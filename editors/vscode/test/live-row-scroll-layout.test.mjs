// Work: scrolling up near the live "Thinking (58s · 1m 32s · ~6–34 min left · ↓ 7617 tok)" line (seen in testing:
// "it flickers and don't scroll up"). Measured in Chromium with real wheel events while the turn's clocks tick and
// its thinking streams:
// - a person's own scroll up always wins: following stops at once, however small the scroll (a trackpad's few
//   pixels at a time), and nothing pulls the view back down until they come back to the bottom themselves;
// - the live row never changes the layout's height as its numbers tick: one line, at every panel width.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

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

async function longTurn(width, theme = "dark-modern") {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 720 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), event);
  await send({ type: "ready", version: "0.51.0", protocol_version: 14, capabilities: {}, model: "glm-5.3:cloud", mode: "default",
    think: "high", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
  await send({ type: "turn_start", turn_id: "t1", prompt: "Plan the billing migration" });
  const para = "The migration touches the invoices, the ledger and the reports, so the order of the steps matters a great deal. ";
  for (let i = 0; i < 12; i += 1) await send({ type: "text_delta", text: `${para.repeat(4)}\n\n` });
  await send({ type: "turn_activity", turn_id: "t1", state: "thinking", label: "Thinking", detail: "" });
  await send({ type: "turn_eta", label: "~6–34 min left" });
  // The turn has been going a while: two clocks, and big numbers.
  await page.evaluate(() => { const real = Date.now; const skew = 92_000; Date.now = () => real() + skew; });
  await send({ type: "turn_activity", turn_id: "t1", state: "thinking", label: "Thinking", detail: "" });
  await page.waitForTimeout(400);
  return { page, send, errors };
}

const metrics = (page) => page.evaluate(() => {
  const log = document.getElementById("log"), row = document.querySelector(".msg.dgc .thinking:not(.done)");
  return { top: log.scrollTop, max: log.scrollHeight - log.clientHeight, rowH: row ? row.getBoundingClientRect().height : 0,
    rowText: row?.textContent || "" };
});

for (const width of [360, 460, 600, 900]) {
  test(`${width}px: a small scroll up near the live row stays where the person put it while the turn ticks and streams`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, send, errors } = await longTurn(width);
    try {
      const start = await metrics(page);
      assert.ok(start.max > 400, "the transcript scrolls");
      assert.ok(Math.abs(start.top - start.max) < 2, "following the end");
      // A trackpad: a few pixels at a time, starting at the bottom, with the clocks ticking and thinking streaming.
      const box = await page.locator("#log").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height - 80);
      let streamed = 0;
      for (let i = 0; i < 12; i += 1) {
        await page.mouse.wheel(0, -4);
        await page.waitForTimeout(60);
        await send({ type: "thinking_delta", text: `step ${i} of the plan, checked against the ledger. ` });
        streamed += 1;
      }
      await page.waitForTimeout(700);                      // ticks of the live row's clocks
      const after = await metrics(page);
      assert.ok(after.top < after.max - 30, `the person's scroll up held: ${after.top} of ${after.max} after ${streamed} parts`);
      // And it keeps holding through more ticks and parts.
      const held = after.top;
      for (let i = 0; i < 5; i += 1) { await send({ type: "thinking_delta", text: "more. " }); await page.waitForTimeout(250); }
      const later = await metrics(page);
      assert.ok(Math.abs(later.top - held) < 2, `nothing pulled the view back down (${held} → ${later.top})`);
      // Back at the bottom by their own scroll: following again.
      await page.mouse.wheel(0, 5000);
      await page.waitForTimeout(300);
      await send({ type: "text_delta", text: "And the reports come last. ".repeat(30) });
      await page.waitForTimeout(300);
      const end = await metrics(page);
      assert.ok(Math.abs(end.top - end.max) < 2, "following again once back at the end");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });

  test(`${width}px: the live row stays one line, its height never changing as its numbers tick`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, send, errors } = await longTurn(width);
    try {
      const heights = new Set(), seen = [];
      for (let i = 0; i < 16; i += 1) {
        if (i === 6) await send({ type: "turn_eta", label: "~12–48 min left" });
        if (i === 10) await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 3_600_000; });
        await send({ type: "thinking_delta", text: "x".repeat(997) });
        await page.waitForTimeout(210);
        const m = await metrics(page);
        heights.add(Math.round(m.rowH)); seen.push(m.rowText);
      }
      assert.equal(heights.size, 1, `one height as it ticks: ${[...heights]} (${seen.at(-1)})`);
      const one = await page.evaluate(() => {
        const row = document.querySelector(".msg.dgc .thinking:not(.done)");
        return Math.round(row.getBoundingClientRect().height) <= Math.ceil(parseFloat(getComputedStyle(row).lineHeight) + 2);
      });
      assert.ok(one, "a single line");
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}
