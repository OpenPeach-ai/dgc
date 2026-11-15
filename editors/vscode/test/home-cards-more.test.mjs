// Home's cards, the second follow-up (asked 13 Nov, late): Weather's city is chosen from places Open-Meteo found, never
// typed blind; Clock's second city is any time zone there is, found by typing; Token usage names the models and their
// providers and links to Settings; Notes is many notes with search, pins, tick boxes and Undo; and two new cards page
// through the widgets and the artifacts the Library lists. In real Chromium on the real side bar
// (support/home-grid-scene.mjs): the host there is a stand-in, the place search a stand-in's, and the page touches no network.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid, LISBON, PLACES, NOTES, WIDGETS, ARTIFACTS, MODELS } from "./support/home-grid-scene.mjs";

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
/** The dropdown under a field: its rows as read, the row the keys are on, its note, and where it lies. */
const menu = (p) => p.evaluate(() => {
  const box = [...document.querySelectorAll(".hc-suggest")].find((b) => b.checkVisibility());
  if (!box) return null;
  const r = box.getBoundingClientRect(), css = getComputedStyle(box);
  return { rows: [...box.querySelectorAll('[role="option"]')].map((o) => ({ name: o.querySelector(".hc-opt-name")?.textContent || "", sub: o.querySelector(".hc-opt-sub")?.textContent || "", code: o.querySelector(".hc-opt-code")?.textContent || "", on: o.getAttribute("aria-selected") === "true", radius: getComputedStyle(o).borderTopLeftRadius })),
    note: box.querySelector(".hc-suggest-note")?.textContent || "", radius: css.borderTopLeftRadius, role: box.getAttribute("role"), left: r.left, right: r.right, top: r.top, bottom: r.bottom, opaque: !/rgba\([^)]*,\s*0(\.\d+)?\)$/.test(css.backgroundColor) || css.backgroundImage !== "none" };
});
/** No dropdown shows. */
const closed = async (p) => (await menu(p)) === null;

