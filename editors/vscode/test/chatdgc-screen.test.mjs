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
  const js = readFileSync(join(root, "media/chart.js"), "utf8") + "\n" + readFileSync(join(root, "media/chatdgc.js"), "utf8");
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
                                                search: "auto", study: false }], "web search is auto unless you choose");
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
    assert.deepEqual(asked.filter((m) => m.type === "copy").map((m) => m.text), ["const x = 1;\n", "Paris is the capital.\n\nconst x = 1;\n\nSee the docs."],
                     "a reply copies as it reads, with no ** or fences (a code block's own Copy keeps its code exactly)");
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

test("the home: Chat and Work as tabs (a long list never hides the other), one search over both", async (t) => {
  if (skipOrFail(t)) return;
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
    await page.evaluate(([mjs, mdjs]) => {
      document.documentElement.dataset.chatPlace = "home";
      window.__posted = []; window.__state = undefined;
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state,
                                         setState(s) { window.__state = s; } });
      window.DgcPips = { mount: () => ({ setVisible() {}, navigate() {} }) };
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
    }, [mainJs, markdownJs]);
    const send = (d) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
    await send({ type: "sessions_list", items: [{ id: "20261006-101500-a1", name: "Fix login", when: "2026-10-06 10:15", count: 4 }], searchable: true });
    assert.deepEqual([await shown(page, "#chats-home"), await shown(page, "#home-tabs"), await shown(page, "#sessions-list")], [false, false, true],
                     "until the CLI says it has ChatDGC: the sessions, no tabs");
    assert.equal(await page.locator("#sessions-title").textContent(), "Sessions");
    const now = new Date().toISOString();
    await send({ type: "chatdgc_list", available: true, total: 2, more: true, open: [ID], items: [
      { id: ID, title: '<img src=x onerror="window.__owned=1">', updated_at: now, pinned: true, preview: "**Paris** is the capital. | Sight | Why go | | --- | --- | See [the docs](https://x.example)" },
      { id: `chat_${"b".repeat(32)}`, title: "Goa trip", updated_at: "2026-01-02T10:00:00.000Z", preview: "Enjoy.",
        match: "…then the **Dudhsagar** falls on day three." }] });
    const tab = (name) => page.locator(`#home-tab-${name}`);
    assert.deepEqual([await shown(page, "#home-tabs"), await tab("chat").getAttribute("aria-selected"), await shown(page, "#chats-home"),
                      await shown(page, "#work-home")], [true, "true", true, false], "Chat first, on its own");
    assert.equal(await page.locator("#chats-home").getAttribute("role"), "tabpanel");
    assert.equal(await page.locator("#chats-list .chat-preview").nth(1).textContent(), "…then the Dudhsagar falls on day three.",
      "found by something said in it: the words around that");
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll("#chats-list .session-name")].map((n) => n.textContent)),
      ['<img src=x onerror="window.__owned=1">', "Goa trip"]);
    assert.equal(await page.evaluate(() => document.querySelectorAll("#chats-list img").length + (window.__owned || 0)), 0);
    const meta = await page.locator("#chats-list .chat-row").first().locator(".session-meta").textContent();
    assert.match(meta, /Pinned/); assert.match(meta, /Just now/); assert.match(meta, /Open in a tab/);
    assert.equal(await page.locator("#chats-list .chat-preview").first().textContent(), "Paris is the capital. Sight Why go See the docs",
      "its words, not its Markdown");
    const box = (s) => page.locator(s).boundingBox();
    assert.ok((await box("#sessions-search")).y < (await box("#home-tabs")).y, "the search sits over both tabs");
    assert.ok((await box("#home-tabs")).y < (await box("#chats-list")).y);
    if (process.env.DGC_SHOTS) await page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-home.png") });
    await page.locator("#chats-list .chat-row").nth(1).click();
    await page.locator("#chats-new").click();
    await tab("work").click();
    assert.deepEqual([await shown(page, "#chats-home"), await shown(page, "#work-home"), await tab("work").getAttribute("aria-selected")],
                     [false, true, "true"]);
    assert.equal(await page.locator("#sessions-list .session-row").count(), 1);
    assert.equal(await page.evaluate(() => window.__state?.homeTab), "work", "remembered");
    await tab("work").press("ArrowLeft");
    assert.equal(await page.evaluate(() => document.activeElement?.id), "home-tab-chat", "arrow keys move between the tabs");
    assert.equal(await shown(page, "#chats-home"), true);
    await page.locator("#sessions-search").fill("goa");
    await page.waitForTimeout(400);
    const asked = await page.evaluate(() => window.__posted.filter((m) => /^(chatdgc|sessionsSearch)/.test(m.type)));
    assert.deepEqual(asked, [{ type: "chatdgcOpen", id: `chat_${"b".repeat(32)}` }, { type: "chatdgcNew" },
                             { type: "sessionsSearch", query: "goa" }, { type: "chatdgcSearch", query: "goa" }]);
    await send({ type: "chatdgc_list", available: true, query: "goa", more: false, items: [{ id: `chat_${"b".repeat(32)}`, title: "Goa trip", updated_at: now }] });
    await send({ type: "sessions_list", query: "goa", searchable: true, more: true, items: [{ id: "20261006-101500-a1", name: "Goa beaches", when: "x", count: 2 }] });
    assert.deepEqual([await page.locator("#home-tab-chat-count").textContent(), await page.locator("#home-tab-work-count").textContent()], ["1", "1+"],
                     "searching: what each tab found, so nothing waits unseen in the other");
    assert.equal(await tab("work").getAttribute("aria-label"), "Work: 1 or more found");
    await send({ type: "sessions_list", query: "", searchable: true, items: [] });
    assert.equal(await page.locator("#home-tab-work-count").isHidden(), true);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#sessions-host button")].filter((b) => !b.title).length), 0,
      "every button on the home says what it does on hover");
    await send({ type: "chatdgc_list", available: false });
    assert.deepEqual([await shown(page, "#chats-home"), await shown(page, "#home-tabs"), await shown(page, "#work-home")], [false, false, true],
                     "an older CLI: the sessions, as before");
    assert.equal(await page.locator("#sessions-title").textContent(), "Sessions");
  } finally { await page.close(); }
});

