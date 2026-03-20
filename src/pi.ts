import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { BRIDGE_BOOTSTRAP_LINES, BRIDGE_EXTENSION_PATH } from "./constants.ts";
import { resolvePiBinary } from "./_resolve.ts";

let piExistsCache: boolean | undefined;

export function findPiBinary(): string {
  const config = vscode.workspace.getConfiguration("pi-vscode");
  return resolvePiBinary({
    customPath: config.get<string>("path") || undefined,
    workspaceDirs: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
  });
}

export async function ensurePiBinary(): Promise<string | undefined> {
  const piPath = findPiBinary();

  if (piExistsCache === undefined) {
    try {
      accessSync(piPath, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      piExistsCache = true;
    } catch {
      piExistsCache = false;
    }
  }

  if (piExistsCache) return piPath;

  const commands: Record<string, string> = {
    npm: "npm i -g @mariozechner/pi-coding-agent",
    bun: "bun i -g @mariozechner/pi-coding-agent",
    pnpm: "pnpm i -g @mariozechner/pi-coding-agent",
  };
  const action = await vscode.window.showErrorMessage(
    "Pi binary not found. Install it globally?",
    ...Object.keys(commands),
  );
  if (action) {
    piExistsCache = undefined;
    const terminal = vscode.window.createTerminal({ name: "Install Pi" });
    terminal.show();
    terminal.sendText(commands[action]!);
  }
  return undefined;
}

export function createPiShellArgs(
  extensionUri: vscode.Uri,
  options: { extraArgs?: string[]; contextLines?: string[] } = {},
): string[] {
  const args = createPiBaseArgs(extensionUri, options.contextLines);
  if (options.extraArgs?.length) args.push(...options.extraArgs);
  return args;
}

export function createPiRpcArgs(extensionUri: vscode.Uri): string[] {
  return ["--mode", "rpc", "--no-session", ...createPiBaseArgs(extensionUri)];
}

export function createPiEnvironment(
  bridgeConfig: { url: string; token: string } | undefined,
): Record<string, string> | undefined {
  if (!bridgeConfig) return undefined;
  return {
    PI_VSCODE_BRIDGE_URL: bridgeConfig.url,
    PI_VSCODE_BRIDGE_TOKEN: bridgeConfig.token,
  };
}

function createPiBaseArgs(extensionUri: vscode.Uri, contextLines?: string[]): string[] {
  const args: string[] = ["--extension", join(extensionUri.fsPath, BRIDGE_EXTENSION_PATH)];
  const bootstrapLines = [...BRIDGE_BOOTSTRAP_LINES, ...(contextLines ?? [])];
  if (bootstrapLines.length > 0) args.push("--append-system-prompt", bootstrapLines.join("\n\n"));
  return args;
}
