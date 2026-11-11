// "Fix it" on a Pip's card in a Work chat runs as a helper row in the chat (asked 11 Nov): the card goes away, and in
// its place the fix shows as the row a helper gets: the helper's own mark (the one its page and the agent map wear),
// its name, what it is doing now, and running; then done, with the files it changed, Review and Undo, or why it stopped.
// The name opens the helper's page, as a helper row's does. A refused start brings the card back with its button. A
// reload draws the row again (the replayed card carries its fix; the chat's fixes are listed when it opens).
// The row is the report's own node, restyled (media/main.js paintPipFixCard, media/main.css .pip-report.is-fix-row):
// everything pip-fix-card.test.mjs says of the fix's line still holds. How it looks is pip-fix-row-browser.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const RUN = "run_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), FIX = "fix_" + "c".repeat(32), AGENT = "sub-0123456789ab";
const REPORT = {
  run_id: RUN, pip_id: PIP, name: "ERP daily audit", pip_type: "scout", kind: "audit", outcome: "findings",
  finished_at: "2026-10-18T13:00:00.000Z", earlier: 0, total: 2, counts: { high: 1, medium: 1 },
  findings: [{ title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 88 },
             { title: "Rounding drops paise", severity: "medium", path: "app/billing.py", line: 12 }],
};
const now = () => Date.now() / 1000;
const fix = (fields) => ({ fix_id: FIX, run_id: RUN, pip_id: PIP, name: "ERP daily audit", pip_type: "scout", agent_id: AGENT, created_at: now() - 30, ...fields });
const STARTED = { type: "agent_started", id: AGENT, parent_id: null, call_id: null, description: "Fix what ERP daily audit found", depth: 1, state: "running",
  started_at: now(), isolated: true, parallel: false, background: true };

function panel(capabilities = { pip_reports: 1, pip_fix: 1, agents: true, agent_control: true }) {
  const s = makeDom();
  s.event = (event) => s.send({ type: "event", event });
  s.event({ type: "ready", capabilities, model: "m", mode: "default", think: "off", session_id: "s1" });
  s.send({ type: "session_ready", sessionId: "s1" });
  return s;
}
const card = (s) => s.doc.querySelector("#log .pip-report");
/** The row as it reads: is the card a row, its mark, its name, what it says, its answers. */
const row = (s) => { const c = card(s), area = c?.querySelector(".pip-fix"), mark = area?.querySelector(".pip-fix-who .agent-mark"), name = area?.querySelector(".pip-fix-name");
  return { row: !!c?.classList.contains("is-fix-row"), mark: !!mark, live: !!mark?.classList.contains("is-live"), face: mark?.dataset.face || "", name: name?.textContent || "", nameIsButton: name?.tagName === "BUTTON",
    says: area?.querySelector(".pip-fix-text")?.textContent || "", actions: [...(area?.querySelectorAll(".pip-fix-actions button") || [])].map((b) => b.textContent), label: c?.getAttribute("aria-label") || "" }; };
const posted = (s, type, from = 0) => JSON.parse(JSON.stringify(s.posted.slice(from).filter((m) => m.type === type)));

test("Fix it takes the card away at once: a helper row in its place, with a mark and a name, starting", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  assert.equal(row(s).row, false, "a report is a card");
  card(s).querySelector(".pip-report-fix-slim").click();
  const r = row(s);
  assert.deepEqual([r.row, r.mark, r.name, r.says, r.actions], [true, true, "Fix what ERP daily audit found", "Starting", []], "the card is a helper row now: a mark, a name, starting");
  assert.match(r.label, /^Fixing what ERP daily audit reported/, "and is named for what it is");
  assert.deepEqual(posted(s, "startPipFix"), [{ type: "startPipFix", run_id: RUN }]);
  assert.equal(s.doc.querySelector("#log .agent-line"), null, "one row for the helper, never two");
  assert.deepEqual(s.errors, []);
});

