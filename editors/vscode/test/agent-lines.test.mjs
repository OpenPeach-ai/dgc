// Sub-agents in the transcript, the way Codex draws them: quiet stable lines, at most four agents
// from one batch per line. Faces first, then a sentence in which only the names are controls --
// "Durable rules review, Remote web and Paper pip concept started working" -- whose words change in
// place while the names stay where they are. Each agent used to get a full-width row of its own.
//
// What a line reads, which spawns share one, what opens a page and where focus goes back to, nested
// agents on their parent's page, background agents that outlive their turn, and the spawn notices a
// line replaces. Layout (alignment, wrapping, contrast) is measured in agent-lines-layout.test.mjs;
// live-versus-reload in agent-lines-replay.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { makeDom, mainCss, mainJs } from "./support/webview-dom.mjs";

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;

function panel({ clock = true, capabilities = { agents: true } } = {}) {
  const v = makeDom({ clock });
  const event = (data) => v.send({ type: "event", event: data });
  event({ type: "ready", capabilities, model: "m", mode: "auto", think: "off", base_url: "http://127.0.0.1:1/v1",
    workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  const $ = (id) => v.doc.getElementById(id);
  return { ...v, event, $ };
}
// The sentence as it reads on screen: the sr-only pauses between clauses are for screen readers.
const shown = (line) => {
  const copy = line.querySelector(".agent-line-text").cloneNode(true);
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.textContent.replace(/\u00a0/g, " ");   // a count keeps its word with a no-break space
};
const lines = (doc) => [...doc.querySelectorAll("#log .agent-line")];
const lineText = (doc) => lines(doc).map(shown);
const spawn = (event, n, description, extra = {}) =>
  event({ type: "tool_call", call_id: `call_${n}`, name: "task", args: { description }, summary: "", ...extra });
const start = (event, n, description, extra = {}) => event({ type: "agent_started", id: sid(n), parent_id: null,
  call_id: `call_${n}`, description, depth: 1, state: "running", started_at: n, isolated: true, parallel: false, ...extra });
const update = (event, n, extra = {}) => event({ type: "agent_updated", id: sid(n), state: "running", ...extra });
const end = (event, n, state = "finished", extra = {}) =>
  event({ type: "agent_ended", id: sid(n), state, duration_ms: 1000, tool_calls: 1, ...extra });
const nameOf = (doc, n, root = "#log") => doc.querySelector(`${root} .agent-name[data-agent-id="${sid(n)}"]`);
const click = (node) => node.dispatchEvent(new node.ownerDocument.defaultView.MouseEvent("click", { bubbles: true }));

// Three agents of one parallel batch, started and past their "started working" window.
function batchOfThree(p, names = ["A", "B", "C"]) {
  p.event({ type: "turn_start", turn_id: "t1", prompt: "split the work" });
  names.forEach((name, i) => spawn(p.event, i + 1, name));
  names.forEach((name, i) => start(p.event, i + 1, name, { parallel: true }));
  p.advance(2000);
}

test("one delegated agent becomes one muted line", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "count the lines" });
  spawn(p.event, 0, "Count the lines in README.md");
  const group = p.doc.querySelector('.tool[data-tool-name="task"]').closest(".tool-group");
  assert.equal(group.open, false, "the spawn's group is created folded: its header already names the delegation");
  p.event({ type: "info", message: "⟳ sub-task: Count the lines in README.md" });
  p.event({ type: "info", message: "↳ isolated checkout: /tmp/wt" });
  start(p.event, 0, "Count the lines in README.md");
  const all = lines(p.doc);
  assert.equal(all.length, 1);
  const line = all[0];
  assert.equal(line.tagName, "DIV");
  assert.equal(line.getAttribute("role"), "group");
  assert.equal(line.getAttribute("aria-label"), "Sub-agent");
  const faces = line.firstElementChild;
  assert.ok(faces.matches(".agent-line-faces[aria-hidden='true']"), "faces come first, hidden from screen readers");
  assert.equal(faces.querySelectorAll(".agent-mark.is-live").length, 1);
  const focusable = [...line.querySelectorAll("button, a[href], input, select, textarea, [tabindex]")];
  assert.equal(focusable.length, 1, "only the name is a control");
  assert.ok(focusable[0].matches("button.agent-name[type='button']"));
  assert.equal(line.querySelector(".agent-line-text").textContent, "Count the lines in README.md started working");
  assert.ok(group.classList.contains("agent-owned"), "the spawn's group gives way to the line");
  assert.equal(group.nextElementSibling, line);
  assert.equal(group.open, false);
  assert.equal(p.doc.querySelector(".agent-chip"), null);
  assert.equal([...p.doc.querySelectorAll(".sys")].filter((n) => /sub-task|isolated checkout/.test(n.textContent)).length, 0,
    "the spawn notices are what the line says now");
  assert.deepEqual(p.errors, []);
});

test("started working, then running, then finished -- in place", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 1, "Write the parser");
  start(p.event, 1, "Write the parser");
  const line = lines(p.doc)[0], name = nameOf(p.doc, 1);
  assert.equal(shown(line), "Write the parser started working");
  p.advance(1999);
  assert.equal(shown(line), "Write the parser started working");
  p.advance(1);
  assert.equal(shown(line), "Write the parser running", "two seconds after it really started");
  end(p.event, 1);
  assert.equal(shown(line), "Write the parser finished");
  assert.equal(line.querySelector(".is-live"), null, "the face goes still");
  assert.equal(lines(p.doc)[0], line, "the same line throughout");
  assert.equal(nameOf(p.doc, 1), name, "and the same name button");
  assert.deepEqual(p.errors, []);
});