test("a reply that searches: what it looks for while it looks, citation marks, and its sources", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    // Web search is always there; Search makes it search first, for the next message only.
    assert.equal(await s.page.locator("#cd-search").count(), 0, "no way to turn the web off from the box");
    const first = s.page.locator("#cd-websearch");
    await first.click();
    assert.equal(await first.getAttribute("aria-pressed"), "true");
    await s.page.locator("#cd-input").fill("Weather in Paris?");
    await s.page.keyboard.press("Enter");
    assert.equal((await s.posted("send"))[0].search, "on");
    assert.equal(await first.getAttribute("aria-pressed"), "false", "one message: then it's the model's call again");
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "activity", messageId: M(2), kind: "searching", text: "paris weather" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").textContent(), "Searching the web for “paris weather”…");
    await s.send({ type: "delta", messageId: M(2), text: "Sunny [1]" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").count(), 0, "writing again");
    const sources = [{ n: 1, title: "Paris forecast", url: "https://www.weather.example/paris", snippet: "Sunny, 21°C, light wind." },
                     { n: 2, title: "Météo", url: "https://meteo.example/p" },
                     { n: 3, title: "BBC Weather: Paris", url: "https://bbc.example/weather/paris", snippet: "A dry week ahead." },
                     { n: 4, title: "Paris news", url: "https://news.example/paris" }];
    await s.send({ type: "message", message: { id: M(2), role: "assistant", finish: "stop", sources, searches: ["paris weather"],
      text: "Sunny and 21°C [1], dry week [2][3][9].\n\n```\nlist[1]\n```" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    // A pill with the site where a fact is cited; [2][3] is one pill, "+1"; [9] was never given, so it stays text.
    assert.deepEqual(await s.page.locator(".cd-cite").allTextContents(), ["weather.example", "meteo.example+1"]);
    assert.match(await s.page.locator(".cd-body").first().textContent(), /\[9\]/);
    assert.equal(await s.page.locator("pre.code code").textContent(), "list[1]\n", "code is code");
    assert.equal(await s.page.locator(".cd-cite").first().getAttribute("aria-label"), "Source: Paris forecast (weather.example)");
    assert.equal(await s.page.locator(".cd-cite .cd-fav .codicon-globe").count(), 2, "favicons off: a globe, and nothing is asked");
    await s.page.locator(".cd-cite").nth(1).hover();
    const card = s.page.locator(".cd-cite-card");
    await card.waitFor({ state: "visible" });
    const [pillBox, cardBox] = [await s.page.locator(".cd-cite").nth(1).boundingBox(), await card.boundingBox()];
    if (pillBox.y - 14 >= cardBox.height) assert.ok(cardBox.y + cardBox.height <= pillBox.y, "above the pill: the Sources button and actions under it stay in reach");
    else assert.ok(cardBox.y >= pillBox.y + pillBox.height, "no room above: below it");
    assert.deepEqual(await card.locator(".cd-source-open").allTextContents(), ["Météo", "BBC Weather: Paris"]);
    assert.equal(await card.locator(".cd-source-snippet").textContent(), "A dry week ahead.");
    await card.locator(".cd-source-open").nth(1).click();
    await s.page.locator(".cd-cite").first().click();
    assert.deepEqual((await s.posted("openLink")).map((m) => m.target), ["https://bbc.example/weather/paris", "https://www.weather.example/paris"]);
    await s.send({ type: "favicons", on: true });
    await s.frame();
    assert.match(await s.page.locator(".cd-cite .cd-fav img").first().getAttribute("src"),
                 /^https:\/\/www\.google\.com\/s2\/favicons\?domain=https%3A%2F%2Fwww\.weather\.example&sz=32$/, "the origin only, never the page");
    const button = s.page.locator(".cd-sources-button");
    assert.equal(await button.innerText(), "Sources · 4");
    assert.equal(await button.locator(".cd-fav").count(), 3, "the sites it cited first, three at most");
    await button.click();
    const panel = s.page.locator("#cd-sources-panel");
    assert.equal(await panel.getAttribute("role"), "dialog");
    assert.equal(await panel.locator(".cd-searched").textContent(), "Searched for “paris weather”");
    assert.deepEqual(await panel.locator(".cd-sources-heading").allTextContents(), ["Cited · 3", "More results · 1"]);
    assert.deepEqual(await panel.locator(".cd-source-open").allTextContents(), ["Paris forecast", "Météo", "BBC Weather: Paris", "Paris news"]);
    assert.deepEqual(await panel.locator(".cd-source-site").allInnerTexts(), ["www.weather.example".replace("www.", ""), "meteo.example", "bbc.example", "news.example"]);
    await panel.locator(".cd-source-open").nth(3).click();
    assert.equal((await s.posted("openLink")).at(-1).target, "https://news.example/paris");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-sources.png") });
    await s.page.keyboard.press("Escape");
    assert.equal(await panel.count(), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a source's card opens above its pill, so a short answer's Sources button stays in reach", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const sources = [{ n: 1, title: "2026 Italian Grand Prix report", url: "https://www.formula1.com/en/latest/italy", snippet: "Antonelli won from Russell." },
                     { n: 2, title: "F1 results", url: "https://www.espn.com/f1/results" }];
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Earlier question.\n".repeat(8) }, { id: M(2), role: "assistant", text: "Earlier answer.\n\n".repeat(6), finish: "stop" },
      { id: M(3), role: "user", text: "Who won the most recent Grand Prix?" },
      { id: M(4), role: "assistant", text: "Kimi Antonelli won the Italian Grand Prix [1] [2].", finish: "stop", sources, searches: ["latest grand prix winner"] }] });
    await s.frame();
    const pill = s.page.locator(".cd-assistant").last().locator(".cd-cite");
    await pill.hover();
    const card = s.page.locator(".cd-cite-card");
    await card.waitFor({ state: "visible" });
    const [p, c] = [await pill.boundingBox(), await card.boundingBox()];
    assert.ok(c.y + c.height <= p.y, "above the pill");
    const button = s.page.locator(".cd-assistant").last().locator(".cd-sources-button");
    const b = await button.boundingBox();
    assert.equal(await s.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest(".cd-sources-button") !== null,
      [b.x + b.width / 2, b.y + b.height / 2]), true, "nothing covers the Sources button while the card is open");
    await button.click();
    assert.equal(await s.page.locator("#cd-sources-panel").isVisible(), true);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("pictures from the web: a strip above the answer as it streams, each with its site, and one opened larger", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const att = (c) => "att_" + c.repeat(32);
    const picture = (c, i, extra = {}) => ({ id: att(c), kind: "image", mime: "image/jpeg", title: `Hagia Sophia ${i}`,
      url: `https://site${i}.example/page`, site: `site${i}.example`, image: `https://img${i}.example/full.jpg`, ...extra });
    await s.send({ type: "opened", conversation: conversation({ title: "Hagia Sophia" }), earlier: 0, busy: false, messages: [] });
    await s.page.locator("#cd-input").fill("What does the inside of the Hagia Sophia look like?");
    await s.page.keyboard.press("Enter");
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "delta", messageId: M(2), text: "The dome seems to float" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-pictures").count(), 0, "none until the reply has some");
    const images = { query: "Hagia Sophia interior", items: [picture("a", 0), picture("b", 1, { title: "" }), picture("c", 2), picture("d", 3)] };
    await s.send({ type: "images", messageId: M(2), images });
    await s.frame();
    const strip = s.page.locator(".cd-assistant .cd-pictures");
    assert.equal(await strip.getAttribute("aria-label"), "Images from the web for “Hagia Sophia interior”");
    assert.deepEqual(await strip.locator(".cd-picture-site").allTextContents(), ["site0.example", "site1.example", "site2.example", "site3.example"]);
    assert.equal(await s.page.locator(".cd-assistant > .cd-pictures + .cd-body").count(), 1, "above the answer");
    assert.deepEqual((await s.posted("image")).map((m) => m.id), [att("a"), att("b"), att("c"), att("d")], "each asked for once, by id");
    const png = await s.page.evaluate(() => { const c = document.createElement("canvas"); c.width = 160; c.height = 120;
      c.getContext("2d").fillRect(0, 0, 160, 120); return c.toDataURL("image/png"); });
    for (const c of "abc") await s.send({ type: "image", id: att(c), data: png });
    await s.send({ type: "image", id: att("d"), error: "That image is no longer there." });
    const kept = await s.page.locator('.cd-pictures img[data-att="' + att("a") + '"]').elementHandle();
    await s.send({ type: "delta", messageId: M(2), text: " above the nave." });
    await s.frame();
    assert.equal(await s.page.locator(".cd-picture").count(), 3, "one that can't be shown leaves the strip");
    assert.equal(await kept.evaluate((n) => n.isConnected && n.src.startsWith("data:image/png")), true,
                 "the strip isn't drawn again as the reply streams: no flicker");
    assert.equal(await s.page.locator(".cd-picture").nth(1).getAttribute("aria-label"), "Image, from site1.example: view larger");
    await s.send({ type: "message", message: { id: M(2), role: "assistant", finish: "stop", images,
      text: "The dome seems to float above the nave." } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.equal((await s.posted("image")).length, 5, "the one refused while it was written is asked for once more");
    await s.send({ type: "image", id: att("d"), error: "That image is no longer there." });
    await s.frame();
    assert.equal(await s.page.locator(".cd-picture").count(), 3, "the saved reply shows them the same way");
    assert.equal((await s.posted("image")).length, 5, "and nothing else is asked twice");
    // One opened larger: what it is, the site, the page it's on, and that the model hasn't seen it.
    await s.page.locator(".cd-picture").nth(2).click();
    const view = s.page.locator("#cd-picture-view");
    assert.equal(await view.getAttribute("role"), "dialog");
    assert.equal(await view.locator(".cd-lightbox-title").textContent(), "Hagia Sophia 2");
    assert.equal(await view.locator(".cd-lightbox-count").textContent(), "3 / 3");
    assert.equal(await view.locator(".cd-source-site").innerText(), "site2.example");
    assert.equal(await view.locator(".cd-lightbox-note").textContent(), "From an image search for “Hagia Sophia interior”: the model hasn't seen it.");
    assert.equal(await view.locator(".cd-lightbox-frame img").evaluate((i) => i.src.startsWith("data:image/png")), true);
    await view.locator("button", { hasText: "Open page" }).click();
    assert.equal((await s.posted("openLink")).at(-1).target, "https://site2.example/page", "the page, not the picture");
    await s.page.keyboard.press("ArrowRight");
    assert.equal(await view.locator(".cd-lightbox-count").textContent(), "1 / 3", "round to the first");
    await view.locator('button[aria-label="Previous image"]').click();
    assert.equal(await view.locator(".cd-lightbox-title").textContent(), "Hagia Sophia 2");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-pictures-view.png") });
    await s.page.keyboard.press("Escape");
    assert.equal(await view.count(), 0);
    assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Hagia Sophia 2, from site2.example: view larger",
                 "focus goes back to the picture it came from");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-pictures.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("branch in new chat: on every reply, never in a temporary chat, and the branch says where it came from", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const FROM = `chat_${"b".repeat(32)}`;
    await s.send({ type: "opened", conversation: conversation({ title: "Goa trip" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Plan Goa" }, { id: M(2), role: "assistant", text: "Beaches first.", finish: "stop" },
      { id: M(3), role: "user", text: "Day two?" }, { id: M(4), role: "assistant", text: "Old Goa.", finish: "stop" }] });
    const branches = s.page.locator('button[aria-label="Branch in new chat"]');
    assert.equal(await branches.count(), 2, "one on each reply");
    await branches.first().click();
    assert.deepEqual(await s.posted("branch"), [{ type: "branch", messageId: M(2) }]);
    await s.send({ type: "turn", state: "started", replyId: M(6) });
    await s.frame();
    assert.equal(await branches.first().isDisabled(), true, "not while a reply is being written");
    await s.send({ type: "turn", state: "ended", replyId: M(6) });
    await s.send({ type: "opened", conversation: conversation({ temporary: true }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Hi" }, { id: M(2), role: "assistant", text: "Hello.", finish: "stop" }] });
    assert.equal(await branches.count(), 0, "a temporary chat isn't kept, so it can't be branched");
    await s.send({ type: "opened", conversation: conversation({ title: "Branch \u00b7 Goa trip",
      branched: { from: FROM, title: "Goa trip", at: M(2), created_at: "2026-10-10T18:00:00Z" } }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Plan Goa" }, { id: M(2), role: "assistant", text: "Beaches first.", finish: "stop" },
      { id: M(7), role: "user", text: "What about the north?" }, { id: M(8), role: "assistant", text: "Arambol.", finish: "stop" }] });
    const line = s.page.locator(".cd-branched");
    assert.equal(await line.textContent(), "Branched from Goa trip");
    assert.equal(await s.page.evaluate(() => document.querySelector(".cd-branched").previousElementSibling.dataset.id), M(2),
                 "right after the reply it branched from");
    await line.locator("button").click();
    assert.deepEqual(await s.posted("openChat"), [{ type: "openChat", id: FROM }]);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-branch.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("projects in a chat's tab: the project's page, its settings, and the project a chat is in, in its header", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const P = `proj_${"c".repeat(32)}`, att = (c) => "att_" + c.repeat(32);
    const project = { id: P, name: "Goa trip", color: "teal", instructions: "Budget traveller. Prices in rupees.", memory: "shared", chats: 2,
      files: [{ id: att("a"), kind: "document", name: "itinerary.pdf", size: 52000, chars: 4000 }, { id: att("b"), kind: "text", name: "Hotel", size: 40, chars: 40 }] };
    await s.send({ type: "opened", conversation: conversation({ project: P }), earlier: 0, busy: false, messages: [], project });
    await s.frame();
    assert.equal(await s.page.locator(".cd-project-name").textContent(), "Goa trip");
    assert.equal(await s.page.locator("#cd-title").textContent(), "Goa trip", "the header names the project, not a chat yet");
    assert.equal(await s.page.locator(".cd-project-head .project-icon").getAttribute("data-color"), "teal");
    assert.equal(await s.page.locator(".cd-project-card").first().textContent(), "InstructionsBudget traveller. Prices in rupees.");
    assert.deepEqual(await s.page.locator(".cd-project-chips .cd-chip-name").allTextContents(), ["itinerary.pdf", "Hotel"]);
    assert.equal(await s.page.locator(".cd-project-memory").textContent(), "Memory: shared with your other chats, Work and Pips.");
    assert.equal(await s.page.locator("#cd-input").getAttribute("placeholder"), "New chat in Goa trip");
    assert.equal(await s.page.locator("#cd-temp-toggle").isHidden(), true, "a project's chat is kept: never temporary");
    assert.equal(await s.page.locator("#cd-crumb").isHidden(), true, "on its own page, the page is the project");
    assert.deepEqual(await s.posted("projectChats"), [{ type: "projectChats", id: P }], "its chats, asked for once");
    await s.send({ type: "projectChats", project: P, items: [{ id: `chat_${"d".repeat(32)}`, title: "Where we stay", preview: "Casa Anjuna, ₹3,000 a night." }] });
    await s.frame();
    await s.page.locator(".cd-project-chat").click();
    assert.deepEqual(await s.posted("openChat"), [{ type: "openChat", id: `chat_${"d".repeat(32)}` }]);
    await s.page.locator(".cd-project-files button", { hasText: "Add files" }).click();
    await s.page.locator('.cd-project-chips button[aria-label="Remove Hotel"]').click();
    assert.deepEqual(await s.posted("projectAddFiles"), [{ type: "projectAddFiles", id: P }]);
    assert.deepEqual(await s.posted("projectRemoveFile"), [{ type: "projectRemoveFile", id: P, fileId: att("b") }]);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-project-page.png") });
    // Settings: name, colour, instructions, memory; Save, and a refused save can be fixed and saved again.
    await s.page.locator('.cd-project-head button[aria-label="Project settings"]').click();
    const panel = s.page.locator("#cd-project-panel");
    assert.equal(await panel.getAttribute("aria-label"), "Project settings");
    await panel.locator("#cd-project-name").fill("Goa, December");
    await panel.locator('input[name="cd-project-color"][value="orange"]').check();
    await panel.locator("#cd-project-instructions").fill("Vegetarian food only.");
    await panel.locator('input[name="cd-project-memory"][value="project"]').check();
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-project-settings.png") });
    await panel.locator("button", { hasText: "Save" }).click();
    assert.deepEqual(await s.posted("projectSave"), [{ type: "projectSave", id: P, name: "Goa, December", color: "orange",
                                                       instructions: "Vegetarian food only.", memory: "project" }]);
    assert.equal(await panel.locator("button", { hasText: "Save" }).isDisabled(), true);
    await s.send({ type: "error", message: "Give the project a name." });
    assert.equal(await panel.locator("button", { hasText: "Save" }).isDisabled(), false, "refused: fix it and save again");
    await panel.locator("button", { hasText: "Save" }).click();
    await s.send({ type: "projectSaved", project: { ...project, name: "Goa, December", color: "orange", memory: "project" } });
    await s.frame();
    assert.equal(await panel.count(), 0, "saved: the panel closes");
    assert.equal(await s.page.locator(".cd-project-name").textContent(), "Goa, December");
    assert.match(await s.page.locator(".cd-project-memory").textContent(), /this project's only/);
    await s.page.locator('.cd-project-head button[aria-label="Project settings"]').click();
    await panel.locator("button", { hasText: "Delete project…" }).click();
    assert.deepEqual(await s.posted("projectDelete"), [{ type: "projectDelete", id: P, name: "Goa, December", chats: 2 }]);
    await s.page.keyboard.press("Escape");
    // A chat in the project: its name in the header, which opens the project's page.
    await s.send({ type: "opened", conversation: conversation({ title: "Where we stay", project: P }), earlier: 0, busy: false,
      messages: [{ id: M(1), role: "user", text: "Where?" }, { id: M(2), role: "assistant", text: "Casa Anjuna.", finish: "stop" }] });
    await s.frame();
    assert.equal(await s.page.locator("#cd-crumb").isVisible(), true);
    assert.equal(await s.page.locator("#cd-crumb .cd-crumb-name").textContent(), "Goa, December");
    await s.page.locator("#cd-crumb").click();
    assert.deepEqual(await s.posted("openProject"), [{ type: "openProject", id: P }]);
    await s.send({ type: "projects", projects: [{ ...project, name: "Goa 2026" }] });
    assert.equal(await s.page.locator("#cd-crumb .cd-crumb-name").textContent(), "Goa 2026", "renamed anywhere: shown here");
    await s.send({ type: "changed", summary: { project: null } });
    assert.equal(await s.page.locator("#cd-crumb").isHidden(), true, "moved out: no project");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the home's projects: a New project, each project's chats under it, and a chat dragged into one", async (t) => {
  if (skipOrFail(t)) return;
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
    await page.evaluate(([mjs, mdjs]) => {
      document.documentElement.dataset.chatPlace = "home";
      window.__posted = []; window.__state = undefined;
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state,
                                         setState(s) { window.__state = s; } });
      window.DgcPips = { mount: () => ({ setVisible() {}, navigate() {} }) };
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
    }, [mainJs, markdownJs]);
    const send = (d) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
    const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
    const now = new Date().toISOString(), P = `proj_${"c".repeat(32)}`, C = `chat_${"b".repeat(32)}`;
    await send({ type: "chatdgc_list", available: true, total: 1, items: [{ id: C, title: "Beach ideas", updated_at: now, preview: "Baga." }] });
    await send({ type: "chatdgc_projects", projects: [] });
    assert.equal(await page.locator("#projects-home").isVisible(), true);
    assert.equal(await page.locator("#chats-sub").isHidden(), true, "no projects: no need to split your chats");
    await page.locator(".project-start").click();
    assert.deepEqual(await posted("chatdgcProjectNew"), [{ type: "chatdgcProjectNew" }]);
    await send({ type: "chatdgc_projects", projects: [{ id: P, name: "<b>Goa</b> trip", color: "teal", chats: 2, files: [], memory: "shared" }] });
    const row = page.locator(".project-row");
    assert.equal(await row.locator(".project-name").textContent(), "<b>Goa</b> trip", "words, never markup");
    assert.equal(await row.locator(".project-count").textContent(), "2");
    assert.equal(await page.locator("#chats-sub").isVisible(), true);
    await row.locator(".project-name").click();
    assert.deepEqual(await posted("chatdgcProjectOpen"), [{ type: "chatdgcProjectOpen", id: P }], "its page");
    await row.locator(".project-toggle").click();
    assert.deepEqual(await posted("chatdgcProjectChats"), [{ type: "chatdgcProjectChats", id: P }]);
    assert.equal(await page.locator(".project-chats .project-empty").textContent(), "Loading…");
    await send({ type: "chatdgc_project_chats", project: P, items: [{ id: `chat_${"d".repeat(32)}`, title: "Where we stay", updated_at: now }] });
    assert.deepEqual(await page.locator(".project-chats .session-name").allTextContents(), ["Where we stay"]);
    assert.equal(await page.evaluate(() => window.__state?.projectsOpen?.length), 1, "kept open across a reload");
    if (process.env.DGC_SHOTS) await page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-home-projects.png") });
    await page.locator("#chats-list .chat-row").dragTo(row);
    assert.deepEqual(await posted("chatdgcMove"), [{ type: "chatdgcMove", id: C, project: P }], "dragged in");
    await page.locator(".project-chats .chat-row").dragTo(page.locator("#chats-list"));
    assert.deepEqual((await posted("chatdgcMove")).at(-1), { type: "chatdgcMove", id: `chat_${"d".repeat(32)}`, project: "" }, "and out");
    await send({ type: "chatdgc_list", available: true, query: "where", items: [{ id: `chat_${"d".repeat(32)}`, title: "Where we stay", updated_at: now, project: P }] });
    assert.equal(await page.locator("#projects-home").isHidden(), true, "searching: the results, each saying its project");
    assert.match(await page.locator("#chats-list .chat-project").textContent(), /Goa/);
    assert.equal(await page.evaluate(() => [...document.querySelectorAll("#sessions-host button")].filter((b) => !b.title).length), 0);
  } finally { await page.close(); }
});

test("a Library file in the box goes by id, and a file deleted from the Library says so where it was sent", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const att = (c) => "att_" + c.repeat(32), FROM = `chat_${"e".repeat(32)}`;
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Check these", attachments: [
        { id: att("a"), kind: "image", name: "old.png", size: 900, removed: true },
        { id: att("b"), kind: "document", name: "budget.csv", size: 15, chars: 15, removed: true }] },
      { id: M(2), role: "assistant", text: "Done.", finish: "stop" }] });
    assert.equal(await s.page.locator(".cd-user .cd-thumb").count(), 0, "a deleted image isn't asked for");
    assert.deepEqual(await s.page.locator(".cd-user .cd-sent .cd-chip-about").allTextContents(), ["deleted from your Library", "deleted from your Library"]);
    const item = { kind: "library", fileKind: "document", name: "itinerary.pdf", size: 52000, chars: 4000, conversation_id: FROM, attachment_id: att("c") };
    await s.send({ type: "attached", items: [item, item] });
    assert.deepEqual(await s.page.locator("#cd-chips .cd-chip-name").allTextContents(), ["itinerary.pdf"], "once, however often it's chosen");
    assert.equal(await s.page.locator("#cd-chips .codicon-file-text").count(), 1, "its own kind's icon");
    await s.page.locator("#cd-input").fill("Summarize it");
    await s.page.keyboard.press("Enter");
    assert.deepEqual((await s.posted("send"))[0].attachments, [{ kind: "library", name: "itinerary.pdf", conversation_id: FROM, attachment_id: att("c") }]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

function libraryHtml() {
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const doc = source.slice(source.indexOf("export function libraryDocument")).match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1]
    .replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "").replace("font-src ;", "font-src data:;");
  const codicon = readFileSync(join(root, "media/codicon.css"), "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);
  const css = readFileSync(join(root, "media/main.css"), "utf8").replace(/@import[^;]*;/, "");
  const own = readFileSync(join(root, "media/chatdgc.css"), "utf8");
  return { html: doc.replace("</head>", `<style>${codicon}</style><style>${css}</style><style>${own}</style></head>`),
           js: readFileSync(join(root, "media/library.js"), "utf8") };
}

test("the Library: every file you attached, by kind, searched by name, each with its actions", async (t) => {
  if (skipOrFail(t)) return;
  const { html, js } = libraryHtml();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
    await page.evaluate((code) => {
      window.__posted = []; window.__state = undefined;
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
      eval(code);
    }, js);
    const send = (d) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
    const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
    assert.deepEqual(await posted("ready"), [{ type: "ready", kind: "" }]);
    assert.equal(await page.locator("#lib-status").textContent(), "Loading…");
    const today = new Date().toISOString();
    const files = [
      { source: "chat", chat_id: `chat_${"a".repeat(32)}`, id: `att_${"1".repeat(32)}`, name: "sign.png", kind: "image", type: "image", size: 7000, created_at: today, chat_title: "Sign" },
      { source: "chat", chat_id: `chat_${"b".repeat(32)}`, id: `att_${"2".repeat(32)}`, name: '<img src=x onerror="window.__owned=1">.pdf', kind: "document", type: "pdf", size: 52000, created_at: "2026-01-02T10:00:00Z", chat_title: "Visa", project_name: "Travel" },
      { source: "project", project_id: `proj_${"c".repeat(32)}`, id: `att_${"3".repeat(32)}`, name: "Hotel", kind: "text", type: "text", size: 40, created_at: today, project_name: "Goa trip" }];
    await send({ type: "library", files, total: 3, next: 3, counts: { image: 1, pdf: 1, text: 1, document: 0 } });
    assert.deepEqual(await page.locator(".lib-name").allTextContents(), ["sign.png", '<img src=x onerror="window.__owned=1">.pdf', "Hotel"]);
    assert.equal(await page.evaluate(() => document.querySelectorAll(".lib-name img").length + (window.__owned || 0)), 0, "names are words");
    const metas = await page.locator(".lib-meta").allTextContents();
    assert.deepEqual([metas[0], metas[2]], ["Image · 7 KB · in “Sign” · Today", "Pasted text · 40 B · in the project Goa trip · Today"]);
    assert.match(metas[1], /^PDF · 51 KB · in “Visa” · Travel · (2 Jan|Jan 2)$/, "the date as this machine writes it");
    assert.deepEqual(await page.locator(".lib-kind").allInnerTexts(), ["All\n3", "Images\n1", "PDFs\n1", "Pasted text\n1"], "only the kinds there are");
    assert.deepEqual((await posted("image")).map((m) => m.file.id), [`att_${"1".repeat(32)}`], "an image's preview, asked for by id");
    await send({ type: "image", id: `att_${"1".repeat(32)}`, data: "data:image/png;base64,iVBORw0KGgo=" });
    assert.equal(await page.locator(".lib-preview img").getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");
    if (process.env.DGC_SHOTS) await page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-library.png") });
    const second = page.locator(".lib-row").nth(1);
    for (const label of ["Open the chat it's in", "Use in a new chat", "Save a copy…", "Add a copy to a project…", "Delete from your Library"]) {
      await second.locator(`button[aria-label="${label}"]`).click();
    }
    assert.deepEqual((await page.evaluate(() => window.__posted.filter((m) => m.file))).map((m) => [m.type, m.file.id]),
      [["image", `att_${"1".repeat(32)}`], ...["open", "use", "save", "toProject", "remove"].map((type) => [type, `att_${"2".repeat(32)}`])]);
    assert.equal(await page.locator('.lib-row').nth(2).locator('button[aria-label^="Open the project"]').getAttribute("aria-label"), "Open the project Goa trip");
    await page.locator(".lib-kind", { hasText: "PDFs" }).click();
    assert.deepEqual((await posted("list")).at(-1), { type: "list", query: "", kind: "pdf", offset: 0 });
    assert.equal(await page.evaluate(() => window.__state?.kind), "pdf", "remembered");
    await send({ type: "library", files: [files[1]], total: 2, next: 1, counts: { pdf: 2 } });
    await page.locator("#lib-more").click();
    assert.deepEqual((await posted("list")).at(-1), { type: "list", query: "", kind: "pdf", offset: 1 });
    await send({ type: "library", files: [{ ...files[1], id: `att_${"4".repeat(32)}`, name: "older.pdf" }], total: 2, next: null, counts: { pdf: 2 } });
    assert.equal(await page.locator(".lib-row").count(), 2, "the next page adds to the list");
    assert.equal(await page.locator("#lib-more").isHidden(), true);
    await page.locator("#lib-search").fill("tax");
    await page.waitForTimeout(400);
    assert.deepEqual((await posted("list")).at(-1), { type: "list", query: "tax", kind: "pdf", offset: 0 });
    await send({ type: "library", files: [], total: 0, next: null, counts: { pdf: 0 } });
    assert.equal(await page.locator("#lib-status").textContent(), "No file named like “tax”.");
    await send({ type: "error", message: "That file is no longer in your Library." });
    assert.equal(await page.locator("#lib-status").textContent(), "That file is no longer in your Library.");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("plugins in chat: a card for each change, Send it now as edited, Hand it to a Pip first for something recurring, Don't", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const A = (c) => "act_" + c.repeat(32);
    const base = { plugin: "gcal", plugin_name: "Google Calendar", money: false, server: "gcal", tool: "create_event",
                   arguments: { title: "Lunch <b>with</b> Anya", when: "Fri 13:00", guests: ["anya@example.com"] }, recurring: false, status: "waiting", at: 0 };
    const cards = [
      { ...base, id: A("1") },
      { ...base, id: A("2"), recurring: true, arguments: { title: "Planning" } },
      { ...base, id: A("3"), plugin: "aave", plugin_name: "Aave", money: true, tool: "supply", arguments: { amount: 10 } },
      { ...base, id: A("4"), status: "done", answer: '{"id":"evt_1"}', sent_arguments: { title: "Lunch", when: "Fri 13:30" } },
      { ...base, id: A("5"), status: "failed", error: "Google Calendar said: calendar is read-only" },
      { ...base, id: A("6"), status: "handed", pip: { id: "pip_" + "a".repeat(32), name: "Ava" } },
      { ...base, id: A("7"), status: "dismissed" }];
    await s.send({ type: "opened", conversation: conversation({ title: "Plans" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Lunch Friday" }, { id: M(2), role: "assistant", text: "Here are the cards.", finish: "stop", actions: cards }] });
    await s.frame();
    const card = (c) => s.page.locator(`.cd-card[data-action="${A(c)}"]`);
    const buttons = (c) => card(c).locator(".cd-card-actions button").allTextContents();
    assert.equal(await card("1").locator("strong").textContent(), "Do this in Google Calendar?");
    assert.equal(await card("1").locator("small").textContent(), "create_event · nothing happens until you choose.");
    assert.equal(await card("1").locator("b").count(), 0, "inputs are text");
    assert.match(await card("1").locator(".cd-card-inputs").textContent(), /titleLunch <b>with<\/b> Anya.*guests\["anya@example\.com"\]/);
    assert.deepEqual(await buttons("1"), ["Send it now", "Hand it to a Pip", "Edit", "Don't"]);
    assert.deepEqual(await buttons("2"), ["Hand it to a Pip", "Send it now", "Edit", "Don't"], "something recurring: a Pip first");
    assert.deepEqual([await card("2").locator("button", { hasText: "Hand it to a Pip" }).getAttribute("class"),
                      await card("2").locator("button", { hasText: "Send it now" }).getAttribute("class")], ["cd-continue", "cd-edit-cancel"],
                     "one choice stands out: the Pip's");
    assert.equal(await card("3").locator("small").textContent(), "supply · Aave can move money, so it always asks.");
    assert.equal(await card("4").locator(".cd-card-status").textContent(), "Done. Sent with your changes.");
    assert.match(await card("4").locator(".cd-card-inputs").textContent(), /Fri 13:30/, "what was sent, as edited");
    assert.equal(await card("4").locator("summary").textContent(), "What Google Calendar answered");
    assert.equal(await card("5").locator(".cd-card-status").textContent(), "Didn't go: Google Calendar said: calendar is read-only");
    assert.equal(await card("6").locator(".cd-card-status").textContent(), "Handed to Ava: it takes it from here.");
    assert.equal(await card("7").locator(".cd-card-status").textContent(), "Not sent.");
    assert.equal(await card("4").locator("small").count(), 0, "a decided card says what came of it, not the tool twice");
    if (process.env.DGC_SHOTS) {
      await card("1").scrollIntoViewIfNeeded();
      await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-plugin-cards.png") });
    }
    // Edit: each input its own field (JSON for a list); a list that won't read says so and nothing goes.
    await card("1").locator("button", { hasText: "Edit" }).click();
    await s.frame();
    assert.deepEqual(await card("1").locator(".cd-field-label").allTextContents(), ["title", "when", "guests (JSON)"]);
    await card("1").locator("textarea, input").nth(1).fill("Fri 13:30");
    await card("1").locator("textarea").last().fill('["anya@example.com"');
    await card("1").locator("button", { hasText: "Send it now" }).click();
    await s.frame();
    assert.equal(await card("1").locator(".cd-card-error").textContent(), "guests aren't valid JSON. Check the brackets and quotes.");
    assert.equal((await s.posted("actionRun")).length, 0);
    await card("1").locator("textarea").last().fill('["anya@example.com","me@home.example"]');
    await card("1").locator("button", { hasText: "Send it now" }).click();
    await s.frame();
    assert.deepEqual(await s.posted("actionRun"), [{ type: "actionRun", messageId: M(2), actionId: A("1"),
      arguments: { title: "Lunch <b>with</b> Anya", when: "Fri 13:30", guests: ["anya@example.com", "me@home.example"] } }]);
    assert.equal(await card("1").locator("button", { hasText: "Sending…" }).isDisabled(), true, "sending: nothing else to press");
    await s.send({ type: "action", messageId: M(2), action: { ...cards[0], status: "done", answer: "ok",
      sent_arguments: { title: "Lunch <b>with</b> Anya", when: "Fri 13:30" } } });
    await s.frame();
    assert.equal(await card("1").locator(".cd-card-status").textContent(), "Done. Sent with your changes.");
    // Hand it to a Pip, and a picker closed without choosing; Don't.
    await card("2").locator("button", { hasText: "Hand it to a Pip" }).click();
    assert.deepEqual(await s.posted("actionHand"), [{ type: "actionHand", messageId: M(2), actionId: A("2") }]);
    await s.send({ type: "actionIdle", actionId: A("2") });
    await s.frame();
    assert.equal(await card("2").locator("button", { hasText: "Hand it to a Pip" }).isDisabled(), false, "closed without a Pip: choose again");
    await card("3").locator("button", { hasText: "Don't" }).click();
    assert.deepEqual(await s.posted("actionDismiss"), [{ type: "actionDismiss", messageId: M(2), actionId: A("3") }]);
    await s.send({ type: "error", message: "Let the reply finish first." });
    await s.frame();
    assert.equal(await card("3").locator("button", { hasText: "Don't" }).isDisabled(), false, "refused: the buttons come back");
    // While a reply is still being written, its card waits for it.
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "activity", messageId: M(4), kind: "plugin", text: "Google Calendar" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").textContent(), "Using Google Calendar…");
    await s.send({ type: "action", messageId: M(4), action: { ...base, id: A("8") } });
    await s.frame();
    assert.equal(await card("8").locator("button", { hasText: "Send it now" }).isDisabled(), true);
    assert.equal(await card("8").locator(".cd-card-note").textContent(), "You can choose once the reply is finished.");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("follow-ups: a few next messages under the last reply; one click sends it, and the box keeps what you were typing", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const next = ["How do I bake my first loaf with this starter?", "What can I make with the <b>discard</b>?"];
    await s.send({ type: "opened", conversation: conversation({ title: "Sourdough" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Starter?" }, { id: M(2), role: "assistant", text: "Mix flour and water.", finish: "stop", followups: ["Old one"] },
      { id: M(3), role: "user", text: "More detail" }, { id: M(4), role: "assistant", text: "Feed it daily.", finish: "stop" }] });
    await s.frame();
    assert.equal(await s.page.locator(".cd-followups").count(), 0, "an earlier reply's are stale: the conversation moved on");
    await s.send({ type: "followups", messageId: M(4), followups: next });
    await s.frame();
    const box = s.page.locator(".cd-assistant").last().locator(".cd-followups");
    assert.equal(await box.getAttribute("aria-label"), "Suggested follow-ups");
    assert.deepEqual(await box.locator(".cd-followup").allTextContents(), next, "words, never markup");
    assert.equal(await box.locator("b").count(), 0);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-followups.png") });
    await s.page.locator("#cd-input").fill("half-typed thought");
    await box.locator(".cd-followup").first().click();
    const sent = (await s.posted("send")).at(-1);
    assert.deepEqual([sent.text, typeof sent.model, sent.search], [next[0], "string", "auto"]);
    assert.equal(await s.page.locator("#cd-input").inputValue(), "half-typed thought", "the box keeps what you were typing");
    await box.locator(".cd-followup").nth(1).click();
    assert.equal((await s.posted("send")).length, 1, "one at a time: a reply is on its way");
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

test("keyboard shortcuts, as ChatGPT has them, and the list of them", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation({ title: "Code" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Two snippets" },
      { id: M(2), role: "assistant", finish: "stop", text: "First:\n\n```js\nconst a = 1;\n```\n\nSecond:\n\n```py\nb = 2\n```" }] });
    await s.page.locator("#cd-title").click();
    await s.page.keyboard.press("Control+Shift+KeyC");
    await s.page.keyboard.press("Control+Shift+Semicolon");
    assert.deepEqual((await s.posted("copy")).map((m) => m.text), ["First:\n\nconst a = 1;\n\nSecond:\n\nb = 2", "b = 2\n"]);
    await s.page.keyboard.press("Shift+Escape");
    assert.equal(await s.page.evaluate(() => document.activeElement.id), "cd-input");
    await s.page.keyboard.press("Control+Shift+KeyO");
    assert.equal((await s.posted("newChat")).length, 1);
    await s.page.keyboard.press("Control+Slash");
    assert.equal(await s.page.locator("#cd-keys").evaluate((d) => d.open), true);
    assert.deepEqual(await s.page.locator("#cd-keys dd").allTextContents(), ["New chat", "Copy the last reply", "Copy the last code block",
      "Focus the message box", "Stop the reply", "Show these shortcuts"]);
    assert.match(await s.page.locator("#cd-keys dt").first().innerText(), /Ctrl\s+Shift\s+O/);
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.locator("#cd-keys").evaluate((d) => d.open), false);
    await s.page.locator("#cd-keys-open").click();
    assert.equal(await s.page.locator("#cd-keys").evaluate((d) => d.open), true, "and from its button");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-keys.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the context window: a meter that warns early, Compact now, the summary in place, and a chat carried over", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const messages = [1, 2, 3, 4, 5].map((n) => ({ id: M(n), role: n % 2 ? "user" : "assistant", text: `message ${n}`, finish: "stop" }));
    await s.send({ type: "opened", conversation: conversation({ title: "Long" }), earlier: 0, busy: false, messages });
    assert.equal(await s.page.locator("#cd-context").isHidden(), true, "no meter until it's counted");
    const ctx = (used, extra = {}) => s.send({ type: "context", window: 32768, limit: 262144, used, preset: "32k", source: "reported",
      parts: { instructions: 600, conversation: used - 600 }, compactable: true, ...extra });
    for (const [used, level, pct] of [[12000, "low", "37%"], [24000, "mid", "73%"], [30000, "high", "92%"]]) {
      await ctx(used);
      assert.deepEqual([await s.page.locator("#cd-context").getAttribute("data-level"), await s.page.locator("#cd-context-pct").textContent()], [level, pct]);
    }
    await s.page.locator("#cd-context").click();
    const pop = s.page.locator("#cd-context-pop");
    assert.equal(await pop.isVisible(), true);
    assert.match(await pop.innerText(), /30,000 of 32,768 tokens, as the model counted them/);
    assert.match(await pop.innerText(), /Window: 32k \(Settings → ChatDGC\)\. This model can take up to 262,144\./);
    await pop.getByText("Compact now").click();
    assert.equal((await s.posted("compact")).length, 1);
    assert.equal(await s.page.locator(".cd-activity").textContent(), "Summarizing earlier messages to fit the context window…");
    assert.equal(await s.page.locator("#cd-send").isDisabled(), true, "nothing sent while it summarizes");
    await s.send({ type: "compacted", summary: { upto: M(3), text: "They planned a trip to Goa.", edited: false } });
    assert.equal(await s.page.locator(".cd-activity").count(), 0);
    const order = await s.page.locator("#cd-log > *").evaluateAll((n) => n.map((x) => x.dataset.id || x.className));
    assert.deepEqual(order, [M(1), M(2), M(3), "cd-summary", M(4), M(5)], "the divider sits after what it covers; nothing is hidden");
    await s.page.locator(".cd-summary-label").click();
    assert.equal((await s.page.locator(".cd-summary-text").textContent()).trim(), "They planned a trip to Goa.");
    await s.page.getByText("Edit summary").click();
    await s.page.locator(".cd-summary textarea").fill("They are planning four days in Goa.");
    await s.page.locator(".cd-summary").getByText("Save").click();
    assert.deepEqual(await s.posted("summary"), [{ type: "summary", text: "They are planning four days in Goa." }]);
    await ctx(20000, { compactable: false });
    await s.page.locator("#cd-context").click();
    assert.equal(await pop.getByText("Compact now").isDisabled(), true, "nothing older left to summarize: not offered");
    assert.equal(await pop.locator(".cd-pop-why").textContent(), "Everything before your last exchange is already summarized.");
    await pop.getByText("Continue in a new chat").click();
    assert.equal((await s.posted("carry")).length, 1);
    await s.send({ type: "opened", earlier: 0, busy: false, messages: [],
      conversation: conversation({ id: `chat_${"c".repeat(32)}`, title: "Long", carried: { from: ID, title: "Long", text: "**Goa**, four days.\n\n- Anya is vegetarian\n- ₹40,000" } }) });
    assert.equal(await s.page.locator(".cd-carried .cd-summary-label").textContent(), "Continued from \u201cLong\u201d");
    // Models write summaries in Markdown even when asked for plain text: shown as it reads, never as asterisks.
    assert.deepEqual(await s.page.locator(".cd-carried .cd-summary-text").evaluate((n) => [n.querySelector("strong")?.textContent, n.querySelectorAll("li").length, n.textContent.includes("**")]),
      ["Goa", 2, false]);
    assert.equal(await s.page.locator("#cd-context").isHidden(), true, "a new chat: counted afresh");
    assert.equal(await s.page.locator("#cd-temp-toggle").isHidden(), true, "a chat carried over can't be swapped for a temporary one");
    await s.send({ type: "turn", state: "started", replyId: M(9) });
    await s.send({ type: "activity", messageId: M(9), kind: "compacting", text: "" });
    await s.frame();
    assert.match(await s.page.locator(".cd-assistant .cd-activity").textContent(), /Summarizing earlier messages/, "while a reply waits on it");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-window.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a question asked mid-sentence: the sentence keeps its full stop above the card, never a lone one below", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const text = "So let's just do it.\n\nPick one.";
    const question = { at: "So let's just do it".length, question: "₹500 at 10% for 2 years?", options: ["₹605", "₹600"], prompt: "My answer: {answer}." };
    await s.send({ type: "opened", conversation: conversation({ title: "Quiz" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Quiz me" }, { id: M(2), role: "assistant", text, finish: "stop", questions: [question] }] });
    await s.frame();
    const bodies = await s.page.locator(`.cd-assistant[data-id="${M(2)}"] > .cd-body`).allInnerTexts();
    assert.deepEqual(bodies.map((b) => b.trim()), ["So let's just do it.", "Pick one."]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a question in the answer: a card where it was asked, Continue sends the choice, and then it shows it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const question = { at: 23, question: "Where is the money held?", options: ["Savings in India", "Company profits"], prompt: "From {answer}." };
    await s.send({ type: "opened", conversation: conversation({ title: "London" }), earlier: 0, busy: false,
                   messages: [{ id: M(1), role: "user", text: "Can I buy a flat in London?" }] });
    // Mid-reply: the card appears where the model asked, and the reply goes on below it.
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "delta", messageId: M(2), text: "Get a written opinion.\n" });
    await s.send({ type: "question", messageId: M(2), question });
    await s.send({ type: "delta", messageId: M(2), text: "\nThe answer matters." });
    await s.frame();
    const parts = await s.page.locator(`.cd-assistant[data-id="${M(2)}"] > *`).evaluateAll((n) => n.map((x) => x.className));
    assert.deepEqual(parts.slice(0, 3), ["text cd-body", "cd-question", "text cd-body"]);
    const card = s.page.locator(".cd-question");
    assert.equal(await card.locator(".cd-question-text").textContent(), "Where is the money held?");
    assert.deepEqual(await card.locator(".cd-option").allTextContents(), ["Savings in India", "Company profits", "Something else"]);
    assert.equal(await card.locator("input[type=radio]").first().isDisabled(), true, "not while it's still answering");
    assert.equal(await card.locator(".cd-question-note").textContent(), "Answer when the reply finishes");
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Get a written opinion.\n\nThe answer matters.",
                                               finish: "stop", questions: [question] } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    const go = card.getByRole("button", { name: "Continue" });
    assert.equal(await go.isDisabled(), true, "nothing chosen yet");
    assert.equal(await card.locator(".cd-other").isHidden(), true);
    await card.getByText("Something else").click();
    assert.equal(await card.locator(".cd-other").evaluate((n) => n === document.activeElement), true, "your own answer, typed at once");
    await card.locator(".cd-other").fill("An inheritance");
    await s.send({ type: "turn", state: "ended", replyId: M(2) });       // the chat redraws: what you picked stays
    assert.equal(await card.locator(".cd-other").inputValue(), "An inheritance");
    assert.equal(await card.locator('input[type=radio]').last().isChecked(), true);
    await card.locator(".cd-other").press("Enter");
    const [sent] = await s.posted("answer");
    assert.deepEqual([sent.messageId, sent.question, sent.choice], [M(2), 0, "An inheritance"]);
    assert.equal(await s.page.locator("#cd-send").isDisabled(), true, "it's answering now");
    await s.send({ type: "message", message: { id: M(3), role: "user", text: "From An inheritance.",
                                               answers: { message: M(2), question: 0, choice: "An inheritance" } } });
    await s.frame();
    assert.equal(await card.getAttribute("data-state"), "answered");
    assert.equal(await card.locator(".cd-question-note").textContent(), "Answered");
    assert.deepEqual([await card.locator(".cd-other").inputValue(), await card.locator(".cd-other").isDisabled()], ["An inheritance", true]);
    assert.equal(await card.getByRole("button", { name: "Continue" }).count(), 0);
    // A question you moved on from is kept, and says so; a pick from a list option shows as that option.
    await s.send({ type: "opened", conversation: conversation({ title: "London" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Can I buy a flat?" },
      { id: M(2), role: "assistant", text: "Asked.", finish: "stop", questions: [question] },
      { id: M(3), role: "user", text: "Actually, tell me about taxes." },
      { id: M(4), role: "assistant", text: "Asked again.", finish: "stop", questions: [question] },
      { id: M(5), role: "user", text: "From Company profits.", answers: { message: M(4), question: 0, choice: "Company profits" } }] });
    const [moved, picked] = [s.page.locator(`[data-id="${M(2)}"] .cd-question`), s.page.locator(`[data-id="${M(4)}"] .cd-question`)];
    assert.deepEqual([await moved.getAttribute("data-state"), await moved.locator(".cd-question-note").textContent()], ["passed", "Not answered"]);
    assert.deepEqual([await moved.locator("input:checked").count(), await moved.locator(".cd-other").isHidden()], [0, true],
                     "what you'd picked but never sent isn't shown as an answer");
    assert.equal(await picked.getByLabel("Company profits").isChecked(), true);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-question.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("deep research: the toggle, a plan that counts down, editing it, the reading as it goes, the report and its reader", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.page.clock.install();
    await s.send({ type: "opened", conversation: conversation({ title: "London" }), earlier: 0, busy: false, messages: [] });
    const toggle = s.page.locator("#cd-research");
    await toggle.click();
    assert.deepEqual([await toggle.getAttribute("aria-pressed"), await s.page.locator("#cd-input").getAttribute("placeholder"),
                      await s.page.locator("#cd-websearch").isHidden()], ["true", "What should I research?", true]);
    await s.page.locator("#cd-input").fill("Can I buy a London flat with savings in India?");
    await s.page.keyboard.press("Enter");
    const [asked] = await s.posted("research");
    assert.equal(asked.text, "Can I buy a London flat with savings in India?");
    assert.equal(await toggle.getAttribute("aria-pressed"), "false", "one message: then it's off again");
    assert.equal((await s.posted("send")).length, 0);
    // The plan is made, then counts down.
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "message", message: { id: M(1), role: "user", text: asked.text, research: true } });
    await s.send({ type: "research", messageId: M(2), research: { status: "planning", question: asked.text } });
    await s.frame();
    assert.equal(await s.page.locator(".cd-research-chip").textContent(), "Deep research");
    assert.equal(await s.page.locator(".cd-research-label").textContent(), "Making a research plan…");
    const plan = { title: "London flat from India", steps: ["What FEMA and the LRS allow", "UK taxes for a non-resident"], sites: [] };
    await s.send({ type: "research", messageId: M(2), research: { status: "planned", question: asked.text, plan } });
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "**Research plan: London flat from India**",
                                               finish: "stop", research: { status: "planned", question: asked.text, plan } } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    const card = s.page.locator(".cd-research");
    assert.deepEqual(await card.locator(".cd-plan-steps li").allTextContents(), plan.steps);
    assert.match(await card.locator(".cd-countdown").textContent(), /^Starting in 1[45]s$/);
    assert.equal(await s.page.locator(".cd-assistant .cd-body").count(), 0, "the plan shows as the card, not twice");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-research-plan.png") });
    // Edit stops the count; the edited plan is what starts.
    await card.getByRole("button", { name: "Edit" }).click();
    await s.page.clock.runFor(20_000);
    assert.equal((await s.posted("researchStart")).length, 0, "editing: it waits for you");
    await card.locator("textarea").fill("What FEMA and the LRS allow\n\nStamp duty for a non-resident buyer");
    await card.locator(".cd-plan-field").nth(2).locator("input").fill("rbi.org.in, gov.uk");
    await card.getByRole("button", { name: "Start research" }).click();
    const [started] = await s.posted("researchStart");
    assert.deepEqual(started.plan, { title: "London flat from India", steps: ["What FEMA and the LRS allow", "Stamp duty for a non-resident buyer"],
                                     sites: ["rbi.org.in", "gov.uk"] });
    // As it reads.
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    const pageNow = await s.page.evaluate(() => Date.now());            // the page's clock, which the test runs
    const running = (extra) => s.send({ type: "research", messageId: M(2), research: { status: "running", question: asked.text,
      plan: started.plan, round: 1, reads: 2, started_at: new Date(pageNow - 65_000).toISOString(),
      notes: [{ n: 1, title: "Master Direction - LRS", url: "https://rbi.org.in/lrs" }],
      activity: [{ kind: "round", text: "Round 1: choosing what to search" }, { kind: "search", text: "LRS property abroad" },
                 { kind: "read", text: "Master Direction - LRS", url: "https://rbi.org.in/lrs" },
                 { kind: "note", text: "Master Direction - LRS", n: 1 }, { kind: "skip", text: "Couldn't read example.com: timed out" }],
      ...extra } });
    await running();
    await s.frame();
    assert.equal(await card.locator(".cd-research-label").textContent(), "Researching…");
    assert.equal(await card.locator(".cd-research-stats").textContent(), "round 1 · 2 pages read · 1 noted · 1:05");
    assert.deepEqual(await card.locator(".cd-research-log li").allTextContents(),
      ["Round 1: choosing what to search", "Searching: LRS property abroad", "Reading: Master Direction - LRS",
       "Noted: [1] Master Direction - LRS", "Skipped: Couldn't read example.com: timed out"]);
    const steer = card.locator(".cd-steer-input");
    await steer.click();
    await steer.pressSequentially("I'm an N");
    await running({ reads: 3 });                         // progress redraws the card while you type
    await s.frame();
    assert.equal(await s.page.locator(".cd-steer-input").evaluate((n) => n === document.activeElement), true, "the keys stay");
    await s.page.keyboard.type("RI");
    await s.page.keyboard.press("Enter");
    assert.deepEqual((await s.posted("steer")).map((m) => m.text), ["I'm an NRI"]);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-research-running.png") });
    // The report streams under the card, then it's done.
    await s.send({ type: "research", messageId: M(2), research: { status: "writing", plan: started.plan, reads: 3, notes: [], activity: [] } });
    await s.send({ type: "delta", messageId: M(2), text: "# London flat\n\nThe LRS allows it [1]." });
    await s.frame();
    assert.equal(await card.locator(".cd-research-label").textContent(), "Writing the report…");
    assert.match(await s.page.locator(".cd-assistant .cd-body").textContent(), /The LRS allows it/);
    const report = "# London flat\n\n## The rules\n\nThe LRS allows it [1].\n\n## Taxes\n\nStamp duty is higher [2].";
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: report, finish: "stop",
      sources: [{ n: 1, title: "LRS", url: "https://rbi.org.in/lrs" }, { n: 2, title: "SDLT", url: "https://gov.uk/sdlt" }],
      research: { status: "done", plan: started.plan, round: 2, read: ["a", "b", "c"], started_at: "2026-10-10T10:00:00Z",
                  finished_at: "2026-10-10T10:06:30Z", notes: [{ n: 1, title: "LRS", url: "u", note: "x" }, { n: 2, title: "SDLT", url: "v", note: "y" }],
                  check: { claims: 5, checked: 5, supported: 4, invalid: 0, unsupported: [{ claim: "No visa is needed", cites: [2] }] },
                  activity: [{ kind: "write", text: "Writing the report" }] } } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    assert.equal(await card.locator(".cd-research-stats").textContent(), "3 pages read · 2 noted · 6:30 · citations: 4 of 5 hold up");
    await card.getByText("How it was researched").click();
    assert.deepEqual(await card.locator(".cd-research-unsupported li").allTextContents(), ["No visa is needed"]);
    await card.getByRole("button", { name: "Open report" }).click();
    const reader = s.page.locator("#cd-reader");
    assert.equal(await reader.getAttribute("role"), "dialog");
    assert.deepEqual(await reader.locator(".cd-reader-link").allTextContents(), ["London flat", "The rules", "Taxes"]);
    assert.equal(await reader.locator(".cd-reader-sources .cd-source").count(), 2);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-research-reader.png") });
    await reader.getByRole("button", { name: "Export…" }).click();
    assert.deepEqual((await s.posted("exportReport")).map((m) => [m.messageId, m.title]), [[M(2), "London flat from India"]]);
    await s.page.keyboard.press("Escape");
    assert.equal(await reader.count(), 0);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-research-done.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("deep research that stopped, or was cut short by a restart, offers to write from what it found", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const plan = { title: "Scooters", steps: ["Range and price"], sites: [] };
    const reply = (status, extra = {}) => ({ id: M(2), role: "assistant", text: "Research stopped: 4 pages read, 2 with something useful.",
      finish: "cancelled", research: { status, plan, round: 1, read: ["a", "b", "c", "d"], notes: [{ n: 1, title: "A", url: "u", note: "x" },
      { n: 2, title: "B", url: "v", note: "y" }], activity: [{ kind: "search", text: "scooters" }], ...extra } });
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false,
                   messages: [{ id: M(1), role: "user", text: "Scooters", research: true }, reply("stopped")] });
    const card = s.page.locator(".cd-research");
    assert.equal(await card.locator(".cd-research-label").textContent(), "Research stopped");
    assert.equal(await s.page.locator(".cd-end").count(), 0, "no Continue: this isn't a cut-off reply");
    await card.getByRole("button", { name: "Write the report from 2 sources" }).click();
    assert.deepEqual((await s.posted("researchStart")).map((m) => [m.messageId, m.write]), [[M(2), true]]);
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false,
                   messages: [{ id: M(1), role: "user", text: "Scooters", research: true }, reply("running")] });
    assert.equal(await card.locator(".cd-research-label").textContent(), "Research was interrupted");
    await card.getByRole("button", { name: "Keep researching" }).click();
    assert.deepEqual((await s.posted("researchStart")).map((m) => m.write), [true, undefined]);
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Scooters", research: true },
      { id: M(2), role: "assistant", text: "plan", finish: "stop", research: { status: "planned", plan } },
      { id: M(3), role: "user", text: "Never mind" }] });
    assert.equal(await s.page.locator(".cd-research .cd-research-note").textContent(), "Not started.");
    assert.equal(await s.page.locator(".cd-countdown").count(), 0, "reopened: no count, and an old plan never starts itself");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("deep research: a new plan you don't touch starts by itself when the count runs out", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.page.clock.install();
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [] });
    await s.page.locator("#cd-research").click();
    await s.page.locator("#cd-input").fill("Scooters under 1.5 lakh");
    await s.page.keyboard.press("Enter");
    const plan = { title: "Scooters", steps: ["Range and price"], sites: [] };
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "research", messageId: M(2), research: { status: "planned", plan } });
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "plan", finish: "stop", research: { status: "planned", plan } } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.page.clock.runFor(10_000);
    assert.match(await s.page.locator(".cd-countdown").textContent(), /^Starting in [56]s$/);
    assert.equal((await s.posted("researchStart")).length, 0);
    await s.page.clock.runFor(6_000);
    assert.deepEqual((await s.posted("researchStart")).map((m) => [m.messageId, m.plan, m.write]), [[M(2), undefined, undefined]]);
    assert.equal(await s.page.locator("#cd-send").isVisible(), false, "it's running: Stop, not Send");
  } finally { await s.page.close(); }
});

