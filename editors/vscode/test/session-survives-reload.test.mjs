// Layer 1: a session keeps running through a window reload (dgc/serve_detach.py, dgc/serve_relay.py).
//
// The extension's half, driven for real: DgcBackend and the panel against a fake `dgc serve` that
// records every command it is sent, every signal it gets and the environment it was started with.
//
// * A session's backend opts in (set_detach) only when the CLI offers it; a window's teardown then says
//   `detach` and kills nothing. A restart, an explicit stop and the Sessions home's own backend still
//   stop it, and an older CLI is driven exactly as before.
// * A reloaded tab asks to reattach (DGC_ATTACH_SESSION / DGC_ATTACH=restore), resumes nothing, repaints
//   from the backend's own snapshot and takes its queue back without handing anything back twice.
// * session_moved leaves the chat read-only with Open here, and Open here takes the session with steal.
// * A turn the backend stopped with no window is offered Continue once (turn_interrupted).
// * Q3: a tab closed while it works is asked about once; the answer is remembered when ticked.
// * Settings -> Running sessions and the Sessions list's "Running, no window".
// * The webview: the read-only bar, the locked box, Open here.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { makeDom, mainJs } from "./support/webview-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-layer1-"));
const bundle = join(scratch, "layer1.cjs");

let command = "dgc";
const settings = new Map([["closingAWorkingTab", "ask"]]);
const settingUpdates = [];
const quickPicks = [];
/** What the next quick pick does: a list of item ids to accept in order (or "hide"). */
let quickPickScript = ["keep"];
globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...parts) => ({ toString: () => parts.join("/"), fsPath: parts.join("/") }) },
  env: { clipboard: { writeText: async () => {} } },
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
    createQuickPick: () => {
      const handlers = { accept: [], hide: [] };
      const pick = {
        items: [], activeItems: [], selectedItems: [], title: "", placeholder: "", ignoreFocusOut: false, shown: 0,
        onDidAccept: (fn) => handlers.accept.push(fn), onDidHide: (fn) => handlers.hide.push(fn),
        show() {
          this.shown++;
          const steps = quickPickScript.slice();
          setTimeout(() => {
            for (const step of steps) {
              if (step === "hide") { handlers.hide.forEach((fn) => fn()); return; }
              pick.selectedItems = [pick.items.find((item) => item.id === step)];
              handlers.accept.forEach((fn) => fn());
            }
          }, 10);
        },
        hide() { handlers.hide.forEach((fn) => fn()); }, dispose() {},
      };
      quickPicks.push(pick);
      return pick;
    },
  },
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: scratch, toString: () => `file://${scratch}` } }],
    getConfiguration: () => ({
      get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
      inspect: (key) => (key === "command" ? { defaultValue: "dgc", globalValue: command } : undefined),
      async update(key, value, target) { settingUpdates.push({ key, value, target }); settings.set(key, value); },
    }),
  },
};

