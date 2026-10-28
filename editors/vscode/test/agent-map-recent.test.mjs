// The agent map shows what matters now; the rest is one click away (reported 25 Oct). A long chat
// lists every helper it ever ran, so the map opens on: every agent working, every agent the chat's
// latest turn that started any started, and any older one whose changes were held back -- each with its
// parents, so the tree stays honest. Everything else is one row, "Earlier in this chat · N agents", a
// real button that opens to them grouped by the prompt that started them, newest group first, and is
// remembered per chat. The subtitle counts: "2 working · 3 this turn · 14 earlier". Which turn started
// an agent is what the chat already holds -- its claimed spawn card's turn, else agent_started.turn_id --
// and a chat whose agents carry neither keeps the full tree. Real geometry is
// agent-map-recent-layout.test.mjs's, in Chromium.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
const READY = { type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
  capabilities: { agents: true, agent_control: true, agent_reports: 1, history_snapshot: true } };
const integrated = (name) => `Sub-task '${name}' completed and integrated 1 path(s): billing.py.\nSummary:\nDone.`;
const HELD = (name) => `Sub-task '${name}' completed but its changes were NOT integrated: conflict. Conflicts: gst.py. `
  + "The isolated worktree is preserved at /work/.dgc/worktrees/sub-9 on branch dgc/sub-9.\nSummary:\nMigrated the tables.";
const PARTLY = (name) => `Sub-task '${name}' partly integrated. Applied 1 path(s): a.py. Held back because you changed the same lines:`
  + " b.py. That work is preserved at /work/.dgc/worktrees/sub-8 on branch dgc/sub-8; resolve it from /tasks.\nSummary:\nHalf.";

