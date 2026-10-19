// The Library (ChatGPT's): every file attached in ChatDGC, in every chat and project, newest first. Search by name,
// show one kind, and for each: open where it is, use it in a new chat, save a copy, add it to a project, delete it.
// And its widgets (a backend that keeps them says so): every interactive answer, to open beside you again or delete.
// Names are the user's words: text nodes only. Images are asked of the backend by id, as the chat screen asks.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const icon = (name) => { const g = el("span", `codicon codicon-${name}`); g.setAttribute("aria-hidden", "true"); return g; };
  const KINDS = [["", "All"], ["image", "Images"], ["pdf", "PDFs"], ["document", "Documents"], ["spreadsheet", "Spreadsheets"],
                 ["presentation", "Presentations"], ["code", "Code"], ["text", "Pasted text"]];
  const TYPE_NAME = { image: "Image", pdf: "PDF", document: "Document", spreadsheet: "Spreadsheet", presentation: "Presentation", code: "Code", text: "Pasted text" };
  const TYPE_ICON = { image: "file-media", pdf: "file-pdf", document: "file-text", spreadsheet: "table", presentation: "preview", code: "file-code", text: "note" };
  const saved = (() => { try { return vscode.getState() || {}; } catch { return {}; } })();
  const ORIGINS = [["", "All"], ["uploaded", "Uploaded"], ["made", "Made by ChatDGC"]];
  const state = { query: "", kind: KINDS.some(([k]) => k === saved.kind) ? saved.kind : "", files: [], total: 0, next: null, counts: {},
                  origin: ORIGINS.some(([o]) => o === saved.origin) ? saved.origin : "", origins: {}, loading: true, asking: 0,
                  view: saved.view === "widgets" ? "widgets" : "files", offered: false, widgets: [], widgetsNext: null };
  const ABOUT = { files: "Every file you attached in ChatDGC or it made for you, in every chat and project. Temporary chats keep none.",
                  widgets: "Every calculator, timer or quiz ChatDGC made for you, in every chat. Open one beside you, or delete it." };
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
    vscode.postMessage({ type: "list", query: state.query, kind: state.kind, ...(state.origin ? { origin: state.origin } : {}), offset });
  }
  function views() {
    // Files and Widgets, as tabs; Widgets only once the backend says it keeps them.
    const bar = $("lib-views");
    bar.hidden = !state.offered;
    bar.replaceChildren();
    if (!state.offered) return;
    for (const [view, label] of [["files", "Files"], ["widgets", "Widgets"]]) {
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
    const widgets = state.view === "widgets";
    $("lib-about").textContent = ABOUT[state.view];
    $("lib-search").placeholder = widgets ? "Search widgets" : "Search files";
    $("lib-search").setAttribute("aria-label", widgets ? "Search your widgets by name" : "Search your files by name");
    $("lib-list").setAttribute("aria-label", widgets ? "Your widgets" : "Your files");
  }
  function status() {
    const line = $("lib-status");
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
      if (known?.data) img.src = known.data;
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
  function render() {
    views();
    const widgets = state.view === "widgets";
    $("lib-origins").hidden = true; $("lib-kinds").hidden = widgets;
    if (!widgets) { origins(); kinds(); }
    $("lib-list").replaceChildren(...(widgets ? state.widgets.map(widgetRow) : state.files.map(row)));
    const next = widgets ? state.widgetsNext : state.next;
    $("lib-more").hidden = next === null || next === undefined;
    status();
  }
  let timer = 0;
  $("lib-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value.trim(); state.files = []; ask(); }, 250);
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
    } else if (msg.type === "view") {
      // Opened from a chat's Widgets list: the Widgets tab (the host says so only to a backend that keeps them).
      if (msg.view === "widgets" && state.offered) show("widgets");
    } else if (msg.type === "refresh") {
      ask();                                        // the list stays on screen until the new one comes
    } else if (msg.type === "image") {
      const ok = typeof msg.data === "string" && /^data:image\/(png|jpeg|gif|webp);base64,/.test(msg.data);
      images.set(msg.id, ok ? { data: msg.data } : { error: true });
      for (const img of document.querySelectorAll(`img[data-att="${CSS.escape(String(msg.id || ""))}"]`)) {
        if (ok) img.src = msg.data; else img.replaceWith(icon("file-media"));
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
