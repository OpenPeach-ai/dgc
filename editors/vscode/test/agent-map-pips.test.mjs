// The agent map's Pips section (0.52, pips-flow-design Q2, picture 9), in the webview. Under a Work session's own
// helpers and background tasks the map says which Pips are related to this session and what they are doing: first the
// Pips working on a job this session gave them ("for this session", with Stop), then the related Pips that are running
// or need you (with Open, their chat), then one quiet line counting the rest ("2 more Pips in this folder are idle ·
// 5 Pips elsewhere · All Pips"). No session owns a Pip: nothing here is chosen, and there is no report card, Allow or
// Apply on the map. Hide / Show is one word, remembered by the editor. The map's button shows its live mark while a
// Pip works for this session. A DGC before Pips API 96 is never asked and shows no section. The host's half (the read,
// the count of Pips elsewhere, Stop, what is remembered) is agent-map-pips-host.test.mjs; the look is
// agent-map-pips-layout.test.mjs, in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };
const PIPS96 = { agents: true, agent_control: true, pips_supported: true, pips_enabled: true, pips_api_version: 96, pip_runs_running: 1 };
const NOW = Date.parse("2026-11-14T09:04:00.000Z");
const hex = (c) => c.repeat(32);
const TAX = "pip_" + hex("a"), BILLING = "pip_" + hex("b"), STOCK = "pip_" + hex("c"), DOCS = "pip_" + hex("d"), NOTES = "pip_" + hex("e");
const RUN = "run_" + hex("1"), RUN2 = "run_" + hex("2");
const running = (extra = {}) => ({ run_id: RUN, pip_id: TAX, name: "Tax watchdog", pip_type: "rook",
  started_at: "2026-11-14T09:00:00.000Z", trigger: "chat", ...extra });
const RELATED = [
  { id: TAX, name: "Tax watchdog", pip_type: "rook", workspace_id: "w1", why: ["asked", "folder"], running: true, needs_you: 0 },
  { id: BILLING, name: "Billing audit", pip_type: "lens", workspace_id: "w1", why: ["set_up", "folder"], running: false, needs_you: 2 },
  { id: STOCK, name: "Stock sync check", pip_type: "pulse", workspace_id: "w1", why: ["folder"], running: true, needs_you: 0 },
  { id: DOCS, name: "Docs writer", pip_type: "quill", workspace_id: "w1", why: ["folder"], running: false, needs_you: 0 },
  { id: NOTES, name: "Release notes", pip_type: "scout", workspace_id: "w1", why: ["folder"], running: false, needs_you: 0 },
];

function view(capabilities = PIPS96, options = {}) {
  const v = makeDom(options);
  v.dom.window.Date.now = () => NOW;
  const navigated = [];
  v.dom.window.DgcPips = { mount: () => ({ navigate: (n) => navigated.push(JSON.parse(JSON.stringify(n))), setVisible() {} }) };
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event({ ...READY, capabilities });
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off" } });
  v.send({ type: "session_ready", sessionId: "s1" });
  const posts = (type) => v.posted.filter((m) => m.type === type).map((m) => JSON.parse(JSON.stringify(m)));
  // The map opens as "/agents" opens it: a chat with no helper of its own has no button to click.
  const open = () => { const input = $("input"); input.focus(); input.value = "/agents";
    input.dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); };
  /** The host answers the page's latest question. */
  const answer = (fields = {}) => {
    const asked = posts("agentMapPips").at(-1);
    assert.ok(asked, "the page asked for this session's Pips");
    v.send({ type: "agentMapPips", seq: asked.seq, pips: RELATED, elsewhere: 5, hidden: false, ...fields });
  };
  const section = () => $("agent-map-pips");
  const rows = () => [...v.doc.querySelectorAll("#agent-map-pip-list > .am-pip")];
  const words = (row) => ({ name: row.querySelector(".am-pip-name").textContent, tag: row.querySelector(".am-pip-tag")?.hidden === false ? row.querySelector(".am-pip-tag").textContent : "",
    meta: row.querySelector(".am-pip-meta").textContent, act: row.querySelector("button").textContent });
  const more = () => $("agent-map-pips-more").textContent;
  const pill = () => ({ hidden: $("agents-picker").hidden, state: $("agents-pill").dataset.state,
    label: [...$("agents-pill").querySelector(".agents-label").children]
      .filter((node) => !node.matches(".agents-short, .agents-need")).map((node) => node.textContent).join("") });
  return { ...v, event, $, posts, open, answer, section, rows, words, more, pill, navigated, isOpen: () => !$("agent-map").hidden };
}

