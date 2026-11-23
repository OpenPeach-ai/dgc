// ChatDGC in the editor (src/chatdgc.ts): a chat per editor tab and the home's Chat list, riding on the side
// bar's dgc serve. Drives the real module, bundled against a stub `vscode`, with a host that records every
// command instead of running a backend. What it checks: each event reaches only the tabs (or the home) it
// belongs to, nothing waits forever for a process that is starting, an older CLI says so, and a tab sends
// only what the protocol accepts.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "dgc-chatdgc-tabs-"));

class Emitter {
  constructor() { this.listeners = []; this.event = (listener) => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(value) { for (const listener of [...this.listeners]) listener(value); }
}

const world = { panels: [], serializers: [], warnings: [], answer: undefined, picks: [], pick: undefined, input: undefined, opened: [], clipboard: "",
                chosen: undefined, sizes: {}, infos: [], saveTo: undefined, saveAsked: undefined, errors: [], tabs: [], changes: new Emitter() };
function fakePanel(viewType, title) {
  const disposed = new Emitter(), received = new Emitter(), viewState = new Emitter();
  const panel = {
    viewType, title, revealed: 0, disposedCount: 0, icon: undefined,
    // In front in its editor group, as a tab just opened is; focus(active) is the user clicking this tab or another.
    visible: true, active: true, onDidChangeViewState: viewState.event,
    focus(active) { this.active = active; viewState.fire({ webviewPanel: panel }); },
    // As VS Code's: a disposed panel throws when its icon is set.
    get iconPath() { return this.icon; },
    set iconPath(value) { if (this.disposedCount) throw new Error("Webview is disposed"); this.icon = value; },
    webview: { options: {}, html: "", cspSource: "vscode-resource:", asWebviewUri: (uri) => uri, posted: [],
      postMessage(message) { this.posted.push(message); return Promise.resolve(true); },
      onDidReceiveMessage: received.event },
    onDidDispose: disposed.event,
    reveal() { this.revealed++; },
    dispose() { if (this.disposedCount++) return; disposed.fire(); },
    /** The tab's page posts this. */
    say(message) { received.fire(message); },
    last(type) { return [...this.webview.posted].reverse().find((m) => m.type === type); },
  };
  return panel;
}
class TabInputText { constructor(uri) { this.uri = uri; } }
class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
globalThis.__DGC_TEST_VSCODE = {
  TabInputText, TabInputCustom,
  EventEmitter: Emitter,
  Disposable: { from: (...items) => ({ dispose() { for (const i of items) i?.dispose?.(); } }) },
  Uri: { joinPath: (...parts) => ({ toString: () => parts.map((p) => String(p?.toString?.() ?? p)).join("/"),
                                     fsPath: parts.map((p) => String(p?.fsPath ?? p?.toString?.() ?? p)).join("/") }),
    file: (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => `file://${p}` }),
    parse: (value) => {
      const file = /^file:\/\/(\/.*)$/.exec(value);
      return file ? { scheme: "file", path: file[1], fsPath: decodeURIComponent(file[1]), toString: () => value, value }
                  : { scheme: value.split(":")[0], path: "", fsPath: "", toString: () => value, value };
    } },
  FileType: { File: 1, Directory: 2 },
  ViewColumn: { Active: -1, Beside: -2 },
  Range: class { constructor(start, end) { this.start = start; this.end = end; } },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } },
  commands: { executeCommand: async (...args) => { world.commands.push(args); } },
  ConfigurationTarget: { Global: 3 },
  QuickPickItemKind: { Separator: -1 },
  env: { clipboard: { writeText: async (text) => { world.clipboard = text; } }, openExternal: async (uri) => { world.opened.push(uri.toString()); return true; } },
  window: {
    // The window's own focus (13 Nov, "New" means not seen).
    state: { focused: true },
    onDidChangeWindowState(listener) { (world.onWindow ||= []).push(listener); return { dispose() {} }; },
    createWebviewPanel(viewType, title, show, options) { const panel = Object.assign(fakePanel(viewType, title), { show, options }); world.panels.push(panel); return panel; },
    registerWebviewPanelSerializer(viewType, serializer) { world.serializers.push({ viewType, serializer }); return { dispose() {} }; },
    showWarningMessage: async (message) => { world.warnings.push(String(message)); return world.answer; },
    showQuickPick: async (items) => {
      if (typeof world.choose === "function") return world.choose(items);
      world.picks.push(items.map((i) => i.id));
      const want = Array.isArray(world.pick) ? world.pick.shift() : world.pick;     // a list: one answer per question
      return items.find((i) => i.id === want);
    },
    showErrorMessage: async (message) => { world.errors.push(String(message)); return undefined; },
    showInputBox: async () => world.input,
    // The question a tab closed mid-reply asks (closingTab.ts): world.quickPick is what the user does, in order.
    createQuickPick: () => {
      const handlers = { accept: [], hide: [] };
      const pick = { items: [], activeItems: [], selectedItems: [], title: "", placeholder: "", ignoreFocusOut: false,
        onDidAccept: (fn) => handlers.accept.push(fn), onDidHide: (fn) => handlers.hide.push(fn),
        show() {
          const steps = (world.quickPick || ["keep"]).slice();
          setTimeout(() => {
            for (const step of steps) {
              if (step === "hide") { handlers.hide.forEach((fn) => fn()); return; }
              pick.selectedItems = [pick.items.find((item) => item.id === step)];
              handlers.accept.forEach((fn) => fn());
            }
          }, 5);
        },
        hide() { handlers.hide.forEach((fn) => fn()); }, dispose() {} };
      world.quickPicks.push(pick);
      return pick;
    },
    showOpenDialog: async () => world.chosen,
    showSaveDialog: async (options) => { world.saveAsked = options; return world.saveTo; },
    showInformationMessage: async (message) => { world.infos.push(String(message)); return undefined; },
    showTextDocument: async (uri, options) => { world.shown.push({ path: uri.fsPath, options }); },
    get visibleTextEditors() { return world.visible; },
    get activeTextEditor() { return world.active; },
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    registerCustomEditorProvider: (viewType, provider) => { world.customEditors = { viewType, provider }; return { dispose() {} }; },
    // One editor group, its tabs world.tabs (the last one in front).
    tabGroups: {
      get all() { const group = { viewColumn: 1, tabs: world.tabs, get activeTab() { return world.tabs.at(-1); } }; for (const t of world.tabs) t.group = group; return [group]; },
      get activeTabGroup() { return this.all[0]; },
      onDidChangeTabs: () => ({ dispose() {} }), onDidChangeTabGroups: () => ({ dispose() {} }),
      close: async (tab) => { world.tabs = world.tabs.filter((t) => t !== tab); return true; },
    },
  },
  workspace: {
    get textDocuments() { return world.docs; },
    // A range's ends are offsets (the fake documents' positionAt is the identity); changes are announced as VS Code does.
    applyEdit: async (edit) => {
      for (const e of edit.edits) {
        const doc = world.docs.find((d) => d.uri.fsPath === e.uri.fsPath);
        if (!doc) continue;
        doc.text = doc.text.slice(0, e.range.start) + e.text + doc.text.slice(e.range.end);
        doc.isDirty = true;
        world.changes.fire({ document: doc, contentChanges: [e] });
      }
      return true;
    },
    onDidChangeTextDocument: (listener) => world.changes.event(listener),
    getConfiguration: () => ({
      get: (key, fallback) => (key === "linkFavicons" && world.favicons !== undefined ? world.favicons
        : key === "closingAWorkingTab" && world.closingSetting !== undefined ? world.closingSetting : fallback),
      async update(key, value, target) { world.updates.push({ key, value, target }); if (key === "closingAWorkingTab") world.closingSetting = value; } }),
    fs: { writeFile: async (uri, bytes) => { world.written.push({ path: uri.fsPath ?? String(uri), bytes: Buffer.from(bytes) }); },
      createDirectory: async () => undefined,
      stat: async (uri) => {
    if (world.dirs?.includes(uri.fsPath)) return { size: 0, type: 2 };
    if (world.missing?.includes(uri.fsPath)) throw new Error("ENOENT");
    return { size: world.sizes[uri.fsPath] ?? 1, type: 1 };
  },
      // (A file a download reads: a real one, as the process wrote it into its private folder.)
      readFile: async (uri) => readFileSync(uri.fsPath) } },
};

const bundle = join(scratch, "chatdgc.cjs");
await build({
  entryPoints: [join(root, "src/chatdgc.ts")], bundle: true, format: "cjs", platform: "node", target: "node18",
  outfile: bundle, logLevel: "silent",
  plugins: [{ name: "test-vscode", setup(builder) {
    builder.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "test" }));
    builder.onLoad({ filter: /^vscode$/, namespace: "test" }, () => ({ contents: "module.exports = globalThis.__DGC_TEST_VSCODE;", loader: "js" }));
  } }],
});
const { ChatDGC, chatTitle, CHATDGC_EDITOR, CHATDGC_LIBRARY, CHATDGC_WIDGET, widgetDocument, isChatdgcEvent } = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_TEST_VSCODE; rmSync(scratch, { recursive: true, force: true }); });

const ID = (n) => `chat_${String(n).repeat(32).slice(0, 32)}`;
const MSG = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`;
let chat, host, sent;
beforeEach(() => {
  Object.assign(world, { panels: [], serializers: [], warnings: [], answer: undefined, picks: [], pick: undefined, input: undefined, opened: [], clipboard: "",
                         chosen: undefined, sizes: {}, infos: [], saveTo: undefined, saveAsked: undefined, errors: [],
                         shown: [], visible: [], active: undefined, docs: [], commands: [], choose: undefined, written: [], tabs: [],
                         quickPicks: [], quickPick: undefined, closingSetting: undefined, updates: [] });
  sent = [];
  host = { outcome: "sent", home: [], models: { ids: ["qwen3:32b", "fixture"], current: "fixture" }, offers: { version: 1 },
    chatdgcOffers() { return this.offers; },
    windows: [], chatdgcSetWindow(preset) { this.windows.push(preset); },
    chatdgcSend(cmd) { if (this.outcome === "sent") sent.push(cmd); return this.outcome; },
    async chatdgcModels() { return this.models; },
    postHome(message) { this.home.push(message); } };
  // The last test's chats let go first: a list refresh it left timed (250 ms) must not land in this test's commands.
  chat?.dispose();
  chat = new ChatDGC({ extensionUri: "ext" });
  chat.attach(host);
});
const last = (type) => [...sent].reverse().find((c) => c.type === type);
const opened = (panel, conversation, extra = {}) => {
  const ask = last("chatdgc_open");
  chat.onEvent({ type: "chatdgc_opened", request_id: ask.request_id, conversation, messages: [], earlier: 0, busy: false, ...extra });
};

test("a new chat opens in an editor tab of its own, named by its chat", async () => {
  chat.open("");
  const [panel] = world.panels;
  assert.equal(panel.viewType, CHATDGC_EDITOR);
  assert.match(panel.webview.html, /Content-Security-Policy[^>]*default-src 'none'/);
  assert.match(panel.webview.html, /media\/chatdgc\.js/);
  panel.say({ type: "ready" });
  const ask = last("chatdgc_open");
  assert.equal(ask.conversation_id, undefined, "a new one");
  assert.match(ask.request_id, /^cd-open-\d+$/);
  opened(panel, { id: ID(1), title: "New chat", temporary: false });
  assert.equal(panel.title, "New chat");
  assert.equal(panel.last("opened").conversation.id, ID(1));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(panel.last("models"), { type: "models", ids: ["qwen3:32b", "fixture"], current: "fixture" });
  chat.onEvent({ type: "chatdgc_changed", conversation_id: ID(1), summary: { id: ID(1), title: "Plan a week in Goa with my family and two dogs" } });
  assert.equal(panel.title, "Plan a week in Goa with my family and t…", "its title, cut to fit a tab as a session tab is");
  assert.equal(chatTitle(""), "New chat");
});

test("one conversation, one tab: opening it again brings its tab forward", () => {
  chat.open(ID(2));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.equal(last("chatdgc_open").conversation_id, ID(2));
  opened(panel, { id: ID(2), title: "Goa" });
  chat.open(ID(2));
  assert.equal(world.panels.length, 1);
  assert.equal(panel.revealed, 1);
  chat.open("not-an-id");
  assert.equal(world.panels.length, 2, "anything that isn't a chat id is a new chat");
});

test("each event reaches only the tabs showing its chat; an error goes to whoever asked", () => {
  chat.open(ID(3)); chat.open(ID(4));
  const [a, b] = world.panels;
  a.say({ type: "ready" }); opened(a, { id: ID(3), title: "A" });
  b.say({ type: "ready" }); opened(b, { id: ID(4), title: "B" });
  a.say({ type: "send", text: "Hello", model: "qwen3:32b", thinking: "high" });
  const send = last("chatdgc_send");
  assert.deepEqual({ ...send, request_id: "" }, { type: "chatdgc_send", conversation_id: ID(3), text: "Hello", model: "qwen3:32b", thinking: "high", request_id: "" });
  b.say({ type: "send", text: "Teach me", study: true });
  assert.equal(last("chatdgc_send").study, true, "study mode goes with the message");
  b.say({ type: "send", text: "Teach me", study: "yes" });
  assert.equal(last("chatdgc_send").study, undefined, "only true or false");
  chat.onEvent({ type: "chatdgc_turn", conversation_id: ID(3), state: "started", reply_id: MSG(1), request_id: send.request_id });
  chat.onEvent({ type: "chatdgc_delta", conversation_id: ID(3), message_id: MSG(1), text: "Hi " });
  chat.onEvent({ type: "chatdgc_message", conversation_id: ID(3), message: { id: MSG(1), role: "assistant", text: "Hi there" } });
  assert.deepEqual(a.webview.posted.filter((m) => ["turn", "delta", "message"].includes(m.type)).map((m) => m.type), ["turn", "delta", "message"]);
  assert.deepEqual(b.webview.posted.filter((m) => ["turn", "delta", "message"].includes(m.type)), [], "another chat's tab hears none of it");
  b.say({ type: "send", text: "Again" });
  chat.onEvent({ type: "chatdgc_error", request_id: last("chatdgc_send").request_id, conversation_id: ID(4), message: "This chat is still answering." });
  assert.equal(b.last("error").message, "This chat is still answering.");
  assert.equal(a.last("error"), undefined);
});

test("a tab sends only what the protocol accepts", () => {
  chat.open(ID(5));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(5), title: "x" });
  const before = sent.length;
  panel.say({ type: "send", text: "   " });
  panel.say({ type: "send", text: "x".repeat(1_000_001) });
  panel.say({ type: "continue", messageId: "../../etc" });
  panel.say({ type: "earlier", before: 7 });
  assert.equal(sent.length, before, "nothing the backend would refuse");
  panel.say({ type: "send", text: "ok", thinking: "ultra", model: "m".repeat(201) });
  assert.deepEqual(Object.keys(last("chatdgc_send")).sort(), ["conversation_id", "request_id", "text", "type"], "no ultra, no oversized model");
  panel.say({ type: "continue", messageId: MSG(2) });
  assert.equal(last("chatdgc_continue").message_id, MSG(2));
  panel.say({ type: "stop" });
  assert.deepEqual(last("chatdgc_cancel"), { type: "chatdgc_cancel", conversation_id: ID(5) });
});

test("commands wait for a process that is starting, and an older CLI says so", async () => {
  host.outcome = "starting";
  host.models = { ids: [], current: "" };              // too early: nothing known yet
  chat.open("");
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.equal(sent.length, 0);
  host.outcome = "sent";
  host.models = { ids: ["qwen3:32b", "fixture"], current: "fixture" };
  chat.backendReady();
  // (The home's refresh asks for the archived chats too, before its list, since Archive's list came to the Chat page.)
  assert.deepEqual(sent.map((c) => [c.type, c.archived === true]), [["chatdgc_open", false], ["chatdgc_projects", false], ["chatdgc_list", true], ["chatdgc_list", false], ["chatdgc_projects", false]],
                   "the tab's held commands sent once it was ready, each once; then the home's lists, asked afresh");
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(panel.last("models"), { type: "models", ids: ["qwen3:32b", "fixture"], current: "fixture" },
                   "a tab opened before the backend was ready gets its models then, so the picker shows the model");
  host.outcome = "old_cli";
  chat.open("");
  world.panels[1].say({ type: "ready" });
  assert.match(world.panels[1].last("unavailable").message, /newer DGC CLI/);
  chat.homeRefresh();
  assert.deepEqual(host.home.at(-1), { type: "chatdgc_list", available: false });
});

test("a restart stops the reply on screen, and a chat that is gone opens as a new one", () => {
  chat.open(ID(6));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  chat.onEvent({ type: "chatdgc_error", request_id: last("chatdgc_open").request_id, message: "That chat doesn't exist." });
  assert.equal(panel.last("error").opening, true, "the page asks for a new one");
  panel.say({ type: "reopenNew" });
  assert.equal(last("chatdgc_open").conversation_id, undefined);
  chat.backendLost();
  assert.match(panel.last("lost").message, /restarted/);
});

test("the home's Chat list: a few, then more; search; delete asks first", async () => {
  chat.homeRefresh();
  const ask = last("chatdgc_list");
  assert.equal(ask.limit, 6);
  chat.open(ID(7));
  world.panels[0].say({ type: "ready" }); opened(world.panels[0], { id: ID(7), title: "Open one" });
  chat.onEvent({ type: "chatdgc_chats", request_id: ask.request_id, total: 9, next_offset: 6,
    chats: [{ id: ID(7), title: "Open one" }, { id: "../x", title: "bad" }, { id: ID(8), title: "Other" }] });
  const list = host.home.at(-1);
  assert.equal(list.available, true);
  assert.deepEqual(list.items.map((i) => i.id), [ID(7), ID(8)], "only real chat ids");
  assert.deepEqual(list.open, [ID(7)], "which are open in a tab");
  assert.equal(list.more, true);
  await chat.homeMessage({ type: "chatdgcSearch", query: "goa" });
  assert.deepEqual([last("chatdgc_list").query, last("chatdgc_list").limit], ["goa", 50]);
  await chat.homeMessage({ type: "chatdgcMore" });
  assert.equal(last("chatdgc_list").limit, 100);
  world.answer = undefined;
  await chat.homeMessage({ type: "chatdgcDelete", id: ID(7), title: "Open one" });
  assert.equal(last("chatdgc_update"), undefined, "not without a yes");
  world.answer = "Delete";
  await chat.homeMessage({ type: "chatdgcDelete", id: ID(7), title: "Open one" });
  assert.deepEqual({ ...last("chatdgc_update"), request_id: "" }, { type: "chatdgc_update", conversation_id: ID(7), delete: true, request_id: "" });
  assert.equal(world.panels[0].disposedCount, 1, "its tab closes");
  assert.equal(await chat.homeMessage({ type: "somethingElse" }), false);
});

test("links open only on the web; copy goes to the clipboard", async () => {
  chat.open("");
  const [panel] = world.panels;
  for (const target of ["file:///etc/passwd", "command:workbench.action.terminal.new", "javascript:alert(1)", "https://example.com/a b"]) {
    panel.say({ type: "openLink", target });
  }
  panel.say({ type: "openLink", target: "https://example.com/docs?q=1" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(world.opened, ["https://example.com/docs?q=1"]);
  panel.say({ type: "copy", text: "Paris is the capital." });
  await new Promise((r) => setImmediate(r));
  assert.equal(world.clipboard, "Paris is the capital.");
});

test("writing blocks: an edit goes to the backend as words; Open in mail app is a mailto link with its fields", async () => {
  chat.open(ID(5));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(5), title: "Notice" });
  panel.say({ type: "draftEdit", messageId: MSG(2), original: "Subject: Hi\n\nHello", text: "Subject: Hi\n\nHello there" });
  const sent = last("chatdgc_draft");
  assert.deepEqual({ ...sent, request_id: "" }, { type: "chatdgc_draft", conversation_id: ID(5), message_id: MSG(2),
                                                  original: "Subject: Hi\n\nHello", text: "Subject: Hi\n\nHello there", request_id: "" });
  panel.say({ type: "draftEdit", messageId: "msg_nope", original: "a", text: "b" });
  panel.say({ type: "draftEdit", messageId: MSG(2), original: "a", text: "  " });
  assert.equal(last("chatdgc_draft").request_id, sent.request_id, "only a reply's draft, and never emptied");
  panel.say({ type: "openMail", to: "rao@example.com, anya@example.com", cc: "", subject: "Moving out & deposit",
              body: "Dear Mr Rao,\n\nI'm leaving." });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(world.opened, ["mailto:rao@example.com,anya@example.com?subject=Moving%20out%20%26%20deposit"
    + "&body=Dear%20Mr%20Rao%2C%0D%0A%0D%0AI'm%20leaving."], "fields as RFC 6068 has them: CRLF line breaks");
  world.opened.length = 0;
  panel.say({ type: "openMail", to: "rao@example.com", subject: "Long", body: "word ".repeat(600) });
  await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r));
  assert.deepEqual(world.opened, ["mailto:rao@example.com?subject=Long"], "too long for a link: the body isn't in it");
  assert.equal(world.clipboard, "word ".repeat(600), "it's on the clipboard instead");
  assert.match(world.infos.at(-1), /on your clipboard: paste it/);
});

const CV = `cv_${"1".repeat(16)}`;
const canvasFile = (chatId, name = "Plan.md") => `/home/u/.dgc/chat/canvas/${chatId}/${CV}/${name}`;
const doc = (path, text, dirty = false) => ({ uri: { fsPath: path, path }, text, isDirty: dirty, saved: 0,
  getText(range) { return range?.picked ?? this.text; }, async save() { this.saved++; this.isDirty = false; return true; },
  positionAt: (n) => n, lineAt: (line) => ({ range: { picked: `line ${line}` } }) });
const tick = () => new Promise((r) => setImmediate(r));

const formattedOpens = () => world.commands.filter((c) => c[0] === "vscode.openWith" && c[2] === "dgc.chatdgcCanvasDoc");

test("canvas: a reply's canvas opens beside the chat; a change goes in as an edit and is saved; never a file elsewhere", async () => {
  chat.register();
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "Trip" });
  const path = canvasFile(ID(7));
  const view = { id: CV, title: "Plan", kind: "document", language: "markdown", version: 1, path, op: "created", text: "# Plan" };
  chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(2), canvas: view });
  await tick();
  assert.deepEqual(formattedOpens().map((c) => [c[1].fsPath, c[3]]), [[path, { viewColumn: -2, preserveFocus: true, preview: false }]],
                   "a document opens formatted (Canvas option B), beside the chat, which keeps focus");
  assert.deepEqual(world.shown, [], "not in the Markdown editor");
  assert.deepEqual(panel.last("canvas"), { type: "canvas", messageId: MSG(2), canvas: { id: CV, title: "Plan", kind: "document",
                                                                                    language: "markdown", version: 1, op: "created" } });
  const open = doc(path, "# Plan");
  world.docs = [open]; world.tabs = [{ input: new TabInputCustom({ fsPath: path }, "dgc.chatdgcCanvasDoc") }];
  chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(4), canvas: { ...view, version: 2, op: "edited", text: "# Plan\n\nMore" } });
  await tick(); await tick();
  assert.equal(open.text, "# Plan\n\nMore", "the reply's change, as an edit of the open document");
  assert.equal(open.saved, 1);
  assert.equal(formattedOpens().length, 1, "already in view: not opened again");
  open.isDirty = true;
  chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(6), canvas: { ...view, version: 3, text: "Other" } });
  await tick();
  assert.equal(open.text, "# Plan\n\nMore", "your unsaved typing is never overwritten");
  assert.match(world.warnings.at(-1), /while you were typing in it/);
  for (const elsewhere of [canvasFile(ID(8)), "/etc/passwd", `/home/u/.dgc/chat/canvas/${ID(7)}/${CV}/../../x.md`,
                           `/home/u/.dgc/chat/canvas/${ID(7)}/${CV}/../../../../etc/canvas/${ID(7)}/${CV}/passwd`]) {
    chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(8), canvas: { ...view, path: elsewhere, text: undefined } });
  }
  await tick();
  assert.equal(formattedOpens().length + world.shown.length, 1, "only this chat's own canvas files");
  // Switched to Markdown, it stays Markdown when the next change lands; a code canvas opens in the code editor.
  world.tabs = [{ input: new TabInputText({ fsPath: path }) }, { input: { viewType: "x" } }];
  chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(10), canvas: { ...view, text: undefined } });
  await tick();
  assert.deepEqual(world.shown.map((s) => [s.path, s.options.viewColumn]), [[path, 1]], "shown again in its Markdown tab");
  const code = canvasFile(ID(7), "app.py");
  chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(12), canvas: { ...view, kind: "code", path: code, text: undefined } });
  await tick();
  assert.equal(world.shown.at(-1).path, code);
  assert.equal(formattedOpens().length, 1);
});

test("canvas: Ask ChatDGC about a selection sends from the chat's tab, saved first; sends forward only a real selection", async () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "Trip" });
  const file = doc(canvasFile(ID(7)), "x", true);
  world.docs = [file];
  world.active = { document: file, selection: { isEmpty: false, start: { line: 2 }, end: { line: 3, character: 5 }, active: { line: 3 }, picked: "Beach\nFort" } };
  world.input = "Make it livelier";
  await chat.canvasAsk();
  assert.equal(file.saved, 1, "what you typed is what the model reads");
  assert.deepEqual(panel.last("sendFromEditor"), { type: "sendFromEditor", text: "Make it livelier",
    canvasSelection: { canvas_id: CV, start_line: 3, end_line: 4, text: "Beach\nFort" } });
  const selection = { canvas_id: CV, start_line: 3, end_line: 4, text: "Beach\nFort" };
  panel.say({ type: "send", text: "Make it livelier", canvas_selection: selection });
  await tick();
  assert.deepEqual(last("chatdgc_send").canvas_selection, selection);
  panel.say({ type: "send", text: "x", canvas_selection: { ...selection, canvas_id: "../x" } });
  await tick();
  assert.equal(last("chatdgc_send").canvas_selection, undefined);
  world.active = { document: doc("/home/u/notes.md", "x"), selection: world.active.selection };
  await chat.canvasAsk();
  assert.match(world.infos.at(-1), /Open a ChatDGC canvas first/, "not a canvas: says so");
});

test("canvas, formatted: typing goes in as the part that changed and saves on a pause; Ask carries its lines; the model's change reaches the page", async () => {
  chat.register();
  chat.open(ID(7));
  const [chatPanel] = world.panels;
  chatPanel.say({ type: "ready" }); opened(chatPanel, { id: ID(7), title: "Trip" });
  const path = canvasFile(ID(7));
  const file = doc(path, "# Plan\n\nDay one.\n");
  world.docs = [file];
  const page = fakePanel("dgc.chatdgcCanvasDoc", "Plan.md");
  page.active = true; page.viewColumn = 2; page.onDidChangeViewState = () => ({ dispose() {} });
  await world.customEditors.provider.resolveCustomTextEditor(file, page);
  assert.match(page.webview.html, /dist\/canvas\.js/);
  assert.equal(page.webview.options.enableScripts, true);
  page.say({ type: "ready" });
  assert.deepEqual(page.last("doc"), { type: "doc", text: "# Plan\n\nDay one.\n", external: false });
  page.say({ type: "edit", text: "# Plan\n\nDay one, by the sea.\n" });
  await tick();
  assert.equal(file.text, "# Plan\n\nDay one, by the sea.\n");
  assert.equal(page.webview.posted.filter((m) => m.type === "doc").length, 1, "its own typing isn't sent back");
  assert.equal(file.saved, 0, "saved once you pause, not on every key");
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(file.saved, 1);
  // The model's change (as chatdgc.ts applies it) reaches the page, to show and flash.
  await globalThis.__DGC_TEST_VSCODE.workspace.applyEdit({ edits: [{ uri: file.uri, range: { start: 0, end: file.text.length }, text: "# Plan\n\nDay one.\n\nDay two.\n" }] });
  assert.deepEqual(page.last("doc"), { type: "doc", text: "# Plan\n\nDay one.\n\nDay two.\n", external: true });
  // Ask from the page: what to ask, then it goes from the chat's tab with the lines it covers.
  world.input = "Make it livelier";
  page.say({ type: "ask", text: "Day two.", start_line: 5, end_line: 5 });
  await tick(); await tick();
  assert.deepEqual(chatPanel.last("sendFromEditor"), { type: "sendFromEditor", text: "Make it livelier",
    canvasSelection: { canvas_id: CV, start_line: 5, end_line: 5, text: "Day two." } });
  page.say({ type: "ask", text: "x", start_line: 0, end_line: 1 });
  await tick();
  assert.equal(chatPanel.webview.posted.filter((m) => m.type === "sendFromEditor").length, 1, "never lines that aren't there");
  // The page's words without their Markdown aren't in the file: the model gets the lines as the file has them.
  file.text = "# Plan\n\n**For** eight years, Bangalore was home.\n";
  page.say({ type: "ask", text: "For eight years, Bangalore was home.", start_line: 3, end_line: 3 });
  await tick(); await tick();
  assert.equal(chatPanel.last("sendFromEditor").canvasSelection.text, "**For** eight years, Bangalore was home.");
  // The title bar's Ask, formatted: the page is asked for its selection.
  world.tabs = [{ input: new TabInputCustom({ fsPath: path }, "dgc.chatdgcCanvasDoc") }];
  await chat.canvasAsk();
  assert.deepEqual(page.last("askSelection"), { type: "askSelection" });
  // As Markdown: the same file in the text editor, where it was.
  page.say({ type: "markdown" });
  await tick(); await tick();
  assert.deepEqual(world.commands.find((c) => c[0] === "vscode.openWith" && c[2] === "default")?.slice(1).map((v) => v?.fsPath ?? v), [path, "default", 2]);
  assert.equal(page.disposedCount, 1);
  // A file that isn't a canvas never opens formatted (no script runs).
  const other = fakePanel("dgc.chatdgcCanvasDoc", "notes.md");
  other.onDidChangeViewState = () => ({ dispose() {} });
  await world.customEditors.provider.resolveCustomTextEditor(doc("/home/u/notes.md", "x"), other);
  assert.equal(other.webview.options.enableScripts, false);
  assert.match(other.webview.html, /Only a ChatDGC document canvas opens formatted/);
});

test("canvas: Markdown and formatted switch in place; a tab VS Code already swapped out is never closed again", async () => {
  chat.register();
  const path = canvasFile(ID(7));
  world.docs = [doc(path, "# Plan\n")];
  world.tabs = [{ input: new TabInputCustom({ fsPath: path }, "dgc.chatdgcCanvasDoc") }];
  let closed = 0;
  globalThis.__DGC_TEST_VSCODE.window.tabGroups.close = async () => { closed++; throw new Error("Tab close: Invalid tab not found!"); };
  world.commands.length = 0;
  // The formatted page in front: CanvasDocEditor.active() needs its panel; the tab alone says formatted here.
  const page = fakePanel("dgc.chatdgcCanvasDoc", "Plan.md");
  page.active = true; page.viewColumn = 1; page.onDidChangeViewState = () => ({ dispose() {} });
  await world.customEditors.provider.resolveCustomTextEditor(world.docs[0], page);
  // As VS Code does: opening the same file in the same group swaps the editor, and the old tab object is gone.
  const execute = globalThis.__DGC_TEST_VSCODE.commands.executeCommand;
  globalThis.__DGC_TEST_VSCODE.commands.executeCommand = async (...args) => {
    if (args[0] === "vscode.openWith") world.tabs = [{ input: args[2] === "default" ? new TabInputText(args[1]) : new TabInputCustom(args[1], args[2]) }];
    return execute(...args);
  };
  after(() => { globalThis.__DGC_TEST_VSCODE.commands.executeCommand = execute; });
  await chat.canvasSwitch(false);
  assert.deepEqual(world.commands.map((c) => [c[0], c[1].fsPath, c[2], c[3]]), [["vscode.openWith", path, "default", 1]]);
  assert.equal(closed, 0, "swapped in place: nothing to close, and no error");
  page.active = false;
  world.tabs = [{ input: new TabInputText({ fsPath: path }) }];
  world.active = { document: world.docs[0], selection: { isEmpty: true, active: { line: 0 } } };
  await chat.canvasSwitch(true);
  assert.deepEqual(world.commands.at(-1).slice(2, 4), ["dgc.chatdgcCanvasDoc", 1]);
  world.active = { document: doc("/home/u/notes.md", "x") };
  world.tabs = [];
  world.commands.length = 0;
  await chat.canvasSwitch(true);
  assert.equal(world.commands.length, 0, "not a canvas: nothing opens");
});

test("canvas: versions compare in VS Code's diff or come back; Download saves a Word copy", async () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "Trip" });
  const path = canvasFile(ID(7));
  world.active = { document: doc(path, "now"), selection: { isEmpty: true, active: { line: 0 } } };
  const versions = [1, 2].map((n) => ({ n, at: "2026-10-11T10:00:00Z", by: n === 1 ? "model" : "user", note: "", chars: 3,
                                         path: `/home/u/.dgc/chat/canvas/${ID(7)}/${CV}/.versions/v${n}.md` }));
  const answer = (requestId) => chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), request_id: requestId,
    canvas: { id: CV, title: "Plan", kind: "document", language: "markdown", version: 2, path, versions, text: "now" } });
  const picks = [(items) => items.find((i) => i.label === "Version 1"), (items) => "Compare with now"];
  world.choose = (items) => picks.shift()(items);
  await chat.canvasVersions();
  assert.equal(last("chatdgc_canvas").op, "get");
  answer(last("chatdgc_canvas").request_id);
  await tick(); await tick(); await tick();
  const [command, left, right, title] = world.commands.at(-1);
  assert.deepEqual([command, left.fsPath, right.fsPath, title], ["vscode.diff", versions[0].path, path, "Plan: version 1 ↔ now"]);
  picks.push((items) => items.find((i) => i.label === "Version 1"), () => "Restore this version");
  await chat.canvasVersions();
  answer(last("chatdgc_canvas").request_id);
  await tick(); await tick(); await tick();
  assert.deepEqual({ ...last("chatdgc_canvas"), request_id: "" }, { type: "chatdgc_canvas", conversation_id: ID(7), canvas_id: CV,
                                                                    op: "restore", version: 1, request_id: "" });
  // Download (18 Nov): no save dialog; the process writes the copy into a private folder made for this download, and the
  // chat's own page saves it on the person's computer (src/download.ts).
  world.choose = (items) => items.find((i) => i.format === "docx");
  world.saveAsked = undefined;
  const downloading = chat.canvasDownload();
  for (let i = 0; i < 100 && last("chatdgc_canvas").op !== "export"; i++) await new Promise((r) => setTimeout(r, 5));
  const exporting = last("chatdgc_canvas");
  assert.deepEqual({ ...exporting, path: "", request_id: "" }, { type: "chatdgc_canvas", conversation_id: ID(7), canvas_id: CV, op: "export", format: "docx", path: "", request_id: "" });
  assert.match(exporting.path, /dgc-download-[^/\\]+[/\\]Plan\.docx$/, "a private folder of its own");
  createRequire(import.meta.url)("node:fs").writeFileSync(exporting.path, "the document");
  chat.onEvent({ type: "chatdgc_exported", request_id: exporting.request_id, conversation_id: ID(7), path: exporting.path, bytes: 12 });
  await downloading;
  assert.equal(world.saveAsked, undefined, "no save dialog");
  const handed = panel.webview.posted.filter((m) => m.type === "dgcDownload").at(-1);
  assert.equal(handed?.name, "Plan.docx");
  assert.equal(String(Buffer.from(handed.data)), "the document");
  assert.equal(createRequire(import.meta.url)("node:fs").existsSync(exporting.path), false, "its private folder is gone");
});

test("a chart saved as an image: only a PNG the page drew, handed back to the page to save on this computer", async () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "Spend" });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  world.saveAsked = undefined;
  panel.say({ type: "saveImage", name: "Spend by month", data: `data:image/png;base64,${png.toString("base64")}` });
  await tick(); await tick();
  assert.equal(world.saveAsked, undefined, "no save dialog");
  const handed = panel.webview.posted.filter((m) => m.type === "dgcDownload");
  assert.deepEqual(handed.map((m) => [m.name, m.mime, [...m.data]]), [["Spend by month.png", "image/png", [...png]]]);
  panel.say({ type: "saveImage", name: "x", data: "data:text/html;base64,PHNjcmlwdD4=" });
  panel.say({ type: "saveImage", name: "x", data: "javascript:alert(1)" });
  await tick(); await tick();
  assert.equal(panel.webview.posted.filter((m) => m.type === "dgcDownload").length, 1, "nothing but a PNG");
  assert.deepEqual(world.written, []);
});

test("a widget's page: nothing loads from anywhere, its own code only, no network APIs, the editor's colours", () => {
  const page = widgetDocument("<h1>EMI</h1><script>calc()</script>");
  assert.match(page, /content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'"/);
  assert.ok(page.indexOf('"RTCPeerConnection"') < page.indexOf("<body>"), "network and peer connections gone before its code runs");
  assert.match(page, /"fetch","XMLHttpRequest"/);
  assert.match(page, /--bg:var\(--vscode-editor-background\)!important;--text:var\(--vscode-editor-foreground\)!important;/,
               "it follows the theme as it changes, over the page's own");
  assert.match(page, /:root:has\(>body\[data-vscode-theme-kind="vscode-dark"\]\),[^{]*\{color-scheme:dark\}/);
  assert.ok(page.indexOf("acquireVsCodeApi()") < page.indexOf("<body>"), "the only handle to VS Code is DGC's, taken first");
  assert.deepEqual([...page.matchAll(/post\(\{type:"(\w+)"/g)].map((m) => m[1]), ["state", "report"], "and all it says");
  assert.match(page, /<body><h1>EMI<\/h1><script>calc\(\)<\/script><\/body>/);
});

test("a widget opens in a tab of its own beside the chat, once; Open shows that tab again, or a ```widget's page", () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "EMI" });
  const WG = `wg_${"b".repeat(16)}`;
  const widget = { id: WG, title: "EMI calculator", html: "<b>calc</b>", at: 0 };
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget });
  assert.deepEqual(panel.last("widgetShown"), { type: "widgetShown", messageId: MSG(2), widget }, "its card under the reply");
  const tab = world.panels.at(-1);
  assert.equal(world.panels.length, 2);
  assert.deepEqual([tab.viewType, tab.title, tab.show], ["dgc.chatdgcWidget", "EMI calculator", { viewColumn: -2, preserveFocus: true }],
                   "beside the chat, which keeps focus");
  assert.deepEqual(tab.options, { enableScripts: true, localResourceRoots: [] }, "scripts, and no file of yours");
  assert.match(tab.webview.html, /<body><b>calc<\/b><\/body>/);
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget });
  panel.say({ type: "widgetOpen", id: WG, html: "<b>anything</b>", title: "x" });
  assert.equal(world.panels.length, 2, "one tab a widget");
  assert.equal(tab.revealed, 2);
  // Not one DGC named, or too big: nothing.
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget: { ...widget, id: "wg_nope" } });
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget: { ...widget, id: `wg_${"c".repeat(16)}`, html: "x".repeat(200_001) } });
  panel.say({ type: "widgetOpen", html: "x".repeat(200_001), title: "Big" });
  assert.equal(world.panels.length, 2);
  // A ```widget in a reply: its page, opened by Open (with focus), once.
  panel.say({ type: "widgetOpen", html: "<i>fence</i>", title: "Tip calculator" });
  panel.say({ type: "widgetOpen", html: "<i>fence</i>", title: "Tip calculator" });
  const fenced = world.panels.at(-1);
  assert.equal(world.panels.length, 3);
  assert.deepEqual([fenced.title, fenced.show.preserveFocus, fenced.revealed], ["Tip calculator", false, 1]);
  // Closed: Open opens it again.
  tab.dispose();
  panel.say({ type: "widgetOpen", id: WG, html: "<b>calc</b>", title: "EMI calculator" });
  assert.equal(world.panels.length, 4);
  // A chat no tab shows: its card waits on the reply; no tab of its own.
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(9), message_id: MSG(2), widget: { ...widget, id: `wg_${"d".repeat(16)}` } });
  assert.equal(world.panels.length, 4);
});

