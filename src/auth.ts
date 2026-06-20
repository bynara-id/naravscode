import * as crypto from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";

// Where the user authorizes the CLI/extension. The gateway's /connect/cli page
// must support `mode=vscode` and redirect to vscode://naraya.naraya-vscode/callback
// (Plan 02 Task 3). The exchange endpoint trades the one-time code for an api key.
const SITE = "https://naraya.ai";
// Engine config base — same as the naraya CLI (src/config.mjs DEFAULT_BASE).
const ROUTER_BASE = "https://router.naraya.ai";
const KEY_SECRET = "naraya.apiKey";

const DEFAULT_CTX = 128000;
const DEFAULT_MAX_OUTPUT = 32000;

function agentDir(): string {
  return join(homedir(), ".naraya", "agent");
}

// TS port of naraya-cli src/config.mjs `writeModelsConfig` + login.mjs /v1/models
// fetch. Writes ~/.naraya/agent/models.json (0600) so the spawned `naraya` engine
// routes through the gateway with this key. Duplicating ~40 lines across the two
// repos is acceptable for v1 (YAGNI on a shared package).
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
  const dir = agentDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "models.json"), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function registerAuth(context: vscode.ExtensionContext) {
  let pendingState: string | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand("naraya.signIn", async () => {
      pendingState = crypto.randomBytes(16).toString("hex");
      await vscode.env.openExternal(
        vscode.Uri.parse(`${SITE}/connect/cli?mode=vscode&state=${pendingState}`),
      );
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