test("a send refused before it starts gives back what was typed, and never leaves the box stuck", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [] });
    // A finished turn first: its reply id mustn't make a later refusal look like a running reply.
    await s.page.locator("#cd-input").fill("hi");
    await s.page.keyboard.press("Enter");
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Hello.", finish: "stop" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.page.locator("#cd-research").click();
    await s.page.locator("#cd-input").fill("Scooters under 1.5 lakh");
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#cd-input").inputValue(), "");
    await s.send({ type: "error", message: "Deep research needs a context window of at least 16k: choose 32k or more in Settings." });
    assert.equal(await s.page.locator("#cd-input").inputValue(), "Scooters under 1.5 lakh", "nothing typed is lost");
    assert.equal(await s.page.locator("#cd-research").getAttribute("aria-pressed"), "true", "still a research request");
    assert.deepEqual([await s.page.locator("#cd-stop").isHidden(), await s.page.locator("#cd-send").isDisabled()], [true, false],
                     "not stuck as if a reply were running");
    assert.match(await s.page.locator("#cd-notice").textContent(), /at least 16k/);
  } finally { await s.page.close(); }
});

test("memory: a reply says what it saved, with Forget, and the way to everything remembered", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "I'm vegetarian and I moved to Goa" },
      { id: M(2), role: "assistant", text: "Noted.", finish: "stop", memory: [
        { op: "saved", id: "mem_aaaaaaaaaaaa", text: "Is vegetarian" }, { op: "forgot", id: "mem_bbbbbbbbbbbb", text: "Lives in Pune" }] }] });
    const note = s.page.locator(".cd-memory");
    assert.deepEqual(await note.locator(".cd-memory-text").allTextContents(), ["Remembered: Is vegetarian", "Forgot: Lives in Pune"]);
    assert.equal(await note.locator(".cd-memory-forget").count(), 1, "Forget only for what it kept");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-memory-chip.png") });
    await note.getByRole("button", { name: "Forget" }).click();
    assert.deepEqual(await s.posted("forgetMemory"), [{ type: "forgetMemory", id: "mem_aaaaaaaaaaaa" }]);
    await s.frame();
    assert.equal(await note.locator(".cd-memory-text").first().textContent(), "Forgotten: Is vegetarian");
    assert.equal(await note.locator(".cd-memory-forget").count(), 0);
    await note.getByRole("button", { name: "Manage memory" }).click();
    assert.equal((await s.posted("openMemory")).length, 1);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the Library: once ChatDGC has made a file, show what you uploaded or what it made", async (t) => {
  if (skipOrFail(t)) return;
  const { html, js } = libraryHtml();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate((code) => {
      window.__posted = []; window.__state = undefined;
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
      eval(code);
    }, js);
    const send = (d) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
    const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
    await send({ type: "library", files: [], total: 0, next: null, counts: {}, origins: { made: 0, uploaded: 0 } });
    assert.equal(await page.locator("#lib-origins").isHidden(), true, "nothing made yet: no filter to show");
    const made = { source: "chat", chat_id: `chat_${"a".repeat(32)}`, id: `att_${"1".repeat(32)}`, name: "LRS brief.docx", kind: "document",
                   type: "document", size: 4754, created_at: new Date().toISOString(), chat_title: "Visa", made: true };
    await send({ type: "library", files: [made], total: 1, next: null, counts: { document: 1 }, origins: { made: 1, uploaded: 2 } });
    assert.deepEqual(await page.locator("#lib-origins .lib-kind").allInnerTexts(), ["All\n3", "Uploaded\n2", "Made by ChatDGC\n1"]);
    assert.equal(await page.locator(".lib-meta").textContent(), "Document · 5 KB · made in “Visa” · Today");
    await page.locator("#lib-origins .lib-kind", { hasText: "Made by ChatDGC" }).click();
    assert.deepEqual((await posted("list")).at(-1), { type: "list", query: "", kind: "", origin: "made", offset: 0 });
    await send({ type: "library", files: [made], total: 1, next: null, counts: { document: 1 }, origins: { made: 1, uploaded: 2 } });
    assert.equal(await page.locator("#lib-origins .lib-kind[aria-pressed=true]").innerText(), "Made by ChatDGC\n1");
    await send({ type: "refresh" });
    assert.deepEqual((await posted("list")).at(-1), { type: "list", query: "", kind: "", origin: "made", offset: 0 },
                     "shown again: asked again, with the filter kept");
    assert.equal(await page.locator(".lib-name").count(), 1, "what it showed stays until the new list comes");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test("study mode: the chat's, on when it opens on, sent with each message, and off for a chat without it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const study = s.page.locator("#cd-study");
    await s.send({ type: "opened", conversation: conversation({ title: "Fractions", study: true }), earlier: 0, busy: false, messages: [] });
    await s.frame();
    assert.equal(await study.getAttribute("aria-pressed"), "true", "a chat in study mode opens with it on");
    assert.equal(await s.page.locator("#cd-input").getAttribute("placeholder"), "What do you want to learn?");
    await s.page.locator("#cd-input").fill("Teach me halves");
    await s.page.keyboard.press("Enter");
    assert.equal((await s.posted("send")).at(-1).study, true);
    await s.send({ type: "opened", conversation: conversation({ id: `chat_${"9".repeat(32)}`, title: "Other" }), earlier: 0, busy: false, messages: [] });
    await s.frame();
    assert.equal(await study.getAttribute("aria-pressed"), "false", "another chat: as it is");
    assert.equal(await s.page.locator("#cd-input").getAttribute("placeholder"), "Ask anything");
    await study.click();
    assert.equal(await study.getAttribute("aria-pressed"), "true");
    await s.page.locator("#cd-input").fill("x");          // a redraw keeps what the box asks for
    assert.equal(await s.page.locator("#cd-input").getAttribute("placeholder"), "What do you want to learn?");
    await s.page.locator("#cd-input").fill("");
    await s.page.locator("#cd-research").click();
    assert.equal(await s.page.locator("#cd-input").getAttribute("placeholder"), "What should I research?", "research asks for its own");
    await s.page.locator("#cd-input").fill("y");
    assert.equal(await s.page.locator("#cd-input").getAttribute("placeholder"), "What should I research?", "and keeps it as you type");
    await s.page.locator("#cd-input").fill("");
    await s.page.locator("#cd-research").click();
    await study.click();
    assert.equal(await study.getAttribute("aria-pressed"), "false", "and off again");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("writing blocks: a draft reads as the email or message it is, with Copy, Open in mail app and Edit in place", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const email = "To: rao@example.com\nSubject: Moving out of 4B\n\nDear Mr Rao,\n\nI'm **leaving** on 30 November.";
    const fence = "```";
    const text = `Here it is, see [the notice rules](https://example.gov/notice).\n\n${fence}email\n${email}\n${fence}\n\nFor WhatsApp:\n\n`
      + `${fence}\ndraft\nHey all, party at 7!\n${fence}\n\nAnd code:\n\n${fence}python\nprint(1)\n${fence}`;
    await s.send({ type: "opened", conversation: conversation({ title: "Notice" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Draft my notice" }, { id: M(2), role: "assistant", text, finish: "stop" }] });
    await s.frame();
    const drafts = s.page.locator(".cd-draft");
    assert.deepEqual(await drafts.evaluateAll((n) => n.map((x) => x.dataset.kind)), ["email", "draft"], "the label on its own line too");
    assert.equal(await s.page.locator("pre.code").count(), 1, "code stays code");
    const mail = drafts.first();
    assert.equal(await mail.locator(".cd-draft-to").textContent(), "To: rao@example.com");
    assert.equal(await mail.locator(".cd-draft-subject").textContent(), "Moving out of 4B");
    assert.equal(await mail.locator(".cd-draft-body").textContent(), "Dear Mr Rao,\n\nI'm leaving on 30 November.", "no stray marks");
    assert.equal(await mail.locator("b, strong").count(), 0, "words, never markup");
    assert.deepEqual(await mail.locator(".cd-draft-tool").allInnerTexts(), ["Copy", "Open in mail app", "Edit"]);
    assert.deepEqual(await drafts.nth(1).locator(".cd-draft-tool").allInnerTexts(), ["Copy", "Edit"], "a message has no mail app");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-writing-blocks.png") });
    await mail.getByRole("button", { name: "Copy" }).click();
    assert.equal((await s.posted("copy")).at(-1).text, "Dear Mr Rao,\n\nI'm leaving on 30 November.");
    await mail.getByRole("button", { name: "Open in mail app" }).click();
    assert.deepEqual((await s.posted("openMail")).at(-1), { type: "openMail", to: "rao@example.com", cc: "", bcc: "",
                                                           subject: "Moving out of 4B", body: "Dear Mr Rao,\n\nI'm leaving on 30 November." });
    // Edit in place: as it reads; Save sends the block's words, refused comes back to editing, saved is the reply's.
    await mail.getByRole("button", { name: "Edit" }).click();
    assert.equal(await mail.locator(".cd-draft-subject-input").inputValue(), "Moving out of 4B");
    assert.equal(await mail.locator(".cd-draft-text").inputValue(), "Dear Mr Rao,\n\nI'm leaving on 30 November.");
    await mail.locator(".cd-draft-text").fill("Dear Mr Rao,\n\nI'm leaving on 1 December.");
    await mail.getByRole("button", { name: "Save" }).click();
    const edited = "To: rao@example.com\nSubject: Moving out of 4B\n\nDear Mr Rao,\n\nI'm leaving on 1 December.";
    assert.deepEqual((await s.posted("draftEdit")).at(-1), { type: "draftEdit", messageId: M(2), original: email, text: edited });
    assert.equal(await mail.getByRole("button", { name: "Saving…" }).isDisabled(), true);
    await s.send({ type: "error", message: "Let the reply finish first." });
    await s.frame();
    assert.equal(await mail.getByRole("button", { name: "Save" }).isDisabled(), false, "refused: still yours to save");
    assert.equal(await mail.locator(".cd-draft-text").inputValue(), "Dear Mr Rao,\n\nI'm leaving on 1 December.");
    await mail.getByRole("button", { name: "Save" }).click();
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: text.replace(email, edited), finish: "stop" } });
    await s.frame();
    assert.equal(await s.page.locator(".cd-draft-text").count(), 0, "saved: it reads again");
    assert.equal(await s.page.locator(".cd-draft-body").first().textContent(), "Dear Mr Rao,\n\nI'm leaving on 1 December.");
    assert.equal(await s.page.locator("#cd-announce").textContent(), "Draft saved.");
    // The reply's Copy: clean text where there's no rich clipboard; formatted and clean where there is.
    const replyCopy = s.page.locator(`.cd-assistant[data-id="${M(2)}"] .cd-actions button[aria-label="Copy"]`);
    await replyCopy.click();
    assert.equal((await s.posted("copy")).at(-1).text, "Here it is, see the notice rules.\n\nTo: rao@example.com\n\nMoving out of 4B\n\n"
      + "Dear Mr Rao,\n\nI'm leaving on 1 December.\n\nFor WhatsApp:\n\nHey all, party at 7!\n\nAnd code:\n\nprint(1)", "no ** or #, no buttons");
    await s.page.evaluate(() => {
      window.ClipboardItem = class { constructor(parts) { this.parts = parts; } async getType(t) { return this.parts[t]; } };
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write: async ([item]) => {
        window.__clip = { plain: await (await item.getType("text/plain")).text(), html: await (await item.getType("text/html")).text() }; } } });
    });
    const before = (await s.posted("copy")).length;
    await replyCopy.click();
    await s.page.waitForFunction(() => !!window.__clip);
    const clip = await s.page.evaluate(() => window.__clip);
    assert.equal((await s.posted("copy")).length, before, "the rich clipboard took it");
    assert.match(clip.html, /<a href="https:\/\/example\.gov\/notice">the notice rules<\/a>/, "links stay links in a mail app");
    assert.doesNotMatch(clip.html, /<button|cd-draft-tool|code-language/, "none of the screen's own controls");
    assert.match(clip.plain, /^Here it is, see the notice rules\./);
    // While a reply is still being written, its draft has no Edit yet.
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "delta", messageId: M(4), text: `${fence}email\nSubject: Again\n\nHello` });
    await s.frame();
    assert.deepEqual(await s.page.locator(`.cd-assistant[data-id="${M(4)}"] .cd-draft-tool`).allInnerTexts(), ["Copy", "Open in mail app"]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("canvas: a card where the reply made or changed one (Open), a message from the editor, and what part it was about", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const CV = `cv_${"1".repeat(16)}`;
    await s.send({ type: "opened", conversation: conversation({ title: "Trip" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Plan my trip in a canvas" },
      { id: M(2), role: "assistant", text: "A two-day plan is open beside the chat.", finish: "stop",
        canvases: [{ id: CV, title: "Goa <b>trip</b>", kind: "document", language: "markdown", version: 1, op: "created", at: 0 }] },
      { id: M(3), role: "user", text: "Make this livelier", canvas: { id: CV, title: "Goa trip", start_line: 5, end_line: 7, text: "Beach" } },
      { id: M(4), role: "assistant", text: "Done.", finish: "stop" }] });
    await s.frame();
    const card = s.page.locator(".cd-canvas");
    assert.equal(await card.locator(".cd-file-name").textContent(), "Goa <b>trip</b>", "a title is text");
    assert.equal(await card.locator(".cd-file-meta").textContent(), "Canvas · Document · made, version 1");
    await card.getByRole("button", { name: "Open" }).click();
    assert.deepEqual((await s.posted("canvasOpen")).at(-1), { type: "canvasOpen", canvasId: CV });
    assert.equal(await s.page.locator(".cd-user-canvas").textContent(), "About lines 5–7 of Goa trip");
    // Live: "Writing in the canvas…", then the card; an edit of the same canvas updates its card.
    await s.send({ type: "turn", state: "started", replyId: M(6) });
    await s.send({ type: "activity", messageId: M(6), kind: "canvas", text: "Goa trip" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").last().textContent(), "Writing in the canvas Goa trip…");
    await s.send({ type: "canvas", messageId: M(6), canvas: { id: CV, title: "Goa trip", kind: "document", version: 2, op: "edited" } });
    await s.send({ type: "canvas", messageId: M(6), canvas: { id: CV, title: "Goa trip", kind: "document", version: 3, op: "edited" } });
    await s.frame();
    assert.equal(await s.page.locator(`.cd-assistant[data-id="${M(6)}"] .cd-canvas`).count(), 1, "one card per canvas");
    assert.equal(await s.page.locator(`.cd-assistant[data-id="${M(6)}"] .cd-canvas .cd-file-meta`).textContent(), "Canvas · Document · changed, version 3");
    await s.send({ type: "message", message: { id: M(6), role: "assistant", text: "Livelier now.", finish: "stop",
                                               canvases: [{ id: CV, title: "Goa trip", kind: "document", version: 3, op: "edited", at: 0 }] } });
    await s.send({ type: "turn", state: "ended", replyId: M(6) });
    await s.frame();
    // From the editor (Ask ChatDGC, a shortcut): sent as if typed here, with this tab's model and thinking.
    const selection = { canvas_id: CV, start_line: 2, end_line: 2, text: "Day 1" };
    await s.send({ type: "sendFromEditor", text: "Make day 1 calmer", canvasSelection: selection });
    const sent = (await s.posted("send")).at(-1);
    assert.deepEqual([sent.text, sent.canvas_selection], ["Make day 1 calmer", selection]);
    await s.send({ type: "sendFromEditor", text: "Again" });
    await s.frame();
    assert.equal((await s.posted("send")).length, 1, "not while a reply is being written");
    assert.match(await s.page.locator("#cd-notice").textContent(), /Let the reply finish first/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("charts: a ```chart block drawn as bar, line, pie or scatter; hover values, legend, Data, Copy data, Save image", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 900, height: 1400 });
  try {
    const fence = "```";
    const bar = { type: "bar", title: "Spend by month <b>2026</b>", x: ["Jan", "Feb", "Mar"], unit: "₹",
                  series: [{ name: "Food", values: [1200, 950, 1100] }, { name: "Travel", values: [400, "3,400", null] }] };
    const line = { type: "line", title: "Weight", x: ["W1", "W2", "W3", "W4"], series: [{ name: "kg", values: [82, 81.4, 80.9, 80.2] }] };
    const pie = { type: "pie", title: "Where it goes", x: ["Rent", "Food", "Other"], series: [{ name: "Share", values: [60, 25, 15] }], unit: "%" };
    const scatter = { type: "scatter", title: "Price vs size", series: [{ name: "Flats", points: [[50, 40], [80, 65], [120, 90]] }] };
    const text = [bar, line, pie, scatter].map((c) => `${fence}chart\n${JSON.stringify(c)}\n${fence}`).join("\n\n")
      + `\n\nBroken:\n\n${fence}chart\n{"type": "bar", "x": [\n${fence}`;
    await s.send({ type: "opened", conversation: conversation({ title: "Spend" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Chart my spend" }, { id: M(2), role: "assistant", text, finish: "stop" }] });
    await s.frame();
    const charts = s.page.locator(".cd-chart");
    assert.deepEqual(await charts.evaluateAll((n) => n.map((x) => x.dataset.type)), ["bar", "line", "pie", "scatter"]);
    assert.equal(await s.page.locator('pre.code[data-language="chart"]').count(), 1, "JSON that won't read stays as it was written");
    const first = charts.first();
    assert.equal(await first.locator(".cd-chart-title").textContent(), "Spend by month <b>2026</b>", "a title is text");
    assert.equal(await first.locator("rect.cd-chart-mark").count(), 5, "3 + 2 bars: a gap where there's no number");
    assert.deepEqual(await first.locator(".cd-chart-key").allInnerTexts(), ["Food", "Travel"]);
    assert.equal(await charts.nth(2).locator("path.cd-chart-mark").count(), 3, "a slice each");
    assert.equal(await charts.nth(3).locator("circle.cd-chart-mark").count(), 3);
    if (process.env.DGC_SHOTS) {
      for (let i = 0; i < 4; i++) await charts.nth(i).screenshot({ path: join(process.env.DGC_SHOTS, `chatdgc-chart-${i + 1}.png`) });
    }
    // Hover: the value, with its unit.
    await first.locator("rect.cd-chart-mark").nth(3).hover();
    assert.equal(await first.locator(".cd-chart-tip").textContent(), "Jan · Travel: ₹400");
    // The legend hides a series (never the last one shown).
    await first.locator(".cd-chart-key", { hasText: "Travel" }).click();
    assert.equal(await first.locator("rect.cd-chart-mark").count(), 3);
    await first.locator(".cd-chart-key", { hasText: "Food" }).click();
    assert.equal(await first.locator("rect.cd-chart-mark").count(), 3, "one series always stays");
    await first.locator(".cd-chart-key", { hasText: "Travel" }).click();
    // Data, Copy data, Save image.
    await first.getByRole("button", { name: "Data", exact: true }).click();
    assert.deepEqual(await first.locator(".cd-chart-table tr").allInnerTexts(), ["\tFood\tTravel", "Jan\t₹1,200\t₹400",
                                                                                "Feb\t₹950\t₹3,400", "Mar\t₹1,100\t"]);
    await first.getByRole("button", { name: "Copy data" }).click();
    assert.equal((await s.posted("copy")).at(-1).text, ",Food,Travel\nJan,1200,400\nFeb,950,3400\nMar,1100,");
    await first.getByRole("button", { name: "Save image" }).click();
    await s.page.waitForFunction(() => window.__posted.some((m) => m.type === "saveImage"), null, { timeout: 5000 });
    const saved = (await s.posted("saveImage")).at(-1);
    assert.match(saved.name, /^Spend by month .*2026.*\.png$/);
    assert.match(saved.data, /^data:image\/png;base64,/);
    // What the reply ran on the spreadsheets: shut, then each SQL and its rows.
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text, finish: "stop", queries: [
      { sql: "SELECT category, SUM(amount) FROM expenses GROUP BY category", columns: ["category", "SUM(amount)"],
        rows: [["Rent", 25000], ["<b>Food</b>", 2050.5]], count: 2, more: false },
      { sql: "DROP TABLE expenses", error: "Only one SELECT query at a time." }] } });
    await s.frame();
    const analysis = s.page.locator(".cd-analysis");
    assert.equal(await analysis.locator(".cd-analysis-summary").textContent(), "Analyzed the data · 2 queries");
    assert.equal(await analysis.evaluate((d) => d.open), false, "shut until asked");
    await analysis.locator(".cd-analysis-summary").click();
    assert.deepEqual(await analysis.locator(".cd-analysis-sql").allTextContents(),
                     ["SELECT category, SUM(amount) FROM expenses GROUP BY category", "DROP TABLE expenses"]);
    assert.deepEqual(await analysis.locator(".cd-analysis-table tr").allInnerTexts(), ["category\tSUM(amount)", "Rent\t25000", "<b>Food</b>\t2050.5"]);
    assert.equal(await analysis.locator(".cd-analysis-error").textContent(), "Only one SELECT query at a time.");
    // While the reply is written, a chart whose JSON is still coming says so instead of showing half of it.
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "delta", messageId: M(4), text: `${fence}chart\n{"type": "line", "x": ["a",` });
    await s.frame();
    assert.equal(await s.page.locator(`.cd-assistant[data-id="${M(4)}"] .cd-chart-pending`).textContent(), "Drawing a chart…");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("files a reply made: a card with what each is, Open and Save a copy…, live as it's made", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const F = (c) => "att_" + c.repeat(32);
    const files = [
      { id: F("1"), name: "LRS <b>brief</b>.docx", kind: "document", format: "docx", size: 4754, made: true, at: 0 },
      { id: F("2"), name: "Brief.pdf", kind: "document", format: "pdf", size: 90473, pages: 3, made: true, at: 0,
        note: "This PDF is plain text in Helvetica: no Chrome or Edge was found to print it." },
      { id: F("3"), name: "Old.xlsx", kind: "document", format: "xlsx", size: 3980, made: true, at: 0, removed: true }];
    await s.send({ type: "opened", conversation: conversation({ title: "Brief" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "A brief, please" }, { id: M(2), role: "assistant", text: "Here it is.", finish: "stop", files }] });
    await s.frame();
    const card = (c) => s.page.locator(`.cd-file:has(.cd-file-name) >> nth=${c}`);
    assert.deepEqual(await s.page.locator(".cd-file-badge").allTextContents(), ["DOCX", "PDF", "XLSX"]);
    assert.equal(await card(0).locator(".cd-file-name").textContent(), "LRS <b>brief</b>.docx", "a name is text");
    assert.equal(await card(0).locator("b").count(), 0);
    assert.equal(await card(0).locator(".cd-file-meta").textContent(), "Word document · 5 KB");
    assert.equal(await card(1).locator(".cd-file-meta").textContent(), "PDF · 88 KB · 3 pages");
    assert.match(await card(1).locator(".cd-file-note").textContent(), /no Chrome or Edge was found/);
    assert.equal(await card(2).locator(".cd-file-meta").textContent(), "Deleted from your Library");
    assert.equal(await card(2).locator("button").count(), 0, "nothing to open");
    assert.deepEqual(await card(0).locator("button").allTextContents(), ["Open", "Save a copy…"]);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-made-files.png") });
    await card(0).locator("button", { hasText: "Open" }).click();
    await card(1).locator("button", { hasText: "Save a copy…" }).click();
    assert.deepEqual(await s.posted("fileOpen"), [{ type: "fileOpen", messageId: M(2), fileId: F("1"), name: "LRS <b>brief</b>.docx" }]);
    assert.deepEqual(await s.posted("fileSave"), [{ type: "fileSave", messageId: M(2), fileId: F("2"), name: "Brief.pdf" }]);
    // As a reply makes one: "Making …" while it's laid out, then its card, with the reply still going.
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "activity", messageId: M(4), kind: "making", text: "Budget" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-activity").last().textContent(), "Making Budget…");
    await s.send({ type: "made", messageId: M(4), file: { id: F("4"), name: "Budget.xlsx", format: "xlsx", size: 3000, made: true, at: 0 } });
    await s.send({ type: "made", messageId: M(4), file: { id: "not-an-id", name: "x.docx", format: "docx" } });
    await s.frame();
    assert.equal(await s.page.locator(`.cd-file[aria-label="Budget.xlsx, Excel workbook"]`).count(), 1);
    assert.equal(await s.page.locator(`.cd-file[aria-label^="x.docx"]`).count(), 0, "only a file DGC named");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
