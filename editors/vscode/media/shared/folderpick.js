// The Project Folder dropdown (0.52, 12 Nov): one button that names the folder chosen and opens the shared menu
// (media/shared/menu.js) with "All projects", then the folders that have a session or a Project Pip, this window's marked
// and a gone one marked "Not found", and (where a folder can be added) "Add a folder…" at its end. The same button and
// menu over the Work sessions, in New Session's dialog, on the Pips view's Project tab and in Create a Project Pip.
// media/shared/folderpick.css is how it looks. A classic script: Work's page loads it before its own script and the Pips
// bundle imports it, so both share window.DgcFolderPick. The page keeps the choice; this file draws and answers keys.
// Two small elements do the fitting no stylesheet can (asked 12 Nov night): <dgc-folder-fit> holds the button on a row
// it shares (Library's, the search field's) or has to itself (the Pips view's Project tab) and drops its "Project Folder" word when the
// row has no room for it; <dgc-path> cuts a long path before its folder's own name, exactly at a letter, so no space
// shows before the name's slash.
// Its shape and motion (asked 13 Nov): the button has the shared button's corner, and the open menu grows out of it as
// one shape with one line around both (drawn here, as one outline: the button's corners next to the menu go square, and
// where the menu is wider than the button it reaches away from the side the button is on, with a small rounded inner
// corner at the join). The shape grows on a soft spring, each row arrives in turn from the button, and they leave in
// reverse; the chevron's two strokes turn into an ×. All of it is this file's own: a small spring, sampled into
// keyframes for the page's own animations. With reduced motion nothing moves: it opens and closes at once.
// Held inside the view (asked 13 Nov): the menu ends above the dock (in a dialog, above the view's end) and shows about
// 8 folders, then it scrolls inside; with more than 8 folders a search field stays at its top (type to narrow by name
// or path; Down goes to the folders, Enter takes the first one found, Escape clears what was typed, then closes). Its
// ground is always an opaque colour: a theme whose input background is see-through (Cursor's dark themes) let the page
// under the menu show through it.
// A row's pin (a Work folder on the dock, 13 Nov; a button of its own since 14 Nov): beside its row, never inside it (a
// button can't hold a button), over the room the row keeps for it. Right from a row goes to its pin, Left back; Up and
// Down from a pin move on from its row. (The menu's first line that pinned the chosen folder went on 14 Nov: each
// row's own pin does it.)
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcFolderPick) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Two strokes: a chevron at rest, an × while the menu is open (folderpick.css turns one into the other).
  const CHEVRON = '<svg class="dgc-folder-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path class="dgc-folder-chevron-a" d="M4.5 6.5 L8 10"/><path class="dgc-folder-chevron-b" d="M8 10 L11.5 6.5"/></svg>';
  const CHECK = '<svg class="dgc-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  // A row's mark: a folder, a stack for All projects, a plus for Add a folder…. Drawn here in the codicons' line (the
  // Pips view's own root has no icon font).
  const MARKS = { folder: '<path d="M1.75 4.5a1 1 0 0 1 1-1h3.2l1.5 1.5h5.8a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1z"/>',
    layers: '<path d="M8 2.25 14 5.4 8 8.55 2 5.4z"/><path d="m2.4 8.2 5.6 2.95 5.6-2.95"/><path d="m2.4 10.9 5.6 2.95 5.6-2.95"/>', add: '<path d="M8 3.25v9.5M3.25 8h9.5"/>' };
  const ALL = "All projects";
  // A pin, as the rows of the lists have it: an outline until its thing is on the dock, then filled.
  const PIN = (on) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z"/></svg>`;
  // ---- a folder's own icon (media/shared/folders.css, asked 13 Nov) ----------------------------------------------------
  // A Work folder is a directory, and wears the folder icon: the maintainer's set, built here in plain markup from its
  // reference component (its flap of four parts, two papers behind and one in front with three lines), always the
  // symbol alone, with no label, at the sizes it has here. Each folder has a palette of its own, one of the twelve the
  // session marks use, given once and kept by the extension as theirs are; the page says which (setPalette), and where
  // no page does (a Pips view in its own tab) it is the one the folder's path alone gives, the same every time. Still
  // at rest: its papers lift only while its row or its button is pointed at or has the keyboard (folderpick.css).
  const TWELVE = ["ember", "peach", "saffron", "fern", "mint", "lagoon", "ice", "azure", "iris", "lilac", "orchid", "rose"];
  const hash = (text) => { let h = 2166136261; for (const ch of String(text || "")) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  /** What a folder is called where its palette is kept: never its path. */
  const folderId = (folder) => `f${hash(String(folder || "").replace(/[\\/]+$/, "")).toString(36)}`;
  let paletteFor = null;
  /** The page's own account of each folder's palette: (folder) => one of the twelve, or "" when it has none to say. */
  function setPalette(fn) { paletteFor = typeof fn === "function" ? fn : null; }
  const paletteOf = (folder) => { let said = ""; try { said = paletteFor ? paletteFor(String(folder || "")) : ""; } catch { said = ""; } return TWELVE.includes(said) ? said : TWELVE[hash(folderId(folder)) % TWELVE.length]; };
  /** A folder's icon as HTML: decoration (its row or its button says the folder's name). */
  function folderMark(folder) {
    return `<span class="folder-icon folder--${paletteOf(folder)} dgc-folder-icon" aria-hidden="true"><span class="folder-flap"><i class="folder-tab"></i><i class="folder-tab-round"></i><i class="folder-tab-bridge"></i><i class="folder-flap-body"></i></span>`
      + '<i class="folder-paper folder-paper--back folder-paper--right"></i><i class="folder-paper folder-paper--back folder-paper--left"></i><span class="folder-paper folder-paper--front"><i class="folder-line"></i><i class="folder-line"></i><i class="folder-line"></i></span></span>';
  }
  const rowsOf = (rows) => (Array.isArray(rows) ? rows : []).filter((r) => r && typeof r.folder === "string" && r.folder).slice(0, 200);
  const nameOf = (folder) => String(folder || "").replace(/[\\/]+$/, "").split(/[\\/]/).pop() || String(folder || "");

  /** A folder on one line, cut in the middle when it doesn't fit: what comes before the folder's own name gives way
   *  first (its end becomes an ellipsis), so the name stays in sight. `shown` has the home folder as ~; the whole path
   *  is the tooltip. A <dgc-path>: it fits itself (below). */
  function pathHtml(shown, full, cls = "") {
    const cut = String(shown || "").replace(/[\\/]+$/, "") || String(shown || "");
    const at = Math.max(cut.lastIndexOf("/"), cut.lastIndexOf("\\"));
    const head = at > 0 ? cut.slice(0, at) : "", tail = at > 0 ? cut.slice(at) : cut;
    return `<dgc-path class="dgc-path${cls ? ` ${esc(cls)}` : ""}" title="${esc(full || shown)}">`
      + (head ? `<span class="dgc-path-head${head.length > 2 ? " dgc-path-long" : ""}">${esc(head)}</span>` : "") + `<span class="dgc-path-tail">${esc(tail)}</span></dgc-path>`;
  }
  /** The same as an element, for a page that builds its rows from nodes. */
  function pathNode(doc, shown, full, cls = "") {
    const holder = doc.createElement("div");
    holder.innerHTML = pathHtml(shown, full, cls);
    return holder.firstChild;
  }

  // ---- the two elements that fit themselves ----
  // Both are measured, never guessed, and neither changes its own box by fitting, so a fit can't ask for another.
  const text = (node) => { const r = node.ownerDocument.createRange(); r.selectNodeContents(node); return r.getBoundingClientRect().width; };
  /** A path: when what comes before the name doesn't fit, it is clipped exactly after its last whole letter, and an
   *  ellipsis of its own is drawn there with the name straight after it. (A stylesheet's ellipsis leaves whatever is
   *  left of a letter's width empty before the name: a space that isn't in the path.) The words stay whole in the page
   *  for a reader and a copy; without this element's script the stylesheet's ellipsis still shows. */
  function fitPath(path) {
    const head = path.querySelector(":scope > .dgc-path-head"), tail = path.querySelector(":scope > .dgc-path-tail");
    let dots = path.querySelector(":scope > .dgc-path-dots");
    path.classList.remove("is-cut");
    if (head) head.style.clipPath = "";
    if (tail) tail.style.transform = "";
    if (dots) dots.style.transform = "";
    const words = head && head.firstChild;
    if (!head || !tail || !words || words.nodeType !== 3 || text(head) <= head.getBoundingClientRect().width + 0.01) return;
    if (!dots) { dots = path.ownerDocument.createElement("span"); dots.className = "dgc-path-dots"; dots.setAttribute("aria-hidden", "true"); dots.textContent = "…"; head.after(dots); }
    path.classList.add("is-cut");                                        // the ellipsis takes its room; the head has the rest
    const room = head.getBoundingClientRect().width, range = path.ownerDocument.createRange(), said = words.data;
    const upTo = (n) => { range.setStart(words, 0); range.setEnd(words, n); return range.getBoundingClientRect().width; };
    let low = 0, high = said.length;
    while (low < high) { const mid = (low + high + 1) >> 1; if (upTo(mid) <= room + 0.01) low = mid; else high = mid - 1; }
    if (low > 0 && low < said.length && /[\uD800-\uDBFF]/.test(said[low - 1])) low--;      // never half of a letter
    const over = Math.max(0, room - upTo(low));
    head.style.clipPath = `inset(0 ${over}px 0 0)`;
    dots.style.transform = tail.style.transform = over ? `translateX(${-over}px)` : "";
  }
  /** The button on a row it shares: with its "Project Folder" word it must show the folder's name whole; when the row
   *  has no room for that the word goes (the button's label and tooltip still say it), and only then may a long name
   *  end in an ellipsis. */
  function fitButton(slot) {
    const value = slot.querySelector(".dgc-folder .dgc-folder-v");
    slot.removeAttribute("data-compact");
    if (value && text(value) > value.getBoundingClientRect().width + 0.01) slot.setAttribute("data-compact", "1");
  }
  const Element_ = root.HTMLElement, registry = root.customElements;
  if (Element_ && registry && typeof root.ResizeObserver === "function") {
    const living = new Set();
    const watcher = new root.ResizeObserver((entries) => { for (const e of entries) { if (living.has(e.target)) e.target.fit(); else for (const item of living) if (item.rowWatched === e.target) item.fit(); } });
    const refit = () => { for (const item of living) item.fit(); };
    try { root.document?.fonts?.addEventListener?.("loadingdone", refit); } catch { /* an older page: the next resize fits */ }
    const define = (name, fit, { row = false } = {}) => {
      if (registry.get(name)) return;
      registry.define(name, class extends Element_ {
        // (The first fit comes with the watcher's first look, before the page is painted: nothing is measured while a
        // long list is still being built.)
        connectedCallback() {
          living.add(this);
          if (row) {
            // The row it is on decides its room; what it holds may be drawn again (another choice).
            this.rowWatched = this.parentElement; if (this.rowWatched) watcher.observe(this.rowWatched);
            this.changes = new root.MutationObserver(() => this.fit()); this.changes.observe(this, { childList: true, subtree: true, characterData: true });
          } else watcher.observe(this);
        }
        disconnectedCallback() {
          living.delete(this);
          if (!row) watcher.unobserve(this);
          else if (this.rowWatched && ![...living].some((item) => item.rowWatched === this.rowWatched)) watcher.unobserve(this.rowWatched);
          this.rowWatched = null; this.changes?.disconnect(); this.changes = null;
        }
        fit() { if (this.isConnected) try { fit(this); } catch { /* the stylesheet's own cut shows */ } }
      });
    };
    define("dgc-path", fitPath);
    define("dgc-folder-fit", fitButton, { row: true });
  }

  /** What the button says for a choice: "All projects", or the folder's own name. */
  function valueOf(rows, choice, empty = ALL) {
    if (!choice) return empty;
    const row = rowsOf(rows).find((r) => r.folder === choice);
    return row ? row.name || nameOf(row.folder) : nameOf(choice);
  }

  // ---- the shape and its motion ----
  /** A damped spring's way from 0 to 1, one value a frame (60 a second) until it rests: ours, a dozen lines. */
  function spring(stiffness, damping) {
    const w = Math.sqrt(stiffness), z = Math.min(1, damping / (2 * w)), out = [];
    for (let i = 0; i <= 120; i++) {
      const t = i / 60;
      if (z < 1) { const wd = w * Math.sqrt(1 - z * z); out.push(1 - Math.exp(-z * w * t) * (Math.cos(wd * t) + (z * w / wd) * Math.sin(wd * t))); }
      else out.push(1 - Math.exp(-w * t) * (1 + w * t));
      if (i > 6 && Math.abs(1 - out[i]) < 0.002 && Math.abs(out[i] - out[i - 1]) < 0.002) break;
    }
    out[out.length - 1] = 1;
    return out;
  }
  const FRAME = 1000 / 60;
  const GROW = spring(230, 28), ARRIVE = spring(230, 25), SHRINK = spring(520, 46);      // soft, soft with a breath of overshoot, brisk
  const STAGGER = 36, STAGGER_OUT = 16, TURNS = 9;                                          // ms between rows; after TURNS rows the rest come together
  /** Whether anything may move in `view`: not with reduced motion, and not where a page can't animate (then it is drawn at rest). */
  const moves = (view, node) => { try { return typeof node.animate === "function" && typeof view.matchMedia === "function" && !view.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };
  const n2 = (v) => Math.round(v * 100) / 100;
  /**
   * The outline of the button and its menu as one path, in the menu's own box (its top left is 0 0; the button is above
   * it, or under it when the menu opens upward). `g`: the menu's width W and height H, the button's left edge X0, width
   * bw and height bh in that box, the corner R, and up. `h`: the menu's height now; `k`: how far (0 to 1) it has
   * reached sideways past the button. `inset`: 0.5 for the line's middle, 0 for the ground under it. `head`: with the
   * button (the line), or the menu and its inner corners alone (the ground: the button paints its own).
   * Always the same commands, so one outline can be animated into another.
   */
  function outline(g, h, k, inset, head) {
    const i = inset, R = g.R, X0 = g.X0, X1 = g.X0 + g.bw, eL = g.X0 * k, eR = (g.W - X1) * k, T = head ? -g.bh : -1, top = head ? R : 0;
    const y = (v) => n2(g.up ? g.H - v : v), sweep = (s) => (g.up ? 1 - s : s);
    const arc = (r, s, x, yy) => `A${n2(Math.max(0, r))} ${n2(Math.max(0, r))} 0 0 ${sweep(s)} ${n2(x)} ${y(yy)}`;
    const rB = Math.max(i, Math.min(R, (h + 1) / 2));
    const side = (e) => (e >= 2 ? { f: Math.min(R, e / 2), r: Math.max(i, Math.min(R, e / 2, (h + 1) / 2)) } : null);
    const right = side(eR), left = side(eL), MR = right ? X1 + eR : X1, ML = left ? X0 - eL : X0;
    return [`M${n2(X0 + top)} ${y(T + i)}`, `H${n2(X1 - top)}`, arc(top - i, 1, X1 - i, T + top),
      // down the button's right side, round the inner corner, along the menu's top to its own corner
      ...(right ? [`V${y(-1 - right.f)}`, arc(right.f + i, 0, X1 + right.f, -1 + i), `H${n2(MR - right.r)}`, arc(right.r - i, 1, MR - i, -1 + right.r)]
        : [`V${y(-1)}`, arc(0, 0, X1 - i, -1), `H${n2(X1 - i)}`, arc(0, 1, X1 - i, -1)]),
      `V${y(h - rB)}`, arc(rB - i, 1, MR - rB, h - i), `H${n2(ML + rB)}`, arc(rB - i, 1, ML + i, h - rB),
      ...(left ? [`V${y(-1 + left.r)}`, arc(left.r - i, 1, ML + left.r, -1 + i), `H${n2(X0 - left.f)}`, arc(left.f + i, 0, X0 + i, -1 - left.f)]
        : [`V${y(-1)}`, arc(0, 1, X0 + i, -1), `H${n2(X0 + i)}`, arc(0, 0, X0 + i, -1)]),
      `V${y(T + top)}`, arc(top - i, 1, X0 + top, T + i), "Z"].join(" ");
  }
  /** What of the rows shows while the shape is at height `h`, reached `k` sideways: the list is cut to the shape, a
   *  pixel inside it (the line is the shape's own). */
  const cut = (g, h, k) => { const far = `${n2(g.H - h + 1)}px`, l = `${n2(g.X0 * (1 - k) + 1)}px`, r = `${n2((g.W - g.X0 - g.bw) * (1 - k) + 1)}px`; return `inset(${g.up ? far : "0px"} ${r} ${g.up ? "0px" : far} ${l} round ${g.round})`; };
  const paths = (g, h, k) => ({ line: outline(g, h, k, 0.5, true), ground: outline(g, h, k, 0, false), shade: outline(g, h, k, 0, true) });
  /** The shape's keyframes along `steps` (each 0 to 1 of the way from `from` to `to`). */
  function grown(g, steps, from, to) {
    const line = [], ground = [], shade = [], clip = [];
    for (const s of steps) { const p = from + (to - from) * s, now = paths(g, g.H * p, Math.max(0, Math.min(1, p)));
      line.push(`path("${now.line}")`); ground.push(`path("${now.ground}")`); shade.push(`path("${now.shade}")`); clip.push(cut(g, g.H * p, Math.max(0, Math.min(1, p)))); }
    return { line, ground, shade, clip };
  }
  /** The rows (and the lines between them) that are in sight, in the order they arrive: from the button outward. */
  function inSight(m) {
    const list = m.list, from = list.scrollTop, to = from + list.clientHeight, all = [...list.children].filter((e) => !e.classList.contains("dgc-folder-find") && !e.hidden && e.offsetTop + e.offsetHeight > from && e.offsetTop < to);
    return m.g.up ? all.reverse() : all;
  }
  /** How far a row travels: from the button's edge to its own slot, at most 96 px. */
  const travel = (m, row) => Math.min(96, 6 + (m.g.up ? m.list.scrollTop + m.list.clientHeight - row.offsetTop - row.offsetHeight : row.offsetTop - m.list.scrollTop));

  function arrive(m) {
    const g = m.g, k = grown(g, GROW, 0, 1), time = { duration: (GROW.length - 1) * FRAME, easing: "linear", fill: "backwards" };
    m.growing = m.line.animate({ d: k.line }, time);
    m.ground.animate({ d: k.ground }, time);
    m.list.animate({ clipPath: k.clip }, time);
    m.list.animate({ opacity: [0, 1] }, { duration: 140, easing: "ease-out", fill: "backwards" });
    m.shade.animate({ d: k.shade, opacity: GROW.map((s) => n2(Math.max(0, Math.min(1, s)))) }, time);
    inSight(m).forEach((row, at) => {
      const far = travel(m, row) * (g.up ? 1 : -1);
      row.animate({ transform: ARRIVE.map((s) => `translateY(${n2(far * (1 - s))}px) scale(${n2(0.94 + 0.06 * s)})`), opacity: ARRIVE.map((s) => n2(Math.max(0, Math.min(1, s * 1.5)))) },
        { duration: (ARRIVE.length - 1) * FRAME, delay: Math.min(at, TURNS) * STAGGER, easing: "linear", fill: "backwards" });
    });
  }
  /** Leaves in reverse: the rows from the farthest back to the button, then the shape after them. `done` when it has gone. */
  function leave(m, done) {
    const g = m.g, view = m.view;
    // Closed while still opening: it goes back from where it is.
    let at = 1;
    try { const t = m.growing && m.growing.playState !== "finished" ? Number(m.growing.currentTime) : NaN; if (t >= 0) at = Math.max(0.05, Math.min(1, GROW[Math.min(GROW.length - 1, Math.round(t / FRAME))])); } catch { at = 1; }
    const rows = inSight(m).reverse(), held = rows.map((row) => { const s = view.getComputedStyle(row); return [s.opacity, s.transform]; });
    for (const node of [m.line, m.ground, m.list, m.shade, ...m.list.children]) for (const a of node.getAnimations()) a.cancel();
    rows.forEach((row, n) => {
      const far = Math.min(28, travel(m, row)) * (g.up ? 1 : -1);
      row.animate([{ opacity: held[n][0], transform: held[n][1] === "none" ? "translateY(0px) scale(1)" : held[n][1] }, { opacity: 0, transform: `translateY(${n2(far)}px) scale(0.95)` }],
        { duration: 130, delay: Math.min(n, TURNS) * STAGGER_OUT, easing: "cubic-bezier(.4,0,1,1)", fill: "both" });
    });
    const wait = Math.min(rows.length, 4) * STAGGER_OUT, k = grown(g, SHRINK, at, 0), time = { duration: (SHRINK.length - 1) * FRAME, delay: wait, easing: "linear", fill: "both" };
    const last = m.line.animate({ d: k.line }, time);
    m.ground.animate({ d: k.ground }, time);
    m.list.animate({ clipPath: k.clip }, time);
    m.shade.animate({ d: k.shade, opacity: SHRINK.map((s) => n2(at * (1 - s))) }, time);
    let over = false;
    const end = () => { if (over) return; over = true; view.clearTimeout(timer); done(); };
    const timer = view.setTimeout(end, time.duration + wait + 150);          // a page that is not painting still lets go
    last.finished.then(end, end);
    return end;
  }

  /** The button: "Project Folder", what is chosen, a chevron. `id`, `cls` and `attrs` are the page's own; `empty` is
   *  what it says with nothing chosen where All projects is not a choice ("Choose a folder"). Its tooltip says the
   *  choice and, for one folder, its whole path (no line of its own names it), unless the page gives another.
   *  A page that draws its button again while its menu is open (or still leaving) gets it as it was: open, in one shape. */
  function buttonHtml({ id = "", cls = "", rows = [], choice = "", label = "Project Folder", title = "", disabled = false, attrs = "", empty = ALL, said = "" } = {}) {
    // `said`: what the button says for a choice that is no folder (the Pips view's "Personal").
    const value = said || valueOf(rows, choice, empty), row = said ? null : rowsOf(rows).find((r) => r.folder === choice);
    const open = id && shown && shown.id === id ? shown : null, joined = open || (id && leaving && leaving.id === id ? leaving : null);
    return `<button type="button"${id ? ` id="${esc(id)}"` : ""} class="dgc-folder${cls ? ` ${esc(cls)}` : ""}" data-folder-pick="1" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}"${joined ? ` data-folder-open="${joined.g.up ? "up" : "down"}"${joined.solid ? ` style="--folder-ground: ${esc(joined.solid)}"` : ""}` : ""}`
      + ` aria-label="${esc(`${label}: ${value}`)}" title="${esc(title || `${label}: ${value}${row ? `\n${row.folder}` : ""}`)}"${disabled ? " disabled" : ""}${attrs ? ` ${attrs}` : ""}>`
      + `<span class="dgc-folder-k">${esc(label)}</span> ${row ? folderMark(row.folder) : ""}<span class="dgc-folder-v">${esc(value)}</span>${CHEVRON}</button>`;
  }

  let shown = null, leaving = null, shades = 0;
  // The shade under the shape: a soft shadow, kept only where it falls outside the shape (never on the button or the rows).
  const SHADE = (id) => `<defs><filter id="${id}" filterUnits="userSpaceOnUse" x="-60" y="-120" width="640" height="4000" color-interpolation-filters="sRGB"><feGaussianBlur in="SourceAlpha" stdDeviation="5"/><feOffset dy="8" result="soft"/>`
    + '<feFlood flood-color="#000" flood-opacity=".16"/><feComposite in2="soft" operator="in"/><feComposite in2="SourceAlpha" operator="out"/></filter></defs>';
  /** The menu that is still leaving goes at once (another opens, or the page is done with it). */
  function gone() { if (leaving) leaving.end(); }
  /** Closes the open menu, if any. `back`: the keyboard returns to the button that opened it. `now`: with no motion. */
  function close(back = false, now = false) {
    if (!shown) { if (now) gone(); return; }
    gone();
    const was = shown; shown = null;
    was.doc.removeEventListener("pointerdown", was.outside, true);
    was.doc.removeEventListener("scroll", was.follow, true);
    was.view.removeEventListener("blur", was.away); was.view.removeEventListener("resize", was.away);
    const button = was.trigger();
    button?.setAttribute("aria-expanded", "false");
    // The button and its menu part when the menu has gone: until then the button keeps its place in the shape.
    const apart = () => { if (leaving === was) leaving = null; was.box.remove(); for (const b of [was.trigger(), was.first]) if (b?.isConnected) { b.removeAttribute("data-folder-open"); b.style?.removeProperty("--folder-ground"); } };
    if (!now && button && was.box.isConnected && moves(was.view, was.box)) {
      // Nothing in it can be reached while it leaves.
      was.box.inert = true; was.box.setAttribute("aria-hidden", "true"); was.box.dataset.leaving = "1";
      leaving = was; was.end = leave(was, apart);
    } else apart();
    if (back) button?.focus({ preventScroll: true });
  }

  /** A computed colour's red, green, blue (0 to 255) and alpha, whichever way the engine writes it. */
  function channels(text) {
    const n = String(text || "").match(/-?[\d.]+(e-?\d+)?%?/g)?.map((v) => (v.endsWith("%") ? parseFloat(v) / 100 : Number(v))) || [];
    if (n.length < 3 || n.some((v) => !Number.isFinite(v))) return null;
    return /^color\(/.test(text) ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : [n[0], n[1], n[2], n[3] ?? 1];
  }
  /** The menu's ground as one opaque colour: the raised grey laid over the page's own ground. "" when the raised grey
   *  is opaque already (every stock theme), or where it can't be read: then the stylesheet's own colour stands. */
  function solidGround(view, box) {
    try {
      const probe = box.ownerDocument.createElement("span");
      probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none;background-color:var(--surface2);color:var(--bg)";
      box.append(probe);
      const css = view.getComputedStyle(probe), top = channels(css.backgroundColor), under = channels(css.color);
      probe.remove();
      if (!top || !under || top[3] >= 0.999) return "";
      return `rgb(${[0, 1, 2].map((i) => Math.round(top[i] * top[3] + under[i] * (1 - top[3]))).join(", ")})`;
    } catch { return ""; }
  }
  /** More folders than this and the menu has its search field; and it shows this many at a time. */
  const MANY = 8;

  /**
   * Opens the menu from `button`, as one shape with it.
   *   rows       [{ folder, shown, name, here, exists }] (list_project_folders, the home folder as ~ in `shown`)
   *   choice     the folder chosen, or "" for All projects
   *   all        offer "All projects" (the filter); without it only folders (New Session, Create a Project Pip)
   *   add        offer "Add a folder…" at the end; onAdd() answers it
   *   goneOff    a folder that is gone can't be chosen (a session or a Pip can't start there)
   *   onChoose(folder)   a row was chosen ("" is All projects)
   *   trigger    a function that finds the button again (a page that redraws replaces it), for the keyboard's way back
   *   pin        { on(folder), toggle(folder) }: each folder's row has a pin, shown while the row is pointed at (and kept
   *              in sight, filled, while the folder is on the dock). A click on it pins or unpins the folder and chooses
   *              nothing; the page says what is pinned again with repin(). (Asked 13 Nov: a Work folder on the dock.)
   *              By the keyboard: Right from a folder's row goes to its pin (a button, named for the folder), Enter or
   *              Space presses it, Left goes back to the row.
   */
  function open(button, { rows = [], choice = "", all = true, add = false, goneOff = false, onChoose, onAdd, keyboard = false, label = "Project Folder", trigger, pin = null, allLabel = ALL, lead = [] } = {}) {
    close(false, true);
    const doc = button.ownerDocument, view = doc.defaultView, Menu = root.DgcMenu;
    // Inside a dialog the menu belongs to it (everything outside a modal dialog is inert); in the Pips view, to its own root.
    const home = button.getRootNode && button.getRootNode() !== doc ? button.getRootNode() : null;
    const holder = button.closest("dialog") || home || doc.body;
    const box = doc.createElement("div");
    box.className = "dgc-menu dgc-pop dgc-folder-menu"; box.setAttribute("role", "menu"); box.setAttribute("aria-label", label);
    const icon = (name) => `<span class="dgc-menu-icon dgc-folder-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16">${MARKS[name]}</svg></span>`;
    const pinned = (folder) => { try { return !!pin?.on?.(folder); } catch { return false; } };
    // A button beside the row's own (a button can't hold a button), drawn over the room the row keeps for it at its end.
    // The keyboard reaches it with Right from its row (the menu's rows are one Tab stop, so it is out of the Tab order).
    const pins = (folder, gone) => !!(pin && folder && (!gone || pinned(folder)));
    const pinHtml = (folder, name) => ((on) => `<button type="button" class="dgc-folder-pin" tabindex="-1" data-folder-pin="${esc(folder)}" data-folder-name="${esc(name)}" aria-pressed="${on}" title="${on ? "Unpin from the dock" : "Pin to the dock"}" aria-label="${on ? "Unpin from the dock" : "Pin to the dock"}: ${esc(name)}">${PIN(on)}</button>`)(pinned(folder));
    const leading = (Array.isArray(lead) ? lead : []).filter((r) => r && typeof r.value === "string" && r.value && typeof r.name === "string" && r.name);
    const line = (folder, name, sub, note, checked, off, gone, plain = false) => { const pinning = !plain && pins(folder, gone);
      const row = `<button type="button" role="menuitemradio" class="dgc-menu-row dgc-folder-row${sub ? " dgc-menu-row-sub" : ""}${checked ? " is-selected" : ""}"`
        + ` data-folder="${esc(folder)}" aria-checked="${checked ? "true" : "false"}"${off ? " disabled" : ""}${pinning ? ' aria-keyshortcuts="ArrowRight"' : ""}>${folder && !plain ? `<span class="dgc-menu-icon dgc-folder-mark" aria-hidden="true">${folderMark(folder)}</span>` : icon("layers")}<span class="dgc-menu-words"><span class="dgc-menu-label">${esc(name)}</span>${sub ? `<span class="dgc-menu-sub">${sub}</span>` : ""}</span>`
        + (note ? `<span class="dgc-folder-note">${esc(note)}</span>` : "") + (pinning ? '<span class="dgc-folder-pin-room" aria-hidden="true"></span>' : "") + CHECK + "</button>";
      return pinning ? `<div class="dgc-folder-item" role="presentation">${row}${pinHtml(folder, name)}</div>` : row; };
    const list = rowsOf(rows), shadeId = `dgc-folder-shade-${++shades}`, finds = list.length > MANY;
    // The search field, when there are many: it stays at the list's top while the folders scroll under it.
    const findHtml = finds ? '<div class="dgc-folder-find" role="presentation"><svg class="dgc-folder-find-mark" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="4.25"/><path d="m10.2 10.2 3.3 3.3"/></svg>'
      + '<input type="text" class="dgc-folder-search" placeholder="Search folders" aria-label="Search folders by name or path" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="200"></div>' : "";
    // The shape (its ground, its shade, its line, and the hairline where the button ends) and, over it, the rows.
    box.innerHTML = `<svg class="dgc-folder-shape" aria-hidden="true" focusable="false">${SHADE(shadeId)}<path class="dgc-folder-shade" filter="url(#${shadeId})"/><path class="dgc-folder-ground"/><path class="dgc-folder-seam"/><path class="dgc-folder-line"/></svg><div class="dgc-folder-list" role="presentation"${finds ? ' data-find="1"' : ""}>` + findHtml
      // `allLabel`: what the row for no folder says ("All Pips", "No folder"); `lead`: choices that are no folder, after it
      // and before the folders ({value, name, sub}: the Pips view's "Personal"), each with the mark of the first row.
      + (all ? line("", allLabel, "", "", !choice, false) : "")
      + leading.map((r) => line(r.value, r.name, r.sub ? esc(r.sub) : "", "", r.value === choice, false, false, true)).join("")
      + ((all || leading.length) && list.length ? '<div class="dgc-menu-div" role="separator"></div>' : "")
      + list.map((r) => line(r.folder, r.name || nameOf(r.folder), pathHtml(r.shown || r.folder, r.folder), r.exists === false ? "Not found" : r.here ? "This window" : "", r.folder === choice, goneOff && r.exists === false, r.exists === false)).join("")
      + (finds ? '<div class="dgc-folder-none" role="status" hidden></div>' : "")
      + (add ? `${all || list.length ? '<div class="dgc-menu-div" role="separator"></div>' : ""}<button type="button" role="menuitem" class="dgc-menu-row dgc-folder-add" data-folder-add="1">${icon("add")}<span class="dgc-menu-label">Add a folder…</span></button>` : "")
      + "</div>";
    holder.append(box);
    // One opaque ground for the button and its menu, where the theme's raised grey is see-through.
    const solid = solidGround(view, box);
    if (solid) { box.style.setProperty("--folder-ground", solid); button.style.setProperty("--folder-ground", solid); }
    const rowsBox = box.querySelector(".dgc-folder-list"), shape = box.querySelector(".dgc-folder-shape");
    // Where it goes. The button's edges as they are painted (on whole device pixels), so the one line lies on them.
    const dpr = view.devicePixelRatio || 1, snap = (v) => Math.round(v * dpr) / dpr;
    const edges = (el) => { const r = el.getBoundingClientRect(); return { left: snap(r.left), right: snap(r.right), top: snap(r.top), bottom: snap(r.bottom) }; };
    const a = edges(button), bw = a.right - a.left, bh = a.bottom - a.top, vw = view.innerWidth, vh = view.innerHeight;
    // As wide as its button; under a small button, as wide as its longest row (200 to 360 px): it keeps one edge on the button's and
    // reaches the other way, toward the side with more room (to the left from a button at a row's right end).
    const roomRight = vw - 6 - a.left, roomLeft = a.right - 6, toLeft = roomLeft > roomRight, room = Math.max(bw, toLeft ? roomLeft : roomRight);
    rowsBox.style.width = "max-content";
    const want = bw >= 200 ? bw : Math.min(Math.max(rowsBox.offsetWidth, 200), 360);      // a field's menu is the field's width
    let w = Math.min(want, room);
    if (w - bw > 0 && w - bw < 16) w = room >= bw + 16 ? bw + 16 : bw;         // never a sliver of a step beside the button
    w = snap(w);
    rowsBox.style.width = `${w}px`;
    // Under the button; over it when there is more room there. Its room ends above the dock (asked 13 Nov: it ran on
    // under the dock to the view's end); a dialog is over the dock, so its menu has the view. And it shows about 8
    // folders at a time (with what stands before them: the search field, All projects), then it scrolls inside.
    const dockEl = holder === doc.body || home ? doc.getElementById("dgc-dock") : null, dockBox = dockEl && view.getComputedStyle(dockEl).display !== "none" ? dockEl.getBoundingClientRect() : null;
    const floor = dockBox && dockBox.height > 0 && dockBox.top > a.bottom ? Math.min(vh, dockBox.top) : vh;
    const folderRows = rowsBox.querySelectorAll(".dgc-folder-row[data-folder]:not([data-folder=''])"), lastShown = folderRows.length > MANY ? folderRows[MANY - 1] : null;
    const slotOf = (row) => row.closest(".dgc-folder-item") || row;          // (a row with a pin is in an item with it)
    const cap = lastShown ? slotOf(lastShown).offsetTop + slotOf(lastShown).offsetHeight + 5 : Infinity, tall = Math.min(rowsBox.offsetHeight, cap);
    const below = floor - a.bottom - 6, above = a.top - 6, up = tall > below && above > below;
    rowsBox.style.maxHeight = `${Math.min(cap, Math.max(120, Math.floor(up ? above : below)))}px`;
    const h = rowsBox.offsetHeight, left = toLeft ? a.right - w : a.left;
    box.style.left = `${left}px`; box.style.top = `${up ? a.top - h : a.bottom}px`;
    box.style.width = `${w}px`; box.style.height = `${h}px`;
    const corner = parseFloat(view.getComputedStyle(button).borderTopLeftRadius) || 6;
    const g = { W: w, H: h, X0: a.left - left, bw, bh, R: Math.min(corner, bh / 2 - 1), up };
    // (The list's own corners, for the cut that follows the shape as it grows.)
    { const r = Math.max(0, g.R - 1), far = `${r}px`, l = g.X0 >= 2 ? far : "0px", rr = w - g.X0 - bw >= 2 ? far : "0px"; g.round = up ? `${far} ${far} ${rr} ${l}` : `${l} ${rr} ${far} ${far}`; }
    box.dataset.dir = up ? "up" : "down"; box.dataset.reach = g.X0 >= 2 ? "left" : w - g.X0 - bw >= 2 ? "right" : "";
    const lineEl = shape.querySelector(".dgc-folder-line"), ground = shape.querySelector(".dgc-folder-ground"), shade = shape.querySelector(".dgc-folder-shade"), full = paths(g, h, 1);
    lineEl.setAttribute("d", full.line); ground.setAttribute("d", full.ground); shade.setAttribute("d", full.shade);
    const filter = shape.querySelector("filter"); filter.setAttribute("y", String(-(bh + 60))); filter.setAttribute("width", String(w + 120)); filter.setAttribute("height", String(h + 2 * bh + 120));
    const seamY = n2(up ? h + 0.5 : -0.5);
    shape.querySelector(".dgc-folder-seam").setAttribute("d", `M${n2(g.X0 + 1)} ${seamY} H${n2(g.X0 + bw - 1)}`);
    button.setAttribute("aria-expanded", "true"); button.setAttribute("data-folder-open", up ? "up" : "down");
    const find = typeof trigger === "function" ? trigger : () => (button.isConnected ? button : button.id ? (home || doc).getElementById?.(button.id) || (home || doc).querySelector(`#${button.id}`) : null);
    box.addEventListener("click", (e) => {
      const adding = e.target.closest("[data-folder-add]"), row = e.target.closest("[data-folder]"), pinning = e.target.closest("[data-folder-pin]");
      // A row's pin: the folder goes on the dock (or comes off it); nothing is chosen and the menu stays.
      if (pinning) { e.preventDefault(); e.stopPropagation(); try { pin?.toggle?.(pinning.dataset.folderPin); } catch { /* the page's own trouble */ } return; }
      if (adding) { close(true); onAdd?.(); return; }
      if (!row || row.disabled) return;
      const folder = row.dataset.folder;
      close(true);
      onChoose?.(folder);
    });
    // The search field: what is typed narrows the folders by name or path. The menu keeps its size (one shape with
    // its button); what doesn't match is taken out of the list.
    const field = box.querySelector(".dgc-folder-search"), none = box.querySelector(".dgc-folder-none");
    const narrow = () => {
      const q = field.value.trim().toLowerCase();
      let found = 0;
      for (const row of rowsBox.querySelectorAll(".dgc-folder-row")) {
        const at = list.find((r) => r.folder === row.dataset.folder);
        const hit = !q || (at ? [at.name || nameOf(at.folder), at.folder, at.shown || ""].some((v) => String(v).toLowerCase().includes(q)) : (row.querySelector(".dgc-menu-label")?.textContent || allLabel).toLowerCase().includes(q));
        row.hidden = slotOf(row).hidden = !hit; if (hit && at) found++;
      }
      const firstDiv = rowsBox.querySelector(".dgc-folder-row + .dgc-menu-div"); if (firstDiv) firstDiv.hidden = !!q;
      none.hidden = !q || found > 0; none.textContent = none.hidden ? "" : `No folder matches “${field.value.trim()}”`;
      rowsBox.scrollTop = 0;
    };
    if (field) {
      field.addEventListener("input", narrow);
      field.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && field.value) { e.preventDefault(); e.stopPropagation(); field.value = ""; narrow(); return; }
        if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); if (field.value.trim()) rowsBox.querySelector(".dgc-folder-row[data-folder]:not([data-folder='']):not([hidden]):not(:disabled)")?.click(); return; }
        if (e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); const rowsNow = [...rowsBox.querySelectorAll(".dgc-menu-row:not([hidden]):not(:disabled)")]; rowsNow[rowsNow.length - 1]?.focus(); }
      });
    }
    box.addEventListener("keydown", (e) => {
      e.stopPropagation();
      // A row's pin: Right from its row goes to it, Left goes back; Enter and Space press it (it is a button); Up, Down,
      // Home and End move on from its row.
      const onPin = e.target.closest?.(".dgc-folder-pin"), own = onPin ? onPin.parentElement.querySelector(":scope > .dgc-folder-row") : null;
      if (onPin && (e.key === "Enter" || e.key === " ")) return;
      if (onPin && e.key === "ArrowLeft") { e.preventDefault(); own?.focus({ preventScroll: true }); return; }
      if (!onPin && e.key === "ArrowRight" && e.target.matches?.(".dgc-folder-row")) { const beside = e.target.parentElement.querySelector(":scope > .dgc-folder-pin"); if (beside) { e.preventDefault(); beside.focus({ preventScroll: true }); } return; }
      const from = own || e.target;
      // A letter typed on a row goes into the search field; Up from the first row goes back to it.
      if (field && e.target !== field && !e.defaultPrevented) {
        if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) { field.focus({ preventScroll: true }); return; }
        if (e.key === "ArrowUp" && from === rowsBox.querySelector(".dgc-menu-row:not([hidden]):not(:disabled)")) { e.preventDefault(); field.focus({ preventScroll: true }); return; }
      }
      if (own && ["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) own.focus({ preventScroll: true });
      Menu?.handle(box, e, { close: (viaEscape) => close(viaEscape !== false), trigger: find });
    });
    const inside = (e) => { const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target]; return path.includes(box) || path.includes(find()); };
    const outside = (e) => { if (!inside(e)) close(false); };
    const away = () => close(false);
    // The page scrolls under it: it stays on its button (and goes when the button has left the view).
    const follow = (e) => {
      if (!shown || shown.box !== box || (e.target && e.target.nodeType === 1 && box.contains(e.target))) return;
      const now = find(); if (!now || !now.isConnected) return;
      const b = edges(now), dx = b.left - a.left, dy = b.top - a.top;
      if (b.bottom < 0 || b.top > view.innerHeight) { close(false, true); return; }
      box.style.left = `${left + dx}px`; box.style.top = `${(up ? a.top - h : a.bottom) + dy}px`;
    };
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("scroll", follow, true);
    view.addEventListener("blur", away); view.addEventListener("resize", away);
    shown = { box, doc, view, outside, away, follow, trigger: find, id: button.id || "", first: button, g, list: rowsBox, line: lineEl, ground, shade, growing: null, solid, pinned };
    if (moves(view, box)) try { arrive(shown); } catch { /* drawn at rest */ }
    box.tabIndex = -1;
    // With a search field the keyboard starts in it, however the menu was opened: typing narrows at once.
    (field || (keyboard ? box.querySelector('[aria-checked="true"]:not(:disabled)') || box.querySelector(".dgc-menu-row:not(:disabled)") : box))?.focus({ preventScroll: true });
    return { box, close };
  }

  /** What is pinned changed: the open menu's pins say so (filled while pinned). */
  function repin() {
    if (!shown) return;
    for (const mark of shown.box.querySelectorAll("[data-folder-pin]")) {
      const on = shown.pinned(mark.dataset.folderPin), said = on ? "Unpin from the dock" : "Pin to the dock";
      if (mark.getAttribute("aria-pressed") === String(on)) continue;
      mark.setAttribute("aria-pressed", String(on)); mark.title = said; mark.setAttribute("aria-label", `${said}: ${mark.dataset.folderName || ""}`); mark.innerHTML = PIN(on);
    }
  }
  /** The open menu's box, or null: a page that draws again leaves it where it is. */
  const opened = () => (shown ? shown.box : null);

  root.DgcFolderPick = Object.freeze({ buttonHtml, pathHtml, pathNode, valueOf, open, close, opened, ALL, folderMark, folderId, setPalette, repin });
})();
