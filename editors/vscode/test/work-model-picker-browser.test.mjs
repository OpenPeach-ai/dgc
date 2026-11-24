// Work's model picker (17 Nov): the one picker Work, ChatDGC and a Pip's chat share (media/shared/modelpicker.js), with
// what Work puts in it: this session's route and the saved providers down its rail, each connection's models, the
// session's fallback as Main and Fallback words and a row's ⋯, a second tab for the sub-agents' model, their thinking
// and their window, Claude Code's rows by nickname with the version each ran as, and Thinking with Ultra. It replaces
// Work's own model menu and its thinking slider. On the real panel, in real Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { launchArgs, openThinking } from "./support/uir2b-scene.mjs";
import { IDS, ROUTES, SPARE, claudeMessage, manyRoutes, modelsMessage } from "./support/model-menu-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const open = async (width, height = 760, theme = "dark-modern", message = modelsMessage(), more = {}) => {
  const s = await openMapScene(browser, { width, height, theme, open: false, capabilities: { agents_model: 1, model_fallback: 1 }, ...more });
  s.page.setDefaultTimeout(4000);
  await s.page.click("#btn-model"); await s.post(message); await s.page.waitForSelector(".dgc-mp .dgc-mp-row"); await s.page.waitForTimeout(150);
  return s;
};
const posted = (page, type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const rect = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s); if (!n || !n.checkVisibility()) return null; const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height }; }, sel);
const names = (page) => page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row .dgc-mp-name")].map((n) => n.textContent));
const focusKey = (page) => page.evaluate(() => document.activeElement?.dataset?.k || document.activeElement?.id || document.activeElement?.tagName);
const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

test("the model button opens the one picker, centred over a dim page: the connections' marks, the session's models, Thinking under them", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, wide] of [[300, 268], [700, 520]]) {      // (520 px in a tab since 24 Nov; it was 432)
    const { page } = await open(width);
    try {
      assert.equal(await page.locator("#modelmenu").count(), 0, "Work's own model menu is gone");
      assert.equal(await page.locator(".effort-slider, .reasoning-card").count(), 0, "and so is its thinking slider");
      const box = await rect(page, ".dgc-mp"), layer = await rect(page, ".dgc-mp-layer");
      assert.equal(Math.round(box.w), wide, `${width}px wide`);
      assert.ok(Math.abs(box.left - (width - box.w) / 2) <= 1 && Math.abs((box.top + box.h / 2) - 380) <= 1, "centred");
      assert.deepEqual([layer.left, layer.top, layer.w, layer.h], [0, 0, width, 760], "over the whole page");
      assert.equal(await page.getAttribute("#btn-model", "aria-expanded"), "true");
      const rail = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-conn")].map((b) => [b.title, b.querySelector(".dgc-mp-mark").dataset.mark, b.querySelector(".dgc-mp-badge")?.dataset.badge || "", b.getAttribute("aria-selected"), b.innerText.trim()]));
      assert.deepEqual(rail, [["Ollama", "ollama", "", "true", ""], ["Spare GPU box · your key", "", "key", "false", "S"], ["Claude Code · your subscription", "claudecode", "cli", "false", ""]]);
      // Ollama is one connection, its list in two sections.
      const list = await page.evaluate(() => [...document.querySelector(".dgc-mp-list").children].map((n) => (n.classList.contains("dgc-mp-sec") ? `# ${n.textContent}` : n.querySelector(".dgc-mp-name").textContent)));
      assert.deepEqual(list, ["# On this computer", "codellama:13b", "gpt-oss:120b-32k", "qwen2.5:14b", "qwen3.8:27b", "a-model-with-a-very-long-name-that-goes-on:120b-instruct-q8_0", "# Cloud", "deepseek-v4-pro:cloud", "glm-5.3:cloud"]);
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.dgc-mp-row[aria-selected="true"] .dgc-mp-name')].map((n) => n.textContent)), ["deepseek-v4-pro:cloud"]);
      // The reference (17 Nov): the tabs, then the frame: the rail with Add provider at its foot, and the card with the
      // models and, under them, Thinking.
      const [tabsBox, mainBox, railBox, footBox, listBox, thinkBox] = [await rect(page, ".dgc-mp-tabs"), await rect(page, ".dgc-mp-main"),
        await rect(page, ".dgc-mp-rail"), await rect(page, ".dgc-mp-foot"), await rect(page, ".dgc-mp-list"), await rect(page, ".dgc-mp-think")];
      assert.ok(tabsBox.bottom <= mainBox.top + 1, "the tabs above the frame");
      assert.ok(railBox.bottom <= footBox.top + 1 && footBox.right <= listBox.left, "Add provider at the rail's foot, beside the card");
      assert.ok(listBox.bottom <= thinkBox.top + 1 && thinkBox.bottom <= mainBox.bottom + 1, "Thinking under the models, inside the card");
      assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-think .dgc-mp-effort-stop")].map((b) => b.dataset.level)), ["off", "low", "medium", "high", "xhigh", "ultra"], "Work has Ultra");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    } finally { await page.close(); }
  }
});

