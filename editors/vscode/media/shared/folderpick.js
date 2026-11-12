// The Project Folder dropdown (0.52, 12 Nov): one button that names the folder chosen and opens the shared menu
// (media/shared/menu.js) with "All projects", then the folders that have a session or a Project Pip, this window's marked
// and a gone one marked "Not found", and (where a folder can be added) "Add a folder…" at its end. The same button and
// menu over the Work sessions, in New Session's dialog, on the Pips view's Project tab and in Create a Project Pip.
// media/shared/folderpick.css is how it looks. A classic script: Work's page loads it before its own script and the Pips
// bundle imports it, so both share window.DgcFolderPick. The page keeps the choice; this file draws and answers keys.
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
   *  is the tooltip. */
  function pathHtml(shown, full, cls = "") {
    const cut = String(shown || "").replace(/[\\/]+$/, "") || String(shown || "");
    const at = Math.max(cut.lastIndexOf("/"), cut.lastIndexOf("\\"));
    const head = at > 0 ? cut.slice(0, at) : "", tail = at > 0 ? cut.slice(at) : cut;
    return `<span class="dgc-path${cls ? ` ${esc(cls)}` : ""}" title="${esc(full || shown)}">`
      + (head ? `<span class="dgc-path-head${head.length > 2 ? " dgc-path-long" : ""}">${esc(head)}</span>` : "") + `<span class="dgc-path-tail">${esc(tail)}</span></span>`;
  }

  /** What the button says for a choice: "All projects", or the folder's own name. */
  function valueOf(rows, choice, empty = ALL) {
    if (!choice) return empty;
    const row = rowsOf(rows).find((r) => r.folder === choice);
    return row ? row.name || nameOf(row.folder) : nameOf(choice);
  }

  /** The button: "Project Folder", what is chosen, a chevron. `id`, `cls` and `attrs` are the page's own; `empty` is
   *  what it says with nothing chosen where All projects is not a choice ("Choose a folder"). */
  function buttonHtml({ id = "", cls = "", rows = [], choice = "", label = "Project Folder", title = "", disabled = false, attrs = "", empty = ALL } = {}) {
    const value = valueOf(rows, choice, empty), row = rowsOf(rows).find((r) => r.folder === choice);
    return `<button type="button"${id ? ` id="${esc(id)}"` : ""} class="dgc-folder${cls ? ` ${esc(cls)}` : ""}" data-folder-pick="1" aria-haspopup="menu" aria-expanded="false"`
      + ` aria-label="${esc(`${label}: ${value}`)}" title="${esc(title || (row ? row.folder : "Choose which project folder to show"))}"${disabled ? " disabled" : ""}${attrs ? ` ${attrs}` : ""}>`
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

  root.DgcFolderPick = Object.freeze({ buttonHtml, pathHtml, valueOf, open, close, opened, ALL });
})();
