// Pip reports reach the chat, end to end: the REAL panel, the REAL `dgc serve` of this checkout, a
// real Pip registry in the session's HOME, and media/main.js in Chromium (test/support/panel-live.mjs).
// A Pip's run finishes; its card arrives in the open chat by itself (no turn). With 0.52's DGC (Pips API 96)
// the card is history: no Ask DGC to fix and no Dismiss, one quiet "Open in its chat" (the fix is the Pip's own, in
// its chat); a reload draws the same card; and the card fits a narrow panel. (Until 0.52 this test also started a
// background fix from the card and dismissed it: neither is offered at API 96, so neither can be reached here. The
// fix row's own drawing is still held by the jsdom tests, pip-fix-row and agent-lines.)
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser or Python into a failure.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
    const task = String(messages.find((m) => m.role === "user")?.content || "");
    if (task.startsWith("Fix what Pip")) {                    // the background fixer, in the fix copy
      if (!results.length) return toolCalls([["call_fix", "write_file", { path: "app/gst.py", content: "def total(x):\n    return x * 118 // 100\n" }]]);
      return answer("Added the cess to the GST total.\nTESTS: not run \u2014 this fixture has no tests");
    }
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

test("a report reaches the open chat as a card with one quiet answer, Open in its chat; a reload draws the same card", async (t) => {
  if (env.skipOrFail(t)) return;
  const s = await panelSession({ ...env, model, name: "pip-report", config: { pips_enabled: true },
    files: { ".gitignore": ".env\n" } });
  try {
    mkdirSync(join(s.work, "app"), { recursive: true });
    writeFileSync(join(s.work, "app", "gst.py"), "def total(x):\n    return x\n");
    for (const args of [["init", "-q"], ["config", "user.email", "t@dgc.invalid"], ["config", "user.name", "T"],
      ["add", "."], ["commit", "-qm", "baseline"]]) assert.equal(spawnSync("git", args, { cwd: s.work }).status, 0);
    const pip = py(s, "create", s.work, "ERP daily audit", "scout");  // Pips in use before the chat saves
    await s.openWebview({ width: 360, height: 760 });
    await s.ready();
    await s.typePrompt("Set up a daily audit of the billing code");
    await until(() => s.events.some((e) => e.type === "turn_end"), "the first turn to end", 30_000);
    await until(() => s.provider.currentSessionSaved, "the chat to be saved", 10_000);
    // 0.52: a Work chat gets a Pip's card only for a run it started (attaching routes nothing): this chat ran it.
    reportRun = py(s, "finish", s.work, pip, JSON.stringify([
      { title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 2, evidence: "return x", verification: "source_excerpt_only" },
      { title: "Rounding drops paise", severity: "medium", path: "app/billing.py", line: 12, evidence: "round", verification: "source_excerpt_only" }]), s.provider.currentSessionId);
    const turnsBefore = s.events.filter((e) => e.type === "turn_start").length;

    const event = await until(() => s.events.find((e) => e.type === "pip_report"), "the report to arrive by itself", 20_000);
    assert.equal(event.report.run_id, reportRun);
    await until(async () => (await cards(s.page)).length === 1, "the card to be drawn");
    const [live] = await cards(s.page);
    assert.ok(live.afterTurn, "drawn after the turn, in the transcript");
    assert.equal(s.events.filter((e) => e.type === "turn_start").length, turnsBefore, "no turn started");
    const state = await s.page.locator(".pip-report .pip-report-state").textContent();
    assert.equal(state, "finished · 2 findings (1 high, 1 medium)");

    // The narrow panel: nothing clipped sideways, its one answer on screen.
    const fit = async () => s.page.evaluate(() => {
      const card = document.querySelector(".pip-report"), log = document.getElementById("log");
      const box = card.getBoundingClientRect();
      return { overflow: card.scrollWidth - card.clientWidth, logOverflow: log.scrollWidth - log.clientWidth,
        right: box.right, width: innerWidth,
        // The buttons on screen (closed: the second line's; the whole card's row waits behind the fold).
        buttons: [...card.querySelectorAll("button")].filter((b) => b.getClientRects().length)
          .map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent.trim(), inside: r.right <= innerWidth && r.width > 0 }; }) };
    });
    const before = await fit();
    assert.ok(before.overflow <= 0 && before.logOverflow <= 0, JSON.stringify(before));
    assert.ok(before.right <= before.width && before.buttons.every((b) => b.inside), JSON.stringify(before));
    // 0.52, Pips API 96 (this checkout's DGC): the Pip tells you in its own chat, so the card here is history. No Fix,
    // no Ask DGC to fix and no Dismiss: one quiet "Open in its chat" (test/pip-report-quiet.test.mjs has the card's
    // every state; the background fix a card used to start is the Pip's own now, test/one-pips-flow.test.mjs).
    assert.deepEqual(before.buttons.map((b) => b.text), ["Open in its chat"], "its one answer, on the card's second line");
    assert.equal(await s.page.locator(".pip-report-fix-slim, .pip-report-fix, .pip-report-dismiss-slim, .pip-fix-dismiss").count(), 0, "nothing to fix or dismiss here");
    assert.equal(await s.page.locator("#input").evaluate((el) => el.value), "", "the box is left alone");
    assert.equal(s.events.filter((e) => e.type === "pip_fix").length, 0, "no fix was started in this chat");

    // A reload draws the same card where it was. Compared at rest: while DGC's own tooltip is up it lifts the
    // control's `title` (and puts it back on hide), so a pointer left over the card's place ("gst.py, line 2", whose
    // title is the exact path) would make the live copy differ from the replay by that one attribute.
    await s.page.mouse.move(0, 0);
    await until(async () => s.page.evaluate(() => !document.querySelector(".pip-report-where:not([title])")), "the tooltip to put the title back", 5_000);
    const liveCards = await cards(s.page);
    await s.reloadWebview({ width: 360, height: 760 });
    await s.ready();
    await until(async () => (await cards(s.page)).length === 1, "the replayed card", 20_000);
    const replayed = await cards(s.page);
    assert.deepEqual(replayed.map((c) => c.html), liveCards.map((c) => c.html), "replay draws what live drew");
    assert.deepEqual((await fit()).buttons.map((b) => b.text), ["Open in its chat"], "and still its one answer");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.close();
  }
});