test("Main and Fallback at the rows' ends; every row's ⋯ shows only while its row is pointed at, the Fallback row's too", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await open(440);
  try {
    const pills = () => page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].filter((r) => r.querySelector(".dgc-menu-pill")).map((r) => [r.querySelector(".dgc-mp-name").textContent, r.querySelector(".dgc-menu-pill").textContent]));
    assert.deepEqual(await pills(), [["deepseek-v4-pro:cloud", "Main"], ["glm-5.3:cloud", "Fallback"]]);
    const dots = () => page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-item")].map((i) => [i.querySelector(".dgc-mp-name").textContent, Number(getComputedStyle(i.querySelector(".dgc-mp-more")).opacity)]));
    await page.mouse.move(2, 2); await page.waitForTimeout(250);
    assert.ok((await dots()).length >= 6);
    assert.deepEqual((await dots()).filter(([, o]) => o > 0.01), [], "at rest no row shows its ⋯");
    // Another model made the fallback with its ⋯: once the pointer leaves, its ⋯ is hidden like every other row's.
    await page.hover('.dgc-mp-row[data-value="qwen3.8:27b"]'); await page.waitForTimeout(200);
    assert.deepEqual((await dots()).filter(([, o]) => o > 0.5).map(([n]) => n), ["qwen3.8:27b"]);
    await page.click('.dgc-mp-item:has(.dgc-mp-row[data-value="qwen3.8:27b"]) .dgc-mp-more');
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-choices button")].map((b) => b.textContent)), ["Use as main", "Use as fallback"]);
    await page.click(".dgc-mp-choices button:nth-child(2)");
    assert.deepEqual(await posted(page, "setFallback"), [{ type: "setFallback", provider: "", model: "qwen3.8:27b" }]);
    assert.deepEqual(await pills(), [["qwen3.8:27b", "Fallback"], ["deepseek-v4-pro:cloud", "Main"]]);
    await page.mouse.move(2, 2); await page.keyboard.press("Tab"); await page.keyboard.press("Shift+Tab"); await page.mouse.move(3, 3); await page.waitForTimeout(300);
    const shown = (await dots()).filter(([, o]) => o > 0.01).map(([n]) => n);
    assert.ok(!shown.includes("glm-5.3:cloud"), "the row that was the fallback shows no ⋯ at rest");
    // The ⋯ never covers the row's check or its word.
    await page.hover('.dgc-mp-row[data-value="deepseek-v4-pro:cloud"]'); await page.waitForTimeout(200);
    const over = await page.evaluate(() => { const item = document.querySelector('.dgc-mp-row[data-value="deepseek-v4-pro:cloud"]').parentElement, more = item.querySelector(".dgc-mp-more").getBoundingClientRect();
      return [".dgc-mp-check", ".dgc-menu-pill", ".dgc-mp-name"].map((s) => { const r = item.querySelector(s).getBoundingClientRect(); return [s, !(r.right <= more.left + 0.5 || r.left >= more.right - 0.5)]; }); });
    assert.deepEqual(over.filter(([, hit]) => hit), [], "its ⋯ sits clear of the name, the word and the check");
  } finally { await page.close(); }
});

