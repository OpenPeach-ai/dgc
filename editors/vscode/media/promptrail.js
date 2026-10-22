// window.DgcPromptRail: the prompt rail (ChatGPT's "table of contents", the founder approved 2026-10-18), the same in
// ChatDGC (chatdgc.js) and the Work chat (main.js). From five prompts, a short tick per prompt in the transcript's
// right margin, centred, the one being read bright. Hovering it (or Tab to it) opens a card of every prompt with its
// time under day headings, and the widget a reply made; a click goes there and outlines it. Alt+Up and Alt+Down step
// between prompts, from anywhere in the page, the message box included. Ticks close up to 4px apart for a long chat,
// then show a window around where you are. It lists every prompt even when only the latest pages are on screen (the
// page's outline), and going to one not on screen loads the pages before it first: ChatGPT's rail broke exactly there.
//
// The page owns its transcript, so it says what the rail needs to know (DgcPromptRail.create(options)):
//   id         the rail's element id; its card's is `${id}-card`
//   scroller   the element the transcript scrolls in
//   visible()  whether a chat is on screen at all (no rail over a welcome page or another view)
//   prompts()  every prompt, oldest first: {id, text, at (ms since 1970, or NaN), loaded (on screen),
//              widgets?: [{title, removed?}], heading? (said above it in the card instead of its day)};
//              ids are stable while the prompt is in the chat
//   top(p)     where a loaded prompt's own place is now (a client y), or null
//   landing()  where a prompt gone to lands (a client y): Alt+Up from below it goes to its own prompt first
//   go(p, then) bring prompt p on screen (loading the pages before it if it needs to), then call then()
//   show(p)    the view moved to p and p outlined for a moment; false when it isn't there
//   more(list) null, or {label, run} when the pages before what's on screen can't be listed yet
//   announce(text), input (the message box: Alt+Up/Down work in it too)
// and calls refresh() when the prompts may have changed. It returns {refresh, track, close, step, rail, card}.
(function () {
  "use strict";
  if (window.DgcPromptRail) return;
  const FROM = 5;
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const glyph = (name) => { const g = el("span", `codicon codicon-${name}`); g.setAttribute("aria-hidden", "true"); return g; };
  const clock = (at) => (Number.isFinite(at) ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");
  function dayOf(at) {
    if (!Number.isFinite(at)) return "";
    const d = new Date(at), now = new Date();
    const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
    if (days === 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days > 1 && days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
    return d.toLocaleDateString(undefined, { day: "numeric", month: "long", ...(d.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
  }

  function create(o) {
    const scroller = o.scroller;
    const rail = el("button", "prompt-rail");
    rail.type = "button"; rail.id = o.id; rail.hidden = true;
    rail.setAttribute("aria-haspopup", "dialog"); rail.setAttribute("aria-expanded", "false");
    rail.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    rail.setAttribute("aria-label", "Prompts in this chat");
    const ticks = el("span", "prompt-rail-ticks");
    ticks.setAttribute("aria-hidden", "true");
    rail.append(ticks);
    const card = el("div", "prompt-rail-card");
    card.id = `${o.id}-card`; card.hidden = true;
    card.setAttribute("role", "dialog"); card.setAttribute("aria-label", "Prompts in this chat");
    document.body.append(rail, card);
    let list = [], key = "", current = -1, timer = 0, quiet = false;
    const widgetsOf = (p) => (Array.isArray(p.widgets) ? p.widgets : []);

    /** The prompts, as the page says them; the ticks drawn again only when they change (a reply streaming doesn't). */
    function refresh() {
      list = o.visible() ? o.prompts() : [];
      const now = list.map((p) => `${p.id}:${p.loaded ? 1 : 0}:${widgetsOf(p).map((w) => w.title + (w.removed ? "-" : "")).join("|")}`).join(",");
      rail.hidden = list.length < FROM;
      if (rail.hidden) { close(false); key = ""; return; }
      if (now !== key) {
        key = now; current = -1;
        ticks.replaceChildren(...list.map(() => el("span", "prompt-tick")));
        rail.setAttribute("aria-label", `Prompts in this chat: ${list.length}. Alt+Up and Alt+Down go to the one before or after`);
        if (!card.hidden) fill();
      }
      track();
    }
    /** Which prompt is being read: the last one whose own place is above a line a third of the way down the view. */
    function track() {
      if (rail.hidden) return;
      const box = scroller.getBoundingClientRect(), line = box.top + box.height / 3;
      let now = -1, firstLoaded = -1;
      list.forEach((p, i) => {
        if (!p.loaded) return;
        if (firstLoaded < 0) firstLoaded = i;
        const top = o.top(p);
        if (top !== null && top <= line) now = i;
      });
      if (now < 0) now = firstLoaded > 0 ? firstLoaded - 1 : 0;      // reading a reply to a prompt on an earlier page
      if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
        // At the end: the last prompt in view, though it never reached the line.
        for (let i = list.length - 1; i > now; i--) {
          const top = list[i].loaded ? o.top(list[i]) : null;
          if (top !== null && top < box.bottom) { now = i; break; }
        }
      }
      if (now !== current) {
        current = now;
        [...ticks.children].forEach((t, i) => t.classList.toggle("now", i === now));
        for (const row of card.querySelectorAll(".prompt-rail-row")) {
          const is = Number(row.dataset.i) === now;
          row.classList.toggle("now", is);
          if (is) row.setAttribute("aria-current", "true"); else row.removeAttribute("aria-current");
        }
      }
      place();
    }
    function place() {
      const box = scroller.getBoundingClientRect(), n = list.length;
      const most = Math.max(60, box.height * 0.5);
      const pitch = Math.max(4, Math.min(10, most / Math.max(1, n)));        // 10px apart, closing up to 4px; then a window
      const full = n * pitch, shown = Math.min(full, most);
      ticks.style.setProperty("--pitch", `${pitch}px`);
      ticks.style.height = `${shown}px`;
      ticks.classList.toggle("windowed", full > most);
      ticks.scrollTop = Math.max(0, current * pitch - shown / 2);
      const gutter = scroller.offsetWidth - scroller.clientWidth;           // its scrollbar: the rail stays left of it
      rail.style.right = `${Math.max(0, window.innerWidth - box.right + gutter + 2)}px`;
      rail.style.top = `${Math.round(box.top + box.height / 2 - (shown + 16) / 2)}px`;
      if (!card.hidden) placeCard();
    }
    function placeCard() {
      const r = rail.getBoundingClientRect(), box = scroller.getBoundingClientRect();
      card.style.right = `${Math.max(8, window.innerWidth - r.right + 2)}px`;
      card.style.width = `${Math.min(340, window.innerWidth - 48)}px`;
      card.style.maxHeight = `${Math.max(120, Math.min(520, box.height - 16))}px`;
      const height = card.offsetHeight, mid = r.top + r.height / 2;
      card.style.top = `${Math.round(Math.max(box.top + 8, Math.min(box.bottom - height - 8, mid - height / 2)))}px`;
    }
    function fill() {
      const head = el("div", "prompt-rail-head");
      const keys = el("span", "prompt-rail-keys");
      keys.append(el("kbd", "", "Alt"), "+", el("kbd", "", "↑"), " ", el("kbd", "", "↓"), " step");
      head.append(el("span", "", `${list.length} prompts`), keys);
      const rows = el("div", "prompt-rail-list");
      const more = o.more?.(list);
      if (more) {
        // An older CLI: the prompts before what's on screen can't be listed until they're loaded.
        const button = el("button", "prompt-rail-more", more.label);
        button.type = "button";
        button.addEventListener("click", () => { close(false); more.run(); });
        rows.append(button);
      }
      let day = null;
      list.forEach((p, i) => {
        const at = p.at, d = p.heading || dayOf(at);
        if (d && d !== day) { day = d; rows.append(el("div", "prompt-rail-day", d)); }
        const row = el("button", `prompt-rail-row${i === current ? " now" : ""}`);
        row.type = "button"; row.dataset.i = String(i);
        row.title = p.text;
        row.append(el("span", "prompt-rail-text", p.text || "(empty)"));
        const made = widgetsOf(p).filter((w) => !w.removed);
        if (made.length) {
          const mark = el("span", "prompt-rail-widget");
          mark.append(glyph("play-circle"), el("span", "", made[0].title + (made.length > 1 ? ` +${made.length - 1}` : "")));
          row.append(mark);
        }
        row.append(el("span", "prompt-rail-time", clock(at)));
        row.setAttribute("aria-label", `${p.text || "Prompt"}${made.length ? `, made ${made.map((w) => w.title).join(", ")}` : ""}${Number.isFinite(at) ? `, ${dayOf(at)} ${clock(at)}` : ""}`);
        if (i === current) row.setAttribute("aria-current", "true");
        row.addEventListener("click", () => { close(false); goTo(i); });
        rows.append(row);
      });
      card.replaceChildren(head, rows);
    }
    function open() {
      clearTimeout(timer);
      if (!card.hidden || rail.hidden) return;
      fill();
      card.hidden = false;
      rail.setAttribute("aria-expanded", "true");
      placeCard();
      const now = card.querySelector(".prompt-rail-row.now"), rows = card.querySelector(".prompt-rail-list");
      if (now && rows) rows.scrollTop = now.offsetTop - rows.clientHeight / 2 + now.offsetHeight / 2;
    }
    function close(focusRail) {
      clearTimeout(timer);
      if (card.hidden) return;
      card.hidden = true;
      rail.setAttribute("aria-expanded", "false");
      if (focusRail && !rail.hidden) { quiet = true; rail.focus(); quiet = false; }     // back on the rail, closed
    }
    const rowsNow = () => [...card.querySelectorAll(".prompt-rail-row, .prompt-rail-more")];
    function focusRow(at) {
      const rows = rowsNow();
      if (!rows.length) return;
      rows[Math.max(0, Math.min(rows.length - 1, at))].focus();
    }
    const leaveSoon = () => { clearTimeout(timer); timer = setTimeout(() => { if (!card.contains(document.activeElement) && document.activeElement !== rail) close(false); }, 180); };
    rail.addEventListener("mouseenter", open);
    rail.addEventListener("mouseleave", leaveSoon);
    card.addEventListener("mouseenter", () => clearTimeout(timer));
    card.addEventListener("mouseleave", leaveSoon);
    rail.addEventListener("focus", () => { if (!quiet && rail.matches(":focus-visible")) open(); });
    rail.addEventListener("click", () => { open(); focusRow(rowsNow().findIndex((r) => r.classList.contains("now"))); });
    document.addEventListener("click", (e) => { if (!card.hidden && !e.composedPath().some((n) => n === card || n === rail)) close(false); });
    rail.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault(); open();
        focusRow(rowsNow().findIndex((r) => r.classList.contains("now")));
      } else if (e.key === "Escape" && !card.hidden) { e.preventDefault(); e.stopPropagation(); close(true); }
    });
    rail.addEventListener("blur", leaveSoon);
    card.addEventListener("focusout", (e) => { if (!card.contains(e.relatedTarget) && e.relatedTarget !== rail) leaveSoon(); });
    card.addEventListener("keydown", (e) => {
      const rows = rowsNow(), at = rows.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); focusRow(at + (e.key === "ArrowDown" ? 1 : -1)); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); focusRow(e.key === "Home" ? 0 : rows.length - 1); }
      else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    });
    /** To prompt i: loaded first if it's on an earlier page, then near the top of the view, outlined for a moment. */
    let aim = { i: -1, until: 0 };          // where a jump is going: a quick second Alt+Up steps on from there
    function goTo(i) {
      const p = list[i];
      if (!p) return;
      aim = { i, until: performance.now() + 600 };
      o.go(p, () => {
        // The pages it loaded may have told the rail more: the prompt is found again by its id.
        refresh();
        const at = list.findIndex((q) => q.id === p.id);
        if (at < 0) return;
        aim = { i: at, until: performance.now() + 600 };
        if (o.show(list[at]) !== false) o.announce?.(`Prompt ${at + 1} of ${list.length}: ${list[at].text}`);
      });
    }
    /** Alt+Up: the prompt above what you're reading (its own, when you're down in its reply); Alt+Down: the next. */
    function step(down) {
      if (rail.hidden || !list.length) return false;
      const from = performance.now() < aim.until ? aim.i : current;
      let to;
      if (down) to = from + 1;
      else {
        const top = list[from]?.loaded ? o.top(list[from]) : null;
        to = top !== null && top < o.landing() - 8 ? from : from - 1;
      }
      to = Math.max(0, Math.min(list.length - 1, to));
      goTo(to);
      return true;
    }
    let frame = 0;
    scroller.addEventListener("scroll", () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; track(); }); }, { passive: true });
    window.addEventListener("resize", () => { if (!rail.hidden) place(); });
    // The transcript's own size changes too: the message box growing, another view taking its place.
    if (typeof ResizeObserver === "function") {
      let sized = 0;
      new ResizeObserver(() => { if (!sized) sized = requestAnimationFrame(() => { sized = 0; refresh(); }); }).observe(scroller);
    }
    document.addEventListener("keydown", (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
      // Everywhere but a field of a card or an edit being typed in (the message box itself takes them too).
      const t = e.target;
      if (t instanceof HTMLElement && t !== o.input && !o.input?.contains?.(t) && t.closest("input, textarea, select, [contenteditable='true']")) return;
      if (step(e.key === "ArrowDown")) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    return { refresh, track, close, step, rail, card };
  }

  window.DgcPromptRail = { create, FROM };
})();
