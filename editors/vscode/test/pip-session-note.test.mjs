// The quiet note in a Work session that used to get Pip cards (0.52; pips-flow-design §3.3, item 3, picture 12). With a
// DGC at Pips API 96, a session whose history has Pip report cards says once, above its chat: "Pips report in their
// own chats now", naming the Pips of those cards, each with "Open <its name>". It is not a pop-up, never takes the
// focus and is not in the transcript: nothing is sent to DGC. × closes it for good, and so does opening one of the
// named Pips from it. Remembered per session in the editor's global state (src/pipsWelcome.ts), so every window agrees.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom } from "./support/webview-dom.mjs";
import { DgcViewProvider, cleanup, extensionRoot } from "./support/panel-bundle.mjs";

const SESSION = "20261112-101500-a1";
const pid = (c) => "pip_" + c.repeat(32), rid = (c) => "run_" + c.repeat(32);
const report = (c, name, extra = {}) => ({ run_id: rid(c), pip_id: pid(c), name, pip_type: "scout", kind: "audit", outcome: "findings", finished_at: "2026-11-12T13:00:00.000Z",
  earlier: 0, total: 1, counts: { critical: 0, high: 1, medium: 0, low: 0 }, findings: [{ title: "GST total skips cess", severity: "high", path: "app/gst.py", line: 88 }], ...extra });
const GST = report("a", "GST watchdog"), ERP = report("b", "ERP daily audit");
const TURN = [{ type: "turn_start", turn_id: "h1", prompt: "Set up the audit" }, { type: "text_delta", text: "Done: it runs at 18:30." },
  { type: "stream_end", message_id: "h1:1", phase: "answer" }, { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }];
const cardsOf = (...reports) => [...TURN, ...reports.map((r) => ({ role: "pip_report", report: r }))];

function panel({ api = 96, session = SESSION, place } = {}) {
  const s = makeDom(place ? { place } : {});
  s.event = (event) => s.send({ type: "event", event });
  s.event({ type: "ready", session_id: session, capabilities: { pip_reports: 1, pips_supported: true, pips_enabled: true, ...(api ? { pips_api_version: api } : {}) }, model: "m", mode: "default", think: "off" });
  s.asks = () => JSON.parse(JSON.stringify(s.posted.filter((m) => m.type === "pipSessionNoteAsk")));
  s.gone = () => JSON.parse(JSON.stringify(s.posted.filter((m) => m.type === "pipSessionNoteGone")));
  s.note = () => { const n = s.doc.getElementById("pip-session-note"); return n && !n.hidden && n.childElementCount ? n : null; };
  s.show = (id = session) => s.send({ type: "pipSessionNote", session: id, show: true });
  return s;
}
const words = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
const opens = (note) => [...note.querySelectorAll(".psn-open")].map((b) => b.textContent.trim());

test("a session whose history has Pip cards asks once whether its note is still due, naming the session and nothing else", () => {
  const s = panel();
  s.event({ type: "history", items: cardsOf(GST, ERP) });
  assert.deepEqual(s.asks(), [{ type: "pipSessionNoteAsk", session: SESSION }]);
  assert.equal(s.note(), null, "nothing is drawn until the editor says it was never closed");
  s.event({ type: "history", items: cardsOf(GST, ERP) });          // the same history again (a reconnect)
  assert.equal(s.asks().length, 1, "asked once");
});

test("the note: its words, the Pips of the cards by name, and a way to open each", () => {
  const s = panel();
  s.event({ type: "history", items: cardsOf(GST, ERP, report("c", "GST watchdog", { pip_id: GST.pip_id })) });   // a Pip's second card names it once
  s.show();
  const note = s.note();
  assert.ok(note, "the note");
  assert.equal(words(note.querySelector(".psn-title")), "Pips report in their own chats now");
  assert.equal(words(note.querySelector(".psn-text")), "GST watchdog and ERP daily audit used to post their reports here. From now on they tell you in their own chats, and what needs you is on Home. "
    + "The cards below stay as history. You can still ask about them here, or @ a Pip to give it a job.");
  assert.deepEqual(opens(note), ["Open GST watchdog", "Open ERP daily audit"]);
  assert.equal(note.querySelector(".psn-close").getAttribute("aria-label"), "Close");
  assert.equal(note.getAttribute("role"), "note");
  assert.deepEqual(s.errors, []);
});