test("the Sub-agents tab: Settings' choice first; their thinking (no Ultra) and their window are its page's; a subscription app is greyed with its reason", async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await open(440);
  try {
    await page.click('.dgc-mp-tab[data-tab="agents"]');
    assert.deepEqual(await posted(page, "getAgentsModel"), [{ type: "getAgentsModel" }]);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-tab")].map((b) => [b.textContent, b.getAttribute("aria-selected")])), [["Main model", "false"], ["Sub-agents", "true"]]);
    assert.equal(await focusKey(page), "tab:agents", "the focus stays on the tab");
    const rail = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-conn")].map((b) => [b.title, b.getAttribute("aria-selected"), b.getAttribute("aria-disabled")]));
    assert.deepEqual(rail, [["Settings’ choice", "true", null], ["Ollama", "false", null], ["Spare GPU box · your key", "false", null], ["Claude Code · your subscription", "false", "true"]]);
    assert.deepEqual(await names(page), ["Settings’ choice"]);
    assert.equal(await page.textContent(".dgc-mp-row .dgc-mp-desc"), "Now: same as this session’s model");
    assert.equal(await page.locator(".dgc-mp-think:visible, .dgc-mp-settings:visible").count(), 0, "under the list: neither (they are the page's, 17 Nov)");
    // Settings' choice opens its page: their thinking, their window, Done.
    await page.click(".dgc-mp-row");
    assert.equal(await page.textContent(".dgc-mp-page-name"), "Settings’ choice");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-page .dgc-mp-think-name")].map((n) => n.textContent)), ["Their thinking", "Their context window"]);
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("[data-pthink]")].map((b) => [b.dataset.pthink, b.textContent, b.getAttribute("aria-checked")])),
      [["same", "Same", "true"], ["off", "Off", "false"], ["low", "Low", "false"], ["medium", "Medium", "false"], ["high", "High", "false"], ["xhigh", "Extra high", "false"]], "no Ultra for sub-agents");
    assert.equal(await page.getAttribute('[data-pthink="same"]', "title") ?? await page.getAttribute('[data-pthink="same"]', "data-tip"), "Same as the session");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-size")].map((b) => b.textContent)), ["Same", "4K", "8K", "16K", "32K", "64K", "128K", "256K", "512K", "1M"],
      "a DGC that can't say the model's window: every size");
    await page.click('[data-pthink="high"]');
    assert.deepEqual(await posted(page, "setAgentsThinking"), [{ type: "setAgentsThinking", level: "high" }]);
    assert.equal(await page.getAttribute('[data-pthink="high"]', "aria-checked"), "true", "shown at once");
    assert.deepEqual(await posted(page, "setReasoningProfile"), [], "the session's own thinking never moves");
    await page.click('.dgc-mp-size[data-size="65536"]');
    assert.deepEqual(await posted(page, "setAgentsContext"), [{ type: "setAgentsContext", size: 65536 }]);
    assert.equal(await page.getAttribute('.dgc-mp-size[data-size="65536"]', "aria-checked"), "true");
    await page.click(".dgc-mp-back");
    assert.equal(await focusKey(page), "r:agents:settings:same", "back on Settings' choice");
    // A saved provider's models for the sub-agents: asked of its host when it is looked at.
    await page.click(`.dgc-mp-conn[data-rail="${SPARE}"]`);
    assert.deepEqual(await posted(page, "providerModels"), [{ type: "providerModels", id: SPARE }]);
    assert.equal(await page.textContent(".dgc-mp-list"), "Listing its models…");
    // Claude Code: shown, greyed, with why.
    await page.click('.dgc-mp-conn[data-rail="subscription_claude"]', { force: true });
    assert.equal(await page.textContent(".dgc-mp-list"), "Runs its own tools, so it can’t run DGC’s agents.");
    assert.equal(await page.locator(".dgc-mp-more").count(), 0, "nothing of it to choose");
    assert.deepEqual(await posted(page, "agentsContextTyped"), [], "no editor input box for a size any more");
  } finally { await page.close(); }
});

