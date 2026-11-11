// The bar for what is going on above a prompt box (the tray), the same in Work, ChatDGC and a Pip's chat
// (media/shared/tray.css is how it looks). It is ONE line at ONE height: each kind of work showing is a pill; narrow,
// the pills are icons with counts; what still does not fit goes behind "+N", which lists the rest; one kind alone is
// the same line, said in full. A pill opens its detail in a popover just above, by keyboard too, and Esc puts the
// focus back on the pill. Nothing going on: no bar. The bar takes its room from the transcript: the box never moves.
//
// A page says what its kinds are; this piece draws, fits and opens them:
//   const tray = DgcTray.create({ line, chips, pop, popBody, popTitle, popClose, popLinks, spec, detail, ... });
//   tray.render(["queue", "tasks"]);     // the kinds showing now, in the bar's order
//   tray.paint("queue");                 // one kind's words changed
// A page with no markup of its own for the bar asks for it: DgcTray.build("cd-tray", "Going on in this chat").
(function () {
  "use strict";
  // How a narrow bar says less: the words go, then the extras, then the number of a pill that needs you. A wide bar
  // keeps whole pills. Either way, what still does not fit goes behind "+N": never a second line.
  const FITS = ["full", "compact", "tight", "tighter"];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const CLOSE = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';

  /** The bar's own markup, for a page that has none: the line, its pills, and the popover they open. */
  function build(id, label, doc = document) {
    const line = doc.createElement("div");
    line.id = id; line.className = "rail-line tray-only";
    line.innerHTML = `<div id="${id}-chips" class="rail-chips" role="toolbar" aria-label="${esc(label)}" hidden></div>`
      // (A dialog only while it is open: closed, it is not one a page's "the dialog" should find.)
      + `<div id="${id}-pop" class="rail-pop dgc-popover" data-tray-role="dialog" aria-modal="false" aria-labelledby="${id}-pop-title" tabindex="-1" hidden>`
      + `<div class="rail-pop-head"><span id="${id}-pop-title" class="rail-pop-title"></span>`
      + `<button type="button" id="${id}-pop-close" class="rail-pop-x" title="Close" aria-label="Close">${CLOSE}</button></div>`
      + `<div id="${id}-pop-body" class="rail-pop-body"></div><div id="${id}-pop-links" class="rail-pop-links" hidden></div></div>`;
    const q = (suffix) => line.querySelector(`#${id}-${suffix}`);
    return { line, chips: q("chips"), pop: q("pop"), popBody: q("pop-body"), popTitle: q("pop-title"), popClose: q("pop-close"), popLinks: q("pop-links") };
  }

  function create(o) {
    const { line, chips, pop, popBody, popTitle } = o;
    const popLinks = o.popLinks || null, doc = line.ownerDocument, view = doc.defaultView;
    const el = (tag, cls) => { const n = doc.createElement(tag); if (cls) n.className = cls; return n; };
    const focusOn = o.focus || ((node, options) => node?.focus?.(options));
    const tipSet = (node, text) => { if (o.tip) o.tip.retitle(node, text); else node.title = text || ""; };
    // The focus as this page sees it: a Pip's chat in the side bar lives in a shadow root.
    const active = () => { const root = line.getRootNode(); return (root && root.activeElement) || doc.activeElement; };
    const input = () => (typeof o.input === "function" ? o.input() : o.input) || null;
    const shown = o.shown || ((node) => !!node && node !== doc.body && node.isConnected && !node.closest("[hidden]"));
    const wide = o.wide || 520, keep = o.keep || [];
    const words = { more: "Show the rest of what is running", list: "The rest of what is running in this chat", ...(o.words || {}) };
    const popId = pop.id || "";

    let hiddenKinds = [];                        // the kinds behind "+N", in the bar's order
    const more = el("button", "rail-more");
    more.type = "button"; if (o.moreId) more.id = o.moreId; more.dataset.kind = "more"; more.tabIndex = -1;
    more.setAttribute("aria-haspopup", "dialog"); more.setAttribute("aria-expanded", "false");
    if (popId) more.setAttribute("aria-controls", popId);
    more.addEventListener("click", () => { if (open?.kind === "more") close(); else openMore(); });
    more.addEventListener("focus", () => { if (stop !== "more") { stop = "more"; rove(); } });
    // One kind alone has its everyday action at the end of its line (a queue's Steer all, the changes' Review).
    const soloAct = el("button", o.soloClass || "rail-text-action rail-solo-act");
    soloAct.type = "button"; if (o.soloId) soloAct.id = o.soloId;   // on the line only while it has something to do
    const nodes = new Map();                     // kind -> its pill, kept across repaints so a focused pill keeps focus
    let kinds = [], stop = "", open = null, fitted = { width: -1, shape: "" }, linksSig = "";

    // What a pill says: an icon, a word (the first thing a short line drops), the number, extras (dropped next) and,
    // when the kind needs you, the reason in words (they go last; the colour and the label never do).
    function face(spec) {
      const icon = o.icon ? o.icon(spec) : `<span class="codicon codicon-${esc(spec.icon)}" aria-hidden="true"></span>`;
      const part = (cls, text) => (text ? `<span class="${cls}">${esc(text)}</span>` : "");
      const mini = typeof spec.share === "number"
        ? `<span class="chip-mini troupe-bar" aria-hidden="true"><span style="width:${spec.share}%"></span></span>` : "";
      const extra = (spec.extra || []).map(([text, cls]) => part(`chip-extra ${cls}`.trim(), text)).join("");
      const need = spec.need ? part("chip-need", spec.needWord) : "";
      // The detail and the caret show only where the kind has the whole line (one kind alone) or a row of the "+N" list.
      return icon + part("chip-word", spec.word) + part("chip-num", spec.num) + part("chip-word", spec.after) + mini + extra + need
        + part("chip-detail", spec.detail) + (o.caret || '<span class="chip-caret codicon codicon-chevron-up" aria-hidden="true"></span>');
    }
    // A pill that acts at once instead of opening (one Pip running goes straight to its chat).
    const direct = (kind) => (o.direct ? o.direct(kind) : null);
    function chipFor(kind) {
      const chip = el("button", "rail-chip");
      chip.type = "button";
      chip.dataset.kind = kind;
      chip.tabIndex = -1;
      chip.setAttribute("aria-haspopup", "dialog");
      chip.setAttribute("aria-expanded", "false");
      if (popId) chip.setAttribute("aria-controls", popId);
      chip.addEventListener("click", () => {
        const go = direct(kind);
        if (go) { go(); return; }
        if (open?.kind === kind) close(); else openKind(kind);
      });
      chip.addEventListener("focus", () => { if (stop !== kind) { stop = kind; rove(); } });
      return chip;
    }
    function paint(kind) {
      const chip = nodes.get(kind), spec = chip ? o.spec(kind) : null;
      if (!spec) return;
      const sig = JSON.stringify(spec);
      if (chip._sig === sig) return;
      chip._sig = sig;
      chip.innerHTML = face(spec);
      chip.toggleAttribute("data-live", !!spec.live);
      if (direct(kind)) chip.removeAttribute("aria-haspopup"); else chip.setAttribute("aria-haspopup", "dialog");
      if (spec.need) chip.dataset.need = spec.tone === "error" ? "error" : "warn"; else delete chip.dataset.need;
      chip.setAttribute("aria-label", spec.label + (spec.need ? `. Needs you${spec.needWord ? `: ${spec.needWord}` : ""}` : ""));
      tipSet(chip, spec.tip);
      // Only a change of shape can change what fits: a ticking clock keeps its width.
      const shape = sig.replace(/\d/g, "0");
      if (chip._shape !== shape) { chip._shape = shape; fit(); }
      if (hiddenKinds.includes(kind)) { paintMoreButton(); if (open?.kind === "more") paintMore(); }
    }
    function render(present) {
      const focusWas = active();
      const hadFocus = pop.contains(focusWas) || chips.contains(focusWas);
      kinds = present;
      chips.hidden = !present.length;
      line.classList.toggle("has-chips", present.length > 0);
      // Its kind ended (a cleared checklist, an emptied queue).
      if (open && open.kind !== "more" && !present.includes(open.kind)) close({ restore: false });
      for (const [kind, chip] of nodes) {
        if (!present.includes(kind)) { chip.remove(); nodes.delete(kind); }
      }
      paintSolo();                               // before the pills are painted: each paint may fit the line
      present.forEach((kind, index) => {
        let chip = nodes.get(kind);
        if (!chip) { chip = chipFor(kind); nodes.set(kind, chip); }
        if (chips.children[index] !== chip) chips.insertBefore(chip, chips.children[index] || null);
        paint(kind);
      });
      rove();
      if (open) paintLinks(open.kind);
      fit();
      // Focus that was on the line or in its popover and has nowhere left to be goes to the line, else the prompt.
      if (hadFocus && !shown(active())) {
        const first = chips.querySelector('[tabindex="0"]');
        if (first && !chips.hidden) focusOn(first); else input()?.focus({ preventScroll: true });
      }
    }
    // One Tab stop for the whole line: the pill last used, else the first.
    const stops = () => [...chips.children].filter((chip) => !chip.hidden);
    function rove() {
      const list = stops();
      const held = list.find((chip) => chip.dataset.kind === stop) || list[0];
      for (const chip of chips.children) { const want = chip === held ? 0 : -1; if (chip.tabIndex !== want) chip.tabIndex = want; }
    }
    // One kind alone: the line says it in full, with its everyday action at the end.
    function paintSolo() {
      const kind = kinds.length === 1 ? kinds[0] : "";
      if (kind) line.dataset.solo = kind; else delete line.dataset.solo;
      const act = kind && o.solo ? o.solo(kind) : null;
      if (!act) {
        if (soloAct.isConnected) { const held = soloAct === active(); soloAct.remove(); if (held) focusOn(anchor(kind) || input()); }
        return;
      }
      if (!soloAct.isConnected) chips.after(soloAct);
      if (soloAct.textContent !== act[0]) soloAct.textContent = act[0];
      soloAct.title = act[1]; soloAct.onclick = act[2];
    }
    // The bar is one line, always. It never wraps, scrolls sideways or clips a pill: a narrow bar drops the words, then
    // the extras, then the number of a pill that needs you (its reason stays); a wide one keeps whole pills. What still
    // does not fit goes behind "+N", the kinds that matter least first.
    function fit(force = false) {
      if (!kinds.length) {
        delete line.dataset.fit; delete line.dataset.squeeze; fitted = { width: -1, shape: "" };
        more.remove(); setHidden([]);
        return;
      }
      if (kinds.some((kind) => !nodes.has(kind))) return;   // mid-repaint: the last pill's paint fits them all
      const width = line.clientWidth;
      const shape = kinds.map((kind) => `${kind}:${nodes.get(kind)?._shape || ""}`).join("|") + (soloAct.isConnected ? "|act" : "");
      if (!force && width === fitted.width && shape === fitted.shape) return;
      fitted = { width, shape };
      const solo = kinds.length === 1, behind = [];
      for (const chip of nodes.values()) if (chip.hidden) chip.hidden = false;
      more.remove();
      delete line.dataset.squeeze;
      const fits = () => chips.scrollWidth <= chips.clientWidth + 1;
      // One kind alone keeps its words at any width. A wide bar short of room first folds what shares the line with the
      // pills to its icon ("roomy"): the pills keep their words.
      for (const step of width >= wide ? ["full", "roomy"] : solo ? ["solo"] : FITS) {
        line.dataset.fit = step;
        if (fits()) break;
      }
      if (!solo && !fits()) {
        chips.appendChild(more);
        const rank = (kind) => (nodes.get(kind)?.hasAttribute("data-need") ? 0 : 100) + keep.indexOf(kind);
        for (const kind of [...kinds].sort((a, b) => rank(b) - rank(a))) {
          if (behind.length >= kinds.length - 1) break;      // one pill always stays beside "+N"
          nodes.get(kind).hidden = true;
          behind.push(kind);
          more.textContent = `+${behind.length}`;
          if (fits()) break;
        }
        if (!fits()) line.dataset.squeeze = "";
      }
      setHidden(kinds.filter((kind) => behind.includes(kind)));
    }
    function setHidden(list) {
      const changed = list.join() !== hiddenKinds.join();
      hiddenKinds = list;
      paintMoreButton();
      if (!changed) return;
      rove();
      if (open?.kind === "more") { if (list.length) paintMore(); else close({ restore: false }); }
      else if (open) {
        // The open kind's pill went behind "+N" or came back: its popover hangs off whichever stands for it now.
        const at = anchor(open.kind);
        for (const chip of [...nodes.values(), more]) chip.setAttribute("aria-expanded", String(chip === at));
        open.chip = at || open.chip;
      }
    }
    function paintMoreButton() {
      const specs = hiddenKinds.map((kind) => o.spec(kind)).filter(Boolean);
      const need = specs.find((spec) => spec.need && spec.tone === "error") || specs.find((spec) => spec.need);
      if (need) more.dataset.need = need.tone === "error" ? "error" : "warn"; else delete more.dataset.need;
      const label = `${hiddenKinds.length} more`;
      if (more.textContent !== `+${hiddenKinds.length}`) more.textContent = `+${hiddenKinds.length}`;
      more.setAttribute("aria-label", `${label}${need ? ", one needs you" : ""}. ${words.more}`);
      tipSet(more, specs.map((spec) => String(spec.tip || "").split("\n")[0]).join("\n"));
    }
    // The pill that stands for a kind on the bar: its own, or "+N" while it is behind it.
    function anchor(kind) {
      if (kind === "more") return more.isConnected ? more : null;
      const chip = nodes.get(kind);
      return chip && !chip.hidden ? chip : more.isConnected ? more : chip || null;
    }
    // "+N" opened: the rest as a list, each row opening its own detail (the same popover its pill would open).
    function paintMore() {
      const rows = [...popBody.querySelectorAll(".rail-more-row")];
      const held = rows.find((row) => row === active())?.dataset.kind || "";
      const list = el("div", "rail-more-list");
      list.setAttribute("role", "group");
      list.setAttribute("aria-label", words.list);
      for (const kind of hiddenKinds) {
        const spec = o.spec(kind);
        if (!spec) continue;
        const row = el("button", "rail-more-row");
        row.type = "button"; row.dataset.kind = kind;
        row.innerHTML = face(spec) + '<span class="row-open" aria-hidden="true">Open</span>';
        row.toggleAttribute("data-live", !!spec.live);
        if (spec.need) row.dataset.need = spec.tone === "error" ? "error" : "warn";
        row.setAttribute("aria-label", `${spec.label}${spec.need ? `. Needs you${spec.needWord ? `: ${spec.needWord}` : ""}` : ""}. Open`);
        row.addEventListener("click", () => {
          const go = direct(kind);
          if (go) { close({ restore: false }); go(); return; }
          openKind(kind);
        });
        list.appendChild(row);
      }
      popBody.replaceChildren(list);
      popTitle.textContent = `${hiddenKinds.length} more`;
      if (held) focusOn(list.querySelector(`.rail-more-row[data-kind="${held}"]`) || list.firstElementChild || pop, { preventScroll: true });
    }
    function show(kind) {
      linksSig = "";
      paintLinks(kind);
      pop.dataset.kind = kind;
      if (pop.dataset.trayRole) pop.setAttribute("role", pop.dataset.trayRole);
      pop.hidden = false;
      line.classList.add("pop-open");
      sizePop();
    }
    function openMore() {
      if (!hiddenKinds.length || !more.isConnected) return;
      if (open) close({ restore: false });
      o.tip?.hide();
      open = { kind: "more", bar: null, chip: more, unfolded: [] };
      paintMore();
      show("more");
      more.setAttribute("aria-expanded", "true");
      stop = "more"; rove();
      focusOn(popBody.querySelector(".rail-more-row") || pop, { preventScroll: true });
    }
    // The popover may use the height between the page's header and the bar, and scrolls past that.
    function sizePop() {
      if (!open) return;
      const room = Math.floor(line.getBoundingClientRect().top - (o.popTop ? o.popTop() : 0) - 12);
      pop.style.maxHeight = room > 0 ? `${Math.max(160, room)}px` : "";
    }
    // Ways further than the detail goes, under it.
    function paintLinks(kind) {
      if (!popLinks) return;
      const links = (o.links && kind !== "more" ? o.links(kind) : null) || [];
      const sig = links.map(([text, title]) => `${text}\n${title}`).join("\n") + (links.length ? kind + (o.linksKey ? o.linksKey(kind) : "") : "");
      if (sig === linksSig) return;
      linksSig = sig;
      popLinks.replaceChildren(...links.map(([text, title, run]) => {
        const link = el("button", "link rail-pop-link");
        link.type = "button"; link.textContent = text; link.title = title; link.onclick = run;
        return link;
      }));
      popLinks.hidden = !links.length;
    }
    function openKind(kind) {
      const chip = anchor(kind), bar = o.detail(kind);
      if (!chip || !bar || bar.hidden) return;
      if (open) close({ restore: false });
      o.tip?.hide();
      // Where the detail lives while its pill is closed, so it goes back to its own place.
      open = { kind, bar, chip, unfolded: [], home: bar.parentNode, next: bar.nextSibling };
      popBody.replaceChildren(bar);              // the detail itself moves: its ids, controls and live updates come with it
      o.opened?.(kind, open);
      popTitle.textContent = (o.title ? o.title(kind) : "") || "";
      show(kind);
      chip.setAttribute("aria-expanded", "true");
      stop = chip.dataset.kind; rove();
      // Into the popover: the detail's own main control, else the popover itself.
      focusOn((o.popFocus ? o.popFocus(kind, bar) : bar.querySelector("[data-tray-focus]")) || pop, { preventScroll: true });
    }
    // `restore`: put the focus back on the pill if it was inside the popover (Esc, ×, the pill again). A click
    // elsewhere, or Tab out of it, leaves the focus where it went.
    function close({ restore = true } = {}) {
      if (!open) return;
      const was = open, { kind, bar, unfolded } = was;
      const chip = anchor(kind) || was.chip;
      const focused = active(), inside = pop.contains(focused);
      open = null;
      unfolded.forEach((fold) => fold());
      if (!bar) popBody.replaceChildren();       // the "+N" list is the popover's own
      else if (o.restore) o.restore(kind, bar);
      else if (was.home) was.home.insertBefore(bar, was.next && was.next.parentNode === was.home ? was.next : null);
      else bar.remove();
      pop.hidden = true;
      if (pop.dataset.trayRole) pop.removeAttribute("role");
      pop.style.maxHeight = "";
      delete pop.dataset.kind;
      if (popLinks) { popLinks.replaceChildren(); popLinks.hidden = true; }
      linksSig = "";
      line.classList.remove("pop-open");
      for (const node of [...nodes.values(), more]) node.setAttribute("aria-expanded", "false");
      o.closed?.(kind, bar);
      if (!inside) return;
      if (restore && chip.isConnected && !chip.hidden && !chips.hidden) { focusOn(chip); return; }
      if (!bar) return;
      // Moving the detail took the focus off it. Where it is on screen again, the focus goes back to the same control.
      if (focused?.isConnected && bar.contains(focused) && shown(focused)) focusOn(focused);
    }
    if (o.popClose) o.popClose.onclick = () => close();
    pop.addEventListener("keydown", (event) => {
      // The "+N" list: the arrows move along its rows.
      if (open?.kind === "more" && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        const rows = [...popBody.querySelectorAll(".rail-more-row")], at = rows.indexOf(active());
        if (!rows.length) return;
        event.preventDefault();
        const to = event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1
          : event.key === "ArrowDown" ? (at + 1) % rows.length : (at - 1 + rows.length) % rows.length;
        rows[to].focus();
        return;
      }
      if (event.key !== "Escape" || !open) return;
      event.preventDefault(); event.stopPropagation();    // Esc in a prompt box is Stop: this one must not reach it
      close();
    });
    // A control that went away under the focus leaves the focus on the page itself: Esc there still closes the
    // popover, and the focus goes back to its pill.
    doc.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !open || event.defaultPrevented || !line.isConnected) return;
      const at = active();
      if (at && at !== doc.body) return;
      event.preventDefault();
      const chip = anchor(open.kind) || open.chip;
      close();
      if (chip.isConnected && !chip.hidden && !chips.hidden) focusOn(chip);
    });
    chips.addEventListener("keydown", (event) => {
      const list = stops(), at = list.indexOf(event.target);
      if (at < 0) return;
      if (event.key === "Escape") {
        if (!open) return;
        event.preventDefault(); event.stopPropagation();
        close();
        return;
      }
      const to = event.key === "ArrowRight" ? (at + 1) % list.length : event.key === "ArrowLeft" ? (at - 1 + list.length) % list.length
        : event.key === "Home" ? 0 : event.key === "End" ? list.length - 1 : -1;
      if (to < 0) return;
      event.preventDefault();
      stop = list[to].dataset.kind; rove();
      list[to].focus();
    });
    // A dialog or a menu opened from the popover sits over it (o.over names them): working in it is not "elsewhere",
    // and the popover is still there, with the focus coming back to it, when it closes.
    const away = (node) => !!node && node.nodeType === 1 && !pop.contains(node) && !chips.contains(node)
      && !(o.over && node.closest(o.over));
    doc.addEventListener("pointerdown", (event) => {
      if (!open || !line.isConnected) return;
      const target = typeof event.composedPath === "function" ? event.composedPath()[0] : event.target;
      if (away(target)) close({ restore: false });
    }, true);
    pop.addEventListener("focusout", (event) => {
      // Focus that went nowhere (a repaint took the focused control away) leaves it open.
      if (open && event.relatedTarget && away(event.relatedTarget)) close({ restore: false });
    });
    if (view && typeof view.ResizeObserver === "function") new view.ResizeObserver(() => { fit(); sizePop(); }).observe(line);
    view?.addEventListener("resize", () => sizePop());

    return { render, paint, fit, close, anchor, more, soloAct, nodes,
      openKind, openMore,
      get open() { return open; }, get kinds() { return kinds; }, get hidden() { return hiddenKinds; } };
  }

  globalThis.DgcTray = { create, build, FITS };
})();