test("the row is the helper's: its own mark, live while it works, its name opening its page, and what it is doing now", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  card(s).querySelector(".pip-report-fix-slim").click();
  s.event({ type: "pip_fix", fix: fix({ state: "queued" }) });
  assert.deepEqual([row(s).row, row(s).says, row(s).actions], [true, "Waiting to start", ["Stop"]]);
  s.event(STARTED);
  s.event({ type: "pip_fix", fix: fix({ state: "running", started_at: now() - 5 }) });
  let r = row(s);
  assert.deepEqual([r.row, r.mark, r.live, r.name, r.nameIsButton, r.says], [true, true, true, "Fix what ERP daily audit found", true, "Fixing"]);
  // The mark is the one the helper wears everywhere (its page's header, the agent map): the same face.
  s.event({ type: "tool_call", call_id: `${AGENT}:c1`, name: "bash", args: { command: "npm test" }, summary: "npm test" });
  r = row(s);
  assert.match(r.says, /^Fixing · .+npm test$/, "the fixer's own step");
  assert.deepEqual(r.actions, ["Watch", "Stop"]);
  card(s).querySelector(".pip-fix-name").click();
  assert.equal(s.doc.body.dataset.agentPage, AGENT, "its name opens the helper's page, as a helper row's does");
  assert.equal(s.doc.querySelector(`#phead .agent-mark`)?.dataset.face, r.face, "the same mark as its page");
  assert.equal(s.doc.querySelector("#log .agent-line"), null);
  assert.deepEqual(s.errors, []);
});

test("done, the row says what changed, with Review and Undo; its files, tests and summary open under it", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  card(s).querySelector(".pip-report-fix-slim").click();
  s.event(STARTED);
  s.event({ type: "pip_fix", fix: fix({ state: "running" }) });
  s.event({ type: "agent_finished", id: AGENT, state: "finished" });
  s.event({ type: "pip_fix", fix: fix({ state: "applied", started_at: now() - 72, ended_at: now(), summary: "Cess is added to the GST total.",
    files: [{ path: "app/gst.py", kind: "edited", additions: 3, deletions: 1 }, { path: "tests/test_gst.py", kind: "added", additions: 12, deletions: 0 }],
    tests: { state: "passed", command: "pytest -q" }, undo: { state: "available" } }) });
  const r = row(s);
  assert.deepEqual([r.row, r.mark, r.live, r.says], [true, true, false, "Fixed · 2 files changed"], "still the row, its mark at rest");
  assert.deepEqual(r.actions, ["Review", "Undo", "Watch"]);
  const before = s.posted.length;
  card(s).querySelector(".pip-fix-review").click();
  assert.deepEqual(posted(s, "reviewPipFix", before), [{ type: "reviewPipFix", fix_id: FIX, paths: ["app/gst.py", "tests/test_gst.py"] }]);
  card(s).querySelector(".pip-fix-undo").click();
  assert.deepEqual(posted(s, "undoPipFix", before), [{ type: "undoPipFix", fix_id: FIX, files: 2 }]);
  card(s).querySelector(".pip-fix-toggle").click();
  assert.deepEqual([...card(s).querySelectorAll(".pip-fix-files .pip-fix-file")].map((b) => b.textContent), ["app/gst.py", "tests/test_gst.py"], "the files it changed");
  assert.match(card(s).querySelector(".pip-fix-details").textContent, /Tests passed in the fix copy · pytest -q.*Cess is added to the GST total\./);
  assert.equal(row(s).row, true, "opened, it is still a row");
  assert.deepEqual(s.errors, []);
});

test("stopped or failed, the row says why, with Try again and the report one click away", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  card(s).querySelector(".pip-report-fix-slim").click();
  s.event({ type: "pip_fix", fix: fix({ state: "failed", message: "The fix didn't finish: the model stopped. Nothing in your project was changed." }) });
  const r = row(s);
  assert.deepEqual([r.row, r.says], [true, "The fix didn't finish"]);
  assert.deepEqual(r.actions, ["Try again", "Report"]);
  assert.match(card(s).querySelector(".pip-fix").textContent, /the model stopped\. Nothing in your project was changed\./, "why it stopped");
  // The report it was fixing is one click away: the card's own words come back under the row, and go again.
  card(s).querySelector(".pip-fix-report").click();
  assert.deepEqual([card(s).classList.contains("is-fix-row"), card(s).dataset.report], [true, "shown"]);
  assert.equal(card(s).querySelector(".pip-fix-report").getAttribute("aria-expanded"), "true");
  card(s).querySelector(".pip-fix-report").click();
  assert.equal(card(s).dataset.report, undefined);
  assert.deepEqual(s.errors, []);
});

