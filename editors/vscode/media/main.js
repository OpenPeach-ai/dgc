(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments"), pop = $("pop");

  const GLYPHS = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];
  const VERBS = ["Ideating", "Percolating", "Ruminating", "Conjuring", "Noodling", "Marinating",
    "Untangling", "Composing", "Simmering", "Cogitating", "Wrangling", "Distilling"];
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
    const act = el("div", "thinking", `<span class="spin">·</span> <span class="verb"></span> <span class="meta"></span>`);
    block.appendChild(act); log.appendChild(block);
    const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    act.querySelector(".verb").textContent = verb + "…";
    let i = 0; const t0 = Date.now(), spin = act.querySelector(".spin"), meta = act.querySelector(".meta");
    turn = { block, act, verb, t0, chars: 0, textEl: null, reasonEl: null, _buf: "" };
    turn.timer = setInterval(() => {
      spin.textContent = GLYPHS[(i = (i + 1) % GLYPHS.length)];
      meta.textContent = `(${Math.floor((Date.now() - t0) / 1000)}s · ↓ ${Math.round(turn.chars / 4)} tokens)`;
    }, 120);
    scroll();
  }
  function endTurn() {
    if (!turn) return;
    clearInterval(turn.timer);
    turn.act.classList.add("done");
    turn.act.innerHTML = `✽ ${esc(turn.verb)}d for ${Math.floor((Date.now() - turn.t0) / 1000)}s · ↓ ${Math.round(turn.chars / 4)} tokens`;
    turn = null;
  }
  function ensureTurn() { if (!turn) startTurn(); }
  function textBlock() { if (!turn.textEl) { turn.textEl = el("div", "text"); turn.block.appendChild(turn.textEl); } return turn.textEl; }
  function breakText() { if (turn) { turn.textEl = null; turn._buf = ""; } }

  function openFileBtn(path, line) { const b = el("button", "link", "⤢ open"); b.onclick = () => vscode.postMessage({ type: "openFile", path, line }); return b; }

  function toolCard(ev) {
    const c = el("div", "tool");
    const verb = { read_file: "Read", write_file: "Write", edit_file: "Edit", bash: "Bash", glob: "Glob", grep: "Grep", web_fetch: "Fetch", web_search: "Search", todo: "Todos", skill: "Skill", save_memory: "Remember" }[ev.name] || ev.name;
    c.innerHTML = `<div class="head"><span class="dot run"></span><span class="verb">${esc(verb)}</span><span class="arg">${esc(ev.summary || "")}</span><span class="badge"></span></div><div class="body"><pre></pre></div>`;
    c.querySelector(".head").onclick = () => c.classList.toggle("open");
    if (["read_file", "write_file", "edit_file"].includes(ev.name) && ev.summary) c.querySelector(".head").appendChild(openFileBtn(ev.summary));
    turn.block.appendChild(c); breakText(); scroll(); return c;
  }
  function renderDiff(diff) {
    const wrap = el("div", "diff");
    const path = (diff.match(/\+\+\+ b\/(.+)/) || [, "changed file"])[1].replace(/^\/+/, "");
    const lines = diff.split("\n").map((l) => {
      const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") || l.startsWith("---") || l.startsWith("+++") ? "hh" : "";
      return `<span class="${cls}">${esc(l)}</span>`;
    }).join("\n");
    wrap.innerHTML = `<div class="dhead"><span class="f">◈ ${esc(path)}</span></div><pre>${lines}</pre>`;
    const b = openFileBtn(path); wrap.querySelector(".dhead").appendChild(b);
    return wrap;
  }
  function decisionCard(inner) { const c = el("div", "card"); c.innerHTML = inner; (turn ? turn.block : log).appendChild(c); breakText(); scroll(); return c; }
  function resolveCard(c) { c.classList.add("resolved"); }
  function sysLine(msg, isErr) { (turn ? turn.block : log).appendChild(el("div", "sys" + (isErr ? " err" : ""), esc(msg))); scroll(); }

  function onEvent(ev) {
    const stick = atBottom();
    switch (ev.type) {
      case "turn_start": startTurn(); break;
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
        const c = decisionCard(`<div class="q">⛔ DGC wants to run <b>${esc(ev.name)}</b></div>${cmd}<div class="btns"><button class="act primary" data-d="once">Allow once</button><button class="act" data-d="always">Always allow</button><button class="act" data-d="deny">Deny</button></div>`);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => { vscode.postMessage({ type: "permission_response", id: ev.id, decision: b.dataset.d, rule: b.dataset.d === "always" ? ev.suggested_rule : undefined }); resolveCard(c); });
        break;
      }
      case "plan_proposal": {
        ensureTurn();
        const c = decisionCard(`<div class="q">📋 Plan ready</div><pre>${esc(ev.plan)}</pre><div class="btns"><button class="act primary" data-d="acceptEdits">Approve → acceptEdits</button><button class="act" data-d="auto">auto</button><button class="act" data-d="default">default</button><button class="act" data-d="reject">Keep planning</button></div>`);
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
  function setSending(on) { streaming = on; send.textContent = on ? "⏹ Stop" : "Send ▸"; send.classList.toggle("stop", on); }
  function submit() {
    if (streaming) { vscode.postMessage({ type: "cancel" }); return; }
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    const full = attachments.map((a) => a.text).join("\n") + (attachments.length ? "\n" : "") + text;
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    m.appendChild(el("div", "bubble", esc(text) + attachments.map((a) => `\n[${esc(a.label)}]`).join(""))); log.appendChild(m);
    vscode.postMessage({ type: "prompt", text: full });
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
    if (sl === 0 && !/\s/.test(v)) { popMode = "/"; popStart = 0; showPop(SLASH.filter((c) => c[0].startsWith(v)).map((c) => ({ label: c[0], detail: c[1], action: c[2] }))); }
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
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Escape" && streaming) vscode.postMessage({ type: "cancel" });
  });
  send.onclick = submit;
  $("pill-model").onclick = () => vscode.postMessage({ type: "pickModel" });
  $("pill-mode").onclick = () => vscode.postMessage({ type: "pickMode" });
  $("pill-think").onclick = () => vscode.postMessage({ type: "pickThink" });
  // copy-code (delegated)
  log.addEventListener("click", (e) => { const b = e.target.closest && e.target.closest(".copy"); if (b) vscode.postMessage({ type: "copy", text: decodeURIComponent(b.dataset.c) }); });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "state") { $("model").textContent = msg.state.model || "—"; $("mode").textContent = msg.state.mode; $("think").textContent = msg.state.think; $("pill-mode").className = "pill " + (msg.state.mode === "auto" ? "auto" : msg.state.mode === "plan" ? "plan" : ""); }
    else if (msg.type === "cleared") { log.innerHTML = ""; turn = null; setSending(false); }
    else if (msg.type === "attach") { attachments.push({ label: msg.label, text: msg.text }); renderAtts(); }
    else if (msg.type === "files") { files = msg.files || []; if (popMode === "@") onInput(); }
    else if (msg.type === "backend_exit") { sysLine("dgc backend exited" + (msg.code ? " (code " + msg.code + ")" : ""), true); setSending(false); }
  });
})();
