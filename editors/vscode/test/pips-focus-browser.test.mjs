// The keyboard keeps its place when the Pips view redraws (0.52, found 13 Nov: Enter or Space on the fold of "Needs
// attention" redrew the button and the focus dropped, to nothing in the side bar and to the body in a tab). The view
// draws itself anew on most actions, so a control is found again after the draw: by its id, or, with no id, by its tag
// and data attributes (src/pipsClient.js focusMark, landFocus). When the control went with its card (answered,
// rejected, its moment for Undo over), the focus is on the card that took its place, then on what is left.
// In real Chromium, with the real client and its CSS, by the keyboard alone: the side bar (a shadow root, 300 px) and an
// editor tab (700 px), dark and light (test/support/pip-chat-scene.mjs); and the side bar's real page with the Project
// Folder dropdown (test/support/project-folder-pips-scene.mjs). After each action the root's activeElement is read.
// Each test says whether it failed before the fix or pins a control that already kept (or moved, on purpose) the focus.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openPips, GARDEN } from "./support/project-folder-pips-scene.mjs";
import { client, openChat, PIP } from "./support/pip-chat-scene.mjs";

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
await client();   // built before the first test is registered (a pending top-level await would end the file early)

const ROOT = '(window.__pipsRoot || document.getElementById("pips-host")?.shadowRoot || document)';
/** Where the keyboard is in the Pips view: null when nowhere (nothing in the shadow root; the body in a tab). `ring`:
 *  the control shows its focus ring (:focus-visible). `card`: the Needs attention card it is on. */
const where = (page) => page.evaluate((root) => { const a = (0, eval)(root).activeElement;
  if (!a || a === document.body || !a.isConnected) return null;
  return { tag: a.tagName, id: a.id, cls: [...a.classList], data: { ...a.dataset }, expanded: a.getAttribute("aria-expanded"), controls: a.getAttribute("aria-controls"), checked: a.getAttribute("aria-checked"),
    selected: a.getAttribute("aria-selected"), ring: a.matches(":focus-visible"), card: a.closest("[data-attention-key]")?.dataset.attentionKey || "", words: a.textContent.replace(/\s+/g, " ").trim().slice(0, 60),
    shown: a.checkVisibility() && a.getBoundingClientRect().width > 0 }; }, ROOT);
/** The keyboard put on a control (the page's own focus(), after a key was pressed: it shows its ring as Tab would). */
const put = async (page, selector) => { assert.equal(await page.evaluate(([root, s]) => { const e = (0, eval)(root).querySelector(s); e?.focus(); return !!e && (0, eval)(root).activeElement === e; }, [ROOT, selector]), true, `the keyboard goes on ${selector}`); };
const press = async (page, key, ms = 0) => { await page.keyboard.press(key); if (ms) await page.waitForTimeout(ms); };
const read = (page, fn, arg) => page.evaluate(([root, f, a]) => (0, eval)(`(${f})`)((0, eval)(root), a), [ROOT, fn.toString(), arg]);
const until = (page, fn, arg) => page.waitForFunction(([root, f, a]) => (0, eval)(`(${f})`)((0, eval)(root), a), [ROOT, fn.toString(), arg], { timeout: 10000 });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 30)))));
const stage = (page) => read(page, (r) => r.querySelector(".attention-stage > li")?.dataset.attentionKey || "");
const rows = (page) => read(page, (r) => [...r.querySelectorAll(".attention-all-list > li")].map((li) => li.dataset.attentionKey));
const fold = (page) => read(page, (r) => { const t = r.querySelector(".attention-toggle:not(.attention-toggle-none)"), list = r.querySelector("#attention-list");
  return { expanded: t.getAttribute("aria-expanded"), list: !!list && !list.hasAttribute("hidden") && list.getBoundingClientRect().height > 0, toggles: r.querySelectorAll(".attention-toggle:not(.attention-toggle-none)").length }; });
/** The held moment for Undo (6 s) is the test's to end: `fire` ends every one that is still held. */
const hold = (page) => page.evaluate(() => { const later = window.setTimeout.bind(window); window.__holds = [];
  window.setTimeout = (fn, ms, ...rest) => (ms === 6000 ? (window.__holds.push(fn), 900000 + window.__holds.length) : later(fn, ms, ...rest));
  const clear = window.clearTimeout.bind(window); window.clearTimeout = (id) => { if (id > 900000) window.__holds[id - 900001] = null; else clear(id); }; });
