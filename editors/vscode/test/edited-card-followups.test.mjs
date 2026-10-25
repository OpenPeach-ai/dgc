// The Edited card's follow-ups for 0.48 (the founder, 25 Oct): a reopened card that marks a file Undo can no longer
// put back, a late redraw that reaches a card drawn from history, Undo on an older turn saying how many later turns it
// also takes back and how many files it really restores, and the changes bar refreshing when a background helper's
// idle integration lands. The CLI side is tests/test_turn_files_followups.py.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { makeDom } from "./support/webview-dom.mjs";

const READY = { type: "ready", capabilities: { history_snapshot: true, turn_files: 1, rewind_preview: 1 }, model: "m",
  mode: "auto", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [],
  custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 };
const row = (path, additions, deletions, extra = {}) =>
  ({ path, additions, deletions, counted: true, status: "modified", ...extra });
const plain = (value) => JSON.parse(JSON.stringify(value));      // out of the page's realm
const savedTurn = (id, prompt, files) => [
  { type: "turn_start", turn_id: id, prompt, kind: "prompt" },
  { type: "text_delta", text: `Answer to ${prompt}.` }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  ...(files ? [{ type: "turn_files", turn_id: id, ...files }] : []),
  { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];
function reopened(items) {
  const v = makeDom();
  v.send({ type: "event", event: READY });
  v.send({ type: "event", event: { type: "history", items, complete: true } });
  return v;
}
const cardOf = (v, n) => v.doc.querySelectorAll(".msg.dgc")[n]?.querySelector(".turn-summary");
const rows = (card) => [...card.querySelectorAll(".ts-row")].map((r) => r.textContent.replace(/\s+/g, " ").trim());

// ---- 4 · a late redraw reaches a card drawn from history ----
test("a turn_files for a live turn reaches its card when the window was reloaded and drew it from history", () => {
  const v = reopened([
    ...savedTurn("h1", "start a worker", { files: [], total: 0, checkpoint_index: 0, checkpoint_preview: "start a worker" }),
    ...savedTurn("h2", "and the docs?", { files: [row("README.md", 1, 0)], total: 1, checkpoint_index: 1,
                                         checkpoint_preview: "and the docs?" })]);
  assert.equal(cardOf(v, 0), null, "nothing had changed when the first turn ended");
  // The backend still calls that turn t1: its id from before the reload.
  v.send({ type: "event", event: { type: "turn_files", turn_id: "t1", files: [row("billing.py", 1, 1)], total: 1,
                                   checkpoint_index: 0, checkpoint_preview: "start a worker" } });
  assert.deepEqual(rows(cardOf(v, 0)), ["billing.py+1−1"], "found by the recovery point its card named");
  assert.deepEqual(rows(cardOf(v, 1)), ["README.md+1−0"], "and no other turn's card is touched");
  v.send({ type: "event", event: { type: "turn_files", turn_id: "t1", files: [row("billing.py", 2, 1)], total: 1,
                                   checkpoint_index: 0, checkpoint_preview: "start a worker" } });
  assert.equal(v.doc.querySelectorAll(".msg.dgc")[0].querySelectorAll(".turn-summary").length, 1, "redrawn in place");
  assert.deepEqual(rows(cardOf(v, 0)), ["billing.py+2−1"]);
  assert.deepEqual(v.errors, []);
});

// ---- 3 · a file outside the project after a restart ----
test("a reopened card marks a file Undo can no longer put back, and Undo's count leaves it out", () => {
  const v = reopened(savedTurn("h1", "edit both", {
    files: [row("src/a.py", 1, 1), row("~/notes.txt", 1, 1, { outside: true, undoable: false })], total: 2,
    checkpoint_index: 0, checkpoint_preview: "edit both" }));
  const card = cardOf(v, 0);
  assert.equal(card.querySelector(".ts-title").textContent, "Edited 2 files", "the turn did edit both");
  const [inside, outside] = card.querySelectorAll(".ts-row");
  assert.equal(inside.querySelector(".ts-no-undo"), null);
  assert.equal(outside.querySelector(".ts-no-undo").textContent, "Can't undo");
  assert.match(outside.querySelector(".ts-no-undo").title, /Outside the project/);
  card.querySelector(".ts-undo").click();
  const undo = plain(v.posted.at(-1));
  assert.equal(undo.total, 1, "Undo's question counts only the file it can restore");
});

test("in the session that changed it, a file outside the project is undone like any other", () => {
  const v = reopened(savedTurn("h1", "edit both", {
    files: [row("src/a.py", 1, 1), row("~/notes.txt", 1, 1, { outside: true })], total: 2,
    checkpoint_index: 0, checkpoint_preview: "edit both" }));
  assert.equal(cardOf(v, 0).querySelector(".ts-no-undo"), null);
  cardOf(v, 0).querySelector(".ts-undo").click();
  assert.equal(plain(v.posted.at(-1)).total, 2);
});

// ---- 2 · Undo on an older turn's card (the panel says how many turns follow it) ----
test("Undo on an older turn's card says how many later turns the rewind takes back too", () => {
  const v = reopened([
    ...savedTurn("h1", "first", { files: [row("a.py", 1, 0)], total: 1, checkpoint_index: 0, checkpoint_preview: "first" }),
    ...savedTurn("h2", "second", null),
    ...savedTurn("h3", "third", { files: [row("b.py", 1, 0)], total: 1, checkpoint_index: 2, checkpoint_preview: "third" })]);
  cardOf(v, 0).querySelector(".ts-undo").click();
  assert.equal(plain(v.posted.at(-1)).later, 2);
  cardOf(v, 2).querySelector(".ts-undo").click();
  assert.equal(plain(v.posted.at(-1)).later, 0, "the newest turn has none after it");
});

// ---- the extension: the question, and the changes bar ----
const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-edited-followups-"));
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
    showWarningMessage: async (message) => { warnings.push(String(message)); return answers.shift(); },
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

const POINTS = [{ index: 0, preview: "first", files: 2 }, { index: 1, preview: "second", files: 3 },
                { index: 2, preview: "third", files: 1 }];
function provider({ preview = 4, capable = true } = {}) {
  const asked = [];
  const p = new DgcViewProvider({
    extension: { packageJSON: { version: "0.32.0", dgcCliVersion: "0.48.0" } }, extensionUri: { fsPath: "/ext" },
    subscriptions: [], globalState: { get() {}, async update() {} }, workspaceState: { get() {}, async update() {} } });
  p.post = () => {};
  const be = { ready: true, send() { return true; }, dispose() {} };
  p.backend = be; p.ensureBackend = () => be;
  p.lastReadyEvent = { type: "ready", capabilities: capable ? { turn_files: 1, rewind_preview: 1 } : { turn_files: 1 } };
  p.requestState = async (_be, _prefix, command) => {
    asked.push(command);
    if (command.type === "list_checkpoints") return { type: "checkpoints", items: POINTS };
    if (command.type === "rewind_preview") return { type: "rewind_preview", index: command.index, files: preview };
    return { type: "rewound", ok: true, files_restored: preview };
  };
  return { p, asked };
}
const undo = (p, checkpoint, later, total = 2) => p.onMessage({ type: "undoTurn", prompt: checkpoint.preview,
  files: ["a.py", "b.py"].slice(0, total), exact: true, total, checkpoint, later });

test("an older turn's Undo names the later turns it takes back and the files the rewind really restores", async () => {
  warnings.length = 0; answers.length = 0;
  const { p, asked } = provider({ preview: 4 });
  await undo(p, { index: 0, preview: "first" }, 2);
  assert.equal(warnings[0], "Undo this turn and the 2 turns after it? DGC restores 4 files and rewinds the "
    + "conversation to just before this prompt.");
  assert.deepEqual(asked.find((c) => c.type === "rewind_preview"), { type: "rewind_preview", index: 0 },
    "the count is the CLI's, across every turn it takes back");
  warnings.length = 0;
  await undo(p, { index: 1, preview: "second" }, 1, 1);
  assert.equal(warnings[0], "Undo this turn and the turn after it? DGC restores 4 files and rewinds the "
    + "conversation to just before this prompt.");
});

test("the newest turn's question is the card's own count, as it was", async () => {
  warnings.length = 0; answers.length = 0;
  const { p, asked } = provider({ preview: 9 });
  await undo(p, { index: 2, preview: "third" }, 0, 1);
  assert.equal(warnings[0], "Undo this turn? DGC restores 1 file and rewinds the conversation to just before this prompt.");
  assert.ok(!asked.some((c) => c.type === "rewind_preview"), "nothing more to ask");
});

test("a CLI that cannot count it gets an upper bound, never a smaller number", async () => {
  warnings.length = 0; answers.length = 0;
  const { p } = provider({ capable: false });
  await undo(p, { index: 0, preview: "first" }, 2);
  assert.equal(warnings[0], "Undo this turn and the 2 turns after it? DGC restores up to 6 files and rewinds the "
    + "conversation to just before this prompt.", "every file those three recovery points recorded");
});

test("a turn_files refreshes the changes bar: an idle helper's integration is in the chat's changes by then", () => {
  const { p } = provider();
  const refreshed = [];
  p.scheduleWorkspaceChanges = (delay) => refreshed.push(delay);
  p.onEvent({ type: "turn_files", seq: 1, turn_id: "t1", files: [row("billing.py", 1, 1)], total: 1,
              checkpoint_index: 0, checkpoint_preview: "first" });
  assert.deepEqual(refreshed, [0]);
});