function view(options = {}) {
  const v = makeDom(options);
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  event(READY);
  v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off" } });
  v.send({ type: "session_ready", sessionId: options.session || "s1" });
  let at = 1000;
  // A turn the way a live chat has it: its prompt, then for each helper the spawn card and the agent it
  // started (turn_id is the turn's), its end and the spawn's result; `running` ones keep working.
  const turn = (id, prompt, helpers = [], { end = true, kind = "prompt" } = {}) => {
    event({ type: "turn_start", turn_id: id, prompt, kind });
    for (const h of helpers) {
      const call = h.call || `${id}-c${h.n}`;
      if (!h.cardless) event({ type: "tool_call", call_id: call, name: "task", args: { description: h.name, prompt: h.name }, summary: "" });
      event({ type: "agent_started", id: sid(h.n), parent_id: h.parent ? sid(h.parent) : null, call_id: h.cardless ? null : call,
        description: h.name, depth: h.depth || 1, state: "running", started_at: h.at ?? at++, isolated: true, parallel: false,
        ...(h.untold ? {} : { turn_id: id }), ...(h.background ? { background: true } : {}) });
      if (h.state === "running") continue;
      event({ type: "agent_ended", id: sid(h.n), state: h.state || "finished", duration_ms: 1200, tool_calls: 2 });
      if (!h.cardless) {
        event({ type: "tool_result", call_id: call, name: "task", is_error: false, is_diff: false,
          output: h.background ? `Sub-task '${h.name}' is running in the background (id ${sid(h.n)}).` : (h.outcome || integrated)(h.name) });
      }
    }
    if (end) event({ type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0 });
  };
  const open = () => { if ($("agent-map").hidden) $("agents-pill").click(); };
  const close = () => { if (!$("agent-map").hidden) $("agent-map-close").click(); };
  const fold = () => v.doc.querySelector("#agent-map-tree .am-earlier");
  // The rows the map shows without a click, in order: everything but what Earlier holds.
  const now = () => [...v.doc.querySelectorAll("#agent-map-tree .am-row")].filter((row) => !row.closest(".am-earlier-groups"))
    .map((row) => row.dataset.amKey);
  const groups = () => [...v.doc.querySelectorAll("#agent-map-earlier .am-group")].map((group) => ({
    label: group.querySelector(".am-group-label").textContent,
    rows: [...group.querySelectorAll(".am-row")].map((row) => row.dataset.amKey) }));
  const row = (key) => v.doc.querySelector(`#agent-map .am-row[data-am-key="${key}"]`);
  const meta = (n) => row(`agent:${sid(n)}`).querySelector(".am-meta").textContent;
  const subtitle = () => $("agent-map-subtitle").textContent;
  const key = (target, name) => target.dispatchEvent(new v.dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  return { ...v, event, $, turn, open, close, fold, now, groups, row, meta, subtitle, key };
}
const a = (n) => `agent:${sid(n)}`;
const sorted = (list) => [...list].sort();

test("recent vs earlier: the latest turn's agents are shown; the two turns before fold into Earlier, grouped by their prompts", () => {
  const p = view();
  p.turn("t1", "Fix the rounding in billing.py and its tests", [{ n: 1, name: "Map billing.py usage" }, { n: 2, name: "Review test_billing.py" }]);
  p.turn("t2", "Now migrate the GST tables", [{ n: 3, name: "Migrate the GST tables" }, { n: 4, name: "Check the GST rates" }]);
  p.turn("t3", "Recheck the invoice totals", [{ n: 5, name: "Recheck invoice totals" }]);
  p.open();
  assert.deepEqual(p.now(), ["root", a(5), "earlier"], "the main agent, this turn's helper, and the folded row");
  assert.equal(p.fold().textContent, "Earlier in this chat · 4 agents");
  assert.equal(p.$("agent-map-earlier").hidden, true, "folded");
  assert.equal(p.doc.querySelectorAll("#agent-map-earlier .am-row").length, 0, "a folded row's agents are out of the document");
  assert.equal(p.subtitle(), "1 this turn · 4 earlier");
  p.fold().click();
  const groups = p.groups();
  assert.deepEqual(groups.map((g) => g.label), ["Now migrate the GST tables", "Fix the rounding in billing.py and its tests"],
    "newest group first, each under its prompt's words");
  assert.deepEqual(sorted(groups[0].rows), [a(3), a(4)]);
  assert.deepEqual(sorted(groups[1].rows), [a(1), a(2)]);
  // Opened, the earlier rows are ordinary rows of the tree: clicking one opens its card as before.
  p.row(a(1)).click();
  assert.equal(p.$("agent-card").hidden, false);
  assert.equal(p.$("agent-card-title").textContent, "Map billing.py usage");
  p.$("agent-card-back").click();
  assert.equal(p.doc.activeElement, p.row(a(1)), "back on the row that opened it");
  assert.deepEqual(p.errors, []);
});

test("a held-back helper from an older turn stays shown, its row saying Held back; partly integrated too", () => {
  const p = view();
  p.turn("t1", "Migrate the GST tables", [{ n: 1, name: "Migrate the GST tables", outcome: HELD },
    { n: 2, name: "Port the rates", outcome: PARTLY }, { n: 3, name: "Map the old tables" }]);
  p.turn("t2", "Fix the rounding", [{ n: 4, name: "Fix the rounding in billing.py" }]);
  p.open();
  assert.deepEqual(sorted(p.now().filter((k) => k.startsWith("agent:"))), [a(1), a(2), a(4)], "this turn's, and the two whose work is held back");
  assert.match(p.meta(1), /^Held back/);
  assert.match(p.meta(2), /^Held back/);
  assert.match(p.meta(4), /^Finished/);
  assert.equal(p.fold().textContent, "Earlier in this chat · 1 agent");
  p.fold().click();
  assert.deepEqual(p.groups(), [{ label: "Migrate the GST tables", rows: [a(3)] }]);
  assert.equal(p.subtitle(), "1 this turn · 1 earlier", "a held-back one is shown, not counted as this turn's");
  assert.deepEqual(p.errors, []);
});

test("a background helper whose report says its work was held back stays shown after later turns", () => {
  const p = view();
  p.turn("t1", "Port the CLI in the background", [{ n: 1, name: "Port the CLI", background: true }, { n: 2, name: "Read the docs" }]);
  p.event({ type: "turn_start", turn_id: "t2", prompt: "Port the CLI", kind: "wake" });
  p.event({ type: "agent_report", turn_id: "t2", id: sid(1), description: "Port the CLI", report: HELD("Port the CLI"), integrated: false });
  p.event({ type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0 });
  p.turn("t3", "Now the tests", [{ n: 3, name: "Write the CLI tests" }]);
  p.open();
  assert.deepEqual(sorted(p.now().filter((k) => k.startsWith("agent:"))), [a(1), a(3)]);
  assert.match(p.meta(1), /^Held back/);
  assert.deepEqual(p.errors, []);
});

test("a working child pulls its parent chain into view; an ended child of a shown parent goes in Earlier with its parent's turn", () => {
  const p = view();
  p.turn("t1", "Audit the auth module", [
    { n: 1, name: "Audit auth", state: "running" },
    { n: 2, name: "Trace the refresh tokens", parent: 1, depth: 2, call: `${sid(1)}:c1`, state: "running" },
    { n: 3, name: "Read the token store", parent: 2, depth: 3, call: `${sid(2)}:c1`, state: "running" },
    { n: 4, name: "List the log calls", parent: 1, depth: 2, call: `${sid(1)}:c2` },
    { n: 5, name: "Check the cookies" }]);
  // The parent and the middle child end; the grandchild keeps working.
  p.event({ type: "agent_ended", id: sid(2), state: "finished", duration_ms: 1000, tool_calls: 1 });
  p.event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 1000, tool_calls: 1 });
  p.turn("t2", "Now the billing", [{ n: 6, name: "Map billing" }]);
  p.open();
  const item = (n) => p.row(a(n)).closest("li");
  assert.deepEqual(sorted(p.now().filter((k) => k.startsWith("agent:"))), [a(1), a(2), a(3), a(6)],
    "the grandchild at work, its parent and theirs, and this turn's");
  assert.equal(item(3).parentElement.parentElement, item(2), "the grandchild under its parent");
  assert.equal(item(2).parentElement.parentElement, item(1), "and that one under the top-level agent");
  assert.equal(item(1).parentElement, p.doc.querySelector(".am-root-node > .am-children"));
  p.fold().click();
  const groups = p.groups();
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, "Audit the auth module");
  assert.deepEqual(sorted(groups[0].rows), [a(4), a(5)], "the ended sibling goes in Earlier with its parent's turn");
  assert.equal(item(4).parentElement.closest(".am-group").querySelector(".am-group-label").textContent, "Audit the auth module");
  assert.equal(p.subtitle(), "1 working · 1 this turn · 2 earlier");
  assert.deepEqual(p.errors, []);
});

