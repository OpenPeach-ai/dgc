// Pip reports reach the chat: a finished run of a Pip that reports to this chat is a card IN THE
// TRANSCRIPT where it arrived -- never another row above the composer, never a turn by itself. Ask DGC
// to fix sends one message naming the run, once (reported 19 Oct: filling the box let a second click
// paste the prompt again); Open report opens the Pips view at that run;
// Dismiss removes it and tells the backend, which saves it with the chat. Live (`pip_report`) and
// replay ({role: "pip_report"} in history) go through one renderer, so a reload draws the same card.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const RUN = "run_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32);
const REPORT = {
  run_id: RUN, pip_id: PIP, name: "ERP daily audit", pip_type: "scout", kind: "audit", outcome: "findings",
  finished_at: "2026-10-18T13:00:00.000Z", earlier: 1, total: 5,
  counts: { critical: 0, high: 2, medium: 2, low: 1 },
  findings: [
    { title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 88 },
    { title: "Invoice push retries forever", severity: "high", path: "app/push.py", line: 40 },
    { title: "Rounding drops paise", severity: "medium", path: "app/billing.py", line: 12 },
  ],
};
const FAILED = {
  run_id: "run_" + "c".repeat(32), pip_id: PIP, name: "GST watchdog", pip_type: "scout", kind: "audit",
  outcome: "failed", finished_at: "2026-10-18T13:05:00.000Z", earlier: 0,
  reason: "The project is too big for it to copy for review.",
  detail: "Snapshot exceeds 10,000 entries, 4 MiB per file or 64 MiB total.",
};
const CLEAR = { run_id: "run_" + "d".repeat(32), pip_id: PIP, name: "Lock review", pip_type: "lock", kind: "audit",
  outcome: "clear", finished_at: "2026-10-18T13:10:00.000Z", earlier: 0, total: 0, counts: {}, findings: [] };

function panel() {
  const s = makeDom();
  s.event = (event) => s.send({ type: "event", event });
  s.event({ type: "ready", capabilities: { pip_reports: 1 }, model: "m", mode: "default", think: "off" });
  return s;
}
const cards = (s) => [...s.doc.querySelectorAll("#log .pip-report")];
const composer = (s) => s.doc.getElementById("input").value;
// A card without the class that only says "this came from the saved history".
const shape = (card) => { const copy = card.cloneNode(true); copy.classList.remove("hist"); return copy.outerHTML; };

test("a report is a card in the transcript: the Pip, what it found, the worst findings and its actions", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  const [card] = cards(s);
  assert.ok(card, "a card in #log");
  assert.equal(card.closest("#log"), s.doc.getElementById("log"));
  assert.equal(s.doc.querySelector("#composer-rail .pip-report, #cbox .pip-report"), null, "never above the composer");
  assert.equal(card.querySelector(".pip-report-name").textContent, "ERP daily audit");
  assert.equal(card.querySelector(".pip-report-state").textContent, "finished · 5 findings (2 high, 2 medium, 1 low)");
  assert.deepEqual([...card.querySelectorAll(".pip-report-findings li")].map((li) => li.textContent),
    ["highGST total skips cessapp/gst.py:88", "highInvoice push retries foreverapp/push.py:40",
     "mediumRounding drops paiseapp/billing.py:12"]);
  assert.equal(card.querySelector(".pip-report-more").textContent, "2 more in the report · 1 earlier run not shown");
  assert.deepEqual([...card.querySelectorAll(".pip-report-actions button")].map((b) => b.textContent),
    ["Ask DGC to fix", "Open report", "Dismiss"]);
  assert.match(card.getAttribute("aria-label"), /ERP daily audit: finished · 5 findings/);
  assert.deepEqual(s.errors, []);
});

const prompts = (s, from = 0) => s.posted.slice(from).filter((m) => m.type === "prompt");

