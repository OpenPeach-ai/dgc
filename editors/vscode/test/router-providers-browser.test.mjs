// Settings → Models → DGC Router in real Chromium (0.52: one of your providers as a system, and model prices), with
// VS Code's Dark Modern and Light Modern colours, in a 700px tab and a 300px one (a Settings tab beside the chat).
// jsdom has no layout: here the Add choice, the provider list, a provider's models, its card (with and without a key)
// and a model's price boxes are measured: nothing pokes out of its card or the page, nothing overlaps, the price reads
// quietly (the muted grey, never the accent), and each box is big enough to type in. DGC_SHOTS=<dir> keeps pictures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

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

const src = new URL("../src/", import.meta.url).pathname;
const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
  platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
const viewModule = { exports: {} };
new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
const skeleton = viewModule.exports.settingsDocument("SCRIPT", "STYLE", "");

// VS Code's own theme colours (Dark Modern and Light Modern), the variables this page reads.
const THEMES = {
  dark: { body: "vscode-dark", vars: { "--vscode-foreground": "#cccccc", "--vscode-descriptionForeground": "#9d9d9d",
    "--vscode-editor-background": "#1f1f1f", "--vscode-editor-foreground": "#cccccc", "--vscode-editorWidget-background": "#202020",
    "--vscode-input-background": "#313131", "--vscode-input-border": "#3c3c3c", "--vscode-panel-border": "#2b2b2b",
    "--vscode-button-secondaryBackground": "#313131", "--vscode-button-secondaryForeground": "#cccccc",
    "--vscode-button-secondaryHoverBackground": "#3c3c3c", "--vscode-sideBar-background": "#181818" } },
  light: { body: "vscode-light", vars: { "--vscode-foreground": "#3b3b3b", "--vscode-descriptionForeground": "#3b3b3b",
    "--vscode-editor-background": "#ffffff", "--vscode-editor-foreground": "#3b3b3b", "--vscode-editorWidget-background": "#f8f8f8",
    "--vscode-input-background": "#ffffff", "--vscode-input-border": "#cecece", "--vscode-panel-border": "#e5e5e5",
    "--vscode-button-secondaryBackground": "#e5e5e5", "--vscode-button-secondaryForeground": "#3b3b3b",
    "--vscode-button-secondaryHoverBackground": "#cccccc", "--vscode-sideBar-background": "#f8f8f8" } },
};
// What VS Code prepends to every webview's <head>: its body padding and 10px scroll bars, so the page gets its real width.
const VSCODE_WEBVIEW = '<style id="_defaultStyles">@layer vscode-default{body{margin:0;padding:0 20px;font-family:var(--vscode-font-family);'
  + "font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:10px;height:10px}}</style>";

const GROQ = "provider_" + "a".repeat(32), OPENROUTER = "provider_" + "b".repeat(32);
const PROFILES = [
  { id: GROQ, name: "Groq", base_url: "https://api.groq.com/openai/v1", model: "llama-3.3-70b-versatile", api_mode: "chat_completions" },
  { id: OPENROUTER, name: "OpenRouter", base_url: "https://openrouter.ai/api/v1", model: "", api_mode: "chat_completions" },
  { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "sonnet" }];
const GPU = { id: "gpu", name: "GPU box", base_url: "http://gpu-box.local:11434", server: "ollama", enabled: true, jobs: ["subagents", "pips"],
  workers: 2, busy: 0, free: 2, one_model_at_a_time: false, health: { state: "online" }, has_key: false, leases: [],
  models: [{ name: "qwen3:8b", workers: 2, free: 2, context: 32768, params_b: 8.2, tools: true }], available: [{ name: "qwen3:8b" }] };
const GROQ_SYSTEM = { id: "groq", name: "Groq", base_url: "https://api.groq.com/openai", server: "openai_compatible", provider: GROQ, enabled: true,
  jobs: ["subagents", "pips"], workers: 3, busy: 0, free: 3, one_model_at_a_time: false, health: { state: "online" }, has_key: true, leases: [],
  models: [
    { name: "llama-3.3-70b-versatile", workers: 2, free: 2, context: 32768, price_in: 0.59, price_out: 0.79, price_from: "provider", thinks: false },
    { name: "meta-llama/llama-4-maverick-17b-128e-instruct", workers: 1, free: 1, context: 65536, price_in: 0.5, price_out: 0.6, price_from: "you", thinks: true, note: "design" },
    { name: "openai/gpt-oss-20b", workers: 1, free: 1, context: 32768, price_in: 0, price_out: 0, price_from: "provider", thinks: true }],
  available: [{ name: "llama-3.3-70b-versatile", price_in: 0.59, price_out: 0.79, context_max: 131072 },
    { name: "meta-llama/llama-4-maverick-17b-128e-instruct", price_in: 0.2, price_out: 0.6, context_max: 131072 },
    { name: "openai/gpt-oss-20b", price_in: 0, price_out: 0, context_max: 131072 }, { name: "qwen/qwen3-32b", price_in: 0.29, price_out: 0.59 }] };
