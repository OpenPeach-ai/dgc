// ChatDGC: the moment you press Enter (seen in testing: "nothing happens unless the model actually loads, and then it
// starts saying Thinking"). Your message shows at once, marked as sending, and under it a reply waiting for the model
// with its clock, as Work's turn does; the backend's usual wait for that model joins it; the model's first part
// (thinking, words, a search) takes over; a send refused before it started says so with Retry, your text back in the
// box; Stop works from the first moment; a chat opened mid-wait shows the reply waiting, never an empty bubble.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { THEMES } from "./support/options-scene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  if (browser) return false;
  const reason = chromium ? "Chromium could not start" : "playwright is not installed (npm ci at the repository root)";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

const ID = `chat_${"a".repeat(32)}`;
const M = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`;
function screenHtml() {
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const doc = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1]
    .replace(/<link [^>]*>/g, "").replace(/<script\b[^>]*><\/script\s*>/gi, "").replace(/\$\{[^}]*\}/g, "");
  const css = readFileSync(join(root, "media/main.css"), "utf8").replace(/@import[^;]*;/, "");
  const own = readFileSync(join(root, "media/chatdgc.css"), "utf8");
  const scripts = [...doc.matchAll(/asset\("media\/([\w-]+\.js)"\)/g)].map((m) => m[1]);
  const js = [...source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1].matchAll(/asset\("media\/([\w-]+\.js)"\)/g)]
    .map((m) => readFileSync(join(root, "media", m[1]), "utf8")).join("\n");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife",
    globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  void scripts;
  return { html: doc.replace("</head>", `<style>${css}</style><style>${own}</style></head>`), js, markdownJs };
}
async function openScreen(theme = "dark-modern", width = 700) {
  const { html, js, markdownJs } = screenHtml();
  const page = await browser.newPage({ viewport: { width, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([code, md]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
  }, [js, markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => !t || m.type === t), type);
  const frame = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const text = (selector) => page.evaluate((s) => [...document.querySelectorAll(s)].map((n) => n.textContent.replace(/\s+/g, " ").trim()), selector);
  return { page, send, posted, frame, text, errors };
}
const conversation = { id: ID, title: "New chat", model: null, thinking: null, pinned: false, archived: false, temporary: false };

for (const theme of ["dark-modern", "light-modern"]) {
  test(`Enter shows your message and a reply waiting for the model at once, then the model takes over (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openScreen(theme);
    try {
      await s.send({ type: "opened", conversation, messages: [], earlier: 0, busy: false });
      await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "qwen3:32b"], current: "deepseek-v4.1-flash:cloud" });
      await s.page.locator("#cd-input").fill("Plan a week in Goa");
      await s.page.keyboard.press("Enter");
      await s.frame();
      // Nothing from the backend yet: the screen drew both itself.
      assert.deepEqual(await s.text(".cd-user .cd-bubble"), ["Plan a week in Goa"]);
      assert.deepEqual(await s.text(".cd-sending-note"), ["Sending…"]);
      const line = await s.text(".cd-assistant .cd-waiting");
      assert.match(line[0], /^Waiting for deepseek-v4\.1-flash:cloud… \(0s\)$/);
      await s.page.waitForTimeout(2100);
      assert.match((await s.text(".cd-waiting .cd-wait-meta"))[0], /^\(2s\)$/, "its clock runs");
      if (process.env.DGC_SHOTS) await s.page.screenshot({ path: `${process.env.DGC_SHOTS}/chatdgc-waiting-${theme}.png` });
      // The backend has it: your message as kept, the turn, and the model's usual wait.
      await s.send({ type: "turn", state: "started", replyId: M(2) });
      await s.send({ type: "message", message: { id: M(1), role: "user", text: "Plan a week in Goa", created_at: new Date().toISOString() } });
      await s.send({ type: "waiting", messageId: M(2), model: "deepseek-v4.1-flash:cloud", usual_s: 11.3 });
      await s.frame();
      assert.deepEqual(await s.text(".cd-sending-note"), [], "sent: no longer marked");
      assert.equal((await s.text(".cd-user")).length, 1, "one bubble: the backend's took the place of the screen's");
      assert.match((await s.text(".cd-waiting .cd-wait-meta"))[0], /^\(2s · usually starts within 12s\)$/, "the clock kept running");
      assert.equal(await s.page.locator(`.cd-msg[data-id="${M(2)}"] .cd-waiting`).count(), 1, "the waiting reply is the turn's reply");
      // The model starts thinking: Thinking takes over, then its words.
      await s.send({ type: "delta", messageId: M(2), thinking: "Beaches first. " });
      await s.frame();
      assert.equal(await s.page.locator(".cd-waiting").count(), 0);
      assert.equal(await s.page.locator(".cd-assistant .cd-thinking-label").count(), 1);
      await s.send({ type: "delta", messageId: M(2), text: "Day one: the beaches." });
      await s.frame();
      assert.match((await s.text(".cd-assistant"))[0], /Day one: the beaches\./);
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

