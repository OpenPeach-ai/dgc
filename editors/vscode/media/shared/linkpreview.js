// A link's preview card: rest the pointer on a link in a chat (or reach it with the Tab key) and a card under it shows
// the site's icon and name, Open, the site's own picture, the page's title and two lines of what it says. The page's
// half of ONE module (src/linkPreview.ts is the host's), the same in Work, ChatDGC and a Pip's chat: for a link you
// sent and a link in a reply alike.
//
// This page never reads the web. It asks its host about the link's address and draws what the host answers: words as
// text, and a picture only when it is a data: URI the host read itself. So the page's own policy stays as it is, and a
// private host, a one-time link or a page that couldn't be read gets a card with its address and Open, nothing else.
// With the setting off (Settings › Security) the host says so and no card is drawn.
//
// A classic script like media/shared/download.js (the pages load it before their own script; the Pips bundle imports
// it), so all share window.DgcLinkPreview:
//   DgcLinkPreview.connect((message) => vscode.postMessage(message));
// The page posts { type: "dgcLinkPreview", id, url, have? } and the host answers with the same type and id:
//   state "page"     { site, title, description, image?, icon?, at }
//   state "address"  { site, why }           the address alone
//   state "reading"  { site }                the host is reading it; the page follows
//   state "same"                             what this page already holds (`have` is its `at`) still stands
//   state "off"                              previews are turned off
// One card at a time, drawn in the page's own body. A view inside a shadow root of the page (a Pip's chat in the side
// bar) adds its root with DgcLinkPreview.watch(root): what happens wholly inside a root is not told to the page.
// It never covers its link: under it, or over it when there is no room under, and always inside the page.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcLinkPreview) return;

  const MESSAGE = "dgcLinkPreview";
  /** How long a pointer rests on a link before its card is asked for; the keyboard's focus waits a little longer. */
  const REST_MS = 450, FOCUS_MS = 600;
  /** How long the card waits after the pointer leaves (the way from the link to the card crosses a gap). */
  const GRACE_MS = 220;
  /** A host that answers "reading" is given this long before the address shows without its page. */
  const READING_MS = 260;
  const GAP = 6, EDGE = 8, WIDE = 340, KEEP = 24, KEEP_MS = 30 * 60_000;
  const LINK = '.md-link[data-link-kind="external"][data-target]';
  /** A picture the host read itself: a data: URI of a plain picture type. Anything else is never drawn. */
  const PICTURE = /^data:image\/(?:png|jpeg|gif|webp|avif|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/;

  let post = null, doc = null, times = { rest: REST_MS, focus: FOCUS_MS, grace: GRACE_MS, reading: READING_MS };
  let node = null;              // the one card
  let shown = null;             // { link, url, title } while the card is up
  let pending = null;           // { link, url, id, lifted } once asked, until answered
  let waiting = null;           // { link, timer } while the pointer rests
  let leaveTimer = 0, readingTimer = 0, seq = 0, lastKey = "", dismissed = null, overCard = false, alive = 0;
  let keyed = false;            // the card (or the wait for it) was brought by the keyboard's focus, not a pointer
  const held = new Map();       // url -> { answer, at }: what the host last said of a page, so its picture isn't sent twice

  const webAddress = (value) => { try { const u = new URL(String(value || "")); return u.protocol === "http:" || u.protocol === "https:" ? u : null; } catch { return null; } };
  /** The link an event is on, through a shadow root too. */
  function linkOf(event) {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const n of path.length ? path : [event.target]) {
      if (n && n.nodeType === 1 && typeof n.matches === "function" && n.matches(LINK)) return webAddress(n.dataset.target) ? n : null;
    }
    const near = event.target && typeof event.target.closest === "function" ? event.target.closest(LINK) : null;
    return near && webAddress(near.dataset.target) ? near : null;
  }
  const inCard = (event) => !!node && ((typeof event.composedPath === "function" ? event.composedPath() : []).includes(node) || (event.target && event.target.nodeType === 1 && node.contains(event.target)));

  // ---- the link's own label steps aside for the card -------------------------------------------------------------------
  function lift(state) {
    const link = state.link;
    if (!link.isConnected) return;
    const said = link.getAttribute("title");
    if (said) { state.title = said; link.removeAttribute("title"); }
    // A hover label already up over the link goes (the pages' own labels listen for this).
    const View = doc.defaultView || root;
    try { link.dispatchEvent(new View.CustomEvent("dgc-said", { bubbles: true, composed: true })); } catch { /* a page with no labels */ }
  }
  function restore(state) {
    const link = state && state.link;
    if (!link) return;
    if (state.title && link.isConnected && !link.hasAttribute("title")) link.setAttribute("title", state.title);
    if (node && link.getAttribute("aria-describedby") === node.id) link.removeAttribute("aria-describedby");
  }

  // ---- the card -----------------------------------------------------------------------------------------------------------
  const el = (tag, cls, text) => { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
  const glyph = (name, size) => { const box = doc.createElement("span"); box.innerHTML = (root.DgcIcons && root.DgcIcons.html(name, { size })) || ""; return box.firstElementChild; };
  /** The address as a person reads it: no scheme, no trailing slash. */
  function plain(url) {
    const u = webAddress(url);
    if (!u) return String(url || "");
    return `${u.host}${u.pathname === "/" ? "" : u.pathname}${u.search}`.replace(/^www\./i, "");
  }
  function draw(state, answer) {
    if (!node) {
      node = el("div", "dgc-linkcard");
      node.id = "dgc-linkcard"; node.hidden = true;
      node.setAttribute("role", "group");
      doc.body.appendChild(node);
    }
    const kind = answer.state === "page" ? "page" : answer.state === "reading" ? "reading" : "address";
    const site = kind === "address" ? plain(state.url) : String(answer.site || plain(state.url));
    node.textContent = ""; node.dataset.state = kind;
    node.setAttribute("aria-label", `Preview of ${site}`);
    const top = el("div", "dgc-linkcard-top"), icon = el("span", "dgc-linkcard-icon");
    // The site's icon: the one the host read; else the one the link itself wears, once it has loaded; else DGC's globe.
    const worn = state.link.querySelector ? state.link.querySelector("img.link-favicon") : null;
    const src = kind === "page" && PICTURE.test(String(answer.icon || "")) ? answer.icon : worn && worn.complete && worn.naturalWidth > 0 ? worn.currentSrc || worn.src : "";
    const globe = () => { icon.textContent = ""; const g = glyph("globe", 16); if (g) icon.appendChild(g); };
    if (src) { const img = el("img"); img.alt = ""; img.decoding = "async"; img.referrerPolicy = "no-referrer"; img.addEventListener("error", globe); img.src = src; icon.appendChild(img); } else globe();
    const open = el("button", "dgc-btn small text dgc-linkcard-open");
    open.type = "button";
    open.append(el("span", "", "Open"));
    const arrow = glyph("link-external", 14); if (arrow) open.appendChild(arrow);
    // Open is a click on the link itself: the page's own way of opening it, with whatever that asks first.
    open.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); const link = state.link; hide(); if (link.isConnected) link.click(); });
    top.append(icon, el("span", "dgc-linkcard-site", site), open);
    node.appendChild(top);
    if (kind === "page") {
      if (PICTURE.test(String(answer.image || ""))) {
        const picture = el("img", "dgc-linkcard-picture");
        picture.alt = ""; picture.decoding = "async";
        picture.addEventListener("error", () => { picture.remove(); place(state.link); });
        picture.src = answer.image;
        node.appendChild(picture);
      }
      const title = String(answer.title || "").trim(), says = String(answer.description || "").trim();
      if (title || says) {
        const box = el("div", "dgc-linkcard-words");
        if (title) box.appendChild(el("div", "dgc-linkcard-title", title));
        if (says) box.appendChild(el("div", "dgc-linkcard-desc", says));
        node.appendChild(box);
      }
    } else if (kind === "reading") {
      const box = el("div", "dgc-linkcard-words"), line = el("div", "dgc-linkcard-reading", "Reading the page…");
      line.setAttribute("role", "status");
      box.appendChild(line); node.appendChild(box);
    }
    node.hidden = false;
    state.link.setAttribute("aria-describedby", node.id);
    place(state.link);
  }
  /** Under the link, or over it when there is no room under; inside the page; never over the link itself. */
  function place(link) {
    if (!node || node.hidden || !link.isConnected) return;
    const view = doc.defaultView || root, page = doc.documentElement;
    const wide = page.clientWidth || view.innerWidth || 0, tall = page.clientHeight || view.innerHeight || 0;
    const width = Math.max(120, Math.min(WIDE, wide - 2 * EDGE));
    node.style.width = `${width}px`; node.style.maxHeight = ""; node.style.left = "0px"; node.style.top = "0px";
    // (A link that wraps is several boxes: the card hangs from the whole of it, at the start of its first line.)
    const all = link.getBoundingClientRect(), first = (link.getClientRects && link.getClientRects()[0]) || all;
    const height = node.getBoundingClientRect().height;
    const under = tall - EDGE - (all.bottom + GAP), over = all.top - GAP - EDGE;
    const above = height > under && over > under;
    const room = Math.max(60, above ? over : under);
    if (height > room) node.style.maxHeight = `${Math.floor(room)}px`;
    const high = Math.min(height, room);
    const top = above ? all.top - GAP - high : all.bottom + GAP;
    const left = Math.max(EDGE, Math.min(first.left, wide - EDGE - width));
    node.style.left = `${Math.round(left)}px`; node.style.top = `${Math.round(Math.max(0, top))}px`;
    node.classList.toggle("above", above); node.classList.toggle("below", !above);
  }

  // ---- when ---------------------------------------------------------------------------------------------------------------
  const view = () => (doc && doc.defaultView) || root;
  function stopWaiting() { if (waiting) { view().clearTimeout(waiting.timer); waiting = null; } }
  /** The card goes (and a question still out is no longer waited for). */
  function close() {
    view().clearTimeout(leaveTimer); view().clearTimeout(readingTimer); leaveTimer = 0; readingTimer = 0;
    if (alive) { view().clearInterval(alive); alive = 0; }
    if (retitled) { retitled.disconnect(); retitled = null; }
    if (pending) { restore(pending); pending = null; }
    if (shown) { restore(shown); shown = null; }
    overCard = false;
    if (node) { node.hidden = true; node.textContent = ""; }
  }
  /** The card goes, and so does a pointer's rest that hasn't asked yet. */
  function hide() { stopWaiting(); close(); }
  function ask(link) {
    waiting = null;
    if (!post || !link.isConnected) return;
    const url = link.dataset.target, had = held.get(url);
    close();
    pending = { link, url, id: `lp${++seq}-${Date.now().toString(36)}`, title: "" };
    const have = had && Date.now() - had.at < KEEP_MS && typeof had.answer.at === "number" ? had.answer.at : undefined;
    try { post({ type: MESSAGE, id: pending.id, url, ...(have !== undefined ? { have } : {}) }); } catch { pending = null; }
  }
  function rest(link, ms, byKey = false) {
    if (link === dismissed) return;
    if ((shown && shown.link === link) || (pending && pending.link === link) || (waiting && waiting.link === link)) { view().clearTimeout(leaveTimer); leaveTimer = 0; return; }
    stopWaiting();
    keyed = byKey;
    waiting = { link, timer: view().setTimeout(() => ask(link), ms) };
  }
  /** The pointer (or focus) is no longer on the card's link: the card goes after a moment, unless it reaches the card. */
  function leave() {
    if ((!shown && !pending) || leaveTimer) return;
    leaveTimer = view().setTimeout(() => { leaveTimer = 0; if (!overCard) close(); }, times.grace);
  }
  /** The host's answer. */
  function take(message) {
    if (!message || message.type !== MESSAGE || !pending || message.id !== pending.id) return false;
    const state = pending;
    if (!state.link.isConnected || message.state === "off") { pending = null; restore(state); return true; }
    let answer = message;
    if (message.state === "same") {
      const had = held.get(state.url);
      if (!had) { pending = null; restore(state); return true; }
      answer = had.answer;
    }
    if (!state.lifted) { state.lifted = true; lift(state); }
    if (answer.state === "reading") {
      // A quick page never flashes a half card: the address shows only when the read takes a moment.
      view().clearTimeout(readingTimer);
      readingTimer = view().setTimeout(() => { readingTimer = 0; if (pending === state && state.link.isConnected) { shown = state; draw(state, answer); follow(state); } }, times.reading);
      return true;
    }
    view().clearTimeout(readingTimer); readingTimer = 0;
    pending = null; shown = state;
    if (answer.state === "page") {
      held.delete(state.url); held.set(state.url, { answer, at: Date.now() });
      for (const old of held.keys()) { if (held.size <= KEEP) break; held.delete(old); }
    }
    draw(state, answer);
    follow(state);
    return true;
  }
  /** A link the page took away while its card was up (a chat drawn again) takes its card with it; one the page drew
   *  again in place, with its label put back, has the label step aside again. */
  let retitled = null;
  function follow(state) {
    if (alive) view().clearInterval(alive);
    alive = view().setInterval(() => { if ((shown === state || pending === state) && (!state.link.isConnected || (state.link.closest && state.link.closest("[hidden]")))) close(); }, 400);
    if (retitled) { retitled.disconnect(); retitled = null; }
    const Observer = view().MutationObserver;
    if (typeof Observer !== "function") return;
    retitled = new Observer(() => { const said = state.link.getAttribute("title"); if (said && (shown === state || pending === state)) { state.title = said; state.link.removeAttribute("title"); } });
    retitled.observe(state.link, { attributes: true, attributeFilter: ["title"] });
  }

  const onOver = (event) => {
    if (event.pointerType === "touch") return;
    if (inCard(event)) { overCard = true; view().clearTimeout(leaveTimer); leaveTimer = 0; return; }
    overCard = false;
    const link = linkOf(event);
    if (dismissed && link !== dismissed) dismissed = null;
    if (link) {
      // (A page that draws itself again puts the link's label back: it steps aside again.)
      const state = (shown && shown.link === link && shown) || (pending && pending.link === link && pending.lifted && pending);
      if (state && link.hasAttribute("title")) { state.title = link.getAttribute("title"); link.removeAttribute("title"); }
      // (Another link's card doesn't wait for this one's: it goes as if the pointer had left it.)
      if ((shown && shown.link !== link) || (pending && pending.link !== link)) leave();
      rest(link, times.rest);
    } else { stopWaiting(); leave(); }
  };
  const onOut = (event) => { if (!event.relatedTarget) { overCard = false; stopWaiting(); leave(); } };                      // the pointer left the page
  const onDown = (event) => {
    lastKey = "";
    if (inCard(event)) return;
    const link = linkOf(event);
    hide();
    if (link) dismissed = link;                                // a click opens it: no card comes up behind the click
  };
  const onFocus = (event) => {
    if (inCard(event)) { view().clearTimeout(leaveTimer); leaveTimer = 0; return; }
    const link = linkOf(event);
    // Only focus the Tab key brought: focus a click put there, or the page put back, is not a request for a card.
    let keyboard = lastKey === "Tab";
    if (keyboard && link) { try { keyboard = link.matches(":focus-visible"); } catch { keyboard = true; } }
    if (link && keyboard) rest(link, times.focus, true);
    // (Focus that moves elsewhere takes a card the keyboard brought. One under a pointer stays: a page that draws
    // itself again puts focus back in its prompt box, and that is not the pointer leaving.)
    else if (!link && keyed && (shown || pending || waiting) && !overCard) hide();
  };
  const onBlur = (event) => {
    const to = event.relatedTarget;
    if (to && node && node.contains(to)) return;
    if (keyed && linkOf(event) && !overCard) { stopWaiting(); if (shown || pending) leave(); }
  };
  const onKey = (event) => {
    lastKey = event.key;
    if (event.key !== "Escape" || (!shown && !pending && !waiting)) return;
    // Escape means it: the card goes and does not come back while the pointer stays where it is.
    dismissed = (shown && shown.link) || (pending && pending.link) || (waiting && waiting.link) || null;
    const focusIn = node && node.contains(doc.activeElement), back = shown && shown.link;
    hide();
    if (focusIn && back && back.isConnected && typeof back.focus === "function") back.focus();
  };
  const onScroll = (event) => { if (node && event.target && event.target.nodeType === 1 && node.contains(event.target)) return; if (shown || pending || waiting) hide(); };
  const onGone = () => hide();
  // Only the host's own answers: a frame inside the page (a plugin's card) can post to this window too, and is never
  // let answer for the host. The host's come from the editor's frames around the page (any of this window's
  // ancestors), or with no source; a test page posts to itself.
  function inside(from) {
    try { for (let w = from, k = 0; w && k < 12; k++) { const up = w.parent; if (!up || up === w) return false; if (up === root) return true; w = up; } } catch { return true; }
    return false;
  }
  const onMessage = (event) => {
    const from = event && event.source;
    if (!event || !event.data || event.data.type !== MESSAGE || (from && from !== root && inside(from))) return;
    take(event.data);
  };

  // (Before the pages' own listeners: the link's label is put aside before a hover label reads it.)
  function listen(scope) {
    scope.addEventListener("pointerover", onOver, true);
    scope.addEventListener("pointerout", onOut, true);
    scope.addEventListener("focusin", onFocus, true);
    scope.addEventListener("focusout", onBlur, true);
    scope.addEventListener("scroll", onScroll, true);
  }
  /** A view drawn in a shadow root of this page (a Pip's chat in the side bar) says so: a pointer that moves from one
   *  thing to another inside the root, a focus that does, and a scroll in it are never told to the page outside it. */
  function watch(scope) {
    if (!scope || typeof scope.addEventListener !== "function" || scope === doc) return () => {};
    listen(scope);
    return () => { for (const [type, fn] of [["pointerover", onOver], ["pointerout", onOut], ["focusin", onFocus], ["focusout", onBlur], ["scroll", onScroll]]) scope.removeEventListener(type, fn, true); };
  }

  /** Connect this page to its host: `send(message)` posts the page's question. Once for a page; a second call only
   *  changes where questions go. */
  function connect(send, options = {}) {
    post = typeof send === "function" ? send : null;
    for (const key of Object.keys(times)) if (Number.isFinite(options[key])) times[key] = options[key];
    const page = options.doc || root.document;
    if (!page || doc === page) return api;
    doc = page;
    const win = doc.defaultView || root;
    listen(doc);
    doc.addEventListener("pointerdown", onDown, true);
    doc.addEventListener("keydown", onKey, true);
    win.addEventListener("blur", onGone);
    win.addEventListener("resize", onGone);
    win.addEventListener("message", onMessage);
    return api;
  }

  const api = Object.freeze({ MESSAGE, REST_MS, FOCUS_MS, GRACE_MS, connect, watch, take, hide, plain });
  root.DgcLinkPreview = api;
})();
