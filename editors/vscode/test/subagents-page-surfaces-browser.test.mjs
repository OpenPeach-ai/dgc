// The Sub-agents page on its two surfaces in real Chromium (17 Nov): Work's picker (media/main.js) and a Pip's chat
// (src/pipsClient.js, in the side bar's shadow root and in a Pips tab), both themes, 300, 440 and 700 px: a model chosen
// on the Sub-agents tab opens its page with only the sizes it takes; Escape is Back, with the focus on the chosen model;
// Done closes; a row's ⋯ makes it the sub-agents' fallback and the row says so. A Pip on a DGC before Pips API 104
// keeps the read-only tab.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";
import { SPARE, modelsMessage, PIP_CATALOG, PIP_MODELS, PIP_KEYED } from "./support/model-menu-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};
const SIZES_256K = ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "256K"];
/** What a page shows of the picker: read in `root` (the document, or a Pip view's shadow root). */
const READ = (root) => {
  const q = (s) => root.querySelector(s), d = q(".dgc-mp").getBoundingClientRect(), page = q(".dgc-mp-page");
  const inside = (n) => { const r = n.getBoundingClientRect(); return r.left >= d.left - 0.5 && r.right <= d.right + 0.5 && r.top >= d.top - 0.5 && r.bottom <= d.bottom + 0.5; };
  return { open: !!page && !page.hidden, name: q(".dgc-mp-page-name")?.textContent || "", conn: q(".dgc-mp-page-conn")?.textContent || "",
    sizes: [...root.querySelectorAll(".dgc-mp-size")].map((b) => b.textContent), note: q(".dgc-mp-window-note")?.textContent || "",
    allInside: !page || page.hidden || [...page.querySelectorAll("button, input, p, span")].filter((n) => n.getClientRects().length).every(inside),
    cut: !page || page.hidden ? [] : [...page.querySelectorAll("button")].filter((b) => b.scrollWidth > b.clientWidth + 0.5).map((b) => b.textContent),
    focus: (root.activeElement || document.activeElement)?.dataset?.k || "", tags: [...root.querySelectorAll(".dgc-mp-list .dgc-mp-row")].filter((r) => r.querySelector(".dgc-mp-tag")).map((r) => [r.dataset.value, r.querySelector(".dgc-mp-tag").textContent]) };
};

