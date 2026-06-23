import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import { toErrorMessage } from "./bridge/utils.ts";
import { createPiEnvironment, createPiRpcArgs, ensurePiBinary, spawnByNara } from "./pi.ts";
import { createNewTerminal } from "./terminal.ts";

export function createChatHandler(options: {
  extensionUri: vscode.Uri;
  getBridgeConfig(): { url: string; token: string } | undefined;
}): vscode.ChatRequestHandler {
  return async (request, _context, stream, token) => {
    const message = request.prompt.trim();
    if (!message) {
      stream.markdown("Please provide a message to send to ByNara.");
      return;
    }

    const piPath = await ensurePiBinary();
    if (!piPath) {
      stream.markdown("ByNara CLI is not installed. Install it with `npm i -g bynara-cli`.");
      return;
    }

    try {
      const result = await runPiRpcPrompt({
        piPath,
        message,
        token,
        stream,
        extensionUri: options.extensionUri,
        bridgeConfig: options.getBridgeConfig(),
      });
      if (!result.hadOutput) stream.markdown("ByNara did not return any text.");
    } catch (error) {
      const terminal = await createNewTerminal({
        extensionUri: options.extensionUri,
        bridgeConfig: options.getBridgeConfig(),
        extraArgs: [message],
      });
      terminal?.show();
      stream.markdown(
        `ByNara RPC failed and fell back to the terminal.\n\nError: ${escapeMarkdownInline(toErrorMessage(error))}`,
      );
    }
  };
}

async function runPiRpcPrompt(options: {
  piPath: string;
  message: string;
  token: vscode.CancellationToken;
  stream: vscode.ChatResponseStream;
  extensionUri: vscode.Uri;
  bridgeConfig?: { url: string; token: string };
}): Promise<{ hadOutput: boolean }> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const child = spawnByNara(options.piPath, createPiRpcArgs(options.extensionUri), {
    cwd,
    env: {
      ...process.env,
      ...createPiEnvironment(options.bridgeConfig),
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuffer = "";
  let stderrBuffer = "";
  let hadOutput = false;
  let resolved = false;
  const decoder = new StringDecoder("utf8");

  const finish = (
    resolve: (value: { hadOutput: boolean }) => void,
    reject: (error: Error) => void,
    error?: Error,
  ) => {
    if (resolved) return;
    resolved = true;
    if (error) reject(error);
    else resolve({ hadOutput });
  };

  const sendCommand = (command: object) => {
    child.stdin!.write(`${JSON.stringify(command)}\n`);
  };

  // Surface the engine's gate prompts (extension_ui_request) as native VS Code
  // dialogs and write the answer back to the engine's stdin. Async — the line
  // handler fires this without awaiting; the reply is sent when the user picks.
  const respondToUiRequest = async (
    id: string,
    method: string | undefined,
    event: Record<string, unknown>,
  ) => {
    const title = typeof event.title === "string" ? event.title : "ByNara";
    try {
      if (method === "confirm") {
        const message = typeof event.message === "string" ? event.message : title;
        const detail = message !== title ? title : undefined;
        const pick = await vscode.window.showWarningMessage(
          message,
          { modal: true, detail },
          "Allow",
        );
        sendCommand({ type: "extension_ui_response", id, confirmed: pick === "Allow" });
        return;
      }
      if (method === "select") {
        const opts = Array.isArray(event.options) ? event.options.map(String) : [];
        const choice = await vscode.window.showQuickPick(opts, { title });
        sendCommand(
          choice === undefined
            ? { type: "extension_ui_response", id, cancelled: true }
            : { type: "extension_ui_response", id, value: choice },
        );
        return;
      }
      if (method === "input") {
        const placeHolder = typeof event.placeholder === "string" ? event.placeholder : undefined;
        const value = await vscode.window.showInputBox({ title, placeHolder });
        sendCommand(
          value === undefined
            ? { type: "extension_ui_response", id, cancelled: true }
            : { type: "extension_ui_response", id, value },
        );
        return;
      }
      // Unknown interactive method — cancel so the engine doesn't hang.
      sendCommand({ type: "extension_ui_response", id, cancelled: true });
    } catch {
      sendCommand({ type: "extension_ui_response", id, cancelled: true });
    }
  };

  const flushLines = (chunk: Buffer | string, onLine: (line: string) => void) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    while (true) {
      const newlineIndex = stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) break;
      let line = stdoutBuffer.slice(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line) onLine(line);
    }
  };

  return await new Promise<{ hadOutput: boolean }>((resolve, reject) => {
    options.token.onCancellationRequested(() => {
      try {
        sendCommand({ type: "abort" });
      } catch {}
      setTimeout(() => {
        child.kill();
      }, 300);
    });

    child.stdout!.on("data", (chunk) => {
      flushLines(chunk, (line) => {
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (event.type === "extension_ui_request") {
          const method = typeof event.method === "string" ? event.method : undefined;
          const id = typeof event.id === "string" ? event.id : undefined;
          if (!id) return;
          // Fire-and-forget notifications carry no response.
          if (method === "notify") {
            if (typeof event.message === "string")
              void vscode.window.showInformationMessage(event.message);
            return;
          }
          if (["confirm", "select", "input"].includes(method ?? "")) {
            void respondToUiRequest(id, method, event);
          } else if (method === "editor") {
            // No native editor dialog yet — decline so the engine continues.
            sendCommand({ type: "extension_ui_response", id, cancelled: true });
          }
          return;
        }
        if (event.type === "message_update") {
          const assistantMessageEvent = event.assistantMessageEvent as
            | Record<string, unknown>
            | undefined;
          if (
            assistantMessageEvent?.type === "text_delta" &&
            typeof assistantMessageEvent.delta === "string"
          ) {
            hadOutput = true;
            options.stream.markdown(assistantMessageEvent.delta);
          }
          return;
        }
        if (event.type === "response" && event.command === "prompt" && event.success === false) {
          finish(resolve, reject, new Error(String(event.error ?? "ByNara RPC prompt failed")));
          child.kill();
          return;
        }
        if (event.type === "agent_end") {
          child.stdin!.end();
        }
      });
    });

    child.stderr!.on("data", (chunk: Buffer) => {
      stderrBuffer += chunk.toString();
    });

    child.on("error", (error) => {
      finish(resolve, reject, error);
    });

    child.on("close", (code, signal) => {
      stdoutBuffer += decoder.end();
      if (resolved) return;
      if (options.token.isCancellationRequested) {
        finish(resolve, reject, new Error("ByNara RPC request cancelled."));
        return;
      }
      if (code === 0 || signal === "SIGTERM") {
        finish(resolve, reject);
        return;
      }
      const message = stderrBuffer.trim() || `ByNara RPC exited with code ${code ?? "unknown"}.`;
      finish(resolve, reject, new Error(message));
    });

    sendCommand({ id: "prompt-1", type: "prompt", message: options.message });
  });
}

function escapeMarkdownInline(text: string): string {
  return text.replace(/[`*_{}[\]()#+\-.!]/g, "\\$&");
}