test("Ask DGC to fix sends one message naming the run, and only once", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  const before = s.posted.length;
  const fix = cards(s)[0].querySelector(".pip-report-fix");
  fix.click();
  const sent = prompts(s, before);
  assert.equal(sent.length, 1, "one message");
  assert.equal(sent[0].delivery, "queue", "behind a turn that is running, never steering into it");
  assert.match(sent[0].text, /^Pip “ERP daily audit” reported 5 findings \(2 high, 2 medium, 1 low\) in run run_a{32}\./);
  assert.match(sent[0].text, /pips_context \(action "report", run_id "run_a{32}"\)/);
  assert.match(sent[0].text, /Ask me before you change any live data or services\./);
  assert.ok(fix.disabled, "a second click can't send it again");
  assert.equal(fix.textContent, "Asked DGC");
  fix.click();
  assert.equal(prompts(s, before).length, 1);
  assert.equal(composer(s), "", "the box is left alone");
  assert.ok([...s.doc.querySelectorAll("#log .msg.user .bubble")].some((b) => b.textContent.includes(`run ${RUN}`)),
    "the message is in the chat");
  assert.equal(cards(s).length, 1, "the card stays");
  assert.deepEqual(s.errors, []);
});

test("Ask DGC to fix never touches a draft the user is writing", () => {
  const s = panel();
  const input = s.doc.getElementById("input");
  input.value = "Also look at the login page";
  input.dispatchEvent(new s.dom.window.Event("input", { bubbles: true }));
  s.event({ type: "pip_report", report: FAILED });
  const before = s.posted.length;
  cards(s)[0].querySelector(".pip-report-fix").click();
  assert.equal(composer(s), "Also look at the login page");
  const [sent] = prompts(s, before);
  assert.match(sent.text, /Pip “GST watchdog” failed \(run run_c{32}\): The project is too big for it to copy for review\./);
  assert.doesNotMatch(sent.text, /login page/);
});

test("a report already asked about says so when the chat opens again", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  cards(s)[0].querySelector(".pip-report-fix").click();
  // The chat drawn again from its history: the prompt naming the run is there, then the card.
  const fresh = panel();
  const bubble = fresh.doc.createElement("div"); bubble.className = "msg user";
  bubble.innerHTML = `<div class="bubble">Pip “ERP daily audit” reported 5 findings in run ${RUN}.</div>`;
  fresh.doc.getElementById("log").append(bubble);
  fresh.event({ type: "pip_report", report: REPORT });
  const fix = cards(fresh)[0].querySelector(".pip-report-fix");
  assert.ok(fix.disabled);
  assert.equal(fix.textContent, "Asked DGC");
});

test("a failed run says it failed, why, and what the saved error was", () => {
  const s = panel();
  s.event({ type: "pip_report", report: FAILED });
  const [card] = cards(s);
  assert.equal(card.dataset.outcome, "failed");
  assert.equal(card.querySelector(".pip-report-state").textContent, "failed: the project is too big for it to copy for review.");
  assert.equal(card.querySelector(".pip-report-detail").textContent, FAILED.detail);
});

test("a clean run is one quiet line with no fix to ask for", () => {
  const s = panel();
  s.event({ type: "pip_report", report: CLEAR });
  const [card] = cards(s);
  assert.ok(card.classList.contains("quiet"));
  assert.equal(card.querySelector(".pip-report-state").textContent, "finished · nothing found");
  assert.equal(card.querySelector(".pip-report-fix, .pip-report-fix-slim"), null, "no fix to ask for");
  assert.deepEqual([...card.querySelectorAll(".pip-report-slim-actions button")].map((b) => b.textContent || b.getAttribute("aria-label")),
    ["Open", "Dismiss"], "its one line carries Open and ✕");
  assert.equal(card.querySelector(".pip-report-line2"), null, "one line");
});

