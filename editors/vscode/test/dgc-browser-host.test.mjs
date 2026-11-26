// DGC Browser from the side bar (Pips API 107) through the editor's Pips bridge (src/pipsView.ts): the dock's and
// Home's Browser open it (open_dgc_browser), Home's card reads the newest tabs (get_dgc_browser_recent), and "Install
// Google Chrome" asks DGC to install it (install_google_chrome). Each goes to DGC as a Pips control, only with the
// fields the side bar sends, never to an older DGC. (Found on a real Remote-SSH window: the dock's click answered
// "Unknown Pips command." because the bridge never let these through.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const viewModule = await pipsViewModule();
const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, f) => f }) }, window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }) } };

function bridge(api) {
  const { PipsEditor } = viewModule(vscode);
  const page = [], sent = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach((m) => page.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
  editor.receive({ type: "pipsReady" });
  const generation = page.filter((m) => m.type === "pipsConnection").at(-1).generation;
  const ask = (id, request) => editor.receive({ type: "pipsRequest", id, generation, request });
  return { page, sent, ask, controls: () => sent.filter((m) => m.type === "pips_control").map((m) => m.request), replies: () => page.filter((m) => m.type === "pipsReply") };
}

test("the dock's Browser, Home's card and Install Google Chrome reach DGC as Pips controls", () => {
  const b = bridge(111);
  b.ask("r1", { type: "open_dgc_browser", editor_bounds: { x: 0, y: 0, width: 1200, height: 900 } });
  b.ask("r2", { type: "open_dgc_browser", url: "news.example.com", editor_bounds: { x: 10, y: 20, width: 800, height: 600, screen: { x: 0, y: 25, width: 1920, height: 1055 } } });
  b.ask("r3", { type: "open_dgc_browser" });
  b.ask("r4", { type: "get_dgc_browser_recent" });
  b.ask("r5", { type: "install_google_chrome" });
  assert.deepEqual(b.controls().map((r) => r.type), ["open_dgc_browser", "open_dgc_browser", "open_dgc_browser", "get_dgc_browser_recent", "install_google_chrome"]);
  assert.equal(b.controls()[1].url, "news.example.com");
  assert.deepEqual(b.controls()[0].editor_bounds, { x: 0, y: 0, width: 1200, height: 900 });
  assert.deepEqual(b.controls()[1].editor_bounds.screen, { x: 0, y: 25, width: 1920, height: 1055 }, "the shape editorBounds() sends");
  assert.deepEqual(b.replies().filter((m) => m.ok === false), [], "none refused");
});

test("anything else in them is refused in plain words, and nothing is sent", () => {
  const b = bridge(111);
  b.ask("r1", { type: "open_dgc_browser", pip_id: "pip_" + "a".repeat(32) });
  b.ask("r2", { type: "open_dgc_browser", url: 42 });
  b.ask("r3", { type: "open_dgc_browser", url: "x".repeat(2001) });
  b.ask("r4", { type: "open_dgc_browser", editor_bounds: { x: "0", y: 0, width: 1, height: 1 } });
  b.ask("r5", { type: "open_dgc_browser", editor_bounds: { x: 0, y: 0, width: 1, height: 1, script: "x" } });
  b.ask("r5b", { type: "open_dgc_browser", editor_bounds: { x: 0, y: 0, width: 1, height: 1, screen: { x: 0, y: 0, width: "wide", height: 1 } } });
  b.ask("r6", { type: "get_dgc_browser_recent", tabs: "all" });
  b.ask("r7", { type: "install_google_chrome", line: "rm -rf /" });
  assert.deepEqual(b.controls(), []);
  assert.ok(b.replies().every((m) => m.ok === false && m.error?.message === "DGC Browser can't be asked that from here."), JSON.stringify(b.replies()));
});

test("an older DGC (Pips API 106) is sent none of them, and says to update", () => {
  const b = bridge(106);
  b.ask("r1", { type: "open_dgc_browser" });
  b.ask("r2", { type: "get_dgc_browser_recent" });
  assert.deepEqual(b.controls(), []);
  assert.deepEqual(b.replies().map((m) => m.error?.message), ["Update DGC to use DGC Browser.", "Update DGC to use DGC Browser."]);
});
