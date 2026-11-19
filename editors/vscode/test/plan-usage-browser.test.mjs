// ChatGPT · your plan in the one model picker, and the usage meter, on all three surfaces (0.52), in real Chromium:
// Work (media/main.js), ChatDGC (media/chatdgc.js) and a Pip's chat (src/pipsClient.js), each on the shared modules
// (media/shared/modelpicker.js MP.planConnection, media/shared/usagemeter.js). The rail has a "ChatGPT · your plan"
// entry: not connected it offers Connect (the sign-in runs in the extension), connected it lists the plan's models in
// the plan's own order. "Using ChatGPT plan" sits near the picker while requests use the plan. The meter sits beside
// the context meter only when the connection reports usage; its one link and a used-up limit's Manage usage are
// asked for by name, never by address.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { launchArgs } from "./support/uir2b-scene.mjs";
import { ROUTES, modelsMessage } from "./support/model-menu-scene.mjs";
import { THEMES } from "./support/options-scene.mjs";
import { readStylesheet } from "./support/stylesheet.mjs";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";
import { PIP_CATALOG, PIP_MODELS } from "./support/model-menu-scene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const NOW = Math.floor(Date.now() / 1000);
const PLAN_ID = `provider_${"e".repeat(32)}`;
const PLAN_MODELS = ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-luna"];   // (the plan's own order, not sorted)
const METER = { source: "chatgpt_plan", limited: false, at: Date.now(), windows: [
  { id: "primary", used_percent: 82, window_minutes: 300, resets_at: NOW + 3600 },
  { id: "secondary", used_percent: 97, window_minutes: 10080, resets_at: NOW + 3 * 86400 }] };
const rail = (page, sel = ".dgc-mp-conn") => page.evaluate((s) => [...document.querySelectorAll(s)].map((b) => [b.title, b.querySelector(".dgc-mp-mark")?.dataset.mark || "", b.getAttribute("aria-selected")]), sel);

