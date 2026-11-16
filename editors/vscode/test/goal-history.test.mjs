// A goal's end, and a session's goal history, in Work (0.52, asked 12 Nov). When a goal ends (done, blocked, or stopped
// by a new goal or a clear), one quiet line under its turn: "Goal done · 2 h 14 min · 1.8M tokens · 7 cycles"; the same
// lines come back after a reload, from goal_runs (ready.capabilities.goal_runs). "/goal-history" in the "/" menu, only
// on such a DGC, adds a "Goals" pill to the bar above the prompt box: the session's goals newest first, each with how
// it ended, when, its time and tokens, and Trace for the turns between its start and its end.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const READY = (goalRuns = true) => ({ type: "ready", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1,
  capabilities: { agents: true, ...(goalRuns ? { goal_runs: true } : {}) } });
const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
const goal = (id, status, extra = {}) => ({ type: "goal_changed", goal: status === "none" ? "" : extra.text || "Ship the release", status,
  elapsed_seconds: extra.elapsed ?? 0, details: { id, tokens_used: extra.tokens ?? 0, cycles: extra.cycles ?? 0, history: [] } });
const run = (id, status, extra = {}) => ({ id, name: "Ship the release", status, started_at: 1_794_000_000, ended_at: status === "active" || status === "paused" ? null : 1_794_008_040,
  elapsed_seconds: 8040, tokens: 1_800_000, cycles: 7, ...extra });