test("a search first: the waiting line becomes the search", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation, messages: [], earlier: 0, busy: false });
    await s.page.locator("#cd-input").fill("Weather in Paris?");
    await s.page.keyboard.press("Enter");
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    await s.send({ type: "activity", messageId: M(2), kind: "searching", text: "paris weather" });
    await s.frame();
    assert.equal(await s.page.locator(".cd-waiting").count(), 0);
    assert.match((await s.text(".cd-assistant .cd-activity"))[0], /Searching the web for “paris weather”/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a send refused before it started: a short error with Retry, your text back in the box", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation, messages: [], earlier: 0, busy: false });
    await s.page.locator("#cd-input").fill("Summarise my notes");
    await s.page.keyboard.press("Enter");
    await s.send({ type: "error", message: "No model is set up yet. Choose one in Settings." });
    await s.frame();
    assert.equal(await s.page.locator("#cd-input").inputValue(), "Summarise my notes", "back in the box");
    assert.deepEqual(await s.text(".cd-user"), [], "the bubble goes with it");
    assert.match((await s.text(".cd-send-failed"))[0], /^Didn't send: No model is set up yet\. Choose one in Settings\. Retry$/);
    assert.equal(await s.page.locator(".cd-waiting").count(), 0);
    await s.page.locator(".cd-send-failed .cd-retry").click();
    const sends = await s.posted("send");
    assert.equal(sends.length, 2);
    assert.equal(sends[1].text, "Summarise my notes");
    assert.equal(await s.page.locator("#cd-input").inputValue(), "", "sent again from the card");
    assert.equal(await s.page.locator(".cd-send-failed").count(), 0);
    assert.equal(await s.page.locator(".cd-waiting").count(), 1, "waiting again");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("Stop works from the first moment, before the backend has started the reply", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation, messages: [], earlier: 0, busy: false });
    await s.page.locator("#cd-input").fill("Write a long story");
    await s.page.keyboard.press("Enter");
    assert.equal(await s.page.locator("#cd-stop").isVisible(), true);
    await s.page.locator("#cd-stop").click();
    assert.equal((await s.posted("stop")).length, 1);
    await s.send({ type: "turn", state: "started", replyId: M(2) });
    assert.equal((await s.posted("stop")).length, 2, "said again once the reply exists, so it stops for sure");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a chat opened mid-wait shows its reply waiting, with how long it has waited, never an empty bubble", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await s.send({ type: "opened", conversation: { ...conversation, title: "Goa" }, earlier: 0, busy: true, replyId: M(2),
      messages: [{ id: M(1), role: "user", text: "Plan Goa" },
                 { id: M(2), role: "assistant", text: "", thinking: "", waiting: { model: "glm-5.3:cloud", usual_s: 0, elapsed_s: 7.4 } }] });
    await s.frame();
    assert.match((await s.text(".cd-assistant .cd-waiting"))[0], /^Waiting for glm-5\.3:cloud… \(7s\)$/);
    assert.equal(await s.page.locator(".cd-assistant .cd-reply:empty, .cd-assistant .cd-text:empty").count(), 0);
    // An older DGC sends the busy chat without the reply: it still shows waiting.
    await s.send({ type: "opened", conversation: { ...conversation, title: "Goa", model: "qwen3:32b" }, earlier: 0, busy: true, replyId: M(3),
      messages: [{ id: M(1), role: "user", text: "Plan Goa" }] });
    await s.frame();
    assert.match((await s.text(".cd-assistant .cd-waiting"))[0], /^Waiting for qwen3:32b…/);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