const fire = (page) => page.evaluate(() => { const due = window.__holds.filter(Boolean); window.__holds = []; due.forEach((fn) => fn()); return due.length; });
/** The one card in view brought to the first whose key starts with `prefix`, by the keyboard (Home, then Right). */
async function showCard(page, prefix) {
  await put(page, ".attention-dot[aria-current]"); await press(page, "Home", 60);
  for (let i = 0; i < 12 && !(await stage(page)).startsWith(prefix); i++) await press(page, "ArrowRight", 60);
  const key = await stage(page);
  assert.ok(key.startsWith(prefix), `a ${prefix} card shows: ${key}`);
  return key;
}
const isFold = (w, expanded, what) => { assert.ok(w, `${what}: the keyboard is somewhere`);
  assert.deepEqual([w.tag, w.cls.includes("attention-toggle"), w.expanded, w.controls, w.ring, w.shown], ["BUTTON", true, expanded, "attention-list", true, true], `${what}: on the fold, which says its new state and shows its ring: ${JSON.stringify(w)}`); };

const PLACES = [["side", 300, "dark"], ["side", 300, "light"], ["tab", 700, "dark"], ["tab", 700, "light"]];
const home = async (t, [place, width, theme], scene) => {
  const x = await openChat(browser, { width, height: 800, theme, where: place, home: true, ...scene });
  t.after(x.close);
  await x.p.waitForSelector(".attention-toggle"); await x.p.mouse.move(2, 2);
  return x;
};
const FULL = { waiting: 4, setups: 2, answers: true, switches: true };   // nine cards: a change to answer here, two new Pips, six to open

// ---- the fold (failed first) ---------------------------------------------------------------------------------------
for (const at of PLACES) test(`the fold of Needs attention keeps the keyboard through Enter and Space (${at.join(", ")}) [failed first]`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await home(t, at, FULL), p = x.p;
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "9");
  // By Tab alone from the top of the page: no script puts the focus anywhere in this test.
  let w = null;
  for (let i = 0; i < 40 && !(w = await where(p))?.cls.includes("attention-toggle"); i++) await press(p, "Tab");
  isFold(w, "true", "Tab reaches it");
  await press(p, "Enter"); await until(p, (r) => r.querySelector(".attention-toggle").getAttribute("aria-expanded") === "false"); await settle(p);
  isFold(await where(p), "false", "after Enter");
  assert.deepEqual(await fold(p), { expanded: "false", list: false, toggles: 1 }, "folded: the card is away");
  await press(p, "Space"); await until(p, (r) => r.querySelector(".attention-toggle").getAttribute("aria-expanded") === "true"); await settle(p);
  isFold(await where(p), "true", "after Space");
  assert.deepEqual(await fold(p), { expanded: "true", list: true, toggles: 1 }, "open again: the card shows");
  // And on: the same key again, with nothing but the keyboard in between.
  await press(p, "Enter"); await until(p, (r) => r.querySelector(".attention-toggle").getAttribute("aria-expanded") === "false"); await settle(p);
  isFold(await where(p), "false", "Enter again");
  await press(p, "Enter"); await until(p, (r) => r.querySelector(".attention-toggle").getAttribute("aria-expanded") === "true"); await settle(p);
  isFold(await where(p), "true", "and again");
  // Tab goes on from it to what follows it on the page, as from any button. (13 Nov: the fold is the word at the end of
  // the heading's line, after View all, so what follows it is the card, and View all is the stop before it.)
  await press(p, "Shift+Tab"); w = await where(p);
  assert.equal(w?.id, "attention-view-all", "Shift+Tab goes back from the fold to View all");
  await press(p, "Tab"); isFold(await where(p), "true", "Tab comes back to it");
  await press(p, "Tab"); w = await where(p);
  assert.ok(w?.card && w.tag === "BUTTON", `Tab goes on from the fold into the card: ${JSON.stringify(w)}`);
  assert.deepEqual(x.errors, []);
});

