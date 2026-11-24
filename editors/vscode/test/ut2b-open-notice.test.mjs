// User test round 2, D7 / P10: the editor's "DGC updated “<artifact>”" notification came up for an artifact that was
// open in a tab already (it covers the dock and the prompt box, and the tab had updated in place). The pop-up is never
// stacked, so a change that arrives while another notification is up waits its turn; by the time its turn came the
// person had opened the artifact from its card, and it was shown all the same. One that waited is asked again whether
// its artifact is on screen.
// D8: every Open from a card added one more editor column (session | deck | design: three 360 px columns). The first
// opens beside; the next ones open in that same group, as tabs. Bundled against a stub `vscode`, as
// artifact-open-notice.test.mjs is.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { artifactsModule } from "./support/artifact-scene.mjs";

const world = {};
function fakePanel(viewType, title) {
  const received = [], disposed = [];
  return { viewType, title, iconPath: undefined, revealed: 0,
    webview: { options: {}, html: "", cspSource: "vscode-resource:", posted: [], asWebviewUri: (u) => u,
      postMessage(m) { this.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (fn) => { received.push(fn); return { dispose() {} }; } },
    onDidDispose: (fn) => { disposed.push(fn); return { dispose() {} }; },
    reveal() { this.revealed++; }, dispose() { disposed.forEach((fn) => fn()); } };
}
const uri = (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => `file://${p}` });
const before = globalThis.__DGC_ART_VSCODE;
globalThis.__DGC_ART_VSCODE = {
  Uri: { file: uri, joinPath: (base, ...parts) => uri([base.fsPath ?? String(base), ...parts].join("/")), parse: (value) => ({ scheme: value.split(":")[0], fsPath: "", path: value, toString: () => value }) },
  ViewColumn: { Active: -1, Beside: -2 },
  window: {
    // (As the editor does: Beside makes a new group to the right of the active one; a column number opens there.)
    createWebviewPanel: (viewType, title, column) => { const p = fakePanel(viewType, title); p.asked = column; p.viewColumn = column === -2 ? ++world.columns : column === -1 ? world.active : column;
      world.panels.push(p); world.active = p.viewColumn; return p; },
    get tabGroups() { return { all: world.groups }; },
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
    showWarningMessage: async () => undefined,
    showInformationMessage: (message, ...items) => new Promise((resolve) => { world.shown.push({ message, items, answer: resolve }); }),
    showTextDocument: async (u) => { world.docs.push(u.fsPath); },
  },
  env: { asExternalUri: async (u) => u, openExternal: async () => true },
  workspace: { workspaceFolders: [{ uri: uri("/work") }], fs: {} },
  commands: { executeCommand: async (...args) => { world.commands.push(args);
    if (args[0] === "vscode.openWith") { const col = args[3].viewColumn === -2 ? ++world.columns : args[3].viewColumn; world.groups.push({ viewColumn: col, tabs: [{ input: { uri: args[1] } }] }); world.active = col; } } },
};
const art = artifactsModule();
after(() => { if (before === undefined) delete globalThis.__DGC_ART_VSCODE; else globalThis.__DGC_ART_VSCODE = before; });

const ID = "ar_" + "a".repeat(16), OTHER = "ar_" + "b".repeat(16);
const view = (id, title, more = {}) => ({ id, type: "design", label: "Design", title, version: 1, exports: [], origin: { surface: "work" },
  versions: [{ n: 1, author: "DGC", at: "2026-11-22T09:00:00Z", summary: "Made" }], ...more });
const changed = (artifact, op = "made", more = {}) => ({ type: "artifact_changed", artifact, op, surface: "work", ...more });
function memory() { const kept = new Map(); return { get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, JSON.parse(JSON.stringify(v))); } }; }
function window_(options = {}) {
  const store = memory(), hub = new art.Artifacts({ extensionUri: uri("/ext"), subscriptions: [], globalState: store });
  hub.attach({ send: () => "sent", offers: () => ({ version: 1 }) });
  const notice = new art.ArtifactNotice({ globalState: store }, hub, options);
  hub.listen((message) => notice.heard(message));
  return { hub, notice };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { Object.assign(world, { panels: [], shown: [], docs: [], commands: [], groups: [], columns: 1, active: 1 }); });
const v = (n) => ({ version: n, versions: [{ n, author: "DGC" }] });

