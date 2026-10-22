// Ask DGC to fix, in the background (ready.capabilities.pip_fix; dgc/pip_fix.py). The founder, 19 Oct: the fix is a
// background sub-agent of the chat, never a turn, so the chat stays free; the report's card IS its live status (what it
// is doing, Watch, Stop); a permission it needs is asked on the card, and the agents pill says an agent needs you; when it
// ends, the card says what changed, whether tests ran in the fix copy, and offers Review and Undo. A "Pip fixes" chip on
// the existing chip line (never a new row) shows only Pip fixes. A replayed card carries its latest fix (report.fix), so
// a reload draws the same card. An older CLI (no pip_fix) keeps today's one prompt.
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
const fix = (fields) => ({ fix_id: FIX, run_id: RUN, pip_id: PIP, name: "ERP daily audit", pip_type: "scout",
  agent_id: AGENT, created_at: now() - 30, ...fields });

function panel(capabilities = { pip_reports: 1, pip_fix: 1, agents: true, agent_control: true }) {
  const s = makeDom();
  s.event = (event) => s.send({ type: "event", event });
  s.event({ type: "ready", capabilities, model: "m", mode: "default", think: "off", session_id: "s1" });
  s.send({ type: "session_ready", sessionId: "s1" });
  return s;
}
const card = (s) => s.doc.querySelector("#log .pip-report");
const area = (s) => card(s)?.querySelector(".pip-fix");
const line = (s) => area(s)?.querySelector(".pip-fix-text")?.textContent;
const actions = (s) => [...(area(s)?.querySelectorAll(".pip-fix-actions button") || [])].map((b) => b.textContent);
// Plain copies: what the page posts is made in its own realm.
const posted = (s, type, from = 0) => JSON.parse(JSON.stringify(s.posted.slice(from).filter((m) => m.type === type)));

test("Ask DGC to fix starts a background fix: no prompt, the box left alone, the chat free", () => {
  const s = panel();
  assert.equal(posted(s, "listPipFixes").length, 1, "the chat's fixes are asked for when it opens");
  s.event({ type: "pip_report", report: REPORT });
  const input = s.doc.getElementById("input");
  input.value = "my own draft";
  input.dispatchEvent(new s.dom.window.Event("input", { bubbles: true }));
  const before = s.posted.length;
  card(s).querySelector(".pip-report-fix-slim").click();
  assert.deepEqual(posted(s, "startPipFix", before), [{ type: "startPipFix", run_id: RUN }]);
  assert.equal(posted(s, "prompt", before).length, 0, "never a message, never a turn");
  assert.equal(input.value, "my own draft");
  assert.equal(s.doc.querySelector("#log .msg.user"), null);
  assert.match(card(s).querySelector(".pip-report-fix").title, /in the background/);
  assert.deepEqual(s.errors, []);
});

test("an older CLI keeps the one prompt", () => {
  const s = panel({ pip_reports: 1 });
  s.event({ type: "pip_report", report: REPORT });
  const before = s.posted.length;
  card(s).querySelector(".pip-report-fix-slim").click();
  assert.equal(posted(s, "startPipFix", before).length, 0);
  assert.equal(posted(s, "prompt", before).length, 1);
});

test("the card is the fix's live status: waiting, getting ready, what the fixer is doing, Watch and Stop", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  card(s).querySelector(".pip-report-fix-slim").click();
  s.event({ type: "pip_fix", fix: fix({ state: "queued", queued_behind: "Lens review" }), request_id: "pip-fix-1" });
  assert.equal(line(s), "Waiting · starts after the fix for Lens review");
  assert.deepEqual(actions(s), ["Stop"]);
  assert.equal(card(s).querySelector(".pip-report-fix-slim").hidden, true, "the fix's own line replaces Fix");
  s.event({ type: "agent_started", id: AGENT, parent_id: null, call_id: null, description: "Fix what ERP daily audit found",
    depth: 1, state: "running", started_at: now(), isolated: true, parallel: false, background: true });
  s.event({ type: "pip_fix", fix: fix({ state: "preparing", step: "Installing dependencies: npm ci", started_at: now() - 5 }) });
  assert.equal(line(s), "Installing dependencies: npm ci");
  s.event({ type: "pip_fix", fix: fix({ state: "running", started_at: now() - 5 }) });
  assert.equal(line(s), "Fixing");
  s.event({ type: "tool_call", call_id: `${AGENT}:c1`, name: "bash", args: { command: "npm test" }, summary: "npm test" });
  assert.match(line(s), /^Fixing · .+npm test$/, "the fixer's own step");
  assert.deepEqual(actions(s), ["Watch", "Stop"]);
  assert.equal(area(s).closest(".pip-report").dataset.shown, "closed", "shown on the closed card, its two lines and this one");
  const before = s.posted.length;
  area(s).querySelector(".pip-fix-stop").click();
  assert.deepEqual(posted(s, "stopAgent", before), [{ type: "stopAgent", id: AGENT }]);
  assert.equal(area(s).querySelector(".pip-fix-stop").textContent, "Stopping…");
  area(s).querySelector(".pip-fix-watch").click();
  assert.equal(s.doc.body.dataset.agentPage, AGENT, "Watch opens the fixer's own page");
  assert.equal(s.doc.querySelector("#log .msg.user, #log .msg.dgc"), null, "nothing was drawn as a turn");
  assert.deepEqual(s.errors, []);
});

