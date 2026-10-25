// "Open here" says where the chat is open and what runs there (src/holderWords.ts, dgc/holder_note.py).
//
// * The words: where and idle, working now, kept running with no window, each running thing counted and none named
//   when none, a folder never shown as a full path, and nothing at all (today's sentence) when the holder can't say.
// * The panel, driven for real against a fake `dgc serve`: it says which editor this window is (editor_app) when the
//   CLI offers it; a read-only chat asks session_holder of its own backend and shows the line; once the chat moved
//   (Open here in another window) it asks the side bar's backend and shows the line about the new owner; an older CLI
//   is never asked and the bar keeps today's sentence.
// * The webview: the line in the bar, its head in bold, as text only; today's sentence without one.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { makeDom } from "./support/webview-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-open-here-"));
const bundle = join(scratch, "open-here.cjs");

let command = "dgc";
globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...parts) => ({ toString: () => parts.join("/"), fsPath: parts.join("/") }) },
  env: { appName: "Cursor", clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async () => undefined },
  languages: { getDiagnostics: () => [] },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  StatusBarAlignment: { Left: 1 },
  ConfigurationTarget: { WorkspaceFolder: 1, Workspace: 2, Global: 3 },
  window: {
    activeTextEditor: undefined,
    tabGroups: { all: [] },
    createStatusBarItem: () => ({ text: "", tooltip: "", command: "", show() {}, hide() {}, dispose() {} }),
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined,
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: scratch, toString: () => `file://${scratch}` } }],
    getConfiguration: () => ({
      get: (key, fallback) => fallback,
      inspect: (key) => (key === "command" ? { defaultValue: "dgc", globalValue: command } : undefined),
      async update() {},
    }),
  },
};

await build({
  stdin: {
    contents: `export { DgcViewProvider } from "./panel"; export { DGC_PROTOCOL_VERSION } from "./backend";
               export * as words from "./holderWords";`,
    resolveDir: join(here, "../src"), loader: "ts",
  },
  bundle: true, format: "cjs", platform: "node", target: "node18", outfile: bundle, logLevel: "silent",
  plugins: [{
    name: "test-vscode",
    setup(builder) {
      builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
      builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({
        contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js",
      }));
    },
  }],
});
const { DgcViewProvider, DGC_PROTOCOL_VERSION, words } = createRequire(import.meta.url)(bundle);

const spawned = [];
const providers = [];
after(() => {
  for (const provider of providers) { try { provider.dispose(); } catch { /* already gone */ } }
  for (const pid of spawned) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.includes(scratch)) process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  delete globalThis.__DGC_TEST_VSCODE;
  rmSync(scratch, { recursive: true, force: true });
});

const SESSION = "20261025-101500-a1b2c3";
const DETACH = { version: 1, idle_exit_s: 120, waiting_exit_s: 3600, max_windowless_s: 43200 };
const CURSOR_FACTS = { found: true, editor: "Cursor", windowless: false, folder: "~/toni-erp", working: false, idle_s: 380,
                       monitors: 2, helpers: 1, commands: 0, queued: 0, waiting: 0 };

/**
 * A fake `dgc serve`: ready with `caps`, answers resume_session, and session_holder with `holder` (whatever is asked).
 * One JSON line per command it gets goes to its log. A prompt `emit <json>` sends that event.
 */
function fakeServe(name, { caps = {}, holder = { found: false } } = {}) {
  const path = join(scratch, name);
  const log = join(scratch, `${name}.log`);
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("fs");
const note = (value) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + "\\n");
let sequence = 0;
const send = (value) => process.stdout.write(JSON.stringify({ seq: sequence++, ...value }) + "\\n");
const perChat = { model: "fixture", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
  context_size: 32768, session_id: ${JSON.stringify(SESSION)} };
