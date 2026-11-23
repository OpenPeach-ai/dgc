// A Pip's tab in Your Browser, streamed into an editor tab beside the chat (Pips API 107; his call, 17 Nov):
//   - the host pins the tab to its own Pip's lane: use_your_browser_view and open_your_browser for that Pip, nothing
//     else (never another Pip's lane, never the person's own tabs, no other command), and an older DGC is refused;
//   - the page (src/yourBrowserTab.js, real Chromium): the Pip's tab live with DGC's own address bar and the Pips' tabs
//     in a row; a click lands where it was made on the page, the address bar goes (DGC refuses an address off the Pip's
//     sites, in words), Back, Forward and Reload drive the lane; another Pip's tab opens its own editor tab;
//   - the side bar's dock offers "Watch <Pip>'s tab" for each Pip working in Your Browser.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { openDock, dockNow } from "./support/dock-scene.mjs";
import { homeState } from "./support/home-scene.mjs";
import { THEMES } from "./support/agent-lines-scene.mjs";

const require = createRequire(import.meta.url), src = fileURLToPath(new URL("../src/", import.meta.url));
const view = (await build({ entryPoints: [src + "pipsView.ts"], bundle: true, write: false, platform: "node", format: "cjs", external: ["vscode"] })).outputFiles[0].text;
const host = (() => { const out = { exports: {} }; new Function("module", "exports", "require", view)(out, out.exports, (name) => (name === "vscode" ? {} : require(name))); return out.exports; })();
const AVA = "pip_" + "a".repeat(32), BEN = "pip_" + "b".repeat(32);

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
const bundle = await build({ entryPoints: [src + "yourBrowserTab.js"], bundle: true, write: false, format: "esm", platform: "browser", outdir: "out", target: "chrome108" });
const pageJs = bundle.outputFiles.find((f) => f.path.endsWith(".js")).text, pageCss = bundle.outputFiles.find((f) => f.path.endsWith(".css")).text;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

