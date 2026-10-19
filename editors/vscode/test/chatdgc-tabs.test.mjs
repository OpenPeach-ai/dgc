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
  const disposed = new Emitter(), received = new Emitter();
  const panel = {
    viewType, title, revealed: 0, disposedCount: 0, icon: undefined,
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
  QuickPickItemKind: { Separator: -1 },
  env: { clipboard: { writeText: async (text) => { world.clipboard = text; } }, openExternal: async (uri) => { world.opened.push(uri.toString()); return true; } },
  window: {
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
    getConfiguration: () => ({ get: (key, fallback) => (key === "linkFavicons" && world.favicons !== undefined ? world.favicons : fallback) }),
    fs: { writeFile: async (uri, bytes) => { world.written.push({ path: uri.fsPath ?? String(uri), bytes: Buffer.from(bytes) }); },
      createDirectory: async () => undefined,
      stat: async (uri) => {
    if (world.dirs?.includes(uri.fsPath)) return { size: 0, type: 2 };
    if (world.missing?.includes(uri.fsPath)) throw new Error("ENOENT");
    return { size: world.sizes[uri.fsPath] ?? 1, type: 1 };
  } } },
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
                         shown: [], visible: [], active: undefined, docs: [], commands: [], choose: undefined, written: [], tabs: [] });
  sent = [];
  host = { outcome: "sent", home: [], models: { ids: ["qwen3:32b", "fixture"], current: "fixture" }, offers: { version: 1 },
    chatdgcOffers() { return this.offers; },
    windows: [], chatdgcSetWindow(preset) { this.windows.push(preset); },
    chatdgcSend(cmd) { if (this.outcome === "sent") sent.push(cmd); return this.outcome; },
    async chatdgcModels() { return this.models; },
    postHome(message) { this.home.push(message); } };
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
  assert.deepEqual(sent.map((c) => c.type), ["chatdgc_open", "chatdgc_projects", "chatdgc_list", "chatdgc_projects"],
                   "the tab's held commands sent once it was ready, each once; then the home's list, asked afresh");
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
  world.choose = (items) => items.find((i) => i.format === "docx");
  world.saveTo = { scheme: "file", fsPath: "/tmp/out/Plan.docx" };
  await chat.canvasDownload();
  assert.deepEqual({ ...last("chatdgc_canvas"), request_id: "" }, { type: "chatdgc_canvas", conversation_id: ID(7), canvas_id: CV,
                                                                    op: "export", format: "docx", path: "/tmp/out/Plan.docx", request_id: "" });
});

test("a chart saved as an image: only a PNG the page drew, written where you chose", async () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "Spend" });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  world.saveTo = { scheme: "file", fsPath: "/tmp/out/Spend.png", path: "/tmp/out/Spend.png" };
  panel.say({ type: "saveImage", name: "Spend by month", data: `data:image/png;base64,${png.toString("base64")}` });
  await tick(); await tick();
  assert.match(String(world.saveAsked.defaultUri), /Spend by month\.png$/);
  assert.deepEqual(world.written.map((w) => [w.path, [...w.bytes]]), [["/tmp/out/Spend.png", [...png]]]);
  panel.say({ type: "saveImage", name: "x", data: "data:text/html;base64,PHNjcmlwdD4=" });
  panel.say({ type: "saveImage", name: "x", data: "javascript:alert(1)" });
  await tick(); await tick();
  assert.equal(world.written.length, 1, "nothing but a PNG");
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
  for (const panel of [tab, library]) {
    assert.deepEqual([drawn(panel.iconPath.light), drawn(panel.iconPath.dark)], [mark("light"), mark("dark")], "the SVG itself, light and dark");
  }
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const command = manifest.contributes.commands.find((c) => c.command === "dgc.newChatDGC");
  assert.deepEqual(command.icon, { light: "media/chatdgc-tab-light.svg", dark: "media/chatdgc-tab-dark.svg" });
  for (const theme of ["light", "dark"]) assert.match(readFileSync(join(root, `media/chatdgc-tab-${theme}.svg`), "utf8"), /aria-label="ChatDGC"/);
});