send({ type: "ready", version: "fixture", protocol_version: ${DGC_PROTOCOL_VERSION}, capabilities: ${JSON.stringify(caps)}, ...perChat });
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const cmd = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    note({ cmd });
    if (cmd.type === "shutdown") process.exit(0);
    if (cmd.type === "set_workspace_roots") send({ type: "workspace_roots", roots: [], request_id: cmd.request_id });
    if (cmd.type === "resume_session") send({ type: "session", kind: "resumed", message_count: 1, session_id: ${JSON.stringify(SESSION)}, request_id: cmd.request_id });
    if (cmd.type === "session_holder") send({ type: "session_holder", request_id: cmd.request_id, session_id: cmd.session_id, ...${JSON.stringify(holder)} });
    if (cmd.type === "prompt" && String(cmd.text || "").startsWith("emit ")) send(JSON.parse(cmd.text.slice(5)));
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 200));
`, "utf8");
  chmodSync(path, 0o700);
  const read = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { path, commands: () => read().map((row) => row.cmd), types: () => read().map((row) => row.cmd.type) };
}

async function until(predicate, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function context(state = {}) {
  return {
    extension: { packageJSON: { version: "0.32.0", dgcCliVersion: "0.0.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [], logUri: { fsPath: mkdtempSync(join(scratch, "log-")) },
    secrets: { async get() {}, async store() {}, async delete() {} },
    globalState: { get() {}, async update() {} },
    workspaceState: { get: (key) => state[key], async update(key, value) { state[key] = value; } },
  };
}

/** The side bar, and a session's tab beside it (as a Sessions-home window has them). */
function tab(session = SESSION) {
  const host = new DgcViewProvider(context());
  host.post = () => {};
  providers.push(host);
  const places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  const posted = [];
  const provider = new DgcViewProvider(context(), { key: "0123456789abcdef", session, places, host, title() {}, restored: false });
  provider.post = (message) => posted.push(message);
  provider.webviewReady = true;
  providers.push(provider);
  return { provider, posted, host };
}
const bars = (posted) => posted.filter((m) => m.type === "session_elsewhere");

// ---- the words ---------------------------------------------------------------------------------

test("the line: where and idle, then what runs there, and what Open here moves", () => {
  assert.deepEqual(words.holderLine(words.holderFacts(CURSOR_FACTS)), {
    head: "Open in Cursor · ~/toni-erp · idle 6 min.",
    detail: "2 monitors and 1 background helper run there. Open here moves them to this window." });
  assert.deepEqual(words.holderLine(words.holderFacts({ ...CURSOR_FACTS, monitors: 0, helpers: 0 })),
                   { head: "Open in Cursor · ~/toni-erp · idle 6 min.", detail: "" }, "nothing runs: nothing more is said");
  assert.deepEqual([0, 59, 60, 3599, 3600, 47 * 3600, 49 * 3600].map((s) => words.idleWords(s)),
                   ["idle under a minute", "idle under a minute", "idle 1 min", "idle 59 min", "idle 1 h", "idle 47 h", "idle 2 days"]);
});

test("the line: working now, and a ChatDGC chat writing a reply", () => {
  const working = words.holderFacts({ ...CURSOR_FACTS, working: true, idle_s: 5, monitors: 0, helpers: 0 });
  assert.equal(working.idle_s, undefined, "never idle while it works");
  assert.deepEqual(words.holderLine(working),
                   { head: "Open in Cursor · ~/toni-erp · working now.", detail: "Open here moves it to this window." });
  assert.deepEqual(words.holderLine(working, "chat"),
                   { head: "Open in Cursor · ~/toni-erp · writing a reply now.", detail: "Open here moves it to this window." });
  assert.deepEqual(words.holderLine(words.holderFacts({ found: true, editor: "VS Code", folder: "~", working: false, idle_s: 7200 }), "chat"),
                   { head: "Open in VS Code · ~ · idle 2 h.", detail: "" });
});

test("the line: kept running by DGC with no window open", () => {
  assert.deepEqual(words.holderLine(words.holderFacts({ found: true, windowless: true, editor: "", folder: "~/toni-erp",
                                                       working: true, monitors: 1 })),
                   { head: "Kept running by DGC with no window open · ~/toni-erp · working now.",
                     detail: "1 monitor runs there. Open here moves them to this window." });
});

test("the line: each running and waiting thing is counted, none is named when none", () => {
  const line = (extra) => words.holderLine(words.holderFacts({ ...CURSOR_FACTS, monitors: 0, helpers: 0, ...extra })).detail;
  assert.equal(line({}), "");
  assert.equal(line({ monitors: 1 }), "1 monitor runs there. Open here moves it to this window.");
  assert.equal(line({ helpers: 2 }), "2 background helpers run there. Open here moves them to this window.");
  assert.equal(line({ commands: 1 }), "1 background command runs there. Open here moves it to this window.");
  assert.equal(line({ monitors: 1, helpers: 1, commands: 3 }),
               "1 monitor, 1 background helper and 3 background commands run there. Open here moves them to this window.");
  assert.equal(line({ queued: 1 }), "1 queued prompt waits there. Open here moves it to this window.");
  assert.equal(line({ waiting: 2 }), "2 questions wait for an answer there. Open here moves them to this window.");
  assert.equal(line({ queued: 2, waiting: 1 }), "2 queued prompts and 1 question wait there. Open here moves them to this window.");
  assert.equal(line({ monitors: -3, helpers: 1.5, commands: "2" }), "", "only real counts");
});

test("nothing invented: an older CLI, a holder that can't say where, or none at all keeps today's sentence", () => {
  for (const ev of [undefined, {}, { found: false }, { ...CURSOR_FACTS, found: false }, { ...CURSOR_FACTS, editor: "" },
                    { ...CURSOR_FACTS, editor: " \n " }]) {
    assert.equal(words.holderLine(words.holderFacts(ev)), undefined, JSON.stringify(ev));
  }
  // A part it didn't say is left out, never guessed.
  assert.deepEqual(words.holderLine(words.holderFacts({ found: true, editor: "Cursor" })), { head: "Open in Cursor.", detail: "" });
});

test("the folder is shown with ~, never as a full path; the editor by the name people use", () => {
  const head = (folder) => words.holderLine(words.holderFacts({ found: true, editor: "Cursor", folder })).head;
  assert.equal(head("~/toni-erp"), "Open in Cursor · ~/toni-erp.");
  assert.equal(head("toni-erp"), "Open in Cursor · toni-erp.");
  assert.equal(head("/home/bob/secret/toni-erp"), "Open in Cursor · toni-erp.", "whatever arrives, never another user's path");
  assert.equal(head("C:\\Users\\bob\\proj"), "Open in Cursor · proj.");
  assert.deepEqual(["Visual Studio Code", "Visual Studio Code - Insiders", "Cursor", "Windsurf", "VSCodium", "", undefined]
    .map((name) => words.editorName(name)), ["VS Code", "VS Code Insiders", "Cursor", "Windsurf", "VSCodium", "", ""]);
});

// ---- the panel -----------------------------------------------------------------------------------

test("the window says which editor it is, only to a CLI that offers it", async () => {
  for (const [caps, says] of [[{ detach: DETACH, session_holder: 1 }, true], [{ detach: DETACH }, false]]) {
    const fixture = fakeServe(`serve-editor-${says}`, { caps });
    command = fixture.path;
    const h = tab();
    const be = h.provider.ensureBackend();
    spawned.push(be.childPid);
    assert.ok(await until(() => h.provider.sessionReady));
    await pause(100);
    assert.deepEqual(fixture.commands().filter((c) => c.type === "editor_app"), says ? [{ type: "editor_app", name: "Cursor" }] : []);
    be.dispose("restart: test");
  }
});

test("elsewhere: the read-only chat asks its own backend and the bar says where and what runs there", async () => {
  const caps = { detach: { ...DETACH, elsewhere: { session_id: SESSION, pid: 4242, reason: "on_screen" } }, session_holder: 1 };
  const fixture = fakeServe("serve-elsewhere", { caps, holder: CURSOR_FACTS });
  command = fixture.path;
  const h = tab();
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => bars(h.posted).some((m) => m.note)), "the bar got the line");
  const asked = fixture.commands().filter((c) => c.type === "session_holder");
  assert.equal(asked.length, 1);
  assert.equal(asked[0].session_id, SESSION);
  const bar = bars(h.posted).at(-1);
  assert.equal(bar.state, "elsewhere");
  assert.deepEqual(bar.note, { head: "Open in Cursor · ~/toni-erp · idle 6 min.",
                               detail: "2 monitors and 1 background helper run there. Open here moves them to this window." });
  // Open here: the chat is this window's, and nothing more is asked about it.
  const taker = fakeServe("serve-elsewhere-taken", { caps: { detach: DETACH, session_holder: 1 }, holder: CURSOR_FACTS });
  command = taker.path;
  h.provider.openSessionHere();
  spawned.push(h.provider.backend?.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  assert.equal(h.provider.sessionElsewhere, undefined);
  await pause(200);
  assert.equal(taker.types().includes("session_holder"), false);
  h.provider.backend?.dispose("restart: test");
});

test("elsewhere with an older CLI: never asked, today's sentence", async () => {
  const caps = { detach: { ...DETACH, elsewhere: { session_id: SESSION, pid: 4242, reason: "on_screen" } } };
  const fixture = fakeServe("serve-elsewhere-old", { caps, holder: CURSOR_FACTS });
  command = fixture.path;
  const h = tab();
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => bars(h.posted).some((m) => m.state === "elsewhere")));
  await pause(300);
  assert.equal(fixture.types().includes("session_holder"), false, "a command it would refuse is never sent");
  assert.equal(bars(h.posted).some((m) => m.note), false);
  be.dispose("restart: test");
});

test("moved: the window it came from asks the side bar's backend, and says where it is now", async () => {
  // The side bar's backend: its own process, which can say where a session is open.
  const home = fakeServe("serve-home", { caps: { detach: DETACH, session_holder: 1 },
                                         holder: { ...CURSOR_FACTS, editor: "VS Code", working: true, monitors: 1, helpers: 0 } });
  command = home.path;
  const h = tab();
  const sidebarBackend = h.host.ensureBackend();
  spawned.push(sidebarBackend.childPid);
  assert.ok(await until(() => h.host.sessionReady), "the side bar's backend is up");
  // The tab's own backend, until another window takes its session.
  const own = fakeServe("serve-moved-own", { caps: { detach: DETACH, session_holder: 1 } });
  command = own.path;
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "session_moved", reason: "opened_elsewhere" })}` });
  assert.ok(await until(() => bars(h.posted).some((m) => m.state === "moved")));
  assert.equal(h.provider.backend, undefined, "its own backend was let go");
  assert.ok(await until(() => bars(h.posted).some((m) => m.state === "moved" && m.note), 8000), "the line about the new owner");
  assert.deepEqual(home.commands().filter((c) => c.type === "session_holder").map((c) => c.session_id), [SESSION]);
  assert.deepEqual(bars(h.posted).at(-1).note, { head: "Open in VS Code · ~/toni-erp · working now.",
                                                 detail: "1 monitor runs there. Open here moves them to this window." });
  sidebarBackend.dispose("restart: test");
});

