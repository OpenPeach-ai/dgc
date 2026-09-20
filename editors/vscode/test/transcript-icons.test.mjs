// The transcript's activity icons: one thin outline set for everything that describes work.
//
// What this pins is the vocabulary, not the artwork: every tool DGC and its engines can emit
// resolves to a known mark, a group header wears the leading action of the sentence it prints,
// and no row is left showing one of the old text glyphs. The SVG itself is decoration — every
// assertion about what a row SAYS lives in the suites that already own that row.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  // "functions.read" is dotted, and DGC has a mapping for it: the MCP regex must never shadow one.
  read_file: "book-open", read: "book-open", Read: "book-open", "functions.read": "book-open",
  glob: "search", Glob: "search", grep: "search", search: "search", Grep: "search",
  repo_map: "folder-tree", code_intel: "braces", git_diff: "file-diff",
  write_file: "file-plus", write: "file-plus", Write: "file-plus", create_file: "file-plus",
  WriteFile: "file-plus",
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
  propose_options: "circle-help", AskUserQuestion: "circle-help", task: "bot", Task: "bot",
  todo: "list-todo", TodoWrite: "list-todo",
  skill: "sparkle", Skill: "sparkle", add_skill: "sparkle",
  notes: "notebook-pen", monitor: "activity", monitor_stop: "activity",
  artifact: "app-window", update_goal: "target",
  // MCP, however the engine spells it — including DGC's own broker tools (dgc/agent.py), which
  // are the same route by another name and used to land on the wrench.
  mcp__github__search_issues: "blocks", mcp: "blocks", "linear.create_issue": "blocks",
  mcp_call: "blocks", mcp_search: "blocks",
  // A server the user named after a domain. DGC's own server-name field allows dots
  // ([A-Za-z0-9][A-Za-z0-9_.-]{0,63}), so one dot was never the bound the regex needed.
  "sentry.io.list_issues": "blocks", "api.github.com.search": "blocks",
  // Nothing DGC has a better word for.
  screenshot: "wrench", some_new_tool: "wrench", tool: "wrench", SlashCommand: "wrench",
};

