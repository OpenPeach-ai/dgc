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
    assert.deepEqual(await s.posted("send"), [{ type: "send", text: "What's the capital of France?", model: "qwen3:32b", thinking: "high",
                                                search: "auto" }], "web search is auto unless you choose");
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
    await s.page.locator('.cd-assistant [aria-label="Copy"]').click();
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
      { id: ID, title: '<img src=x onerror="window.__owned=1">', updated_at: now, pinned: true, preview: "**Paris** is the capital. | Sight | Why go | | --- | --- | See [the docs](https://x.example)" },
      { id: `chat_${"b".repeat(32)}`, title: "Goa trip", updated_at: "2026-01-02T10:00:00.000Z", preview: "" }] });
    assert.equal(await shown(page, "#chats-home"), true);
    assert.equal(await page.locator("#sessions-title").textContent(), "Work");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#chats-list .session-name")].map((n) => n.textContent)),
      ['<img src=x onerror="window.__owned=1">', "Goa trip"]);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#chats-list img").length + (window.__owned || 0)), 0);
    const meta = await page.locator("#chats-list .chat-row").first().locator(".session-meta").textContent();
    assert.match(meta, /Pinned/); assert.match(meta, /Just now/); assert.match(meta, /Open in a tab/);
    assert.equal(await page.locator("#chats-list .chat-preview").first().textContent(), "Paris is the capital. Sight Why go See the docs",
      "its words, not its Markdown");
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