test("a permission the fix needs is asked on its card, and the agents pill says an agent needs you", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  s.event({ type: "pip_fix", fix: fix({ state: "running" }) });
  s.event({ type: "agent_started", id: AGENT, parent_id: null, call_id: null, description: "Fix", depth: 1,
    state: "running", started_at: now(), isolated: true, parallel: false, background: true });
  s.event({ type: "permission_request", id: "p1", call_id: `${AGENT}:install-1`, name: "bash",
    args: { command: "npm ci --no-audit --no-fund" }, command: "npm ci --no-audit --no-fund", suggested_rule: "Bash(npm ci *)", choices: [] });
  s.event({ type: "agent_updated", id: AGENT, state: "waiting", waiting_for: "permission" });
  const ask = area(s).querySelector(".pip-fix-ask .card");
  assert.ok(ask, "the request is on the fix's card");
  assert.equal(s.doc.querySelectorAll("#log > .card, #log .msg .card").length, 0, "not in the transcript");
  assert.match(ask.querySelector(".q").textContent, /Install the project's dependencies in the fix copy\?/);
  assert.equal(line(s), "Needs you");
  assert.ok(area(s).hasAttribute("data-waiting"));
  assert.equal(s.doc.getElementById("agents-pill").dataset.state, "waiting");
  assert.equal(s.doc.querySelector('#rail-chips .rail-chip[data-kind="pipfixes"]').dataset.need, "warn", "and the chip");
  const before = s.posted.length;
  ask.querySelector('button[data-d="once"]').click();
  assert.deepEqual(posted(s, "permission_response", before).map((m) => [m.id, m.decision]), [["p1", "once"]]);
  s.event({ type: "agent_updated", id: AGENT, state: "running" });
  assert.equal(area(s).querySelector(".pip-fix-ask .card"), null, "answered, it leaves the card");
  // The fixer asks for an ignored file a test needs: copy it, or not now.
  s.event({ type: "permission_request", id: "p2", call_id: `${AGENT}:c4`, name: "request_project_file",
    args: { path: ".env", why: "the API tests read DATABASE_URL" }, suggested_rule: "", choices: [] });
  const file = area(s).querySelector(".pip-fix-ask .card");
  assert.match(file.textContent, /Copy \.env from your project into the fix copy\?/);
  assert.match(file.textContent, /the API tests read DATABASE_URL/);
  assert.match(file.textContent, /copied, never linked/);
  assert.deepEqual([...file.querySelectorAll(".btns button")].map((b) => b.textContent), ["Copy it", "Not now"]);
  assert.deepEqual(s.errors, []);
});

