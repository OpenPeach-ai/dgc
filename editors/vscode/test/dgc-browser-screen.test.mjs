// DGC Browser's own tab as fast as a Pip's computer (capability dgc_browser_screen): where the computer DGC runs on has
// no screen, the tab shows Chrome's real window on a screen of its own with the Pip computer's own viewer and stream
// (src/screenView.js), not a picture asked for at a time.
//   - the host (src/pipsView.ts): only your own tab may open, feed or close that stream (never a Pip's tab, never another
//     page); the screen's bytes go to your own tab only; an editor whose DGC can't is told so (screen: false);
//   - the page (src/dgcBrowserTab.js, real Chromium, the viewer stood in for): one viewer on the tab's whole stage,
//     one to one (100%, as a Pip computer's 100%; Fit when chosen: test/dgc-browser-view-browser.test.mjs), DGC's own
//     bar stepping aside for Chrome's own; bytes both ways through the host; the screen asked for the tab's size in the
//     pixels DGC says Chrome draws at (an older DGC that says no screen size); Copy there lands on your clipboard;
//     pictures where DGC says so; it opens again by itself after a close, then offers Open it again; no frames asked.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { THEMES } from "./support/agent-lines-scene.mjs";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const view = (await build({ entryPoints: [src + "pipsView.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
const host = (() => { const out = { exports: {} }; new Function("module", "exports", "require", view)(out, out.exports, (name) => (name === "vscode" ? {} : require(name))); return out.exports; })();
const PICTURES = process.env.DGC_YB_PICTURES || "";
const AVA = "pip_" + "a".repeat(32);

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
// (Built before any test is declared: a test file whose tests come after a top-level await can see its after() run first.)
const bundle = await build({ entryPoints: [src + "dgcBrowserTab.js"], bundle: true, write: false, format: "esm", platform: "browser", outdir: "out", target: "chrome108" });
const pageJs = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text, pageCss = bundle.outputFiles.find((f) => f.path.endsWith(".css")).text;
// (The Pips view too, here: built further down, after the first test, its await let after() close the browser before
// the page tests ran whenever the whole suite was busy building, 11 of them failing on a closed browser, 27 Nov.)
const viewModule = await pipsViewModule();
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

// ---- the host ---------------------------------------------------------------------------------------------------------
test("only your own tab may open, feed or close its screen's stream", () => {
  const ok = (m) => assert.equal(host.dgcBrowserScreenRefusal(m, true), "", JSON.stringify(m));
  const no = (m, own = true) => assert.match(host.dgcBrowserScreenRefusal(m, own), /Only DGC Browser's own tab/, JSON.stringify(m));
  ok({ type: "dgcBrowserScreen", op: "open" });
  ok({ type: "dgcBrowserScreen", op: "send", data: "AAEC" });
  ok({ type: "dgcBrowserScreen", op: "close" });
  no({ type: "dgcBrowserScreen", op: "open" }, false);
  no({ type: "dgcBrowserScreen", op: "peek" });
  no({ type: "dgcBrowserScreen", op: "send", data: "not base64!" });
  no({ type: "dgcBrowserScreen", op: "send", data: "A".repeat(1_400_001) });
  no({ type: "dgcBrowserScreen", op: "open", pip_id: AVA });
  no({ type: "dgcBrowserScreen", op: "open", data: "AAAA" });
  no(null);
});

function editorWith(caps = {}) {
  const panels = [];
  const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, f) => f }) },
    window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }),
      createWebviewPanel: (id, title) => { const p = { id, title, posted: [], receive: null, dispose: null, viewColumn: -1,
        webview: { cspSource: "csp", asWebviewUri: (u) => u, postMessage: (m) => { p.posted.push(m); return Promise.resolve(true); }, onDidReceiveMessage: (f) => { p.receive = f; } },
        reveal() {}, onDidDispose: (f) => { p.dispose = f; }, onDidChangeViewState() {} }; panels.push(p); return p; } } };
  const { PipsEditor } = viewModule(vscode);
  const sent = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach(() => {});
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: 112, ...caps }, {});
  return { editor, panels, sent, screen: () => sent.filter((m) => m.type === "dgc_browser_screen") };
}

