// #3 Sessions home: the side bar lists the project's sessions and each opens in an editor tab of its
// own. These drive the real src/sessionTabs.ts and src/panel.ts, bundled against a stub `vscode` whose
// editor tabs are recorded, with backends that record every command instead of running `dgc serve`.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "dgc-session-tabs-"));

class Emitter {
  constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
  dispose() { this.listeners = []; }
}

const world = { panels: [], serializers: [], warnings: [], infos: [], answer: undefined, statusBar: null, workspaceState: new Map() };
function fakePanel(viewType, title) {
  const viewState = new Emitter(), disposed = new Emitter();
  const panel = {
    viewType, title, visible: true, active: true, revealed: 0, disposedCount: 0, iconPath: undefined,
    webview: { options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (uri) => uri, posted: [],
      postMessage(message) { this.posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage() { return { dispose() {} }; } },
    onDidChangeViewState: viewState.event,
    onDidDispose: disposed.event,
    reveal() { this.revealed++; },
    dispose() { if (this.disposedCount++) return; disposed.fire(); },
    /** The user clicks this tab (true) or another one (false). */
    focus(active) { this.active = active; viewState.fire({ webviewPanel: panel }); },
  };
  return panel;
}
globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...parts) => ({ toString: () => parts.map(String).join("/"), fsPath: parts.map(String).join("/") }),
    file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
  EventEmitter: Emitter,
  ViewColumn: { Active: -1, Beside: -2 },
  StatusBarAlignment: { Left: 1 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  env: { clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async () => undefined },
  languages: { getDiagnostics: () => [] },
  window: {
    activeTextEditor: undefined, visibleTextEditors: [], tabGroups: { all: [] },
    createWebviewPanel(viewType, title) { const panel = fakePanel(viewType, title); world.panels.push(panel); return panel; },
    registerWebviewPanelSerializer(viewType, serializer) { world.serializers.push({ viewType, serializer }); return { dispose() {} }; },
    createStatusBarItem() { world.statusBar = { text: "", tooltip: "", command: "", shown: 0, show() { this.shown++; }, hide() {}, dispose() {} }; return world.statusBar; },
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async (message) => { world.warnings.push(String(message)); return world.answer; },
    showErrorMessage: async () => undefined,
    showInformationMessage: async (message) => { world.infos.push(String(message)); },
  },
  workspace: {
    isTrusted: true, workspaceFile: undefined, workspaceFolders: [{ uri: { fsPath: scratch, toString: () => `file://${scratch}` } }],
    getConfiguration: () => ({ get: (_key, fallback) => fallback, inspect: () => undefined, async update() {} }),
    registerTextDocumentContentProvider: () => ({ dispose() {} }),
    createFileSystemWatcher: () => ({ onDidCreate() {}, onDidChange() {}, onDidDelete() {}, dispose() {} }),
  },
};

const bundle = join(scratch, "tabs.cjs");
await build({
  stdin: { contents: 'export * from "./src/sessionTabs"; export { DgcViewProvider } from "./src/panel";', resolveDir: root, loader: "ts" },
  bundle: true, format: "cjs", platform: "node", target: "node18",
  outfile: bundle, logLevel: "silent",
  plugins: [{ name: "test-vscode", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
    builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({ contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js" }));
  } }],
});
const { SessionTabs, tabTitle, DgcViewProvider } = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_TEST_VSCODE; rmSync(scratch, { recursive: true, force: true }); });

