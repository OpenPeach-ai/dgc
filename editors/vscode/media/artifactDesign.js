// A design, in the artifact panel (media/artifact.js): a canvas you pan and zoom, with its artboards where they sit.
// DGC draws the artboards one at a time and each shows as it is made; a frame not drawn yet says so. You select an
// artboard to move, resize, rename, duplicate, remove, play, download or comment on it; open it (double-click) to pick
// an element, change its text in place and its look in the panel beside; change the tweaks an artboard declares; add
// notes and pages. Each of those is saved at once as one version by you (the host sends it as ops, as DGC's own are).
//
// An artboard is a page someone wrote, so it is never part of this page: each shows in a frame of its own, sandboxed
// with no origin and with a policy that reaches nothing (no network: styles inline, pictures and fonts only as data
// inside it). Its own scripts never run on the canvas (they are switched off, and the policy refuses them); they run
// only while you play an artboard that says it is interactive. The one script a frame runs otherwise is DGC's own
// helper below (frameHelper), which says what is picked and makes the changes you ask for. Frames far from view, or
// too small to read, show a still picture of the artboard instead of a live frame.
(() => {
  "use strict";
  const A = (window.DgcArtifact = window.DgcArtifact || { editors: {} });
  const GAP_X = 80, GAP_Y = 120, MIN_ZOOM = 0.03, MAX_ZOOM = 4, MIN_SIDE = 100, MAX_W = 4000, MAX_H = 20000;
  const SNAP_PX = 7;                 // how close, on screen, an edge snaps to another frame's
  const LIVE_MAX = 10;               // live frames at once; the rest show their picture
  const LIVE_MIN_PX = 100;           // a frame narrower than this on screen shows its picture
  const PICTURE_MAX = 320 * 1024;    // an artboard larger than this has no picture (its frame shows its name)
  const SIZES = [["phone", "Phone", 390, 844], ["tablet", "Tablet", 834, 1194], ["desktop", "Desktop", 1440, 900], ["wide", "Wide screen", 1920, 1080],
                 ["square", "Square post", 1080, 1080], ["story", "Story", 1080, 1920], ["poster", "Poster", 1240, 1754], ["page", "Whole web page", 1280, 800]];
  const NOTE_COLORS = ["yellow", "pink", "blue", "green", "grey"];
  const POLICY = "default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'";
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

  // ---- the canvas's sums (the tests call these through window.DgcDesign) ------------------------------------------------
  /** A view is {x, y, k}: a point of the canvas (wx, wy) is on screen at (wx * k + x, wy * k + y). */
  function zoomAt(view, px, py, k) {
    const next = clamp(k, MIN_ZOOM, MAX_ZOOM);
    const wx = (px - view.x) / view.k, wy = (py - view.y) / view.k;      // the canvas point under the pointer stays there
    return { x: px - wx * next, y: py - wy * next, k: next };
  }
  function boundsOf(rects) {
    if (!rects.length) return null;
    const x = Math.min(...rects.map((r) => r.x)), y = Math.min(...rects.map((r) => r.y));
    return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
  }
  /** The view that shows all of `bounds` in a vw by vh window, centred, never larger than life. */
  function fitView(bounds, vw, vh, pad = 56, most = 1) {
    if (!bounds || vw <= 0 || vh <= 0) return { x: 0, y: 0, k: 1 };
    const k = clamp(Math.min((vw - 2 * pad) / Math.max(1, bounds.w), (vh - 2 * pad) / Math.max(1, bounds.h)), MIN_ZOOM, most);
    return { x: (vw - bounds.w * k) / 2 - bounds.x * k, y: (vh - bounds.h * k) / 2 - bounds.y * k, k };
  }
  function nearest(value, candidates, tol) {
    let best = null;
    for (const c of candidates) { const d = Math.abs(c.at - value); if (d <= tol && (!best || d < best.d)) best = { ...c, d }; }
    return best;
  }
  function guide(axis, at, a, b, kind) {
    // (A line along the snapped edge, as long as the two frames together; a gap's is the measure between them.)
    return axis === "x" ? { axis, at, from: Math.min(a.y, b.y), to: Math.max(a.y + a.h, b.y + b.h), kind }
                        : { axis, at, from: Math.min(a.x, b.x), to: Math.max(a.x + a.w, b.x + b.w), kind };
  }
  /** A frame being moved: its place snapped to the other frames' edges, or to 80 px beside and 120 px above or below one. */
  function snapMove(rect, others, tol) {
    const xs = [], ys = [];
    for (const o of others) {
      xs.push({ at: o.x, o, kind: "edge", line: o.x }, { at: o.x + o.w - rect.w, o, kind: "edge", line: o.x + o.w },
              { at: o.x + o.w, o, kind: "edge", line: o.x + o.w }, { at: o.x - rect.w, o, kind: "edge", line: o.x },
              { at: o.x + o.w + GAP_X, o, kind: "gap", line: o.x + o.w }, { at: o.x - GAP_X - rect.w, o, kind: "gap", line: o.x - GAP_X });
      ys.push({ at: o.y, o, kind: "edge", line: o.y }, { at: o.y + o.h - rect.h, o, kind: "edge", line: o.y + o.h },
              { at: o.y + o.h, o, kind: "edge", line: o.y + o.h }, { at: o.y - rect.h, o, kind: "edge", line: o.y },
              { at: o.y + o.h + GAP_Y, o, kind: "gap", line: o.y + o.h }, { at: o.y - GAP_Y - rect.h, o, kind: "gap", line: o.y - GAP_Y });
    }
    const sx = nearest(rect.x, xs, tol), sy = nearest(rect.y, ys, tol);
    const out = { x: sx ? sx.at : rect.x, y: sy ? sy.at : rect.y, guides: [] };
    const placed = { ...rect, x: out.x, y: out.y };
    if (sx) out.guides.push({ ...guide("x", sx.line, placed, sx.o, sx.kind), ...(sx.kind === "gap" ? { gap: GAP_X } : {}) });
    if (sy) out.guides.push({ ...guide("y", sy.line, placed, sy.o, sy.kind), ...(sy.kind === "gap" ? { gap: GAP_Y } : {}) });
    return out;
  }
  /** A frame being resized by a handle ("n", "se", …): the edges that move snap the same way; never smaller than 100. */
  function snapResize(rect, handle, others, tol) {
    let { x, y, w, h } = rect;
    const guides = [];
    const edge = (axis, value, gapSide) => {
      const list = [];
      for (const o of others) {
        if (axis === "x") list.push({ at: o.x, o, kind: "edge" }, { at: o.x + o.w, o, kind: "edge" }, { at: gapSide > 0 ? o.x - GAP_X : o.x + o.w + GAP_X, o, kind: "gap" });
        else list.push({ at: o.y, o, kind: "edge" }, { at: o.y + o.h, o, kind: "edge" }, { at: gapSide > 0 ? o.y - GAP_Y : o.y + o.h + GAP_Y, o, kind: "gap" });
      }
      return nearest(value, list, tol);
    };
    if (handle.includes("e")) { const s = edge("x", x + w, 1); if (s && s.at - x >= MIN_SIDE) { w = s.at - x; guides.push(guide("x", s.at, { x, y, w, h }, s.o, s.kind)); } }
    if (handle.includes("w")) { const s = edge("x", x, -1); if (s && x + w - s.at >= MIN_SIDE) { w = x + w - s.at; x = s.at; guides.push(guide("x", s.at, { x, y, w, h }, s.o, s.kind)); } }
    if (handle.includes("s")) { const s = edge("y", y + h, 1); if (s && s.at - y >= MIN_SIDE) { h = s.at - y; guides.push(guide("y", s.at, { x, y, w, h }, s.o, s.kind)); } }
    if (handle.includes("n")) { const s = edge("y", y, -1); if (s && y + h - s.at >= MIN_SIDE) { h = y + h - s.at; y = s.at; guides.push(guide("y", s.at, { x, y, w, h }, s.o, s.kind)); } }
    return { x, y, w: clamp(w, MIN_SIDE, MAX_W), h: clamp(h, MIN_SIDE, MAX_H), guides };
  }
  /** An artboard's tweaks as the CSS that sets them on its root, and the attributes its root gets (dgc/artifact_design
   *  writes the same for a download). */
  function tweakStyle(tweaks) {
    const rules = [], attrs = {};
    for (const t of Array.isArray(tweaks) ? tweaks : []) {
      if (!/^[a-z][a-z0-9-]{0,31}$/.test(String(t.name || ""))) continue;
      if (t.type === "switch") { rules.push(`--${t.name}:${t.value ? 1 : 0}`); attrs[`data-tweak-${t.name}`] = t.value ? "on" : "off"; }
      else if (t.type === "choice") { rules.push(`--${t.name}:"${String(t.value).replace(/[^A-Za-z0-9 _-]/g, "")}"`); attrs[`data-tweak-${t.name}`] = String(t.value).toLowerCase().replace(/ /g, "-"); }
      else if (/^[#.%a-zA-Z0-9-]{1,24}$/.test(String(t.value))) rules.push(`--${t.name}:${t.value}`);
    }
    return { css: rules.length ? `:root{${rules.join(";")}}` : "", attrs };
  }
  /** "rgb(181, 101, 29)" as "#b5651d" (what a colour box takes); "" when it has no solid colour. */
  function hexOf(color) {
    const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(String(color || "").trim());
    if (!m) return /^#[0-9a-f]{6}$/i.test(String(color || "").trim()) ? String(color).trim().toLowerCase() : "";
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return "";
    return "#" + [m[1], m[2], m[3]].map((n) => clamp(Number(n), 0, 255).toString(16).padStart(2, "0")).join("");
  }

  // ---- an artboard's frame -------------------------------------------------------------------------------------------------
  /** DGC's helper inside an artboard's frame. Self-contained: it is written into the frame as text. `cfg`: {mode: "view" |
   *  "edit" | "play", token}. It talks only to the window that frames it, and only says what is picked, what you
   *  changed and where a link goes; in play it does nothing but follow a link to another artboard. */
  function frameHelper(cfg) {
    const top = window.parent;
    if (!top || top === window) return;
    const say = (ev, data) => { try { top.postMessage(Object.assign({ type: "dgc-design", token: cfg.token, ev }, data || {}), "*"); } catch (e) { /* the canvas went */ } };
    const root = document.documentElement;
    const tall = () => Math.ceil(Math.max(root.scrollHeight, document.body ? document.body.scrollHeight : 0));
    const HEADING = /^H[1-6]$/;
    function near(el) {
      for (let at = el; at && at !== document.body; at = at.parentElement) {
        if (HEADING.test(at.tagName)) return at.textContent.replace(/\s+/g, " ").trim().slice(0, 200);
        for (let prev = at.previousElementSibling; prev; prev = prev.previousElementSibling) {
          if (HEADING.test(prev.tagName)) return prev.textContent.replace(/\s+/g, " ").trim().slice(0, 200);
        }
      }
      return "";
    }
    function path(el) {
      const parts = [];
      for (let at = el; at && at.nodeType === 1 && at !== document.body && at !== root && parts.length < 12; at = at.parentElement) {
        let part = at.tagName.toLowerCase();
        if (at.id && /^[A-Za-z][\w-]{0,40}$/.test(at.id)) { parts.unshift(part + "#" + at.id); break; }
        const same = at.parentElement ? [...at.parentElement.children].filter((c) => c.tagName === at.tagName) : [];
        if (same.length > 1) part += ":nth-of-type(" + (same.indexOf(at) + 1) + ")";
        parts.unshift(part);
      }
      return parts.join(" > ") || "body";
    }
    const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    const ownText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.data.trim());
    function info(el) {
      const cs = getComputedStyle(el);
      return { path: path(el), tag: el.tagName.toLowerCase(), text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 300), editable: ownText(el),
               near: near(el), rect: box(el.getBoundingClientRect()),
               styles: { color: cs.color, background: cs.backgroundColor, fontSize: cs.fontSize, fontWeight: cs.fontWeight,
                         padding: cs.paddingTop, gap: cs.rowGap === "normal" ? "" : cs.rowGap, radius: cs.borderTopLeftRadius,
                         flex: /flex|grid/.test(cs.display) } };
    }
    /** The page as its file should be: DGC's own nodes out, its scripts and handlers as they were written. */
    function serialize() {
      const copy = root.cloneNode(true);
      copy.querySelectorAll("[data-dgc-own]").forEach((n) => n.remove());
      for (const s of copy.querySelectorAll('script[type="dgc/off"]')) {
        const was = s.getAttribute("data-dgc-type");
        if (was) s.setAttribute("type", was); else s.removeAttribute("type");
        s.removeAttribute("data-dgc-type");
      }
      const all = [copy, ...copy.querySelectorAll("*")];
      for (const el of all) {
        for (const attr of [...el.attributes]) {
          if (attr.name.startsWith("data-dgc-on-")) { el.setAttribute("on" + attr.name.slice(12), attr.value); el.removeAttribute(attr.name); }
          else if (attr.name === "data-dgc-pick" || attr.name === "contenteditable" && el.hasAttribute("data-dgc-editing")) el.removeAttribute(attr.name);
        }
        el.removeAttribute("data-dgc-editing");
      }
      for (const name of String(copy.getAttribute("data-dgc-attrs") || "").split(" ").filter(Boolean)) copy.removeAttribute(name);
      copy.removeAttribute("data-dgc-attrs");
      return "<!doctype html>\n" + copy.outerHTML;
    }
    window.addEventListener("load", () => say("size", { height: tall() }));
    if (cfg.mode === "play") {
      document.addEventListener("click", (e) => {
        const el = e.target && e.target.closest ? e.target.closest("[data-goto], a[href]") : null;
        if (!el) return;
        const to = el.getAttribute("data-goto") || (/^#./.test(el.getAttribute("href") || "") ? el.getAttribute("href").slice(1) : "");
        if (to && !(el.tagName === "A" && !el.hasAttribute("data-goto") && document.getElementById(to))) { e.preventDefault(); say("goto", { target: to.slice(0, 120) }); }
        else if (el.tagName === "A" && !/^#/.test(el.getAttribute("href") || "")) e.preventDefault();          // a link out stays on the canvas
      }, true);
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") say("escape"); });
      say("ready", { height: tall() });
      return;
    }
    let picked = null, editing = null, before = "", wait = 0;
    const unpick = () => { if (picked) picked.removeAttribute("data-dgc-pick"); picked = null; };
    function pick(el, quiet) {
      if (!el || el === root) el = document.body;
      unpick(); picked = el; el.setAttribute("data-dgc-pick", "");
      if (!quiet) say("pick", { pick: info(el) });
    }
    function finish(keep) {
      if (!editing) return;
      const el = editing; editing = null;
      el.removeAttribute("contenteditable"); el.removeAttribute("data-dgc-editing");
      if (!keep) { el.innerHTML = before; say("pick", { pick: info(el) }); return; }
      if (el.innerHTML !== before) say("changed", { html: serialize(), note: "Edited text", pick: info(el), height: tall() });
    }
    function edit(el) {
      if (!el || !ownText(el)) return;
      finish(true); pick(el, true);
      editing = el; before = el.innerHTML;
      el.setAttribute("contenteditable", "plaintext-only"); el.setAttribute("data-dgc-editing", "");
      if (el.contentEditable !== "plaintext-only") el.setAttribute("contenteditable", "true");
      el.focus();
      const range = document.createRange(); range.selectNodeContents(el);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
      say("editing", { pick: info(el) });
    }
    if (cfg.mode === "edit") {
      document.addEventListener("click", (e) => {
        if (editing && editing.contains(e.target)) return;
        e.preventDefault(); e.stopPropagation();
        finish(true);
        if (e.detail < 2) pick(e.target.nodeType === 1 ? e.target : e.target.parentElement);
      }, true);
      document.addEventListener("dblclick", (e) => {
        e.preventDefault();
        let el = e.target.nodeType === 1 ? e.target : e.target.parentElement;
        while (el && el !== document.body && !ownText(el)) el = el.parentElement;
        edit(el && el !== document.body ? el : null);
      }, true);
      document.addEventListener("submit", (e) => e.preventDefault(), true);
      document.addEventListener("focusout", (e) => { if (editing && e.target === editing) setTimeout(() => { if (editing && document.activeElement !== editing) finish(true); }, 0); });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); if (editing) finish(false); else say("escape"); }
        else if (e.key === "Enter" && editing && !e.shiftKey) { e.preventDefault(); finish(true); }
      }, true);
      // (Words picked, for a comment on them: said a moment after the selection settles.)
      document.addEventListener("selectionchange", () => {
        clearTimeout(wait);
        wait = setTimeout(() => {
          if (editing) return;
          const s = getSelection(), words = s ? String(s).replace(/\s+/g, " ").trim() : "";
          if (!s || s.isCollapsed || !s.rangeCount || !words) { say("words", {}); return; }
          let el = s.getRangeAt(0).commonAncestorContainer;
          if (el && el.nodeType !== 1) el = el.parentElement;
          if (el) say("words", { anchor: { quote: words.slice(0, 2000), path: path(el), near: near(el), tag: el.tagName.toLowerCase() }, rect: box(s.getRangeAt(0).getBoundingClientRect()) });
        }, 180);
      });
      // (The canvas pans and zooms from here too: a frame keeps its wheel to itself otherwise.)
      window.addEventListener("wheel", (e) => { e.preventDefault(); say("wheel", { dx: e.deltaX, dy: e.deltaY, ctrl: e.ctrlKey || e.metaKey, x: e.clientX, y: e.clientY }); }, { passive: false });
    }
    function find(anchor) {
      let el = null;
      try { el = anchor && anchor.path ? document.querySelector(anchor.path) : null; } catch (e) { el = null; }
      const quote = String((anchor && anchor.quote) || "").replace(/\s+/g, " ").trim();
      if (el && (!quote || el.textContent.replace(/\s+/g, " ").includes(quote))) return el;
      if (!quote) return el;
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (n.parentElement && !/^(SCRIPT|STYLE)$/.test(n.parentElement.tagName) && n.data.replace(/\s+/g, " ").includes(quote.slice(0, 60))) return n.parentElement;
      }
      return el;
    }
    window.addEventListener("message", (e) => {
      const m = e.data;
      if (e.source !== top || !m || m.type !== "dgc-design" || m.token !== cfg.token) return;
      if (m.cmd === "style" && picked && /^[a-z-]{2,30}$/.test(String(m.prop || "")) && typeof m.value === "string" && m.value.length <= 60 && !/[;{}<>]|url\s*\(/i.test(m.value)) {
        finish(true);
        if (m.value) picked.style.setProperty(m.prop, m.value); else picked.style.removeProperty(m.prop);
        if (!picked.getAttribute("style")) picked.removeAttribute("style");
        say("changed", { html: serialize(), note: "Restyled", pick: info(picked), height: tall() });
      } else if (m.cmd === "reveal") {
        const el = find(m.anchor || {});
        if (el) { el.scrollIntoView({ block: "center" }); pick(el); }
      } else if (m.cmd === "clear") { finish(true); unpick(); }
      else if (m.cmd === "finish") finish(true);
    });
    say("ready", { height: tall() });
  }

  /** An artboard's page as its frame shows it: what it may not hold taken out, its scripts switched off (kept as written,
   *  so a change you make saves them back) unless it plays, its tweaks set, the policy, and DGC's helper. */
  function frameDoc(board, html, mode, nonce, token) {
    const doc = new DOMParser().parseFromString(String(html || ""), "text/html");
    doc.querySelectorAll("meta[http-equiv], base, link, iframe, frame, object, embed, portal").forEach((n) => n.remove());
    const runs = mode === "play" && board.interactive === true;
    for (const s of doc.querySelectorAll("script")) {
      s.removeAttribute("src");
      if (runs) s.setAttribute("nonce", nonce);
      else { if (s.hasAttribute("type")) s.setAttribute("data-dgc-type", s.getAttribute("type")); s.setAttribute("type", "dgc/off"); }
    }
    for (const el of doc.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) if (/^on[a-z]/i.test(attr.name)) { el.setAttribute("data-dgc-" + attr.name.toLowerCase().replace(/^on/, "on-"), attr.value); el.removeAttribute(attr.name); }
    }
    const { css, attrs } = tweakStyle(board.tweaks);
    for (const [k, v] of Object.entries(attrs)) doc.documentElement.setAttribute(k, v);
    if (Object.keys(attrs).length) doc.documentElement.setAttribute("data-dgc-attrs", Object.keys(attrs).join(" "));
    const own = (tag) => { const n = doc.createElement(tag); n.setAttribute("data-dgc-own", ""); return n; };
    const policy = own("meta");
    policy.setAttribute("http-equiv", "Content-Security-Policy");
    policy.setAttribute("content", `${POLICY}; script-src 'nonce-${nonce}'`);
    const style = own("style");
    // (What is picked wears the panel's own accent: a frame has no tokens of its own.)
    const accent = getComputedStyle(document.body).getPropertyValue("--accent").trim();
    const mark = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d\s.,%/]+\))$/.test(accent) ? accent : "Highlight";
    style.textContent = `${css}${mode === "play" ? "" : "html{overflow:hidden!important}"}`
      + (mode === "edit" ? `[data-dgc-pick]{outline:2px solid ${mark}!important;outline-offset:-2px!important}[data-dgc-editing]{outline:2px dashed ${mark}!important;outline-offset:2px!important;cursor:text!important}*{cursor:default}` : "");
    doc.head.prepend(policy, style);
    const helper = own("script");
    helper.setAttribute("nonce", nonce);
    helper.textContent = `(${frameHelper.toString()})(${JSON.stringify({ mode, token })});`;
    doc.body.append(helper);
    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  }
  /** A still picture of an artboard: its page drawn as an image (no script can run in one, and it can reach nothing). */
  function pictureOf(board, html) {
    if (!html || html.length > PICTURE_MAX) return "";
    try {
      const doc = new DOMParser().parseFromString(html, "text/html");
      doc.querySelectorAll("script, noscript, iframe, object, embed, link, meta, base, title").forEach((n) => n.remove());
      const { css, attrs } = tweakStyle(board.tweaks);
      const root = doc.documentElement;
      for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
      root.setAttribute("style", `display:block;width:${board.w}px;height:${board.h}px;overflow:hidden;background:#fff;${root.getAttribute("style") || ""}`);
      const style = doc.createElement("style");
      style.textContent = `${css.replace(":root", "html")}body{min-height:${board.h}px;box-sizing:border-box}`;
      doc.head.prepend(style);
      const xml = new XMLSerializer().serializeToString(root);
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${board.w}" height="${board.h}" viewBox="0 0 ${board.w} ${board.h}"><foreignObject x="0" y="0" width="${board.w}" height="${board.h}">${xml}</foreignObject></svg>`);
    } catch { return ""; }
  }
  const frameNonce = () => document.querySelector('meta[name="dgc-frame-nonce"]')?.getAttribute("content") || "";
  const newToken = () => { const a = new Uint32Array(3); crypto.getRandomValues(a); return [...a].map((n) => n.toString(36)).join(""); };

  window.DgcDesign = { GAP_X, GAP_Y, MIN_ZOOM, MAX_ZOOM, zoomAt, boundsOf, fitView, snapMove, snapResize, tweakStyle, hexOf, frameDoc, pictureOf, editor: null };

  // ---- the editor ------------------------------------------------------------------------------------------------------------
  A.editors.design = () => {
    let ctx, U, bar, tabs, stage, world, guidesBox, props, acts, playBar, zoomBtn, zoomMenu, hintBox;
    let index = { pages: [], boards: [], notes: [], start: {} }, pages = {};       // pages: board id -> its HTML
    let pageId = "", locked = false;
    let following = true;                    // the view is the fit DGC set: it keeps fitting as the canvas fills, until you move about
    const views = new Map();                 // page id -> its view
    let view = { x: 0, y: 0, k: 1 };
    let sel = null;                          // {kind: "board" | "note", id}
    let inside = "";                         // the board opened for editing (its frame takes the pointer)
    let picked = null;                       // what is picked in it (from its helper)
    let play = null;                         // {board, trail: [board ids], back: view}
    let drag = null, space = false, stale = false;
    const nodes = new Map();                 // board id -> {root, name, face, shield, key, token, frame, measured}
    const noteNodes = new Map();
    const pictures = new Map();              // "<id>|<rev>|<tweaks>" -> data address
    const measured = new Map();              // board id -> its page's height (a whole-page artboard)
    const heard = new Set();                 // boards already said to be drawn

    const boardOf = (id) => index.boards.find((b) => b.id === id);
    const noteOf = (id) => index.notes.find((n) => n.id === id);
    const onPage = () => index.boards.filter((b) => b.page === pageId);
    const heightOf = (b) => (b.fit === "page" && measured.has(b.id) ? Math.max(b.h, measured.get(b.id)) : b.h);
    const rectOf = (b) => ({ x: b.x, y: b.y, w: b.w, h: heightOf(b) });
    const tweakKey = (b) => JSON.stringify((b.tweaks || []).map((t) => [t.name, t.value]));
    const glyph = (action, codicon) => window.DgcIcons?.node?.(action, { size: 14 }) || U.icon(codicon || action);

    function read() {
      const content = ctx.state.content;
      index = content && typeof content === "object" && Array.isArray(content.boards)
        ? { pages: [], notes: [], start: {}, ...clone(content) } : { pages: [{ id: "p1", name: "Page 1" }], boards: [], notes: [], start: { page: "p1" } };
      const held = ctx.state.dstate?.boards;
      pages = held && typeof held === "object" ? { ...held } : {};
      if (!index.pages.some((p) => p.id === pageId)) pageId = index.pages.some((p) => p.id === index.start?.page) ? index.start.page : index.pages[0]?.id || "";
      if (sel && !(sel.kind === "board" ? boardOf(sel.id) : noteOf(sel.id))) { sel = null; inside = ""; picked = null; }
      if (inside && !boardOf(inside)) { inside = ""; picked = null; }
      if (play && !boardOf(play.board)) stopPlay();
    }

    // ---- what you change: sent as ops, shown at once
    function send(ops, said) {
      if (locked) return;
      U.post({ type: "designEdit", edits: ops });
      if (said) U.announce(said);
    }

    // ---- the view
    // (In a narrow panel the panel beside is a sheet under the canvas, one line until it is opened: the canvas is
    // what is left above it, so what is fitted is never under the sheet.)
    const narrow = () => !!window.matchMedia?.("(max-width: 560px)").matches;
    let sheetOpen = false;
    const size = () => ({ w: stage.clientWidth, h: stage.clientHeight });
    function setView(next, quiet, fitted = false) {
      following = fitted;
      view = { x: next.x, y: next.y, k: clamp(next.k, MIN_ZOOM, MAX_ZOOM), fitted };
      views.set(pageId, view);
      world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
      stage.style.setProperty("--dz-k", String(view.k));
      stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
      stage.style.backgroundSize = `${Math.max(12, 24 * view.k)}px ${Math.max(12, 24 * view.k)}px`;
      zoomBtn.firstChild.textContent = `${Math.round(view.k * 100)}%`;
      zoomBtn.setAttribute("aria-label", `Zoom: ${Math.round(view.k * 100)}%. Choose a zoom`);
      labels(); placeFloats();
      if (!quiet) scheduleFrames();
    }
    function everything() {
      return boundsOf([...onPage().map(rectOf), ...index.notes.filter((n) => n.page === pageId).map((n) => ({ x: n.x, y: n.y, w: n.kind === "title" ? 600 : 220, h: n.kind === "title" ? 60 : 140 }))]);
    }
    const padFor = (s) => Math.round(clamp(Math.min(s.w, s.h) * 0.07, 14, 56));
    function fitAll() { const s = size(); setView(fitView(everything(), s.w, s.h, padFor(s)), false, true); }
    function focusBoard(id, most = 1) {
      const b = boardOf(id);
      if (!b) return;
      if (b.page !== pageId) showPage(b.page);
      const s = size();
      setView(fitView(rectOf(b), s.w, s.h, Math.max(padFor(s), Math.min(64, s.w * 0.1)), most));
    }
    function zoomBy(factor, px, py) { const s = size(); setView(zoomAt(view, px ?? s.w / 2, py ?? s.h / 2, view.k * factor)); }
    const toWorld = (px, py) => ({ x: (px - view.x) / view.k, y: (py - view.y) / view.k });

    // ---- pages
    function showPage(id) {
      if (!index.pages.some((p) => p.id === id) || id === pageId) return;
      leaveInside();
      pageId = id; sel = null;
      paint();
      const kept = views.get(id);
      if (kept && !kept.fitted) setView(kept); else fitAll();
    }
    function paintTabs() {
      tabs.replaceChildren(...index.pages.map((p) => {
        const tab = U.el("button", "dz-tab", p.name); tab.type = "button";
        tab.setAttribute("role", "tab"); tab.setAttribute("aria-selected", String(p.id === pageId)); tab.dataset.page = p.id;
        tab.tabIndex = p.id === pageId ? 0 : -1;
        tab.title = `${p.name}: double-click to rename`;
        tab.addEventListener("click", () => showPage(p.id));
        tab.addEventListener("dblclick", () => renameInPlace(tab, p.name, 60, (name) => send([{ op: "page_rename", page: p.id, name }], `Page renamed ${name}.`)));
        tab.addEventListener("keydown", (e) => {
          const all = [...tabs.querySelectorAll(".dz-tab")], at = all.indexOf(tab);
          if (e.key === "ArrowRight") { e.preventDefault(); all[(at + 1) % all.length].focus(); all[(at + 1) % all.length].click(); }
          else if (e.key === "ArrowLeft") { e.preventDefault(); all[(at - 1 + all.length) % all.length].focus(); all[(at - 1 + all.length) % all.length].click(); }
          else if (e.key === "F2") { e.preventDefault(); tab.dispatchEvent(new MouseEvent("dblclick")); }
        });
        return tab;
      }));
      const add = U.el("button", "art-icon dz-tab-add"); add.type = "button";
      add.title = "Add a page"; add.setAttribute("aria-label", "Add a page"); add.append(glyph("add"));
      add.disabled = locked || index.pages.length >= 12;
      add.addEventListener("click", () => {
        let n = index.pages.length + 1;
        while (index.pages.some((p) => p.name.toLowerCase() === `page ${n}`)) n += 1;
        send([{ op: "page_add", name: `Page ${n}` }], `Page ${n} added.`);
      });
      tabs.append(add);
    }
    /** A name changed where it is shown: the words become a box; Enter keeps it, Escape leaves it. */
    function renameInPlace(node, value, max, keep) {
      if (locked) return;
      const input = U.el("input", "dz-rename"); input.type = "text"; input.value = value; input.maxLength = max;
      input.setAttribute("aria-label", "Name");
      input.style.width = `${Math.max(80, node.getBoundingClientRect().width + 24)}px`;
      const done = (save) => {
        if (!input.isConnected) return;
        const next = input.value.replace(/\s+/g, " ").trim();
        input.replaceWith(node);
        if (save && next && next !== value) keep(next);
      };
      input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") { e.preventDefault(); done(true); } else if (e.key === "Escape") { e.preventDefault(); done(false); } });
      input.addEventListener("blur", () => done(true));
      input.addEventListener("pointerdown", (e) => e.stopPropagation());
      node.replaceWith(input); input.focus(); input.select();
    }

    // ---- drawing the canvas
    function waitingWords(b) {
      const first = index.boards.find((x) => x.state !== "ready");
      const fresh = Date.now() - Date.parse(String(ctx.state.view?.updated || "")) < 180_000;
      return first && first.id === b.id && fresh ? "Drawing…" : "Not drawn yet";
    }
    function boardNode(b) {
      let n = nodes.get(b.id);
      if (!n) {
        const root = U.el("div", "dz-board"); root.dataset.board = b.id;
        const name = U.el("div", "dz-name");
        const title = U.el("span", "dz-name-title"), short = U.el("span", "dz-name-short"), dims = U.el("span", "dz-name-size");
        short.setAttribute("aria-hidden", "true");
        name.append(title, short, dims);
        const face = U.el("div", "dz-face"), shield = U.el("div", "dz-shield");
        root.append(name, face, shield);
        for (const h of ["n", "e", "s", "w", "ne", "se", "sw", "nw"]) { const g = U.el("i", "dz-handle"); g.dataset.handle = h; root.append(g); }
        n = { root, name, title, short, dims, face, shield, key: "", token: "", frame: null, loads: 0 };
        nodes.set(b.id, n);
        world.append(root);
        title.addEventListener("dblclick", (e) => { e.stopPropagation(); renameInPlace(title, boardOf(b.id)?.title || "", 80, (t) => send([{ op: "rename", board: b.id, title: t }], `Renamed ${t}.`)); });
      }
      const h = heightOf(b);
      n.root.style.left = `${b.x}px`; n.root.style.top = `${b.y}px`; n.root.style.width = `${b.w}px`; n.root.style.height = `${h}px`;
      n.root.dataset.state = b.state === "ready" ? "ready" : "drawing";
      n.root.dataset.selected = String(sel?.kind === "board" && sel.id === b.id);
      n.root.dataset.inside = String(inside === b.id);
      n.root.dataset.playing = String(play?.board === b.id);
      n.root.setAttribute("role", "group");
      n.root.setAttribute("aria-label", `Artboard ${b.title}, ${b.w} by ${h}${b.state === "ready" ? "" : ", not drawn yet"}`);
      n.title.textContent = b.title;
      n.dims.textContent = `${b.w} × ${h}${b.fit === "page" ? " · whole page" : ""}${b.interactive ? " · interactive" : ""}`;
      return n;
    }
    /** Each artboard's name as it fits over its frame at this zoom: whole, else its first whole words, else none (the
     *  one selected or under the pointer shows whole, over its neighbours). Its size is said only where both fit. */
    let ruler = null;
    function wide(text, weight = 500) {
      ruler = ruler || document.createElement("canvas").getContext("2d");
      ruler.font = `${weight} 12px ${getComputedStyle(stage).fontFamily || "sans-serif"}`;
      return ruler.measureText(text).width;
    }
    function labels() {
      const list = onPage();
      for (const b of list) {
        const n = nodes.get(b.id);
        if (!n) continue;
        // (Room: its own frame and the gap to whatever is next on its right in the same row.)
        const next = list.filter((o) => o.id !== b.id && o.x > b.x && o.y < b.y + 40 && o.y + heightOf(o) > b.y - 40).sort((a, c) => a.x - c.x)[0];
        const room = ((next ? next.x - b.x : b.w + 400) - 16 / view.k) * view.k;
        let shown = b.title;
        if (wide(shown) > room) {
          const words = b.title.split(/\s+/);
          shown = "";
          for (let i = words.length - 1; i > 0; i--) { const cut = words.slice(0, i).join(" ") + "…"; if (wide(cut) <= room) { shown = cut; break; } }
        }
        n.short.textContent = shown;
        n.name.dataset.fits = String(shown === b.title);
        const dims = n.dims.textContent;
        n.name.dataset.size = String(wide(b.title) + 8 + wide(dims, 400) <= Math.max(room, b.w * view.k));
      }
    }
    function paintBoards() {
      const here = new Set(onPage().map((b) => b.id));
      for (const [id, n] of nodes) if (!here.has(id)) { n.root.remove(); nodes.delete(id); }
      // In back-to-front order. A node already in its place is left there: moving a frame in the page loads it again.
      let prev = null;
      for (const b of onPage()) {
        const root = boardNode(b).root;
        let before = root.previousElementSibling;
        while (before && !before.classList.contains("dz-board")) before = before.previousElementSibling;
        if (root.parentNode !== world || before !== prev) world.insertBefore(root, prev ? prev.nextSibling : world.firstChild);
        prev = root;
      }
      paintNotes();
      if (world.lastElementChild !== guidesBox) world.append(guidesBox);
      labels();
      scheduleFrames();
    }
    function paintNotes() {
      const here = index.notes.filter((n) => n.page === pageId);
      for (const [id, node] of noteNodes) if (!here.some((n) => n.id === id)) { node.remove(); noteNodes.delete(id); }
      for (const note of here) {
        let node = noteNodes.get(note.id);
        if (!node) {
          node = U.el("div", "dz-note"); node.dataset.note = note.id; node.tabIndex = -1;
          node.append(U.el("div", "dz-note-text"));
          noteNodes.set(note.id, node);
          node.addEventListener("dblclick", (e) => { e.stopPropagation(); editNote(note.id); });
        }
        node.dataset.kind = note.kind; node.dataset.color = note.color || "";
        node.dataset.selected = String(sel?.kind === "note" && sel.id === note.id);
        node.style.left = `${note.x}px`; node.style.top = `${note.y}px`;
        if (!node.dataset.editing) node.firstChild.textContent = note.text;
        node.setAttribute("aria-label", `${note.kind === "title" ? "Title" : "Note"}: ${note.text.slice(0, 80)}`);
        if (node.parentNode !== world) world.insertBefore(node, guidesBox.parentNode === world ? guidesBox : null);
      }
    }
    function editNote(id) {
      const note = noteOf(id), node = noteNodes.get(id);
      if (!note || !node || locked) return;
      const text = node.firstChild;
      node.dataset.editing = "1";
      text.contentEditable = "plaintext-only"; if (text.contentEditable !== "plaintext-only") text.contentEditable = "true";
      text.focus();
      const range = document.createRange(); range.selectNodeContents(text);
      const s = getSelection(); s.removeAllRanges(); s.addRange(range);
      const done = (save) => {
        if (!node.dataset.editing) return;
        delete node.dataset.editing; text.removeAttribute("contenteditable");
        const next = text.textContent.trim().slice(0, note.kind === "title" ? 200 : 2000);
        if (save && next && next !== note.text) { note.text = next; send([{ op: "note_change", note: id, text: next }], "Note changed."); }
        else text.textContent = note.text;
      };
      text.addEventListener("blur", () => done(true), { once: true });
      text.addEventListener("keydown", function key(e) {
        e.stopPropagation();
        if (e.key === "Escape") { e.preventDefault(); text.removeEventListener("keydown", key); done(false); text.blur(); }
        else if (e.key === "Enter" && (note.kind === "title" || e.ctrlKey || e.metaKey)) { e.preventDefault(); text.removeEventListener("keydown", key); text.blur(); }
      });
    }

    // ---- frames: live where they can be read, a picture elsewhere
    let framesDue = 0;
    function scheduleFrames() { if (!framesDue) framesDue = requestAnimationFrame(() => { framesDue = 0; frames(); }); }
    function modeOf(b) { return play?.board === b.id ? "play" : inside === b.id ? "edit" : "view"; }
    function frames() {
      const s = size(), cx = s.w / 2, cy = s.h / 2;
      const seen = onPage().filter((b) => b.state === "ready" && pages[b.id] !== undefined).map((b) => {
        const left = b.x * view.k + view.x, top = b.y * view.k + view.y, w = b.w * view.k, h = heightOf(b) * view.k;
        const visible = left < s.w + 200 && left + w > -200 && top < s.h + 200 && top + h > -200;
        const must = play?.board === b.id || inside === b.id;
        return { b, visible, must, wide: w, far: Math.hypot(left + w / 2 - cx, top + h / 2 - cy) };
      });
      const live = new Set(seen.filter((x) => x.must).map((x) => x.b.id));
      for (const x of seen.filter((x) => !x.must && x.visible && x.wide >= LIVE_MIN_PX).sort((a, b) => a.far - b.far)) {
        if (live.size >= LIVE_MAX) break;
        live.add(x.b.id);
      }
      for (const b of onPage()) {
        const n = nodes.get(b.id);
        if (!n) continue;
        if (b.state !== "ready" || pages[b.id] === undefined) { showWaiting(n, b); continue; }
        const item = seen.find((x) => x.b.id === b.id);
        if (live.has(b.id)) showLive(n, b);
        else if (item?.visible || n.key.startsWith("live|")) showPicture(n, b);
      }
    }
    function showWaiting(n, b) {
      const words = waitingWords(b), key = `wait|${words}|${b.title}`;
      if (n.key === key) return;
      n.key = key; n.frame = null; n.token = "";
      const box = U.el("div", "dz-wait");
      box.append(U.el("span", "dz-wait-title", b.title), U.el("span", "dz-wait-words", words));
      n.face.replaceChildren(box);
    }
    function showLive(n, b) {
      const mode = modeOf(b), key = `live|${b.rev}|${tweakKey(b)}|${mode}|${b.interactive}`;
      if (n.key === key) return;
      n.key = key; n.token = newToken(); n.loads = 0;
      const frame = U.el("iframe", "dz-frame");
      frame.setAttribute("sandbox", "allow-scripts");               // (never allow-same-origin: the page has no origin)
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.setAttribute("tabindex", mode === "view" ? "-1" : "0");
      frame.title = `${b.title}${mode === "play" ? " (playing)" : ""}`;
      frame.dataset.mode = mode;
      frame.srcdoc = frameDoc(b, pages[b.id], mode, frameNonce(), n.token);
      // A played page that leaves for another address is put back: an artboard stays on the canvas.
      frame.addEventListener("load", () => { n.loads += 1; if (n.loads > 1 && n.frame === frame) { n.key = ""; scheduleFrames(); } });
      n.frame = frame;
      n.face.replaceChildren(frame);
    }
    function showPicture(n, b) {
      const key = `pic|${b.rev}|${tweakKey(b)}|${b.w}|${b.h}`;
      if (n.key === key) return;
      n.key = key; n.frame = null; n.token = "";
      const cacheKey = `${b.id}|${key}`;
      if (!pictures.has(cacheKey)) {
        if (pictures.size > 80) pictures.delete(pictures.keys().next().value);
        pictures.set(cacheKey, pictureOf({ ...b, h: heightOf(b) }, pages[b.id]));
      }
      const src = pictures.get(cacheKey);
      if (!src) { const box = U.el("div", "dz-wait dz-still"); box.append(U.el("span", "dz-wait-title", b.title)); n.face.replaceChildren(box); return; }
      const img = U.el("img", "dz-pic"); img.alt = ""; img.draggable = false; img.decoding = "async"; img.src = src;
      n.face.replaceChildren(img);
    }
    function tell(id, message) {
      const n = nodes.get(id);
      try { n?.frame?.contentWindow?.postMessage({ type: "dgc-design", token: n.token, ...message }, "*"); } catch { /* not loaded yet */ }
    }
    /** What an artboard's frame said (its helper): checked against the frame it came from, never trusted for more. */
    function fromFrame(event) {
      const m = event.data;
      if (!m || typeof m !== "object" || m.type !== "dgc-design") return;
      const hit = [...nodes].find(([, n]) => n.frame && n.frame.contentWindow === event.source);
      if (!hit || hit[1].token !== m.token) return;
      const id = hit[0], b = boardOf(id), n = hit[1];
      if (!b) return;
      if ((m.ev === "size" || m.ev === "ready" || m.ev === "changed") && Number.isFinite(m.height) && b.fit === "page") {
        const tall = clamp(Math.round(m.height), MIN_SIDE, MAX_H);
        if (measured.get(id) !== tall) {
          measured.set(id, tall);
          boardNode(b); placeFloats();
          if (!locked) U.post({ type: "designMeasured", board: id, h: tall });
        }
      }
      if (m.ev === "escape") { if (play) stopPlay(); else leaveInside(true); return; }
      if (m.ev === "goto" && play?.board === id && typeof m.target === "string") { goTo(m.target); return; }
      if (inside !== id || play) return;
      if (m.ev === "wheel") {
        const r = n.frame.getBoundingClientRect(), sr = stage.getBoundingClientRect();
        wheel({ deltaX: Number(m.dx) || 0, deltaY: Number(m.dy) || 0, ctrlKey: !!m.ctrl, clientX: r.left + (Number(m.x) || 0) * view.k, clientY: r.top + (Number(m.y) || 0) * view.k,
                preventDefault() {}, shiftKey: false }, sr);
      } else if ((m.ev === "pick" || m.ev === "editing") && m.pick && typeof m.pick === "object") {
        picked = cleanPick(m.pick); paintProps(); placeFloats(); U.offerComment(null);
      } else if (m.ev === "changed" && typeof m.html === "string" && m.html.length <= 500_000) {
        if (m.pick && typeof m.pick === "object") picked = cleanPick(m.pick);
        const note = m.note === "Edited text" ? "Edited text" : "Restyled";
        const rev = b.rev;
        pages[id] = m.html; b.rev = rev + 1;
        n.key = `live|${b.rev}|${tweakKey(b)}|edit|${b.interactive}`;        // (this frame already shows it)
        send([{ op: "change", board: id, html: m.html, rev, note }]);
        paintProps();
      } else if (m.ev === "words") {
        const a = m.anchor, r = m.rect;
        if (!a || !r || typeof a.quote !== "string" || !a.quote.trim()) { U.offerComment(null); return; }
        const fr = n.frame.getBoundingClientRect();
        U.offerComment({ kind: "artboard", board: id, title: b.title, quote: a.quote.slice(0, 2000), path: String(a.path || "").slice(0, 600),
                         near: String(a.near || "").slice(0, 200), tag: String(a.tag || "").slice(0, 20) },
                       { left: fr.left + r.left * view.k, right: fr.left + r.right * view.k, top: fr.top + r.top * view.k, bottom: fr.top + r.bottom * view.k });
      }
    }
    function cleanPick(p) {
      const text = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
      const s = p.styles && typeof p.styles === "object" ? p.styles : {};
      const r = p.rect && typeof p.rect === "object" ? p.rect : {};
      return { path: text(p.path, 600), tag: text(p.tag, 20).replace(/[^a-z0-9-]/g, ""), text: text(p.text, 300), near: text(p.near, 200), editable: p.editable === true,
               rect: { left: Number(r.left) || 0, top: Number(r.top) || 0, right: Number(r.right) || 0, bottom: Number(r.bottom) || 0 },
               styles: { color: text(s.color, 40), background: text(s.background, 40), fontSize: text(s.fontSize, 12), fontWeight: text(s.fontWeight, 8),
                         padding: text(s.padding, 12), gap: text(s.gap, 12), radius: text(s.radius, 12), flex: s.flex === true } };
    }

    // ---- selecting, opening, playing
    function select(next) {
      if (sel?.kind === next?.kind && sel?.id === next?.id) return;
      if (inside && !(next?.kind === "board" && next.id === inside)) leaveInside();
      sel = next;
      for (const b of onPage()) boardNode(b);
      paintNotes(); paintActs(); paintProps(); placeFloats();
    }
    function enterInside(id) {
      const b = boardOf(id);
      if (!b || b.state !== "ready" || locked || play) return;
      sel = { kind: "board", id }; inside = id; picked = null;
      for (const x of onPage()) boardNode(x);
      const s = size(), wide = b.w * view.k;
      if (wide < 320 || wide > s.w * 1.5) focusBoard(id);
      frames(); paintActs(); paintProps(); placeFloats();
      U.announce(`${b.title} is open: click a part to pick it, double-click words to change them. Escape closes it.`);
    }
    function leaveInside(focus) {
      if (!inside) return;
      tell(inside, { cmd: "finish" });
      const was = inside;
      inside = ""; picked = null; U.offerComment(null);
      // (A moment for the frame to say a change it was holding, before it is drawn again.)
      setTimeout(() => { for (const x of onPage()) boardNode(x); frames(); paintActs(); paintProps(); placeFloats(); }, 30);
      if (focus) { stage.focus(); U.announce(`${boardOf(was)?.title || "The artboard"} is closed.`); }
    }
    function startPlay(id) {
      const b = boardOf(id) || onPage().find((x) => x.id === index.start?.board && x.state === "ready") || onPage().find((x) => x.state === "ready");
      if (!b || b.state !== "ready") { U.announce("There is no drawn artboard to play yet."); return; }
      leaveInside();
      play = { board: b.id, trail: [], first: b.id, back: { ...view }, page: pageId };
      sel = { kind: "board", id: b.id };
      afterPlayMove();
      U.announce(`Playing ${b.title}. Escape stops.`);
    }
    function goTo(target) {
      const name = target.trim().toLowerCase();
      const to = index.boards.find((b) => b.id === target.trim()) || index.boards.find((b) => b.title.toLowerCase() === name);
      if (!to) { U.announce(`That link names no artboard: ${target.slice(0, 60)}.`); return; }
      if (to.state !== "ready") { U.announce(`${to.title} isn't drawn yet.`); return; }
      play.trail.push(play.board); play.board = to.id; sel = { kind: "board", id: to.id };
      afterPlayMove();
      U.announce(`${to.title}.`);
    }
    function afterPlayMove() {
      const b = boardOf(play.board);
      if (b.page !== pageId) { pageId = b.page; paint(); }
      stage.dataset.play = "1";
      for (const x of onPage()) boardNode(x);
      focusBoard(b.id);
      frames(); paintActs(); paintProps(); paintPlayBar(); placeFloats();
      setTimeout(() => nodes.get(b.id)?.frame?.focus(), 60);
    }
    function stopPlay() {
      if (!play) return;
      const was = play; play = null;
      delete stage.dataset.play;
      if (was.page !== pageId && index.pages.some((p) => p.id === was.page)) { pageId = was.page; paint(); }
      for (const x of onPage()) boardNode(x);
      setView(was.back, false, was.back.fitted === true); frames(); paintActs(); paintProps(); paintPlayBar(); placeFloats();
      stage.focus();
      U.announce("Stopped playing.");
    }
    function paintPlayBar() {
      playBar.hidden = !play;
      if (!play) return;
      const b = boardOf(play.board);
      const back = iconButton("arrow-left", "Back to the artboard before", () => { if (play.trail.length) { play.board = play.trail.pop(); afterPlayMove(); } }, "arrow-left");
      back.disabled = !play.trail.length;
      const again = iconButton("debug-restart", "Start again from the first artboard", () => { play.board = play.first; play.trail = []; nodes.get(play.first) && (nodes.get(play.first).key = ""); afterPlayMove(); }, "debug-restart");
      const stop = U.el("button", "art-btn dz-stop"); stop.type = "button";
      stop.append(glyph("stop", "debug-stop"), U.el("span", "", "Stop"));
      stop.title = "Stop playing (Escape)";
      stop.addEventListener("click", stopPlay);
      playBar.replaceChildren(U.el("span", "dz-play-words", `Playing “${b?.title || ""}”${b?.interactive ? "" : " · its links work"}`), back, again, stop);
    }
    function iconButton(action, label, run, codicon) {
      const b = U.el("button", "art-icon dz-act"); b.type = "button";
      b.title = label; b.setAttribute("aria-label", label);
      b.append(glyph(action, codicon));
      b.addEventListener("click", (e) => { e.stopPropagation(); run(b, e); });
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      return b;
    }

    // ---- the selected artboard's actions, floating over it
    function anchorOf(withPick = true) {
      if (sel?.kind !== "board") return null;
      const b = boardOf(sel.id);
      if (!b) return null;
      const a = { kind: "artboard", board: b.id, title: b.title };
      if (withPick && inside === b.id && picked && picked.path && picked.path !== "body") {
        a.path = picked.path; a.tag = picked.tag;
        if (picked.near && picked.near !== picked.text) a.near = picked.near;
        if (picked.text) a.quote = picked.text.slice(0, 280);
      }
      return a;
    }
    function boardDownloads(b, from) {
      const ask = (format) => { window.DgcDownload?.ask(from); U.post({ type: "export", format, board: b.id }); };
      return [[`“${b.title}” as a picture (.png)`, () => ask("png")], [`“${b.title}” as PDF`, () => ask("pdf")], [`“${b.title}” as a web page (.html)`, () => ask("html")]];
    }
    function paintActs() {
      acts.replaceChildren();
      acts.hidden = !sel || !!play || locked || !!drag;
      if (acts.hidden) return;
      if (sel.kind === "note") {
        const note = noteOf(sel.id);
        if (!note) { acts.hidden = true; return; }
        if (note.kind === "sticky") {
          for (const color of NOTE_COLORS) {
            const dot = U.el("button", "dz-swatch"); dot.type = "button"; dot.dataset.color = color;
            dot.title = `Make it ${color}`; dot.setAttribute("aria-label", `Make the note ${color}`);
            dot.setAttribute("aria-pressed", String(note.color === color));
            dot.addEventListener("pointerdown", (e) => e.stopPropagation());
            dot.addEventListener("click", () => { note.color = color; paintNotes(); paintActs(); send([{ op: "note_change", note: note.id, color }]); });
            acts.append(dot);
          }
        }
        acts.append(iconButton("edit", "Change its words", () => editNote(note.id), "edit"),
                    iconButton("delete", "Delete the note", () => { const id = note.id; index.notes = index.notes.filter((n) => n.id !== id); sel = null; paint(); send([{ op: "note_remove", note: id }], "Note deleted. Versions can bring it back."); }));
        return;
      }
      const b = boardOf(sel.id);
      if (!b) { acts.hidden = true; return; }
      const drawn = b.state === "ready";
      const playBtn = iconButton("play", `Play “${b.title}”`, () => startPlay(b.id), "play");
      const open = iconButton("edit", inside === b.id ? "Close it (Escape)" : "Open it to pick and change its parts (Enter)", () => (inside === b.id ? leaveInside(true) : enterInside(b.id)), "edit");
      open.setAttribute("aria-pressed", String(inside === b.id));
      const ask = iconButton("comment-discussion", "Ask in chat about this", () => { const a = anchorOf(); U.post({ type: "askChat", ...a }); U.announce("Added to the chat's prompt box."); }, "comment-discussion");
      ask.dataset.act = "ask";
      const comment = iconButton("comment", "Comment on this", (btn) => U.askComment(anchorOf(), btn.getBoundingClientRect()));
      comment.dataset.act = "comment"; comment.hidden = !U.commentsOn();
      const copy = iconButton("copy", "Duplicate", () => send([{ op: "duplicate", board: b.id }], `${b.title} duplicated.`));
      const wrap = U.el("span", "art-menu-wrap");
      const menu = U.el("div", "art-menu dgc-popover dz-menu"); menu.setAttribute("role", "menu"); menu.hidden = true;
      const down = iconButton("download", "Download this artboard", (btn) => U.showMenu(btn, menu, boardDownloads(b, btn)));
      down.setAttribute("aria-haspopup", "menu"); down.setAttribute("aria-expanded", "false"); down.dataset.act = "download";
      wrap.append(down, menu);
      const del = iconButton("delete", "Delete", () => removeBoard(b.id));
      for (const btn of [playBtn, open, down]) btn.disabled = !drawn;
      playBtn.dataset.act = "play"; open.dataset.act = "open"; copy.dataset.act = "duplicate"; del.dataset.act = "delete";
      acts.append(playBtn, open, ask, comment, copy, wrap, del);
    }
    function removeBoard(id) {
      const b = boardOf(id);
      if (!b) return;
      leaveInside();
      index.boards = index.boards.filter((x) => x.id !== id); sel = null;
      paint();
      send([{ op: "remove", board: id }], `${b.title} deleted. Versions can bring it back.`);
    }
    function placeFloats() {
      if (!stage) return;
      const s = size();
      if (!acts.hidden && sel) {
        const r = sel.kind === "board" ? (() => { const b = boardOf(sel.id); return b ? rectOf(b) : null; })() : (() => { const n = noteNodes.get(sel.id), note = noteOf(sel.id); return n && note ? { x: note.x, y: note.y, w: n.offsetWidth, h: n.offsetHeight } : null; })();
        if (r) {
          const w = acts.offsetWidth, h = acts.offsetHeight;
          const left = clamp(r.x * view.k + view.x, 8, Math.max(8, s.w - w - 8));
          let top = r.y * view.k + view.y - h - (sel.kind === "board" ? 30 : 8);
          if (top < 8) top = Math.min(s.h - h - 8, Math.max(8, (r.y + r.h) * view.k + view.y + 8));
          acts.style.left = `${Math.round(left)}px`; acts.style.top = `${Math.round(top)}px`;
        }
      }
    }

    // ---- the panel beside: the artboard, its tweaks, the part picked in it
    function field(label, control) { const row = U.el("label", "dz-field"); row.append(U.el("span", "dz-field-label", label), control); return row; }
    function numberBox(value, min, max, keep, unit = "px") {
      const wrap = U.el("span", "dz-num");
      const input = U.el("input"); input.type = "number"; input.min = String(min); input.max = String(max); input.value = String(value);
      input.addEventListener("keydown", (e) => e.stopPropagation());
      input.addEventListener("change", () => { const n = clamp(Math.round(Number(input.value) || 0), min, max); input.value = String(n); keep(n); });
      wrap.append(input, U.el("span", "dz-unit", unit));
      return wrap;
    }
    function colorBox(value, keep, label) {
      const input = U.el("input", "dz-color"); input.type = "color"; input.value = value || "#000000";
      input.setAttribute("aria-label", label);
      input.addEventListener("change", () => keep(input.value));
      return input;
    }
    function paintProps() {
      const b = sel?.kind === "board" ? boardOf(sel.id) : null;
      props.hidden = !b || !!play;
      stage.dataset.props = props.hidden ? "" : "1";
      if (props.hidden) { props.replaceChildren(); sheetOpen = false; return; }
      const keepFocus = props.contains(document.activeElement) ? document.activeElement?.dataset?.key : "";
      const head = U.el("div", "dz-props-head");
      const sheet = narrow();
      props.dataset.sheet = sheet ? (sheetOpen ? "open" : "closed") : "";
      head.append(U.el("h2", "", sheet ? b.title : inside === b.id && picked ? "Part" : "Artboard"));
      if (sheet) {
        // One line until it is opened: the artboard's name and the control that opens its properties.
        const more = U.el("button", "art-icon dz-sheet-toggle"); more.type = "button";
        more.setAttribute("aria-expanded", String(sheetOpen)); more.setAttribute("aria-controls", "dz-props-body");
        more.title = sheetOpen ? "Hide its properties" : "Show its properties"; more.setAttribute("aria-label", more.title);
        more.append(U.icon(sheetOpen ? "chevron-down" : "chevron-up"));
        more.addEventListener("click", () => { sheetOpen = !sheetOpen; paintProps(); props.querySelector(".dz-sheet-toggle")?.focus(); });
        head.append(more);
      }
      const close = U.el("button", "art-icon"); close.type = "button"; close.title = "Close"; close.setAttribute("aria-label", "Close the panel");
      close.append(glyph("close")); close.addEventListener("click", () => select(null));
      head.append(close);
      const body = U.el("div", "dz-props-body"); body.id = "dz-props-body";
      body.hidden = sheet && !sheetOpen;
      if (sheet && inside === b.id && picked) body.append(U.el("h3", "dz-props-sub", "Part"));
      if (inside === b.id && picked) {
        const s = picked.styles, px = (v) => Math.round(parseFloat(v) || 0);
        const style = (prop, value) => tell(b.id, { cmd: "style", prop, value });
        body.append(U.el("p", "dz-part", `<${picked.tag}>${picked.text ? ` ${picked.text.slice(0, 70)}${picked.text.length > 70 ? "…" : ""}` : ""}`));
        if (picked.editable) body.append(U.el("p", "dz-hint", "Double-click its words to change them."));
        body.append(field("Text colour", colorBox(hexOf(s.color), (v) => style("color", v), "Text colour")),
                    field("Background", colorBox(hexOf(s.background) || "#ffffff", (v) => style("background-color", v), "Background colour")),
                    field("Font size", numberBox(px(s.fontSize), 6, 400, (n) => style("font-size", `${n}px`))));
        const weight = U.el("select", "dz-select");
        for (const [v, words] of [["300", "Light"], ["400", "Regular"], ["500", "Medium"], ["600", "Semibold"], ["700", "Bold"], ["800", "Heavy"]]) { const o = U.el("option", "", words); o.value = v; weight.append(o); }
        weight.value = ["300", "400", "500", "600", "700", "800"].includes(s.fontWeight) ? s.fontWeight : Number(s.fontWeight) > 600 ? "700" : "400";
        weight.addEventListener("change", () => style("font-weight", weight.value));
        body.append(field("Weight", weight), field("Padding", numberBox(px(s.padding), 0, 400, (n) => style("padding", `${n}px`))));
        if (s.flex) body.append(field("Gap", numberBox(px(s.gap), 0, 400, (n) => style("gap", `${n}px`))));
        body.append(field("Corner radius", numberBox(px(s.radius), 0, 400, (n) => style("border-radius", `${n}px`))));
      } else {
        const name = U.el("input", "dz-text"); name.type = "text"; name.value = b.title; name.maxLength = 80;
        name.addEventListener("keydown", (e) => e.stopPropagation());
        name.addEventListener("change", () => { const t = name.value.replace(/\s+/g, " ").trim(); if (t && t !== b.title) { b.title = t; boardNode(b); send([{ op: "rename", board: b.id, title: t }], `Renamed ${t}.`); } else name.value = b.title; });
        const resize = (w, h) => { b.w = w; b.h = h; boardNode(b); nodes.get(b.id).key = ""; scheduleFrames(); placeFloats(); send([{ op: "resize", board: b.id, w, h, x: b.x, y: b.y }]); };
        body.append(field("Name", name), field("Width", numberBox(b.w, MIN_SIDE, MAX_W, (n) => resize(n, b.h))),
                    field(b.fit === "page" ? "Height, at least" : "Height", numberBox(b.h, MIN_SIDE, MAX_H, (n) => resize(b.w, n))));
        if (b.state === "ready") body.append(U.el("p", "dz-hint", "Double-click the artboard to open it and change its parts."));
        if ((b.tweaks || []).length) {
          body.append(U.el("h3", "dz-props-sub", "Tweaks"));
          for (const t of b.tweaks) body.append(field(t.label || t.name, tweakControl(b, t)));
        }
      }
      props.replaceChildren(head, body);
      if (keepFocus) props.querySelector(`[data-key="${keepFocus}"]`)?.focus();
    }
    function tweakControl(b, t) {
      const set = (value) => { t.value = value; nodes.get(b.id) && scheduleFrames(); send([{ op: "tweak", board: b.id, name: t.name, value }], `${t.label || t.name} changed.`); };
      if (t.type === "color") return colorBox(String(t.value), set, t.label || t.name);
      if (t.type === "switch") {
        const box = U.el("input", "dz-check"); box.type = "checkbox"; box.checked = t.value === true;
        box.setAttribute("role", "switch"); box.addEventListener("change", () => set(box.checked));
        return box;
      }
      if (t.type === "choice") {
        const pick = U.el("select", "dz-select");
        for (const o of t.options || []) { const opt = U.el("option", "", o); opt.value = o; pick.append(opt); }
        pick.value = String(t.value); pick.addEventListener("change", () => set(pick.value));
        return pick;
      }
      const m = /^(-?[\d.]+)(px|rem|em|%|vw|vh)$/.exec(String(t.value)) || ["", "0", "px"];
      return numberBox(Number(m[1]), Number.isFinite(t.min) ? t.min : 0, Number.isFinite(t.max) ? t.max : 2000, (n) => set(`${n}${m[2]}`), m[2]);
    }

    // ---- the pointer: pan, select, move, resize
    function showGuides(list) {
      guidesBox.replaceChildren(...list.map((g) => {
        const line = U.el("i", "dz-guide"); line.dataset.axis = g.axis; line.dataset.kind = g.kind;
        if (g.axis === "x") { line.style.left = `${g.at}px`; line.style.top = `${g.from}px`; line.style.height = `${g.to - g.from}px`; }
        else { line.style.top = `${g.at}px`; line.style.left = `${g.from}px`; line.style.width = `${g.to - g.from}px`; }
        if (g.gap) line.append(U.el("b", "dz-guide-gap", String(g.gap)));
        return line;
      }));
    }
    function pointerDown(e) {
      if (e.target.closest(".dz-acts, .dz-props, .dz-playbar, .dz-rename, [contenteditable]")) return;
      stage.focus({ preventScroll: true });
      const sr = stage.getBoundingClientRect(), px = e.clientX - sr.left, py = e.clientY - sr.top;
      const start = { px, py, view: { ...view } };
      const boardEl = e.target.closest(".dz-board"), noteEl = e.target.closest(".dz-note");
      if (space || e.button === 1 || (!boardEl && !noteEl) || play) {
        if (e.button === 2) return;
        drag = { kind: "pan", start, moved: false, bare: !boardEl && !noteEl };
      } else if (e.button !== 0) return;
      else if (noteEl) {
        const note = noteOf(noteEl.dataset.note);
        select({ kind: "note", id: note.id });
        if (locked) return;
        drag = { kind: "note", start, id: note.id, at: { x: note.x, y: note.y }, moved: false };
      } else {
        const b = boardOf(boardEl.dataset.board), handle = e.target.closest(".dz-handle")?.dataset.handle;
        if (!b) return;
        select({ kind: "board", id: b.id });
        if (locked || inside === b.id && !handle && !e.target.closest(".dz-name")) return;
        drag = { kind: handle ? "resize" : "move", handle, start, id: b.id, at: { x: b.x, y: b.y, w: b.w, h: b.h }, moved: false };
      }
      // (The pointer is held only once it moves: held from the press, its click and double-click would go to the
      // canvas instead of the name or the artboard under it.)
      drag.pointer = e.pointerId;
      e.preventDefault();
    }
    function pointerMove(e) {
      if (!drag) return;
      const sr = stage.getBoundingClientRect(), dx = e.clientX - sr.left - drag.start.px, dy = e.clientY - sr.top - drag.start.py;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) {
        drag.moved = true; stage.dataset.dragging = drag.kind; paintActs();
        try { stage.setPointerCapture(drag.pointer); } catch { /* a synthetic pointer */ }
      }
      if (drag.kind === "pan") { setView({ x: drag.start.view.x + dx, y: drag.start.view.y + dy, k: view.k }, true); return; }
      const wx = dx / view.k, wy = dy / view.k, tol = e.altKey ? 0 : SNAP_PX / view.k;
      if (drag.kind === "note") {
        const note = noteOf(drag.id);
        note.x = Math.round(drag.at.x + wx); note.y = Math.round(drag.at.y + wy);
        paintNotes(); return;
      }
      const b = boardOf(drag.id), others = onPage().filter((o) => o.id !== b.id).map(rectOf);
      if (drag.kind === "move") {
        const s = snapMove({ x: drag.at.x + wx, y: drag.at.y + wy, w: b.w, h: heightOf(b) }, others, tol);
        b.x = Math.round(s.x); b.y = Math.round(s.y); showGuides(s.guides);
      } else {
        let { x, y, w, h } = drag.at;
        const hd = drag.handle;
        if (hd.includes("e")) w = Math.max(MIN_SIDE, w + wx);
        if (hd.includes("s")) h = Math.max(MIN_SIDE, h + wy);
        if (hd.includes("w")) { const nw = Math.max(MIN_SIDE, w - wx); x += w - nw; w = nw; }
        if (hd.includes("n")) { const nh = Math.max(MIN_SIDE, h - wy); y += h - nh; h = nh; }
        const s = snapResize({ x, y, w, h }, hd, others, tol);
        b.x = Math.round(s.x); b.y = Math.round(s.y); b.w = Math.round(s.w); b.h = Math.round(s.h); showGuides(s.guides);
      }
      boardNode(b);
    }
    function pointerUp(e) {
      if (!drag) return;
      const d = drag; drag = null;
      delete stage.dataset.dragging;
      try { stage.releasePointerCapture(e.pointerId); } catch { /* not held */ }
      showGuides([]);
      if (d.kind === "pan") { if (!d.moved && d.bare && !play) select(null); scheduleFrames(); }
      else if (d.kind === "note" && d.moved) { const n = noteOf(d.id); send([{ op: "note_change", note: n.id, x: n.x, y: n.y }]); }
      else if (d.moved) {
        const b = boardOf(d.id);
        if (d.kind === "move") send([{ op: "move", board: b.id, x: b.x, y: b.y }], `${b.title} moved.`);
        else { nodes.get(b.id).key = ""; send([{ op: "resize", board: b.id, w: b.w, h: b.h, x: b.x, y: b.y }], `${b.title} is ${b.w} by ${b.h}.`); }
      }
      paintActs(); paintProps(); placeFloats(); scheduleFrames();
      if (stale) { stale = false; apply(); }
    }
    function wheel(e, rect) {
      const sr = rect || stage.getBoundingClientRect();
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) setView(zoomAt(view, e.clientX - sr.left, e.clientY - sr.top, view.k * Math.exp(-e.deltaY * 0.0022)));
      else setView({ x: view.x - (e.shiftKey ? e.deltaY : e.deltaX), y: view.y - (e.shiftKey ? 0 : e.deltaY), k: view.k });
    }
    function keyDown(e) {
      if (e.target.closest?.("input, select, textarea, [contenteditable]")) return;
      if (e.key === " " && !space) { space = true; stage.dataset.space = "1"; e.preventDefault(); return; }
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      if (e.key === "Escape") { if (play) stopPlay(); else if (inside) leaveInside(true); else select(null); return; }
      if (play) return;
      if (plain && (e.key === "+" || e.key === "=")) { e.preventDefault(); zoomBy(1.25); }
      else if (plain && (e.key === "-" || e.key === "_")) { e.preventDefault(); zoomBy(0.8); }
      else if (plain && (e.key === "1" && e.shiftKey || e.key === "!" || e.key.toLowerCase() === "f")) { e.preventDefault(); fitAll(); }
      else if (plain && (e.key === "0" || e.key === ")")) { e.preventDefault(); const s = size(); setView(zoomAt(view, s.w / 2, s.h / 2, 1)); }
      else if (sel?.kind === "board" && !inside && !locked) {
        const b = boardOf(sel.id);
        if (e.key === "Enter") { e.preventDefault(); enterInside(b.id); }
        else if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeBoard(b.id); }
        else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") { e.preventDefault(); send([{ op: "duplicate", board: b.id }], `${b.title} duplicated.`); }
        else if (e.key.startsWith("Arrow") && plain) {
          e.preventDefault();
          const step = e.shiftKey ? 10 : 1;
          b.x += e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0;
          b.y += e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0;
          boardNode(b); placeFloats();
          clearTimeout(keyDown.nudge);
          keyDown.nudge = setTimeout(() => send([{ op: "move", board: b.id, x: b.x, y: b.y }]), 500);
        }
      } else if (sel?.kind === "note" && !locked && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        const id = sel.id; index.notes = index.notes.filter((n) => n.id !== id); sel = null; paint();
        send([{ op: "note_remove", note: id }], "Note deleted. Versions can bring it back.");
      } else if (plain && e.key === "Tab" && !e.shiftKey && onPage().length && document.activeElement === stage && !sel) {
        e.preventDefault(); select({ kind: "board", id: onPage()[0].id });
      }
    }

    // ---- the toolbar
    function toolbar() {
      bar = U.el("div", "art-toolbar dz-bar");
      tabs = U.el("div", "dz-tabs"); tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Pages");
      const tools = U.el("div", "dz-tools"); tools.setAttribute("role", "toolbar"); tools.setAttribute("aria-label", "Canvas");
      const menuButton = (action, label, items, codicon) => {
        const wrap = U.el("span", "art-menu-wrap");
        const menu = U.el("div", "art-menu dgc-popover dz-menu"); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", label); menu.hidden = true;
        const b = U.el("button", "art-icon dz-tool"); b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
        b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false");
        b.append(glyph(action, codicon));
        b.addEventListener("click", (e) => { e.stopPropagation(); U.showMenu(b, menu, items()); });
        wrap.append(b, menu);
        return [wrap, b];
      };
      const [addWrap, addBtn] = menuButton("add", "Add an artboard", () => SIZES.map(([size, name, w, h]) =>
        [`${name} · ${w} × ${h}${size === "page" ? " or taller" : ""}`, () => send([{ op: "add", title: name, size, page: pageId }], `${name} artboard added.`)]));
      addBtn.dataset.tool = "add";
      const [noteWrap, noteBtn] = menuButton("note", "Add a note", () => {
        const at = toWorld(size().w / 2, size().h / 2);
        return [["Sticky note", () => send([{ op: "note_add", kind: "sticky", text: "Note", page: pageId, x: Math.round(at.x - 110), y: Math.round(at.y - 40) }], "Note added: double-click it to write.")],
                ["Title", () => send([{ op: "note_add", kind: "title", text: "Title", page: pageId, x: Math.round(at.x - 100), y: Math.round(at.y - 30) }], "Title added: double-click it to write.")]];
      }, "note");
      noteBtn.dataset.tool = "note";
      const playBtn = U.el("button", "art-icon dz-tool"); playBtn.type = "button"; playBtn.dataset.tool = "play";
      playBtn.title = "Play: use the artboards as a person would, following their links"; playBtn.setAttribute("aria-label", "Play");
      playBtn.append(glyph("play", "play"));
      playBtn.addEventListener("click", () => (play ? stopPlay() : startPlay(sel?.kind === "board" ? sel.id : "")));
      const out = U.el("button", "art-icon dz-tool"); out.type = "button"; out.title = "Zoom out (−)"; out.setAttribute("aria-label", "Zoom out"); out.append(U.icon("remove"));
      out.addEventListener("click", () => zoomBy(0.8));
      const inn = U.el("button", "art-icon dz-tool"); inn.type = "button"; inn.title = "Zoom in (+)"; inn.setAttribute("aria-label", "Zoom in"); inn.append(glyph("add"));
      inn.addEventListener("click", () => zoomBy(1.25));
      const zoomWrap = U.el("span", "art-menu-wrap");
      zoomBtn = U.el("button", "art-btn art-btn-quiet dz-zoom"); zoomBtn.type = "button"; zoomBtn.append(U.el("span", "", "100%"));
      zoomBtn.title = "Zoom"; zoomBtn.setAttribute("aria-haspopup", "menu"); zoomBtn.setAttribute("aria-expanded", "false");
      zoomMenu = U.el("div", "art-menu dgc-popover dz-menu"); zoomMenu.setAttribute("role", "menu"); zoomMenu.setAttribute("aria-label", "Zoom"); zoomMenu.hidden = true;
      const to = (k) => () => { const s = size(); setView(zoomAt(view, s.w / 2, s.h / 2, k)); };
      zoomBtn.addEventListener("click", (e) => { e.stopPropagation(); U.showMenu(zoomBtn, zoomMenu, [["Fit all (F)", fitAll], ["100% (0)", to(1)], ["50%", to(0.5)], ["200%", to(2)],
        ...(sel?.kind === "board" ? [["Fit the selected artboard", () => focusBoard(sel.id)]] : [])]); });
      zoomWrap.append(zoomBtn, zoomMenu);
      const fit = U.el("button", "art-icon dz-tool"); fit.type = "button"; fit.dataset.tool = "fit"; fit.title = "Fit all (F)"; fit.setAttribute("aria-label", "Fit all"); fit.append(U.icon("screen-full"));
      fit.addEventListener("click", fitAll);
      tools.append(addWrap, noteWrap, playBtn, U.el("span", "dz-sep"), out, zoomWrap, inn, fit);
      bar.append(tabs, U.el("span", "art-spacer"), tools);
      return bar;
    }
    function paintTools() {
      for (const b of bar.querySelectorAll('[data-tool="add"], [data-tool="note"]')) b.disabled = locked || !!play;
      const p = bar.querySelector('[data-tool="play"]');
      p.setAttribute("aria-pressed", String(!!play));
      p.disabled = !index.boards.some((b) => b.state === "ready");
    }

    function paint() {
      paintTabs(); paintBoards(); paintActs(); paintProps(); paintTools(); paintPlayBar(); placeFloats();
      const none = !onPage().length && !index.notes.some((n) => n.page === pageId);
      hintBox.hidden = !none;
    }
    /** The design as the process has it now: shown, with what you have selected and where you are looking kept. */
    function apply() {
      const before = new Map(index.boards.map((b) => [b.id, b.state]));
      const had = index.boards.length;
      read();
      const drawn = index.boards.filter((b) => b.state === "ready" && before.get(b.id) === "drawing" && !heard.has(b.id));
      for (const b of index.boards) if (b.state === "ready") heard.add(b.id);
      paint();
      if (drawn.length) U.announce(`${drawn.map((b) => b.title).join(" and ")} ${drawn.length === 1 ? "is" : "are"} drawn.`);
      // (Watching it fill: while the view is still the fit DGC set, a frame that comes in keeps everything in view.)
      if (!play && !inside && following && index.boards.length !== had) fitAll();
    }

    const editor = {
      mount(main, context) {
        ctx = context; U = ctx.util;
        read();
        for (const b of index.boards) if (b.state === "ready") heard.add(b.id);
        const wrap = U.el("div", "dz");
        stage = U.el("div", "dz-stage"); stage.tabIndex = 0;
        stage.setAttribute("role", "application"); stage.setAttribute("aria-label", "Design canvas: drag to move about, Ctrl and scroll to zoom");
        world = U.el("div", "dz-world");
        guidesBox = U.el("div", "dz-guides"); guidesBox.setAttribute("aria-hidden", "true");
        world.append(guidesBox);
        acts = U.el("div", "dz-acts"); acts.setAttribute("role", "toolbar"); acts.setAttribute("aria-label", "Selected"); acts.hidden = true;
        playBar = U.el("div", "dz-playbar"); playBar.setAttribute("role", "toolbar"); playBar.setAttribute("aria-label", "Playing"); playBar.hidden = true;
        props = U.el("aside", "dz-props"); props.setAttribute("aria-label", "Properties"); props.hidden = true;
        hintBox = U.el("p", "dz-empty", "Nothing on this page yet. Add an artboard, or ask DGC to draw one."); hintBox.hidden = true;
        stage.append(world, acts, playBar, hintBox);
        wrap.append(toolbar(), stage, props);
        main.append(wrap);
        stage.addEventListener("pointerdown", pointerDown);
        stage.addEventListener("pointermove", pointerMove);
        stage.addEventListener("pointerup", pointerUp);
        stage.addEventListener("pointercancel", pointerUp);
        // (A press let go anywhere ends what it began: outside the canvas, or after the pointer's hold was lost.)
        stage.addEventListener("lostpointercapture", (e) => { if (drag) pointerUp(e); });
        window.addEventListener("pointerup", (e) => { if (drag) pointerUp(e); });
        stage.addEventListener("wheel", (e) => wheel(e), { passive: false });
        stage.addEventListener("dblclick", (e) => {
          const el = e.target.closest(".dz-board");
          if (el && !e.target.closest(".dz-name, .dz-handle") && !play) enterInside(el.dataset.board);
        });
        stage.addEventListener("keydown", keyDown);
        window.addEventListener("keyup", (e) => { if (e.key === " ") { space = false; delete stage.dataset.space; } });
        window.addEventListener("blur", () => { space = false; delete stage.dataset.space; });
        window.addEventListener("message", fromFrame);
        new ResizeObserver(() => { if (following && !play && !inside && !drag) fitAll(); placeFloats(); scheduleFrames(); }).observe(stage);
        window.matchMedia?.("(max-width: 560px)").addEventListener?.("change", () => paintProps());
        paint();
        // It opens on the artboard it says to, else on everything.
        const startAt = index.start?.board && boardOf(index.start.board);
        requestAnimationFrame(() => { if (startAt) focusBoard(startAt.id); else fitAll(); });
        window.DgcDesign.editor = editor;
      },
      update() { if (drag) { stale = true; return; } apply(); },
      saved() {},
      rejected() { U.post({ type: "reload" }); },
      dirty: () => false,
      lock(on) { locked = !!on; if (locked) { leaveInside(); stopPlay(); } paint(); },
      /** The header's Download: the whole canvas, and the selected artboard first. */
      exportItems(from) {
        const ask = (format) => () => { window.DgcDownload?.ask(from); U.post({ type: "export", format }); };
        const b = sel?.kind === "board" ? boardOf(sel.id) : null;
        return [...(b && b.state === "ready" ? boardDownloads(b, from) : []),
                ["Every artboard as pictures (.zip)", ask("zip")], ["PDF, an artboard a page", ask("pdf")], ["The canvas as a web page (.html)", ask("html")]];
      },
      commentAnchor: () => anchorOf() || { kind: "whole" },
      reveal(anchor) {
        if (!anchor || anchor.kind !== "artboard") return;
        const b = boardOf(String(anchor.board || ""));
        if (!b) return;
        if (b.page !== pageId) showPage(b.page);
        select({ kind: "board", id: b.id });
        focusBoard(b.id);
        if ((anchor.path || anchor.quote) && b.state === "ready" && !locked) {
          enterInside(b.id);
          setTimeout(() => tell(b.id, { cmd: "reveal", anchor: { path: anchor.path, quote: anchor.quote } }), 350);
        }
      },
      // (For the tests and the captures: where the canvas is, and the same moves a person makes.)
      debug: { view: () => ({ x: view.x, y: view.y, k: view.k }), setView: (v) => setView(v), fitAll, focusBoard, select, enterInside, leaveInside, startPlay, stopPlay, state: () => ({ sel, inside, picked, play: play ? { ...play } : null, pageId }),
               frames, node: (id) => nodes.get(id) },
    };
    return editor;
  };
})();