test("an update that waited its turn is not shown once its artifact is open in a tab", async () => {
  const { hub } = window_();
  hub.onEvent(changed(view(ID, "Bakery Landing Page")));
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “Bakery Landing Page”"], "premise: made, and not open: offered");
  hub.onEvent(changed(view(ID, "Bakery Landing Page", v(2)), "changed"));          // DGC draws the next artboard: this one waits
  hub.open(ID, { type: "design", title: "Bakery Landing Page" });                    // the person opens it from its card
  world.shown[0].answer(undefined); await tick();                                    // the first notification goes
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “Bakery Landing Page”"], "no “DGC updated” for what the open tab already shows");
  hub.onEvent(changed(view(ID, "Bakery Landing Page", v(3)), "changed"));
  hub.onEvent(changed(view(ID, "Bakery Landing Page", v(4)), "changed"));
  await tick();
  assert.equal(world.shown.length, 1, "nor for any later change while it is open");
});

test("the same when the first notification leaves the screen by itself", async () => {
  const { hub } = window_({ holdMs: 40 });
  hub.onEvent(changed(view(ID, "Bakery Landing Page")));
  hub.onEvent(changed(view(ID, "Bakery Landing Page", v(2)), "changed"));
  hub.open(ID, { type: "design", title: "Bakery Landing Page" });
  await tick(90);
  assert.equal(world.shown.length, 1);
});

test("other notifications are unchanged: one that waited for an artifact that is NOT open still shows, and so does the next thing made", async () => {
  const { hub } = window_();
  hub.onEvent(changed(view(ID, "Bakery Landing Page")));
  hub.onEvent(changed(view(OTHER, "Price list", { type: "sheet" })));
  hub.open(ID, { type: "design", title: "Bakery Landing Page" });
  world.shown[0].answer(undefined); await tick();
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “Bakery Landing Page”", "DGC made “Price list”"]);
  world.shown[1].answer(undefined); await tick();
  // Its tab closed: a later change is news again.
  world.panels[0].dispose();
  hub.onEvent(changed(view(ID, "Bakery Landing Page", v(2)), "changed"));
  assert.equal(world.shown.at(-1).message, "DGC updated “Bakery Landing Page”");
});

test("D8: the first artifact opens beside; the next ones open in that same group, never one more column each", async () => {
  const { hub } = window_();
  hub.open(ID, { type: "slides", title: "Bulk discount pitch" });
  assert.equal(world.panels[0].asked, -2, "the first: beside the session");
  assert.equal(world.panels[0].viewColumn, 2);
  world.active = 1;                                               // back in the session, on the next card
  hub.open(OTHER, { type: "design", title: "Bakery Landing Page" });
  assert.equal(world.panels[1].viewColumn, 2, "the second: a tab in the group the first opened");
  assert.equal(world.columns, 2, "two columns, not three");
  // A document is a file in its editor: it goes to the same group.
  world.active = 1;
  hub.open("ar_" + "d".repeat(16), { type: "doc", title: "Guide", file: "/home/me/.dgc/artifacts/ar_dddddddddddddddd/work/Guide.md" }); await tick();
  const opened = world.commands.find((c) => c[0] === "vscode.openWith");
  assert.equal(opened[3].viewColumn, 2);
  assert.equal(world.columns, 2);
  // With the artifacts' own group in front (the Library opens one): still that group.
  world.active = 2;
  hub.open("ar_" + "e".repeat(16), { type: "sheet", title: "Price list" });
  assert.equal(world.panels.at(-1).viewColumn, 2);
});

test("D8: once every artifact tab is closed, the next one opens beside again; a document's group is reused too", async () => {
  const { hub } = window_();
  hub.open(ID, { type: "slides", title: "Bulk discount pitch" });
  world.panels[0].dispose();
  world.active = 1; world.columns = 1;
  hub.open(OTHER, { type: "design", title: "Bakery Landing Page" });
  assert.equal(world.panels[1].asked, -2, "no artifact is open: beside, as the first");
  world.panels[1].dispose(); world.active = 1; world.columns = 1;
  hub.open("ar_" + "d".repeat(16), { type: "doc", title: "Guide", file: "/home/me/.dgc/artifacts/ar_dddddddddddddddd/work/Guide.md" }); await tick();
  assert.equal(world.groups[0].viewColumn, 2);
  world.active = 1;
  hub.open(ID, { type: "slides", title: "Bulk discount pitch" });
  assert.equal(world.panels.at(-1).viewColumn, 2, "beside the session there is the document's group: the deck opens in it");
  assert.equal(world.columns, 2);
});
