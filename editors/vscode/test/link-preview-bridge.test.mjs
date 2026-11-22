// A link's preview card in a Pip's chat goes through the editor's real Pips bridge (src/pipsView.ts): the Pips tab's
// page, and a chat's own tab, ask with "dgcLinkPreview" and are answered on the page that asked, by the one host module
// (src/linkPreview.ts). A stand-in host would never notice the bridge dropping the question. Nothing here reaches the
// network: the links are a private host's and a one-time link, which are answered without reading anything.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const viewModule = await pipsViewModule();
const PIP = { id: "pip_" + "5".repeat(32), name: "Shopper", pip_type: "scout" };
const GOA = "conv_" + "a".repeat(32);
const tick = () => new Promise((r) => setTimeout(r, 20));

function host({ previews = true } = {}) {
  const panels = [];
  const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => (key === "linkPreviews" ? previews : fallback) }) },
    window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }),
      createWebviewPanel: (id, title) => { const p = { id, title, posted: [], receive: null, closed: [], visible: true,
        webview: { cspSource: "https://csp.test", html: "", asWebviewUri: (u) => ({ toString: () => "https://csp.test/" + u.path }), postMessage: (m) => { p.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { p.receive = f; } },
        reveal() {}, onDidDispose: (f) => { p.closed.push(f); }, onDidChangeViewState() {}, dispose() {} }; panels.push(p); return p; } } };
  const { PipsEditor } = viewModule(vscode);
  const main = [], sent = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach((m) => main.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 111 }, {});
  return { editor, main, sent, panels, previews: (list) => list.filter((m) => m.type === "dgcLinkPreview") };
}

test("the Pips page's question is answered on the Pips page, through the real bridge", async () => {
  const h = host();
  h.editor.receive({ type: "dgcLinkPreview", id: "a1", url: "http://localhost:3000/app" });
  h.editor.receive({ type: "dgcLinkPreview", id: "a2", url: "https://example.com/reset?token=abc" });
  await tick();
  assert.deepEqual(h.previews(h.main), [
    { type: "dgcLinkPreview", id: "a1", url: "http://localhost:3000/app", state: "address", why: "private", site: "localhost:3000" },
    { type: "dgcLinkPreview", id: "a2", url: "https://example.com/reset?token=abc", state: "address", why: "one-time", site: "example.com" }]);
  assert.deepEqual(h.sent, [], "it never goes to DGC as a Pips control: the editor answers it");
});

test("a chat's own tab is answered in that tab, never on the Pips page", async () => {
  const h = host();
  h.editor.openChat(PIP, { id: GOA, title: "Trip to Goa" });
  const tab = h.panels.find((p) => p.id === "dgc.pipChat");
  assert.ok(tab?.receive, "premise: the chat's tab is open");
  tab.receive({ type: "dgcLinkPreview", id: "t1", url: "http://192.168.1.10/" });
  await tick();
  assert.deepEqual(h.previews(tab.posted), [{ type: "dgcLinkPreview", id: "t1", url: "http://192.168.1.10/", state: "address", why: "private", site: "192.168.1.10" }]);
  assert.deepEqual(h.previews(h.main), []);
});

test("with dgc.linkPreviews off the bridge says off, and what isn't the question is not answered", async () => {
  const h = host({ previews: false });
  h.editor.receive({ type: "dgcLinkPreview", id: "o1", url: "https://example.com/" });
  h.editor.receive({ type: "dgcLinkPreview", id: 12, url: "https://example.com/" });
  h.editor.receive({ type: "dgcLinkPreview", id: "o2" });
  await tick();
  assert.deepEqual(h.previews(h.main), [{ type: "dgcLinkPreview", id: "o1", url: "https://example.com/", state: "off" }]);
});
