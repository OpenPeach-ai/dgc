// Ask in chat from a design's canvas, for a design a Pip made: the reference goes to that Pip's prompt box in the Pips
// tab, opened BESIDE the canvas (never in its group, where it would push the canvas out of sight); a Pips tab already
// open stays where it is. Other ways of opening the Pips tab still open it in the active group, as before.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const viewModule = await pipsViewModule();
const editors = [];
after(() => { for (const e of editors) e.dispose(); });
const PIP = "pip_" + "5".repeat(32);

function host() {
  const panels = [];
  const vscode = { ViewColumn: { Active: -1, Beside: -2 },
    Uri: { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/"), fsPath: [base.fsPath, ...parts].join("/") }), file: (p) => ({ path: p, fsPath: p }), parse: (t) => ({ toString: () => t }) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (key, fallback) => fallback }) },
    window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }),
      createWebviewPanel: (id, title, column) => { const p = { id, title, column, reveals: [], posted: [], closed: [], visible: true, viewColumn: column === -2 ? 2 : 1,
        webview: { cspSource: "https://csp.test", html: "", asWebviewUri: (u) => ({ toString: () => "https://csp.test/" + u.path }), postMessage: (m) => { p.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: () => ({ dispose() {} }) },
        reveal(c) { p.reveals.push(c); }, onDidDispose: (f) => { p.closed.push(f); }, onDidChangeViewState() {}, dispose() { for (const f of p.closed) f(); } };
        panels.push(p); return p; } } };
  const { PipsEditor } = viewModule(vscode);
  const editor = new PipsEditor({ path: "ext", fsPath: "/ext" }, () => true, () => {}, true);
  editors.push(editor);
  editor.attach(() => {});
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 99 }, {});
  return { editor, panels: () => panels.filter((p) => p.id === "dgc.pips") };
}

test("Ask in chat opens the Pip's chat beside the canvas, with the reference in its box", () => {
  const h = host();
  h.editor.open({ pip: PIP, section: "chat", compose: "[Artboard “Poster” of the design “Book Club Poster”] " });
  const [tab] = h.panels();
  assert.equal(tab.column, -2, "beside the canvas, not in its group");
  const nav = tab.posted.find((m) => m.type === "pipsNavigate") || null;
  assert.ok(nav === null || nav.navigation.compose.startsWith("[Artboard"), "the reference goes with it");
});

test("a Pips tab already open stays in its own group when Ask in chat reaches it", () => {
  const h = host();
  h.editor.open({ pip: PIP });
  const [tab] = h.panels();
  assert.equal(tab.column, -1, "opened the usual way: in the active group, as before");
  h.editor.open({ pip: PIP, section: "chat", compose: "[Artboard “Poster”] " });
  assert.notEqual(tab.reveals.at(-1), -1, "not pulled into the canvas's group");
  assert.equal(tab.posted.filter((m) => m.type === "pipsNavigate").at(-1).navigation.compose, "[Artboard “Poster”] ");
});
