// A Pip's sub-agent with Work tools in its chat, in real Chromium (Pips API 109):
// the side bar's real page with the real Pips view, on the stand-in DGC (test/support/one-pips-scene.mjs,
// `sub`, `work`), at 300, 440 and 700 px, dark and light. Read from the DOM, computed style and geometry: the
// permission card's More is Work's icon button (6 px corner, a button height) and its menu row fits; "Work tools" beside
// the sub-agent's name is a quiet label, whole, in its row and in the agent map; the done card with Undo sits inside the
// chat with Undo in the button family's shape; nothing scrolls sideways. With DGC_PICTURES_DIR set, each case is also
// a picture there (the report's pictures come from this run).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";

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

const PICTURES = process.env.DGC_PICTURES_DIR || "";
if (PICTURES) mkdirSync(PICTURES, { recursive: true });
const picture = async (x, name, selector) => {
  if (!PICTURES) return;
  if (selector) await x.page.locator(selector).first().screenshot({ path: join(PICTURES, `${name}.png`) });
  else await x.page.screenshot({ path: join(PICTURES, `${name}.png`) });
};
const look = (x, selector) => x.inPips((root, s) => {
  const n = root.querySelector(s); if (!n) return null;
  const r = n.getBoundingClientRect(), c = getComputedStyle(n);
  return { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width * 10) / 10,
    height: Math.round(r.height * 10) / 10, radius: c.borderTopLeftRadius, shown: n.checkVisibility({ visibilityProperty: true }), cut: n.scrollWidth > n.clientWidth + 1, color: c.color };
}, selector);
const sideways = (x) => x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const open = async (o, scene) => { const x = await openOnePips(browser, { api: 109, height: 900, faces: true, ...o, scene: { sub: true, waiting: false, ...scene } }); await x.openPip(GST); return x; };
const inside = (b, log, what) => assert.ok(b && b.shown && b.left >= log.left - 1 && b.right <= log.right + 1, `${what} is inside the chat (${JSON.stringify(b)})`);
const button = (b, what, heights = [28]) => { assert.ok(b && b.shown, `${what} shows`); assert.equal(b.radius, "6px", `${what}: the family's corner`); assert.ok(heights.includes(b.height), `${what}: a button height (${b.height})`); assert.equal(b.cut, false, `${what} says its word whole`); };

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  const at = `${theme} at ${width}px`, name = `${theme.split("-")[0]}-${width}`;
  test(`${at}: the permission card's More is Work's icon button, and its one row fits`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme }, { fix: "ask" });
    try {
      await x.waitIn(".pip-ask-card .pip-ask-more");
      const card = await look(x, ".pip-ask-card"), more = await look(x, ".pip-ask-card .pip-ask-more");
      button(more, "More");
      assert.equal(more.width, more.height, "square, as Work's icon buttons");
      assert.ok(more.left >= card.left && more.right <= card.right, "inside the card");
      await x.click(".pip-ask-card .pip-ask-more"); await x.waitIn(".pip-ask-menu");
      const menu = await look(x, ".pip-ask-menu");
      assert.ok(menu.left >= card.left - 1 && menu.right <= card.right + 1, `the menu stays in the card (${JSON.stringify({ menu, card })})`);
      assert.equal((await look(x, ".pip-ask-menu .dgc-menu-label")).cut, false, "its label whole");
      assert.equal(await sideways(x), false);
      await picture(x, `ask-menu-${name}`, ".pip-ask-card");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${at}: "Work tools" beside its name in its row and in the agent map, whole and quiet`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme }, { fix: "running", work: true });
    try {
      await x.waitIn(".pip-agent-row .pip-agent-tag");
      const log = await look(x, ".conversation-log"), tag = await look(x, ".pip-agent-row .pip-agent-tag"), title = await look(x, ".pip-agent-row .pip-agent-name");
      inside(await look(x, ".pip-agent-row"), log, "its row");
      assert.equal(tag.cut, false, "Work tools, whole"); assert.equal(tag.radius, "6px", "Work's corner, never a pill");
      assert.ok(tag.height <= 20, `a quiet label (${tag.height})`); assert.ok(tag.left >= title.right - 1, "beside its name");
      await x.click("#chat-agents"); await x.waitIn(".pip-agent-map .am-agent .am-tag"); await x.page.waitForTimeout(120);
      const row = await look(x, ".pip-agent-map .am-agent"), mtag = await look(x, ".pip-agent-map .am-agent .am-tag");
      assert.equal(mtag.cut, false); assert.ok(mtag.right <= row.right, "inside its row of the map");
      assert.equal(await sideways(x), false);
      await picture(x, `agent-map-${name}`, ".pip-agent-map .agent-map");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${at}: the done message with Undo: the Pip's words, then what changed in your folder, Undo in the family's shape`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open({ width, theme }, { fix: "applied", work: true, level: "full" });
    try {
      await x.waitIn(".pip-change[data-work-done] [data-agent-undo]");
      const log = await look(x, ".conversation-log"), card = await look(x, ".pip-change[data-work-done]");
      inside(card, log, "the done card");
      button(await look(x, ".pip-change[data-work-done] [data-agent-undo]"), "Undo");
      assert.equal((await look(x, ".pip-change[data-work-done] .pip-change-title")).cut, false);
      await x.inPips((root) => root.querySelector(".pip-change[data-work-done]").scrollIntoView({ block: "end" }));
      await x.page.waitForTimeout(120);
      assert.equal(await sideways(x), false);
      await picture(x, `done-undo-${name}`);
      await x.click(".pip-change[data-work-done] [data-agent-undo]"); await x.waitIn('.pip-change[data-work-done][data-state="undone"]');
      inside(await look(x, '.pip-change[data-work-done][data-state="undone"]'), log, "the undone card");
      await x.inPips((root) => root.querySelector(".pip-change[data-work-done]").scrollIntoView({ block: "end" }));
      await x.page.waitForTimeout(120);
      await picture(x, `undone-${name}`, '.pip-change[data-work-done][data-state="undone"]');
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
