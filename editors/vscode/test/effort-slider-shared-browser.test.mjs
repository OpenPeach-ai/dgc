// The thinking slider is one slider (0.52, 15 Nov; media/shared/effort.js): a Pip's is Work's in every way but its dot,
// which is that Pip's face. Work's real model menu and a Pip's real one, in Chromium: the same markup, the same track,
// fill, stops, words, keyboard and what a screen reader hears; a Pip's face is the dot's size, on the dot's centre at
// every stop, with the dot's focus ring for the keyboard only.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { modelsMessage } from "./support/model-menu-scene.mjs";
import { GST, MORNINGS, openOnePips } from "./support/one-pips-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

/** A slider as drawn and as heard. Run in the page with the slider's root (the document, or the Pips view's shadow root). */
const measure = (root, selector) => {
  const sl = root.querySelector(selector), c = sl.parentElement, l = c.querySelector(".effort-labels"), s = getComputedStyle(sl), cs = getComputedStyle(c), ls = getComputedStyle(l);
  const box = sl.getBoundingClientRect(), out = l.querySelector("output");
  return { control: [...c.classList].filter((n) => !["has-face", "bumped", "is-ultra"].includes(n)), slider: [...sl.classList].filter((n) => n !== "by-pointer"),
    kids: [...c.children].filter((n) => !n.classList.contains("effort-face")).map((n) => `${n.tagName.toLowerCase()}.${n.className.replace(" by-pointer", "")}`),
    type: sl.type, min: sl.min, max: sl.max, step: sl.step, value: sl.value, name: sl.getAttribute("aria-label"), heard: sl.getAttribute("aria-valuetext"), profiles: sl.dataset.profiles,
    height: box.height, radius: s.borderTopLeftRadius, edge: s.boxShadow, fill: s.backgroundImage, effort: cs.getPropertyValue("--effort").trim(), pad: [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].join(" "),
    border: [s.borderTopWidth, s.paddingTop, s.paddingLeft, s.minHeight, s.marginTop].join(" "), words: [...l.children].map((n) => `${n.tagName.toLowerCase()}:${n.textContent}`), at: l.dataset.at,
    wordsTop: ls.marginTop, wordsType: [ls.fontSize, ls.color, getComputedStyle(out).color, getComputedStyle(out).visibility].join(" ") };
};
const workMenu = async (width = 440, theme = "dark-modern") => {
  const s = await openMapScene(browser, { width, height: 760, theme, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
  s.page.setDefaultTimeout(5000);
  await s.page.click("#btn-model"); await s.post(modelsMessage()); await s.page.waitForSelector("#modelmenu .effort-slider"); await s.page.waitForTimeout(200);
  return s;
};
const pipMenu = async (pip = GST, width = 440, theme = "dark-modern", scene = {}) => {
  const x = await openOnePips(browser, { api: 99, width, height: 760, theme, faces: true, scene: { sub: true, waiting: false, ...scene } });
  x.page.setDefaultTimeout(5000);
  await x.openPip(pip); await x.waitIn("#chat-model:not([disabled])"); await x.click("#chat-model"); await x.waitIn("#chat-thinking"); await x.page.waitForTimeout(200);
  return x;
};
const inWork = (s, selector = "#modelmenu .effort-slider") => s.page.evaluate(([f, sel]) => (0, eval)(`(${f})`)(document, sel), [measure.toString(), selector]);
const inPip = (x, selector = "#chat-thinking") => x.inPips(measure, selector);
// The Pips view's width is its own, so the slider's is; what must agree is everything that isn't the width.
/** Is a dot painted at the slider's thumb? The few pixels at the thumb's centre against the filled track a little to
 *  its left (stop 4 of 5, where both are inside the fill): the same picture when nothing is painted there. */
const dotPainted = async (page, box) => {
  const cx = box.x + 14 + (box.w - 28) * 0.8, cy = box.y + box.h / 2, clip = (x) => ({ x: Math.round(x) - 1, y: Math.round(cy) - 1, width: 3, height: 3 });
  const [at, beside] = [await page.screenshot({ clip: clip(cx) }), await page.screenshot({ clip: clip(cx - 26) })];
  return !at.equals(beside);
};
const same = (m) => { const { fill, ...rest } = m; return { ...rest, fill: fill.replace(/\s+/g, " ") }; };

test("a Pip's thinking slider is Work's: the same markup, track, fill, stops and words at every stop", async (t) => {
  if (skipOrFail(t)) return;
  const s = await workMenu(), x = await pipMenu();
  try {
    for (const stop of [0, 2, 5]) {
      const set = (root, [sel, v]) => { const sl = root.querySelector(sel); sl.value = String(v); sl.dispatchEvent(new Event("input", { bubbles: true, composed: true })); };
      await s.page.evaluate(([f, a]) => (0, eval)(`(${f})`)(document, a), [set.toString(), ["#modelmenu .effort-slider", stop]]);
      await x.inPips(set, ["#chat-thinking", stop]);
      await s.page.waitForTimeout(260); await x.page.waitForTimeout(260);
      const work = same(await inWork(s)), pip = same(await inPip(x));
      assert.deepEqual(pip, work, `at stop ${stop} a Pip's slider is Work's`);
      assert.equal(pip.name, "Thinking effort");
      assert.deepEqual(pip.control, ["effort-control"]); assert.deepEqual(pip.slider, ["effort-slider"]);
      assert.equal(pip.height, 25);
    }
    assert.deepEqual(x.errors, []);
  } finally { await s.close?.(); await s.page.context().close().catch(() => {}); await x.close(); }
});

test("the keyboard moves both the same way, a step at a time, and both say the stop", async (t) => {
  if (skipOrFail(t)) return;
  const s = await workMenu(), x = await pipMenu();
  try {
    const steps = async (page, focus, read) => { const seen = []; await focus();
      for (const key of ["Home", "ArrowRight", "ArrowRight", "ArrowLeft", "End"]) { await page.keyboard.press(key); await page.waitForTimeout(120); const m = await read(); seen.push([key, m.value, m.heard, m.words.join(","), m.at, m.effort]); }
      return seen; };
    const work = await steps(s.page, () => s.page.focus("#modelmenu .effort-slider"), () => inWork(s));
    const pip = await steps(x.page, () => x.inPips((root) => root.querySelector("#chat-thinking").focus()), () => inPip(x));
    assert.deepEqual(pip, work);
    assert.deepEqual(pip.map((r) => [r[1], r[2]]), [["0", "Off"], ["1", "Low"], ["2", "Medium"], ["1", "Low"], ["5", "Ultra"]].map(([v, w], i) => [v, i === 4 ? pip[4][2] : w]));
    assert.match(pip[4][2], /^Ultra/);
    assert.equal(await x.inPips((root) => root.querySelector("#chat-model-summary, .composer-model-menu") !== null), true, "an arrow key keeps the menu open for the next step");
    assert.deepEqual(x.errors, []);
  } finally { await s.page.context().close().catch(() => {}); await x.close(); }
});

test("a Pip's face is the dot: that Pip's own face, the dot's size, on the dot's centre at every stop; Work keeps its dot", async (t) => {
  if (skipOrFail(t)) return;
  const s = await workMenu();
  try {
    assert.equal(await s.page.locator("#modelmenu .effort-face").count(), 0, "Work's dot is its dot");
    await s.page.evaluate(() => { const sl = document.querySelector("#modelmenu .effort-slider"); sl.value = "4"; sl.dispatchEvent(new Event("input", { bubbles: true })); });
    await s.page.waitForTimeout(400);
    const box = await s.page.evaluate(() => { const b = document.querySelector("#modelmenu .effort-slider").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    assert.equal(await dotPainted(s.page, box), true, "and it is painted");
  } finally { await s.page.context().close().catch(() => {}); }
  for (const [pip, character] of [[GST, "rook"], [MORNINGS, "quill"]]) {
    const x = await pipMenu(pip);
    try {
      for (const stop of [0, 1, 2, 3, 4, 5]) {
        await x.inPips((root, v) => { const sl = root.querySelector("#chat-thinking"); sl.value = String(v); sl.dispatchEvent(new Event("input", { bubbles: true, composed: true })); }, stop);
        await x.page.waitForTimeout(260);
        const seen = await x.inPips((root) => { const sl = root.querySelector("#chat-thinking"), f = sl.parentElement.querySelector(".effort-face"), a = f.querySelector(".avatar"), b = sl.getBoundingClientRect(), r = f.getBoundingClientRect(), ar = a.getBoundingClientRect();
          const t = Number(sl.value) / Number(sl.max);
          return { character: a.dataset.character, w: r.width, h: r.height, aw: ar.width, ah: ar.height, dx: r.left + r.width / 2 - (b.left + 14 + (b.width - 28) * t), dy: r.top + r.height / 2 - (b.top + b.height / 2), ring: getComputedStyle(f).boxShadow, taken: getComputedStyle(f).pointerEvents, hidden: f.getAttribute("aria-hidden") }; });
        assert.equal(seen.character, character, "this Pip's own face");
        assert.deepEqual([seen.w, seen.h, seen.aw, seen.ah], [28, 28, 28, 28], "the size of Work's dot");
        assert.ok(Math.abs(seen.dx) <= 0.6 && Math.abs(seen.dy) <= 0.6, `on the dot's centre at stop ${stop} (${seen.dx}, ${seen.dy})`);
        if (stop === 4) {     // with the face out of the way, nothing is painted where the dot was
          await x.inPips((root) => { root.querySelector(".effort-face").style.visibility = "hidden"; });
          const box = await x.inPips((root) => { const b = root.querySelector("#chat-thinking").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
          assert.equal(await dotPainted(x.page, box), false, "the white dot is not drawn under the face");
          await x.inPips((root) => { root.querySelector(".effort-face").style.visibility = ""; });
        }
        assert.equal(seen.taken, "none", "the slider under it is what is dragged"); assert.equal(seen.hidden, "true");
      }
      // The focus ring is the dot's, for the keyboard only.
      const ring = () => x.inPips((root) => getComputedStyle(root.querySelector(".effort-face")).boxShadow);
      const box = await x.inPips((root) => { const b = root.querySelector("#chat-thinking").getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
      await x.page.mouse.move(box.x + box.w * 0.5, box.y + box.h / 2); await x.page.mouse.down(); await x.page.mouse.move(box.x + box.w * 0.62, box.y + box.h / 2, { steps: 3 });
      assert.equal(await ring(), "none", "dragging it draws no ring");
      assert.equal(await x.inPips((root) => getComputedStyle(root.querySelector("#chat-thinking")).outlineStyle), "none");
      await x.page.mouse.up(); await x.page.waitForTimeout(200);
      await x.waitIn("#chat-thinking"); await x.inPips((root) => root.querySelector("#chat-thinking").focus());
      await x.page.keyboard.press("ArrowLeft"); await x.page.waitForTimeout(350);
      assert.match(await ring(), /0px 0px 0px 2px.*0px 0px 0px 4px/, "the keyboard gets the dot's ring, on the face");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("one module draws both: neither page keeps a slider of its own", () => {
  const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
  for (const file of ["media/main.js", "src/pipsClient.js"]) {
    assert.match(read(file), /DgcEffort\.html\(/, `${file} draws the shared slider`);
    assert.doesNotMatch(read(file), /type="range"[^>]*effort|class="[^"]*effort-slider/, `${file} has no slider markup of its own`);
  }
  assert.doesNotMatch(read("src/pips.css"), /composer-effort-(slider|control|face|labels)/, "a Pip's slider has no rules of its own");
  assert.doesNotMatch(read("media/main.css"), /\.effort-slider\s*\{/, "Work's slider rules are the shared ones");
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/effort\.css"\)/);
  assert.match(read("src/panel.ts"), /"shared", "effort\.js"/, "Work's page loads the module");
});