const OPENROUTER_SYSTEM = { ...GROQ_SYSTEM, id: "openrouter", name: "OpenRouter", base_url: "https://openrouter.ai/api", provider: OPENROUTER, has_key: false,
  health: { state: "unknown" }, models: [{ name: "anthropic/claude-sonnet-4.5", workers: 1, free: 1, context: 65536, price_in: 3, price_out: 15, price_from: "provider" }],
  available: [{ name: "anthropic/claude-sonnet-4.5", price_in: 3, price_out: 15 }] };
const status = (...systems) => ({ enabled: true, when_busy: "wait", workers: { total: 2, free: 2, busy: 0 }, systems });
const LISTED = ["llama-3.3-70b-versatile", "meta-llama/llama-4-maverick-17b-128e-instruct", "openai/gpt-oss-20b", "qwen/qwen3-32b",
  "moonshotai/kimi-k2-instruct-0905", "whisper-large-v3-turbo"];

const hostFor = (opts) => `(${function (opts) {
  const post = (m) => setTimeout(() => window.postMessage(m, "*"), 1);
  let status = opts.status;
  window.__sent = [];
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    if (m.type === "ready") {
      post({ type: "event", event: { type: "config", base_url: "http://gpu-box.local:11434/v1", model: "qwen3:8b", mode: "auto",
        router_capable: true, router_pips_default: true, pips_settable: true, subagent_model: "", max_parallel_tasks: 4,
        router_providers: true, router_prices: true, ...opts.config } });
      post({ type: "show", section: "models" });
      post({ type: "providerProfiles", profiles: opts.profiles, defaultId: opts.profiles[0].id });
    }
    if (m.type !== "routerCommand") return;
    const command = m.command || {};
    window.__sent.push(command);
    let extra = {};
    if (command.type === "router_provider_models") extra = { models: opts.listed };
    if (command.type === "router_update" && command.action === "add_system" && command.provider) {
      status = { ...status, systems: [...status.systems, { ...opts.added, jobs: [], workers: command.workers,
        models: command.models.map((name) => ({ name, workers: 1, context: 32768, ...(opts.added.available.find((a) => a.name === name) ? { price_from: "provider" } : {}),
          ...(opts.added.available.find((a) => a.name === name) || {}) })) }] };
    }
    if (command.type === "router_update" && command.action === "disable_system") {
      status = { ...status, systems: status.systems.map((s) => (s.id === command.system ? { ...s, enabled: false } : s)) };
    }
    post({ type: "routerReply", token: m.token, ok: true, status, ...extra });
  } });
}})(${JSON.stringify(opts)});`;
const pageFor = (theme, opts) => skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
  .replace("<head>", `<head>${VSCODE_WEBVIEW}<style>:root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;${Object.entries(THEMES[theme].vars)
    .map(([k, v]) => `${k}:${v}`).join(";")}}</style>`)
  .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`)
  .replace("<body>", `<body class="${THEMES[theme].body}">`)
  .replace('<script src="SCRIPT"></script>', () => `<script>${hostFor(opts)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);