test("a widget's tab open when VS Code closed comes back with its page; a deleted one doesn't; it waits for the backend", async () => {
  host.offers = {};                                   // starting
  const reg = chat.register();
  assert.deepEqual(world.serializers.map((x) => x.viewType), [CHATDGC_EDITOR, CHATDGC_WIDGET]);
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

test("a chat's tab revived after a reload gets the mark itself, even one behind another tab; a second copy gets nothing", async () => {
  const chat = installed();
  chat.register();
  const { serializer } = world.serializers.find((s) => s.viewType === CHATDGC_EDITOR);
  // VS Code revives a tab that was behind another only once it is shown; until then it draws the icon it saved, so
  // that icon must need nothing fetched (a remote window's connection is not up yet; an update moved the folder).
  const behind = fakePanel(CHATDGC_EDITOR, "Trip");
  await serializer.deserializeWebviewPanel(behind, { conversation: ID(5) });
  assert.deepEqual([drawn(behind.iconPath.light), drawn(behind.iconPath.dark)], [mark("light"), mark("dark")]);
  assert.doesNotMatch(String(behind.iconPath.dark), /media|vibedgc|file:/, "nothing names the extension's folder");
  const twin = fakePanel(CHATDGC_EDITOR, "Trip");
  await serializer.deserializeWebviewPanel(twin, { conversation: ID(5) });
  assert.equal(twin.disposedCount, 1, "one chat, one tab");
  assert.equal(twin.iconPath, undefined, "a disposed panel is given nothing (VS Code throws)");
  const fresh = fakePanel(CHATDGC_EDITOR, "x");
  await serializer.deserializeWebviewPanel(fresh, undefined);         // a new chat's tab: no state saved
  assert.equal(drawn(fresh.iconPath.dark), mark("dark"));
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

test("images the chat keeps are asked for by the tab showing them; dropped files are as good as picked, but not from hidden folders", async () => {
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
  panel.say({ type: "dropped", uris: ["file:///home/u/trip%20notes.md", "file:///home/u/.ssh/id_ed25519", "file:///home/u/project/.git/config",
                                      "file:///home/u/photos", "file:///home/u/gone.txt", "https://example.com/x.pdf"] });
  await new Promise((r) => setTimeout(r, 0));
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

test("export: the save dialog's choice says where and in which format, and the result is announced", async () => {
  chat.open(ID(8));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(8), title: "Goa: trip/plan" });
  world.pick = "export"; world.saveTo = { scheme: "file", fsPath: "/home/u/Goa trip.json", path: "/home/u/Goa trip.json" };
  panel.say({ type: "menu" });
  await new Promise((r) => setTimeout(r, 0));
  assert.match(world.saveAsked.defaultUri.toString(), /Goa trip plan\.md$/, "named after the chat, without path characters");
  const ask = last("chatdgc_export");
  assert.deepEqual([ask.path, ask.format], ["/home/u/Goa trip.json", "json"]);
  chat.onEvent({ type: "chatdgc_exported", request_id: ask.request_id, conversation_id: ID(8), path: "/home/u/Goa trip.json", bytes: 900 });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(world.infos, ["Exported to Goa trip.json."]);
  world.saveTo = undefined;
  const before = sent.length;
  panel.say({ type: "menu" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, before, "cancelled: nothing written");
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
  world.answer = "Delete project and 2 chats";
  page.say({ type: "projectDelete", id: PROJ("a"), name: "Goa, December", chats: 2 });
  await tick();
  assert.match(world.warnings.at(-1), /Delete the project “Goa, December”\?.*its chats too, unless you keep them/);
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
  world.pick = ["move", PROJ("b")];
  panel.say({ type: "menu" });
  await tick();
  chat.onEvent({ type: "chatdgc_projects", request_id: last("chatdgc_projects").request_id,
                 projects: [{ id: PROJ("a"), name: "Goa", chats: 1 }, { id: PROJ("b"), name: "Kerala", chats: 0 }] });
  await tick(); await tick();
  assert.deepEqual(world.picks.at(-1), [PROJ("b"), "new", ""], "not the one it's in; a new one; out of it");
  assert.deepEqual([last("chatdgc_move").conversation_id, last("chatdgc_move").project_id], [ID(5), PROJ("b")]);
  world.pick = ["move", "new"];
  world.input = "Tax 2026";
  panel.say({ type: "menu" });
  await tick();
  chat.onEvent({ type: "chatdgc_projects", request_id: last("chatdgc_projects").request_id, projects: [] });
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
  assert.equal(last("chatdgc_library").origin, "made", "files ChatDGC made, as ChatGPT filters them");
  lib.say({ type: "list", origin: "<script>" });
  assert.equal(last("chatdgc_library").origin, undefined, "only a filter DGC knows");
  const file = { source: "chat", chat_id: ID(7), id: `att_${"a".repeat(32)}`, name: "budget.csv", kind: "document", size: 15 };
  const projectFile = { source: "project", project_id: PROJ("a"), id: `att_${"b".repeat(32)}`, name: "Hotel", kind: "text" };
  lib.say({ type: "image", file: { ...file, kind: "image" } });
  const image = last("chatdgc_file");
  assert.deepEqual([image.conversation_id, image.attachment_id], [ID(7), file.id]);
  chat.onEvent({ type: "chatdgc_file", request_id: image.request_id, conversation_id: ID(7), attachment_id: file.id, data: "data:image/png;base64,AAAA" });
  assert.equal(lib.last("image").data, "data:image/png;base64,AAAA");
  world.saveTo = { scheme: "file", fsPath: "/home/u/budget.csv" };
  lib.say({ type: "save", file });
  await tick();
  assert.deepEqual([last("chatdgc_library_file").op, last("chatdgc_library_file").path, last("chatdgc_library_file").conversation_id], ["save", "/home/u/budget.csv", ID(7)]);
  chat.onEvent({ type: "chatdgc_library_file", request_id: last("chatdgc_library_file").request_id, op: "save", path: "/home/u/budget.csv", bytes: 15 });
  assert.deepEqual(world.infos.at(-1), "Saved budget.csv.");
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
  assert.equal(sent.filter((c) => c.type === "chatdgc_library_file").length, 2, "a file the Library didn't name isn't touched");
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
