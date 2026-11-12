// A goal's end line, the Goals pill and its list, in real Chromium on Work's own page, dark and light, at 700 and
// 300 px: the line sits under the goal's last reply inside the chat's column and reads at 4.5:1; the pill is on the
// bar; the list stays inside its popover and the window, names and facts never run under Trace, and Trace reads whole.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { END_LINE, measureGoals, openGoals } from "./support/goal-history-scene.mjs";

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

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`${theme} ${width}px: the goal's end line is under its last reply, inside the chat, and readable`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGoals(browser, { width, theme });
    try {
      const m = await measureGoals(x.page);
      assert.ok(m.line, "the end line is drawn");
      assert.equal(m.line.text, END_LINE);
      assert.ok(m.line.underReply, "under the goal's last reply");
      assert.ok(m.line.left >= 0 && m.line.right <= width, `inside the window (${m.line.left}..${m.line.right})`);
      assert.equal(m.sideways, 0, "nothing scrolls sideways");
      assert.ok(m.line.ratio >= 4.5, `reads at ${m.line.ratio}:1`);
      assert.equal(m.chip, null, "no Goals pill until /goal-history");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
  test(`${theme} ${width}px: /goal-history adds the Goals pill, and its list fits with every Trace whole`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGoals(browser, { width, theme, list: true });
    try {
      const m = await measureGoals(x.page);
      assert.ok(m.chip, "the Goals pill");
      assert.match(m.chip.text, /^Goals 3$/);
      assert.ok(m.chip.left >= 0 && m.chip.right <= width);
      assert.ok(m.pop, "its list is open");
      assert.ok(m.pop.left >= 0 && m.pop.right <= width && m.pop.top >= 0, `the list is inside the window (${JSON.stringify(m.pop)})`);
      assert.equal(m.rows.length, 3);
      assert.match(m.rows[0].name, /^Move the upload limit/, "newest first");
      for (const row of m.rows) {
        assert.ok(row.nameInside && row.factsInside, `${row.name}: inside the list`);
        assert.ok(!row.overlap, `${row.name}: its words don't run under Trace`);
        assert.equal(row.trace.word, "Trace");
        assert.ok(!row.trace.cut && row.trace.inside, `${row.name}: Trace is whole`);
        for (const r of row.ratios) assert.ok(r >= 4.5, `${row.name}: reads at ${r}:1`);
      }
      for (let i = 1; i < m.rows.length; i++) assert.ok(m.rows[i].top >= m.rows[i - 1].bottom - 0.5, "rows don't overlap");
      assert.equal(m.rows[0].trace.disabled, false, "the newest goal's turns are in this chat");
      assert.equal(m.sideways, 0);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
