// Notes, step 6 (media/shared/notes.js, notes.css, homecards.js): the three card sizes and the opened app in both its
// layouts, as the design has them; the palette's "DGC: New Note"; and the look held to DGC's rules in every scene: one
// shape for every control, every word readable, nothing spilling sideways, in dark and in light.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

const root = new URL("..", import.meta.url).pathname, CARD = '.hc-grid .hc-card[data-card="note"]', OPEN = ".hc-open .hc-card";
const grid = (width, more = {}) => openGrid(browser, { width, layout: ["note", "clock", "token"], seed: sample(), notesOptions: { iterations: 1500 }, ...more });
const type = async (x, digits, rest = 450) => { for (const d of digits) await x.page.keyboard.press(d); await x.rest(rest); };
/** What breaks the look inside `where`: a word under 4.5:1, a control that is not the 6 px family, something past the card's edge. */
const flaws = (page, where) => page.evaluate((sel) => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((u, top) => over(top, u), parse(getComputedStyle(document.body).backgroundColor).slice(0, 3).concat(1)); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const card = document.querySelector(sel), out = [], box = card.getBoundingClientRect(), walk = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { const e = n.parentElement; if (!n.textContent.trim() || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || e.closest(":disabled, [data-off]")) continue;
    const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p), ratio = (a + 0.05) / (b + 0.05);
    if (ratio < 4.5) out.push(`faint: ${n.textContent.trim().slice(0, 24)} ${ratio.toFixed(2)} (${e.className || e.tagName})`); }
  for (const c of card.querySelectorAll("button, input, [role='menuitem'], [role='menuitemradio'], summary")) { if (!c.checkVisibility()) continue; const r = c.getBoundingClientRect(), s = getComputedStyle(c), corner = Math.max(...[s.borderTopLeftRadius, s.borderBottomRightRadius].map((v) => parseFloat(v) || 0));
    if (r.width >= 8 && corner > 6.5) out.push(`not the 6 px family: ${c.className} ${corner}`);
    if (!c.closest(".nt-listbox, .nt-body, .nt-rail, .nt-menu") && (r.right > box.right + 1 || r.left < box.left - 1)) out.push(`past the card's edge: ${c.className}`); }
  if (document.documentElement.scrollWidth > innerWidth) out.push("the page scrolls sideways");
  for (const b of card.querySelectorAll("button")) if (b.checkVisibility() && !(b.getAttribute("aria-label") || b.textContent.trim() || b.title)) out.push(`a button with no name: ${b.className}`);
  return out;
}, where);

test("the Small card: the top note (a pinned one first) with up to two of its lines, how many notes and folders, and a small + for a quick note", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(300), p = x.page;
  try {
    await x.rest(500);      // (the cards have come to rest: a card still gliding in is measured smaller than it is)
    const s = await p.evaluate((sel) => { const c = document.querySelector(sel), r = c.getBoundingClientRect(), q = c.querySelector(".nt-quick"), qr = q.getBoundingClientRect(), two = c.querySelector(".nt-two");
      return { form: c.dataset.form, text: c.innerText.replace(/\s+/g, " ").trim(), square: Math.abs(c.offsetWidth - c.offsetHeight) < 1.5, plus: { name: q.getAttribute("aria-label"), inside: qr.right <= r.right && qr.top >= r.top, size: [q.offsetWidth, q.offsetHeight], corner: parseFloat(getComputedStyle(q).borderTopLeftRadius) }, lines: Math.round(two.getBoundingClientRect().height / parseFloat(getComputedStyle(two).lineHeight)), fits: c.scrollHeight <= c.clientHeight + 1 }; }, CARD);
    assert.equal(s.form, "s"); assert.equal(s.square, true, "still one cube");
    assert.match(s.text, /^Notes Ferry to Porto Leaves from the north quay/); assert.match(s.text, /14 notes · 3 folders$/);
    assert.ok(s.lines <= 2, `up to two lines of it (${s.lines})`); assert.equal(s.fits, true, "nothing is cut by the card");
    assert.deepEqual([s.plus.name, s.plus.inside], ["New note", true]); assert.ok(s.plus.size[0] >= 20 && s.plus.size[0] <= 24 && s.plus.corner <= 6, "a small button of the 6 px family");
    assert.deepEqual(await flaws(p, CARD), []);
    // Anywhere but the +: the app opens, on its list.
    await p.click(CARD, { position: { x: 30, y: 90 } }); await x.rest(250);
    assert.equal((await x.grid()).open?.id, "note"); assert.equal(await p.locator(`${OPEN} .hc-note-row`).count(), 14); assert.equal(await p.locator(`${OPEN} .nt-doc`).count(), 0);
    await p.keyboard.press("Escape"); await x.rest(200);
    // The +: a new note, with the app open on it, ready to type.
    await p.click(`${CARD} .nt-quick`); await x.rest(300);
    assert.equal((await x.grid()).open?.id, "note"); assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true);
    await p.keyboard.type("Milk, on the way home"); await x.rest(900);
    assert.equal((await x.notes.list()).some((n) => n.title === "Milk, on the way home"), true);
  } finally { await x.close(); }
});

