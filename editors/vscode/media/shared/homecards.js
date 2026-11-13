// Home as cards (asked 13 Nov: "nice looking cards which users can add on the Home Screen, something like widgets users
// add on iPhone screens ... bento cards, which users can rearrange"). Home is one scrolling page of cards in a grid. The
// user chooses which cards and their order; the side bar's WIDTH chooses each card's form ("user just selects the card,
// not the size"): under about 380 px every card is Small (a square, two to a row); to about 620 px Medium (a card two
// squares wide, as tall as it needs); wider, Large where a card has one (a 2×2 block), else Medium, packed densely.
// Dragging the side bar's edge glides the cards to their new places, and a card keeps what was chosen on it (a tab, an
// inked day) across the change. A Small card opens to its full form over Home (Back or Escape returns), so everything a
// card does is reachable in a narrow side bar.
//
// Home's top right has one button, Cards (the Ember mosaic, still until pointed at): it opens the card library in a
// pop-up, every card with a small live preview, its name and one line (no icon of its own: the mosaic is the Cards
// button's and the pop-up's title's only), and Add (or On Home, with Remove); at its foot
// Arrange Home (each card shows × and can be dragged; by keyboard Space lifts, the arrows move, Space drops) and Reset
// Home. The host keeps the layout for this computer (src/homeCards.ts); this file never touches a network.
//
// The page (media/main.js) gives the data each card shows (`data()`), answers what is chosen (`act`), and lends the two
// hubs of media/shared/hub.js: what needs you, drawn inside the Needs you card (a few on the card, all of it opened), and
// what is new, drawn in Recent opened, each card with its own answers. What is new is in one place only: Recent.
// media/shared/homecards.css is how it looks. A classic script, loaded before main.js: window.DgcHomeCards.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcHomeCards) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const DEFAULT = ["needs", "recent", "running", "token", "quick"];
  // Every card: its name, its one line in the library, the group it is listed under, whether it has a Large form.
  const CARDS = {
    needs: { name: "Needs you", line: "What waits for you: approvals, questions, Pip cards", group: "Now" },
    running: { name: "Running now", line: "Sessions, goals and chats at work", group: "Now" },
    recent: { name: "Recent", line: "Work, chats and Pips together, what is new first", group: "Lists", large: true },
    work: { name: "Work sessions", line: "This list’s sessions, running ones marked", group: "Lists" },
    chats: { name: "Chats", line: "Your chats, newest first", group: "Lists" },
    pips: { name: "Pips", line: "Core first, then the others and what waits", group: "Lists" },
    token: { name: "Token usage", line: "Tokens, requests and cache, day by day", group: "Usage and start", large: true },
    quick: { name: "Quick start", line: "New session, chat or Pip", group: "Usage and start" },
    folders: { name: "Folders", line: "Your Work folders, each a tile", group: "Usage and start", large: true },
    clock: { name: "Clock", line: "The time here, and in a second city", group: "Everyday" },
    weather: { name: "Weather", line: "Now and the next hours, for a city you type", group: "Everyday" },
    note: { name: "Note", line: "A sticky note, kept on this computer", group: "Everyday" },
  };
  const TYPES = Object.keys(CARDS);
  const ZONES = [["America/Los_Angeles", "Los Angeles"], ["America/Denver", "Denver"], ["America/Chicago", "Chicago"], ["America/New_York", "New York"], ["America/Sao_Paulo", "São Paulo"],
    ["Europe/London", "London"], ["Europe/Paris", "Paris"], ["Europe/Berlin", "Berlin"], ["Africa/Lagos", "Lagos"], ["Africa/Johannesburg", "Johannesburg"], ["Europe/Istanbul", "Istanbul"],
    ["Asia/Dubai", "Dubai"], ["Asia/Kolkata", "Delhi"], ["Asia/Singapore", "Singapore"], ["Asia/Shanghai", "Shanghai"], ["Asia/Tokyo", "Tokyo"], ["Australia/Sydney", "Sydney"], ["Pacific/Auckland", "Auckland"]];
  const mosaic = (palette, size, more = "") => `<span class="mosaic mosaic--${esc(palette)}" style="--size:${size}px${more}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
  const svg = (d, size = 12, w = 2.2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const PLUS = svg('<path d="M12 5v14M5 12h14"/>', 11, 2.6), CROSS = svg('<path d="M6 6l12 12M18 6L6 18"/>', 10, 2.8), BACK = svg('<path d="M15 18l-6-6 6-6"/>', 12, 2.4), TICK = svg('<path d="M5 12l5 5L20 7"/>', 11, 3);
  const GRIP = '<svg class="hc-grip" width="12" height="16" viewBox="0 0 12 16" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="9" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="9" cy="13" r="1.4"/></g></svg>';
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + "s"}`;

  // ---- numbers and days ------------------------------------------------------------------------------------------------
  const pad = (v) => String(v).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayOf = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(y, m - 1, d); };
  const compact = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(n < 1e10 ? 2 : 1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(n < 1e7 ? 2 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n < 1e4 ? 1 : 0)}K` : String(Math.round(n)));
  const DAY = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }), SHORT = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" });
  /** A scale's top: the next round number at or over `max` (1, 1.5, 2, 2.5, 3, 4, 5, 6, 8 × a power of ten). */
  function nice(max) {
    if (!(max > 0)) return 1;
    const p = 10 ** Math.floor(Math.log10(max)), m = max / p;
    return (([1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((s) => s >= m - 1e-9)) || 10) * p;
  }
  const METRICS = {
    tokens: { name: "Tokens", unit: "tokens", of: (d) => d.input + d.output, total: (ds) => ds.reduce((a, d) => a + d.input + d.output, 0), say: compact,
      icon: '<path d="M4 18l5-6 4 3 7-9"/>' },
    requests: { name: "Requests", unit: "requests", of: (d) => d.requests, total: (ds) => ds.reduce((a, d) => a + d.requests, 0), say: (n) => Math.round(n).toLocaleString("en-US"),
      icon: '<path d="M4 7h16M4 12h10M4 17h6"/>' },
    // Cache saved: of what was sent, the share that came from the cache.
    cache: { name: "Cache saved", unit: "from the cache", of: (d) => (d.input ? (d.cached / d.input) * 100 : 0), total: (ds) => { const sent = ds.reduce((a, d) => a + d.input, 0); return sent ? (ds.reduce((a, d) => a + d.cached, 0) / sent) * 100 : 0; },
      say: (n) => `${Math.round(n)}%`, share: true, icon: '<path d="M12 3v18M5 8l7-5 7 5M5 16l7 5 7-5"/>' },
  };
  // The weather's conditions as a small drawing (WMO weather codes, as Open-Meteo gives them), and in a word.
  function wx(code, day = true, size = 22) {
    const c = Number(code) || 0, sun = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>';
    const moon = '<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>', cloud = '<path d="M7 18.5h10a4 4 0 0 0 .6-7.95A5.5 5.5 0 0 0 7 11.2 3.7 3.7 0 0 0 7 18.5z"/>';
    const low = '<path d="M7 15.5h10a3.6 3.6 0 0 0 .5-7.2A5 5 0 0 0 7.9 9 3.3 3.3 0 0 0 7 15.5z"/>';
    const d = c === 0 ? (day ? sun : moon) : c <= 2 ? `${day ? '<circle cx="8" cy="8" r="3"/><path d="M8 2.2v1.3M2.2 8h1.3M3.9 3.9l.9.9M12.1 3.9l-.9.9"/>' : '<path d="M10 3.2a4.2 4.2 0 1 0 3.6 6.3A4.6 4.6 0 0 1 10 3.200z"/>'}<path d="M9 19.5h8.500a3.500 3.500 0 0 0 .5-7 4.800 4.800 0 0 0-9.200.9A3.100 3.100 0 0 0 9 19.500z"/>`
      : c === 3 ? cloud : c === 45 || c === 48 ? `${low}<path d="M5 19h14M7 22h10"/>`
      : c >= 95 ? `${low}<path d="M12.500 16.500l-2 3h3l-2 3"/>` : (c >= 71 && c <= 77) || c === 85 || c === 86 ? `${low}<path d="M8 19.500h.01M12 19.500h.01M16 19.500h.01M10 22.500h.01M14 22.500h.01"/>`
      : `${low}<path d="M8.500 18.500l-1 3M12.500 18.500l-1 3M16.500 18.500l-1 3"/>`;
    return `<svg class="hc-wx" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  }
  const wxWord = (code) => { const c = Number(code) || 0; return c === 0 ? "Clear" : c <= 2 ? "Partly cloudy" : c === 3 ? "Cloudy" : c === 45 || c === 48 ? "Fog" : c >= 95 ? "Thunderstorm" : (c >= 71 && c <= 77) || c === 85 || c === 86 ? "Snow" : c >= 51 && c <= 57 ? "Drizzle" : "Rain"; };

  /**
   * Home in `host`.
   *   data()             what the cards show now, from the page's own lists (see media/main.js, homeData)
   *   act(what, ...a)    something chosen: "open" key · "new" kind · "clear" · "tab" name · "folder" path · "here" path · "retry"
   *   post(message)      to the host: homeCardsReady / homeCardsSet / homeCardsReset / homeCardSetting / homeUsageGet / homeWeatherGet
   *   slot(name)         the hub's own element for "needs" or "new"; slotted(name, form) tells the page it was placed
   *   kept() / keep(v)   the page's kept state for Home (which card is open)
   *   onDraw(node)       after a draw: the page starts the faces in `node`
   * layout(state), usage(report) and weather(said) take the host's messages; update() draws again from data().
   */
  function create({ host, data, act, post, slot, slotted, kept, keep, onDraw } = {}) {
    const doc = host.ownerDocument, view = doc.defaultView;
    const still = () => !!view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let layout = { order: [...DEFAULT], settings: {} }, heard = false;
    let usage = null, usageAt = 0, weather = null, weatherAt = 0, weatherAsked = 0;
    const ui = { open: TYPES.includes(kept?.()?.open) ? kept().open : "", arranging: false, lifted: "", token: { metric: "tokens", hot: "", range: "30d" }, weatherEdit: false };
    let filling = false, library = null, libraryAdding = "", pending = 0, drag = null, liftedFrom = null, noteTimer = 0, focusNext = "";
    host.classList.add("dgc-home");
    host.innerHTML = '<div class="hc-head"></div><div class="hc-notes"></div><div class="hc-grid" data-form="s"></div><div class="hc-open" hidden></div><div class="hc-pantry" hidden></div><p class="hc-live" role="status" aria-live="polite"></p>';
    // (The hubs' own elements wait here, drawn and out of sight, until a card that shows them takes them.)
    for (const name of ["needs", "new"]) { const node = slot?.(name); if (node) host.querySelector(".hc-pantry").append(node); }
    const head = host.querySelector(".hc-head"), notes = host.querySelector(".hc-notes"), grid = host.querySelector(".hc-grid"), opened = host.querySelector(".hc-open"), pantry = host.querySelector(".hc-pantry"), live = host.querySelector(".hc-live");
    const say = (text) => { live.textContent = text; };
    const keepOrder = (order) => { layout = { ...layout, order }; post?.({ type: "homeCardsSet", order }); };
    const setting = (card, change) => { layout = { ...layout, settings: { ...layout.settings, [card]: { ...(layout.settings?.[card] || {}), ...change } } }; post?.({ type: "homeCardSetting", card, settings: change }); };

    // ---- the form the width picks -------------------------------------------------------------------------------------
    const widthNow = () => host.clientWidth || view.innerWidth;
    const gridForm = (w = widthNow()) => (w < 380 ? "s" : w < 620 ? "m" : "l");
    const formOf = (id, g) => (g === "l" ? (CARDS[id].large ? "l" : "m") : g);

    // ---- what each card draws -----------------------------------------------------------------------------------------
    const li = (r, more = "") => `<button type="button" class="hc-li${r.fresh ? " hc-new" : ""}" data-open="${esc(r.key)}" title="${esc(r.title || `Open ${r.name}`)}"><span class="hc-ico">${r.icon || ""}</span><span class="hc-tx"><span class="hc-nm">${esc(r.name)}${r.star ? ' <span class="hc-star" title="Core, your main Pip">★</span>' : ""}</span>${r.meta ? `<span class="hc-meta">${esc(r.meta)}</span>` : ""}</span>${more || (r.fresh ? '<span class="hc-newmark">New</span>' : r.live ? '<span class="hc-livedot" title="Running"></span>' : r.count ? `<span class="hc-cnt">${r.count}</span>` : r.age ? `<span class="hc-age">${esc(r.age)}</span>` : "")}</button>`;
    const headOf = (title, cap = "", right = "") => `<div class="hc-ch"><span class="hc-ct">${esc(title)}</span>${cap}<span class="hc-sp"></span>${right}</div>`;
    const more = (n, tab, words) => (n > 0 ? `<button type="button" class="hc-lnk hc-more" data-tab="${tab}">${esc(words)}</button>` : "");
    const rowsFor = (form, tight) => (form === "full" ? 30 : form === "l" ? 6 : tight ? 2 : 3);

    function series(n, back = 0) {
      const by = new Map((usage?.days || []).map((d) => [d.date, d])), out = [], now = new Date();
      for (let k = n - 1 + back; k >= back; k--) {
        const key = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - k)), d = by.get(key);
        out.push({ date: key, input: d?.input_tokens || 0, output: d?.output_tokens || 0, cached: d?.cached_input_tokens || 0, requests: d?.requests || 0 });
      }
      return out;
    }
    /** The change against the period before, as "+12.0%" (a share: in points), and whether it rose. */
    function change(metric, now, before) {
      const m = METRICS[metric], a = m.total(now), b = m.total(before);
      if (!(b > 0)) return null;
      const by = m.share ? a - b : ((a - b) / b) * 100;
      return { text: `${by >= 0 ? "+" : "−"}${Math.abs(by).toFixed(1)}${m.share ? " pts" : "%"}`, up: by >= 0 };
    }
    const delta = (c, tail = "") => (c ? `<span class="${c.up ? "hc-good" : "hc-bad"}">${c.text}</span>${tail}` : tail ? '<span class="hc-flat">No earlier use to compare</span>' : "");
    function columns(days, metric, rows, top) {
      const m = METRICS[metric];
      return days.map((d) => { const v = m.of(d), lv = v > 0 ? Math.max(1, Math.min(rows, Math.round((v / top) * rows))) : 0;
        let cells = ""; for (let r = 0; r < rows; r++) cells += `<i class="hc-cell${r < lv ? (r === lv - 1 && lv < rows ? " cap" : " on") : ""}"></i>`;
        return `<span class="hc-col${ui.token.hot === d.date ? " hot" : ""}" data-day="${d.date}">${cells}</span>`; }).join("");
    }
    function tokenCard(form) {
      const st = ui.token, none = !usage ? "Counting what DGC used…" : usage.error && !(usage.days || []).length ? usage.error : !(usage.days || []).some((d) => d.input_tokens || d.output_tokens || d.requests) ? "No use yet. What DGC uses shows here, day by day." : "";
      if (form === "s") {
        const week = series(7), today = week[6], yesterday = week[5], t = today.input + today.output, y = yesterday.input + yesterday.output;
        const by = y > 0 ? Math.round(((t - y) / y) * 100) : null, top = nice(Math.max(...week.map(METRICS.tokens.of)));
        return `<span class="hc-lbl">Tokens today${by === null || none ? "" : `<span class="${by >= 0 ? "hc-good" : "hc-bad"}">${by >= 0 ? "+" : "−"}${Math.abs(by)}%</span>`}</span><span class="hc-big">${none ? "0" : compact(t)}</span><span class="hc-grow"></span>`
          + (none ? `<span class="hc-sub">${esc(usage ? "No use yet" : "Counting…")}</span>` : `<span class="hc-strip" aria-hidden="true">${columns(week, "tokens", 5, top)}</span><span class="hc-sub">last 7 days</span>`);
      }
      const n = form === "m" ? 14 : form === "full" && st.range === "7d" ? 7 : 30, tabs = form === "m" ? ["tokens", "requests"] : ["tokens", "requests", "cache"];
      const metric = tabs.includes(st.metric) ? st.metric : "tokens", m = METRICS[metric], days = series(n), before = series(n, n);
      const span = form === "full" ? `prior ${n}d` : n === 14 ? "the 2 weeks before" : "the 30 days before";
      const title = `<div class="hc-ch"><span class="hc-tx"><span class="hc-ct">Token usage</span><span class="hc-cap">Daily · last ${n} days</span></span>`
        + (form === "full" ? `<span class="hc-seg" role="group" aria-label="Range">${["7d", "30d"].map((r) => `<button type="button" data-range="${r}" aria-pressed="${st.range === r}"${st.range === r ? ' class="on"' : ""}>${r}</button>`).join("")}</span>` : `<span class="hc-badge">${m.name}</span>`) + "</div>";
      if (none) return `${title}<p class="hc-quiet">${esc(none)}</p>`;
      const top = m.share ? 100 : nice(Math.max(...days.map(m.of))), rows = form === "m" ? 8 : 10;
      const tick = (v) => (m.share ? `${v}%` : v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : String(+v.toFixed(1)));
      const chart = `<div class="hc-chart"><div class="hc-y" aria-hidden="true"><span style="top:0%">${tick(top)}</span><span style="top:50%">${tick(top / 2)}</span><span style="top:100%">0</span></div>`
        + `<div class="hc-plot" tabindex="0" role="img" data-fk="plot" aria-label="${m.name} per day, last ${n} days. The arrow keys read a day."><span class="hc-grd" style="top:0%"></span><span class="hc-grd" style="top:50%"></span>${columns(days, metric, rows, top)}<span class="hc-line" hidden></span><div class="hc-tip" hidden></div></div>`
        + `<div class="hc-xs" aria-hidden="true"><span>${SHORT.format(dayOf(days[0].date))}</span><span>${SHORT.format(dayOf(days[Math.floor(n / 2)].date))}</span><span>Today</span><span class="hc-pin" hidden></span></div></div>`;
      const kt = `<div class="hc-kt hc-kt-${tabs.length}${form === "full" ? " hc-kt-wrap" : ""}" role="tablist" aria-label="What is counted">${tabs.map((id) => { const k = METRICS[id], c = change(id, days, before), on = id === metric;
        return `<button type="button" role="tab" class="hc-kb${on ? " on" : ""}" data-metric="${id}" data-fk="tab:${id}" aria-selected="${on}" tabindex="${on ? 0 : -1}"><span class="hc-kl">${form === "m" ? `<span class="hc-ki">${svg(k.icon, 11, 2.4)}</span>` : ""}${k.name}</span><span class="hc-kv">${k.say(k.total(days))}</span><span class="hc-kd">${delta(c, form === "l" ? "" : ` vs ${span}`)}</span></button>`; }).join("")}</div>`;
      const top3 = (usage.models || []).slice(0, 5), most = Math.max(1, ...top3.map((r) => r.tokens));
      const by = form === "full" && top3.length ? `<div class="hc-by"><span class="hc-bh">By model · last 30 days</span>${top3.map((r) => `<div class="hc-mr"><span class="hc-mt"><span class="hc-mn">${esc(r.name)}</span><span class="hc-mv">${compact(r.tokens)}</span></span><span class="hc-track"><span class="hc-fill" style="width:${Math.max(2, Math.round((r.tokens / most) * 100))}%"></span></span></div>`).join("")}</div>` : "";
      return title + chart + kt + by;
    }
    function recentCard(form, d, tight) {
      const fresh = (d.news || []).map((r) => ({ ...r, fresh: true })), rows = [...fresh, ...(d.recent || [])];
      if (form === "s") {
        const r = rows[0];
        return `<span class="hc-lbl">Recent${fresh.length ? `<span class="hc-newmark">New${fresh.length > 1 ? ` · ${fresh.length}` : ""}</span>` : ""}</span>${r ? `<span class="hc-ico hc-ico-s">${r.icon || ""}</span><span class="hc-mid hc-grow${r.fresh ? " hc-b" : ""}">${esc(r.name)}</span><span class="hc-sub">${esc(r.meta || "")}${r.age ? ` · ${esc(r.age)}` : ""}</span>` : '<span class="hc-grow"></span><span class="hc-sub">Nothing yet</span>'}`;
      }
      // Opened: what is new as cards with their own answers (Open, Mark read, Dismiss, Undo) and Clear, the hub's; then the rest as rows.
      if (form === "full") return `${fresh.length ? "" : headOf("Recent", '<span class="hc-cap">Work, chats and Pips</span>')}<div data-slot="new"></div>${(d.recent || []).length ? `${fresh.length ? '<div class="hc-ch hc-earlier"><span class="hc-ct">Earlier</span></div>' : ""}<div class="hc-list">${d.recent.slice(0, 30).map((r) => li(r)).join("")}</div>` : fresh.length ? "" : '<p class="hc-quiet">Nothing yet. Sessions, chats and Pips show here as you use them.</p>'}`;
      const clear = `${fresh.length ? '<button type="button" class="hc-lnk hc-clear" title="Mark what is new as read. What needs you stays.">Clear</button>' : ""}<button type="button" class="hc-lnk hc-viewall" title="Open Recent whole: what is new with its answers, and more of the rest">View all</button>`;
      const shown = rows.slice(0, rowsFor(form, tight));
      return `${headOf("Recent", fresh.length ? `<span class="hc-cnt">${fresh.length} new</span>` : form === "l" ? '<span class="hc-cap">Work, chats and Pips</span>' : "", clear)}${shown.length ? `<div class="hc-list">${shown.map((r) => li(r)).join("")}</div>` : '<p class="hc-quiet">Nothing yet. Sessions, chats and Pips show here as you use them.</p>'}`;
    }
    function listCard(id, form, d, tight) {
      const x = d[id] || { rows: [], total: 0 }, name = CARDS[id].name, tab = id === "chats" ? "chat" : id, unit = id === "work" ? "session" : id === "chats" ? "chat" : "Pip";
      if (x.offered === false) return form === "s" ? `<span class="hc-lbl">${name}</span><span class="hc-grow"></span><span class="hc-sub">${esc(x.why || "Not set up here")}</span>` : `${headOf(name)}<p class="hc-quiet">${esc(x.why || "Not set up here.")}</p>`;
      const total = `${x.total}${x.more ? "+" : ""}`;
      if (form === "s") {
        if (id === "pips") { const r = x.rows[0]; return `<span class="hc-lbl">Pips</span>${r ? `<span class="hc-ico hc-ico-l">${r.icon || ""}</span><span class="hc-mid hc-grow">${esc(x.say || `${r.name} is ready`)}</span>` : '<span class="hc-grow"></span>'}<span class="hc-sub">${plural(x.total, "Pip")}${x.waiting ? ` · ${x.waiting} waiting` : ""}</span>`; }
        const r = x.rows[0], note = id === "work" ? (x.running ? `<span class="hc-row"><span class="hc-livedot"></span><span class="hc-sub">${x.running} running</span></span>` : "") : x.fresh ? `<span class="hc-row"><span class="hc-sub hc-b">${plural(x.fresh, "new reply", "new replies")}</span></span>` : "";
        return `<span class="hc-lbl">${name}</span><span class="hc-big">${total}</span><span class="hc-grow"></span>${note}<span class="hc-sub hc-cut">${r ? `${esc(r.name)}${r.age ? ` · ${esc(r.age)}` : ""}` : `No ${unit}s yet`}</span>`;
      }
      const n = rowsFor(form, tight), shown = x.rows.slice(0, n), rest = Math.max(0, x.rows.length - shown.length);
      const right = id === "pips" ? `<button type="button" class="hc-lnk" data-tab="pips">All Pips</button>` : `<button type="button" class="hc-btn hc-solid hc-new-btn" data-new="${id === "work" ? "work" : "chat"}" title="${id === "work" ? "New session: it opens in an editor tab" : "New chat"}">${PLUS}${id === "work" ? "New" : "New chat"}</button>`;
      return `${headOf(name, id === "work" && x.folder ? `<span class="hc-cap hc-cut">${esc(x.folder)}</span>` : "", right)}${shown.length ? `<div class="hc-list">${shown.map((r) => li(r)).join("")}</div>` : `<p class="hc-quiet">${esc(x.empty || `No ${unit}s yet.`)}</p>`}`
        + more(rest + (x.more ? 1 : 0), tab, x.more ? `More in ${id === "work" ? "Work" : id === "chats" ? "Chat" : "Pips"}` : `${rest} more`);
    }
    function needsCard(form, d) {
      const x = d.needs || { count: 0, faces: [] };
      if (form === "s") return `<span class="hc-lbl">Needs you</span><span class="hc-big">${x.count}</span><span class="hc-sub hc-grow">${x.count ? "waiting for you" : "Nothing needs you"}</span><span class="hc-row hc-faces">${(x.faces || []).slice(0, 4).map((f) => `<span class="hc-ico hc-ico-f">${f}</span>`).join("")}</span>`;
      return '<div data-slot="needs"></div>';
    }
    function runningCard(form, d, tight) {
      const rows = d.running || [];
      if (form === "s") { const r = rows[0]; return `<span class="hc-lbl">Running now${rows.length ? '<span class="hc-livedot"></span>' : ""}</span><span class="hc-big">${rows.length}</span><span class="hc-grow"></span>${r ? `<span class="hc-mid">${esc(r.name)}</span><span class="hc-sub hc-cut">${esc(r.meta || "")}</span>` : '<span class="hc-sub">Nothing running</span>'}`; }
      const shown = rows.slice(0, form === "full" ? 30 : tight ? 2 : 4);
      return `${headOf("Running now", rows.length ? '<span class="hc-livedot"></span>' : "")}${shown.length ? `<div class="hc-list">${shown.map((r) => li(r, '<span class="hc-btn hc-open-word">Open</span>')).join("")}</div>${rows.length > shown.length ? `<span class="hc-more-n">${rows.length - shown.length} more</span>` : ""}` : '<p class="hc-quiet">Nothing running. A session at work, or a chat answering, shows here.</p>'}`;
    }
    function quickCard(form, d) {
      const q = d.quick || {}, items = [["work", "Session", "New session", q.work], ["chat", "Chat", "New chat", q.chat], ["pip", "Pip", "New Pip", q.pip]];
      return (form === "s" ? '<span class="hc-lbl">Quick start</span>' : headOf("Quick start")) + `<span class="hc-qs">${items.map(([id, short, long, mark]) => `<button type="button" class="hc-qb" data-quick="${id}" title="${long}">${mark || ""}<span>${form === "s" ? short : long}</span></button>`).join("")}</span>`;
    }
    function foldersCard(form, d) {
      const x = d.folders || { rows: [] }, rows = x.rows || [];
      if (!rows.length) return (form === "s" ? '<span class="hc-lbl">Folders</span><span class="hc-grow"></span><span class="hc-sub">No folders yet</span>' : `${headOf("Folders")}<p class="hc-quiet">No folders yet. A folder shows here once it has a Work session or a Pip.</p>`);
      const most = form === "s" ? 1 : form === "m" ? 4 : form === "l" ? 8 : 24, size = form === "s" ? 52 : form === "m" ? 72 : 64;
      const tile = (r) => { const counts = [r.sessions ? plural(r.sessions, "session") : "", r.pips ? plural(r.pips, "Pip") : ""].filter(Boolean).join(" · ") || "Nothing yet";
        return `<div class="hc-tile${r.exists === false ? " hc-gone" : ""}" data-name="${esc(r.name)}"><button type="button" class="hc-tile-open" data-folder="${esc(r.folder)}" title="${esc(r.exists === false ? `${r.shown || r.folder}: not found` : `${r.shown || r.folder} · ${counts}${r.here ? " · this window’s folder" : ""}: open its Work sessions`)}">${x.mark ? x.mark(r.folder, size, size >= 64 ? r.name : "") : ""}`
          + `${size >= 64 ? "" : `<span class="hc-tile-name">${esc(r.name)}</span>`}${form === "s" ? "" : `<span class="hc-tile-sub">${r.exists === false ? "Not found" : esc(counts)}</span>`}</button>`
          + (r.exists === false ? "" : `<button type="button" class="hc-here" data-here="${esc(r.folder)}" title="New session here" aria-label="New session in ${esc(r.name)}">${PLUS}</button>`) + "</div>"; };
      const shown = rows.slice(0, most), rest = rows.length - shown.length;
      if (form === "s") return `<span class="hc-lbl">Folders${rest > 0 ? `<span class="hc-cnt">+${rest}</span>` : ""}</span><span class="hc-tiles hc-tiles-1">${shown.map(tile).join("")}</span>`;
      return `${headOf("Folders", "", rest > 0 ? `<span class="hc-cap">+${rest} more</span>` : "")}<div class="hc-tiles">${shown.map(tile).join("")}</div>`;
    }
    function clockCard(form) {
      const now = new Date(), z = layout.settings?.clock?.zone || "", city = (ZONES.find(([id]) => id === z) || [z, z.split("/").pop().replace(/_/g, " ")])[1];
      const time = (zone) => { try { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) }).format(now); } catch { return "--:--"; } };
      const date = DAY.format(now);
      if (form === "s") return `<span class="hc-lbl">Clock</span><span class="hc-big">${time("")}</span><span class="hc-grow"></span>${z ? `<span class="hc-sub">${esc(city)} ${time(z)}</span>` : ""}<span class="hc-sub">${date}</span>`;
      const pick = `<select class="hc-zone hc-field" aria-label="A second city’s time" title="Show a second city’s time beside yours"><option value="">No second city</option>${ZONES.map(([id, name]) => `<option value="${id}"${id === z ? " selected" : ""}>${esc(name)}</option>`).join("")}</select>`;
      return `${headOf("Clock", `<span class="hc-cap">${date}</span>`, pick)}<div class="hc-clocks"><span class="hc-clock"><span class="hc-time">${time("")}</span><span class="hc-sub">Here</span></span>${z ? `<span class="hc-clock"><span class="hc-time">${time(z)}</span><span class="hc-sub">${esc(city)}</span></span>` : ""}</div>`;
    }
    function weatherCard(form) {
      const w = layout.settings?.weather || {}, f = w.unit === "f", deg = (c) => (Number.isFinite(c) ? `${Math.round(f ? (c * 9) / 5 + 32 : c)}°` : "–");
      const field = (label) => `<form class="hc-cityform"><input class="hc-city hc-field" type="text" maxlength="80" placeholder="City" aria-label="City" value="${esc(ui.weatherEdit ? w.city || "" : "")}"><button type="submit" class="hc-btn hc-solid">${label}</button></form><p class="hc-fine">The city’s name is sent to Open-Meteo to find its weather. Nothing else is sent.</p>`;
      if (!w.city) return form === "s" ? '<span class="hc-lbl">Weather</span><span class="hc-grow"></span><span class="hc-mid">Add a city</span><span class="hc-sub">Open to type one</span>' : `${headOf("Weather")}${field("Set city")}`;
      const bad = weather && weather.ok === false ? (weather.reason === "notfound" ? `Couldn’t find “${w.city}”. Try another spelling.` : weather.reason === "refused" ? "The weather service isn’t answering right now." : "Can’t reach the weather right now.") : "";
      const unit = `<span class="hc-seg" role="group" aria-label="Unit">${[["c", "°C"], ["f", "°F"]].map(([id, name]) => `<button type="button" data-unit="${id}" aria-pressed="${(f ? "f" : "c") === id}"${(f ? "f" : "c") === id ? ' class="on"' : ""}>${name}</button>`).join("")}</span>`;
      const edit = form === "full" ? (ui.weatherEdit ? field("Change city") : '<button type="button" class="hc-lnk hc-city-edit">Change city</button><p class="hc-fine">The city’s name is sent to Open-Meteo to find its weather. Nothing else is sent.</p>') : "";
      if (!weather || bad) {
        if (form === "s") return `<span class="hc-lbl">Weather</span><span class="hc-grow"></span><span class="hc-mid">${esc(bad || "Looking…")}</span><span class="hc-sub hc-cut">${esc(w.city)}</span>`;
        return `${headOf("Weather", `<span class="hc-cap hc-cut">${esc(w.city)}</span>`, unit)}<p class="hc-quiet">${esc(bad || "Looking up the weather…")}</p>${edit}`;
      }
      if (form === "s") return `<span class="hc-lbl">Weather${wx(weather.now.code, weather.now.day, 18)}</span><span class="hc-big">${deg(weather.now.temp)}</span><span class="hc-grow"></span><span class="hc-sub">${wxWord(weather.now.code)}</span><span class="hc-sub hc-cut">${esc(weather.place)}</span>`;
      return `${headOf("Weather", `<span class="hc-cap hc-cut">${esc(weather.place)}</span>`, unit)}<div class="hc-wnow">${wx(weather.now.code, weather.now.day, 30)}<span class="hc-time">${deg(weather.now.temp)}</span><span class="hc-tx"><span class="hc-nm">${wxWord(weather.now.code)}</span><span class="hc-meta">High ${deg(weather.high)} · Low ${deg(weather.low)}</span></span></div>`
        + `<div class="hc-hours">${(weather.hours || []).slice(0, 5).map((h) => `<span class="hc-hour"><span class="hc-sub">${esc(h.time)}</span><span class="hc-hrow">${wx(h.code, true, 15)}<span class="hc-hv">${deg(h.temp)}</span></span></span>`).join("")}</div><span class="hc-fine">Weather from Open-Meteo</span>${edit}`;
    }
    function noteCard(form) {
      const text = layout.settings?.note?.text || "";
      if (form === "s") { const first = text.split("\n").find((l) => l.trim()) || ""; return `<span class="hc-lbl">Note</span><span class="hc-mid hc-note-line hc-grow">${first ? esc(first.trim()) : '<span class="hc-sub">Empty. Open to write.</span>'}</span>`; }
      return `${headOf("Note", '<span class="hc-cap">Kept on this computer</span>')}<textarea class="hc-note hc-field" maxlength="4000" placeholder="Write a note…" aria-label="Note"></textarea>`;
    }
    const render = (id, form, d, tight) => (id === "token" ? tokenCard(form) : id === "recent" ? recentCard(form, d, tight) : id === "needs" ? needsCard(form, d) : id === "running" ? runningCard(form, d, tight)
      : id === "quick" ? quickCard(form, d) : id === "folders" ? foldersCard(form, d) : id === "clock" ? clockCard(form) : id === "weather" ? weatherCard(form) : id === "note" ? noteCard(form) : listCard(id, form, d, tight));
    /** A card's one line while Home is arranged, and its small preview in the library. */
    function caption(id, d) {
      return id === "needs" ? (d.needs?.count ? `${d.needs.count} waiting` : "Nothing waiting") : id === "running" ? ((d.running || []).length ? `${d.running.length} running` : "Nothing running") : id === "recent" ? "Work, chats and Pips"
        : id === "token" ? "Tokens, requests, cache" : id === "quick" ? "New session · chat · Pip" : id === "work" ? plural(d.work?.total || 0, "session") : id === "chats" ? plural(d.chats?.total || 0, "chat") : id === "pips" ? plural(d.pips?.total || 0, "Pip")
        : id === "folders" ? plural((d.folders?.rows || []).length, "folder") : id === "clock" ? "The time here" : id === "weather" ? layout.settings?.weather?.city || "A city you type" : "A sticky note";
    }
    function preview(id, d) {
      const marks = (rows) => (rows || []).slice(0, 3).map((r) => `<span class="hc-ico">${r.icon || ""}</span>`).join("") || `<span class="hc-sub">${esc(caption(id, d))}</span>`;
      if (id === "needs") return `<span class="hc-big">${d.needs?.count || 0}</span>`;
      if (id === "running") return `${(d.running || []).length ? '<span class="hc-livedot"></span>' : ""}<span class="hc-pvw">${esc(caption(id, d))}</span>`;
      if (id === "token") { const week = series(7), top = Math.max(1, ...week.map(METRICS.tokens.of)); return `<span class="hc-mini" aria-hidden="true">${week.map((x) => `<i style="height:${Math.max(8, Math.round((METRICS.tokens.of(x) / top) * 100))}%"></i>`).join("")}</span>`; }
      if (id === "recent") return marks([...(d.news || []), ...(d.recent || [])]);
      if (id === "work" || id === "chats" || id === "pips") return marks(d[id]?.rows);
      if (id === "quick") return `${d.quick?.work || ""}${d.quick?.chat || ""}${d.quick?.pip || ""}`;
      if (id === "folders") return (d.folders?.rows || []).slice(0, 3).map((r) => (d.folders.mark ? d.folders.mark(r.folder, 28, "") : "")).join("") || `<span class="hc-sub">No folders yet</span>`;
      if (id === "clock") return `<span class="hc-pvt">${new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" }).format(new Date())}</span>`;
      if (id === "weather") return weather?.ok && layout.settings?.weather?.city ? `${wx(weather.now.code, weather.now.day, 20)}<span class="hc-pvt">${Math.round(layout.settings.weather.unit === "f" ? (weather.now.temp * 9) / 5 + 32 : weather.now.temp)}°</span>` : `${wx(1, true, 20)}<span class="hc-pvw">A city you type</span>`;
      return `<span class="hc-pvw hc-note-line">${esc((layout.settings?.note?.text || "").split("\n").find((l) => l.trim()) || "A sticky note")}</span>`;
    }

    // ---- drawing --------------------------------------------------------------------------------------------------------
    const focusKey = (section) => { const a = doc.activeElement; if (!a || !section.contains(a) || a === section) return null; return a.dataset.fk ? `[data-fk="${a.dataset.fk}"]` : a.dataset.open ? `[data-open="${view.CSS.escape(a.dataset.open)}"]` : a.className ? `.${String(a.className).trim().split(/\s+/).map((c) => view.CSS.escape(c)).join(".")}` : null; };
    /** A card's inside, drawn again only when it changed; the hubs' own elements are put back, and the keyboard stays. */
    function fill(section, id, form, d, tight) {
      const arranging = ui.arranging && section.parentNode === grid;
      const html = arranging ? `${GRIP}<span class="hc-tx"><span class="hc-ct">${esc(CARDS[id].name)}</span><span class="hc-cap">${esc(ui.lifted === id ? "Being moved · Space drops it here" : caption(id, d))}</span></span><button type="button" class="hc-x" aria-label="Remove ${esc(CARDS[id].name)}" title="Take ${esc(CARDS[id].name)} off Home">${CROSS}</button>` : render(id, form, d, tight);
      const small = form === "s" && !arranging && id !== "quick";
      section.dataset.form = form;
      section.classList.toggle("hc-lifted", arranging && ui.lifted === id);
      if (small || arranging) { section.tabIndex = 0; section.setAttribute("role", arranging ? "listitem" : "button"); } else { section.removeAttribute("tabindex"); section.setAttribute("role", "group"); }
      section.setAttribute("aria-label", arranging ? `${CARDS[id].name}. Space lifts it to move it, Delete takes it off Home.` : small ? `${CARDS[id].name}: open` : CARDS[id].name);
      if (section.__html === html) { after(section, id, form); return; }
      // (The keyboard may be inside a hub's own element, which is moved, not redrawn: the same button takes it back.)
      const moved = [...section.querySelectorAll("[data-slot] > *")], inSlot = moved.some((node) => node.contains(doc.activeElement)) ? doc.activeElement : null;
      const key = inSlot ? null : focusKey(section);
      for (const node of moved) pantry.append(node);
      filling = true; section.__html = html; section.innerHTML = html; filling = false;
      for (const place of section.querySelectorAll("[data-slot]")) { const node = slot?.(place.dataset.slot); if (node) { place.append(node); slotted?.(place.dataset.slot, form, tight); } }
      after(section, id, form);
      if (inSlot && section.contains(inSlot)) inSlot.focus({ preventScroll: true });
      else if (key) { try { section.querySelector(key)?.focus({ preventScroll: true }); } catch { /* it is gone */ } }
    }
    /** What a draw leaves to be set by hand: a note's words (never while it is typed in), the inked day. */
    function after(section, id, form) {
      if (id === "note") { const box = section.querySelector("textarea.hc-note"); if (box && doc.activeElement !== box && box.value !== (layout.settings?.note?.text || "")) box.value = layout.settings?.note?.text || ""; }
      if (id === "token" && form !== "s") inkHot(section);
    }
    function section(id) { const s = doc.createElement("section"); s.className = `hc-card hc-${id}`; s.dataset.card = id; return s; }
    function drawNow() {
      pending = 0;
      const d = data?.() || {}, g = gridForm(), order = layout.order.filter((id) => CARDS[id]);
      if (ui.open && !order.includes(ui.open)) ui.open = "";
      if (ui.arranging && !order.length) ui.arranging = false;
      // The head: Cards at the top right; while Home is arranged, what to do and Done.
      const headHtml = `${ui.arranging ? `<span class="hc-arr-title">Arrange Home</span><span class="hc-cap hc-arr-cap">drag to move · × to remove</span><span class="hc-sp"></span><button type="button" class="hc-btn hc-solid hc-done">Done</button>` : ui.open ? `<button type="button" class="hc-btn hc-back" title="Back to Home (Escape)">${BACK}Home</button><span class="hc-sp"></span>` : '<span class="hc-sp"></span>'}`
        + `<button type="button" class="hc-btn hc-cards-btn" aria-haspopup="dialog" title="Cards: add, remove and arrange what is on Home">${mosaic("ember", 16)}Cards</button>`;
      if (head.__html !== headHtml) { const had = doc.activeElement && head.contains(doc.activeElement) ? doc.activeElement.className : ""; head.__html = headHtml; head.innerHTML = headHtml; if (had) head.querySelector(`.${had.trim().split(/\s+/).join(".")}`)?.focus({ preventScroll: true }); }
      const notesHtml = (d.notes || []).map((n) => `<p class="dgc-hub-note" role="status">${esc(n.text)}${n.retry ? ' <button type="button" class="dgc-hub-link dgc-hub-retry" title="Ask DGC again">Retry</button>' : ""}</p>`).join("");
      if (notes.__html !== notesHtml) { notes.__html = notesHtml; notes.innerHTML = notesHtml; }
      grid.dataset.form = g; grid.dataset.cols = g === "l" ? (widthNow() >= 940 ? "6" : "4") : g === "m" ? "1" : "2";
      grid.classList.toggle("hc-arranging", ui.arranging);
      grid.setAttribute("role", ui.arranging ? "list" : "presentation");
      grid.hidden = !!ui.open; opened.hidden = !ui.open;
      // The opened card first: the hubs' elements go where the user is looking.
      if (ui.open) {
        let full = opened.querySelector(".hc-card");
        if (!full || full.dataset.card !== ui.open) { for (const node of opened.querySelectorAll("[data-slot] > *")) pantry.append(node); opened.replaceChildren(); full = section(ui.open); opened.append(full); }
        for (const s of grid.querySelectorAll(".hc-card")) { if (s.dataset.card === ui.open) { for (const node of s.querySelectorAll("[data-slot] > *")) pantry.append(node); s.__html = null; } }
        fill(full, ui.open, "full", d, false);
      } else if (opened.firstChild) { for (const node of opened.querySelectorAll("[data-slot] > *")) pantry.append(node); opened.replaceChildren(); }
      const have = new Map([...grid.children].map((s) => [s.dataset.card, s]));
      let at = grid.firstElementChild;
      for (const id of order) {
        let s = have.get(id);
        if (!s) { s = section(id); s.__new = true; }
        have.delete(id);
        if (s !== at) { const focused = doc.activeElement === s; grid.insertBefore(s, at); if (focused) s.focus({ preventScroll: true }); } else at = at.nextElementSibling;
        if (!(ui.open === id)) fill(s, id, formOf(id, g), d, g === "l");
        else s.dataset.form = formOf(id, g);
      }
      for (const s of have.values()) { for (const node of s.querySelectorAll("[data-slot] > *")) pantry.append(node); s.remove(); }
      const emptyHtml = order.length ? "" : '<p class="hc-quiet hc-empty">Home is empty. Add cards with the Cards button, or put the usual ones back with Reset Home in it.</p>';
      let empty = host.querySelector(".hc-empty"); if (!!empty !== !!emptyHtml) { empty?.remove(); if (emptyHtml) grid.insertAdjacentHTML("afterend", emptyHtml); }
      if (library) drawLibrary(d);
      try { onDraw?.(host); } catch { /* the faces are the page's */ }
      if (focusNext) { const target = host.querySelector(focusNext); focusNext = ""; target?.focus({ preventScroll: true }); }
      ask();
    }
    /** Draws at the next frame; what moved glides there (FLIP) when `glide`. */
    function draw(glide = false) {
      if (glide && !still() && !ui.open) { cancelAnimationFrame(pending); pending = 0; flip(drawNow); return; }
      if (!pending) pending = view.requestAnimationFrame(drawNow);
    }
    const spring = () => view.getComputedStyle(host).getPropertyValue("--ease-spring").trim() || "cubic-bezier(.23,1,.32,1)";
    function flip(change, skip = null) {
      const first = new Map([...grid.children].map((s) => [s, s.getBoundingClientRect()]));
      change();
      if (still()) return;
      const ease = spring();
      for (const s of grid.children) {
        if (s === skip) continue;
        const was = first.get(s), now = s.getBoundingClientRect();
        let frames = null;
        if (!was) frames = [{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }];
        else if (Math.abs(was.left - now.left) + Math.abs(was.top - now.top) > 0.5) frames = [{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)` }, { transform: "none" }];
        if (!frames) continue;
        try { s.animate(frames, { duration: 520, easing: ease }); } catch { try { s.animate(frames, { duration: 320, easing: "cubic-bezier(.23,1,.32,1)" }); } catch { /* it is in its place already */ } }
      }
    }

    // ---- Token usage: the inked day, the tabs' wave ------------------------------------------------------------------------
    function inkHot(card) {
      const plot = card.querySelector(".hc-plot"); if (!plot) return;
      const cols = [...plot.querySelectorAll(".hc-col")], at = cols.findIndex((c) => c.dataset.day === ui.token.hot), line = plot.querySelector(".hc-line"), tip = plot.querySelector(".hc-tip"), pin = card.querySelector(".hc-pin");
      for (const [k, c] of cols.entries()) c.classList.toggle("hot", k === at);
      plot.classList.toggle("hc-has-hot", at >= 0);
      line.hidden = tip.hidden = at < 0; if (pin) pin.hidden = at < 0;
      if (at < 0) { plot.removeAttribute("aria-description"); return; }
      const metric = card.querySelector('[role="tab"][aria-selected="true"]')?.dataset.metric || "tokens", m = METRICS[metric];
      const day = series(cols.length).find((x) => x.date === ui.token.hot) || { input: 0, output: 0, cached: 0, requests: 0 };
      const x = ((at + 0.5) / cols.length) * 100;
      line.style.left = `${x}%`;
      const words = `${m.say(m.of(day))} ${m.unit}`;
      tip.innerHTML = `<div class="hc-tip-d">${DAY.format(dayOf(ui.token.hot))}</div><div class="hc-tip-v"><i></i>${words}</div>`;
      // Above the inked column, clear of the bars, and never past the plot's ends.
      const wide = plot.clientWidth, half = tip.offsetWidth / 2, mid = (x / 100) * wide;
      tip.style.left = `${wide && half ? Math.max(half - 2, Math.min(wide - half + 2, mid)) : mid}px`;
      plot.setAttribute("aria-description", `${DAY.format(dayOf(ui.token.hot))}: ${words}`);
      if (pin) { pin.textContent = SHORT.format(dayOf(ui.token.hot)); pin.style.left = `${Math.max(8, Math.min(92, x))}%`; }
    }
    const tokenCards = () => [...host.querySelectorAll('.hc-card[data-card="token"]')];
    function hot(day) { if (ui.token.hot === day) return; ui.token.hot = day; for (const c of tokenCards()) { c.__html = null; } for (const c of tokenCards()) inkHot(c); }
    function wave(card) {
      if (still()) return;
      const ease = spring();
      for (const [c, col] of [...card.querySelectorAll(".hc-plot .hc-col")].entries()) for (const [r, cell] of [...col.children].entries()) {
        try { cell.animate([{ transform: "perspective(240px) rotateX(88deg) scaleY(.3)", opacity: 0.25 }, { transform: "none", opacity: 1 }], { duration: 420, delay: c * 11 + r * 16, easing: ease, fill: "backwards" }); } catch { /* drawn already */ }
      }
    }
    function chooseMetric(metric, focus) {
      if (!METRICS[metric] || ui.token.metric === metric) return;
      ui.token.metric = metric;
      if (focus) focusNext = `${ui.open ? ".hc-open" : ".hc-grid"} [data-fk="tab:${metric}"]`;
      cancelAnimationFrame(pending); drawNow();
      for (const c of tokenCards()) if (c.checkVisibility?.() !== false) wave(c);
    }

    // ---- what the host is asked: the token report and the weather, while Home shows a card that wants them ---------------
    function ask() {
      if (!heard || !host.checkVisibility?.()) return;
      const now = Date.now(), on = (id) => layout.order.includes(id) || !!library;
      if (on("token") && now - usageAt > 5 * 60000) { usageAt = now; post?.({ type: "homeUsageGet" }); }
      if (layout.order.includes("weather") && layout.settings?.weather?.city && now - Math.max(weatherAt, weatherAsked) > 30 * 60000) { weatherAsked = now; post?.({ type: "homeWeatherGet" }); }
    }

    // ---- a Small card opened to its full form -----------------------------------------------------------------------------
    function open(id) {
      if (!CARDS[id] || !layout.order.includes(id) || ui.arranging) return;
      ui.open = id; keep?.({ open: id });
      cancelAnimationFrame(pending); drawNow();
      host.closest("#sessions-host")?.scrollTo?.({ top: 0 });
      head.querySelector(".hc-back")?.focus({ preventScroll: true });
    }
    function close(focus = true) {
      if (!ui.open) return;
      const was = ui.open; ui.open = ""; ui.weatherEdit = false; keep?.({ open: "" });
      cancelAnimationFrame(pending); drawNow();
      if (focus) { const card = grid.querySelector(`.hc-card[data-card="${was}"]`); (card?.tabIndex === 0 ? card : card?.querySelector("button, [tabindex]") || head.querySelector(".hc-cards-btn"))?.focus({ preventScroll: true }); }
    }

    // ---- Arrange Home -----------------------------------------------------------------------------------------------------
    function arrange(on, focus = "") {
      if (ui.arranging === on) return;
      focusNext = focus || (on ? "" : ".hc-cards-btn");
      if (on && ui.open) close(false);
      ui.arranging = on; ui.lifted = ""; liftedFrom = null;
      say(on ? "Arrange Home: Space lifts a card, the arrows move it, Space drops it. Delete takes a card off Home." : "Home is arranged.");
      draw(true);
    }
    function remove(id) {
      const at = layout.order.indexOf(id); if (at < 0) return;
      keepOrder(layout.order.filter((x) => x !== id));
      say(`${CARDS[id].name} is off Home.`);
      if (!library) focusNext = layout.order.length ? `.hc-grid .hc-card[data-card="${layout.order[Math.min(at, layout.order.length - 1)]}"]` : ".hc-cards-btn";
      draw(true);
    }
    function add(id) { if (!CARDS[id] || layout.order.includes(id)) return; keepOrder([...layout.order, id]); say(`${CARDS[id].name} is on Home.`); draw(true); }
    function moveTo(id, to) {
      const order = layout.order.filter((x) => x !== id), at = Math.max(0, Math.min(order.length, to));
      order.splice(at, 0, id);
      if (order.every((x, i) => x === layout.order[i])) return false;
      layout = { ...layout, order };
      return true;
    }
    function lift(id) { ui.lifted = id; liftedFrom = [...layout.order]; say(`${CARDS[id].name} lifted. The arrow keys move it, Space drops it, Escape puts it back.`); drawNow(); }
    function drop(commit) {
      if (!ui.lifted) return;
      const id = ui.lifted; ui.lifted = "";
      if (!commit && liftedFrom) { layout = { ...layout, order: liftedFrom }; say(`${CARDS[id].name} is back where it was.`); }
      else { post?.({ type: "homeCardsSet", order: layout.order }); say(`${CARDS[id].name} dropped, ${layout.order.indexOf(id) + 1} of ${layout.order.length}.`); }
      liftedFrom = null; focusNext = `.hc-grid .hc-card[data-card="${id}"]`;
      flip(drawNow);
    }
    // By pointer: the card follows the pointer, and the others make room.
    function dragStart(e, card) {
      if (e.button !== 0 || e.target.closest(".hc-x")) return;
      drag = { id: card.dataset.card, card, x: e.clientX, y: e.clientY, lifted: false, base: null, pointer: e.pointerId };
    }
    function dragMove(e) {
      if (!drag || e.pointerId !== drag.pointer) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.lifted) {
        if (Math.hypot(dx, dy) < 4) return;
        drag.lifted = true; ui.lifted = drag.id; liftedFrom = [...layout.order];
        drag.card.classList.add("hc-lifted", "hc-dragging");
        try { drag.card.setPointerCapture(drag.pointer); } catch { /* it still follows */ }
        drag.base = rectAtRest(drag.card);
      }
      e.preventDefault();
      // Where it would land: before the first card whose middle the pointer has not passed.
      const others = [...grid.children].filter((s) => s !== drag.card), cols = view.getComputedStyle(grid).gridTemplateColumns.split(" ").length;
      let to = others.length;
      for (const [k, s] of others.entries()) { const r = s.getBoundingClientRect(); if (cols > 1 ? (e.clientY < r.top || (e.clientY < r.bottom && e.clientX < r.left + r.width / 2)) : e.clientY < r.top + r.height / 2) { to = k; break; } }
      if (moveTo(drag.id, to)) flip(() => { grid.insertBefore(drag.card, others[to] || null); }, drag.card);
      const rest = rectAtRest(drag.card);
      drag.card.style.transform = `translate(${drag.base.left + dx - rest.left}px, ${drag.base.top + dy - rest.top}px)`;
    }
    function rectAtRest(card) { const was = card.style.transform; card.style.transform = "none"; const r = card.getBoundingClientRect(); card.style.transform = was; return r; }
    function dragEnd(e, commit = true) {
      if (!drag || (e && e.pointerId !== drag.pointer)) return;
      const d = drag; drag = null;
      if (!d.lifted) return;
      d.card.classList.remove("hc-dragging"); d.card.style.transform = "";
      try { d.card.releasePointerCapture(d.pointer); } catch { /* released */ }
      d.card.__moved = Date.now();
      drop(commit);
    }

    // ---- the card library, a pop-up -----------------------------------------------------------------------------------------
    function drawLibrary(d) {
      if (!library) return;
      const groups = [...new Set(TYPES.map((id) => CARDS[id].group))], list = library.querySelector(".hc-lib-list");
      if (!list.childElementCount) list.innerHTML = groups.map((g) => `<div class="hc-lib-grp">${esc(g)}</div><div class="hc-lib-grid">${TYPES.filter((id) => CARDS[id].group === g).map((id) => `<div class="hc-lib-item" data-card="${id}"></div>`).join("")}</div>`).join("");
      for (const item of list.querySelectorAll(".hc-lib-item")) {
        const id = item.dataset.card, on = layout.order.includes(id), adding = libraryAdding === id && !on;
        // Its preview, its name whole on a line of its own, its one line, then (level across a row of cards) whether it is
        // on Home and the one button: Add, or Remove.
        const html = `<div class="hc-lib-pv">${preview(id, d)}</div><div class="hc-lib-row"><span class="hc-lib-name">${esc(CARDS[id].name)}</span></div>`
          + `<span class="hc-lib-line">${esc(CARDS[id].line)}</span>`
          + (adding ? '<span class="hc-fine">The city’s name is sent to Open-Meteo to find its weather. Nothing else is sent, and nothing is guessed from this computer.</span>' : "")
          + `<div class="hc-lib-act">${adding ? '<form class="hc-cityform"><input class="hc-city hc-field" type="text" maxlength="80" placeholder="City" aria-label="City for the weather"><button type="submit" class="hc-btn hc-solid hc-add-city">Add</button></form>'
            : on ? `<span class="hc-onhome">${TICK}On Home</span><span class="hc-sp"></span><button type="button" class="hc-btn hc-remove" aria-label="Remove ${esc(CARDS[id].name)} from Home">Remove</button>`
            : `<span class="hc-sp"></span><button type="button" class="hc-btn hc-solid hc-add" aria-label="Add ${esc(CARDS[id].name)} to Home">Add</button>`}</div>`;
        if (item.__html === html) continue;
        const had = item.contains(doc.activeElement) ? (doc.activeElement.classList.contains("hc-add") ? ".hc-remove" : doc.activeElement.classList.contains("hc-remove") ? ".hc-add" : "") : "";
        item.__html = html; item.innerHTML = html;
        if (adding) item.querySelector(".hc-city")?.focus(); else if (had) item.querySelector(had)?.focus();
      }
      try { onDraw?.(library); } catch { /* the faces are the page's */ }
    }
    function closeLibrary(focus = true) {
      if (!library) return;
      const was = library; library = null; libraryAdding = "";
      try { was.close(); } catch { /* closed */ }
      was.remove();
      if (focus) head.querySelector(".hc-cards-btn")?.focus({ preventScroll: true });
    }
    function openLibrary() {
      closeLibrary(false);
      const dialog = library = doc.createElement("dialog");
      dialog.className = "hc-library dgc-dialog"; dialog.setAttribute("aria-labelledby", "hc-lib-title");
      dialog.innerHTML = `<div class="hc-lib-head"><h2 id="hc-lib-title">${mosaic("ember", 18)}Cards</h2><span class="hc-cap">Add what you want on Home</span><span class="hc-sp"></span><button type="button" class="hc-btn hc-icon hc-lib-close" aria-label="Close" title="Close (Escape)">${CROSS}</button></div>`
        + '<div class="hc-lib-list"></div><div class="hc-lib-foot"><button type="button" class="hc-btn hc-arrange" title="Move cards about on Home, or take them off">Arrange Home</button><button type="button" class="hc-btn hc-reset" title="Put the usual cards back: Needs you, Recent, Running now, Token usage, Quick start">Reset Home</button></div>';
      (host.parentNode || doc.body).append(dialog);          // (beside Home, not under <body>: the side bar hides what it does not know there)
      dialog.addEventListener("cancel", (e) => { e.preventDefault(); closeLibrary(); });
      dialog.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (libraryAdding) { libraryAdding = ""; drawLibrary(data?.() || {}); } else closeLibrary(); } });
      // A click outside it (on its backdrop) closes it.
      dialog.addEventListener("mousedown", (e) => { dialog.__out = e.target === dialog; });
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) { if (dialog.__out) closeLibrary(); return; }
        const t = e.target, item = t.closest(".hc-lib-item"), id = item?.dataset.card;
        if (t.closest(".hc-lib-close")) closeLibrary();
        else if (t.closest(".hc-arrange")) { closeLibrary(false); arrange(true, ".hc-done"); }
        else if (t.closest(".hc-reset")) { layout = { ...layout, order: [...DEFAULT] }; post?.({ type: "homeCardsReset" }); say("Home has its usual cards again."); draw(true); }
        else if (t.closest(".hc-add") && id) { if (id === "weather" && !layout.settings?.weather?.city) { libraryAdding = id; drawLibrary(data?.() || {}); } else add(id); }
        else if (t.closest(".hc-remove") && id) remove(id);
      });
      dialog.addEventListener("submit", (e) => {
        e.preventDefault();
        const city = e.target.querySelector(".hc-city")?.value.replace(/\s+/g, " ").trim();
        if (!city) return;
        libraryAdding = ""; weather = null; weatherAsked = Date.now();
        setting("weather", { city }); add("weather");
      });
      if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
      drawLibrary(data?.() || {});
      dialog.querySelector(".hc-lib-close").focus({ preventScroll: true });
      ask();
    }

    // ---- what is pressed ----------------------------------------------------------------------------------------------------
    host.addEventListener("click", (e) => {
      const t = e.target, card = t.closest(".hc-card"), id = card?.dataset.card;
      if (t.closest(".hc-cards-btn")) { openLibrary(); return; }
      if (t.closest(".hc-done")) { arrange(false); return; }
      if (t.closest(".hc-back")) { close(); return; }
      if (t.closest(".dgc-hub-retry")) { act?.("retry"); return; }
      if (!card) return;
      if (ui.arranging && card.parentNode === grid) { if (t.closest(".hc-x")) remove(id); e.preventDefault(); return; }
      const row = t.closest("[data-open]"), tab = t.closest("[data-tab]"), range = t.closest("[data-range]"), unit = t.closest("[data-unit]"), metric = t.closest('[role="tab"][data-metric]');
      if (metric) { chooseMetric(metric.dataset.metric, false); return; }
      if (range) { ui.token.range = range.dataset.range; focusNext = `.hc-open [data-range="${range.dataset.range}"]`; cancelAnimationFrame(pending); drawNow(); return; }
      if (unit) { setting("weather", { unit: unit.dataset.unit }); focusNext = `${ui.open ? ".hc-open" : ".hc-grid"} .hc-weather [data-unit="${unit.dataset.unit}"]`; draw(); return; }
      if (t.closest(".hc-city-edit")) { ui.weatherEdit = true; cancelAnimationFrame(pending); drawNow(); opened.querySelector(".hc-city")?.focus(); return; }
      if (t.closest(".hc-clear")) { act?.("clear"); return; }
      if (t.closest(".hc-viewall")) { open(id); return; }
      if (t.closest("[data-new]")) { act?.("new", t.closest("[data-new]").dataset.new); return; }
      if (t.closest("[data-quick]")) { act?.("new", t.closest("[data-quick]").dataset.quick); return; }
      if (t.closest("[data-here]")) { act?.("here", t.closest("[data-here]").dataset.here); return; }
      if (t.closest("[data-folder]")) { if (!t.closest(".hc-gone")) act?.("folder", t.closest("[data-folder]").dataset.folder); return; }
      if (row) { act?.("open", row.dataset.open); return; }
      if (tab) { act?.("tab", tab.dataset.tab); return; }
      // A Small card opens to its full form (a press on one of its own buttons, or in a hub's card, is that button's).
      if (card.dataset.form === "s" && card.parentNode === grid && id !== "quick" && !t.closest("button, a, input, select, textarea, .dgc-hub-card")) open(id);
    });
    host.addEventListener("submit", (e) => {
      const form = e.target.closest(".hc-cityform"); if (!form) return;
      e.preventDefault();
      const city = form.querySelector(".hc-city").value.replace(/\s+/g, " ").trim();
      if (!city) return;
      ui.weatherEdit = false; weather = null; weatherAsked = Date.now();
      setting("weather", { city }); draw();
    });
    host.addEventListener("change", (e) => { if (e.target.matches?.(".hc-zone")) { setting("clock", { zone: e.target.value }); focusNext = `${ui.open ? ".hc-open" : ".hc-grid"} .hc-zone`; draw(); } });
    host.addEventListener("input", (e) => {
      if (!e.target.matches?.("textarea.hc-note")) return;
      const text = e.target.value.slice(0, 4000);
      layout = { ...layout, settings: { ...layout.settings, note: { text } } };
      view.clearTimeout(noteTimer); noteTimer = view.setTimeout(() => post?.({ type: "homeCardSetting", card: "note", settings: { text } }), 400);
    });
    host.addEventListener("contextmenu", (e) => { const card = e.target.closest(".hc-grid > .hc-card"); if (!card || e.target.closest("textarea, input, .dgc-hub-card")) return; e.preventDefault(); if (!ui.arranging) arrange(true, `.hc-grid .hc-card[data-card="${card.dataset.card}"]`); });
    host.addEventListener("pointerdown", (e) => { const card = e.target.closest(".hc-grid.hc-arranging > .hc-card"); if (card) dragStart(e, card); });
    host.addEventListener("pointermove", (e) => {
      if (drag) { dragMove(e); return; }
      const plot = e.target.closest?.(".hc-plot"); if (!plot || e.pointerType === "touch") return;
      const cols = plot.querySelectorAll(".hc-col"), r = plot.getBoundingClientRect(), at = Math.max(0, Math.min(cols.length - 1, Math.floor(((e.clientX - r.left) / r.width) * cols.length)));
      hot(cols[at]?.dataset.day || "");
    });
    host.addEventListener("pointerup", (e) => dragEnd(e));
    host.addEventListener("pointercancel", (e) => dragEnd(e, false));
    host.addEventListener("pointerout", (e) => { const plot = e.target.closest?.(".hc-plot"); if (plot && !plot.contains(e.relatedTarget) && doc.activeElement !== plot) hot(""); });
    host.addEventListener("focusout", (e) => { if (!filling && e.target.matches?.(".hc-plot") && !e.target.matches(":hover")) hot(""); });
    host.addEventListener("keydown", (e) => {
      const t = e.target, card = t.closest?.(".hc-card"), id = card?.dataset.card;
      if (t.matches?.(".hc-plot")) {
        const cols = [...t.querySelectorAll(".hc-col")], at = cols.findIndex((c) => c.dataset.day === ui.token.hot);
        if (e.key === "Escape" && at >= 0) { e.preventDefault(); e.stopPropagation(); hot(""); return; }
        const to = e.key === "ArrowLeft" ? (at < 0 ? cols.length - 1 : Math.max(0, at - 1)) : e.key === "ArrowRight" ? (at < 0 ? cols.length - 1 : Math.min(cols.length - 1, at + 1)) : e.key === "Home" ? 0 : e.key === "End" ? cols.length - 1 : -1;
        if (to >= 0) { e.preventDefault(); hot(cols[to].dataset.day); }
        return;
      }
      if (t.matches?.('[role="tab"][data-metric]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const tabs = [...t.parentNode.querySelectorAll('[role="tab"]')].map((b) => b.dataset.metric), at = tabs.indexOf(t.dataset.metric);
        chooseMetric(e.key === "Home" ? tabs[0] : e.key === "End" ? tabs.at(-1) : tabs[(at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length], true);
        return;
      }
      if (!card || t !== card) return;
      if (ui.arranging && card.parentNode === grid) {
        const at = layout.order.indexOf(id), cols = view.getComputedStyle(grid).gridTemplateColumns.split(" ").length;
        if (e.key === " " || e.key === "Enter") { e.preventDefault(); if (ui.lifted === id) drop(true); else { if (ui.lifted) drop(true); lift(id); } }
        else if (ui.lifted === id && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.key)) {
          e.preventDefault();
          const by = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -cols : cols;
          if (moveTo(id, at + by)) { flip(drawNow); card.focus({ preventScroll: true }); card.scrollIntoView?.({ block: "nearest" }); say(`${CARDS[id].name}, ${layout.order.indexOf(id) + 1} of ${layout.order.length}.`); }
        }
        else if ((e.key === "Delete" || e.key === "Backspace") && !ui.lifted) { e.preventDefault(); remove(id); }
        return;
      }
      if ((e.key === "Enter" || e.key === " ") && card.dataset.form === "s" && card.parentNode === grid) { e.preventDefault(); open(id); }
    });
    // Escape, wherever the keyboard is on Home: a lifted card goes back, Arrange Home ends, an opened card closes.
    const onKey = (e) => {
      if (e.key !== "Escape" || e.defaultPrevented || library || !host.checkVisibility?.() || doc.querySelector("dialog[open]")) return;
      if (drag?.lifted) { e.preventDefault(); dragEnd(null, false); }
      else if (ui.lifted) { e.preventDefault(); drop(false); }
      else if (ui.arranging) { e.preventDefault(); arrange(false); }
      else if (ui.open) { e.preventDefault(); close(); }
    };
    doc.addEventListener("keydown", onKey);

    // The side bar's edge dragged: a new form, and the cards glide to their places.
    let width = widthNow(), was = gridForm(width), sized = null;
    if (view.ResizeObserver) { sized = new view.ResizeObserver(() => { const w = widthNow(); if (!w || w === width) return; width = w; const g = gridForm(w); if (g !== was || g === "l") { was = g; draw(true); } }); sized.observe(host); }
    const tick = view.setInterval(() => { if (host.checkVisibility?.() && (layout.order.includes("clock") || layout.order.includes("recent"))) draw(); }, 20000);
    post?.({ type: "homeCardsReady" });
    drawNow();

    return {
      update() { draw(); },
      /** The host's { type: "homeCards", order, settings }. */
      layout(next) {
        heard = true;
        const order = Array.isArray(next?.order) ? next.order.filter((id, i, all) => CARDS[id] && all.indexOf(id) === i) : layout.order;
        const changed = JSON.stringify(order) !== JSON.stringify(layout.order);
        if (ui.lifted || drag) return;      // a card is in the air: what the user holds wins
        const city = layout.settings?.weather?.city;
        layout = { order, settings: { ...(next?.settings && typeof next.settings === "object" ? next.settings : {}), ...(doc.activeElement?.matches?.("textarea.hc-note") ? { note: layout.settings?.note } : {}) } };
        if (city !== layout.settings?.weather?.city) { weather = null; weatherAt = 0; }
        draw(changed);
      },
      usage(report) { usage = { days: Array.isArray(report?.days) ? report.days : [], models: Array.isArray(report?.models) ? report.models : [], error: String(report?.error || "") }; usageAt = Date.now(); draw(); },
      weather(said) { weather = said && typeof said === "object" ? said : null; weatherAt = Date.now(); draw(); },
      open, close, opened: () => ui.open, arranging: () => ui.arranging, order: () => [...layout.order],
      closeLibrary: () => closeLibrary(false),
      /** Home is in front again: what it reads is read again when it is old. */
      shown() { ask(); },
      dispose() { doc.removeEventListener("keydown", onKey); sized?.disconnect(); view.clearInterval(tick); closeLibrary(false); },
    };
  }

  root.DgcHomeCards = Object.freeze({ create, CARDS, TYPES, DEFAULT });
})();
