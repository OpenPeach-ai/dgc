// Home as cards (media/shared/homecards.js), in real Chromium on the real side bar (dock-scene.mjs opens it), with a
// small stand-in for the host: it keeps which cards are on Home, their order and their settings the way
// src/homeCards.ts does, and answers the token report and the weather from what the test gives it. Nothing here
// touches a network: the weather is a stand-in's. Shared by home-cards.test.mjs and the pictures. Not a *.test.mjs file.
import { openDock, DOCK_SESSIONS } from "./dock-scene.mjs";
import { homeState, CHATS } from "./home-scene.mjs";
import { notesModule, context as notesContext, seed as notesSeed, OLD_KEY } from "./notes-host.mjs";

export const DEFAULT = ["needs", "recent", "running", "token", "quick"];
export const EVERY = ["needs", "recent", "running", "token", "quick", "work", "chats", "pips", "folders", "clock", "weather", "note"];
/** The place a Weather card is set to, as the host keeps a place chosen from Open-Meteo's list. */
export const LISBON = { name: "Lisbon", admin1: "Lisbon", country: "Portugal", code: "PT", lat: 38.72, lon: -9.13, tz: "Europe/Lisbon" };
/** What the stand-in place search knows (Open-Meteo's search answers by the start of a name). */
export const PLACES = [LISBON,
  { name: "Lisbon", admin1: "Ohio", country: "United States", code: "US", lat: 40.77, lon: -80.77, tz: "America/New_York" },
  { name: "Lisbon", admin1: "Maine", country: "United States", code: "US", lat: 44.03, lon: -70.1, tz: "America/New_York" },
  { name: "Lisburn", admin1: "Northern Ireland", country: "United Kingdom", code: "GB", lat: 54.52, lon: -6.04, tz: "Europe/London" },
  { name: "Porto", admin1: "Porto", country: "Portugal", code: "PT", lat: 41.15, lon: -8.61, tz: "Europe/Lisbon" },
  { name: "Portland", admin1: "Oregon", country: "United States", code: "US", lat: 45.52, lon: -122.68, tz: "America/Los_Angeles" }];
export const NOTES = [
  { id: "n0003", text: "Ferry to Porto\n- [ ] book the 09:40\n- [x] check the car deck\nAsk about bikes", at: Date.now() - 5 * 60000, pinned: false },
  { id: "n0002", text: "Call the bank about the card\nthen book the ferry", at: Date.now() - 26 * 3600000, pinned: true },
  { id: "n0001", text: "Seeds for spring: tomatoes, basil, sweet peas", at: Date.now() - 9 * 86400000, pinned: false }];
const wid = (n) => `wg_${String(n).padStart(16, "0")}`, aid = (n) => `ar_${String(n).padStart(16, "0")}`;
export const WIDGETS = ["Tip calculator", "Pomodoro timer", "Unit converter", "Tide table quiz", "Loan payoff slider"].map((title, k) => ({ id: wid(k + 1), title, chat_id: `chat_${k + 1}`, chat_title: ["Dinner in Porto", "Focus", "Recipes", "Goa trip", "Rent or buy"][k], created_at: new Date(Date.now() - k * 86400000).toISOString() }));
export const ARTIFACTS = [["page", "Tide pools, a field guide", "chat"], ["doc", "Lease questions", "work"], ["slides", "Shop: the first year", "pip"], ["sheet", "Invoice totals", "work"], ["dashboard", "Visits this week", "chat"], ["doc", "Ferry plan", "chat"]]
  .map(([type, title, surface], k) => ({ id: aid(k + 1), type, title, version: k + 1, surface, at: new Date(Date.now() - k * 3600000 * 30).toISOString() }));
