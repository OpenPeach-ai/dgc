// ChatDGC's screen (media/chatdgc.js) and the home's Chat list (media/main.js), in real Chromium. The page is
// the document src/chatdgc.ts serves, with its stylesheets inlined; what it posts is what the extension host
// would receive. Everything a person or a model wrote must arrive as text or inert Markdown, never markup.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
  const own = readFileSync(join(root, "media/chatdgc.css"), "utf8") + readFileSync(join(root, "media/voicebar.css"), "utf8");
  // The page's own scripts, in the order chatdgc.ts loads them: a list kept here by hand misses the next one added.
  const scripts = [...source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1].matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => m[1]);
  assert.equal(scripts.at(-1), "chatdgc.js");
  const js = scripts.map((f) => readFileSync(join(root, "media", f), "utf8")).join("\n");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife",
    globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  cached = { html: doc.replace("</head>", `<style>${codicon}</style><style>${css}</style><style>${own}</style></head>`), js, markdownJs };
  return cached;
}

async function openScreen({ width = 900, height = 700, theme = "dark-modern", state, reducedMotion = false } = {}) {
  const { html, js, markdownJs } = screenHtml();
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
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
    // As main DGC: one pill for the model and its thinking, opening a menu (the model, then the dial).
    await s.page.locator("#cd-model-pill").click();
    await s.page.locator(".cd-menu-row", { hasText: "qwen3:32b" }).click();
    await s.page.locator(".cd-dial-face").focus();
    for (let i = 0; i < 3; i++) await s.page.keyboard.press("ArrowRight");
    await s.page.keyboard.press("Escape");
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

test("a click opens the thinking while it still thinks, even when a delta redraws the reply between press and release", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "message", message: { id: M(1), role: "user", text: "Plan a week in Goa" } });
    await s.send({ type: "delta", messageId: M(2), thinking: "First the beaches. " });
    await s.frame();
    const box = s.page.locator(".cd-assistant details.cd-thinking"), label = s.page.locator(".cd-thinking-label");
    assert.equal(await box.getAttribute("open"), null, "collapsed while it thinks: the founder's default");
    // A press, a streamed delta that redraws the reply, then the release: one click, as a reader makes it mid-stream.
    const at = await label.boundingBox();
    await s.page.mouse.move(at.x + 20, at.y + at.height / 2);
    await s.page.mouse.down();
    await s.send({ type: "delta", messageId: M(2), thinking: "Then the forts. " });
    await s.frame();
    await s.page.mouse.up();
    await s.frame();
    assert.equal(await box.getAttribute("open"), "", "opened by that click");
    for (const piece of ["Then the food. ", "Then the monsoon. "]) { await s.send({ type: "delta", messageId: M(2), thinking: piece }); await s.frame(); }
    assert.equal(await box.getAttribute("open"), "", "and it stays open while the thinking keeps coming");
    assert.equal(await s.page.locator(".cd-thought").textContent(), "First the beaches. Then the forts. Then the food. Then the monsoon. ",
                 "the words kept up all the same");
    await s.send({ type: "delta", messageId: M(2), text: "Day 1: the beaches." });
    await s.frame();
    assert.equal(await box.getAttribute("open"), "", "the answer starting doesn't close what the reader opened");
    await label.focus();
    await s.page.keyboard.press("Enter");
    await s.frame();
    assert.equal(await box.getAttribute("open"), null, "closed again from the keyboard");
    await s.send({ type: "delta", messageId: M(2), text: " Day 2: the forts." });
    await s.frame();
    assert.equal(await box.getAttribute("open"), null, "and the reader's choice holds as the reply streams");
    await label.focus();
    await s.page.keyboard.press("Enter");
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Day 1: the beaches. Day 2: the forts.", thinking: "First the beaches.", finish: "stop" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.match(await label.textContent(), /^Thought$/);
    assert.equal(await box.getAttribute("open"), "", "opened while it streamed, it stays open once the reply is finished");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("with no click, the thinking is collapsed while it thinks, as the answer streams, once it's finished, and in a chat opened later", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "delta", messageId: M(2), thinking: "Hmm." });
    await s.frame();
    assert.equal(await s.page.locator("details.cd-thinking").getAttribute("open"), null, "collapsed while it thinks");
    assert.equal(await shown(s.page, ".cd-thought"), false, "its words wait behind the label");
    await s.send({ type: "delta", messageId: M(2), text: "Yes." });
    await s.frame();
    assert.equal(await s.page.locator("details.cd-thinking").getAttribute("open"), null, "and as the answer streams");
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Yes.", thinking: "Hmm.", finish: "stop" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.equal(await s.page.locator("details.cd-thinking").getAttribute("open"), null, "and once it's finished");
    await s.send({ type: "opened", conversation: conversation({ id: `chat_${"b".repeat(32)}` }), earlier: 0, busy: false,
                   messages: [{ id: M(3), role: "user", text: "Hi" }, { id: M(4), role: "assistant", text: "Hello.", thinking: "A greeting.", finish: "stop" }] });
    await s.frame();
    assert.equal(await s.page.locator("details.cd-thinking").getAttribute("open"), null, "a chat opened later shows its thinking collapsed");
    await s.page.locator(".cd-thinking-label").click();
    assert.equal(await s.page.locator("details.cd-thinking").getAttribute("open"), "", "a click opens it");
    assert.equal(await s.page.locator(".cd-thought").textContent(), "A greeting.");
  } finally { await s.page.close(); }
});

// "The 'Thinking' word flickers a lot" (founder, 2026-10-18): every streamed part drew the reply again, taking the
// thinking box out of the page and putting it back, so the pointer's hover over the label came and went with each part,
// and the working line's pulse started over with each one. Now nothing a part doesn't change is touched, and the label
// is Work's status line: DGC's slashes lighting in turn, beside words that hold still.
test("while it thinks, no streamed part redraws 'Thinking' or the working line, and both are Work's wave: slashes lighting in turn, words still", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "message", message: { id: M(1), role: "user", text: "Plan a week in Goa" } });
    await s.send({ type: "activity", messageId: M(2), kind: "searching", text: "goa in december" });
    await s.send({ type: "delta", messageId: M(2), thinking: "First the beaches. " });
    await s.frame();
    const label = s.page.locator(".cd-thinking-label");
    const at = await label.boundingBox();
    await s.page.mouse.move(at.x + 30, at.y + at.height / 2);
    // Watch for the label, the working line or anything holding them leaving the page, part by part.
    await s.page.evaluate(() => {
      window.__label = document.querySelector(".cd-thinking-label"); window.__doing = document.querySelector(".cd-working");
      window.__out = 0;
      new MutationObserver((records) => {
        for (const r of records) for (const n of r.removedNodes) if (n.nodeType === 1 && (n.contains(window.__label) || n.contains(window.__doing))) window.__out++;
      }).observe(document.getElementById("cd-log"), { childList: true, subtree: true });
      for (const n of document.querySelectorAll(".cd-wave .tmark .s1")) n.getAnimations().forEach((a) => { a.id = "first"; });
    });
    const hovered = [];
    for (let i = 0; i < 20; i++) {
      await s.send({ type: "delta", messageId: M(2), thinking: `Part ${i}. ` });
      await s.frame();
      hovered.push(await s.page.evaluate(() => window.__label.matches(":hover")));
    }
    assert.equal(await s.page.evaluate(() => window.__out), 0, "20 parts streamed, and the label and the working line never left the page");
    assert.deepEqual([...new Set(hovered)], [true], "the pointer's hover over the label held through every part (it came and went with each)");
    assert.equal(await s.page.evaluate(() => window.__label.isConnected && document.querySelector(".cd-thinking-label") === window.__label
                                          && document.querySelector(".cd-working") === window.__doing), true, "the same nodes");
    assert.match(await s.page.locator(".cd-thought").textContent(), /^First the beaches\. Part 0\. .*Part 19\. $/, "the words kept up");
    // Work's wave: the three slashes light in turn (Work's own keyframes), and the words beside them hold still.
    const look = await s.page.evaluate(() => [".cd-thinking-label", ".cd-working"].map((sel) => {
      const line = document.querySelector(sel), marks = [...line.querySelectorAll(".cd-wave .tmark path")];
      return { marks: marks.map((p) => getComputedStyle(p).animationName), still: getComputedStyle(line.querySelector(".verb")).animationName,
               line: getComputedStyle(line).animationName, kept: marks[0].getAnimations().map((a) => a.id), hidden: line.querySelector(".tmark").getAttribute("aria-hidden") };
    }));
    for (const one of look) {
      assert.deepEqual(one.marks, ["dgc-mark1", "dgc-mark2", "dgc-mark3"], "Work's slashes, lit in turn");
      assert.equal(one.still, "none"); assert.equal(one.line, "none", "no pulse: the words hold still");
      assert.deepEqual(one.kept, ["first"], "the wave ran on through every part: never started over");
      assert.equal(one.hidden, "true", "the slashes are drawing; the words are what a screen reader says");
    }
    assert.equal(await label.textContent(), "Thinking");
    assert.equal(await s.page.locator(".cd-working").textContent(), "Searching the web for “goa in december”…");
    await s.send({ type: "delta", messageId: M(2), text: "Day 1: the beaches." });
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Day 1: the beaches.", thinking: "First the beaches.", finish: "stop" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.equal(await label.textContent(), "Thought", "finished: the label is still, with no wave");
    assert.equal(await s.page.locator(".cd-thinking-label .tmark").count(), 0);
    assert.equal(await s.page.locator(".cd-working").count(), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// "I am not able to scroll just the thinking section to read it all" (founder, 2026-10-18): each streamed part put a
// new thinking box in the page, its scroll back at the top, and the chat's follow pulled it away as the answer came.
test("an open thinking box scrolls on its own while it streams: wheel and keys, the chat doesn't pull it away, and at its end the wheel goes on to the chat", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ height: 640 });
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "message", message: { id: M(1), role: "user", text: "Plan a week in Goa" } });
    await s.send({ type: "delta", messageId: M(2), thinking: "Line 0: where to start.\n" });
    await s.frame();
    await s.page.locator(".cd-thinking-label").click();
    const words = s.page.locator(".cd-thought");
    const part = async (i, kind = "thinking") => {
      await s.send({ type: "delta", messageId: M(2), [kind]: kind === "thinking" ? `Line ${i}: the beaches, the forts, the food.\n` : `Day ${i}: a full day out.\n\n` });
      await s.frame();
    };
    for (let i = 1; i <= 40; i++) await part(i);
    const box = () => words.evaluate((n) => ({ top: n.scrollTop, end: n.scrollHeight - n.clientHeight, at: n.getBoundingClientRect().top }));
    let b = await box();
    assert.ok(b.end > 400, `it holds more than it shows (${b.end}px more)`);
    assert.ok(b.end - b.top < 4, "open at its end, it follows its words as they come");
    // The reader wheels up inside it while it goes on thinking.
    const r = await words.boundingBox();
    await s.page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await s.page.mouse.wheel(0, -300);
    await s.page.waitForTimeout(250);
    const read = (await box()).top;
    assert.ok(read < b.end - 200, `the wheel scrolled the box itself (${read} of ${b.end})`);
    for (let i = 41; i <= 60; i++) await part(i);
    b = await box();
    assert.ok(Math.abs(b.top - read) < 2, `the reader's place held while 20 more parts came (${b.top}, was ${read})`);
    // The answer streams below: the chat no longer follows it, so the box stays where the reader is.
    const before = b.at, page = await s.page.evaluate(() => document.getElementById("cd-scroll").scrollTop);
    for (let i = 1; i <= 20; i++) await part(i, "text");
    b = await box();
    assert.equal(b.at, before, "the box didn't move on screen as the answer grew below it");
    assert.equal(await s.page.evaluate(() => document.getElementById("cd-scroll").scrollTop), page, "the chat stayed put");
    assert.ok(Math.abs(b.top - read) < 2, "and nor did the reader's place in it");
    // The keys, once it has focus.
    await words.focus();
    assert.equal(await words.evaluate((n) => [n.tabIndex, n.getAttribute("role"), n.getAttribute("aria-label")].join("|")), "0|region|The model's thinking");
    await s.page.keyboard.press("Home");
    await s.page.waitForTimeout(250);
    assert.equal((await box()).top, 0, "Home: its first words");
    await s.page.keyboard.press("PageDown");
    await s.page.waitForTimeout(250);
    assert.ok((await box()).top > 100, "Page Down scrolls it");
    // At its end, the wheel isn't held: it goes on to the chat.
    await words.evaluate((n) => { n.scrollTop = n.scrollHeight; });
    await s.page.mouse.move(r.x + r.width / 2, (await words.boundingBox()).y + 40);
    const chat0 = await s.page.evaluate(() => document.getElementById("cd-scroll").scrollTop);
    await s.page.mouse.wheel(0, 400);
    await s.page.waitForTimeout(300);
    assert.ok(await s.page.evaluate(() => document.getElementById("cd-scroll").scrollTop) > chat0 + 100, "the chat scrolled on");
    // The reply finishing draws the chat again: the box keeps the reader's place.
    await words.evaluate((n) => { n.scrollTop = 150; });
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Day 1: a full day out.", thinking: (await words.textContent()), finish: "stop" } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.equal(await s.page.locator(".cd-thinking-label").textContent(), "Thought");
    assert.equal(await s.page.locator("details.cd-thinking").getAttribute("open"), "", "still open");
    assert.equal(await words.evaluate((n) => n.scrollTop), 150, "and still where the reader was");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("for a reader who asked for less motion, the wave is still: all three slashes lit", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ reducedMotion: true });
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "activity", messageId: M(2), kind: "searching", text: "goa" });
    await s.send({ type: "delta", messageId: M(2), thinking: "Hmm." });
    await s.frame();
    const marks = await s.page.evaluate(() => [...document.querySelectorAll(".cd-wave .tmark path")]
      .map((p) => [getComputedStyle(p).animationName, getComputedStyle(p).opacity]));
    assert.equal(marks.length, 6, "the label's and the working line's");
    assert.deepEqual([...new Set(marks.map(([name]) => name))], ["none"]);
    assert.deepEqual([...new Set(marks.map(([, opacity]) => opacity))], ["1"]);
  } finally { await s.page.close(); }
});

