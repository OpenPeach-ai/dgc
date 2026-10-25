// A background helper's report, end to end: the REAL panel asks for it with the handshake, the REAL
// `dgc serve` of this checkout runs the helper in the background and wakes the chat when it ends, and
// media/main.js in Chromium draws one folded "Woke on agent" line that opens to the helper's report.
// A webview reload and a window reload (a new backend that reopens the saved session) draw the same
// line with the same report. test/support/panel-live.mjs. DGC_REQUIRE_CHROMIUM=1 turns a missing
// browser or Python into a failure.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { answer, launch, modelServer, panelSession, sleep, toolCalls, until } from "./support/panel-live.mjs";

const REPORT = "The rounding bug is in total(): it rounded each line.\n\n- Fixed it to round once.\n- Added a test.";
let env, model;
before(async () => {
  env = await launch();
  model = await modelServer(({ messages, users, lastUser }) => {
    if (lastUser.startsWith("A background specialist finished.")) return answer("The helper fixed the rounding.");
    if (users.some((text) => text.includes("CHILD-TASK"))) return answer(REPORT);          // the helper's own turn
    if (messages.some((m) => m.role === "tool")) return answer("A helper is on it.");
    return toolCalls([["call_bg", "task", { description: "Review billing.py", background: true,
      prompt: "CHILD-TASK: review billing.py and report what you found." }]]);
  });
});
after(async () => {
  model?.close();
  await env?.browser?.close();
});

// The lines, and each one's report once opened.
const lines = (page) => page.evaluate(() => [...document.querySelectorAll("#log .handback-line")].map((line) => {
  const toggle = line.querySelector(".handback-toggle"), body = line.querySelector(".handback-body");
  return { text: toggle.textContent, expanded: toggle.getAttribute("aria-expanded"), hidden: body.hidden };
}));
const opened = (page) => page.evaluate(() => {
  const line = document.querySelector("#log .handback-line");
  if (line.querySelector(".handback-toggle").getAttribute("aria-expanded") !== "true") line.querySelector(".handback-toggle").click();
  const body = line.querySelector(".handback-body");
  return { note: body.querySelector(".agent-page-outcome")?.textContent || "",
    said: [...body.querySelectorAll(".handback-answer p, .handback-answer li")].map((n) => n.textContent),
    link: body.querySelector(".handback-map")?.textContent || "" };
});
// Every marker between turns: the wake's own note must have become the line, never sit beside it.
const notes = (page) => page.evaluate(() => [...document.querySelectorAll("#log .resume-note")].map((n) => n.textContent.trim()));
const users = (page) => page.evaluate(() => [...document.querySelectorAll("#log .msg.user .bubble")].map((n) => n.textContent));

test("a background helper's report is one folded line, the same after a webview and a window reload", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await panelSession({ ...env, model, name: "agent-report" });
  try {
    await s.openWebview();
    await s.ready();
    await s.typePrompt("Review billing in the background");
    const report = await until(() => s.events.find((e) => e.type === "agent_report"), "the helper's report", 60_000);
    assert.equal(report.description, "Review billing.py");
    assert.ok(report.report.includes(REPORT), report.report);
    await until(() => s.events.filter((e) => e.type === "turn_end").length >= 2, "the wake turn to end", 30_000);
    await sleep(400);
    const live = await lines(s.page);
    assert.deepEqual(live, [{ text: "Woke on agent · Review billing.py", expanded: "false", hidden: true }]);
    assert.deepEqual(await users(s.page), ["Review billing in the background"], "nobody typed the wake");
    const liveNotes = await notes(s.page);
    assert.deepEqual(liveNotes, ["Woke on agent · Review billing.py"]);
    const liveReport = await opened(s.page);
    assert.match(liveReport.note, /^Sub-task 'Review billing\.py' completed/);
    assert.deepEqual(liveReport.said, ["The rounding bug is in total(): it rounded each line.", "Fixed it to round once.", "Added a test."]);
    assert.equal(liveReport.link, "Open in agent map");

    await s.reloadWebview();
    await s.ready();
    const afterReload = await until(async () => { const now = await lines(s.page); return now.length ? now : null; },
      "the replayed line", 15_000).catch(() => lines(s.page));
    assert.deepEqual(afterReload, live, "a webview reload draws the same folded line");
    assert.deepEqual(await notes(s.page), liveNotes, "and nothing beside it");
    assert.deepEqual(await opened(s.page), liveReport);
    assert.deepEqual(await users(s.page), ["Review billing in the background"]);

    await s.reloadWindow();
    await s.ready();
    const reopened = await until(async () => { const now = await lines(s.page); return now.length ? now : null; },
      "the reopened chat's line", 30_000).catch(() => lines(s.page));
    assert.deepEqual(reopened, live, "a new backend reopening the saved chat draws it too");
    assert.deepEqual(await notes(s.page), liveNotes);
    assert.deepEqual(await opened(s.page), liveReport);
    assert.deepEqual(await users(s.page), ["Review billing in the background"], "DGC's notice is never a prompt bubble");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
