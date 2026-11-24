// A model's marks in the picker (media/shared/modelpicker.js + .css, 24 Nov), in real Chromium. The owner, testing the
// release candidate: "maybe we increase the width of the model selector pop up, and on a narrow width, all these model's
// capability icons fold inside a single icon, where when user hovers on it, then it shows those icons?" A wider picker
// where a row's name, its Main or Fallback word and all its marks fit; in a narrow one (the side bar at 300 px) a row's
// marks are one small icon in the same column, and pointing at it, or reaching its row with the keys, shows them with
// their words. The marks are what the provider says (Ollama's own list), with a quiet "No tools" for a model without.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { pickerPage } from "./support/model-picker-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};
const shot = async (page, name) => {
  const dir = process.env.MODEL_CAPS_SHOTS; if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
};

// What the live Ollama said of these on 24 Nov (its /api/tags `capabilities`), as src/modelcaps.ts hands it to a page.
const SAID = { "qwen3.8:27b-q4km": { thinks: true, images: true, tools: true }, "codellama:13b": { thinks: false, images: false, tools: false },
  "qwen2.5:14b": { thinks: false, images: false, tools: true }, "deepseek-v4.1-flash:cloud": { thinks: true, images: true, tools: true },
  "kimi-k3.1-pro:cloud": { thinks: true, images: true, tools: true }, "glm-5.3:cloud": { thinks: true, images: false, tools: true } };
const IDS = ["qwen3.8:27b-q4km", "codellama:13b", "qwen2.5:14b", "deepseek-v4.1-flash:cloud", "kimi-k3.1-pro:cloud", "glm-5.3:cloud"];
const VIEW = `(() => {
  const P = window.DgcModelPicker, said = ${JSON.stringify(SAID)};
  const rows = ${JSON.stringify(IDS)}.map((id) => ({ id, value: id, name: id, caps: P.marksOf(id, said), current: id === "deepseek-v4.1-flash:cloud",
    pills: id === "deepseek-v4.1-flash:cloud" ? [["Main", "main"]] : id === "glm-5.3:cloud" ? [["Fallback", "fallback"]] : [],
    actions: [{ id: "main", label: "Use as main" }, { id: "fallback", label: "Use as fallback" }] }));
  return { title: "Model", connections: [{ id: "ollama", name: "Ollama", ...P.markOf({ base_url: "http://localhost:11434/v1" }), current: true, loaded: true, sections: P.ollamaSections(rows) },
      { id: "anthropic", name: "Anthropic API", ...P.markOf({ base_url: "https://api.anthropic.com/v1" }), loaded: true, sections: [{ title: "", rows: [] }] }],
    thinking: { levels: [["off", "Off"], ["low", "Low"], ["medium", "Medium"], ["high", "High"]].map(([value, label]) => ({ value, label })), value: "high" },
    footer: [{ id: "settings", label: "Add provider in Settings…", icon: "add" }] };
})()`;
const scene = async (t, width, theme) => {
  const made = await pickerPage(browser, { width, theme });
  t.after(() => made.context.close());
  const errors = [];
  made.page.on("pageerror", (e) => errors.push(e.message));
  await made.page.evaluate(`window.openPicker(${VIEW})`);
  // (Into the search with the pointer: the chosen row the picker opened on is no longer focused, so its ⋯ is away.)
  await made.page.click(".dgc-mp-q");
  await made.page.mouse.move(2, 2);
  return { ...made, errors };
};
/** Each row: its name, whether the name is cut, its tag, the marks one sees and the fold. */
const rows = (page) => page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].map((r) => {
  const name = r.querySelector(".dgc-mp-name"), caps = r.querySelector(".dgc-mp-caps"), fold = r.querySelector(".dgc-mp-fold"), tag = r.querySelector(".dgc-menu-pill");
  const seen = (n) => !!n && n.checkVisibility() && n.getBoundingClientRect().width > 4;
  const box = caps && seen(caps) ? caps.getBoundingClientRect() : null, f = seen(fold) ? fold.getBoundingClientRect() : null, s = fold ? getComputedStyle(fold) : null;
  return { name: name.textContent, cut: name.scrollWidth > name.clientWidth + 1, tag: tag ? tag.textContent : "", tagRight: tag ? tag.getBoundingClientRect().right : 0,
    marks: [...r.querySelectorAll(".dgc-mp-cap")].filter(seen).map((c) => c.dataset.cap), fold: f ? { label: fold.getAttribute("aria-label"), role: fold.getAttribute("role"),
      w: f.width, h: f.height, radius: parseFloat(getComputedStyle(caps).borderTopLeftRadius) } : null,
    capsLeft: box ? box.left : null, capsRight: box ? Math.round(box.right) : null, rowRight: r.getBoundingClientRect().right };
}));
const sheet = (page) => page.evaluate(() => {
  const s = document.querySelector(".dgc-mp-capsheet");
  if (!s || s.hidden || !s.checkVisibility()) return null;
  const b = s.getBoundingClientRect(), d = document.querySelector(".dgc-mp").getBoundingClientRect(), cs = getComputedStyle(s);
  return { lines: [...s.querySelectorAll(".dgc-mp-sheet-line")].map((l) => [l.dataset.cap, l.textContent.trim(), !!l.querySelector("svg")]),
    inside: b.left >= d.left && b.right <= d.right && b.top >= d.top && b.bottom <= d.bottom, top: b.top, bottom: b.bottom, radius: cs.borderTopLeftRadius, ground: cs.backgroundColor };
});
/** The pointer onto a row, then onto its icon where it is with the row pointed at (its ⋯ takes its room then). */
const hoverFold = async (page, name) => {
  const find = (n) => page.evaluate((m) => { const row = [...document.querySelectorAll(".dgc-mp-row")].find((r) => r.querySelector(".dgc-mp-name").textContent === m);
    const b = row.querySelector(".dgc-mp-fold").getBoundingClientRect(), r = row.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, left: r.left, top: r.top, bottom: r.bottom }; }, n);
  const row = await find(name);
  await page.mouse.move(row.left + 12, (row.top + row.bottom) / 2);
  await page.waitForTimeout(100);
  const at = await find(name);
  await page.mouse.move(at.x, at.y, { steps: 4 });
  return at;
};

