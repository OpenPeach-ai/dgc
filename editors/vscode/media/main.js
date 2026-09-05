(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments"), pop = $("pop");
  const goalBar = $("goalbar");
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
  const THINK = ["off", "low", "medium", "high", "xhigh"];
  let curMode = "default", curThink = "off", curModel = "", curSubscription = "", curUltra = false;
  let curWorkers = 4;
  let lastConfig = null, settingsProviders = [];
  let contextState = { used: 0, size: 0, input_tokens: 0, output_tokens: 0,
    cached_input_tokens: 0, reasoning_tokens: 0, requests: 0, compact_threshold: .85 };
  let lastCompaction = null, compacting = false;

  function setThreadTitle(name, sessionId = "", fresh = false) {
    const safeName = String(name || "").replace(/\s+/g, " ").trim();
    const safeId = String(sessionId || "").replace(/[^A-Za-z0-9_-]/g, "");
    const fallback = fresh ? "New chat" : (safeId ? `Chat · ${safeId.slice(-8)}` : "Untitled chat");
    const title = (safeName || fallback).slice(0, 200);
    const node = $("thread-title");
    node.textContent = title;
    node.title = `${title} — click to rename`;
    node.setAttribute("aria-label", `Current chat: ${title}. Click to rename`);
    document.title = `${title} — DGC`;
  }

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
    hideModelMenu(); hideContextMenu();
    mm.innerHTML =
      `<div role="group" aria-label="Permission mode"><div class="mhead" role="presentation"><span>Permission mode</span><kbd>⇧Tab</kbd></div>` +
      MODE_ORDER.map((m) => `<button type="button" role="menuitemradio" aria-checked="${m === curMode}" class="mrow${m === curMode ? " sel" : ""}" data-mode="${m}"><span class="mi codicon codicon-${MODES[m].icon}" aria-hidden="true"></span><span>${m}</span><span class="md">${MODES[m].desc}</span></button>`).join("") +
      `</div>`;
    mm.querySelectorAll("[data-mode]").forEach((r) => r.onclick = () => setMode(r.dataset.mode));
    mm.hidden = false; $("btn-mode").setAttribute("aria-expanded", "true");
    (mm.querySelector(".sel") || mm.querySelector("button"))?.focus();
  }

  // in-composer model menu (rendered from the `models` message the extension posts)
  function hideModelMenu() { $("modelmenu").hidden = true; $("btn-model").setAttribute("aria-expanded", "false"); }
  function hideContextMenu() { $("ctxmenu").hidden = true; $("btn-ctx").setAttribute("aria-expanded", "false"); }
  function fmtTokens(n) { return Number(n || 0).toLocaleString(); }
  function compactionLabel(strategy) {
    return ({ provider_native: "Provider-native", model_summary: "Model summary",
      mechanical: "Safe local fallback", tool_prune: "Local tool-output prune",
      none: "No change" })[strategy] || "Not compacted yet";
  }
  function renderContextMenu() {
    const used = Math.max(0, Number(contextState.used || 0));
    const size = Math.max(0, Number(contextState.size || 0));
    const pct = size ? Math.min(100, Math.round((used / size) * 100)) : 0;
    $("ctx-used").textContent = `${fmtTokens(used)} / ${fmtTokens(size)}`;
    $("ctx-pct").textContent = `${pct}%`;
    $("ctx-fill").style.width = `${pct}%`;
    $("ctx-free").textContent = `${fmtTokens(Math.max(0, size - used))} free`;
    const threshold = Math.max(.01, Math.min(1, Number(contextState.compact_threshold || .85)));
    const thresholdPct = Math.round(threshold * 100);
    $("ctx-auto").textContent = `auto at ${thresholdPct}%`;
    $("ctx-usage").textContent = `${fmtTokens(contextState.input_tokens)} in · ` +
      `${fmtTokens(contextState.output_tokens)} out · ${fmtTokens(contextState.requests)} requests`;
    $("ctx-compact").disabled = compacting;
    $("ctx-compact").textContent = compacting ? "Compacting…" : "Compact now";
    if (lastCompaction) {
      const before = fmtTokens(lastCompaction.before_tokens), after = fmtTokens(lastCompaction.after_tokens);
      $("ctx-last").textContent = `${compactionLabel(lastCompaction.strategy)} · ${before} → ${after}`;
      const detail = String(lastCompaction.fallback_reason || "");
      $("ctx-detail").textContent = detail;
      $("ctx-detail").hidden = !detail;
    } else {
      $("ctx-last").textContent = `DGC compacts automatically near ${thresholdPct}%.`;
      $("ctx-detail").textContent = ""; $("ctx-detail").hidden = true;
    }
  }
  function renderContext() {
    const used = Math.max(0, Number(contextState.used || 0));
    const size = Math.max(0, Number(contextState.size || 0));
    const pct = size ? Math.min(100, Math.round((used / size) * 100)) : 0;
    const threshold = Math.max(.01, Math.min(1, Number(contextState.compact_threshold || .85)));
    $("ctx").textContent = pct + "%";
    $("btn-ctx").classList.toggle("warn", pct >= Math.round(threshold * 100));
    $("btn-ctx").classList.toggle("busy", compacting);
    $("btn-ctx").title = `Context ${fmtTokens(used)} / ${fmtTokens(size)} estimated tokens · ` +
      `provider ${fmtTokens(contextState.input_tokens)} in / ${fmtTokens(contextState.output_tokens)} out · ` +
      `${fmtTokens(contextState.cached_input_tokens)} cached · ${fmtTokens(contextState.reasoning_tokens)} reasoning · ` +
      `${fmtTokens(contextState.requests)} requests · click for details`;
    $("btn-ctx").setAttribute("aria-label", `Context used: ${pct} percent; open context details`);
    renderContextMenu();
  }
  function toggleContextMenu() {
    const menu = $("ctxmenu");
    if (!menu.hidden) { hideContextMenu(); return; }
    hideModelMenu(); hideModeMenu(); renderContextMenu();
    menu.hidden = false; $("btn-ctx").setAttribute("aria-expanded", "true");
    $("ctx-compact").focus();
  }
  function profileMenu(subscription, supportsEffort) {
    const levels = subscription
      ? (supportsEffort === false ? ["off"] : [...THINK, "max"])
      : THINK;
    const profiles = [...levels, "ultra"];
    const selected = curUltra ? "ultra" : curThink;
    const selectedRank = Math.max(0, profiles.indexOf(selected));
    const buttons = profiles.map((profile, index) => {
      const display = profile === "ultra" ? "Ultra"
        : subscription && profile === "off" ? "Default"
          : profile === "xhigh" ? "XHigh" : profile[0].toUpperCase() + profile.slice(1);
      const description = profile === "ultra"
        ? "Deep reasoning + bounded parallel agents"
        : profile === "off" ? (subscription ? "Vendor default" : "No extra reasoning")
          : profile === "max" ? "Vendor maximum" : `${display} reasoning`;
      return `<button type="button" role="menuitemradio" aria-checked="${profile === selected}" aria-label="${display}: ${description}" class="power-stop${index <= selectedRank ? " charged" : ""}${profile === selected ? " selected" : ""}${profile === "ultra" ? " ultra" : ""}" data-profile="${profile}"><span class="power-dot" aria-hidden="true"></span><span>${display}</span></button>`;
    }).join("");
    return `<section class="power-card${curUltra ? " is-ultra" : ""}" aria-label="Reasoning profile"><div class="power-head"><div><span class="power-kicker">Reasoning profile</span><strong>${curUltra ? "Ultra" : (subscription && curThink === "off" ? "Default" : curThink)}</strong></div><span class="power-state">${curUltra ? "DGC fleet active" : "Tune model depth"}</span></div><div class="power-rail">${buttons}</div><p>${curUltra ? `Uses the deepest route-safe effort and up to ${curWorkers} bounded sub-agents. Permissions stay unchanged.` : "Higher levels use more time and tokens. Ultra also coordinates independent sub-agents."}</p></section><div class="mdiv" role="separator"></div>`;
  }
  function bindProfiles(mm) {
    mm.querySelectorAll("[data-profile]").forEach((button) => button.onclick = () => {
      vscode.postMessage({ type: "setReasoningProfile", level: button.dataset.profile });
      hideModelMenu();
    });
  }
  function renderModelMenu(ids, current, err, subscription, label, supportsEffort) {
    const mm = $("modelmenu");
    const profile = profileMenu(subscription, supportsEffort);
    if (subscription) {
      mm.innerHTML = profile + `<div class="mhead"><span>${esc(label || "Subscription")} model</span></div>`
        + `<button type="button" role="menuitemradio" aria-checked="${!current}" class="mrow${!current ? " sel" : ""}" data-default="1"><span class="mi ${!current ? "codicon codicon-check" : ""}" aria-hidden="true"></span><span>CLI default</span></button>`
        + ids.map((id, i) => `<button type="button" role="menuitemradio" aria-checked="${id === current}" class="mrow${id === current ? " sel" : ""}" data-i="${i}"><span class="mi ${id === current ? "codicon codicon-check" : ""}" aria-hidden="true"></span><span>${esc(id)}</span></button>`).join("")
        + `<button type="button" role="menuitem" class="mrow" data-custom="1"><span class="mi codicon codicon-edit" aria-hidden="true"></span><span>Enter another model…</span></button>`;
      bindProfiles(mm);
      mm.querySelector("[data-default]").onclick = () => { vscode.postMessage({ type: "setModel", model: "" }); hideModelMenu(); };
      mm.querySelectorAll("[data-i]").forEach((r) => r.onclick = () => { vscode.postMessage({ type: "setModel", model: ids[+r.dataset.i] }); hideModelMenu(); });
      mm.querySelector("[data-custom]").onclick = () => { vscode.postMessage({ type: "pickModel" }); hideModelMenu(); };
      mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true");
      (mm.querySelector(".sel") || mm.querySelector("button"))?.focus(); return;
    }
    if (err || !ids.length) {
      mm.innerHTML = profile + `<button type="button" role="menuitem" class="mrow" data-connect="1"><span class="mi codicon codicon-plug" aria-hidden="true"></span><span>${err ? "Can’t reach endpoint — connect…" : "No models — connect…"}</span></button>`;
      bindProfiles(mm);
      mm.querySelector("[data-connect]").onclick = () => { vscode.postMessage({ type: "connect" }); hideModelMenu(); };
      mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true"); mm.querySelector("button")?.focus(); return;
    }
    mm.innerHTML = profile + `<div class="mhead"><span>Model</span></div>` +
      ids.map((id, i) => `<button type="button" role="menuitemradio" aria-checked="${id === current}" class="mrow${id === current ? " sel" : ""}" data-i="${i}"><span class="mi ${id === current ? "codicon codicon-check" : ""}" aria-hidden="true"></span><span>${esc(id)}</span></button>`).join("");
    bindProfiles(mm);
    mm.querySelectorAll("[data-i]").forEach((r) => r.onclick = () => { vscode.postMessage({ type: "setModel", model: ids[+r.dataset.i] }); hideModelMenu(); });
    mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true");
    (mm.querySelector(".sel") || mm.querySelector("button"))?.focus();
  }

  function updateModelControl() {
    const model = curModel || "dgc";
    const effort = curUltra ? "Ultra" : (curSubscription && curThink === "off" ? "default" : curThink);
    $("modelname").textContent = model;
    $("effortname").textContent = effort;
    $("btn-model").classList.toggle("ultra", curUltra);
    $("btn-model").title = `${model} · ${effort} reasoning — click to change`;
    $("btn-model").setAttribute("aria-label", `Change model and reasoning. Current model: ${model}. Profile: ${effort}.`);
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
  const TOOL_COPY = {
    read_file: ["Reading", "Read"], glob: ["Finding files", "Found files"], repo_map: ["Mapping repository", "Mapped repository"],
    write_file: ["Writing", "Wrote"], edit_file: ["Editing", "Edited"], apply_patch: ["Applying patch", "Applied patch"], save_memory: ["Saving memory", "Saved memory"],
    bash: ["Running", "Ran"], bash_output: ["Checking process", "Checked process"], bash_kill: ["Stopping process", "Stopped process"],
    grep: ["Searching", "Searched"], web_search: ["Searching the web", "Searched the web"], web_fetch: ["Fetching", "Fetched"],
    present_plan: ["Preparing plan", "Prepared plan"], task: ["Delegating", "Delegated"], todo: ["Updating plan", "Updated plan"], skill: ["Loading skill", "Loaded skill"],
  };
  function toolCopy(name) {
    const known = TOOL_COPY[name];
    if (known) return { present: known[0], past: known[1], target: "" };
    if (String(name).startsWith("mcp__")) {
      return { present: "Calling MCP tool", past: "Called MCP tool",
        target: String(name).slice(5).replaceAll("__", " · ").replaceAll("_", " ") };
    }
    return { present: "Using tool", past: "Used tool", target: String(name || "tool").replaceAll("_", " ") };
  }
  let builtinCommands = [
    { name: "model", description: "pick the model", action: "pickModel" },
    { name: "connect", description: "provider or a custom LAN host", action: "connect" },
    { name: "mode", description: "permission mode", action: "pickMode" },
    { name: "think", description: "how hard the model reasons", action: "pickThink" },
    { name: "ultra", description: "deep reasoning + bounded parallel agents", action: "toggleUltra" },
    { name: "goal", description: "inspect, set, pause, resume, or clear the standing objective", action: "goal", accepts_args: true },
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
    const lastText = [...turn.block.querySelectorAll(".text")].at(-1);
    if (lastText) { lastText.classList.remove("commentary"); lastText.classList.add("final"); }
    turn.act.classList.add("done");
    turn.act.innerHTML = `▸ worked for ${Math.floor((Date.now() - turn.t0) / 1000)}s · ↓ ${Math.round(turn.chars / 4)} tok`;
    turn = null;
  }
  function discardTurn() {
    if (turn) {
      clearInterval(turn.timer);
      turn.block.querySelectorAll(".tool").forEach((card) => clearInterval(card._timer));
    }
    expireOpenRequests();
    turn = null;
  }
  function ensureTurn() { if (!turn) startTurn(); }
  // Keep the live activity row at the visual edge of the active turn. New response text,
  // tool cards, diffs and decisions are inserted immediately before it, so a user following
  // the stream always sees that DGC is still running beneath the newest content.
  function appendTurnContent(node) { turn.block.insertBefore(node, turn.act); return node; }
  function appendConversationContent(node) {
    if (turn) return appendTurnContent(node);
    log.appendChild(node); return node;
  }
  function textBlock() { if (!turn.textEl) { turn.textEl = appendTurnContent(el("div", "text")); } return turn.textEl; }
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
    const copy = toolCopy(card.dataset.toolName || "");
    const verb = card.querySelector(".verb");
    if (verb) {
      verb.textContent = value === "running" ? copy.present
        : value === "completed" ? copy.past
          : value === "failed" ? `${copy.past} · failed`
            : value === "denied" ? `${copy.present} · denied`
              : value === "stopped" ? `${copy.present} · stopped` : copy.past;
    }
    if (value !== "running") {
      clearInterval(card._timer);
      const elapsed = card.querySelector(".tool-time");
      if (elapsed && card._startedAt) elapsed.textContent = `${((Date.now() - card._startedAt) / 1000).toFixed(1)}s`;
    }
  }

  function toolCard(ev) {
    const c = el("div", "tool");
    c.dataset.toolName = String(ev.name || "");
    c._startedAt = Date.now();
    const copy = toolCopy(ev.name);
    const detail = [copy.target, ev.summary || ""].filter(Boolean).join(" · ");
    const bodyId = `tool-output-${++disclosureId}`;
    c.innerHTML = `<div class="head"><button type="button" class="tool-toggle" aria-expanded="false" aria-controls="${bodyId}" title="${esc(ev.name || "tool")}"><span class="chev" aria-hidden="true">›</span><span class="glyph" aria-hidden="true">${glyphFor(ev.name)}</span><span class="verb">${copy.present}</span><span class="arg">${esc(detail)}</span></button></div><div class="body" id="${bodyId}"><pre></pre></div>`;
    const head = c.querySelector(".head");
    const toggle = c.querySelector(".tool-toggle");
    toggle.onclick = () => {
      const open = c.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    };
    if (turn.textEl) turn.textEl.classList.add("commentary");
    if (["read_file", "write_file", "edit_file", "apply_patch"].includes(ev.name) && ev.summary) head.appendChild(openFileBtn(ev.summary));
    const status = el("span", "sr-only tool-status", "running");
    toggle.appendChild(status);
    const dot = el("span", "dot run"); dot.setAttribute("aria-hidden", "true");
    head.appendChild(dot);
    head.appendChild(el("span", "badge"));
    const elapsed = el("span", "tool-time", "0.0s"); head.appendChild(elapsed);
    c._timer = setInterval(() => { elapsed.textContent = `${((Date.now() - c._startedAt) / 1000).toFixed(1)}s`; }, 200);
    setToolStatus(c, "running");
    appendTurnContent(c); breakText(); return c;
  }
  function renderDiff(diff) {
    const wrap = el("div", "diff open");
    const newPath = (diff.match(/^\+\+\+\s+([^\n\t]+)/m) || [])[1];
    const oldPath = (diff.match(/^---\s+([^\n\t]+)/m) || [])[1];
    const rawPath = newPath && newPath !== "/dev/null" ? newPath : oldPath;
    const path = String(rawPath || "changed file").replace(/^[ab]\//, "").replace(/^\/+/, "");
    let additions = 0, deletions = 0, oldLine = null, newLine = null;
    const body = diff.split("\n").map((line) => {
      const hunk = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      let cls = "ctx", oldNo = "", newNo = "";
      if (hunk) { cls = "hh"; oldLine = Number(hunk[1]); newLine = Number(hunk[2]); }
      else if (line.startsWith("---") || line.startsWith("+++")) cls = "hh";
      else if (line.startsWith("+")) { cls = "add"; newNo = newLine ?? ""; if (newLine !== null) newLine++; additions++; }
      else if (line.startsWith("-")) { cls = "del"; oldNo = oldLine ?? ""; if (oldLine !== null) oldLine++; deletions++; }
      else { oldNo = oldLine ?? ""; newNo = newLine ?? ""; if (oldLine !== null) oldLine++; if (newLine !== null) newLine++; }
      return `<span class="${cls}"><span class="ln old">${oldNo}</span><span class="ln new">${newNo}</span><span class="dc">${esc(line) || " "}</span></span>`;
    }).join("");
    const bodyId = `diff-body-${++disclosureId}`;
    wrap.innerHTML = `<div class="dhead"><button type="button" class="diff-toggle" aria-expanded="true" aria-controls="${bodyId}"><span class="chev" aria-hidden="true">⌄</span><span class="dg">✎</span><span class="f">${esc(path)}</span><span class="diff-stat add-stat">+${additions}</span><span class="diff-stat del-stat">−${deletions}</span><span class="diff-action">Hide diff</span></button></div><pre id="${bodyId}">${body}</pre>`;
    const toggle = wrap.querySelector(".diff-toggle");
    toggle.onclick = () => {
      const open = wrap.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".chev").textContent = open ? "⌄" : "›";
      toggle.querySelector(".diff-action").textContent = open ? "Hide diff" : "Review";
    };
    if (path !== "changed file") wrap.querySelector(".dhead").appendChild(openFileBtn(path));
    return wrap;
  }
  function decisionCard(inner, label = "DGC decision") { const c = el("div", "card"); c.setAttribute("role", "group"); c.setAttribute("aria-label", label); c.innerHTML = inner; appendConversationContent(c); breakText(); return c; }
  function requestArtifactStop(id, container, button) {
    if (!id || button.disabled) return;
    container.dataset.artifactId = String(id);
    container.classList.add("stopping");
    button.disabled = true;
    button.textContent = "Stopping…";
    vscode.postMessage({ type: "stopArtifact", id });
  }
  function settleArtifactStop(message) {
    const id = String(message.id || "");
    const targets = [...document.querySelectorAll("[data-artifact-id]")]
      .filter((node) => node.dataset.artifactId === id);
    targets.forEach((node) => {
      const stop = node.querySelector("[data-artifact-stop]");
      node.classList.remove("stopping");
      if (message.state === "stopped") {
        if (node.classList.contains("artifact-list-row")) { node.remove(); return; }
        node.classList.add("stopped");
        node.querySelectorAll("button").forEach((button) => { button.disabled = true; });
        const label = node.querySelector(".anm"); if (label) label.textContent = "Artifact stopped";
        if (stop) stop.textContent = "Stopped";
      } else if (message.state === "error" && stop) {
        stop.disabled = false;
        stop.textContent = "Retry stop";
      }
    });
    if (message.state === "error") {
      sysLine(String(message.error || "DGC could not stop the artifact preview."), true);
    }
  }
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
  function sysLine(msg, isErr) { const line = el("div", "sys" + (isErr ? " err" : ""), esc(msg)); if (isErr) line.setAttribute("role", "alert"); appendConversationContent(line); }

  // ---- standing goal — durable state above the composer, with an active-work clock ----
  let goalState = { text: "", status: "none", elapsed: 0 }, goalObservedAt = Date.now();
  function currentGoalElapsed() {
    return goalState.elapsed + (goalState.status === "active"
      ? Math.max(0, (Date.now() - goalObservedAt) / 1000) : 0);
  }
  function formatDuration(seconds) {
    const total = Math.max(0, Math.floor(seconds || 0));
    const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), secs = total % 60;
    return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
      : `${minutes}:${String(secs).padStart(2, "0")}`;
  }
  function paintGoalClock() { if (!goalBar.hidden) $("goal-time").textContent = formatDuration(currentGoalElapsed()); }
  function setGoalState(next) {
    const text = String(next?.text ?? next?.goal ?? "");
    const status = text ? String(next?.status || "active") : "none";
    const priorElapsed = currentGoalElapsed();
    const explicit = Number(next?.elapsed_seconds);
    goalState = { text, status,
      elapsed: Number.isFinite(explicit) && explicit >= 0 ? explicit
        : (text === goalState.text ? priorElapsed : 0) };
    goalObservedAt = Date.now();
    goalBar.hidden = !text;
    if (!text) return;
    $("goal-text").textContent = text;
    const paused = status === "blocked", completed = status === "completed";
    $("goal-status").textContent = paused ? "Paused goal" : completed ? "Completed goal" : "Active goal";
    goalBar.dataset.status = status;
    const toggle = $("goal-toggle"), icon = toggle.querySelector(".codicon");
    toggle.hidden = false;
    const resume = paused || completed;
    icon.className = `codicon codicon-${resume ? "debug-continue" : "debug-pause"}`;
    toggle.title = resume ? "Resume goal" : "Pause goal";
    toggle.setAttribute("aria-label", resume ? "Resume standing goal" : "Pause standing goal");
    paintGoalClock();
  }
  const goalClockTimer = setInterval(paintGoalClock, 500);
  if (goalClockTimer && typeof goalClockTimer.unref === "function") goalClockTimer.unref();

  // ---- dedicated non-chat surfaces (skills, MCP, docs, permissions, memory, hooks) ----
  const SURFACE_META = {
    skills: ["Skills", "library"], mcp: ["MCP servers", "plug"],
    docs: ["Documentation", "book"], permissions: ["Permission rules", "shield"],
    memory: ["Memory", "bookmark"], hooks: ["Lifecycle hooks", "run-all"],
  };
  let surfaceKind = "", surfaceReturnFocus = null, surfaceRows = [], mcpRows = [], mcpTools = [];
  const surfaceBody = $("surface-body"), surfaceSearch = $("surface-search");
  function openSurface(kind) {
    if (!SURFACE_META[kind]) return;
    surfaceKind = kind;
    if ($("surface").hidden) surfaceReturnFocus = document.activeElement;
    $("surface-title-text").textContent = SURFACE_META[kind][0];
    $("surface-icon").className = "codicon codicon-" + SURFACE_META[kind][1];
    $("surface").hidden = false; surfaceSearch.value = "";
    surfaceBody.innerHTML = '<div class="surface-empty">Loading…</div>';
    $("surface-primary").hidden = true; $("surface-secondary").hidden = true;
    surfaceSearch.focus();
  }
  function closeSurface() {
    $("surface").hidden = true; surfaceKind = "";
    const target = surfaceReturnFocus && typeof surfaceReturnFocus.focus === "function"
      ? surfaceReturnFocus : input;
    surfaceReturnFocus = null; target.focus();
  }
  function surfaceButtons(primary, primaryAction, secondary, secondaryAction) {
    const p = $("surface-primary"), s = $("surface-secondary");
    p.hidden = !primary; p.textContent = primary || ""; p.onclick = primaryAction || null;
    s.hidden = !secondary; s.textContent = secondary || ""; s.onclick = secondaryAction || null;
  }
  function filterSurface() {
    const query = surfaceSearch.value.trim().toLowerCase();
    surfaceBody.querySelectorAll("[data-filter]").forEach((node) => {
      node.hidden = Boolean(query) && !String(node.dataset.filter || "").includes(query);
    });
  }
  function useSkill(name) {
    input.value = `$${name} `; input.selectionStart = input.selectionEnd = input.value.length;
    closeSurface(); input.focus(); input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function renderSkills(items) {
    surfaceRows = Array.isArray(items) ? items : [];
    openSurface("skills");
    surfaceBody.innerHTML = surfaceRows.length ? surfaceRows.map((skill, i) =>
      `<article class="surface-card" data-filter="${esc(`${skill.name} ${skill.source} ${skill.description}`.toLowerCase())}"><div class="surface-card-head"><button type="button" class="surface-name" data-skill-view="${i}">$${esc(skill.name)}</button><span class="surface-badge">${esc(skill.source || "unknown")}</span></div><p>${esc(skill.description || "Reusable agent instructions")}</p><div class="surface-actions"><button type="button" class="act primary" data-skill-use="${i}">Use skill</button><button type="button" class="act" data-skill-view="${i}">View instructions</button></div></article>`).join("")
      : '<div class="surface-empty">No skills are installed. Add a project skill at <code>.dgc/skills/&lt;name&gt;/SKILL.md</code>.</div>';
    surfaceBody.querySelectorAll("[data-skill-use]").forEach((button) => button.onclick = () => useSkill(surfaceRows[+button.dataset.skillUse].name));
    surfaceBody.querySelectorAll("[data-skill-view]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "getSkill", name: surfaceRows[+button.dataset.skillView].name }));
    surfaceButtons("Reload", () => vscode.postMessage({ type: "skillsReload" }));
    filterSurface();
  }
  function renderSkillDetail(ev) {
    openSurface("skills");
    if (!ev.found) { surfaceBody.innerHTML = '<div class="surface-empty">That skill is no longer installed.</div>'; return; }
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← All skills</button><div class="surface-detail-head"><h2>$${esc(ev.name)}</h2><span class="surface-badge">${esc(ev.source)}</span></div><p class="muted">${esc(ev.description || "")}</p><div class="surface-markdown">${md(ev.markdown || "")}</div>`;
    surfaceBody.querySelector(".surface-back").onclick = () => renderSkills(surfaceRows);
    surfaceButtons("Use skill", () => useSkill(ev.name));
  }
  function mcpStateClass(value) { return ["connected", "configured"].includes(value) ? "ok" : value === "failed" ? "err" : ""; }
  function showMcpForm(item) {
    const value = item || { name: "", transport: "stdio", command: "", args: [], env_names: [], url: "", log_level: "warning" };
    const remote = value.transport === "remote";
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← MCP servers</button><form id="mcp-config-form" class="surface-form"><input id="mcp-original" type="hidden" value="${esc(value.name || "")}"><label>Server name<input id="mcp-name" required maxlength="64" pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" value="${esc(value.name || "")}" placeholder="github"></label><label>Transport<select id="mcp-transport"><option value="stdio"${remote ? "" : " selected"}>Local STDIO</option><option value="remote"${remote ? " selected" : ""}>Remote Streamable HTTP (via mcp-remote)</option></select></label><label id="mcp-target-label">${remote ? "Server URL" : "Command"}<input id="mcp-target" required value="${esc(remote ? value.url : value.command)}" placeholder="${remote ? "https://mcp.example.com/mcp" : "npx"}"></label><label id="mcp-args-label">Arguments <span class="set-hint">one argument per line; no shell parsing</span><textarea id="mcp-args" rows="4" spellcheck="false">${esc((value.args || []).join("\n"))}</textarea></label><label id="mcp-env-label">Environment <span class="set-hint">KEY=value → SecretStorage · KEY → ambient lookup</span><textarea id="mcp-env" rows="4" spellcheck="false" placeholder="${esc((value.env_names || []).map((name) => `${name}=…`).join("\n") || "GITHUB_TOKEN=…")}"></textarea></label><label id="mcp-token-label">Bearer token <span class="set-hint">blank preserves the saved token</span><input id="mcp-token" type="password" spellcheck="false" placeholder="optional"></label><label class="surface-check"><input id="mcp-clear-secrets" type="checkbox"> Clear stored credentials before saving</label><label>Log level<select id="mcp-log"><option>warning</option><option>info</option><option>debug</option><option>error</option><option>off</option></select></label><div class="surface-actions"><button type="submit" class="act primary">Save and connect</button><button type="button" class="act" id="mcp-cancel">Cancel</button></div></form>`;
    $("mcp-log").value = value.log_level || "warning";
    const updateTransport = () => {
      const isRemote = $("mcp-transport").value === "remote";
      $("mcp-target-label").firstChild.textContent = isRemote ? "Server URL" : "Command";
      $("mcp-args-label").hidden = isRemote; $("mcp-env-label").hidden = isRemote;
      $("mcp-token-label").hidden = !isRemote;
    };
    $("mcp-transport").onchange = updateTransport; updateTransport();
    surfaceBody.querySelector(".surface-back").onclick = () => renderMcp();
    $("mcp-cancel").onclick = () => renderMcp();
    $("mcp-config-form").onsubmit = (event) => {
      event.preventDefault();
      if (!event.target.reportValidity()) return;
      vscode.postMessage({ type: "mcpSave", values: {
        original_name: $("mcp-original").value, name: $("mcp-name").value,
        transport: $("mcp-transport").value, target: $("mcp-target").value,
        args: $("mcp-args").value, env: $("mcp-env").value,
        env_names: value.env_names || [], token: $("mcp-token").value,
        clear_secrets: $("mcp-clear-secrets").checked,
        log_level: $("mcp-log").value,
      } });
      surfaceBody.innerHTML = '<div class="surface-empty">Saving and connecting…</div>';
    };
    surfaceButtons(); $("mcp-name").focus();
  }
  function renderMcp() {
    openSurface("mcp");
    const servers = mcpRows.length ? mcpRows.map((item, i) =>
      `<article class="surface-card" data-filter="${esc(`${item.name} ${item.state} ${item.command} ${item.url}`.toLowerCase())}"><div class="surface-card-head"><strong>${esc(item.name)}</strong><span class="surface-state ${mcpStateClass(item.state)}">${esc(item.state || "configured")}</span></div><div class="surface-meta">${esc(item.transport === "remote" ? item.url : [item.command, ...(item.args || [])].join(" "))}</div><p>${Number(item.tool_count || 0)} tool(s)${item.protocol_era ? ` · ${esc(item.protocol_era)}` : ""}</p>${item.error ? `<div class="err">${esc(item.error)}</div>` : ""}<div class="surface-actions"><button type="button" class="act" data-mcp-edit="${i}">Edit</button><button type="button" class="act danger" data-mcp-remove="${i}">Remove</button></div></article>`).join("")
      : '<div class="surface-empty">No MCP servers configured.</div>';
    const tools = mcpTools.length ? `<h2 class="surface-subtitle">Available tools · ${mcpTools.length}</h2>${mcpTools.map((tool) => `<article class="surface-card compact" data-filter="${esc(`${tool.name} ${tool.description}`.toLowerCase())}"><strong>${esc(tool.name)}</strong><p>${esc(tool.description || "")}</p></article>`).join("")}` : "";
    surfaceBody.innerHTML = servers + tools;
    surfaceBody.querySelectorAll("[data-mcp-edit]").forEach((button) => button.onclick = () => showMcpForm(mcpRows[+button.dataset.mcpEdit]));
    surfaceBody.querySelectorAll("[data-mcp-remove]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "mcpRemove", name: mcpRows[+button.dataset.mcpRemove].name }));
    surfaceButtons("Add server", () => showMcpForm(), "Reload", () => vscode.postMessage({ type: "mcpReload" }));
    filterSurface();
  }
  function renderDocs(items) {
    surfaceRows = Array.isArray(items) ? items : []; openSurface("docs");
    surfaceBody.innerHTML = surfaceRows.map((doc, i) => `<button type="button" class="surface-card surface-list-button" data-doc="${i}" data-filter="${esc(`${doc.title} ${doc.description}`.toLowerCase())}"><strong>${esc(doc.title)}</strong><span>${esc(doc.description)}</span></button>`).join("") || '<div class="surface-empty">No documentation is bundled.</div>';
    surfaceBody.querySelectorAll("[data-doc]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "getDoc", id: surfaceRows[+button.dataset.doc].id }));
    surfaceButtons(); filterSurface();
  }
  function renderDoc(ev) {
    openSurface("docs");
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← Documentation</button><div class="surface-markdown">${ev.found ? md(ev.markdown || "") : "Page not found."}</div>`;
    surfaceBody.querySelector(".surface-back").onclick = () => renderDocs(surfaceRows);
    surfaceButtons();
  }
  function renderPermissions(items) {
    surfaceRows = Array.isArray(items) ? items : []; openSurface("permissions");
    surfaceBody.innerHTML = `<form id="permission-form" class="surface-inline-form"><select id="permission-action" aria-label="Rule action"><option>deny</option><option>ask</option><option>allow</option></select><input id="permission-rule" required aria-label="Permission rule" placeholder="Bash(npm test *)"><button class="act primary" type="submit">Add</button></form>` + (surfaceRows.map((rule, i) => `<article class="surface-card compact" data-filter="${esc(`${rule.action} ${rule.rule}`.toLowerCase())}"><div class="surface-card-head"><span class="surface-badge ${esc(rule.action)}">${esc(rule.action)}</span><code>${esc(rule.rule)}</code><button type="button" class="icon-action" aria-label="Remove rule" data-rule-remove="${i}">×</button></div></article>`).join("") || '<div class="surface-empty">No custom permission rules. Mode defaults still apply.</div>');
    $("permission-form").onsubmit = (event) => { event.preventDefault(); vscode.postMessage({ type: "permissionAdd", action: $("permission-action").value, rule: $("permission-rule").value }); };
    surfaceBody.querySelectorAll("[data-rule-remove]").forEach((button) => button.onclick = () => { const rule = surfaceRows[+button.dataset.ruleRemove]; vscode.postMessage({ type: "permissionRemove", action: rule.action, rule: rule.rule }); });
    surfaceButtons(); filterSurface();
  }
  function renderMemory(ev) {
    openSurface("memory");
    const block = (title, value) => `<section><h2 class="surface-subtitle">${title}</h2><div class="surface-markdown">${value ? md(value) : '<p class="muted">No memory saved.</p>'}</div></section>`;
    surfaceBody.innerHTML = (ev.message ? `<div class="surface-notice">${esc(ev.message)}</div>` : "") + block("Project · DGC.md", ev.project) + block("Personal · ~/.dgc/DGC.md", ev.user);
    const add = (scope) => {
      surfaceBody.innerHTML = `<button type="button" class="surface-back">← Memory</button><form id="memory-form" class="surface-form"><label>Add ${scope} memory<textarea id="memory-text" required rows="6" maxlength="8000" placeholder="A durable fact or preference DGC should remember"></textarea></label><button class="act primary" type="submit">Save memory</button></form>`;
      surfaceBody.querySelector(".surface-back").onclick = () => renderMemory(ev);
      $("memory-form").onsubmit = (event) => { event.preventDefault(); vscode.postMessage({ type: "memoryAdd", scope, text: $("memory-text").value }); };
      surfaceButtons(); $("memory-text").focus();
    };
    surfaceButtons("Add project memory", () => add("project"), "Add personal memory", () => add("user"));
  }
  function renderHooks(ev) {
    openSurface("hooks");
    const items = Array.isArray(ev.items) ? ev.items : [];
    surfaceBody.innerHTML = (Number(ev.invalid || 0) ? `<div class="err surface-notice">${Number(ev.invalid)} invalid or unsupported hook entries</div>` : "") + items.map((hook) => `<article class="surface-card compact" data-filter="${esc(`${hook.event} ${(hook.matchers || []).join(" ")}`.toLowerCase())}"><div class="surface-card-head"><strong>${esc(hook.event)}</strong><span class="surface-state ${hook.valid ? "ok" : "err"}">${hook.valid ? "ready" : "invalid"}</span></div><p>${Number(hook.configured || 0)} configured${hook.matchers?.length ? ` · ${esc(hook.matchers.join(", "))}` : ""}</p></article>`).join("");
    surfaceButtons("Reload", () => vscode.postMessage({ type: "slash", action: "hooks" })); filterSurface();
  }
  surfaceSearch.addEventListener("input", filterSurface);
  $("surface-close").onclick = closeSurface;
  $("surface").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeSurface(); return; }
    if (event.key !== "Tab") return;
    const focusable = [...$("surface").querySelectorAll("button, input, select, textarea, [tabindex]")]
      .filter((node) => !node.disabled && !node.hidden && !node.closest("[hidden]")
        && node.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

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
        setThreadTitle(ev.session_name, ev.session_id, !ev.session_name);
        break;
      }
      case "context": {
        contextState = { ...contextState, ...ev };
        renderContext();
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
        setThreadTitle(ev.name, ev.session_id, ev.kind === "cleared" || ev.kind === "new");
        break;
      case "session_named": setThreadTitle(ev.name); break;
      case "config":
        lastConfig = ev;
        curUltra = ev.ultra_mode === true;
        curWorkers = Math.max(1, Math.min(8, Number(ev.max_parallel_tasks || 4)));
        updateModelControl();
        document.body.classList.toggle("hide-reasoning", ev.show_reasoning === false);
        if (!$("settings").hidden) fillSettings(ev);
        break;
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
          appendTurnContent(d); appendTurnContent(r); turn.reasonEl = r;
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
        if (ev.is_error) {
          c.classList.add("open"); c.querySelector(".tool-toggle").setAttribute("aria-expanded", "true");
        }
        if (ev.is_diff && ev.diff) appendTurnContent(renderDiff(ev.diff));
        else { const out = String(ev.output || ""); c.querySelector(".body pre").textContent = out.slice(0, 4000); c.querySelector(".badge").textContent = out.split("\n").length + " ln"; }
        breakText(); break;
      }
      case "tool_denied": {
        ensureTurn();
        turn._tools = turn._tools || {};
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name, summary: ev.reason }));
        c.querySelector(".dot").className = "dot deny";
        setToolStatus(c, "denied");
        c.classList.add("open"); c.querySelector(".tool-toggle").setAttribute("aria-expanded", "true");
        break;
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
        if (!turn._todo) { turn._todo = appendTurnContent(el("div", "todos")); }
        const TG = { pending: ["□", "pend"], in_progress: ["▶", "doing"], done: ["✓", "done"], cancelled: ["✗", "cancel"] };
        const dn = ev.todos.filter((t) => t.status === "done").length;
        turn._todo.innerHTML = `<div class="thead">Tasks <span>${dn}/${ev.todos.length}</span></div>` +
          ev.todos.map((t) => { const g = TG[t.status] || TG.pending;
            return `<div class="t ${g[1]}"><span class="ti">${g[0]}</span><span class="tc">${esc(t.content)}</span></div>`; }).join("");
        break;
      }
      case "artifact_ready": {
        ensureTurn();
        const c = el("div", "artifact"); c.dataset.artifactId = String(ev.id || "");
        c.innerHTML = `<div class="ahead"><span class="aico" aria-hidden="true">▶</span><span class="anm">Artifact ready</span><span class="alabel">${esc(ev.name)}</span></div><button type="button" class="aurl">${esc(ev.url)}</button>`;
        const row = el("div", "abtns");
        const open = el("button", "abtn primary", "Open in browser"); open.type = "button";
        open.onclick = () => vscode.postMessage({ type: "openExternal", url: ev.url });
        const stop = el("button", "abtn", "Stop"); stop.type = "button"; stop.dataset.artifactStop = "1";
        stop.onclick = () => requestArtifactStop(ev.id, c, stop);
        row.appendChild(open); row.appendChild(stop); c.appendChild(row);
        c.querySelector(".aurl").onclick = () => vscode.postMessage({ type: "openExternal", url: ev.url });
        appendTurnContent(c); breakText();
        break;
      }
      case "artifacts": {
        const items = ev.items || [];
        if (!items.length) {
          if (!String(ev.request_id || "").startsWith("artifact-stop-")) {
            sysLine("No artifact previews are running.");
          }
          break;
        }
        const c = decisionCard(`<div class="q"><span class="codicon codicon-preview"></span> Artifacts</div><div class="artifact-list"></div>`);
        const list = c.querySelector(".artifact-list");
        items.forEach((a) => {
          const row = el("div", "abtns artifact-list-row"); row.dataset.artifactId = String(a.id || "");
          const open = el("button", "abtn primary", `${a.name} · open`); open.type = "button";
          open.onclick = () => vscode.postMessage({ type: "openExternal", url: a.url });
          const stop = el("button", "abtn", "Stop"); stop.type = "button"; stop.dataset.artifactStop = "1";
          stop.onclick = () => requestArtifactStop(a.id, row, stop);
          row.appendChild(open); row.appendChild(stop); list.appendChild(row);
        });
        break;
      }
      case "saved_plan":
        if (ev.exists) decisionCard(`<div class="q"><span class="codicon codicon-checklist"></span> Saved plan</div><pre>${esc(ev.plan)}</pre>`);
        else sysLine("No saved plan yet — switch to plan mode and ask DGC to propose one.");
        break;
      case "skill_catalog": {
        if (surfaceKind === "skills") renderSkills(ev.items);
        break;
      }
      case "skill_detail": if (surfaceKind === "skills") renderSkillDetail(ev); break;
      case "docs_catalog": if (surfaceKind === "docs") renderDocs(ev.items); break;
      case "doc": if (surfaceKind === "docs") renderDoc(ev); break;
      case "mcp_servers":
        mcpRows = Array.isArray(ev.items) ? ev.items : [];
        if (surfaceKind === "mcp") renderMcp();
        if (ev.error && surfaceKind === "mcp") {
          const warning = el("div", "err surface-notice", esc(ev.error));
          surfaceBody.insertBefore(warning, surfaceBody.firstChild);
        }
        break;
      case "mcp_tools":
        mcpTools = Array.isArray(ev.tools) ? ev.tools : [];
        if (surfaceKind === "mcp") renderMcp();
        break;
      case "permissions": if (surfaceKind === "permissions") renderPermissions(ev.items); break;
      case "memory": if (surfaceKind === "memory") renderMemory(ev); break;
      case "hook_catalog": {
        if (surfaceKind === "hooks") renderHooks(ev);
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
        setGoalState({ text, status: ev.status, elapsed_seconds: ev.elapsed_seconds });
        sysLine(text ? `Standing goal · ${ev.status}: ${text}` : "Standing goal cleared");
        break;
      }
      case "status":
        sysLine(`${ev.model} · ${ev.mode} · thinking ${ev.think} · context ${ev.context_used}/${ev.context_size}`
          + (ev.ultra_mode ? " · Ultra" : "")
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
      case "compacted": {
        compacting = false; lastCompaction = ev;
        contextState = { ...contextState, used: ev.after_tokens, size: ev.context_size };
        renderContext();
        const before = fmtTokens(ev.before_tokens), after = fmtTokens(ev.after_tokens);
        const lead = ev.status === "unchanged" ? "Context unchanged"
          : ev.strategy === "tool_prune" ? "Context pruned"
            : ev.strategy === "provider_native" ? "Context compacted natively"
              : ev.strategy === "mechanical" ? "Context compacted safely on-device"
                : "Context compacted";
        sysLine(`${lead} · ${before} → ${after} estimated tokens`);
        break;
      }
      case "error": speak(`DGC error: ${ev.message}`); sysLine(ev.message, true); if (ev.fatal) { endTurn(); setSending(false); } break;
      case "turn_end": speak(ev.reason === "cancelled" ? "DGC generation stopped" : ev.reason === "error" ? "DGC response ended with an error" : "DGC response complete"); endTurn(); setSending(false); break;
    }
    if (stick) scroll();
  }

  // ---- composer ----
  function setSending(on) { streaming = on; send.innerHTML = `<span class="codicon codicon-${on ? "debug-stop" : "arrow-up"}" aria-hidden="true"></span>`; send.title = on ? "Stop" : "Send"; send.setAttribute("aria-label", on ? "Stop generation" : "Send message"); }
  function doStop() { queuedCount = 0; renderQueued(); vscode.postMessage({ type: "cancel" }); }
  $("goal-toggle").onclick = () => vscode.postMessage({
    type: "slashText", text: goalState.status === "active" ? "/goal pause" : "/goal resume",
  });
  $("goal-clear").onclick = () => vscode.postMessage({ type: "slashText", text: "/goal clear" });
  $("goal-edit").onclick = () => {
    input.value = `/goal ${goalState.text}`; input.selectionStart = input.selectionEnd = input.value.length;
    input.focus(); onInput();
  };
  function submit() {
    const text = input.value.trim();
    if (!text && !attachments.length) return;
    const imgs = attachments.filter((a) => a.img).map((a) => a.data);
    const resources = attachments.filter((a) => a.resource).map((a) => a.resource);
    if (text.startsWith("/") && !attachments.length) {
      const name = (text.slice(1).split(/\s+/, 1)[0] || "").toLowerCase();
      const custom = customCommands.includes(name);
      const rest = text.slice(name.length + 1).trim();
      const goalStateCommand = ["clear", "off", "none", "remove", "complete", "completed",
        "done", "blocked", "block", "pause", "paused", "resume", "active", "reactivate"];
      const startsGoal = name === "goal" && rest && !goalStateCommand.includes(rest.toLowerCase());
      if (custom || startsGoal) {
        const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
        if (startsGoal) {
          m.classList.add("goal-prompt");
          m.querySelector(".role").textContent = "goal";
          m.appendChild(el("div", "bubble", esc(rest)));
        } else {
          m.appendChild(el("div", "bubble", esc(text)));
        }
        log.appendChild(m); setSending(true);
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
  $("btn-ctx").onclick = (e) => { e.stopPropagation(); toggleContextMenu(); };
  $("ctx-compact").onclick = () => {
    if (compacting) return;
    compacting = true; renderContext();
    vscode.postMessage({ type: "compact" });
  };
  $("ctxmenu").addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); hideContextMenu(); $("btn-ctx").focus(); }
  });
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
    mm.hidden = false; $("btn-model").setAttribute("aria-expanded", "true"); hideModeMenu(); hideContextMenu();
    vscode.postMessage({ type: "listModels" });
  };
  const pmodel = $("pmodel"); if (pmodel) pmodel.onclick = () => vscode.postMessage({ type: "pickModel" });
  $("thread-title").onclick = () => vscode.postMessage({ type: "slashText", text: "/name" });
  document.addEventListener("click", (e) => {          // dismiss the picker menus on outside click
    if (!$("modemenu").hidden && !$("btn-mode").contains(e.target) && !$("modemenu").contains(e.target)) hideModeMenu();
    if (!$("modelmenu").hidden && !$("btn-model").contains(e.target) && !$("modelmenu").contains(e.target)) hideModelMenu();
    if (!$("ctxmenu").hidden && !$("btn-ctx").contains(e.target) && !$("ctxmenu").contains(e.target)) hideContextMenu();
  });

  // ---- settings page ----
  const SET_FIELDS = ["base_url", "api_key", "model", "subagent_model", "subagent_base_url",
    "subagent_api_mode", "subagent_api_key", "fallback_model", "fallback_base_url",
    "fallback_api_mode", "fallback_api_key", "api_mode", "provider_state", "prompt_cache",
    "capability_cache_ttl_s", "mode", "think", "context_size", "sandbox",
    "sandbox_network", "show_reasoning", "ultra_mode", "suggest", "plan_artifact", "artifact_autostart",
    "artifact_in_plan", "tool_profile", "max_parallel_tasks",
    "subscription_engine", "subscription_model", "subscription_effort"];
  const SET_BOOLEAN_FIELDS = new Set(["prompt_cache", "sandbox", "sandbox_network",
    "show_reasoning", "ultra_mode", "suggest", "plan_artifact", "artifact_autostart", "artifact_in_plan"]);
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
      sandbox: String(cfg.sandbox === true), sandbox_network: String(cfg.sandbox_network === true),
      show_reasoning: String(cfg.show_reasoning !== false), suggest: String(cfg.suggest !== false),
      ultra_mode: String(cfg.ultra_mode === true),
      plan_artifact: String(cfg.plan_artifact !== false),
      artifact_autostart: String(cfg.artifact_autostart !== false),
      artifact_in_plan: String(cfg.artifact_in_plan === true),
      tool_profile: cfg.tool_profile || "adaptive",
      max_parallel_tasks: cfg.max_parallel_tasks || 4,
      subscription_engine: cfg.subscription_engine || "",
      subscription_model: cfg.subscription_model || "",
      subscription_effort: cfg.subscription_effort || "",
    };
    for (const k in map) { const el = $("s-" + k); if (el && map[k] != null) el.value = map[k]; }
    const subscriptionSelect = $("s-subscription_engine");
    if (subscriptionSelect) subscriptionSelect.dataset.loadedValue = map.subscription_engine;
    updateSubscriptionFields();
    renderSubscriptionStatus(cfg);
  }
  function updateSubscriptionFields() {
    const engine = $("s-subscription_engine")?.value || "";
    const effort = $("s-subscription_effort");
    if (effort) {
      effort.disabled = engine === "qwen" || engine === "kimi" || !engine;
      if (effort.disabled) effort.value = "";
    }
  }
  function renderSubscriptionStatus(cfg) {
    const box = $("s-subscription_status");
    if (!box) return;
    const active = cfg.subscription_engine || "";
    const list = Array.isArray(cfg.subscription_engines) ? cfg.subscription_engines : [];
    if (!active) { box.textContent = "off — DGC drives the model above directly."; return; }
    const s = list.find((e) => e && e.key === active);
    if (!s) { box.textContent = ""; return; }
    if (!s.installed) box.textContent = s.label + ": CLI not installed.";
    else if (s.auth_state === "check_on_launch") {
      box.textContent = s.label + ": authentication is checked securely by its CLI on launch.";
    }
    else if (!s.logged_in) box.textContent = s.label + ": not signed in — run  " + s.login_cmd;
    else box.textContent = s.label + ": signed in ✓ — turns run through your subscription.";
  }
  function showSettingsSection(section) {
    const wanted = ["general", "models", "agents", "security", "extensions"].includes(section)
      ? section : "general";
    document.querySelectorAll(".set-section").forEach((node) => { node.hidden = node.dataset.section !== wanted; });
    document.querySelectorAll(".set-tab").forEach((button) => {
      const active = button.dataset.section === wanted;
      button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
    });
    const first = $(`settings`).querySelector(`.set-section[data-section="${wanted}"] input, .set-section[data-section="${wanted}"] select, .set-section[data-section="${wanted}"] button`);
    if (first) first.focus();
  }
  function openSettings(providers, models, section) {
    settingsProviders = providers || [];
    $("s-provider").innerHTML = `<option value="">— pick a preset —</option>` +
      settingsProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
    $("s-models").innerHTML = (models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
    if (lastConfig) fillSettings(lastConfig);
    settingsReturnFocus = document.activeElement;
    $("settings").hidden = false;
    showSettingsSection(section || "general");
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
    SET_BOOLEAN_FIELDS.forEach((key) => { v[key] = v[key] !== "false"; });
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
      const se = $("s-subscription_engine"); if (se) se.value = "";   // a direct provider turns delegation off
      const sm = $("s-subscription_model"); if (sm) sm.value = "";
      const sf = $("s-subscription_effort"); if (sf) sf.value = "";
      updateSubscriptionFields();
      if (!p.needsKey && !$("s-api_key").value) $("s-api_key").value = "ollama";
    }
  };
  const subscriptionEngine = $("s-subscription_engine");
  if (subscriptionEngine) subscriptionEngine.onchange = () => {
    if (subscriptionEngine.value !== subscriptionEngine.dataset.loadedValue) {
      const model = $("s-subscription_model"); if (model) model.value = "";
      const effort = $("s-subscription_effort"); if (effort) effort.value = "";
      subscriptionEngine.dataset.loadedValue = subscriptionEngine.value;
    }
    updateSubscriptionFields();
  };
  document.querySelectorAll(".set-tab").forEach((button) => button.onclick = () => showSettingsSection(button.dataset.section));
  document.querySelectorAll("[data-open-surface]").forEach((button) => button.onclick = () => {
    closeSettings(); vscode.postMessage({ type: "slash", action: button.dataset.openSurface });
  });

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
        if (it.text) m.appendChild(el("div", "text final", md(it.text)));
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
      curSubscription = msg.state.subscriptionEngine || "";
      curUltra = msg.state.ultra === true;
      updateModelControl();
      if (pmodel) { pmodel.textContent = curModel || "dgc"; pmodel.title = "Model: " + (curModel || "dgc") + " — click to change"; pmodel.setAttribute("aria-label", "Change model. Current model: " + (curModel || "dgc")); }
      applyMode(msg.state.mode || "default");
      setGoalState(msg.state.goal || { text: "", status: "none", elapsed_seconds: 0 });
    }
    else if (msg.type === "models") { renderModelMenu(msg.ids || [], msg.current, msg.err, msg.subscription, msg.label, msg.supportsEffort); }
    else if (msg.type === "settings_open") { openSettings(msg.providers, msg.models, msg.section); }
    else if (msg.type === "surface_open") { openSurface(msg.surface); }
    else if (msg.type === "command_menu") {
      input.value = "/"; input.selectionStart = input.selectionEnd = 1; input.focus(); onInput();
    }
    else if (msg.type === "composer_text") {
      input.value = String(msg.text || ""); input.selectionStart = input.selectionEnd = input.value.length;
      input.focus(); onInput();
    }
    else if (msg.type === "cleared") { discardTurn(); log.innerHTML = ""; setSending(false); }
    else if (msg.type === "prompt_rejected") { setSending(false); }
    else if (msg.type === "goal_start_state") {
      if (msg.state === "error") {
        setSending(false);
        sysLine(String(msg.error || "DGC could not start the goal."), true);
      }
    }
    else if (msg.type === "compact_state") {
      compacting = msg.state === "working";
      renderContext();
      if (msg.error) sysLine(String(msg.error), true);
    }
    else if (msg.type === "artifact_stop_state") settleArtifactStop(msg);
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
  vscode.postMessage({ type: "webviewReady" });
})();