test("one Pip reads in the singular; more than three: the first three and \"and N more\"", () => {
  const one = panel();
  one.event({ type: "history", items: cardsOf(GST) });
  one.show();
  assert.equal(words(one.note().querySelector(".psn-text")), "GST watchdog used to post its reports here. From now on it tells you in its own chat, and what needs you is on Home. "
    + "The cards below stay as history. You can still ask about them here, or @ a Pip to give it a job.");
  assert.deepEqual(opens(one.note()), ["Open GST watchdog"]);
  const three = panel();
  three.event({ type: "history", items: cardsOf(GST, ERP, report("c", "Lock review")) });
  three.show();
  assert.match(words(three.note().querySelector(".psn-text")), /^GST watchdog, ERP daily audit and Lock review used to post their reports here\./);
  const five = panel();
  five.event({ type: "history", items: cardsOf(GST, ERP, report("c", "Lock review"), report("d", "Night tests"), report("e", "Docs check")) });
  five.show();
  assert.match(words(five.note().querySelector(".psn-text")), /^GST watchdog, ERP daily audit, Lock review and 2 more used to post their reports here\. From now on they tell you/);
  assert.deepEqual(opens(five.note()), ["Open GST watchdog", "Open ERP daily audit", "Open Lock review"]);
  assert.equal(words(five.note().querySelector(".psn-more")), "and 2 more");
});

test("it is above the chat, not in it: not a message, never the focus, and nothing is sent to DGC", () => {
  const s = panel();
  const input = s.doc.getElementById("input");
  input.focus();
  const focused = s.doc.activeElement;
  s.event({ type: "history", items: cardsOf(GST, ERP) });
  const before = s.posted.length;
  s.show();
  const note = s.note(), log = s.doc.getElementById("log");
  assert.equal(note.closest("#log"), null, "not in the transcript");
  assert.ok(note.compareDocumentPosition(log) & s.dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "above the chat");
  assert.equal(note.closest("[role=dialog], dialog"), null, "not a pop-up");
  assert.equal(s.doc.activeElement, focused, "the focus stays where it was");
  assert.equal(log.querySelectorAll(".pip-report").length, 2, "the cards stay, as history");
  assert.deepEqual(s.posted.slice(before), [], "showing it sends nothing");
  assert.deepEqual(s.posted.filter((m) => ["prompt", "steer", "command"].includes(m.type)), []);
});

test("× closes it for good", () => {
  const s = panel();
  s.event({ type: "history", items: cardsOf(GST, ERP) });
  s.show();
  s.note().querySelector(".psn-close").click();
  assert.equal(s.note(), null);
  assert.deepEqual(s.gone(), [{ type: "pipSessionNoteGone", session: SESSION }]);
  s.show();                                                         // a late answer never brings it back
  assert.equal(s.note(), null);
});

test("opening one of the named Pips from it opens that Pip's chat, and the note goes by itself", () => {
  const side = panel();
  const navigated = [];
  side.dom.window.DgcPips = { mount: () => ({ navigate: (value) => navigated.push(value), setVisible() {} }) };
  side.event({ type: "history", items: cardsOf(GST, ERP) });
  side.show();
  side.note().querySelectorAll(".psn-open")[1].click();
  assert.equal(JSON.stringify(navigated), JSON.stringify([{ pip: ERP.pip_id, section: "chat" }]));
  assert.equal(side.note(), null);
  assert.deepEqual(side.gone(), [{ type: "pipSessionNoteGone", session: SESSION }]);
  const tab = panel({ place: "tab" });
  tab.event({ type: "history", items: cardsOf(GST, ERP) });
  tab.show();
  tab.note().querySelector(".psn-open").click();
  assert.deepEqual(JSON.parse(JSON.stringify(tab.posted.filter((m) => m.type === "openPips"))), [{ type: "openPips", navigation: { pip: GST.pip_id, section: "chat" } }]);
  assert.equal(tab.note(), null);
  assert.equal(tab.gone().length, 1);
});

test("no note: below API 96, in a session without Pip cards, when it was closed before, or for another session's answer", () => {
  const old = panel({ api: 95 });
  old.event({ type: "history", items: cardsOf(GST, ERP) });
  assert.deepEqual(old.asks(), [], "an older DGC still posts cards here");
  old.show();
  assert.equal(old.note(), null);
  const plain = panel();
  plain.event({ type: "history", items: TURN });
  assert.deepEqual(plain.asks(), []);
  plain.show();
  assert.equal(plain.note(), null);
  const closed = panel();
  closed.event({ type: "history", items: cardsOf(GST) });
  closed.send({ type: "pipSessionNote", session: SESSION, show: false });
  assert.equal(closed.note(), null);
  const other = panel();
  other.event({ type: "history", items: cardsOf(GST) });
  other.show("20261101-090000-zz");
  assert.equal(other.note(), null);
});