// A narrow box drew Temporary as a bare native checkbox beside its icon: a stray white square in a dark theme
// (seen in real VS Code, 2026-10-18). Without its word it is an icon button like its neighbours, lit when on.
test("narrow, Temporary is an icon button: no bare checkbox, Space and a click still toggle it, and it lights when on", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 460, height: 700 });
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    const look = () => s.page.evaluate(() => {
      const label = document.getElementById("cd-temp-toggle"), box = document.getElementById("cd-temporary");
      const r = label.getBoundingClientRect(), icon = label.querySelector(".cd-toggle-icon"), cs = getComputedStyle;
      return { boxShown: cs(box).opacity !== "0", checked: box.checked, size: [Math.round(r.width), Math.round(r.height)],
               icon: cs(icon).display !== "none", colour: cs(label).color,
               accent: cs(document.body).getPropertyValue("--accent").trim(), attach: Math.round(document.getElementById("cd-attach").getBoundingClientRect().height) };
    });
    const before = await look();
    assert.equal(before.boxShown, false, "no bare checkbox drawn");
    assert.equal(before.icon, true, "its icon stands for it");
    assert.equal(before.size[1], before.attach, "as tall as its neighbours");
    assert.equal(before.checked, false);
    await s.page.locator("#cd-temp-toggle").click();
    const on = await look();
    assert.equal(on.checked, true, "a click turns it on");
    assert.notEqual(on.colour, before.colour, "and it lights");
    await s.page.locator("#cd-temporary").focus();
    await s.page.keyboard.press("Space");
    assert.equal((await look()).checked, false, "Space turns it off again");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("however narrow the editor, the prompt box keeps one row: the tools turn to icons, the meter, model, microphone and Send hold their places; recording, the voice bar takes the row", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, recording] of [1100, 640, 460, 340, 230].flatMap((w) => [[w, false], [w, true]])) {
    const s = await openScreen({ width, height: 700 });
    try {
      await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
      await s.send({ type: "models", ids: ["qwen3.6-35b-a3b-instruct-long-name:cloud"], current: "qwen3.6-35b-a3b-instruct-long-name:cloud" });
      await s.send({ type: "context", window: 32768, limit: 262144, used: 5200, preset: "32k", source: "reported", parts: { conversation: 5200 }, compactable: true });
      if (recording) {
        // Recording: the voice bar in the tools row's place -- Cancel, the waveform with the time, Stop, Send.
        await s.page.locator("#cd-mic").click();
        await s.send({ type: "mic", state: "recording" });
        await s.send({ type: "micLevels", levels: [0.1, 0.12, 0.09, 0.11] });
        await s.page.waitForTimeout(450);
        const bar = await s.page.evaluate(() => {
          const r = (n) => { const b = n.getBoundingClientRect(); return { l: b.left, r: b.right, t: b.top, b: b.bottom, w: b.width }; };
          const q = (sel) => document.querySelector(`#cd-voice ${sel}`);
          return { box: r(document.querySelector(".cd-box")), tools: getComputedStyle(document.querySelector(".cd-tools")).display,
                   cancel: r(q('[data-voice-action="cancel"]')), wave: r(q("canvas")), time: r(q("[data-voice-time]")), timeShown: q("[data-voice-time]").checkVisibility(),
                   stop: r(q('[data-voice-action="stop"]')), send: r(q('[data-voice-action="send"]')),
                   sideways: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth };
        });
        assert.equal(bar.tools, "none", `${width}px: the tools row gives way`);
        assert.ok(bar.cancel.l >= bar.box.l && bar.send.r <= bar.box.r + 1, `${width}px: the bar inside the box`);
        assert.ok(bar.cancel.r <= bar.wave.l && bar.wave.r <= bar.stop.l && bar.stop.r <= bar.send.l, `${width}px: Cancel, waveform, Stop, Send`);
        assert.ok(new Set([bar.cancel, bar.stop, bar.send].map((b) => Math.round((b.t + b.b) / 2))).size === 1, `${width}px: one row`);
        assert.ok(bar.wave.w >= bar.box.w * (width > 300 ? 0.4 : 0.2), `${width}px: the waveform gets the room (${bar.wave.w} of ${bar.box.w})`);
        if (bar.timeShown) assert.ok(bar.time.l >= bar.wave.r - 1 && bar.time.r <= bar.stop.l, `${width}px: the time between waveform and Stop`);
        assert.equal(bar.sideways, 0);
        if (process.env.DGC_SHOTS) await s.page.locator(".cd-box").screenshot({ path: join(process.env.DGC_SHOTS, `chatdgc-box-${width}-recording.png`) });
        assert.deepEqual(s.errors, []);
        continue;
      }
      await s.frame();
      // An empty box offers voice mode where Send is (as ChatGPT does); the row is measured with a word typed, so
      // Send shows, and voice mode must have sat in exactly that place.
      const voice = await s.page.evaluate(() => { const n = document.querySelector("#cd-voicemode"); if (!n || n.hidden || !n.offsetWidth) return null; const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; });
      assert.ok(voice, `${width}px: an empty box offers voice mode`);
      await s.page.locator("#cd-input").fill("Hi");
      await s.frame();
      const got = await s.page.evaluate(() => {
        const box = (sel) => { const n = document.querySelector(sel); if (!n || n.hidden || !n.offsetWidth) return null; const r = n.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
        const parts = ["#cd-attach", "#cd-research", "#cd-study", "#cd-temp-toggle", "#cd-context", "#cd-model-pill", "#cd-mic", "#cd-send"].map((sel) => [sel, box(sel)]).filter(([, b]) => b);
        const tools = document.querySelector(".cd-tools").getBoundingClientRect();
        const words = [...document.querySelectorAll(".cd-tools .cd-tool-label")].filter((n) => n.offsetWidth).length;
        // A part squeezed narrower than what it holds spills over its neighbour while its box looks in place.
        const spills = ["#cd-model-pill", "#cd-mic", "#cd-context"].filter((sel) => { const n = document.querySelector(sel); return n && n.offsetWidth && n.scrollWidth > n.clientWidth + 1; });
        return { parts, tools: { l: tools.left, r: tools.right }, words, spills, sideways: document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth };
      });
      const at = Object.fromEntries(got.parts);
      const mid = (b) => Math.round((b.t + b.b) / 2);
      const rows = new Set(got.parts.map(([, b]) => mid(b)));
      if (width > 300) assert.ok(Math.max(...rows) - Math.min(...rows) <= 2, `${width}px: one row, not wrapped (${[...rows]})`);
      else assert.ok(Math.abs(mid(at["#cd-send"]) - mid(at["#cd-model-pill"])) <= 2 && Math.abs(mid(at["#cd-send"]) - mid(at["#cd-context"])) <= 2
                     && mid(at["#cd-send"]) > mid(at["#cd-attach"]), `${width}px: too narrow for one row: the meter, model and Send together on the row below`);
      for (const [sel, b] of got.parts) assert.ok(b.l >= got.tools.l - 1 && b.r <= got.tools.r + 1, `${width}px: ${sel} inside the box`);
      assert.ok(at["#cd-send"].l > at["#cd-mic"].r && at["#cd-mic"].l > at["#cd-model-pill"].r && at["#cd-model-pill"].l > at["#cd-context"].r,
                `${width}px: meter, model, microphone, then Send`);
      assert.ok(at["#cd-send"].r >= got.tools.r - 2, `${width}px: Send ends the row`);
      assert.ok(["l", "r", "t", "b"].every((k) => Math.abs(voice[k] - at["#cd-send"][k]) <= 1), `${width}px: voice mode sat where Send is`);
      assert.equal(got.sideways, 0);
      assert.deepEqual(got.spills, [], `${width}px: nothing spills out of its place`);
      if (width >= 1100) assert.ok(got.words >= 2, "wide: Deep research and Study say their names");
      if (width <= 460) assert.equal(got.words, 0, `${width}px: icons only`);
      assert.equal(await s.page.locator("#cd-research").getAttribute("aria-label"), "Deep research", "an icon still has its name");
      if (process.env.DGC_SHOTS) await s.page.locator(".cd-box").screenshot({ path: join(process.env.DGC_SHOTS, `chatdgc-box-${width}.png`) });
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("dictation: the voice bar while it records; Stop writes it down at the caret, Send sends it, Esc cancels, and what went wrong is said", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 900 });
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    const mic = s.page.locator("#cd-mic"), bar = s.page.locator('#cd-voice [data-voicebar="chatdgc"]'), tools = s.page.locator(".cd-tools");
    assert.equal(await mic.getAttribute("aria-label"), "Dictate");
    assert.equal(await bar.isVisible(), false);
    await s.page.locator("#cd-input").fill("Plan a trip to Lisbon");
    await s.page.evaluate(() => document.getElementById("cd-input").setSelectionRange(11, 11));
    await mic.click();
    assert.equal((await s.posted("micStart")).length, 1);
    assert.equal(await bar.isVisible(), true, "the voice bar at once, starting");
    assert.equal(await tools.isVisible(), false);
    assert.equal(await bar.getAttribute("data-state"), "starting");
    await s.send({ type: "mic", state: "recording" });
    assert.equal(await bar.getAttribute("data-state"), "recording");
    for (let i = 0; i < 10; i++) { await s.send({ type: "micLevels", levels: [0.08 + (i % 3) * 0.03, 0.11] }); await s.page.waitForTimeout(100); }
    const tallest = await s.page.evaluate(() => {
      const c = document.querySelector("#cd-voice canvas"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let best = 0;
      for (let x = 0; x < c.width; x++) { let col = 0; for (let y = 0; y < c.height; y++) if (d[(y * c.width + x) * 4 + 3] > 40) col++; best = Math.max(best, col); }
      return best / c.height;
    });
    assert.ok(tallest > 0.5, `the waveform moves with the voice: ${tallest}`);
    assert.match(await bar.locator("[data-voice-time]").textContent(), /^0:0[01]$/);

    // Stop: what was said goes in at the caret, spaced; the tools come back.
    await bar.locator('[data-voice-action="stop"]').click();
    assert.deepEqual((await s.posted("micStop")).at(-1), { type: "micStop", mode: "insert" });
    assert.equal(await bar.getAttribute("data-state"), "writing");
    assert.equal(await bar.locator("[data-voice-status]").textContent(), "Writing it down…");
    await s.send({ type: "mic", state: "idle", text: "for two people", mode: "insert" });
    assert.equal(await s.page.locator("#cd-input").inputValue(), "Plan a trip for two people to Lisbon");
    assert.equal(await s.page.evaluate(() => document.getElementById("cd-input").selectionStart), "Plan a trip for two people".length, "the caret after what was said");
    assert.equal(await tools.isVisible(), true);
    assert.equal(await bar.isVisible(), false);

    // Send: the words go in, and the message goes.
    await s.page.evaluate(() => { const i = document.getElementById("cd-input"); i.setSelectionRange(i.value.length, i.value.length); });
    await mic.click();
    await s.send({ type: "mic", state: "recording" });
    await bar.locator('[data-voice-action="send"]').click();
    assert.deepEqual((await s.posted("micStop")).at(-1), { type: "micStop", mode: "send" });
    await s.send({ type: "mic", state: "idle", text: "Book the hotel too.", mode: "send" });
    assert.equal((await s.posted("send")).at(-1)?.text, "Plan a trip for two people to Lisbon Book the hotel too.");
    assert.equal((await s.posted("send")).at(-1)?.voice, undefined, "dictated into the box and sent: a typed message, read on screen");

    // Esc cancels: from the box, or anywhere on the page.
    await mic.click();
    await s.send({ type: "mic", state: "recording" });
    await s.page.locator("#cd-input").press("Escape");
    assert.equal((await s.posted("micCancel")).length, 1);
    assert.equal(await tools.isVisible(), true);
    assert.equal((await s.posted("stop")).length, 0, "Esc cancelled the recording, not a reply");
    await mic.click();
    await s.send({ type: "mic", state: "recording" });
    await s.page.locator("#cd-title").click();
    await s.page.keyboard.press("Escape");
    assert.equal((await s.posted("micCancel")).length, 2);
    await mic.click();
    await bar.locator('[data-voice-action="cancel"]').click();
    assert.equal((await s.posted("micCancel")).length, 3, "Cancel while it's still starting");

    // No model yet: the host opened Settings -> Voice; the page says why, as information. Nothing heard, too.
    await mic.click();
    await s.send({ type: "mic", state: "idle", error: "Choose a dictation model in Settings → Voice, then press the microphone again.", kind: "info" });
    assert.equal(await s.page.locator("#cd-notice").textContent(), "Choose a dictation model in Settings → Voice, then press the microphone again.");
    assert.equal(await s.page.locator("#cd-notice").getAttribute("data-kind"), "info");
    assert.equal(await tools.isVisible(), true);
    await mic.click();
    assert.equal(await s.page.locator("#cd-notice").isHidden(), true, "a new press clears the old word");
    await s.send({ type: "mic", state: "recording" });
    await bar.locator('[data-voice-action="stop"]').click();
    await s.send({ type: "mic", state: "idle", text: "" });
    assert.match(await s.page.locator("#cd-notice").textContent(), /Nothing was heard/);
    await s.send({ type: "mic", state: "idle", error: "Another chat is recording: stop it there first." });
    assert.equal(await s.page.locator("#cd-notice").getAttribute("data-kind"), "error");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("read aloud: a speaker under each reply asks for that reply's words; it shows Stop while it reads", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 900 });
  try {
    await s.send({ type: "opened", conversation: conversation({ title: "Lisbon" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Plan Lisbon" },
      { id: M(2), role: "assistant", text: "## Two days\n\nBelém, then the **beach**.", model: "qwen3:32b" }] });
    const speaker = s.page.locator(`[data-read-aloud="${M(2)}"]`);
    assert.equal(await speaker.count(), 1, "one speaker, under the reply");
    assert.equal(await s.page.locator(`.cd-user [data-read-aloud]`).count(), 0, "not under your own message");
    await speaker.click();
    assert.deepEqual((await s.posted("speakStart")).at(-1), { type: "speakStart", id: M(2), text: "## Two days\n\nBelém, then the **beach**." });
    await s.send({ type: "speak", id: M(2), state: "loading" });
    assert.equal(await speaker.getAttribute("data-reading"), "loading");
    assert.equal(await speaker.getAttribute("aria-label"), "Stop reading");
    // The reply redrawn (a version stepped, an edit elsewhere): the new speaker still shows it's reading.
    await s.send({ type: "message", conversation_id: ID, message: { id: M(2), role: "assistant", text: "## Two days\n\nBelém, then the **beach**.", model: "qwen3:32b" } });
    assert.equal(await s.page.locator(`[data-read-aloud="${M(2)}"]`).getAttribute("data-reading"), "loading");
    await s.page.locator(`[data-read-aloud="${M(2)}"]`).click();
    assert.deepEqual((await s.posted("speakStop")).at(-1), { type: "speakStop" });
    await s.page.locator(`[data-read-aloud="${M(2)}"]`).click();
    await s.send({ type: "speak", id: M(2), state: "idle", kind: "info", error: "Choose a voice for reading aloud in Settings → Voice, then press Read aloud again." });
    assert.match(await s.page.locator("#cd-notice").textContent(), /Choose a voice for reading aloud/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("each message says when it was sent or written, and the time stays while your message's buttons wait for the pointer", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 700 });
  try {
    const sent = "2026-10-17T09:12:00.000Z", written = "2026-10-17T09:12:41.000Z";
    await s.send({ type: "opened", conversation: conversation({ title: "Lisbon" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Plan Lisbon", created_at: sent },
      { id: M(2), role: "assistant", text: "Belém first.", model: "qwen3:32b", created_at: written }] });
    await s.page.mouse.move(0, 0);
    const look = (selector) => s.page.evaluate((sel) => {
      const n = document.querySelector(sel);
      if (!n) return null;
      const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
      return { text: n.textContent, when: n.getAttribute("datetime"), title: n.title, opacity: opacity(n),
               first: n === n.parentElement.firstElementChild, last: n === n.parentElement.lastElementChild,
               buttons: Math.max(0, ...[...n.parentElement.querySelectorAll("button")].map(opacity)) };
    }, selector);
    const mine = await look(".cd-user .cd-actions > time.cd-time"), reply = await look(".cd-assistant .cd-actions > time.cd-time");
    assert.equal(mine.when, sent);
    assert.equal(reply.when, written);
    assert.ok(mine.last && reply.first, "at the message's own edge: after your buttons, before the reply's");
    assert.ok(mine.title.includes("2026") && reply.title.includes("2026"), "the whole date is the tooltip");
    assert.equal(mine.opacity, 1, "your message's time shows without the pointer");
    assert.equal(mine.buttons, 0, "its buttons still wait for it");
    await s.page.locator(".cd-user .cd-bubble").hover();
    assert.equal((await look(".cd-user .cd-actions > time.cd-time")).buttons, 1, "pointed at, the buttons come back");
    await s.send({ type: "message", conversation_id: ID, message: { id: M(3), role: "user", text: "no time" } });
    assert.equal(await s.page.locator(`[data-id="${M(3)}"] time`).count(), 0, "no saved time, no time");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("voice mode: in place of Send while the box is empty; it listens, ends your turn when you stop, sends it, speaks the reply, and listens again", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 900 });
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    const talk = s.page.locator("#cd-voicemode"), sendBtn = s.page.locator("#cd-send");
    assert.equal(await talk.isVisible(), true, "the empty box offers voice mode");
    assert.equal(await sendBtn.isVisible(), false);
    await s.page.locator("#cd-input").fill("typed");
    assert.equal(await talk.isVisible(), false, "a word typed, and it's Send again");
    assert.equal(await sendBtn.isVisible(), true);
    await s.page.locator("#cd-input").fill("");

    await talk.click();
    assert.equal((await s.posted("voiceCheck")).length, 1, "first: is there a model to listen with and a voice to answer in?");
    const bar = s.page.locator('#cd-voice [data-voicebar="chatdgc-talk"]');
    assert.equal(await bar.isVisible(), true);
    assert.equal(await s.page.locator(".cd-tools").isVisible(), false);
    await s.send({ type: "voiceReady", dictation: true, readAloud: true });
    assert.equal((await s.posted("micStart")).length, 1, "then it listens");
    await s.send({ type: "mic", state: "recording" });
    assert.equal(await bar.getAttribute("data-state"), "listening");
    assert.equal(await bar.locator("[data-voice-phase]").textContent(), "Listening");
    // The room, then speech, then quiet: the turn ends by itself.
    for (const v of [...Array(5).fill(0.002), ...Array(10).fill(0.09), ...Array(16).fill(0.002)]) {
      await s.send({ type: "micLevels", levels: [v, v] });
      await s.page.waitForTimeout(100);
      if ((await s.posted("micStop")).length) break;
    }
    assert.deepEqual((await s.posted("micStop")).at(-1), { type: "micStop", mode: "send" }, "a moment of quiet after speech ends the turn");
    assert.equal(await bar.getAttribute("data-state"), "writing");
    await s.send({ type: "mic", state: "writing", mode: "send" });
    await s.send({ type: "mic", state: "idle", text: "What should I cook tonight?", mode: "send" });
    assert.equal((await s.posted("send")).at(-1)?.text, "What should I cook tonight?", "what was said is sent");
    assert.equal((await s.posted("send")).at(-1)?.voice, true, "as spoken: its reply is asked to sound like speech");
    assert.equal(await bar.getAttribute("data-state"), "thinking");
    assert.equal(await bar.locator("[data-voice-status]").textContent(), "Thinking…");

    // The reply comes, finishes, and is read aloud.
    await s.send({ type: "turn", state: "started", replyId: M(8) });
    await s.send({ type: "message", conversation_id: ID, message: { id: M(7), role: "user", text: "What should I cook tonight?" } });
    await s.send({ type: "message", conversation_id: ID, message: { id: M(8), role: "assistant", text: "Try a **spinach** dal." } });
    assert.equal((await s.posted("speakStart")).length, 0, "not while the reply is still coming");
    await s.send({ type: "turn", state: "finished", replyId: M(8) });
    assert.deepEqual((await s.posted("speakStart")).at(-1), { type: "speakStart", id: M(8), text: "Try a **spinach** dal." });
    assert.equal(await bar.getAttribute("data-state"), "speaking");
    assert.equal(await bar.locator("[data-voice-phase]").textContent(), "Speaking");
    assert.equal(await bar.locator('[data-voice-action="turn"]').getAttribute("aria-label"), "Stop speaking");
    const tone = (sec) => { const n = Math.round(24000 * sec), b = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 10) * 9000), i * 2); return b.toString("base64"); };
    await s.send({ type: "speak", id: M(8), state: "loading" });
    await s.send({ type: "speakAudio", id: M(8), part: 0, audio: tone(0.6), rate: 24000, done: false });
    await s.send({ type: "speakAudio", id: M(8), part: 1, audio: "", rate: 0, done: true });
    await s.page.waitForFunction(() => window.__posted.filter((m) => m.type === "micStart").length === 2, null, { timeout: 4000 });
    assert.equal(await bar.getAttribute("data-state"), "starting", "the reply read, it listens again");

    // Stop cuts the reply short and listens; End ends it all.
    await s.send({ type: "mic", state: "recording" });
    for (const v of [...Array(5).fill(0.002), ...Array(8).fill(0.09), ...Array(16).fill(0.002)]) {
      await s.send({ type: "micLevels", levels: [v, v] }); await s.page.waitForTimeout(100);
      if ((await s.posted("micStop")).length === 2) break;
    }
    await s.send({ type: "mic", state: "idle", text: "And dessert?", mode: "send" });
    await s.send({ type: "turn", state: "started", replyId: M(9) });
    await s.send({ type: "message", conversation_id: ID, message: { id: M(9), role: "assistant", text: "Kheer, slowly." } });
    await s.send({ type: "turn", state: "finished", replyId: M(9) });
    await s.send({ type: "speakAudio", id: M(9), part: 0, audio: tone(3), rate: 24000, done: false });
    await bar.locator('[data-voice-action="turn"]').click();
    assert.deepEqual((await s.posted("speakStop")).at(-1), { type: "speakStop" });
    assert.equal((await s.posted("micStart")).length, 3, "cut short: your turn");
    await s.send({ type: "mic", state: "recording" });
    await bar.locator('[data-voice-action="end"]').click();
    assert.equal((await s.posted("micCancel")).length, 1);
    assert.equal(await s.page.locator(".cd-tools").isVisible(), true, "the box is back");
    assert.equal(await talk.isVisible(), true);

    // Without a voice to answer in, it says so and doesn't start.
    await talk.click();
    await s.send({ type: "voiceReady", dictation: true, readAloud: false, message: "Voice mode needs a voice for reading aloud: choose one in Settings → Voice, then start voice mode again." });
    assert.match(await s.page.locator("#cd-notice").textContent(), /needs a voice for reading aloud/);
    assert.equal(await s.page.locator(".cd-tools").isVisible(), true);
    assert.equal((await s.posted("micStart")).length, 3, "nothing recorded");
    // Esc ends it too.
    await talk.click();
    await s.send({ type: "voiceReady", dictation: true, readAloud: true });
    await s.send({ type: "mic", state: "recording" });
    await s.page.keyboard.press("Escape");
    assert.equal((await s.posted("micCancel")).length, 2);
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
    assert.equal(await s.page.locator(".cd-assistant details.cd-thinking").getAttribute("open"), null, "its thinking is there, collapsed");
    assert.match(await s.page.locator(".cd-thinking-label").textContent(), /^Thinking$/);
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
    assert.equal(await shown(s.page, "#cd-send"), false, "the box is empty: voice mode is offered where Send is");
    assert.equal(await shown(s.page, "#cd-voicemode"), true);
    await s.page.locator("#cd-input").fill("And Rome?");
    assert.equal(await shown(s.page, "#cd-send"), true, "a word typed, and it's Send again");
    assert.equal(await shown(s.page, "#cd-voicemode"), false);
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

test("the home shows Chat | Work at once when ChatDGC was here last time; a CLI without it takes them away", async (t) => {
  if (skipOrFail(t)) return;
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } });
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.evaluate(([mjs, mdjs]) => {
      document.documentElement.dataset.chatPlace = "home";
      document.documentElement.dataset.chatdgcSeen = "1";
      window.__posted = []; window.__state = undefined;
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state,
                                         setState(s) { window.__state = s; } });
      window.DgcPips = { mount: () => ({ setVisible() {}, navigate() {} }) };
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
    }, [mainJs, markdownJs]);
    const send = (d) => page.evaluate((x) => window.dispatchEvent(new MessageEvent("message", { data: x })), d);
    await send({ type: "sessions_list", items: [{ id: "20261006-101500-a1", name: "Fix login", when: "2026-10-06 10:15", count: 4 }], searchable: true });
    assert.deepEqual([await shown(page, "#home-tabs"), await shown(page, "#chats-home"), await shown(page, "#work-home")], [true, true, false],
                     "the tabs, before the backend has said anything");
    assert.equal(await page.locator("#chats-status").textContent(), "Loading your chats…");
    assert.equal(await page.locator("#sessions-title").textContent(), "Work");
    assert.equal(await page.locator("#sessions-search").getAttribute("placeholder"), "Search chats and sessions");
    await send({ type: "chatdgc_list", available: true, total: 0, items: [] });
    assert.match(await page.locator("#chats-status").textContent(), /^No chats yet/, "its answer replaces the wait");
    await send({ type: "chatdgc_list", available: false });
    assert.deepEqual([await shown(page, "#home-tabs"), await shown(page, "#chats-home"), await shown(page, "#sessions-list")], [false, false, true],
                     "a CLI with no ChatDGC: the sessions, as before");
    assert.equal(await page.locator("#sessions-title").textContent(), "Sessions");
  } finally { await page.close(); }
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

