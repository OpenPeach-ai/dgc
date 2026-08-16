(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments");

  const GLYPHS = ["·", "✢", "*", "✶", "✻", "✽", "✻", "✶", "*", "✢"];
  const VERBS = ["Ideating", "Percolating", "Ruminating", "Conjuring", "Noodling", "Marinating",
    "Untangling", "Composing", "Simmering", "Cogitating", "Wrangling", "Distilling"];

  let streaming = false;
  let turn = null;                 // { block, act, spin, timer, verb, t0, chars, textEl, reasonEl }
  const attachments = [];          // pending {label, text}

  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
  const inlineCode = (s) => esc(s).replace(/`([^`]+)`/g, "<code>$1</code>");

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (html !== undefined) { e.innerHTML = html; }
    return e;
  }
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
  function scroll() { log.scrollTop = log.scrollHeight; }

  // ---- turn lifecycle ------------------------------------------------------
  function startTurn() {
    const block = el("div", "msg dgc");
    block.appendChild(el("div", "role dgc", "DGC"));
    const act = el("div", "thinking");
    act.innerHTML = `<span class="spin">·</span> <span class="verb"></span> <span class="meta"></span>`;
    block.appendChild(act);
    log.appendChild(block);
    const verb = VERBS[Math.floor(Math.random() * VERBS.length)];
    act.querySelector(".verb").textContent = verb + "…";
    let i = 0;
    const t0 = Date.now();
    const spin = act.querySelector(".spin");
    const meta = act.querySelector(".meta");
    turn = { block, act, verb, t0, chars: 0, textEl: null, reasonEl: null };
    turn.timer = setInterval(() => {
      spin.textContent = GLYPHS[(i = (i + 1) % GLYPHS.length)];
      const s = Math.floor((Date.now() - t0) / 1000);
      meta.textContent = `(${s}s · ↓ ${Math.round(turn.chars / 4)} tokens)`;
    }, 120);
    scroll();
  }
  function endTurn() {
    if (!turn) { return; }
    clearInterval(turn.timer);
    const s = Math.floor((Date.now() - turn.t0) / 1000);
    turn.act.classList.add("done");
    turn.act.innerHTML = `✽ ${esc(turn.verb)}d for ${s}s · ↓ ${Math.round(turn.chars / 4)} tokens`;
    turn = null;
  }
  function ensureTurn() { if (!turn) { startTurn(); } }

  // ---- element helpers -----------------------------------------------------
  function textBlock() {
    if (!turn.textEl) {
      turn.textEl = el("div", "text");
      turn.block.appendChild(turn.textEl);
      turn._buf = "";
    }
    return turn.textEl;
  }
  function breakText() { if (turn) { turn.textEl = null; } }  // next text starts a fresh block

  function toolCard(ev) {
    const c = el("div", "tool");
    const verb = { read_file: "Read", write_file: "Write", edit_file: "Edit", bash: "Bash", glob: "Glob", grep: "Grep", web_fetch: "Fetch", web_search: "Search", todo: "Todos", skill: "Skill", save_memory: "Remember" }[ev.name] || ev.name;
    c.innerHTML = `<div class="head"><span class="dot run"></span><span class="verb">${esc(verb)}</span><span class="arg">${esc(ev.summary || "")}</span><span class="badge"></span></div><div class="body"><pre></pre></div>`;
    c.querySelector(".head").onclick = () => c.classList.toggle("open");
    turn.block.appendChild(c);
    breakText();
    scroll();
    return c;
  }

  function renderDiff(diff) {
    const wrap = el("div", "diff");
    const path = (diff.match(/\+\+\+ b\/(.+)/) || [, "changed file"])[1].replace(/^\/+/, "");
    const lines = diff.split("\n").map((l) => {
      const cls = l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : l.startsWith("@@") || l.startsWith("---") || l.startsWith("+++") ? "hh" : "";
      return `<span class="${cls}">${esc(l)}</span>`;
    }).join("\n");
    wrap.innerHTML = `<div class="dhead"><span class="f">◈ ${esc(path)}</span></div><pre>${lines}</pre>`;
    return wrap;
  }

  function decisionCard(inner) {
    const c = el("div", "card");
    c.innerHTML = inner;
    turn ? turn.block.appendChild(c) : log.appendChild(c);
    breakText();
    scroll();
    return c;
  }
  function resolveCard(c) { c.classList.add("resolved"); }

  function sysLine(msg, isErr) {
    const s = el("div", "sys" + (isErr ? " err" : ""), esc(msg));
    (turn ? turn.block : log).appendChild(s);
    scroll();
  }

  // ---- event handling ------------------------------------------------------
  function onEvent(ev) {
    const stick = atBottom();
    switch (ev.type) {
      case "turn_start": startTurn(); break;
      case "text_delta": {
        ensureTurn();
        turn.chars += ev.text.length;
        turn._buf = (turn._buf || "") + ev.text;
        textBlock().innerHTML = inlineCode(turn._buf);
        break;
      }
      case "thinking_delta": {
        ensureTurn();
        turn.chars += ev.text.length;
        if (!turn.reasonEl) {
          const d = el("div", "disclosure", "▸ thinking");
          const r = el("div", "reasoning");
          d.onclick = () => { r.classList.toggle("show"); d.textContent = (r.classList.contains("show") ? "▾" : "▸") + " thinking"; };
          turn.block.appendChild(d); turn.block.appendChild(r);
          turn.reasonEl = r;
        }
        turn.reasonEl.textContent += ev.text;
        break;
      }
      case "stream_end": breakText(); break;
      case "tool_call": { ensureTurn(); turn._tools = turn._tools || {}; turn._tools[ev.call_id || ev.name] = toolCard(ev); break; }
      case "tool_result": {
        ensureTurn();
        const c = (turn._tools && turn._tools[ev.call_id]) || toolCard({ name: ev.name });
        c.querySelector(".dot").className = "dot " + (ev.is_error ? "err" : "ok");
        if (ev.is_diff && ev.diff) {
          turn.block.appendChild(renderDiff(ev.diff));
        } else {
          const out = String(ev.output || "");
          c.querySelector(".body pre").textContent = out.slice(0, 4000);
          c.querySelector(".badge").textContent = out.split("\n").length + " ln";
        }
        breakText();
        break;
      }
      case "tool_denied": { ensureTurn(); const c = toolCard({ name: ev.name, summary: ev.reason }); c.querySelector(".dot").className = "dot deny"; break; }
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
    if (stick) { scroll(); }
  }

  // ---- composer ------------------------------------------------------------
  function setSending(on) {
    streaming = on;
    send.textContent = on ? "⏹ Stop" : "Send ▸";
    send.classList.toggle("stop", on);
  }
  function submit() {
    if (streaming) { vscode.postMessage({ type: "cancel" }); return; }
    const text = input.value.trim();
    if (!text && !attachments.length) { return; }
    const full = attachments.map((a) => a.text).join("\n") + (attachments.length ? "\n" : "") + text;
    // echo the user message
    const m = el("div", "msg user");
    m.appendChild(el("div", "role", "you"));
    const b = el("div", "bubble", esc(text) + attachments.map((a) => `\n[${esc(a.label)}]`).join(""));
    m.appendChild(b); log.appendChild(m);
    vscode.postMessage({ type: "prompt", text: full });
    input.value = ""; input.style.height = "auto";
    attachments.length = 0; renderAtts();
    setSending(true); scroll();
  }
  function renderAtts() {
    atts.innerHTML = "";
    attachments.forEach((a, i) => {
      const chip = el("span", "chip", esc(a.label) + ' <span class="x">×</span>');
      chip.querySelector(".x").onclick = () => { attachments.splice(i, 1); renderAtts(); };
      atts.appendChild(chip);
    });
  }
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px"; });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); }
    else if (e.key === "Escape" && streaming) { vscode.postMessage({ type: "cancel" }); }
  });
  send.onclick = submit;
  $("pill-model").onclick = () => vscode.postMessage({ type: "pickModel" });
  $("pill-mode").onclick = () => vscode.postMessage({ type: "pickMode" });
  $("pill-think").onclick = () => vscode.postMessage({ type: "pickThink" });

  // ---- host messages -------------------------------------------------------
  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "event") { onEvent(msg.event); }
    else if (msg.type === "state") {
      $("model").textContent = msg.state.model || "—";
      $("mode").textContent = msg.state.mode;
      $("think").textContent = msg.state.think;
      const pm = $("pill-mode"); pm.className = "pill " + (msg.state.mode === "auto" ? "auto" : msg.state.mode === "plan" ? "plan" : "");
    }
    else if (msg.type === "cleared") { log.innerHTML = ""; turn = null; setSending(false); }
    else if (msg.type === "attach") { attachments.push({ label: msg.label, text: msg.text }); renderAtts(); }
    else if (msg.type === "stderr") { /* diagnostics — keep quiet unless debugging */ }
    else if (msg.type === "backend_exit") { sysLine("dgc backend exited" + (msg.code ? " (code " + msg.code + ")" : ""), true); setSending(false); }
  });
})();
