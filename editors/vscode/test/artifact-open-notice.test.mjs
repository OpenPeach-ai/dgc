// The "Open" pop-up (src/artifactNotice.ts; asked 14 Nov): whenever a Work, Chat or Pip turn makes or updates a
// page, a document, slides, a sheet or a dashboard (or a chat makes a widget nobody is looking at), ONE editor
// notification says DGC made “<title>” (or updated) with Open, which opens it where DGC opens it: a document in its
// editor tab, everything else in its artifact tab. Once per artifact and version, also after a reload; never a stack
// (while one is unanswered the newest waits, and only the newest); none for the person's own edits, nor for one that is
// already open in a tab. Bundled against a stub `vscode`, as artifact-host.test.mjs is.
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
globalThis.__DGC_ART_VSCODE = {
  Uri: { file: uri, joinPath: (base, ...parts) => uri([base.fsPath ?? String(base), ...parts].join("/")), parse: (value) => ({ scheme: value.split(":")[0], fsPath: "", path: value, toString: () => value }) },
  ViewColumn: { Active: -1, Beside: -2 },
  window: {
    createWebviewPanel: (viewType, title) => { const p = fakePanel(viewType, title); world.panels.push(p); return p; },
    registerWebviewPanelSerializer: () => ({ dispose() {} }),
    showWarningMessage: async () => undefined,
    // A notification stays until it is answered or dismissed: each is held here, answered by the test.
    showInformationMessage: (message, ...items) => new Promise((resolve) => { world.shown.push({ message, items, answer: resolve }); }),
    showTextDocument: async (u) => { world.docs.push(u.fsPath); },
  },
  env: { asExternalUri: async (u) => u, openExternal: async () => true },
  workspace: { workspaceFolders: [{ uri: uri("/work") }], fs: {} },
  commands: { executeCommand: async (...args) => { world.commands.push(args); } },
};
const art = artifactsModule();
after(() => { delete globalThis.__DGC_ART_VSCODE; });

const ID = "ar_" + "a".repeat(16), OTHER = "ar_" + "b".repeat(16), THIRD = "ar_" + "c".repeat(16);
const view = (id, title, more = {}) => ({ id, type: "slides", label: "Slides", title, version: 1, exports: [], origin: { surface: "work" },
  versions: [{ n: 1, author: "DGC", at: "2026-11-14T09:00:00Z", summary: "Made" }], ...more });
