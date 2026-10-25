// Run in background as laid out by a real browser: on an agent's line the button sits right after the sentence (not at
// the far edge of a wide tab) and the line keeps its one-line height; with several agents the choice wraps inside the
// panel, never past it; on a running command's row it shares the head's one line with Copy. Readable in the dark and
// light themes. DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure instead of a skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { CONTRAST_SOURCE, openAgentLines, sendEvents, settle, sid } from "./support/agent-lines-scene.mjs";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const READY = { type: "ready", version: "0.48.0", protocol_version: 14,
  capabilities: { agents: true, history_snapshot: true, agent_control: true, agent_control_foreground: true, background_now: { version: 1 } },
  model: "qwen3.8:27b", mode: "auto", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true,
  commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" };
const spawn = (n, description) => ({ type: "tool_call", call_id: `call_${n}`, name: "task", args: { description }, summary: "" });
const start = (n, description, parallel = false) => ({ type: "agent_started", id: sid(n), parent_id: null, call_id: `call_${n}`,
  description, depth: 1, state: "running", started_at: n, isolated: true, parallel });

function measure(contrastSource) {
  const contrast = (node) => Math.round(eval(contrastSource)(node) * 100) / 100;
  const log = document.getElementById("log");
  return {
    overflow: Math.max(log.scrollWidth - log.clientWidth, document.documentElement.scrollWidth - window.innerWidth),
    lines: [...log.querySelectorAll(".agent-line")].map((line) => {
      const text = line.querySelector(".agent-line-text").getBoundingClientRect();
      const move = line.querySelector(".agent-line-move");
      const buttons = move ? [...move.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom, contrast: contrast(b) };
      }) : [];
      return { height: line.getBoundingClientRect().height, textRight: text.right, textHeight: text.height,
        lineHeight: parseFloat(getComputedStyle(line.querySelector(".agent-line-text")).lineHeight),
        logRight: log.getBoundingClientRect().right, buttons };
    }),
    rows: [...log.querySelectorAll('.tool[data-tool-name="bash"]')].map((card) => {
      const head = card.querySelector(".head").getBoundingClientRect();
      const b = card.querySelector("button.run-bg");
      const r = b && !b.hidden ? b.getBoundingClientRect() : null;
      return { headHeight: head.height, headRight: head.right, button: r && { left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        contrast: contrast(b), label: b.textContent } };
    }),
  };
}

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: an agent's Run in background sits after its sentence and keeps the line one line tall`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await openAgentLines(browser, { width: 900, theme,
      events: [READY, { type: "turn_start", turn_id: "t1", prompt: "go" }, spawn(1, "Map the auth module"), start(1, "Map the auth module")] });
    try {
      await page.evaluate(() => new Promise((done) => setTimeout(done, 2200)));     // past "started working"
      await settle(page);
      const m = await page.evaluate(measure, CONTRAST_SOURCE);
      const [line] = m.lines;
      assert.equal(line.buttons.length, 1);
      const [button] = line.buttons;
      assert.equal(button.label, "Run in background");
      assert.ok(button.left - line.textRight <= 12, `right after the sentence (gap ${button.left - line.textRight}px)`);
      assert.ok(button.right < line.logRight - 100, "not pushed to the far edge of a wide tab");
      assert.ok(line.height <= line.lineHeight + 12, `one line tall (${line.height}px for a ${line.lineHeight}px line)`);
      assert.ok(button.contrast >= 4.5, `readable (${button.contrast}:1)`);
      assert.equal(m.overflow, 0);
    } finally { await page.close(); }
  });
}

test("narrow side bar: a batch's choice wraps inside the panel, every button whole", async (t) => {
  if (skipOrFail(t)) return;
  const names = ["Survey the parser", "Survey the lexer", "Survey the printer"];
  const page = await openAgentLines(browser, { width: 300,
    events: [READY, { type: "turn_start", turn_id: "t1", prompt: "split" }, ...names.map((d, i) => spawn(i + 1, d)),
      ...names.map((d, i) => start(i + 1, d, true))] });
  try {
    await page.evaluate(() => document.querySelector("#log .agent-line .agent-line-move button").click());
    await settle(page);
    const m = await page.evaluate(measure, CONTRAST_SOURCE);
    const labels = m.lines[0].buttons.map((b) => b.label);
    assert.deepEqual(labels, [...names, "All", "Cancel"]);
    for (const b of m.lines[0].buttons) assert.ok(b.right <= m.lines[0].logRight + 0.5, `${b.label} stays in the panel`);
    assert.equal(m.overflow, 0, "nothing scrolls sideways");
  } finally { await page.close(); }
});

test("a running command's row: Run in background shares the head's one line, in a narrow panel too", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [900, 320]) {
    const page = await openAgentLines(browser, { width,
      events: [READY, { type: "turn_start", turn_id: "t1", prompt: "build" },
        { type: "tool_call", call_id: "b1", name: "bash", args: { command: "npm test -- --runInBand" }, summary: "npm test -- --runInBand" }] });
    try {
      const before = (await page.evaluate(measure, CONTRAST_SOURCE)).rows[0];
      assert.equal(before.button, null, "not in the first moment");
      await page.evaluate(() => new Promise((done) => setTimeout(done, 1700)));
      await settle(page);
      const m = await page.evaluate(measure, CONTRAST_SOURCE);
      const row = m.rows[0];
      assert.ok(row.button, `offered after a moment (${width}px)`);
      assert.equal(row.button.label, "Run in background");
      assert.ok(row.headHeight <= before.headHeight + 2, `the head stays one line (${before.headHeight} -> ${row.headHeight}px at ${width}px)`);
      assert.ok(row.button.right <= row.headRight + 0.5, "inside the row");
      assert.ok(row.button.contrast >= 4.5, `readable (${row.button.contrast}:1)`);
      assert.equal(m.overflow, 0);
    } finally { await page.close(); }
  }
});
