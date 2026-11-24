// "Open in editor" for a Pip's chat (15 Nov: "each Pip chat should also get the same open in editor icon ... like we
// have on work and chat sessions"), the host's side (src/pipsView.ts): one editor tab per Pip conversation, titled
// "{Pip name} · {conversation}", brought forward when asked for again. It is the same chat over the same channel, never
// a copy: what is typed, sent or read in one page reaches the others, and closing the tab asks DGC nothing.
// The Pips tab's policy lets a favicon load only while dgc.linkFavicons is on.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const viewModule = await pipsViewModule();
const PIP = { id: "pip_" + "5".repeat(32), name: "Shopper", pip_type: "scout" };
const OTHER = { id: "pip_" + "6".repeat(32), name: "Mornings", pip_type: "lens" };
const GOA = "conv_" + "a".repeat(32), TAX = "conv_" + "c".repeat(32);

function host(api = 97, { favicons = true } = {}) {
  const panels = [], disposed = [];
  const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => (key === "linkFavicons" ? favicons : fallback) }) },
    window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }),
      createWebviewPanel: (id, title) => { const p = { id, title, revealed: 0, posted: [], receive: null, closed: [], visible: true,
        webview: { cspSource: "https://csp.test", html: "", asWebviewUri: (u) => ({ toString: () => "https://csp.test/" + u.path }), postMessage: (m) => { p.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { p.receive = f; } },
        reveal() { p.revealed++; }, onDidDispose: (f) => { p.closed.push(f); }, onDidChangeViewState() {}, dispose() { if (disposed.includes(p)) return; disposed.push(p); for (const f of p.closed) f(); } }; panels.push(p); return p; } } };
  const { PipsEditor, pipsDocument } = viewModule(vscode);
  const make = (attach) => { const main = [], sent = []; const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
    if (attach) editor.attach((m) => main.push(m));
    editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
    return { editor, main, sent, generation: () => (main.filter((m) => m.type === "pipsConnection").at(-1) || panels.flatMap((p) => p.posted).filter((m) => m.type === "pipsConnection").at(-1)).generation }; };
  return { ...make(true), make, panels, disposed, pipsDocument };
}
const chats = (h) => h.panels.filter((p) => p.id === "dgc.pipChat" && !h.disposed.includes(p));
const policy = (html) => /<meta http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)[1];
const imgSrc = (html) => policy(html).split(";").map((d) => d.trim()).find((d) => d.startsWith("img-src"));

test("the Pips tab's policy lets an https image in only while dgc.linkFavicons is on, and tells the page which", () => {
  const { pipsDocument } = host();
  const page = (extra) => pipsDocument("s.js", "s.css", "https://csp.test", "m.js", "", "", "", "c.css", extra);
  assert.equal(imgSrc(page({ favicons: true })), "img-src https://csp.test data: https:");
  assert.match(page({ favicons: true }), /<body data-link-favicons="on">/);
  for (const off of [page({ favicons: false }), page({}), page(undefined)]) {
    assert.equal(imgSrc(off), "img-src https://csp.test data:", "off, and when nothing says: no icon may load");
    assert.doesNotMatch(policy(off), /https:(\s|;|$)/);
    assert.match(off, /<body data-link-favicons="off">/);
  }
  // A conversation's own tab says whose it is.
  const mine = page({ favicons: true, chat: { pip: PIP.id, conversation: GOA } });
  assert.match(mine, new RegExp(`<body data-link-favicons="on" data-pip-chat="${PIP.id}" data-pip-conversation="${GOA}">`));
  assert.match(page({ favicons: false, chat: { pip: PIP.id, conversation: "" } }), new RegExp(`<body data-link-favicons="off" data-pip-chat="${PIP.id}" data-pip-conversation="">`));
});