test("what DGC says the sub-agents use shows on their page; a DGC that cannot set one shows neither", async (t) => {
  if (skipOrFail(t)) return;
  const said = await open(440, 760, "dark-modern", modelsMessage({ thinking: "medium", context_size: 32768, own: true, model: "gpt-oss:120b", base_url: "https://spare.example/v1" }));
  try {
    await said.page.click('.dgc-mp-tab[data-tab="agents"]');
    assert.equal(await said.page.getAttribute(`.dgc-mp-conn[data-rail="${SPARE}"]`, "aria-selected"), "true", "the tab opens on where their own model runs");
    await said.post({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "other:1"] });
    assert.deepEqual(await said.page.evaluate(() => [...document.querySelectorAll('.dgc-mp-row[aria-selected="true"] .dgc-mp-name')].map((n) => n.textContent)), ["gpt-oss:120b"]);
    await said.page.click('.dgc-mp-row[aria-selected="true"]');
    assert.equal(await said.page.evaluate(() => document.querySelector('[data-pthink][aria-checked="true"]').dataset.pthink), "medium");
    assert.equal(await said.page.evaluate(() => document.querySelector('.dgc-mp-size[aria-checked="true"]').textContent), "32K");
    assert.deepEqual(await posted(said.page, "setAgentsModel"), [], "the chosen one again: its page, nothing saved");
  } finally { await said.page.close(); }
  const plain = await open(440, 760, "dark-modern", modelsMessage({ thinking_settable: false, context_settable: false }));
  try {
    await plain.page.click('.dgc-mp-tab[data-tab="agents"]');
    assert.equal(await plain.page.locator(".dgc-mp-think:visible, .dgc-mp-settings:visible").count(), 0, "neither row");
    assert.deepEqual(await names(plain.page), ["Settings’ choice"]);
    await plain.page.click(".dgc-mp-row");
    assert.equal(await plain.page.locator("[data-pthink], .dgc-mp-size").count(), 0);
    assert.equal(await plain.page.textContent(".dgc-mp-page .dgc-mp-say"), "This DGC can’t set their thinking or their window. Update DGC CLI.");
  } finally { await plain.page.close(); }
});

test("Claude Code's rows: each nickname with the version it last ran as, then the fixed versions; choosing one names it to DGC", async (t) => {
  if (skipOrFail(t)) return;
  const here = await open(440, 760, "dark-modern", claudeMessage("opus"));
  try {
    assert.equal((await here.page.evaluate(() => document.querySelector(".dgc-mp-head").innerText)).replace(/\s+/g, " ").trim(), "Claude Code your subscription");
    const rows = await here.page.evaluate(() => [...document.querySelector(".dgc-mp-list").children].map((n) => (n.classList.contains("dgc-mp-sec") ? `# ${n.textContent}` : `${n.querySelector(".dgc-mp-name").textContent} | ${n.querySelector(".dgc-mp-desc")?.textContent || ""}`)));
    assert.deepEqual(rows, ["CLI default | Whatever Claude Code is set to use", "Fable (newest) | Follows the newest Fable. Its version shows after its first use", "Opus 5.5 | Follows the newest Opus · now claude-opus-5-5",
      "Sonnet (newest) | Follows the newest Sonnet. Its version shows after its first use", "Haiku (newest) | Follows the newest Haiku. Its version shows after its first use", "# Fixed versions",
      "Fable 5.2 | claude-fable-5-2 · stays on this version", "Opus 5.5 | claude-opus-5-5 · stays on this version", "Sonnet 5.5 | claude-sonnet-5-5 · stays on this version", "Haiku 5.5 | claude-haiku-5-5 · stays on this version"]);
    assert.deepEqual(await here.page.evaluate(() => [...document.querySelectorAll('.dgc-mp-row[aria-selected="true"]')].map((r) => r.dataset.value)), ["opus"], "the nickname is the chosen one, not the version it runs as today");
    assert.deepEqual(await here.page.evaluate(() => [...document.querySelectorAll(".dgc-mp-think .dgc-mp-effort-stop")].map((b) => b.dataset.level)), ["off", "low", "medium", "high", "xhigh", "max", "ultra"], "Claude Code's levels, and Ultra");
    await here.page.click('.dgc-mp-row[data-value="claude-sonnet-5-5"]');
    assert.deepEqual(await posted(here.page, "setModel"), [{ type: "setModel", model: "claude-sonnet-5-5" }], "a fixed version is sent by its full name: it stays on it");
    assert.equal(await here.page.locator(".dgc-mp-layer").count(), 0, "choosing a model closes the picker");
    assert.equal(await focusKey(here.page), "btn-model", "and the focus is back on the model button");
  } finally { await here.page.close(); }
  // From another connection: the session moves to Claude Code on that model in one step.
  const from = await open(440);
  try {
    await from.page.click('.dgc-mp-conn[data-rail="subscription_claude"]');
    assert.deepEqual((await names(from.page)).slice(0, 3), ["CLI default", "Fable (newest)", "Opus 5.5"]);
    assert.deepEqual(await from.page.evaluate(() => [...document.querySelectorAll('.dgc-mp-row[aria-selected="true"]')].length), 0, "nothing of it is chosen while the session is elsewhere");
    await from.page.click('.dgc-mp-row[data-value="fable"]');
    assert.deepEqual(await posted(from.page, "setSubscription"), [{ type: "setSubscription", engine: "subscription_claude", model: "fable" }]);
  } finally { await from.page.close(); }
});

