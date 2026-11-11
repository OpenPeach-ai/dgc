// Home, the first tab of DGC's side bar: everything that needs you or has news, each as one card of the same size
// (media/shared/card.js, its thin form), whether it comes from a Pip (its face) or a session (its blob), or is a thing
// made (the sheet of its kind, media/shared/filesheet.js; its source is "" when nothing says where: All only). Two groups,
// "Needs you" then "New", under a Show filter: All, Work, Chat, Personal Pips, Project Pips, each with its count.
// media/shared/hub.css is how it looks. The page gives the cards (media/main.js builds them from its sessions, chats and
// Pips) and answers what is chosen; this file draws, filters and keeps the keyboard where it was. A classic script,
// loaded before main.js: window.DgcHub.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcHub) return;

  const SOURCES = [["all", "All"], ["work", "Work"], ["chat", "Chat"], ["personal", "Personal Pips"], ["project", "Project Pips"]];
  const NAME = Object.fromEntries(SOURCES);
  const GROUPS = [["needs", "Needs you"], ["new", "New"]];
  const FIRST = 8;                 // cards a group shows before "Show N more"
  const CHEVRON = '<svg class="dgc-hub-chevron" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="m4.5 6.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  /**
   * The hub in `host`.
   *   show()            the kept filter ("all" | "work" | "chat" | "personal" | "project"); onShow(value) keeps a new one
   *   onAct(key, act)   a card's answer was chosen: act is an action's id ("open", "read", "dismiss" ...)
   *   onClear(keys)     Clear, beside "New": the cards it covers (what is shown)
   *   onMore()          "N more need you": where the rest are; onPips(): "More Pips may have news": your Pips
   *   onCount(total)    how many cards there are in all, whatever is shown (the Home tab's number)
   *   onDraw(host)      after a redraw: the page starts its faces and blobs moving
   * update({ cards, more, partial, notes }) draws.
   *   cards: [{ key, source, group: "needs" | "new", who: { html }, from, title, chips, actions: [{ id, label, primary?, title? }], label }]
   *     A card answered where it is also has `full` (the one line it must show whole to be answered here; `mono` for a
   *     command), `more` (a quiet third answer, the way to all of it) and `fallback` (its answers when that line or its
   *     sentence does not fit: it opens instead, with its chips as before).
   *   more: how many more need you than the cards show; partial: more Pips may have news than DGC named; notes: [{ text, retry? }] lines that say what went wrong
   */
  function create({ host, show, onShow, onAct, onClear, onMore, onPips, onRetry, onCount, onDraw } = {}) {
    const doc = host.ownerDocument, view = doc.defaultView, Card = root.DgcCard, Menu = root.DgcMenu;
    const esc = Card.esc;
    let state = { cards: [], more: 0, partial: false, notes: [] }, drawn = "", menu = null, unwatch = null;
    const open = new Set();          // groups shown in full
    let cuts = new Set();            // cards whose line does not show whole here: they open instead
    const filter = () => { const v = show?.(); return NAME[v] ? v : "all"; };
    const counts = () => { const n = { all: state.cards.length, work: 0, chat: 0, personal: 0, project: 0 }; for (const c of state.cards) if (n[c.source] !== undefined) n[c.source]++; return n; };

    function cardHtml(c) {
      const here = c.full !== undefined && !cuts.has(c.key);        // answered on the card
      const answers = [...((c.full !== undefined && !here ? c.fallback : c.actions) || []).filter(Boolean).slice(0, 2), here && c.more ? { ...c.more, primary: false, cls: "dgc-hub-open" } : null].filter(Boolean);
      return Card.html({ id: `hub-${c.key}`, cls: `dgc-card-thin dgc-hub-card${here ? " dgc-hub-answers" : ""}${here && c.mono ? " dgc-hub-mono" : ""}${c.held ? " dgc-hub-held" : ""}`,
        label: c.label || `${c.from}: ${c.title}${here ? `: ${c.full}` : ""}`,
        attrs: { "data-key": c.key, "data-source": c.source, "data-group": c.group },
        icon: { html: c.who?.html || "", face: true }, title: c.title, sub: c.from, chips: here ? [] : c.chips, note: here ? c.full : undefined,
        actions: answers.map((a) => ({ label: a.label, primary: !!a.primary, title: a.title, cls: a.cls, attrs: { "data-hub-act": a.id, ...(a.say ? { "aria-label": a.say } : {}) } })) });
    }
    /** The cards answered here whose line, or sentence, is cut where it is drawn. */
    function cutNow() {
      const found = [];
      for (const card of host.querySelectorAll(".dgc-hub-answers")) {
        const line = card.querySelector(".dgc-card-note"), title = card.querySelector(".dgc-card-title");
        if (!line || !line.clientWidth) continue;       // not laid out (another tab is shown): measured when it is
        const foot = card.querySelector(".dgc-card-actions")?.getBoundingClientRect().bottom || 0;
        if (line.scrollWidth > line.clientWidth + 0.5 || line.scrollHeight > line.clientHeight + 1 || title.scrollHeight > title.clientHeight + 1 || foot > card.getBoundingClientRect().bottom - 1) found.push(card.dataset.key);
      }
      return found;
    }

    function draw(force = false) {
      const f = filter(), n = counts();
      const shown = state.cards.filter((c) => f === "all" || c.source === f);
      const next = JSON.stringify([f, state, [...open]]);
      onCount?.(n.all);
      if (next === drawn && !force) return;
      drawn = next;
      // The keyboard stays where it was: the same card's same answer, or the card that took its place, or Show.
      const active = host.contains(doc.activeElement) ? doc.activeElement : null, heldCard = active?.closest?.(".dgc-hub-card");
      const held = active ? { key: heldCard?.dataset.key || "", act: active.dataset?.hubAct || "", group: heldCard?.dataset.group || "",
        at: heldCard ? [...host.querySelectorAll(`.dgc-hub-card[data-group="${heldCard.dataset.group}"]`)].indexOf(heldCard) : -1, cls: active.className } : null;
      const render = () => {
      let html = `<div class="dgc-hub-bar"><button type="button" class="dgc-hub-show" aria-haspopup="menu" aria-expanded="${menu ? "true" : "false"}" aria-label="Show: ${esc(NAME[f])}. Choose what Home shows" title="Choose what Home shows">`
        + `<span class="dgc-hub-show-k">Show</span><span class="dgc-hub-show-v">${esc(NAME[f])}</span>${CHEVRON}</button></div>`;
      for (const note of state.notes || []) html += `<p class="dgc-hub-note" role="status">${esc(note.text)}${note.retry ? ` <button type="button" class="dgc-hub-link dgc-hub-retry" title="Ask DGC again">Retry</button>` : ""}</p>`;
      for (const [group, name] of GROUPS) {
        const all = shown.filter((c) => c.group === group);
        const more = group === "needs" && (f === "all" || f === "personal" || f === "project") ? Number(state.more) || 0 : 0;
        if (!all.length && !more) continue;
        const cut = open.has(group) || all.length <= FIRST ? all : all.slice(0, FIRST);
        html += `<section class="dgc-hub-group" data-group="${group}" aria-labelledby="dgc-hub-h-${group}"><div class="dgc-hub-head"><h2 id="dgc-hub-h-${group}">${name}<span class="dgc-hub-n">${all.length + more}</span></h2>`
          + (group === "new" && all.length ? `<button type="button" class="dgc-hub-link dgc-hub-clear" title="Clear what is new here. What needs you stays.">Clear</button>` : "") + `</div>`
          + `<div class="dgc-hub-cards">${cut.map(cardHtml).join("")}</div>`
          + (cut.length < all.length ? `<button type="button" class="dgc-hub-link dgc-hub-rest" data-group="${group}" title="Show the rest of these here">Show ${all.length - cut.length} more</button>` : "")
          + (more ? `<button type="button" class="dgc-hub-link dgc-hub-more" title="Open Needs attention in Pips">${more} more ${more === 1 ? "needs" : "need"} you · Open in Pips</button>` : "")
          + (group === "new" && state.partial && f !== "work" && f !== "chat" ? `<button type="button" class="dgc-hub-link dgc-hub-all" title="Open your Pips">More Pips may have news · Open Pips</button>` : "")
          + `</section>`;
      }
      if (!shown.length && !(state.more && f !== "work" && f !== "chat")) {
        html += `<p class="dgc-hub-empty">${n.all && f !== "all" ? `Nothing from ${esc(NAME[f])} right now. Show All has ${n.all}.`
          : "Nothing needs you. New things arrive here."}</p>`;
      }
      host.innerHTML = html;
      };
      // A card is answered here only where it shows its line whole: drawn so first, then any that is cut opens instead.
      cuts = new Set();
      render();
      const cut = cutNow();
      if (cut.length) { cuts = new Set(cut); render(); }
      Card.fit(host);
      onDraw?.(host);
      if (held) {
        const cards = [...host.querySelectorAll(".dgc-hub-card")];
        const same = cards.find((c) => c.dataset.key === held.key);
        const group = cards.filter((c) => c.dataset.group === held.group), near = held.at >= 0 ? group[Math.min(held.at, group.length - 1)] || cards[0] : null;
        const target = held.key ? (same?.querySelector(`[data-hub-act="${held.act}"]`) || same?.querySelector("[data-hub-act]") || near?.querySelector(`[data-hub-act="${held.act}"]`) || near?.querySelector("[data-hub-act]"))
          : (held.cls && host.querySelector(`.${held.cls.split(" ").filter((c) => c.startsWith("dgc-hub-")).join(".") || "dgc-hub-show"}`));
        (target || host.querySelector(".dgc-hub-show"))?.focus({ preventScroll: true });
      }
    }

    // ---- the Show menu: the shared menu's rows, each with its count, the chosen one checked ---------------------------
    function closeMenu(back = false) {
      if (!menu) return;
      const was = menu; menu = null;
      doc.removeEventListener("pointerdown", was.outside, true);
      view.removeEventListener("blur", was.away); view.removeEventListener("resize", was.away);
      was.box.remove();
      const button = host.querySelector(".dgc-hub-show");
      button?.setAttribute("aria-expanded", "false");
      if (back) button?.focus({ preventScroll: true });
    }
    function openMenu(keyboard) {
      closeMenu();
      const button = host.querySelector(".dgc-hub-show"), f = filter(), n = counts();
      const box = doc.createElement("div");
      box.className = "dgc-menu dgc-pop dgc-hub-menu"; box.setAttribute("role", "menu"); box.setAttribute("aria-label", "Show on Home");
      box.innerHTML = Menu.html([{ rows: SOURCES.map(([id, label]) => ({ id, label, hint: String(n[id]), checked: id === f })) }], { role: "menuitemradio", data: "show", check: true });
      doc.body.append(box);
      const a = button.getBoundingClientRect(), w = box.offsetWidth, h = box.offsetHeight;
      box.style.left = `${Math.round(Math.max(6, Math.min(view.innerWidth - w - 6, a.left)))}px`;
      box.style.top = `${Math.round(Math.max(6, Math.min(view.innerHeight - h - 6, a.bottom + 6)))}px`;
      box.style.setProperty("--pop-x", "24px"); box.style.setProperty("--pop-y", "0%");
      button.setAttribute("aria-expanded", "true");
      box.addEventListener("click", (e) => {
        const row = e.target.closest("[data-show]");
        if (!row) return;
        const value = row.dataset.show;
        closeMenu(true);
        if (value !== f) { onShow?.(value); open.clear(); draw(true); }
      });
      box.addEventListener("keydown", (e) => Menu.handle(box, e, { close: () => closeMenu(false), trigger: () => host.querySelector(".dgc-hub-show") }));
      const outside = (e) => { if (!box.contains(e.target) && !button.contains(e.target)) closeMenu(false); };
      const away = () => closeMenu(false);
      doc.addEventListener("pointerdown", outside, true);
      view.addEventListener("blur", away); view.addEventListener("resize", away);
      menu = { box, outside, away };
      box.tabIndex = -1;
      (keyboard ? box.querySelector('[aria-checked="true"]') || box.querySelector(".dgc-menu-row") : box).focus({ preventScroll: true });
    }

    host.addEventListener("click", (e) => {
      const t = e.target;
      if (t.closest(".dgc-hub-show")) { if (menu) closeMenu(true); else openMenu(e.detail === 0); return; }
      const act = t.closest("[data-hub-act]");
      if (act) { onAct?.(act.closest(".dgc-hub-card").dataset.key, act.dataset.hubAct); return; }
      if (t.closest(".dgc-hub-clear")) { const f = filter(); onClear?.(state.cards.filter((c) => c.group === "new" && (f === "all" || c.source === f)).map((c) => c.key), f); return; }
      const rest = t.closest(".dgc-hub-rest");
      if (rest) { open.add(rest.dataset.group); draw(true); host.querySelectorAll(`.dgc-hub-card[data-group="${rest.dataset.group}"]`)[FIRST]?.querySelector("[data-hub-act]")?.focus(); return; }
      if (t.closest(".dgc-hub-more")) { onMore?.(); return; }
      if (t.closest(".dgc-hub-all")) { onPips?.(); return; }
      if (t.closest(".dgc-hub-retry")) onRetry?.();
    });
    host.addEventListener("keydown", (e) => {
      // Down on Show opens its menu, as a menu button does.
      if (e.key === "ArrowDown" && e.target.closest?.(".dgc-hub-show")) { e.preventDefault(); openMenu(true); }
    });
    unwatch = Card.watch(host);
    // A wider or narrower side bar shows more or less of a line: what is answered here is measured again.
    let width = host.clientWidth, sized = null;
    if (view.ResizeObserver) {
      sized = new view.ResizeObserver(() => { const w = host.clientWidth; if (w === width) return; width = w; if (state.cards.some((c) => c.full !== undefined)) draw(true); });
      sized.observe(host);
    }
    draw(true);

    return {
      update(next) { state = { cards: Array.isArray(next?.cards) ? next.cards : [], more: Number(next?.more) || 0, partial: next?.partial === true, notes: Array.isArray(next?.notes) ? next.notes : [] }; draw(); },
      redraw() { draw(true); },
      counts, shown: filter, closeMenu,
      dispose() { closeMenu(); unwatch?.(); sized?.disconnect(); },
    };
  }

  root.DgcHub = Object.freeze({ create, SOURCES });
})();