test("Open in editor opens one tab per Pip conversation, titled with both names, and brings it forward the second time", () => {
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  assert.equal(chats(h).length, 1);
  const tab = chats(h)[0];
  assert.equal(tab.title, "Shopper · Trip to Goa");
  assert.match(tab.webview.html, new RegExp(`data-pip-chat="${PIP.id}" data-pip-conversation="${GOA}"`), "the tab's page is told its Pip and its conversation");
  assert.match(tab.webview.html, /dist\/pips\.js/, "it is the Pips page itself, not another client");
  assert.equal(imgSrc(tab.webview.html), "img-src https://csp.test data: https:", "its favicons follow dgc.linkFavicons, as the Pips tab's do");
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  assert.equal(chats(h).length, 1, "asked for again, no second tab");
  assert.equal(tab.revealed, 1, "it comes forward");
  // Another conversation of the same Pip, its first conversation, and another Pip's: a tab each.
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: TAX, title: "Tax papers" } });
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  h.editor.receive({ type: "pipsOpenChat", pip: OTHER, conversation: { id: "", title: "Chat" } });
  assert.deepEqual(chats(h).map((p) => p.title), ["Shopper · Trip to Goa", "Shopper · Tax papers", "Shopper · Chat", "Mornings · Chat"]);
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: "", title: "Chat" } });
  assert.equal(chats(h).length, 4, "its first conversation is one tab, named or not");
  assert.equal(chats(h)[2].revealed, 1);
  // What is not a Pip or not a conversation opens nothing.
  for (const bad of [{ pip: { ...PIP, id: "../x" } }, { pip: { ...PIP, name: "" } }, { pip: { ...PIP, name: "x".repeat(121) } }, { pip: { ...PIP, pip_type: "robot" } }, { pip: PIP, conversation: { id: "conv_nope", title: "x" } },
    { pip: PIP, conversation: { id: GOA, title: 7 } }, { pip: PIP, conversation: "all of them" }, {}])
    h.editor.receive({ type: "pipsOpenChat", ...bad });
  assert.equal(chats(h).length, 4);
  // A tab off: its favicons are off with the setting.
  const quiet = host(97, { favicons: false });
  quiet.editor.receive({ type: "pipsOpenChat", pip: PIP });
  assert.equal(imgSrc(chats(quiet)[0].webview.html), "img-src https://csp.test data:");
});

test("an older DGC has the same tab: it needs no new command (a Pip's one chat, before several conversations)", () => {
  const h = host(43);
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  assert.deepEqual(chats(h).map((p) => p.title), ["Shopper · Chat"], "before Pips API 79 a Pip has one chat: that is the tab");
  assert.match(chats(h)[0].webview.html, new RegExp(`data-pip-chat="${PIP.id}" data-pip-conversation=""`));
  assert.deepEqual(h.sent, [], "opening the tab asks DGC nothing");
});

test("the tab is the same chat over the same channel: it is connected, its requests are answered to it alone", () => {
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  const tab = chats(h)[0];
  tab.receive({ type: "pipsReady" });
  const connection = tab.posted.find((m) => m.type === "pipsConnection");
  assert.ok(connection && connection.connected && connection.supported && connection.enabled && connection.apiVersion === 97, "it hears the connection as the Pips page does");
  const before = h.main.length;
  tab.receive({ type: "pipsRequest", id: "tab-1", generation: connection.generation, request: { type: "list_pip_messages", pip_id: PIP.id, conversation_id: GOA } });
  const call = h.sent.find((m) => m.type === "pips_control" && m.request.type === "list_pip_messages");
  assert.ok(call, "it asks DGC through the same bridge");
  h.editor.event({ type: "pips_result", request_id: call.request.request_id, command: "list_pip_messages", ok: true, result: { messages: [] } });
  assert.deepEqual(tab.posted.filter((m) => m.type === "pipsReply").map((m) => [m.id, m.ok]), [["tab-1", true]]);
  assert.equal(h.main.slice(before).filter((m) => m.type === "pipsReply").length, 0, "and the Pips page is not sent its answer");
  // A reconnect reaches it too.
  h.editor.offline(); h.editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 97 }, {});
  assert.equal(tab.posted.filter((m) => m.type === "pipsConnection").at(-1).connected, true);
  assert.equal(tab.posted.filter((m) => m.type === "pipsConnection").some((m) => m.connected === false), true, "it was told when the connection went");
});