test("every tool name in the transcript resolves to a known icon", () => {
  const { doc, event, errors } = panel();
  start(event);
  const names = Object.keys(TOOL_ICONS);
  names.forEach((name, i) => call(event, name, `c${i}`));
  for (const [i, name] of names.entries()) {
    assert.equal(cardIcon(doc, `c${i}`), TOOL_ICONS[name], `icon for ${name}`);
  }
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

test("the backend going away is marked, and by a shape that survives 14px", () => {
  const { doc, send, errors } = makeDom();
  send({ type: "backend_exit", code: null, signal: "SIGKILL", recovering: true, resumes: "offer" });
  const line = [...doc.querySelectorAll(".sys.err")].at(-1);
  // Not `unplug`: six sub-paths, five of them short diagonals, which at 14px reads as a scribble
  // rather than an object — on one of the most important rows the panel ever draws.
  assert.equal(line.querySelector("svg").dataset.icon, "triangle-alert");
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
  // The solid 6px dot keeps the deep pulse — and keeps it out of a reduced-motion session. The
  // shared block near the top of the file names the same selector at the same specificity but
  // earlier, so only a rule after the animation actually switches it off.
  assert.match(mainCss, /@media \(prefers-reduced-motion: reduce\) \{ \.tool \.dot\.run \{ animation: none; \} \}/);
});

test("no transcript icon is painted in a translucent token", () => {
  // --faint is --vscode-disabledForeground, which both default themes ship at 50% alpha. An SVG
  // composites each <path> of a mark separately, so two crossing strokes paint their crossing
  // twice and the icon reads as two different greys — something a codicon FONT never did.
  for (const rule of mainCss.split("}")) {
    if (!/\.(ic|glyph|note-icon|tg-icon|dg)\b/.test(rule.split("{")[0] || "")) continue;
    assert.doesNotMatch(rule, /color:\s*var\(--faint\)/,
      `a transcript icon must not take --faint: ${rule.split("{")[0].trim()}`);
  }
  assert.match(mainCss, /\.sys-marked > \.ic \{[^}]*color: var\(--muted\)/);
  assert.match(mainCss, /\.resume-note \.note-icon, \.recovery-card \.note-icon \{[^}]*color: var\(--muted\)/);
  assert.match(mainCss, /\.compaction > summary > \.ic \{[^}]*color: var\(--muted\)/);
  // Every step's mark is the same grey, whatever became of the step.
  assert.doesNotMatch(mainCss, /\.tool\[data-status="denied"\] \.glyph/);
});

test("a step the header has a word for does not call itself \"Used tool\"", () => {
  // Giving these three a mark exposed the other half of the same gap: the card said "Used tool
  // multi edit" under a header that said "Edited 1 file". The icon and the words come from the
  // same reading of the step, so they have to agree.
  const rows = [["MultiEdit", "m1", /^Edited\b/], ["create_file", "c1", /^Created\b/],
    ["code_intel", "i1", /^Read code structure\b/]];
  for (const [n, [name, id, verb]] of rows.entries()) {
    const { doc, event, errors } = panel();
    start(event, `t${n}`);
    call(event, name, id);
    result(event, name, id);
    event({ type: "turn_end", turn_id: `t${n}`, reason: "completed", final_message_id: null });
    const text = doc.querySelector(`.tool[data-call-id="${id}"] .verb`).textContent;
    assert.match(text, verb, `${name} verb`);
    assert.doesNotMatch(text, /Used tool/, `${name} has a word of its own`);
    assert.deepEqual(errors, []);
  }
});

test("every icon name the panel asks for is one the panel actually has", () => {
  // icon() resolves the key before it writes data-icon, so a typo can no longer paint the wrench
  // while claiming to be a book — but it would still ship a wrench. This catches it a step
  // earlier, at the name, and covers the ~30 literal call sites the two tables do not.
  const main = readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
  const section = (start) => main.split(start)[1].split("\n  };")[0];
  const have = new Set([...section("const ICON_PATHS = {").matchAll(/^\s*"([a-z0-9-]+)":/gm)].map((m) => m[1]));
  const asked = new Map();
  const want = (name, where) => { if (!asked.has(name)) asked.set(name, where); };
  for (const m of main.matchAll(/\bicon\("([a-z0-9-]+)"/g)) want(m[1], "an icon() call");
  for (const m of main.matchAll(/\bsetIcon\([^,)]*,\s*"([a-z0-9-]+)"/g)) want(m[1], "a setIcon() call");
  for (const m of main.matchAll(/\bdata-icon="([a-z0-9-]+)"/g)) want(m[1], "a wrapper's data-icon");
  for (const table of ["const TOOL_ICON = {", "const BUCKET_ICON = {"]) {
    for (const m of section(table).matchAll(/:\s*"([a-z0-9-]+)"/g)) want(m[1], table.split(" ")[1]);
  }
  for (const m of section("const IMAGE_FAILURES = {").matchAll(/\[\s*"([a-z0-9-]+)"/g)) want(m[1], "IMAGE_FAILURES");
  assert.ok(asked.size > 30, `the scan found the call sites (${asked.size})`);
  for (const [name, where] of asked) assert.ok(have.has(name), `${where} asks for "${name}", which ICON_PATHS has not got`);
});

test("the licence notice lists exactly the icons that ship", () => {
  // The notice is the licence record for embedded artwork, so it has to name what is actually in
  // the file — not what was in it when the set was drawn up.
  const main = readFileSync(new URL("../media/main.js", import.meta.url), "utf8");
  const block = main.split("const ICON_PATHS = {")[1].split("\n  };")[0];
  const embedded = [...block.matchAll(/^\s*"([a-z0-9-]+)":/gm)].map((m) => m[1]).sort();
  const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES.md", import.meta.url), "utf8");
  const line = notices.split("\n").find((l) => l.startsWith("- The icons used are:"));
  const listed = [...line.matchAll(/`([a-z0-9-]+)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, embedded);
  assert.match(notices, new RegExp(`are ${embedded.length} \\[Lucide\\]`));
  assert.match(notices, /licenses\/LUCIDE-LICENSES\.txt/);
});