test("the host: your own tab's viewer reaches DGC, and the screen comes back to your own tab only", () => {
  const h = editorWith({ dgc_browser_screen: 1 });
  h.editor.openDgcBrowserTab(null);
  h.editor.openDgcBrowserTab({ id: AVA, name: "Ava" });
  const [own, ava] = h.panels;
  own.receive({ type: "pipsReady" });
  assert.deepEqual(own.posted.find((m) => m.type === "dgcBrowserInit"), { type: "dgcBrowserInit", own: true, screen: true });
  own.receive({ type: "dgcBrowserScreen", op: "open" });
  own.receive({ type: "dgcBrowserScreen", op: "send", data: "AAEC" });
  own.receive({ type: "dgcBrowserScreen", op: "send", data: "bad!" });
  ava.receive({ type: "dgcBrowserScreen", op: "send", data: "AAEC" });
  assert.deepEqual(h.screen(), [{ type: "dgc_browser_screen", op: "open" }, { type: "dgc_browser_screen", op: "send", data: "AAEC" }], "a Pip's tab never feeds it");
  assert.equal(h.editor.event({ type: "dgc_browser_screen_data", data: "UkZC" }), true);
  h.editor.event({ type: "dgc_browser_screen_closed", reason: "closed", pictures: false });
  assert.deepEqual(own.posted.filter((m) => /dgcBrowserScreen/.test(m.type)), [{ type: "dgcBrowserScreenData", data: "UkZC" }, { type: "dgcBrowserScreenClosed", reason: "closed", pictures: false }]);
  assert.equal(ava.posted.some((m) => /dgcBrowserScreen/.test(m.type)), false, "never to a Pip's tab");
  own.dispose();
  assert.deepEqual(h.screen().at(-1), { type: "dgc_browser_screen", op: "close" }, "closing the tab closes its stream");
});

