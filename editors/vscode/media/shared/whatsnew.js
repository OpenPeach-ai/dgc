// "What's new in 0.52" (pips-flow-design §3.3, item 1; the look of 17 Nov, the slides of 24 Nov): a dialog in the side
// bar the first time 0.52's side bar is shown, one slide at a time. Each slide is a card: a picture on top, a still of
// the thing the slide is about, made of DGC's own parts, as a glass panel on a soft two-stop backdrop in the slide's own
// hue, playing out its story (a loop of 6 s, transforms and opacity only; still under reduced motion, at its final
// frame; paused while the window is hidden), with × at its top right and the dots on its bottom edge. Under it a quiet
// eyebrow, the title, and three rows: an icon, a heading and a muted line or two. Then a footer under a hairline: the
// slide's own action on the left (Open Pips, Open DGC Browser, Open Library, Open Work, Open Settings), Next on the
// right (Done on the last), and the arrow keys.
//
// The picture has two forms, so its words can be read in any side bar: wide (the card 400 px or more: 16:9, two parts
// side by side) and narrow (under 400 px: 4:3, the one part that tells the story, drawn larger).
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
  // What 0.52 ships, in a user's words; each line was checked against the code at this commit (24 Nov). Three rows a
  // slide. Where each is so: a Pip's chat, computer and copy (dgc/pip_computer.py, dgc/pip_folder.py), its levels
  // (dgc/pip_levels.py), its daily limit and Always allow (src/pipPay.js, dgc/pip_action_grants.py); DGC Browser
  // (dgc/dgc_browser.py, the dock's menu in media/main.js); comments (dgc/artifact_comments.py,
  // media/shared/comments.js); the canvas (dgc/artifact_design.py, media/artifactDesign.js); checklists
  // (dgc/artifact_checklist.py, dgc/checklists.py, the Output chip in media/main.js); Home's cards and the Library
  // (media/shared/homecards.js, media/library.js); a typed /goal, the plan's steps, a link's preview and Archive
  // (media/main.js, media/shared/linkpreview.js).
  const SLIDES = [
    { scene: "pips", hue: "violet", title: "Pips, each with a computer of its own", go: { to: "pips", label: "Open Pips" }, rows: [
      { id: "pip-own", icon: "vm", head: "Its own chat, its own computer", text: "A Pip tells you what it found in its chat, and works on a desktop of its own, in its own copy of a folder you give it." },
      { id: "levels", icon: "shield", head: "You choose how much it asks", text: "Ask me first, Approve for me, or Do it all. Set it for each Pip, in its prompt box." },
      { id: "pay-limit", icon: "credit-card", head: "A daily limit in dollars", text: "The most a Pip may pay by itself in a day. Always allow on a card lets that same step run next time without asking." },
    ] },
    { scene: "browser", hue: "teal", title: "DGC Browser", go: { to: "browser", label: "Open DGC Browser" }, rows: [
      { id: "yb-chrome", icon: "globe", head: "Chrome, with your sign-ins", text: "Sign in to your sites once. It opens beside the editor, or in a tab when DGC runs on another computer." },
      { id: "yb-pip-tab", icon: "browser", head: "Pips and Work, each in its own tab", text: "Say “use the DGC browser” in Work, or let a Pip: only on sites you allow, never in your tabs. You can watch." },
      { id: "yb-menu", icon: "settings", head: "You decide, from the dock", text: "DGC Browser's menu there has Sites Pips can use and Clear browsing data." },
    ] },
    { scene: "comments", hue: "amber", title: "Comment on anything DGC made", go: { to: "library", label: "Open Library" }, rows: [
      { id: "cm-pick", icon: "comment", head: "Point at a part and say it", text: "Pick words in a doc, cells in a sheet, a slide, part of a page or a checklist item, and comment." },
      { id: "cm-ask", icon: "comment-discussion", head: "Ask DGC", text: "DGC answers in the thread, or makes the change and says so." },
      { id: "cm-suggest", icon: "edit", head: "Suggestions you accept", text: "In a doc or a page, new wording comes as a suggestion: Accept or Reject each one." },
    ] },
    { scene: "canvas", hue: "blue", title: "A design canvas, drawn while you watch", go: { to: "work", label: "Open Work" }, rows: [
      { id: "cv-boards", icon: "device-mobile", head: "Screens, side by side", text: "Ask for a design and DGC draws each artboard in turn: desktop, phone, tablet, a poster." },
      { id: "cv-steer", icon: "comment", head: "Steer it as it draws", text: "Comment on an artboard, or ask in the chat, and DGC changes that screen." },
      { id: "cv-play", icon: "play", head: "Play it, then take it along", text: "Click through the prototype. Download the artboards as pictures, a PDF or a web page." },
    ] },
    { scene: "checklist", hue: "green", title: "DGC keeps a checklist", go: { to: "work", label: "Open Work" }, rows: [
      { id: "ck-make", icon: "checklist", head: "A checklist for the job", text: "Ask for one, or pick Checklist under Output. Each item says what done means." },
      { id: "ck-work", icon: "check", head: "Worked through, with proof", text: "DGC takes one item at a time, and ticks it with a note and its proof." },
      { id: "ck-yours", icon: "edit", head: "Yours to change", text: "Tick, reopen, edit and add items in its panel. Pinned to a project, every new chat there carries on with it." },
    ] },
    { scene: "home-library", hue: "azure", title: "Home in cards, and one Library", go: { to: "library", label: "Open Library" }, rows: [
      { id: "cards", icon: "layout", head: "Home, arranged by you", text: "Needs you, Running now, Token usage, Notes, Clock, Weather and more, as cards you add and move." },
      { id: "library", icon: "library", head: "One Library for everything", text: "Pages, docs, sheets, decks, dashboards, widgets, pictures, videos and files, from Chat, Work and Pips." },
      { id: "lib-find", icon: "favorite", head: "Find it again", text: "Search, a tab for each kind, filters, and a star for your favorites." },
    ] },
    { scene: "work", hue: "copper", title: "Work: goals, steps and previews", go: { to: "work", label: "Open Work" }, rows: [
      { id: "goal", icon: "target", head: "Type /goal and what you want", text: "“/goal fix the failing tests” starts a goal: DGC keeps going, turn after turn, until it is done." },
      { id: "steps", icon: "list-unordered", head: "The steps, as it works", text: "A turn's plan shows as steps that tick off one by one." },
      { id: "links", icon: "link-external", head: "A peek at a link, a tidy list", text: "Point at a link in a chat to see its page. Archive finished sessions, and bring them back any time." },
    ] },
    { scene: "also", hue: "neutral", title: "Also new", go: { to: "settings", label: "Open Settings" }, rows: [
      { id: "picker", icon: "layers", head: "One model picker", text: "Every model you've added, in one place, for Chat, Work and Pips." },
      { id: "auto", icon: "shield", head: "Auto that stays out of your way", text: "Everyday steps just run. A risky one stops and says why; your yes lets it go." },
      { id: "settings", icon: "settings", head: "Settings by asking", text: "Say “use 8 Pip runs at once”, and it changes, with Undo in the chat." },
    ] },
  ];
  /** The slides: its scene, its hue, its title, its action ({to, label}) and its rows ({id, icon, head, text}). */
  function slides() {
    return SLIDES.map((s) => ({ scene: s.scene, hue: s.hue, title: s.title, go: s.go ? { ...s.go } : null, rows: s.rows.map(({ id, icon, head, text }) => ({ id, icon, head, text })) }));
  }

  // ---- the pictures: stills of DGC's own things, made of their own parts -----------------------------------------------
  // Each scene is drawn with the parts the real pages draw with: a Pip's face from the faces' renderer
  // (window.PipConcepts.plush, the same sprite the Pips list, Home and the dock use), a session's or a widget's mark
  // (window.DgcMarks), a file's sheet (window.DgcFileSheet), the icons (window.DgcIcons), DGC Browser's halo
  // (media/icons/browser-halo), Home's cards, the Library's rows, a comment's thread (media/shared/comments.css), a
  // link's preview card (media/shared/linkpreview.css), a turn's steps (Work's own marks, lent by the page) and the one
  // family of buttons, each in its own classes and stylesheets. A Pip's computer's apps are its own icons
  // (media/pips/apps), from where the page already loads the extension's files; so are the canvas's artboards, pictures
  // of a real design's own boards (media/whatsnew). A checklist's items and an artboard's frame live in the artifact's
  // own page, whose stylesheet the side bar doesn't load: they are drawn here to the same measures (media/artifact.css
  // .ck-*, media/artifactDesign.css), with the shared tick, sheet and buttons.
  //
  // A scene is laid out at a fixed size, as on a page, and the whole picture is scaled to its frame: 480 × 270 in the
  // wide form (two parts side by side), 288 × 216 in the narrow one, where only the part that tells the story is drawn
  // (a part marked wn-w is the wide form's alone, wn-n the narrow one's), so its words stay readable in a 290 px side
  // bar. Nothing in it can be pressed or reached by Tab: its controls are drawn as plain words (asPicture()).
  //
  // Each scene is drawn at its last frame (what reduced motion shows), and says how it gets there: `moves(A, narrow)`
  // with the steps below, on one 6 s loop. Everything that moves fades out together near the loop's end, and the
  // story starts again.
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
    return node;
  }
  const KINDS = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"];
  let faces = 0;
  /** A Pip's face, as the Pips list draws it: its kind, its pose ("idle" breathes and blinks). */
  const face = (kind, state = "idle") => { const P = root.PipConcepts?.plush; let m = "";
    try { m = P ? P.markup({ index: KINDS.indexOf(kind), name: kind[0].toUpperCase() + kind.slice(1) }, state, `wn-face-${++faces}`, { includeStyles: false }) : ""; } catch { m = ""; }
    return m; };
  const mark = (kind, palette, moving = false) => root.DgcMarks?.of?.(kind, palette, { moving, id: `wn-${kind}-${palette}` }) || "";
  const sheet = (what, small = false) => { let m = ""; try { m = root.DgcFileSheet ? root.DgcFileSheet.html(what) : ""; } catch { m = ""; } return small ? m.replace('class="dgc-sheet"', 'class="dgc-sheet dgc-sheet-sm"') : m; };
  const glyph = (name, size = 16) => root.DgcIcons?.html?.(name, { size }) || "";
  // The extension's media folder, from where this script (or the Pips bundle) was loaded: a Pip's computer's apps.
  const here = (typeof document !== "undefined" && document.currentScript?.src) || "";
  const mediaUrl = (path) => {
    const scripts = typeof document !== "undefined" ? [...document.scripts].map((s) => s.src) : [];
    const own = here || scripts.find((s) => /\/media\/shared\/whatsnew\.js(?:[?#]|$)/.test(s)), bundle = scripts.find((s) => /\/dist\/[A-Za-z]+\.js(?:[?#]|$)/.test(s));
    try { return own ? new URL(`../${path}`, own).href : bundle ? new URL(`../media/${path}`, bundle).href : ""; } catch { return ""; }
  };
  const app = (name) => { const i = el("img", "wn-app"); i.alt = ""; const src = mediaUrl(`pips/apps/${name}.png`); if (src) i.src = src; return i; };

  // Home's cards (media/shared/homecards.css): a card, its head, its rows.
  const card = (kind, ...kids) => { const [name, ...more] = kind.split(" "); const c = el("section", `hc-card hc-${name}${more.length ? " " + more.join(" ") : ""}`); c.dataset.card = name; c.dataset.form = "m"; for (const k of kids) if (k) c.append(k); return c; };
  const head = (title, ...more) => box("hc-ch", span("hc-ct", title), ...more);
  /** A row of a card: its icon (one of DGC's parts, as markup, or a node), its name, its line (words, or a node), and what ends it. */
  const row = (icon, name, meta, end) => { const li = span("hc-li"); const ico = typeof icon === "string" ? part("span", "hc-ico", icon) : span("hc-ico", icon);
    li.append(ico, span("hc-tx", typeof name === "string" ? span("hc-nm", name) : name, typeof meta === "string" ? span("hc-meta", meta) : meta)); if (end) li.append(end); return li; };
  const list = (...rows) => box("hc-list", ...rows);
  /** One of the button family, with its glyph (a picture of it: asPicture() makes it plain words). */
  const btn = (cls, word, icon) => { const b = el("button", `dgc-btn small ${cls}`.trim()); b.type = "button"; if (icon) b.insertAdjacentHTML("afterbegin", glyph(icon, 14)); b.append(word); return b; };
  /** What you sent in a chat, as Work draws it. */
  const sent = (words) => { const m = box("msg user wn-said", box("bubble", box("prompt-text"))); m.querySelector(".prompt-text").textContent = words; return m; };

  const SCENES = {
    // Your Pips, the faces as they are; Scout is chosen, and what it has of its own ticks in beside it: its chat, its
    // computer (its Browser, Files and Terminal, by their own icons) and how much it asks.
    pips: () => {
      const core = span("hc-nm", "Core "); core.append(span("hc-star", "★"));
      const rows = [row(face("core"), core, "Ready when you are"), row(face("scout"), "Scout", "Checking lime_tiles"), row(face("quill"), "Quill", "Morning brief at 8:00")];
      const chosen = el("i", "wn-sel"); rows[1].prepend(chosen);
      const own = [row(glyph("comment-discussion", 16), "Its own chat", "Says what it found"),
        row(glyph("vm", 16), "Its own computer", span("wn-apps", app("browser"), app("files"), app("terminal"))),
        row(glyph("shield", 16), "Ask me first", "Asks before it sends")];
      const mine = card("wn-own", box("hc-ch", part("span", "hc-ico wn-head-face", face("scout")), span("hc-ct", "Scout")), list(...own));
      return { nodes: [card("pips wn-w", head("Pips"), list(...rows)), mine],
        moves(A, narrow) { const t = narrow ? 0.3 : 1.9;
          rows.forEach((r, i) => A.arrive(r, 0.3 + i * 0.3, { dy: 10 })); A.arrive(chosen, 1.6, { dy: 0 }); A.press(rows[1], 1.55);
          A.arrive(mine, t, { dx: narrow ? 0 : -14, dy: narrow ? 10 : 0 }); own.forEach((n, i) => A.arrive(n, t + 0.5 + i * 0.5, { dy: 8 })); } };
    },
    // DGC Browser: your own tabs, then a Pip's tab, with its face and the dock's words while it works there. Beside
    // it, the sites your Pips may use.
    browser: () => {
      const live = span("hc-livedot");
      const tabs = [row(glyph("globe", 16), "Flights to Lisbon", "Your tab · signed in"), row(glyph("globe", 16), "Mail", "Your tab · signed in"), row(face("pulse"), "Ava's tab", "Ava is working in it", live)];
      const mine = card("wn-yb", box("hc-ch", part("span", "hc-ico", '<span class="halo wn-halo" aria-hidden="true"><i></i><i></i><i></i></span>'), span("hc-ct", "DGC Browser")), list(...tabs));
      const site = (name, who, tag) => { const li = span("hc-li wn-site", span("hc-tx", span("yb-site-name", name), span("hc-meta", who))); if (tag) li.append(span("yb-site-tag", tag)); return li; };
      const sites = [site("mail.example", "Every Pip"), site("shop.example", "Ava"), site("bank.example", "No Pip", "Bank")];
      return { nodes: [mine, card("wn-sites wn-w", head("Sites Pips can use"), list(...sites))],
        moves(A) { A.arrive(tabs[0], 0.3); A.arrive(tabs[1], 0.6); A.arrive(tabs[2], 1.4, { dx: -12, dy: 0 }); A.pulse(live, 1.9);
          sites.forEach((s, i) => A.arrive(s, 2.8 + i * 0.35)); } };
    },
    // A comment on part of a doc: what you said, DGC's wording as a suggestion, Accept, and it says so as the doc's
    // words change.
    comments: () => {
      const OLD = "The rollout will be done in several careful stages.", NEW = "We roll out in stages.";
      const para = (words, cls) => { const p = el("p", "wn-doc-p" + (cls ? " " + cls : "")); p.append("We ship on Friday. ", el("mark", "wn-pick", words), " Support is ready."); return p; };
      const was = para(OLD, "was"), now = para(NEW);
      const doc = card("wn-doc wn-w", box("hc-ch", part("span", "hc-ico", sheet("doc", true)), span("hc-ct", "Launch plan")), box("wn-doc-body", was, now));
      const mine = el("li", "dgc-cm-msg"); mine.dataset.by = "you";
      mine.append(box("dgc-cm-msg-top", span("dgc-cm-who", "You")), el("p", "dgc-cm-text", "Shorter, please."));
      const yes = btn("primary", "Accept"), sug = el("li", "dgc-cm-sug"); sug.dataset.state = "open";
      // (Accept and Reject, and what takes their place once it is accepted: one place, as a tab's two states are.)
      const acts = box("dgc-cm-sug-acts was", yes, btn("", "Reject")), kept = span("dgc-cm-sug-state", "Accepted · version 2");
      sug.append(box("dgc-cm-sug-words", el("del", "dgc-cm-was", OLD), el("ins", "dgc-cm-now", NEW)), box("wn-sug-end", acts, kept));
      const msgs = el("ol", "dgc-cm-msgs"), sugs = el("ul", "dgc-cm-sugs"); msgs.append(mine); sugs.append(sug);
      const thread = box("dgc-cm-thread wn-thread", msgs, sugs);
      return { nodes: [doc, thread],
        moves(A, narrow) { A.arrive(thread, 0.4, { dx: narrow ? 0 : 12, dy: narrow ? 10 : 0 }); A.arrive(mine, 0.9); A.arrive(sug, 2.0); A.press(yes, 3.5); A.swap(acts, kept, 3.8); A.swap(was, now, 3.8); } };
    },
    // The canvas, with a real design DGC drew on it (a bakery's landing page, from a user test: its desktop and phone
    // artboards as pictures, media/whatsnew): each artboard is drawn from the top down while you watch, desktop then
    // phone; a comment lands on the desktop one, and its headline changes (the picture of that board before the comment
    // gives way to the one after: what the comment really changed). In the narrow form, the desktop artboard alone.
    canvas: () => {
      const pic = (name, cls) => { const i = el("img", "wn-board-pic" + (cls ? " " + cls : "")); i.alt = ""; const src = mediaUrl(`whatsnew/${name}.webp`); if (src) i.src = src; return i; };
      const before = pic("canvas-desktop-before", "was"), after = pic("canvas-desktop"), covers = [el("i", "wn-cover"), el("i", "wn-cover")];
      const pin = part("span", "wn-pin", glyph("comment", 12));
      // (Each named as the canvas names it: the artboard's own title, then its size.)
      const board = (cls, title, size, ...kids) => box("wn-board " + cls, span("wn-board-name", span("wn-board-title", title), " ", span("wn-board-size", size)), box("wn-board-frame", ...kids));
      const d = board("desktop", "Desktop home", "1440 × 900", after, before, covers[0], pin), p = board("phone wn-w", "Phone", "390 × 844", pic("canvas-phone"), covers[1]);
      const bar = box("wn-canvas-bar wn-w", part("span", "hc-ico", sheet("design", true)), span("hc-ct", "Bakery Landing Page"), span("hc-sp"), btn("", "Play", "play"), btn("", "Download", "download"));
      return { nodes: [box("wn-canvas", bar, box("wn-boards", d, p))],
        moves(A, narrow) { A.arrive(d, 0.2, { dy: 6 }); A.reveal(covers[0], 0.6, narrow ? 1.8 : 1.3); A.arrive(p, 1.9, { dy: 6 }); A.reveal(covers[1], 2.2, 1.1);
          A.arrive(pin, 3.6, { dy: 0, s: 0.4, dur: 0.3 }); A.swap(before, after, 4.2, 0.5); } };
    },
    // A checklist: its items, each ticked in turn as the bar fills; beside it, what done means for one, and its proof.
    checklist: () => {
      // (An item that gets done in the story: its tick, and its status before and after in one place.)
      const item = (title, status, done) => { const on = part("i", "wn-ck-on", glyph("check", 12)), li = el("li", "wn-ck-item"), was = span("wn-ck-chip was", "Testing"), now = span("wn-ck-chip", status);
        li.dataset.status = status; li.append(span("wn-ck-tick", done ? on : null), span("wn-ck-title", title), done ? span("wn-two", was, now) : now); return { li, on, was, now }; };
      const items = [item("Fix the totals", "Done", true), item("Add the tests", "Done", true), item("Check it live", "Testing", false)];
      const ul = el("ul", "wn-ck-list"); ul.append(...items.map((i) => i.li));
      const fill = el("i", "wn-ck-fill");
      const sum = span("hc-cap wn-ck-sum", "2 of 3 done");
      const main = card("wn-ck", box("hc-ch", part("span", "hc-ico", sheet("checklist", true)), span("hc-ct", "Release 2.4"), span("hc-sp"), sum), box("wn-ck-bar", fill), ul);
      const line = (label, words, cls) => box("wn-ck-line", span("wn-ck-label", label), span(cls, words));
      const lines = [line("Done means", "Every total has a test.", "wn-ck-words"), line("Proof", "pytest: 212 passed", "wn-ck-words wn-ck-proof")];
      const detail = card("wn-ck-detail wn-w", head("Add the tests"), ...lines);
      return { nodes: [main, detail],
        moves(A) { items.forEach((i, k) => A.arrive(i.li, 0.3 + k * 0.25)); [1.4, 2.4].forEach((t, k) => { A.arrive(items[k].on, t, { dy: 0, s: 0.4, dur: 0.25 }); A.swap(items[k].was, items[k].now, t, 0.25); });
          A.fill(fill, [[1.4, 0.5], [2.4, 1]]); A.arrive(sum, 2.5, { dy: 0 }); A.arrive(detail, 2.9, { dx: -10, dy: 0 }); lines.forEach((n, k) => A.arrive(n, 3.3 + k * 0.4, { dy: 6 })); } };
    },
    // Home's own cards settle, the week's bars fill in; the Library's rows arrive, and one gets its star.
    "home-library": () => {
      const needs = card("needs", head("Needs you", span("hc-cnt", "1")), list(row(face("scout", "waiting_approval"), "Scout", "Wants your okay")));
      const days = [5, 3, 6, 4, 7, 5, 6].map((on) => { const c = span("hc-col"); for (let k = 0; k < 8; k++) c.append(el("i", "hc-cell" + (k < on ? " on" : k === on ? " cap" : ""))); return c; });
      const token = card("token", box("hc-ch", span("hc-ct", "Token usage")), box("hc-chart", box("hc-plot", ...days)));
      const star = part("span", "lib-row-more wn-star", glyph("unfavorite", 14));
      const libRow = (icon, name, by, when, end) => { const r = el("li", "lib-row"); r.append(part("span", `lib-row-thumb ${icon.startsWith("<span class=\"dgc-sheet") ? "lib-row-sheet" : "lib-row-mark"}`, icon),
        span("lib-row-main", span("lib-row-name", name), span("lib-row-meta", span("lib-row-by", "by "), span("lib-row-maker", by), span("lib-row-when", ` · ${when}`))), end || part("span", "lib-row-more", glyph("more"))); return r; };
      const rows = [libRow(sheet("page", true), "Q3 plan", "Scout", "40m", star), libRow(sheet("sheet", true), "Trip costs", "Chat", "2h"), libRow(mark("widget", "fern"), "Weekly sales", "Work", "1d")];
      const ul = el("ul", "lib-list wn-lib-rows"); ul.append(...rows);
      const lib = box("dgc-lib wn-lib", box("wn-lib-head", part("span", "hc-ico", glyph("library", 16)), span("hc-ct", "Library")), ul);
      return { nodes: [box("wn-home wn-w", needs, token), lib],
        moves(A, narrow) { const t = narrow ? 0.3 : 1.7;
          A.arrive(needs, 0.2, { dy: 12, s: 0.97 }); A.arrive(token, 0.5, { dy: 12, s: 0.97 }); days.forEach((d, i) => A.grow(d, 0.9 + i * 0.08));
          A.arrive(lib, t, { dx: narrow ? 0 : 12, dy: narrow ? 10 : 0 }); rows.forEach((r, i) => A.arrive(r, t + 0.4 + i * 0.3)); A.arrive(star, t + 2, { dy: 0, s: 0.4, dur: 0.3 }); } };
    },
    // Work: a goal typed as /goal, a link's preview card, and the turn's steps ticking off as it works.
    work: (lend) => {
      const said = sent("/goal fix the failing tests");
      const link = box("dgc-linkcard wn-link", box("dgc-linkcard-top", part("span", "dgc-linkcard-icon", glyph("globe", 14)), span("dgc-linkcard-site", "docs.example.com")),
        box("dgc-linkcard-words", box("dgc-linkcard-title", "Running the tests"), box("dgc-linkcard-desc", "One file, or all of them.")));
      // (A step that gets done in the story: its ring and its check, its words before and after, each in one place.)
      const step = (label, status, mk) => { const li = el("li", "todo"), done = status === "done", mark = (m, cls) => part("span", "wn-mark" + cls, lend?.planMark?.(m, true) || "");
        const was = [mark("next", " was"), span("todo-label wn-todo was", label)], now = [mark(mk, ""), span("todo-label", label)]; li.dataset.status = status; li.dataset.mark = mk;
        li.append(box("todo-row", span("todo-markbox wn-two", done ? was[0] : null, now[0]), span("todo-text wn-two", done ? was[1] : null, now[1]))); return { li, was, now }; };
      const steps = [step("Find the failing tests", "done", "done"), step("Fix the rounding", "done", "done"), step("Running the suite", "in_progress", "doing")];
      const ol = el("ol", "todos-list"); ol.append(...steps.map((s) => s.li));
      const fill = el("span", "todos-fill wn-fill");
      const plan = box("todos-card wn-plan", box("todos-head", span("todos-trigger", span("todos-words", span("todos-title", "Tasks"), span("todos-sum", "2 of 3 done")))), span("todos-track", fill), box("todos-body", ol));
      return { nodes: [box("wn-chat wn-w", said, link), plan],
        moves(A, narrow) { A.arrive(said, 0.3, { dx: 16, dy: 0 }); A.arrive(plan, narrow ? 0.3 : 1.1, { dy: 10 });
          const t = narrow ? 0.7 : 1.5; steps.forEach((s, i) => A.arrive(s.li, t + i * 0.3, { dy: 6 }));
          [t + 1.2, t + 2].forEach((at, k) => { A.swap(steps[k].was[0], steps[k].now[0], at, 0.25); A.swap(steps[k].was[1], steps[k].now[1], at, 0.25); }); A.fill(fill, [[t + 1.2, 0.5], [t + 2, 1]]);
          A.arrive(link, 4.1, { dy: 8 }); } };
    },
    // A setting changed by asking, in a Work chat: what you sent, and the quiet line the change leaves, with Undo. And
    // three more of what is new.
    also: (lend) => {
      const said = sent("Use 8 Pip runs at once");
      const line = box("sys sys-marked setting-change"); line.dataset.state = "changed";
      const ic = lend?.icon?.("sliders-horizontal"); if (ic) line.insertAdjacentHTML("afterbegin", ic);
      line.append(span("setting-change-text", span("setting-change-words", "Changed Pip runs at once from 4 to 8")), span("link setting-change-undo", "Undo"));
      const more = [row(glyph("arrow-swap", 16), "A fallback model", "When yours can't answer"), row(glyph("eye-closed", 16), "An incognito chat", "Never saved or listed"),
        row(glyph("download", 16), "Pictures in a chat", "Download or save them")];
      const also = card("wn-also", head("And more"), list(...more));
      return { nodes: [box("wn-chat wn-w", said, line), also],
        moves(A, narrow) { A.arrive(said, 0.4, { dx: 16, dy: 0 }); A.arrive(line, 1.4, { dy: 8 }); if (line.firstElementChild?.tagName === "svg") A.arrive(line.firstElementChild, 1.7, { dy: 0, s: 0.4 });
          const t = narrow ? 0.3 : 2.4; A.arrive(also, t, { dy: 10 }); more.forEach((r, i) => A.arrive(r, t + 0.4 + i * (narrow ? 0.6 : 0.3), { dy: 6 })); } };
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
      /** A cover that draws back, from the top down, off what is under it at `t` (an artboard drawn while you watch),
       *  and is over it again for the next loop once all has faded. Its last frame: gone. */
      reveal(node, t, dur = 1.2) {
        const on = { scale: "1 1" }, off = { scale: "1 0" };
        run(node, [{ ...on, offset: 0 }, { ...on, offset: at(t), easing: "cubic-bezier(.45,0,.25,1)" }, { ...off, offset: at(t + dur) }, { ...off, offset: at(END + 0.35) }, { ...on, offset: at(END + 0.4) }, { ...on, offset: 1 }]);
      },
      /** A bar that fills in steps: at each [t, part] it grows to that part of its full length, and stays. */
      fill(node, steps) {
        const frames = [{ opacity: 1, scale: "0 1", offset: 0 }]; let last = 0;
        for (const [t, v] of steps) { frames.push({ opacity: 1, scale: `${last} 1`, offset: at(t), easing: EASE }, { opacity: 1, scale: `${v} 1`, offset: at(t + 0.5) }); last = v; }
        frames.push({ opacity: 1, scale: `${last} 1`, offset: at(END) }, { opacity: 0, scale: `${last} 1`, offset: at(END + 0.35) }, { opacity: 0, scale: "0 1", offset: at(END + 0.4) }, { opacity: 1, scale: "0 1", offset: at(END + 0.45) }, { opacity: 1, scale: "0 1", offset: 1 });
        run(node, frames);
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
  // The picture's two forms: the card's width where the narrow one gives way to the wide one, and the size each is laid out at.
  const WIDE_FROM = 400, FORMS = { wide: 480, narrow: 288 };
  /** `icon(name)`, `planMark(mark, running)`: what the page lends the pictures of its own (Work's own glyphs and a
   *  step's mark, as its chat draws them). `can(to)`: whether a slide's action has somewhere to go here (false: the
   *  slide keeps its words and shows no action). */
  function mount(layer, { onSeen, onGo, release = "0.52", icon: pageIcon, planMark, can } = {}) {
    let list = slides(), at = 0, back = null, moving = [], story = null, faced = null, form = "";
    const lent = (fn) => (typeof fn === "function" ? (...args) => { try { return String(fn(...args) || ""); } catch { return ""; } } : null);
    const lend = { icon: lent(pageIcon), planMark: lent(planMark) };
    const offered = (go) => { if (!go) return false; if (typeof can !== "function") return true; try { return can(go.to) !== false; } catch { return true; } };
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
      try { story.moves(animator(moving), form === "narrow"); } catch { stop(); }
      if (hidden()) for (const a of moving) a.pause();
    }
    // The window hidden: the story waits, and so do the parts' own lives (a face's breath and blink, a session's mark).
    const onVisible = () => { stage.classList.toggle("wn-paused", hidden()); for (const a of moving) { try { if (hidden()) a.pause(); else a.play(); } catch { /* gone */ } } };
    // The still is laid out at its form's own size, as on a page, and scaled to the picture's width. A side bar dragged
    // across the two forms' border starts the story again in the other one.
    const fit = () => {
      const w = picture.clientWidth; if (!(w > 0)) return;
      const next = w < WIDE_FROM ? "narrow" : "wide", changed = next !== form;
      form = next; picture.dataset.form = form; picture.style.setProperty("--wn-k", String(w / FORMS[form]));
      if (changed && story && !layer.hidden) play();
    };
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
      story = null;                                                 // (fit() below plays nothing of the slide before)
      const scene = SCENES[slide.scene] ? SCENES[slide.scene](lend) : { nodes: [] };
      for (const n of scene.nodes) asPicture(n);
      // (In Home's own frame, .dgc-home: its cards' colours and corners are Home's tokens.)
      stage.replaceChildren(box("wn-glass", box("wn-scene dgc-home wn-scene-" + slide.scene, ...scene.nodes)));
      stage.classList.toggle("wn-paused", hidden());
      fit();
      story = scene;
      kicker.textContent = `What's new in DGC ${release}`;
      words(slide);
      dots.replaceChildren(...list.map((s, i) => { const d = el("button", "wn-dot" + (i === at ? " on" : "")); d.type = "button"; d.dataset.at = String(i);
        d.setAttribute("aria-label", `Slide ${i + 1} of ${list.length}: ${s.title}`); if (i === at) d.setAttribute("aria-current", "step"); return d; }));
      step.textContent = `${at + 1} of ${list.length}`;
      go.hidden = !offered(slide.go);
      go.textContent = go.hidden ? "" : slide.go.label;
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
    go.addEventListener("click", () => { const place = offered(list[at]?.go) ? list[at].go.to : ""; if (place) shut(true, place); });
    next.addEventListener("click", () => { if (at === list.length - 1) shut(true); else { goTo(at + 1); next.focus(); } });

    return {
      /** Opens it on the first slide. */
      open(options = {}) {
        if (typeof options.release === "string" && /^\d+\.\d+(\.\d+)?$/.test(options.release)) release = options.release;
        list = slides(); at = 0;
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

  root.DgcWhatsNew = { mount, slides };
})();
