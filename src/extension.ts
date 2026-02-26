import { accessSync, constants } from "node:fs";
import * as vscode from "vscode";

let terminal: vscode.Terminal | null = null;
let extensionUri: vscode.Uri;

export function activate(context: vscode.ExtensionContext) {
  const participant = vscode.chat.createChatParticipant("pi-vscode.chat", chatHandler);
  extensionUri = context.extensionUri;
  const logoIcon = {
    light: vscode.Uri.joinPath(extensionUri, "assets", "logo-light.svg"),
    dark: vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"),
  };
  participant.iconPath = logoIcon;

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBarItem.text = "$(pi-logo) Pi";
  statusBarItem.tooltip = "Open Pi Terminal";
  statusBarItem.command = "pi-vscode.open";
  statusBarItem.show();

  context.subscriptions.push(
    participant,
    statusBarItem,
    vscode.commands.registerCommand("pi-vscode.open", () => {
      createNewTerminal();
      terminal!.show();
    }),
    vscode.commands.registerCommand("pi-vscode.openWithFile", () => {
      const editor = vscode.window.activeTextEditor;
      const isNew = !terminal;
      ensureTerminal();
      terminal!.show();
      if (editor) {
        const filePath = vscode.workspace.asRelativePath(editor.document.uri);
        const sel = editor.selection;
        const range = sel.isEmpty ? `:${sel.active.line + 1}` : `:${sel.start.line + 1}-${sel.end.line + 1}`;
        const prompt = `in @${filePath}${range}`;
        const sendPrompt = () => { terminal?.sendText("\x15", false); terminal?.sendText(prompt, false); };
        if (isNew) {
          // Wait for terminal process to be ready before sending text
          terminal!.processId.then(() => sendPrompt());
        } else {
          sendPrompt();
        }
      }
    }),
    vscode.commands.registerCommand("pi-vscode.sendSelection", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (selection) {
        ensureTerminal();
        terminal!.sendText(selection);
        terminal!.show();
      }
    }),
    vscode.window.onDidCloseTerminal((t) => {
      if (t === terminal) {
        terminal = null;
      }
    }),
  );
}

export function deactivate() {
  terminal?.dispose();
  terminal = null;
}

const chatHandler: vscode.ChatRequestHandler = async (request, _context, stream, _token) => {
  const message = request.prompt.trim();
  if (!message) {
    stream.markdown("Please provide a message to send to Pi.");
    return;
  }

  ensureTerminal();
  terminal!.sendText(message);
  terminal!.show();

  stream.markdown(
    `Sent to Pi terminal:\n\n\`\`\`\n${message}\n\`\`\`\n\nCheck the **Pi** terminal for the response.`,
  );
};

function findPiBinary(): string {
  const config = vscode.workspace.getConfiguration("pi-vscode");
  const custom = config.get<string>("path");
  if (custom) return custom;

  const home = process.env.HOME || process.env.USERPROFILE || "";
  const candidates = [
    `${home}/.bun/bin/pi`,
    `${home}/.local/bin/pi`,
    `${home}/.npm-global/bin/pi`,
  ];

  for (const c of candidates) {
    try {
      accessSync(c, constants.X_OK);
      return c;
    } catch {}
  }

  return "pi";
}

function createNewTerminal(): vscode.Terminal {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  terminal = vscode.window.createTerminal({
    name: "Pi",
    shellPath: findPiBinary(),
    cwd,
    iconPath: {
      light: vscode.Uri.joinPath(extensionUri, "assets", "logo-light.svg"),
      dark: vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"),
    },
    location: { viewColumn: vscode.ViewColumn.Beside },
  });

  return terminal;
}

function ensureTerminal(): void {
  if (terminal) return;
  createNewTerminal();
}
