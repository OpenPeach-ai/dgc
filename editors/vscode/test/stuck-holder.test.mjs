// A DGC that holds a session and has stopped answering, the editor's half (src/stuckHolder.ts, src/panel.ts,
// src/settingsClient.js, media/main.js). Seen 13 Nov: "This session is open in another window" → Open here → the same
// again, because the process holding it could not be asked and nothing showed it.
//
// * Settings › Running sessions: a process whose liveness is "stuck" has a row of its own that says "Not responding
//   since 12:00" (its note's heartbeat) with Stop and no Open, whether or not its note still says it has a window.
// * A read-only chat whose holder is stuck: the bar names who holds it in plain words ("Held by a DGC with no window,
//   since 11:53, running a turn.") and offers "Stop it and open here": stop_live_session for that process, and only
//   when it has stopped, Open here. A holder that answers keeps the plain Open here, and nothing is stopped.
// * Nothing new on the wire: only list_live_sessions' rows as they are, and stop_live_session.
process.env.TZ = "UTC";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { makeDom } from "./support/webview-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), "dgc-vscode-stuck-holder-"));
const bundle = join(scratch, "stuck-holder.cjs");
// The peers folder this editor reads a stuck process's heartbeat from (DGC's own home, as DGC_HOME names it).
const dgcHome = join(scratch, "dgc-home");
mkdirSync(join(dgcHome, "peers"), { recursive: true });
const HOME_BEFORE = process.env.DGC_HOME;
process.env.DGC_HOME = dgcHome;

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
               export * as stuck from "./stuckHolder";`,
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
const { DgcViewProvider, DGC_PROTOCOL_VERSION, stuck } = createRequire(import.meta.url)(bundle);

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
  if (HOME_BEFORE === undefined) delete process.env.DGC_HOME; else process.env.DGC_HOME = HOME_BEFORE;
  rmSync(scratch, { recursive: true, force: true });
});

const SESSION = "20260930-050447-c62af3b6";
const DETACH = { version: 1, idle_exit_s: 120, waiting_exit_s: 3600, max_windowless_s: 43200 };
// 13 Nov 2026, 13:10:00 UTC: the moment the pictures and these tests stand at.
const NOW = Date.UTC(2026, 10, 13, 13, 10, 0);
const at = (h, m, s = 0) => Date.UTC(2026, 10, 13, h, m, s);
const HOLDER_PID = 2142044, INSTANCE = "ab12cd34";
/** list_live_sessions' row for the process of 13 Nov: a `dgc serve` with no window since 11:53, its turn never ended. */
const stuckRow = (more = {}) => ({ pid: HOLDER_PID, kind: "serve", instance: INSTANCE, version: "0.51.0", attached: false, detachable: true,
  windowless_s: Math.round((NOW - at(11, 53, 29)) / 1000), uptime_s: Math.round((NOW - at(9, 2)) / 1000), work: "running the nightly audit",
  status: "working", liveness: "stuck", here: false, scope: "", chats: [],
  sessions: [{ session_id: SESSION, name: "toni_fabrics audit", cwd: "/home/me/toni_fabrics", status: "working" }], ...more });
const hereRow = { pid: 77, kind: "serve", instance: "ee", version: "0.52.0", attached: true, detachable: true, windowless_s: 0, uptime_s: 60,
  work: "", status: "idle", liveness: "live", here: true, scope: "", chats: [], sessions: [] };
const heartbeat = (pid, ms) => writeFileSync(join(dgcHome, "peers", `${pid}.json`), JSON.stringify({ pid, kind: "serve", heartbeat: ms / 1000 }));

/**
 * A fake `dgc serve`: ready with `caps`; answers resume_session, session_holder (`holder`), list_live_sessions
 * (`rows`) and stop_live_session (the rows again with `stopped` as its message). Every command it gets goes to its log
 * with the time, so a test can say what was sent and in which order across two of them.
 */
function fakeServe(name, { caps = {}, holder = { found: false }, rows = [], stopped = "Stopped: sent SIGKILL" } = {}) {
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
    note({ cmd, at: Date.now() });
    if (cmd.type === "shutdown") process.exit(0);
    if (cmd.type === "set_workspace_roots") send({ type: "workspace_roots", roots: [], request_id: cmd.request_id });
    if (cmd.type === "resume_session") send({ type: "session", kind: "resumed", message_count: 1, session_id: ${JSON.stringify(SESSION)}, request_id: cmd.request_id });
    if (cmd.type === "session_holder") send({ type: "session_holder", request_id: cmd.request_id, session_id: cmd.session_id, ...${JSON.stringify(holder)} });
    if (cmd.type === "list_live_sessions") send({ type: "live_sessions", request_id: cmd.request_id, items: ${JSON.stringify(rows)} });
    if (cmd.type === "stop_live_session") setTimeout(() => send({ type: "live_sessions", request_id: cmd.request_id, items: [], message: ${JSON.stringify(stopped)} }), 120);
    if (cmd.type === "prompt" && String(cmd.text || "").startsWith("emit ")) send(JSON.parse(cmd.text.slice(5)));
  }
});
process.stdin.on("end", () => setTimeout(() => process.exit(0), 200));
`, "utf8");
  chmodSync(path, 0o700);
  const read = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
  return { path, rows: read, commands: () => read().map((row) => row.cmd), types: () => read().map((row) => row.cmd.type) };
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
    extension: { packageJSON: { version: "0.35.0", dgcCliVersion: "0.0.1" } },
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
const HELD = { found: true, editor: "", windowless: true, folder: "~/toni_fabrics", working: true };
const CAPS = { detach: { ...DETACH, elsewhere: { session_id: SESSION, pid: HOLDER_PID, reason: "busy" } }, session_holder: 1, session_owner: 1 };

