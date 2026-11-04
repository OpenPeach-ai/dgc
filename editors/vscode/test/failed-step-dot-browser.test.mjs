import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openThinkingPage } from "./render-thinking.mjs";

// A failed step's dot says it failed, in real Chromium, live and after a reload. Release check, 2026-11-03: a batch
// of helpers that named none read "Couldn't delegate", and its dot was round and olive, which read as a step that
// worked (olive is the error colour, and also auto mode's). It is a small cross now; a step that worked keeps its
// round dot. DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure.
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

const TURN = [
  { type: "turn_start", turn_id: "t1", prompt: "Call the task tool with an empty tasks list.", kind: "prompt" },
  { type: "tool_call", call_id: "call_0", name: "task", args: { tasks: [] }, summary: "" },
  { type: "tool_result", call_id: "call_0", name: "task", is_error: true, is_diff: false,
    output: "error: tasks needs at least 2 helpers; for one helper pass description and prompt instead of tasks." },
  { type: "tool_call", call_id: "call_1", name: "read_file", args: { path: "README.md" }, summary: "README.md" },
  { type: "tool_result", call_id: "call_1", name: "read_file", is_error: false, is_diff: false, output: "# Garden" },
  { type: "text_delta", text: "The task tool refused the call." },
  { type: "stream_end", message_id: "t1:1", phase: "answer" },
  { type: "turn_end", turn_id: "t1", message_id: "t1:1" },
];

const DOTS = () => {
  document.querySelectorAll("#log .msg.dgc.work-folded > .work-toggle").forEach((row) => row.click());
  document.querySelectorAll("#log details.tool-group").forEach((group) => { group.open = true; });
  const look = (card) => {
    const dot = card.querySelector(".dot"), style = getComputedStyle(dot), box = dot.getBoundingClientRect();
    return { verb: card.querySelector(".verb").textContent, status: card.dataset.status, round: style.borderRadius !== "0px",
      drawn: style.backgroundImage, width: Math.round(box.width), shown: dot.checkVisibility() };
  };
  return [...document.querySelectorAll("#log .tool")].map(look);
};

for (const how of ["live", "after a reload"]) {
  test(`a failed step's dot is a cross and a step that worked keeps its round dot, ${how}`, async (t) => {
    if (skipOrFail(t)) return;
    const events = how === "live" ? TURN : [{ type: "history", items: TURN, complete: true }];
    const page = await openThinkingPage(browser, { theme: "dark-modern", width: 900, events,
      config: { model: "deepseek-v4.1-flash:cloud" } });
    try {
      const [failed, worked] = await page.evaluate(DOTS);
      assert.equal(failed.verb, "Couldn't delegate");
      assert.equal(failed.status, "failed");
      assert.ok(failed.shown, "its dot is on screen");
      assert.equal(failed.round, false, "not the round dot of a step that worked");
      assert.match(failed.drawn, /linear-gradient.*linear-gradient/, "drawn as a cross");
      assert.ok(failed.width >= 8, `as big as a cross needs to be read (${failed.width}px)`);
      assert.equal(worked.status, "completed");
      assert.equal(worked.round, true, "a step that worked keeps its round dot");
      assert.equal(worked.drawn, "none");
    } finally {
      await page.close();
    }
  });
}