test("Work: a model on the Sub-agents tab opens its page with only the sizes it takes; Escape is Back; the ⋯ makes a fallback; Done closes", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
    const s = await openMapScene(browser, { width, height: 760, theme, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
    const { page, post } = s, at = `${theme} ${width}px`, errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(4000);
    try {
      await page.click("#btn-model"); await post(modelsMessage({ window_offered: true, fallback_offered: true })); await page.waitForSelector(".dgc-mp .dgc-mp-row");
      await page.click('.dgc-mp-tab[data-tab="agents"]');
      await page.click(`.dgc-mp-conn[data-rail="${SPARE}"]`);
      await post({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "gpt-oss:20b", "own-coder"] });
      await page.waitForSelector('.dgc-mp-row[data-value="gpt-oss:120b"]');
      await page.click('.dgc-mp-row[data-value="gpt-oss:120b"]');
      assert.deepEqual(await page.evaluate(() => window.__posted.filter((m) => m.type === "agentsWindow")), [{ type: "agentsWindow", provider: SPARE, model: "gpt-oss:120b" }], at);
      await post({ type: "agentsWindow", provider: SPARE, model: "gpt-oss:120b", window: 262144 });
      const seen = await page.evaluate(`(${READ})(document)`);
      assert.deepEqual([seen.open, seen.name, seen.conn, seen.sizes, seen.note, seen.focus], [true, "gpt-oss:120b", "Spare GPU box", SIZES_256K, "This model takes up to 256K.", "back"], at);
      assert.deepEqual([seen.allInside, seen.cut], [true, []], `${at}: nothing outside the dialog, no word cut`);
      await page.keyboard.press("Escape");
      const back = await page.evaluate(`(${READ})(document)`);
      assert.deepEqual([back.open, back.focus], [false, `r:${SPARE}:gpt-oss:120b`], `${at}: Escape is Back, on the chosen model`);
      // The ⋯ on another row: their fallback; the rows say Main and Fallback.
      await page.hover('.dgc-mp-row[data-value="gpt-oss:20b"]');
      await page.click('.dgc-mp-item:has(.dgc-mp-row[data-value="gpt-oss:20b"]) .dgc-mp-more');
      await page.click(".dgc-mp-choices button");
      assert.deepEqual(await page.evaluate(() => window.__posted.filter((m) => m.type === "setAgentsFallback")), [{ type: "setAgentsFallback", provider: SPARE, model: "gpt-oss:20b" }], at);
      const tagged = await page.evaluate(`(${READ})(document)`);
      assert.deepEqual(tagged.tags, [["gpt-oss:120b", "Main"], ["gpt-oss:20b", "Fallback"]], at);
      assert.equal(tagged.focus, `m:r:${SPARE}:gpt-oss:20b`, `${at}: the focus is back on the row's ⋯`);
      await page.click('.dgc-mp-row[data-value="gpt-oss:120b"]');
      await page.click(".dgc-mp-done");
      assert.equal(await page.locator(".dgc-mp-layer").count(), 0, `${at}: Done closes the picker`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test("a Pip on Pips API 104: the same page, in the side bar's shadow root and in a Pips tab", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
    const where = width >= 600 ? "tab" : "side", at = `${theme} ${width}px ${where}`;
    const x = await openOnePips(browser, { width, height: 760, theme, where, api: 104,
      scene: { sub: true, fix: "none", posts: false, waiting: false, attention: false, models: PIP_MODELS, catalog: PIP_CATALOG, windows: { "claude-opus-5-5": 262144 } } });
    try {
      await x.openPip(GST); await x.page.waitForTimeout(200);
      await x.click("#chat-model"); await x.waitIn(".dgc-mp .dgc-mp-row");
      await x.click('.dgc-mp-tab[data-tab="agents"]'); await x.waitIn(`.dgc-mp-conn[data-rail="provider:${PIP_KEYED}"]`);
      await x.click(`.dgc-mp-conn[data-rail="provider:${PIP_KEYED}"]`);
      await x.click(`.dgc-mp-row[data-value="provider:${PIP_KEYED}:claude-opus-5-5"]`);
      await x.waitIn(".dgc-mp-page:not([hidden])"); await x.page.waitForFunction(() => (document.getElementById("pips-host")?.shadowRoot || document).querySelectorAll(".dgc-mp-size").length === 8);
      const seen = await x.inPips(READ);
      assert.deepEqual([seen.open, seen.name, seen.conn, seen.sizes, seen.note], [true, "claude-opus-5-5", "Anthropic API", SIZES_256K, "This model takes up to 256K."], at);
      assert.deepEqual([seen.allInside, seen.cut], [true, []], `${at}: nothing outside the dialog, no word cut`);
      assert.equal(seen.focus, "back", `${at}: the focus is on Back`);
      await x.page.keyboard.press("Escape");
      const back = await x.inPips(READ);
      assert.deepEqual([back.open, back.focus], [false, `r:provider:${PIP_KEYED}:provider:${PIP_KEYED}:claude-opus-5-5`], `${at}: Escape is Back, on the chosen model`);
      await x.click(`.dgc-mp-row[data-value="provider:${PIP_KEYED}:claude-opus-5-5"]`);
      await x.click(".dgc-mp-done");
      assert.equal(await x.inPips((root) => !!root.querySelector(".dgc-mp-layer")), false, `${at}: Done closes the picker`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("a Pip on a DGC before Pips API 104: the Sub-agents tab is read-only, as it was", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOnePips(browser, { width: 300, height: 760, api: 103, scene: { sub: true, fix: "none", posts: false, waiting: false, attention: false, models: PIP_MODELS, catalog: PIP_CATALOG } });
  try {
    await x.openPip(GST); await x.page.waitForTimeout(200);
    await x.click("#chat-model"); await x.waitIn(".dgc-mp .dgc-mp-row");
    await x.click('.dgc-mp-tab[data-tab="agents"]'); await x.waitIn('.dgc-mp-conn[data-rail="pip"]');
    assert.deepEqual(await x.inPips((root) => [...root.querySelectorAll(".dgc-mp-conn")].map((b) => b.dataset.rail)), ["pip"]);
    await x.click(".dgc-mp-row");
    assert.equal(await x.inPips((root) => !!root.querySelector(".dgc-mp-page:not([hidden])")), false, "no page");
    assert.equal(await x.inPips((root) => root.querySelectorAll(".dgc-mp-more").length), 0);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
