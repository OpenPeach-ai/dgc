// The artifacts' extension side (src/artifacts.ts), bundled against a stub `vscode`, with a host that records every
// command instead of running a backend: what each screen's action sends, what each reply does, and that a removal
// asks first.
import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
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

test("an older preview reply cannot replace the latest page at the same version", async () => {
  hub.open(ID, { type: "page", title: "Tips" });
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  hub.onEvent({ type: "artifact_detail", artifact: { ...VIEW, type: "page", exports: ["html", "zip"] }, request_id: last("artifact_get").request_id });
  const older = last("artifact_open");
  panel.say({ type: "preview" });
  const newer = last("artifact_open");
  assert.notEqual(older.request_id, newer.request_id);
  hub.onEvent({ type: "artifact_served", id: ID, url: "http://127.0.0.1:45013/", request_id: newer.request_id });
  await tick(); await tick();
  hub.onEvent({ type: "artifact_served", id: ID, url: "http://127.0.0.1:45012/", request_id: older.request_id });
  await tick(); await tick();
  assert.deepEqual(panel.webview.posted.filter((message) => message.type === "frame"), [
    { type: "frame", url: "http://forwarded.example:45013/", version: 3 },
  ]);
});

test("an older detail reply cannot replace a newer reload", () => {
  hub.open(ID, { type: "page", title: "Tips" });
  const [panel] = world.panels;
  panel.say({ type: "ready" });
  const older = last("artifact_get");
  panel.say({ type: "reload" });
  const newer = last("artifact_get");
  hub.onEvent({ type: "artifact_detail", artifact: { ...VIEW, title: "Latest", version: 4, type: "page" }, request_id: newer.request_id });
  hub.onEvent({ type: "artifact_detail", artifact: { ...VIEW, title: "Old", type: "page" }, request_id: older.request_id });
  assert.equal(panel.title, "Latest");
  assert.equal(panel.last("detail").artifact.title, "Latest");
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
  const heard = [], opened = [];
  // (Opening one says so too, for Home, where an opened thing is no longer news: H1. Counted apart from the changes.)
  hub.listen((m) => (m.type === "artifactOpened" ? opened : heard).push(m));
  hub.open(ID, { type: "slides" });
  assert.deepEqual(opened, [{ type: "artifactOpened", id: ID }]);
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

// His ask (18 Nov): Download saves on the computer the editor runs on, in any window. The process makes the file and its
// bytes go to the page that asked, which saves it there (src/download.ts, media/shared/download.js): never a save dialog,
// which in a remote window browses the remote machine. Asked with no page (a command), the artifact's own panel saves it.
test("Download, in any window: no save dialog; the process makes it and its bytes go to the page that asked", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "dgc-export-"));
  const made = join(folder, "Q3 plan.pptx");
  writeFileSync(made, "the deck");
  try {
    for (const remote of [false, true]) {
      const env = globalThis.__DGC_ART_VSCODE.env;
      if (remote) env.remoteName = "ssh-remote"; else delete env.remoteName;
      const posted = [], page = { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } };
      world.saveAsked = undefined; world.external = [];
      const done = hub.exportArtifact(VIEW, "pptx", undefined, page);
      await tick();
      assert.equal(world.saveAsked, undefined, "no save dialog");
      const cmd = last("artifact_export");
      assert.deepEqual({ ...cmd, request_id: "" }, { type: "artifact_export", id: ID, format: "pptx", request_id: "" });
      hub.onEvent({ type: "artifact_exported", id: ID, format: "pptx", path: made, request_id: cmd.request_id });
      await done;
      const [m] = posted;
      assert.equal(m?.type, "dgcDownload", `${remote ? "remote" : "local"}: handed to the page`);
      assert.equal(m.name, "Q3 plan.pptx");
      assert.equal(String(Buffer.from(m.data)), "the deck");
      assert.deepEqual(world.external, [], "not the browser: the page saves it");
      delete env.remoteName;
    }
    const before = sent.filter((c) => c.type === "artifact_export").length;
    await hub.exportArtifact(VIEW, "xlsx");
    assert.equal(sent.filter((c) => c.type === "artifact_export").length, before, "a format it doesn't have is never asked for");
    // From a command (no page): the artifact's own panel opens and is handed it.
    const done = hub.exportArtifact(VIEW, "pdf");
    await tick();
    hub.onEvent({ type: "artifact_exported", id: ID, format: "pdf", path: made, request_id: last("artifact_export").request_id });
    await done;
    const panel = world.panels.at(-1);
    assert.ok(panel, "its panel opened");
    panel.say({ type: "ready" });
    await tick();
    assert.equal(panel.last("dgcDownload")?.name, "Q3 plan.pdf", "its own page saves it");
  } finally { rmSync(folder, { recursive: true, force: true }); }
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

