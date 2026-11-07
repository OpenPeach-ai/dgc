// One card per Pip (reported 7 Nov): a Project Pip that runs at 8 AM and 8 PM left two "requires Fix" cards in the chat
// for one problem, and kept the morning failure's Fix after the evening run had worked. Now a Pip's newer card takes the
// place of its older ones: a failure after a failure says "failed again", a clean run after a problem says "fixed", and the
// opened card says what it replaced. A card someone acted on (a fix started, its prompt sent) stays. A failure that
// nothing in the project can fix, a refused key or sign-in, offers Check sign-in instead of Fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const PIP = "pip_" + "b".repeat(32), OTHER = "pip_" + "e".repeat(32);
const run = (c) => "run_" + c.repeat(32);
const base = { pip_id: PIP, name: "ERP daily audit", pip_type: "scout", kind: "audit", earlier: 0 };
const failedAt = (c, at, extra = {}) => ({ ...base, run_id: run(c), outcome: "failed", finished_at: at,
  reason: "Its model provider turned down the API key.", detail: "HTTP 401 from Responses API: {\"error\": {}}", ...extra });
const findingsAt = (c, at) => ({ ...base, run_id: run(c), outcome: "findings", finished_at: at, total: 5,
  counts: { high: 2, medium: 3 }, findings: [{ title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 88 }] });
const clearAt = (c, at) => ({ ...base, run_id: run(c), outcome: "clear", finished_at: at, total: 0, counts: {}, findings: [] });
const MORNING = "2026-11-07T02:30:00.000Z", EVENING = "2026-11-07T14:34:00.000Z", LATER = "2026-11-07T20:00:00.000Z";

function panel(capabilities = { pip_reports: 1 }) {
  const s = makeDom();
  s.event = (event) => s.send({ type: "event", event });
  s.event({ type: "ready", capabilities, model: "m", mode: "default", think: "off", session_id: "s1" });
  s.send({ type: "session_ready", sessionId: "s1" });
  return s;
}
const cards = (s) => [...s.doc.querySelectorAll("#log .pip-report")];
const posted = (s, type, from = 0) => JSON.parse(JSON.stringify(s.posted.slice(from).filter((m) => m.type === type)));
const lineState = (card) => card.querySelector(".pip-report-line-state").textContent;

test("a Pip's newer card takes the place of its older one; the older run counts as read; other Pips keep theirs", () => {
  const s = panel();
  s.event({ type: "pip_report", report: { ...findingsAt("9", MORNING), pip_id: OTHER, name: "GST watchdog" } });
  s.event({ type: "pip_report", report: failedAt("a", MORNING) });
  const before = s.posted.length;
  s.event({ type: "pip_report", report: findingsAt("c", EVENING) });
  assert.deepEqual(cards(s).map((c) => c.dataset.run), [run("9"), run("c")], "one card for each Pip");
  assert.deepEqual(posted(s, "pipReportRead", before), [{ type: "pipReportRead", pip_id: PIP, run_id: run("a") }]);
  const card = cards(s)[1];
  assert.equal(lineState(card), "5 findings · 2 high", "line one is the newest run's");
  assert.match(card.querySelector(".pip-report-more").textContent, /(^| · )Earlier: failed · \S/);
  assert.deepEqual(s.errors, []);
});

test("a failure after a failure is one card that says so: failed again", () => {
  const s = panel();
  s.event({ type: "pip_report", report: failedAt("a", MORNING) });
  s.event({ type: "pip_report", report: failedAt("c", EVENING) });
  let [card] = cards(s);
  assert.equal(cards(s).length, 1);
  assert.equal(lineState(card), "failed again");
  assert.equal(card.querySelector(".pip-report-state").textContent, "failed again: its model provider turned down the API key.");
  s.event({ type: "pip_report", report: failedAt("d", LATER) });
  [card] = cards(s);
  assert.equal(cards(s).length, 1);
  assert.equal(lineState(card), "failed again", "never a count");
  assert.match(card.querySelector(".pip-report-more").textContent, /^Earlier: failed · .+, and 1 older card$/);
});

test("a clean run after a problem says fixed, with no Fix to press", () => {
  const s = panel();
  s.event({ type: "pip_report", report: findingsAt("a", MORNING) });
  s.event({ type: "pip_report", report: clearAt("c", EVENING) });
  const [card] = cards(s);
  assert.equal(cards(s).length, 1);
  assert.equal(lineState(card), "fixed · nothing found");
  assert.ok("good" in card.querySelector(".pip-report-line-state").dataset, "said in the good colour");
  assert.ok("fixed" in card.dataset);
  assert.equal(card.querySelector(".pip-report-fix, .pip-report-fix-slim"), null);
  assert.match(card.querySelector(".pip-report-more").textContent, /^Earlier: 5 findings · \S/);
  assert.match(card.getAttribute("aria-label"), /fixed · nothing found/);
});

test("a clean run after a clean one is just the newest, not fixed", () => {
  const s = panel();
  s.event({ type: "pip_report", report: clearAt("a", MORNING) });
  s.event({ type: "pip_report", report: clearAt("c", EVENING) });
  assert.equal(cards(s).length, 1);
  assert.equal(lineState(cards(s)[0]), "nothing found");
});

