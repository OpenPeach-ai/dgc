// A finished background agent's line in a real browser: one quiet row that Enter and Space open and
// close from the keyboard, a focus ring on it and on Open in agent map, the report readable in every
// theme, and nothing wider than the panel at side-bar width. agent-report-line.test.mjs has the
// behaviour; this is what only Chromium can say. DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a
// failure instead of a skip.
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

const REPORT = "Sub-task 'Review billing.py' completed and integrated 2 path(s): billing.py, test_billing.py.\nSummary:\n"
  + "The rounding bug is in `total()`: it rounded each line.\n\n- Fixed it to round once.\n- Added a test.\nFILES: billing.py, test_billing.py";
const LONG = "Audit every settings surface for keyboard reachability, contrast in all four themes and what the screen reader announces";
function scene(description = "Review billing.py") {
  return [
    { type: "turn_start", turn_id: "t1", prompt: "Review billing in the background", kind: "prompt" },
    { type: "tool_call", call_id: "call_1", name: "task", args: { description, background: true }, summary: description },
    { type: "agent_started", id: sid(1), parent_id: null, call_id: "call_1", description, depth: 1, state: "running",
      started_at: 1, isolated: true, parallel: false, background: true },
    { type: "tool_result", call_id: "call_1", name: "task", is_error: false, is_diff: false,
      output: `Sub-task '${description}' is running in the background (id ${sid(1)}).` },
    { type: "text_delta", text: "A helper is on it." }, { type: "stream_end", message_id: "t1:1", phase: "answer" },
    { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:1" },
    { type: "agent_ended", id: sid(1), state: "finished", duration_ms: 4000, tool_calls: 3, message: "The rounding bug is in total()." },
    { type: "turn_start", turn_id: "t2", prompt: description, kind: "wake" },
    { type: "agent_report", turn_id: "t2", id: sid(1), description, report: REPORT, integrated: true },
    { type: "text_delta", text: "The helper fixed the rounding." }, { type: "stream_end", message_id: "t2:1", phase: "answer" },
    { type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0, final_message_id: "t2:1" },
  ];
}
async function open(options = {}) {
  const page = await openAgentLines(browser, options);
  await page.evaluate(() => window.__event({ type: "ready", version: "0.48.0", protocol_version: 14,
    capabilities: { agents: true, history_snapshot: true, agent_reports: 1 }, model: "m", mode: "auto", think: "off",
    base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [], custom_commands: [],
    goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" }));
  await sendEvents(page, options.scene || scene());
  await settle(page);
  return page;
}
const state = (page) => page.evaluate(() => {
  const line = document.querySelector("#log .handback-line");
  const toggle = line.querySelector(".handback-toggle"), body = line.querySelector(".handback-body");
  const box = toggle.getBoundingClientRect();
  return { expanded: toggle.getAttribute("aria-expanded"), shown: !!body.offsetParent, height: box.height,
    lineHeight: parseFloat(getComputedStyle(toggle).lineHeight), chevron: getComputedStyle(toggle.querySelector(".handback-chevron"), "::after").content,
    focused: document.activeElement === toggle, outline: getComputedStyle(toggle).outlineStyle };
});

test("Enter and Space open and close it from the keyboard, with a visible focus ring", async (t) => {
  if (skipOrFail(t)) return;
  const page = await open();
  try {
    await page.focus("#log .handback-toggle");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");                                  // keyboard focus: :focus-visible
    let now = await state(page);
    assert.equal(now.focused, true);
    assert.notEqual(now.outline, "none", "a focus ring");
    assert.deepEqual([now.expanded, now.shown, now.chevron], ["false", false, '"›"']);
    assert.ok(now.height <= now.lineHeight + 2, `one row, folded (${now.height}px)`);
    await page.keyboard.press("Enter");
    now = await state(page);
    assert.deepEqual([now.expanded, now.shown, now.chevron], ["true", true, '"⌄"']);
    await page.keyboard.press(" ");
    now = await state(page);
    assert.deepEqual([now.expanded, now.shown], ["false", false]);
    // Open again, then Tab through the report to Open in agent map and press it.
    await page.keyboard.press("Enter");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      if (await page.evaluate(() => document.activeElement?.classList.contains("handback-map"))) break;
    }
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Open in agent map", "reachable by keyboard");
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), "none");
    await page.keyboard.press("Enter");
    await settle(page);
    assert.equal(await page.evaluate(() => document.getElementById("agent-card").hidden), false, "the agent's card in the map");
    assert.equal(await page.evaluate(() => document.getElementById("agent-card-title").textContent), "Review billing.py");
  } finally {
    await page.close();
  }
});

test("the folded line reads as the note did, and the report is readable in every theme", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern", "light-plus", "hc"]) {
    const page = await open({ theme });
    try {
      await page.click("#log .handback-toggle");
      await page.mouse.move(1, 1);                                   // not hovered: its resting colour
      await settle(page);
      const got = await page.evaluate((source) => {
        const contrast = (node) => Math.round(eval(source)(node) * 100) / 100;
        const colourOf = (value) => { const p = document.createElement("span"); p.style.color = value; document.body.appendChild(p);
          const c = getComputedStyle(p).color; p.remove(); return c; };
        const line = document.querySelector("#log .handback-line");
        const answer = line.querySelector(".handback-answer li"), map = line.querySelector(".handback-map");
        const note = line.querySelector(".agent-page-outcome");
        return { label: getComputedStyle(line.querySelector(".handback-label")).color, faint: colourOf("var(--faint)"),
          answer: contrast(answer), map: contrast(map), note: contrast(note) };
      }, CONTRAST_SOURCE);
      assert.equal(got.label, got.faint, `${theme}: as quiet as the wake note it replaces`);
      assert.ok(got.answer >= 4.5, `${theme}: the report's words ${got.answer}:1`);
      assert.ok(got.map >= 4.5, `${theme}: Open in agent map ${got.map}:1`);
      assert.ok(got.note >= 3, `${theme}: the integration note ${got.note}:1`);
    } finally {
      await page.close();
    }
  }
});

test("at side-bar width a long name wraps in its own column and nothing is wider than the panel", async (t) => {
  if (skipOrFail(t)) return;
  const page = await open({ width: 300, scene: scene(LONG) });
  try {
    await page.click("#log .handback-toggle");
    await settle(page);
    const got = await page.evaluate(() => {
      const log = document.getElementById("log"), line = log.querySelector(".handback-line");
      const label = line.querySelector(".handback-label").getBoundingClientRect();
      const icon = line.querySelector(".note-icon").getBoundingClientRect();
      const body = line.querySelector(".handback-body").getBoundingClientRect();
      return { overflow: Math.max(log.scrollWidth - log.clientWidth, document.documentElement.scrollWidth - window.innerWidth),
        labelLeft: label.left, iconRight: icon.right, bodyLeft: body.left, iconLeft: icon.left, bodyRight: body.right, logRight: log.getBoundingClientRect().right };
    });
    assert.ok(got.overflow <= 0, `no sideways scroll (${got.overflow}px)`);
    assert.ok(got.labelLeft >= got.iconRight, "the words keep their column beside the icon");
    assert.ok(got.bodyLeft > got.iconLeft, "the report sits under the line, indented");
    assert.ok(got.bodyRight <= got.logRight, "and inside the panel");
  } finally {
    await page.close();
  }
});