test("the map asks for this session's Pips when it opens, and draws them in the design's order", () => {
  const p = view();
  assert.equal(p.posts("agentMapPips").length, 0, "nothing is asked while the map is closed");
  p.event({ type: "pip_runs_running", items: [running()] });
  p.open();
  assert.equal(p.isOpen(), true);
  assert.equal(p.posts("agentMapPips").length, 1, "asked once, as the map opens");
  p.answer();
  assert.equal(p.section().hidden, false);
  assert.equal(p.$("agent-map-pips-title").textContent, "Pips");
  assert.equal(p.$("agent-map-pips-count").textContent, "3", "the count is of the Pips listed");
  assert.deepEqual(p.rows().map(p.words), [
    { name: "Tax watchdog", tag: "for this session", meta: "Working · 4m 0s", act: "Stop" },
    { name: "Billing audit", tag: "", meta: "Needs you · 2 things wait in its chat", act: "Open" },
    { name: "Stock sync check", tag: "", meta: "Running now", act: "Open" },
  ], "first the job from this session with Stop, then the related Pips that run or need you with Open; the idle ones are not rows");
  assert.equal(p.more(), "2 more Pips in this folder are idle · 5 Pips elsewhere · All Pips");
  assert.equal(p.rows()[0].querySelector("button").getAttribute("aria-label"), "Stop Tax watchdog");
  assert.equal(p.rows()[1].querySelector("button").getAttribute("aria-label"), "Open Billing audit’s chat");
  // The section is under the session's own helpers and tasks, above the settings link.
  const body = [...p.$("agent-map-body").children].map((n) => n.id);
  assert.ok(body.indexOf("agent-map-pips") > body.indexOf("agent-map-tasks") && body.indexOf("agent-map-pips") < body.indexOf("agent-map-settings"), body.join());
  // Nothing of a report: no Allow, no Apply, no card; and the banned word is nowhere.
  const said = p.section().textContent;
  assert.doesNotMatch(said, /\b(Allow|Apply|Fix|AI)\b/);
  assert.equal(p.section().querySelector(".pip-report, .card"), null);
  assert.deepEqual(p.errors, []);
});

test("counts are left out when they are none, and one is said as one", () => {
  const p = view();
  p.open();
  p.answer({ pips: RELATED.slice(1, 4), elsewhere: 0 });
  assert.equal(p.more(), "1 more Pip in this folder is idle · All Pips");
  p.answer({ pips: RELATED.slice(1, 3), elsewhere: 1 });
  assert.equal(p.more(), "1 Pip elsewhere · All Pips");
  p.answer({ pips: RELATED.slice(3), elsewhere: 0 });
  assert.deepEqual(p.rows(), [], "nothing runs and nothing needs you: no rows");
  assert.equal(p.more(), "2 Pips in this folder are idle · All Pips", "no “more” when none is listed above");
  assert.equal(p.$("agent-map-pips-count").hidden, true, "and no count of none");
  p.answer({ pips: [{ ...RELATED[1], needs_you: 1 }, { ...RELATED[2], needs_you: 3 }], elsewhere: 0 });
  assert.deepEqual(p.rows().map((r) => p.words(r).meta), ["Needs you · 1 thing waits in its chat", "Running now · needs you in its chat"]);
  assert.equal(p.more(), "All Pips");
});

test("no related Pips and none elsewhere: no section; none related but some elsewhere: the one quiet line", () => {
  const p = view();
  p.open();
  assert.equal(p.section().hidden, true, "nothing before DGC has answered");
  p.answer({ pips: [], elsewhere: 0 });
  assert.equal(p.section().hidden, true);
  p.answer({ pips: [], elsewhere: 4 });
  assert.equal(p.section().hidden, false);
  assert.deepEqual(p.rows(), []);
  assert.equal(p.more(), "4 Pips elsewhere · All Pips");
});

