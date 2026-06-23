import http from "node:http";
import crypto from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { ensurePiBinary } from "./pi.ts";

// Same gateway as the naracli CLI. Sign-in uses the CLI's proven flow: a local
// loopback server + `?state=&port=` (NOT the custom-URI redirect, which forks
// mangle). All in-extension — no terminal, and no CLI binary needed to sign in.
const SITE = "https://router.bynara.id";
const BASE_URL = "https://router.bynara.id/v1";
const KEY_SECRET = "bynara.apiKey";
const DEFAULT_CTX = 128000;
const DEFAULT_MAX_OUTPUT = 32000;

function agentDir(): string {
  return join(homedir(), ".bynara", "agent");
}
function modelsPath(): string {
  return join(agentDir(), "models.json");
}

function cliApiKey(): string | undefined {
  try {
    const key = JSON.parse(readFileSync(modelsPath(), "utf8"))?.providers?.bynara?.apiKey;
    return typeof key === "string" && key.trim() ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Signed in if SecretStorage has a key OR the CLI is already logged in. */
export async function isSignedIn(context: vscode.ExtensionContext): Promise<boolean> {
  return Boolean((await context.secrets.get(KEY_SECRET)) || cliApiKey());
}

// Write ~/.bynara/agent/models.json (0600) so the spawned `naracli` engine routes
// through the gateway with this key — mirrors the CLI's writeModelsConfig.
async function writeEngineConfig(apiKey: string): Promise<void> {
  let models: any[] = [];
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.ok) models = (await res.json())?.data ?? [];
  } catch {
    /* offline — write empty; /model refreshes later */
  }

  const built = (Array.isArray(models) ? models : [])
    .filter((m) => m && m.id)
    .map((m) => {
      const w = Number(m.weight);
      const g = Number(m.max_output_tokens);
      return {
        id: m.id,
        name: w > 0 ? `${m.id} (${w}x)` : m.id,
        contextWindow: m.context_window ?? DEFAULT_CTX,
        maxTokens: Number.isFinite(g) && g > 0 ? g : DEFAULT_MAX_OUTPUT,
        input: m.vision === false ? ["text"] : ["text", "image"],
      };
    });

  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(
    modelsPath(),
    JSON.stringify(
      {
        providers: {
          bynara: {
            name: "ByNara",
            baseUrl: BASE_URL,
            api: "openai-completions",
            apiKey,
            models: built,
          },
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

// Cheap validity probe so a revoked/stale key triggers a fresh sign-in.
async function validKey(key: string): Promise<boolean> {
  try {
    const r = await fetch(`${BASE_URL}/me`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch {
    return false;
  }
}

// Loopback OAuth: open the gateway sign-in with a local callback port, capture the
// code, exchange it for an api key. Returns the key or null.
function loopbackSignIn(): Promise<string | null> {
  return new Promise((resolve) => {
    const state = crypto.randomBytes(16).toString("hex");
    let settled = false;
    const done = (v: string | null) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      if (u.searchParams.get("state") !== state) {
        res
          .writeHead(400, { "content-type": "text/html" })
          .end("<h3>State mismatch. Close this tab and retry.</h3>");
        server.close();
        done(null);
        return;
      }
      const code = u.searchParams.get("code");
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<h3>ByNara connected — you can close this tab.</h3>");
      server.close();
      if (!code) {
        done(null);
        return;
      }
      try {
        const ex = await fetch(`${SITE}/api/auth/exchange`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const api_key = ex.ok ? (await ex.json())?.api_key : undefined;
        done(typeof api_key === "string" && api_key ? api_key : null);
      } catch {
        done(null);
      }
    });
    server.on("error", () => done(null));
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as any)?.port;
      void vscode.env.openExternal(
        vscode.Uri.parse(`${SITE}/connect/cli?state=${state}&port=${port}`),
      );
    });
    setTimeout(() => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
      done(null);
    }, 300_000).unref?.();
  });
}

export function registerAuth(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand("bynara.signIn", async (): Promise<boolean> => {
      // Existing session (extension secret or CLI models.json) — no browser.
      let key = (await context.secrets.get(KEY_SECRET)) || cliApiKey();
      // Discard a stale/revoked key so we fall through to a fresh browser sign-in
      // instead of getting stuck "signed in" with a dead session.
      if (key && !(await validKey(key))) {
        await context.secrets.delete(KEY_SECRET);
        key = undefined;
      }
      if (!key) {
        // In-extension loopback browser flow.
        key =
          (await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: "Signing in to ByNara… (finish in your browser)",
              cancellable: false,
            },
            () => loopbackSignIn(),
          )) ?? undefined;
        if (!key) {
          void vscode.window.showErrorMessage("ByNara sign-in failed or timed out. Try again.");
          return false;
        }
      }
      await context.secrets.store(KEY_SECRET, key);
      // Make sure the engine config exists/matches (secret may outlive models.json).
      if (cliApiKey() !== key) {
        try {
          await writeEngineConfig(key);
        } catch {
          /* offline */
        }
      }
      void ensurePiBinary(); // offer to install the engine if missing
      void vscode.window.showInformationMessage("Signed in to ByNara.");
      return true;
    }),
    vscode.commands.registerCommand("bynara.signOut", async (): Promise<boolean> => {
      await context.secrets.delete(KEY_SECRET);
      try {
        rmSync(modelsPath(), { force: true });
      } catch {
        /* ignore */
      }
      return true;
    }),
  );
}