await build({
  stdin: {
    contents: `export { DgcViewProvider } from "./panel"; export { DgcBackend, DGC_PROTOCOL_VERSION } from "./backend";
               export { OpenedChat } from "./chatChannel";`,
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
const { DgcViewProvider, DgcBackend, DGC_PROTOCOL_VERSION, OpenedChat } = createRequire(import.meta.url)(bundle);

const spawned = [];
const providers = [];
after(() => {
  for (const provider of providers) { try { provider.dispose(); } catch { /* already gone */ } }
  // Every fixture this file started, by pid: each is a node script under `scratch`, never anything else.
  for (const pid of spawned) {
    try {
      const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8");
      if (cmdline.includes(scratch)) process.kill(pid, "SIGKILL");
    } catch { /* already gone */ }
  }
  delete globalThis.__DGC_TEST_VSCODE;
  rmSync(scratch, { recursive: true, force: true });
});

const SESSION = "20261022-120000-a1b2c3";

/**
 * A fake `dgc serve`. `caps` are ready's capabilities; `attached` (if set) is what a reattached
 * backend's ready says. It appends to `log` one JSON line per thing that happened to it: its start
 * (with DGC_ATTACH_SESSION / DGC_ATTACH), each command, end of input, each SIGTERM. End of input leaves
 * it running a second longer (a backend keeping its work), `shutdown` ends it at once. A prompt
 * `emit <json>` sends that event; list_live_sessions answers with `rows`.
 */
function fakeServe(name, { caps = {}, attached = null, session = SESSION, rows = [], opened = [] } = {}) {
  const path = join(scratch, name);
  const log = join(scratch, `${name}.log`);
  writeFileSync(path, `#!/usr/bin/env node
const fs = require("fs");
const note = (value) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + "\\n");
note({ start: process.pid, attach_session: process.env.DGC_ATTACH_SESSION || "", attach: process.env.DGC_ATTACH || "" });
process.on("SIGTERM", () => { note({ signal: "SIGTERM" }); process.exit(0); });
let sequence = 0;
const send = (value) => process.stdout.write(JSON.stringify({ seq: sequence++, ...value }) + "\\n");
const perChat = { model: "fixture", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1",
  workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
  context_size: 32768, session_id: ${JSON.stringify(session)} };
const caps = ${JSON.stringify(caps)};
const attached = ${JSON.stringify(attached)};
if (attached) caps.attached = attached;
send({ type: "ready", version: "fixture", protocol_version: ${DGC_PROTOCOL_VERSION}, capabilities: caps, ...perChat });
for (const extra of ${JSON.stringify(opened)}) send({ type: "chat_opened", request_id: "attached", ...perChat, ...extra });
let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const cmd = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    note({ cmd });
    if (cmd.type === "shutdown") process.exit(0);
    if (cmd.type === "set_workspace_roots") send({ type: "workspace_roots", roots: [], request_id: cmd.request_id });
    if (cmd.type === "resume_session") send({ type: "session", kind: "resumed", message_count: 1, session_id: ${JSON.stringify(session)}, request_id: cmd.request_id });
    if (cmd.type === "list_live_sessions") send({ type: "live_sessions", items: ${JSON.stringify(rows)}, request_id: cmd.request_id });
    if (cmd.type === "prompt" && String(cmd.text || "").startsWith("emit ")) send(JSON.parse(cmd.text.slice(5)));
  }
});
process.stdin.on("end", () => { note({ eof: true }); setTimeout(() => process.exit(0), 1000); });
`, "utf8");
  chmodSync(path, 0o700);
  const read = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { path, read, commands: () => read().filter((row) => row.cmd).map((row) => row.cmd),
           types: () => read().filter((row) => row.cmd).map((row) => row.cmd.type),
           signals: () => read().filter((row) => row.signal).length, eof: () => read().some((row) => row.eof),
           starts: () => read().filter((row) => row.start) };
}

async function until(predicate, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const DETACH = { detach: { version: 1, idle_exit_s: 120, waiting_exit_s: 3600, max_windowless_s: 43200 } };
const PANEL_DISPOSED = "panel disposed (window reload, close or extension update)";

function backend(fixture, { keep = true, attach } = {}) {
  const be = new DgcBackend(scratch, fixture.path, undefined, undefined);
  be.keepWorkRunning = keep;
  if (attach) be.attach = attach;
  be.start();
  spawned.push(be.childPid);
  return be;
}

// ---- the transport -------------------------------------------------------------------------------

test("a session's backend opts in, and a window going away says detach and kills nothing", async () => {
  const fixture = fakeServe("serve-detach", { caps: DETACH });
  const be = backend(fixture);
  assert.ok(await until(() => be.ready), "ready");
  be.completeHandshake();
  assert.ok(await until(() => fixture.types().includes("set_detach")), "set_detach is sent right after ready");
  assert.deepEqual(fixture.commands().find((c) => c.type === "set_detach"), { type: "set_detach", keep_running: true });
  const pid = be.childPid;
  be.dispose(PANEL_DISPOSED);
  assert.ok(await until(() => fixture.eof()), "the pipe is closed");
  await pause(500);                                       // past the 300 ms a stop waits before its kill
  assert.ok(fixture.types().includes("detach"), "it was told the window is going");
  assert.equal(fixture.types().includes("shutdown"), false, "never told to shut down");
  assert.equal(fixture.signals(), 0, "never signalled");
  assert.ok(alive(pid), "it is still running its work");
});

test("a restart and an explicit stop still stop it; the Sessions home's backend never opts in", async () => {
  for (const cause of ["restart: command DGC: Restart Backend", "stop: its tab was closed", "chat closed: x"]) {
    const fixture = fakeServe(`serve-stop-${cause.split(":")[0].replace(/\s/g, "-")}`, { caps: DETACH });
    const be = backend(fixture);
    assert.ok(await until(() => be.ready));
    be.completeHandshake();
    assert.ok(await until(() => fixture.types().includes("set_detach")));
    be.dispose(cause);
    assert.ok(await until(() => fixture.types().includes("shutdown")), `${cause}: shutdown`);
    assert.equal(fixture.types().includes("detach"), false, `${cause}: no detach`);
  }
  const home = fakeServe("serve-home", { caps: DETACH });
  const be = backend(home, { keep: false });
  assert.ok(await until(() => be.ready));
  be.completeHandshake();
  await pause(150);
  assert.equal(home.types().includes("set_detach"), false, "the home's backend ends with its window, as before");
  assert.ok(be.detachOffer, "it still knows the CLI can (Settings asks it what is running)");
  be.dispose(PANEL_DISPOSED);
  assert.ok(await until(() => home.types().includes("shutdown")));
});

test("an older CLI that offers nothing is driven exactly as before", async () => {
  const fixture = fakeServe("serve-old", { caps: {} });
  const be = backend(fixture);
  assert.ok(await until(() => be.ready));
  be.completeHandshake();
  await pause(150);
  assert.equal(fixture.types().includes("set_detach"), false, "never sent a command it would reject");
  be.dispose(PANEL_DISPOSED);
  assert.ok(await until(() => fixture.types().includes("shutdown")), "a window going away stops it, as before");
  assert.equal(fixture.types().includes("detach"), false);
});

test("a backend asked to reattach says so in its environment, once as asked, then automatically", async () => {
  const fixture = fakeServe("serve-attach-env", { caps: DETACH });
  const be = backend(fixture, { attach: { session: SESSION, mode: "restore" } });
  assert.ok(await until(() => be.ready));
  assert.deepEqual(fixture.starts().map((s) => [s.attach_session, s.attach]), [[SESSION, "restore"]]);
  assert.deepEqual(be.attach, { session: SESSION, mode: "auto" }, "a later start of this instance asks automatically");
  be.dispose("restart: test");
  await until(() => fixture.types().includes("shutdown"));
  const plain = fakeServe("serve-attach-none", { caps: DETACH });
  const other = backend(plain);
  assert.ok(await until(() => other.ready));
  assert.deepEqual(plain.starts().map((s) => [s.attach_session, s.attach]), [["", ""]], "nothing asked, nothing set");
  other.dispose("restart: test");
});

test("session_moved lets the child go without stopping it: it may be serving the other window", async () => {
  const fixture = fakeServe("serve-moved", { caps: DETACH });
  const be = backend(fixture);
  assert.ok(await until(() => be.ready));
  be.completeHandshake();
  const teardowns = [];
  be.on("teardown", (cause) => teardowns.push(cause));
  const pid = be.childPid;
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "session_moved", reason: "opened_elsewhere" })}` });
  assert.ok(await until(() => teardowns.length), "the panel hears it");
  assert.match(teardowns[0], /^moved: /);
  assert.ok(await until(() => fixture.eof()), "its stdin is ended");
  await pause(450);
  assert.equal(fixture.signals(), 0, "never signalled");
  assert.equal(fixture.types().includes("shutdown"), false);
  assert.ok(alive(pid));
  assert.equal(be.moved, true);
});

test("a chat the reattached process kept is adopted: claimed with a ping, never opened again", async () => {
  const attached = { chats: [{ chat_id: "c0", session_id: SESSION, cwd: scratch, turn: null, queued: [], waiting: [] },
                             { chat_id: "c1", session_id: "20261022-other", cwd: scratch, turn: null, queued: [], waiting: [] }],
                     windowless_s: 30, work: "", pid: 1 };
  const fixture = fakeServe("serve-adopt", { caps: { ...DETACH, chats: { version: 1, max: 8, default: "c0" } }, attached,
                                            opened: [{ chat_id: "c1", session_id: "20261022-other" }] });
  const be = backend(fixture);
  assert.ok(await until(() => be.ready && be.attachedOpened.has("c1")), "the kept chat was announced");
  be.completeHandshake();
  const chat = new OpenedChat(be, scratch, "open-1", "c1");
  const readies = [];
  chat.on("event", (ev) => { if (ev.type === "ready") readies.push(ev); });
  chat.start();
  assert.ok(await until(() => readies.length), "its ready");
  assert.equal(readies[0].session_id, "20261022-other");
  assert.ok(readies[0].capabilities.attached, "with the process's capabilities");
  assert.equal(chat.chatId, "c1");
  await pause(100);
  const sent = fixture.commands();
  assert.ok(sent.some((c) => c.type === "ping" && c.chat_id === "c1"), "claimed at once");
  assert.equal(sent.some((c) => c.type === "open_chat"), false, "no second chat on the same session");
  be.dispose("restart: test");
});

// ---- the panel -----------------------------------------------------------------------------------

function sidebar(state) {
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.32.0", dgcCliVersion: "0.0.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [], logUri: { fsPath: mkdtempSync(join(scratch, "log-")) },
    secrets: { async get() {}, async store() {}, async delete() {} },
    globalState: { get() {}, async update() {} },
    workspaceState: state ? { get: (key) => state[key], async update(key, value) { state[key] = value; } }
                          : { get() {}, async update() {} },
  });
  provider.post = () => {};
  providers.push(provider);
  return provider;
}

/** A session's tab, as VS Code brings one back after a reload (`restored`) or as the user opens one. */
function tab(session = SESSION, { restored = true, state = {} } = {}) {
  const host = sidebar();
  const places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  const posted = [];
  const provider = new DgcViewProvider({
    extension: { packageJSON: { version: "0.32.0", dgcCliVersion: "0.0.1" } },
    extensionUri: { fsPath: "/ext" }, subscriptions: [], logUri: { fsPath: mkdtempSync(join(scratch, "log-")) },
    secrets: { async get() {}, async store() {}, async delete() {} },
    globalState: { get() {}, async update() {} },
    workspaceState: { get: (key) => state[key], async update(key, value) { state[key] = value; } },
  }, { key: "0123456789abcdef", session, places, host, title() {}, restored });
  provider.post = (message) => posted.push(message);
  provider.webviewReady = true;
  providers.push(provider);
  return { provider, posted, state };
}

test("a reloaded tab reattaches: no resume, the backend's own snapshot, and its queue taken back", async () => {
  // What the window queued before it reloaded: q1 is still queued in the backend; q2 ran with no window.
  const draft = (text) => ({ text, attachments: [] });
  const state = { "dgc.queuedPrompts.v1#0123456789abcdef": { scope: "", items: [
    { requestId: "q1", session: SESSION, text: "next one", draft: draft("next one") },
    { requestId: "q2", session: SESSION, text: "ran already", draft: draft("ran already") }] } };
  const attached = { chats: [{ chat_id: "c0", session_id: SESSION, cwd: scratch,
                               turn: { turn_id: "t7", kind: "prompt", prompt: "TURN_LONG please", started_at: Date.now() / 1000 - 30 },
                               queued: [{ request_id: "q1", text: "next one" }], waiting: ["perm-1"] }],
                     windowless_s: 12, work: "a turn is running", pid: 4242 };
  const fixture = fakeServe("serve-reattach", { caps: { ...DETACH, history_snapshot: true, resume_turn: true,
                                                        chats: { version: 1, max: 8, default: "c0" } }, attached });
  command = fixture.path;
  const h = tab(SESSION, { state });
  const key = Object.keys(state)[0];
  if (h.provider.stateKey("dgc.queuedPrompts.v1") !== key) {
    // The panel's own name for the key: re-file the fixture under it.
    state[h.provider.stateKey("dgc.queuedPrompts.v1")] = state[key];
  }
  h.provider.unsentPrompts = state[h.provider.stateKey("dgc.queuedPrompts.v1")].items
    .map((item) => ({ ...item, queued: true }));
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady), "the handshake finished");
  assert.deepEqual(fixture.starts().map((s) => [s.attach_session, s.attach]), [[SESSION, "restore"]]);
  const sent = fixture.types();
  assert.equal(sent.includes("resume_session"), false, "it never reopens from disk what is still running");
  assert.ok(sent.includes("set_detach"));
  assert.ok(await until(() => fixture.types().includes("get_history")), "repainted from the backend's snapshot");
  assert.equal(fixture.types().includes("set_workspace_roots"), false, "the folder grant waits for the running turn");
  assert.ok(h.posted.some((m) => m.type === "turn_active" && m.turnId === "t7"), "the running turn is the live one");
  assert.equal(h.provider.confirmedTurnActive, true);
  assert.ok(h.provider.openDecisions.has("perm-1"));
  assert.deepEqual([...h.provider.unstartedPrompts.keys()], ["q1"], "q1 is still queued there");
  assert.equal(h.provider.unstartedPrompts.get("q1").queued, true);
  assert.deepEqual(h.provider.unsentPrompts, [], "nothing handed back: q2 ran, q1 is still queued");
  assert.equal(h.posted.some((m) => m.type === "prompts_unsent"), false);
  // The turn ends: now this window's folders are sent.
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "turn_end", turn_id: "t7", reason: "completed", token_estimate: 10 })}` });
  assert.ok(await until(() => fixture.types().includes("set_workspace_roots")), "sent once the turn ended");
  be.dispose("restart: test");
});

