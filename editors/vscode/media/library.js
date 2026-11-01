// The Library (ChatGPT's): every file attached in ChatDGC, in every chat and project, newest first. Search by name,
// show one kind, and for each: open where it is, use it in a new chat, save a copy, add it to a project, delete it.
// And its widgets (a backend that keeps them says so): every interactive answer, to open beside you again or delete.
// And its artifacts (ready.capabilities.artifacts): every document, deck, sheet, page and dashboard DGC made, wherever it
// made it, newest first; shown by kind and by where it was made; to open, export or remove (to DGC's trash).
// Names are the user's words: text nodes only. Images are asked of the backend by id, as the chat screen asks.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const icon = (name) => { const g = el("span", `codicon codicon-${name}`); g.setAttribute("aria-hidden", "true"); return g; };
  const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  const KINDS = [["", "All"], ["image", "Images"], ["pdf", "PDFs"], ["document", "Documents"], ["spreadsheet", "Spreadsheets"],
                 ["presentation", "Presentations"], ["code", "Code"], ["text", "Pasted text"]];
  const TYPE_NAME = { image: "Image", pdf: "PDF", document: "Document", spreadsheet: "Spreadsheet", presentation: "Presentation", code: "Code", text: "Pasted text" };
  const TYPE_ICON = { image: "file-media", pdf: "file-pdf", document: "file-text", spreadsheet: "table", presentation: "preview", code: "file-code", text: "note" };
  const saved = (() => { try { return vscode.getState() || {}; } catch { return {}; } })();
  const ORIGINS = [["", "All"], ["uploaded", "Uploaded"], ["made", "Made by ChatDGC"]];
  const state = { query: "", kind: KINDS.some(([k]) => k === saved.kind) ? saved.kind : "", files: [], total: 0, next: null, counts: {},
                  origin: ORIGINS.some(([o]) => o === saved.origin) ? saved.origin : "", origins: {}, loading: true, asking: 0,
                  view: ["widgets", "artifacts"].includes(saved.view) ? saved.view : "files", offered: false, widgets: [], widgetsNext: null,
                  artifactsOffered: false, artifacts: [], atype: typeof saved.atype === "string" ? saved.atype : "", made: typeof saved.made === "string" ? saved.made : "" };
  const ATYPES = [["", "All"], ["doc", "Documents"], ["slides", "Slides"], ["sheet", "Spreadsheets"], ["page", "Pages"], ["dashboard", "Dashboards"]];
  const MADE = [["", "Anywhere"], ["chat", "Chat"], ["work", "Work"], ["pip", "Pips"]];
  const A_KIND = { doc: "Document", slides: "Slides", sheet: "Spreadsheet", page: "Page", dashboard: "Dashboard" };
  const A_ICON = { doc: "file-text", slides: "preview", sheet: "table", page: "browser", dashboard: "dashboard" };
  const A_MADE = { chat: "made in Chat", work: "made in Work", pip: "made by a Pip", sdk: "made by an app", cli: "made in the terminal" };
  const FORMATS = { docx: "Word document (.docx)", pdf: "PDF", md: "Markdown (.md)", pptx: "PowerPoint (.pptx)", html: "Web page (.html)",
                    xlsx: "Excel workbook (.xlsx)", csv: "CSV (first sheet)", zip: "Zip of its files (.zip)" };
  const ABOUT = { files: "Every file you attached in ChatDGC or it made for you, in every chat and project. Temporary chats keep none.",
                  widgets: "Every calculator, timer or quiz ChatDGC made for you, in every chat. Open one beside you, or delete it.",
                  artifacts: "Every document, deck, sheet, page and dashboard DGC made for you, in Chat, Work and your Pips, with every version. Open one, export it, or remove it." };
  const images = new Map();
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  function when(stamp) {
    const at = Date.parse(String(stamp || ""));
    if (!Number.isFinite(at)) return "";
    const days = Math.floor((Date.now() - at) / 86400000);
    if (days < 1) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: new Date(at).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }
  function ask(offset = 0) {
    state.loading = true; state.asking = offset;       // a later page adds to the list; a new search replaces it
    status();
    if (state.view === "widgets") { vscode.postMessage({ type: "widgets", query: state.query, offset }); return; }
    if (state.view === "artifacts") { vscode.postMessage({ type: "artifactList" }); return; }
    vscode.postMessage({ type: "list", query: state.query, kind: state.kind, ...(state.origin ? { origin: state.origin } : {}), offset });
  }
  function views() {
    // Files, Widgets and Artifacts, as tabs; Widgets and Artifacts only once the backend says it keeps them.
    const bar = $("lib-views");
    const offered = [["files", "Files"], ...(state.offered ? [["widgets", "Widgets"]] : []), ...(state.artifactsOffered ? [["artifacts", "Artifacts"]] : [])];
    bar.hidden = offered.length < 2;
    bar.replaceChildren();
    if (bar.hidden) return;
    for (const [view, label] of offered) {
      const tab = el("button", "lib-view", label);
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", String(state.view === view));
      tab.addEventListener("click", () => show(view));
      bar.append(tab);
    }
  }
  function show(view) {
    if (state.view === view) return;
    state.view = view; state.query = ""; $("lib-search").value = "";
    state.files = []; state.widgets = [];
    try { vscode.setState({ ...(vscode.getState() || {}), view }); } catch {}
    place();
    render();
    ask();
  }
  function place() {
    const noun = { files: "files", widgets: "widgets", artifacts: "artifacts" }[state.view];
    $("lib-about").textContent = ABOUT[state.view];
    $("lib-search").placeholder = `Search ${noun}`;
    $("lib-search").setAttribute("aria-label", `Search your ${noun} by name`);
    $("lib-list").setAttribute("aria-label", `Your ${noun}`);
  }
  function status() {
    const line = $("lib-status");
    if (state.view === "artifacts") {
      const shown = artifactsShown();
      line.textContent = state.loading && !state.artifacts.length ? "Loading…" : shown.length ? ""
        : state.query ? `No artifact named like “${state.query}”.`
        : state.atype || state.made ? "None like that yet."
        : "Documents, decks, sheets, pages and dashboards DGC makes for you show here.";
      line.hidden = !line.textContent;
      return;
    }
    if (state.view === "widgets") {
      line.textContent = state.loading && !state.widgets.length ? "Loading…" : state.widgets.length ? ""
        : state.query ? `No widget named like “${state.query}”.` : "Calculators, timers and quizzes ChatDGC makes for you show here.";
      line.hidden = !line.textContent;
      return;
    }
    line.textContent = state.loading && !state.files.length ? "Loading…"
      : state.files.length ? "" : state.query ? `No file named like “${state.query}”.`
      : state.kind ? `No ${KINDS.find(([k]) => k === state.kind)[1].toLowerCase()} yet.`
      : "Files you attach to chats, and files in your projects, show here.";
    line.hidden = !line.textContent;
  }
  function origins() {
    // As ChatGPT filters it: files you uploaded, or files ChatDGC made. Shown once it has made one.
    const bar = $("lib-origins");
    const made = Number(state.origins.made) || 0, uploaded = Number(state.origins.uploaded) || 0;
    bar.hidden = !made && !state.origin;
    bar.replaceChildren();
    if (bar.hidden) return;
    for (const [origin, label] of ORIGINS) {
      const chip = el("button", "lib-kind");
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(state.origin === origin));
      chip.append(el("span", "", label), el("span", "lib-kind-count", String(origin === "made" ? made : origin === "uploaded" ? uploaded : made + uploaded)));
      chip.addEventListener("click", () => {
        state.origin = origin; state.files = [];
        try { vscode.setState({ ...(vscode.getState() || {}), origin }); } catch {}
        ask();
      });
      bar.append(chip);
    }
  }
  function kinds() {
    const bar = $("lib-kinds");
    bar.replaceChildren();
    const all = Object.values(state.counts).reduce((a, b) => a + (Number(b) || 0), 0);
    for (const [kind, label] of KINDS) {
      const count = kind ? Number(state.counts[kind]) || 0 : all;
      if (kind && !count && state.kind !== kind) continue;
      const chip = el("button", "lib-kind");
      chip.type = "button";
      chip.setAttribute("aria-pressed", String(state.kind === kind));
      chip.append(el("span", "", label), el("span", "lib-kind-count", String(count)));
      chip.title = `Show ${label.toLowerCase()}`;
      chip.addEventListener("click", () => {
        state.kind = kind; state.files = [];
        try { vscode.setState({ ...(vscode.getState() || {}), kind }); } catch {}
        ask();
      });
      bar.append(chip);
    }
  }
  function where(file) {
    if (file.source === "project") return `in the project ${file.project_name || ""}`.trim();
    return `${file.made ? "made in" : "in"} “${file.chat_title || "a chat"}”` + (file.project_name ? ` · ${file.project_name}` : "");
  }
  function preview(file) {
    const box = el("span", "lib-preview");
    if (file.type === "image" && file.source === "chat") {
      const img = el("img");
      img.alt = ""; img.dataset.att = file.id;
      const known = images.get(file.id);
      if (known?.data && IMAGE_DATA.test(known.data)) img.src = known.data;
      else if (!known) { images.set(file.id, "asked"); vscode.postMessage({ type: "image", file }); }
      if (!known?.error) { box.append(img); return box; }
    }
    box.append(icon(TYPE_ICON[file.type] || "file"));
    return box;
  }
  function action(name, label, onClick) {
    const button = el("button", "lib-action");
    button.type = "button"; button.title = label; button.setAttribute("aria-label", label);
    button.append(icon(name));
    button.addEventListener("click", onClick);
    return button;
  }
  function row(file) {
    const item = el("li", "lib-row");
    const main = el("div", "lib-main");
    main.append(el("span", "lib-name", file.name || "file"));
    const meta = [TYPE_NAME[file.type] || "File", Number(file.size) ? sizeText(Number(file.size)) : "", where(file), when(file.created_at)].filter(Boolean);
    main.append(el("span", "lib-meta", meta.join(" · ")));
    const actions = el("div", "lib-actions");
    actions.append(
      action(file.source === "project" ? "folder" : "comment-discussion", file.source === "project" ? `Open the project ${file.project_name || ""}`.trim() : "Open the chat it's in",
             () => vscode.postMessage({ type: "open", file })),
      action("comment", "Use in a new chat", () => vscode.postMessage({ type: "use", file })),
      action("desktop-download", "Save a copy…", () => vscode.postMessage({ type: "save", file })),
      action("new-folder", "Add a copy to a project…", () => vscode.postMessage({ type: "toProject", file })),
      action("trash", "Delete from your Library", () => vscode.postMessage({ type: "remove", file })));
    item.append(preview(file), main, actions);
    return item;
  }
  function widgetRow(w) {
    const item = el("li", "lib-row");
    const main = el("div", "lib-main");
    main.append(el("span", "lib-name", w.title || "Interactive"));
    const where = `in “${w.chat_title || "a chat"}”` + (w.project_name ? ` · ${w.project_name}` : "");
    main.append(el("span", "lib-meta", ["Interactive", where, when(w.created_at)].filter(Boolean).join(" · ")));
    const actions = el("div", "lib-actions");
    actions.append(
      action("play", "Open it beside you", () => vscode.postMessage({ type: "widgetOpen", widget: w })),
      action("comment-discussion", "Open the chat it's in", () => vscode.postMessage({ type: "widgetChat", widget: w })),
      action("trash", "Delete the widget", () => vscode.postMessage({ type: "widgetRemove", widget: w })));
    const box = el("span", "lib-preview");
    box.append(icon("play-circle"));
    item.append(box, main, actions);
    return item;
  }
  // ---- artifacts
  function artifactsShown() {
    const q = state.query.toLowerCase();
    return state.artifacts.filter((a) => (!state.atype || a.type === state.atype) && (!state.made || a.origin?.surface === state.made)
      && (!q || String(a.title || "").toLowerCase().includes(q)))
      .sort((a, b) => String(b.updated || b.created || "").localeCompare(String(a.updated || a.created || "")));
  }
  function chips(bar, options, current, count, set) {
    bar.replaceChildren();
    for (const [value, label] of options) {
      const n = count(value);
      if (value && !n && current !== value) continue;
      const chip = el("button", "lib-kind");
      chip.type = "button";
      chip.dataset.value = value;
      chip.setAttribute("aria-pressed", String(current === value));
      chip.append(el("span", "", label), el("span", "lib-kind-count", String(n)));
      chip.addEventListener("click", () => set(value));
      bar.append(chip);
    }
  }
  function artifactFilters() {
    const byType = (t) => state.artifacts.filter((a) => (!t || a.type === t) && (!state.made || a.origin?.surface === state.made)).length;
    const byMade = (m) => state.artifacts.filter((a) => (!m || a.origin?.surface === m) && (!state.atype || a.type === state.atype)).length;
    const keep = () => { try { vscode.setState({ ...(vscode.getState() || {}), atype: state.atype, made: state.made }); } catch {} };
    chips($("lib-kinds"), ATYPES, state.atype, byType, (t) => { state.atype = t; keep(); render(); });
    chips($("lib-made"), MADE, state.made, byMade, (m) => { state.made = m; keep(); render(); });
    $("lib-kinds").setAttribute("aria-label", "Show kind");
  }
  let menuOpen = null;
  function closeMenu(focus) {
    if (!menuOpen) return;
    menuOpen.menu.remove(); menuOpen.button.setAttribute("aria-expanded", "false");
    if (focus) menuOpen.button.focus();
    menuOpen = null;
  }
  document.addEventListener("click", (e) => { if (menuOpen && !menuOpen.menu.contains(e.target) && !menuOpen.button.contains(e.target)) closeMenu(false); });
  function exportMenu(button, a) {
    if (menuOpen?.button === button) { closeMenu(true); return; }
    closeMenu(false);
    const menu = el("div", "lib-menu");
    menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", `Export ${a.title || "it"} as`);
    for (const format of Array.isArray(a.exports) ? a.exports : []) {
      const item = el("button", "lib-menu-item", FORMATS[format] || format.toUpperCase());
      item.type = "button"; item.setAttribute("role", "menuitem"); item.dataset.format = format;
      item.addEventListener("click", () => { closeMenu(true); vscode.postMessage({ type: "artifactExport", artifact: a, format }); });
      menu.append(item);
    }
    menu.addEventListener("keydown", (e) => {
      const items = [...menu.querySelectorAll("button")];
      const at = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); closeMenu(true); }
      else if (e.key === "ArrowDown") { e.preventDefault(); items[(at + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); items[(at - 1 + items.length) % items.length].focus(); }
      else if (e.key === "Tab") closeMenu(false);
    });
    button.parentElement.append(menu);
    button.setAttribute("aria-expanded", "true");
    menuOpen = { menu, button };
    menu.querySelector("button")?.focus();
  }
  function artifactRow(a) {
    const item = el("li", "lib-row lib-artifact");
    item.dataset.artifact = a.id; item.dataset.type = a.type;
    const main = el("div", "lib-main");
    main.append(el("span", "lib-name", a.title || A_KIND[a.type] || "Artifact"));
    main.append(el("span", "lib-meta", [A_KIND[a.type] || a.type, `version ${Number(a.version) || 1}`, A_MADE[a.origin?.surface] || "", when(a.updated || a.created)].filter(Boolean).join(" · ")));
    const actions = el("div", "lib-actions");
    actions.append(action("go-to-file", a.type === "doc" ? "Open it in the editor" : "Open it", () => vscode.postMessage({ type: "artifactOpen", artifact: a })));
    if (Array.isArray(a.exports) && a.exports.length) {
      const wrap = el("span", "lib-menu-wrap");
      const exp = action("desktop-download", "Export…", () => exportMenu(exp, a));
      exp.setAttribute("aria-haspopup", "menu"); exp.setAttribute("aria-expanded", "false");
      wrap.append(exp);
      actions.append(wrap);
    }
    actions.append(action("trash", "Remove: it goes to DGC's trash, where it can be recovered", () => vscode.postMessage({ type: "artifactRemove", artifact: a })));
    const box = el("span", "lib-preview");
    box.append(icon(A_ICON[a.type] || "file"));
    item.append(box, main, actions);
    return item;
  }

  function render() {
    views();
    const widgets = state.view === "widgets", artifacts = state.view === "artifacts";
    $("lib-origins").hidden = true; $("lib-kinds").hidden = widgets; $("lib-made").hidden = !artifacts;
    if (artifacts) artifactFilters();
    else if (!widgets) { $("lib-kinds").setAttribute("aria-label", "Show"); origins(); kinds(); }
    $("lib-list").replaceChildren(...(artifacts ? artifactsShown().map(artifactRow) : widgets ? state.widgets.map(widgetRow) : state.files.map(row)));
    const next = artifacts ? null : widgets ? state.widgetsNext : state.next;
    $("lib-more").hidden = next === null || next === undefined;
    status();
  }
  let timer = 0;
  $("lib-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.query = e.target.value.trim();
      if (state.view === "artifacts") { render(); return; }       // the whole list is here: searched as it is
      state.files = []; ask();
    }, 250);
  });
  $("lib-more").addEventListener("click", () => ask(state.view === "widgets" ? state.widgets.length : state.files.length));
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "library") {
      const files = Array.isArray(msg.files) ? msg.files : [];
      state.files = state.asking ? [...state.files, ...files] : files;
      state.total = Number(msg.total) || 0; state.next = msg.next ?? null;
      state.counts = msg.counts && typeof msg.counts === "object" ? msg.counts : {};
      state.origins = msg.origins && typeof msg.origins === "object" ? msg.origins : {};
      state.loading = false;
      render();
    } else if (msg.type === "widgets") {
      const widgets = Array.isArray(msg.widgets) ? msg.widgets : [];
      state.widgets = state.asking ? [...state.widgets, ...widgets] : widgets;
      state.widgetsNext = msg.next ?? null;
      state.loading = false;
      render();
    } else if (msg.type === "widgetsOffered") {
      const was = state.offered;
      state.offered = msg.on === true;
      if (!state.offered && state.view === "widgets") show("files");        // as if Files were chosen
      else { if (state.offered && !was && state.view === "widgets") ask(); render(); }
    } else if (msg.type === "artifactsOffered") {
      const was = state.artifactsOffered;
      state.artifactsOffered = msg.on === true;
      if (!state.artifactsOffered && state.view === "artifacts") show("files");
      else { if (state.artifactsOffered && !was && state.view === "artifacts") ask(); render(); }
    } else if (msg.type === "artifacts") {
      state.artifacts = Array.isArray(msg.items) ? msg.items.filter((a) => a && /^ar_[a-f0-9]{16}$/.test(String(a.id || ""))) : [];
      state.loading = false;
      render();
    } else if (msg.type === "artifactRemoved") {
      state.artifacts = state.artifacts.filter((a) => a.id !== msg.id);
      render();
    } else if (msg.type === "artifactChanged") {
      if (state.view === "artifacts") ask();       // made, changed or removed anywhere: the list as it is now
    } else if (msg.type === "view") {
      // Opened from a chat's Widgets list: the Widgets tab (the host says so only to a backend that keeps them).
      if (msg.view === "widgets" && state.offered) show("widgets");
      if ((msg.view === "artifacts" || msg.view === "artifacts-work") && state.artifactsOffered) {
        state.made = msg.view === "artifacts-work" ? "work" : "";
        try { vscode.setState({ ...(vscode.getState() || {}), made: state.made }); } catch {}
        if (state.view === "artifacts") { render(); ask(); } else show("artifacts");
      }
    } else if (msg.type === "refresh") {
      ask();                                        // the list stays on screen until the new one comes
    } else if (msg.type === "image") {
      const ok = typeof msg.data === "string" && IMAGE_DATA.test(msg.data);
      images.set(msg.id, ok ? { data: msg.data } : { error: true });
      for (const img of document.querySelectorAll(`img[data-att="${CSS.escape(String(msg.id || ""))}"]`)) {
        if (ok && IMAGE_DATA.test(msg.data)) img.src = msg.data; else img.replaceWith(icon("file-media"));
      }
    } else if (msg.type === "changed") {
      state.files = []; ask();
    } else if (msg.type === "error") {
      state.loading = false;
      const line = $("lib-status"); line.textContent = String(msg.message || "Something went wrong."); line.hidden = false;
    }
  });
  place();
  vscode.postMessage({ type: "ready", kind: state.kind });
  status();
}());
