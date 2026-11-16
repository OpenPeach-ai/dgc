// A file's menu, the same wherever a file is drawn: a row of the Library, and a file's card or chip in a chat (Work,
// ChatDGC, a Pip's chat), for what you attached and for what DGC or a Pip made or sent. Six things, in one order:
// Open · Open in editor · Save a copy… · Copy · Copy path · Reveal in file manager. What a kind can't do is shown off
// with why, never missing. The Library adds Rename… and Remove… under them; a chat never does: a chat is a record.
//
// The menu is DGC's small menu (media/shared/blob.js, window.DgcBlob.popup): beside the card's "…", or at the pointer on a
// right-click, with the keyboard (Shift+F10 or the context-menu key opens it, arrows, Enter, Escape back to the "…").
// A page never names a place on disk: a pick tells its host which file (by the reference the host gave it) and which of
// the six, and the host does it (src/fileActs.ts).
//
// A classic script: Work's and ChatDGC's pages and the Library load it before their own script, and the Pips bundle
// imports it, so all share window.DgcFileMenu.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcFileMenu) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** The six, in his order (15 Nov), the same for every kind of file. */
  const ACTS = Object.freeze([["open", "Open"], ["editor", "Open in editor"], ["save", "Save a copy…"], ["copy", "Copy"], ["path", "Copy path"], ["reveal", "Reveal in file manager"]]);
  const PICTURE = /\.(png|jpe?g|gif|webp|bmp)$/i;
  // A file whose text an editor shows and the clipboard takes (src/fileActs.ts keeps the same list).
  const TEXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|ini|cfg|conf|env|log|xml|html?|css|scss|less|js|jsx|mjs|cjs|ts|tsx|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|ps1|sql|r|lua|pl|tex|rst|srt|vtt|svg|diff|patch|gitignore|dockerfile|makefile)$/i;
  /** What a file is, by its name: "picture", "text" or "other". */
  const kindOf = (name) => (PICTURE.test(String(name || "")) ? "picture" : TEXT.test(String(name || "")) || /(^|\/)(Makefile|Dockerfile|LICENSE|README)$/.test(String(name || "")) ? "text" : "other");

  const KEPT = "DGC keeps this copy for the chat: Save a copy… to put it where you want";
  /** Why a file DGC keeps for a chat (by its digest: what a Pip sent, what you attached, what a reply made) can't do one
   *  of the six; "" when it can. */
  function whyKept(name, act) {
    const kind = kindOf(name);
    if (act === "editor") return kind === "text" ? "" : "An editor can't show this kind of file. Open shows it; Save a copy… keeps it.";
    if (act === "copy") return kind === "other" ? "Copy takes a picture or a text file's text. Use Save a copy… for this file." : "";
    if (act === "path" || act === "reveal") return KEPT;
    return "";
  }
  /** A file in your project (one you named with @, or one a turn made): its real place, so only Copy depends on its kind. */
  function whyProject(name, act) {
    return act === "copy" && kindOf(name) === "other" ? "Copy takes a picture or a text file's text. Use Copy path or Save a copy… for this file." : "";
  }
  /** A picture kept inside its session or its chat (one you pasted, one a reply made): it is shown and saved, not a file. */
  function whyPicture(act, where = "session") {
    if (act === "editor") return `This picture is kept inside its ${where}. Open shows it; Save a copy… makes a file.`;
    if (act === "path" || act === "reveal") return `This picture is kept inside its ${where}, not as a file. Save a copy… makes a file.`;
    return "";
  }
  /** The six as the menu's rows; `why(act)` says why one is off ("": it is on). */
  const rows = (why) => ACTS.map(([id, label]) => { const off = why ? why(id) : ""; return { id, label, ...(off ? { why: off } : {}) }; });

  const dots = () => (root.DgcIcons ? root.DgcIcons.html("more") : "…");
  /** The card's "…": always shown, a 6px control, reached by Tab. `key`: what the page finds the card by again. */
  const moreHtml = (name, key = "") => `<button type="button" class="dgc-file-more" data-file-more="${esc(key)}" aria-haspopup="menu" aria-expanded="false" title="More" aria-label="More for ${esc(name)}">${dots()}</button>`;
  function moreNode(doc, name, key = "") { const t = doc.createElement("template"); t.innerHTML = moreHtml(name, key); return t.content.firstChild; }

  // (A press on the "…" of an open menu closes it; the click that follows must not open it again. Where the press itself
  // closed the menu first — inside a shadow root the menu takes it for a press outside — `skip` remembers that "…".)
  let shut = { at: 0, anchor: null }, skip = null;
  /** Opens the menu beside `anchor` (its "…"), or at a point. opts: name, why(act), onPick(act), extra (more groups of rows,
   *  under the six), at {x, y}, keyboard, onClose. */
  function open(anchor, { name = "", why, onPick, extra = [], at = null, keyboard = false, pressed = false, onClose, place = "below" } = {}) {
    const blob = root.DgcBlob;
    if (!blob || !anchor) return null;
    // (`pressed`: a pointer's press on the "…" itself, which closes the menu it opened.)
    if (pressed && (anchor.getAttribute("aria-expanded") === "true" || skip === anchor)) { skip = null; blob.close(true); return null; }
    skip = null;
    return blob.popup(anchor, { keyboard, label: `More for ${name}`, place, rows: [rows(why), ...extra], ...(at ? { at } : {}),
      onPick: (id) => { if (!why || !why(id) || !ACTS.some(([a]) => a === id)) onPick?.(id); },
      onClose: () => { anchor.setAttribute("aria-expanded", "false"); shut = { at: Date.now(), anchor }; onClose?.(); } });
  }
  /** What a card's events mean: a click on its "…" (→ "click"), a right-click on it (→ "right"), Shift+F10 or the
   *  context-menu key from inside it (→ "keys"); "" for anything else. For a page that listens once for all its cards. */
  function gesture(event) {
    const t = event.target, card = t?.closest?.("[data-file-card]");
    if (!card) return "";
    if (event.type === "click") return t.closest(".dgc-file-more") ? "click" : "";
    if (event.type === "contextmenu") return "right";
    if (event.type === "keydown") return event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey) ? "keys" : "";
    return "";
  }
  /** Listens on `host` for every card inside it. `find(card)` → { name, why, onPick, extra? } or null (not a file's card). */
  function listen(host, find) {
    const on = (event) => {
      const how = gesture(event);
      if (!how) return;
      const card = event.target.closest("[data-file-card]"), more = card.querySelector(".dgc-file-more"), spec = more ? find(card) : null;
      if (!spec) return;
      event.preventDefault(); event.stopPropagation();
      const keyboard = how === "keys" || (how === "click" && event.detail === 0);
      open(more, { ...spec, keyboard, pressed: how === "click" && !keyboard, ...(how === "right" ? { at: { x: event.clientX, y: event.clientY } } : {}) });
    };
    host.addEventListener("pointerdown", (event) => { const more = event.target?.closest?.(".dgc-file-more"); skip = more && shut.anchor === more && Date.now() - shut.at < 8 ? more : null; }, true);
    host.addEventListener("click", on); host.addEventListener("contextmenu", on); host.addEventListener("keydown", on);
  }
  /** Marks `card` as a file's card and gives it its "…" (put in `into`, or at the card's end). side: "you" | "dgc" | "pip". */
  function mark(card, { name, side = "", key = "", into = null } = {}) {
    card.dataset.fileCard = ""; card.dataset.fileName = String(name || ""); if (side) card.dataset.fileSide = side;
    const more = moreNode(card.ownerDocument, name, key);
    (into || card).append(more);
    return more;
  }
  /** The attributes of a card drawn as markup (a Pip's chat). */
  const cardAttrs = (name, side = "") => ` data-file-card data-file-name="${esc(name)}"${side ? ` data-file-side="${esc(side)}"` : ""}`;

  /** A picture (a data: URI) as a PNG, which every app pastes. */
  function pngOf(doc, data) {
    return new Promise((resolve, reject) => {
      const comma = data.indexOf(","), mime = data.slice(5, data.indexOf(";"));
      if (mime === "image/png") {
        const raw = atob(data.slice(comma + 1)), bytes = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
        resolve(new Blob([bytes], { type: "image/png" })); return;
      }
      const img = new (doc.defaultView || root).Image();
      img.onerror = () => reject(new Error("not a picture"));
      img.onload = () => {
        try {
          const canvas = doc.createElement("canvas"); canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
          canvas.getContext("2d").drawImage(img, 0, 0);
          canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("not a picture"))), "image/png");
        } catch (error) { reject(error); }
      };
      img.src = data;
    });
  }
  const IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/;
  /** Copy: a picture the page holds (or its host handed it) goes to the clipboard, which only a page can write. */
  function copyPicture(doc, data) {
    const view = doc.defaultView || root;
    if (typeof data !== "string" || !IMAGE_DATA.test(data) || !view.navigator?.clipboard?.write || typeof view.ClipboardItem !== "function") return Promise.resolve(false);
    return pngOf(doc, data).then((blob) => view.navigator.clipboard.write([new view.ClipboardItem({ "image/png": blob })])).then(() => true, () => false);
  }
  /** "Copied", said beside the card's "…" for a moment (the host says its own in the status bar). */
  function said(anchor, words) {
    if (!anchor?.isConnected) return;
    const doc = anchor.ownerDocument, note = doc.createElement("span"), r = anchor.getBoundingClientRect();
    note.className = "dgc-file-said"; note.setAttribute("role", "status"); note.textContent = words;
    doc.body.append(note);
    const w = note.offsetWidth, vw = doc.documentElement.clientWidth;
    note.style.left = `${Math.round(Math.max(6, Math.min(vw - w - 6, r.left + r.width / 2 - w / 2)))}px`; note.style.top = `${Math.round(Math.max(6, r.top - note.offsetHeight - 6))}px`;
    setTimeout(() => note.remove(), 1800);
  }

  root.DgcFileMenu = Object.freeze({ ACTS, KEPT, kindOf, whyKept, whyProject, whyPicture, rows, moreHtml, moreNode, mark, cardAttrs, open, listen, gesture, pngOf, copyPicture, said });
})();
