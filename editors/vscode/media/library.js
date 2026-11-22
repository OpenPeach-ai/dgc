// The Library: ONE module for both places it shows (Library v2, 0.52; his words of 15 Nov: "the library tab UX should
// match the Editor Library page"). It draws the whole Library into one element: the header row every page has
// (media/shared/pagehead.js), the search field, the tabs Artifacts · Widgets · Images · Videos · Files, the chosen
// tab's own filter line, and its rows. The side bar's Library tab mounts it narrow (media/main.js); the Library's
// editor tab mounts it wide (the page src/chatdgc.ts serves: this file's last lines). The same code, the same messages
// to the same host (src/chatdgc.ts fromLibrary), so a change reaches both.
//
//   Artifacts  the pages, sheets, docs, decks and dashboards DGC made. Filters: the kind, and who made it.
//   Widgets    ChatDGC's widgets, the cards a reply drew in Work or a Pip's chat, and the charts ChatDGC's replies drew
//              (where this DGC lists them). Filter: who made it.
//   Images     every image DGC made or kept (images_library, every surface: Work, ChatDGC, the Pips). Filter: who.
//   Videos     every video DGC made (videos_library). Filter: who.
//   Files      what you attached in ChatDGC or it made, in every chat and project, and what you attached in Work
//              sessions (where this DGC lists them). Filters: the kind of file, and whether you uploaded it or
//              ChatDGC made it.
//
// Every row says who made it, by name ("made by Tile checker · 2h"; an image the model kept on purpose says "kept by"),
// and the name leads back: a Pip to its chat, a session and a chat to their tabs. A row opens its item. Every item has
// ONE menu, the same in both places, on a right-click, on the row's ⋯ and from the keyboard (Shift+F10, the
// context-menu key): Open · Open in editor · Save a copy… · Copy · Copy path · Reveal in file manager · Rename… ·
// Remove…, then what only its kind has (pin to the dock, use in a new chat, ...). What a kind cannot do is there, off,
// and says why. Each of the eight asks the host one way ("itemAct", naming the item and nothing else): the host does it
// only for an item it listed, from its own record of it. Where there is room a row also keeps its quick icon buttons.
// The search field searches the tab you are on.
// Favorites: every row has a star (an outline, shown when the row is pointed at or holds the keyboard; filled, in the
// accent, and always shown once the item is a favorite), its menu has Add to Favorites / Remove from Favorites, and
// every tab's filter line has Favorites, which shows only the starred, with the search and the other filters. DGC
// keeps the list (one for every kind and every window); the host says it ("favorites") where this DGC keeps one.
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
    ["widgets", "Widgets", "widget", "symbol-misc", "Widgets: ChatDGC's widgets, and the cards a reply drew in Work or a Pip's chat"],
    ["images", "Images", "image", "file-media", "Images: every image DGC made or kept for you"],
    ["videos", "Videos", "video", "device-camera-video", "Videos: every video DGC made for you"],
    ["files", "Files", "file", "files", "Files: what you attached in ChatDGC or it made, in every chat and space. Incognito chats keep none."],
  ];
  const TAB_IDS = TABS.map((t) => t[0]);
  // Artifacts' kinds: the filter's word, and the word of an empty list.
  const A_KINDS = [["", "All", "artifacts"], ["page", "Pages", "pages"], ["sheet", "Sheets", "sheets"], ["doc", "Docs", "docs"], ["slides", "Decks", "decks"], ["dashboard", "Dashboards", "dashboards"]];
  // The Widgets tab's kinds (his call, 16 Nov): the widgets you use again, or the charts a chat's replies drew.
  const W_KINDS = [["", "All", "widgets or charts"], ["widget", "Widgets", "widgets"], ["chart", "Charts", "charts"]];
  const A_KIND = { doc: "Doc", slides: "Deck", sheet: "Sheet", page: "Page", dashboard: "Dashboard" };
  // Files' kinds (ChatDGC's own), and where a file came from.
  const F_KINDS = [["", "All", "files"], ["image", "Images", "images"], ["pdf", "PDFs", "PDFs"], ["document", "Documents", "documents"], ["spreadsheet", "Spreadsheets", "spreadsheets"],
    ["presentation", "Presentations", "presentations"], ["code", "Code", "code files"], ["text", "Pasted text", "pasted text"]];
  const F_KIND = { image: "Image", pdf: "PDF", document: "Document", spreadsheet: "Spreadsheet", presentation: "Presentation", code: "Code", text: "Pasted text" };
  const ORIGINS = [["", "All"], ["uploaded", "Uploaded"], ["made", "Made by ChatDGC"]];
  // Who made things, by kind: the filter's word, the words of a row with no name, of an empty list, the menu's heading,
  // and the surface the host lists images and videos by.
  const KINDS = { session: { all: "Work", bare: "in Work", none: "made in Work", head: "Work sessions", surface: "work" }, chat: { all: "Chat", bare: "in Chat", none: "made in Chat", head: "Chats", surface: "chat" },
    pip: { all: "Pips", bare: "by a Pip", none: "made by your Pips", head: "Pips", surface: "pip" } };
  const BARE = { app: "by an app", sdk: "by an app", cli: "in the terminal", project: "in a project" };
  const LINKED = new Set(["pip", "session", "chat", "project"]);
  const CHEVRON = '<svg class="dgc-folder-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path class="dgc-folder-chevron-a" d="M4.5 6.5 L8 10"/><path class="dgc-folder-chevron-b" d="M8 10 L11.5 6.5"/></svg>';
  // Pin and Unpin, More: the one glyph each has on every surface (media/shared/icons.js).
  const PIN = (on) => window.DgcIcons.html(on ? "unpin" : "pin");
  const DOTS = window.DgcIcons.html("more");
  // A Favorite's star: in outline to add, filled to take off (media/shared/icons.js).
  const STAR = (on) => window.DgcIcons.html(on ? "unfavorite" : "favorite");
  // Which favorites a tab lists page by page, by how the list names them (the artifacts are all listed at once).
  const FAV_PAGED = { widgets: ["widget:", "chart:"], images: ["image:"], videos: ["video:"], files: ["file:", "workfile:"] };
  const FAV_PAGES = 40;     // the most pages a tab reads on its own, looking for its favorites
  const PAGE = 200;         // artifacts and widgets drawn at a time ("Show more" draws the next)
  // An item's menu: the eight things, in his order (15 Nov), the same for every kind.
  // (The first six are every file's, on every surface: media/shared/filemenu.js. A chat's file card has those and no more.)
  const ITEM_ACTS = [...window.DgcFileMenu.ACTS, ["rename", "Rename…"], ["remove", "Remove…"]];
  // What only a kind has, kept under the eight (by the ids of actions() below).
  const ITEM_MORE = ["chat", "player", "use", "project", "add", "pin"];
  const A_WORD = { doc: "doc", slides: "deck", sheet: "sheet", page: "page", dashboard: "dashboard" };
  const SAID_MS = 2600;     // how long "Path copied" stays

  /** Why an item cannot do one of the eight ("" when it can). The host decides again for itself (src/chatdgc.ts
   *  libraryAct): this is only what the menu shows. */
  function whyNot(item, act) {
    const r = item.raw;
    if (item.source === "artifact") {
      const word = A_WORD[r.type] || "artifact", a = /^[aeiou]/.test(word) ? "An" : "A", doc = r.type === "doc", file = doc && typeof r.file === "string" && !!r.file;
      if (act === "editor") return file ? "" : doc ? "This doc has no file to open yet." : `${a} ${word} opens in DGC's own viewer: it has no file an editor can open.`;
      if (act === "save") return Array.isArray(r.exports) && r.exports.length ? "" : `This DGC has no format to save ${a.toLowerCase()} ${word} in.`;
      if (act === "copy") return doc ? "" : `Copy takes a doc's text or an image. Use Save a copy… for ${a.toLowerCase()} ${word}.`;
      if (act === "path" || act === "reveal") return file ? "" : doc ? "This doc has no file yet." : `${a} ${word} is kept inside DGC, not as one file. Save a copy… makes a file.`;
      if (act === "rename") return r.type === "page" ? "A page can't be renamed here yet. Ask DGC to rename it." : "";
      return "";
    }
    if (item.source === "widget") {
      if (act === "editor") return "A widget opens beside its chat: it has no file an editor can open.";
      if (act === "save") return "A widget lives in its chat. Ask ChatDGC to make it a page, then save that.";
      if (act === "copy") return "Copy takes a doc's text or an image. A widget is neither.";
      if (act === "path" || act === "reveal") return "A widget is kept inside its chat, not as a file.";
      if (act === "rename") return "A widget keeps the name its chat gave it.";
      return "";
    }
    if (item.source === "chart") {
      // A chart is drawn in its reply: it opens its chat there, and is nothing else by itself.
      if (act === "editor") return "A chart is drawn in its chat: it has no file an editor can open.";
      if (act === "save") return "A chart is saved from its chat: open it there and use the chart's own Save as image.";
      if (act === "copy") return "Copy takes a doc's text or an image. Open the chart in its chat to copy its numbers.";
      if (act === "path" || act === "reveal") return "A chart is kept inside its chat, not as a file.";
      if (act === "rename") return "A chart keeps the title its reply gave it.";
      if (act === "remove") return "A chart is part of its reply: it goes when its chat is deleted.";
      return "";
    }
    if (item.source === "workfile") {
      // What you attached in a Work session: a picture is kept inside the session, a file is where it was, in its project.
      const picture = r.kind === "image";
      if (act === "editor") return picture ? "This picture is kept inside its session. Open shows it; Save a copy… makes a file." : "";
      if (act === "copy") return picture ? "" : "Copy takes an image or a doc's text. Use Copy path or Save a copy… for this file.";
      if (act === "path" || act === "reveal") return picture ? "This picture is kept inside its session, not as a file. Save a copy… makes a file." : "";
      if (act === "rename") return picture ? "A picture you attached has no name of its own to change." : "This file is your project's: rename it there.";
      if (act === "remove") return "What you attached stays in its session: a session is a record.";
      return "";
    }
    if (item.source === "image") return act === "rename" ? "An image is listed by the words it was made from. Its file keeps its name." : "";
    if (item.source === "video") {
      if (act === "copy") return "A video is too big for the clipboard. Use Copy path or Save a copy….";
      if (act === "rename") return "A video is listed by the words it was made from. Its file keeps its name.";
      return "";
    }
    const where = r.source === "project" ? "project" : "chat";
    if (act === "editor") return `This file is kept inside its ${where}. Save a copy… to open it in an editor.`;
    if (act === "copy") return r.type === "image" && r.source !== "project" ? "" : "Copy takes an image or a doc's text. Use Save a copy… for this file.";
    if (act === "path" || act === "reveal") return `This file is kept inside its ${where}, not on its own. Save a copy… makes a file.`;
    if (act === "rename") return "A file keeps the name it was attached with.";
    return "";
  }
  /** An item as the host is told of it: its kind and its id (or its path), never its title, its content or a file. */
  function refOf(item) {
    const r = item.raw;
    if (item.source === "artifact") return { kind: "artifact", id: String(r.id || "") };
    if (item.source === "widget") return { kind: "widget", id: String(r.id || ""), chat_id: String(r.chat_id || "") };
    if (item.source === "chart") return { kind: "chart", id: String(r.id || ""), chat_id: String(r.chat_id || "") };
    if (item.source === "workfile") return { kind: "workfile", ref: String(r.ref || "") };
    if (item.source === "image" || item.source === "video") return { kind: item.source, path: String(r.path || "") };
    return r.source === "project" ? { kind: "file", id: String(r.id || ""), source: "project", project_id: String(r.project_id || "") } : { kind: "file", id: String(r.id || ""), source: "chat", chat_id: String(r.chat_id || "") };
  }
  /** A picture the host handed over (a data: URI), as a PNG for the clipboard (media/shared/filemenu.js). */
  const pngOf = (doc, data) => window.DgcFileMenu.pngOf(doc, data);

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
      at: when(a.updated || a.created), by: makerOf(a.made_by, a.origin), verb: "made",
      // (A reply's card is a card here, never "Page": listed under Widgets with a Page's name and sheet, it read as an
      // artifact filed in the wrong tab. L2, user test 15 Nov.)
      facts: [a.made_as === "card" ? "A reply’s card" : a.made_as === "widget" ? "Widget" : A_KIND[a.type] || String(a.type || ""), `version ${Number(a.version) || 1}`], raw: a };
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
    // (One you kept with Save to Library says so, and the chat it came from: "saved by you from Painter".)
    return { key: `image:${img.path}`, source: "image", type: "image", title, at: when(img.created_at), by: makerOf(img.made_by, img), verb: kept ? (img.kept_by === "you" ? "saved" : "kept") : "made",
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
  /** A chart a ChatDGC reply drew: it is in that reply, and opens its chat there. */
  function fromChart(c) {
    const kind = { bar: "Bar chart", line: "Line chart", area: "Area chart", pie: "Pie chart", scatter: "Scatter chart" }[String(c.chart_type || "")] || "Chart";
    return { key: `chart:${c.chat_id}:${c.id}`, source: "chart", type: "chart", title: text(c.title) || "Chart", at: when(c.created_at), by: { kind: "chat", id: text(c.chat_id, 128), name: text(c.chat_title, 120) }, verb: "chart",
      facts: [kind, text(c.project_name, 120)], raw: c };
  }
  /** The kind of file a Work attachment is, in the Files filter's words: a picture, or by its name's ending. */
  function workKind(f) {
    if (f.kind === "image") return "image";
    const end = (/\.([A-Za-z0-9]{1,8})$/.exec(String(f.name || ""))?.[1] || "").toLowerCase();
    return end === "pdf" ? "pdf" : ["doc", "docx", "odt", "rtf", "md", "txt"].includes(end) ? "document" : ["xls", "xlsx", "ods", "csv", "tsv"].includes(end) ? "spreadsheet" : ["ppt", "pptx", "odp", "key"].includes(end) ? "presentation" : "code";
  }
  /** Something you attached in a Work session (a picture, or a file you named with @): the host names it by a word
   *  of its own (`ref`), never by where it is kept. */
  function fromWorkFile(f) {
    return { key: `workfile:${f.ref}`, source: "workfile", type: workKind(f), title: text(f.name) || "file", at: when(f.created_at), by: { kind: "session", id: text(f.session_id, 128), name: text(f.session_name, 120) }, verb: "work",
      where: text(f.project_name, 120), facts: [F_KIND[workKind(f)] || "File", Number(f.bytes) ? sizeText(Number(f.bytes)) : ""], raw: f };
  }
  /** A row's second line, before the time: [words, the name that leads back or ""]. */
  function byWords(item) {
    const by = item.by;
    if (item.verb === "chart") return by.name ? ["A chart in ", by.name] : ["A chart in a chat", ""];
    if (item.verb === "work") return by.name ? ["in Work · ", by.name] : ["in Work", ""];
    if (item.verb === "saved") return by.name ? ["saved by you from ", by.name] : ["saved by you", ""];
    if (by.name) return [item.verb === "in" ? "in " : `${item.verb} by `, by.name];
    if (item.verb === "in") return [by.kind === "chat" ? "in a chat" : BARE[by.kind] || "", ""];
    const bare = KINDS[by.kind]?.bare || BARE[by.kind] || "";
    return [bare ? `${item.verb} ${bare}` : "", ""];
  }

  /** A chart's mark: a small tile with the chart's own kind drawn in it (bars, a line, a pie), in the text's colour. */
  /** A chart's mark (media/shared/graph.css, his call of 16 Nov): one Azure, a mark for each kind DGC draws; anything
   *  else wears the bar's. */
  const CHART_KINDS = ["bar", "line", "area", "pie", "scatter"];
  function chartMark(kind) {
    const k = CHART_KINDS.includes(kind) ? kind : "bar";
    return `<span class="graph graph--${k}" data-chart="${k}" aria-hidden="true">${"<i></i>".repeat(8)}</span>`;
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
      + '<div class="lib-said-at"><p id="library-said" class="lib-said" role="status" hidden></p></div>'
      + '<ul id="library-list" class="lib-list" role="tabpanel"></ul>'
      + '<button type="button" id="library-load" class="lib-load" title="Show more" hidden>Show more</button>';
    const $ = (id) => host.querySelector(`#${id}`);
    const els = { search: $("library-search"), tabs: $("library-tabs"), filters: $("library-filters"), status: $("library-status"), list: $("library-list"), load: $("library-load"), more: $("library-more"), said: $("library-said") };
    // In its own tab the list scrolls inside the page (library.css) and takes the keyboard for that.
    if (place === "tab") els.list.tabIndex = 0;
    // What went wrong reading the Library stays over the list: it can be closed (media/shared/dismiss.js).
    root.DgcDismiss?.watch({ root: host, lines: [{ sel: '#library-status[data-kind="error"]', focus: () => els.search }] });
    const saved = kept?.() || {};
    const savedF = saved.filters && typeof saved.filters === "object" ? saved.filters : {};
    const str = (v) => (typeof v === "string" ? v.slice(0, 200) : "");
    const state = {
      tab: TAB_IDS.includes(saved.tab) ? saved.tab : "artifacts", query: "", shown: PAGE,
      filters: { artifacts: { kind: A_KINDS.some((k) => k[0] === savedF.artifacts?.kind) ? savedF.artifacts.kind : "", maker: str(savedF.artifacts?.maker) }, widgets: { kind: W_KINDS.some((k) => k[0] === savedF.widgets?.kind) ? savedF.widgets.kind : "", maker: str(savedF.widgets?.maker) },
        images: { maker: str(savedF.images?.maker) }, videos: { maker: str(savedF.videos?.maker) },
        files: { kind: F_KINDS.some((k) => k[0] === savedF.files?.kind) ? savedF.files.kind : "", origin: ORIGINS.some((o) => o[0] === savedF.files?.origin) ? savedF.files.origin : "" } },
      // What this DGC keeps (the host says; until it has, every tab is offered). Files are always.
      offered: { artifacts: true, widgets: true, images: true, videos: true, files: true },
      artifacts: { items: [], loaded: false },
      widgets: { rows: [], next: null, loaded: false, asking: 0, live: true },
      images: { rows: [], next: null, loaded: false, seq: 0, error: "" },
      videos: { rows: [], next: null, loaded: false, seq: 0, error: "" },
      files: { rows: [], next: null, loaded: false, counts: {}, asked: [] },
      // The charts ChatDGC's replies drew (in Widgets) and what you attached in Work sessions (in Files): listed only
      // by a DGC whose host says it lists them (chartsOffered, workFilesOffered); until then neither is asked for.
      charts: { rows: [], next: null, loaded: false, live: false, asking: 0, sig: null },
      work: { rows: [], next: null, loaded: false, live: false, seq: 0, sig: null },
      // Favorites: whether this DGC keeps them (the host says), the starred items by their row's key, and the tabs
      // showing only those.
      favs: { live: false, keys: new Set(), only: Object.fromEntries(TAB_IDS.map((id) => [id, saved.favorites?.[id] === true])) },
      error: "",
    };
    // (Looking for a tab's favorites past its first page: one page asked for at a time, and so many at most.)
    const favLook = { waiting: false, pages: 0 };
    // What each tab last asked the host for (its words and filters): shown again unchanged, it is not asked again.
    const sig = { artifacts: null, widgets: null, images: null, videos: null, files: null };
    // Every maker a tab has seen, by name, so the By menu keeps them while one is chosen.
    const seen = { artifacts: new Map(), widgets: new Map(), images: new Map(), videos: new Map() };
    const pics = new Map();      // a picture's data, by row key: "asked", { data } or { error }
    let docked = new Set(), started = false, showing = place === "tab", drawn = [], toTop = false;

    const sendPin = pin || post;
    const goTo = go || ((maker) => post({ type: "maker", maker: { kind: maker.kind, id: maker.id, name: maker.name } }));
    const keepNow = () => keep?.({ tab: state.tab, filters: JSON.parse(JSON.stringify(state.filters)), ...(TAB_IDS.some((id) => state.favs.only[id]) ? { favorites: { ...state.favs.only } } : {}) });
    const menu = (button, label, rows, pick) => {
      if (!root.DgcBlob) return;
      if (button.getAttribute("aria-expanded") === "true") { root.DgcBlob.close(true); return; }
      root.DgcBlob.popup(button, { keyboard: true, label, place: "below", rows, onPick: pick, onClose: () => button.setAttribute("aria-expanded", "false") });
    };
    /** What the host (or the Library itself) just did, in a word or two over the list's top, then gone: "Path copied". */
    let saidTimer = 0;
    function say(words) {
      view.clearTimeout(saidTimer);
      els.said.textContent = String(words || "").slice(0, 120); els.said.hidden = !els.said.textContent;
      if (!els.said.hidden) saidTimer = view.setTimeout(() => { els.said.hidden = true; els.said.textContent = ""; }, SAID_MS);
    }

    // ---- favorites ----------------------------------------------------------------------------------------------------------
    const isFav = (item) => state.favs.keys.has(item.key);
    const favOnly = (tab = state.tab) => state.favs.live && state.favs.only[tab] === true;
    /** Stars an item, or takes its star off: shown at once, and asked of the host, whose answer is the list DGC keeps. */
    function toggleFav(item) {
      if (!state.favs.live || !item) return;
      const on = !isFav(item);
      if (on) state.favs.keys.add(item.key); else state.favs.keys.delete(item.key);
      post({ type: "favorite", item: refOf(item), on });
      say(on ? "Added to Favorites" : "Removed from Favorites");
      draw();
    }
    /** With Favorites on, a tab listed a page at a time reads on while one of its favorites is not among its rows yet. */
    function favRead() {
      const tab = state.tab, kinds = FAV_PAGED[tab];
      if (!kinds || !showing || !favOnly(tab) || favLook.waiting || favLook.pages >= FAV_PAGES) return false;
      const more = tab === "widgets" ? state.widgets.next != null || state.charts.next != null : tab === "files" ? state.files.next != null || state.work.next != null : state[tab].next != null;
      if (!more) return false;
      const have = new Set(tab === "widgets" ? [...state.widgets.rows.map((w) => `widget:${w.id}`), ...state.charts.rows.map((c) => `chart:${c.chat_id}:${c.id}`)]
        : tab === "files" ? [...state.files.rows.map((f) => `file:${f.id}`), ...state.work.rows.map((f) => `workfile:${f.ref}`)] : state[tab].rows.map((r) => `${tab === "images" ? "image" : "video"}:${r.path}`));
      if (![...state.favs.keys].some((key) => kinds.some((k) => key.startsWith(k)) && !have.has(key))) return false;
      favLook.waiting = true; favLook.pages += 1;
      ask(tab, true);
      return true;
    }
    const favAgain = () => { favLook.waiting = false; favLook.pages = 0; };

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
    /** The charts ChatDGC's replies drew, for Widgets, and what you attached in Work sessions, for Files (by name: their
     *  kind and "uploaded" are the page's to filter by): asked for with their tab, only of a DGC that lists them. */
    function askCharts(on = false) {
      if (!state.charts.live || (on && state.charts.next == null)) return;
      state.charts.asking = on ? state.charts.next || 0 : 0; if (on) state.charts.next = null; else state.charts.sig = state.query;
      post({ type: "charts", query: state.query, offset: state.charts.asking });
    }
    function askWork(on = false) {
      if (!state.work.live || (on && state.work.next == null)) return;
      const from = on ? state.work.next || 0 : 0; if (on) state.work.next = null; else state.work.sig = state.query;
      post({ type: "workFiles", seq: on ? state.work.seq : ++state.work.seq, query: state.query, offset: from });
    }
    /** Asks the host for the tab's rows: from the top (a new search, a filter, a refresh), or `on` from where it stopped. */
    function ask(tab, on = false) {
      if (!started) { started = true; state.files.asked.push({ offset: 0, sig: JSON.stringify(["", { kind: "", origin: "" }]) }); post({ type: "ready" }); }
      if (!on) sig[tab] = sigOf(tab);
      if (tab === "artifacts" || tab === "widgets") { if (!on || !state.artifacts.loaded) post({ type: "artifactList" }); }
      if (tab === "widgets" && state.widgets.live && (!on || state.widgets.next != null || !state.widgets.loaded)) { state.widgets.asking = on ? state.widgets.rows.length : 0; post({ type: "widgets", query: state.query, offset: state.widgets.asking }); }
      if (tab === "widgets") askCharts(on);
      if (tab === "images" || tab === "videos") {
        const t = state[tab], surface = surfaceOf(state.filters[tab].maker), offset = on ? t.next || 0 : 0;
        t.error = ""; if (on) t.next = null;
        post(tab === "images" ? { type: "workImages", seq: on ? t.seq : ++t.seq, query: state.query, offset, limit: 60, ...(surface ? { surface } : {}) }
          : { type: "videoList", seq: on ? t.seq : ++t.seq, query: state.query, offset, ...(surface ? { surface } : {}) });
      }
      if (tab === "files") {
        const f = state.filters.files, offset = on ? state.files.next || 0 : 0;
        askWork(on);
        // (The host lists the files with its answer to "ready": that list, still on its way, is not asked for twice.)
        if (!on && state.files.asked.some((a) => a.offset === 0 && a.sig === sigOf("files"))) return;
        if (on && state.files.next == null) return;
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
      // (Its charts, or Work's attachments, not yet asked for with these words: a DGC said it lists them after the tab's own list came.)
      else if (tab === "widgets" && state.charts.live && state.charts.sig !== state.query) askCharts();
      else if (tab === "files" && state.work.live && state.work.sig !== state.query) askWork();
    }

    // ---- the rows of the tab on screen -----------------------------------------------------------------------------------------
    const has = (hay, q) => String(hay || "").toLowerCase().includes(q);
    function rows() {
      const tab = state.tab, q = state.query.toLowerCase(), f = state.filters[tab];
      const found = (item) => !q || has(item.title, q) || has(item.by.name, q);
      const newest = (a, b) => b.at - a.at;        // (made at the same moment, they stay in the host's order)
      const only = favOnly(tab), starred = (item) => !only || isFav(item);      // (Favorites, with the words and the other filters)
      if (tab === "artifacts") {
        const all = state.artifacts.items.map(fromArtifact).filter((a) => !a.made_as);
        note("artifacts", all);
        return all.filter((a) => (!f.kind || a.type === f.kind) && byMaker(a, f.maker) && found(a) && starred(a)).sort(newest);
      }
      if (tab === "widgets") {
        // ChatDGC's own widgets are listed by ChatDGC; each is also a Page among the artifacts, which is left out here
        // (it would be the same widget twice) unless this ChatDGC lists none.
        const cards = state.artifacts.items.map(fromArtifact).filter((a) => a.made_as === "card" || (a.made_as === "widget" && !state.widgets.live));
        const all = [...cards, ...(state.widgets.live ? state.widgets.rows.map(fromWidget) : []), ...(state.charts.live ? state.charts.rows.map(fromChart) : [])];
        note("widgets", all);
        const kindOk = (a) => !f.kind || (f.kind === "chart") === (a.source === "chart");
        return all.filter((a) => kindOk(a) && byMaker(a, f.maker) && found(a) && starred(a)).sort(newest);
      }
      if (tab === "images" || tab === "videos") {
        const all = state[tab].rows.map(tab === "images" ? fromImage : fromVideo);
        note(tab, all);
        // (The host found them by their words and their surface; a maker by name is one of that surface's.)
        return all.filter((a) => byMaker(a, f.maker) && starred(a));
      }
      const own = state.files.rows.map(fromFile).filter(starred);
      if (!state.work.live || f.origin === "made") return own;
      // Beside ChatDGC's: what you attached in Work sessions, of the kind chosen; the newest of both first.
      const work = state.work.rows.map(fromWorkFile).filter((w) => (!f.kind || w.type === f.kind) && starred(w));
      return work.length ? [...own, ...work].sort(newest) : own;
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
      // (Files' own label says Work's attachments too, where this DGC lists them.)
      const filesTab = els.tabs.querySelector('[data-tab="files"]'), filesTip = state.work.live ? "Files: what you attached in ChatDGC or in a Work session, and what ChatDGC made, in every chat and space. Incognito chats keep none." : TABS[4][4];
      if (filesTab && filesTab.dataset.said !== filesTip) { filesTab.dataset.said = filesTip; filesTab.title = filesTip; }
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
      // (Kind on Widgets only where this DGC lists charts: with none, every row is a widget.)
      if (tab === "widgets" && state.charts.live) html += button("kind", "Kind", (W_KINDS.find((k) => k[0] === f.kind) || W_KINDS[0])[1], "Show the widgets you use again, or the charts a chat drew");
      if (tab === "files") html += button("kind", "Kind", (F_KINDS.find((k) => k[0] === f.kind) || F_KINDS[0])[1], "Show one kind of file")
        + button("origin", "From", (ORIGINS.find((o) => o[0] === f.origin) || ORIGINS[0])[1], "Show the files you uploaded, or the ones ChatDGC made");
      else html += button("maker", "By", makerWord(tab), "Show what one maker made: Work, Chat, your Pips, or one of them by name");
      // Favorites, on every tab: pressed, the tab shows only what you starred (with the search and the filters before it).
      if (state.favs.live) { const on = favOnly(tab); html += `<button type="button" id="library-filter-fav" class="lib-fav-filter" data-filter="fav" aria-pressed="${on}" aria-label="${on ? "Favorites: showing only your favorites" : "Favorites: show only your favorites"}" title="${on ? "Showing only your favorites. Press to show everything." : "Show only your favorites"}">${STAR(on)}<span class="lib-fav-word">Favorites</span></button>`; }
      if (els.filters.__html === html) return;
      const had = doc.activeElement && els.filters.contains(doc.activeElement) ? doc.activeElement.id : "";
      els.filters.__html = html; els.filters.innerHTML = html;
      if (had) doc.getElementById(had)?.focus({ preventScroll: true });
    }
    /** A row's quick buttons, in order: the first is what a click on the row does. Those that are one of the eight
     *  (open, save, reveal, remove) ask the host the menu's way, itemAct; the rest are what only that kind has. */
    function actions(item) {
      const r = item.raw, pinned = (kind, id) => docked.has(`${kind}:${id}`);
      // (Save a copy… is a download: the host hands this page the file, which saves it on the person's computer and says
      // "Downloaded" beside the row: media/shared/download.js.)
      const ask = (act) => (li) => { if (act === "save") root.DgcDownload?.ask(li?.querySelector?.(".lib-row-more") || doc.activeElement); post({ type: "itemAct", act, item: refOf(item) }); };
      const pinRow = (pinItem) => ({ id: "pin", label: pinned(pinItem.kind, pinItem.id) ? "Unpin from the dock" : "Pin to the dock", pinned: pinned(pinItem.kind, pinItem.id), run: () => sendPin({ type: "dockToggle", item: pinItem }) });
      if (item.source === "artifact") {
        return [{ id: "open", icon: "go-to-file", label: r.type === "doc" ? "Open it in the editor" : "Open it", run: ask("open") },
          ...(Array.isArray(r.exports) && r.exports.length ? [{ id: "save", icon: "save", label: "Save a copy…", run: ask("save") }] : []),
          pinRow({ kind: "artifact", id: String(r.id), title: item.title, sub: item.facts.filter(Boolean).join(" · "), look: { type: String(r.type || "") }, ...(typeof r.file === "string" ? { ref: { file: r.file } } : {}) }),
          { id: "remove", icon: "trash", label: "Remove…", tip: "Remove: it goes to DGC's trash, where it can be recovered", danger: true, run: ask("remove") }];
      }
      if (item.source === "widget") {
        return [{ id: "open", icon: "play", label: "Open it beside you", run: ask("open") },
          { id: "chat", icon: "comment-discussion", label: "Open the chat it's in", run: () => post({ type: "widgetChat", widget: r }) },
          pinRow({ kind: "widget", id: String(r.id || ""), title: item.title, sub: `Widget · in “${r.chat_title || "a chat"}”`, ref: { chat_id: String(r.chat_id || "") } }),
          { id: "remove", icon: "trash", label: "Delete the widget…", danger: true, run: ask("remove") }];
      }
      if (item.source === "chart") return [{ id: "open", icon: "comment-discussion", label: "Open its chat at this chart", run: ask("open") }];
      if (item.source === "workfile") {
        const picture = r.kind === "image";
        return [{ id: "open", icon: "go-to-file", label: picture ? "Open the picture" : "Open it in the editor", run: ask("open") },
          { id: "save", icon: "save", label: "Save a copy…", run: ask("save") },
          ...(picture ? [] : [{ id: "reveal", icon: "folder-opened", label: "Reveal in file manager", run: ask("reveal") }])];
      }
      if (item.source === "image") {
        return [{ id: "open", icon: "go-to-file", label: "Open the image", run: ask("open") },
          { id: "reveal", icon: "folder-opened", label: "Reveal in file manager", run: ask("reveal") },
          { id: "save", icon: "save", label: "Save a copy…", run: ask("save") },
          { id: "project", icon: "file-symlink-file", label: "Save to project…", tip: "Save to project… (the folder open in VS Code)", run: () => post({ type: "workImageToProject", path: r.path }) }];
      }
      if (item.source === "video") {
        return [{ id: "open", icon: "play", label: "Play it here", run: (li) => play(li, r) },
          { id: "player", icon: "link-external", label: "Open it in your player", run: () => post({ type: "videoOpen", path: r.path }) },
          { id: "reveal", icon: "folder-opened", label: "Reveal in file manager", run: ask("reveal") },
          { id: "project", icon: "file-symlink-file", label: "Save to project…", run: () => post({ type: "videoSave", path: r.path }) }];
      }
      const project = r.source === "project";
      return [{ id: "open", icon: project ? "folder" : "comment-discussion", label: project ? `Open the space ${r.project_name || ""}`.trim() : "Open the chat it's in", run: ask("open") },
        { id: "use", icon: "comment", label: "Use in a new chat", run: () => post({ type: "use", file: r }) },
        { id: "save", icon: "save", label: "Save a copy…", run: ask("save") },
        ...(r.type === "image" ? [{ id: "project", icon: "file-symlink-file", label: "Save to project…", tip: "Save to project… (the folder open in VS Code)", run: () => post({ type: "saveToProject", file: r }) }] : []),
        { id: "add", icon: "new-folder", label: "Add a copy to a space…", run: () => post({ type: "toProject", file: r }) },
        pinRow({ kind: "file", id: String(r.id || ""), title: item.title, sub: [F_KIND[r.type] || "File", project ? `in the space ${r.project_name || ""}`.trim() : `in “${r.chat_title || "a chat"}”`].join(" · "),
          look: { type: String(r.type || "") }, ref: project ? { project_id: String(r.project_id || "") } : { chat_id: String(r.chat_id || "") } }),
        { id: "remove", icon: "trash", label: "Delete from your Library…", danger: true, run: ask("remove") }];
    }
    /** A video plays in its own row, with the shared player (media/videoPlayer.js). */
    function play(li, v) {
      if (!root.DgcVideo || !li || li.querySelector("figure.made-video")) return;
      li.append(root.DgcVideo.figure({ id: String(v.job || "vid_library"), state: "done", resolution: "", label: v.generator_name,
        result: { path: v.path, poster: v.poster, bytes: v.bytes, seconds: v.seconds, width: v.width, height: v.height, file: baseName(v.path) } }));
    }
    /** An item's one menu: the eight (what it cannot do is off, with why), then what only its kind has. */
    function itemRows(item) {
      // (What only its kind has, in the order of the row's own icon buttons: where those don't fit, this is where they are.)
      const more = actions(item).filter((a) => ITEM_MORE.includes(a.id));
      return [ITEM_ACTS.map(([id, label]) => { const why = whyNot(item, id); return { id, label, ...(why ? { why } : {}), ...(id === "remove" ? { danger: true } : {}) }; }),
        more.map((a) => ({ id: `more:${a.id}`, label: a.label })),
        // (The star's own row, with the star: the one glyph the row's button and the filter wear.)
        state.favs.live ? [isFav(item) ? { id: "fav", label: "Remove from Favorites", icon: "unfavorite" } : { id: "fav", label: "Add to Favorites", icon: "favorite" }] : []];
    }
    function itemPick(item, li, id) {
      if (id.startsWith("more:")) { const act = actions(item).find((a) => a.id === id.slice(5)); if (act) act.run(li); return; }
      if (id === "fav") { toggleFav(item); return; }
      if (whyNot(item, id)) return;
      // (A video plays in its own row, from the bytes the host hands over: nothing is opened anywhere else.)
      if (id === "open" && item.source === "video") { play(li, item.raw); return; }
      if (id === "save") root.DgcDownload?.ask(li.querySelector(".lib-row-more") || li);
      post({ type: "itemAct", act: id, item: refOf(item) });
    }
    /** Opens it: beside the row's ⋯, or at a point (a right-click). `fromRow`: the keyboard came from the row, and goes back to it. */
    function itemMenu(item, li, { at = null, keyboard = false, fromRow = false } = {}) {
      const dots = li.querySelector(".lib-row-more");
      if (!root.DgcBlob || !dots) return;
      if (!at && dots.getAttribute("aria-expanded") === "true") { root.DgcBlob.close(true); return; }
      root.DgcBlob.popup(dots, { keyboard, label: `More for ${item.title}`, place: "below", rows: itemRows(item), ...(at ? { at } : {}),
        onPick: (id) => itemPick(item, li, id),
        // (Escape puts the keyboard back on what opened the menu, the ⋯: from a row, on the row.)
        onClose: () => { dots.setAttribute("aria-expanded", "false"); if (fromRow && li.isConnected && doc.activeElement === dots) li.focus({ preventScroll: true }); } });
    }
    function thumb(item) {
      const box = doc.createElement("span"); box.className = "lib-row-thumb"; box.setAttribute("aria-hidden", "true");
      if (item.source === "chart") { box.innerHTML = chartMark(item.raw.chart_type); box.classList.add("lib-row-chart"); return box; }
      const picture = item.source === "image" || (item.source === "file" && item.type === "image" && item.raw.source === "chat") || (item.source === "workfile" && item.raw.kind === "image");
      if (picture) {
        const known = pics.get(item.key);
        if (!known?.error) {
          const img = doc.createElement("img"); img.alt = ""; img.dataset.pic = item.key; img.decoding = "async";
          if (known?.data) img.src = known.data;
          else if (!known) { pics.set(item.key, "asked"); post(item.source === "file" ? { type: "image", file: item.raw } : item.source === "workfile" ? { type: "workFilePic", ref: String(item.raw.ref || "") } : { type: "workImage", path: item.raw.path }); }
          box.append(img); return box;
        }
      }
      if (item.source === "video" && typeof item.raw.poster_data === "string" && IMAGE_DATA.test(item.raw.poster_data)) {
        const img = doc.createElement("img"); img.alt = ""; img.src = item.raw.poster_data; box.append(img); box.classList.add("lib-row-poster"); return box;
      }
      if ((item.source === "widget" || item.made_as) && marks) { box.innerHTML = marks.mark("widget", String(item.raw.id || "")); box.classList.add("lib-row-mark"); return box; }
      const sheets = root.DgcFileSheet;
      const html = !sheets || item.source === "video" || item.source === "image" || item.source === "widget" ? ""
        : item.source === "artifact" ? sheets.html(item.type) : item.source === "chart" ? "" : sheets.forFile(item.type, item.title);
      if (html) { box.innerHTML = html; box.firstElementChild?.classList.add("dgc-sheet-sm"); box.classList.add("lib-row-sheet"); }
      else { const dot = doc.createElement("span"); dot.className = `codicon codicon-${item.source === "video" ? "device-camera-video" : item.source === "widget" ? "symbol-misc" : item.type === "image" ? "file-media" : "file"}`; box.append(dot); }
      return box;
    }
    function row(item, now) {
      const li = doc.createElement("li"); li.className = "lib-row"; li.tabIndex = 0; li.dataset.key = item.key; li.dataset.type = item.source === "artifact" ? item.type : item.source;
      if (item.source === "widget") li.dataset.widget = String(item.raw.id || "");
      const [words, name] = byWords(item), ago = age(item.at, now), acts = actions(item);
      const facts = item.facts.filter(Boolean);
      li.setAttribute("aria-label", `${item.title}, ${words}${name}${item.where ? ` · ${item.where}` : ""}${ago ? `, ${ago === "now" ? "just now" : `${ago} ago`}` : ""}${facts.length ? `. ${facts.join(", ")}` : ""}${item.tip ? `. ${item.tip.replace(/\n/g, ". ")}` : ""}.${state.favs.live && isFav(item) ? " A favorite." : ""} ${acts[0].label}.`);
      const main = doc.createElement("span"); main.className = "lib-row-main";
      // (The row has no label of its own: its words are on it. A name too long for its line ends in "…" and says itself
      // whole when pointed at, see nameTip below; what a kept picture is for, and its file's name, are said there too.)
      const title = doc.createElement("span"); title.className = "lib-row-name"; title.textContent = item.title; if (item.tip) title.dataset.more = item.tip;
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
        if (link.tagName === "BUTTON") { link.type = "button"; link.dataset.maker = item.key; link.title = { pip: `Open ${name}’s chat`, session: `Open the session “${name}”`, chat: `Open the chat “${name}”`, project: `Open the space ${name}` }[item.by.kind] || name; }
        meta.append(link);
      }
      // (Where a Work attachment's session is: its project, after the session's name. It gives way first when the line is short.)
      if (item.where) { const t = doc.createElement("span"); t.className = "lib-row-where"; t.textContent = ` · ${item.where}`; meta.append(t); }
      if (ago) { const t = doc.createElement("span"); t.className = "lib-row-when"; t.textContent = ` · ${ago}`; meta.append(t); }
      if (facts.length) { const t = doc.createElement("span"); t.className = "lib-row-facts"; t.textContent = ` · ${facts.join(" · ")}`; meta.append(t); }
      main.append(title, meta);
      // Where there is room, each thing it can do is a button; where there is not, one ⋯ holds the same list.
      const bar = doc.createElement("span"); bar.className = "lib-row-actions";
      for (const act of acts) {
        const b = doc.createElement("button"); b.type = "button"; b.className = `lib-act${act.id === "pin" ? " lib-pin" : ""}`; b.dataset.act = act.id; b.title = act.tip || act.label; b.setAttribute("aria-label", act.label);
        if (act.id === "pin") { b.setAttribute("aria-pressed", String(!!act.pinned)); b.setAttribute("aria-label", `${act.label}: ${item.title}`); b.innerHTML = PIN(!!act.pinned); }
        // (Save a copy is Download: one glyph on every surface, the icon module's own drawing.)
        else if (act.icon === "save" && root.DgcIcons) b.innerHTML = root.DgcIcons.html("save");
        else b.innerHTML = `<span class="codicon codicon-${act.icon}" aria-hidden="true"></span>`;
        bar.append(b);
      }
      const dots = doc.createElement("button"); dots.type = "button"; dots.className = "lib-row-more"; dots.setAttribute("aria-haspopup", "menu"); dots.setAttribute("aria-expanded", "false");
      dots.setAttribute("aria-label", `More for ${item.title}`); dots.title = "More"; dots.innerHTML = DOTS;
      li.append(thumb(item), main, bar, dots);
      // The star, before the row's buttons: a real button with the item's name, pressed while it is a favorite.
      if (state.favs.live) {
        const on = isFav(item), star = doc.createElement("button"); star.type = "button"; star.className = "lib-fav"; star.dataset.fav = "1"; star.setAttribute("aria-pressed", String(on));
        star.setAttribute("aria-label", on ? `Remove ${item.title} from Favorites` : `Add ${item.title} to Favorites`); star.title = on ? "Remove from Favorites" : "Add to Favorites"; star.innerHTML = STAR(on);
        if (on) li.dataset.fav = "1";
        bar.before(star);
      }
      return li;
    }
    function statusWords(found) {
      const tab = state.tab, t = state[tab], q = state.query, f = state.filters[tab];
      if (state.error) return state.error;
      if (t.error) return t.error;
      if (found.length) return "";
      const loaded = tab === "artifacts" ? state.artifacts.loaded : tab === "widgets" ? state.artifacts.loaded && (!state.widgets.live || state.widgets.loaded) && (!state.charts.live || state.charts.loaded)
        : tab === "files" ? t.loaded && (!state.work.live || state.work.loaded) : t.loaded;
      if (!loaded) return "Loading…";
      if (favOnly(tab)) {
        // (Still reading the tab's later pages for a favorite: not "none" yet.)
        if (favLook.waiting) return "Looking for your favorites…";
        const narrowed = tab === "files" ? f.kind || f.origin : f.kind || f.maker;
        return q ? `No favorite named like “${q}”${narrowed ? " with these filters" : ""}.` : narrowed ? "No favorites with these filters." : "No favorites here yet. Star an item to keep it here.";
      }
      const who = tab === "files" ? "" : whoWords(tab);
      if (tab === "artifacts") return q ? `No artifact named like “${q}”${f.kind || f.maker ? " with these filters" : ""}.` : f.kind || f.maker ? `No ${(A_KINDS.find((k) => k[0] === f.kind) || A_KINDS[0])[2]}${who ? ` ${who}` : ""} yet.`
        : "Pages, sheets, docs, decks and dashboards DGC makes for you show here.";
      if (tab === "widgets") return q ? `No ${f.kind === "chart" ? "chart" : "widget"} named like “${q}”${f.kind || f.maker ? " with these filters" : ""}.` : f.kind || who ? `No ${(W_KINDS.find((k) => k[0] === f.kind) || W_KINDS[0])[2]}${who ? ` ${who}` : ""} yet.` : state.charts.live ? "Widgets ChatDGC makes for you, the charts its replies draw, and the cards a reply draws in Work or a Pip’s chat, show here."
        : "Widgets ChatDGC makes for you, and the cards a reply draws in Work or a Pip’s chat, show here. A chart in a chat stays in its chat.";
      if (tab === "images") return q ? `No image made from words like “${q}”.` : who ? `No images ${who} yet.` : "Images DGC makes or keeps for you show here.";
      if (tab === "videos") return q ? `No video made from words like “${q}”.` : who ? `No videos ${who} yet.` : "Videos DGC makes for you show here.";
      return q ? `No file named like “${q}”.` : f.kind || f.origin ? `No ${(F_KINDS.find((k) => k[0] === f.kind) || F_KINDS[0])[2]}${f.origin === "made" ? " made by ChatDGC" : f.origin === "uploaded" ? " uploaded" : ""} yet.`
        : state.work.live ? "Files you attach in ChatDGC or in a Work session, and files in your spaces, show here. Incognito chats keep none."
        : "Files you attach in ChatDGC, and files in your spaces, show here. What you attach in a Work session stays in that session. Incognito chats keep none.";
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
      const focused = doc.activeElement && els.list.contains(doc.activeElement) ? [doc.activeElement.closest(".lib-row")?.dataset.key, doc.activeElement.dataset?.act || (doc.activeElement.classList.contains("lib-row-more") ? "more" : doc.activeElement.classList.contains("lib-fav") ? "fav" : "")] : null;
      const playing = new Map([...els.list.querySelectorAll(".lib-row")].filter((li) => li.querySelector("figure.made-video")).map((li) => [li.dataset.key, li.querySelector("figure.made-video")]));
      els.list.replaceChildren(...drawn.map((item) => { const li = row(item, now); if (playing.has(item.key)) li.append(playing.get(item.key)); return li; }));
      if (focused?.[0]) { const li = [...els.list.children].find((n) => n.dataset.key === focused[0]); (focused[1] === "more" ? li?.querySelector(".lib-row-more") : focused[1] === "fav" ? li?.querySelector(".lib-fav") : focused[1] ? li?.querySelector(`[data-act="${focused[1]}"]`) : li)?.focus({ preventScroll: true }); }
      favRead();
      const say = statusWords(all);
      els.status.textContent = say; els.status.hidden = !say;
      if (state.error || state[tab].error) els.status.dataset.kind = "error"; else delete els.status.dataset.kind;
      const noun = TABS.find((t) => t[0] === tab)[1].toLowerCase();
      els.list.setAttribute("aria-label", `Your ${noun}`);
      els.load.hidden = !(tab === "artifacts" ? all.length > state.shown : tab === "widgets" ? all.length > state.shown || state.widgets.next != null || state.charts.next != null : tab === "files" ? state.files.next != null || state.work.next != null : state[tab].next != null);
      els.load.title = `Show more of your ${noun}`;
      // (An empty list keeps where it was scrolled to, so the first rows of the tab just chosen are what puts it back.)
      if (toTop && els.list.children.length) { els.list.scrollTop = 0; toTop = false; }
    }
    const byKey = (key) => drawn.find((item) => item.key === key);
    /** A name's label, decided as the pointer (or the keyboard) reaches it: the whole name when its line cut it, with
     *  what else is known of it (why a picture was kept, its file's name); none when the name is all there. The label
     *  is the name's own, so it shows against its own row; under the row when there is no room over it (data-tip-under
     *  names what it must clear: the row). */
    function nameTip(e) {
      const name = e.target.closest?.(".lib-row-name"); if (!name || !els.list.contains(name)) return;
      const cut = name.scrollWidth > name.clientWidth + 1, more = name.dataset.more || "";
      const label = cut ? `${name.textContent}${more ? `\n${more}` : ""}` : more;
      if (name.dataset.tipSaid === label) return;        // (said already: the label's own code may have lifted `title` while it shows)
      name.dataset.tipSaid = label;
      if (label) { name.title = label; name.dataset.tipUnder = ".lib-row"; } else name.removeAttribute("title");
    }
    els.list.addEventListener("pointerover", nameTip, true);

    // ---- what is pressed ------------------------------------------------------------------------------------------------------
    function show(tab, focus = false) {
      if (!TAB_IDS.includes(tab) || !state.offered[tab]) return;
      const other = tab !== state.tab;
      if (other) { state.tab = tab; state.shown = PAGE; keepNow(); }
      if (other) { toTop = true; favAgain(); }       // (another tab starts at its first row)
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
      state.filters[state.tab][which] = value; state.shown = PAGE; favAgain();
      keepNow(); draw(); fresh();
      doc.getElementById(`library-filter-${which}`)?.focus({ preventScroll: true });
    }
    els.filters.addEventListener("click", (e) => {
      if (e.target.closest?.(".lib-fav-filter")) {
        // Favorites: only the starred, or everything again. The keyboard stays on the button.
        e.stopPropagation();
        state.favs.only[state.tab] = !favOnly(); state.shown = PAGE; favAgain(); toTop = true;
        keepNow(); draw(); fresh();
        doc.getElementById("library-filter-fav")?.focus({ preventScroll: true });
        return;
      }
      const button = e.target.closest?.(".lib-filter"); if (!button) return;
      e.stopPropagation();
      const which = button.dataset.filter, tab = state.tab, f = state.filters[tab];
      if (which === "kind" && tab === "artifacts") menu(button, "Kind", A_KINDS.map((k) => ({ id: `v:${k[0]}`, label: k[1], checked: f.kind === k[0] })), (id) => choose("kind", id.slice(2)));
      else if (which === "kind" && tab === "widgets") menu(button, "Kind", W_KINDS.map((k) => ({ id: `v:${k[0]}`, label: k[1], checked: f.kind === k[0] })), (id) => choose("kind", id.slice(2)));
      else if (which === "kind") {
        // The kinds of file there are (the host counts them), and the one chosen.
        const work = new Set(state.work.live ? state.work.rows.map(workKind) : []);
        const counts = state.files.counts, kinds = F_KINDS.filter((k) => !k[0] || Number(counts[k[0]]) > 0 || work.has(k[0]) || f.kind === k[0]);
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
      act.run(li);
    }
    els.list.addEventListener("click", (e) => {
      const t = e.target, li = t.closest?.(".lib-row"); if (!li) return;
      const item = byKey(li.dataset.key); if (!item) return;
      if (t.closest(".made-video")) return;                       // the player's own controls
      if (t.closest("[data-maker]")) { e.stopPropagation(); goTo({ ...item.by }); return; }
      if (t.closest(".lib-fav")) { e.stopPropagation(); toggleFav(item); return; }
      const acts = actions(item), button = t.closest("[data-act]");
      if (button) { e.stopPropagation(); run(item, acts.find((a) => a.id === button.dataset.act), li, button); return; }
      const dots = t.closest(".lib-row-more");
      if (dots) {
        e.stopPropagation();
        // (Words only: the small menu has a drawing for some of these and not for others, and a list half with icons reads ragged.)
        itemMenu(item, li, { keyboard: e.detail === 0 });
        return;
      }
      acts[0].run(li);
    });
    // A right-click (or the context-menu key, or Shift+F10) on a row is the row's own menu. Nothing in the Library took
    // it before, so the editor's own Cut · Copy · Paste opened, and its Copy copies selected text: a row has none.
    let keyMenuAt = 0;
    els.list.addEventListener("contextmenu", (e) => {
      const li = e.target.closest?.(".lib-row"); if (!li || e.target.closest(".made-video")) return;
      const item = byKey(li.dataset.key); if (!item) return;
      e.preventDefault();
      // (From the keyboard the event has no pointer: the menu opens beside the row's ⋯, its first row focused. The
      // keydown below has already opened it where the key is one the page hears first.)
      const keys = e.button !== 2 && e.detail === 0;
      if (keys) { if (Date.now() - keyMenuAt > 400) itemMenu(item, li, { keyboard: true, fromRow: !e.target.closest(".lib-row-more, [data-act]") }); return; }
      root.DgcBlob?.close(false);
      itemMenu(item, li, { at: { x: e.clientX, y: e.clientY } });
    });
    // The rest of the Library has no menu of its own: no dead Cut · Copy · Paste there either. A field you type in,
    // and words you have selected, keep the editor's.
    host.addEventListener("contextmenu", (e) => {
      if (e.defaultPrevented || e.target.closest?.("input, textarea, [contenteditable], .made-video")) return;
      if (String(view.getSelection?.() || "")) return;
      e.preventDefault();
    });
    els.list.addEventListener("keydown", (e) => {
      const menuKey = e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey);
      if (menuKey) {
        const li = e.target.closest?.(".lib-row"), item = li && byKey(li.dataset.key);
        if (item && !e.target.closest(".made-video")) { e.preventDefault(); e.stopPropagation(); keyMenuAt = Date.now(); root.DgcBlob?.close(false); itemMenu(item, li, { keyboard: true, fromRow: e.target === li }); }
        return;
      }
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
      typing = view.setTimeout(() => { state.query = els.search.value.trim().slice(0, 200); state.shown = PAGE; favAgain(); draw(); fresh(); }, 250);
    });
    els.load.addEventListener("click", () => {
      const tab = state.tab;
      if (tab === "artifacts") state.shown += PAGE;
      else if (tab === "widgets") { state.shown += PAGE; if (state.widgets.next != null || state.charts.next != null) ask("widgets", true); }
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
        case "favorites": {
          // What DGC keeps starred, by each row's key ("artifact:<id>", "image:<path>", ...); `offered` false (or a
          // host that never says this): this DGC keeps no favorites, and there is no star and no filter.
          const live = msg.offered === true;
          state.favs.live = live;
          state.favs.keys = new Set(live ? (Array.isArray(msg.keys) ? msg.keys : []).filter((k) => typeof k === "string" && k.length <= 4200).slice(0, 5000) : []);
          if (started) draw();
          return;
        }
        case "artifactsOffered":
          // No artifacts in this DGC: no Artifacts tab. Widgets is ChatDGC's own list and the cards among the
          // artifacts: its tab is there while this DGC keeps either.
          if (msg.on !== true) { state.artifacts.items = []; state.artifacts.loaded = true; }
          offer("artifacts", msg.on === true); offer("widgets", msg.on === true || state.widgets.live || state.charts.live);
          return;
        case "widgetsOffered":
          state.widgets.live = msg.on === true;
          if (!state.widgets.live) { state.widgets.rows = []; state.widgets.loaded = true; }
          offer("widgets", state.widgets.live || state.offered.artifacts || state.charts.live);
          if (started) { draw(); fresh(); }
          return;
        case "chartsOffered": case "workFilesOffered": {
          // This DGC lists them (or no longer does): the tab on screen is asked again, with them.
          const t = msg.type === "chartsOffered" ? state.charts : state.work, on = msg.on === true;
          if (t.live === on) return;
          t.live = on; if (!on) { t.rows = []; t.next = null; t.loaded = false; }
          if (msg.type === "chartsOffered") offer("widgets", state.widgets.live || state.offered.artifacts || on);
          if (started) draw();
          // (Listed from now: the tab on screen is asked for them, and only for them.)
          t.sig = null; if (started) fresh();
          return;
        }
        case "charts": {
          if (!state.charts.live) return;
          const found = (Array.isArray(msg.charts) ? msg.charts : []).filter((c) => c && typeof c.id === "string" && typeof c.chat_id === "string");
          state.charts.rows = Number(msg.offset) > 0 ? [...state.charts.rows, ...found.filter((c) => !state.charts.rows.some((x) => x.id === c.id && x.chat_id === c.chat_id))] : found;
          state.charts.next = next(msg.next); state.charts.loaded = true; favLook.waiting = false; draw(); return;
        }
        case "workFiles": {
          if (!state.work.live || Number(msg.seq) !== state.work.seq) return;        // an answer to a search since replaced
          const found = (Array.isArray(msg.files) ? msg.files : []).filter((f) => f && typeof f.ref === "string" && f.ref);
          state.work.rows = Number(msg.offset) > 0 ? [...state.work.rows, ...found.filter((f) => !state.work.rows.some((x) => x.ref === f.ref))] : found;
          state.work.next = next(msg.next); state.work.loaded = true; favLook.waiting = false; draw(); return;
        }
        case "workFileData": setPic(`workfile:${String(msg.ref || "")}`, msg); return;
        case "workImagesOffered": if (msg.on !== true) { state.images.rows = []; state.images.loaded = true; } offer("images", msg.on === true); return;
        case "videosOffered": if (msg.on !== true) { state.videos.rows = []; state.videos.loaded = true; } offer("videos", msg.on === true); return;
        case "artifacts":
          state.artifacts.items = (Array.isArray(msg.items) ? msg.items : []).filter((a) => a && ARTIFACT_ID.test(String(a.id || "")));
          state.artifacts.loaded = true; state.error = ""; draw(); return;
        case "artifactRemoved": state.artifacts.items = state.artifacts.items.filter((a) => a.id !== msg.id); draw(); return;
        case "widgets": {
          const found = (Array.isArray(msg.widgets) ? msg.widgets : []).filter((w) => w && typeof w.id === "string");
          state.widgets.rows = state.widgets.asking ? [...state.widgets.rows, ...found.filter((w) => !state.widgets.rows.some((x) => x.id === w.id))] : found;
          state.widgets.next = next(msg.next); state.widgets.loaded = true; favLook.waiting = false; draw(); return;
        }
        case "workImages": case "videos": {
          const tab = msg.type === "videos" ? "videos" : "images", t = state[tab];
          if (Number(msg.seq) !== t.seq) return;                // an answer to a search since replaced
          const found = (Array.isArray(tab === "videos" ? msg.videos : msg.images) ? (tab === "videos" ? msg.videos : msg.images) : []).filter((r) => r && typeof r.path === "string");
          t.rows = Number(msg.offset) > 0 ? [...t.rows, ...found.filter((r) => !t.rows.some((x) => x.path === r.path))] : found;
          t.next = next(msg.next); t.loaded = true; t.error = msg.error ? String(msg.error).slice(0, 300) : "";
          favLook.waiting = false; draw(); return;
        }
        case "library": {
          const asked = state.files.asked.shift() || { offset: 0, sig: sigOf("files") };
          if (msg.counts && typeof msg.counts === "object" && !state.query) state.files.counts = { ...state.files.counts, ...msg.counts };
          if (asked.sig !== sigOf("files")) return;               // an answer to words or filters since replaced
          const found = (Array.isArray(msg.files) ? msg.files : []).filter((f) => f && typeof f.id === "string");
          state.files.rows = asked.offset ? [...state.files.rows, ...found.filter((f) => !state.files.rows.some((x) => x.id === f.id))] : found;
          state.files.next = next(msg.next); state.files.loaded = true; if (sig.files === null) sig.files = asked.sig;
          favLook.waiting = false; draw(); return;
        }
        case "itemSaid": say(msg.words); return;
        case "itemCopy": {
          // Copy: the host read the item's own picture and hands it over; the clipboard is the page's to write.
          const ok = typeof msg.data === "string" && IMAGE_DATA.test(msg.data) && !!view.navigator?.clipboard?.write && typeof view.ClipboardItem === "function";
          const done = (good) => { if (good) say("Image copied"); post({ type: "itemCopied", ok: good }); };
          if (!ok) { done(false); return; }
          pngOf(doc, msg.data).then((blob) => view.navigator.clipboard.write([new view.ClipboardItem({ "image/png": blob })])).then(() => done(true), () => done(false));
          return;
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
        case "changed": case "refresh": for (const id of TAB_IDS) sig[id] = null; state.charts.sig = state.work.sig = null; favAgain(); fresh(true); draw(); return;
        case "error":
          // (The host could not answer something the Library asked: said in the status line, the lists left as they are.)
          state.files.asked.length = 0; favLook.waiting = false;
          state.error = String(msg.message || "The Library couldn't be read.").slice(0, 300);
          state.artifacts.loaded = state.files.loaded = state.widgets.loaded = state.charts.loaded = state.work.loaded = true; draw(); state.error = ""; return;
        default: return;
      }
    }
    draw();
    if (showing) fresh();
    return {
      message,
      /** It is on screen: what it shows is asked for again (made, changed or removed since). */
      shown() { showing = true; for (const id of TAB_IDS) sig[id] = null; state.charts.sig = state.work.sig = null; favAgain(); if (started && state.favs.live) post({ type: "favorites" }); draw(); fresh(true); },
      hidden() { showing = false; },
      /** Shows one of its tabs (Home's Widgets and Artifacts cards). */
      view(tab) { message({ type: "view", view: tab }); },
      state: () => ({ tab: state.tab, query: state.query, filters: JSON.parse(JSON.stringify(state.filters)), ...(TAB_IDS.some((id) => state.favs.only[id]) ? { favorites: { ...state.favs.only } } : {}) }),
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
