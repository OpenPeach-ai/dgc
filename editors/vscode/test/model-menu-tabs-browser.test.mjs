// The model menu after live round 1 (14 Nov, findings 3, 12, 13b): today's model row and the main thinking slider stay
// on top; below them, tabs "Main model | Sub-agents". The Main tab is the model list with Main and Fallback at the
// rows' ends, and every row's ⋯ shows only while the row is pointed at (the Fallback row showed its ⋯ always). The
// Sub-agents tab has a Thinking dropdown (no Ultra), a Context window dropdown (the sizes Settings offers) and its own
// list, "Settings' choice" first; the list takes the menu's height. On the real panel, in real Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openMapScene } from "./support/agent-map-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

import { SPARE, modelsMessage } from "./support/model-menu-scene.mjs";
const open = async (width, height = 760, theme = "dark-modern", more = {}) => {
  const s = await openMapScene(browser, { width, height, theme, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
  s.page.setDefaultTimeout(4000);
  await s.page.click("#btn-model"); await s.post(modelsMessage(more)); await s.page.waitForSelector("#modelmenu .model-summary"); await s.page.waitForTimeout(200);
  return s;
};
const posted = (page, type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const top = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); if (!n || !n.checkVisibility()) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: r.height }; }, sel);

test("the model row and the main slider stay on top; under them, the tabs Main model and Sub-agents; the Main tab is the list with Main and Fallback", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await open(440);
  try {
    const row = await top(page, "#modelmenu .model-summary"), slider = await top(page, "#modelmenu .effort-slider"), tabs = await top(page, "#modelmenu .model-tabs"), list = await top(page, "#modelmenu .model-list-scroll");
    assert.ok(row && slider && tabs && list, "the model row, the slider, the tabs and the list are all there");
    assert.ok(row.bottom <= slider.top + 1 && slider.bottom <= tabs.top + 1 && tabs.bottom <= list.top + 1, "in that order, top to bottom");
    const names = await page.evaluate(() => [...document.querySelectorAll("#modelmenu .model-tabs [role='tab']")].map((b) => [b.textContent.trim(), b.getAttribute("aria-selected")]));
    assert.deepEqual(names, [["Main model", "true"], ["Sub-agents", "false"]]);
    const pills = await page.evaluate(() => [...document.querySelectorAll("#modelmenu .model-list-scroll .mrow")].filter((r) => r.querySelector(".dgc-menu-pill")).map((r) => [r.querySelector(".dgc-menu-label").textContent, r.querySelector(".dgc-menu-pill").textContent]));
    assert.deepEqual(pills, [["deepseek-v4-pro:cloud", "Main"], ["glm-5.3:cloud", "Fallback"]]);
    assert.equal(await page.locator("#modelmenu [data-agents-open]").count(), 0, "the old Sub-agents row that drilled into the main list's place is gone");
    // One shape: the tabs are the 6 px family at a button's height, never a pill.
    const shape = await page.evaluate(() => [...document.querySelectorAll("#modelmenu .model-tabs, #modelmenu .model-tabs [role='tab']")].map((n) => { const s = getComputedStyle(n), r = n.getBoundingClientRect(); return { radius: parseFloat(s.borderTopLeftRadius), h: r.height }; }));
    for (const s of shape) assert.ok(s.radius <= 6 && s.radius >= 3, `a 6 px family corner (${s.radius})`);
    assert.ok(shape[1].h >= 24 && shape[1].h <= 30, `a tab is a button's height (${shape[1].h})`);
  } finally { await page.close(); }
});

