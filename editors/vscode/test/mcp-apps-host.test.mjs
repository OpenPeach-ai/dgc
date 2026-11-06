// The extension host's side of a plugin's card (src/mcpApps.ts), bundled against a stub `vscode`: what a card asks of
// its server goes to the backend as mcp_app_* commands and the answers come back to the page that asked (an Allow
// card's outcome too); a link to a site the card declared opens at once and any other asks first; a download goes
// through a save dialog with a safe file name; and a card's own tab frames only loopback and never carries its page.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const world = {};
const uri = (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => p });
globalThis.__DGC_APPS_VSCODE = {
  Uri: { joinPath: (base, ...parts) => uri([base.fsPath ?? String(base), ...parts].join("/")),
         parse: (value) => ({ toString: () => value }) },
  ViewColumn: { Active: -1 },
  window: {
    showWarningMessage: async (message, options, ...items) => { world.warnings.push({ message, items }); return world.answer; },
    showSaveDialog: async (options) => { world.saveAsked = options; return world.saveTo; },
    createWebviewPanel: (viewType, title) => {
      const panel = { viewType, title, disposed: false, revealed: 0,
        webview: { html: "", cspSource: "vscode-resource:", asWebviewUri: (u) => u, postMessage: () => Promise.resolve(true),
                   onDidReceiveMessage: () => ({ dispose() {} }) },
        onDidDispose: (fn) => { panel.onDispose = fn; return { dispose() {} }; }, reveal() { panel.revealed++; },
        dispose() { panel.disposed = true; panel.onDispose?.(); } };
      world.panels.push(panel);
      return panel;
    },
  },
  workspace: { workspaceFolders: [{ uri: uri("/home/me/project") }], fs: { writeFile: async (target, bytes) => { world.written.push([target.fsPath, Buffer.from(bytes).toString()]); } } },
  env: { remoteName: undefined, openExternal: async (u) => { world.opened.push(u.toString()); return true; },
         asExternalUri: async (u) => u },
};
const out = mkdtempSync(join(tmpdir(), "dgc-mcp-apps-build-"));
let apps;
try {
  const code = buildSync({ entryPoints: [join(root, "src/mcpApps.ts")], bundle: true, format: "cjs", platform: "node",
    target: "node18", write: false, external: ["vscode"], logLevel: "silent" }).outputFiles[0].text
    .replace(/require\("vscode"\)/g, "(globalThis.__DGC_APPS_VSCODE || {})");
  writeFileSync(join(out, "mcpApps.cjs"), code);
  apps = createRequire(import.meta.url)(join(out, "mcpApps.cjs"));
} finally {
  rmSync(out, { recursive: true, force: true });
}

const CARD = "app_" + "e".repeat(24);
beforeEach(() => { Object.assign(world, { warnings: [], opened: [], written: [], panels: [], answer: undefined, saveTo: undefined, saveAsked: undefined }); });
const page = () => { const got = []; return { got, post: (m) => got.push(m) }; };
const flush = () => new Promise((r) => setTimeout(r, 0));

test("a card's request goes to its backend and the answer to the page that asked, an Allow card's outcome too", () => {
  const host = new apps.McpAppsHost(uri("/ext"));
  const a = page(), b = page(), sent = [];
  host.fromPage({ type: "mcpApp", op: "call", card_id: CARD, request_id: "mcpapp-call-1-1", method: "tools/call",
                  params: { name: "move", arguments: { to: "b2" } } }, a.post, (c) => { sent.push(c); return true; });
  host.fromPage({ type: "mcpApp", op: "call", card_id: "app_nope", request_id: "mcpapp-call-1-2", method: "tools/call", params: {} },
                a.post, (c) => { sent.push(c); return true; });
  host.fromPage({ type: "mcpApp", op: "call", card_id: CARD, request_id: "mcpapp-call-1-3", method: "prompts/get", params: {} },
                a.post, (c) => { sent.push(c); return true; });
  assert.deepEqual(sent, [{ type: "mcp_app_call", request_id: "mcpapp-call-1-1", card_id: CARD, method: "tools/call",
                            params: { name: "move", arguments: { to: "b2" } } }], "only a card's tools/call or resources/read");
  host.fromPage({ type: "mcpApp", op: "get", card_id: CARD, request_id: "mcpapp-get-1-4" }, b.post, (c) => { sent.push(c); return true; });
  assert.equal(host.onEvent({ type: "mcp_app_reply", card_id: CARD, request_id: "mcpapp-call-1-1", ask: { ask_id: "ask_" + "1".repeat(24) } }), true);
  assert.equal(host.onEvent({ type: "mcp_app_reply", card_id: CARD, request_id: "mcpapp-call-1-1", result: { content: [] } }), true);
  assert.deepEqual(a.got.map((m) => m.event.ask ? "ask" : "result"), ["ask", "result"], "the outcome after an Allow card reaches the same page");
  assert.equal(b.got.length, 0);
  host.onEvent({ type: "mcp_app_resource", card_id: CARD, request_id: "mcpapp-get-1-4", html: "<p>" });
  assert.equal(b.got[0].event.type, "mcp_app_resource");
  assert.equal(host.onEvent({ type: "tool_result" }), false, "nothing else is a card's");
  host.fromPage({ type: "mcpApp", op: "answer", card_id: CARD, ask_id: "ask_" + "1".repeat(24), choice: "always", request_id: "mcpapp-call-1-1" },
                a.post, (c) => { sent.push(c); return true; });
  assert.deepEqual(sent.at(-1), { type: "mcp_app_answer", ask_id: "ask_" + "1".repeat(24), choice: "always", request_id: "mcpapp-call-1-1" });
  host.fromPage({ type: "mcpApp", op: "context", card_id: CARD, content: [{ type: "text", text: "picked" }], structured_content: [1] },
                a.post, (c) => { sent.push(c); return true; });
  assert.deepEqual(sent.at(-1), { type: "mcp_app_context", card_id: CARD, content: [{ type: "text", text: "picked" }], structured_content: {} });
});

