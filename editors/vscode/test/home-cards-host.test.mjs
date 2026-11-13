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
  assert.deepEqual(Object.keys(home.state()).sort(), ["order", "settings", "type"]);
  assert.equal("palettes" in (context.kept.get("dgc.homeCards.v1") || {}), false);
});

test("the everyday cards' settings are kept with the layout, and only what a card has", async () => {
  const context = store(), home = new HomeCards(context);
  await home.setting("note", { text: "Buy seeds\nthen water", evil: "<script>" });
  await home.setting("clock", { zone: "Asia/Tokyo" });
  await home.setting("clock", { zone: "Not/AZone;rm" });
  await home.setting("weather", { unit: "f" });
  await home.setting("token", { anything: 1 });
  const kept = new HomeCards(context).state().settings;
  assert.deepEqual(kept.note, { text: "Buy seeds\nthen water" });
  assert.deepEqual(kept.clock, { zone: "Asia/Tokyo" }, "a time zone that is not one changes nothing");
  assert.equal(kept.weather.unit, "f"); assert.equal(kept.token, undefined);
  await home.setting("note", { text: "x".repeat(9000) });
  assert.equal(new HomeCards(context).state().settings.note.text.length, 4000, "a note is at most 4,000 characters");
});

const GEO = { results: [{ name: "Lisbon", country: "Portugal", latitude: 38.72, longitude: -9.13 }] };
const FORECAST = (hour = "2026-11-13T14:00") => ({ current: { time: hour, temperature_2m: 24.3, weather_code: 2, is_day: 1 }, daily: { temperature_2m_max: [26.1, 25], temperature_2m_min: [17.4, 16] },
  hourly: { time: Array.from({ length: 48 }, (_, h) => `2026-11-${13 + Math.floor(h / 24)}T${String(h % 24).padStart(2, "0")}:00`), temperature_2m: Array.from({ length: 48 }, (_, h) => 10 + h / 2), weather_code: Array.from({ length: 48 }, (_, h) => h % 4) } });
function service(answers) {
  const asked = [];
  const fetcher = async (url) => { asked.push(String(url)); const a = answers(String(url)); if (a instanceof Error) throw a; return { ok: a.status === undefined || a.status < 400, status: a.status || 200, json: async () => a.body }; };
  return { asked, fetcher };
}

test("Weather: the host asks Open-Meteo for the city the user typed, and nothing before a city is typed", async () => {
  const context = store(), net = service((url) => ({ body: url.includes("geocoding-api") ? GEO : FORECAST() }));
  let clock = 1_000_000;
  const home = new HomeCards(context, { fetcher: net.fetcher, now: () => clock });
  assert.deepEqual(await home.weather(), { type: "homeWeather", ok: false, reason: "nocity" });
  assert.deepEqual(net.asked, [], "no city, no request");
  await home.setting("weather", { city: "  Lisbon " });
  const said = await home.weather();
  assert.equal(net.asked.length, 2);
  const geo = new URL(net.asked[0]), fc = new URL(net.asked[1]);
  assert.equal(geo.origin, "https://geocoding-api.open-meteo.com"); assert.equal(geo.searchParams.get("name"), "Lisbon"); assert.equal(geo.searchParams.get("count"), "1");
  assert.equal(fc.origin, "https://api.open-meteo.com"); assert.equal(fc.searchParams.get("latitude"), "38.72"); assert.equal(fc.searchParams.get("longitude"), "-9.13");
  for (const url of net.asked) assert.doesNotMatch(url, /key|token|home|fungi/i, "no key, no account, nothing of this machine");
  assert.equal(said.ok, true); assert.equal(said.place, "Lisbon, Portugal");
  assert.deepEqual(said.now, { temp: 24.3, code: 2, day: true }); assert.equal(said.high, 26.1); assert.equal(said.low, 17.4);
  assert.deepEqual(said.hours.map((h) => h.time), ["15:00", "16:00", "17:00", "18:00", "19:00"], "the next few hours");
  assert.equal(said.hours[0].temp, 10 + 15 / 2);
  // Asked again within the half hour: what it has, no new request. After it: the forecast again (the place is known).
  await home.weather(); assert.equal(net.asked.length, 2);
  clock += 31 * 60000;
  await home.weather(); assert.equal(net.asked.length, 3); assert.match(net.asked[2], /api\.open-meteo\.com\/v1\/forecast/);
  // Another city: found again.
  await home.setting("weather", { city: "Porto" });
  await home.weather(); assert.equal(new URL(net.asked[3]).searchParams.get("name"), "Porto");
});

test("Weather offline, refused or a city nobody knows: said calmly, never thrown", async () => {
  const offline = new HomeCards(store(), { fetcher: service(() => new Error("getaddrinfo ENOTFOUND")).fetcher });
  await offline.setting("weather", { city: "Lisbon" });
  assert.deepEqual(await offline.weather(), { type: "homeWeather", ok: false, reason: "offline" });
  const refused = new HomeCards(store(), { fetcher: service(() => ({ status: 429, body: {} })).fetcher });
  await refused.setting("weather", { city: "Lisbon" });
  assert.deepEqual(await refused.weather(), { type: "homeWeather", ok: false, reason: "refused" });
  const unknown = new HomeCards(store(), { fetcher: service(() => ({ body: { results: [] } })).fetcher });
  await unknown.setting("weather", { city: "Qqqqzz" });
  assert.deepEqual(await unknown.weather(), { type: "homeWeather", ok: false, reason: "notfound" });
});

test("the token report as the card takes it: the days as DGC counted them, and the models by tokens", () => {
  const report = { range: "all", by_day: [{ date: "2026-11-12", input_tokens: 10, output_tokens: 5, cached_input_tokens: 4, requests: 2 }, { date: "bad", input_tokens: 1 }, { date: "2026-11-13", input_tokens: 7, output_tokens: 1, cached_input_tokens: 0, requests: 1, prompt: "never" }],
    by_model: [{ model: "qwen3.5-coder", provider: "ollama", system_name: "This computer", input_tokens: 3, output_tokens: 1 }, { model: "deepseek", provider: "x", input_tokens: 30, output_tokens: 10 }] };
  const said = usageForHome(report, { range: "30d", by_model: report.by_model });
  assert.equal(said.type, "homeUsage");
  assert.deepEqual(said.days, [{ date: "2026-11-12", input_tokens: 10, output_tokens: 5, cached_input_tokens: 4, requests: 2 }, { date: "2026-11-13", input_tokens: 7, output_tokens: 1, cached_input_tokens: 0, requests: 1 }]);
  assert.deepEqual(said.models, [{ name: "deepseek", tokens: 40 }, { name: "qwen3.5-coder (This computer)", tokens: 4 }]);
  assert.equal(usageForHome({ error: "The ledger is locked." }, null).error, "The ledger is locked.");
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
  home.handle({ type: "homeCardSetting", card: "weather", settings: { city: "Lisbon" } }, reply);
  await new Promise((d) => setTimeout(d, 30));
  assert.ok(said.some((m) => m.type === "homeWeather" && m.ok && m.place === "Lisbon, Portugal"), "a city typed is answered with its weather");
  home.handle({ type: "homeCardsReset" }, reply);
  await new Promise((d) => setTimeout(d, 10));
  assert.deepEqual(said.at(-1).order, HOME_DEFAULT);
});