const pad = (v) => String(v).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** `n` days of use ending today (local days, as DGC's report names them), the same numbers on every run. Today: 900,000 in and 340,000 out (1.24M). */
export function usageDays(n = 60, now = new Date()) {
  const out = [];
  for (let back = n - 1; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const k = (back * 37) % 11, input = back === 0 ? 900000 : 300000 + k * 110000, output = back === 0 ? 340000 : 60000 + k * 21000;
    out.push({ date: dayKey(d), input_tokens: input, output_tokens: output, cached_input_tokens: Math.round(input * (0.4 + (k % 4) * 0.1)), requests: back === 0 ? 96 : 20 + k * 9 });
  }
  return out;
}
const model = (model, provider, where, tokens, share) => ({ name: where && where !== model ? `${model} (${where})` : model, model, provider, where, tokens, share });
/** The thirty days' models as the host shapes get_usage's by-model rows: seven of them, most tokens first, each with its share. */
export const MODELS = [model("deepseek-v4.1-flash:cloud", "Ollama", "Ollama Cloud", 19700000, 55), model("claude-opus-4.1", "Claude Code", "Claude Code", 8300000, 23), model("qwen3.5-coder:32b", "Ollama", "This computer", 3800000, 11),
  model("qwen3:8b", "Ollama", "This computer", 1900000, 5), model("gpt-5.1-codex", "Codex", "Codex", 1100000, 3), model("kimi-k2", "Moonshot", "Moonshot", 700000, 2), model("gemma3:4b", "Ollama", "This computer", 300000, 1)];
export const USAGE = () => { const days = usageDays(); days.at(-1).models = [model("qwen3.5-coder:32b", "Ollama", "This computer", 800000, 65), model("deepseek-v4.1-flash:cloud", "Ollama", "Ollama Cloud", 440000, 35)];
  return { type: "homeUsage", days, models: MODELS, modelCount: MODELS.length, error: "" }; };
export const WEATHER = { type: "homeWeather", ok: true, place: "Lisbon, Portugal", at: Date.now(), now: { temp: 24.3, code: 2, day: true }, high: 26.1, low: 17.4,
  hours: [{ time: "15:00", temp: 24.6, code: 1 }, { time: "16:00", temp: 24.1, code: 2 }, { time: "17:00", temp: 23.0, code: 3 }, { time: "18:00", temp: 21.4, code: 61 }, { time: "19:00", temp: 20.2, code: 61 }] };
export const FOLDERS = { choice: "", window: { folder: "/home/me/shop", shown: "~/shop", name: "shop" }, rows: [
  { folder: "/home/me/shop", shown: "~/shop", name: "shop", here: true, exists: true, sessions: 14, pips: 1, workspace_id: null },
  { folder: "/home/me/garden-notes", shown: "~/garden-notes", name: "garden-notes", here: false, exists: true, sessions: 6, pips: 0, workspace_id: null },
  { folder: "/home/me/tide_api", shown: "~/tide_api", name: "tide_api", here: false, exists: true, sessions: 3, pips: 2, workspace_id: null },
  { folder: "/home/me/old-site", shown: "~/old-site", name: "old-site", here: false, exists: false, sessions: 1, pips: 0, workspace_id: null },
  { folder: "/home/me/invoices", shown: "~/invoices", name: "invoices", here: false, exists: true, sessions: 2, pips: 0, workspace_id: null }] };

/** Thirty folders (neutral names), for a long Project Folder list: the eighth is gone, the first is this window's. */
export const THIRTY_FOLDERS = ["shop", "garden-notes", "invoices", "recipes", "tide-tables", "ferry-plan", "book-club", "field-guide", "weather-log", "bike-routes", "seed-list", "boat-shed", "print-queue", "photo-sort", "tax-2026",
  "newsletter", "kitchen-plan", "map-tiles", "bird-count", "choir-site", "loan-sheet", "quiz-night", "allotment", "bakery-orders", "trail-notes", "reading-list", "market-stall", "school-run", "lighthouse", "harbour-cam"]
  .map((name, k) => ({ folder: `/home/me/projects/${name}`, shown: `~/projects/${name}`, name, here: k === 0, exists: k !== 7, sessions: 1 + (k % 5), pips: k % 3 === 0 ? 1 : 0, workspace_id: null }));

/** Opens Home with its cards. layout: the cards on Home, in order; settings: { clock, weather, note } as the host keeps
 *  them; usage: the token report (null: none yet); weather: what the stand-in service says (or { ok: false, reason });
 *  folders: the Project Folder rows (null: a DGC that lists none); news: Work replies nobody saw ([{ id, at, preview }]).
 *  Everything else is dock-scene's (width, height, theme, motion, state, sessions, video...). */
export async function openGrid(browser, { layout = DEFAULT, settings = {}, usage = USAGE(), weather = WEATHER, folders = FOLDERS, news = [], sessions = DOCK_SESSIONS, state = homeState("busy"),
  notes = [], seed = null, notesOptions = {}, keychain = true, places = PLACES, geo = "ok", widgets = WIDGETS, artifacts = ARTIFACTS, favorites = false, ...rest } = {}) {
  const x = await openDock(browser, { tab: "home", sessions, state, height: 900, grid: true, ...rest });
  // Notes are the real host's (src/notes.ts), on a folder of its own: `notes` are the notes kept before the notes app
  // ([{ id, text, at, pinned }], carried over as the host carries them), `seed` is notes and folders as files
  // ({ notes: [{ id, text, folder, pinned, created, edited, deleted }], folders: [{ id, name }] }).
  const { Notes } = await notesModule(), nc = notesContext(undefined, { state: notes.length ? { [OLD_KEY]: { notes } } : {}, keychain });
  if (seed) await notesSeed(nc, seed);
  const store = new Notes(nc, notesOptions), tell = (said) => x.page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), JSON.parse(JSON.stringify(said))).catch(() => {});
  await x.page.exposeFunction("__notesHost", (m) => { store.handle(m, tell); });
  store.onSaid(tell);      // (what the host says by itself, as when notes lock after a while, reaches the page too)
  const requests = [];
  x.page.on("request", (r) => requests.push(r.url()));
  await x.page.evaluate(({ layout, settings, usage, weather, DEFAULT, notes, places, geo, widgets, artifacts, favorites }) => {
    const kept = window.__homeCards = { order: [...layout], settings: JSON.parse(JSON.stringify(settings)) };
    // The stand-in place search: `geo` "ok" | "offline" | "refused"; what was asked of it is noted (never a network).
    window.__homeGeo = { places, mode: geo }; window.__geoAsked = [];
    window.__homeWidgets = widgets; window.__homeArtifacts = artifacts; window.__homeFavorites = favorites === true;      // (a DGC that keeps the Library's favorites)
    window.__homeUsage = usage; window.__homeWeather = weather; window.__weatherAsked = [];
    const tell = (data) => window.dispatchEvent(new MessageEvent("message", { data: JSON.parse(JSON.stringify(data)) }));
    const say = () => tell({ type: "homeCards", ...kept });
    const host = (m) => {
      if (!m || typeof m.type !== "string" || !m.type.startsWith("home")) return;
      if (m.type === "homeCardsReady") { say(); window.__notesHost({ type: "homeNotesDo", op: "get" }); }
      else if (m.type === "homeCardsSet") { kept.order = [...new Set(m.order)]; say(); }
      else if (m.type === "homeCardsReset") { kept.order = [...DEFAULT]; say(); }
      else if (m.type === "homeCardSetting") {
        // (As the host: a Weather place is kept only whole, from the list; a bare city a page sends changes nothing.)
        const change = { ...m.settings }; if (m.card === "weather") delete change.city;
        kept.settings[m.card] = { ...(kept.settings[m.card] || {}), ...change }; say();
        if (m.card === "weather" && m.settings.place !== undefined) { window.__weatherAsked.push(kept.settings.weather.place); tell(window.__homeWeather); }
      }
      else if (m.type === "homeUsageGet") { if (window.__homeUsage) tell(window.__homeUsage); }
      else if (m.type === "homeWeatherGet") { const w = kept.settings.weather || {}; window.__weatherAsked.push(w.place || w.city || ""); if (w.place || w.city) tell(window.__homeWeather); }
      else if (m.type === "homeWeatherSuggest") {
        window.__geoAsked.push(m.q);
        const g = window.__homeGeo, q = String(m.q || "").trim().toLowerCase();
        if (g.mode !== "ok") tell({ type: "homeWeatherPlaces", q: m.q, seq: m.seq, ok: false, reason: g.mode });
        else tell({ type: "homeWeatherPlaces", q: m.q, seq: m.seq, ok: true, places: g.places.filter((p) => p.name.toLowerCase().startsWith(q)).slice(0, 8) });
      }
      // Notes: the real host (src/notes.ts) answers, from the test's own process (see below).
      else if (m.type === "homeNotesDo") window.__notesHost(m);
      else if (m.type === "homeWidgetsGet") tell(window.__homeWidgets ? { type: "homeWidgets", offered: true, widgets: window.__homeWidgets } : { type: "homeWidgets", offered: false, widgets: [] });
      else if (m.type === "homeArtifactsGet") tell(window.__homeArtifacts ? { type: "homeArtifacts", offered: true, items: window.__homeArtifacts, ...(window.__homeFavorites ? { favorites: true } : {}) } : { type: "homeArtifacts", offered: false, items: [] });
    };
    const posted = window.__posted, push = posted.push;
    posted.push = function (m) { const n = push.call(this, m); try { host(m); } catch (error) { window.__homeCardsError = String(error); } return n; };
    say(); window.__notesHost({ type: "homeNotesDo", op: "get" });
    if (usage) tell(usage);
    if (kept.settings.weather?.place || kept.settings.weather?.city) tell(weather);
  }, { layout, settings, usage, weather, DEFAULT, notes, places, geo, widgets, artifacts, favorites });
  if (folders || news.length) await x.send({ type: "sessions_list", items: sessions, error: "", ...(folders ? { folders } : {}), ...(news.length ? { news } : {}) });
  await x.settle();
  /** Until the cards have come to rest (a glide, a flip wave). */
  const rest2 = async (ms = 80) => { await x.page.evaluate((w) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, w)))), ms); };
  const resize = async (width, height = 900) => { await x.page.setViewportSize({ width, height }); await rest2(700); };
  return { ...x, requests, grid: () => gridNow(x.page), rest: rest2, resize, host: () => x.page.evaluate(() => JSON.parse(JSON.stringify(window.__homeCards))),
    /** The notes as the host has them: the list (`all`: the bin too), one note's words as its file has them, the store itself. */
    notes: { store, context: nc, list: async (all = false) => { await store.idle(); return store.state().notes.filter((n) => all || !n.deleted); }, state: async () => { await store.idle(); return store.state(); },
      text: async (id) => { await store.idle(); let said; store.handle({ type: "homeNotesDo", op: "open", id }, (m) => { said = m; }); await store.idle(); return said?.ok ? said.text : undefined; } } };
}

