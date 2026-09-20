// The transcript's activity icons: one thin outline set for everything that describes work.
//
// What this pins is the vocabulary, not the artwork: every tool DGC and its engines can emit
// resolves to a known mark, a group header wears the leading action of the sentence it prints,
// and no row is left showing one of the old text glyphs. The SVG itself is decoration — every
// assertion about what a row SAYS lives in the suites that already own that row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

// The old set, which must not survive anywhere a step is drawn.
const OLD_GLYPHS = /[→✎✱▸±$?＋⤢]/;

function panel() {
  const { doc, send, errors } = makeDom();
  const event = (data) => send({ type: "event", event: data });
  return { doc, event, errors };
}
const start = (event, id = "t1") => event({ type: "turn_start", turn_id: id, prompt: "go", kind: "prompt" });
const call = (event, name, callId, summary = "") =>
  event({ type: "tool_call", call_id: callId, name, args: {}, summary });
const result = (event, name, callId, output = "ok") =>
  event({ type: "tool_result", call_id: callId, name, is_error: false, is_diff: false, diff: "", output });

const cardIcon = (doc, callId) =>
  doc.querySelector(`.tool[data-call-id="${callId}"] .glyph svg`)?.dataset.icon;
const headerIcon = (doc) => [...doc.querySelectorAll(".tool-group > summary > .tg-icon")].at(-1)?.dataset.icon;
const headerLabel = (doc) => [...doc.querySelectorAll(".tool-group-label")].at(-1)?.textContent;

// Every tool name DGC, its CLI and the engines that speak for it can put in a transcript. A name
// that falls off this list shows the generic wrench, which is a real answer — but it should be a
// decision someone made, not a name nobody mapped.
const TOOL_ICONS = {
  read_file: "book-open", read: "book-open", Read: "book-open", "functions.read": "book-open",
  glob: "search", Glob: "search", grep: "search", search: "search", Grep: "search",
  repo_map: "folder-tree", code_intel: "braces", git_diff: "file-diff",
  write_file: "file-plus", write: "file-plus", Write: "file-plus", create_file: "file-plus",
  edit_file: "pencil", edit: "pencil", Edit: "pencil", apply_patch: "pencil",
  multi_edit: "pencil", MultiEdit: "pencil", NotebookEdit: "pencil",
  save_memory: "bookmark",
  bash: "square-terminal", shell: "square-terminal", Bash: "square-terminal",
  exec_command: "square-terminal", shell_command: "square-terminal", "functions.shell": "square-terminal",
  bash_output: "square-terminal", BashOutput: "square-terminal",
  bash_kill: "square-terminal", KillShell: "square-terminal",
  python: "code",
  web_search: "globe", WebSearch: "globe", web_fetch: "globe", WebFetch: "globe", browser: "globe",
  view_image: "image",
  present_plan: "clipboard-list", ExitPlanMode: "clipboard-list", present_document: "file-text",
  propose_options: "circle-help", task: "bot", Task: "bot",
  todo: "list-todo", TodoWrite: "list-todo",
  skill: "sparkle", Skill: "sparkle", add_skill: "sparkle",
  notes: "notebook-pen", monitor: "activity", monitor_stop: "activity",
  artifact: "app-window", update_goal: "target",
  // MCP, however the engine spells it.
  mcp__github__search_issues: "blocks", mcp: "blocks", "linear.create_issue": "blocks",
  // Nothing DGC has a better word for.
  screenshot: "wrench", some_new_tool: "wrench", tool: "wrench",
};

test("every tool name in the transcript resolves to a known icon", () => {
  const { doc, event, errors } = panel();
  start(event);
  const names = Object.keys(TOOL_ICONS);
  names.forEach((name, i) => call(event, name, `c${i}`));
  for (const [i, name] of names.entries()) {
    assert.equal(cardIcon(doc, `c${i}`), TOOL_ICONS[name], `icon for ${name}`);
  }
  // A dotted name DGC DOES know is its own tool, never an MCP guess.
  assert.equal(TOOL_ICONS["functions.read"], "book-open");
  assert.deepEqual(errors, []);
});

test("no tool card is left showing one of the old text glyphs", () => {
  const { doc, event, errors } = panel();
  start(event);
  Object.keys(TOOL_ICONS).forEach((name, i) => call(event, name, `c${i}`));
  for (const card of doc.querySelectorAll(".tool")) {
    const glyph = card.querySelector(".glyph");
    assert.equal(glyph.textContent, "", `${card.dataset.toolName} glyph has no text`);
    assert.equal(glyph.querySelector("svg").getAttribute("aria-hidden"), "true");
    assert.equal(glyph.querySelector("title"), null, "a decorative icon has no accessible name");
    assert.doesNotMatch(card.querySelector(".head").textContent, OLD_GLYPHS,
      `${card.dataset.toolName} head is free of the old glyphs`);
  }
  // The toggle's first four children are what lane-hooks pins; the icon lives inside .glyph.
  const first = doc.querySelector(".tool .tool-toggle");
  assert.deepEqual([...first.children].slice(0, 4).map((n) => n.className), ["chev", "glyph", "verb", "arg"]);
  assert.deepEqual(errors, []);
});