test("every row's ⋯ shows only while its row is pointed at: the Fallback row's too, also just after it was made the fallback", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await open(440);
  try {
    const dots = () => page.evaluate(() => [...document.querySelectorAll("#modelmenu .model-list-scroll .dgc-menu-item")].map((i) => [i.querySelector(".dgc-menu-label").textContent, Number(getComputedStyle(i.querySelector(".dgc-menu-more")).opacity)]));
    await page.mouse.move(2, 2); await page.waitForTimeout(250);
    assert.ok((await dots()).length >= 6);
    assert.deepEqual((await dots()).filter(([, o]) => o > 0.01), [], "at rest no row shows its ⋯");
    // Another model made the fallback with its ⋯: once the pointer leaves, its ⋯ is hidden like every other row's.
    const item = page.locator("#modelmenu .dgc-menu-item", { hasText: "qwen2.5:14b" });
    await item.hover(); await page.waitForTimeout(250);
    assert.equal((await dots()).find(([n]) => n === "qwen2.5:14b")[1], 1, "pointed at, its ⋯ shows");
    await item.locator(".dgc-menu-more").click(); await page.click("#modelmenu [data-fb-set]"); await page.waitForTimeout(200);
    assert.equal(await page.locator("#modelmenu .dgc-menu-item", { hasText: "qwen2.5:14b" }).locator(".dgc-menu-pill").innerText(), "Fallback");
    await page.mouse.move(2, 2); await page.waitForTimeout(300);
    assert.deepEqual((await dots()).filter(([, o]) => o > 0.01), [], "the new Fallback row's ⋯ is hidden once the pointer has left");
    // The keyboard still reaches it: a row focused by the keys shows its ⋯.
    await page.locator("#modelmenu .dgc-menu-item", { hasText: "codellama:13b" }).locator(".mrow").focus(); await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowUp"); await page.waitForTimeout(250);
    assert.equal((await dots()).find(([n]) => n === "codellama:13b")[1], 1, "a row reached with the keyboard shows its ⋯");
  } finally { await page.close(); }
});

test("the Sub-agents tab: a Thinking dropdown with no Ultra, a Context window dropdown with Settings' sizes, then its list with Settings' choice first", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await open(440);
  try {
    await page.click("#modelmenu .model-tabs [data-model-tab='agents']"); await page.waitForTimeout(200);
    assert.equal(await page.getAttribute("#modelmenu .model-tabs [data-model-tab='agents']", "aria-selected"), "true");
    assert.ok(await top(page, "#modelmenu .model-summary") && await top(page, "#modelmenu .effort-slider"), "the model row and the main slider stay");
    const think = await top(page, "#modelmenu [data-agents-drop='thinking']"), ctx = await top(page, "#modelmenu [data-agents-drop='context']"), list = await top(page, "#modelmenu .model-list-scroll"), tabs = await top(page, "#modelmenu .model-tabs");
    assert.ok(think && ctx && list); assert.ok(tabs.bottom <= think.top + 1 && think.bottom <= ctx.top + 1 && ctx.bottom <= list.top + 1, "tabs, Thinking, Context window, the list");
    assert.deepEqual([await page.innerText("#modelmenu [data-agents-drop='thinking']"), await page.innerText("#modelmenu [data-agents-drop='context']")].map((s) => s.trim()), ["Same as the session", "Same as the session"]);
    const first = await page.evaluate(() => { const rows = [...document.querySelectorAll("#modelmenu .model-list-scroll .mrow")]; return [rows[0].querySelector(".dgc-menu-label").textContent, rows[0].getAttribute("aria-checked"), rows.slice(1).map((r) => r.querySelector(".dgc-menu-label")?.textContent || r.textContent.trim())]; });
    assert.equal(first[0], "Settings’ choice"); assert.equal(first[1], "true");
    assert.deepEqual(first[2].slice(0, 3), ["Ollama", "Spare GPU box", "Claude Code"]);
    assert.equal(await page.locator("#modelmenu [data-provider-back], #modelmenu [data-i]").count(), 0, "nothing of the main model's list is here");
    // Thinking: its six choices, no Ultra; choosing one tells the host and shows at once.
    await page.click("#modelmenu [data-agents-drop='thinking']"); await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#modelmenu .agents-drop-list [role='option']")].map((o) => o.textContent.trim())), ["Same as the session", "Off", "Low", "Medium", "High", "Extra high"]);
    await page.click("#modelmenu .agents-drop-list [data-value='low']"); await page.waitForTimeout(150);
    assert.deepEqual(await posted(page, "setAgentsThinking"), [{ type: "setAgentsThinking", level: "low" }]);
    assert.equal((await page.innerText("#modelmenu [data-agents-drop='thinking']")).trim(), "Low");
    assert.equal(await page.locator("#modelmenu .agents-drop-list").count(), 0, "the dropdown closed");
    await page.click("#modelmenu [data-agents-drop='context']"); await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#modelmenu .agents-drop-list [role='option']")].map((o) => o.textContent.trim())), ["Same as the session", "4K", "8K", "16K", "32K", "64K", "128K", "256K", "Another size…"]);
    await page.click("#modelmenu .agents-drop-list [data-value='32768']"); await page.waitForTimeout(150);
    assert.deepEqual(await posted(page, "setAgentsContext"), [{ type: "setAgentsContext", size: 32768 }]);
    assert.equal((await page.innerText("#modelmenu [data-agents-drop='context']")).trim(), "32K");
    // Back on the Main tab the main list is as it was.
    await page.click("#modelmenu .model-tabs [data-model-tab='main']"); await page.waitForTimeout(150);
    assert.ok(await page.locator("#modelmenu [data-i]").count() >= 6);
    // One shape: each dropdown is a button of the 6 px family.
    await page.click("#modelmenu .model-tabs [data-model-tab='agents']"); await page.waitForTimeout(150);
    const shape = await page.evaluate(() => [...document.querySelectorAll("#modelmenu [data-agents-drop]")].map((n) => ({ radius: parseFloat(getComputedStyle(n).borderTopLeftRadius), h: n.getBoundingClientRect().height })));
    for (const s of shape) { assert.equal(s.radius, 6); assert.ok(s.h >= 24 && s.h <= 28, `a button's height (${s.h})`); }
  } finally { await page.close(); }
});

