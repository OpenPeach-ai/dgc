// A Pip's page opens with its face, and Edit for the face under it: never on top of the face (asked 24 Nov, a picture:
// "the Edit button kind of overlaps with the pip's face"; it sat over the face's lower right, with a see-through fill).
// Real Chromium with the real Pips bundle, dark and light, in a tab and in the side bar.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

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

for (const [theme, width] of [["dark", 700], ["light", 300], ["dark", 460]]) {
  test(`${theme}, ${width} px: Edit is under the face, centred, clear of it`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, height: 900, theme, where: width > 400 ? "tab" : "side", api: 80, many: true, settings: true });
    try {
      await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
      await x.p.waitForSelector(".pip-page .pip-face-edit"); await x.p.waitForTimeout(300);
      const box = await x.p.evaluate(() => {
        const root = window.__pipsRoot || document, face = root.querySelector(".pip-page-head .avatar"), edit = root.querySelector(".pip-page-head .pip-face-edit");
        const r = (n) => { const q = n.getBoundingClientRect(); return { left: q.left, right: q.right, top: q.top, bottom: q.bottom }; };
        return { face: r(face), edit: r(edit), name: r(root.getElementById("pipPageName")) };
      });
      const { face, edit, name } = box;
      const overlap = Math.max(0, Math.min(face.right, edit.right) - Math.max(face.left, edit.left)) * Math.max(0, Math.min(face.bottom, edit.bottom) - Math.max(face.top, edit.top));
      assert.equal(overlap, 0, `Edit is clear of the face: ${JSON.stringify(box)}`);
      assert.ok(edit.top >= face.bottom, "under it");
      assert.ok(Math.abs((edit.left + edit.right) / 2 - (face.left + face.right) / 2) <= 1, "centred under it");
      assert.ok(name.top >= edit.bottom, "the name comes after it");
    } finally { await x.close?.(); }
  });
}
