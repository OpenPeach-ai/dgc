// The agent map's Pips section, its geometry in real Chromium (pips-flow-design Q2, picture 9): at a side bar's 300 px
// and at 700 px, dark and light. The section sits under the session's own helpers and above the settings link, inside
// the dialog; nothing scrolls sideways; rows never overlap and a Pip's name keeps a readable width; Stop and Open are
// the small outline button of the one family (its height, its 6 px corner) and line up down the right; nothing is a
// pill, the count and "for this session" included; the quiet words clear 4.5:1; every Pip wears its face. Hide folds
// the list to its title line.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { measurePips, openPipsMapScene, RELATED } from "./support/agent-map-pips-scene.mjs";

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

const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
const within = (outer, inner) => inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
const contrasts = (page, selectors) => page.evaluate((list) => {
  const rgb = (value) => { const m = value.match(/-?[\d.]+(?:e-?\d+)?/g).map(Number); return value.startsWith("color(srgb") ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3); };
  const lum = (c) => { const v = c.map((p) => p / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  return Object.fromEntries(list.map((selector) => {
    const node = document.querySelector(selector);
    if (!node) return [selector, 0];
    let ground = node;
    while (ground && getComputedStyle(ground).backgroundColor.replace(/\s/g, "") === "rgba(0,0,0,0)") ground = ground.parentElement;
    return [selector, ratio(rgb(getComputedStyle(node).color), rgb(getComputedStyle(ground || document.body).backgroundColor))];
  }));
}, selectors);

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 700]) {
    test(`${theme} at ${width}px: the Pips section under the session's helpers`, async (t) => {
      if (skipOrFail(t)) return;
      const { page, errors } = await openPipsMapScene(browser, { width, height: 760, theme });
      try {
        const m = await measurePips(page);
        assert.equal(m.hidden, false);
        assert.ok(m.pageOverflow <= 0, `the page does not scroll sideways (${m.pageOverflow})`);
        assert.ok(m.bodyOverflow <= 0, `nor does the map (${m.bodyOverflow})`);
        assert.ok(within(m.dialog, m.section), "the section is inside the dialog");
        assert.ok(m.section.top >= m.tree.bottom - 0.5, "under the session's own helpers");
        assert.ok(m.settings.top >= m.section.bottom - 0.5, "above the settings link");
        assert.deepEqual(m.rows.map((r) => [r.nameText, r.act.text]), [["Tax watchdog", "Stop"], ["Billing audit", "Open"], ["Stock sync check", "Open"]]);
        assert.equal(m.count.text, "3");
        assert.equal(m.more.text, "2 more Pips in this folder are idle · 5 Pips elsewhere · All Pips");
        for (const [i, row] of m.rows.entries()) {
          assert.ok(within(m.section, row.box), `${row.nameText}: inside the section`);
          assert.equal(row.plush, true, `${row.nameText}: its face`);
          assert.ok(row.face.width >= 20 && Math.abs(row.face.width - row.face.height) < 0.5, "a square face");
          assert.equal(row.nameClipped, false, `${row.nameText}: its name is whole`);
          assert.ok(row.name.width >= 60, `${row.nameText}: a readable name (${row.name.width})`);
          assert.ok(!overlap(row.name, row.act.box) && !overlap(row.meta, row.act.box) && !overlap(row.face, row.name), `${row.nameText}: nothing over anything`);
          assert.ok(Math.abs(row.act.box.height - m.small) < 0.5, `${row.act.text}: the small button's height (${row.act.box.height})`);
          assert.ok(Math.abs(row.act.corner - m.family) < 0.5, `${row.act.text}: the family's corner (${row.act.corner})`);
          assert.ok(Math.abs(row.act.box.right - m.rows[0].act.box.right) < 0.5, "the buttons line up down the right");
          assert.ok(Math.abs(row.act.box.width - m.rows[0].act.box.width) < 0.5, "and are one size");
          if (i) assert.ok(row.box.top >= m.rows[i - 1].box.bottom + 4, "rows keep their distance");
        }
        const tag = m.rows[0].tag;
        assert.ok(tag && !overlap(tag.box, m.rows[0].act.box), "“for this session” clears Stop");
        assert.equal(m.rows[1].tag, null, "only the job from this session is marked");
        // Nothing is a pill: no control, nor the count or the mark, has a corner of half its height.
        for (const shape of [...m.controls, { text: "count", ...m.count }, { text: "for this session", ...tag }]) {
          assert.ok(shape.corner <= m.family + 0.5, `${shape.text}: corner ${shape.corner}`);
          assert.ok(shape.corner < shape.box.height / 2 - 1.5, `${shape.text}: not a pill (${shape.corner} of ${shape.box.height})`);
        }
        assert.ok(Math.abs(m.toggle.height - m.small) < 0.5, "Hide is a small control's height");
        assert.ok(within(m.section, m.toggle) || m.toggle.right - m.section.right <= 8.5, "Hide ends where the buttons end");
        const seen = await contrasts(page, [".am-pips-title", ".am-pip-name", ".am-pip-meta", ".am-pip-tag", ".am-pips-toggle", ".am-pips-count", ".am-pips-words", ".am-pips-all", ".am-pip-act"]);
        for (const [selector, ratio] of Object.entries(seen)) assert.ok(ratio >= 4.5, `${selector}: ${ratio.toFixed(2)}:1`);
        // Hide folds it to its title line; Show brings it back.
        await page.click("#agent-map-pips-toggle");
        const folded = await measurePips(page);
        assert.equal(folded.bodyHidden, true);
        assert.ok(folded.section.height <= m.head.height + 12, `only its title line is left (${folded.section.height})`);
        assert.deepEqual(await page.evaluate(() => window.__posted.filter((x) => x.type === "agentMapPipsHidden")), [{ type: "agentMapPipsHidden", hidden: true }]);
        await page.click("#agent-map-pips-toggle");
        assert.equal((await measurePips(page)).rows.length, 3);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    });
  }
}

test("a long Pip name is cut with an ellipsis and keeps its button; the keyboard reaches Stop, Open, Hide and All Pips", async (t) => {
  if (skipOrFail(t)) return;
  const long = "Quarterly supplier statement reconciliation watchdog";
  const { page, errors } = await openPipsMapScene(browser, { width: 300, names: { tax: long },
    related: RELATED.map((p, i) => (i === 1 ? { ...p, name: "Monthly billing audit across every customer account" } : p)) });
  try {
    const m = await measurePips(page);
    assert.ok(m.pageOverflow <= 0 && m.bodyOverflow <= 0, "nothing scrolls sideways");
    assert.equal(m.rows[0].nameClipped, true);
    for (const row of m.rows) { assert.ok(row.act.box.right <= m.section.right + 0.5 && row.act.box.width >= 40, "its button is whole"); assert.ok(!overlap(row.name, row.act.box)); }
    assert.equal(await page.evaluate(() => document.querySelector(".am-pip-name").title), long, "pointing at it says the whole name");
    const order = await page.evaluate(() => { const all = [...document.querySelectorAll("#agent-map-pips button")]; return all.map((b) => [b.textContent, b.tabIndex]); });
    assert.deepEqual(order, [["Hide", 0], ["Stop", 0], ["Open", 0], ["Open", 0], ["All Pips", 0]]);
    await page.focus("#agent-map-pips-toggle");
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")), `Stop ${long}`);
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.__posted.filter((x) => x.type === "agentMapPipStop").length), 1);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
