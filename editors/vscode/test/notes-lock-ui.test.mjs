// Notes, step 4 (media/shared/notes.js): the lock as it is used. Choosing a PIN (typed twice, 4 digits or longer), the
// PIN pad, a wrong PIN and the wait, Forgot PIN, taking the lock off, changing the PIN, Lock now, and locking again by
// itself. In real Chromium, answered by the real host with a stand-in keychain (and a low cost per guess, for speed).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

const CARD = '.hc-grid .hc-card[data-card="note"]', OPEN = ".hc-open .hc-card", WORDS = "The router is under the stairs";
const opened = async (width, more = {}) => { const x = await openGrid(browser, { width: 300, layout: ["note", "clock"], seed: sample(), notesOptions: { iterations: 1500 }, ...more }); await x.page.click(`${CARD} .nt-openapp`); await x.rest(200); if (width !== 300) await x.resize(width, more.height || 900); return x; };
const note = async (x, id) => { await x.page.click(`${OPEN} .hc-note-row[data-note="${id}"]`); await x.rest(300); };
const type = async (x, digits, rest = 450) => { for (const d of digits) await x.page.keyboard.press(d); await x.rest(rest); };
const lockScreen = (p) => p.evaluate((sel) => { const l = document.querySelector(`${sel} .nt-lockbox`); if (!l) return null; return { title: l.querySelector("h3")?.textContent || "", text: l.innerText.replace(/\s+/g, " "), dots: l.querySelectorAll(".nt-dots i").length, on: l.querySelectorAll(".nt-dots i.on").length, pad: l.querySelectorAll(".nt-pad button").length, off: [...l.querySelectorAll(".nt-pad button")].every((b) => b.disabled) && l.querySelectorAll(".nt-pad button").length > 0, warn: l.querySelector(".nt-warn")?.textContent || "", focus: !!document.activeElement?.closest(".nt-pad") }; }, OPEN);
const row = (p, id) => p.evaluate(({ sel, id }) => { const r = document.querySelector(`${sel} .hc-note-row[data-note="${id}"]`); return r ? { meta: r.querySelector(".hc-meta")?.textContent || "", lock: !!r.querySelector(".nt-lockmark-row") } : null; }, { sel: OPEN, id });
const shown = (p) => p.evaluate(() => document.body.innerText);
/** A PIN is set and wifi01 locked with it, from the note's own lock button (it locks at once), then opened with the PIN. */
const lockFirst = async (x, pin = "4821") => { await note(x, "wifi01"); await x.page.click(`${OPEN} .nt-lock`); await x.rest(200); await type(x, pin, 150); await type(x, pin, 700); await x.page.click(`${OPEN} .nt-pad`); await type(x, pin, 700); };

