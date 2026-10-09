// ChatDGC's screen (media/chatdgc.js) and the home's Chat list (media/main.js), in real Chromium. The page is
// the document src/chatdgc.ts serves, with its stylesheets inlined; what it posts is what the extension host
// would receive. Everything a person or a model wrote must arrive as text or inert Markdown, never markup.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
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

const ID = `chat_${"a".repeat(32)}`;
const M = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`;
let cached;
function screenHtml() {
  if (cached) return cached;
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const doc = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1]
    .replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "")
    .replace("font-src ;", "font-src data:;");     // the icon font is inlined here; the webview loads it from the extension
  const codicon = readFileSync(join(root, "media/codicon.css"), "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);
  const css = readFileSync(join(root, "media/main.css"), "utf8").replace(/@import[^;]*;/, "");
  const own = readFileSync(join(root, "media/chatdgc.css"), "utf8");
  const js = readFileSync(join(root, "media/chatdgc.js"), "utf8");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife",
    globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  cached = { html: doc.replace("</head>", `<style>${codicon}</style><style>${css}</style><style>${own}</style></head>`), js, markdownJs };
  return cached;
}

async function openScreen({ width = 900, height = 700, theme = "dark-modern", state } = {}) {
  const { html, js, markdownJs } = screenHtml();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([code, md, saved]) => {
    window.__posted = []; window.__state = saved;
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
    eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
  }, [js, markdownJs, state]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => !t || m.type === t), type);
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  return { page, send, posted, frame, errors };
}
const shown = (page, selector) => page.evaluate((s) => { const n = document.querySelector(s); return !!n && n.checkVisibility(); }, selector);
const conversation = (extra = {}) => ({ id: ID, title: "New chat", model: null, thinking: null, pinned: false, archived: false, temporary: false, ...extra });

test("a new chat: the question and the box together, and a message goes out with its model and thinking", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    assert.deepEqual((await s.posted()).map((m) => m.type), ["ready"], "it asks for its chat as it loads");
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "models", ids: ["qwen3:32b", "deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud" });
    assert.equal(await shown(s.page, "#cd-empty"), true);
    assert.equal(await s.page.evaluate(() => document.body.classList.contains("cd-blank")), true);
    const box = await s.page.locator("#cd-box").boundingBox(), vh = 700;
    assert.ok(box.y > vh * 0.25 && box.y < vh * 0.7, `the box sits near the middle, not the bottom (y=${box.y})`);
    assert.equal(await s.page.locator("#cd-send").isDisabled(), true, "nothing to send yet");
    assert.equal(await s.page.locator("#cd-model").inputValue(), "deepseek-v4.1-flash:cloud", "your model by default");
    assert.equal(await shown(s.page, "#cd-menu"), false, "nothing to rename until it has a message");
    await s.page.locator("#cd-thinking").selectOption("high");
    await s.page.locator("#cd-model").selectOption("qwen3:32b");
    await s.page.locator("#cd-input").fill("What's the capital of France?");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted("send"), [{ type: "send", text: "What's the capital of France?", model: "qwen3:32b", thinking: "high" }]);
    assert.equal(await s.page.locator("#cd-input").inputValue(), "");
    assert.equal(await shown(s.page, "#cd-stop"), true, "Stop while it answers");
    assert.equal(await shown(s.page, "#cd-send"), false);
    await s.page.locator("#cd-input").fill("second");
    await s.page.keyboard.press("Enter");
    assert.equal((await s.posted("send")).length, 1, "no second send while one runs");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a reply streams in as Markdown; your words and its words never become markup", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "message", message: { id: M(1), role: "user", text: '<img src=x onerror="window.__owned=1"> hi' } });
    await s.send({ type: "delta", messageId: M(2), thinking: "The user greets me." });
    await s.frame();
    assert.equal(await s.page.locator(".cd-assistant details.cd-thinking").getAttribute("open"), "", "its thinking shows while it thinks");
    assert.match(await s.page.locator(".cd-thinking-label").textContent(), /Thinking…/);
    await s.send({ type: "delta", messageId: M(2), text: "**Paris** is the capital. <img src=x onerror=\"window.__owned=2\">\n\n```js\nconst x = 1;\n```\n\nSee [the docs](https://example.com/paris)." });
    await s.frame();
    assert.equal(await s.page.locator(".cd-user .cd-bubble").textContent(), '<img src=x onerror="window.__owned=1"> hi');
    assert.equal(await s.page.locator(".cd-assistant .cd-body strong").textContent(), "Paris");
    assert.equal(await s.page.locator(".cd-assistant pre.code code").textContent(), "const x = 1;\n");
    assert.equal(await s.page.evaluate(() => document.querySelectorAll("#cd-log img").length + (window.__owned || 0)), 0);
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "**Paris** is the capital.\n\n```js\nconst x = 1;\n```\n\nSee [the docs](https://example.com/paris).", thinking: "The user greets me.", finish: "stop", model: "qwen3:32b" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.match(await s.page.locator(".cd-thinking-label").textContent(), /^Thought$/);
    assert.equal(await s.page.locator(".cd-assistant .cd-meta").textContent(), "qwen3:32b", "which model answered");
    await s.page.locator(".cd-assistant .md-link").click();
    await s.page.locator(".cd-assistant pre.code .copy").click({ force: true });
    await s.page.locator(".cd-assistant .cd-action").click();
    const asked = await s.posted();
    assert.deepEqual(asked.filter((m) => m.type === "openLink"), [{ type: "openLink", target: "https://example.com/paris" }]);
    assert.deepEqual(asked.filter((m) => m.type === "copy").map((m) => m.text), ["const x = 1;\n", "**Paris** is the capital.\n\n```js\nconst x = 1;\n```\n\nSee [the docs](https://example.com/paris)."]);
    assert.equal(await shown(s.page, "#cd-send"), true);
    assert.equal(await shown(s.page, "#cd-menu"), true, "a chat with messages can be renamed");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a reply cut at the model's limit, or stopped, carries on with Continue", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const messages = [{ id: M(1), role: "user", text: "Write a long story" },
                      { id: M(2), role: "assistant", text: "Chapter one.", finish: "length" }];
    await s.send({ type: "opened", conversation: conversation({ title: "Story" }), messages, earlier: 0, busy: false });
    assert.match(await s.page.locator(".cd-end").textContent(), /length limit/);
    await s.page.locator(".cd-continue").click();
    assert.deepEqual(await s.posted("continue"), [{ type: "continue", messageId: M(2) }]);
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "delta", messageId: M(2), text: " Chapter two." });
    await s.frame();
    assert.equal(await s.page.locator(".cd-continue").count(), 0, "no Continue while it continues");
    assert.match(await s.page.locator(".cd-assistant .cd-body").textContent(), /Chapter one\. Chapter two\./, "the same reply grows");
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Chapter one. Chapter two.", finish: "cancelled" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.match(await s.page.locator(".cd-end").textContent(), /Stopped\./);
    assert.equal(await s.page.locator(".cd-continue").count(), 1);
    assert.equal(await s.page.locator(".cd-assistant").count(), 1, "still one reply");
  } finally { await s.page.close(); }
});

test("errors, a CLI without ChatDGC, and older messages", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation({ title: "Long one" }), messages: [{ id: M(5), role: "user", text: "latest" }], earlier: 4, busy: false });
    assert.equal(await shown(s.page, "#cd-earlier"), true);
    await s.page.locator("#cd-earlier").click();
    assert.deepEqual(await s.posted("earlier"), [{ type: "earlier", before: M(5) }]);
    await s.send({ type: "earlier", messages: [{ id: M(4), role: "assistant", text: "older" }], earlier: 0 });
    assert.deepEqual(await s.page.evaluate(() => [...document.querySelectorAll(".cd-msg")].map((n) => n.dataset.id)), [M(4), M(5)]);
    assert.equal(await shown(s.page, "#cd-earlier"), false);
    await s.page.locator("#cd-input").fill("hello");
    await s.page.keyboard.press("Enter");
    await s.send({ type: "error", message: "The model didn't answer: connection refused" });
    assert.equal(await s.page.locator("#cd-notice").textContent(), "The model didn't answer: connection refused");
    assert.equal(await shown(s.page, "#cd-send"), true, "a send that never started isn't running");
    await s.send({ type: "error", opening: true, message: "That chat doesn't exist." });
    assert.deepEqual((await s.posted("reopenNew")).length, 1, "a chat that is gone opens as a new one");
    await s.send({ type: "unavailable", message: "ChatDGC needs a newer DGC CLI." });
    assert.equal(await s.page.locator("#cd-input").isDisabled(), true);
  } finally { await s.page.close(); }
});

test("it fits a narrow editor and a wide one, in both themes", async (t) => {
  if (skipOrFail(t)) return;
  const shots = process.env.DGC_SHOTS || "";
  if (shots) mkdirSync(shots, { recursive: true });
  for (const [theme, width] of [["dark-modern", 380], ["dark-modern", 1280], ["light-modern", 1280]]) {
    const s = await openScreen({ width, height: 760, theme });
    try {
      const long = "A word ".repeat(60) + " " + "x".repeat(300);
      await s.send({ type: "opened", conversation: conversation({ title: "Trip to Goa" }), earlier: 0, busy: false, messages: [
        { id: M(1), role: "user", text: "Plan three days in Goa for a family of four, with one rainy-day option." },
        { id: M(2), role: "assistant", thinking: "They want a short plan.", finish: "stop", model: "deepseek-v4.1-flash:cloud",
          text: "## Day 1: North Goa\n\n- Morning at **Calangute**\n- Lunch: `fish thali`\n\n| Day | Plan |\n| --- | --- |\n| 1 | Beaches |\n| 2 | Old Goa |\n\n```bash\necho 'pack sunscreen'\n```\n\n" + long },
        { id: M(3), role: "user", text: "And if it rains?" },
        { id: M(4), role: "assistant", text: "Visit the **Goa State Museum**.", finish: "length" }] });
      await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud" });
      await s.frame();
      const wide = await s.page.evaluate(() => ({ page: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth,
        column: document.querySelector(".cd-log").getBoundingClientRect().width }));
      assert.equal(wide.page, 0, `no sideways scroll at ${width}px`);
      assert.ok(wide.column <= 760, "a reading column, not the whole editor");
      if (shots) await s.page.screenshot({ path: join(shots, `chatdgc-${theme}-${width}.png`) });
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("the home: your chats above this project's sessions, one search over both", async (t) => {
  if (skipOrFail(t)) return;
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
    await page.evaluate(([mjs, mdjs]) => {
      document.documentElement.dataset.chatPlace = "home";
      window.__posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
      window.DgcPips = { mount: () => ({ setVisible() {}, navigate() {} }) };
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
    }, [mainJs, markdownJs]);
    const send = (d) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
    await send({ type: "sessions_list", items: [{ id: "20261006-101500-a1", name: "Fix login", when: "2026-10-06 10:15", count: 4 }], searchable: true });
    assert.equal(await shown(page, "#chats-home"), false, "hidden until the CLI says it has ChatDGC");
    assert.equal(await page.locator("#sessions-title").textContent(), "Sessions");
    const now = new Date().toISOString();
    await send({ type: "chatdgc_list", available: true, total: 2, more: true, open: [ID], items: [
      { id: ID, title: '<img src=x onerror="window.__owned=1">', updated_at: now, pinned: true, preview: "Paris is the capital." },
      { id: `chat_${"b".repeat(32)}`, title: "Goa trip", updated_at: "2026-01-02T10:00:00.000Z", preview: "" }] });
    assert.equal(await shown(page, "#chats-home"), true);
    assert.equal(await page.locator("#sessions-title").textContent(), "Work");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#chats-list .session-name")].map((n) => n.textContent)),
      ['<img src=x onerror="window.__owned=1">', "Goa trip"]);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#chats-list img").length + (window.__owned || 0)), 0);
    const meta = await page.locator("#chats-list .chat-row").first().locator(".session-meta").textContent();
    assert.match(meta, /Pinned/); assert.match(meta, /Just now/); assert.match(meta, /Open in a tab/);
    const box = (s) => page.locator(s).boundingBox();
    assert.ok((await box("#chats-home")).y < (await box("#sessions-title")).y, "Chat above Work");
    assert.ok((await box("#sessions-search")).y < (await box("#chats-home")).y, "the search sits over both");
    await page.locator("#chats-list .chat-row").nth(1).click();
    await page.locator("#chats-new").click();
    await page.locator("#sessions-search").fill("goa");
    await page.waitForTimeout(400);
    const asked = await page.evaluate(() => window.__posted.filter((m) => /^(chatdgc|sessionsSearch)/.test(m.type)));
    assert.deepEqual(asked, [{ type: "chatdgcOpen", id: `chat_${"b".repeat(32)}` }, { type: "chatdgcNew" },
                             { type: "sessionsSearch", query: "goa" }, { type: "chatdgcSearch", query: "goa" }]);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#sessions-host button")].filter((b) => !b.title).length), 0,
      "every button on the home says what it does on hover");
    if (process.env.DGC_SHOTS) await page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-home.png") });
    await send({ type: "chatdgc_list", available: false });
    assert.equal(await shown(page, "#chats-home"), false, "an older CLI: no Chat section");
    assert.equal(await page.locator("#sessions-title").textContent(), "Sessions");
  } finally { await page.close(); }
});