test("the latest-turn rule: a follow-up turn that starts none leaves the map as it was; the next turn that starts one moves the old ones", () => {
  const p = view();
  p.turn("t1", "Map the billing module", [{ n: 1, name: "Map billing.py" }, { n: 2, name: "Map invoices.py" }]);
  p.turn("t2", "thanks, and what about the totals?");
  p.open();
  assert.deepEqual(sorted(p.now().filter((k) => k.startsWith("agent:"))), [a(1), a(2)]);
  assert.equal(p.fold(), null, "nothing earlier");
  assert.equal(p.subtitle(), "2 this turn");
  p.close();
  // A running turn that has started none yet does not empty the map either.
  p.turn("t3", "Recheck the totals", [], { end: false });
  p.open();
  assert.deepEqual(sorted(p.now().filter((k) => k.startsWith("agent:"))), [a(1), a(2)]);
  p.close();
  p.event({ type: "tool_call", call_id: "t3-c3", name: "task", args: { description: "Recheck totals", prompt: "go" }, summary: "" });
  p.event({ type: "agent_started", id: sid(3), parent_id: null, call_id: "t3-c3", description: "Recheck totals", depth: 1,
    state: "running", started_at: 5000, isolated: true, parallel: false, turn_id: "t3" });
  p.open();
  assert.deepEqual(p.now(), ["root", a(3), "earlier"]);
  assert.equal(p.subtitle(), "1 working · 1 this turn · 2 earlier");
  assert.deepEqual(p.errors, []);
});

