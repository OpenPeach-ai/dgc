// Report cards in Work chats go quiet (0.52; pips-flow-design §3.1, "Report cards already in Work chats"). With a DGC
// at Pips API 96 a Pip tells you what it finds in its own chat, so a report card in a Work chat (an old one in the
// history, or one that still comes for a run this chat started) is history: no "Ask DGC to fix", no Dismiss, and one
// quiet "Open in its chat" that opens that Pip's chat in the Pips view. Its words and findings stay as they are. A
// finished fix keeps Review and Undo. Below API 96 nothing changes. And the Pips view never offers the old "Ask DGC
// to fix" (onAskDgc, report_session) at API 96.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";
import { setup as openPips } from "./support/one-pips-node.mjs";
import { GST } from "./support/one-pips-scene.mjs";

const RUN = "run_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), FIX = "fix_" + "9".repeat(32);
const REPORT = {
  run_id: RUN, pip_id: PIP, name: "ERP daily audit", pip_type: "scout", kind: "audit", outcome: "findings",
  finished_at: "2026-11-12T13:00:00.000Z", earlier: 1, total: 5, counts: { critical: 0, high: 2, medium: 2, low: 1 },
  findings: [
    { title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 88 },
    { title: "Invoice push retries forever", severity: "high", path: "app/push.py", line: 40 },
    { title: "Rounding drops paise", severity: "medium", path: "app/billing.py", line: 12 },
  ],
};
const FAILED = { run_id: "run_" + "c".repeat(32), pip_id: "pip_" + "1".repeat(32), name: "GST watchdog", pip_type: "scout", kind: "audit",
  outcome: "failed", finished_at: "2026-11-12T13:05:00.000Z", earlier: 0, reason: "The project is too big for it to copy for review.",
  detail: "Snapshot exceeds 10,000 entries, 4 MiB per file or 64 MiB total." };
const SIGN_IN = { ...FAILED, run_id: "run_" + "e".repeat(32), pip_id: "pip_" + "3".repeat(32), name: "Morning check", sign_in: true, reason: "Its model provider turned down the key." };
const CLEAR = { run_id: "run_" + "d".repeat(32), pip_id: "pip_" + "2".repeat(32), name: "Lock review", pip_type: "lock", kind: "audit",
  outcome: "clear", finished_at: "2026-11-12T13:10:00.000Z", earlier: 0, total: 0, counts: {}, findings: [] };

function panel(api, { place, fix = false } = {}) {
  const s = makeDom(place ? { place } : {});
  s.event = (event) => s.send({ type: "event", event });
  s.event({ type: "ready", session_id: "20261112-101500-a1", capabilities: { pip_reports: 1, ...(fix ? { pip_fix: 1 } : {}), ...(api ? { pips_supported: true, pips_enabled: true, pips_api_version: api } : {}) },
    model: "m", mode: "default", think: "off" });
  return s;
}
const cards = (s) => [...s.doc.querySelectorAll("#log .pip-report")];
const labels = (card, where) => [...card.querySelectorAll(`${where} button`)].map((b) => b.textContent.trim() || b.getAttribute("aria-label"));
const everyButton = (card) => [...card.querySelectorAll("button")].map((b) => b.textContent.trim() || b.getAttribute("aria-label"));
const shape = (card) => { const copy = card.cloneNode(true); copy.classList.remove("hist"); return copy.outerHTML; };

test("at API 96 a report card has one answer, Open in its chat: no Ask DGC to fix, no Fix, no Dismiss, no Open report", () => {
  const s = panel(96);
  s.event({ type: "pip_report", report: REPORT });
  const [card] = cards(s);
  assert.ok(card);
  assert.deepEqual(labels(card, ".pip-report-actions"), ["Open in its chat"], "opened");
  assert.deepEqual(labels(card, ".pip-report-slim-actions"), ["Open in its chat"], "closed, on its second line");
  assert.equal(card.querySelector(".pip-report-fix, .pip-report-fix-slim, .pip-report-dismiss-slim, .pip-report-open, .pip-report-open-slim"), null);
  assert.ok(!everyButton(card).some((t) => /fix|dismiss/i.test(t)), `no fix and no dismiss anywhere on it: ${everyButton(card)}`);
  assert.deepEqual(s.errors, []);
});

