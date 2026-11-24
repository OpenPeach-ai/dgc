// "What's new in 0.52" (pips-flow-design §3.3, item 1; the new look of 17 Nov): a dialog in the side bar the first time
// 0.52's side bar is shown, one slide at a time. Each slide is a card: a 16:9 picture on top, a still of the page the
// slide is about, made of DGC's own parts, as a glass panel on a soft two-stop backdrop in the slide's own hue, playing
// out its story (a loop of 6 s, transforms and opacity only; still under reduced motion, at its final frame; paused
// while the window is hidden), with × at its top right and the dots on its bottom edge. Under it a quiet eyebrow, the
// title, and rows: an icon, a heading and a muted line or two. Then a footer under a hairline: the slide's own action
// on the left when it has one (Open Pips, Arrange Home, Open Library, Open Work), Next on the right (Done on the last),
// and the arrow keys.
//
// ×, Done and Esc close it for good: the page says {type: "whatsNewSeen"} and the editor remembers (src/whatsNew.ts).
// A slide's action closes it for good too and says {type: "whatsNewGo", to}: the host keeps the answer and takes the
// side bar there. A click on the page behind does not answer for you.
//
// A classic script, loaded before the side bar's own (window.DgcWhatsNew). It draws into #whats-new (src/panel.ts);
// the look is media/shared/whatsnew.css, the rows' icons media/shared/icons.js (window.DgcIcons). Words are text nodes;
// the only markup it places is what DGC's own modules draw (a face, a mark, a sheet, an icon): never a message's.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcWhatsNew) return;

  // ---- the words ---------------------------------------------------------------------------------------------------
  // Each line was checked against the code at this commit (17 Nov). A line that isn't true yet is `ships: false`: it
  // isn't shown, and comes back in its place when slides([id]) says it has shipped. The four held back, and why:
  //   pip-computer: "or step in" isn't so: while a Pip uses its computer your keys and pointer wait until it stops
  //                 (src/pipComputerClient.js: "You can watch; it is yours again when it stops").
  //   wall:         "Inside its computer a Pip never asks" isn't so: at Ask me first it asks before a new site or a
  //                 submit from its own browser, and at every level a Terminal command that could wipe its Files
  //                 waits for you (dgc/pip_levels.py).
  //   own-copy:     "Nothing in your folder changes until you apply it" isn't so at Do it all, which applies what it
  //                 changed by itself (dgc/pip_levels.py BOX_SAYS, dgc/pip_fixes.py).
  //   reflow:       "to a full editor tab" isn't so: Home is the side bar's only (src/panel.ts useSessionsHome).
  const SLIDES = [
    { scene: "pips-list", hue: "violet", title: "Pips are one kind now", go: { to: "pips", label: "Open Pips" }, rows: [
      { id: "one-list", icon: "list-unordered", head: "One list, one New Pip", text: "Every Pip gets everything: its own chat, its own computer, and its own copy of any folder you give it." },
      { id: "pip-chat", icon: "comment-discussion", head: "It talks to you in its chat", text: "A Pip says what it found, sends you files, and shows the helpers it hands work to." },
      { id: "pip-computer", icon: "vm", head: "A computer of its own", text: "It opens on a desktop with a browser, Files and Terminal. Watch it work, or step in.", ships: false },
    ] },
    { scene: "wall", hue: "amber", title: "Each Pip works behind a wall", rows: [
      { id: "wall", icon: "lock", head: "Free inside, asks at the wall", text: "Inside its computer a Pip never asks. Changing your folder, sending, posting or paying does.", ships: false },
      { id: "levels", icon: "shield", head: "You choose how much it asks", text: "Ask me first, Approve for me, or Do it all." },
      { id: "pay-limit", icon: "credit-card", head: "A daily limit in dollars", text: "For each Pip and for all of them. Inside it, Always allow is one tap." },
    ] },
    { scene: "levels", hue: "violet", title: "Pips tell you, then fix", rows: [
      { id: "explains", icon: "lightbulb", head: "What's wrong, and why", text: "When a check finds something, the Pip explains it in its chat." },
      { id: "own-copy", icon: "diff", head: "Fixed in its own copy", text: "Nothing in your folder changes until you apply it. Undo is always there.", ships: false },
      { id: "needs-you", icon: "bell", head: "Asked once, kept in one place", text: "What only you can do waits on Home, under Needs you." },
    ] },
    { scene: "cards", hue: "green", title: "Home is yours", go: { to: "home-cards", label: "Arrange Home" }, rows: [
      { id: "cards", icon: "layout", head: "Cards you arrange", text: "Needs you, Recent, Running now, Token usage, Notes, Clock, Weather and more." },
      { id: "reflow", icon: "screen-full", head: "They fit any width", text: "Cards reflow from a narrow side bar to a full editor tab.", ships: false },
      { id: "notes", icon: "note", head: "Notes, a full notes app", text: "Folders, search, checklists, and formatting as you type." },
    ] },
    { scene: "library", hue: "azure", title: "One Library for everything", go: { to: "library", label: "Open Library" }, rows: [
      { id: "library", icon: "library", head: "Everything you make, in one place", text: "Pages, docs, sheets, decks, dashboards, widgets, charts, pictures, videos and files, from Chat, Work and Pips." },
      { id: "filters", icon: "filter", head: "Search, then narrow it down", text: "A tab for each kind, then filters, like Kind in Widgets." },
      { id: "file-menu", icon: "more", head: "One menu on every file", text: "Open, open in the editor, save a copy, copy its path, or show it in its folder." },
    ] },
    { scene: "work", hue: "blue", title: "Work, tidier", go: { to: "work", label: "Open Work" }, rows: [
      { id: "archive", icon: "archive", head: "Archive and restore", text: "Put finished sessions away, and bring them back any time." },
      { id: "goals", icon: "target", head: "Goals you can follow", text: "A goal runs as turns you can read, and its clock holds when you change the model." },
      { id: "queue-edit", icon: "edit", head: "Edit a queued message", text: "Change the message waiting to go next, without losing your draft." },
    ] },
    { scene: "settings", hue: "neutral", title: "Also new", also: true },
  ];
  // The last slide is a list: at most three lines, the first three that have shipped. Payments is slide 2's.
  // (18 Nov: the model picker shipped, 8a40f6b1; auto mode's safety check, the commit after this one.)
  const ALSO = [
    { id: "picker", icon: "layers", head: "One model picker", text: "Every model you've added, in one place, for Chat, Work and Pips." },
    { id: "auto", icon: "shield", head: "Auto that stays out of your way", text: "Everyday steps just run. A risky one stops and says why; your yes lets it go." },
    { id: "settings", icon: "settings", head: "Settings by asking", text: "Say “use 8 Pip runs at once”, and it changes, with Undo in the chat." },
    { id: "fallback", icon: "arrow-swap", head: "A fallback model everywhere", text: "A backup model you chose takes over when yours can't answer." },
    { id: "incognito", icon: "eye-closed", head: "Incognito chats", text: "A chat that is never saved, listed or remembered." },
    { id: "browser", icon: "globe", head: "Your Browser", text: "Sign in once in your own Chrome; each Pip works in its own tab.", ships: false },
  ];
  const ids = (shipped) => (Array.isArray(shipped) ? shipped.filter((id) => typeof id === "string") : []);
  const line = ({ id, icon, head, text }) => ({ id, icon, head, text });
  const shown = (extra) => (row) => row.ships !== false || extra.includes(row.id);
  /** "Also new": the first three lines that have shipped (`shipped`: ids of `ships: false` lines that have since). */
  function alsoNew(shipped) { return ALSO.filter(shown(ids(shipped))).slice(0, 3).map(line); }
  /** The slides: its scene, its hue, its title, its action ({to, label} or null) and its rows ({id, icon, head, text}). */
  function slides(shipped) {
    const extra = ids(shipped);
    return SLIDES.map((s) => ({ scene: s.scene, hue: s.hue, title: s.title, go: s.go ? { ...s.go } : null, rows: s.also ? alsoNew(extra) : s.rows.filter(shown(extra)).map(line) }));
  }

  // ---- the pictures: stills of DGC's own pages, made of their own parts ------------------------------------------------
  // Each scene is drawn with the parts the real pages draw with: a Pip's face from the faces' renderer
  // (window.PipConcepts.plush, the same sprite the Pips list, Home and the dock use), a session's or a widget's mark
  // (window.DgcMarks), a file's sheet (window.DgcFileSheet), a folder's icon (window.DgcFolderPick), the icons
  // (window.DgcIcons), the answers' row (window.DgcIconActions), the queued message's row (window.DgcMessageQueue), and
  // Home's cards, the Library's tabs and rows and the menus in their own classes and stylesheets. A Pip's computer's
  // apps are its own icons (media/pips/apps), from where the page already loads the extension's files. The scene is
  // laid out at a fixed 640 × 360, as on a page, and the whole picture is scaled to its frame, so it is a still of the
  // page at every width. Nothing in it can be pressed or reached by Tab: its controls are drawn as plain words (asPicture()).
  //
  // Each scene is drawn at its last frame (what reduced motion shows), and says how it gets there: `moves(A)` with the
  // steps below, on one 6 s loop. Everything that moves fades out together near the loop's end, and the story starts again.
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const box = (cls, ...kids) => { const n = el("div", cls); for (const k of kids) if (k) n.append(k); return n; };
  const span = (cls, ...kids) => { const n = el("span", cls); for (const k of kids) if (k) n.append(typeof k === "string" ? document.createTextNode(k) : k); return n; };
  /** One of DGC's own parts, as its own module draws it (never a message's words). */
  const part = (tag, cls, markup) => { const n = el(tag, cls); if (markup) n.innerHTML = markup; return n; };
  /** A real part made a picture: its controls become plain words (nothing in a picture is pressed or reached by Tab),
   *  no id is kept (the page behind has its own) and no tooltip shows. */
  function asPicture(node) {
    for (const n of [...node.querySelectorAll("button, input, select, textarea, a[href]")]) {
      const s = document.createElement("span");
      for (const a of [...n.attributes]) if (!/^(id|type|tabindex|title|href|disabled|role|aria-(label|describedby|haspopup|expanded|controls))$/.test(a.name)) s.setAttribute(a.name, a.value);
      s.append(...n.childNodes); n.replaceWith(s);
    }
    for (const n of [node, ...node.querySelectorAll("[id], [tabindex], [title], [contenteditable]")]) { n.removeAttribute("id"); n.removeAttribute("tabindex"); n.removeAttribute("title"); n.removeAttribute("contenteditable"); }
    for (const n of [...node.querySelectorAll(".dgc-ia-said")]) n.remove();
    return node;
  }
  const KINDS = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
  let faces = 0;
  /** A Pip's face, as the Pips list draws it: its kind, its pose ("idle" breathes and blinks). */
  const face = (kind, state = "idle") => { const P = root.PipConcepts?.plush; let m = "";
    try { m = P ? P.markup({ index: KINDS.indexOf(kind), name: kind[0].toUpperCase() + kind.slice(1) }, state, `wn-face-${++faces}`, { includeStyles: false }) : ""; } catch { m = ""; }
    return m; };
  const mark = (kind, palette, moving = false) => root.DgcMarks?.of?.(kind, palette, { moving, id: `wn-${kind}-${palette}` }) || "";
  const sheet = (what, name) => { try { return root.DgcFileSheet ? (name ? root.DgcFileSheet.forFile(what, name) : root.DgcFileSheet.html(what)) : ""; } catch { return ""; } };
  const glyph = (name, size = 16) => root.DgcIcons?.html?.(name, { size }) || "";
  const folder = (path, size) => { const m = root.DgcFolderPick?.folderMark?.(path) || ""; return size ? m.replace('class="folder-icon ', `style="--folder-size:${size}px" class="folder-icon `) : m; };
  // The extension's media folder, from where this script (or the Pips bundle) was loaded: a Pip's computer's apps.
  const here = (typeof document !== "undefined" && document.currentScript?.src) || "";
  const mediaUrl = (path) => {
    const scripts = typeof document !== "undefined" ? [...document.scripts].map((s) => s.src) : [];
    const own = here || scripts.find((s) => /\/media\/shared\/whatsnew\.js(?:[?#]|$)/.test(s)), bundle = scripts.find((s) => /\/dist\/[A-Za-z]+\.js(?:[?#]|$)/.test(s));
    try { return own ? new URL(`../${path}`, own).href : bundle ? new URL(`../media/${path}`, bundle).href : ""; } catch { return ""; }
  };
  /** The dropdowns' own chevron (the Project Folder button's, which the Library's filters wear too). */
  const chevron = () => { try { const t = document.createElement("template"); t.innerHTML = root.DgcFolderPick?.buttonHtml?.({ said: "-" }) || ""; return t.content.querySelector(".dgc-folder-chevron")?.outerHTML || ""; } catch { return ""; } };
  const app = (name) => { const i = el("img", "wn-app"); i.alt = ""; const src = mediaUrl(`pips/apps/${name}.png`); if (src) i.src = src; return i; };

  // Home's cards (media/shared/homecards.css): a card, its head, its rows.
  const card = (kind, ...kids) => { const c = el("section", `hc-card hc-${kind}`); c.dataset.card = kind; c.dataset.form = "m"; for (const k of kids) if (k) c.append(k); return c; };
  const head = (title, ...more) => box("hc-ch", span("hc-ct", title), ...more);
  /** A row of a card: its icon (one of DGC's parts, as markup, or a node), its name, its line, and what ends it. */
  const row = (icon, name, meta, end) => { const li = span("hc-li"); const ico = typeof icon === "string" ? part("span", "hc-ico", icon) : span("hc-ico", icon);
    li.append(ico, span("hc-tx", typeof name === "string" ? span("hc-nm", name) : name, span("hc-meta", meta))); if (end) li.append(end); return li; };
  const list = (...rows) => box("hc-list", ...rows);

  const SCENES = {
    // One list of Pips, the faces as they are: they arrive one by one; Scout is chosen, and what it has of its own ticks
    // in beside it: its chat, its computer (Browser, Files, Terminal) and its copy of a folder.
    "pips-list": () => {
      const core = span("hc-nm", "Core "); core.append(span("hc-star", "★"));
      const rows = [row(face("core"), core, "Ready when you are"), row(face("scout"), "Scout", "2 waiting for you", span("hc-cnt", "2")),
        row(face("lens"), "Lens", "Checked lime_tiles · 1h"), row(face("quill"), "Quill", "Morning brief at 8:00")];
      const chosen = el("i", "wn-sel"); rows[1].prepend(chosen);
      const apps = span("wn-apps", app("browser"), app("files"), app("terminal"));
      const own = [row(glyph("comment-discussion", 16), "Its own chat", "Says what it found, sends files"),
        row(app("browser"), "Its own computer", "Browser, Files and Terminal", apps), row(folder("/home/me/projects/lime_tiles", 20), "Its own copy", "of lime_tiles, to work in")];
      const mine = card("wn-own", box("hc-ch", part("span", "hc-ico wn-head-face", face("scout")), span("hc-ct", "Scout"), span("hc-cap", "Personal")), list(...own));
      return { nodes: [card("pips", head("Pips", span("hc-sp"), span("hc-lnk", "All Pips")), list(...rows)), mine],
        moves(A) { rows.forEach((r, i) => A.arrive(r, 0.3 + i * 0.3, { dy: 10 })); A.arrive(chosen, 1.6, { dy: 0 }); A.arrive(mine, 1.9, { dx: -14, dy: 0 });
          own.forEach((n, i) => A.arrive(n, 2.3 + i * 0.3, { dy: 8 })); A.press(rows[1], 1.55); } };
    },
    // Your folder, copied into the Pip's own computer, inside the wall (amber, the colour of "this asks you"): a file
    // crosses into it; what would leave it asks.
    wall: () => {
      const file = (name, meta) => row(sheet("", name), name, meta);
      const mine = [file("orders.py", "Python · 2h"), file("gst/rules.py", "Python · 1d"), file("README.md", "Markdown · 3d")];
      const copies = [file("orders.py", "a copy"), file("gst/rules.py", "a copy"), file("README.md", "a copy")];
      const travel = file("orders.py", "copying…"); travel.classList.add("wn-travel"); mine[0].append(travel);
      const glow = el("i", "wn-glow"), asks = span("wn-arrow back", "asks"); asks.prepend(glow);
      return { nodes: [card("wn-folder", box("hc-ch", part("span", "hc-ico", folder("/home/me/projects/lime_tiles", 20)), span("hc-ct", "lime_tiles"), span("hc-cap", "Your folder")), list(...mine)),
        box("wn-cross", span("wn-arrow", "copy"), asks),
        card("wn-boxed", box("hc-ch", part("span", "hc-ico wn-head-face", face("scout")), span("hc-ct", "Scout's computer")), list(...copies))],
        moves(A) { A.travel(travel, 0.5, { to: "var(--wn-cross)", dur: 1.3 }); copies.forEach((n, i) => A.arrive(n, 1.8 + i * 0.25, { dy: 8 })); A.pulse(glow, 2.9); } };
    },
    // The level, in the menu a Pip's prompt box opens: it moves from Ask me first to Approve for me. And what the Pip
    // found, said in its words, waits on Home under Needs you, with its face.
    levels: () => {
      const levels = (on) => { const m = box("dgc-menu dgc-menu-rows wn-levels"); m.setAttribute("role", "presentation");
        for (const [label, sub] of [["Ask me first", "Asks before it submits or sends"], ["Approve for me", "Asks before it pays or posts"], ["Do it all", "Does the whole job"]]) {
          const r = span("dgc-menu-row"); r.setAttribute("aria-checked", String(label === on));
          r.append(span("dgc-menu-words", span("dgc-menu-label", label), span("dgc-menu-sub", sub)), part("span", "dgc-menu-check", glyph("check", 14) || "✓"));
          m.append(r);
        } return m; };
      const was = levels("Ask me first"), now = levels("Approve for me"); was.classList.add("was");
      const pick = box("wn-pick", was, now);
      const title = el("strong", "dgc-card-title"); "March totals round down".split(" ").forEach((w, i) => { if (i) title.append(" "); title.append(span("wn-word", w)); });
      const chips = el("ul", "dgc-card-chips"); for (const c of ["Why: rounding", "+4 −2"]) { const li = el("li", "dgc-chip"); li.append(span("", c)); chips.append(li); }
      const answers = part("div", "dgc-card-actions", root.DgcIconActions?.html?.([{ label: "Review", primary: true }, { label: "Apply" }]) || "");
      const hub = el("section", "dgc-card dgc-card-thin dgc-hub-card"); hub.dataset.source = "personal"; hub.dataset.group = "needs";
      hub.append(box("dgc-card-head", part("span", "dgc-card-icon dgc-card-face", face("lens", "waiting_approval")), box("dgc-card-words", title, span("dgc-card-sub", "Lens · Pip · now"))), chips, answers);
      const needs = card("needs", box("dgc-hub hc-hub", box("dgc-hub-group", box("dgc-hub-head", (() => { const h = el("h2"); h.append("Needs you", span("dgc-hub-n", "1")); return h; })(), span("dgc-hub-link", "View all")), box("dgc-hub-cards", hub))));
      needs.querySelector(".dgc-hub").dataset.hub = "needs"; needs.querySelector(".dgc-hub-group").dataset.group = "needs";
      return { nodes: [pick, needs],
        moves(A) { A.swap(was, now, 0.9, 0.35); A.arrive(hub, 1.5, { dy: 10 });
          let t = 1.9; for (const w of title.querySelectorAll(".wn-word")) { A.arrive(w, t, { dy: 0, dur: 0.14 }); t += 0.12; }
          A.arrive(chips, t + 0.15, { dy: 6 }); A.arrive(answers, t + 0.45, { dy: 6 }); } };
    },
    // Home's own cards settle into the bento: Needs you, Running now (a session at work), Notes, Token usage, whose
    // days fill in.
    cards: () => {
      const needs = card("needs", head("Needs you", span("hc-cnt", "2"), span("hc-sp"), span("hc-lnk", "View all")),
        list(row(face("scout", "waiting_approval"), "Scout", "2 things are waiting for you"), row(mark("work", "saffron"), "Plan the release notes", "Wants your okay · Work")));
      const running = card("running", head("Running now", span("hc-livedot"), span("hc-sp")), list(row(mark("work", "azure", true), "Fix the login redirect", "Work · Running · 5 messages")));
      const tick = part("span", "wn-check on", glyph("check", 12));
      const note = card("note", head("Notes", span("hc-sp"), span("hc-lnk", "Open Notes")),
        box("wn-todo", tick, span("", "Book the ferry")), box("wn-todo", el("span", "wn-check"), span("", "Pack chargers")));
      const days = [5, 3, 0, 4, 2, 6, 3, 7, 5, 2, 4, 6, 3, 5].map((on) => { const c = span("hc-col"); for (let k = 0; k < 8; k++) c.append(el("i", "hc-cell" + (k < on ? " on" : k === on ? " cap" : ""))); return c; });
      const plot = box("hc-plot", ...days);
      const token = card("token", box("hc-ch", span("hc-tx", span("hc-ct", "Token usage"), span("hc-cap", "Daily · last 14 days")), span("hc-badge", "Tokens")), box("hc-chart", plot));
      const cards = [needs, running, token, note];
      return { nodes: [box("hc-grid wn-bento", ...cards)],
        moves(A) { cards.forEach((c, i) => A.arrive(c, 0.2 + i * 0.25, { dx: 6, dy: 12, s: 0.97 })); days.forEach((d, i) => A.grow(d, 1.4 + i * 0.06)); A.arrive(tick, 2.8, { dy: 0, s: 0.4 }); } };
    },
    // The Library: its tab changes from Artifacts to Widgets, Kind is set to Chart, and the rows filter.
    library: () => {
      const TABS = [["artifacts", "Artifacts", "browser"], ["widgets", "Widgets", "symbol-misc"], ["images", "Images", "file-media"], ["videos", "Videos", "device-camera-video"], ["files", "Files", "files"]];
      const tabs = (on) => { const t = box("lib-tabs"); for (const [id, word, ic] of TABS) { const b = span("lib-tab", part("span", `lib-tab-icon codicon codicon-${ic}`, ""), span("lib-tab-word", word)); b.setAttribute("aria-selected", String(id === on)); t.append(b); } return t; };
      const tabsWas = tabs("artifacts"), tabsNow = tabs("widgets"); tabsWas.classList.add("was");
      const libRow = (icon, name, by, when, cls) => { const r = el("li", "lib-row" + (cls ? " " + cls : "")); r.append(part("span", `lib-row-thumb ${icon.startsWith("<span class=\"dgc-sheet") ? "lib-row-sheet" : "lib-row-mark"}`, icon),
        span("lib-row-main", span("lib-row-name", name), span("lib-row-meta", span("lib-row-by", span("lib-row-pre", "made "), "by "), span("lib-row-maker", by), span("lib-row-when", ` · ${when}`))), part("span", "lib-row-more", glyph("more"))); return r; };
      const small = (m) => m.replace('class="dgc-sheet"', 'class="dgc-sheet dgc-sheet-sm"');
      const before = [libRow(small(sheet("page")), "Q3 plan", "Scout", "40m", "was"), libRow(small(sheet("sheet")), "Trip costs", "Chat", "2h", "was"), libRow(small(sheet("slides")), "Launch deck", "Work", "1d", "was")];
      const after = [libRow(mark("widget", "azure"), "Token usage by day", "Chat", "15m"), libRow(mark("widget", "peach"), "Trip budget calculator", "Chat", "5h", "out"),
        libRow(mark("widget", "fern"), "Weekly sales", "Lens", "1d", "up"), libRow(mark("widget", "iris"), "Daily cost", "Work", "2d", "up")];
      [...before, ...after].forEach((r, i) => { r.style.gridRow = String((i < 3 ? i : i - 3) + 1); });
      const filter = (v) => { const f = span("dgc-folder lib-filter", span("dgc-folder-k", "Kind"), span("dgc-folder-v", v)); f.insertAdjacentHTML("beforeend", chevron()); return f; };
      const kindWas = filter("All"), kindNow = filter("Chart"); kindWas.classList.add("was");
      const lib = box("dgc-lib wn-lib", box("lib-bar", span("lib-search wn-ph", "Search widgets")), box("wn-tabs", tabsWas, tabsNow),
        box("lib-filters", box("wn-kind", kindWas, kindNow)), (() => { const ul = el("ul", "lib-list wn-lib-rows"); ul.append(...before, ...after); return ul; })());
      return { nodes: [lib],
        moves(A) { before.forEach((r) => A.leave(r, 1.1, { to: "0px -6px" })); A.swap(tabsWas, tabsNow, 1.2);
          A.arrive(after[0], 1.5, { dy: 8 }); A.arrive(after[1], 1.7, { dy: 8, until: 3.0 }); A.arrive(after[2], 1.9, { dy: 8 });
          A.swap(kindWas, kindNow, 2.6);
          for (const r of after.slice(2)) A.move(r, 3.15, { from: "0px 0px", to: "var(--wn-up)", dur: 0.4, after: r === after[3] ? 0 : 1.9 }); } };
    },
    // Work's sessions, with their marks: one is archived (Archived counts it) and the list closes up; then the message
    // waiting to go next, in its own row, is edited.
    work: () => {
      const archive = part("span", "hc-btn hc-icon wn-act", glyph("archive", 16));
      const done = row(mark("work", "lagoon"), "Fix the login redirect", "Done · 12 messages", archive); done.classList.add("out");
      const rest = [["saffron", "Invoice totals", "Wants your okay · 7 messages", "1h"], ["fern", "Release notes", "Open in a tab · 9 messages", "5h"], ["iris", "Weekly report", "4 messages", "1d"]]
        .map(([p, name, meta, age]) => { const r = row(mark("work", p), name, meta, span("hc-age", age)); r.classList.add("up"); return r; });
      const was = span("wn-count was", "3"), now = span("wn-count", "4"), count = span("hc-lnk hc-more wn-counts", "Archived (", span("wn-n", was, now), ")");
      const work = card("work", box("hc-ch", span("hc-ct", "Work sessions"), span("hc-cap", "lime_tiles"), span("hc-sp"), part("span", "hc-btn hc-solid hc-new-btn", `${glyph("add", 14)}New`)), box("hc-list wn-slots", done, ...rest), count);
      const ol = el("ol", "wn-queue-list"); let edit = null;
      if (root.DgcMessageQueue?.render) {
        try { root.DgcMessageQueue.render(ol, [{ id: "wn-queued", text: "Also update the changelog", title: "" }], { steer() {}, edit() {}, remove() {}, draft: () => false }); } catch { ol.replaceChildren(); }
        edit = asPicture(ol).querySelector('[data-queue-role="edit"]');
      }
      const queued = card("wn-queue", ol);
      return { nodes: [work, queued],
        moves(A) { A.arrive(archive, 0.5, { dy: 0, dur: 0.25 }); A.press(archive, 0.95); A.move(done, 1.2, { from: "0px 0px", to: "var(--wn-away)", dur: 0.6, fade: true });
          A.swap(was, now, 1.9);
          for (const r of rest) A.move(r, 2.25, { from: "0px 0px", to: "var(--wn-up)", dur: 0.45 });
          A.arrive(queued, 3.0, { dy: 10 }); if (edit) A.press(edit, 3.9); } };
    },
    // A setting changed by asking, in a Work chat: what you sent, and the quiet line the change leaves, with Undo. And
    // two more of what is new.
    settings: (lend) => {
      const said = box("msg user wn-said", box("bubble", box("prompt-text", el("span", "", "Use 8 Pip runs at once"))));
      said.querySelector(".prompt-text").textContent = "Use 8 Pip runs at once";
      const line = box("sys sys-marked setting-change"); line.dataset.state = "changed";
      const ic = lend?.icon?.("sliders-horizontal"); if (ic) line.insertAdjacentHTML("afterbegin", ic);
      line.append(span("setting-change-text", span("setting-change-words", "Changed Pip runs at once from 4 to 8")), span("link setting-change-undo", "Undo"));
      const more = [row(glyph("arrow-swap", 16), "A fallback model", "Takes over when yours can't answer"), row(glyph("eye-closed", 16), "An incognito chat", "Never saved, listed or remembered")];
      const also = card("wn-also", head("Also new"), list(...more));
      const chat = box("wn-chat", said, line);
      return { nodes: [chat, also],
        moves(A) { A.arrive(said, 0.4, { dx: 16, dy: 0 }); A.arrive(line, 1.4, { dy: 8 }); if (line.firstElementChild?.tagName === "svg") A.arrive(line.firstElementChild, 1.7, { dy: 0, s: 0.4 });
          A.arrive(also, 2.4, { dy: 10 }); more.forEach((r, i) => A.arrive(r, 2.7 + i * 0.3, { dy: 6 })); } };
    },
  };

  // ---- the motion: Web Animations on one loop, so a hidden window pauses them and a closed dialog ends them -----------
  const LOOP = 6, END = 5.5, EASE = "cubic-bezier(.2,.7,.2,1)";
  /** The steps a scene tells its story with, each one animation on the loop. Times in seconds. */
  function animator(list) {
    const at = (s) => Math.max(0, Math.min(1, s / LOOP));
    const run = (node, frames) => {
      if (!node || typeof node.animate !== "function") return;
      // (A value of var(--x) is the scene's own length, read once: Web Animations takes lengths, not variables.)
      const css = getComputedStyle(node), real = (v) => String(v).replace(/var\((--[\w-]+)\)/g, (_, name) => css.getPropertyValue(name).trim() || "0px");
      const read = frames.map((f) => { const o = { ...f }; if (o.translate) o.translate = real(o.translate); return o; });
      for (let i = 1; i < read.length; i++) if (read[i].offset < read[i - 1].offset) read[i].offset = read[i - 1].offset;
      try { list.push(node.animate(read, { duration: LOOP * 1000, iterations: Infinity })); } catch { /* still: its last frame */ }
    };
    const gone = (o) => ({ ...o, opacity: 0 });
    return {
      /** Comes in at `t` (from dx/dy px away, at scale s), stays, and goes with the rest; `until`: it goes sooner. */
      arrive(node, t, { dx = 0, dy = 8, s = 1, dur = 0.45, until = END } = {}) {
        const from = { opacity: 0, translate: `${dx}px ${dy}px`, scale: `${s}` }, to = { opacity: 1, translate: "0px 0px", scale: "1" };
        run(node, [{ ...from, offset: 0 }, { ...from, offset: at(t), easing: EASE }, { ...to, offset: at(t + dur) }, { ...to, offset: at(until) }, { ...gone(to), offset: at(until + 0.35) }, { ...gone(to), offset: 1 }]);
      },
      /** There from the start; goes at `t` (faded, moved by `to`). Its last frame: gone. */
      leave(node, t, { to = "0px 6px", dur = 0.4 } = {}) {
        const here = { opacity: 1, translate: "0px 0px" };
        run(node, [{ ...gone(here), offset: 0 }, { ...here, offset: at(0.25) }, { ...here, offset: at(t), easing: EASE }, { opacity: 0, translate: to, offset: at(t + dur) }, { opacity: 0, translate: to, offset: 1 }]);
      },
      /** There from the start (or from `after`); moves from `from` to `to` at `t`, and stays; `fade`: it fades as it lands. */
      move(node, t, { from, to, dur = 0.5, fade = false, after = 0 } = {}) {
        const a = { opacity: 1, translate: from }, b = { opacity: fade ? 0 : 1, translate: to };
        run(node, [{ ...gone(a), offset: 0 }, { ...gone(a), offset: at(after) }, { ...a, offset: at(after + 0.25) }, { ...a, offset: at(t), easing: EASE },
          ...(fade ? [{ opacity: 1, translate: to, offset: at(t + dur * 0.75) }] : []), { ...b, offset: at(t + dur) }, { ...b, offset: at(END) }, { ...gone(b), offset: at(END + 0.35) }, { ...gone(b), offset: 1 }]);
      },
      /** Appears, crosses by `to`, and is gone at the other side (a file crossing the wall). Its last frame: gone. */
      travel(node, t, { to, dur = 1.2 } = {}) {
        const here = { opacity: 0, translate: "0px 0px" };
        run(node, [{ ...here, offset: 0 }, { ...here, offset: at(t - 0.25) }, { opacity: 1, translate: "0px 0px", offset: at(t), easing: "cubic-bezier(.45,0,.25,1)" },
          { opacity: 1, translate: `${to} 0px`, offset: at(t + dur) }, { opacity: 0, translate: `${to} 0px`, offset: at(t + dur + 0.3) }, { opacity: 0, translate: `${to} 0px`, offset: 1 }]);
      },
      /** Lights up at `t`, breathes twice, and stays lit. */
      pulse(node, t) {
        run(node, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: at(t), easing: EASE }, { opacity: 1, offset: at(t + 0.4) }, { opacity: 0.4, offset: at(t + 0.9) }, { opacity: 1, offset: at(t + 1.4) },
          { opacity: 0.4, offset: at(t + 1.9) }, { opacity: 1, offset: at(t + 2.4) }, { opacity: 1, offset: at(END) }, { opacity: 0, offset: at(END + 0.35) }, { opacity: 0, offset: 1 }]);
      },
      /** Grows from its foot at `t` (a bar). */
      grow(node, t) {
        run(node, [{ opacity: 1, scale: "1 0", offset: 0 }, { opacity: 1, scale: "1 0", offset: at(t), easing: EASE }, { opacity: 1, scale: "1 1", offset: at(t + 0.5) }, { opacity: 1, scale: "1 1", offset: at(END) },
          { opacity: 0, scale: "1 1", offset: at(END + 0.35) }, { opacity: 0, scale: "1 0", offset: at(END + 0.4) }, { opacity: 1, scale: "1 0", offset: at(END + 0.45) }, { opacity: 1, scale: "1 0", offset: 1 }]);
      },
      /** One place, two states: `a` gives way to `b` at `t`, and at the loop's end `b` gives way to `a` again (a tab, a
       *  count, a chosen level: one of the two is always there). */
      swap(a, b, t, dur = 0.3) {
        run(a, [{ opacity: 1, offset: 0 }, { opacity: 1, offset: at(t), easing: EASE }, { opacity: 0, offset: at(t + dur) }, { opacity: 0, offset: at(END) }, { opacity: 1, offset: at(END + 0.35) }, { opacity: 1, offset: 1 }]);
        run(b, [{ opacity: 0, offset: 0 }, { opacity: 0, offset: at(t), easing: EASE }, { opacity: 1, offset: at(t + dur) }, { opacity: 1, offset: at(END) }, { opacity: 0, offset: at(END + 0.35) }, { opacity: 0, offset: 1 }]);
      },
      /** Pressed at `t`: a small dip, as a button does. */
      press(node, t) {
        run(node, [{ scale: "1", offset: 0 }, { scale: "1", offset: at(t) }, { scale: "0.88", offset: at(t + 0.12) }, { scale: "1", offset: at(t + 0.32) }, { scale: "1", offset: 1 }]);
      },
    };
  }

  // ---- the dialog ---------------------------------------------------------------------------------------------------
  /** `lend`: what the page lends the pictures of its own (`icon(name)`: Work's own glyphs, as its chat draws them). */
  function mount(layer, { onSeen, onGo, release = "0.52", icon: pageIcon } = {}) {
    let list = slides(), at = 0, back = null, moving = [], story = null, faced = null;
    const lend = { icon: typeof pageIcon === "function" ? (name) => { try { return String(pageIcon(name) || ""); } catch { return ""; } } : null };
    const icon = (name, size) => { const I = root.DgcIcons; if (!I?.node) return null; try { return I.node(name, { size }, document); } catch { return null; } };
    const dialog = box("wn-dialog dgc-dialog");
    const picture = el("div", "wn-picture"), stage = el("div", "wn-stage");
    stage.setAttribute("aria-hidden", "true");
    const close = el("button", "wn-close");
    close.type = "button"; close.setAttribute("aria-label", "Close"); close.title = "Close (Escape)";
    const x = icon("close", 16); if (x) close.append(x); else close.textContent = "×";
    const dots = el("div", "wn-dots"); dots.setAttribute("role", "group"); dots.setAttribute("aria-label", "Slides");
    picture.append(stage, close, dots);
    const kicker = el("p", "wn-kicker"), title = el("h2", "wn-title"), rows = el("ul", "wn-rows");
    title.id = "wn-title"; rows.setAttribute("role", "list");
    const copy = box("wn-copy", kicker, title, rows), scroll = box("wn-scroll", picture, copy);
    const step = el("span", "wn-step sr-only"); step.setAttribute("aria-live", "polite");
    const go = el("button", "wn-go dgc-btn"), next = el("button", "wn-next dgc-btn primary", "Next");
    go.type = next.type = "button";
    const foot = box("wn-foot", step, go, next);
    dialog.append(scroll, foot);
    layer.replaceChildren(dialog);
    layer.setAttribute("aria-labelledby", "wn-title");

    const words = (slide) => {
      title.textContent = slide.title;
      rows.replaceChildren(...slide.rows.map((r) => {
        const li = el("li", "wn-item"), mark = el("span", "wn-icon"), glyph = icon(r.icon, 18);
        if (glyph) mark.append(glyph);
        li.dataset.id = r.id;
        li.append(mark, box("wn-item-words", el("h3", "wn-head", r.head), el("p", "wn-say", r.text)));
        return li;
      }));
    };
    // Every slide's words get the room of the longest at this width, so the footer never moves under the pointer.
    function level() {
      copy.style.minHeight = "";
      let most = 0;
      // (Its laid-out height, to the fraction: the dialog arrives with 2% of scale, which a box's rectangle would include.)
      for (const slide of list) { words(slide); most = Math.max(most, parseFloat(getComputedStyle(copy).height) || copy.offsetHeight); }
      if (most > 0) copy.style.minHeight = most + "px";
      words(list[at]);
    }
    const still = () => { try { return !!root.matchMedia?.("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
    const hidden = () => document.visibilityState === "hidden";
    function stop() { for (const a of moving) { try { a.cancel(); } catch { /* gone */ } } moving = []; }
    function play() {
      stop();
      if (layer.hidden || still() || !story?.moves) return;
      try { story.moves(animator(moving)); } catch { stop(); }
      if (hidden()) for (const a of moving) a.pause();
    }
    // The window hidden: the story waits, and so do the parts' own lives (a face's breath and blink, a session's mark).
    const onVisible = () => { stage.classList.toggle("wn-paused", hidden()); for (const a of moving) { try { if (hidden()) a.pause(); else a.play(); } catch { /* gone */ } } };
    // The still is laid out at 640 × 360, as on a page, and scaled to the picture's width.
    const fit = () => { const w = picture.clientWidth; if (w > 0) picture.style.setProperty("--wn-k", String(w / 640)); };
    const sized = typeof ResizeObserver === "function" ? new ResizeObserver(fit) : null;
    sized?.observe(picture);
    // The faces breathe, blink and look at the pointer as they do everywhere (media/pips/plush.js, with its own styles).
    function faces() {
      const P = root.PipConcepts?.plush;
      if (!P || faced) return;
      try {
        if (!document.getElementById("plush-styles") && !document.getElementById("pips-plush-styles")) { const st = el("style"); st.id = "plush-styles"; st.textContent = P.styles; document.head.append(st); }
        faced = P.mount(stage) || null;
      } catch { faced = null; }
    }
    const motion = (() => { try { return root.matchMedia?.("(prefers-reduced-motion: reduce)") || null; } catch { return null; } })();
    const onMotion = () => play();

    function paint() {
      const slide = list[at], last = at === list.length - 1;
      picture.dataset.scene = slide.scene; picture.dataset.hue = slide.hue;
      story = SCENES[slide.scene] ? SCENES[slide.scene](lend) : { nodes: [] };
      for (const n of story.nodes) asPicture(n);
      // (In Home's own frame, .dgc-home: its cards' colours and corners are Home's tokens.)
      stage.replaceChildren(box("wn-glass", box("wn-scene dgc-home wn-scene-" + slide.scene, ...story.nodes)));
      stage.classList.toggle("wn-paused", hidden());
      fit();
      kicker.textContent = `What's new in DGC ${release}`;
      words(slide);
      dots.replaceChildren(...list.map((s, i) => { const d = el("button", "wn-dot" + (i === at ? " on" : "")); d.type = "button"; d.dataset.at = String(i);
        d.setAttribute("aria-label", `Slide ${i + 1} of ${list.length}: ${s.title}`); if (i === at) d.setAttribute("aria-current", "step"); return d; }));
      step.textContent = `${at + 1} of ${list.length}`;
      go.hidden = !slide.go;
      go.textContent = slide.go ? slide.go.label : "";
      next.textContent = last ? "Done" : "Next";
      play();
    }
    function goTo(to) { const clamped = Math.max(0, Math.min(list.length - 1, to)); if (clamped === at) return; at = clamped; paint(); }
    function shut(seen, place) {
      if (layer.hidden) return;
      layer.hidden = true;
      stop();
      try { faced?.(); } catch { /* released */ }
      faced = null;
      document.removeEventListener("keydown", keys, true);
      document.removeEventListener("visibilitychange", onVisible);
      motion?.removeEventListener?.("change", onMotion);
      root.removeEventListener("resize", level);
      // A slide's action is an answer too: the host keeps it with where to go.
      if (place && typeof onGo === "function") onGo(place);
      else if ((seen || place) && typeof onSeen === "function") onSeen();
      try { if (back && back.isConnected) back.focus(); } catch { /* the page's own focus */ }
      back = null;
    }
    function keys(e) {
      if (layer.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); shut(true); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); goTo(at + (e.key === "ArrowRight" ? 1 : -1)); return; }
      if (e.key === "Tab") {
        // The keyboard stays in the dialog while it is open.
        const stops = [...layer.querySelectorAll("button")].filter((b) => !b.hidden && !b.disabled);
        const here = stops.indexOf(document.activeElement);
        e.preventDefault(); e.stopPropagation();
        const to = here < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (here + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
        stops[to]?.focus();
      }
    }
    dots.addEventListener("click", (e) => { const d = e.target.closest?.(".wn-dot"); if (d) { goTo(Number(d.dataset.at)); dots.querySelector(".wn-dot.on")?.focus(); } });
    close.addEventListener("click", () => shut(true));
    go.addEventListener("click", () => { const place = list[at]?.go?.to; if (place) shut(true, place); });
    next.addEventListener("click", () => { if (at === list.length - 1) shut(true); else { goTo(at + 1); next.focus(); } });

    return {
      /** Opens it on the first slide. `shipped`: ids of `ships: false` lines that have shipped since. */
      open(options = {}) {
        if (typeof options.release === "string" && /^\d+\.\d+(\.\d+)?$/.test(options.release)) release = options.release;
        list = slides(options.shipped); at = 0;
        if (layer.hidden) back = document.activeElement;
        layer.hidden = false;
        faces();
        paint();
        level();
        root.removeEventListener("resize", level);
        root.addEventListener("resize", level);
        document.removeEventListener("keydown", keys, true);
        document.addEventListener("keydown", keys, true);
        document.removeEventListener("visibilitychange", onVisible);
        document.addEventListener("visibilitychange", onVisible);
        motion?.removeEventListener?.("change", onMotion);
        motion?.addEventListener?.("change", onMotion);
        next.focus({ preventScroll: true });
      },
      close: (seen) => shut(seen), isOpen: () => !layer.hidden,
    };
  }

  root.DgcWhatsNew = { mount, slides, alsoNew };
})();
