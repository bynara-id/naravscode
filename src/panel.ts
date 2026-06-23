import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import {
  createPiEnvironment,
  createPiRpcArgs,
  ensurePiBinary,
  findPiBinary,
  piBinaryExists,
  spawnByNara,
} from "./pi.ts";

// ByNara UI: a lightweight sidebar (Sessions + Account + New Chat) plus a full
// chat that opens as an EDITOR-AREA webview panel — like Claude Code's tab,
// not a cramped sidebar view. The engine is the `naracli` CLI (RPC); these views
// only render + drive it.

const ROUTER_BASE = "https://router.bynara.id/v1";

function agentDir(): string {
  return join(homedir(), ".bynara", "agent");
}

function provider(): { baseUrl: string; apiKey: string } | undefined {
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir(), "models.json"), "utf8"));
    const p = cfg?.providers?.bynara;
    if (p?.apiKey) return { baseUrl: p.baseUrl || ROUTER_BASE, apiKey: p.apiKey };
  } catch {
    /* not signed in */
  }
  return undefined;
}

// Claude-Code-style tab title: a short topic derived from the first user turn.
function deriveTitle(text: string): string {
  let t = (text || "")
    .replace(/^You may browse the web[^\n]*\n+/i, "")
    .replace(/^Plan first[^\n]*\n+/i, "")
    .replace(/^@\S+\s*/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > 42) t = t.slice(0, 42).replace(/\s\S*$/, "") + "…";
  return t || "ByNara";
}