test("a backend that hears what a widget shows: every open says so, and each widget's tab tells it once", () => {
  chat.open(ID(7));
  let [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.equal(last("chatdgc_open").widget_reports, undefined, "not to a backend that doesn't offer it");
  host.offers = { version: 1, widget_report: 1 };
  panel.say({ type: "ready" });
  assert.equal(last("chatdgc_open").widget_reports, true);
  opened(panel, { id: ID(7), title: "EMI" });
  const WG = `wg_${"e".repeat(16)}`;
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget: { id: WG, title: "EMI", html: "<b>EMI</b>", at: 0 } });
  const tab = world.panels.at(-1);
  assert.equal(last("chatdgc_widget_report"), undefined, "not before it's open and has run");
  tab.say({ type: "report", text: "EMI ₹43,391", errors: ["Uncaught TypeError: x", 5] });
  const told = last("chatdgc_widget_report");
  assert.deepEqual({ ...told, request_id: "" }, { type: "chatdgc_widget_report", request_id: "", conversation_id: ID(7), widget_id: WG,
                                                  shown: true, text: "EMI ₹43,391", errors: ["Uncaught TypeError: x"] });
  tab.say({ type: "report", text: "again" });
  assert.equal(sent.filter((c) => c.type === "chatdgc_widget_report").length, 1, "once");
  // The reply fixed it: the same tab, the new page.
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget: { id: WG, title: "EMI calculator", html: "<i>fixed</i>", at: 0 } });
  assert.equal(world.panels.at(-1), tab);
  assert.match(tab.webview.html, /<body><i>fixed<\/i><\/body>/);
  assert.equal(tab.title, "EMI calculator");
  tab.say({ type: "report", text: "fixed", errors: [] });
  assert.equal(last("chatdgc_widget_report").text, "fixed", "the fixed one tells too");
  // A chat no tab shows: told at once that nothing shows it.
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(9), message_id: MSG(2), widget: { id: `wg_${"f".repeat(16)}`, title: "X", html: "x", at: 0 } });
  assert.deepEqual([last("chatdgc_widget_report").widget_id, last("chatdgc_widget_report").shown, "text" in last("chatdgc_widget_report")],
                   [`wg_${"f".repeat(16)}`, false, false]);
});

test("a widget opens again as you left it: its fields kept as you type, never anything else, and a fix starts afresh", () => {
  const kept = {};
  const globalState = { get: (k) => kept[k], update: (k, v) => { kept[k] = v; return Promise.resolve(); } };
  const keeping = new ChatDGC({ extensionUri: "ext", globalState });
  keeping.attach(host);
  const WG = `wg_${"9".repeat(16)}`;
  const widget = { id: WG, title: "Tip", html: "<input id=bill><input type=checkbox>", at: 0 };
  keeping.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  keeping.onEvent({ type: "chatdgc_opened", request_id: last("chatdgc_open").request_id, conversation: { id: ID(7), title: "Tip" }, messages: [], earlier: 0, busy: false });
  keeping.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget });
  let tab = world.panels.at(-1);
  assert.match(tab.webview.html, /var saved=\[\];/);
  tab.say({ type: "state", fields: [{ i: 0, id: "bill", v: "1200" }, { i: 1, id: "", c: true }] });
  for (const bad of [{ type: "state", fields: [{ i: 0, v: { x: 1 } }] }, { type: "state", fields: "x" }, { type: "state", fields: Array(201).fill({ i: 0, v: "" }) },
                     { type: "state", fields: [{ i: 0, v: "x".repeat(2001) }] }, { type: "anything", fields: [] }]) tab.say(bad);
  assert.deepEqual(kept["dgc.chatdgcWidgetFields"][WG].fields, [{ i: 0, id: "bill", v: "1200" }, { i: 1, id: "", c: true }]);
  tab.dispose();
  panel.say({ type: "widgetOpen", id: WG, html: widget.html, title: "Tip" });
  tab = world.panels.at(-1);
  assert.match(tab.webview.html, /var saved=\[\{"i":0,"id":"bill","v":"1200"\},\{"i":1,"id":"","c":true\}\];/, "as you left it");
  keeping.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget: { ...widget, html: "<input id=bill><b>fixed</b>" } });
  assert.match(tab.webview.html, /var saved=\[\];/, "a fixed page starts afresh");
  assert.equal(kept["dgc.chatdgcWidgetFields"][WG], undefined);
});

/** What an icon URI draws: the SVG inside a data: URI (nothing to fetch), or "" for a link to a file. */
const drawn = (uri) => {
  const m = /^data:image\/svg\+xml;base64,(.+)$/.exec(String(uri));
  return m ? Buffer.from(m[1], "base64").toString("utf8") : "";
};
const mark = (theme) => readFileSync(join(root, `media/chatdgc-tab-${theme}.svg`), "utf8");
const installed = () => { const c = new ChatDGC({ extensionUri: { fsPath: root, toString: () => root } }); c.attach(host); return c; };

test("ChatDGC's tabs wear its own mark, the speech bubble, so they aren't taken for DGC's sessions", () => {
  const chat = installed();
  chat.open("");
  chat.openLibrary();
  const [tab, library] = world.panels;
  assert.deepEqual([drawn(tab.iconPath.light), drawn(tab.iconPath.dark)], [mark("light"), mark("dark")], "the SVG itself, light and dark");
  // (The Library's own tab wears the Library's icon, his Iris books, since Library v2: the test of its editor tab, below.)
  assert.match(String(library.iconPath.light.fsPath || library.iconPath.light.path || library.iconPath.light), /library-iris-32\.png$/);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const command = manifest.contributes.commands.find((c) => c.command === "dgc.newChatDGC");
  assert.deepEqual(command.icon, { light: "media/chatdgc-tab-light.svg", dark: "media/chatdgc-tab-dark.svg" });
  for (const theme of ["light", "dark"]) assert.match(readFileSync(join(root, `media/chatdgc-tab-${theme}.svg`), "utf8"), /aria-label="ChatDGC"/);
});

test("the Library's tab open when the window reloaded comes back (its filters are its page's own kept state); one at a time", async () => {
  world.serializers.length = 0;
  const reg = chat.register();
  const { serializer } = world.serializers.find((x) => x.viewType === CHATDGC_LIBRARY);
  const restored = fakePanel(CHATDGC_LIBRARY, "Library"), extra = fakePanel(CHATDGC_LIBRARY, "Library");
  const before = world.panels.length;
  await serializer.deserializeWebviewPanel(restored, { library: { tab: "images", search: "logo", filters: { fav: true } } });
  assert.match(restored.webview.html, /library\.js/, "the Library's own page");
  assert.equal(restored.webview.options.enableScripts, true);
  assert.equal(chat.library, restored);
  await serializer.deserializeWebviewPanel(extra, {});
  assert.equal(extra.disposedCount, 1, "a second one brought back is closed");
  chat.openLibrary();
  assert.equal(world.panels.length, before, "opening it again shows the one that came back, no new tab");
  assert.equal(restored.revealed, 1);
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.ok(manifest.activationEvents.includes(`onWebviewPanel:${CHATDGC_LIBRARY}`), "the editor wakes DGC to bring it back");
  restored.dispose();
  reg.dispose();
});

test("a widget's tab open when VS Code closed comes back with its page; a deleted one doesn't; it waits for the backend", async () => {
  host.offers = {};                                   // starting
  const reg = chat.register();
  assert.deepEqual(world.serializers.map((x) => x.viewType), [CHATDGC_EDITOR, CHATDGC_WIDGET, CHATDGC_LIBRARY]);
  const { serializer } = world.serializers[1];
  const WG = `wg_${"7".repeat(16)}`, other = `wg_${"8".repeat(16)}`;
  const kept = fakePanel(CHATDGC_WIDGET, "EMI"), gone = fakePanel(CHATDGC_WIDGET, "Old"), junk = fakePanel(CHATDGC_WIDGET, "x");
  await serializer.deserializeWebviewPanel(kept, { dgcWidget: { id: WG, chat: ID(7), title: "EMI calculator" } });
  await serializer.deserializeWebviewPanel(gone, { dgcWidget: { id: other, chat: ID(7), title: "Old" } });
  await serializer.deserializeWebviewPanel(junk, { dgcWidget: { id: "wg_x", chat: "../etc" } });
  assert.equal(junk.disposedCount, 1, "nothing it can name: closed");
  assert.match(kept.webview.html, /Opening EMI calculator…/);
  assert.match(kept.webview.html, /api\.setState\(\{dgcWidget:\{"id":"wg_7{16}","chat":"chat_7{32}","title":"EMI calculator"\}\}\)/,
               "still named, should VS Code close again first");
  assert.equal(last("chatdgc_widgets"), undefined, "not before the backend is up");
  host.offers = { version: 1, widget_library: 1 };
  chat.backendReady();
  const asks = sent.filter((c) => c.type === "chatdgc_widgets");
  assert.deepEqual(asks.map((c) => [c.op, c.widget_id, c.conversation_id]), [["get", WG, ID(7)], ["get", other, ID(7)]]);
  chat.onEvent({ type: "chatdgc_widgets", request_id: asks[0].request_id, op: "get", conversation_id: ID(7), widget_id: WG,
                 widget: { id: WG, title: "EMI calculator", html: "<b>EMI</b>", at: 0, message_id: MSG(2) } });
  assert.match(kept.webview.html, /<body><b>EMI<\/b><\/body>/);
  assert.equal(kept.disposedCount, 0);
  chat.onEvent({ type: "chatdgc_error", request_id: asks[1].request_id, message: "That widget isn't there any more." });
  assert.equal(gone.disposedCount, 1, "deleted since: no tab");
  assert.deepEqual(world.errors, [], "and no error said for it");
  // Shown from its card again: the same tab.
  chat.onEvent({ type: "chatdgc_widget", conversation_id: ID(7), message_id: MSG(2), widget: { id: WG, title: "EMI calculator", html: "<b>EMI</b>", at: 0 } });
  assert.equal(world.panels.filter((x) => x.viewType === CHATDGC_WIDGET).length, 0, "no new tab");
  reg.dispose();
});

test("the Library's widgets: listed for its page, opened beside you from their chat, deleted with their tab closed", async () => {
  host.offers = { version: 1, widget_library: 1 };
  chat.openLibrary();
  const [library] = world.panels;
  library.say({ type: "ready" });
  assert.deepEqual(library.last("widgetsOffered"), { type: "widgetsOffered", on: true });
  library.say({ type: "widgets", query: "emi", offset: 0 });
  const listed = last("chatdgc_widgets");
  assert.deepEqual({ ...listed, request_id: "" }, { type: "chatdgc_widgets", request_id: "", op: "list", query: "emi", limit: 60, offset: 0 });
  const W = { chat_id: ID(7), id: `wg_${"5".repeat(16)}`, title: "EMI", message_id: MSG(2), created_at: "2026-10-11T10:00:00Z", chat_title: "Loan" };
  chat.onEvent({ type: "chatdgc_widgets", request_id: listed.request_id, op: "list", widgets: [W], total: 1, next_offset: null });
  assert.deepEqual(library.last("widgets"), { type: "widgets", widgets: [W], total: 1, next: null });
  library.say({ type: "widgetOpen", widget: W });
  const get = last("chatdgc_widgets");
  assert.deepEqual([get.op, get.conversation_id, get.widget_id], ["get", ID(7), W.id]);
  chat.onEvent({ type: "chatdgc_widgets", request_id: get.request_id, op: "get", conversation_id: ID(7), widget_id: W.id,
                 widget: { id: W.id, title: "EMI", html: "<i>emi</i>", at: 0, message_id: MSG(2) } });
  const tab = world.panels.at(-1);
  assert.deepEqual([tab.viewType, tab.title, tab.show.preserveFocus], [CHATDGC_WIDGET, "EMI", false]);
  assert.match(tab.webview.html, /"chat":"chat_7{32}"/, "it knows its chat, to come back after a restart");
  library.say({ type: "widgetOpen", widget: W });
  assert.equal(tab.revealed, 1, "open already: shown, not asked for");
  library.say({ type: "widgetOpen", widget: { ...W, chat_id: "chat_../../x" } });
  assert.equal(last("chatdgc_widgets").request_id, get.request_id, "a widget it can't name: nothing");
  world.answer = undefined;
  library.say({ type: "widgetRemove", widget: W });
  await tick();
  assert.match(world.warnings.at(-1), /^Delete the widget “EMI”\? Its card stays in the chat, marked as deleted\./);
  assert.equal(last("chatdgc_widgets").op, "get", "not without a yes");
  world.answer = "Delete";
  library.say({ type: "widgetRemove", widget: W });
  await tick();
  const remove = last("chatdgc_widgets");
  assert.deepEqual([remove.op, remove.conversation_id, remove.widget_id], ["remove", ID(7), W.id]);
  chat.onEvent({ type: "chatdgc_widgets", request_id: remove.request_id, op: "remove", conversation_id: ID(7), widget_id: W.id });
  assert.equal(tab.disposedCount, 1, "its tab closes");
  assert.deepEqual(library.last("changed"), { type: "changed" });
  library.say({ type: "widgetChat", widget: W });
  const chatTab = world.panels.at(-1);
  assert.equal(chatTab.viewType, CHATDGC_EDITOR);
  chatTab.say({ type: "ready" });
  assert.equal(last("chatdgc_open").conversation_id, ID(7), "its chat, in a tab of its own");
  // A backend that doesn't keep widgets: the page is told, and asked nothing.
  host.offers = { version: 1 };
  const before = sent.length;
  library.say({ type: "widgets", query: "", offset: 0 });
  assert.deepEqual(library.last("widgetsOffered"), { type: "widgetsOffered", on: false });
  assert.equal(sent.length, before);
});

