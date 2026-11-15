// Notes after live round 1 (14 Nov, findings 25 and 26). The card on Home is only a field that saves as it is typed,
// a new-note icon and "Open Notes"; nothing in the card or the app says Save or Done. A PIN locks a note at once (its
// title and the keypad); the lock button on an open locked note locks it again; "Remove lock" is in the note's ⋯; the
// list says which locked notes are open now. In real Chromium, answered by the real host (src/notes.ts).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openGrid } from "./support/home-grid-scene.mjs";
import { sample } from "./support/notes-sample.mjs";
import { cleanup } from "./support/notes-host.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });

const CARD = '.hc-grid .hc-card[data-card="note"]', OPEN = ".hc-open .hc-card";
const grid = (width, more = {}) => openGrid(browser, { width, layout: ["note", "clock"], seed: sample(), notesOptions: { iterations: 1500 }, ...more });
const type = async (x, digits, rest = 450) => { for (const d of digits) await x.page.keyboard.press(d); await x.rest(rest); };
/** What the card on Home holds: its controls by what they are, and every word a button says. */
const cardNow = (p, sel = CARD) => p.evaluate((s) => { const c = document.querySelector(s); if (!c) return null; const seen = (n) => n.checkVisibility?.({ checkOpacity: true, checkVisibilityCSS: true });
  return { form: c.dataset.form, fields: [...c.querySelectorAll(".nt-doc")].filter(seen).length, buttons: [...c.querySelectorAll("button")].filter(seen).map((b) => (b.innerText.trim() || b.getAttribute("aria-label") || "").replace(/\s+/g, " ")),
    inputs: [...c.querySelectorAll("input, select, textarea")].filter(seen).length, rows: c.querySelectorAll(".hc-note-row").length, words: (c.querySelector(".nt-doc")?.innerText || "").trim(), role: c.getAttribute("role"), tab: c.getAttribute("tabindex"),
    box: (() => { const r = c.getBoundingClientRect(), d = c.querySelector(".nt-doc")?.getBoundingClientRect(); return d ? { inside: d.left >= r.left - 0.5 && d.right <= r.right + 0.5 && d.top >= r.top - 0.5 && d.bottom <= r.bottom + 0.5, h: Math.round(d.height) } : null; })() }; }, sel);
const lockScreen = (p, sel = OPEN) => p.evaluate((s) => { const l = document.querySelector(`${s} .nt-lockbox`); if (!l) return null; return { title: l.querySelector("h3")?.textContent || "", text: l.innerText.replace(/\s+/g, " "), pad: l.querySelectorAll(".nt-pad button").length }; }, sel);

for (const [width, form] of [[300, "s"], [440, "m"], [700, "l"]]) {
  test(`the Notes card on Home is only a field, a new-note icon and Open Notes (${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await grid(width), p = x.page;
    try {
      await x.rest(300);
      const c = await cardNow(p);
      assert.equal(c.form, form);
      assert.equal(c.fields, 1, "one field to type in");
      assert.deepEqual(c.buttons, ["New note", "Open Notes"], "its only buttons");
      assert.equal(c.inputs + c.rows, 0, "no search, no list, no folders: those are the app's");
      assert.notEqual(c.role, "button", "the card is not one big button: its field is typed in");
      assert.equal(c.box.inside, true, "the field is inside its card"); assert.ok(c.box.h >= 40, `the field has room to type in (${c.box.h} px)`);
      assert.doesNotMatch(await p.locator(CARD).innerText(), /\b(Save|Done)\b/);
    } finally { await x.close(); }
  });
}

test("the card's field saves as it is typed; the new-note icon starts a fresh note and the typed one stays in Notes; Open Notes opens the app", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(440), p = x.page;
  try {
    await x.rest(300);
    const before = (await x.notes.list()).length;
    await p.click(`${CARD} .hc-note-new`); await x.rest(250);
    assert.equal((await cardNow(p)).words, "", "a fresh, empty field");
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true, "and the keyboard is in it");
    assert.equal((await x.notes.list()).length, before, "an empty note is not a note yet");
    await p.keyboard.type("Buy string for the beans"); await x.rest(900);
    let list = await x.notes.list();
    assert.equal(list.length, before + 1, "typing kept it: no button was pressed");
    const first = list.find((n) => n.title === "Buy string for the beans"); assert.ok(first, "saved under its first line");
    await p.click(`${CARD} .hc-note-new`); await x.rest(250);
    assert.equal((await cardNow(p)).words, "");
    await p.keyboard.type("Second thought"); await x.rest(900);
    list = await x.notes.list();
    assert.equal(list.length, before + 2);
    assert.equal(await x.notes.text(first.id), "Buy string for the beans", "the first one stays in Notes as it was typed");
    // Enter in the field is a new line in the note, never "open the card".
    await p.keyboard.press("Enter"); await p.keyboard.type("and a line under it"); await x.rest(900);
    assert.equal((await x.grid()).open, null);
    assert.equal(await x.notes.text(list.find((n) => n.title === "Second thought").id), "Second thought\nand a line under it");
    await p.click(`${CARD} .nt-openapp`); await x.rest(400);
    const g = await x.grid();
    assert.equal(g.open?.id, "note", "Open Notes opens the notes app");
    assert.ok(await p.locator(`${OPEN} .hc-note-row`).count() >= before + 2, "with every note in its list");
  } finally { await x.close(); }
});

for (const width of [300, 700]) {
  test(`nothing in the notes app says Save or Done: typing saves (${width} px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await grid(300), p = x.page;
    try {
      await x.rest(200); await p.click(`${CARD} .nt-openapp`); await x.rest(300); if (width !== 300) await x.resize(width, 900);
      await p.click(`${OPEN} .hc-note-row[data-note="ferry1"]`); await x.rest(400);
      const said = await p.evaluate((s) => [...document.querySelectorAll(`${s} button`)].map((b) => b.innerText.trim()).filter((w) => /^(Save|Done)\b/.test(w)), OPEN);
      assert.deepEqual(said, []);
      await p.click(`${OPEN} .nt-doc`); await p.keyboard.press("Control+End"); await p.keyboard.type(" ok"); await x.rest(900);
      assert.match(await x.notes.text("ferry1"), / ok$/, "what was typed is kept by itself");
    } finally { await x.close(); }
  });
}

