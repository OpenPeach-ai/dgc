import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// Undo in the prompt box, in a real browser. A textarea keeps its own undo history, and that is what
// Cmd+Z, Ctrl+Z and Edit → Undo act on. The composer used to assign .value on every send and every
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
// Linux Chromium binds undo to Ctrl+Z; macOS binds it to Cmd+Z. Edit → Undo and the macOS menu
// accelerator reach the page as the editing command itself, which is exercised directly too.
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

test("Edit → Undo (the command the macOS menu sends) works the same way", async (t) => {
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
