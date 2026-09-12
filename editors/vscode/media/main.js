(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const log = $("log"), input = $("input"), send = $("send"), atts = $("attachments"), pop = $("pop");
  const goalBar = $("goalbar"), changesBar = $("changesbar"), composerRail = $("composer-rail");
  const announcer = $("announcer");
  const queuedEl = $("queued");
  const MAX_IMAGE_FILES = 4, MAX_IMAGE_TOTAL_BYTES = 2 * 1024 * 1024;
  const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"]);
  let pendingImageFiles = 0, pendingImageBytes = 0;
  let queuedCount = 0, customCommands = [], skillRows = [];
  let skillManagement = false;
  let liveSteering = false, nativeSteering = false;
  let mcpContextSupported = false, mcpManagement = false, mcpContextSequence = 0, mcpContextPending = "", mcpView = "servers";
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
  const attachments = [];
  let promptSequence = 0;
  const promptPrefix = `web-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const pendingPrompts = new Map();
  const draftScope = document.documentElement.dataset.draftScope || "";
  const draftEntries = new Map();
  const pendingImages = new Set();
  let draftSession = "unbound", sessionReady = !draftScope, draftTimer = null, restoringDraft = false;
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
    try { vscode.setState({ version: 1, scope: draftScope, active: draftSession, entries, pending }); }
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
    if (!draftEntries.has(session) && source && draftEntries.has(source)) {
      draftEntries.set(session, draftEntries.get(source)); draftEntries.delete(source);
    }
    if (source) for (const row of unconfirmedDrafts) if (row.session === source) row.session = session;
    if (source) for (const image of pendingImages) if (image.session === source) image.session = session;
    const draft = cleanDraft(draftEntries.get(session)) || { text: "", attachments: [], start: 0, end: 0 };
    restoringDraft = true;
    input.value = draft.text; attachments.splice(0, attachments.length, ...draft.attachments);
    input.selectionStart = draft.start; input.selectionEnd = draft.end;
    renderAtts(); input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px";
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
        renderAtts(); input.style.height = Math.min(input.scrollHeight, 160) + "px";
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
    const pending = pendingPrompts.get(id);
    if (!pending) return;
    pendingPrompts.delete(id);
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
  function speak(message) { announcer.textContent = String(message || ""); }

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
  function scroll() { log.scrollTop = log.scrollHeight; following = true; }
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
    const last = [...log.querySelectorAll(".msg.user > .bubble")].at(-1);
    if (last && sameProse(last.textContent, body)) return;
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    m.appendChild(el("div", "bubble", esc(body)));
    log.appendChild(m); settleBlock(m);
  }
  function startTurn(prompt = "", kind = "prompt") {
    if (turn) endTurn("cancelled");
    speak("DGC is working");
    // A resumed goal is not something the user just typed. Show it as what it is instead of
    // echoing the objective back into the chat as a fresh prompt.
    if (kind === "resume") {
      const note = el("div", "resume-note");
      note.innerHTML = '<span class="codicon codicon-debug-continue" aria-hidden="true"></span>'
        + '<span>Resumed the standing goal</span>';
      log.appendChild(note);
    } else {
      echoPrompt(prompt);
    }
    const block = el("div", "msg dgc"); block.appendChild(el("div", "role dgc", "DGC"));
    const act = el("div", "thinking", `<span class="spin">${MARK}</span> <span class="verb">working…</span> <span class="meta"></span>`);
    block.appendChild(act); log.appendChild(block);
    const t0 = Date.now();
    turn = { block, act, t0, chars: 0, textEl: null, reasonEl: null, _buf: "", eta: "",
             prompt: String(prompt || ""), edits: new Map() };
    turn.timer = setInterval(renderTurnMeta, 200);
    renderTurnMeta();
    scroll();
  }
  function renderTurnMeta() {
    const meta = turn?.act?.querySelector(".meta");
    if (!turn || !meta) return;
    const eta = turn.eta ? ` · ${turn.eta}` : "";
    meta.textContent = `(${Math.floor((Date.now() - turn.t0) / 1000)}s${eta} · ↓ ${Math.round(turn.chars / 4)} tok)`;
  }
  function endTurn(reason = "completed") {
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
    const lastText = [...turn.block.querySelectorAll(".text")].at(-1);
    if (lastText && !lastText.classList.contains("commentary") && reason === "completed") {
      lastText.classList.add("final");
      // What this turn changed, then what you can do about it — the two things a reader wants
      // at the end of an answer, in that order.
      const summary = turnSummaryCard(turn.edits, turn.prompt);
      const actions = responseActions(lastText, turn.prompt);
      lastText.after(actions);
      if (summary) lastText.after(summary);
      // The work summary separates the collapsed activity from the final response.
      turn.block.insertBefore(turn.act, lastText);
    }
    turn.act.classList.add("done");
    turn.act.textContent = `${reason === "cancelled" ? "Stopped" : reason === "error" ? "Failed" : "Worked"} for ${Math.floor((Date.now() - turn.t0) / 1000)}s`;
    const finished = turn.block;
    turn = null;
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
  function responseActions(textEl, prompt) {
    const actions = el("div", "response-actions");
    const add = (act, icon, label) => {
      const b = el("button", `ract ract-${act}`, `<span class="codicon codicon-${icon}" aria-hidden="true"></span>`);
      b.type = "button"; b.title = label; b.setAttribute("aria-label", label); b.dataset.act = act;
      actions.appendChild(b); return b;
    };
    add("copy", "copy", "Copy response");
    add("up", "thumbsup", "Good response \u2014 kept in this workspace, sent nowhere");
    add("down", "thumbsdown", "Poor response \u2014 kept in this workspace, sent nowhere");
    add("branch", "git-branch", "Branch into a new chat from here");
    add("retry", "refresh", "Run this prompt again");
    add("edit", "edit", "Edit this prompt and send it again");
    const body = () => textEl._markdown || textEl.textContent;
    actions.onclick = (event) => {
      const button = event.target.closest("[data-act]");
      if (!button) return;
      const act = button.dataset.act;
      if (act === "copy") { vscode.postMessage({ type: "copy", text: body() }); flashAction(button, "check"); return; }
      if (act === "up" || act === "down") {
        const on = button.classList.contains("on");
        actions.querySelectorAll(".ract-up, .ract-down").forEach((b) => b.classList.remove("on"));
        if (!on) button.classList.add("on");
        vscode.postMessage({ type: "rateResponse", rating: on ? "none" : act, prompt: String(prompt || "") });
        return;
      }
      if (act === "branch") { vscode.postMessage({ type: "branchChat", prompt: String(prompt || "") }); return; }
      if (act === "retry") { resend(prompt); return; }
      if (act === "edit") {
        input.value = String(prompt || ""); input.selectionStart = input.selectionEnd = input.value.length;
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
    input.value = text; submit();
    if (input.value === "" && draft) { input.value = draft; onInput(); }
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
    }
  }
  function appendText(value) {
    turn._buf = (turn._buf || "") + value;
    const node = textBlock(); node._markdown = turn._buf;
    if (!turn.renderedAt || Date.now() - turn.renderedAt >= 48) flushText();
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

  function refreshToolGroup(group) {
    if (!group) return;
    const cards = [...group.querySelectorAll(".tool")];
    const running = cards.filter(card => card.dataset.status === "running");
    const failures = cards.filter(card => ["failed", "denied", "stopped"].includes(card.dataset.status));
    const summary = group.querySelector(".tool-group-label");
    group.classList.toggle("running", running.length > 0);
    if (running.length) {
      const card = running.at(-1);
      summary.textContent = `${toolCopy(card.dataset.toolName).present} ${card.dataset.summary || ""}`.trim();
    } else {
      // Say what happened in a sentence, the way a colleague would: "Read 5 files and searched
      // code", not a tally of function names. Counts only where the number tells you something.
      const counts = Object.create(null);
      const bucket = {
        read_file: "read", grep: "searched", glob: "searched", repo_map: "mapped",
        code_intel: "mapped", write_file: "created", create_file: "created",
        edit_file: "edited", apply_patch: "edited", multi_edit: "edited",
        bash: "ran", browser: "looked", web_search: "web", web_fetch: "web",
      };
      for (const card of cards) {
        const key = bucket[canonicalTool(card.dataset.toolName)] || "other";
        counts[key] = (counts[key] || 0) + 1;
      }
      const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
      const phrases = [
        counts.read && `read ${plural(counts.read, "file", "files")}`,
        counts.edited && `edited ${plural(counts.edited, "file", "files")}`,
        counts.created && `created ${plural(counts.created, "file", "files")}`,
        counts.ran && `ran ${plural(counts.ran, "command", "commands")}`,
        counts.searched && "searched code",
        counts.mapped && "mapped the project",
        counts.looked && `looked at ${plural(counts.looked, "page", "pages")}`,
        counts.web && "searched the web",
        counts.other && `used ${plural(counts.other, "tool", "tools")}`,
      ].filter(Boolean);
      let sentence = phrases.length > 1
        ? `${phrases.slice(0, -1).join(", ")} and ${phrases.at(-1)}`
        : (phrases[0] || "Worked");
      sentence = sentence.charAt(0).toUpperCase() + sentence.slice(1);
      if (failures.length) {
        sentence += ` · ${failures.length} ${failures.length === 1 ? "issue" : "issues"}`;
      }
      summary.textContent = sentence;
    }
    if (failures.length) group.open = true;
  }
  function appendTool(card) {
    if (!turn.toolGroup) {
      turn.toolGroup = appendTurnContent(el("details", "tool-group"));
      turn.toolGroup.innerHTML = '<summary><span class="codicon codicon-tools" aria-hidden="true"></span><span class="tool-group-label">Working</span></summary>';
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
              : value === "stopped" ? `${copy.present} · stopped` : copy.past;
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
    [...turn.block.querySelectorAll(".text")].at(-1)?.classList.add("commentary");
    if (["read_file", "write_file", "edit_file", "apply_patch"].includes(ev.name) && ev.summary) head.appendChild(openFileBtn(ev.summary));
    const status = el("span", "sr-only tool-status", "running");
    toggle.appendChild(status);
    const dot = el("span", "dot run"); dot.setAttribute("aria-hidden", "true");
    head.appendChild(dot);
    head.appendChild(el("span", "badge"));
    const elapsed = el("span", "tool-time", ""); head.appendChild(elapsed);
    c._timer = setInterval(() => {
      const seconds = (Date.now() - c._startedAt) / 1000;
      elapsed.textContent = seconds >= 1 ? `${seconds.toFixed(1)}s` : "";
    }, 200);
    setToolStatus(c, "running");
    appendTool(c); breakText(); return c;
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
  function updateInputActivity() {
    if (!turn?.act) return;
    const waiting = !!turn.block.querySelector(".card[data-request-id]:not(.resolved)");
    turn.act.classList.toggle("waiting-input", waiting);
    turn.act.querySelector(".verb").textContent = waiting ? "waiting for your input" : "working…";
  }
  function requestCard(c, id) { c.dataset.requestId = String(id); updateInputActivity(); return c; }
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
    updateInputActivity();
    return true;
  }
  function expireOpenRequests() {
    document.querySelectorAll(".card[data-request-id]:not(.resolved)").forEach(resolveCard);
  }
  function sysLine(msg, isErr) { const line = el("div", "sys" + (isErr ? " err" : ""), esc(msg)); if (isErr) line.setAttribute("role", "alert"); appendConversationContent(line); }

  // ---- Codex-style composer rail: durable workspace changes and standing goal ----
  let changeState = { total: 0, additions: 0, deletions: 0, files: [] };
  let workspaceChangeState = { ...changeState }, reviewScope = "chat";
  function syncComposerRail() {
    composerRail.hidden = goalBar.hidden && changesBar.hidden;
    composerRail.classList.toggle("has-changes", !changesBar.hidden);
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
    goalBar.hidden = !text;
    syncComposerRail();
    if (!text) { closeGoalEditor(false); closeGoalReview(false); return; }
    $("goal-text").textContent = text;
    const paused = status === "paused", blocked = status === "blocked", completed = status === "completed";
    $("goal-status").textContent = paused ? "Paused goal" : blocked ? "Blocked goal" : completed ? "Completed goal" : "Pursuing goal";
    goalBar.dataset.status = status;
    const toggle = $("goal-toggle"), icon = toggle.querySelector(".codicon");
    toggle.hidden = false;
    const resume = paused || blocked || completed;
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
      input.value = String(skill.default_prompt).slice(0, 4096);
      input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px";
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
      case "history": renderHistory(ev.items || []); break;
      case "rewound":
        if (ev.ok) {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; renderQueued(); setSending(false);
        }
        break;
      case "session":
        if (["cleared", "new", "resumed"].includes(ev.kind)) {
          discardTurn(); log.innerHTML = ""; queuedCount = 0; renderQueued(); setSending(false);
        }
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
      case "turn_start": startTurn(ev.prompt, ev.kind); setSending(true); if (queuedCount > 0) { queuedCount--; renderQueued(); } break;
      case "turn_eta": if (turn && typeof ev.label === "string") { turn.eta = ev.label.slice(0, 80); renderTurnMeta(); } break;
      case "handoff_started":
        startTurn(); setSending(true); speak("DGC is generating a handoff");
        if (turn?.act?.querySelector(".verb")) turn.act.querySelector(".verb").textContent = "generating handoff…";
        break;
      case "queued": queuedCount = ev.count; renderQueued(); break;
      case "prompt_accepted": {
        const pending = pendingPrompts.get(ev.request_id);
        if (ev.state === "steered") {
          if (pending?.node) pending.node.querySelector(".role").textContent = "you · steering pending";
        } else {
          if (ev.state === "queued" && pending?.node) pending.node.querySelector(".role").textContent = "you · queued";
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
      case "stream_end": finishReasoning(); breakText(); break;
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
        c.querySelector(".body pre").textContent = String(ev.message || "").slice(0, 500);
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
        else { const out = String(ev.output || ""); c.querySelector(".body pre").textContent = out.slice(0, 4000); c.querySelector(".badge").textContent = out.split("\n").length + " ln"; }
        breakText(); break;
      }
      case "tool_denied": {
        ensureTurn();
        turn._tools = turn._tools || Object.create(null);
        const key = ev.call_id || ev.name;
        const c = turn._tools[key] || (turn._tools[key] = toolCard({ name: ev.name, summary: ev.reason }));
        c.querySelector(".dot").className = "dot deny";
        setToolStatus(c, "denied");
        c.querySelector(".body pre").textContent = String(ev.reason || "Permission denied");
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
        skillRows = Array.isArray(ev.items) ? ev.items : [];
        if (surfaceKind === "skills") renderSkills(ev.items);
        if (popMode === "/" || popMode === "$") onInput();
        break;
      }
      case "skill_detail": if (surfaceKind === "skills") renderSkillDetail(ev); break;
      case "docs_catalog": if (surfaceKind === "docs") renderDocs(ev.items); break;
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
        if (ev.command === "prompt" || ev.command === "start_goal") rejectPrompt(ev.request_id);
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
      case "error": speak(`DGC error: ${ev.message}`); sysLine(ev.message, true); if (ev.fatal) { endTurn("error"); setSending(false); } break;
      case "turn_end": speak(ev.reason === "cancelled" ? "DGC generation stopped" : ev.reason === "error" ? "DGC response ended with an error" : "DGC response complete"); endTurn(ev.reason); setSending(false); break;
    }
    if (stick || following) scroll(); else noteNewContent();
  }

  // ---- composer ----
  function hasComposerInput() { return Boolean(input.value.trim() || attachments.length); }
  function renderComposerControls() {
    const hasDraft = hasComposerInput(), stop = streaming && !hasDraft;
    const label = stop ? "Stop generation" : streaming ? (nativeSteering ? "Steer current run" : "Queue next turn") : "Send message";
    send.innerHTML = `<span class="codicon codicon-${stop ? "debug-stop" : "arrow-up"}" aria-hidden="true"></span>`;
    send.title = label; send.setAttribute("aria-label", label);
    // Filled (DGC purple) only when the button will actually do something: text to send, or a
    // run to stop. Empty composer leaves it a quiet surface, so the accent stays meaningful.
    send.classList.toggle("ready", hasDraft || streaming);
    $("queue-send").hidden = !streaming || !nativeSteering;
    $("queue-send").disabled = !hasDraft;
    $("stop-run").hidden = !streaming || !hasDraft;
    $("followup-hint").hidden = !streaming;
    $("followup-hint").textContent = nativeSteering ? "Enter to steer · Alt+Enter to queue" : "Follow-ups queue for the next turn";
  }
  function setSending(on) {
    streaming = on; renderComposerControls();
    document.querySelectorAll("[data-skill-mutation]").forEach(button => {
      button.disabled = on; button.title = on ? "Available after this turn finishes" : "";
    });
  }
  function doStop() { queuedCount = 0; renderQueued(); vscode.postMessage({ type: "cancel" }); }
  $("goal-toggle").onclick = () => vscode.postMessage({
    type: goalState.status === "active" ? "pauseGoal" : "resumeGoal",
  });
  $("goal-clear").onclick = () => vscode.postMessage({ type: "clearGoal" });
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
    input.value = ""; input.style.height = "auto"; attachments.length = 0;
    renderAtts(); persistDraft(); scroll();
  }
  function submit(delivery = nativeSteering ? "steer" : "queue") {
    if (!sessionReady) { sysLine("DGC is reconnecting to this chat. Your draft is saved."); persistDraft(); return; }
    if (pendingImageFiles) { sysLine("Wait for the pasted images to finish loading before sending."); return; }
    const text = input.value.trim();
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
      input.value = ""; input.style.height = "auto"; persistDraft(); return;
    }
    const trailingGoal = /^([\s\S]*\S)\s+\/goal$/i.exec(text)?.[1].trim();
    if (trailingGoal) { submitGoal(trailingGoal); return; }
    const workflowPrompt = (/^\/(plan|review|init)(?:\s|$)/i.test(text)
      || /\s+\/(plan|review|init)$/i.test(text)) && !(text.toLowerCase() === "/plan" && !attachments.length);
    if (text.startsWith("/") && !attachments.length && !workflowPrompt) {
      const name = (text.slice(1).split(/\s+/, 1)[0] || "").toLowerCase();
      const custom = customCommands.includes(name);
      if (custom) {
          const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
          m.appendChild(el("div", "bubble", esc(text)));
          log.appendChild(m); settleBlock(m); setSending(true);
      }
      vscode.postMessage({ type: "slashText", text });
      input.value = ""; input.style.height = "auto"; persistDraft(); scroll(); return;
    }
    const m = el("div", "msg user"); m.appendChild(el("div", "role", "you"));
    m.appendChild(el("div", "bubble", esc(text) + attachments.map((a) => `\n[${esc(a.label)}]`).join(""))); log.appendChild(m); settleBlock(m);
    const requestId = `${promptPrefix}-${++promptSequence}`;
    pendingPrompts.set(requestId, { text, attachments: [...attachments], node: m, session: draftSession });
    vscode.postMessage({ type: "prompt", text, requestId, images: imgs.length ? imgs : undefined,
      delivery,
      skills: skills.length ? skills : undefined, templates: templates.length ? templates : undefined,
      context: resources.length ? resources : undefined });
    input.value = ""; input.style.height = "auto"; attachments.length = 0; renderAtts(); persistDraft(); setSending(true); scroll();
  }
  function renderAtts() {
    atts.innerHTML = "";
    attachments.forEach((a, i) => {
      const chip = el("span", `chip${a.skill || a.template ? " invocation-chip" : ""}`), label = el("span", "chip-label"), remove = el("button", "x", "×");
      label.textContent = a.label; label.title = a.label; remove.type = "button"; remove.title = "Remove this attachment";
      remove.setAttribute("aria-label", `Remove attachment ${a.label}`);
      remove.onclick = () => { attachments.splice(i, 1); renderAtts(); };
      chip.appendChild(label); chip.appendChild(remove); atts.appendChild(chip);
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
    input.value = input.value.slice(0, popStart) + value + input.value.slice(popEnd);
    input.selectionStart = input.selectionEnd = popStart + value.length;
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
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
        replacePopToken();
        prepareWorkflowDraft(it.action.slice("workflow:".length));
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
  function prepareWorkflowDraft(name) {
    if (!["plan", "review", "init"].includes(name)) return;
    const prefix = `/${name} `;
    const current = /^\/(plan|review|init)(?:\s+|$)/i.exec(input.value);
    const removed = current ? current[0].length : 0;
    const caret = Math.max(0, input.selectionStart - removed) + prefix.length;
    input.value = prefix + input.value.slice(removed);
    input.selectionStart = input.selectionEnd = caret;
    input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px";
    persistDraft(); input.focus();
  }
  function onInput() {
    scheduleDraftSave();
    renderComposerControls();
    input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 160) + "px";
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
      }
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
  $("btn-add").onclick = () => {                       // insert @ at the caret → file popover
    input.focus();
    const p = input.selectionStart;
    input.value = input.value.slice(0, p) + "@" + input.value.slice(p);
    input.selectionStart = input.selectionEnd = p + 1;
    onInput();
  };
  function openCommandMenu() {
    const caret = input.selectionEnd;
    const prefix = caret && !/\s/.test(input.value[caret - 1]) ? " /" : "/";
    input.value = input.value.slice(0, caret) + prefix + input.value.slice(caret);
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
    let cursor = items.length;
    function page() {
      const frag = document.createDocumentFragment(), start = Math.max(0, cursor - 50);
      items.slice(start, cursor).forEach((it) => {
      if (it.role === "user") {
        const m = el("div", "msg user hist"); m.appendChild(el("div", "role", "you"));
        m.appendChild(el("div", "bubble", esc(it.text))); frag.appendChild(m);
      } else if (it.role === "compaction") {
        // Earlier turns were summarised so the run could keep going. Say so plainly; the summary
        // is the model's own context, available on request rather than pasted into the chat.
        const note = el("details", "compaction hist");
        note.innerHTML = '<summary><span class="codicon codicon-fold" aria-hidden="true"></span>'
          + "<span>Earlier conversation summarised to keep it in context</span></summary>";
        const body = el("pre", "compaction-body");
        body.textContent = String(it.text || "").slice(0, 20000);
        note.appendChild(body);
        frag.appendChild(note);
      } else if (it.role === "notice") {
        frag.appendChild(el("div", "sys hist", esc(it.text)));
      } else {
        const m = el("div", "msg dgc hist"); m.appendChild(el("div", "role dgc", "DGC"));
        if (it.text) {
          const text = el("div", it.commentary || it.tools?.length ? "text commentary" : "text final", md(it.text));
          text._markdown = it.text; m.appendChild(text);
        }
        if (it.tools?.length) {
          const group = el("details", "tool-group history-tools");
          const summary = el("summary"); summary.textContent = `Used ${it.tools.length} ${it.tools.length === 1 ? "tool" : "tools"} · ${it.tools.join(", ")}`;
          group.appendChild(summary);
          // Output is constructed only on expansion, keeping long restored threads responsive.
          group.addEventListener("toggle", () => {
            if (!group.open || group.dataset.loaded) return;
            group.dataset.loaded = "true";
            (it.tool_details || []).forEach(detail => {
              const row = el("div", "tool history-tool"), label = el("div", "nm"), pre = el("pre", "out");
              label.textContent = `${detail.name} · ${detail.status === "returned" ? "saved result" : "result unavailable"}`;
              pre.textContent = [detail.arguments, detail.output].filter(Boolean).join("\n\n");
              row.append(label, pre); group.appendChild(row);
            });
          });
          m.appendChild(group);
        }
        frag.appendChild(m);
      }
      });
      const oldHeight = log.scrollHeight, oldTop = log.scrollTop;
      const landed = [...frag.children];
      older.after(frag); cursor = start; older.hidden = cursor === 0;
      landed.forEach(settleBlock);
      log.scrollTop = oldTop + log.scrollHeight - oldHeight;
    }
    older.type = "button"; older.onclick = page;
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
      copy.textContent = "Copied";
      setTimeout(() => { if (copy.isConnected) copy.textContent = "Copy"; }, 1600);
    }
  });

  window.addEventListener("message", (e) => {
    const msg = e.data;
    if (msg.type === "event") onEvent(msg.event);
    else if (msg.type === "session_ready") {
      selectDraftSession(msg.sessionId, msg.adoptDraftFrom || ""); sessionReady = true;
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
    else if (msg.type === "settings_open") { openSettings(msg.providers, msg.models, msg.section); }
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
      input.value = String(msg.text || ""); input.selectionStart = input.selectionEnd = input.value.length;
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
    else if (msg.type === "open_goal_review") openGoalReview();
    else if (msg.type === "workflow_draft") prepareWorkflowDraft(msg.name);
    else if (msg.type === "backend_exit") { sessionReady = !draftScope; endTurn("error"); expireOpenRequests(); for (const id of [...pendingPrompts.keys()]) rejectPrompt(id, false); renderUnconfirmedDrafts(); sysLine("dgc backend exited" + (msg.code ? " (code " + msg.code + ")" : ""), true); setSending(false); }
  });
  loadDraftState();
  window.addEventListener("pagehide", persistDraft);
  input.addEventListener("select", scheduleDraftSave);
  vscode.postMessage({ type: "webviewReady" });
})();
