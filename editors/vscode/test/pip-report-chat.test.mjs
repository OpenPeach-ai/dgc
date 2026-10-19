// Pip reports reach the chat, end to end: the REAL panel, the REAL `dgc serve` of this checkout, a
// real Pip registry in the session's HOME, and media/main.js in Chromium (test/support/panel-live.mjs).
// A Pip attached to the chat finishes a run; its card arrives in the open chat by itself (no turn);
// Ask DGC to fix sends one message naming the run, once (the founder, 19 Oct), and the model reads
// the whole report with pips_context; a reload draws
// the same card; Dismiss is saved; and the card fits a narrow panel.
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser or Python into a failure.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { answer, launch, modelServer, panelSession, repoRoot, sleep, toolCalls, until } from "./support/panel-live.mjs";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "support", "pip-report-fixture.py");
let env, model, reportRun = "";
const seen = [];
before(async () => {
  env = await launch();
  model = await modelServer(({ messages, lastUser }) => {
    seen.push(lastUser);
    const results = messages.filter((m) => m.role === "tool").map((m) => String(m.content || ""));
    if (!lastUser.includes("pips_context")) return answer("Done: the audit is set up.");
    if (!results.length) return toolCalls([["call_load", "use_pips", {}]]);
    if (!results.some((r) => r.includes("total_findings"))) {
      return toolCalls([["call_read", "pips_context", { action: "report", run_id: reportRun }]]);
    }
    const read = results.find((r) => r.includes("total_findings"));
    return answer(read.includes("GST total skips cess") ? "I read the report: 2 findings, starting with the GST total." : "The report was empty.");
  });
});
after(async () => {
  model?.close();
  await env?.browser?.close();
});

function py(s, ...args) {
  const run = spawnSync(env.python, [fixture, ...args], { encoding: "utf8",
    env: { ...process.env, HOME: s.home, PYTHONPATH: repoRoot, DGC_HOME: "" } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}
const cards = (page) => page.evaluate(() => [...document.querySelectorAll("#log .pip-report")].map((card) => {
  // `hist` and `settled` (with its measured size) only say a block came from the saved history and is
  // laid out lazily; what the card draws is the rest.
  const copy = card.cloneNode(true); copy.classList.remove("hist", "settled"); copy.removeAttribute("style");
  const block = [...document.querySelectorAll("#log .msg.dgc")].at(-1);
  return { html: copy.outerHTML, afterTurn: !!block && !block.contains(card)
    && !!(block.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING) };
}));

test("a report reaches the open chat as a card, Ask DGC to fix fills the box, and the model reads it", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await panelSession({ ...env, model, name: "pip-report", config: { pips_enabled: true } });
  try {
    const pip = py(s, "create", s.work, "ERP daily audit", "scout");  // Pips in use before the chat saves
    await s.openWebview({ width: 360, height: 760 });
    await s.ready();
    await s.typePrompt("Set up a daily audit of the billing code");
    await until(() => s.events.some((e) => e.type === "turn_end"), "the first turn to end", 30_000);
    await until(() => s.provider.currentSessionSaved, "the chat to be saved", 10_000);
    py(s, "attach", s.work, s.provider.currentSessionId, pip);
    reportRun = py(s, "finish", s.work, pip, JSON.stringify([
      { title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 88, evidence: "total", verification: "source_excerpt_only" },
      { title: "Rounding drops paise", severity: "medium", path: "app/billing.py", line: 12, evidence: "round", verification: "source_excerpt_only" }]));
    const turnsBefore = s.events.filter((e) => e.type === "turn_start").length;

    const event = await until(() => s.events.find((e) => e.type === "pip_report"), "the report to arrive by itself", 20_000);
    assert.equal(event.report.run_id, reportRun);
    await until(async () => (await cards(s.page)).length === 1, "the card to be drawn");
    const [live] = await cards(s.page);
    assert.ok(live.afterTurn, "drawn after the turn, in the transcript");
    assert.equal(s.events.filter((e) => e.type === "turn_start").length, turnsBefore, "no turn started");
    const state = await s.page.locator(".pip-report .pip-report-state").textContent();
    assert.equal(state, "finished · 2 findings (1 high, 1 medium)");

    // The narrow panel: nothing clipped sideways, the actions on screen.
    const fit = await s.page.evaluate(() => {
      const card = document.querySelector(".pip-report"), log = document.getElementById("log");
      const box = card.getBoundingClientRect();
      return { overflow: card.scrollWidth - card.clientWidth, logOverflow: log.scrollWidth - log.clientWidth,
        right: box.right, width: innerWidth,
        buttons: [...card.querySelectorAll("button")].map((b) => { const r = b.getBoundingClientRect(); return r.right <= innerWidth && r.width > 0; }) };
    });
    assert.ok(fit.overflow <= 0 && fit.logOverflow <= 0, JSON.stringify(fit));
    assert.ok(fit.right <= fit.width && fit.buttons.every(Boolean), JSON.stringify(fit));

    await s.page.locator(".pip-report-fix").click();                     // the user's ask: sent at once, once
    assert.equal(await s.page.locator("#input").evaluate((el) => el.value), "", "the box is left alone");
    assert.equal(await s.page.locator(".pip-report-fix").textContent(), "Asked DGC");
    assert.ok(await s.page.locator(".pip-report-fix").isDisabled(), "a second click can't send it again");
    const ended = await until(() => s.events.filter((e) => e.type === "turn_end").length === 2
      && s.events.filter((e) => e.type === "turn_end").at(-1), "the fix turn to end", 60_000);
    assert.equal(ended.reason, "completed");
    assert.ok(seen.some((u) => u.includes(reportRun)), "the model got the prompt naming the run");
    const reply = await s.page.evaluate(() => [...document.querySelectorAll("#log .msg.dgc")].at(-1).textContent);
    assert.match(reply, /I read the report: 2 findings, starting with the GST total\./);

    // A reload draws the same card where it was.
    const liveCards = await cards(s.page);
    await s.reloadWebview({ width: 360, height: 760 });
    await s.ready();
    await until(async () => (await cards(s.page)).length === 1, "the replayed card", 20_000);
    const replayed = await cards(s.page);
    assert.deepEqual(replayed.map((c) => c.html), liveCards.map((c) => c.html), "replay draws what live drew");

    await s.page.locator(".pip-report-dismiss").click();
    await sleep(800);
    await s.reloadWebview({ width: 360, height: 760 });
    await s.ready();
    await sleep(1500);
    assert.equal((await cards(s.page)).length, 0, "Dismiss is saved with the chat");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