// Reported 19 Oct: the cards took too much room ("just 2 lines"); three that arrive together are one line.
test("a report is two lines until opened: what it found, then the worst finding with Fix, Open and ✕", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  const [card] = cards(s);
  assert.equal(card.dataset.shown, "closed");
  const line1 = card.querySelector(".pip-report-line1"), line2 = card.querySelector(".pip-report-line2");
  assert.equal(line1.querySelector(".pip-report-line-name").textContent, "ERP daily audit");
  assert.equal(line1.querySelector(".pip-report-line-state").textContent, "5 findings · 2 high");
  assert.equal(line2.querySelector(".pip-report-sev").textContent, "high");
  assert.equal(line2.querySelector(".pip-report-line-what").textContent, "GST total skips cess");
  assert.equal(line2.querySelector(".pip-report-where").textContent, "app/gst.py:88");
  assert.deepEqual([...line2.querySelectorAll("button")].map((b) => b.textContent || b.getAttribute("aria-label")), ["Fix", "Open", "Dismiss"]);
  line1.click();
  assert.equal(card.dataset.shown, "open", "a click opens the whole card");
  assert.equal(line1.getAttribute("aria-expanded"), "true");
  line1.dispatchEvent(new s.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  assert.equal(card.dataset.shown, "closed", "Enter closes it again");
  const before = s.posted.filter((m) => m.type === "prompt").length;
  line2.querySelector(".pip-report-fix-slim").click();
  assert.equal(s.posted.filter((m) => m.type === "prompt").length, before + 1, "Fix sends the message");
  assert.equal(card.dataset.shown, "closed", "pressing Fix doesn't open the card");
  assert.deepEqual([...card.querySelectorAll(".pip-report-fix, .pip-report-fix-slim")].map((b) => [b.textContent, b.disabled]),
    [["Asked DGC", true], ["Asked DGC", true]]);
});

test("a failed run's second line says why", () => {
  const s = panel();
  s.event({ type: "pip_report", report: FAILED });
  const [card] = cards(s);
  assert.equal(card.querySelector(".pip-report-line-state").textContent, "failed");
  assert.equal(card.querySelector(".pip-report-line2 .pip-report-sev").textContent, "why");
  assert.equal(card.querySelector(".pip-report-line-what").textContent, FAILED.reason);
});

test("two or more reports that arrive together are one line, opened to their rows; one alone is a card", () => {
  // Reported 24 Oct: the folded line was perfect, but two reports still stacked as two cards. It starts at two.
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  assert.equal(s.doc.querySelector("#log .pip-report-group"), null, "one card is not grouped");
  s.event({ type: "pip_report", report: FAILED });
  let group = s.doc.querySelector("#log .pip-report-group");
  assert.ok(group, "two are one line");
  assert.equal(group.querySelectorAll(":scope > .pip-report").length, 2);
  assert.equal(group.querySelector(".pip-report-group-title").textContent, "2 Pip reports · 1 failed · 5 findings");
  s.event({ type: "pip_report", report: CLEAR });
  group = s.doc.querySelector("#log .pip-report-group");
  assert.equal(s.doc.querySelectorAll("#log .pip-report-group").length, 1, "the third joins the same line");
  assert.equal(group.querySelectorAll(":scope > .pip-report").length, 3);
  assert.equal(group.querySelector(".pip-report-group-title").textContent, "3 Pip reports · 1 failed · 5 findings · 1 clear");
  assert.equal(group.dataset.shown, "closed");
  group.querySelector(".pip-report-group-head").click();
  assert.equal(group.dataset.shown, "open");
  // Dismissing one leaves two: still one line. Dismissing another leaves one card on its own.
  group.querySelector(".pip-report[data-outcome='clear'] .pip-report-dismiss-slim").click();
  group = s.doc.querySelector("#log .pip-report-group");
  assert.ok(group, "two left are still one line");
  assert.equal(group.querySelector(".pip-report-group-title").textContent, "2 Pip reports · 1 failed · 5 findings");
  group.querySelector(".pip-report[data-outcome='failed'] .pip-report-dismiss-slim").click();
  assert.equal(s.doc.querySelector("#log .pip-report-group"), null, "one left is a card again");
  assert.equal(cards(s).length, 1);
  assert.deepEqual(s.errors, []);
});

test("Open report opens the Pips view at that run", () => {
  const s = panel();
  const navigated = [];
  s.dom.window.DgcPips = { mount: () => ({ navigate: (value) => navigated.push(value), setVisible() {} }) };
  s.event({ type: "pip_report", report: REPORT });
  cards(s)[0].querySelector(".pip-report-open").click();
  assert.equal(JSON.stringify(navigated), JSON.stringify([{ pip: PIP, section: "runs", run: RUN }]));
  assert.equal(s.doc.getElementById("pips-host").hidden, false);
});

