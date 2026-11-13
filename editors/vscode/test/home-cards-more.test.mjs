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

// ---- 2. Clock: every time zone for the second city -------------------------------------------------------------------
for (const [theme, width] of [["dark-modern", 300], ["dark-modern", 460], ["light-modern", 300], ["light-modern", 460]]) {
  test(`Clock, ${width}px ${theme}: the second city is any time zone there is, found by its city or its zone`, async (t) => {
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
      assert.equal(m.rows[0].name, "No second city", "and none, first");
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
      assert.deepEqual((await x.host()).settings.clock, { zone: "Asia/Tokyo" });
      assert.equal(await closed(p), true);
      assert.match(await p.locator(card).innerText(), /Tokyo/);
      assert.equal(await p.locator(`${card} .hc-clock`).count(), 2, "both clocks");
      // Escape while looking leaves the city as it was; and "No second city" takes it away.
      await p.click(field); await p.keyboard.type("par"); await x.rest(120); await p.keyboard.press("Escape"); await x.rest(80);
      assert.equal(await closed(p), true); assert.deepEqual((await x.host()).settings.clock, { zone: "Asia/Tokyo" });
      assert.equal(await p.inputValue(field), "Tokyo", "the field says the city again");
      await p.click(field); await x.rest(120);
      await p.locator('.hc-suggest [role="option"]').first().click(); await x.rest(300);
      assert.equal((await x.host()).settings.clock?.zone || "", "");
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

// ---- 6. Notes: a full notes app ---------------------------------------------------------------------------------------
const noteRows = (p, where) => p.evaluate((w) => [...document.querySelectorAll(`${w} .hc-note-row`)].map((r) => ({ id: r.dataset.note, title: r.querySelector(".hc-nm").textContent, meta: r.querySelector(".hc-meta")?.textContent || "", pinned: !!r.querySelector(".hc-note-pinmark") })), where);
for (const theme of ["dark-modern", "light-modern"]) {
  test(`Notes, ${theme}: Small shows the newest note's first line and how many more; Medium the latest few; Large the list beside the open note`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width: 300, theme, layout: ["note", "clock"], notes: NOTES });
    try {
      const p = x.page;
      const small = await p.locator(sel("note")).innerText();
      assert.match(small, /Notes/); assert.match(small, /Ferry to Porto/, "the newest note's first line"); assert.match(small, /\+2 notes/);
      assert.equal(await p.locator(`${sel("note")} textarea`).count(), 0);
      await x.resize(460);
      let rows = await noteRows(p, sel("note"));
      assert.deepEqual(rows.map((r) => r.title), ["Call the bank about the card", "Ferry to Porto", "Seeds for spring: tomatoes, basil, sweet peas"], "pinned first, then the latest: each titled by its first line");
      assert.equal(rows[0].pinned, true); assert.match(rows[1].meta, /^\d min ago · book the 09:40/, "when it was last changed, then more of it"); assert.match(rows[0].meta, /^Yesterday/);
      assert.equal(await p.locator(`${sel("note")} .hc-note-new`).innerText(), "New note");
      // A click opens that note, in the full app.
      await p.click(`${sel("note")} .hc-note-row[data-note="n0003"]`); await x.rest(200);
      assert.equal((await x.grid()).open?.id, "note");
      assert.match(await p.locator(".hc-open .hc-note-pane").innerText(), /Ferry to Porto[\s\S]*book the 09:40/);
      await p.keyboard.press("Escape"); await x.rest(200);
      await x.resize(700);
      const large = await p.evaluate(() => { const c = document.querySelector('.hc-grid .hc-card[data-card="note"]'), list = c.querySelector(".hc-notes-list").getBoundingClientRect(), pane = c.querySelector(".hc-note-pane").getBoundingClientRect(), card = c.getBoundingClientRect();
        return { form: c.dataset.form, beside: pane.left >= list.right - 1 && Math.abs(pane.top - list.top) < 40, inside: pane.right <= card.right + 0.5 && pane.bottom <= card.bottom + 0.5, rows: c.querySelectorAll(".hc-note-row").length, pane: c.querySelector(".hc-note-pane").innerText }; });
      assert.equal(large.form, "l"); assert.equal(large.beside, true, "the list beside the open note"); assert.equal(large.inside, true); assert.equal(large.rows, 3);
      assert.match(large.pane, /Call the bank about the card/, "with none chosen, the first of the list is open");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Notes at 300 px, opened: New note, typed and saved as you type, titled by its first line, kept across a reload", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 300, layout: ["note", "clock"], notes: NOTES });
  try {
    const p = x.page;
    await p.click(sel("note")); await x.rest(200);
    assert.equal(await p.locator(".hc-open input.hc-note-find").count(), 1, "the full app: a search field");
    assert.equal((await noteRows(p, ".hc-open")).length, 3);
    await p.click(".hc-open .hc-note-new"); await x.rest(120);
    assert.equal(await p.evaluate(() => document.activeElement?.matches("textarea.hc-note-edit")), true, "a new note opens ready to type");
    await p.keyboard.type("Paint for the fence\ntwo tins, green"); await x.rest(120);
    assert.equal((await x.host()).notes.length, 3, "not saved on every key");
    await x.rest(600);
    let host = await x.host();
    assert.equal(host.notes.length, 4, "saved once the typing rests");
    assert.equal(host.notes[0].text, "Paint for the fence\ntwo tins, green"); assert.ok(Math.abs(host.notes[0].at - Date.now()) < 5000); assert.match(host.notes[0].id, /^[a-z0-9]{4,24}$/);
    assert.equal(await p.evaluate(() => document.activeElement?.matches("textarea.hc-note-edit") && document.activeElement.value), "Paint for the fence\ntwo tins, green", "the keyboard and the words stay where they were while it saves");
    await p.keyboard.type("!"); await x.rest(700);
    assert.equal((await x.host()).notes[0].text, "Paint for the fence\ntwo tins, green!");
    // Back to the list: it is there, first, by its first line.
    await p.click(".hc-open .hc-note-all"); await x.rest(150);
    const rows = await noteRows(p, ".hc-open");
    assert.equal(rows.length, 4); assert.equal(rows.find((r) => !r.pinned).title, "Paint for the fence");
    // "A reload": the page again, over what the host keeps.
    host = await x.host();
    const y = await openGrid(browser, { width: 460, layout: host.order, notes: host.notes });
    try { assert.ok((await noteRows(y.page, sel("note"))).some((r) => r.title === "Paint for the fence"), "a reload finds the note"); } finally { await y.close(); }
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Notes: search, pin to top, delete with Undo, and tick boxes for “- [ ]” lines", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700, layout: ["note", "clock"], notes: NOTES, saved: undefined });
  try {
    const p = x.page;
    await p.click(`${sel("note")} .hc-note-row[data-note="n0003"]`); await x.rest(150);
    // Tick boxes: the lines that start "- [ ]" or "- [x]".
    const boxes = () => p.evaluate(() => [...document.querySelectorAll('.hc-grid .hc-card[data-card="note"] .hc-note-view input[type="checkbox"]')].map((b) => [b.checked, b.closest("label").innerText.trim()]));
    assert.deepEqual(await boxes(), [[false, "book the 09:40"], [true, "check the car deck"]]);
    await p.locator(`${sel("note")} .hc-note-view input[type="checkbox"]`).first().check(); await x.rest(700);
    assert.equal((await x.host()).notes.find((n) => n.id === "n0003").text, "Ferry to Porto\n- [x] book the 09:40\n- [x] check the car deck\nAsk about bikes", "a tick is written into the note");
    assert.deepEqual((await boxes()).map((b) => b[0]), [true, true]);
    await p.locator(`${sel("note")} .hc-note-view input[type="checkbox"]`).nth(1).uncheck(); await x.rest(700);
    assert.match((await x.host()).notes.find((n) => n.id === "n0003").text, /- \[ \] check the car deck/);
    // Pin: it goes to the top and stays there.
    await p.click(`${sel("note")} .hc-note-pin`); await x.rest(300);
    assert.equal((await x.host()).notes.find((n) => n.id === "n0003").pinned, true);
    assert.equal(await p.getAttribute(`${sel("note")} .hc-note-pin`, "aria-pressed"), "true");
    assert.deepEqual((await noteRows(p, sel("note"))).map((r) => [r.id, r.pinned]), [["n0003", true], ["n0002", true], ["n0001", false]], "pinned notes first, the latest changed of them first");
    // Delete, and Undo.
    await p.click(`${sel("note")} .hc-note-del`); await x.rest(300);
    assert.deepEqual((await x.host()).notes.map((n) => n.id), ["n0002", "n0001"]);
    assert.match(await p.locator(`${sel("note")} .hc-note-undo`).innerText(), /Note deleted/);
    await p.click(`${sel("note")} .hc-note-undo .hc-undo`); await x.rest(300);
    const back = (await x.host()).notes.find((n) => n.id === "n0003");
    assert.ok(back && back.pinned === true && /Ferry to Porto/.test(back.text), "Undo brings it back as it was");
    assert.equal(await p.locator(`${sel("note")} .hc-note-undo`).count(), 0);
    // Search, in the full app.
    await x.resize(460);
    await p.click(`${sel("note")} .hc-viewall`); await x.rest(200);
    await p.fill(".hc-open input.hc-note-find", "BASIL"); await x.rest(120);
    assert.deepEqual((await noteRows(p, ".hc-open")).map((r) => r.id), ["n0001"], "by any word in a note, whatever its case");
    await p.fill(".hc-open input.hc-note-find", "nothing like this"); await x.rest(120);
    assert.equal((await noteRows(p, ".hc-open")).length, 0); assert.match(await p.locator(".hc-open .hc-card").innerText(), /No note has “nothing like this”/);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Notes: with none it says how to start; at 500 notes New note is off and says why; a note stops at 20,000 characters and says so", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["note"], notes: [] });
  try {
    const p = x.page;
    assert.match(await p.locator(sel("note")).innerText(), /No notes yet/);
    await p.click(`${sel("note")} .hc-note-new`); await x.rest(200);
    assert.equal(await p.evaluate(() => document.activeElement?.matches("textarea.hc-note-edit")), true);
    assert.equal(await p.getAttribute(".hc-open textarea.hc-note-edit", "maxlength"), "20000");
    await p.evaluate(() => { const box = document.querySelector(".hc-open textarea.hc-note-edit"); box.value = "x".repeat(20000); box.dispatchEvent(new Event("input", { bubbles: true })); }); await x.rest(100);
    assert.match(await p.locator(".hc-open .hc-note-limit").innerText(), /20,000 characters/);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const many = Array.from({ length: 500 }, (_, k) => ({ id: `m${String(k).padStart(4, "0")}`, text: `Note ${k}`, at: Date.now() - k * 1000, pinned: false }));
  const y = await openGrid(browser, { width: 460, layout: ["note"], notes: many });
  try {
    assert.equal(await y.page.locator(`${sel("note")} .hc-note-new`).isDisabled(), true);
    assert.match(await y.page.getAttribute(`${sel("note")} .hc-note-new`, "title"), /500 notes/);
    assert.deepEqual(y.errors, []);
  } finally { await y.close(); }
});

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
      assert.deepEqual((await posted(p, "homeLibraryOpen")).at(-1), { type: "homeLibraryOpen", view: "widgets" });
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
      assert.deepEqual((await posted(p, "homeLibraryOpen")).at(-1), { type: "homeLibraryOpen", view: "artifacts" });
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
      if (width === 300) for (const c of g.cards) assert.ok(Math.abs(c.width - c.height) <= 1, `${c.id} is a square at 300 px`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
