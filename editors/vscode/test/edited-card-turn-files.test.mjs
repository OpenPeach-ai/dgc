// The Edited card lists exactly the files the turn's recovery point will restore (the founder, 25 Oct: "this should
// go into 0.48"). The 0.48 marketing take 5: a worker fixed billing.py in its own checkout with a shell command, DGC
// integrated it, then wrote test_billing.py with its edit tools. The card said "Edited 1 file · test_billing.py"
// while Undo restored both, because the panel counted only its own edit tools' diffs.
//
// A CLI with ready.capabilities.turn_files now counts the card itself and sends `turn_files` before `turn_end`; the
// panel draws exactly that, Undo's question names the same number, and a reopened chat replays the same card. An older
// CLI (no capability) keeps today's edit-tool counting.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", capabilities: { history_snapshot: true, turn_files: 1 }, model: "m", mode: "auto",
  think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
  goal: { text: "", status: "none" }, context_size: 1 };
const OLD_READY = { ...READY, capabilities: { history_snapshot: true } };
const diffFor = (path, add = 1, del = 1) => `--- a/${path}\n+++ b/${path}\n@@ -1,${del} +1,${add} @@\n`
  + "-old\n".repeat(del) + "+new\n".repeat(add);
const row = (path, additions, deletions, status = "modified", counted = true) =>
  ({ path, additions, deletions, counted, status });
const TAKE5 = { files: [row("billing.py", 2, 0), row("test_billing.py", 64, 2)], total: 2,
  checkpoint_index: 0, checkpoint_preview: "fix the billing rounding" };

