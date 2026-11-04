// A plugin's card (MCP Apps) in real Chromium: media/mcpApps.js and media/mcpApps.css on a page of their own, and a
// card served from another origin as DGC's backend serves one. The card is framed sandboxed at its address, gets the
// handshake (theme, styles, display mode, the tool), then its tool's input and result; what it asks of its server
// goes to the extension host as {type: "mcpApp", op: "call"} and the answer comes back to it; DGC's Allow card is drawn
// outside the frame and its choice names the request; a message it sends is labelled with its plugin; its height
// follows size-changed within bounds; a message it posts shaped like the host's never reaches the page's own
// handlers; and a frame that navigates to another local page (the webviews frame every loopback port) keeps none of
// the card's standing: it hears nothing and asks nothing in the card's name. jsdom can't frame a page on another
// origin, so only a browser can say these.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const media = join(dirname(fileURLToPath(import.meta.url)), "..", "media");
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, cardServer, pageServer, otherServer, cardPort, pagePort, otherPort;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
const CARD_ID = "app_" + "c".repeat(24);
const QUIET_ID = "app_" + "d".repeat(24);

// The plugin's page: it talks MCP Apps JSON-RPC to window.parent and records what it heard on document.body.dataset.
const CARD_PAGE = `<!doctype html><html><body><p id="said">waiting</p><script>
let id = 0; const pending = new Map();
const ask = (method, params) => new Promise((resolve) => { const n = ++id; pending.set(n, resolve); parent.postMessage({ jsonrpc: "2.0", id: n, method, params }, "*"); });
addEventListener("message", (e) => {
  const m = e.data || {};
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "ui/notifications/tool-input") document.body.dataset.input = JSON.stringify(m.params);
  if (m.method === "ui/notifications/tool-result") { document.body.dataset.result = JSON.stringify(m.params); document.getElementById("said").textContent = "got result"; }
  if (m.method === "ui/notifications/host-context-changed") document.body.dataset.changed = JSON.stringify(m.params);
});
window.go = async () => {
  const init = await ask("ui/initialize", { protocolVersion: "2026-01-26", appInfo: { name: "t", version: "1" }, appCapabilities: {} });
  document.body.dataset.init = JSON.stringify(init.result);
  parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
};
window.call = async (name) => { const r = await ask("tools/call", { name, arguments: { n: 1 } }); document.body.dataset.call = JSON.stringify(r); };
window.say = async (text) => { const r = await ask("ui/message", { role: "user", content: [{ type: "text", text }] }); document.body.dataset.say = JSON.stringify(r); };
window.grow = (height) => parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { width: 300, height } }, "*");
window.spoof = () => parent.postMessage({ type: "event", event: { type: "permission_request", id: "x" } }, "*");
go();
</script></body></html>`;

// Another local page (a preview, another program's server): it speaks to its parent as a card would, and records
// whatever it hears.
const OTHER_PAGE = `<!doctype html><html><body><script>
const heard = [];
addEventListener("message", (e) => { heard.push(e.data); document.body.dataset.heard = JSON.stringify(heard); });
parent.postMessage({ jsonrpc: "2.0", id: 1, method: "ui/initialize", params: { protocolVersion: "2026-01-26", appInfo: { name: "x", version: "1" }, appCapabilities: {} } }, "*");
parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
parent.postMessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "show_board", arguments: {} } }, "*");
document.body.dataset.sent = "yes";
</script></body></html>`;

// The webviews' own frame rule (panel.ts, chatdgc.ts, pipsView.ts, mcpApps.ts): a frame may be at any loopback port.
const PAGE = () => `<!doctype html><html style="--vscode-editor-background:#1e1e1e;--vscode-foreground:#cccccc;--vscode-font-family:sans-serif">
<head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="frame-src http://127.0.0.1:* http://localhost:*"><style>${readFileSync(join(media, "mcpApps.css"), "utf8")}</style></head>
<body class="vscode-dark">
<main id="log"></main>
<script>${readFileSync(join(media, "mcpApps.js"), "utf8")}</script>
<script>
window.__posted = []; window.__heard = []; window.__sent = [];
addEventListener("message", (e) => window.__heard.push(e.data));        // the page's own handler, as main.js has
DgcMcpApps.setup({ post: (m) => { window.__posted.push(m); if (m.op === "url") setTimeout(() => DgcMcpApps.host({ type: "mcpAppDone", id: m.id, url: m.url }), 0); } });
window.show = (card) => document.getElementById("log").append(DgcMcpApps.card(card, { sendMessage: (t) => { window.__sent.push(t); return true; } }));
</script></body></html>`;

