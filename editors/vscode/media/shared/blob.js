// The small menu a session's "..." and the dock open (media/shared/blob.css is how it looks), with
// the twelve palettes a session's mark can wear. A session's mark itself is the maintainer's own
// Mote (a ChatDGC chat) or Voxel (a Work session), drawn by media/shared/marks.js (window.DgcMarks), which the pages
// load before this. A classic script: Work's and ChatDGC's pages and the Library load it before their own script, so
// all share window.DgcBlob.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcBlob) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // ---- the small menu: rows, then (for a session) its twelve palettes ---------------------------------------------------
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
    archive: '<path d="M2 3.5h12v3H2zM3.2 6.5V13h9.6V6.5M6.5 9.2h3"/>',
    reset: '<path d="M3 8a5 5 0 1 0 1.6-3.7M3 3v2.8h2.8"/>',
  };
  const icon = (name, filled = false) => `<svg viewBox="0 0 16 16" width="15" height="15" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`;

  /** The twelve palettes as still marks of the session's kind (Motes for a chat, Voxels for a Work session), six to a
   *  line, the one it wears marked. */
  function swatches(kind, { chosen } = {}) {
    const M = root.DgcMarks;
    if (!M) return "";
    return `<div class="dgc-menu-head" role="presentation"><span>Colour</span></div><div class="dgc-swatches" role="group" aria-label="Colour">`
      + M.PALETTES.map((name) => `<button type="button" class="dgc-swatch" role="menuitemradio" data-colour="${name}" aria-checked="${chosen === name ? "true" : "false"}"`
        + ` aria-label="${esc(M.label(name))}" title="${esc(M.label(name))}" tabindex="-1">${M.of(kind, name)}</button>`).join("")
      + `</div>`;
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
   *   colour: { kind: "work" | "chat", chosen }: the twelve palettes, the one it wears marked
   *   onPick(id), onColour(palette)
   *   at:     { x, y }: open at a point (a right-click), not beside the anchor
   *   place:  "above" (the default) or "below"
   * Keys: Up and Down between rows (and between the colours' two lines), Left and Right between colours, Home and End, Enter or Space to choose, Escape to
   * close and go back to what opened it, Tab to close and move on.
   */
  function popup(anchor, { rows = [], head = "", colour = null, onPick, onColour, onClose, at = null, place = "above", label = "", keyboard = false } = {}) {
    close();
    const doc = anchor.ownerDocument, view = doc.defaultView, menu = doc.createElement("div");
    menu.className = "dgc-menu dgc-pop"; menu.setAttribute("role", "menu");
    if (label) menu.setAttribute("aria-label", label);
    const groups = (Array.isArray(rows[0]) ? rows : [rows]).filter((g) => g && g.length);
    // (A row with `checked` said, true or false, is one of a picker's: the chosen one wears the check. A row that is
    // only { head } is a small heading over the rows after it.)
    const CHECK = '<svg class="dgc-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const row = (r) => (r.head ? `<div class="dgc-menu-head" role="presentation"><span>${esc(r.head)}</span></div>`
      : `<button type="button" role="${r.checked === undefined ? "menuitem" : "menuitemradio"}"${r.checked === undefined ? "" : ` aria-checked="${r.checked ? "true" : "false"}"`} class="dgc-menu-row${r.danger ? " is-danger" : ""}" data-id="${esc(r.id)}"${r.disabled ? " disabled" : ""}>`
      + (r.icon ? `<span class="dgc-pop-icon">${icon(r.icon)}</span>` : "") + `<span class="dgc-menu-label">${esc(r.label)}</span>${r.checked === undefined ? "" : CHECK}</button>`);
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
      if (picked !== undefined) onColour?.(picked);
      else onPick?.(id);
    };
    menu.addEventListener("click", (e) => choose(e.target));
    menu.addEventListener("contextmenu", (e) => e.preventDefault());
    menu.addEventListener("keydown", (e) => {
      const active = doc.activeElement, inDots = active?.classList?.contains("dgc-swatch");
      // The colours are one stop among the rows: Up and Down pass through them (line by line), Left and Right move along them.
      const list = [];
      for (const el of menu.querySelectorAll(".dgc-menu-row:not(:disabled), .dgc-swatches")) list.push(el);
      const here = list.indexOf(inDots ? active.parentElement : active);
      const go = (el) => { if (!el) return; (el.classList.contains("dgc-swatches") ? (el.querySelector('[aria-checked="true"]') || el.firstElementChild) : el).focus(); };
      // Six colours to a line: Down from the first line is the colour below it, Up from the second the one above.
      const all = inDots ? dots() : [], at = all.indexOf(active), line = Math.ceil(all.length / 2);
      const below = inDots && e.key === "ArrowDown" && at < line ? all[at + line] : null, above = inDots && e.key === "ArrowUp" && at >= line ? all[at - line] : null;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === "Tab") close(false);
      else if (below || above) { e.preventDefault(); (below || above).focus(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); go(list[(here + 1) % list.length]); }
      else if (e.key === "ArrowUp") { e.preventDefault(); go(list[(here - 1 + list.length) % list.length]); }
      else if (e.key === "Home") { e.preventDefault(); go(list[0]); }
      else if (e.key === "End") { e.preventDefault(); go(list[list.length - 1]); }
      else if (inDots && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        all[(at + (e.key === "ArrowRight" ? 1 : -1) + all.length) % all.length].focus();
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

  root.DgcBlob = Object.freeze({ popup, close, swatches, icon, isOpen: () => !!open, menu: () => open?.menu || null });
})();