// ---- the words ---------------------------------------------------------------------------------------------------

test("the words: who holds it, since when, and that it stopped answering; a part nobody said is left out", () => {
  assert.equal(stuck.clock(at(12, 0, 13)), "12:00");
  assert.equal(stuck.clock(at(9, 5)), "09:05");
  assert.equal(stuck.clock(0), "");
  assert.equal(stuck.clock(NaN), "");
  assert.equal(stuck.notResponding(at(12, 0, 13)), "Not responding since 12:00");
  assert.equal(stuck.notResponding(0), "Not responding", "no heartbeat to read: no time is made up");
  const facts = { place: "a DGC with no window", since: at(11, 53, 29), working: true, heartbeat: at(12, 0, 13) };
  assert.deepEqual(stuck.stuckLine(facts), {
    head: "Held by a DGC with no window, since 11:53, running a turn.",
    detail: "It stopped answering at 12:00, so Open here can't take it. Stop it and open here ends it and opens the session in this window as it was last saved." });
  assert.equal(stuck.stuckLine({ ...facts, working: false, since: 0 }).head, "Held by a DGC with no window.");
  assert.match(stuck.stuckLine({ ...facts, heartbeat: 0 }).detail, /^It has stopped answering, so Open here can't take it\./);
});

test("the holder of a session among list_live_sessions' rows: only a stuck one, never this window's own process", () => {
  heartbeat(HOLDER_PID, at(12, 0, 13));
  const found = stuck.stuckHolder([hereRow, stuckRow()], SESSION, NOW);
  assert.deepEqual(found, { pid: HOLDER_PID, instance: INSTANCE,
    facts: { place: "a DGC with no window", since: at(11, 53, 29) - (at(11, 53, 29) % 1000), working: true, heartbeat: at(12, 0, 13) } });
  assert.equal(stuck.stuckHolder([hereRow, stuckRow({ liveness: "live" })], SESSION, NOW), undefined, "one that answers is asked, not stopped");
  assert.equal(stuck.stuckHolder([stuckRow({ here: true })], SESSION, NOW), undefined);
  assert.equal(stuck.stuckHolder([stuckRow()], "20261113-000000-other", NOW), undefined, "another session's holder");
  assert.equal(stuck.stuckHolder([stuckRow({ pid: "1; rm" })], SESSION, NOW), undefined, "a row that isn't one");
  // Where it runs, in plain words, from what its row says.
  const place = (more) => stuck.stuckHolder([stuckRow(more)], SESSION, NOW).facts.place;
  assert.equal(place({ attached: true, windowless_s: 0 }), "a DGC in an editor window");
  assert.equal(place({ kind: "tui", attached: true, windowless_s: 0 }), "a DGC in a terminal");
  // No heartbeat on disk (another home, a note that can't be read): the row is still found, with no time.
  rmSync(join(dgcHome, "peers", `${HOLDER_PID}.json`));
  assert.equal(stuck.stuckHolder([stuckRow()], SESSION, NOW).facts.heartbeat, 0);
  writeFileSync(join(dgcHome, "peers", `${HOLDER_PID}.json`), "{ not json");
  assert.equal(stuck.stuckHolder([stuckRow()], SESSION, NOW).facts.heartbeat, 0);
});

// ---- Settings › Running sessions: what the host hands the page ---------------------------------------------------------

test("Running sessions lists a stuck process, with a window or not, with its heartbeat; a live one is as before", () => {
  heartbeat(HOLDER_PID, at(12, 0, 13));
  const { provider } = tab();
  const rows = provider.runningRows([hereRow, stuckRow()]);
  assert.equal(rows.length, 1);
  assert.deepEqual({ pid: rows[0].pid, instance: rows[0].instance, session: rows[0].session, name: rows[0].name, stuck: rows[0].stuck, since: rows[0].since },
    { pid: HOLDER_PID, instance: INSTANCE, session: SESSION, name: "toni_fabrics audit", stuck: true, since: at(12, 0, 13) });
  // Its note froze while it still had a window (the 13 Nov process never wrote that the window went): still listed.
  const attached = provider.runningRows([stuckRow({ attached: true, detachable: false, windowless_s: 0 })]);
  assert.equal(attached.length, 1);
  assert.equal(attached[0].stuck, true);
  // One that holds no session is one row, so it can be stopped.
  const empty = provider.runningRows([stuckRow({ sessions: [] })]);
  assert.deepEqual([empty.length, empty[0].stuck, empty[0].session], [1, true, ""]);
  // A live one with no window is the row it always was; a live one with a window is not listed.
  const live = provider.runningRows([stuckRow({ liveness: "live" })]);
  assert.deepEqual([live.length, live[0].stuck], [1, undefined]);
  assert.deepEqual(provider.runningRows([stuckRow({ liveness: "live", attached: true })]), []);
});

// ---- the panel: Open here that can't take it --------------------------------------------------------------------------

test("a stuck holder: the bar names it and offers Stop it and open here, which stops it and then opens the session here", async () => {
  heartbeat(HOLDER_PID, at(12, 0, 13));
  const fixture = fakeServe("serve-stuck", { caps: CAPS, holder: HELD, rows: [hereRow, stuckRow()] });
  command = fixture.path;
  const h = tab();
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => bars(h.posted).some((m) => m.stuck)), "the bar learned its holder is stuck");
  const bar = bars(h.posted).at(-1);
  assert.equal(bar.state, "elsewhere");
  assert.equal(bar.stop, true, "Stop it and open here is offered");
  assert.equal(bar.stuck.place, "a DGC with no window");
  assert.equal(bar.stuck.working, true);
  assert.equal(bar.stuck.heartbeat, at(12, 0, 13));
  // (Since when: the row's "no window for N seconds", counted back from now. The words' own test says 11:53 for 13 Nov.)
  assert.ok(Math.abs(bar.stuck.since - (Date.now() - stuckRow().windowless_s * 1000)) < 20000, "since its window went");
  assert.equal(fixture.types().includes("stop_live_session"), false, "nothing is stopped until the person says");
  // The click: the stop the Running sessions page sends, to that process, and only then Open here.
  const taker = fakeServe("serve-stuck-taken", { caps: { detach: DETACH, session_holder: 1, session_owner: 1 } });
  command = taker.path;
  await h.provider.onMessage({ type: "stopAndOpenHere" });
  assert.ok(await until(() => fixture.types().includes("stop_live_session")), "the stop was sent");
  const stop = fixture.commands().find((c) => c.type === "stop_live_session");
  assert.deepEqual({ pid: stop.pid, instance: stop.instance }, { pid: HOLDER_PID, instance: INSTANCE });
  assert.equal(bars(h.posted).at(-1).stopping, true, "the bar says it is stopping it");
  assert.equal(taker.rows().length, 0, "nothing is opened before the stop is answered");
  assert.ok(await until(() => taker.rows().length > 0), "then this window opens the session");
  spawned.push(h.provider.backend?.childPid);
  assert.ok(await until(() => h.provider.sessionReady && bars(h.posted).at(-1).state === "none"), "this window's now");
  assert.equal(h.provider.sessionElsewhere, undefined);
  const stoppedAt = fixture.rows().find((row) => row.cmd.type === "stop_live_session").at;
  assert.ok(taker.rows()[0].at >= stoppedAt + 100, "open came after the stop was answered, not beside it");
  h.provider.backend?.dispose("restart: test");
});