test("the window's size, chosen in a chat's meter: for every chat, its meter asked again; only sizes its backend takes", () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.deepEqual(panel.last("windows"), { type: "windows", presets: [] }, "a backend that doesn't list them: none here");
  panel.say({ type: "window", preset: "64k" });
  assert.deepEqual(host.windows, []);
  host.offers = { version: 1, windows: ["8k", "16k", "32k", "64k", "128k", "256k", "512k", "1m", "max", "2m"] };
  chat.backendReady();
  assert.equal(panel.last("windows").presets.length, 9, "a tab that loaded first is told once the backend is up");
  panel.say({ type: "ready" });
  assert.deepEqual(panel.last("windows").presets, ["8k", "16k", "32k", "64k", "128k", "256k", "512k", "1m", "max"], "the ones this screen knows");
  opened(panel, { id: ID(7), title: "Loan" });
  panel.say({ type: "window", preset: "64k" });
  assert.deepEqual(host.windows, ["64k"]);
  assert.deepEqual({ ...last("chatdgc_context"), request_id: "" }, { type: "chatdgc_context", request_id: "", conversation_id: ID(7) });
  for (const bad of ["2m", "48k", "", "max; rm"]) panel.say({ type: "window", preset: bad });
  assert.deepEqual(host.windows, ["64k"], "never one it doesn't know");
});

test("what fills a chat's window: asked of a backend that counts it, shown in the tabs on that chat only", () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "Loan" });
  panel.say({ type: "breakdown" });
  assert.equal(last("chatdgc_context_breakdown"), undefined, "not of a backend that doesn't say it counts it");
  host.offers = { version: 1, context_breakdown: 1 };
  panel.say({ type: "breakdown" });
  const asked = last("chatdgc_context_breakdown");
  assert.deepEqual({ ...asked, request_id: "" }, { type: "chatdgc_context_breakdown", request_id: "", conversation_id: ID(7) });
  const parts = { window: 32768, used: 100, source: "estimated", compact_at: 24576, buffer: 8192, free: 24476, categories: [{ id: "messages", label: "Messages", tokens: 100 }] };
  chat.onEvent({ type: "context_breakdown", request_id: asked.request_id, conversation_id: ID(7), ...parts, limit: 262144, preset: "32k" });
  assert.deepEqual(panel.last("breakdown"), { type: "breakdown", conversation: ID(7), breakdown: parts });
  chat.onEvent({ type: "context_breakdown", conversation_id: ID(9), ...parts });
  assert.equal(panel.webview.posted.filter((m) => m.type === "breakdown").length, 1, "another chat's goes nowhere here");
  const before = panel.webview.posted.length;
  panel.say({ type: "breakdown" });
  chat.onEvent({ type: "chatdgc_error", request_id: last("chatdgc_context_breakdown").request_id, conversation_id: ID(7), message: "couldn't count" });
  assert.equal(panel.webview.posted.slice(before).filter((m) => m.type === "error").length, 0, "a breakdown that fails says nothing: the meter's lines stay");
  // The side bar sends ChatDGC a chat's breakdown (it carries the chat), never a session's (live, it went nowhere).
  assert.equal(isChatdgcEvent({ type: "context_breakdown", conversation_id: ID(7) }), true);
  assert.equal(isChatdgcEvent({ type: "context_breakdown" }), false);
  assert.equal(isChatdgcEvent({ type: "context_breakdown", conversation_id: "" }), false);
  assert.equal(isChatdgcEvent({ type: "chatdgc_opened" }), true);
  assert.equal(isChatdgcEvent({ type: "context" }), false);
});

test("a reload brings each chat back in its tab, once", async () => {
  chat.register();
  const { serializer } = world.serializers[0];
  const first = fakePanel(CHATDGC_EDITOR, "x"), second = fakePanel(CHATDGC_EDITOR, "x");
  await serializer.deserializeWebviewPanel(first, { conversation: ID(9) });
  first.say({ type: "ready" });
  assert.equal(last("chatdgc_open").conversation_id, ID(9));
  opened(first, { id: ID(9), title: "Back" });
  await serializer.deserializeWebviewPanel(second, { conversation: ID(9) });
  assert.equal(second.disposedCount, 1, "a second copy of the same chat closes");
});

test("a chat's tab revived after a reload gets its picture itself (its blob; a new chat ChatDGC's mark), even one behind another tab; a second copy gets nothing", async () => {
  const chat = installed();
  chat.register();
  const { serializer } = world.serializers.find((s) => s.viewType === CHATDGC_EDITOR);
  // VS Code revives a tab that was behind another only once it is shown; until then it draws the icon it saved, so
  // that icon must need nothing fetched (a remote window's connection is not up yet; an update moved the folder).
  const behind = fakePanel(CHATDGC_EDITOR, "Trip");
  await serializer.deserializeWebviewPanel(behind, { conversation: ID(5) });
  // A chat's tab wears its blob (0.52, src/dock.ts): one still PNG, a rounded square, inside the URI as the mark is.
  assert.match(String(behind.iconPath), /^data:image\/png;base64,[A-Za-z0-9+/=]{200,}$/, "its blob, as a PNG inside the URI");
  assert.equal(behind.iconPath.light, undefined, "one picture for both themes");
  assert.doesNotMatch(String(behind.iconPath), /media|vibedgc|file:/, "nothing names the extension's folder");
  const twin = fakePanel(CHATDGC_EDITOR, "Trip");
  await serializer.deserializeWebviewPanel(twin, { conversation: ID(5) });
  assert.equal(twin.disposedCount, 1, "one chat, one tab");
  assert.equal(twin.iconPath, undefined, "a disposed panel is given nothing (VS Code throws)");
  const fresh = fakePanel(CHATDGC_EDITOR, "x");
  await serializer.deserializeWebviewPanel(fresh, undefined);         // a new chat's tab: no state saved
  assert.equal(drawn(fresh.iconPath.dark), mark("dark"));
});

test("a tab closed mid-reply asks once, as a session's tab does: Stop stops the reply, Keep leaves it running", async () => {
  host.keeps = true;
  host.chatdgcKeepsRunning = function () { return this.keeps; };
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const answering = (n, title) => {
    chat.open(ID(n));
    const panel = world.panels.at(-1);
    panel.say({ type: "ready" });
    opened(panel, { id: ID(n), title }, { busy: true, reply_id: MSG(n) });
    return panel;
  };
  world.quickPick = ["stop"];
  answering(1, "Count to 400").dispose();
  await tick();
  assert.equal(world.quickPicks.length, 1, "asked once");
  assert.equal(world.quickPicks[0].title, "“Count to 400” was still answering when you closed its tab");
  assert.deepEqual(world.quickPicks[0].items.map((i) => i.id), ["keep", "stop", "remember"], "the same three as Work");
  assert.deepEqual(last("chatdgc_cancel"), { type: "chatdgc_cancel", conversation_id: ID(1) }, "Stop: the reply stops, saved");
  world.quickPick = ["remember", "keep"];
  answering(2, "Trip").dispose();
  await tick();
  assert.equal(world.quickPicks.length, 2);
  assert.equal(sent.filter((c) => c.type === "chatdgc_cancel").length, 1, "Keep: it goes on");
  assert.deepEqual(world.updates, [{ key: "closingAWorkingTab", value: "keepRunning", target: 3 }], "the same setting");
  answering(3, "Remembered").dispose();
  await tick();
  assert.equal(world.quickPicks.length, 2, "remembered: not asked again");
  world.closingSetting = "ask";
  // A reply that ended, a tab with nothing running, and a CLI that can't keep it: nothing is asked.
  const ended = answering(4, "Done");
  chat.onEvent({ type: "chatdgc_turn", conversation_id: ID(4), state: "ended", reply_id: MSG(4) });
  ended.dispose();
  host.keeps = false;
  answering(5, "Older CLI").dispose();
  await tick();
  assert.equal(world.quickPicks.length, 2);
  // The window going (a reload, a closed window): never asked; the reply goes on with no window.
  host.keeps = true;
  const kept = answering(6, "Reload");
  chat.dispose();
  kept.dispose();
  await tick();
  assert.equal(world.quickPicks.length, 2, "a reload never asks");
  assert.equal(sent.filter((c) => c.type === "chatdgc_cancel").length, 1);
});

test("the process this window left answering comes back: each chat on screen opens again from it", () => {
  chat.open(ID(7));
  const [shown] = world.panels;
  shown.say({ type: "ready" });
  opened(shown, { id: ID(7), title: "Long" }, { busy: true, reply_id: MSG(7) });
  chat.backendLost();                                    // the window's own dgc serve (a relay) went
  assert.match(shown.last("lost").message, /restarted/);
  sent.length = 0;
  chat.backendReady(true);
  assert.deepEqual(sent.filter((c) => c.type === "chatdgc_open").map((c) => c.conversation_id), [ID(7)],
                   "opened again from the process that kept it, the reply so far in it");
  const reopened = sent.find((c) => c.type === "chatdgc_open");
  chat.onEvent({ type: "chatdgc_opened", request_id: reopened.request_id, conversation: { id: ID(7), title: "Long" },
                 messages: [{ id: MSG(7), role: "assistant", text: "1\n2\n" }], earlier: 0, busy: true, reply_id: MSG(7) });
  assert.deepEqual([shown.last("opened").busy, shown.last("opened").replyId], [true, MSG(7)]);
  sent.length = 0;
  chat.backendReady(false);                              // a new process: it has nothing of this window's
  assert.equal(sent.filter((c) => c.type === "chatdgc_open").length, 0);
});

test("rename, pin and archive from the tab's menu", async () => {
  chat.open(ID(1));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(1), title: "Old", pinned: false });
  world.pick = "rename"; world.input = "  Goa trip  ";
  panel.say({ type: "menu" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(last("chatdgc_update").title, "  Goa trip  ".slice(0, 120));
  world.pick = "pin";
  panel.say({ type: "menu" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(last("chatdgc_update").pinned, true);
  world.pick = "archive";
  panel.say({ type: "menu" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(last("chatdgc_update").archived, true);
  assert.equal(panel.disposedCount, 1);
});

test("web search: the tab's choice goes with the message, and what it looks for reaches its tabs", () => {
  chat.open(ID(3)); chat.open(ID(4));
  const [a, b] = world.panels;
  a.say({ type: "ready" }); opened(a, { id: ID(3), title: "A" });
  b.say({ type: "ready" }); opened(b, { id: ID(4), title: "B" });
  a.say({ type: "send", text: "Weather?", search: "on" });
  assert.equal(last("chatdgc_send").search, "on");
  a.say({ type: "send", text: "Weather?", search: "always" });
  assert.equal("search" in last("chatdgc_send"), false, "only off, auto or on");
  chat.onEvent({ type: "chatdgc_activity", conversation_id: ID(3), message_id: MSG(1), kind: "searching", text: "paris" });
  assert.deepEqual(a.last("activity"), { type: "activity", messageId: MSG(1), kind: "searching", text: "paris" });
  assert.equal(b.last("activity"), undefined);
});

test("attachments: only files this tab's picker returned, real pasted images, and nothing too large for one frame", async () => {
  chat.open(ID(5));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(5), title: "x" });
  const file = (p) => ({ scheme: "file", fsPath: p, path: p });
  world.chosen = [file("/home/u/trip.csv"), { scheme: "untitled", fsPath: "x", path: "x" }, file("/home/u/photo.png")];
  world.sizes = { "/home/u/trip.csv": 42, "/home/u/photo.png": 2048 };
  panel.say({ type: "attach" });
  await new Promise((r) => setTimeout(r, 0));
  // Nothing in the Library yet: straight to the picker.
  chat.onEvent({ type: "chatdgc_library", request_id: last("chatdgc_library").request_id, files: [], total: 0, next_offset: null, counts: {} });
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(panel.last("attached").items, [{ kind: "file", path: "/home/u/trip.csv", name: "trip.csv", size: 42 },
                                                   { kind: "file", path: "/home/u/photo.png", name: "photo.png", size: 2048 }]);
  const png = "data:image/png;base64,iVBORw0KGgo=";
  panel.say({ type: "send", text: "", attachments: [
    { kind: "file", path: "/home/u/trip.csv", name: "trip.csv" },
    { kind: "file", path: "/etc/shadow", name: "shadow" },
    { kind: "image", data: png, name: "Pasted image" },
    { kind: "image", data: "data:text/html;base64,PHNjcmlwdD4=" },
    { kind: "text", text: "long paste", name: "Pasted text" }] });
  assert.deepEqual(last("chatdgc_send").attachments, [{ kind: "file", path: "/home/u/trip.csv", name: "trip.csv" },
    { kind: "image", data: png, name: "Pasted image" }, { kind: "text", text: "long paste", name: "Pasted text" }],
    "a path the user never picked, and anything that isn't an image, never leave the tab");
  const before = sent.length;
  panel.say({ type: "send", text: "big", attachments: [{ kind: "image", data: "data:image/png;base64," + "A".repeat(3_000_100) }] });
  assert.equal(sent.length, before, "nothing is sent");
  assert.match(panel.last("error").message, /too large to send together/);
});

test("images the chat keeps are asked for by the tab showing them; dropped files need host confirmation and cannot come from hidden folders", async () => {
  chat.open(ID(6));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(6), title: "x" });
  const att = "att_" + "a".repeat(32);
  panel.say({ type: "image", id: att });
  panel.say({ type: "image", id: "../../etc/passwd" });
  const ask = last("chatdgc_file");
  assert.deepEqual({ ...ask, request_id: "" }, { type: "chatdgc_file", conversation_id: ID(6), attachment_id: att, request_id: "" });
  chat.onEvent({ type: "chatdgc_file", request_id: ask.request_id, conversation_id: ID(6), attachment_id: att, data: "data:image/png;base64,AAAA" });
  assert.deepEqual(panel.last("image"), { type: "image", id: att, data: "data:image/png;base64,AAAA" });
  world.dirs = ["/home/u/photos"]; world.missing = ["/home/u/gone.txt"];
  world.sizes = { "/home/u/trip notes.md": 300 };
  world.answer = undefined;
  panel.say({ type: "dropped", uris: ["file:///home/u/trip%20notes.md"] });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(panel.last("attached"), undefined, "a forged or declined drop never grants the path");
  world.answer = "Attach";
  panel.say({ type: "dropped", uris: ["file:///home/u/trip%20notes.md", "file:///home/u/.ssh/id_ed25519", "file:///home/u/project/.git/config",
                                      "file:///home/u/photos", "file:///home/u/gone.txt", "https://example.com/x.pdf"] });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(world.warnings.at(-1), /Attach these dropped files/);
  assert.deepEqual(panel.last("attached").items, [{ kind: "file", path: "/home/u/trip notes.md", name: "trip%20notes.md", size: 300 }]);
  panel.say({ type: "send", text: "", attachments: [{ kind: "file", path: "/home/u/trip notes.md", name: "trip notes.md" }] });
  assert.equal(last("chatdgc_send").attachments[0].path, "/home/u/trip notes.md", "a dropped file can be sent");
  panel.say({ type: "dropped", uris: ["file:///home/u/.dgc/secrets.json"] });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(panel.last("error").message, /Use the paperclip/);
});

test("versions: edits, retries and switches go as their commands, and a new version reaches the tab with its draft kept", () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "x" });
  panel.say({ type: "edit", messageId: MSG(1), text: "Again", thinking: "high", search: "on", model: "m".repeat(201) });
  const edit = last("chatdgc_edit");
  assert.deepEqual({ ...edit, request_id: "" }, { type: "chatdgc_edit", conversation_id: ID(7), message_id: MSG(1), text: "Again",
                                                  thinking: "high", search: "on", request_id: "" });
  chat.onEvent({ type: "chatdgc_opened", request_id: edit.request_id, conversation: { id: ID(7), title: "x" }, messages: [],
                 earlier: 0, busy: true, reply_id: MSG(2) });
  assert.deepEqual(panel.last("opened").keep, true);
  chat.onEvent({ type: "chatdgc_error", request_id: edit.request_id, conversation_id: ID(7), message: "The model didn't answer." });
  assert.equal(panel.last("error").message, "The model didn't answer.", "the edit's request was still open for its turn");
  panel.say({ type: "regenerate", messageId: MSG(2), model: "qwen3:32b" });
  assert.deepEqual([last("chatdgc_regenerate").message_id, last("chatdgc_regenerate").model], [MSG(2), "qwen3:32b"]);
  panel.say({ type: "version", parent: "root", index: 0 });
  panel.say({ type: "version", parent: MSG(1), index: 2 });
  for (const bad of [{ parent: "../x", index: 0 }, { parent: "root", index: -1 }, { parent: "root", index: 1.5 }]) {
    panel.say({ type: "version", ...bad });
  }
  assert.deepEqual(sent.filter((c) => c.type === "chatdgc_version").map((c) => [c.parent_id, c.index]), [["root", 0], [MSG(1), 2]]);
});

// Export (18 Nov): which kind of file is asked, then the process writes it into a private folder and the chat's page saves
// it on the person's computer (src/download.ts): never a save dialog, which in a remote window browses the remote.
test("export: Markdown or JSON, made by the process in a private folder, then saved by the chat's page on this computer", async () => {
  chat.open(ID(8));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(8), title: "Goa: trip/plan" });
  world.pick = "export"; world.saveAsked = undefined;
  world.choose = (items) => items.find((i) => i.id === "export") || items.find((i) => i.format === "json");
  panel.say({ type: "menu" });
  for (let i = 0; i < 20 && !last("chatdgc_export"); i++) await new Promise((r) => setTimeout(r, 0));
  const ask = last("chatdgc_export");
  assert.equal(ask.format, "json");
  assert.match(ask.path, /dgc-download-[^/\\]+[/\\]Goa trip plan\.json$/, "named after the chat, without path characters, in a private folder");
  createRequire(import.meta.url)("node:fs").writeFileSync(ask.path, "{}");
  chat.onEvent({ type: "chatdgc_exported", request_id: ask.request_id, conversation_id: ID(8), path: ask.path, bytes: 2 });
  for (let i = 0; i < 20 && !panel.webview.posted.some((m) => m.type === "dgcDownload"); i++) await new Promise((r) => setTimeout(r, 5));
  const handed = panel.webview.posted.find((m) => m.type === "dgcDownload");
  assert.equal(handed?.name, "Goa trip plan.json");
  assert.equal(String(Buffer.from(handed.data)), "{}");
  assert.equal(world.saveAsked, undefined, "no save dialog");
  world.choose = undefined;
});

test("Open on a file the chat made: one private folder for this window, the file's last copy only, gone on dispose", () => {
  const { existsSync, statSync } = createRequire(import.meta.url)("node:fs");
  chat.open(ID(5));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(5), title: "Budget" });
  const F = (c) => `att_${c.repeat(32)}`;
  const open = (fileId, name) => { panel.say({ type: "fileOpen", messageId: MSG(2), fileId, name }); return last("chatdgc_library_file").path; };
  const first = open(F("a"), "Budget.xlsx"), again = open(F("a"), "Budget.xlsx"), other = open(F("b"), "Notes.md");
  const parent = dirname(dirname(first));
  assert.equal(dirname(dirname(again)), parent, "every copy in one folder of this window's");
  assert.equal(dirname(dirname(other)), parent);
  assert.equal(statSync(parent).mode & 0o777, 0o700, "a private folder");
  assert.equal(existsSync(dirname(first)), false, "opening the file again replaces its earlier copy");
  assert.equal(existsSync(dirname(again)) && existsSync(dirname(other)), true);
  chat.dispose();
  assert.equal(existsSync(parent), false, "nothing left in the temp folder");
});

test("the context window: its commands go as such, and its events reach the tabs showing the chat", () => {
  chat.open(ID(9));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(9), title: "x" });
  panel.say({ type: "compact" });
  panel.say({ type: "summary", text: "  " });
  panel.say({ type: "summary", text: "Edited." });
  panel.say({ type: "carry" });
  assert.deepEqual(sent.slice(-3).map((c) => c.type), ["chatdgc_compact", "chatdgc_summary", "chatdgc_carry"], "an empty summary isn't sent");
  chat.onEvent({ type: "chatdgc_context", conversation_id: ID(9), window: 32768, limit: 0, used: 900, preset: "32k", source: "estimated", parts: {}, compactable: true });
  assert.deepEqual([panel.last("context").used, panel.last("context").compactable], [900, true]);
  chat.onEvent({ type: "chatdgc_compacted", conversation_id: ID(9), summary: { upto: MSG(1), text: "s" } });
  assert.equal(panel.last("compacted").summary.text, "s");
  const carry = last("chatdgc_carry");
  chat.onEvent({ type: "chatdgc_opened", request_id: carry.request_id, conversation: { id: ID(4), title: "x" }, messages: [], earlier: 0, busy: false });
  assert.equal(panel.last("opened").conversation.id, ID(4), "the tab moves to the new chat");
  chat.onEvent({ type: "chatdgc_context", conversation_id: ID(9), window: 1, limit: 0, used: 1, preset: "32k", source: "estimated", parts: {} });
  assert.equal(panel.last("context").used, 900, "the old chat's meter no longer reaches it");
});

test("a question in the answer: the card's choice goes as chatdgc_answer, and a question reaches the tabs showing the chat", () => {
  chat.open(ID(10));
  const [panel] = world.panels.slice(-1);
  panel.say({ type: "ready" }); opened(panel, { id: ID(10), title: "x" });
  const before = sent.length;
  for (const bad of [{ choice: "" }, { choice: "x".repeat(501) }, { question: -1 }, { question: 1.5 }, { messageId: "nope" }]) {
    panel.say({ type: "answer", messageId: MSG(2), question: 0, choice: "Pune", ...bad });
  }
  assert.equal(sent.length, before, "nothing that isn't an answer is sent");
  panel.say({ type: "answer", messageId: MSG(2), question: 0, choice: " Pune ", model: "qwen3:8b", thinking: "low", search: "off" });
  const answer = last("chatdgc_answer");
  assert.deepEqual([answer.conversation_id, answer.message_id, answer.question, answer.choice, answer.model, answer.thinking, answer.search],
                   [ID(10), MSG(2), 0, "Pune", "qwen3:8b", "low", "off"]);
  const asked = { at: 4, question: "Which city?", options: ["Pune", "Goa"], prompt: "I mean {answer}." };
  chat.onEvent({ type: "chatdgc_question", conversation_id: ID(10), message_id: MSG(2), question: asked });
  assert.deepEqual(panel.last("question"), { type: "question", messageId: MSG(2), question: asked });
});

test("deep research: its commands go as such, its progress reaches the tabs, and an ending out of sight is said", async () => {
  chat.open(ID(11));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(11), title: "x" });
  panel.say({ type: "research", text: "  " });
  panel.say({ type: "research", text: "Scooters", model: "qwen3:8b", thinking: "low" });
  panel.say({ type: "researchStart", messageId: MSG(2), plan: { title: "t", steps: ["a"] } });
  panel.say({ type: "researchStart", messageId: MSG(2), write: true });
  panel.say({ type: "steer", messageId: MSG(2), text: "x".repeat(1001) });
  panel.say({ type: "steer", messageId: MSG(2), text: " I'm an NRI " });
  assert.deepEqual(sent.slice(-4).map((c) => c.type), ["chatdgc_research", "chatdgc_research_start", "chatdgc_research_start", "chatdgc_research_steer"]);
  const [research, start, write, steer] = sent.slice(-4);
  assert.deepEqual([research.text, research.model, research.thinking], ["Scooters", "qwen3:8b", "low"]);
  assert.deepEqual([start.plan, start.write, write.write, steer.text], [{ title: "t", steps: ["a"] }, undefined, true, "I'm an NRI"]);
  const progress = { status: "running", plan: { title: "Scooters" } };
  chat.onEvent({ type: "chatdgc_research", conversation_id: ID(11), message_id: MSG(2), research: progress });
  assert.deepEqual(panel.last("research"), { type: "research", messageId: MSG(2), research: progress });
  assert.equal(world.infos.length, 0, "still running: nothing to say");
  panel.visible = true;
  chat.onEvent({ type: "chatdgc_research", conversation_id: ID(11), message_id: MSG(2), research: { status: "done", plan: { title: "Scooters" } } });
  assert.equal(world.infos.length, 0, "it ended where you can see it");
  panel.visible = false;
  chat.onEvent({ type: "chatdgc_research", conversation_id: ID(11), message_id: MSG(2), research: { status: "done", plan: { title: "Scooters" } } });
  assert.deepEqual(world.infos, ["Deep research finished: Scooters"]);
});

test("memory: Forget under a reply deletes it from the one memory, and Manage memory opens Settings at Memory", () => {
  chat.open(ID(12));
  const [panel] = world.panels;
  const shown = [];
  host.openSettings = (section) => shown.push(section);
  panel.say({ type: "ready" }); opened(panel, { id: ID(12), title: "x" });
  const before = sent.length;
  panel.say({ type: "forgetMemory", id: "not-an-id" });
  assert.equal(sent.length, before);
  panel.say({ type: "forgetMemory", id: "mem_0123456789ab" });
  assert.deepEqual([last("memory_forget").id, typeof last("memory_forget").request_id], ["mem_0123456789ab", "string"]);
  panel.say({ type: "openMemory" });
  assert.deepEqual(shown, ["memory"]);
});

const PROJ = (c) => `proj_${c.repeat(32)}`;

test("branch in new chat: the branch opens in a tab of its own, and the chat it came from stays", () => {
  chat.open(ID(1));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(1), title: "Goa" });
  panel.say({ type: "branch", messageId: MSG(2) });
  panel.say({ type: "branch", messageId: "not a message" });
  const ask = last("chatdgc_branch");
  assert.deepEqual({ ...ask, request_id: undefined }, { type: "chatdgc_branch", conversation_id: ID(1), message_id: MSG(2), request_id: undefined });
  assert.equal(sent.filter((c) => c.type === "chatdgc_branch").length, 1, "only a message id goes");
  chat.onEvent({ type: "chatdgc_opened", request_id: ask.request_id, conversation: { id: ID(2), title: "Branch · Goa" }, messages: [], earlier: 0, busy: false });
  assert.equal(world.panels.length, 2, "a tab of its own");
  world.panels[1].say({ type: "ready" });
  assert.equal(last("chatdgc_open").conversation_id, ID(2));
  assert.equal(panel.last("opened").conversation.id, ID(1), "the first tab still shows the chat it came from");
  panel.say({ type: "openChat", id: ID(1) });
  assert.equal(world.panels.length, 2, "a chat already open is brought forward");
});