// Take 5, as the panel saw it: a helper's task result (no diff) and DGC's own write_file diff of test_billing.py.
function take5(v, { files = TAKE5, id = "t1" } = {}) {
  const event = (d) => v.send({ type: "event", event: d });
  event({ type: "turn_start", turn_id: id, prompt: "fix the billing rounding", kind: "prompt" });
  event({ type: "tool_call", call_id: "p1", name: "task", args: { description: "fix billing", prompt: "fix it" } });
  event({ type: "tool_result", call_id: "p1", name: "task", is_error: false, is_diff: false,
          output: "Sub-task 'fix billing' completed and integrated 1 path(s): billing.py.\nSummary:\nFixed." });
  event({ type: "tool_call", call_id: "p2", name: "edit_file", args: { path: "test_billing.py" } });
  const diff = diffFor("test_billing.py", 64, 2);
  event({ type: "tool_result", call_id: "p2", name: "edit_file", output: diff, is_diff: true, diff });
  event({ type: "text_delta", text: "Fixed the rounding and added tests." });
  event({ type: "stream_end", message_id: `${id}:1`, phase: "answer" });
  if (files) event({ type: "turn_files", turn_id: id, ...files });
  event({ type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` });
}
function panel(ready = READY) {
  const v = makeDom();
  v.send({ type: "event", event: ready });
  return v;
}
const cardRows = (card) => [...card.querySelectorAll(".ts-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim());

test("take 5: the file a helper changed with a shell command is on the card, with the CLI's true counts", () => {
  const v = panel();
  assert.ok(v.posted.some((m) => m.type === "turnFilesWatch"), "the panel asks for the CLI's card");
  take5(v);
  const card = v.doc.querySelector(".turn-summary");
  assert.equal(card.querySelector(".ts-title").textContent, "Edited 2 files");
  assert.deepEqual(cardRows(card), ["billing.py+2−0", "test_billing.py+64−2"]);
  assert.equal(card.querySelector(".ts-head .change-add").textContent, "+66");
  assert.equal(card.querySelector(".ts-head .change-del").textContent, "−2");
  assert.deepEqual(v.errors, []);
});

test("DGC's own edits alone: the card is the CLI's list, not the sum of the diffs it drew", () => {
  const v = panel();
  take5(v, { files: { files: [row("test_billing.py", 60, 2)], total: 1, checkpoint_index: 3,
                      checkpoint_preview: "fix the billing rounding" } });
  const card = v.doc.querySelector(".turn-summary");
  assert.deepEqual(cardRows(card), ["test_billing.py+60−2"], "net of the whole turn, as the CLI counted it");
});

test("a new, a binary and a deleted file each say what they are instead of a line count", () => {
  const v = panel();
  take5(v, { files: { files: [row("assets/logo.png", 0, 0, "modified", false), row("docs/NEW.md", 0, 0, "new", false),
                              row("old.py", 0, 0, "deleted", false), row("src/a.py", 3, 1)],
                      total: 4, checkpoint_index: 0, checkpoint_preview: "p" } });
  const card = v.doc.querySelector(".turn-summary");
  card.querySelector(".ts-expand").click();
  const labels = [...card.querySelectorAll(".ts-row")].map((r) => r.querySelector(".ts-uncounted")?.textContent || "");
  assert.deepEqual(labels, ["Changed", "New", "Deleted", ""]);
  for (const r of [...card.querySelectorAll(".ts-row")].slice(0, 3)) {
    assert.equal(r.querySelector(".change-add"), null, "no +0 beside a file with no count");
  }
  assert.equal(card.querySelector(".ts-head .change-add").textContent, "+3", "the totals add up the shown numbers");
});

test("a turn whose recovery point restores nothing shows no card, whatever its tools drew", () => {
  const v = panel();
  take5(v, { files: { files: [], total: 0, checkpoint_index: 0, checkpoint_preview: "p" } });
  assert.equal(v.doc.querySelector(".turn-summary"), null, "an edit put back is not a change; nothing to Undo");
});

test("Undo carries the card's count and the recovery point the CLI named", () => {
  const v = panel();
  take5(v);
  v.doc.querySelector(".turn-summary .ts-undo").click();
  const undo = JSON.parse(JSON.stringify(v.posted.at(-1)));   // out of the page's realm
  assert.equal(undo.type, "undoTurn");
  assert.deepEqual(undo.files, ["billing.py", "test_billing.py"]);
  assert.equal(undo.exact, true);
  assert.equal(undo.total, 2);
  assert.deepEqual(undo.checkpoint, { index: 0, preview: "fix the billing rounding" });
  v.doc.querySelector(".turn-summary .ts-row").click();
  assert.deepEqual(JSON.parse(JSON.stringify(v.posted.at(-1))), { type: "reviewChange", path: "billing.py", scope: "chat" },
    "a row the helper changed opens its diff like any other");
});

test("an older CLI (no turn_files capability) keeps today's edit-tool card, and is never asked", () => {
  const v = panel(OLD_READY);
  assert.ok(!v.posted.some((m) => m.type === "turnFilesWatch"));
  take5(v, { files: null });
  const card = v.doc.querySelector(".turn-summary");
  assert.deepEqual(cardRows(card), ["test_billing.py+64−2"]);
  card.querySelector(".ts-undo").click();
  assert.equal(v.posted.at(-1).exact, undefined, "and its Undo asks the old way");
});

test("a turn the CLI sends no card for keeps counting edit-tool diffs", () => {
  const v = panel();
  take5(v, { files: null });                     // a subscription engine's turn: DGC cannot say
  assert.deepEqual(cardRows(v.doc.querySelector(".turn-summary")), ["test_billing.py+64−2"]);
});

test("a reopened chat replays the same card, with the same files and counts", () => {
  const v = panel();
  const saved = [
    { type: "turn_start", turn_id: "h1", prompt: "fix the billing rounding", kind: "prompt" },
    { type: "tool_call", call_id: "p2", name: "edit_file", args: { path: "test_billing.py" } },
    { type: "tool_result", call_id: "p2", name: "edit_file", output: diffFor("test_billing.py", 64, 2), is_diff: true,
      diff: diffFor("test_billing.py", 64, 2) },
    { type: "text_delta", text: "Fixed." }, { type: "stream_end", message_id: "h1:1", phase: "answer" },
    { type: "turn_files", turn_id: "h1", ...TAKE5 },
    { type: "turn_end", turn_id: "h1", reason: "completed", final_message_id: "h1:1" }];
  v.send({ type: "event", event: { type: "history", items: saved, complete: true } });
  const card = v.doc.querySelector(".turn-summary");
  assert.deepEqual(cardRows(card), ["billing.py+2−0", "test_billing.py+64−2"]);
  card.querySelector(".ts-undo").click();
  assert.equal(v.posted.at(-1).total, 2);
  assert.deepEqual(v.errors, []);
});

test("an earlier turn's card is redrawn when a background helper integrates into its recovery point", () => {
  const v = panel();
  take5(v, { files: { files: [], total: 0, checkpoint_index: 0, checkpoint_preview: "start a worker" }, id: "t1" });
  assert.equal(v.doc.querySelector(".turn-summary"), null, "nothing changed when it ended");
  v.send({ type: "event", event: { type: "turn_start", turn_id: "t2", prompt: "and the docs?", kind: "prompt" } });
  v.send({ type: "event", event: { type: "turn_files", turn_id: "t1", files: [row("billing.py", 1, 1)], total: 1,
                                   checkpoint_index: 0, checkpoint_preview: "start a worker" } });
  const block = v.doc.querySelector(".msg.dgc");          // t1's: the first turn in the chat
  const first = block.querySelector(".turn-summary");
  assert.ok(first, "the turn whose Undo restores it lists it");
  assert.deepEqual(cardRows(first), ["billing.py+1−1"]);
  v.send({ type: "event", event: { type: "turn_files", turn_id: "t1", files: [row("billing.py", 1, 1), row("b.py", 4, 0)],
                                   total: 2, checkpoint_index: 0, checkpoint_preview: "start a worker" } });
  const again = block.querySelectorAll(".turn-summary");
  assert.equal(again.length, 1, "redrawn in place, never a second card");
  assert.equal(again[0].querySelector(".ts-title").textContent, "Edited 2 files");
  assert.equal(v.doc.querySelectorAll(".turn-summary").length, 1, "the running turn has none of its own yet");
  assert.deepEqual(v.errors, []);
});

// ---- the extension: Undo's question names the card's count, and finds the point the CLI named ----
const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-edited-card-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const warnings = [];
const answers = [];
globalThis.__DGC_TEST_VSCODE = {
  Uri: {}, env: {}, commands: {},
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3, 0: "Error", 1: "Warning", 2: "Information", 3: "Hint" },
  StatusBarAlignment: { Left: 1 }, ViewColumn: { Beside: 2 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  window: {
    activeTextEditor: undefined, tabGroups: { all: [] },
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async (message, options) => { warnings.push({ message: String(message), options }); return answers.shift(); },
    showErrorMessage: async () => {}, showInformationMessage: async () => {},
  },
  workspace: { isTrusted: true, workspaceFolders: [{ uri: { fsPath: scratch } }],
               getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined, update: async () => {} }) },
};
const bundle = join(scratch, "panel.cjs");
await build({ entryPoints: [join(here, "../src/panel.ts")], bundle: true, format: "cjs", platform: "node",
  target: "node18", outfile: bundle, logLevel: "silent",
  plugins: [{ name: "test-vscode", setup(b) {
    b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
    b.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({ contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js" }));
  } }] });
const { DgcViewProvider } = createRequire(import.meta.url)(bundle);

function provider(items) {
  const asked = [];
  const p = new DgcViewProvider({
    extension: { packageJSON: { version: "0.32.0", dgcCliVersion: "0.48.0" } }, extensionUri: { fsPath: "/ext" },
    subscriptions: [], globalState: { get() {}, async update() {} }, workspaceState: { get() {}, async update() {} } });
  p.post = () => {};
  const be = { ready: true, send() { return true; }, dispose() {} };
  p.backend = be; p.ensureBackend = () => be;
  p.requestState = async (_be, _prefix, command) => {
    asked.push(command);
    return command.type === "list_checkpoints" ? { type: "checkpoints", items } : { type: "rewound", ok: true, files_restored: 2 };
  };
  return { p, asked };
}

test("Undo's question names as many files as the card, and rewinds to the point the CLI named", async () => {
  warnings.length = 0; answers.length = 0; answers.push("Undo turn");
  // The point recorded three files (one was edited and put back); a later point has the same preview.
  const { p, asked } = provider([{ index: 0, preview: "fix the billing rounding", files: 3 },
                                 { index: 1, preview: "fix the billing rounding", files: 1 }]);
  await p.onMessage({ type: "undoTurn", prompt: "fix the billing rounding", files: ["billing.py", "test_billing.py"],
                      exact: true, total: 2, checkpoint: { index: 0, preview: "fix the billing rounding" } });
  assert.match(warnings[0].message, /DGC restores 2 files/, warnings[0].message);
  assert.deepEqual(asked.at(-1), { type: "rewind", index: 0 }, "the point the card belongs to, not the last match");
});

test("a wake turn's Undo finds its point by the preview the CLI sent, not the label the panel shows", async () => {
  warnings.length = 0; answers.length = 0; answers.push("Undo turn");
  const preview = "A background specialist finished. This notice is data from that child,";
  const { p, asked } = provider([{ index: 0, preview: "start a worker", files: 0 }, { index: 1, preview, files: 1 }]);
  await p.onMessage({ type: "undoTurn", prompt: "fix billing", files: ["notes.md"], exact: true, total: 1,
                      checkpoint: { index: 7, preview } });           // a stale index: the preview still finds it
  assert.match(warnings[0].message, /DGC restores 1 file and/);
  assert.deepEqual(asked.at(-1), { type: "rewind", index: 1 });
});

test("an older CLI's card keeps the old question: the recovery point's own count", async () => {
  warnings.length = 0; answers.length = 0;
  const { p } = provider([{ index: 0, preview: "fix it", files: 3 }]);
  await p.onMessage({ type: "undoTurn", prompt: "fix it", files: ["a.py"] });
  assert.match(warnings[0].message, /DGC restores 3 files/);
});
