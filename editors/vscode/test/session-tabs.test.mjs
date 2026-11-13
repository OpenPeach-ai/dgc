// #3 Sessions home: the side bar lists the project's sessions and each opens in an editor tab of its
// own. These drive the real src/sessionTabs.ts and src/panel.ts, bundled against a stub `vscode` whose
// editor tabs are recorded, with backends that record every command instead of running `dgc serve`.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
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

const world = { panels: [], serializers: [], warnings: [], infos: [], answer: undefined, statusBar: null, workspaceState: new Map(), globalState: new Map(), picked: undefined, pickers: [], onWindow: [], commands: [],
  focus(focused) { globalThis.__DGC_TEST_VSCODE.window.state.focused = focused; for (const listener of [...this.onWindow]) listener({ focused }); } };
function fakePanel(viewType, title) {
  const viewState = new Emitter(), disposed = new Emitter();
  const panel = {
    viewType, title, visible: true, active: true, revealed: 0, disposedCount: 0, icon: undefined,
    // As VS Code's: a disposed panel throws when its icon is set.
    get iconPath() { return this.icon; },
    set iconPath(value) { if (this.disposedCount) throw new Error("Webview is disposed"); this.icon = value; },
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
    file: (p) => ({ fsPath: p, toString: () => `file://${p}` }),
    parse: (value) => ({ scheme: value.split(":")[0], toString: () => value }) },
  EventEmitter: Emitter,
  ViewColumn: { Active: -1, Beside: -2 },
  StatusBarAlignment: { Left: 1 },
  ThemeIcon: class { constructor(id) { this.id = id; } },
  env: { clipboard: { writeText: async () => {} } },
  commands: { executeCommand: async (...args) => { world.commands.push(args); return undefined; } },
  languages: { getDiagnostics: () => [] },
  window: {
    // The window's own focus (13 Nov, "New" means not seen): world.focus(false) is the user in another window or app.
    state: { focused: true },
    onDidChangeWindowState(listener) { world.onWindow.push(listener); return { dispose() {} }; },
    activeTextEditor: undefined, visibleTextEditors: [], tabGroups: { all: [] },
    createWebviewPanel(viewType, title) { const panel = fakePanel(viewType, title); world.panels.push(panel); return panel; },
    registerWebviewPanelSerializer(viewType, serializer) { world.serializers.push({ viewType, serializer }); return { dispose() {} }; },
    createStatusBarItem() { world.statusBar = { text: "", tooltip: "", command: "", shown: 0, show() { this.shown++; }, hide() {}, dispose() {} }; return world.statusBar; },
    createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, dispose() {} }),
    showWarningMessage: async (message) => { world.warnings.push(String(message)); return world.answer; },
    showErrorMessage: async () => undefined,
    showInformationMessage: async (message) => { world.infos.push(String(message)); },
    // VS Code's own folder picker ("Add a folder…"): what was asked, and the folder the test says was picked.
    showOpenDialog: async (options) => { world.pickers.push(options); return world.picked ? [{ fsPath: world.picked }] : undefined; },
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
  globalState: { get: (key) => world.globalState.get(key), async update(key, value) {
    if (value === undefined) world.globalState.delete(key); else world.globalState.set(key, value);
  } },
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
  world.answer = undefined; world.workspaceState.clear(); world.globalState.clear(); world.picked = undefined; world.pickers.length = 0;
  world.commands.length = 0; globalThis.__DGC_TEST_VSCODE.window.state.focused = true;
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

/** What an icon URI draws: the SVG inside a data: URI (nothing to fetch), or "" for a link to a file. */
const drawn = (uri) => {
  const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(String(uri));
  return m ? Buffer.from(m[1], "base64").toString("utf8") : "";
};
const svg = (name) => readFileSync(join(root, "media", name), "utf8");