// ---- the host's pin ---------------------------------------------------------------------------------------------------
test("the host pins a streamed tab to its own Pip's lane", () => {
  const ok = (request) => assert.equal(host.yourBrowserTabRefusal(request, AVA), "", JSON.stringify(request));
  const no = (request, why) => assert.match(host.yourBrowserTabRefusal(request, AVA), /only shows this Pip/, why || JSON.stringify(request));
  for (const op of ["frame", "click", "type", "key", "scroll", "go", "back", "forward", "reload", "close"]) ok({ type: "use_your_browser_view", pip_id: AVA, op });
  ok({ type: "use_your_browser_view", pip_id: AVA, op: "click", x: 10, y: 20 });
  ok({ type: "open_your_browser", pip_id: AVA });
  no({ type: "use_your_browser_view", pip_id: BEN, op: "frame" }, "never another Pip's lane");
  no({ type: "use_your_browser_view", op: "frame" }, "never the person's own tabs");
  no({ type: "use_your_browser_view", pip_id: AVA, op: "explode" });
  no({ type: "use_your_browser_view", pip_id: AVA, op: "frame", path: "/etc" }, "only the view's own fields");
  no({ type: "open_your_browser", pip_id: AVA, url: "https://elsewhere.example" }, "never an address of the person's");
  no({ type: "get_your_browser", pip_id: AVA });
  no({ type: "set_your_browser_site", pip_id: AVA, site: "example.com", mode: "all" });
  no({ type: "send_pip_message", pip_id: AVA, text: "hi" });
  no(null);
  const doc = host.yourBrowserDocument("vscode-resource:/dist/yourBrowserTab.js", "vscode-resource:/dist/yourBrowserTab.css", "vscode-resource:", "Ava · Your Browser");
  assert.match(doc, /default-src 'none'/);
  assert.match(doc, /<title>Ava · Your Browser<\/title>/);
  assert.doesNotMatch(doc, /unsafe-eval|https?:\/\//, "nothing from the web, nothing evaluated");
  assert.equal(host.YOUR_BROWSER_API, 107);
});

test("the host opens one streamed tab per Pip, beside the chat, named for the Pip", () => {
  const source = readFileSync(src + "pipsView.ts", "utf8");
  // (A Pip's tab beside the chat; your own tab, where there is no screen, in the editor itself: your-browser-own.test.mjs.)
  assert.match(source, /createWebviewPanel\('dgc\.yourBrowser', title, pip \? vscode\.ViewColumn\.Beside : vscode\.ViewColumn\.Active/);
  assert.match(source, /const title = pip \? `\$\{pip\.name\} · Your Browser` : 'Your Browser';/);
  const esb = readFileSync(new URL("../esbuild.js", import.meta.url), "utf8");
  assert.match(esb, /src\/yourBrowserTab\.js/, "its page is built with the others");
});

// ---- the page -------------------------------------------------------------------------------------------------------
/** A picture of a page 640 by 400 CSS pixels, drawn at twice its size (a sharp screen), with a mark at (200, 100). */
async function shotOf(page) {
  return page.evaluate(() => { const c = document.createElement("canvas"); c.width = 1280; c.height = 800; const g = c.getContext("2d");
    g.fillStyle = "#f4f7fb"; g.fillRect(0, 0, 1280, 800); g.fillStyle = "#1a5fd0"; g.font = "64px sans-serif"; g.fillText("Your cart", 60, 120); g.fillRect(380, 180, 40, 40); return c.toDataURL("image/jpeg", 0.8); });
}
async function openTab(theme = "dark", { width = 900, height = 600, frames = true, api = 107 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><head><style>${pageCss}</style><style>body{background:${theme === "dark" ? "#1e1e1e" : "#ffffff"};color:${theme === "dark" ? "#ccc" : "#222"}}</style><style>:root{${THEMES[theme === "dark" ? "dark-modern" : "light-modern"]}}</style></head><body class="${theme === "dark" ? "vscode-dark" : "vscode-light"}"><main id="app"></main></body></html>`);
  const image = await shotOf(page);
  await page.evaluate(([image, frames, api, AVA, BEN]) => {
    window.__sent = []; window.__posted = [];
    const reply = (m, result, ok = true, error) => setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: ok ? { type: "pipsReply", id: m.id, ok: true, result } : { type: "pipsReply", id: m.id, ok: false, error: { message: error } } })), 5);
    window.__frame = { ok: true, pip_id: AVA, url: "https://shop.example.com/cart", title: "Your cart", width: 640, height: 400, image,
      lanes: [{ pip_id: AVA, name: "Ava", title: "Your cart", url: "https://shop.example.com/cart" }, { pip_id: BEN, name: "Ben", title: "Inbox", url: "https://mail.example.net/" }] };
    window.acquireVsCodeApi = () => ({ getState: () => null, setState() {}, postMessage(m) {
      window.__posted.push(JSON.parse(JSON.stringify(m)));
      if (m.type === "pipsReady") setTimeout(() => {
        window.dispatchEvent(new MessageEvent("message", { data: { type: "yourBrowserInit", pip: { id: AVA, name: "Ava" } } }));
        window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion: api, connected: true, supported: true, enabled: true } }));
      }, 5);
      if (m.type !== "pipsRequest") return;
      window.__sent.push(m.request);
      const r = m.request;
      if (r.type === "use_your_browser_view" && r.op === "go" && !/example\.com/.test(r.url)) return reply(m, { ok: false, error: "This Pip uses only the sites you allowed it in Your Browser (example.com). Open elsewhere.org in your own tab instead." });
      if (r.type === "use_your_browser_view") return reply(m, frames ? window.__frame : { ok: false, error: "This Pip has no tab in Your Browser yet: it opens one when it works there." });
      if (r.type === "open_your_browser") return reply(m, { ok: true, kind: "host_profile", weaker: true, url: "", open: true });
    } });
  }, [image, frames, api, AVA, BEN]);
  await page.addScriptTag({ content: pageJs, type: "module" });
  return { page, close: () => context.close(), sent: (op) => page.evaluate((o) => window.__sent.filter((r) => !o || r.op === o), op) };
}

test("the page: the Pip's tab live, its address in DGC's own bar, the Pips' tabs in a row", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTab();
  try {
    await x.page.waitForFunction(() => { const f = document.querySelector(".yb-frame"); return f && !f.hidden && f.naturalWidth > 0; }, null, { timeout: 10000 });
    const seen = await x.page.evaluate(() => ({ url: document.querySelector(".yb-url").value, title: document.title, tabs: [...document.querySelectorAll(".yb-tab")].map((b) => [b.querySelector(".yb-tab-name").textContent, b.getAttribute("aria-selected")]),
      frame: (() => { const r = document.querySelector(".yb-frame").getBoundingClientRect(); return { w: r.width, h: r.height, right: r.right, bottom: r.bottom }; })(), overflow: document.documentElement.scrollWidth > innerWidth }));
    assert.equal(seen.url, "https://shop.example.com/cart");
    assert.equal(seen.title, "Ava · Your Browser");
    assert.deepEqual(seen.tabs, [["Ava", "true"], ["Ben", "false"]]);
    assert.ok(Math.abs(seen.frame.w / seen.frame.h - 1.6) < 0.02, "the picture keeps its shape");
    assert.ok(seen.frame.right <= 900 && seen.frame.bottom <= 600 && !seen.overflow, "it fits the editor tab");
    const frames = await x.sent("frame");
    assert.ok(frames.length >= 1 && frames.every((r) => r.pip_id === "pip_" + "a".repeat(32)), "only its own Pip's lane");
    // Pictures keep coming while it is shown.
    await x.page.waitForTimeout(800);
    assert.ok((await x.sent("frame")).length >= 2);
  } finally { await x.close(); }
});

test("the row of Pips names its own Pip where DGC's list of tabs carries no name (never \"A Pip\")", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTab();
  try {
    // (What an older supervisor's list says: each Pip's id and its page, no name.)
    await x.page.evaluate(([AVA, BEN]) => { window.__frame = { ...window.__frame, title: "Mystery | Books to Scrape",
      lanes: [{ pip_id: AVA, title: "Mystery | Books to Scrape", url: "https://books.toscrape.com/" }, { pip_id: BEN, name: "", title: "Inbox", url: "https://mail.example.net/" }] }; }, [AVA, BEN]);
    await x.page.waitForFunction(() => document.querySelector(".yb-tab .yb-tab-title")?.textContent === "Mystery | Books to Scrape", null, { timeout: 10000 });
    const tabs = await x.page.evaluate(() => [...document.querySelectorAll(".yb-tab")].map((b) => [b.querySelector(".yb-tab-name").textContent, b.title]));
    assert.deepEqual(tabs[0], ["Ava", "Ava: Mystery | Books to Scrape"], "its own Pip by the name the tab was opened with");
  } finally { await x.close(); }
});

test("the page: a click lands where it was made, typing and keys reach the tab, and the bar drives it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTab();
  try {
    await x.page.waitForFunction(() => { const f = document.querySelector(".yb-frame"); return f && !f.hidden && f.naturalWidth > 0; }, null, { timeout: 10000 });
    // The mark is at (200, 100) of a 640 by 400 page, drawn at twice the size.
    const box = await x.page.evaluate(() => { const r = document.querySelector(".yb-frame").getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height }; });
    await x.page.mouse.click(box.left + box.width * (200 / 640), box.top + box.height * (100 / 400));
    await x.page.waitForFunction(() => window.__sent.some((r) => r.op === "click"));
    const [click] = await x.sent("click");
    assert.ok(Math.abs(click.x - 200) <= 1.5 && Math.abs(click.y - 100) <= 1.5, `in the page's own pixels (${click.x}, ${click.y})`);
    await x.page.keyboard.type("blue shoes");
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction(() => window.__sent.some((r) => r.op === "key"));
    assert.equal((await x.sent("type")).map((r) => r.text).join(""), "blue shoes");
    assert.equal((await x.sent("key"))[0].key, "Enter");
    for (const [cls, op] of [[".yb-back", "back"], [".yb-forward", "forward"], [".yb-reload", "reload"]]) {
      await x.page.click(cls);
      await x.page.waitForFunction((o) => window.__sent.some((r) => r.op === o), op);
    }
    await x.page.fill(".yb-url", "shop.example.com/orders");
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction(() => window.__sent.some((r) => r.op === "go"));
    assert.equal((await x.sent("go"))[0].url, "shop.example.com/orders", "DGC makes it an address or a search");
    // Off its sites: DGC refuses, and the page says so.
    await x.page.fill(".yb-url", "https://elsewhere.org/");
    await x.page.keyboard.press("Enter");
    await x.page.waitForFunction(() => /only the sites you allowed/.test(document.querySelector(".yb-note").textContent));
    // Show it in the window, and another Pip's tab opens its own editor tab.
    await x.page.click(".yb-window");
    await x.page.waitForFunction(() => window.__sent.some((r) => r.type === "open_your_browser"));
    assert.deepEqual(Object.keys((await x.sent()).find((r) => r.type === "open_your_browser")).sort(), ["pip_id", "type"]);
    await x.page.click('.yb-tab[data-pip="pip_' + "b".repeat(32) + '"]');
    const opened = await x.page.evaluate(() => window.__posted.filter((m) => m.type === "pipsOpenYourBrowser"));
    assert.deepEqual(opened.map((m) => m.pip), [{ id: "pip_" + "b".repeat(32), name: "Ben" }]);
  } finally { await x.close(); }
});

test("the page: a Pip with no tab there yet says so, and an older DGC asks for nothing", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openTab("light", { frames: false });
  try {
    await x.page.waitForFunction(() => /no tab in Your Browser yet/.test(document.querySelector(".yb-note").textContent), null, { timeout: 10000 });
    assert.equal(await x.page.evaluate(() => document.querySelector(".yb-frame").hidden), true);
  } finally { await x.close(); }
  const y = await openTab("dark", { api: 106 });
  try {
    await y.page.waitForFunction(() => /Update DGC/.test(document.querySelector(".yb-note").textContent), null, { timeout: 10000 });
    assert.equal((await y.sent()).length, 0);
    // What the tab says stays until something else is said: its × (media/shared/dismiss.js) puts it away, the focus
    // goes to the address bar, and the next picture's poll doesn't bring the same words back.
    const x0 = await y.page.evaluate(() => { const b = document.querySelector(".yb-note > .dgc-dismiss"); return b && { title: b.title, name: b.getAttribute("aria-label"), w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height, radius: getComputedStyle(b).borderTopLeftRadius }; });
    assert.deepEqual(x0, { title: "Dismiss", name: "Dismiss this message", w: 26, h: 26, radius: "6px" });
    await y.page.click(".yb-note > .dgc-dismiss"); await y.page.waitForTimeout(800);
    assert.equal(await y.page.evaluate(() => document.querySelector(".yb-note").checkVisibility()), false, "closed, and it stays closed");
    assert.equal(await y.page.evaluate(() => document.activeElement?.className), "yb-url");
  } finally { await y.close(); }
});