test("the host: with a DGC that can't, the tab is told so and nothing is sent", () => {
  const h = editorWith();
  h.editor.openDgcBrowserTab(null);
  const [own] = h.panels;
  own.receive({ type: "pipsReady" });
  assert.deepEqual(own.posted.find((m) => m.type === "dgcBrowserInit"), { type: "dgcBrowserInit", own: true, screen: false });
  own.receive({ type: "dgcBrowserScreen", op: "open" });
  assert.deepEqual(h.screen(), []);
  const doc = host.dgcBrowserDocument("vscode-resource:/dist/dgcBrowserTab.js", "vscode-resource:/dist/dgcBrowserTab.css", "vscode-resource:", "DGC Browser");
  assert.match(doc, /<script type="module" src="vscode-resource:\/dist\/dgcBrowserTab\.js"><\/script>/, "a module: its viewer uses top-level await");
  assert.doesNotMatch(doc, /unsafe-eval|https?:\/\//);
});

// A screen asked for while this window can't pass it on (Pips off, DGC still connecting) is answered, never dropped: the
// tab then tries again a few times and says why. Dropped, the tab waited on "Opening DGC Browser…" for ever (25 Nov).
test("the host: a screen this window can't open yet is answered with why, so the tab tries again", () => {
  const h = editorWith({ dgc_browser_screen: 1, pips_enabled: false });
  h.editor.openDgcBrowserTab(null);
  const [own] = h.panels;
  own.receive({ type: "pipsReady" });
  own.receive({ type: "dgcBrowserScreen", op: "open" });
  assert.deepEqual(h.screen(), [], "nothing reaches DGC");
  const closed = own.posted.filter((m) => m.type === "dgcBrowserScreenClosed");
  assert.equal(closed.length, 1, "the tab is answered");
  assert.match(closed[0].reason, /Pips/);
  assert.equal(closed[0].pictures, false);
  own.receive({ type: "dgcBrowserScreen", op: "send", data: "AAEC" });
  assert.equal(own.posted.filter((m) => m.type === "dgcBrowserScreenClosed").length, 1, "only an open is answered");
});

// ---- the page ---------------------------------------------------------------------------------------------------------

async function openScreen(theme = "dark", { width = 900, height = 600, screen = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>${pageCss}</style><style>body{background:${theme === "dark" ? "#1e1e1e" : "#ffffff"};color:${theme === "dark" ? "#ccc" : "#222"}}</style><style>:root{${THEMES[theme === "dark" ? "dark-modern" : "light-modern"]}}</style></head><body class="${theme === "dark" ? "vscode-dark" : "vscode-light"}"><main id="app"></main></body></html>`);
  await page.evaluate((screen) => {
    window.__sent = []; window.__posted = []; window.__made = []; window.__sized = []; window.__copied = [];
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (t) => { window.__copied.push(t); } } });
    window.__dgcTestRFB = class {
      constructor(target, channel, options) { this.target = target; this.channel = channel; this.options = options; this.listeners = {}; this.got = [];
        this._supportsSetDesktopSize = true; this._sock = {}; this._screenID = 7; this._screenFlags = 0; this._fbWidth = 0; this._fbHeight = 0;
        const c = document.createElement("canvas"); c.width = 400; c.height = 300; c.tabIndex = 0; target.appendChild(c); this.canvas = c;
        channel.onopen = () => { this.opened = true; }; channel.onmessage = (e) => { this.got.push([...new Uint8Array(e.data)]); }; channel.onclose = (e) => { this.closed = e; };
        window.__made.push(this); }
      addEventListener(kind, fn) { this.listeners[kind] = fn; }
      static messages = { setDesktopSize: (sock, w, h, id, flags) => window.__sized.push([w, h, id, flags]) };
    };
    window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage(m) {
      window.__posted.push(JSON.parse(JSON.stringify(m)));
      if (m.type === "pipsReady") setTimeout(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "dgcBrowserInit", own: true, screen } }));
        window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion: 112, connected: true, supported: true, enabled: true } }));
      }, 5);
      if (m.type !== "pipsRequest") return;
      window.__sent.push(JSON.parse(JSON.stringify(m.request)));
      const scale = m.request.op === "size" ? { scale: 2 } : {};
      setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result: { ok: true, own: true, current: "T1", url: "", title: "", tabs: [], ...scale } } })), 5);
    } });
  }, screen);
  await page.addScriptTag({ content: pageJs, type: "module" });
  const say = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
  const sent = (op) => page.evaluate((o) => window.__sent.filter((r) => !o || r.op === o), op);
  await page.waitForFunction(() => window.__made.length > 0 || window.__sent.length > 0, null, { timeout: 10000 });
  return { page, say, posted, sent, close: () => context.close() };
}
const b64 = (text) => Buffer.from(text).toString("base64");
const look = (page) => page.evaluate(() => { const r = (sel) => { const n = document.querySelector(sel); if (!n || !n.checkVisibility()) return null; const b = n.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height)]; };
  return { bar: r(".yb-bar"), stage: r(".yb-stage"), vnc: r(".yb-vnc"), frame: r(".yb-frame"), line: document.querySelector(".yb-line").checkVisibility() ? document.querySelector(".yb-line").textContent : "",
    note: document.querySelector(".yb-note").checkVisibility() ? document.querySelector(".yb-note").textContent : "", again: r(".yb-again"), overflow: document.documentElement.scrollWidth > innerWidth }; });

test("your own screen: one viewer on the tab's whole stage, Chrome's own bar in it, no frames asked", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openScreen();
  try {
    const viewer = await x.page.evaluate(() => { const v = window.__made[0]; return { n: window.__made.length, target: v.target.className, shared: v.options.shared, scale: v.scaleViewport, resize: v.resizeSession, clip: v.clipViewport, focus: v.focusOnClick }; });
    assert.deepEqual(viewer, { n: 1, target: "yb-vnc", shared: true, scale: false, resize: false, clip: false, focus: true }, "one to one, as a Pip computer's 100%");
    assert.deepEqual((await x.posted("dgcBrowserScreen")).map((m) => m.op), ["open"]);
    const seen = await look(x.page);
    assert.equal(seen.bar, null, "DGC's own bar steps aside: Chrome's own is in the picture");
    assert.equal(seen.frame, null);
    assert.deepEqual(seen.vnc.slice(2), seen.stage.slice(2), "the screen fills the stage");
    assert.equal(seen.line, "Passkeys and security keys don’t work in this tab.");
    assert.equal(seen.note, "Opening DGC Browser…");
    // The screen's bytes come through the host, and the viewer's go back through it.
    await x.say({ type: "dgcBrowserScreenData", data: b64("RFB 003.008\n") });
    await x.page.waitForFunction(() => window.__made[0].got.length > 0);
    assert.equal(Buffer.from(await x.page.evaluate(() => window.__made[0].got[0])).toString(), "RFB 003.008\n");
    await x.page.evaluate(() => window.__made[0].channel.send(new Uint8Array([1, 2, 3]).buffer));
    assert.deepEqual((await x.posted("dgcBrowserScreen")).filter((m) => m.op === "send").map((m) => m.data), [Buffer.from([1, 2, 3]).toString("base64")]);
    await x.page.waitForTimeout(600);
    assert.deepEqual(await x.sent("frame"), [], "no picture asked for at a time");
  } finally { await x.close(); }
});

test("connected: Chrome's window and the screen are sized to the tab, the screen in the pixels DGC says; a resize follows", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openScreen("dark", { width: 900, height: 600 });
  try {
    await x.page.evaluate(() => window.__made[0].listeners.connect());
    await x.page.waitForFunction(() => window.__sent.some((r) => r.op === "size"));
    const vnc = (await look(x.page)).vnc;
    const [size] = await x.sent("size");
    assert.deepEqual([size.own, size.width, size.height], [true, vnc[2], vnc[3]], "Chrome's window at the tab's size");
    await x.page.waitForFunction((w) => window.__sized.some((s) => s[0] === w), vnc[2] * 2);
    assert.deepEqual((await x.page.evaluate(() => window.__sized)).find((s) => s[0] === vnc[2] * 2), [vnc[2] * 2, vnc[3] * 2, 7, 0], "the screen in the pixels DGC says Chrome draws at");
    assert.equal((await look(x.page)).note, "", "live: nothing over it");
    await x.page.setViewportSize({ width: 700, height: 500 });
    await x.page.waitForFunction(() => window.__sent.filter((r) => r.op === "size").length > 1, null, { timeout: 5000 });
    const last = (await x.sent("size")).at(-1), now = (await look(x.page)).vnc;
    assert.deepEqual([last.width, last.height], [now[2], now[3]]);
    await x.page.waitForFunction((w) => window.__sized.at(-1)?.[0] === w, now[2] * 2);
    assert.deepEqual((await x.page.evaluate(() => window.__sized)).at(-1).slice(0, 2), [now[2] * 2, now[3] * 2]);
  } finally { await x.close(); }
});

test("Copy on your screen lands on your clipboard; a copy made there by itself does not", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openScreen();
  try {
    await x.page.evaluate(() => window.__made[0].listeners.connect());
    await x.page.evaluate(() => {
      const v = window.__made[0];
      v.canvas.focus();
      v.canvas.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }));
      v.listeners.clipboard({ detail: { text: "copied there" } });
      v.listeners.clipboard({ detail: { text: "the page copied by itself" } });
    });
    await x.page.waitForTimeout(100);
    assert.deepEqual(await x.page.evaluate(() => window.__copied), ["copied there"]);
  } finally { await x.close(); }
});

test("where DGC shows pictures instead, the tab is the streamed tab of your own tab", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openScreen();
  try {
    await x.say({ type: "dgcBrowserScreenClosed", reason: "DGC Browser shows pictures of your tab here.", pictures: true });
    await x.page.waitForFunction(() => window.__sent.some((r) => r.op === "frame"), null, { timeout: 5000 });
    const seen = await look(x.page);
    assert.ok(seen.bar, "DGC's own bar is back");
    assert.equal(seen.vnc, null);
    assert.equal(seen.line, "Passkeys, security keys and your computer’s password manager don’t work in this tab.");
  } finally { await x.close(); }
});

test("a screen that closes opens again by itself, then offers Open it again", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openScreen();
  try {
    await x.page.evaluate(() => window.__made[0].listeners.connect());
    await x.say({ type: "dgcBrowserScreenClosed", reason: "The computer's screen closed.", pictures: false });
    await x.page.waitForFunction(() => window.__made.length === 2, null, { timeout: 5000 });
    assert.deepEqual((await x.posted("dgcBrowserScreen")).map((m) => m.op).filter((op) => op === "open"), ["open", "open"]);
    // It keeps closing (DGC Browser was closed): after a few tries it says so, with Open it again.
    for (let i = 0; i < 8 && !(await look(x.page)).again; i++) {
      await x.say({ type: "dgcBrowserScreenClosed", reason: "DGC Browser isn't open yet. Open it from the dock.", pictures: false });
      await x.page.waitForFunction((n) => window.__made.length > n || document.querySelector(".yb-again")?.checkVisibility(), i + 2, { timeout: 6000 });
    }
    const seen = await look(x.page);
    assert.ok(seen.again, "Open it again");
    assert.match(await x.page.locator(".yb-again p").textContent(), /isn't open yet/);
    const made = await x.page.evaluate(() => window.__made.length);
    await x.page.click(".yb-again-go");
    await x.page.waitForFunction((n) => window.__made.length === n + 1, made);
    assert.equal((await look(x.page)).again, null);
  } finally { await x.close(); }
});

for (const width of [300, 440, 700]) {
  for (const theme of ["dark", "light"]) {
    test(`your own screen at ${width} px, ${theme}: it fills the tab, its notes inside, the one corner`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openScreen(theme, { width, height: 560 });
      try {
        let seen = await look(x.page);
        assert.equal(seen.overflow, false);
        assert.deepEqual(seen.vnc.slice(2), seen.stage.slice(2));
        const note = await x.page.evaluate(() => { const n = document.querySelector(".yb-note").getBoundingClientRect(); return [n.left, n.right, getComputedStyle(document.querySelector(".yb-note")).borderTopLeftRadius]; });
        assert.ok(note[0] >= 0 && note[1] <= width, "its note inside the tab");
        assert.equal(note[2], "6px");
        if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/screen-opening-${width}-${theme}.png` });
        // Open it again, when it has kept closing.
        await x.page.evaluate(() => { for (let i = 0; i < 6; i++) window.dispatchEvent(new MessageEvent("message", { data: { type: "dgcBrowserScreenClosed", reason: "DGC Browser isn't open yet. Open it from the dock.", pictures: false } })); });
        await x.page.waitForFunction(() => document.querySelector(".yb-again")?.checkVisibility() || window.__made.length > 1, null, { timeout: 8000 });
        seen = await look(x.page);
        if (seen.again) {
          assert.ok(seen.again[0] >= 0 && seen.again[0] + seen.again[2] <= width, "the card inside the tab");
          const radius = await x.page.evaluate(() => [getComputedStyle(document.querySelector(".yb-again")).borderTopLeftRadius, getComputedStyle(document.querySelector(".yb-again-go")).borderTopLeftRadius, document.querySelector(".yb-again-go").getBoundingClientRect().height]);
          assert.deepEqual(radius.slice(0, 2), ["6px", "6px"]);
          assert.ok(radius[2] >= 24 && radius[2] <= 28, `a button's height (${radius[2]})`);
          if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/screen-again-${width}-${theme}.png` });
        }
      } finally { await x.close(); }
    });
  }
}