test("a stuck holder that could not be stopped: the session stays read-only and the bar says why", async () => {
  heartbeat(HOLDER_PID, at(12, 0, 13));
  const fixture = fakeServe("serve-stuck-kept", { caps: CAPS, holder: HELD, rows: [stuckRow()],
    stopped: "Not stopped: this computer cannot confirm that process is still the DGC that left the note" });
  command = fixture.path;
  const h = tab();
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => bars(h.posted).some((m) => m.stop)));
  await h.provider.onMessage({ type: "stopAndOpenHere" });
  assert.ok(await until(() => bars(h.posted).some((m) => m.stopNote)), "the bar says it was not stopped");
  const bar = bars(h.posted).at(-1);
  assert.equal(bar.state, "elsewhere");
  assert.equal(bar.stopping, undefined);
  assert.match(bar.stopNote, /^It was not stopped: this computer cannot confirm/);
  assert.equal(h.provider.backend, be, "this chat kept its backend: nothing was reopened");
  be.dispose("restart: test");
});

test("a holder that answers keeps the plain Open here: no stop is offered and none is sent", async () => {
  const live = { found: true, editor: "Cursor", windowless: false, folder: "~/toni_fabrics", working: false, idle_s: 380 };
  const fixture = fakeServe("serve-live", { caps: CAPS, holder: live, rows: [hereRow, stuckRow({ liveness: "live", attached: true, windowless_s: 0 })] });
  command = fixture.path;
  const h = tab();
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => bars(h.posted).some((m) => m.note)), "the usual line");
  assert.ok(await until(() => fixture.types().includes("list_live_sessions")), "the rows were read");
  await pause(200);
  const bar = bars(h.posted).at(-1);
  assert.deepEqual(bar.note, { head: "Open in Cursor · ~/toni_fabrics · idle 6 min.", detail: "" });
  assert.equal(bar.stop, undefined);
  assert.equal(bar.stuck, undefined);
  // A stray click (a page that lost track) stops nothing.
  await h.provider.onMessage({ type: "stopAndOpenHere" });
  await pause(200);
  assert.equal(fixture.types().includes("stop_live_session"), false);
  // Open here is the Open here it always was.
  const taker = fakeServe("serve-live-taken", { caps: { detach: DETACH, session_holder: 1, session_owner: 1 } });
  command = taker.path;
  await h.provider.onMessage({ type: "openSessionHere" });
  spawned.push(h.provider.backend?.childPid);
  assert.ok(await until(() => h.provider.sessionReady && bars(h.posted).at(-1).state === "none"));
  assert.equal(fixture.types().includes("stop_live_session"), false);
  h.provider.backend?.dispose("restart: test");
});

