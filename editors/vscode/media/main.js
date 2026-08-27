(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments"), pop = $("pop");
  const announcer = $("announcer");
  const queuedEl = $("queued");
  const MAX_IMAGE_FILES = 4, MAX_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;
  const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
  let pendingImageFiles = 0, pendingImageBytes = 0;
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
    $("btn-mode").setAttribute("aria-label", `Permission mode: ${m}. ${MODES[m].desc}`);
  }
  // The extension host owns the auto-mode confirmation. Update only when the backend
  // echoes mode_changed/state so cancelling the modal cannot leave a false "auto" badge.
  function setMode(m) { vscode.postMessage({ type: "setMode", mode: m }); hideModeMenu(); }
  function cycleMode() { setMode(MODE_ORDER[(MODE_ORDER.indexOf(curMode) + 1) % MODE_ORDER.length]); }
  function hideModeMenu() { $("modemenu").hidden = true; $("btn-mode").setAttribute("aria-expanded", "false"); }
  function toggleModeMenu() {
    const mm = $("modemenu");
    if (!mm.hidden) { hideModeMenu(); return; }
    hideModelMenu();
    mm.innerHTML =
      `<div role="group" aria-label="Permission mode"><div class="mhead" role="presentation"><span>Permission mode</span><kbd>⇧Tab</kbd></div>` +
      MODE_ORDER.map((m) => `<button type="button" role="menuitemradio" aria-checked="${m === curMode}" class="mrow${m === curMode ? " sel" : ""}" data-mode="${m}"><span class="mi codicon codicon-${MODES[m].icon}" aria-hidden="true"></span><span>${m}</span><span class="md">${MODES[m].desc}</span></button>`).join("") +
      `</div><div class="mdiv" role="separator"></div><div role="group" aria-label="Thinking"><div class="mhead" role="presentation"><span>Thinking</span></div>` +
      THINK.map((t) => `<button type="button" role="menuitemradio" aria-checked="${t === curThink}" class="mrow${t === curThink ? " sel" : ""}" data-think="${t}"><span class="mi codicon codicon-lightbulb" aria-hidden="true"></span><span>${t}</span></button>`).join("") + `</div>`;
    mm.querySelectorAll("[data-mode]").forEach((r) => r.onclick = () => setMode(r.dataset.mode));
    mm.querySelectorAll("[data-think]").forEach((r) => r.onclick = () => { curThink = r.dataset.think; vscode.postMessage({ type: "setThink", level: curThink }); hideModeMenu(); });
    mm.hidden = false; $("btn-mode").setAttribute("aria-expanded", "true");
    (mm.querySelector(".sel") || mm.querySelector("button"))?.focus();
  }

  // in-composer model menu (rendered from the `models` message the extension posts)
  function hideModelMenu() { $("modelmenu").hidden = true; $("btn-model").setAttribute("aria-expanded", "false"); }
  function renderModelMenu(ids, current, err) {
    const mm = $("modelmenu");
    if (err || !ids.length) {
      mm.innerHTML = `<button type="button" role="menuitem" class="mrow" data-connect="1"><span class="mi codicon codicon-plug" aria-hidden="true"></span><span>${err ? "Can’t reach endpoint — connect…" : "No models — connect…"}</span></button>`;
      mm.querySelector("[data-connect]").onclick = () => { vscode.postMessage({ type: "connect" }); hideModelMenu(); };
      mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true"); mm.querySelector("button")?.focus(); return;
    }
    mm.innerHTML = `<div class="mhead"><span>Model</span></div>` +
      ids.map((id, i) => `<button type="button" role="menuitemradio" aria-checked="${id === current}" class="mrow${id === current ? " sel" : ""}" data-i="${i}"><span class="mi ${id === current ? "codicon codicon-check" : ""}" aria-hidden="true"></span><span>${esc(id)}</span></button>`).join("");
    mm.querySelectorAll("[data-i]").forEach((r) => r.onclick = () => { vscode.postMessage({ type: "setModel", model: ids[+r.dataset.i] }); hideModelMenu(); });
    mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true");
    (mm.querySelector(".sel") || mm.querySelector("button"))?.focus();
  }

  function menuKeys(menu, close, trigger, e) {
    const items = [...menu.querySelectorAll("button[role^='menuitem']")];
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(document.activeElement));
    let next = null;
    if (e.key === "ArrowDown") next = (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); return; }
    if (next !== null) { e.preventDefault(); items[next].focus(); }
  }
  $("modemenu").addEventListener("keydown", (e) => menuKeys($("modemenu"), hideModeMenu, $("btn-mode"), e));
  $("modelmenu").addEventListener("keydown", (e) => menuKeys($("modelmenu"), hideModelMenu, $("btn-model"), e));

  // animated DGC mark — the three stripes light up one-by-one, hold all three,
  // then repeat (CSS-driven, ~1.2s loop, single purple). Replaces the old braille
  // spinner; the reduced-motion case (in main.css) renders all three lit + static.
  const MARK = '<svg class="tmark" viewBox="0 0 90 90" fill="currentColor" aria-hidden="true">'
    + '<path class="s1" d="M32 24 L20 30 L13 72 L25 66 Z"/>'
    + '<path class="s2" d="M54 18 L42 24 L35 72 L47 66 Z"/>'
    + '<path class="s3" d="M76 24 L64 30 L57 66 L69 60 Z"/></svg>';
  // per-tool glyph — the CLI's set: → read · ✎ write/edit · $ shell · ✱ search · ▸ other
  const GLYPH = {
    read_file: "→", glob: "→", repo_map: "→",
    write_file: "✎", edit_file: "✎", apply_patch: "✎", save_memory: "✎",
    bash: "$", bash_output: "$", bash_kill: "$",
    grep: "✱", web_search: "✱", web_fetch: "✱",
    present_plan: "▸", task: "▸", todo: "▸", skill: "▸",
  };
  const glyphFor = (name) => GLYPH[name] || "▸";
  let builtinCommands = [
    { name: "model", description: "pick the model", action: "pickModel" },
    { name: "connect", description: "provider or a custom LAN host", action: "connect" },
    { name: "mode", description: "permission mode", action: "pickMode" },
    { name: "think", description: "how hard the model reasons", action: "pickThink" },
    { name: "goal", description: "inspect/set/complete/block the standing objective", action: "goal", accepts_args: true },
    { name: "view-plan", description: "reopen the saved plan", action: "viewPlan" },
  ];

  let streaming = false, turn = null;
  const attachments = [];
  let files = [];              // workspace files for @-mentions
  let popMode = null, popItems = [], popIdx = 0, popStart = 0;
  let disclosureId = 0;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  function speak(message) { announcer.textContent = String(message || ""); }

  // Small dependency-free Markdown renderer. Every model byte is escaped before becoming markup;
  // fenced/inline code is parsed as an opaque block so Markdown-looking source code cannot be
  // reinterpreted. An unterminated final fence is rendered immediately while it is still streaming.
  function inlineMd(source) {
    return String(source).split(/(`[^`\n]*`)/g).map((part) => {
      if (part.length >= 2 && part.startsWith("`") && part.endsWith("`")) {
        return `<code>${esc(part.slice(1, -1))}</code>`;
      }
      let safe = esc(part);
      // Links remain inert inside the webview: show their label but never synthesize navigation.
      safe = safe.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
      safe = safe.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      safe = safe.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
      return safe;
    }).join("");
  }

  function tableCells(line) {
    let source = String(line).trim();
    if (source.startsWith("|")) source = source.slice(1);
    if (source.endsWith("|") && !source.endsWith("\\|")) source = source.slice(0, -1);
    const cells = [];
    let cell = "", inCode = false;
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === "\\" && source[i + 1] === "|") { cell += "|"; i++; continue; }
      if (ch === "`") { inCode = !inCode; cell += ch; continue; }
      if (ch === "|" && !inCode) { cells.push(cell.trim()); cell = ""; continue; }
      cell += ch;
    }
    cells.push(cell.trim());
    return cells;
  }

  function tableAlignment(cell) {
    const marker = String(cell).replace(/\s/g, "");
    if (!/^:?-{3,}:?$/.test(marker)) return null;
    if (marker.startsWith(":") && marker.endsWith(":")) return "center";
    return marker.endsWith(":") ? "right" : "left";
  }

  function textMd(source) {
    const lines = String(source).split("\n"), rendered = [];
    for (let i = 0; i < lines.length;) {
      const headers = lines[i].includes("|") ? tableCells(lines[i]) : [];
      const dividers = i + 1 < lines.length && lines[i + 1].includes("|")
        ? tableCells(lines[i + 1]) : [];
      const alignment = dividers.map(tableAlignment);
      if (headers.length && headers.length === dividers.length
          && alignment.every((value) => value !== null)) {
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
          const cells = tableCells(lines[i]);
          if (cells.length !== headers.length) break;
          rows.push(cells); i++;
        }
        const head = headers.map((cell, index) =>
          `<th class="align-${alignment[index]}">${inlineMd(cell)}</th>`).join("");
        const body = rows.map((row) => `<tr>${row.map((cell, index) =>
          `<td class="align-${alignment[index]}">${inlineMd(cell)}</td>`).join("")}</tr>`).join("");
        rendered.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(lines[i]);
      const bullet = /^(\s*)[-*]\s+(.*)$/.exec(lines[i]);
      if (heading) rendered.push(`<b class="md-heading md-h${heading[1].length}">${inlineMd(heading[2])}</b>`);
      else if (bullet) rendered.push(`${bullet[1]}• ${inlineMd(bullet[2])}`);
      else rendered.push(inlineMd(lines[i]));
      i++;
    }
    return rendered.join("\n");
  }

  function codeBlock(code, language) {
    const lang = language ? ` data-language="${language}"` : "";
    return `<pre class="code"${lang}><button type="button" class="copy" data-c="${encodeURIComponent(code)}" aria-label="Copy code">copy</button><code>${esc(code)}</code></pre>`;
  }

  function md(source) {
    const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
    const rendered = [], text = [];
    const flushText = () => {
      if (text.length) { rendered.push(textMd(text.join("\n"))); text.length = 0; }
    };
    for (let i = 0; i < lines.length;) {
      const opening = /^\s*```([A-Za-z0-9_+.-]*)\s*$/.exec(lines[i]);
      if (!opening) { text.push(lines[i]); i++; continue; }
      flushText(); i++;
      const code = [];
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { code.push(lines[i]); i++; }
      if (i < lines.length) i++; // closing fence; absence means this is the live partial block
      rendered.push(codeBlock(code.join("\n"), opening[1]));
    }
    flushText();
    return rendered.join("\n");
  }
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
  function scroll() { log.scrollTop = log.scrollHeight; }

  // ---- turn lifecycle ----
  function startTurn() {
    if (turn) endTurn();
    speak("DGC is working");
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
    turn.block.querySelectorAll(".card:not(.resolved)").forEach(resolveCard);
    turn.block.querySelectorAll('.tool[data-status="running"]').forEach((card) => {
      setToolStatus(card, "stopped");
      const dot = card.querySelector(".dot");
      if (dot) dot.className = "dot deny";
    });
    clearInterval(turn.timer);
    turn.act.classList.add("done");
    turn.act.innerHTML = `▸ worked for ${Math.floor((Date.now() - turn.t0) / 1000)}s · ↓ ${Math.round(turn.chars / 4)} tok`;
    turn = null;
  }
  function discardTurn() {
    if (turn) clearInterval(turn.timer);
    expireOpenRequests();
    turn = null;
  }
  function ensureTurn() { if (!turn) startTurn(); }
  function textBlock() { if (!turn.textEl) { turn.textEl = el("div", "text"); turn.block.appendChild(turn.textEl); } return turn.textEl; }
  function breakText() { if (turn) { turn.textEl = null; turn._buf = ""; } }

  function openFileBtn(path, line) {
    const b = el("button", "link", "⤢ open"); b.type = "button";
    b.setAttribute("aria-label", `Open ${path}${line ? ` at line ${line}` : ""}`);
    b.onclick = (e) => { e.stopPropagation(); vscode.postMessage({ type: "openFile", path, line }); };
    return b;
  }

  function setToolStatus(card, status) {
    const value = String(status || "");
    card.dataset.status = value;
    const label = card.querySelector(".tool-status");
    if (label) label.textContent = value;
  }

  function toolCard(ev) {
    const c = el("div", "tool");
    const bodyId = `tool-output-${++disclosureId}`;
    c.innerHTML = `<div class="head"><button type="button" class="tool-toggle" aria-expanded="false" aria-controls="${bodyId}"><span class="glyph" aria-hidden="true">${glyphFor(ev.name)}</span><span class="verb">${esc(ev.name)}</span><span class="arg">${esc(ev.summary || "")}</span></button></div><div class="body" id="${bodyId}"><pre></pre></div>`;
    const head = c.querySelector(".head");
    const toggle = c.querySelector(".tool-toggle");
    toggle.onclick = () => {
      const open = c.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    };
    if (["read_file", "write_file", "edit_file", "apply_patch"].includes(ev.name) && ev.summary) head.appendChild(openFileBtn(ev.summary));
    const status = el("span", "sr-only tool-status", "running");
    toggle.appendChild(status);
    const dot = el("span", "dot run"); dot.setAttribute("aria-hidden", "true");
    head.appendChild(dot);
    head.appendChild(el("span", "badge"));
    setToolStatus(c, "running");
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
  function decisionCard(inner, label = "DGC decision") { const c = el("div", "card"); c.setAttribute("role", "group"); c.setAttribute("aria-label", label); c.innerHTML = inner; (turn ? turn.block : log).appendChild(c); breakText(); scroll(); return c; }
  function requestCard(c, id) { c.dataset.requestId = String(id); return c; }
  function resolveCard(c) {
    if (!c || c.classList.contains("resolved")) return false;
    c.classList.add("resolved"); c.setAttribute("aria-disabled", "true");
    c.querySelectorAll(".btns button, .opts button, .feedback, .mcp-form input, .mcp-form select, .mcp-form textarea, .mcp-form button")
      .forEach((control) => { control.disabled = true; });
    return true;
  }
  function expireOpenRequests() {
    document.querySelectorAll(".card[data-request-id]:not(.resolved)").forEach(resolveCard);
  }
  function sysLine(msg, isErr) { const line = el("div", "sys" + (isErr ? " err" : ""), esc(msg)); if (isErr) line.setAttribute("role", "alert"); (turn ? turn.block : log).appendChild(line); scroll(); }

  function onEvent(ev) {
    const stick = atBottom();
    switch (ev.type) {
      case "ready": {
        if (Array.isArray(ev.commands) && ev.commands.length
            && ev.commands.every((c) => c && typeof c === "object")) {
          builtinCommands = ev.commands;
        }
        customCommands = Array.isArray(ev.custom_commands) ? ev.custom_commands
          : (Array.isArray(ev.commands) ? ev.commands.filter((c) => typeof c === "string") : []);
        break;
      }
      case "context": {
        const pct = ev.size ? Math.min(100, Math.round((ev.used / ev.size) * 100)) : 0;
        $("ctx").textContent = pct + "%";
        $("btn-ctx").classList.toggle("warn", pct >= 85);
        const fmt = (n) => Number(n || 0).toLocaleString();
        $("btn-ctx").title = `Context ${fmt(ev.used)} / ${fmt(ev.size)} estimated tokens · ` +
          `provider ${fmt(ev.input_tokens)} in / ${fmt(ev.output_tokens)} out · ` +
          `${fmt(ev.cached_input_tokens)} cached · ${fmt(ev.reasoning_tokens)} reasoning · ` +
          `${fmt(ev.requests)} requests · click to compact`;
        $("btn-ctx").setAttribute("aria-label", `Context used: ${pct} percent; compact context`);
        break;
      }
      case "history": renderHistory(ev.items || []); break;
      case "rewound":
        if (ev.ok) {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; renderQueued(); setSending(false);
        }
        break;
      case "session":
        if (ev.kind === "cleared" || ev.kind === "new") {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; renderQueued(); setSending(false);
        }
        break;
      case "config": lastConfig = ev; if (!$("settings").hidden) fillSettings(ev); break;
      case "turn_start": startTurn(); setSending(true); if (queuedCount > 0) { queuedCount--; renderQueued(); } break;
      case "handoff_started":
        startTurn(); setSending(true); speak("DGC is generating a handoff");
        if (turn?.act?.querySelector(".verb")) turn.act.querySelector(".verb").textContent = "generating handoff…";
        break;
      case "queued": queuedCount = ev.count; renderQueued(); break;
      case "text_delta": ensureTurn(); turn.chars += ev.text.length; turn._buf = (turn._buf || "") + ev.text; textBlock().innerHTML = md(turn._buf); break;
      case "thinking_delta":
        ensureTurn(); turn.chars += ev.text.length;
        if (!turn.reasonEl) {
          const d = el("button", "disclosure", "▸ thinking"), r = el("div", "reasoning");
          const reasonId = `reasoning-${++disclosureId}`;
          d.type = "button"; d.setAttribute("aria-expanded", "false"); d.setAttribute("aria-controls", reasonId); r.id = reasonId;
          d.onclick = () => { const open = r.classList.toggle("show"); d.textContent = (open ? "▾" : "▸") + " thinking"; d.setAttribute("aria-expanded", String(open)); };
          turn.block.appendChild(d); turn.block.appendChild(r); turn.reasonEl = r;
        }
        turn.reasonEl.textContent += ev.text; break;
      case "stream_end": breakText(); break;
      case "tool_call": ensureTurn(); turn._tools = turn._tools || {}; turn._tools[ev.call_id || ev.name] = toolCard(ev); break;
      case "tool_progress": {
        ensureTurn();
        turn._tools = turn._tools || {};
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name }));
        const numeric = Number.isFinite(ev.progress);
        const hasTotal = numeric && Number.isFinite(ev.total) && ev.total !== 0;
        c.querySelector(".body pre").textContent = String(ev.message || "").slice(0, 500);
        c.querySelector(".badge").textContent = hasTotal
          ? Math.max(0, Math.min(100, Math.round(ev.progress / ev.total * 100))) + "%"
          : (numeric ? String(ev.progress) : "");
        break;
      }
      case "tool_result": {
        ensureTurn();
        turn._tools = turn._tools || {};
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name }));
        c.querySelector(".dot").className = "dot " + (ev.is_error ? "err" : "ok");
        setToolStatus(c, ev.is_error ? "failed" : "completed");
        if (ev.is_diff && ev.diff) turn.block.appendChild(renderDiff(ev.diff));
        else { const out = String(ev.output || ""); c.querySelector(".body pre").textContent = out.slice(0, 4000); c.querySelector(".badge").textContent = out.split("\n").length + " ln"; }
        breakText(); break;
      }
      case "tool_denied": {
        ensureTurn();
        turn._tools = turn._tools || {};
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name, summary: ev.reason }));
        c.querySelector(".dot").className = "dot deny";
        setToolStatus(c, "denied"); break;
      }
      case "permission_request": {
        ensureTurn();
        speak(`Permission required to run ${ev.name}`);
        const cmd = ev.command ? `<pre>$ ${esc(ev.command)}</pre>` : `<pre>${esc(JSON.stringify(ev.args))}</pre>`;
        const c = requestCard(decisionCard(`<div class="q"><span class="codicon codicon-shield" aria-hidden="true"></span> Run <b>${esc(ev.name)}</b>?</div>${cmd}<div class="btns"><button type="button" class="act primary" data-d="once">Allow once</button><button type="button" class="act" data-d="always">Always allow</button><button type="button" class="act" data-d="deny">Deny</button></div>`, "Tool permission request"), ev.id);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => {
          if (!resolveCard(c)) return;
          vscode.postMessage({ type: "permission_response", id: ev.id, decision: b.dataset.d, rule: b.dataset.d === "always" ? ev.suggested_rule : undefined });
        });
        break;
      }
      case "plan_proposal": {
        ensureTurn();
        speak("Plan ready for review");
        const c = requestCard(decisionCard(`<div class="q"><span class="codicon codicon-checklist" aria-hidden="true"></span> Plan ready</div><pre>${esc(ev.plan)}</pre><textarea class="feedback" rows="2" aria-label="Plan feedback" placeholder="Optional feedback (required changes, constraints, priorities)…"></textarea><div class="btns"><button type="button" class="act primary" data-d="acceptEdits">Approve → acceptEdits</button><button type="button" class="act" data-d="auto">auto</button><button type="button" class="act" data-d="default">default</button><button type="button" class="act" data-d="reject">Keep planning</button></div>`, "Plan approval"), ev.id);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => {
          const feedback = c.querySelector(".feedback").value.trim();
          if (!resolveCard(c)) return;
          vscode.postMessage({ type: "plan_response", id: ev.id, decision: b.dataset.d, feedback });
        });
        break;
      }
      case "options_request": {
        ensureTurn();
        speak(ev.question);
        // Stacked, numbered, wrapping rows — long options stay fully visible (never overflow
        // the card), and the recommended one is marked with an accent bar, not an unreadable
        // solid-purple fill.
        const opts = ev.options.map((o, i) =>
          `<button type="button" class="opt${i === 0 ? " rec" : ""}" data-i="${i + 1}"><span class="n">${i + 1}</span><span class="ol">${esc(o)}</span></button>`).join("");
        const c = requestCard(decisionCard(`<div class="q">${esc(ev.question)}</div><div class="opts">${opts}</div>`, "Choose an option"), ev.id);
        c.querySelectorAll("button").forEach((b) => b.onclick = () => {
          if (!resolveCard(c)) return;
          vscode.postMessage({ type: "options_response", id: ev.id, choice: Number(b.dataset.i) });
        });
        break;
      }
      case "mcp_input_request": {
        ensureTurn();
        const p = ev.payload || {};
        const title = `MCP server ${ev.server} requests input`;
        speak(title);
        if (ev.kind === "sampling_request" || ev.kind === "sampling_response") {
          const question = ev.kind === "sampling_request"
            ? "Allow this server to ask your model?"
            : "Share this generated response with the server?";
          const c = decisionCard(`<div class="q"><span class="codicon codicon-shield" aria-hidden="true"></span> ${esc(question)}</div><div class="muted">Requested by ${esc(ev.server)}</div><pre>${esc(JSON.stringify(p, null, 2).slice(0, 12000))}</pre><div class="btns"><button type="button" class="act primary" data-a="accept">Approve once</button><button type="button" class="act" data-a="decline">Decline</button><button type="button" class="act" data-a="cancel">Cancel</button></div>`, title);
          requestCard(c, ev.id);
          c.querySelectorAll("button").forEach((b) => b.onclick = () => {
            if (!resolveCard(c)) return;
            vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: b.dataset.a });
          });
          break;
        }
        if (ev.kind !== "elicitation") break;
        if (p.mode === "url") {
          const warning = p.suspicious_host
            ? `<div class="err">Punycode host — inspect carefully for lookalike characters.</div>` : "";
          const c = decisionCard(`<div class="q"><span class="codicon codicon-link-external" aria-hidden="true"></span> Open a URL outside DGC?</div><div class="muted">Requested by ${esc(ev.server)}</div><p>${esc(p.message || "")}</p><div><b>Host:</b> ${esc(p.host || "")}</div><pre>${esc(p.url || "")}</pre>${warning}<div class="btns"><button type="button" class="act primary" data-a="accept">Open in secure browser</button><button type="button" class="act" data-a="decline">Decline</button><button type="button" class="act" data-a="cancel">Cancel</button></div>`, title);
          requestCard(c, ev.id);
          c.querySelectorAll("button").forEach((b) => b.onclick = () => {
            if (!resolveCard(c)) return;
            vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: b.dataset.a });
          });
          break;
        }
        const schema = p.requestedSchema || {}, fields = Object.entries(schema.properties || {});
        const required = new Set(schema.required || []);
        const optionsFor = (f) => f.oneOf?.map((o) => ({ value: o.const, title: o.title }))
          || f.enum?.map((v, i) => ({ value: v, title: f.enumNames?.[i] || v }))
          || f.items?.anyOf?.map((o) => ({ value: o.const, title: o.title }))
          || f.items?.enum?.map((v) => ({ value: v, title: v })) || [];
        const controls = fields.map(([key, f], i) => {
          const id = `mcp-field-${ev.id}-${i}`, label = f.title || key;
          const req = required.has(key) ? " required" : "";
          const desc = f.description ? `<div class="muted">${esc(f.description)}</div>` : "";
          const opts = optionsFor(f);
          let control;
          if (f.type === "array") {
            control = `<select id="${esc(id)}" data-mcp-field="${i}" multiple${req}>${opts.map((o) => `<option value="${esc(o.value)}"${(f.default || []).includes(o.value) ? " selected" : ""}>${esc(o.title)}</option>`).join("")}</select>`;
          } else if (opts.length) {
            control = `<select id="${esc(id)}" data-mcp-field="${i}"${req}>${required.has(key) ? "" : '<option value="">Skip</option>'}${opts.map((o) => `<option value="${esc(o.value)}"${f.default === o.value ? " selected" : ""}>${esc(o.title)}</option>`).join("")}</select>`;
          } else if (f.type === "boolean") {
            const skip = required.has(key) ? "" : '<option value="">Skip</option>';
            const yes = `<option value="true"${f.default === true ? " selected" : ""}>Yes</option>`;
            const no = `<option value="false"${f.default === false ? " selected" : ""}>No</option>`;
            control = `<select id="${esc(id)}" data-mcp-field="${i}"${req}>${skip}${yes}${no}</select>`;
          } else {
            const inputType = f.type === "integer" || f.type === "number" ? "number"
              : ({ email: "email", uri: "url", date: "date", "date-time": "datetime-local" }[f.format] || "text");
            const step = f.type === "integer" ? ' step="1"' : f.type === "number" ? ' step="any"' : "";
            const min = f.minimum !== undefined ? ` min="${Number(f.minimum)}"` : "";
            const max = f.maximum !== undefined ? ` max="${Number(f.maximum)}"` : "";
            const minLen = f.minLength !== undefined ? ` minlength="${Number(f.minLength)}"` : "";
            const maxLen = f.maxLength !== undefined ? ` maxlength="${Number(f.maxLength)}"` : "";
            control = `<input id="${esc(id)}" data-mcp-field="${i}" type="${inputType}" value="${esc(f.default ?? "")}"${step}${min}${max}${minLen}${maxLen}${req}>`;
          }
          return `<div class="mcp-field"><label for="${esc(id)}">${esc(label)}${required.has(key) ? " *" : ""}</label>${desc}${control}</div>`;
        }).join("");
        const c = decisionCard(`<div class="q"><span class="codicon codicon-form" aria-hidden="true"></span> Information requested by ${esc(ev.server)}</div><p>${esc(p.message || "")}</p><form class="mcp-form">${controls}<div class="muted">Review and edit every value before submitting. Never enter passwords, API keys, access tokens, or payment credentials here.</div><div class="btns"><button type="submit" class="act primary">Submit</button><button type="button" class="act" data-a="decline">Decline</button><button type="button" class="act" data-a="cancel">Cancel</button></div></form>`, title);
        requestCard(c, ev.id);
        const form = c.querySelector("form");
        form.onsubmit = (e) => {
          e.preventDefault();
          fields.forEach(([, f], i) => {
            if (f.type !== "array") return;
            const control = form.querySelector(`[data-mcp-field="${i}"]`);
            const count = control.selectedOptions.length;
            const min = Number.isInteger(f.minItems) ? f.minItems : 0;
            const max = Number.isInteger(f.maxItems) ? f.maxItems : optionsFor(f).length;
            control.setCustomValidity(count < min || count > max
              ? `Choose between ${min} and ${max} values.` : "");
          });
          if (!form.reportValidity()) return;
          const content = Object.create(null);
          fields.forEach(([key, f], i) => {
            const control = form.querySelector(`[data-mcp-field="${i}"]`);
            if (f.type === "array") {
              const selected = [...control.selectedOptions].map((o) => o.value);
              if (selected.length || required.has(key)) content[key] = selected;
            }
            else if (f.type === "boolean") {
              if (control.value !== "" || required.has(key)) content[key] = control.value === "true";
            }
            else if (control.value !== "" || required.has(key)) content[key] =
              f.type === "integer" ? Number.parseInt(control.value, 10)
              : f.type === "number" ? Number(control.value) : control.value;
          });
          if (!resolveCard(c)) return;
          vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: "accept", content });
        };
        c.querySelectorAll("button[data-a]").forEach((b) => b.onclick = () => {
          if (!resolveCard(c)) return;
          vscode.postMessage({ type: "mcp_input_response", id: ev.id, action: b.dataset.a });
        });
        break;
      }
      case "todos": {
        ensureTurn();
        if (!turn._todo) { turn._todo = el("div", "todos"); turn.block.appendChild(turn._todo); }
        const TG = { pending: ["□", "pend"], in_progress: ["▶", "doing"], done: ["✓", "done"], cancelled: ["✗", "cancel"] };
        const dn = ev.todos.filter((t) => t.status === "done").length;
        turn._todo.innerHTML = `<div class="thead">Tasks <span>${dn}/${ev.todos.length}</span></div>` +
          ev.todos.map((t) => { const g = TG[t.status] || TG.pending;
            return `<div class="t ${g[1]}"><span class="ti">${g[0]}</span><span class="tc">${esc(t.content)}</span></div>`; }).join("");
        break;
      }
      case "artifact_ready": {
        ensureTurn();
        const c = el("div", "artifact");
        c.innerHTML = `<div class="ahead"><span class="aico" aria-hidden="true">▶</span><span class="anm">Artifact ready</span><span class="alabel">${esc(ev.name)}</span></div><button type="button" class="aurl">${esc(ev.url)}</button>`;
        const row = el("div", "abtns");
        const open = el("button", "abtn primary", "Open in browser"); open.type = "button";
        open.onclick = () => vscode.postMessage({ type: "openExternal", url: ev.url });
        const stop = el("button", "abtn", "Stop"); stop.type = "button";
        stop.onclick = () => { vscode.postMessage({ type: "stopArtifact", id: ev.id }); c.classList.add("stopped"); };
        row.appendChild(open); row.appendChild(stop); c.appendChild(row);
        c.querySelector(".aurl").onclick = () => vscode.postMessage({ type: "openExternal", url: ev.url });
        turn.block.appendChild(c); breakText(); scroll();
        break;
      }
      case "artifacts": {
        const items = ev.items || [];
        if (!items.length) { sysLine("No artifact previews are running."); break; }
        const c = decisionCard(`<div class="q"><span class="codicon codicon-preview"></span> Artifacts</div><div class="artifact-list"></div>`);
        const list = c.querySelector(".artifact-list");
        items.forEach((a) => {
          const row = el("div", "abtns");
          const open = el("button", "abtn primary", `${a.name} · open`); open.type = "button";
          open.onclick = () => vscode.postMessage({ type: "openExternal", url: a.url });
          const stop = el("button", "abtn", "Stop"); stop.type = "button";
          stop.onclick = () => { vscode.postMessage({ type: "stopArtifact", id: a.id }); row.remove(); };
          row.appendChild(open); row.appendChild(stop); list.appendChild(row);
        });
        break;
      }
      case "saved_plan":
        if (ev.exists) decisionCard(`<div class="q"><span class="codicon codicon-checklist"></span> Saved plan</div><pre>${esc(ev.plan)}</pre>`);
        else sysLine("No saved plan yet — switch to plan mode and ask DGC to propose one.");
        break;
      case "skill_catalog": {
        const items = Array.isArray(ev.items) ? ev.items : [];
        if (!items.length) { sysLine("No skills are installed."); break; }
        const rows = items.map((skill) => {
          const description = String(skill.description || "skill");
          return `${String(skill.name || "")}  [${String(skill.source || "unknown")}]  ${description}`;
        }).join("\n");
        decisionCard(`<div class="q"><span class="codicon codicon-library"></span> Installed skills · ${items.length}</div><pre>${esc(rows)}</pre>`, "Installed skills");
        break;
      }
      case "hook_catalog": {
        const items = Array.isArray(ev.items) ? ev.items : [];
        const rows = items.map((hook) => {
          const matchers = Array.isArray(hook.matchers) && hook.matchers.length
            ? hook.matchers.join(", ") : "—";
          return `${String(hook.event || "")}  ${Number(hook.configured || 0)}  ${matchers}  ${hook.valid ? "ready" : "invalid"}`;
        }).join("\n");
        const warning = Number(ev.invalid || 0)
          ? `<div class="err">${Number(ev.invalid)} invalid or unsupported hook entries</div>` : "";
        decisionCard(`<div class="q"><span class="codicon codicon-run-all"></span> Lifecycle hooks · ${Number(ev.total || 0)}</div><pre>${esc(rows)}</pre>${warning}`, "Lifecycle hooks");
        break;
      }
      case "hook_activity":
        if (ev.status !== "started") {
          sysLine(`Hook ${ev.event} ${ev.status} · ${ev.configured} configured · ${ev.duration_ms}ms${ev.message ? ` · ${ev.message}` : ""}`,
            ev.status !== "completed");
        }
        break;
      case "handoff": {
        ensureTurn();
        const markdown = String(ev.markdown || "");
        turn.chars += markdown.length;
        textBlock().innerHTML = md(markdown);
        if (ev.path) sysLine(`Handoff saved to ${ev.path}`);
        if (ev.status !== "completed") sysLine(String(ev.error || `Handoff ${ev.status}`), true);
        speak(ev.status === "completed" ? "Handoff ready" : `Handoff ${ev.status}`);
        endTurn(); setSending(false);
        break;
      }
      case "goal_changed": {
        const text = String(ev.goal || "");
        sysLine(text ? `Standing goal · ${ev.status}: ${text}` : "Standing goal cleared");
        break;
      }
      case "status":
        sysLine(`${ev.model} · ${ev.mode} · thinking ${ev.think} · context ${ev.context_used}/${ev.context_size}`
          + (ev.goal && ev.goal.text ? ` · goal ${ev.goal.status}` : ""));
        break;
      case "rule_added": sysLine("＋ rule: " + ev.rule); break;
      case "info": sysLine(ev.message); break;
      case "command_rejected": sysLine(ev.message || "Command unavailable while a turn is running", true); break;
      case "request_expired":
        document.querySelectorAll(".card[data-request-id]").forEach((card) => {
          if (card.dataset.requestId === String(ev.id)) resolveCard(card);
        });
        sysLine("Approval request expired; the action was denied.", true); break;
      case "compacted": sysLine("context compacted"); break;
      case "error": speak(`DGC error: ${ev.message}`); sysLine(ev.message, true); if (ev.fatal) { endTurn(); setSending(false); } break;
      case "turn_end": speak(ev.reason === "cancelled" ? "DGC generation stopped" : ev.reason === "error" ? "DGC response ended with an error" : "DGC response complete"); endTurn(); setSending(false); break;
    }
    if (stick) scroll();
  }

  // ---- composer ----
  function setSending(on) { streaming = on; send.innerHTML = `<span class="codicon codicon-${on ? "debug-stop" : "arrow-up"}" aria-hidden="true"></span>`; send.title = on ? "Stop" : "Send"; send.setAttribute("aria-label", on ? "Stop generation" : "Send message"); }
  function doStop() { queuedCount = 0; renderQueued(); vscode.postMessage({ type: "cancel" }); }
  function submit() {
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    const imgs = attachments.filter((a) => a.img).map((a) => a.data);
    const resources = attachments.filter((a) => a.resource).map((a) => a.resource);
    if (text.startsWith("/") && !attachments.length) {
      const name = (text.slice(1).split(/\s+/, 1)[0] || "").toLowerCase();
      const custom = customCommands.includes(name);
      if (custom) {
        const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
        m.appendChild(el("div", "bubble", esc(text))); log.appendChild(m); setSending(true);
      }
      vscode.postMessage({ type: "slashText", text });
      input.value = ""; input.style.height = "auto"; scroll(); return;
    }
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    m.appendChild(el("div", "bubble", esc(text) + attachments.map((a) => `\n[${esc(a.label)}]`).join(""))); log.appendChild(m);
    vscode.postMessage({ type: "prompt", text, images: imgs.length ? imgs : undefined,
      context: resources.length ? resources : undefined });   // backend queues it if a turn is running
    input.value = ""; input.style.height = "auto"; attachments.length = 0; renderAtts(); setSending(true); scroll();
  }
  function renderAtts() {
    atts.innerHTML = "";
    attachments.forEach((a, i) => {
      const chip = el("span", "chip"), label = el("span", "chip-label"), remove = el("button", "x", "×");
      label.textContent = a.label; remove.type = "button"; remove.setAttribute("aria-label", `Remove attachment ${a.label}`);
      remove.onclick = () => { attachments.splice(i, 1); renderAtts(); };
      chip.appendChild(label); chip.appendChild(remove); atts.appendChild(chip);
    });
  }

  // ---- @file / slash popover ----
  function hidePop() { pop.style.display = "none"; popMode = null; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
  function showPop(items) {
    popItems = items; popIdx = 0;
    if (!items.length) return hidePop();
    pop.innerHTML = items.map((it, i) => `<div id="pop-option-${i}" role="option" aria-selected="${i === 0}" class="pi${i === 0 ? " sel" : ""}" data-i="${i}">${esc(it.label)}${it.detail ? ` <span class="pd">${esc(it.detail)}</span>` : ""}</div>`).join("");
    pop.querySelectorAll(".pi").forEach((e) => e.onclick = () => choosePop(Number(e.dataset.i)));
    pop.style.display = "block"; input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-activedescendant", "pop-option-0");
  }
  function movePop(d) { if (popMode) { popIdx = (popIdx + d + popItems.length) % popItems.length; [...pop.children].forEach((c, i) => { const selected = i === popIdx; c.className = "pi" + (selected ? " sel" : ""); c.setAttribute("aria-selected", String(selected)); }); input.setAttribute("aria-activedescendant", `pop-option-${popIdx}`); } }
  function choosePop(i) {
    const it = popItems[i]; if (!it) return;
    if (popMode === "@") {
      attachments.push({ label: it.label, resource: {
        type: "file_mention", uri: it.uri, path: it.path,
        relative_path: it.relative_path, workspace: it.workspace,
      } });
      renderAtts();
      input.value = input.value.slice(0, popStart) + input.value.slice(input.selectionStart);
    } else if (popMode === "/") {
      if (it.acceptsArgs || (it.action && it.action.indexOf("custom:") === 0)) {
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
      const all = builtinCommands.map((c) => ({ label: "/" + c.name, detail: c.description,
        action: c.action, acceptsArgs: c.accepts_args === true,
        aliases: Array.isArray(c.aliases) ? c.aliases : [] }))
        .concat(customCommands.map((c) => ({ label: "/" + c, detail: "custom command", action: "custom:" + c, acceptsArgs: true })));
      const query = v.toLowerCase();
      showPop(all.filter((c) => c.label.toLowerCase().startsWith(query)
        || (c.aliases || []).some((alias) => ("/" + alias).toLowerCase().startsWith(query))));
    }
    else if (at !== -1 && !/\s/.test(upto.slice(at))) {
      popMode = "@"; popStart = at; const q = upto.slice(at + 1).toLowerCase();
      showPop(files.filter((f) => f.label.toLowerCase().includes(q)).slice(0, 8));
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
        if (!SUPPORTED_IMAGE_TYPES.has(String(file.type || "").toLowerCase())) {
          sysLine(`Unsupported pasted image type: ${file.type || "unknown"}.`, true); continue;
        }
        const current = attachments.filter((a) => a.img);
        if (current.length + pendingImageFiles >= MAX_IMAGE_FILES) {
          sysLine(`At most ${MAX_IMAGE_FILES} images can be attached to one prompt.`, true); continue;
        }
        const retainedBytes = current.reduce((total, image) => total + (image.bytes || 0), 0);
        if (file.size > MAX_IMAGE_TOTAL_BYTES
            || retainedBytes + pendingImageBytes + file.size > MAX_IMAGE_TOTAL_BYTES) {
          sysLine("Pasted images exceed the 2 MiB prompt limit.", true); continue;
        }
        pendingImageFiles += 1; pendingImageBytes += file.size;
        const r = new FileReader();
        let settled = false;
        const release = () => {
          if (settled) return; settled = true;
          pendingImageFiles -= 1; pendingImageBytes -= file.size;
        };
        r.onload = () => {
          release();
          if (typeof r.result !== "string" || !r.result.startsWith("data:image/")) {
            sysLine("The pasted image could not be encoded safely.", true); return;
          }
          attachments.push({ label: "📷 image", img: true, data: r.result,
            bytes: file.size, text: "" }); renderAtts();
        };
        r.onerror = () => { release(); sysLine("The pasted image could not be read.", true); };
        r.onabort = release;
        try { r.readAsDataURL(file); }
        catch { release(); sysLine("The pasted image could not be read.", true); }
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
    if (!mm.hidden) { hideModelMenu(); return; }
    mm.innerHTML = `<div class="mhead"><span>Loading…</span></div>`;
    mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true"); hideModeMenu();
    vscode.postMessage({ type: "listModels" });
  };
  const pmodel = $("pmodel"); if (pmodel) pmodel.onclick = () => vscode.postMessage({ type: "pickModel" });
  document.addEventListener("click", (e) => {          // dismiss the picker menus on outside click
    if (!$("modemenu").hidden && !$("btn-mode").contains(e.target) && !$("modemenu").contains(e.target)) hideModeMenu();
    if (!$("modelmenu").hidden && !$("btn-model").contains(e.target) && !$("modelmenu").contains(e.target)) hideModelMenu();
  });

  // ---- settings page ----
  const SET_FIELDS = ["base_url", "api_key", "model", "subagent_model", "subagent_base_url",
    "subagent_api_mode", "subagent_api_key", "fallback_model", "fallback_base_url",
    "fallback_api_mode", "fallback_api_key", "api_mode", "provider_state", "prompt_cache",
    "capability_cache_ttl_s", "mode", "think", "context_size"];
  let settingsReturnFocus = null;
  function fillSettings(cfg) {
    const map = {
      base_url: cfg.base_url, model: cfg.model, mode: cfg.mode, think: cfg.think,
      subagent_model: cfg.subagent_model, subagent_base_url: cfg.subagent_base_url,
      subagent_api_mode: cfg.subagent_api_mode,
      subagent_api_key: "", fallback_model: cfg.fallback_model,
      fallback_base_url: cfg.fallback_base_url, context_size: cfg.context_size,
      fallback_api_mode: cfg.fallback_api_mode, fallback_api_key: "",
      api_mode: cfg.api_mode, provider_state: cfg.provider_state,
      prompt_cache: String(cfg.prompt_cache !== false),
      capability_cache_ttl_s: cfg.capability_cache_ttl_s,
    };
    for (const k in map) { const el = $("s-" + k); if (el && map[k] != null) el.value = map[k]; }
  }
  function openSettings(providers, models) {
    settingsProviders = providers || [];
    $("s-provider").innerHTML = `<option value="">— pick a preset —</option>` +
      settingsProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
    $("s-models").innerHTML = (models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
    if (lastConfig) fillSettings(lastConfig);
    settingsReturnFocus = document.activeElement;
    $("settings").hidden = false;
    $("s-provider").focus();
  }
  function closeSettings() {
    $("settings").hidden = true;
    const target = settingsReturnFocus && typeof settingsReturnFocus.focus === "function"
      ? settingsReturnFocus : $("btn-settings");
    settingsReturnFocus = null; target.focus();
  }
  function collectSettings() {
    const v = {};
    SET_FIELDS.forEach((k) => { const el = $("s-" + k); if (el) v[k] = el.value.trim(); });
    v.prompt_cache = v.prompt_cache !== "false";
    return v;
  }
  $("btn-settings").onclick = () => vscode.postMessage({ type: "openSettings" });
  $("set-close").onclick = closeSettings;
  $("set-cancel").onclick = closeSettings;
  $("set-save").onclick = () => { vscode.postMessage({ type: "saveSettings", values: collectSettings() }); closeSettings(); };
  $("settings").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeSettings(); return; }
    if (e.key !== "Tab") return;
    const focusable = [...$("settings").querySelectorAll("button, input, select, textarea")]
      .filter((node) => !node.disabled && node.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  $("s-provider").onchange = () => {
    const p = settingsProviders.find((x) => x.id === $("s-provider").value);
    if (p) {
      $("s-base_url").value = p.url; $("s-api_mode").value = "auto";
      if (!p.needsKey && !$("s-api_key").value) $("s-api_key").value = "ollama";
    }
  };

  function renderHistory(items) {
    // Non-destructive: replace only the history block, and place it ABOVE any live
    // content. A resumed session's `history` event can arrive AFTER the user has
    // already sent a prompt (slow session load) — clearing the whole log here used
    // to wipe that just-sent prompt while the turn kept streaming.
    log.querySelectorAll(".hist").forEach((e) => e.remove());
    const frag = document.createDocumentFragment();
    items.forEach((it) => {
      if (it.role === "user") {
        const m = el("div", "msg user hist"); m.appendChild(el("div", "role", "you"));
        m.appendChild(el("div", "bubble", esc(it.text))); frag.appendChild(m);
      } else {
        const m = el("div", "msg dgc hist"); m.appendChild(el("div", "role dgc", "DGC"));
        if (it.text) m.appendChild(el("div", "text", md(it.text)));
        if (it.tools && it.tools.length) m.appendChild(el("div", "sys", "▸ " + it.tools.join(", ")));
        frag.appendChild(m);
      }
    });
    log.insertBefore(frag, log.firstChild);   // history above any live user prompt / streaming turn
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
      $("btn-model").setAttribute("aria-label", "Change model. Current model: " + (curModel || "dgc"));
      if (pmodel) { pmodel.textContent = curModel || "dgc"; pmodel.title = "Model: " + (curModel || "dgc") + " — click to change"; pmodel.setAttribute("aria-label", "Change model. Current model: " + (curModel || "dgc")); }
      applyMode(msg.state.mode || "default");
    }
    else if (msg.type === "models") { renderModelMenu(msg.ids || [], msg.current, msg.err); }
    else if (msg.type === "settings_open") { openSettings(msg.providers, msg.models); }
    else if (msg.type === "cleared") { discardTurn(); log.innerHTML = ""; setSending(false); }
    else if (msg.type === "prompt_rejected") { setSending(false); }
    else if (msg.type === "attach" && msg.resource && typeof msg.resource === "object") {
      attachments.push({ label: msg.label, resource: msg.resource }); renderAtts();
    }
    else if (msg.type === "files") {
      files = Array.isArray(msg.files) ? msg.files.filter((file) => file
        && typeof file.label === "string" && typeof file.path === "string"
        && typeof file.uri === "string" && typeof file.relative_path === "string"
        && typeof file.workspace === "string").slice(0, 600) : [];
      if (popMode === "@") onInput();
    }
    else if (msg.type === "backend_exit") { endTurn(); expireOpenRequests(); sysLine("dgc backend exited" + (msg.code ? " (code " + msg.code + ")" : ""), true); setSending(false); }
  });
})();