// ---- 1. Weather: a city is picked from suggestions, never typed blind ------------------------------------------------
for (const [theme, width] of [["dark-modern", 300], ["dark-modern", 460], ["light-modern", 300], ["light-modern", 460]]) {
  test(`Weather, ${width}px ${theme}: typing offers places to choose from, and Save waits for a choice`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme, layout: ["weather", "clock"] });
    try {
      const p = x.page;
      if (width < 380) { await p.click(sel("weather")); await x.rest(200); }
      const card = width < 380 ? ".hc-open .hc-card" : sel("weather"), field = `${card} .hc-city`, save = `${card} .hc-cityform button[type="submit"]`;
      assert.equal(await p.locator(save).isDisabled(), true, "nothing chosen: Save is off");
      assert.match(await p.locator(`${card} .hc-fine`).first().innerText(), /letters you type are sent to Open-Meteo/i, "the card says what is sent, and where");
      assert.equal(await p.getAttribute(field, "role"), "combobox");
      await p.click(field); await p.keyboard.type("L"); await x.rest(400);
      assert.deepEqual(await p.evaluate(() => window.__geoAsked), [], "one letter asks nothing");
      await p.keyboard.type("is"); await x.rest(450);
      assert.deepEqual(await p.evaluate(() => window.__geoAsked), ["Lis"], "typed quickly: asked once, after the typing rests");
      const m = await menu(p);
      assert.ok(m, "the places found show under the field");
      assert.equal(m.role, "listbox");
      assert.deepEqual(m.rows.map((r) => [r.name, r.sub, r.code]), [["Lisbon", "Lisbon, Portugal", "PT"], ["Lisbon", "Ohio, United States", "US"], ["Lisbon", "Maine, United States", "US"], ["Lisburn", "Northern Ireland, United Kingdom", "GB"]],
        "each place with its name, its region and country, and its country's code");
      assert.equal(m.radius, "6px", "the dropdown has the one corner"); assert.ok(m.rows.every((r) => parseFloat(r.radius) <= 6), "and so have its rows");
      assert.equal(m.opaque, true, "its ground is opaque: the card does not show through");
      assert.ok(m.left >= 0 && m.right <= width + 0.5, `it stays inside the side bar (${m.left}..${m.right})`);
      assert.equal(await p.locator(save).isDisabled(), true, "places are offered, none is chosen yet: Save is still off");
      // Enter with nothing chosen saves nothing.
      assert.equal((await posted(p, "homeCardSetting")).length, 0);
      // Down, Down, Up: the keys move through the places; Enter takes the one they are on.
      await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowUp");
      assert.deepEqual((await menu(p)).rows.map((r) => r.on), [true, false, false, false]);
      assert.ok(await p.getAttribute(field, "aria-activedescendant"), "the field says which place the keys are on");
      await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(60);
      assert.equal(await closed(p), true, "a place taken: the dropdown goes");
      assert.equal(await p.inputValue(field), "Lisbon, Ohio, United States");
      assert.equal(await p.locator(save).isDisabled(), false, "a place is chosen: Save is on");
      assert.equal((await posted(p, "homeCardSetting")).length, 0, "choosing is not saving");
      // Typing on after a choice: it is a choice no more.
      await p.keyboard.press("Backspace"); await x.rest(60);
      assert.equal(await p.locator(save).isDisabled(), true, "the words changed: Save is off again until a place is chosen");
      // Escape closes the dropdown and leaves the card where it is.
      await p.fill(field, ""); await p.keyboard.type("Lisb"); await x.rest(450);
      assert.ok(await menu(p));
      await p.keyboard.press("Escape"); await x.rest(60);
      assert.equal(await closed(p), true, "Escape closes the dropdown");
      assert.equal(await p.locator(field).isVisible(), true, "and nothing else");
      // By pointer: the first Lisbon.
      await p.keyboard.type("o"); await x.rest(450);
      await p.locator('.hc-suggest [role="option"]').first().click(); await x.rest(60);
      assert.equal(await p.inputValue(field), "Lisbon, Portugal");
      await p.click(save); await x.rest(300);
      const kept = (await x.host()).settings.weather;
      assert.deepEqual(kept.place, LISBON, "the place is kept whole: its name, region, country, coordinates and time zone");
      assert.deepEqual(await p.evaluate(() => window.__weatherAsked), [LISBON], "and the host forecasts that place");
      assert.match(await p.locator(card).innerText(), /Lisbon, Portugal[\s\S]*24°/, "the card shows its weather");
      assert.deepEqual(x.requests.filter((u) => !u.startsWith("https://home.test/")), [], "the page asked nothing of any network");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Weather: a name nobody knows says so; offline or refused is said calmly; Save stays off through all of it", async (t) => {
  if (skipOrFail(t)) return;
  for (const [geo, typed, said] of [["ok", "Qqzz", /^No place by that name\.$/], ["offline", "Lisbon", /can’t reach Open-Meteo/i], ["refused", "Lisbon", /Open-Meteo isn’t answering/i]]) {
    const x = await openGrid(browser, { width: 460, layout: ["weather"], geo });
    try {
      const p = x.page, field = `${sel("weather")} .hc-city`, save = `${sel("weather")} .hc-cityform button[type="submit"]`;
      await p.click(field); await p.keyboard.type(typed); await x.rest(450);
      const m = await menu(p);
      assert.ok(m, `${geo}: the dropdown opens to say it`); assert.deepEqual(m.rows, []); assert.match(m.note, said);
      await p.keyboard.press("Enter"); await x.rest(60);
      assert.equal(await p.locator(save).isDisabled(), true); assert.equal((await posted(p, "homeCardSetting")).length, 0, `${geo}: nothing is saved`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("Weather from the Cards library: Add waits for a place from the list too, then the card is on Home with it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460 });
  try {
    const p = x.page, item = '.hc-lib-item[data-card="weather"]';
    await p.click(".hc-cards-btn"); await x.rest(200);
    await p.click(`${item} .hc-add`); await x.rest(120);
    assert.equal(await p.locator(`${item} .hc-add-city`).isDisabled(), true);
    await p.keyboard.type("Port"); await x.rest(450);
    const m = await menu(p);
    assert.deepEqual(m.rows.map((r) => r.name), ["Porto", "Portland"]);
    // Enter with the keys on no place does not add a card with a made-up city.
    await p.keyboard.press("Enter"); await x.rest(80);
    assert.equal((await x.host()).order.includes("weather"), false);
    await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(80);
    assert.equal(await p.locator(`${item} .hc-add-city`).isDisabled(), false);
    await p.keyboard.press("Enter"); await x.rest(300);
    const host = await x.host();
    assert.ok(host.order.includes("weather")); assert.equal(host.settings.weather.place.name, "Porto"); assert.equal(host.settings.weather.place.lat, 41.15);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Weather opened: Change place offers the list again, and a place kept before the list (a typed city) still shows its weather", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300, layout: ["weather"], settings: { weather: { city: "Lisbon", unit: "c" } } });
  try {
    const p = x.page;
    assert.match(await p.locator(sel("weather")).innerText(), /24°/);
    await p.click(sel("weather")); await x.rest(200);
    await p.click(".hc-open .hc-city-edit"); await x.rest(120);
    assert.equal(await p.locator('.hc-open .hc-cityform button[type="submit"]').isDisabled(), true);
    await p.keyboard.type("Porto"); await x.rest(450);
    await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await p.keyboard.press("Enter"); await x.rest(300);
    assert.equal((await x.host()).settings.weather.place.name, "Porto");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- 2. Clock: every time zone, for a city added beside Here ------------------------------------------------------------
// (Changed 14 Nov: the field adds a city, up to three beside Here, where it set the one second city; "No second city" and
// the city's name in the field went with that, and an added city leaves by its ×. test/home-batch.test.mjs has the rest.)
for (const [theme, width] of [["dark-modern", 300], ["dark-modern", 460], ["light-modern", 300], ["light-modern", 460]]) {
  test(`Clock, ${width}px ${theme}: a city added is any time zone there is, found by its city or its zone`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme, layout: ["clock", "weather"] });
    try {
      const p = x.page;
      if (width < 380) { await p.click(sel("clock")); await x.rest(200); }
      const card = width < 380 ? ".hc-open .hc-card" : sel("clock"), field = `${card} input.hc-zone`;
      assert.equal(await p.locator(`${card} select`).count(), 0, "the short list is gone");
      assert.equal(await p.getAttribute(field, "role"), "combobox");
      await p.click(field); await x.rest(120);
      const all = await p.evaluate(() => ({ n: document.querySelectorAll('.hc-suggest [role="option"]').length, supported: Intl.supportedValuesOf("timeZone").length }));
      assert.ok(all.supported > 300 && all.n >= all.supported, `every time zone is offered (${all.n} rows for ${all.supported} zones)`);
      let m = await menu(p);
      assert.notEqual(m.rows[0].name, "No second city", "only zones: a city leaves by its ×");
      assert.equal(m.radius, "6px"); assert.ok(m.left >= 0 && m.right <= width + 0.5, "inside the side bar");
      assert.ok(m.bottom - m.top <= 330, `it shows a few and scrolls (${Math.round(m.bottom - m.top)} px tall)`);
      // By city.
      await p.keyboard.type("lisb"); await x.rest(120);
      m = await menu(p);
      assert.deepEqual(m.rows.map((r) => [r.name, r.sub]), [["Lisbon", "Europe · Europe/Lisbon"]]);
      assert.match(m.rows[0].code, /^UTC(?:[+−]\d{1,2}(?::\d\d)?)?$/, `its offset now (${m.rows[0].code})`);
      // By zone, slash and all.
      await p.fill(field, "europe/lis"); await x.rest(120);
      assert.deepEqual((await menu(p)).rows.map((r) => r.name), ["Lisbon"]);
      // By a city's newer name, whatever this engine calls its zone.
      await p.fill(field, "Kolkata"); await x.rest(120);
      m = await menu(p);
      assert.equal(m.rows.length, 1); assert.equal(m.rows[0].name, "Kolkata"); assert.equal(m.rows[0].code, "UTC+5:30"); assert.match(m.rows[0].sub, /^Asia · Asia\/(Kolkata|Calcutta)$/);
      await p.fill(field, "zzzz"); await x.rest(120);
      m = await menu(p);
      assert.deepEqual(m.rows, []); assert.match(m.note, /No time zone by that name/);
      // The same keys as Weather's: Down, Enter.
      await p.fill(field, "tok"); await x.rest(120);
      await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(300);
      assert.deepEqual((await x.host()).settings.clock, { zones: ["Asia/Tokyo"] });
      assert.equal(await closed(p), true);
      assert.match(await p.locator(card).innerText(), /Tokyo/);
      assert.equal(await p.locator(`${card} .hc-clock`).count(), 2, "both clocks");
      // Escape while looking adds nothing and empties the field; the city's × takes it away.
      await p.click(field); await p.keyboard.type("par"); await x.rest(120); await p.keyboard.press("Escape"); await x.rest(80);
      assert.equal(await closed(p), true); assert.deepEqual((await x.host()).settings.clock, { zones: ["Asia/Tokyo"] });
      assert.equal(await p.inputValue(field), "", "the field is empty again: it adds, it names no city");
      await p.locator(`${card} .hc-clock`).nth(1).hover(); await p.click(`${card} .hc-zone-x`); await x.rest(300);
      assert.deepEqual((await x.host()).settings.clock?.zones || [], []);
      assert.equal(await p.locator(`${card} .hc-clock`).count(), 1);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

// ---- 4. Token usage: the models, their providers, and the way to Settings ------------------------------------------------
for (const theme of ["dark-modern", "light-modern"]) {
  test(`Token usage, ${theme}: Medium names the top three models with provider and share, Large five, the rest as “+N more”; Small is as it was`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width: 460, theme, layout: ["token", "needs"] });
    try {
      const p = x.page;
      const read = (where) => p.evaluate((w) => { const c = document.querySelector(w); return { rows: [...c.querySelectorAll(".hc-models .hc-model")].map((r) => r.innerText.replace(/\s+/g, " ").trim()), more: c.querySelector(".hc-models-more")?.innerText || "", link: c.querySelector(".hc-usage-link")?.innerText || "",
        clipped: [...c.querySelectorAll(".hc-models, .hc-usage-link, .hc-kt")].some((n) => n.getBoundingClientRect().bottom > c.getBoundingClientRect().bottom + 0.5) }; }, where);
      let m = await read(sel("token"));
      assert.deepEqual(m.rows, ["deepseek-v4.1-flash:cloud · Ollama · 55%", "claude-opus-4.1 · Claude Code · 23%", "qwen3.5-coder:32b · Ollama · 11%"]);
      assert.equal(m.more, "+4 more"); assert.equal(m.link, "Open Token Usage"); assert.equal(m.clipped, false, "nothing of it is cut off by the card");
      await x.resize(700);
      m = await read(sel("token"));
      assert.equal(m.rows.length, 5, "Large: five"); assert.equal(m.rows[4], "gpt-5.1-codex · Codex · 3%"); assert.equal(m.more, "+2 more"); assert.equal(m.link, "Open Token Usage");
      assert.equal(m.clipped, false, "Large: the models, the link and the tabs all fit the block");
      await p.click(`${sel("token")} .hc-usage-link`); await x.rest(60);
      assert.deepEqual((await posted(p, "openSettings")).at(-1), { type: "openSettings", section: "usage" }, "the link opens Settings on Token Usage");
      await x.resize(300);
      const small = await p.evaluate(() => { const c = document.querySelector('.hc-grid .hc-card[data-card="token"]'); return { text: c.innerText.replace(/\s+/g, " "), models: c.querySelectorAll(".hc-model").length, link: c.querySelectorAll(".hc-usage-link").length, strip: c.querySelectorAll(".hc-strip .hc-col").length }; });
      assert.deepEqual([small.models, small.link, small.strip], [0, 0, 7], "Small stays as it is: today's tokens and the strip");
      assert.match(small.text, /Tokens today.*1\.24M/);
      await p.click(sel("token")); await x.rest(200);
      m = await read(".hc-open .hc-card");
      assert.equal(m.link, "Open Token Usage", "opened: the link is there too");
      assert.equal(await p.locator(".hc-open .hc-by .hc-mr").count(), 5, "with By model, as it was");
      await p.click(".hc-open .hc-usage-link"); await x.rest(60);
      assert.equal((await posted(p, "openSettings")).length, 2);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Token usage: a day's tooltip names that day's top models when the report has them, by pointer and by the arrow keys", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["token"] });
  try {
    const p = x.page, plot = p.locator(`${sel("token")} .hc-plot`);
    await plot.focus(); await p.keyboard.press("ArrowLeft"); await x.rest(60);          // today
    let tip = await p.evaluate(() => { const t = document.querySelector('.hc-card[data-card="token"] .hc-tip'); return { shown: !t.hidden, models: [...t.querySelectorAll(".hc-tip-m")].map((n) => n.textContent) }; });
    assert.deepEqual(tip, { shown: true, models: ["qwen3.5-coder:32b · Ollama · 65%", "deepseek-v4.1-flash:cloud · Ollama · 35%"] });
    assert.match(await plot.getAttribute("aria-description"), /qwen3\.5-coder:32b/, "and it is read out with the day");
    await p.keyboard.press("ArrowLeft"); await x.rest(60);                               // yesterday: the report names no models for it
    tip = await p.evaluate(() => [...document.querySelectorAll('.hc-card[data-card="token"] .hc-tip .hc-tip-m')].length);
    assert.equal(tip, 0, "a day whose models the report does not name shows its number alone");
    const box = await plot.boundingBox();
    await p.mouse.move(box.x + box.width - 3, box.y + box.height / 2); await x.rest(60);
    assert.equal(await p.locator(`${sel("token")} .hc-tip .hc-tip-m`).count(), 2, "under the pointer too");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- 6. Notes ---------------------------------------------------------------------------------------------------------
// (The four Notes tests that were here (the forms; New note typed and saved; search, pin, Undo and tick boxes; the 500
// and 20,000 limits) went on 14 Nov with the notes app that replaced that card: notes are files the host keeps, with
// folders, a bin, formatting as you type and a lock. test/notes*.test.mjs has what replaced them, each behaviour again.)

// ---- 7. Widgets and Artifacts ----------------------------------------------------------------------------------------
test("the Cards library offers Widgets and Artifacts, and a new Home has neither", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460 });
  try {
    const p = x.page;
    assert.deepEqual((await x.grid()).cards.map((c) => c.id), ["needs", "recent", "running", "token", "quick"]);
    await p.click(".hc-cards-btn"); await x.rest(200);
    const lib = (await x.grid()).library.items;
    for (const id of ["widgets", "artifacts"]) { const item = lib.find((i) => i.id === id); assert.ok(item && item.add && !item.on, `${id} is in the library, not on Home`); assert.equal(item.previewDrawn, true); }
    assert.deepEqual(lib.filter((i) => ["widgets", "artifacts", "note"].includes(i.id)).map((i) => i.name), ["Widgets", "Artifacts", "Notes"]);
    await p.click('.hc-lib-item[data-card="widgets"] .hc-add'); await p.click('.hc-lib-item[data-card="artifacts"] .hc-add'); await x.rest(300);
    assert.deepEqual((await x.host()).order.slice(-2), ["widgets", "artifacts"]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

const stack = (p, id, where = ".hc-grid") => p.evaluate(([i, w]) => { const c = document.querySelector(`${w} .hc-card[data-card="${i}"]`);
  return { tiles: [...c.querySelectorAll(".hc-stack [data-tile]")].map((n) => n.dataset.tile), names: [...c.querySelectorAll(".hc-stack .hc-tile-t")].map((n) => n.textContent), dots: [...c.querySelectorAll(".hc-pager .hc-dot")].map((d) => d.getAttribute("aria-current") === "true"),
    prev: c.querySelector(".hc-prev")?.disabled, next: c.querySelector(".hc-next")?.disabled, marks: c.querySelectorAll(".hc-stack [data-tile] :is([data-mark], .dgc-sheet)").length, text: c.innerText.replace(/\s+/g, " ").trim(),
    inside: [...c.querySelectorAll(".hc-stack, .hc-pager")].every((n) => n.getBoundingClientRect().bottom <= c.getBoundingClientRect().bottom + 0.5 && n.getBoundingClientRect().right <= c.getBoundingClientRect().right + 0.5) }; }, [id, where]);
for (const theme of ["dark-modern", "light-modern"]) {
  test(`Widgets, ${theme}: one at a time, paged by the arrows, the dots and Left/Right; two side by side when Large; a click opens it`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width: 460, theme, layout: ["widgets", "artifacts", "clock"] });
    try {
      const p = x.page, W = WIDGETS.map((w) => w.id);
      assert.equal((await posted(p, "homeWidgetsGet")).length, 1, "the host is asked for the widgets the Library lists");
      let s = await stack(p, "widgets");
      assert.deepEqual(s.tiles, [W[0]], "Medium: one, full width"); assert.deepEqual(s.names, ["Tip calculator"]); assert.equal(s.marks, 1, "shown as the Library and the dock show it: its mark");
      assert.deepEqual(s.dots, [true, false, false, false, false]); assert.equal(s.prev, true); assert.equal(s.next, false); assert.equal(s.inside, true);
      assert.match(s.text, /in “Dinner in Porto”/);
      await p.click(`${sel("widgets")} .hc-next`); await x.rest(250);
      assert.deepEqual((await stack(p, "widgets")).tiles, [W[1]]);
      assert.equal((await x.host()).settings.widgets.shown, W[1], "the card remembers which one it showed");
      await p.locator(`${sel("widgets")} .hc-pager .hc-dot`).nth(3).click(); await x.rest(250);
      assert.deepEqual((await stack(p, "widgets")).tiles, [W[3]]);
      await p.locator(`${sel("widgets")} .hc-stack`).focus();
      await p.keyboard.press("ArrowRight"); await x.rest(250);
      s = await stack(p, "widgets");
      assert.deepEqual(s.tiles, [W[4]]); assert.equal(s.next, true, "the last: no further");
      await p.keyboard.press("ArrowRight"); await x.rest(120);
      assert.deepEqual((await stack(p, "widgets")).tiles, [W[4]]);
      await p.keyboard.press("ArrowLeft"); await x.rest(250);
      assert.deepEqual((await stack(p, "widgets")).tiles, [W[3]]);
      assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("hc-stack")), true, "the keyboard stays on the stack as it pages");
      // A click opens it; All widgets opens the Library on Widgets.
      await p.click(`${sel("widgets")} [data-tile="${W[3]}"]`); await x.rest(60);
      assert.deepEqual((await posted(p, "homeWidgetOpen")).at(-1), { type: "homeWidgetOpen", id: W[3], chat_id: "chat_4" });
      await p.click(`${sel("widgets")} .hc-all`); await x.rest(60);
      // (The side bar's own Library, on that tab; it was the editor's page until Library v2.)
      assert.deepEqual(await p.evaluate(() => [document.getElementById("side-tab-library").getAttribute("aria-selected"), document.querySelector('#library-tabs [aria-selected="true"]')?.dataset.tab]), ["true", "widgets"]);
      assert.deepEqual(await posted(p, "homeLibraryOpen"), [], "not the editor's page");
      await p.click("#side-tab-home"); await x.rest(200);
      // Large: two side by side.
      await x.resize(700);
      s = await stack(p, "widgets");
      assert.deepEqual(s.tiles, [W[2], W[3]], "Large: two side by side, on the page that holds the one it showed"); assert.equal(s.dots.length, 3); assert.equal(s.inside, true);
      const side = await p.evaluate(() => [...document.querySelectorAll('.hc-grid .hc-card[data-card="widgets"] .hc-stack [data-tile]')].map((n) => { const r = n.getBoundingClientRect(); return [r.left, r.top]; }));
      assert.ok(side[1][0] > side[0][0] + 20 && Math.abs(side[1][1] - side[0][1]) < 1, "side by side");
      // Small: one, compact; the square opens the whole card.
      await x.resize(300);
      s = await stack(p, "widgets");
      assert.equal(s.tiles.length, 1); assert.equal(s.inside, true); assert.equal(s.dots.length, 5);
      await p.click(`${sel("widgets")} .hc-next`); await x.rest(250);
      assert.equal((await x.grid()).open, null, "an arrow pages; it does not open the card");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Artifacts, ${theme}: newest first, one, two or four to a page by the card's size, each with its picture, name, kind, where and when`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width: 460, theme, layout: ["artifacts", "widgets", "clock"], settings: { artifacts: { shown: ARTIFACTS[2].id } } });
    try {
      const p = x.page, A = ARTIFACTS.map((a) => a.id);
      assert.equal((await posted(p, "homeArtifactsGet")).length, 1);
      let s = await stack(p, "artifacts");
      assert.deepEqual(s.tiles, [A[2], A[3]], "Medium: two to a page, on the page it was left on (kept by the host)"); assert.deepEqual(s.dots, [false, true, false]); assert.equal(s.marks, 2); assert.equal(s.inside, true);
      assert.match(s.text, /Shop: the first year/); assert.match(s.text, /Slides · made by a Pip/); assert.match(s.text, /Spreadsheet · made in Work/);
      await p.click(`${sel("artifacts")} .hc-prev`); await x.rest(250);
      s = await stack(p, "artifacts");
      assert.deepEqual(s.tiles, [A[0], A[1]], "the newest first"); assert.match(s.text, /Tide pools, a field guide/); assert.match(s.text, /Page · made in Chat · Today/);
      assert.equal((await x.host()).settings.artifacts.shown, A[0]);
      await p.locator(`${sel("artifacts")} .hc-stack`).focus(); await p.keyboard.press("ArrowRight"); await p.keyboard.press("ArrowRight"); await x.rest(250);
      assert.deepEqual((await stack(p, "artifacts")).tiles, [A[4], A[5]]);
      await p.click(`${sel("artifacts")} [data-tile="${A[5]}"]`); await x.rest(60);
      assert.deepEqual((await posted(p, "artifactOpen")).at(-1), { type: "artifactOpen", id: A[5], artifactType: "doc", title: "Ferry plan" }, "a click opens it in an editor tab");
      await p.click(`${sel("artifacts")} .hc-all`); await x.rest(60);
      assert.deepEqual(await p.evaluate(() => [document.getElementById("side-tab-library").getAttribute("aria-selected"), document.querySelector('#library-tabs [aria-selected="true"]')?.dataset.tab]), ["true", "artifacts"]);
      assert.deepEqual(await posted(p, "homeLibraryOpen"), [], "not the editor's page");
      await p.click("#side-tab-home"); await x.rest(200);
      await x.resize(700);
      s = await stack(p, "artifacts");
      assert.deepEqual(s.tiles, [A[4], A[5]], "Large: four to a page, and the page that holds the one it showed (the last two of six)"); assert.equal(s.dots.length, 2); assert.equal(s.inside, true);
      await p.click(`${sel("artifacts")} .hc-prev`); await x.rest(250);
      s = await stack(p, "artifacts");
      assert.deepEqual(s.tiles, [A[0], A[1], A[2], A[3]], "Large: four"); assert.equal(s.marks, 4); assert.equal(s.inside, true);
      await x.resize(300);
      s = await stack(p, "artifacts");
      assert.equal(s.tiles.length, 1, "Small: one"); assert.equal(s.dots.length, 6); assert.equal(s.inside, true);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Widgets and Artifacts with nothing yet say so quietly and how to make one; a DGC that keeps none says that", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["widgets", "artifacts"], widgets: [], artifacts: [] });
  try {
    const p = x.page;
    const w = await p.locator(sel("widgets")).innerText(), a = await p.locator(sel("artifacts")).innerText();
    assert.match(w, /No widgets yet/); assert.match(w, /ask Work or Chat for a widget/i); assert.equal(await p.locator(`${sel("widgets")} .hc-pager`).count(), 0);
    assert.match(a, /No artifacts yet/); assert.match(a, /ask Work or Chat for a page, a document, slides, a sheet or a dashboard/i);
    assert.equal(await p.locator(`${sel("widgets")} .hc-all`).count(), 1, "the Library is still a click away");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const y = await openGrid(browser, { width: 460, layout: ["widgets", "artifacts"], widgets: null, artifacts: null });
  try {
    assert.match(await y.page.locator(sel("widgets")).innerText(), /This DGC keeps no widgets/); assert.match(await y.page.locator(sel("artifacts")).innerText(), /This DGC keeps no artifacts/);
    assert.deepEqual(y.errors, []);
  } finally { await y.close(); }
});

test("the new cards in every form, dark and light: nothing spills out of the side bar or out of its card", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 460, 700]) {
    const x = await openGrid(browser, { width, theme, layout: ["widgets", "artifacts", "note", "token", "clock", "weather"], notes: NOTES, settings: { weather: { place: LISBON }, clock: { zone: "Asia/Kolkata" } } });
    try {
      const g = await x.grid();
      assert.equal(g.overflowX, false, `${width}px ${theme}: no sideways scroll`);
      const spill = await x.page.evaluate(() => [...document.querySelectorAll(".hc-grid > .hc-card")].flatMap((c) => { const box = c.getBoundingClientRect();
        return [...c.querySelectorAll("button, input, textarea, .hc-ct, .hc-tile-t, .hc-nm, .hc-model")].filter((n) => n.checkVisibility() && (n.getBoundingClientRect().right > box.right + 0.5 || n.getBoundingClientRect().left < box.left - 0.5)).map((n) => `${c.dataset.card}: ${n.className}`); }));
      assert.deepEqual(spill, [], `${width}px ${theme}: nothing reaches past its card's sides`);
      if (width === 300) for (const c of g.cards) if (c.id !== "note") assert.ok(Math.abs(c.width - c.height) <= 1, `${c.id} is a square at 300 px`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