test("its words and findings stay exactly as they were", () => {
  const now = panel(96), before = panel(0);
  for (const s of [now, before]) s.event({ type: "pip_report", report: REPORT });
  const read = (s) => { const card = cards(s)[0]; return { name: card.querySelector(".pip-report-name").textContent, state: card.querySelector(".pip-report-state").textContent,
    findings: [...card.querySelectorAll(".pip-report-findings li")].map((li) => li.textContent), more: card.querySelector(".pip-report-more").textContent, all: card.querySelector(".pip-report-all").textContent,
    line: card.querySelector(".pip-report-line-state").textContent, what: card.querySelector(".pip-report-line-what").textContent, label: card.getAttribute("aria-label") }; };
  assert.deepEqual(read(now), read(before));
  assert.equal(read(now).state, "finished · 5 findings (2 high, 2 medium, 1 low)");
});

test("Open in its chat opens that Pip's chat in the Pips view, from the side bar and from a session's tab; it never sends a message", () => {
  const side = panel(96);
  const navigated = [];
  side.dom.window.DgcPips = { mount: () => ({ navigate: (value) => navigated.push(value), setVisible() {} }) };
  side.event({ type: "pip_report", report: REPORT });
  cards(side)[0].querySelector(".pip-report-chat").click();
  assert.equal(JSON.stringify(navigated), JSON.stringify([{ pip: PIP, section: "chat" }]));
  assert.equal(side.doc.getElementById("pips-host").hidden, false);
  const tab = panel(96, { place: "tab" });
  tab.event({ type: "pip_report", report: REPORT });
  cards(tab)[0].querySelector(".pip-report-chat-slim").click();
  assert.deepEqual(JSON.parse(JSON.stringify(tab.posted.filter((m) => m.type === "openPips"))), [{ type: "openPips", navigation: { pip: PIP, section: "chat" } }]);
  for (const s of [side, tab]) assert.deepEqual(s.posted.filter((m) => ["prompt", "pipReportDismiss", "startPipFix"].includes(m.type)), [], "nothing is asked of DGC");
});

test("a failed run, a sign-in failure and a clean run: the same one answer", () => {
  const s = panel(96);
  for (const report of [FAILED, SIGN_IN, CLEAR]) s.event({ type: "pip_report", report });
  const all = cards(s);
  assert.equal(all.length, 3);
  for (const card of all) {
    assert.deepEqual(labels(card, ".pip-report-actions"), ["Open in its chat"], card.dataset.outcome);
    assert.deepEqual(labels(card, ".pip-report-slim-actions"), ["Open in its chat"], card.dataset.outcome);
    assert.equal(card.querySelector(".pip-report-dismiss-slim, .pip-report-signin, .pip-report-signin-slim, .pip-report-fix-slim"), null);
  }
  assert.equal(all[0].querySelector(".pip-report-state").textContent.startsWith("failed"), true, "it still says it failed, and why");
});

test("an old card in the history is drawn as a live one is", () => {
  const live = panel(96), replay = panel(96);
  live.event({ type: "pip_report", report: REPORT });
  replay.event({ type: "history", items: [{ role: "pip_report", report: REPORT }] });
  assert.deepEqual(cards(replay).map(shape), cards(live).map(shape));
  assert.deepEqual(labels(cards(replay)[0], ".pip-report-actions"), ["Open in its chat"]);
});