test("a reply that searches: what it looks for while it looks, its words with no source chips, and its sources at the end", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    // Web search is always there, and the box has no switch for it (founder, 2026-10-18: "it anyway uses web, so
    // let's not confuse users"): the model looks things up when an answer depends on it. Settings turns it off.
    assert.equal(await s.page.locator("#cd-search, #cd-websearch, .cd-tools .codicon-globe").count(), 0, "no web switch in the box");
    assert.deepEqual(await s.page.locator(".cd-tools .cd-tool").evaluateAll((tools) => tools.map((b) => b.getAttribute("aria-label"))),
                     ["Deep research", "Study"], "Deep research and Study stay");
    await s.page.locator("#cd-input").fill("Weather in Paris?");
    await s.page.keyboard.press("Enter");
    assert.equal((await s.posted("send"))[0].search, "auto", "the model's call, every message");
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
    // Sources only at the end (founder, 2026-10-18): no chip in the words, and the marks taken out cleanly. [2][3][9] is
    // one group naming sources the reply has, so all of it goes; in code, [1] is code.
    assert.equal(await s.page.locator(".cd-body button:not(.copy), .cd-body .cd-fav, [class*='cd-cite']").count(), 0, "nothing but words in the reply (and its code block's Copy)");
    assert.equal(await s.page.locator(".cd-body p").first().textContent(), "Sunny and 21°C, dry week.");
    assert.equal(await s.page.locator("pre.code code").textContent(), "list[1]\n", "code is code");
    const button = s.page.locator(".cd-sources-button");
    assert.equal(await button.locator(".cd-fav .codicon-globe").count(), 3, "favicons off: a globe, and nothing is asked");
    await s.send({ type: "favicons", on: true });
    await s.frame();
    assert.match(await button.locator(".cd-fav img").first().getAttribute("src"),
                 /^https:\/\/www\.google\.com\/s2\/favicons\?domain=https%3A%2F%2Fwww\.weather\.example&sz=32$/, "the origin only, never the page");
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

// "In ChatDGC, the mid-response source chips — let's not have them there; only show sources at the end" (founder,
// 2026-10-18). The marks the model cites with stay in the reply as kept (its Sources say which were cited) and are
// taken out of what's read and copied, with the space before them; a reply's own brackets stay.
test("sources only at the end: no chips in a reply, its citation marks out cleanly (spacing, punctuation), kept in code and where they name no source, and out of Copy", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const sources = [{ n: 1, title: "2026 Italian Grand Prix report", url: "https://www.formula1.com/en/latest/italy", snippet: "Antonelli won from Russell." },
                     { n: 2, title: "F1 results", url: "https://www.espn.com/f1/results" }, { n: 3, title: "Rates", url: "https://rbi.example/rates" }];
    const text = "Kimi Antonelli won the Italian Grand Prix [1] [2].\n\n[1] At the start, and **bold**[2] next, then a list:\n\n"
      + "- Rates rose 0.5% [3], then fell [1, 2]\n- In `arr[1]` code, array[0] stays and so does [7].\n\n| City | Temp |\n|---|---|\n| Paris [1] | 21°C [2] |\n\n"
      + "Antonelli[1]won; Russell was second [2][9]!";
    // A chat opened again: its replies come as kept, marks and all.
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Who won the most recent Grand Prix?" },
      { id: M(2), role: "assistant", text, finish: "stop", sources, searches: ["latest grand prix winner"] },
      { id: M(3), role: "user", text: "And without the web?" },
      { id: M(4), role: "assistant", text: "See note [1] below: no sources, so the brackets are the reply's own.", finish: "stop" }] });
    await s.frame();
    const reply = s.page.locator(".cd-assistant").first();
    assert.equal(await s.page.locator(".cd-body button:not(.copy), .cd-body .cd-fav, [class*='cd-cite']").count(), 0, "no chip, pill or card anywhere in the words");
    assert.deepEqual(await reply.locator(".cd-body > p").allTextContents(),
                     ["Kimi Antonelli won the Italian Grand Prix.", "At the start, and bold next, then a list:", "Antonelli won; Russell was second!"]);
    assert.deepEqual(await reply.locator(".cd-body li").allTextContents(), ["Rates rose 0.5%, then fell", "In arr[1] code, array[0] stays and so does [7]."],
                     "a group naming its sources goes; code, array[0] and a number naming none stay");
    assert.deepEqual(await reply.locator(".cd-body td").allTextContents(), ["Paris", "21°C"]);
    assert.equal(await reply.locator(".cd-body code").first().textContent(), "arr[1]");
    assert.equal(await s.page.locator(".cd-assistant").last().locator(".cd-body p").textContent(), "See note [1] below: no sources, so the brackets are the reply's own.");
    // Its sources, at the end, as they were.
    const button = reply.locator(".cd-sources-button");
    assert.equal(await button.innerText(), "Sources · 3");
    await button.click();
    assert.deepEqual(await s.page.locator("#cd-sources-panel .cd-sources-heading").allTextContents(), ["Cited · 3"], "the marks still say which were cited");
    await s.page.keyboard.press("Escape");
    // Copy: the words as they read.
    await reply.locator('.cd-actions [aria-label="Copy"]').click();
    const copied = (await s.posted("copy")).at(-1).text;
    assert.doesNotMatch(copied.replace("arr[1]", "").replace("array[0]", "").replace("[7]", ""), /\[\d/, `no marks copied: ${copied}`);
    assert.match(copied, /^Kimi Antonelli won the Italian Grand Prix\.\n\nAt the start, and bold next, then a list:\n\n- Rates rose 0\.5%, then fell\n/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a deep research report reads without its citation marks, on the chat, in its reader and in its Copy; its sources are at its end", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const plan = { title: "Rates", steps: ["Find the rate"], sites: [] };
    const report = "# Rates\n\n## Today\n\nThe repo rate is 6.5% [1]. It held in October [1][2].\n\n```\nrate[1] = 6.5\n```";
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "The RBI rate", research: true },
      { id: M(2), role: "assistant", text: report, finish: "stop", sources: [{ n: 1, title: "RBI", url: "https://rbi.example" }, { n: 2, title: "News", url: "https://news.example" }],
        research: { status: "done", plan, round: 1, read: ["a"], notes: [{ n: 1, title: "RBI", url: "u", note: "x" }], activity: [], check: { checked: 2, supported: 2 } } }] });
    await s.frame();
    assert.deepEqual(await s.page.locator(".cd-assistant .cd-body p").allTextContents(), ["The repo rate is 6.5%. It held in October."]);
    assert.equal(await s.page.locator(".cd-assistant .cd-sources-button").innerText(), "Sources · 2");
    await s.page.locator(".cd-assistant").getByRole("button", { name: "Open report" }).click();
    assert.deepEqual(await s.page.locator("#cd-reader .cd-reader-text p").allTextContents(), ["The repo rate is 6.5%. It held in October."]);
    assert.equal(await s.page.locator("#cd-reader .cd-reader-sources .cd-source").count(), 2, "the reader's sources, at its side");
    await s.page.keyboard.press("Escape");
    await s.page.locator('.cd-assistant .cd-actions [aria-label="Copy"]').click();
    assert.equal((await s.posted("copy")).at(-1).text, "# Rates\n\n## Today\n\nThe repo rate is 6.5%. It held in October.\n\n```\nrate[1] = 6.5\n```",
                 "the report's Markdown, its code as written");
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

