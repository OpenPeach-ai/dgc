"""Comments on a page: a small helper DGC's artifact server adds to a page it serves into a frame (the artifact panel's),
so the panel learns what is picked on the page and where, and can show a thread's place there.

A page is framed at its own address, on an origin of its own, so the panel can't read inside it. The helper is what
lets a comment point at a page's words: with the panel's handshake ({type: "dgc-comments", on: true}, from the window
that frames it), it says what is picked ({type: "dgc-comment-pick", anchor: {quote, path, near, tag}, rect}) to that
window only; asked to show a thread's place ({reveal: anchor}), it scrolls there and picks those words. It changes
nothing on the page and sends nothing anywhere else. It is added only to a framed page's HTML (the browser says
``Sec-Fetch-Dest: iframe``), never to a page opened in its own tab or to the files the store keeps; it is served from a
path no page file can have (``/.dgc-comments.js``: the store refuses dot files), so a page's own ``script-src 'self'``
allows it. A page whose own policy forbids it can still be commented on as a whole.
"""
from __future__ import annotations

import re

PATH = ".dgc-comments.js"
TAG = b'<script src="/.dgc-comments.js" defer></script>'

SCRIPT = r"""(() => {
  "use strict";
  if (window.parent === window || window.__dgcComments) return;
  window.__dgcComments = true;
  let parent = null, origin = "", on = false, wait = 0;
  const HEADING = /^H[1-6]$/;
  function near(el) {
    for (let at = el; at && at !== document.body; at = at.parentElement) {
      if (HEADING.test(at.tagName)) return at.textContent.replace(/\s+/g, " ").trim().slice(0, 200);
      for (let prev = at.previousElementSibling; prev; prev = prev.previousElementSibling) {
        if (HEADING.test(prev.tagName)) return prev.textContent.replace(/\s+/g, " ").trim().slice(0, 200);
        const inner = prev.querySelectorAll && prev.querySelectorAll("h1,h2,h3,h4,h5,h6");
        if (inner && inner.length) return inner[inner.length - 1].textContent.replace(/\s+/g, " ").trim().slice(0, 200);
      }
    }
    return "";
  }
  function path(el) {
    const parts = [];
    for (let at = el; at && at.nodeType === 1 && at !== document.body && at !== document.documentElement && parts.length < 12; at = at.parentElement) {
      let part = at.tagName.toLowerCase();
      if (at.id && /^[A-Za-z][\w-]{0,40}$/.test(at.id)) { parts.unshift(part + "#" + at.id); break; }
      const same = at.parentElement ? [...at.parentElement.children].filter((c) => c.tagName === at.tagName) : [];
      if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(at) + 1) + ")";
      parts.unshift(part);
    }
    return parts.join(" > ");
  }
  function say(data) {
    if (!parent) return;
    try { parent.postMessage(Object.assign({ type: "dgc-comment-pick" }, data || {}), origin && origin !== "null" ? origin : "*"); } catch (e) { /* the panel went */ }
  }
  function pick() {
    if (!on) return;
    const s = document.getSelection();
    const words = s ? String(s).replace(/\s+/g, " ").trim() : "";
    if (!s || s.isCollapsed || !s.rangeCount || !words) { say(null); return; }
    const range = s.getRangeAt(0), box = range.getBoundingClientRect();
    let el = range.commonAncestorContainer;
    if (el && el.nodeType !== 1) el = el.parentElement;
    if (!el) { say(null); return; }
    say({ anchor: { quote: words.slice(0, 2000), path: path(el), near: near(el), tag: el.tagName.toLowerCase() },
          rect: { left: box.left, top: box.top, right: box.right, bottom: box.bottom } });
  }
  function later(ms) { clearTimeout(wait); wait = setTimeout(pick, ms); }
  document.addEventListener("selectionchange", () => later(160));
  window.addEventListener("scroll", () => later(80), true);
  function find(anchor) {
    let el = null;
    try { el = anchor.path ? document.querySelector(anchor.path) : null; } catch (e) { el = null; }
    const quote = String(anchor.quote || "").replace(/\s+/g, " ").trim();
    const scope = el && (!quote || el.textContent.replace(/\s+/g, " ").includes(quote)) ? el : document.body;
    if (!quote) return { el: scope };
    const walk = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    const pieces = [];
    let text = "";
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const tag = n.parentElement ? n.parentElement.tagName : "";
      if (tag === "SCRIPT" || tag === "STYLE") continue;
      pieces.push([n, text.length]); text += n.data;
    }
    const flat = text.replace(/\s/g, " ");
    let at = flat.indexOf(quote);
    if (at < 0) return { el: scope === document.body ? null : scope };
    const end = at + quote.length;
    const range = document.createRange();
    for (const [n, from] of pieces) {
      if (from <= at && at <= from + n.data.length) range.setStart(n, at - from);
      if (from <= end && end <= from + n.data.length) { range.setEnd(n, end - from); break; }
    }
    return { el: scope, range };
  }
  function show(anchor) {
    const got = find(anchor || {});
    if (got.range) {
      const s = document.getSelection();
      s.removeAllRanges(); s.addRange(got.range);
      const node = got.range.startContainer.parentElement;
      if (node) node.scrollIntoView({ block: "center" });
    } else if (got.el) got.el.scrollIntoView({ block: "center" });
  }
  window.addEventListener("message", (e) => {
    if (e.source !== window.parent || !e.data || e.data.type !== "dgc-comments") return;
    parent = e.source; origin = e.origin;
    if (e.data.on) { on = true; later(0); }
    if (e.data.reveal && typeof e.data.reveal === "object") show(e.data.reveal);
  });
})();
"""

_BODY_END = re.compile(rb"</body\s*>", re.I)


def inject(html: bytes) -> bytes:
    """The page with the helper's script tag before its last </body> (or at its end): only what the server sends."""
    if TAG in html:
        return html
    found = list(_BODY_END.finditer(html))
    if found:
        at = found[-1].start()
        return html[:at] + TAG + html[at:]
    return html + TAG


def framed(headers) -> bool:
    """The browser is loading this page into a frame (an artifact panel's, the artifact list's)."""
    try:
        return str(headers.get("Sec-Fetch-Dest") or "").strip().lower() == "iframe"
    except Exception:                                      # noqa: BLE001 -- no headers: not framed
        return False
