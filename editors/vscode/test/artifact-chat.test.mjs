// Artifacts in ChatDGC (media/chatdgc.js) and the Library's Artifacts tab (media/library.js), in real Chromium: the
// Output chip in the chat's box, a reply's artifact cards (live and after a reload), the note under a reply that
// didn't make what was asked, and the Library's list, filters and actions.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { ITEMS, M, OFFER, conversation, openChat, openLibrary } from "./support/chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const DECK = { id: ITEMS[0].id, type: "slides", label: "Slides", title: "Q3 plan", version: 1, op: "made", at: 0 };
const SHEET = { id: ITEMS[1].id, type: "sheet", label: "Spreadsheet", title: "Home budget", version: 2, op: "changed", at: 0 };
const reply = (extra = {}) => ({ id: M(2), role: "assistant", text: "Here's the deck: six slides on the Q3 plan.", finish: "stop", created_at: "2026-10-28T08:40:00Z", ...extra });

test("the Output chip: hidden without the capability, chosen by keyboard, sent once, then Auto again", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat(browser);
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    assert.equal(await s.page.locator("#cd-output-wrap").isHidden(), true, "no capability, no chip");
    await s.send({ type: "artifacts", offered: OFFER });
    assert.equal(await s.page.locator("#cd-output").isVisible(), true);
    assert.equal(await s.page.locator("#cd-output-label").textContent(), "Output");
    await s.page.focus("#cd-output");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.page.locator("#cd-output-menu [data-output]").evaluateAll((r) => r.map((n) => n.dataset.output)),
      ["auto", "document", "slides", "spreadsheet", "page", "dashboard"]);
    await s.page.keyboard.press("End");
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#cd-output-label").textContent(), "Output: Dashboard");
    assert.equal(await s.page.locator("#cd-output").getAttribute("aria-pressed"), "true");
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "cd-output");
    await s.page.fill("#cd-input", "Chart my store's sales");
    await s.page.keyboard.press("Enter");
    const [send] = await s.posted("send");
    assert.equal(send.output, "dashboard");
    assert.equal(await s.page.locator("#cd-output-label").textContent(), "Output", "Auto again, as Deep research turns off");
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "message", message: reply() });
    await s.send({ type: "turn", state: "ended" });
    await s.page.evaluate(() => { window.__posted = []; });
    await s.page.fill("#cd-input", "Thanks");
    await s.page.keyboard.press("Enter");
    const sends = await s.posted("send");
    assert.equal(sends.length, 1, "the next message goes");
    assert.equal("output" in sends[0], false, "Auto is never sent");
    await s.send({ type: "artifacts", offered: null });
    assert.equal(await s.page.locator("#cd-output-wrap").isHidden(), true, "and gone with a backend that doesn't offer it");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a reply's artifacts are cards that survive a reload: Open, Export over its own formats, what it is now", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat(browser, { width: 760 });
  try {
    await s.send({ type: "artifacts", offered: OFFER });
    // A reload: the chat comes back from disk, its reply's cards with it.
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Make me a Q3 deck and a budget", created_at: "2026-10-28T08:39:00Z" },
      reply({ artifacts: [DECK, SHEET], output_note: "The model didn't make a dashboard. Try again, or pick another model for this reply." })] });
    assert.deepEqual(await s.posted("artifactViews"), [{ type: "artifactViews" }], "it asks what each one is now");
    const cards = s.page.locator(".cd-artifact");
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.nth(0).locator(".cd-file-name").textContent(), "Q3 plan");
    assert.equal(await cards.nth(0).locator(".cd-file-meta").textContent(), "Slides · made · version 1");
    assert.equal(await cards.nth(1).locator(".cd-file-meta").textContent(), "Spreadsheet · changed · version 2");
    assert.equal(await s.page.locator(".cd-output-note").textContent(), "The model didn't make a dashboard. Try again, or pick another model for this reply.");
    const badge = await cards.nth(0).locator(".cd-file-badge").evaluate((n) => getComputedStyle(n).opacity);
    assert.equal(badge, "1", "a card that isn't removed isn't dimmed (.cd-file[data-removed] matches on presence)");
    await cards.nth(0).locator("button:has-text('Open')").click();
    assert.deepEqual(await s.posted("artifactOpen"), [{ type: "artifactOpen", id: DECK.id, artifactType: "slides", title: "Q3 plan" }]);
    await cards.nth(1).locator(".cd-artifact-export-button").click();
    assert.deepEqual(await cards.nth(1).locator(".cd-artifact-menu-item").allTextContents(), ["Excel workbook (.xlsx)", "CSV (first sheet)"]);
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted("artifactExport"), [{ type: "artifactExport", id: SHEET.id, format: "csv", artifactType: "sheet", title: "Home budget", exports: ["xlsx", "csv"] }]);
    // What each one is now: the deck was edited since (version 3), the sheet was removed.
    await s.send({ type: "artifactViews", items: [{ ...ITEMS[0], version: 3, title: "Q3 plan (final)" }] });
    assert.equal(await cards.nth(0).locator(".cd-file-name").textContent(), "Q3 plan (final)");
    assert.equal(await cards.nth(0).locator(".cd-file-meta").textContent(), "Slides · made here as version 1 · now version 3");
    assert.match(await cards.nth(1).locator(".cd-file-meta").textContent(), /removed: it's in DGC's trash, where it can be recovered/);
    assert.equal(await cards.nth(1).locator("button").count(), 0, "nothing to open");
    assert.equal(await cards.nth(1).locator(".cd-file-badge").evaluate((n) => getComputedStyle(n).opacity), "0.45");
    // Live: a change made anywhere.
    await s.send({ type: "artifactChanged", artifact: { ...ITEMS[0], version: 4, title: "Q3 plan (final)" }, op: "changed" });
    assert.match(await cards.nth(0).locator(".cd-file-meta").textContent(), /version 4/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a reply that is still being written shows its cards as they come, and no note until it ends", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat(browser);
  try {
    await s.send({ type: "artifacts", offered: OFFER });
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "message", message: reply({ artifacts: [DECK] }) });
    assert.equal(await s.page.locator(".cd-artifact").count(), 1);
    assert.equal(await s.page.locator(".cd-output-note").count(), 0);
  } finally { await s.page.close(); }
});

