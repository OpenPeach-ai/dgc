// User test round 2, the model picker (media/shared/modelpicker.js, as Work fills it). M3: Thinking's "?" was jargon
// that never closed, took the list down to four rows and touched the card's bottom. M5: on the Sub-agents tab "Use as
// fallback" did not say whose (held in work-subagents-page.test.mjs and pip-subagents-page.test.mjs). M6: pointing at
// a row took its capability marks away; a row that says Main cut its own
// name where there was room for it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { modelsMessage } from "./support/model-menu-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const short = (theme) => theme.split("-")[0];
const open = async (width, theme = "dark-modern", message = modelsMessage({ window_offered: true, fallback_offered: true }), control = "") => {
  const s = await openMapScene(C.state.browser, { width, height: 760, theme, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
  s.page.setDefaultTimeout(4000);
  // (What the process says of this model's thinking, as it says it with its settings.)
  if (control) await s.send({ type: "ready", provider_capabilities: { reasoning_control: control } });
  await s.page.click("#btn-model"); await s.post(message); await s.page.waitForSelector(".dgc-mp .dgc-mp-row"); await s.page.waitForTimeout(150);
  return s;
};
const rowsInSight = () => { const l = document.querySelector(".dgc-mp-list").getBoundingClientRect(); return [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].filter((r) => { const b = r.getBoundingClientRect(); return b.top >= l.top - 1 && b.bottom <= l.bottom + 1; }).length; };
const note = (page) => page.evaluate((rowsFn) => { const rows = (0, eval)(`(${rowsFn})`)(), more = document.querySelector(".dgc-mp-think-more"), p = more?.querySelector("p");
  if (!more || more.hidden || !p) return { open: false, rows, list: document.querySelector(".dgc-mp-list").getBoundingClientRect().height };
  const r = more.getBoundingClientRect(), c = document.querySelector(".dgc-mp").getBoundingClientRect(), think = document.querySelector(".dgc-mp-think-head").getBoundingClientRect(), cs = getComputedStyle(more);
  const range = document.createRange(); range.selectNodeContents(p); const lines = new Set([...range.getClientRects()].map((b) => Math.round(b.top))).size;
  return { open: true, words: p.textContent, lines, rows, list: document.querySelector(".dgc-mp-list").getBoundingClientRect().height, ground: cs.backgroundColor,
    inside: r.left >= c.left + 2 && r.right <= c.right - 2 && r.top >= c.top + 2, clear: r.bottom <= think.top + 0.5 }; }, rowsInSight.toString());
const JARGON = /Ollama|profile|bounded|guarantee|instructions|native|parallel|provider|grades|sent as/i;

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`M3: Thinking's ? says a few plain words, leaves the list its rows, and closes on a second click, Escape, or a click elsewhere (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const { page } = await open(width, theme);
    try {
      const before = await note(page);
      assert.equal(before.open, false, "premise: closed to begin with");
      await page.click(".dgc-mp-think-help");
      const n = await note(page);
      await shot(page, `m3-thinking-help-${short(theme)}-${width}`);
      assert.equal(n.open, true);
      assert.doesNotMatch(n.words, JARGON, `plain words (“${n.words}”)`);
      assert.ok(n.words.length <= 115 && n.lines <= (width > 400 ? 2 : 4), `short: ${n.words.length} characters on ${n.lines} lines`);
      assert.ok(n.inside && n.clear, "inside the picker, over the foot of the list: clear of the card's bottom edge and of Thinking itself");
      assert.deepEqual([n.rows, n.list], [before.rows, before.list], "the list keeps every row it showed");
      assert.doesNotMatch(n.ground, /rgba\([^)]*,\s*0?\.\d+\)|transparent/, `on a solid ground (${n.ground})`);
      assert.equal(await page.getAttribute(".dgc-mp-think-help", "aria-expanded"), "true");
      await page.click(".dgc-mp-think-help");
      assert.equal((await note(page)).open, false, "a second click closes it");
      await page.click(".dgc-mp-think-help"); await page.keyboard.press("Escape");
      assert.equal((await note(page)).open, false, "Escape closes it");
      assert.equal(await page.locator(".dgc-mp").count(), 1, "and leaves the picker open");
      assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("dgc-mp-think-help")), true, "the focus stays on the ?");
      await page.click(".dgc-mp-think-help"); await page.click(".dgc-mp-think-name");
      assert.equal((await note(page)).open, true, "a click on Thinking itself leaves it: its words go with the slider");
      await page.locator(".dgc-mp-tabs, .dgc-mp-rail").first().click({ position: { x: 3, y: 3 } });
      assert.equal((await note(page)).open, false, "a click elsewhere in the picker closes it");
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".dgc-mp").count(), 0, "with the words closed, Escape closes the picker as before");
    } finally { await page.close(); }
  });
}

test("M3: every model's thinking help is plain and short", async (t) => {
  if (C.skipOrFail(t)) return;
  const seen = new Set();
  for (const control of ["ollama-levels", "glm-levels", "glm-flash-levels", "toggle", "levels", "instructions", "provider"]) {
    const s = await open(300, "dark-modern", undefined, control);
    try {
      await s.page.click(".dgc-mp-think-help");
      const n = await note(s.page);
      assert.ok(n.open && n.words.length >= 30, `${control}: it says something`);
      seen.add(n.words);
      assert.doesNotMatch(n.words, JARGON, `${control}: plain words (“${n.words}”)`);
      assert.ok(n.words.length <= 115 && n.lines <= 4, `${control}: short (${n.words.length} characters, ${n.lines} lines at 300 px)`);
    } finally { await s.page.close(); }
  }
  assert.ok(seen.size >= 5, `premise: each kind of model says its own (${seen.size} different lines)`);
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`M6: a row keeps its capability marks under the pointer; Main's name is whole where it fits (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const { page } = await open(width, theme);
    try {
      // M6: the row that says Main keeps its name whole where the picker has the room.
      const main = await page.evaluate(() => { const row = [...document.querySelectorAll(".dgc-mp-row")].find((r) => /Main/.test(r.querySelector(".dgc-menu-pill")?.textContent || "")), name = row?.querySelector(".dgc-mp-name");
        return row ? { name: name.textContent, cut: name.scrollWidth > name.clientWidth + 1, caps: !!row.querySelector(".dgc-mp-caps")?.checkVisibility() } : null; });
      assert.ok(main, "premise: with a fallback set, a row says Main");
      if (width >= 700) assert.equal(main.cut, false, `“${main.name}” is whole`);
      // M6: pointing at a row keeps its marks.
      const row = page.locator(".dgc-mp-row", { has: page.locator(".dgc-mp-caps") }).filter({ hasNot: page.locator(".dgc-menu-pill") }).first();
      if (await row.count()) {
        const marks = () => row.evaluate((r) => { const c = r.querySelector(".dgc-mp-caps"), b = c.getBoundingClientRect(), box = r.getBoundingClientRect(), more = r.parentElement.querySelector(".dgc-mp-more")?.getBoundingClientRect();
          return { shown: c.checkVisibility() && b.width > 8, in: b.right <= box.right + 0.5, clearOfMore: !more || !more.width || b.right <= more.left + 0.5 || b.left >= more.right - 0.5, n: c.querySelectorAll(".dgc-mp-cap").length }; });
        const rest = await marks();
        await row.hover(); await page.waitForTimeout(120);
        const over = await marks();
        await shot(page, `m6-row-hover-${short(theme)}-${width}`);
        if (rest.shown) { assert.equal(over.shown, true, "its marks stay while it is pointed at"); assert.equal(over.n, rest.n); assert.ok(over.in && over.clearOfMore, "inside the row, clear of its ⋯"); }
      }
    } finally { await page.close(); }
  });
}
