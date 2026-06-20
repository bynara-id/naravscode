// Naraya chat webview — minimal Claude-Code-style rendering (no avatars/role
// labels; tool calls as compact dot+line steps; final answer flows at the end).
(function () {
  const vscode = acquireVsCodeApi();
  const ICON = (window.__naraya && (window.__naraya.icon || window.__naraya.logo)) || "";
  const log = document.getElementById("log");
  const input = document.getElementById("in");
  let streaming = false, empty = true;
  let curText = null, curRaw = "", thinkingEl = null;
  const tools = {};

  function esc(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  function md(t) {
    const blocks = [];
    t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, function (m, lang, code) {
      blocks.push("<pre><code>" + esc(code.replace(/\n+$/, "")) + "</code></pre>");
      return " " + (blocks.length - 1) + " ";
    });
    t = esc(t);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    const lines = t.split("\n");
    let html = "", inList = false, inTable = false, tbl = [];
    function flushTable() {
      if (!tbl.length) { inTable = false; return; }
      const rows = tbl.filter(r => !/^\s*\|?[\s|:-]+\|?\s*$/.test(r));
      html += "<table>" + rows.map((r, i) => {
        const cells = r.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim());
        const tag = i === 0 ? "th" : "td";
        return "<tr>" + cells.map(c => "<" + tag + ">" + c + "</" + tag + ">").join("") + "</tr>";
      }).join("") + "</table>";
      tbl = []; inTable = false;
    }
    for (let ln of lines) {
      if (/^\s*\|.*\|\s*$/.test(ln)) { if (inList) { html += "</ul>"; inList = false; } inTable = true; tbl.push(ln); continue; }
      if (inTable) flushTable();
      const h = ln.match(/^\s*#{1,3}\s+(.*)$/);
      const li = ln.match(/^\s*[-*]\s+(.*)$/);
      const ph = ln.match(/^ (\d+) $/);
      if (li) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + li[1] + "</li>"; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      if (h) { html += "<h3>" + h[1] + "</h3>"; continue; }
      if (ph) { html += blocks[+ph[1]]; continue; }
      if (ln.trim() === "") continue;
      html += "<p>" + ln + "</p>";
    }
    if (inList) html += "</ul>";
    if (inTable) flushTable();
    html = html.replace(/ (\d+) /g, function (m, i) { return blocks[i]; });
    return html;
  }
  function render(el, text) { try { el.innerHTML = md(text); } catch (e) { el.textContent = text; } }
  function scroll() { log.scrollTop = log.scrollHeight; }

  function welcome() {
    log.innerHTML =
      '<div class="welcome">' + (ICON ? '<img class="wlogo" src="' + ICON + '">' : "") + "<h2>Naraya AI</h2>" +
      "<p>Ask it to build, fix, or explain. Type @ to reference a file.</p>" +
      '<div><span class="chip">Explain this file</span><span class="chip">Find bugs</span><span class="chip">Write tests</span></div></div>';
    for (const c of log.querySelectorAll(".chip")) c.onclick = function () { input.value = c.textContent; input.focus(); resize(); };
  }
  function fresh() { if (empty) { log.innerHTML = ""; empty = false; } }
  function newText() { fresh(); const b = document.createElement("div"); b.className = "body"; log.appendChild(b); return b; }
  function clearThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

  function send() {
    const t = input.value.trim(); if (!t || streaming) return;
    fresh();
    const u = document.createElement("div"); u.className = "umsg"; u.textContent = t; log.appendChild(u);
    input.value = ""; resize(); streaming = true; curText = null; curRaw = "";
    thinkingEl = document.createElement("div"); thinkingEl.className = "step thinking";
    thinkingEl.innerHTML = '<span class="dot run"></span><span class="thought">Thinking…</span>';
    log.appendChild(thinkingEl); scroll();
    vscode.postMessage({ type: "chat", text: t, mode: modeSel.value, effort: effortSel.value });
  }
  function resize() { input.style.height = "auto"; input.style.height = Math.min(200, input.scrollHeight) + "px"; }

  function startTool(id, name, summary) {
    clearThinking(); fresh(); curText = null;
    const step = document.createElement("div");
    step.className = "step";
    step.innerHTML =
      '<span class="dot run"></span>' +
      '<div class="sbody"><div class="shead"><b>' + esc(name) + '</b> <span class="args"></span><span class="ststate">running</span></div>' +
      '<pre class="tout" style="display:none"></pre></div>';
    if (summary) step.querySelector(".args").textContent = summary;
    step.querySelector(".shead").onclick = function () {
      const o = step.querySelector(".tout");
      if (o.textContent || o.querySelector("img")) o.style.display = o.style.display === "none" ? "block" : "none";
    };
    log.appendChild(step); tools[id] = step; scroll();
    return step;
  }

  // ---- @ file mention ----
  const menu = document.getElementById("mention");
  let files = [], mEntries = [], mIdx = 0, mStart = -1;
  function atQuery() {
    const v = input.value, c = input.selectionStart;
    const at = v.lastIndexOf("@", c - 1);
    if (at < 0) return null;
    const between = v.slice(at + 1, c);
    if (/\s/.test(between)) return null;
    return { at, q: between.toLowerCase() };
  }
  function showMentions() {
    const m = atQuery();
    if (!m) { menu.style.display = "none"; mStart = -1; return; }
    mStart = m.at;
    mEntries = files.filter(f => f.toLowerCase().includes(m.q)).slice(0, 12);
    if (!mEntries.length) { menu.style.display = "none"; return; }
    mIdx = 0; paintMenu(); menu.style.display = "block";
  }
  function paintMenu() {
    menu.innerHTML = mEntries.map((f, i) => '<div class="mi' + (i === mIdx ? " sel" : "") + '">' + esc(f) + "</div>").join("");
    [...menu.children].forEach((el, i) => el.onclick = () => pickMention(i));
  }
  function pickMention(i) {
    const f = mEntries[i]; if (!f) return;
    const v = input.value, c = input.selectionStart;
    input.value = v.slice(0, mStart) + "@" + f + " " + v.slice(c);
    menu.style.display = "none"; mStart = -1; input.focus(); resize();
  }

  document.getElementById("send").onclick = send;
  document.getElementById("new").onclick = function () {
    vscode.postMessage({ type: "newChat" }); empty = true; curText = null; curRaw = ""; streaming = false; welcome();
  };
  input.addEventListener("input", function () { resize(); showMentions(); });
  input.addEventListener("keydown", function (e) {
    if (menu.style.display === "block") {
      if (e.key === "ArrowDown") { e.preventDefault(); mIdx = (mIdx + 1) % mEntries.length; paintMenu(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); mIdx = (mIdx - 1 + mEntries.length) % mEntries.length; paintMenu(); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mIdx); return; }
      if (e.key === "Escape") { menu.style.display = "none"; return; }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  const modeSel = document.getElementById("mode");
  const effortSel = document.getElementById("effort");

  window.addEventListener("message", function (e) {
    const m = e.data;
    if (m.type === "chatDelta") {
      clearThinking();
      if (!curText) { curText = newText(); curRaw = ""; }
      curRaw += m.delta; render(curText, curRaw); scroll();
    } else if (m.type === "chatReason") {
      clearThinking();
      let r = log.querySelector(".reason.live");
      if (!r) { fresh(); r = document.createElement("div"); r.className = "reason live"; r.dataset.raw = ""; log.appendChild(r); }
      r.dataset.raw += m.delta; r.textContent = "💭 " + r.dataset.raw.slice(-500); scroll();
    } else if (m.type === "toolStart") { startTool(m.id, m.name, m.summary); }
    else if (m.type === "toolEnd") {
      const step = tools[m.id] || startTool(m.id, "tool", "");
      const dot = step.querySelector(".dot"); dot.className = "dot " + (m.isError ? "err" : "ok");
      step.querySelector(".ststate").textContent = m.isError ? "error" : "done";
      if (m.result) step.querySelector(".tout").textContent = m.result;
      scroll();
    } else if (m.type === "toolImage") {
      const step = tools[m.id];
      if (step && m.src) { const o = step.querySelector(".tout"); const img = document.createElement("img"); img.className = "toolimg"; img.src = m.src; o.appendChild(img); o.style.display = "block"; scroll(); }
    } else if (m.type === "chatDone") {
      streaming = false; clearThinking();
      const live = log.querySelector(".reason.live"); if (live) live.classList.remove("live");
    } else if (m.type === "chatError") {
      clearThinking(); fresh();
      const d = document.createElement("div"); d.className = "errline"; d.textContent = "error: " + m.error; log.appendChild(d); streaming = false;
    } else if (m.type === "reset") { empty = true; curText = null; curRaw = ""; streaming = false; welcome(); }
    else if (m.type === "files") { files = m.list || []; }
    else if (m.type === "transcript") {
      empty = true; curText = null; curRaw = ""; log.innerHTML = "";
      for (const x of (m.messages || [])) {
        if (x.role === "user") { fresh(); const u = document.createElement("div"); u.className = "umsg"; u.textContent = x.text; log.appendChild(u); }
        else { const b = newText(); render(b, x.text); }
      }
      if (!(m.messages || []).length) welcome();
    }
  });

  welcome();
  vscode.postMessage({ type: "listFiles" });
})();
