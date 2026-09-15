// A question left open when the backend died is replayed as never answered. The reconnect drew it
// "Asked · stopped · Not answered"; after Continue repaired the transcript, a reload drew the same step
// "Asked · failed" and expanded, because the repair text the model reads replayed as the step's output.
// The REAL panel, the REAL `dgc serve` of this checkout and media/main.js in Chromium
// (test/support/panel-live.mjs). DGC_REQUIRE_CHROMIUM=1 turns a missing browser or Python into a failure.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { answer, launch, modelServer, panelSession, sleep, toolCalls, until } from "./support/panel-live.mjs";

const QUESTION = { questions: [{ header: "Database", question: "Which database should the cache use?", options: [
  { label: "SQLite (Recommended)", description: "One file, nothing to run." },
  { label: "Postgres", description: "A server to operate." }] }] };

let env, model;
before(async () => {
  env = await launch();
  model = await modelServer(({ messages }) => {
    if (messages.some((m) => m.role === "tool")) return answer("Continued without an answer.");
    return toolCalls([["call_ask", "propose_options", QUESTION]]);
  });
});
after(async () => {
  model?.close();
  await env?.browser?.close();
});

// The question step as drawn: status, outcome, its header row, whether it is expanded, and its turn's verb.
const question = (page) => page.evaluate(() => [...document.querySelectorAll('#log .tool[data-tool-name="propose_options"]')].map((card) => ({
  status: card.dataset.status, outcome: card.dataset.outcome || "",
  head: (card.querySelector(".tool-toggle")?.textContent || "").replace(/\s+/g, " ").trim(),
  open: card.classList.contains("open"),
  group: (card.closest(".tool-group")?.querySelector(".group-head, summary, .tool-group-head")?.textContent || "").replace(/\s+/g, " ").trim(),
  turn: (card.closest(".msg.dgc")?.querySelector(".thinking")?.textContent || "").trim(),
})));

test("an unanswered question after Continue reads the same live and after a reload", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await panelSession({ ...env, model, name: "question-continue" });
  try {
    await s.openWebview();
    await s.ready();
    await s.typePrompt("Set up the cache");
    await until(() => s.events.some((e) => e.type === "options_request"), "the question");
    await sleep(300);
    const child = s.provider.backend.proc;
    process.kill(child.pid, "SIGKILL");                       // the backend dies with the question open
    await until(() => s.posted.some((m) => m.type === "continue_offer"), "the Continue offer", 30_000);
    await sleep(500);
    const reconnected = await question(s.page);
    assert.equal(reconnected.length, 1);
    assert.equal(reconnected[0].outcome, "cancelled");
    assert.equal(reconnected[0].status, "stopped");

    await s.page.locator(".recovery-card button", { hasText: "Continue" }).click();
    await until(() => s.events.some((e) => e.type === "turn_start" && e.kind === "continue")
      && s.events.findLastIndex((e) => e.type === "turn_end") > s.events.findLastIndex((e) => e.type === "turn_start"),
      "the continued turn to finish", 30_000);
    await sleep(500);
    const live = await question(s.page);
    assert.deepEqual(live, reconnected, "Continue leaves the question as the reconnect drew it");

    await s.reloadWebview();
    await s.ready();
    await until(async () => {
      const now = await question(s.page);
      return now.length && now[0].outcome ? now : null;
    }, "the replayed question", 10_000).catch(async () => question(s.page));
    await sleep(500);
    assert.deepEqual(await question(s.page), live.map((row) => ({ ...row, turn: row.turn.replace(/ for \d+s$/, "") })),
      "a reload draws the question the live chat drew");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
