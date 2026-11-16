// ChatDGC's Edit on a queued message asks before replacing a draft in the box (Keep draft / Replace draft; the replaced
// draft is one Undo away), the same as Work and a Pip's chat. In real Chromium on ChatDGC's real page.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs } from "./support/uir2a-scene.mjs";
import { openChatQueue } from "./support/uir2c-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

for (const width of [300, 440, 700]) {
  test(`ChatDGC: Edit on a queued message asks before replacing a draft; Keep keeps both, Replace puts the message in the box, Undo brings the draft back (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChatQueue(browser, { width, queued: ["And the budget?", "And the weather in May?"], draft: "half a thought" });
    try {
      await x.edit(0);
      let b = await x.box();
      assert.match(b.ask, /The box has a draft\. Replace it with this message\?/, "the row asks first");
      assert.deepEqual(b.buttons, ["Keep draft", "Replace draft"]);
      assert.deepEqual([b.text, b.rows], ["half a thought", ["And the budget?", "And the weather in May?"]], "the draft and the queue are untouched while it asks");
      assert.equal(b.fits, true, "the question and its two buttons are inside the queue's panel");
      await x.answer("ask-keep"); b = await x.box();
      assert.deepEqual([b.ask, b.text, b.rows], ["", "half a thought", ["And the budget?", "And the weather in May?"]], "Keep draft: nothing changes");
      await x.edit(0); await x.page.keyboard.press("Escape"); b = await x.box();
      assert.deepEqual([b.ask, b.text, b.rows.length], ["", "half a thought", 2], "Escape keeps the draft too");
      await x.edit(0); await x.answer("ask-replace"); b = await x.box();
      assert.deepEqual([b.ask, b.text, b.rows], ["", "And the budget?", ["And the weather in May?"]], "Replace draft: the message is in the box, by itself, and out of the queue");
      assert.equal(b.focus, true, "and the box has the caret");
      await x.page.keyboard.press("Control+z"); b = await x.box();
      assert.equal(b.text.trim(), "half a thought", "Undo brings the draft back");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("ChatDGC: with an empty box Edit asks nothing: the message goes straight back to the box", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChatQueue(browser, { queued: ["And the budget?"] });
  try { await x.edit(0); const b = await x.box(); assert.deepEqual([b.ask, b.text, b.rows], ["", "And the budget?", []]); } finally { await x.page.close(); }
});
