// A picture in a chat, opened large in a pop-up inside the chat (his ask, 18 Nov: "clicking it opens up in the editor,
// maybe chat can open that image as a image pop up inside chat itself? where user can download from there too"). ONE
// module: ChatDGC's pictures and a Pip's chat's open it; Work's own viewer (media/main.js)
// wears the same actions. The picture large, centred over a dim backdrop, its name and size, and its actions as icons:
// Download (to the person's computer, media/shared/download.js), Save to Library (In Library, off, once it is there),
// Open in editor (the old way, now second) and Close. Escape, a click outside and Close close it; the arrows step
// through the other pictures of the same message. Focus goes into it, stays there, and goes back where it was.
//
// A classic script (the pages load it after icons.js and download.js; the Pips bundle imports it): window.DgcPicturePop.
//   open({ pictures, index, opener, host, onLibrary, onEditor, load })
//     pictures   [{ src, name, bytes, width, height, mime, library }]   library: "can" | "in" | "saving" | "" (none)
//     host       where the pop-up is put (default: the page's body; a shadow root's own box for a Pip in the side bar)
//     onLibrary(picture, i)  Save to Library pressed: returns a promise of { in_library } (or nothing: the caller sets it)
//     onEditor(picture, i)   Open in editor pressed (no button when absent)
//     load(picture, i)       the picture's full bytes when `src` is only a thumbnail: a promise of a data: URI
//   returns { el, close(), set(i, patch) }    set: a picture's library state or src, from the caller
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcPicturePop) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = (action) => root.DgcIcons?.html(action) || "";
  const size = (n) => (!Number(n) ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const CHEVRON = { prev: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5 5.5 8l4.5 4.5"/></svg>',
                    next: '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5 10.5 8 6 12.5"/></svg>' };
  let open_ = null;

  /** A picture's file name, with the ending its type says when it has none. */
  function fileName(picture) {
    const name = String(picture?.name || "Picture").trim() || "Picture";
    if (/\.[A-Za-z0-9]{2,5}$/.test(name)) return name;
    const type = String(picture?.mime || (/^data:([^;,]+)/.exec(String(picture?.src || ""))?.[1]) || "");
    return `${name}.${{ "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp" }[type] || "png"}`;
  }

  function open({ pictures = [], index = 0, opener = null, host = null, onLibrary = null, onEditor = null, load = null } = {}) {
    open_?.close(false);
    const list = pictures.filter(Boolean);
    if (!list.length) return null;
    const doc = (host?.ownerDocument || opener?.ownerDocument || root.document);
    // (Inside the shadow root a Pip in the side bar is drawn in, where its styles are; else the page's body.)
    const shadow = opener?.getRootNode?.(), place = host || (shadow && shadow !== doc && shadow.nodeType === 11 ? shadow : doc.body);
    let at = Math.max(0, Math.min(list.length - 1, Number(index) || 0));
    const back = opener || doc.activeElement;
    const view = doc.createElement("div");
    view.className = "dgc-picpop";
    view.setAttribute("role", "dialog"); view.setAttribute("aria-modal", "true");
    view.innerHTML = `<div class="dgc-picpop-box"><div class="dgc-picpop-head"><div class="dgc-picpop-words"><strong class="dgc-picpop-name"></strong><span class="dgc-picpop-meta"></span></div>`
      + `<div class="dgc-picpop-acts" role="toolbar" aria-label="Picture">`
      + `<button type="button" class="dgc-picpop-btn" data-act="download" aria-label="Download" title="Download to this computer">${icon("download")}</button>`
      + (onLibrary ? `<button type="button" class="dgc-picpop-btn" data-act="library" aria-label="Save to Library" title="Save to Library">${icon("library")}</button>` : "")
      + (onEditor ? `<button type="button" class="dgc-picpop-btn" data-act="editor" aria-label="Open in editor" title="Open in editor">${icon("open-in-editor")}</button>` : "")
      + `<button type="button" class="dgc-picpop-btn" data-act="close" aria-label="Close" title="Close (Esc)">${icon("close")}</button></div></div>`
      + `<div class="dgc-picpop-stage">${list.length > 1 ? `<button type="button" class="dgc-picpop-btn dgc-picpop-nav" data-act="prev" aria-label="Previous picture" title="Previous (←)">${CHEVRON.prev}</button>` : ""}`
      + `<img class="dgc-picpop-img" alt="">${list.length > 1 ? `<button type="button" class="dgc-picpop-btn dgc-picpop-nav" data-act="next" aria-label="Next picture" title="Next (→)">${CHEVRON.next}</button>` : ""}</div></div>`;
    const q = (s) => view.querySelector(s);
    const img = q(".dgc-picpop-img"), name = q(".dgc-picpop-name"), meta = q(".dgc-picpop-meta");
    const asking = new Set();

    function libraryButton() {
      const button = q('[data-act="library"]');
      if (!button) return;
      const state = list[at].library || "";
      const inLibrary = state === "in", saving = state === "saving";
      button.hidden = !state;
      button.disabled = inLibrary || saving;
      button.classList.toggle("is-in", inLibrary);
      const words = inLibrary ? "In Library" : saving ? "Saving to Library…" : "Save to Library";
      button.setAttribute("aria-label", words); button.title = words;
    }
    function show(i) {
      at = (i + list.length) % list.length;
      const p = list[at];
      const label = String(p.name || "Picture");
      view.setAttribute("aria-label", `Picture: ${label}`);
      name.textContent = label; name.title = label;
      const facts = [p.width && p.height ? `${p.width} × ${p.height}` : "", size(p.bytes), list.length > 1 ? `${at + 1} of ${list.length}` : ""].filter(Boolean);
      meta.textContent = facts.join(" · ");
      img.alt = label;
      if (p.src) img.src = p.src; else img.removeAttribute("src");
      view.classList.toggle("is-loading", !p.full && !!load);
      libraryButton();
      if (load && !p.full && !asking.has(p)) {
        asking.add(p);
        Promise.resolve(load(p, at)).then((src) => {
          if (typeof src === "string" && src) { p.src = src; p.full = true; }
        }).catch(() => {}).finally(() => { asking.delete(p); if (list[at] === p && view.isConnected) { view.classList.remove("is-loading"); if (p.src) img.src = p.src; } });
      }
    }
    function close(focusBack = true) {
      if (!view.isConnected) return;
      view.remove();
      doc.removeEventListener("keydown", onKey, true);
      if (open_?.el === view) open_ = null;
      if (focusBack && back?.isConnected && typeof back.focus === "function") back.focus({ preventScroll: true });
    }
    async function act(what, button) {
      const p = list[at];
      if (what === "close") close();
      else if (what === "prev") show(at - 1);
      else if (what === "next") show(at + 1);
      else if (what === "download") {
        const src = p.full || !load ? p.src : await Promise.resolve(load(p, at)).catch(() => "") || p.src;
        root.DgcDownload?.here(button, { name: fileName(p), data: src, mime: p.mime || "" });
      } else if (what === "library" && onLibrary && p.library === "can") {
        p.library = "saving"; libraryButton();
        try {
          const answer = await onLibrary(p, at);
          if (answer && typeof answer === "object") p.library = answer.in_library ? "in" : "can";
        } catch { p.library = "can"; }
        if (p.library === "saving") p.library = "can";
        libraryButton();
        if (p.library === "in") root.DgcDownload?.said(button, "Saved to Library");
      } else if (what === "editor" && onEditor) onEditor(p, at);
    }
    function onKey(e) {
      if (!view.isConnected) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); return; }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && list.length > 1) { e.preventDefault(); e.stopPropagation(); show(at + (e.key === "ArrowLeft" ? -1 : 1)); return; }
      if (e.key === "Tab") {
        // Focus stays in the pop-up while it is open.
        const stops = [...view.querySelectorAll("button")].filter((b) => !b.disabled && !b.hidden && b.getClientRects().length);
        if (!stops.length) return;
        const active = view.getRootNode().activeElement || doc.activeElement, i = stops.indexOf(active);
        if (e.shiftKey && i <= 0) { e.preventDefault(); stops[stops.length - 1].focus(); }
        else if (!e.shiftKey && (i === stops.length - 1 || i < 0)) { e.preventDefault(); stops[0].focus(); }
      }
    }
    view.addEventListener("click", (e) => {
      const button = e.target.closest?.("button[data-act]");
      if (button && view.contains(button)) { e.stopPropagation(); void act(button.dataset.act, button); return; }
      // A click outside the picture and its bar (on the dim backdrop) closes it.
      if (e.target === view || e.target === q(".dgc-picpop-stage")) close();
    });
    doc.addEventListener("keydown", onKey, true);
    place.append(view);
    show(at);
    q('[data-act="close"]').focus({ preventScroll: true });
    open_ = { el: view, close, set(i, patch) { if (!list[i]) return; Object.assign(list[i], patch || {}); if (i === at) { libraryButton(); if (patch?.src) img.src = patch.src; } }, get index() { return at; } };
    return open_;
  }

  root.DgcPicturePop = Object.freeze({ open, fileName, current: () => open_ });
})();
