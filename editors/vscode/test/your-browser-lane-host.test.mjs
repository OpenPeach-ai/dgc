// Your Browser, phase 4 (0.52), through the editor's real Pips bridge (src/pipsView.ts): a sign-in card in a Pip's chat
// (in the Pips tab, or in the chat's own editor tab) opens the site in YOUR OWN tab of Your Browser: open_your_browser
// {url} reaches DGC as a Pips control with nothing else in it, and where the computer DGC runs on has no screen the
// page then opens your own tab in an editor tab ("Your Browser"). A chat tab never opens a Pip's lane (only the dock's
// Watch does), and nothing else rides along.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const viewModule = await pipsViewModule();
const PIP = { id: "pip_" + "5".repeat(32), name: "Ava", pip_type: "lens" };
const CONV = "conv_" + "a".repeat(32);

function host(api = 112) {
  const panels = [];
  const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }),
      createWebviewPanel: (id, title) => { const p = { id, title, posted: [], receive: null, closed: [], visible: true, viewColumn: -1,
        webview: { cspSource: "https://csp.test", html: "", asWebviewUri: (u) => ({ toString: () => "https://csp.test/" + u.path }), postMessage: (m) => { p.posted.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (f) => { p.receive = f; return { dispose() {} }; } },
        reveal() {}, onDidDispose: (f) => { p.closed.push(f); }, onDidChangeViewState() {}, dispose() {} }; panels.push(p); return p; } } };
  const { PipsEditor } = viewModule(vscode);
  const main = [], sent = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach((m) => main.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
  editor.receive({ type: "pipsReady" });
  const generation = () => main.filter((m) => m.type === "pipsConnection").at(-1).generation;
  return { editor, main, sent, panels, generation, controls: () => sent.filter((m) => m.type === "pips_control").map((m) => m.request),
    browserTabs: () => panels.filter((p) => p.id === "dgc.yourBrowser") };
}

test("Open Your Browser on a sign-in card in the Pips tab: the site, in your own tab, and nothing else", () => {
  const h = host();
  h.editor.receive({ type: "pipsRequest", id: "r1", generation: h.generation(), request: { type: "open_your_browser", url: "https://shop.lanestore.com/account" } });
  assert.deepEqual(h.controls().map((r) => [r.type, r.url, Object.keys(r).filter((k) => !["type", "url", "request_id"].includes(k))]),
    [["open_your_browser", "https://shop.lanestore.com/account", []]]);
  h.editor.receive({ type: "pipsOpenYourBrowser", own: true });
  assert.deepEqual(h.browserTabs().map((p) => p.title), ["Your Browser"], "no screen here: your own tab, in an editor tab");
});

test("from a chat's own editor tab: your own tab opens, only that chat's own Pip's tab (its Watch), and nothing else rides along", () => {
  const h = host();
  h.editor.openChat({ ...PIP }, { id: CONV, title: "Kettle prices" });
  const chat = h.panels.find((p) => p.id === "dgc.pipChat");
  assert.ok(chat, "the chat's own tab");
  chat.receive({ type: "pipsReady" });
  const generation = chat.posted.filter((m) => m.type === "pipsConnection").at(-1)?.generation ?? h.generation();
  chat.receive({ type: "pipsRequest", id: "c1", generation, request: { type: "open_your_browser", url: "https://shop.lanestore.com/account" } });
  assert.deepEqual(h.controls().map((r) => [r.type, r.url]), [["open_your_browser", "https://shop.lanestore.com/account"]]);
  // (Its working line's Watch, Pips API 113: that chat's own Pip's tab, under the name the tab knows; never another's.)
  chat.receive({ type: "pipsOpenYourBrowser", pip: { id: "pip_" + "f".repeat(32), name: "Fern" } });
  assert.deepEqual(h.browserTabs(), [], "a chat tab never opens another Pip's tab");
  chat.receive({ type: "pipsOpenYourBrowser", pip: { id: PIP.id, name: "Someone else" } });
  assert.deepEqual(h.browserTabs().map((p) => p.title), [`${PIP.name} · Your Browser`], "its own Pip's tab, by its own name");
  chat.receive({ type: "pipsOpenYourBrowser", own: true });
  assert.deepEqual(h.browserTabs().map((p) => p.title), [`${PIP.name} · Your Browser`, "Your Browser"]);
  chat.receive({ type: "pipsRequest", id: "c2", generation, request: { type: "open_your_browser", url: "https://shop.lanestore.com/", pip_id: PIP.id } });
  assert.equal(h.controls().length, 1, "a Pip's tab is never asked for from a card");
  assert.ok(chat.posted.some((m) => m.type === "pipsReply" && m.id === "c2" && m.ok === false));
});
