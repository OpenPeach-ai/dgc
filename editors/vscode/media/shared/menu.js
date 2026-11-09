// One menu for every "+" and picker, in Work, ChatDGC and a Pip's chat: the rows it draws and the keys it answers.
// media/shared/menu.css is how it looks. A classic script: Work's and ChatDGC's pages load it before their own script,
// and the Pips bundle imports it, so all three share window.DgcMenu.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcMenu) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // A hint that is a key you press is a small key cap; any other hint is quiet words.
  const KEY = /^(?:[@$/#!?:]|Esc|Enter|Tab|Space|Shift\+Tab|(?:Ctrl|Cmd|Alt|⌘|⌥|⇧)\+?\S{1,6})$/;
  const hintHtml = (hint) => (hint === undefined || hint === null || hint === "" ? ""
    : `<span class="dgc-menu-hint">${KEY.test(String(hint)) ? `<kbd class="dgc-key">${esc(hint)}</kbd>` : esc(hint)}</span>`);

  const CHECK = '<svg class="dgc-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  /**
   * Grouped rows as HTML. `groups`: [{ name?, rows: [{ id, icon?, label, sub?, hint?, checked?, classes?, attrs? }] }].
   * A group with a name gets a small heading; groups are parted by a hairline. `role` is "menuitem" for actions and
   * "menuitemradio" for a picker (then `checked` marks the chosen row, and `check` adds a check mark it shows). `sub` is
   * one quiet line under the row's name, which may wrap (a Pip's level says what it means). `data` names the data-* key
   * each row carries.
   */
  function html(groups, { role = "menuitem", data = "id", rowClass = "", check = false } = {}) {
    const visible = (groups || []).filter((g) => g && Array.isArray(g.rows) && g.rows.length);
    return visible.map((group, i) => (i ? '<div class="dgc-menu-div mdiv" role="separator"></div>' : "")
      + (group.name ? `<div class="dgc-menu-head mhead" role="presentation"><span>${esc(group.name)}</span></div>` : "")
      + group.rows.map((row) => {
        const checked = role === "menuitemradio" ? ` aria-checked="${row.checked ? "true" : "false"}"` : "";
        const sub = row.sub !== undefined && row.sub !== null && row.sub !== "";
        const classes = ["dgc-menu-row", sub ? "dgc-menu-row-sub" : "", rowClass, row.checked ? "is-selected" : "", row.classes || ""].filter(Boolean).join(" ");
        const attrs = row.attrs ? ` ${row.attrs}` : "";
        const label = `<span class="dgc-menu-label">${esc(row.label)}</span>`;
        return `<button type="button" role="${role}" class="${classes}" data-${data}="${esc(row.id)}"${checked}${attrs}>`
          + (row.icon ? `<span class="dgc-menu-icon codicon codicon-${esc(row.icon)}" aria-hidden="true"></span>` : "")
          + (sub ? `<span class="dgc-menu-words">${label}<span class="dgc-menu-sub">${esc(row.sub)}</span></span>` : label)
          + hintHtml(row.hint) + (check && role === "menuitemradio" ? CHECK : "") + "</button>";
      }).join("")).join("");
  }

  // A model row's ⋯ (D14): a quiet button at the row's right end, for what else that row can be (Use as fallback). It sits
  // in a .dgc-menu-item with its row, never inside it (a button can't hold a button); Right reaches it from its row, Left
  // goes back. `pill` is a small word at a row's right end: Main and Fallback in a model picker. The pill and the ⋯ share
  // that end: the pill at rest, the ⋯ while the row is hovered or focused, so every row's pill lines up at the edge.
  const DOTS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/></svg>';
  const more = (label, attrs = "", open = false) =>
    `<button type="button" class="dgc-menu-more" aria-label="${esc(label)}" aria-haspopup="true" aria-expanded="${open ? "true" : "false"}"${attrs ? ` ${attrs}` : ""}>${DOTS}</button>`;
  const pill = (text, kind = "") => `<span class="dgc-menu-pill${kind ? ` dgc-menu-pill-${esc(kind)}` : ""}">${esc(text)}</span>`;
  const item = (rowHtml, moreHtml = "", after = "") => `<div class="dgc-menu-item" role="presentation">${rowHtml}${moreHtml}</div>${after}`;

  // A row inside anything hidden is not a stop, and neither is a disabled one (as Work's menus always skipped them).
  const shown = (el) => !el.disabled && !el.closest("[hidden]");

  /**
   * The keys every menu answers, the same in all three chats: Down and Up move between rows (wrapping), Home and End
   * jump to the first and last, Escape closes and puts focus back on the button that opened it, and Tab closes and lets
   * focus move on. Enter and Space press the focused row, as any button does. In a search box inside the menu, Down
   * moves to the first row and Home, End and Up stay the box's own; a slider, and a key already handled, are left alone.
   * `close(viaEscape)` closes the menu; `trigger` is the button (or a function returning it) that opened it.
   */
  function handle(menu, event, { close, trigger, rows = ".dgc-menu-row" } = {}) {
    const key = event.key;
    if (key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      close?.(true);
      const back = typeof trigger === "function" ? trigger() : trigger;
      back?.focus?.();
      return true;
    }
    if (key === "Tab") { close?.(false); return false; }
    const target = event.target;
    // A slider (Work's effort slider, ChatDGC's thinking dial) keeps its arrow keys, and so does any key already handled.
    if (event.defaultPrevented || target?.matches?.("input[type=range], [role=slider]")) return false;
    const typing = target?.matches?.("input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable='true']");
    if (typing && key !== "ArrowDown") return false;
    const items = [...menu.querySelectorAll(rows)].filter(shown);
    if (!items.length) return false;
    // Inside a shadow root (a Pip in Work's side bar) the document's active element is the host: ask the menu's own root.
    const active = menu.getRootNode?.().activeElement || document.activeElement;
    // A row's ⋯: Right from the row, Left back; Up and Down from the ⋯ move on from its row.
    const dots = active?.classList?.contains("dgc-menu-more") ? active : null;
    const own = dots ? dots.parentElement?.querySelector(rows) : null;
    if (key === "ArrowRight" && !dots) {
      const beside = active?.parentElement?.classList?.contains("dgc-menu-item") ? active.parentElement.querySelector(".dgc-menu-more") : null;
      if (beside && shown(beside)) { event.preventDefault(); beside.focus(); return true; }
      return false;
    }
    if (key === "ArrowLeft" && dots && own) { event.preventDefault(); own.focus(); return true; }
    const at = items.indexOf(own || active);
    let next = null;
    if (key === "ArrowDown") next = typing || at < 0 ? 0 : (at + 1) % items.length;
    else if (key === "ArrowUp") next = at < 0 ? items.length - 1 : (at - 1 + items.length) % items.length;
    else if (key === "Home") next = 0;
    else if (key === "End") next = items.length - 1;
    if (next === null) return false;
    event.preventDefault();
    items[next].focus();
    return true;
  }

  /** Answer the menu keys on `menu` (see handle). Returns a function that stops listening. */
  function keys(menu, options) {
    const listener = (event) => handle(menu, event, options);
    menu.addEventListener("keydown", listener);
    return () => menu.removeEventListener("keydown", listener);
  }

  /** A long name stays on one line (its "…" at rest), and while its row is pointed at or focused it slides to show its
   *  end, pauses, and slides back (9 Nov, the user's call). Measured when the row is reached, so the room the row's ⋯
   *  takes is counted; a name that fits never moves; menu.css keeps it still for reduced motion. Once per menu (or a
   *  shadow root that redraws its menus): it listens on `menu` for every row drawn in it later. */
  function slide(menu) {
    if (!menu || menu.__dgcSlide) return;
    menu.__dgcSlide = true;
    const view = menu.ownerDocument?.defaultView || root;
    const DELAY = 0.35;                       // a moment's rest before it starts (menu.css's default)
    const labelOf = (row) => row && row.querySelector(".dgc-menu-label");
    // Which row is sliding, by what it shows: a menu that redraws gives it a new element.
    const keyOf = (row) => [row.getAttribute("data-i"), row.getAttribute("data-chat-model"), row.getAttribute("data-provider-i"),
                            labelOf(row)?.textContent || ""].join("|");
    const clock = () => (view.performance && view.performance.now ? view.performance.now() : Date.now());
    let active = null;                        // {key, started} of the name sliding now
    let pointer = null;                       // where the pointer last was over this menu
    const scope = menu.getRootNode ? menu.getRootNode() : menu.ownerDocument;
    // The row under the pointer, found again by where it is: a redrawn row isn't hovered until the pointer moves.
    const rowAtPointer = () => {
      if (!pointer || !scope || typeof scope.elementFromPoint !== "function") return null;
      const under = scope.elementFromPoint(pointer.x, pointer.y);
      const row = under && under.closest ? under.closest(".dgc-menu-row") : null;
      return row && menu.contains(row) ? row : null;
    };
    // The same name again (its row redrawn under the pointer or the focus) carries on from where it was.
    const start = (row) => {
      const label = labelOf(row);
      if (!label || label.classList.contains("is-sliding")) return;
      row.__dgcSlideWanted = true;
      view.requestAnimationFrame(() => {
        if (!row.__dgcSlideWanted) return;   // the pointer or the focus left before this frame
        if (!row.isConnected) {               // redrawn meanwhile: the same name in its new row
          const again = rowAtPointer();
          if (again && again !== row) { start(again); }
          return;
        }
        const hidden = Math.ceil(label.scrollWidth - label.clientWidth);
        if (hidden <= 1) return;
        const key = keyOf(row), resumed = !!active && active.key === key;
        if (!resumed) active = { key, started: clock() };
        const ran = (clock() - active.started) / 1000 - DELAY;
        label.style.setProperty("--dgc-slide", `${-hidden}px`);
        label.style.setProperty("--dgc-slide-time", `${Math.min(6, Math.max(1.6, hidden / 40)).toFixed(2)}s`);
        label.style.setProperty("--dgc-slide-delay", resumed && ran > 0 ? `${-ran.toFixed(2)}s` : `${DELAY}s`);
        label.classList.add("is-sliding");
        // Sliding, it shows its whole name itself: its tooltip would only cover the row above. Kept when it can't
        // move (reduced motion).
        const still = typeof view.matchMedia === "function" && view.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (!still && label.hasAttribute("title")) { label.dataset.dgcTitle = label.getAttribute("title"); label.removeAttribute("title"); }
      });
    };
    const stop = (row) => {
      if (row) row.__dgcSlideWanted = false;
      const label = labelOf(row);
      if (label) {
        label.classList.remove("is-sliding");
        if (label.dataset.dgcTitle !== undefined) { label.setAttribute("title", label.dataset.dgcTitle); delete label.dataset.dgcTitle; }
      }
      active = null;
    };
    // A row focused from the keyboard (not one the menu focused by itself as it opened, or after a click).
    const keyboardFocused = (row) => { try { return row.matches(":focus-visible"); } catch { return true; } };
    const rowOf = (event) => (event.target && event.target.closest ? event.target.closest(".dgc-menu-row") : null);
    menu.addEventListener("pointerover", (event) => { pointer = { x: event.clientX, y: event.clientY }; const row = rowOf(event); if (row && !row.contains(event.relatedTarget)) start(row); });
    menu.addEventListener("pointermove", (event) => { pointer = { x: event.clientX, y: event.clientY }; });
    menu.addEventListener("pointerout", (event) => { const row = rowOf(event); if (row && !row.contains(event.relatedTarget) && !keyboardFocused(row)) stop(row); });
    menu.addEventListener("focusin", (event) => { const row = rowOf(event); if (row && keyboardFocused(row)) start(row); });
    menu.addEventListener("focusout", (event) => { const row = rowOf(event); if (row && !row.contains(event.relatedTarget) && row.isConnected) stop(row); });
    // A menu that redraws its rows (a Pip's does every second or so) keeps the name under the pointer or the focus
    // sliding, from where it was, not from the start.
    if (view.MutationObserver) {
      const again = () => {
        if (!active) return;
        let row = null;
        try { row = menu.querySelector(".dgc-menu-row:hover"); } catch { row = null; }
        if (!row) row = rowAtPointer();
        if (!row) {
          const focused = (menu.activeElement !== undefined ? menu.activeElement : menu.ownerDocument?.activeElement) || null;
          row = focused && focused.closest ? focused.closest(".dgc-menu-row") : null;
          if (row && !menu.contains(row)) row = null;
        }
        if (row && keyOf(row) === active.key) start(row);
      };
      // After the redraw is laid out: the browser moves its hover to the new row only then.
      new view.MutationObserver(() => { again(); view.requestAnimationFrame(again); }).observe(menu, { childList: true, subtree: true });
    }
  }

  root.DgcMenu = Object.freeze({ html, keys, handle, hintHtml, KEY, esc, CHECK, DOTS, more, pill, item, slide });
})();