for (const [theme, width, tab] of [["dark-modern", 300, "personal"], ["light-modern", 300, "project"], ["dark-modern", 700, "project"], ["light-modern", 700, "personal"]]) {
  test(`the side bar's real page: the fold keeps the keyboard (${tab} tab, ${theme}, ${width}px) [failed first]`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, tab }); t.after(x.close);
    const p = x.page, FOLD = ".attention-toggle:not(.attention-toggle-none)", said = (v) => until(p, (r, v) => r.querySelector(".attention-toggle:not(.attention-toggle-none)")?.getAttribute("aria-expanded") === v, v);
    await p.mouse.move(2, 2); await press(p, "Tab");
    await put(p, FOLD);
    await press(p, "Enter"); await said("false"); await settle(p); isFold(await where(p), "false", "after Enter");
    await press(p, "Space"); await said("true"); await settle(p); isFold(await where(p), "true", "after Space");
    await press(p, "Space"); await said("false"); await settle(p); isFold(await where(p), "false", "Space again");
    // The page around the view has the focus on the view's host and nowhere else of its own.
    assert.equal(await p.evaluate(() => document.activeElement?.id), "pips-host");
    assert.deepEqual(x.errors, []);
  });
}

// ---- a pointer: as it was (a control: passed before) ---------------------------------------------------------------
for (const at of [PLACES[0], PLACES[3]]) test(`a click on the fold shows no focus ring that was not there (${at.join(", ")}) [control]`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await home(t, at, FULL), p = x.p;
  // (Everything that waits is read first: a card arriving opens a fold again, which is not what this looks at.)
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "9" && !!r.querySelector("#attention-yes")); await settle(p);
  for (const to of ["false", "true"]) {
    await p.click(".attention-toggle"); await until(p, (r, v) => r.querySelector(".attention-toggle").getAttribute("aria-expanded") === v, to); await settle(p);
    const w = await where(p);
    assert.ok(!w || !w.ring, `a click, folded ${to}: no ring: ${JSON.stringify(w)}`);
    assert.equal(await read(p, (r) => { const s = getComputedStyle(r.querySelector(".attention-toggle")); return s.outlineStyle === "none" || parseFloat(s.outlineWidth) === 0; }), true, "no outline drawn on the fold");
  }
  // Reject by a click: the next card takes its place, and no button of it lights up.
  await hold(p); await p.click("#attention-next"); await until(p, (r) => !!r.querySelector(".attention-stage [id^=setup-reject-]")); await p.mouse.move(2, 2);
  const gone = await stage(p);
  await p.click(".attention-stage [id^=setup-reject-]"); await until(p, (r, k) => { const li = r.querySelector(".attention-stage > li"); return !!li && li.dataset.attentionKey !== k; }, gone); await p.mouse.move(2, 2); await settle(p);
  const w = await where(p);
  assert.ok(!w || !w.ring, `after a click on Reject: no ring: ${JSON.stringify(w)}`);
  assert.deepEqual(x.errors, []);
});

