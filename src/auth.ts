import * as crypto from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

// Where the user authorizes the extension (browser fallback only). The gateway's
// /connect/cli page must support `mode=vscode` + redirect to the `redirect_uri`
// we pass (Plan 02 Task 3). The exchange endpoint trades the code for an api key.
const SITE = "https://naraya.ai";
// Engine config base — same as the naraya CLI (src/config.mjs DEFAULT_BASE).
const ROUTER_BASE = "https://router.naraya.ai";
const KEY_SECRET = "naraya.apiKey";

const DEFAULT_CTX = 128000;
const DEFAULT_MAX_OUTPUT = 32000;

function agentDir(): string {
  return join(homedir(), ".naraya", "agent");
}
function modelsPath(): string {
  return join(agentDir(), "models.json");
}

// Reuse the CLI's session: the extension shares ~/.naraya/agent with the `naraya`
// CLI, so if the user already ran `naraya login`, models.json carries the key and
// the spawned engine already works — no browser round-trip (and no dependency on
// the gateway's vscode redirect being live).
function cliApiKey(): string | undefined {
  try {
    const cfg = JSON.parse(readFileSync(modelsPath(), "utf8"));
    const key = cfg?.providers?.naraya?.apiKey;
    return typeof key === "string" && key.trim() ? key : undefined;
  } catch {
    return undefined;
  }
}

/** Signed in if SecretStorage has a key OR the CLI is already logged in. */
export async function isSignedIn(context: vscode.ExtensionContext): Promise<boolean> {
  return Boolean((await context.secrets.get(KEY_SECRET)) || cliApiKey());
}

// TS port of naraya-cli src/config.mjs `writeModelsConfig` + login.mjs /v1/models
// fetch. Writes ~/.naraya/agent/models.json (0600) so the spawned `naraya` engine
// routes through the gateway with this key.
async function writeEngineConfig(apiKey: string): Promise<void> {
  const baseUrl = `${ROUTER_BASE}/v1`;
  let models: Array<{ id: string; context_window?: number; max_output_tokens?: number; vision?: boolean; weight?: number }> = [];
  try {
    const res = await fetch(`${baseUrl}/models`, { headers: { authorization: `Bearer ${apiKey}` } });
    if (res.ok) {
      const data = (await res.json()) as { data?: any[] };
      models = Array.isArray(data?.data) ? data.data : [];
    }
  } catch {
    // Network failure — write an empty model list; /model can refresh later.
  }

  const built = models
    .filter((m) => m && m.id)
    .map((m) => {
      const w = Number(m.weight);
      const name = w > 0 ? `${m.id} (${w}x)` : m.id;
      const g = Number(m.max_output_tokens);
      return {
        id: m.id,
        name,
        contextWindow: m.context_window ?? DEFAULT_CTX,
        maxTokens: Number.isFinite(g) && g > 0 ? g : DEFAULT_MAX_OUTPUT,
        input: m.vision === false ? ["text"] : ["text", "image"],
      };
    });

  const config = {
    providers: {
      naraya: { name: "Naraya", baseUrl, api: "openai-completions", apiKey, models: built },
    },
  };
  mkdirSync(agentDir(), { recursive: true });
  writeFileSync(modelsPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function registerAuth(context: vscode.ExtensionContext) {
  let pendingState: string | undefined;

  const browserSignIn = async () => {
    pendingState = crypto.randomBytes(16).toString("hex");
    // Build a callback URI for the ACTUAL host app — vscode.env.uriScheme is
    // "vscode" / "cursor" / "windsurf" / "vscodium" / "antigravity" / … and
    // asExternalUri also handles remote/Codespaces. Pass it as redirect_uri so
    // the gateway sends the user back to whichever IDE they launched from.
    const base = vscode.Uri.parse(`${vscode.env.uriScheme}://naraya.naraya-vscode/callback`);
    const callback = await vscode.env.asExternalUri(base);
    const url = `${SITE}/connect/cli?mode=vscode&state=${pendingState}&redirect_uri=${encodeURIComponent(callback.toString(true))}`;
    await vscode.env.openExternal(vscode.Uri.parse(url));
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("naraya.signIn", async () => {
      // 1. Already have a key in SecretStorage.
      if (await context.secrets.get(KEY_SECRET)) {
        void vscode.window.showInformationMessage("Already signed in to Naraya.");
        return;
      }
      // 2. Reuse the CLI session if present — no browser needed.
      const cliKey = cliApiKey();
      if (cliKey) {
        await context.secrets.store(KEY_SECRET, cliKey);
        void vscode.window.showInformationMessage("Signed in to Naraya using your CLI session.");
        return;
      }
      // 3. Fall back to the browser OAuth flow (fork-aware redirect).
      await browserSignIn();
    }),
    vscode.window.registerUriHandler({
      async handleUri(uri: vscode.Uri) {
        const params = new URLSearchParams(uri.query);
        if (uri.path !== "/callback" || !pendingState || params.get("state") !== pendingState) {
          void vscode.window.showErrorMessage("Naraya sign-in failed: state mismatch. Try again.");
          return;
        }
        pendingState = undefined;
        try {
          const res = await fetch(`${SITE}/api/auth/exchange`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ code: params.get("code") }),
          });
          if (!res.ok) {
            void vscode.window.showErrorMessage(`Naraya sign-in failed: HTTP ${res.status}`);
            return;
          }
          const { api_key } = (await res.json()) as { api_key: string };
          if (!api_key) {
            void vscode.window.showErrorMessage("Naraya sign-in failed: no api key returned.");
            return;
          }
          await context.secrets.store(KEY_SECRET, api_key);
          await writeEngineConfig(api_key);
          void vscode.window.showInformationMessage("Signed in to Naraya. Models configured.");
        } catch (error) {
          void vscode.window.showErrorMessage(`Naraya sign-in failed: ${String(error)}`);
        }
      },
    }),
  );
}
