// Undo never loses the person's work (the founder, 25 Oct: "fix all of these for 0.48").
//
// 1. A file one of the turn's own commands changed, that Undo can't put back, is on the Edited card as "Changed by a
//    command — Undo leaves it", with no line count, and Undo's question leaves it out of its count.
// 2. With a CLI that offers ready.capabilities.undo_to, Undo asks with `undo_to` and reads `undo_result`: when files
//    somebody changed after DGC wrote them stop it, a second question names them, "Keep my changes" first (the
//    default) and "Undo anyway" second, which sends the same rewind with exactly those files to overwrite; when
//    anything else stops it, it says what; after it, its line says how many files commands changed were left.
// 3. An older CLI keeps `rewind` / `rewound`.
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

function turnWith(v, files) {
  const event = (d) => v.send({ type: "event", event: d });
  event({ type: "turn_start", turn_id: "t1", prompt: "tidy the notes", kind: "prompt" });
  event({ type: "tool_call", call_id: "b1", name: "bash", args: { command: "sed -i s/a/b/ notes.txt" } });
  event({ type: "tool_result", call_id: "b1", name: "bash", output: "", is_error: false, is_diff: false });
  event({ type: "text_delta", text: "Tidied." });
  event({ type: "stream_end", message_id: "t1:1", phase: "answer" });
  event({ type: "turn_files", turn_id: "t1", ...files });
  event({ type: "turn_end", turn_id: "t1", reason: "completed", final_message_id: "t1:1" });
}

test("a file a command changed that Undo can't put back says so on the card, and Undo's count leaves it out", () => {
  const v = makeDom();
  v.send({ type: "event", event: READY });
  turnWith(v, { files: [
    { path: "src/a.py", additions: 1, deletions: 1, counted: true, status: "modified" },
    { path: "notes.txt", additions: 0, deletions: 0, counted: false, status: "modified", command: true }],
    total: 2, checkpoint_index: 0, checkpoint_preview: "tidy the notes" });
  const card = v.doc.querySelector(".turn-summary");
  assert.equal(card.querySelector(".ts-title").textContent, "Edited 2 files");
  const [edited, byCommand] = [...card.querySelectorAll(".ts-row")];
  assert.equal(byCommand.querySelector(".ts-by-command").textContent, "Changed by a command — Undo leaves it");
  assert.equal(byCommand.querySelector(".change-add"), null, "no line count beside it");
  assert.equal(byCommand.querySelectorAll(".ts-uncounted").length, 1, "one label, not two");
  assert.equal(edited.querySelector(".ts-by-command"), null);
  assert.equal(card.querySelector(".ts-head .change-add").textContent, "+1", "the totals are the counted rows'");
  card.querySelector(".ts-undo").click();
  const undo = JSON.parse(JSON.stringify(v.posted.at(-1)));
  assert.equal(undo.type, "undoTurn");
  assert.equal(undo.total, 1, "Undo restores one file; the question says one");
  assert.deepEqual(v.errors, []);
});

// ---- the extension ----
const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-undo-anyway-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const said = [];
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
    showWarningMessage: async (message, options, ...items) => {
      said.push({ kind: "warning", message: String(message), options, items }); return answers.shift(); },
    showErrorMessage: async (message) => { said.push({ kind: "error", message: String(message) }); },
    showInformationMessage: async (message) => { said.push({ kind: "info", message: String(message) }); },
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

function provider(results, capabilities = { turn_files: 1, rewind_preview: 1, undo_to: 1 }) {
  const asked = [];
  const p = new DgcViewProvider({
    extension: { packageJSON: { version: "0.32.0", dgcCliVersion: "0.48.0" } }, extensionUri: { fsPath: "/ext" },
    subscriptions: [], globalState: { get() {}, async update() {} }, workspaceState: { get() {}, async update() {} } });
  p.post = () => {};
  const be = { ready: true, send() { return true; }, dispose() {} };
  p.backend = be; p.ensureBackend = () => be;
  p.lastReadyEvent = { type: "ready", capabilities };
  p.requestState = async (_be, _prefix, command) => {
    asked.push(JSON.parse(JSON.stringify(command)));
    if (command.type === "list_checkpoints") return { type: "checkpoints", items: [{ index: 0, preview: "turn 1", files: 1 }] };
    if (command.type === "rewind") return { type: "rewound", ok: true, files_restored: 1 };
    return { type: "undo_result", request_id: "u", index: command.index, ...results.shift() };
  };
  return { p, asked };
}
const undoTurn = (p) => p.onMessage({ type: "undoTurn", prompt: "turn 1", files: ["a.py"], exact: true, total: 1,
                                      checkpoint: { index: 0, preview: "turn 1" } });