test("three started together share one line, and their words change together", () => {
  const p = panel();
  const names = ["Durable rules review", "Remote web", "Paper pip concept"];
  p.event({ type: "turn_start", turn_id: "t1", prompt: "three things" });
  names.forEach((name, i) => spawn(p.event, i + 1, name));
  p.event({ type: "info", message: "↯ running 3 isolated sub-tasks in parallel (max 4)" });
  names.forEach((name, i) => {
    p.event({ type: "info", message: `⟳ sub-task: ${name}` });
    p.event({ type: "info", message: `↳ isolated checkout: /tmp/wt${i}` });
    start(p.event, i + 1, name, { state: "queued", parallel: true });
  });
  assert.deepEqual(lineText(p.doc), ["Durable rules review, Remote web and Paper pip concept queued"]);
  const faces = [...lines(p.doc)[0].querySelectorAll(".agent-line-faces .agent-mark")].map((n) => n.dataset.agentId);
  assert.deepEqual(faces, [sid(1), sid(2), sid(3)], "faces in the cards' order");
  // Workers take them a few milliseconds apart.
  update(p.event, 1); p.advance(5); update(p.event, 2); p.advance(4); update(p.event, 3);
  assert.deepEqual(lineText(p.doc), ["Durable rules review, Remote web and Paper pip concept started working"]);
  p.advance(1999);                                   // t+2008: the first one's window is over, but not the last
  assert.deepEqual(lineText(p.doc), ["Durable rules review, Remote web and Paper pip concept started working"]);
  p.advance(1);                                      // t+2009: the line's one timer, at the latest window's end
  assert.deepEqual(lineText(p.doc), ["Durable rules review, Remote web and Paper pip concept running"]);
  assert.equal(p.doc.querySelectorAll(".sys").length, 0);
  assert.deepEqual(p.errors, []);
});

test("names keep their places as members diverge; only the words between them change", () => {
  const p = panel();
  batchOfThree(p);
  const before = [...p.doc.querySelectorAll("#log .agent-name")];
  const same = () => {
    const now = [...p.doc.querySelectorAll("#log .agent-name")];
    assert.equal(now.length, before.length);
    now.forEach((node, i) => assert.equal(node, before[i], "a name was replaced or moved"));
  };
  end(p.event, 2);
  assert.deepEqual(lineText(p.doc), ["A running · B finished · C running"]);
  same();
  end(p.event, 1);
  assert.deepEqual(lineText(p.doc), ["A and B finished · C running"]);
  same();
  end(p.event, 3, "failed", { message: "the sub-agent stopped without a final summary\nTraceback: …" });
  assert.deepEqual(lineText(p.doc), ["A and B finished · C failed"]);
  same();
  assert.equal(p.doc.querySelectorAll("#log .agent-state[data-state='failed']").length, 1);
  assert.equal(nameOf(p.doc, 3).getAttribute("title"), "Open C\nthe sub-agent stopped without a final summary",
    "a failed agent's name says why");
  assert.equal(nameOf(p.doc, 1).getAttribute("title"), "Open A");
  assert.deepEqual(p.errors, []);
});

test("a snapshot mid-window keeps 'started working' to its end, and never opens a window itself", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 1, "A");
  start(p.event, 1, "A");
  p.advance(500);
  const listed = (state) => ({ type: "agents", items: [{ id: sid(1), parent_id: null, call_id: "call_1", description: "A",
    depth: 1, state, started_at: 1 }], total: 1, active: state === "running" ? 1 : 0 });
  p.event(listed("running"));
  assert.deepEqual(lineText(p.doc), ["A started working"], "the live window survives a snapshot");
  p.advance(1500);
  assert.deepEqual(lineText(p.doc), ["A running"]);
  // A record first seen in a snapshot (a reload, a resume, a chat switch) is just running.
  const q = panel();
  q.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(q.event, 1, "A");
  q.event(listed("running"));
  assert.deepEqual(lineText(q.doc), ["A running"]);
  assert.deepEqual([...p.errors, ...q.errors], []);
});

test("a parallel child reads queued until a worker takes it", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 1, "A");
  start(p.event, 1, "A", { state: "queued", parallel: true });
  p.advance(5000);
  assert.deepEqual(lineText(p.doc), ["A queued"], "never 'started working' while it waits");
  update(p.event, 1);
  assert.deepEqual(lineText(p.doc), ["A started working"]);
  p.advance(2000);
  assert.deepEqual(lineText(p.doc), ["A running"]);
  assert.deepEqual(p.errors, []);
});

test("an agent waiting on you says what for, and the word is the one that stands out", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 1, "A"); spawn(p.event, 2, "B");
  start(p.event, 1, "A"); start(p.event, 2, "B");
  p.advance(2000);
  update(p.event, 1, { state: "waiting", waiting_for: "permission" });
  assert.deepEqual(lineText(p.doc), ["A waiting for your permission · B running"]);
  assert.ok(p.doc.querySelector("#log .agent-state[data-state='waiting']"));
  update(p.event, 1, { state: "waiting", waiting_for: "answer" });
  assert.deepEqual(lineText(p.doc), ["A waiting for your answer · B running"]);
  update(p.event, 1);
  assert.deepEqual(lineText(p.doc), ["A and B running"], "back to running, with no new 'started working'");
  assert.deepEqual(p.errors, []);
});

