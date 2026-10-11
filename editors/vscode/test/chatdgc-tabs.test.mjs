// ChatDGC in the editor (src/chatdgc.ts): a chat per editor tab and the home's Chat list, riding on the side
// bar's dgc serve. Drives the real module, bundled against a stub `vscode`, with a host that records every
// command instead of running a backend. What it checks: each event reaches only the tabs (or the home) it
// belongs to, nothing waits forever for a process that is starting, an older CLI says so, and a tab sends
// only what the protocol accepts.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
                chosen: undefined, sizes: {}, infos: [], saveTo: undefined, saveAsked: undefined, errors: [] };
function fakePanel(viewType, title) {
  const disposed = new Emitter(), received = new Emitter();
  const panel = {
    viewType, title, revealed: 0, disposedCount: 0, iconPath: undefined,
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
globalThis.__DGC_TEST_VSCODE = {
  Uri: { joinPath: (...parts) => ({ toString: () => parts.map((p) => String(p?.toString?.() ?? p)).join("/") }),
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
    createWebviewPanel(viewType, title) { const panel = fakePanel(viewType, title); world.panels.push(panel); return panel; },
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
  },
  workspace: {
    get textDocuments() { return world.docs; },
    applyEdit: async (edit) => { for (const e of edit.edits) { const doc = world.docs.find((d) => d.uri.fsPath === e.uri.fsPath); if (doc) doc.text = e.text; } return true; },
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
const { ChatDGC, chatTitle, CHATDGC_EDITOR, CHATDGC_LIBRARY, widgetDocument } = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_TEST_VSCODE; rmSync(scratch, { recursive: true, force: true }); });

const ID = (n) => `chat_${String(n).repeat(32).slice(0, 32)}`;
const MSG = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`;
let chat, host, sent;
beforeEach(() => {
  Object.assign(world, { panels: [], serializers: [], warnings: [], answer: undefined, picks: [], pick: undefined, input: undefined, opened: [], clipboard: "",
                         chosen: undefined, sizes: {}, infos: [], saveTo: undefined, saveAsked: undefined, errors: [],
                         shown: [], visible: [], active: undefined, docs: [], commands: [], choose: undefined, written: [] });
  sent = [];
  host = { outcome: "sent", home: [], models: { ids: ["qwen3:32b", "fixture"], current: "fixture" },
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
  assert.deepEqual(sent.map((c) => c.type), ["chatdgc_open", "chatdgc_projects"], "sent once it was ready, each once");
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

test("canvas: a reply's canvas opens beside the chat; a change goes in as an edit and is saved; never a file elsewhere", async () => {
  chat.open(ID(7));
  const [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "Trip" });
  const path = canvasFile(ID(7));
  const view = { id: CV, title: "Plan", kind: "document", language: "markdown", version: 1, path, op: "created", text: "# Plan" };
  chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(2), canvas: view });
  await tick();
  assert.deepEqual(world.shown, [{ path, options: { viewColumn: -2, preserveFocus: true, preview: false } }], "beside the chat, which keeps focus");
  assert.deepEqual(panel.last("canvas"), { type: "canvas", messageId: MSG(2), canvas: { id: CV, title: "Plan", kind: "document",
                                                                                    language: "markdown", version: 1, op: "created" } });
  const open = doc(path, "# Plan");
  world.docs = [open]; world.visible = [{ document: open }];
  chat.onEvent({ type: "chatdgc_canvas", conversation_id: ID(7), message_id: MSG(4), canvas: { ...view, version: 2, op: "edited", text: "# Plan\n\nMore" } });
  await tick(); await tick();
  assert.equal(open.text, "# Plan\n\nMore", "the reply's change, as an edit of the open document");
  assert.equal(open.saved, 1);
  assert.equal(world.shown.length, 1, "already in view: not opened again");
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
  assert.equal(world.shown.length, 1, "only this chat's own canvas files");
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

test("a widget's page: nothing loads from anywhere, its own code only, no network APIs, theme colours checked", () => {
  const page = widgetDocument("<h1>EMI</h1><script>calc()</script>", { bg: "#1e1e1e", text: "red;}</style><script>alert(1)</script>", scheme: "light" });
  assert.match(page, /content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; form-action 'none'; base-uri 'none'"/);
  assert.ok(page.indexOf('"RTCPeerConnection"') < page.indexOf("<body>"), "network and peer connections gone before its code runs");
  assert.match(page, /"fetch","XMLHttpRequest"/);
  assert.match(page, /--bg:#1e1e1e;--text:#1f2328;/, "a colour that isn't one is never written into the page");
  assert.doesNotMatch(page, /alert\(1\)/);
  assert.match(page, /parent\.postMessage\(\{dgcWidget:true,height:/, "framed: it tells the chat its height");
  assert.doesNotMatch(widgetDocument("x", {}, false), /parent\.postMessage/, "in a tab of its own, nothing to tell");
  assert.match(page, /<body><h1>EMI<\/h1><script>calc\(\)<\/script><\/body>/);
});

test("a widget is written to a file of its own and framed; one too big, or with nowhere to write, isn't", async () => {
  chat.open(ID(7));
  let [panel] = world.panels;
  panel.say({ type: "ready" }); opened(panel, { id: ID(7), title: "EMI" });
  panel.say({ type: "widget", ref: `${MSG(2)}:abc`, html: "<b>calc</b>", theme: {} });
  await tick(); await tick();
  assert.deepEqual(panel.last("widgetReady"), { type: "widgetReady", ref: `${MSG(2)}:abc`, src: "" }, "no storage folder: not framed");
  const stored = new ChatDGC({ extensionUri: "ext", globalStorageUri: { scheme: "file", fsPath: "/g", path: "/g", toString: () => "file:///g" } });
  stored.attach(host);
  world.panels.length = 0;
  stored.open(ID(8));
  [panel] = world.panels;
  panel.say({ type: "ready" });
  stored.onEvent({ type: "chatdgc_opened", request_id: last("chatdgc_open").request_id, conversation: { id: ID(8), title: "EMI" }, messages: [], earlier: 0, busy: false });
  panel.say({ type: "widget", ref: `${MSG(2)}:abc`, html: "<b>calc</b>", theme: {} });
  await tick(); await tick(); await tick();
  const ready = panel.last("widgetReady");
  assert.match(String(ready.src), /widgets\/[0-9a-f]{40}\.html$/);
  assert.match(world.written.at(-1).bytes.toString(), /<body><b>calc<\/b><\/body>/);
  panel.say({ type: "widget", ref: `${MSG(2)}:big`, html: "x".repeat(200_001), theme: {} });
  await tick();
  assert.equal(panel.last("widgetReady").src, "");
  panel.say({ type: "widgetOpen", html: "<b>calc</b>", title: "EMI calculator", theme: {} });
  const tab = world.panels.at(-1);
  assert.equal(tab.viewType, "dgc.chatdgcWidget");
  assert.match(tab.webview.html, /default-src 'none'/);
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