test("downloads in a remote window share one port that keeps listening: the editor never holds a forwarded port with nothing behind it", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "dgc-download-"));
  const file = join(folder, "made.xlsx");
  writeFileSync(file, "the workbook");
  const env = globalThis.__DGC_ART_VSCODE.env, opened = env.openExternal, external = env.asExternalUri;
  const forwarded = [], addresses = [];
  env.asExternalUri = async (u) => { forwarded.push(new URL(u.toString()).port); return u; };
  env.openExternal = async (u) => { addresses.push(u.toString()); return true; };
  try {
    for (const name of ["One.xlsx", "Two.xlsx", "Three.xlsx"]) {
      assert.equal(await art.downloadThroughBrowser(file, name), true);
      assert.equal(await (await fetch(addresses.at(-1), { signal: AbortSignal.timeout(5000) })).text(), "the workbook");
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    // What the editor counts as forwarded is what it was asked to forward: one port, for all three.
    assert.equal(new Set(forwarded).size, 1, `one forwarded port, not one a download: ${forwarded.join(", ")}`);
    // And each of them still has something behind it.
    for (const address of addresses) assert.equal((await fetch(address, { signal: AbortSignal.timeout(5000) })).status, 200);
  } finally {
    env.openExternal = opened; env.asExternalUri = external;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a file too large for a page goes to the person's own browser as an attachment; a second click gets it again, and an ended link says so", async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "dgc-download-"));
  const file = join(folder, "made.pptx");
  writeFileSync(file, "the deck");
  const env = globalThis.__DGC_ART_VSCODE.env, opened = env.openExternal, external = env.asExternalUri;
  env.remoteName = "ssh-remote";
  let address = "";
  env.asExternalUri = async (u) => u;
  env.openExternal = async (u) => { address = u.toString(); return true; };
  try {
    world.saveTo = undefined; world.saveAsked = undefined;
    assert.equal(await art.downloadThroughBrowser(file, "Q3 plan.pptx"), true);
    assert.equal(world.saveAsked, undefined, "the remote machine's dialog isn't asked");
    assert.match(address, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/Q3%20plan\.pptx$/);
    assert.equal((await fetch(address.replace(/\/[a-f0-9]{48}\//, `/${"0".repeat(48)}/`))).status, 404, "only with its token");
    const got = await fetch(address);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-disposition"), "attachment; filename*=UTF-8''Q3%20plan.pptx");
    assert.equal(await got.text(), "the deck");
    await new Promise((resolve) => setTimeout(resolve, 50));
    // A second click on a link already used: it answers. Through a forwarded port, an address with nothing listening
    // behind it leaves the browser waiting for ever, so the address never just goes.
    const again = await fetch(address, { signal: AbortSignal.timeout(5000) });
    assert.equal(again.status, 200, "inside its few minutes the file downloads again");
    assert.equal(await again.text(), "the deck");
    // Past its few minutes, or with the file gone: words that say so, and how to get it again.
    const first = address;
    assert.equal(await art.downloadThroughBrowser(file, "Q3 plan.pptx", () => Date.now() - (art.DOWNLOAD_MINUTES + 1) * 60_000), true);
    assert.notEqual(address, first);
    const ended = await fetch(address, { signal: AbortSignal.timeout(5000) });
    assert.equal(ended.status, 410);
    assert.match(ended.headers.get("content-type"), /^text\/html/);
    const words = await ended.text();
    assert.match(words, /This download link has ended/);
    assert.match(words, /choose Download again/);
    assert.match(words, /Q3 plan\.pptx/);
    assert.doesNotMatch(words, /<script|127\.0\.0\.1|\/tmp|dgc-download-/, "no script, no address, no path");
    rmSync(file);
    assert.equal(await art.downloadThroughBrowser(file, "Q3 plan.pptx").catch(() => "said"), "said", "a file that isn't there is said where Download was chosen");
  } finally {
    delete env.remoteName; env.openExternal = opened; env.asExternalUri = external;
    rmSync(folder, { recursive: true, force: true });
  }
});

// A model types a link to DGC's page list into its reply, in a remote window. The list frames each page from the page's own
// port, which a remote window doesn't forward, so opening the list itself shows the list with an empty frame. Every such
// link opens a page at its own forwarded address instead: the one it names; the only one; or the one picked from a short
// list of their names. A dismissed list opens nothing.
test("a typed link to DGC's page list, in a remote window: a page at its own forwarded address, never the list with an empty frame", async () => {
  let pages = [{ id: "a1", name: "Other", path: "/index.html", port: 45011, uptime: "2m" }, { id: "a2", name: "Inbox", path: "/inbox.html", port: 45012, uptime: "1m" }];
  const server = createServer((req, res) => {
    if (req.url !== "/_list") { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ artifacts: pages }));
  });
  const other = createServer((req, res) => { res.writeHead(404); res.end(); });   // a loopback server that isn't DGC's
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  const port = server.address().port, shell = `http://127.0.0.1:${port}`;
  const env = globalThis.__DGC_ART_VSCODE.env;
  const opened = async (link) => { const u = await art.forwardedArtifactPage(link); return u === null ? null : u?.toString(); };
  try {
    for (const link of [`${shell}/?a=a2`, `${shell}/`, `${shell}/a/a2/`]) {
      assert.equal(await opened(link), undefined, `a local window opens ${link} as it is: the list frames its pages there`);
    }
    assert.equal(world.picks.length, 0);
    env.remoteName = "ssh-remote";
    // The page it names.
    assert.equal(await opened(`${shell}/?a=a2`), "http://forwarded.example:45012/inbox.html");
    assert.equal(await opened(`http://localhost:${port}/index.html?a=a1`), "http://forwarded.example:45011/index.html", "localhost is this computer too");
    // An old /a/<id>/ link: the page's own address, with the rest of the link.
    assert.equal(await opened(`${shell}/a/a2/`), "http://forwarded.example:45012/inbox.html");
    assert.equal(await opened(`${shell}/a/a2/notes/b.html?x=1#top`), "http://forwarded.example:45012/notes/b.html?x=1#top");
    assert.equal(world.picks.length, 0, "a link that names a page opens it without asking");
    // The bare list: its pages by name, and the one picked opens.
    world.pick = (items) => items.find((i) => i.label === "Inbox");
    assert.equal(await opened(`${shell}/`), "http://forwarded.example:45012/inbox.html");
    assert.deepEqual(world.picks.at(-1).map((i) => i.label), ["Other", "Inbox"]);
    assert.match(world.pickOptions.placeHolder, /2 pages/);
    // A link to a page that has stopped: the list too, saying so.
    assert.equal(await opened(`${shell}/?a=gone`), "http://forwarded.example:45012/inbox.html");
    assert.match(world.pickOptions.placeHolder, /isn't being served/);
    // Dismissed: nothing opens (null), not the list with its empty frame.
    world.pick = () => undefined;
    assert.equal(await opened(`${shell}/`), null);
    // One page: it opens, nothing to choose.
    pages = [pages[1]];
    const asked = world.picks.length;
    assert.equal(await opened(`${shell}/`), "http://forwarded.example:45012/inbox.html");
    assert.equal(world.picks.length, asked);
    // No pages: the list as it is, which says so.
    pages = [];
    assert.equal(await opened(`${shell}/`), undefined);
    // Never anything else.
    assert.equal(await opened("https://example.com/?a=a2"), undefined, "never another site");
    assert.equal(await opened(`http://example.com:${port}/?a=a2`), undefined, "never another host");
    assert.equal(await opened(`${shell}/other?a=a2`), undefined);
    assert.equal(await opened(`http://127.0.0.1:${other.address().port}/`), undefined, "a loopback server that isn't DGC's opens as it is");
  } finally { delete env.remoteName; delete world.pick; server.close(); other.close(); }
});

test("a dismissed page list opens nothing: Work and ChatDGC stop at null instead of opening the link as typed", () => {
  for (const [file, call] of [["src/panel.ts", "forwardedArtifactPage(parsed.toString())"], ["src/chatdgc.ts", "forwardedArtifactPage(target)"]]) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const at = src.indexOf(call);
    assert.ok(at > 0, `${file} asks forwardedArtifactPage`);
    const near = src.slice(at - 200, at + 400);
    assert.match(near, /=== null\) return/, `${file} opens nothing when the list was dismissed`);
    assert.doesNotMatch(near, /forwardedArtifactPage\([^)]*\)\) \?\?/, `${file} must not treat a dismissed list as "open the link"`);
  }
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

// ---- who made it (0.52, 15 Nov): the Library names each item's maker, and its Widgets are the Pages a card or a widget made
test("an artifact's view keeps who made it (made_by) and what made a Page (made_as, or the process's legacy record)", () => {
  const { artifactView } = artifactsModule();
  const base = { id: "ar_" + "a".repeat(16), type: "page", title: "Open invoices", version: 1, origin: { surface: "pip", pip: "pip_x" } };
  assert.deepEqual(artifactView({ ...base, made_by: { kind: "pip", id: "pip_x", name: "Tile checker", more: 1 } }).made_by, { kind: "pip", id: "pip_x", name: "Tile checker" });
  assert.equal(artifactView(base).made_by, undefined, "an older DGC says nothing");
  assert.equal(artifactView({ ...base, made_by: { kind: "<b>", id: "x", name: "y" } }).made_by, undefined, "only a plain kind");
  assert.equal(artifactView({ ...base, made_by: { kind: "session", id: 7, name: "n".repeat(500) } }).made_by.name.length, 120);
  assert.equal(artifactView({ ...base, made_as: "card" }).made_as, "card");
  assert.equal(artifactView({ ...base, made_as: "anything" }).made_as, undefined);
  assert.equal(artifactView({ ...base, legacy: { card: "abc", card_place: "pip::x:" } }).made_as, "card");
  assert.equal(artifactView({ ...base, legacy: { widget: "wg_1", chat: "chat_1" } }).made_as, "widget");
  assert.equal(artifactView({ ...base, legacy: { made: "att_1" } }).made_as, undefined, "a sheet from a chat's file is not a widget");
});

// ---- Rename and Copy, from the Library's item menu (0.52, 15 Nov) ---------------------------------------------------------------
test("detail: what an artifact is now, with its content (a doc's text), in one answer", async () => {
  const DOC = { ...VIEW, type: "doc", label: "Document", title: "Launch notes", exports: ["docx", "pdf", "md"] };
  const asked = hub.detail(ID);
  await tick();
  assert.deepEqual({ ...last("artifact_get"), request_id: "" }, { type: "artifact_get", id: ID, content: true, request_id: "" });
  hub.onEvent({ type: "artifact_detail", artifact: DOC, content: "# Launch\n\nOn the 3rd.", request_id: last("artifact_get").request_id });
  const got = await asked;
  assert.deepEqual([got.view.title, got.content], ["Launch notes", "# Launch\n\nOn the 3rd."]);
  const failed = hub.detail(ID);
  await tick();
  hub.onEvent({ type: "command_rejected", command: "artifact_get", reason: "invalid", message: "No such artifact.", request_id: last("artifact_get").request_id });
  assert.equal(await failed, undefined, "refused: nothing, and no words of its own (the caller says what it could not do)");
  assert.equal(await hub.detail("../etc"), undefined, "only an artifact's id");
});

test("Rename asks for the new name, then makes one new version that differs only in its title; a page says it cannot be renamed here", async () => {
  const vs = globalThis.__DGC_ART_VSCODE;
  vs.window.showInputBox = async (options) => { world.inputAsked = options; return world.input; };
  try {
    // Cancelled, left empty or left as it was: nothing is asked of DGC.
    for (const input of [undefined, "   ", "Q3 plan"]) {
      world.input = input;
      assert.equal(await hub.rename({ id: ID, title: "Q3 plan", type: "slides" }), false);
    }
    assert.equal(last("artifact_get"), undefined);
    assert.equal(world.inputAsked.value, "Q3 plan", "the box starts with the name it has");
    assert.match(world.inputAsked.title, /Rename “Q3 plan”/);
    assert.equal(world.inputAsked.validateInput(""), "A name is needed."); assert.equal(world.inputAsked.validateInput("Q4"), undefined);
    assert.match(world.inputAsked.validateInput("x".repeat(201)), /200/);
    world.input = "  Q4 plan  ";
    const done = hub.rename({ id: ID, title: "Q3 plan", type: "slides" });
    await tick();
    const get = last("artifact_get");
    assert.equal(get.content, true);
    hub.onEvent({ type: "artifact_detail", artifact: VIEW, content: { slides: [{ title: "One" }] }, request_id: get.request_id });
    await tick();
    const update = last("artifact_update");
    assert.deepEqual({ ...update, request_id: "" }, { type: "artifact_update", id: ID, content: { slides: [{ title: "One" }] }, base_version: 3, title: "Q4 plan", note: "Renamed", request_id: "" },
      "its content as it is, from the version it has now, with the new title");
    hub.onEvent({ type: "artifact_changed", artifact: { ...VIEW, title: "Q4 plan", version: 4 }, op: "changed", surface: "editor", request_id: update.request_id });
    assert.equal(await done, true);
    assert.equal(hub.title(ID), "Q4 plan");
    // DGC refuses (it changed meanwhile): said in words, and false.
    const again = hub.rename({ id: ID, title: "Q4 plan", type: "slides" }); world.input = "Q5 plan";
    const refused = hub.rename({ id: ID, title: "Q4 plan", type: "slides" });
    await tick();
    for (const cmd of sent.filter((c) => c.type === "artifact_get").slice(1)) hub.onEvent({ type: "artifact_detail", artifact: { ...VIEW, version: 4 }, content: { slides: [] }, request_id: cmd.request_id });
    await tick();
    for (const cmd of sent.filter((c) => c.type === "artifact_update").slice(1)) hub.onEvent({ type: "command_rejected", command: "artifact_update", reason: "conflict", message: "It changed since version 4.", request_id: cmd.request_id });
    assert.deepEqual([await again, await refused], [false, false]);
    assert.match(String(world.warnings.at(-1).message), /wasn't renamed: It changed since version 4\./);
    // A page is files, which this window never holds: it is not renamed from here, and says so.
    const before = sent.length, warned = world.warnings.length;
    assert.equal(await hub.rename({ id: ID, title: "Tide pools", type: "page" }), false);
    assert.equal(sent.length, before);
    assert.match(String(world.warnings.at(-1).message), /A page can't be renamed here yet/); assert.equal(world.warnings.length, warned + 1);
  } finally { delete vs.window.showInputBox; }
});