function recordingBackend(sessions = []) {
  return {
    ready: true, handshakeComplete: true, sent: [], requested: [], disposed: "", sessions,
    send(command) { this.sent.push(command); return true; },
    sendSetup(command) { this.sent.push(command); return true; },
    request(command) {
      this.requested.push(command);
      if (command.type === "list_sessions") return Promise.resolve({ type: "sessions", items: this.sessions });
      if (command.type === "delete_session") {
        this.sessions = this.sessions.filter((item) => !item.path.endsWith(`/${command.path}`));
        return Promise.resolve({ type: "sessions", items: this.sessions, deleted: true });
      }
      return Promise.resolve({ type: "ok" });
    },
    completeHandshake() {}, start() {}, editorState() {},
    dispose(cause) { this.disposed = cause || "disposed"; },
  };
}
const context = () => ({
  extension: { packageJSON: JSON.parse(readFileSync(join(root, "package.json"), "utf8")) },
  extensionUri: { fsPath: root, toString: () => root },
  secrets: { async get() {}, async store() {}, async delete() {} },
  subscriptions: [],
  globalState: { get() {}, async update() {} },
  workspaceState: { get: (key) => world.workspaceState.get(key), async update(key, value) {
    if (value === undefined) world.workspaceState.delete(key); else world.workspaceState.set(key, value);
  } },
});
/** A provider that never starts a process: its backend records what it is sent. */
function quiet(provider, backend = recordingBackend()) {
  provider.backend = backend;
  provider.ensureBackend = () => backend;
  provider.scheduleWorkspaceChanges = () => {};
  provider.backendNote = () => {};
  provider.posted = [];
  provider.post = (message) => { provider.posted.push(message); };
  return provider;
}
function windowWith(sessions = []) {
  const ctx = context();
  // In the order activate() does it: the side bar becomes the home before anything starts its backend.
  const sidebar = new DgcViewProvider(ctx);
  const made = [];
  const tabs = new SessionTabs(ctx, sidebar, (init) => { const provider = quiet(new DgcViewProvider(ctx, init)); made.push(provider); return provider; });
  sidebar.useSessionsHome(tabs);
  quiet(sidebar, recordingBackend(sessions));
  sidebar.webviewReady = true;
  return { ctx, sidebar, tabs, made };
}
const settle = () => new Promise((done) => setTimeout(done, 0));

beforeEach(() => {
  world.panels.length = 0; world.serializers.length = 0; world.warnings.length = 0; world.infos.length = 0;
  world.answer = undefined; world.workspaceState.clear();
});

test("a session opens in a tab of its own, and opening it again shows that tab", () => {
  const { tabs } = windowWith();
  const first = tabs.open("20261006-101500-a1", "Visits page alignment");
  assert.equal(world.panels.length, 1);
  assert.equal(world.panels[0].viewType, "dgc.chatEditor");
  assert.equal(world.panels[0].title, "Visits page alignment");
  assert.match(world.panels[0].webview.html, /data-chat-place="tab"/, "the page knows it is a tab");
  assert.equal(tabs.open("20261006-101500-a1", "again"), first, "the same session is the same tab");
  assert.equal(world.panels.length, 1, "no second tab");
  assert.equal(world.panels[0].revealed, 1, "it is brought forward instead");
});

test("New session opens a new tab every time", () => {
  const { tabs } = windowWith();
  tabs.open(""); tabs.open("");
  assert.equal(world.panels.length, 2);
  assert.deepEqual(world.panels.map((panel) => panel.title), ["New session", "New session"]);
  assert.equal(tabs.open("../../etc/passwd"), tabs.current(), "an id that is not a session id opens a new session, never a path");
  assert.equal(world.panels.length, 3);
});

test("a tab opens on its own session, never on the window's remembered chat, and never writes it", () => {
  const { tabs, made } = windowWith();
  world.workspaceState.set("dgc.activeSession.v1", { scope: "anything", id: "the-side-bars-chat", saved: true });
  tabs.open("20261006-101500-a1", "Visits");
  const tab = made[0];
  assert.equal(tab.sessionId(), "20261006-101500-a1", "it is about to resume its own session");
  // Its backend is ready: the window's remembered chat must not replace the tab's own.
  tab.onEvent({ type: "ready", session_id: "fresh", session_name: "", model: "m", mode: "default", think: "off", capabilities: {} });
  assert.equal(tab.sessionRestoreCandidate, "20261006-101500-a1");
  tab.currentSessionId = "20261006-101500-a1"; tab.currentSessionSaved = true;
  tab.rememberSession();
  assert.deepEqual(world.workspaceState.get("dgc.activeSession.v1"), { scope: "anything", id: "the-side-bars-chat", saved: true },
    "the window's remembered chat is the side bar's, untouched by a tab");
});