test("the Library's widgets: a tab of their own once the backend keeps them, each to open beside you, see its chat, or delete", async (t) => {
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
    await send({ type: "library", files: [], total: 0, next: null, counts: {} });
    assert.equal(await page.locator("#lib-views").isHidden(), true, "not before the backend says it keeps them");
    await send({ type: "widgetsOffered", on: true });
    assert.deepEqual(await page.locator(".lib-view").allTextContents(), ["Files", "Widgets"]);
    // Opened from a chat's Widgets list ("Open the Library"): on its Widgets tab.
    await send({ type: "view", view: "widgets" });
    assert.equal(await page.locator(".lib-view", { hasText: "Widgets" }).getAttribute("aria-selected"), "true");
    assert.deepEqual((await posted("widgets")).at(-1), { type: "widgets", query: "", offset: 0 });
    await page.locator(".lib-view", { hasText: "Files" }).click();
    await page.locator(".lib-view", { hasText: "Widgets" }).click();
    assert.deepEqual((await posted("widgets")).at(-1), { type: "widgets", query: "", offset: 0 });
    assert.equal(await page.evaluate(() => window.__state?.view), "widgets", "remembered");
    assert.equal(await page.locator("#lib-search").getAttribute("placeholder"), "Search widgets");
    assert.equal(await page.locator("#lib-kinds").isHidden(), true);
    assert.match(await page.locator("#lib-about").textContent(), /^Every calculator, timer or quiz ChatDGC made for you/);
    const w = { chat_id: `chat_${"a".repeat(32)}`, id: `wg_${"1".repeat(16)}`, message_id: M(2), title: "EMI <b>calculator</b>",
                created_at: new Date().toISOString(), chat_title: "Home loan" };
    await send({ type: "widgets", widgets: [w], total: 1, next: null });
    assert.deepEqual(await page.locator(".lib-name").allTextContents(), ["EMI <b>calculator</b>"], "a name is words");
    assert.equal(await page.locator(".lib-meta").textContent(), "Interactive · in “Home loan” · Today");
    if (process.env.DGC_SHOTS) await page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-library-widgets.png") });
    for (const label of ["Open it beside you", "Open the chat it's in", "Delete the widget"]) await page.locator(`button[aria-label="${label}"]`).click();
    assert.deepEqual((await page.evaluate(() => window.__posted.filter((m) => m.widget))).map((m) => [m.type, m.widget.id]),
                     [["widgetOpen", w.id], ["widgetChat", w.id], ["widgetRemove", w.id]]);
    await page.locator("#lib-search").fill("tip");
    await page.waitForTimeout(400);
    assert.deepEqual((await posted("widgets")).at(-1), { type: "widgets", query: "tip", offset: 0 });
    await send({ type: "widgets", widgets: [], total: 0, next: null });
    assert.equal(await page.locator("#lib-status").textContent(), "No widget named like “tip”.");
    // A backend that no longer keeps them: back to the files.
    await send({ type: "widgetsOffered", on: false });
    assert.equal(await page.locator("#lib-views").isHidden(), true);
    assert.deepEqual((await posted("list")).at(-1), { type: "list", query: "", kind: "", offset: 0 });
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
      "Focus the message box", "Stop the reply", "The prompt before", "The next prompt", "Show these shortcuts"]);
    assert.match(await s.page.locator("#cd-keys dt").first().innerText(), /Ctrl\s+Shift\s+O/);
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.locator("#cd-keys").evaluate((d) => d.open), false);
    await s.page.locator("#cd-keys-open").click();
    assert.equal(await s.page.locator("#cd-keys").evaluate((d) => d.open), true, "and from its button");
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-keys.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the thinking menu keeps its height at every level, though some levels' words take two lines", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [900, 420]) {
    const s = await openScreen({ width });
    try {
      await s.send({ type: "opened", conversation: conversation({ thinking: "off" }), earlier: 0, busy: false, messages: [] });
      await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "qwen3:32b"], current: "deepseek-v4.1-flash:cloud" });
      await s.frame();
      await s.page.locator("#cd-model-pill").click();
      const menu = s.page.locator("#cd-model-menu");
      await menu.locator(".cd-dial-face").focus();
      await s.page.keyboard.press("Home");
      const seen = [];
      for (let level = 0; level < 5; level++) {
        if (level) await s.page.keyboard.press("ArrowUp");
        await s.frame();
        const box = await menu.boundingBox(), lines = await menu.locator(".cd-dial-desc").evaluate((n) => Math.round(n.scrollHeight / parseFloat(getComputedStyle(n).lineHeight)));
        seen.push([await menu.locator(".cd-dial-level").textContent(), Math.round(box.height), Math.round(box.y), lines]);
      }
      assert.equal(new Set(seen.map(([, h]) => h)).size, 1, `${width}px: one height for every level: ${JSON.stringify(seen)}`);
      assert.equal(new Set(seen.map(([, , y]) => y)).size, 1, `${width}px: and the menu's top never moves`);
      if (width === 420) assert.ok(seen.some(([, , , lines]) => lines === 2), "at this width a description does wrap: the case this guards");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});

test("the box as main DGC's: no accent ring, one pill for the model and a dial for thinking, the window's size in the meter", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "windows", presets: ["8k", "16k", "32k", "64k", "128k", "256k", "512k", "1m", "max"] });
    await s.send({ type: "opened", conversation: conversation({ thinking: "medium" }), earlier: 0, busy: false,
      messages: [{ id: M(1), role: "user", text: "hi" }, { id: M(2), role: "assistant", text: "Hello.", finish: "stop" }] });
    await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "qwen3:32b"], current: "deepseek-v4.1-flash:cloud" });
    await s.page.locator("#cd-input").focus();
    const ring = await s.page.evaluate(() => {
      const box = getComputedStyle(document.getElementById("cd-box")), probe = document.createElement("div");
      probe.style.color = "var(--border-strong)"; document.body.append(probe);
      const strong = getComputedStyle(probe).color; probe.remove();
      return [box.borderTopColor, strong];
    });
    assert.equal(ring[0], ring[1], "focused, the box keeps its quiet border");
    assert.equal(await s.page.locator("select:visible").count(), 0, "no dropdowns: the pill");
    const pill = s.page.locator("#cd-model-pill");
    assert.equal(await pill.locator("#cd-model-name").textContent(), "deepseek-v4.1-flash:cloud");
    assert.equal(await pill.getAttribute("data-level"), "medium", "the chat's thinking");
    assert.match(await pill.getAttribute("aria-label"), /^Model deepseek-v4\.1-flash:cloud, thinking Medium\./);
    await pill.click();
    const menu = s.page.locator("#cd-model-menu");
    assert.equal(await menu.isVisible(), true);
    assert.equal(await pill.getAttribute("aria-expanded"), "true");
    assert.deepEqual(await menu.locator(".cd-menu-row").allInnerTexts(), ["deepseek-v4.1-flash:cloud", "qwen3:32b"]);
    assert.equal(await menu.locator(".cd-menu-row.sel").getAttribute("aria-checked"), "true");
    const dial = menu.locator(".cd-dial-face");
    assert.deepEqual([await dial.getAttribute("role"), await dial.getAttribute("aria-valuenow"), await menu.locator(".cd-dial-level").textContent(),
                      await menu.locator(".cd-dial-desc").textContent()], ["slider", "2", "Medium", "Thinks it through"]);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-composer-dial.png") });
    // A click on a mark: that level.
    const end = await dial.locator('.cd-dial-hit[data-level="4"]').boundingBox();
    await s.page.mouse.click(end.x + end.width / 2, end.y + end.height / 2);
    assert.equal(await s.page.locator("#cd-thinking").inputValue(), "xhigh");
    assert.equal(await menu.locator(".cd-dial-level").textContent(), "Extra high");
    assert.equal(await pill.getAttribute("data-level"), "xhigh", "the pill's arc follows");
    // A drag across it: the nearest mark as it goes.
    const off = await dial.locator('.cd-dial-hit[data-level="0"]').boundingBox(), mid = await dial.locator('.cd-dial-hit[data-level="2"]').boundingBox();
    await s.page.mouse.move(off.x + off.width / 2, off.y + off.height / 2);
    await s.page.mouse.down();
    assert.equal(await s.page.locator("#cd-thinking").inputValue(), "off");
    await s.page.mouse.move(mid.x + mid.width / 2, mid.y + mid.height / 2, { steps: 4 });
    await s.page.mouse.up();
    assert.equal(await s.page.locator("#cd-thinking").inputValue(), "medium");
    // Keys: step, ends.
    await dial.focus();
    await s.page.keyboard.press("End");
    assert.equal(await dial.getAttribute("aria-valuetext"), "Extra high: Thinks longest: slowest, most careful");
    await s.page.keyboard.press("Home");
    await s.page.keyboard.press("ArrowUp");
    assert.equal(await s.page.locator("#cd-thinking").inputValue(), "low");
    await menu.locator(".cd-menu-row", { hasText: "qwen3:32b" }).click();
    assert.equal(await s.page.locator("#cd-model").inputValue(), "qwen3:32b");
    assert.equal(await pill.locator("#cd-model-name").textContent(), "qwen3:32b");
    assert.equal(await menu.isVisible(), true, "still open, for thinking next");
    await s.page.keyboard.press("Escape");
    assert.equal(await menu.isHidden(), true);
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "cd-model-pill", "back on the pill");
    await pill.click();
    await s.page.locator("#cd-log").click({ position: { x: 5, y: 5 } });
    assert.equal(await menu.isHidden(), true, "a click elsewhere closes it");
    // A provider listing dozens of models: they scroll in their own list; the dial stays in view and takes a real click.
    await s.send({ type: "models", ids: Array.from({ length: 22 }, (_, i) => `model-${String(i).padStart(2, "0")}:latest`), current: "model-17:latest" });
    await pill.click();
    const [menuBox, dialBox] = [await menu.boundingBox(), await menu.locator(".cd-dial-face").boundingBox()];
    assert.ok(dialBox.y >= menuBox.y && dialBox.y + dialBox.height <= menuBox.y + menuBox.height && dialBox.y >= 0, "the dial is in view");
    assert.equal(await menu.locator(".cd-menu-models").evaluate((n) => n.scrollHeight > n.clientHeight), true, "the models scroll");
    const chosen = await menu.locator(".cd-menu-row.sel").boundingBox(), list = await menu.locator(".cd-menu-models").boundingBox();
    assert.ok(chosen.y >= list.y && chosen.y + chosen.height <= list.y + list.height + 1, "the chosen model shown in its list");
    const high = await menu.locator('.cd-dial-hit[data-level="3"]').boundingBox();
    await s.page.mouse.click(high.x + high.width / 2, high.y + high.height / 2);
    assert.equal(await s.page.locator("#cd-thinking").inputValue(), "high");
    await s.page.keyboard.press("Escape");
    await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "qwen3:32b"], current: "qwen3:32b" });
    await pill.click(); await menu.locator(".cd-dial-face").focus(); await s.page.keyboard.press("Home"); await s.page.keyboard.press("ArrowUp");
    await s.page.keyboard.press("Escape");
    // The window's size, in the meter's details, as main DGC's.
    await s.send({ type: "context", window: 32768, limit: 262144, used: 5200, preset: "32k", source: "reported", parts: { conversation: 5200 }, compactable: true });
    await s.page.locator("#cd-context").click();
    const size = s.page.locator("#cd-window-size");
    assert.deepEqual(await size.locator("option").allTextContents(), ["8K", "16K", "32K", "64K", "128K", "256K", "512K", "1M", "Model's maximum"]);
    assert.equal(await size.inputValue(), "32k");
    assert.match(await s.page.locator("#cd-context-pop").innerText(), /For every chat\. This model can take up to 262,144\./);
    await size.selectOption("128k");
    assert.deepEqual((await s.posted("window")).at(-1), { type: "window", preset: "128k" });
    await s.page.locator("#cd-input").fill("Plan a trip");
    await s.page.keyboard.press("Enter");
    assert.deepEqual((await s.posted("send")).map((m) => [m.model, m.thinking]), [["qwen3:32b", "low"]], "the send reads what the pill chose");
    await s.page.locator("#cd-context").click();
    assert.equal(await s.page.locator("#cd-window-size").isDisabled(), true, "not while a reply is written");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the welcome: ChatDGC's mark and a line for the time of day, chosen once a chat; a temporary chat keeps nothing", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.page.evaluate(() => { const D = Date; window.Date = class extends D { constructor(...a) { super(...(a.length ? a : [2026, 9, 11, 23, 30])); } }; });
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    const line = await s.page.locator(".cd-welcome h2").textContent();
    assert.ok(["Up late? I'm here.", "Quiet hours. What are you thinking about?", "Night owl mode. Ask away."].includes(line), `a night line: ${line}`);
    assert.equal(await s.page.locator(".cd-welcome-mark .cd-welcome-slash").count(), 3);
    const node = await s.page.locator(".cd-welcome").elementHandle();
    for (let i = 0; i < 5; i++) await s.send({ type: "models", ids: ["a", "b"], current: "a" });
    assert.equal(await s.page.locator(".cd-welcome h2").textContent(), line, "the same line, however often it draws");
    assert.equal(await node.evaluate((n) => n.isConnected), true, "the same element: its drawing doesn't replay");
    await s.send({ type: "opened", conversation: conversation({ id: `chat_${"b".repeat(32)}`, temporary: true }), messages: [], earlier: 0, busy: false });
    assert.equal(await s.page.locator(".cd-welcome h2").textContent(), "Off the record. Nothing here is kept.");
    assert.equal(await s.page.getByText("What can I help with?").count(), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// The founder (2026-10-18): Work's tab opens on the three slashes, "DGC" and a "|" that move; ChatDGC's should too, with
// its own mark, the bubble with the slashes inside it, and those slashes moving as Work's do. Both pages side by side.
test("the header's wordmark moves as Work's does: the slashes in the bubble breathe in turn, the cursor blinks, in both themes; reduced motion stills them", async (t) => {
  if (skipOrFail(t)) return;
  async function openWork({ theme, reducedMotion }) {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 }, reducedMotion: reducedMotion ? "reduce" : "no-preference" });
    await page.setContent(panelHtml().html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
    await page.evaluate((th) => document.body.classList.add(th.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
    return page;
  }
  // A wordmark as the reader gets it: how each part moves, its size, colour and type, and where the parts sit.
  const wordmark = (page, scope) => page.evaluate((scope) => {
    const pm = document.querySelector(scope), cs = (n) => getComputedStyle(n), rect = (n) => n.getBoundingClientRect();
    const motion = (n) => { const s = cs(n); return `${s.animationName} ${s.animationDuration} ${s.animationTimingFunction} ${s.animationIterationCount} ${s.animationDelay}`; };
    const mark = pm.querySelector("svg.mk"), cur = pm.querySelector(".cur"), bubble = mark.querySelector(".mk-bubble");
    const slashes = [...mark.querySelectorAll("path")].filter((n) => n !== bubble);
    const range = document.createRange();
    range.selectNode([...pm.childNodes].find((n) => n.nodeType === 3));
    const word = range.getBoundingClientRect(), middle = (r) => r.top + r.height / 2;
    return {
      slashes: slashes.map(motion), cursor: motion(cur), bubble: bubble && motion(bubble),
      words: { text: pm.textContent, font: `${cs(pm).fontWeight} ${cs(pm).fontSize} ${cs(pm).fontFamily}`, spacing: cs(pm).letterSpacing, colour: cs(pm).color },
      colours: { slashes: [...new Set(slashes.map((n) => cs(n).fill))], cursor: cs(cur).backgroundColor, bubble: bubble && cs(bubble).stroke },
      caret: { width: rect(cur).width, height: rect(cur).height, gap: rect(cur).left - word.right },
      markGap: word.left - rect(mark).right, markSize: [rect(mark).width, rect(mark).height],
      level: Math.max(Math.abs(middle(rect(mark)) - middle(word)), Math.abs(middle(rect(cur)) - middle(word))),
      inset: rect(pm).left - rect(pm.parentElement).left,
    };
  }, scope);
  const opacities = (page, scope) => page.evaluate(async (scope) => {
    const slashes = [...document.querySelectorAll(`${scope} svg.mk path:not(.mk-bubble)`)], seen = slashes.map(() => new Set());
    // One whole breath (2.1s) and a little more: a slash is at full strength for over half of one.
    for (let i = 0; i < 24; i++) { slashes.forEach((n, k) => seen[k].add(Number(getComputedStyle(n).opacity).toFixed(2))); await new Promise((r) => setTimeout(r, 100)); }
    return seen.map((s) => s.size);
  }, scope);
  const shots = process.env.DGC_SHOTS || "";
  if (shots) mkdirSync(shots, { recursive: true });
  for (const theme of ["dark-modern", "light-modern"]) {
    const s = await openScreen({ theme }), work = await openWork({ theme });
    try {
      await s.send({ type: "opened", conversation: conversation({ title: "Trip to Goa" }), earlier: 0, busy: false,
        messages: [{ id: M(1), role: "user", text: "Plan three days in Goa" }, { id: M(2), role: "assistant", text: "Day 1: the beaches.", finish: "stop" }] });
      await s.frame();
      const chat = await wordmark(s.page, ".cd-head .pm"), ours = await wordmark(work, "#phead .pm");
      assert.deepEqual(ours.slashes, ["brand-slash-pulse 2.1s ease-in-out infinite 0s", "brand-slash-pulse 2.1s ease-in-out infinite 0.22s",
                                      "brand-slash-pulse 2.1s ease-in-out infinite 0.44s"], "Work's slashes (the reference)");
      assert.deepEqual(chat.slashes, ours.slashes, `${theme}: the bubble's slashes breathe in turn, as Work's do`);
      assert.match(chat.bubble, /^none /, "the bubble holds still");
      assert.match(ours.cursor, /^blink 1\.1s steps\(1(, end)?\) infinite 0s$/);
      assert.equal(chat.cursor, ours.cursor, "the cursor blinks as Work's does");
      assert.deepEqual(chat.words, { ...ours.words, text: "DGC" }, `${theme}: DGC, in Work's type and colour`);
      assert.equal(ours.words.text, "DGC");
      assert.deepEqual(chat.colours, { ...ours.colours, bubble: ours.colours.slashes[0] }, `${theme}: the bubble and its slashes in Work's mark colour`);
      assert.deepEqual(chat.caret, ours.caret, "a caret of Work's size, as far from the word");
      assert.equal(chat.markGap, ours.markGap, "as far from the word as Work's mark");
      assert.ok(chat.level < 0.75 && ours.level < 0.75, `the mark, the word and the caret on one line (${chat.level}, ${ours.level})`);
      assert.equal(chat.inset, ours.inset, "as far in from the header's edge");
      assert.deepEqual(ours.markSize, [14, 14]);
      assert.deepEqual(chat.markSize, ours.markSize, "the bubble at the size of Work's mark (the founder: the size and looks of Work's)");
      // The whole header is Work's, not only the wordmark: its height, padding, no rule below, the title's type and colour,
      // and the small faint buttons.
      const header = (page, head, title, button) => page.evaluate(([head, title, button]) => {
        const h = document.querySelector(head), t = document.querySelector(title), b = document.querySelector(button), cs = (n) => getComputedStyle(n);
        return { height: h.getBoundingClientRect().height, minHeight: cs(h).minHeight, padding: cs(h).padding, rule: cs(h).borderBottomWidth,
                 onItsPage: cs(h).backgroundColor === cs(document.body).backgroundColor, gap: cs(h).columnGap,
                 title: `${cs(t).fontWeight} ${cs(t).fontSize}/${cs(t).lineHeight} ${cs(t).fontFamily} ${cs(t).color}`,
                 button: { size: [b.getBoundingClientRect().width, b.getBoundingClientRect().height], colour: cs(b).color } };
      }, [head, title, button]);
      assert.deepEqual(await header(s.page, ".cd-head", "#cd-title", "#cd-new"), await header(work, "#phead", "#thread-title", "#chat-add"),
                       `${theme}: ChatDGC's header measures as Work's`);
      for (const sizes of await Promise.all([opacities(s.page, ".cd-head .pm"), opacities(work, "#phead .pm")])) {
        assert.ok(sizes.every((n) => n > 2), `each slash really fades in and out (${sizes})`);
      }
      if (shots) {
        await s.page.locator(".cd-head").screenshot({ path: join(shots, `chatdgc-header-${theme}.png`) });
        await work.locator("#phead").screenshot({ path: join(shots, `work-header-${theme}.png`) });
      }
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); await work.close(); }
  }
  // Reduced motion: Work's slashes and cursor stand still, and so do ChatDGC's.
  const s = await openScreen({ reducedMotion: true }), work = await openWork({ theme: "dark-modern", reducedMotion: true });
  try {
    const chat = await wordmark(s.page, ".cd-head .pm"), ours = await wordmark(work, "#phead .pm");
    for (const [name, mark] of [["Work", ours], ["ChatDGC", chat]]) {
      assert.ok(mark.slashes.every((m) => m.startsWith("none ")), `${name}: the slashes are still (${mark.slashes})`);
      assert.match(mark.cursor, /^none /, `${name}: the cursor is still`);
    }
    for (const sizes of await Promise.all([opacities(s.page, ".cd-head .pm"), opacities(work, "#phead .pm")])) {
      assert.deepEqual(sizes, [1, 1, 1], "and each slash keeps one opacity");
    }
    assert.deepEqual(await s.page.evaluate(() => [...document.querySelectorAll(".cd-head .pm .mk-slashes path")].map((n) => getComputedStyle(n).opacity)),
                     ["1", "1", "1"], "fully drawn, not caught mid-fade");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); await work.close(); }
});