before(async () => {
  cardServer = createServer((req, res) => {
    if (req.url.startsWith(`/card/${QUIET_ID}`)) {      // a page that loads but never starts (its code was blocked)
      res.writeHead(200, { "Content-Type": "text/html" }); res.end("<!doctype html><html><body></body></html>"); return;
    }
    if (!req.url.startsWith(`/card/${CARD_ID}`)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/html", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'" });
    res.end(CARD_PAGE);
  });
  pageServer = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(PAGE()); });
  otherServer = createServer((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(OTHER_PAGE); });
  await new Promise((r) => cardServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => pageServer.listen(0, "127.0.0.1", r));
  await new Promise((r) => otherServer.listen(0, "127.0.0.1", r));
  cardPort = cardServer.address().port;
  pagePort = pageServer.address().port;
  otherPort = otherServer.address().port;
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); cardServer?.close(); pageServer?.close(); otherServer?.close(); });

const card = () => ({
  card_id: CARD_ID, call_id: "call_1", surface: "work", server: "board", plugin: "Board", tool: "show_board",
  uri: "ui://board/card.html", url: `http://127.0.0.1:${cardPort}/card/${CARD_ID}?t=tok`, html: "<p>page</p>",
  tool_input: { size: 3 }, tool_result: { content: [{ type: "text", text: "the board" }], structuredContent: { cells: [1] } },
  tool_info: { name: "show_board", title: "Show the board" }, csp: {}, declared_csp: false, link_hosts: [],
});

async function open(t) {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${pagePort}/`);
  await page.evaluate((c) => window.show(c), card());
  const frame = await (async () => {
    for (let i = 0; i < 100; i++) {
      const found = page.frames().find((f) => f.url().includes(`/card/${CARD_ID}`));
      if (found && await found.evaluate(() => document.body.dataset.result).catch(() => null)) return found;
      await page.waitForTimeout(50);
    }
    return null;
  })();
  assert.ok(frame, "the card got its tool's result");
  return { page, frame };
}

test("the card is framed sandboxed at its address and gets the handshake, then its tool's input and result", async (t) => {
  if (skipOrFail(t)) return;
  const { page, frame } = await open(t);
  const shown = await page.evaluate(() => {
    const f = document.querySelector(".mcp-app iframe");
    return { sandbox: f.getAttribute("sandbox"), src: f.src, head: document.querySelector(".mcp-app-head").textContent };
  });
  assert.equal(shown.sandbox, "allow-scripts allow-same-origin allow-forms");
  assert.match(shown.src, new RegExp(`^http://127\\.0\\.0\\.1:${cardPort}/card/${CARD_ID}`));
  assert.match(shown.head, /Board/);
  const init = JSON.parse(await frame.evaluate(() => document.body.dataset.init));
  assert.equal(init.protocolVersion, "2026-01-26");
  assert.equal(init.hostInfo.name, "DGC");
  assert.equal(init.hostContext.theme, "dark");
  assert.equal(init.hostContext.displayMode, "inline");
  assert.equal(init.hostContext.toolInfo.tool.name, "show_board");
  assert.equal(init.hostContext.styles.variables["--color-background-primary"], "#1e1e1e");
  assert.ok(init.hostCapabilities.serverTools && init.hostCapabilities.openLinks && init.hostCapabilities.downloadFile);
  assert.deepEqual(JSON.parse(await frame.evaluate(() => document.body.dataset.input)), { arguments: { size: 3 } });
  assert.deepEqual(JSON.parse(await frame.evaluate(() => document.body.dataset.result)).structuredContent, { cells: [1] });
  // The editor's theme changes: the card hears it.
  await page.evaluate(() => { document.body.className = "vscode-light"; });
  await page.waitForFunction(() => true);
  for (let i = 0; i < 40 && !(await frame.evaluate(() => document.body.dataset.changed)); i++) await page.waitForTimeout(50);
  assert.equal(JSON.parse(await frame.evaluate(() => document.body.dataset.changed)).theme, "light");
  await page.close();
});

