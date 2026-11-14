// The Home batch of 14 Nov (he tested the installed build and asked):
//  - Clock: Here plus up to three more time zones (four in all), each added one with an × (shown when its clock is
//    pointed at or has the keyboard); the Small card shows the home zone only; four fit without a city's name cut. The
//    one zone kept before (`clock.zone`) is the first added zone.
//  - Weather: adding the card always asks for the place, with the saved place in the field; "Change place" is on every
//    size; a weather that could not be read offers Try again (it stayed "Can't reach" for half an hour after one miss).
//  - The Project Folder dropdown: no first line that pins the chosen folder (each row's own pin does it, a button the
//    keyboard reaches with Right); and its search field covers the rows that scroll under it, with no gap above it.
// The host's part against src/homeCards.ts (bundled against a stub `vscode`); the rest in real Chromium on the real
// side bar (support/home-grid-scene.mjs: the host and the weather there are stand-ins, and nothing touches a network).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { openGrid, LISBON, FOLDERS, THIRTY_FOLDERS } from "./support/home-grid-scene.mjs";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";

const root = new URL("..", import.meta.url).pathname;
globalThis.__HB_VSCODE = {};
const out = await build({ entryPoints: [root + "src/homeCards.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__HB_VSCODE;" })); } }] });
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, (await import("node:module")).createRequire(import.meta.url));
const { HomeCards } = mod.exports;
const store = () => { const kept = new Map(); return { globalState: { get: (k) => kept.get(k), update: async (k, v) => { if (v === undefined) kept.delete(k); else kept.set(k, JSON.parse(JSON.stringify(v))); } }, kept }; };

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const sel = (id, where = ".hc-grid") => `${where} .hc-card[data-card="${id}"]`;
const posted = (p, type) => p.evaluate((t) => window.__posted.filter((m) => m && m.type === t), type);
/** Until an element's opacity has come to 1 (or two seconds have gone): what it is then. */
const shown = (locator) => locator.evaluate((n) => new Promise((done) => { const t0 = performance.now(); (function look() { const o = Number(getComputedStyle(n).opacity); if (o === 1 || performance.now() - t0 > 2000) done(o); else requestAnimationFrame(look); })(); }));
const THREE = ["Asia/Tokyo", "America/Los_Angeles", "Europe/London"];
/** A Clock card as it is on screen: each clock (its words, whether it is cut, its ×), the field, whether anything spills. */
const clockNow = (p, card) => p.evaluate((q) => {
  const c = document.querySelector(q), box = c.getBoundingClientRect();
  const clocks = [...c.querySelectorAll(".hc-clock")].map((k) => { const r = k.getBoundingClientRect(), x = k.querySelector(".hc-zone-x");
    return { text: k.innerText.replace(/\s+/g, " ").trim(), inside: r.left >= box.left - 0.5 && r.right <= box.right + 0.5 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5,
      cut: [...k.querySelectorAll("*")].some((n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow !== "visible"), top: Math.round(r.top), left: Math.round(r.left),
      x: x ? { tag: x.tagName, label: x.getAttribute("aria-label"), opacity: Number(getComputedStyle(x).opacity), radius: getComputedStyle(x).borderTopLeftRadius, w: x.getBoundingClientRect().width } : null }; });
  return { form: c.dataset.form, clocks, field: c.querySelector("input.hc-zone") ? { placeholder: c.querySelector("input.hc-zone").placeholder, value: c.querySelector("input.hc-zone").value } : null,
    spills: c.scrollHeight > c.clientHeight + 1 || c.scrollWidth > c.clientWidth + 1, text: c.innerText.replace(/\s+/g, " ").trim() };
}, card);

// ---- the host: what is kept --------------------------------------------------------------------------------------------
test("Clock, kept: up to three added time zones, each a real one and once; the one zone kept before is the first of them", async () => {
  const old = store(); await old.globalState.update("dgc.homeCards.v1", { order: ["clock"], settings: { clock: { zone: "Asia/Tokyo" } } });
  let home = new HomeCards(old);
  assert.deepEqual(home.state().settings.clock, { zones: ["Asia/Tokyo"] }, "the second city kept before 14 Nov is the first added zone");
  await home.setting("clock", { zones: ["Asia/Tokyo", "Europe/London"] });
  assert.deepEqual(new HomeCards(old).state().settings.clock, { zones: ["Asia/Tokyo", "Europe/London"] }, "kept across a reload");
  await home.setting("clock", { zones: ["Asia/Tokyo", "Europe/London", "Asia/Tokyo", "UTC", "Asia/Kolkata", "Europe/Paris"] });
  assert.deepEqual(home.state().settings.clock, { zones: ["Asia/Tokyo", "Europe/London", "UTC"] }, "each once, and three at most (four with Here)");
  await home.setting("clock", { zones: ["Europe/Lisbon", "Not/AZone;rm"] });
  await home.setting("clock", { zones: "Europe/Lisbon" });
  await home.setting("clock", { zones: [7, null] });
  assert.deepEqual(home.state().settings.clock, { zones: ["Asia/Tokyo", "Europe/London", "UTC"] }, "a list with anything that is not a time zone changes nothing");
  await home.setting("clock", { zones: ["Europe/London", "UTC"] });
  assert.deepEqual(home.state().settings.clock, { zones: ["Europe/London", "UTC"] }, "one taken away");
  await home.setting("clock", { zones: [] });
  assert.equal(new HomeCards(old).state().settings.clock, undefined, "none: only Here");
  // A page from before (it sends the one zone): that zone is the first added one, and "" takes the first away.
  home = new HomeCards(store());
  await home.setting("clock", { zone: "Asia/Tokyo" }); await home.setting("clock", { zones: ["Asia/Tokyo", "UTC"] }); await home.setting("clock", { zone: "Europe/Paris" });
  assert.deepEqual(home.state().settings.clock, { zones: ["Europe/Paris", "UTC"] });
  await home.setting("clock", { zone: "" });
  assert.deepEqual(home.state().settings.clock, { zones: ["UTC"] });
});

// ---- Clock ---------------------------------------------------------------------------------------------------------------
for (const [theme, width] of [["dark-modern", 300], ["dark-modern", 460], ["light-modern", 300], ["light-modern", 460]]) {
  test(`Clock, ${width}px ${theme}: Here and up to three more, added from the field, each with an × that takes it away`, async (t) => {
    if (skipOrFail(t)) return;
    // (Kept as it was before 14 Nov: one zone.)
    const x = await openGrid(browser, { width, theme, layout: ["clock", "weather"], settings: { clock: { zone: "Asia/Tokyo" } } });
    try {
      const p = x.page;
      if (width < 380) {
        const small = await clockNow(p, sel("clock"));
        assert.equal(small.form, "s"); assert.match(small.text, /^Clock \d\d:\d\d \w{3},? \d{1,2} \w{3}$/, `the Small card is Here's time and date, and nothing else (${small.text})`);
        assert.doesNotMatch(small.text, /Tokyo/, "never another zone on the Small card");
        await p.click(sel("clock")); await x.rest(200);
      }
      const card = width < 380 ? ".hc-open .hc-card" : sel("clock"), field = `${card} input.hc-zone`;
      let c = await clockNow(p, card);
      // Tokyo is already tomorrow here in the evening (IST + 3:30): the card says so, and so does what it is checked against.
      const day = await p.evaluate(() => { const f = (zone) => new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
        const here = f(undefined), there = f("Asia/Tokyo"); return there > here ? " · tomorrow" : there < here ? " · yesterday" : ""; });
      assert.deepEqual(c.clocks.map((k) => k.text.replace(/^\d\d:\d\d /, "")), ["Here", "Tokyo · UTC+9" + day], "the zone kept before is the first added one");
      assert.equal(c.clocks[0].x, null, "Here cannot be removed");
      assert.deepEqual([c.clocks[1].x.tag, c.clocks[1].x.label], ["BUTTON", "Remove Tokyo"], "an added zone has an ×, a button with its name");
      assert.equal(c.field.placeholder, "Add a city"); assert.equal(c.field.value, "", "the field adds: it names no city");
      // Add two more from the field: every zone is offered but the ones already there, and never "No second city".
      await p.click(field); await x.rest(150);
      const offered = await p.evaluate(() => [...document.querySelectorAll('.hc-suggest [role="option"] .hc-opt-name')].map((n) => n.textContent));
      assert.ok(offered.length > 300 && !offered.includes("No second city") && !offered.includes("Tokyo"), `every other time zone (${offered.length}), no “No second city”`);
      await p.keyboard.type("los ang"); await x.rest(150); await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(300);
      assert.deepEqual((await x.host()).settings.clock.zones, ["Asia/Tokyo", "America/Los_Angeles"]);
      await p.click(field); await p.keyboard.type("london"); await x.rest(150); await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(300);
      assert.deepEqual((await x.host()).settings.clock.zones, THREE);
      c = await clockNow(p, card);
      assert.deepEqual(c.clocks.map((k) => k.text.replace(/^\d\d:\d\d /, "").replace(/ · UTC.*$/, "")), ["Here", "Tokyo", "Los Angeles", "London"], "four in all");
      assert.equal(c.field, null, "four is the most: the field is gone");
      assert.deepEqual(c.clocks.filter((k) => k.cut || !k.inside).map((k) => k.text), [], "no city's name is cut, and every clock is inside the card");
      assert.equal(c.spills, false, "nothing spills out of the card");
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing scrolls sideways");
      // The ×: out of sight at rest, shown when its clock is pointed at, and when the keyboard is on it.
      const los = p.locator(`${card} .hc-clock`).nth(2), cross = los.locator(".hc-zone-x");
      await p.mouse.move(2, 880); await x.rest(250);
      assert.equal(Number(await cross.evaluate((n) => getComputedStyle(n).opacity)), 0, "at rest no × shows");
      await los.hover(); assert.equal(await shown(cross), 1, "pointed at: its × shows");
      assert.equal(Number(await p.locator(`${card} .hc-clock`).nth(1).locator(".hc-zone-x").evaluate((n) => getComputedStyle(n).opacity)), 0, "and only its own: Tokyo's stays out of sight");
      assert.ok(parseFloat(await cross.evaluate((n) => getComputedStyle(n).borderTopLeftRadius)) <= 6, "the one corner");
      await p.mouse.move(2, 880); await x.rest(250);
      await p.locator(`${card} .hc-clock`).nth(1).locator(".hc-zone-x").focus(); await p.keyboard.press("Tab");
      assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Remove Los Angeles", "Tab goes from one × to the next");
      assert.equal(await shown(cross), 1, "on the keyboard: its × shows");
      await p.keyboard.press("Enter"); await x.rest(300);
      assert.deepEqual((await x.host()).settings.clock.zones, ["Asia/Tokyo", "Europe/London"], "Enter on the × takes that zone away");
      c = await clockNow(p, card);
      assert.equal(c.clocks.length, 3); assert.equal(c.field?.placeholder, "Add a city", "fewer than four: the field is back");
      assert.match(await p.evaluate(() => document.activeElement?.getAttribute("aria-label") || ""), /^Remove /, "the keyboard stays on the clocks");
      await p.locator(`${card} .hc-clock`).nth(1).hover(); await p.locator(`${card} .hc-clock`).nth(1).locator(".hc-zone-x").click(); await x.rest(300);
      assert.deepEqual((await x.host()).settings.clock.zones, ["Europe/London"], "a click on the × too");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
for (const theme of ["dark-modern", "light-modern"]) {
  test(`Clock, ${theme}: with four zones the Small card is Here alone, and the wide side bar's card shows all four, none cut`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width: 300, theme, layout: ["clock", "weather", "token"], settings: { clock: { zones: THREE }, weather: { place: LISBON } } });
    try {
      const p = x.page;
      let c = await clockNow(p, sel("clock"));
      assert.equal(c.form, "s"); assert.doesNotMatch(c.text, /Tokyo|Los Angeles|London|UTC/, `only the home zone on a Small card (${c.text})`);
      assert.match(c.text, /^Clock \d\d:\d\d \w{3},? \d{1,2} \w{3}$/); assert.equal(c.spills, false);
      for (const width of [460, 700, 1000]) {
        await x.resize(width);
        c = await clockNow(p, sel("clock"));
        assert.deepEqual(c.clocks.map((k) => k.text.replace(/^\d\d:\d\d /, "").replace(/ · UTC.*$/, "")), ["Here", "Tokyo", "Los Angeles", "London"], `${width}: all four`);
        assert.deepEqual(c.clocks.filter((k) => k.cut || !k.inside).map((k) => k.text), [], `${width}: no name cut, every clock inside the card`);
        assert.equal(c.spills, false, `${width}: nothing spills`);
        assert.ok(c.clocks.every((k) => / · UTC/.test(k.text) || /Here/.test(k.text)), "each added zone says its offset");
        const rows = new Set(c.clocks.map((k) => k.top)).size; assert.ok(rows <= 2, `${width}: one row or two (${rows})`);
      }
      // The longest names there are still fit (two rows of two at 460 px).
      await x.resize(460);
      await p.evaluate(() => window.__posted.push({ type: "homeCardSetting", card: "clock", settings: { zones: ["Asia/Ho_Chi_Minh", "Antarctica/DumontDUrville", "America/Argentina/Rio_Gallegos"] } })); await x.rest(300);
      c = await clockNow(p, sel("clock"));
      assert.equal(c.clocks.length, 4); assert.deepEqual(c.clocks.filter((k) => k.cut || !k.inside).map((k) => k.text), [], "long names whole"); assert.equal(c.spills, false);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- Weather -------------------------------------------------------------------------------------------------------------
test("Weather: adding the card asks for the place every time, with the saved place in the field", async (t) => {
  if (skipOrFail(t)) return;
  // (Weather was on Home once, with Lisbon; then it was removed. Its place is still kept.)
  const x = await openGrid(browser, { width: 460, layout: ["clock", "quick"], settings: { weather: { place: LISBON, unit: "c" } } });
  try {
    const p = x.page, item = '.hc-lib-item[data-card="weather"]';
    await p.click(".hc-cards-btn"); await x.rest(300);
    await p.click(`${item} .hc-add`); await x.rest(200);
    assert.equal((await x.host()).order.includes("weather"), false, "Add asks for the place first: nothing is added yet");
    assert.equal(await p.inputValue(`${item} .hc-city`), "Lisbon, Portugal", "the place kept is in the field");
    assert.equal(await p.locator(`${item} .hc-add-city`).isDisabled(), false, "and Add is on: it is a place from the list already");
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("hc-city") && document.activeElement.selectionStart === 0 && document.activeElement.selectionEnd === document.activeElement.value.length), true, "its words are selected: typing replaces them");
    assert.match(await p.locator(item).innerText(), /Open-Meteo/, "it says where the letters typed are sent");
    assert.deepEqual(await p.evaluate(() => window.__geoAsked), [], "nothing was asked of the place search to show it");
    // Another place: typed, chosen, added.
    await p.keyboard.type("Port"); await x.rest(450);
    assert.equal(await p.locator(`${item} .hc-add-city`).isDisabled(), true, "typed over: Add waits for a choice again");
    await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(100);
    await p.click(`${item} .hc-add-city`); await x.rest(300);
    let kept = await x.host();
    assert.equal(kept.order.at(-1), "weather"); assert.equal(kept.settings.weather.place.name, "Porto");
    // Removed and added again: asked again, with Porto; Add as it is keeps it.
    await p.click(`${item} .hc-remove`); await x.rest(300);
    await p.click(`${item} .hc-add`); await x.rest(200);
    assert.equal((await x.host()).order.includes("weather"), false);
    assert.equal(await p.inputValue(`${item} .hc-city`), "Porto, Portugal");
    await p.click(`${item} .hc-add-city`); await x.rest(300);
    kept = await x.host();
    assert.equal(kept.order.at(-1), "weather"); assert.equal(kept.settings.weather.place.name, "Porto"); assert.equal(kept.settings.weather.unit, "c", "the unit is kept");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  test(`Weather, ${theme}: Change place is on every size; a card that cannot show the field opens the whole card at it`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width: 300, theme, layout: ["weather", "clock", "token"], settings: { weather: { place: LISBON, unit: "c" } } });
    try {
      const p = x.page, fits = (q) => p.evaluate((s) => { const c = document.querySelector(s), b = c.getBoundingClientRect(); return c.scrollHeight <= c.clientHeight + 1 && c.scrollWidth <= c.clientWidth + 1 && [...c.querySelectorAll("button, span, p")].every((n) => { const r = n.getBoundingClientRect(); return !r.width || (r.bottom <= b.bottom + 0.5 && r.right <= b.right + 0.5); }); }, q);
      const focusOn = () => p.evaluate(() => { const a = document.activeElement; return [a?.classList.contains("hc-city"), !!a?.closest(".hc-open"), !!a?.closest(".hc-grid")]; });
      // Small (300 px): a button on the card; it opens the whole card with the field, the keyboard in it.
      let edit = p.locator(`${sel("weather")} .hc-city-edit`);
      assert.equal(await p.getAttribute(sel("weather"), "data-form"), "s");
      assert.equal(await edit.count(), 1, "Small: Change place is on the card"); assert.equal((await edit.innerText()).trim(), "Change place");
      assert.equal(await edit.evaluate((n) => n.tagName), "BUTTON");
      assert.equal(await fits(sel("weather")), true, "and the Small card still holds everything it shows");
      await edit.click(); await x.rest(300);
      assert.equal((await x.grid()).open?.id, "weather", "it opens the whole card");
      assert.deepEqual(await focusOn(), [true, true, false], "at the field");
      await p.keyboard.type("Port"); await x.rest(450); await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(100);
      await p.click('.hc-open .hc-cityform button[type="submit"]'); await x.rest(300);
      assert.equal((await x.host()).settings.weather.place.name, "Porto", "and the place chosen there is kept");
      await p.keyboard.press("Escape"); await x.rest(300);
      assert.equal((await x.grid()).open, null);
      // Medium, as tall as it needs (460 px): the field shows in the card itself; Escape puts it away.
      await x.resize(460);
      edit = p.locator(`${sel("weather")} .hc-city-edit`);
      assert.equal(await p.getAttribute(sel("weather"), "data-form"), "m"); assert.equal(await edit.count(), 1, "Medium: Change place is on the card");
      await edit.click(); await x.rest(300);
      assert.equal((await x.grid()).open, null, "a Medium card has the room: it is not opened");
      assert.deepEqual(await focusOn(), [true, false, true], "the field is in the card, the keyboard in it");
      await p.keyboard.press("Escape"); await x.rest(200);
      assert.equal(await p.locator(`${sel("weather")} .hc-city`).count(), 0, "Escape puts the field away"); assert.equal((await x.grid()).open, null);
      assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("hc-city-edit")), true, "and the keyboard is back on Change place");
      // Medium in the wide side bar (700 px, a fixed height): no room for the field, so the whole card opens at it.
      await x.resize(700);
      edit = p.locator(`${sel("weather")} .hc-city-edit`);
      assert.equal(await edit.count(), 1, "700 px: Change place is on the card"); assert.equal(await fits(sel("weather")), true, "and the card still holds everything it shows");
      await edit.click(); await x.rest(300);
      assert.equal((await x.grid()).open?.id, "weather"); assert.deepEqual(await focusOn(), [true, true, false]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Weather that could not be read: Try again asks at once, on every size, and Change place is still there", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["weather", "clock"], settings: { weather: { place: LISBON, unit: "c" } }, weather: { type: "homeWeather", ok: false, reason: "offline" } });
  try {
    const p = x.page, WEATHER = { type: "homeWeather", ok: true, place: "Lisbon, Portugal", at: Date.now(), now: { temp: 24.3, code: 2, day: true }, high: 26.1, low: 17.4, hours: [] };
    assert.match(await p.locator(sel("weather")).innerText(), /Can’t reach the weather right now/);
    assert.equal(await p.locator(`${sel("weather")} .hc-city-edit`).count(), 1, "the place can still be changed");
    const asked = (await posted(p, "homeWeatherGet")).length;
    const again = p.locator(`${sel("weather")} .hc-wx-retry`);
    assert.equal((await again.innerText()).trim(), "Try again"); assert.equal(await again.evaluate((n) => n.tagName), "BUTTON");
    await again.click(); await x.rest(200);
    assert.equal((await posted(p, "homeWeatherGet")).length, asked + 1, "Try again asks the host now (no half-hour wait)");
    assert.match(await p.locator(sel("weather")).innerText(), /Can’t reach the weather right now/, "still out of reach: it says so still");
    await p.evaluate((w) => { window.__homeWeather = w; }, WEATHER);
    await again.click(); await x.rest(300);
    assert.match(await p.locator(sel("weather")).innerText(), /24°/, "reached: the weather shows");
    assert.equal(await p.locator(`${sel("weather")} .hc-wx-retry`).count(), 0);
    // Small: the same two answers.
    await p.evaluate(() => { window.__homeWeather = { type: "homeWeather", ok: false, reason: "offline" }; window.dispatchEvent(new MessageEvent("message", { data: window.__homeWeather })); });
    await x.resize(300);
    assert.equal(await p.locator(`${sel("weather")} .hc-wx-retry`).count(), 1, "Small: Try again"); assert.equal(await p.locator(`${sel("weather")} .hc-city-edit`).count(), 1, "Small: Change place");
    assert.equal(await p.evaluate((q) => { const c = document.querySelector(q); return c.scrollHeight <= c.clientHeight + 1; }, sel("weather")), true, "and the Small card holds them");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- the Project Folder dropdown -----------------------------------------------------------------------------------------
const GARDEN = "/home/me/garden-notes";
const withFolders = async (x, choice = "", rows = FOLDERS.rows) => { await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { ...FOLDERS, rows, choice } }); await x.settle(); };
const folderPins = (x) => x.page.evaluate(() => window.__dock.pins.filter((p) => p.kind === "folder").map((p) => [p.title, p.ref.folder]));

test("Project Folder dropdown: no first line that pins the chosen folder; each row's own pin is a button the keyboard reaches", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 460, pins: [] });
  try {
    const p = x.page;
    await withFolders(x, GARDEN);
    await p.focus("#sessions-folder-pick"); await p.keyboard.press("ArrowDown"); await x.settle(); await p.waitForTimeout(700);
    assert.equal(await p.locator(".dgc-folder-menu [data-folder-pin-line]").count(), 0, "no line that pins the chosen folder");
    assert.equal(await p.evaluate(() => document.querySelector(".dgc-folder-menu .dgc-menu-row")?.dataset.folder), "", "the menu's first line is All projects");
    assert.doesNotMatch(await p.locator(".dgc-folder-menu").innerText(), /to the dock|from the dock/);
    // Each folder's row has its own pin: a real button beside the row (a button cannot hold a button), with its name.
    const pins = await p.evaluate(() => [...document.querySelectorAll(".dgc-folder-menu .dgc-folder-pin")].map((n) => ({ tag: n.tagName, type: n.getAttribute("type"), label: n.getAttribute("aria-label"), pressed: n.getAttribute("aria-pressed"), inButton: !!n.parentElement.closest("button"), folder: n.dataset.folderPin,
      besideRow: n.parentElement.querySelector(".dgc-folder-row")?.dataset.folder, focusable: n.tabIndex >= -1 && !n.disabled })));
    assert.deepEqual(pins.map((n) => n.label), ["Pin to the dock: shop", "Pin to the dock: garden-notes", "Pin to the dock: rust_ire", "Pin to the dock: invoices"], "every folder that is there has one, by name (a gone folder has none)");
    assert.ok(pins.every((n) => n.tag === "BUTTON" && n.type === "button" && !n.inButton && n.besideRow === n.folder && n.focusable && n.pressed === "false"), JSON.stringify(pins));
    // The keyboard: Down opened it on the chosen row; Right goes to that row's pin, which shows; Enter pins; the menu stays.
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.folder), GARDEN);
    await p.keyboard.press("ArrowRight");
    const pin = p.locator(`.dgc-folder-menu .dgc-folder-pin[data-folder-pin="${GARDEN}"]`);
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.folderPin), GARDEN, "Right: the row's pin has the keyboard");
    assert.equal(await shown(pin), 1, "and is in sight");
    assert.equal(await pin.evaluate((n) => n.matches(":focus-visible") && getComputedStyle(n).outlineStyle !== "none"), true, "with the keyboard's ring");
    await p.keyboard.press("Enter"); await x.settle();
    assert.deepEqual(await folderPins(x), [["garden-notes", GARDEN]], "Enter pins the folder");
    assert.equal((await x.posted("projectFolderChoose")).length, 0, "and chooses nothing"); assert.equal(await p.locator(".dgc-folder-menu").count(), 1, "the menu stays open");
    assert.equal(await pin.getAttribute("aria-pressed"), "true"); assert.equal(await pin.getAttribute("aria-label"), "Unpin from the dock: garden-notes");
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.folderPin), GARDEN, "the keyboard is still on the pin");
    await p.keyboard.press(" "); await x.settle();
    assert.deepEqual(await folderPins(x), [], "Space unpins");
    // Left goes back to the row; Right again, then Down moves on from that row to the next.
    await p.keyboard.press("ArrowLeft"); assert.equal(await p.evaluate(() => document.activeElement?.dataset.folder), GARDEN, "Left: back on the row");
    await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowDown");
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.folder), "/home/me/rust_ire", "Down from a pin: the next row");
    await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowUp");
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.folder), GARDEN, "Up from a pin: the row before");
    // By the pointer, as before: a click on a row's pin pins, the row itself is not chosen; and the pin lies inside its row.
    const rust = p.locator('.dgc-folder-menu .dgc-folder-pin[data-folder-pin="/home/me/rust_ire"]');
    await p.locator('.dgc-folder-menu .dgc-folder-row[data-folder="/home/me/rust_ire"]').hover(); assert.equal(await shown(rust), 1);
    const lies = await p.evaluate(() => { const b = document.querySelector('.dgc-folder-menu .dgc-folder-pin[data-folder-pin="/home/me/rust_ire"]').getBoundingClientRect(), r = document.querySelector('.dgc-folder-menu .dgc-folder-row[data-folder="/home/me/rust_ire"]'), rr = r.getBoundingClientRect(), room = r.querySelector(".dgc-folder-pin-room").getBoundingClientRect();
      return { inRow: b.left >= rr.left && b.right <= rr.right && b.top >= rr.top && b.bottom <= rr.bottom, dx: Math.abs(b.left - room.left), dy: Math.abs((b.top + b.bottom) / 2 - (rr.top + rr.bottom) / 2) }; });
    assert.ok(lies.inRow && lies.dx <= 0.6 && lies.dy <= 0.6, `the pin is on its row, in the room the row keeps for it (${JSON.stringify(lies)})`);
    await rust.hover();
    assert.notEqual(await p.evaluate(() => getComputedStyle(document.querySelector('.dgc-folder-menu .dgc-folder-row[data-folder="/home/me/rust_ire"]')).backgroundColor), "rgba(0, 0, 0, 0)", "pointing at the pin keeps its row lit");
    await rust.click(); await x.settle();
    assert.deepEqual(await folderPins(x), [["rust_ire", "/home/me/rust_ire"]]); assert.equal((await x.posted("projectFolderChoose")).length, 0); assert.equal(await p.locator(".dgc-folder-menu").count(), 1);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const [theme, width] of [["dark-modern", 300], ["dark-modern", 700], ["light-modern", 300], ["light-modern", 700]]) {
  test(`Project Folder dropdown, 30 folders, ${width}px ${theme}: the search field stays at the top over the rows, opaque, with no gap above it`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width, theme, pins: [], height: 620 });
    try {
      const p = x.page;
      await withFolders(x, THIRTY_FOLDERS[3].folder, THIRTY_FOLDERS);
      await p.click("#sessions-folder-pick"); await x.settle(); await p.waitForTimeout(900);
      const look = () => p.evaluate(() => {
        const list = document.querySelector(".dgc-folder-list"), find = list.querySelector(".dgc-folder-find"), l = list.getBoundingClientRect(), f = find.getBoundingClientRect(), css = getComputedStyle(find);
        const alpha = (c) => { const m = c.match(/[\d.]+/g) || []; return c.startsWith("rgba") || (c.startsWith("color(") && m.length > 3) ? Number(m[3]) : 1; };
        // Whatever is drawn in the strip from the list's top to the field's foot belongs to the search field.
        const strays = [];
        for (let y = Math.ceil(l.top) + 0.5; y < f.bottom - 0.5; y += 1) for (const xx of [l.left + 3, l.left + 14, (l.left + l.right) / 2, l.right - 14, l.right - 3]) { const hit = document.elementFromPoint(xx, y); if (!hit?.closest(".dgc-folder-find")) strays.push([Math.round(xx - l.left), Math.round(y - l.top), hit?.className?.baseVal ?? hit?.className ?? ""]); }
        // And no row's own box shows above the field's foot uncovered: the field's box spans the list's width.
        return { scrollTop: list.scrollTop, scrolls: list.scrollHeight > list.clientHeight + 40, gap: f.top - (l.top + list.clientTop), left: f.left - l.left, right: l.right - f.right, alpha: alpha(css.backgroundColor), position: css.position, strays: strays.slice(0, 6), strayCount: strays.length,
          rowsAbove: [...list.querySelectorAll(".dgc-folder-row")].filter((r) => { const b = r.getBoundingClientRect(); return b.bottom > l.top && b.top < f.bottom; }).length, folders: list.querySelectorAll(".dgc-folder-row[data-folder]:not([data-folder=''])").length };
      });
      let v = await look();
      assert.equal(v.folders, 30); assert.equal(v.scrolls, true, "thirty folders scroll inside the menu");
      assert.equal(v.position, "sticky"); assert.equal(v.alpha, 1, "the search field's ground is opaque");
      assert.ok(Math.abs(v.gap) <= 0.6 && v.left <= 1.5 && v.right <= 1.5, `at rest it lies on the list's top, edge to edge (${JSON.stringify(v)})`);
      for (const top of [37, 173, 999999]) {
        await p.evaluate((y) => { document.querySelector(".dgc-folder-list").scrollTop = y; }, top); await p.waitForTimeout(120);
        v = await look();
        assert.ok(v.scrollTop > 0, "scrolled");
        assert.ok(Math.abs(v.gap) <= 0.6, `scrolled to ${v.scrollTop}: no gap above the search field (${v.gap} px)`);
        assert.equal(v.strayCount, 0, `scrolled to ${v.scrollTop}: nothing of a row shows in or above the search field: ${JSON.stringify(v.strays)}`);
        if (top < 999999) assert.ok(v.rowsAbove > 0, "(rows are under it: it covers them)");
      }
      // The keyboard's row is never under the field: Up from the list's last rows scrolls each one clear of it.
      await p.focus(`.dgc-folder-menu .dgc-folder-row[data-folder="${THIRTY_FOLDERS[29].folder}"]`);
      for (let k = 0; k < 12; k++) { await p.keyboard.press("ArrowUp");
        const clear = await p.evaluate(() => { const a = document.activeElement.getBoundingClientRect(), f = document.querySelector(".dgc-folder-find").getBoundingClientRect(); return a.top >= f.bottom - 0.5; });
        assert.equal(clear, true, `Up ${k + 1}: the row the keyboard is on is clear of the search field`); }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
