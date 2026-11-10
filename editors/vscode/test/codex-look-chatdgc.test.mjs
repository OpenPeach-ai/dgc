// ChatDGC in the 0.52 look, in real Chromium on the real chat page: your prompt is a quiet raised grey with no light or
// grain, the prompt box has the 22 px corner on a ground a step off the page with its own soft edge, the answer's link
// keeps the purple, and the button where Send is stays the one purple fill. Dark and light, 700 and 300 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull, isPurple, look, tokenColours } from "./support/look-probe.mjs";

const chromium = await chromiumOrNull();
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

import { openChatDgc } from "./support/codex-look-scene.mjs";

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`a chat: grey bubbles, a 22px prompt box, purple only on the link and where Send is (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChatDgc(browser, { theme, width });
    try {
      const token = await tokenColours(x.page, ["--bubble", "--box", "--accent-fill", "--link"]);
      const bubble = await look(x.page, ".cd-user .cd-bubble");
      assert.equal(bubble.fill, token["--bubble"], "the sent prompt is the shared grey");
      assert.equal(isPurple(bubble.fill), false);
      assert.deepEqual([bubble.image, bubble.grain], ["none", "none"], "no light and no grain on it");
      const box = await look(x.page, "#cd-box");
      assert.equal(box.corner, "22px");
      assert.equal(box.fill, token["--box"], "the prompt box's own ground");
      assert.notEqual(box.shadow, "none", "with its soft edge");
      assert.equal(isPurple(box.line), false);
      assert.equal((await look(x.page, ".cd-assistant .md-link")).words, token["--link"], "a link in an answer keeps the purple");
      const filled = await x.page.evaluate(() => [...document.querySelectorAll("body *")].filter((n) => n.checkVisibility()).map((n) => { const r = n.getBoundingClientRect(); return { n: n.id || String(n.className), c: getComputedStyle(n).backgroundColor, w: r.width, h: r.height }; }));
      assert.deepEqual(filled.filter((m) => isPurple(m.c) && m.w > 12).map((m) => m.n), ["cd-voicemode"], "one purple fill: the button where Send is");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}