test("more than three: two names and 'N more', which reveals every name in place", () => {
  const p = panel();
  const names = ["A", "B", "C", "D"];
  p.event({ type: "turn_start", turn_id: "t1", prompt: "four" });
  names.forEach((name, i) => spawn(p.event, i + 1, name));
  names.forEach((name, i) => start(p.event, i + 1, name, { parallel: true }));
  assert.deepEqual(lineText(p.doc), ["A, B and 2 more started working"]);
  const line = lines(p.doc)[0];
  assert.equal(line.querySelectorAll(".agent-line-faces .agent-mark").length, 4, "all four faces");
  const more = line.querySelector(".agent-line-more");
  assert.equal(more.tagName, "BUTTON");
  assert.equal(more.getAttribute("aria-label"), "Show 2 more agents");
  assert.equal(more.hasAttribute("aria-expanded"), false, "one way: it is gone once used");
  end(p.event, 3);
  p.advance(2000);
  assert.deepEqual(lineText(p.doc), ["A, B and 2 more · 3 running · 1 finished"]);
  assert.deepEqual([...line.querySelectorAll(".agent-line-tail .agent-state")].map((n) => n.textContent),
    ["3\u00a0running", "1\u00a0finished"], "a count never ends a row without its word");
  more.focus();
  more.click();
  assert.deepEqual(lineText(p.doc), ["A and B running · C finished · D running"]);
  assert.equal(line.querySelector(".agent-line-more"), null);
  assert.equal(p.doc.activeElement, nameOf(p.doc, 3), "focus moves to the first name it revealed");
  update(p.event, 4, { tool_calls: 3 });
  assert.deepEqual(lineText(p.doc), ["A and B running · C finished · D running"], "and it stays expanded");
  assert.deepEqual(p.errors, []);
});

test("eight agents in one fan-out use two stable lines of four with every face visible", () => {
  const p = panel();
  const names = ["A", "B", "C", "D", "E", "F", "G", "H"];
  p.event({ type: "turn_start", turn_id: "t1", prompt: "eight" });
  names.forEach((name, i) => spawn(p.event, i + 1, name));
  names.forEach((name, i) => start(p.event, i + 1, name, { parallel: true }));
  const rows = lines(p.doc);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => [...row.querySelectorAll(".agent-mark")].map((mark) => mark.dataset.agentId)),
    [[1, 2, 3, 4].map(sid), [5, 6, 7, 8].map(sid)]);
  assert.deepEqual(rows.map((row) => row.dataset.agentIds.split(" ")),
    [[1, 2, 3, 4].map(sid), [5, 6, 7, 8].map(sid)]);
  assert.equal(rows[0].nextElementSibling, rows[1], "the second row stays directly below the first");
  assert.deepEqual(p.errors, []);
});

test("only the names open pages; Back and Escape return focus to the name that was used", () => {
  const p = panel();
  batchOfThree(p);
  end(p.event, 2);
  const line = lines(p.doc)[0];
  for (const target of [line, line.querySelector(".agent-state"), line.querySelector(".agent-line-faces .agent-mark"),
    line.querySelector(".agent-line-glue")]) {
    click(target);
    assert.equal(p.doc.body.dataset.agentPage, undefined, `a click on ${target.className} opened a page`);
  }
  const b = nameOf(p.doc, 2);
  b.focus();
  b.click();
  assert.equal(p.doc.body.dataset.agentPage, sid(2));
  assert.equal(p.$("thread-title").textContent, "B");
  assert.equal(p.$("agent-back").getAttribute("title"), "Back to chat");
  p.$("agent-back").click();
  assert.equal(p.doc.body.dataset.agentPage, undefined);
  assert.equal(p.doc.activeElement, b, "focus is back on the name that opened the page");
  b.click();
  p.doc.dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(p.doc.body.dataset.agentPage, undefined);
  assert.equal(p.doc.activeElement, b);
  // From the agents list, Back returns to the pill.
  p.$("agents-pill").click();
  p.doc.querySelector(`.agent-row[data-agent-id="${sid(3)}"]`).click();
  assert.equal(p.doc.body.dataset.agentPage, sid(3));
  p.$("agent-back").click();
  assert.equal(p.doc.activeElement, p.$("agents-pill"));
  assert.deepEqual(p.errors, []);
});

