// Comments on an artifact, on the extension's side (src/artifacts.ts), bundled against a stub `vscode` with a host that
// records every command: the panel's page asks through the real panel (ArtifactPanel's own allowlist of what a page may
// ask), only of a process that offers comments, with only the fields each command has; the threads the process sends
// reach every page showing that artifact, and every screen hears the count (the Library's row).
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { artifactsModule } from "./support/artifact-scene.mjs";

const world = {};
function fakePanel(viewType, title) {
  const received = [], disposed = [];
  return {
    viewType, title, iconPath: undefined, revealed: 0, disposedCount: 0,
    webview: { options: {}, html: "", cspSource: "vscode-resource:", posted: [], asWebviewUri: (u) => u,
      postMessage(m) { this.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (fn) => { received.push(fn); return { dispose() {} }; } },
    onDidDispose: (fn) => { disposed.push(fn); return { dispose() {} }; },
    reveal() { this.revealed++; },
    dispose() { if (this.disposedCount++) return; disposed.forEach((fn) => fn()); },
    say(m) { received.forEach((fn) => fn(m)); },
    last(type) { return [...this.webview.posted].reverse().find((m) => m.type === type); },
  };
}
const uri = (p) => ({ scheme: "file", fsPath: p, path: p, toString: (skip) => `file://${p}` });
globalThis.__DGC_ART_VSCODE = {
  Uri: { file: uri, joinPath: (base, ...parts) => uri([base.fsPath ?? String(base), ...parts].join("/")),
    parse: (value) => ({ scheme: value.split(":")[0], fsPath: "", path: value.replace(/^\w+:\/\/[^/]*/, ""), toString: () => value }) },
  ViewColumn: { Active: -1, Beside: -2 },
  ProgressLocation: { Notification: 15 },
  window: {
    createWebviewPanel: (viewType, title, column) => { const p = fakePanel(viewType, title); p.column = column; world.panels.push(p); return p; },
    registerWebviewPanelSerializer: (viewType, serializer) => { world.serializers.push({ viewType, serializer }); return { dispose() {} }; },
    showWarningMessage: async (message, options, ...items) => { world.warnings.push({ message, options, items }); return world.answer; },
    showInformationMessage: async (message) => { world.infos.push(message); return undefined; },
    showSaveDialog: async (options) => { world.saveAsked = options; return world.saveTo; },
    showQuickPick: async (items, options) => { world.picks.push(items); world.pickOptions = options; return typeof world.pick === "function" ? world.pick(items) : undefined; },
    showTextDocument: async (u) => { world.shown.push(u.fsPath); },
    withProgress: async (_o, task) => task(),
  },
  env: { asExternalUri: async (u) => ({ toString: () => u.toString().replace("127.0.0.1", "forwarded.example") }),
         openExternal: async (u) => { world.external.push(u.toString()); return true; } },
  workspace: { workspaceFolders: [{ uri: uri("/work") }],
    fs: { copy: async (from, to) => { world.copies.push([from.fsPath, to.fsPath]); },
          // (A download reads the file the process made, as a real file.)
          stat: async (u) => { const { statSync } = await import("node:fs"); const s = statSync(u.fsPath); return { type: s.isFile() ? 1 : 2, size: s.size }; },
          readFile: async (u) => (u.fsPath in world.files ? Buffer.from(world.files[u.fsPath]) : (await import("node:fs")).readFileSync(u.fsPath)) } },
  commands: { executeCommand: async (...args) => { world.commands.push(args); } },
};
const art = artifactsModule();
after(() => { delete globalThis.__DGC_ART_VSCODE; });

const OFFER = { version: 1, types: ["page", "doc", "slides", "sheet", "dashboard"], outputs: ["auto", "document", "slides", "spreadsheet", "page", "dashboard"],
                exports: { doc: ["docx", "pdf", "md"], slides: ["pptx", "pdf", "html"], sheet: ["xlsx", "csv"], dashboard: ["pdf", "html"], page: ["docx", "pdf", "html", "zip"] },
                present: false };
const ID = "ar_" + "a".repeat(16);
const VIEW = { id: ID, type: "slides", label: "Slides", title: "Q3 plan", version: 3, exports: ["pptx", "pdf", "html"], origin: { surface: "chat" },
               versions: [{ n: 1, author: "DGC", at: "2026-10-27T09:00:00Z", summary: "Made" }] };
let hub, sent, host;
beforeEach(() => {
  Object.assign(world, { panels: [], serializers: [], warnings: [], infos: [], answer: undefined, saveTo: undefined, saveAsked: undefined,
                         picks: [], pick: undefined, shown: [], external: [], copies: [], files: {}, commands: [] });
  sent = [];
  host = { outcome: "sent", offer: OFFER, send(cmd) { if (this.outcome === "sent") sent.push(cmd); return this.outcome; }, offers() { return this.offer; } };
  hub = new art.Artifacts({ extensionUri: uri("/ext"), subscriptions: [] });
  hub.attach(host);
});
const last = (type) => [...sent].reverse().find((c) => c.type === type);
const COMMENTS = { ...OFFER, comments: true };
const T = "t_" + "1".repeat(12), S = "s_" + "2".repeat(12);

function openOne() {
  host.offer = COMMENTS;
  hub.open(ID, { type: "slides", title: "Q3 plan" });
  const panel = world.panels.at(-1);
  panel.say({ type: "ready" });
  return panel;
}

test("the capability says whether comments are understood; a view carries its count, checked", () => {
  assert.equal(art.artifactsOffer({ artifacts: OFFER }).comments, undefined);
  assert.equal(art.artifactsOffer({ artifacts: { ...OFFER, comments: 1 } }).comments, true);
  assert.deepEqual(art.artifactView({ ...VIEW, comments: { open: 2, all: 3 } }).comments, { open: 2, all: 3 });
  assert.equal(art.artifactView({ ...VIEW, comments: { open: 2, all: 0 } }).comments, undefined);
  assert.deepEqual(art.artifactView({ ...VIEW, comments: { open: 9, all: 3 } }).comments, { open: 3, all: 3 }, "never more open than there are");
});

test("a panel's page asks its threads at once, through the real panel, and only of a process that offers comments", () => {
  host.offer = OFFER;
  hub.open(ID, { type: "slides", title: "Q3 plan" });
  const old = world.panels.at(-1);
  old.say({ type: "ready" });
  old.say({ type: "comments", op: "add", anchor: { kind: "whole" }, text: "hello" });
  assert.equal(sent.filter((c) => c.type.startsWith("artifact_comment")).length, 0, "an older process is asked nothing");
  old.dispose();
  const panel = openOne();
  const list = last("artifact_comment_list");
  assert.equal(list.id, ID);
  assert.match(list.request_id, /^art-comment_list-\d+$/);
});

test("each thing a page asks goes as its own command, with only its own fields; anything else goes nowhere", () => {
  const panel = openOne();
  sent.length = 0;
  panel.say({ type: "comments", op: "add", text: "  Say which train  ", ask: true, version: 3, extra: "x",
              anchor: { kind: "slide", slide: 2, field: "bullets", title: "Getting there", quote: "Early train", evil: "<b>", values: "no" } });
  const add = last("artifact_comment_add");
  delete add.request_id;
  assert.deepEqual(add, { type: "artifact_comment_add", id: ID, text: "Say which train", ask: true, version: 3,
                          anchor: { kind: "slide", slide: 2, field: "bullets", title: "Getting there", quote: "Early train" } });
  panel.say({ type: "comments", op: "add", text: "x", anchor: { kind: "cells", sheet: "Budget", range: "B3", values: [[1, "a", null, true]] } });
  assert.deepEqual(last("artifact_comment_add").anchor.values, [[1, "a", null, true]]);
  for (const [message, type, fields] of [
    [{ op: "reply", thread: T, text: "Or a bus", ask: false }, "artifact_comment_reply", { thread: T, text: "Or a bus" }],
    [{ op: "resolve", thread: T, resolved: true }, "artifact_comment_resolve", { thread: T, resolved: true }],
    [{ op: "resolve", thread: T, resolved: false }, "artifact_comment_resolve", { thread: T, resolved: false }],
    [{ op: "ask", thread: T }, "artifact_comment_ask", { thread: T }],
    [{ op: "delete", thread: T }, "artifact_comment_delete", { thread: T }],
    [{ op: "accept", thread: T, suggestion: S }, "artifact_suggestion_accept", { thread: T, suggestion: S }],
    [{ op: "reject", thread: T, suggestion: S }, "artifact_suggestion_reject", { thread: T, suggestion: S }]]) {
    sent.length = 0;
    panel.say({ type: "comments", ...message });
    assert.equal(sent.length, 1, type);
    const { request_id, ...rest } = sent[0];
    assert.deepEqual(rest, { type, id: ID, ...fields }, type);
  }
  sent.length = 0;
  for (const bad of [{ op: "add", text: "", anchor: { kind: "whole" } }, { op: "add", text: "x", anchor: { kind: "teleport" } },
                     { op: "add", text: "x" }, { op: "reply", thread: "t_short", text: "x" }, { op: "reply", thread: T, text: "   " },
                     { op: "accept", thread: T, suggestion: "nope" }, { op: "resolve", thread: T }, { op: "rename", thread: T },
                     { op: "ask", thread: "../../etc" }]) panel.say({ type: "comments", ...bad });
  assert.deepEqual(sent, [], "nothing unchecked reaches the process");
});

test("the threads the process sends reach every page showing the artifact; every screen hears the count; a refusal goes to the page that asked", () => {
  const panel = openOne();
  const heard = [];
  hub.listen((m) => heard.push(m));
  const other = [];
  const stop = hub.watchComments(ID, (m) => other.push(m));
  const threads = [{ id: T, status: "open", messages: [] }, { id: "t_" + "3".repeat(12), status: "resolved", messages: [] }];
  assert.equal(hub.onEvent({ type: "artifact_comments", id: ID, version: 3, threads }), true, "the artifacts' own event");
  assert.deepEqual(panel.last("comments"), { type: "comments", id: ID, version: 3, threads });
  assert.deepEqual(other.at(-1), { type: "comments", id: ID, version: 3, threads });
  assert.deepEqual(heard.at(-1), { type: "artifactComments", id: ID, open: 1, all: 2 });
  stop.dispose();
  hub.onEvent({ type: "artifact_comments", id: ID, version: 4, threads: [] });
  assert.equal(other.at(-1).version, 3, "a page that stopped watching hears no more");
  // An answer to this page's own request is the threads too; a refusal is said to that page.
  panel.say({ type: "comments", op: "accept", thread: T, suggestion: S });
  const asked = last("artifact_suggestion_accept");
  hub.onEvent({ type: "command_rejected", request_id: asked.request_id, reason: "invalid", message: "The words this suggestion would change aren't in it any more." });
  assert.deepEqual(panel.last("commentsRejected"), { type: "commentsRejected", op: "accept", reason: "invalid",
                                                     message: "The words this suggestion would change aren't in it any more." });
  // The panel closed: its page no longer hears.
  const before = panel.webview.posted.length;
  panel.dispose();
  hub.onEvent({ type: "artifact_comments", id: ID, version: 5, threads });
  assert.equal(panel.webview.posted.length, before);
});

test("a page opened while the process starts is asked its threads once the process is ready", () => {
  host.offer = undefined;
  hub.open(ID, { type: "slides", title: "Q3 plan" });
  const panel = world.panels.at(-1);
  panel.say({ type: "ready" });
  assert.equal(last("artifact_comment_list"), undefined);
  host.offer = COMMENTS;
  hub.backendReady();
  assert.equal(last("artifact_comment_list").id, ID);
});

test("an anchor keeps only the fields a place has, as the right kinds", () => {
  assert.equal(art.commentAnchor(null), undefined);
  assert.equal(art.commentAnchor({ kind: "nowhere" }), undefined);
  assert.deepEqual(art.commentAnchor({ kind: "text", quote: "q".repeat(3000), before: 5, after: "a" }), { kind: "text", quote: "q".repeat(2000), after: "a" });
  assert.deepEqual(art.commentAnchor({ kind: "slide", slide: 1.5 }), { kind: "slide" });
  assert.deepEqual(art.commentAnchor({ kind: "cells", values: Array.from({ length: 60 }, () => [1]) }), { kind: "cells" }, "50 cells at most");
  assert.deepEqual(art.commentAnchor({ kind: "cells", values: [[{ deep: 1 }]] }), { kind: "cells" });
});
