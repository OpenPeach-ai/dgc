// Sub-agent lines in the parent turn, an inner agent page, and child tools hidden from the
// parent transcript (they replay on the inner page, filtered by call-id prefix).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

function view(options = {}) {
  const v = makeDom(options);
  const event = (data) => v.send({ type: "event", event: data });
  const $ = (id) => v.doc.getElementById(id);
  return { ...v, event, $ };
}

const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
// What a line reads on screen: the sr-only pauses between its clauses are for screen readers.
const shown = (node) => {
  const copy = node.cloneNode(true);
  copy.querySelectorAll(".sr-only").forEach((n) => n.remove());
  return copy.querySelector(".agent-line-text").textContent;
};

test("the parent turn shows one line for its agents, not the child's greps", () => {
  const { doc, event, advance, errors } = view({ clock: true });
  event({ type: "turn_start", turn_id: "t1", prompt: "split the work" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "map auth" }, summary: "map auth" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0",
    description: "map auth", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false });
  event({ type: "tool_call", call_id: `${sid(1)}:g1`, name: "grep", args: { pattern: "login" }, summary: "login" });
  event({ type: "tool_call", call_id: "call_1", name: "task", args: { description: "Safari logo fix" }, summary: "Safari logo fix" });
  event({ type: "agent_started", id: sid(2), parent_id: null, call_id: "call_1",
    description: "Safari logo fix", depth: 1, state: "running", started_at: 2, isolated: true, parallel: true });
  event({ type: "agent_ended", id: sid(2), state: "finished", duration_ms: 462000, tool_calls: 6,
    message: "Logo is aligned.\nFILES: app/logo.svg, app/hero.css" });
  advance(2000);

  // The child's hidden grep between the two spawns is not the parent's output: one batch, one line.
  const lines = [...doc.querySelectorAll(".agent-line")];
  assert.equal(lines.length, 1);
  assert.equal(shown(lines[0]), "map auth running · Safari logo fix finished");
  const marks = [...lines[0].querySelectorAll(".agent-line-faces .agent-mark")];
  assert.deepEqual(marks.map((m) => m.dataset.agentId), [sid(1), sid(2)]);
  assert.ok(marks[0].classList.contains("is-live"));
  assert.ok(!marks[1].classList.contains("is-live"));

  const grep = doc.querySelector('.tool[data-tool-name="grep"]');
  assert.ok(grep.classList.contains("agent-owned"));
  assert.equal(grep.dataset.agentId, sid(1));
  const visibleTools = [...doc.querySelectorAll("#log .tool")].filter((n) => !n.classList.contains("agent-owned"));
  assert.equal(visibleTools.length, 0, "parent task cards are claimed and owned; the line is the spawn");
  assert.deepEqual(errors, []);
});

test("agent-mark CSS does not clip or bloom the SVG face", () => {
  assert.match(mainCss, /\.agent-mark:has\(img\)[\s\S]{0,120}clip-path:\s*none/);
  assert.match(mainCss, /\.agent-mark:not\(:has\(img\)\)\[data-mark="0"\]/);
  assert.match(mainCss, /\.agent-mark:not\(:has\(img\)\)\[data-mark="3"\]/);
  assert.equal(
    (mainCss.match(/\.agent-mark\[data-mark="0"\]\s*\{[^}]*clip-path/g) || []).length, 0,
    "clip-path on [data-mark] must not win over the SVG img",
  );
  // No ring around the face while an agent works: no pseudo-element, box-shadow or outline.
  assert.doesNotMatch(mainCss, /\.agent-mark[^{]*::(?:after|before)/);
  assert.doesNotMatch(mainCss, /\.agent-mark[^{]*\{[^}]*(?:box-shadow|outline)/);
});

test("a live line and its inner page share the still identity face", () => {
  const { $, doc, event } = view();
  doc.body.dataset.agentMarks = "vscode-file://agents";
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "agent_started", id: sid(4), parent_id: null, call_id: "call_0",
    description: "Invoice workflow cards UI", depth: 1, state: "running", started_at: 1,
    isolated: true, parallel: false });
  const lineMark = doc.querySelector(".agent-line .agent-line-faces .agent-mark");
  const lineImg = lineMark.querySelector("img");
  assert.ok(lineMark.classList.contains("is-live"));
  assert.ok(lineImg, "the line paints the SVG face");
  assert.match(lineImg.getAttribute("src"), /agent-0[1-8]-[a-z]+\.svg$/);
  assert.ok(!lineImg.getAttribute("src").includes("-animated"),
    "live agents keep the still face; motion is CSS");
  doc.querySelector(`.agent-name[data-agent-id="${sid(4)}"]`).click();
  const pageMark = $("agent-mark");
  const pageImg = pageMark.querySelector("img");
  assert.equal(pageMark.hidden, false);
  assert.equal(pageMark.dataset.face, lineMark.dataset.face);
  assert.equal(pageImg.getAttribute("src"), lineImg.getAttribute("src"));
});