test("a card whose prompt was sent stays; the newer card comes in beside it", () => {
  const s = panel();
  s.event({ type: "pip_report", report: findingsAt("a", MORNING) });
  cards(s)[0].querySelector(".pip-report-fix-slim").click();
  assert.equal(posted(s, "prompt").length, 1, "its prompt went to the chat");
  s.event({ type: "pip_report", report: findingsAt("c", EVENING) });
  assert.deepEqual(cards(s).map((c) => c.dataset.run), [run("a"), run("c")]);
  assert.equal(cards(s)[1].querySelector(".pip-report-more").textContent.includes("Earlier"), false, "it replaced nothing");
});

test("a card with a fix started from it stays: its card is the fix's status", () => {
  const s = panel({ pip_reports: 1, pip_fix: 1, agents: true, agent_control: true });
  const fix = { fix_id: "fix_" + "f".repeat(32), run_id: run("a"), pip_id: PIP, name: "ERP daily audit", pip_type: "scout",
    agent_id: "sub-0123456789ab", created_at: Date.now() / 1000 - 30, state: "running" };
  s.event({ type: "pip_report", report: { ...findingsAt("a", MORNING), fix } });
  s.event({ type: "pip_report", report: findingsAt("c", EVENING) });
  assert.deepEqual(cards(s).map((c) => c.dataset.run), [run("a"), run("c")]);
  assert.deepEqual(s.errors, []);
});

test("an older run arriving after a newer one never replaces it", () => {
  const s = panel();
  s.event({ type: "pip_report", report: findingsAt("c", EVENING) });
  s.event({ type: "pip_report", report: failedAt("a", MORNING) });
  assert.equal(cards(s).some((c) => c.dataset.run === run("c")), true, "the newer card is still there");
});

test("Dismiss takes the cards it replaced with it, so a reload can't bring one back", () => {
  const s = panel();
  s.event({ type: "pip_report", report: failedAt("a", MORNING) });
  s.event({ type: "pip_report", report: failedAt("c", EVENING) });
  const before = s.posted.length;
  cards(s)[0].querySelector(".pip-report-dismiss-slim").click();
  assert.equal(cards(s).length, 0);
  assert.deepEqual(posted(s, "pipReportDismiss", before).map((m) => m.run_id), [run("a"), run("c")]);
});

test("a reopened chat draws one card per Pip, and an older page drawn later brings no old card back", () => {
  const s = panel();
  const turn = (i) => [{ type: "turn_start", turn_id: `h${i}`, prompt: `Question ${i}` }, { type: "text_delta", text: `Answer ${i}.` },
    { type: "stream_end", message_id: `h${i}:1`, phase: "answer" },
    { type: "turn_end", turn_id: `h${i}`, reason: "completed", final_message_id: `h${i}:1` }];
  const items = [{ role: "pip_report", report: findingsAt("1", "2026-11-05T14:30:00.000Z") }];
  for (let i = 0; i < 20; i++) items.push(...turn(i));
  items.push({ role: "pip_report", report: failedAt("a", MORNING) }, ...turn(98),
             { role: "pip_report", report: findingsAt("c", EVENING) }, ...turn(99));
  s.event({ type: "history", items });
  assert.deepEqual(cards(s).map((c) => c.dataset.run), [run("c")], "the newest page: the evening card took the morning's place");
  const older = s.doc.querySelector("#log .history-older");
  assert.ok(older && !older.hidden, "there is an older page");
  older.click();
  assert.ok(s.doc.body.textContent.includes("Question 0"), "the older page is drawn");
  assert.deepEqual(cards(s).map((c) => c.dataset.run), [run("c")], "its old card isn't drawn again");
  assert.deepEqual(s.errors, []);
});

test("a refused key or sign-in offers Check sign-in, which opens Settings at Models, instead of Fix", () => {
  const s = panel();
  s.event({ type: "pip_report", report: failedAt("a", MORNING, { sign_in: true }) });
  const [card] = cards(s);
  assert.equal(card.querySelector(".pip-report-fix, .pip-report-fix-slim"), null, "nothing in the project to fix");
  assert.deepEqual([...card.querySelectorAll(".pip-report-slim-actions button")].map((b) => b.textContent || b.getAttribute("aria-label")),
    ["Check sign-in", "Dismiss"], "beside the wider Check sign-in only ✕: it fits a 300 px side bar");
  assert.deepEqual([...card.querySelectorAll(".pip-report-actions button")].map((b) => b.textContent),
    ["Check sign-in", "Open report", "Dismiss"]);
  const before = s.posted.length;
  card.querySelector(".pip-report-signin-slim").click();
  assert.deepEqual(posted(s, "openSettings", before), [{ type: "openSettings", section: "models" }]);
  assert.deepEqual(posted(s, "pipReportRead", before), [{ type: "pipReportRead", pip_id: PIP, run_id: run("a") }]);
  // Any other failure still offers Fix.
  const t = panel();
  t.event({ type: "pip_report", report: failedAt("c", EVENING) });
  assert.ok(cards(t)[0].querySelector(".pip-report-fix-slim"));
});

test("pressing Fix keeps the card even before the background fix has started", () => {
  const s = panel({ pip_reports: 1, pip_fix: 1, agents: true, agent_control: true });
  s.event({ type: "pip_report", report: findingsAt("a", MORNING) });
  cards(s)[0].querySelector(".pip-report-fix-slim").click();
  assert.equal(posted(s, "startPipFix").length, 1);
  s.event({ type: "pip_report", report: findingsAt("c", EVENING) });          // before the fix's first pip_fix arrives
  assert.deepEqual(cards(s).map((c) => c.dataset.run), [run("a"), run("c")]);
});
