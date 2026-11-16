// Home, the first tab of DGC's side bar: everything that needs you or has news, each as one card of the same size
// (media/shared/card.js, its thin form), whether it comes from a Pip (its face) or a session (its blob), or is a thing
// made (the sheet of its kind, media/shared/filesheet.js). Two groups, "Needs you" and "New". Since Home became cards
// (13 Nov, media/shared/homecards.js) each group is drawn inside a card of Home: what needs you in the Needs you card,
// what is new at the top of Recent; one hub is made for each (`groups`). The Show filter went with that: the cards on
// Home are the filter. media/shared/hub.css is how it looks. The page gives the cards (media/main.js builds them from its sessions, chats and
// Pips) and answers what is chosen; this file draws, filters and keeps the keyboard where it was. A classic script,
// loaded before main.js: window.DgcHub.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcHub) return;
  // A card's answers are a row of icons that turn into the full button (media/shared/iconactions.js, asked 12 Nov):
  // loaded before this file. A held answer's one way back, Undo, is a plain word button.

  const SOURCES = [["all", "All"], ["work", "Work"], ["chat", "Chat"], ["personal", "Personal Pips"], ["project", "Project Pips"]];
  const GROUPS = [["needs", "Needs you"], ["new", "New"]];
  const FIRST = 8;                 // cards a group shows before "Show N more"

  /**
   * The hub in `host`.
   *   groups            which groups this hub draws (["needs"], ["new"]; both by default)
   *   first()           how many cards a group shows before "Show N more" (8 by default; fewer on a small card)
   *   onRest(group)     "Show N more" was chosen: true when the page shows the rest itself (it opens the card whole)
   *   empty             the line an empty hub says ("" for none)
   *   onViewAll()       given: a group's heading has "View all" while its card is not opened whole (always is on), and this opens it
   *   onAct(key, act)   a card's answer was chosen: act is an action's id ("open", "read", "dismiss" ...)
   *   onClear(keys)     Clear, beside "New": the cards it covers (what is shown)
   *   onMore()          "N more need you": where the rest are; onPips(): "More Pips may have news": your Pips
   *   onCount(total)    how many cards there are in all, whatever is shown (the Home tab's number)
   *   onDraw(host)      after a redraw: the page starts its faces and blobs moving
   * update({ cards, more, partial, notes }) draws.
   *   cards: [{ key, source, group: "needs" | "new", who: { html }, from, title, chips, actions: [{ id, label, primary?, title? }], label }]
   *          (fromShort: [shorter ways to say `from`, the longest first]: the line is never cut mid-word where one of
   *          them fits. A way that ends in a name is { text, lead }: its `lead` and a little of the name must fit; the
   *          name itself may be cut, as names are.)
   *     A card answered where it is also has `full` (the one line it must show whole to be answered here; `mono` for a
   *     command), `more` (a quiet third answer, the way to all of it) and `fallback` (its answers when that line or its
   *     sentence does not fit: it opens instead, with its chips as before).
   *     Chips show only for what the sentence and the source line do not say, and only on a line the sentence leaves free.
   *   more: how many more need you than the cards show; partial: more Pips may have news than DGC named; notes: [{ text, retry? }] lines that say what went wrong
   */
  function create({ host, groups, first, always: alwaysHead = false, onRest, onViewAll, empty: emptyLine = "Nothing needs you. New things arrive here.", onAct, onClear, onMore, onPips, onRetry, onCount, onDraw } = {}) {
    const doc = host.ownerDocument, view = doc.defaultView, Card = root.DgcCard, Menu = root.DgcMenu, Icons = root.DgcIconActions;
    const esc = Card.esc;
    let state = { cards: [], more: 0, partial: false, notes: [] }, drawn = "", unwatch = null;
    // (Which groups, whether an empty one keeps its heading, and the empty line may each follow the card's form: a function.)
    const said = (value) => (typeof value === "function" ? value() : value);
    const mineNow = () => { const g = said(groups); return GROUPS.filter(([group]) => !Array.isArray(g) || g.includes(group)); };
    let mine = mineNow();
    const most = () => { const n = typeof first === "function" ? Number(first()) : NaN; return Number.isFinite(n) && n > 0 ? Math.floor(n) : FIRST; };
    const open = new Set();          // groups shown in full
    let cuts = new Set();            // cards whose line does not show whole here: they open instead
    const filter = () => "all";
    const counts = () => { const n = { all: state.cards.length, work: 0, chat: 0, personal: 0, project: 0 }; for (const c of state.cards) if (n[c.source] !== undefined) n[c.source]++; return n; };

    function cardHtml(c) {
      const here = c.full !== undefined && !cuts.has(c.key);        // answered on the card
      const answers = [...((c.full !== undefined && !here ? c.fallback : c.actions) || []).filter(Boolean).slice(0, 2), here && c.more ? { ...c.more, primary: false } : null].filter(Boolean);
      // The answers as icons; a held answer's Undo, alone and against the clock, as a word.
      const icons = !c.held && Icons ? Icons.html(answers.map((a) => ({ label: a.label, primary: !!a.primary, title: a.title, say: a.say, attrs: { "data-hub-act": a.id } })), { label: "Answers" }) : "";
      // A chip is shown only for what the card's own words do not already say.
      const said = `${c.title} · ${c.from}`.toLowerCase(), word = (chip) => String((chip && typeof chip === "object" ? chip.label : chip) ?? "").trim();
      const chips = here ? [] : (c.chips || []).filter((chip) => word(chip) && !said.includes(word(chip).toLowerCase()));
      return Card.html({ id: `hub-${c.key}`, cls: `dgc-card-thin dgc-hub-card${here ? " dgc-hub-answers" : ""}${here && c.mono ? " dgc-hub-mono" : ""}${c.held ? " dgc-hub-held" : ""}`,
        label: `${c.label || `${c.from}: ${c.title}`}${here ? `: ${c.full}` : chips.length ? `. ${chips.map(word).join(", ")}` : ""}`,
        attrs: { "data-key": c.key, "data-source": c.source, "data-group": c.group, ...(Array.isArray(c.fromShort) && c.fromShort.length ? { "data-from": JSON.stringify([c.from, ...c.fromShort.slice(0, 4)]) } : {}) },
        icon: { html: c.who?.html || "", face: true }, title: c.title, sub: c.from, chips, note: here ? c.full : undefined,
        actionsHtml: icons,
        actions: icons ? [] : answers.map((a) => ({ label: a.label, primary: !!a.primary, title: a.title, attrs: { "data-hub-act": a.id, ...(a.say ? { "aria-label": a.say } : {}) } })) });
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

    /** A slim card has one line to spare under a one-line sentence: its chips show there and nowhere else, so they never
        add a row. Words that are cut where they are drawn say themselves whole when pointed at. */
    function tidy() {
      for (const card of host.querySelectorAll(".dgc-hub-card")) {
        const title = card.querySelector(".dgc-card-title"), sub = card.querySelector(".dgc-card-sub");
        if (!title || !title.clientWidth) continue;       // not laid out (another tab is shown)
        if (card.querySelector(".dgc-card-chips")) card.classList.toggle("dgc-hub-nochips", title.scrollHeight > parseFloat(view.getComputedStyle(title).lineHeight) * 1.5);
        // The quiet line over the sentence says as much as fits whole: "Spreadsheet changed · version 2 · Budget", then
        // without its version, then "Spreadsheet changed" (H2, user test 15 Nov: "Dashboard made · v…"). The whole line
        // is what a pointer reads.
        if (sub && card.dataset.from) {
          let ways = []; try { ways = JSON.parse(card.dataset.from); } catch { ways = []; }
          // (Measured as drawn: a line half a pixel too long is cut, and scrollWidth, a whole number, doesn't say so.)
          const fits = () => { const range = doc.createRange(); range.selectNodeContents(sub); return range.getBoundingClientRect().width <= sub.getBoundingClientRect().width + 0.25; };
          for (const way of ways) {
            if (typeof way === "string") { sub.textContent = way; if (fits()) break; continue; }
            sub.textContent = `${way.lead}${String(way.text).slice(way.lead.length, way.lead.length + 8)}…`;
            if (fits()) { sub.textContent = way.text; break; }
          }
          if (ways.length && sub.textContent !== ways[0]) sub.dataset.whole = ways[0]; else delete sub.dataset.whole;
        }
        for (const n of [title, sub]) { if (!n) continue; if (n.dataset.whole) n.title = n.dataset.whole; else if (n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1) n.title = n.textContent; else n.removeAttribute("title"); }
      }
      Card.fit(host);
    }

    function draw(force = false) {
      const f = filter(), n = counts(), always = said(alwaysHead) === true, empty = said(emptyLine);
      mine = mineNow();
      const shown = state.cards.filter((c) => mine.some(([group]) => group === c.group));
      const next = JSON.stringify([most(), mine, always, empty, state, [...open]]);
      onCount?.(n.all);
      if (next === drawn && !force) return;
      drawn = next;
      // The keyboard stays where it was: the same card's same answer, or the card that took its place, or Show.
      const active = host.contains(doc.activeElement) ? doc.activeElement : null, heldCard = active?.closest?.(".dgc-hub-card");
      const held = active ? { key: heldCard?.dataset.key || "", act: active.dataset?.hubAct || "", group: heldCard?.dataset.group || "",
        at: heldCard ? [...host.querySelectorAll(`.dgc-hub-card[data-group="${heldCard.dataset.group}"]`)].indexOf(heldCard) : -1, cls: active.className } : null;
      const render = () => {
      let html = "";
      for (const note of state.notes || []) html += `<p class="dgc-hub-note" role="status">${esc(note.text)}${note.retry ? ` <button type="button" class="dgc-hub-link dgc-hub-retry" title="Ask DGC again">Retry</button>` : ""}</p>`;
      for (const [group, name] of mine) {
        const all = shown.filter((c) => c.group === group);
        const more = group === "needs" ? Number(state.more) || 0 : 0, FIRST = most();
        if (!all.length && !more && !always) continue;
        const cut = open.has(group) || all.length <= FIRST ? all : all.slice(0, FIRST);
        html += `<section class="dgc-hub-group" data-group="${group}" aria-labelledby="dgc-hub-h-${group}"><div class="dgc-hub-head"><h2 id="dgc-hub-h-${group}">${name}<span class="dgc-hub-n"${all.length + more ? "" : " hidden"}>${all.length + more}</span></h2>`
          + (group === "new" && all.length ? `<button type="button" class="dgc-hub-link dgc-hub-clear" title="Clear what is new here. What needs you stays.">Clear</button>` : "")
          + (always && onViewAll && all.length ? `<button type="button" class="dgc-hub-link dgc-hub-viewall" title="Open all of it">View all</button>` : "") + `</div>`
          + (!all.length && !more && empty ? `<p class="dgc-hub-empty">${esc(empty)}</p>` : "")
          + `<div class="dgc-hub-cards">${cut.map(cardHtml).join("")}</div>`
          + (cut.length < all.length ? `<button type="button" class="dgc-hub-link dgc-hub-rest" data-group="${group}" title="Show the rest of these here">Show ${all.length - cut.length} more</button>` : "")
          + (more ? `<button type="button" class="dgc-hub-link dgc-hub-more" title="Open Needs attention in Pips">${more} more ${more === 1 ? "needs" : "need"} you · Open in Pips</button>` : "")
          + (group === "new" && state.partial ? `<button type="button" class="dgc-hub-link dgc-hub-all" title="Open your Pips">More Pips may have news · Open Pips</button>` : "")
          + `</section>`;
      }
      if (!always && !shown.length && !(state.more && mine.some(([group]) => group === "needs")) && empty) html += `<p class="dgc-hub-empty">${esc(empty)}</p>`;
      host.innerHTML = html;
      };
      // A card is answered here only where it shows its line whole: drawn so first, then any that is cut opens instead.
      cuts = new Set();
      render();
      const cut = cutNow();
      if (cut.length) { cuts = new Set(cut); render(); }
      tidy();
      onDraw?.(host);
      Icons?.refresh(host);        // an answer the pointer or the keyboard is still on shows its pill again
      if (held) {
        const cards = [...host.querySelectorAll(".dgc-hub-card")];
        const same = cards.find((c) => c.dataset.key === held.key);
        const group = cards.filter((c) => c.dataset.group === held.group), near = held.at >= 0 ? group[Math.min(held.at, group.length - 1)] || cards[0] : null;
        const target = held.key ? (same?.querySelector(`[data-hub-act="${held.act}"]`) || same?.querySelector("[data-hub-act]") || near?.querySelector(`[data-hub-act="${held.act}"]`) || near?.querySelector("[data-hub-act]"))
          : (held.cls && held.cls.split(" ").some((c) => c.startsWith("dgc-hub-")) ? host.querySelector(`.${held.cls.split(" ").filter((c) => c.startsWith("dgc-hub-")).join(".")}`) : null);
        // (With nothing of the hub left to hold it, the keyboard goes to Home's own button, never to the page's top.)
        (target || host.querySelector("[data-hub-act]") || doc.querySelector("#home-hub .hc-cards-btn"))?.focus({ preventScroll: true });
      }
    }

    host.addEventListener("click", (e) => {
      const t = e.target;
      const act = t.closest("[data-hub-act]");
      if (act) { onAct?.(act.closest(".dgc-hub-card").dataset.key, act.dataset.hubAct); return; }
      if (t.closest(".dgc-hub-clear")) { onClear?.(state.cards.filter((c) => c.group === "new").map((c) => c.key), "all"); return; }
      const rest = t.closest(".dgc-hub-rest");
      if (rest) { if (onRest?.(rest.dataset.group) === true) return; const at = most(); open.add(rest.dataset.group); draw(true); host.querySelectorAll(`.dgc-hub-card[data-group="${rest.dataset.group}"]`)[at]?.querySelector("[data-hub-act]")?.focus(); return; }
      if (t.closest(".dgc-hub-viewall")) { onViewAll?.(); return; }
      if (t.closest(".dgc-hub-more")) { onMore?.(); return; }
      if (t.closest(".dgc-hub-all")) { onPips?.(); return; }
      if (t.closest(".dgc-hub-retry")) onRetry?.();
    });
    unwatch = Card.watch(host);
    const unwatchIcons = Icons ? Icons.watch(host) : null;
    // A wider or narrower side bar shows more or less of a line: what is answered here is measured again.
    let width = host.clientWidth, sized = null;
    if (view.ResizeObserver) {
      sized = new view.ResizeObserver(() => { const w = host.clientWidth; if (w === width) return; width = w; if (state.cards.some((c) => c.full !== undefined)) draw(true); else tidy(); });
      sized.observe(host);
    }
    draw(true);

    return {
      update(next) { state = { cards: Array.isArray(next?.cards) ? next.cards : [], more: Number(next?.more) || 0, partial: next?.partial === true, notes: Array.isArray(next?.notes) ? next.notes : [] }; draw(); },
      redraw() { draw(true); },
      counts, shown: filter, closeMenu() {},
      dispose() { unwatch?.(); unwatchIcons?.(); sized?.disconnect(); },
    };
  }

  root.DgcHub = Object.freeze({ create, SOURCES });
})();
