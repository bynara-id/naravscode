import type { ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import * as vscode from "vscode";
import { createPiEnvironment, createPiRpcArgs, ensurePiBinary, spawnNaraya } from "./pi.ts";

// Naraya side panel — a Claude-style webview with three sections:
//   Chat     (9c) — multi-turn in-panel chat streamed via the naraya RPC engine
//   Sessions (9b) — past Naraya sessions (resume / new), with search
//   Account  (9a) — live account/credit/quota/usage from the gateway /v1/me
//
// The engine is the `naraya` CLI; this panel only renders + drives it.

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
        /* skip unreadable */
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

export function createNarayaPanelProvider(
  extensionUri: vscode.Uri,
  getBridgeConfig: () => { url: string; token: string } | undefined,
  openTerminal: (extraArgs?: string[]) => Promise<vscode.Terminal | undefined>,
): vscode.WebviewViewProvider {
  return {
    resolveWebviewView(view) {
      view.webview.options = { enableScripts: true, localResourceRoots: [extensionUri] };
      view.webview.html = html(view.webview, extensionUri);

      // One long-lived RPC child per panel so chat is MULTI-TURN: the in-memory
      // session in that process remembers the conversation across messages.
      let child: ChildProcess | undefined;
      let wired = false;

      const post = (msg: any) => void view.webview.postMessage(msg);
      const send = (o: object) => child?.stdin?.write(`${JSON.stringify(o)}\n`);

      const ensureChild = async (): Promise<boolean> => {
        if (child) return true;
        const naraya = await ensurePiBinary();
        if (!naraya) {
          post({ type: "chatError", error: "Naraya CLI not found on PATH." });
          return false;
        }
        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        child = spawnNaraya(naraya, createPiRpcArgs(extensionUri), {
          cwd,
          env: { ...process.env, ...createPiEnvironment(getBridgeConfig()) },
          stdio: ["pipe", "pipe", "pipe"],
        });
        wired = false;
        const decoder = new StringDecoder("utf8");
        let buf = "";
        child.stdout?.on("data", (chunk) => {
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
            handleEvent(ev);
          }
        });
        child.on("close", () => {
          child = undefined;
          post({ type: "chatDone" });
        });
        child.on("error", (e) => {
          child = undefined;
          post({ type: "chatError", error: String(e?.message ?? e) });
        });
        wired = true;
        return true;
      };

      const handleEvent = (ev: any) => {
        if (ev.type === "extension_ui_request") {
          const id = ev.id;
          const method = ev.method;
          if (!id) return;
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
          if (a?.type === "text_delta" && typeof a.delta === "string") post({ type: "chatDelta", delta: a.delta });
          else if (a?.type === "tool_call" || (a?.partial && Array.isArray(a.partial.content) && a.partial.content.some((c: any) => c.type === "toolCall"))) {
            const name = a?.toolName ?? a?.partial?.content?.find((c: any) => c.type === "toolCall")?.name;
            if (name) post({ type: "chatTool", name });
          }
          return;
        }
        if (ev.type === "message_end" && ev.message?.role === "assistant") {
          for (const part of ev.message.content ?? []) {
            if (part.type === "toolCall" && part.name) post({ type: "chatTool", name: part.name });
          }
          return;
        }
        if (ev.type === "agent_end") {
          post({ type: "chatDone" }); // keep the process alive for the next turn
        }
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
          case "openSession":
            if (typeof msg.file === "string") void openTerminal(["--resume", msg.file]);
            break;
          case "signIn":
            void vscode.commands.executeCommand("naraya.signIn");
            break;
          case "chat":
            if (typeof msg.text === "string" && msg.text.trim()) {
              if (await ensureChild()) send({ id: `p${Date.now()}`, type: "prompt", message: msg.text.trim() });
            }
            break;
          case "newChat":
            try {
              child?.kill();
            } catch {
              /* ignore */
            }
            child = undefined;
            break;
          case "stopChat":
            try {
              child?.kill();
            } catch {
              /* ignore */
            }
            child = undefined;
            break;
        }
        void wired;
      });

      view.onDidDispose(() => {
        try {
          child?.kill();
        } catch {
          /* ignore */
        }
        child = undefined;
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
  // Inline SVG icons (currentColor) — no codicon-font dependency (works on forks).
  const ic = {
    chat: `<svg viewBox="0 0 16 16" width="15" height="15" fill="currentColor"><path d="M8 1.5A6.5 6.5 0 0 0 2.2 11L1.5 14l3-0.7A6.5 6.5 0 1 0 8 1.5Z" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>`,
    sessions: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M8 4v4l2.5 1.5"/><circle cx="8" cy="8" r="6"/></svg>`,
    account: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.2"><circle cx="8" cy="5.5" r="2.6"/><path d="M3 13.5a5 5 0 0 1 10 0"/></svg>`,
    plus: `<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path d="M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z"/></svg>`,
    sess: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.1"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 6h12"/></svg>`,
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); margin: 0; }
  .brand { display: flex; align-items: center; gap: 8px; padding: 12px 12px 8px; }
  .brand img { width: 22px; height: 22px; } .brand strong { font-size: 14px; }
  .tabs { display: flex; gap: 2px; padding: 0 8px; border-bottom: 1px solid var(--vscode-panel-border); position: sticky; top: 0; background: var(--vscode-sideBar-background); z-index: 2; }
  .tab { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 4px; cursor: pointer; opacity: .6; border-bottom: 2px solid transparent; font-size: 12px; }
  .tab:hover { opacity: .85; } .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder); color: var(--vscode-focusBorder); }
  .view { display: none; } .view.active { display: flex; flex-direction: column; }
  h3 { margin: 4px 0 6px; font-size: 11px; text-transform: uppercase; opacity: .65; letter-spacing: .05em; }
  .row { display: flex; justify-content: space-between; gap: 8px; padding: 5px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .row:last-child { border: 0; } .row .k { opacity: .7; } .row .v { font-weight: 600; text-align: right; }
  button { display: inline-flex; align-items: center; gap: 6px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: none; padding: 6px 12px; border-radius: 5px; cursor: pointer; font-size: 12px; }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  input { width: 100%; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); padding: 7px 9px; border-radius: 5px; outline: none; }
  input:focus { border-color: var(--vscode-focusBorder); }
  .muted { opacity: .6; padding: 6px 0; }
  /* chat */
  #v-chat { height: calc(100vh - 96px); }
  #log { flex: 1; overflow-y: auto; padding: 12px; }
  .welcome { text-align: center; padding: 28px 16px; opacity: .85; }
  .welcome img { width: 40px; height: 40px; margin-bottom: 10px; }
  .welcome p { opacity: .65; font-size: 12px; margin: 6px 0 16px; }
  .chip { display: inline-block; margin: 4px; padding: 6px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 14px; cursor: pointer; font-size: 12px; }
  .chip:hover { background: var(--vscode-list-hoverBackground); }
  .msg { padding: 8px 0; } .msg .who { display: flex; align-items: center; gap: 6px; font-size: 11px; opacity: .6; margin-bottom: 3px; }
  .msg .body { white-space: pre-wrap; word-break: break-word; line-height: 1.5; }
  .avatar { width: 16px; height: 16px; border-radius: 4px; display: inline-flex; align-items: center; justify-content: center; font-size: 10px; }
  .av-u { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .tool { font-size: 11px; opacity: .6; font-style: italic; padding: 2px 0; }
  .chatbar { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid var(--vscode-panel-border); }
  .pad { padding: 12px; }
  .sess { display: flex; gap: 8px; padding: 8px; border-radius: 6px; cursor: pointer; border: 1px solid transparent; align-items: flex-start; }
  .sess:hover { background: var(--vscode-list-hoverBackground); border-color: var(--vscode-panel-border); }
  .sess .ic { opacity: .5; margin-top: 1px; }
  .sess .t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sess .m { font-size: 11px; opacity: .55; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .toolbar { display: flex; gap: 6px; padding: 10px 12px 6px; }
</style>
</head>
<body>
  <div class="brand"><img src="${logo}" alt=""><strong>Naraya AI</strong></div>
  <div class="tabs">
    <div class="tab active" data-v="chat">${ic.chat} Chat</div>
    <div class="tab" data-v="sessions">${ic.sessions} Sessions</div>
    <div class="tab" data-v="account">${ic.account} Account</div>
  </div>

  <div class="view active" id="v-chat">
    <div id="log"></div>
    <div class="chatbar">
      <input id="chatInput" placeholder="Message Naraya… (Enter to send)">
      <button id="send">${ic.chat}</button>
    </div>
  </div>

  <div class="view" id="v-sessions">
    <div class="toolbar"><button id="newSession">${ic.plus} New session</button></div>
    <div class="pad" style="padding-top:0"><input id="search" placeholder="Search sessions…"></div>
    <div class="pad" id="sessions" style="padding-top:0"><div class="muted">Loading…</div></div>
  </div>

  <div class="view" id="v-account">
    <div class="pad" id="account"><div class="muted">Loading…</div></div>
    <div class="pad" style="padding-top:0"><button class="sec" id="refreshAcc">Refresh</button></div>
  </div>

<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  const IC = ${JSON.stringify(ic)};
  let sessions = [];

  document.querySelectorAll('.tab').forEach(t => t.onclick = () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.view').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('v-' + t.dataset.v).classList.add('active');
    if (t.dataset.v === 'sessions') vscode.postMessage({ type: 'refreshSessions' });
    if (t.dataset.v === 'account') vscode.postMessage({ type: 'refreshAccount' });
  });

  // ---- Chat ----
  const log = document.getElementById('log');
  const input = document.getElementById('chatInput');
  let streaming = false, assistantBody = null, empty = true;
  const LOGO = ${JSON.stringify(String(logo))};

  function showWelcome() {
    log.innerHTML = '<div class="welcome"><img src="'+LOGO+'"><div><strong>Chat with Naraya</strong></div>'
      + '<p>Runs the Naraya engine in this workspace — ask it to build, fix, or explain. It can read & edit your files (with permission).</p>'
      + '<div><span class="chip">Explain this file</span><span class="chip">Find bugs in the project</span><span class="chip">Write tests</span></div></div>';
    log.querySelectorAll('.chip').forEach(c => c.onclick = () => { input.value = c.textContent; input.focus(); });
  }
  function addMsg(who, cls, av) {
    if (empty) { log.innerHTML = ''; empty = false; }
    const d = document.createElement('div'); d.className = 'msg ' + cls;
    d.innerHTML = '<div class="who">'+av+' '+who+'</div><div class="body"></div>';
    log.appendChild(d); log.scrollTop = log.scrollHeight; return d.querySelector('.body');
  }
  function send() {
    const text = input.value.trim(); if (!text || streaming) return;
    addMsg('You', 'user', '<span class="avatar av-u">U</span>').textContent = text;
    input.value = ''; streaming = true;
    assistantBody = addMsg('Naraya', 'assistant', '<img class="avatar" src="'+LOGO+'">');
    vscode.postMessage({ type: 'chat', text });
  }
  document.getElementById('send').onclick = send;
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  // ---- Sessions ----
  function renderSessions() {
    const q = (document.getElementById('search').value || '').toLowerCase();
    const box = document.getElementById('sessions'); box.innerHTML = '';
    const items = sessions.filter(s => !q || (s.title + ' ' + s.project).toLowerCase().includes(q));
    if (!items.length) { box.innerHTML = '<div class="muted">No sessions yet.</div>'; return; }
    for (const s of items) {
      const d = document.createElement('div'); d.className = 'sess';
      const proj = s.project ? s.project.split(/[\\\\/]/).pop() : '';
      d.innerHTML = '<span class="ic">'+IC.sess+'</span><div style="min-width:0"><div class="t"></div><div class="m"></div></div>';
      d.querySelector('.t').textContent = s.title;
      d.querySelector('.m').textContent = proj + ' · ' + new Date(s.mtime).toLocaleString();
      d.onclick = () => vscode.postMessage({ type: 'openSession', file: s.file });
      box.appendChild(d);
    }
  }
  document.getElementById('search').addEventListener('input', renderSessions);
  document.getElementById('newSession').onclick = () => vscode.postMessage({ type: 'newSession' });

  // ---- Account ----
  function num(n){ return (n||0).toLocaleString(); }
  function renderAccount(r) {
    const box = document.getElementById('account');
    if (!r || !r.ok) {
      if (r && r.error === 'not-signed-in') { box.innerHTML = '<div class="muted">Not signed in.</div>'; const b = document.createElement('button'); b.innerHTML = IC.account + ' Sign in with Naraya'; b.onclick = () => vscode.postMessage({ type: 'signIn' }); box.appendChild(b); return; }
      box.innerHTML = '<div class="muted">Usage unavailable' + (r && r.error ? ' (' + r.error + ')' : '') + '.</div>'; return;
    }
    const s = r.data || {}; const a = s.account || {}, c = s.credit || {}, q = s.quota || {}, u = s.usage || {};
    const rows = [
      ['Email', a.email || '—'], ['Plan', a.plan || '—'],
      ['Credit', 'Rp ' + Math.round(c.available||0).toLocaleString() + (c.usd_equivalent ? ' / $' + c.usd_equivalent : '')],
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
    else if (m.type === 'chatDelta') { if (assistantBody) { assistantBody.textContent += m.delta; log.scrollTop = log.scrollHeight; } }
    else if (m.type === 'chatTool') { const t = document.createElement('div'); t.className='tool'; t.textContent = '⚙ ' + m.name; if (assistantBody) assistantBody.parentElement.insertBefore(t, assistantBody); log.scrollTop = log.scrollHeight; }
    else if (m.type === 'chatDone') { streaming = false; }
    else if (m.type === 'chatError') { if (assistantBody) assistantBody.textContent += '\\n[error: ' + m.error + ']'; streaming = false; }
  });

  showWelcome();
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
