// The Library, in the side bar (0.52, his calls of 15 Nov): the fifth tab's page. One list of everything DGC keeps for
// you, wherever it was made: the pages, sheets, docs, decks and dashboards (artifacts), the pictures, and the files in
// your chats. Each row says who made it, by name ("made by Tile checker · 2h"), and the name leads back to that Pip's
// chat, that Work session or that chat. One filter line: the type (All, Pages, Sheets, Docs, Decks, Dashboards,
// Widgets, Images, Files) and the maker (Anyone, Work, Chat, Pips, then each Pip, session and chat by name). A row
// opens its item in an editor tab, where there is room to view and edit it; the big grid stays in its own tab ("Open
// the full Library", under the page's ⋯).
//
// It asks the Library's own host (src/chatdgc.ts, through "sideLibrary") with the messages the full Library's page
// sends, so both list the same things. The page (media/main.js) owns the header row, the search field and the ⋯; this
// draws the filter line and the rows into them. media/shared/librarypage.css is how it looks. A classic script:
// window.DgcLibraryPage.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcLibraryPage) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const IMAGE_DATA = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
  const ARTIFACT_ID = /^ar_[a-f0-9]{16}$/;
  // The type filter, in his order. A Widget is a Page that a reply's card or a ChatDGC widget made.
  const TYPES = [["", "All", "Nothing"], ["page", "Pages", "pages"], ["sheet", "Sheets", "sheets"], ["doc", "Docs", "docs"], ["slides", "Decks", "decks"],
    ["dashboard", "Dashboards", "dashboards"], ["widget", "Widgets", "widgets"], ["image", "Images", "images"], ["file", "Files", "files"]];
  // Who made things, by kind: the filter's word, the words of a row with no name, and of an empty list.
  const KINDS = { session: { all: "Work", bare: "made in Work", none: "made in Work", head: "Work sessions" }, chat: { all: "Chat", bare: "made in Chat", none: "made in Chat", head: "Chats" },
    pip: { all: "Pips", bare: "made by a Pip", none: "made by your Pips", head: "Pips" } };
  const BARE = { app: "made by an app", cli: "made in the terminal", project: "in a project" };
  const LINKED = new Set(["pip", "session", "chat", "project"]);
  const CHEVRON = '<svg class="dgc-folder-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path class="dgc-folder-chevron-a" d="M4.5 6.5 L8 10"/><path class="dgc-folder-chevron-b" d="M8 10 L11.5 6.5"/></svg>';
  const PAGE = 80;          // rows drawn at a time ("Show more" draws the next)
  const MOST = 600;         // files and pictures read from the host before "Show more" is asked to fetch on

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

  /** An artifact as a row: its type, whether a widget or a card made it, and who made it (the view's made_by; an
   *  older DGC says only where, in `origin`). */
  function fromArtifact(a) {
    const o = a.origin && typeof a.origin === "object" ? a.origin : {};
    const said = a.made_by && typeof a.made_by === "object" ? a.made_by : null;
    const by = said ? { kind: text(said.kind, 24), id: text(said.id, 128), name: text(said.name, 120) }
      : { kind: { work: "session", chat: "chat", pip: "pip", sdk: "app", cli: "cli" }[o.surface] || "", id: text(o.pip || o.session || o.chat || o.app, 128), name: "" };
    return { key: `artifact:${a.id}`, source: "artifact", type: String(a.type || ""), widget: a.made_as === "card" || a.made_as === "widget", title: text(a.title) || "Untitled",
      at: when(a.updated || a.created), by, made: true, raw: a };
  }
  /** A file in a chat or a project: a picture is an Image, anything else a File; it is "in" its chat unless ChatDGC made it. */
  function fromFile(f) {
    const project = f.source === "project";
    const by = project ? { kind: "project", id: text(f.project_id, 128), name: text(f.project_name, 120) } : { kind: "chat", id: text(f.chat_id, 128), name: text(f.chat_title, 120) };
    return { key: `file:${f.id}`, source: "file", type: f.type === "image" ? "image" : "file", widget: false, title: text(f.name) || "file", at: when(f.created_at), by, made: f.made === true, raw: f };
  }
  /** A picture made in Work: a file in the project. (DGC does not say which session made it.) */
  function fromImage(img) {
    const name = String(img.rel || img.path || "image").split(/[\\/]/).pop() || "image";
    return { key: `image:${img.path}`, source: "image", type: "image", widget: false, title: name.slice(0, 200), at: when(img.created_at), by: { kind: "session", id: "", name: "" }, made: true, raw: img,
      tip: text(img.prompt, 500) };
  }
  /** A row's second line, before the time: [words, the name that links back or ""]. */
  function byWords(item) {
    const by = item.by;
    if (by.name) return [item.made ? "made by " : "in ", by.name];
    return [(item.made ? KINDS[by.kind]?.bare || BARE[by.kind] : by.kind === "chat" ? "in a chat" : BARE[by.kind]) || "", ""];
  }

  /**
   * Draws the Library into the page's own elements.
   *   els:   { filters, status, list, more, search }
   *   post(message): to the Library's host
   *   go(maker):     the maker's name was pressed ({ kind: pip|session|chat|project, id, name })
   *   kept(), keep({ type, maker }): the filters, for a reload
   *   menu(button, label, rows, pick): the page's own small menu
   *   sheet(type, name): a type's sheet as HTML ("" when the page has none)
   */
  function mount({ els, post, go, kept, keep, menu, sheet }) {
    const doc = els.list.ownerDocument, view = doc.defaultView;
    const saved = kept?.() || {};
    const state = { type: TYPES.some((t) => t[0] === saved.type) ? saved.type : "", maker: typeof saved.maker === "string" ? saved.maker.slice(0, 200) : "", query: "",
      artifacts: [], files: [], images: [], offered: true, loaded: { artifacts: false, files: false, images: false }, error: "", shown: PAGE, filesNext: null, imagesNext: null };
    const pics = new Map();      // a picture's data, by row key: "asked", { data } or { error }
    const asked = [];            // the offsets of the file pages asked for, in order (the host's answer names none)
    let seq = 0, started = false, makers = [];

    const ask = () => {
      asked.push(0); post({ type: started ? "list" : "ready" }); started = true;
      post({ type: "artifactList" });
      post({ type: "workImages", seq: ++seq, offset: 0, limit: 60 });
    };
    const items = () => [...state.artifacts.map(fromArtifact), ...state.files.map(fromFile), ...state.images.map(fromImage)].sort((a, b) => b.at - a.at || (a.key < b.key ? -1 : 1));
    const makerOf = (item) => (item.by.id && item.by.name && KINDS[item.by.kind] ? `${item.by.kind}:${item.by.id}` : "");
    const kindOf = (item) => (item.by.kind === "project" ? "chat" : item.by.kind);
    const matches = (item) => {
      if (state.type && !(state.type === "widget" ? item.widget : item.type === state.type)) return false;
      if (state.maker && !(state.maker.startsWith("kind:") ? kindOf(item) === state.maker.slice(5) : makerOf(item) === state.maker)) return false;
      if (state.query) { const q = state.query.toLowerCase(); if (!item.title.toLowerCase().includes(q) && !item.by.name.toLowerCase().includes(q)) return false; }
      return true;
    };
    /** Every maker with a name, by kind, each kind's by name. */
    function listMakers(all) {
      const seen = new Map();
      for (const item of all) { const id = makerOf(item); if (id && !seen.has(id)) seen.set(id, { id, kind: item.by.kind, name: item.by.name }); }
      return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
    }
    const makerWord = () => (state.maker ? state.maker.startsWith("kind:") ? KINDS[state.maker.slice(5)]?.all || "Anyone" : makers.find((m) => m.id === state.maker)?.name || "Anyone" : "Anyone");

    function drawFilters() {
      const type = TYPES.find((t) => t[0] === state.type) || TYPES[0], who = makerWord();
      const button = (id, key, value, tip) => `<button type="button" id="${id}" class="dgc-folder lib-filter" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(`${key}: ${value}`)}" title="${esc(tip)}">`
        + `<span class="dgc-folder-k">${esc(key)}</span><span class="dgc-folder-v">${esc(value)}</span>${CHEVRON}</button>`;
      const html = button("library-type", "Type", type[1], "Show one type: pages, sheets, docs, decks, dashboards, widgets, images or files") + button("library-maker", "By", who, "Show what one maker made: Work, Chat, your Pips, or one of them by name");
      if (els.filters.__html !== html) {
        const had = doc.activeElement && els.filters.contains(doc.activeElement) ? doc.activeElement.id : "";
        els.filters.__html = html; els.filters.innerHTML = html;
        if (had) doc.getElementById(had)?.focus({ preventScroll: true });
      }
    }
    function thumb(item) {
      const box = doc.createElement("span"); box.className = "lib-row-thumb"; box.setAttribute("aria-hidden", "true");
      if (item.type === "image" && !(item.source === "file" && item.raw.source !== "chat")) {
        const known = pics.get(item.key);
        if (!known?.error) {
          const img = doc.createElement("img"); img.alt = ""; img.dataset.pic = item.key; img.decoding = "async";
          if (known?.data) img.src = known.data;
          else if (!known) { pics.set(item.key, "asked"); post(item.source === "file" ? { type: "image", file: item.raw } : { type: "workImage", path: item.raw.path }); }
          box.append(img); return box;
        }
      }
      const html = sheet?.(item.source === "artifact" ? item.type : item.raw.type || "file", item.source === "artifact" ? "" : item.title) || "";
      if (html) { box.innerHTML = html; box.firstElementChild?.classList.add("dgc-sheet-sm"); box.classList.add("lib-row-sheet"); }
      else { const dot = doc.createElement("span"); dot.className = `codicon codicon-${item.type === "image" ? "file-media" : "file"}`; box.append(dot); }
      return box;
    }
    function row(item, now) {
      const li = doc.createElement("li"); li.className = "lib-row"; li.tabIndex = 0; li.dataset.key = item.key; li.dataset.type = item.widget ? "widget" : item.type;
      const [words, name] = byWords(item), ago = age(item.at, now);
      const kind = TYPES.find((t) => t[0] === (item.widget ? "widget" : item.type))?.[1].replace(/s$/, "") || "Item";
      li.title = `${item.title}\n${kind} · ${words}${name}${ago ? ` · ${ago}` : ""}${item.tip ? `\n${item.tip}` : ""}`;
      li.setAttribute("aria-label", `${item.title}, ${kind.toLowerCase()}, ${words}${name}${ago ? `, ${ago} ago` : ""}. Opens in an editor tab.`);
      const main = doc.createElement("span"); main.className = "lib-row-main";
      const title = doc.createElement("span"); title.className = "lib-row-name"; title.textContent = item.title;
      const meta = doc.createElement("span"); meta.className = "lib-row-meta";
      const by = doc.createElement("span"); by.className = "lib-row-by"; by.textContent = words; meta.append(by);
      if (name) {
        // (A link only where there is somewhere to go back to: a Pip's chat, a session, a chat, a project. An app's or
        // the terminal's name is said, no more.)
        const link = item.by.id && go && LINKED.has(item.by.kind) ? doc.createElement("button") : doc.createElement("span");
        link.className = "lib-row-maker"; link.textContent = name;
        if (link.tagName === "BUTTON") { link.type = "button"; link.dataset.maker = item.key; link.title = { pip: `Open ${name}’s chat`, session: `Open the session “${name}”`, chat: `Open the chat “${name}”`, project: `Open the project ${name}` }[item.by.kind] || name; }
        meta.append(link);
      }
      if (ago) { const t = doc.createElement("span"); t.className = "lib-row-when"; t.textContent = ` · ${ago}`; meta.append(t); }
      main.append(title, meta); li.append(thumb(item), main);
      return li;
    }
    let drawn = [];
    function draw() {
      const all = items(); makers = listMakers(all);
      if (state.maker && !state.maker.startsWith("kind:") && !makers.some((m) => m.id === state.maker) && state.loaded.artifacts && state.loaded.files) { state.maker = ""; keep?.({ type: state.type, maker: "" }); }
      drawFilters();
      const found = all.filter(matches), now = Date.now();
      drawn = found.slice(0, state.shown);
      const focused = doc.activeElement && els.list.contains(doc.activeElement) ? doc.activeElement.closest(".lib-row")?.dataset.key : "";
      els.list.replaceChildren(...drawn.map((item) => row(item, now)));
      if (focused) [...els.list.children].find((n) => n.dataset.key === focused)?.focus({ preventScroll: true });
      const loading = !(state.loaded.artifacts && state.loaded.files);
      const type = TYPES.find((t) => t[0] === state.type) || TYPES[0];
      const who = !state.maker ? "" : state.maker.startsWith("kind:") ? KINDS[state.maker.slice(5)]?.none || "" : `made by ${makerWord()}`;
      const say = state.error ? state.error : found.length ? "" : loading ? "Loading your Library…"
        : state.query ? `Nothing named like “${state.query}”${state.type || state.maker ? " with these filters" : ""}.`
        : state.type || state.maker ? `${state.type ? `No ${type[2]}` : "Nothing"}${who ? ` ${who}` : ""} yet.`
        : "Nothing here yet. What DGC makes for you in Work, Chat and your Pips is kept here.";
      els.status.textContent = say; els.status.hidden = !say;
      if (state.error) els.status.dataset.kind = "error"; else delete els.status.dataset.kind;
      const more = found.length > state.shown || state.filesNext != null || state.imagesNext != null;
      els.more.hidden = !more || !found.length && !(state.filesNext != null || state.imagesNext != null);
    }
    const byKey = (key) => drawn.find((item) => item.key === key);
    function open(item) {
      if (!item) return;
      if (item.source === "artifact") post({ type: "artifactOpen", artifact: { id: item.raw.id, type: item.raw.type, title: item.raw.title, ...(typeof item.raw.file === "string" ? { file: item.raw.file } : {}) } });
      else if (item.source === "image") post({ type: "workImageOpen", path: item.raw.path });
      else post({ type: "open", file: item.raw });
    }
    els.list.addEventListener("click", (e) => {
      const maker = e.target.closest?.("[data-maker]");
      if (maker) { e.stopPropagation(); const item = byKey(maker.dataset.maker); if (item) go?.({ ...item.by }); return; }
      const li = e.target.closest?.(".lib-row"); if (li) open(byKey(li.dataset.key));
    });
    els.list.addEventListener("keydown", (e) => {
      if (e.target.closest?.("[data-maker]") || !e.target.matches?.(".lib-row")) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(byKey(e.target.dataset.key)); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { const next = e.key === "ArrowDown" ? e.target.nextElementSibling : e.target.previousElementSibling; if (next) { e.preventDefault(); next.focus(); } }
    });
    els.filters.addEventListener("click", (e) => {
      const button = e.target.closest?.(".lib-filter"); if (!button) return;
      e.stopPropagation();
      if (button.id === "library-type") {
        menu(button, "Type", TYPES.map((t) => ({ id: `t:${t[0]}`, label: t[1], checked: state.type === t[0] })), (id) => choose("type", id.slice(2)));
      } else {
        const rows = [{ id: "m:", label: "Anyone", checked: !state.maker }, ...["session", "chat", "pip"].map((k) => ({ id: `m:kind:${k}`, label: KINDS[k].all, checked: state.maker === `kind:${k}` }))];
        for (const k of ["pip", "session", "chat"]) { const named = makers.filter((m) => m.kind === k); if (named.length) rows.push({ head: KINDS[k].head }, ...named.map((m) => ({ id: `m:${m.id}`, label: m.name, checked: state.maker === m.id }))); }
        menu(button, "Made by", rows, (id) => choose("maker", id.slice(2)));
      }
    });
    function choose(which, value) {
      state[which] = value; state.shown = PAGE;
      keep?.({ type: state.type, maker: state.maker });
      draw();
      doc.getElementById(which === "type" ? "library-type" : "library-maker")?.focus({ preventScroll: true });
    }
    let typing = 0;
    els.search?.addEventListener("input", () => { view.clearTimeout(typing); typing = view.setTimeout(() => { state.query = els.search.value.trim().slice(0, 200); state.shown = PAGE; draw(); }, 120); });
    els.more.addEventListener("click", () => {
      state.shown += PAGE;
      // Past what was read: the next page of files and of pictures.
      if (state.shown > items().length - PAGE / 2) fetchOn(true);
      draw();
    });
    function fetchOn(force) {
      if (state.filesNext != null && (force || state.files.length < MOST)) { asked.push(state.filesNext); post({ type: "list", offset: state.filesNext }); state.filesNext = null; }
      if (state.imagesNext != null && (force || state.images.length < MOST)) { post({ type: "workImages", seq, offset: state.imagesNext, limit: 60 }); state.imagesNext = null; }
    }
    function setPic(key, msg) {
      const ok = typeof msg.data === "string" && IMAGE_DATA.test(msg.data);
      pics.set(key, ok ? { data: msg.data } : { error: true });
      const img = [...els.list.querySelectorAll("img[data-pic]")].find((n) => n.dataset.pic === key);
      if (img && ok) img.src = msg.data; else if (img) draw();
    }

    /** What the Library's host said. */
    function message(msg) {
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "artifacts") {
        state.artifacts = (Array.isArray(msg.items) ? msg.items : []).filter((a) => a && ARTIFACT_ID.test(String(a.id || "")));
        state.loaded.artifacts = true; state.error = ""; draw();
      } else if (msg.type === "artifactsOffered") { if (msg.on !== true) { state.artifacts = []; state.loaded.artifacts = true; draw(); } }
      else if (msg.type === "library") {
        const offset = asked.length ? asked.shift() : 0, files = (Array.isArray(msg.files) ? msg.files : []).filter((f) => f && typeof f.id === "string");
        state.files = offset ? [...state.files, ...files.filter((f) => !state.files.some((x) => x.id === f.id))] : files;
        state.filesNext = Number.isInteger(msg.next) ? msg.next : null; state.loaded.files = true;
        fetchOn(false); draw();
      } else if (msg.type === "workImages") {
        if (msg.seq !== seq) return;
        const images = (Array.isArray(msg.images) ? msg.images : []).filter((i) => i && typeof i.path === "string");
        state.images = msg.offset ? [...state.images, ...images.filter((i) => !state.images.some((x) => x.path === i.path))] : images;
        state.imagesNext = Number.isInteger(msg.next) ? msg.next : null; state.loaded.images = true;
        fetchOn(false); draw();
      } else if (msg.type === "workImagesOffered") { if (msg.on !== true) { state.images = []; state.loaded.images = true; draw(); } }
      else if (msg.type === "image") setPic(`file:${String(msg.id || "")}`, msg);
      else if (msg.type === "workImageData") setPic(`image:${String(msg.path || "")}`, msg);
      else if (msg.type === "artifactRemoved") { state.artifacts = state.artifacts.filter((a) => a.id !== msg.id); draw(); }
      // Made, changed or removed somewhere: asked for again while the tab shows (shown again later, it asks anyway).
      else if (msg.type === "artifactChanged" || msg.type === "changed" || msg.type === "refresh") { if (showing) ask(); }
      else if (msg.type === "error") { state.error = String(msg.message || "The Library couldn't be read.").slice(0, 300); state.loaded.artifacts = state.loaded.files = true; draw(); }
    }
    let showing = false;
    drawFilters();
    return {
      message,
      /** The tab is on screen: everything is asked for again (made, changed or removed since). */
      shown() { showing = true; ask(); draw(); },
      hidden() { showing = false; },
      state: () => ({ type: state.type, maker: state.maker, query: state.query }),
    };
  }

  root.DgcLibraryPage = Object.freeze({ mount, age });
})();
