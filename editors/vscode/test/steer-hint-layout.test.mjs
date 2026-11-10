// The prompt box stays where it is when a turn starts and ends. While a turn runs, a line under the box says
// "Enter to steer · Alt+Enter to queue" (or "Follow-ups queue for the next turn"); that line's room is kept when it
// has nothing to say, so the box never jumps up on send and back down at the end. A layout fact, so it is checked in
// real Chromium: the box's top and the footer's height, idle, running and after, at a wide panel and a 300 px side bar,
// in both themes; and the line is one line however narrow, so a wrap can't move the box either.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";
import { messageQueueJs } from "./support/webview-dom.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
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

async function openPage({ width, theme, steering, hello = true, height = 700 }) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, messageQueueJs + "\n" + markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const event = (e) => send({ type: "event", event: e });
  const greet = async () => { await send({ type: "session_ready", sessionId: "s1" });
  await event({ type: "ready", capabilities: { history_snapshot: true, ...(steering ? { live_steering: true, steering_native: true } : {}) },
    model: "qwen3.8:27b", mode: "default", think: "off", commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" }); };
  if (hello) await greet();
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 120)))));
  const measure = () => page.evaluate(() => {
    const box = document.getElementById("cbox").getBoundingClientRect();
    const hint = document.getElementById("followup-hint");
    const footer = hint.closest("footer").getBoundingClientRect();
    const h = hint.getBoundingClientRect();
    return { boxTop: Math.round(box.top * 10) / 10, boxBottom: Math.round(box.bottom * 10) / 10, footer: Math.round(footer.height * 10) / 10,
      hintHeight: Math.round(h.height * 10) / 10, shown: getComputedStyle(hint).visibility === "visible" && h.height > 0,
      text: hint.textContent, lines: Math.round((h.height - parseFloat(getComputedStyle(hint).paddingTop)) / parseFloat(getComputedStyle(hint).lineHeight)) };
  });
  return { page, event, settle, measure, errors, greet };
}

for (const [width, theme] of [[700, "dark-modern"], [300, "light-modern"], [700, "light-modern"], [300, "dark-modern"]]) {
  for (const steering of [true, false]) {
    test(`the prompt box keeps its place when a turn starts and ends (${width}px, ${theme}, ${steering ? "steering" : "queue only"})`, async (t) => {
      if (skipOrFail(t)) return;
      const s = await openPage({ width, theme, steering });
      try {
        await s.settle();
        const idle = await s.measure();
        assert.equal(idle.shown, false, "nothing to say before a turn");
        await s.event({ type: "turn_start", turn_id: "t1", prompt: "Plan the release", kind: "prompt" });
        await s.event({ type: "text_delta", text: "Working on it." });
        await s.settle();
        const running = await s.measure();
        assert.equal(running.shown, true, "the line shows while the turn runs");
        assert.equal(running.text, steering ? "Enter to steer · Alt+Enter to queue" : "Follow-ups queue for the next turn");
        assert.equal(running.boxTop, idle.boxTop, `the box didn't move on send (idle ${idle.boxTop}, running ${running.boxTop})`);
        assert.equal(running.footer, idle.footer, "the footer kept its height");
        await s.event({ type: "stream_end", message_id: "t1:1", phase: "answer" });
        await s.event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:1" });
        await s.settle();
        const done = await s.measure();
        assert.equal(done.shown, false, "the line goes when the turn ends");
        assert.equal(done.boxTop, idle.boxTop, "and the box stays put then too");
        assert.deepEqual(s.errors, []);
      } finally { await s.page.close(); }
    });
  }
}

test("the line is one line however narrow the panel, so a wrap can't move the box", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 220, theme: "dark-modern", steering: true });
  try {
    await s.settle();
    const idle = await s.measure();
    await s.event({ type: "turn_start", turn_id: "t1", prompt: "Plan", kind: "prompt" });
    await s.settle();
    const running = await s.measure();
    assert.equal(running.lines, 1, `one line (${running.hintHeight}px)`);
    assert.equal(running.boxTop, idle.boxTop);
  } finally { await s.page.close(); }
});

test("the box is where it will be before the backend says hello, not 16 px lower until it does", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [700, 320]) {
    const s = await openPage({ width, theme: "dark-modern", steering: true, hello: false });
    try {
      await s.settle();
      const before = await s.measure();
      await s.greet();
      await s.settle();
      const after = await s.measure();
      assert.equal(after.boxTop, before.boxTop, `${width}px: the hint's room is one line even with no words yet`);
    } finally { await s.page.close(); }
  }
});

test("a short panel keeps its rows for the transcript: no line at all, and the box still doesn't move", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ width: 520, height: 308, theme: "dark-modern", steering: true });
  try {
    await s.settle();
    const idle = await s.measure();
    await s.event({ type: "turn_start", turn_id: "t1", prompt: "Plan", kind: "prompt" });
    await s.settle();
    const running = await s.measure();
    assert.deepEqual([idle.hintHeight, running.hintHeight], [0, 0], "no room taken");
    assert.equal(running.boxTop, idle.boxTop);
  } finally { await s.page.close(); }
});