test("a saved provider's models are asked of its host when it is looked at or searched; choosing one moves the session there", async (t) => {
  if (skipOrFail(t)) return;
  const { page, post } = await open(440);
  try {
    assert.deepEqual(await posted(page, "providerModels"), [], "nothing is asked until then");
    await page.click(".dgc-mp-q"); await page.keyboard.type("oss");
    assert.deepEqual(await posted(page, "providerModels"), [{ type: "providerModels", id: SPARE }], "a search spans every connection");
    assert.equal(await page.textContent(".dgc-mp-conn-kind"), "still listing…");
    await post({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "gpt-oss:20b"] });
    const found = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].map((r) => [r.dataset.conn.slice(0, 9), r.querySelector(".dgc-mp-name").textContent, !!r.querySelector(".dgc-mp-row-mark")]));
    assert.deepEqual(found, [["provider_", "gpt-oss:120b-32k", true], ["provider_", "gpt-oss:120b", true], ["provider_", "gpt-oss:20b", true]]);
    assert.equal(await page.inputValue(".dgc-mp-q"), "oss", "the words typed stay");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
    assert.deepEqual(await posted(page, "setSubscription"), [{ type: "setSubscription", engine: SPARE, model: "gpt-oss:120b" }]);
    assert.deepEqual(await posted(page, "prompt"), [], "nothing typed in the picker reached the prompt box");
  } finally { await page.close(); }
});

test("twelve connections: the rail scrolls with no scrollbar and the picker keeps its size; two: the same picker", async (t) => {
  if (skipOrFail(t)) return;
  const many = await open(300, 600, "dark-modern", { ...modelsMessage(), routes: manyRoutes(10), currentRouteKey: "subscription_codex", subscription: true, ids: ["gpt-5.6-sol", "gpt-5.6-luna"], current: "gpt-5.6-luna", label: "Codex", cliDefaultModel: "gpt-5.6-sol", cliDefaultListed: true });
  try {
    const facts = await many.page.evaluate(() => { const rail = document.querySelector(".dgc-mp-rail"), on = rail.querySelector('[aria-selected="true"]'), a = rail.getBoundingClientRect(), b = on.getBoundingClientRect();
      return { count: rail.children.length, scrolls: rail.scrollHeight > rail.clientHeight, bar: rail.offsetWidth - rail.clientWidth, on: on.title, inView: b.top >= a.top - 1 && b.bottom <= a.bottom + 1,
        marks: [...rail.querySelectorAll(".dgc-mp-mark")].map((m) => m.dataset.mark), badges: [...rail.querySelectorAll(".dgc-mp-conn")].map((c) => c.querySelector(".dgc-mp-badge")?.dataset.badge || "") }; });
    assert.equal(facts.count, 14);
    assert.ok(facts.scrolls && facts.bar <= 1, "it scrolls, with no scrollbar");
    assert.deepEqual([facts.on, facts.inView], ["Codex · your subscription", true], "the session's own connection, the last, is in view");
    assert.deepEqual(facts.marks, ["ollama", "", "claudecode", "openai", "anthropic", "openrouter", "groq", "deepseek", "mistral", "lmstudio", "ollama", "together", "vllm", "openai"]);
    assert.deepEqual(facts.badges, ["", "key", "cli", "key", "key", "key", "key", "key", "key", "", "cloud", "key", "", "cli"], "a subscription app and its company's key wear one mark and different badges");
    const box = await rect(many.page, ".dgc-mp");
    assert.ok(box.top >= 15 && box.bottom <= 585, `inside the page, 16 px clear (${box.top}–${box.bottom})`);
    assert.deepEqual(await names(many.page), ["CLI default", "gpt-5.6-luna", "gpt-5.6-sol"]);
    assert.equal(await many.page.textContent('.dgc-mp-row[data-value=""] .dgc-mp-desc'), "Now gpt-5.6-sol");
  } finally { await many.page.close(); }
  const two = await open(300, 600, "dark-modern", { ...modelsMessage(), routes: ROUTES.slice(0, 2) });
  try { assert.equal(await two.page.locator(".dgc-mp-conn").count(), 2); assert.equal(Math.round((await rect(two.page, ".dgc-mp")).w), 268); } finally { await two.page.close(); }
});