test("what DGC says the sub-agents use shows in the dropdowns; a DGC that cannot set one shows no dropdown for it", async (t) => {
  if (skipOrFail(t)) return;
  let s = await open(440, 760, "dark-modern", { thinking: "high", context_size: 24576 });
  try {
    await s.page.click("#modelmenu .model-tabs [data-model-tab='agents']"); await s.page.waitForTimeout(150);
    assert.deepEqual([await s.page.innerText("#modelmenu [data-agents-drop='thinking']"), await s.page.innerText("#modelmenu [data-agents-drop='context']")].map((x) => x.trim()), ["High", "24K"]);
  } finally { await s.page.close(); }
  s = await open(440, 760, "dark-modern", { thinking_settable: false, context_settable: false });
  try {
    await s.page.click("#modelmenu .model-tabs [data-model-tab='agents']"); await s.page.waitForTimeout(150);
    assert.equal(await s.page.locator("#modelmenu [data-agents-drop]").count(), 0);
    assert.equal((await s.page.evaluate(() => document.querySelector("#modelmenu .model-list-scroll .mrow .dgc-menu-label").textContent)), "Settings’ choice");
  } finally { await s.page.close(); }
});

for (const [width, height] of [[300, 900], [300, 600], [220, 700]]) {
  test(`the Sub-agents list takes the menu's height: several rows show at ${width} × ${height}, and nothing is cut sideways`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, post } = await open(width, height);
    try {
      await page.click("#modelmenu .model-tabs [data-model-tab='agents']"); await page.waitForTimeout(150);
      await page.click('#modelmenu [data-agents-provider="1"]'); await post({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "own-coder", "qwen3-coder:30b", "glm-5.3:cloud", "deepseek-v4.1-flash:cloud", "codellama:13b", "qwen2.5:14b", "a-model-with-a-very-long-name-that-goes-on:120b-instruct-q8_0"] });
      await page.waitForSelector("#modelmenu [data-agents-model]"); await page.waitForTimeout(200);
      const m = await page.evaluate(() => { const mm = document.getElementById("modelmenu"), list = mm.querySelector(".model-list-scroll"), rows = [...list.querySelectorAll("[data-agents-model]")], lr = list.getBoundingClientRect(), r = mm.getBoundingClientRect();
        const whole = rows.filter((x) => { const b = x.getBoundingClientRect(); return b.top >= lr.top - 0.5 && b.bottom <= lr.bottom + 0.5; }).length;
        return { whole, rows: rows.length, menu: { top: r.top, bottom: r.bottom, left: r.left, right: r.right }, vw: innerWidth, vh: innerHeight, sideways: mm.scrollWidth > mm.clientWidth + 1 || list.scrollWidth > list.clientWidth + 1 }; });
      assert.ok(m.whole >= Math.min(4, m.rows), `at least four of the ${m.rows} models show whole (${m.whole} did)`);
      assert.ok(m.menu.left >= 0 && m.menu.right <= m.vw + 0.5 && m.menu.top >= 0 && m.menu.bottom <= m.vh + 0.5, "the menu is inside the window");
      assert.equal(m.sideways, false, "nothing scrolls sideways");
    } finally { await page.close(); }
  });
}
