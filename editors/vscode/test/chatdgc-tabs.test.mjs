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
                chosen: undefined, sizes: {}, infos: [], saveTo: undefined, saveAsked: undefined };
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
  ViewColumn: { Active: -1 },
  env: { clipboard: { writeText: async (text) => { world.clipboard = text; } }, openExternal: async (uri) => { world.opened.push(uri.toString()); return true; } },
  window: {
    createWebviewPanel(viewType, title) { const panel = fakePanel(viewType, title); world.panels.push(panel); return panel; },
    registerWebviewPanelSerializer(viewType, serializer) { world.serializers.push({ viewType, serializer }); return { dispose() {} }; },
    showWarningMessage: async (message) => { world.warnings.push(String(message)); return world.answer; },
    showQuickPick: async (items) => { world.picks.push(items.map((i) => i.id)); return items.find((i) => i.id === world.pick); },
    showInputBox: async () => world.input,
    showOpenDialog: async () => world.chosen,
    showSaveDialog: async (options) => { world.saveAsked = options; return world.saveTo; },
    showInformationMessage: async (message) => { world.infos.push(String(message)); return undefined; },
    showTextDocument: async () => undefined,
  },
  workspace: { fs: { stat: async (uri) => {
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
const { ChatDGC, chatTitle, CHATDGC_EDITOR } = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_TEST_VSCODE; rmSync(scratch, { recursive: true, force: true }); });

const ID = (n) => `chat_${String(n).repeat(32).slice(0, 32)}`;
const MSG = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`;
let chat, host, sent;
beforeEach(() => {
  Object.assign(world, { panels: [], serializers: [], warnings: [], answer: undefined, picks: [], pick: undefined, input: undefined, opened: [], clipboard: "",
                         chosen: undefined, sizes: {}, infos: [], saveTo: undefined, saveAsked: undefined });
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

test("commands wait for a process that is starting, and an older CLI says so", () => {
  host.outcome = "starting";
  chat.open("");
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.equal(sent.length, 0);
  host.outcome = "sent";
  chat.backendReady();
  assert.equal(sent.length, 1, "sent once it was ready");
  assert.equal(sent[0].type, "chatdgc_open");
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
  chat.onEvent({ type: "chatdgc_context", conversation_id: ID(9), window: 32768, limit: 0, used: 900, preset: "32k", source: "estimated", parts: {} });
  assert.equal(panel.last("context").used, 900);
  chat.onEvent({ type: "chatdgc_compacted", conversation_id: ID(9), summary: { upto: MSG(1), text: "s" } });
  assert.equal(panel.last("compacted").summary.text, "s");
  const carry = last("chatdgc_carry");
  chat.onEvent({ type: "chatdgc_opened", request_id: carry.request_id, conversation: { id: ID(4), title: "x" }, messages: [], earlier: 0, busy: false });
  assert.equal(panel.last("opened").conversation.id, ID(4), "the tab moves to the new chat");
  chat.onEvent({ type: "chatdgc_context", conversation_id: ID(9), window: 1, limit: 0, used: 1, preset: "32k", source: "estimated", parts: {} });
  assert.equal(panel.last("context").used, 900, "the old chat's meter no longer reaches it");
});