test("a tab's queued prompts are its own, are kept over a window reload, and go when its tab is closed", async () => {
  const { tabs, made } = windowWith();
  tabs.open("20261006-101500-a1");
  const [tab] = made;
  const key = `dgc.queuedPrompts.v1#${world.panels[0] && tab.tab.key}`;
  tab.unsentPrompts = [{ requestId: "r1", session: "s", text: "later", draft: { text: "later", attachments: [] }, queued: true }];
  tab.persistQueuedPrompts();
  await settle();
  assert.equal(world.workspaceState.has("dgc.queuedPrompts.v1"), false, "the side bar's queue is not written");
  assert.equal(world.workspaceState.get(key)?.items?.[0]?.text, "later", "the tab's own key holds it");
  tabs.dispose();                                     // the window closing: a reload brings it back
  assert.equal(tab.backend.disposed !== "", true, "its backend stops with the window");
  assert.equal(world.workspaceState.has(key), true, "kept for the reload");

  const again = windowWith();
  again.tabs.open("20261006-101500-a1");
  const [reopened] = again.made;
  const reopenedKey = `dgc.queuedPrompts.v1#${reopened.tab.key}`;
  reopened.unsentPrompts = [{ requestId: "r2", session: "s", text: "x", draft: { text: "x", attachments: [] }, queued: true }];
  reopened.persistQueuedPrompts();
  await settle();
  world.panels.at(-1).dispose();                      // the user closes the tab
  await settle();
  assert.equal(reopened.backend.disposed !== "", true, "closing a tab stops its backend");
  assert.equal(world.workspaceState.has(reopenedKey), false, "and forgets what it kept for a reload");
});

test("after a reload a tab comes back on its session, once", async () => {
  const { tabs, made } = windowWith();
  const panel = fakePanel("dgc.chatEditor", "Visits page alignment");
  await tabs.deserializeWebviewPanel(panel, { chatTab: { key: "0123456789abcdef", session: "20261006-101500-a1" }, version: 1 });
  assert.equal(made.length, 1);
  assert.equal(made[0].tab.key, "0123456789abcdef", "its key, so its own workspace state is found again");
  assert.equal(made[0].sessionId(), "20261006-101500-a1");
  const twin = fakePanel("dgc.chatEditor", "copy");
  await tabs.deserializeWebviewPanel(twin, { chatTab: { key: "fedcba9876543210", session: "20261006-101500-a1" } });
  assert.equal(twin.disposedCount, 1, "a second tab on the same session is closed: one session, one tab");
  const junk = fakePanel("dgc.chatEditor", "junk");
  await tabs.deserializeWebviewPanel(junk, { chatTab: { key: "<script>", session: "../x" } });
  assert.match(made.at(-1).tab.key, /^[a-f0-9]{16}$/, "a state that is not a key gets a fresh one");
  assert.equal(made.at(-1).sessionId(), "", "and a session that is not an id is a new session");
});

test("the status bar shows the tab you last worked in, and the side bar's chat once no tab is open", () => {
  const { sidebar, tabs, made } = windowWith();
  sidebar.state = { ...sidebar.state, model: "side-model", mode: "default", think: "off" };
  sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /side-model/);
  tabs.open("a1"); tabs.open("b2");
  const [a, b] = made;
  a.state = { ...a.state, model: "alpha", mode: "plan" };
  b.state = { ...b.state, model: "beta", mode: "auto" };
  world.panels[0].focus(true);
  assert.match(world.statusBar.text, /alpha · off · plan/, "the tab clicked last");
  b.paintStatusBar(); sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /alpha/, "another chat's state change does not take the bar");
  world.panels[1].focus(true);
  assert.match(world.statusBar.text, /beta · off · auto/);
  world.panels[1].dispose();
  assert.match(world.statusBar.text, /alpha/, "closing it hands the bar to the tab before it");
  world.panels[0].dispose();
  assert.match(world.statusBar.text, /side-model/, "and to the side bar once none is open");
});

test("a tab is named by its session's name, else its first prompt", () => {
  const { tabs, made } = windowWith();
  tabs.open("");
  const [tab] = made;
  tab.onEvent({ type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "📷 On Visits page, the My visits section: the search and filters are poorly aligned" });
  assert.equal(world.panels[0].title, "On Visits page, the My visits section:…", "its first prompt, cut to a tab's width");
  tab.onEvent({ type: "turn_start", turn_id: "t2", kind: "prompt", prompt: "and the dates?" });
  assert.equal(world.panels[0].title, "On Visits page, the My visits section:…", "a later prompt does not rename it");
  tab.onEvent({ type: "session_named", name: "Visits alignment" });
  assert.equal(world.panels[0].title, "Visits alignment", "a name wins");
  tab.onEvent({ type: "session", session_id: "after-new", kind: "new", name: "" });
  assert.equal(world.panels[0].title, "New session", "/new in the tab: a new session's tab");
  tab.onEvent({ type: "turn_start", turn_id: "t3", kind: "prompt", prompt: "next task" });
  assert.equal(world.panels[0].title, "next task", "named again by its first prompt");
  assert.equal(tabTitle("   "), "New session");
});

