// One × for every line that stays, painted (media/shared/dismiss.js; the piece itself is in dismiss-lines.test.mjs).
// On each surface a real message is made the way its page gets one, and then: the line has the one ×, a 26px box with
// the 6px corner inside its line and inside the window, its words keep clear of it, nothing scrolls sideways; a
// click closes that line and leaves the focus on something; and the next message shows again. Both themes, at the
// side bar's 300, 440 and an editor tab's 700. DGC_PICTURES_DIR=<folder> also writes the pictures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { READY } from "./support/dgc-look-scene.mjs";
import { openSettings } from "./support/settings-scene.mjs";
import { openOnePips } from "./support/one-pips-scene.mjs";
import { openLibraryTab, openLibraryPage } from "./support/library-scene.mjs";
import { openDock } from "./support/dock-scene.mjs";
import { openPanel } from "./support/artifact-scene.mjs";

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
after(async () => { await browser?.close(); });

const PICTURES = process.env.DGC_PICTURES_DIR || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });
const shot = async (page, name) => { if (PICTURES) await page.screenshot({ path: `${PICTURES}/${name}.png` }); };

/** The line `sel` names (in the page or in a shadow root), with its ×, measured. */
const lineNow = (page, sel) => page.evaluate((q) => {
  const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
  const line = roots.flatMap((r) => [...r.querySelectorAll(q)]).find((n) => n.checkVisibility());
  if (!line) return { shown: false, closed: roots.some((r) => [...r.querySelectorAll(q)].some((n) => n.hasAttribute("data-dgc-dismissed"))) };
  const x = line.querySelector(":scope > .dgc-dismiss") || line.parentElement.querySelector(":scope > .dgc-dismiss");
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  // Where the line's own words end (the last text before the ×).
  const range = document.createRange(); let wordsRight = 0, wordsTop = Infinity;
  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) { if (!t.nodeValue.trim() || t.parentElement.closest(".dgc-dismiss") || !t.parentElement.checkVisibility()) continue; range.selectNodeContents(t); for (const r of range.getClientRects()) { if (r.width < 1) continue; wordsTop = Math.min(wordsTop, r.top); if (r.top < (x ? x.getBoundingClientRect().bottom : 0) && r.bottom > (x ? x.getBoundingClientRect().top : 0)) wordsRight = Math.max(wordsRight, r.right); } }
  const s = x ? getComputedStyle(x) : null;
  return { shown: true, words: line.textContent.replace(/\s+/g, " ").trim(), line: box(line), wordsRight,
    x: x ? { ...box(x), title: x.title, name: x.getAttribute("aria-label"), tag: x.tagName, type: x.type, radius: s.borderTopLeftRadius, glyph: x.querySelector("svg")?.dataset.icon || "", color: s.color } : null,
    wide: innerWidth, sideways: document.documentElement.scrollWidth > innerWidth + 1 };
}, sel);
/** Clicks the × of the line `sel` names, as a person does, and says where the focus went. */
async function closeLine(page, sel) {
  const at = await page.evaluateHandle((q) => {
    const roots = [document]; for (const n of document.querySelectorAll("*")) if (n.shadowRoot) roots.push(n.shadowRoot);
    const line = roots.flatMap((r) => [...r.querySelectorAll(q)]).find((n) => n.checkVisibility());
    return line.querySelector(":scope > .dgc-dismiss") || line.parentElement.querySelector(":scope > .dgc-dismiss");
  }, sel);
  await at.asElement().click();
  await page.waitForTimeout(80);
  return page.evaluate(() => { let a = document.activeElement; while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement; return { tag: a?.tagName || "", id: a?.id || "", body: !a || a === document.body, cls: a?.className || "" }; });
}
function theOne(m, what) {
  assert.ok(m.shown, `${what}: the line shows`);
  assert.ok(m.x, `${what}: it has a ×`);
  assert.equal(m.x.tag, "BUTTON"); assert.equal(m.x.type, "button");
  assert.equal(m.x.title, "Dismiss", `${what}: titled Dismiss`); assert.equal(m.x.name, "Dismiss this message", `${what}: named`);
  assert.equal(m.x.glyph, "close", `${what}: the Close glyph`);
  assert.ok(Math.abs(m.x.w - 26) < 0.6 && Math.abs(m.x.h - 26) < 0.6, `${what}: a 26px box (${m.x.w}x${m.x.h})`);
  assert.equal(m.x.radius, "6px", `${what}: the 6px corner`);
  assert.ok(m.x.left >= m.line.left - 1 && m.x.right <= m.line.right + 1, `${what}: inside its line, side to side (${m.x.left} to ${m.x.right} of ${m.line.left} to ${m.line.right})`);
  assert.ok(m.x.right <= m.wide && m.x.left >= 0, `${what}: inside the window`);
  assert.ok(m.wordsRight <= m.x.left + 1, `${what}: the words keep clear of it (${m.wordsRight} against ${m.x.left})`);
  assert.equal(m.sideways, false, `${what}: nothing scrolls sideways`);
}
const settled = (to, what) => assert.equal(to.body, false, `${what}: the focus is on something after closing (${to.tag}#${to.id})`);