test("Dismiss removes the card and tells the backend; the saved chat no longer has it", () => {
  const s = panel();
  s.event({ type: "pip_report", report: REPORT });
  cards(s)[0].querySelector(".pip-report-dismiss").click();
  assert.equal(cards(s).length, 0);
  assert.equal(JSON.stringify(s.posted.filter((m) => m.type === "pipReportDismiss")), JSON.stringify([{ type: "pipReportDismiss", run_id: RUN }]));
  // The backend saves it dismissed, so a reopened chat's history leaves it out.
  s.event({ type: "history", items: [{ type: "turn_start", turn_id: "h1", prompt: "Set up the audit" },
    { type: "text_delta", text: "Done." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }] });
  assert.equal(cards(s).length, 0);
});

test("Dismiss is not sent to a backend that cannot save it", () => {
  const s = makeDom();
  s.send({ type: "event", event: { type: "ready", capabilities: {}, model: "m" } });
  s.send({ type: "event", event: { type: "pip_report", report: REPORT } });
  s.doc.querySelector(".pip-report-dismiss").click();
  assert.equal(s.posted.some((m) => m.type === "pipReportDismiss"), false);
});

test("a report that comes during a turn goes under it and the turn carries on, uninterrupted", () => {
  const s = panel();
  s.event({ type: "turn_start", turn_id: "t1", prompt: "Refactor the parser" });
  s.event({ type: "text_delta", text: "Reading the parser. " });
  s.event({ type: "pip_report", report: REPORT });
  s.event({ type: "text_delta", text: "Done refactoring." });
  s.event({ type: "stream_end", message_id: "t1:1", phase: "answer" });
  s.event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1" });
  const [card] = cards(s);
  const block = s.doc.querySelector("#log .msg.dgc");
  assert.equal(block.contains(card), false, "never inside the turn's block");
  assert.match(block.textContent, /Reading the parser\. Done refactoring\./, "the answer is one piece, not cut by the card");
  assert.ok(block.compareDocumentPosition(card) & s.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "after the turn");
  assert.equal(s.posted.some((m) => m.type === "cancel" || m.type === "stop"), false);
  assert.deepEqual(s.errors, []);
});

test("replay draws the card the live event drew, once, after the same turn", () => {
  const turn = [{ type: "turn_start", turn_id: "h1", prompt: "Set up the audit" },
    { type: "text_delta", text: "Done: it runs at 18:30." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }];
  const live = panel();
  live.event({ type: "history", items: turn });
  live.event({ type: "pip_report", report: REPORT });
  live.event({ type: "pip_report", report: FAILED });
  const replay = panel();
  replay.event({ type: "history", items: [...turn, { role: "pip_report", report: REPORT }, { role: "pip_report", report: FAILED }] });
  assert.deepEqual(cards(replay).map(shape), cards(live).map(shape));
  // The live chat gets the same history again (a reconnect): the saved cards replace the live ones.
  live.event({ type: "history", items: [...turn, { role: "pip_report", report: REPORT }, { role: "pip_report", report: FAILED }] });
  assert.equal(cards(live).length, 2, "one card per run");
  assert.deepEqual(cards(live).map(shape), cards(replay).map(shape));
  for (const s of [live, replay]) {
    const block = s.doc.querySelector("#log .msg.dgc");
    assert.ok(cards(s).every((card) => block.compareDocumentPosition(card) & s.dom.window.Node.DOCUMENT_POSITION_FOLLOWING));
    assert.deepEqual(s.errors, []);
  }
});

test("a malformed report draws nothing", () => {
  const s = panel();
  for (const report of [null, { ...REPORT, run_id: "run_x" }, { ...REPORT, outcome: "fixed" }, { ...REPORT, pip_type: "x" },
    { ...REPORT, name: "" }]) s.event({ type: "pip_report", report });
  s.event({ type: "history", items: [{ role: "pip_report", report: { ...REPORT, pip_id: "nope" } }] });
  assert.equal(cards(s).length, 0);
  assert.deepEqual(s.errors, []);
});

test("names and findings are text, never markup", () => {
  const s = panel();
  s.event({ type: "pip_report", report: { ...REPORT, name: '<img src=x onerror="bad()">',
    findings: [{ title: "<b>bold</b>", severity: "high", path: "<i>p</i>", line: 1 }] } });
  const [card] = cards(s);
  assert.equal(card.querySelector("img, b, i"), null);
  assert.equal(card.querySelector(".pip-report-title").textContent, "<b>bold</b>");
});