test("a reply that searches: what it looks for while it looks, citation marks, and its sources", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ state: { search: "on" } });
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    assert.equal(await s.page.locator("#cd-search").inputValue(), "on", "the tab keeps the choice");
    await s.page.locator("#cd-search").selectOption("auto");
    await s.page.locator("#cd-input").fill("Weather in Paris?");
    await s.page.keyboard.press("Enter");
    assert.equal((await s.posted("send"))[0].search, "auto");
    assert.equal(await s.page.evaluate(() => window.__state.search), "auto");
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "activity", messageId: M(2), kind: "searching", text: "paris weather" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").textContent(), "Searching the web for “paris weather”…");
    await s.send({ type: "delta", messageId: M(2), text: "Sunny [1]" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").count(), 0, "writing again");
    const sources = [{ n: 1, title: "Paris forecast", url: "https://www.weather.example/paris" },
                     { n: 2, title: "Météo", url: "https://meteo.example/p" }];
    await s.send({ type: "message", message: { id: M(2), role: "assistant", finish: "stop", sources, searches: ["paris weather"],
      text: "Sunny and 21°C [1], dry week [2][9].\n\n```\nlist[1]\n```" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.deepEqual(await s.page.locator(".cd-cite").allTextContents(), ["1", "2"], "only numbers it was given; [9] stays text");
    assert.match(await s.page.locator(".cd-body").first().textContent(), /\[9\]/);
    assert.equal(await s.page.locator("pre.code code").textContent(), "list[1]\n", "code is code");
    assert.equal(await s.page.locator(".cd-cite").first().getAttribute("title"), "Paris forecast (weather.example)");
    await s.page.locator(".cd-cite").first().click();
    await s.page.locator(".cd-sources summary").click();
    assert.equal(await s.page.locator(".cd-sources-label").textContent(), "Sources · 2");
    assert.equal(await s.page.locator(".cd-searched").textContent(), "Searched for “paris weather”");
    assert.deepEqual(await s.page.locator(".cd-source").allInnerTexts(), ["Paris forecast\nweather.example", "Météo\nmeteo.example"]);
    await s.page.locator(".cd-source-open").nth(1).click();
    assert.deepEqual((await s.posted("openLink")).map((m) => m.target), ["https://www.weather.example/paris", "https://meteo.example/p"]);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-sources.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("attachments: picked files and pastes become chips, go with the message, and show on it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.page.locator("#cd-attach").click();
    assert.deepEqual((await s.posted("attach")).length, 1);
    await s.send({ type: "attached", items: [{ kind: "file", path: "/home/u/trip.csv", name: "trip.csv", size: 2400 },
                                             { kind: "file", path: "/home/u/old.pdf", name: "old.pdf", size: 3_400_000 }] });
    assert.deepEqual(await s.page.locator("#cd-chips .cd-chip").allInnerTexts(), ["trip.csv\n2 KB", "old.pdf\n3.2 MB"]);
    await s.page.locator('#cd-chips .cd-chip-remove[title="Remove old.pdf"]').click();
    assert.equal(await s.page.locator("#cd-chips .cd-chip").count(), 1);
    assert.equal(await s.page.locator("#cd-send").isDisabled(), false, "a file alone can be sent");
    const long = "word ".repeat(1500);
    await s.page.locator("#cd-input").focus();
    await s.page.evaluate((text) => {
      const data = new DataTransfer(); data.setData("text/plain", text);
      document.getElementById("cd-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, long);
    await s.page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 4000; canvas.height = 1000;
      canvas.getContext("2d").fillRect(0, 0, 4000, 1000);
      const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
      const data = new DataTransfer(); data.items.add(new File([blob], "image.png", { type: "image/png" }));
      document.getElementById("cd-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await s.page.waitForFunction(() => document.querySelectorAll("#cd-chips .cd-chip").length === 3);
    assert.equal(await s.page.locator("#cd-input").inputValue(), "", "the long paste went to a chip, not the box");
    const names = await s.page.locator("#cd-chips .cd-chip-name").allTextContents();
    assert.deepEqual(names, ["trip.csv", "Pasted text", "Pasted image"]);
    assert.match(await s.page.locator("#cd-chips .cd-chip").nth(1).innerText(), /7,500 characters/);
    await s.page.locator("#cd-send").click();
    const [sent] = await s.posted("send");
    assert.equal(sent.text, "");
    assert.deepEqual(sent.attachments.slice(0, 2), [{ kind: "file", name: "trip.csv", path: "/home/u/trip.csv" },
                                                    { kind: "text", name: "Pasted text", text: long }]);
    const image = sent.attachments[2];
    const side = await s.page.evaluate((uri) => new Promise((r) => { const i = new Image(); i.onload = () => r([i.naturalWidth, i.naturalHeight]); i.src = uri; }), image.data);
    assert.deepEqual(side, [2048, 512], "scaled to fit one frame");
    assert.equal(await s.page.locator("#cd-chips").isHidden(), true, "the box is clear again");
    await s.send({ type: "message", message: { id: M(1), role: "user", text: "", attachments: [
      { id: "att_" + "1".repeat(32), kind: "document", name: "trip.csv", size: 2400, chars: 1200 },
      { id: "att_" + "2".repeat(32), kind: "image", name: "Pasted image", size: 50_000 }] } });
    assert.deepEqual(await s.page.locator(".cd-user .cd-sent .cd-chip").allInnerTexts(), ["trip.csv\n1,200 characters"]);
    assert.equal(await s.page.locator(".cd-user .cd-thumb img").getAttribute("alt"), "Pasted image", "an image shows as itself");
    assert.equal(await s.page.locator(".cd-user .cd-bubble").count(), 0, "no empty bubble for a message of only files");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("images you sent show as thumbnails, what a vision model saw is one click away, and files can be dropped", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const att = (c) => "att_" + c.repeat(32);
    await s.send({ type: "opened", conversation: conversation({ title: "Sign" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "What does it say?", attachments: [
        { id: att("a"), kind: "image", name: "sign.png", size: 7000 }, { id: att("b"), kind: "image", name: "gone.png", size: 9 },
        { id: att("c"), kind: "document", name: "notes.pdf", size: 100, chars: 50 }],
        vision: { model: "qwen3-vl:8b", text: "A white sign reading PIPS 48 READY." } },
      { id: M(2), role: "assistant", text: "It says PIPS 48 READY.", finish: "stop" }] });
    assert.deepEqual((await s.posted("image")).map((m) => m.id), [att("a"), att("b")], "each image asked for once");
    const png = await s.page.evaluate(() => { const c = document.createElement("canvas"); c.width = 400; c.height = 100;
      c.getContext("2d").fillRect(0, 0, 400, 100); return c.toDataURL("image/png"); });
    await s.send({ type: "image", id: att("a"), data: png });
    await s.send({ type: "image", id: att("b"), error: "That image is no longer there." });
    assert.equal(await s.page.locator('img[data-att="' + att("a") + '"]').evaluate((i) => i.src.startsWith("data:image/png")), true);
    assert.equal(await s.page.locator(".cd-thumb-missing").textContent(), "gone.png");
    assert.deepEqual(await s.page.locator(".cd-user .cd-sent .cd-chip-name").allTextContents(), ["notes.pdf"], "other files stay chips");
    await s.page.locator(".cd-thumb").first().click();
    assert.equal(await s.page.locator(".cd-thumb").first().evaluate((b) => b.classList.contains("cd-thumb-big")), true);
    assert.equal(await s.page.locator(".cd-seen summary").textContent(), "Seen by qwen3-vl:8b");
    await s.page.locator(".cd-seen summary").click();
    assert.equal(await s.page.locator(".cd-seen-text").textContent(), "A white sign reading PIPS 48 READY.");
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "activity", messageId: M(4), kind: "looking", text: "qwen3-vl:8b" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").textContent(), "Looking at the image with qwen3-vl:8b…");
    await s.send({ type: "turn", state: "ended", replyId: M(4) });
    await s.page.evaluate(() => {
      const data = new DataTransfer(); data.setData("text/uri-list", "file:///home/u/a.csv\r\n# comment\r\nfile:///home/u/b.md");
      document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    assert.deepEqual((await s.posted("dropped")).map((m) => m.uris), [["file:///home/u/a.csv", "file:///home/u/b.md"]]);
    await s.page.evaluate(async () => {
      const data = new DataTransfer();
      data.items.add(new File(["# Packing\n- sunscreen"], "packing.md", { type: "" }));
      data.items.add(new File([new Uint8Array([80, 75, 3, 4])], "trip.zip", { type: "application/zip" }));
      document.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await s.page.waitForFunction(() => document.querySelectorAll("#cd-chips .cd-chip").length === 1);
    assert.equal(await s.page.locator("#cd-chips .cd-chip-name").textContent(), "packing.md");
    assert.match(await s.page.locator("#cd-notice").textContent(), /Use the paperclip/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("versions: edit a message, try a reply again, and step between versions", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const view = (extra = {}) => ({ type: "opened", conversation: conversation({ title: "Goa" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Plan Old Goa", versions: { parent: "root", index: 1, count: 2 } },
      { id: M(2), role: "assistant", text: "Churches.", finish: "stop", versions: { parent: M(1), index: 0, count: 3 } }], ...extra });
    await s.send(view());
    const counts = await s.page.locator(".cd-versions-count").allTextContents();
    assert.deepEqual(counts, ["2 / 2", "1 / 3"]);
    const user = s.page.locator(".cd-user");
    assert.equal(await user.locator('[aria-label="Next version"]').isDisabled(), true);
    await user.locator('[aria-label="Previous version"]').click();
    await s.page.locator(".cd-assistant [aria-label='Next version']").click();
    assert.deepEqual(await s.posted("version"), [{ type: "version", parent: "root", index: 0 }, { type: "version", parent: M(1), index: 1 }]);
    await user.hover();
    await user.locator('[aria-label="Edit"]').click();
    assert.equal(await s.page.locator(".cd-edit-input").inputValue(), "Plan Old Goa");
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.locator(".cd-edit").count(), 0, "Escape leaves it as it was");
    assert.equal(await s.page.locator(".cd-user .cd-bubble").textContent(), "Plan Old Goa");
    await user.hover();
    await user.locator('[aria-label="Edit"]').click();
    await s.page.locator(".cd-edit-input").fill("Plan Panjim");
    await s.page.keyboard.press("Enter");
    assert.deepEqual(await s.posted("edit"), [{ type: "edit", messageId: M(1), text: "Plan Panjim", model: "", thinking: "off", search: "auto" }]);
    assert.equal(await s.page.locator("#cd-stop").isVisible(), true, "busy until the new reply ends");
    assert.equal(await s.page.locator(".cd-assistant [aria-label='Try again']").isDisabled(), true, "nothing else while it answers");
    await s.page.locator("#cd-input").fill("half-typed question");
    await s.send(view({ messages: [{ id: M(3), role: "user", text: "Plan Panjim", versions: { parent: "root", index: 2, count: 3 } }],
                        busy: true, replyId: M(4), keep: true }));
    assert.equal(await s.page.locator("#cd-input").inputValue(), "half-typed question", "what you were typing stays");
    assert.deepEqual(await s.page.locator(".cd-msg").evaluateAll((n) => n.map((x) => x.dataset.id)), [M(3)], "cut back to the edit");
    await s.send({ type: "message", message: { id: M(4), role: "assistant", text: "Panjim walk.", finish: "stop" } });
    await s.send({ type: "turn", state: "ended", replyId: M(4) });
    await s.frame();
    await s.page.locator(".cd-assistant [aria-label='Try again']").click();
    assert.deepEqual((await s.posted("regenerate")).map((m) => m.messageId), [M(4)]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