test("what fills the window, in the meter's details: a bar a colour a part, each part's share, tools one by one", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [{ id: M(1), role: "user", text: "hi" }, { id: M(2), role: "assistant", text: "Hello.", finish: "stop" }], earlier: 0, busy: false });
    await s.send({ type: "context", window: 32768, limit: 262144, used: 9200, preset: "32k", source: "reported", parts: { conversation: 9200 }, compactable: true });
    await s.page.locator("#cd-context").click();
    assert.deepEqual((await s.posted("breakdown")).length, 1, "asked for as the details open");
    const pop = s.page.locator("#cd-context-pop");
    assert.equal(await pop.locator(".bd").count(), 0, "until it comes: the meter's own lines");
    const breakdown = { window: 32768, used: 9200, source: "reported", compact_at: 24576, buffer: 8192, free: 15376, categories: [
      { id: "messages", label: "Messages", tokens: 5200 },
      { id: "tools", label: "Tools", tokens: 3100, items: [{ name: "make_file", tokens: 900 }, { name: "<b>x</b>", tokens: 800 }] },
      { id: "system_prompt", label: "System prompt", tokens: 900 }] };
    await s.send({ type: "breakdown", conversation: `chat_${"f".repeat(32)}`, breakdown: { ...breakdown, used: 1 } });
    assert.equal(await pop.locator(".bd").count(), 0, "another chat's: not this one's");
    await s.send({ type: "breakdown", conversation: ID, breakdown });
    assert.equal(await pop.locator(".bd-seg").count(), 4, "three parts and the summarizing room");
    // Folded at first: the bar and what's free at a glance, the parts on a click.
    assert.equal(await pop.locator(".bd-details").evaluate((d) => d.open), false, "the parts are folded at first");
    assert.equal(await pop.locator(".bd-bar").isVisible(), true);
    assert.equal(await pop.locator(".bd-list").isVisible(), false);
    assert.deepEqual(await pop.locator(".bd-toggle > span").allTextContents(), ["Details", "15.4k free"]);
    if (process.env.DGC_SHOTS) await pop.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-context-folded.png") });
    await pop.locator(".bd-toggle").click();
    assert.equal(await pop.locator(".bd-list").isVisible(), true, "a click shows them");
    if (process.env.DGC_SHOTS) await pop.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-context-open.png") });
    assert.deepEqual(await pop.locator(".bd-list > .bd-row .bd-label, .bd-list > details .bd-label").allTextContents(),
                     ["Messages", "Tools2", "System prompt", "Kept free for summarizing", "Free space"]);
    assert.deepEqual(await pop.locator('.bd-row[data-id="messages"] .bd-num, .bd-row[data-id="messages"] .bd-share').allTextContents(), ["5.2k", "15.9%"]);
    assert.match(await pop.locator(".context-head").innerText(), /9,200 \/ 32,768\s*28%/);
    await pop.locator(".bd-more summary").click();
    assert.deepEqual(await pop.locator(".bd-item-name").allTextContents(), ["make_file", "<b>x</b>"], "names are words");
    assert.equal(await pop.locator(".bd-item b").count(), 0);
    assert.match(await pop.locator(".bd-bar").getAttribute("aria-label"), /^28\.1% of the context window used: Messages 5\.2k, Tools 3\.1k, System prompt 900$/);
    const drawn = await pop.locator(".bd").elementHandle();
    await s.send({ type: "context", window: 32768, limit: 262144, used: 9300, preset: "32k", source: "reported", parts: { conversation: 9300 }, compactable: true });
    assert.equal((await s.posted("breakdown")).length, 2, "asked again as the window changes, while it's open");
    assert.equal(await drawn.evaluate((n) => n.isConnected), false, "the details were drawn again");
    assert.equal(await pop.locator(".bd-list").isVisible(), true, "and what was opened stayed open: a meter redrawn as a reply streams never folds under the reader");
    assert.equal(await pop.locator(".bd-item-name").first().isVisible(), true, "the tools too");
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
    assert.match(await pop.innerText(), /CONTEXT WINDOW\s*30,000 \/ 32,768\s*92%/i, "laid out as main DGC's");
    assert.match(await pop.innerText(), /2,768 free\s*as the model counted them/);
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