test("the same agent id keeps the same identity mark after a second paint", () => {
  const { doc, event } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "agent_started", id: sid(4), parent_id: null, call_id: "call_0",
    description: "one", depth: 1, state: "running", started_at: 1, isolated: false, parallel: false });
  const mark = () => doc.querySelector(`.agent-line .agent-mark[data-agent-id="${sid(4)}"]`);
  const first = mark().dataset.mark;
  event({ type: "agent_updated", id: sid(4), state: "running", activity: "reading" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "one" } });
  event({ type: "agent_ended", id: sid(4), state: "finished", duration_ms: 900, tool_calls: 1 });
  assert.equal(mark().dataset.mark, first);
  assert.ok(["seafoam", "lagoon", "coral", "violet", "amber", "slate", "lime", "rose"]
    .includes(mark().dataset.face));
});

test("clicking an agent's name opens the inner page with the child's tools, duration and FILES", () => {
  const { $, doc, event, posted, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "fix the logo" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "Safari logo fix" }, summary: "Safari logo fix" });
  event({ type: "agent_started", id: sid(2), parent_id: null, call_id: "call_0",
    description: "Safari logo fix", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false });
  event({ type: "tool_call", call_id: `${sid(2)}:e1`, name: "edit_file", args: { path: "app/logo.svg" }, summary: "app/logo.svg" });
  event({ type: "agent_ended", id: sid(2), state: "finished", duration_ms: 462000, tool_calls: 3,
    message: "Aligned the mark.\nFILES: app/logo.svg, app/hero.css" });

  doc.querySelector(`.agent-name[data-agent-id="${sid(2)}"]`).click();
  assert.equal(doc.body.dataset.agentPage, sid(2));
  assert.equal($("agent-page").hidden, false);
  assert.equal($("agent-back").hidden, false);
  assert.equal($("thread-title").textContent, "Safari logo fix");
  assert.match($("agent-page-meta").textContent, /Worked for 7m 42s/);
  assert.match($("agent-log").textContent, /Aligned the mark/);
  assert.ok($("agent-log").querySelector('.tool[data-tool-name="edit_file"]'));
  assert.equal($("agent-log").querySelector('.tool[data-tool-name="task"]'), null, "the parent spawn card stays off the inner page");
  const files = [...$("agent-log").querySelectorAll(".agent-file")].map((n) => n.textContent);
  assert.deepEqual(files, ["app/logo.svg", "app/hero.css"]);
  assert.equal($("agent-log").querySelector(".agent-change-title").textContent, "Files to open",
    "the handoff does not say which files were edited");
  $("agent-log").querySelector(".agent-file").click();
  assert.equal(posted.at(-1).type, "openFile");
  assert.equal(posted.at(-1).path, "app/logo.svg");

  $("agent-back").click();
  assert.equal($("agent-page").hidden, true);
  assert.ok(!doc.body.dataset.agentPage);
  assert.deepEqual(errors, []);
});

test("child tools after turn_end do not open a Working row on the parent", () => {
  const { $, doc, event, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0",
    description: "map auth", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false,
    background: true });
  event({ type: "text_delta", text: "Running in the background." });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  event({ type: "tool_call", call_id: `${sid(1)}:g1`, name: "grep", args: { pattern: "login" }, summary: "login" });
  assert.equal(doc.querySelectorAll(".msg.dgc").length, 1, "no second Working turn");
  assert.equal([...doc.querySelectorAll(".msg.dgc .act, .turn-meta")].some((n) => /Working/i.test(n.textContent)), false);
  assert.ok(doc.querySelector('.tool[data-tool-name="grep"]')?.classList.contains("agent-owned"));
  assert.equal($("agents-picker").hidden, false);
  assert.deepEqual(errors, []);
});