test("an older CLI (no list of processes) is never asked for one; the bar is as it was", async () => {
  const fixture = fakeServe("serve-old", { caps: { session_holder: 1, session_owner: 1 }, holder: HELD, rows: [stuckRow()] });
  command = fixture.path;
  const h = tab();
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  be.send({ type: "prompt", text: `emit ${JSON.stringify({ type: "session_held", session_id: SESSION })}` });
  assert.ok(await until(() => bars(h.posted).some((m) => m.note)));
  await pause(250);
  assert.equal(fixture.types().includes("list_live_sessions"), false);
  assert.equal(bars(h.posted).at(-1).stop, undefined);
  be.dispose("restart: test");
});

// ---- the webview: the bar ---------------------------------------------------------------------------------------------

test("the webview: the refusal line and Stop it and open here; a live holder keeps Open here", () => {
  const x = makeDom();
  x.send({ type: "event", event: { type: "ready", capabilities: {} } });
  x.send({ type: "session_ready", sessionId: SESSION });
  const text = () => x.doc.getElementById("elsewhere-text"), open = () => x.doc.getElementById("elsewhere-open"), stop = () => x.doc.getElementById("elsewhere-stop");
  // A live holder: Open here, and no stop.
  x.send({ type: "session_elsewhere", state: "elsewhere", note: { head: "Open in Cursor · ~/shop-api · idle 6 min.", detail: "" } });
  assert.equal(open().hidden, false);
  assert.equal(stop().hidden, true);
  // A stuck one: who holds it, in bold, why Open here can't, and the one button that can.
  const facts = { place: "a DGC with no window", since: at(11, 53, 29), working: true, heartbeat: at(12, 0, 13) };
  x.send({ type: "session_elsewhere", state: "elsewhere", stuck: facts, stop: true });
  assert.equal(text().querySelector("strong.elsewhere-where").textContent, "Held by a DGC with no window, since 11:53, running a turn.");
  assert.equal(text().textContent, "Held by a DGC with no window, since 11:53, running a turn. It stopped answering at 12:00, so Open here can't take it. "
    + "Stop it and open here ends it and opens the session in this window as it was last saved.");
  assert.equal(stop().hidden, false);
  assert.equal(stop().textContent, "Stop it and open here");
  assert.equal(open().hidden, true, "the Open here that can't work is not offered beside it");
  assert.equal(x.doc.getElementById("input").getAttribute("contenteditable"), "false", "still read-only");
  stop().click();
  assert.deepEqual(x.posted.filter((m) => /openSessionHere|stopAndOpenHere/.test(m.type)).map((m) => m.type), ["stopAndOpenHere"]);
  assert.equal(stop().disabled, true, "one click");
  // While it stops; then, not stopped: the reason, and the button again.
  x.send({ type: "session_elsewhere", state: "elsewhere", stuck: facts, stop: true, stopping: true });
  assert.equal(stop().disabled, true);
  assert.equal(stop().textContent, "Stopping…");
  x.send({ type: "session_elsewhere", state: "elsewhere", stuck: facts, stop: true, stopNote: "It was not stopped: it is still finishing." });
  assert.equal(stop().disabled, false);
  assert.equal(stop().textContent, "Stop it and open here");
  assert.match(text().textContent, /It was not stopped: it is still finishing\.$/);
  // Taken: the bar goes, and so does the button.
  x.send({ type: "session_elsewhere", state: "none" });
  assert.equal(x.doc.getElementById("elsewhere-bar").hidden, true);
  // Text only, whatever arrives.
  x.send({ type: "session_elsewhere", state: "elsewhere", stuck: { ...facts, place: "<img src=x onerror=alert(1)>" }, stop: true });
  assert.equal(text().querySelector("img"), null);
  assert.deepEqual(x.errors, []);
});