// Subagents + their effective model (override in agent-models.json wins over the
// frontmatter `model:`). Keyed by the agent's frontmatter name (e.g. nara-build).
function listAgents(): Array<{ name: string; model: string }> {
  const dir = join(agentDir(), "agents");
  let overrides: Record<string, string> = {};
  try {
    overrides = JSON.parse(readFileSync(join(agentDir(), "agent-models.json"), "utf8")) || {};
  } catch {
    /* none */
  }
  const out: Array<{ name: string; model: string }> = [];
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      let name = e.name,
        model = "";
      try {
        const txt = readFileSync(join(dir, e.name, "AGENTS.md"), "utf8");
        const fm = txt.match(/^---([\s\S]*?)---/);
        const head = fm ? (fm[1] ?? "") : "";
        const nm = head.match(/^name:\s*(.+)$/m);
        if (nm && nm[1]) name = nm[1].trim();
        const mm = head.match(/^model:\s*(.+)$/m);
        if (mm && mm[1]) model = mm[1].trim();
      } catch {
        /* skip */
      }
      out.push({ name, model: overrides[name] ?? model });
    }
  } catch {
    /* no agents dir */
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function readMcp(): Record<string, any> {
  try {
    return JSON.parse(readFileSync(join(agentDir(), "mcp.json"), "utf8"))?.mcpServers ?? {};
  } catch {
    return {};
  }
}
function mcpEntries(): Array<{ name: string; detail: string; bundled: boolean }> {
  return Object.entries(readMcp()).map(([name, v]: [string, any]) => ({
    name,
    detail: v?.url || [v?.command, ...(v?.args ?? [])].filter(Boolean).join(" "),
    bundled: name === "context7",
  }));
}
function writeMcp(servers: Record<string, any>): void {
  writeFileSync(join(agentDir(), "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
}

function setAgentModel(name: string, model: string): void {
  const p = join(agentDir(), "agent-models.json");
  let all: Record<string, string> = {};
  try {
    all = JSON.parse(readFileSync(p, "utf8")) || {};
  } catch {
    /* none */
  }
  all[name] = model;
  writeFileSync(p, JSON.stringify(all, null, 2));
}

function listModels(): {
  provider: string;
  models: Array<{ id: string; name: string }>;
  default: string;
} {
  try {
    const cfg = JSON.parse(readFileSync(join(agentDir(), "models.json"), "utf8"));
    const provs = cfg?.providers ?? {};
    const provider = provs.bynara ? "bynara" : (Object.keys(provs)[0] ?? "bynara");
    const models = (provs[provider]?.models ?? [])
      .filter((m: any) => m?.id)
      .map((m: any) => ({ id: String(m.id), name: String(m.name ?? m.id) }));
    // Engine default lives in settings.json (defaultModel, no provider prefix).
    let def = "";
    try {
      const st = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
      def = String(st?.defaultModel ?? "").replace(/^.*\//, "");
    } catch {
      /* no settings */
    }
    if (!models.some((m: { id: string }) => m.id === def)) def = models[0]?.id ?? "";
    return { provider, models, default: def };
  } catch {
    return { provider: "bynara", models: [], default: "" };
  }
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
    dirs = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
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
        const text =
          typeof c === "string"
            ? c
            : Array.isArray(c)
              ? c.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join(" ")
              : "";
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
      const text =
        typeof c === "string"
          ? c
          : Array.isArray(c)
            ? c
                .filter((p: any) => p?.type === "text")
                .map((p: any) => p.text)
                .join("")
            : "";
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
  if (name === "read" || name === "write" || name === "edit" || name === "ast_edit")
    return String(args.path ?? args.file ?? "");
  if (name === "grep" || name === "ast_grep") return String(args.pattern ?? args.query ?? "");
  if (name === "delegate")
    return String(args.agent ?? "") + (args.task ? ": " + String(args.task).slice(0, 80) : "");
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
  else if (Array.isArray(c))
    text = c
      .map((p: any) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
      .join("");
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
  const m = text.match(
    /([A-Za-z]:[\\/][^\n\r"']*?\.(?:png|jpe?g|gif|svg)|\/[^\n\r"']*?\.(?:png|jpe?g|gif|svg))/i,
  );
  return m?.[1]?.trim() ?? "";
}
// Read a (small) image into a data URI so the webview can show it inline.
function readImageDataUri(p: string): string {
  try {
    const st = statSync(p);
    if (!st.isFile() || st.size > 6_000_000) return "";
    const ext = (p.split(".").pop() || "").toLowerCase();
    const mime =
      ext === "svg"
        ? "image/svg+xml"
        : ext === "jpg" || ext === "jpeg"
          ? "image/jpeg"
          : ext === "gif"
            ? "image/gif"
            : "image/png";
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
    const title = (messages.find((m) => m.role === "user")?.text || "(chat)")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    // Stamp the workspace folder so sessions can be scoped to the current project.
    const project = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
    require("node:fs").writeFileSync(
      join(dir, id + ".json"),
      JSON.stringify({ id, title, project, mtime: Date.now(), messages }, null, 2),
    );
  } catch {
    /* best-effort */
  }
}

// Scope a session list to the current workspace folder unless the user opted to
// see sessions from every folder. CLI sessions carry their `cwd`; editor sessions
// carry the workspace path stamped at save time (older ones without it fall back
// to "editor" and only appear under "show all").
function currentWorkspaceFolder(): string {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
}
function filterSessionsByFolder(list: SessionInfo[], showAll: boolean): SessionInfo[] {
  if (showAll) return list;
  const cur = currentWorkspaceFolder();
  if (!cur) return list;
  const norm = (p: string) => p.replace(/[\\/]+$/, "").toLowerCase();
  return list.filter((s) => norm(s.project) === norm(cur));
}

// Backfill an editor session's folder the first time it's opened: opening it means
// the user is in its folder, so legacy sessions (saved as "editor"/no folder)
// migrate to correct per-folder scoping instead of showing in every folder.
function stampEditorSessionFolder(file: string): void {
  try {
    if (!file.startsWith(editorSessionsDir())) return;
    const j = JSON.parse(readFileSync(file, "utf8"));
    const cur = currentWorkspaceFolder();
    if (!cur) return;
    if (typeof j.project === "string" && j.project && j.project !== "editor") return; // already scoped
    j.project = cur;
    require("node:fs").writeFileSync(file, JSON.stringify(j, null, 2));
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
        out.push({
          file,
          title: j.title || "(chat)",
          project: typeof j.project === "string" && j.project ? j.project : "editor",
          mtime: j.mtime || statSync(file).mtimeMs,
        });
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
  trash: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 8.5h6l.5-8.5"/></svg>`,
  send: `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M1.7 2 14.5 8 1.7 14l1.8-6-1.8-6Zm2 2.6L4.4 8 3.7 11.4 11 8 3.7 4.6Z"/></svg>`,
  upload: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 10V2.6M5.2 5.2 8 2.4l2.8 2.8M3 10v2.4a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V10"/></svg>`,
  ctx: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6M9 2l4 4M9 2v4h4M5.5 9h5M5.5 11h3"/></svg>`,
  globe: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c1.8 1.6 2.8 3.8 2.8 6S9.8 12.4 8 14C6.2 12.4 5.2 10.2 5.2 8S6.2 3.6 8 2Z"/></svg>`,
  mode: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><circle cx="4.5" cy="4.5" r="1.6"/><path d="M7 4.5h6M3 11.5h6"/><circle cx="11.5" cy="11.5" r="1.6"/></svg>`,
  brain: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M6 2.6A2.1 2.1 0 0 0 4 5a2 2 0 0 0-1 3.6A2 2 0 0 0 5 12a1.9 1.9 0 0 0 1 .3V2.6Zm4 0A2.1 2.1 0 0 1 12 5a2 2 0 0 1 1 3.6A2 2 0 0 1 11 12a1.9 1.9 0 0 1-1 .3V2.6Z"/></svg>`,
  cpu: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="4.5" y="4.5" width="7" height="7" rx="1"/><path d="M6.5 1.5v2M9.5 1.5v2M6.5 12.5v2M9.5 12.5v2M1.5 6.5h2M1.5 9.5h2M12.5 6.5h2M12.5 9.5h2"/></svg>`,
  zap: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M9 1 3.5 9H8l-1 6 5.5-8H8z"/></svg>`,
  hand: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M5 7V3.5a1 1 0 0 1 2 0V7m0-.5V2.8a1 1 0 0 1 2 0V7m0-.8a1 1 0 0 1 2 0V9c0 2.5-1.6 4.5-4 4.5S4 12 4 9.5V8a1 1 0 0 1 1.6-.8"/></svg>`,
  plan: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="3" y="2.5" width="10" height="11" rx="1.5"/><path d="M5.5 6h5M5.5 8.5h5M5.5 11h3"/></svg>`,
  check: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3.5 8.5l3 3 6-7"/></svg>`,
  slash: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M6.5 11.5l3-7"/></svg>`,
  refresh: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5"/></svg>`,
  caveman: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M2 6.5 4.5 8 2 9.5M14 6.5 11.5 8 14 9.5M6.2 12l3.6-8"/></svg>`,
  logout: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M6 14H3.5A1.5 1.5 0 0 1 2 12.5v-9A1.5 1.5 0 0 1 3.5 2H6M10.5 11l3-3-3-3M13 8H6"/></svg>`,
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
  if (!chatOut) chatOut = vscode.window.createOutputChannel("ByNara");

  if (chatPanel) {
    chatPanel.reveal(vscode.ViewColumn.Active);
  } else {
    chatPanel = vscode.window.createWebviewPanel(
      "bynara.chat",
      "ByNara",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      },
    );
    chatPanel.iconPath = vscode.Uri.joinPath(extensionUri, "assets", "logo.svg");
    chatPanel.webview.html = chatHtml(chatPanel.webview, extensionUri);

    const panel = chatPanel;
    const post = (m: any) => void panel.webview.postMessage(m);
    const send = (o: object) => chatChild?.stdin?.write(`${JSON.stringify(o)}\n`);
    let chatMode = "auto"; // ask | auto | plan
    let chatEffort = ""; // low | medium | high — sent to the engine when it changes
    let chatModel = ""; // model id — sent to the engine (set_model) when it changes
    const uiPending = new Map<string, string>(); // extension_ui_request id -> method, awaiting inline answer

    const ensureChild = async (): Promise<boolean> => {
      if (chatChild) return true;
      // Non-blocking: if the CLI is missing, surface the error INSIDE the chat
      // immediately (so it doesn't hang on "Thinking…") and fire the install
      // prompt without awaiting it — a blocking modal here would stall the spinner
      // until the user clicks a button.
      if (!piBinaryExists()) {
        post({
          type: "chatError",
          error:
            "ByNara CLI not found. Install it with `npm i -g bynara-cli`, then send your message again.",
        });
        void ensurePiBinary();
        return false;
      }
      const bynara = findPiBinary();
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      // Persist engine context to a per-editor-session file so reopening a chat
      // restores the agent's memory (not just the visible transcript).
      const engineSession = join(editorSessionsDir(), sessId + ".session.jsonl");
      try {
        require("node:fs").mkdirSync(editorSessionsDir(), { recursive: true });
      } catch {
        /* ignore */
      }
      const args = createPiRpcArgs(extensionUri, engineSession);
      chatOut!.appendLine(`[chat] spawn ${bynara} ${args.join(" ")} (cwd=${cwd ?? "-"})`);
      chatChild = spawnByNara(bynara, args, {
        cwd,
        env: { ...process.env, ...createPiEnvironment(getBridgeConfig()) },
        stdio: ["pipe", "pipe", "pipe"],
      });
      chatChild.stderr?.on("data", (d) =>
        chatOut!.appendLine(`[stderr] ${d.toString().trimEnd()}`),
      );
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
        if (ev.type === "response" && ev.command === "get_commands" && ev.data?.commands) {
          post({ type: "commands", list: ev.data.commands });
          return;
        }
        if (ev.type === "extension_ui_request") {
          const id = ev.id,
            method = ev.method;
          if (!id) return;
          void (async () => {
            try {
              if (method === "confirm") {
                if (chatMode === "auto") {
                  send({ type: "extension_ui_response", id, confirmed: true }); // auto-approve
                  post({
                    type: "chatTool",
                    name: "auto-approved: " + String(ev.title ?? "action"),
                  });
                  return;
                }
                const pick = await vscode.window.showWarningMessage(
                  String(ev.message ?? ev.title ?? "Allow?"),
                  { modal: true },
                  "Allow",
                );
                send({ type: "extension_ui_response", id, confirmed: pick === "Allow" });
              } else if (
                method === "select" &&
                typeof ev.title === "string" &&
                ev.title.startsWith("BYNARA_ASK:")
              ) {
                // The `ask_user` tool batches questions; render a tabbed picker.
                let questions: any[] = [];
                try {
                  questions = JSON.parse(ev.title.slice("BYNARA_ASK:".length));
                } catch {
                  /* malformed */
                }
                uiPending.set(id, "askmulti");
                post({ type: "askMulti", id, questions });
              } else if (method === "select") {
                const o = Array.isArray(ev.options) ? ev.options.map(String) : [];
                // A permission GATE arrives as a select whose options are about
                // allowing/denying an action (Allow once / Allow for this session /
                // Auto-approve all / Deny). A genuine ask_user question is anything
                // else — never auto-answer those.
                const isGate = o.some((x: string) =>
                  /\b(allow|deny|reject|approve|auto-approve)\b/i.test(x),
                );
                if (isGate) {
                  if (chatMode === "auto" && o.length) {
                    const pick =
                      o.find((x: string) => /auto-approve/i.test(x)) ||
                      o.find((x: string) => /this session/i.test(x)) ||
                      o.find((x: string) => /allow/i.test(x)) ||
                      o[0];
                    send({ type: "extension_ui_response", id, value: pick });
                    post({
                      type: "chatTool",
                      name: "auto-approved: " + String(ev.title ?? "action"),
                    });
                    return;
                  }
                  const c = await vscode.window.showQuickPick(o, {
                    title: String(ev.title ?? "Select"),
                  });
                  send(
                    c === undefined
                      ? { type: "extension_ui_response", id, cancelled: true }
                      : { type: "extension_ui_response", id, value: c },
                  );
                  return;
                }
                // Genuine question → render inline option buttons in the chat and
                // wait for the user to click one (sent back as a uiResponse).
                uiPending.set(id, "select");
                post({ type: "uiSelect", id, title: String(ev.title ?? ""), options: o });
              } else if (method === "input") {
                // Inline free-text question card in the chat.
                uiPending.set(id, "input");
                post({
                  type: "uiInput",
                  id,
                  title: String(ev.title ?? ""),
                  placeholder: String(ev.placeholder ?? ""),
                });
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
          if (a?.type === "text_delta" && typeof a.delta === "string") {
            asstAcc += a.delta;
            post({ type: "chatDelta", delta: a.delta });
          } else if (a?.type === "reasoning_delta" && typeof a.delta === "string")
            post({ type: "chatReason", delta: a.delta });
          return;
        }
        if (ev.type === "tool_execution_start") {
          post({
            type: "toolStart",
            id: ev.toolCallId,
            name: ev.toolName,
            summary: toolSummary(ev.toolName, ev.args),
          });
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
          if (asstAcc.trim()) {
            sessMsgs.push({ role: "assistant", text: asstAcc.trim() });
            saveEditorSession(sessId, sessMsgs);
          }
          asstAcc = "";
          post({ type: "chatDone" });
        }
      }
    };

    panel.webview.onDidReceiveMessage(async (msg: any) => {
      const hasImages = Array.isArray(msg?.images) && msg.images.some((im: any) => im && im.data);
      if (msg?.type === "chat" && typeof msg.text === "string" && (msg.text.trim() || hasImages)) {
        if (typeof msg.mode === "string") chatMode = msg.mode;
        if (!(await ensureChild())) return;
        sessMsgs.push({ role: "user", text: msg.text.trim() || "[image]" });
        if (sessMsgs.filter((m) => m.role === "user").length === 1)
          panel.title = deriveTitle(msg.text);
        asstAcc = "";
        // Model -> engine (set_model, only when it changes; "" = engine default).
        if (typeof msg.model === "string" && msg.model && msg.model !== chatModel) {
          chatModel = msg.model;
          send({
            id: `m${Date.now()}`,
            type: "set_model",
            provider: msg.provider || "bynara",
            modelId: chatModel,
          });
        }
        // Effort -> engine thinking level (only when it changes).
        if (typeof msg.effort === "string" && msg.effort !== chatEffort) {
          chatEffort = msg.effort;
          send({ id: `t${Date.now()}`, type: "set_thinking_level", level: chatEffort });
        }
        let text = msg.text.trim();
        if (msg.web)
          text = "You may browse the web (web_search / web tools) to answer this.\n\n" + text;
        if (chatMode === "plan")
          text =
            "Plan first — investigate and present a step-by-step plan, do NOT edit anything yet.\n\n" +
            text;
        const imgs = hasImages
          ? msg.images
              .filter((im: any) => im && im.data)
              .map((im: any) => ({
                mimeType: String(im.mimeType || "image/png"),
                data: String(im.data),
              }))
          : [];
        send({
          id: `p${Date.now()}`,
          type: "prompt",
          message: text,
          ...(imgs.length ? { images: imgs } : {}),
        });
      } else if (msg?.type === "followup" && typeof msg.text === "string" && msg.text.trim()) {
        // Queue a steering message while the agent is still running.
        if (chatChild) {
          sessMsgs.push({ role: "user", text: msg.text.trim() });
          send({ id: `f${Date.now()}`, type: "follow_up", message: msg.text.trim() });
        }
      } else if (msg?.type === "signOut") {
        try {
          chatChild?.kill();
        } catch {
          /* ignore */
        }
        chatChild = undefined;
        await vscode.commands.executeCommand("bynara.signOut"); // clears secret + models.json
        post({ type: "chatError", error: "Signed out. Sign in again to continue." });
      } else if (msg?.type === "listFiles") {
        try {
          const uris = await vscode.workspace.findFiles(
            "**/*",
            "**/{node_modules,.git,dist,out,build,vendor,.venv,venv,__pycache__,target,.next,.nuxt,.svelte-kit,coverage,.gradle,.idea,.cache,bower_components,Pods,vendor/bundle}/**",
            8000,
          );
          const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
          post({
            type: "files",
            list: uris
              .map((u) => vscode.workspace.asRelativePath(u, false))
              .filter(Boolean)
              .sort(),
          });
          void root;
        } catch {
          post({ type: "files", list: [] });
        }
      } else if (msg?.type === "uiResponse" && typeof msg.id === "string") {
        if (uiPending.has(msg.id)) {
          uiPending.delete(msg.id);
          if (msg.cancelled) send({ type: "extension_ui_response", id: msg.id, cancelled: true });
          else send({ type: "extension_ui_response", id: msg.id, value: String(msg.value ?? "") });
        }
      } else if (msg?.type === "listAgents") {
        post({ type: "agents", list: listAgents() });
      } else if (
        msg?.type === "setAgentModel" &&
        typeof msg.name === "string" &&
        typeof msg.model === "string"
      ) {
        try {
          setAgentModel(msg.name, msg.model);
          post({ type: "agents", list: listAgents(), saved: msg.name });
        } catch (e: any) {
          post({
            type: "chatError",
            error: `Failed to set agent model: ${String(e?.message ?? e)}`,
          });
        }
      } else if (msg?.type === "customModel") {
        const id = (
          await vscode.window.showInputBox({
            title: "Custom model",
            placeHolder: "e.g. glm-4.6 or claude-opus-4.7",
            prompt: "Model id (routes through the bynara provider)",
          })
        )?.trim();
        if (id) post({ type: "pickModel", id });
      } else if (msg?.type === "getMcp") {
        post({ type: "mcp", list: mcpEntries() });
      } else if (msg?.type === "addMcp") {
        const name = (
          await vscode.window.showInputBox({
            title: "MCP server name",
            placeHolder: "e.g. github, playwright",
          })
        )?.trim();
        if (name) {
          const spec = (
            await vscode.window.showInputBox({
              title: `Command or URL for "${name}"`,
              placeHolder: "npx -y @some/mcp   OR   https://host/mcp",
            })
          )?.trim();
          if (spec) {
            const s = readMcp();
            s[name] = /^https?:\/\//.test(spec)
              ? { type: "http", url: spec }
              : { command: spec.split(/\s+/)[0], args: spec.split(/\s+/).slice(1) };
            writeMcp(s);
          }
        }
        post({ type: "mcp", list: mcpEntries() });
      } else if (msg?.type === "removeMcp" && typeof msg.name === "string") {
        const s = readMcp();
        delete s[msg.name];
        writeMcp(s);
        post({ type: "mcp", list: mcpEntries() });
      } else if (msg?.type === "compact") {
        if (chatChild) {
          send({ id: `c${Date.now()}`, type: "compact" });
          post({ type: "chatTool", name: "compacting context…" });
        }
      } else if (msg?.type === "getSuperpowers") {
        let on = true;
        try {
          on = JSON.parse(readFileSync(join(agentDir(), "superpowers.json"), "utf8"))?.on !== false;
        } catch {
          /* default on */
        }
        post({ type: "superpowers", on });
      } else if (msg?.type === "setSuperpowers") {
        try {
          writeFileSync(
            join(agentDir(), "superpowers.json"),
            JSON.stringify({ on: !!msg.on }, null, 2),
          );
        } catch {
          /* ignore */
        }
        post({ type: "superpowers", on: !!msg.on });
      } else if (msg?.type === "getCaveman") {
        let level = "lite"; // engine default
        try {
          level =
            JSON.parse(readFileSync(join(agentDir(), "caveman.json"), "utf8"))?.level ?? "lite";
        } catch {
          /* default */
        }
        post({ type: "caveman", level });
      } else if (msg?.type === "setCaveman" && typeof msg.level === "string") {
        try {
          writeFileSync(
            join(agentDir(), "caveman.json"),
            JSON.stringify({ level: msg.level }, null, 2),
          );
        } catch {
          /* ignore */
        }
        post({ type: "caveman", level: msg.level });
      } else if (msg?.type === "getUsage") {
        post({ type: "usage", result: await fetchAccount() });
      } else if (msg?.type === "listCommands") {
        if (await ensureChild()) send({ type: "get_commands" });
      } else if (msg?.type === "listModels") {
        // All ByNara models support reasoning, so no per-model gating needed.
        post({ type: "models", ...listModels() });
      } else if (msg?.type === "attach") {
        try {
          const picks = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach",
          });
          if (picks?.length) {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri;
            const paths = picks.map((u) =>
              root ? vscode.workspace.asRelativePath(u, false) : u.fsPath,
            );
            post({ type: "attachPaths", paths });
          }
        } catch {
          /* cancelled */
        }
      } else if (msg?.type === "newChat") {
        try {
          chatChild?.kill();
        } catch {
          /* ignore */
        }
        chatChild = undefined;
        sessId = nonce();
        sessMsgs = [];
        asstAcc = "";
        chatModel = "";
        panel.title = "ByNara";
      } else if (msg?.type === "stop") {
        // Graceful: abort the current run but keep the session/child alive.
        if (chatChild) send({ id: `a${Date.now()}`, type: "abort" });
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
    try {
      chatChild?.kill();
    } catch {
      /* ignore */
    }
    chatChild = undefined;
    sessId = nonce();
    sessMsgs = [];
    asstAcc = "";
    chatPanel.title = "ByNara";
    void chatPanel.webview.postMessage({ type: "reset" });
  } else if (opts.sessionFile) {
    try {
      chatChild?.kill();
    } catch {
      /* ignore */
    }
    chatChild = undefined;
    asstAcc = "";
    if (opts.sessionFile.endsWith(".json")) {
      // Editor session — resume it (new turns append to the same file).
      sessId = opts.sessionFile.replace(/^.*[\\/]/, "").replace(/\.json$/, "");
      sessMsgs = readEditorSession(opts.sessionFile);
      void chatPanel.webview.postMessage({ type: "transcript", messages: sessMsgs });
    } else {
      // CLI session — read-only view; new turns start a fresh editor session.
      sessId = nonce();
      sessMsgs = [];
      const tx = readTranscript(opts.sessionFile);
      void chatPanel.webview.postMessage({ type: "transcript", messages: tx });
      const first = tx.find((m) => m.role === "user");
      chatPanel.title = first ? deriveTitle(first.text) : "ByNara";
      return;
    }
    const firstU = sessMsgs.find((m) => m.role === "user");
    chatPanel.title = firstU ? deriveTitle(firstU.text) : "ByNara";
  }
}

// ============================ Sidebar (Sessions + Account) ===================

export function createByNaraPanelProvider(
  extensionUri: vscode.Uri,
  openChat: (opts?: { sessionFile?: string; fresh?: boolean }) => void,
): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
      view.webview.html = sidebarHtml(view.webview, extensionUri);
      // Re-check auth when the panel becomes visible again (e.g. after the user
      // returns from the browser sign-in), so the login screen flips to the app.
      view.onDidChangeVisibility(() => {
        if (view.visible) view.webview.postMessage({ type: "auth", signedIn: !!provider() });
      });
      view.webview.onDidReceiveMessage(async (msg: any) => {
        switch (msg?.type) {
          case "ready":
            view.webview.postMessage({ type: "auth", signedIn: !!provider() });
            break;
          case "refreshSessions": {
            const cli = msg?.source === "cli";
            const all = !!msg?.showAll;
            const list = filterSessionsByFolder(cli ? listSessions() : listEditorSessions(), all);
            view.webview.postMessage({ type: "sessions", list, source: cli ? "cli" : "editor" });
            break;
          }
          case "refreshAccount":
            view.webview.postMessage({ type: "account", result: await fetchAccount() });
            break;
          case "signOut": {
            const ok = await vscode.window.showWarningMessage(
              "Sign out of ByNara?",
              { modal: true },
              "Sign out",
            );
            if (ok === "Sign out") {
              await vscode.commands.executeCommand("bynara.signOut"); // clears secret + models.json
              view.webview.postMessage({ type: "auth", signedIn: false });
            }
            break;
          }
          case "newChat":
            openChat({ fresh: true });
            break;
          case "openSession":
            if (typeof msg.file === "string") {
              stampEditorSessionFolder(msg.file);
              openChat({ sessionFile: msg.file });
            }
            break;
          case "deleteSession":
            if (typeof msg.file === "string") {
              const ok = await vscode.window.showWarningMessage(
                "Delete this session permanently?",
                { modal: true, detail: "This cannot be undone." },
                "Delete",
              );
              if (ok === "Delete") {
                try {
                  require("node:fs").rmSync(msg.file, { force: true });
                } catch {
                  /* ignore */
                }
                const cli = msg.source === "cli";
                const list = filterSessionsByFolder(
                  cli ? listSessions() : listEditorSessions(),
                  !!msg.showAll,
                );
                view.webview.postMessage({
                  type: "sessions",
                  list,
                  source: cli ? "cli" : "editor",
                });
              }
            }
            break;
          case "signIn": {
            const ok = await vscode.commands.executeCommand("bynara.signIn");
            view.webview.postMessage({ type: "auth", signedIn: Boolean(ok) || !!provider() });
            break;
          }
        }
      });
    },
  };
}

function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"));
  const icon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "icon.png"));
  const chatJs = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "assets", "webview", "chat.js"),
  );
  const logos = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "provider-logos"));
  const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${n}';`;
  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root { color-scheme: light dark; --nry: #3b82f6; --nry-hover: #2f74e6; --nry-soft: rgba(59,130,246,.16); } * { box-sizing: border-box; }
  html,body { height: 100%; margin: 0; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); display: flex; flex-direction: column; }
  .top { display: flex; align-items: center; gap: 8px; padding: 8px 14px; }
  .top img { width: 18px; height: 18px; } .top strong { flex: 1; font-size: 13px; }
  .top button { background: transparent; color: var(--vscode-foreground); opacity: .7; border: 1px solid var(--vscode-panel-border); padding: 4px 9px; border-radius: 6px; cursor: pointer; font-size: 12px; }
  .top button:hover { opacity: 1; }
  #log { flex: 1; overflow-y: auto; padding: 8px 24px 18px; }
  .welcome { text-align: center; padding: 56px 16px; }
  .welcome .wlogo { width: 168px; height: auto; margin-bottom: 14px; }
  .welcome h2 { margin: 4px 0; } .welcome p { opacity: .6; margin: 6px 0 18px; }
  .chip { display: inline-block; margin: 5px; padding: 7px 13px; border: 1px solid var(--vscode-panel-border); border-radius: 16px; cursor: pointer; font-size: 13px; }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  /* user turn */
  .umsg { background: var(--vscode-input-background); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 12px; margin: 16px 0 10px; white-space: pre-wrap; word-break: break-word; }
  /* tool / thinking steps (compact dot + line) */
  .step { display: flex; gap: 9px; align-items: flex-start; margin: 6px 0; font-size: 13px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.06)); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 4px 10px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; flex: none; background: var(--vscode-descriptionForeground, #888); }
  .dot.run { background: var(--vscode-charts-yellow, #d7ba7d); } .dot.ok { background: var(--vscode-charts-green, #89d185); } .dot.err { background: var(--vscode-errorForeground); }
  .step .sbody { min-width: 0; flex: 1; }
  .shead { display: flex; gap: 8px; align-items: baseline; cursor: pointer; }
  .shead b { font-weight: 600; flex: none; } .args { opacity: .6; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; }
  .ststate { opacity: .45; font-size: 11px; flex: none; }
  .thought { opacity: .55; font-style: italic; }
  .tout { margin: 4px 0 2px; padding: 8px 10px; overflow-x: auto; font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; white-space: pre-wrap; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.12)); border-radius: 6px; }
  .reason { margin: 8px 0; border-left: 2px solid var(--vscode-panel-border); padding-left: 10px; }
  .reason .rhead { font-size: 11.5px; font-weight: 600; opacity: .65; cursor: pointer; user-select: none; padding: 1px 0; }
  .reason .rhead::after { content: " ▾"; opacity: .6; }
  .reason.collapsed .rhead::after { content: " ▸"; }
  .reason .rbody { opacity: .5; font-style: italic; font-size: 12.5px; margin-top: 3px; white-space: pre-wrap; }
  .reason.collapsed .rbody { display: none; }
  .errline { color: var(--vscode-errorForeground); font-size: 12px; margin: 4px 0; }
  .toolimg { max-width: 100%; border-radius: 6px; margin: 4px 0; }
  .todo { margin: 8px 0; padding: 8px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: var(--vscode-textCodeBlock-background, rgba(127,127,127,.08)); font-size: 12.5px; }
  .todo-h { font-weight: 600; margin-bottom: 6px; display: flex; gap: 8px; align-items: center; }
  .todo-c { font-weight: 400; opacity: .6; font-family: var(--vscode-editor-font-family, monospace); }
  .todo-r { display: flex; gap: 8px; align-items: baseline; padding: 2px 0; line-height: 1.45; }
  .todo-i { flex: none; width: 14px; text-align: center; }
  .td-done { opacity: .55; } .td-done span:last-child { text-decoration: line-through; }
  .td-done .todo-i { color: var(--vscode-charts-green, #6fbf73); }
  .td-run { color: var(--vscode-charts-blue, #4da3ff); font-weight: 600; }
  .td-run .todo-i { color: var(--vscode-charts-blue, #4da3ff); }
  .td-todo { opacity: .8; } .td-todo .todo-i { opacity: .5; }
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
  .composer { max-width: 680px; margin: 0 auto; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 12px; background: var(--vscode-input-background); padding: 8px 10px; transition: border-color .12s; }
  .composer:focus-within { border-color: var(--nry); box-shadow: 0 0 0 1px var(--nry); }
  textarea { width: 100%; resize: none; background: transparent; color: var(--vscode-input-foreground); border: none; outline: none; font-family: inherit; font-size: inherit; max-height: 200px; padding: 2px; }
  .chips { display: none; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  .chip-img { position: relative; display: inline-block; }
  .chip-img img { height: 46px; width: auto; border-radius: 6px; border: 1px solid var(--vscode-panel-border); display: block; }
  .chip-x { position: absolute; top: -6px; right: -6px; background: var(--vscode-editorWidget-background, #222); border: 1px solid var(--vscode-panel-border); border-radius: 50%; width: 16px; height: 16px; font-size: 9px; line-height: 1; cursor: pointer; color: var(--vscode-foreground); padding: 0; }
  .umsg .uimg { height: 80px; border-radius: 6px; margin: 6px 6px 0 0; border: 1px solid var(--vscode-panel-border); }
  .cfoot { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
  .cfoot .grow { flex: 1; }
  .cfoot label { display: flex; gap: 4px; align-items: center; font-size: 11px; opacity: .65; }
  .cfoot .lico { display: inline-flex; opacity: .8; margin-right: 1px; }
  .cfoot label.disabled { opacity: .32; }
  .cfoot label.disabled select { cursor: not-allowed; }
  .bico.on { color: var(--nry); opacity: 1; }
  #effortlbl.reasoning { opacity: .9; }
  .popmenu.cmdmenu { position: fixed; left: 50%; right: auto; bottom: 104px; transform: translateX(-50%); }
  .cmdmenu { width: min(680px, calc(100% - 40px)); padding: 0; }
  .popmenu.plusmenu { width: 260px; }
  #cmdlist { max-height: 300px; overflow-y: auto; padding: 6px; }
  .cmd-sec { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; opacity: .5; padding: 8px 10px 4px; }
  .cmi { display: flex; align-items: baseline; gap: 8px; padding: 6px 10px; border-radius: 7px; cursor: pointer; font-size: 12.5px; }
  .cmi:hover, .cmi.sel { background: var(--nry); color: #fff; }
  .cmi .cname { font-weight: 600; flex: none; white-space: nowrap; } .cmi .cdesc { opacity: .55; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; flex: 1; min-width: 0; }
  .cmi:hover .cdesc, .cmi.sel .cdesc { opacity: .85; }
  .cmi .csrc { font-size: 9px; text-transform: uppercase; opacity: .5; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; flex: none; }
  .cmi.loading { opacity: .6; font-style: italic; cursor: default; }
  /* consolidated Mode + Effort (Claude-style) */
  .modetrig { display: inline-flex; align-items: center; gap: 5px; background: var(--vscode-dropdown-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
  .modetrig:hover { border-color: var(--nry); }
  .modetrig .lico { display: inline-flex; opacity: .85; } .modetrig .mcaret { opacity: .6; }
  .modemenu { width: 340px; padding: 8px; }
  .mm-head { font-size: 11px; opacity: .55; padding: 4px 8px 6px; text-transform: uppercase; letter-spacing: .04em; }
  .mm-row { display: flex; gap: 10px; align-items: flex-start; padding: 8px 10px; border-radius: 8px; cursor: pointer; }
  .mm-row:hover { background: var(--vscode-list-hoverBackground); }
  .mm-row.active { background: var(--nry-soft); }
  .mm-row .micon { flex: none; opacity: .7; margin-top: 1px; }
  .mm-row.active .micon { opacity: 1; color: var(--nry); }
  .mm-row .mtext { flex: 1; min-width: 0; } .mm-row .mtext b { display: block; font-size: 13px; font-weight: 600; } .mm-row .mtext p { margin: 2px 0 0; font-size: 11.5px; opacity: .55; line-height: 1.35; }
  .mm-row.active .mtext b { color: var(--nry); }
  .mm-row .mcheck { margin-left: auto; flex: none; opacity: 0; align-self: center; color: var(--nry); } .mm-row.active .mcheck { opacity: 1; }
  .mm-effort { display: flex; align-items: center; gap: 8px; padding: 9px 10px 5px; border-top: 1px solid var(--vscode-panel-border); font-size: 12px; }
  .mm-effort:nth-of-type(odd) { border-top: 1px solid var(--vscode-panel-border); }
  .mm-effort .lvl { opacity: .55; font-size: 11px; }
  .dotslider { position: relative; width: 96px; height: 16px; margin-left: auto; cursor: pointer; flex: none; touch-action: none; }
  .ds-track { position: absolute; top: 50%; left: 2px; right: 2px; height: 4px; transform: translateY(-50%); border-radius: 3px; background: var(--vscode-panel-border); }
  .ds-fill { height: 100%; border-radius: 3px; background: var(--nry); width: 0; transition: width .08s; }
  .ds-dot { position: absolute; top: 50%; width: 4px; height: 4px; border-radius: 50%; background: var(--vscode-descriptionForeground, #888); transform: translate(-50%, -50%); }
  .ds-dot.on { background: var(--nry); }
  .ds-knob { position: absolute; top: 50%; left: 0; width: 13px; height: 13px; border-radius: 50%; background: #fff; border: 2px solid var(--nry); transform: translate(-50%, -50%); box-shadow: 0 1px 3px rgba(0,0,0,.4); transition: left .08s; }
  .mm-toggle { display: flex; align-items: center; gap: 8px; padding: 9px 10px; font-size: 12px; cursor: pointer; }
  .mm-toggle .grow2 { flex: 1; }
  .mm-toggle .sw { width: 30px; height: 16px; border-radius: 9px; background: var(--vscode-panel-border); position: relative; transition: background .12s; flex: none; }
  .mm-toggle .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left .12s; }
  .mm-toggle.on .sw { background: var(--nry); } .mm-toggle.on .sw::after { left: 16px; }
  select { background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 5px; padding: 2px 5px; font-size: 11px; }
  select:hover, select:focus { border-color: var(--nry); }
  #model { max-width: 170px; }
  /* + attach button */
  .iconbtn { background: transparent; color: var(--vscode-foreground); border: 1px solid transparent; border-radius: 7px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: .7; flex: none; }
  .iconbtn:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .iconbtn.on { opacity: 1; color: var(--nry); background: var(--nry-soft); }
  #send { background: linear-gradient(135deg, #4f8ef7, #2f6fed); color: #fff; border: none; border-radius: 10px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; cursor: pointer; flex: none; box-shadow: 0 2px 8px rgba(59,130,246,.4); transition: filter .12s, transform .08s, box-shadow .12s; }
  #send:hover { filter: brightness(1.08); box-shadow: 0 3px 13px rgba(59,130,246,.55); } #send:active { transform: scale(.9); }
  #send.stopping { background: linear-gradient(135deg, #f0616a, #e5484d); box-shadow: 0 2px 8px rgba(229,72,77,.45); }
  /* + popup menu */
  .popmenu { position: absolute; left: 14px; bottom: 70px; min-width: 210px; background: var(--vscode-menu-background, var(--vscode-editorWidget-background)); border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border)); border-radius: 10px; padding: 5px; display: none; z-index: 6; box-shadow: 0 6px 22px rgba(0,0,0,.4); }
  .popmenu.open { display: block; }
  .pmi { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 7px; cursor: pointer; font-size: 13px; }
  .pmi:hover { background: var(--nry); color: #fff; }
  .pmi.on { background: var(--nry-soft); color: var(--nry); }
  .pmi svg { flex: none; opacity: .85; }
  .pmi .pmcheck { margin-left: auto; opacity: 0; color: var(--nry); display: inline-flex; }
  .pmi.on .pmcheck { opacity: 1; }
  .pmi.on:hover .pmcheck { color: #fff; }
  #mention { position: absolute; left: 50%; transform: translateX(-50%); width: min(680px, calc(100% - 28px)); bottom: 78px; max-height: 220px; overflow-y: auto; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border: 1px solid var(--vscode-panel-border); border-radius: 8px; display: none; z-index: 5; box-shadow: 0 4px 16px rgba(0,0,0,.3); }
  .mi { padding: 6px 10px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .mi.sel, .mi:hover { background: var(--nry); color: #fff; }
  /* inline ask_user question card (Claude-style) */
  .qcard { border: 1px solid var(--nry); border-radius: 10px; padding: 11px 13px; margin: 10px 0; background: var(--nry-soft); max-width: 560px; }
  .qtitle { font-weight: 600; margin-bottom: 8px; line-height: 1.4; font-size: 13px; }
  .qopts { display: flex; flex-direction: column; gap: 5px; }
  .qbtn { text-align: left; background: var(--vscode-input-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 7px; padding: 7px 10px; cursor: pointer; font-size: 12.5px; line-height: 1.35; font-family: inherit; transition: background .1s, border-color .1s; }
  .qbtn:hover, .qbtn:focus { border-color: var(--nry); background: var(--vscode-list-hoverBackground); outline: none; }
  .qbtn.chosen { background: var(--nry); color: #fff; border-color: var(--nry); }
  .qbtn.agentrow { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
  .qbtn.agentrow .amodel { opacity: .55; font-size: 11.5px; flex: none; }
  .qbtn.modelrow { display: flex; align-items: center; gap: 8px; }
  .qcard.done { padding: 7px 12px; background: transparent; border-color: var(--vscode-panel-border); }
  .qdone { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; line-height: 1.4; }
  .qdone .qcheck { color: var(--nry); flex: none; font-weight: 700; }
  .qdone .qq { opacity: .55; }
  .qdone .qa { color: var(--nry); font-weight: 600; margin-left: auto; flex: none; }
  .qrow { display: flex; gap: 8px; margin-top: 4px; }
  .qrow input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 11px; outline: none; font-family: inherit; font-size: 13px; }
  .qrow input:focus { border-color: var(--nry); }
  .qrow button { background: var(--nry); color: #fff; border: none; border-radius: 8px; padding: 0 14px; cursor: pointer; }
  .qbtn:disabled { cursor: default; } .qbtn.chosen { opacity: 1; }
  /* ask_user tabbed modal */
  .askmodal { width: min(540px, calc(100% - 40px)); }
  .askmodal .modal-head { align-items: flex-end; }
  .ask-tabs { display: flex; gap: 3px; flex: 1; flex-wrap: wrap; }
  .ask-tab { background: transparent; border: none; border-bottom: 2px solid transparent; color: var(--vscode-foreground); opacity: .55; padding: 4px 9px; cursor: pointer; font-size: 12px; }
  .ask-tab:hover { opacity: .9; }
  .ask-tab.active { opacity: 1; border-bottom-color: var(--nry); color: var(--nry); }
  .ask-tab .tk { color: var(--nry); margin-right: 3px; }
  .ask-q { font-weight: 600; font-size: 13.5px; margin: 14px 0 10px; line-height: 1.4; }
  .ask-body .qopts { display: flex; flex-direction: column; gap: 6px; }
  .ask-body .qrow { display: flex; gap: 8px; }
  .ask-input { flex: 1; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 8px 11px; outline: none; font-family: inherit; font-size: 13px; }
  .ask-input:focus { border-color: var(--nry); }
  .ask-send { background: var(--nry); color: #fff; border: none; border-radius: 8px; padding: 0 14px; cursor: pointer; }
  .ask-hint { font-weight: 400; opacity: .5; font-size: 11px; }
  .askopt { display: flex; align-items: center; gap: 11px; width: 100%; text-align: left; background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 9px 11px; cursor: pointer; color: var(--vscode-foreground); font-size: 13px; font-family: inherit; }
  .askopt:hover { background: var(--vscode-list-hoverBackground); }
  .askopt.sel { background: var(--nry-soft); }
  .askopt .ind { flex: none; width: 16px; height: 16px; border: 1.5px solid var(--vscode-descriptionForeground, #888); display: inline-flex; align-items: center; justify-content: center; }
  .askopt .ind.rd { border-radius: 50%; } .askopt .ind.ck { border-radius: 4px; }
  .askopt.sel .ind { border-color: var(--nry); }
  .askopt.sel .ind.rd::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--nry); }
  .askopt.sel .ind.ck { background: var(--nry); } .askopt.sel .ind.ck::after { content: "✓"; color: #fff; font-size: 11px; line-height: 1; }
  .ask-foot { margin-top: 12px; display: flex; justify-content: flex-end; }
  .ask-submit { background: var(--nry); color: #fff; border: none; border-radius: 8px; padding: 8px 16px; font-size: 12.5px; cursor: pointer; }
  .ask-submit:hover { background: var(--nry-hover); } .ask-submit:disabled { opacity: .4; cursor: default; }
  /* /usage account card */
  .qcard.usage { border-color: var(--vscode-panel-border); background: var(--vscode-input-background); max-width: 420px; }
  .qcard.usage .udesc { opacity: .6; }
  .urow { display: flex; justify-content: space-between; gap: 12px; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12.5px; }
  .urow:last-child { border: 0; } .urow .uk { opacity: .65; } .urow .uv { font-weight: 600; text-align: right; }
  /* centered modal (account/usage) */
  .modal-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.5); display: flex; align-items: center; justify-content: center; z-index: 50; }
  .modal { width: min(520px, calc(100% - 40px)); max-height: 82vh; overflow-y: auto; background: var(--vscode-editorWidget-background, var(--vscode-input-background)); border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 18px 20px; box-shadow: 0 14px 44px rgba(0,0,0,.5); }
  .modal-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .modal-head h3 { margin: 0; font-size: 15px; }
  .modal-close { background: transparent; border: none; color: var(--vscode-foreground); opacity: .6; cursor: pointer; font-size: 16px; line-height: 1; padding: 3px 7px; border-radius: 6px; }
  .modal-close:hover { opacity: 1; background: var(--vscode-list-hoverBackground); }
  .modal-sec { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; opacity: .55; margin: 16px 0 6px; }
  .modal .udesc { opacity: .6; font-style: italic; padding: 6px 0; }
  .bar { height: 8px; border-radius: 6px; background: var(--vscode-panel-border); overflow: hidden; margin: 7px 0 4px; }
  .bar-fill { height: 100%; background: var(--nry); border-radius: 6px; transition: width .3s; }
  .bar-fill.warn { background: var(--vscode-charts-yellow, #d7ba7d); } .bar-fill.crit { background: var(--vscode-errorForeground); }
  .bar-label { display: flex; justify-content: space-between; font-size: 11px; opacity: .75; }
  .picklist { display: flex; flex-direction: column; gap: 5px; }
  .pickrow { display: flex; align-items: center; gap: 9px; justify-content: space-between; text-align: left; background: var(--vscode-input-background); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 7px; padding: 8px 11px; cursor: pointer; font-size: 12.5px; font-family: inherit; }
  .pickrow:hover { border-color: var(--nry); background: var(--vscode-list-hoverBackground); }
  .pickrow .amodel { opacity: .55; font-size: 11.5px; flex: none; }
  .pickrow.modelrow { justify-content: flex-start; }
  .pickrow.saved { border-color: var(--nry); } .pickrow.saved .amodel { color: var(--nry); opacity: 1; }
  .mcprow { display: flex; align-items: center; gap: 10px; padding: 8px 11px; border: 1px solid var(--vscode-panel-border); border-radius: 7px; }
  .mcprow .mtext { flex: 1; min-width: 0; } .mcprow .mtext b { font-size: 12.5px; } .mcprow .mtext p { margin: 2px 0 0; font-size: 11px; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mcpx { flex: none; background: transparent; border: none; color: var(--vscode-foreground); opacity: .5; cursor: pointer; font-size: 13px; }
  .mcpx:hover { opacity: 1; color: var(--vscode-errorForeground); }
  .pickrow.mcpadd { margin-top: 6px; justify-content: center; color: var(--nry); }
  /* custom model dropdown with provider icons */
  .msel { display: inline-flex; align-items: center; gap: 6px; max-width: 190px; background: var(--vscode-dropdown-background); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); border-radius: 5px; padding: 2px 6px 2px 5px; font-size: 11px; cursor: pointer; }
  .msel:hover { border-color: var(--nry); }
  .msel .mname { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .msel .mcaret { opacity: .6; flex: none; }
  .mico { width: 16px; height: 16px; flex: none; border-radius: 4px; display: inline-flex; }
  img.logo { width: 16px; height: 16px; flex: none; object-fit: contain; background: #fff; border-radius: 4px; padding: 1px; }
  .modelmenu { left: auto; right: 14px; min-width: 240px; max-height: 340px; overflow-y: auto; }
  .mmi { display: flex; align-items: center; gap: 9px; padding: 7px 10px; border-radius: 7px; cursor: pointer; font-size: 12.5px; white-space: nowrap; }
  .mmi:hover { background: var(--nry); color: #fff; }
  .mmi.sel { background: var(--nry-soft); }
  .mmi .mname { overflow: hidden; text-overflow: ellipsis; }
  .mmi .dtag { margin-left: auto; font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; opacity: .7; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; flex: none; }
</style></head><body>
  <div class="top"><img src="${logo}"><strong>ByNara</strong><button id="new">+ New chat</button></div>
  <div id="log"></div>
  <div class="barwrap">
    <div id="mention"></div>
    <div id="plusmenu" class="popmenu plusmenu">
      <div class="pmi" data-act="upload">${ICONS.upload}<span>Upload from computer</span></div>
      <div class="pmi" data-act="context">${ICONS.ctx}<span>Add context</span></div>
      <div class="pmi" id="webitem" data-act="web">${ICONS.globe}<span>Browse the web</span><span class="pmcheck">${ICONS.check}</span></div>
    </div>
    <div id="modelmenu" class="popmenu modelmenu"></div>
    <div id="cmdmenu" class="popmenu cmdmenu"><div id="cmdlist"></div></div>
    <div id="modemenu" class="popmenu modemenu">
      <div class="mm-head"><span>Mode</span></div>
      <div class="mm-modes">
        <div class="mm-row" data-mode="ask"><span class="micon">${ICONS.hand}</span><div class="mtext"><b>Ask</b><p>Asks for approval before each edit</p></div><span class="mcheck">${ICONS.check}</span></div>
        <div class="mm-row" data-mode="auto"><span class="micon">${ICONS.zap}</span><div class="mtext"><b>Auto</b><p>Automatically picks the best mode per task</p></div><span class="mcheck">${ICONS.check}</span></div>
        <div class="mm-row" data-mode="plan"><span class="micon">${ICONS.plan}</span><div class="mtext"><b>Plan</b><p>Explores and presents a plan before editing</p></div><span class="mcheck">${ICONS.check}</span></div>
      </div>
      <div class="mm-effort"><span class="lico bico on">${ICONS.brain}</span><span>Effort</span><span class="lvl" id="effortval">(Medium)</span><div class="dotslider" id="effortslider"></div></div>
      <div class="mm-effort"><span class="lico">${ICONS.caveman}</span><span>Caveman</span><span class="lvl" id="cavemanval">(Off)</span><div class="dotslider" id="cavemanslider"></div></div>
      <div class="mm-toggle" id="sptoggle"><span class="lico">${ICONS.zap}</span><span class="grow2">Superpowers</span><span class="sw"></span></div>
    </div>
    <div class="composer">
      <div id="chips" class="chips"></div>
      <textarea id="in" rows="1" placeholder="Message ByNara…  (@ mention a file · paste an image)"></textarea>
      <div class="cfoot">
        <button class="iconbtn" id="plus" title="Add">${ICONS.plus}</button>
        <button class="iconbtn" id="slashbtn" title="Commands & actions">${ICONS.slash}</button>
        <button class="modetrig" id="modetrig" title="Mode"><span class="lico" id="modeico">${ICONS.zap}</span><span id="modename">Auto</span><span class="mcaret">▾</span></button>
        <select id="mode" style="display:none"><option value="ask">Ask</option><option value="auto" selected>Auto</option><option value="plan">Plan</option></select>
        <select id="effort" style="display:none"><option value="low">Low</option><option value="medium" selected>Medium</option><option value="high">High</option></select>
        <span class="grow"></span>
        <div class="msel" id="modeltrig" title="Model"><span class="mico" id="modeltrigico"></span><span class="mname">…</span><span class="mcaret">▾</span></div>
        <select id="model" style="display:none"></select>
        <button id="send" title="Send">${ICONS.send}</button>
      </div>
    </div>
  </div>
<script nonce="${n}">window.__bynara = { logo: ${JSON.stringify(String(logo))}, icon: ${JSON.stringify(String(icon))}, logos: ${JSON.stringify(String(logos))} };</script>
<script nonce="${n}" src="${chatJs}"></script>
</body></html>`;
}

function sidebarHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"));
  const icon = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "icon.png"));
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
  .login { display: none; flex-direction: column; align-items: center; text-align: center; padding: 64px 24px 24px; gap: 4px; }
  .login.show { display: flex; }
  .login-logo { width: 66px; height: 66px; border-radius: 14px; margin-bottom: 12px; }
  .login-title { font-size: 18px; font-weight: 600; }
  .login-sub { opacity: .55; font-size: 12.5px; margin-bottom: 22px; }
  .signin { width: auto; padding: 10px 20px; background: #3b82f6; color: #fff; border-radius: 8px; font-size: 13px; font-weight: 500; }
  .signin:hover { background: #2f74e6; }
  .acctbtns { display: flex; gap: 8px; margin-top: 14px; }
  .abtn { flex: 1; width: auto; display: inline-flex; align-items: center; justify-content: center; gap: 6px; border: none; border-radius: 7px; padding: 8px 10px; font-size: 12px; cursor: pointer; }
  .abtn.refresh { background: #3b82f6; color: #fff; } .abtn.refresh:hover { background: #2f74e6; }
  .abtn.logout { background: transparent; color: var(--vscode-errorForeground, #e5484d); border: 1px solid var(--vscode-errorForeground, #e5484d); }
  .abtn.logout:hover { background: var(--vscode-errorForeground, #e5484d); color: #fff; }
  .tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 4px; cursor: pointer; opacity: .6; border-bottom: 2px solid transparent; font-size: 12px; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .view { display: none; padding: 8px 8px; } .view.active { display: block; }
  input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 6px 8px; border-radius: 5px; outline: none; margin-bottom: 6px; }
  .muted { opacity: .6; padding: 6px 0; }
  .srctoggle { display: flex; gap: 4px; margin-bottom: 8px; }
  .srctoggle button { flex: 1; width: auto; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 4px 0; opacity: .6; }
  .srctoggle button.on { opacity: 1; background: var(--vscode-button-secondaryBackground); border-color: var(--vscode-focusBorder); }
  .showall { display: flex; align-items: center; gap: 6px; font-size: 11.5px; opacity: .75; margin-bottom: 8px; cursor: pointer; user-select: none; }
  .showall input { width: auto; margin: 0; cursor: pointer; }
  .sess { display: flex; gap: 7px; padding: 4px 6px; border-radius: 5px; cursor: pointer; border: 1px solid transparent; align-items: center; }
  .sess:hover { background: var(--vscode-list-hoverBackground); }
  .sess .ic { opacity: .45; flex: none; } .sess .t { font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.25; } .sess .m { font-size: 10.5px; opacity: .5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.2; }
  .sess .del { flex: none; width: auto; background: transparent; border: none; padding: 3px; opacity: 0; color: var(--vscode-foreground); cursor: pointer; }
  .sess:hover .del { opacity: .55; } .sess .del:hover { opacity: 1; color: var(--vscode-errorForeground); }
  h3 { margin: 4px 0 6px; font-size: 11px; text-transform: uppercase; opacity: .65; }
  .row { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); } .row:last-child { border: 0; } .row .k { opacity: .7; } .row .v { font-weight: 600; text-align: right; }
</style></head><body>
  <div id="login" class="login show">
    <img class="login-logo" src="${icon}">
    <div class="login-title">ByNara AI</div>
    <div class="login-sub">One sign-in, every model.</div>
    <button id="signinBtn" class="signin">Sign in with ByNara</button>
  </div>
  <div id="app" style="display:none">
  <div class="brand"><img src="${logo}"><strong>ByNara AI</strong></div>
  <div class="newbtn"><button id="new">${ICONS.plus} New chat</button></div>
  <div class="tabs">
    <div class="tab active" data-v="sessions">${ICONS.sessions} Sessions</div>
    <div class="tab" data-v="account">${ICONS.account} Account</div>
  </div>
  <div class="view active" id="v-sessions">
    <div class="srctoggle"><button data-s="editor" class="on">Editor</button><button data-s="cli">CLI</button></div>
    <label class="showall"><input type="checkbox" id="showAll"> Show all sessions (across folders)</label>
    <input id="search" placeholder="Search sessions…">
    <div id="sessions"><div class="muted">Loading…</div></div>
  </div>
  <div class="view" id="v-account">
    <div id="account"><div class="muted">Loading…</div></div>
    <div class="acctbtns">
      <button class="abtn refresh" id="refreshAcc">${ICONS.refresh}<span>Refresh</span></button>
      <button class="abtn logout" id="logoutBtn">${ICONS.logout}<span>Log out</span></button>
    </div>
  </div>
  </div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const IC = ${JSON.stringify(ICONS)};
  let sessions = [], src = 'editor';
  // Persist the "show all folders" preference in webview state so it survives reloads.
  let showAll = !!(vscode.getState && vscode.getState() || {}).showAll;
  const refreshSess = () => vscode.postMessage({ type: 'refreshSessions', source: src, showAll });
  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x===t));
    document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id==='v-'+t.dataset.v));
    if (t.dataset.v === 'sessions') refreshSess();
    if (t.dataset.v === 'account') vscode.postMessage({ type: 'refreshAccount' });
  });
  document.querySelectorAll('.srctoggle button').forEach(b => b.onclick = () => {
    src = b.dataset.s;
    document.querySelectorAll('.srctoggle button').forEach(x => x.classList.toggle('on', x===b));
    refreshSess();
  });
  const showAllEl = document.getElementById('showAll');
  showAllEl.checked = showAll;
  showAllEl.onchange = () => {
    showAll = showAllEl.checked;
    try { vscode.setState({ ...(vscode.getState() || {}), showAll }); } catch (e) {}
    refreshSess();
  };
  document.getElementById('new').onclick = () => vscode.postMessage({ type: 'newChat' });
  function renderSessions() {
    const q = (document.getElementById('search').value||'').toLowerCase();
    const box = document.getElementById('sessions'); box.innerHTML = '';
    const items = sessions.filter(s => !q || (s.title+' '+s.project).toLowerCase().includes(q));
    if (!items.length) { box.innerHTML = '<div class="muted">No sessions.</div>'; return; }
    for (const s of items) {
      const d = document.createElement('div'); d.className='sess';
      const proj = s.project ? s.project.split(/[\\\\/]/).pop() : '';
      d.innerHTML = '<span class="ic">'+IC.sess+'</span><div style="min-width:0;flex:1"><div class="t"></div><div class="m"></div></div><button class="del" title="Delete permanently">'+IC.trash+'</button>';
      d.querySelector('.t').textContent = s.title;
      d.querySelector('.m').textContent = proj + ' · ' + new Date(s.mtime).toLocaleString();
      d.onclick = () => vscode.postMessage({ type: 'openSession', file: s.file });
      d.querySelector('.del').onclick = (ev) => { ev.stopPropagation(); vscode.postMessage({ type: 'deleteSession', file: s.file, source: src, showAll }); };
      box.appendChild(d);
    }
  }
  document.getElementById('search').addEventListener('input', renderSessions);
  function num(n){ return (n||0).toLocaleString(); }
  function renderAccount(r) {
    const box = document.getElementById('account');
    if (!r || !r.ok) {
      if (r && r.error === 'not-signed-in') { box.innerHTML='<div class="muted">Not signed in.</div>'; const b=document.createElement('button'); b.textContent='Sign in with ByNara'; b.onclick=()=>vscode.postMessage({type:'signIn'}); box.appendChild(b); return; }
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
  document.getElementById('logoutBtn').onclick = () => vscode.postMessage({ type: 'signOut' });
  const loginEl = document.getElementById('login'), appEl = document.getElementById('app');
  document.getElementById('signinBtn').onclick = () => vscode.postMessage({ type: 'signIn' });
  function applyAuth(signedIn) {
    loginEl.classList.toggle('show', !signedIn);
    appEl.style.display = signedIn ? 'block' : 'none';
    if (signedIn) { refreshSess(); vscode.postMessage({ type: 'refreshAccount' }); }
  }
  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'sessions') { sessions = m.list||[]; renderSessions(); }
    else if (m.type === 'account') renderAccount(m.result);
    else if (m.type === 'auth') applyAuth(!!m.signedIn);
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}