// ---- the one card, its answers, and the card that takes its place ---------------------------------------------------
for (const at of PLACES) test(`the one card: the keyboard stays on it as the view redraws, and goes to the next card when it leaves (${at.join(", ")}) [failed first]`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await home(t, at, FULL), p = x.p;
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "9");
  await until(p, (r) => !!r.querySelector("#attention-yes"));
  await hold(p); await press(p, "Tab");
  // On the card's own row (a button with no id): a card arriving redraws the view, and the keyboard is still on it.
  const first = await stage(p);
  assert.ok(first.startsWith("approval:"), first);
  await put(p, ".attention-stage button.attention-row");
  await p.evaluate(() => { window.__attention.add(); window.__attention.read(); });
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "10"); await settle(p);
  let w = await where(p);
  assert.deepEqual([w?.cls.includes("attention-row"), w?.data.attention, w?.ring], [true, first, true], `a card arrived: still on the row: ${JSON.stringify(w)}`);
  assert.equal(await stage(p), first, "and the same card shows");
  // Its answers (as before): yes says what it will do and the keyboard is on Undo; Undo gives the answers back.
  await put(p, "#attention-yes"); await press(p, "Enter"); await until(p, (r) => !!r.querySelector("#attention-undo")); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.ring, w?.card], ["attention-undo", true, first], "answered: on Undo");
  await press(p, "Space"); await until(p, (r) => !!r.querySelector("#attention-yes")); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.ring], ["attention-yes", true], "Undo: back on the answer");
  // Answered for good while the keyboard is on Undo: the card leaves, and the keyboard is on the card that took its place.
  await put(p, "#attention-no"); await press(p, "Enter"); await until(p, (r) => !!r.querySelector("#attention-undo")); await settle(p);
  assert.equal((await where(p))?.id, "attention-undo");
  assert.equal(await fire(p), 1);
  await until(p, (r, k) => { const li = r.querySelector(".attention-stage > li"); return !!li && li.dataset.attentionKey !== k; }, first); await settle(p);
  w = await where(p);
  const second = await stage(p);
  assert.ok(w && w.tag === "BUTTON" && w.card === second && w.ring && w.shown, `the card left: on the next card (${second}): ${JSON.stringify(w)}`);
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "9"); await settle(p);
  w = await where(p);
  assert.ok(w && w.card === await stage(p), `and still on it once the list is read again: ${JSON.stringify(w)}`);
  // A new Pip rejected from its card: the card goes at once; the keyboard is on the card that took its place.
  const setup = await showCard(p, "setup:");
  await put(p, ".attention-stage [id^=setup-reject-]"); await press(p, "Enter");
  await until(p, (r, k) => { const li = r.querySelector(".attention-stage > li"); return !!li && li.dataset.attentionKey !== k; }, setup); await settle(p);
  w = await where(p);
  const third = await stage(p);
  assert.ok(w && w.tag === "BUTTON" && w.card === third && third !== setup && w.ring, `rejected: on the next card (${third}): ${JSON.stringify(w)}`);
  assert.equal(await read(p, (r) => r.querySelector(".undo-reject")?.getAttribute("role")), "status", "what happened is said (a status), with Undo");
  // Undo in that line (a button with no id) takes it back; the line goes, and the keyboard is on the card in view.
  await put(p, ".undo-reject [data-undo-reject]"); await press(p, "Enter");
  await until(p, (r) => !r.querySelector(".undo-reject")); await settle(p);
  w = await where(p);
  assert.ok(w && w.tag === "BUTTON" && w.card === await stage(p) && w.ring, `Undo: on the card in view: ${JSON.stringify(w)}`);
  // The arrows and dots (as before): Next keeps the keyboard; at the last card, where Next goes off, it is on that card's dot.
  await put(p, ".attention-dot[aria-current]"); await press(p, "Home", 80);
  await put(p, "#attention-next"); await press(p, "Enter", 80);
  w = await where(p); assert.equal(w?.id, "attention-next", "Next: still on Next");
  await press(p, "End", 80);
  w = await where(p); assert.ok(w?.cls.includes("attention-dot") && w.data.attentionGo === await stage(p), `at the end: on the dot of the card showing: ${JSON.stringify(w)}`);
  assert.deepEqual(x.errors, []);
});

for (const at of [PLACES[1], PLACES[2]]) test(`the last card rejected: the keyboard is on Undo, then on the tab you are on (${at.join(", ")}) [failed first]`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await home(t, at, { setups: 1 }), p = x.p;
  // (The scene lists an email beside the new Pip: it is taken away, as if answered elsewhere, so one card waits.)
  await p.evaluate(() => { window.__attention.remove(window.__attention.ids().find((id) => id.startsWith("email:"))); window.__attention.read(); });
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "1" && !!r.querySelector(".attention-stage [id^=setup-reject-]"));
  await hold(p); await press(p, "Tab");
  await put(p, ".attention-stage [id^=setup-reject-]"); await press(p, "Enter");
  await until(p, (r) => !r.querySelector(".attention") && !!r.querySelector(".undo-reject")); await settle(p);
  let w = await where(p);
  assert.deepEqual([w?.data.undoReject?.startsWith("setup_"), w?.words, w?.ring], [true, "Undo", true], `nothing else waits: on Undo: ${JSON.stringify(w)}`);
  // The moment passes with the keyboard still there: the line goes; the keyboard is on the tab this list is under.
  assert.equal(await fire(p), 1);
  await until(p, (r) => !r.querySelector(".undo-reject")); await settle(p);
  w = await where(p);
  assert.deepEqual([w?.id, w?.selected, w?.ring], ["pips-tab-personal", "true", true], `the line went: on the Personal tab: ${JSON.stringify(w)}`);
  assert.deepEqual(x.errors, []);
});