test("a project's page is a tab of its own, and its settings, files and deletion go through the host", async () => {
  chat.openProject(PROJ("a"));
  chat.openProject("proj_bad");
  assert.equal(world.panels.length, 1);
  const [page] = world.panels;
  page.say({ type: "ready" });
  assert.equal(last("chatdgc_open").project, PROJ("a"), "a new chat in the project: its page");
  assert.ok(last("chatdgc_projects"), "and the projects, for the header and the page");
  opened(page, { id: ID(3), title: "New chat", project: PROJ("a") }, { project: { id: PROJ("a"), name: "Goa trip", files: [] } });
  assert.equal(page.title, "Goa trip");
  assert.equal(page.last("opened").project.name, "Goa trip");
  chat.openProject(PROJ("a"));
  assert.equal(world.panels.length, 1, "its page again: the same tab");
  page.say({ type: "projectSave", id: PROJ("a"), name: "Goa, December", color: "chartreuse", instructions: "Rupees.", memory: "project" });
  const saved = last("chatdgc_project");
  assert.deepEqual({ ...saved, request_id: undefined }, { type: "chatdgc_project", op: "update", project_id: PROJ("a"), name: "Goa, December",
                                                         instructions: "Rupees.", memory: "project", request_id: undefined }, "a colour it doesn't know isn't sent");
  chat.onEvent({ type: "chatdgc_project", request_id: saved.request_id, project: { id: PROJ("a"), name: "Goa, December" } });
  assert.equal(page.last("projectSaved").project.name, "Goa, December");
  world.chosen = [{ scheme: "file", fsPath: "/home/u/itinerary.pdf", path: "/home/u/itinerary.pdf" }, { scheme: "untitled", fsPath: "", path: "" }];
  page.say({ type: "projectAddFiles", id: PROJ("a") });
  await tick();
  assert.deepEqual(last("chatdgc_project").attachments, [{ kind: "file", path: "/home/u/itinerary.pdf" }], "picked here: the page names no file");
  page.say({ type: "projectRemoveFile", id: PROJ("a"), fileId: `att_${"b".repeat(32)}` });
  assert.deepEqual([last("chatdgc_project").op, last("chatdgc_project").file_id], ["remove_file", `att_${"b".repeat(32)}`]);
  // Delete: its chats too, or kept as yours; then its page and its chats' tabs close.
  chat.open(ID(4));
  world.panels[1].say({ type: "ready" });
  opened(world.panels[1], { id: ID(4), title: "Where we stay", project: PROJ("a") });
  world.answer = "Delete space and 2 chats";
  page.say({ type: "projectDelete", id: PROJ("a"), name: "Goa, December", chats: 2 });
  await tick();
  assert.match(world.warnings.at(-1), /Delete the space “Goa, December”\?.*its chats too, unless you keep them/);
  const gone = last("chatdgc_project");
  assert.deepEqual([gone.op, gone.keep_chats], ["delete", false]);
  chat.onEvent({ type: "chatdgc_project", request_id: gone.request_id, project: null, deleted: [ID(4)] });
  assert.deepEqual(world.panels.map((p) => p.disposedCount), [1, 1], "the page, and the chat that went with it");
});

test("move to project from a chat's menu: a project, a new one, or out of the one it's in", async () => {
  chat.open(ID(5));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(5), title: "Beaches", project: PROJ("a") });
  // The menu asks for the projects, and so may the home's own refresh (250 ms after a change, which a loaded
  // machine can land in the middle of this): answer every projects request since the menu opened, not just the last.
  const answerProjects = (since, projects) => {
    for (const asked of sent.slice(since).filter((c) => c.type === "chatdgc_projects")) {
      chat.onEvent({ type: "chatdgc_projects", request_id: asked.request_id, projects });
    }
  };
  world.pick = ["move", PROJ("b")];
  let since = sent.length;
  panel.say({ type: "menu" });
  await tick();
  answerProjects(since, [{ id: PROJ("a"), name: "Goa", chats: 1 }, { id: PROJ("b"), name: "Kerala", chats: 0 }]);
  await tick(); await tick();
  assert.deepEqual(world.picks.at(-1), [PROJ("b"), "new", ""], "not the one it's in; a new one; out of it");
  assert.deepEqual([last("chatdgc_move").conversation_id, last("chatdgc_move").project_id], [ID(5), PROJ("b")]);
  world.pick = ["move", "new"];
  world.input = "Tax 2026";
  since = sent.length;
  panel.say({ type: "menu" });
  await tick();
  answerProjects(since, []);
  await tick(); await tick();
  const made = last("chatdgc_project");
  assert.deepEqual([made.op, made.name], ["create", "Tax 2026"]);
  chat.onEvent({ type: "chatdgc_project", request_id: made.request_id, project: { id: PROJ("c"), name: "Tax 2026" } });
  await tick();
  assert.equal(last("chatdgc_move").project_id, PROJ("c"), "into the project it just made");
});

test("the home's projects: listed with the chats, opened as pages, and a chat dragged into one", async () => {
  chat.homeRefresh();
  const asked = last("chatdgc_projects");
  chat.onEvent({ type: "chatdgc_projects", request_id: asked.request_id, projects: [{ id: PROJ("a"), name: "Goa" }, { id: "nope", name: "x" }] });
  assert.deepEqual(host.home.at(-1), { type: "chatdgc_projects", projects: [{ id: PROJ("a"), name: "Goa" }] });
  await chat.homeMessage({ type: "chatdgcProjectChats", id: PROJ("a") });
  const list = last("chatdgc_list");
  assert.equal(list.project, PROJ("a"));
  chat.onEvent({ type: "chatdgc_chats", request_id: list.request_id, chats: [{ id: ID(6), title: "Where we stay" }, { id: "bad" }], total: 1, next_offset: null });
  assert.deepEqual(host.home.at(-1), { type: "chatdgc_project_chats", project: PROJ("a"), items: [{ id: ID(6), title: "Where we stay" }], total: 1 });
  await chat.homeMessage({ type: "chatdgcMove", id: ID(6), project: "" });
  await chat.homeMessage({ type: "chatdgcMove", id: ID(6), project: "elsewhere" });
  assert.equal(sent.filter((c) => c.type === "chatdgc_move").length, 1, "only a real project, or none");
  chat.onEvent({ type: "chatdgc_error", request_id: last("chatdgc_move").request_id, message: "That project doesn't exist." });
  assert.deepEqual(world.errors, ["That project doesn't exist."], "a move from the home that failed says so");
  await chat.homeMessage({ type: "chatdgcProjectOpen", id: PROJ("a") });
  assert.equal(world.panels.length, 1);
  // A change anywhere reaches the home and every tab.
  chat.onEvent({ type: "chatdgc_projects", projects: [{ id: PROJ("a"), name: "Goa 2026" }] });
  assert.equal(world.panels[0].last("projects").projects[0].name, "Goa 2026");
  assert.equal(host.home.at(-1).projects[0].name, "Goa 2026");
});