test("what is typed in one page shows in the others, and a tab opened later starts with it", () => {
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: TAX, title: "Tax papers" } });
  const [goa, tax] = chats(h);
  const draft = { type: "pipsChatDraft", pip_id: PIP.id, conversation_id: GOA, text: "Hold https://stay.example/42", parts: ["Hold ", { kind: "link", label: "https://stay.example/42", wire: "https://stay.example/42", identity: "" }] };
  h.editor.receive(draft);   // typed in the Pips page
  assert.deepEqual(goa.posted.filter((m) => m.type === "pipsChatDraft"), [draft], "the conversation's tab hears it, marks and all");
  assert.deepEqual(tax.posted.filter((m) => m.type === "pipsChatDraft"), [draft], "every page of the chat hears it and keeps its own conversation's");
  assert.equal(h.main.filter((m) => m.type === "pipsChatDraft").length, 0, "the page that typed it is not told what it typed");
  // Typed in the tab: the Pips page and the other tab hear it.
  const back = { type: "pipsChatDraft", pip_id: PIP.id, conversation_id: GOA, text: "Hold it until 6" };
  goa.receive(back);
  assert.deepEqual(h.main.filter((m) => m.type === "pipsChatDraft"), [back]);
  assert.equal(goa.posted.filter((m) => m.type === "pipsChatDraft").length, 1, "and not the tab that typed it");
  assert.deepEqual(tax.posted.filter((m) => m.type === "pipsChatDraft").at(-1), back);
  // The side bar's Pips and the tabs are different bridges of one window: they hear each other.
  const side = h.make(true);
  side.editor.receive({ type: "pipsChatDraft", pip_id: PIP.id, conversation_id: "", text: "from the side bar" });
  assert.equal(goa.posted.filter((m) => m.type === "pipsChatDraft").at(-1).text, "from the side bar");
  assert.equal(h.main.filter((m) => m.type === "pipsChatDraft").at(-1).text, "from the side bar");
  assert.equal(side.main.filter((m) => m.type === "pipsChatDraft").length, 0, "and the side bar is not told what it typed");
  goa.receive({ ...back, text: "Hold it until 6" });
  assert.equal(side.main.filter((m) => m.type === "pipsChatDraft").at(-1).text, "Hold it until 6", "what the tab types reaches the side bar");
  // A tab opened now starts with what is in the box.
  goa.dispose();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  const again = chats(h).at(-1);
  again.receive({ type: "pipsReady" });
  assert.deepEqual(again.posted.filter((m) => m.type === "pipsChatDraft").map((m) => [m.conversation_id, m.text]), [[GOA, "Hold it until 6"]]);
  // What is not a draft goes nowhere.
  const heard = tax.posted.length;
  for (const bad of [{ pip_id: "../x", conversation_id: "", text: "a" }, { pip_id: PIP.id, conversation_id: "conv_x", text: "a" }, { pip_id: PIP.id, conversation_id: "", text: 7 }, { pip_id: PIP.id, conversation_id: "", text: "x".repeat(262145) },
    { pip_id: PIP.id, conversation_id: "", text: "a", parts: [{ kind: "script", label: "a", wire: "a", identity: "" }] }, { pip_id: PIP.id, conversation_id: "", text: "a", parts: ["b"] }])
    h.editor.receive({ type: "pipsChatDraft", ...bad });
  assert.equal(tax.posted.length, heard);
});

