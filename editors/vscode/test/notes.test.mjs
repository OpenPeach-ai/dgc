// Notes, the notes app on Home (media/shared/notes.js, media/shared/notes.css), in real Chromium on the real side bar,
// answered by the real host (src/notes.ts) on a folder of its own. Step 2 here: folders, the order of the list, search
// across everything, the list that scrolls inside the card, Recently deleted. Nothing touches a network or a real home.
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
const rows = (p, where) => p.evaluate((w) => [...document.querySelectorAll(`${w} .hc-note-row`)].map((r) => ({ id: r.dataset.note, title: r.querySelector(".hc-nm").textContent, meta: r.querySelector(".hc-meta")?.textContent || "", marks: [...r.querySelectorAll("mark")].map((m) => m.textContent), pinned: !!r.querySelector('.hc-note-pinmark[title^="Pinned"]') })), where);
const ids = async (p, where) => (await rows(p, where)).map((r) => r.id);
const menu = (p) => p.evaluate(() => { const m = document.querySelector(".nt-menu"); if (!m) return null; const r = m.getBoundingClientRect(), c = m.closest(".hc-card").getBoundingClientRect();
  return { rows: [...m.querySelectorAll(".dgc-menu-row")].map((b) => [b.querySelector(".dgc-menu-label").textContent, b.querySelector(".dgc-menu-hint")?.textContent || "", b.getAttribute("aria-checked") || ""]), inside: r.left >= c.left - 0.5 && r.right <= c.right + 0.5, focus: document.activeElement?.closest(".nt-menu") ? document.activeElement.textContent : "" }; });
const pick = async (x, label) => { await x.page.locator(".nt-menu .dgc-menu-row", { hasText: label }).first().click(); await x.rest(150); };
const opened = async (width, more = {}) => { const x = await openGrid(browser, { width: 300, layout: ["note", "clock"], seed: sample(), ...more }); await x.page.click(CARD); await x.rest(200); if (width !== 300) await x.resize(width, more.height || 900); return x; };

test("folders, in a narrow side bar: the folder button lists them with how many notes each has; a folder shows its notes only, and is remembered", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    assert.equal((await ids(p, OPEN)).length, 14, "All notes: every note");
    assert.equal(await p.locator(`${OPEN} .nt-folder`).innerText(), "All notes");
    await p.click(`${OPEN} .nt-folder`); await x.rest(150);
    let m = await menu(p);
    assert.deepEqual(m.rows, [["All notes", "14", "true"], ["Trips", "4", "false"], ["Home", "5", "false"], ["Reading", "3", "false"], ["New folder…", "", ""], ["Rename or delete a folder…", "", ""], ["Export All notes…", "", ""], ["Recently deleted", "2", "false"]]);
    assert.equal(m.inside, true, "the menu stays inside the card"); assert.equal(m.focus.includes("All notes"), true, "the keyboard is on the folder shown");
    await p.keyboard.press("ArrowDown"); await p.keyboard.press("Enter"); await x.rest(200);
    assert.equal(await menu(p), null);
    assert.deepEqual(await ids(p, OPEN), ["ferry1", "pass01", "tide01", "pack01"], "Trips: its notes, the pinned one first, then the latest edited");
    assert.equal(await p.locator(`${OPEN} .nt-folder`).innerText(), "Trips");
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-folder")), true, "the keyboard goes back to the button");
    assert.equal((await x.notes.state()).shown, "trips1", "the host keeps the folder you were in");
    // A new note is made in the folder shown.
    await p.click(`${OPEN} .hc-note-new`); await x.rest(150); await p.keyboard.type("Harbour café"); await x.rest(800);
    assert.equal((await x.notes.list()).find((n) => n.title === "Harbour café").folder, "trips1");
    // Escape in the menu closes it and nothing else.
    await p.keyboard.press("Escape"); await x.rest(150); await p.click(`${OPEN} .nt-folder`); await x.rest(120); await p.keyboard.press("Escape"); await x.rest(120);
    assert.equal(await menu(p), null); assert.equal((await x.grid()).open?.id, "note");
  } finally { await x.close(); }
});