test("finished: what changed, whether tests ran in the fix copy, Review and Undo", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  s.event({ type: "pip_fix", fix: fix({ state: "applied", started_at: now() - 72, ended_at: now(),
    files: [{ path: "app/gst.py", kind: "edited", additions: 3, deletions: 1, counted: true },
            { path: "app/cess.py", kind: "added", additions: 9, deletions: 0, counted: true }],
    tests: { state: "passed", command: "npm test" }, summary: "Added the cess to the GST total.", undo: { state: "available" } }) });
  assert.equal(line(s), "Fixed · 2 files changed");
  assert.equal(area(s).querySelector(".pip-fix-totals").textContent, "+12\u22121");
  assert.deepEqual([...area(s).querySelectorAll(".pip-fix-files li")].map((li) => li.textContent),
    ["app/gst.py+3−1", "app/cess.pynew+9−0"]);
  assert.equal(area(s).querySelector(".pip-fix-tests").textContent, "Tests passed in the fix copy · npm test");
  assert.equal(area(s).querySelector(".pip-fix-summary").textContent, "Added the cess to the GST total.");
  assert.equal(area(s).querySelector(".pip-fix-time").textContent, "1m 12s");
  assert.deepEqual(actions(s), ["Review", "Undo"]);
  let before = s.posted.length;
  area(s).querySelector(".pip-fix-review").click();
  assert.deepEqual(posted(s, "reviewPipFix", before), [{ type: "reviewPipFix", fix_id: FIX, paths: ["app/gst.py", "app/cess.py"] }]);
  before = s.posted.length;
  area(s).querySelector(".pip-fix-file").click();
  assert.deepEqual(posted(s, "reviewPipFix", before), [{ type: "reviewPipFix", fix_id: FIX, paths: ["app/gst.py"] }], "one file, its diff");
  before = s.posted.length;
  area(s).querySelector(".pip-fix-undo").click();
  assert.deepEqual(posted(s, "undoPipFix", before), [{ type: "undoPipFix", fix_id: FIX, files: 2 }]);
  s.event({ type: "pip_fix", request_id: "u", fix: fix({ state: "undone", files: [{ path: "app/gst.py", kind: "edited", additions: 3, deletions: 1 }],
    undo: { state: "done", restored: ["app/gst.py", "app/cess.py"] } }) });
  assert.equal(line(s), "Undone");
  assert.match(area(s).textContent, /Put back 2 files\./);
  assert.deepEqual(actions(s), ["Try again"]);
  assert.deepEqual(s.errors, []);
});

test("held back, not run, stopped and failed each say so, and what can be done next", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  s.event({ type: "pip_fix", fix: fix({ state: "partial", files: [{ path: "app/billing.py", kind: "edited", additions: 1, deletions: 1 }],
    held: [{ path: "app/gst.py", why: "you changed the same lines while it worked" }], tests: { state: "not_run", note: "no tests here" },
    undo: { state: "available" } }) });
  assert.equal(line(s), "Fixed 1 file · 1 held back");
  assert.equal(area(s).querySelector(".pip-fix-held").textContent, "Held back: app/gst.py · you changed the same lines while it worked");
  assert.equal(area(s).querySelector(".pip-fix-tests").textContent, "Tests didn't run in the fix copy: no tests here");
  let before = s.posted.length;
  area(s).querySelector(".pip-fix-held .pip-fix-file").click();
  assert.deepEqual(posted(s, "reviewPipFix", before), [{ type: "reviewPipFix", fix_id: FIX, paths: ["app/gst.py"] }]);
  s.event({ type: "pip_fix", fix: fix({ state: "stopped", message: "Stopped. Nothing in your project was changed." }) });
  assert.equal(line(s), "Stopped");
  assert.match(area(s).textContent, /Nothing in your project was changed\./);
  before = s.posted.length;
  area(s).querySelector(".pip-fix-again").click();
  assert.deepEqual(posted(s, "startPipFix", before), [{ type: "startPipFix", run_id: RUN }], "Try again starts a new fix");
  s.event({ type: "command_rejected", command: "start_pip_fix", reason: "plan_mode", message: "This chat is in Plan mode, where DGC changes nothing." });
  assert.equal(area(s).querySelector(".pip-fix-again").disabled, false, "a refusal gives the button back");
  assert.match(s.doc.getElementById("log").textContent, /Plan mode, where DGC changes nothing/);
  s.event({ type: "pip_fix", fix: fix({ fix_id: "fix_" + "d".repeat(32), created_at: now(), state: "failed",
    message: "The fix didn't finish: the model stopped. Nothing in your project was changed." }) });
  assert.equal(line(s), "The fix didn't finish");
  assert.deepEqual(s.errors, []);
});