for (const [width, height] of [[300, 900], [300, 600], [220, 700]]) test(`the picker fits ${width} × ${height}: its list scrolls, several rows show, and nothing is cut sideways`, async (t) => {
  if (skipOrFail(t)) return;
  const { page } = await open(width, height);
  try {
    const box = await rect(page, ".dgc-mp"), list = await rect(page, ".dgc-mp-list");
    assert.ok(box.left >= 15.5 && box.right <= width - 15.5 && box.top >= 15.5 && box.bottom <= height - 15.5, `16 px clear on every side (${JSON.stringify(box)})`);
    const rows = await page.evaluate(() => { const l = document.querySelector(".dgc-mp-list").getBoundingClientRect(); return [...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].filter((r) => { const b = r.getBoundingClientRect(); return b.top >= l.top - 1 && b.bottom <= l.bottom + 1; }).length; });
    assert.ok(rows >= 2, `${rows} whole rows show`);
    assert.ok(list.h >= 76, `the list keeps room (${list.h}px)`);
    const cut = await page.evaluate(() => [...document.querySelectorAll(".dgc-mp-think-now, .dgc-mp-effort-ends span, .dgc-mp-tab, .dgc-mp-think-name, .dgc-mp-conn-name")].filter((n) => n.scrollWidth > n.clientWidth + 0.5).map((n) => n.textContent));
    assert.deepEqual(cut, [], "no control's word is cut");
    assert.equal(await page.evaluate(() => document.querySelector(".dgc-mp").scrollWidth <= document.querySelector(".dgc-mp").clientWidth + 1), true, "nothing runs off its side");
    // The chosen model is in sight when it opens.
    const on = await page.evaluate(() => { const l = document.querySelector(".dgc-mp-list").getBoundingClientRect(), b = document.querySelector('.dgc-mp-row[aria-selected="true"]').getBoundingClientRect(); return b.top >= l.top - 1 && b.bottom <= l.bottom + 1; });
    assert.equal(on, true, "the chosen model is scrolled into view");
  } finally { await page.close(); }
});

test("Escape closes only the picker and the focus returns to the model button; with motion on it arrives once and stays", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openMapScene(browser, { width: 440, height: 760, theme: "light-modern", open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
  try {
    await s.page.emulateMedia({ reducedMotion: "no-preference" });
    await s.page.click("#btn-model");
    assert.equal(await s.page.textContent(".dgc-mp-conn-name"), "Loading…", "it opens at once, before DGC answers");
    await s.post(modelsMessage());
    await s.page.waitForSelector(".dgc-mp .dgc-mp-row");
    await s.page.waitForFunction(() => document.querySelector(".dgc-mp").getAnimations().every((a) => a.playState === "finished") && getComputedStyle(document.querySelector(".dgc-mp")).opacity === "1");
    assert.equal(await focusKey(s.page), "r:" + ROUTES[0].key + ":deepseek-v4-pro:cloud", "the focus rests on the chosen model once its list is in");
    await s.post(modelsMessage());                                  // (DGC's list again: drawn in place)
    assert.equal(await s.page.evaluate(() => [document.querySelector(".dgc-mp"), document.querySelector(".dgc-mp-layer")].flatMap((n) => n.getAnimations()).filter((a) => a.playState === "running").length), 0, "it does not arrive a second time");
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.locator(".dgc-mp-layer").count(), 0);
    assert.equal(await focusKey(s.page), "btn-model");
    assert.equal(await s.page.getAttribute("#btn-model", "aria-expanded"), "false");
    await s.post(modelsMessage());
    assert.equal(await s.page.locator(".dgc-mp-layer").count(), 0, "a late answer never opens it again");
    await s.page.click("#btn-model"); await s.post(modelsMessage()); await s.page.waitForSelector(".dgc-mp .dgc-mp-row");
    await s.page.mouse.click(8, 8);
    assert.equal(await s.page.locator(".dgc-mp-layer").count(), 0, "a click outside closes it");
  } finally { await s.page.close(); }
});

