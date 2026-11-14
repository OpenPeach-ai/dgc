// What the extension keeps for Home's cards (src/homeCards.ts, bundled against a stub `vscode`): which cards are on
// Home, their order and the everyday cards' settings, kept on this computer as the
// dock's pins are; the token report shaped for the card; and the Weather card's one outside request, made by the host
// to Open-Meteo for the city the user typed. The service here is a stand-in: nothing in this file touches a network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const root = new URL("..", import.meta.url).pathname;
globalThis.__HC_VSCODE = {};
const out = await build({ entryPoints: [root + "src/homeCards.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__HC_VSCODE;" })); } }] });
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, (await import("node:module")).createRequire(import.meta.url));
const { HomeCards, HOME_DEFAULT, HOME_CARD_TYPES, usageForHome } = mod.exports;
const store = () => { const kept = new Map(); return { globalState: { get: (k) => kept.get(k), update: async (k, v) => { if (v === undefined) kept.delete(k); else kept.set(k, JSON.parse(JSON.stringify(v))); } }, kept }; };

test("someone new has the default set; what is added, moved and removed is kept on this computer across a reload", async () => {
  const context = store(), home = new HomeCards(context);
  assert.deepEqual(HOME_DEFAULT, ["needs", "recent", "running", "token", "quick"]);
  assert.deepEqual(home.state().order, HOME_DEFAULT);
  assert.equal(home.state().type, "homeCards");
  await home.setOrder(["quick", "needs", "work", "weather", "nonsense", "work", 7, "token"]);
  assert.deepEqual(home.state().order, ["quick", "needs", "work", "weather", "token"], "only cards there are, each once");
  assert.deepEqual(new HomeCards(context).state().order, ["quick", "needs", "work", "weather", "token"], "a reload, or another window, finds it");
  await home.setOrder([]);
  assert.deepEqual(new HomeCards(context).state().order, [], "a Home with every card taken off stays empty: it is the user's");
  await home.reset();
  assert.deepEqual(new HomeCards(context).state().order, HOME_DEFAULT, "Reset Home");
});

// (The test "each card type wears a mosaic palette of its own ... never Ember" went on 13 Nov with the per-card icons:
// the library's cards have no icon, so the host keeps no palette for them.)
test("the host keeps no palette for a card: the library's cards have no icon of their own", async () => {
  const context = store(), home = new HomeCards(context);
  await home.setOrder(["note", "clock"]);
  // (14 Nov: and no notes either. They are files in DGC's storage folder now: src/notes.ts, test/notes-store.test.mjs.)
  assert.deepEqual(Object.keys(home.state()).sort(), ["order", "settings", "type"]);
  assert.equal("palettes" in (context.kept.get("dgc.homeCards.v1") || {}), false);
});

test("the everyday cards' settings are kept with the layout, and only what a card has", async () => {
  const context = store(), home = new HomeCards(context);
  await home.setting("clock", { zone: "Asia/Tokyo" });
  await home.setting("clock", { zone: "Not/AZone;rm" });
  await home.setting("weather", { unit: "f" });
  await home.setting("token", { anything: 1 });
  await home.setting("widgets", { shown: "wg_0000000000000002", evil: "<script>" });
  await home.setting("artifacts", { shown: "ar_0000000000000003" });
  await home.setting("artifacts", { shown: "../../etc" });
  const kept = new HomeCards(context).state().settings;
  // (Since 14 Nov the Clock keeps a list of added zones, three at most; the one zone a page sent before is the first.)
  assert.deepEqual(kept.clock, { zones: ["Asia/Tokyo"] }, "a time zone that is not one changes nothing");
  assert.equal(kept.weather.unit, "f"); assert.equal(kept.token, undefined);
  assert.deepEqual(kept.widgets, { shown: "wg_0000000000000002" }, "which widget the card showed"); assert.deepEqual(kept.artifacts, { shown: "ar_0000000000000003" });
  // Every time zone there is, and UTC; "" takes the first added zone away.
  for (const z of ["Europe/Lisbon", "America/Argentina/Buenos_Aires", "Asia/Kolkata", "Etc/GMT+5", "UTC"]) { await home.setting("clock", { zone: z }); assert.deepEqual(new HomeCards(context).state().settings.clock, { zones: [z] }, z); }
  await home.setting("clock", { zone: "" });
  assert.equal(new HomeCards(context).state().settings.clock, undefined);
});