// ---- the page of them all ------------------------------------------------------------------------------------------
for (const at of PLACES) test(`View all: the keyboard goes to the page and back on purpose, and to the next row when a row leaves (${at.join(", ")}) [failed first]`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await home(t, at, FULL), p = x.p;
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "9");
  await hold(p); await press(p, "Tab");
  // View all moves the keyboard on purpose: to the page's way back (as before).
  await put(p, "#attention-view-all"); await press(p, "Enter"); await until(p, (r) => !!r.querySelector(".attention-all-list")); await settle(p);
  let w = await where(p); assert.deepEqual([w?.id, w?.ring], ["attention-all-back", true], "View all: on Back");
  await until(p, (r) => r.querySelectorAll('.attention-all-list [data-attention-answer="no"]').length >= 1);
  let list = await rows(p);
  assert.equal(list.length, 9);
  // A row answered (as before: on its Undo), then for good: the row leaves, and the keyboard is on the row that took its place.
  const change = list.findIndex((k) => k.startsWith("approval:")), ROW = `.attention-all-list > li[data-attention-key="${list[change]}"]`;
  await put(p, `${ROW} [data-attention-answer="no"]`); await press(p, "Enter"); await until(p, (r, s) => !!r.querySelector(`${s} .attention-undo`), ROW); await settle(p);
  w = await where(p); assert.deepEqual([w?.cls.includes("attention-undo"), w?.card, w?.ring], [true, list[change], true], "answered: on that row's Undo");
  assert.equal(await fire(p), 1);
  await until(p, (r, s) => !r.querySelector(s), ROW); await settle(p);
  w = await where(p);
  assert.ok(w && w.tag === "BUTTON" && w.card === list[change + 1] && w.ring && w.shown, `the row left: on the row that took its place (${list[change + 1]}): ${JSON.stringify(w)}`);
  await until(p, (r) => r.querySelector(".attention-all-count")?.textContent === "8"); await settle(p);
  w = await where(p); assert.equal(w?.card, list[change + 1], "and still there once the list is read again");
  // A new Pip rejected here: its row says so in place, and the keyboard is on its Undo; Undo gives the card back (on Review, as before).
  list = await rows(p);
  const pip = list.find((k) => k.startsWith("setup:")), CARD = `.attention-all-list > li[data-attention-key="${pip}"]`;
  await put(p, `${CARD} [id^=setup-reject-]`); await press(p, "Enter"); await until(p, (r, s) => !!r.querySelector(`${s} [data-undo-reject]`), CARD); await settle(p);
  w = await where(p); assert.deepEqual([w?.data.undoReject, w?.card, w?.ring], [pip.split(":")[1], pip, true], `rejected: on its Undo: ${JSON.stringify(w)}`);
  await press(p, "Enter"); await until(p, (r, s) => !!r.querySelector(`${s} [id^=setup-reject-]`), CARD); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.card], [`setup-review-${pip.split(":")[1]}`, pip], "Undo: on the card's Review");
  // Rejected for good, the keyboard on Undo: the row leaves; the keyboard is on the row that took its place.
  await put(p, `${CARD} [id^=setup-reject-]`); await press(p, "Space"); await until(p, (r, s) => !!r.querySelector(`${s} [data-undo-reject]`), CARD); await settle(p);
  const after = list[list.indexOf(pip) + 1];
  assert.equal(await fire(p), 1);
  await until(p, (r, s) => !r.querySelector(s), CARD); await settle(p);
  w = await where(p);
  assert.ok(w && w.tag === "BUTTON" && w.card === after && w.ring, `rejected for good: on the next row (${after}): ${JSON.stringify(w)}`);
  // A row's own button (no id) keeps the keyboard as a card arrives above it.
  const last = (await rows(p)).at(-1);
  await put(p, `.attention-all-list > li[data-attention-key="${last}"] button.attention-row`);
  const n = (await rows(p)).length;
  await p.evaluate(() => { window.__attention.add(); window.__attention.read(); });
  await until(p, (r, n) => r.querySelectorAll(".attention-all-list > li").length === n + 1, n); await settle(p);
  w = await where(p); assert.deepEqual([w?.cls.includes("attention-row"), w?.card, w?.ring], [true, last, true], `a card arrived: still on its row: ${JSON.stringify(w)}`);
  // Back moves the keyboard on purpose: to View all (as before). Escape from a row does the same.
  await put(p, "#attention-all-back"); await press(p, "Enter"); await until(p, (r) => !r.querySelector(".attention-all-list")); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.ring], ["attention-view-all", true], "Back: on View all");
  await press(p, "Space"); await until(p, (r) => !!r.querySelector(".attention-all-list")); await settle(p);
  assert.equal((await where(p))?.id, "attention-all-back");
  await put(p, ".attention-all-list button.attention-row"); await press(p, "Escape"); await until(p, (r) => !r.querySelector(".attention-all-list")); await settle(p);
  assert.equal((await where(p))?.id, "attention-view-all", "Escape: on View all");
  assert.deepEqual(x.errors, []);
});