for (const theme of ["dark", "light"]) {
  for (const width of [300, 440, 700]) {
    test(`the page at ${width}px (${theme}): one design language, nothing past its edge`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openTab(theme, { width, height: 520 });
      try {
        await x.page.waitForFunction(() => { const f = document.querySelector(".yb-frame"); return f && !f.hidden && f.naturalWidth > 0; }, null, { timeout: 10000 });
        const look = await x.page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth,
          parts: [...document.querySelectorAll(".yb-btn, .yb-url, .yb-tab, .yb-frame")].map((n) => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return { what: n.className, right: r.right, radius: s.borderTopLeftRadius, height: r.height }; }) }));
        assert.equal(look.overflow, false);
        for (const part of look.parts) {
          assert.ok(part.right <= width + 0.5, `${part.what} stays on the page`);
          assert.equal(part.radius, "6px", `${part.what}: 6 px corners, never a pill`);
          if (!/yb-frame/.test(part.what)) assert.ok(part.height >= 24 && part.height <= 28, `${part.what}: a button's height (${part.height})`);
        }
        if (process.env.DGC_YB_PICTURES) await x.page.screenshot({ path: `${process.env.DGC_YB_PICTURES}/streamed-tab-${width}-${theme}.png` });
      } finally { await x.close(); }
    });
  }
}