// (The tests "Notes: made, changed, pinned and deleted ..." and "Notes are bounded: 500 notes, 20,000 characters each"
// went on 14 Nov with the notes app: notes are no longer kept in this state. test/notes-store.test.mjs has what replaced
// them: the carry-over of these very notes into files, made and edited times, 2,000 notes of 100,000 characters.)

const GEO = { results: [{ name: "Lisbon", country: "Portugal", latitude: 38.72, longitude: -9.13 }] };
const FORECAST = (hour = "2026-11-13T14:00") => ({ current: { time: hour, temperature_2m: 24.3, weather_code: 2, is_day: 1 }, daily: { temperature_2m_max: [26.1, 25], temperature_2m_min: [17.4, 16] },
  hourly: { time: Array.from({ length: 48 }, (_, h) => `2026-11-${13 + Math.floor(h / 24)}T${String(h % 24).padStart(2, "0")}:00`), temperature_2m: Array.from({ length: 48 }, (_, h) => 10 + h / 2), weather_code: Array.from({ length: 48 }, (_, h) => h % 4) } });
function service(answers) {
  const asked = [];
  const fetcher = async (url) => { asked.push(String(url)); const a = answers(String(url)); if (a instanceof Error) throw a; return { ok: a.status === undefined || a.status < 400, status: a.status || 200, json: async () => a.body }; };
  return { asked, fetcher };
}

const LISBON = { name: "Lisbon", admin1: "Lisbon", country: "Portugal", code: "PT", lat: 38.72, lon: -9.13, tz: "Europe/Lisbon" };
const SEARCH = { results: [
  { id: 2267057, name: "Lisbon", latitude: 38.72, longitude: -9.13, country_code: "PT", country: "Portugal", admin1: "Lisbon", timezone: "Europe/Lisbon", population: 517802, elevation: 45 },
  { id: 5160783, name: "Lisbon", latitude: 40.77, longitude: -80.77, country_code: "us", country: "United States", admin1: "Ohio", timezone: "America/New_York" },
  { id: 1, name: "Nowhere", latitude: 999, longitude: 0, country: "X" }, { id: 2, latitude: 1, longitude: 1 }, { id: 3, name: "Bad zone", latitude: 1, longitude: 2, timezone: "Not/AZone;rm", country_code: "ZZZ" }] };

test("Weather: while a city is typed the host asks Open-Meteo's place search, and offers the places it finds", async () => {
  const net = service(() => ({ body: SEARCH })), home = new HomeCards(store(), { fetcher: net.fetcher });
  assert.deepEqual(await home.places(" L ", 1), { type: "homeWeatherPlaces", q: " L ", seq: 1, ok: true, places: [] }, "under two letters nothing is asked");
  assert.deepEqual(net.asked, []);
  const said = await home.places("Lisb", 7);
  assert.equal(net.asked.length, 1);
  const url = new URL(net.asked[0]);
  assert.equal(url.origin + url.pathname, "https://geocoding-api.open-meteo.com/v1/search");
  assert.deepEqual([url.searchParams.get("name"), url.searchParams.get("count"), url.searchParams.get("language")], ["Lisb", "8", "en"]);
  assert.doesNotMatch(net.asked[0], /key|token|home|fungi/i, "the letters typed, and nothing of this machine");
  assert.equal(said.ok, true); assert.equal(said.seq, 7); assert.equal(said.q, "Lisb");
  assert.deepEqual(said.places, [LISBON, { name: "Lisbon", admin1: "Ohio", country: "United States", code: "US", lat: 40.77, lon: -80.77, tz: "America/New_York" }, { name: "Bad zone", admin1: "", country: "", code: "", lat: 1, lon: 2, tz: "" }],
    "each place whole (name, region, country and its code, coordinates, time zone); one with no name or off the Earth is not offered");
  await home.places("lisb", 8);
  assert.equal(net.asked.length, 1, "the same letters again are answered from what was just found");
  const none = new HomeCards(store(), { fetcher: service(() => ({ body: {} })).fetcher });
  assert.deepEqual((await none.places("Qqzz", 1)).places, [], "nobody by that name: an empty list, said by the card");
  const offline = new HomeCards(store(), { fetcher: service(() => new Error("getaddrinfo ENOTFOUND")).fetcher });
  assert.deepEqual(await offline.places("Lisbon", 2), { type: "homeWeatherPlaces", q: "Lisbon", seq: 2, ok: false, reason: "offline" });
  const refused = new HomeCards(store(), { fetcher: service(() => ({ status: 429, body: {} })).fetcher });
  assert.deepEqual(await refused.places("Lisbon", 3), { type: "homeWeatherPlaces", q: "Lisbon", seq: 3, ok: false, reason: "refused" });
});

