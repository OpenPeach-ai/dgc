// Scrollbars on every DGC page (17 Nov live check on Linux; decided: "Slim bars everywhere"). VS Code gives each
// webview `html { scrollbar-color: … }` in its own default layer; Chromium then ignores every ::-webkit-scrollbar rule and
// draws its standard bar (arrow buttons and a wide pill on Linux and Windows, a hiding overlay on a Mac). DGC's pages undo
// that one property, so the slim bars (media/shared/tokens.css) are what draws, the Pips' shadow root included, as the
// tests and the layout audit see them. In real Chromium, with VS Code's layer put in first.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { conversation, openChat } from "./support/chat-scene.mjs";
import { openOnePips } from "./support/one-pips-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { // Headless Chromium hides scrollbars unless told otherwise: these tests measure them.
  browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"], ignoreDefaultArgs: ["--hide-scrollbars"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

// What VS Code's webview puts on every page (its pre/index.html, _defaultStyles).
const VSCODE_LAYER = "@layer vscode-default { html { scrollbar-color: rgba(100, 100, 100, 0.4) rgb(30, 30, 30); } }";
const insertLayer = (page) => page.evaluate((css) => { const s = document.createElement("style"); s.id = "_defaultStyles"; s.textContent = css; document.head.prepend(s); }, VSCODE_LAYER);
// A scrolling box put into `root` (the page, or a shadow root): the width its bar takes.
const barWidth = (page, inShadow) => page.evaluate((shadow) => {
  // The page root, not the body: with the Pips showing, Work's page hides whatever else sits directly in its body.
  const root = shadow ? document.getElementById("pips-host")?.shadowRoot : document.documentElement;
  if (!root) return -1;
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;left:0;top:0;width:120px;height:60px;overflow-y:scroll";
  box.innerHTML = "<div style='height:400px'></div>";
  (root.querySelector?.(".pip-app-root") || root).append(box);
  const width = box.offsetWidth - box.clientWidth; box.remove(); return width;
}, inShadow);

test("ChatDGC: VS Code's scrollbar colour is undone and the slim bar draws", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat(browser, { width: 900, height: 700 });
  try {
    await insertLayer(s.page);
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    assert.equal(await s.page.evaluate(() => getComputedStyle(document.documentElement).scrollbarColor), "auto");
    assert.equal(await barWidth(s.page, false), 10, "the slim 10px bar, not the 15px standard one with arrows");
    assert.equal(await s.page.evaluate(() => getComputedStyle(document.getElementById("cd-input")).scrollbarWidth), "auto", "nothing asks for a thin standard bar");
  } finally { await s.page.close(); }
});

test("Work's side bar and the Pips' shadow root draw the slim bar; the chat tabs still hide theirs", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openOnePips(browser, { width: 320, height: 760 });
  try {
    await insertLayer(s.page);
    assert.equal(await barWidth(s.page, false), 10, "Work's page");
    assert.equal(await barWidth(s.page, true), 10, "inside the Pips' shadow root");
    const tabs = await s.page.evaluate(() => { const el = document.querySelector(".chatbar .chat-tabs"); return el ? getComputedStyle(el).scrollbarWidth : "none"; });
    assert.equal(tabs, "none");
  } finally { await s.page.context().close(); }
});

test("a Pip in its own editor tab draws the slim bar too", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openOnePips(browser, { width: 900, height: 760, where: "tab" });
  try {
    await insertLayer(s.page);
    assert.equal(await barWidth(s.page, false), 10);
  } finally { await s.page.context().close(); }
});