test("the first lock: choose a PIN and type it twice; it says plainly what a forgotten PIN means and that the title stays readable; then the note is encrypted", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await note(x, "wifi01");
    assert.equal(await p.getAttribute(`${OPEN} .nt-lock`, "aria-pressed"), "false"); assert.match(await p.getAttribute(`${OPEN} .nt-lock`, "aria-label"), /Lock this note/);
    await p.click(`${OPEN} .nt-lock`); await x.rest(200);
    let s = await lockScreen(p);
    assert.equal(s.title, "Choose a PIN"); assert.deepEqual([s.dots, s.on, s.pad], [4, 0, 11]); assert.equal(s.focus, true, "the pad has the keyboard: the number keys type");
    assert.match(s.text, /A forgotten PIN cannot be reset/); assert.match(s.text, /title stays readable: don’t put the secret in the first line/); assert.match(s.text, /What a PIN holds against/);
    assert.equal(await p.locator(`${OPEN} .nt-doc`).count(), 0, "the note's words are out of sight while a PIN is typed");
    await type(x, "48", 100); assert.equal((await lockScreen(p)).on, 2);
    await p.keyboard.press("Backspace"); await x.rest(60); assert.equal((await lockScreen(p)).on, 1);
    await type(x, "821", 150);
    s = await lockScreen(p); assert.match(s.text, /Type it again/); assert.equal(s.on, 0);
    // Not the same twice: it starts over, and nothing is locked.
    await type(x, "4822", 200);
    s = await lockScreen(p); assert.match(s.warn, /not the same/); assert.equal(s.title, "Choose a PIN"); assert.equal((await x.notes.state()).lock.state, "none");
    await type(x, "4821", 150); await type(x, "4821", 600);
    s = await lockScreen(p);
    assert.equal(s.title, "House Wi-Fi and the alarm", "locked at once: its title and the keypad"); assert.match(s.text, /Type your 4-digit PIN to open it/);
    assert.equal(await p.locator(`${OPEN} .nt-doc`).count(), 0);
    assert.equal(await p.getAttribute(`${OPEN} .nt-lock`, "aria-pressed"), "true");
    const st = await x.notes.state(), dir = join(x.notes.context.dir, "notes");
    assert.deepEqual([st.lock.state, st.lock.digits, st.notes.find((n) => n.id === "wifi01").locked], ["locked", 4, true]);
    assert.equal(existsSync(join(dir, "wifi01.md")), false); assert.equal(readFileSync(join(dir, "wifi01.lock"), "utf8").includes("router"), false);
    // The PIN is never drawn, and is sent only with the lock's own messages.
    assert.equal((await p.content()).includes("4821"), false);
    assert.deepEqual([...new Set((await x.posted("homeNotesDo")).filter((m) => JSON.stringify(m).includes("4821")).map((m) => m.op))], ["lockSet"]);
    // Its row: the title and a lock, "Locked" where the line was.
    await p.click(`${OPEN} .hc-note-all`); await x.rest(200);
    assert.deepEqual(await row(p, "wifi01"), { meta: "Yesterday · Locked", lock: true });
  } finally { await x.close(); }
});

test("Lock now (the button, and Ctrl+Alt+L): the words leave the page; the PIN pad opens the note again, by keys or by its buttons", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(760), p = x.page;
  try {
    await lockFirst(x);
    assert.match(await shown(p), new RegExp(WORDS));
    await p.click(`${OPEN} .nt-locknow`); await x.rest(300);
    assert.equal((await x.notes.state()).lock.state, "locked");
    assert.equal((await shown(p)).includes(WORDS), false, "not on the page any more"); assert.equal((await p.content()).includes("under the stairs"), false, "nor anywhere in it");
    let s = await lockScreen(p);
    assert.equal(s.title, "House Wi-Fi and the alarm"); assert.match(s.text, /Type your 4-digit PIN to open it/); assert.match(s.text, /An opened note stays open until you lock it again/); assert.match(s.text, /Forgot PIN\?/);
    assert.equal(await p.locator(`${OPEN} .nt-locknow`).count(), 0, "nothing to lock while notes are locked");
    for (const d of "4821") await p.click(`${OPEN} .nt-pad button[data-digit="${d}"]`); await x.rest(600);
    assert.equal(await lockScreen(p), null); assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), new RegExp(WORDS));
    // Typed while open, it is saved encrypted.
    await p.click(`${OPEN} .nt-doc`); await p.keyboard.press("Control+End"); await p.keyboard.press("Enter"); await p.keyboard.type("Spare key with the neighbour"); await x.rest(900);
    assert.match(await x.notes.text("wifi01"), /Spare key with the neighbour$/);
    assert.equal(readFileSync(join(x.notes.context.dir, "notes", "wifi01.lock"), "utf8").includes("neighbour"), false);
    await p.keyboard.press("Control+Alt+l"); await x.rest(300);
    assert.equal((await x.notes.state()).lock.state, "locked"); assert.equal((await shown(p)).includes("neighbour"), false);
    assert.match((await lockScreen(p)).text, /Type your 4-digit PIN/);
  } finally { await x.close(); }
});