test("Weather: the place chosen is kept whole and the forecast is asked by its coordinates; nothing is asked before a place is chosen", async () => {
  const context = store(), net = service((url) => ({ body: url.includes("geocoding-api") ? GEO : FORECAST() }));
  let clock = 1_000_000;
  const home = new HomeCards(context, { fetcher: net.fetcher, now: () => clock });
  assert.deepEqual(await home.weather(), { type: "homeWeather", ok: false, reason: "nocity" });
  // A page cannot save a city by its name alone any more, nor a place that is not one.
  await home.setting("weather", { city: "Lisbon" });
  await home.setting("weather", { place: { name: "Lisbon" } });
  await home.setting("weather", { place: { name: "Lisbon", lat: 999, lon: 0 } });
  assert.equal(new HomeCards(context).state().settings.weather?.place, undefined); assert.equal(new HomeCards(context).state().settings.weather?.city, undefined);
  assert.deepEqual(await home.weather(), { type: "homeWeather", ok: false, reason: "nocity" });
  assert.deepEqual(net.asked, [], "no place, no request");
  await home.setting("weather", { place: { ...LISBON, extra: "<script>" } });
  assert.deepEqual(new HomeCards(context).state().settings.weather.place, LISBON, "the place's exact identity, and nothing else");
  const said = await home.weather();
  assert.equal(net.asked.length, 1, "the forecast alone: the place is known");
  const fc = new URL(net.asked[0]);
  assert.equal(fc.origin, "https://api.open-meteo.com"); assert.equal(fc.searchParams.get("latitude"), "38.72"); assert.equal(fc.searchParams.get("longitude"), "-9.13");
  assert.doesNotMatch(net.asked[0], /Lisbon|key|token|home|fungi/i, "by its coordinates: no name, no key, nothing of this machine");
  assert.equal(said.ok, true); assert.equal(said.place, "Lisbon, Portugal");
  assert.deepEqual(said.now, { temp: 24.3, code: 2, day: true }); assert.equal(said.high, 26.1); assert.equal(said.low, 17.4);
  assert.deepEqual(said.hours.map((h) => h.time), ["15:00", "16:00", "17:00", "18:00", "19:00"], "the next few hours");
  // Asked again within the half hour: what it has, no new request. After it: the forecast again.
  await home.weather(); assert.equal(net.asked.length, 1);
  clock += 31 * 60000;
  await home.weather(); assert.equal(net.asked.length, 2);
  // Another place: its own forecast, at once.
  await home.setting("weather", { place: { name: "Porto", admin1: "Porto", country: "Portugal", code: "PT", lat: 41.15, lon: -8.61, tz: "Europe/Lisbon" } });
  const porto = await home.weather();
  assert.equal(new URL(net.asked[2]).searchParams.get("latitude"), "41.15"); assert.equal(porto.place, "Porto, Portugal");
  assert.equal(new HomeCards(context).state().settings.weather.unit, undefined);
  await home.setting("weather", { unit: "f" });
  assert.equal(new HomeCards(context).state().settings.weather.place.name, "Porto", "the unit changes; the place stays");
});