test("a live card collapses without losing its frame or approval controls", async (t) => {
  if (skipOrFail(t)) return;
  const { page, frame } = await open(t);
  await page.getByRole("button", { name: "Collapse Board's card" }).click();
  assert.equal(await page.locator(".mcp-app").getAttribute("data-collapsed"), "true");
  assert.equal(await page.locator(".mcp-app-frame").isVisible(), false);
  assert.equal(await frame.evaluate(() => document.body.dataset.result !== undefined), true, "the frame stays live");
  await page.getByRole("button", { name: "Expand Board's card" }).click();
  assert.equal(await page.locator(".mcp-app-frame").isVisible(), true);
  await page.close();
});

test("an old failed card shows a concise error instead of opening its gallery", async (t) => {
  if (skipOrFail(t)) return;
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${pagePort}/`);
  await page.evaluate((c) => window.show(c), { ...card(), plugin: "Higgsfield", tool_result: { isError: true } });
  assert.equal(await page.locator(".mcp-app").getAttribute("data-failed"), "true");
  assert.equal(await page.locator(".mcp-app-frame").isVisible(), false);
  assert.match(await page.locator(".mcp-app-note").textContent(), /Higgsfield couldn't show this card/);
  assert.equal(page.frames().some((f) => f.url().includes(`/card/${CARD_ID}`)), false, "the failed page was never loaded");
  await page.close();
});

test("what it asks of its server goes to the host and the answer comes back; an Allow card names the request", async (t) => {
  if (skipOrFail(t)) return;
  const { page, frame } = await open(t);
  await frame.evaluate(() => { window.call("show_board"); });
  const call = await page.evaluate(() => window.__posted.find((m) => m.op === "call"));
  assert.equal(call.method, "tools/call");
  assert.equal(call.card_id, CARD_ID, "the host is told which card");
  await page.evaluate((id) => DgcMcpApps.event({ type: "mcp_app_reply", card_id: id[0], request_id: id[1], result: { content: [{ type: "text", text: "ok" }] } }), [CARD_ID, call.request_id]);
  for (let i = 0; i < 40 && !(await frame.evaluate(() => document.body.dataset.call)); i++) await page.waitForTimeout(50);
  assert.deepEqual(JSON.parse(await frame.evaluate(() => document.body.dataset.call)).result, { content: [{ type: "text", text: "ok" }] });
  // A change: DGC's Allow card, drawn outside the frame, and the choice names the request.
  await frame.evaluate(() => { document.body.dataset.call = ""; window.call("move"); });
  await page.waitForFunction(() => window.__posted.filter((m) => m.op === "call").length === 2);
  const second = await page.evaluate(() => window.__posted.filter((m) => m.op === "call")[1]);
  await page.evaluate((a) => DgcMcpApps.event({ type: "mcp_app_reply", card_id: a[0], request_id: a[1], ask: { ask_id: "ask_" + "d".repeat(24),
    card_id: a[0], plugin: "Board", server: "board", tool: "move", title: "Move", arguments: { n: 1 }, always: false, money: true } }), [CARD_ID, second.request_id]);
  await page.waitForSelector(".mcp-app-ask");
  const ask = await page.evaluate(() => ({ text: document.querySelector(".mcp-app-ask").textContent,
                                           buttons: [...document.querySelectorAll(".mcp-app-ask button")].map((b) => b.textContent) }));
  assert.match(ask.text, /Board's card wants to run\s*Move/);
  assert.deepEqual(ask.buttons, ["Allow", "Don't"], "a plugin that can move money is never offered Always allow");
  assert.match(ask.text, /asks every time/);
  await page.click(".mcp-app-ask button.primary");
  const answer = await page.evaluate(() => window.__posted.find((m) => m.op === "answer"));
  assert.deepEqual([answer.ask_id, answer.choice, answer.request_id], ["ask_" + "d".repeat(24), "once", second.request_id]);
  assert.equal(await page.evaluate(() => document.querySelectorAll(".mcp-app-ask").length), 0);
  await page.evaluate((a) => DgcMcpApps.event({ type: "mcp_app_reply", card_id: a[0], request_id: a[1], error: { code: -32000, message: "the user didn't allow it" } }), [CARD_ID, second.request_id]);
  for (let i = 0; i < 40 && !(await frame.evaluate(() => document.body.dataset.call)); i++) await page.waitForTimeout(50);
  assert.match(JSON.parse(await frame.evaluate(() => document.body.dataset.call)).error.message, /didn't allow/);
  await page.close();
});

test("its message is labelled with its plugin, its height stays in bounds, and nothing it posts reaches the page", async (t) => {
  if (skipOrFail(t)) return;
  const { page, frame } = await open(t);
  await frame.evaluate(() => { window.say("Make it bigger"); });
  for (let i = 0; i < 40 && !(await frame.evaluate(() => document.body.dataset.say)); i++) await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(() => window.__sent), ["From Board's card: Make it bigger"]);
  await frame.evaluate(() => window.grow(5000));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.querySelector(".mcp-app iframe").style.height), "720px");
  await frame.evaluate(() => window.grow(10));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => document.querySelector(".mcp-app iframe").style.height), "80px");
  await page.evaluate(() => { window.__heard = []; });
  await frame.evaluate(() => window.spoof());
  await page.waitForTimeout(200);
  assert.deepEqual(await page.evaluate(() => window.__heard), [], "a card's message never reaches the page's own handlers");
  await page.close();
});

test("a card's frame that navigates to another local page hears nothing and asks nothing in the card's name", async (t) => {
  if (skipOrFail(t)) return;
  const { page, frame } = await open(t);
  const calls = () => page.evaluate(() => window.__posted.filter((m) => m.op === "call" || m.op === "context").length);
  const before = await calls();
  const other = `http://127.0.0.1:${otherPort}/elsewhere`;
  await frame.evaluate((url) => { setTimeout(() => { location.href = url; }, 0); }, other);
  for (let i = 0; i < 100 && !frame.url().startsWith(other); i++) await page.waitForTimeout(50);
  assert.equal(frame.url(), other, "the frame navigated: the webviews' frame rule lets it");
  await frame.waitForFunction(() => document.body.dataset.sent === "yes");
  await page.waitForTimeout(300);
  await page.evaluate(() => { document.body.className = "vscode-light"; });   // a theme change is sent to the card
  await page.waitForTimeout(300);
  const heard = JSON.parse(await frame.evaluate(() => document.body.dataset.heard || "[]"));
  assert.deepEqual(heard, [], `the other page heard the card's handshake, input or result: ${JSON.stringify(heard)}`);
  assert.equal(await calls(), before, "nothing was asked of the plugin in the card's name");
  // Back at the card's own address (its token), it is the card again.
  await frame.evaluate((url) => { setTimeout(() => { location.href = url; }, 0); }, `http://127.0.0.1:${cardPort}/card/${CARD_ID}?t=tok`);
  for (let i = 0; i < 100 && !(await frame.evaluate(() => document.body.dataset.result).catch(() => null)); i++) await page.waitForTimeout(50);
  assert.deepEqual(JSON.parse(await frame.evaluate(() => document.body.dataset.result)).structuredContent, { cells: [1] });
  await page.close();
});

