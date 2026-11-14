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
// Since the second follow-up (13 Nov, late): Weather's place is chosen from the places Open-Meteo's search finds for the
// letters typed (the host asks; Save waits for a choice); a Clock's city is any time zone there is, found by
// typing; both use one small dropdown under their field (Up, Down, Enter, Escape; the menu's look, the one corner).
// Since 14 Nov: the Clock is Here and up to three more time zones (four in all), each added one with an × (shown when
// its clock is pointed at or has the keyboard); its Small card is Here alone; with three or four clocks it is a Large
// card in a wide side bar. Adding Weather always asks for the place (the saved one is in the field); Change place is on
// every size (a card with no room for the field opens whole at it); a weather that could not be read offers Try again
// and is asked again after a minute.
// Token usage names the models with their provider and share, and links to Settings. Notes is many notes: a list, a
// note open beside it or over it, search, pins, tick boxes, Undo. Widgets and Artifacts page through what the Library lists.
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
    widgets: { name: "Widgets", line: "The widgets made for you, one at a time", group: "Made for you", large: true },
    artifacts: { name: "Artifacts", line: "Pages, documents, slides, sheets and dashboards", group: "Made for you", large: true },
    token: { name: "Token usage", line: "Tokens, requests and cache, day by day", group: "Usage and start", large: true },
    quick: { name: "Quick start", line: "New session, chat or Pip", group: "Usage and start" },
    folders: { name: "Folders", line: "Your Work folders, each a tile", group: "Usage and start", large: true },
    clock: { name: "Clock", line: "The time here, and in up to three more cities", group: "Everyday" },
    weather: { name: "Weather", line: "Now and the next hours, for a place you choose", group: "Everyday" },
    note: { name: "Notes", line: "Your notes, kept on this computer", group: "Everyday", large: true },
  };
  const TYPES = Object.keys(CARDS);
  // Every time zone there is (IANA), for the Clock's added cities: the engine's own list where it has one, else this one,
  // shipped with the card ("Region:City,City|Region:..."). A zone's city is its last part; a few are better known by a
  // newer name than the one the engine keeps ("Asia/Calcutta" is Kolkata), and a few big cities share another's zone.
  const ZONE_LIST = "Africa:Abidjan,Accra,Addis_Ababa,Algiers,Asmera,Bamako,Bangui,Banjul,Bissau,Blantyre,Brazzaville,Bujumbura,Cairo,Casablanca,Ceuta,Conakry,Dakar,Dar_es_Salaam,Djibouti,Douala,El_Aaiun,Freetown,Gaborone,Harare,Johannesburg,Juba,Kampala,Khartoum,Kigali,Kinshasa,Lagos,Libreville,Lome,Luanda,Lubumbashi,Lusaka,Malabo,Maputo,Maseru,Mbabane,Mogadishu,Monrovia,Nairobi,Ndjamena,Niamey,Nouakchott,Ouagadougou,Porto-Novo,Sao_Tome,Tripoli,Tunis,Windhoek|America:Adak,Anchorage,Anguilla,Antigua,Araguaina,Argentina/La_Rioja,Argentina/Rio_Gallegos,Argentina/Salta,Argentina/San_Juan,Argentina/San_Luis,Argentina/Tucuman,Argentina/Ushuaia,Aruba,Asuncion,Bahia,Bahia_Banderas,Barbados,Belem,Belize,Blanc-Sablon,Boa_Vista,Bogota,Boise,Buenos_Aires,Cambridge_Bay,Campo_Grande,Cancun,Caracas,Catamarca,Cayenne,Cayman,Chicago,Chihuahua,Ciudad_Juarez,Coral_Harbour,Cordoba,Costa_Rica,Coyhaique,Creston,Cuiaba,Curacao,Danmarkshavn,Dawson,Dawson_Creek,Denver,Detroit,Dominica,Edmonton,Eirunepe,El_Salvador,Fort_Nelson,Fortaleza,Glace_Bay,Godthab,Goose_Bay,Grand_Turk,Grenada,Guadeloupe,Guatemala,Guayaquil,Guyana,Halifax,Havana,Hermosillo,Indiana/Knox,Indiana/Marengo,Indiana/Petersburg,Indiana/Tell_City,Indiana/Vevay,Indiana/Vincennes,Indiana/Winamac,Indianapolis,Inuvik,Iqaluit,Jamaica,Jujuy,Juneau,Kentucky/Monticello,Kralendijk,La_Paz,Lima,Los_Angeles,Louisville,Lower_Princes,Maceio,Managua,Manaus,Marigot,Martinique,Matamoros,Mazatlan,Mendoza,Menominee,Merida,Metlakatla,Mexico_City,Miquelon,Moncton,Monterrey,Montevideo,Montserrat,Nassau,New_York,Nome,Noronha,North_Dakota/Beulah,North_Dakota/Center,North_Dakota/New_Salem,Ojinaga,Panama,Paramaribo,Phoenix,Port-au-Prince,Port_of_Spain,Porto_Velho,Puerto_Rico,Punta_Arenas,Rankin_Inlet,Recife,Regina,Resolute,Rio_Branco,Santarem,Santiago,Santo_Domingo,Sao_Paulo,Scoresbysund,Sitka,St_Barthelemy,St_Johns,St_Kitts,St_Lucia,St_Thomas,St_Vincent,Swift_Current,Tegucigalpa,Thule,Tijuana,Toronto,Tortola,Vancouver,Whitehorse,Winnipeg,Yakutat|Antarctica:Casey,Davis,DumontDUrville,Macquarie,Mawson,McMurdo,Palmer,Rothera,Syowa,Troll,Vostok|Arctic:Longyearbyen|Asia:Aden,Almaty,Amman,Anadyr,Aqtau,Aqtobe,Ashgabat,Atyrau,Baghdad,Bahrain,Baku,Bangkok,Barnaul,Beirut,Bishkek,Brunei,Calcutta,Chita,Colombo,Damascus,Dhaka,Dili,Dubai,Dushanbe,Famagusta,Gaza,Hebron,Hong_Kong,Hovd,Irkutsk,Jakarta,Jayapura,Jerusalem,Kabul,Kamchatka,Karachi,Katmandu,Khandyga,Krasnoyarsk,Kuala_Lumpur,Kuching,Kuwait,Macau,Magadan,Makassar,Manila,Muscat,Nicosia,Novokuznetsk,Novosibirsk,Omsk,Oral,Phnom_Penh,Pontianak,Pyongyang,Qatar,Qostanay,Qyzylorda,Rangoon,Riyadh,Saigon,Sakhalin,Samarkand,Seoul,Shanghai,Singapore,Srednekolymsk,Taipei,Tashkent,Tbilisi,Tehran,Thimphu,Tokyo,Tomsk,Ulaanbaatar,Urumqi,Ust-Nera,Vientiane,Vladivostok,Yakutsk,Yekaterinburg,Yerevan|Atlantic:Azores,Bermuda,Canary,Cape_Verde,Faeroe,Madeira,Reykjavik,South_Georgia,St_Helena,Stanley|Australia:Adelaide,Brisbane,Broken_Hill,Darwin,Eucla,Hobart,Lindeman,Lord_Howe,Melbourne,Perth,Sydney|Europe:Amsterdam,Andorra,Astrakhan,Athens,Belgrade,Berlin,Bratislava,Brussels,Bucharest,Budapest,Busingen,Chisinau,Copenhagen,Dublin,Gibraltar,Guernsey,Helsinki,Isle_of_Man,Istanbul,Jersey,Kaliningrad,Kiev,Kirov,Lisbon,Ljubljana,London,Luxembourg,Madrid,Malta,Mariehamn,Minsk,Monaco,Moscow,Oslo,Paris,Podgorica,Prague,Riga,Rome,Samara,San_Marino,Sarajevo,Saratov,Simferopol,Skopje,Sofia,Stockholm,Tallinn,Tirane,Ulyanovsk,Vaduz,Vatican,Vienna,Vilnius,Volgograd,Warsaw,Zagreb,Zurich|Indian:Antananarivo,Chagos,Christmas,Cocos,Comoro,Kerguelen,Mahe,Maldives,Mauritius,Mayotte,Reunion|Pacific:Apia,Auckland,Bougainville,Chatham,Easter,Efate,Enderbury,Fakaofo,Fiji,Funafuti,Galapagos,Gambier,Guadalcanal,Guam,Honolulu,Kiritimati,Kosrae,Kwajalein,Majuro,Marquesas,Midway,Nauru,Niue,Norfolk,Noumea,Pago_Pago,Palau,Pitcairn,Ponape,Port_Moresby,Rarotonga,Saipan,Tahiti,Tarawa,Tongatapu,Truk,Wake,Wallis";
  const CITY = { Calcutta: "Kolkata", Katmandu: "Kathmandu", Rangoon: "Yangon", Saigon: "Ho Chi Minh City", Kiev: "Kyiv", Godthab: "Nuuk", Faeroe: "Faroe", Truk: "Chuuk", Ponape: "Pohnpei", Enderbury: "Kanton", Asmera: "Asmara", Thimbu: "Thimphu", Ujung_Pandang: "Makassar", Ulan_Bator: "Ulaanbaatar" };
  const ALSO = { "Asia/Calcutta": "Calcutta Delhi Mumbai Bengaluru Chennai India", "Asia/Kolkata": "Calcutta Delhi Mumbai Bengaluru Chennai India", "America/Los_Angeles": "San Francisco Seattle Pacific", "America/New_York": "Boston Washington Miami Eastern", "America/Chicago": "Dallas Houston Central",
    "America/Denver": "Mountain", "Asia/Shanghai": "Beijing China", "Europe/London": "UK Britain", "Europe/Berlin": "Germany Munich Frankfurt", "Europe/Paris": "France", "Asia/Tokyo": "Japan", "Australia/Sydney": "Canberra", "America/Sao_Paulo": "Rio Brazil", "Asia/Dubai": "Abu Dhabi UAE",
    "Asia/Saigon": "Saigon Vietnam Hanoi", "Asia/Ho_Chi_Minh": "Saigon Vietnam Hanoi", "Europe/Kiev": "Kiev Ukraine", "Europe/Kyiv": "Kiev Ukraine", "Europe/Istanbul": "Turkey Ankara", "America/Toronto": "Ottawa", "Africa/Johannesburg": "Cape Town Pretoria", "Asia/Karachi": "Lahore Islamabad Pakistan" };
  let zonesKnown = null;
  /** Every time zone: [{ zone, city, region, find }], by city. */
  function zones() {
    if (zonesKnown) return zonesKnown;
    let ids = [];
    try { ids = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : []; } catch { ids = []; }
    if (ids.length < 100) ids = ZONE_LIST.split("|").flatMap((group) => { const [region, cities] = group.split(":"); return cities.split(",").map((c) => (region ? `${region}/${c}` : c)); });
    if (!ids.includes("UTC")) ids = [...ids, "UTC"];
    zonesKnown = ids.map((zone) => { const parts = zone.split("/"), last = parts[parts.length - 1], city = CITY[last] || last.replace(/_/g, " "), region = parts.slice(0, -1).join(", ").replace(/_/g, " ");
      return { zone, city, region, find: `${city} ${zone} ${zone.replace(/_/g, " ")} ${ALSO[zone] || ""}`.toLowerCase() }; }).sort((a, b) => a.city.localeCompare(b.city));
    return zonesKnown;
  }
  const zoneCity = (zone) => { const last = String(zone || "").split("/").pop(); return CITY[last] || last.replace(/_/g, " "); };
  const offsets = new Map();
  /** A zone's offset now, as "UTC+5:30" (kept for a quarter of an hour: an offset changes twice a year). */
  function zoneOffset(zone) {
    const slot = Math.floor(Date.now() / 900000), had = offsets.get(zone);
    if (had && had[0] === slot) return had[1];
    let said = "";
    try { const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortOffset" }).formatToParts(new Date()).find((x) => x.type === "timeZoneName"); said = String(part?.value || "").replace(/^GMT/, "UTC").replace("-", "−"); } catch { said = ""; }
    offsets.set(zone, [slot, said]);
    return said;
  }
  const mosaic = (palette, size, more = "") => `<span class="mosaic mosaic--${esc(palette)}" style="--size:${size}px${more}" aria-hidden="true"><i></i><i></i><i></i><i></i></span>`;
  const svg = (d, size = 12, w = 2.2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const PREV = svg('<path d="M15 18l-6-6 6-6"/>', 11, 2.6), NEXT = svg('<path d="M9 6l6 6-6 6"/>', 11, 2.6), BIN = svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>', 12, 2);
  const PIN_D = "M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z";
  const pinSvg = (on, size = 12) => `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="${on ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" aria-hidden="true"><path d="${PIN_D}"/></svg>`;
  const PLUS = svg('<path d="M12 5v14M5 12h14"/>', 11, 2.6), CROSS = svg('<path d="M6 6l12 12M18 6L6 18"/>', 10, 2.8), BACK = svg('<path d="M15 18l-6-6 6-6"/>', 12, 2.4), TICK = svg('<path d="M5 12l5 5L20 7"/>', 11, 3);
  const GRIP = '<svg class="hc-grip" width="12" height="16" viewBox="0 0 12 16" aria-hidden="true"><g fill="currentColor"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="3" r="1.4"/><circle cx="3" cy="8" r="1.4"/><circle cx="9" cy="8" r="1.4"/><circle cx="3" cy="13" r="1.4"/><circle cx="9" cy="13" r="1.4"/></g></svg>';
  const plural = (n, word, many) => `${n} ${n === 1 ? word : many || word + "s"}`;
  // The Clock: Here and at most this many added time zones (the host's own bound, src/homeCards.ts).
  const ZONES_MOST = 3;
  // What the Notes card holds at most (the host's own bounds, src/homeCards.ts).
  const NOTES_MOST = 500, NOTE_MOST = 20000;
  /** A place as words: its name, its region when that says more, its country. */
  const placeWords = (p) => [p.name, p.admin1 && p.admin1 !== p.name ? p.admin1 : "", p.country].filter(Boolean).join(", ");
  /** When something was last changed or made, in a word or two. */
  function ago(at) {
    const ms = Date.now() - Number(at), min = Math.floor(ms / 60000);
    if (!Number.isFinite(ms) || !(Number(at) > 0)) return "";
    if (min < 1) return "Just now";
    if (min < 60) return `${min} min ago`;
    if (min < 1440) return `${Math.floor(min / 60)} h ago`;
    if (min < 2880) return "Yesterday";
    if (min < 10080) return `${Math.floor(min / 1440)} days ago`;
    return SHORT_DAY(new Date(Number(at)));
  }
  /** As the Library says when: Today, Yesterday, a few days ago, then the date. */
  function madeWhen(stamp) {
    const at = Date.parse(String(stamp || "")); if (!Number.isFinite(at)) return "";
    const days = Math.floor((Date.now() - at) / 86400000);
    return days < 1 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? `${days} days ago` : SHORT_DAY(new Date(at));
  }
  const SHORT_DAY = (d) => new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", ...(d.getFullYear() === new Date().getFullYear() ? {} : { year: "numeric" }) }).format(d);
  const A_KIND = { doc: "Document", slides: "Slides", sheet: "Spreadsheet", page: "Page", dashboard: "Dashboard" };
  const A_MADE = { chat: "made in Chat", work: "made in Work", pip: "made by a Pip", sdk: "made by an app", cli: "made in the terminal" };
  /** A note's name: its first line with words in it (a tick box's line without its box). */
  const noteTitle = (text) => { const first = String(text || "").split("\n").find((l) => l.trim()) || ""; return first.replace(/^\s*- \[[ xX]\]\s*/, "").trim().slice(0, 120) || "New note"; };
  const TICK_LINE = /^(\s*)- \[([ xX])\] ?(.*)$/;

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
   *                      · "pin" folder path · "usage" · "widget" row · "artifact" row · "library" view
   *   post(message)      to the host: homeCardsReady / homeCardsSet / homeCardsReset / homeCardSetting / homeUsageGet / homeWeatherGet
   *                      / homeWeatherSuggest / homeNote / homeWidgetsGet / homeArtifactsGet
   *   slot(name)         the hub's own element for "needs" or "new"; slotted(name, form) tells the page it was placed
   *   kept() / keep(v)   the page's kept state for Home (which card is open)
   *   onDraw(node)       after a draw: the page starts the faces in `node`
   * layout(state), usage(report), weather(said), places(said) and made(kind, said) take the host's messages; update()
   * draws again from data().
   */
  function create({ host, data, act, post, slot, slotted, kept, keep, onDraw } = {}) {
    const doc = host.ownerDocument, view = doc.defaultView;
    const still = () => !!view.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    let layout = { order: [...DEFAULT], settings: {}, notes: [] }, heard = false;
    let usage = null, usageAt = 0, weather = null, weatherAt = 0, weatherAsked = 0, weatherWait = 30 * 60000, weatherRetried = "";
    // What the Library lists, for the Widgets and Artifacts cards: null until the host has said; when each was asked.
    const made = { widgets: null, artifacts: null }, madeAt = { widgets: 0, artifacts: 0 };
    const ui = { open: TYPES.includes(kept?.()?.open) ? kept().open : "", arranging: false, lifted: "", token: { metric: "tokens", hot: "", range: "30d" }, weatherEdit: false,
      // Notes: the note that is open, the one being typed in, what is searched for, the note just deleted (for Undo).
      notes: { open: "", editing: "", q: "", undo: null, fresh: "" } };
    let filling = false, library = null, libraryAdding = "", pending = 0, drag = null, liftedFrom = null, noteTimer = 0, noteDirty = "", undoTimer = 0, focusNext = "";
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
    /** The time zones added to the Clock, in their order: the list, or (kept before 14 Nov) the one second city. */
    const zonesNow = () => { const c = layout.settings?.clock, all = Array.isArray(c?.zones) ? c.zones : c?.zone ? [c.zone] : []; return all.filter((z, i) => typeof z === "string" && z && all.indexOf(z) === i).slice(0, ZONES_MOST); };
    // (A Clock of three or four is a Large card where there are Large cards: two rows of two, nothing cut.)
    const large = (id) => (id === "clock" ? zonesNow().length >= 2 : !!CARDS[id].large);
    const formOf = (id, g) => (g === "l" ? (large(id) ? "l" : "m") : g);

    // ---- what each card draws -----------------------------------------------------------------------------------------
    const li = (r, more = "") => `<button type="button" class="hc-li${r.fresh ? " hc-new" : ""}" data-open="${esc(r.key)}" title="${esc(r.title || `Open ${r.name}`)}"><span class="hc-ico">${r.icon || ""}</span><span class="hc-tx"><span class="hc-nm">${esc(r.name)}${r.star ? ' <span class="hc-star" title="Core, your main Pip">★</span>' : ""}</span>${r.meta ? `<span class="hc-meta">${esc(r.meta)}</span>` : ""}</span>${more || (r.fresh ? '<span class="hc-newmark">New</span>' : r.live ? '<span class="hc-livedot" title="Running"></span>' : r.count ? `<span class="hc-cnt">${r.count}</span>` : r.age ? `<span class="hc-age">${esc(r.age)}</span>` : "")}</button>`;
    const headOf = (title, cap = "", right = "") => `<div class="hc-ch"><span class="hc-ct">${esc(title)}</span>${cap}<span class="hc-sp"></span>${right}</div>`;
    const more = (n, tab, words) => (n > 0 ? `<button type="button" class="hc-lnk hc-more" data-tab="${tab}">${esc(words)}</button>` : "");
    const rowsFor = (form, tight) => (form === "full" ? 30 : form === "l" ? 6 : tight ? 2 : 3);

    function series(n, back = 0) {
      const by = new Map((usage?.days || []).map((d) => [d.date, d])), out = [], now = new Date();
      for (let k = n - 1 + back; k >= back; k--) {
        const key = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - k)), d = by.get(key);
        out.push({ date: key, input: d?.input_tokens || 0, output: d?.output_tokens || 0, cached: d?.cached_input_tokens || 0, requests: d?.requests || 0, models: Array.isArray(d?.models) ? d.models : [] });
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
      const models = usage.models || [], shownModels = form === "m" ? models.slice(0, 3) : form === "l" ? models.slice(0, 5) : [], restModels = Math.max(0, (Number(usage.modelCount) || models.length) - shownModels.length);
      const top = m.share ? 100 : nice(Math.max(...days.map(m.of))), rows = form === "m" ? 8 : form === "l" && shownModels.length ? 6 : 10;
      const tick = (v) => (m.share ? `${v}%` : v >= 1e6 ? `${+(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}K` : String(+v.toFixed(1)));
      const chart = `<div class="hc-chart"><div class="hc-y" aria-hidden="true"><span style="top:0%">${tick(top)}</span><span style="top:50%">${tick(top / 2)}</span><span style="top:100%">0</span></div>`
        + `<div class="hc-plot" tabindex="0" role="img" data-fk="plot" aria-label="${m.name} per day, last ${n} days. The arrow keys read a day."><span class="hc-grd" style="top:0%"></span><span class="hc-grd" style="top:50%"></span>${columns(days, metric, rows, top)}<span class="hc-line" hidden></span><div class="hc-tip" hidden></div></div>`
        + `<div class="hc-xs" aria-hidden="true"><span>${SHORT.format(dayOf(days[0].date))}</span><span>${SHORT.format(dayOf(days[Math.floor(n / 2)].date))}</span><span>Today</span><span class="hc-pin" hidden></span></div></div>`;
      const kt = `<div class="hc-kt hc-kt-${tabs.length}${form === "full" ? " hc-kt-wrap" : ""}" role="tablist" aria-label="What is counted">${tabs.map((id) => { const k = METRICS[id], c = change(id, days, before), on = id === metric;
        return `<button type="button" role="tab" class="hc-kb${on ? " on" : ""}" data-metric="${id}" data-fk="tab:${id}" aria-selected="${on}" tabindex="${on ? 0 : -1}"><span class="hc-kl">${form === "m" ? `<span class="hc-ki">${svg(k.icon, 11, 2.4)}</span>` : ""}${k.name}</span><span class="hc-kv">${k.say(k.total(days))}</span><span class="hc-kd">${delta(c, form === "l" ? "" : ` vs ${span}`)}</span></button>`; }).join("")}</div>`;
      // The models of the last thirty days, with their provider and share: three on a Medium card, five on a Large one,
      // the rest as "+N more"; and the way to Settings' own Token Usage page.
      const link = '<button type="button" class="hc-lnk hc-usage-link" title="Open Settings on Token Usage: every model, provider and day">Open Token Usage</button>';
      const named = form === "full" ? "" : `<div class="hc-models-wrap">${shownModels.length ? `${form === "m" ? '<span class="hc-bh">By model · last 30 days</span>' : ""}<div class="hc-models">${shownModels.map(modelLine).join("")}</div>` : ""}`
        + `<div class="hc-mfoot">${restModels ? `<span class="hc-models-more" title="${restModels} more ${restModels === 1 ? "model" : "models"} in the last 30 days">+${restModels} more</span>` : ""}<span class="hc-sp"></span>${link}</div></div>`;
      const top5 = models.slice(0, 5), most = Math.max(1, ...top5.map((r) => r.tokens));
      const by = form === "full" ? `${top5.length ? `<div class="hc-by"><span class="hc-bh">By model · last 30 days</span>${top5.map((r) => `<div class="hc-mr"><span class="hc-mt"><span class="hc-mn">${esc(r.model || r.name)}${r.provider ? `<span class="hc-mp"> · ${esc(r.provider)}</span>` : ""}</span><span class="hc-mv">${compact(r.tokens)}${Number.isFinite(r.share) ? ` · ${r.share}%` : ""}</span></span><span class="hc-track"><span class="hc-fill" style="width:${Math.max(2, Math.round((r.tokens / most) * 100))}%"></span></span></div>`).join("")}</div>` : ""}<div class="hc-mfoot"><span class="hc-sp"></span>${link}</div>` : "";
      return title + chart + named + kt + by;
    }
    /** A model on one line: its name, its provider, its share ("qwen3:8b · Ollama · 62%"); a long name gives way, never the share. */
    const modelSays = (r) => [r.model || r.name, r.provider, Number.isFinite(r.share) ? `${r.share}%` : ""].filter(Boolean).join(" · ");
    function modelLine(r) {
      return `<span class="hc-model" title="${esc(`${modelSays(r)}${r.where && r.where !== r.provider ? ` · on ${r.where}` : ""} · ${compact(r.tokens)} tokens`)}"><span class="hc-model-n">${esc(r.model || r.name)}</span>`
        + `${r.provider ? `<i class="hc-model-d">·</i><span class="hc-model-p">${esc(r.provider)}</span>` : ""}${Number.isFinite(r.share) ? `<i class="hc-model-d">·</i><span class="hc-model-s">${r.share}%</span>` : ""}</span>`;
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
          + (r.exists === false ? "" : `<button type="button" class="hc-here" data-here="${esc(r.folder)}" title="New session here" aria-label="New session in ${esc(r.name)}">${PLUS}</button>`
            + (x.pinned ? ((on) => `<button type="button" class="hc-pin" data-pin-folder="${esc(r.folder)}" aria-pressed="${on}" title="${on ? "Unpin from the dock" : "Pin to the dock"}" aria-label="${on ? "Unpin from the dock" : "Pin to the dock"}: ${esc(r.name)}">${pinSvg(on)}</button>`)(!!x.pinned(r.folder)) : "")) + "</div>"; };
      const shown = rows.slice(0, most), rest = rows.length - shown.length;
      if (form === "s") return `<span class="hc-lbl">Folders${rest > 0 ? `<span class="hc-cnt">+${rest}</span>` : ""}</span><span class="hc-tiles hc-tiles-1">${shown.map(tile).join("")}</span>`;
      return `${headOf("Folders", "", rest > 0 ? `<span class="hc-cap">+${rest} more</span>` : "")}<div class="hc-tiles">${shown.map(tile).join("")}</div>`;
    }
    function clockCard(form) {
      const now = new Date(), zs = zonesNow();
      const time = (zone) => { try { return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", ...(zone ? { timeZone: zone } : {}) }).format(now); } catch { return "--:--"; } };
      const date = DAY.format(now);
      // Small: the home zone alone, its time and its date (asked 14 Nov: never the others on a single cube).
      if (form === "s") return `<span class="hc-lbl">Clock</span><span class="hc-big">${time("")}</span><span class="hc-grow"></span><span class="hc-sub">${date}</span>`;
      // The day there, when it is not today's here.
      const dayThere = (zone) => { try { const key = (z) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", ...(z ? { timeZone: z } : {}) }).format(now), here = key(""), there = key(zone); return there > here ? "tomorrow" : there < here ? "yesterday" : ""; } catch { return ""; } };
      // The field that adds a city, while there are fewer than four clocks: it offers every time zone there is, narrowed
      // by what is typed (it holds no words of its own, so typing in it never draws the card again).
      const pick = zs.length < ZONES_MOST ? '<input class="hc-zone hc-field" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" data-fk="zone" placeholder="Add a city" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="60" aria-label="Add a city’s time: type a city or a time zone">' : "";
      // An added zone: its time, its city (never cut: its offset and its day go to a second line first), and its ×.
      const one = (z) => { const city = zoneCity(z), off = zoneOffset(z), day = dayThere(z);
        return `<span class="hc-clock" data-zone="${esc(z)}"><span class="hc-time">${time(z)}</span><span class="hc-sub"><span class="hc-zc">${esc(city)}</span>${off ? ` <span class="hc-zo">· ${esc(off)}</span>` : ""}${day ? ` <span class="hc-zo">· ${day}</span>` : ""}</span>`
          + `<button type="button" class="hc-zone-x" data-zone-x="${esc(z)}" data-fk="zone-x:${esc(z)}" aria-label="Remove ${esc(city)}" title="Remove ${esc(city)} from the Clock">${CROSS}</button></span>`; };
      return `${headOf("Clock", `<span class="hc-cap hc-cut">${date}</span>`, pick)}<div class="hc-clocks" data-n="${zs.length + 1}"><span class="hc-clock"><span class="hc-time">${time("")}</span><span class="hc-sub">Here</span></span>${zs.map(one).join("")}</div>`;
    }
    const SENT = "The letters you type are sent to Open-Meteo to look the place up. Nothing else is sent.";
    /** The place the Weather card is set to: one chosen from the list, or (kept from before the list) a city typed. */
    const placeOf = (w = layout.settings?.weather) => (w?.place?.name ? w.place : w?.city ? { name: w.city, admin1: "", country: "" } : null);
    /** The field a place is chosen in: Save is off until a place from the list is taken. */
    const placeForm = (label, cls = "hc-save", cancel = false) => `<form class="hc-cityform"><input class="hc-city hc-field" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="listbox" data-fk="city" maxlength="80" placeholder="City" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="City: type a few letters, then choose a place from the list"><button type="submit" class="hc-btn hc-solid ${cls}" disabled title="Choose a place from the list first">${label}</button>${cancel ? '<button type="button" class="hc-btn hc-city-cancel" title="Keep the place as it is (Escape)">Cancel</button>' : ""}</form>`;
    function weatherCard(form, tight) {
      const w = layout.settings?.weather || {}, at = placeOf(w), f = w.unit === "f", deg = (c) => (Number.isFinite(c) ? `${Math.round(f ? (c * 9) / 5 + 32 : c)}°` : "–");
      const field = (label, cancel = false) => `${placeForm(label, "hc-save", cancel)}<p class="hc-fine">${SENT}</p>`;
      if (!at) return form === "s" ? '<span class="hc-lbl">Weather</span><span class="hc-grow"></span><span class="hc-mid">Choose a place</span><span class="hc-sub">Open to choose one</span>' : `${headOf("Weather")}${field("Save")}`;
      const said = placeWords({ ...at, admin1: "" });
      const bad = weather && weather.ok === false ? (weather.reason === "notfound" ? `Couldn’t find “${at.name}”. Choose a place from the list.` : weather.reason === "refused" ? "The weather service isn’t answering right now." : "Can’t reach the weather right now.") : "";
      const unit = `<span class="hc-seg" role="group" aria-label="Unit">${[["c", "°C"], ["f", "°F"]].map(([id, name]) => `<button type="button" data-unit="${id}" aria-pressed="${(f ? "f" : "c") === id}"${(f ? "f" : "c") === id ? ' class="on"' : ""}>${name}</button>`).join("")}</span>`;
      // Change place, on every size (asked 14 Nov): the field shows in a card that has the room for it (the card opened,
      // and a Medium card that is as tall as it needs); from a Small card, and a Medium one of a fixed height, it opens
      // the card whole at the field. Try again: the weather is asked for now.
      const change = '<button type="button" class="hc-lnk hc-city-edit" data-fk="city-edit" title="Choose another place">Change place</button>';
      const retry = bad && weather.reason !== "notfound" ? '<button type="button" class="hc-lnk hc-wx-retry" data-fk="wx-retry" title="Ask for the weather again">Try again</button>' : "";
      const roomy = form === "full" || (form === "m" && !tight), editing = roomy && ui.weatherEdit;
      const foot = (credit) => (editing ? `${credit ? '<span class="hc-fine">Weather from Open-Meteo</span>' : ""}${field("Save", true)}`
        : `<div class="hc-wfoot">${credit ? '<span class="hc-fine">Weather from Open-Meteo</span>' : retry}<span class="hc-sp"></span>${change}</div>${form === "full" ? `<p class="hc-fine">${SENT}</p>` : ""}`);
      if (!weather || bad) {
        if (form === "s") return `<span class="hc-lbl">Weather<span class="hc-wplace hc-cut">${esc(at.name)}</span></span><span class="hc-mid hc-wbad">${esc(bad ? (weather.reason === "notfound" ? "Place not found" : weather.reason === "refused" ? "The weather service isn’t answering" : "Can’t reach the weather") : "Looking…")}</span><span class="hc-grow"></span><span class="hc-wfoot hc-wfoot-s">${retry}${change}</span>`;
        return `${headOf("Weather", `<span class="hc-cap hc-cut">${esc(said)}</span>`, unit)}<p class="hc-quiet">${esc(bad || "Looking up the weather…")}</p>${foot(false)}`;
      }
      if (form === "s") return `<span class="hc-lbl">Weather${wx(weather.now.code, weather.now.day, 18)}</span><span class="hc-big">${deg(weather.now.temp)}</span><span class="hc-grow"></span><span class="hc-sub">${wxWord(weather.now.code)}</span><span class="hc-sub hc-cut">${esc(weather.place)}</span><span class="hc-wfoot hc-wfoot-s">${change}</span>`;
      return `${headOf("Weather", `<span class="hc-cap hc-cut">${esc(weather.place)}</span>`, unit)}<div class="hc-wnow">${wx(weather.now.code, weather.now.day, 30)}<span class="hc-time">${deg(weather.now.temp)}</span><span class="hc-tx"><span class="hc-nm">${wxWord(weather.now.code)}</span><span class="hc-meta">High ${deg(weather.high)} · Low ${deg(weather.low)}</span></span></div>`
        + `<div class="hc-hours">${(weather.hours || []).slice(0, 5).map((h) => `<span class="hc-hour"><span class="hc-sub">${esc(h.time)}</span><span class="hc-hrow">${wx(h.code, true, 15)}<span class="hc-hv">${deg(h.temp)}</span></span></span>`).join("")}</div>${foot(true)}`;
    }

    // ---- Notes: many notes, each named by its first line ------------------------------------------------------------------
    /** The notes, pinned first, then the latest changed; `q` keeps those with those words in them. */
    function notesNow(q = "") {
      const all = [...(layout.notes || [])].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.at - a.at), find = q.trim().toLowerCase();
      return find ? all.filter((n) => n.text.toLowerCase().includes(find)) : all;
    }
    const noteOf = (id) => (layout.notes || []).find((n) => n.id === id) || null;
    const noteRow = (n, on) => { const rest = n.text.split("\n").map((l) => l.trim()).filter(Boolean).slice(1).join(" · ").replace(/- \[[ xX]\]\s*/g, "");
      return `<button type="button" class="hc-li hc-note-row${on ? " on" : ""}" data-note="${esc(n.id)}" title="Open this note"${on ? ' aria-current="true"' : ""}><span class="hc-tx"><span class="hc-nm">${esc(noteTitle(n.text))}</span><span class="hc-meta">${esc([ago(n.at), rest.slice(0, 80)].filter(Boolean).join(" · "))}</span></span>${n.pinned ? `<span class="hc-note-pinmark" title="Pinned to the top">${pinSvg(true, 10)}</span>` : ""}</button>`; };
    const full500 = () => (layout.notes || []).length >= NOTES_MOST;
    const newNote = (cls = "") => `<button type="button" class="hc-btn hc-solid hc-note-new${cls}"${full500() ? ` disabled title="${NOTES_MOST} notes is the most. Delete one to add another."` : ' title="Start a new note"'}>${PLUS}New note</button>`;
    const undoBar = () => (ui.notes.undo ? `<div class="hc-note-undo" role="status"><span>Note deleted.</span><button type="button" class="hc-lnk hc-undo" title="Bring the note back">Undo</button></div>` : "");
    /** The open note: its tools (when it was changed, Edit or Done, pin, delete), then its words: read, with a tick box
     *  for each "- [ ]" line, or typed into (the words themselves are put in after the draw, never drawn again while typing). */
    function notePane(n, back) {
      if (!n) return '<div class="hc-note-pane"><p class="hc-quiet">No note is open. Choose one, or start a new one.</p></div>';
      const editing = ui.notes.editing === n.id, lines = n.text.split("\n");
      const view = lines.map((line, k) => { const tick = TICK_LINE.exec(line);
        return tick ? `<label class="hc-check" style="margin-left:${Math.min(4, Math.floor(tick[1].length / 2)) * 14}px"><input type="checkbox" data-line="${k}"${tick[2] === " " ? "" : " checked"}><span>${esc(tick[3])}</span></label>` : `<span class="hc-note-ln${k === lines.findIndex((l) => l.trim()) ? " hc-note-title" : ""}">${esc(line) || "&nbsp;"}</span>`; }).join("");
      return `<div class="hc-note-pane" data-note="${esc(n.id)}"><div class="hc-note-tools">${back ? `<button type="button" class="hc-lnk hc-note-all" title="Back to all your notes">${BACK}All notes</button>` : ""}<span class="hc-cap hc-cut">${n.at ? `Changed ${esc(ago(n.at).replace(/^Just now$/, "just now").replace(/^Yesterday$/, "yesterday"))}` : "New"}</span><span class="hc-sp"></span>`
        + `<button type="button" class="hc-btn hc-note-mode" data-fk="note-mode" title="${editing ? "Finish typing (Escape)" : "Type in this note"}">${editing ? "Done" : "Edit"}</button>`
        + `<button type="button" class="hc-btn hc-icon hc-note-pin" data-fk="note-pin" aria-pressed="${n.pinned}" title="${n.pinned ? "Unpin: let it fall back among the others" : "Pin to the top of your notes"}" aria-label="${n.pinned ? "Unpin this note" : "Pin this note to the top"}">${pinSvg(n.pinned)}</button>`
        + `<button type="button" class="hc-btn hc-icon hc-note-del" title="Delete this note (Undo brings it back)" aria-label="Delete this note">${BIN}</button></div>`
        + (editing ? `<textarea class="hc-note-edit hc-field" data-note="${esc(n.id)}" data-fk="note-edit" maxlength="${NOTE_MOST}" placeholder="Write a note… Its first line is its name. A line that starts “- [ ]” is a tick box." aria-label="Note"></textarea><p class="hc-fine hc-note-limit" hidden>${NOTE_MOST.toLocaleString("en-US")} characters is the most for one note.</p>`
          : `<div class="hc-note-view" data-note="${esc(n.id)}" title="Click to type in this note">${n.text.trim() ? view : '<span class="hc-quiet">Empty. Click to write.</span>'}</div>`) + "</div>";
    }
    function noteCard(form) {
      const all = notesNow(), count = all.length;
      if (form === "s") { const newest = [...all].sort((a, b) => b.at - a.at)[0];
        return `<span class="hc-lbl">Notes</span><span class="hc-mid hc-note-line hc-grow">${newest ? esc(noteTitle(newest.text)) : '<span class="hc-sub">No notes yet. Open to write one.</span>'}</span>${count > 1 ? `<span class="hc-sub">+${count - 1} ${count === 2 ? "note" : "notes"}</span>` : ""}`; }
      const none = '<p class="hc-quiet">No notes yet. New note starts one: its first line is its name.</p>';
      if (form === "m") { const shown = all.slice(0, 4);
        return `${headOf("Notes", '<span class="hc-cap hc-cut">Kept on this computer</span>', `${count ? '<button type="button" class="hc-lnk hc-viewall" title="Open Notes whole: every note, search, and the note you open">View all</button>' : ""}${newNote()}`)}${undoBar()}${shown.length ? `<div class="hc-list">${shown.map((n) => noteRow(n, false)).join("")}</div>${count > shown.length ? `<span class="hc-more-n">${count - shown.length} more</span>` : ""}` : none}`; }
      // Large: the list beside the open note. Opened: the whole app (search, the list, the note): side by side when
      // there is the room for both, else the list, and the note over it with All notes to go back.
      const wide = form === "l" || widthNow() >= 560, found = form === "full" ? notesNow(ui.notes.q) : all;
      const open = noteOf(ui.notes.open) || (wide && !ui.notes.q ? all[0] : wide ? found[0] : null) || null;
      const list = `<div class="hc-notes-list">${found.length ? `<div class="hc-list">${found.slice(0, form === "l" ? 40 : NOTES_MOST).map((n) => noteRow(n, !!open && n.id === open.id)).join("")}</div>` : ui.notes.q ? `<p class="hc-quiet">No note has “${esc(ui.notes.q.trim())}”.</p>` : none}</div>`;
      const head = form === "l" ? headOf("Notes", `<span class="hc-cap hc-cut">${plural(count, "note")}</span>`, newNote())
        : `${headOf("Notes", `<span class="hc-cap hc-cut">${plural(count, "note")} · kept on this computer</span>`)}<div class="hc-notes-bar"><input class="hc-note-find hc-field" type="search" data-fk="note-find" placeholder="Search notes" aria-label="Search your notes" autocomplete="off" spellcheck="false" maxlength="200">${newNote()}</div>`;
      if (wide) return `${head}${undoBar()}<div class="hc-notes-app">${list}${count || open ? notePane(open, false) : ""}</div>`;
      return open && !ui.notes.q ? `${headOf("Notes", `<span class="hc-cap hc-cut">${plural(count, "note")}</span>`, newNote())}${undoBar()}${notePane(open, true)}` : `${head}${undoBar()}${list}`;
    }

    // ---- Widgets and Artifacts: what the Library lists, a page at a time ---------------------------------------------------
    const PER = { widgets: { s: 1, m: 1, l: 2 }, artifacts: { s: 1, m: 2, l: 4 } };
    const rowsOf = (id) => (Array.isArray(made[id]?.rows) ? made[id].rows : []);
    /** The page a card shows: the one that holds the thing it showed last (kept by the host). */
    function pageOf(id, per) {
      const rows = rowsOf(id), shown = layout.settings?.[id]?.shown || "", at = Math.max(0, rows.findIndex((r) => r.id === shown));
      return { page: Math.floor(at / per), pages: Math.max(1, Math.ceil(rows.length / per)) };
    }
    function turn(id, form, to) {
      const per = PER[id][form] || 1, rows = rowsOf(id), { page, pages } = pageOf(id, per), next = Math.max(0, Math.min(pages - 1, to === "prev" ? page - 1 : to === "next" ? page + 1 : Number(to)));
      if (!rows.length || next === page || !Number.isFinite(next)) return false;
      const shown = rows[next * per].id;
      setting(id, { shown });
      say(`${CARDS[id].name}: page ${next + 1} of ${pages}.`);
      cancelAnimationFrame(pending); drawNow();
      return true;
    }
    function tileOf(id, r, d, form) {
      const picture = id === "widgets" ? (d.widgets?.mark ? d.widgets.mark(r.id) : "") : (d.artifacts?.sheet ? d.artifacts.sheet(r.type) : "");
      const sub = id === "widgets" ? [`in “${r.chat_title || "a chat"}”`, r.project_name || "", madeWhen(r.created_at)].filter(Boolean).join(" · ") : [A_KIND[r.type] || "Artifact", A_MADE[r.surface] || "", madeWhen(r.at)].filter(Boolean).join(" · ");
      const title = r.title || (id === "widgets" ? "Interactive" : A_KIND[r.type] || "Artifact");
      const inner = `<span class="hc-tile-pic">${picture}</span><span class="hc-tile-tx"><span class="hc-tile-t">${esc(title)}</span><span class="hc-tile-s">${esc(sub)}</span></span>`;
      // On a Small card the square itself opens the card whole; from Medium up each one opens what it is.
      return form === "s" ? `<span class="hc-mtile" data-tile="${esc(r.id)}">${inner}</span>` : `<button type="button" class="hc-mtile" data-tile="${esc(r.id)}" title="${esc(id === "widgets" ? `Open ${title} beside you` : `Open ${title} in an editor tab`)}">${inner}</button>`;
    }
    function stackCard(id, form, d) {
      const name = CARDS[id].name, said = made[id], rows = rowsOf(id), all = id === "widgets" ? "All widgets" : "All artifacts";
      const link = `<button type="button" class="hc-lnk hc-all" data-library="${id}" title="Open the Library on ${name}">${all}</button>`;
      const quiet = !said ? "Looking…" : said.offered === false ? `This DGC keeps no ${id}. Update DGC to see them here.`
        : id === "widgets" ? "No widgets yet. Ask Work or Chat for a widget (a calculator, a timer, a quiz), and it shows here." : "No artifacts yet. Ask Work or Chat for a page, a document, slides, a sheet or a dashboard, and it shows here.";
      if (!rows.length) return form === "s" ? `<span class="hc-lbl">${name}</span><span class="hc-grow"></span><span class="hc-sub">${esc(!said ? "Looking…" : said.offered === false ? `This DGC keeps no ${id}` : `No ${id} yet`)}</span>`
        : `${headOf(name, "", said && said.offered !== false ? link : "")}<p class="hc-quiet">${esc(quiet)}</p>`;
      if (form === "full") return `${headOf(name, `<span class="hc-cap hc-cut">${rows.length}${said.more ? "+" : ""}, newest first</span>`, link)}<div class="hc-stack hc-stack-all" data-per="all">${rows.map((r) => tileOf(id, r, d, form)).join("")}</div>`;
      const per = PER[id][form], { page, pages } = pageOf(id, per), shown = rows.slice(page * per, page * per + per);
      const dots = pages > 8 ? `<span class="hc-pages">${page + 1} / ${pages}</span>` : Array.from({ length: pages }, (_, k) => `<button type="button" class="hc-dot" data-page="${k}" tabindex="-1" aria-label="Page ${k + 1} of ${pages}"${k === page ? ' aria-current="true"' : ""}></button>`).join("");
      const pager = `<div class="hc-pager" role="group" aria-label="${name}: pages"><button type="button" class="hc-btn hc-icon hc-prev" data-fk="prev" aria-label="Earlier page" title="Earlier (Left)"${page ? "" : " disabled"}>${PREV}</button><span class="hc-dots">${dots}</span><button type="button" class="hc-btn hc-icon hc-next" data-fk="next" aria-label="Next page" title="Next (Right)"${page < pages - 1 ? "" : " disabled"}>${NEXT}</button></div>`;
      const stack = `<div class="hc-stack" data-per="${per}" data-fk="stack" tabindex="0" role="group" aria-roledescription="carousel" aria-label="${name}, page ${page + 1} of ${pages}. Left and Right turn the page.">${shown.map((r) => tileOf(id, r, d, form)).join("")}</div>`;
      return (form === "s" ? `<span class="hc-lbl">${name}<span class="hc-cnt">${rows.length}${said.more ? "+" : ""}</span></span>` : headOf(name, "", link)) + stack + pager;
    }
    const render = (id, form, d, tight) => (id === "token" ? tokenCard(form) : id === "recent" ? recentCard(form, d, tight) : id === "needs" ? needsCard(form, d) : id === "running" ? runningCard(form, d, tight)
      : id === "quick" ? quickCard(form, d) : id === "folders" ? foldersCard(form, d) : id === "clock" ? clockCard(form) : id === "weather" ? weatherCard(form, tight) : id === "note" ? noteCard(form)
      : id === "widgets" || id === "artifacts" ? stackCard(id, form, d) : listCard(id, form, d, tight));
    /** A card's one line while Home is arranged, and its small preview in the library. */
    function caption(id, d) {
      return id === "needs" ? (d.needs?.count ? `${d.needs.count} waiting` : "Nothing waiting") : id === "running" ? ((d.running || []).length ? `${d.running.length} running` : "Nothing running") : id === "recent" ? "Work, chats and Pips"
        : id === "token" ? "Tokens, requests, cache" : id === "quick" ? "New session · chat · Pip" : id === "work" ? plural(d.work?.total || 0, "session") : id === "chats" ? plural(d.chats?.total || 0, "chat") : id === "pips" ? plural(d.pips?.total || 0, "Pip")
        : id === "folders" ? plural((d.folders?.rows || []).length, "folder") : id === "clock" ? "The time here" : id === "weather" ? placeOf()?.name || "A place you choose"
        : id === "widgets" ? (made.widgets ? plural(rowsOf("widgets").length, "widget") : "The widgets made for you") : id === "artifacts" ? (made.artifacts ? plural(rowsOf("artifacts").length, "artifact") : "What was made for you") : plural((layout.notes || []).length, "note");
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
      if (id === "weather") return weather?.ok && placeOf() ? `${wx(weather.now.code, weather.now.day, 20)}<span class="hc-pvt">${Math.round(layout.settings.weather.unit === "f" ? (weather.now.temp * 9) / 5 + 32 : weather.now.temp)}°</span>` : `${wx(1, true, 20)}<span class="hc-pvw">A place you choose</span>`;
      if (id === "widgets") return rowsOf(id).slice(0, 3).map((r) => (d.widgets?.mark ? d.widgets.mark(r.id) : "")).join("") || `<span class="hc-pvw">${esc(CARDS[id].line)}</span>`;
      if (id === "artifacts") return rowsOf(id).slice(0, 3).map((r) => `<span class="hc-ico">${d.artifacts?.sheet ? d.artifacts.sheet(r.type) : ""}</span>`).join("") || `<span class="hc-pvw">${esc(CARDS[id].line)}</span>`;
      const newest = notesNow()[0];
      return `<span class="hc-pvw hc-note-line">${esc(newest ? noteTitle(newest.text) : "Your notes")}</span>`;
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
      // A field being typed in (a note, a search, a city) keeps its words, its caret and the keyboard across the draw.
      const typed = !inSlot && doc.activeElement?.matches?.("textarea.hc-note-edit, input.hc-note-find, input.hc-city, input.hc-zone") && section.contains(doc.activeElement) ? doc.activeElement : null;
      const held = typed ? { fk: typed.dataset.fk, note: typed.dataset.note || "", value: typed.value, from: typed.selectionStart, to: typed.selectionEnd, top: typed.scrollTop, place: typed.__place || null } : null;
      for (const node of moved) pantry.append(node);
      filling = true; section.__html = html; section.innerHTML = html; filling = false;
      for (const place of section.querySelectorAll("[data-slot]")) { const node = slot?.(place.dataset.slot); if (node) { place.append(node); slotted?.(place.dataset.slot, form, tight); } }
      const again = held ? [...section.querySelectorAll(`[data-fk="${held.fk}"]`)].find((n) => (n.dataset.note || "") === held.note) : null;
      if (again) {
        again.value = held.value; filling = true; again.focus({ preventScroll: true }); filling = false;
        try { again.setSelectionRange(held.from, held.to); } catch { /* a field with no caret to place */ }
        again.scrollTop = held.top;
        if (held.place) { again.__place = held.place; const save = again.closest("form")?.querySelector('button[type="submit"]'); if (save) save.disabled = false; }
        if (pick && pick.input === typed) { pick.input = again; again.setAttribute("aria-expanded", "true"); again.setAttribute("aria-controls", pick.box.id); pickPlace(); }
      }
      after(section, id, form);
      if (again) return;
      if (pick && typed && pick.input === typed) pickClose();
      if (inSlot && section.contains(inSlot)) inSlot.focus({ preventScroll: true });
      else if (key) { try { section.querySelector(key)?.focus({ preventScroll: true }); } catch { /* it is gone */ } }
    }
    /** What a draw leaves to be set by hand: a note's words and what is searched for (never while they are typed), the
     *  inked day; the Clock's field is emptied. */
    function after(section, id, form) {
      if (id === "note") {
        const box = section.querySelector("textarea.hc-note-edit"), find = section.querySelector("input.hc-note-find");
        if (box) { const n = noteOf(box.dataset.note); if (n && doc.activeElement !== box && box.value !== n.text) box.value = n.text; const limit = section.querySelector(".hc-note-limit"); if (limit) limit.hidden = box.value.length < NOTE_MOST; }
        if (find && doc.activeElement !== find && find.value !== ui.notes.q) find.value = ui.notes.q;
      }
      if (id === "clock") { const field = section.querySelector("input.hc-zone"); if (field && doc.activeElement !== field && field.value) field.value = ""; }
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
      // The day's top models, when the report names them (today's always; another day's when the ledger says).
      const named = (Array.isArray(day.models) ? day.models : []).slice(0, 3).map(modelSays);
      tip.innerHTML = `<div class="hc-tip-d">${DAY.format(dayOf(ui.token.hot))}</div><div class="hc-tip-v"><i></i>${words}</div>${named.map((line) => `<div class="hc-tip-m">${esc(line)}</div>`).join("")}`;
      tip.classList.toggle("hc-tip-tall", named.length > 0);
      // Above the inked column, clear of the bars, and never past the plot's ends.
      const wide = plot.clientWidth, half = tip.offsetWidth / 2, mid = (x / 100) * wide;
      tip.style.left = `${wide && half ? Math.max(half - 2, Math.min(wide - half + 2, mid)) : mid}px`;
      plot.setAttribute("aria-description", `${DAY.format(dayOf(ui.token.hot))}: ${words}${named.length ? `. ${named.join("; ")}` : ""}`);
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
      // The weather: every half hour; after a miss, again after a minute (five when the service refused): one miss as
      // the editor started, or while it was busy, left "Can't reach the weather" on the card for half an hour.
      if (layout.order.includes("weather") && placeOf() && now - Math.max(weatherAt, weatherAsked) > weatherWait) { weatherAsked = now; post?.({ type: "homeWeatherGet" }); }
      // What the Library lists: asked when its card is on Home (or the library is open, for its preview), and again when it is old.
      for (const kind of ["widgets", "artifacts"]) if (on(kind) && now - madeAt[kind] > 5 * 60000) { madeAt[kind] = now; post?.({ type: kind === "widgets" ? "homeWidgetsGet" : "homeArtifactsGet" }); }
    }

    // ---- a field that offers what may be chosen: Weather's place, a city for the Clock -------------------------------------
    // One dropdown under the field (the menu's look, the one corner): Down and Up move through it, Enter takes the row the
    // keys are on, Escape closes it, a click takes a row. The keyboard never leaves the field.
    let pick = null, placeTimer = 0, placeSeq = 0, placeFor = null;
    function pickClose() {
      if (!pick) return;
      const was = pick; pick = null; was.box.remove();
      if (was.input.isConnected) { was.input.setAttribute("aria-expanded", "false"); was.input.removeAttribute("aria-activedescendant"); was.input.removeAttribute("aria-controls"); }
    }
    /** Under its field; over it when there is more room there. Inside the side bar (or the pop-up it is in), above the dock. */
    function pickPlace() {
      if (!pick || !pick.input.isConnected) return;
      const { input, box } = pick, holder = box.parentNode, a = input.getBoundingClientRect(), h = holder.getBoundingClientRect(), inDialog = holder.tagName === "DIALOG";
      const dock = inDialog ? null : doc.getElementById("dgc-dock"), dockTop = dock && dock.checkVisibility?.() && dock.dataset.show === "always" ? dock.getBoundingClientRect().top : view.innerHeight;
      const tabs = inDialog ? null : doc.getElementById("side-tabs"), ceiling = inDialog ? h.top + 6 : Math.max(6, (tabs?.getBoundingClientRect().bottom || 0) + 4), floor = (inDialog ? h.bottom : Math.min(view.innerHeight, dockTop)) - 6;
      const leftMost = inDialog ? h.left + 6 : 6, rightMost = (inDialog ? h.right : doc.documentElement.clientWidth) - 6;
      const width = Math.min(Math.max(a.width, 236), rightMost - leftMost), left = Math.max(leftMost, Math.min(a.left, rightMost - width));
      const below = floor - a.bottom - 4, above = a.top - 4 - ceiling, up = below < 150 && above > below;
      box.style.width = `${width}px`; box.style.maxHeight = `${Math.max(88, Math.min(304, Math.floor(up ? above : below)))}px`;
      box.style.left = `${left - h.left - holder.clientLeft + holder.scrollLeft}px`;
      box.style.top = `${(up ? a.top - 4 - box.offsetHeight : a.bottom + 4) - h.top - holder.clientTop + holder.scrollTop}px`;
      box.dataset.dir = up ? "up" : "down";
    }
    /** The rows a field offers now ([{ name, sub, code, ... }]), and a quiet line under them (nothing found, cannot ask). */
    function pickShow(input, kind, rows, note = "") {
      if (!input.isConnected) return;
      if (!pick || pick.input !== input) {
        pickClose();
        const box = doc.createElement("div");
        box.className = "dgc-menu hc-suggest"; box.id = "hc-suggest"; box.setAttribute("role", "listbox"); box.setAttribute("aria-label", kind === "zone" ? "Time zones" : "Places");
        (input.closest("dialog") || host).append(box);
        box.addEventListener("mousedown", (e) => e.preventDefault());           // the keyboard stays in the field
        box.addEventListener("click", (e) => { const row = e.target.closest('[role="option"]'); if (row) pickTake(Number(row.dataset.at)); });
        pick = { input, kind, box, rows: [], at: -1 };
        input.setAttribute("aria-expanded", "true"); input.setAttribute("aria-controls", box.id);
      }
      pick.rows = rows; pick.at = -1; input.removeAttribute("aria-activedescendant");
      pick.box.innerHTML = rows.map((r, k) => `<div role="option" id="hc-opt-${k}" class="dgc-menu-row hc-opt" data-at="${k}" aria-selected="false"><span class="hc-opt-tx"><span class="hc-opt-name">${esc(r.name)}</span>${r.sub ? `<span class="hc-opt-sub">${esc(r.sub)}</span>` : ""}</span>${r.code ? `<span class="hc-opt-code">${esc(r.code)}</span>` : ""}</div>`).join("")
        + (note ? `<p class="hc-suggest-note" role="status">${esc(note)}</p>` : "");
      pick.box.scrollTop = 0;
      pickPlace();
    }
    function pickMove(by) {
      if (!pick || !pick.rows.length) return;
      const n = pick.rows.length, to = pick.at < 0 ? (by > 0 ? 0 : n - 1) : (pick.at + by + n) % n, rows = pick.box.querySelectorAll('[role="option"]');
      rows[pick.at]?.setAttribute("aria-selected", "false");
      pick.at = to; rows[to].setAttribute("aria-selected", "true"); rows[to].scrollIntoView({ block: "nearest" });
      pick.input.setAttribute("aria-activedescendant", rows[to].id);
    }
    const saveOf = (input) => input.closest("form")?.querySelector('button[type="submit"]') || null;
    function pickTake(at) {
      if (!pick) return;
      const row = pick.rows[at], input = pick.input, kind = pick.kind;
      if (!row) return;
      pickClose();
      if (kind === "city") {
        // The place is the field's now, whole; Save (or Add) is on.
        input.value = placeWords(row.place); input.__place = row.place;
        const save = saveOf(input); if (save) { save.disabled = false; save.title = `${save.textContent}: ${input.value}`; }
        input.focus({ preventScroll: true });
        say(`${input.value} chosen. ${save ? save.textContent : "Save"} keeps it.`);
      } else {
        const zs = zonesNow();
        if (!row.zone || zs.includes(row.zone) || zs.length >= ZONES_MOST) return;
        const scope = input.closest(".hc-open") ? ".hc-open" : ".hc-grid";
        setting("clock", { zones: [...zs, row.zone] });
        say(`${row.name} added to the Clock.${zs.length + 1 >= ZONES_MOST ? " Four clocks is the most." : ""}`);
        input.value = ""; input.blur();
        // With four clocks the field is gone: the keyboard goes to the clock just added.
        if (zs.length + 1 >= ZONES_MOST) focusNext = `${scope} .hc-clock .hc-zone-x[data-zone-x="${row.zone}"]`;
        redraw();
      }
    }
    /** The letters typed into a city's field: with two or more, the host is asked for the places by that name once the
     *  typing rests. Whatever was chosen before is chosen no more: Save is off until a place is taken from the list. */
    function cityTyped(input) {
      input.__place = null;
      const save = saveOf(input); if (save) { save.disabled = true; save.title = "Choose a place from the list first"; }
      const q = input.value.replace(/\s+/g, " ").trim();
      view.clearTimeout(placeTimer); placeTimer = 0;
      if (q.length < 2) { placeSeq++; if (pick?.input === input) pickClose(); return; }
      placeTimer = view.setTimeout(() => {
        placeTimer = 0;
        if (!input.isConnected || doc.activeElement !== input) return;
        placeFor = input;
        if (!(pick && pick.input === input)) pickShow(input, "city", [], "Looking…");
        post?.({ type: "homeWeatherSuggest", q, seq: ++placeSeq });
      }, 250);
    }
    /** What is typed into the Clock's field narrows every time zone there is (but the ones on the Clock), by city or by zone. */
    function zoneTyped(input, all = false) {
      const q = all ? "" : input.value.trim().toLowerCase(), spaced = q.replace(/_/g, " ");
      const have = zonesNow(), rest = zones().filter((z) => !have.includes(z.zone));
      const found = q ? rest.filter((z) => z.find.includes(q) || z.find.includes(spaced)) : rest;
      if (q) found.sort((a, b) => (b.city.toLowerCase().startsWith(spaced) ? 1 : 0) - (a.city.toLowerCase().startsWith(spaced) ? 1 : 0));
      const rows = found.map((z) => ({ name: z.city, sub: z.region ? `${z.region} · ${z.zone}` : z.zone, code: zoneOffset(z.zone), zone: z.zone }));
      pickShow(input, "zone", rows, rows.length ? "" : "No time zone by that name.");
    }
    const zoneBack = (input) => { input.value = ""; };
    /** The two fields' keys and pointer, wherever they are drawn (a card on Home, the Cards pop-up). */
    function wireFields(el) {
      el.addEventListener("input", (e) => { const t = e.target; if (t.matches?.("input.hc-city")) cityTyped(t); else if (t.matches?.("input.hc-zone")) zoneTyped(t); });
      el.addEventListener("focusin", (e) => { const t = e.target; if (!filling && t.matches?.("input.hc-zone") && !(pick && pick.input === t)) { t.select(); zoneTyped(t, true); } });
      el.addEventListener("click", (e) => { const t = e.target; if (t.matches?.("input.hc-zone") && !(pick && pick.input === t)) zoneTyped(t, true); });
      el.addEventListener("focusout", (e) => { const t = e.target; if (filling || !t.matches?.("input.hc-city, input.hc-zone")) return; if (pick && pick.input === t) pickClose(); if (t.matches(".hc-zone")) zoneBack(t); });
      el.addEventListener("keydown", (e) => {
        const t = e.target; if (!t.matches?.("input.hc-city, input.hc-zone")) return;
        const mine = !!pick && pick.input === t, zone = t.matches(".hc-zone");
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (mine) pickMove(e.key === "ArrowDown" ? 1 : -1); else if (zone) zoneTyped(t, true); else if (!t.__place) cityTyped(t); }
        else if (e.key === "Enter") {
          // Enter takes the row the keys are on. With none, it saves only a place that was chosen (a form's own Enter).
          if (mine) { e.preventDefault(); e.stopImmediatePropagation(); if (pick.at >= 0) pickTake(pick.at); }
          else if (zone || !t.__place) e.preventDefault();
        }
        else if (e.key === "Escape" && mine) { e.preventDefault(); e.stopImmediatePropagation(); pickClose(); if (zone) { zoneBack(t); t.select(); } }
        else if (e.key === "Escape" && zone && t.value !== "") { e.preventDefault(); e.stopImmediatePropagation(); zoneBack(t); }
        // Escape in the field Change place showed puts it away (and closes nothing else).
        else if (e.key === "Escape" && !zone && ui.weatherEdit && t.closest(".hc-card")) { e.preventDefault(); e.stopImmediatePropagation(); weatherEditEnd(t.closest(".hc-card")); }
      });
    }
    wireFields(host);
    const onResize = () => pickClose();
    /** Draws now; when the grid may change (a Clock that becomes Large), the cards glide to their places. */
    function redraw() { cancelAnimationFrame(pending); pending = 0; if (!ui.open && !still()) flip(drawNow); else drawNow(); }
    /** The field Change place showed is put away; the keyboard goes back to Change place. */
    function weatherEditEnd(card) { pickClose(); ui.weatherEdit = false; focusNext = `${card.parentNode === grid ? ".hc-grid" : ".hc-open"} .hc-weather .hc-city-edit`; cancelAnimationFrame(pending); drawNow(); }
    view.addEventListener("resize", onResize);

    // ---- Notes: what is done to a note -----------------------------------------------------------------------------------------
    const setNotes = (notes) => { layout = { ...layout, notes }; };
    /** A note as it is now, here at once and to the host: soon (typing rests) or now. A new note with no words yet is not kept. */
    function keepNote(n, now = false) {
      const all = layout.notes || [], at = all.findIndex((x) => x.id === n.id);
      setNotes(at >= 0 ? all.map((x) => (x.id === n.id ? n : x)) : [n, ...all]);
      noteDirty = n.id;
      view.clearTimeout(noteTimer); noteTimer = 0;
      if (ui.notes.fresh === n.id && !n.text.trim()) return;
      const send = () => { noteTimer = 0; const cur = noteOf(n.id); if (!cur) return; if (ui.notes.fresh === cur.id) ui.notes.fresh = ""; post?.({ type: "homeNote", op: "save", note: { id: cur.id, text: cur.text, at: cur.at, pinned: cur.pinned } }); };
      if (now) send(); else noteTimer = view.setTimeout(send, 400);
    }
    /** What was typed and not yet sent goes now. */
    function flushNote() { if (!noteTimer) return; view.clearTimeout(noteTimer); noteTimer = 0; const cur = noteOf(noteDirty); if (cur && !(ui.notes.fresh === cur.id && !cur.text.trim())) { if (ui.notes.fresh === cur.id) ui.notes.fresh = ""; post?.({ type: "homeNote", op: "save", note: { id: cur.id, text: cur.text, at: cur.at, pinned: cur.pinned } }); } }
    /** Typing in a note ends: it is read again. A new note left with no words is not a note. */
    function endEdit() {
      flushNote();
      const id = ui.notes.editing; ui.notes.editing = "";
      if (id && ui.notes.fresh === id) { ui.notes.fresh = ""; if (!noteOf(id)?.text.trim()) { setNotes((layout.notes || []).filter((n) => n.id !== id)); if (ui.notes.open === id) ui.notes.open = ""; if (noteDirty === id) noteDirty = ""; } }
    }
    const scopeOf = (card) => (card.parentNode === grid ? ".hc-grid" : ".hc-open");
    function startNote(card) {
      if (full500()) return;
      endEdit();
      const n = { id: `n${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, text: "", at: 0, pinned: false };
      setNotes([n, ...(layout.notes || [])]);
      ui.notes = { ...ui.notes, fresh: n.id, open: n.id, editing: n.id, q: "" }; noteDirty = n.id;
      // On a Medium card (a list only) and a Small one, the note opens with the card whole; on a Large one, beside its list.
      if (card.parentNode === grid && card.dataset.form !== "l") open("note"); else { cancelAnimationFrame(pending); drawNow(); }
      host.querySelector(`${card.parentNode === grid && card.dataset.form === "l" ? ".hc-grid" : ".hc-open"} textarea.hc-note-edit`)?.focus({ preventScroll: true });
    }
    function showNote(id, card) {
      if (ui.notes.editing !== id) endEdit();
      ui.notes.open = id;
      if (card.parentNode === grid && card.dataset.form !== "l") { ui.notes.q = ""; open("note"); } else { focusNext = `${scopeOf(card)} .hc-note-row[data-note="${id}"]`; cancelAnimationFrame(pending); drawNow(); }
    }
    function editNote(id, card, on) {
      if (on) { if (ui.notes.editing && ui.notes.editing !== id) endEdit(); ui.notes.open = id; ui.notes.editing = id; } else endEdit();
      focusNext = on ? "" : `${scopeOf(card)} [data-fk="note-mode"]`;
      cancelAnimationFrame(pending); drawNow();
      if (on) { const box = host.querySelector(`${scopeOf(card)} textarea.hc-note-edit`); if (box) { box.focus({ preventScroll: true }); try { box.setSelectionRange(box.value.length, box.value.length); } catch { /* at its start */ } } }
    }
    function deleteNote(id, card) {
      const n = noteOf(id); if (!n) return;
      view.clearTimeout(noteTimer); noteTimer = 0; if (noteDirty === id) noteDirty = "";
      const kept = ui.notes.fresh !== id;
      setNotes((layout.notes || []).filter((x) => x.id !== id));
      if (ui.notes.open === id) ui.notes.open = ""; if (ui.notes.editing === id) ui.notes.editing = ""; if (!kept) ui.notes.fresh = "";
      if (kept) {
        post?.({ type: "homeNote", op: "delete", id });
        // Undo, for a few seconds: the note as it was.
        ui.notes.undo = { note: n }; view.clearTimeout(undoTimer); undoTimer = view.setTimeout(() => { ui.notes.undo = null; draw(); }, 8000);
        say("Note deleted. Undo brings it back.");
      }
      focusNext = kept ? `${scopeOf(card)} .hc-undo` : "";
      cancelAnimationFrame(pending); drawNow();
    }
    function undoDelete(card) {
      const n = ui.notes.undo?.note; if (!n) return;
      ui.notes.undo = null; view.clearTimeout(undoTimer);
      if ((layout.notes || []).length >= NOTES_MOST) { say(`${NOTES_MOST} notes is the most. Delete one to bring it back.`); draw(); return; }
      ui.notes.open = n.id;
      keepNote(n, true);
      say("The note is back.");
      focusNext = `${scopeOf(card)} .hc-note-row[data-note="${n.id}"]`;
      cancelAnimationFrame(pending); drawNow();
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
      pickClose(); if (was === "note") { endEdit(); ui.notes.open = ""; ui.notes.q = ""; }
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
          + (adding ? '<span class="hc-fine">The letters you type are sent to Open-Meteo to look the place up. Nothing else is sent, and nothing is guessed from this computer.</span>' : "")
          + `<div class="hc-lib-act">${adding ? placeForm("Add", "hc-add-city")
            : on ? `<span class="hc-onhome">${TICK}On Home</span><span class="hc-sp"></span><button type="button" class="hc-btn hc-remove" aria-label="Remove ${esc(CARDS[id].name)} from Home">Remove</button>`
            : `<span class="hc-sp"></span><button type="button" class="hc-btn hc-solid hc-add" aria-label="Add ${esc(CARDS[id].name)} to Home">Add</button>`}</div>`;
        if (item.__html === html) continue;
        const had = item.contains(doc.activeElement) ? (doc.activeElement.classList.contains("hc-add") ? ".hc-remove" : doc.activeElement.classList.contains("hc-remove") ? ".hc-add" : "") : "";
        item.__html = html; item.innerHTML = html;
        if (adding) {
          // The place kept (asked 14 Nov: adding always asks, with the saved place in the field): chosen already, so Add is
          // on; its words are selected, so typing replaces them.
          const field = item.querySelector(".hc-city"), kept = layout.settings?.weather?.place;
          if (field && kept?.name && Number.isFinite(kept.lat) && Number.isFinite(kept.lon)) { field.value = placeWords(kept); field.__place = kept; const save = saveOf(field); if (save) { save.disabled = false; save.title = `${save.textContent}: ${field.value}`; } }
          field?.focus(); field?.select();
        } else if (had) item.querySelector(had)?.focus();
      }
      try { onDraw?.(library); } catch { /* the faces are the page's */ }
    }
    function closeLibrary(focus = true) {
      if (!library) return;
      const was = library; library = null; libraryAdding = ""; if (pick && was.contains(pick.box)) pickClose();
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
      wireFields(dialog);                                    // (first: Escape closes a field's dropdown before it closes anything of the pop-up's)
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
        else if (t.closest(".hc-add") && id) { if (id === "weather") { libraryAdding = id; drawLibrary(data?.() || {}); } else add(id); }
        else if (t.closest(".hc-remove") && id) remove(id);
      });
      dialog.addEventListener("submit", (e) => {
        e.preventDefault();
        // Only a place taken from the list: never whatever was typed.
        const place = e.target.querySelector(".hc-city")?.__place;
        if (!place) return;
        pickClose(); libraryAdding = ""; weather = null; weatherAsked = Date.now();
        setting("weather", { place, city: undefined }); add("weather");
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
      if (t.closest(".hc-city-edit")) {
        // The field in this card when it has the room (opened, or a Medium card as tall as it needs); else the card opens whole at it.
        const here = card.parentNode !== grid || (card.dataset.form === "m" && grid.dataset.form === "m");
        ui.weatherEdit = true;
        if (here) { cancelAnimationFrame(pending); drawNow(); card.querySelector(".hc-city")?.focus(); } else { open("weather"); opened.querySelector(".hc-city")?.focus(); }
        return;
      }
      if (t.closest(".hc-city-cancel")) { weatherEditEnd(card); return; }
      if (t.closest(".hc-wx-retry")) { weatherRetried = card.parentNode === grid ? ".hc-grid" : ".hc-open"; weather = null; weatherAsked = Date.now(); post?.({ type: "homeWeatherGet" }); say("Asking for the weather again."); cancelAnimationFrame(pending); drawNow(); return; }
      const cross = t.closest(".hc-zone-x");
      if (cross) {
        // An added zone's ×: it goes; the keyboard stays on the clocks (the next one's ×, else the one before, else the field).
        const zs = zonesNow(), at = zs.indexOf(cross.dataset.zoneX), scope = card.parentNode === grid ? ".hc-grid" : ".hc-open"; if (at < 0) return;
        const next = zs.filter((z) => z !== zs[at]), to = next[at] || next[at - 1] || "";
        setting("clock", { zones: next });
        say(`${zoneCity(zs[at])} removed from the Clock.`);
        focusNext = to ? `${scope} .hc-clock .hc-zone-x[data-zone-x="${to}"]` : `${scope} .hc-card[data-card="clock"] input.hc-zone`;
        redraw();
        return;
      }
      if (t.closest(".hc-clear")) { act?.("clear"); return; }
      if (t.closest(".hc-usage-link")) { act?.("usage"); return; }
      if (t.closest("[data-pin-folder]")) { act?.("pin", t.closest("[data-pin-folder]").dataset.pinFolder); return; }
      if (id === "widgets" || id === "artifacts") {
        const turner = t.closest(".hc-prev, .hc-next, .hc-dot"), tile = t.closest("button[data-tile]");
        if (turner) { turn(id, card.dataset.form, turner.classList.contains("hc-prev") ? "prev" : turner.classList.contains("hc-next") ? "next" : turner.dataset.page); if (!card.contains(doc.activeElement)) card.querySelector(".hc-stack")?.focus({ preventScroll: true }); return; }
        if (t.closest("[data-library]")) { act?.("library", id); return; }
        if (tile) { const row = rowsOf(id).find((r) => r.id === tile.dataset.tile); if (row) act?.(id === "widgets" ? "widget" : "artifact", row); return; }
      }
      if (id === "note") {
        const pane = t.closest(".hc-note-pane"), noteId = pane?.dataset.note || "";
        if (t.closest(".hc-note-new")) { startNote(card); return; }
        if (t.closest(".hc-note-row")) { showNote(t.closest(".hc-note-row").dataset.note, card); return; }
        if (t.closest(".hc-undo")) { undoDelete(card); return; }
        if (t.closest(".hc-note-all")) { endEdit(); ui.notes.open = ""; focusNext = ".hc-open .hc-note-row, .hc-open .hc-note-new"; cancelAnimationFrame(pending); drawNow(); return; }
        if (t.closest(".hc-viewall")) { endEdit(); ui.notes.open = ""; ui.notes.q = ""; open(id); return; }
        if (noteId && t.closest(".hc-note-mode")) { editNote(noteId, card, ui.notes.editing !== noteId); return; }
        if (noteId && t.closest(".hc-note-pin")) { const n = noteOf(noteId); if (n) { keepNote({ ...n, pinned: !n.pinned }, true); say(n.pinned ? "Unpinned." : "Pinned to the top."); cancelAnimationFrame(pending); drawNow(); } return; }
        if (noteId && t.closest(".hc-note-del")) { deleteNote(noteId, card); return; }
        if (noteId && t.closest(".hc-note-view") && !t.closest("label, input")) { editNote(noteId, card, true); return; }
        if (t.closest("label.hc-check, .hc-note-pane, .hc-notes-bar")) return;
      }
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
      // Only a place taken from the list is saved: never whatever was typed.
      const place = form.querySelector(".hc-city")?.__place;
      if (!place) return;
      const scope = form.closest(".hc-open") ? ".hc-open" : ".hc-grid", was = ui.weatherEdit;
      pickClose(); ui.weatherEdit = false; weather = null; weatherAsked = Date.now();
      if (was) focusNext = `${scope} .hc-weather .hc-city-edit`;
      setting("weather", { place, city: undefined }); draw();
    });
    // A tick box in a note: its line is written "- [x]" or "- [ ]", and kept.
    host.addEventListener("change", (e) => {
      const box = e.target; if (!box.matches?.('.hc-note-view input[type="checkbox"]')) return;
      const n = noteOf(box.closest(".hc-note-view").dataset.note), at = Number(box.dataset.line); if (!n) return;
      const lines = n.text.split("\n"), tick = TICK_LINE.exec(lines[at] || ""); if (!tick) return;
      lines[at] = `${tick[1]}- [${box.checked ? "x" : " "}] ${tick[3]}`;
      keepNote({ ...n, text: lines.join("\n"), at: Date.now() });
      draw();
    });
    host.addEventListener("input", (e) => {
      const t = e.target;
      if (t.matches?.("input.hc-note-find")) { ui.notes.q = t.value.slice(0, 200); draw(); return; }
      if (!t.matches?.("textarea.hc-note-edit")) return;
      const n = noteOf(t.dataset.note); if (!n) return;
      const text = t.value.slice(0, NOTE_MOST), limit = t.parentNode.querySelector(".hc-note-limit");
      if (limit) limit.hidden = text.length < NOTE_MOST;
      keepNote({ ...n, text, at: Date.now() });
      draw();
    });
    host.addEventListener("contextmenu", (e) => { const card = e.target.closest(".hc-grid > .hc-card"); if (!card || e.target.closest("textarea, input, .dgc-hub-card, .hc-note-view")) return; e.preventDefault(); if (!ui.arranging) arrange(true, `.hc-grid .hc-card[data-card="${card.dataset.card}"]`); });
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
      // Widgets and Artifacts: Left and Right turn the page, from the stack or its arrows.
      if ((id === "widgets" || id === "artifacts") && (e.key === "ArrowLeft" || e.key === "ArrowRight") && t.closest(".hc-stack, .hc-pager") && card.dataset.form !== "full") {
        e.preventDefault(); turn(id, card.dataset.form, e.key === "ArrowLeft" ? "prev" : "next");
        if (!card.contains(doc.activeElement)) card.querySelector(".hc-stack")?.focus({ preventScroll: true });
        return;
      }
      // A note being typed in: Escape ends the typing (and closes nothing else).
      if (t.matches?.("textarea.hc-note-edit") && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); editNote(t.dataset.note, card, false); return; }
      if (t.matches?.("input.hc-note-find") && e.key === "Escape" && t.value) { e.preventDefault(); e.stopPropagation(); t.value = ""; ui.notes.q = ""; draw(); return; }
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
    if (view.ResizeObserver) { sized = new view.ResizeObserver(() => { const w = widthNow(); if (!w || w === width) return; width = w; const g = gridForm(w); if (g !== was || g === "l") { if (g !== was && !ui.open) ui.weatherEdit = false; was = g; draw(true); } }); sized.observe(host); }
    const tick = view.setInterval(() => { if (host.checkVisibility?.() && (layout.order.includes("clock") || layout.order.includes("recent") || layout.order.includes("note") || (layout.order.includes("weather") && weather && weather.ok === false))) draw(); }, 20000);
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
        const whereOf = (w) => (w?.place ? `${w.place.lat},${w.place.lon}` : w?.city || ""), was = whereOf(layout.settings?.weather);
        // The notes as the host keeps them; the one being typed in (or not yet sent) stays as it is here.
        let notes = Array.isArray(next?.notes) ? next.notes.filter((n) => n && typeof n.id === "string" && typeof n.text === "string").map((n) => ({ id: n.id, text: n.text, at: Number(n.at) || 0, pinned: n.pinned === true })) : layout.notes || [];
        if (noteDirty) {
          const mine = noteOf(noteDirty), theirs = notes.find((n) => n.id === noteDirty);
          if (mine && (noteTimer || ui.notes.fresh === noteDirty || !theirs || theirs.text !== mine.text || theirs.pinned !== mine.pinned)) notes = theirs ? notes.map((n) => (n.id === noteDirty ? mine : n)) : [mine, ...notes];
          else noteDirty = "";
        }
        layout = { order, settings: next?.settings && typeof next.settings === "object" ? next.settings : {}, notes };
        if (was !== whereOf(layout.settings?.weather)) { weather = null; weatherAt = 0; }
        draw(changed);
      },
      usage(report) { usage = { days: Array.isArray(report?.days) ? report.days : [], models: Array.isArray(report?.models) ? report.models : [], modelCount: Number(report?.modelCount) || 0, error: String(report?.error || "") }; usageAt = Date.now(); draw(); },
      weather(said) {
        weather = said && typeof said === "object" ? said : null; weatherAt = Date.now();
        weatherWait = weather && weather.ok === false && weather.reason !== "notfound" ? (weather.reason === "refused" ? 5 : 1) * 60000 : 30 * 60000;
        // Try again was pressed: the keyboard goes back to it if the weather is still out of reach.
        if (weatherRetried) { if (weather && weather.ok === false) focusNext = `${weatherRetried} .hc-wx-retry`; weatherRetried = ""; }
        draw();
      },
      /** The host's { type: "homeWeatherPlaces", q, seq, ok, places | reason }: the places found for the letters typed. */
      places(said) {
        const input = placeFor;
        if (!said || said.seq !== placeSeq || !input?.isConnected || doc.activeElement !== input) return;
        const rows = said.ok ? (Array.isArray(said.places) ? said.places : []).filter((p) => p && typeof p.name === "string" && Number.isFinite(p.lat) && Number.isFinite(p.lon)).slice(0, 8)
          .map((p) => ({ name: p.name, sub: [p.admin1, p.country].filter(Boolean).join(", "), code: p.code || "", place: { name: p.name, admin1: p.admin1 || "", country: p.country || "", code: p.code || "", lat: p.lat, lon: p.lon, tz: p.tz || "" } })) : [];
        pickShow(input, "city", rows, !said.ok ? (said.reason === "refused" ? "Open-Meteo isn’t answering right now. Try again in a moment." : "Can’t reach Open-Meteo right now. Check the connection and try again.") : rows.length ? "" : "No place by that name.");
      },
      /** The host's { type: "homeWidgets", offered, widgets } or { type: "homeArtifacts", offered, items }: what the Library lists. */
      made(kind, said) {
        if (kind !== "widgets" && kind !== "artifacts") return;
        const rows = (Array.isArray(kind === "widgets" ? said?.widgets : said?.items) ? (kind === "widgets" ? said.widgets : said.items) : []).filter((r) => r && typeof r.id === "string" && r.id).slice(0, 200);
        if (kind === "artifacts") rows.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
        made[kind] = { offered: said?.offered !== false, rows, more: said?.more === true }; madeAt[kind] = Date.now(); draw();
      },
      open, close, opened: () => ui.open, arranging: () => ui.arranging, order: () => [...layout.order],
      closeLibrary: () => closeLibrary(false),
      /** Home is in front again: what it reads is read again when it is old. */
      shown() { ask(); },
      dispose() { doc.removeEventListener("keydown", onKey); view.removeEventListener("resize", onResize); sized?.disconnect(); view.clearInterval(tick); view.clearTimeout(placeTimer); view.clearTimeout(undoTimer); flushNote(); pickClose(); closeLibrary(false); },
    };
  }

  root.DgcHomeCards = Object.freeze({ create, CARDS, TYPES, DEFAULT, zones });
})();