test("what is sent or read in one page is read again by the others", () => {
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  const tab = chats(h)[0];
  tab.receive({ type: "pipsReady" });
  const generation = tab.posted.find((m) => m.type === "pipsConnection").generation;
  tab.receive({ type: "pipsRequest", id: "send-1", generation, request: { type: "send_pip_message", pip_id: PIP.id, text: "https://vibedgc.com", idempotency_key: "k".repeat(32) } });
  const call = h.sent.find((m) => m.type === "pips_control" && m.request.type === "send_pip_message");
  assert.equal(call.request.text, "https://vibedgc.com", "a link is sent as its words");
  assert.equal(h.main.filter((m) => m.type === "pipsChatChanged").length, 0, "nothing is said before DGC has it");
  h.editor.event({ type: "pips_result", request_id: call.request.request_id, command: "send_pip_message", ok: true, result: { message: {} } });
  assert.deepEqual(h.main.filter((m) => m.type === "pipsChatChanged"), [{ type: "pipsChatChanged", pip_id: PIP.id }], "the Pips page is told that Pip's chat changed");
  assert.equal(tab.posted.filter((m) => m.type === "pipsChatChanged").length, 0, "the page that sent it already knows");
  // Sent from the Pips page: the tab is told.
  h.editor.receive({ type: "pipsRequest", id: "send-2", generation, request: { type: "send_pip_message", pip_id: PIP.id, text: "and this", idempotency_key: "j".repeat(32) } });
  const second = h.sent.filter((m) => m.type === "pips_control" && m.request.type === "send_pip_message").at(-1);
  h.editor.event({ type: "pips_result", request_id: second.request.request_id, command: "send_pip_message", ok: true, result: { message: {} } });
  assert.deepEqual(tab.posted.filter((m) => m.type === "pipsChatChanged"), [{ type: "pipsChatChanged", pip_id: PIP.id }]);
  // One refused tells nobody.
  h.editor.receive({ type: "pipsRequest", id: "send-3", generation, request: { type: "send_pip_message", pip_id: PIP.id, text: "no", idempotency_key: "i".repeat(32) } });
  const third = h.sent.filter((m) => m.type === "pips_control" && m.request.type === "send_pip_message").at(-1);
  h.editor.event({ type: "pips_result", request_id: third.request.request_id, command: "send_pip_message", ok: false, error: { message: "no" } });
  assert.equal(tab.posted.filter((m) => m.type === "pipsChatChanged").length, 1);
  // Read somewhere: every page counts its unread again.
  h.editor.unreadChanged();
  assert.equal(tab.posted.filter((m) => m.type === "pipsUnreadChanged").length, 1);
});

test("closing the tab changes nothing about the Pip; the tab follows a rename and a conversation that moved", () => {
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  const [goa, first] = chats(h);
  // Renamed (the Pip, the conversation): the page says what it shows, and the tab's title follows.
  goa.receive({ type: "pipsChatShown", pip: { id: PIP.id, name: "Shopper two" }, conversation: { id: GOA, title: "Goa in March" } });
  assert.equal(goa.title, "Shopper two · Goa in March");
  // A tab only speaks for its own Pip.
  goa.receive({ type: "pipsChatShown", pip: { id: OTHER.id, name: "Mornings" }, conversation: { id: GOA, title: "x" } });
  assert.equal(goa.title, "Shopper two · Goa in March");
  // Its conversation is gone (archived elsewhere) and it shows the first one now: that one has a tab, which comes forward.
  goa.receive({ type: "pipsChatShown", pip: { id: PIP.id, name: "Shopper two" }, conversation: { id: "", title: "Chat" } });
  assert.equal(h.disposed.includes(goa), true, "two tabs never show one conversation");
  assert.equal(first.revealed, 1);
  const sentBefore = h.sent.length;
  first.dispose();
  assert.equal(chats(h).length, 0);
  assert.equal(h.sent.length, sentBefore, "closing a tab asks DGC nothing: the Pip, its chat and its work are as they were");
  h.editor.receive({ type: "pipsOpenChat", pip: PIP });
  assert.equal(chats(h).length, 1, "and it opens again");
});

