// Every mark sits in the middle of what it stands beside (asked 12 Nov: "all the icons must sit in the centre
// vertically"; a Pip's computer menu drew each Portal on the name's line, above the middle of its two-line row).
// The marks: Mote, Voxel, Folio, Portal (media/shared/marks.js) and the artifact file sheet (media/shared/filesheet.js).
// Each surface is opened in real Chromium at 700 and 300 px, dark and light (test/support/marks-centred-scene.mjs):
// a mark beside words has its vertical centre within 1 px of the centre of that block of words, both lines of a
// two-line row; a mark alone in a dock tile or a colour swatch is centred in it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { eachSurface, measure, SURFACES } from "./support/marks-centred-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
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

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`every mark is centred on what it stands beside, ${theme} ${width}px`, async (t) => {
    if (skipOrFail(t)) return;
    const seen = [], off = [];
    const errors = await eachSurface(browser, { width, theme }, async (name, page, scope, mode) => {
      const marks = await page.evaluate(measure, [scope, mode]);
      seen.push([name, marks.length > 0]);
      for (const m of marks) if (m.off === null || Math.abs(m.off) > 1) off.push(`${name}: a ${m.mark} of ${m.size}px is ${m.off === null ? "beside no words" : `${m.off}px ${m.off < 0 ? "above" : "below"} the middle of ${m.beside} (${m.lines} lines)`}`);
    });
    assert.deepEqual(seen, SURFACES.map((name) => [name, true]), "every surface was opened and shows its marks");
    assert.deepEqual([...new Set(off)], [], "each mark's centre is within 1px of the centre of the words beside it");
    assert.deepEqual(errors, []);
  });
}