test("folders: New folder, Rename and Delete; deleting one asks one thing, and by default its notes stay in All notes", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await p.click(`${OPEN} .nt-folder`); await x.rest(120); await pick(x, "New folder…");
    assert.equal(await p.evaluate(() => document.activeElement?.matches("input.nt-name")), true, "the name field has the keyboard");
    await p.keyboard.type("trips"); await p.keyboard.press("Enter"); await x.rest(150);
    assert.match(await p.locator(`${OPEN} .nt-ask`).innerText(), /There is a folder with that name already/);
    await p.fill(`${OPEN} input.nt-name`, "Garden"); await p.keyboard.press("Enter"); await x.rest(250);
    assert.deepEqual((await x.notes.state()).folders.map((f) => f.name), ["Trips", "Home", "Reading", "Garden"]);
    assert.equal(await p.locator(`${OPEN} .nt-folder`).innerText(), "Garden", "the new folder is shown"); assert.match(await p.locator(`${OPEN} .nt-listbox`).innerText(), /No notes in Garden yet/);
    // Rename, from the folder menu's own row.
    await p.click(`${OPEN} .nt-folder`); await x.rest(120); await pick(x, "Rename or delete a folder…");
    await p.locator(`${OPEN} .nt-ask .nt-askrow`, { hasText: "Home" }).locator('[data-ask="rename"]').click(); await x.rest(150);
    await p.fill(`${OPEN} input.nt-name`, "House"); await p.keyboard.press("Enter"); await x.rest(250);
    assert.equal((await x.notes.state()).folders[1].name, "House");
    // Delete: the default (the solid button, where the keyboard is) moves the notes to All notes.
    await p.click(`${OPEN} .nt-folder`); await x.rest(120); await pick(x, "Rename or delete a folder…");
    await p.locator(`${OPEN} .nt-ask .nt-askrow`, { hasText: "Trips" }).locator('[data-ask="delete"]').click(); await x.rest(150);
    const ask = await p.locator(`${OPEN} .nt-ask`).innerText();
    assert.match(ask, /Delete the folder Trips\?/); assert.match(ask, /It has 4 notes/);
    assert.equal(await p.evaluate(() => document.activeElement?.textContent), "Move its notes to All notes");
    await p.keyboard.press("Enter"); await x.rest(250);
    let s = await x.notes.state();
    assert.deepEqual(s.folders.map((f) => f.name), ["House", "Reading", "Garden"]); assert.equal(s.notes.filter((n) => !n.deleted).length, 14, "no note was lost"); assert.equal(s.notes.find((n) => n.id === "ferry1").folder, "");
    // The other answer: its notes go to Recently deleted.
    await p.click(`${OPEN} .nt-folder`); await x.rest(120); await pick(x, "Rename or delete a folder…");
    await p.locator(`${OPEN} .nt-ask .nt-askrow`, { hasText: "Reading" }).locator('[data-ask="delete"]').click(); await x.rest(150);
    await p.click(`${OPEN} .nt-ask [data-ask="folder-bin"]`); await x.rest(250);
    s = await x.notes.state();
    assert.equal(s.notes.filter((n) => !n.deleted).length, 11); assert.equal(s.notes.filter((n) => n.deleted).length, 5);
  } finally { await x.close(); }
});

test("the order of the list: last edited, created or title, pinned notes first under their own heading in each", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    assert.deepEqual((await ids(p, OPEN)).slice(0, 4), ["ferry1", "wifi01", "seeds1", "bank01"]);
    assert.deepEqual(await p.locator(`${OPEN} .nt-grp`).allInnerTexts(), ["Pinned", "Notes"]);
    await p.click(`${OPEN} .nt-sort`); await x.rest(120);
    assert.deepEqual((await menu(p)).rows, [["Last edited", "", "true"], ["Created", "", "false"], ["Title", "", "false"]]);
    await pick(x, "Title");
    assert.deepEqual((await rows(p, OPEN)).map((r) => r.title), ["Ferry to Porto", "House Wi-Fi and the alarm", "Bike service", "Book club: the March pick", "Call the bank about the card", "Gift ideas", "Lemon rice", "Lines I liked", "Packing for the bay", "Paint for the fence", "Passport numbers", "Reading list", "Seeds for spring", "Tide tables for the bay"]);
    assert.equal((await x.notes.state()).sort, "title", "kept for the next time");
    assert.match(await p.getAttribute(`${OPEN} .nt-sort`, "aria-label"), /Sort: title/);
  } finally { await x.close(); }
});