test("the counts: 2 working · 3 this turn · 14 earlier; a part that is 0 is left out; no agents keeps today's sentence", () => {
  const p = view();
  p.open();
  assert.equal(p.subtitle(), "No agents in this chat yet");
  p.close();
  let n = 0;
  const helpers = (count, extra = {}) => Array.from({ length: count }, () => ({ n: ++n, name: `helper ${n + 1}`, ...extra }));
  p.turn("t1", "Plan the GST change", [...helpers(6), { n: ++n, name: "Migrate the GST tables", outcome: HELD }]);
  p.turn("t2", "Review every handler", helpers(8));
  p.turn("t3", "Fix the rounding", [...helpers(2, { state: "running" }), ...helpers(1)], { end: false });
  p.open();
  assert.equal(p.subtitle(), "2 working · 3 this turn · 14 earlier");
  assert.equal(p.fold().textContent, "Earlier in this chat · 14 agents");
  assert.equal(p.now().filter((k) => k.startsWith("agent:")).length, 4, "this turn's three and the held-back one");
  p.close();
  for (const id of [16, 17]) p.event({ type: "agent_ended", id: sid(id), state: "finished", duration_ms: 1000, tool_calls: 1 });
  p.open();
  assert.equal(p.subtitle(), "3 this turn · 14 earlier", "no one working: that part is left out");
  assert.deepEqual(p.errors, []);
});

test("a snapshot's cap: the agents it did not itemise are earlier ones, counted there and said inside Earlier", () => {
  const p = view();
  p.turn("t1", "Map everything", [{ n: 1, name: "Map a" }]);
  p.turn("t2", "Now fix it", [{ n: 2, name: "Fix a" }]);
  // A resync that lists these two of the chat's 70.
  const item = (k, turnId, at) => ({ id: sid(k), parent_id: null, call_id: `${turnId}-c${k}`, description: `x${k}`, depth: 1,
    state: "finished", tool_calls: 1, duration_ms: 1000, isolated: true, parallel: false, restored: false, started_at: at, turn_id: turnId });
  p.event({ type: "agents", items: [item(1, "t1", 1000), item(2, "t2", 1001)], total: 70, active: 0 });
  p.open();
  assert.equal(p.subtitle(), "1 this turn · 69 earlier");
  assert.equal(p.$("agent-map-more").hidden, true, "the line is not under the tree");
  assert.equal(p.fold().textContent, "Earlier in this chat · 69 agents");
  p.fold().click();
  const note = p.$("agent-map-earlier").querySelector(".am-note");
  assert.equal(note.textContent, "68 more agents not listed.");
  assert.equal(note, p.$("agent-map-earlier").lastElementChild, "after the groups");
  assert.deepEqual(p.errors, []);
});

test("the fold is a real button with aria-expanded: arrows and End reach it, it opens and closes, and its rows join the tree's keys", () => {
  const p = view();
  p.turn("t1", "Map the billing module", [{ n: 1, name: "Map billing.py" }, { n: 2, name: "Map invoices.py" }]);
  p.turn("t2", "Fix the rounding", [{ n: 3, name: "Fix the rounding" }]);
  p.open();
  const fold = p.fold();
  assert.equal(fold.tagName, "BUTTON");
  assert.equal(fold.type, "button");
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.equal(fold.getAttribute("aria-controls"), "agent-map-earlier");
  assert.ok(p.$("agent-map-earlier"), "it controls a real element");
  assert.equal(p.$("agent-map-earlier").getAttribute("role"), "group");
  assert.equal(p.$("agent-map-earlier").getAttribute("aria-label"), "Earlier in this chat");
  assert.equal(p.doc.activeElement, p.row(a(3)), "the map opens on this turn's agent");
  p.key(p.doc.activeElement, "ArrowDown");
  assert.equal(p.doc.activeElement, fold, "the arrow reaches it");
  p.key(p.doc.activeElement, "ArrowDown");
  assert.equal(p.doc.activeElement, fold, "closed, nothing after it");
  p.key(p.row(a(3)), "End");
  assert.equal(p.doc.activeElement, fold);
  fold.click();
  assert.equal(fold.getAttribute("aria-expanded"), "true");
  assert.equal(p.$("agent-map-earlier").hidden, false);
  assert.equal(p.doc.activeElement, fold, "focus stays on it");
  assert.ok(fold.querySelector(".am-earlier-chevron"), "with a chevron");
  p.key(fold, "ArrowDown");
  assert.ok([a(1), a(2)].includes(p.doc.activeElement.dataset.amKey), "opened, the arrow goes on into its rows");
  p.key(p.doc.activeElement, "ArrowUp");
  assert.equal(p.doc.activeElement, fold);
  fold.click();
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.equal(p.$("agent-map-earlier").hidden, true);
  assert.equal(p.doc.querySelectorAll("#agent-map-earlier .am-row").length, 0);
  // One tab stop in the tree, whichever row holds it.
  assert.equal([...p.doc.querySelectorAll("#agent-map-tree .am-row")].filter((r) => r.tabIndex === 0).length, 1);
  assert.deepEqual(p.errors, []);
});