const LOOKS = [["dark-modern", 700], ["light-modern", 700], ["dark-modern", 440], ["light-modern", 300]];
const GONE = "The model nope-9 isn’t available.";

for (const [theme, width] of LOOKS) {
  test(`Work: what went wrong in the transcript can be closed, one line at a time (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openWorkTab(browser, { width, theme });
    try {
      const event = (e) => x.send({ type: "event", event: e });
      await x.send({ type: "session_ready", sessionId: "s1" }); await event(READY);
      await event({ type: "error", message: "DGC couldn’t read the project’s rules: the file is not valid." });
      await event({ type: "error", message: "model 'nope-9' not found", cause: { kind: "model_not_found", summary: "model 'nope-9' not found", model: "nope-9", http_status: 404, attempts: 1 } });
      await x.page.waitForSelector("#log .model-error");
      await shot(x.page, `work-${theme}-${width}`);
      const plain = await lineNow(x.page, "#log .sys.err:not(.model-error)"), model = await lineNow(x.page, "#log .model-error");
      theOne(plain, "a plain error line"); theOne(model, "a model's error");
      const to = await closeLine(x.page, "#log .model-error");
      assert.equal(to.id, "input", "the focus goes to the message box");
      assert.equal((await lineNow(x.page, "#log .model-error")).shown, false, "that line is closed");
      assert.ok((await lineNow(x.page, "#log .sys.err:not(.model-error)")).shown, "the other one stays");
      // The same thing fails again: a new line, shown.
      await event({ type: "error", message: "model 'nope-9' not found", cause: { kind: "model_not_found", summary: "model 'nope-9' not found", model: "nope-9", http_status: 404, attempts: 1 } });
      theOne(await lineNow(x.page, "#log .model-error"), "the next one");
      await shot(x.page, `work-${theme}-${width}-after`);
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`ChatDGC: the notice over the message box can be closed, and the next one shows (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const chat = await import("./support/chat-scene.mjs");
    const x = await chat.openChat(browser, { width, height: 700, theme });
    try {
      await x.send({ type: "opened", conversation: chat.conversation({ title: "A week in Goa" }), earlier: 0, busy: false, messages: [] });
      await x.send({ type: "error", message: "ChatDGC couldn’t reach DGC. Try again in a moment." });
      await x.page.waitForSelector("#cd-notice:not([hidden])");
      await shot(x.page, `chatdgc-${theme}-${width}`);
      const m = await lineNow(x.page, "#cd-notice"); theOne(m, "the notice");
      assert.match(m.words, /couldn’t reach DGC/);
      const to = await closeLine(x.page, "#cd-notice");
      assert.equal(to.id, "cd-input", "the focus goes to the message box");
      assert.equal((await lineNow(x.page, "#cd-notice")).shown, false);
      await x.send({ type: "error", message: "ChatDGC couldn’t reach DGC. Try again in a moment." });
      theOne(await lineNow(x.page, "#cd-notice"), "the same failure again");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

for (const [theme, width] of [["dark", 900], ["light", 440]]) {
  test(`Settings: a page's banner can be closed; a question to confirm keeps its own answers (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openSettings(browser, { theme, width, section: "memory" });
    try {
      const say = (m) => x.page.evaluate((d) => window.postMessage(d, "*"), m);
      await say({ type: "memory_unavailable", message: "DGC couldn’t reach what it remembers: the local service didn’t answer." });
      await x.page.waitForSelector(".banner.error");
      await shot(x.page, `settings-${theme}-${width}`);
      theOne(await lineNow(x.page, ".banner.error"), "the banner");
      settled(await closeLine(x.page, ".banner.error"), "the banner");
      assert.equal((await lineNow(x.page, ".banner.error")).shown, false);
      // The page draws itself again with the same words: still closed. Different words: shown.
      await say({ type: "memory_unavailable", message: "DGC couldn’t reach what it remembers: the local service didn’t answer." }); await x.rest();
      assert.equal((await lineNow(x.page, ".banner.error")).shown, false, "the same words drawn again stay closed");
      await say({ type: "memory_unavailable", message: "The memory file couldn’t be read." }); await x.rest();
      theOne(await lineNow(x.page, ".banner.error"), "a different message");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

for (const [theme, width] of [["dark-modern", 300], ["light-modern", 440]]) {
  test(`the side bar: a list that couldn't be read, and the Library's, can be closed (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab: "work", width, theme });
    try {
      await x.page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "sessions_list", items: [], error: "DGC didn’t answer, so your sessions aren’t listed. Reload the window to try again." } })));
      await x.page.waitForSelector('#sessions-status[data-kind="error"]');
      await shot(x.page, `sidebar-work-${theme}-${width}`);
      theOne(await lineNow(x.page, "#sessions-status"), "the Work list's line");
      settled(await closeLine(x.page, "#sessions-status"), "the Work list's line");
      assert.equal((await lineNow(x.page, "#sessions-status")).shown, false);
      // The list is read, and is empty: the line says so, with no × (it is not a warning).
      await x.page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "sessions_list", items: [] } })));
      const empty = await lineNow(x.page, "#sessions-status");
      assert.ok(empty.shown, "the empty list's line shows again"); assert.equal(empty.x, null, "and has no ×");
    } finally { await x.page.close(); }
    const lib = await openLibraryTab(browser, { width, theme });
    try {
      await lib.page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "sideLibrary", message: { type: "error", message: "The Library couldn’t be read: DGC didn’t answer." } } })));
      await lib.page.waitForSelector('#library-status[data-kind="error"]:not([hidden])');
      await shot(lib.page, `sidebar-library-${theme}-${width}`);
      theOne(await lineNow(lib.page, "#library-status"), "the Library's line");
      const to = await closeLine(lib.page, "#library-status");
      assert.equal(to.id, "library-search", "the focus goes to the Library's search");
      assert.equal((await lineNow(lib.page, "#library-status")).shown, false);
    } finally { await lib.page.close(); }
  });
}

