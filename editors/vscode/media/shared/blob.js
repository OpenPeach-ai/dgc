// A session's liquid blob and a widget's liquid cube, in our own code (media/shared/blob.css is how they look and
// move), and the small menu that offers a session's seven colours. A Work session's blob is round and a ChatDGC chat's a
// rounded square. A blob's colour comes from its id, so it is the same wherever it shows, until its owner picks another
// of the seven; "Back to its own colour" returns to the one from its id. A classic script: Work's and ChatDGC's pages
// and the Library load it before their own script, so all share window.DgcBlob.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcBlob) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // The seven pairs, in the order they are offered. Their colours are tokens (media/shared/tokens.css: --blob-1a ...).
  const NAMES = ["Purple to pink", "Blue to purple", "Cyan to blue", "Green to cyan", "Yellow to green", "Orange to yellow", "Red to orange"];
  const PAIRS = NAMES.length;
  const valid = (n) => Number.isInteger(n) && n >= 1 && n <= PAIRS;

  /** The pair an id gets by itself: one of 2 to 7, the same every time. Never 1, which is led by purple. */
  function own(id) {
    let h = 2166136261;
    for (const ch of String(id || "")) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
    return 2 + ((h >>> 0) % (PAIRS - 1));
  }
  /** The pair to draw: the one picked, or the id's own. */
  const pairOf = (id, picked) => (valid(Number(picked)) ? Number(picked) : own(id));
  /** Where a blob starts in its motion, from its id: blobs side by side never move in step. */
  const phase = (id) => { let h = 0; for (const ch of String(id || "")) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % 7; };

  /**
   * A blob as HTML. `kind` is "work" (round) or "chat" (a rounded square). `pair` 1 to 7 (or leave it out and give `id`).
   * `running` adds the glow. `still` never moves (a colour to pick, a picture). `size` in px (or let the CSS say).
   */
  function html(kind, { id = "", pair, running = false, still = false, size } = {}) {
    const n = pairOf(id, pair), shape = kind === "chat" ? "square" : "round";
    const style = [size ? `--blob-size:${Number(size)}px` : "", `--blob-i:${phase(id || n)}`].filter(Boolean).join(";");
    return `<span class="dgc-blob${still ? " is-still" : ""}" data-shape="${shape}" data-pair="${n}"${running ? " data-running" : ""} style="${style}" aria-hidden="true">`
      + `<span class="dgc-blob-fill"><i class="w"></i><i class="s"></i><i class="h"></i><i class="b"></i></span></span>`;
  }

  let cubes = 0;
  /** A widget's cube as HTML, in the pair its id gets. */
  function cube({ id = "", pair, size } = {}) {
    const n = pairOf(id, pair), k = `dgc-cube-${++cubes}`;
    return `<span class="dgc-cube" data-pair="${n}"${size ? ` style="--blob-size:${Number(size)}px"` : ""} aria-hidden="true"><svg viewBox="0 0 24 24"><defs>`
      + `<linearGradient id="${k}t" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="cl"/><stop offset=".6" class="cb"/><stop offset="1" class="cm"/></linearGradient>`
      + `<linearGradient id="${k}l" x1="0" y1="0" x2=".4" y2="1"><stop offset="0" class="cm"/><stop offset="1" class="ca"/></linearGradient>`
      + `<linearGradient id="${k}r" x1="0" y1="0" x2="-.3" y2="1"><stop offset="0" class="ca"/><stop offset="1" class="cd"/></linearGradient>`
      + `<radialGradient id="${k}h" cx=".35" cy=".3" r=".6"><stop offset="0" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs>`
      + `<g stroke-linejoin="round" stroke-width="2.2">`
      + `<path d="M12 3 L20.5 7.6 L12 12.2 L3.5 7.6 Z" fill="url(#${k}t)" stroke="url(#${k}t)"/>`
      + `<path d="M3.5 7.6 L12 12.2 L12 21 L3.5 16.4 Z" fill="url(#${k}l)" stroke="url(#${k}l)"/>`
      + `<path d="M20.5 7.6 L12 12.2 L12 21 L20.5 16.4 Z" fill="url(#${k}r)" stroke="url(#${k}r)"/>`
      + `<path d="M12 3 L20.5 7.6 L12 12.2 L3.5 7.6 Z" fill="url(#${k}h)" stroke="none"/></g></svg></span>`;
  }

  // ---- motion only while seen: a blob off screen (scrolled away, a hidden tab) pauses ---------------------------------
  const watchers = new WeakMap();   // a document -> its IntersectionObserver
  /** Watch every moving blob under `node` (call again after drawing more): each pauses while it is off screen. */
  function watch(node) {
    const doc = node?.ownerDocument || (node?.nodeType === 9 ? node : null), view = doc?.defaultView;
    if (!doc || !view || typeof view.IntersectionObserver !== "function") return;
    let seen = watchers.get(doc);
    if (!seen) {
      seen = new view.IntersectionObserver((entries) => {
        for (const entry of entries) entry.target.classList.toggle("is-paused", !entry.isIntersecting);
      });
      watchers.set(doc, seen);
    }
    for (const blob of node.querySelectorAll?.(".dgc-blob:not(.is-still)") || []) {
      if (blob.__dgcWatched) continue;
      blob.__dgcWatched = true; seen.observe(blob);
    }
  }

  // ---- the small menu: rows, then (for a session) its seven colours ---------------------------------------------------
  const ICONS = {
    open: '<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h4"/>',
    pin: '<path d="M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z"/>',
    unpin: '<path d="M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z"/><path d="M2.5 2.5l11 11"/>',
    left: '<path d="M9.5 3.5 5 8l4.5 4.5"/>', right: '<path d="M6.5 3.5 11 8l-4.5 4.5"/>',
    work: '<path d="M5.4 3.2 3 4.4 1.6 13l2.4-1.2zM9.7 2 7.3 3.2 5.9 13l2.4-1.2zM14.2 3.2l-2.4 1.2L10.4 11.8l2.4-1.2z" fill="currentColor" stroke="none"/>',
    chat: '<path d="M4 2.5h8A2.5 2.5 0 0 1 14.5 5v4A2.5 2.5 0 0 1 12 11.5H7.5L4.5 14v-2.5H4A2.5 2.5 0 0 1 1.5 9V5A2.5 2.5 0 0 1 4 2.5z"/>',
    pip: '<path d="M8 2.2c2.6 2 4.7 4.3 4.7 7A4.7 4.7 0 0 1 3.3 9.2c0-2.7 2.1-5 4.7-7z"/><path d="M6.3 9.3v1M9.7 9.3v1"/>',
    settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/>',
    trash: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>',
    reset: '<path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v2.8h2.8"/>',
  };
  const icon = (name, filled = false) => `<svg viewBox="0 0 16 16" width="15" height="15" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  /** The seven colours as a row of still blobs, the chosen one marked, then "Back to its own colour". */
  function swatches(kind, { chosen, own: ownPair } = {}) {
    const shape = kind === "chat" ? "square" : "round";
    return `<div class="dgc-menu-head" role="presentation"><span>Colour</span></div><div class="dgc-swatches" role="group" aria-label="Colour">`
      + NAMES.map((name, i) => `<button type="button" class="dgc-swatch" role="menuitemradio" data-shape="${shape}" data-colour="${i + 1}" aria-checked="${chosen === i + 1 ? "true" : "false"}"`
        + ` aria-label="${esc(name)}" title="${esc(name)}" tabindex="-1">${html(kind, { pair: i + 1, still: true })}</button>`).join("")
      + `</div><button type="button" role="menuitem" class="dgc-menu-row" data-colour="own"${chosen === ownPair ? " disabled" : ""}><span class="dgc-pop-icon">${icon("reset")}</span><span class="dgc-menu-label">Back to its own colour</span></button>`;
  }

  let open = null;
  /** Close the menu that is open, if one is. `back`: put the focus back on what opened it. */
  function close(back = false) {
    if (!open) return;
    const was = open; open = null;
    was.doc.removeEventListener("pointerdown", was.outside, true);
    was.view.removeEventListener("blur", was.blur);
    was.view.removeEventListener("resize", was.blur);
    // The focus goes back first: a row shows its "..." only while its menu is open or the row holds the keyboard.
    if (back) was.anchor?.focus?.({ preventScroll: true });
    was.menu.remove();
    was.anchor?.setAttribute?.("aria-expanded", "false");
    was.onClose?.();
  }

  /**
   * Open a small menu beside `anchor` (above it when there is room, as a dock's menu opens; below it otherwise).
   *   rows:   [{ id, label, icon?, danger?, disabled? }] or groups of them ([[...], [...]]: a hairline between groups)
   *   head:   a small heading over the rows
   *   colour: { kind: "work" | "chat", chosen, own }: the seven colours and "Back to its own colour"
   *   onPick(id), onColour(n | null)
   *   at:     { x, y }: open at a point (a right-click), not beside the anchor
   *   place:  "above" (the default) or "below"
   * Keys: Up and Down between rows, Left and Right between colours, Home and End, Enter or Space to choose, Escape to
   * close and go back to what opened it, Tab to close and move on.
   */
  function popup(anchor, { rows = [], head = "", colour = null, onPick, onColour, onClose, at = null, place = "above", label = "", keyboard = false } = {}) {
    close();
    const doc = anchor.ownerDocument, view = doc.defaultView, menu = doc.createElement("div");
    menu.className = "dgc-menu dgc-pop"; menu.setAttribute("role", "menu");
    if (label) menu.setAttribute("aria-label", label);
    const groups = (Array.isArray(rows[0]) ? rows : [rows]).filter((g) => g && g.length);
    const row = (r) => `<button type="button" role="menuitem" class="dgc-menu-row${r.danger ? " is-danger" : ""}" data-id="${esc(r.id)}"${r.disabled ? " disabled" : ""}>`
      + (r.icon ? `<span class="dgc-pop-icon">${icon(r.icon)}</span>` : "") + `<span class="dgc-menu-label">${esc(r.label)}</span></button>`;
    menu.innerHTML = (head ? `<div class="dgc-menu-head" role="presentation"><span>${esc(head)}</span></div>` : "")
      + groups.map((g, i) => (i ? '<div class="dgc-menu-div mdiv" role="separator"></div>' : "") + g.map(row).join("")).join("")
      + (colour ? (groups.length ? '<div class="dgc-menu-div mdiv" role="separator"></div>' : "") + swatches(colour.kind, colour) : "");
    doc.body.append(menu);
    // Beside what opened it, inside the page: above when there is room, and never past an edge.
    const a = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0 } : anchor.getBoundingClientRect();
    const w = menu.offsetWidth, h = menu.offsetHeight, vw = view.innerWidth, vh = view.innerHeight, gap = at ? 2 : 8;
    const above = place === "above" ? a.top - gap - h >= 6 || a.top > vh - a.bottom : !(a.bottom + gap + h <= vh - 6 || a.top < vh - a.bottom);
    const left = Math.max(6, Math.min(vw - w - 6, at ? a.left : a.left + a.width / 2 - w / 2));
    const top = Math.max(6, Math.min(vh - h - 6, above ? a.top - gap - h : a.bottom + gap));
    menu.style.left = `${Math.round(left)}px`; menu.style.top = `${Math.round(top)}px`;
    menu.style.setProperty("--pop-x", `${Math.round((at ? a.left : a.left + a.width / 2) - left)}px`);
    menu.style.setProperty("--pop-y", above ? "100%" : "0%");
    anchor.setAttribute?.("aria-expanded", "true");

    const stops = () => [...menu.querySelectorAll(".dgc-menu-row:not(:disabled)")];
    const dots = () => [...menu.querySelectorAll(".dgc-swatch")];
    const choose = (target) => {
      const el = target.closest(".dgc-menu-row, .dgc-swatch");
      if (!el || el.disabled) return;
      const picked = el.dataset.colour, id = el.dataset.id;
      close(true);
      if (picked !== undefined) onColour?.(picked === "own" ? null : Number(picked));
      else onPick?.(id);
    };
    menu.addEventListener("click", (e) => choose(e.target));
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    menu.addEventListener("keydown", (e) => {
      const active = doc.activeElement, inDots = active?.classList?.contains("dgc-swatch");
      // The colours are one stop among the rows: Up and Down pass through them, Left and Right move along them.
      const list = [];
      for (const el of menu.querySelectorAll(".dgc-menu-row:not(:disabled), .dgc-swatches")) list.push(el);
      const here = list.indexOf(inDots ? active.parentElement : active);
      const go = (el) => { if (!el) return; (el.classList.contains("dgc-swatches") ? (el.querySelector('[aria-checked="true"]') || el.firstElementChild) : el).focus(); };
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") close(false);
      else if (e.key === "ArrowDown") { e.preventDefault(); go(list[(here + 1) % list.length]); }
      else if (e.key === "ArrowUp") { e.preventDefault(); go(list[(here - 1 + list.length) % list.length]); }
      else if (e.key === "Home") { e.preventDefault(); go(list[0]); }
      else if (e.key === "End") { e.preventDefault(); go(list[list.length - 1]); }
      else if (inDots && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        const all = dots(), i = all.indexOf(active);
        all[(i + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length].focus();
      }
    });
    const outside = (e) => { if (!menu.contains(e.target) && !(anchor.contains?.(e.target) && e.button === 0)) close(false); };
    const blur = () => close(false);
    doc.addEventListener("pointerdown", outside, true);
    view.addEventListener("blur", blur); view.addEventListener("resize", blur);
    open = { menu, anchor, doc, view, outside, blur, onClose };
    // Opened by the keyboard, the first row has the focus; by the pointer, the menu itself (the keys still work).
    menu.tabIndex = -1;
    (keyboard ? stops()[0] || dots()[0] || menu : menu).focus({ preventScroll: true });
    return menu;
  }

  root.DgcBlob = Object.freeze({ NAMES, PAIRS, own, pairOf, html, cube, watch, popup, close, swatches, icon, isOpen: () => !!open, menu: () => open?.menu || null });
})();