// ---- Work ----
const workOpen = async (width, message) => {
  const s = await openMapScene(browser, { width, height: 760, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
  s.page.setDefaultTimeout(4000);
  if (message) { await s.page.click("#btn-model"); await s.post(message); await s.page.waitForSelector(".dgc-mp .dgc-mp-conn"); await s.page.waitForTimeout(120); }
  return s;
};
const posted = (page, type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);

test("Work: not connected, the rail's ChatGPT · your plan offers Connect; waiting it offers Cancel; the sign-in is the extension's", async (t) => {
  if (skipOrFail(t)) return;
  const { page, post } = await workOpen(440, { ...modelsMessage(), routes: [...ROUTES, { key: "chatgpt_plan", label: "ChatGPT · your plan", kind: "plan_offer", plan: "none" }] });
  try {
    const conns = await rail(page);
    assert.deepEqual(conns.at(-1), ["ChatGPT · your plan", "openai", "false"], "last on the rail, OpenAI's mark, no key badge");
    await page.click('.dgc-mp-conn[data-rail="chatgpt_plan"]');
    assert.equal(await page.textContent(".dgc-mp-head"), "ChatGPT · your plan", "its name says it is the plan, once");
    assert.match(await page.textContent(".dgc-mp-list"), /ChatGPT Plus or Pro plan here: sign in with ChatGPT/);
    await page.click('.dgc-mp-under [data-foot="planConnect"]');
    assert.deepEqual(await posted(page, "connectPlan"), [{ type: "connectPlan", id: "" }]);
    assert.match(await page.textContent(".dgc-mp-list"), /Sign in on the ChatGPT page that opened in your browser/, "waiting at once");
    await post({ type: "planConnecting", waiting: true });
    await page.click('.dgc-mp-under [data-foot="planCancel"]');
    assert.deepEqual(await posted(page, "cancelPlanConnect"), [{ type: "cancelPlanConnect" }]);
    await post({ type: "planConnecting", waiting: false, error: "Connecting was cancelled." });
    assert.match(await page.textContent(".dgc-mp-list"), /Connecting was cancelled\./);
    assert.ok(await page.locator('.dgc-mp-under [data-foot="planConnect"]').isVisible(), "Connect again");
    // The Sub-agents tab has no offer: a plan not connected isn't somewhere to run helpers.
    await page.click('.dgc-mp-tab[data-tab="agents"]');
    assert.equal(await page.locator('.dgc-mp-conn[data-rail="chatgpt_plan"]').count(), 0);
  } finally { await page.close(); }
});

test("Work: connected, the plan lists its models in its own order and says Using ChatGPT plan; signed out it says Connect again", async (t) => {
  if (skipOrFail(t)) return;
  const plan = { key: PLAN_ID, label: "ChatGPT · your plan", kind: "native", base_url: "https://api.openai.com/v1", model: "", allModels: true, plan: "connected" };
  const msg = { ...modelsMessage(), ids: PLAN_MODELS, current: "gpt-6-luna", base: "https://api.openai.com/v1", routes: [ROUTES[0], plan], currentRouteKey: PLAN_ID,
    fallback: { offered: false }, agents: { offered: false } };
  const { page, post, send } = await workOpen(700);
  try {
    // (An idle chat: the scene's running turn and its agents pill end, as they do between turns.)
    await send({ type: "turn_end", reason: "completed" });
    await page.evaluate(() => { document.getElementById("agents-picker").hidden = true; document.getElementById("queue-send").hidden = true; });
    await post({ type: "usageMeter", meter: null, plan: true });
    await page.click("#btn-model"); await post(msg); await page.waitForSelector(".dgc-mp .dgc-mp-row");
    assert.deepEqual((await rail(page)).map(([title, mark]) => [title, mark]), [["Ollama", "ollama"], ["ChatGPT · your plan", "openai"]]);
    assert.deepEqual(await page.locator(".dgc-mp-list .dgc-mp-name").allInnerTexts(), PLAN_MODELS, "the plan's order");
    assert.equal(await page.textContent(".dgc-mp-head"), "ChatGPT · your plan", "its name says it is the plan, once");
    assert.match(await page.textContent(".dgc-mp-under"), /Using ChatGPT plan/);
    await page.keyboard.press("Escape");
    // Beside the picker on the prompt box too, and in the model button's own words where the row is narrow (640 px or less).
    assert.equal(await page.isVisible("#plan-note"), true);
    assert.equal(await page.textContent("#plan-note"), "Using ChatGPT plan");
    const note = await page.locator("#plan-note").boundingBox(), model = await page.locator("#btn-model").boundingBox();
    assert.ok(note.x + note.width <= model.x + 1 && Math.abs((note.y + note.height / 2) - (model.y + model.height / 2)) < 3, "just left of the model button, on its line");
    await page.setViewportSize({ width: 300, height: 760 }); await page.waitForTimeout(100);
    assert.equal(await page.isVisible("#plan-note"), false);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#btn-model .model-copy"), "::before").content), '"ChatGPT plan"');
    assert.match(await page.getAttribute("#btn-model", "aria-label"), /Using ChatGPT plan/);
    // Signed out: Connect again, for that saved row.
    await page.setViewportSize({ width: 440, height: 760 });
    await page.click("#btn-model"); await post({ ...msg, routes: [ROUTES[0], { ...plan, plan: "signed_out" }], currentRouteKey: ROUTES[0].key, ids: ["qwen3.8:27b"], current: "qwen3.8:27b", base: "http://127.0.0.1:11434/v1" });
    await page.waitForSelector(".dgc-mp .dgc-mp-conn");
    await page.click(`.dgc-mp-conn[data-rail="${PLAN_ID}"]`);
    assert.match(await page.textContent(".dgc-mp-list"), /Signed out of ChatGPT/);
    await page.click('.dgc-mp-under [data-foot="planConnect"]');
    assert.deepEqual((await posted(page, "connectPlan")).at(-1), { type: "connectPlan", id: PLAN_ID });
  } finally { await page.close(); }
});

test("Work: the meter beside the context meter only when its connection reports usage; its pop-up and its one link", async (t) => {
  if (skipOrFail(t)) return;
  const { page, post } = await workOpen(700);
  try {
    assert.equal(await page.locator("#btn-usage").count(), 0, "nothing reported: no meter");
    await post({ type: "usageMeter", meter: METER, plan: true });
    const ctx = await page.locator("#btn-ctx").boundingBox(), meter = await page.locator("#btn-usage").boundingBox();
    assert.ok(meter.x >= ctx.x + ctx.width - 1 && meter.x - (ctx.x + ctx.width) < 12 && Math.abs(meter.y - ctx.y) < 2, "right after the context meter, on its row");
    assert.equal(Math.round(meter.height), Math.round(ctx.height), "the same height as its neighbours");
    assert.equal(await page.getAttribute("#btn-usage", "data-tone"), "err", "its fullest window, above 95%: red");
    await page.click("#btn-usage");
    const rows = await page.evaluate(() => [...document.querySelectorAll(".dgc-um-pop .dgc-um-row")].map((r) => [r.querySelector(".dgc-um-label").textContent, r.querySelector(".dgc-um-pct").textContent, r.dataset.tone, getComputedStyle(r.querySelector(".dgc-um-fill")).backgroundColor]));
    assert.deepEqual(rows.map((r) => r.slice(0, 3)), [["5-hour limit", "82% used", "need"], ["Weekly limit", "97% used", "err"]]);
    const css = await page.evaluate(() => ({ need: getComputedStyle(document.body).getPropertyValue("--need").trim(), err: getComputedStyle(document.body).getPropertyValue("--err").trim(), r: getComputedStyle(document.querySelector(".dgc-um-pop")).borderRadius }));
    assert.equal(css.r, "6px");
    const pop = await page.locator(".dgc-um-pop").boundingBox();
    assert.ok(pop.y + pop.height <= meter.y + 1 && pop.x >= 7 && pop.x + pop.width <= 700 - 7, "above its button, inside the page");
    await page.click(".dgc-um-pop [data-um-link]");
    assert.deepEqual(await posted(page, "openUsagePage"), [{ type: "openUsagePage", source: "chatgpt_plan", page: "usage" }]);
    assert.equal(await page.locator(".dgc-um-pop").count(), 0);
    // OpenRouter's: Top up. A report that goes away takes the meter with it.
    await post({ type: "usageMeter", meter: { source: "openrouter", limited: false, at: 1, windows: [{ id: "daily", used_percent: 30, window_minutes: null, resets_at: NOW + 3600 }] }, plan: false });
    await page.click("#btn-usage");
    assert.equal(await page.textContent(".dgc-um-pop [data-um-link]"), "Top up");
    assert.equal(await page.textContent(".dgc-um-pop .dgc-um-label"), "Daily credit limit");
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "btn-usage", "Escape: back on its button");
    assert.equal(await page.isVisible("#plan-note"), false);
    await post({ type: "usageMeter", meter: null, plan: false });
    assert.equal(await page.locator("#btn-usage").count(), 0);
  } finally { await page.close(); }
});

test("Work: a used-up plan's error says so, when it resets, and its way out is Manage usage", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send } = await workOpen(440);
  try {
    await send({ type: "turn_start", turn_id: "t9", prompt: "hi" });
    await send({ type: "error", message: "Your ChatGPT plan's limit for DGC is used up for now. It resets at 14:05. See how much is left, or change DGC's share, at https://chatgpt.com/settings/usage.",
      cause: { kind: "rate_limited", summary: "Your ChatGPT plan's limit for DGC is used up", action: "manage_usage", resets_at: NOW + 3600, http_status: 429 } });
    await page.waitForSelector(".model-error");
    assert.equal(await page.textContent(".model-error .model-error-headline"), "Your ChatGPT plan's limit for DGC is used up for now.");
    assert.match(await page.textContent(".model-error .model-error-hint"), /It resets at 14:05\./);
    assert.equal(await page.locator(".model-error .model-error-fix").count(), 1, "one way out, not Settings");
    await page.click(".model-error .model-error-usage");
    assert.deepEqual(await posted(page, "openUsagePage"), [{ type: "openUsagePage", source: "chatgpt_plan", page: "usage" }]);
  } finally { await page.close(); }
});