test("a prompt that named the run (an old Ask DGC to fix) leaves the card as it is: nothing to mark as asked", () => {
  const s = panel(96);
  s.event({ type: "history", items: [{ role: "pip_report", report: REPORT },
    { type: "turn_start", turn_id: "h1", prompt: `Pip “ERP daily audit” reported 5 findings in run ${RUN}.` },
    { type: "text_delta", text: "Fixed." }, { type: "stream_end", message_id: "h1:1", phase: "answer" }, { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }] });
  assert.deepEqual(everyButton(cards(s)[0]).filter((t) => /asked|fix/i.test(t)), []);
  assert.deepEqual(s.errors, []);
});

test("a finished fix keeps Review and Undo; a failed one offers no Try again", () => {
  const fix = (fields) => ({ fix_id: FIX, run_id: RUN, pip_id: PIP, name: "ERP daily audit", pip_type: "scout", created_at: Date.now() / 1000 - 90, ...fields });
  const done = panel(96, { fix: true });
  done.event({ type: "pip_report", report: REPORT });
  done.event({ type: "pip_fix", fix: fix({ state: "applied", started_at: Date.now() / 1000 - 80, ended_at: Date.now() / 1000 - 10, summary: "Cess is added to the GST total.",
    files: [{ path: "app/gst.py", kind: "edited", additions: 4, deletions: 1 }], tests: { state: "passed", command: "pytest -q" }, undo: { state: "available" } }) });
  const texts = everyButton(cards(done)[0]);
  assert.ok(texts.includes("Review") && texts.includes("Undo"), `Review and Undo: ${texts}`);
  assert.ok(!texts.some((t) => /try again|ask dgc|^fix$/i.test(t)), `nothing starts another fix: ${texts}`);
  const failed = panel(96, { fix: true });
  failed.event({ type: "pip_report", report: REPORT });
  failed.event({ type: "pip_fix", fix: fix({ state: "failed", started_at: Date.now() / 1000 - 80, ended_at: Date.now() / 1000 - 10, error: "The tests did not pass." }) });
  assert.ok(!everyButton(cards(failed)[0]).some((t) => /try again|ask dgc|^fix$/i.test(t)), `no Try again: ${everyButton(cards(failed)[0])}`);
  // (Below API 96 a failed fix still offers it.)
  const old = panel(95, { fix: true });
  old.event({ type: "pip_report", report: REPORT });
  old.event({ type: "pip_fix", fix: fix({ state: "failed", started_at: Date.now() / 1000 - 80, ended_at: Date.now() / 1000 - 10, error: "The tests did not pass." }) });
  assert.ok(everyButton(cards(old)[0]).includes("Try again"));
});

test("below API 96 the card is unchanged: Ask DGC to fix, Open report and its ✕", () => {
  for (const api of [0, 95]) {
    const s = panel(api);
    s.event({ type: "pip_report", report: REPORT });
    const [card] = cards(s);
    assert.deepEqual(labels(card, ".pip-report-actions"), ["Ask DGC to fix", "Open report"], `API ${api}`);
    assert.deepEqual(labels(card, ".pip-report-slim-actions"), ["Fix", "Open"], `API ${api}`);
    assert.ok(card.querySelector(".pip-report-dismiss-slim"), "Dismiss");
    assert.equal(card.querySelector(".pip-report-chat, .pip-report-chat-slim"), null);
  }
});

// ---- the Pips view ------------------------------------------------------------------------------------------------------

const windows = [];
after(() => windows.forEach((w) => w.close()));

test("the Pips view at API 96 never offers Ask DGC to fix, even when the page gives it the old way to ask", async () => {
  const asked = [];
  const x = openPips({ api: 96, scene: { fix: "ask" }, host: { onAskDgc: (ask) => { asked.push(ask); return true; } } });
  windows.push(x.w);
  await x.drain();
  await x.openPip(GST);
  assert.ok(x.$("article.run-post"), "the check's post is there");
  assert.doesNotMatch(x.text(), /Ask DGC to fix/);
  assert.equal(x.$("[data-ask-dgc], #ask-dgc, .ask-dgc"), null);
  assert.deepEqual(asked, []);
});