test("the group header wears the leading action of the sentence it prints", () => {
  // The three rows of the reference set, built from real events.
  const cases = [
    { steps: [["bash", "b1"]], icon: "square-terminal", label: "Ran 1 command" },
    { steps: [["read_file", "r1"], ["read_file", "r2"], ["bash", "b1"]], icon: "book-open",
      label: "Read 2 files and ran 1 command" },
    { steps: [["edit_file", "e1"], ["bash", "b1"], ["bash", "b2"]], icon: "pencil",
      label: "Edited 1 file and ran 2 commands" },
    // The lone-card refinement: five tools and nine CLI names live in the `other` bucket, whose
    // finished sentence can only say "Used 1 tool". A wrench on top of that told the reader
    // nothing at all — which is the founder's complaint, exactly.
    { steps: [["todo", "t1"]], icon: "list-todo", label: "Used 1 tool" },
    { steps: [["skill", "s1"]], icon: "sparkle", label: "Used 1 tool" },
    { steps: [["bash_output", "o1"]], icon: "square-terminal", label: "Used 1 tool" },
    { steps: [["code_intel", "i1"]], icon: "braces", label: "Mapped the project" },
    // A genuinely mixed bag of names DGC has no word for keeps the generic mark.
    { steps: [["some_new_tool", "x1"], ["another_tool", "x2"]], icon: "wrench", label: "Used 2 tools" },
  ];
  for (const [n, { steps, icon, label }] of cases.entries()) {
    const { doc, event, errors } = panel();
    start(event, `t${n}`);
    for (const [name, id] of steps) call(event, name, id);
    for (const [name, id] of steps) result(event, name, id);
    event({ type: "turn_end", turn_id: `t${n}`, reason: "completed", final_message_id: null });
    assert.equal(headerIcon(doc), icon, `${label}: icon`);
    assert.equal(headerLabel(doc), label, `${label}: the words are unchanged`);
    assert.deepEqual(errors, []);
  }
});

test("the header icon follows the work from running to finished, and adds no text", () => {
  const { doc, event, errors } = panel();
  start(event);
  call(event, "read_file", "r1", "src/a.ts");
  const summary = doc.querySelector(".tool-group > summary");
  assert.equal(summary.textContent, "Reading a file");
  assert.equal(headerIcon(doc), "book-open");
  // Two reads finished and a command now running: the header tracks what is happening NOW.
  result(event, "read_file", "r1");
  call(event, "bash", "b1", "npm test");
  assert.equal(summary.textContent, "Running a command", "the icon adds no text to the summary");
  assert.equal(headerIcon(doc), "square-terminal");
  assert.ok(doc.querySelector(".tool-group").classList.contains("running"));
  result(event, "bash", "b1");
  event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: null });
  // Finished, the first phrase wins again.
  assert.equal(summary.textContent, "Read 1 file and ran 1 command");
  assert.equal(headerIcon(doc), "book-open");
  assert.deepEqual(errors, []);
});

test("a group whose every step was refused keeps the refused work's own mark", () => {
  const { doc, event, errors } = panel();
  start(event);
  call(event, "bash", "b1", "rm -rf dist");
  event({ type: "tool_denied", call_id: "b1", name: "bash", args: { command: "rm -rf dist" },
          reason: "The user denied this command." });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: null });
  assert.equal(headerLabel(doc), "No tools ran · 1 issue");
  assert.equal(headerIcon(doc), "square-terminal", "a refused command is still a command");
  assert.equal(doc.querySelector('.tool[data-status="denied"] .glyph svg').dataset.icon, "square-terminal",
    "the step still describes the kind of work that was refused");
  assert.deepEqual(errors, []);
});

test("repainting a running group never rebuilds its icon, so the pulse cannot restart", () => {
  const { doc, event, errors } = panel();
  start(event);
  call(event, "bash", "b1", "npm test");
  const wrap = doc.querySelector(".tool-group > summary > .tg-icon");
  const svg = wrap.firstElementChild;
  // Several more events in the same leading bucket: the label is rewritten, the icon is not.
  call(event, "bash", "b2", "npm run lint");
  result(event, "bash", "b1");
  call(event, "bash", "b3", "npm run build");
  assert.equal(doc.querySelector(".tool-group > summary > .tg-icon"), wrap, "the wrapper is stable");
  assert.equal(wrap.firstElementChild, svg, "the SVG inside it was not replaced");
  assert.equal(headerLabel(doc), "Running 2 commands");
  // A new leading bucket does swap the child, but never the animated wrapper.
  call(event, "edit_file", "e1", "src/a.ts");
  result(event, "bash", "b2"); result(event, "bash", "b3");
  assert.equal(doc.querySelector(".tool-group > summary > .tg-icon"), wrap);
  assert.equal(headerIcon(doc), "pencil");
  assert.notEqual(wrap.firstElementChild, svg);
  assert.deepEqual(errors, []);
});

