import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import { createPiEnvironment, createPiRpcArgs, ensurePiBinary, spawnNaraya } from "./pi.ts";

// Naraya UI: a lightweight sidebar (Sessions + Account + New Chat) plus a full
// chat that opens as an EDITOR-AREA webview panel — like Claude Code's tab,
// not a cramped sidebar view. The engine is the `naraya` CLI (RPC); these views
// only render + drive it.

const ROUTER_BASE = "https://router.naraya.ai/v1";

function agentDir(): string {
  return join(homedir(), ".naraya", "agent");
}

function provider(): { baseUrl: string; apiKey: string } | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir(), "models.json"), "utf8"));
    const p = cfg?.providers?.naraya;
    if (p?.apiKey) return { baseUrl: p.baseUrl || ROUTER_BASE, apiKey: p.apiKey };
  } catch {
    /* not signed in */
  }
  return undefined;
}

async function fetchAccount(): Promise<{ ok: boolean; data?: any; error?: string }> {
  const p = provider();
  if (!p) return { ok: false, error: "not-signed-in" };
  try {
    const res = await fetch(`${p.baseUrl}/me`, {
      headers: { authorization: `Bearer ${p.apiKey}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

interface SessionInfo {
  file: string;
  title: string;
  project: string;
  mtime: number;
}

function listSessions(limit = 200): SessionInfo[] {
  const root = join(agentDir(), "sessions");
  if (!existsSync(root)) return [];
  const out: SessionInfo[] = [];
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  for (const d of dirs) {
    const dir = join(root, d);
    let files: string[];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const file = join(dir, f);
      try {
        const st = statSync(file);
        const { title, project } = describeSession(file);
        out.push({ file, title, project, mtime: st.mtimeMs });
      } catch {
        /* skip */
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

function describeSession(file: string): { title: string; project: string } {
  let title = "";
  let project = "";
  try {
    const head = readFileSync(file, "utf8").split("\n", 40);
    for (const line of head) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!project && typeof rec?.cwd === "string") project = rec.cwd;
      const msg = rec?.message ?? rec;
      if (!title && msg?.role === "user") {
        const c = msg.content;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join(" ") : "";
        const trimmed = text.replace(/\s+/g, " ").trim();
        if (trimmed) title = trimmed.slice(0, 80);
      }
      if (title && project) break;
    }
  } catch {
    /* ignore */
  }
  return { title: title || "(untitled session)", project: project || "" };
}

function readTranscript(file: string, limit = 100): Array<{ role: string; text: string }> {
  const out: Array<{ role: string; text: string }> = [];
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      const msg = rec?.message ?? rec;
      if (msg?.role !== "user" && msg?.role !== "assistant") continue;
      const c = msg.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((p: any) => p?.type === "text").map((p: any) => p.text).join("") : "";
      if (text.trim()) out.push({ role: msg.role, text: text.trim() });
    }
  } catch {
    /* ignore */
  }
  return out.slice(-limit);
}

// A short, human label for a tool call (mirrors how the CLI shows it).
function toolSummary(name: string, args: any): string {
  if (!args || typeof args !== "object") return "";
  if (name === "bash") return String(args.command ?? "").slice(0, 200);
  if (name === "read" || name === "write" || name === "edit" || name === "ast_edit") return String(args.path ?? args.file ?? "");
  if (name === "grep" || name === "ast_grep") return String(args.pattern ?? args.query ?? "");
  if (name === "delegate") return String(args.agent ?? "") + (args.task ? ": " + String(args.task).slice(0, 80) : "");
  if (name === "web_search") return String(args.query ?? "");
  const k = Object.keys(args)[0];
  return k ? `${k}: ${String(args[k]).slice(0, 120)}` : "";
}

// Flatten a tool result into display text (caps length).
function extractText(result: any): string {
  if (!result) return "";
  const c = result.content ?? result;
  let text = "";
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) text = c.map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("");
  else if (typeof result.text === "string") text = result.text;
  text = text.trim();
  return text.length > 4000 ? text.slice(0, 4000) + "\n… (truncated)" : text;
}

function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// Find an image file path a tool wrote (e.g. render_mermaid's PNG) in its output.
function findImagePath(text: string): string {
  const m = text.match(/([A-Za-z]:[\\/][^\n\r"']*?\.(?:png|jpe?g|gif|svg)|\/[^\n\r"']*?\.(?:png|jpe?g|gif|svg))/i);
  return m?.[1]?.trim() ?? "";
}
// Read a (small) image into a data URI so the webview can show it inline.
function readImageDataUri(p: string): string {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > 6_000_000) return "";
    const ext = (p.split(".").pop() || "").toLowerCase();
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "gif" ? "image/gif" : "image/png";
    return `data:${mime};base64,${readFileSync(p).toString("base64")}`;
  } catch {
    return "";
  }
}

// --- Editor (extension) chat sessions, kept SEPARATE from the CLI's sessions
// so the panel's history doesn't mix with terminal sessions (Claude-style). ---
function editorSessionsDir(): string {
  return join(agentDir(), "editor-sessions");
}
function saveEditorSession(id: string, messages: Array<{ role: string; text: string }>): void {
  if (!messages.length) return;
  try {
    const dir = editorSessionsDir();
    require("node:fs").mkdirSync(dir, { recursive: true });
    const title = (messages.find((m) => m.role === "user")?.text || "(chat)").replace(/\s+/g, " ").trim().slice(0, 80);
    require("node:fs").writeFileSync(join(dir, id + ".json"), JSON.stringify({ id, title, mtime: Date.now(), messages }, null, 2));
  } catch {
    /* best-effort */
  }
}
function listEditorSessions(limit = 200): SessionInfo[] {
  const dir = editorSessionsDir();
  if (!existsSync(dir)) return [];
  const out: SessionInfo[] = [];
  try {
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const file = join(dir, f);
        const j = JSON.parse(readFileSync(file, "utf8"));
        out.push({ file, title: j.title || "(chat)", project: "editor", mtime: j.mtime || statSync(file).mtimeMs });
      } catch {
        /* skip */
      }
    }
  } catch {
    /* ignore */
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}
function readEditorSession(file: string): Array<{ role: string; text: string }> {
  try {
    const j = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(j.messages) ? j.messages : [];
  } catch {
    return [];
  }
}

const ICONS = {
  chat: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 1.7A6.3 6.3 0 0 0 2.3 11L1.6 14l3-.7A6.3 6.3 0 1 0 8 1.7Z"/></svg>`,
  sessions: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 4v4l2.5 1.5"/><circle cx="8" cy="8" r="6"/></svg>`,
  account: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5a5 5 0 0 1 10 0"/></svg>`,
  plus: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z"/></svg>`,
  sess: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/></svg>`,
  send: `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M1.7 2 14.5 8 1.7 14l1.8-6-1.8-6Zm2 2.6L4.4 8 3.7 11.4 11 8 3.7 4.6Z"/></svg>`,
};

// ============================ Editor-area chat panel ========================

let chatPanel: vscode.WebviewPanel | undefined;
let chatChild: ChildProcess | undefined;
let chatOut: vscode.OutputChannel | undefined;
let sessId = nonce(); // current editor-session id
let sessMsgs: Array<{ role: string; text: string }> = [];
let asstAcc = ""; // assistant text accumulated for the current turn

export function openChatPanel(
  extensionUri: vscode.Uri,
  getBridgeConfig: () => { url: string; token: string } | undefined,
  opts: { sessionFile?: string; fresh?: boolean } = {},
): void {
  if (!chatOut) chatOut = vscode.window.createOutputChannel("Naraya");

  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Active);
  } else {
    chatPanel = vscode.window.createWebviewPanel("naraya.chat", "Naraya", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [extensionUri],
    });
    chatPanel.iconPath = vscode.Uri.joinPath(extensionUri, "assets", "logo.svg");
    chatPanel.webview.html = chatHtml(chatPanel.webview, extensionUri);

    const panel = chatPanel;
    const post = (m: any) => void panel.webview.postMessage(m);
    const send = (o: object) => chatChild?.stdin?.write(`${JSON.stringify(o)}\n`);
    let chatMode = "auto"; // ask | auto | plan
    let chatEffort = ""; // low | medium | high — sent to the engine when it changes

    const ensureChild = async (): Promise<boolean> => {
      if (chatChild) return true;
      const naraya = await ensurePiBinary();
      if (!naraya) {
        post({ type: "chatError", error: "Naraya CLI not found on PATH." });
        return false;
      }
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const args = createPiRpcArgs(extensionUri);
      chatOut!.appendLine(`[chat] spawn ${naraya} ${args.join(" ")} (cwd=${cwd ?? "-"})`);
      chatChild = spawnNaraya(naraya, args, {
        cwd,
        env: { ...process.env, ...createPiEnvironment(getBridgeConfig()) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      chatChild.stderr?.on("data", (d) => chatOut!.appendLine(`[stderr] ${d.toString().trimEnd()}`));
      const decoder = new StringDecoder("utf8");
      let buf = "";
      chatChild.stdout?.on("data", (chunk) => {
        buf += decoder.write(chunk);
        let nl: number;
        while ((nl = buf.indexOf("\n")) !== -1) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          handle(ev);
        }
      });
      chatChild.on("close", (code) => {
        chatOut!.appendLine(`[chat] closed (${code})`);
        chatChild = undefined;
        post({ type: "chatDone" });
      });
      chatChild.on("error", (e) => {
        chatOut!.appendLine(`[chat] error ${String(e?.message ?? e)}`);
        chatChild = undefined;
        post({ type: "chatError", error: String(e?.message ?? e) });
      });
      return true;

      function handle(ev: any) {
        if (ev.type === "extension_ui_request") {
          const id = ev.id, method = ev.method;
          if (!id) return;
          void (async () => {
            try {
              if (method === "confirm") {
                if (chatMode === "auto") {
                  send({ type: "extension_ui_response", id, confirmed: true }); // auto-approve
                  post({ type: "chatTool", name: "auto-approved: " + String(ev.title ?? "action") });
                  return;
                }
                const pick = await vscode.window.showWarningMessage(String(ev.message ?? ev.title ?? "Allow?"), { modal: true }, "Allow");
                send({ type: "extension_ui_response", id, confirmed: pick === "Allow" });
              } else if (method === "select") {
                const o = Array.isArray(ev.options) ? ev.options.map(String) : [];
                // Auto mode: gate prompts arrive as a select (Allow once / Allow
                // for this session / Auto-approve all / Deny). Pick the strongest
                // allow so the engine stops asking for the rest of the session.
                if (chatMode === "auto" && o.length) {
                  const pick = o.find((x: string) => /auto-approve/i.test(x)) || o.find((x: string) => /this session/i.test(x)) || o.find((x: string) => /allow/i.test(x)) || o[0];
                  send({ type: "extension_ui_response", id, value: pick });
                  post({ type: "chatTool", name: "auto-approved: " + String(ev.title ?? "action") });
                  return;
                }
                const c = await vscode.window.showQuickPick(o, { title: String(ev.title ?? "Select") });
                send(c === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value: c });
              } else if (method === "input") {
                const v = await vscode.window.showInputBox({ title: String(ev.title ?? "Input") });
                send(v === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value: v });
              } else if (method !== "notify" && method !== "setStatus" && method !== "setWidget") {
                send({ type: "extension_ui_response", id, cancelled: true });
              }
            } catch {
              send({ type: "extension_ui_response", id, cancelled: true });
            }
          })();
          return;
        }
        if (ev.type === "message_update") {
          const a = ev.assistantMessageEvent;
          if (a?.type === "text_delta" && typeof a.delta === "string") { asstAcc += a.delta; post({ type: "chatDelta", delta: a.delta }); }
          else if (a?.type === "reasoning_delta" && typeof a.delta === "string") post({ type: "chatReason", delta: a.delta });
          return;
        }
        if (ev.type === "tool_execution_start") {
          post({ type: "toolStart", id: ev.toolCallId, name: ev.toolName, summary: toolSummary(ev.toolName, ev.args) });
          return;
        }
        if (ev.type === "tool_execution_end") {
          const text = extractText(ev.result);
          post({ type: "toolEnd", id: ev.toolCallId, result: text, isError: !!ev.isError });
          const imgPath = findImagePath(text);
          if (imgPath) {
            const data = readImageDataUri(imgPath);
            if (data) post({ type: "toolImage", id: ev.toolCallId, src: data });
          }
          return;
        }
        if (ev.type === "agent_end") {
          if (asstAcc.trim()) { sessMsgs.push({ role: "assistant", text: asstAcc.trim() }); saveEditorSession(sessId, sessMsgs); }
          asstAcc = "";
          post({ type: "chatDone" });
        }
      }
    };

    panel.webview.onDidReceiveMessage(async (msg: any) => {
      if (msg?.type === "chat" && typeof msg.text === "string" && msg.text.trim()) {
        if (typeof msg.mode === "string") chatMode = msg.mode;
        if (!(await ensureChild())) return;
        sessMsgs.push({ role: "user", text: msg.text.trim() });
        asstAcc = "";
        // Effort -> engine thinking level (only when it changes).
        if (typeof msg.effort === "string" && msg.effort !== chatEffort) {
          chatEffort = msg.effort;
          send({ id: `t${Date.now()}`, type: "set_thinking_level", level: chatEffort });
        }
        let text = msg.text.trim();
        if (chatMode === "plan") text = "Plan first — investigate and present a step-by-step plan, do NOT edit anything yet.\n\n" + text;
        send({ id: `p${Date.now()}`, type: "prompt", message: text });
      } else if (msg?.type === "listFiles") {
        try {
          const uris = await vscode.workspace.findFiles("**/*", "**/{node_modules,.git,dist,out,build}/**", 3000);
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
          post({ type: "files", list: uris.map((u) => vscode.workspace.asRelativePath(u, false)).filter(Boolean).sort() });
          void root;
        } catch {
          post({ type: "files", list: [] });
        }
      } else if (msg?.type === "newChat") {
        try {
          chatChild?.kill();
        } catch {
          /* ignore */
        }
        chatChild = undefined;
        sessId = nonce(); sessMsgs = []; asstAcc = "";
      } else if (msg?.type === "stop") {
        try {
          chatChild?.kill();
        } catch {
          /* ignore */
        }
        chatChild = undefined;
      }
    });

    panel.onDidDispose(() => {
      try {
        chatChild?.kill();
      } catch {
        /* ignore */
      }
      chatChild = undefined;
      chatPanel = undefined;
    });
  }

  // Fresh chat or load a session transcript into the (possibly reused) panel.
  if (opts.fresh) {
    try { chatChild?.kill(); } catch { /* ignore */ }
    chatChild = undefined;
    sessId = nonce(); sessMsgs = []; asstAcc = "";
    void chatPanel.webview.postMessage({ type: "reset" });
  } else if (opts.sessionFile) {
    try { chatChild?.kill(); } catch { /* ignore */ }
    chatChild = undefined;
    asstAcc = "";
    if (opts.sessionFile.endsWith(".json")) {
      // Editor session — resume it (new turns append to the same file).
      sessId = opts.sessionFile.replace(/^.*[\\/]/, "").replace(/\.json$/, "");
      sessMsgs = readEditorSession(opts.sessionFile);
      void chatPanel.webview.postMessage({ type: "transcript", messages: sessMsgs });
    } else {
      // CLI session — read-only view; new turns start a fresh editor session.
      sessId = nonce(); sessMsgs = [];
      void chatPanel.webview.postMessage({ type: "transcript", messages: readTranscript(opts.sessionFile) });
    }
  }
}

// ============================ Sidebar (Sessions + Account) ===================

export function createNarayaPanelProvider(
  extensionUri: vscode.Uri,
  openChat: (opts?: { sessionFile?: string; fresh?: boolean }) => void,
): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
      view.webview.html = sidebarHtml(view.webview, extensionUri);
      view.webview.onDidReceiveMessage(async (msg: any) => {
        switch (msg?.type) {
          case "ready":
          case "refreshSessions":
            view.webview.postMessage({ type: "sessions", list: msg?.source === "cli" ? listSessions() : listEditorSessions(), source: msg?.source === "cli" ? "cli" : "editor" });
            break;
          case "refreshAccount":
            view.webview.postMessage({ type: "account", result: await fetchAccount() });
            break;
          case "newChat":
            openChat({ fresh: true });
            break;
          case "openSession":
            if (typeof msg.file === "string") openChat({ sessionFile: msg.file });
            break;
          case "signIn":
            void vscode.commands.executeCommand("naraya.signIn");
            break;
        }
      });
    },
  };
}