// ---- Thinking (user test W15, 15 Nov): the level is chosen when the keys rest; DGC is told once ---------------------
test("W15: arrow keys along the levels are one choice: the button follows at once, and DGC is told once, when they rest", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openThinking(browser, { think: "low" });
  try {
    const start = await x.now();
    assert.equal(start.value, "low"); assert.equal(start.button, "Low");
    await x.page.focus('.dgc-mp-think .dgc-mp-effort');
    const seen = [];
    for (let i = 0; i < 3; i++) { await x.page.keyboard.press("ArrowRight"); await x.page.waitForTimeout(150); const n = await x.now(); seen.push([n.value, same(n.button, n.word), await focusKey(x.page)]); }
    assert.deepEqual(seen.map(([v]) => v), start.levels.slice(start.levels.indexOf("low") + 1, start.levels.indexOf("low") + 4), "each key is one level");
    assert.ok(seen.every(([, same]) => same), "the button says the picker's level at every step, at once");
    assert.deepEqual(seen.map(([, , k]) => k), seen.map(() => "effort"), "the focus stays on the slider");
    assert.deepEqual(await x.sent(), [], "nothing is sent while the keys are still moving");
    assert.equal((await x.now()).menu, true, "the picker stays open for the next step");
    // DGC says the level it had (an answer on its way): the button keeps the level just chosen.
    await x.state("low");
    { const n = await x.now(); assert.ok(same(n.button, n.word), `the button still says ${n.word} (${n.button})`); assert.equal(n.value, seen.at(-1)[0], "and so does the picker"); }
    await x.page.waitForTimeout(900);
    const sent = await x.sent();
    assert.deepEqual(sent.map((m) => m.level), [seen.at(-1)[0]], "one request, for where the keys came to rest");
    await x.state(sent[0].level);
    const end = await x.now();
    assert.ok(same(end.button, end.word)); assert.equal(end.value, sent[0].level);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("W15: back where it started sends nothing; leaving the levels sends at once; a click is one request and the picker stays", async (t) => {
  if (skipOrFail(t)) return;
  const back = await openThinking(browser, { think: "medium" });
  try {
    await back.page.focus('.dgc-mp-think .dgc-mp-effort');
    await back.page.keyboard.press("ArrowRight"); await back.page.waitForTimeout(120); await back.page.keyboard.press("ArrowLeft"); await back.page.waitForTimeout(900);
    assert.deepEqual(await back.sent(), [], "the level it already had is not asked for again: no line in the session");
    assert.equal((await back.now()).button, "Medium");
    // Tab away right after a key: the choice is sent then, not after the wait.
    await back.page.focus('.dgc-mp-think .dgc-mp-effort'); await back.page.keyboard.press("ArrowRight"); await back.page.keyboard.press("Tab"); await back.page.waitForTimeout(80);
    assert.deepEqual((await back.sent()).map((m) => m.level), ["high"]);
  } finally { await back.page.close(); }
  const closed = await openThinking(browser, { think: "medium" });
  try {
    await closed.page.focus('.dgc-mp-think .dgc-mp-effort'); await closed.page.keyboard.press("ArrowLeft"); await closed.page.keyboard.press("Escape"); await closed.page.waitForTimeout(60);
    assert.deepEqual((await closed.sent()).map((m) => m.level), ["low"], "closing the picker right after a key sends it then");
  } finally { await closed.page.close(); }
  const click = await openThinking(browser, { think: "off" });
  try {
    await click.page.click('.dgc-mp-effort-stop[data-level="high"] > i'); await click.page.waitForTimeout(60);
    const sent = await click.sent(), after = await click.now();
    assert.deepEqual(sent.map((m) => m.level), ["high"], "a click is the one request, at once");
    assert.equal(after.menu, true, "and the picker stays open"); assert.equal(after.button, "High", "the button says it at once");
    // What DGC says on the way (the level before) never shows; its own answer settles it.
    await click.state("off"); assert.equal((await click.now()).button, "High"); assert.equal((await click.now()).value, "high");
    await click.state("high"); assert.equal((await click.now()).button, "High");
    await click.page.click('.dgc-mp-effort-stop[data-level="ultra"] > i'); await click.page.waitForTimeout(60);
    assert.deepEqual((await click.sent()).map((m) => m.level), ["high", "ultra"]);
    assert.equal(await click.page.evaluate(() => document.querySelector(".dgc-mp-think").classList.contains("is-ultra")), true);
  } finally { await click.page.close(); }
});

test("W15: a level DGC never takes goes back to what DGC last said", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openThinking(browser, { think: "low" });
  try {
    await x.page.evaluate(() => { const real = window.setTimeout; window.setTimeout = (fn, ms, ...a) => real(fn, ms >= 5000 ? 300 : ms, ...a); });   // (the six seconds DGC is given, shortened)
    await x.page.click('.dgc-mp-effort-stop[data-level="medium"] > i'); await x.page.waitForTimeout(60);
    assert.equal((await x.now()).button, "Medium");
    await x.page.waitForTimeout(500);
    assert.equal((await x.now()).button, "Low", "DGC said nothing: the button says the level it is really at");
    assert.equal((await x.now()).value, "low", "and so does the open picker");
  } finally { await x.page.close(); }
});

// 24 Nov: what the provider says each model can do (src/modelcaps.ts) reaches Work's page as its own message,
// modelCaps {id: the route, caps}: the rows of that connection take its marks over the guess from their names, and a
// model without tools wears a quiet No tools. A connection it wasn't for keeps its guesses.
test("modelCaps: the provider's marks replace the names' guesses on that connection's rows, on both tabs", async (t) => {
  if (skipOrFail(t)) return;
  const { page, post } = await open(700);
  try {
    const marks = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll(".dgc-mp-list .dgc-mp-row")].map((r) => [r.querySelector(".dgc-mp-name").textContent, [...r.querySelectorAll(".dgc-mp-cap")].map((c) => c.dataset.cap)])));
    const before = await marks();
    assert.deepEqual([before["qwen3.8:27b"], before["codellama:13b"]], [["thinks"], []], "premise: the names' guesses");
    const said = { "qwen3.8:27b": { thinks: true, images: true, tools: true }, "codellama:13b": { thinks: false, images: false, tools: false }, "glm-5.3:cloud": { thinks: true, images: false, tools: true } };
    await post({ type: "modelCaps", id: SPARE, caps: { "qwen3.8:27b": { thinks: false, images: false, tools: false } } });
    await page.waitForTimeout(100);
    assert.deepEqual((await marks())["qwen3.8:27b"], ["thinks"], "another connection's map: not this one's rows");
    await post({ type: "modelCaps", id: ROUTES[0].key, caps: said });
    await page.waitForFunction(() => !!document.querySelector('.dgc-mp-cap[data-cap="notools"]'));
    const after = await marks();
    assert.deepEqual(after["qwen3.8:27b"], ["thinks", "images"], "it sees images: its provider says so");
    assert.deepEqual(after["codellama:13b"], ["notools"]);
    assert.deepEqual(after["glm-5.3:cloud"], ["cloud", "thinks"]);
    assert.deepEqual(after["gpt-oss:120b-32k"], before["gpt-oss:120b-32k"], "nothing said of it: its guess");
    assert.equal(await page.locator(".dgc-mp-row", { hasText: "codellama:13b" }).locator('.dgc-mp-cap[data-cap="notools"]').getAttribute("aria-label"), "No tools: it can only answer, not run steps");
    // The Sub-agents tab lists the same connection: the same marks.
    await page.click('.dgc-mp-tab[data-tab="agents"]');
    await page.click(`.dgc-mp-conn[data-rail="${ROUTES[0].key}"]`);
    await post({ type: "providerModels", id: ROUTES[0].key, ids: IDS });
    await page.waitForSelector(".dgc-mp-list .dgc-mp-row");
    const agents = await marks();
    assert.deepEqual(agents["qwen3.8:27b"], ["thinks", "images"]);
    assert.deepEqual(agents["codellama:13b"], ["notools"]);
  } finally { await page.close(); }
});