test("a related Pip of another folder that runs or needs you is listed; idle, it counts as elsewhere", () => {
  const p = view();
  p.open();
  const away = (extra) => ({ id: DOCS, name: "Docs writer", pip_type: "quill", workspace_id: "w2", why: ["set_up"], running: false, needs_you: 0, ...extra });
  p.answer({ pips: [away({ needs_you: 1 })], elsewhere: 2 });
  assert.deepEqual(p.rows().map(p.words), [{ name: "Docs writer", tag: "", meta: "Needs you · 1 thing waits in its chat", act: "Open" }]);
  assert.equal(p.more(), "2 Pips elsewhere · All Pips");
  p.answer({ pips: [away()], elsewhere: 2 });
  assert.deepEqual(p.rows(), []);
  assert.equal(p.more(), "3 Pips elsewhere · All Pips", "every Pip is counted once: it is not in this folder, so it is elsewhere");
});

test("Stop asks the editor to stop that run, waits, and says so when it could not", () => {
  const p = view();
  p.event({ type: "pip_runs_running", items: [running()] });
  p.open();
  p.answer();
  const stop = () => p.rows()[0].querySelector("button");
  stop().click();
  assert.deepEqual(p.posts("agentMapPipStop"), [{ type: "agentMapPipStop", run_id: RUN }]);
  assert.equal(stop().disabled, true);
  assert.equal(stop().textContent, "Stopping…");
  stop().click();
  assert.equal(p.posts("agentMapPipStop").length, 1, "asked once");
  p.send({ type: "agentMapPipStopped", run_id: RUN, ok: false, message: "That run already ended." });
  assert.equal(stop().disabled, false);
  assert.equal(stop().textContent, "Stop");
  assert.equal(p.words(p.rows()[0]).meta, "Couldn’t stop it: That run already ended.");
  stop().click();
  p.send({ type: "agentMapPipStopped", run_id: RUN, ok: true });
  assert.equal(stop().textContent, "Stopping…", "stopped: it waits for DGC to say the run is over");
  p.event({ type: "pip_runs_running", items: [] });
  p.answer({ pips: RELATED.map((r) => (r.id === TAX ? { ...r, running: false } : r)) });
  assert.deepEqual(p.rows().map((r) => p.words(r).name), ["Billing audit", "Stock sync check"], "the run ended: its row goes");
  assert.equal(p.more(), "3 more Pips in this folder are idle · 5 Pips elsewhere · All Pips");
  assert.deepEqual(p.errors, []);
});

test("Open goes to that Pip's chat in the Pips view, and All Pips to the list; the map closes", () => {
  const p = view();
  p.open();
  p.answer();
  assert.deepEqual(p.rows().map((r) => [p.words(r).name, p.words(r).act]), [["Tax watchdog", "Open"], ["Billing audit", "Open"], ["Stock sync check", "Open"]],
    "no job from this session is running: every row opens its Pip");
  p.rows()[1].querySelector("button").click();
  assert.equal(p.isOpen(), false);
  assert.deepEqual(p.navigated, [{ pip: BILLING, section: "chat" }]);
  assert.equal(p.$("pips-host").hidden, false, "on the Pips page");
  const q = view();
  q.open();
  q.answer();
  q.$("agent-map-pips-more").querySelector("button").click();
  assert.equal(q.isOpen(), false);
  assert.deepEqual(q.navigated, [{ overview: true }]);
  assert.equal(q.$("pips-host").hidden, false);
});

test("Hide / Show is one word; the editor remembers it, and a map opened later starts as it was left", () => {
  const p = view();
  p.event({ type: "pip_runs_running", items: [running()] });
  p.open();
  p.answer();
  const toggle = p.$("agent-map-pips-toggle");
  assert.equal(toggle.tagName, "BUTTON");
  assert.equal(toggle.textContent, "Hide");
  assert.equal(toggle.getAttribute("aria-expanded"), "true");
  assert.equal(toggle.getAttribute("aria-controls"), "agent-map-pips-body");
  toggle.click();
  assert.deepEqual(p.posts("agentMapPipsHidden"), [{ type: "agentMapPipsHidden", hidden: true }]);
  assert.equal(toggle.textContent, "Show");
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(p.$("agent-map-pips-body").hidden, true);
  assert.equal(p.section().hidden, false, "its title, its count and Show stay");
  assert.equal(p.$("agent-map-pips-count").textContent, "3");
  toggle.click();
  assert.deepEqual(p.posts("agentMapPipsHidden").at(-1), { type: "agentMapPipsHidden", hidden: false });
  assert.equal(p.$("agent-map-pips-body").hidden, false);
  // Another window's map, where the editor says it was hidden.
  const q = view();
  q.open();
  q.answer({ hidden: true });
  assert.equal(q.$("agent-map-pips-toggle").textContent, "Show");
  assert.equal(q.$("agent-map-pips-body").hidden, true);
  assert.equal(q.posts("agentMapPipsHidden").length, 0, "what the editor said is not said back");
});