function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"));
  const icon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "icon.png"));
  const chatJs = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "webview", "chat.js"));
  const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${n}';`;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; } * { box-sizing: border-box; }
  html,body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 8px; padding: 8px 14px; }
  .top img { width: 18px; height: 18px; } .top strong { flex: 1; font-size: 13px; }
  .top button { background: transparent; color: var(--vscode-foreground); opacity: .7; border: 1px solid var(--vscode-panel-border); padding: 4px 9px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .top button:hover { opacity: 1; }
  #log { flex: 1; overflow-y: auto; padding: 8px 18px 18px; }
  .welcome { text-align: center; padding: 56px 16px; }
  .welcome .wlogo { width: 56px; height: 56px; border-radius: 12px; margin-bottom: 12px; }
  .welcome h2 { margin: 4px 0; } .welcome p { opacity: .6; margin: 6px 0 18px; }
  .chip { display: inline-block; margin: 5px; padding: 7px 13px; border: 1px solid var(--vscode-panel-border); border-radius: 16px; cursor: pointer; font-size: 13px; }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  /* user turn */
  .umsg { background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 12px; margin: 16px 0 10px; white-space: pre-wrap; word-break: break-word; }
  /* tool / thinking steps (compact dot + line) */
  .step { display: flex; gap: 9px; align-items: flex-start; margin: 4px 0; font-size: 13px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; background: var(--vscode-descriptionForeground, #888); }
  .dot.run { background: var(--vscode-charts-yellow, #d7ba7d); } .dot.ok { background: var(--vscode-charts-green, #89d185); } .dot.err { background: var(--vscode-errorForeground); }
  .step .sbody { min-width: 0; flex: 1; }
  .shead { display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
  .shead b { font-weight: 600; flex: none; } .args { opacity: .6; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .ststate { opacity: .45; font-size: 11px; flex: none; }
  .thought { opacity: .55; font-style: italic; }
  .tout { margin: 4px 0 2px; padding: 8px 10px; max-height: 300px; overflow: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); border-radius: 6px; }
  .reason { opacity: .5; font-style: italic; font-size: 12.5px; margin: 4px 0; white-space: pre-wrap; }
  .errline { color: var(--vscode-errorForeground); font-size: 12px; margin: 4px 0; }
  .toolimg { max-width: 100%; border-radius: 6px; margin: 4px 0; }
  /* assistant markdown */
  .body { word-break: break-word; line-height: 1.6; margin: 2px 0; }
  .body p { margin: 5px 0; } .body h2,.body h3 { margin: 12px 0 4px; font-size: 1.04em; }
  .body ul,.body ol { margin: 4px 0; padding-left: 22px; } .body li { margin: 2px 0; }
  .body a { color: var(--vscode-textLink-foreground); }
  .body code { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.16)); padding: 1px 5px; border-radius: 4px; font-family: var(--vscode-editor-font-family, monospace); font-size: .92em; }
  .body pre { background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.16)); padding: 10px 12px; border-radius: 6px; overflow-x: auto; margin: 8px 0; }
  .body pre code { background: none; padding: 0; }
  .body table { border-collapse: collapse; margin: 6px 0; font-size: .95em; }
  .body th, .body td { border: 1px solid var(--vscode-panel-border); padding: 3px 9px; text-align: left; }
  .body th { background: var(--vscode-textBlockQuote-background, rgba(127,127,127,.08)); }
  /* composer (contained, Claude-style) */
  .barwrap { padding: 6px 14px 14px; position: relative; }
  .composer { max-width: 880px; margin: 0 auto; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 12px; background: var(--vscode-input-background); padding: 8px 10px; }
  .composer:focus-within { border-color: var(--vscode-focusBorder); }
  textarea { width: 100%; resize: none; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; font-family: inherit; font-size: inherit; max-height: 200px; padding: 2px; }
  .cfoot { display: flex; align-items: center; gap: 10px; margin-top: 6px; }
  .cfoot .grow { flex: 1; }
  .cfoot label { display: flex; gap: 4px; align-items: center; font-size: 11px; opacity: .65; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 5px; padding: 2px 5px; font-size: 11px; }
  #send { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; border-radius: 8px; width: 30px; height: 30px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  #mention { position: absolute; left: 50%; transform: translateX(-50%); width: min(880px, calc(100% - 28px)); bottom: 78px; max-height: 220px; overflow-y: auto; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border: 1px solid var(--vscode-panel-border); border-radius: 8px; display: none; z-index: 5; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
  .mi { padding: 6px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .mi.sel, .mi:hover { background: var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground)); color: var(--vscode-list-activeSelectionForeground); }
</style></head><body>
  <div class="top"><img src="${logo}"><strong>Naraya</strong><button id="new">+ New chat</button></div>
  <div id="log"></div>
  <div class="barwrap">
    <div id="mention"></div>
    <div class="composer">
      <textarea id="in" rows="1" placeholder="Message Naraya…  (@ to mention a file)"></textarea>
      <div class="cfoot">
        <label>Mode <select id="mode"><option value="ask">Ask</option><option value="auto" selected>Auto</option><option value="plan">Plan</option></select></label>
        <label>Effort <select id="effort"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select></label>
        <span class="grow"></span>
        <button id="send">${ICONS.send}</button>
      </div>
    </div>
  </div>
<script nonce="${n}">window.__naraya = { logo: ${JSON.stringify(String(logo))}, icon: ${JSON.stringify(String(icon))} };</script>
<script nonce="${n}" src="${chatJs}"></script>
</body></html>`;
}

function sidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"));
  const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';`;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; } * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 12px 12px 6px; } .brand img { width: 22px; height: 22px; }
  .newbtn { margin: 6px 12px 8px; }
  button { display: inline-flex; align-items: center; gap: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 7px 12px; border-radius: 6px; cursor: pointer; font-size: 12px; width: 100%; justify-content: center; }
  button:hover { background: var(--vscode-button-hoverBackground); } button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); width: auto; }
  .tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 4px; cursor: pointer; opacity: .6; border-bottom: 2px solid transparent; font-size: 12px; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .view { display: none; padding: 8px 8px; } .view.active { display: block; }
  input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px 8px; border-radius: 5px; outline: none; margin-bottom: 6px; }
  .muted { opacity: .6; padding: 6px 0; }
  .srctoggle { display: flex; gap: 4px; margin-bottom: 8px; }
  .srctoggle button { flex: 1; width: auto; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 4px 0; opacity: .6; }
  .srctoggle button.on { opacity: 1; background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-focusBorder); }
  .sess { display: flex; gap: 7px; padding: 4px 6px; border-radius: 5px; cursor: pointer; border: 1px solid transparent; align-items: center; }
  .sess:hover { background: var(--vscode-list-hoverBackground); }
  .sess .ic { opacity: .45; flex: none; } .sess .t { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.25; } .sess .m { font-size: 10.5px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
  h3 { margin: 4px 0 6px; font-size: 11px; text-transform: uppercase; opacity: .65; }
  .row { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); } .row:last-child { border: 0; } .row .k { opacity: .7; } .row .v { font-weight: 600; text-align: right; }