// ---- ChatDGC ----
let chatCached;
function chatHtml() {
  if (chatCached) return chatCached;
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const doc = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  const page = doc.replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "").replace("font-src ;", "font-src data:;");
  const css = readStylesheet(join(root, "media/main.css")) + readFileSync(join(root, "media/chatdgc.css"), "utf8");
  const scripts = [...doc.matchAll(/asset\("media\/((?:shared\/)?[\w-]+\.js)"\)/g)].map((m) => m[1]);
  const js = scripts.map((f) => readFileSync(join(root, "media", f), "utf8")).join("\n");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  chatCached = { html: page.replace("</head>", `<style>${css}</style></head>`), js, markdownJs, scripts };
  return chatCached;
}
async function chatOpen(width = 700) {
  const { html, js, markdownJs } = chatHtml();
  const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await page.evaluate(([code, md]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
  }, [js, markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  return { page, send, errors, posted: (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type) };
}
const CHAT = { id: `chat_${"a".repeat(32)}`, title: "New chat", model: null, thinking: null, pinned: false, archived: false, temporary: false };

test("ChatDGC: the plan's rail entry, its models, Using ChatGPT plan, the meter and Manage usage", async (t) => {
  if (skipOrFail(t)) return;
  assert.ok(chatHtml().scripts.indexOf("shared/usagemeter.js") >= 0 && chatHtml().scripts.indexOf("shared/usagemeter.js") < chatHtml().scripts.indexOf("chatdgc.js"), "the page loads the meter before its own script");
  const s = await chatOpen();
  const value = `provider:${PLAN_ID}:gpt-6-luna`;
  const profiles = [{ id: PLAN_ID, name: "ChatGPT · your plan", kind: "native", model: "", mark: "openai", badge: "plan", plan: "connected" },
                    { id: `provider_${"a".repeat(32)}`, name: "Ollama", kind: "native", model: "qwen3:32b", mark: "ollama", badge: "" }];
  try {
    await s.send({ type: "opened", conversation: { ...CHAT, model: value }, messages: [], earlier: 0, busy: false });
    await s.send({ type: "models", profiles, defaultId: PLAN_ID, providerId: PLAN_ID, current: value, ids: PLAN_MODELS });
    assert.deepEqual((await s.posted("usageFor")).at(-1), { type: "usageFor", model: value, fresh: false }, "it asks for its model's meter");
    await s.send({ type: "usageMeter", meter: METER, plan: true });
    assert.equal(await s.page.isVisible("#cd-plan-note"), true);
    const ctxShown = await s.page.isVisible("#cd-context");
    const meter = await s.page.locator("#cd-usage").boundingBox(), pill = await s.page.locator("#cd-model-pill").boundingBox();
    assert.ok(meter && meter.x < pill.x, "the meter sits before the model pill, with the context meter" + (ctxShown ? "" : " (no context yet)"));
    await s.page.click("#cd-usage");
    assert.equal(await s.page.locator(".dgc-um-pop .dgc-um-row").count(), 2);
    await s.page.click(".dgc-um-pop [data-um-link]");
    assert.deepEqual((await s.posted("openUsagePage")).at(-1), { type: "openUsagePage", source: "chatgpt_plan", page: "usage" });
    await s.page.click("#cd-model-pill");
    const picker = s.page.locator(".dgc-mp");
    assert.deepEqual((await rail(s.page)).map(([title, mark, on]) => [title, mark, on]), [["ChatGPT · your plan", "openai", "true"], ["Ollama", "ollama", "false"]]);
    assert.deepEqual(await picker.locator(".dgc-mp-list .dgc-mp-name").allInnerTexts(), PLAN_MODELS);
    assert.match(await picker.locator(".dgc-mp-under").textContent(), /Using ChatGPT plan/);
    await s.page.keyboard.press("Escape");
    // Not saved at all: the offer, and Connect through the extension.
    await s.send({ type: "models", profiles: [profiles[1], { id: "chatgpt_plan", name: "ChatGPT · your plan", kind: "plan_offer", model: "", plan: "none", mark: "openai", badge: "plan" }],
      defaultId: profiles[1].id, providerId: profiles[1].id, current: `provider:${profiles[1].id}:qwen3:32b`, ids: ["qwen3:32b"] });
    await s.page.click("#cd-model-pill");
    await s.page.click('.dgc-mp-conn[data-rail="chatgpt_plan"]');
    assert.equal((await s.posted("models")).filter((m) => m.provider === "chatgpt_plan").length, 0, "the offer has no models to ask for");
    await s.page.click('.dgc-mp-under [data-foot="planConnect"]');
    assert.deepEqual((await s.posted("connectPlan")).at(-1), { type: "connectPlan", id: "" });
    await s.page.keyboard.press("Escape");
    // A used-up plan's error: Manage usage.
    await s.send({ type: "error", message: "The model didn't answer: Your ChatGPT plan's limit for DGC is used up for now. It resets on 21 Nov at 09:00. See how much is left, or change DGC's share, at https://chatgpt.com/settings/usage." });
    assert.match(await s.page.textContent("#cd-notice"), /Your ChatGPT plan's limit for DGC is used up for now\. It resets on 21 Nov at 09:00\./);
    await s.page.click("#cd-notice .cd-notice-usage");
    assert.deepEqual((await s.posted("openUsagePage")).at(-1), { type: "openUsagePage", source: "chatgpt_plan", page: "usage" });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// ---- a Pip's chat ----
const bare = (m) => { const { documentId, ...rest } = m || {}; return rest; };   // (the side bar stamps its document on each)
const PIP_PLAN = { id: PLAN_ID, name: "ChatGPT · your plan", default: false, models: PLAN_MODELS, mark: "openai", badge: "plan", plan: "connected" };
const pipOpen = async (catalog, more = {}) => {
  const x = await openOnePips(browser, { width: 440, api: 97, ...more, scene: { sub: true, fix: "none", posts: false, waiting: false, attention: false, models: PIP_MODELS, catalog } });
  await x.openPip(GST); await x.page.waitForTimeout(250);
  return x;
};

test("A Pip's chat: the plan's rail entry, Connect through the extension, the meter beside the context chip and Using ChatGPT plan", async (t) => {
  if (skipOrFail(t)) return;
  const x = await pipOpen({ ...PIP_CATALOG, providers: [...PIP_CATALOG.providers, PIP_PLAN] });
  try {
    const asked = await x.posted("pipUsageMeter");
    assert.ok(asked.length >= 1 && /^pip_[a-f0-9]{32}$/.test(asked.at(-1).pip_id), "the chat asks for its meter");
    const pip = asked.at(-1).pip_id;
    await x.send({ type: "pipUsageMeter", pip_id: pip, meter: METER, plan: true });
    await x.waitIn("#chat-usage");
    assert.deepEqual(await x.inPips((r) => { const m = r.querySelector("#chat-usage").getBoundingClientRect(), c = r.querySelector("#chat-context-toggle")?.getBoundingClientRect();
      return { after: !c || m.left >= c.right - 1, row: !c || Math.abs(m.top - c.top) < 2, tone: r.querySelector("#chat-usage").dataset.tone, note: r.querySelector(".composer-plan-note")?.innerText || "", title: r.querySelector(".composer-plan-note")?.title || "" }; }),
      { after: true, row: true, tone: "err", note: "ChatGPT plan", title: "Using ChatGPT plan: requests use your plan’s allowance" }, "at 440 px its short words; its title says all of it");
    await x.click("#chat-usage");
    assert.equal(await x.inPips((r) => r.querySelectorAll(".dgc-um-pop .dgc-um-row").length), 2, "the pop-up opens in the view's own root");
    await x.click(".dgc-um-pop [data-um-link]");
    assert.deepEqual(bare((await x.posted("pipOpenUsagePage")).at(-1)), { type: "pipOpenUsagePage", source: "chatgpt_plan", page: "usage" });
    // The picker: the plan listed with its models.
    await x.click("#chat-model"); await x.waitIn(".dgc-mp .dgc-mp-conn");
    await x.click(`.dgc-mp-conn[data-rail="provider:${PLAN_ID}"]`);
    assert.deepEqual(await x.inPips((r) => [...r.querySelectorAll(".dgc-mp-list .dgc-mp-name")].map((n) => n.textContent)), PLAN_MODELS);
    assert.equal(await x.inPips((r, id) => r.querySelector(`.dgc-mp-conn[data-rail="provider:${id}"]`).title, PLAN_ID), "ChatGPT · your plan");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  // Not saved: the offer, and Connect.
  const y = await pipOpen({ ...PIP_CATALOG, plan_offer: "none" });
  try {
    await y.click("#chat-model"); await y.waitIn(".dgc-mp .dgc-mp-conn");
    await y.click('.dgc-mp-conn[data-rail="chatgpt_plan"]');
    assert.match(await y.inPips((r) => r.querySelector(".dgc-mp-list").textContent), /sign in with ChatGPT/);
    await y.click('.dgc-mp-under [data-foot="planConnect"]');
    assert.deepEqual(bare((await y.posted("pipPlanConnect")).at(-1)), { type: "pipPlanConnect", id: "" });
    await y.send({ type: "pipPlanConnecting", waiting: true });
    assert.ok(await y.inPips((r) => !!r.querySelector('.dgc-mp-under [data-foot="planCancel"]')));
    assert.deepEqual(y.errors, []);
  } finally { await y.close(); }
});
