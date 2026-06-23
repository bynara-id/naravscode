// ByNara chat webview — minimal Claude-Code-style rendering (no avatars/role
// labels; tool calls as compact dot+line steps; final answer flows at the end).
(function () {
  const vscode = acquireVsCodeApi();
  const ICON = (window.__bynara && (window.__bynara.icon || window.__bynara.logo)) || "";
  const log = document.getElementById("log");
  const input = document.getElementById("in");
  const sendBtn = document.getElementById("send");
  const SEND_SVG = sendBtn.innerHTML;
  const STOP_SVG =
    '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><rect x="3.5" y="3.5" width="9" height="9" rx="2"/></svg>';
  let streaming = false,
    empty = true;
  let curText = null,
    curRaw = "",
    thinkingEl = null;
  const tools = {};
  const askTools = {}; // ask_user tool-call ids, suppressed in favor of the inline question card
  const todoIds = {}; // todo tool-call ids, rendered as one live checklist instead of stacked boxes
  let todoPanel = null;
  let doneTimer = null; // grace timer before treating the turn as fully idle
  const workStatus = document.getElementById("workstatus");
  const workLabel = workStatus && workStatus.querySelector(".wlabel");
  function setStreaming(on) {
    streaming = on;
    sendBtn.classList.toggle("stopping", on);
    sendBtn.innerHTML = on ? STOP_SVG : SEND_SVG;
    sendBtn.title = on ? "Stop" : "Send";
    // Persistent rotating "working" pill above the composer — visible the WHOLE
    // time the agent is busy (not just the brief pre-output gap).
    if (workStatus) workStatus.classList.toggle("on", on);
    if (on) {
      if (workLabel) workLabel.textContent = pickWord() + "…";
      startThinkTicker();
    } else {
      stopThinkTicker();
    }
  }

  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  const CB0 = String.fromCharCode(0),
    CB1 = String.fromCharCode(1);
  function md(t) {
    const blocks = [];
    t = t.replace(/```(\w*)\n?([\s\S]*?)```/g, function (m, lang, code) {
      blocks.push("<pre><code>" + esc(code.replace(/\n+$/, "")) + "</code></pre>");
      return CB0 + (blocks.length - 1) + CB1;
    });
    t = esc(t);
    t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
    t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
    const lines = t.split("\n");
    let html = "",
      inList = false,
      inTable = false,
      tbl = [];
    function flushTable() {
      if (!tbl.length) {
        inTable = false;
        return;
      }
      const rows = tbl.filter((r) => !/^\s*\|?[\s|:-]+\|?\s*$/.test(r));
      html +=
        "<table>" +
        rows
          .map((r, i) => {
            const cells = r
              .replace(/^\s*\|/, "")
              .replace(/\|\s*$/, "")
              .split("|")
              .map((c) => c.trim());
            const tag = i === 0 ? "th" : "td";
            return (
              "<tr>" + cells.map((c) => "<" + tag + ">" + c + "</" + tag + ">").join("") + "</tr>"
            );
          })
          .join("") +
        "</table>";
      tbl = [];
      inTable = false;
    }
    for (let ln of lines) {
      if (/^\s*\|.*\|\s*$/.test(ln)) {
        if (inList) {
          html += "</ul>";
          inList = false;
        }
        inTable = true;
        tbl.push(ln);
        continue;
      }
      if (inTable) flushTable();
      const h = ln.match(/^\s*#{1,3}\s+(.*)$/);
      const li = ln.match(/^\s*[-*]\s+(.*)$/);
      const ph = ln.match(new RegExp("^" + CB0 + "(\\d+)" + CB1 + "$"));
      if (li) {
        if (!inList) {
          html += "<ul>";
          inList = true;
        }
        html += "<li>" + li[1] + "</li>";
        continue;
      }
      if (inList) {
        html += "</ul>";
        inList = false;
      }
      if (h) {
        html += "<h3>" + h[1] + "</h3>";
        continue;
      }
      if (ph) {
        html += blocks[+ph[1]];
        continue;
      }
      if (ln.trim() === "") continue;
      html += "<p>" + ln + "</p>";
    }
    if (inList) html += "</ul>";
    if (inTable) flushTable();
    html = html.replace(new RegExp(CB0 + "(\\d+)" + CB1, "g"), function (m, i) {
      return blocks[+i] != null ? blocks[+i] : m;
    });
    return html;
  }
  function render(el, text) {
    try {
      el.innerHTML = md(text);
    } catch (e) {
      el.textContent = text;
    }
  }
  // Auto-scroll only when the user is already pinned near the bottom. If they
  // scrolled up to read while the agent is streaming, leave the viewport alone.
  let stick = true;
  log.addEventListener("scroll", function () {
    stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  });
  function scroll() {
    if (stick) log.scrollTop = log.scrollHeight;
  }
  // Force to bottom + re-pin (used when the user themselves sends a message).
  function scrollPin() {
    stick = true;
    log.scrollTop = log.scrollHeight;
  }

  function welcome() {
    todoPanel = null;
    log.innerHTML =
      '<div class="welcome">' +
      (ICON ? '<img class="wlogo" src="' + ICON + '">' : "") +
      "<h2>ByNara AI</h2>" +
      "<p>Ask it to build, fix, or explain. Type @ to reference a file.</p>" +
      '<div><span class="chip">Explain this file</span><span class="chip">Find bugs</span><span class="chip">Write tests</span></div></div>';
    for (const c of log.querySelectorAll(".chip"))
      c.onclick = function () {
        input.value = c.textContent;
        input.focus();
        resize();
      };
  }
  function fresh() {
    if (empty) {
      log.innerHTML = "";
      todoPanel = null;
      empty = false;
    }
  }
  function newText() {
    fresh();
    const b = document.createElement("div");
    b.className = "body";
    log.appendChild(b);
    return b;
  }
  // Rotating "working" verbs (Claude-style) shown while the agent is busy.
  const WORK_WORDS = [
    "Thinking", "Pondering", "Cogitating", "Brewing", "Conjuring", "Crunching",
    "Synthesizing", "Chunking", "Wrangling", "Percolating", "Noodling", "Computing",
    "Untangling", "Finagling", "Tinkering", "Reticulating", "Vibing", "Scheming",
    "Assembling", "Distilling", "Completing", "Plotting", "Marinating", "Whirring",
  ];
  let thinkTimer = null;
  function pickWord() {
    return WORK_WORDS[Math.floor(Math.random() * WORK_WORDS.length)];
  }
  function startThinkTicker() {
    stopThinkTicker();
    thinkTimer = setInterval(function () {
      const w = pickWord() + "…";
      if (thinkingEl) {
        const t = thinkingEl.querySelector(".thought");
        if (t) t.textContent = w;
      }
      if (workLabel) workLabel.textContent = w;
    }, 1800);
  }
  function stopThinkTicker() {
    if (thinkTimer) {
      clearInterval(thinkTimer);
      thinkTimer = null;
    }
  }
  function clearThinking() {
    // Only remove the inline "Thinking…" step. The rotating ticker stays alive —
    // it now drives the persistent #workstatus pill, controlled by setStreaming.
    if (thinkingEl) {
      thinkingEl.remove();
      thinkingEl = null;
    }
  }

  function send() {
    const t = input.value.trim();
    if ((!t && !pendingImages.length) || streaming) return;
    const lc = t.match(/^\/([\w-]+)/);
    if (lc && isLocal(lc[1])) {
      cmdMenu.classList.remove("open");
      runLocalCmd(lc[1]);
      input.value = "";
      resize();
      return;
    }
    fresh();
    const imgs = pendingImages.slice();
    const u = document.createElement("div");
    u.className = "umsg";
    if (t) u.textContent = t;
    for (const im of imgs) {
      const img = document.createElement("img");
      img.className = "uimg";
      img.src = im.url;
      u.appendChild(img);
    }
    log.appendChild(u);
    input.value = "";
    pendingImages = [];
    renderChips();
    resize();
    setStreaming(true); // shows the persistent #workstatus pill — no inline duplicate
    curText = null;
    curRaw = "";
    scrollPin();
    vscode.postMessage({
      type: "chat",
      text: t,
      mode: modeSel.value,
      effort: effortSel.value,
      model: modelSel.value,
      provider: modelProvider,
      web: webOn,
      images: imgs.map((im) => ({ mimeType: im.mimeType, data: im.data })),
    });
  }
  function resize() {
    input.style.height = "auto";
    input.style.height = Math.min(200, input.scrollHeight) + "px";
  }

  // ---- pasted / attached images ----
  const chips = document.getElementById("chips");
  let pendingImages = []; // { mimeType, data(base64), url(dataURI) }
  function renderChips() {
    chips.innerHTML = pendingImages
      .map(
        (im, i) =>
          '<span class="chip-img"><img src="' +
          im.url +
          '"><button class="chip-x" data-i="' +
          i +
          '" title="Remove">✕</button></span>',
      )
      .join("");
    chips.style.display = pendingImages.length ? "flex" : "none";
    [...chips.querySelectorAll(".chip-x")].forEach(
      (b) =>
        (b.onclick = () => {
          pendingImages.splice(+b.dataset.i, 1);
          renderChips();
        }),
    );
  }
  function addImageFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const data = url.split(",")[1] || "";
      if (data) {
        pendingImages.push({ mimeType: file.type || "image/png", data: data, url: url });
        renderChips();
      }
    };
    reader.readAsDataURL(file);
  }
  input.addEventListener("paste", function (e) {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    let got = false;
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const f = it.getAsFile();
        if (f) {
          addImageFile(f);
          got = true;
        }
      }
    }
    if (got) e.preventDefault();
  });

  // The `todo` tool fires many times per turn (clear/add/start/done). pi renders
  // it as ONE live widget; mirror that here — a single checklist panel updated in
  // place instead of a stack of click-to-expand boxes. Parses "#1 [x] Title" rows.
  function renderTodo(text) {
    clearThinking();
    fresh();
    curText = null;
    const raw = text || "";
    const rows = raw
      .split("\n")
      .map(function (l) {
        const mm = l.match(/^\s*#?\d+\s*\[([ x~-])\]\s*(.*)$/);
        return mm ? { state: mm[1], title: mm[2] } : null;
      })
      .filter(Boolean);
    if (!rows.length) {
      // No list rows. If the tool explicitly cleared/emptied, drop the panel;
      // otherwise (e.g. an add ack with no payload) keep the last shown state.
      if (todoPanel && /clear|empt|no\s+todo/i.test(raw)) {
        todoPanel.remove();
        todoPanel = null;
      }
      return;
    }
    const isNew = !todoPanel;
    if (isNew) {
      todoPanel = document.createElement("div");
      todoPanel.className = "todo";
    }
    const icon = function (s) {
      return s === "x" ? "✔" : s === "~" ? "▶" : "○";
    };
    const cls = function (s) {
      return s === "x" ? "td-done" : s === "~" ? "td-run" : "td-todo";
    };
    const done = rows.filter(function (r) {
      return r.state === "x";
    }).length;
    todoPanel.innerHTML =
      '<div class="todo-h">Todo <span class="todo-c">' +
      done +
      "/" +
      rows.length +
      "</span></div>" +
      rows
        .map(function (r) {
          return (
            '<div class="todo-r ' +
            cls(r.state) +
            '"><span class="todo-i">' +
            icon(r.state) +
            "</span><span>" +
            esc(r.title) +
            "</span></div>"
          );
        })
        .join("");
    // Append only once at its natural spot; update in place afterwards so the
    // panel doesn't jump around the conversation on every status change.
    if (isNew) log.appendChild(todoPanel);
    scroll();
  }

  function startTool(id, name, summary) {
    clearThinking();
    fresh();
    curText = null;
    const step = document.createElement("div");
    step.className = "step";
    step.innerHTML =
      '<span class="dot run"></span>' +
      '<div class="sbody"><div class="shead"><b>' +
      esc(name) +
      '</b> <span class="args"></span><span class="ststate">running</span></div>' +
      '<pre class="tout" style="display:none"></pre></div>';
    if (summary) step.querySelector(".args").textContent = summary;
    step.querySelector(".shead").onclick = function () {
      const o = step.querySelector(".tout");
      if (o.textContent || o.querySelector("img"))
        o.style.display = o.style.display === "none" ? "block" : "none";
    };
    log.appendChild(step);
    tools[id] = step;
    scroll();
    return step;
  }

  // ---- @ file mention ----
  const menu = document.getElementById("mention");
  let files = [],
    mEntries = [],
    mIdx = 0,
    mStart = -1;
  function atQuery() {
    const v = input.value,
      c = input.selectionStart;
    const at = v.lastIndexOf("@", c - 1);
    if (at < 0) return null;
    const between = v.slice(at + 1, c);
    if (/\s/.test(between)) return null;
    return { at, q: between.toLowerCase() };
  }
  let lastFilesReq = 0;
  function refreshFilesThrottled() {
    const now = Date.now();
    if (now - lastFilesReq < 1200) return; // avoid spamming on every keystroke
    lastFilesReq = now;
    vscode.postMessage({ type: "listFiles" });
  }
  function showMentions() {
    const m = atQuery();
    if (!m) {
      menu.style.display = "none";
      mStart = -1;
      return;
    }
    // Pull a fresh file list so newly-created files show up without reopening
    // the panel; the "files" handler re-renders this menu when it arrives.
    refreshFilesThrottled();
    mStart = m.at;
    mEntries = files.filter((f) => f.toLowerCase().includes(m.q)).slice(0, 12);
    if (!mEntries.length) {
      menu.style.display = "none";
      return;
    }
    mIdx = 0;
    paintMenu();
    menu.style.display = "block";
  }
  function paintMenu() {
    menu.innerHTML = mEntries
      .map((f, i) => '<div class="mi' + (i === mIdx ? " sel" : "") + '">' + esc(f) + "</div>")
      .join("");
    [...menu.children].forEach((el, i) => (el.onclick = () => pickMention(i)));
  }
  function pickMention(i) {
    const f = mEntries[i];
    if (!f) return;
    const v = input.value,
      c = input.selectionStart;
    input.value = v.slice(0, mStart) + "@" + f + " " + v.slice(c);
    menu.style.display = "none";
    mStart = -1;
    input.focus();
    resize();
  }

  // ---- / command palette (Filter-actions style) ----
  const cmdMenu = document.getElementById("cmdmenu");
  const cmdList = document.getElementById("cmdlist");
  const CAT_ORDER = ["Context", "Model", "Tools", "Account", "Skills"];
  let cmds = [],
    cmdsRequested = false,
    cEntries = [],
    cIdx = 0;
  // Actions handled by the extension UI itself (not forwarded to the engine).
  const LOCAL_CMDS = [
    {
      name: "clear",
      description: "Clear conversation (new chat)",
      source: "local",
      cat: "Context",
    },
    {
      name: "compact",
      description: "Compact / truncate the conversation context",
      source: "local",
      cat: "Context",
    },
    { name: "agent-model", description: "Set a subagent's model", source: "local", cat: "Model" },
    { name: "mcp", description: "MCP servers — view, add, remove", source: "local", cat: "Tools" },
    {
      name: "usage",
      description: "Account credit, quota & usage",
      source: "local",
      cat: "Account",
    },
    { name: "signout", description: "Sign out of ByNara", source: "local", cat: "Account" },
  ];
  function isLocal(name) {
    return LOCAL_CMDS.some((c) => c.name === name);
  }
  function slashQuery() {
    const v = input.value,
      c = input.selectionStart;
    if (!v.startsWith("/")) return null;
    const head = v.slice(0, c);
    if (/\s/.test(head)) return null; // command name ends at first space
    return { q: v.slice(1, c).toLowerCase() };
  }
  function showCmds() {
    const m = slashQuery();
    if (!m) {
      cmdMenu.classList.remove("open");
      return;
    }
    if (!cmdsRequested) {
      cmdsRequested = true;
      vscode.postMessage({ type: "listCommands" });
    }
    // LOCAL actions run directly. Engine "extension" commands can't be invoked over
    // RPC, but SKILLS can be triggered model-driven (pick primes a prompt).
    const skills = cmds.filter((c) => c.source === "skill").map((c) => ({ ...c, cat: "Skills" }));
    cEntries = LOCAL_CMDS.concat(skills)
      .filter(
        (c) =>
          c.name.toLowerCase().includes(m.q) || (c.description || "").toLowerCase().includes(m.q),
      )
      .sort((a, b) => CAT_ORDER.indexOf(a.cat || "Skills") - CAT_ORDER.indexOf(b.cat || "Skills"));
    cIdx = 0;
    paintCmds();
    closeMenus("cmd");
    cmdMenu.classList.add("open");
  }
  function paintCmds() {
    if (!cEntries.length) {
      cmdList.innerHTML =
        '<div class="cmi loading">' + (cmds.length ? "No matches" : "Loading…") + "</div>";
      return;
    }
    let html = "",
      lastCat = null;
    cEntries.forEach((c, i) => {
      const cat = c.cat || "Commands";
      if (cat !== lastCat) {
        html += '<div class="cmd-sec">' + esc(cat) + "</div>";
        lastCat = cat;
      }
      const label = c.source === "local" ? esc(c.description || c.name) : "/" + esc(c.name);
      const desc =
        c.source === "local" ? "" : '<span class="cdesc">' + esc(c.description || "") + "</span>";
      const src =
        c.source && c.source !== "local" ? '<span class="csrc">' + esc(c.source) + "</span>" : "";
      html +=
        '<div class="cmi' +
        (i === cIdx ? " sel" : "") +
        '" data-i="' +
        i +
        '"><span class="cname">' +
        label +
        "</span>" +
        desc +
        src +
        "</div>";
    });
    cmdList.innerHTML = html;
    [...cmdList.querySelectorAll(".cmi")].forEach(
      (el) => (el.onclick = () => pickCmd(+el.dataset.i)),
    );
  }
  function pickCmd(i) {
    const c = cEntries[i];
    if (!c) return;
    cmdMenu.classList.remove("open");
    if (c.source === "local") {
      runLocalCmd(c.name);
      input.value = "";
      resize();
      return;
    }
    // Skill: prime a natural request so the model loads + follows the skill.
    input.value = 'Use the "' + c.name + '" skill: ';
    input.focus();
    resize();
  }
  function runLocalCmd(name) {
    if (name === "usage") {
      openUsageModal('<div class="udesc">Loading usage…</div>');
      vscode.postMessage({ type: "getUsage" });
    } else if (name === "clear") {
      document.getElementById("new").click();
    } else if (name === "compact") {
      fresh();
      const d = document.createElement("div");
      d.className = "qcard done";
      d.innerHTML =
        '<div class="qdone"><span class="qcheck">✓</span><span class="qq">Compacting conversation context…</span></div>';
      log.appendChild(d);
      scroll();
      vscode.postMessage({ type: "compact" });
    } else if (name === "agent-model") {
      vscode.postMessage({ type: "listAgents" });
    } else if (name === "mcp") {
      vscode.postMessage({ type: "getMcp" });
    } else if (name === "signout") {
      vscode.postMessage({ type: "signOut" });
    }
  }
  function renderMcpModal(list) {
    let body = '<div class="picklist">';
    if (!list || !list.length) body += '<div class="udesc">No MCP servers configured.</div>';
    (list || []).forEach(function (s) {
      body +=
        '<div class="mcprow"><div class="mtext"><b>' +
        esc(s.name) +
        (s.bundled ? ' <span class="dtag">bundled</span>' : "") +
        "</b><p>" +
        esc(s.detail || "") +
        "</p></div>" +
        (s.bundled
          ? ""
          : '<button class="mcpx" data-name="' + esc(s.name) + '" title="Remove">✕</button>') +
        "</div>";
    });
    body += '</div><button class="pickrow mcpadd">＋ Add MCP server…</button>';
    const mo = openModal("MCP servers", body);
    mo.querySelector(".mcpadd").onclick = function () {
      vscode.postMessage({ type: "addMcp" });
    };
    [...mo.querySelectorAll(".mcpx")].forEach(function (b) {
      b.onclick = function () {
        vscode.postMessage({ type: "removeMcp", name: b.dataset.name });
      };
    });
  }
  // ---- generic centered modal ----
  let modal = null;
  function closeModal() {
    if (modal) {
      modal.remove();
      modal = null;
    }
  }
  function openModal(title, bodyHtml) {
    if (!modal) {
      const bd = document.createElement("div");
      bd.className = "modal-backdrop";
      bd.appendChild(document.createElement("div")).className = "modal";
      document.body.appendChild(bd);
      modal = bd;
      bd.onclick = (e) => {
        if (e.target === modal) closeModal();
      };
    }
    const mo = modal.querySelector(".modal");
    mo.innerHTML =
      '<div class="modal-head"><h3></h3><button class="modal-close" title="Close">✕</button></div>' +
      bodyHtml;
    mo.querySelector("h3").textContent = title;
    mo.querySelector(".modal-close").onclick = closeModal;
    return mo;
  }
  function renderAgentPicker(list, saved) {
    let body = '<div class="picklist">';
    if (!list || !list.length) body += '<div class="udesc">No subagents found.</div>';
    (list || []).forEach(function (ag) {
      body +=
        '<button class="pickrow' +
        (ag.name === saved ? " saved" : "") +
        '" data-agent="' +
        esc(ag.name) +
        '"><span class="aname">' +
        esc(ag.name) +
        '</span><span class="amodel">' +
        esc((ag.model || "default").replace(/^bynara\//, "")) +
        "</span></button>";
    });
    body += "</div>";
    const mo = openModal("Set subagent model", body);
    [...mo.querySelectorAll(".pickrow")].forEach(
      (b) => (b.onclick = () => renderModelPicker(b.dataset.agent)),
    );
  }
  function renderModelPicker(agent) {
    let body = '<div class="picklist">';
    modelOpts.forEach(function (o) {
      body +=
        '<button class="pickrow modelrow" data-id="' +
        esc(o.id) +
        '">' +
        provIcon(o.id) +
        "<span>" +
        esc(o.name) +
        "</span></button>";
    });
    body += "</div>";
    const mo = openModal("Model for " + agent, body);
    [...mo.querySelectorAll(".pickrow")].forEach(
      (b) =>
        (b.onclick = () => {
          // Save, then go back to the agent list (re-rendered with the new model) —
          // the modal stays open so you can set several agents in a row.
          vscode.postMessage({
            type: "setAgentModel",
            name: agent,
            model: "bynara/" + b.dataset.id,
          });
        }),
    );
  }
  function openUsageModal(bodyHtml) {
    openModal("Account & Usage", bodyHtml);
  }
  function rows(pairs) {
    return pairs
      .map(
        (kv) =>
          '<div class="urow"><span class="uk">' +
          kv[0] +
          '</span><span class="uv">' +
          esc(String(kv[1])) +
          "</span></div>",
      )
      .join("");
  }
  function renderUsage(r) {
    if (!r || !r.ok) {
      const why =
        r && r.error === "not-signed-in"
          ? "Not signed in."
          : "Usage unavailable" + (r && r.error ? " (" + esc(r.error) + ")" : "") + ".";
      openUsageModal('<div class="udesc">' + why + "</div>");
      return;
    }
    const s = r.data || {},
      a = s.account || {},
      c = s.credit || {},
      q = s.quota || {},
      u = s.usage || {};
    const num = (n) => (n || 0).toLocaleString();
    let quota = '<div class="udesc">fair-use (no hard limit)</div>';
    if (q.limit > 0) {
      const used = Math.max(0, q.limit - (q.remaining || 0));
      const pct = Math.min(100, Math.round((used / q.limit) * 100));
      const cls = pct >= 90 ? " crit" : pct >= 75 ? " warn" : "";
      quota =
        '<div class="bar-label"><span>' +
        num(used) +
        " / " +
        num(q.limit) +
        " " +
        esc(q.unit || "tokens") +
        "</span><span>" +
        pct +
        "%</span></div>" +
        '<div class="bar"><div class="bar-fill' +
        cls +
        '" style="width:' +
        pct +
        '%"></div></div>';
    }
    openUsageModal(
      '<div class="modal-sec">Account</div>' +
        rows([
          ["Email", a.email || "—"],
          ["Plan", a.plan || "—"],
          [
            "Credit",
            "Rp " +
              Math.round(c.available || 0).toLocaleString() +
              (c.usd_equivalent ? " / $" + c.usd_equivalent : ""),
          ],
        ]) +
        '<div class="modal-sec">Quota</div>' +
        quota +
        '<div class="modal-sec">Usage</div>' +
        rows([
          ["Tokens today", num(u.tokens_today)],
          ["Tokens month", num(u.tokens_month)],
          ["Requests today", num(u.requests_today)],
          [
            "Success rate",
            typeof u.success_rate === "number" ? Math.round(u.success_rate * 100) + "%" : "—",
          ],
        ]),
    );
  }

  sendBtn.onclick = function () {
    if (streaming) stopRun();
    else send();
  };
  function stopRun() {
    if (doneTimer) {
      clearTimeout(doneTimer);
      doneTimer = null;
    }
    vscode.postMessage({ type: "stop" });
    setStreaming(false);
    clearThinking();
  }
  function sendFollowup() {
    const t = input.value.trim();
    if (!t) return;
    fresh();
    const u = document.createElement("div");
    u.className = "umsg";
    u.textContent = t;
    log.appendChild(u);
    input.value = "";
    resize();
    scroll();
    vscode.postMessage({ type: "followup", text: t });
  }
  document.getElementById("slashbtn").onclick = function (e) {
    e.stopPropagation();
    openPalette();
  };
  document.getElementById("new").onclick = function () {
    vscode.postMessage({ type: "newChat" });
    empty = true;
    curText = null;
    curRaw = "";
    setStreaming(false);
    welcome();
  };
  input.addEventListener("input", function () {
    resize();
    showMentions();
    showCmds();
  });
  input.addEventListener("keydown", function (e) {
    if (menu.style.display === "block") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        mIdx = (mIdx + 1) % mEntries.length;
        paintMenu();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        mIdx = (mIdx - 1 + mEntries.length) % mEntries.length;
        paintMenu();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickMention(mIdx);
        return;
      }
      if (e.key === "Escape") {
        menu.style.display = "none";
        return;
      }
    }
    if (cmdMenu.classList.contains("open") && cEntries.length) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        cIdx = (cIdx + 1) % cEntries.length;
        paintCmds();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        cIdx = (cIdx - 1 + cEntries.length) % cEntries.length;
        paintCmds();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickCmd(cIdx);
        return;
      }
      if (e.key === "Escape") {
        cmdMenu.classList.remove("open");
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (streaming) sendFollowup();
      else send();
    }
  });

  const modeSel = document.getElementById("mode");
  const effortSel = document.getElementById("effort");
  const modelSel = document.getElementById("model");
  let modelProvider = "bynara";

  // ---- consolidated Mode + Effort popup (Claude-style) ----
  const modeTrig = document.getElementById("modetrig");
  const modeMenu = document.getElementById("modemenu");
  const modeName = document.getElementById("modename");
  const modeIco = document.getElementById("modeico");
  const effortRange = document.getElementById("effortrange");
  const effortVal = document.getElementById("effortval");
  const cavemanRange = document.getElementById("cavemanrange");
  const cavemanVal = document.getElementById("cavemanval");
  const CAVE_LEVELS = ["off", "lite", "full", "ultra"];
  function cap(s) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  const MODE_ICON = {}; // pull each mode's SVG from the server-rendered rows
  [...modeMenu.querySelectorAll(".mm-row")].forEach((r) => {
    MODE_ICON[r.dataset.mode] = r.querySelector(".micon").innerHTML;
  });
  const MODE_LABEL = { ask: "Ask", auto: "Auto", plan: "Plan" };
  const EFFORTS = ["low", "medium", "high"];
  function setMode(m) {
    modeSel.value = m;
    modeName.textContent = MODE_LABEL[m] || m;
    if (modeIco && MODE_ICON[m]) modeIco.innerHTML = MODE_ICON[m];
    [...modeMenu.querySelectorAll(".mm-row")].forEach((r) =>
      r.classList.toggle("active", r.dataset.mode === m),
    );
  }
  [...modeMenu.querySelectorAll(".mm-row")].forEach(
    (r) =>
      (r.onclick = () => {
        setMode(r.dataset.mode);
        modeMenu.classList.remove("open");
      }),
  );
  const spToggle = document.getElementById("sptoggle");
  let spOn = true;
  spToggle.onclick = function () {
    spOn = !spOn;
    spToggle.classList.toggle("on", spOn);
    vscode.postMessage({ type: "setSuperpowers", on: spOn });
  };
  modeTrig.onclick = function (e) {
    e.stopPropagation();
    const open = modeMenu.classList.toggle("open");
    if (open) {
      closeMenus("mode");
      anchorMenu(modeMenu, modeTrig);
      vscode.postMessage({ type: "getCaveman" });
      vscode.postMessage({ type: "getSuperpowers" });
    }
  };
  document.addEventListener("click", function (e) {
    if (!modeMenu.contains(e.target) && !modeTrig.contains(e.target))
      modeMenu.classList.remove("open");
  });
  // Compact Claude-style dot slider (discrete levels, draggable knob).
  function makeDotSlider(el, n, onChange) {
    el.innerHTML =
      '<div class="ds-track"><div class="ds-fill"></div></div>' +
      Array.from(
        { length: n },
        (_, i) =>
          '<span class="ds-dot" style="left:' + (n > 1 ? (i / (n - 1)) * 100 : 0) + '%"></span>',
      ).join("") +
      '<div class="ds-knob"></div>';
    const fill = el.querySelector(".ds-fill"),
      knob = el.querySelector(".ds-knob"),
      dots = [...el.querySelectorAll(".ds-dot")];
    let val = 0;
    function paint() {
      const pct = n > 1 ? (val / (n - 1)) * 100 : 0;
      fill.style.width = pct + "%";
      knob.style.left = pct + "%";
      dots.forEach((d, j) => d.classList.toggle("on", j <= val));
    }
    function set(i, fire) {
      const nv = Math.max(0, Math.min(n - 1, i));
      const ch = nv !== val;
      val = nv;
      paint();
      if (fire && ch) onChange(val);
    }
    function fromX(x) {
      const r = el.getBoundingClientRect();
      return Math.round(Math.max(0, Math.min(1, (x - r.left) / r.width)) * (n - 1));
    }
    el.onpointerdown = function (e) {
      el.setPointerCapture(e.pointerId);
      set(fromX(e.clientX), true);
      const mv = (ev) => set(fromX(ev.clientX), true);
      const up = () => {
        el.removeEventListener("pointermove", mv);
        el.removeEventListener("pointerup", up);
      };
      el.addEventListener("pointermove", mv);
      el.addEventListener("pointerup", up);
    };
    paint();
    return { set: (i) => set(i, false) };
  }
  const effortSlider = makeDotSlider(
    document.getElementById("effortslider"),
    EFFORTS.length,
    function (i) {
      effortSel.value = EFFORTS[i];
      effortVal.textContent = "(" + cap(EFFORTS[i]) + ")";
    },
  );
  const cavemanSlider = makeDotSlider(
    document.getElementById("cavemanslider"),
    CAVE_LEVELS.length,
    function (i) {
      cavemanVal.textContent = "(" + cap(CAVE_LEVELS[i]) + ")";
      vscode.postMessage({ type: "setCaveman", level: CAVE_LEVELS[i] });
    },
  );
  setMode(modeSel.value || "auto");
  effortSlider.set(Math.max(0, EFFORTS.indexOf(effortSel.value || "medium")));
  effortVal.textContent = "(" + cap(effortSel.value || "medium") + ")";

  // ---- + attach menu (separate from the / command palette) ----
  const plusBtn = document.getElementById("plus");
  const plusMenu = document.getElementById("plusmenu");
  const webItem = document.getElementById("webitem");
  let webOn = false;
  function closeMenus(except) {
    if (except !== "plus") plusMenu.classList.remove("open");
    if (except !== "cmd") cmdMenu.classList.remove("open");
    if (except !== "mode") modeMenu.classList.remove("open");
    if (except !== "model") modelMenu.classList.remove("open");
    if (except !== "mention") menu.style.display = "none";
  }
  function openPalette() {
    if (cmdMenu.classList.contains("open")) {
      cmdMenu.classList.remove("open");
      input.value = "";
      resize();
      return;
    }
    input.value = "/";
    input.focus();
    resize();
    showCmds();
  }
  function anchorMenu(menuEl, trigEl) {
    const tr = trigEl.getBoundingClientRect();
    const wrap = document.querySelector(".barwrap");
    const wr = wrap.getBoundingClientRect();
    const w = menuEl.offsetWidth || 260;
    let left = tr.left - wr.left;
    if (left + w > wr.width - 8) left = Math.max(8, wr.width - w - 8);
    menuEl.style.right = "auto";
    menuEl.style.left = left + "px";
    menuEl.style.bottom = wr.bottom - tr.top + 6 + "px";
  }
  plusBtn.onclick = function (e) {
    e.stopPropagation();
    const open = plusMenu.classList.toggle("open");
    if (open) {
      closeMenus("plus");
      anchorMenu(plusMenu, plusBtn);
    }
  };
  document.addEventListener("click", function (e) {
    if (!plusMenu.contains(e.target) && e.target !== plusBtn && !plusBtn.contains(e.target))
      plusMenu.classList.remove("open");
  });
  plusMenu.querySelectorAll(".pmi").forEach(function (it) {
    it.onclick = function () {
      const act = it.dataset.act;
      if (act === "upload") {
        vscode.postMessage({ type: "attach" });
        plusMenu.classList.remove("open");
      } else if (act === "context") {
        input.value = "@";
        input.focus();
        resize();
        showMentions();
        plusMenu.classList.remove("open");
      } else if (act === "web") {
        webOn = !webOn;
        webItem.classList.toggle("on", webOn);
        plusBtn.classList.toggle("on", webOn);
      }
    };
  });

  // ---- model dropdown with provider brand icons ----
  const modelTrig = document.getElementById("modeltrig");
  const modelMenu = document.getElementById("modelmenu");
  const modelTrigIco = document.getElementById("modeltrigico");
  const modelTrigName = modelTrig.querySelector(".mname");
  let modelOpts = [];
  let defaultId = "";

  const LOGO_BASE = (window.__bynara && window.__bynara.logos) || "";
  function logoFile(id) {
    id = (id || "").toLowerCase();
    if (/claude|opus|sonnet|haiku|anthropic/.test(id)) return "anthropic.svg";
    if (/gpt|openai|o1|o3|o4/.test(id)) return "openai.svg";
    if (/gemini/.test(id)) return "gemini.svg";
    if (/deepseek/.test(id)) return "deepseek.svg";
    if (/kimi|moonshot/.test(id)) return "moonshot.svg";
    if (/mistral/.test(id)) return "mistral.png";
    if (/glm|zhipu|chatglm/.test(id)) return "zhipu.svg";
    if (/minimax/.test(id)) return "minimax.svg";
    if (/mimo|xiaomi/.test(id)) return "xiaomi.svg";
    if (/qwen|qwq/.test(id)) return "qwen.svg";
    if (/llama|meta/.test(id)) return "llama.svg";
    if (/bynara/.test(id)) return "bynara.svg";
    return null;
  }
  function provIcon(id) {
    const f = logoFile(id);
    if (f && LOGO_BASE) return '<img class="logo" src="' + LOGO_BASE + "/" + f + '" alt="">';
    const L = ((id && id[0]) || "?").toUpperCase();
    return (
      '<svg viewBox="0 0 16 16" width="16" height="16"><rect width="16" height="16" rx="4" fill="#888"/><text x="8" y="11.4" text-anchor="middle" font-size="8.5" font-weight="700" fill="#fff" font-family="sans-serif">' +
      L +
      "</text></svg>"
    );
  }
  function setModel(id) {
    modelSel.value = id;
    const opt = modelOpts.find(function (o) {
      return o.id === id;
    });
    modelTrigName.textContent = opt ? opt.name : modelOpts[0] ? modelOpts[0].name : "—";
    modelTrigIco.innerHTML = provIcon(opt ? opt.id : modelOpts[0] ? modelOpts[0].id : "");
    buildModelMenu();
  }
  function buildModelMenu() {
    modelMenu.innerHTML =
      modelOpts
        .map(function (o) {
          return (
            '<div class="mmi' +
            (o.id === modelSel.value ? " sel" : "") +
            '" data-id="' +
            esc(o.id) +
            '">' +
            provIcon(o.id) +
            '<span class="mname">' +
            esc(o.name) +
            "</span>" +
            (o.id === defaultId ? '<span class="dtag">default</span>' : "") +
            "</div>"
          );
        })
        .join("") +
      '<div class="mmi mmi-custom" data-custom="1"><span class="mname">＋ Custom model…</span></div>';
    [...modelMenu.querySelectorAll(".mmi")].forEach(function (el) {
      el.onclick = function () {
        modelMenu.classList.remove("open");
        if (el.dataset.custom) {
          vscode.postMessage({ type: "customModel" });
          return;
        }
        setModel(el.dataset.id);
      };
    });
  }
  modelTrig.onclick = function (e) {
    e.stopPropagation();
    const open = modelMenu.classList.toggle("open");
    if (!open) return;
    closeMenus("model");
    const tr = modelTrig.getBoundingClientRect();
    const wrap = document.querySelector(".barwrap");
    const wr = wrap.getBoundingClientRect();
    const menuW = Math.max(240, modelMenu.offsetWidth);
    let left = tr.left - wr.left;
    if (left + menuW > wr.width - 8) left = Math.max(8, wr.width - menuW - 8);
    modelMenu.style.right = "auto";
    modelMenu.style.left = left + "px";
    modelMenu.style.bottom = wr.bottom - tr.top + 6 + "px";
  };
  document.addEventListener("click", function (e) {
    if (!modelMenu.contains(e.target) && !modelTrig.contains(e.target))
      modelMenu.classList.remove("open");
  });
  document.addEventListener("click", function (e) {
    if (!cmdMenu.contains(e.target) && e.target !== input) cmdMenu.classList.remove("open");
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (modal) closeModal();
      else closeAsk();
    }
  });

  // ---- ask_user: tabbed centered modal (Claude-style). bynara streams questions
  // one at a time, so tabs accumulate as each arrives; answered tabs stay switchable.
  let askEl = null,
    askQs = [],
    askActive = 0,
    askBatch = null,
    bActive = 0;
  function closeAsk() {
    if (askEl) {
      askEl.remove();
      askEl = null;
      askQs = [];
      askActive = 0;
      askBatch = null;
      bActive = 0;
    }
  }
  // Batch picker (the `ask_user` tool sends all questions at once): tabs upfront,
  // single/multi-select, one Submit that returns a JSON array of answers.
  function bAnswered(q) {
    return q.options
      ? q.multiSelect
        ? q.answer.length > 0
        : q.answer != null
      : q.answer != null && q.answer !== "";
  }
  function renderAskMulti(id, questions) {
    ensureAsk();
    clearThinking();
    askQs = [];
    askBatch = {
      id,
      qs: (questions || []).map(function (q) {
        return {
          question: q.question || "",
          header: q.header || "",
          options: Array.isArray(q.options) && q.options.length ? q.options : null,
          multiSelect: !!q.multiSelect,
          answer: q.multiSelect ? [] : null,
        };
      }),
    };
    bActive = 0;
    paintBatch();
  }
  function paintBatch() {
    if (!askEl || !askBatch) return;
    const mo = askEl.querySelector(".modal"),
      tabs = mo.querySelector(".ask-tabs"),
      body = mo.querySelector(".ask-body");
    tabs.innerHTML = askBatch.qs
      .map(function (q, i) {
        return (
          '<button class="ask-tab' +
          (i === bActive ? " active" : "") +
          '" data-i="' +
          i +
          '">' +
          (bAnswered(q) ? '<span class="tk">✓</span>' : "") +
          (q.header ? esc(q.header) : "Q" + (i + 1)) +
          "</button>"
        );
      })
      .join("");
    [...tabs.querySelectorAll(".ask-tab")].forEach(function (t) {
      t.onclick = function () {
        bActive = +t.dataset.i;
        paintBatch();
      };
    });
    const q = askBatch.qs[bActive];
    let h =
      '<div class="ask-q">' +
      esc(q.question) +
      (q.multiSelect ? ' <span class="ask-hint">(pick one or more)</span>' : "") +
      "</div>";
    if (q.options) {
      h +=
        '<div class="qopts">' +
        q.options
          .map(function (o) {
            const sel = q.multiSelect ? q.answer.indexOf(o) >= 0 : q.answer === o;
            return (
              '<button class="askopt' +
              (sel ? " sel" : "") +
              '" data-o="' +
              esc(o) +
              '"><span class="ind ' +
              (q.multiSelect ? "ck" : "rd") +
              '"></span><span class="askopt-l">' +
              esc(o) +
              "</span></button>"
            );
          })
          .join("") +
        "</div>";
    } else {
      h +=
        '<div class="qrow"><input class="ask-input" placeholder="Type your answer…" value="' +
        esc(q.answer || "") +
        '"></div>';
    }
    const all = askBatch.qs.every(bAnswered);
    h +=
      '<div class="ask-foot"><button class="ask-submit"' +
      (all ? "" : " disabled") +
      ">Submit answers</button></div>";
    body.innerHTML = h;
    if (q.options) {
      [...body.querySelectorAll(".askopt")].forEach(function (b) {
        b.onclick = function () {
          const o = b.dataset.o;
          // Click = SELECT only (no auto-advance); user submits or switches tabs.
          if (q.multiSelect) {
            const k = q.answer.indexOf(o);
            if (k >= 0) q.answer.splice(k, 1);
            else q.answer.push(o);
          } else {
            q.answer = o;
          }
          paintBatch();
        };
      });
    } else {
      const inp = body.querySelector(".ask-input");
      inp.oninput = function () {
        q.answer = inp.value;
      };
      inp.focus();
    }
    body.querySelector(".ask-submit").onclick = function () {
      if (!askBatch.qs.every(bAnswered)) return;
      const ans = askBatch.qs.map(function (q) {
        return q.options ? q.answer : q.answer || "";
      });
      const rid = askBatch.id;
      vscode.postMessage({ type: "uiResponse", id: rid, value: JSON.stringify(ans) });
      closeAsk();
    };
  }
  function ensureAsk() {
    if (askEl) return;
    const bd = document.createElement("div");
    bd.className = "modal-backdrop";
    const mo = document.createElement("div");
    mo.className = "modal askmodal";
    mo.innerHTML =
      '<div class="modal-head"><div class="ask-tabs"></div><button class="modal-close" title="Close">✕</button></div><div class="ask-body"></div>';
    mo.querySelector(".modal-close").onclick = closeAsk;
    bd.appendChild(mo);
    document.body.appendChild(bd);
    askEl = bd;
  }
  function addAsk(q) {
    ensureAsk();
    clearThinking();
    askQs.push(q);
    askActive = askQs.length - 1;
    renderAsk();
  }
  function answerSent(q) {
    vscode.postMessage({ type: "uiResponse", id: q.id, value: q.answer });
  }
  function renderAsk() {
    if (!askEl) return;
    const mo = askEl.querySelector(".modal");
    const tabs = mo.querySelector(".ask-tabs");
    tabs.innerHTML = askQs
      .map(function (q, i) {
        return (
          '<button class="ask-tab' +
          (i === askActive ? " active" : "") +
          '" data-i="' +
          i +
          '">' +
          (q.answer != null ? '<span class="tk">✓</span>' : "") +
          "Q" +
          (i + 1) +
          "</button>"
        );
      })
      .join("");
    [...tabs.querySelectorAll(".ask-tab")].forEach(function (t) {
      t.onclick = function () {
        askActive = +t.dataset.i;
        renderAsk();
      };
    });
    const q = askQs[askActive];
    const body = mo.querySelector(".ask-body");
    let h = '<div class="ask-q">' + esc(q.title || "") + "</div>";
    if (q.type === "input") {
      h +=
        '<div class="qrow"><input class="ask-input" placeholder="' +
        esc(q.placeholder || "Type your answer…") +
        '"' +
        (q.answer != null ? ' value="' + esc(q.answer) + '" disabled' : "") +
        '><button class="ask-send">Send</button></div>';
      body.innerHTML = h;
      if (q.answer == null) {
        const inp = body.querySelector(".ask-input"),
          snd = body.querySelector(".ask-send");
        const sub = function () {
          if (q.answer != null) return;
          q.answer = inp.value;
          answerSent(q);
          renderAsk();
        };
        snd.onclick = sub;
        inp.addEventListener("keydown", function (e) {
          if (e.key === "Enter") {
            e.preventDefault();
            sub();
          }
        });
        inp.focus();
      }
    } else {
      h +=
        '<div class="qopts">' +
        (q.options || [])
          .map(function (o) {
            return (
              '<button class="qbtn' +
              (q.answer === o ? " chosen" : "") +
              '"' +
              (q.answer != null ? " disabled" : "") +
              ">" +
              esc(o) +
              "</button>"
            );
          })
          .join("") +
        "</div>";
      body.innerHTML = h;
      if (q.answer == null) {
        [...body.querySelectorAll(".qbtn")].forEach(function (b, idx) {
          b.onclick = function () {
            if (q.answer != null) return;
            q.answer = q.options[idx];
            answerSent(q);
            renderAsk();
          };
        });
      }
    }
  }

  window.addEventListener("message", function (e) {
    const m = e.data;
    // Any sign of ongoing work re-arms the busy pill and cancels a pending "done"
    // — the engine emits agent_end (chatDone) after EVERY tool round, not just the
    // final one, so without this the pill/stop-button flickers off mid-task.
    if (
      m.type === "chatDelta" ||
      m.type === "chatReason" ||
      m.type === "toolStart" ||
      m.type === "toolEnd"
    ) {
      if (doneTimer) {
        clearTimeout(doneTimer);
        doneTimer = null;
      }
      if (!streaming) setStreaming(true);
    }
    if (m.type === "chatDelta") {
      clearThinking();
      // Answer started — close the live reasoning stream but KEEP it visible
      // (distinct dim block above the answer). User can fold it via its header.
      const lr = log.querySelector(".reason.live");
      if (lr) lr.classList.remove("live");
      if (!curText) {
        curText = newText();
        curRaw = "";
      }
      curRaw += m.delta;
      render(curText, curRaw);
      scroll();
    } else if (m.type === "chatReason") {
      clearThinking();
      let r = log.querySelector(".reason.live");
      if (!r) {
        fresh();
        r = document.createElement("div");
        r.className = "reason live";
        r.dataset.raw = "";
        r.innerHTML = '<div class="rhead">💭 Thinking</div><div class="rbody"></div>';
        r.querySelector(".rhead").onclick = function () {
          r.classList.toggle("collapsed");
        };
        log.appendChild(r);
      }
      r.dataset.raw += m.delta;
      r.querySelector(".rbody").textContent = r.dataset.raw;
      scroll();
    } else if (m.type === "toolStart") {
      if (m.name === "ask_user") {
        askTools[m.id] = 1;
      } else if (m.name === "todo") {
        todoIds[m.id] = 1;
      } else startTool(m.id, m.name, m.summary);
    } else if (m.type === "toolEnd") {
      if (askTools[m.id]) {
        delete askTools[m.id];
        return;
      } // ask_user is rendered as an inline question card, not a tool step
      if (todoIds[m.id]) {
        delete todoIds[m.id];
        renderTodo(m.result);
        return;
      } // todo -> single live checklist
      const step = tools[m.id] || startTool(m.id, "tool", "");
      const dot = step.querySelector(".dot");
      dot.className = "dot " + (m.isError ? "err" : "ok");
      step.querySelector(".ststate").textContent = m.isError ? "error" : "done";
      if (m.result) step.querySelector(".tout").textContent = m.result;
      scroll();
    } else if (m.type === "toolImage") {
      const step = tools[m.id];
      if (step && m.src) {
        const o = step.querySelector(".tout");
        const img = document.createElement("img");
        img.className = "toolimg";
        img.src = m.src;
        o.appendChild(img);
        o.style.display = "block";
        scroll();
      }
    } else if (m.type === "chatDone") {
      // Don't go idle immediately — agent_end fires per tool round. Wait a beat;
      // if new activity arrives (handled above) this timer is cancelled and we
      // stay busy. Only a real, sustained stop finalizes the turn.
      const live = log.querySelector(".reason.live");
      if (live) live.classList.remove("live"); // keep visible; user folds manually
      if (doneTimer) clearTimeout(doneTimer);
      doneTimer = setTimeout(function () {
        doneTimer = null;
        setStreaming(false);
        clearThinking();
        closeAsk();
      }, 1500);
    } else if (m.type === "chatError") {
      if (doneTimer) {
        clearTimeout(doneTimer);
        doneTimer = null;
      }
      clearThinking();
      fresh();
      closeAsk();
      const d = document.createElement("div");
      d.className = "errline";
      d.textContent = "error: " + m.error;
      log.appendChild(d);
      setStreaming(false);
    } else if (m.type === "reset") {
      empty = true;
      curText = null;
      curRaw = "";
      setStreaming(false);
      closeAsk();
      welcome();
    } else if (m.type === "files") {
      files = m.list || [];
      // If the mention menu is open, re-render it with the fresh list.
      if (menu.style.display === "block") showMentions();
    } else if (m.type === "models") {
      modelProvider = m.provider || "bynara";
      const prev = modelSel.value;
      modelOpts = (m.models || []).map(function (x) {
        return { id: x.id, name: x.name, reasoning: x.reasoning };
      });
      defaultId = m.default || (modelOpts[0] && modelOpts[0].id) || "";
      modelSel.innerHTML = modelOpts
        .map(function (o) {
          return '<option value="' + esc(o.id) + '">' + esc(o.name) + "</option>";
        })
        .join("");
      setModel(
        prev &&
          modelOpts.some(function (o) {
            return o.id === prev;
          })
          ? prev
          : defaultId,
      );
    } else if (m.type === "askMulti") {
      renderAskMulti(m.id, m.questions || []);
    } else if (m.type === "uiSelect") {
      addAsk({ id: m.id, type: "select", title: m.title, options: m.options || [], answer: null });
    } else if (m.type === "uiInput") {
      addAsk({
        id: m.id,
        type: "input",
        title: m.title,
        placeholder: m.placeholder || "",
        answer: null,
      });
    } else if (m.type === "commands") {
      cmds = m.list || [];
      if (slashQuery()) showCmds();
    } else if (m.type === "pickModel" && m.id) {
      if (
        !modelOpts.some(function (o) {
          return o.id === m.id;
        })
      ) {
        modelOpts.push({ id: m.id, name: m.id, reasoning: true });
        modelSel.innerHTML = modelOpts
          .map(function (o) {
            return '<option value="' + esc(o.id) + '">' + esc(o.name) + "</option>";
          })
          .join("");
      }
      setModel(m.id);
    } else if (m.type === "agents") {
      renderAgentPicker(m.list || [], m.saved);
    } else if (m.type === "mcp") {
      renderMcpModal(m.list || []);
    } else if (m.type === "caveman") {
      const i = CAVE_LEVELS.indexOf(m.level || "off");
      cavemanSlider.set(i < 0 ? 0 : i);
      cavemanVal.textContent = "(" + cap(m.level || "off") + ")";
    } else if (m.type === "superpowers") {
      spOn = !!m.on;
      spToggle.classList.toggle("on", spOn);
    } else if (m.type === "usage") {
      renderUsage(m.result);
    } else if (m.type === "attachPaths") {
      const v = input.value;
      const refs = (m.paths || []).map((p) => "@" + p).join(" ");
      input.value = v + (v && !v.endsWith(" ") ? " " : "") + refs + " ";
      input.focus();
      resize();
    } else if (m.type === "transcript") {
      empty = true;
      curText = null;
      curRaw = "";
      log.innerHTML = "";
      todoPanel = null;
      for (const x of m.messages || []) {
        if (x.role === "user") {
          fresh();
          const u = document.createElement("div");
          u.className = "umsg";
          u.textContent = x.text;
          log.appendChild(u);
        } else {
          const b = newText();
          render(b, x.text);
        }
      }
      if (!(m.messages || []).length) welcome();
    }
  });

  welcome();
  vscode.postMessage({ type: "listFiles" });
  vscode.postMessage({ type: "listModels" });
})();