async function open(theme, width, opts = {}) {
  const context = await browser.newContext({ viewport: { width, height: 2600 }, reducedMotion: "reduce", colorScheme: theme });
  const p = await context.newPage();
  const full = { status: status(GPU), profiles: PROFILES, listed: LISTED, added: GROQ_SYSTEM, config: {}, ...opts };
  await p.route("https://settings.test/**", (r) => r.fulfill({ body: pageFor(theme, full), contentType: "text/html" }));
  await p.goto("https://settings.test/view");
  await p.waitForSelector("[data-router-add]", { state: "attached" });
  return { context, p };
}
const shot = async (p, selector, name, theme, width) => {
  await p.$eval(selector, (el) => el.scrollIntoView({ block: "center" }));
  if (process.env.DGC_SHOTS) await p.locator(selector).screenshot({ path: `${process.env.DGC_SHOTS}/${name}-${theme}-${width}.png` });
};
/** Nothing pokes out of the card or the page, and no control or line of words inside it is cut by its edge. */
async function fits(p, selector, what) {
  const r = await p.$eval(selector, (card) => {
    const box = card.getBoundingClientRect();
    const out = [...card.querySelectorAll("button, input, select, label, p, small, span, b, li, legend")].filter((el) => {
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height || el.closest("[hidden]")) return false;
      const scroller = el.closest(".router-pick-list");                     // a long model list scrolls inside its own box
      if (scroller && scroller !== el && (b.bottom > scroller.getBoundingClientRect().bottom + 1 || b.top < scroller.getBoundingClientRect().top - 1)) return false;
      return b.left < box.left - 1 || b.right > box.right + 1;
    }).map((el) => `${el.tagName.toLowerCase()} "${(el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 40)}"`);
    const clipped = [...card.querySelectorAll("button, small, b, .router-name, .router-where, .router-way-name, .router-way-hint")]
      .filter((el) => el.getBoundingClientRect().width && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).display !== "inline")
      .map((el) => `${el.tagName.toLowerCase()} "${el.textContent.trim().slice(0, 40)}"`);
    return { out, clipped, card: card.scrollWidth - card.clientWidth, page: document.documentElement.scrollWidth - window.innerWidth, width: box.width };
  });
  assert.deepEqual(r.out, [], `${what}: these poke out of the card`);
  assert.deepEqual(r.clipped, [], `${what}: these are cut short`);
  assert.ok(r.card <= 1, `${what}: the card scrolls sideways by ${r.card}px`);
  assert.ok(r.page <= 0, `${what}: the page scrolls sideways by ${r.page}px`);
  return r;
}
/** The boxes of these elements, none overlapping another. */
async function apart(p, selector, what) {
  const boxes = await p.$$eval(selector, (list) => list.map((el) => { const b = el.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, text: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 30) }; })
    .filter((b) => b.r > b.l && b.b > b.t));
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.r <= b.l + 0.5 || b.r <= a.l + 0.5 || a.b <= b.t + 0.5 || b.b <= a.t + 0.5, `${what}: "${a.text}" overlaps "${b.text}"`);
  }
  return boxes;
}
const colour = (p, selector) => p.$eval(selector, (el) => getComputedStyle(el).color);

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`${theme} ${width}px: + Add system asks which, lists the saved providers, then one provider's models, Workers and jobs`, async (t) => {
    if (skipOrFail(t)) return;
    const { context, p } = await open(theme, width);
    try {
      await p.click("[data-router-add]");
      await p.waitForSelector("[data-router-add-way]");
      await shot(p, "[data-router-adding]", "add-choice", theme, width);
      await fits(p, "[data-router-adding]", "the Add choice");
      const ways = await apart(p, "[data-router-add-way]", "the two ways");
      assert.equal(ways.length, 2);
      if (width >= 600) assert.ok(Math.abs(ways[0].t - ways[1].t) < 1, "side by side in a wide tab");
      else assert.ok(ways[1].t >= ways[0].b, "one under the other in a narrow tab");
      for (const w of ways) assert.ok(w.b - w.t >= 40, "each is a button big enough to press");
      await p.click("[data-router-add-way=providers]");
      await p.waitForSelector(".router-providers li");
      await shot(p, "[data-router-adding]", "provider-list", theme, width);
      await fits(p, "[data-router-adding]", "the provider list");
      assert.deepEqual(await p.$$eval(".router-providers li b", (l) => l.map((b) => b.textContent)), ["Groq", "OpenRouter"]);
      await apart(p, ".router-providers li > *", "a provider's name and its button");
      await p.click(`[data-router-add-provider="${GROQ}"]`);
      await p.waitForSelector("[data-router-adding] [data-pick='5']");
      await shot(p, "[data-router-adding]", "provider-models", theme, width);
      await fits(p, "[data-router-adding]", "a provider's models");
      await apart(p, "[data-router-adding] .router-pick", "the models to tick");
      assert.deepEqual(await p.$$eval("[data-router-adding] [data-pick]", (l) => l.map((b) => b.checked)), [true, false, false, false, false, false]);
      const workers = await p.$eval("#router-add-workers", (el) => { const b = el.getBoundingClientRect(); return { w: b.width, h: b.height, v: el.value }; });
      assert.equal(workers.v, "2");
      assert.ok(workers.w >= 60 && workers.h >= 24, `Workers is a box to type in (${workers.w}×${workers.h})`);
      await p.check("[data-pick='3']");
      await p.click("[data-router-add-provider-go]");
      await p.waitForSelector("[data-router-system=groq] .router-form");
      const sent = await p.evaluate(() => window.__sent.filter((c) => c.type === "router_update"));
      assert.deepEqual(await p.evaluate(() => window.__sent.at(-1)), { type: "router_probe", system: "groq", checks: ["models"] });
      assert.deepEqual(sent, [
        { type: "router_update", action: "add_system", provider: GROQ, models: ["llama-3.3-70b-versatile", "qwen/qwen3-32b"], jobs: [], workers: 2 },
        { type: "router_update", action: "disable_system", system: "groq" }]);
      await shot(p, "[data-router-system=groq]", "provider-added-form", theme, width);
      assert.deepEqual(await p.$$eval("[data-router-system=groq] [data-price-row] .router-price", (l) => l.map((x) => x.textContent)),
        ["Its list says: $0.59 in · $0.79 out per million tokens", "Its list says: $0.29 in · $0.59 out per million tokens"], "each chosen model's price, from the provider's list");
      const tick = await p.$$eval("[data-router-system=groq] .router-use > input", (l) => l.map((b) => b.getBoundingClientRect().width));
      assert.ok(tick.every((w) => w >= 12), `a long model name never squeezes its tick box (${tick.join(", ")}px)`);
      await fits(p, "[data-router-system=groq]", "the new system's form");
      assert.equal(await p.$("[data-router-system=groq] input[type=password]"), null, "no key field");
    } finally { await context.close(); }
  });

  test(`${theme} ${width}px: a provider's card says whose it is, its key and its prices quietly; its edit row has the price boxes`, async (t) => {
    if (skipOrFail(t)) return;
    const { context, p } = await open(theme, width, { status: status(GPU, GROQ_SYSTEM, OPENROUTER_SYSTEM), config: { router_thinking: true } });
    try {
      await p.waitForSelector("[data-router-system=openrouter]", { state: "attached" });
      await shot(p, "[data-router-system=groq]", "card-with-key", theme, width);
      await shot(p, "[data-router-system=openrouter]", "card-no-key", theme, width);
      for (const id of ["groq", "openrouter"]) await fits(p, `[data-router-system=${id}]`, `${id}'s card`);
      assert.equal(await p.$eval("[data-router-system=groq] .router-where", (el) => el.textContent), "Your provider · Groq");
      // Every price is on its own line under its model's name, inside the name's cell, in the muted grey.
      const prices = await p.$$eval("[data-router-system=groq] .router-models > .router-model:not(.head)", (rows) => rows.map((row) => {
        const name = row.querySelector(".router-model-name"), price = row.querySelector(".router-price");
        const n = name.getBoundingClientRect(), b = price.getBoundingClientRect();
        const first = document.createRange(); first.selectNodeContents(name.firstChild);
        return { text: price.textContent, under: b.top >= first.getBoundingClientRect().bottom - 1, inside: b.left >= n.left - 1 && b.right <= n.right + 1,
          size: parseFloat(getComputedStyle(price).fontSize), nameSize: parseFloat(getComputedStyle(name).fontSize) };
      }));
      assert.deepEqual(prices.map((x) => x.text), ["$0.59 in · $0.79 out per million tokens", "$0.50 in · $0.60 out per million tokens", "Free"]);
      for (const x of prices) {
        assert.ok(x.under && x.inside, `"${x.text}" sits under its model's name, inside its cell`);
        assert.ok(x.size < x.nameSize, "smaller than the name");
      }
      const muted = await colour(p, "[data-router-system=groq] .router-where");
      assert.equal(await colour(p, "[data-router-system=groq] .router-price"), muted, "the price is in the muted grey");
      assert.equal(await colour(p, "[data-router-system=groq] [data-router-key-line=saved]"), muted);
      assert.notEqual(await colour(p, "[data-router-system=openrouter] [data-router-key-line=missing]"), muted, "a missing key stands out from the quiet lines");
      await apart(p, "[data-router-system=openrouter] .router-buttons button", "the card's buttons");
      // Edit: the price boxes.
      await p.click("[data-router-edit=groq]");
      await p.waitForSelector("[data-router-system=groq] [data-price-row]");
      await shot(p, "[data-router-system=groq]", "edit-prices", theme, width);
      await shot(p, "[data-router-system=groq] [data-model-row='1']", "edit-price-row", theme, width);
      await fits(p, "[data-router-system=groq]", "the edit form");
      const ticks = await p.$$eval("[data-router-system=groq] .router-use > input", (l) => l.map((b) => b.getBoundingClientRect().width));
      assert.ok(ticks.every((w) => w >= 12), `a long model name never squeezes its tick box (${ticks.join(", ")}px)`);
      for (const i of [0, 1, 2]) {
        const row = `[data-router-system=groq] [data-model-row='${i}']`;
        await apart(p, `${row} > *`, `model ${i}: the cells of its edit row`);
        await apart(p, `${row} [data-price-row] > *`, `model ${i}: Price, In and Out`);
        const m = await p.$eval(row, (el) => {
          const r = el.getBoundingClientRect(), price = el.querySelector("[data-price-row]").getBoundingClientRect();
          const others = [...el.children].filter((c) => !c.matches("[data-price-row]")).map((c) => c.getBoundingClientRect());
          return { inside: price.left >= r.left && price.right <= r.right + 1 && price.bottom <= r.bottom + 1, last: others.every((o) => o.bottom <= price.top + 1),
            boxes: [...el.querySelectorAll("[data-edit^=price-]")].map((b) => ({ w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, value: b.value, hint: b.placeholder })) };
        });
        assert.ok(m.inside, `model ${i}: the price line is inside its row`);
        assert.ok(m.last, `model ${i}: the price line is under the row's other fields`);
        for (const b of m.boxes) assert.ok(b.w >= 56 && b.h >= 24, `model ${i}: a price box is ${b.w}×${b.h}`);
        assert.deepEqual(m.boxes.map((b) => [b.value, b.hint]), [[["", "0.59"], ["", "0.79"]], [["0.5", "0.2"], ["0.6", "0.6"]], [["", "0"], ["", "0"]]][i]);
      }
      await p.fill("[data-router-system=groq] [data-model-row='0'] [data-edit=price-in]", "0.45");
      await p.fill("[data-router-system=groq] [data-model-row='0'] [data-edit=price-out]", "0.65");
      await p.click("[data-router-edit-save=groq]");
      await p.waitForFunction(() => window.__sent.some((c) => c.action === "set_model"));
      assert.deepEqual(await p.evaluate(() => window.__sent.filter((c) => c.action === "set_model")),
        [{ type: "router_update", action: "set_model", system: "groq", model: "llama-3.3-70b-versatile", price_in: 0.45, price_out: 0.65 }]);
    } finally { await context.close(); }
  });
}