test("the map's button shows its live mark while a Pip works for this session, and goes back when it ends", () => {
  const p = view();
  assert.equal(p.pill().hidden, true, "a chat with no helper and no Pip at work has no button");
  p.event({ type: "pip_runs_running", items: [running()] });
  assert.deepEqual(p.pill(), { hidden: false, state: "running", label: "1 Pip" });
  assert.match(p.$("agents-pill").getAttribute("aria-label"), /1 Pip working for this session · Click to open the agent map$/);
  p.event({ type: "pip_runs_running", items: [running(), running({ run_id: RUN2, pip_id: BILLING, name: "Billing audit" })] });
  assert.equal(p.pill().label, "2 Pips");
  p.$("agents-pill").click();
  assert.equal(p.isOpen(), true);
  assert.deepEqual(p.rows().map(p.words).map((w) => [w.name, w.tag, w.act]), [["Tax watchdog", "for this session", "Stop"], ["Billing audit", "for this session", "Stop"]],
    "the runs of this session are drawn at once, before DGC has said the rest");
  p.event({ type: "pip_runs_running", items: [] });
  assert.equal(p.pill().hidden, true);
  // Beside a helper it is one more part of the same button.
  const q = view();
  q.event({ type: "agent_started", id: "sub-000000000001", parent_id: null, call_id: "call_1", description: "Read the totals", depth: 1,
    state: "running", started_at: 1000, isolated: false, parallel: false });
  q.event({ type: "pip_runs_running", items: [running()] });
  assert.deepEqual(q.pill(), { hidden: false, state: "running", label: "1 sub-agent · 1 Pip" });
  q.event({ type: "agent_ended", id: "sub-000000000001", state: "finished", duration_ms: 1200, tool_calls: 1 });
  assert.deepEqual(q.pill(), { hidden: false, state: "running", label: "1 Pip" }, "the helper ended; the Pip still works");
});

test("a run this chat's own card started is in the Pips section, not also among the background tasks", () => {
  const p = view({ ...PIPS96, background_tasks: { version: 1 } });
  const runs = [{ id: RUN, pipId: TAX, name: "Tax watchdog", status: "running", label: "Working", detail: "", active: true, stoppable: true }];
  p.dom.window.DgcPips.mountSetupCards = () => ({ toolResult() {}, finish() {}, reset() {}, receive() {}, runs: () => runs, openRun() {} });
  p.doc.documentElement.dataset.pipsDocumentId = "doc1";
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "tool_call", call_id: "c1", name: "run_pip_now", args: {}, summary: "" });
  p.event({ type: "tool_result", call_id: "c1", name: "run_pip_now", output: "{}", is_error: false });
  p.event({ type: "pip_runs_running", items: [running({ trigger: "setup" })] });
  assert.equal(p.pill().label, "1 Pip", "counted once");
  p.$("agents-pill").click();
  assert.deepEqual([...p.doc.querySelectorAll("#agent-map-task-list .am-row")].map((r) => r.dataset.amKey), []);
  assert.deepEqual(p.rows().map((r) => p.words(r).name), ["Tax watchdog"]);
});

