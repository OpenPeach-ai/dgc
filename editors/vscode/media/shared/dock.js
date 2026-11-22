// The dock at the foot of DGC's side bar (media/shared/dock.css is how it looks): what you pinned, then "+", which is
// always last. What is always there (`fixed`: Your Browser, his call of 17 Nov) sits just before "+", on the right of the
// "|" divider with it: it can't be unpinned or moved, and nothing is dropped past it. Pointed at, the tiles swell toward the pointer and the one under it is named;
// a click opens it; a right-click (or the menu key, or Shift+F10) offers Open, Unpin, Move left and Move right, and a
// session's colours. Tab reaches the dock as one stop: Left and Right move between its items, Home and End jump to the
// first and the last, Enter opens.
//
// The pinned items are rearranged as on a Mac's dock: press one and drag it along the bar, and the others slide apart to
// open a gap where it would land; letting go puts it there (onReorder says its new place, and the page keeps it). A press
// that moves under 5 px is still a click. "+" is never moved and nothing is dropped past it. Escape puts the item back,
// and so does letting go outside the dock: a drag never removes anything. Alt+Left and Alt+Right move the focused item
// one place and say where it is now. Under reduced motion nothing slides: the gap is just there.
//
// Tiles are as large as Settings allows and shrink as items are added, down to 24 px. When even 24 px tiles would not
// fit the side bar, the dock steps aside until the side bar is wider: nothing is unpinned.
//
// Settings, "Show the dock": Always (it has its own room at the foot of the page, so nothing hides behind it), When I
// point at the bottom (it lies over the page, rises when the pointer reaches the bottom edge or the keyboard reaches
// it, and drops away a second after the pointer leaves), or Never.
//
// A page gives it what to show; this piece draws, sizes, moves and opens it:
//   const dock = DgcDock.create({ host, onOpen, onUnpin, onMove, onReorder, onColour, onNew, onMenu });
//   dock.update({ items: [{ key, kind, title, state, icon, dot, badge, fresh, colour, menu, gone }], fixed: [...], show, size, offers });
// An item may bring its menu's first rows itself (`menu`: groups of { id, label, icon, disabled }, a Work folder's: New
// session here, Open in new window, Unpin); "unpin" and "open" are answered here as ever, anything else by onMenu(key, id).
// One that is `gone` (a folder that is not there any more) is dimmed.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcDock) return;

  const MIN = 24;                         // the smallest a tile gets; below it the dock steps aside
  const MARGIN = 8;                       // the side bar's edge to the bar's
  const PEAK = 1.5;                       // how much the tile under the pointer grows
  const REACH = 2.6;                      // how far the pointer's pull reaches, in tiles
  const STIFFNESS = 320, DAMPING = 20, MASS = 0.1;   // the spring a tile's size rides: quick, and it never bounces
  const DROP_MS = 1000;                   // "When I point at the bottom": how long after the pointer leaves it drops away
  const DRAG_PX = 5;                      // how far a press moves before it is a drag, not a click
  const OUT_PX = 36;                      // how far above or below the bar the pointer is out of the dock
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PLUS = root.DgcIcons ? root.DgcIcons.html("add", { cls: "dgc-dock-plus" }) : "";       // New: the one glyph it has everywhere (media/shared/icons.js)

  // The bar's measures at a tile size: tighter gaps and sides once the tiles are small.
  const gapAt = (s) => (s >= 30 ? 6 : 4), padAt = (s) => (s >= 30 ? 8 : 6);
  /** How wide the bar is with `n` pinned items, `f` always there, and "+" at tile size `s`. */
  function widthAt(n, s, f = 0) {
    const gap = gapAt(s);
    return (n + f + 1) * s + (n + f) * gap + (n ? 2 + 1 + gap : 0) + 2 * padAt(s);
  }
  /** The largest tile, from `largest` down to 24 px, at which `n` items, `f` fixed ones and "+" fit a side bar `width`
   *  wide; 0: none does. */
  function fit(width, n, largest, f = 0) {
    for (let s = Math.max(MIN, Math.round(largest)); s >= MIN; s--) if (widthAt(n, s, f) <= width - 2 * MARGIN) return s;
    return 0;
  }

  function create(o) {
    const host = o.host, doc = host.ownerDocument, view = doc.defaultView;
    const still = () => typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
    host.classList.add("dgc-dock");
    host.innerHTML = '<div class="dgc-dock-hint" aria-hidden="true"></div>'
      + '<div class="dgc-dock-bar" role="toolbar" aria-orientation="horizontal" aria-label="Dock: what you pinned, then New"></div>'
      + '<div class="dgc-dock-tip" role="tooltip" hidden><b></b><span></span></div>'
      + '<div class="dgc-dock-live" role="status" aria-live="polite"></div>';
    const bar = host.querySelector(".dgc-dock-bar"), tip = host.querySelector(".dgc-dock-tip"), live = host.querySelector(".dgc-dock-live");
    tip.id = `${host.id || "dgc-dock"}-tip`;

    let items = [], fixed = [], show = "always", largest = 34, offers = { work: true, chat: true, pip: true, settings: true };
    let size = 0;                          // the tile size at rest now (0: stepped aside)
    let buttons = [];                      // every item's button, then "+"
    let drawn = "";                        // what the bar shows now, so the same state is never drawn twice
    let stop = null;                       // the key of the item Tab lands on ("+" for New); null until there is one
    let pointer = null;                    // the pointer's x over the dock, or null
    let named = null;                      // the button whose name shows
    let nameTimer = 0, nameFor = null;     // the button a resting pointer is about to name
    let cur = [], vel = [], frame = 0, last = 0;
    let up = false, dropTimer = 0, inBand = false;
    let drag = null;                       // a press on a pinned item: { key, button, id, x0, y0, x, y, from, to, active, tx }
    let swallow = false;                   // the click that follows a drag's release is not a click

    const keyOf = (button) => button?.dataset.key || "";
    const itemOf = (button) => items.find((item) => item.key === keyOf(button)) || fixed.find((item) => item.key === keyOf(button)) || null;
    const menuOpen = () => !!root.DgcBlob?.isOpen?.() && buttons.some((b) => b.getAttribute("aria-expanded") === "true");

    // ---- drawing -------------------------------------------------------------------------------------------------
    function draw() {
      const sig = JSON.stringify([items, fixed, show, offers]);
      if (sig === drawn) return;
      drawn = sig;
      const focused = bar.contains(doc.activeElement) ? keyOf(doc.activeElement) || "+" : "";
      if (stop === null || (stop !== "+" && ![...items, ...fixed].some((item) => item.key === stop))) stop = items[0]?.key || fixed[0]?.key || null;
      const tile = (item, always) => {
        // (A new message nobody has read: a small dot on the tile's top-right corner, never a number. What waits for your
        // okay wins the corner, so the dot is drawn only where there is no number.)
        const fresh = !!item.fresh && !item.badge;
        const said = [item.title, item.state, item.badge && !/waiting|okay/i.test(item.state || "") ? `${item.badge} waiting for you` : "", fresh ? "New message" : ""].filter(Boolean).join(". ");
        return `<button type="button" class="dgc-dock-item" data-key="${esc(item.key)}" data-kind="${esc(item.kind)}"${item.gone ? ' data-gone="1"' : ""}${always ? ' data-fixed="1"' : ""} tabindex="${item.key === stop ? 0 : -1}"`
          + ` aria-label="${esc(said)}" aria-haspopup="menu" aria-expanded="false" aria-keyshortcuts="Shift+F10">`
          + `<span class="dgc-dock-tile">${item.icon || ""}</span>`
          + (item.badge ? `<span class="dgc-dock-badge" aria-hidden="true">${esc(item.badge > 99 ? "99+" : item.badge)}</span>` : "")
          + (fresh ? '<span class="dgc-dock-new" aria-hidden="true"></span>' : "")
          + (item.dot ? `<span class="dgc-dock-dot" data-dot="${item.dot === "live" ? "live" : "open"}" aria-hidden="true"></span>` : "") + "</button>";
      };
      bar.innerHTML = items.map((item) => tile(item, false)).join("")
        + (items.length ? '<span class="dgc-dock-sep" aria-hidden="true"></span>' : "")
        + fixed.map((item) => tile(item, true)).join("")
        + `<button type="button" class="dgc-dock-item dgc-dock-add" data-add="1" tabindex="${stop === "+" || stop === null ? 0 : -1}" aria-label="New" aria-haspopup="menu" aria-expanded="false">`
        + `<span class="dgc-dock-tile">${PLUS}</span></button>`
        + (items.length ? "" : '<span class="dgc-dock-empty">Pin Pips and sessions here</span>');
      buttons = [...bar.querySelectorAll(".dgc-dock-item")];
      cur = buttons.map(() => size); vel = buttons.map(() => 0);
      named = null; tip.hidden = true;
      o.onDraw?.(bar);
      if (focused) (buttons.find((b) => (keyOf(b) || "+") === focused) || buttons[Math.min(buttons.length - 1, Math.max(0, items.length - 1))])?.focus({ preventScroll: true });
      host.dataset.fixed = String(fixed.length);
    }
    /** The tile size for this width, or stepped aside; then every tile at rest. */
    function layout() {
      host.dataset.show = show;
      host.hidden = show === "never";
      const width = doc.documentElement.clientWidth;
      const next = show === "never" ? 0 : fit(width, items.length, largest, fixed.length);
      host.dataset.state = next ? "shown" : "aside";
      host.dataset.count = String(items.length);
      if (next !== size) { size = next; cur = buttons.map(() => size); vel = buttons.map(() => 0); }
      if (!size) { o.onLayout?.({ size: 0, height: 0 }); return; }
      host.style.setProperty("--dock-s", `${size}px`);
      host.style.setProperty("--dock-gap", `${gapAt(size)}px`);
      host.style.setProperty("--dock-pad", `${padAt(size)}px`);
      apply();
      o.onLayout?.({ size, height: show === "always" ? host.offsetHeight : 0 });
    }
    function apply() {
      buttons.forEach((button, i) => {
        const s = Math.round((cur[i] || size) * 100) / 100;
        button.style.setProperty("--s", `${s}px`); button.style.setProperty("--k", String(s));
      });
      placeTip();
      if (drag?.active) placeDrag();
    }

    // ---- rearranging: drag a pinned item along the bar, or Alt+Left / Alt+Right ---------------------------------------
    /** The item to place `to` among the pinned ones, here at once and told to the page, which keeps it. */
    function reorder(key, to) {
      const from = items.findIndex((item) => item.key === key);
      if (from < 0 || to === from || to < 0 || to >= items.length) return false;
      const next = [...items]; next.splice(to, 0, next.splice(from, 1)[0]);
      items = next; stop = key; draw(); layout();
      o.onReorder?.(key, to, items.map((item) => item.key));
      return true;
    }
    function say(text) { live.textContent = ""; live.textContent = text; }
    /** While dragging: the dragged item under the pointer, and the others one place aside to open the gap. */
    function placeDrag() {
      const d = drag, n = items.length, gap = gapAt(size), wide = d.button.offsetWidth + gap;
      const left = bar.getBoundingClientRect().left;
      const centre = (b) => left + b.offsetLeft + b.offsetWidth / 2;          // where it lies, whatever it is moved by
      const out = d.y < bar.getBoundingClientRect().top - OUT_PX || d.y > bar.getBoundingClientRect().bottom + OUT_PX;
      // Its place: how many of the other pinned items lie left of the pointer. Out of the dock, it would go back.
      d.to = out ? d.from : buttons.slice(0, n).filter((b, i) => i !== d.from && centre(b) < d.x).length;
      buttons.slice(0, n).forEach((b, i) => {
        if (i === d.from) return;
        const shift = i > d.from && i <= d.to ? -wide : i < d.from && i >= d.to ? wide : 0;
        b.style.transform = shift ? `translateX(${shift}px)` : "";
      });
      d.button.style.transform = `translateX(${Math.round((d.x - centre(d.button)) * 100) / 100}px)`;
    }
    function endDrag(drop) {
      const d = drag; drag = null;
      if (!d) return;
      try { bar.releasePointerCapture(d.id); } catch { /* not held */ }
      if (!d.active) return;
      swallow = true; view.setTimeout(() => { swallow = false; }, 60);
      d.button.removeAttribute("data-drag");
      const moved = drop && d.to !== d.from;
      // Dropped in a new place: drawn there at once. Otherwise every item goes back where it was (sliding, unless still).
      if (moved) host.removeAttribute("data-dragging");
      for (const b of buttons) b.style.transform = "";
      if (moved) reorder(d.key, d.to);
      else view.setTimeout(() => { if (!drag) host.removeAttribute("data-dragging"); }, 200);
    }
    bar.addEventListener("pointerdown", (e) => {
      const button = e.target.closest?.(".dgc-dock-item");
      if (drag || e.button !== 0 || !button || button.dataset.add || button.dataset.fixed || menuOpen()) return;
      const from = buttons.indexOf(button);
      drag = { key: keyOf(button), button, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, from, to: from, active: false };
    });
    const onDragMove = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      drag.x = e.clientX; drag.y = e.clientY;
      if (!drag.active) {
        if (Math.hypot(drag.x - drag.x0, drag.y - drag.y0) < DRAG_PX || !size) return;
        drag.active = true;
        host.setAttribute("data-dragging", ""); drag.button.setAttribute("data-drag", "");
        name(null);
        try { bar.setPointerCapture(drag.id); } catch { /* the pointer is gone */ }
      }
      // The tiles still grow toward the pointer while one is carried.
      pointer = drag.x; kick();
      placeDrag();
    };
    const onDragUp = (e) => { if (drag && e.pointerId === drag.id) endDrag(e.type === "pointerup"); };
    const onDragKey = (e) => { if (drag?.active && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); endDrag(false); } };
    doc.addEventListener("pointermove", onDragMove);
    doc.addEventListener("pointerup", onDragUp); doc.addEventListener("pointercancel", onDragUp);
    doc.addEventListener("keydown", onDragKey, true);

    // ---- the magnify: every tile's size follows the pointer on a spring ------------------------------------------------
    /** Each tile's size with the pointer at `x`: full growth under it, falling away as a cosine over a few tiles, and never
     *  so much that the bar would pass the side bar's edges. */
    function wanted() {
      if (pointer === null || still() || menuOpen()) return buttons.map(() => size);
      const n = items.length, gap = gapAt(size), width = doc.documentElement.clientWidth;
      const left = (width - widthAt(n, size, fixed.length)) / 2 + padAt(size);
      // (The divider lies between the pinned items and what is always there with "+".)
      const centres = buttons.map((_, i) => left + i * (size + gap) + size / 2 + (n && i >= n ? 3 + gap : 0));
      const pull = centres.map((c) => { const d = Math.min(1, Math.abs(pointer - c) / (REACH * (size + gap))); return Math.cos(d * Math.PI / 2) ** 2; });
      // The bar keeps 6 px from each edge. Where the side bar has no room for it to grow, the far tiles give a little
      // (never more than a seventh) so the one under the pointer still grows, the way a lens does; past that, it grows less.
      const room = widthAt(n, size, fixed.length) - buttons.length * size, most = width - 12 - room;
      const at = (peak) => pull.map((p) => size * (1 + (peak - 1) * p)), sum = (list) => list.reduce((a, b) => a + b, 0);
      let peak = Math.min(PEAK, 60 / size), sizes = at(peak);
      for (let i = 0; i < 12; i++) {
        const give = most / sum(sizes);
        if (give >= 1) break;
        if (give >= 0.86) { sizes = sizes.map((v) => v * give); break; }
        peak = 1 + (peak - 1) * 0.85; sizes = at(peak);
      }
      return sum(sizes) > most + 0.5 ? buttons.map(() => size) : sizes;
    }
    function step(now) {
      frame = 0;
      const target = wanted(), dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;
      let moving = false;
      for (let i = 0; i < buttons.length; i++) {
        // Small steps: at this stiffness one step a frame would overshoot.
        for (let t = 0, h = dt / 8; t < 8; t++) {
          const force = STIFFNESS * (target[i] - cur[i]) - DAMPING * vel[i];
          vel[i] += (force / MASS) * h; cur[i] += vel[i] * h;
        }
        if (Math.abs(target[i] - cur[i]) < 0.05 && Math.abs(vel[i]) < 0.5) { cur[i] = target[i]; vel[i] = 0; } else moving = true;
      }
      apply();
      if (moving) frame = view.requestAnimationFrame(step);
    }
    function kick() {
      if (!size) return;
      if (still()) { cur = wanted(); vel = buttons.map(() => 0); apply(); return; }
      if (!frame) { last = view.performance.now(); frame = view.requestAnimationFrame(step); }
    }
    /** Every tile where it is going, at once (a test, or a page that must measure now). */
    function settle() { if (frame) view.cancelAnimationFrame(frame); frame = 0; cur = wanted(); vel = buttons.map(() => 0); apply(); }

    // ---- names ---------------------------------------------------------------------------------------------------
    function name(button) {
      if (!button && nameTimer) { view.clearTimeout(nameTimer); nameTimer = 0; nameFor = null; }
      if (button === named) { placeTip(); return; }
      if (named) named.removeAttribute("aria-describedby");
      named = button || null;
      const item = named ? itemOf(named) : null;
      const title = named?.dataset.add ? "New" : item?.title || "", state = named?.dataset.add ? "Work, a chat, a Pip, or Settings" : [item?.fresh && !item?.badge ? "New message" : "", item?.state || ""].filter(Boolean).join(" · ");
      if (!named || !title || menuOpen()) { tip.hidden = true; named = null; return; }
      tip.querySelector("b").textContent = title; tip.querySelector("span").textContent = state;
      tip.hidden = false; named.setAttribute("aria-describedby", tip.id);
      placeTip();
    }
    function placeTip() {
      if (!named || tip.hidden) return;
      const r = named.getBoundingClientRect(), h = host.getBoundingClientRect();
      // (Measured from the dock's left edge: measured where it last stood, near the right edge, its words were
      // squeezed into the sliver of room left there, one word to a line.)
      tip.style.left = "0px";
      const w = tip.offsetWidth;
      tip.style.left = `${Math.round(Math.max(6, Math.min(h.width - w - 6, r.left - h.left + r.width / 2 - w / 2)))}px`;
      tip.style.bottom = `${Math.round(h.bottom - r.top + 7)}px`;
    }

    // ---- menus ---------------------------------------------------------------------------------------------------
    function itemMenu(button, keyboard) {
      const item = itemOf(button), at = items.indexOf(item), pop = root.DgcBlob?.popup;
      if (!item || !pop) return;
      // What is always there has its own rows (Open, and what it brings), never Unpin or a move.
      const always = fixed.includes(item);
      // (Its tiles are at rest before the menu is placed: a menu placed against a tile still swollen under the pointer
      // stood off its tile, and off its centre, once the tile had settled.)
      name(null); pointer = null; settle();
      pop(button, { keyboard, label: item.title,
        rows: always ? (Array.isArray(item.menu) && item.menu.length ? item.menu : [[{ id: "open", label: "Open", icon: "open" }]])
          : [...(Array.isArray(item.menu) && item.menu.length ? item.menu : [[{ id: "open", label: "Open", icon: "open" }, { id: "unpin", label: "Unpin", icon: "unpin" }]]),
            [{ id: "left", label: "Move left", icon: "left", disabled: at === 0 }, { id: "right", label: "Move right", icon: "right", disabled: at === items.length - 1 }]],
        colour: item.colour ? { kind: item.kind, chosen: item.colour.chosen } : null,
        onPick: (id) => {
          if (id === "open") o.onOpen?.(item.key);
          else if (always && (id === "unpin" || id === "left" || id === "right")) return;
          else if (id === "unpin") o.onUnpin?.(item.key);
          else if (id === "left" || id === "right") { stop = item.key; o.onMove?.(item.key, id === "left" ? -1 : 1); }
          else o.onMenu?.(item.key, id);
        },
        onColour: (n) => o.onColour?.(item.key, n), onClose: watchLeave });
    }
    function addMenu(button, keyboard) {
      const pop = root.DgcBlob?.popup;
      if (!pop) return;
      name(null); pointer = null; settle();
      const made = [offers.work && { id: "work", label: "New work", icon: "work" }, offers.chat && { id: "chat", label: "New chat", icon: "chat" },
        offers.pip && { id: "pip", label: "New Pip", icon: "pip" }].filter(Boolean);
      pop(button, { keyboard, label: "New", rows: [made, offers.settings ? [{ id: "settings", label: "Settings", icon: "settings" }] : []],
        onPick: (id) => o.onNew?.(id), onClose: watchLeave });
    }

    // ---- pointer, keys -------------------------------------------------------------------------------------------
    // A tile's name comes to a pointer that has rested on it about 800 ms (asked 13 Nov: it was there the moment the
    // pointer arrived), as a tab's label does. Once a name is up it goes along the tiles with the pointer; leaving the
    // dock takes it away, and a pointer that only passes over gets none. The keyboard's focus is named at once.
    const NAME_AFTER_MS = 800;
    function nameSoon(button) {
      if (named) { nameLater(null); name(button); return; }
      if (button === nameFor) return;
      nameLater(button);
    }
    function nameLater(button) {
      view.clearTimeout(nameTimer); nameTimer = 0; nameFor = button || null;
      if (nameFor) nameTimer = view.setTimeout(() => { const due = nameFor; nameTimer = 0; nameFor = null; if (due && due.isConnected && pointer !== null && !drag?.active) name(due); }, NAME_AFTER_MS);
    }
    bar.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      pointer = e.clientX; kick();
      const over = drag?.active ? null : e.target.closest?.(".dgc-dock-item");
      if (over) nameSoon(over); else nameLater(null);
    });
    bar.addEventListener("pointerleave", () => { if (drag?.active) return; pointer = null; kick(); nameLater(null); if (!named?.matches(":focus-visible")) name(null); });
    bar.addEventListener("click", (e) => {
      if (swallow) { swallow = false; e.preventDefault(); e.stopPropagation(); return; }    // a drag's release
      const button = e.target.closest(".dgc-dock-item");
      if (!button) return;
      if (button.dataset.add) { if (button.getAttribute("aria-expanded") === "true") root.DgcBlob?.close?.(true); else addMenu(button, e.detail === 0); }
      else o.onOpen?.(keyOf(button));
    });
    bar.addEventListener("contextmenu", (e) => {
      const button = e.target.closest(".dgc-dock-item");
      e.preventDefault();
      if (button && !button.dataset.add) itemMenu(button, e.button !== 2 && e.detail === 0);
    });
    bar.addEventListener("keydown", (e) => {
      const button = e.target.closest?.(".dgc-dock-item");
      if (!button) return;
      const at = buttons.indexOf(button);
      const go = (i) => { e.preventDefault(); const next = buttons[(i + buttons.length) % buttons.length]; rove(next); next.focus(); };
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        // Alt+Left / Alt+Right: the item itself moves one place, and where it is now is said.
        e.preventDefault(); e.stopPropagation();
        if (button.dataset.add) return;
        if (button.dataset.fixed) { say("Always here, before New"); return; }
        const key = keyOf(button), n = items.length, to = at + (e.key === "ArrowLeft" ? -1 : 1);
        if (reorder(key, to)) say(`Moved to place ${to + 1} of ${n}`);
        else say(`Already ${to < 0 ? "first" : "last"} of ${n}`);
      }
      else if (e.key === "ArrowRight") go(at + 1);
      else if (e.key === "ArrowLeft") go(at - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(buttons.length - 1);
      else if ((e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) && !button.dataset.add) { e.preventDefault(); e.stopPropagation(); itemMenu(button, true); }
      else if (e.key === "ArrowUp" && button.dataset.add) { e.preventDefault(); addMenu(button, true); }
      else if (e.key === "Escape" && named) { name(null); }
    });
    function rove(button) { stop = keyOf(button) || "+"; for (const b of buttons) b.tabIndex = b === button ? 0 : -1; }
    bar.addEventListener("focusin", (e) => {
      const button = e.target.closest?.(".dgc-dock-item");
      if (!button) return;
      rove(button); rise();
      // Named for the keyboard as it is for the pointer; a click's focus is already named by the pointer.
      let keyed = true; try { keyed = button.matches(":focus-visible"); } catch { /* an older engine: name it */ }
      if (keyed) name(button);
    });
    bar.addEventListener("focusout", (e) => { if (!bar.contains(e.relatedTarget)) { if (pointer === null) name(null); watchLeave(); } });

    // ---- "When I point at the bottom" ---------------------------------------------------------------------------------
    function rise() { view.clearTimeout(dropTimer); dropTimer = 0; if (show !== "hover" || up) return; up = true; host.setAttribute("data-up", ""); }
    function drop() { dropTimer = 0; if (!up) return; up = false; host.removeAttribute("data-up"); pointer = null; name(null); settle(); }
    /** Start the second's wait, unless the pointer, the keyboard or an open menu still holds the dock up. */
    function watchLeave() {
      if (show !== "hover" || !up || dropTimer) return;
      if (inBand || bar.contains(doc.activeElement) || menuOpen()) return;
      dropTimer = view.setTimeout(() => { if (inBand || bar.contains(doc.activeElement) || menuOpen()) { dropTimer = 0; return; } drop(); }, DROP_MS);
    }
    const onMove = (e) => {
      if (show !== "hover" || !size) return;
      const edge = view.innerHeight - e.clientY <= 10;
      // Up: the whole band the dock stands in holds it, and so does a menu it opened.
      inBand = edge || (up && (e.clientY >= bar.getBoundingClientRect().top - 10 || !!e.target?.closest?.(".dgc-pop")));
      if (edge) rise();
      else if (inBand) { view.clearTimeout(dropTimer); dropTimer = 0; }
      else watchLeave();
    };
    const onLeave = () => { inBand = false; watchLeave(); };
    doc.addEventListener("pointermove", onMove, { passive: true });
    doc.documentElement.addEventListener("pointerleave", onLeave);
    const resized = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(() => layout()) : null;
    resized?.observe(doc.documentElement);

    function update(state = {}) {
      if (Array.isArray(state.items)) items = state.items.filter((item) => item && item.key);
      // What is always there, before "+" (never one of the pinned keys).
      if (Array.isArray(state.fixed)) fixed = state.fixed.filter((item) => item && item.key && !items.some((pinned) => pinned.key === item.key));
      if (state.show === "always" || state.show === "hover" || state.show === "never") {
        if (state.show !== show) { up = false; host.removeAttribute("data-up"); view.clearTimeout(dropTimer); dropTimer = 0; }
        show = state.show;
      }
      if (Number(state.size) >= MIN) largest = Math.min(48, Number(state.size));
      if (state.offers) offers = { ...offers, ...state.offers };
      draw(); layout();
    }
    /** A few words on an item, shown in its name's place for a while and said to a screen reader (Your Browser couldn't
     *  open, and why). */
    let noteTimer = 0;
    function note(key, words) {
      const button = buttons.find((b) => keyOf(b) === key), item = button ? itemOf(button) : null;
      if (!button || !item || !words || !size) return;
      view.clearTimeout(noteTimer);
      if (named && named !== button) named.removeAttribute("aria-describedby");
      named = button;
      tip.querySelector("b").textContent = item.title; tip.querySelector("span").textContent = String(words);
      tip.hidden = false; button.setAttribute("aria-describedby", tip.id); placeTip();
      say(`${item.title}: ${words}`);
      noteTimer = view.setTimeout(() => { if (named === button) name(null); }, 8000);
    }
    function dispose() {
      doc.removeEventListener("pointermove", onMove); doc.documentElement.removeEventListener("pointerleave", onLeave);
      doc.removeEventListener("pointermove", onDragMove); doc.removeEventListener("pointerup", onDragUp); doc.removeEventListener("pointercancel", onDragUp);
      doc.removeEventListener("keydown", onDragKey, true);
      resized?.disconnect(); if (frame) view.cancelAnimationFrame(frame); view.clearTimeout(dropTimer); view.clearTimeout(noteTimer);
    }
    return { update, layout, settle, dispose, note, element: host, bar, get size() { return size; }, get up() { return show !== "hover" || up; } };
  }

  root.DgcDock = Object.freeze({ create, fit, widthAt, MIN });
})();