// What sits between two spawns, and whether they still share a line. Only the model's own output and
// the user's steering split a batch; every other row exists live or on replay but not both.
const BETWEEN = {
  "prose": { lines: 2, events: [{ type: "text_delta", text: "Now the second part." }, { type: "stream_end", message_id: "t1:1", phase: "commentary" }] },
  "the model's reasoning": { lines: 2, events: [
    { type: "thinking_delta", block: "t1:th1", source: "raw", text: "The second part needs its own agent." },
    { type: "thinking_end", block: "t1:th1", source: "raw", placement: "collapsed", seconds: 2 }] },
  // Hidden reasoning is still the model's own step, and a reload draws it (hidden) in the same place.
  "the model's reasoning, with reasoning hidden": { lines: 2, events: [
    { type: "config", model: "m", mode: "auto", think: "high", show_reasoning: false },
    { type: "thinking_delta", block: "t1:th1", source: "raw", text: "The second part needs its own agent." },
    { type: "thinking_end", block: "t1:th1", source: "raw", placement: "collapsed", seconds: 2 }] },
  "a visible tool group": { lines: 2, group: true, events: [
    { type: "tool_call", call_id: "r1", name: "read_file", args: { path: "README.md" }, summary: "README.md" },
    { type: "tool_result", call_id: "r1", name: "read_file", output: "# readme", is_error: false }] },
  "a steering prompt": { lines: 2, steer: true, events: [] },
  "an approval card and its answer": { lines: 1, events: [
    { type: "permission_request", id: "p1", call_id: "call_2", name: "task", args: { description: "B" }, summary: "B",
      suggested_rule: "task", choices: ["once", "always", "deny"] },
    { type: "permission_resolved", id: "p1", decision: "once", message: "Allowed once" }] },
  "a child's file chip with its raw call id": { lines: 1, events: [{ type: "files_ready", call_id: "c7", items: [{ name: "out.txt", rel: "out.txt", bytes: 3 }] }] },
  "an artifact": { lines: 1, events: [{ type: "artifact_ready", id: "a1", name: "demo", url: "http://127.0.0.1:5173/" }] },
  "a sub-agent's retry line": { lines: 1, events: [{ type: "model_retry", retry_id: `t1:${sid(1)}:retry1`, state: "retrying", kind: "connect",
    layer: "request", attempt: 1, max_attempts: 3, summary: "connection refused", delay_ms: 500, origin: "subagent", agent: sid(1), turn_id: "t1" }] },
  "the parent's request-layer retry": { lines: 1, events: [{ type: "model_retry", retry_id: "t1:retry1", state: "retrying", kind: "connect",
    layer: "request", attempt: 1, max_attempts: 3, summary: "connection refused", delay_ms: 500, origin: "agent", turn_id: "t1" }] },
  "a monitor card": { lines: 1, events: [{ type: "monitor_event", id: "m1", description: "npm run dev", event_index: 1, lines: ["ready"],
    omitted_lines: 0, kind: "output", delivery: "inline", turn_id: "t1" }] },
  "a notice": { lines: 1, events: [{ type: "info", message: "↳ this project has no Git HEAD; sub-task writes use the shared checkout" }] },
  "a plan update": { lines: 1, events: [{ type: "tool_call", call_id: "td1", name: "todo", args: { todos: [] }, summary: "" },
    { type: "tool_result", call_id: "td1", name: "todo", output: "ok", is_error: false }] },
  "blank prose": { lines: 1, events: [{ type: "text_delta", text: "  \n" }, { type: "stream_end", message_id: "t1:1", phase: "commentary" }] },
};
for (const [what, { lines: count, events, group, steer }] of Object.entries(BETWEEN)) {
  test(`between two spawns, ${what} ${count === 2 ? "starts a new line" : "never splits the batch"}`, () => {
    const p = panel({ capabilities: { agents: true, live_steering: true } });
    p.event({ type: "turn_start", turn_id: "t1", prompt: "two parts" });
    spawn(p.event, 1, "A"); start(p.event, 1, "A");
    for (const frame of events) p.event(frame);
    if (steer) {
      const input = p.$("input");
      input.value = "also check the docs";
      input.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
      p.$("send").click();
      const id = [...p.posted].reverse().find((m) => m?.type === "prompt")?.requestId;
      p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
      p.event({ type: "steering_update", request_id: id, state: "applied" });
      assert.ok(p.doc.querySelector(".msg.dgc .msg.user"), "the steer landed in the turn");
    }
    spawn(p.event, 2, "B"); start(p.event, 2, "B");
    p.advance(2000);
    assert.deepEqual(lineText(p.doc), count === 2 ? ["A running", "B running"] : ["A and B running"]);
    if (group) {
      const [first, second] = lines(p.doc);
      const visible = p.doc.querySelector('.tool[data-tool-name="read_file"]').closest(".tool-group");
      assert.equal(visible.classList.contains("agent-owned"), false);
      const FOLLOWING = p.dom.window.Node.DOCUMENT_POSITION_FOLLOWING;
      assert.ok(first.compareDocumentPosition(visible) & FOLLOWING && visible.compareDocumentPosition(second) & FOLLOWING,
        "the read group stays visible between the two lines");
    }
    assert.deepEqual(p.errors, []);
  });
}

test("the step around a spawn: earlier tools stay above, later ones open a group below the line", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  p.event({ type: "tool_call", call_id: "r1", name: "read_file", args: { path: "a.py" }, summary: "a.py" });
  p.event({ type: "tool_result", call_id: "r1", name: "read_file", output: "x", is_error: false });
  spawn(p.event, 1, "A"); start(p.event, 1, "A");
  p.event({ type: "tool_call", call_id: "b1", name: "bash", args: { command: "ls" }, summary: "ls" });
  p.event({ type: "tool_result", call_id: "b1", name: "bash", output: "a.py", is_error: false });
  const turnBlock = p.doc.querySelector(".msg.dgc");
  const sequence = () => [...turnBlock.children].filter((n) => !n.matches(".role, .thinking")).map((n) =>
    n.matches(".agent-line") ? "line"
      : `${n.classList.contains("agent-owned") ? "hidden" : "group"}:${[...n.querySelectorAll(":scope > .tool")].map((c) => c.dataset.toolName).join(",")}:${n.open ? "open" : "folded"}`);
  assert.deepEqual(sequence(), ["group:read_file:open", "hidden:task:folded", "line", "group:bash:open"],
    "nothing folds mid-step");
  p.event({ type: "text_delta", text: "Done." });
  assert.deepEqual(sequence().slice(0, 4), ["group:read_file:folded", "hidden:task:folded", "line", "group:bash:folded"],
    "both fold when the model moves on");
  assert.deepEqual(p.errors, []);
});