const changed = (artifact, op = "made", more = {}) => ({ type: "artifact_changed", artifact, op, surface: "work", ...more });
/** The editor's global state, kept across "reloads" (a new hub and notice over the same store). */
function memory() { const kept = new Map(); return { get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, JSON.parse(JSON.stringify(v))); } }; }
function window_(store = memory(), options = {}) {
  const hub = new art.Artifacts({ extensionUri: uri("/ext"), subscriptions: [], globalState: store });
  hub.attach({ send: () => "sent", offers: () => ({ version: 1 }) });
  const notice = new art.ArtifactNotice({ globalState: store }, hub, options);
  hub.listen((message) => notice.heard(message));
  return { hub, notice, store };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
beforeEach(() => { Object.assign(world, { panels: [], shown: [], docs: [], commands: [] }); });

test("a turn makes one: one notification, DGC made “title”, with Open, which opens it in its tab", async () => {
  const { hub } = window_();
  hub.onEvent(changed(view(ID, "Q3 plan")));
  assert.equal(world.shown.length, 1);
  assert.equal(world.shown[0].message, "DGC made “Q3 plan”");
  assert.deepEqual(world.shown[0].items, ["Open"]);
  assert.equal(world.panels.length, 0, "nothing opens by itself");
  world.shown[0].answer("Open"); await tick();
  assert.equal(world.panels.length, 1, "its artifact tab");
  assert.equal(world.panels[0].title, "Q3 plan");
});

test("a document opens in its editor tab, over its working file", async () => {
  const { hub } = window_();
  const file = `/home/me/.dgc/artifacts/${ID}/work/Notes.md`;
  hub.onEvent(changed(view(ID, "Notes", { type: "doc", label: "Document", file })));
  assert.equal(world.shown[0].message, "DGC made “Notes”");
  world.shown[0].answer("Open"); await tick();
  assert.equal(world.panels.length, 0);
  assert.equal(world.commands.some((c) => c[0] === "vscode.openWith" && c[1].fsPath === file), true, "the document's own editor");
});

test("once per artifact and version: the same change told twice (two processes say it) is one notification; a new version says updated", async () => {
  const { hub } = window_();
  hub.onEvent(changed(view(ID, "Q3 plan")));
  hub.onEvent(changed(view(ID, "Q3 plan")));
  hub.onEvent(changed(view(ID, "Q3 plan"), "changed"));            // a rename-free echo of the same version
  assert.equal(world.shown.length, 1);
  world.shown[0].answer(undefined); await tick();                    // dismissed
  hub.onEvent(changed(view(ID, "Q3 plan", { version: 2, versions: [{ n: 1, author: "DGC" }, { n: 2, author: "DGC" }] }), "changed"));
  assert.equal(world.shown.length, 2);
  assert.equal(world.shown[1].message, "DGC updated “Q3 plan”");
  assert.deepEqual(world.shown[1].items, ["Open"]);
});

test("never a stack: while one is unanswered the newest waits, and only the newest; it shows once the first is answered", async () => {
  const { hub } = window_();
  hub.onEvent(changed(view(ID, "First")));
  hub.onEvent(changed(view(OTHER, "Second")));
  hub.onEvent(changed(view(THIRD, "Third")));
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “First”"], "one on screen");
  world.shown[0].answer(undefined); await tick();
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “First”", "DGC made “Third”"], "the newest replaced the one that waited");
  world.shown[1].answer("Open"); await tick();
  assert.deepEqual(world.panels.map((p) => p.title), ["Third"]);
  assert.equal(world.shown.length, 2, "Second is on Home and in its chat, not in a third pop-up");
});

test("an unanswered one leaves the screen by itself after a while: the one that waited shows then", async () => {
  const { hub } = window_(memory(), { holdMs: 40 });
  hub.onEvent(changed(view(ID, "First")));
  hub.onEvent(changed(view(OTHER, "Second")));
  assert.equal(world.shown.length, 1);
  await tick(90);
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “First”", "DGC made “Second”"]);
  // Open on the older one, found later in the bell, still opens its own.
  world.shown[0].answer("Open"); await tick();
  assert.deepEqual(world.panels.map((p) => p.title), ["First"]);
});

test("no repeat on reload: what was already offered is remembered in the editor's own state", async () => {
  const store = memory();
  const first = window_(store);
  first.hub.onEvent(changed(view(ID, "Q3 plan")));
  assert.equal(world.shown.length, 1);
  // The window reloads: a new hub over the same state, told of the same artifact again.
  const again = window_(store);
  again.hub.onEvent(changed(view(ID, "Q3 plan")));
  again.hub.onEvent(changed(view(ID, "Q3 plan"), "changed"));
  assert.equal(world.shown.length, 1, "not again");
  again.hub.onEvent(changed(view(ID, "Q3 plan", { version: 3 }), "changed"));
  assert.equal(world.shown.length, 2, "a new version is news");
  assert.equal(world.shown[1].message, "DGC updated “Q3 plan”");
});

test("not for the person's own doing: their edit, their restore, a removal, a refresh, or this window's own save", () => {
  const { hub } = window_();
  hub.onEvent(changed(view(ID, "Mine", { version: 2, versions: [{ n: 1, author: "DGC" }, { n: 2, author: "you" }] }), "changed"));
  hub.onEvent(changed(view(OTHER, "Back", { version: 4 }), "restored"));
  hub.onEvent(changed(view(OTHER, "Back", { version: 4 }), "removed"));
  hub.onEvent(changed(view(THIRD, "Numbers", { type: "dashboard", version: 2 }), "refreshed"));
  // This window's own request (its panel's Save): the reply carries the request's id.
  hub.ask({ type: "artifact_update", id: THIRD }, { ok() {}, fail() {} });
  hub.onEvent(changed(view(THIRD, "Numbers", { version: 3, versions: [{ n: 3, author: "DGC" }] }), "changed", { request_id: "art-update-1" }));
  assert.deepEqual(world.shown, []);
});

test("not when it is already open in a tab; and one a chat or a Pip made is offered like Work's", async () => {
  const { hub } = window_();
  hub.open(ID, { type: "slides", title: "Q3 plan" });
  assert.equal(world.panels.length, 1);
  hub.onEvent(changed(view(ID, "Q3 plan", { version: 2, versions: [{ n: 2, author: "DGC" }] }), "changed"));
  assert.equal(world.shown.length, 0, "it is on screen already: its tab shows the change");
  hub.onEvent(changed(view(OTHER, "Trip costs", { type: "sheet", origin: { surface: "chat", chat: "chat_1" } }), "made", { surface: "chat", conversation_id: "chat_1" }));
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “Trip costs”"]);
  world.shown[0].answer(undefined); await tick();
  hub.onEvent(changed(view(THIRD, "Daily audit", { type: "doc", origin: { surface: "pip", pip: "pip_x" }, versions: [{ n: 1, author: "ERP daily audit" }] }), "made", { surface: "pip" }));
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “Trip costs”", "DGC made “Daily audit”"]);
});

test("one that opens by itself is not offered: a chat's document opens beside the chat that is showing it", () => {
  const { hub, notice } = window_();
  notice.opensByItself = (message) => message.surface === "chat" && message.artifact.type === "doc" && message.conversation_id === "chat_on_screen";
  const doc = (id, chat) => changed(view(id, "Letter", { type: "doc", origin: { surface: "chat", chat } }), "made", { surface: "chat", conversation_id: chat });
  hub.onEvent(doc(ID, "chat_on_screen"));
  assert.equal(world.shown.length, 0);
  hub.onEvent(doc(OTHER, "chat_closed"));
  assert.equal(world.shown.length, 1, "nobody is looking at that chat: offered");
});

test("a widget, or anything else with its own way to open: the same one notification, the same once", async () => {
  const { notice } = window_();
  const opened = [];
  const widget = { key: "wg_" + "1".repeat(16), version: 1, title: "Weekly signups", updated: false, open: () => opened.push("widget") };
  notice.offer(widget);
  notice.offer({ ...widget });
  assert.deepEqual(world.shown.map((n) => n.message), ["DGC made “Weekly signups”"]);
  world.shown[0].answer("Open"); await tick();
  assert.deepEqual(opened, ["widget"]);
  // A title is text, bounded, on one line; with none, its kind.
  notice.offer({ key: "wg_" + "2".repeat(16), version: 1, title: "  A\nvery   long " + "x".repeat(300), updated: true, open() {} });
  await tick();
  assert.match(world.shown[1].message, /^DGC updated “A very long x+…”$/);
  assert.ok(world.shown[1].message.length <= 120);
  world.shown[1].answer(undefined); await tick();
  notice.offer({ key: "wg_" + "3".repeat(16), version: 1, title: "", updated: false, open() {} });
  assert.equal(world.shown[2].message, "DGC made something new");
});

// 25 Nov (seen live during an RC run): a checklist the turn is working through popped "DGC updated “<checklist>”" over the
// prompt box at every tick. Its ticks are progress its card and the Tasks pill already show; the pop-up is for its
// making, and for an item that now needs you, said as that.
test("a checklist: made is offered; its ticks are not; an item that now needs you is, once, in those words", async () => {
  const { hub } = window_();
  const list = (version, done, more = {}) => view(ID, "Release list", { type: "checklist", label: "Checklist", version,
    versions: Array.from({ length: version }, (_, k) => ({ n: k + 1, author: "DGC", at: "2026-11-25T09:00:00Z", summary: k ? "Ticked" : "Made" })),
    progress: { done, total: 4, needs: [], pinned: true, ...more } });
  hub.onEvent(changed(list(1, 0)));
  assert.deepEqual(world.shown.map((s) => s.message), ["DGC made “Release list”"]);
  world.shown[0].answer(undefined); await tick();
  hub.onEvent(changed(list(2, 1), "changed"));
  hub.onEvent(changed(list(3, 2), "changed"));
  await tick();
  assert.equal(world.shown.length, 1, "a tick is progress, not news");
  const asks = { needs: ["c3"], waiting: { id: "c3", title: "Pick the version name" } };
  hub.onEvent(changed(list(4, 2, asks), "changed"));
  assert.equal(world.shown.length, 2);
  assert.equal(world.shown[1].message, "“Release list” needs you: Pick the version name");
  assert.deepEqual(world.shown[1].items, ["Open"]);
  world.shown[1].answer(undefined); await tick();
  hub.onEvent(changed(list(5, 3, asks), "changed"));
  await tick();
  assert.equal(world.shown.length, 2, "the same item still waiting is not news again");
});
