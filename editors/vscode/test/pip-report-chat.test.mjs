// Pip reports reach the chat, end to end: the REAL panel, the REAL `dgc serve` of this checkout, a
// real Pip registry in the session's HOME, and media/main.js in Chromium (test/support/panel-live.mjs).
// A Pip attached to the chat finishes a run; its card arrives in the open chat by itself (no turn);
// Ask DGC to fix starts a BACKGROUND fix (reported 19 Oct): no turn, the card is its status, the
// fixer reads the whole finding, its change is applied with Undo and the card says so; a reload draws
// the same card; Dismiss is saved; and the card fits a narrow panel.
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

test("a report reaches the open chat as a card, Ask DGC to fix fixes it in the background with Undo", async (t) => {
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
    py(s, "attach", s.work, s.provider.currentSessionId, pip);
    reportRun = py(s, "finish", s.work, pip, JSON.stringify([
      { title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 2, evidence: "return x", verification: "source_excerpt_only" },
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
    const fit = async () => s.page.evaluate(() => {
      const card = document.querySelector(".pip-report"), log = document.getElementById("log");
      const box = card.getBoundingClientRect();
      return { overflow: card.scrollWidth - card.clientWidth, logOverflow: log.scrollWidth - log.clientWidth,
        right: box.right, width: innerWidth,
        // The buttons on screen (closed, the second line's Fix · Open · ✕; the whole card's row waits behind the fold).
        buttons: [...card.querySelectorAll("button")].filter((b) => b.getClientRects().length)
          .map((b) => { const r = b.getBoundingClientRect(); return r.right <= innerWidth && r.width > 0; }) };
    });
    const before = await fit();
    assert.ok(before.overflow <= 0 && before.logOverflow <= 0, JSON.stringify(before));
    assert.ok(before.right <= before.width && before.buttons.every(Boolean), JSON.stringify(before));
    assert.ok(before.buttons.length >= 3, "Fix, Open and ✕ are on the card's second line");

    await s.page.locator(".pip-report-fix-slim").click();                // the user's ask: a fix in the background
    assert.equal(await s.page.locator("#input").evaluate((el) => el.value), "", "the box is left alone");
    const fixed = await until(() => s.events.find((e) => e.type === "pip_fix" && e.fix.state === "applied"),
      "the background fix to be applied", 60_000);
    assert.equal(s.events.filter((e) => e.type === "turn_start").length, turnsBefore, "the fix is no turn: the chat stays free");
    assert.equal(readFileSync(join(s.work, "app", "gst.py"), "utf8"), "def total(x):\n    return x * 118 // 100\n");
    assert.ok(seen.some((u) => u.includes("GST total skips cess") && u.includes("Evidence: return x")), "the fixer read the finding");
    await until(async () => (await s.page.locator(".pip-fix .pip-fix-text").textContent()) === "Fixed · 1 file changed", "the card to say so");
    assert.deepEqual(await s.page.locator(".pip-fix .pip-fix-act").allTextContents(), ["Review", "Undo", "Watch"]);
    assert.match(await s.page.locator(".pip-fix .pip-fix-tests").textContent(), /^Tests didn't run in the fix copy: this fixture has no tests$/);
    assert.equal(await s.page.locator(".pip-report-fix-slim").isVisible(), false, "the fix's own line replaces Fix");
    const after = await fit();
    assert.ok(after.overflow <= 0 && after.logOverflow <= 0 && after.buttons.every(Boolean), JSON.stringify(after));
    assert.equal(fixed.fix.files[0].path, "app/gst.py");

    // A reload draws the same card where it was, its fix with it.
    const liveCards = await cards(s.page);
    await s.reloadWebview({ width: 360, height: 760 });
    await s.ready();
    await until(async () => (await cards(s.page)).length === 1, "the replayed card", 20_000);
    await until(async () => (await s.page.locator(".pip-fix .pip-fix-text").count()) === 1, "the replayed fix", 20_000);
    const replayed = await cards(s.page);
    const plain = (html) => html.replace(/<span class="pip-fix-time">[^<]*<\/span>/, "");
    assert.deepEqual(replayed.map((c) => plain(c.html)), liveCards.map((c) => plain(c.html)), "replay draws what live drew");

    await s.page.locator(".pip-report-dismiss-slim").click();
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