test("moved: the chat goes read-only with Open here, and Open here takes the session with steal", async () => {
  const fixture = fakeServe("serve-moved-panel", { caps: { ...DETACH, history_snapshot: true } });
  command = fixture.path;
  const h = tab(SESSION, { restored: false });
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  assert.deepEqual(fixture.starts().map((s) => s.attach), ["auto"], "a tab the user opened never waits for a reload");
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "session_moved", reason: "opened_elsewhere" })}` });
  assert.ok(await until(() => h.posted.some((m) => m.type === "session_elsewhere" && m.state === "moved")));
  assert.equal(h.provider.backend, undefined, "the chat let its backend go");
  await pause(400);
  assert.equal(fixture.signals(), 0, "and stopped nothing");
  const taker = fakeServe("serve-open-here", { caps: { ...DETACH, history_snapshot: true } });
  command = taker.path;
  h.provider.openSessionHere();
  spawned.push(h.provider.backend?.childPid);
  assert.ok(await until(() => taker.starts().length));
  assert.deepEqual(taker.starts().map((s) => [s.attach_session, s.attach]), [[SESSION, "steal"]]);
  h.provider.backend?.dispose("restart: test");
});

test("a turn stopped while no window was open is offered Continue once", async () => {
  const fixture = fakeServe("serve-interrupted", { caps: { ...DETACH, resume_turn: true } });
  command = fixture.path;
  const h = tab(SESSION, { restored: false });
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "turn_interrupted", session_id: SESSION,
    cause: "it waited 1h 0m for your answer with no window open", at: Date.now() / 1000 })}` });
  assert.ok(await until(() => h.posted.some((m) => m.type === "continue_offer")));
  const offer = h.posted.find((m) => m.type === "continue_offer");
  assert.equal(offer.windowless, true);
  assert.match(offer.cause, /your answer/);
  // Another session's is not this chat's to offer.
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "turn_interrupted", session_id: "other",
    cause: "x", at: 1 })}` });
  await pause(150);
  assert.equal(h.posted.filter((m) => m.type === "continue_offer").length, 1);
  be.dispose("restart: test");
});

async function workingTab(name) {
  const fixture = fakeServe(name, { caps: { ...DETACH } });
  command = fixture.path;
  const h = tab(SESSION, { restored: false });
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  assert.ok(await until(() => fixture.types().includes("set_detach")));
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "turn_start", turn_id: "t1", prompt: "work" })}` });
  assert.ok(await until(() => h.provider.confirmedTurnActive));
  return { fixture, h, be };
}