test("a card of several questions, as ChatGPT asks them: numbered, the first answers chosen, one button sends them all", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const form = { at: 22, question: "Who should own it?", options: ["Only me", "Jointly"], prompt: "Build my plan.",
      submit: "Build my family remittance plan", questions: [
        { question: "Who should own it?", options: ["Only me", "Jointly"] },
        { question: "Which relatives could contribute?", options: ["Spouse and/or parents", "Brothers and/or sisters", "Adult children"] },
        { question: "Where in the UK is the property?", options: ["England, including London", "Scotland", "Wales"] }] };
    await s.send({ type: "opened", conversation: conversation({ title: "London" }), earlier: 0, busy: false,
                   messages: [{ id: M(1), role: "user", text: "Can my family fund my flat?" }] });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "delta", messageId: M(2), text: "Decide who owns it first." });
    await s.send({ type: "question", messageId: M(2), question: form });
    await s.frame();
    const card = s.page.locator(".cd-question");
    assert.equal(await card.getAttribute("class"), "cd-question cd-form");
    assert.deepEqual(await card.locator(".cd-question-text").allTextContents(),
                     ["1. Who should own it?", "2. Which relatives could contribute?", "3. Where in the UK is the property?"]);
    assert.equal(await card.locator(".cd-other").count(), 0, "no box of its own: they can write in the chat");
    assert.equal(await card.locator("input:checked").count(), 0, "nothing chosen while it's still answering");
    assert.equal(await card.locator(".cd-question-note").textContent(), "Answer when the reply finishes");
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Decide who owns it first.", finish: "stop", questions: [form] } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    assert.deepEqual(await card.locator("input:checked").evaluateAll((n) => n.map((x) => x.value)),
                     ["Only me", "Spouse and/or parents", "England, including London"], "the first answer of each, until changed");
    await card.getByText("Brothers and/or sisters").click();
    await s.send({ type: "turn", state: "ended", replyId: M(2) });       // the chat redraws: what you picked stays
    assert.equal(await card.getByLabel("Brothers and/or sisters").isChecked(), true);
    if (process.env.DGC_SHOTS) await card.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-question-form.png") });
    await card.getByRole("button", { name: "Build my family remittance plan" }).click();
    const [answer] = await s.posted("answer");
    assert.deepEqual([answer.question, answer.choice, answer.choices],
                     [0, "Only me", ["Only me", "Brothers and/or sisters", "England, including London"]]);
    assert.equal(await s.page.locator("#cd-send").isDisabled(), true, "it's answering now");
    await s.send({ type: "message", message: { id: M(3), role: "user", text: "Build my plan.\n\nWho should own it? Only me",
      answers: { message: M(2), question: 0, choice: "Only me", choices: ["Only me", "Brothers and/or sisters", "Wales"] } } });
    await s.frame();
    assert.equal(await card.getAttribute("data-state"), "answered");
    assert.deepEqual(await card.locator("input:checked").evaluateAll((n) => n.map((x) => x.value)),
                     ["Only me", "Brothers and/or sisters", "Wales"], "it shows what was sent");
    assert.equal(await card.locator("input:not(:disabled)").count(), 0);
    assert.equal(await card.locator(".cd-question-note").textContent(), "Answered");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("Codex's queue: what you send while it answers waits above the box and goes when the reply finishes; Stop gives it all back", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const sends = async () => (await s.posted("send")).map((m) => m.text);
    const box = s.page.locator("#cd-input"), queue = s.page.locator("#cd-queue");
    await s.send({ type: "opened", conversation: conversation(), messages: [{ id: M(1), role: "user", text: "Plan a trip." }], earlier: 0, busy: false });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    assert.equal(await queue.isHidden(), true, "nothing queued: no queue");
    assert.equal(await s.page.locator("#cd-send").isHidden(), true, "an empty box while it answers: Stop only");
    await box.fill("And the budget?");
    assert.deepEqual([await s.page.locator("#cd-send").isVisible(), await s.page.locator("#cd-stop").isVisible()], [true, true],
                     "something typed: Send, to queue it, beside Stop");
    assert.equal(await s.page.locator("#cd-send").getAttribute("aria-label"), "Queue message");
    await box.press("Enter");
    await box.fill("And the weather?");
    await s.page.locator("#cd-send").click();
    assert.deepEqual(await sends(), [], "nothing is sent while it answers");
    assert.equal(await box.inputValue(), "");
    assert.deepEqual([await s.page.locator("#cd-send").isHidden(), await s.page.locator("#cd-stop").isVisible()], [true, true],
                     "queued, the box is empty again: Stop only");
    assert.deepEqual(await queue.locator(".cd-queue-text").allTextContents(), ["And the budget?", "And the weather?"]);
    assert.match(await queue.locator(".cd-queue-head").textContent(), /^2 queued/);
    if (process.env.DGC_SHOTS) await s.page.locator(".cd-box").screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-queue.png") });
    // Up in an empty box takes back the last one (Codex's "edit last queued message"); Enter queues it again.
    await box.press("ArrowUp");
    assert.equal(await box.inputValue(), "And the weather?");
    assert.deepEqual(await queue.locator(".cd-queue-text").allTextContents(), ["And the budget?"]);
    await box.fill("And the weather in May?"); await box.press("Enter");
    // The reply finishes: the first goes, and the next waits for its reply.
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    assert.deepEqual(await sends(), ["And the budget?"]);
    assert.deepEqual(await queue.locator(".cd-queue-text").allTextContents(), ["And the weather in May?"]);
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "turn", state: "ended", replyId: M(4) });
    assert.deepEqual(await sends(), ["And the budget?", "And the weather in May?"], "one a reply, in order");
    assert.equal(await queue.isHidden(), true);
    // Stop: the reply ends and nothing queued goes after it -- it's all back in the box, in order, for you.
    await s.send({ type: "turn", state: "started", replyId: M(6) });
    await box.fill("One"); await box.press("Enter");
    await box.fill("Two"); await box.press("Enter");
    await box.fill("Still typing");
    await s.page.locator("#cd-stop").click();
    assert.equal((await s.posted("stop")).length, 1);
    await s.send({ type: "turn", state: "ended", replyId: M(6) });
    assert.equal((await sends()).length, 2, "Stop: nothing queued is sent");
    assert.equal(await box.inputValue(), "One\n\nTwo\n\nStill typing");
    assert.equal(await queue.isHidden(), true);
    // A reply that fails: the same -- what waited is yours again.
    await box.fill("");
    await s.send({ type: "turn", state: "started", replyId: M(8) });
    await box.fill("Three"); await box.press("Enter");
    await s.send({ type: "error", message: "The model is not reachable." });
    await s.send({ type: "turn", state: "ended", replyId: M(8) });
    assert.equal((await sends()).length, 2);
    assert.equal(await box.inputValue(), "Three");
    // Edit and Remove on a row.
    await box.fill("");
    await s.send({ type: "turn", state: "started", replyId: M(9) });
    for (const words of ["Keep me", "Drop me", "Change me"]) { await box.fill(words); await box.press("Enter"); }
    await queue.getByRole("button", { name: "Remove queued message 2" }).click();
    await queue.getByRole("button", { name: "Edit queued message 2" }).click();
    assert.equal(await box.inputValue(), "Change me");
    assert.deepEqual(await queue.locator(".cd-queue-text").allTextContents(), ["Keep me"]);
    // Kept with the chat: shown again on a reload while it answers; with nothing running, back in the box instead.
    const saved = await s.page.evaluate(() => window.__state[`queue:chat_${"a".repeat(32)}`]);
    assert.deepEqual(saved.map((q) => q.text), ["Keep me"]);
    await s.send({ type: "opened", conversation: conversation(), messages: [{ id: M(1), role: "user", text: "Plan a trip." }], earlier: 0, busy: false });
    assert.equal(await queue.isHidden(), true);
    assert.match(await box.inputValue(), /^Keep me/, "never sent on its own after a reload");
    assert.equal((await sends()).length, 2);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a reply that read a plugin says so under it (Used Aave), as ChatGPT names the apps it used", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "USDC rate on Aave?" },
      { id: M(2), role: "assistant", text: "About 3.87% on the main market.", finish: "stop",
        plugins: [{ plugin: "aave", name: "Aave" }, { plugin: "evil", name: "<b>x</b>" }, "Context7"] },
      { id: M(3), role: "user", text: "Thanks" },
      { id: M(4), role: "assistant", text: "Any time.", finish: "stop" }] });
    await s.frame();
    assert.deepEqual(await s.page.locator(".cd-plugins-used").allTextContents(), ["Used Aave, <b>x</b>, Context7"],
                     "only the reply that read one, names as words (a bare name from an earlier build too)");
    assert.equal(await s.page.locator(".cd-plugins-used b").count(), 0);
    // Its logo, from the host: a plug until it comes, asked once for the plugins with an id.
    assert.equal(await s.page.locator(".cd-plugin-mark img").count(), 0);
    assert.deepEqual((await s.posted("pluginLogos")).map((m) => m.plugins), [["aave", "evil"]]);
    await s.send({ type: "pluginLogos", logos: { aave: "data:image/png;base64,iVBORw0KGgo=", evil: "javascript:alert(1)" } });
    assert.equal(await s.page.locator('.cd-plugin-mark[data-plugin-mark="aave"] img').getAttribute("src"), "data:image/png;base64,iVBORw0KGgo=");
    assert.equal(await s.page.locator('.cd-plugin-mark[data-plugin-mark="evil"] img').count(), 0, "only an image the host read");
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "USDC rate on Aave?" },
      { id: M(2), role: "assistant", text: "About 3.87%.", finish: "stop", plugins: [{ plugin: "aave", name: "Aave" }] }] });
    await s.frame();
    assert.equal(await s.page.locator('.cd-plugin-mark[data-plugin-mark="aave"] img').count(), 1, "drawn again with its logo");
    assert.equal((await s.posted("pluginLogos")).length, 1, "never asked again");
    await s.send({ type: "turn", state: "started", replyId: M(6) });
    await s.send({ type: "message", message: { id: M(5), role: "user", text: "Again?" } });
    await s.send({ type: "delta", messageId: M(6), text: "Checking" });
    await s.frame();
    assert.equal(await s.page.locator(`[data-id="${M(6)}"] .cd-plugins-used`).count(), 0, "not while it's still being written");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("Codex's queue while it summarizes: a message sent during Compact now goes once the summary is in", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [{ id: M(1), role: "user", text: "hi" }, { id: M(2), role: "assistant", text: "Hello.", finish: "stop" }], earlier: 0, busy: false });
    await s.send({ type: "activity", kind: "compacting", messageId: "c1", text: "" });
    await s.page.locator("#cd-input").fill("Now the next step?");
    await s.page.locator("#cd-input").press("Enter");
    assert.deepEqual(await s.posted("send"), [], "not while it summarizes");
    assert.deepEqual(await s.page.locator("#cd-queue .cd-queue-text").allTextContents(), ["Now the next step?"]);
    await s.send({ type: "compacted", summary: { text: "Said hello.", upto: M(2) } });
    assert.deepEqual((await s.posted("send")).map((m) => m.text), ["Now the next step?"], "the summary is in: it goes");
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
    assert.deepEqual([await toggle.getAttribute("aria-pressed"), await s.page.locator("#cd-input").getAttribute("placeholder")],
                     ["true", "What should I research?"]);
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

test("deep research: how deep it goes, its budget as it reads, the steps it has covered, and how it was researched", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const plan = { title: "Home loans in Pune", steps: ["Rates in 2026", "Processing fees", "Prepayment rules"], sites: [] };
    const planned = { status: "planned", plan, depth: "standard", budget: { rounds: 6, pages: 40, minutes: 15, least: 20 } };
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Home loans for a ₹70 lakh flat in Pune", research: true },
      { id: M(2), role: "assistant", text: "plan", finish: "stop", research: planned }] });
    const card = s.page.locator(".cd-research");
    assert.equal(await card.locator(".cd-plan-depth").textContent(), "Standard: reads up to 40 pages, in up to 15 minutes.");
    await card.getByRole("button", { name: "Edit" }).click();
    const depth = card.locator(".cd-plan-field").nth(3).locator("select");
    assert.equal(await depth.inputValue(), "standard");
    assert.deepEqual(await depth.locator("option").allTextContents(), ["Quick: reads up to 15 pages, in up to 5 minutes",
      "Standard: reads up to 40 pages, in up to 15 minutes", "Thorough: reads up to 80 pages, in up to 30 minutes"]);
    await depth.selectOption("thorough");
    await card.getByRole("button", { name: "Start research" }).click();
    const [started] = await s.posted("researchStart");
    assert.equal(started.plan.depth, "thorough", "a depth you change goes with the plan");
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "research", messageId: M(2), research: { ...planned, status: "running", depth: "thorough",
      budget: { rounds: 10, pages: 80, minutes: 30, least: 40 }, round: 3, reads: 25, opened: 23, found: 96, covered: [1, 3],
      notes: [{ n: 1, title: "SBI", url: "https://sbi.co.in" }],
      activity: [{ kind: "gap", text: "Prepayment rules for fixed-rate loans" }, { kind: "pick", text: "Chose 9 of 31 results to read" }] } });
    await s.frame();
    assert.equal(await card.locator(".cd-research-stats").textContent(), "round 3 of 10 · 23 of 80 pages read · 96 sources found");
    assert.deepEqual(await card.locator(".cd-research-log li").allTextContents(),
                     ["Still missing: Prepayment rules for fixed-rate loans", "Chose 9 of 31 results to read"]);
    await card.getByText(/^Research plan · 3 steps · 2 covered so far$/).click();
    assert.deepEqual(await card.locator(".cd-plan-steps li").evaluateAll((items) => items.map((li) => li.classList.contains("cd-step-covered"))),
                     [true, false, true]);
    const how = "How this was researched: 6 rounds of searching and reading, 31 searches, 112 sources found, 38 pages read (35 in full), "
      + "29 of them used, 13 minutes. Citations checked: 52 of 55 cited claims hold up against their sources.";
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "# Home loans\n\nRates start at 7.5% [1].", finish: "stop",
      sources: [{ n: 1, title: "SBI", url: "https://sbi.co.in" }],
      research: { status: "done", plan, depth: "thorough", budget: { rounds: 10, pages: 80, minutes: 30 }, round: 6, opened: 38, found: 112,
                  seconds: 785, started_at: "2026-10-10T10:00:00Z", finished_at: "2026-10-10T11:00:00Z", how,
                  notes: [{ n: 1, title: "SBI", url: "u", note: "x" }], check: { claims: 55, checked: 55, supported: 52 }, activity: [] } } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    assert.equal(await card.locator(".cd-research-stats").textContent(), "38 pages read · 112 sources found · 13:05 · citations: 52 of 55 hold up",
                 "the time it spent, not the hour on the clock");
    assert.equal(await s.page.locator(".cd-research-how").textContent(), how);
    const order = await s.page.locator(".cd-assistant").evaluate((node) => [".cd-body", ".cd-research-how", ".cd-sources-button"]
      .map((sel) => [...node.querySelectorAll("*")].indexOf(node.querySelector(sel))));
    assert.ok(order[0] < order[1] && order[1] < order[2], `the report, how it was researched, then its sources: ${order}`);
    if (process.env.DGC_SHOTS) await s.page.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-research-how.png") });
    assert.deepEqual(s.errors, []);
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
    if (process.env.DGC_SHOTS) writeFileSync(join(process.env.DGC_SHOTS, "chatdgc-chart-saved.png"), Buffer.from(saved.data.split(",")[1], "base64"));
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

test("interactive answers: a ```widget is a card, never a frame in the chat; Open sends its page, Show code shows it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const fence = "```";
    const html = "<title>EMI calculator</title><label>Loan <input id=loan></label><script>/* … */</script>";
    await s.send({ type: "opened", conversation: conversation({ title: "EMI" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "EMI calculator please" },
      { id: M(2), role: "assistant", text: `Here's a calculator.\n\n${fence}widget\n${html}\n${fence}`, finish: "stop" }] });
    await s.frame();
    const card = s.page.locator(".cd-widget");
    assert.equal(await card.locator(".cd-widget-title").textContent(), "EMI calculator");
    assert.match(await card.locator(".cd-widget-note").textContent(), /opens in a tab beside the chat/);
    assert.equal(await s.page.locator("iframe").count(), 0, "nothing of the widget's runs in the chat");
    assert.equal(s.page.frames().length, 1);
    await card.getByRole("button", { name: "Open" }).click();
    assert.deepEqual((await s.posted("widgetOpen")).at(-1), { type: "widgetOpen", html, title: "EMI calculator" });
    await card.getByRole("button", { name: "Show code" }).click();
    await s.frame();
    assert.equal(await s.page.locator(".cd-widget pre.code").count(), 1);
    assert.equal(await card.getByRole("button", { name: "Hide code" }).count(), 1);
    // While the reply is written: a placeholder, never half a page.
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "delta", messageId: M(4), text: `${fence}widget\n<div>half` });
    await s.frame();
    assert.equal(await s.page.locator(`.cd-assistant[data-id="${M(4)}"] .cd-chart-pending`).textContent(), "Building an interactive answer…");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("interactive answers from show_widget: the card as the reply shows it, then kept on the reply; Open names it; Show code is its page", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    const widget = { id: `wg_${"a".repeat(16)}`, title: "Stopwatch <b>!</b>", html: "<button id=go>Start</button><script>/* … */</script>", at: 0 };
    await s.send({ type: "opened", conversation: conversation({ title: "Timer" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "A stopwatch please" }] });
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "widgetShown", messageId: M(2), widget });
    await s.send({ type: "widgetShown", messageId: M(2), widget: { ...widget, id: "wg_nope" } });
    await s.frame();
    assert.equal(await s.page.locator(".cd-widget").count(), 1, "only a widget DGC named");
    assert.equal(await s.page.locator(".cd-widget-title").textContent(), "Stopwatch <b>!</b>", "a title is text");
    await s.send({ type: "message", message: { id: M(2), role: "assistant", text: "Here's a stopwatch.", finish: "stop", widgets: [widget] } });
    await s.send({ type: "turn", state: "ended", replyId: M(2) });
    await s.frame();
    assert.equal(await s.page.locator(".cd-widget").count(), 1, "kept on the reply, once");
    assert.equal(await s.page.locator("iframe").count(), 0);
    await s.page.locator(".cd-widget").getByRole("button", { name: "Open" }).click();
    assert.deepEqual((await s.posted("widgetOpen")).at(-1), { type: "widgetOpen", id: widget.id, html: widget.html, title: widget.title });
    await s.page.locator(".cd-widget").getByRole("button", { name: "Show code" }).click();
    await s.frame();
    assert.equal(await s.page.locator(".cd-widget pre.code").textContent(), widget.html);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// The widget's own page, as the extension builds it (VS Code itself isn't needed to build it).
let widgetDocument;
function widgetPage() {
  if (widgetDocument) return widgetDocument;
  const dir = mkdtempSync(join(tmpdir(), "dgc-widget-page-"));
  writeFileSync(join(dir, "vscode.cjs"), "module.exports = {};");
  buildSync({ entryPoints: [join(root, "src/chatdgc.ts")], bundle: true, format: "cjs", platform: "node", target: "node18",
    outfile: join(dir, "chatdgc.cjs"), alias: { vscode: join(dir, "vscode.cjs") }, logLevel: "silent" });
  ({ widgetDocument } = createRequire(import.meta.url)(join(dir, "chatdgc.cjs")));
  return widgetDocument;
}