test("it is read again when this chat's Pips change, never faster than every two seconds, and slowly while the map stays open", () => {
  const p = view(PIPS96, { clock: true });
  p.open();
  assert.equal(p.posts("agentMapPips").length, 1);
  p.answer();
  p.event({ type: "pip_runs_running", items: [running()] });
  p.event({ type: "pip_runs_running", items: [running(), running({ run_id: RUN2, pip_id: BILLING, name: "Billing audit" })] });
  assert.equal(p.posts("agentMapPips").length, 1, "not at once: it was just read");
  p.advance(2000);
  assert.equal(p.posts("agentMapPips").length, 2, "once, two seconds after the last read");
  p.answer();
  p.advance(29000);
  assert.equal(p.posts("agentMapPips").length, 2);
  p.advance(1500);
  assert.equal(p.posts("agentMapPips").length, 3, "and every half minute while the map is open, for what no event of this chat says");
  p.answer();
  // An answer to an older question is not drawn.
  p.send({ type: "agentMapPips", seq: 1, pips: [], elsewhere: 0, hidden: false });
  assert.equal(p.rows().length, 3, "an old answer changes nothing");
  // Closed: nothing more is asked.
  p.$("agent-map-close").click();
  p.advance(120000);
  assert.equal(p.posts("agentMapPips").length, 3);
});

test("another chat starts with no Pips of the one before, and asks for its own", () => {
  const p = view();
  p.event({ type: "pip_runs_running", items: [running()] });
  p.open();
  p.answer();
  assert.equal(p.rows().length, 3);
  const before = p.posts("agentMapPips").at(-1);
  p.event({ type: "session", kind: "new", session_id: "s2" });
  assert.equal(p.section().hidden, true, "the other chat's Pips are gone with it");
  p.send({ type: "agentMapPips", seq: before.seq, pips: RELATED, elsewhere: 5, hidden: false });
  assert.equal(p.section().hidden, true, "an answer about the chat before is not this one's");
  if (!p.isOpen()) p.open();
  assert.ok(p.posts("agentMapPips").at(-1).seq > before.seq, "this chat's are asked for");
  p.answer({ pips: RELATED.slice(1, 2), elsewhere: 0 });
  assert.deepEqual(p.rows().map((r) => p.words(r).name), ["Billing audit"]);
});

test("when DGC could not read them, the runs of this session are still shown, and nothing else is claimed", () => {
  const p = view();
  p.event({ type: "pip_runs_running", items: [running()] });
  p.open();
  const asked = p.posts("agentMapPips").at(-1);
  p.send({ type: "agentMapPips", seq: asked.seq, failed: true, hidden: false });
  assert.deepEqual(p.rows().map((r) => p.words(r).name), ["Tax watchdog"]);
  assert.equal(p.more(), "All Pips");
  const q = view();
  q.open();
  q.send({ type: "agentMapPips", seq: q.posts("agentMapPips").at(-1).seq, failed: true, hidden: false });
  assert.equal(q.section().hidden, true, "nothing known: no section");
});

test("a DGC before Pips API 96, or with Pips off, is never asked and shows no section; its button is as it was", () => {
  for (const capabilities of [{ ...PIPS96, pips_api_version: 95 }, { ...PIPS96, pips_enabled: false }, { agents: true, agent_control: true, pip_runs_running: 1 }]) {
    const p = view(capabilities);
    p.event({ type: "pip_runs_running", items: [running()] });
    assert.equal(p.pill().hidden, true, "the chip above the box is all an older DGC shows");
    p.open();
    assert.equal(p.isOpen(), true);
    assert.equal(p.posts("agentMapPips").length, 0);
    p.send({ type: "agentMapPips", seq: 1, pips: RELATED, elsewhere: 5, hidden: false });
    assert.equal(p.section().hidden, true);
    assert.deepEqual(p.errors, []);
  }
});

test("an answer is read as data: rows that name no Pip are left out, and counts are whole numbers", () => {
  const p = view();
  p.open();
  p.answer({ pips: [{ ...RELATED[1], id: "../x" }, "nope", null, { ...RELATED[2], name: "<b>Stock</b>" }, { ...RELATED[1], needs_you: "9" }], elsewhere: -3 });
  assert.deepEqual(p.rows().map(p.words), [{ name: "<b>Stock</b>", tag: "", meta: "Running now", act: "Open" }],
    "a name is text; a count that is not a whole number is none, so that Pip is idle");
  assert.equal(p.rows()[0].querySelector("b"), null);
  assert.equal(p.more(), "1 more Pip in this folder is idle · All Pips");
});
