// The prompt box's shared pieces, the same in Work, ChatDGC and a Pip's chat (media/shared/composer.css is how they
// look): an attachment pill, the picture shown large just above the box, the "Drop to attach" overlay, and the Stop mark.
// Each box keeps its own attachments and its own paste and drop handling; these draw them alike. A classic script:
// Work's and ChatDGC's pages load it before their own script; the Pips bundle imports it.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcComposer) return;

  const make = (doc, tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  /**
   * One attachment pill. `name` is what it says; `src` a picture (data: or blob:) for its thumbnail, else `icon` (a codicon
   * name) stands in; `progress` 0..1 while it uploads (null when done); `failed` says "Failed"; `onOpen(pill)` when it is
   * clicked (a picture opens large above the box); `onRemove()` for ✕. `tag`, `classes` and `title` pass through. It keeps the
   * old hooks a box's tests look for: `thumbClass`, `nameClass` and `removeClass` are added beside the shared ones.
   */
  function pill(opts = {}) {
    const doc = opts.document || root.document;
    const node = make(doc, opts.tag || "span", ["dgc-att", opts.classes || ""].filter(Boolean).join(" "));
    if (opts.title) node.title = opts.title;
    // A pill with something to open (a picture) opens on a click; one without is only its words, so ✕ is its one button.
    const open = make(doc, opts.onOpen ? "button" : "span", "dgc-att-open");
    if (opts.onOpen) {
      open.type = "button";
      open.setAttribute("aria-label", opts.openLabel || (opts.src ? `Show ${opts.name || "the picture"}` : String(opts.name || "Attachment")));
    }
    const thumb = make(doc, "span", ["dgc-att-thumb", opts.thumbClass || ""].filter(Boolean).join(" "));
    if (opts.src) { const img = make(doc, "img"); img.alt = ""; img.decoding = "async"; img.src = opts.src; thumb.append(img); }
    else { const glyph = make(doc, "span", `codicon codicon-${opts.icon || "file"}`); glyph.setAttribute("aria-hidden", "true"); thumb.append(glyph); }
    const name = make(doc, "span", ["dgc-att-name", opts.nameClass || ""].filter(Boolean).join(" "), opts.name || "");
    open.append(thumb, name);
    if (opts.failed) { node.dataset.failed = ""; open.append(make(doc, "span", "dgc-att-state", "· Failed")); }
    node.append(open);
    if (opts.onOpen) open.addEventListener("click", (event) => { event.stopPropagation(); opts.onOpen(node); });
    if (opts.onRemove) {
      const x = make(doc, "button", ["dgc-att-x", opts.removeClass || ""].filter(Boolean).join(" "));
      x.type = "button";
      x.innerHTML = X_SVG;
      x.title = opts.removeTitle || "Remove";
      x.setAttribute("aria-label", opts.removeLabel || `Remove ${opts.name || "attachment"}`);
      x.addEventListener("click", (event) => { event.stopPropagation(); opts.onRemove(); });
      node.append(x);
    }
    setProgress(node, opts.progress);
    return node;
  }

  const X_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
  const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /**
   * The same pill as markup, for a page that draws its box from a string (a Pip's chat), whose own delegated clicks act on
   * it: `openAttrs` and `removeAttrs` are attribute text (e.g. `data-remove-image="0"`) put on its open part and its ✕.
   * `thumbText` puts a file's short type ("pdf") where a picture would be; `after` is trusted markup after the name.
   */
  function pillHtml(opts = {}) {
    const thumb = opts.src ? `<img src="${escHtml(opts.src)}" alt="${escHtml(opts.alt || "")}">`
      : opts.thumbText ? `<span class="dgc-att-ext">${escHtml(opts.thumbText)}</span>`
      : `<span class="codicon codicon-${escHtml(opts.icon || "file")}" aria-hidden="true"></span>`;
    const inner = `<span class="${["dgc-att-thumb", opts.thumbClass].filter(Boolean).join(" ")}">${thumb}</span>`
      + `<span class="${["dgc-att-name", opts.nameClass].filter(Boolean).join(" ")}">${escHtml(opts.name || "")}</span>`
      + (opts.after || "") + (opts.failed ? '<span class="dgc-att-state">· Failed</span>' : "");
    const open = opts.openAttrs
      ? `<button type="button" class="dgc-att-open" ${opts.openAttrs} aria-label="${escHtml(opts.openLabel || `Show ${opts.name || "the picture"}`)}">${inner}</button>`
      : `<span class="dgc-att-open">${inner}</span>`;
    const x = opts.removeAttrs ? `<button type="button" class="${["dgc-att-x", opts.removeClass].filter(Boolean).join(" ")}" ${opts.removeAttrs} title="${escHtml(opts.removeTitle || "Remove")}" aria-label="${escHtml(opts.removeLabel || `Remove ${opts.name || "attachment"}`)}">${X_SVG}</button>` : "";
    const value = opts.progress === null || opts.progress === undefined ? null : Math.max(0, Math.min(1, Number(opts.progress) || 0));
    return `<span class="${["dgc-att", opts.classes].filter(Boolean).join(" ")}"${opts.title ? ` title="${escHtml(opts.title)}"` : ""}`
      + `${value === null ? "" : ` data-progress="${Math.round(value * 100)}" style="--dgc-progress:${value}"`}${opts.failed ? " data-failed" : ""}>${open}${x}</span>`;
  }

  /** An upload's progress, 0..1, filled from the left; null or undefined when it is done. */
  function setProgress(node, progress) {
    if (progress === null || progress === undefined || Number.isNaN(Number(progress))) {
      node.removeAttribute("data-progress"); node.style.removeProperty("--dgc-progress"); return;
    }
    const value = Math.max(0, Math.min(1, Number(progress)));
    node.dataset.progress = String(Math.round(value * 100));
    node.style.setProperty("--dgc-progress", String(value));
  }

  // ---- the picture, large, in an island above the box
  let island = null, islandFrom = null, islandOff = null;
  /**
   * Show `src` large over `from` (a pill), inside `box` (positioned), at most 300 px tall and the box's width; a second
   * click on the same pill, Escape or a click anywhere else closes it. Returns the island.
   */
  function preview(from, { src, name = "", box } = {}) {
    if (!from || !src || !box) return null;
    if (island && islandFrom === from && !island.hidden) { closePreview(); return null; }
    closePreview();
    const doc = box.ownerDocument;
    island = make(doc, "figure", "dgc-att-preview");
    island.setAttribute("role", "dialog");
    island.setAttribute("aria-label", name ? `${name}, large` : "The picture, large");
    const img = make(doc, "img"); img.alt = name; img.src = src;
    island.append(img);
    if (name) island.append(make(doc, "figcaption", "", name));
    box.append(island);
    islandFrom = from;
    const place = () => {
      if (!island) return;
      const boxRect = box.getBoundingClientRect(), pillRect = from.getBoundingClientRect(), width = island.offsetWidth;
      const left = Math.max(0, Math.min(pillRect.left - boxRect.left, boxRect.width - width));
      island.style.left = `${Math.round(left)}px`;
      island.style.maxWidth = `${Math.round(boxRect.width)}px`;
    };
    img.addEventListener("load", place);
    place();
    const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closePreview(); from.querySelector(".dgc-att-open")?.focus(); } };
    const onDown = (event) => { if (!event.composedPath().some((n) => n === island || n === from)) closePreview(); };
    const scope = from.getRootNode?.() || doc;
    scope.addEventListener("keydown", onKey, true);
    doc.addEventListener("pointerdown", onDown, true);
    islandOff = () => { scope.removeEventListener("keydown", onKey, true); doc.removeEventListener("pointerdown", onDown, true); };
    return island;
  }
  function closePreview() {
    islandOff?.(); islandOff = null;
    island?.remove(); island = null; islandFrom = null;
  }

  // ---- files dragged over the box
  /**
   * While files are dragged over `box`, show "Drop to attach" over it (or `full` when `isFull()` says no more fit).
   * Pointer events pass through, so the box's own drop handler takes the files. Returns a function that stops it.
   */
  function dropZone(box, { label = "Drop to attach", full = "No more room for attachments", isFull = () => false, accepts, listen } = {}) {
    const doc = box.ownerDocument, on = listen || box;   // `listen`: a page that takes drops anywhere (ChatDGC's tab)
    const overlay = make(doc, "div", "dgc-drop", label);
    overlay.hidden = true;
    overlay.setAttribute("aria-hidden", "true");
    box.append(overlay);
    let depth = 0;
    const hasFiles = (event) => (accepts ? accepts(event) : [...(event.dataTransfer?.types || [])].includes("Files"));
    const show = () => { overlay.textContent = isFull() ? full : label; overlay.hidden = false; };
    const hide = () => { depth = 0; overlay.hidden = true; };
    const enter = (event) => { if (!hasFiles(event)) return; depth += 1; show(); };
    const over = (event) => { if (hasFiles(event) && overlay.hidden) show(); };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) overlay.hidden = true; };
    on.addEventListener("dragenter", enter);
    on.addEventListener("dragover", over);
    on.addEventListener("dragleave", leave);
    on.addEventListener("drop", hide);
    doc.addEventListener("dragend", hide);
    return () => {
      on.removeEventListener("dragenter", enter); on.removeEventListener("dragover", over);
      on.removeEventListener("dragleave", leave); on.removeEventListener("drop", hide); doc.removeEventListener("dragend", hide);
      overlay.remove();
    };
  }

  // Stop while a reply runs: a square inside a spinning arc (currentColor).
  const STOP = '<svg class="dgc-stop" viewBox="0 0 24 24" aria-hidden="true"><rect x="8.5" y="8.5" width="7" height="7" rx="1.4" fill="currentColor"/>'
    + '<path class="dgc-stop-arc" d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  root.DgcComposer = Object.freeze({ pill, pillHtml, setProgress, preview, closePreview, dropZone, STOP });
})();