test("Q3: a tab closed mid-turn asks once; Keep running with the tick remembers it and detaches", async () => {
  settings.set("closingAWorkingTab", "ask");
  quickPicks.length = 0; settingUpdates.length = 0;
  quickPickScript = ["remember", "keep"];
  const { fixture, h } = await workingTab("serve-q3-keep");
  h.provider.dispose(true);                                // the user closed the tab
  assert.ok(await until(() => fixture.types().includes("detach")), "kept running: told the window is going");
  assert.equal(quickPicks.length, 1, "asked once");
  assert.match(quickPicks[0].title, /still working when you closed its tab/);
  assert.deepEqual(settingUpdates, [{ key: "closingAWorkingTab", value: "keepRunning", target: 3 }]);
  await pause(400);
  assert.equal(fixture.types().includes("shutdown"), false);
  assert.equal(fixture.signals(), 0);
  // Remembered: the next one is not asked.
  const second = await workingTab("serve-q3-remembered");
  second.h.provider.dispose(true);
  assert.ok(await until(() => second.fixture.types().includes("detach")));
  assert.equal(quickPicks.length, 1, "not asked again");
});

test("Q3: Stop stops it; a tab with nothing running stops as before; a reload never asks", async () => {
  settings.set("closingAWorkingTab", "ask");
  quickPicks.length = 0; settingUpdates.length = 0;
  quickPickScript = ["stop"];
  const stopped = await workingTab("serve-q3-stop");
  stopped.h.provider.dispose(true);
  assert.ok(await until(() => stopped.fixture.types().includes("shutdown")), "Stop: shut down");
  assert.equal(stopped.fixture.types().includes("detach"), false);
  assert.deepEqual(settingUpdates, [], "not ticked: nothing remembered");
  settings.set("closingAWorkingTab", "stop");
  const told = await workingTab("serve-q3-setting-stop");
  told.h.provider.dispose(true);
  assert.ok(await until(() => told.fixture.types().includes("shutdown")));
  assert.equal(quickPicks.length, 1, "the remembered Stop is not asked");
  settings.set("closingAWorkingTab", "ask");
  const idle = fakeServe("serve-q3-idle", { caps: { ...DETACH } });
  command = idle.path;
  const h = tab(SESSION, { restored: false });
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  h.provider.dispose(true);
  assert.ok(await until(() => idle.types().includes("shutdown")), "nothing running: it stops, as closing a tab did");
  assert.equal(quickPicks.length, 1, "and nothing is asked");
  const reload = await workingTab("serve-q3-reload");
  reload.h.provider.dispose();                              // a reload or a closed window
  assert.ok(await until(() => reload.fixture.types().includes("detach")));
  assert.equal(quickPicks.length, 1, "a reload never asks");
});