test("the Library: its own tab, its files asked for, and each file's actions through the host", async () => {
  chat.openLibrary();
  chat.openLibrary();
  assert.equal(world.panels.length, 1, "one Library");
  const [lib] = world.panels;
  assert.deepEqual(lib.last("refresh"), { type: "refresh" }, "shown again, it asks again: a file made since is there");
  assert.equal(lib.viewType, CHATDGC_LIBRARY);
  assert.match(lib.webview.html, /media\/library\.js/);
  assert.match(lib.webview.html, /img-src[^;]*data:;/, "its images come from DGC, never a site");
  lib.say({ type: "ready", kind: "pdf" });
  const asked = last("chatdgc_library");
  assert.deepEqual({ ...asked, request_id: undefined }, { type: "chatdgc_library", kind: "pdf", limit: 60, offset: 0, request_id: undefined });
  chat.onEvent({ type: "chatdgc_library", request_id: asked.request_id, files: [{ id: "x" }], total: 1, next_offset: null, counts: { pdf: 1 },
                 origins: { made: 1, uploaded: 0 } });
  assert.deepEqual(lib.last("library"), { type: "library", files: [{ id: "x" }], total: 1, next: null, counts: { pdf: 1 },
                                          origins: { made: 1, uploaded: 0 } });
  lib.say({ type: "list", origin: "made" });
  assert.equal(last("chatdgc_library").origin, "made", "the files ChatDGC made");
  lib.say({ type: "list", origin: "<script>" });
  assert.equal(last("chatdgc_library").origin, undefined, "only a filter DGC knows");
  const file = { source: "chat", chat_id: ID(7), id: `att_${"a".repeat(32)}`, name: "budget.csv", kind: "document", size: 15 };
  const projectFile = { source: "project", project_id: PROJ("a"), id: `att_${"b".repeat(32)}`, name: "Hotel", kind: "text" };
  lib.say({ type: "image", file: { ...file, kind: "image" } });
  const image = last("chatdgc_file");
  assert.deepEqual([image.conversation_id, image.attachment_id], [ID(7), file.id]);
  chat.onEvent({ type: "chatdgc_file", request_id: image.request_id, conversation_id: ID(7), attachment_id: file.id, data: "data:image/png;base64,AAAA" });
  assert.equal(lib.last("image").data, "data:image/png;base64,AAAA");
  // Save a copy… (18 Nov): the process writes it into a private folder made for this download, and the Library's page saves
  // it on the person's computer: no save dialog.
  world.saveAsked = undefined;
  lib.say({ type: "save", file });
  for (let i = 0; i < 100 && last("chatdgc_library_file")?.op !== "save"; i++) await new Promise((r) => setTimeout(r, 5));
  const saving = last("chatdgc_library_file");
  assert.deepEqual([saving.op, saving.conversation_id], ["save", ID(7)]);
  assert.match(saving.path, /dgc-download-[^/\\]+[/\\]budget\.csv$/);
  createRequire(import.meta.url)("node:fs").writeFileSync(saving.path, "month,amount\n");
  chat.onEvent({ type: "chatdgc_library_file", request_id: saving.request_id, op: "save", path: saving.path, bytes: 13 });
  for (let i = 0; i < 100 && !lib.last("dgcDownload"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual([lib.last("dgcDownload")?.name, String(Buffer.from(lib.last("dgcDownload").data))], ["budget.csv", "month,amount\n"]);
  assert.equal(world.saveAsked, undefined, "no save dialog");
  // Save to project… on a picture: a copy in the folder open in VS Code (assets/ unless you pick); never another file.
  {
    const vs = globalThis.__DGC_TEST_VSCODE;
    const saves = () => sent.filter((c) => c.type === "chatdgc_library_file").length;
    const before = saves();
    lib.say({ type: "saveToProject", file: { ...file, type: "document" } });
    await tick();
    assert.equal(saves(), before, "only a picture");
    vs.workspace.workspaceFolders = [{ uri: { fsPath: "/home/u/app", toString: () => "file:///home/u/app" } }];
    try {
      world.saveTo = { scheme: "file", fsPath: "/home/u/app/assets/fox.png" };
      lib.say({ type: "saveToProject", file: { ...file, kind: "image", type: "image", name: "fox.png" } });
      await tick();
      assert.deepEqual([last("chatdgc_library_file").op, last("chatdgc_library_file").path], ["save", "/home/u/app/assets/fox.png"]);
      assert.equal(world.saveAsked.title, "Save to project");
      assert.match(String(world.saveAsked.defaultUri), /home\/u\/app\/assets\/fox\.png$/);
    } finally { delete vs.workspace.workspaceFolders; }
  }
  world.answer = undefined;
  lib.say({ type: "remove", file });
  await tick();
  assert.equal(last("chatdgc_library_file").op, "save", "not deleted unless confirmed");
  world.answer = "Delete";
  lib.say({ type: "remove", file: projectFile });
  await tick();
  const removed = last("chatdgc_library_file");
  assert.deepEqual([removed.op, removed.project_id, removed.attachment_id], ["remove", PROJ("a"), projectFile.id]);
  chat.onEvent({ type: "chatdgc_library_file", request_id: removed.request_id, op: "remove" });
  assert.equal(lib.last("changed").type, "changed", "the list is asked for again");
  lib.say({ type: "save", file: { ...file, chat_id: "../../etc" } });
  lib.say({ type: "open", file: projectFile });
  assert.equal(world.panels.length, 2, "a project's file opens its project");
  assert.equal(sent.filter((c) => c.type === "chatdgc_library_file").length, 3, "a file the Library didn't name isn't touched (save, Save to project…, remove)");
});

test("the Library lists every image DGC made or kept (images_library: every surface, or the one asked for) with who made it, and only those may be shown, opened or copied", async () => {
  const fs = globalThis.__DGC_TEST_VSCODE.workspace.fs, keptRead = fs.readFile;
  const read = [], copied = [];
  fs.readFile = async (uri) => { read.push(uri.fsPath); return Buffer.from("png-bytes"); };
  fs.copy = async (from, to) => { copied.push([from.fsPath, to.fsPath]); };
  const asked = [];
  const made = { path: "/home/me/app/assets/generated/fox.png", rel: "assets/generated/fox.png", surface: "work", generator: "comfy",
                 generator_name: "ComfyUI on gpu-box", provider: "comfyui", model: "sdxl", prompt: "a red fox", seed: 4, width: 768, height: 320,
                 bytes: 46000, cost_usd: 0, created_at: "2026-11-02T08:00:00+00:00", project: "/home/me/app", session: "s-1",
                 made_by: { kind: "session", id: "s-1", name: "Snow scenes", secret: "never passed on" } };
  // One a Pip kept on purpose (dgc/image_keep.py): `kept`, its title and why.
  const kept = { path: "/home/me/.dgc/images/kept/owl.png", rel: "", surface: "pip", prompt: "The barn owl", kept: true, title: "The barn owl", why: "For the bird count", width: 640, height: 480, bytes: 9000,
                 created_at: "2026-11-03T08:00:00+00:00", pip: "pip_" + "b".repeat(32), made_by: { kind: "pip", id: "pip_" + "b".repeat(32), name: "Bird counter" }, source: "https://example.test/owl.png" };
  try {
    // A backend without images_library: the Library is told, and nothing is asked.
    chat.openLibrary();
    const [lib] = world.panels;
    lib.say({ type: "ready", kind: "" });
    assert.deepEqual(lib.last("workImagesOffered"), { type: "workImagesOffered", on: false });
    lib.say({ type: "workImages", query: "", offset: 0, limit: 60, seq: 1 });
    await tick();
    assert.deepEqual(lib.last("workImagesOffered"), { type: "workImagesOffered", on: false });
    host.imagesOffered = () => true;
    host.imagesLibrary = async (cmd) => { asked.push(cmd); return { type: "images_library", images: [made, kept, { path: "/etc/passwd" }].filter((i) => !cmd.surface || !i.surface || i.surface === cmd.surface), total: 3, next_offset: null }; };
    lib.say({ type: "ready", kind: "" });
    assert.deepEqual(lib.last("workImagesOffered"), { type: "workImagesOffered", on: true });
    lib.say({ type: "workImages", query: "fox", offset: 0, limit: 60, seq: 2 });
    await tick();
    assert.deepEqual(asked, [{ query: "fox", limit: 60, offset: 0 }], "every surface: Work's, ChatDGC's and the Pips' (no `surface` is named)");
    const answer = lib.last("workImages");
    assert.equal(answer.seq, 2);
    assert.deepEqual(answer.images.map((i) => i.path), [made.path, kept.path], "only picture files DGC made or kept");
    assert.equal(answer.images[0].generator_name, "ComfyUI on gpu-box");
    assert.deepEqual([answer.images[0].surface, answer.images[0].made_by], ["work", { kind: "session", id: "s-1", name: "Snow scenes" }], "who made it, by name: its three fields and no more");
    assert.deepEqual([answer.images[0].kept, answer.images[0].title], [undefined, undefined], "a made image is not a kept one");
    assert.deepEqual([answer.images[1].kept, answer.images[1].title, answer.images[1].why, answer.images[1].made_by.name], [true, "The barn owl", "For the bird count", "Bird counter"], "a kept one says so, with its title and why");
    assert.equal("source" in answer.images[1], false, "where it was fetched from is not the page's to know");
    // One maker's surface, when the page asks for one; anything else is every surface.
    lib.say({ type: "workImages", query: "", offset: 0, limit: 60, seq: 3, surface: "pip" });
    lib.say({ type: "workImages", query: "", offset: 0, limit: 60, seq: 4, surface: "../etc" });
    await tick();
    assert.deepEqual(asked.slice(1), [{ surface: "pip", limit: 60, offset: 0 }, { limit: 60, offset: 0 }]);
    lib.say({ type: "workImage", path: made.path });
    await tick();
    assert.deepEqual(lib.last("workImageData"), { type: "workImageData", path: made.path, data: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` });
    lib.say({ type: "workImage", path: "/home/me/.ssh/id_rsa.png" });
    lib.say({ type: "workImageOpen", path: "/home/me/secret.png" });
    await tick();
    assert.deepEqual(read, [made.path], "a path the Library wasn't given is never read");
    lib.say({ type: "workImageOpen", path: made.path });
    lib.say({ type: "workImageReveal", path: made.path });
    await tick();
    assert.deepEqual(world.commands.map((c) => [c[0], c[1].fsPath]), [["vscode.open", made.path], ["revealFileInOS", made.path]]);
    // Save a copy (18 Nov): the picture goes to the Library's page, which saves it on the person's computer.
    world.saveAsked = undefined;
    lib.say({ type: "workImageSave", path: made.path });
    await tick(); await tick();
    assert.deepEqual([lib.last("dgcDownload")?.name, String(Buffer.from(lib.last("dgcDownload").data))], ["fox.png", "png-bytes"]);
    assert.equal(world.saveAsked, undefined, "no save dialog");
    assert.deepEqual(copied, [], "nothing written on this machine");
    // Save to project…: a copy in the open project, assets/ unless you pick another place; with no folder open, said.
    const vs = globalThis.__DGC_TEST_VSCODE;
    lib.say({ type: "workImageToProject", path: made.path });
    await tick();
    assert.equal(copied.length, 0, "no folder open: nothing copied");
    assert.match(world.infos.at(-1), /Open a folder first: Save to project… copies the picture into it\./);
    vs.workspace.workspaceFolders = [{ uri: { fsPath: "/home/me/app", toString: () => "file:///home/me/app" } }];
    vs.workspace.asRelativePath = (uri) => String(uri.fsPath).replace("/home/me/app/", "");
    try {
      world.saveTo = { scheme: "file", fsPath: "/home/me/app/assets/fox.png" };
      lib.say({ type: "workImageToProject", path: "/home/me/secret.png" });
      lib.say({ type: "workImageToProject", path: made.path });
      await tick();
      assert.deepEqual(copied.at(-1), [made.path, "/home/me/app/assets/fox.png"]);
      assert.equal(copied.length, 1, "only a picture the Library was given");
      assert.equal(world.saveAsked.title, "Save to project");
      assert.match(String(world.saveAsked.defaultUri), /home\/me\/app\/assets\/fox\.png$/, "assets/ by default");
      assert.equal(world.infos.at(-1), "Saved assets/fox.png in the project.");
    } finally { delete vs.workspace.workspaceFolders; delete vs.workspace.asRelativePath; }
    chat.imagesMade();
    assert.deepEqual(lib.last("refresh"), { type: "refresh" }, "a picture made since is listed");
  } finally { fs.readFile = keptRead; delete fs.copy; }      // (the stub's own reader back, for the tests after)
});

test("a Library file in a new chat, or from the paperclip, and a send names only files picked for it", async () => {
  chat.openLibrary();
  const [lib] = world.panels;
  const file = { source: "chat", chat_id: ID(7), id: `att_${"a".repeat(32)}`, name: "budget.csv", kind: "document", size: 15, chars: 15 };
  lib.say({ type: "use", file });
  assert.equal(world.panels.length, 2);
  const tab = world.panels[1];
  tab.say({ type: "ready" });
  opened(tab, { id: ID(8), title: "New chat" });
  assert.deepEqual(tab.last("attached").items, [{ kind: "library", fileKind: "document", name: "budget.csv", size: 15, chars: 15,
                                                   conversation_id: ID(7), attachment_id: file.id }]);
  tab.say({ type: "send", text: "Total?", attachments: [{ kind: "library", conversation_id: ID(7), attachment_id: file.id },
                                                      { kind: "library", conversation_id: ID(9), attachment_id: `att_${"c".repeat(32)}` }] });
  assert.deepEqual(last("chatdgc_send").attachments, [{ kind: "library", conversation_id: ID(7), attachment_id: file.id }],
                   "a file the page names that wasn't picked here doesn't go");
  // The paperclip: the newest Library files first, then upload.
  tab.say({ type: "attach" });
  await tick();
  const recent = last("chatdgc_library");
  assert.equal(recent.limit, 8);
  world.pick = undefined;
  chat.onEvent({ type: "chatdgc_library", request_id: recent.request_id, files: [{ ...file, id: `att_${"d".repeat(32)}`, chat_title: "Goa" }], total: 1, next_offset: null, counts: {} });
  await tick(); await tick();
  assert.equal(world.picks.at(-1).length, 3, "Upload, a heading, and the recent file");
});

test("a plugin card's choices go by id; Hand it to a Pip asks which Pip, and a picker closed without one changes nothing", async () => {
  chat.open(ID(9));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(9), title: "Plans" });
  const act = `act_${"a".repeat(32)}`;
  chat.onEvent({ type: "chatdgc_action", conversation_id: ID(9), message_id: MSG(2), action: { id: act, status: "waiting" } });
  assert.deepEqual(panel.last("action"), { type: "action", messageId: MSG(2), action: { id: act, status: "waiting" } });
  panel.say({ type: "actionRun", messageId: MSG(2), actionId: act, arguments: { when: "Fri 13:30" } });
  panel.say({ type: "actionRun", messageId: MSG(2), actionId: "act_bad" });
  assert.deepEqual({ ...last("chatdgc_action"), request_id: undefined }, { type: "chatdgc_action", conversation_id: ID(9), message_id: MSG(2),
    action_id: act, op: "run", arguments: { when: "Fri 13:30" }, request_id: undefined });
  assert.equal(sent.filter((c) => c.type === "chatdgc_action").length, 1, "only a real card id goes");
  panel.say({ type: "actionDismiss", messageId: MSG(2), actionId: act });
  assert.equal(last("chatdgc_action").op, "dismiss");
  // Hand it to a Pip: your Personal Pips, then the one chosen.
  world.pick = `pip_${"b".repeat(32)}`;
  panel.say({ type: "actionHand", messageId: MSG(2), actionId: act });
  await tick();
  chat.onEvent({ type: "chatdgc_pips", request_id: last("chatdgc_pips").request_id,
                 pips: [{ id: `pip_${"b".repeat(32)}`, name: "Ava", goal: "Plans" }, { id: "nope", name: "x" }] });
  await tick(); await tick();
  assert.deepEqual(world.picks.at(-1), [`pip_${"b".repeat(32)}`], "only real Pips are offered");
  assert.deepEqual([last("chatdgc_action").op, last("chatdgc_action").pip_id], ["hand", `pip_${"b".repeat(32)}`]);
  world.pick = undefined;
  panel.say({ type: "actionHand", messageId: MSG(2), actionId: act });
  await tick();
  chat.onEvent({ type: "chatdgc_pips", request_id: last("chatdgc_pips").request_id, pips: [{ id: `pip_${"b".repeat(32)}`, name: "Ava" }] });
  await tick(); await tick();
  assert.deepEqual(panel.last("actionIdle"), { type: "actionIdle", actionId: act }, "closed without a Pip: the card's buttons come back");
  panel.say({ type: "actionHand", messageId: MSG(2), actionId: act });
  await tick();
  chat.onEvent({ type: "chatdgc_pips", request_id: last("chatdgc_pips").request_id, pips: [], error: "Pips are disabled in this profile." });
  await tick(); await tick();
  assert.match(world.infos.at(-1), /Pips are disabled/, "no Pips: it says why");
});

test("dictation: each tab's box speaks for itself to the window's dictation; a closed or reloaded tab lets go of its recording", async () => {
  const tick = () => new Promise((r) => setImmediate(r));
  const posted = (panel) => panel.webview.posted.filter((m) => m.type === "mic" || m.type === "micLevels");
  // A CLI without voice: the page is told, and nothing else happens.
  chat.open(ID(5));
  const [a] = world.panels;
  a.say({ type: "micStart" });
  await tick();
  assert.deepEqual(posted(a).at(-1), { type: "mic", state: "idle", error: "Update the DGC CLI to use voice." });

  const handled = [], released = [];
  const dictation = {
    async handle(owner, message) { handled.push([owner, message.type, message.mode]); owner.post({ type: "mic", state: "recording" }); },
    release(owner) { released.push(owner); },
  };
  host.dictation = () => dictation;
  chat.open(ID(6));
  const b = world.panels[1];
  a.say({ type: "micStart" });
  b.say({ type: "micStop", mode: "send" });
  a.say({ type: "micCancel" });
  await tick();
  assert.deepEqual(handled.map(([, type, mode]) => [type, mode]), [["micStart", undefined], ["micStop", "send"], ["micCancel", undefined]]);
  const [ownerA, ownerB] = [handled[0][0], handled[1][0]];
  assert.notEqual(ownerA, ownerB, "each tab is its own box");
  assert.equal(handled[2][0], ownerA, "the same box every time");
  assert.deepEqual(posted(a).at(-1), { type: "mic", state: "recording" }, "what dictation says to a box reaches its tab");
  assert.deepEqual(posted(b).at(-1), { type: "mic", state: "recording" });

  // Reloaded or closed: the tab's box lets go.
  b.say({ type: "ready" });
  await tick();
  assert.deepEqual(released, [ownerB]);
  a.dispose();
  await tick();
  assert.deepEqual(released, [ownerB, ownerA]);
});

test("a card of several questions answers them all at once, only to a backend that takes it", () => {
  chat.open(ID(10));
  const [panel] = world.panels.slice(-1);
  panel.say({ type: "ready" }); opened(panel, { id: ID(10), title: "x" });
  const picks = ["Only me", "Spouse and/or parents", "Savings in India", "England"];
  const saved = host.offers;
  try {
    host.offers = { version: 1 };
    panel.say({ type: "answer", messageId: MSG(2), question: 0, choice: picks[0], choices: picks });
    assert.equal(last("chatdgc_answer").choices, undefined, "an older backend: the field it would refuse isn't sent");
    assert.equal(last("chatdgc_answer").choice, "Only me", "it answers the first, as its own screen would");
    host.offers = { version: 1, question_forms: 1 };
    const before = sent.length;
    for (const bad of [["one"], [...picks, "a fifth"], ["a", ""], ["a", 2], ["a", "x".repeat(501)], "a,b"]) {
      panel.say({ type: "answer", messageId: MSG(2), question: 0, choice: "a", choices: bad });
    }
    assert.equal(sent.length, before, "nothing that isn't a card's answers is sent");
    panel.say({ type: "answer", messageId: MSG(2), question: 0, choice: picks[0], choices: [" Only me ", ...picks.slice(1)] });
    assert.deepEqual([last("chatdgc_answer").choice, last("chatdgc_answer").choices], ["Only me", picks]);
  } finally { host.offers = saved; }
});

test("a message spoken in voice mode goes as spoken only to a backend that offers voice replies", () => {
  chat.open(ID(7));
  const [panel] = world.panels.slice(-1);
  panel.say({ type: "ready" });
  opened(panel, { id: ID(7), title: "Talk" });
  panel.say({ type: "send", text: "What should I cook?", voice: true });
  assert.equal(last("chatdgc_send").voice, undefined, "an older backend: the field it would refuse isn't sent");
  host.offers = { version: 1, voice_replies: 1 };
  panel.say({ type: "send", text: "And dessert?", voice: true });
  assert.equal(last("chatdgc_send").voice, true);
  panel.say({ type: "send", text: "Typed.", voice: "yes" });
  assert.equal(last("chatdgc_send").voice, undefined, "only true");
});

test("a tab asks for the logos of the plugins its replies used, and gets them from the host by valid id only", async () => {
  chat.open("");
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(1), title: "Rates", temporary: false });
  const asked = [];
  host.pluginLogo = (id) => { asked.push(id); return id === "aave" ? "data:image/png;base64,AAAA" : ""; };
  panel.say({ type: "pluginLogos", plugins: ["aave", "context7", "../x", 7, "Aave"] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(asked, ["aave", "context7"]);
  assert.deepEqual(panel.last("pluginLogos"), { type: "pluginLogos", logos: { aave: "data:image/png;base64,AAAA", context7: "" } });
  const before = panel.webview.posted.length;
  panel.say({ type: "pluginLogos", plugins: ["../x"] });
  await new Promise((r) => setImmediate(r));
  assert.equal(panel.webview.posted.length, before, "nothing valid: no reply");
  delete host.pluginLogo;
  panel.say({ type: "pluginLogos", plugins: ["aave"] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(panel.last("pluginLogos").logos, { aave: "" }, "a host with no logos: the page keeps its plug");
});

test("a chat's Widgets list: its outline from a backend that offers one, a widget opened by id, deleted for that chat, and the Library on its Widgets tab", async () => {
  chat.open(ID(8)); chat.open(ID(9));
  const [panel, other] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(8), title: "Flat" }, { earlier: 12 });
  other.say({ type: "ready" }); opened(other, { id: ID(9), title: "Other" });
  // An older CLI: no outline asked; the page makes do with what it has.
  host.offers = { version: 1, widget_library: 1 };
  panel.say({ type: "outline" });
  assert.equal(last("chatdgc_outline"), undefined, "not offered: not asked");
  host.offers = { version: 1, widget_library: 1, outline: 1 };
  panel.say({ type: "outline" });
  const ask = last("chatdgc_outline");
  assert.deepEqual({ ...ask, request_id: "" }, { type: "chatdgc_outline", conversation_id: ID(8), request_id: "" });
  const prompts = [{ id: MSG(1), text: "Make me an EMI calculator", created_at: "2026-10-11T10:00:00Z",
                     widgets: [{ id: `wg_${"1".repeat(16)}`, message_id: MSG(2), title: "EMI calculator", created_at: "2026-10-11T10:01:00Z" }] }];
  chat.onEvent({ type: "chatdgc_outline", request_id: ask.request_id, conversation_id: ID(8), prompts });
  assert.deepEqual(panel.last("outline"), { type: "outline", conversation: ID(8), prompts });
  assert.equal(other.last("outline"), undefined, "only the tab that asked");
  // Open, named by id from the list (its reply isn't on screen): its page asked for, as the Library asks.
  const WG = `wg_${"1".repeat(16)}`;
  panel.say({ type: "widgetOpen", id: WG, title: "EMI calculator" });
  const get = last("chatdgc_widgets");
  assert.deepEqual([get.op, get.conversation_id, get.widget_id], ["get", ID(8), WG]);
  chat.onEvent({ type: "chatdgc_widgets", request_id: get.request_id, op: "get", conversation_id: ID(8), widget_id: WG,
                 widget: { id: WG, title: "EMI calculator", html: "<b>EMI</b>", at: 0, message_id: MSG(2) } });
  const tab = world.panels.at(-1);
  assert.deepEqual([tab.viewType, tab.title], [CHATDGC_WIDGET, "EMI calculator"]);
  panel.say({ type: "widgetOpen", id: WG, title: "EMI calculator" });
  assert.equal(tab.revealed, 1, "open already: shown, not asked for again");
  // Delete, asked in the list's own row first: the Library's delete, for this chat, with no second question.
  panel.say({ type: "widgetRemove", id: "wg_../../x" });
  assert.equal(last("chatdgc_widgets").op, "get", "an id it can't name: nothing");
  panel.say({ type: "widgetRemove", id: WG });
  const remove = last("chatdgc_widgets");
  assert.deepEqual([remove.op, remove.conversation_id, remove.widget_id], ["remove", ID(8), WG]);
  assert.deepEqual(world.warnings, [], "the page asked already: no modal");
  chat.onEvent({ type: "chatdgc_widgets", request_id: remove.request_id, op: "remove", conversation_id: ID(8), widget_id: WG });
  assert.equal(tab.disposedCount, 1, "its tab closes");
  assert.deepEqual(panel.last("widgetRemoved"), { type: "widgetRemoved", id: WG });
  assert.equal(other.last("widgetRemoved"), undefined, "another chat's tab hears nothing");
  // The Library, on its Widgets tab: said once its page is ready, and again when it's open already.
  panel.say({ type: "openLibrary", view: "widgets" });
  const library = world.panels.at(-1);
  assert.equal(library.viewType, CHATDGC_LIBRARY);
  assert.equal(library.last("view"), undefined, "not before its page can hear it");
  library.say({ type: "ready" });
  assert.deepEqual(library.webview.posted.filter((m) => ["widgetsOffered", "view"].includes(m.type)),
                   [{ type: "widgetsOffered", on: true }, { type: "view", view: "widgets" }]);
  panel.say({ type: "openLibrary", view: "widgets" });
  assert.equal(library.revealed, 1);
  assert.equal(library.webview.posted.filter((m) => m.type === "view").length, 2, "open already: shown on its Widgets tab");
  // A backend that keeps no widgets: no delete, and the Library opens as it always has.
  host.offers = { version: 1 };
  const before = sent.length;
  panel.say({ type: "widgetRemove", id: WG });
  assert.equal(sent.length, before);
});

test("Open here for a chat: the tabs' chats are said to the process; one another window holds is read-only, hears none of its reply, and Open here takes it", async () => {
  host.chatdgcOpenHere = () => true;
  host.chatdgcKeepsRunning = () => true;
  chat.open(ID(1));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(1), title: "Count" });
  assert.deepEqual(last("chatdgc_shown"), { type: "chatdgc_shown", conversation_ids: [ID(1)] }, "what this window shows");
  // Held by another window: the bar and a locked box on the page, and nothing of a reply reaches it.
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(1), state: "elsewhere", pid: 4242 });
  assert.deepEqual(panel.last("elsewhere"), { type: "elsewhere", state: "elsewhere", conversation: ID(1) });
  chat.onEvent({ type: "chatdgc_delta", conversation_id: ID(1), message_id: MSG(1), text: "1\n" });
  chat.onEvent({ type: "chatdgc_turn", conversation_id: ID(1), state: "started", reply_id: MSG(1) });
  assert.equal(panel.last("delta"), undefined);
  assert.equal(panel.last("turn"), undefined);
  const before = sent.length;
  panel.say({ type: "send", text: "Hello" });
  panel.say({ type: "regenerate", messageId: MSG(1) });
  assert.equal(sent.length, before, "a change goes nowhere while another window writes to it");
  assert.match(panel.last("error").message, /open in another window\. Use Open here/);
  // Open here: asked once; its answer is "here" with the chat after it, never a second open.
  panel.say({ type: "openHere" });
  const take = last("chatdgc_open_here");
  assert.deepEqual({ ...take, request_id: "" }, { type: "chatdgc_open_here", conversation_id: ID(1), request_id: "" });
  const opens = sent.filter((c) => c.type === "chatdgc_open").length;
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(1), state: "here", request_id: take.request_id });
  assert.deepEqual(panel.last("elsewhere"), { type: "elsewhere", state: "none", conversation: ID(1) });
  assert.equal(sent.filter((c) => c.type === "chatdgc_open").length, opens, "the answer's chat is on its way");
  chat.onEvent({ type: "chatdgc_opened", request_id: take.request_id, conversation: { id: ID(1), title: "Count" },
                 messages: [{ id: MSG(1), role: "assistant", text: "1\n2\n" }], earlier: 0, busy: true, reply_id: MSG(1) });
  assert.deepEqual([panel.last("opened").busy, panel.last("opened").replyId], [true, MSG(1)], "the reply so far");
  chat.onEvent({ type: "chatdgc_delta", conversation_id: ID(1), message_id: MSG(1), text: "3\n" });
  assert.equal(panel.last("delta").text, "3\n", "and the rest, here");
  // The reply ended and the chat moved here for good: it is opened again, as it is here, what you type kept.
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(1), state: "here" });
  const reopen = last("chatdgc_open");
  assert.equal(sent.filter((c) => c.type === "chatdgc_open").length, opens + 1);
  assert.equal(reopen.conversation_id, ID(1));
  chat.onEvent({ type: "chatdgc_opened", request_id: reopen.request_id, conversation: { id: ID(1), title: "Count" },
                 messages: [], earlier: 0, busy: false });
  assert.equal(panel.last("opened").keep, true);
  // Taken back by the other window mid-reply: read-only again, and closing the tab asks nothing.
  chat.onEvent({ type: "chatdgc_turn", conversation_id: ID(1), state: "started", reply_id: MSG(2) });
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(1), state: "moved", pid: 4242 });
  assert.equal(panel.last("elsewhere").state, "moved");
  world.quickPick = ["stop"];
  panel.dispose();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(world.quickPicks.length, 0, "not this window's reply to keep or stop");
  assert.deepEqual(last("chatdgc_shown"), { type: "chatdgc_shown", conversation_ids: [] }, "let go of with its tab");
});

test("Open here: Running sessions' Open takes the chat at once; an older CLI hears nothing of what the tabs show", () => {
  host.chatdgcOpenHere = () => true;
  chat.open(ID(2), false, true);
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.equal(last("chatdgc_open"), undefined, "never opened as last saved first");
  assert.equal(last("chatdgc_open_here").conversation_id, ID(2));
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(2), state: "elsewhere" });
  chat.open(ID(2), false, true);                         // its tab again: brought forward, and taken
  assert.equal(panel.revealed, 1);
  assert.equal(sent.filter((c) => c.type === "chatdgc_open_here").length, 2);
  // A CLI that doesn't hold chats: no chatdgc_shown, no chatdgc_open_here, the tab opens as it always did.
  host.chatdgcOpenHere = () => false;
  sent.length = 0;
  chat.open(ID(3), false, true);
  const older = world.panels.at(-1);
  older.say({ type: "ready" });
  opened(older, { id: ID(3), title: "Old" });
  assert.deepEqual(sent.filter((c) => c.type.startsWith("chatdgc_open") || c.type === "chatdgc_shown").map((c) => c.type), ["chatdgc_open"]);
});

test("Open here: a read-only chat's bar says where it is open and whether it writes there, when the CLI can say", async () => {
  host.chatdgcOpenHere = () => true;
  host.offers = { version: 1, holder: 1 };
  chat.open(ID(6));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(6), title: "Held" });
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(6), state: "elsewhere", pid: 7 });
  assert.deepEqual(panel.last("elsewhere"), { type: "elsewhere", state: "elsewhere", conversation: ID(6) }, "read-only at once");
  const ask = last("chatdgc_holder");
  assert.deepEqual({ ...ask, request_id: "" }, { type: "chatdgc_holder", conversation_id: ID(6), request_id: "" });
  chat.onEvent({ type: "chatdgc_holder", request_id: ask.request_id, conversation_id: ID(6), found: true, editor: "Cursor",
                 windowless: false, folder: "~/shop-api", working: true });
  const line = { head: "Open in Cursor · ~/shop-api · writing a reply now.", detail: "Open here moves it to this window." };
  assert.deepEqual(panel.last("elsewhere"), { type: "elsewhere", state: "elsewhere", conversation: ID(6), note: line });
  // A reloaded page shows the line at once.
  panel.say({ type: "ready" });
  assert.deepEqual(panel.last("elsewhere").note, line);
  // The holder can't say where (an older DGC holds it): today's sentence, never a guess.
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(6), state: "elsewhere", pid: 7 });
  const again = [...sent].reverse().find((c) => c.type === "chatdgc_holder");
  chat.onEvent({ type: "chatdgc_holder", request_id: again.request_id, conversation_id: ID(6), found: false });
  assert.deepEqual(panel.last("elsewhere"), { type: "elsewhere", state: "elsewhere", conversation: ID(6) });
  // A failed ask says nothing to anyone.
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(6), state: "elsewhere", pid: 7 });
  const failed = [...sent].reverse().find((c) => c.type === "chatdgc_holder");
  chat.onEvent({ type: "chatdgc_error", request_id: failed.request_id, message: "nope" });
  assert.deepEqual(world.errors, []);
  assert.equal(panel.last("error"), undefined);
  // A CLI that can't say is never asked.
  host.offers = { version: 1 };
  sent.length = 0;
  chat.open(ID(7));
  const older = world.panels.at(-1);
  older.say({ type: "ready" });
  opened(older, { id: ID(7), title: "Old" });
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(7), state: "elsewhere", pid: 8 });
  assert.equal(last("chatdgc_holder"), undefined);
});

test("Open here: the window a chat was taken from asks a moment later, and says where it is now", async () => {
  host.chatdgcOpenHere = () => true;
  host.offers = { version: 1, holder: 1 };
  chat.open(ID(8));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(8), title: "Mine" });
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(8), state: "moved", pid: 9 });
  assert.equal(last("chatdgc_holder"), undefined, "not at once: the window that took it names itself a moment later");
  await new Promise((r) => setTimeout(r, 3200));
  const ask = last("chatdgc_holder");
  assert.equal(ask?.conversation_id, ID(8));
  chat.onEvent({ type: "chatdgc_holder", request_id: ask.request_id, conversation_id: ID(8), found: true, editor: "VS Code",
                 windowless: false, folder: "~/work", working: false, idle_s: 30 });
  assert.deepEqual(panel.last("elsewhere"), { type: "elsewhere", state: "moved", conversation: ID(8),
                                              note: { head: "Open in VS Code · ~/work · idle under a minute.", detail: "" } });
});

test("Open here: a read-only chat's menu offers only Export; its own again, the whole menu", async () => {
  host.chatdgcOpenHere = () => true;
  chat.open(ID(5));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(5), title: "Held" });
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(5), state: "elsewhere", pid: 7 });
  panel.say({ type: "menu" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(world.picks.at(-1), ["export"], "only what leaves the chat as it is");
  chat.onEvent({ type: "chatdgc_held", conversation_id: ID(5), state: "here" });
  panel.say({ type: "menu" });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(world.picks.at(-1), ["rename", "pin", "archive", "move", "export", "delete"]);
});

// ---- artifacts (src/artifacts.ts): the Output chip's field, a card's actions, the Library's Artifacts tab
const ARTIFACTS = { version: 1, types: ["page", "doc", "slides", "sheet", "dashboard"], outputs: ["auto", "document", "slides", "spreadsheet", "page", "dashboard"],
                    exports: { slides: ["pptx", "pdf", "html"], sheet: ["xlsx", "csv"] } };
function fakeArtifacts(offer = ARTIFACTS) {
  return { offer, opened: [], exported: [], removed: [], answer: true, heard: [],
    offers() { return this.offer; }, listen(fn) { this.tell = fn; return { dispose() {} }; },
    open(id, hint) { this.opened.push([id, hint]); }, async exportArtifact(view, format) { this.exported.push([view, format]); },
    async remove(view) { this.removed.push(view); return this.answer; }, async list() { return [{ id: "ar_" + "1".repeat(16), type: "slides" }]; },
    docAt() { return undefined; }, title() { return ""; } };
}

test("the Output chip's choice goes to chatdgc_send only when the process offers artifacts, and never Auto", () => {
  const hub = fakeArtifacts(null);
  chat.useArtifacts(hub);
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.deepEqual(panel.last("artifacts"), { type: "artifacts", offered: null }, "the page hides the chip");
  opened(panel, { id: ID(7), title: "x" });
  panel.say({ type: "send", text: "Make a deck", output: "slides" });
  assert.equal("output" in last("chatdgc_send"), false, "an older CLI refuses the whole send over a field it doesn't know");
  hub.offer = ARTIFACTS;
  panel.say({ type: "ready" });
  assert.deepEqual(panel.last("artifacts"), { type: "artifacts", offered: ARTIFACTS });
  panel.say({ type: "send", text: "Make a deck", output: "slides" });
  assert.equal(last("chatdgc_send").output, "slides");
  panel.say({ type: "send", text: "Again", output: "auto" });
  assert.equal("output" in last("chatdgc_send"), false);
  hub.tell({ type: "artifactChanged", artifact: { id: "ar_" + "1".repeat(16), type: "slides", version: 2 }, op: "changed" });
  assert.equal(panel.last("artifactChanged").artifact.version, 2, "every tab hears a change, for its cards");
});

test("a card's Open and Export go to the artifacts; the Library's Remove is asked about, and listed after", async () => {
  const hub = fakeArtifacts();
  chat.useArtifacts(hub);
  chat.open(ID(8));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(8), title: "x" });
  const id = "ar_" + "2".repeat(16);
  panel.say({ type: "artifactOpen", id, artifactType: "sheet", title: "Budget" });
  panel.say({ type: "artifactOpen", id: "../etc", artifactType: "sheet" });
  assert.deepEqual(hub.opened, [[id, { type: "sheet", title: "Budget" }]], "only an artifact's id");
  panel.say({ type: "artifactExport", id, format: "csv", artifactType: "sheet", title: "Budget", exports: ["xlsx", "csv"] });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(hub.exported, [[{ id, title: "Budget", type: "sheet", exports: ["xlsx", "csv"] }, "csv"]]);
  panel.say({ type: "artifactViews" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(panel.last("artifactViews").items.length, 1, "after a reload, what each card's artifact is now");
  chat.openLibrary("artifacts");
  const library = world.panels.at(-1);
  library.say({ type: "ready" });
  assert.equal(library.last("artifactsOffered").on, true);
  library.say({ type: "artifactList" });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(library.last("artifacts").items.length, 1);
  hub.answer = false;
  library.say({ type: "artifactRemove", artifact: { id, title: "Budget" } });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(hub.removed, [{ id, title: "Budget" }], "the host asks first (Artifacts.remove: a modal)");
  assert.equal(library.last("artifactRemoved"), undefined, "said no: still listed");
  hub.answer = true;
  library.say({ type: "artifactRemove", artifact: { id, title: "Budget" } });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(library.last("artifactRemoved"), { type: "artifactRemoved", id });
});

test("a DGC document (an artifact's working file) opens formatted with its versions, export and browser, and no chat's Ask", async () => {
  const hub = fakeArtifacts();
  const id = "ar_" + "3".repeat(16);
  const path = `/home/u/.dgc/artifacts/${id}/work/Launch notes.md`;
  const calls = [];
  Object.assign(hub, { docAt: (p) => (p === path ? { id, title: "Launch notes" } : undefined),
    docVersions: async (a) => calls.push(["versions", a]), docExport: async (a) => calls.push(["export", a]),
    openInBrowser: (v) => calls.push(["browser", v.id]) });
  chat.useArtifacts(hub);
  chat.register();
  const file = doc(path, "# Launch\n");
  world.docs = [file];
  const page = fakePanel("dgc.chatdgcCanvasDoc", "Launch notes.md");
  page.active = true; page.onDidChangeViewState = () => ({ dispose() {} });
  await world.customEditors.provider.resolveCustomTextEditor(file, page);
  assert.equal(page.webview.options.enableScripts, true);
  assert.doesNotMatch(page.webview.html, /Ask ChatDGC/, "no chat to ask");
  for (const does of ["versions", "export", "browser", "markdown"]) assert.match(page.webview.html, new RegExp(`data-do="${does}"`));
  page.say({ type: "versions" }); await tick();
  page.say({ type: "export" }); await tick();
  page.say({ type: "browser" }); await tick();
  page.say({ type: "ask", text: "x", start_line: 1, end_line: 1 }); await tick();
  assert.deepEqual(calls, [["versions", id], ["export", id], ["browser", id]]);
});

test("a DGC document's comments: its page watches its threads and asks through the hub; what you typed is saved first", async () => {
  const hub = fakeArtifacts();
  const id = "ar_" + "4".repeat(16);
  const path = `/home/u/.dgc/artifacts/${id}/work/Trip plan.md`;
  const watched = [], asked = [];
  let stopped = 0;
  Object.assign(hub, { docAt: (p) => (p === path ? { id, title: "Trip plan" } : undefined),
    offers() { return { ...this.offer, comments: true }; },
    watchComments: (a, post) => { watched.push(a); post({ type: "comments", id: a, version: 2, threads: [] }); return { dispose() { stopped++; } }; },
    comment: (a, message, post) => { asked.push([a, message]); post({ type: "commentsRejected", op: message.op, message: "no" }); } });
  chat.useArtifacts(hub);
  chat.register();
  const file = doc(path, "# Trip\n\nThe early train.\n");
  world.docs = [file];
  const page = fakePanel("dgc.chatdgcCanvasDoc", "Trip plan.md");
  page.active = true; page.onDidChangeViewState = () => ({ dispose() {} });
  await world.customEditors.provider.resolveCustomTextEditor(file, page);
  assert.match(page.webview.html, /media\/shared\/comments\.js/, "the page loads the comments module");
  assert.match(page.webview.html, /id="cv-comments"/, "and has its rail");
  assert.match(page.webview.html, /media\/shared\/menu\.js/, "and menu.js, for the solid raised grey (--raised)");
  page.say({ type: "ready" }); await tick();
  assert.deepEqual(page.webview.posted.filter((m) => m.type === "commentsOffer"), [{ type: "commentsOffer", on: true }]);
  assert.deepEqual(watched, [id]);
  assert.deepEqual(page.last("comments"), { type: "comments", id, version: 2, threads: [] });
  file.isDirty = true;
  page.say({ type: "comments", op: "add", anchor: { kind: "text", quote: "early train" }, text: "Later?", ask: true }); await tick(); await tick();
  assert.equal(file.saved, 1, "the words as you left them are saved before the comment goes");
  assert.deepEqual(asked, [[id, { type: "comments", op: "add", anchor: { kind: "text", quote: "early train" }, text: "Later?", ask: true }]]);
  assert.equal(page.last("commentsRejected").message, "no", "a refusal comes back to this page");
  page.dispose();
  assert.equal(stopped, 1, "closed: it stops watching");
  // A chat's own canvas (not an artifact's document) has no comments.
  const canvas = doc(canvasFile(ID(7)), "# Plan\n");
  world.docs = [canvas];
  const chatPage = fakePanel("dgc.chatdgcCanvasDoc", "Plan.md");
  chatPage.active = true; chatPage.onDidChangeViewState = () => ({ dispose() {} });
  await world.customEditors.provider.resolveCustomTextEditor(canvas, chatPage);
  assert.doesNotMatch(chatPage.webview.html, /cv-comments|comments\.js/);
});

// ---- a folder the chat reads, and Continue in Work (ready.capabilities.chatdgc.folder)

/** A tab on chat `n`, opened, on a backend that offers folders (or doesn't). */
function folderTab(n, offered = true) {
  host.offers = { version: 1, ...(offered ? { folder: 1 } : {}) };
  chat.open(ID(n));
  const panel = world.panels.at(-1);
  panel.say({ type: "ready" });
  opened(panel, { id: ID(n), title: "Uploads" });
  return panel;
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("a chat's folder is asked as it opens, only of a backend that offers it, and every tab on the chat shows it", async () => {
  const old = folderTab(7, false);
  assert.deepEqual(old.webview.posted.filter((m) => m.type === "folderOffered"), [{ type: "folderOffered", on: false }]);
  assert.equal(last("chatdgc_folder"), undefined, "never asked of a backend that doesn't offer it");
  old.say({ type: "folderPick" });
  old.say({ type: "workBrief" });
  await settle();
  assert.equal(last("chatdgc_set_folder"), undefined);
  assert.equal(last("chatdgc_work_brief"), undefined);
  assert.match(old.last("folderError").message, /Update CLI/);
  assert.match(old.last("briefing").error, /Update CLI/);

  const a = folderTab(8);
  assert.equal(a.last("folderOffered").on, true);
  const asked = last("chatdgc_folder");
  assert.deepEqual({ ...asked, request_id: "" }, { type: "chatdgc_folder", conversation_id: ID(8), request_id: "" });
  chat.onEvent({ type: "chatdgc_folder", request_id: asked.request_id, conversation_id: ID(8), folder: "/work/uploads" });
  assert.deepEqual(a.last("folder"), { type: "folder", conversation: ID(8), folder: "/work/uploads" });
  // The same chat in a second tab hears a change made in the first; another chat's tab doesn't.
  chat.open(ID(9)); const other = world.panels.at(-1); other.say({ type: "ready" }); opened(other, { id: ID(9), title: "Other" });
  chat.onEvent({ type: "chatdgc_folder", conversation_id: ID(8), folder: "" });
  assert.equal(a.last("folder").folder, "");
  assert.equal(other.webview.posted.some((m) => m.type === "folder" && m.conversation === ID(8)), false);
  chat.onEvent({ type: "chatdgc_folder", conversation_id: ID(8), folder: "x".repeat(5000) });
  assert.equal(a.last("folder").folder, "", "an oversized path is not shown");
});

test("the Folder chip: VS Code's picker chooses (at the window's folder), the page can only take it away", async () => {
  const vs = globalThis.__DGC_TEST_VSCODE;
  const picker = vs.window.showOpenDialog;
  let options;
  vs.window.showOpenDialog = async (o) => { options = o; return world.chosen; };
  vs.workspace.workspaceFolders = [{ uri: { fsPath: "/work" } }];
  try {
    const panel = folderTab(8);
    panel.say({ type: "folderSet", folder: "/etc" });
    assert.equal(last("chatdgc_set_folder"), undefined, "a path from the page is never sent");
    world.chosen = undefined;
    panel.say({ type: "folderPick" });
    await settle();
    assert.equal(options.canSelectFolders, true);
    assert.equal(options.canSelectFiles, false);
    assert.equal(options.canSelectMany, false);
    assert.equal(options.defaultUri.fsPath, "/work", "it starts at the window's first folder");
    assert.deepEqual(panel.last("folderPicked"), { type: "folderPicked", cancelled: true }, "closed with nothing chosen");
    assert.equal(last("chatdgc_set_folder"), undefined);
    world.chosen = [{ fsPath: "/work/uploads" }];
    panel.say({ type: "folderPick" });
    await settle();
    const set = last("chatdgc_set_folder");
    assert.deepEqual({ ...set, request_id: "" }, { type: "chatdgc_set_folder", conversation_id: ID(8), folder: "/work/uploads", request_id: "" });
    chat.onEvent({ type: "chatdgc_folder", request_id: set.request_id, conversation_id: ID(8), folder: "/work/uploads" });
    assert.deepEqual(panel.last("folder"), { type: "folder", conversation: ID(8), folder: "/work/uploads", mine: true });
    panel.say({ type: "folderPick" });
    await settle();
    assert.equal(options.defaultUri.fsPath, "/work/uploads", "choosing another starts at the chat's folder");
    panel.say({ type: "folderSet", folder: "" });
    const removal = last("chatdgc_set_folder");
    assert.equal(removal.folder, "");
    chat.onEvent({ type: "chatdgc_error", request_id: removal.request_id, conversation_id: ID(8), message: "Choose a project's folder, not the whole disk or your home folder." });
    assert.deepEqual(panel.last("folderError"), { type: "folderError", message: "Choose a project's folder, not the whole disk or your home folder." });
    assert.equal(panel.last("error"), undefined, "said on the chip's own line, never as a failed send");
  } finally { vs.window.showOpenDialog = picker; delete vs.workspace.workspaceFolders; }
});

test("Continue in Work: the brief's progress, then Work opens in the folder with the brief; a failure says why", async () => {
  const opens = [];
  host.openWork = async (folder, brief) => { opens.push({ folder, brief }); return host.workAnswer ?? true; };
  try {
    const panel = folderTab(8);
    chat.open(ID(8));                                       // its tab, brought forward
    panel.say({ type: "workBrief" });
    const ask = last("chatdgc_work_brief");
    assert.deepEqual({ ...ask, request_id: "" }, { type: "chatdgc_work_brief", conversation_id: ID(8), request_id: "" });
    // The turn slot says "compacting" with the request's id: for this request, it is the brief being written.
    chat.onEvent({ type: "chatdgc_activity", conversation_id: ID(8), message_id: ask.request_id, kind: "compacting", text: "" });
    assert.deepEqual(panel.last("briefing"), { type: "briefing", on: true });
    assert.equal(panel.last("activity"), undefined, "not shown as earlier messages being summarized");
    chat.onEvent({ type: "chatdgc_activity", conversation_id: ID(8), message_id: "cd-compact-1", kind: "compacting", text: "" });
    assert.equal(panel.last("activity").kind, "compacting", "Compact now is still Compact now");
    chat.onEvent({ type: "chatdgc_work_brief", request_id: ask.request_id, conversation_id: ID(8), folder: "/work/uploads",
                   brief: "Continuing from the chat “Uploads”, about this folder. What we worked out there:\n\nMove the limit.\n\nCarry on from here." });
    assert.deepEqual(panel.last("briefing"), { type: "briefing", on: false });
    await settle();
    assert.deepEqual(opens, [{ folder: "/work/uploads", brief: "Continuing from the chat “Uploads”, about this folder. What we worked out there:\n\nMove the limit.\n\nCarry on from here." }]);
    assert.deepEqual(panel.last("workOpened"), { type: "workOpened", folder: "/work/uploads", opened: true });
    // Said no to a folder outside the window's: nothing opened, and the chat says so.
    host.workAnswer = false;
    panel.say({ type: "workBrief" });
    chat.onEvent({ type: "chatdgc_work_brief", request_id: last("chatdgc_work_brief").request_id, conversation_id: ID(8), folder: "/elsewhere", brief: "b" });
    await settle();
    assert.equal(panel.last("workOpened").opened, false);
    // Refused by the backend (no folder any more, nothing sent, the model failed, Stop): why, to the tab that asked.
    panel.say({ type: "workBrief" });
    chat.onEvent({ type: "chatdgc_error", request_id: last("chatdgc_work_brief").request_id, conversation_id: ID(8), message: "Send a message first." });
    assert.deepEqual(panel.last("briefing"), { type: "briefing", on: false, error: "Send a message first." });
    // An empty brief opens nothing.
    panel.say({ type: "workBrief" });
    chat.onEvent({ type: "chatdgc_work_brief", request_id: last("chatdgc_work_brief").request_id, conversation_id: ID(8), folder: "/work/uploads", brief: "  " });
    await settle();
    assert.equal(opens.length, 2);
    assert.match(panel.last("workOpened").message, /no brief/);
  } finally { delete host.openWork; delete host.workAnswer; }
});

test("while another window writes to the chat, its folder can't be changed and Work can't be asked for", async () => {
  host.chatdgcOpenHere = () => true;
  try {
    const panel = folderTab(8);
    chat.onEvent({ type: "chatdgc_held", conversation_id: ID(8), state: "elsewhere" });
    const before = sent.length;
    panel.say({ type: "folderSet", folder: "" });
    panel.say({ type: "workBrief" });
    panel.say({ type: "folderPick" });
    await settle();
    assert.equal(sent.slice(before).filter((c) => /folder|work_brief/.test(c.type)).length, 0);
  } finally { delete host.chatdgcOpenHere; }
});

test("a read-only ChatDGC tab cannot run a mod in the other window's chat", async () => {
  const requests = [];
  host.chatdgcModsSend = (message) => { requests.push(message); return true; };
  try {
    const panel = folderTab(8);
    chat.onEvent({ type: "chatdgc_held", conversation_id: ID(8), state: "elsewhere" });
    panel.say({ type: "mods", op: "command", name: "tally", request_id: "chatdgc-mods-test" });
    await settle();
    assert.equal(requests.length, 0);
    assert.match(panel.last("error").message, /Open here before running a mod/);
    panel.say({ type: "mods", op: "list", request_id: "chatdgc-mods-list" });
    await settle();
    assert.equal(requests.length, 1, "a read-only tab can still inspect its mods");
  } finally { delete host.chatdgcModsSend; }
});

test("a chat's fallback model (D14) goes with every turn it sends, only to a process that offers it, a provider's route with it", async () => {
  chat.open("");
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(7), title: "New chat", temporary: false, fallback: "glm-5.3:cloud" });
  const sendIt = () => panel.say({ type: "send", text: "Hi.", model: "fixture", thinking: "", search: "auto" });
  sendIt();
  assert.equal("fallback" in last("chatdgc_send"), false, "an older process: never sent");
  host.offers = { version: 1, fallback: 1 };
  sendIt();
  assert.equal(last("chatdgc_send").fallback, "glm-5.3:cloud", "the chat's own, as it opened");
  panel.say({ type: "fallback", value: "" });
  sendIt();
  assert.equal(last("chatdgc_send").fallback, "", "none chosen: none");
  const spare = `provider_${"c".repeat(32)}`;
  host.chatdgcProviderRoute = async (model) => ({ id: spare, base_url: "https://spare.example/v1", api_key: "k", api_mode: "chat", asked: model });
  panel.say({ type: "fallback", value: `provider:${spare}:gpt-oss:120b` });
  sendIt();
  await new Promise((r) => setImmediate(r));
  const turn = last("chatdgc_send");
  assert.equal(turn.fallback, `provider:${spare}:gpt-oss:120b`);
  assert.equal(turn.fallback_provider.base_url, "https://spare.example/v1", "its saved provider's route, for this turn only");
  assert.equal(panel.last("fallbackOffered")?.type, "fallbackOffered");
});

test("a chat's wake-ups (0.52): its row reaches its tab, a due one is sent as its turn with the chat's route, Cancel takes one back; never to a process that doesn't offer them", async () => {
  chat.open("");
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(8), title: "New chat", temporary: false });
  const row = [{ id: "wake3", at: "2026-11-11T14:30:00+05:30", why: "Check the build" }];
  chat.onEvent({ type: "chatdgc_wakeups", conversation_id: ID(8), items: row });
  assert.deepEqual(panel.last("wakeups"), { type: "wakeups", items: row }, "the pill's row, for the tab showing it");
  const before = sent.length;
  chat.onEvent({ type: "chatdgc_wakeup_due", conversation_id: ID(8), id: "wake3", model: "fixture" });
  panel.say({ type: "cancelWakeup", id: "wake3" });
  assert.equal(sent.length, before, "an older process: nothing sent");
  host.offers = { version: 1, wakeups: 1 };
  chat.onEvent({ type: "chatdgc_wakeup_due", conversation_id: ID(8), id: "wake3", model: "fixture" });
  const wake = last("chatdgc_wake");
  assert.deepEqual({ ...wake, request_id: "" }, { type: "chatdgc_wake", conversation_id: ID(8), id: "wake3", model: "fixture", request_id: "" });
  assert.match(wake.request_id, /^cd-wake-\d+$/);
  // A chat on a saved provider: its route goes with the wake-up's turn, as with any turn (the key lives here).
  const saved = `provider_${"d".repeat(32)}`;
  host.chatdgcProviderRoute = async (model) => ({ id: saved, base_url: "https://ollama.com", api_key: "k", api_mode: "ollama", asked: model });
  chat.onEvent({ type: "chatdgc_wakeup_due", conversation_id: ID(8), id: "wake4", model: `provider:${saved}:glm-5.3` });
  await new Promise((r) => setImmediate(r));
  assert.equal(last("chatdgc_wake").provider.base_url, "https://ollama.com");
  panel.say({ type: "cancelWakeup", id: "wake3" });
  assert.deepEqual(last("chatdgc_cancel_wakeup"), { type: "chatdgc_cancel_wakeup", conversation_id: ID(8), id: "wake3" });
  const count = sent.length;
  panel.say({ type: "cancelWakeup", id: "../../x" });
  chat.onEvent({ type: "chatdgc_wakeup_due", conversation_id: "not-a-chat", id: "wake5" });
  assert.equal(sent.length, count, "nothing but a chat's own wake-up id goes");
  // A refused wake (gone, or not due) says nothing on the screen: the row is said again.
  const errorsBefore = panel.webview.posted.filter((m) => m.type === "error").length;
  chat.onEvent({ type: "chatdgc_error", request_id: wake.request_id, conversation_id: ID(8), message: "That wake-up isn't due yet, or has gone." });
  assert.equal(panel.webview.posted.filter((m) => m.type === "error").length, errorsBefore);
  chat.onEvent({ type: "chatdgc_wakeups", conversation_id: ID(8), items: [] });
  assert.deepEqual(panel.last("wakeups"), { type: "wakeups", items: [] });
});

// A widget's tab wears its Folio (the maintainer's own mark for a widget, media/shared/folio.css): the still PNG of the
// palette the widget wears, as a session's tab wears its Voxel or Mote. The palette is kept by the widget's id, with the
// sessions' (src/dock.ts), from the moment a list gives it one.
test("a widget's tab icon is its Folio's PNG, in the palette the widget wears, and follows it; a chat's own tab is its Mote's", async () => {
  const kept = new Map(), globalState = { get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, JSON.parse(JSON.stringify(v))); } };
  kept.set("dgc.sessionPalettesSince", 1);
  const c = new ChatDGC({ extensionUri: { fsPath: root, toString: () => root }, globalState });
  c.attach(host);
  host.offers = { version: 1, widget_library: 1 };
  const png = (name) => `data:image/png;base64,${readFileSync(join(root, "media", "session-icons", `${name}.png`)).toString("base64")}`;
  const marks = createRequire(import.meta.url)(join(root, "media", "shared", "marks.js"));
  c.openLibrary();
  const library = world.panels.at(-1);
  library.say({ type: "ready" });
  assert.equal(library.last("dock").since, 1, "the Library is told what each widget wears, and since when");
  const W = (n) => ({ chat_id: ID(7), id: `wg_${String(n).repeat(16)}`, title: `Widget ${n}`, message_id: MSG(2), created_at: "2026-10-11T10:00:00Z", chat_title: "Loan" });
  const open = (w) => {
    library.say({ type: "widgetOpen", widget: w });
    const get = last("chatdgc_widgets");
    c.onEvent({ type: "chatdgc_widgets", request_id: get.request_id, op: "get", conversation_id: w.chat_id, widget_id: w.id, widget: { id: w.id, title: w.title, html: "<i>w</i>", at: 0, message_id: MSG(2) } });
    return world.panels.at(-1);
  };
  // Opened before any list has drawn it: the palette its id alone gives, the same every time.
  const first = open(W(1));
  assert.equal(first.viewType, CHATDGC_WIDGET);
  assert.equal(String(first.iconPath), png(`folio-${marks.fallback("widget", W(1).id)}`), "its Folio, as a PNG inside the URI");
  assert.doesNotMatch(String(first.iconPath), /media|file:/, "nothing names the extension's folder");
  // The Library draws its Widgets tab: each widget is given the first palette its neighbours don't wear, and it is kept.
  library.say({ type: "dockPalettes", kind: "widget", list: [1, 2, 3].map((n) => ({ id: W(n).id })) });
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual([1, 2, 3].map((n) => kept.get("dgc.sessionPalettes")[`widget:${W(n).id}`]), ["ember", "peach", "saffron"], "kept by the widget's id, with the sessions' palettes");
  assert.equal(String(first.iconPath), png("folio-ember"), "the open tab follows");
  assert.deepEqual([1, 2, 3].map((n) => library.last("dock").colours[`widget:${W(n).id}`]), ["ember", "peach", "saffron"], "and the page is told");
  const second = open(W(2)), third = open(W(3));
  assert.deepEqual([String(second.iconPath), String(third.iconPath)], [png("folio-peach"), png("folio-saffron")], "widgets side by side look different");
  // "A reload": a new ChatDGC over the same kept state gives the same widget the same Folio.
  const again = new ChatDGC({ extensionUri: { fsPath: root, toString: () => root }, globalState });
  again.attach(host);
  again.openLibrary();
  const library2 = world.panels.at(-1);
  library2.say({ type: "widgetOpen", widget: W(2) });
  const get = last("chatdgc_widgets");
  again.onEvent({ type: "chatdgc_widgets", request_id: get.request_id, op: "get", conversation_id: ID(7), widget_id: W(2).id, widget: { id: W(2).id, title: "Widget 2", html: "<i>w</i>", at: 0, message_id: MSG(2) } });
  assert.equal(String(world.panels.at(-1).iconPath), png("folio-peach"));
  // A ```widget block has no id: its tab still wears a Folio, one of the twelve, by its page.
  const panel = (c.open(ID(7)), world.panels.at(-1));
  panel.say({ type: "ready" });
  c.onEvent({ type: "chatdgc_opened", request_id: last("chatdgc_open").request_id, conversation: { id: ID(7), title: "Loan" }, messages: [] });
  panel.say({ type: "widgetOpen", html: "<i>fence</i>", title: "Tip calculator" });
  const fenced = world.panels.at(-1);
  assert.equal(fenced.title, "Tip calculator");
  assert.match(String(fenced.iconPath), /^data:image\/png;base64,/);
  assert.ok(marks.PALETTES.some((name) => String(fenced.iconPath) === png(`folio-${name}`)), "one of the twelve Folios");
  // The chat's own tab wears its Mote, never a Folio.
  assert.equal(String(panel.iconPath), png(`mote-${marks.fallback("chat", ID(7))}`));
  c.dispose(); again.dispose();
});

// ---- "New" means not seen (13 Nov, after midnight) ----
test("the home's Chat list says which chats are watched: their tab in front, in a window that has the focus", async () => {
  const focus = (focused) => { globalThis.__DGC_TEST_VSCODE.window.state.focused = focused; for (const listener of [...(world.onWindow || [])]) listener({ focused }); };
  const listNow = () => { chat.homeRefresh(); const ask = last("chatdgc_list"); chat.onEvent({ type: "chatdgc_chats", request_id: ask.request_id, total: 2, next_offset: null, chats: [{ id: ID(7), title: "One" }, { id: ID(8), title: "Two" }] }); return host.home.at(-1); };
  try {
    chat.open(ID(7)); world.panels[0].say({ type: "ready" }); opened(world.panels[0], { id: ID(7), title: "One" });
    chat.open(ID(8)); world.panels[1].say({ type: "ready" }); opened(world.panels[1], { id: ID(8), title: "Two" });
    const [one, two] = world.panels;
    one.visible = false; one.active = false;                       // the second tab is in front of the first
    assert.deepEqual(listNow().watched, [ID(8)], "only the chat whose tab is in front");
    // The other tab comes to the front: the home is told by itself.
    const before = sent.filter((c) => c.type === "chatdgc_list").length;
    two.visible = false; two.active = false; one.visible = true; one.focus(true);
    await new Promise((r) => setTimeout(r, 320));
    assert.ok(sent.filter((c) => c.type === "chatdgc_list").length > before, "a tab coming to the front refreshes the home's list");
    assert.deepEqual(listNow().watched, [ID(7)]);
    // The window loses its focus: nothing is watched. It comes back: the tab in front is watched again, and the home is told.
    focus(false);
    assert.deepEqual(listNow().watched, [], "a tab in front of a window nobody is looking at is not watched");
    const mid = sent.filter((c) => c.type === "chatdgc_list").length;
    focus(true);
    await new Promise((r) => setTimeout(r, 320));
    assert.ok(sent.filter((c) => c.type === "chatdgc_list").length > mid, "the focus coming back refreshes the home's list");
    assert.deepEqual(listNow().watched, [ID(7)]);
  } finally { globalThis.__DGC_TEST_VSCODE.window.state.focused = true; }
});

// ---- Archive for chats, the home's side (0.52, 13 Nov): a chat's "…" on the Chat list archives it, the page is told
// so it can offer Undo, and the archived chats are listed with the list (chatdgc_list {archived: true}), each with
// Restore (chatdgc_update {archived: false}) and Delete (as any chat's).
test("the home's Chat list: Archive from a row, Undo, and the archived chats with Restore and Delete", async () => {
  chat.homeRefresh();
  const lists = () => sent.filter((c) => c.type === "chatdgc_list");
  const archivedAsk = lists().find((c) => c.archived === true);
  assert.deepEqual({ ...archivedAsk, request_id: "" }, { type: "chatdgc_list", archived: true, limit: 50, request_id: "" });
  assert.equal(last("chatdgc_list").archived, undefined, "the list itself is asked for as it was");
  chat.onEvent({ type: "chatdgc_chats", request_id: archivedAsk.request_id, total: 61, next_offset: 50,
    chats: [{ id: ID(3), title: "Old trip", archived: true, updated_at: "2026-10-01T09:00:00Z" }, { id: "../x", title: "bad" }] });
  assert.deepEqual(host.home.at(-1), { type: "chatdgc_archived", total: 61, more: true, items: [{ id: ID(3), title: "Old trip", archived: true, updated_at: "2026-10-01T09:00:00Z" }] });
  // Archive: its tab closes, DGC is told, and the page can offer Undo.
  chat.open(ID(7));
  world.panels[0].say({ type: "ready" }); opened(world.panels[0], { id: ID(7), title: "Open one" });
  assert.equal(await chat.homeMessage({ type: "chatdgcArchive", id: ID(7), title: "Open one" }), true);
  assert.deepEqual({ ...last("chatdgc_update"), request_id: "" }, { type: "chatdgc_update", conversation_id: ID(7), archived: true, request_id: "" });
  assert.equal(world.panels[0].disposedCount, 1, "its tab closes, as the chat's own menu closes it");
  assert.deepEqual(host.home.at(-1), { type: "chatdgc_note", kind: "archived", id: ID(7), title: "Open one" });
  assert.deepEqual(world.warnings, [], "no question: it can be undone");
  // Undo (the one just archived) and Restore (one DGC listed as archived).
  await chat.homeMessage({ type: "chatdgcRestore", id: ID(7), title: "Open one" });
  assert.deepEqual({ ...last("chatdgc_update"), request_id: "" }, { type: "chatdgc_update", conversation_id: ID(7), archived: false, request_id: "" });
  await chat.homeMessage({ type: "chatdgcRestore", id: ID(3), title: "Old trip" });
  assert.equal(last("chatdgc_update").conversation_id, ID(3));
  const before = sent.filter((c) => c.type === "chatdgc_update").length;
  await chat.homeMessage({ type: "chatdgcRestore", id: ID(9), title: "Never listed" });
  await chat.homeMessage({ type: "chatdgcArchive", id: "../x", title: "bad" });
  assert.equal(sent.filter((c) => c.type === "chatdgc_update").length, before, "never an id the page made up");
  // More of them, and a search looks through them too.
  await chat.homeMessage({ type: "chatdgcArchivedMore" });
  assert.equal(lists().filter((c) => c.archived).at(-1).limit, 100);
  await chat.homeMessage({ type: "chatdgcSearch", query: "trip" });
  assert.deepEqual([lists().filter((c) => c.archived).at(-1).query, lists().filter((c) => c.archived).at(-1).limit], ["trip", 50]);
  // Delete of an archived one asks first, as any chat's does.
  world.answer = "Delete";
  await chat.homeMessage({ type: "chatdgcDelete", id: ID(3), title: "Old trip" });
  assert.deepEqual({ ...last("chatdgc_update"), request_id: "" }, { type: "chatdgc_update", conversation_id: ID(3), delete: true, request_id: "" });
  assert.equal(world.warnings.length, 1);
});

// ---- the side bar's Library tab (0.52, 15 Nov): the Library's own host answers it, through the side bar
test("the side bar's Library tab is answered by the Library's host as its editor tab is (one module draws both): its lists, a row opened or removed, what changed; never a pin", async () => {
  const hub = fakeArtifacts();
  const made = { id: "ar_" + "1".repeat(16), type: "page", title: "Open invoices", made_by: { kind: "pip", id: "pip_" + "b".repeat(32), name: "Tile checker" }, made_as: "card" };
  hub.list = async () => [made];
  chat.useArtifacts(hub);
  const side = (type) => host.home.filter((m) => m.type === "sideLibrary" && m.message.type === type).map((m) => m.message);
  await chat.sideLibrary({ type: "ready" });
  assert.deepEqual(side("artifactsOffered"), [{ type: "artifactsOffered", on: true }]);
  assert.equal(last("chatdgc_library").limit, 60, "the files are asked for as the full Library asks");
  chat.onEvent({ type: "chatdgc_library", request_id: last("chatdgc_library").request_id, files: [{ id: "att_" + "3".repeat(32), name: "map.png", type: "image", source: "chat", chat_id: ID(1) }], total: 1, next_offset: null, counts: {} });
  assert.equal(side("library")[0].files[0].name, "map.png");
  await chat.sideLibrary({ type: "artifactList" });
  assert.deepEqual(side("artifacts")[0].items, [made], "each item with who made it and what made it");
  await chat.sideLibrary({ type: "artifactOpen", artifact: { id: made.id, type: "page", title: "Open invoices" } });
  assert.deepEqual(hub.opened, [[made.id, { type: "page", title: "Open invoices" }]], "a row opens in an editor tab, as the full Library's does");
  await chat.sideLibrary({ type: "open", file: { id: "att_" + "3".repeat(32), source: "chat", chat_id: ID(1) } });
  assert.equal(world.panels.length, 1, "a chat's file opens the chat it is in");
  // The tab asks what the editor tab asks, checked the same way: a removal asks you first, there as here.
  hub.answer = false;
  await chat.sideLibrary({ type: "artifactRemove", artifact: { id: made.id, title: "Open invoices" } });
  assert.deepEqual(hub.removed, [{ id: made.id, title: "Open invoices" }], "asked first");
  assert.deepEqual(side("artifactRemoved"), [], "you said no: it stays");
  hub.answer = true;
  await chat.sideLibrary({ type: "artifactRemove", artifact: { id: made.id, title: "Open invoices" } });
  assert.deepEqual(side("artifactRemoved"), [{ type: "artifactRemoved", id: made.id }], "you said yes: the tab is told");
  await chat.sideLibrary({ type: "artifactExport", artifact: { id: made.id, title: "Open invoices", type: "page", exports: ["html"] }, format: "html" });
  assert.equal(hub.exported.at(-1)[1], "html");
  world.answer = undefined;
  await chat.sideLibrary({ type: "remove", file: { id: "att_" + "3".repeat(32), name: "map.png", source: "chat", chat_id: ID(1) } });
  assert.equal(world.warnings.length, 1, "a file's delete asks first too"); assert.equal(last("chatdgc_library_file"), undefined, "not answered: nothing is deleted");
  // Every image, with who made it; every video.
  host.imagesOffered = () => true;
  host.imagesLibrary = async (cmd) => ({ type: "images_library", images: [{ path: "/home/me/.dgc/images/chat/a.png", prompt: "a", surface: "chat", made_by: { kind: "chat", id: ID(1), name: "Goa" } }], total: 1, next_offset: null, asked: cmd });
  await chat.sideLibrary({ type: "workImages", seq: 1, offset: 0, limit: 60 });
  assert.deepEqual(side("workImages")[0].images[0].made_by, { kind: "chat", id: ID(1), name: "Goa" });
  // Never a pin (the side bar's own dock answers those), nor a maker's name or the settings (the side bar opens them itself).
  const before = host.home.length, shown = [];
  host.openSettings = (section) => shown.push(section); host.openMaker = (maker) => shown.push(maker);
  await chat.sideLibrary({ type: "dockToggle", item: { kind: "artifact", id: made.id, title: "x" } });
  await chat.sideLibrary({ type: "maker", maker: { kind: "session", id: "s-1", name: "x" } });
  await chat.sideLibrary({ type: "settings", section: "security" });
  assert.equal(host.home.length, before); assert.deepEqual(shown, []);
  delete host.imagesOffered; delete host.imagesLibrary; delete host.openSettings; delete host.openMaker;
  // An artifact made or changed anywhere: the tab hears it.
  hub.tell({ type: "artifactChanged", artifact: { id: made.id, type: "page", version: 2 }, op: "changed" });
  assert.deepEqual(side("artifactChanged").at(-1), { type: "artifactChanged", artifact: { id: made.id, type: "page", version: 2 }, op: "changed" });
  // Nothing in the side bar opens the full Library by the old messages any more.
  assert.equal(await chat.homeMessage({ type: "chatdgcLibrary" }), false);
  assert.equal(world.panels.filter((p) => p.viewType === CHATDGC_LIBRARY).length, 0);
});

// ---- Favorites in the Library (0.52): through the Library's real host and its side bar allowlist
test("Favorites: the side bar's tab and the editor tab star only what the Library was shown, DGC keeps the list, and both pages and Home's Artifacts card hear it", async () => {
  const wait = () => new Promise((done) => setTimeout(done, 5));
  const A1 = { id: "ar_" + "1".repeat(16), type: "doc", title: "Launch notes", updated: "2026-11-19T10:00:00Z" }, A2 = { id: "ar_" + "2".repeat(16), type: "sheet", title: "Acme sales", updated: "2026-11-18T10:00:00Z" };
  const hub = fakeArtifacts();
  hub.list = async () => [A1, A2];
  chat.useArtifacts(hub);
  // DGC's own list (dgc/favorites.py), as the editor's panel reaches it: no argument reads, a change stars or clears.
  let kept = []; const changes = [];
  host.favoritesOffered = () => true;
  host.favorites = async (change) => {
    if (change) {
      changes.push(change);
      if (change.id === A2.id && change.on) throw new Error("That item isn't in the Library any more.");
      kept = kept.filter((r) => !(r.kind === change.kind && r.id === change.id));
      if (change.on) kept.push({ kind: change.kind, id: change.id, at: "2026-11-19T00:00:00Z" });
    }
    return { type: "favorites", items: kept.map((r) => ({ ...r })) };
  };
  const side = (type) => host.home.filter((m) => m.type === "sideLibrary" && m.message.type === type).map((m) => m.message);
  const homeCard = () => host.home.filter((m) => m.type === "homeArtifacts").at(-1);
  // The side bar's tab is told the list with what else it is told when it is ready, and again when it asks.
  await chat.sideLibrary({ type: "ready" }); await wait();
  assert.deepEqual(side("favorites"), [{ type: "favorites", offered: true, keys: [] }]);
  // An artifact the Library was not shown yet is nothing to star: DGC is never asked.
  await chat.sideLibrary({ type: "favorite", item: { kind: "artifact", id: A1.id }, on: true }); await wait();
  assert.deepEqual(changes, []);
  await chat.sideLibrary({ type: "artifactList" }); await wait();
  await chat.sideLibrary({ type: "favorite", item: { kind: "artifact", id: A1.id }, on: true }); await wait();
  assert.deepEqual(changes, [{ kind: "artifact", id: A1.id, on: true }], "its kind, its id, on: nothing else of it");
  assert.deepEqual(side("favorites").at(-1), { type: "favorites", offered: true, keys: [`artifact:${A1.id}`] }, "by the row's key");
  assert.deepEqual(homeCard().items.map((a) => [a.id, a.favorite === true]), [[A1.id, true], [A2.id, false]], "Home's Artifacts card hears which are favorites");
  assert.equal(homeCard().favorites, true, "and that this DGC keeps them (its star shows)");
  // Nothing the page made up reaches DGC: an id never listed, a path, a kind there is none of, a star neither on nor off.
  const before = changes.length;
  for (const item of [{ kind: "artifact", id: "ar_" + "9".repeat(16) }, { kind: "image", path: "/etc/passwd" }, { kind: "video", path: "/home/me/x.mp4" }, { kind: "pip", id: "pip_" + "a".repeat(32) },
    { kind: "workfile", ref: "wa_" + "1".repeat(16) }, { kind: "chart", id: "msg_" + "a".repeat(32) + ":0", chat_id: ID(1) }, { kind: "file", id: "att_" + "3".repeat(32), source: "chat", chat_id: ID(1) },
    { kind: "widget", id: "wg_zz", chat_id: ID(1) }, { kind: "widget", id: "wg_" + "4".repeat(16), chat_id: "nope" }, null, "artifact"]) {
    await chat.sideLibrary({ type: "favorite", item, on: true }); await wait();
  }
  await chat.sideLibrary({ type: "favorite", item: { kind: "artifact", id: A1.id }, on: "yes" }); await wait();
  await chat.sideLibrary({ type: "favorite", item: { kind: "artifact", id: A1.id } }); await wait();
  assert.equal(changes.length, before, "none of them asked of DGC");
  // What the Library was shown can be: an image images_library listed (by its path), a chat's file, a widget by its ids.
  host.imagesOffered = () => true;
  host.imagesLibrary = async () => ({ type: "images_library", images: [{ path: "/home/me/.dgc/images/chat/a.png", prompt: "a", surface: "chat" }], total: 1, next_offset: null });
  await chat.sideLibrary({ type: "workImages", seq: 1, offset: 0, limit: 60 }); await wait();
  await chat.sideLibrary({ type: "favorite", item: { kind: "image", path: "/home/me/.dgc/images/chat/a.png" }, on: true }); await wait();
  chat.onEvent({ type: "chatdgc_library", request_id: last("chatdgc_library").request_id, files: [{ id: "att_" + "3".repeat(32), name: "map.png", type: "image", source: "chat", chat_id: ID(1) }], total: 1, next_offset: null, counts: {} });
  await chat.sideLibrary({ type: "favorite", item: { kind: "file", id: "att_" + "3".repeat(32), source: "chat", chat_id: ID(1) }, on: true }); await wait();
  await chat.sideLibrary({ type: "favorite", item: { kind: "file", id: "att_" + "3".repeat(32), source: "chat", chat_id: ID(2) }, on: true }); await wait();     // (the file, named in another chat: not it)
  await chat.sideLibrary({ type: "favorite", item: { kind: "widget", id: "wg_" + "4".repeat(16), chat_id: ID(1) }, on: true }); await wait();
  assert.deepEqual(changes.slice(before), [{ kind: "image", id: "/home/me/.dgc/images/chat/a.png", on: true }, { kind: "file", id: "att_" + "3".repeat(32), on: true }, { kind: "widget", id: "wg_" + "4".repeat(16), on: true }]);
  assert.deepEqual(side("favorites").at(-1).keys, [`artifact:${A1.id}`, "image:/home/me/.dgc/images/chat/a.png", "file:att_" + "3".repeat(32), "widget:wg_" + "4".repeat(16)]);
  // The Library's editor tab is the same host: told the list when ready, and it hears a star set in the side bar.
  chat.openLibrary();
  const lib = world.panels.find((p) => p.viewType === CHATDGC_LIBRARY);
  lib.say({ type: "ready" }); await wait();
  assert.equal(lib.last("favorites").keys.length, 4, "the editor tab reads the same list");
  lib.say({ type: "favorite", item: { kind: "artifact", id: A1.id }, on: false }); await wait();
  assert.deepEqual(changes.at(-1), { kind: "artifact", id: A1.id, on: false });
  assert.equal(lib.last("favorites").keys.includes(`artifact:${A1.id}`), false);
  assert.equal(side("favorites").at(-1).keys.includes(`artifact:${A1.id}`), false, "the side bar's tab hears a star taken off in the editor tab");
  assert.deepEqual(homeCard().items.map((a) => a.favorite === true), [false, false]);
  // DGC refuses one (gone since it was listed): the person is told why, and the page the list as it is.
  const said = lib.webview.posted.filter((m) => m.type === "favorites").length;
  lib.say({ type: "favorite", item: { kind: "artifact", id: A2.id }, on: true }); await wait();
  assert.match(world.warnings.at(-1), /couldn't be added to your Favorites: That item isn't in the Library any more\./);
  assert.equal(lib.webview.posted.filter((m) => m.type === "favorites").length, said + 1, "its star goes back");
  assert.equal(lib.last("favorites").keys.includes(`artifact:${A2.id}`), false);
  // Removed from the Library, it is no favorite any more.
  lib.say({ type: "favorite", item: { kind: "artifact", id: A1.id }, on: true }); await wait();
  hub.answer = true;
  lib.say({ type: "itemAct", act: "remove", item: { kind: "artifact", id: A1.id } }); await wait(); await wait();
  assert.deepEqual(changes.at(-1), { kind: "artifact", id: A1.id, on: false }, "its star goes with it");
  // An older DGC keeps none: the pages are told so (no star, no filter), and nothing is asked of it.
  host.favoritesOffered = () => false;
  const asked = changes.length;
  await chat.sideLibrary({ type: "favorites" }); await wait();
  assert.deepEqual(side("favorites").at(-1), { type: "favorites", offered: false, keys: [] });
  await chat.sideLibrary({ type: "favorite", item: { kind: "widget", id: "wg_" + "4".repeat(16), chat_id: ID(1) }, on: true }); await wait();
  assert.equal(changes.length, asked);
  await chat.homeCardsMessage({ type: "homeArtifactsGet" }); await wait();
  assert.equal("favorites" in homeCard(), false, "and Home's card has no star");
});

test("Home's Artifacts card is given every favorite, however old: the newest sixty and the favorites after them", async () => {
  const hub = fakeArtifacts();
  const all = Array.from({ length: 70 }, (_, n) => ({ id: "ar_" + String(n).padStart(16, "0"), type: "page", title: `Page ${n}`, updated: new Date(Date.UTC(2026, 10, 19) - n * 3600000).toISOString() }));
  hub.list = async () => all;
  chat.useArtifacts(hub);
  host.favoritesOffered = () => true;
  host.favorites = async () => ({ type: "favorites", items: [{ kind: "artifact", id: all[65].id }, { kind: "artifact", id: all[3].id }, { kind: "image", id: "/x.png" }] });
  await chat.homeCardsMessage({ type: "homeArtifactsGet" });
  const card = host.home.filter((m) => m.type === "homeArtifacts").at(-1);
  assert.equal(card.items.length, 61); assert.equal(card.more, true); assert.equal(card.favorites, true);
  assert.deepEqual(card.items.filter((a) => a.favorite).map((a) => a.id), [all[3].id, all[65].id]);
});

test("the Library's editor tab: his Iris books on its tab, opened on the tab asked for, a maker's name leads back, ⋯ opens the settings", async () => {
  const shown = [];
  host.openSettings = (section) => shown.push(["settings", section]); host.openMaker = (maker) => shown.push(["maker", maker]);
  try {
    // "Open the Library in the editor", from the side bar's Library, on the tab it was on.
    await chat.homeCardsMessage({ type: "homeLibraryOpen", view: "images" });
    const lib = world.panels.find((p) => p.viewType === CHATDGC_LIBRARY);
    assert.ok(lib, "the Library opened in a tab of its own");
    for (const tone of ["light", "dark"]) assert.match(String(lib.iconPath[tone].fsPath || lib.iconPath[tone].path || lib.iconPath[tone]), /media[\\/]icons[\\/]library-iris[\\/]png[\\/]library-iris-32\.png$/, `its tab icon is his PNG (${tone})`);
    lib.say({ type: "ready" });
    assert.deepEqual(lib.last("view"), { type: "view", view: "images" });
    await chat.homeCardsMessage({ type: "homeLibraryOpen", view: "videos" });
    assert.deepEqual(lib.last("view"), { type: "view", view: "videos" }, "already open: shown on the tab asked for");
    await chat.homeCardsMessage({ type: "homeLibraryOpen", view: "../x" });
    assert.deepEqual(lib.last("view"), { type: "view", view: "videos" }, "never a tab the page made up");
    assert.equal(world.panels.filter((p) => p.viewType === CHATDGC_LIBRARY).length, 1, "one Library tab");
    // A maker's name: a chat opens here; a session and a Pip are the window's to open; nothing else is.
    const tabs = world.panels.length;
    lib.say({ type: "maker", maker: { kind: "chat", id: ID(4), name: "Goa" } });
    assert.equal(world.panels.length, tabs + 1, "the chat that made it opens");
    lib.say({ type: "maker", maker: { kind: "session", id: "20261106-101500-a1", name: "Fix totals" } });
    lib.say({ type: "maker", maker: { kind: "pip", id: "pip_" + "b".repeat(32), name: "Tile checker" } });
    lib.say({ type: "maker", maker: { kind: "pip", id: "../x", name: "x" } });
    lib.say({ type: "maker", maker: { kind: "cli", id: "", name: "" } });
    lib.say({ type: "settings", section: "security" });
    await tick();
    assert.deepEqual(shown, [["maker", { kind: "session", id: "20261106-101500-a1", name: "Fix totals" }], ["maker", { kind: "pip", id: "pip_" + "b".repeat(32), name: "Tile checker" }], ["settings", "security"]]);
  } finally { delete host.openSettings; delete host.openMaker; }
});

// ---- an item's menu in the Library (0.52, 15 Nov): one route to the host, "itemAct" -----------------------------------------------
// The page names an item (its kind and its id or path) and one of the eight things; the host does it only for an item
// the Library was shown, from its OWN record of it: never a path, a title or content the page sent.
test("an item's menu asks one way (itemAct): each of the eight is done only for an item the Library was shown, from the host's own record of it", async () => {
  const vs = globalThis.__DGC_TEST_VSCODE, fs = vs.workspace.fs, kept = { readFile: fs.readFile, copy: fs.copy, delete: fs.delete, status: vs.window.setStatusBarMessage };
  const read = [], copied = [], trashed = [], files = {};
  fs.readFile = async (uri) => { read.push(uri.fsPath); if (!(uri.fsPath in files)) throw new Error("ENOENT"); return Buffer.from(files[uri.fsPath]); };
  fs.copy = async (from, to) => { copied.push([from.fsPath, to.fsPath]); };
  fs.delete = async (uri, options) => { trashed.push([uri.fsPath, options]); };
  vs.window.setStatusBarMessage = () => ({ dispose() {} });
  const wait = () => new Promise((r) => setTimeout(r, 8));
  const ar = (c) => "ar_" + c.repeat(16), att = (c) => "att_" + c.repeat(32);
  const DOC = { id: ar("3"), type: "doc", title: "Launch notes", version: 4, file: `/home/me/.dgc/artifacts/${ar("3")}/work/Launch notes.md`, exports: ["docx", "pdf", "md"] };
  const PAGE = { id: ar("1"), type: "page", title: "Tide pool walk", version: 1, exports: ["html"] };
  const hub = Object.assign(fakeArtifacts(), { renamed: [], detailed: [], async list() { return [DOC, PAGE]; },
    async detail(id) { this.detailed.push(id); return id === DOC.id ? { view: DOC, content: "# Launch\n\nOn the 3rd." } : undefined; },
    async rename(view) { this.renamed.push(view); return true; } });
  chat.useArtifacts(hub);
  chat.openLibrary();
  const lib = world.panels.at(-1);
  lib.say({ type: "ready" });
  const act = async (what, item) => { lib.say({ type: "itemAct", act: what, item }); await wait(); };
  const said = () => lib.webview.posted.filter((m) => m.type === "itemSaid").map((m) => m.words);
  try {
    // ---- artifacts: nothing is done for one the Library was not shown
    await act("path", { kind: "artifact", id: DOC.id });
    assert.equal(world.clipboard, "", "the Library has listed nothing yet: nothing is copied");
    lib.say({ type: "artifactList" }); await wait();
    await act("path", { kind: "artifact", id: DOC.id, file: "/etc/passwd", title: "x" });
    assert.equal(world.clipboard, DOC.file, "Copy path: the doc's own file, as the host knows it (never a path the page sent)");
    assert.deepEqual(said(), ["Path copied"]);
    await act("reveal", { kind: "artifact", id: DOC.id, file: "/etc" });
    assert.deepEqual([world.commands.at(-1)[0], world.commands.at(-1)[1].fsPath], ["revealFileInOS", DOC.file], "Reveal in file manager: VS Code's own");
    await act("copy", { kind: "artifact", id: DOC.id });
    assert.deepEqual(hub.detailed, [DOC.id]);
    assert.equal(world.clipboard, "# Launch\n\nOn the 3rd.", "Copy: a doc's text");
    assert.equal(said().at(-1), "Text copied");
    await act("editor", { kind: "artifact", id: DOC.id });
    assert.equal(world.shown.at(-1).path, DOC.file, "Open in editor: its Markdown file in an editor tab");
    await act("open", { kind: "artifact", id: DOC.id });
    assert.deepEqual(hub.opened.at(-1), [DOC.id, { type: "doc", title: "Launch notes", file: DOC.file }]);
    // Save a copy…: the formats the editor offers for its kind, then its own save dialog (Artifacts.exportArtifact).
    world.choose = (items) => { world.picks.push(items.map((i) => i.label)); return items.find((i) => i.format === "pdf"); };
    await act("save", { kind: "artifact", id: DOC.id });
    assert.deepEqual(world.picks.at(-1), ["Word document (.docx)", "PDF", "Markdown (.md)"]);
    assert.deepEqual([hub.exported.at(-1)[0].id, hub.exported.at(-1)[1]], [DOC.id, "pdf"]);
    const picks = world.picks.length;
    await act("save", { kind: "artifact", id: PAGE.id });
    assert.deepEqual([hub.exported.at(-1)[0].id, hub.exported.at(-1)[1], world.picks.length], [PAGE.id, "html", picks], "a page is saved as .html: one format, no question");
    world.choose = undefined;
    await act("rename", { kind: "artifact", id: DOC.id, title: "Not this" });
    assert.deepEqual(hub.renamed, [{ id: DOC.id, title: "Launch notes", type: "doc" }], "Rename: the hub asks for the new name (Artifacts.rename)");
    // What a page cannot do is not done, whatever the page asks.
    const before = { clip: world.clipboard, commands: world.commands.length, shown: world.shown.length, detailed: hub.detailed.length };
    for (const what of ["path", "reveal", "copy", "editor", "rename"]) await act(what, { kind: "artifact", id: PAGE.id, file: DOC.file });
    assert.deepEqual({ clip: world.clipboard, commands: world.commands.length, shown: world.shown.length, detailed: hub.detailed.length }, before, "a page has no file and no text to copy");
    assert.equal(hub.renamed.length, 1, "and is not renamed from here");
    // An id that is an artifact's, but none the Library was shown; a thing that is not one of the eight.
    await act("remove", { kind: "artifact", id: ar("9") }); await act("open", { kind: "artifact", id: ar("9") }); await act("delete-everything", { kind: "artifact", id: DOC.id });
    assert.deepEqual([hub.removed.length, hub.opened.length], [0, 1]);
    hub.answer = true;
    await act("remove", { kind: "artifact", id: PAGE.id, title: "x" });
    assert.deepEqual(hub.removed, [{ id: PAGE.id, title: "Tide pool walk" }], "Remove asks first (Artifacts.remove: a modal), by the host's own title");
    assert.deepEqual(lib.last("artifactRemoved"), { type: "artifactRemoved", id: PAGE.id });

    // ---- images: a file on disk, by a path images_library listed
    const fox = "/home/me/app/assets/generated/fox.png";
    files[fox] = "png-bytes"; files["/home/me/app/assets/generated/fox.json"] = JSON.stringify({ prompt: "a red fox", file: "fox.png", made_by: "DGC" });
    host.imagesOffered = () => true;
    host.imagesLibrary = async () => ({ type: "images_library", images: [{ path: fox, prompt: "a red fox", surface: "work" }], total: 1, next_offset: null });
    await act("path", { kind: "image", path: fox });
    assert.notEqual(world.clipboard, fox, "not listed yet: not copied");
    lib.say({ type: "workImages", query: "", offset: 0, limit: 60, seq: 1 }); await wait();
    await act("path", { kind: "image", path: fox });
    assert.equal(world.clipboard, fox, "Copy path");
    await act("path", { kind: "image", path: "/home/me/.ssh/id_rsa.png" });
    assert.equal(world.clipboard, fox, "a path the Library wasn't given is never copied");
    await act("reveal", { kind: "image", path: fox }); await act("open", { kind: "image", path: fox }); await act("editor", { kind: "image", path: fox });
    assert.deepEqual(world.commands.slice(-3).map((c) => [c[0], c[1].fsPath]), [["revealFileInOS", fox], ["vscode.open", fox], ["vscode.open", fox]]);
    await act("copy", { kind: "image", path: fox });
    assert.deepEqual(lib.last("itemCopy"), { type: "itemCopy", key: `image:${fox}`, data: `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}` }, "Copy: the picture, handed to the page for the clipboard");
    await act("copy", { kind: "image", path: "/home/me/secret.png" });
    assert.ok(!read.includes("/home/me/secret.png"), "never one it wasn't given");
    world.saveAsked = undefined;
    await act("save", { kind: "image", path: fox });
    assert.equal(lib.last("dgcDownload")?.name, "fox.png", "Save a copy…: handed to the page, to save on the person's computer");
    assert.equal(world.saveAsked, undefined, "no save dialog");
    await act("rename", { kind: "image", path: fox });
    assert.equal(hub.renamed.length, 1, "an image is not renamed");
    world.answer = undefined; const warned = world.warnings.length;
    await act("remove", { kind: "image", path: fox });
    assert.equal(world.warnings.length, warned + 1, "Remove asks first"); assert.match(world.warnings.at(-1), /Remove “fox\.png”\?/);
    assert.deepEqual(trashed, [], "not answered: nothing is removed");
    world.answer = "Move to Trash";
    await act("remove", { kind: "image", path: fox });
    assert.deepEqual(trashed, [[fox, { useTrash: true }], ["/home/me/app/assets/generated/fox.json", { useTrash: true }]], "to the computer's trash, with the note DGC wrote beside it");
    assert.ok(lib.last("refresh"), "and the Library lists again");
    await act("path", { kind: "image", path: fox });
    assert.equal(said().filter((w) => w === "Path copied").length, 2, "removed: it is no longer one of the Library's");
    // A file beside it that is not DGC's own note is never touched.
    const owl = "/home/me/app/owl.png"; files[owl] = "x"; files["/home/me/app/owl.json"] = JSON.stringify({ name: "a project's own file" });
    host.imagesLibrary = async () => ({ type: "images_library", images: [{ path: owl, prompt: "an owl", surface: "work" }], total: 1, next_offset: null });
    lib.say({ type: "workImages", query: "", offset: 0, limit: 60, seq: 2 }); await wait();
    await act("remove", { kind: "image", path: owl });
    assert.deepEqual(trashed.slice(2), [[owl, { useTrash: true }]], "only the image");
    // The page could not put a picture on the clipboard: said in words.
    const w2 = world.warnings.length;
    lib.say({ type: "itemCopied", ok: false }); await wait();
    assert.equal(world.warnings.length, w2 + 1); assert.match(world.warnings.at(-1), /couldn't be copied/);
    lib.say({ type: "itemCopied", ok: true }); await wait();
    assert.equal(world.warnings.length, w2 + 1);

    // ---- videos: a path videos_library listed
    const clip = "/home/me/app/assets/clip.mp4";
    host.videosOffered = () => true;
    host.videosLibrary = async () => ({ type: "videos_library", videos: [{ path: clip, prompt: "tiles" }], total: 1, next_offset: null });
    lib.say({ type: "videoList", seq: 1, offset: 0 }); await wait();
    await act("path", { kind: "video", path: clip });
    assert.equal(world.clipboard, clip);
    await act("path", { kind: "video", path: "/home/me/private.mp4" });
    assert.equal(world.clipboard, clip, "a video the Library wasn't given is never named");
    await act("reveal", { kind: "video", path: clip }); await act("editor", { kind: "video", path: clip });
    assert.deepEqual(world.commands.slice(-2).map((c) => [c[0], c[1].fsPath]), [["revealFileInOS", clip], ["vscode.open", clip]]);
    world.saveAsked = undefined; files[clip] = "the clip";
    await act("save", { kind: "video", path: clip });
    assert.equal(lib.last("dgcDownload")?.name, "clip.mp4", "Save a copy…: handed to the page, to save on the person's computer");
    assert.equal(world.saveAsked, undefined, "no save dialog");
    const posted = lib.webview.posted.filter((m) => m.type === "itemCopy").length;
    await act("copy", { kind: "video", path: clip });
    assert.equal(lib.webview.posted.filter((m) => m.type === "itemCopy").length, posted, "a video is not put on the clipboard");
    world.answer = "Move to Trash";
    await act("remove", { kind: "video", path: clip });
    assert.deepEqual(trashed.at(-1), [clip, { useTrash: true }]);

    // ---- files: a chat's or a project's, by an id chatdgc_library listed
    const map = { id: att("3"), name: "map.png", type: "image", source: "chat", chat_id: ID(1) }, pdf = { id: att("4"), name: "review.pdf", type: "pdf", source: "chat", chat_id: ID(1) };
    const ref = (f) => ({ kind: "file", id: f.id, source: "chat", chat_id: f.chat_id });
    const count = (type) => sent.filter((c) => c.type === type).length;
    await act("copy", ref(map));
    assert.equal(count("chatdgc_file"), 0, "not listed yet: not read");
    chat.onEvent({ type: "chatdgc_library", request_id: last("chatdgc_library").request_id, files: [map, pdf], total: 2, next_offset: null, counts: {} });
    await act("copy", ref(map));
    assert.deepEqual({ ...last("chatdgc_file"), request_id: "" }, { type: "chatdgc_file", conversation_id: ID(1), attachment_id: map.id, request_id: "" });
    chat.onEvent({ type: "chatdgc_file", request_id: last("chatdgc_file").request_id, conversation_id: ID(1), attachment_id: map.id, data: "data:image/png;base64,AAAA" });
    assert.deepEqual(lib.last("itemCopy"), { type: "itemCopy", key: `file:${map.id}`, data: "data:image/png;base64,AAAA" });
    assert.equal(lib.webview.posted.filter((m) => m.type === "image" && m.id === map.id).length, 0, "(its answer is for the clipboard, not the row's picture)");
    await act("copy", ref(pdf)); await act("copy", { kind: "file", id: att("5"), source: "chat", chat_id: ID(1) }); await act("copy", { ...ref(map), chat_id: ID(2) });
    assert.equal(count("chatdgc_file"), 1, "a PDF has nothing to copy; a file the Library wasn't shown, or named in another chat, is not read");
    const clipboard = world.clipboard;
    await act("path", ref(map)); await act("reveal", ref(map)); await act("editor", ref(map)); await act("rename", ref(map));
    assert.equal(world.clipboard, clipboard, "a chat's file has no path of its own to copy");
    // Save a copy… (18 Nov): written into a private folder made for this download, for the Library's page to save.
    await act("save", ref(map));
    const saving = last("chatdgc_library_file");
    assert.deepEqual({ ...saving, path: "", request_id: "" }, { type: "chatdgc_library_file", op: "save", conversation_id: ID(1), attachment_id: map.id, path: "", request_id: "" });
    assert.match(saving.path, /dgc-download-[^/\\]+[/\\]map\.png$/);
    chat.onEvent({ type: "chatdgc_error", request_id: saving.request_id, message: "That file is no longer in your Library." });
    world.answer = undefined; const w3 = world.warnings.length, files3 = count("chatdgc_library_file");
    await act("remove", ref(map));
    assert.equal(world.warnings.length, w3 + 1, "Remove asks first"); assert.match(world.warnings.at(-1), /Delete “map\.png” from your Library\?/);
    assert.equal(count("chatdgc_library_file"), files3);
    const panels = world.panels.length;
    await act("open", ref(map));
    assert.equal(world.panels.length, panels + 1, "Open: the chat it is in");

    // ---- the side bar's Library tab asks the same way, and is answered the same way
    world.clipboard = "";
    await chat.sideLibrary({ type: "itemAct", act: "path", item: { kind: "artifact", id: DOC.id } }); await wait();
    assert.equal(world.clipboard, DOC.file);
    assert.deepEqual(host.home.filter((m) => m.type === "sideLibrary" && m.message.type === "itemSaid").map((m) => m.message.words), ["Path copied"]);
    await chat.sideLibrary({ type: "itemCopied", ok: false }); await wait();
    assert.match(world.warnings.at(-1), /couldn't be copied/);
  } finally {
    Object.assign(fs, { readFile: kept.readFile, copy: kept.copy, delete: kept.delete }); vs.window.setStatusBarMessage = kept.status;
    delete host.imagesOffered; delete host.imagesLibrary; delete host.videosOffered; delete host.videosLibrary; world.choose = undefined;
  }
});

// User test L2 (15 Nov): Home's Artifacts card said 5 over a Library → Artifacts of 4, and Home's Widgets card said
// "No widgets yet" over a Library → Widgets with one in it. Home counted a reply's card among its artifacts and listed
// only ChatDGC's own widgets; the Library's tabs put a reply's card under Widgets. Home's two cards now list what the
// Library's two tabs list.
test("L2: Home's Artifacts and Widgets cards list what the Library's tabs list: a reply's card is a widget, not an artifact", async () => {
  const ar = (c) => "ar_" + c.repeat(16), WG = "wg_" + "5".repeat(16);
  const made = [{ id: ar("1"), type: "dashboard", title: "Orders", version: 1, origin: { surface: "work" }, updated: "2026-11-15T20:02:00Z" },
    { id: ar("2"), type: "sheet", title: "Budget", version: 2, origin: { surface: "work" }, updated: "2026-11-15T19:59:00Z" },
    { id: ar("3"), type: "page", title: "UK heat pump tariffs, 2026", version: 1, made_as: "card", origin: { surface: "work" }, updated: "2026-11-15T05:10:00Z" },
    { id: ar("4"), type: "page", title: "EMI calculator", version: 1, made_as: "widget", origin: { surface: "chat" }, updated: "2026-11-14T05:10:00Z" }];
  chat.useArtifacts(Object.assign(fakeArtifacts(), { async list() { return made; } }));
  host.offers = { version: 1, widget_library: 1 };
  await chat.homeCardsMessage({ type: "homeArtifactsGet" });
  const artifacts = host.home.filter((m) => m.type === "homeArtifacts").at(-1);
  assert.deepEqual(artifacts.items.map((a) => a.title), ["Orders", "Budget"], "the two the Library's Artifacts tab lists: never a reply's card or a widget's page");
  await chat.homeCardsMessage({ type: "homeWidgetsGet" });
  const asked = last("chatdgc_widgets");
  assert.ok(asked, "ChatDGC is asked for its own widgets");
  {
    // This ChatDGC lists its own widgets: they come first from it, and the reply's card joins them.
    chat.onEvent({ type: "chatdgc_widgets", request_id: asked.request_id, op: "list", total: 1, next_offset: null,
      widgets: [{ id: WG, title: "EMI calculator", chat_id: ID(7), chat_title: "Loans", created_at: "2026-11-14T05:10:00Z" }] });
    const widgets = host.home.filter((m) => m.type === "homeWidgets").at(-1);
    assert.equal(widgets.offered, true);
    assert.deepEqual(widgets.widgets.map((w) => [w.title, w.card === true]), [["EMI calculator", false], ["UK heat pump tariffs, 2026", true]], "ChatDGC's widget, and the card a Work reply drew");
    assert.deepEqual({ id: widgets.widgets[1].id, surface: widgets.widgets[1].surface }, { id: ar("3"), surface: "work" }, "the card opens as the artifact it is");
  }
  {
    // A ChatDGC that lists no widgets: the cards, and a widget's page too (as the Library's Widgets tab then shows it).
    host.offers = { version: 1 }; host.home.length = 0;
    await chat.homeCardsMessage({ type: "homeWidgetsGet" });
    const widgets = host.home.filter((m) => m.type === "homeWidgets").at(-1);
    assert.deepEqual(widgets.widgets.map((w) => w.title), ["UK heat pump tariffs, 2026", "EMI calculator"]);
    assert.equal(widgets.offered, true);
  }
});

// ---- uir2c (16 Nov): the Library lists the charts ChatDGC's replies drew and what you attached in Work sessions ------------------
const PNG_URI = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAOklEQVR42mP4/OUHTRHDqAWjFpCFamL+w9GoBaRZgCwxasGoBXjVj1owasGoBWRYQIn4qAWjFgwBCwCv+U93BeXqBQAAAABJRU5ErkJggg==";
test("uir2c: Widgets' charts are asked of a ChatDGC that lists them, checked, and Open opens the chat at the chart's reply; one it never listed opens nothing", async () => {
  const wait = () => new Promise((r) => setTimeout(r, 8));
  chat.openLibrary();
  const lib = world.panels.at(-1);
  lib.say({ type: "ready" }); await wait();
  assert.equal(lib.webview.posted.filter((m) => m.type === "chartsOffered").at(-1)?.on, false, "this ChatDGC lists none: said so");
  lib.say({ type: "charts", query: "", offset: 0 }); await wait();
  assert.equal(sent.filter((c) => c.type === "chatdgc_widgets" && c.op === "charts").length, 0, "and it is never asked");
  host.offers = { version: 1, widget_library: 1, chart_library: 1 };
  lib.say({ type: "ready" }); await wait();
  assert.equal(lib.webview.posted.filter((m) => m.type === "chartsOffered").at(-1).on, true);
  lib.say({ type: "charts", query: " frost ", offset: 0 }); await wait();
  const asked = sent.filter((c) => c.type === "chatdgc_widgets" && c.op === "charts").at(-1);
  assert.deepEqual({ query: asked.query, limit: asked.limit, offset: asked.offset }, { query: " frost ", limit: 60, offset: 0 });
  const good = { chat_id: ID(7), chat_title: "Tiles", message_id: MSG(3), id: `${MSG(3)}:1`, title: "Frost rating by tile", kind: "chart", chart_type: "bar", created_at: "2026-11-16T05:10:00Z" };
  chat.onEvent({ type: "chatdgc_widgets", request_id: asked.request_id, op: "charts", total: 4, next_offset: 60, widgets: [good,
    { ...good, id: `${MSG(4)}:0` },                                   // an id that isn't its own reply's
    { ...good, chat_id: "../etc", id: `${MSG(3)}:2` }, { ...good, message_id: "nope", id: "nope:0" }, null] });
  const said = lib.webview.posted.filter((m) => m.type === "charts").at(-1);
  assert.deepEqual(said.charts, [{ chat_id: ID(7), chat_title: "Tiles", message_id: MSG(3), id: `${MSG(3)}:1`, title: "Frost rating by tile", kind: "chart", chart_type: "bar", created_at: "2026-11-16T05:10:00Z" }], "only a chart that is a reply's own");
  assert.deepEqual([said.offset, said.next], [0, 60]);
  // Open: the chat's tab, and the page is told which reply and which of its charts.
  const before = world.panels.length;
  lib.say({ type: "itemAct", act: "open", item: { kind: "chart", id: `${MSG(4)}:0`, chat_id: ID(7) } }); await wait();
  lib.say({ type: "itemAct", act: "open", item: { kind: "chart", id: `${MSG(3)}:1`, chat_id: ID(8) } }); await wait();
  assert.equal(world.panels.length, before, "a chart the Library was never shown opens nothing");
  lib.say({ type: "itemAct", act: "remove", item: { kind: "chart", id: `${MSG(3)}:1`, chat_id: ID(7) } }); await wait();
  assert.equal(world.panels.length, before, "and a chart is only ever opened");
  lib.say({ type: "itemAct", act: "open", item: { kind: "chart", id: `${MSG(3)}:1`, chat_id: ID(7) } }); await wait();
  assert.equal(world.panels.length, before + 1, "its chat opens in a tab");
  const tab = world.panels.at(-1);
  tab.say({ type: "ready" });
  assert.equal(last("chatdgc_open").conversation_id, ID(7));
  opened(tab, { id: ID(7), title: "Tiles", temporary: false });
  assert.deepEqual(tab.last("showMessage"), { type: "showMessage", id: MSG(3), chart: 1 }, "once it has opened: scroll to that reply's second chart");
  // Open again, the chat already in a tab: that tab, told again.
  lib.say({ type: "itemAct", act: "open", item: { kind: "chart", id: `${MSG(3)}:1`, chat_id: ID(7) } }); await wait();
  assert.equal(world.panels.length, before + 1); assert.equal(tab.webview.posted.filter((m) => m.type === "showMessage").length, 2);
  // The side bar's Library tab asks the same way.
  await chat.sideLibrary({ type: "charts", query: "", offset: 60 }); await wait();
  assert.equal(sent.filter((c) => c.type === "chatdgc_widgets" && c.op === "charts").at(-1).offset, 60);
});

// His call (16 Nov): Home's Widgets card is the widgets you use again; a chart is the Library's (Widgets, Kind: Charts).
test("Home's Widgets card is the widgets alone: where ChatDGC lists charts it never asks for them or counts one, and no chart opens from Home", async () => {
  const WG = "wg_" + "5".repeat(16);
  host.offers = { version: 1, widget_library: 1, chart_library: 1 };
  const chartsBefore = sent.filter((c) => c.type === "chatdgc_widgets" && c.op === "charts").length;
  host.home.length = 0;
  await chat.homeCardsMessage({ type: "homeWidgetsGet" });
  const list = sent.filter((c) => c.type === "chatdgc_widgets" && c.op === "list").at(-1);
  chat.onEvent({ type: "chatdgc_widgets", request_id: list.request_id, op: "list", total: 1, next_offset: null, widgets: [{ id: WG, title: "EMI calculator", chat_id: ID(7), chat_title: "Loans", created_at: "2026-11-14T05:10:00Z" }] });
  assert.equal(sent.filter((c) => c.type === "chatdgc_widgets" && c.op === "charts").length, chartsBefore, "the charts are not asked for");
  const home = host.home.filter((m) => m.type === "homeWidgets").at(-1);
  assert.ok(home, "Home is told at once");
  assert.deepEqual(home.widgets.filter((w) => !w.card).map((w) => [w.title, w.chart === true]), [["EMI calculator", false]], "the widget alone");
  const before = world.panels.length;
  await chat.homeCardsMessage({ type: "homeChartOpen", id: `${MSG(3)}:0`, chat_id: ID(8) });
  assert.equal(world.panels.length, before, "a chart never opens from Home");
});

test("uir2c: Files' Work attachments: listed by a name of the host's own, never a path; a picture opens in the picture viewer, a file in the editor; nothing is done for one it never listed", async () => {
  const vs = globalThis.__DGC_TEST_VSCODE, wfs = vs.workspace.fs, kept = { copy: wfs.copy, writeFile: wfs.writeFile, status: vs.window.setStatusBarMessage };
  const copied = [], wait = () => new Promise((r) => setTimeout(r, 12));
  wfs.copy = async (from, to) => { copied.push([from.fsPath, to.fsPath]); };
  vs.window.setStatusBarMessage = () => ({ dispose() {} });
  const SESSION_FILE = "/home/me/.dgc/sessions/abc123/20261115-194400-a1b2c3d4.json", PROJECT = "/home/me/projects/lime_tiles";
  const listed = [], got = [];
  const items = [{ path: SESSION_FILE, id: "2:0", kind: "image", name: "Picture 1.png", mime: "image/png", bytes: 120, at: 1794800000, session_name: "Fix totals", project: PROJECT, project_name: "lime_tiles" },
    { path: SESSION_FILE, id: "4:0", kind: "file", name: "order_total.py", at: 1794700000, session_name: "Fix totals", project: PROJECT, project_name: "lime_tiles" },
    { path: "/etc/passwd", id: "0:0", kind: "file", name: "passwd", at: 1, session_name: "", project: "/etc", project_name: "etc" },      // not a session of DGC's
    { path: SESSION_FILE, id: "../1", kind: "file", name: "x", at: 1, session_name: "", project: PROJECT, project_name: "lime_tiles" }];
  let answer = (path, id) => (id === "2:0" ? { type: "session_attachment", id, kind: "image", name: "Picture 1.png", mime: "image/png", data: PNG_URI }
    : { type: "session_attachment", id, kind: "file", name: "order_total.py", file_path: `${PROJECT}/billing/order_total.py` });
  try {
    chat.openLibrary();
    const lib = world.panels.at(-1);
    lib.say({ type: "ready" }); await wait();
    assert.equal(lib.webview.posted.filter((m) => m.type === "workFilesOffered").at(-1)?.on, false, "a DGC that lists none: said so");
    lib.say({ type: "workFiles", seq: 1, query: "", offset: 0 }); await wait();
    assert.equal(lib.webview.posted.filter((m) => m.type === "workFiles").length, 0, "and nothing is listed");
    host.sessionAttachmentsOffered = () => true;
    host.sessionAttachments = async (cmd) => { listed.push(cmd); return { type: "session_attachments", items, total: 4, next_offset: null }; };
    host.sessionAttachment = async (path, id) => { got.push([path, id]); return answer(path, id); };
    lib.say({ type: "ready" }); await wait();
    assert.equal(lib.webview.posted.filter((m) => m.type === "workFilesOffered").at(-1).on, true);
    lib.say({ type: "workFiles", seq: 2, query: "order", offset: 0 }); await wait();
    assert.deepEqual(listed.at(-1), { query: "order", limit: 60, offset: 0 });
    const said = lib.webview.posted.filter((m) => m.type === "workFiles").at(-1);
    assert.equal(said.seq, 2);
    assert.deepEqual(said.files.map((f) => [f.kind, f.name, f.session_name, f.session_id, f.project_name]), [["image", "Picture 1.png", "Fix totals", "20261115-194400-a1b2c3d4", "lime_tiles"], ["file", "order_total.py", "Fix totals", "20261115-194400-a1b2c3d4", "lime_tiles"]],
      "the two that are in DGC's own sessions, each with the session it is in");
    assert.doesNotMatch(JSON.stringify(said), /\/home\/me|sessions\/|\.json/, "no path reaches the page: the session's file and the project's folder stay here");
    assert.match(said.files[0].ref, /^wa_[0-9a-f]{16}$/); assert.match(said.files[0].created_at, /^2026-/);
    const [pic, file] = said.files.map((f) => f.ref);
    const act = async (what, ref) => { lib.say({ type: "itemAct", act: what, item: { kind: "workfile", ref } }); await wait(); };
    // One it was never shown: nothing is asked of DGC.
    await act("open", "wa_" + "0".repeat(16)); await act("open", SESSION_FILE);
    assert.deepEqual(got, []);
    // A picture: its thumbnail, Open (the editor's picture viewer, from a copy of its own), Copy, Save a copy….
    lib.say({ type: "workFilePic", ref: pic }); await wait();
    assert.deepEqual(got.at(-1), [SESSION_FILE, "2:0"], "DGC is asked by the session and the id the listing gave");
    assert.deepEqual(lib.webview.posted.filter((m) => m.type === "workFileData").at(-1), { type: "workFileData", ref: pic, data: PNG_URI });
    world.commands.length = 0; world.written.length = 0;
    await act("open", pic);
    // (Its copy is written to this computer's own temporary folder, a real file: waited for, however busy the machine is.)
    for (let i = 0; i < 200 && !world.commands.some((c) => c[0] === "vscode.open"); i++) await wait();
    const openedPic = world.commands.find((c) => c[0] === "vscode.open");
    assert.ok(openedPic, "a picture opens in the picture viewer");
    assert.match(openedPic[1].fsPath, /dgc-library-files[\\/][0-9a-f]+[\\/]Picture 1\.png$/, "from a copy of its own, named as the picture is");
    { const nfs = await import("node:fs"); const st = nfs.statSync(openedPic[1].fsPath); assert.ok(st.size > 50, "the picture's own bytes");
      if (process.platform !== "win32") assert.equal(st.mode & 0o077, 0, "for this user alone"); nfs.rmSync(join(openedPic[1].fsPath, ".."), { recursive: true, force: true }); }
    await act("copy", pic);
    assert.deepEqual(lib.webview.posted.filter((m) => m.type === "itemCopy").at(-1), { type: "itemCopy", key: `workfile:${pic}`, data: PNG_URI });
    world.written.length = 0; world.saveAsked = undefined;
    await act("save", pic);
    assert.equal(lib.last("dgcDownload")?.name, "Picture 1.png", "Save a copy…: the picture handed to the page, to save on the person's computer");
    assert.deepEqual([world.written.length, world.saveAsked], [0, undefined], "nothing written here, no save dialog");
    await act("path", pic); await act("reveal", pic); await act("editor", pic);
    assert.equal(world.clipboard, "", "a picture has no path to give");
    // A file: Open and Open in editor show it in the editor; Copy path, Reveal, Save a copy….
    world.shown.length = 0; world.commands.length = 0;
    await act("open", file); await act("editor", file);
    assert.deepEqual(world.shown.map((s) => s.path), [`${PROJECT}/billing/order_total.py`, `${PROJECT}/billing/order_total.py`], "a file opens in the editor, where it is in its project");
    await act("path", file);
    assert.equal(world.clipboard, `${PROJECT}/billing/order_total.py`);
    assert.equal(lib.webview.posted.filter((m) => m.type === "itemSaid").at(-1).words, "Path copied");
    await act("reveal", file);
    assert.deepEqual(world.commands.at(-1).slice(0, 1), ["revealFileInOS"]); assert.equal(world.commands.at(-1)[1].fsPath, `${PROJECT}/billing/order_total.py`);
    const fsx = globalThis.__DGC_TEST_VSCODE.workspace.fs, readBefore = fsx.readFile;
    fsx.readFile = async (u) => (u.fsPath === `${PROJECT}/billing/order_total.py` ? Buffer.from("def total(): ...\n") : readBefore(u));
    try { await act("save", file); } finally { fsx.readFile = readBefore; }
    assert.equal(lib.last("dgcDownload")?.name, "order_total.py", "Save a copy…: handed to the page, to save on the person's computer");
    await act("remove", file); await act("rename", file); await act("copy", file);
    // What DGC answers is checked: another attachment's answer, a file outside its project, a picture that isn't one.
    world.shown.length = 0; world.commands.length = 0; world.clipboard = "";
    answer = (path, id) => ({ type: "session_attachment", id, kind: "file", name: "passwd", file_path: "/etc/passwd" });
    await act("open", file); await act("path", file);
    assert.deepEqual([world.shown.length, world.clipboard], [0, ""], "a file outside its own project is never opened or named");
    assert.match(world.warnings.at(-1), /order_total\.py/);
    answer = (path, id) => ({ type: "session_attachment", id, kind: "image", name: "Picture 1.png", mime: "image/png", data: "data:text/html;base64,PGI+" });
    const posts = lib.webview.posted.length;
    await act("copy", pic); await act("open", pic); for (let i = 0; i < 12; i++) await wait();
    assert.equal(lib.webview.posted.slice(posts).filter((m) => m.type === "itemCopy").length, 0, "what isn't a picture is never handed to the page");
    assert.equal(world.commands.filter((c) => c[0] === "vscode.open").length, 0);
    // The side bar's Library tab asks the same way.
    await chat.sideLibrary({ type: "workFiles", seq: 5, query: "", offset: 0 }); await wait();
    assert.equal(host.home.filter((m) => m.type === "sideLibrary" && m.message.type === "workFiles").at(-1).message.seq, 5);
  } finally { wfs.copy = kept.copy; vs.window.setStatusBarMessage = kept.status; world.saveTo = undefined; }
});

test("uir2c 2b: a chat file's menu asks DGC for the file by its id in this chat: Open and Open in editor from a private copy, Copy a text file's text, a picture handed to the page; Copy path and Reveal ask nothing", async () => {
  const { existsSync, statSync, writeFileSync, mkdirSync } = createRequire(import.meta.url)("node:fs");
  const wait = () => new Promise((r) => setTimeout(r, 8));
  chat.open(ID(5));
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  opened(panel, { id: ID(5), title: "Budget" });
  const F = (c) => `att_${c.repeat(32)}`;
  const asks = () => sent.filter((c) => c.type === "chatdgc_library_file" || c.type === "chatdgc_file").length;
  const pick = (act, fileId, name, more = {}) => panel.say({ type: "fileAct", act, messageId: MSG(2), fileId, name, ...more });
  /** DGC writes the copy where the host asked, and says so. */
  const written = (text) => { const asked = last("chatdgc_library_file"); mkdirSync(dirname(asked.path), { recursive: true }); writeFileSync(asked.path, text);
    chat.onEvent({ type: "chatdgc_library_file", request_id: asked.request_id, op: "save", path: asked.path, bytes: text.length }); return asked; };
  // Open: a private copy, in its own app (a Markdown file in an editor tab).
  pick("open", F("a"), "Notes.md");
  let asked = written("# Notes\n"); await wait();
  assert.deepEqual([asked.op, asked.conversation_id, asked.attachment_id], ["save", ID(5), F("a")]);
  assert.equal(statSync(dirname(dirname(asked.path))).mode & 0o777, 0o700, "into a private folder of this window's");
  assert.equal(world.shown.at(-1).path, asked.path);
  // Open in editor: the same copy, in an editor tab that stays; only for a file with text.
  const shownBefore = world.shown.length;
  pick("editor", F("a"), "Notes.md"); asked = written("# Notes\n"); await wait();
  assert.deepEqual([world.shown.length, world.shown.at(-1).path, world.shown.at(-1).options?.preview], [shownBefore + 1, asked.path, false]);
  let before = asks();
  pick("editor", F("b"), "Budget.xlsx"); await wait();
  assert.equal(asks(), before, "a workbook has no text an editor can show: nothing is asked");
  // Copy: a text file's text, read from a private copy that is then taken away.
  pick("copy", F("a"), "Notes.md"); asked = written("# Notes\n\nCheck the totals.\n"); await wait(); await wait();
  for (let i = 0; i < 100 && world.clipboard !== "# Notes\n\nCheck the totals.\n"; i++) await wait();   // (a loaded machine reads later)
  assert.equal(world.clipboard, "# Notes\n\nCheck the totals.\n");
  assert.equal(panel.last("fileSaid").words, "Text copied");
  assert.equal(existsSync(asked.path), false, "the copy made to read it is gone");
  // Copy on a picture: DGC is asked for it, and the page gets the picture for its clipboard.
  pick("copy", F("c"), "chart.png");
  const want = last("chatdgc_file");
  assert.deepEqual([want.conversation_id, want.attachment_id], [ID(5), F("c")]);
  chat.onEvent({ type: "chatdgc_file", request_id: want.request_id, conversation_id: ID(5), attachment_id: F("c"), data: "data:image/png;base64,iVBORw0KGgo=" }); await wait();
  assert.equal(panel.last("fileCopy").data, "data:image/png;base64,iVBORw0KGgo=");
  // Save a copy… (18 Nov): DGC writes it into a private folder made for this download; the chat's page saves it on the
  // person's computer. No save dialog.
  world.saveAsked = undefined;
  pick("save", F("a"), "Notes.md");
  for (let i = 0; i < 100 && !/dgc-download-/.test(last("chatdgc_library_file").path || ""); i++) await new Promise((r) => setTimeout(r, 5));
  const saving = last("chatdgc_library_file");
  assert.equal(saving.op, "save");
  assert.match(saving.path, /dgc-download-[^/\\]+[/\\]Notes\.md$/);
  writeFileSync(saving.path, "# Notes\n");
  chat.onEvent({ type: "chatdgc_library_file", request_id: saving.request_id, op: "save", path: saving.path, bytes: 8 });
  for (let i = 0; i < 100 && !panel.last("dgcDownload"); i++) await new Promise((r) => setTimeout(r, 5));
  assert.equal(panel.last("dgcDownload")?.name, "Notes.md");
  assert.equal(world.saveAsked, undefined, "no save dialog");
  // Copy path, Reveal, and anything that isn't one of the six: DGC keeps this copy for the chat. Nothing is asked.
  before = asks(); const clip = world.clipboard, ran = world.commands.length;
  for (const act of ["path", "reveal", "remove", "rename", "cut"]) pick(act, F("a"), "Notes.md");
  pick("open", "att_nope", "Notes.md"); pick("open", "../../etc/passwd", "passwd");
  pick("copy", F("a"), "Notes.md", { path: "/etc/passwd" });      // (a path the page adds is not looked at: this one is asked by its id)
  await wait();
  assert.equal(asks(), before + 1); assert.equal(JSON.stringify(last("chatdgc_library_file")).includes("/etc/passwd"), false);
  assert.deepEqual([world.clipboard, world.commands.length], [clip, ran]);
  assert.equal(panel.webview.posted.some((m) => /dgc-chatdgc-files/.test(JSON.stringify(m))), false, "the page is never told where a copy is");
});

// Finding 73 (16 Nov): Home's token card asks the ledger again soon after DGC used tokens; a ChatDGC reply's end says so.
test("a ChatDGC reply's end tells Home its token count moved; its start does not", async () => {
  host.home.length = 0;
  chat.onEvent({ type: "chatdgc_turn", conversation_id: ID(4), state: "started", reply_id: MSG(5) });
  assert.equal(host.home.filter((m) => m.type === "homeUsageStale").length, 0, "nothing used yet");
  chat.onEvent({ type: "chatdgc_turn", conversation_id: ID(4), state: "ended", reply_id: MSG(5) });
  assert.equal(host.home.filter((m) => m.type === "homeUsageStale").length, 1, "Home asks again soon");
});
