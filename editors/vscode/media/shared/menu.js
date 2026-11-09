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

  root.DgcMenu = Object.freeze({ html, keys, handle, hintHtml, KEY, esc, CHECK, DOTS, more, pill, item });
})();