test("a reload draws the card with its fix, as live drew it", () => {
  const turn = [{ type: "turn_start", turn_id: "h1", prompt: "Set up the audit" },
    { type: "text_delta", text: "Done." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }];
  const done = fix({ state: "applied", started_at: 1000, ended_at: 1072, files: [{ path: "app/gst.py", kind: "edited", additions: 1, deletions: 1 }],
    tests: { state: "failed", command: "pytest", note: "1 failed" }, undo: { state: "available" } });
  const live = panel();
  live.event({ type: "history", items: turn });
  live.event({ type: "pip_report", report: REPORT });
  live.event({ type: "pip_fix", fix: done });
  const replay = panel();
  replay.event({ type: "history", items: [...turn, { role: "pip_report", report: { ...REPORT, fix: done } }] });
  const shape = (s) => { const c = card(s).cloneNode(true); c.classList.remove("hist"); return c.outerHTML; };
  assert.equal(shape(replay), shape(live));
  assert.equal(area(replay).querySelector(".pip-fix-tests").textContent, "Tests failed in the fix copy · pytest: 1 failed");
  // A fix whose card was dismissed still reaches the chip from the chat's list of fixes.
  const listed = panel();
  listed.event({ type: "pip_fixes", items: [fix({ state: "running" })] });
  assert.ok(listed.doc.querySelector('#rail-chips .rail-chip[data-kind="pipfixes"]'));
  for (const s of [live, replay, listed]) assert.deepEqual(s.errors, []);
});

test("the Pip fixes chip is on the existing chip line, never a row, and lists only Pip fixes", () => {
  const s = panel();
  const rowsBefore = [...s.doc.getElementById("composer-rail").children].map((n) => n.id);
  s.event({ type: "pip_report", report: REPORT });
  assert.equal(s.doc.querySelector('#rail-chips .rail-chip[data-kind="pipfixes"]'), null, "no fix, no chip");
  s.event({ type: "pip_fix", fix: fix({ state: "running" }) });
  const chip = s.doc.querySelector('#rail-chips .rail-chip[data-kind="pipfixes"]');
  assert.ok(chip, "a chip on the chip line");
  assert.equal(s.doc.getElementById("rail-chips").hidden, false);
  assert.deepEqual([...s.doc.getElementById("composer-rail").children].map((n) => n.id), rowsBefore, "no new rail row");
  assert.match(chip.textContent, /Pip fixes/);
  assert.ok(chip.hasAttribute("data-live"));
  // A general background agent is not a Pip fix: the chip doesn't count it (it stays in the agents pill).
  s.event({ type: "agent_started", id: "sub-ffffffffffff", parent_id: null, call_id: "c9", description: "map auth",
    depth: 1, state: "running", started_at: now(), isolated: true, parallel: false, background: true });
  assert.match(chip.textContent, /Pip fixes\s*1/);
  chip.click();
  const pop = s.doc.getElementById("rail-pop");
  assert.equal(pop.hidden, false);
  assert.equal(s.doc.getElementById("rail-pop-title").textContent, "Pip fixes");
  assert.deepEqual([...pop.querySelectorAll(".pip-fixes-row")].map((b) => b.textContent), ["ERP daily auditFixing"]);
  pop.querySelector(".pip-fixes-row").click();
  assert.equal(pop.hidden, true, "a row takes you to the card");
  assert.deepEqual([...s.doc.getElementById("composer-rail").children].map((n) => n.id), rowsBefore, "and the list went with it");
  // Ended and looked at, the chip goes.
  s.event({ type: "pip_fix", fix: fix({ state: "unchanged", summary: "Nothing to change." }) });
  assert.ok(s.doc.querySelector('#rail-chips .rail-chip[data-kind="pipfixes"]'), "an end not yet seen stays on the chip");
  s.doc.querySelector('#rail-chips .rail-chip[data-kind="pipfixes"]').click();
  s.doc.getElementById("rail-pop-close").click();
  s.event({ type: "pip_fixes", items: [] });
  assert.equal(s.doc.querySelector('#rail-chips .rail-chip[data-kind="pipfixes"]'), null);
  assert.deepEqual(s.errors, []);
});

test("a card with a fix leaves a folded group of reports: a running fix is never out of sight", () => {
  const s = panel();
  const other = (c) => ({ ...REPORT, run_id: "run_" + c.repeat(32), pip_id: PIP, name: `Pip ${c}` });
  for (const c of ["d", "e"]) s.event({ type: "pip_report", report: other(c) });
  s.event({ type: "pip_report", report: REPORT });
  assert.ok(s.doc.querySelector("#log .pip-report-group"), "three are one line");
  s.event({ type: "pip_fix", fix: fix({ state: "running" }) });
  const fixed = s.doc.querySelector(`#log .pip-report[data-run="${RUN}"]`);
  assert.equal(fixed.closest(".pip-report-group"), null, "the fix's card stands on its own");
  assert.equal(s.doc.querySelector("#log .pip-report-group"), null, "the two left are not a group");
  assert.deepEqual(s.errors, []);
});