test("a background agent's line outlives its turn, and its late work opens no turn", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "count in the background" });
  spawn(p.event, 1, "count");
  start(p.event, 1, "count", { background: true });
  p.event({ type: "tool_result", call_id: "call_1", name: "task", output: `Sub-task 'count' is running in the background (id ${sid(1)}).`, is_error: false });
  p.event({ type: "text_delta", text: "It is counting." });
  p.event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: null });
  p.event({ type: "turn_start", turn_id: "t2", prompt: "and meanwhile" });
  p.event({ type: "text_delta", text: "Meanwhile, hello." });
  p.event({ type: "turn_end", turn_id: "t2", reason: "completed", final_message_id: null });
  end(p.event, 1);
  p.event({ type: "thinking_delta", block: "c:th1", source: "raw", agent: sid(1), text: "late reasoning" });
  p.event({ type: "thinking_end", block: "c:th1", source: "raw", agent: sid(1), placement: "collapsed", seconds: 1 });
  p.event({ type: "tool_call", call_id: `${sid(1)}:g1`, name: "grep", args: { pattern: "x" }, summary: "x" });
  const turns = [...p.doc.querySelectorAll("#log .msg.dgc")];
  assert.equal(turns.length, 2, "no phantom turn for the child's late reasoning or step");
  assert.deepEqual(lineText(p.doc), ["count finished"]);
  assert.ok(turns[0].contains(lines(p.doc)[0]), "the line stays in the turn that started the agent");
  const grep = p.doc.querySelector(`.tool[data-call-id="${sid(1)}:g1"]`);
  assert.ok(grep.classList.contains("agent-owned") && turns[0].contains(grep), "its step is filed, hidden, with its line");
  assert.deepEqual(p.errors, []);
});

test("a backend exit stops the active members; the new backend's snapshot wins", () => {
  const p = panel();
  batchOfThree(p);
  end(p.event, 1);
  p.send({ type: "backend_exit", code: 1, recovering: true, resumes: "offer" });
  assert.deepEqual(lineText(p.doc), ["A finished · B and C stopped"]);
  assert.equal(nameOf(p.doc, 2).getAttribute("title"), "Open B\nDGC's backend stopped");
  p.event({ type: "agents", items: [1, 2, 3].map((n) => ({ id: sid(n), parent_id: null, call_id: `call_${n}`,
    description: ["A", "B", "C"][n - 1], depth: 1, state: "finished", tool_calls: 2, isolated: true, parallel: true,
    started_at: n })), total: 3, active: 0 });
  assert.deepEqual(lineText(p.doc), ["A, B and C finished"]);
  assert.deepEqual(p.errors, []);
});

// Nested agents (depth 2, opt-in) leave the main chat: they are a line on their parent's page.
function nested(p) {
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go deep" });
  spawn(p.event, 1, "Parent work");
  start(p.event, 1, "Parent work");
  p.event({ type: "tool_call", call_id: `${sid(1)}:call_0`, name: "task", args: { description: "Nested check" }, summary: "" });
  p.event({ type: "agent_started", id: sid(2), parent_id: sid(1), call_id: `${sid(1)}:call_0`, description: "Nested check",
    depth: 2, state: "running", started_at: 2, isolated: false, parallel: false });
  p.event({ type: "tool_call", call_id: `${sid(1)}:${sid(2)}:g1`, name: "grep", args: { pattern: "TODO" }, summary: "TODO" });
}

test("a nested agent is a line on its parent's page, and Back steps back one page at a time", () => {
  const p = panel();
  nested(p);
  assert.deepEqual(lines(p.doc).map((line) => line.dataset.agentIds), [sid(1)], "the chat has one line, the parent's");
  const parentName = nameOf(p.doc, 1);
  parentName.focus();
  parentName.click();
  const page = p.$("agent-log");
  const child = page.querySelector(`.agent-line .agent-name[data-agent-id="${sid(2)}"]`);
  assert.ok(child, "the nested agent is a line on its parent's page");
  assert.equal(page.querySelector('.tool[data-tool-name="grep"]'), null, "the nested agent's own steps are on its own page");
  assert.equal(page.querySelector('.tool[data-tool-name="task"]'), null, "and its spawn is the line, not a raw card");
  child.focus();
  child.click();
  assert.equal(p.doc.body.dataset.agentPage, sid(2));
  assert.ok(page.querySelector('.tool[data-tool-name="grep"]'), "the nested agent's page has its step");
  assert.equal(p.$("agent-back").getAttribute("title"), "Back to Parent work");
  assert.equal(p.$("agent-back").getAttribute("aria-label"), "Back to Parent work");
  p.$("agent-back").click();
  assert.equal(p.doc.body.dataset.agentPage, sid(1), "Back returns to the parent's page");
  assert.equal(p.doc.activeElement, page.querySelector(`.agent-name[data-agent-id="${sid(2)}"]`),
    "with focus on the nested agent's name");
  assert.equal(p.$("agent-back").getAttribute("title"), "Back to chat");
  p.$("agent-back").click();
  assert.equal(p.doc.body.dataset.agentPage, undefined, "and again to the chat");
  assert.equal(p.doc.activeElement, parentName, "with focus on the parent's name in the chat");
  // A page opened from the agents list starts over: Back goes straight to the chat.
  parentName.click();
  page.querySelector(`.agent-name[data-agent-id="${sid(2)}"]`).click();
  p.$("agents-pill").click();
  p.doc.querySelector(`.agent-row[data-agent-id="${sid(1)}"]`).click();
  assert.equal(p.$("agent-back").getAttribute("title"), "Back to chat");
  p.$("agent-back").click();
  assert.equal(p.doc.body.dataset.agentPage, undefined);
  assert.deepEqual(p.errors, []);
});

