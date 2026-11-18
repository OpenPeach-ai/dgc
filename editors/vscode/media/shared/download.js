// Download: a copy of a file saved on the computer the editor runs on (his asks, 18 Nov: Download opened a folder picker
// of the machine DGC runs on, where he wanted it simply saved on the computer his editor runs on, and the same on all
// surfaces). Every Download and Save a copy in DGC comes here: a chat's pictures and files (Work,
// ChatDGC, a Pip's chat), the Library, output and artifact cards, videos, Home's cards, a Pip's computer files and
// Notes' export.
//
// Why from the page: a page (a webview) runs in the editor's own window, on the person's computer, even when DGC and the
// extension host run on another machine over a remote connection. The editor's save dialog, opened by the host, browses
// the HOST's machine; a download started by the page lands on the person's own. So the bytes come to the page and the
// page saves them: a Blob, an object URL, and a hidden <a download> clicked.
//
// A classic script like media/shared/menu.js (the pages load it before their own script; the Pips bundle imports it), so
// all share window.DgcDownload. It listens for the host's answer itself: a host posts
//   { type: "dgcDownload", name, mime, data }      data: bytes (Uint8Array or ArrayBuffer), or a data: URI
// and the page saves it, then says "Downloaded" beside the control that asked (ask(control) marks it) for a moment.
// "Save to project" is not here: that one's place IS the project, on the machine DGC runs on, so it keeps its dialog.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcDownload) return;

  const MESSAGE = "dgcDownload";
  /** The most one download carries (the host refuses more, and says so: src/download.ts keeps the same number). */
  const MAX_BYTES = 512 * 1024 * 1024;
  /** How long the control that asked stays the one a host's answer is said beside. */
  const ASKED_MS = 120_000;
  let asked = null;            // { control, at }

  /** A name safe as one file name on any computer: no folders, no control characters, never empty. */
  function nameOf(name, fallback = "download") {
    const clean = String(name || "").split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f<>:"|?*]+/g, " ").replace(/\s+/g, " ").trim();
    return (clean.replace(/^\.+/, "").slice(0, 200) || fallback);
  }
  /** The bytes of what a host or a page holds: a Uint8Array, an ArrayBuffer, a typed array's JSON form, or a data: URI
   *  (base64 or plain). Null for anything else. */
  function bytesOf(data) {
    if (data instanceof Uint8Array) return data;
    // (By their tags too: bytes made in another window's realm are bytes all the same.)
    const tag = Object.prototype.toString.call(data);
    if (tag === "[object ArrayBuffer]" || tag === "[object SharedArrayBuffer]") return new Uint8Array(data);
    if (data && ArrayBuffer.isView?.(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data && Array.isArray(data.data)) return Uint8Array.from(data.data);
    if (typeof data === "string") {
      const m = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/s.exec(data);
      if (!m) return null;
      try {
        if (!m[3]) return new TextEncoder().encode(decodeURIComponent(m[4]));
        const text = atob(m[4].replace(/\s+/g, "")), out = new Uint8Array(text.length);
        for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
        return out;
      } catch { return null; }
    }
    return null;
  }
  /** A data: URI's own type ("image/png"), or "". */
  const typeOf = (data) => (typeof data === "string" ? (/^data:([^;,]+)/.exec(data)?.[1] || "") : "");

  /**
   * Save `data` as a file named `name` on this computer, from this page. data: bytes or a data: URI (a Blob is taken as
   * it is). True when the download was started; false when there was nothing to save.
   */
  function save(doc, { name, data, mime = "" } = {}) {
    doc = doc || root.document;
    if (!doc?.body || typeof URL?.createObjectURL !== "function") return false;
    let blob;
    if (typeof Blob !== "undefined" && data instanceof Blob) blob = data;
    else {
      const bytes = bytesOf(data);
      if (!bytes || bytes.byteLength > MAX_BYTES) return false;
      blob = new Blob([bytes], { type: String(mime || typeOf(data) || "application/octet-stream") });
    }
    const url = URL.createObjectURL(blob);
    const link = doc.createElement("a");
    link.href = url; link.download = nameOf(name); link.rel = "noopener"; link.hidden = true;
    link.dataset.dgcDownload = "";
    doc.body.append(link);
    try { link.click(); } finally { link.remove(); }
    // (The object URL is let go once the download has surely read it.)
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return true;
  }

  /** The control a host's coming answer is for: its "Downloaded" is said beside it. */
  function ask(control) { asked = control ? { control, at: Date.now() } : null; }
  /** A few words beside a control for a moment ("Downloaded"), read out too. */
  function said(control, words) {
    const doc = control?.ownerDocument || root.document;
    if (!doc?.body) return;
    // (A page's hover label hides while this stands: media/shared/tip.js, and Work's own.)
    const quiet = () => new (doc.defaultView?.CustomEvent || CustomEvent)("dgc-said", { bubbles: true, composed: true });
    if (control?.isConnected) control.dispatchEvent(quiet()); else doc.dispatchEvent(quiet());
    // (One note at a time: a new one takes the place of the last, "Saved to Library" never over "Downloaded".)
    for (const old of doc.querySelectorAll(".dgc-file-said")) old.remove();
    const note = doc.createElement("span");
    note.className = "dgc-file-said dgc-download-said";
    note.setAttribute("role", "status");
    note.textContent = String(words || "");
    // (Held to the screen on any page: the shared look is media/shared/doccard.css's, and these few stay inline.)
    note.style.position = "fixed"; note.style.zIndex = "1000"; note.style.pointerEvents = "none";
    doc.body.append(note);
    const r = control?.isConnected ? control.getBoundingClientRect() : null, vw = doc.documentElement.clientWidth || 300;
    const w = note.offsetWidth, h = note.offsetHeight;
    const left = r ? r.left + r.width / 2 - w / 2 : vw / 2 - w / 2, top = r ? r.top - h - 6 : 12;
    note.style.left = `${Math.round(Math.max(6, Math.min(vw - w - 6, left)))}px`;
    note.style.top = `${Math.round(Math.max(6, top))}px`;
    setTimeout(() => note.remove(), 1800);
  }
  /** A host's answer: saved, and said where the person clicked. */
  function take(message, doc = root.document) {
    if (!message || message.type !== MESSAGE) return false;
    const ok = save(doc, { name: message.name, data: message.data, mime: message.mime });
    const control = asked && Date.now() - asked.at < ASKED_MS && asked.control?.isConnected ? asked.control : null;
    asked = null;
    said(control, ok ? "Downloaded" : "Couldn’t download here");
    return ok;
  }
  /** Save what the page itself holds (a picture it shows, a chart it drew), and say so beside the control. */
  function here(control, file) {
    const ok = save(control?.ownerDocument || root.document, file);
    said(control, ok ? "Downloaded" : "Couldn’t download here");
    return ok;
  }

  // Only the host's own messages: a frame inside the page (a plugin's card) can post to this window too, and is never
  // let start a download. The host's come from the editor's frame around the page (this window's parent), or with no
  // source; a test page posts to itself.
  if (typeof root.addEventListener === "function") root.addEventListener("message", (event) => {
    const from = event?.source;
    if (event?.data?.type !== MESSAGE || (from && from !== root && from !== root.parent)) return;
    take(event.data);
  });
  root.DgcDownload = Object.freeze({ MESSAGE, MAX_BYTES, save, here, ask, said, take, bytesOf, nameOf });
})();
