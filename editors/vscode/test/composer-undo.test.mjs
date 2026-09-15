import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// Undo in the prompt box, in a real browser. A textarea keeps its own undo history, and that is what
// Cmd+Z and Ctrl+Z act on. (VS Code's Edit → Undo menu item is routed to the active editor and does
// not reach a webview view, so it is not claimed here.) The composer used to assign .value on every send and every
// inserted completion, which wipes that history, so undo did nothing — unlike Claude's and Codex's
// composers. jsdom has no editing commands, so only a real Chromium can prove this.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }

let browser, page, posted;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");

before(async () => {
  if (!chromium) return;
  try {
    browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
  } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readFileSync(here + "/../media/main.css", "utf8");
  const mainJs = readFileSync(here + "/../media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true,
    format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map(m => m[0])
    .find(c => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  page = await browser.newPage({ viewport: { width: 460, height: 800 } });
  await page.setContent(skeleton.replace("</head>", `<style>${css}</style></head>`), { waitUntil: "load" });
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.postMessage({ type: "session_ready", sessionId: "s1" }, "*");
  }, [mainJs, markdownJs]);
  await page.waitForFunction(() => document.getElementById("input"));
  posted = () => page.evaluate(() => window.__posted.filter(m => m.type === "prompt").map(m => m.text));
});
after(async () => { await browser?.close(); });

const value = () => page.evaluate(() => document.getElementById("input").value);
// Linux Chromium binds undo to Ctrl+Z; macOS binds it to Cmd+Z. The browser's own undo command,
// which a key binding ends up running, is exercised directly too.
const undo = () => page.keyboard.press("Control+Z");
const redo = () => page.keyboard.press("Control+Shift+Z");

test("undo right after sending brings the sent prompt back", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await page.click("#input");
  await page.keyboard.type("Fix the flaky login test");
  await page.keyboard.press("Enter");
  assert.deepEqual(await posted(), ["Fix the flaky login test"], "the prompt was sent");
  assert.equal(await value(), "", "and the box was cleared");
  await undo();
  assert.equal(await value(), "Fix the flaky login test", "Ctrl/Cmd+Z restores what was sent");
  await redo();
  assert.equal(await value(), "", "and redo clears it again");
});

test("the browser's undo command works the same way as the key", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await page.click("#input");
  await page.keyboard.type("Explain this stack trace");
  await page.keyboard.press("Enter");
  assert.equal(await value(), "");
  assert.equal(await page.evaluate(() => document.execCommand("undo")), true);
  assert.equal(await value(), "Explain this stack trace");
  await page.evaluate(() => { document.getElementById("input").select(); document.execCommand("delete"); });
});

test("text deleted by hand comes back with undo", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await page.click("#input");
  await page.keyboard.type("keep this draft");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
  assert.equal(await value(), "");
  await undo();
  assert.equal(await value(), "keep this draft");
  await page.keyboard.press("Control+A");
  await page.keyboard.press("Backspace");
});

test("an inserted completion is one undo step, and the typed text before it survives", async (t) => {
  if (skipReason()) return t.skip(skipReason());
  await page.click("#input");
  await page.keyboard.type("review ");
  // The + menu's command entry inserts "/" through the same composer edit as every completion.
  await page.evaluate(() => window.postMessage({ type: "command_menu" }, "*"));
  await page.waitForFunction(() => document.getElementById("input").value === "review /");
  await undo();
  assert.equal(await value(), "review ", "undo removes only the inserted command trigger");
});

const clearBox = () => page.evaluate(() => {
  const box = document.getElementById("input"); box.focus(); box.select(); document.execCommand("delete");
});

test("typing and deleting are undone a run at a time, not one character at a time", async (t) => {
  // Before: every input event rewrote the send button's markup and the follow-up hint, and any
  // DOM replacement while typing closes Chromium's open typing step, so each Ctrl+Z took back
  // a single character.
  if (skipReason()) return t.skip(skipReason());
  await clearBox();
  await page.click("#input");
  await page.keyboard.type("please refactor the calc module");
  await page.waitForTimeout(300);
  for (let i = 0; i < 6; i += 1) await page.keyboard.press("Backspace");
  assert.equal(await value(), "please refactor the calc ");
  await undo();
  assert.equal(await value(), "please refactor the calc module", "one Ctrl+Z restores the deleted word");
  await page.keyboard.press("End");
  await page.keyboard.type(" in one two three steps");
  await page.waitForTimeout(300);
  await undo();
  assert.equal(await value(), "please refactor the calc module", "one Ctrl+Z removes the typed run");
  await clearBox();
});

test("a workflow command picked from the slash menu is one undo step", async (t) => {
  // Before: the typed token was deleted by one editing command and the /plan prefix inserted by
  // a second, so the first Ctrl+Z showed a blank box and only the second reached "/pla".
  if (skipReason()) return t.skip(skipReason());
  for (const [typed, command, inserted] of [["/pla", "/plan", "/plan "], ["write tests /revi", "/review", "/review write tests "]]) {
    await clearBox();
    await page.click("#input");
    await page.keyboard.type(typed);
    await page.waitForFunction((label) => [...document.querySelectorAll("#pop .pi-label")].some(n => n.textContent === label), command);
    await page.waitForTimeout(200);
    await page.keyboard.press("Enter");
    assert.equal(await value(), inserted);
    await undo();
    assert.equal(await value(), typed, `one Ctrl+Z returns to "${typed}"`);
    await redo();
    assert.equal(await value(), inserted, "and redo puts the command back, not a blank box");
  }
  await clearBox();
});

test("a new chat starts with a fresh undo history even when both composers are empty", async (t) => {
  // Before: selectDraftSession assigned "" over "", which Chromium ignores, so Ctrl+Z in the new
  // chat brought back the prompt sent in the previous one.
  if (skipReason()) return t.skip(skipReason());
  await clearBox();
  await page.click("#input");
  await page.keyboard.type("Reply with the single word kiwi.");
  await page.keyboard.press("Enter");
  assert.equal(await value(), "");
  await page.evaluate(() => window.postMessage({ type: "event", event: { type: "session", kind: "new", session_id: "fresh-chat" } }, "*"));
  await page.waitForTimeout(100);
  await page.click("#input");
  await undo(); await undo();
  assert.equal(await value(), "", "nothing from the other chat comes back");
  await page.evaluate(() => window.postMessage({ type: "session_ready", sessionId: "s1" }, "*"));
  await page.waitForTimeout(100);
});

test("undoing Show in text field folds the pasted text back into its chip", async (t) => {
  // Before: the insert was undoable but removing the chip was not, so one Ctrl+Z deleted the
  // pasted text and left no chip: the paste was gone.
  if (skipReason()) return t.skip(skipReason());
  await clearBox();
  await page.click("#input");
  await page.keyboard.type("see attached: ");
  const big = "x".repeat(5589);
  await page.evaluate((text) => {
    const data = new DataTransfer(); data.setData("text/plain", text);
    document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, big);
  const chips = () => page.evaluate(() => document.querySelectorAll("#attachments .pasted-chip").length);
  assert.equal(await chips(), 1);
  await page.click("#attachments .chip-action");
  assert.equal((await value()).length, 14 + big.length);
  assert.equal(await chips(), 0);
  await page.click("#input");
  await undo();
  assert.equal(await value(), "see attached: ");
  assert.equal(await chips(), 1, "the chip is back");
  await redo();
  assert.equal((await value()).length, 14 + big.length);
  assert.equal(await chips(), 0, "and redo shows it in the text field again");
  await clearBox();
});