test("search: as you type, in the folder you are in, the found words marked on the row with the line they are in; Search all notes when the folder has none", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    await p.keyboard.press("Escape"); await x.rest(100); await p.click(CARD); await x.rest(200);
    await p.locator(`${OPEN} .hc-note-row`).first().focus(); await p.keyboard.press("/"); await x.rest(60);
    assert.equal(await p.evaluate(() => document.activeElement?.matches("input.hc-note-find")), true, "/ goes to search");
    await p.keyboard.type("FERRY"); await x.rest(400);
    let found = await rows(p, OPEN);
    assert.deepEqual(found.map((r) => r.id), ["ferry1", "bank01", "tide01"]);
    assert.deepEqual(found.map((r) => r.marks), [["Ferry"], ["ferry"], ["ferry"]], "the found words are marked: in the title, or in the line they are in");
    assert.match(found[1].meta, /Then book the ferry/); assert.match(found[2].meta, /by the ferry pier/);
    assert.equal(await p.locator(`${OPEN} .nt-grp`).count(), 0, "what is found is one list");
    assert.equal(await p.evaluate(() => document.activeElement?.matches("input.hc-note-find") && document.activeElement.value), "FERRY", "the keyboard and the words stay in the field");
    // In a folder with no match: say so, and offer all notes.
    await p.fill(`${OPEN} input.hc-note-find`, ""); await x.rest(200);
    assert.equal((await ids(p, OPEN)).length, 14);
    await p.click(`${OPEN} .nt-folder`); await x.rest(120); await pick(x, "Reading");
    await p.fill(`${OPEN} input.hc-note-find`, "ferry"); await x.rest(400);
    assert.deepEqual(await ids(p, OPEN), []); assert.match(await p.locator(`${OPEN} .nt-listbox`).innerText(), /No note in Reading has “ferry”/);
    await p.click(`${OPEN} .nt-searchall`); await x.rest(400);
    assert.deepEqual(await ids(p, OPEN), ["ferry1", "bank01", "tide01"]);
    // Escape clears the search, then (again) goes back to Home.
    await p.locator(`${OPEN} input.hc-note-find`).focus(); await p.keyboard.press("Escape"); await x.rest(200);
    assert.equal(await p.inputValue(`${OPEN} input.hc-note-find`), ""); assert.deepEqual(await ids(p, OPEN), ["book01", "read02", "poem01"]); assert.equal((await x.grid()).open?.id, "note");
    await p.keyboard.press("Escape"); await x.rest(200);
    assert.equal((await x.grid()).open, null);
  } finally { await x.close(); }
});

test("the list scrolls inside the card (the page does not grow) and keeps its place when you come back from a note; Up, Down, Enter and Delete work in it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300, { height: 640 }), p = x.page;
  try {
    const box = () => p.evaluate(() => { const b = document.querySelector(".hc-open .nt-listbox"), c = document.querySelector(".hc-open .hc-card"); return { scrolls: b.scrollHeight > b.clientHeight + 20, top: b.scrollTop, card: c.getBoundingClientRect().height, page: document.documentElement.scrollWidth > innerWidth }; });
    let b = await box();
    assert.equal(b.scrolls, true, "fourteen notes do not fit: the list scrolls"); assert.ok(b.card < 640, `the card stays on the screen (${b.card})`); assert.equal(b.page, false);
    await p.evaluate(() => { document.querySelector(".hc-open .nt-listbox").scrollTop = 260; }); await x.rest(60);
    const at = (await box()).top; assert.ok(at > 150);
    await p.click(`${OPEN} .hc-note-row[data-note="tide01"]`); await x.rest(250);
    assert.equal(await p.locator(`${OPEN} .hc-note-row`).count(), 0, "one thing at a time: the note, over the list");
    assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /Tide tables for the bay/);
    await p.click(`${OPEN} .hc-note-all`); await x.rest(250);
    assert.ok(Math.abs((await box()).top - at) < 3, "back at the same place in the list");
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.note), "tide01", "and the keyboard is on the note's row");
    // The keys of the list.
    await p.keyboard.press("ArrowUp"); assert.equal(await p.evaluate(() => document.activeElement?.dataset.note), "read02");
    await p.keyboard.press("ArrowDown"); await p.keyboard.press("ArrowDown"); assert.equal(await p.evaluate(() => document.activeElement?.dataset.note), "pack01");
    await p.keyboard.press("Delete"); await x.rest(250);
    assert.equal((await x.notes.list(true)).find((n) => n.id === "pack01").deleted > 0, true, "Delete deletes the note the keyboard is on");
    assert.match(await p.locator(`${OPEN} .hc-note-undo`).innerText(), /Note deleted/);
    await p.locator(`${OPEN} .hc-note-row[data-note="gift01"]`).focus(); await p.keyboard.press("Enter"); await x.rest(250);
    assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /Gift ideas/);
  } finally { await x.close(); }
});