test("whether Earlier is open is remembered per chat in the webview's state, and a missing or broken state draws it closed", () => {
  const chat = (p) => {
    p.turn("t1", "Map the billing module", [{ n: 1, name: "Map billing.py" }]);
    p.turn("t2", "Fix the rounding", [{ n: 2, name: "Fix the rounding" }]);
  };
  const p = view();
  chat(p);
  p.open();
  p.fold().click();
  assert.deepEqual(p.savedState().agentMapEarlier, ["s1"]);
  p.close(); p.open();
  assert.equal(p.fold().getAttribute("aria-expanded"), "true", "open again when the map opens again");
  p.close();
  // Another chat in this view keeps its own.
  p.send({ type: "session_ready", sessionId: "s2" });
  p.open();
  assert.equal(p.fold().getAttribute("aria-expanded"), "false");
  p.close();
  p.send({ type: "session_ready", sessionId: "s1" });
  p.open();
  assert.equal(p.fold().getAttribute("aria-expanded"), "true");
  p.fold().click();
  assert.deepEqual(p.savedState().agentMapEarlier, []);

  // A reloaded view reads it back.
  const q = view({ state: { agentMapEarlier: ["s1"] } });
  chat(q);
  q.open();
  assert.equal(q.fold().getAttribute("aria-expanded"), "true");
  assert.deepEqual(q.groups().map((g) => g.rows), [[a(1)]]);
  for (const state of [undefined, { agentMapEarlier: "s1" }, { agentMapEarlier: [7, null, { x: 1 }] }]) {
    const r = view({ state });
    chat(r);
    r.open();
    assert.equal(r.fold().getAttribute("aria-expanded"), "false");
    assert.deepEqual(r.errors, []);
  }
  assert.deepEqual(p.errors, []);
  assert.deepEqual(q.errors, []);
});

test("a reopened chat: restored agents find their turns by their spawn cards in the replayed history", () => {
  const p = view();
  const say = (text, id) => [{ type: "text_delta", text }, { type: "stream_end", message_id: id, phase: "answer" }];
  const spawn = (turnId, k, name) => [
    { type: "tool_call", call_id: `call_${k}`, name: "task", args: { description: name, prompt: name }, summary: "" },
    { type: "tool_result", call_id: `call_${k}`, name: "task", is_error: false, is_diff: false, output: integrated(name) }];
  const turn = (id, prompt, spawns) => [{ type: "turn_start", turn_id: id, prompt, kind: "prompt" }, ...spawns,
    ...say("Done.", `${id}:1`), { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0, final_message_id: `${id}:1` }];
  // The replay's turn ids are its own (h1...); the records name the turns of the run that started them.
  p.event({ type: "history", complete: true, items: [
    ...turn("h1", "Map the billing module", [...spawn("h1", 1, "Map billing.py"), ...spawn("h1", 2, "Map invoices.py")]),
    ...turn("h2", "Fix the rounding", spawn("h2", 3, "Fix the rounding")),
  ] });
  const record = (k, name, turnId, at) => ({ id: sid(k), parent_id: null, call_id: `call_${k}`, description: name, depth: 1,
    state: "finished", tool_calls: 1, duration_ms: 1000, isolated: true, parallel: false, restored: true, started_at: at, turn_id: turnId });
  p.event({ type: "agents", total: 4, active: 0, items: [record(1, "Map billing.py", "t1", 100), record(2, "Map invoices.py", "t1", 101),
    record(3, "Fix the rounding", "t2", 200),
    // Its card is not in the pages on screen: it keeps its own turn, under a label that says so.
    { ...record(4, "Map the old API", "t0", 50), call_id: "call_old" }] });
  p.open();
  assert.deepEqual(p.now(), ["root", a(3), "earlier"]);
  p.fold().click();
  assert.deepEqual(p.groups().map((g) => [g.label, sorted(g.rows)]), [
    ["Map the billing module", [a(1), a(2)]], ["An earlier prompt", [a(4)]]]);
  assert.deepEqual(p.errors, []);
});

