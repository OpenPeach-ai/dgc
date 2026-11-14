// DGC's own hover label, for every page that is not Work's (Work's page has had one since 0.46: media/main.js). The
// browser's own `title` tooltip is drawn by the system, outside the page, and the window's edge cuts it ("Mark as
// read, w…" beside a Pip's row, 14 Nov). This one is drawn in the page, so it always stays inside it: over the control,
// or under it when there is no room over, and never off a side.
//
// A control keeps saying what it is with `title` (or `data-tip`), as before; nothing else in a page changes. While the
// pointer rests on it (700 ms, Work's and Codex's delay; at once on the next control for a short while after) or the
// Tab key reaches it, the label shows. Under a pointer the control's `title` is lifted so the system's tooltip stays
// away, and put back when the label goes; a page that draws itself again while the label is up (the Pips view) puts
// `title` back early, and it is lifted again.
//
//   const tip = DgcTip.install({ root, shell, look });   // root: a document or a shadow root; shell: the box to stay inside
//   tip.hide(); tip.dispose();
(function (root) {
  "use strict";
  const DELAY_MS = 700, WARM_MS = 300, GAP = 6, EDGE = 4;

  function install(options = {}) {
    const scope = options.root || root.document, doc = scope.ownerDocument || scope, view = doc.defaultView || root;
    const shell = options.shell || doc.body, delayMs = Number.isFinite(options.delay) ? options.delay : DELAY_MS;
    // (`look`: the label's class. A page that already carries Work's stylesheet names Work's own, "tip".)
    const look = options.look || "dgc-tip", node = doc.createElement("div");
    node.className = look; node.hidden = true; node.setAttribute("role", "tooltip");
    shell.appendChild(node);
    let timer = 0, warm = 0, target = null, lifted = "", watching = null, lastKey = "", alive = 0;

    const labelOf = (el) => (el.getAttribute("title") || el.dataset.tip || "").trim();
    const find = (event) => {
      // Through a shadow root too: the path is the event's own, never the page's retargeted target.
      const path = typeof event.composedPath === "function" ? event.composedPath() : [event.target];
      for (const n of path) { if (n === scope || n === shell) break; if (n && n.nodeType === 1 && (n.hasAttribute("title") || n.dataset.tip) && (n === target ? lifted || labelOf(n) : labelOf(n))) return n; }
      // (The control whose title is lifted has none just now, but is still the one pointed at.)
      return target && path.includes(target) ? target : null;
    };
    function hide() {
      view.clearTimeout(timer); if (alive) { view.clearInterval(alive); alive = 0; }
      if (watching) { watching.disconnect(); watching = null; }
      if (target && lifted && target.isConnected && !target.hasAttribute("title")) target.setAttribute("title", lifted);
      if (!node.hidden) warm = Date.now();
      target = null; lifted = ""; node.hidden = true; node.className = look;
    }
    function paint(el, label) {
      const [head, ...more] = label.split("\n").map((line) => line.trim()).filter(Boolean);
      node.textContent = head || "";
      if (more.length) { const detail = doc.createElement("span"); detail.className = `${look}-detail`; detail.textContent = more.join(" "); node.appendChild(detail); }
      node.className = look; node.hidden = false;
      // Inside the shell's box (a side bar's panel, an editor tab): the box may be what a fixed thing is placed
      // against, so where "0, 0" lands is measured, never assumed.
      const box = shell.getBoundingClientRect(), wide = doc.documentElement.clientWidth, tall = doc.documentElement.clientHeight;
      const left0 = Math.max(0, box.left) + EDGE, right0 = Math.min(wide, box.right) - EDGE, top0 = Math.max(0, box.top) + EDGE, bottom0 = Math.min(tall, box.bottom) - EDGE;
      node.style.maxWidth = `${Math.max(80, Math.min(280, right0 - left0))}px`;
      node.style.left = "0px"; node.style.top = "0px";
      const zero = node.getBoundingClientRect(), a = el.getBoundingClientRect();
      let top = a.top - zero.height - GAP, side = "above";
      if (top < top0) { top = a.bottom + GAP; side = "below"; }
      if (side === "below" && top + zero.height > bottom0 && a.top - zero.height - GAP >= 0) { top = Math.max(top0, a.top - zero.height - GAP); side = "above"; }
      const left = Math.max(left0, Math.min(Math.round(a.left + a.width / 2 - zero.width / 2), right0 - zero.width));
      node.style.left = `${Math.round(left - zero.left)}px`; node.style.top = `${Math.round(top - zero.top)}px`;
      // The arrow points at the control, wherever the label was nudged to stay inside.
      node.style.setProperty("--tip-arrow", `${Math.round(Math.max(8, Math.min(a.left + a.width / 2 - left, zero.width - 8)))}px`);
      node.classList.add(side);
    }
    function lift(el) {
      const said = el.getAttribute("title");
      if (said) { lifted = said; el.removeAttribute("title"); }
    }
    function watch(el) {
      // A page that draws itself again puts `title` back (or changes its words): lifted again, and said again.
      if (watching || typeof view.MutationObserver !== "function") return;
      watching = new view.MutationObserver(() => { if (target !== el) return; const now = el.getAttribute("title"); if (now) { lifted = now; el.removeAttribute("title"); if (!node.hidden) paint(el, now.trim()); } });
      watching.observe(el, { attributes: true, attributeFilter: ["title"] });
    }
    function show(el, instant) {
      // (The keyboard's label keeps the control's `title`: the system shows its tooltip only to a pointer. A pointer that
      // then rests on the same control has it lifted.)
      if (el === target) { if (!instant && !node.hidden && !lifted) { lift(el); watch(el); } return; }
      const label = labelOf(el);
      if (!label || el.closest("[hidden]")) { hide(); return; }
      hide();
      target = el;
      timer = view.setTimeout(() => {
        if (target !== el || !el.isConnected) return;
        if (el.classList.contains("is-sliding")) return;       // a long name sliding in a menu shows itself whole
        const words = labelOf(el); if (!words) return;
        if (!instant) { lift(el); watch(el); }
        paint(el, words);
        // A control the page took away while its label was up (a list drawn again) takes its label with it.
        alive = view.setInterval(() => { if (!el.isConnected || !el.getClientRects().length) hide(); }, 400);
      }, instant ? 0 : Date.now() - warm < WARM_MS ? 0 : delayMs);
    }
    const over = (e) => { const found = find(e); if (found) show(found, false); else hide(); };
    const leave = (e) => { if (!e.relatedTarget) hide(); };            // the pointer left the page
    const down = () => hide();
    const focus = (e) => {
      const found = find(e);
      // Only focus the Tab key brought: a label on every click is noise, and so is one on the control focus is put
      // back on as a menu or a dialog closes (it would cover what was under it).
      let keyboard = true; try { keyboard = found ? found.matches(":focus-visible") : false; } catch { keyboard = !!found; }
      keyboard = keyboard && lastKey === "Tab";
      if (found && keyboard) show(found, true); else hide();
    };
    const key = (e) => { lastKey = e.key; if (e.key === "Escape") hide(); };
    const scrolled = () => hide();
    scope.addEventListener("pointerover", over);
    scope.addEventListener("pointerout", leave);
    scope.addEventListener("pointerdown", down, true);
    scope.addEventListener("focusin", focus);
    scope.addEventListener("focusout", hide);
    doc.addEventListener("keydown", key, true);       // (the page's: the Tab that brings focus in is pressed outside a shadow root)
    scope.addEventListener("scroll", scrolled, true);
    view.addEventListener("blur", hide);
    return { node, hide, dispose() {
      hide(); node.remove();
      scope.removeEventListener("pointerover", over); scope.removeEventListener("pointerout", leave); scope.removeEventListener("pointerdown", down, true);
      scope.removeEventListener("focusin", focus); scope.removeEventListener("focusout", hide); doc.removeEventListener("keydown", key, true);
      scope.removeEventListener("scroll", scrolled, true); view.removeEventListener("blur", hide);
    } };
  }

  root.DgcTip = { install, DELAY_MS, WARM_MS };
})(typeof window !== "undefined" ? window : globalThis);