test("a refused start brings the card back, with its button", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  card(s).querySelector(".pip-report-fix-slim").click();
  assert.equal(row(s).row, true);
  s.event({ type: "command_rejected", command: "start_pip_fix", reason: "plan_mode", message: "This chat is in Plan mode, where DGC changes nothing." });
  assert.equal(row(s).row, false, "the card is back");
  assert.equal(card(s).querySelector(".pip-fix"), null, "with no row left in it");
  const again = card(s).querySelector(".pip-report-fix-slim");
  assert.deepEqual([again.disabled, again.hidden, again.textContent], [false, false, "Fix"], "and its button");
  assert.match(card(s).getAttribute("aria-label"), /^Pip report from ERP daily audit/);
  assert.match(s.doc.getElementById("log").textContent, /Plan mode, where DGC changes nothing/, "and why is said");
  // It can be asked again.
  const before = s.posted.length;
  again.click();
  assert.equal(posted(s, "startPipFix", before).length, 1);
  assert.equal(row(s).row, true);
  assert.deepEqual(s.errors, []);
});

test("a reload shows the row: from the replayed card's own fix, and from the chat's list of fixes", () => {
  const turn = [{ type: "turn_start", turn_id: "h1", prompt: "Set up the audit" }, { type: "text_delta", text: "Done." },
    { type: "stream_end", message_id: "h1:1", phase: "answer" }, { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }];
  const running = fix({ state: "running", started_at: now() - 5 });
  const replay = panel();
  replay.event({ type: "history", items: [...turn, { role: "pip_report", report: { ...REPORT, fix: running } }] });
  assert.deepEqual([row(replay).row, row(replay).mark, row(replay).name, row(replay).says], [true, true, "Fix what ERP daily audit found", "Fixing"], "the replayed card is the row");
  // The card came without its fix (an older record), and the chat's list of fixes brings it.
  const listed = panel();
  listed.event({ type: "history", items: [...turn, { role: "pip_report", report: REPORT }] });
  assert.equal(row(listed).row, false);
  listed.event({ type: "pip_fixes", items: [running] });
  assert.deepEqual([row(listed).row, row(listed).says, row(listed).actions], [true, "Fixing", ["Stop"]]);
  for (const s of [replay, listed]) assert.deepEqual(s.errors, []);
});

test("an older CLI (no background fix) keeps the card and its one prompt", () => {
  const s = panel({ pip_reports: 1 });
  s.event({ type: "pip_report", report: REPORT });
  card(s).querySelector(".pip-report-fix-slim").click();
  assert.equal(row(s).row, false, "no helper runs, so no row");
  assert.equal(posted(s, "prompt").length, 1);
});

test("an ended fix's row can be dismissed, as its card could; a working one can not", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  card(s).querySelector(".pip-report-fix-slim").click();
  assert.equal(card(s).querySelector(".pip-fix-dismiss"), null, "starting: nothing to dismiss");
  s.event({ type: "pip_fix", fix: fix({ state: "running" }) });
  assert.equal(card(s).querySelector(".pip-fix-dismiss"), null, "working: Stop, not Dismiss");
  s.event({ type: "pip_fix", fix: fix({ state: "applied", files: [{ path: "app/gst.py", kind: "edited", additions: 3, deletions: 1 }], undo: { state: "available" } }) });
  const gone = card(s).querySelector(".pip-fix-dismiss");
  assert.deepEqual([gone?.getAttribute("aria-label"), gone?.tagName], ["Dismiss", "BUTTON"]);
  const before = s.posted.length;
  gone.click();
  assert.equal(card(s), null, "the row leaves the chat");
  assert.deepEqual(posted(s, "pipReportDismiss", before), [{ type: "pipReportDismiss", run_id: RUN }], "and that is saved with the chat");
  assert.deepEqual(s.errors, []);
});