test("a background agent keeps the pill after the parent turn ends", () => {
  const { $, doc, event, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "go" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0",
    description: "map auth", depth: 1, state: "running", started_at: 1, isolated: true, parallel: false,
    background: true });
  assert.equal($("agents-picker").hidden, false);
  event({ type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0 });
  assert.equal($("agents-picker").hidden, false, "detached children outlive the turn");
  const line = doc.querySelector(".agent-line");
  assert.match(shown(line), /^map auth (started working|running)$/, "the line outlives the turn too");
  event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 1200, tool_calls: 2,
    message: "done" });
  event({ type: "turn_start", turn_id: "t2", prompt: "map auth", kind: "wake" });
  assert.match(doc.querySelector(".resume-note").textContent, /Woke on agent/);
  assert.deepEqual(errors, []);
});

test("restored agents without a spawn card do not dump lines under the last answer", () => {
  const { doc, event, errors } = view();
  event({ type: "history", items: [
    { role: "compaction", text: "Earlier work spawned sub-agents." },
    { type: "turn_start", turn_id: "h1", prompt: "show the screenshots", kind: "prompt" },
    { type: "text_delta", text: "Here they are." },
    { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" },
  ] });
  event({ type: "agents", items: [{
    id: sid(1), parent_id: null, call_id: "call_old", description: "3.5 Semantic search via Ollama",
    depth: 1, state: "finished", tool_calls: 4, isolated: true, parallel: false, restored: true,
    message: "Indexed the notes.",
  }], total: 1, active: 0 });
  assert.equal(doc.querySelectorAll(".agent-line").length, 0);
  assert.deepEqual(errors, []);
});

test("restored spawn cards after the summary put their line there, and the inner page uses the saved log", () => {
  const { $, doc, event, errors } = view();
  event({ type: "history", items: [
    { role: "compaction", text: "Earlier work spawned sub-agents." },
    { type: "tool_call", call_id: "call_old", name: "task", args: { description: "3.5 Semantic search via Ollama" },
      summary: "3.5 Semantic search via Ollama" },
    { type: "tool_result", call_id: "call_old", name: "task", output: "Indexed the notes.\nFILES: search.py",
      is_error: false, is_diff: false },
    { type: "turn_start", turn_id: "h1", prompt: "show the screenshots", kind: "prompt" },
    { type: "text_delta", text: "Here they are." },
    { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_end", turn_id: "h1", reason: "completed", token_estimate: 0, final_message_id: "h1:1" },
  ] });
  event({ type: "agents", items: [{
    id: sid(1), parent_id: null, call_id: "call_old", description: "3.5 Semantic search via Ollama",
    depth: 1, state: "finished", tool_calls: 4, isolated: true, parallel: false, restored: true,
    message: "Indexed the notes.\nFILES: search.py",
    log: [
      { type: "tool_call", call_id: `${sid(1)}:g1`, name: "grep", summary: "semantic", args: {} },
      { type: "tool_result", call_id: `${sid(1)}:g1`, name: "grep", output: "search.py:12", is_error: false },
    ],
  }], total: 1, active: 0 });
  const lines = [...doc.querySelectorAll(".agent-line")];
  assert.equal(lines.length, 1);
  assert.equal(shown(lines[0]), "3.5 Semantic search via Ollama finished");
  const compaction = doc.querySelector(".compaction");
  const answer = [...doc.querySelectorAll(".text")].find((n) => n.textContent.includes("Here they are"));
  assert.ok(compaction);
  assert.ok(answer);
  const following = compaction.ownerDocument.defaultView.Node.DOCUMENT_POSITION_FOLLOWING;
  assert.equal(Boolean(compaction.compareDocumentPosition(lines[0]) & following), true,
    "the line sits after the summary marker");
  assert.equal(Boolean(lines[0].compareDocumentPosition(answer) & following), true,
    "the line sits above the last answer");
  lines[0].querySelector(".agent-name").click();
  assert.match($("agent-log").textContent, /Indexed the notes/);
  assert.ok($("agent-log").querySelector('.tool[data-tool-name="grep"]'));
  assert.deepEqual(errors, []);
});

test("the agent page keeps a FILES note apart from its path and names a folder without a link", () => {
  const { $, doc, event, posted, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "triage" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "triage" }, summary: "triage" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0", description: "triage",
    agent_type: "critic", depth: 1, state: "running", started_at: 1, isolated: false, parallel: false });
  event({ type: "agent_ended", id: sid(1), state: "finished", duration_ms: 1000, tool_calls: 2,
    message: "Triaged.\nFILES: `reports/auth.log`, frontend/test-results/ (40 × error-context.md), a.ts (the flaky one)" });
  doc.querySelector(`.agent-name[data-agent-id="${sid(1)}"]`).click();
  const rows = [...$("agent-log").querySelectorAll(".agent-file-row")];
  assert.deepEqual(rows.map((row) => [row.querySelector(".agent-file, .agent-folder").textContent,
    row.querySelector(".agent-file-note")?.textContent || ""]), [
    ["reports/auth.log", ""], ["frontend/test-results/", "(40 × error-context.md)"], ["a.ts", "(the flaky one)"]]);
  assert.equal(rows[1].querySelector(".agent-file"), null, "a folder is not offered as a file to open");
  rows[2].querySelector(".agent-file").click();
  assert.equal(posted.at(-1).path, "a.ts");
  assert.match(mainCss, /\.agent-file, \.agent-folder \{[^}]*text-align: left/);
  assert.deepEqual(errors, []);
});