test("a question's card carries one mark from the moment it is created", () => {
  // It used to show the generic fallback until the ask arrived, then have a "?" written over it.
  const { doc, event, errors } = panel();
  start(event);
  call(event, "propose_options", "q1", "2 questions · Storage, Extras");
  assert.equal(cardIcon(doc, "q1"), "circle-help", "asking");
  const questions = [{ id: "q1", question: "Where?", options: [{ label: "Disk" }, { label: "Memory" }] }];
  event({ type: "options_request", id: "r1", call_id: "q1", questions });
  assert.equal(cardIcon(doc, "q1"), "circle-help", "docked");
  event({ type: "options_resolved", id: "r1", call_id: "q1", outcome: "answered", questions,
          answers: { q1: { selected: [0], other: "" } } });
  result(event, "propose_options", "q1", "The user answered your question.");
  assert.equal(cardIcon(doc, "q1"), "circle-help", "answered");
  assert.equal(doc.querySelector('.tool[data-call-id="q1"] .glyph').textContent, "");
  assert.deepEqual(errors, []);
});

test("the notices that carry a mark carry the right one", () => {
  const { doc, event, errors } = panel();
  // An MCP server asking for structured input drew an empty slot: codicon-form does not exist in
  // the bundled font.
  start(event);
  event({ type: "mcp_input_request", id: "e1", server: "jira", kind: "elicitation",
          payload: { message: "Which project should the ticket go to?",
            requestedSchema: { type: "object", required: ["project"],
              properties: { project: { type: "string", title: "Project" } } } } });
  const form = [...doc.querySelectorAll(".card .q")].at(-1);
  assert.equal(form.querySelector("svg")?.dataset.icon, "square-pen");
  assert.match(form.textContent, /Information requested by jira/);
  // A rule the user just granted ties back to the shield on the card that created it.
  event({ type: "rule_added", rule: "bash(npm test)" });
  const rule = [...doc.querySelectorAll(".sys")].at(-1);
  assert.equal(rule.querySelector("svg").dataset.icon, "shield-plus");
  assert.equal(rule.textContent, "rule: bash(npm test)");
  assert.doesNotMatch(rule.textContent, OLD_GLYPHS);
  // Older conversation, summarised.
  event({ type: "compacted", before_tokens: 60000, after_tokens: 20000, context_size: 128000,
          strategy: "mechanical", status: "compacted" });
  assert.equal([...doc.querySelectorAll(".sys")].at(-1).querySelector("svg").dataset.icon, "history");
  assert.deepEqual(errors, []);
});

test("the backend going away is the one place a broken plug is literally right", () => {
  const { doc, send, errors } = makeDom();
  send({ type: "backend_exit", code: null, signal: "SIGKILL", recovering: true, resumes: "offer" });
  const line = [...doc.querySelectorAll(".sys.err")].at(-1);
  assert.equal(line.querySelector("svg").dataset.icon, "unplug");
  assert.match(line.textContent, /dgc backend stopped \(killed by SIGKILL\)/);
  assert.equal(line.getAttribute("role"), "alert");
  assert.deepEqual(errors, []);
});

test("the icon set is stroke-only, sized by token, and pulses only where a group is running", () => {
  // currentColor + fill none is what makes one rule per role enough, and what carries the set
  // through forced colors without a declaration of its own.
  const { doc, event } = panel();
  start(event);
  call(event, "bash", "b1", "npm test");
  const svg = doc.querySelector(".tool .glyph svg");
  assert.equal(svg.getAttribute("fill"), "none");
  assert.equal(svg.getAttribute("stroke"), "currentColor");
  assert.equal(svg.getAttribute("viewBox"), "0 0 24 24", "Lucide's own grid, so the geometry is verbatim");
  assert.equal(svg.getAttribute("stroke-linecap"), "round");
  assert.equal(svg.getAttribute("focusable"), "false");
  assert.equal(svg.getAttribute("width"), null, "the box is a CSS token, not a hard-coded attribute");
  assert.match(mainCss, /--icon:\s*14px/);
  assert.match(mainCss, /\.ic\s*\{[^}]*width:\s*var\(--icon\)/);
  // A hairline that dips to .3 does not pulse, it disappears — and this is the one row a reader
  // most needs to find.
  assert.match(mainCss, /@keyframes icon-pulse \{ 0%,100% \{ opacity: 1; \} 50% \{ opacity: \.55; \} \}/);
  assert.match(mainCss, /\.tool-group\.running > summary > \.tg-icon \{[^}]*animation: icon-pulse/);
  assert.match(mainCss,
    /@media \(prefers-reduced-motion: reduce\) \{ \.tool-group\.running > summary > \.tg-icon \{ animation: none; \} \}/);
  // Refused work recedes by token, never by opacity: opacity survives forced colors, where the
  // user asked for maximum contrast.
  assert.match(mainCss, /\.tool\[data-status="denied"\] \.glyph,/);
  assert.match(mainCss, /\.tool\[data-status="stopped"\] \.glyph \{ color: var\(--faint\); \}/);
});
