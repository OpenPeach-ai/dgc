(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments"), pop = $("pop");
  const queuedEl = $("queued");
  let queuedCount = 0, customCommands = [];
  function renderQueued() { queuedEl.textContent = queuedCount > 0 ? `${queuedCount} queued` : ""; }

  // permission modes — codicon glyph, one-liner (matches the CLI's mode ladder)
  const MODES = {
    default:     { icon: "shield",    desc: "ask before edits & commands" },
    acceptEdits: { icon: "edit",      desc: "auto-approve file edits" },
    plan:        { icon: "checklist", desc: "read-only — plan first" },
    auto:        { icon: "zap",       desc: "approve everything" },
  };
  const MODE_ORDER = ["default", "acceptEdits", "plan", "auto"];
  const THINK = ["off", "low", "medium", "high"];
  let curMode = "default", curThink = "off", curModel = "";
  let lastConfig = null, settingsProviders = [];

  function applyMode(m) {
    if (!MODES[m]) return;
    curMode = m;
    $("cbox").dataset.mode = m; send.dataset.mode = m;
    $("modeicon").className = "codicon codicon-" + MODES[m].icon; $("modelabel").textContent = m;
    $("btn-mode").title = MODES[m].desc + " — Shift+Tab to cycle";
  }
  function setMode(m) { applyMode(m); vscode.postMessage({ type: "setMode", mode: m }); hideModeMenu(); }
  function cycleMode() { setMode(MODE_ORDER[(MODE_ORDER.indexOf(curMode) + 1) % MODE_ORDER.length]); }
  function hideModeMenu() { $("modemenu").hidden = true; }
  function toggleModeMenu() {
    const mm = $("modemenu");
    if (!mm.hidden) { mm.hidden = true; return; }
    hideModelMenu();
    mm.innerHTML =
      `<div class="mhead"><span>Permission mode</span><kbd>⇧Tab</kbd></div>` +
      MODE_ORDER.map((m) => `<div class="mrow${m === curMode ? " sel" : ""}" data-mode="${m}"><span class="mi codicon codicon-${MODES[m].icon}"></span><span>${m}</span><span class="md">${MODES[m].desc}</span></div>`).join("") +
      `<div class="mdiv"></div><div class="mhead"><span>Thinking</span></div>` +
      THINK.map((t) => `<div class="mrow${t === curThink ? " sel" : ""}" data-think="${t}"><span class="mi codicon codicon-lightbulb"></span><span>${t}</span></div>`).join("");
    mm.querySelectorAll("[data-mode]").forEach((r) => r.onclick = () => setMode(r.dataset.mode));
    mm.querySelectorAll("[data-think]").forEach((r) => r.onclick = () => { curThink = r.dataset.think; vscode.postMessage({ type: "setThink", level: curThink }); hideModeMenu(); });
    mm.hidden = false;
  }

  // in-composer model menu (rendered from the `models` message the extension posts)
  function hideModelMenu() { $("modelmenu").hidden = true; }
  function renderModelMenu(ids, current, err) {
    const mm = $("modelmenu");
    if (err || !ids.length) {
      mm.innerHTML = `<div class="mrow" data-connect="1"><span class="mi codicon codicon-plug"></span><span>${err ? "Can’t reach endpoint — connect…" : "No models — connect…"}</span></div>`;
      mm.querySelector("[data-connect]").onclick = () => { vscode.postMessage({ type: "connect" }); hideModelMenu(); };
      mm.hidden = false; return;
    }
    mm.innerHTML = `<div class="mhead"><span>Model</span></div>` +
      ids.map((id, i) => `<div class="mrow${id === current ? " sel" : ""}" data-i="${i}"><span class="mi ${id === current ? "codicon codicon-check" : ""}"></span><span>${esc(id)}</span></div>`).join("");
    mm.querySelectorAll("[data-i]").forEach((r) => r.onclick = () => { vscode.postMessage({ type: "setModel", model: ids[+r.dataset.i] }); hideModelMenu(); });
    mm.hidden = false;
  }

  // animated DGC mark — the three stripes light up one-by-one, hold all three,
  // then repeat (CSS-driven, ~1.2s loop, single purple). Replaces the old braille
  // spinner; the reduced-motion case (in main.css) renders all three lit + static.
  const MARK = '<svg class="tmark" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true">'
    + '<path class="s1" d="M24 32 L30 20 L72 13 L66 25 Z"/>'
    + '<path class="s2" d="M18 54 L24 42 L72 35 L66 47 Z"/>'
    + '<path class="s3" d="M24 76 L30 64 L66 57 L60 69 Z"/></svg>';
  // per-tool glyph — the CLI's set: → read · ✎ write/edit · $ shell · ✱ search · ▸ other
  const GLYPH = {
    read_file: "→", glob: "→",
    write_file: "✎", edit_file: "✎", save_memory: "✎",
    bash: "$", bash_output: "$", bash_kill: "$",
    grep: "✱", web_search: "✱", web_fetch: "✱",
    present_plan: "▸", task: "▸", todo: "▸", skill: "▸",
  };
  const glyphFor = (name) => GLYPH[name] || "▸";
  const SLASH = [
    ["/model", "pick the model", "pickModel"], ["/connect", "connect a provider", "connect"],
    ["/mode", "permission mode", "pickMode"], ["/think", "thinking level", "pickThink"],
    ["/resume", "resume a past session", "resume"], ["/new", "new session", "new"],
    ["/compact", "summarize context now", "compact"], ["/clear", "clear the view", "clear"],
  ];

  let streaming = false, turn = null;
  const attachments = [];
  let files = [];              // workspace files for @-mentions
  let popMode = null, popItems = [], popIdx = 0, popStart = 0;

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  // minimal, streaming-safe markdown
  function md(s) {
    s = esc(s);
    s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (m, l, code) =>
      `<pre class="code"><button class="copy" data-c="${encodeURIComponent(code)}">copy</button><code>${code}</code></pre>`);
    s = s.replace(/^#{1,6}\s+(.*)$/gm, "<b>$1</b>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
    s = s.replace(/^[-*]\s+(.*)$/gm, "• $1");
    return s;
  }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
  function scroll() { log.scrollTop = log.scrollHeight; }

  // ---- turn lifecycle ----
  function startTurn() {
    const block = el("div", "msg dgc"); block.appendChild(el("div", "role dgc", "DGC"));
    const act = el("div", "thinking", `<span class="spin">${MARK}</span> <span class="verb">working…</span> <span class="meta"></span>`);
    block.appendChild(act); log.appendChild(block);
    const t0 = Date.now(), meta = act.querySelector(".meta");
    turn = { block, act, t0, chars: 0, textEl: null, reasonEl: null, _buf: "" };
    turn.timer = setInterval(() => {
      meta.textContent = `(${Math.floor((Date.now() - t0) / 1000)}s · ↓ ${Math.round(turn.chars / 4)} tok)`;
    }, 200);
    scroll();
  }
  function endTurn() {
    if (!turn) return;
    clearInterval(turn.timer);
    turn.act.classList.add("done");
    turn.act.innerHTML = `▸ worked for ${Math.floor((Date.now() - turn.t0) / 1000)}s · ↓ ${Math.round(turn.chars / 4)} tok`;
    turn = null;
  }
  function ensureTurn() { if (!turn) startTurn(); }
  function textBlock() { if (!turn.textEl) { turn.textEl = el("div", "text"); turn.block.appendChild(turn.textEl); } return turn.textEl; }
  function breakText() { if (turn) { turn.textEl = null; turn._buf = ""; } }

  function openFileBtn(path, line) { const b = el("button", "link", "⤢ open"); b.onclick = () => vscode.postMessage({ type: "openFile", path, line }); return b; }

  function toolCard(ev) {
    const c = el("div", "tool");
    c.innerHTML = `<div class="head"><span class="glyph">${glyphFor(ev.name)}</span><span class="verb">${esc(ev.name)}</span><span class="arg">${esc(ev.summary || "")}</span></div><div class="body"><pre></pre></div>`;
    const head = c.querySelector(".head");
    head.onclick = () => c.classList.toggle("open");
    if (["read_file", "write_file", "edit_file"].includes(ev.name) && ev.summary) head.appendChild(openFileBtn(ev.summary));
    head.appendChild(el("span", "dot run"));
    head.appendChild(el("span", "badge"));
    turn.block.appendChild(c); breakText(); scroll(); return c;
  }
  function renderDiff(diff) {
    const wrap = el("div", "diff");
    const path = (diff.match(/\+\+\+ b\/(.+)/) || [, "changed file"])[1].replace(/^\/+/, "");
    const body = diff.split("\n").map((l) => {
      const cls = l.startsWith("+") && !l.startsWith("+++") ? "add"
        : l.startsWith("-") && !l.startsWith("---") ? "del"
          : (l.startsWith("@@") || l.startsWith("---") || l.startsWith("+++")) ? "hh" : "ctx";
      return `<span class="${cls}">${esc(l) || " "}</span>`;
    }).join("");
    wrap.innerHTML = `<div class="dhead"><span class="dg">✎</span><span class="f">${esc(path)}</span></div><pre>${body}</pre>`;
    wrap.querySelector(".dhead").appendChild(openFileBtn(path));
    return wrap;
  }
  function decisionCard(inner) { const c = el("div", "card"); c.innerHTML = inner; (turn ? turn.block : log).appendChild(c); breakText(); scroll(); return c; }
  function resolveCard(c) { c.classList.add("resolved"); }
  function sysLine(msg, isErr) { (turn ? turn.block : log).appendChild(el("div", "sys" + (isErr ? " err" : ""), esc(msg))); scroll(); }

  function onEvent(ev) {
    const stick = atBottom();
    switch (ev.type) {
      case "ready": customCommands = ev.commands || []; break;
      case "context": {
        const pct = ev.size ? Math.min(100, Math.round((ev.used / ev.size) * 100)) : 0;
        $("ctx").textContent = pct + "%";
        $("btn-ctx").classList.toggle("warn", pct >= 85);
        break;
      }
      case "history": renderHistory(ev.items || []); break;
      case "config": lastConfig = ev; if (!$("settings").hidden) fillSettings(ev); break;
      case "turn_start": startTurn(); setSending(true); if (queuedCount > 0) { queuedCount--; renderQueued(); } break;
      case "queued": queuedCount = ev.count; renderQueued(); break;
      case "text_delta": ensureTurn(); turn.chars += ev.text.length; turn._buf = (turn._buf || "") + ev.text; textBlock().innerHTML = md(turn._buf); break;
      case "thinking_delta":
        ensureTurn(); turn.chars += ev.text.length;
        if (!turn.reasonEl) {
          const d = el("div", "disclosure", "▸ thinking"), r = el("div", "reasoning");
          d.onclick = () => { r.classList.toggle("show"); d.textContent = (r.classList.contains("show") ? "▾" : "▸") + " thinking"; };
          turn.block.appendChild(d); turn.block.appendChild(r); turn.reasonEl = r;
        }
        turn.reasonEl.textContent += ev.text; break;
      case "stream_end": breakText(); break;
      case "tool_call": ensureTurn(); turn._tools = turn._tools || {}; turn._tools[ev.call_id || ev.name] = toolCard(ev); break;
      case "tool_result": {
        ensureTurn();
        const c = (turn._tools && turn._tools[ev.call_id]) || toolCard({ name: ev.name });
        c.querySelector(".dot").className = "dot " + (ev.is_error ? "err" : "ok");
        if (ev.is_diff && ev.diff) turn.block.appendChild(renderDiff(ev.diff));
        else { const out = String(ev.output || ""); c.querySelector(".body pre").textContent = out.slice(0, 4000); c.querySelector(".badge").textContent = out.split("\n").length + " ln"; }
        breakText(); break;
      }
      case "tool_denied": { ensureTurn(); toolCard({ name: ev.name, summary: ev.reason }).querySelector(".dot").className = "dot deny"; break; }
      case "permission_request": {
        ensureTurn();
        const cmd = ev.command ? `<pre>$ ${esc(ev.command)}</pre>` : `<pre>${esc(JSON.stringify(ev.args))}</pre>`;
        const c = decisionCard(`<div class="q"><span class="codicon codicon-shield"></span> Run <b>${esc(ev.name)}</b>?</div>${cmd}<div class="btns"><button class="act primary" data-d="once">Allow once</button><button class="act" data-d="always">Always allow</button><button class="act" data-d="deny">Deny</button></div>`);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => { vscode.postMessage({ type: "permission_response", id: ev.id, decision: b.dataset.d, rule: b.dataset.d === "always" ? ev.suggested_rule : undefined }); resolveCard(c); });
        break;
      }
      case "plan_proposal": {
        ensureTurn();
        const c = decisionCard(`<div class="q"><span class="codicon codicon-checklist"></span> Plan ready</div><pre>${esc(ev.plan)}</pre><div class="btns"><button class="act primary" data-d="acceptEdits">Approve → acceptEdits</button><button class="act" data-d="auto">auto</button><button class="act" data-d="default">default</button><button class="act" data-d="reject">Keep planning</button></div>`);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => { vscode.postMessage({ type: "plan_response", id: ev.id, decision: b.dataset.d }); resolveCard(c); });
        break;
      }
      case "options_request": {
        ensureTurn();
        const btns = ev.options.map((o, i) => `<button class="act${i === 0 ? " primary" : ""}" data-i="${i + 1}">${esc(o)}</button>`).join("");
        const c = decisionCard(`<div class="q">${esc(ev.question)}</div><div class="btns">${btns}</div>`);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => { vscode.postMessage({ type: "options_response", id: ev.id, choice: Number(b.dataset.i) }); resolveCard(c); });
        break;
      }
      case "todos": {
        ensureTurn();
        if (!turn._todo) { turn._todo = el("div", "todos"); turn.block.appendChild(turn._todo); }
        turn._todo.innerHTML = ev.todos.map((t) => `<div class="t ${t.status === "in_progress" ? "doing" : ""}">${t.status === "done" ? "☑" : t.status === "in_progress" ? "◐" : "◻"} ${esc(t.content)}</div>`).join("");
        break;
      }
      case "rule_added": sysLine("＋ rule: " + ev.rule); break;
      case "info": sysLine(ev.message); break;
      case "compacted": sysLine("context compacted"); break;
      case "error": sysLine(ev.message, true); if (ev.fatal) { endTurn(); setSending(false); } break;
      case "turn_end": endTurn(); setSending(false); break;
    }
    if (stick) scroll();
  }

  // ---- composer ----
  function setSending(on) { streaming = on; send.innerHTML = `<span class="codicon codicon-${on ? "debug-stop" : "arrow-up"}"></span>`; send.title = on ? "Stop" : "Send"; }
  function doStop() { queuedCount = 0; renderQueued(); vscode.postMessage({ type: "cancel" }); }
  function submit() {
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    const textAtts = attachments.filter((a) => !a.img);
    const imgs = attachments.filter((a) => a.img).map((a) => a.data);
    const full = textAtts.map((a) => a.text).join("\n") + (textAtts.length ? "\n" : "") + text;
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    m.appendChild(el("div", "bubble", esc(text) + attachments.map((a) => `\n[${esc(a.label)}]`).join(""))); log.appendChild(m);
    vscode.postMessage({ type: "prompt", text: full, images: imgs.length ? imgs : undefined });   // backend queues it if a turn is running
    input.value = ""; input.style.height = "auto"; attachments.length = 0; renderAtts(); setSending(true); scroll();
  }
  function renderAtts() {
    atts.innerHTML = "";
    attachments.forEach((a, i) => { const chip = el("span", "chip", esc(a.label) + ' <span class="x">×</span>'); chip.querySelector(".x").onclick = () => { attachments.splice(i, 1); renderAtts(); }; atts.appendChild(chip); });
  }

  // ---- @file / slash popover ----
  function hidePop() { pop.style.display = "none"; popMode = null; }
  function showPop(items) {
    popItems = items; popIdx = 0;
    if (!items.length) return hidePop();
    pop.innerHTML = items.map((it, i) => `<div class="pi${i === 0 ? " sel" : ""}" data-i="${i}">${esc(it.label)}${it.detail ? ` <span class="pd">${esc(it.detail)}</span>` : ""}</div>`).join("");
    pop.querySelectorAll(".pi").forEach((e) => e.onclick = () => choosePop(Number(e.dataset.i)));
    pop.style.display = "block";
  }
  function movePop(d) { if (popMode) { popIdx = (popIdx + d + popItems.length) % popItems.length; [...pop.children].forEach((c, i) => c.className = "pi" + (i === popIdx ? " sel" : "")); } }
  function choosePop(i) {
    const it = popItems[i]; if (!it) return;
    if (popMode === "@") {
      attachments.push({ label: it.label, text: `<file path="${it.label}"></file>` });
      renderAtts();
      input.value = input.value.slice(0, popStart) + input.value.slice(input.selectionStart);
    } else if (popMode === "/") {
      if (it.action && it.action.indexOf("custom:") === 0) {
        input.value = it.label + " ";       // custom command — let the user add args, then Enter
        hidePop(); input.focus(); return;
      }
      input.value = "";
      vscode.postMessage({ type: "slash", action: it.action });
    }
    hidePop(); input.focus();
  }
  function onInput() {
    input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px";
    const v = input.value, caret = input.selectionStart;
    const upto = v.slice(0, caret);
    const at = upto.lastIndexOf("@"), sl = upto.startsWith("/") ? 0 : -1;
    if (sl === 0 && !/\s/.test(v)) {
      popMode = "/"; popStart = 0;
      const all = SLASH.concat(customCommands.map((c) => ["/" + c, "custom command", "custom:" + c]));
      showPop(all.filter((c) => c[0].startsWith(v)).map((c) => ({ label: c[0], detail: c[1], action: c[2] })));
    }
    else if (at !== -1 && !/\s/.test(upto.slice(at))) {
      popMode = "@"; popStart = at; const q = upto.slice(at + 1).toLowerCase();
      showPop(files.filter((f) => f.toLowerCase().includes(q)).slice(0, 8).map((f) => ({ label: f })));
      if (files.length === 0) vscode.postMessage({ type: "reqFiles" });
    } else hidePop();
  }
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", (e) => {
    if (popMode) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePop(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePop(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choosePop(popIdx); return; }
      if (e.key === "Escape") { e.preventDefault(); hidePop(); return; }
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Escape" && streaming) doStop();
  });
  input.addEventListener("paste", (e) => {                 // paste an image → attach for vision models
    const items = (e.clipboardData && e.clipboardData.items) || [];
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const file = it.getAsFile(); if (!file) continue;
        const r = new FileReader();
        r.onload = () => { attachments.push({ label: "📷 image", img: true, data: r.result, text: "" }); renderAtts(); };
        r.readAsDataURL(file);
        e.preventDefault();
      }
    }
  });
  send.onclick = () => { if (streaming) doStop(); else submit(); };
  $("btn-ctx").onclick = () => vscode.postMessage({ type: "compact" });
  $("btn-mode").onclick = (e) => { e.stopPropagation(); toggleModeMenu(); };
  $("btn-add").onclick = () => {                       // insert @ at the caret → file popover
    input.focus();
    const p = input.selectionStart;
    input.value = input.value.slice(0, p) + "@" + input.value.slice(p);
    input.selectionStart = input.selectionEnd = p + 1;
    onInput();
  };
  $("btn-cmd").onclick = () => { input.value = "/"; input.selectionStart = input.selectionEnd = 1; input.focus(); onInput(); };
  $("btn-model").onclick = (e) => {
    e.stopPropagation();
    const mm = $("modelmenu");
    if (!mm.hidden) { mm.hidden = true; return; }
    mm.innerHTML = `<div class="mhead"><span>Loading…</span></div>`;
    mm.hidden = false; hideModeMenu();
    vscode.postMessage({ type: "listModels" });
  };
  const pmodel = $("pmodel"); if (pmodel) pmodel.onclick = () => vscode.postMessage({ type: "pickModel" });
  document.addEventListener("click", (e) => {          // dismiss the picker menus on outside click
    if (!$("modemenu").hidden && !$("btn-mode").contains(e.target) && !$("modemenu").contains(e.target)) hideModeMenu();
    if (!$("modelmenu").hidden && !$("btn-model").contains(e.target) && !$("modelmenu").contains(e.target)) hideModelMenu();
  });

  // ---- settings page ----
  const SET_FIELDS = ["base_url", "api_key", "model", "subagent_model", "subagent_base_url",
    "subagent_api_key", "fallback_model", "fallback_base_url", "mode", "think", "context_size"];
  function fillSettings(cfg) {
    const map = {
      base_url: cfg.base_url, model: cfg.model, mode: cfg.mode, think: cfg.think,
      subagent_model: cfg.subagent_model, subagent_base_url: cfg.subagent_base_url,
      subagent_api_key: cfg.subagent_api_key, fallback_model: cfg.fallback_model,
      fallback_base_url: cfg.fallback_base_url, context_size: cfg.context_size,
    };
    for (const k in map) { const el = $("s-" + k); if (el && map[k] != null) el.value = map[k]; }
  }
  function openSettings(providers, models) {
    settingsProviders = providers || [];
    $("s-provider").innerHTML = `<option value="">— pick a preset —</option>` +
      settingsProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
    $("s-models").innerHTML = (models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
    if (lastConfig) fillSettings(lastConfig);
    $("settings").hidden = false;
  }
  function collectSettings() {
    const v = {};
    SET_FIELDS.forEach((k) => { const el = $("s-" + k); if (el) v[k] = el.value.trim(); });
    return v;
  }
  $("btn-settings").onclick = () => vscode.postMessage({ type: "openSettings" });
  $("set-close").onclick = () => { $("settings").hidden = true; };
  $("set-cancel").onclick = () => { $("settings").hidden = true; };
  $("set-save").onclick = () => { vscode.postMessage({ type: "saveSettings", values: collectSettings() }); $("settings").hidden = true; };
  $("s-provider").onchange = () => {
    const p = settingsProviders.find((x) => x.id === $("s-provider").value);
    if (p) { $("s-base_url").value = p.url; if (!p.needsKey && !$("s-api_key").value) $("s-api_key").value = "ollama"; }
  };

  function renderHistory(items) {
    log.innerHTML = ""; turn = null;
    items.forEach((it) => {
      if (it.role === "user") {
        const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
        m.appendChild(el("div", "bubble", esc(it.text))); log.appendChild(m);
      } else {
        const m = el("div", "msg dgc"); m.appendChild(el("div", "role dgc", "DGC"));
        if (it.text) m.appendChild(el("div", "text", md(it.text)));
        if (it.tools && it.tools.length) m.appendChild(el("div", "sys", "▸ " + it.tools.join(", ")));
        log.appendChild(m);
      }
    });
    scroll();
  }
  // copy-code (delegated)
  log.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest(".copy"); if (b) vscode.postMessage({ type: "copy", text: decodeURIComponent(b.dataset.c) }); });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "state") {
      curModel = msg.state.model || ""; curThink = msg.state.think || "off";
      $("modelname").textContent = curModel || "dgc";
      $("btn-model").title = "Model: " + (curModel || "dgc") + " — click to change";
      if (pmodel) { pmodel.textContent = curModel || "dgc"; pmodel.title = "Model: " + (curModel || "dgc") + " — click to change"; }
      applyMode(msg.state.mode || "default");
    }
    else if (msg.type === "models") { renderModelMenu(msg.ids || [], msg.current, msg.err); }
    else if (msg.type === "settings_open") { openSettings(msg.providers, msg.models); }
    else if (msg.type === "cleared") { log.innerHTML = ""; turn = null; setSending(false); }
    else if (msg.type === "attach") { attachments.push({ label: msg.label, text: msg.text }); renderAtts(); }
    else if (msg.type === "files") { files = msg.files || []; if (popMode === "@") onInput(); }
    else if (msg.type === "backend_exit") { sysLine("dgc backend exited" + (msg.code ? " (code " + msg.code + ")" : ""), true); setSending(false); }
  });
})();