test("a nested spawn while the parent's page is open is claimed in the chat, never on the page", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go deep" });
  spawn(p.event, 1, "Parent work");
  start(p.event, 1, "Parent work");
  nameOf(p.doc, 1).click();
  p.event({ type: "tool_call", call_id: `${sid(1)}:call_0`, name: "task", args: { description: "Nested check" }, summary: "" });
  // The parent's own update repaints its page, which now holds a copy of the unclaimed nested spawn.
  update(p.event, 1, { tool_calls: 1 });
  assert.ok(p.$("agent-log").querySelector('.tool[data-tool-name="task"]'), "premise: the page holds a copy of the spawn card");
  p.event({ type: "agent_started", id: sid(2), parent_id: sid(1), call_id: `${sid(1)}:call_0`, description: "Nested check",
    depth: 2, state: "running", started_at: 2, isolated: false, parallel: false });
  const card = p.doc.querySelector(`#log .tool[data-call-id="${sid(1)}:call_0"]`);
  assert.equal(card.dataset.agentId, sid(2), "the chat's card is the one claimed");
  assert.equal(p.$("agent-log").querySelector(`.tool[data-agent-id="${sid(2)}"]`), null, "never the page's copy");
  assert.ok(p.$("agent-log").querySelector(`.agent-line .agent-name[data-agent-id="${sid(2)}"]`), "the page shows a line");
  update(p.event, 1, { tool_calls: 2 });
  assert.ok(p.$("agent-log").querySelector(`.agent-line .agent-name[data-agent-id="${sid(2)}"]`), "and keeps it on a repaint");
  assert.equal(p.doc.querySelector(`#log .tool[data-call-id="${sid(1)}:call_0"]`).dataset.agentId, sid(2));
  assert.deepEqual(p.errors, []);
});

test("a nested agent's updates repaint its line on the page in place, keeping a focused name", () => {
  const p = panel();
  nested(p);
  nameOf(p.doc, 1).click();
  const child = p.$("agent-log").querySelector(`.agent-name[data-agent-id="${sid(2)}"]`);
  child.focus();
  update(p.event, 2, { tool_calls: 4 });
  update(p.event, 2, { tool_calls: 5, activity: "reading" });
  assert.equal(p.$("agent-log").querySelector(`.agent-name[data-agent-id="${sid(2)}"]`), child, "the same node, not a repaint");
  assert.equal(p.doc.activeElement, child);
  update(p.event, 1, { tool_calls: 9 });                // the parent's own update rebuilds its page
  assert.equal(p.doc.activeElement?.dataset.agentId, sid(2), "a rebuild gives focus back to the name");
  assert.deepEqual(p.errors, []);
});

test("the spawn notices are not drawn when the backend reports agents; other notices are", () => {
  const notices = ["⟳ sub-task: map auth [explorer]", "↳ isolated checkout: /tmp/wt/map-auth",
    "↯ running 2 isolated sub-tasks in parallel (max 4)"];
  const others = ["↳ this project has no Git HEAD; sub-task writes use the shared checkout",
    "↳ subagent_link_paths not shared — node_modules: no such file", "↯ running 2 independent reads in parallel"];
  for (const [capabilities, drawn] of [[{ agents: true }, others], [{}, [...notices, ...others]]]) {
    const p = panel({ capabilities });
    p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
    for (const message of [...notices, ...others]) p.event({ type: "info", message });
    assert.deepEqual([...p.doc.querySelectorAll(".sys")].map((n) => n.textContent), drawn, JSON.stringify(capabilities));
    assert.deepEqual(p.errors, []);
  }
});

test("provisional lines: an agent whose spawn card is not on screen yet", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  start(p.event, 1, "Early starter");
  const turnBlock = p.doc.querySelector(".msg.dgc");
  const provisional = lines(p.doc)[0];
  assert.ok(provisional, "a line at the end of the turn");
  assert.equal(provisional.nextElementSibling, turnBlock.querySelector(".thinking"));
  spawn(p.event, 1, "Early starter");
  const line = lines(p.doc)[0];
  assert.equal(lines(p.doc).length, 1);
  assert.equal(provisional.isConnected, false, "the provisional line is gone");
  assert.equal(line.previousElementSibling, p.doc.querySelector('.tool[data-call-id="call_1"]').closest(".tool-group"),
    "the member moved under its card");
  // Ending with no card: the line goes, as a reload would draw none.
  start(p.event, 2, "Never had a card");
  assert.equal(lines(p.doc).length, 2);
  end(p.event, 2);
  assert.deepEqual(lines(p.doc).map((n) => n.dataset.agentIds), [sid(1)]);
  // A snapshot that no longer lists a provisional member removes it.
  start(p.event, 3, "Dropped");
  assert.equal(lines(p.doc).length, 2);
  p.event({ type: "agents", items: [{ id: sid(1), parent_id: null, call_id: "call_1", description: "Early starter", depth: 1,
    state: "running", started_at: 1 }], total: 1, active: 1 });
  assert.deepEqual(lines(p.doc).map((n) => n.dataset.agentIds), [sid(1)]);
  // A restored, ended record with no card draws nothing.
  p.event({ type: "agents", items: [{ id: sid(1), parent_id: null, call_id: "call_1", description: "Early starter", depth: 1,
    state: "running", started_at: 1 }, { id: sid(9), parent_id: null, call_id: "old", description: "Restored", depth: 1,
    state: "finished", restored: true }], total: 2, active: 1 });
  assert.deepEqual(lines(p.doc).map((n) => n.dataset.agentIds), [sid(1)]);
  assert.deepEqual(p.errors, []);
});

