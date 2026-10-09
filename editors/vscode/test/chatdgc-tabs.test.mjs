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

const world = { panels: [], serializers: [], warnings: [], answer: undefined, picks: [], pick: undefined, input: undefined, opened: [], clipboard: "" };
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
    parse: (value) => ({ toString: () => value, value }) },
  ViewColumn: { Active: -1 },
  env: { clipboard: { writeText: async (text) => { world.clipboard = text; } }, openExternal: async (uri) => { world.opened.push(uri.toString()); return true; } },
  window: {
    createWebviewPanel(viewType, title) { const panel = fakePanel(viewType, title); world.panels.push(panel); return panel; },
    registerWebviewPanelSerializer(viewType, serializer) { world.serializers.push({ viewType, serializer }); return { dispose() {} }; },
    showWarningMessage: async (message) => { world.warnings.push(String(message)); return world.answer; },
    showQuickPick: async (items) => { world.picks.push(items.map((i) => i.id)); return items.find((i) => i.id === world.pick); },
    showInputBox: async () => world.input,
  },
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
  Object.assign(world, { panels: [], serializers: [], warnings: [], answer: undefined, picks: [], pick: undefined, input: undefined, opened: [], clipboard: "" });
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