test("the Small card never shows a locked note's words: its title and a lock; with no notes it says so and still offers the +", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(300), p = x.page;
  try {
    // Lock the top note (Ferry to Porto) from the opened app, then go back to Home.
    await p.click(CARD, { position: { x: 30, y: 90 } }); await x.rest(250); await p.click(`${OPEN} .hc-note-row[data-note="ferry1"]`); await x.rest(300);
    await p.click(`${OPEN} .nt-lock`); await x.rest(200); await type(x, "4821", 150); await type(x, "4821", 600);
    await p.keyboard.press("Escape"); await x.rest(150); await p.keyboard.press("Escape"); await x.rest(250);
    const s = await p.evaluate((sel) => { const c = document.querySelector(sel); return { text: c.innerText.replace(/\s+/g, " ").trim(), lock: !!c.querySelector(".nt-small-lock svg") }; }, CARD);
    assert.match(s.text, /^Notes Ferry to Porto Locked 14 notes · 3 folders$/, "even while notes are unlocked"); assert.equal(s.lock, true);
    assert.equal((await x.notes.state()).lock.state, "unlocked");
  } finally { await x.close(); }
  const y = await openGrid(browser, { width: 300, layout: ["note", "clock"] });
  try {
    assert.match(await y.page.locator(CARD).innerText(), /No notes yet/); assert.equal(await y.page.locator(`${CARD} .nt-quick`).count(), 1);
  } finally { await y.close(); }
});

test("the Medium card: Notes, the folder button and New; search; the list with its lock and pin marks; the count and Open Notes; folders and search work in place, a row opens the app on that note", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(460), p = x.page;
  try {
    const parts = await p.evaluate((sel) => { const c = document.querySelector(sel), y = (s) => c.querySelector(s).getBoundingClientRect().top; return { form: c.dataset.form, order: y(".hc-ch") < y(".hc-note-find") && y(".hc-note-find") < y(".nt-listbox") && y(".nt-listbox") < y(".nt-footbox"), head: c.querySelector(".hc-ch").innerText.replace(/\s+/g, " ").trim(), foot: c.querySelector(".nt-footbox").innerText.replace(/\s+/g, " ").trim(), pane: c.querySelectorAll(".nt-doc, .nt-rail").length }; }, CARD);
    assert.deepEqual(parts, { form: "m", order: true, head: "Notes All notes New", foot: "14 notes · 3 folders Open Notes", pane: 0 });
    assert.deepEqual(await flaws(p, CARD), []);
    // A folder chosen in place: the card stays a card.
    await p.click(`${CARD} .nt-folder`); await x.rest(150); await p.locator(".nt-menu .dgc-menu-row", { hasText: "Trips" }).click(); await x.rest(250);
    assert.equal((await x.grid()).open, null); assert.equal(await p.locator(`${CARD} .hc-note-row`).count(), 4);
    assert.equal(await p.locator(`${CARD} .nt-folder`).innerText(), "Trips");
    await p.fill(`${CARD} input.hc-note-find`, "tide"); await x.rest(450);
    assert.deepEqual(await p.locator(`${CARD} .hc-note-row .hc-nm`).allInnerTexts(), ["Tide tables for the bay"]); assert.equal((await x.grid()).open, null, "search in place too");
    await p.click(`${CARD} .hc-note-row`); await x.rest(300);
    assert.equal((await x.grid()).open?.id, "note"); assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /Tide tables for the bay/, "a row opens the app on that note");
    await p.click(".hc-back"); await x.rest(250);
    await p.click(`${CARD} .nt-openapp`); await x.rest(250);
    assert.equal((await x.grid()).open?.id, "note");
  } finally { await x.close(); }
});