test("a widget's page in a browser: the editor's colours win over its own, an error shows in it, no network", async (t) => {
  if (skipOrFail(t)) return;
  const page = await browser.newPage({ viewport: { width: 500, height: 400 } });
  try {
    const own = `<style>:root{--bg:#ffffff;--text:#111111}@media (prefers-color-scheme: light){:root{--bg:#fefefe}}
      body{background:var(--bg);color:var(--text)}</style><h1>EMI</h1><input id=a value=1><output id=o></output>
      <script>var el={a:document.getElementById("a")};el.a.addEventListener("input",function(){el.out.textContent="x"});
      document.getElementById("o").textContent=[typeof fetch,typeof XMLHttpRequest,typeof WebSocket,typeof RTCPeerConnection].join();</script>`;
    await page.emulateMedia({ colorScheme: "light" });      // the system's, as a webview has it, while VS Code's theme is dark
    await page.setContent(widgetPage()(own), { waitUntil: "load" });
    await page.evaluate(() => {        // what VS Code puts on a webview's page
      document.documentElement.style.setProperty("--vscode-editor-background", "rgb(31, 31, 31)");
      document.documentElement.style.setProperty("--vscode-editor-foreground", "rgb(204, 204, 204)");
      document.body.dataset.vscodeThemeKind = "vscode-dark";
    });
    const look = () => page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.body).color,
                                             getComputedStyle(document.documentElement).colorScheme]);
    assert.deepEqual(await look(), ["rgb(31, 31, 31)", "rgb(204, 204, 204)", "dark"], "the editor's, not the page's own light ones");
    assert.equal(await page.locator("#o").textContent(), "undefined,undefined,undefined,undefined");
    assert.equal(await page.locator("#dgc-widget-error").count(), 0, "nothing failed yet");
    await page.locator("#a").fill("2");
    assert.match(await page.locator("#dgc-widget-error").textContent(),
                 /^This widget hit an error, so it may not work: Uncaught TypeError: .*'textContent'\)\. Ask ChatDGC to fix it\.$/);
    assert.equal(await page.locator("#dgc-widget-error").getAttribute("role"), "alert");
    await page.evaluate(() => { document.body.dataset.vscodeThemeKind = "vscode-light"; });
    assert.equal((await look())[2], "light", "its controls follow a light theme");
  } finally { await page.close(); }
});

test("a widget's page in a browser: put back as you left it (its code reruns), said as you type, and told once open", async (t) => {
  if (skipOrFail(t)) return;
  const page = await browser.newPage({ viewport: { width: 500, height: 400 } });
  try {
    // As VS Code gives a webview its handle (a script it puts first in the page's head): once.
    const handle = `<script>window.__posted=[];var taken=false;window.acquireVsCodeApi=function(){if(taken)throw new Error(
      "An instance of the VS Code API has already been acquired");taken=true;return{postMessage:function(m){window.__posted.push(JSON.parse(JSON.stringify(m)))}}}</script>`;
    const own = `<label>Bill <input id=bill type=number value=100></label><label>Tip <input type=range min=0 max=30 value=10></label>
      <label><input type=checkbox id=round> Round</label><p>Tip: <span id=out></span></p>
      <script>function calc(){var t=bill.value*document.querySelector("[type=range]").value/100;out.textContent=round.checked?Math.round(t):t.toFixed(2)}
      document.addEventListener("input",calc);calc();try{acquireVsCodeApi()}catch(e){document.body.dataset.api=e.message}</script>`;
    const saved = [{ i: 0, id: "bill", v: "1251" }, { i: 1, id: "", v: "20" }, { i: 2, id: "round", c: true }];
    await page.setContent(widgetPage()(own, saved).replace("<head>", `<head>${handle}`), { waitUntil: "load" });
    await page.waitForFunction(() => window.__posted.some((m) => m.type === "report"), null, { timeout: 5000 });
    assert.equal(await page.locator("#out").textContent(), "250", "1251 at 20%, rounded: as left, and worked out again");
    const report = await page.evaluate(() => window.__posted.filter((m) => m.type === "report"));
    assert.equal(report.length, 1);
    assert.match(report[0].text, /Tip: 250/);
    assert.deepEqual(report[0].errors, []);
    assert.equal(await page.evaluate(() => document.body.dataset.api), "An instance of the VS Code API has already been acquired",
                 "the widget's own code can't take the handle");
    await page.locator("#bill").fill("1000");
    await page.waitForFunction(() => window.__posted.some((m) => m.type === "state" && m.fields[0].v === "1000"), null, { timeout: 5000 });
    const state = await page.evaluate(() => window.__posted.filter((m) => m.type === "state").at(-1));
    assert.deepEqual(state.fields, [{ i: 0, id: "bill", v: "1000" }, { i: 1, id: "", v: "20" }, { i: 2, id: "round", c: true }]);
  } finally { await page.close(); }
});

test("maths in a reply, drawn by KaTeX as ChatGPT draws it: in a line and on its own; money stays money; Copy keeps the TeX", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    // KaTeX, as the page loads it the first time a formula shows (its file is the extension's own).
    await s.page.evaluate((code) => { eval(code); }, readFileSync(join(root, "node_modules/katex/dist/katex.min.js"), "utf8"));
    await s.page.addStyleTag({ content: readFileSync(join(root, "node_modules/katex/dist/katex.min.css"), "utf8").replace(/url\([^)]*\)/g, "local(x)") });
    const text = "The area is $\\pi r^2$, which costs $5 or $10 to paint.\n\n$$\nA = P\\left(1 + \\frac{r}{n}\\right)^{nt}\n$$";
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Area of a circle?" }, { id: M(2), role: "assistant", text, finish: "stop" }] });
    await s.frame(); await s.frame();
    const reply = s.page.locator(`.cd-assistant[data-id="${M(2)}"]`);
    assert.equal(await reply.locator(".md-math").count(), 2);
    assert.equal(await reply.locator("span.md-math .katex").count(), 1, "in a line");
    assert.equal(await reply.locator("div.md-math-display .katex-display").count(), 1, "on its own line");
    assert.equal(await reply.locator(".katex-mathml annotation").first().textContent(), "\\pi r^2", "and readable by a screen reader");
    assert.match(await reply.locator("p").first().innerText(), /costs \$5 or \$10 to paint/);
    // While it's written: drawn as it comes.
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "delta", messageId: M(4), text: "So $x^2 + y^2 = z^2$ holds" });
    await s.frame(); await s.frame();
    assert.equal(await s.page.locator(`.cd-assistant[data-id="${M(4)}"] .md-math .katex`).count(), 1);
    await reply.getByRole("button", { name: "Copy" }).click();
    const copied = (await s.posted("copy")).at(-1)?.text ?? await s.page.evaluate(() => navigator.clipboard.readText()).catch(() => "");
    assert.match(copied, /The area is \$\\pi r\^2\$/, "the TeX, as written");
    if (process.env.DGC_SHOTS) await reply.screenshot({ path: join(process.env.DGC_SHOTS, "chatdgc-maths.png") });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a widget deleted from the Library: its card keeps its name and says so, with nothing to open or show", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: conversation({ title: "Timer" }), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "A stopwatch please" },
      { id: M(2), role: "assistant", text: "Here's a stopwatch.", finish: "stop", widgets: [{ id: `wg_${"a".repeat(16)}`, title: "Stopwatch", removed: true, at: 0 }] }] });
    await s.frame();
    const card = s.page.locator(".cd-widget");
    assert.equal(await card.locator(".cd-widget-title").textContent(), "Stopwatch");
    assert.equal(await card.locator(".cd-widget-note").textContent(), "Deleted from your Library");
    assert.equal(await card.locator("button").count(), 0);
    assert.equal(await card.locator(".cd-file[data-removed]").count(), 1);
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

// Widgets in a chat, option C1 (founder, 2026-10-18): "Widgets N" in the header while the chat has any, a list of them
// with when each was made and the prompt that asked, Open, Show it in the chat, Delete asked in the row, and the
// Library a click away. A long chat opens on its latest pages: the rest come from its outline, and Show it in the chat
// loads the pages before what's shown until the widget's card is there.
test("widgets in a chat: Widgets N in the header, each with its prompt, Open, shown in the chat (earlier pages loaded first), deleted after asking, the Library a click away", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 900, height: 700 });
  try {
    const P = (n) => `msg_${String(n).padStart(32, "0")}`, WG = (n) => `wg_${String(n).padStart(16, "0")}`;
    const at = (n) => new Date(Date.UTC(2026, 9, 10, 9, n)).toISOString();
    const say = ["Make me an EMI calculator", "Something else", "Make a tool to compare loans", "Build a focus timer", "Thanks"];
    const msgs = [];
    say.forEach((text, i) => {
      msgs.push({ id: P(2 * i), role: "user", text, created_at: at(4 * i) });
      const made = { 0: [{ id: WG(1), title: "EMI calculator", html: "<title>EMI calculator</title><p>emi</p>", created_at: at(4 * i + 1) }],
                     1: [{ id: WG(3), title: "Old one", removed: true, created_at: at(4 * i + 1) }],
                     2: [{ id: WG(5), title: "Loan comparison", html: "<p>loans</p>", created_at: at(4 * i + 1) }],
                     3: [{ id: WG(7), title: "Focus timer", html: "<p>timer</p>", created_at: at(4 * i + 1) }] }[i] || [];
      msgs.push({ id: P(2 * i + 1), role: "assistant", text: `Reply ${i}.\n\n${"Words. ".repeat(120)}`, widgets: made, finish: "stop", created_at: at(4 * i + 1) });
    });
    // A chat with none: no button.
    await s.send({ type: "opened", conversation: conversation(), messages: msgs.slice(2, 4).map((m) => ({ ...m, widgets: [] })), earlier: 0, busy: false });
    assert.equal(await shown(s.page, "#cd-widgets"), false, "no widgets, no button");
    assert.equal((await s.posted("outline")).length, 0, "the whole chat on screen: no outline asked");
    // A long chat opened on its latest pages (prompts 3 and 4): the rest of its widgets come from its outline.
    await s.send({ type: "opened", conversation: conversation({ id: `chat_${"b".repeat(32)}`, title: "Flat" }), messages: msgs.slice(6), earlier: 6, busy: false });
    assert.equal((await s.posted("outline")).length, 1, "asked for, once");
    const outline = say.map((text, i) => ({ id: P(2 * i), text, created_at: at(4 * i),
      ...(msgs[2 * i + 1].widgets.length ? { widgets: msgs[2 * i + 1].widgets.map(({ html, ...w }) => ({ ...w, message_id: P(2 * i + 1) })) } : {}) }));
    await s.send({ type: "outline", conversation: `chat_${"b".repeat(32)}`, prompts: outline });
    await s.frame();
    const button = s.page.locator("#cd-widgets");
    assert.equal(await shown(s.page, "#cd-widgets"), true);
    assert.equal((await button.innerText()).replace(/\s+/g, " "), "Widgets 3", "the three not deleted, though one's reply is on screen");
    assert.equal(await button.getAttribute("aria-label"), "Widgets in this chat: 3");
    const head = await s.page.evaluate(() => [...document.querySelector(".cd-head").children].filter((n) => n.checkVisibility()).map((n) => n.id || n.className));
    assert.ok(head.indexOf("cd-widgets") < head.indexOf("cd-keys-open"), `among the header's buttons, first (${head})`);
    await button.click();
    const panel = s.page.locator("#cd-widgets-panel");
    assert.equal(await panel.getAttribute("role"), "dialog");
    assert.equal(await button.getAttribute("aria-expanded"), "true");
    assert.equal(await panel.locator(".cd-wtitle").textContent(), "Widgets in this chat");
    assert.equal(await panel.locator(".cd-wcount").textContent(), "3, in the order they were made");
    assert.deepEqual(await panel.locator(".cd-wname").allTextContents(), ["EMI calculator", "Old one", "Loan comparison", "Focus timer"]);
    const metas = await panel.locator(".cd-wmeta").allTextContents();
    assert.match(metas[0], /· from “Make me an EMI calculator”$/);
    assert.equal(metas[1], "Deleted");
    assert.match(metas[3], /from “Build a focus timer”$/);
    assert.equal(await panel.locator('.cd-wrow[data-removed] button').count(), 0, "nothing to do with a deleted one");
    assert.equal(await s.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open EMI calculator beside the chat", "the keys start on the first Open");
    // The keys: Esc closes it and gives the button back its focus; Enter opens it again.
    await s.page.keyboard.press("Escape");
    assert.equal(await panel.count(), 0);
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "cd-widgets");
    await s.page.keyboard.press("Enter");
    assert.equal(await panel.count(), 1);
    // Open: from its card's page when its reply is on screen; by id, for the host to fetch, when it isn't.
    await panel.locator('.cd-wrow[data-widget="' + WG(7) + '"] .cd-wopen').click();
    await panel.locator('.cd-wrow[data-widget="' + WG(1) + '"] .cd-wopen').click();
    assert.deepEqual((await s.posted("widgetOpen")).map((m) => [m.id, m.title, m.html || ""]),
                     [[WG(7), "Focus timer", "<p>timer</p>"], [WG(1), "EMI calculator", ""]]);
    // Delete, asked in the row; Esc says no. Its reply isn't on screen: the reply sent again stays off the bottom.
    const row5 = panel.locator('.cd-wrow[data-widget="' + WG(5) + '"]');
    await row5.locator(".cd-wdel").click();
    assert.equal(await row5.locator(".cd-wconfirm").textContent(), "Delete it?");
    assert.equal(await s.page.evaluate(() => document.activeElement?.textContent), "Delete", "the row's Delete has the keys");
    await s.page.keyboard.press("Escape");
    assert.equal(await row5.locator(".cd-wconfirm").count(), 0, "Esc: kept");
    assert.equal(await panel.count(), 1, "and the list stays open");
    await row5.locator(".cd-wdel").click();
    await row5.locator(".cd-wdanger").click();
    assert.deepEqual(await s.posted("widgetRemove"), [{ type: "widgetRemove", id: WG(5) }]);
    assert.equal(await row5.locator(".cd-wconfirm").textContent(), "Deleting…");
    await s.send({ type: "message", message: { ...msgs[5], widgets: [{ id: WG(5), title: "Loan comparison", removed: true, created_at: at(9) }] } });
    await s.send({ type: "widgetRemoved", id: WG(5) });
    await s.frame();
    assert.equal(await row5.locator(".cd-wmeta").textContent(), "Deleted");
    assert.equal((await button.innerText()).replace(/\s+/g, " "), "Widgets 2");
    assert.equal(await s.page.evaluate(() => [...document.querySelectorAll("#cd-log .cd-msg")].at(-1).dataset.id), P(9), "an earlier reply, not a new one at the end");
    // Show it in the chat: the pages before what's shown, asked for one after another, until its card is there.
    await panel.locator('.cd-wrow[data-widget="' + WG(1) + '"] .cd-wgo').click();
    assert.equal(await panel.count(), 0, "the list closes");
    let asked = await s.posted("earlier");
    assert.deepEqual(asked.map((m) => m.before), [P(6)]);
    await s.send({ type: "earlier", messages: msgs.slice(2, 6).map((m) => (m.id === P(5) ? { ...m, widgets: [{ id: WG(5), title: "Loan comparison", removed: true }] } : m)), earlier: 2 });
    asked = await s.posted("earlier");
    assert.deepEqual(asked.map((m) => m.before), [P(6), P(2)], "not there yet: the page before");
    await s.send({ type: "earlier", messages: msgs.slice(0, 2), earlier: 0 });
    await s.page.waitForTimeout(450);
    const card = s.page.locator(`.cd-widget[data-ref="${P(1)}:${WG(1)}"]`);
    const [c, view] = [await card.boundingBox(), await s.page.locator("#cd-scroll").boundingBox()];
    assert.ok(c.y >= view.y && c.y + c.height <= view.y + view.height, `its card in view (${c.y} in ${view.y}-${view.y + view.height})`);
    assert.equal(await card.locator(".cd-widget-card").evaluate((n) => n.classList.contains("cd-flash")), true, "and outlined for a moment");
    assert.equal(await s.page.locator(`.cd-widget[data-ref="${P(5)}:${WG(5)}"] .cd-widget-note`).textContent(), "Deleted from your Library");
    // The Library, on its Widgets tab.
    await button.click();
    await s.page.locator(".cd-wlink").click();
    assert.deepEqual(await s.posted("openLibrary"), [{ type: "openLibrary", view: "widgets" }]);
    assert.equal(await panel.count(), 0);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("widgets in a chat at side-bar width: the mark and the count, a list that fits, and a widget made while it is open", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 460, height: 700 });
  try {
    const W1 = { id: `wg_${"1".repeat(16)}`, title: "A calculator with a rather long name that has to give way", html: "<p>x</p>", created_at: "2026-10-10T09:00:00Z" };
    await s.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(1), role: "user", text: "Make me a calculator for something with a long description that runs on", created_at: "2026-10-10T08:59:00Z" },
      { id: M(2), role: "assistant", text: "Here.", widgets: [W1], finish: "stop", created_at: "2026-10-10T09:00:00Z" }] });
    const button = s.page.locator("#cd-widgets");
    assert.equal((await button.innerText()).replace(/\s+/g, " "), "1", "narrow: the mark and the count");
    assert.equal(await button.getAttribute("aria-label"), "Widgets in this chat: 1", "its name says it all the same");
    await button.click();
    const box = await s.page.locator("#cd-widgets-panel").boundingBox();
    assert.ok(box.x >= 11 && box.x + box.width <= 460 - 11, `inside the editor (${box.x}, ${box.width})`);
    const row = await s.page.evaluate(() => { const r = document.querySelector(".cd-wrow"); return { over: r.scrollWidth - r.clientWidth, acts: r.querySelector(".cd-wacts").getBoundingClientRect().right, right: r.getBoundingClientRect().right }; });
    assert.ok(row.over <= 0 && row.acts <= row.right + 1, "the name gives way; Open, Show and Delete stay in reach");
    assert.equal(await s.page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth), 0);
    // A new widget while the list is open: there at once.
    await s.send({ type: "turn", state: "started", replyId: M(4) });
    await s.send({ type: "message", message: { id: M(3), role: "user", text: "And a timer", created_at: "2026-10-10T09:05:00Z" } });
    await s.send({ type: "widgetShown", messageId: M(4), widget: { id: `wg_${"2".repeat(16)}`, title: "Timer", html: "<p>t</p>", created_at: "2026-10-10T09:06:00Z" } });
    await s.frame();
    assert.deepEqual(await s.page.locator("#cd-widgets-panel .cd-wname").allTextContents(), [W1.title, "Timer"]);
    assert.equal((await button.innerText()).replace(/\s+/g, " "), "2");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// The prompt rail (founder, 2026-10-18: "The rail looks good"), ChatGPT's table of contents with ours added: a tick
