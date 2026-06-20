import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import { createPiEnvironment, createPiRpcArgs, ensurePiBinary } from "./pi.ts";

// Naraya side panel — a Claude-style webview with three sections:
//   Account  (9a) — live account/credit/quota/usage from the gateway /v1/me
//   Sessions (9b) — past Naraya sessions for this machine (resume / new)
//   Chat     (9c) — in-panel chat that streams via the naraya RPC engine
//
// The engine is the `naraya` CLI; this panel only renders + drives it. Account
// data needs a key in ~/.naraya/agent/models.json (from `naraya login` or the
// extension sign-in).

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

// Scan ~/.naraya/agent/sessions/<encoded-cwd>/*.jsonl. Each file is one session;
// the title is taken from its first user message, the project from the first
// record's cwd. Newest first, capped so a huge history stays snappy.
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
        /* skip unreadable */
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

// Pull a human title + project from a session JSONL without reading it whole:
// scan the first handful of lines for cwd and the first user text.
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

export function createNarayaPanelProvider(
  extensionUri: vscode.Uri,
  getBridgeConfig: () => { url: string; token: string } | undefined,
  openTerminal: (extraArgs?: string[]) => Promise<vscode.Terminal | undefined>,
): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
      view.webview.html = html(view.webview, extensionUri);

      let chatChild: ReturnType<typeof spawn> | undefined;

      const post = (msg: any) => {
        void view.webview.postMessage(msg);
      };

      const runChat = async (text: string) => {
        const naraya = await ensurePiBinary();
        if (!naraya) {
          post({ type: "chatError", error: "Naraya CLI not found." });
          return;
        }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        const child = spawn(naraya, createPiRpcArgs(extensionUri), {
          cwd,
          env: { ...process.env, ...createPiEnvironment(getBridgeConfig()) },
          stdio: ["pipe", "pipe", "pipe"],
        });
        chatChild = child;
        const decoder = new StringDecoder("utf8");
        let buf = "";
        const send = (o: object) => child.stdin.write(`${JSON.stringify(o)}\n`);

        child.stdout.on("data", (chunk) => {
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
            if (ev.type === "extension_ui_request") {
              // Reuse native modals for gate prompts inside the panel chat.
              const id = ev.id;
              const method = ev.method;
              if (!id) continue;
              void (async () => {
                try {
                  if (method === "confirm") {
                    const pick = await vscode.window.showWarningMessage(String(ev.message ?? ev.title ?? "Allow?"), { modal: true }, "Allow");
                    send({ type: "extension_ui_response", id, confirmed: pick === "Allow" });
                  } else if (method === "select") {
                    const opts = Array.isArray(ev.options) ? ev.options.map(String) : [];
                    const choice = await vscode.window.showQuickPick(opts, { title: String(ev.title ?? "Select") });
                    send(choice === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value: choice });
                  } else if (method === "input") {
                    const v = await vscode.window.showInputBox({ title: String(ev.title ?? "Input") });
                    send(v === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value: v });
                  } else if (method !== "notify") {
                    send({ type: "extension_ui_response", id, cancelled: true });
                  }
                } catch {
                  send({ type: "extension_ui_response", id, cancelled: true });
                }
              })();
              continue;
            }
            if (ev.type === "message_update") {
              const a = ev.assistantMessageEvent;
              if (a?.type === "text_delta" && typeof a.delta === "string") post({ type: "chatDelta", delta: a.delta });
              continue;
            }
            if (ev.type === "message_update" || ev.type === "message_end") continue;
            if (ev.type === "agent_end") {
              child.stdin.end();
            }
          }
        });
        child.on("close", () => {
          if (chatChild === child) chatChild = undefined;
          post({ type: "chatDone" });
        });
        child.on("error", (e) => post({ type: "chatError", error: String(e?.message ?? e) }));
        send({ id: "p1", type: "prompt", message: text });
      };

      view.webview.onDidReceiveMessage(async (msg: any) => {
        switch (msg?.type) {
          case "ready":
          case "refreshAccount":
            post({ type: "account", result: await fetchAccount() });
            break;
          case "refreshSessions":
            post({ type: "sessions", list: listSessions() });
            break;
          case "newSession":
            void openTerminal();
            break;
          case "openSession": {
            // Resume a session in a terminal (pi reads the JSONL via --resume).
            if (typeof msg.file === "string") void openTerminal(["--resume", msg.file]);
            break;
          }
          case "signIn":
            void vscode.commands.executeCommand("naraya.signIn");
            break;
          case "chat":
            if (typeof msg.text === "string" && msg.text.trim()) await runChat(msg.text.trim());
            break;
          case "stopChat":
            try {
              chatChild?.kill();
            } catch {
              /* ignore */
            }
            break;
        }
      });

      view.onDidDispose(() => {
        try {
          chatChild?.kill();
        } catch {
          /* ignore */
        }
      });
    },
  };
}