test("a card whose page loads but never starts says so under the card; one that starts says nothing", async (t) => {
  if (skipOrFail(t)) return;
  const page = await browser.newPage();
  await page.clock.install();
  await page.goto(`http://127.0.0.1:${pagePort}/`);
  const quiet = { ...card(), card_id: QUIET_ID, plugin: "Higgsfield", url: `http://127.0.0.1:${cardPort}/card/${QUIET_ID}?t=tok` };
  await page.evaluate(([a, b]) => { window.show(a); window.show(b); }, [card(), quiet]);
  for (let i = 0; i < 100; i++) {
    const loaded = await page.evaluate(() => [...document.querySelectorAll(".mcp-app-loading")].every((n) => n.hidden));
    const started = page.frames().find((f) => f.url().includes(`/card/${CARD_ID}`));
    if (loaded && started && await started.evaluate(() => document.body.dataset.result).catch(() => null)) break;
    await page.clock.runFor(50);
  }
  const before = await page.evaluate(() => [...document.querySelectorAll(".mcp-app-note")].map((n) => n.hidden));
  assert.deepEqual(before, [true, true], "nothing is said while a page may still be starting");
  await page.clock.runFor(16000);
  const notes = await page.evaluate(() => [...document.querySelectorAll(".mcp-app")].map((n) => {
    const note = n.querySelector(".mcp-app-note");
    return { hidden: note.hidden, text: note.textContent, under: note.previousElementSibling?.className };
  }));
  assert.equal(notes[0].hidden, true, "a card that started says nothing");
  assert.equal(notes[1].hidden, false);
  assert.match(notes[1].text, /^Higgsfield's card didn't start\./);
  assert.equal(notes[1].under, "mcp-app-frame", "said under the card, never over it");
  await page.close();
});