test("the side bar's Pips hand Open in editor to whoever keeps the tabs", () => {
  const h = host();
  const asked = [];
  h.editor.useOpenChat((pip, conversation) => asked.push([pip, conversation]));
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  h.editor.receive({ type: "pipsOpenChat", pip: { ...PIP, id: "nope" } });
  assert.deepEqual(asked, [[PIP, { id: GOA, title: "Trip to Goa" }]], "checked first, then handed on");
  assert.equal(chats(h).length, 0);
  h.editor.openChat(PIP, { id: GOA, title: "Trip to Goa" });
  assert.equal(chats(h)[0].title, "Shopper · Trip to Goa");
});

test("a Pip's chat tab comes back after a window reload: its page keeps whose it is, and the host takes the tab back", async () => {
  // User test round 2, R1: after Developer: Reload Window, Work, chats and artifact tabs came back, a Pip's chat tab did not.
  const h = host();
  h.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  const first = chats(h)[0];
  assert.match(first.webview.html, new RegExp(`data-pip-name="Shopper" data-pip-type="scout"`), "its page knows its Pip's name and kind, to keep");
  // The page keeps whose tab it is in its saved state (what the editor hands back after a reload).
  const { JSDOM } = await import("jsdom");
  const { client } = await import("./support/pip-chat-scene.mjs");
  const dom = new JSDOM(first.webview.html.replace(/<script[^>]*src=[^>]*><\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true });
  const saved = [];
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  dom.window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState: (v) => saved.push(v) });
  try {
    const page = await client();
    dom.window.eval(`${page.markdown}\n;globalThis.DgcMarkdown = DgcMarkdown;`);
    dom.window.eval(page.js);
    // (Read across the page's own realm as plain data.)
    assert.deepEqual(JSON.parse(JSON.stringify(saved.at(-1)?.pipChatTab ?? null)), { pip: PIP.id, conversation: GOA, name: "Shopper", pip_type: "scout" }, "kept in its state");
  } finally { dom.window.close(); }
  // A fresh window: the editor hands the tab back with that state, and the host takes it over.
  const after = host();
  const restored = { id: "dgc.pipChat", title: "Shopper · Trip to Goa", revealed: 0, posted: [], closed: [], visible: true, options: null,
    webview: { cspSource: "https://csp.test", html: "", options: {}, asWebviewUri: (u) => ({ toString: () => "https://csp.test/" + u.path }), postMessage: (m) => { restored.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose() {} }) },
    reveal() { restored.revealed++; }, onDidDispose: (f) => { restored.closed.push(f); }, onDidChangeViewState() {}, dispose() { restored.gone = true; for (const f of restored.closed) f(); } };
  after.editor.restoreChat(restored, { pipChatTab: { pip: PIP.id, conversation: GOA, name: "Shopper", pip_type: "scout" } });
  assert.equal(restored.gone, undefined, "kept");
  assert.match(restored.webview.html, new RegExp(`data-pip-chat="${PIP.id}" data-pip-conversation="${GOA}"`), "its page is the same chat again");
  assert.equal(restored.webview.options.enableScripts, true);
  after.editor.receive({ type: "pipsOpenChat", pip: PIP, conversation: { id: GOA, title: "Trip to Goa" } });
  assert.equal(chats(after).length, 0, "asked for again: no second tab");
  assert.equal(restored.revealed, 1, "the restored one comes forward");
  // Nothing it can trust, or a second copy of a tab already open: closed.
  for (const bad of [undefined, {}, { pipChatTab: { pip: "../x", conversation: GOA, name: "Shopper", pip_type: "scout" } },
    { pipChatTab: { pip: PIP.id, conversation: "conv_nope", name: "Shopper", pip_type: "scout" } }, { pipChatTab: { pip: PIP.id, conversation: GOA, name: "Shopper", pip_type: "robot" } },
    { pipChatTab: { pip: PIP.id, conversation: GOA, name: "Shopper", pip_type: "scout" } }]) {
    const p = { ...restored, gone: undefined, closed: [], webview: { ...restored.webview, html: "" }, dispose() { p.gone = true; } };
    after.editor.restoreChat(p, bad);
    assert.equal(p.gone, true, `closed: ${JSON.stringify(bad)}`);
  }
});