</style></head><body>
  <div class="brand"><img src="${logo}"><strong>Naraya AI</strong></div>
  <div class="newbtn"><button id="new">${ICONS.plus} New chat</button></div>
  <div class="tabs">
    <div class="tab active" data-v="sessions">${ICONS.sessions} Sessions</div>
    <div class="tab" data-v="account">${ICONS.account} Account</div>
  </div>
  <div class="view active" id="v-sessions">
    <div class="srctoggle"><button data-s="editor" class="on">Editor</button><button data-s="cli">CLI</button></div>
    <input id="search" placeholder="Search sessions…">
    <div id="sessions"><div class="muted">Loading…</div></div>
  </div>
  <div class="view" id="v-account">
    <div id="account"><div class="muted">Loading…</div></div>
    <button class="sec" id="refreshAcc" style="margin-top:8px">Refresh</button>
  </div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const IC = ${JSON.stringify(ICONS)};
  let sessions = [], src = 'editor';
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x===t));
    document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id==='v-'+t.dataset.v));
    if (t.dataset.v === 'sessions') vscode.postMessage({ type: 'refreshSessions', source: src });
    if (t.dataset.v === 'account') vscode.postMessage({ type: 'refreshAccount' });
  });
  document.querySelectorAll('.srctoggle button').forEach(b => b.onclick = () => {
    src = b.dataset.s;
    document.querySelectorAll('.srctoggle button').forEach(x => x.classList.toggle('on', x===b));
    vscode.postMessage({ type: 'refreshSessions', source: src });
  });
  document.getElementById('new').onclick = () => vscode.postMessage({ type: 'newChat' });
  function renderSessions() {
    const q = (document.getElementById('search').value||'').toLowerCase();
    const box = document.getElementById('sessions'); box.innerHTML = '';
    const items = sessions.filter(s => !q || (s.title+' '+s.project).toLowerCase().includes(q));
    if (!items.length) { box.innerHTML = '<div class="muted">No sessions.</div>'; return; }
    for (const s of items) {
      const d = document.createElement('div'); d.className='sess';
      const proj = s.project ? s.project.split(/[\\\\/]/).pop() : '';
      d.innerHTML = '<span class="ic">'+IC.sess+'</span><div style="min-width:0"><div class="t"></div><div class="m"></div></div>';
      d.querySelector('.t').textContent = s.title;
      d.querySelector('.m').textContent = proj + ' · ' + new Date(s.mtime).toLocaleString();
      d.onclick = () => vscode.postMessage({ type: 'openSession', file: s.file });
      box.appendChild(d);
    }
  }
  document.getElementById('search').addEventListener('input', renderSessions);
  function num(n){ return (n||0).toLocaleString(); }
  function renderAccount(r) {
    const box = document.getElementById('account');
    if (!r || !r.ok) {
      if (r && r.error === 'not-signed-in') { box.innerHTML='<div class="muted">Not signed in.</div>'; const b=document.createElement('button'); b.textContent='Sign in with Naraya'; b.onclick=()=>vscode.postMessage({type:'signIn'}); box.appendChild(b); return; }
      box.innerHTML = '<div class="muted">Usage unavailable'+(r&&r.error?' ('+r.error+')':'')+'.</div>'; return;
    }
    const s=r.data||{}, a=s.account||{}, c=s.credit||{}, q=s.quota||{}, u=s.usage||{};
    const rows = [['Email',a.email||'—'],['Plan',a.plan||'—'],
      ['Credit','Rp '+Math.round(c.available||0).toLocaleString()+(c.usd_equivalent?' / $'+c.usd_equivalent:'')],
      ['Quota', q.limit>0 ? num(q.remaining)+' / '+num(q.limit)+' '+(q.unit||'tokens') : 'fair-use'],
      ['Tokens today',num(u.tokens_today)],['Tokens month',num(u.tokens_month)],
      ['Requests today',num(u.requests_today)],['Success rate', typeof u.success_rate==='number'?Math.round(u.success_rate*100)+'%':'—'],
      ['Models', Array.isArray(s.models)?s.models.length:0]];
    box.innerHTML = '<h3>Account</h3>'+rows.map(([k,v])=>'<div class="row"><span class="k">'+k+'</span><span class="v">'+String(v).replace(/</g,'&lt;')+'</span></div>').join('');
  }
  document.getElementById('refreshAcc').onclick = () => vscode.postMessage({ type: 'refreshAccount' });
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'sessions') { sessions = m.list||[]; renderSessions(); }
    else if (m.type === 'account') renderAccount(m.result);
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