test("the Large card: the folder's list (titles only) beside the open note with the short format bar, pin, lock and ⋯; both halves scroll on their own, inside a card that does not grow", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(700), p = x.page;
  try {
    const l = await p.evaluate((sel) => { const c = document.querySelector(sel), r = (s) => c.querySelector(s).getBoundingClientRect(), list = c.querySelector(".nt-listbox"), body = c.querySelector(".nt-body"), card = c.getBoundingClientRect(), clock = document.querySelector('.hc-grid .hc-card[data-card="clock"]')?.getBoundingClientRect();
      return { form: c.dataset.form, beside: r(".nt-pane").left >= r(".nt-listbox").right - 1, inside: r(".nt-pane").bottom <= card.bottom + 0.5 && r(".nt-pane").right <= card.right + 0.5 && r(".nt-listbox").bottom <= card.bottom + 0.5,
        metas: [...c.querySelectorAll(".hc-note-row .hc-meta")].filter((m) => m.checkVisibility()).length, rows: c.querySelectorAll(".hc-note-row").length, bar: [...c.querySelectorAll(".nt-format button")].map((b) => b.dataset.cmd), tools: [...c.querySelectorAll(".hc-note-tools button")].map((b) => b.className.replace(/hc-btn|hc-icon/g, "").trim()),
        listScrolls: getComputedStyle(list).overflowY === "auto" && list.scrollHeight > list.clientHeight, bodyScrolls: getComputedStyle(body).overflowY === "auto" && body.scrollHeight > body.clientHeight, height: card.height, cardCut: c.scrollHeight > c.clientHeight + 1 }; }, CARD);
    assert.equal(l.form, "l"); assert.equal(l.beside, true); assert.equal(l.inside, true); assert.equal(l.metas, 0, "titles only"); assert.equal(l.rows, 14);
    assert.deepEqual(l.bar, ["bold", "italic", "ul", "ck"]); assert.deepEqual(l.tools, ["hc-note-pin", "nt-lock", "nt-more"]);
    assert.equal(l.listScrolls, true); assert.equal(l.bodyScrolls, true, "a long note scrolls in its own half"); assert.ok(l.height < 340, `a 2×2 block, whatever the notes (${l.height})`); assert.equal(l.cardCut, false);
    assert.deepEqual(await flaws(p, CARD), []);
    await p.click(`${CARD} .nt-more`); await x.rest(150);
    assert.ok((await p.locator(".nt-menu .dgc-menu-label").allInnerTexts()).includes("Open in an editor tab"), "for room");
    await p.keyboard.press("Escape"); await x.rest(150);
    // And the way to the whole app (folders in a rail, Recently deleted) is on the card.
    assert.equal(await p.locator(`${CARD} .nt-footbox`).innerText().then((w) => w.replace(/\s+/g, " ")), "14 notes · 3 folders Open Notes");
    await p.click(`${CARD} .nt-more`); await x.rest(150);
    assert.deepEqual(await flaws(p, CARD), [], "with its menu open");
    await p.keyboard.press("Escape"); await x.rest(150); await p.click(`${CARD} .nt-openapp`); await x.rest(300);
    assert.equal((await x.grid()).open?.id, "note"); assert.equal(await p.evaluate((sel) => document.querySelector(sel).dataset.notes, OPEN), "wide");
  } finally { await x.close(); }
});