test("an agent no turn names (a Pip fix's) goes with the turn that was the latest when it started", () => {
  const p = view();
  p.turn("t1", "Map billing", [{ n: 1, name: "Map billing.py" }]);
  p.turn("t2", "Fix the rounding", [{ n: 2, name: "Fix the rounding" }]);
  p.event({ type: "agent_started", id: sid(3), parent_id: null, call_id: null, description: "Fix: the rounding drifts", depth: 1,
    state: "running", started_at: 1500, isolated: true, parallel: false, background: true });
  p.event({ type: "agent_ended", id: sid(3), state: "finished", duration_ms: 1000, tool_calls: 1 });
  p.open();
  assert.deepEqual(sorted(p.now().filter((k) => k.startsWith("agent:"))), [a(2), a(3)]);
  assert.equal(p.subtitle(), "2 this turn · 1 earlier");
  assert.deepEqual(p.errors, []);
});

test("an older CLI or missing data: agents with neither a spawn card nor a turn keep today's full tree and subtitle", () => {
  const p = view();
  p.turn("t1", "Map billing", [{ n: 1, name: "Map billing.py" }]);
  p.turn("t2", "Fix the rounding", [{ n: 2, name: "Fix the rounding" }]);
  p.open();
  assert.ok(p.fold(), "with what to place them by, the map folds the older turn");
  p.close();
  // The snapshot an older CLI sends after a reload: no turn_id, and no call id a card on screen carries.
  p.event({ type: "agents", total: 70, active: 0, items: [11, 12, 13].map((k) => ({ id: sid(k), parent_id: null, call_id: null,
    description: `old ${k}`, depth: 1, state: "finished", tool_calls: 1, isolated: false, parallel: false, restored: true, started_at: k })) });
  p.open();
  assert.equal(p.fold(), null, "no Earlier row");
  assert.deepEqual(p.now(), ["root", a(13), a(12), a(11)], "every agent, as before");
  assert.equal(p.subtitle(), "70 agents · click an agent for details", "today's sentence");
  assert.equal(p.$("agent-map-more").hidden, false, "the cap is said where it always was");
  assert.equal(p.$("agent-map-more").textContent, "67 more agents not listed.");
  p.close();
  // Live agents of three turns that carry nothing to place them by.
  const q = view();
  for (const [i, id] of ["t1", "t2", "t3"].entries()) {
    q.turn(id, `prompt ${i + 1}`, [{ n: i * 2 + 1, name: `agent ${i * 2 + 1}`, untold: true, cardless: true },
      { n: i * 2 + 2, name: `agent ${i * 2 + 2}`, untold: true, cardless: true }]);
  }
  q.open();
  assert.equal(q.fold(), null);
  assert.equal(q.now().filter((k) => k.startsWith("agent:")).length, 6);
  assert.equal(q.subtitle(), "6 agents · click an agent for details");
  assert.deepEqual(p.errors, []);
  assert.deepEqual(q.errors, []);
});

test("Open in agent map, from a report of an agent that is in Earlier, opens Earlier and that agent's card", () => {
  const p = view();
  p.turn("t1", "Port the CLI in the background", [{ n: 1, name: "Port the CLI", background: true }]);
  p.event({ type: "turn_start", turn_id: "t2", prompt: "Port the CLI", kind: "wake" });
  p.event({ type: "agent_report", turn_id: "t2", id: sid(1), description: "Port the CLI", report: integrated("Port the CLI"), integrated: true });
  p.event({ type: "turn_end", turn_id: "t2", reason: "completed", token_estimate: 0 });
  p.turn("t3", "Now the tests", [{ n: 2, name: "Write the CLI tests" }]);
  const line = p.doc.querySelector(`#log .handback-line[data-agent-id="${sid(1)}"]`);
  line.querySelector(".handback-toggle").click();
  line.querySelector(".handback-map").click();
  assert.equal(p.$("agent-card").hidden, false);
  assert.equal(p.$("agent-card-title").textContent, "Port the CLI");
  assert.equal(p.fold().getAttribute("aria-expanded"), "true");
  assert.deepEqual(p.errors, []);
});