// ---- the dock offers to watch a Pip's tab ---------------------------------------------------------------------------------
test("the dock's Browser menu offers each Pip working there, and opens its streamed tab", async (t) => {
  if (skipOrFail(t)) return;
  const state = { ...homeState(), browser: { recent: { links: [], open: true, available: true, reason: "", lanes: [{ pip_id: AVA, name: "Ava", title: "Your cart", url: "https://shop.example.com/cart" }] } } };
  const x = await openDock(browser, { width: 440, height: 700, api: 107, state });
  try {
    await x.page.waitForFunction(() => !!document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]'), null, { timeout: 15000 });
    await x.page.waitForFunction(() => window.__answered.includes("get_your_browser_recent"), null, { timeout: 15000 });
    const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
    await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2, { button: "right" });
    await x.page.waitForFunction(() => document.querySelectorAll(".dgc-pop .dgc-menu-row").length > 1, null, { timeout: 5000 });
    assert.deepEqual((await dockNow(x.page)).menu, ["Open Your Browser", "Watch Ava's tab"]);
    await x.page.click('.dgc-pop .dgc-menu-row:has-text("Watch Ava")');
    const opened = await x.posted("pipsOpenYourBrowser");
    assert.deepEqual(opened.map((m) => m.pip), [{ id: AVA, name: "Ava" }]);
    assert.ok(opened[0].documentId, "the side bar's own Pips document");
  } finally { await x.close(); }
});
