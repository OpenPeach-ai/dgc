// A new session isn't a blank window: DGC's mark (the three slashes) sits in the middle of the empty transcript, muted;
// the first message takes its place and it doesn't come back. Checked in real Chromium from
// computed style: where the mark is laid out, its size and shape, a colour that's quiet in both themes and never the
// accent, a short fade so a resumed chat whose history arrives at once doesn't flash it, and none under reduced motion.
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

async function openPage({ width = 700, theme = "dark-modern", reducedMotion = "no-preference" } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 700 }, reducedMotion });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, messageQueueJs + "\n" + markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const event = (e) => send({ type: "event", event: e });
  await send({ type: "session_ready", sessionId: "s1" });
  await event({ type: "ready", capabilities: { history_snapshot: true }, model: "qwen3.8:27b", mode: "default", think: "off",
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
  const mark = () => page.evaluate(() => {
    const log = document.getElementById("log"), s = getComputedStyle(log), m = getComputedStyle(log, "::before");
    const parse = (c) => (c.match(/[\d.]+/g) || []).map(Number);
    return { content: m.content, display: m.display, width: m.width, height: m.height, mask: m.webkitMaskImage || m.maskImage,
      color: m.backgroundColor, rgba: parse(m.backgroundColor), animation: m.animationName, delay: m.animationDelay,
      justify: s.justifyContent, align: s.alignItems, children: log.children.length,
      accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() };
  });
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80)))));
  return { page, event, mark, settle, errors };
}

for (const [width, theme] of [[700, "dark-modern"], [300, "light-modern"], [700, "light-modern"], [300, "dark-modern"]]) {
  test(`a new session shows DGC's mark, muted, in the middle (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openPage({ width, theme });
    try {
      await s.settle();
      const m = await s.mark();
      assert.equal(m.children, 0, "a new session's transcript is empty");
      assert.notEqual(m.content, "none", "the mark is there");
      assert.equal(m.display, "block");
      assert.equal(m.width, "44px"); assert.equal(m.height, "44px");
      assert.match(m.mask, /svg/, "drawn from the mark's own shape");
      assert.equal(m.justify, "center"); assert.equal(m.align, "center");
      const [, , , alpha = 1] = m.rgba;
      assert.ok(alpha > 0.08 && alpha <= 0.3, `quiet: a faint wash of the text colour (${m.color})`);
      assert.ok(!/124,\s*92,\s*255|118,\s*84,\s*246/.test(m.color), "never the accent");
      assert.equal(m.animation, "dgc-empty-mark", "it fades in");
      assert.notEqual(m.delay, "0s", "after a moment, so restored history never flashes it");
      await s.event({ type: "turn_start", turn_id: "t1", prompt: "Plan the release", kind: "prompt" });
      await s.event({ type: "text_delta", text: "Working on it." });
      await s.settle();
      const after = await s.mark();
      assert.ok(after.children > 0);
      assert.ok(after.content === "none" || after.display === "none", "the first message takes its place");
      assert.equal(after.justify, "normal", "and the transcript lays out as before");
      assert.deepEqual(s.errors, []);
    } finally { await s.page.close(); }
  });
}

test("under reduced motion the mark just appears", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openPage({ reducedMotion: "reduce" });
  try {
    await s.settle();
    const m = await s.mark();
    assert.notEqual(m.content, "none");
    assert.equal(m.animation, "none");
  } finally { await s.page.close(); }
});