// per prompt from five prompts, the one being read bright; a card on hover with every prompt, its time under day
// headings and the widget its reply made; a click or Alt+Up/Down goes there. ChatGPT's broke when a chat loaded in
// pieces; this one lists every prompt from the chat's outline and loads what a jump needs first.
const railChat = (count, { widgetsAt = [0, 7] } = {}) => {
  const P = (n) => `msg_${String(n).padStart(32, "0")}`;
  const messages = [];
  const start = Date.now() - count * 3 * 3600e3;
  for (let i = 0; i < count; i++) {
    const at = start + i * 3 * 3600e3;
    messages.push({ id: P(2 * i), role: "user", text: `Prompt ${i}: ${"about the flat ".repeat(1 + (i % 3))}`.trim(), created_at: new Date(at).toISOString() });
    messages.push({ id: P(2 * i + 1), role: "assistant", text: `Answer ${i}.\n\n${"A fixed rate stays the same for a set period. ".repeat(10)}`, finish: "stop",
                    created_at: new Date(at + 60e3).toISOString(),
                    widgets: widgetsAt.includes(i) ? [{ id: `wg_${String(i).padStart(16, "0")}`, title: i === 0 ? "EMI calculator" : `Widget ${i}`, html: "<p>w</p>" }] : [] });
  }
  return { P, messages };
};
const railState = (page) => page.evaluate(() => {
  const ticks = [...document.querySelectorAll("#cd-rail .cd-tick")];
  return { shown: !document.getElementById("cd-rail").hidden, ticks: ticks.length, now: ticks.findIndex((t) => t.classList.contains("now")) };
});
// The card opens over the rail, as ChatGPT's does: the pointer goes there (a locator's hover waits for the rail to be on
// top, and the card it opened never lets it).
const hoverRail = async (page) => { const b = await page.locator("#cd-rail").boundingBox(); await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); };
const promptTop = (page, id) => page.evaluate((x) => {
  const sc = document.getElementById("cd-scroll").getBoundingClientRect(), n = document.querySelector(`.cd-msg[data-id="${x}"]`);
  return n ? (n.getBoundingClientRect().top - sc.top) / sc.height : null;
}, id);

test("the prompt rail: from five prompts, a tick each and the one being read bright; hover lists them with times, days and widgets; a click, Alt+Up/Down and the keys go there", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 900, height: 700 });
  try {
    const { P, messages } = railChat(23);
    await s.send({ type: "opened", conversation: conversation(), messages: messages.slice(0, 8), earlier: 0, busy: false });
    assert.equal((await railState(s.page)).shown, false, "four prompts: no rail");
    await s.send({ type: "message", message: messages[8] });
    await s.frame();
    assert.deepEqual(await railState(s.page).then((r) => [r.shown, r.ticks]), [true, 5], "the fifth prompt brings it");
    await s.send({ type: "opened", conversation: conversation({ id: `chat_${"c".repeat(32)}` }), messages, earlier: 0, busy: false });
    await s.frame();
    const rail = s.page.locator("#cd-rail");
    assert.equal((await railState(s.page)).ticks, 23);
    // Where it sits: centred on the transcript, in its right margin, clear of the words.
    const [r, scroll, bubble] = [await rail.boundingBox(), await s.page.locator("#cd-scroll").boundingBox(), await s.page.locator(".cd-bubble").first().boundingBox()];
    assert.ok(Math.abs(r.y + r.height / 2 - (scroll.y + scroll.height / 2)) <= 2, "centred");
    assert.ok(r.x > bubble.x + bubble.width && r.x + r.width <= scroll.x + scroll.width, "in the margin, right of the bubbles");
    const tick = await s.page.locator(".cd-tick").first().boundingBox();
    assert.deepEqual([tick.width, tick.height], [16, 2]);
    // The one being read is bright.
    await s.page.evaluate((id) => { const sc = document.getElementById("cd-scroll"), n = document.querySelector(`.cd-msg[data-id="${id}"]`);
      sc.scrollTop += n.getBoundingClientRect().top - sc.getBoundingClientRect().top - 20; }, P(18));
    await s.page.waitForTimeout(300);
    assert.equal((await railState(s.page)).now, 9);
    const colours = await s.page.evaluate(() => [...document.querySelectorAll(".cd-tick")].slice(8, 10).map((t) => getComputedStyle(t).opacity));
    assert.deepEqual(colours, ["0.55", "1"]);
    // Hover: every prompt, with its time, under day headings; the widget a reply made; the one being read marked.
    await hoverRail(s.page);
    const card = s.page.locator("#cd-rail-card");
    await card.waitFor({ state: "visible" });
    assert.equal(await rail.getAttribute("aria-expanded"), "true");
    assert.match(await card.locator(".cd-rail-head").innerText(), /^23 prompts/);
    assert.equal(await card.locator(".cd-rail-row").count(), 23);
    assert.ok((await card.locator(".cd-rail-day").count()) >= 2, "day headings");
    assert.deepEqual(await card.locator(".cd-rail-widget").allInnerTexts(), ["EMI calculator", "Widget 7"]);
    const now = card.locator(".cd-rail-row.now");
    assert.equal(await now.getAttribute("data-i"), "9");
    assert.equal(await now.getAttribute("aria-current"), "true");
    assert.match(await card.locator(".cd-rail-row").nth(9).locator(".cd-rail-time").innerText(), /^\d{1,2}:\d{2}/);
    const c = await card.boundingBox();
    assert.ok(c.x + c.width <= 900 && c.y >= scroll.y && c.y + c.height <= scroll.y + scroll.height, "inside the transcript");
    // A click: the card closes, the view eases to that prompt, near the top, outlined for a moment.
    await card.locator(".cd-rail-row").nth(2).click();
    assert.equal(await card.isHidden(), true);
    await s.page.waitForTimeout(450);
    const top = await promptTop(s.page, P(4));
    assert.ok(top >= 0 && top < 0.12, `prompt 2 near the top (${top})`);
    assert.equal(await s.page.locator(`.cd-msg[data-id="${P(4)}"] .cd-bubble`).evaluate((n) => n.classList.contains("cd-flash")), true);
    assert.equal((await railState(s.page)).now, 2, "and its tick is the bright one");
    // Alt+Down and Alt+Up, from the message box.
    await s.page.locator("#cd-input").focus();
    await s.page.keyboard.press("Alt+ArrowDown");
    await s.page.waitForTimeout(450);
    assert.equal((await railState(s.page)).now, 3);
    assert.ok((await promptTop(s.page, P(6))) < 0.12);
    await s.page.keyboard.press("Alt+ArrowUp");
    await s.page.waitForTimeout(450);
    assert.equal((await railState(s.page)).now, 2);
    assert.equal(await s.page.locator("#cd-input").inputValue(), "", "nothing typed into the box");
    // The keys: Tab reaches it, Down goes into the list, Enter goes there, Esc closes it.
    await rail.focus();
    await s.page.keyboard.press("ArrowDown");
    assert.equal(await s.page.evaluate(() => document.activeElement?.dataset.i), "2", "into the list, at the one being read");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Enter");
    await s.page.waitForTimeout(450);
    assert.equal((await railState(s.page)).now, 4);
    await rail.focus();
    await s.page.keyboard.press("ArrowDown");
    await s.page.keyboard.press("Escape");
    assert.equal(await card.isHidden(), true);
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "cd-rail");
    assert.match(await rail.getAttribute("aria-label"), /^Prompts in this chat: 23\./);
    assert.match(await s.page.locator("#cd-keys-list").textContent(), /Alt ↑The prompt beforeAlt ↓The next prompt/, "in the shortcuts list");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the prompt rail on a long chat opened on its latest pages: every prompt listed from its outline, and a jump to an early one loads the pages before it first", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen({ width: 900, height: 700 });
  try {
    const { P, messages } = railChat(25);
    await s.send({ type: "opened", conversation: conversation(), messages: messages.slice(40), earlier: 40, busy: false });
    await s.frame();
    assert.deepEqual(await railState(s.page).then((r) => [r.shown, r.ticks]), [true, 5], "what's on screen, until the outline comes");
    await hoverRail(s.page);
    assert.match(await s.page.locator("#cd-rail-card .cd-rail-more").innerText(), /Earlier messages aren't listed yet/);
    await s.page.mouse.move(100, 100);
    await s.page.waitForTimeout(250);
    const outline = [];
    for (let i = 0; i < 25; i++) {
      const w = messages[2 * i + 1].widgets;
      outline.push({ id: P(2 * i), text: messages[2 * i].text, created_at: messages[2 * i].created_at,
                     ...(w.length ? { widgets: w.map(({ html, ...x }) => ({ ...x, message_id: P(2 * i + 1) })) } : {}) });
    }
    await s.send({ type: "outline", conversation: ID, prompts: outline });
    await s.frame();
    assert.equal((await railState(s.page)).ticks, 25, "every prompt");
    assert.equal((await railState(s.page)).now, 24);
    await hoverRail(s.page);
    const card = s.page.locator("#cd-rail-card");
    assert.equal(await card.locator(".cd-rail-row").count(), 25);
    assert.equal(await card.locator(".cd-rail-more").count(), 0);
    assert.deepEqual(await card.locator(".cd-rail-widget").allInnerTexts(), ["EMI calculator", "Widget 7"], "the widgets of replies not on screen too");
    await card.locator(".cd-rail-row").nth(3).click();
    assert.deepEqual((await s.posted("earlier")).map((m) => m.before), [P(40)], "the page before what's shown");
    await s.send({ type: "earlier", messages: messages.slice(20, 40), earlier: 20 });
    assert.deepEqual((await s.posted("earlier")).map((m) => m.before), [P(40), P(20)], "not there yet: the next");
    await s.send({ type: "earlier", messages: messages.slice(0, 20), earlier: 0 });
    await s.page.waitForTimeout(450);
    const top = await promptTop(s.page, P(6));
    assert.ok(top !== null && top >= 0 && top < 0.12, `there, near the top (${top})`);
    assert.equal(await s.page.locator(`.cd-msg[data-id="${P(6)}"] .cd-bubble`).evaluate((n) => n.classList.contains("cd-flash")), true);
    assert.equal((await railState(s.page)).now, 3);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the prompt rail for a very long chat closes its ticks up and shows a window around where you are; shorter ticks at side-bar width; still for less motion", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, motion] of [[900, false], [460, true]]) {
    const s = await openScreen({ width, height: 700, reducedMotion: motion });
    try {
      const { P, messages } = railChat(80);
      await s.send({ type: "opened", conversation: conversation(), messages, earlier: 0, busy: false });
      await s.frame();
      const look = await s.page.evaluate(() => {
        const ticks = document.querySelector(".cd-rail-ticks"), all = [...ticks.children], sc = document.getElementById("cd-scroll");
        return { windowed: ticks.classList.contains("windowed"), height: ticks.getBoundingClientRect().height, half: sc.clientHeight / 2,
                 pitch: all[1].getBoundingClientRect().top - all[0].getBoundingClientRect().top, width: all[0].getBoundingClientRect().width,
                 nowShown: (() => { const n = ticks.querySelector(".now").getBoundingClientRect(), b = ticks.getBoundingClientRect(); return n.top >= b.top && n.bottom <= b.bottom; })() };
      });
      assert.equal(look.windowed, true, `${width}px: a window, faded at both ends`);
      assert.ok(look.height <= look.half + 1, "no taller than half the transcript");
      assert.equal(look.pitch, 4, "4px apart at the closest");
      assert.equal(look.width, width === 900 ? 16 : 10, "shorter at side-bar width");
      assert.equal(look.nowShown, true, "the bright one in the window");
      if (motion) {
        // Less motion: a jump is instant.
        await s.page.locator("#cd-input").focus();
        for (let i = 0; i < 5; i++) await s.page.keyboard.press("Alt+ArrowUp");
        const top = await promptTop(s.page, P(148));
        assert.ok(top >= 0 && top < 0.12, `five prompts up, there at once, without easing (${top})`);
        await s.frame();
        assert.equal((await railState(s.page)).now, 74);
      }
      assert.equal(await s.page.evaluate(() => document.scrollingElement.scrollWidth - document.scrollingElement.clientWidth), 0);
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  }
});
