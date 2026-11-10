// The dock at the foot of DGC's side bar (media/shared/dock.css is how it looks): what you pinned, then "+", which is
// always last. Pointed at, the tiles grow toward the pointer the way a macOS dock does and the one under it is named;
// a click opens it; a right-click (or the menu key, or Shift+F10) offers Open, Unpin, Move left and Move right, and a
// session's colours. Tab reaches the dock as one stop: Left and Right move between its items, Home and End jump to the
// first and the last, Enter opens.
//
// Tiles are as large as Settings allows and shrink as items are added, down to 24 px. When even 24 px tiles would not
// fit the side bar, the dock steps aside until the side bar is wider: nothing is unpinned.
//
// Settings, "Show the dock": Always (it has its own room at the foot of the page, so nothing hides behind it), When I
// point at the bottom (it lies over the page, rises when the pointer reaches the bottom edge or the keyboard reaches
// it, and drops away a second after the pointer leaves), or Never.
//
// A page gives it what to show; this piece draws, sizes, moves and opens it:
//   const dock = DgcDock.create({ host, onOpen, onUnpin, onMove, onColour, onNew });
//   dock.update({ items: [{ key, kind, title, state, icon, dot, badge, colour }], show, size, offers });
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
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const PLUS = '<svg class="dgc-dock-plus" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

  // The bar's measures at a tile size: tighter gaps and sides once the tiles are small.
  const gapAt = (s) => (s >= 30 ? 6 : 4), padAt = (s) => (s >= 30 ? 8 : 6);
  /** How wide the bar is with `n` pinned items (and "+") at tile size `s`. */
  function widthAt(n, s) {
    const gap = gapAt(s);
    return (n + 1) * s + n * gap + (n ? 2 + 1 + gap : 0) + 2 * padAt(s);
  }
  /** The largest tile, from `largest` down to 24 px, at which `n` items and "+" fit a side bar `width` wide; 0: none does. */
  function fit(width, n, largest) {
    for (let s = Math.max(MIN, Math.round(largest)); s >= MIN; s--) if (widthAt(n, s) <= width - 2 * MARGIN) return s;
    return 0;
  }

  function create(o) {
    const host = o.host, doc = host.ownerDocument, view = doc.defaultView;
    const still = () => typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
    host.classList.add("dgc-dock");
    host.innerHTML = '<div class="dgc-dock-hint" aria-hidden="true"></div>'
      + '<div class="dgc-dock-bar" role="toolbar" aria-orientation="horizontal" aria-label="Dock: what you pinned, then New"></div>'
      + '<div class="dgc-dock-tip" role="tooltip" hidden><b></b><span></span></div>';
    const bar = host.querySelector(".dgc-dock-bar"), tip = host.querySelector(".dgc-dock-tip");
    tip.id = `${host.id || "dgc-dock"}-tip`;

    let items = [], show = "always", largest = 34, offers = { work: true, chat: true, pip: true, settings: true };
    let size = 0;                          // the tile size at rest now (0: stepped aside)
    let buttons = [];                      // every item's button, then "+"
    let drawn = "";                        // what the bar shows now, so the same state is never drawn twice
    let stop = null;                       // the key of the item Tab lands on ("+" for New); null until there is one
    let pointer = null;                    // the pointer's x over the dock, or null
    let named = null;                      // the button whose name shows
    let cur = [], vel = [], frame = 0, last = 0;
    let up = false, dropTimer = 0, inBand = false;

    const keyOf = (button) => button?.dataset.key || "";
    const itemOf = (button) => items.find((item) => item.key === keyOf(button)) || null;
    const menuOpen = () => !!root.DgcBlob?.isOpen?.() && buttons.some((b) => b.getAttribute("aria-expanded") === "true");

    // ---- drawing -------------------------------------------------------------------------------------------------
    function draw() {
      const sig = JSON.stringify([items, show, offers]);
      if (sig === drawn) return;
      drawn = sig;
      const focused = bar.contains(doc.activeElement) ? keyOf(doc.activeElement) || "+" : "";
      if (stop === null || (stop !== "+" && !items.some((item) => item.key === stop))) stop = items[0]?.key || null;
      bar.innerHTML = items.map((item) => {
        const said = [item.title, item.state, item.badge && !/waiting|okay/i.test(item.state || "") ? `${item.badge} waiting for you` : ""].filter(Boolean).join(". ");
        return `<button type="button" class="dgc-dock-item" data-key="${esc(item.key)}" data-kind="${esc(item.kind)}" tabindex="${item.key === stop ? 0 : -1}"`
          + ` aria-label="${esc(said)}" aria-haspopup="menu" aria-expanded="false" aria-keyshortcuts="Shift+F10">`
          + `<span class="dgc-dock-tile">${item.icon || ""}</span>`
          + (item.badge ? `<span class="dgc-dock-badge" aria-hidden="true">${esc(item.badge > 99 ? "99+" : item.badge)}</span>` : "")
          + (item.dot ? `<span class="dgc-dock-dot" data-dot="${item.dot === "live" ? "live" : "open"}" aria-hidden="true"></span>` : "") + "</button>";
      }).join("")
        + (items.length ? '<span class="dgc-dock-sep" aria-hidden="true"></span>' : "")
        + `<button type="button" class="dgc-dock-item dgc-dock-add" data-add="1" tabindex="${stop === "+" || stop === null ? 0 : -1}" aria-label="New" aria-haspopup="menu" aria-expanded="false">`
        + `<span class="dgc-dock-tile">${PLUS}</span></button>`
        + (items.length ? "" : '<span class="dgc-dock-empty">Pin Pips and sessions here</span>');
      buttons = [...bar.querySelectorAll(".dgc-dock-item")];
      cur = buttons.map(() => size); vel = buttons.map(() => 0);
      named = null; tip.hidden = true;
      root.DgcBlob?.watch?.(bar);
      o.onDraw?.(bar);
      if (focused) (buttons.find((b) => (keyOf(b) || "+") === focused) || buttons[Math.min(buttons.length - 1, Math.max(0, items.length - 1))])?.focus({ preventScroll: true });
    }
    /** The tile size for this width, or stepped aside; then every tile at rest. */
    function layout() {
      host.dataset.show = show;
      host.hidden = show === "never";
      const width = doc.documentElement.clientWidth;
      const next = show === "never" ? 0 : fit(width, items.length, largest);
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
    }

    // ---- the magnify: every tile's size follows the pointer on a spring ------------------------------------------------
    /** Each tile's size with the pointer at `x`: full growth under it, falling away as a cosine over a few tiles, and never
     *  so much that the bar would pass the side bar's edges. */
    function wanted() {
      if (pointer === null || still() || menuOpen()) return buttons.map(() => size);
      const n = items.length, gap = gapAt(size), width = doc.documentElement.clientWidth;
      const left = (width - widthAt(n, size)) / 2 + padAt(size);
      const centres = buttons.map((_, i) => left + i * (size + gap) + size / 2 + (n && i === n ? 3 + gap : 0));
      const pull = centres.map((c) => { const d = Math.min(1, Math.abs(pointer - c) / (REACH * (size + gap))); return Math.cos(d * Math.PI / 2) ** 2; });
      // The bar keeps 6 px from each edge. Where the side bar has no room for it to grow, the far tiles give a little
      // (never more than a seventh) so the one under the pointer still grows, the way a lens does; past that, it grows less.
      const fixed = widthAt(n, size) - (n + 1) * size, most = width - 12 - fixed;
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
      if (button === named) { placeTip(); return; }
      if (named) named.removeAttribute("aria-describedby");
      named = button || null;
      const item = named ? itemOf(named) : null;
      const title = named?.dataset.add ? "New" : item?.title || "", state = named?.dataset.add ? "A session, a chat, a Pip, or Settings" : item?.state || "";
      if (!named || !title || menuOpen()) { tip.hidden = true; named = null; return; }
      tip.querySelector("b").textContent = title; tip.querySelector("span").textContent = state;
      tip.hidden = false; named.setAttribute("aria-describedby", tip.id);
      placeTip();
    }
    function placeTip() {
      if (!named || tip.hidden) return;
      const r = named.getBoundingClientRect(), h = host.getBoundingClientRect();
      const w = tip.offsetWidth;
      tip.style.left = `${Math.round(Math.max(6, Math.min(h.width - w - 6, r.left - h.left + r.width / 2 - w / 2)))}px`;
      tip.style.bottom = `${Math.round(h.bottom - r.top + 7)}px`;
    }

    // ---- menus ---------------------------------------------------------------------------------------------------
    function itemMenu(button, keyboard) {
      const item = itemOf(button), at = items.indexOf(item), pop = root.DgcBlob?.popup;
      if (!item || !pop) return;
      name(null); pointer = null; kick();
      pop(button, { keyboard, label: item.title,
        rows: [[{ id: "open", label: "Open", icon: "open" }, { id: "unpin", label: "Unpin", icon: "unpin" }],
          [{ id: "left", label: "Move left", icon: "left", disabled: at === 0 }, { id: "right", label: "Move right", icon: "right", disabled: at === items.length - 1 }]],
        colour: item.colour ? { kind: item.kind, chosen: item.colour.chosen, own: item.colour.own } : null,
        onPick: (id) => {
          if (id === "open") o.onOpen?.(item.key);
          else if (id === "unpin") o.onUnpin?.(item.key);
          else { stop = item.key; o.onMove?.(item.key, id === "left" ? -1 : 1); }
        },
        onColour: (n) => o.onColour?.(item.key, n), onClose: watchLeave });
    }
    function addMenu(button, keyboard) {
      const pop = root.DgcBlob?.popup;
      if (!pop) return;
      name(null); pointer = null; kick();
      const made = [offers.work && { id: "work", label: "New Work session", icon: "work" }, offers.chat && { id: "chat", label: "New ChatDGC chat", icon: "chat" },
        offers.pip && { id: "pip", label: "New Personal Pip", icon: "pip" }].filter(Boolean);
      pop(button, { keyboard, label: "New", rows: [made, offers.settings ? [{ id: "settings", label: "Settings", icon: "settings" }] : []],
        onPick: (id) => o.onNew?.(id), onClose: watchLeave });
    }

    // ---- pointer, keys -------------------------------------------------------------------------------------------
    bar.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") return;
      pointer = e.clientX; kick();
      const over = e.target.closest?.(".dgc-dock-item");
      if (over) name(over);
    });
    bar.addEventListener("pointerleave", () => { pointer = null; kick(); if (!named?.matches(":focus-visible")) name(null); });
    bar.addEventListener("click", (e) => {
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
      if (e.key === "ArrowRight") go(at + 1);
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
      if (state.show === "always" || state.show === "hover" || state.show === "never") {
        if (state.show !== show) { up = false; host.removeAttribute("data-up"); view.clearTimeout(dropTimer); dropTimer = 0; }
        show = state.show;
      }
      if (Number(state.size) >= MIN) largest = Math.min(48, Number(state.size));
      if (state.offers) offers = { ...offers, ...state.offers };
      draw(); layout();
    }
    function dispose() {
      doc.removeEventListener("pointermove", onMove); doc.documentElement.removeEventListener("pointerleave", onLeave);
      resized?.disconnect(); if (frame) view.cancelAnimationFrame(frame); view.clearTimeout(dropTimer);
    }
    return { update, layout, settle, dispose, element: host, bar, get size() { return size; }, get up() { return show !== "hover" || up; } };
  }

  root.DgcDock = Object.freeze({ create, fit, widthAt, MIN });
})();