test("a wrong PIN says how many tries are left; after five the pad is off and a clock counts the wait down; a reload does not buy fresh tries", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await lockFirst(x); await p.keyboard.press("Control+Alt+l"); await x.rest(300);
    await type(x, "0000", 500);
    let s = await lockScreen(p);
    assert.match(s.warn, /Wrong PIN\. 4 tries left, then a 30 second wait\./); assert.equal(s.on, 0); assert.equal(s.focus, true);
    for (let k = 0; k < 3; k++) await type(x, "1111", 500);
    assert.match((await lockScreen(p)).warn, /Wrong PIN\. 1 try left/);
    await type(x, "2222", 500);
    s = await lockScreen(p);
    assert.match(s.warn, /Too many wrong tries\. Try again in 0:(30|2\d)\./); assert.equal(s.off, true, "the pad is off");
    await type(x, "4821", 500);
    assert.notEqual(await lockScreen(p), null, "the right PIN is not taken during the wait"); assert.equal((await x.notes.state()).lock.state, "locked");
    const first = (await lockScreen(p)).warn; await x.rest(1600);
    assert.notEqual((await lockScreen(p)).warn, first, "the clock counts down");
    assert.equal((await x.notes.list(true)).length, 16, "and nothing is erased");
  } finally { await x.close(); }
});

test("Forgot PIN: it says there is no reset, names what will be deleted, asks once more, and deletes only the locked notes, for good", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await lockFirst(x);
    await p.click(`${OPEN} .hc-note-all`); await x.rest(200); await note(x, "pass01"); await p.click(`${OPEN} .nt-lock`); await x.rest(400);
    assert.equal((await x.notes.list()).filter((n) => n.locked).length, 2, "a second note locks with the same PIN, at once");
    await p.keyboard.press("Control+Alt+l"); await x.rest(300);
    await p.click(`${OPEN} .nt-lockbox [data-pin="forgot"]`); await x.rest(200);
    let s = await lockScreen(p);
    assert.equal(s.title, "Forgot your PIN?");
    assert.match(s.text, /DGC cannot open a locked note without its PIN, and neither can anyone else: there is no reset and no back door\./);
    assert.match(s.text, /delete your 2 locked notes and start over with a new PIN\. Your other 12 notes stay as they are\./);
    assert.deepEqual(await p.locator(`${OPEN} .nt-lockbox button`).allInnerTexts(), ["Try the PIN again", "Delete 2 locked notes…"]);
    await p.click(`${OPEN} .nt-lockbox [data-pin="forgot-next"]`); await x.rest(200);
    s = await lockScreen(p);
    assert.match(s.text, /House Wi-Fi and the alarm/); assert.match(s.text, /Passport numbers/); assert.match(s.text, /do not go to Recently deleted/);
    assert.equal((await x.notes.list()).length, 14, "nothing yet");
    await p.click(`${OPEN} .nt-lockbox [data-pin="forgot-sure"]`); await x.rest(500);
    const st = await x.notes.state();
    assert.equal(st.notes.filter((n) => !n.deleted).length, 12); assert.equal(st.notes.filter((n) => n.deleted).length, 2, "Recently deleted has what it had, no more"); assert.equal(st.lock.state, "none");
    assert.equal(existsSync(join(x.notes.context.dir, "notes", "wifi01.lock")), false);
    // The next lock asks for a new PIN.
    await note(x, "seeds1"); await p.click(`${OPEN} .nt-lock`); await x.rest(200);
    assert.equal((await lockScreen(p)).title, "Choose a PIN");
  } finally { await x.close(); }
});