for (const at of [PLACES[0], PLACES[3]]) test(`View all: the last row gone, the keyboard is on Back to your Pips (${at.join(", ")}) [failed first]`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await home(t, at, { setups: 2 }), p = x.p;
  // (The scene's email is taken away, as if answered elsewhere: the two new Pips are all that wait.)
  await p.evaluate(() => { window.__attention.remove(window.__attention.ids().find((id) => id.startsWith("email:"))); window.__attention.read(); });
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "2" && !!r.querySelector("#attention-view-all"));
  await hold(p); await press(p, "Tab");
  await put(p, "#attention-view-all"); await press(p, "Enter"); await until(p, (r) => r.querySelectorAll(".attention-all-list > li").length === 2); await settle(p);
  for (const left of [1, 0]) {
    const key = (await rows(p))[0];
    await put(p, ".attention-all-list [id^=setup-reject-]"); await press(p, "Enter");
    await until(p, (r, k) => !!r.querySelector(`.attention-all-list > li[data-attention-key="${k}"] [data-undo-reject]`), key); await settle(p);
    assert.equal((await where(p))?.card, key, "rejected: on its Undo");
    assert.equal(await fire(p), 1);
    await until(p, (r, k) => !r.querySelector(`li[data-attention-key="${k}"]`), key);
    await until(p, (r, n) => r.querySelectorAll(".attention-all-list > li").length === n, left); await settle(p);
    const w = await where(p);
    if (left) assert.ok(w && w.card === (await rows(p))[0] && w.ring, `one left: on it: ${JSON.stringify(w)}`);
    else assert.deepEqual([w?.id, w?.words, w?.ring], ["attention-all-done", "Back to your Pips", true], `none left: on Back to your Pips: ${JSON.stringify(w)}`);
  }
  assert.deepEqual(x.errors, []);
});

// ---- the list's other controls: each already kept the keyboard, or moves it on purpose (controls) --------------------
for (const at of PLACES) test(`the tabs, a Pip's switch and Search keep the keyboard (${at.join(", ")}) [control]`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await home(t, at, FULL), p = x.p;
  await until(p, (r) => r.querySelector(".attention-count")?.textContent === "9" && !!r.querySelector("#attention-yes")); await settle(p);
  await press(p, "Tab");
  const chosen = (name) => until(p, (r, n) => r.querySelector(`#pips-tab-${n}`)?.getAttribute("aria-selected") === "true", name);
  // Enter and Space on a tab choose it and stay on it; the arrows choose the other and go with it (a tab list's own way).
  await put(p, "#pips-tab-project"); await press(p, "Enter"); await chosen("project"); await settle(p);
  let w = await where(p); assert.deepEqual([w?.id, w?.selected, w?.ring], ["pips-tab-project", "true", true], "Enter on Project");
  await put(p, "#pips-tab-personal"); await press(p, "Space"); await chosen("personal"); await until(p, (r) => !!r.querySelector(".pip-row")); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.selected, w?.ring], ["pips-tab-personal", "true", true], "Space on Personal");
  await press(p, "ArrowRight"); await chosen("project"); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.selected], ["pips-tab-project", "true"], "Right: Project, and the keyboard with it");
  await press(p, "ArrowLeft"); await chosen("personal"); await until(p, (r) => !!r.querySelector(".pip-row")); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.selected], ["pips-tab-personal", "true"], "Left: Personal");
  // A Pip's switch in the list.
  const SWITCH = `#pip-switch-${PIP}`;
  await until(p, (r, s) => r.querySelector(s)?.getAttribute("aria-checked") === "true", SWITCH);
  await put(p, SWITCH); await press(p, "Space"); await until(p, (r, s) => r.querySelector(s)?.getAttribute("aria-checked") === "false" && !r.querySelector(s).disabled, SWITCH); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.checked, w?.ring], [`pip-switch-${PIP}`, "false", true], "Space: off, and still on the switch");
  await press(p, "Enter"); await until(p, (r, s) => r.querySelector(s)?.getAttribute("aria-checked") === "true" && !r.querySelector(s).disabled, SWITCH); await settle(p);
  w = await where(p); assert.deepEqual([w?.id, w?.checked], [`pip-switch-${PIP}`, "true"], "Enter: on again");
  // Search: typing redraws the list under it, and Escape clears it (the field's own way): the keyboard stays in the field.
  await put(p, "#pip-search"); await p.keyboard.type("Mor"); await p.waitForTimeout(450); await settle(p);
  w = await where(p); assert.equal(w?.id, "pip-search", "typing: in the field");
  assert.equal(await read(p, (r) => r.querySelector("#pip-search").value), "Mor");
  assert.equal(await read(p, (r) => !!r.querySelector(".attention")), false, "a search shows the list alone");
  await press(p, "Escape"); await until(p, (r) => !!r.querySelector(".attention")); await settle(p);
  w = await where(p); assert.equal(w?.id, "pip-search", "cleared: still in the field");
  assert.equal(await read(p, (r) => r.querySelector("#pip-search").value), "");
  assert.deepEqual(x.errors, []);
});

