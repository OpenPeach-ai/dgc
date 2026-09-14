(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments"), pop = $("pop");
  const goalBar = $("goalbar"), changesBar = $("changesbar"), tasksBar = $("tasksbar"), composerRail = $("composer-rail");
  const monitorsBar = $("monitorsbar");
  const announcer = $("announcer");
  const queuedEl = $("queued");
  const MAX_IMAGE_FILES = 4, MAX_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;
  const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
  const PASTED_TEXT_LIMIT = 5000;   // characters; past this a paste becomes an attachment
  let pendingImageFiles = 0, pendingImageBytes = 0;
  let queuedCount = 0, customCommands = [], skillRows = [];
  let skillManagement = false;
  let liveSteering = false, nativeSteering = false;
  let mcpContextSupported = false, mcpManagement = false, mcpContextSequence = 0, mcpContextPending = "", mcpView = "servers";
  function renderQueued() { queuedEl.textContent = queuedCount > 0 ? `${queuedCount} queued` : ""; }

  // ---- one renderer, two sources ----
  // A restored turn is built by the builders that build a live one -- same classes, same answer
  // promotion, same tool cards -- because a second projection is how the panel came to disagree
  // with itself about what an answer was. `replaying` is the only thing that tells the two apart,
  // and it suppresses exactly what would lie (clocks, spinners, announcements, "new" pills) or
  // cost (posts to the extension host). `appendTarget` is where a new block lands: the transcript
  // live, a detached fragment while a history page is being built.
  let replaying = false, appendTarget = log;

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
  function effortLabel(value, subscription = curSubscription) {
    return ({ off: subscription ? "Default" : "Off", low: "Low", medium: "Medium",
      high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" })[value] || value;
  }
  function profileMenu(subscription, supportsEffort) {
    const levels = subscription && supportsEffort === false ? ["off"]
      : subscription && curSubscription !== "codex" ? [...THINK, "max"] : THINK;
    const profiles = [...levels, "ultra"];
    const selected = curUltra ? "ultra" : curThink;
    const index = Math.max(0, profiles.indexOf(selected));
    return `<section class="reasoning-card${curUltra ? " is-ultra" : ""}" aria-label="Model and reasoning"><button type="button" class="mrow model-summary" aria-expanded="false"><span class="codicon codicon-zap" aria-hidden="true"></span><span class="model-summary-label">${esc(curModel || "Select model")} <span class="muted">${effortLabel(selected, subscription)}</span></span><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button><div class="effort-control" style="--effort:${index / (profiles.length - 1) * 100}%"><input class="effort-slider" type="range" min="0" max="${profiles.length - 1}" step="1" value="${index}" data-profiles="${profiles.join(",")}" aria-label="Thinking effort" aria-valuetext="${effortLabel(selected, subscription)}"/><div class="effort-labels"><span>${effortLabel(profiles[0], subscription)}</span><output>${effortLabel(selected, subscription)}</output><span>Ultra</span></div></div></section>`;
  }
  function bindProfiles(mm) {
    const card = mm.querySelector(".reasoning-card"), slider = mm.querySelector(".effort-slider");
    const options = el("div", "model-options"); options.hidden = true;
    [...mm.children].filter(node => node !== card).forEach(node => options.appendChild(node));
    mm.appendChild(options);
    const toggle = card.querySelector(".model-summary");
    toggle.onclick = () => {
      options.hidden = !options.hidden;
      toggle.setAttribute("aria-expanded", String(!options.hidden));
      card.querySelector(".effort-control").hidden = !options.hidden;
      if (!options.hidden) (options.querySelector(".sel") || options.querySelector("button"))?.focus();
    };
    slider.oninput = () => {
      const profiles = slider.dataset.profiles.split(","), value = profiles[Number(slider.value)];
      slider.parentElement.style.setProperty("--effort", `${Number(slider.value) / (profiles.length - 1) * 100}%`);
      slider.setAttribute("aria-valuetext", effortLabel(value));
      card.querySelector("output").textContent = effortLabel(value);
      // Acknowledge the step. Restarting the class is what replays the keyframe.
      const control = slider.parentElement;
      control.classList.remove("bumped");
      void control.offsetWidth;
      control.classList.add("bumped");
    };
    slider.onchange = () => {
      vscode.postMessage({ type: "setReasoningProfile", level: slider.dataset.profiles.split(",")[Number(slider.value)] });
      hideModelMenu();
    };
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
      mm.querySelector(".model-summary")?.focus(); return;
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
    mm.querySelector(".model-summary")?.focus();
  }

  // "xhigh" capitalised reads "Xhigh", which is not a thing. Spell the profiles out.
  const EFFORT_LABEL = { off: "Off", low: "Low", medium: "Medium", high: "High",
                         xhigh: "Extra High", max: "Max", default: "Default" };

  function updateModelControl() {
    const model = curModel || "dgc";
    const raw = curUltra ? "Ultra" : (curSubscription && curThink === "off" ? "default" : curThink);
    const effort = EFFORT_LABEL[raw] || raw;
    $("modelname").textContent = model;
    $("effortname").textContent = effort;
    $("btn-model").classList.toggle("ultra", curUltra);
    $("btn-model").title = `${model} · ${effort} reasoning — click to change`;
    $("btn-model").setAttribute("aria-label", `Change model and reasoning. Current model: ${model}. Profile: ${effort}.`);
  }

  function menuKeys(menu, close, trigger, e) {
    if (e.key === "Escape") { e.preventDefault(); close(); trigger.focus(); return; }
    if (e.target.matches?.("input[type=range]")) return;
    const items = [...menu.querySelectorAll("button[role^='menuitem']")].filter(item => !item.closest("[hidden]"));
    if (!items.length) return;
    const current = Math.max(0, items.indexOf(document.activeElement));
    let next = null;
    if (e.key === "ArrowDown") next = (current + 1) % items.length;
    else if (e.key === "ArrowUp") next = (current - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
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
    read_file: "→", glob: "→", repo_map: "→", git_diff: "±",
    write_file: "✎", edit_file: "✎", apply_patch: "✎", save_memory: "✎",
    bash: "$", bash_output: "$", bash_kill: "$",
    grep: "✱", web_search: "✱", web_fetch: "✱",
    present_plan: "▸", task: "▸", todo: "▸", skill: "▸",
  };
  function canonicalTool(name) {
    const plain = String(name || "").replace(/^functions\./, "").toLowerCase();
    return ({ read: "read_file", write: "write_file", edit: "edit_file", shell: "bash",
      exec_command: "bash", shell_command: "bash", search: "grep" })[plain] || plain;
  }
  const glyphFor = (name) => GLYPH[canonicalTool(name)] || "▸";
  const TOOL_COPY = {
    read_file: ["Reading", "Read"], glob: ["Finding files", "Found files"], repo_map: ["Mapping repository", "Mapped repository"],
    git_diff: ["Inspecting changes", "Inspected changes"],
    write_file: ["Writing", "Wrote"], edit_file: ["Editing", "Edited"], apply_patch: ["Applying patch", "Applied patch"], save_memory: ["Saving memory", "Saved memory"],
    bash: ["Running", "Ran"], bash_output: ["Checking process", "Checked process"], bash_kill: ["Stopping process", "Stopped process"],
    grep: ["Searching", "Searched"], web_search: ["Searching the web", "Searched the web"], web_fetch: ["Fetching", "Fetched"],
    present_plan: ["Preparing plan", "Prepared plan"], task: ["Delegating", "Delegated"], todo: ["Updating plan", "Updated plan"], skill: ["Loading skill", "Loaded skill"],
  };
  function toolCopy(name) {
    const known = TOOL_COPY[canonicalTool(name)];
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
    { name: "plan", description: "enter read-only mode and plan a task", action: "workflow:plan", accepts_args: true },
    { name: "review", description: "review changes for bugs and regressions", action: "workflow:review", accepts_args: true },
    { name: "init", description: "inspect the project and prepare DGC.md", action: "workflow:init", accepts_args: true },
    { name: "view-plan", description: "reopen the saved plan", action: "viewPlan" },
  ];

  let streaming = false, turn = null;
  // A custom slash command sent while idle shows Stop before its turn exists. Holds the command's
  // name until that turn starts or the backend answers that command with an error or refusal.
  let customCommandPending = "";
  const attachments = [];
  let promptSequence = 0;
  const promptPrefix = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const pendingPrompts = new Map();
  // Prompts the backend acknowledged as queued, in the order they will run. They used to be
  // dropped from pendingPrompts on that acknowledgement, so a backend that stopped before running
  // them lost the user's words with no way to restore them.
  const queuedPrompts = new Map();
  const draftScope = document.documentElement.dataset.draftScope || "";
  const draftEntries = new Map();
  const pendingImages = new Set();
  let draftSession = "unbound", sessionReady = !draftScope, draftTimer = null, restoringDraft = false;
  // The Tasks row: which chats keep the checklist expanded (keyed by session id; a chat never seen
  // starts collapsed), a Clear waiting for the backend's answer, and whether a backend is up.
  const tasksExpanded = new Set();
  // `backendDown`: the backend exited and the extension is not bringing it back on its own.
  let todoClear = null, backendLive = false, backendDown = false;
  let draftWarning = false, unconfirmedDrafts = [];
  const DRAFT_STORAGE_BYTES = 8 * 1024 * 1024;
  function cleanDraft(value) {
    if (!value || typeof value !== "object" || typeof value.text !== "string" || value.text.length > 1_000_000
        || !Array.isArray(value.attachments) || value.attachments.length > 64) return null;
    try {
      if (JSON.stringify(value).length > 4 * 1024 * 1024) return null;
      const items = [];
      for (const source of value.attachments) {
        if (!source || typeof source !== "object" || typeof source.label !== "string" || source.label.length > 8192) return null;
        const item = { label: source.label };
        if (source.skill || source.template) {
          const key = source.skill ? "skill" : "template";
          if (typeof source[key] !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(source[key])) return null;
          item[key] = source[key];
        } else if (source.img) {
          if (typeof source.data !== "string" || !/^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/.test(source.data)) return null;
          item.img = true; item.data = source.data; item.bytes = Math.max(0, Number(source.bytes) || 0);
        } else if (source.resource && typeof source.resource === "object") {
          item.resource = JSON.parse(JSON.stringify(source.resource));
        } else return null;
        items.push(item);
      }
      const text = value.text;
      const start = Math.max(0, Math.min(text.length, Number(value.start) || 0));
      const end = Math.max(start, Math.min(text.length, Number(value.end) || start));
      return { text, attachments: items, start, end, updated: Number(value.updated) || Date.now() };
    } catch { return null; }
  }
  function captureDraft() {
    return { text: input.value, attachments: [...attachments], start: input.selectionStart,
      end: input.selectionEnd, updated: Date.now() };
  }
  function persistDraft() {
    if (restoringDraft) return;
    clearTimeout(draftTimer); draftTimer = null;
    const current = captureDraft();
    if (current.text || current.attachments.length) draftEntries.set(draftSession, current);
    else draftEntries.delete(draftSession);
    const entries = [], pending = [];
    let bytes = 0, omitted = false;
    for (const row of unconfirmedDrafts) {
      const draft = cleanDraft(row.draft);
      const clean = draft && { ...row, draft };
      const size = clean ? new TextEncoder().encode(JSON.stringify(clean)).length : DRAFT_STORAGE_BYTES + 1;
      if (!clean || bytes + size > DRAFT_STORAGE_BYTES || pending.length >= 17) { omitted = true; continue; }
      pending.push(clean); bytes += size;
    }
    const ordered = [...draftEntries].sort((a, b) => (b[0] === draftSession) - (a[0] === draftSession)
      || b[1].updated - a[1].updated);
    for (const [session, draft] of ordered) {
      const clean = cleanDraft(draft);
      const size = clean ? new TextEncoder().encode(JSON.stringify(clean)).length : DRAFT_STORAGE_BYTES + 1;
      if (!clean || entries.length >= 32 || bytes + size > DRAFT_STORAGE_BYTES) { omitted = true; continue; }
      entries.push([session, clean]); bytes += size;
    }
    for (const [id, request] of pendingPrompts) {
      const draft = cleanDraft({ text: request.text, attachments: request.attachments, start: 0, end: request.text.length });
      const size = draft ? new TextEncoder().encode(JSON.stringify(draft)).length : DRAFT_STORAGE_BYTES + 1;
      if (!draft || bytes + size > DRAFT_STORAGE_BYTES || pending.length >= 17) { omitted = true; continue; }
      pending.push({ id, session: request.session || draftSession, draft }); bytes += size;
    }
    // Which chats keep their checklist open: webview-local, like the drafts, and bounded the same way.
    const tasksOpen = [...tasksExpanded].slice(-32);
    try { vscode.setState({ version: 1, scope: draftScope, active: draftSession, entries, pending, tasksOpen }); }
    catch { omitted = true; }
    if (omitted && !draftWarning) {
      draftWarning = true;
      sysLine("Some drafts exceed saved-draft storage limits and remain only in this window. Send or reduce them before reloading.", true);
    }
  }
  function scheduleDraftSave() {
    if (restoringDraft) return;
    clearTimeout(draftTimer); draftTimer = setTimeout(persistDraft, 150);
  }
  function selectDraftSession(session, adoptFrom = "") {
    if (typeof session !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(session)) return;
    persistDraft();
    const prior = draftSession;
    draftSession = session;
    const source = adoptFrom || (prior === "unbound" ? prior : "");
    if (source && tasksExpanded.delete(source)) tasksExpanded.add(session);
    paintTasksExpanded();
    if (!draftEntries.has(session) && source && draftEntries.has(source)) {
      draftEntries.set(session, draftEntries.get(source)); draftEntries.delete(source);
    }
    if (source) for (const row of unconfirmedDrafts) if (row.session === source) row.session = session;
    if (source) for (const image of pendingImages) if (image.session === source) image.session = session;
    const draft = cleanDraft(draftEntries.get(session)) || { text: "", attachments: [], start: 0, end: 0 };
    restoringDraft = true;
    // Another chat gets its own undo history. Assigning a new value does not reliably drop the old
    // chat's steps: going from an empty composer to an empty chat changed nothing, and Ctrl+Z then
    // brought back the prompt sent in the chat that was left. Chromium does drop every undo step of
    // an element that leaves the document, so take the box out and put the same node straight back.
    if (session !== prior && input.parentNode) {
      const focused = document.activeElement === input, parent = input.parentNode, next = input.nextSibling;
      input.remove(); parent.insertBefore(input, next);
      if (focused) input.focus({ preventScroll: true });
      shownPastes.length = 0;
    }
    input.value = draft.text; attachments.splice(0, attachments.length, ...draft.attachments);
    input.selectionStart = draft.start; input.selectionEnd = draft.end;
    renderAtts(); autosizeComposer();
    hidePop(); restoringDraft = false; persistDraft();
  }
  function loadDraftState() {
    try {
      const saved = vscode.getState();
      if (saved?.version !== 1 || saved.scope !== draftScope || !Array.isArray(saved.entries)
          || JSON.stringify(saved).length > 12 * 1024 * 1024) return;
      for (const entry of saved.entries.slice(0, 32)) {
        if (!Array.isArray(entry) || entry.length !== 2) continue;
        const [session, raw] = entry;
        const draft = cleanDraft(raw);
        if (typeof session === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(session) && draft) draftEntries.set(session, draft);
      }
      if (typeof saved.active === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(saved.active)) draftSession = saved.active;
      for (const session of (Array.isArray(saved.tasksOpen) ? saved.tasksOpen : []).slice(-32)) {
        if (typeof session === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(session)) tasksExpanded.add(session);
      }
      paintTasksExpanded();
      unconfirmedDrafts = (Array.isArray(saved.pending) ? saved.pending : []).slice(0, 17).flatMap(row => {
        const draft = cleanDraft(row?.draft);
        return draft && typeof row.id === "string" && row.id.length <= 128
          && typeof row.session === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(row.session)
          ? [{ id: row.id, session: row.session, draft, rejected: row.rejected === true }] : [];
      });
      const draft = draftEntries.get(draftSession);
      if (draft) {
        restoringDraft = true;
        input.value = draft.text; attachments.push(...draft.attachments);
        input.selectionStart = draft.start; input.selectionEnd = draft.end;
        renderAtts(); autosizeComposer();
        restoringDraft = false;
      }
    } catch { restoringDraft = false; }
  }
  function renderUnconfirmedDrafts() {
    log.querySelectorAll(".draft-delivery-notice").forEach(node => node.remove());
    for (const row of unconfirmedDrafts.filter(row => row.session === draftSession)) {
      const node = el("div", "sys draft-delivery-notice");
      node.textContent = row.rejected ? "A rejected message is available to restore."
        : "Delivery of a message from the previous connection was not confirmed. Check the chat before retrying.";
      const button = el("button", "act", "Restore message to draft"); button.type = "button";
      button.onclick = () => {
        if (input.value || attachments.length) { sysLine("Send or clear the current draft first."); return; }
        input.value = row.draft.text; attachments.push(...row.draft.attachments);
        unconfirmedDrafts = unconfirmedDrafts.filter(item => item.id !== row.id);
        node.remove(); renderAtts(); onInput(); persistDraft();
      };
      node.appendChild(button); log.appendChild(node);
    }
  }
  function rejectPrompt(id, confirmed = true) {
    const pending = pendingPrompts.get(id) || queuedPrompts.get(id);
    if (!pending) return;
    pendingPrompts.delete(id); queuedPrompts.delete(id);
    pending.node.classList.add(confirmed ? "rejected" : "unconfirmed");
    const restore = () => {
      if (pending.session && pending.session !== draftSession) {
        sysLine("Reopen this message's original chat to restore its draft."); return;
      }
      if (input.value || attachments.length) {
        sysLine("Send or clear the current draft before restoring this message."); return;
      }
      input.value = pending.text; attachments.push(...pending.attachments);
      unconfirmedDrafts = unconfirmedDrafts.filter(item => item.id !== id);
      renderAtts(); onInput(); persistDraft(); input.focus();
    };
    const retry = el("button", "act", confirmed ? "Restore unsent message" : "Review delivery before restoring"); retry.type = "button";
    retry.onclick = restore; pending.node.appendChild(retry);
    if (confirmed && (!pending.session || pending.session === draftSession) && !input.value && !attachments.length) restore();
    else {
      unconfirmedDrafts.push({ id, session: pending.session || draftSession, rejected: confirmed,
        draft: { text: pending.text, attachments: pending.attachments, start: 0,
          end: pending.text.length, updated: Date.now() } });
      persistDraft();
    }
    if (!turn && !queuedCount && !pendingPrompts.size) setSending(false);
  }
  let files = [];              // workspace files for @-mentions
  let popMode = null, popItems = [], popIdx = 0, popStart = 0, popEnd = 0;
  let disclosureId = 0;

  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  // Replay says nothing: a restored transcript is not something that just happened, and
  // announcing fifty saved turns on reload buries whatever the reader is actually doing.
  function speak(message) { if (replaying) return; announcer.textContent = String(message || ""); }

  // One CommonMark renderer for live answers, history, skills, and documentation.
  const md = (source) => DgcMarkdown.render(source);
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html !== undefined) e.innerHTML = html; return e; }
  // ---- hover labels ----
  // The panel relied on the browser's `title` tooltip: about a second of delay, operating-system
  // chrome that matches nothing else on screen, and nothing at all for a keyboard user. This is
  // one shared label that appears quickly, follows the panel's own type and surfaces, and works
  // on focus as well as hover. `title` stays in the DOM as the source of truth — it is the
  // accessible fallback and what the tests read — and is lifted off only while ours is showing,
  // so a control never explains itself twice.
  const hoverTip = (() => {
    const node = el("div", "tip");
    node.hidden = true; node.setAttribute("role", "tooltip"); node.id = "hover-tip";
    document.body.appendChild(node);
    let timer = 0, warm = 0, target = null, native = "";
    function hide() {
      clearTimeout(timer);
      if (target && native) target.setAttribute("title", native);
      if (node.hidden === false) warm = Date.now();
      target = null; native = ""; node.hidden = true; node.className = "tip";
    }
    function paint(el0, label) {
      const [head, ...rest] = label.split("\n").map((line) => line.trim()).filter(Boolean);
      node.textContent = head;
      if (rest.length) {
        const detail = document.createElement("span");
        detail.className = "tip-detail"; detail.textContent = rest.join(" ");
        node.appendChild(detail);
      }
      node.hidden = false;
      // Above by default, below when there is no room, and never off the side of the panel.
      const anchorBox = el0.getBoundingClientRect(), box = node.getBoundingClientRect(), gap = 6;
      let top = anchorBox.top - box.height - gap, side = "above";
      if (top < 4) { top = anchorBox.bottom + gap; side = "below"; }
      const left = Math.max(4, Math.min(Math.round(anchorBox.left + anchorBox.width / 2 - box.width / 2),
                                        window.innerWidth - box.width - 4));
      node.style.top = `${Math.round(top)}px`;
      node.style.left = `${left}px`;
      // The arrow points at the control, not at the middle of the label — they part company
      // whenever the label has been nudged away from the edge of the panel.
      const centre = anchorBox.left + anchorBox.width / 2 - left;
      node.style.setProperty("--tip-arrow", `${Math.round(Math.max(8, Math.min(centre, box.width - 8)))}px`);
      node.classList.add(side);
    }
    function show(el0, instant) {
      if (el0 === target) return;
      const label = (el0.getAttribute("title") || el0.dataset.tip || "").trim();
      if (!label || el0.closest("[hidden]")) return;
      hide();
      target = el0; native = el0.getAttribute("title") || "";
      // Moving to a neighbouring control should not make you wait again.
      const delay = instant || Date.now() - warm < 500 ? 0 : 380;
      timer = setTimeout(() => {
        if (target !== el0 || !el0.isConnected) return;
        if (native) el0.removeAttribute("title");
        paint(el0, label);
      }, delay);
    }
    return { show, hide, node };
  })();
  const tipTarget = (event) => event.target?.closest?.("[title], [data-tip]") || null;
  document.addEventListener("pointerover", (e) => {
    const found = tipTarget(e);
    if (found) hoverTip.show(found, false); else hoverTip.hide();
  });
  document.addEventListener("pointerdown", () => hoverTip.hide(), true);
  document.addEventListener("focusin", (e) => {
    const found = tipTarget(e);
    // Only for keyboard focus: a label that pops up on every click is noise. A host that cannot
    // evaluate the selector should still get labels, so an unsupported pseudo-class means yes.
    let keyboard = true;
    try { keyboard = found ? found.matches(":focus-visible") : false; } catch { keyboard = !!found; }
    if (found && keyboard) hoverTip.show(found, true); else hoverTip.hide();
  });
  document.addEventListener("focusout", () => hoverTip.hide());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hoverTip.hide(); }, true);
  window.addEventListener("blur", () => hoverTip.hide());

  // ---- keeping the transcript's height honest while still skipping what is off screen ----
  // `content-visibility: auto` lets the browser skip rendering a block that has scrolled away,
  // but a skipped block is laid out at its `contain-intrinsic-size`, not its real height. A
  // guessed placeholder therefore changes the page's length every time a block is skipped or
  // rendered, which is what moved the viewport. Measure once, pin the measured value, and keep
  // it current with a ResizeObserver: skipped and rendered then occupy exactly the same space.
  const blockSizes = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    for (const entry of entries) pinBlockHeight(entry.target);
  }) : null;
  function pinBlockHeight(node) {
    const height = Math.round(node.offsetHeight);
    // A skipped block reports no size — to itself and to the observer. Writing that back would
    // replace the measurement with zero, which is the guessed placeholder all over again.
    if (height < 8 || Math.abs((node._pinnedHeight || 0) - height) < 2) return false;
    node._pinnedHeight = height;
    node.style.containIntrinsicSize = `auto ${height}px`;
    return true;
  }
  function settleBlock(node) {
    if (!node || node.classList.contains("settled")) return;
    if (!pinBlockHeight(node)) {          // not laid out yet; settle on a later frame
      requestAnimationFrame(() => settleBlock(node));
      return;
    }
    node.classList.add("settled");        // only now may the browser skip it
    blockSizes?.observe(node);
  }
  // Is the view still tracking the end of the run? It stops only when you scroll away yourself.
  // Following "whenever we happen to be at the bottom" is not enough: anything that moves the
  // transcript once — a focused control scrolled into view, a card resolving, the composer
  // growing — leaves it more than a screen-edge away, and from then on nothing ever scrolls
  // again, so a run keeps writing into a part of the panel nobody is looking at.
  window.__dgcPanelBuild = "follow-4";   // proves which panel code a recording actually ran
  let following = true, userScrolledAt = 0;
  function atBottom() { return log.scrollHeight - log.scrollTop - log.clientHeight < 60; }
  function scroll() { if (replaying) return; log.scrollTop = log.scrollHeight; following = true; }
  // ---- reading back without losing the end ----
  // Scrolling up during a run is normal; being stranded there is not. The pill appears only
  // while you are away from the bottom, and turns into the accent once something has arrived
  // that you have not seen.
  const toLatest = $("to-latest");
  let unread = false;
  function renderToLatest() {
    const away = !atBottom();
    if (!away) { unread = false; following = true; }
    toLatest.hidden = !away;
    toLatest.classList.toggle("unread", away && unread);
    $("to-latest-label").textContent = away && unread ? "New" : "Latest";
    toLatest.title = away && unread
      ? "DGC has written more since you scrolled up \u2014 jump to it"
      : "Jump to the newest message";
  }
  function noteNewContent() { if (!atBottom()) { unread = true; renderToLatest(); } }
  // Only a gesture counts as "I want to read back". A scroll the page did to itself does not —
  // and neither does pressing a button that happens to live inside the transcript. Approval
  // cards, plan cards and question forms are all in there, so a plain pointerdown on the
  // scroller is usually someone answering DGC, not someone scrolling away from it.
  const SCROLL_KEYS = new Set(["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "]);
  const readingBack = () => { userScrolledAt = Date.now(); };
  log.addEventListener("wheel", readingBack, { passive: true });
  log.addEventListener("touchmove", readingBack, { passive: true });
  log.addEventListener("pointerdown", (e) => {
    if (e.offsetX > log.clientWidth) readingBack();          // the scrollbar, not the content
  }, { passive: true });
  log.addEventListener("keydown", (e) => {
    if (SCROLL_KEYS.has(e.key) && !e.target.closest("input, textarea, select, [contenteditable]")) {
      readingBack();
    }
  }, { passive: true });
  log.addEventListener("scroll", () => {
    if (Date.now() - userScrolledAt < 700) following = atBottom();
    renderToLatest();
  }, { passive: true });
  toLatest.onclick = () => { scroll(); unread = false; renderToLatest(); input.focus(); };
  // The composer grows and shrinks under the transcript: the goal rail and the changed-files
  // rail appear as a turn ends, the follow-up hint comes and goes, attachments wrap. Every one
  // of those takes height from the transcript while its scroll position stays put, which walks
  // the newest content off the bottom of the view — the end-of-turn summary went with it. If we
  // were following the run, keep following it.
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { if (atBottom() || following) scroll(); })
      .observe(document.querySelector("footer"));
  }

  // ---- turn lifecycle ----
  // Two prompts are "the same" when their opening prose matches; the composer's own bubble may
  // carry attachment labels the backend never echoes, and the backend may expand a template.
  function sameProse(a, b) {
    const norm = (v) => String(v || "").replace(/\s+/g, " ").trim().slice(0, 120);
    const x = norm(a), y = norm(b);
    return !!x && !!y && (x.startsWith(y) || y.startsWith(x));
  }
  function echoPrompt(text) {
    const body = String(text || "").trim();
    if (!body) return;
    // The composer renders what the user typed there. A turn begun anywhere else — a slash
    // command, an editor action, a queued follow-up, a retry, the terminal beside us — must
    // still show its prompt, or the transcript reads as answers to questions nobody asked.
    const last = [...appendTarget.querySelectorAll(".msg.user > .bubble")].at(-1);
    if (last && sameProse(last.textContent, body)) return;
    const m = el("div", replaying ? "msg user hist" : "msg user"); m.appendChild(el("div", "role", "you"));
    m.appendChild(el("div", "bubble", esc(body)));
    appendTarget.appendChild(m); if (!replaying) settleBlock(m);
  }
  function startTurn(prompt = "", kind = "prompt", id = "") {
    // A page of restored turns is a sequence of finished turns, not one turn interrupting another.
    if (turn) endTurn(replaying ? "completed" : "cancelled");
    speak("DGC is working");
    // A resumed goal is not something the user just typed. Show it as what it is instead of
    // echoing the objective back into the chat as a fresh prompt. The same holds for a turn the
    // Continue card started after the backend stopped: DGC wrote that instruction, not the user.
    if (kind === "resume" || kind === "continue") {
      const note = el("div", replaying ? "resume-note hist" : "resume-note");
      note.innerHTML = '<span class="codicon codicon-debug-continue" aria-hidden="true"></span>'
        + `<span>${kind === "continue" ? "Continued the interrupted turn" : "Resumed the standing goal"}</span>`;
      if (kind === "continue") note.classList.add("continue-note");
      appendTarget.appendChild(note);
    } else if (kind === "monitor") {
      // DGC started this turn because a background monitor printed something. The label is
      // command-derived text the backend wrote, so it is a marker, never a "you" bubble.
      const note = el("div", replaying ? "resume-note monitor-note hist" : "resume-note monitor-note");
      note.innerHTML = '<span class="codicon codicon-pulse" aria-hidden="true"></span>'
        + `<span>Woke on monitor · ${esc(String(prompt || "").slice(0, 200))}</span>`;
      appendTarget.appendChild(note);
    } else {
      echoPrompt(prompt);
    }
    const block = el("div", replaying ? "msg dgc hist" : "msg dgc");
    block.appendChild(el("div", "role dgc", "DGC"));
    // The verb starts empty and is written only by renderTurnMeta, from what the backend says the
    // turn is doing. A literal here is a claim the panel cannot keep: it was "working…" from the
    // first byte to the last, through six gates and every tool call.
    const act = el("div", "thinking", `<span class="spin">${MARK}</span> <span class="verb"></span> <span class="meta"></span>`);
    block.appendChild(act); appendTarget.appendChild(block);
    // No clock for a replayed turn: the session file does not record when it started, and a
    // fabricated 0s is worse than no number at all.
    const t0 = replaying ? null : Date.now();
    turn = { block, act, t0, chars: 0, textEl: null, reasonEl: null, _buf: "", eta: "",
             id: String(id || ""), activity: null, phaseT0: t0, handoff: false,
             prompt: String(prompt || ""), edits: new Map() };
    if (!replaying) {
      turn.timer = setInterval(renderTurnMeta, 200);
      renderTurnMeta();
      scroll();
    }
  }
  // The one writer of the activity row. Everything it can say is a fact somebody stated: the
  // panel's own open request card, the handoff this panel asked for, or the backend's
  // `turn_activity`. "Working" is the floor, and only until the first activity arrives.
  function renderTurnMeta() {
    if (!turn?.act) return;
    const verb = turn.act.querySelector(".verb"), meta = turn.act.querySelector(".meta");
    if (!verb || !meta) return;
    // A question on screen is a fact about THIS client and beats anything the backend is doing.
    const waiting = !!turn.block.querySelector(".card[data-request-id]:not(.resolved)");
    turn.act.classList.toggle("waiting-input", waiting);
    const activity = turn.activity;
    // A tool step's detail is its argument (the command, the path), and that tool's card is already
    // on screen holding it: the row says only what kind of step is running, beside the clocks and
    // tokens. Detail stays for states with no card to show it, such as a stalled model
    // ("<model> at <host> · no reply for 45s+"). Decided here, so it holds for any CLI.
    const detail = activity && activity.state !== "tool" ? activity.detail : "";
    verb.textContent = waiting ? "waiting for your input"
      : turn.handoff ? "generating handoff…"
        : activity ? activity.label + (detail ? ` · ${detail}` : "")
          : "Working";
    if (turn.t0 == null) { meta.textContent = ""; return; }   // a replayed turn has no clock
    const now = Date.now();
    const total = Math.floor((now - turn.t0) / 1000);
    const phase = Math.floor((now - (turn.phaseT0 || turn.t0)) / 1000);
    // Two clocks only once they differ: how long this step has taken, then the whole turn. It is
    // the TUI's shape, and it is what makes a long gate visible instead of a growing total.
    const clock = activity && phase !== total ? `${phase}s · ${total}s` : `${total}s`;
    const eta = turn.eta ? ` · ${turn.eta}` : "";
    meta.textContent = `(${clock}${eta} · ↓ ${Math.round(turn.chars / 4)} tok)`;
  }
  // `finalId` is the backend's own designation of which prose block this turn answered with
  // (`turn_end.final_message_id`). The panel used to guess it from the position of the last
  // `.text` node, which made a gate round's prose the answer and left the block the user had
  // actually read as bare, unclassified text.
  function endTurn(reason = "completed", finalId) {
    if (!turn) return;
    flushText();
    finishReasoning();
    turn.block.querySelectorAll(".card:not(.resolved)").forEach(resolveCard);
    turn.block.querySelectorAll('.tool[data-status="running"]').forEach((card) => {
      setToolStatus(card, "stopped");
      const dot = card.querySelector(".dot");
      if (dot) dot.className = "dot deny";
    });
    clearInterval(turn.timer);
    clearTimeout(turn.recoverTimer);
    const nodes = [...turn.block.querySelectorAll(".text")];
    let answer = finalId != null ? nodes.find((n) => n.dataset.messageId === String(finalId)) : null;
    // Absent and null are different answers to the same question. A backend that never states the
    // field (or an internal caller ending a turn the protocol did not) keeps the old positional
    // rule -- the compatibility floor, exactly as a null MessagePhase means "legacy behaviour".
    // An explicit null is a statement: this turn designated no answer (it ended mid-tool), and
    // inventing one from the last node on screen is the guess this change exists to remove.
    if (!answer && (finalId === undefined
        // A stated id the panel has no node for is a lost message, not a statement that the turn
        // had no answer: without this the turn rendered with no answer block at all.
        || (finalId != null && !nodes.some((n) => n.dataset.messageId === String(finalId))))) {
      const last = nodes.at(-1);
      if (last && !last.classList.contains("commentary")) answer = last;
    }
    // After a turn ends there is no third state left: every block is either the answer or the
    // commentary around it. A bare `.text` was how a gate-round answer came to look finished.
    for (const n of nodes) if (n !== answer) n.classList.add("commentary");
    if (answer) {
      answer.classList.remove("commentary");        // the stated id outranks any earlier guess
      const complete = reason === "completed";
      if (complete) answer.classList.add("final");   // unfinished prose is not a final answer
      // The answer gets a block of its own: separated from the work above it, with room to
      // breathe, and its own actions inside it rather than floating underneath the turn.
      // What this turn changed, then what you can do about it — the two things a reader wants
      // at the end of an answer, in that order. A stopped or failed turn gets the actions too:
      // a partial answer is exactly the one a reader wants to copy or retry, and denying Copy
      // there was the opposite of helpful. The change summary stays gated on completion, because
      // a turn that did not finish has not finished changing things.
      const box = el("div", complete ? "answer complete" : "answer partial");
      answer.replaceWith(box);
      box.appendChild(answer);
      const summary = complete ? turnSummaryCard(turn.edits, turn.prompt) : null;
      if (summary) box.appendChild(summary);
      box.appendChild(responseActions(answer, turn.prompt, !complete));
      // The work summary separates the collapsed activity from the final response.
      turn.block.insertBefore(turn.act, box);
    }
    turn.act.classList.add("done");
    const outcome = reason === "cancelled" ? "Stopped" : reason === "error" ? "Failed" : "Worked";
    // A replayed turn has no clock — the session file never recorded when it began — so it says
    // what happened and stops there rather than printing a fabricated 0s.
    turn.act.textContent = turn.t0 == null ? outcome
      : `${outcome} for ${Math.floor((Date.now() - turn.t0) / 1000)}s`;
    const finished = turn.block;
    turn = null;
    if (replaying) return;
    // After every mutation this turn will make, so the height that gets pinned is the final one.
    // The end of a finished turn is its result — the summary of what it changed and what you can
    // do about it — so unless you have scrolled away to read something else, show it. Once now
    // and once on the next frame, because the rails and the composer settle a frame later and
    // each of them takes height from the transcript.
    requestAnimationFrame(() => {
      settleBlock(finished);
      if (following) scroll();
    });
    if (following) scroll();
  }
  // ---- what the turn changed, and what you can do about it ----
  function turnSummaryCard(edits, prompt) {
    const files = [...(edits || new Map()).entries()];
    if (!files.length) return null;
    const additions = files.reduce((n, [, v]) => n + v.additions, 0);
    const deletions = files.reduce((n, [, v]) => n + v.deletions, 0);
    const card = el("div", "turn-summary");
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Files changed in this turn");
    card.innerHTML = `<div class="ts-head"><span class="codicon codicon-diff-multiple" aria-hidden="true"></span>`
      + `<span class="ts-title">${files.length} ${files.length === 1 ? "file" : "files"} changed</span>`
      + `<span class="change-add">+${additions}</span><span class="change-del">\u2212${deletions}</span></div>`
      + `<div class="ts-list">${files.map(([path, v], i) =>
          `<button type="button" class="ts-row" data-file="${i}" title="Review ${esc(path)}">`
          + `<span class="change-path">${esc(path)}</span>`
          + (v.additions || v.deletions
              ? `<span class="change-add">+${v.additions}</span><span class="change-del">\u2212${v.deletions}</span>`
              : `<span class="ts-new">New</span>`)
          + `<span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>`).join("")}</div>`
      + `<div class="ts-actions">`
      + `<button type="button" class="act ts-undo" title="Put these files back as they were before this turn">Undo</button>`
      + `<button type="button" class="act ts-review" title="Open the diff for every file this chat changed">Review</button></div>`;
    card.querySelectorAll("[data-file]").forEach((row) => row.onclick = () => {
      const entry = files[Number(row.dataset.file)];
      if (entry) vscode.postMessage({ type: "reviewChange", path: entry[0], scope: "chat" });
    });
    card.querySelector(".ts-review").onclick = () => openChangesReview("chat");
    // Undo restores the workspace to the recovery point this turn opened. The extension
    // identifies it by the prompt, refuses when it can no longer find it, and confirms first.
    card.querySelector(".ts-undo").onclick = () => vscode.postMessage({
      type: "undoTurn", prompt: String(prompt || ""), files: files.map(([path]) => path) });
    return card;
  }
  //: One rating per response, kept in this workspace and sent nowhere.
  // `partial` is a turn that stopped or failed. Its prose is not an answer and must not be styled
  // as one, but it is exactly the text a reader wants to keep or try again — so Copy and Retry
  // stay, and rating something half-written does not.
  // A fence longer than this buries the answer and pushes the response actions off screen.
  const CODE_FOLD_LINES = 24;
  // ---- mermaid diagrams ----
  // The runtime is ~5MB, so it is fetched the first time a diagram actually appears and never by
  // a panel that shows none. Two deliberate choices: the source is model output, so rendering
  // stays at mermaid's "strict" security level (no click bindings, no raw HTML in labels); and a
  // block that fails to parse keeps its original fence, because a broken diagram must not delete
  // the text the model wrote. The fence is kept either way behind a Show source toggle, so the
  // Copy button a reader expects on a code block never disappears.
  const SCRIPT_NONCE = (document.currentScript && document.currentScript.nonce) || "";
  let mermaidReady = null;
  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    const src = (document.body && document.body.dataset && document.body.dataset.mermaidSrc) || "";
    if (!src) return (mermaidReady = Promise.resolve(null));
    mermaidReady = new Promise((resolve) => {
      const tag = document.createElement("script");
      if (SCRIPT_NONCE) tag.nonce = SCRIPT_NONCE;   // the panel CSP admits scripts by nonce only
      tag.src = src;
      tag.onload = () => resolve(window.mermaid || null);
      tag.onerror = () => resolve(null);
      document.head.appendChild(tag);
    }).then((lib) => {
      if (!lib) return null;
      // Diagrams are read against the panel's own surfaces, so the theme comes from the same
      // tokens every other block uses rather than mermaid's stock palette.
      const token = (name, fallback) =>
        (getComputedStyle(document.documentElement).getPropertyValue(name) || "").trim() || fallback;
      try {
        lib.initialize({
          startOnLoad: false, securityLevel: "strict", theme: "base",
          // Without this, a diagram mermaid cannot parse is answered by appending a full-width
          // "Syntax error" bomb graphic to document.body -- outside the transcript, outside the
          // panel's layout, and impossible to dismiss. DGC handles the failure itself instead.
          suppressErrorRendering: true,
          fontFamily: token("--sans", "system-ui"), fontSize: 13,
          themeVariables: {
            background: token("--surface", "#202021"),
            primaryColor: token("--surface2", "#29292B"),
            primaryTextColor: token("--text", "#d4d4d6"),
            primaryBorderColor: token("--border-strong", "#3A3A3D"),
            secondaryColor: token("--code", "#151516"),
            tertiaryColor: token("--code", "#151516"),
            lineColor: token("--muted", "#9a9aa0"),
            textColor: token("--text", "#d4d4d6"),
          },
        });
      } catch { return null; }
      return lib;
    });
    return mermaidReady;
  }
  let mermaidSeq = 0;
  function renderMermaid(root) {
    const blocks = [...root.querySelectorAll('pre.code[data-language="mermaid"]:not([data-mermaid])')];
    if (!blocks.length) return;
    blocks.forEach((pre) => { pre.dataset.mermaid = "pending"; });
    loadMermaid().then((lib) => {
      if (!lib) { blocks.forEach((pre) => { pre.dataset.mermaid = "unavailable"; }); return; }
      blocks.forEach((pre) => drawMermaid(lib, pre));
    });
  }
  async function drawMermaid(lib, pre) {
    const code = pre.querySelector("code");
    const source = code ? code.textContent : "";
    if (!source.trim()) { pre.dataset.mermaid = "empty"; return; }
    let svg = "";
    try {
      // parse() first: it validates without touching the DOM, so an invalid diagram costs
      // nothing and never reaches the renderer.
      if (await lib.parse(source, { suppressErrors: true }) === false) {
        pre.dataset.mermaid = "failed"; return;
      }
      ({ svg } = await lib.render(`dgc-mermaid-${++mermaidSeq}`, source));
    } catch { pre.dataset.mermaid = "failed"; return; }
    if (!pre.parentNode) return;
    const figure = el("figure", "mermaid-figure");
    const art = el("div", "mermaid-art");
    art.innerHTML = svg;                       // mermaid sanitises at securityLevel "strict"
    const bar = el("figcaption", "mermaid-bar");
    const toggle = el("button", "fold", "Show source");
    toggle.type = "button";
    toggle.onclick = () => {
      pre.hidden = !pre.hidden;
      toggle.textContent = pre.hidden ? "Show source" : "Hide source";
    };
    bar.appendChild(toggle);
    pre.replaceWith(figure);
    pre.hidden = true;
    figure.append(art, bar, pre);
    pre.dataset.mermaid = "done";
  }

  // Everything that has to happen to rendered markdown after it lands in the DOM.
  function enrichMarkdown(root) {
    if (!root) return;
    foldLongCode(root);
    renderMermaid(root);
  }
  function foldLongCode(root) {
    root.querySelectorAll("pre.code:not([data-folded])").forEach((pre) => {
      pre.dataset.folded = "1";
      const code = pre.querySelector("code");
      const lines = code ? code.textContent.split("\n").length : 0;
      if (lines <= CODE_FOLD_LINES) return;
      pre.classList.add("foldable");
      const fold = el("button", "fold", `See all ${lines} lines`);
      fold.type = "button";
      fold.onclick = () => {
        const open = pre.classList.toggle("open");
        fold.textContent = open ? "Hide lines" : `See all ${lines} lines`;
      };
      pre.appendChild(fold);
    });
  }

  function responseActions(textEl, prompt, partial = false) {
    const actions = el("div", "response-actions");
    if (partial) actions.classList.add("partial");
    const add = (act, icon, label) => {
      const b = el("button", `ract ract-${act}`, `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`);
      b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.dataset.act = act;
      actions.appendChild(b); return b;
    };
    add("copy", "copy", partial ? "Copy what was written" : "Copy response");
    if (!partial) {
      // Ratings are toggles, so they carry aria-pressed: without it a screen reader announces
      // "Good response, button" whether or not the rating is already applied, and gives no hint
      // that pressing again removes it. The visual `.on` class is the same state, seen.
      for (const [act, icon, label] of [
        ["up", "thumbsup", "Good response \u2014 kept in this workspace, sent nowhere"],
        ["down", "thumbsdown", "Poor response \u2014 kept in this workspace, sent nowhere"]]) {
        add(act, icon, label).setAttribute("aria-pressed", "false");
      }
      add("branch", "git-branch", "Branch into a new chat from here");
    }
    add("retry", "refresh", "Run this prompt again");
    if (!partial) add("edit", "edit", "Edit this prompt and send it again");
    const body = () => textEl._markdown || textEl.textContent;
    actions.onclick = (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      if (act === "copy") { vscode.postMessage({ type: "copy", text: body() }); flashAction(button, "check"); return; }
      if (act === "up" || act === "down") {
        const on = button.classList.contains("on");
        actions.querySelectorAll(".ract-up, .ract-down").forEach((b) => {
          b.classList.remove("on"); b.setAttribute("aria-pressed", "false");
        });
        if (!on) { button.classList.add("on"); button.setAttribute("aria-pressed", "true"); }
        vscode.postMessage({ type: "rateResponse", rating: on ? "none" : act, prompt: String(prompt || "") });
        return;
      }
      if (act === "branch") { vscode.postMessage({ type: "branchChat", prompt: String(prompt || "") }); return; }
      if (act === "retry") { resend(prompt); return; }
      if (act === "edit") {
        setComposerText(String(prompt || "")); input.selectionStart = input.selectionEnd = input.value.length;
        input.focus(); onInput(); scroll();
      }
    };
    return actions;
  }
  function flashAction(button, icon) {
    const glyph = button.querySelector(".codicon"), was = glyph.className;
    glyph.className = `codicon codicon-${icon}`;
    setTimeout(() => { glyph.className = was; }, 1100);
  }
  // Retry runs the same prompt again without eating whatever is half-typed in the composer.
  function resend(prompt) {
    const text = String(prompt || "").trim();
    if (!text) return;
    const draft = input.value;
    setComposerText(text); submit();
    if (input.value === "" && draft) { setComposerText(draft); onInput(); }
  }
  function discardTurn() {
    if (turn) {
      clearInterval(turn.timer);
      clearTimeout(turn.renderTimer);
      turn.block.querySelectorAll(".tool").forEach((card) => clearInterval(card._timer));
    }
    expireOpenRequests();
    turn = null;
  }
  // A checklist belongs to the session, not to a single assistant bubble, so it is not a card
  // in the transcript. It is a row in the composer rail, directly above the goal row and built from
  // the same parts: collapsed it reads "Tasks 2/5 · <the step in progress>", and expanded the full
  // list opens above the row inside the rail, scrolling within its own bounded panel. Every update
  // — a `todos` event mid-turn, or the `history` snapshot on resume and reload — repaints that one
  // row without inventing a running turn or starting a timer. Nothing here scrolls the transcript
  // or touches follow mode: a reader who scrolled up must stay where they are while the list ticks.
  const TODO_GLYPHS = {
    pending:     ["□", "pend",   "pending"],
    in_progress: ["▶", "doing",  "in progress"],
    done:        ["✓", "done",   "done"],
    blocked:     ["⊘", "block",  "blocked"],
    cancelled:   ["✗", "cancel", "cancelled"],
  };
  const TASKS_TIMEOUT_MS = 5000;
  // How long a Clear may wait for a backend that is reconnecting, the same bound a turn gets
  // (the backend_exit handler's thirty seconds) before it is reported as unanswered.
  const TASKS_RECONNECT_MS = 30000;
  const TASKS_NOT_RUNNING = "DGC is not running. Run DGC: Restart Backend, then clear the checklist again.";
  function tasksOpen() { return tasksExpanded.has(draftSession); }
  function paintTasksExpanded() {
    const open = tasksOpen(), toggle = $("tasks-toggle");
    $("tasks-panel").hidden = !open;
    const label = open ? "Hide the checklist" : "Show the checklist";
    for (const button of [$("tasks-main"), toggle]) button.setAttribute("aria-expanded", String(open));
    toggle.title = label; toggle.setAttribute("aria-label", label);
    $("tasks-main").title = label;
    toggle.querySelector(".codicon").className = `codicon codicon-chevron-${open ? "down" : "up"}`;
  }
  function toggleTasks() {
    if (tasksOpen()) tasksExpanded.delete(draftSession); else tasksExpanded.add(draftSession);
    paintTasksExpanded();
    persistDraft();
  }
  function showTasksNote(message) {
    const note = $("tasks-note");
    note.textContent = message || ""; note.title = message || ""; note.hidden = !message;
    tasksBar.classList.toggle("noted", Boolean(message));
    $("tasks-text").hidden = Boolean(message);   // the note takes the summary's place, never both
  }
  function paintTodoClearBusy(busy) {
    const button = $("tasks-clear"), icon = button.querySelector(".codicon");
    if (busy) button.setAttribute("aria-busy", "true"); else button.removeAttribute("aria-busy");
    icon.className = busy ? "codicon codicon-loading codicon-modifier-spin" : "codicon codicon-trash";
    const label = busy ? "Clearing the checklist" : "Clear the checklist";
    button.title = label; button.setAttribute("aria-label", label);
  }
  // A clear waiting on a backend that is restarting or still handshaking is not unanswered yet:
  // the command is held until it is back. The clock only runs against a live backend.
  function armTodoClearTimer() {
    if (!todoClear || todoClear.timer || !backendLive || !sessionReady) return;
    if (todoClear.reconnect) { clearTimeout(todoClear.reconnect); todoClear.reconnect = null; }
    todoClear.timer = setTimeout(() => {
      if (todoClear) todoClear.timer = null;
      settleTodoClear("DGC did not confirm the clear. Try again, or run DGC: Restart Backend.");
    }, TASKS_TIMEOUT_MS);
  }
  // The backend went away. Recovering, the clear is held for the new backend and its clock stops,
  // bounded by the reconnect allowance so a recovery that never completes cannot spin for ever.
  // Not recovering, nothing will ever answer: say so now.
  function pauseTodoClearTimer(recovering = true) {
    if (!todoClear) return;
    if (todoClear.timer) { clearTimeout(todoClear.timer); todoClear.timer = null; }
    if (!recovering) { settleTodoClear(TASKS_NOT_RUNNING); return; }
    if (!todoClear.reconnect) {
      todoClear.reconnect = setTimeout(() => {
        if (todoClear) todoClear.reconnect = null;
        settleTodoClear("DGC did not confirm the clear. Try again, or run DGC: Restart Backend.");
      }, TASKS_RECONNECT_MS);
    }
  }
  function requestTodoClear() {
    if (todoClear) return;                      // one clear at a time; the answer settles it
    // A backend that exited and is not coming back by itself cannot answer. Posting would start a
    // fresh one whose session restore could bring the list straight back, so say what to do.
    if (backendDown) { showTasksNote(TASKS_NOT_RUNNING); return; }
    todoClear = { timer: null, reconnect: null };
    showTasksNote("");
    paintTodoClearBusy(true);
    vscode.postMessage({ type: "clear_todos" });
    armTodoClearTimer();
  }
  // Every way a clear ends goes through here, and every one of them takes the old note down: a
  // refusal or timeout note must never sit beside a list it was not about.
  function settleTodoClear(message = "") {
    if (todoClear?.timer) clearTimeout(todoClear.timer);
    if (todoClear?.reconnect) clearTimeout(todoClear.reconnect);
    todoClear = null;
    paintTodoClearBusy(false);
    showTasksNote(message);
  }
  function renderTodos(value) {
    const rows = (Array.isArray(value) ? value : []).filter((t) => t && typeof t.content === "string").slice(0, 100);
    const list = $("tasks-list"), count = $("tasks-count");
    if (!rows.length) {
      const hadFocus = tasksBar.contains(document.activeElement);
      settleTodoClear();
      list.innerHTML = ""; count.textContent = "Tasks 0/0"; $("tasks-text").textContent = "";
      $("tasks-blocked").hidden = true;
      tasksBar.hidden = true;
      syncComposerRail();
      // Clear removed the row the focus was on: land in the composer, the next thing to use.
      if (hadFocus) input.focus();
      return;
    }
    // A fresh list is never shown beside a stale note. A pending clear stays pending: the
    // backend's empty list or its refusal is what settles it.
    if (!todoClear) showTasksNote("");
    // Own keys only — a status of "constructor" must not fish a function out of the prototype.
    const statusOf = (t) => Object.hasOwn(TODO_GLYPHS, t.status) ? t.status : "pending";
    // Blocked items are not done: the counter is the same one the backend's completion gate reads.
    const complete = rows.filter((t) => t.status === "done").length;
    const doing = rows.find((t) => statusOf(t) === "in_progress");
    const pending = rows.filter((t) => statusOf(t) === "pending").length;
    const blocked = rows.filter((t) => statusOf(t) === "blocked").length;
    const cancelled = rows.filter((t) => statusOf(t) === "cancelled").length;
    count.textContent = `Tasks ${complete}/${rows.length}`;
    // "all done" only when every row is done. Cancelled rows are finished but not done, so a list
    // with nothing left open says how many were cancelled instead of contradicting its own count.
    const settled = doing ? "" : pending ? `${pending} pending` : blocked ? ""
      : cancelled ? `${cancelled} cancelled` : "all done";
    const summary = doing ? doing.content.replace(/\s+/g, " ").trim() : settled;
    $("tasks-text").textContent = summary;
    $("tasks-blocked").textContent = `${blocked} blocked`;
    $("tasks-blocked").hidden = blocked === 0;
    tasksBar.dataset.status = doing ? "active" : blocked ? "blocked" : pending ? "pending" : "done";
    $("tasks-main").setAttribute("aria-label", `Tasks, ${complete} of ${rows.length} done`
      + (doing ? `, in progress: ${summary.slice(0, 180)}` : settled ? `, ${settled}` : "")
      + (blocked ? `, ${blocked} blocked` : ""));
    list.innerHTML = rows.map((t) => {
      const g = TODO_GLYPHS[statusOf(t)];
      return `<div class="t ${g[1]}" role="listitem"><span class="ti" role="img" aria-label="${g[2]}">${g[0]}</span><span class="tc">${esc(t.content)}</span></div>`;
    }).join("");
    tasksBar.hidden = false;
    paintTasksExpanded();
    syncComposerRail();
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
  function flushText() {
    if (!turn) return;
    clearTimeout(turn.renderTimer); turn.renderTimer = null;
    if (turn.textEl && turn._buf) {
      turn.textEl._markdown = turn._buf;
      turn.textEl.innerHTML = md(turn._buf); turn.renderedAt = Date.now();
      enrichMarkdown(turn.textEl);
    }
  }
  function appendText(value) {
    turn._buf = (turn._buf || "") + value;
    const node = textBlock(); node._markdown = turn._buf;
    // Replay renders inline: a batch timer would hand the fragment back to the pager half empty.
    if (replaying || !turn.renderedAt || Date.now() - turn.renderedAt >= 48) flushText();
    else if (!turn.renderTimer) turn.renderTimer = setTimeout(() => {
      const stick = atBottom(); flushText(); if (stick || following) scroll(); else noteNewContent();
    }, 48);
  }
  function breakText() { if (turn) { flushText(); turn.textEl = null; turn._buf = ""; turn.renderedAt = 0; } }

  function finishReasoning() {
    if (!turn?.reasonEl) return;
    const button = turn.reasonEl.previousElementSibling;
    const seconds = Math.max(0, Math.round((Date.now() - turn.reasonStarted) / 1000));
    button.dataset.label = `Thought for ${seconds}s`;
    button.textContent = `${turn.reasonEl.classList.contains("show") ? "▾" : "▸"} ${button.dataset.label}`;
    turn.reasonEl = null;
  }

  // Say what the cards did (or are doing) in a sentence, the way a colleague would: "Read 5 files
  // and searched code", not a tally of function names. Counts only where the number tells you
  // something. The present tense uses the same buckets, so a running header and the finished one
  // it becomes read as the same sentence in two tenses.
  const TOOL_BUCKET = {
    read_file: "read", grep: "searched", glob: "searched", repo_map: "mapped",
    code_intel: "mapped", write_file: "created", create_file: "created",
    edit_file: "edited", apply_patch: "edited", multi_edit: "edited",
    bash: "ran", browser: "looked", web_search: "web", web_fetch: "web",
  };
  function toolSentence(cards, tense) {
    const counts = Object.create(null);
    for (const card of cards) {
      const key = TOOL_BUCKET[canonicalTool(card.dataset.toolName)] || "other";
      counts[key] = (counts[key] || 0) + 1;
    }
    const past = tense !== "present";
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    // The present tense reads "a file" for one: "Reading a file", not "Reading 1 file".
    const some = (n, one, many) => (past ? plural(n, one, many) : n === 1 ? `a ${one}` : `${n} ${many}`);
    // One running tool DGC has a specific verb for ("Updating plan", "Delegating") keeps it.
    const lone = !past && counts.other === 1
      ? cards.find((card) => !TOOL_BUCKET[canonicalTool(card.dataset.toolName)]) : null;
    const loneCopy = lone && TOOL_COPY[canonicalTool(lone.dataset.toolName)];
    const otherPresent = loneCopy ? loneCopy[0].toLowerCase()
      : lone && String(lone.dataset.toolName).startsWith("mcp__") ? "calling an MCP tool"
        : `using ${some(counts.other || 0, "tool", "tools")}`;
    const phrases = [
      counts.read && `${past ? "read" : "reading"} ${some(counts.read, "file", "files")}`,
      counts.edited && `${past ? "edited" : "editing"} ${some(counts.edited, "file", "files")}`,
      counts.created && `${past ? "created" : "creating"} ${some(counts.created, "file", "files")}`,
      counts.ran && `${past ? "ran" : "running"} ${some(counts.ran, "command", "commands")}`,
      counts.searched && (past ? "searched code" : "searching code"),
      counts.mapped && (past ? "mapped the project" : "mapping the project"),
      counts.looked && `${past ? "looked at" : "looking at"} ${some(counts.looked, "page", "pages")}`,
      counts.web && (past ? "searched the web" : "searching the web"),
      counts.other && (past ? `used ${plural(counts.other, "tool", "tools")}` : otherPresent),
    ].filter(Boolean);
    const sentence = phrases.length > 1
      ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
      : (phrases[0] || (past ? "Worked" : "Working"));
    return sentence.charAt(0).toUpperCase() + sentence.slice(1);
  }
  function refreshToolGroup(group) {
    if (!group) return;
    const cards = [...group.querySelectorAll(".tool")];
    const running = cards.filter(card => card.dataset.status === "running");
    const failures = cards.filter(card => ["failed", "denied", "stopped"].includes(card.dataset.status));
    const summary = group.querySelector(".tool-group-label");
    group.classList.toggle("running", running.length > 0);
    // Running, the header says what is happening in the present tense ("Running a command",
    // "Editing 2 files and running a command") and never repeats a card's argument: the card
    // below holds the command or path, and the header used to print it a second time.
    let sentence = running.length ? toolSentence(running, "present") : toolSentence(cards, "past");
    if (!running.length && failures.length) {
      sentence += ` · ${failures.length} ${failures.length === 1 ? "issue" : "issues"}`;
    }
    summary.textContent = sentence;
    if (failures.length) group.open = true;
  }
  function appendTool(card) {
    if (!turn.toolGroup) {
      turn.toolGroup = appendTurnContent(el("details", "tool-group"));
      turn.toolGroup.innerHTML = '<summary><span class="codicon codicon-tools" aria-hidden="true"></span><span class="tool-group-label">Working</span></summary>';
      // Open, because work you cannot see is work you cannot check. The group collapsed itself
      // the moment it was created, so a run of twenty commands showed one grey line and the
      // reader had no idea what had just been done to their project. The summary sentence still
      // sits in the header when the group is folded by hand.
      turn.toolGroup.open = true;
    }
    turn.toolGroup.appendChild(card);
    refreshToolGroup(turn.toolGroup);
  }

  function openFileBtn(path, line) {
    const b = el("button", "link open-file", "⤢ open"); b.type = "button";
    b.setAttribute("aria-label", `Open ${path}${line ? ` at line ${line}` : ""}`);
    b.title = `Open ${path}${line ? ` at line ${line}` : ""} in the editor`;
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
            : value === "blocked" ? `${copy.past} · blocked, repeated call`
              : value === "denied" ? `${copy.present} · denied`
              : value === "stopped" ? `${copy.past} · stopped` : copy.past;
    }
    if (value !== "running") {
      clearInterval(card._timer);
      const elapsed = card.querySelector(".tool-time");
      if (elapsed && card._startedAt) {
        const seconds = (Date.now() - card._startedAt) / 1000;
        elapsed.textContent = seconds >= 1 ? `${seconds.toFixed(1)}s` : "";
      }
    }
    refreshToolGroup(card.closest(".tool-group"));
  }

  function toolCard(ev) {
    const c = el("div", "tool");
    c.dataset.toolName = String(ev.name || "");
    c.dataset.summary = String(ev.summary || "");
    c._startedAt = Date.now();
    const copy = toolCopy(ev.name);
    const detail = [copy.target, ev.summary || ""].filter(Boolean).join(" · ");
    const bodyId = `tool-output-${++disclosureId}`;
    c.innerHTML = `<div class="head"><button type="button" class="tool-toggle" aria-expanded="false" aria-controls="${bodyId}" title="${esc(ev.name || "tool")}"><span class="chev" aria-hidden="true">›</span><span class="glyph" aria-hidden="true">${glyphFor(ev.name)}</span><span class="verb">${copy.present}</span><span class="arg">${esc(detail)}</span></button></div><div class="body" id="${bodyId}"><pre></pre></div>`;
    const head = c.querySelector(".head");
    const toggle = c.querySelector(".tool-toggle");
    toggle.onclick = () => {
      if (c.classList.contains("no-body")) return;
      const open = c.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    };
    if (["read_file", "write_file", "edit_file", "apply_patch"].includes(ev.name) && ev.summary) head.appendChild(openFileBtn(ev.summary));
    const status = el("span", "sr-only tool-status", "running");
    toggle.appendChild(status);
    // Nothing is running in a replayed turn, so neither the pulse nor the stopwatch is started:
    // both would be animating a step that finished before the window was reopened.
    const dot = el("span", replaying ? "dot" : "dot run"); dot.setAttribute("aria-hidden", "true");
    head.appendChild(dot);
    head.appendChild(el("span", "badge"));
    const elapsed = el("span", "tool-time", ""); head.appendChild(elapsed);
    if (!replaying) c._timer = setInterval(() => {
      const seconds = (Date.now() - c._startedAt) / 1000;
      elapsed.textContent = seconds >= 1 ? `${seconds.toFixed(1)}s` : "";
    }, 200);
    setToolStatus(c, "running");
    appendTool(c); breakText(); return c;
  }
  // A tool card shows its output as soon as there is any: the head says what ran, the body shows
  // the first few lines of what came back, and the toggle opens the rest. The body used to be
  // hidden until clicked, so a collapsed group inside a collapsed body meant the work was
  // invisible twice over.
  function setToolOutput(card, text) {
    const value = String(text || "");
    const pre = card.querySelector(".body pre");
    if (pre) pre.textContent = value;
    card.classList.toggle("has-output", !!value.trim());
    return value;
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
    wrap.innerHTML = `<div class="dhead"><button type="button" class="diff-toggle" aria-expanded="true" aria-controls="${bodyId}"><span class="chev" aria-hidden="true">⌄</span><span class="dg">✎</span><span class="f">${esc(path)}</span><span class="diff-stat add-stat">+${additions}</span><span class="diff-stat del-stat">−${deletions}</span><span class="diff-action sr-only">Hide diff</span></button></div><pre id="${bodyId}">${body}</pre>`;
    const toggle = wrap.querySelector(".diff-toggle");
    toggle.title = "Collapse this diff";
    toggle.onclick = () => {
      const open = wrap.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".chev").textContent = open ? "⌄" : "›";
      toggle.querySelector(".diff-action").textContent = open ? "Hide diff" : "Review";
      toggle.title = open ? "Collapse this diff" : "Show what changed in this file";
    };
    if (path !== "changed file") wrap.querySelector(".dhead").appendChild(openFileBtn(path));
    wrap.dataset.path = path; wrap.dataset.add = String(additions); wrap.dataset.del = String(deletions);
    return wrap;
  }
  //: Tools that change files on disk. Their diffs are what the end-of-turn summary counts.
  // A screenshot is evidence, so it belongs in the transcript rather than behind a file path.
  // Three states, the way Codex shows one: a thumbnail in the step, expanded in place, and a
  // full-size viewer over the panel.
  const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/;

  function openLightbox(src, caption) {
    document.getElementById("lightbox")?.remove();
    const box = el("div"); box.id = "lightbox";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-label", caption || "Screenshot");
    const img = el("img"); img.src = src; img.alt = caption || "Screenshot";
    box.appendChild(img);
    if (caption) { const cap = el("div", "lb-cap"); cap.textContent = caption; box.appendChild(cap); }
    const close = () => { box.remove(); document.removeEventListener("keydown", onKey); };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    box.addEventListener("click", close);
    document.addEventListener("keydown", onKey);
    document.body.appendChild(box);
    box.focus?.();
  }

  function shotStrip(images, caption) {
    const strip = el("div", "shots");
    let added = 0;
    for (const src of images) {
      if (typeof src !== "string" || !IMAGE_DATA.test(src)) continue;   // never inject an unvetted URI
      const shot = el("button", "shot");
      shot.type = "button";
      shot.title = "Click to enlarge · click again for full size";
      const img = el("img");
      img.src = src;
      img.alt = caption || "Screenshot";
      img.loading = "lazy";
      shot.appendChild(img);
      const label = el("span", "shot-cap");
      label.textContent = caption || "Screenshot";
      shot.appendChild(label);
      shot.addEventListener("click", () => {
        if (shot.classList.contains("wide")) { openLightbox(src, caption); return; }
        shot.classList.add("wide");
        shot.title = "Click for full size";
        if (following && atBottom()) scroll();      // growing in place must not yank a reader back
      });
      strip.appendChild(shot);
      added++;
    }
    return added ? strip : null;
  }

  const EDIT_TOOLS = new Set(["edit_file", "write_file", "multi_edit", "apply_patch", "create_file"]);
  function recordEdit(path, additions = 0, deletions = 0) {
    const name = String(path || "").replace(/^[ab]\//, "").replace(/^\/+/, "").trim();
    if (!turn || !name || name === "changed file") return;
    const prior = turn.edits.get(name) || { additions: 0, deletions: 0 };
    turn.edits.set(name, { additions: prior.additions + (Number(additions) || 0),
                           deletions: prior.deletions + (Number(deletions) || 0) });
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
  function requestCard(c, id) { c.dataset.requestId = String(id); renderTurnMeta(); return c; }
  function showQuestionForm(ev) {
    const grouped = Array.isArray(ev.questions);
    const questions = grouped ? ev.questions : [{ id: "q1", header: "Question", question: ev.question, options: ev.options }];
    if (!questions.length || questions.length > 6 || questions.some((q) => !q || typeof q.id !== "string"
      || typeof q.question !== "string" || !Array.isArray(q.options) || q.options.length > 8
      || q.options.some((o) => typeof o !== "string"))
      || new Set(questions.map((q) => q.id)).size !== questions.length) {
      sysLine("DGC received an invalid question form. Stop the turn and retry.", true); return;
    }
    speak(questions.length > 1 ? `${questions.length} questions need your input` : questions[0].question);
    const c = requestCard(decisionCard('<div class="question-form"></div><div class="question-summary"></div>', "Questions for you"), ev.id);
    const form = c.querySelector(".question-form"), states = questions.map(() => ({ selected: null, text: "" }));
    let tab = 0;
    const answer = (i) => states[i].selected === "other" ? states[i].text.trim()
      : Number.isInteger(states[i].selected) ? questions[i].options[states[i].selected] : "";
    function render() {
      const q = questions[tab], state = states[tab];
      form.innerHTML = (questions.length > 1 ? `<div class="question-tabs" role="tablist" aria-label="Questions">${questions.map((item, i) =>
        `<button type="button" class="question-tab${i === tab ? " active" : ""}" role="tab" aria-selected="${i === tab}" tabindex="${i === tab ? 0 : -1}" data-tab="${i}">${esc(item.header || `Question ${i + 1}`)}${answer(i) ? ' ✓' : ''}</button>`).join("")}</div>` : "")
        + `<div class="question-panel" role="group" aria-label="${esc(q.question)}"><div class="q">${esc(q.question)}</div><div class="opts">${q.options.map((o, i) =>
          `<button type="button" class="opt${i === 0 ? " rec" : ""}${state.selected === i ? " selected" : ""}" aria-pressed="${state.selected === i}" data-choice="${i}"><span class="n">${i + 1}</span><span class="ol">${esc(o)}</span></button>`).join("")}
          <button type="button" class="opt${state.selected === "other" ? " selected" : ""}" aria-pressed="${state.selected === "other"}" data-choice="other"><span class="n">${q.options.length + 1}</span><span class="ol">Other<span class="question-hint">Type your own answer</span></span></button></div>
          <textarea class="question-other feedback" rows="3" maxlength="4096" aria-label="Your answer" placeholder="Describe what you want…"${state.selected === "other" ? "" : " hidden"}></textarea></div>
          <div class="btns"><span class="question-progress"></span>${questions.length > 1 ? '<button type="button" class="act question-next">Next</button>' : ''}<button type="button" class="act primary question-submit">Submit</button></div>`;
      const input = form.querySelector(".question-other"), submit = form.querySelector(".question-submit");
      input.value = state.text;
      const refresh = () => {
        const count = questions.filter((_, i) => !!answer(i)).length;
        submit.disabled = count !== questions.length;
        form.querySelector(".question-progress").textContent = `${count} of ${questions.length} answered`;
      };
      input.oninput = () => { state.text = input.value; refresh(); };
      form.querySelectorAll("[data-tab]").forEach((b) => {
        b.onclick = () => { tab = Number(b.dataset.tab); render(); form.querySelector(`[data-tab="${tab}"]`).focus(); };
        b.onkeydown = (event) => {
          if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          tab = event.key === "Home" ? 0 : event.key === "End" ? questions.length - 1
            : (tab + (event.key === "ArrowRight" ? 1 : -1) + questions.length) % questions.length;
          render(); form.querySelector(`[data-tab="${tab}"]`).focus();
        };
      });
      form.querySelectorAll("[data-choice]").forEach((b) => b.onclick = () => {
        if (c.classList.contains("resolved")) return;
        state.selected = b.dataset.choice === "other" ? "other" : Number(b.dataset.choice);
        render();
        form.querySelector(state.selected === "other" ? ".question-other" : `[data-choice="${state.selected}"]`).focus();
      });
      const next = form.querySelector(".question-next");
      if (next) next.onclick = () => { tab = (tab + 1) % questions.length; render(); form.querySelector(`[data-tab="${tab}"]`).focus(); };
      submit.onclick = () => {
        if (questions.some((_, i) => !answer(i)) || !resolveCard(c)) return;
        const answers = Object.fromEntries(questions.map((q, i) => [q.id, answer(i)]));
        c.querySelector(".question-summary").textContent = questions.map((q, i) => `${q.question}\n${answer(i)}`).join("\n\n");
        form.hidden = true;
        vscode.postMessage({ type: "options_response", id: ev.id,
          ...(grouped ? { answers } : { choice: answer(0) }) });
      };
      refresh();
    }
    render();
  }
  function resolveCard(c) {
    if (!c || c.classList.contains("resolved")) return false;
    c.classList.add("resolved"); c.setAttribute("aria-disabled", "true");
    c.querySelectorAll("button, input, select, textarea")
      .forEach((control) => { control.disabled = true; });
    renderTurnMeta();
    return true;
  }
  function expireOpenRequests() {
    document.querySelectorAll(".card[data-request-id]:not(.resolved)").forEach(resolveCard);
  }
  // The two cards a backend death can leave: Continue for an ordinary turn it cut off, and Resume
  // goal when the same death kept repeating and automatic resume stood down. Each is a DGC marker
  // with buttons — clicking Continue sends no words on the user's behalf.
  function removeRecoveryCards() { log.querySelectorAll(".recovery-card").forEach((node) => node.remove()); }
  function recoveryCard(kind, text, actionLabel, onAction) {
    removeRecoveryCards();
    const card = el("div", `sys recovery-card ${kind}`);
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", actionLabel);
    card.appendChild(el("span", "codicon codicon-debug-continue"));
    card.lastChild.setAttribute("aria-hidden", "true");
    card.appendChild(el("span", "recovery-text", esc(text)));
    const actions = el("span", "recovery-actions");
    const go = el("button", "act primary", esc(actionLabel)); go.type = "button";
    go.onclick = () => { card.remove(); onAction(); };
    const dismiss = el("button", "act", "Dismiss"); dismiss.type = "button";
    dismiss.onclick = () => card.remove();
    actions.appendChild(go); actions.appendChild(dismiss); card.appendChild(actions);
    appendConversationContent(card);
    if (!replaying) { speak(text); scroll(); }
    return card;
  }
  // ---- background monitors ----
  // One card per event, inside the turn it arrived in. Lines are command output: they go in as
  // textContent, never as markup.
  function monitorEventCard(ev) {
    const card = el("div", "monitor-event");
    card.dataset.monitorId = String(ev.id || "");
    card.dataset.kind = String(ev.kind || "output");
    card.setAttribute("role", "group");
    const ended = ev.kind === "ended" || ev.kind === "background_exit";
    const lines = (Array.isArray(ev.lines) ? ev.lines : []).map((line) => String(line)).slice(0, 40);
    const head = el("div", "monitor-event-head");
    head.innerHTML = '<span class="codicon codicon-pulse" aria-hidden="true"></span>'
      + `<span class="me-title">Monitor · ${esc(String(ev.description || ev.id || "").slice(0, 120))}</span>`
      + `<span class="me-meta">${ended ? esc(ev.kind === "background_exit" ? "exited" : "ended")
        : `event ${Math.max(0, Number(ev.event_index) || 0)}`}</span>`;
    card.setAttribute("aria-label", `Monitor ${String(ev.description || ev.id || "")}, ${ended ? "ended" : `event ${Number(ev.event_index) || 0}`}`);
    card.appendChild(head);
    const body = ended ? lines.slice(1) : lines;
    if (ended && lines[0]) {
      const summary = el("div", "monitor-event-summary");
      summary.textContent = lines[0];
      card.appendChild(summary);
    }
    if (body.length) {
      const pre = el("pre", "monitor-lines");
      pre.textContent = body.join("\n");
      card.appendChild(pre);
    }
    const omitted = Math.max(0, Number(ev.omitted_lines) || 0);
    if (omitted) {
      const more = el("div", "monitor-more");
      more.textContent = `${omitted} more line${omitted === 1 ? "" : "s"} · ask DGC to read ${String(ev.id || "the monitor")}`;
      card.appendChild(more);
    }
    return card;
  }
  // The monitors of THIS chat: every id a monitors list or a monitor_started named since the chat
  // began. A new chat, clear or resume empties it, so the end of a monitor from the chat that was
  // left (it can reach the webview after the new chat's acknowledgement) is not shown in this one.
  const eventCount = (value) => { const n = Math.max(0, Number(value) || 0); return `${n} event${n === 1 ? "" : "s"}`; };
  let monitorItems = [], monitorsPaused = false;
  const knownMonitorIds = new Set();
  function renderMonitors(ev) {
    monitorItems = (Array.isArray(ev?.items) ? ev.items : [])
      .filter((item) => item && typeof item.id === "string").slice(0, 32);
    if (ev?.reset) knownMonitorIds.clear();
    monitorItems.forEach((item) => knownMonitorIds.add(item.id));
    monitorsPaused = ev?.wake_paused === true;
    const live = monitorItems.filter((item) => item.state === "running" || item.state === "stopping");
    const pending = Math.max(0, Number(ev?.pending_events) || 0);
    const chips = $("monitor-chips");
    chips.innerHTML = "";
    live.forEach((item) => {
      const chip = el("span", "monitor-chip");
      chip.setAttribute("role", "listitem");
      chip.dataset.monitorId = item.id;
      chip.dataset.state = item.state;
      const label = el("span", "monitor-chip-label");
      label.textContent = `${String(item.description || item.id).slice(0, 60)} · ${Math.max(0, Number(item.events) || 0)}`;
      label.title = `${item.id} · ${String(item.command || "")}`;
      chip.appendChild(label);
      const stop = el("button", "rail-icon-button monitor-stop");
      stop.type = "button";
      stop.innerHTML = '<span class="codicon codicon-debug-stop" aria-hidden="true"></span>';
      stop.title = item.state === "stopping" ? "Stopping…" : `Stop ${item.id}`;
      stop.setAttribute("aria-label", `Stop monitor ${String(item.description || item.id)}`);
      stop.disabled = item.state === "stopping";
      stop.onclick = () => { stop.disabled = true; chip.dataset.state = "stopping"; vscode.postMessage({ type: "stopMonitor", id: item.id }); };
      chip.appendChild(stop);
      chips.appendChild(chip);
    });
    const summary = live.length
      ? `${live.length} monitor${live.length === 1 ? "" : "s"}`
      : `${pending} event${pending === 1 ? "" : "s"} waiting`;
    // With chips on the row they are the count; the words only fill a row that has none.
    $("monitors-count").textContent = summary;
    $("monitors-count").hidden = live.length > 0;
    monitorsBar.setAttribute("aria-label", `Background monitors: ${summary}${monitorsPaused ? ", wake-ups paused" : ""}`);
    $("monitors-paused").hidden = !monitorsPaused;
    monitorsBar.dataset.paused = String(monitorsPaused);
    monitorsBar.hidden = !live.length && !(monitorsPaused && pending);
    syncComposerRail();
    if (String(ev?.request_id || "").startsWith("monitors-list")) {
      if (!monitorItems.length) { sysLine("No background monitors in this chat."); return; }
      const c = decisionCard('<div class="q"><span class="codicon codicon-pulse"></span> Background monitors</div><div class="monitor-list"></div>', "Background monitors");
      const list = c.querySelector(".monitor-list");
      monitorItems.forEach((item) => {
        const row = el("div", "abtns monitor-list-row");
        const text = el("span", "monitor-list-text");
        text.textContent = `${item.id} · ${String(item.description || "")} · ${item.state}`
          + `${item.end_reason ? ` (${item.end_reason})` : ""} · ${eventCount(item.events)}`;
        row.appendChild(text);
        if (item.state === "running") {
          const stop = el("button", "abtn", "Stop"); stop.type = "button";
          stop.onclick = () => { stop.disabled = true; vscode.postMessage({ type: "stopMonitor", id: item.id }); };
          row.appendChild(stop);
        }
        list.appendChild(row);
      });
    }
  }
  function sysLine(msg, isErr) { const line = el("div", "sys" + (isErr ? " err" : ""), esc(msg)); if (isErr) line.setAttribute("role", "alert"); appendConversationContent(line); }

  // ---- Codex-style composer rail: durable workspace changes and standing goal ----
  let changeState = { total: 0, additions: 0, deletions: 0, files: [] };
  let workspaceChangeState = { ...changeState }, reviewScope = "chat";
  function syncComposerRail() {
    composerRail.hidden = goalBar.hidden && changesBar.hidden && tasksBar.hidden && monitorsBar.hidden;
    composerRail.classList.toggle("has-monitors", !monitorsBar.hidden);
    composerRail.classList.toggle("has-changes", !changesBar.hidden);
    composerRail.classList.toggle("has-tasks", !tasksBar.hidden);
    composerRail.classList.toggle("has-goal", !goalBar.hidden);
  }
  function setChatChanges(next) {
    const files = Array.isArray(next?.files) ? next.files.filter((item) => item
      && typeof item.path === "string").slice(0, 500) : [];
    changeState = {
      total: Math.max(0, Number(next?.total) || files.length),
      additions: Math.max(0, Number(next?.additions) || 0),
      deletions: Math.max(0, Number(next?.deletions) || 0), files,
      notices: Array.isArray(next?.notices) ? next.notices.map(String).slice(0, 34) : [],
    };
    changesBar.hidden = changeState.total === 0 && !changeState.notices.length;
    $("changes-count").textContent = changeState.notices.length
      ? (changeState.total ? `${changeState.total} changed in this chat · partial scan` : "Changes unavailable")
      : `${changeState.total} ${changeState.total === 1 ? "file" : "files"} changed in this chat`;
    changesBar.title = ["Changes recorded during runs in this chat; existing workspace changes are excluded", ...changeState.notices].join("\n");
    $("changes-add").hidden = $("changes-del").hidden = changeState.total === 0;
    $("changes-add").textContent = `+${changeState.additions}`;
    $("changes-del").textContent = `−${changeState.deletions}`;
    syncComposerRail();
    if (!$("changes-review").hidden) renderChangesReview();
  }
  function renderChangesReview() {
    const changeState = reviewScope === "chat" ? currentChatChanges() : workspaceChangeState;
    $("changes-review-title").textContent = reviewScope === "chat" ? "Changes in this chat" : "Workspace changes";
    $("changes-review-description").textContent = reviewScope === "chat"
      ? "Saved before/after snapshots from this chat’s runs in the primary project folder. Existing changes and edits between runs are excluded. Concurrent edits during a run may be included."
      : "All pending changes since the last Git commit, including edits made before this chat or by other tools.";
    const summary = $("changes-review-summary"), list = $("changes-review-list");
    summary.innerHTML = `<span>${changeState.total} ${changeState.total === 1 ? "file" : "files"} changed</span><span class="change-add">+${changeState.additions}</span><span class="change-del">−${changeState.deletions}</span>`;
    list.innerHTML = changeState.files.length ? changeState.files.map((item, index) =>
      `<button type="button" class="change-row" data-change="${index}" title="${esc(item.error || (item.staged ? "Includes staged changes" : "Review change"))}"><span class="change-kind codicon codicon-${item.deleted ? "trash" : item.untracked ? "new-file" : "diff-modified"}" aria-hidden="true"></span><span class="change-path">${esc(item.path)}</span><span class="change-add">${item.counted === false || item.binary ? "—" : "+" + Math.max(0, Number(item.additions) || 0)}</span><span class="change-del">${item.counted === false || item.binary ? "—" : "−" + Math.max(0, Number(item.deletions) || 0)}</span><span class="codicon codicon-chevron-right" aria-hidden="true"></span></button>`).join("")
      : '<div class="surface-empty">No workspace changes remain.</div>';
    if (changeState.notices?.length) {
      const note = el("div", "surface-notice"); note.textContent = changeState.notices.join(" ");
      list.prepend(note);
      if (!changeState.files.length) list.querySelector(".surface-empty")?.remove();
    }
    list.querySelectorAll("[data-change]").forEach((button) => button.onclick = () => {
      const item = changeState.files[Number(button.dataset.change)];
      if (item) vscode.postMessage({ type: "reviewChange", path: item.id || item.path, scope: reviewScope });
    });
  }
  function currentChatChanges() { return changeState; }
  function setWorkspaceChanges(next) {
    workspaceChangeState = { total: 0, additions: 0, deletions: 0, files: [], ...next };
    if (!$("changes-review").hidden && reviewScope === "workspace") renderChangesReview();
  }
  function openChangesReview(scope = "chat") {
    reviewScope = scope === "workspace" ? "workspace" : "chat";
    renderChangesReview();
    $("changes-review").hidden = false;
    $("changes-review-close").focus();
  }
  function closeChangesReview() {
    $("changes-review").hidden = true;
    (reviewScope === "workspace" || changesBar.hidden ? $("workspace-changes") : $("changes-main")).focus();
  }

  // Standing goal — the objective and clock stay attached immediately above the composer.
  let goalState = { text: "", status: "none", elapsed: 0, running: false }, goalObservedAt = Date.now();
  function currentGoalElapsed() {
    return goalState.elapsed + (goalState.status === "active" && goalState.running
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
    goalState = { ...next, text, status, running: next?.running === true,
      elapsed: Number.isFinite(explicit) && explicit >= 0 ? explicit
        : (text === goalState.text ? priorElapsed : 0) };
    goalObservedAt = Date.now();
    // A finished goal stops being a pinned goal. Leaving it on the rail with a play button meant
    // the obvious next click RESUMED work that was already done -- which is exactly what happened:
    // a completed objective was resumed and started over. The transcript keeps the record.
    goalBar.hidden = !text || status === "completed";
    syncComposerRail();
    if (!text) { closeGoalEditor(false); closeGoalReview(false); return; }
    $("goal-text").textContent = text;
    const paused = status === "paused", blocked = status === "blocked", completed = status === "completed";
    $("goal-status").textContent = paused ? "Paused goal" : blocked ? "Blocked goal" : completed ? "Completed goal" : "Pursuing goal";
    goalBar.dataset.status = status;
    const toggle = $("goal-toggle"), icon = toggle.querySelector(".codicon");
    toggle.hidden = false;
    const resume = paused || blocked;   // never offer to resume something already finished
    icon.className = `codicon codicon-${resume ? "debug-continue" : "debug-pause"}`;
    toggle.title = resume ? "Resume goal" : "Pause goal";
    toggle.setAttribute("aria-label", resume ? "Resume goal" : "Pause goal");
    $("goal-main").title = text;
    $("goal-main").setAttribute("aria-label", `Expand and edit goal: ${text.slice(0, 180)}`);
    paintGoalClock();
    if (!$("goal-review").hidden) renderGoalReview();
  }
  function openGoalEditor() {
    if (!goalState.text) return;
    const editor = $("goal-editor-text");
    editor.value = goalState.text;
    $("goal-editor-budget").value = goalState.token_budget || "";
    $("goal-editor-save").disabled = false;
    $("goal-editor").hidden = false;
    editor.focus(); editor.selectionStart = editor.selectionEnd = editor.value.length;
  }
  function closeGoalEditor(restoreFocus = true) {
    $("goal-editor").hidden = true;
    if (restoreFocus && !goalBar.hidden) $("goal-main").focus();
  }
  function saveGoalEditor() {
    const text = $("goal-editor-text").value.trim();
    if (!text) return;
    const budget = Number($("goal-editor-budget").value || 0);
    if (!Number.isSafeInteger(budget) || budget < 0 || budget > 1e12) {
      $("goal-editor-budget").reportValidity(); return;
    }
    $("goal-editor-save").disabled = true;
    vscode.postMessage({ type: "updateGoal", text, tokenBudget: budget });
  }
  function renderGoalReview() {
    const body = $("goal-review-body");
    body.replaceChildren();
    body.appendChild(el("div", "text", md(goalState.text)));
    const status = el("p");
    status.textContent = `${goalState.status} · ${formatDuration(currentGoalElapsed())} worked · ${Number(goalState.cycles || 0)} cycles`;
    body.appendChild(status);
    const attached = goalState.attachments || {};
    const labels = [...(Array.isArray(attached.skills) ? attached.skills.map(name => "$" + name) : []),
      ...(Array.isArray(attached.templates) ? attached.templates.map(name => "/" + name) : [])];
    if (attached.context) labels.push(`${Number(attached.context)} context attachment${Number(attached.context) === 1 ? "" : "s"}`);
    if (attached.images) labels.push(`${Number(attached.images)} image${Number(attached.images) === 1 ? "" : "s"}`);
    if (labels.length || attached.invalid) {
      const summary = el("p", "goal-attachments");
      summary.textContent = attached.invalid ? "Saved attachments could not be restored. Replace this goal before resuming."
        : "Attached to this goal: " + labels.join(" · ");
      body.appendChild(summary);
    }
    if (goalState.reason) { const reason = el("p"); reason.textContent = goalState.reason; body.appendChild(reason); }
    if (Array.isArray(goalState.evidence) && goalState.evidence.length) {
      body.appendChild(el("h3", "", "Evidence"));
      const list = el("ul");
      goalState.evidence.forEach(item => { const li = el("li"); li.textContent = String(item); list.appendChild(li); });
      body.appendChild(list);
    }
    const usage = el("p");
    usage.textContent = goalState.usage_known === false ? "Token usage unavailable for this route"
      : `${Number(goalState.tokens_used || 0).toLocaleString()} reported tokens${goalState.token_budget ? ` / ${Number(goalState.token_budget).toLocaleString()} budget` : ""}`;
    body.appendChild(usage);
    if (Array.isArray(goalState.history) && goalState.history.length) {
      const history = el("details"), list = el("ul");
      history.appendChild(el("summary", "", "Goal history"));
      goalState.history.forEach(item => { const li = el("li");
        li.textContent = `${String(item.status)} · ${String(item.reason || "")}`; list.appendChild(li); });
      history.appendChild(list); body.appendChild(history);
    }
  }
  function openGoalReview() {
    if (!goalState.text) return;
    renderGoalReview(); $("goal-review").hidden = false; $("goal-review-close").focus();
    vscode.postMessage({ type: "reviewGoal" });
  }
  function closeGoalReview(restoreFocus = true) {
    $("goal-review").hidden = true;
    if (restoreFocus) $("goal-review-button").focus();
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
  let surfaceReturnSection = "";   // the settings tab a surface was opened from, if any

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
    if (surfaceReturnSection) {
      const section = surfaceReturnSection;
      surfaceReturnSection = "";
      surfaceReturnFocus = null;
      vscode.postMessage({ type: "openSettings", section });
      return;
    }
    const target = surfaceReturnFocus && typeof surfaceReturnFocus.focus === "function"
      ? surfaceReturnFocus : input;
    surfaceReturnFocus = null; target.focus();
  }
  function dismissSurface() {
    if (mcpContextPending) { vscode.postMessage({ type: "cancel" }); mcpContextPending = ""; }
    closeSurface();
  }
  function surfaceButtons(primary, primaryAction, secondary, secondaryAction) {
    const p = $("surface-primary"), s = $("surface-secondary");
    for (const button of [p, s]) { delete button.dataset.skillMutation; button.disabled = false; }
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
    const skill = skillRows.find((row) => row.name === name);
    if (skill?.enabled === false) return;
    if (!attachInvocation("skill", name)) return;
    if (!input.value.trim() && skill?.default_prompt) {
      setComposerText(String(skill.default_prompt).slice(0, 4096));
      autosizeComposer();
    }
    closeSurface(); input.focus();
  }
  function attachInvocation(kind, name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) return false;
    if (!attachments.some((a) => a[kind] === name)) {
      if (attachments.filter(item => item.skill || item.template).length >= 8) {
        sysLine("Select at most eight skills and prompt templates per message."); return false;
      }
      if (!canAttach()) return false;
      attachments.push({ label: `${kind === "skill" ? "$" : "/"}${name}`, [kind]: name });
    }
    renderAtts();
    return true;
  }
  function canAttach() {
    const waiting = [...pendingImages].filter(owner => owner.session === draftSession).length;
    if (attachments.length + waiting >= 64) { sysLine("Select at most 64 attachments per message."); return false; }
    return true;
  }
  function renderSkills(items) {
    const query = surfaceKind === "skills" ? surfaceSearch.value : "";
    surfaceRows = Array.isArray(items) ? items : [];
    openSurface("skills");
    surfaceSearch.value = query;
    surfaceBody.innerHTML = surfaceRows.length ? surfaceRows.map((skill, i) =>
      `<article class="surface-card" data-filter="${esc(`${skill.name} ${skill.display_name || ""} ${skill.source} ${skill.description}`.toLowerCase())}"><div class="surface-card-head"><button type="button" class="surface-name" data-skill-view="${i}">${esc(skill.display_name || "$" + skill.name)}</button><span class="surface-badge">${esc(skill.source || "unknown")}${skill.enabled === false ? " · disabled" : skill.allow_implicit_invocation === false ? " · explicit only" : ""}</span></div><p>${esc(skill.short_description || skill.description || "Reusable agent instructions")}</p>${(Array.isArray(skill.diagnostics) ? skill.diagnostics : []).map((line) => `<p class="muted">${esc(line)}</p>`).join("")}<div class="surface-actions"><button type="button" class="act primary" data-skill-use="${i}"${skill.enabled === false ? " disabled" : ""}>Use skill</button><button type="button" class="act" data-skill-view="${i}">View instructions</button>${skillManagement ? `<button type="button" class="act" data-skill-toggle="${i}" aria-pressed="${skill.enabled !== false}">${skill.enabled === false ? "Enable" : "Disable"}</button>` : ""}</div></article>`).join("")
      : '<div class="surface-empty">No skills are installed. Add a project skill at <code>.dgc/skills/&lt;name&gt;/SKILL.md</code>.</div>';
    surfaceBody.querySelectorAll("[data-skill-use]").forEach((button) => button.onclick = () => useSkill(surfaceRows[+button.dataset.skillUse].name));
    surfaceBody.querySelectorAll("[data-skill-view]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "getSkill", name: surfaceRows[+button.dataset.skillView].name }));
    surfaceBody.querySelectorAll("[data-skill-toggle]").forEach((button) => button.onclick = () => {
      const skill = surfaceRows[+button.dataset.skillToggle]; button.disabled = true;
      vscode.postMessage({ type: "skillToggle", name: skill.name, enabled: skill.enabled === false });
    });
    surfaceButtons("Reload", () => vscode.postMessage({ type: "skillsReload" }),
      skillManagement ? "Create / install" : "", () => vscode.postMessage({ type: "skillsManage" }));
    for (const button of [$("surface-primary"), $("surface-secondary"), ...surfaceBody.querySelectorAll("[data-skill-toggle]")]) {
      button.dataset.skillMutation = "true";
      button.disabled = streaming;
      button.title = streaming ? "Available after this turn finishes" : "";
    }
    filterSurface();
  }
  function renderSkillDetail(ev) {
    openSurface("skills");
    if (!ev.found) { surfaceBody.innerHTML = '<div class="surface-empty">That skill is no longer installed.</div>'; return; }
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← All skills</button><div class="surface-detail-head"><h2>$${esc(ev.name)}</h2><span class="surface-badge">${esc(ev.source)}</span></div><p class="muted">${esc(ev.description || "")}</p><div class="surface-markdown">${md(ev.markdown || "")}</div>`;
    surfaceBody.querySelector(".surface-back").onclick = () => renderSkills(surfaceRows);
    const enabled = skillRows.find((skill) => skill.name === ev.name)?.enabled !== false;
    surfaceButtons(enabled ? "Use skill" : "", () => useSkill(ev.name));
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
      closeSurface(); // Keep browser sign-in and permission cards visible while the host connects.
    };
    surfaceButtons(); $("mcp-name").focus();
  }
  function renderMcp() {
    mcpView = "servers";
    openSurface("mcp");
    const servers = mcpRows.length ? mcpRows.map((item, i) =>
      `<article class="surface-card" data-filter="${esc(`${item.name} ${item.state} ${item.command} ${item.url}`.toLowerCase())}"><div class="surface-card-head"><strong>${esc(item.name)}</strong><span class="surface-state ${mcpStateClass(item.state)}">${esc(item.state || "configured")}</span></div><div class="surface-meta">${esc(item.transport === "remote" ? item.url : [item.command, ...(item.args || [])].join(" "))}</div><p>${Number(item.tool_count || 0)} tool(s)${item.protocol_era ? ` · ${esc(item.protocol_era)}` : ""}</p>${item.error ? `<div class="err">${esc(item.error)}</div>` : ""}<div class="surface-actions"><button type="button" class="act" data-mcp-edit="${i}">Edit</button><button type="button" class="act danger" data-mcp-remove="${i}">Remove</button></div></article>`).join("")
      : '<div class="surface-empty">No MCP servers configured.</div>';
    const tools = mcpTools.length ? `<h2 class="surface-subtitle">Available tools · ${mcpTools.length}</h2>${mcpTools.map((tool) => `<article class="surface-card compact" data-filter="${esc(`${tool.name} ${tool.description}`.toLowerCase())}"><strong>${esc(tool.name)}</strong><p>${esc(tool.description || "")}</p></article>`).join("")}` : "";
    surfaceBody.innerHTML = servers + tools;
    if (mcpManagement) {
      surfaceBody.querySelectorAll("[data-mcp-edit]").forEach((button) => {
        const item = mcpRows[+button.dataset.mcpEdit];
        const toggle = el("button", "act", item.enabled === false ? "Enable" : "Disable"); toggle.type = "button";
        toggle.dataset.mcpToggle = item.name;
        toggle.onclick = () => { toggle.disabled = true;
          vscode.postMessage({ type: "mcpToggle", name: item.name, enabled: item.enabled === false }); };
        const reconnect = el("button", "act", "Reconnect"); reconnect.type = "button";
        reconnect.disabled = item.enabled === false;
        reconnect.onclick = () => { reconnect.disabled = true;
          vscode.postMessage({ type: "mcpReconnect", name: item.name }); };
        button.parentElement.append(toggle, reconnect);
      });
    }
    if (mcpContextSupported) {
      surfaceBody.querySelectorAll("[data-mcp-edit]").forEach((button) => {
        const item = mcpRows[+button.dataset.mcpEdit];
        if (item.state !== "connected") return;
        for (const [kind, label] of [["resources", "Resources"], ["templates", "Resource templates"], ["prompts", "Prompts"]]) {
          const browse = el("button", "act", label); browse.type = "button";
          browse.dataset.mcpBrowse = kind;
          browse.onclick = () => browseMcpContext(item.name, kind);
          button.parentElement.appendChild(browse);
        }
      });
    }
    surfaceBody.querySelectorAll("[data-mcp-edit]").forEach((button) => button.onclick = () => showMcpForm(mcpRows[+button.dataset.mcpEdit]));
    surfaceBody.querySelectorAll("[data-mcp-remove]").forEach((button) => button.onclick = () => vscode.postMessage({ type: "mcpRemove", name: mcpRows[+button.dataset.mcpRemove].name }));
    surfaceButtons("Add server", () => showMcpForm(), "Reload", () => vscode.postMessage({ type: "mcpReload" }));
    filterSurface();
  }
  function browseMcpContext(server, kind) {
    mcpView = "context"; openSurface("mcp");
    mcpContextPending = `mcp-context-${Date.now()}-${++mcpContextSequence}`;
    vscode.postMessage({ type: "mcpContextList", requestId: mcpContextPending, server, kind });
    surfaceButtons("Cancel", () => { vscode.postMessage({ type: "cancel" }); mcpContextPending = ""; renderMcp(); });
  }
  function requestMcpContext(server, kind, identifier, args = {}) {
    mcpContextPending = `mcp-context-${Date.now()}-${++mcpContextSequence}`;
    closeSurface();
    vscode.postMessage({ type: "mcpContextGet", requestId: mcpContextPending, server, kind, identifier, arguments: args });
  }
  function renderMcpContextCatalog(ev) {
    if (ev.request_id !== mcpContextPending) return;
    mcpContextPending = ""; mcpView = "context"; openSurface("mcp");
    const rows = Array.isArray(ev.items) ? ev.items : [];
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← MCP servers</button><h2>${esc(ev.server)} · ${esc(ev.kind)}</h2>`
      + (ev.error ? `<div class="err">${esc(ev.error)}</div>` : rows.length ? rows.map((row, i) =>
        `<button type="button" class="surface-card surface-list-button" data-mcp-context="${i}" data-filter="${esc(`${row.name} ${row.description}`.toLowerCase())}"><strong>${esc(row.title || row.name)}</strong><span>${esc(row.description || row.uri || row.uriTemplate || "Preview prompt")}</span></button>`).join("") : '<p class="muted">This server returned no entries for this category.</p>');
    surfaceBody.querySelector(".surface-back").onclick = renderMcp;
    surfaceBody.querySelectorAll("[data-mcp-context]").forEach((button) => button.onclick = () => {
      const row = rows[+button.dataset.mcpContext];
      if (ev.kind === "resources") requestMcpContext(ev.server, "resources", row.uri);
      else renderMcpContextForm(ev.server, ev.kind, row);
    });
    surfaceButtons("Refresh", () => browseMcpContext(ev.server, ev.kind)); filterSurface();
  }
  function renderMcpContextForm(server, kind, row) {
    const args = Array.isArray(row.arguments) ? row.arguments : [];
    const fields = kind === "templates" ? [{ name: "uri", required: true, description: "Fill in a concrete URI using the server's template." }] : args;
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← ${esc(kind)}</button><h2>${esc(row.title || row.name)}</h2><form id="mcp-context-form" class="surface-form">`
      + fields.map((arg, i) => `<label>${esc(arg.name)}${arg.required ? " *" : ""}<span class="set-hint">${esc(arg.description || "")}</span><input data-context-argument="${i}"${arg.required ? " required" : ""} maxlength="8000" value="${kind === "templates" ? esc(row.uriTemplate) : ""}"></label>`).join("")
      + '<button type="submit" class="act primary">Preview context</button></form>';
    surfaceBody.querySelector(".surface-back").onclick = () => browseMcpContext(server, kind);
    $("mcp-context-form").onsubmit = (event) => {
      event.preventDefault(); if (!event.target.reportValidity()) return;
      const values = Object.create(null);
      fields.forEach((arg, i) => { const value = surfaceBody.querySelector(`[data-context-argument="${i}"]`).value;
        if (value || arg.required) values[arg.name] = value; });
      requestMcpContext(server, kind === "templates" ? "resources" : kind,
        kind === "templates" ? values.uri : row.name, kind === "templates" ? {} : values);
    };
    surfaceButtons();
  }
  function renderMcpContext(ev) {
    if (ev.request_id !== mcpContextPending) return;
    mcpContextPending = ""; mcpView = "context"; openSurface("mcp");
    surfaceBody.innerHTML = `<button type="button" class="surface-back">← MCP servers</button><h2>${esc(ev.server)}</h2><p class="muted">${esc(ev.identifier)}</p>`
      + (ev.error ? `<div class="err">${esc(ev.error)}</div>` : `<div class="surface-markdown">${md(ev.text || "")}</div>`)
      + (Array.isArray(ev.omitted) ? ev.omitted.map((line) => `<p class="muted">${esc(line)}</p>`).join("") : "");
    surfaceBody.querySelector(".surface-back").onclick = renderMcp;
    surfaceButtons(!ev.error && ev.text ? "Attach to draft" : "", () => {
      const resource = { type: "mcp_context", server: ev.server, uri: ev.identifier, text: ev.text };
      const previous = attachments.findIndex((item) => item.resource?.type === "mcp_context" && item.resource.server === ev.server && item.resource.uri === ev.identifier);
      const selected = { label: `${ev.server} · ${ev.identifier}`, resource };
      if (previous >= 0) attachments[previous] = selected;
      else { if (!canAttach()) return; attachments.push(selected); }
      renderAtts(); closeSurface(); input.focus();
    });
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
  $("surface-close").onclick = dismissSurface;
  $("surface").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); dismissSurface(); return; }
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
    if (ev.type === "session" || ev.type === "ready") {
      setChatChanges({ files: [], total: 0 });
      $("changes-review").hidden = true;
    }
    const stick = atBottom();
    switch (ev.type) {
      case "ready": {
        backendLive = true; backendDown = false; armTodoClearTimer();
        if (Array.isArray(ev.commands) && ev.commands.length
            && ev.commands.every((c) => c && typeof c === "object")) {
          builtinCommands = ev.commands;
        }
        customCommands = Array.isArray(ev.custom_commands) ? ev.custom_commands
          : (Array.isArray(ev.commands) ? ev.commands.filter((c) => typeof c === "string") : []);
        skillRows = (Array.isArray(ev.skills) ? ev.skills : []).map((skill) =>
          typeof skill === "string" ? { name: skill, description: "", source: "" } : skill);
        skillManagement = ev.capabilities?.skill_management === true;
        liveSteering = ev.capabilities?.live_steering === true;
        nativeSteering = liveSteering && ev.capabilities?.steering_native !== false;
        mcpContextSupported = ev.capabilities?.mcp_context === true;
        mcpManagement = ev.capabilities?.mcp_management === true;
        if (ev.capabilities?.headless_skill_catalog) vscode.postMessage({ type: "requestSkills" });
        setThreadTitle(ev.session_name, ev.session_id, !ev.session_name);
        if (!draftScope && ev.session_id) selectDraftSession(ev.session_id);
        break;
      }
      case "context": {
        contextState = { ...contextState, ...ev };
        renderContext();
        break;
      }
      case "history":
        renderHistory(ev.items || []);
        if (Array.isArray(ev.todos)) renderTodos(ev.todos);
        break;
      case "recall": renderHistory._absorbRecall?.(ev); break;
      case "rewound":
        if (ev.ok) {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; renderQueued(); setSending(false);
        }
        break;
      case "session":
        if (["cleared", "new", "resumed"].includes(ev.kind)) {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; queuedPrompts.clear(); renderQueued(); setSending(false);
        }
        // A fresh chat has no checklist. A resumed one gets its list from the `history`
        // snapshot that follows, so the row is left for that event to overwrite. Either way a
        // clear that was waiting belonged to the chat being left.
        if (["cleared", "new", "resumed"].includes(ev.kind)) { settleTodoClear(); renderMonitors({ items: [], reset: true }); }
        if (ev.kind === "cleared" || ev.kind === "new") renderTodos([]);
        // A branch keeps the conversation on screen — that is the whole point of it.
        if (ev.kind === "forked") {
          sysLine(`Branched into a new chat${ev.name ? ` — ${ev.name}` : ""}. `
            + "The chat you came from keeps everything up to this point.");
        }
        setThreadTitle(ev.name, ev.session_id, ev.kind === "cleared" || ev.kind === "new");
        if (ev.session_id) selectDraftSession(ev.session_id);
        renderUnconfirmedDrafts();
        break;
      case "session_named": setThreadTitle(ev.name); break;
      case "config":
        lastConfig = ev;
        nativeSteering = liveSteering && !ev.subscription_engine;
        renderComposerControls();
        curUltra = ev.ultra_mode === true;
        curWorkers = Math.max(1, Math.min(8, Number(ev.max_parallel_tasks || 4)));
        updateModelControl();
        document.body.classList.toggle("hide-reasoning", ev.show_reasoning === false);
        if (!$("settings").hidden) fillSettings(ev);
        break;
      case "turn_start":
        if (!replaying) removeRecoveryCards();
        startTurn(ev.prompt, ev.kind, ev.turn_id);
        if (!replaying) customCommandPending = "";
        if (!replaying) {
          // A monitor turn was never queued by anyone, so it takes nothing off the queued count.
          setSending(true); if (queuedCount > 0 && ev.kind !== "monitor") { queuedCount--; renderQueued(); }
          // A queued prompt leaves the queue when its own turn starts, matched by the request id the
          // backend carries on turn_start. Never by position: a queued custom slash command, a goal
          // cycle or a continuation has no id of the user's, and popping the head for one of those
          // silently discarded a message the user could otherwise restore after a backend exit.
          if (typeof ev.request_id === "string" && ev.request_id) queuedPrompts.delete(ev.request_id);
        }
        break;
      // What the turn is doing, stated by the backend rather than guessed here. A turn that is
      // between model rounds because a gate continued it now says so, instead of a static verb
      // that could not be wrong because it never changed.
      case "turn_activity": {
        if (!turn || (ev.turn_id && turn.id && ev.turn_id !== turn.id)) break;
        const label = String(ev.label || "").slice(0, 80);
        const detail = String(ev.detail || "").slice(0, 120);
        const changed = !turn.activity || turn.activity.state !== ev.state
          || turn.activity.label !== label || turn.activity.detail !== detail;
        turn.activity = { state: String(ev.state || ""), label, detail };
        if (changed) turn.phaseT0 = Date.now();      // the phase clock restarts with the phase
        renderTurnMeta();
        break;
      }
      case "turn_eta": if (turn && typeof ev.label === "string") { turn.eta = ev.label.slice(0, 80); renderTurnMeta(); } break;
      case "handoff_started":
        startTurn(); setSending(true); speak("DGC is generating a handoff");
        if (turn) { turn.handoff = true; renderTurnMeta(); }
        break;
      case "queued": queuedCount = ev.count; renderQueued(); break;
      case "prompt_accepted": {
        const pending = pendingPrompts.get(ev.request_id);
        if (ev.state === "steered") {
          if (pending?.node) pending.node.querySelector(".role").textContent = "you · steering pending";
        } else {
          if (ev.state === "queued" && pending?.node) pending.node.querySelector(".role").textContent = "you · queued";
          if (ev.state === "queued" && pending) queuedPrompts.set(ev.request_id, pending);
          pendingPrompts.delete(ev.request_id);
        }
        if (ev.message) sysLine(ev.message);
        persistDraft(); break;
      }
      case "steering_update": {
        const pending = pendingPrompts.get(ev.request_id);
        if (ev.state === "returned") {
          rejectPrompt(ev.request_id);
          if (ev.message) sysLine(ev.message);
        } else {
          if (pending?.node) {
            pending.node.querySelector(".role").textContent = ev.state === "applied" ? "you · steering" : "you · queued";
            if (ev.state === "applied" && turn) {
              flushText(); finishReasoning();
              if (turn.textEl) turn.textEl.classList.add("commentary");
              turn.textEl = null; turn._buf = ""; turn.toolGroup = null;
              appendTurnContent(pending.node);
            }
          }
          // Unconsumed steering is spliced back in at the HEAD of the backend's queue.
          if (ev.state === "queued" && pending) {
            const rest = [...queuedPrompts]; queuedPrompts.clear();
            queuedPrompts.set(ev.request_id, pending);
            for (const [key, value] of rest) queuedPrompts.set(key, value);
          }
          pendingPrompts.delete(ev.request_id); persistDraft();
        }
        break;
      }
      case "text_delta": ensureTurn(); finishReasoning(); turn.toolGroup = null; turn.chars += ev.text.length; appendText(ev.text); break;
      case "thinking_delta":
        ensureTurn(); turn.chars += ev.text.length;
        if (!turn.reasonEl) {
          const d = el("button", "disclosure", "▸ thinking"), r = el("div", "reasoning");
          const reasonId = `reasoning-${++disclosureId}`;
          d.type = "button"; d.setAttribute("aria-expanded", "false"); d.setAttribute("aria-controls", reasonId); r.id = reasonId;
          d.dataset.label = "Thinking"; turn.reasonStarted = Date.now();
          d.title = "Show the model\u2019s reasoning for this turn";
          d.onclick = () => { const open = r.classList.toggle("show"); d.textContent = (open ? "▾" : "▸") + " " + d.dataset.label; d.setAttribute("aria-expanded", String(open)); };
          appendTurnContent(d); appendTurnContent(r); turn.reasonEl = r;
        }
        turn.reasonEl.textContent += ev.text; break;
      // The block that just closed, named and classified by the backend. `phase` absent means
      // undetermined (a cancelled or errored round genuinely does not know), and then nothing is
      // claimed here: `turn_end` still designates the answer.
      case "stream_end": {
        finishReasoning();
        const closed = turn?.textEl;
        if (closed) {
          if (ev.message_id) closed.dataset.messageId = String(ev.message_id);
          if (ev.phase === "commentary") closed.classList.add("commentary");
        }
        breakText();
        break;
      }
      case "tool_call": {
        ensureTurn(); finishReasoning();
        turn._tools = turn._tools || Object.create(null);
        turn._tools[ev.call_id || ev.name] = toolCard(ev);
        // Remember the path an edit tool was called with, so a result that carries no diff
        // (a brand-new file, a binary write) still reaches the end-of-turn summary.
        turn._paths = turn._paths || Object.create(null);
        const target = ev.args && (ev.args.path || ev.args.file_path || ev.args.file);
        if (EDIT_TOOLS.has(String(ev.name || "")) && target) turn._paths[ev.call_id || ev.name] = String(target);
        break;
      }
      case "tool_progress": {
        ensureTurn();
        turn._tools = turn._tools || Object.create(null);
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name }));
        const numeric = Number.isFinite(ev.progress);
        const hasTotal = numeric && Number.isFinite(ev.total) && ev.total !== 0;
        setToolOutput(c, String(ev.message || "").slice(0, 500));
        c.querySelector(".badge").textContent = hasTotal
          ? Math.max(0, Math.min(100, Math.round(ev.progress / ev.total * 100))) + "%"
          : (numeric ? String(ev.progress) : "");
        break;
      }
      case "tool_images": {
        ensureTurn();
        const strip = shotStrip(Array.isArray(ev.images) ? ev.images : [], String(ev.caption || ""));
        if (strip) {
          // A screenshot is evidence for the answer, not a detail of the step, so it goes in the
          // conversation flow. Inside the tool group it would sit behind a collapsed disclosure
          // and the reader would never know it existed.
          appendTurnContent(strip);
          if (stick || following) scroll(); else noteNewContent();
        }
        break;
      }
      case "tool_result": {
        ensureTurn();
        if (!ev.is_error && EDIT_TOOLS.has(String(ev.name || "")) && !ev.is_diff) {
          recordEdit(turn._paths?.[ev.call_id || ev.name]);
        }
        turn._tools = turn._tools || Object.create(null);
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name }));
        c.querySelector(".dot").className = "dot " + (ev.is_error ? "err" : "ok");
        // (status is refined just below; a blocked repeat is not an error of the command)
        // A repeat the loop guard refused never ran, so reporting it as a failed command sends
        // the user hunting for a problem in their code. Keep it an error for the model; say what
        // actually happened here. The prefix is agent.LOOP_GUARD_PREFIX; a test pins them together.
        const blocked = ev.is_error
          && String(ev.output || "").startsWith("error: repeated tool call blocked");
        setToolStatus(c, blocked ? "blocked" : (ev.is_error ? "failed" : "completed"));
        if (ev.is_error) {
          c.classList.add("open"); c.querySelector(".tool-toggle").setAttribute("aria-expanded", "true");
        }
        if (ev.is_diff && ev.diff) {
          c.classList.add("no-body");           // the diff below is this step's detail
          const rendered = renderDiff(ev.diff); c.after(rendered);
          if (!ev.is_error) recordEdit(rendered.dataset.path, rendered.dataset.add, rendered.dataset.del);
        }
        else {
          const out = setToolOutput(c, String(ev.output || "").slice(0, 4000));
          c.querySelector(".badge").textContent = out.split("\n").length + " ln";
        }
        breakText(); break;
      }
      case "tool_denied": {
        ensureTurn();
        turn._tools = turn._tools || Object.create(null);
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name, summary: ev.reason }));
        c.querySelector(".dot").className = "dot deny";
        setToolStatus(c, "denied");
        setToolOutput(c, String(ev.reason || "Permission denied"));
        c.classList.add("open"); c.querySelector(".tool-toggle").setAttribute("aria-expanded", "true");
        break;
      }
      case "permission_request": {
        ensureTurn();
        speak(`Permission required to run ${ev.name}`);
        // v7: the step's summary and, for an edit, the diff it would apply — approve against
        // what will happen, not raw JSON. A denial can carry a note for the model.
        const detail = ev.command ? `<pre>$ ${esc(ev.command)}</pre>`
          : ev.diff ? "" : `<pre>${esc(JSON.stringify(ev.args))}</pre>`;
        const restates = ev.summary && detail.includes(esc(String(ev.summary)));
        const summary = ev.summary && !restates ? `<div class="muted">${esc(ev.summary)}</div>` : "";
        const c = requestCard(decisionCard(`<div class="q"><span class="codicon codicon-shield" aria-hidden="true"></span><span>Run <b>${esc(ev.name)}</b></span></div>${summary}${detail}<textarea class="feedback" rows="1" placeholder="If you deny: a note for the model (optional)"></textarea><div class="btns"><button type="button" class="act primary" data-d="once">Allow once</button><button type="button" class="act" data-d="always">Always allow</button><button type="button" class="act" data-d="deny">Deny</button></div>`, "Tool permission request"), ev.id);
        if (ev.diff) { c.querySelector(".feedback").before(renderDiff(String(ev.diff))); }
        c.querySelectorAll("button").forEach((b) => b.onclick = () => {
          const note = (c.querySelector(".feedback")?.value || "").trim().slice(0, 2000);
          if (!resolveCard(c)) return;
          vscode.postMessage({ type: "permission_response", id: ev.id, decision: b.dataset.d,
            rule: b.dataset.d === "always" ? ev.suggested_rule : undefined,
            reason: b.dataset.d === "deny" && note ? note : undefined });
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
        showQuestionForm(ev);
        break;
      }
      case "mcp_input_request": {
        closeSurface();
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
      case "todos":
        renderTodos(ev.todos);
        return;   // the transcript did not change: no follow scroll, no "New" on the pill
      case "monitor_event": {
        ensureTurn();
        appendTurnContent(monitorEventCard(ev)); breakText();
        break;
      }
      case "monitor_started":
        knownMonitorIds.add(String(ev.id || ""));
        sysLine(`Monitor ${ev.id} started · ${String(ev.description || "")}`);
        break;
      case "monitor_ended":
        if (!knownMonitorIds.has(String(ev.id || ""))) break;   // a monitor of a chat that was left
        sysLine(`Monitor ${ev.id} · ${String(ev.message || ev.reason || "ended")}`, ev.reason === "flood" || ev.reason === "error");
        break;
      case "monitors":
        renderMonitors(ev);
        break;
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
        skillRows = Array.isArray(ev.items) ? ev.items : [];
        if (surfaceKind === "skills") renderSkills(ev.items);
        if (popMode === "/" || popMode === "$") onInput();
        break;
      }
      case "skill_detail": if (surfaceKind === "skills") renderSkillDetail(ev); break;
      case "docs_catalog": if (surfaceKind === "docs") renderDocs(ev.items); break;
      case "usage_report": renderUsage(ev); break;
      case "doc": if (surfaceKind === "docs") renderDoc(ev); break;
      case "mcp_servers":
        mcpRows = Array.isArray(ev.items) ? ev.items : [];
        if (surfaceKind === "mcp" && mcpView === "servers") renderMcp();
        if (ev.error && surfaceKind === "mcp") {
          const warning = el("div", "err surface-notice", esc(ev.error));
          surfaceBody.insertBefore(warning, surfaceBody.firstChild);
        }
        break;
      case "mcp_tools":
        mcpTools = Array.isArray(ev.tools) ? ev.tools : [];
        if (surfaceKind === "mcp" && mcpView === "servers") renderMcp();
        break;
      case "mcp_context_catalog": renderMcpContextCatalog(ev); break;
      case "mcp_context": renderMcpContext(ev); break;
      case "mcp_command_result": {
        if (ev.request_id !== mcpContextPending) break;
        if (ev.context) renderMcpContext({ ...ev.context, request_id: ev.request_id });
        else if (ev.catalog) renderMcpContextCatalog({ ...ev.catalog, request_id: ev.request_id });
        else {
          mcpContextPending = ""; renderMcp();
          if (ev.error || ev.output) {
            const result = el("pre", ev.error ? "err" : "surface-meta");
            result.textContent = ev.error || ev.output;
            surfaceBody.prepend(result);
          }
        }
        break;
      }
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
        textBlock()._markdown = markdown; textBlock().innerHTML = md(markdown);
        enrichMarkdown(textBlock());
        if (ev.path) sysLine(`Handoff saved to ${ev.path}`);
        if (ev.status !== "completed") sysLine(String(ev.error || `Handoff ${ev.status}`), true);
        speak(ev.status === "completed" ? "Handoff ready" : `Handoff ${ev.status}`);
        endTurn(ev.status === "completed" ? "completed" : "error"); setSending(false);
        break;
      }
      case "goal_changed": {
        const text = String(ev.goal || "");
        setGoalState({ ...ev.details, text, status: ev.status, elapsed_seconds: ev.elapsed_seconds });
        break;
      }
      case "status":
        sysLine(`${ev.model} · ${ev.mode} · thinking ${ev.think} · context ${ev.context_used}/${ev.context_size}`
          + (ev.ultra_mode ? " · Ultra" : "")
          + (ev.goal && ev.goal.text ? ` · goal ${ev.goal.status}` : ""));
        break;
      case "rule_added": sysLine("＋ rule: " + ev.rule); break;
      case "info": sysLine(ev.message); break;
      case "mode_changed": if (ev.message) sysLine(ev.message); break;
      case "permission_resolved":
        document.querySelectorAll(".card[data-request-id]").forEach((card) => {
          if (card.dataset.requestId === String(ev.id)) resolveCard(card);
        });
        sysLine(ev.message, ev.decision === "no"); break;
      case "command_rejected":
        // A refused Clear says why beside the checklist, not in the transcript.
        if (ev.command === "clear_todos") { settleTodoClear(ev.message || "DGC could not clear the checklist."); break; }
        if (ev.command === "prompt" || ev.command === "start_goal") rejectPrompt(ev.request_id);
        // A custom slash command that was refused (busy, queue full) never started a turn.
        if (ev.command === "slash_command") settleCustomCommand();
        sysLine(ev.message || "Command unavailable while a turn is running", true); break;
      case "request_expired":
        document.querySelectorAll(".card[data-request-id]").forEach((card) => {
          if (card.dataset.requestId === String(ev.id)) resolveCard(card);
        });
        sysLine("Input request closed. No unanswered choice was selected."); break;
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
      case "error":
        speak(`DGC error: ${ev.message}`); sysLine(ev.message, true);
        if (ev.fatal) { endTurn("error"); setSending(false); }
        // "unknown command: /foo" / "custom command /foo is empty": no turn is coming for it.
        else if (answersCustomCommand(ev.message)) settleCustomCommand();
        break;
      case "turn_end":
        speak(ev.reason === "cancelled" ? "DGC generation stopped" : ev.reason === "error" ? "DGC response ended with an error" : "DGC response complete");
        endTurn(ev.reason, ev.final_message_id);
        if (!replaying) setSending(false);
        break;
    }
    // A replayed page anchors its own scroll position and is not news: no jump to the bottom, and
    // no "New" pill for a turn that finished before the window was reopened.
    if (replaying) return;
    if (stick || following) scroll(); else noteNewContent();
  }

  // ---- composer ----
  function hasComposerInput() { return Boolean(input.value.trim() || attachments.length); }
  function renderComposerControls() {
    const hasDraft = hasComposerInput(), stop = streaming && !hasDraft;
    const label = stop ? "Stop generation" : streaming ? (nativeSteering ? "Steer current run" : "Queue next turn") : "Send message";
    // This runs on every keystroke. Replacing a node's children while typing closes Chromium's open
    // typing step, which made each Ctrl+Z take back one character, so write only what changed.
    const icon = stop ? "debug-stop" : "arrow-up";
    if (send._icon !== icon) {
      send.innerHTML = `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`;
      send._icon = icon;
    }
    if (send.getAttribute("aria-label") !== label) { send.title = label; send.setAttribute("aria-label", label); }
    // Filled (DGC purple) only when the button will actually do something: text to send, or a
    // run to stop. Empty composer leaves it a quiet surface, so the accent stays meaningful.
    send.classList.toggle("ready", hasDraft || streaming);
    $("queue-send").hidden = !streaming || !nativeSteering;
    $("queue-send").disabled = !hasDraft;
    $("stop-run").hidden = !streaming || !hasDraft;
    $("followup-hint").hidden = !streaming;
    const hint = nativeSteering ? "Enter to steer · Alt+Enter to queue" : "Follow-ups queue for the next turn";
    if ($("followup-hint").textContent !== hint) $("followup-hint").textContent = hint;
  }
  function settleCustomCommand() {
    if (!customCommandPending) return;
    customCommandPending = "";
    if (!turn) setSending(false);
  }
  // Only the backend's answer to the pending command settles it. `slash_command` errors carry no
  // request id, so match their two fixed texts for that command's name; any other error (a tool,
  // an MCP server, a setting) says nothing about whether the command's turn is on its way.
  function answersCustomCommand(message) {
    const name = customCommandPending;
    if (!name) return false;
    const text = String(message || "").toLowerCase();
    return text === `custom command /${name} is empty`
      || text === `unknown command: /${name}` || text.startsWith(`unknown command: /${name} `);
  }
  function setSending(on) {
    streaming = on; renderComposerControls();
    document.querySelectorAll("[data-skill-mutation]").forEach(button => {
      button.disabled = on; button.title = on ? "Available after this turn finishes" : "";
    });
  }
  function doStop() { queuedCount = 0; queuedPrompts.clear(); renderQueued(); vscode.postMessage({ type: "cancel" }); }
  $("goal-toggle").onclick = () => vscode.postMessage({
    type: goalState.status === "active" ? "pauseGoal" : "resumeGoal",
  });
  $("goal-clear").onclick = () => vscode.postMessage({ type: "clearGoal" });
  // Clear is never disabled: the backend empties the list even while a turn runs.
  $("tasks-clear").onclick = requestTodoClear;
  $("tasks-main").onclick = toggleTasks;
  $("tasks-toggle").onclick = toggleTasks;
  $("goal-main").onclick = openGoalEditor;
  $("goal-edit").onclick = openGoalEditor;
  $("goal-review-button").onclick = openGoalReview;
  $("goal-review-close").onclick = () => closeGoalReview();
  $("goal-review").addEventListener("click", event => { if (event.target === $("goal-review")) closeGoalReview(); });
  $("goal-review").addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); closeGoalReview(); } });
  for (const dialog of [$("goal-editor"), $("goal-review")]) {
    dialog.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const nodes = [...dialog.querySelectorAll('button, input, textarea, summary, [tabindex="0"]')]
        .filter(node => !node.disabled && !node.closest("[hidden]"));
      const first = nodes[0], last = nodes.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
  }
  $("goal-editor-close").onclick = () => closeGoalEditor();
  $("goal-editor-cancel").onclick = () => closeGoalEditor();
  $("goal-editor-save").onclick = saveGoalEditor;
  $("goal-editor-text").addEventListener("input", () => {
    $("goal-editor-save").disabled = !$("goal-editor-text").value.trim();
  });
  $("goal-editor").addEventListener("click", (event) => {
    if (event.target === $("goal-editor")) closeGoalEditor();
  });
  $("workspace-changes").onclick = () => openChangesReview("workspace");
  $("changes-main").onclick = () => openChangesReview("chat");
  $("changes-review-button").onclick = () => openChangesReview("chat");
  $("changes-review-close").onclick = closeChangesReview;
  $("goal-editor").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeGoalEditor(); }
    else if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault(); saveGoalEditor();
    }
  });
  $("changes-review").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeChangesReview(); }
  });
  function appendGoalPrompt(objective) {
    const m = el("div", "msg user goal-prompt");
    m.appendChild(el("div", "role", "goal"));
    m.appendChild(el("div", "bubble", esc(objective)));
    log.appendChild(m); setSending(true);
    return m;
  }
  function submitGoal(objective, restoreText = input.value) {
    if (!sessionReady || pendingImageFiles || pendingPrompts.size >= 17) {
      sysLine("Wait for DGC and pending attachments before starting the goal."); persistDraft(); return;
    }
    const selected = [...attachments];
    const node = appendGoalPrompt(objective + selected.map(item => `\n[${item.label}]`).join(""));
    const requestId = `${promptPrefix}-${++promptSequence}`;
    pendingPrompts.set(requestId, { text: restoreText, attachments: selected, node, session: draftSession });
    const values = key => selected.filter(item => item[key]).map(item => item[key]);
    vscode.postMessage({ type: "startGoal", text: objective, requestId,
      skills: values("skill"), templates: values("template"), context: values("resource"),
      images: selected.filter(item => item.img).map(item => item.data) });
    clearComposer(); attachments.length = 0;
    renderAtts(); persistDraft(); scroll();
  }
  function submit(delivery = nativeSteering ? "steer" : "queue") {
    if (!sessionReady) { sysLine("DGC is reconnecting to this chat. Your draft is saved."); persistDraft(); return; }
    if (pendingImageFiles) { sysLine("Wait for the pasted images to finish loading before sending."); return; }
    // A folded paste is part of the message, not a side-channel: append it in chip order so the
    // model receives exactly what was pasted.
    const pastes = attachments.filter((a) => a.pasted);
    const typed = input.value.trim();
    const text = pastes.length
      ? [typed, ...pastes.map((a) => a.pasted)].filter(Boolean).join("\n\n")
      : typed;
    if (!text && !attachments.length) return;
    if (pendingPrompts.size >= 17) { sysLine("Wait for the pending messages to be acknowledged before sending another.", true); return; }
    const imgs = attachments.filter((a) => a.img).map((a) => a.data);
    const resources = attachments.filter((a) => a.resource).map((a) => a.resource);
    const skills = attachments.filter((a) => a.skill).map((a) => a.skill);
    const templates = attachments.filter((a) => a.template).map((a) => a.template);
    const goalPrefix = /^\/goal\s+([\s\S]+)$/i.exec(text)?.[1].trim();
    const goalStateCommand = ["clear", "off", "none", "remove", "complete", "completed",
      "done", "blocked", "block", "pause", "paused", "resume", "active", "reactivate", "review", "status", "delete"];
    if (goalPrefix && !goalStateCommand.includes(goalPrefix.toLowerCase())) {
      submitGoal(goalPrefix); return;
    }
    if (goalPrefix || text.toLowerCase() === "/goal") {
      vscode.postMessage({ type: "slashText", text });
      clearComposer(); persistDraft(); return;
    }
    const trailingGoal = /^([\s\S]*\S)\s+\/goal$/i.exec(text)?.[1].trim();
    if (trailingGoal) { submitGoal(trailingGoal); return; }
    const workflowPrompt = (/^\/(plan|review|init)(?:\s|$)/i.test(text)
      || /\s+\/(plan|review|init)$/i.test(text)) && !(text.toLowerCase() === "/plan" && !attachments.length);
    if (text.startsWith("/") && !attachments.length && !workflowPrompt) {
      const name = (text.slice(1).split(/\s+/, 1)[0] || "").toLowerCase();
      // The terminals' `/todo clear` does what the Tasks row's Clear does, pending state and all.
      if (/^\/todo\s+clear$/i.test(text)) {
        requestTodoClear();
        clearComposer(); persistDraft(); return;
      }
      const custom = customCommands.includes(name);
      if (custom) {
          const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
          m.appendChild(el("div", "bubble", esc(text)));
          log.appendChild(m); settleBlock(m);
          // Idle, this shows Stop until the command's turn starts. If the backend answers with an
          // error or a refusal instead, no turn is coming and the composer must come back.
          if (!streaming) customCommandPending = name;
          setSending(true);
      }
      vscode.postMessage({ type: "slashText", text });
      clearComposer(); persistDraft(); scroll(); return;
    }
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    m.appendChild(el("div", "bubble", esc(text) + attachments.map((a) => `\n[${esc(a.label)}]`).join(""))); log.appendChild(m); settleBlock(m);
    const requestId = `${promptPrefix}-${++promptSequence}`;
    pendingPrompts.set(requestId, { text, attachments: [...attachments], node: m, session: draftSession });
    vscode.postMessage({ type: "prompt", text, requestId, images: imgs.length ? imgs : undefined,
      delivery,
      skills: skills.length ? skills : undefined, templates: templates.length ? templates : undefined,
      context: resources.length ? resources : undefined });
    clearComposer(); attachments.length = 0; renderAtts(); persistDraft(); setSending(true); scroll();
  }
  function renderAtts() {
    atts.innerHTML = "";
    attachments.forEach((a, i) => {
      const chip = el("span", `chip${a.skill || a.template ? " invocation-chip" : ""}${a.pasted ? " pasted-chip" : ""}`);
      const label = el("span", "chip-label"), remove = el("button", "x", "\u00d7");
      label.textContent = a.pasted ? `Pasted text · ${a.chars.toLocaleString()} chars` : a.label;
      label.title = label.textContent; remove.type = "button"; remove.title = "Remove this attachment";
      remove.setAttribute("aria-label", `Remove attachment ${label.textContent}`);
      remove.onclick = () => { attachments.splice(i, 1); renderAtts(); };
      chip.appendChild(label);
      if (a.pasted) {
        // The paste is not hidden, only folded away. One click puts it back where it was typed.
        const show = el("button", "chip-action", "Show in text field");
        show.type = "button";
        show.title = "Put this text back into the composer";
        show.onclick = () => {
          const at = input.selectionStart ?? input.value.length;
          const before = input.value;
          editComposer(at, at, a.pasted);
          input.selectionStart = input.selectionEnd = at + a.pasted.length;
          // The insert is in the textarea's undo history; the chip leaving is not. Remember both
          // sides so Ctrl+Z folds the text back into its chip instead of deleting the paste.
          shownPastes.push({ before, after: input.value, item: a, index: i });
          if (shownPastes.length > 8) shownPastes.shift();
          attachments.splice(i, 1);
          renderAtts();
          input.focus();
          autosizeComposer();
        };
        chip.appendChild(show);
      }
      chip.appendChild(remove); atts.appendChild(chip);
    });
    scheduleDraftSave();
    renderComposerControls();
  }

  // ---- @file / slash popover ----
  function hidePop() { pop.style.display = "none"; popMode = null; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); }
  function showPop(items) {
    popItems = items; popIdx = 0;
    if (!items.length) return hidePop();
    pop.innerHTML = items.map((it, i) => `<div id="pop-option-${i}" role="option" aria-selected="${i === 0}" class="pi${i === 0 ? " sel" : ""}" data-i="${i}"><span class="pi-label">${esc(it.label)}</span>${it.kind ? `<span class="pi-kind">${esc(it.kind)}</span>` : ""}${it.detail ? `<span class="pd">${esc(it.detail)}</span>` : ""}</div>`).join("");
    pop.querySelectorAll(".pi").forEach((e) => e.onclick = () => choosePop(Number(e.dataset.i)));
    pop.style.display = "block"; input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-activedescendant", "pop-option-0");
  }
  function movePop(d) {
    if (!popMode) return;
    popIdx = (popIdx + d + popItems.length) % popItems.length;
    [...pop.children].forEach((c, i) => { const selected = i === popIdx; c.className = "pi" + (selected ? " sel" : ""); c.setAttribute("aria-selected", String(selected)); });
    input.setAttribute("aria-activedescendant", `pop-option-${popIdx}`);
    pop.children[popIdx]?.scrollIntoView?.({ block: "nearest" });
  }
  function replacePopToken(value = "") {
    editComposer(popStart, popEnd, value);
    input.selectionStart = input.selectionEnd = popStart + value.length;
    autosizeComposer();
    scheduleDraftSave();
  }
  function choosePop(i) {
    const it = popItems[i]; if (!it) return;
    if (it.skill || it.template) {
      if (!attachInvocation(it.skill ? "skill" : "template", it.skill || it.template)) return;
      replacePopToken();
      hidePop(); input.focus(); return;
    }
    if (popMode === "@") {
      if (!canAttach()) return;
      attachments.push({ label: it.label, resource: {
        type: "file_mention", uri: it.uri, path: it.path,
        relative_path: it.relative_path, workspace: it.workspace,
      } });
      renderAtts();
      replacePopToken();
    } else if (popMode === "/") {
      if (it.action?.startsWith("workflow:")) {
        // One edit, so one Ctrl+Z returns to what was typed: removing the token and adding the
        // prefix as two edits left a blank box between them in the undo history.
        prepareWorkflowDraft(it.action.slice("workflow:".length), popStart, popEnd);
        hidePop(); input.focus(); return;
      }
      if (input.value.slice(0, popStart).trim() || input.value.slice(popEnd).trim()) {
        replacePopToken(); hidePop(); input.focus();
        if (it.action === "goal" && input.value.trim()) {
          const objective = input.value.trim();
          submitGoal(objective, `${objective} /goal`);
        } else {
          // Management actions operate independently of the draft. Opening a model, skills,
          // MCP, or settings picker must not submit or replace the user's unfinished request.
          vscode.postMessage({ type: "slash", action: it.action });
        }
        return;
      }
      if (it.acceptsArgs || (it.action && it.action.indexOf("custom:") === 0)) {
        replacePopToken(it.label + " ");
        hidePop(); input.focus(); return;
      }
      replacePopToken();
      vscode.postMessage({ type: "slash", action: it.action });
    }
    hidePop(); input.focus();
  }
  // `tokenStart`/`tokenEnd`: the slash-menu token this replaces, removed in the same edit.
  function prepareWorkflowDraft(name, tokenStart = 0, tokenEnd = tokenStart) {
    if (!["plan", "review", "init"].includes(name)) return;
    const prefix = `/${name} `;
    const value = input.value;
    const token = tokenEnd > tokenStart;
    const without = token ? value.slice(0, tokenStart) + value.slice(tokenEnd) : value;
    const current = /^\/(plan|review|init)(?:\s+|$)/i.exec(without);
    const removed = current ? current[0].length : 0;
    const caret = Math.max(0, (token ? tokenStart : input.selectionStart) - removed) + prefix.length;
    const next = prefix + without.slice(removed);
    // The smallest single replacement that turns the box into `next`.
    let head = 0;
    while (head < value.length && head < next.length && value[head] === next[head]) head++;
    let tail = 0;
    while (tail < value.length - head && tail < next.length - head
      && value[value.length - 1 - tail] === next[next.length - 1 - tail]) tail++;
    editComposer(head, value.length - tail, next.slice(head, next.length - tail));
    input.selectionStart = input.selectionEnd = caret;
    autosizeComposer();
    persistDraft(); input.focus();
  }
  // ---- composer height ----
  // The box grows with its text up to 160px. That needs a real layout: measured while the panel is
  // hidden (another view in front, the editor collapsing it to zero width), the text wraps one
  // character per line and the box came back 160px tall; measured under display:none it came back
  // 0px. A turn that stops while you are elsewhere restarts the backend and restores the draft, so
  // this happened exactly when DGC was not on screen. Measure only when laid out, and measure again
  // whenever the box's width really changes or the panel becomes visible.
  var composerSizedWidth = -1;   // var: callers above this line run before it at startup
  function autosizeComposer() {
    const width = input.clientWidth;
    if (!input.isConnected || width < 40 || document.hidden) { composerSizedWidth = -1; return; }
    composerSizedWidth = width;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  }
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(() => { if (input.clientWidth !== composerSizedWidth) autosizeComposer(); })
      .observe(input.parentElement || input);
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden) autosizeComposer(); });
  window.addEventListener("focus", autosizeComposer);

  // ---- composer edits that Cmd/Ctrl+Z can take back ----
  // A textarea keeps its own undo history, which is what makes Cmd+Z and Ctrl+Z work in Claude's
  // and Codex's composers. (VS Code's Edit → Undo menu item does not reach it: the workbench sends
  // that command to the active editor, and opening the menu takes focus out of this view.)
  // Assigning .value wipes that history, so undo did nothing here after a send, a completion or an
  // inserted command. Edits made through the browser's own editing command stay in the history
  // instead: undo after sending brings the prompt back. Where that command is unavailable (a test
  // DOM), the edit still happens, just without history.
  let composerEditing = false;
  function editComposer(start, end, text) {
    start = Math.max(0, Math.min(start, input.value.length));
    end = Math.max(start, Math.min(end, input.value.length));
    if (start === end && !text) return;
    const expected = input.value.slice(0, start) + text + input.value.slice(end);
    if (typeof document.execCommand === "function") {
      composerEditing = true;
      try {
        input.focus({ preventScroll: true });
        input.setSelectionRange(start, end);
        const done = text ? document.execCommand("insertText", false, text)
          : document.execCommand("delete", false);
        if (done && input.value === expected) return;
      } catch { /* fall through to a plain assignment */ }
      finally { composerEditing = false; }
    }
    // No editing command, or it did not produce exactly this edit: set the result directly.
    input.value = expected;
    input.selectionStart = input.selectionEnd = start + text.length;
  }
  function setComposerText(text) { editComposer(0, input.value.length, String(text ?? "")); }
  function clearComposer() { setComposerText(""); autosizeComposer(); }

  // "Show in text field" moved a pasted chip's text into the box. When undo or redo lands back on
  // either side of that edit, put the chip back or take it away again to match.
  const shownPastes = [];
  function syncShownPaste(event) {
    if (!shownPastes.length || (event.inputType !== "historyUndo" && event.inputType !== "historyRedo")) return;
    for (const entry of [...shownPastes].reverse()) {
      const attached = attachments.includes(entry.item);
      if (event.inputType === "historyUndo" && !attached && input.value === entry.before) {
        attachments.splice(Math.min(entry.index, attachments.length), 0, entry.item);
        renderAtts(); return;
      }
      if (event.inputType === "historyRedo" && attached && input.value === entry.after) {
        attachments.splice(attachments.indexOf(entry.item), 1);
        renderAtts(); return;
      }
    }
  }
  input.addEventListener("input", syncShownPaste);
  function onInput() {
    if (composerEditing) return;   // our own edit: its caller already does the follow-up work
    scheduleDraftSave();
    renderComposerControls();
    autosizeComposer();
    const v = input.value, caret = input.selectionStart;
    const upto = v.slice(0, caret);
    const token = /(^|\s)([/$@][^\s]*)$/.exec(upto);
    if (!token || input.selectionStart !== input.selectionEnd || input.matches(":disabled")) return hidePop();
    popStart = caret - token[2].length;
    popEnd = caret + (v.slice(caret).match(/^[^\s]*/)?.[0].length || 0);
    popMode = token[2][0];
    const query = token[2].slice(1).toLowerCase();
    if (popMode === "/" || popMode === "$") {
      const skillItems = skillRows.filter((s) => s && s.enabled !== false).map((s) => ({
        label: "$" + s.name, detail: s.description || "Reusable agent instructions",
        skill: s.name, kind: s.source ? `${s.source} skill` : "skill", aliases: [],
      }));
      const all = popMode === "$" ? skillItems : builtinCommands.map((c) => ({ label: "/" + c.name, detail: c.description,
        action: c.action, acceptsArgs: c.accepts_args === true,
        kind: "command",
        aliases: Array.isArray(c.aliases) ? c.aliases : [] }))
        .concat(customCommands.map((c) => ({ label: "/" + c, detail: "Apply this prompt template to your request", template: c, kind: "prompt" })), skillItems);
      const matches = all.filter((c) => c.label.slice(1).toLowerCase().includes(query)
        || (c.detail || "").toLowerCase().includes(query)
        || (c.aliases || []).some((alias) => alias.toLowerCase().includes(query)));
      if (query) matches.sort((a, b) => Number(!a.label.slice(1).toLowerCase().startsWith(query))
        - Number(!b.label.slice(1).toLowerCase().startsWith(query)));
      showPop(matches);
    }
    else if (popMode === "@") {
      showPop(files.filter((f) => f.label.toLowerCase().includes(query)).slice(0, 30));
      if (files.length === 0) vscode.postMessage({ type: "reqFiles" });
    } else hidePop();
  }
  input.addEventListener("input", onInput);
  input.addEventListener("click", onInput);
  input.addEventListener("keydown", (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Escape" && mcpContextPending) {
      e.preventDefault(); doStop(); mcpContextPending = ""; return;
    }
    if (popMode) {
      if (e.key === "ArrowDown") { e.preventDefault(); movePop(1); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); movePop(-1); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); choosePop(popIdx); return; }
      if (e.key === "Escape") { e.preventDefault(); hidePop(); return; }
    }
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(e.altKey ? "queue" : undefined); }
    else if (e.key === "Escape" && streaming) doStop();
  });
  // Files dragged from the explorer (or a tab) attach as @-mentions, like the popup does.
  for (const zone of [input, log]) {
    zone.addEventListener("dragover", (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("text/uri-list")) {
        e.preventDefault(); e.dataTransfer.dropEffect = "copy";
      }
    });
    zone.addEventListener("drop", (e) => {
      const list = e.dataTransfer ? e.dataTransfer.getData("text/uri-list") : "";
      const uris = list.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#")).slice(0, 16);
      if (!uris.length) return;
      e.preventDefault();
      vscode.postMessage({ type: "drop_uris", uris });
    });
  }
  input.addEventListener("paste", (e) => {                 // paste an image → attach for vision models
    const items = (e.clipboardData && e.clipboardData.items) || [];
    let sawImage = false;
    for (const it of items) {
      if (it.type && it.type.indexOf("image/") === 0) {
        const file = it.getAsFile(); if (!file) continue;
        if (!canAttach()) continue;
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
        const owner = { session: draftSession }; pendingImages.add(owner);
        const r = new FileReader();
        let settled = false;
        const release = () => {
          if (settled) return; settled = true;
          pendingImages.delete(owner);
          pendingImageFiles -= 1; pendingImageBytes -= file.size;
        };
        r.onload = () => {
          release();
          if (typeof r.result !== "string" || !r.result.startsWith("data:image/")) {
            sysLine("The pasted image could not be encoded safely.", true); return;
          }
          const image = { label: "📷 image", img: true, data: r.result, bytes: file.size };
          if (owner.session === draftSession) {
            attachments.push(image); renderAtts();
          } else {
            const draft = draftEntries.get(owner.session)
              || { text: "", attachments: [], start: 0, end: 0, updated: Date.now() };
            draft.attachments.push(image); draft.updated = Date.now();
            draftEntries.set(owner.session, draft); persistDraft();
            sysLine("The pasted image was added to its original chat's draft.");
          }
        };
        r.onerror = () => { release(); sysLine("The pasted image could not be read.", true); };
        r.onabort = release;
        try { r.readAsDataURL(file); }
        catch { release(); sysLine("The pasted image could not be read.", true); }
        e.preventDefault();
        sawImage = true;        // keep looping: a multi-image paste must see every item
      }
    }
    if (sawImage) return;
    // A wall of pasted text buries the composer and hides the controls under it. Past this many
    // characters it becomes an attachment instead, recoverable with one click. The threshold
    // matches Codex's.
    const pasted = e.clipboardData ? String(e.clipboardData.getData("text/plain") || "") : "";
    if (pasted.length >= PASTED_TEXT_LIMIT && canAttach()) {
      e.preventDefault();
      attachments.push({ label: "Pasted text", pasted, chars: pasted.length });
      renderAtts();
      sysLine(`Attached ${pasted.length.toLocaleString()} characters of pasted text.`);
    }
  });
  send.onclick = () => { if (streaming && !hasComposerInput()) doStop(); else submit(); };
  $("stop-run").onclick = doStop;
  $("queue-send").onclick = () => submit("queue");
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
  // "+" is a menu, not a keystroke. It used to insert a literal "@", which meant the one control
  // most likely to be clicked first did the least discoverable thing in the panel. The shape is
  // Codex's -- a leading Add section -- but every item is a capability DGC already has, including
  // two that were previously reachable only from a settings page.
  function insertTrigger(ch) {
    input.focus();
    const at = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, at);
    const prefix = before && !/\s$/.test(before) ? " " : "";
    editComposer(at, at, prefix + ch);
    input.selectionStart = input.selectionEnd = at + prefix.length + 1;
    onInput();
  }
  function hideAddMenu() {
    $("addmenu").hidden = true; $("btn-add").setAttribute("aria-expanded", "false");
  }
  function addMenuItems() {
    const items = [
      { id: "files", icon: "file-directory", label: "Files and folders",
        hint: "@", run: () => insertTrigger("@") },
      { id: "skill", icon: "lightbulb", label: "Skills",
        hint: "$", run: () => insertTrigger("$") },
      { id: "command", icon: "terminal", label: "Commands",
        hint: "/", run: () => insertTrigger("/") },
    ];
    if (mcpContextSupported) {
      items.push({ id: "mcp", icon: "plug", label: "MCP context",
                   hint: "resources, prompts",
                   run: () => vscode.postMessage({ type: "slash", action: "mcp" }) });
    }
    items.push({ id: "goal", icon: "target", label: "Goal",
                 hint: "keep pursuing", run: () => vscode.postMessage({ type: "slash", action: "goal" }) });
    items.push({ id: "plan", icon: "checklist", label: "Plan mode",
                 hint: curMode === "plan" ? "turn off" : "turn on",
                 run: () => setMode(curMode === "plan" ? "default" : "plan") });
    items.push({ id: "memory", icon: "bookmark", label: "Memory",
                 hint: "what DGC remembers",
                 run: () => vscode.postMessage({ type: "slash", action: "memory" }) });
    return items;
  }
  function toggleAddMenu() {
    const am = $("addmenu");
    if (!am.hidden) { hideAddMenu(); return; }
    hideModeMenu(); hideModelMenu(); hideContextMenu();
    const items = addMenuItems();
    am.innerHTML = '<div role="group" aria-label="Add">'
      + '<div class="mhead" role="presentation"><span>Add</span></div>'
      + items.map((it) => `<button type="button" role="menuitem" class="mrow" data-add="${it.id}">`
          + `<span class="codicon codicon-${it.icon}" aria-hidden="true"></span>`
          + `<span class="mrow-label">${esc(it.label)}</span>`
          + `<span class="mrow-hint">${esc(it.hint)}</span></button>`).join("")
      + "</div>";
    am.querySelectorAll("[data-add]").forEach((row) => row.onclick = () => {
      hideAddMenu();
      items.find((it) => it.id === row.dataset.add)?.run();
    });
    am.hidden = false; $("btn-add").setAttribute("aria-expanded", "true");
    am.querySelector("button")?.focus();
  }
  $("btn-add").onclick = toggleAddMenu;
  function openCommandMenu() {
    const caret = input.selectionEnd;
    const prefix = caret && !/\s/.test(input.value[caret - 1]) ? " /" : "/";
    editComposer(caret, caret, prefix);
    input.selectionStart = input.selectionEnd = caret + prefix.length; input.focus(); onInput();
  }
  $("btn-cmd").onclick = openCommandMenu;
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
    "artifact_in_plan", "tool_profile", "max_parallel_tasks", "monitor_wake",
    "subscription_engine", "subscription_model", "subscription_effort"];
  const SET_BOOLEAN_FIELDS = new Set(["prompt_cache", "sandbox", "sandbox_network",
    "show_reasoning", "ultra_mode", "suggest", "plan_artifact", "artifact_autostart", "artifact_in_plan",
    "monitor_wake"]);
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
      monitor_wake: String(cfg.monitor_wake !== false),
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
    syncContextPreset(cfg.context_size);
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
    const wanted = ["general", "models", "agents", "usage", "security", "extensions"].includes(section)
      ? section : "general";
    document.querySelectorAll(".set-section").forEach((node) => { node.hidden = node.dataset.section !== wanted; });
    document.querySelectorAll(".set-tab").forEach((button) => {
      const active = button.dataset.section === wanted;
      button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active));
    });
    const first = $(`settings`).querySelector(`.set-section[data-section="${wanted}"] input, .set-section[data-section="${wanted}"] select, .set-section[data-section="${wanted}"] button`);
    if (first) first.focus();
    // A tab strip wider than the panel scrolls: keep the chosen tab in view and fade the edge
    // that hides more tabs, so the ones past it are discoverable.
    const activeTab = document.querySelector(`.set-tab[data-section="${wanted}"]`);
    if (activeTab && typeof activeTab.scrollIntoView === "function") activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
    usageEdges(document.querySelector(".settings-nav"));
    if (wanted === "usage") requestUsage();     // opening the tab always counts again
  }

  // ---- Token Usage tab ----
  // The CLI keeps a local ledger of every request DGC finished. The tab asks for one range
  // (getUsage -> get_usage) and draws the usage_report it gets back. Every number is what a
  // provider reported; nothing here is estimated, and only the newest request is ever drawn.
  const USAGE_RANGES = ["today", "7d", "30d", "month", "all"];
  const USAGE_TIMEOUT_MS = 15000;
  let usageRequestId = "", usageSequence = 0, usageTimer = 0, usageHasData = false;
  let usageBuckets = [], usageDay = -1;
  const usageSection = () => $("settings").querySelector('.set-section[data-section="usage"]');
  const usageCount = (value) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
  };
  const usageExact = (value) => usageCount(value).toLocaleString();
  function usageCompact(value) {
    const n = usageCount(value);
    const scaled = (unit, suffix) => {
      const v = n / unit;
      return (v >= 100 ? Math.round(v).toString() : v.toFixed(1).replace(/\.0$/, "")) + suffix;
    };
    if (n >= 1e9) return scaled(1e9, "B");
    if (n >= 1e6) return scaled(1e6, "M");
    if (n >= 1e4) return scaled(1e3, "K");
    return n.toLocaleString();
  }
  function usageNode(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function usageDate(iso, withYear) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ""));
    if (!match) return String(iso || "");
    const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return date.toLocaleDateString(undefined, withYear
      ? { year: "numeric", month: "short", day: "numeric" } : { month: "short", day: "numeric" });
  }
  function setUsageStatus(text, busy) {
    $("usage-status").textContent = text;
    const section = usageSection();
    if (busy) section.setAttribute("aria-busy", "true"); else section.removeAttribute("aria-busy");
  }
  function requestUsage() {
    const select = $("usage-range");
    const range = USAGE_RANGES.includes(select.value) ? select.value : "7d";
    usageRequestId = `usage-${Date.now().toString(36)}-${++usageSequence}`;
    const requestId = usageRequestId;
    setUsageStatus(usageHasData ? "Refreshing\u2026" : "Counting\u2026", true);
    clearTimeout(usageTimer);
    usageTimer = setTimeout(() => {
      if (requestId !== usageRequestId) return;
      setUsageStatus("No answer from the DGC backend yet. Try Refresh.", false);
    }, USAGE_TIMEOUT_MS);
    vscode.postMessage({ type: "getUsage", range, requestId });
  }
  function usageUnavailable(msg) {
    if (msg.requestId && msg.requestId !== usageRequestId) return;
    clearTimeout(usageTimer);
    usageHasData = false;
    $("usage-content").hidden = true;
    $("usage-empty").hidden = true;
    setUsageStatus(String(msg.message || "Token usage is unavailable."), false);
  }
  // A long id keeps the part that tells variants apart: the ":tag"/quantisation or "-suffix" of
  // a model, the ":port" of a host. The head truncates with an ellipsis; the tail always shows.
  function usageSplit(text, kind) {
    const value = String(text || "");
    let cut = -1;
    if (kind === "host") {
      const port = /:\d{1,5}$/.exec(value);
      if (port) cut = port.index;
    } else if (kind === "model" && value.length > 14) {
      const colon = value.lastIndexOf(":");
      const dash = value.lastIndexOf("-");
      if (colon > 0 && value.length - colon <= 14) cut = colon;
      else if (dash > 0 && value.length - dash <= 10) cut = dash;
      else cut = value.length - 8;
    }
    const line = usageNode("span", kind === "model" ? "usage-clip usage-name" : "usage-clip usage-where");
    if (cut <= 0) {
      line.appendChild(usageNode("span", "usage-head", value));
    } else {
      line.appendChild(usageNode("span", "usage-head", value.slice(0, cut)));
      line.appendChild(usageNode("span", "usage-tail", value.slice(cut)));
    }
    return line;
  }
  // A box that scrolls sideways says so: its hidden edge fades while there is more to see.
  function usageEdges(node) {
    if (!node) return;
    const more = node.scrollWidth - node.clientWidth;
    node.classList.toggle("more-right", more > 1 && node.scrollLeft < more - 1);
    node.classList.toggle("more-left", more > 1 && node.scrollLeft > 1);
  }
  function renderUsage(ev) {
    if (!ev || ev.request_id !== usageRequestId) return;   // a late answer to an older request
    clearTimeout(usageTimer);
    const totals = ev.totals && typeof ev.totals === "object" ? ev.totals : {};
    const models = (Array.isArray(ev.by_model) ? ev.by_model : [])
      .filter((row) => row && typeof row === "object").slice(0, 100);
    const days = (Array.isArray(ev.by_day) ? ev.by_day : [])
      .filter((row) => row && typeof row === "object" && /^\d{4}-\d{2}-\d{2}$/.test(String(row.date)))
      .slice(-401);
    const zone = String(ev.timezone || "").slice(0, 64);
    $("usage-timezone").textContent = `Days follow this computer’s local time${zone ? ` (${zone})` : ""}.`;
    const stamp = new Date(String(ev.generated_at || ""));
    const updated = Number.isNaN(stamp.getTime()) ? "Updated just now"
      : `Updated ${stamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (ev.error) {
      usageHasData = false;
      $("usage-content").hidden = true;
      $("usage-empty").hidden = true;
      setUsageStatus(`The usage ledger could not be read: ${String(ev.error).slice(0, 300)}`, false);
      return;
    }
    const requests = usageCount(totals.requests);
    usageHasData = requests > 0;
    $("usage-empty").hidden = usageHasData;
    $("usage-empty-all").hidden = usageHasData || $("usage-range").value === "all";
    $("usage-content").hidden = !usageHasData;
    setUsageStatus(updated, false);
    if (!usageHasData) {
      usageBuckets = [];
      $("usage-strip-in").replaceChildren(); $("usage-strip-out").replaceChildren();
      return;
    }

    const figures = $("usage-figures");
    figures.replaceChildren();
    for (const [label, key, unit] of [["Input", "input_tokens", "tokens"],
      ["Output", "output_tokens", "tokens"], ["Cached input", "cached_input_tokens", "tokens"],
      ["Requests", "requests", "requests"]]) {
      const figure = usageNode("div", "usage-figure");
      const exact = usageExact(totals[key]);
      const compact = usageCompact(totals[key]);
      figure.setAttribute("role", "group");
      figure.setAttribute("aria-label", `${label}: ${exact} ${unit}`);
      figure.appendChild(usageNode("span", "usage-figure-label", label));
      figure.appendChild(usageNode("span", "usage-figure-value", compact));
      // The exact count earns its line only when the big figure is abbreviated.
      if (compact !== exact) figure.appendChild(usageNode("span", "usage-figure-exact", `${exact} ${unit}`));
      figures.appendChild(figure);
    }
    const unmetered = usageCount(totals.unmetered_requests);
    const unmeteredNote = $("usage-unmetered");
    unmeteredNote.hidden = unmetered === 0;
    unmeteredNote.textContent = unmetered === 0 ? ""
      : unmetered === 1
        ? "1 unmetered request ended without a usage report (cancelled, interrupted, or the "
          + "provider sent none), so its tokens are not in these totals."
        : `${unmetered.toLocaleString()} unmetered requests ended without a usage report `
          + "(cancelled, interrupted, or the provider sent none), so their tokens are not in these totals.";

    const body = $("usage-models");
    body.replaceChildren();
    const tokensOf = (row) => usageCount(row.input_tokens) + usageCount(row.output_tokens);
    const tokenSum = models.reduce((sum, row) => sum + tokensOf(row), 0);
    const requestSum = models.reduce((sum, row) => sum + usageCount(row.requests), 0);
    for (const row of models) {
      const tr = document.createElement("tr");
      const model = String(row.model || "unknown").slice(0, 256);
      const provider = String(row.provider || "").slice(0, 64);
      const host = String(row.host || "").slice(0, 255);
      const where = [provider, host].filter(Boolean).join(" · ");
      const modelCell = usageNode("th", "usage-model");
      modelCell.setAttribute("scope", "row");
      modelCell.title = where ? `${model}\n${where}` : model;
      modelCell.appendChild(usageSplit(model, "model"));
      modelCell.appendChild(usageSplit(where || "—", host ? "host" : "where"));
      tr.appendChild(modelCell);
      for (const key of ["input_tokens", "output_tokens", "cached_input_tokens", "requests"]) {
        tr.appendChild(usageNode("td", "num", usageExact(row[key])));
      }
      const share = tokenSum > 0 ? tokensOf(row) / tokenSum
        : (requestSum > 0 ? usageCount(row.requests) / requestSum : 0);
      const percent = share * 100;
      const shareText = percent > 0 && percent < 1 ? "<1%" : `${Math.round(percent)}%`;
      const shareCell = usageNode("td", "usage-share-cell");
      const wrap = usageNode("span", "usage-share");
      wrap.setAttribute("role", "img");
      wrap.setAttribute("aria-label", `${shareText} of ${tokenSum > 0 ? "tokens" : "requests"}`);
      const track = usageNode("span", "usage-share-track");
      const fill = usageNode("span", "usage-share-fill" + (percent > 0 ? " nonzero" : ""));
      fill.style.width = `${Math.min(100, percent)}%`;
      track.appendChild(fill);
      wrap.appendChild(track);
      wrap.appendChild(usageNode("span", "usage-share-text", shareText));
      shareCell.appendChild(wrap);
      tr.appendChild(shareCell);
      body.appendChild(tr);
    }
    usageEdges(document.querySelector(".usage-table-wrap"));

    // One column per local day (weeks past 62 days), drawn as two strips on their own scales:
    // a coding agent reads far more than it writes, so output on the input scale would be a
    // sliver whatever its size. Each strip names its own peak.
    const weekly = days.length > 62;
    usageBuckets = [];
    for (let i = 0; i < days.length; i += weekly ? 7 : 1) {
      const slice = days.slice(i, i + (weekly ? 7 : 1));
      usageBuckets.push({
        first: slice[0].date, last: slice[slice.length - 1].date,
        input: slice.reduce((sum, day) => sum + usageCount(day.input_tokens), 0),
        output: slice.reduce((sum, day) => sum + usageCount(day.output_tokens), 0),
        requests: slice.reduce((sum, day) => sum + usageCount(day.requests), 0),
      });
    }
    const crossesYear = days.length > 0 && days[0].date.slice(0, 4) !== days[days.length - 1].date.slice(0, 4);
    const label = (bucket) => weekly
      ? `Week of ${usageDate(bucket.first, crossesYear)}` : usageDate(bucket.first, crossesYear);
    usageBuckets.forEach((bucket) => { bucket.label = label(bucket); });
    // A single day has nothing to compare: the figures above already are that day.
    const single = usageBuckets.length <= 1;
    $("usage-days").hidden = single;
    const strips = [["usage-strip-in", "input", "usage-in", "usage-peak-in"],
      ["usage-strip-out", "output", "usage-out", "usage-peak-out"]];
    for (const [id, key, cls, peakId] of strips) {
      const strip = $(id);
      strip.replaceChildren();
      strip.classList.toggle("dense", usageBuckets.length > 40);
      const peak = Math.max(0, ...usageBuckets.map((bucket) => bucket[key]));
      $(peakId).textContent = peak > 0 ? `peak ${usageCompact(peak)}` : "none";
      usageBuckets.forEach((bucket, index) => {
        const column = usageNode("div", "usage-day");
        column.dataset.index = String(index);
        if (bucket[key] > 0) {
          const bar = usageNode("span", `usage-bar ${cls}`);
          bar.style.height = `${(bucket[key] / peak) * 100}%`;
          column.appendChild(bar);
        } else if (key === "input" && bucket.requests) {
          column.appendChild(usageNode("span", "usage-bar usage-unmetered-day"));
        }
        column.addEventListener("mouseenter", () => selectUsageDay(index));
        strip.appendChild(column);
      });
    }
    $("usage-days-first").textContent = usageBuckets.length ? label(usageBuckets[0]) : "";
    $("usage-days-last").textContent = usageBuckets.length > 1 ? label(usageBuckets[usageBuckets.length - 1]) : "";
    $("usage-days").setAttribute("aria-label", `Input and output tokens per ${weekly ? "week" : "day"}, `
      + `${usageBuckets.length} ${weekly ? "weeks" : "days"}. Use the arrow keys to read each one.`);
    let busiest = usageBuckets.length - 1;
    usageBuckets.forEach((bucket, index) => {
      if (bucket.input + bucket.output > usageBuckets[busiest].input + usageBuckets[busiest].output) busiest = index;
    });
    selectUsageDay(busiest, true);
  }
  function selectUsageDay(index, initial) {
    if (!usageBuckets.length) return;
    usageDay = Math.max(0, Math.min(usageBuckets.length - 1, index));
    const bucket = usageBuckets[usageDay];
    $("usage-days").querySelectorAll(".usage-day").forEach((column) => {
      column.classList.toggle("sel", Number(column.dataset.index) === usageDay);
    });
    const text = `${bucket.label}: ${bucket.input.toLocaleString()} input · `
      + `${bucket.output.toLocaleString()} output tokens · ${bucket.requests.toLocaleString()} `
      + `request${bucket.requests === 1 ? "" : "s"}`;
    $("usage-day-readout").textContent = (initial && usageBuckets.length > 1 ? "Busiest — " : "") + text;
  }
  $("usage-days").addEventListener("keydown", (e) => {
    if (!usageBuckets.length) return;
    const moves = { ArrowLeft: usageDay - 1, ArrowRight: usageDay + 1, Home: 0, End: usageBuckets.length - 1 };
    if (!(e.key in moves)) return;
    e.preventDefault();
    selectUsageDay(moves[e.key]);
  });
  $("usage-range").onchange = requestUsage;
  $("usage-refresh").onclick = requestUsage;
  $("usage-show-all").onclick = () => { $("usage-range").value = "all"; requestUsage(); };
  document.querySelector(".usage-table-wrap").addEventListener("scroll", (e) => usageEdges(e.currentTarget), { passive: true });
  const settingsNav = document.querySelector(".settings-nav");
  if (settingsNav) settingsNav.addEventListener("scroll", () => usageEdges(settingsNav), { passive: true });
  window.addEventListener("resize", () => {
    usageEdges(settingsNav);
    usageEdges(document.querySelector(".usage-table-wrap"));
  });
  function openSettings(providers, models, section, range) {
    settingsProviders = providers || [];
    $("s-provider").innerHTML = `<option value="">— pick a preset —</option>` +
      settingsProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
    const subPreset = $("s-subagent_provider");
    if (subPreset) {
      subPreset.innerHTML = '<option value="">choose a preset\u2026</option>'
        + settingsProviders.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");
    }
    $("s-models").innerHTML = (models || []).map((m) => `<option value="${esc(m)}"></option>`).join("");
    if (lastConfig) fillSettings(lastConfig);
    // `/usage 30d` opens the tab on the range it named; anything else keeps the last choice.
    if (USAGE_RANGES.includes(range)) $("usage-range").value = range;
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
  // Context size: a menu of the sizes people actually use, with Custom for anything else. The
  // number input stays the single source of truth, so collectSettings() is unchanged.
  function syncContextPreset(value) {
    const preset = $("s-context_preset") || $("s-context_size_preset");
    const custom = $("s-context_size");
    if (!preset || !custom) return;
    const known = [...preset.options].some((o) => o.value === String(value || ""));
    if (value && known) {
      preset.value = String(value);
      custom.hidden = true;
    } else {
      preset.value = "custom";
      custom.hidden = false;
    }
  }

  function collectSettings() {
    const v = {};
    SET_FIELDS.forEach((k) => { const el = $("s-" + k); if (el) v[k] = el.value.trim(); });
    SET_BOOLEAN_FIELDS.forEach((key) => { v[key] = v[key] !== "false"; });
    return v;
  }
  {
    const preset = $("s-context_size_preset");
    if (preset) {
      preset.onchange = () => {
        const custom = $("s-context_size");
        if (preset.value === "custom") { custom.hidden = false; custom.focus(); return; }
        custom.value = preset.value;
        custom.hidden = true;
      };
    }
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
  // The Agents tab needs the same shortcut the Models tab has: pick a provider, get its host.
  // It fills only the sub-agent fields, and never touches the main connection.
  $("s-subagent_provider").onchange = () => {
    const preset = settingsProviders.find((x) => x.id === $("s-subagent_provider").value);
    if (!preset) return;
    $("s-subagent_base_url").value = preset.url;
    $("s-subagent_api_mode").value = "auto";
    if (!preset.needsKey && !$("s-subagent_api_key").value) $("s-subagent_api_key").value = "ollama";
  };
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
    // Settings has to close for the surface to take the panel, so remember where we came from
    // and put it back on the way out. Without this the Extensions tab was a one-way door.
    surfaceReturnSection = button.closest(".set-section")?.dataset.section || "extensions";
    closeSettings(); vscode.postMessage({ type: "slash", action: button.dataset.openSurface });
  });

  // ---- replay ----
  // Everything a saved turn is made of. Anything else in a history payload is not dispatched:
  // `onEvent` carries cases with real side effects (posting to the extension host, registering
  // approval cards, flipping the composer), and a reload must not fire any of them.
  const REPLAYABLE = new Set(["turn_start", "text_delta", "thinking_delta", "stream_end",
                              "tool_call", "tool_result", "tool_denied", "monitor_event", "turn_end"]);
  // One whole turn, or one standalone marker. Paging cuts between units, never inside one.
  function historyUnits(items) {
    const units = [];
    let open = null;
    for (const it of items) {
      if (!it || typeof it !== "object") continue;
      const type = typeof it.type === "string" ? it.type : "";
      if (type === "turn_start") { open = [it]; units.push(open); continue; }
      if (!type) {                           // a marker: part of the turn it fell inside, if any
        if (open) open.push(it); else units.push([it]);
        continue;
      }
      if (!REPLAYABLE.has(type)) continue;
      if (open) { open.push(it); if (type === "turn_end") open = null; }
      else units.push([it]);                 // a fragment with no turn above it still renders
    }
    return units;
  }
  // Drive the live reducer with saved events, into a detached fragment. The live turn is set
  // aside first: a history page can arrive while a turn is streaming, and the replay must not
  // adopt, finish or otherwise touch it.
  function replayInto(list, frag) {
    const live = turn, wasFollowing = following;
    turn = null; replaying = true; appendTarget = frag;
    try {
      for (const it of list) {
        if (it && typeof it.type === "string") { if (REPLAYABLE.has(it.type)) onEvent(it); }
        else legacyItem(it);
      }
      if (turn) endTurn("completed");        // a page that ends mid-turn still settles its block
    } finally {
      replaying = false; appendTarget = log; turn = live; following = wasFollowing;
    }
  }
  // Items the backend still sends in their own shape because they are not turn events, plus the
  // flat projection an older backend sends — translated into events rather than given a second
  // renderer of their own.
  function legacyItem(it) {
    if (!it || typeof it !== "object") return;
    if (it.role === "compaction") {
      // Earlier turns were summarised so the run could keep going. Say so plainly; the summary
      // is the model's own context, available on request rather than pasted into the chat.
      const note = el("details", "compaction hist");
      note.innerHTML = '<summary><span class="codicon codicon-fold" aria-hidden="true"></span>'
        + "<span>Earlier conversation summarised to keep it in context</span></summary>";
      const body = el("pre", "compaction-body");
      body.textContent = String(it.text || "").slice(0, 20000);
      note.appendChild(body);
      appendTarget.appendChild(note);
      return;
    }
    if (it.role === "notice") { appendTarget.appendChild(el("div", "sys hist", esc(it.text))); return; }
    if (it.role === "resume") { onEvent({ type: "turn_start", prompt: String(it.text || ""), kind: "resume" }); return; }
    if (it.role === "user") { onEvent({ type: "turn_start", prompt: String(it.text || ""), kind: "prompt" }); return; }
    if (it.role === "assistant" && it.text) {
      onEvent({ type: "text_delta", text: String(it.text) });
      onEvent({ type: "stream_end", phase: it.tools?.length ? "commentary" : "answer" });
    }
  }

  function renderHistory(items) {
    // Non-destructive: replace only the history block, and place it ABOVE any live
    // content. A resumed session's `history` event can arrive AFTER the user has
    // already sent a prompt (slow session load) — clearing the whole log here used
    // to wipe that just-sent prompt while the turn kept streaming.
    log.querySelectorAll(".hist").forEach((e) => e.remove());
    const history = el("div", "hist history-pages");
    const older = el("button", "act history-older", "Show earlier messages");
    older.title = "Load the previous page of this chat\u2019s history";
    history.appendChild(older);
    // Saved history IS the live event vocabulary, so a page of it renders by driving the same
    // reducer that renders a live turn: same classes, same answer promotion, same tool cards,
    // same diffs. What used to be here was a second projection with its own idea of what an
    // answer was, which is why a reloaded session read as one long wall of text.
    const units = historyUnits(items);
    let cursor = units.length;
    function page() {
      const frag = document.createDocumentFragment();
      // Take whole turns until the page is about fifty events deep, and never fewer than one.
      let start = cursor, count = 0;
      while (start > 0 && count < 50) { start--; count += units[start].length; }
      replayInto(units.slice(start, cursor).flat(), frag);
      const oldHeight = log.scrollHeight, oldTop = log.scrollTop;
      const landed = [...frag.children];
      older.after(frag); cursor = start;
      landed.forEach(settleBlock);
      log.scrollTop = oldTop + log.scrollHeight - oldHeight;
      // Past the live messages there is still the archive of everything compaction folded away.
      // DGC keeps it on disk beside the session, so "Show earlier messages" keeps working rather
      // than stopping at the summary with the rest of the conversation sitting unread.
      if (cursor === 0) {
        if (recallCursor === null || recallCursor > 0) askForRecall();
        else older.hidden = true;
      }
    }

    let recallCursor = null;         // null = not asked yet; 0 = the archive is exhausted
    let recallPending = false;
    function askForRecall() {
      if (recallPending) return;
      recallPending = true;
      older.textContent = "Loading earlier messages\u2026";
      older.disabled = true;
      vscode.postMessage({ type: "getRecall",
                           before: recallCursor === null ? undefined : recallCursor });
    }
    renderHistory._absorbRecall = (ev) => {
      recallPending = false;
      older.disabled = false;
      older.textContent = "Show earlier messages";
      recallCursor = Number(ev.before) || 0;
      const rows = Array.isArray(ev.items) ? ev.items : [];
      const frag = document.createDocumentFragment();
      for (const it of rows) {
        if (it.role === "user") {
          const m = el("div", "msg user hist archived");
          m.appendChild(el("div", "role", "you"));
          m.appendChild(el("div", "bubble", esc(it.text)));
          frag.appendChild(m);
        } else {
          const m = el("div", "msg dgc hist archived");
          m.appendChild(el("div", "role dgc", "DGC"));
          const text = el("div", "text", md(String(it.text || "")));
          text._markdown = it.text;
          m.appendChild(text);
          frag.appendChild(m);
        }
      }
      if (rows.length) {
        const oldHeight = log.scrollHeight, oldTop = log.scrollTop;
        const landed = [...frag.children];
        older.after(frag);
        landed.forEach(settleBlock);
        log.scrollTop = oldTop + log.scrollHeight - oldHeight;
      }
      older.hidden = !ev.more;
    };
    older.type = "button";
    older.onclick = () => { if (cursor > 0) page(); else askForRecall(); };
    log.insertBefore(history, log.firstChild);   // history above any live user prompt / streaming turn
    page();
    scroll();
  }
  // User clicks are the only route out of model-generated content. Never navigate a webview.
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.(".md-link");
    if (link) {
      event.preventDefault();
      const target = DgcMarkdown.linkTarget(link.dataset.target + (link.dataset.line ? `:${link.dataset.line}` : ""));
      if (target?.kind === "external") vscode.postMessage({ type: "openExternal", url: target.target });
      else if (target?.kind === "file") vscode.postMessage({ type: "openFile", path: target.target, line: target.line });
      return;
    }
    const copy = event.target.closest?.(".copy");
    if (copy) {
      vscode.postMessage({ type: "copy", text: decodeURIComponent(copy.dataset.c) });
      const glyph = copy.querySelector(".codicon");
      copy.classList.add("done");
      if (glyph) { glyph.classList.remove("codicon-copy"); glyph.classList.add("codicon-check"); }
      setTimeout(() => {
        if (!copy.isConnected) return;
        copy.classList.remove("done");
        if (glyph) { glyph.classList.remove("codicon-check"); glyph.classList.add("codicon-copy"); }
      }, 1600);
    }
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "session_ready") {
      selectDraftSession(msg.sessionId, msg.adoptDraftFrom || ""); sessionReady = true;
      backendLive = true; backendDown = false; armTodoClearTimer();
      renderUnconfirmedDrafts();
    }
    else if (msg.type === "state") {
      curModel = msg.state.model || ""; curThink = msg.state.think || "off";
      curSubscription = msg.state.subscriptionEngine || "";
      curUltra = msg.state.ultra === true;
      updateModelControl();
      if (pmodel) { pmodel.textContent = curModel || "dgc"; pmodel.title = "Model: " + (curModel || "dgc") + " — click to change"; pmodel.setAttribute("aria-label", "Change model. Current model: " + (curModel || "dgc")); }
      applyMode(msg.state.mode || "default");
      setGoalState(msg.state.goal || { text: "", status: "none", elapsed_seconds: 0 });
    }
    else if (msg.type === "models" && !$("modelmenu").hidden) { renderModelMenu(msg.ids || [], msg.current, msg.err, msg.subscription, msg.label, msg.supportsEffort); }
    else if (msg.type === "chat_changes") {
      if (!msg.sessionId || msg.sessionId === draftSession) setChatChanges(msg);
    }
    else if (msg.type === "workspace_changes") { setWorkspaceChanges(msg); }
    else if (msg.type === "settings_open") { openSettings(msg.providers, msg.models, msg.section, msg.range); }
    else if (msg.type === "usage_unavailable") { usageUnavailable(msg); }
    else if (msg.type === "mcp_command_started") {
      mcpContextPending = msg.requestId; mcpView = "context"; openSurface("mcp");
      surfaceBody.innerHTML = '<div class="surface-empty">Working with MCP…</div>';
      surfaceButtons("Cancel", () => { vscode.postMessage({ type: "cancel" }); mcpContextPending = ""; renderMcp(); });
    }
    else if (msg.type === "surface_open") {
      if (msg.surface === "mcp") mcpView = "servers";
      openSurface(msg.surface);
    }
    else if (msg.type === "command_menu") {
      openCommandMenu();
    }
    else if (msg.type === "composer_text") {
      setComposerText(String(msg.text || "")); input.selectionStart = input.selectionEnd = input.value.length;
      input.focus(); onInput();
    }
    else if (msg.type === "composer_skill") {
      if (!attachInvocation("skill", String(msg.name || ""))) return;
      if (msg.text) {
        input.value += (input.value && !/\s$/.test(input.value) ? " " : "") + String(msg.text);
        input.selectionStart = input.selectionEnd = input.value.length;
      }
      input.focus(); onInput();
    }
    else if (msg.type === "cleared") { discardTurn(); log.innerHTML = ""; setSending(false); }
    else if (msg.type === "prompt_rejected") { rejectPrompt(msg.requestId); if (!turn) setSending(false); }
    else if (msg.type === "goal_start_state") {
      if (msg.state === "error") {
        setSending(false);
        sysLine(String(msg.error || "DGC could not start the goal."), true);
      }
    }
    else if (msg.type === "goal_edit_state") {
      if (msg.state === "saved") closeGoalEditor();
      else if (msg.state === "error") {
        $("goal-editor-save").disabled = false;
        sysLine(String(msg.error || "DGC could not update the goal."), true);
      }
    }
    else if (msg.type === "goal_control_state" && msg.state === "error") {
      sysLine(String(msg.error || "DGC could not change the goal state."), true);
    }
    else if (msg.type === "compact_state") {
      compacting = msg.state === "working";
      renderContext();
      if (msg.error) sysLine(String(msg.error), true);
    }
    else if (msg.type === "artifact_stop_state") settleArtifactStop(msg);
    else if (msg.type === "attach" && msg.resource && typeof msg.resource === "object") {
      if (canAttach()) { attachments.push({ label: msg.label, resource: msg.resource }); renderAtts(); }
    }
    else if (msg.type === "files") {
      files = Array.isArray(msg.files) ? msg.files.filter((file) => file
        && typeof file.label === "string" && typeof file.path === "string"
        && typeof file.uri === "string" && typeof file.relative_path === "string"
        && typeof file.workspace === "string").slice(0, 600) : [];
      if (popMode === "@") onInput();
    }
    else if (msg.type === "continue_offer") {
      if (msg.sessionId && msg.sessionId !== draftSession) return;
      const cause = String(msg.cause || "").slice(0, 300);
      recoveryCard("continue-offer",
        `DGC's backend stopped during your last turn${cause ? ` (${cause})` : ""}. `
          + "Work up to the last completed step is saved.",
        "Continue", () => vscode.postMessage({ type: "resumeTurn" }));
    }
    else if (msg.type === "goal_resume_held") {
      const cause = String(msg.cause || "").slice(0, 300);
      const exits = Math.max(0, Number(msg.exits) || 0);
      recoveryCard("goal-resume-held",
        `DGC's backend stopped ${exits} times in 30 minutes, so the goal was not resumed automatically.`
          + (cause ? ` Last cause: ${cause}.` : "")
          + (msg.logPath ? ` Details: ${String(msg.logPath).slice(0, 600)}` : " Details: the DGC Backend output channel."),
        "Resume goal", () => vscode.postMessage({ type: "resumeGoal" }));
    }
    else if (msg.type === "open_goal_review") openGoalReview();
    else if (msg.type === "workflow_draft") prepareWorkflowDraft(msg.name);
    else if (msg.type === "backend_exit") {
      sessionReady = !draftScope;
      // A Clear sent to a recovering backend is held for the next one, so it is not unanswered
      // yet; with no recovery coming, the row says so at once instead of spinning.
      backendLive = false; backendDown = !msg.recovering; pauseTodoClearTimer(Boolean(msg.recovering));
      // The extension is restarting the backend and will pick the work back up, so the turn has
      // not failed. Ending it here relabelled an already-answered turn "Failed for 41s" and took
      // its answer chrome away. Say what is happening instead — and bound it: if nothing arrives
      // within thirty seconds, it really did fail.
      if (msg.recovering && turn) {
        const stale = turn;
        turn.activity = { state: "waiting", label: "Reconnecting", detail: "" };
        turn.phaseT0 = Date.now();
        renderTurnMeta();
        clearTimeout(turn.recoverTimer);
        turn.recoverTimer = setTimeout(() => {
          if (turn === stale) { endTurn("error"); setSending(false); }
        }, 30000);
      } else endTurn("error");
      expireOpenRequests();
      for (const id of [...pendingPrompts.keys()]) rejectPrompt(id, false);
      // Accepted as queued but never started: the backend that held them is gone, so they are
      // the user's to send again (a backend that got to say so first already returned them).
      for (const id of [...queuedPrompts.keys()]) rejectPrompt(id, true);
      queuedCount = 0; renderQueued();
      renderUnconfirmedDrafts();
      // The goal clock is driven from this side: it keeps adding elapsed time for as long as the
      // goal reads active-and-running. With the backend gone nothing will ever say otherwise, so
      // it counted time against a dead process. Freeze it where it stopped.
      if (goalState.text) setGoalState({ ...goalState, running: false });
      // `msg.code ?` hid the two cases that matter: 0 is falsy, so a clean stop and a process
      // killed by a signal (code null) printed the same bare line, and neither could be told from
      // the other when diagnosing a crash loop.
      const why = msg.signal ? " (killed by " + msg.signal + ")"
        : typeof msg.code === "number" ? " (code " + msg.code + ")"
        : " (killed)";
      // Say only what will actually happen: a goal resumes by itself, an ordinary turn is offered
      // a Continue once the backend is back, and anything else simply reconnects.
      const next = msg.resumes === "offer" ? "reconnecting; you can continue the interrupted turn when it is back"
        : msg.resumes === "held" ? "reconnecting; the goal will not resume by itself after repeated backend exits"
        : msg.resumes === "none" ? "reconnecting"
        : "reconnecting and picking the work back up";
      const cause = typeof msg.cause === "string" && msg.cause ? ": " + msg.cause.slice(0, 300) : "";
      sysLine(msg.recovering
        ? "dgc backend stopped" + why + cause + "\u2009\u2014\u2009" + next
        : "dgc backend exited" + why + cause, true);
      if (!turn) setSending(false);      // a turn still being recovered keeps its Stop button
    }
  });
  loadDraftState();
  window.addEventListener("pagehide", persistDraft);
  input.addEventListener("select", scheduleDraftSave);
  vscode.postMessage({ type: "webviewReady" });
})();
