// The Library (ChatGPT's): every file attached in ChatDGC, in every chat and project, newest first. Search by name,
// show one kind, and for each: open where it is, use it in a new chat, save a copy, add it to a project, delete it.
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
                  origin: ORIGINS.some(([o]) => o === saved.origin) ? saved.origin : "", origins: {}, loading: true, asking: 0 };
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
    vscode.postMessage({ type: "list", query: state.query, kind: state.kind, ...(state.origin ? { origin: state.origin } : {}), offset });
  }
  function status() {
    const line = $("lib-status");
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
  function render() {
    origins();
    kinds();
    $("lib-list").replaceChildren(...state.files.map(row));
    $("lib-more").hidden = state.next === null || state.next === undefined;
    status();
  }
  let timer = 0;
  $("lib-search").addEventListener("input", (e) => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.query = e.target.value.trim(); state.files = []; ask(); }, 250);
  });
  $("lib-more").addEventListener("click", () => ask(state.files.length));
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
  vscode.postMessage({ type: "ready", kind: state.kind });
  status();
}());