/** Home's cards as they are on screen: the grid's form, each card (which, its form, its box, its words), what is opened,
 *  the Cards button, the library and Arrange Home. */
export const gridNow = (page) => page.evaluate(() => {
  const hub = document.getElementById("home-hub"), rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const grid = hub?.querySelector(".hc-grid"), open = hub?.querySelector(".hc-open"), lib = document.querySelector("dialog.hc-library"), button = hub?.querySelector(".hc-cards-btn");
  const words = (n) => (n.innerText || "").replace(/\s+/g, " ").trim();
  const card = (c) => ({ id: c.dataset.card, form: c.dataset.form, text: words(c), label: c.getAttribute("aria-label") || "", lifted: c.classList.contains("hc-lifted"), x: !!c.querySelector(".hc-x")?.checkVisibility(), ...rect(c) });
  return { there: !!grid, form: grid?.dataset.form || "", shown: !!grid?.checkVisibility(), arranging: !!grid?.classList.contains("hc-arranging"),
    cards: grid ? [...grid.querySelectorAll(":scope > .hc-card")].map(card) : [],
    open: open && !open.hidden ? { ...card(open.querySelector(".hc-card")), back: words(hub.querySelector(".hc-back")) } : null,
    button: button ? { text: words(button), mosaic: button.querySelector(".mosaic")?.className || "", tiles: button.querySelectorAll(".mosaic > i").length, play: button.querySelector(".mosaic i:nth-child(4)") ? getComputedStyle(button.querySelector(".mosaic i:nth-child(4)")).animationPlayState : "",
      motion: button.querySelector(".mosaic i:nth-child(4)") ? getComputedStyle(button.querySelector(".mosaic i:nth-child(4)")).animationName : "", radius: getComputedStyle(button).borderTopLeftRadius, ...rect(button) } : null,
    library: lib?.open ? { ...rect(lib), items: [...lib.querySelectorAll(".hc-lib-item")].map((i) => ({ id: i.dataset.card, name: words(i.querySelector(".hc-lib-name")), line: words(i.querySelector(".hc-lib-line")), on: !!i.querySelector(".hc-onhome"), add: !!i.querySelector(".hc-add"), remove: !!i.querySelector(".hc-remove"),
      mosaics: i.querySelectorAll(".mosaic").length, preview: words(i.querySelector(".hc-lib-pv")), previewDrawn: i.querySelector(".hc-lib-pv").childElementCount > 0 })),
      title: [...lib.querySelectorAll(".hc-lib-head .mosaic")].map((m) => m.className), foot: [...lib.querySelectorAll(".hc-lib-foot button")].map(words) } : null,
    head: hub ? words(hub.querySelector(".hc-head")) : "", width: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth,
    focus: document.activeElement?.closest?.(".hc-card")?.dataset.card || document.activeElement?.className || "" };
});