function nonce(): string {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const n = nonce();
  const logo = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "logo.svg"));
  const csp = `default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${n}';`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; padding: 0; }
  .tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-sideBar-background); }
  .tab { flex: 1; padding: 8px 4px; text-align: center; cursor: pointer; opacity: .6; user-select: none; border-bottom: 2px solid transparent; }
  .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); }
  .view { display: none; padding: 10px; }
  .view.active { display: block; }
  h3 { margin: 6px 0; font-size: 11px; text-transform: uppercase; opacity: .7; letter-spacing: .04em; }
  .row { display: flex; justify-content: space-between; gap: 8px; padding: 3px 0; }
  .row .k { opacity: .7; } .row .v { font-weight: 600; text-align: right; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 10px; border-radius: 4px; cursor: pointer; }
  button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  input { width: 100%; box-sizing: border-box; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, transparent); padding: 6px; border-radius: 4px; }
  .muted { opacity: .6; } .sp { margin: 8px 0; }
  .sess { padding: 7px 6px; border-radius: 4px; cursor: pointer; border: 1px solid transparent; }
  .sess:hover { background: var(--vscode-list-hoverBackground); }
  .sess .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sess .m { font-size: 11px; opacity: .6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #log { white-space: pre-wrap; word-break: break-word; line-height: 1.45; }
  .msg { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .msg.user { opacity: .85; } .msg .who { font-size: 11px; opacity: .6; margin-bottom: 2px; }
  .chatbar { display: flex; gap: 6px; margin-top: 8px; position: sticky; bottom: 0; background: var(--vscode-sideBar-background); padding-top: 6px; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 10px; }
  .brand img { width: 20px; height: 20px; }
</style>
</head>
<body>
  <div class="brand"><img src="${logo}" alt=""><strong>Naraya AI</strong></div>
  <div class="tabs">
    <div class="tab active" data-v="chat">Chat</div>
    <div class="tab" data-v="sessions">Sessions</div>
    <div class="tab" data-v="account">Account</div>
  </div>

  <div class="view active" id="v-chat">
    <div id="log"></div>
    <div class="chatbar">
      <input id="chatInput" placeholder="Message Naraya… (Enter to send)">
      <button id="send">Send</button>
    </div>
  </div>

  <div class="view" id="v-sessions">
    <button id="newSession">+ New session</button>
    <div class="sp"><input id="search" placeholder="Search sessions…"></div>
    <div id="sessions"><div class="muted">Loading…</div></div>
  </div>

  <div class="view" id="v-account">
    <div id="account"><div class="muted">Loading…</div></div>
    <div class="sp"><button class="sec" id="refreshAcc">Refresh</button></div>
  </div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  let sessions = [];

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('v-' + t.dataset.v).classList.add('active');
    if (t.dataset.v === 'sessions') vscode.postMessage({ type: 'refreshSessions' });
    if (t.dataset.v === 'account') vscode.postMessage({ type: 'refreshAccount' });
  });

  // Chat
  const log = document.getElementById('log');
  const input = document.getElementById('chatInput');
  let streaming = false, assistantEl = null;
  function addMsg(who, cls) { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = '<div class="who">' + who + '</div><div class="body"></div>'; log.appendChild(d); log.scrollTop = log.scrollHeight; return d.querySelector('.body'); }
  function send() {
    const text = input.value.trim(); if (!text || streaming) return;
    addMsg('You', 'user').textContent = text;
    input.value = ''; streaming = true; assistantEl = addMsg('Naraya', 'assistant');
    vscode.postMessage({ type: 'chat', text });
  }
  document.getElementById('send').onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // Sessions
  function renderSessions() {
    const q = (document.getElementById('search').value || '').toLowerCase();
    const box = document.getElementById('sessions'); box.innerHTML = '';
    const items = sessions.filter(s => !q || (s.title + ' ' + s.project).toLowerCase().includes(q));
    if (!items.length) { box.innerHTML = '<div class="muted">No sessions.</div>'; return; }
    for (const s of items) {
      const d = document.createElement('div'); d.className = 'sess';
      const proj = s.project ? s.project.split(/[\\\\/]/).pop() : '';
      d.innerHTML = '<div class="t"></div><div class="m"></div>';
      d.querySelector('.t').textContent = s.title;
      d.querySelector('.m').textContent = proj + ' · ' + new Date(s.mtime).toLocaleString();
      d.onclick = () => vscode.postMessage({ type: 'openSession', file: s.file });
      box.appendChild(d);
    }
  }
  document.getElementById('search').addEventListener('input', renderSessions);
  document.getElementById('newSession').onclick = () => vscode.postMessage({ type: 'newSession' });

  // Account
  function num(n){ return (n||0).toLocaleString(); }
  function renderAccount(r) {
    const box = document.getElementById('account');
    if (!r || !r.ok) {
      if (r && r.error === 'not-signed-in') { box.innerHTML = '<div class="muted">Not signed in.</div>'; const b = document.createElement('button'); b.textContent = 'Sign in with Naraya'; b.onclick = () => vscode.postMessage({ type: 'signIn' }); box.appendChild(b); return; }
      box.innerHTML = '<div class="muted">Usage unavailable' + (r && r.error ? ' (' + r.error + ')' : '') + '.</div>'; return;
    }
    const s = r.data || {}; const a = s.account || {}, c = s.credit || {}, q = s.quota || {}, u = s.usage || {};
    const rows = [
      ['Email', a.email || '—'], ['Plan', a.plan || '—'],
      ['Credit', 'Rp ' + num(c.available) + (c.usd_equivalent ? ' / $' + c.usd_equivalent : '')],
      ['Quota', q.limit > 0 ? num(q.remaining) + ' / ' + num(q.limit) + ' ' + (q.unit || 'tokens') : 'fair-use'],
      ['Tokens today', num(u.tokens_today)], ['Tokens month', num(u.tokens_month)],
      ['Requests today', num(u.requests_today)], ['Success rate', typeof u.success_rate === 'number' ? Math.round(u.success_rate*100)+'%' : '—'],
      ['Models', Array.isArray(s.models) ? s.models.length : 0],
    ];
    box.innerHTML = '<h3>Account</h3>' + rows.map(([k,v]) => '<div class="row"><span class="k">'+k+'</span><span class="v">'+String(v).replace(/</g,'&lt;')+'</span></div>').join('');
  }
  document.getElementById('refreshAcc').onclick = () => vscode.postMessage({ type: 'refreshAccount' });

  window.addEventListener('message', e => {
    const m = e.data;
    if (m.type === 'account') renderAccount(m.result);
    else if (m.type === 'sessions') { sessions = m.list || []; renderSessions(); }
    else if (m.type === 'chatDelta') { if (assistantEl) { assistantEl.textContent += m.delta; log.scrollTop = log.scrollHeight; } }
    else if (m.type === 'chatDone') { streaming = false; }
    else if (m.type === 'chatError') { if (assistantEl) assistantEl.textContent += '\\n[error: ' + m.error + ']'; streaming = false; }
  });

  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