test("Weather: a city typed before places were chosen from a list is found once more and kept as a place", async () => {
  const context = store(), net = service((url) => ({ body: url.includes("geocoding-api") ? { results: [SEARCH.results[0]] } : FORECAST() }));
  await context.globalState.update("dgc.homeCards.v1", { order: ["weather"], settings: { weather: { city: "Lisbon", unit: "f" } } });
  const home = new HomeCards(context, { fetcher: net.fetcher });
  assert.equal(home.state().settings.weather.city, "Lisbon", "the page is told the city it has until its place is found");
  const said = await home.weather();
  assert.equal(said.ok, true); assert.equal(said.place, "Lisbon, Portugal");
  assert.equal(net.asked.length, 2); assert.equal(new URL(net.asked[0]).searchParams.get("name"), "Lisbon"); assert.equal(new URL(net.asked[0]).searchParams.get("count"), "1");
  const kept = new HomeCards(context).state().settings.weather;
  assert.deepEqual(kept, { place: LISBON, unit: "f" }, "kept as the place it is from now on");
  const unknown = store(); await unknown.globalState.update("dgc.homeCards.v1", { settings: { weather: { city: "Qqqqzz" } } });
  assert.deepEqual(await new HomeCards(unknown, { fetcher: service(() => ({ body: { results: [] } })).fetcher }).weather(), { type: "homeWeather", ok: false, reason: "notfound" });
});

test("Weather offline or refused: said calmly, never thrown", async () => {
  const offline = new HomeCards(store(), { fetcher: service(() => new Error("getaddrinfo ENOTFOUND")).fetcher });
  await offline.setting("weather", { place: LISBON });
  assert.deepEqual(await offline.weather(), { type: "homeWeather", ok: false, reason: "offline" });
  const refused = new HomeCards(store(), { fetcher: service(() => ({ status: 429, body: {} })).fetcher });
  await refused.setting("weather", { place: LISBON });
  assert.deepEqual(await refused.weather(), { type: "homeWeather", ok: false, reason: "refused" });
});

test("the token report as the card takes it: the days as DGC counted them, and the models by tokens with their provider and share", () => {
  const report = { range: "all", by_day: [{ date: "2026-11-12", input_tokens: 10, output_tokens: 5, cached_input_tokens: 4, requests: 2 }, { date: "bad", input_tokens: 1 }, { date: "2026-11-13", input_tokens: 7, output_tokens: 1, cached_input_tokens: 0, requests: 1, prompt: "never" }],
    by_model: [{ model: "qwen3.5-coder", provider: "ollama", system: "This computer", system_id: "computer:this", input_tokens: 3, output_tokens: 1 }, { model: "deepseek", provider: "x", input_tokens: 30, output_tokens: 10 },
      { model: "qwen3.5-coder", provider: "ollama", system: "This computer", host: "127.0.0.1:11434", input_tokens: 5, output_tokens: 1 }, { model: "", provider: "ollama", input_tokens: 9 }, { model: "idle", provider: "ollama", input_tokens: 0, output_tokens: 0 }] };
  const today = { range: "today", by_day: [{ date: "2026-11-13", input_tokens: 7, output_tokens: 1 }], by_model: [{ model: "qwen3:8b", provider: "ollama", system: "This computer", input_tokens: 6, output_tokens: 0 }, { model: "deepseek", provider: "deepseek", system: "DeepSeek", input_tokens: 1, output_tokens: 1 }] };
  const said = usageForHome(report, { range: "30d", by_model: report.by_model }, today);
  assert.equal(said.type, "homeUsage");
  assert.deepEqual(said.days.map(({ models, ...d }) => d), [{ date: "2026-11-12", input_tokens: 10, output_tokens: 5, cached_input_tokens: 4, requests: 2 }, { date: "2026-11-13", input_tokens: 7, output_tokens: 1, cached_input_tokens: 0, requests: 1 }]);
  assert.deepEqual(said.models, [{ name: "deepseek", model: "deepseek", provider: "X", where: "", tokens: 40, share: 80 }, { name: "qwen3.5-coder (This computer)", model: "qwen3.5-coder", provider: "Ollama", where: "This computer", tokens: 10, share: 20 }],
    "most tokens first; the same model on the same provider and system is one row; each with its provider as people call it and its share");
  assert.equal(said.modelCount, 2);
  assert.equal(said.days[0].models, undefined, "a day the report names no models for has none");
  assert.deepEqual(said.days[1].models.map((m) => [m.model, m.provider, m.share]), [["qwen3:8b", "Ollama", 75], ["deepseek", "DeepSeek", 25]], "today's models come from today's own report");
  // Should the ledger name a day's models itself, they are that day's (its top three).
  const own = usageForHome({ by_day: [{ date: "2026-11-12", input_tokens: 1, models: [{ model: "a", provider: "ollama", input_tokens: 1 }, { model: "b", provider: "ollama", input_tokens: 4 }, { model: "c", provider: "openai", input_tokens: 3 }, { model: "d", provider: "x", input_tokens: 2 }] }] }, null);
  assert.deepEqual(own.days[0].models.map((m) => `${m.model} ${m.provider} ${m.share}`), ["b Ollama 40", "c OpenAI 30", "d X 20"]);
  assert.equal(usageForHome({ error: "The ledger is locked." }, null).error, "The ledger is locked.");
  const many = usageForHome({}, { by_model: Array.from({ length: 12 }, (_, k) => ({ model: `m${k}`, provider: "ollama", input_tokens: 100 - k })) });
  assert.equal(many.models.length, 8, "the card is sent its top eight"); assert.equal(many.modelCount, 12, "and how many there were");
});

