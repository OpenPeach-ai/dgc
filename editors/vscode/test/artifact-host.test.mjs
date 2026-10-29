// The artifacts' extension side (src/artifacts.ts), bundled against a stub `vscode`, with a host that records every
// command instead of running a backend: what each screen's action sends, what each reply does, and that a removal
// asks first.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
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
    showQuickPick: async (items) => { world.picks.push(items); return typeof world.pick === "function" ? world.pick(items) : undefined; },
    showTextDocument: async (u) => { world.shown.push(u.fsPath); },
    withProgress: async (_o, task) => task(),
  },
  env: { asExternalUri: async (u) => ({ toString: () => u.toString().replace("127.0.0.1", "forwarded.example") }),
         openExternal: async (u) => { world.external.push(u.toString()); return true; } },
  workspace: { workspaceFolders: [{ uri: uri("/work") }],
    fs: { copy: async (from, to) => { world.copies.push([from.fsPath, to.fsPath]); },
          readFile: async (u) => Buffer.from(world.files[u.fsPath] ?? "") } },
  commands: { executeCommand: async (...args) => { world.commands.push(args); } },
};
const art = artifactsModule();
after(() => { delete globalThis.__DGC_ART_VSCODE; });

const OFFER = { version: 1, types: ["page", "doc", "slides", "sheet", "dashboard"], outputs: ["auto", "document", "slides", "spreadsheet", "page", "dashboard"],
                exports: { doc: ["docx", "pdf", "md"], slides: ["pptx", "pdf", "html"], sheet: ["xlsx", "csv"], dashboard: ["html"], page: ["html", "zip"] },
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
const tick = () => new Promise((r) => setTimeout(r, 0));

test("the capability, checked, and the Output chip's field: only a choice other than Auto, only when offered", () => {
  assert.equal(art.artifactsOffer({}), undefined);
  assert.equal(art.artifactsOffer({ artifacts: { version: 0 } }), undefined);
  assert.deepEqual(art.artifactsOffer({ artifacts: OFFER }), OFFER);
  assert.equal(art.artifactsOffer({ artifacts: { ...OFFER, present: 1 } }).present, true);
  assert.equal(art.outputChoice("slides", undefined), "", "no capability: nothing is sent");
  assert.equal(art.outputChoice("auto", OFFER), "", "Auto is never sent");
  assert.equal(art.outputChoice("", OFFER), "");
  assert.equal(art.outputChoice("slides", OFFER), "slides");
  assert.equal(art.outputChoice("poster", OFFER), "", "only the protocol's choices");
  assert.equal(art.outputChoice("dashboard", { ...OFFER, outputs: ["auto", "document"] }), "", "only what this process offers");
});

test("a panel asks for the artifact with its content, then its own page, and shows DGC's layout of it", async () => {
  const server = createServer((_q, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><html lang=\"en\"><body>deck</body></html>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    hub.open(ID, { type: "slides", title: "Q3 plan" });
    const [panel] = world.panels;
    assert.equal(panel.viewType, art.ARTIFACT_PANEL);
    assert.equal(panel.column, -2, "an artifact opens beside the conversation");
    assert.match(panel.webview.html, /Content-Security-Policy[^>]*default-src 'none'[^>]*script-src 'nonce-/);
    assert.match(panel.webview.html, /frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\* https:;/);
    panel.say({ type: "ready" });
    assert.deepEqual(panel.webview.posted[0], { type: "init", id: ID });
    const get = last("artifact_get");
    assert.deepEqual({ ...get, request_id: "" }, { type: "artifact_get", id: ID, content: true, request_id: "" });
    assert.equal(hub.onEvent({ type: "artifact_detail", artifact: VIEW, content: { slides: [] }, request_id: get.request_id }), true);
    assert.equal(panel.last("detail").artifact.title, "Q3 plan");
    assert.equal(panel.title, "Q3 plan");
    const open = last("artifact_open");
    assert.equal(open.id, ID);
    hub.onEvent({ type: "artifact_served", id: ID, url: `http://127.0.0.1:${server.address().port}/index.html`, request_id: open.request_id });
    for (let i = 0; i < 50 && !panel.last("render"); i++) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(panel.last("render"), { type: "render", html: "<!doctype html><html lang=\"en\"><body>deck</body></html>", version: 3 });
    hub.open(ID, { type: "slides" });
    assert.equal(world.panels.length, 1, "one panel an artifact");
    assert.equal(panel.revealed, 1);
  } finally { server.close(); }
});

test("a page is framed at its own address, as the window's browser reaches it", async () => {
  hub.open(ID, { type: "page", title: "Tips" });
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  hub.onEvent({ type: "artifact_detail", artifact: { ...VIEW, type: "page", exports: ["html", "zip"] }, request_id: last("artifact_get").request_id });
  hub.onEvent({ type: "artifact_served", id: ID, url: "http://127.0.0.1:45012/", request_id: last("artifact_open").request_id });
  await tick(); await tick();
  assert.deepEqual(panel.last("frame"), { type: "frame", url: "http://forwarded.example:45012/", version: 3 });
});

test("Save sends the whole content from the version it started at; a conflict comes back as one", () => {
  hub.open(ID, { type: "slides" });
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  hub.onEvent({ type: "artifact_detail", artifact: VIEW, content: {}, request_id: last("artifact_get").request_id });
  const deck = { theme: "paper", slides: [{ layout: "title", title: "Mine" }] };
  panel.say({ type: "save", content: deck, base_version: 3, note: "Your edits" });
  const update = last("artifact_update");
  assert.deepEqual({ ...update, request_id: "" }, { type: "artifact_update", id: ID, content: deck, base_version: 3, note: "Your edits", request_id: "" });
  assert.equal(hub.onEvent({ type: "command_rejected", command: "artifact_update", reason: "conflict", message: "It changed since version 3.", request_id: update.request_id }), true);
  assert.deepEqual(panel.last("rejected"), { type: "rejected", what: "save", reason: "conflict", message: "It changed since version 3." });
  assert.equal(hub.onEvent({ type: "command_rejected", command: "prompt", reason: "busy", message: "x", request_id: "prompt-1" }), false, "another's refusal isn't the artifacts'");
  panel.say({ type: "save", content: deck, base_version: 3 });
  const again = last("artifact_update");
  assert.equal(hub.onEvent({ type: "artifact_changed", artifact: { ...VIEW, version: 4 }, op: "changed", surface: "editor", request_id: again.request_id }), true);
  assert.equal(panel.last("saved").artifact.version, 4);
  assert.equal(panel.last("changed"), undefined, "its own save isn't news from elsewhere");
  assert.ok(last("artifact_open").request_id !== undefined, "and its page is asked for again");
  panel.say({ type: "save", content: "x".repeat(4 * 1024 * 1024), base_version: 4 });
  assert.equal(panel.last("rejected").reason, "too_large", "more than one frame carries is refused here, with a reason");
});

test("a change from elsewhere reaches its panel and every screen; a Work turn's goes on to its chat too", () => {
  const heard = [];
  hub.listen((m) => heard.push(m));
  hub.open(ID, { type: "slides" });
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  assert.equal(hub.onEvent({ type: "artifact_changed", artifact: { ...VIEW, version: 5 }, op: "changed", surface: "chat", conversation_id: "chat_x" }), true);
  assert.equal(panel.last("changed").artifact.version, 5);
  assert.equal(heard.at(-1).type, "artifactChanged");
  assert.equal(hub.onEvent({ type: "artifact_changed", artifact: { ...VIEW, version: 6 }, op: "changed", surface: "work" }), false, "Work draws its own card");
  assert.equal(heard.length, 2);
  assert.equal(hub.onEvent({ type: "artifact_changed", artifact: { id: "nope", type: "slides" }, op: "changed" }), true, "nothing shown for a bad one");
  assert.equal(heard.length, 2);
  assert.equal(hub.onEvent({ type: "artifact_ready", id: "x" }), false, "the old previews' events aren't these");
});

test("Remove asks first, says it goes to DGC's trash and can be recovered, and only then removes", async () => {
  world.answer = undefined;
  assert.equal(await hub.remove({ id: ID, title: "Q3 plan" }), false);
  assert.equal(world.warnings.length, 1);
  const asked = world.warnings[0];
  assert.match(asked.message, /Remove “Q3 plan”\?/);
  assert.equal(asked.options.modal, true);
  assert.match(asked.options.detail, /trash.*recovered/);
  assert.deepEqual(asked.items, ["Remove"]);
  assert.equal(last("artifact_remove"), undefined, "cancelled: nothing sent");
  world.answer = "Remove";
  const removing = hub.remove({ id: ID, title: "Q3 plan" });
  await tick();
  const cmd = last("artifact_remove");
  assert.equal(cmd.id, ID);
  hub.onEvent({ type: "artifact_changed", artifact: VIEW, op: "removed", surface: "editor", request_id: cmd.request_id });
  assert.equal(await removing, true);
});

test("Export: where to keep it first, then the process makes it and it is copied there", async () => {
  world.saveTo = uri("/work/Q3 plan.pptx");
  const done = hub.exportArtifact(VIEW, "pptx");
  await tick();
  assert.match(world.saveAsked.title, /Export “Q3 plan” as PowerPoint/);
  assert.equal(world.saveAsked.defaultUri.fsPath, "/work/Q3 plan.pptx");
  const cmd = last("artifact_export");
  assert.deepEqual({ ...cmd, request_id: "" }, { type: "artifact_export", id: ID, format: "pptx", request_id: "" });
  hub.onEvent({ type: "artifact_exported", id: ID, format: "pptx", path: "/home/u/.dgc/artifacts/ar_x/exports/Q3 plan.pptx", request_id: cmd.request_id });
  await done;
  assert.deepEqual(world.copies, [["/home/u/.dgc/artifacts/ar_x/exports/Q3 plan.pptx", "/work/Q3 plan.pptx"]]);
  assert.match(world.infos[0], /Exported “Q3 plan.pptx”/);
  await hub.exportArtifact(VIEW, "xlsx");
  assert.equal(last("artifact_export").format, "pptx", "a format it doesn't have is never asked for");
  world.saveTo = undefined;
  await hub.exportArtifact(VIEW, "pdf");
  assert.equal(sent.filter((c) => c.type === "artifact_export").length, 1, "no place chosen: nothing made");
});

test("commands wait for a process that is starting; an older CLI says it needs updating", async () => {
  host.outcome = "starting";
  const listed = hub.list();
  assert.equal(sent.length, 0);
  host.outcome = "sent";
  hub.backendReady();
  const cmd = last("artifact_list");
  assert.ok(cmd, "sent once it's ready");
  hub.onEvent({ type: "artifact_items", items: [VIEW, { id: "bad" }], request_id: cmd.request_id });
  assert.deepEqual((await listed).map((a) => a.id), [ID]);
  host.outcome = "old_cli";
  await assert.rejects(hub.list(), /newer DGC CLI/);
});

test("a document opens in the canvas editor over its working file, and its saves are known to be its", async () => {
  const file = "/home/u/.dgc/artifacts/ar_bbbbbbbbbbbbbbbb/work/Launch notes.md";
  hub.open("ar_bbbbbbbbbbbbbbbb", { type: "doc", title: "Launch notes", file });
  await tick();
  assert.equal(world.panels.length, 0, "no panel for a document");
  assert.deepEqual(world.commands[0].slice(0, 3).map((x) => x?.fsPath ?? x), ["vscode.openWith", file, "dgc.chatdgcCanvasDoc"]);
  assert.deepEqual(hub.docAt(file), { id: "ar_bbbbbbbbbbbbbbbb", title: "Launch notes" });
  assert.equal(hub.docAt("/home/u/.dgc/artifacts/ar_cccccccccccccccc/work/Other.md").id, "ar_cccccccccccccccc", "the store's own layout, after a reload");
  assert.equal(hub.docAt("/home/u/project/notes.md"), undefined);
  assert.equal(hub.docAt("/home/u/.dgc/artifacts/ar_cccccccccccccccc/work/../../x.md"), undefined, "never a path that climbs out");
});

test("Open in browser goes through asExternalUri; Present shows the deck's one-file page in a tab of its own", async () => {
  hub.openInBrowser({ id: ID, title: "Q3 plan" });
  hub.onEvent({ type: "artifact_served", id: ID, url: "http://127.0.0.1:45001/index.html", request_id: last("artifact_open").request_id });
  await tick(); await tick();
  assert.deepEqual(world.external, ["http://forwarded.example:45001/index.html"]);
  world.files["/x/exports/Q3 plan.html"] = "<!doctype html><title>Q3 plan</title><body class=\"present\">";
  hub.present({ id: ID, title: "Q3 plan" });
  const cmd = last("artifact_export");
  assert.equal(cmd.format, "html");
  hub.onEvent({ type: "artifact_exported", id: ID, format: "html", path: "/x/exports/Q3 plan.html", request_id: cmd.request_id });
  for (let i = 0; i < 20 && !world.panels.length; i++) await tick();
  assert.equal(world.panels[0].viewType, art.ARTIFACT_PRESENT);
  assert.equal(world.panels[0].title, "Present: Q3 plan");
  assert.match(world.panels[0].webview.html, /body class="present"/);
});

test("Present, when the process offers it: the deck's present mode at its own address, framed; its Esc closes the tab", async () => {
  host.offer = { ...OFFER, present: true };
  hub.present({ id: ID, title: "Q3 plan" });
  const cmd = last("artifact_open");
  assert.equal(cmd.mode, "present");
  assert.equal(last("artifact_export"), undefined, "no one-file export any more");
  hub.onEvent({ type: "artifact_served", id: ID, url: "http://127.0.0.1:45001/present.html", request_id: cmd.request_id });
  for (let i = 0; i < 20 && !world.panels.length; i++) await tick();
  const panel = world.panels[0];
  assert.equal(panel.viewType, art.ARTIFACT_PRESENT);
  assert.equal(panel.title, "Present: Q3 plan");
  const html = panel.webview.html;
  assert.match(html, /<iframe id="deck" src="http:\/\/forwarded\.example:45001\/present\.html" sandbox="allow-scripts allow-same-origin"/);
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\* https:;/);
  assert.doesNotMatch(html, /allow-top-navigation|allow-popups/);
  panel.say({ type: "exit" });
  assert.equal(panel.disposedCount, 1);
  assert.match(art.presentDocument('http://127.0.0.1:1/"><script>', "n0nce12345"), /src="http:\/\/127\.0\.0\.1:1\/&quot;&gt;&lt;script&gt;"/);
});

test("a dashboard's Allow is sent for that source, and what comes back says which is allowed", () => {
  hub.open(ID, { type: "dashboard" });
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  hub.onEvent({ type: "artifact_detail", artifact: { ...VIEW, type: "dashboard", exports: ["html"] }, content: {}, state: { results: {} }, request_id: last("artifact_get").request_id });
  panel.say({ type: "allow", source: "ads", allowed: true });
  const cmd = last("artifact_allow_source");
  assert.deepEqual({ ...cmd, request_id: "" }, { type: "artifact_allow_source", id: ID, source: "ads", allowed: true, request_id: "" });
  hub.onEvent({ type: "artifact_changed", artifact: { ...VIEW, type: "dashboard", allowed_sources: ["ads"] }, op: "changed", surface: "editor", request_id: cmd.request_id });
  assert.deepEqual(panel.last("allowed").artifact.allowed_sources, ["ads"]);
  panel.say({ type: "refresh" });
  assert.equal(last("artifact_refresh").id, ID);
});

test("the list, or the list of one type (a Pip's page asks for dashboards); never a type the protocol doesn't have", async () => {
  const all = hub.list();
  assert.equal("artifact_type" in last("artifact_list"), false);
  hub.onEvent({ type: "artifact_items", request_id: last("artifact_list").request_id, items: [VIEW] });
  assert.deepEqual((await all).map((v) => v.id), [ID]);
  void hub.list("dashboard");
  assert.equal(last("artifact_list").artifact_type, "dashboard");
  void hub.list("poster");
  assert.equal("artifact_type" in last("artifact_list"), false);
});

test("a failed queued mutation is never replayed after reconnect", () => {
  host.outcome = "starting";
  const failed = [];
  hub.ask({ type: "artifact_restore", id: ID, version: 1 }, { ok() { assert.fail("not sent"); }, fail(r) { failed.push(r); } });
  hub.backendLost();
  host.outcome = "sent";
  hub.backendReady();
  assert.deepEqual(failed, ["lost"]);
  assert.equal(sent.length, 0);
});

test("queue eviction reports failure and cannot later execute the evicted request", () => {
  host.outcome = "starting";
  const failed = [];
  for (let i = 0; i < 260; i++) hub.ask({ type: "artifact_restore", id: ID, version: i + 1 }, {
    ok() {}, fail(reason) { failed.push([i + 1, reason]); },
  });
  assert.deepEqual(failed, [[1,"busy"],[2,"busy"],[3,"busy"],[4,"busy"]]);
  host.outcome = "sent";
  hub.backendReady();
  assert.equal(sent.length, 256);
  assert.equal(sent[0].version, 5);
});

test("dashboard consent uses the displayed content version and is gated for older CLIs", () => {
  host.offer = { ...OFFER, sourceConsentVersion: true };
  hub.open(ID, { type: "dashboard", title: "Dashboard" });
  const panel = world.panels[0]; panel.say({ type: "ready" });
  hub.onEvent({ type: "artifact_detail", request_id: last("artifact_get").request_id,
    artifact: { ...VIEW, type: "dashboard", version: 3 }, content: { sources: [] } });
  // The host learned of version 4, but the user still sees version 3's source list.
  hub.onEvent({ type: "artifact_changed", artifact: { ...VIEW, type: "dashboard", version: 4 }, op: "changed" });
  panel.say({ type: "allow", source: "sales", allowed: true, base_version: 3 });
  assert.equal(last("artifact_allow_source").base_version, 3);
  const count = sent.length;
  panel.say({ type: "allow", source: "sales", allowed: true });
  assert.equal(sent.length, count);
  assert.equal(panel.last("rejected").reason, "conflict");
  host.offer = OFFER;
  panel.say({ type: "allow", source: "sales", allowed: false, base_version: 3 });
  assert.equal("base_version" in last("artifact_allow_source"), false);
});