for (const theme of ["dark", "light"]) {
  test(`700 px (${theme}): a wider picker, every name whole beside its Main or Fallback word and all its marks, in one column`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await scene(t, 700, theme);
    const width = await page.evaluate(() => Math.round(document.querySelector(".dgc-mp").getBoundingClientRect().width));
    assert.ok(width >= 500 && width <= 560, `wider than the 432 px it was (${width})`);
    const list = await rows(page);
    assert.deepEqual(list.map((r) => [r.name, r.marks]), [
      ["qwen3.8:27b-q4km", ["thinks", "images"]], ["codellama:13b", ["notools"]], ["qwen2.5:14b", []],
      ["deepseek-v4.1-flash:cloud", ["cloud", "thinks", "images"]], ["kimi-k3.1-pro:cloud", ["cloud", "thinks", "images"]], ["glm-5.3:cloud", ["cloud", "thinks"]]],
      "the provider's marks: deepseek-v4.1-flash and kimi see images, glm doesn't, codellama has no tools");
    assert.deepEqual(list.filter((r) => r.cut).map((r) => r.name), [], "no name is cut");
    assert.ok(list.every((r) => !r.fold), "nothing folded at this width");
    const marked = list.filter((r) => r.marks.length);
    assert.equal(new Set(marked.map((r) => r.capsRight)).size, 1, `the marks end at one edge (${marked.map((r) => r.capsRight)})`);
    for (const r of list.filter((x) => x.tag)) assert.ok(r.tagRight <= r.capsLeft + 0.5, `${r.tag} before ${r.name}'s marks`);
    const look = await page.evaluate(() => { const color = (sel) => getComputedStyle(document.querySelector(sel)).color, m = document.querySelector('.dgc-mp-cap[data-cap="notools"]');
      return { quiet: color('.dgc-mp-cap[data-cap="notools"]') === color('.dgc-mp-cap[data-cap="cloud"]'), thinks: color('.dgc-mp-cap[data-cap="thinks"]') !== color('.dgc-mp-cap[data-cap="notools"]'),
        title: m.title, label: m.getAttribute("aria-label"), drawn: !!m.querySelector("svg path") }; });
    assert.deepEqual([look.quiet, look.thinks, look.drawn], [true, true, true], "No tools is quiet: the cloud's grey, not a colour of its own");
    assert.match(look.title, /^No tools/); assert.match(look.label, /^No tools/);
    await shot(page, `picker-700-${theme}`);
    assert.deepEqual(errors, []);
  });

  test(`300 px (${theme}): a row's marks fold into one small icon in the same column; hover or the keys show them with their words`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await scene(t, 300, theme);
    const list = await rows(page), by = (n) => list.find((r) => r.name === n);
    for (const n of ["qwen3.8:27b-q4km", "kimi-k3.1-pro:cloud"]) {
      const r = by(n);
      assert.deepEqual(r.marks, [], `${n}: its marks are folded`);
      assert.ok(r.fold, `${n}: one small icon instead`);
      assert.equal(r.fold.role, "img");
      assert.ok(r.fold.h <= 22 && r.fold.w <= 28, `small (${r.fold.w}×${r.fold.h})`);
      assert.equal(r.fold.radius, 6, "the button family's corner, not a pill");
    }
    assert.equal(by("qwen3.8:27b-q4km").fold.label, "Thinks, Takes images", "its label says every mark");
    assert.equal(by("kimi-k3.1-pro:cloud").fold.label, "Runs in Ollama’s cloud, Thinks, Takes images");
    assert.deepEqual([by("codellama:13b").marks, by("codellama:13b").fold], [["notools"], null], "one mark is shown as itself: nothing to fold");
    assert.deepEqual([by("qwen2.5:14b").marks, by("qwen2.5:14b").fold], [[], null], "no marks, no icon");
    const plain = list.filter((r) => !r.tag && (r.fold || r.marks.length));
    assert.equal(new Set(plain.map((r) => r.capsRight)).size, 1, `the icons stand in the marks' column (${plain.map((r) => r.capsRight)})`);
    for (const r of list.filter((x) => x.tag && (x.fold || x.marks.length))) assert.ok(r.tagRight <= r.capsLeft + 0.5, `${r.tag} before ${r.name}'s icon`);
    assert.equal(await sheet(page), null, "nothing shown until asked");

    // The pointer on the icon: the marks with their words, inside the picker, clear of the row itself.
    const at = await hoverFold(page, "kimi-k3.1-pro:cloud");
    await page.waitForFunction(() => document.querySelector(".dgc-mp-capsheet")?.checkVisibility(), null, { timeout: 2000 });
    const shown = await sheet(page);
    assert.deepEqual(shown.lines, [["cloud", "Runs in Ollama’s cloud", true], ["thinks", "Thinks", true], ["images", "Takes images", true]]);
    assert.ok(shown.inside, "inside the picker");
    assert.ok(shown.top >= at.bottom - 0.5 || shown.bottom <= at.top + 0.5, "under or over its row: the row stays in sight");
    assert.equal(shown.radius, "6px");
    assert.doesNotMatch(shown.ground, /rgba\([^)]*,\s*0?\.\d+\)|transparent/, `on a solid ground (${shown.ground})`);
    await shot(page, `picker-300-${theme}-hover`);
    await page.mouse.move(2, 2);
    await page.waitForFunction(() => !document.querySelector(".dgc-mp-capsheet")?.checkVisibility(), null, { timeout: 2000 });

    // The keys: the row the arrows reach shows its marks; one with nothing folded shows none.
    await page.focus(".dgc-mp-q");
    await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".dgc-mp-name")?.textContent), "qwen3.8:27b-q4km");
    assert.deepEqual((await sheet(page))?.lines, [["thinks", "Thinks", true], ["images", "Takes images", true]], "its marks, by the keys");
    await shot(page, `picker-300-${theme}-keys`);
    await page.keyboard.press("ArrowDown");
    assert.equal(await sheet(page), null, "codellama: its one mark is in sight already");
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowDown");
    assert.equal(await page.evaluate(() => document.activeElement?.querySelector(".dgc-mp-name")?.textContent), "kimi-k3.1-pro:cloud");
    assert.deepEqual((await sheet(page))?.lines.map(([cap]) => cap), ["cloud", "thinks", "images"]);
    await page.keyboard.press("Tab");
    assert.equal(await sheet(page), null, "the focus gone from the row: gone too");
    await page.mouse.move(2, 2);
    await shot(page, `picker-300-${theme}`);
    assert.deepEqual(errors, []);
  });
}

test("560 px, just room for the wide picker: a row that says Main or Fallback keeps its whole name beside its marks", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await scene(t, 560, "dark");
  const list = await rows(page);
  for (const r of list.filter((x) => x.tag)) assert.equal(r.cut, false, `${r.name} beside ${r.tag} is whole`);
});