test("the Large card with a locked note: the whole PIN pad shows in its half (nothing of it cut), and the number keys open the note in place", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(300), p = x.page;
  try {
    await p.click(CARD, { position: { x: 30, y: 90 } }); await x.rest(250); await p.click(`${OPEN} .hc-note-row[data-note="wifi01"]`); await x.rest(300);
    await p.click(`${OPEN} .nt-lock`); await x.rest(200); await type(x, "4821", 150); await type(x, "4821", 600);
    await p.keyboard.press("Control+Alt+l"); await x.rest(300); await p.keyboard.press("Escape"); await x.rest(150); await p.keyboard.press("Escape"); await x.rest(250);
    await x.resize(700); await p.click(`${CARD} .hc-note-row[data-note="wifi01"]`); await x.rest(300);
    const fit = await p.evaluate((sel) => { const c = document.querySelector(sel), body = c.querySelector(".nt-body").getBoundingClientRect(), keys = [...c.querySelectorAll(".nt-pad button")].map((b) => b.getBoundingClientRect()), forgot = c.querySelector('[data-pin="forgot"]').getBoundingClientRect();
      return { keys: keys.length, inside: keys.every((k) => k.bottom <= body.bottom + 0.5 && k.top >= body.top - 0.5 && k.height >= 18), forgot: forgot.bottom <= body.bottom + 0.5, words: c.querySelector(".nt-lockbox").innerText.replace(/\s+/g, " ") }; }, CARD);
    assert.equal(fit.keys, 11); assert.equal(fit.inside, true, "every key of the pad is in sight"); assert.equal(fit.forgot, true, "and Forgot PIN? under it");
    assert.match(fit.words, /^Type your 4-digit PIN to open it\./); assert.equal(await p.getAttribute(`${CARD} .hc-note-row.on`, "data-note"), "wifi01", "its name is on the lit row beside the pad");
    assert.deepEqual(await flaws(p, CARD), []);
    await p.click(`${CARD} .nt-pad`); await type(x, "4821", 600);
    assert.match(await p.locator(`${CARD} .nt-doc`).innerText(), /The router is under the stairs/);
  } finally { await x.close(); }
});

test("opened: one thing at a time under about 560 px, three columns from there; dragging the side bar's edge with a note being typed in keeps the note, its words and the keyboard", async (t) => {
  if (skipOrFail(t)) return;
  const x = await grid(300), p = x.page;
  try {
    await p.click(CARD, { position: { x: 30, y: 90 } }); await x.rest(250);
    const mode = () => p.evaluate((sel) => document.querySelector(sel).dataset.notes, OPEN);
    // (560 px of Home itself: the side bar is a little wider than what it holds.)
    const home = () => p.evaluate(() => document.getElementById("home-hub").clientWidth);
    assert.equal(await mode(), "list"); await x.resize(540); assert.ok((await home()) < 560); assert.equal(await mode(), "list"); await x.resize(600); assert.ok((await home()) >= 560); assert.equal(await mode(), "wide");
    await x.resize(300); await p.click(`${OPEN} .hc-note-row[data-note="seeds1"]`); await x.rest(300); assert.equal(await mode(), "note");
    await p.click(`${OPEN} .nt-doc`); await p.keyboard.press("Control+End"); await p.keyboard.type(", and dill"); await x.rest(60);
    await x.resize(760);
    assert.equal(await mode(), "wide");
    assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /sweet peas, and dill/); assert.equal(await p.getAttribute(`${OPEN} .hc-note-row.on`, "data-note"), "seeds1", "the same note, lit in the list");
    assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true, "the keyboard is still in the note");
    await p.keyboard.type("!"); await x.rest(900);
    assert.equal(await x.notes.text("seeds1"), "Seeds for spring\nTomatoes, basil, sweet peas, and dill!");
    await x.resize(300); assert.equal(await mode(), "note"); assert.match(await p.locator(`${OPEN} .nt-doc`).innerText(), /and dill!/);
    // The PIN pad keeps the keyboard across the change too.
    await p.click(`${OPEN} .nt-lock`); await x.rest(200); assert.equal(await p.evaluate(() => !!document.activeElement?.closest(".nt-pad")), true);
    await x.resize(760); assert.equal(await p.evaluate(() => !!document.activeElement?.closest(".nt-pad")), true, "the number keys still type the PIN");
    await type(x, "12", 100); assert.equal(await p.locator(`${OPEN} .nt-dots i.on`).count(), 2);
  } finally { await x.close(); }
});