test("Settings -> Running sessions lists what runs with no window, and Stop asks that process", async () => {
  const rows = [
    { pid: 900, kind: "serve", instance: "a1b2c3d4e5f60718", version: "0.48.0", attached: false, detachable: true,
      windowless_s: 400, uptime_s: 900, work: "a turn is running", status: "working", liveness: "live", here: false,
      sessions: [{ session_id: SESSION, name: "Fix the login", cwd: "/work/app", status: "working" }] },
    { pid: 901, kind: "serve", instance: "ffff", version: "0.48.0", attached: true, detachable: true,
      windowless_s: 0, uptime_s: 50, work: "", status: "idle", liveness: "live", here: false,
      sessions: [{ session_id: "20261022-shown", name: "Open in a window", cwd: "/work/app", status: "idle" }] },
    { pid: 902, kind: "tui", instance: "", version: "0.48.0", attached: true, detachable: false,
      windowless_s: 0, uptime_s: 50, work: "", status: "idle", liveness: "live", here: false, sessions: [] },
  ];
  const fixture = fakeServe("serve-running", { caps: { ...DETACH }, rows });
  command = fixture.path;
  const provider = sidebar();
  const pages = [];
  provider.settingsEditor = { webview: { postMessage: (m) => { pages.push(m); return Promise.resolve(true); } } };
  const be = provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => be.ready));
  be.completeHandshake();
  await provider.onSettingsMessage({ type: "listRunning" });
  assert.ok(await until(() => pages.some((m) => m.type === "running" && Array.isArray(m.items))));
  const page = pages.find((m) => m.type === "running" && Array.isArray(m.items));
  assert.deepEqual(page.items.map((r) => [r.pid, r.session, r.name, r.working, r.windowless_s]),
    [[900, SESSION, "Fix the login", true, 400]], "only what runs with no window");
  await provider.onSettingsMessage({ type: "stopRunning", pid: 900, instance: "a1b2c3d4e5f60718" });
  assert.ok(await until(() => fixture.commands().some((c) => c.type === "stop_live_session")));
  const stop = fixture.commands().find((c) => c.type === "stop_live_session");
  assert.equal(stop.pid, 900);
  assert.equal(stop.instance, "a1b2c3d4e5f60718");
  // The Sessions list marks it "Running, no window" (a session open in a tab here is marked open instead).
  const home = [];
  provider.home = true;
  provider.places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  provider.webviewReady = true;
  provider.post = (m) => home.push(m);
  provider.postSessionItems([{ path: `${SESSION}.json`, name: "Fix the login" }, { path: "20261022-shown.json", name: "x" }]);
  const list = home.find((m) => m.type === "sessions_list");
  assert.equal(list.items[0].windowless, "a turn is running");
  assert.equal("windowless" in list.items[1], false, "shown in a window: not marked");
  be.dispose("restart: test");
});