for (const [theme, width] of [["dark-modern", 300], ["light-modern", 300], ["dark-modern", 700], ["light-modern", 700]]) {
  test(`the side bar's real page: the tabs and the Project Folder dropdown's choice keep the keyboard (${theme}, ${width}px) [control]`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPips(browser, { theme, width, tab: "personal" }); t.after(x.close);
    const p = x.page;
    await p.mouse.move(2, 2); await press(p, "Tab");
    await put(p, "#pips-tab-project"); await press(p, "Enter");
    await until(p, (r) => !!r.querySelector("#pips-folder-pick") && !!r.querySelector("#pips-tabpanel .pip-row")); await settle(p);
    let w = await where(p); assert.deepEqual([w?.id, w?.selected, w?.ring], ["pips-tab-project", "true", true], "Enter on Project: still on the tab as its list loads");
    // The dropdown opens onto its list (on purpose: a menu), and a choice gives the keyboard back to its button...
    await put(p, "#pips-folder-pick"); await press(p, "Enter");
    await p.waitForFunction(() => document.activeElement?.closest?.(".dgc-menu-row") || document.getElementById("pips-host").shadowRoot.activeElement?.classList.contains("dgc-menu-row"));
    w = await where(p); assert.deepEqual([w?.cls.includes("dgc-menu-row"), w?.data.folder], [true, ""], "open: on the row chosen now (All projects)");
    await press(p, "ArrowDown"); await press(p, "ArrowDown");
    w = await where(p); assert.equal(w?.data.folder, GARDEN);
    await press(p, "Enter"); await settle(p);
    w = await where(p); assert.deepEqual([w?.id, w?.expanded, w?.ring], ["pips-folder-pick", "false", true], "chosen: back on the dropdown's button");
    // ...where it stays as the extension says the choice back and the tab redraws for that folder.
    const asked = await x.posted("pipsProjectFolderChoose");
    assert.deepEqual(asked.map((m) => m.folder), [GARDEN]);
    await x.send({ type: "pipsProjectFolder", folder: GARDEN });
    await until(p, (r) => /garden/.test(r.querySelector("#pips-folder-pick")?.textContent || "") && [...r.querySelectorAll("#pips-tabpanel .pip-row")].some((e) => /Bed planner/.test(e.textContent)));
    await p.waitForTimeout(300); await settle(p);
    w = await where(p); assert.deepEqual([w?.id, w?.ring], ["pips-folder-pick", true], `the tab is the folder's now: still on the dropdown: ${JSON.stringify(w)}`);
    // Escape closes it with nothing chosen: back on its button.
    await press(p, "Space"); await p.waitForFunction(() => document.getElementById("pips-host").shadowRoot.activeElement?.classList.contains("dgc-menu-row") || document.activeElement?.classList.contains("dgc-menu-row"));
    await press(p, "Escape"); await settle(p);
    assert.equal((await where(p))?.id, "pips-folder-pick", "Escape: on the button");
    assert.deepEqual(x.errors, []);
  });
}