// A background sub-task's step can still be running when the parent's turn ends. The turn end
// stopped every running card, and the late result then made a second card with no command.
test("a background child's step outlives the turn that started it: one card, its command, its result", () => {
  const { doc, event, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "count in the background" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "count" }, summary: "count" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0", description: "count",
    depth: 1, state: "running", started_at: 1, isolated: true, parallel: false, background: true });
  event({ type: "tool_call", call_id: `${sid(1)}:c1`, name: "bash",
    args: { command: "sleep 20; wc -l README.md" }, summary: "sleep 20; wc -l README.md" });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: null });
  const cards = () => [...doc.querySelectorAll(`.tool[data-call-id="${sid(1)}:c1"]`)];
  assert.equal(cards().length, 1);
  assert.equal(cards()[0].dataset.status, "running", "the parent's turn end stopped a step still running");
  event({ type: "tool_progress", call_id: `${sid(1)}:c1`, name: "bash", message: "halfway there" });
  assert.match(cards()[0].textContent, /halfway there/, "progress after the turn was dropped");
  event({ type: "tool_result", call_id: `${sid(1)}:c1`, name: "bash",
    output: "exit code: 0\n3 README.md", is_error: false, is_diff: false });
  assert.equal(cards().length, 1, "the result made a second card");
  assert.equal(cards()[0].dataset.status, "completed");
  assert.match(cards()[0].querySelector(".arg").textContent, /sleep 20; wc -l README\.md/);
  assert.deepEqual(errors, []);
});

test("a step of a child the turn was waiting on still stops with the turn", () => {
  const { doc, event, errors } = view();
  event({ type: "turn_start", turn_id: "t1", prompt: "count" });
  event({ type: "tool_call", call_id: "call_0", name: "task", args: { description: "count" }, summary: "count" });
  event({ type: "agent_started", id: sid(1), parent_id: null, call_id: "call_0", description: "count",
    depth: 1, state: "running", started_at: 1, isolated: true, parallel: false });
  event({ type: "tool_call", call_id: `${sid(1)}:c1`, name: "bash", args: { command: "make" }, summary: "make" });
  event({ type: "turn_end", turn_id: "t1", reason: "cancelled", final_message_id: null });
  assert.equal(doc.querySelector(`.tool[data-call-id="${sid(1)}:c1"]`).dataset.status, "stopped");
  assert.deepEqual(errors, []);
});