// ---- the Sessions home's backend: it carries ChatDGC ------------------------------------------------

const CHATDGC_DETACH = { detach: { ...DETACH.detach, chatdgc: 1 }, chatdgc: { version: 1 } };

test("the home's backend keeps a ChatDGC reply running: set_detach_chatdgc where offered, never set_detach", async () => {
  const home = fakeServe("serve-home-chatdgc", { caps: CHATDGC_DETACH });
  const be = new DgcBackend(scratch, home.path, undefined, undefined);
  be.keepChatdgcRunning = true;
  be.start();
  spawned.push(be.childPid);
  assert.ok(await until(() => be.ready));
  be.completeHandshake();
  assert.ok(await until(() => home.types().includes("set_detach_chatdgc")), "opted in for ChatDGC");
  assert.deepEqual(home.commands().find((c) => c.type === "set_detach_chatdgc"), { type: "set_detach_chatdgc", keep_running: true });
  assert.equal(home.types().includes("set_detach"), false, "its own chat's work is not kept: only ChatDGC's");
  const pid = be.childPid;
  be.dispose(PANEL_DISPOSED);
  assert.ok(await until(() => home.types().includes("detach")), "a window going says detach");
  await pause(450);
  assert.equal(home.types().includes("shutdown"), false);
  assert.equal(home.signals(), 0);
  assert.ok(alive(pid));
  // A CLI whose detach predates it (layer 1): the home's backend ends with its window, as before.
  const older = fakeServe("serve-home-layer1", { caps: DETACH });
  const old = new DgcBackend(scratch, older.path, undefined, undefined);
  old.keepChatdgcRunning = true;
  old.start();
  spawned.push(old.childPid);
  assert.ok(await until(() => old.ready));
  old.completeHandshake();
  await pause(150);
  assert.equal(older.types().some((t) => t.startsWith("set_detach")), false, "never sent a command it would refuse");
  old.dispose(PANEL_DISPOSED);
  assert.ok(await until(() => older.types().includes("shutdown")));
});