function chat({ goalRuns = true } = {}) {
  const v = makeDom({}), win = v.dom.window, input = v.doc.getElementById("input");
  const event = (data) => v.send({ type: "event", event: data });
  event(READY(goalRuns));
  v.send({ type: "session_ready", sessionId: "s1" });
  const asked = () => v.posted.filter((m) => m.type === "goalRuns").length;
  const lines = () => [...v.doc.querySelectorAll("#log .goal-end")];
  const chip = () => v.doc.querySelector('#rail-chips .rail-chip[data-kind="goalruns"]');
  const turn = (id, words = "Working on it.") => { event({ type: "turn_start", turn_id: id, prompt: "Ship the release", kind: "prompt" });
    event({ type: "text_delta", text: words }); event({ type: "stream_end", message_id: `${id}:1`, phase: "final_answer" }); };
  const end = (id) => event({ type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` });
  return { v, win, input, event, asked, lines, chip, turn, end,
    type(words) { input.value = words; input.selectionStart = input.selectionEnd = words.length; input.dispatchEvent(new win.Event("input", { bubbles: true })); },
    key(key) { input.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); },
    menu: () => (v.doc.getElementById("pop").style.display === "block" ? [...v.doc.querySelectorAll("#pop .pi")].map((row) => text(row)) : null) };
}
const now = () => Date.now() / 1000;
/** What a turn's end line follows: the turn's own box (its prompt and its reply). */
const under = (reply) => reply.closest(".turn") || reply;

test("a goal that ends leaves one quiet line under its turn: how it ended, its time, tokens and cycles", () => {
  const x = chat();
  x.event(goal("g1", "active"));
  x.turn("t1");
  const before = x.asked();
  x.event(goal("g1", "completed", { elapsed: 8040, tokens: 1_800_000, cycles: 7 }));
  assert.equal(x.asked(), before + 1, "the page asks DGC for the session's goals");
  // One record, listed twice as DGC would: built once, so a slow machine can't give its two copies different end times
  // (it read the clock twice, and more than half a second apart the two rounded end times differed: 13 Nov).
  const record = run("g1", "completed", { started_at: now() - 8040, ended_at: now() + 1 });
  x.event({ type: "goal_runs", runs: [record] });
  assert.equal(x.lines().length, 0, "not in the middle of the turn");
  x.end("t1");
  assert.deepEqual(x.lines().map(text), ["Goal done · 2 h 14 min · 1.8M tokens · 7 cycles"]);
  const line = x.lines()[0];
  assert.equal(line.previousElementSibling, under(x.v.doc.querySelector("#log .msg.dgc")), "under that turn");
  assert.equal(line.nextElementSibling, null, "the last thing in the chat");
  assert.match(line.title, /Ship the release/, "its tooltip names the goal");
  x.event({ type: "goal_runs", runs: [{ ...record }] });
  assert.equal(x.lines().length, 1, "said once, however often DGC lists it");
  assert.deepEqual(x.v.errors, []);
});

test("blocked and stopped say so; a goal replaced or cleared is stopped", () => {
  const x = chat();
  x.event(goal("g1", "active"));
  x.turn("t1"); x.end("t1");
  x.event(goal("g1", "blocked", { elapsed: 125, tokens: 52_400, cycles: 3 }));
  x.event({ type: "goal_runs", runs: [run("g1", "blocked", { started_at: now() - 125, ended_at: now() + 1, elapsed_seconds: 125, tokens: 52_400, cycles: 3 })] });
  assert.deepEqual(x.lines().map(text), ["Goal blocked · 2 min · 52.4k tokens · 3 cycles"]);
  const y = chat();
  y.event(goal("g1", "active"));
  y.turn("t1"); y.end("t1");
  const before = y.asked();
  y.event(goal("g2", "active", { text: "Another goal" }));
  assert.equal(y.asked(), before + 1, "a new goal in its place: the old one ended");
  y.event({ type: "goal_runs", runs: [run("g1", "stopped", { started_at: now() - 45, ended_at: now() + 1, elapsed_seconds: 45, tokens: 950, cycles: 1 }), run("g2", "active", { name: "Another goal", started_at: now() })] });
  assert.deepEqual(y.lines().map(text), ["Goal stopped · 45 s · 950 tokens · 1 cycle"], "the goal still running has no end line");
  const z = chat();
  z.event(goal("g1", "paused"));
  const cleared = z.asked();
  z.event(goal("", "none"));
  assert.equal(z.asked(), cleared + 1, "cleared: it ended");
  z.event({ type: "goal_runs", runs: [run("g1", "stopped", { started_at: now() - 5, ended_at: now() + 1, elapsed_seconds: 0, tokens: 0, cycles: 0 })] });
  assert.deepEqual(z.lines().map(text), ["Goal stopped · 0 s"], "nothing counted: no tokens or cycles to say");
});

test("a goal already ended when the window opened says nothing new by itself, and a DGC without goal_runs is never asked", () => {
  const x = chat();
  x.event(goal("g1", "completed", { elapsed: 60 }));
  assert.equal(x.lines().length, 0, "the first sight of a goal is not its end");
  const old = chat({ goalRuns: false });
  old.event(goal("g1", "active"));
  old.turn("t1");
  old.event(goal("g1", "completed", { elapsed: 754, tokens: 20_500, cycles: 2 }));
  old.end("t1");
  assert.equal(old.asked(), 0, "an older DGC has no goal_runs");
  assert.deepEqual(old.lines().map(text), ["Goal done · 12 min · 20.5k tokens · 2 cycles"], "the line is still said, from what goal_changed told");
});

test("a window that opens on a goal already running (a session that ran with no window) still says its end", () => {
  // Seen live (12 Nov): a session kept running its goal with no window; opened again, its tab showed the goal running
  // (from the panel's state, not a goal_changed), and when the goal was done no line came.
  const x = chat();
  x.v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off",
    goal: { id: "g1", text: "Ship the release", status: "active", elapsed_seconds: 600 } } });
  x.turn("t1");
  const before = x.asked();
  x.event(goal("g1", "completed", { elapsed: 643, tokens: 66_015, cycles: 1 }));
  assert.equal(x.asked(), before + 1, "the page asks DGC for the session's goals");
  x.event({ type: "goal_runs", runs: [run("g1", "completed", { started_at: now() - 643, ended_at: now() + 1, elapsed_seconds: 643, tokens: 66_015, cycles: 1 })] });
  x.end("t1");
  assert.deepEqual(x.lines().map(text), ["Goal done · 10 min · 66k tokens · 1 cycle"]);
  const old = chat({ goalRuns: false });
  old.v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off",
    goal: { id: "g1", text: "Ship the release", status: "active", elapsed_seconds: 600 } } });
  old.turn("t1");
  old.event(goal("g1", "completed", { elapsed: 643, tokens: 66_015, cycles: 1 }));
  old.end("t1");
  assert.deepEqual(old.lines().map(text), ["Goal done · 10 min · 66k tokens · 1 cycle"], "an older DGC: from what goal_changed told");
  const done = chat();
  done.v.send({ type: "state", state: { model: "qwen3.8:27b", mode: "default", think: "off",
    goal: { id: "g1", text: "Ship the release", status: "completed", elapsed_seconds: 60 } } });
  const asked = done.asked();
  done.event(goal("g1", "completed", { elapsed: 60 }));
  assert.equal(done.asked(), asked, "a goal that had ended before the window opened is not a new end");
  assert.deepEqual(x.v.errors, []);
});

test("after a reload the same lines come back, each under the turn its goal ended in", () => {
  const x = chat();
  const turn = (id, at, prompt) => [{ type: "turn_start", turn_id: id, prompt, kind: "prompt" }, { role: "time", of: "prompt", at },
    { type: "text_delta", text: `Reply to ${prompt}` }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" }, { role: "time", of: "reply", at: at + 50 },
    { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];
  const T = 1_794_000_000;
  const before = x.asked();
  x.event({ type: "history", complete: true, items: [...turn("h1", T, "first goal"), ...turn("h2", T + 100, "more of it"), ...turn("h3", T + 1000, "second goal"), ...turn("h4", T + 2000, "a question")] });
  assert.equal(x.asked(), before + 1, "asked once the chat is drawn");
  x.event({ type: "goal_runs", runs: [run("g1", "completed", { name: "First goal", started_at: T, ended_at: T + 160, elapsed_seconds: 150, tokens: 4000, cycles: 2 }),
    run("g2", "blocked", { name: "Second goal", started_at: T + 1000, ended_at: T + 1055, elapsed_seconds: 55, tokens: 1200, cycles: 1 }),
    run("g3", "active", { name: "Third", started_at: T + 2000 })] });
  const replies = [...x.v.doc.querySelectorAll("#log .msg.dgc")];
  assert.equal(replies.length, 4);
  assert.deepEqual(x.lines().map(text), ["Goal done · 2 min · 4k tokens · 2 cycles", "Goal blocked · 55 s · 1.2k tokens · 1 cycle"]);
  assert.equal(x.lines()[0].previousElementSibling, under(replies[1]), "the first goal ended in the second turn");
  assert.equal(x.lines()[1].previousElementSibling, under(replies[2]), "the second in the third");
  assert.deepEqual(x.v.errors, []);
});

test('"/goal-history" is in the "/" menu only on a DGC with goal_runs; it adds a Goals pill that lists the goals newest first', () => {
  const old = chat({ goalRuns: false });
  old.type("/goal-h");
  assert.ok(!(old.menu() || []).some((row) => /^goal-history/.test(row)), "not offered by an older DGC");
  const x = chat();
  assert.equal(x.chip(), null, "no pill until it is asked for");
  x.type("/goal-h");
  assert.match(x.menu()?.[0] || "", /^goal-history/);
  const before = x.asked();
  x.key("Enter");
  assert.equal(x.input.value, "", "the token leaves the draft");
  assert.equal(x.asked(), before + 1, "the list is asked for afresh");
  assert.ok(x.chip(), "a Goals pill on the bar");
  const T = 1_794_000_000;
  x.event({ type: "goal_runs", runs: [run("g1", "completed", { name: "First goal", started_at: T, ended_at: T + 8040 }),
    run("g2", "stopped", { name: "Second goal", started_at: T + 9000, ended_at: T + 9045, elapsed_seconds: 45, tokens: 950, cycles: 1 }),
    run("g3", "active", { name: "Third goal", started_at: T + 10000, elapsed_seconds: 30, tokens: 12_000, cycles: 1 })] });
  assert.match([...x.chip().querySelectorAll(".chip-word, .chip-num, .chip-extra")].map((n) => n.textContent).join(" ").trim(), /^Goals 3$/);
  const pop = x.v.doc.getElementById("rail-pop");
  if (pop.hidden) x.chip().click();
  assert.equal(pop.hidden, false, "its list is open");
  const rows = [...pop.querySelectorAll(".goal-run")];
  assert.deepEqual(rows.map((row) => text(row.querySelector(".goal-run-name"))), ["Third goal", "Second goal", "First goal"], "newest first");
  assert.match(text(rows[0].querySelector(".goal-run-facts")), /^Running now · 30 s · 12k tokens · 1 cycle$/);
  assert.match(text(rows[1].querySelector(".goal-run-facts")), /^Stopped · .+ · 45 s · 950 tokens · 1 cycle$/);
  assert.match(text(rows[2].querySelector(".goal-run-facts")), /^Done · .+ · 2 h 14 min · 1\.8M tokens · 7 cycles$/);
  assert.ok(rows.every((row) => row.querySelector("button.goal-run-trace")), "each has Trace");
  assert.equal(rows[2].querySelector("button.goal-run-trace").disabled, true, "none of its turns are in this chat: Trace has nothing to show");
  pop.querySelector("button.goal-runs-hide").click();
  assert.equal(x.chip(), null, "Hide takes the pill away again");
  assert.deepEqual(x.v.errors, []);
});

test("a goal's Trace opens the Trace of the turns between its start and its end, as one", () => {
  const x = chat();
  const T = 1_794_000_000;
  const turn = (id, at) => [{ type: "turn_start", turn_id: id, prompt: `turn ${id}`, kind: "prompt" }, { role: "time", of: "prompt", at },
    { role: "time", of: "trace", at: at + 2, tokens: 300 }, { type: "tool_call", call_id: `c-${id}`, name: "read_file", args: {}, summary: `read ${id}.py` },
    { role: "time", of: "trace", at: at + 3 }, { type: "tool_result", call_id: `c-${id}`, name: "read_file", output: "one\n", is_error: false },
    { type: "text_delta", text: "Done." }, { role: "time", of: "trace", at: at + 5, tokens: 200 }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
    { role: "time", of: "reply", at: at + 5 }, { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];
  x.event({ type: "history", complete: true, items: [...turn("h1", T - 500), ...turn("h2", T + 10), ...turn("h3", T + 100), ...turn("h4", T + 900)] });
  x.event({ type: "goal_runs", runs: [run("g1", "completed", { name: "The goal", started_at: T, ended_at: T + 200, elapsed_seconds: 110, tokens: 1000, cycles: 2 })] });
  x.type("/goal-h"); x.key("Enter");
  const pop = x.v.doc.getElementById("rail-pop");
  if (pop.hidden) x.chip().click();
  const trace = pop.querySelector(".goal-run button.goal-run-trace");
  assert.equal(trace.disabled, false);
  trace.click();
  const dialog = x.v.doc.querySelector(".dgc-trace-dialog");
  assert.ok(dialog, "Trace opens");
  assert.match(text(dialog.querySelector(".dgc-trace-head")), /The goal/);
  assert.match(text(dialog.querySelector(".dgc-trace-head")), /2 turns/);
  const labels = [...dialog.querySelectorAll(".dgc-trace-row")].map((row) => row.title);
  assert.equal(labels.filter((l) => /read h2\.py/.test(l)).length, 1, "the goal's first turn");
  assert.equal(labels.filter((l) => /read h3\.py/.test(l)).length, 1, "and its second");
  assert.ok(!labels.some((l) => /read h1\.py|read h4\.py/.test(l)), "no turn from before it began or after it ended");
  assert.equal(dialog.querySelector(".dgc-trace-scrub").max, "95000", "from its first turn's start to its last turn's end");
  assert.deepEqual(x.v.errors, []);
});

test("a goal's own next turn says which goal turn it is; any other resume keeps its words", () => {
  // The goal's turns (12 Nov night): each goal cycle is a turn of its own, started by DGC ("resume" on the wire, labelled
  // "Goal · turn N"), never drawn as something you sent.
  const x = chat();
  x.event({ type: "turn_start", turn_id: "t1", prompt: "Ship the release", kind: "prompt" });
  x.event({ type: "turn_end", turn_id: "t1", reason: "completed" });
  x.event({ type: "turn_start", turn_id: "t2", prompt: "Goal · turn 2", kind: "resume" });
  const notes = () => [...x.v.doc.querySelectorAll("#log .resume-note")].map((n) => text(n));
  assert.deepEqual(notes(), ["Goal · turn 2"]);
  assert.ok(x.v.doc.querySelector("#log .resume-note.goal-turn-note"), "drawn as a goal turn");
  assert.equal(x.v.doc.querySelectorAll("#log .msg.user").length, 1, "only the prompt you sent is a bubble");
  x.event({ type: "turn_end", turn_id: "t2", reason: "completed" });
  x.event({ type: "turn_start", turn_id: "t3", prompt: "Continue the standing goal from where the previous session stopped.", kind: "resume" });
  assert.deepEqual(notes(), ["Goal · turn 2", "Resumed the standing goal"]);
  x.event({ type: "turn_end", turn_id: "t3", reason: "completed" });
  x.event({ type: "turn_start", turn_id: "t4", prompt: "Goal · turn <b>2</b>", kind: "resume" });
  assert.equal(notes().at(-1), "Resumed the standing goal", "only DGC's own label is shown");
  assert.deepEqual(x.v.errors, []);
});