test("a card that arrives live (a run this chat started) is not a reason for the note; another session takes the note away", () => {
  const live = panel();
  live.event({ type: "history", items: TURN });
  live.event({ type: "pip_report", report: GST });
  assert.deepEqual(live.asks(), []);
  const s = panel();
  s.event({ type: "history", items: cardsOf(GST, ERP) });
  s.show();
  assert.ok(s.note());
  s.event({ type: "session", kind: "new", session_id: "20261114-090000-b2", name: "" });
  assert.equal(s.note(), null, "a new session has no note");
  assert.deepEqual(s.gone(), [], "and the old one's was not closed");
});

test("names are text, never markup", () => {
  const s = panel();
  s.event({ type: "history", items: cardsOf(report("a", '<img src=x onerror="1">Bold</b>')) });
  s.show();
  assert.equal(s.note().querySelector("img, b"), null);
  assert.equal(opens(s.note())[0], 'Open <img src=x onerror="1">Bold</b>');
});

// ---- the host: remembered per session, for every window ----------------------------------------------------------------

const made = [];
after(() => { for (const p of made) { try { p.dispose(); } catch { /* already gone */ } } cleanup(); });
const KEY = "dgc.pipSessionNotesGone";
function memory(initial = {}) { const kept = new Map(Object.entries(initial)); return { kept, get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, v); } }; }
function provider(globalState, { api = 96 } = {}) {
  const context = { extension: { packageJSON: JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8")) }, extensionUri: { fsPath: "/ext" }, subscriptions: [],
    secrets: { async get() {}, async store() {}, async delete() {} }, globalState, workspaceState: { get() {}, async update() {} } };
  const p = new DgcViewProvider(context);
  made.push(p);
  const posted = [];
  p.post = (m) => { posted.push(m); };
  p.webviewReady = true;
  p.lastReadyEvent = { type: "ready", capabilities: { pips_supported: true, pips_enabled: true, pips_api_version: api } };
  p.ensureBackend = () => ({ ready: false, send() { return false; }, sendSetup() { return false; }, request: async () => ({}), dispose() {} });
  return { p, posted, notes: () => posted.filter((m) => m.type === "pipSessionNote") };
}

test("the editor answers that a session's note is due until it is closed, and then never again in any window", async () => {
  const state = memory();
  const one = provider(state), two = provider(state);
  await one.p.onMessage({ type: "pipSessionNoteAsk", session: SESSION });
  assert.deepEqual(one.notes(), [{ type: "pipSessionNote", session: SESSION, show: true }]);
  await one.p.onMessage({ type: "pipSessionNoteGone", session: SESSION });
  assert.deepEqual(state.kept.get(KEY), [SESSION], "kept in the editor's global state, by session");
  await one.p.onMessage({ type: "pipSessionNoteAsk", session: SESSION });
  assert.deepEqual(one.notes()[1], { type: "pipSessionNote", session: SESSION, show: false });
  await two.p.onMessage({ type: "pipSessionNoteAsk", session: SESSION });
  assert.deepEqual(two.notes(), [{ type: "pipSessionNote", session: SESSION, show: false }], "another window agrees");
  await two.p.onMessage({ type: "pipSessionNoteAsk", session: "20261113-090000-c3" });
  assert.deepEqual(two.notes()[1], { type: "pipSessionNote", session: "20261113-090000-c3", show: true }, "another session has its own");
});

test("the editor never says a note is due below API 96, and ignores a session id that is not one", async () => {
  const old = provider(memory(), { api: 95 });
  await old.p.onMessage({ type: "pipSessionNoteAsk", session: SESSION });
  assert.deepEqual(old.notes(), [{ type: "pipSessionNote", session: SESSION, show: false }]);
  const state = memory();
  const x = provider(state);
  await x.p.onMessage({ type: "pipSessionNoteAsk", session: "../../etc" });
  await x.p.onMessage({ type: "pipSessionNoteGone", session: { id: 1 } });
  await x.p.onMessage({ type: "pipSessionNoteGone", session: "a b" });
  assert.deepEqual(x.notes(), []);
  assert.equal(state.kept.get(KEY), undefined);
});

test("what is kept stays small: a closed note is kept once, the newest 2,000", async () => {
  const state = memory({ [KEY]: Array.from({ length: 2000 }, (_, i) => `s${i}`) });
  const x = provider(state);
  await x.p.onMessage({ type: "pipSessionNoteGone", session: "s5" });
  assert.equal(state.kept.get(KEY).length, 2000, "one already kept is not kept twice");
  await x.p.onMessage({ type: "pipSessionNoteGone", session: SESSION });
  const kept = state.kept.get(KEY);
  assert.equal(kept.length, 2000);
  assert.equal(kept.at(-1), SESSION);
  assert.ok(!kept.includes("s0"), "the oldest goes");
});