test("the lock comes off a note with the PIN; the PIN is changed with the old one; a longer PIN (up to 8 digits) can be chosen", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    // A longer PIN: six digits, then Next.
    await note(x, "wifi01"); await p.click(`${OPEN} .nt-lock`); await x.rest(200);
    await p.click(`${OPEN} .nt-lockbox [data-pin="longer"]`); await x.rest(150);
    let s = await lockScreen(p); assert.match(s.text, /4 to 8 digits/); assert.equal(s.dots, 8);
    await type(x, "482", 100); assert.equal(await p.locator(`${OPEN} .nt-lockbox [data-pin="next"]`).isDisabled(), true, "fewer than four is not a PIN");
    await type(x, "193", 100); await p.keyboard.press("Enter"); await x.rest(200);
    assert.match((await lockScreen(p)).text, /Type it again/);
    await type(x, "482193", 700);
    assert.equal((await x.notes.state()).lock.digits, 6); assert.match((await lockScreen(p)).text, /Type your 6-digit PIN to open it/);
    await p.click(`${OPEN} .nt-pad`); await type(x, "482193", 700); assert.equal(await lockScreen(p), null);
    // Remove lock (in the note's ⋯): it asks for the PIN even while the note is open.
    await p.click(`${OPEN} .nt-more`); await x.rest(150); await p.locator(".nt-menu .dgc-menu-row", { hasText: "Remove lock…" }).click(); await x.rest(200);
    s = await lockScreen(p); assert.equal(s.title, "Remove lock"); assert.match(s.text, /Type your PIN/);
    await type(x, "482193", 700);
    assert.equal((await x.notes.list()).find((n) => n.id === "wifi01").locked, false); assert.equal(existsSync(join(x.notes.context.dir, "notes", "wifi01.md")), true);
    assert.equal(await p.getAttribute(`${OPEN} .nt-lock`, "aria-pressed"), "false");
    // Change the PIN, from the note's ⋯ menu.
    await p.click(`${OPEN} .nt-lock`); await x.rest(200); assert.match((await lockScreen(p)).text, /Type your 6-digit PIN to lock/); await type(x, "482193", 800);
    await p.click(`${OPEN} .nt-more`); await x.rest(150); await p.locator(".nt-menu .dgc-menu-row", { hasText: "Change PIN…" }).click(); await x.rest(200);
    assert.match((await lockScreen(p)).text, /Type the PIN you have now/);
    await type(x, "482193", 200); assert.match((await lockScreen(p)).text, /Choose a new PIN/);
    await type(x, "7755", 200); await type(x, "7755", 700);
    assert.equal((await x.notes.state()).lock.digits, 4); assert.match((await lockScreen(p)).text, /Type your 4-digit PIN to open it/);
    assert.equal(await p.evaluate(() => !!document.activeElement?.closest(".nt-pad")), true, "the pad has the keyboard");
    await type(x, "7755", 700);
    assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), new RegExp(WORDS), "the new PIN opens what the old one locked");
  } finally { await x.close(); }
});

test("notes lock again by themselves after a while with nothing done; a computer with no keychain locks nothing and says why", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300, { notesOptions: { iterations: 1500, idleMs: 1500 } }), p = x.page;
  try {
    await lockFirst(x);
    assert.equal(await lockScreen(p), null);
    await x.rest(2200);
    assert.match((await lockScreen(p)).text, /Type your 4-digit PIN to open it/, "the pad is back, by itself");
    assert.equal((await shown(p)).includes(WORDS), false);
  } finally { await x.close(); }
  const y = await opened(300, { keychain: false }), q = y.page;
  try {
    await note(y, "wifi01"); await q.click(`${OPEN} .nt-lock`); await y.rest(300);
    const s = await lockScreen(q);
    assert.match(s.text, /This computer has no keychain, so notes cannot be locked here/); assert.equal(s.pad, 0, "no PIN is asked for");
    assert.equal((await y.notes.list()).some((n) => n.locked), false);
    await q.click(`${OPEN} .nt-lockbox [data-pin="cancel"]`); await y.rest(200);
    assert.match(await q.locator(`${OPEN} .nt-doc`).innerText(), new RegExp(WORDS));
  } finally { await y.close(); }
});