test("the Library in its own tab: the same line, the same ×", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryPage(browser, { width: 700, theme: "light-modern" });
  try {
    await x.send({ type: "error", message: "The Library couldn’t be read: DGC didn’t answer." });
    await x.page.waitForSelector('#library-status[data-kind="error"]:not([hidden])');
    await shot(x.page, "library-tab-light-modern-700");
    theOne(await lineNow(x.page, "#library-status"), "the Library's line");
    settled(await closeLine(x.page, "#library-status"), "the Library's line");
    assert.equal((await lineNow(x.page, "#library-status")).shown, false);
  } finally { await x.close(); }
});

for (const [theme, width, where] of [["dark-modern", 300, "side"], ["light-modern", 700, "tab"]]) {
  test(`the Pips page: its own line wears the shared ×, and so does a section's (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const keep = { platform: "linux", supported: true, reason: "", on: false, starts_at_login: false, restarts_after_failure: false, while_logged_out: false };
    const x = await openOnePips(browser, { width, theme, where, scene: { answers: { get_pips_keep_running: { keep_running: keep },
      set_pips_keep_running: { error: { code: "busy", message: "The scoped unit file is installed, but the user service manager reload failed. Try again in a moment." } } } } });
    try {
      await x.waitIn("#runner-controls-toggle");
      await x.click("#runner-controls-toggle");
      await x.waitIn("#keep-running");
      await x.inPips((root) => { const box = root.querySelector("#keep-running"); box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); });
      await x.waitIn(".page-note .notice.error");
      // (The Controls menu lies over the top of the page while it is open: put away, as a person does, before the line is read.)
      await x.inPips((root) => { const menu = root.querySelector("details.runner-controls"); if (menu?.open) menu.open = false; });
      await x.page.waitForTimeout(150);
      await shot(x.page, `pips-page-${theme}-${width}`);
      const m = await lineNow(x.page, ".page-note");
      theOne(m, "the page's line"); assert.match(m.words, /service manager reload failed/);
      settled(await closeLine(x.page, ".page-note"), "the page's line");
      assert.equal(await x.inPips((root) => !!root.querySelector(".page-note")), false, "it goes");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("an artifact's page: a banner that only says something can be closed; one that asks keeps its answers", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPanel(browser, { width: 700, theme: "dark-modern", kind: "page" });
  try {
    assert.ok(await x.page.evaluate(() => !!window.DgcDismiss), "the page loads the shared piece");
    await x.send({ type: "copyFailed", message: "The page’s text couldn’t be copied: the editor refused the clipboard." });
    await x.page.waitForSelector("#art-banner:not([hidden])");
    await shot(x.page, "artifact-dark-modern-700");
    theOne(await lineNow(x.page, "#art-banner"), "the banner");
    settled(await closeLine(x.page, "#art-banner"), "the banner");
    assert.equal((await lineNow(x.page, "#art-banner")).shown, false);
    await x.send({ type: "copyFailed", message: "Not saved: DGC didn’t answer." });
    theOne(await lineNow(x.page, "#art-banner"), "the next one");
  } finally { await x.page.close(); }
});
