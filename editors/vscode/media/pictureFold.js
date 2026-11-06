// Pictures and videos in a reply fold away, the same in Work, ChatDGC and a Pip's chat (0.51: "they always remain
// opened, and can disturb the user"). Each block of them gets one header row, "1 picture · felt purple ball" or
// "3 pictures", with a chevron: a click, Enter or Space folds it to that one line or opens it again. Folded, the header
// still offers Open (the first picture in the viewer). What a person chose for a block holds: the host keeps it
// (src/pictureFolds.ts) and hands it back after a reload or when the chat is opened again. A block nobody chose for
// follows Settings -> General -> Pictures in replies (Shown or Folded).
//
// DgcPictureFold.markup(key, inner, facts) -> the block as markup (a Pip's chat draws markup);
// DgcPictureFold.element(key, body, facts) -> the same as a node around `body` (Work, ChatDGC);
// DgcPictureFold.message(msg) -> true when it took a host message (pictureFolds: the choices and the setting);
// DgcPictureFold.host(post) -> where a choice is sent (the webview's postMessage).
(function (root) {
  "use strict";
  if (root.DgcPictureFold) return;
  const chosen = new Map();             // key -> folded, what a person chose (from the host, then as they choose)
  let folded = false;                   // Settings -> General -> Pictures in replies: Folded
  let post = null;
  let seq = 0;
  const roots = new Set();              // shadow roots a page draws in (a Pip's chat in the side bar), beside document
  const everywhere = (selector) => [...(typeof document === "undefined" ? [] : [document]), ...roots]
    .flatMap((r) => [...r.querySelectorAll(selector)]);

  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const words = (value, limit = 48) => {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text;
  };
  const isFolded = (key) => (chosen.has(key) ? chosen.get(key) : folded);

  /** A picture's file name as words: "a-small-felt-fox-20261103-022626.png" -> "a small felt fox". */
  function nameWords(label) {
    const text = String(label ?? "").trim();
    if (!text || /\s/.test(text)) return text;
    return text.replace(/\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i, "").replace(/[-_]\d{8}[-_]\d{4,6}$/, "")
      .replace(/[-_]+/g, " ").trim();
  }
  /** "1 picture · felt purple ball", "3 pictures", "1 video · a drone over the sea", "2 pictures and 1 video". */
  function summary({ pictures = 0, videos = 0, label = "" } = {}) {
    const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    const what = [pictures ? count(pictures, "picture", "pictures") : "", videos ? count(videos, "video", "videos") : ""]
      .filter(Boolean).join(" and ") || "Pictures";
    const named = words(nameWords(label));
    return pictures + videos === 1 && named ? `${what} · ${named}` : what;
  }

  const CHEVRON = '<svg class="pic-fold-chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function head(key, id, facts) {
    const shut = isFolded(key);
    const title = summary(facts);
    const open = facts.pictures ? `<button type="button" class="pic-fold-open" data-pic-fold-open title="Open the ${facts.pictures === 1 ? "picture" : "first picture"}"${shut ? "" : " hidden"}>Open</button>` : "";
    return `<div class="pic-fold-head"><button type="button" class="pic-fold-toggle" data-pic-fold-toggle aria-expanded="${!shut}" aria-controls="${esc(id)}" title="${shut ? "Show" : "Fold away"} ${esc(title)}">`
      + `${CHEVRON}<span class="pic-fold-title">${esc(title)}</span></button>${open}</div>`;
  }
  /** The block as markup: its header, then what it holds (hidden while folded). */
  function markup(key, inner, facts = {}) {
    const id = `pic-fold-${++seq}`;
    return `<section class="pic-fold" data-pic-fold="${esc(key)}" data-folded="${isFolded(key)}">${head(key, id, facts)}`
      + `<div class="pic-fold-body" id="${id}"${isFolded(key) ? " hidden" : ""}>${inner}</div></section>`;
  }
  /** The same block around a node already drawn. */
  function element(key, body, facts = {}) {
    const id = `pic-fold-${++seq}`;
    const shut = isFolded(key);
    const title = summary(facts);
    const section = document.createElement("section");
    section.className = "pic-fold";
    section.dataset.picFold = String(key);
    section.dataset.folded = String(shut);
    const header = document.createElement("div");
    header.className = "pic-fold-head";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pic-fold-toggle";
    toggle.dataset.picFoldToggle = "";
    toggle.setAttribute("aria-expanded", String(!shut));
    toggle.setAttribute("aria-controls", id);
    toggle.title = `${shut ? "Show" : "Fold away"} ${title}`;
    const chevron = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    chevron.setAttribute("class", "pic-fold-chev");
    chevron.setAttribute("viewBox", "0 0 16 16");
    chevron.setAttribute("width", "12");
    chevron.setAttribute("height", "12");
    chevron.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    for (const [name, value] of Object.entries({ d: "M6 4l4 4-4 4", fill: "none", stroke: "currentColor", "stroke-width": "1.5", "stroke-linecap": "round", "stroke-linejoin": "round" })) path.setAttribute(name, value);
    chevron.append(path);
    const words = document.createElement("span");
    words.className = "pic-fold-title";
    words.textContent = title;
    toggle.append(chevron, words);
    header.append(toggle);
    if (facts.pictures) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "pic-fold-open";
      open.dataset.picFoldOpen = "";
      open.title = `Open the ${facts.pictures === 1 ? "picture" : "first picture"}`;
      open.textContent = "Open";
      open.hidden = !shut;
      header.append(open);
    }
    const content = document.createElement("div");
    content.className = "pic-fold-body";
    content.id = id;
    content.hidden = shut;
    content.append(body);
    section.append(header, content);
    return section;
  }
  /** Every block of `key` on the page as it now is (a chat can show one reply twice: a split view, a redraw). */
  function paint(key) {
    const shut = isFolded(key);
    for (const section of everywhere(".pic-fold[data-pic-fold]")) {
      if (section.dataset.picFold !== key) continue;
      section.dataset.folded = String(shut);
      const toggle = section.querySelector(":scope > .pic-fold-head > .pic-fold-toggle");
      const title = section.querySelector(".pic-fold-title")?.textContent || "";
      toggle?.setAttribute("aria-expanded", String(!shut));
      toggle?.setAttribute("title", `${shut ? "Show" : "Fold away"} ${title}`);
      const open = section.querySelector(":scope > .pic-fold-head > .pic-fold-open");
      if (open) open.hidden = !shut;
      const body = section.querySelector(":scope > .pic-fold-body");
      if (body) body.hidden = shut;
    }
  }
  function choose(key, shut) {
    chosen.set(key, shut);
    paint(key);
    try { post?.({ type: "pictureFold", key, folded: shut }); } catch { /* the choice still holds here */ }
  }
  if (typeof document !== "undefined") document.addEventListener("click", (event) => {
    // Inside a shadow root the event reaches the document as its host: what was clicked is the path's first node.
    const target = (typeof event.composedPath === "function" && event.composedPath()[0]) || event.target;
    if (!target || typeof target.closest !== "function") return;
    const toggle = target.closest(".pic-fold-toggle[data-pic-fold-toggle]");
    const open = !toggle && target.closest(".pic-fold-open[data-pic-fold-open]");
    const section = (toggle || open)?.closest(".pic-fold[data-pic-fold]");
    if (!section) return;
    event.preventDefault();
    if (toggle) { choose(section.dataset.picFold, !isFolded(section.dataset.picFold)); return; }
    // Open, folded: the first picture opens in the viewer, as a click on it would (the block stays folded).
    const first = section.querySelector(".pic-fold-body [data-pic-open]") || section.querySelector(".pic-fold-body img");
    first?.click();
  });

  /** A host message: {type: "pictureFolds", folds?: {key: folded}, folded?: boolean}. True when taken. */
  function message(msg) {
    if (!msg || msg.type !== "pictureFolds") return false;
    if (msg.folds && typeof msg.folds === "object") {
      for (const [key, value] of Object.entries(msg.folds)) if (typeof value === "boolean" && key.length <= 300) chosen.set(key, value);
    }
    if (typeof msg.folded === "boolean") folded = msg.folded;
    const keys = new Set(everywhere(".pic-fold[data-pic-fold]").map((s) => s.dataset.picFold));
    for (const key of keys) paint(key);
    return true;
  }
  root.DgcPictureFold = { markup, element, summary, message, isFolded,
    host(fn) { post = typeof fn === "function" ? fn : null; },
    /** A shadow root this page draws replies in, so a fold there is painted too. */
    root(node) { if (node && typeof node.querySelectorAll === "function") roots.add(node); },
    /** A stable key from what a block holds (its pictures' names, its videos' jobs), for a page with no reply id. */
    keyOf(prefix, parts) {
      let h = 0x811c9dc5;
      for (const ch of String((parts || []).join("|"))) { h ^= ch.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
      return `${prefix}:${h.toString(36)}-${(parts || []).length}`;
    },
    // Tests and a page drawn before the host's answer: the setting as the page's own data says it.
    setDefault(value) { folded = value === true; } };
})(typeof window !== "undefined" ? window : globalThis);
