// The Project Folder dropdown (0.52, 12 Nov): one button that names the folder chosen and opens the shared menu
// (media/shared/menu.js) with "All projects", then the folders that have a session or a Project Pip, this window's marked
// and a gone one marked "Not found", and (where a folder can be added) "Add a folder…" at its end. The same button and
// menu over the Work sessions, in New Session's dialog, on the Pips view's Project tab and in Create a Project Pip.
// media/shared/folderpick.css is how it looks. A classic script: Work's page loads it before its own script and the Pips
// bundle imports it, so both share window.DgcFolderPick. The page keeps the choice; this file draws and answers keys.
// Two small elements do the fitting no stylesheet can (asked 12 Nov night): <dgc-folder-fit> holds the button on a row
// it shares (Library's, the search field's, the Needs attention heading's) and drops its "Project Folder" word when the
// row has no room for it; <dgc-path> cuts a long path before its folder's own name, exactly at a letter, so no space
// shows before the name's slash.
// Its shape and motion (asked 13 Nov): the button has the shared button's corner, and the open menu grows out of it as
// one shape with one line around both (drawn here, as one outline: the button's corners next to the menu go square, and
// where the menu is wider than the button it reaches away from the side the button is on, with a small rounded inner
// corner at the join). The shape grows on a soft spring, each row arrives in turn from the button, and they leave in
// reverse; the chevron's two strokes turn into an ×. All of it is this file's own: a small spring, sampled into
// keyframes for the page's own animations. With reduced motion nothing moves: it opens and closes at once.
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
    const list = m.list, from = list.scrollTop, to = from + list.clientHeight, all = [...list.children].filter((e) => e.offsetTop + e.offsetHeight > from && e.offsetTop < to);
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
  function buttonHtml({ id = "", cls = "", rows = [], choice = "", label = "Project Folder", title = "", disabled = false, attrs = "", empty = ALL } = {}) {
    const value = valueOf(rows, choice, empty), row = rowsOf(rows).find((r) => r.folder === choice);
    const open = id && shown && shown.id === id ? shown : null, joined = open || (id && leaving && leaving.id === id ? leaving : null);
    return `<button type="button"${id ? ` id="${esc(id)}"` : ""} class="dgc-folder${cls ? ` ${esc(cls)}` : ""}" data-folder-pick="1" aria-haspopup="menu" aria-expanded="${open ? "true" : "false"}"${joined ? ` data-folder-open="${joined.g.up ? "up" : "down"}"` : ""}`
      + ` aria-label="${esc(`${label}: ${value}`)}" title="${esc(title || `${label}: ${value}${row ? `\n${row.folder}` : ""}`)}"${disabled ? " disabled" : ""}${attrs ? ` ${attrs}` : ""}>`
      + `<span class="dgc-folder-k">${esc(label)}</span> <span class="dgc-folder-v">${esc(value)}</span>${CHEVRON}</button>`;
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
    const apart = () => { if (leaving === was) leaving = null; was.box.remove(); was.trigger()?.removeAttribute("data-folder-open"); if (was.first?.isConnected) was.first.removeAttribute("data-folder-open"); };
    if (!now && button && was.box.isConnected && moves(was.view, was.box)) {
      // Nothing in it can be reached while it leaves.
      was.box.inert = true; was.box.setAttribute("aria-hidden", "true"); was.box.dataset.leaving = "1";
      leaving = was; was.end = leave(was, apart);
    } else apart();
    if (back) button?.focus({ preventScroll: true });
  }

  /**
   * Opens the menu from `button`, as one shape with it.
   *   rows       [{ folder, shown, name, here, exists }] (list_project_folders, the home folder as ~ in `shown`)
   *   choice     the folder chosen, or "" for All projects
   *   all        offer "All projects" (the filter); without it only folders (New Session, Create a Project Pip)
   *   add        offer "Add a folder…" at the end; onAdd() answers it
   *   goneOff    a folder that is gone can't be chosen (a session or a Pip can't start there)
   *   onChoose(folder)   a row was chosen ("" is All projects)
   *   trigger    a function that finds the button again (a page that redraws replaces it), for the keyboard's way back
   */
  function open(button, { rows = [], choice = "", all = true, add = false, goneOff = false, onChoose, onAdd, keyboard = false, label = "Project Folder", trigger } = {}) {
    close(false, true);
    const doc = button.ownerDocument, view = doc.defaultView, Menu = root.DgcMenu;
    // Inside a dialog the menu belongs to it (everything outside a modal dialog is inert); in the Pips view, to its own root.
    const home = button.getRootNode && button.getRootNode() !== doc ? button.getRootNode() : null;
    const holder = button.closest("dialog") || home || doc.body;
    const box = doc.createElement("div");
    box.className = "dgc-menu dgc-pop dgc-folder-menu"; box.setAttribute("role", "menu"); box.setAttribute("aria-label", label);
    const icon = (name) => `<span class="dgc-menu-icon dgc-folder-mark" aria-hidden="true"><svg viewBox="0 0 16 16" width="16" height="16">${MARKS[name]}</svg></span>`;
    const line = (folder, name, sub, note, checked, off) => `<button type="button" role="menuitemradio" class="dgc-menu-row dgc-folder-row${sub ? " dgc-menu-row-sub" : ""}${checked ? " is-selected" : ""}"`
      + ` data-folder="${esc(folder)}" aria-checked="${checked ? "true" : "false"}"${off ? " disabled" : ""}>${icon(folder ? "folder" : "layers")}<span class="dgc-menu-words"><span class="dgc-menu-label">${esc(name)}</span>${sub ? `<span class="dgc-menu-sub">${sub}</span>` : ""}</span>`
      + (note ? `<span class="dgc-folder-note">${esc(note)}</span>` : "") + CHECK + "</button>";
    const list = rowsOf(rows), shadeId = `dgc-folder-shade-${++shades}`;
    // The shape (its ground, its shade, its line, and the hairline where the button ends) and, over it, the rows.
    box.innerHTML = `<svg class="dgc-folder-shape" aria-hidden="true" focusable="false">${SHADE(shadeId)}<path class="dgc-folder-shade" filter="url(#${shadeId})"/><path class="dgc-folder-ground"/><path class="dgc-folder-seam"/><path class="dgc-folder-line"/></svg><div class="dgc-folder-list" role="presentation">`
      + (all ? line("", ALL, "", "", !choice, false) + (list.length ? '<div class="dgc-menu-div" role="separator"></div>' : "") : "")
      + list.map((r) => line(r.folder, r.name || nameOf(r.folder), pathHtml(r.shown || r.folder, r.folder), r.exists === false ? "Not found" : r.here ? "This window" : "", r.folder === choice, goneOff && r.exists === false)).join("")
      + (add ? `${all || list.length ? '<div class="dgc-menu-div" role="separator"></div>' : ""}<button type="button" role="menuitem" class="dgc-menu-row dgc-folder-add" data-folder-add="1">${icon("add")}<span class="dgc-menu-label">Add a folder…</span></button>` : "")
      + "</div>";
    holder.append(box);
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
    // Under the button; over it when there is more room there.
    const below = vh - a.bottom - 6, above = a.top - 6, up = rowsBox.offsetHeight > below && above > below;
    rowsBox.style.maxHeight = `${Math.max(120, Math.floor(up ? above : below))}px`;
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
      const adding = e.target.closest("[data-folder-add]"), row = e.target.closest("[data-folder]");
      if (adding) { close(true); onAdd?.(); return; }
      if (!row || row.disabled) return;
      const folder = row.dataset.folder;
      close(true);
      onChoose?.(folder);
    });
    box.addEventListener("keydown", (e) => { e.stopPropagation(); Menu?.handle(box, e, { close: (viaEscape) => close(viaEscape !== false), trigger: find }); });
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
    shown = { box, doc, view, outside, away, follow, trigger: find, id: button.id || "", first: button, g, list: rowsBox, line: lineEl, ground, shade, growing: null };
    if (moves(view, box)) try { arrive(shown); } catch { /* drawn at rest */ }
    box.tabIndex = -1;
    (keyboard ? box.querySelector('[aria-checked="true"]:not(:disabled)') || box.querySelector(".dgc-menu-row:not(:disabled)") : box)?.focus({ preventScroll: true });
    return { box, close };
  }

  /** The open menu's box, or null: a page that draws again leaves it where it is. */
  const opened = () => (shown ? shown.box : null);

  root.DgcFolderPick = Object.freeze({ buttonHtml, pathHtml, pathNode, valueOf, open, close, opened, ALL });
})();