test("a long list of models scrolls inside its own box, with a filter above it", async (t) => {
  if (skipOrFail(t)) return;
  const listed = Array.from({ length: 60 }, (_, i) => `vendor-${i % 4}/a-rather-long-model-name-${i}-instruct`);
  const { context, p } = await open("dark", 300, { listed });
  try {
    await p.click("[data-router-add]");
    await p.click("[data-router-add-way=providers]");
    await p.click(`[data-router-add-provider="${OPENROUTER}"]`);
    await p.waitForSelector("[data-pick='59']", { state: "attached" });
    await shot(p, "[data-router-adding]", "provider-models-long", "dark", 300);
    await fits(p, "[data-router-adding]", "a long model list");
    const list = await p.$eval(".router-pick-list", (el) => ({ h: el.getBoundingClientRect().height, scrolls: el.scrollHeight > el.clientHeight }));
    assert.ok(list.h <= 240 && list.scrolls, `the list keeps to its box (${list.h}px) and scrolls`);
    await p.fill("[data-pick-filter]", "name-59");
    assert.deepEqual(await p.$$eval(".router-pick", (l) => l.filter((x) => x.getBoundingClientRect().height > 0).map((x) => x.textContent.trim())),
      ["vendor-3/a-rather-long-model-name-59-instruct"]);
    const add = await p.$eval("[data-router-add-provider-go]", (el) => { const b = el.getBoundingClientRect(); return b.bottom <= window.innerHeight && b.height >= 24; });
    assert.ok(add, "Add is still in reach under the list");
  } finally { await context.close(); }
});