test("a declared site opens at once; another asks first, and a plain no opens nothing", async () => {
  const host = new apps.McpAppsHost(uri("/ext"));
  const p = page();
  host.fromPage({ type: "mcpApp", op: "link", id: "l1", card_id: CARD, url: "https://app.cardboard.ai/p/1", plugin: "Cardboard", hosts: ["*.cardboard.ai"] }, p.post, () => true);
  await flush(); await flush();
  assert.deepEqual(world.opened, ["https://app.cardboard.ai/p/1"]);
  assert.equal(world.warnings.length, 0);
  host.fromPage({ type: "mcpApp", op: "link", id: "l2", card_id: CARD, url: "https://elsewhere.example/x", plugin: "Cardboard", hosts: ["*.cardboard.ai"] }, p.post, () => true);
  await flush(); await flush();
  assert.match(world.warnings[0].message, /Cardboard's card wants to open https:\/\/elsewhere\.example/);
  assert.equal(world.opened.length, 1, "nothing opens without the user's yes");
  assert.deepEqual(p.got.map((m) => [m.id, m.ok]), [["l1", true], ["l2", false]]);
  host.fromPage({ type: "mcpApp", op: "link", id: "l3", card_id: CARD, url: "javascript:alert(1)", hosts: [] }, p.post, () => true);
  await flush();
  assert.equal(p.got.at(-1).ok, false);
});

test("a download goes through a save dialog with a safe name", async () => {
  const host = new apps.McpAppsHost(uri("/ext"));
  const p = page();
  world.saveTo = uri("/home/me/project/report.csv");
  host.fromPage({ type: "mcpApp", op: "download", id: "d1", card_id: CARD, plugin: "Board",
                  contents: [{ type: "resource", resource: { uri: "file:///../../etc/.passwd", text: "a,b\n1,2" } }] }, p.post, () => true);
  await flush(); await flush(); await flush();
  assert.match(world.saveAsked.defaultUri.fsPath, /\/home\/me\/project\/passwd$/, "no folders, no hidden name");
  assert.deepEqual(world.written, [["/home/me/project/report.csv", "a,b\n1,2"]]);
  assert.equal(p.got[0].ok, true);
  assert.equal(apps.downloadName("a/b/c%2F..%2Fx.png"), "c_.._x.png");
  assert.equal(apps.downloadName(""), "download");
});

test("a card's own tab frames only loopback and never carries the page", () => {
  const html = apps.cardTabDocument({ card_id: CARD, html: "<script>evil()</script>", plugin: "Board", tool: "t", url: "http://127.0.0.1:1/card/x" },
                                    "s.js", "s.css", "c.css", "vscode-resource:", "n0nce");
  assert.match(html, /frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*;/);
  assert.doesNotMatch(html, /evil/);
  assert.doesNotMatch(html, /<\/script><script/i);
  const host = new apps.McpAppsHost(uri("/ext"));
  host.fromPage({ type: "mcpApp", op: "tab", card_id: CARD, card: { card_id: CARD, plugin: "Board", tool: "t" } }, () => {}, () => true);
  host.fromPage({ type: "mcpApp", op: "tab", card_id: CARD, card: { card_id: CARD, plugin: "Board", tool: "t" } }, () => {}, () => true);
  assert.equal(world.panels.length, 1, "one tab per card");
  assert.equal(world.panels[0].revealed, 1);
  host.fromPage({ type: "mcpApp", op: "closeTab", card_id: CARD }, () => {}, () => true);
  assert.equal(world.panels[0].disposed, true);
});

test("declared sites: *.x is x and its subdomains, nothing else", () => {
  assert.equal(apps.declaredHost("https://cardboard.ai/", ["*.cardboard.ai"]), true);
  assert.equal(apps.declaredHost("https://a.b.cardboard.ai/", ["*.cardboard.ai"]), true);
  assert.equal(apps.declaredHost("https://evilcardboard.ai/", ["*.cardboard.ai"]), false);
  assert.equal(apps.declaredHost("https://cdn.test/", ["cdn.test"]), true);
  assert.equal(apps.declaredHost("not a url", ["*"]), false);
});