const CONFLICT = { ok: false, files_restored: 0, left: [], stopped: 0,
                   conflicts: [{ path: "a.py", reason: "between" }, { path: "b.py", reason: "changed" }] };

test("a refusal names the files and offers Undo anyway, with Keep my changes the default", async () => {
  said.length = 0; answers.length = 0; answers.push("Undo turn", "Keep my changes");
  const { p, asked } = provider([CONFLICT]);
  await undoTurn(p);
  assert.deepEqual(asked.at(-1), { type: "undo_to", index: 0 }, "the first ask overwrites nothing");
  const question = said[1];
  assert.equal(question.message, "These files changed after DGC wrote them, by you or another program: a.py, b.py. "
    + "Undo anyway puts back the version from before this turn and loses those changes.");
  assert.equal(question.options.modal, true);
  assert.deepEqual(question.items, ["Keep my changes", "Undo anyway"], "Keep my changes first: the default");
  assert.equal(question.options.detail, "a.py: changed after DGC wrote it, before DGC wrote it again\n"
    + "b.py: changed after DGC last wrote it");
  assert.equal(asked.filter((c) => c.type === "undo_to").length, 1, "keeping them sends nothing more");
  assert.equal(said.length, 2);
});

test("Undo anyway sends the same rewind with exactly those files, and its line says what commands left", async () => {
  said.length = 0; answers.length = 0; answers.push("Undo turn", "Undo anyway");
  const { p, asked } = provider([CONFLICT, { ok: true, files_restored: 3, conflicts: [], left: ["notes.txt", "log.txt"],
                                             stopped: 0 }]);
  await undoTurn(p);
  assert.deepEqual(asked.at(-1), { type: "undo_to", index: 0, overwrite: ["a.py", "b.py"] });
  assert.deepEqual(said.at(-1), { kind: "info",
    message: "↩ Undone; DGC restored 3 files. 2 files changed by commands were left as they are." });
});

test("an Undo that stops for any other reason says why", async () => {
  said.length = 0; answers.length = 0; answers.push("Undo turn");
  const { p } = provider([{ ok: false, files_restored: 0, conflicts: [], left: [], stopped: 0,
                            error: "DGC could not write ro/b.py: Permission denied" }]);
  await undoTurn(p);
  assert.deepEqual(said.at(-1), { kind: "error", message: "DGC could not undo the turn: DGC could not write ro/b.py: "
    + "Permission denied. Nothing was changed, and the recovery point was kept." });
});

test("one file left by a command, and none", async () => {
  said.length = 0; answers.length = 0; answers.push("Undo turn", "Undo turn");
  const { p } = provider([{ ok: true, files_restored: 1, conflicts: [], left: ["notes.txt"], stopped: 0 },
                          { ok: true, files_restored: 1, conflicts: [], left: [], stopped: 0 }]);
  await undoTurn(p);
  assert.equal(said.at(-1).message, "↩ Undone; DGC restored 1 file. 1 file changed by a command was left as it is.");
  await undoTurn(p);
  assert.equal(said.at(-1).message, "↩ Undone; DGC restored 1 file.");
});

test("an older CLI is sent rewind, as before", async () => {
  said.length = 0; answers.length = 0; answers.push("Undo turn");
  const { p, asked } = provider([], { turn_files: 1, rewind_preview: 1 });
  await undoTurn(p);
  assert.deepEqual(asked.at(-1), { type: "rewind", index: 0 });
  assert.equal(said.at(-1).message, "↩ Undone; DGC restored 1 file(s).");
});