// One delegated pair, finished, as the live turn draws it and as a history replays it.
const pairHistory = [
  { type: "turn_start", turn_id: "h1", prompt: "two parts", kind: "prompt" },
  { type: "tool_call", call_id: "call_1", name: "task", args: { description: "A" }, summary: "" },
  { type: "tool_call", call_id: "call_2", name: "task", args: { description: "B" }, summary: "" },
  { type: "tool_result", call_id: "call_1", name: "task", output: "Sub-task 'A' completed with no file changes.\nSummary:\nok", is_error: false },
  { type: "tool_result", call_id: "call_2", name: "task", output: "Sub-task 'B' completed with no file changes.\nSummary:\nok", is_error: false },
  { type: "text_delta", text: "Both done." },
  { type: "stream_end", message_id: "h1:1", phase: "answer" },
  { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" },
];
const onlyB = { type: "agents", items: [{ id: sid(2), parent_id: null, call_id: "call_2", description: "B", depth: 1,
  state: "finished", tool_calls: 1, started_at: 2 }], total: 1, active: 0 };
// A hidden group's header is never seen (its label is not kept current while every card in it is
// claimed), so only a visible group is compared by what it says.
const turnShape = (doc) => [...doc.querySelectorAll("#log .msg.dgc > *")].filter((n) => !n.matches(".role, .thinking")).map((n) =>
  n.matches(".agent-line") ? `line:${shown(n)}`
    : n.matches(".tool-group.agent-owned") ? "hidden"
      : n.matches(".tool-group") ? `group:${n.querySelector(".tool-group-label").textContent}`
        : n.className);

test("an agent the backend stops listing gives its spawn back, exactly as a reload draws it", () => {
  const live = panel();
  live.event({ type: "turn_start", turn_id: "t1", prompt: "two parts" });
  spawn(live.event, 1, "A"); spawn(live.event, 2, "B");
  start(live.event, 1, "A", { parallel: true }); start(live.event, 2, "B", { parallel: true });
  end(live.event, 1); end(live.event, 2);
  for (const n of [1, 2]) live.event(pairHistory[2 + n]);
  for (const frame of pairHistory.slice(5)) live.event(frame);
  assert.deepEqual(lineText(live.doc), ["A and B finished"]);
  live.event(onlyB);
  assert.deepEqual(lineText(live.doc), ["B finished"], "A leaves the line");
  const group = live.doc.querySelector('.tool[data-call-id="call_1"]').closest(".tool-group");
  assert.equal(group.classList.contains("agent-owned"), false, "A's spawn is visible again");
  assert.equal(group.querySelector(".tool-group-label").textContent, "Delegated A");
  const reloaded = panel();
  reloaded.event({ type: "history", items: pairHistory });
  reloaded.event(onlyB);
  assert.deepEqual(turnShape(reloaded.doc), turnShape(live.doc));
  assert.deepEqual(turnShape(live.doc).slice(0, 3), ["group:Delegated A", "hidden", "line:B finished"]);
  assert.deepEqual([...live.errors, ...reloaded.errors], []);
});

test("a chat switch clears the lines and their timers", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 1, "A");
  start(p.event, 1, "A");
  p.send({ type: "chat_switched", slotId: "s2", label: "x" });
  p.advance(3000);
  assert.equal(p.doc.querySelector(".agent-line"), null);
  assert.deepEqual(p.errors, []);
});

test("an unclaimed spawn names its delegation", () => {
  const p = panel({ capabilities: {} });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 0, "Count the lines in README.md");
  assert.equal(p.doc.querySelector(".tool-group-label").textContent, "Delegating Count the lines in README.md");
  p.event({ type: "tool_result", call_id: "call_0", name: "task", output: "Sub-task 'Count the lines in README.md' completed with no file changes.", is_error: false });
  assert.equal(p.doc.querySelector(".tool-group-label").textContent, "Delegated Count the lines in README.md");
  assert.equal(p.doc.querySelector(".tool .arg").textContent, "Count the lines in README.md");
  assert.equal(p.doc.querySelector(".agent-line"), null);
  assert.deepEqual(p.errors, []);
});

test("an agent page rebuilt from its step log never touches the live turn", async () => {
  const p = panel({ clock: false });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 1, "A");
  start(p.event, 1, "A");
  p.event({ type: "text_delta", text: "While it works, " });
  const turnBlock = p.doc.querySelector(".msg.dgc");
  const groups = turnBlock.querySelectorAll(".tool-group").length;
  const text = turnBlock.querySelector(".text");
  nameOf(p.doc, 1).click();
  for (let i = 0; i < 3; i += 1) {
    p.event({ type: "agent_step", agent_id: sid(1), seq_in_agent: i + 1,
      step: { type: "tool_call", name: "read_file", call_id: `${sid(1)}:r${i}`, args: { path: `f${i}.py` }, summary: `f${i}.py` } });
  }
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(p.$("agent-log").querySelectorAll(".tool").length, 3, "premise: the page drew the steps");
  assert.equal(turnBlock.querySelectorAll(".tool-group").length, groups, "the turn gained no group");
  p.event({ type: "text_delta", text: "I keep writing." });
  assert.equal(turnBlock.querySelector(".text"), text);
  assert.match(text.textContent, /While it works, I keep writing\./, "the streaming text block was not broken");
  assert.equal(p.$("agent-log").querySelector(".tool .dot.run"), null, "and no clock runs for a page copy");
  assert.deepEqual(p.errors, []);
});