test("a page's messages: only Home's own are taken, and each answers with what is kept", async () => {
  const context = store(), net = service((url) => ({ body: url.includes("geocoding-api") ? GEO : FORECAST() })), home = new HomeCards(context, { fetcher: net.fetcher }), said = [];
  const reply = (m) => said.push(m);
  assert.equal(home.handle({ type: "dockReady" }, reply), false);
  assert.equal(home.handle({ type: "homeCardsReady" }, reply), true);
  assert.deepEqual(said.at(-1).order, HOME_DEFAULT);
  assert.equal(home.handle({ type: "homeCardsSet", order: ["note"] }, reply), true);
  await new Promise((d) => setTimeout(d, 10));
  assert.deepEqual(said.at(-1).order, ["note"]);
  assert.equal(home.handle({ type: "homeWeatherSuggest", q: "Lis", seq: 4 }, reply), true);
  await new Promise((d) => setTimeout(d, 30));
  assert.deepEqual([said.at(-1).type, said.at(-1).seq, said.at(-1).places.map((p) => p.name)], ["homeWeatherPlaces", 4, ["Lisbon"]], "the letters typed are answered with the places found");
  home.handle({ type: "homeCardSetting", card: "weather", settings: { place: said.at(-1).places[0] } }, reply);
  await new Promise((d) => setTimeout(d, 30));
  assert.ok(said.some((m) => m.type === "homeWeather" && m.ok && m.place === "Lisbon, Portugal"), "a place chosen is answered with its weather");
  // (14 Nov: the old "homeNote" message is gone with the notes kept in this state; a store with no storage folder takes none.)
  assert.equal(home.handle({ type: "homeNote", op: "save", note: { id: "n0001", text: "A note", at: 5, pinned: false } }, reply), false);
  home.handle({ type: "homeCardsReset" }, reply);
  await new Promise((d) => setTimeout(d, 10));
  assert.deepEqual(said.at(-1).order, HOME_DEFAULT);
});

// ---- Notes, the full app (14 Nov): Home's host hands a Notes message to the notes' own store (src/notes.ts) -------------
test("a Notes message goes to the notes' own store, which keeps files in DGC's storage folder", async () => {
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs"), { tmpdir } = await import("node:os"), { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "dgc-home-notes-"));
  try {
    const context = { ...store(), globalStorageUri: { fsPath: dir }, secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} } }, home = new HomeCards(context), said = [];
    assert.equal(home.handle({ type: "homeNotesDo", op: "save", id: "note01", text: "Tide tables\nlow water 06:12" }, (m) => said.push(m)), true);
    await home.notes.idle();
    assert.deepEqual(said.find((m) => m.type === "homeNotes").notes.map((n) => [n.id, n.title, n.line]), [["note01", "Tide tables", "low water 06:12"]]);
    assert.equal(existsSync(join(dir, "notes", "note01.md")), true);
    assert.equal(context.kept.get("dgc.homeCards.v1"), undefined, "nothing of it in the extension's state");
    // Home ready: answered with its cards and with the list of notes (the page asks for no more than that).
    const ready = []; home.handle({ type: "homeCardsReady" }, (m) => ready.push(m.type)); await home.notes.idle();
    assert.deepEqual(ready, ["homeCards", "homeNotes"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