test("a tab's icon carries its own picture, so a reload draws it before the tab is revived, and after an update: a new session DGC's mark, a saved one its Voxel", async () => {
  const { tabs, made, ctx } = windowWith();
  const kept = new Map(); ctx.globalState = { get: (key) => kept.get(key), async update(key, value) { kept.set(key, value); } };
  tabs.open("");
  const fresh = world.panels[0];
  assert.equal(drawn(fresh.iconPath.light), svg("dgc-tab-light.svg"), "the light mark itself, not a link to it");
  assert.equal(drawn(fresh.iconPath.dark), svg("dgc-tab-dark.svg"), "and the dark one: VS Code still picks by theme");
  // A tab that was behind another when the window reloaded: VS Code revives it only once it is shown.
  const behind = fakePanel("dgc.chatEditor", "Visits");
  behind.visible = false; behind.active = false;
  await tabs.deserializeWebviewPanel(behind, { chatTab: { key: "0123456789abcdef", session: "20261006-101500-a1" } });
  assert.equal(made.at(-1).sessionId(), "20261006-101500-a1");
  // A saved session's tab wears its mark (0.52, src/dock.ts): its Voxel at rest, the PNG of the palette it wears
  // (media/session-icons/), inside the URI as the plain marks are, so nothing is fetched for it either.
  const png = (name) => `data:image/png;base64,${readFileSync(join(root, "media", "session-icons", `${name}.png`)).toString("base64")}`;
  const blob = String(behind.iconPath);
  assert.match(blob, /^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/, "its mark, as a PNG inside the URI");
  // (No palette kept for it yet: the one its id alone gives, which for this id is Saffron.)
  assert.equal(blob, png("voxel-saffron"), "a Work session's is a Voxel, in its palette");
  assert.equal(behind.iconPath.light, undefined, "one picture for both themes: a mark is its own colours");
  assert.doesNotMatch(blob, /media|file:/, "nothing names the extension's folder");
  assert.notEqual(behind.iconPath, fresh.iconPath);
  assert.equal(drawn(fresh.iconPath.light), svg("dgc-tab-light.svg"), "a new session with nothing saved keeps DGC's mark");
  // Its palette was given or chosen (from a list, the dock or its own header): the tab's icon follows.
  kept.set("dgc.sessionPalettes", { "work:20261006-101500-a1": "rose" });
  tabs.changed();
  assert.equal(String(behind.iconPath), png("voxel-rose"), "the palette kept for it");
  // A colour chosen before the marks (one of seven, by number) counts as its palette: 1, purple to pink, is Lilac.
  kept.set("dgc.sessionPalettes", {}); kept.set("dgc.sessionColours", { "work:20261006-101500-a1": 1 });
  tabs.changed();
  assert.equal(String(behind.iconPath), png("voxel-lilac"), "its old colour's palette");
  kept.set("dgc.sessionColours", {});
  tabs.changed();
  assert.equal(String(behind.iconPath), blob, "and with nothing kept, its id's own again");
  // A second copy of the same session closes before it is given anything (setting a disposed panel's icon throws).
  const twin = fakePanel("dgc.chatEditor", "copy");
  await tabs.deserializeWebviewPanel(twin, { chatTab: { key: "fedcba9876543210", session: "20261006-101500-a1" } });
  assert.equal(twin.disposedCount, 1);
  assert.equal(twin.iconPath, undefined);
  // Nothing in it names the extension's folder, which an update replaces (and Remote - SSH fetches over the connection).
  assert.doesNotMatch(String(behind.iconPath.dark), /media|vibedgc|file:/);
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

test("the side bar remembers that its backend offered ChatDGC, so the next window's home shows Chat | Work at once", () => {
  const seen = new Map();
  const ctx = context();
  ctx.globalState = { get: (key) => seen.get(key), async update(key, value) { seen.set(key, value); } };
  const sidebar = new DgcViewProvider(ctx);
  const tabs = new SessionTabs(ctx, sidebar, (init) => quiet(new DgcViewProvider(ctx, init)));
  sidebar.useSessionsHome(tabs);
  const backend = recordingBackend();
  quiet(sidebar, backend);
  sidebar.webviewReady = true;
  sidebar.useChatDGC({ attach() {}, backendReady() {}, onEvent() {}, homeRefresh() {}, backendLost() {} });
  const webview = { cspSource: "vscode-resource:", asWebviewUri: (uri) => uri };
  assert.doesNotMatch(sidebar.html(webview), /data-chatdgc-seen/, "never seen: the tabs wait for the backend");
  sidebar.lastReadyEvent = { type: "ready", capabilities: { chatdgc: { version: 1 } } };
  sidebar.finishSessionHandshake(backend);
  assert.equal(seen.get("dgc.chatdgcSeen.v1"), true);
  assert.match(sidebar.html(webview), /data-chat-place="home" data-chatdgc-seen="1"/);
  sidebar.lastReadyEvent = { type: "ready", capabilities: {} };
  sidebar.finishSessionHandshake(backend);
  assert.equal(seen.get("dgc.chatdgcSeen.v1"), false, "a CLI without ChatDGC: not next time either");
  assert.doesNotMatch(sidebar.html(webview), /data-chatdgc-seen/);
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

test("in a Work tab, Settings stays separate and Pips opens its own editor tab", async () => {
  const { sidebar, tabs, made } = windowWith();
  const opened = [];
  sidebar.openSettings = (section) => { opened.push(["settings", section]); };
  sidebar.openPipsEditor = (navigation) => { opened.push(["pips-tab", navigation]); };
  tabs.open("");
  const [tab] = made;
  await tab.onMessage({ type: "openSettings", section: "general" });
  const navigation = {pip:'pip_'+'a'.repeat(32),section:'chat',run:'run_'+'b'.repeat(32)};
  await tab.onMessage({ type: "openPips", navigation });
  assert.deepEqual(opened, [["settings", "general"], ["pips-tab", navigation]]);
  await tab.onMessage({ type: "openPips", navigation: { overview: true } });
  assert.deepEqual(opened.at(-1), ["pips-tab", { overview: true }], "the home doorway opens the Pip list, not a saved chat");
  await tab.onMessage({ type: "newChat" });
  assert.equal(world.panels.length, 2, "+ in a tab is a new session in a new tab");
  assert.equal(tab.slots.length <= 1, true, "not a second chat inside the tab");
});

// ---- Continue in Work (a ChatDGC chat's folder): a Work session in that folder, in a tab of its own, its brief unsent

const BRIEF = "Continuing from the chat “Uploads”, about this folder. What we worked out there:\n\nMove the upload limit into settings.\n\nCarry on from here.";
/** What a tab's page has been told once it is ready (its webview loads after the tab opens). */
const shown = (provider) => { for (const action of provider.pendingWebviewActions.splice(0)) action(); return provider.posted; };

test("Continue in Work opens a session in the chat's folder, named by it, with the brief in its box and nothing sent", async () => {
  const { sidebar, made } = windowWith();
  const folder = join(scratch, "uploads");
  mkdirSync(folder, { recursive: true });
  assert.equal(await sidebar.continueInWork(folder, BRIEF), true);
  assert.deepEqual(world.warnings, [], "a folder in the window's: nothing to ask");
  assert.equal(world.panels.length, 1);
  assert.equal(world.panels[0].title, "uploads", "named by its folder, not by the brief");
  const [tab] = made;
  assert.equal(tab.activeSlot().cwd, folder, "its chat works in that folder, with a backend of its own there");
  assert.equal(tab.sessionId(), "", "a new session");
  assert.deepEqual(shown(tab).filter((m) => m.type === "composer_text"), [{ type: "composer_text", text: BRIEF }]);
  assert.equal(tab.backend.sent.some((c) => c.type === "prompt"), false, "nothing runs until the person sends it");
  assert.match(world.panels[0].webview.html, new RegExp(`data-tab-cwd="${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`), "kept in the tab's state for a reload");
  tab.retitle("Continuing from the chat");
  assert.equal(world.panels[0].title, "uploads", "its first prompt doesn't rename it");
  assert.equal(await sidebar.continueInWork(folder, "   "), false, "an empty brief opens nothing");
});

test("a folder outside the window's is asked about first, and a reload brings its tab back there without asking again", async () => {
  const outside = mkdtempSync(join(tmpdir(), "dgc-work-elsewhere-"));
  try {
    const { sidebar, tabs, made } = windowWith();
    assert.equal(await sidebar.continueInWork(outside, BRIEF), false, "said no: nothing opens");
    assert.match(world.warnings[0], /Open a DGC chat in .*dgc-work-elsewhere-/);
    assert.equal(world.panels.length, 0);
    world.answer = "Trust it and open";
    assert.equal(await sidebar.continueInWork(outside, BRIEF), true);
    assert.equal(made.at(-1).activeSlot().cwd, outside);
    assert.deepEqual(world.workspaceState.get("dgc.workFolders.v1"), [outside]);

    // The window reloads: VS Code hands the tab back with what its page kept.
    world.warnings.length = 0; world.answer = undefined;
    const again = windowWith();
    const back = fakePanel("dgc.chatEditor", "uploads");
    await again.tabs.deserializeWebviewPanel(back, { chatTab: { key: "0123456789abcdef", session: "", cwd: outside } });
    assert.equal(back.disposedCount, 0);
    assert.equal(again.made.at(-1).activeSlot().cwd, outside, "in its folder, never the window's");
    assert.deepEqual(world.warnings, [], "Continue in Work opened it there: not asked again");
    // A folder this window never opened Work in is asked about; said no, the tab doesn't come back in the wrong folder.
    world.workspaceState.delete("dgc.workFolders.v1");
    const third = windowWith();
    const stray = fakePanel("dgc.chatEditor", "x");
    await third.tabs.deserializeWebviewPanel(stray, { chatTab: { key: "fedcba9876543210", session: "", cwd: outside } });
    assert.equal(world.warnings.length, 1);
    assert.equal(stray.disposedCount, 1);
    assert.equal(third.made.length, 0);
    assert.match(world.infos.at(-1), /wasn't reopened/);
    // Not a full path: the tab comes back in the window's folder, as any tab does.
    const odd = fakePanel("dgc.chatEditor", "y");
    await third.tabs.deserializeWebviewPanel(odd, { chatTab: { key: "00112233445566aa", session: "", cwd: "relative/dir" } });
    assert.equal(third.made.at(-1).activeSlot().cwd, undefined);
    void tabs;
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

// ---- the status bar with no tab open follows the saved default; with nothing saved it says so --------------------------------
const PROVIDER = { id: `provider_${"a".repeat(32)}`, name: "Ollama (local)", base_url: "http://localhost:11434/v1", model: "deepseek-v4.1-flash:cloud", api_mode: "auto" };
function statusScene(values = {}) {
  const saved = new Map(Object.entries(values));
  const sidebar = new DgcViewProvider({ ...context(), globalState: { get: (key, fallback) => (saved.has(key) ? saved.get(key) : fallback), async update(key, value) { saved.set(key, value); } } });
  return { sidebar, saved };
}
test("with no tab open, the status bar is the saved default, not the side bar's old chat", () => {
  const { sidebar, saved } = statusScene({ "dgc.modelProviders.v1": [PROVIDER], "dgc.defaultModelProvider.v1": PROVIDER.id });
  sidebar.lastReadyEvent = { model: "qwen3:8b", capabilities: { model_chosen: false } };
  sidebar.state = { ...sidebar.state, model: "qwen3:8b", think: "off", mode: "default" };
  sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /deepseek-v4\.1-flash:cloud · off · default/);
  saved.set("dgc.modelProviders.v1", [PROVIDER, { id: "subscription_claude", kind: "subscription", engine: "claude", name: "Claude Code", model: "" }]);
  saved.set("dgc.defaultModelProvider.v1", "subscription_claude");
  sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /Claude Code · off · default/, "another default moves it with no reload");
});
test("with nothing saved and nothing chosen it says No provider; an older CLI, or a config's model, keeps its name", () => {
  const { sidebar } = statusScene();
  sidebar.state = { ...sidebar.state, model: "qwen3:8b", think: "off", mode: "default" };
  sidebar.lastReadyEvent = { model: "qwen3:8b", capabilities: { model_chosen: false } };
  sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /No provider · default/);
  assert.doesNotMatch(world.statusBar.text, /qwen3/);
  sidebar.lastReadyEvent = { model: "qwen3:8b", capabilities: { model_chosen: true } };
  sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /qwen3:8b · off · default/, "a terminal's dgc setup chose it");
  sidebar.lastReadyEvent = { model: "qwen3:8b", capabilities: {} };
  sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /qwen3:8b · off · default/, "an older CLI doesn't say");
  sidebar.lastReadyEvent = { model: "qwen3:8b", capabilities: { model_chosen: false } };
  sidebar.state = { ...sidebar.state, model: "picked-with-slash-model" };
  sidebar.paintStatusBar();
  assert.match(world.statusBar.text, /picked-with-slash-model/, "this chat was moved to one");
});

// ---- a reload in the middle of a reply: nothing about the folder grant reaches the chat ----------------------------------------
function chatInTab() {
  const { sidebar, tabs, made } = windowWith();
  tabs.open("a1");
  const [provider] = made;
  provider.posted = [];
  provider.post = (message) => { provider.posted.push(message); };
  return provider;
}
test("an older CLI's refusal of the folder grant mid-queue isn't shown, and the grant is asked again", () => {
  const provider = chatInTab();
  provider.workspaceRootsInFlight = { revision: 1, requestId: "roots-1" };
  provider.workspaceRootsRevision = 1;
  provider.onEvent({ type: "command_rejected", command: "set_workspace_roots", reason: "turn_in_progress",
    request_id: "roots-1", message: "'set_workspace_roots' is unavailable while a turn is running; cancel or wait" });
  assert.equal(provider.posted.some((m) => m.type === "event" && m.event?.type === "command_rejected"), false, "nothing in the chat");
  assert.equal(provider.workspaceRootsInFlight, undefined);
  assert.equal(provider.workspaceRootsDirty, true, "it goes again when this turn ends");
  assert.equal(provider.turnActive, true);
});
test("while the grant waits, the changes row is left alone instead of saying partial scan", async () => {
  const provider = chatInTab();
  provider.backend = recordingBackend();
  provider.workspaceRootsDirty = true;
  provider.posted = [];
  await provider.refreshWorkspaceChanges();
  assert.deepEqual(provider.posted.filter((m) => /changes$/.test(String(m.type))), [], "not 'no files, and a reason'");
  provider.workspaceRootsDirty = false;
  provider.workspaceRootsInFlight = { revision: 1 };
  await provider.refreshWorkspaceChanges();
  assert.deepEqual(provider.posted.filter((m) => /changes$/.test(String(m.type))), []);
});

// ---- Home answers a session's command (11 Nov): the host learns what each tab waits on, and routes the answer ----------
const TWO = [
  { path: "/p/20261006-101500-a1.json", when: "2026-10-06 10:15", preview: "run the tests", count: 4, name: "" },
  { path: "/p/20261006-091200-b2.json", when: "2026-10-06 09:12", preview: "On Visits page", count: 12, name: "Visits" },
];
const ask = (id, more = {}) => ({ type: "permission_request", id, call_id: `call-${id}`, name: "bash", args: { command: "npm test -- --run" }, command: "npm test -- --run",
  summary: "npm test -- --run", diff: null, suggested_rule: "bash(npm test:*)", choices: ["once", "always", "deny"], ...more });
const listed = async (sidebar) => { await sidebar.onMessage({ type: "sessionsList" }); return sidebar.posted.filter((m) => m.type === "sessions_list").at(-1).items; };

test("a session whose tab asks to run a command is listed as waiting, with that command and its request, for Home's card", async () => {
  const { sidebar, tabs, made } = windowWith(TWO);
  tabs.open("20261006-101500-a1"); tabs.open("20261006-091200-b2");
  const [first, second] = made;
  assert.deepEqual((await listed(sidebar)).map((item) => [item.id, item.waiting, item.ask]), [["20261006-101500-a1", undefined, undefined], ["20261006-091200-b2", undefined, undefined]], "nothing waits yet");
  first.onEvent({ type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "run the tests" });
  first.onEvent(ask("perm-1"));
  second.onEvent({ type: "turn_start", turn_id: "t2", kind: "prompt", prompt: "fix it" });
  // A file change has more to read than a card shows: it waits, with nothing for the card to answer.
  second.onEvent(ask("perm-2", { name: "edit", command: null, args: { path: "src/app.js" }, diff: "--- a/src/app.js\n+++ b/src/app.js\n@@\n-a\n+b\n" }));
  const items = await listed(sidebar);
  assert.deepEqual(items.map((item) => [item.id, item.waiting, item.ask]),
    [["20261006-101500-a1", true, { id: "perm-1", command: "npm test -- --run" }], ["20261006-091200-b2", true, undefined]]);
  // Two things waiting in one session, a command over several lines, and one with no Allow once: none is the card's to answer.
  first.onEvent(ask("perm-3"));
  assert.deepEqual((await listed(sidebar))[0].ask, undefined, "two decisions open: the session is where they are answered");
  first.onEvent({ type: "permission_resolved", id: "perm-3", decision: "once" });
  assert.deepEqual((await listed(sidebar))[0].ask, { id: "perm-1", command: "npm test -- --run" });
  first.onEvent({ type: "permission_resolved", id: "perm-1", decision: "once" });
  first.onEvent(ask("perm-4", { command: "npm test &&\nrm -rf build", args: { command: "npm test &&\nrm -rf build" } }));
  assert.deepEqual([(await listed(sidebar))[0].waiting, (await listed(sidebar))[0].ask], [true, undefined], "a command over several lines opens");
  first.onEvent({ type: "permission_resolved", id: "perm-4", decision: "deny" });
  assert.equal((await listed(sidebar))[0].waiting, undefined, "answered in its tab: it waits no more");
  first.onEvent(ask("perm-5"));
  first.onEvent({ type: "turn_end", turn_id: "t1", reason: "cancelled" });
  assert.equal((await listed(sidebar))[0].waiting, undefined, "its turn ended: nothing waits");
});

test("Home's Allow once and Deny reach that session's own process, once, and never as a rule", async () => {
  const { sidebar, tabs, made } = windowWith(TWO);
  tabs.open("20261006-101500-a1"); tabs.open("20261006-091200-b2");
  const [first, second] = made;
  for (const [tab, turn, id] of [[first, "t1", "perm-1"], [second, "t2", "perm-9"]]) { tab.onEvent({ type: "turn_start", turn_id: turn, kind: "prompt", prompt: "go" }); tab.onEvent(ask(id)); }
  const answersOf = (tab) => tab.backend.sent.filter((c) => c.type === "permission_response");
  // A request that is not that session's, a session that is not open, and an answer Home does not give: nothing is sent.
  await sidebar.onMessage({ type: "homeSessionAnswer", session: "20261006-101500-a1", id: "perm-9", decision: "once" });
  await sidebar.onMessage({ type: "homeSessionAnswer", session: "20261006-000000-zz", id: "perm-1", decision: "once" });
  await sidebar.onMessage({ type: "homeSessionAnswer", session: "20261006-101500-a1", id: "perm-1", decision: "always" });
  assert.deepEqual([answersOf(first), answersOf(second)], [[], []]);
  await sidebar.onMessage({ type: "homeSessionAnswer", session: "20261006-101500-a1", id: "perm-1", decision: "once" });
  assert.deepEqual(answersOf(first), [{ type: "permission_response", id: "perm-1", decision: "once" }], "Allow once, to the session that asked");
  assert.deepEqual(answersOf(second), [], "and to no other");
  assert.equal((await listed(sidebar))[0].waiting, undefined, "Home's list says it waits no more");
  // The session's own tab settles its card too, and says where it was answered: the backend sends no word of an
  // answer it was given, so the tab hears it from here.
  assert.deepEqual(first.posted.filter((m) => m.type === "settleCard"), [{ type: "settleCard", id: "perm-1", label: "Allowed once, on Home" }]);
  await sidebar.onMessage({ type: "homeSessionAnswer", session: "20261006-101500-a1", id: "perm-1", decision: "once" });
  assert.equal(answersOf(first).length, 1, "a second answer to the same request sends nothing");
  await sidebar.onMessage({ type: "homeSessionAnswer", session: "20261006-091200-b2", id: "perm-9", decision: "deny" });
  assert.deepEqual(answersOf(second), [{ type: "permission_response", id: "perm-9", decision: "deny" }]);
  assert.deepEqual(second.posted.filter((m) => m.type === "settleCard"), [{ type: "settleCard", id: "perm-9", label: "Denied, on Home" }]);
  // A tab is no Home: the same message from a session's own page answers nothing.
  first.onEvent({ type: "turn_start", turn_id: "t3", kind: "prompt", prompt: "again" }); first.onEvent(ask("perm-7"));
  await second.onMessage({ type: "homeSessionAnswer", session: "20261006-101500-a1", id: "perm-7", decision: "once" });
  assert.equal(answersOf(first).length, 1);
});

// ---- The Project Folder dropdown (0.52, 12 Nov): one shared choice, "All projects" by default ----------------------------
// Kept in the extension's own storage (every window, the side bar and tabs agree; a restart keeps it). All projects asks
// list_sessions {scope: "all"}; a folder asks {scope: "all", folder}. Only where DGC lists folders (session_scopes and
// Pips API 93). Another folder's session opens in a tab here whose backend runs in that folder.
const HOME = homedir();
const GARDEN = join(HOME, "code", "garden"), NOTES = join(HOME, "code", "notes");
const HERE_WS = "ws_" + "d".repeat(32);
const HERE = [{ path: "/p/s1.json", when: "2026-11-10 10:15", preview: "Fix the checkout total", count: 4, name: "Checkout" }];
const everywhereRows = (garden = GARDEN, notes = NOTES) => [
  { path: "/g/g1.json", when: "2026-11-12 09:00", preview: "Water the tomatoes on Fridays", count: 6, name: "", project: garden, project_name: "garden", here: false, folder_exists: true },
  { path: "/p/s1.json", when: "2026-11-10 10:15", preview: "Fix the checkout total", count: 4, name: "Checkout", project: scratch, project_name: "shop", here: true, folder_exists: true },
  { path: "/n/n1.json", when: "2026-11-01 08:00", preview: "Tidy the reading list", count: 2, name: "", project: notes, project_name: "notes", here: false, folder_exists: false },
];
const folderRows = (garden = GARDEN, notes = NOTES) => [
  { folder: garden, name: "garden", here: false, exists: true, sessions: 1, pips: 0, workspace_id: null, updated_at: "2026-11-12T03:30:00.000Z" },
  { folder: scratch, name: "shop", here: true, exists: true, sessions: 1, pips: 2, workspace_id: HERE_WS, updated_at: "2026-11-10T04:45:00.000Z" },
  { folder: notes, name: "notes", here: false, exists: false, sessions: 1, pips: 0, workspace_id: null, updated_at: "2026-11-01T02:30:00.000Z" },
];
const FOLDER_CAPS = { session_paging: true, session_scopes: true, pips_supported: true, pips_enabled: true, pips_api_version: 93 };
/** A provider whose DGC lists every project's sessions and the folders that have any. */
function withFolders(provider, { rows = everywhereRows(), folders = folderRows(), capabilities = FOLDER_CAPS, backend = provider.backend } = {}) {
  const plain = backend.request.bind(backend);
  backend.request = (command) => (command.type === "list_sessions" && command.scope === "all"
    ? (backend.requested.push(command), Promise.resolve({ type: "sessions", items: command.folder ? rows.filter((r) => r.project === command.folder) : rows })) : plain(command));
  provider.lastReadyEvent = { type: "ready", capabilities };
  provider.folderReads = 0;
  provider.readProjectFolders = async () => { provider.folderReads++; return { folders }; };
  return backend;
}
/** A window whose DGC offers the Project Folder dropdown (or, with other `capabilities`, one that doesn't). */
function folderWindow(options = {}) {
  const x = windowWith(HERE);
  const backend = withFolders(x.sidebar, options);
  const lists = () => backend.requested.filter((c) => c.type === "list_sessions").map(({ type, request_id, ...rest }) => rest);
  const listed = () => x.sidebar.posted.filter((m) => m.type === "sessions_list").at(-1);
  return { ...x, backend, lists, listed };
}
const settled = async () => { for (let i = 0; i < 8; i++) await settle(); };
const CHOICE_KEY = "dgc.projectFolder.v1";

test("Project Folder: All projects by default, every project's sessions asked for, each with its folder (the home folder as ~)", async () => {
  const { sidebar, lists, listed } = folderWindow();
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  assert.deepEqual(lists(), [{ scope: "all", limit: 201 }], "All projects: every project's sessions, in one request");
  const all = listed();
  assert.equal(all.folders?.choice, "", "All projects is the default");
  assert.deepEqual(all.folders.rows.map((r) => [r.folder, r.shown, r.name, r.here, r.exists]), [
    [GARDEN, "~/code/garden", "garden", false, true], [scratch, scratch, "shop", true, true], [NOTES, "~/code/notes", "notes", false, false]],
    "the folders that have a session or a Project Pip, newest first, this window's marked, a gone one marked");
  assert.deepEqual(all.items.map((i) => [i.id, i.here !== false, i.project, i.projectPath, i.projectName, i.gone === true]), [
    ["g1", false, "~/code/garden", GARDEN, "garden", false],
    ["s1", true, scratch, scratch, "shop", false],
    ["n1", false, "~/code/notes", NOTES, "notes", true]], "each session says its folder; one whose folder is gone is said");
  assert.equal("folder" in all, false, "no one folder to name above the list");
});

test("Project Folder: a folder chosen is asked for by its path, kept in the extension's storage, and a new window opens on it", async () => {
  const { ctx, sidebar, backend, lists, listed } = folderWindow();
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  backend.requested.length = 0;
  await sidebar.onMessage({ type: "projectFolderChoose", folder: GARDEN }); await settled();
  assert.equal(world.globalState.get(CHOICE_KEY), GARDEN, "kept in the extension's own storage: every window and a restart agree");
  assert.deepEqual(lists(), [{ scope: "all", folder: GARDEN, limit: 201 }], "one folder: that folder's sessions");
  assert.equal(listed().folders.choice, GARDEN);
  assert.deepEqual([listed().folder, listed().folderPath], ["~/code/garden", GARDEN], "its path, once, for the top of the list");
  assert.deepEqual(listed().items.map((i) => i.id), ["g1"]);
  // The search and Load more follow the choice.
  backend.requested.length = 0;
  await sidebar.onMessage({ type: "sessionsSearch", query: "tomatoes" }); await settled();
  assert.deepEqual(lists(), [{ scope: "all", folder: GARDEN, limit: 201, query: "tomatoes" }]);
  await sidebar.onMessage({ type: "sessionsSearch", query: "" }); await settled();
  backend.requested.length = 0;
  await sidebar.onMessage({ type: "sessionsMore" }); await settled();
  assert.deepEqual(lists().at(-1), { scope: "all", folder: GARDEN, limit: 401 });
  // Reopened (a new window, a restart): the same choice, from storage.
  const again = new DgcViewProvider(ctx), tabs = new SessionTabs(ctx, again, (init) => quiet(new DgcViewProvider(ctx, init)));
  again.useSessionsHome(tabs); quiet(again, recordingBackend(HERE)); again.webviewReady = true;
  const second = withFolders(again);
  await again.onMessage({ type: "sessionsList" }); await settled();
  assert.deepEqual(second.requested.filter((c) => c.type === "list_sessions").map(({ type, request_id, ...rest }) => rest), [{ scope: "all", folder: GARDEN, limit: 201 }]);
  // Back to All projects; a folder DGC never listed is not a choice.
  await sidebar.onMessage({ type: "projectFolderChoose", folder: "" }); await settled();
  assert.equal(world.globalState.get(CHOICE_KEY) || "", "");
  assert.deepEqual(lists().at(-1), { scope: "all", limit: 201 });
  await sidebar.onMessage({ type: "projectFolderChoose", folder: "/somewhere/never/listed" }); await settled();
  assert.equal(world.globalState.get(CHOICE_KEY) || "", "", "only All projects or a folder DGC listed");
});

test("Project Folder: an older DGC has no dropdown, and is asked for this project's sessions as before", async () => {
  for (const capabilities of [{ session_paging: true }, { ...FOLDER_CAPS, pips_api_version: 92 }, { ...FOLDER_CAPS, session_scopes: false }]) {
    world.globalState.set(CHOICE_KEY, GARDEN);          // a choice kept by a newer DGC changes nothing here
    const { sidebar, lists, listed } = folderWindow({ capabilities });
    await sidebar.onMessage({ type: "projectFolderChoose", folder: "" });
    await sidebar.onMessage({ type: "sessionsList" }); await settled();
    assert.deepEqual(lists(), [{ limit: 201 }], `no scope and no folder reach a DGC that doesn't know them (${JSON.stringify(capabilities)})`);
    assert.equal("folders" in listed(), false, "no dropdown");
    assert.equal(sidebar.folderReads, 0, "and the folders are never asked for");
    assert.equal(world.globalState.get(CHOICE_KEY), GARDEN, "what was kept stays");
    assert.deepEqual(listed().items.map((i) => ["project" in i, "here" in i]), [[false, false]]);
  }
});

test("Project Folder: a session from another folder opens in a tab here whose backend runs in its own folder, the folder named on the tab", async () => {
  const garden = join(scratch, "garden");
  mkdirSync(garden, { recursive: true });
  const { sidebar, tabs, made, backend } = folderWindow({ rows: everywhereRows(garden), folders: folderRows(garden) });
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  await sidebar.onMessage({ type: "openSessionInEditor", id: "g1", title: "Water the tomatoes on Fridays" }); await settled();
  assert.deepEqual(world.warnings, [], "a folder in the window's: nothing to ask");
  assert.equal(world.panels.length, 1);
  assert.equal(world.panels[0].title, "garden · Water the tomatoes on Fridays", "the tab says the folder, then the session");
  const [tab] = made;
  assert.equal(tab.activeSlot().cwd, garden, "its backend runs in the session's own folder, never the window's");
  assert.equal(tab.sessionId(), "g1", "and resumes that session");
  const html = world.panels[0].webview.html, quoted = garden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, new RegExp(`data-tab-session="g1" data-tab-cwd="${quoted}"`), "both kept in the tab's state, so a reload brings it back there");
  assert.equal(tabs.openSessions().has("g1"), true);
  // Its name, when it has one, follows the folder's; /new keeps the folder on the tab.
  tab.onEvent({ type: "session", session_id: "g1", kind: "resumed", name: "Friday watering" });
  assert.equal(world.panels[0].title, "garden · Friday watering");
  tab.onEvent({ type: "session", session_id: "g9", kind: "new", name: "" });
  assert.equal(world.panels[0].title, "garden");
  tab.onEvent({ type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "Plan the herb bed" });
  assert.equal(world.panels[0].title, "garden · Plan the herb bed");
  // This window's own opens as it always did, in the window's folder.
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  await sidebar.onMessage({ type: "openSessionInEditor", id: "s1", title: "Checkout" }); await settled();
  assert.equal(world.panels.length, 2);
  assert.equal(world.panels[1].title, "Checkout");
  assert.equal(made[1].activeSlot().cwd, undefined);
  // Delete is only for this window's folder's sessions: another folder's deletes nothing and asks nothing.
  await sidebar.onMessage({ type: "deleteSession", id: "n1", title: "Tidy the reading list" });
  assert.equal(backend.requested.some((c) => c.type === "delete_session"), false);
  assert.deepEqual(world.warnings, []);
});

test("Project Folder: another folder outside the window's is asked about first; said no, nothing opens", async () => {
  const outside = mkdtempSync(join(tmpdir(), "dgc-garden-elsewhere-"));
  try {
    const { sidebar, made } = folderWindow({ rows: everywhereRows(outside), folders: folderRows(outside) });
    await sidebar.onMessage({ type: "sessionsList" }); await settled();
    await sidebar.onMessage({ type: "openSessionInEditor", id: "g1", title: "Water the tomatoes" }); await settled();
    assert.match(world.warnings[0], /Open a DGC chat in .*dgc-garden-elsewhere-/);
    assert.equal(world.panels.length, 0, "said no: nothing opens");
    world.answer = "Trust it and open";
    await sidebar.onMessage({ type: "openSessionInEditor", id: "g1", title: "Water the tomatoes" }); await settled();
    assert.equal(world.panels.length, 1);
    assert.equal(made[0].activeSlot().cwd, outside);
    assert.deepEqual(world.workspaceState.get("dgc.workFolders.v1"), [outside], "a reload brings its tab back there without asking again");
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

test("Project Folder: a session whose folder is gone doesn't open, and says why", async () => {
  // n1's folder is said to be gone; g1's was there when listed and isn't now.
  const was = join(scratch, "was-here-a-moment-ago");
  const { sidebar } = folderWindow({ rows: everywhereRows(was), folders: folderRows(was) });
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  for (const id of ["n1", "g1"]) {
    world.infos.length = 0;
    await sidebar.onMessage({ type: "openSessionInEditor", id, title: "x" }); await settled();
    assert.equal(world.panels.length, 0, `${id}: no tab`);
    assert.match(world.infos.at(-1) || "", /^Folder not found: /, `${id}: said in plain words`);
  }
  assert.deepEqual(world.warnings, [], "nothing is asked about a folder that isn't there");
});

test("New Session: in the folder chosen in its dialog; this window's opens as always, another's in a tab running there", async () => {
  const garden = join(scratch, "garden-new");
  mkdirSync(garden, { recursive: true });
  const { sidebar, made } = folderWindow({ rows: everywhereRows(garden), folders: folderRows(garden) });
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  await sidebar.onMessage({ type: "newSessionInEditor", folder: scratch }); await settled();
  assert.deepEqual([world.panels.length, world.panels[0].title, made[0].activeSlot().cwd], [1, "New session", undefined], "this window's folder: a new tab, as always");
  await sidebar.onMessage({ type: "newSessionInEditor", folder: garden }); await settled();
  assert.deepEqual([world.panels.length, world.panels[1].title, made[1].activeSlot().cwd, made[1].sessionId()], [2, "garden-new", garden, ""], "another folder: a new session's tab that runs there, the folder named on it");
  made[1].onEvent({ type: "turn_start", turn_id: "t1", kind: "prompt", prompt: "Plan the herb bed" });
  assert.equal(world.panels[1].title, "garden-new · Plan the herb bed");
  // A folder that is gone, or one that isn't a full path, opens nothing.
  await sidebar.onMessage({ type: "newSessionInEditor", folder: join(scratch, "not-there") }); await settled();
  assert.equal(world.panels.length, 2);
  assert.match(world.infos.at(-1) || "", /^Folder not found: /);
  await sidebar.onMessage({ type: "newSessionInEditor", folder: "relative/path" }); await settled();
  assert.equal(world.panels.length, 2, "never a relative path");
});

test("New Session: Add a folder… is VS Code's own folder picker, and the session opens in the folder picked", async () => {
  const picked = mkdtempSync(join(tmpdir(), "dgc-picked-folder-"));
  try {
    const { sidebar, made } = folderWindow();
    await sidebar.onMessage({ type: "sessionsList" }); await settled();
    await sidebar.onMessage({ type: "newSessionAddFolder" }); await settled();
    assert.equal(world.pickers.length, 1, "the editor's own picker");
    assert.deepEqual([world.pickers[0].canSelectFolders, world.pickers[0].canSelectFiles, world.pickers[0].canSelectMany], [true, false, false], "folders only, one");
    assert.equal(world.panels.length, 0, "closed without a folder: nothing opens");
    world.picked = picked;
    await sidebar.onMessage({ type: "newSessionAddFolder" }); await settled();
    assert.match(world.warnings.at(-1) || "", /Open a DGC chat in .*dgc-picked-folder-/, "a folder outside the window's is asked about first");
    assert.equal(world.panels.length, 0);
    world.answer = "Trust it and open";
    await sidebar.onMessage({ type: "newSessionAddFolder" }); await settled();
    assert.equal(world.panels.length, 1);
    assert.equal(made[0].activeSlot().cwd, picked, "the session runs in the folder picked");
  } finally { rmSync(picked, { recursive: true, force: true }); }
});

test("a tab's session picker follows the Project Folder choice: every project's with its folder, and one opens in its own folder", async () => {
  const garden = join(scratch, "garden-picker");
  mkdirSync(garden, { recursive: true });
  const { tabs, made } = folderWindow();
  tabs.open("");
  const [tab] = made;
  const backend = recordingBackend(HERE);
  quiet(tab, backend); withFolders(tab, { rows: everywhereRows(garden), folders: folderRows(garden) });
  const vs = globalThis.__DGC_TEST_VSCODE.window, kept = vs.createQuickPick;
  const qp = { items: [], selectedItems: [], value: "", busy: false, shown: 0, hidden: 0, onDidTriggerItemButton() {}, onDidAccept(fn) { this.accept = fn; }, onDidHide() {},
    show() { this.shown++; }, hide() { this.hidden++; }, dispose() {} };
  vs.createQuickPick = () => qp;
  try {
    void tab.resume(); await settled();
    assert.equal(qp.shown, 1);
    assert.deepEqual(backend.requested.filter((c) => c.type === "list_sessions").map(({ type, request_id, ...rest }) => rest), [{ scope: "all", limit: 500 }]);
    assert.deepEqual(qp.items.map((i) => [i.label, i.detail, i.buttons?.length]), [
      ["Water the tomatoes on Fridays", garden, undefined], ["Checkout · Fix the checkout total", scratch, 1], ["Tidy the reading list", "Folder not found · ~/code/notes", undefined]],
      "each says its folder; only this window's folder's can be deleted");
    qp.selectedItems = [qp.items[2]]; await qp.accept(); await settled();
    assert.equal(world.panels.length, 1, "a gone folder's session opens nothing");
    assert.match(world.infos.at(-1), /^Folder not found: /);
    qp.selectedItems = [qp.items[0]]; await qp.accept(); await settled();
    assert.equal(world.panels.length, 2);
    assert.equal(world.panels[1].title, "garden-picker · Water the tomatoes on F…", "the folder, then the session (a tab's name is 40 characters at most)");
    assert.equal(made[1].activeSlot().cwd, garden);
    assert.equal(made[1].sessionId(), "g1");
  } finally { vs.createQuickPick = kept; }
});

test("the editor's \"N waiting\" notice counts the Project Pips of the Project Folder choice", async () => {
  const BILLING_WS = "ws_" + "9".repeat(32);
  const folders = [...folderRows(), { folder: join(HOME, "code", "billing"), name: "billing", here: false, exists: true, sessions: 0, pips: 1, workspace_id: BILLING_WS, updated_at: "2026-11-11T03:30:00.000Z" }];
  const asked = [];
  const notice = async (capabilities, choice) => {
    world.globalState.clear(); if (choice) world.globalState.set(CHOICE_KEY, choice);
    const { sidebar } = folderWindow({ folders, capabilities });
    asked.length = 0;
    sidebar.sessionReady = true;
    sidebar.ensurePipsBridge = () => ({ hostRead: async (type, fields) => { asked.push({ type, ...fields }); return type === "get_pip_digest" ? { digest: null } : { total: 0, in_projects: 0 }; } });
    await sidebar.checkPipsAttention(); await settled();
    return asked.find((r) => r.type === "list_pip_attention");
  };
  assert.deepEqual(await notice(FOLDER_CAPS, ""), { type: "list_pip_attention", limit: 1, projects: "all" }, "All projects: every project's");
  assert.deepEqual(await notice(FOLDER_CAPS, join(HOME, "code", "billing")), { type: "list_pip_attention", limit: 1, projects: BILLING_WS }, "one folder: its workspace");
  assert.deepEqual(await notice(FOLDER_CAPS, GARDEN), { type: "list_pip_attention", limit: 1 }, "a folder with no workspace adds nothing");
  assert.deepEqual(await notice({ ...FOLDER_CAPS, pips_api_version: 92 }, ""), { type: "list_pip_attention", limit: 1 }, "an older DGC is asked as before");
});

test("Ask DGC to fix, for a Project Pip of another folder, opens its session in a tab here that runs in the Pip's own folder", async () => {
  const garden = join(scratch, "garden-fix"), GARDEN_WS = "ws_" + "5".repeat(32), PIP = "pip_" + "a".repeat(32), MINE = "pip_" + "b".repeat(32);
  mkdirSync(garden, { recursive: true });
  const folders = folderRows(garden).map((row) => (row.folder === garden ? { ...row, pips: 1, workspace_id: GARDEN_WS } : row));
  const { sidebar, made } = folderWindow({ rows: everywhereRows(garden), folders });
  sidebar.pipWorkspace = async (id) => (id === PIP ? GARDEN_WS : HERE_WS);
  const report = (pip_id) => ({ run_id: "run_" + "1".repeat(32), pip_id, pip_type: "rook", outcome: "findings", name: "Bed checker", kind: "report" });
  await sidebar.onMessage({ type: "pipAskDgc", report: report(PIP), session: "g1" }); await settled();
  assert.equal(world.panels.length, 1);
  assert.equal(made[0].activeSlot().cwd, garden, "the Work session runs in the Pip's own folder, never this window's");
  assert.equal(made[0].sessionId(), "g1", "its owner session");
  assert.match(world.panels[0].title, /^garden-fix/, "the folder named on the tab");
  // (Its page isn't up yet in this harness: what it is to be told waits for it, and is told once it is.)
  for (const told of made[0].pendingWebviewActions.splice(0)) told();
  assert.deepEqual(made[0].posted.filter((m) => m.type === "pipAskDgc").map((m) => m.report.pip_id), [PIP], "and is asked about the run");
  // No owner session: a new Work session, in that folder too.
  await sidebar.onMessage({ type: "pipAskDgc", report: report(PIP), session: "" }); await settled();
  assert.deepEqual([world.panels.length, made[1].activeSlot().cwd, made[1].sessionId()], [2, garden, ""]);
  // This window's own Project Pip: as before, in the window's folder.
  await sidebar.onMessage({ type: "pipAskDgc", report: report(MINE), session: "s1" }); await settled();
  assert.deepEqual([world.panels.length, made[2].activeSlot().cwd, made[2].sessionId()], [3, undefined, "s1"]);
});

test("a Project Pip of another folder reports to a session of its own folder: its picker lists that folder's sessions, never this window's", async () => {
  const garden = join(scratch, "garden-owner"), GARDEN_WS = "ws_" + "5".repeat(32), PIP = "pip_" + "a".repeat(32), MINE = "pip_" + "b".repeat(32);
  mkdirSync(garden, { recursive: true });
  const folders = folderRows(garden).map((row) => (row.folder === garden ? { ...row, pips: 1, workspace_id: GARDEN_WS } : row));
  const { sidebar, backend, lists } = folderWindow({ rows: everywhereRows(garden), folders });
  sidebar.pipWorkspace = async (id) => (id === PIP ? GARDEN_WS : HERE_WS);
  // (Each with when it is from, since 12 Nov night: the picker tells same-titled sessions apart by it.)
  assert.deepEqual(await sidebar.sessionsForPip(PIP), [{ id: "g1", title: "Water the tomatoes on Fridays", when: "2026-11-12 09:00" }], "that folder's sessions, by the titles its list shows");
  assert.deepEqual(lists(), [{ scope: "all", folder: garden, limit: 500 }], "asked for by its folder");
  backend.requested.length = 0;
  assert.deepEqual(await sidebar.sessionsForPip(MINE), [{ id: "s1", title: "Checkout", when: "2026-11-10 10:15" }], "this window's own Pip: this project's sessions, as before");
  assert.deepEqual(lists(), [{}]);
  backend.requested.length = 0;
  assert.deepEqual(await sidebar.sessionsForPip(), [{ id: "s1", title: "Checkout", when: "2026-11-10 10:15" }]);
  // An older DGC is never asked by folder.
  const old = folderWindow({ capabilities: { session_paging: true } });
  old.sidebar.pipWorkspace = async () => GARDEN_WS;
  await old.sidebar.sessionsForPip(PIP);
  assert.deepEqual(old.lists(), [{}]);
});

// ---- a Work session's reply on Home (13 Nov) ----
// The side bar's page used to learn of a reply only by seeing the session listed as running and then not: a turn that
// ended before the first of those lists arrived (a quick reply, a long list, a new session's first turn) was never news.
// Now the tab says so itself when its turn ends, and the side bar's list carries it until it has been seen.
const lastList = async (sidebar) => { await sidebar.onMessage({ type: "sessionsList" }); return sidebar.posted.filter((m) => m.type === "sessions_list").at(-1); };
test("a reply in a tab that is not in front is news on the side bar's list, with the reply's first words; one you are looking at is not", async () => {
  const { sidebar, tabs, made } = windowWith(TWO);
  tabs.open("20261006-101500-a1"); tabs.open("20261006-091200-b2");
  const [first, second] = made, [panelA, panelB] = world.panels;
  panelA.visible = false; panelA.active = false;                 // the second tab is in front of the first
  assert.deepEqual((await lastList(sidebar)).news ?? [], [], "nothing is news yet");
  assert.deepEqual((await lastList(sidebar)).items.map((item) => [item.id, item.watched]), [["20261006-101500-a1", undefined], ["20261006-091200-b2", true]], "the list says which session's tab is in front");
  // Both turns start and end before the side bar lists anything in between: neither was ever listed as running.
  for (const [tab, turn] of [[first, "t1"], [second, "t2"]]) {
    tab.onEvent({ type: "turn_start", turn_id: turn, kind: "prompt", prompt: "why do tide pools matter?" });
    tab.onEvent({ type: "text_delta", text: "Let me look at the notes first." });
    tab.onEvent({ type: "tool_call", id: `call-${turn}`, name: "read", args: { path: "notes.md" } });
    tab.onEvent({ type: "text_delta", text: "Tide pools matter because they are " });
    tab.onEvent({ type: "text_delta", text: "small, rough nurseries." });
    tab.onEvent({ type: "turn_end", turn_id: turn, reason: "completed" });
  }
  const list = await lastList(sidebar);
  assert.deepEqual(list.items.map((item) => item.running), [undefined, undefined], "neither is running now");
  assert.equal(list.news.length, 1, "one reply is news");
  assert.deepEqual([list.news[0].id, list.news[0].preview], ["20261006-101500-a1", "Tide pools matter because they are small, rough nurseries."], "the one nobody was looking at, with the words it ended on");
  assert.ok(Math.abs(list.news[0].at - Date.now()) < 5000, "and when");
  assert.deepEqual((await lastList(sidebar)).news, list.news, "it stays news on every list until it is seen");
  // A turn the user stopped is not a reply.
  panelB.visible = false; panelA.visible = false;
  second.onEvent({ type: "turn_start", turn_id: "t3", kind: "prompt", prompt: "and again" });
  second.onEvent({ type: "text_delta", text: "Starting over" });
  second.onEvent({ type: "turn_end", turn_id: "t3", reason: "cancelled" });
  assert.deepEqual((await lastList(sidebar)).news.map((n) => n.id), ["20261006-101500-a1"], "a stopped turn is not news");
  // Seen: its tab comes to the front.
  panelA.visible = true; panelA.focus(true);
  const seen = await lastList(sidebar);
  assert.deepEqual(seen.news ?? [], [], "its tab in front: no longer news");
  assert.equal(seen.items[0].watched, true);
});

test("news of a reply goes when Home says it was seen, when the session is opened, and when it runs again", async () => {
  const { sidebar, tabs, made } = windowWith(TWO);
  tabs.open("20261006-101500-a1");
  const [first] = made, [panel] = world.panels;
  const reply = (turn) => { first.onEvent({ type: "turn_start", turn_id: turn, kind: "prompt", prompt: "go" }); first.onEvent({ type: "text_delta", text: "Done." }); first.onEvent({ type: "turn_end", turn_id: turn, reason: "completed" }); };
  panel.visible = false;
  reply("t1");
  assert.deepEqual((await lastList(sidebar)).news.map((n) => n.id), ["20261006-101500-a1"]);
  await sidebar.onMessage({ type: "homeSessionSeen", id: "20261006-101500-a1" });
  assert.deepEqual((await lastList(sidebar)).news ?? [], [], "dismissed on Home");
  reply("t2");
  assert.equal((await lastList(sidebar)).news.length, 1, "a later reply is news again");
  await sidebar.onMessage({ type: "openSessionInEditor", id: "20261006-101500-a1", title: "Visits" });
  assert.deepEqual((await lastList(sidebar)).news ?? [], [], "opened from the side bar");
  reply("t3");
  first.onEvent({ type: "turn_start", turn_id: "t4", kind: "prompt", prompt: "more" });
  assert.deepEqual((await lastList(sidebar)).news ?? [], [], "running again: its last reply is no longer the news");
  // Only a session id is taken from the page.
  await sidebar.onMessage({ type: "homeSessionSeen", id: "../../etc/passwd" });
});

// ---- another folder's session pinned to the dock (13 Nov) ----
// On All projects a session of another folder can be pinned. The pin keeps where the session runs (what the host
// itself listed, never what the page said): from the dock it opens here in a tab running in its own folder, also when
// the list no longer shows that folder; a pin whose folder is gone opens nothing and says so.
test("the dock: another folder's session is pinned with its folder as the host listed it, and opens from the dock in a tab running there", async () => {
  const garden = join(scratch, "garden-dock");
  mkdirSync(garden, { recursive: true });
  const { ctx, sidebar, made } = folderWindow({ rows: everywhereRows(garden), folders: folderRows(garden) });
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  // The page names a folder of its own: the pin takes the host's.
  await sidebar.onMessage({ type: "dockToggle", item: { kind: "work", id: "g1", title: "Water the tomatoes on Fridays", ref: { folder: "/etc", folder_name: "etc" } } }); await settled();
  const pinned = sidebar.posted.filter((m) => m.type === "dock").at(-1).pins.find((p) => p.key === "work:g1");
  assert.ok(pinned, "it is pinned");
  assert.deepEqual(pinned.ref, { folder: garden, folder_name: "garden" }, "with the folder it runs in, as the host listed it");
  // This folder's own session: no folder on its pin.
  await sidebar.onMessage({ type: "dockToggle", item: { kind: "work", id: "s1", title: "Checkout", ref: { folder: "/etc" } } }); await settled();
  assert.deepEqual(sidebar.posted.filter((m) => m.type === "dock").at(-1).pins.find((p) => p.key === "work:s1").ref, {}, "this folder's own session keeps none");
  // The list now shows this window's folder only: the pin still knows where its session runs.
  await sidebar.onMessage({ type: "projectFolderChoose", folder: scratch }); await settled();
  await sidebar.onMessage({ type: "dockOpen", key: "work:g1" }); await settled();
  assert.equal(world.panels.length, 1, "one tab");
  assert.match(world.panels[0].title, /^garden-dock · Water the tomatoes/, "named with its folder");
  assert.equal(made[0].activeSlot().cwd, garden, "running in the session's own folder, never the window's");
  assert.equal(made[0].sessionId(), "g1");
});

test("the dock: a pinned session whose folder is gone opens nothing and says so", async () => {
  const garden = join(scratch, "garden-gone");
  mkdirSync(garden, { recursive: true });
  const { sidebar } = folderWindow({ rows: everywhereRows(garden), folders: folderRows(garden) });
  await sidebar.onMessage({ type: "sessionsList" }); await settled();
  await sidebar.onMessage({ type: "dockToggle", item: { kind: "work", id: "g1", title: "Water the tomatoes on Fridays" } }); await settled();
  rmSync(garden, { recursive: true, force: true });
  await sidebar.onMessage({ type: "dockOpen", key: "work:g1" }); await settled();
  assert.equal(world.panels.length, 0, "no tab opens");
  assert.match(world.infos.at(-1) || "", /Folder not found/, "and it says why");
});

// ---- "New" means not seen (13 Nov, after midnight): a tab in front counts as watched only while the window is focused ----
test("a reply into a tab in front of a window that is not focused is news, and is read when the window has the focus again", async () => {
  const { sidebar, tabs, made } = windowWith(TWO);
  tabs.open("20261006-101500-a1");
  const [first] = made, [panel] = world.panels;
  const reply = (turn) => { first.onEvent({ type: "turn_start", turn_id: turn, kind: "prompt", prompt: "go" }); first.onEvent({ type: "text_delta", text: "Done." }); first.onEvent({ type: "turn_end", turn_id: turn, reason: "completed" }); };
  assert.equal(panel.visible, true);
  // Focused, its tab in front: the reply is seen as it arrives.
  reply("t1");
  let list = await lastList(sidebar);
  assert.deepEqual(list.news ?? [], [], "watched as it arrived: never news"); assert.equal(list.items[0].watched, true);
  // The user is in another window: the tab is still in front here, but nobody is looking.
  world.focus(false);
  assert.equal((await lastList(sidebar)).items[0].watched, undefined, "a tab in front of a window that is not focused is not watched");
  reply("t2");
  list = await lastList(sidebar);
  assert.deepEqual(list.news.map((n) => n.id), ["20261006-101500-a1"], "its reply is news");
  assert.deepEqual((await lastList(sidebar)).news.map((n) => n.id), ["20261006-101500-a1"], "and stays news while the window is away");
  // Back: the side bar is told by itself (a list nobody asked for), and the reply is read.
  const before = sidebar.posted.filter((m) => m.type === "sessions_list").length;
  world.focus(true);
  await settle(); await new Promise((done) => setTimeout(done, 350)); await settle();
  const told = sidebar.posted.filter((m) => m.type === "sessions_list");
  assert.ok(told.length > before, "the window's focus coming back sends the list again");
  assert.deepEqual(told.at(-1).news ?? [], [], "read: the user is back on its tab"); assert.equal(told.at(-1).items[0].watched, true);
});

test("Open in new window, from a pinned folder on the dock: only a folder that is pinned opens, as its own window", async () => {
  const { sidebar } = windowWith(TWO);
  const folder = join(scratch, "garden-notes");
  mkdirSync(folder, { recursive: true });
  await sidebar.onMessage({ type: "folderOpenWindow", folder });
  assert.deepEqual(world.commands.filter((c) => c[0] === "vscode.openFolder"), [], "a folder that is not on the dock opens nothing, whatever a page says");
  await sidebar.onMessage({ type: "dockPin", item: { kind: "folder", id: "fgarden1", title: "garden-notes", ref: { folder } } });
  await settle(); await settle();
  await sidebar.onMessage({ type: "folderOpenWindow", folder });
  await settle();
  const opened = world.commands.filter((c) => c[0] === "vscode.openFolder");
  assert.equal(opened.length, 1); assert.equal(opened[0][1].fsPath, folder); assert.deepEqual(opened[0][2], { forceNewWindow: true });
});