test("the Library's Artifacts tab: only when offered, newest first, by kind and by where it was made", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openLibrary(browser);
  try {
    await s.send({ type: "widgetsOffered", on: false });
    await s.send({ type: "artifactsOffered", on: false });
    assert.equal(await s.page.locator("#lib-views").isHidden(), true, "no tabs without a second view");
    await s.send({ type: "artifactsOffered", on: true });
    assert.deepEqual(await s.page.locator("#lib-views .lib-view").allTextContents(), ["Files", "Artifacts"]);
    await s.page.click("#lib-views .lib-view:has-text('Artifacts')");
    assert.deepEqual((await s.posted("artifactList")).length, 1);
    await s.send({ type: "artifacts", items: [...ITEMS].reverse() });
    const names = () => s.page.locator(".lib-artifact .lib-name").allTextContents();
    assert.deepEqual(await names(), ["Q3 plan", "Home budget", "Store sales", "Tip calculator", "Launch notes"], "newest change first");
    assert.match(await s.page.locator(".lib-artifact .lib-meta").first().textContent(), /^Slides · version 3 · made in Chat · /);
    const chip = (bar, value) => s.page.locator(`#${bar} .lib-kind[data-value="${value}"]`);
    assert.deepEqual(await s.page.locator("#lib-kinds .lib-kind").allTextContents(), ["All5", "Documents1", "Slides1", "Spreadsheets1", "Pages1", "Dashboards1"]);
    assert.deepEqual(await s.page.locator("#lib-made .lib-kind").allTextContents(), ["Anywhere5", "Chat2", "Work2", "Pips1"]);
    await chip("lib-made", "work").click();
    assert.deepEqual(await names(), ["Home budget", "Tip calculator"]);
    assert.equal(await chip("lib-made", "work").getAttribute("aria-pressed"), "true");
    await chip("lib-kinds", "page").click();
    assert.deepEqual(await names(), ["Tip calculator"]);
    await chip("lib-made", "").click();
    await chip("lib-kinds", "").click();
    await s.page.fill("#lib-search", "budget");
    await s.page.waitForTimeout(320);
    assert.deepEqual(await names(), ["Home budget"], "searched by name");
    await s.page.fill("#lib-search", "");
    await s.page.waitForTimeout(320);
    const row = s.page.locator('.lib-artifact[data-type="dashboard"]');
    await row.locator('[aria-label="Open it"]').click();
    assert.equal((await s.posted("artifactOpen"))[0].artifact.id, ITEMS[2].id);
    await row.locator('[aria-label="Export…"]').click();
    assert.deepEqual(await row.locator(".lib-menu-item").allTextContents(), ["Web page (.html)"], "a dashboard's one format");
    await row.locator(".lib-menu-item").click();
    assert.deepEqual((await s.posted("artifactExport")).map((m) => [m.artifact.id, m.format]), [[ITEMS[2].id, "html"]]);
    await row.locator('[aria-label^="Remove"]').click();
    const [remove] = await s.posted("artifactRemove");
    assert.equal(remove.artifact.id, ITEMS[2].id, "Remove asks the host, which asks you first");
    assert.equal(await row.count(), 1, "still listed until you said yes");
    await s.send({ type: "artifactRemoved", id: ITEMS[2].id });
    assert.equal(await row.count(), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("at 360px nothing runs off the edge: the Library's rows and the chat's Output menu", async (t) => {
  if (skipOrFail(t)) return;
  const lib = await openLibrary(browser, { width: 360 });
  try {
    await lib.send({ type: "widgetsOffered", on: true });
    await lib.send({ type: "artifactsOffered", on: true });
    await lib.page.click("#lib-views .lib-view:has-text('Artifacts')");
    await lib.send({ type: "artifacts", items: ITEMS });
    const wide = await lib.page.evaluate(() => [...document.querySelectorAll("body *")].filter((n) => n.getBoundingClientRect().right > window.innerWidth + 1).map((n) => n.className));
    assert.deepEqual(wide, [], "every row and its actions within reach");
  } finally { await lib.page.close(); }
  const s = await openChat(browser, { width: 360 });
  try {
    await s.send({ type: "artifacts", offered: OFFER });
    await s.send({ type: "opened", conversation: conversation(), messages: [{ id: M(1), role: "user", text: "Hi" }, reply()], earlier: 0, busy: false });
    await s.page.click("#cd-output");
    const box = await s.page.locator("#cd-output-menu").boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 360 && box.y >= 0, `the menu is on screen (${JSON.stringify(box)})`);
    await s.page.click('#cd-output-menu [data-output="spreadsheet"]');
    const chip = await s.page.locator("#cd-output").boundingBox();
    const form = await s.page.locator("#cd-box").boundingBox();
    assert.ok(chip.x + chip.width <= form.x + form.width, "the chosen chip stays inside the box");
    assert.equal(await s.page.locator("#cd-output .cd-tool-label").innerText(), "Spreadsheet", "narrow: the choice, without its prefix");
  } finally { await s.page.close(); }
});