test("a Medium card shows about five rows and scrolls the rest inside itself", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["note", "token"], seed: sample() }), p = x.page;
  try {
    const m = await p.evaluate((sel) => { const c = document.querySelector(sel), b = c.querySelector(".nt-listbox"), r = [...b.querySelectorAll(".hc-note-row")], br = b.getBoundingClientRect();
      return { form: c.dataset.form, rows: r.length, seen: r.filter((x) => { const q = x.getBoundingClientRect(); return q.top >= br.top - 1 && q.bottom <= br.bottom + 1; }).length, scrolls: b.scrollHeight > b.clientHeight + 20, height: c.getBoundingClientRect().height }; }, CARD);
    assert.equal(m.form, "m"); assert.equal(m.rows, 14); assert.ok(m.seen >= 4 && m.seen <= 5, `about five rows show (${m.seen})`); assert.equal(m.scrolls, true); assert.ok(m.height < 380, `the card does not grow with the notes (${m.height})`);
  } finally { await x.close(); }
});

test("Recently deleted: a deleted note waits there with the days it has left; Undo, Restore to its folder, Delete now and Empty now (both ask first)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(300), p = x.page;
  try {
    // Delete from the open note's ⋯ menu; Undo brings it back.
    await p.click(`${OPEN} .hc-note-row[data-note="seeds1"]`); await x.rest(250);
    await p.click(`${OPEN} .nt-more`); await x.rest(120);
    assert.deepEqual((await menu(p)).rows.at(-1), ["Delete", "kept 30 days", ""]);
    await pick(x, "Delete");
    assert.equal((await x.notes.list(true)).find((n) => n.id === "seeds1").deleted > 0, true);
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("hc-undo")), true, "the keyboard is on Undo");
    await p.keyboard.press("Enter"); await x.rest(300);
    assert.equal((await x.notes.list()).find((n) => n.id === "seeds1").folder, "home01", "Undo: back where it was");
    // The bin, from the folder menu.
    assert.equal(await p.evaluate(() => document.activeElement?.dataset.note), "seeds1", "and the keyboard is on its row");
    await p.click(`${OPEN} .hc-note-row[data-note="seeds1"]`); await x.rest(200); await p.click(`${OPEN} .nt-more`); await x.rest(120); await pick(x, "Delete");
    await p.click(`${OPEN} .nt-folder`); await x.rest(120); await pick(x, "Recently deleted");
    const bin = () => p.evaluate(() => [...document.querySelectorAll(".hc-open .nt-drow")].map((r) => [r.querySelector(".hc-nm").textContent, r.querySelector(".hc-meta").textContent]));
    assert.deepEqual(await bin(), [["Seeds for spring", "30 days left"], ["Old ferry times", "28 days left"], ["Shopping, last week", "4 days left"]]);
    assert.match(await p.locator(`${OPEN} .nt-deleted`).innerText(), /3 notes · kept 30 days, then gone for good/);
    await p.click(`${OPEN} .nt-restore[data-note="oldf01"]`); await x.rest(250);
    assert.deepEqual([(await x.notes.list()).find((n) => n.id === "oldf01").folder, (await bin()).length], ["trips1", 2], "Restore: to the folder it was in");
    // Delete now asks first; Cancel keeps it.
    await p.click(`${OPEN} .nt-purge[data-note="shop01"]`); await x.rest(150);
    assert.match(await p.locator(`${OPEN} .nt-ask`).innerText(), /Delete “Shopping, last week” for good\?[\s\S]*cannot be undone/);
    await p.click(`${OPEN} .nt-ask [data-ask="cancel"]`); await x.rest(150);
    assert.equal((await x.notes.list(true)).some((n) => n.id === "shop01"), true);
    await p.click(`${OPEN} .nt-purge[data-note="shop01"]`); await x.rest(150); await p.click(`${OPEN} .nt-ask [data-ask="purge-yes"]`); await x.rest(250);
    assert.equal((await x.notes.list(true)).some((n) => n.id === "shop01"), false);
    // Empty now asks first.
    await p.click(`${OPEN} .nt-empty`); await x.rest(150);
    assert.match(await p.locator(`${OPEN} .nt-ask`).innerText(), /Delete this note for good\?/);
    await p.click(`${OPEN} .nt-ask [data-ask="empty-yes"]`); await x.rest(250);
    assert.equal((await x.notes.list(true)).filter((n) => n.deleted).length, 0); assert.match(await p.locator(`${OPEN} .nt-deleted`).innerText(), /Nothing here/);
    assert.equal(await p.locator(`${OPEN} .nt-empty`).isDisabled(), true);
    // Back to all notes.
    await p.click(`${OPEN} .hc-note-all`); await x.rest(200);
    assert.equal((await ids(p, OPEN)).length, 14);
  } finally { await x.close(); }
});