test("a tab remembers only a saved session for a reload", () => {
  const { tabs, made } = windowWith();
  tabs.open("");
  const [tab] = made;
  tab.onEvent({ type: "session", session_id: "new-one", kind: "new", name: "" });
  assert.deepEqual(tab.posted.filter((m) => m.type === "chat_tab").at(-1), { type: "chat_tab", session: "" },
    "a session with no message has no file: a reload would find nothing to resume");
  tab.onEvent({ type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "hello" });
  assert.deepEqual(tab.posted.filter((m) => m.type === "chat_tab").at(-1), { type: "chat_tab", session: "new-one" });
});

test("the Sessions list marks the sessions open in tabs, and one open in a tab cannot be deleted", async () => {
  const items = [
    { path: "/p/20261006-101500-a1.json", when: "2026-10-06 10:15", preview: "ok, so my this directory", count: 84, name: "" },
    { path: "/p/20261006-091200-b2.json", when: "2026-10-06 09:12", preview: "On Visits page", count: 12, name: "Visits" },
    { path: "/p/not a session!.json", when: "", preview: "", count: 0, name: "" },
  ];
  const { sidebar, tabs } = windowWith(items);
  tabs.open("20261006-101500-a1");
  await sidebar.onMessage({ type: "sessionsList" });
  const list = sidebar.posted.filter((m) => m.type === "sessions_list").at(-1);
  assert.deepEqual(list.items.map((item) => [item.id, item.open]), [["20261006-101500-a1", true], ["20261006-091200-b2", false]],
    "each session by id, the open one marked; a file whose name is not a session id is left out");
  assert.equal(list.items[1].name, "Visits");

  await sidebar.onMessage({ type: "deleteSession", id: "20261006-101500-a1", title: "ok" });
  assert.equal(sidebar.backend.requested.some((c) => c.type === "delete_session"), false, "nothing is deleted under an open tab");
  assert.match(world.infos.at(-1), /open in a tab/);

  world.answer = undefined;                         // the user dismisses the confirmation
  await sidebar.onMessage({ type: "deleteSession", id: "20261006-091200-b2", title: "Visits" });
  assert.equal(sidebar.backend.requested.some((c) => c.type === "delete_session"), false, "dismissed: nothing is deleted");
  assert.match(world.warnings.at(-1), /Delete the session “Visits”\?.*can't be undone/);
  world.answer = "Delete";
  await sidebar.onMessage({ type: "deleteSession", id: "20261006-091200-b2", title: "Visits" });
  assert.deepEqual(sidebar.backend.requested.filter((c) => c.type === "delete_session").map((c) => c.path), ["20261006-091200-b2.json"]);
  assert.deepEqual(sidebar.posted.filter((m) => m.type === "sessions_list").at(-1).items.map((item) => item.id), ["20261006-101500-a1"],
    "the list shows what is left");
});

test("the side bar's own chat starts empty, and its messages open sessions in tabs", async () => {
  const { sidebar, tabs } = windowWith();
  world.workspaceState.set("dgc.activeSession.v1", { scope: sidebar.draftScope(), id: "remembered", saved: true });
  assert.equal(sidebar.sessionRestoreCandidate, "", "the remembered session opens from the list, in a tab, not in the hidden side-bar chat");
  assert.equal(sidebar.sessionRestoreSuppressed, true);
  await sidebar.onMessage({ type: "openSessionInEditor", id: "20261006-091200-b2", title: "Visits" });
  await sidebar.onMessage({ type: "openSessionInEditor", id: "../../x", title: "bad" });
  await sidebar.onMessage({ type: "newSessionInEditor" });
  await sidebar.onMessage({ type: "newChat" });
  assert.deepEqual(world.panels.map((panel) => panel.title), ["Visits", "New session", "New session"]);
  assert.equal(tabs.openSessions().has("20261006-091200-b2"), true);
});

test("in a tab, Settings and the Pips open the side bar's, and + opens another tab", async () => {
  const { sidebar, tabs, made } = windowWith();
  const opened = [];
  sidebar.openSettings = (section) => { opened.push(["settings", section]); };
  sidebar.openPips = () => { opened.push(["pips"]); };
  tabs.open("");
  const [tab] = made;
  await tab.onMessage({ type: "openSettings", section: "general" });
  await tab.onMessage({ type: "openPips" });
  assert.deepEqual(opened, [["settings", "general"], ["pips"]]);
  await tab.onMessage({ type: "newChat" });
  assert.equal(world.panels.length, 2, "+ in a tab is a new session in a new tab");
  assert.equal(tab.slots.length <= 1, true, "not a second chat inside the tab");
});