// ---- the webview ---------------------------------------------------------------------------------

test("the webview: the bar says the line, its head in bold, as text; today's sentence without one", () => {
  const x = makeDom();
  x.send({ type: "event", event: { type: "ready", capabilities: {} } });
  x.send({ type: "session_ready", sessionId: SESSION });
  const text = () => x.doc.getElementById("elsewhere-text");
  x.send({ type: "session_elsewhere", state: "elsewhere" });
  assert.equal(text().textContent, "This session is open in another window.");
  x.send({ type: "session_elsewhere", state: "elsewhere", note: { head: "Open in Cursor · ~/toni-erp · idle 6 min.",
    detail: "2 monitors and 1 background helper run there. Open here moves them to this window." } });
  assert.equal(text().querySelector("strong.elsewhere-where").textContent, "Open in Cursor · ~/toni-erp · idle 6 min.");
  assert.equal(text().textContent, "Open in Cursor · ~/toni-erp · idle 6 min. 2 monitors and 1 background helper run there. "
                                   + "Open here moves them to this window.");
  assert.equal(x.doc.getElementById("elsewhere-bar").hidden, false);
  assert.equal(x.doc.getElementById("input").getAttribute("contenteditable"), "false", "still read-only");
  // Text only, whatever arrives.
  x.send({ type: "session_elsewhere", state: "moved", note: { head: "<img src=x onerror=alert(1)>", detail: "<b>x</b>" } });
  assert.equal(text().querySelector("img, b"), null);
  assert.equal(text().textContent, "<img src=x onerror=alert(1)> <b>x</b>");
  // Moved, the holder not said yet: today's sentence.
  x.send({ type: "session_elsewhere", state: "moved", reason: "opened_elsewhere" });
  assert.equal(text().textContent, "This session is open in another window now.");
  assert.deepEqual(x.errors, []);
});