test("the palette's “DGC: New Note” (no key of its own): Home comes forward with Notes on it and a new note ready to type", async (t) => {
  const pkg = JSON.parse(readFileSync(root + "package.json", "utf8")), command = pkg.contributes.commands.find((c) => c.command === "dgc.newNote");
  assert.deepEqual(command, { command: "dgc.newNote", title: "New Note", category: "DGC" });
  assert.equal((pkg.contributes.keybindings || []).some((k) => k.command === "dgc.newNote"), false, "no default key: Ctrl+Alt+N belongs to other extensions");
  assert.match(readFileSync(root + "src/extension.ts", "utf8"), /registerCommand\("dgc\.newNote"/);
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["clock", "token"], seed: sample(), tab: "work" }), p = x.page;
  try {
    assert.equal((await x.tabs()).tabs.find((tab) => tab.selected).id, "work");
    await x.send({ type: "homeNewNote" }); await x.rest(400);
    assert.equal((await x.tabs()).tabs.find((tab) => tab.selected).id, "home");
    assert.deepEqual((await x.host()).order, ["clock", "token", "note"], "Notes is put on Home when it was not there");
    assert.equal((await x.grid()).open?.id, "note"); assert.equal(await p.evaluate(() => document.activeElement?.classList.contains("nt-doc")), true);
    await p.keyboard.type("From the palette"); await x.rest(900);
    assert.equal((await x.notes.list()).some((n) => n.title === "From the palette"), true);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`the opened app keeps the look in every scene, ${width} px ${theme}: the list, a menu, a question, a note being formatted, the link field, the PIN pad, a wrong PIN, Forgot PIN, Recently deleted`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await grid(300, { theme, height: 820 }), p = x.page, wide = width >= 560;
    const check = async (scene) => assert.deepEqual(await flaws(p, OPEN), [], scene);
    try {
      await p.click(CARD, { position: { x: 30, y: 90 } }); await x.rest(250); if (wide) await x.resize(width, 820);
      await check("the list");
      if (wide) { await p.click(`${OPEN} .nt-sort`); await x.rest(200); await check("the sort menu"); await p.keyboard.press("Escape"); await x.rest(150); await p.click(`${OPEN} .nt-newfold`); }
      else { await p.click(`${OPEN} .nt-folder`); await x.rest(200); await check("the folder menu"); await p.locator(".nt-menu .dgc-menu-row", { hasText: "New folder…" }).click(); }
      await x.rest(200); await check("a question"); await p.keyboard.press("Escape"); await x.rest(150);
      await p.fill(`${OPEN} input.hc-note-find`, "ferry"); await x.rest(450); await check("search, with the found words marked"); await p.fill(`${OPEN} input.hc-note-find`, ""); await x.rest(250);
      await p.click(`${OPEN} .hc-note-row[data-note="ferry1"]`); await x.rest(300); await p.click(`${OPEN} .nt-doc b`); await x.rest(150); await check("a note, formatted");
      await p.keyboard.press("Control+k"); await x.rest(200); await check("the link field"); await p.keyboard.press("Escape"); await x.rest(150);
      await p.click(`${OPEN} .nt-more`); await x.rest(200); await check("the note's menu"); await p.keyboard.press("Escape"); await x.rest(150);
      await p.click(`${OPEN} .nt-lock`); await x.rest(200); await check("choose a PIN"); await type(x, "4821", 150); await type(x, "4821", 600);
      await p.keyboard.press("Control+Alt+l"); await x.rest(300); await check("the PIN pad");
      await type(x, "0000", 500); await check("a wrong PIN");
      await p.click(`${OPEN} .nt-lockbox [data-pin="forgot"]`); await x.rest(200); await check("Forgot PIN");
      await p.click(`${OPEN} .nt-lockbox [data-pin="forgot-next"]`); await x.rest(200); await check("Forgot PIN, asked once more"); await p.click(`${OPEN} .nt-lockbox [data-pin="retry"]`); await x.rest(200);
      if (wide) await p.click(`${OPEN} .nt-fold[data-folder="bin"]`); else { await p.click(`${OPEN} .hc-note-all`); await x.rest(200); await p.click(`${OPEN} .nt-folder`); await x.rest(150); await p.locator(".nt-menu .dgc-menu-row", { hasText: "Recently deleted" }).click(); }
      await x.rest(250); await check("Recently deleted");
      await p.click(`${OPEN} .nt-empty`); await x.rest(200); await check("Empty now, asked first");
    } finally { await x.close(); }
  });
}