test("in a wide side bar: folders in a rail with Recently deleted at its foot, the list, the note; a row dragged onto a folder moves the note", async (t) => {
  if (skipOrFail(t)) return;
  const x = await opened(760), p = x.page;
  try {
    const cols = await p.evaluate(() => { const r = (s) => document.querySelector(`.hc-open ${s}`).getBoundingClientRect(), a = r(".nt-rail"), b = r(".nt-listbox"), c = r(".nt-pane"), card = r(".hc-card");
      return { order: a.right <= b.left + 1 && b.right <= c.left + 1, inside: c.right <= card.right + 0.5, rail: [...document.querySelectorAll(".hc-open .nt-rail .nt-fold")].map((f) => f.innerText.replace(/\s+/g, " ").trim()), over: document.documentElement.scrollWidth > innerWidth }; });
    assert.equal(cols.order, true, "three columns: folders, the list, the note"); assert.equal(cols.inside, true); assert.equal(cols.over, false);
    assert.deepEqual(cols.rail, ["All notes 14", "Trips 4", "Home 5", "Reading 3", "New folder", "Recently deleted 2"]);
    assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /Ferry to Porto/, "the first note is open beside the list");
    await p.click(`${OPEN} .nt-fold[data-folder="home01"]`); await x.rest(250);
    assert.deepEqual(await ids(p, OPEN), ["wifi01", "seeds1", "rice01", "bike01", "fence1"]);
    assert.equal(await p.getAttribute(`${OPEN} .nt-fold[data-folder="home01"]`, "aria-current"), "true");
    // Drag a row onto Reading.
    await p.dragAndDrop(`${OPEN} .hc-note-row[data-note="bike01"]`, `${OPEN} .nt-fold[data-folder="read01"]`); await x.rest(300);
    assert.equal((await x.notes.list()).find((n) => n.id === "bike01").folder, "read01");
    assert.deepEqual(await ids(p, OPEN), ["wifi01", "seeds1", "rice01", "fence1"]);
    // The folder's own ⋯: rename and delete.
    await p.click(`${OPEN} .nt-fold-more`); await x.rest(120);
    assert.deepEqual((await menu(p)).rows.map((r) => r[0]), ["Rename…", "Export…", "Delete…"]);   // (Export… came with step 5)
    await pick(x, "Rename…"); await p.fill(`${OPEN} input.nt-name`, "House"); await p.keyboard.press("Enter"); await x.rest(250);
    assert.equal((await x.notes.state()).folders.find((f) => f.id === "home01").name, "House");
    // Recently deleted, in the rail.
    await p.click(`${OPEN} .nt-fold[data-folder="bin"]`); await x.rest(250);
    assert.match(await p.locator(`${OPEN} .nt-deleted`).innerText(), /Deleted 2 days ago · 28 days left/);
  } finally { await x.close(); }
});
