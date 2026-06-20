import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { registerAuth } from "./auth.ts";
import { createBridge } from "./bridge/server.ts";
import { createChatHandler } from "./chat.ts";
import { TERMINAL_TITLE } from "./constants.ts";
import { createNarayaPanelProvider, openChatPanel } from "./panel.ts";
import { createPiEnvironment, createPiShellArgs, findPiBinary, upgradePiBinary } from "./pi.ts";
import { createSessionTracker } from "./sessions.ts";
import { buildOpenWithFileContext, createNewTerminal } from "./terminal.ts";

let extensionUri: vscode.Uri;
let bridgeConfig: { url: string; token: string } | undefined;
let bridgeDispose: (() => Promise<void>) | undefined;

export async function activate(context: vscode.ExtensionContext) {
  extensionUri = context.extensionUri;

  // Sign in with Naraya (vscode:// callback) — registers naraya.signIn + the URI
  // handler. Gateway-side /connect/cli?mode=vscode redirect is Plan 02 Task 3.
  registerAuth(context);

  const sessions = createSessionTracker(context);
  const bridge = await createBridge(context, (terminalId, sessionFile) => {
    sessions.update(terminalId, sessionFile);
  });
  bridgeConfig = { url: bridge.url, token: bridge.token };
  bridgeDispose = () => bridge.dispose();
  context.subscriptions.push({
    dispose: () => {
      const dispose = bridgeDispose;
      bridgeDispose = undefined;
      bridgeConfig = undefined;
      void dispose?.();
    },
  });

  const openTerminal = async (
    extraArgs?: string[],
    contextLines?: string[],
  ): Promise<vscode.Terminal | undefined> => {
    const terminalId = randomUUID();
    const terminal = await createNewTerminal({
      extensionUri,
      bridgeConfig,
      extraArgs,
      contextLines,
      terminalId,
    });
    if (terminal) sessions.track(terminal, terminalId);
    return terminal;
  };

  const participant = vscode.chat.createChatParticipant(
    "naraya.chat",
    createChatHandler({
      extensionUri,
      getBridgeConfig: () => bridgeConfig,
    }),
  );
  const logoIcon = {
    light: vscode.Uri.joinPath(extensionUri, "assets", "logo-light.svg"),
    dark: vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"),
  };
  participant.iconPath = logoIcon;

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(sparkle) Naraya";
  statusBarItem.tooltip = "Open Naraya Terminal";
  statusBarItem.command = "naraya.open";
  statusBarItem.show();

  context.subscriptions.push(
    participant,
    statusBarItem,
    vscode.window.onDidCloseTerminal((terminal) => sessions.onClose(terminal)),
    vscode.commands.registerCommand("naraya.open", async () => {
      const terminal = await openTerminal();
      terminal?.show();
    }),
    vscode.commands.registerCommand("naraya.openWithFile", async () => {
      const terminal = await openTerminal(undefined, buildOpenWithFileContext());
      terminal?.show();
    }),
    vscode.commands.registerCommand("naraya.sendSelection", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) return;
      const terminal = await openTerminal([selection]);
      terminal?.show();
    }),
    vscode.commands.registerCommand("naraya.openInNewWindow", async () => {
      const terminal = await openTerminal();
      if (!terminal) return;
      terminal.show();
      await vscode.commands.executeCommand("workbench.action.moveEditorToNewWindow");
    }),
    vscode.commands.registerCommand("naraya.upgrade", upgradePiBinary),
    // Naraya chat opens as an editor-area panel (Claude-style tab); the sidebar
    // is the launcher (Sessions + Account + New chat).
    vscode.commands.registerCommand("naraya.openChat", () =>
      openChatPanel(extensionUri, () => bridgeConfig, { fresh: true }),
    ),
    vscode.window.registerWebviewViewProvider(
      "naraya.home",
      createNarayaPanelProvider(extensionUri, (opts) => openChatPanel(extensionUri, () => bridgeConfig, opts)),
    ),
    vscode.window.registerTerminalProfileProvider("naraya.terminal-profile", {
      provideTerminalProfile() {
        const terminalId = randomUUID();
        const baseEnv = createPiEnvironment(bridgeConfig);
        return new vscode.TerminalProfile({
          name: TERMINAL_TITLE,
          shellPath: findPiBinary(),
          shellArgs: createPiShellArgs(extensionUri),
          cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          env: { ...baseEnv, PI_VSCODE_TERMINAL_ID: terminalId },
          iconPath: logoIcon,
        });
      },
    }),
  );

  if (bridgeConfig) void sessions.restore(extensionUri, bridgeConfig);
}

export async function deactivate() {
  for (const terminal of vscode.window.terminals) {
    if (terminal.name === TERMINAL_TITLE) terminal.dispose();
  }
  const dispose = bridgeDispose;
  bridgeDispose = undefined;
  bridgeConfig = undefined;
  await dispose?.();
}