test("a PIN locks the note at once: its title and the keypad; opened, the list says it is open now; its lock button locks it again; Remove lock is in ⋯", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(300), p = x.page;
  try {
    await x.rest(200); await p.click(`${CARD} .nt-openapp`); await x.rest(300); await x.resize(700, 900);
    await p.click(`${OPEN} .hc-note-row[data-note="wifi01"]`); await x.rest(300);
    const title = (await x.notes.list()).find((n) => n.id === "wifi01").title;
    await p.click(`${OPEN} .nt-lock`); await x.rest(200); await type(x, "4821", 150); await type(x, "4821", 800);
    let s = await lockScreen(p);
    assert.ok(s, "the note is locked at once: the keypad stands where its words were");
    assert.equal(s.title, title, "under its title"); assert.equal(s.pad, 11);
    assert.equal(await p.locator(`${OPEN} .nt-doc`).count(), 0, "its words are out of sight");
    assert.equal((await x.notes.state()).lock.state, "locked", "and the key is not kept in memory");
    const mark = (id) => p.evaluate(({ sel, id }) => { const r = document.querySelector(`${sel} .hc-note-row[data-note="${id}"]`), m = r?.querySelector(".nt-lockmark-row"); return m ? { open: m.dataset.open === "1", title: m.getAttribute("title"), meta: r.querySelector(".hc-meta")?.textContent || "" } : null; }, { sel: OPEN, id });
    assert.deepEqual([(await mark("wifi01")).open, (await mark("wifi01")).title], [false, "Locked"]);
    // Opened with the PIN: its words are back, and the list says it is open now.
    await p.click(`${OPEN} .nt-pad`); await type(x, "4821", 700);
    assert.equal(await lockScreen(p), null); assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /router/i);
    let m = await mark("wifi01"); assert.equal(m.open, true); assert.equal(m.title, "Locked · open now"); assert.match(m.meta, /open now/i);
    // Its lock button locks it again: no question, no "take the lock off".
    assert.match(await p.getAttribute(`${OPEN} .nt-lock`, "aria-label"), /^Lock it again/);
    await p.click(`${OPEN} .nt-lock`); await x.rest(600);
    s = await lockScreen(p); assert.equal(s.title, title); assert.doesNotMatch(s.text, /Take the lock off|plain words/);
    assert.equal((await mark("wifi01")).open, false); assert.equal((await x.notes.state()).lock.state, "locked");
    assert.equal((await x.notes.state()).notes.find((n) => n.id === "wifi01").locked, true, "it is still a locked note");
    // Remove lock is in the note's ⋯, and asks for the PIN.
    await p.click(`${OPEN} .nt-more`); await x.rest(250);
    const rows = await p.evaluate(() => [...document.querySelectorAll(".nt-menu .dgc-menu-row")].map((r) => r.querySelector(".dgc-menu-label").textContent));
    assert.ok(rows.includes("Remove lock…"), `the ⋯ menu has Remove lock (${rows.join(", ")})`);
    await p.click('.nt-menu .dgc-menu-row[data-act="lock-remove"]'); await x.rest(250);
    s = await lockScreen(p); assert.equal(s.title, "Remove lock");
    await type(x, "4821", 800);
    assert.equal((await x.notes.state()).notes.find((n) => n.id === "wifi01").locked, false);
    assert.equal(await lockScreen(p), null); assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /router/i);
  } finally { await x.close(); }
});

test("a second note locked while another is open is locked at once too, and the open one stays open; the card on Home never shows a locked note's words", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(300), p = x.page;
  try {
    await x.rest(200); await p.click(`${CARD} .nt-openapp`); await x.rest(300); await x.resize(700, 900);
    await p.click(`${OPEN} .hc-note-row[data-note="wifi01"]`); await x.rest(300);
    await p.click(`${OPEN} .nt-lock`); await x.rest(200); await type(x, "4821", 150); await type(x, "4821", 800);
    await p.click(`${OPEN} .nt-pad`); await type(x, "4821", 700);
    await p.click(`${OPEN} .hc-note-row[data-note="ferry1"]`); await x.rest(300);
    await p.click(`${OPEN} .nt-lock`); await x.rest(700);
    assert.ok(await lockScreen(p), "locked at once, with the PIN already set");
    const marks = await p.evaluate((sel) => Object.fromEntries([...document.querySelectorAll(`${sel} .hc-note-row`)].filter((r) => r.querySelector(".nt-lockmark-row")).map((r) => [r.dataset.note, r.querySelector(".nt-lockmark-row").dataset.open])), OPEN);
    assert.deepEqual(marks, { wifi01: "1", ferry1: "0" });
    await p.click(".hc-back"); await x.rest(500);
    const words = (await cardNow(p)).words;
    assert.doesNotMatch(words, /router|Ferry/i, "the card's field holds neither locked note");
  } finally { await x.close(); }
});
