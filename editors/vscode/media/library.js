// The Library: ONE module for both places it shows (Library v2, 0.52; his words of 15 Nov: "the library tab UX should
// match the Editor Library page"). It draws the whole Library into one element: the header row every page has
// (media/shared/pagehead.js), the search field, the tabs Artifacts · Widgets · Images · Videos · Files, the chosen
// tab's own filter line, and its rows. The side bar's Library tab mounts it narrow (media/main.js); the Library's
// editor tab mounts it wide (the page src/chatdgc.ts serves: this file's last lines). The same code, the same messages
// to the same host (src/chatdgc.ts fromLibrary), so a change reaches both.
//
//   Artifacts  the pages, sheets, docs, decks and dashboards DGC made. Filters: the kind, and who made it.
//   Widgets    ChatDGC's widgets, and the cards a reply drew in Work or a Pip's chat. Filter: who made it.
//   Images     every image DGC made or kept (images_library, every surface: Work, ChatDGC, the Pips). Filter: who.
//   Videos     every video DGC made (videos_library). Filter: who.
//   Files      what you attached in ChatDGC or it made, in every chat and project. Filters: the kind of file, and
//              whether you uploaded it or ChatDGC made it.
//
// Every row says who made it, by name ("made by Tile checker · 2h"; an image the model kept on purpose says "kept by"),
// and the name leads back: a Pip to its chat, a session and a chat to their tabs. A row opens its item. What else it
// can do (show in its folder, save a copy, download, pin to the dock, remove) is a line of icon buttons where there is
// room and one ⋯ where there is not: the same list either way. The search field searches the tab you are on.
// Names are the user's words: text nodes only. media/shared/library.css is how it looks. A classic script:
// window.DgcLibrary.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcLibrary) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  const ARTIFACT_ID = /^ar_[a-f0-9]{16}$/;
  // The tabs, in his order: id, name, what one of them is called, its icon (a codicon) and its line for a label.
  const TABS = [
    ["artifacts", "Artifacts", "artifact", "browser", "Artifacts: the pages, sheets, docs, decks and dashboards DGC made"],
    ["widgets", "Widgets", "widget", "symbol-misc", "Widgets: ChatDGC's widgets and the cards a reply drew"],
    ["images", "Images", "image", "file-media", "Images: every image DGC made or kept for you"],
    ["videos", "Videos", "video", "device-camera-video", "Videos: every video DGC made for you"],
    ["files", "Files", "file", "files", "Files: what you attached in ChatDGC or it made, in every chat and project. Incognito chats keep none."],
  ];
  const TAB_IDS = TABS.map((t) => t[0]);
  // Artifacts' kinds: the filter's word, and the word of an empty list.
  const A_KINDS = [["", "All", "artifacts"], ["page", "Pages", "pages"], ["sheet", "Sheets", "sheets"], ["doc", "Docs", "docs"], ["slides", "Decks", "decks"], ["dashboard", "Dashboards", "dashboards"]];
  const A_KIND = { doc: "Doc", slides: "Deck", sheet: "Sheet", page: "Page", dashboard: "Dashboard" };
  // Files' kinds (ChatDGC's own), and where a file came from.
  const F_KINDS = [["", "All", "files"], ["image", "Images", "images"], ["pdf", "PDFs", "PDFs"], ["document", "Documents", "documents"], ["spreadsheet", "Spreadsheets", "spreadsheets"],
    ["presentation", "Presentations", "presentations"], ["code", "Code", "code files"], ["text", "Pasted text", "pasted text"]];
  const F_KIND = { image: "Image", pdf: "PDF", document: "Document", spreadsheet: "Spreadsheet", presentation: "Presentation", code: "Code", text: "Pasted text" };
  const ORIGINS = [["", "All"], ["uploaded", "Uploaded"], ["made", "Made by ChatDGC"]];
  const FORMATS = { docx: "Word document (.docx)", pdf: "PDF", md: "Markdown (.md)", pptx: "PowerPoint (.pptx)", html: "Web page (.html)",
    xlsx: "Excel workbook (.xlsx)", csv: "CSV (first sheet)", zip: "Zip of its files (.zip)" };
  // Who made things, by kind: the filter's word, the words of a row with no name, of an empty list, the menu's heading,
  // and the surface the host lists images and videos by.
  const KINDS = { session: { all: "Work", bare: "in Work", none: "made in Work", head: "Work sessions", surface: "work" }, chat: { all: "Chat", bare: "in Chat", none: "made in Chat", head: "Chats", surface: "chat" },
    pip: { all: "Pips", bare: "by a Pip", none: "made by your Pips", head: "Pips", surface: "pip" } };
  const BARE = { app: "by an app", sdk: "by an app", cli: "in the terminal", project: "in a project" };
  const LINKED = new Set(["pip", "session", "chat", "project"]);
  const CHEVRON = '<svg class="dgc-folder-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path class="dgc-folder-chevron-a" d="M4.5 6.5 L8 10"/><path class="dgc-folder-chevron-b" d="M8 10 L11.5 6.5"/></svg>';
  const PIN = (on) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z"/></svg>`;
  const DOTS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/></svg>';
  const PAGE = 200;         // artifacts and widgets drawn at a time ("Show more" draws the next)

  /** How long ago, in a few characters, from a time DGC wrote ("now", "40m", "2h", "1d", "3w", "4mo", "2y"). */
  function age(at, now = Date.now()) {
    if (!at) return "";
    const minutes = Math.floor((now - at) / 60000);
    if (minutes < 1) return "now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
    const days = Math.floor(minutes / 1440);
    if (days < 7) return `${days}d`;
    if (days < 30) return `${Math.floor(days / 7)}w`;
    if (days <= 365) return `${Math.floor(days / 30)}mo`;
    return `${Math.floor(days / 365)}y`;
  }
  const text = (v, n = 200) => (typeof v === "string" ? v.slice(0, n) : "");
  const when = (v) => Date.parse(String(v || "")) || 0;
  const sizeText = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
  const baseName = (path) => String(path || "").split(/[\\/]/).filter(Boolean).pop() || "";
  /** Who made it, as DGC says it (made_by {kind, id, name}); an older DGC says only where (`origin`, `surface`). */
  function makerOf(said, fallback) {
    if (said && typeof said === "object") return { kind: text(said.kind, 24) === "sdk" ? "app" : text(said.kind, 24), id: text(said.id, 128), name: text(said.name, 120) };
    const o = fallback && typeof fallback === "object" ? fallback : {};
    return { kind: { work: "session", chat: "chat", pip: "pip", sdk: "app", cli: "cli" }[o.surface] || "", id: text(o.pip || o.session || o.chat || o.app, 128), name: "" };
  }

  // ---- what a row is: one shape for every kind of thing ---------------------------------------------------------------------
  /** An artifact: its kind's sheet, its title, who made it; `card`: a reply's card or a ChatDGC widget made it. */
  function fromArtifact(a) {
    return { key: `artifact:${a.id}`, source: "artifact", type: String(a.type || ""), made_as: a.made_as === "card" || a.made_as === "widget" ? a.made_as : "", title: text(a.title) || A_KIND[a.type] || "Untitled",
      at: when(a.updated || a.created), by: makerOf(a.made_by, a.origin), verb: "made", facts: [A_KIND[a.type] || String(a.type || ""), `version ${Number(a.version) || 1}`], raw: a };
  }
  /** One of ChatDGC's widgets: it is in a chat, which made it. */
  function fromWidget(w) {
    return { key: `widget:${w.id}`, source: "widget", type: "widget", title: text(w.title) || "Interactive", at: when(w.created_at), by: { kind: "chat", id: text(w.chat_id, 128), name: text(w.chat_title, 120) }, verb: "made",
      facts: ["Interactive", text(w.project_name, 120)], raw: w };
  }
  /** An image DGC made or kept: a kept one has the title the model gave it, a made one the words it was made from. */
  function fromImage(img) {
    const kept = img.kept === true, title = (kept && text(img.title)) || text(img.prompt) || baseName(img.rel || img.path) || "Image";
    const size = Number(img.width) > 0 && Number(img.height) > 0 ? `${Number(img.width)}×${Number(img.height)}` : "";
    return { key: `image:${img.path}`, source: "image", type: "image", title, at: when(img.created_at), by: makerOf(img.made_by, img), verb: kept ? "kept" : "made",
      facts: [size, Number(img.bytes) ? sizeText(Number(img.bytes)) : "", text(img.generator_name, 64), baseName(img.project)], tip: [kept ? text(img.why, 500) : "", baseName(img.rel || img.path)].filter(Boolean).join("\n"), raw: img };
  }
  /** A video DGC made. */
  function fromVideo(v) {
    return { key: `video:${v.path}`, source: "video", type: "video", title: text(v.prompt, 160) || baseName(v.path) || "Video", at: when(v.created_at), by: makerOf(v.made_by, v), verb: "made",
      facts: [v.seconds ? `${Math.round(Number(v.seconds))} s` : "", v.width && v.height ? `${v.width}×${v.height}` : "", v.bytes ? sizeText(Number(v.bytes)) : "", text(v.generator_name, 64)], raw: v };
  }
  /** A file in a chat or a project: it is "in" its chat unless ChatDGC made it. */
  function fromFile(f) {
    const project = f.source === "project";
    const by = project ? { kind: "project", id: text(f.project_id, 128), name: text(f.project_name, 120) } : { kind: "chat", id: text(f.chat_id, 128), name: text(f.chat_title, 120) };
    return { key: `file:${f.id}`, source: "file", type: String(f.type || "file"), title: text(f.name) || "file", at: when(f.created_at), by, verb: f.made === true ? "made" : "in",
      facts: [F_KIND[f.type] || "File", Number(f.size) ? sizeText(Number(f.size)) : "", project ? "" : text(f.project_name, 120)], raw: f };
  }
  /** A row's second line, before the time: [words, the name that leads back or ""]. */
  function byWords(item) {
    const by = item.by;
    if (by.name) return [item.verb === "in" ? "in " : `${item.verb} by `, by.name];
    if (item.verb === "in") return [by.kind === "chat" ? "in a chat" : BARE[by.kind] || "", ""];
    const bare = KINDS[by.kind]?.bare || BARE[by.kind] || "";
    return [bare ? `${item.verb} ${bare}` : "", ""];
  }

  /**
   * Draws the Library into `host` and keeps it up to date.
   *   host:   the element it fills (it becomes .dgc-lib)
   *   place:  "side" (the side bar's tab) or "tab" (its editor tab): said on the element, for the page's own frame
   *   post(message):  to the Library's host (src/chatdgc.ts fromLibrary)
   *   pin(message):   a pin for the dock (dockToggle); `post` when not given
   *   go(maker):      a maker's name was pressed ({ kind: pip|session|chat|project, id, name }); told to the host when not given
   *   more:   the ⋯'s rows [{ id, label, icon }]; onMore(id, tab) when one is chosen
   *   kept(), keep(state): what to keep for a reload (the tab, each tab's filters)
   *   marks:  { mark(kind, id), wear(kind, list), said?(msg) }: the palettes widgets wear (media/shared/marks.js)
   *   level:  the title's heading level (1 in its own tab)
   */
  function mount({ host, place = "side", post, pin, go, more = [], onMore, kept, keep, marks = null, level = 2 }) {
    const doc = host.ownerDocument, view = doc.defaultView;
    const head = root.DgcPageHead ? root.DgcPageHead.html({ title: "Library", level, more: { id: "library-more", label: "More for Library", tip: "More for the Library" } })
      : '<header class="dgc-pagehead"><h2 class="dgc-pagehead-title">Library</h2></header>';
    host.classList.add("dgc-lib"); host.dataset.place = place;
    host.innerHTML = head
      + '<div class="lib-bar"><input id="library-search" class="lib-search" type="search" maxlength="200" autocomplete="off" spellcheck="false"></div>'
      + '<div id="library-tabs" class="lib-tabs" role="tablist" aria-label="Library">'
      + TABS.map(([id, name, , icon, tip]) => `<button type="button" role="tab" id="library-tab-${id}" class="lib-tab" data-tab="${id}" aria-controls="library-list" aria-selected="false" tabindex="-1" title="${esc(tip)}">`
        + `<span class="lib-tab-icon codicon codicon-${icon}" aria-hidden="true"></span><span class="lib-tab-word" data-label="${name}">${name}</span></button>`).join("")
      + "</div>"
      + '<div id="library-filters" class="lib-filters" role="group" aria-label="Show"></div>'
      + '<p id="library-status" class="lib-status" role="status" hidden></p>'
      + '<ul id="library-list" class="lib-list" role="tabpanel"></ul>'
      + '<button type="button" id="library-load" class="lib-load" title="Show more" hidden>Show more</button>';
    const $ = (id) => host.querySelector(`#${id}`);
    const els = { search: $("library-search"), tabs: $("library-tabs"), filters: $("library-filters"), status: $("library-status"), list: $("library-list"), load: $("library-load"), more: $("library-more") };
    // In its own tab the list scrolls inside the page (library.css) and takes the keyboard for that.
    if (place === "tab") els.list.tabIndex = 0;
    const saved = kept?.() || {};
    const savedF = saved.filters && typeof saved.filters === "object" ? saved.filters : {};
    const str = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
    const state = {
      tab: TAB_IDS.includes(saved.tab) ? saved.tab : "artifacts", query: "", shown: PAGE,
      filters: { artifacts: { kind: A_KINDS.some((k) => k[0] === savedF.artifacts?.kind) ? savedF.artifacts.kind : "", maker: str(savedF.artifacts?.maker) }, widgets: { maker: str(savedF.widgets?.maker) },
        images: { maker: str(savedF.images?.maker) }, videos: { maker: str(savedF.videos?.maker) },
        files: { kind: F_KINDS.some((k) => k[0] === savedF.files?.kind) ? savedF.files.kind : "", origin: ORIGINS.some((o) => o[0] === savedF.files?.origin) ? savedF.files.origin : "" } },
      // What this DGC keeps (the host says; until it has, every tab is offered). Files are always.
      offered: { artifacts: true, widgets: true, images: true, videos: true, files: true },
      artifacts: { items: [], loaded: false },
      widgets: { rows: [], next: null, loaded: false, asking: 0, live: true },
      images: { rows: [], next: null, loaded: false, seq: 0, error: "" },
      videos: { rows: [], next: null, loaded: false, seq: 0, error: "" },
      files: { rows: [], next: null, loaded: false, counts: {}, asked: [] },
      error: "",
    };
    // What each tab last asked the host for (its words and filters): shown again unchanged, it is not asked again.
    const sig = { artifacts: null, widgets: null, images: null, videos: null, files: null };
    // Every maker a tab has seen, by name, so the By menu keeps them while one is chosen.
    const seen = { artifacts: new Map(), widgets: new Map(), images: new Map(), videos: new Map() };
    const pics = new Map();      // a picture's data, by row key: "asked", { data } or { error }
    let docked = new Set(), started = false, showing = place === "tab", drawn = [], toTop = false;

    const sendPin = pin || post;
    const goTo = go || ((maker) => post({ type: "maker", maker: { kind: maker.kind, id: maker.id, name: maker.name } }));
    const keepNow = () => keep?.({ tab: state.tab, filters: JSON.parse(JSON.stringify(state.filters)) });
    const menu = (button, label, rows, pick) => {
      if (!root.DgcBlob) return;
      if (button.getAttribute("aria-expanded") === "true") { root.DgcBlob.close(true); return; }
      root.DgcBlob.popup(button, { keyboard: true, label, place: "below", rows, onPick: pick, onClose: () => button.setAttribute("aria-expanded", "false") });
    };

    // ---- who made it: the filter's value, and what the host is asked for ----------------------------------------------------
    const makerKey = (item) => (item.by.id && item.by.name && KINDS[item.by.kind] ? `${item.by.kind}:${item.by.id}` : "");
    const kindOf = (item) => (item.by.kind === "project" ? "chat" : item.by.kind);
    const byMaker = (item, maker) => !maker || (maker.startsWith("kind:") ? kindOf(item) === maker.slice(5) : makerKey(item) === maker);
    /** The surface the host lists by, for a maker: Work, Chat or Pips (a session's images are Work's). */
    const surfaceOf = (maker) => KINDS[maker.startsWith("kind:") ? maker.slice(5) : maker.split(":")[0]]?.surface || "";
    function note(tab, items) { for (const item of items) { const key = makerKey(item); if (key && !seen[tab].has(key)) seen[tab].set(key, { id: key, kind: item.by.kind, name: item.by.name }); } }
    const makerWord = (tab) => { const m = state.filters[tab].maker; return !m ? "Anyone" : m.startsWith("kind:") ? KINDS[m.slice(5)]?.all || "Anyone" : seen[tab].get(m)?.name || "Anyone"; };
    const whoWords = (tab) => { const m = state.filters[tab].maker; return !m ? "" : m.startsWith("kind:") ? KINDS[m.slice(5)]?.none || "" : `made by ${makerWord(tab)}`; };

    // ---- asking the host --------------------------------------------------------------------------------------------------------
    const sigOf = (tab) => JSON.stringify(tab === "artifacts" ? [] : tab === "widgets" ? [state.query, state.widgets.live] : tab === "files" ? [state.query, state.filters.files] : [state.query, surfaceOf(state.filters[tab].maker)]);
    /** Asks the host for the tab's rows: from the top (a new search, a filter, a refresh), or `on` from where it stopped. */
    function ask(tab, on = false) {
      if (!started) { started = true; state.files.asked.push({ offset: 0, sig: JSON.stringify(["", { kind: "", origin: "" }]) }); post({ type: "ready" }); }
      if (!on) sig[tab] = sigOf(tab);
      if (tab === "artifacts" || tab === "widgets") { if (!on || !state.artifacts.loaded) post({ type: "artifactList" }); }
      if (tab === "widgets" && state.widgets.live) { state.widgets.asking = on ? state.widgets.rows.length : 0; post({ type: "widgets", query: state.query, offset: state.widgets.asking }); }
      if (tab === "images" || tab === "videos") {
        const t = state[tab], surface = surfaceOf(state.filters[tab].maker), offset = on ? t.next || 0 : 0;
        t.error = ""; if (on) t.next = null;
        post(tab === "images" ? { type: "workImages", seq: on ? t.seq : ++t.seq, query: state.query, offset, limit: 60, ...(surface ? { surface } : {}) }
          : { type: "videoList", seq: on ? t.seq : ++t.seq, query: state.query, offset, ...(surface ? { surface } : {}) });
      }
      if (tab === "files") {
        const f = state.filters.files, offset = on ? state.files.next || 0 : 0;
        // (The host lists the files with its answer to "ready": that list, still on its way, is not asked for twice.)
        if (!on && state.files.asked.some((a) => a.offset === 0 && a.sig === sigOf("files"))) return;
        if (on) state.files.next = null;
        state.files.asked.push({ offset, sig: sigOf("files") });
        post({ type: "list", query: state.query, kind: f.kind, ...(f.origin ? { origin: f.origin } : {}), offset });
      }
    }
    /** The tab on screen is asked for when what it shows is not what is wanted now (or `force`: made or changed since). */
    function fresh(force = false) {
      if (!showing) return;
      const tab = state.tab;
      if (force || sig[tab] !== sigOf(tab) || (tab === "artifacts" && !state.artifacts.loaded)) ask(tab);
    }

    // ---- the rows of the tab on screen -----------------------------------------------------------------------------------------
    const has = (hay, q) => String(hay || "").toLowerCase().includes(q);
    function rows() {
      const tab = state.tab, q = state.query.toLowerCase(), f = state.filters[tab];
      const found = (item) => !q || has(item.title, q) || has(item.by.name, q);
      const newest = (a, b) => b.at - a.at;        // (made at the same moment, they stay in the host's order)
      if (tab === "artifacts") {
        const all = state.artifacts.items.map(fromArtifact).filter((a) => !a.made_as);
        note("artifacts", all);
        return all.filter((a) => (!f.kind || a.type === f.kind) && byMaker(a, f.maker) && found(a)).sort(newest);
      }
      if (tab === "widgets") {
        // ChatDGC's own widgets are listed by ChatDGC; each is also a Page among the artifacts, which is left out here
        // (it would be the same widget twice) unless this ChatDGC lists none.
        const cards = state.artifacts.items.map(fromArtifact).filter((a) => a.made_as === "card" || (a.made_as === "widget" && !state.widgets.live));
        const all = [...cards, ...(state.widgets.live ? state.widgets.rows.map(fromWidget) : [])];
        note("widgets", all);
        return all.filter((a) => byMaker(a, f.maker) && found(a)).sort(newest);
      }
      if (tab === "images" || tab === "videos") {
        const all = state[tab].rows.map(tab === "images" ? fromImage : fromVideo);
        note(tab, all);
        // (The host found them by their words and their surface; a maker by name is one of that surface's.)
        return all.filter((a) => byMaker(a, f.maker));
      }
      return state.files.rows.map(fromFile);
    }

    // ---- drawing ----------------------------------------------------------------------------------------------------------------
    const tabsOffered = () => TAB_IDS.filter((id) => state.offered[id]);
    function drawTabs() {
      const offered = tabsOffered();
      if (!offered.includes(state.tab)) { state.tab = offered[0] || "files"; state.shown = PAGE; }
      els.tabs.hidden = offered.length < 2;
      for (const tab of els.tabs.children) {
        const id = tab.dataset.tab, on = id === state.tab;
        tab.hidden = !offered.includes(id);
        tab.setAttribute("aria-selected", String(on)); tab.tabIndex = on ? 0 : -1;
      }
      els.list.setAttribute("aria-labelledby", `library-tab-${state.tab}`);
      const noun = TABS.find((t) => t[0] === state.tab)[1].toLowerCase();
      els.search.placeholder = `Search ${noun}`;
      els.search.setAttribute("aria-label", `Search your ${noun}${state.tab === "images" || state.tab === "videos" ? " by the words they were made from" : state.tab === "files" ? " by name" : " by name, or by who made them"}`);
    }
    function drawFilters() {
      const tab = state.tab, f = state.filters[tab];
      // (data-all: a kind or an origin left on All. At the narrowest side bar such a filter is its key alone, "Kind",
      // "From": two buttons that both read "All" would not say which is which.)
      const button = (id, key, value, tip) => `<button type="button" id="library-filter-${id}" class="dgc-folder lib-filter" data-filter="${id}"${id !== "maker" && value === "All" ? ' data-all="1"' : ""} aria-haspopup="menu" aria-expanded="false" aria-label="${esc(`${key}: ${value}`)}" title="${esc(tip)}">`
        + `<span class="dgc-folder-k">${esc(key)}</span><span class="dgc-folder-v">${esc(value)}</span>${CHEVRON}</button>`;
      let html = "";
      if (tab === "artifacts") html += button("kind", "Kind", (A_KINDS.find((k) => k[0] === f.kind) || A_KINDS[0])[1], "Show one kind: pages, sheets, docs, decks or dashboards");
      if (tab === "files") html += button("kind", "Kind", (F_KINDS.find((k) => k[0] === f.kind) || F_KINDS[0])[1], "Show one kind of file")
        + button("origin", "From", (ORIGINS.find((o) => o[0] === f.origin) || ORIGINS[0])[1], "Show the files you uploaded, or the ones ChatDGC made");
      else html += button("maker", "By", makerWord(tab), "Show what one maker made: Work, Chat, your Pips, or one of them by name");
      if (els.filters.__html === html) return;
      const had = doc.activeElement && els.filters.contains(doc.activeElement) ? doc.activeElement.id : "";
      els.filters.__html = html; els.filters.innerHTML = html;
      if (had) doc.getElementById(had)?.focus({ preventScroll: true });
    }
    /** What a row can do, in order: the first is what a click on the row does. */
    function actions(item) {
      const r = item.raw, pinned = (kind, id) => docked.has(`${kind}:${id}`);
      const pinRow = (pinItem) => ({ id: "pin", label: pinned(pinItem.kind, pinItem.id) ? "Unpin from the dock" : "Pin to the dock", pinned: pinned(pinItem.kind, pinItem.id), run: () => sendPin({ type: "dockToggle", item: pinItem }) });
      if (item.source === "artifact") {
        const a = { id: r.id, type: r.type, title: r.title, ...(typeof r.file === "string" ? { file: r.file } : {}) };
        return [{ id: "open", icon: "go-to-file", label: r.type === "doc" ? "Open it in the editor" : "Open it", run: () => post({ type: "artifactOpen", artifact: a }) },
          ...(Array.isArray(r.exports) && r.exports.length ? [{ id: "export", icon: "desktop-download", label: "Download…", formats: r.exports.filter((x) => typeof x === "string") }] : []),
          pinRow({ kind: "artifact", id: String(r.id), title: item.title, sub: item.facts.filter(Boolean).join(" · "), look: { type: String(r.type || "") }, ...(typeof r.file === "string" ? { ref: { file: r.file } } : {}) }),
          { id: "remove", icon: "trash", label: "Remove…", tip: "Remove: it goes to DGC's trash, where it can be recovered", danger: true, run: () => post({ type: "artifactRemove", artifact: r }) }];
      }
      if (item.source === "widget") {
        return [{ id: "open", icon: "play", label: "Open it beside you", run: () => post({ type: "widgetOpen", widget: r }) },
          { id: "chat", icon: "comment-discussion", label: "Open the chat it's in", run: () => post({ type: "widgetChat", widget: r }) },
          pinRow({ kind: "widget", id: String(r.id || ""), title: item.title, sub: `Widget · in “${r.chat_title || "a chat"}”`, ref: { chat_id: String(r.chat_id || "") } }),
          { id: "remove", icon: "trash", label: "Delete the widget…", danger: true, run: () => post({ type: "widgetRemove", widget: r }) }];
      }
      if (item.source === "image") {
        return [{ id: "open", icon: "go-to-file", label: "Open the image", run: () => post({ type: "workImageOpen", path: r.path }) },
          { id: "reveal", icon: "folder-opened", label: "Show it in its folder", run: () => post({ type: "workImageReveal", path: r.path }) },
          { id: "save", icon: "desktop-download", label: "Save a copy…", run: () => post({ type: "workImageSave", path: r.path }) },
          { id: "project", icon: "file-symlink-file", label: "Save to project…", tip: "Save to project… (the folder open in VS Code)", run: () => post({ type: "workImageToProject", path: r.path }) }];
      }
      if (item.source === "video") {
        return [{ id: "open", icon: "play", label: "Play it here", run: (li) => play(li, r) },
          { id: "player", icon: "link-external", label: "Open it in your player", run: () => post({ type: "videoOpen", path: r.path }) },
          { id: "reveal", icon: "folder-opened", label: "Show it in its folder", run: () => post({ type: "videoReveal", path: r.path }) },
          { id: "project", icon: "desktop-download", label: "Save to project…", run: () => post({ type: "videoSave", path: r.path }) }];
      }
      const project = r.source === "project";
      return [{ id: "open", icon: project ? "folder" : "comment-discussion", label: project ? `Open the project ${r.project_name || ""}`.trim() : "Open the chat it's in", run: () => post({ type: "open", file: r }) },
        { id: "use", icon: "comment", label: "Use in a new chat", run: () => post({ type: "use", file: r }) },
        { id: "save", icon: "desktop-download", label: "Save a copy…", run: () => post({ type: "save", file: r }) },
        ...(r.type === "image" ? [{ id: "project", icon: "file-symlink-file", label: "Save to project…", tip: "Save to project… (the folder open in VS Code)", run: () => post({ type: "saveToProject", file: r }) }] : []),
        { id: "add", icon: "new-folder", label: "Add a copy to a project…", run: () => post({ type: "toProject", file: r }) },
        pinRow({ kind: "file", id: String(r.id || ""), title: item.title, sub: [F_KIND[r.type] || "File", project ? `in the project ${r.project_name || ""}`.trim() : `in “${r.chat_title || "a chat"}”`].join(" · "),
          look: { type: String(r.type || "") }, ref: project ? { project_id: String(r.project_id || "") } : { chat_id: String(r.chat_id || "") } }),
        { id: "remove", icon: "trash", label: "Delete from your Library…", danger: true, run: () => post({ type: "remove", file: r }) }];
    }
    /** A video plays in its own row, with the shared player (media/videoPlayer.js). */
    function play(li, v) {
      if (!root.DgcVideo || !li || li.querySelector("figure.made-video")) return;
      li.append(root.DgcVideo.figure({ id: String(v.job || "vid_library"), state: "done", resolution: "", label: v.generator_name,
        result: { path: v.path, poster: v.poster, bytes: v.bytes, seconds: v.seconds, width: v.width, height: v.height, file: baseName(v.path) } }));
    }
    /** Download…: the formats it can be saved as, in the same small menu. */
    function formats(button, item, act) {
      view.setTimeout(() => menu(button, `Download ${item.title} as`, act.formats.map((f) => ({ id: f, label: FORMATS[f] || f.toUpperCase() })), (format) => post({ type: "artifactExport", artifact: item.raw, format })), 0);
    }
    function thumb(item) {
      const box = doc.createElement("span"); box.className = "lib-row-thumb"; box.setAttribute("aria-hidden", "true");
      const picture = item.source === "image" || (item.source === "file" && item.type === "image" && item.raw.source === "chat");
      if (picture) {
        const known = pics.get(item.key);
        if (!known?.error) {
          const img = doc.createElement("img"); img.alt = ""; img.dataset.pic = item.key; img.decoding = "async";
          if (known?.data) img.src = known.data;
          else if (!known) { pics.set(item.key, "asked"); post(item.source === "file" ? { type: "image", file: item.raw } : { type: "workImage", path: item.raw.path }); }
          box.append(img); return box;
        }
      }
      if (item.source === "video" && typeof item.raw.poster_data === "string" && IMAGE_DATA.test(item.raw.poster_data)) {
        const img = doc.createElement("img"); img.alt = ""; img.src = item.raw.poster_data; box.append(img); box.classList.add("lib-row-poster"); return box;
      }
      if (item.source === "widget" && marks) { box.innerHTML = marks.mark("widget", String(item.raw.id || "")); box.classList.add("lib-row-mark"); return box; }
      const sheets = root.DgcFileSheet;
      const html = !sheets || item.source === "video" || item.source === "image" || item.source === "widget" ? ""
        : item.source === "artifact" ? sheets.html(item.type) : sheets.forFile(item.type, item.title);
      if (html) { box.innerHTML = html; box.firstElementChild?.classList.add("dgc-sheet-sm"); box.classList.add("lib-row-sheet"); }
      else { const dot = doc.createElement("span"); dot.className = `codicon codicon-${item.source === "video" ? "device-camera-video" : item.source === "widget" ? "symbol-misc" : item.type === "image" ? "file-media" : "file"}`; box.append(dot); }
      return box;
    }
    function row(item, now) {
      const li = doc.createElement("li"); li.className = "lib-row"; li.tabIndex = 0; li.dataset.key = item.key; li.dataset.type = item.source === "artifact" ? item.type : item.source;
      if (item.source === "widget") li.dataset.widget = String(item.raw.id || "");
      const [words, name] = byWords(item), ago = age(item.at, now), acts = actions(item);
      const facts = item.facts.filter(Boolean);
      li.title = `${item.title}\n${[`${words}${name}`, ago, ...facts].filter(Boolean).join(" · ")}${item.tip ? `\n${item.tip}` : ""}`;
      li.setAttribute("aria-label", `${item.title}, ${words}${name}${ago ? `, ${ago === "now" ? "just now" : `${ago} ago`}` : ""}. ${acts[0].label}.`);
      const main = doc.createElement("span"); main.className = "lib-row-main";
      const title = doc.createElement("span"); title.className = "lib-row-name"; title.textContent = item.title;
      const meta = doc.createElement("span"); meta.className = "lib-row-meta";
      const by = doc.createElement("span"); by.className = "lib-row-by"; by.textContent = words; meta.append(by);
      // (At the narrowest side bar "made by Tile checker" is "by Tile checker" and "made in Work" is "in Work": the
      // name, or the place, is what must stay.)
      if (item.verb === "made" && words.startsWith("made ")) { const pre = doc.createElement("span"); pre.className = "lib-row-pre"; pre.textContent = "made "; by.replaceChildren(pre, words.slice(5)); }
      if (name) {
        // (A link only where there is somewhere to go back to: a Pip's chat, a session, a chat, a project. An app's or
        // the terminal's name is said, no more.)
        const link = item.by.id && LINKED.has(item.by.kind) ? doc.createElement("button") : doc.createElement("span");
        link.className = "lib-row-maker"; link.textContent = name;
        if (link.tagName === "BUTTON") { link.type = "button"; link.dataset.maker = item.key; link.title = { pip: `Open ${name}’s chat`, session: `Open the session “${name}”`, chat: `Open the chat “${name}”`, project: `Open the project ${name}` }[item.by.kind] || name; }
        meta.append(link);
      }
      if (ago) { const t = doc.createElement("span"); t.className = "lib-row-when"; t.textContent = ` · ${ago}`; meta.append(t); }
      if (facts.length) { const t = doc.createElement("span"); t.className = "lib-row-facts"; t.textContent = ` · ${facts.join(" · ")}`; meta.append(t); }
      main.append(title, meta);
      // Where there is room, each thing it can do is a button; where there is not, one ⋯ holds the same list.
      const bar = doc.createElement("span"); bar.className = "lib-row-actions";
      for (const act of acts) {
        const b = doc.createElement("button"); b.type = "button"; b.className = `lib-act${act.id === "pin" ? " lib-pin" : ""}`; b.dataset.act = act.id; b.title = act.tip || act.label; b.setAttribute("aria-label", act.label);
        if (act.id === "pin") { b.setAttribute("aria-pressed", String(!!act.pinned)); b.setAttribute("aria-label", `${act.label}: ${item.title}`); b.innerHTML = PIN(!!act.pinned); }
        else { if (act.formats) { b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false"); } b.innerHTML = `<span class="codicon codicon-${act.icon}" aria-hidden="true"></span>`; }
        bar.append(b);
      }
      const dots = doc.createElement("button"); dots.type = "button"; dots.className = "lib-row-more"; dots.setAttribute("aria-haspopup", "menu"); dots.setAttribute("aria-expanded", "false");
      dots.setAttribute("aria-label", `More for ${item.title}`); dots.title = "More"; dots.innerHTML = DOTS;
      li.append(thumb(item), main, bar, dots);
      return li;
    }
    function statusWords(found) {
      const tab = state.tab, t = state[tab], q = state.query, f = state.filters[tab];
      if (state.error) return state.error;
      if (t.error) return t.error;
      if (found.length) return "";
      const loaded = tab === "artifacts" ? state.artifacts.loaded : tab === "widgets" ? state.artifacts.loaded && (!state.widgets.live || state.widgets.loaded) : t.loaded;
      if (!loaded) return "Loading…";
      const who = tab === "files" ? "" : whoWords(tab);
      if (tab === "artifacts") return q ? `No artifact named like “${q}”${f.kind || f.maker ? " with these filters" : ""}.` : f.kind || f.maker ? `No ${(A_KINDS.find((k) => k[0] === f.kind) || A_KINDS[0])[2]}${who ? ` ${who}` : ""} yet.`
        : "Pages, sheets, docs, decks and dashboards DGC makes for you show here.";
      if (tab === "widgets") return q ? `No widget named like “${q}”.` : who ? `No widgets ${who} yet.` : "Widgets ChatDGC makes for you, and the cards a reply draws, show here.";
      if (tab === "images") return q ? `No image made from words like “${q}”.` : who ? `No images ${who} yet.` : "Images DGC makes or keeps for you show here.";
      if (tab === "videos") return q ? `No video made from words like “${q}”.` : who ? `No videos ${who} yet.` : "Videos DGC makes for you show here.";
      return q ? `No file named like “${q}”.` : f.kind || f.origin ? `No ${(F_KINDS.find((k) => k[0] === f.kind) || F_KINDS[0])[2]}${f.origin === "made" ? " made by ChatDGC" : f.origin === "uploaded" ? " uploaded" : ""} yet.`
        : "Files you attach to chats, and files in your projects, show here. Incognito chats keep none.";
    }
    function draw() {
      drawTabs();
      const tab = state.tab, all = rows();
      // A maker chosen by name that made nothing here any more: back to Anyone.
      const f = state.filters[tab];
      const gone = tab !== "files" && f.maker && !f.maker.startsWith("kind:") && !seen[tab].has(f.maker);
      if (gone && (tab === "artifacts" || tab === "widgets" ? state.artifacts.loaded : state[tab].loaded && sig[tab] === sigOf(tab))) { f.maker = ""; keepNow(); fresh(); return draw(); }
      drawFilters();
      const now = Date.now();
      drawn = tab === "artifacts" || tab === "widgets" ? all.slice(0, state.shown) : all;
      if (tab === "widgets" && marks) marks.wear?.("widget", state.widgets.rows.map((w) => ({ id: String(w.id || "") })));
      const focused = doc.activeElement && els.list.contains(doc.activeElement) ? [doc.activeElement.closest(".lib-row")?.dataset.key, doc.activeElement.dataset?.act || (doc.activeElement.classList.contains("lib-row-more") ? "more" : "")] : null;
      const playing = new Map([...els.list.querySelectorAll(".lib-row")].filter((li) => li.querySelector("figure.made-video")).map((li) => [li.dataset.key, li.querySelector("figure.made-video")]));
      els.list.replaceChildren(...drawn.map((item) => { const li = row(item, now); if (playing.has(item.key)) li.append(playing.get(item.key)); return li; }));
      if (focused?.[0]) { const li = [...els.list.children].find((n) => n.dataset.key === focused[0]); (focused[1] === "more" ? li?.querySelector(".lib-row-more") : focused[1] ? li?.querySelector(`[data-act="${focused[1]}"]`) : li)?.focus({ preventScroll: true }); }
      const say = statusWords(all);
      els.status.textContent = say; els.status.hidden = !say;
      if (state.error || state[tab].error) els.status.dataset.kind = "error"; else delete els.status.dataset.kind;
      const noun = TABS.find((t) => t[0] === tab)[1].toLowerCase();
      els.list.setAttribute("aria-label", `Your ${noun}`);
      els.load.hidden = !(tab === "artifacts" ? all.length > state.shown : tab === "widgets" ? all.length > state.shown || state.widgets.next != null : state[tab].next != null);
      els.load.title = `Show more of your ${noun}`;
      // (An empty list keeps where it was scrolled to, so the first rows of the tab just chosen are what puts it back.)
      if (toTop && els.list.children.length) { els.list.scrollTop = 0; toTop = false; }
    }
    const byKey = (key) => drawn.find((item) => item.key === key);

    // ---- what is pressed ------------------------------------------------------------------------------------------------------
    function show(tab, focus = false) {
      if (!TAB_IDS.includes(tab) || !state.offered[tab]) return;
      const other = tab !== state.tab;
      if (other) { state.tab = tab; state.shown = PAGE; keepNow(); }
      if (other) toTop = true;                 // (another tab starts at its first row)
      draw(); fresh();
      if (focus) doc.getElementById(`library-tab-${tab}`)?.focus({ preventScroll: true });
    }
    els.tabs.addEventListener("click", (e) => { const tab = e.target.closest?.(".lib-tab"); if (tab) show(tab.dataset.tab); });
    els.tabs.addEventListener("keydown", (e) => {
      const offered = tabsOffered(), at = offered.indexOf(state.tab);
      const to = e.key === "ArrowRight" ? offered[(at + 1) % offered.length] : e.key === "ArrowLeft" ? offered[(at - 1 + offered.length) % offered.length] : e.key === "Home" ? offered[0] : e.key === "End" ? offered.at(-1) : "";
      if (!to || e.ctrlKey || e.metaKey || e.altKey) return;
      e.preventDefault(); show(to, true);
    });
    function choose(which, value) {
      state.filters[state.tab][which] = value; state.shown = PAGE;
      keepNow(); draw(); fresh();
      doc.getElementById(`library-filter-${which}`)?.focus({ preventScroll: true });
    }
    els.filters.addEventListener("click", (e) => {
      const button = e.target.closest?.(".lib-filter"); if (!button) return;
      e.stopPropagation();
      const which = button.dataset.filter, tab = state.tab, f = state.filters[tab];
      if (which === "kind" && tab === "artifacts") menu(button, "Kind", A_KINDS.map((k) => ({ id: `v:${k[0]}`, label: k[1], checked: f.kind === k[0] })), (id) => choose("kind", id.slice(2)));
      else if (which === "kind") {
        // The kinds of file there are (the host counts them), and the one chosen.
        const counts = state.files.counts, kinds = F_KINDS.filter((k) => !k[0] || Number(counts[k[0]]) > 0 || f.kind === k[0]);
        menu(button, "Kind of file", kinds.map((k) => ({ id: `v:${k[0]}`, label: k[1], checked: f.kind === k[0] })), (id) => choose("kind", id.slice(2)));
      } else if (which === "origin") menu(button, "From", ORIGINS.map((o) => ({ id: `v:${o[0]}`, label: o[1], checked: f.origin === o[0] })), (id) => choose("origin", id.slice(2)));
      else {
        const makers = [...seen[tab].values()].sort((a, b) => a.name.localeCompare(b.name));
        const list = [{ id: "v:", label: "Anyone", checked: !f.maker }, ...["session", "chat", "pip"].map((k) => ({ id: `v:kind:${k}`, label: KINDS[k].all, checked: f.maker === `kind:${k}` }))];
        for (const k of ["pip", "session", "chat"]) { const named = makers.filter((m) => m.kind === k); if (named.length) list.push({ head: KINDS[k].head }, ...named.map((m) => ({ id: `v:${m.id}`, label: m.name, checked: f.maker === m.id }))); }
        menu(button, "Made by", list, (id) => choose("maker", id.slice(2)));
      }
    });
    function run(item, act, li, button) {
      if (!item || !act) return;
      if (act.formats) formats(button, item, act); else act.run(li);
    }
    els.list.addEventListener("click", (e) => {
      const t = e.target, li = t.closest?.(".lib-row"); if (!li) return;
      const item = byKey(li.dataset.key); if (!item) return;
      if (t.closest(".made-video")) return;                       // the player's own controls
      if (t.closest("[data-maker]")) { e.stopPropagation(); goTo({ ...item.by }); return; }
      const acts = actions(item), button = t.closest("[data-act]");
      if (button) { e.stopPropagation(); run(item, acts.find((a) => a.id === button.dataset.act), li, button); return; }
      const dots = t.closest(".lib-row-more");
      if (dots) {
        e.stopPropagation();
        // (Words only: the small menu has a drawing for some of these and not for others, and a list half with icons reads ragged.)
        menu(dots, `More for ${item.title}`, acts.map((a) => ({ id: a.id, label: a.label, danger: !!a.danger })), (id) => run(item, acts.find((a) => a.id === id), li, dots));
        return;
      }
      acts[0].run(li);
    });
    els.list.addEventListener("keydown", (e) => {
      // The list itself (its editor tab, where it scrolls inside the page): the arrows and the page keys scroll it.
      if (e.target === els.list) {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const page = Math.max(40, els.list.clientHeight - 48);
        const to = { ArrowDown: els.list.scrollTop + 48, ArrowUp: els.list.scrollTop - 48, PageDown: els.list.scrollTop + page, PageUp: els.list.scrollTop - page, " ": els.list.scrollTop + (e.shiftKey ? -page : page), Home: 0, End: els.list.scrollHeight }[e.key];
        if (to !== undefined) { e.preventDefault(); els.list.scrollTop = to; }
        return;
      }
      if (!e.target.matches?.(".lib-row")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); const item = byKey(e.target.dataset.key); if (item) actions(item)[0].run(e.target); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { const next = e.key === "ArrowDown" ? e.target.nextElementSibling : e.target.previousElementSibling; if (next) { e.preventDefault(); next.focus(); } }
    });
    let typing = 0;
    els.search.addEventListener("input", () => {
      view.clearTimeout(typing);
      if (state.tab === "images" || state.tab === "videos") ++state[state.tab].seq;      // an answer on its way is to words since replaced
      typing = view.setTimeout(() => { state.query = els.search.value.trim().slice(0, 200); state.shown = PAGE; draw(); fresh(); }, 250);
    });
    els.load.addEventListener("click", () => {
      const tab = state.tab;
      if (tab === "artifacts") state.shown += PAGE;
      else if (tab === "widgets") { state.shown += PAGE; if (state.widgets.next != null) ask("widgets", true); }
      else ask(tab, true);
      draw();
    });
    els.more?.addEventListener("click", (e) => { e.stopPropagation(); menu(els.more, "Library", more.map((m) => ({ id: m.id, label: m.label, icon: m.icon })), (id) => onMore?.(id, state.tab)); });

    function setPic(key, msg) {
      const ok = typeof msg.data === "string" && IMAGE_DATA.test(msg.data);
      pics.set(key, ok ? { data: msg.data } : { error: true });
      const img = [...els.list.querySelectorAll("img[data-pic]")].find((n) => n.dataset.pic === key);
      if (img && ok) img.src = msg.data; else if (img) draw();
    }
    const offer = (tab, on) => { if (state.offered[tab] === on) return; state.offered[tab] = on; draw(); fresh(); };

    /** What the Library's host said. */
    function message(msg) {
      if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
      const next = (v) => (Number.isInteger(v) ? v : null);
      switch (msg.type) {
        case "dock":
          docked = new Set((Array.isArray(msg.pins) ? msg.pins : []).map((p) => p?.key).filter((k) => typeof k === "string"));
          marks?.said?.(msg);
          if (started) draw();
          return;
        case "artifactsOffered":
          // No artifacts in this DGC: no Artifacts tab. Widgets is ChatDGC's own list and the cards among the
          // artifacts: its tab is there while this DGC keeps either.
          if (msg.on !== true) { state.artifacts.items = []; state.artifacts.loaded = true; }
          offer("artifacts", msg.on === true); offer("widgets", msg.on === true || state.widgets.live);
          return;
        case "widgetsOffered":
          state.widgets.live = msg.on === true;
          if (!state.widgets.live) { state.widgets.rows = []; state.widgets.loaded = true; }
          offer("widgets", state.widgets.live || state.offered.artifacts);
          if (started) { draw(); fresh(); }
          return;
        case "workImagesOffered": if (msg.on !== true) { state.images.rows = []; state.images.loaded = true; } offer("images", msg.on === true); return;
        case "videosOffered": if (msg.on !== true) { state.videos.rows = []; state.videos.loaded = true; } offer("videos", msg.on === true); return;
        case "artifacts":
          state.artifacts.items = (Array.isArray(msg.items) ? msg.items : []).filter((a) => a && ARTIFACT_ID.test(String(a.id || "")));
          state.artifacts.loaded = true; state.error = ""; draw(); return;
        case "artifactRemoved": state.artifacts.items = state.artifacts.items.filter((a) => a.id !== msg.id); draw(); return;
        case "widgets": {
          const found = (Array.isArray(msg.widgets) ? msg.widgets : []).filter((w) => w && typeof w.id === "string");
          state.widgets.rows = state.widgets.asking ? [...state.widgets.rows, ...found.filter((w) => !state.widgets.rows.some((x) => x.id === w.id))] : found;
          state.widgets.next = next(msg.next); state.widgets.loaded = true; draw(); return;
        }
        case "workImages": case "videos": {
          const tab = msg.type === "videos" ? "videos" : "images", t = state[tab];
          if (Number(msg.seq) !== t.seq) return;                // an answer to a search since replaced
          const found = (Array.isArray(tab === "videos" ? msg.videos : msg.images) ? (tab === "videos" ? msg.videos : msg.images) : []).filter((r) => r && typeof r.path === "string");
          t.rows = Number(msg.offset) > 0 ? [...t.rows, ...found.filter((r) => !t.rows.some((x) => x.path === r.path))] : found;
          t.next = next(msg.next); t.loaded = true; t.error = msg.error ? String(msg.error).slice(0, 300) : "";
          draw(); return;
        }
        case "library": {
          const asked = state.files.asked.shift() || { offset: 0, sig: sigOf("files") };
          if (msg.counts && typeof msg.counts === "object" && !state.query) state.files.counts = { ...state.files.counts, ...msg.counts };
          if (asked.sig !== sigOf("files")) return;               // an answer to words or filters since replaced
          const found = (Array.isArray(msg.files) ? msg.files : []).filter((f) => f && typeof f.id === "string");
          state.files.rows = asked.offset ? [...state.files.rows, ...found.filter((f) => !state.files.rows.some((x) => x.id === f.id))] : found;
          state.files.next = next(msg.next); state.files.loaded = true; if (sig.files === null) sig.files = asked.sig;
          draw(); return;
        }
        case "image": setPic(`file:${String(msg.id || "")}`, msg); return;
        case "workImageData": setPic(`image:${String(msg.path || "")}`, msg); return;
        case "view": {
          // Opened on a tab: from Home's cards, a chat's Widgets list, the side bar's "Open the Library in the editor".
          const tab = msg.view === "artifacts-work" ? "artifacts" : String(msg.view || "");
          if (msg.view === "artifacts-work") { state.filters.artifacts.maker = "kind:session"; keepNow(); }
          if (TAB_IDS.includes(tab)) { if (state.offered[tab]) show(tab); else state.tab = tab; }
          return;
        }
        // Made, changed or removed somewhere: every tab is asked again when it next shows, the one on screen now.
        case "artifactChanged": sig.artifacts = sig.widgets = null; if (showing && (state.tab === "artifacts" || state.tab === "widgets")) ask(state.tab); return;
        case "changed": case "refresh": for (const id of TAB_IDS) sig[id] = null; fresh(true); draw(); return;
        case "error":
          // (The host could not answer something the Library asked: said in the status line, the lists left as they are.)
          state.files.asked.length = 0;
          state.error = String(msg.message || "The Library couldn't be read.").slice(0, 300);
          state.artifacts.loaded = state.files.loaded = state.widgets.loaded = true; draw(); state.error = ""; return;
        default: return;
      }
    }
    draw();
    if (showing) fresh();
    return {
      message,
      /** It is on screen: what it shows is asked for again (made, changed or removed since). */
      shown() { showing = true; for (const id of TAB_IDS) sig[id] = null; draw(); fresh(true); },
      hidden() { showing = false; },
      /** Shows one of its tabs (Home's Widgets and Artifacts cards). */
      view(tab) { message({ type: "view", view: tab }); },
      state: () => ({ tab: state.tab, query: state.query, filters: JSON.parse(JSON.stringify(state.filters)) }),
    };
  }

  root.DgcLibrary = Object.freeze({ mount, age, TABS: TAB_IDS });

  // ---- in its own editor tab (the page src/chatdgc.ts serves): the same Library, full width ---------------------------------------
  const page = typeof document !== "undefined" ? document.getElementById("library-root") : null;
  if (page && typeof root.acquireVsCodeApi === "function") {
    const vscode = root.acquireVsCodeApi();
    // A control's `title` shows as DGC's own label, inside the tab (media/shared/tip.js; Work's look, from main.css).
    root.DgcTip?.install({ look: "tip" });
    const state = () => { try { return vscode.getState() || {}; } catch { return {}; } };
    const send = (message) => vscode.postMessage(message);
    // The palette each widget's Folio wears: the host keeps them (src/dock.ts) and says every one in "dock".
    const marks = root.DgcMarks?.keeper(send) || null;
    root.DgcVideo?.host(send);
    const library = mount({ host: page, place: "tab", level: 1, post: send, marks,
      more: [{ id: "settings", label: "Page preview settings", icon: "settings" }], onMore: () => send({ type: "settings", section: "security" }),
      kept: () => state().library, keep: (kept) => { try { vscode.setState({ ...state(), library: kept }); } catch { /* nothing to keep it in */ } } });
    root.addEventListener("message", (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (root.DgcVideo?.message(msg)) return;
      library.message(msg);
    });
  }
})();