// ---- Settings › Running sessions, on the real page in Chromium -----------------------------------------------------

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

test("Settings › Running sessions: the stuck row says Not responding since 12:00, with Stop and no Open", async (t) => {
  if (skipOrFail(t)) return;
  const { openRunning } = await import("./support/settings-scene.mjs");
  const live = { pid: 4242, instance: "c0ffee", session: "20261113-101500-a1", name: "Fix the narrow settings layout", cwd: "/home/me/notes-app", windowless_s: 400, working: true, work: "running the tests", version: "0.52.0" };
  const held = { pid: HOLDER_PID, instance: INSTANCE, session: SESSION, name: "toni_fabrics audit", cwd: "/home/me/toni_fabrics", windowless_s: 4600, working: true,
    work: "running the nightly audit", version: "0.51.0", stuck: true, since: at(12, 0, 13) };
  for (const width of [300, 700]) {
    const x = await openRunning(browser, { items: [live, held], width });
    const rows = await x.rows();
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0].buttons, ["Open", "Stop"], "a live one is as it was");
    assert.equal(rows[1].title, "toni_fabrics audit");
    assert.equal(rows[1].summary, "Not responding since 12:00 · /home/me/toni_fabrics", `the row's own line says so, first (${width})`);
    assert.equal(rows[1].summaryCut, false, `and those words are never cut off (${width})`);
    assert.match(rows[1].description, /^It stopped answering while it worked/);
    assert.deepEqual(rows[1].buttons, ["Stop"], "Open can't take it, so only Stop");
    assert.equal(rows[1].stuck, true);
    // The row keeps the page's look: same card, same line box, the same button.
    assert.equal(rows[1].buttonRadius, rows[0].buttonRadius);
    assert.equal(rows[1].buttonHeight, rows[0].buttonHeight);
    assert.equal(rows[1].left, rows[0].left);
    assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `nothing runs off the page (${width})`);
    // Stop: the page's own stop, for that process.
    await x.page.click(`[data-running-stop="${HOLDER_PID}:${SESSION}"]`);
    assert.deepEqual((await x.posted("stopRunning")).at(-1), { type: "stopRunning", pid: HOLDER_PID, instance: INSTANCE });
    assert.equal((await x.rows())[1].buttons[0], "Stopping…");
    assert.deepEqual(x.errors, []);
    await x.close();
  }
  // No heartbeat to read: no time is made up.
  const x = await openRunning(browser, { items: [{ ...held, since: 0 }], width: 700 });
  assert.equal((await x.rows())[0].summary, "Not responding · /home/me/toni_fabrics");
  await x.close();
});

test("the host sends the page's Stop for a stuck process whose note names no instance (a DGC in a terminal)", async () => {
  const fixture = fakeServe("serve-settings-stop", { caps: { detach: DETACH }, rows: [stuckRow({ kind: "tui", instance: "" })] });
  command = fixture.path;
  const h = tab();
  const be = h.provider.ensureBackend();
  spawned.push(be.childPid);
  assert.ok(await until(() => h.provider.sessionReady));
  h.provider.settingsEditor = { webview: { postMessage: async () => true } };
  await h.provider.onSettingsMessage({ type: "stopRunning", pid: HOLDER_PID, instance: "" });
  assert.ok(await until(() => fixture.types().includes("stop_live_session")), "the stop was sent");
  assert.deepEqual(fixture.commands().filter((c) => c.type === "stop_live_session").map((c) => [c.pid, c.instance]), [[HOLDER_PID, ""]]);
  // Still never anything that isn't a process and its instance.
  await h.provider.onSettingsMessage({ type: "stopRunning", pid: HOLDER_PID, instance: "../x" });
  await pause(150);
  assert.equal(fixture.types().filter((t) => t === "stop_live_session").length, 1);
  be.dispose("restart: test");
});