test("the home asks for its own backend back after a reload, and remembers the one it gets", async () => {
  const state = { "dgc.homeBackend.v1": { scope: "", session: "20261023-home-old" } };
  const fixture = fakeServe("serve-home-reattach", { caps: CHATDGC_DETACH, session: "20261023-home-new" });
  command = fixture.path;
  const provider = sidebar(state);
  provider.home = true;
  state["dgc.homeBackend.v1"].scope = provider.draftScope();
  const be = provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => fixture.starts().length));
  assert.deepEqual(fixture.starts().map((s) => [s.attach_session, s.attach]), [["20261023-home-old", "restore"]],
                   "its first start after the window opens is a reload's");
  assert.equal(be.keepChatdgcRunning, true);
  assert.equal(be.keepWorkRunning, false);
  assert.ok(await until(() => state["dgc.homeBackend.v1"].session === "20261023-home-new"), "the backend it has now");
  assert.ok(await until(() => fixture.types().includes("set_detach_chatdgc")));
  be.dispose("restart: test");
  await until(() => fixture.types().includes("shutdown"));
  // Another folder's remembered backend is not this window's.
  const other = { "dgc.homeBackend.v1": { scope: "another-folder", session: "20261023-home-old" } };
  const plain = fakeServe("serve-home-other-scope", { caps: CHATDGC_DETACH });
  command = plain.path;
  const second = sidebar(other);
  second.home = true;
  const be2 = second.ensureBackend();
  spawned.push(be2.childPid);
  assert.ok(await until(() => plain.starts().length));
  assert.deepEqual(plain.starts().map((s) => [s.attach_session, s.attach]), [["", ""]]);
  be2.dispose("restart: test");
});

test("Settings -> Running sessions lists a ChatDGC chat answering with no window as a chat, not the home's own session", async () => {
  const CHAT = "chat_" + "c".repeat(32);
  const rows = [
    { pid: 910, kind: "serve", instance: "c0ffee00c0ffee00", version: "0.48.0", attached: false, detachable: true,
      windowless_s: 200, uptime_s: 900, work: "a ChatDGC reply is being written", status: "idle", liveness: "live", here: false,
      scope: "chatdgc", chats: [{ conversation_id: CHAT, title: "Count from 1 to 400" }, { conversation_id: "../x", title: "bad" }],
      sessions: [{ session_id: "20261023-home", name: "", cwd: "/work/app", status: "idle" }] },
  ];
  const fixture = fakeServe("serve-running-chat", { caps: { ...CHATDGC_DETACH }, rows });
  command = fixture.path;
  const provider = sidebar();
  const pages = [];
  provider.settingsEditor = { webview: { postMessage: (m) => { pages.push(m); return Promise.resolve(true); } } };
  const be = provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => be.ready));
  be.completeHandshake();
  await provider.onSettingsMessage({ type: "listRunning" });
  assert.ok(await until(() => pages.some((m) => m.type === "running" && Array.isArray(m.items))));
  const page = pages.find((m) => m.type === "running" && Array.isArray(m.items));
  assert.deepEqual(page.items.map((r) => [r.kind, r.chat, r.name, r.cwd, r.working, r.windowless_s, r.pid]),
    [["chat", CHAT, "Count from 1 to 400", "/work/app", true, 200, 910]]);
  // The Sessions list marks none of it: the home's own session is nobody's.
  provider.home = true;
  provider.places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  provider.webviewReady = true;
  const home = [];
  provider.post = (m) => home.push(m);
  provider.postSessionItems([{ path: "20261023-home.json", name: "x" }]);
  assert.equal("windowless" in home.find((m) => m.type === "sessions_list").items[0], false);
  be.dispose("restart: test");
});