test("an agent's page says what became of its changes", () => {
  const p = panel();
  p.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(p.event, 1, "A");
  start(p.event, 1, "A");
  nameOf(p.doc, 1).click();
  assert.match(p.$("agent-page-meta").textContent, /^Working for \d+s · isolated checkout$/);
  end(p.event, 1, "finished", { message: "Did the work." });
  assert.equal(p.$("agent-log").querySelector(".agent-page-outcome"), null, "nothing before the spawn's result");
  const held = "Sub-task 'A' completed but its changes were NOT integrated: conflict. Conflicts: a.py. The isolated "
    + "worktree is preserved at /wt/a on branch dgc/a.";
  p.event({ type: "tool_result", call_id: "call_1", name: "task", output: `${held}\nSummary:\nDid the work.`, is_error: false });
  const note = p.$("agent-log").firstElementChild;
  assert.ok(note.matches(".agent-page-outcome[data-held]"), "the outcome comes first, marked held");
  assert.equal(note.textContent, held);
  // A background spawn's result is not an outcome.
  const bg = panel();
  bg.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(bg.event, 1, "A");
  start(bg.event, 1, "A", { background: true });
  nameOf(bg.doc, 1).click();
  bg.event({ type: "tool_result", call_id: "call_1", name: "task", output: `Sub-task 'A' is running in the background (id ${sid(1)}). `, is_error: false });
  assert.equal(bg.$("agent-log").querySelector(".agent-page-outcome"), null);
  // An integrated one says so, not held.
  const ok = panel();
  ok.event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  spawn(ok.event, 1, "A");
  start(ok.event, 1, "A");
  end(ok.event, 1);
  ok.event({ type: "tool_result", call_id: "call_1", name: "task", output: "Sub-task 'A' completed and integrated 1 path(s): a.py.\nSummary:\nok", is_error: false });
  nameOf(ok.doc, 1).click();
  const integrated = ok.$("agent-log").querySelector(".agent-page-outcome");
  assert.equal(integrated.textContent, "Sub-task 'A' completed and integrated 1 path(s): a.py.");
  assert.equal(integrated.hasAttribute("data-held"), false);
  assert.deepEqual([...p.errors, ...bg.errors, ...ok.errors], []);
});

test("the stylesheet and the script carry the line, and nothing of the chip", () => {
  assert.doesNotMatch(mainCss, /agent-chip/);
  assert.doesNotMatch(mainJs, /agent-chip/);
  const agents = mainCss.slice(mainCss.indexOf("/* ---- 0.40 agents -"), mainCss.indexOf("/* ---- end 0.40 agents -"));
  const rule = (selector) => {
    const at = agents.indexOf(`${selector} {`);
    assert.ok(at >= 0, `${selector} is in the agents section`);
    return agents.slice(at, agents.indexOf("}", at));
  };
  const line = rule(".agent-line");
  assert.match(line, /color: var\(--muted\)/);
  assert.doesNotMatch(line, /--faint/, "--faint is 2.13:1 on the light themes");
  assert.match(line, /user-select: none/);
  assert.match(line, /margin: 0/);
  assert.match(rule(".agent-name:focus-visible, .agent-line-more:focus-visible"), /outline: 1px solid/);
  assert.match(rule(".agent-line-faces .agent-mark"), /width: 16px; height: 16px/);
  assert.doesNotMatch(mainCss, /\.agent-state[^{]*\{[^}]*--err-text/, "--err-text is about 3:1 on light themes");
  const forced = agents.slice(agents.indexOf("@media (forced-colors: active)"));
  assert.match(forced, /\.agent-name, \.agent-line-more \{ color: LinkText; text-decoration-color: LinkText; \}/);
  assert.match(forced, /\.agent-state\[data-state="waiting"\], \.agent-state\[data-state="failed"\] \{ color: CanvasText;/);
  // No ring around a face, and one breathing animation.
  assert.doesNotMatch(mainCss, /\.agent-mark[^{]*\{[^}]*(?:box-shadow|outline)/);
  assert.equal((mainCss.match(/animation: agent-mark-breathe/g) || []).length, 1);
});

// The panel hides three of the backend's notices and reads two of its result sentences. Pin the
// wording to the backend's own source, as tests/run_tests.py pins the loop-guard prefix: if either
// side changes alone, the notices would quietly come back or the page's outcome note would vanish.
test("the backend's spawn notices and outcome sentences are the ones the panel reads", () => {
  const agentPy = readFileSync(fileURLToPath(new URL("../../../dgc/agent.py", import.meta.url)), "utf8");
  for (const phrase of ["⟳ sub-task: ", "↳ isolated checkout: ", "isolated sub-tasks in parallel", "completed and integrated",
    "partly integrated", "completed but its changes were NOT integrated", "\\nSummary:\\n", "is running in the background"]) {
    assert.ok(agentPy.includes(phrase), `dgc/agent.py no longer says ${JSON.stringify(phrase)}`);
  }
  assert.match(agentPy, /f"↯ running \{len\(calls\)\} isolated sub-tasks in parallel \(max \{limit\}\)"/);
  assert.match(mainJs, /const AGENT_SPAWN_NOTICE = \/\^\(\?:⟳ sub-task: \|↳ isolated checkout: \|↯ running \\d\+ isolated sub-tasks in parallel\\b\)\//);
});
