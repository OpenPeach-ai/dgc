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
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcFolderPick) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CHEVRON = '<svg class="dgc-folder-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const CHECK = '<svg class="dgc-menu-check" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
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

  /** The button: "Project Folder", what is chosen, a chevron. `id`, `cls` and `attrs` are the page's own; `empty` is
   *  what it says with nothing chosen where All projects is not a choice ("Choose a folder"). Its tooltip says the
   *  choice and, for one folder, its whole path (no line of its own names it), unless the page gives another. */
  function buttonHtml({ id = "", cls = "", rows = [], choice = "", label = "Project Folder", title = "", disabled = false, attrs = "", empty = ALL } = {}) {
    const value = valueOf(rows, choice, empty), row = rowsOf(rows).find((r) => r.folder === choice);
    return `<button type="button"${id ? ` id="${esc(id)}"` : ""} class="dgc-folder${cls ? ` ${esc(cls)}` : ""}" data-folder-pick="1" aria-haspopup="menu" aria-expanded="false"`
      + ` aria-label="${esc(`${label}: ${value}`)}" title="${esc(title || `${label}: ${value}${row ? `\n${row.folder}` : ""}`)}"${disabled ? " disabled" : ""}${attrs ? ` ${attrs}` : ""}>`
      + `<span class="dgc-folder-k">${esc(label)}</span> <span class="dgc-folder-v">${esc(value)}</span>${CHEVRON}</button>`;
  }

  let shown = null;
  /** Closes the open menu, if any. `back`: the keyboard returns to the button that opened it. */
  function close(back = false) {
    if (!shown) return;
    const was = shown; shown = null;
    was.doc.removeEventListener("pointerdown", was.outside, true);
    was.view.removeEventListener("blur", was.away); was.view.removeEventListener("resize", was.away);
    was.box.remove();
    const button = was.trigger();
    button?.setAttribute("aria-expanded", "false");
    if (back) button?.focus({ preventScroll: true });
  }

  /**
   * Opens the menu under `button`.
   *   rows       [{ folder, shown, name, here, exists }] (list_project_folders, the home folder as ~ in `shown`)
   *   choice     the folder chosen, or "" for All projects
   *   all        offer "All projects" (the filter); without it only folders (New Session, Create a Project Pip)
   *   add        offer "Add a folder…" at the end; onAdd() answers it
   *   goneOff    a folder that is gone can't be chosen (a session or a Pip can't start there)
   *   onChoose(folder)   a row was chosen ("" is All projects)
   *   trigger    a function that finds the button again (a page that redraws replaces it), for the keyboard's way back
   */
  function open(button, { rows = [], choice = "", all = true, add = false, goneOff = false, onChoose, onAdd, keyboard = false, label = "Project Folder", trigger } = {}) {
    close();
    const doc = button.ownerDocument, view = doc.defaultView, Menu = root.DgcMenu;
    // Inside a dialog the menu belongs to it (everything outside a modal dialog is inert); in the Pips view, to its own root.
    const home = button.getRootNode && button.getRootNode() !== doc ? button.getRootNode() : null;
    const holder = button.closest("dialog") || home || doc.body;
    const box = doc.createElement("div");
    box.className = "dgc-menu dgc-pop dgc-folder-menu"; box.setAttribute("role", "menu"); box.setAttribute("aria-label", label);
    const line = (folder, name, sub, note, checked, off) => `<button type="button" role="menuitemradio" class="dgc-menu-row dgc-folder-row${sub ? " dgc-menu-row-sub" : ""}${checked ? " is-selected" : ""}"`
      + ` data-folder="${esc(folder)}" aria-checked="${checked ? "true" : "false"}"${off ? " disabled" : ""}><span class="dgc-menu-words"><span class="dgc-menu-label">${esc(name)}</span>${sub ? `<span class="dgc-menu-sub">${sub}</span>` : ""}</span>`
      + (note ? `<span class="dgc-folder-note">${esc(note)}</span>` : "") + CHECK + "</button>";
    const list = rowsOf(rows);
    box.innerHTML = (all ? line("", ALL, "", "", !choice, false) + (list.length ? '<div class="dgc-menu-div" role="separator"></div>' : "") : "")
      + list.map((r) => line(r.folder, r.name || nameOf(r.folder), pathHtml(r.shown || r.folder, r.folder), r.exists === false ? "Not found" : r.here ? "This window" : "", r.folder === choice, goneOff && r.exists === false)).join("")
      + (add ? `${all || list.length ? '<div class="dgc-menu-div" role="separator"></div>' : ""}<button type="button" role="menuitem" class="dgc-menu-row dgc-folder-add" data-folder-add="1"><span class="dgc-menu-label">Add a folder…</span></button>` : "");
    holder.append(box);
    // Under the button, as wide as it at least, inside the view; above it when there is more room there.
    const a = button.getBoundingClientRect();
    box.style.minWidth = `${Math.round(Math.min(Math.max(a.width, 200), view.innerWidth - 12))}px`;
    const w = box.offsetWidth, below = view.innerHeight - a.bottom - 12, above = a.top - 12, up = box.offsetHeight > below && above > below;
    box.style.maxHeight = `${Math.max(120, Math.round(up ? above : below))}px`;
    const h = box.offsetHeight;
    box.style.left = `${Math.round(Math.max(6, Math.min(view.innerWidth - w - 6, a.left)))}px`;
    box.style.top = `${Math.round(Math.max(6, up ? a.top - h - 6 : Math.min(view.innerHeight - h - 6, a.bottom + 6)))}px`;
    box.style.setProperty("--pop-x", "24px"); box.style.setProperty("--pop-y", up ? "100%" : "0%");
    button.setAttribute("aria-expanded", "true");
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
    doc.addEventListener("pointerdown", outside, true);
    view.addEventListener("blur", away); view.addEventListener("resize", away);
    shown = { box, doc, view, outside, away, trigger: find };
    box.tabIndex = -1;
    (keyboard ? box.querySelector('[aria-checked="true"]:not(:disabled)') || box.querySelector(".dgc-menu-row:not(:disabled)") : box)?.focus({ preventScroll: true });
    return { box, close };
  }

  /** The open menu's box, or null: a page that draws again leaves it where it is. */
  const opened = () => (shown ? shown.box : null);

  root.DgcFolderPick = Object.freeze({ buttonHtml, pathHtml, pathNode, valueOf, open, close, opened, ALL });
})();