test("the Running sessions page: a chat row says it is a chat, how long, and where to watch it; Stop asks its process", async () => {
  const { JSDOM } = await import("jsdom");
  const src = join(here, "../src/");
  const client = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife",
                               loader: { ".css": "empty", ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
  const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, platform: "node", format: "cjs" });
  const mod = { exports: {} };
  new Function("module", "exports", view.outputFiles[0].text)(mod, mod.exports);
  const dom = new JSDOM(mod.exports.settingsDocument(), { runScripts: "outside-only" });
  const w = dom.window;
  const sent = [];
  w.acquireVsCodeApi = () => ({ postMessage: (m) => sent.push(m) });
  w.eval(client.outputFiles[0].text);
  const message = (m) => w.dispatchEvent(new w.MessageEvent("message", { data: m }));
  message({ type: "event", event: { type: "config", model: "m", mode: "default", think: "off" } });
  w.document.querySelector("[data-nav=running]").click();
  assert.ok(sent.some((m) => m.type === "listRunning"));
  message({ type: "running", items: [
    { kind: "chat", chat: "chat_" + "c".repeat(32), name: "Count from 1 to 400", cwd: "/work/app", working: true,
      work: "a ChatDGC reply is being written", windowless_s: 200, pid: 910, instance: "c0ffee00c0ffee00", version: "0.48.0" },
    { session: SESSION, name: "Fix the login", cwd: "/work/app", working: true, work: "a turn is running", windowless_s: 400,
      pid: 900, instance: "a1b2c3d4e5f60718", version: "0.48.0" }] });
  const rows = [...w.document.querySelectorAll(".running-sessions .row")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /Count from 1 to 400/);
  assert.match(rows[0].textContent, /ChatDGC chat · no window for 3 minutes/);
  assert.match(rows[0].textContent, /Writing a reply\. It finishes and saves by itself; open app again to watch it/);
  assert.equal(rows[0].querySelector("[data-running-open]"), null, "it opens in the window it was in, not here");
  assert.ok(rows[1].querySelector("[data-running-open]"), "a session's row still opens here");
  rows[0].querySelector("[data-running-stop]").click();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), { type: "stopRunning", pid: 910, instance: "c0ffee00c0ffee00" });
  assert.equal(w.document.querySelector(".running-sessions .row [data-running-stop]").textContent, "Stopping…");
  w.close();
});

// ---- the webview ---------------------------------------------------------------------------------

test("the webview: read-only with Open here while the session is elsewhere, and back again", () => {
  const x = makeDom();
  x.send({ type: "event", event: { type: "ready", capabilities: {} } });
  x.send({ type: "session_ready", sessionId: SESSION });
  x.send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "go" } });
  x.send({ type: "event", event: { type: "text_delta", text: "half an answer" } });
  const bar = x.doc.getElementById("elsewhere-bar"), input = x.doc.getElementById("input");
  assert.equal(bar.hidden, true);
  x.send({ type: "session_elsewhere", state: "moved", reason: "opened_elsewhere" });
  assert.equal(bar.hidden, false);
  assert.match(x.doc.getElementById("elsewhere-text").textContent, /open in another window now/);
  assert.equal(input.getAttribute("contenteditable"), "false", "read-only");
  assert.equal(x.doc.getElementById("send").disabled, true);
  assert.match(input.dataset.placeholder, /Open here/);
  const ended = [...x.doc.querySelectorAll(".turn-act, .act-summary, [class*='act']")].map((n) => n.textContent).join(" ");
  assert.match(x.doc.body.textContent, /Carrying on in another window/, "the turn is not called stopped");
  assert.doesNotMatch(ended, /Stopped/);
  x.doc.getElementById("elsewhere-open").click();
  assert.ok(x.posted.some((m) => m.type === "openSessionHere"));
  assert.equal(x.doc.getElementById("elsewhere-open").disabled, true, "one click");
  x.send({ type: "session_elsewhere", state: "none" });
  assert.equal(bar.hidden, true);
  assert.equal(input.getAttribute("contenteditable"), "true");
  assert.equal(x.doc.getElementById("send").disabled, false);
  x.send({ type: "session_elsewhere", state: "moved", reason: "no_window" });
  assert.match(x.doc.getElementById("elsewhere-text").textContent, /stopped answering/);
  assert.deepEqual(x.errors, []);
});

test("the webview: a turn stopped with no window says so on its Continue card", () => {
  const x = makeDom();
  x.send({ type: "event", event: { type: "ready", capabilities: {} } });
  x.send({ type: "session_ready", sessionId: SESSION });
  x.send({ type: "continue_offer", sessionId: SESSION, windowless: true, cause: "it waited 1h 0m for your answer with no window open" });
  const card = x.doc.querySelector(".recovery-card.continue-offer");
  assert.ok(card);
  assert.match(card.textContent, /stopped while no window was open \(it waited 1h 0m for your answer/);
  assert.deepEqual(x.errors, []);
});

test("the Sessions list marks a session running with no window", () => {
  const x = makeDom({ script: `document.documentElement.dataset.chatPlace = "home";\n${mainJs}` });
  x.send({ type: "sessions_list", items: [
    { id: SESSION, name: "Fix the login", when: "now", count: 3, open: false, windowless: "a turn is running" },
    { id: "20261022-quiet", name: "Quiet", when: "today", count: 1, open: false }] });
  const rows = [...x.doc.querySelectorAll(".session-row")];
  assert.equal(rows.length, 2);
  const mark = rows[0].querySelector(".session-windowless");
  assert.ok(mark);
  assert.equal(mark.textContent, "Running, no window");
  assert.match(mark.title, /a turn is running/);
  assert.equal(rows[1].querySelector(".session-windowless"), null);
  assert.deepEqual(x.errors, []);
});
