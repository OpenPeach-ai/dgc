// The formatted canvas's page (src/canvasEditor.ts in canvasDoc.ts's document) in Chromium: it shows the canvas's
// Markdown formatted, sends what you type as Markdown that leaves every other block as it was, formats from its
// toolbar, flashes what the model changed, and asks about a selection with its lines in the file.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const src = (name) => new URL(`../src/${name}`, import.meta.url).pathname;
const media = (name) => new URL(`../media/${name}`, import.meta.url).pathname;
const script = (await build({ entryPoints: [src("canvasEditor.ts")], bundle: true, write: false, format: "iife",
  platform: "browser", target: "chrome108" })).outputFiles[0].text;
const hostCode = (await build({ entryPoints: [src("canvasDoc.ts")], bundle: true, write: false, platform: "node", format: "cjs",
  external: ["vscode"] })).outputFiles[0].text;
const hostModule = { exports: {} };
new Function("module", "exports", "require", hostCode)(hostModule, hostModule.exports, (id) => id === "vscode" ? {} : require(id));
const { canvasDocDocument, minimalChange } = hostModule.exports;

const ORIGIN = "https://canvas.invalid";
const html = canvasDocDocument((name) => `${ORIGIN}/${name}`, ORIGIN);
const FILE = "# Plan\n\nDay one.\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nThe sum is $x^2$, for $5 and $10.\n";

const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] });
after(() => browser.close());

async function open() {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(() => { window.__posted = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m) }); });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: html });
    if (url.endsWith("/dist/canvas.js")) return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.endsWith("/media/canvas.css")) return route.fulfill({ contentType: "text/css", body: readFileSync(media("canvas.css")) });
    if (url.endsWith("/media/codicon.css")) return route.fulfill({ contentType: "text/css", body: readFileSync(media("codicon.css")) });
    return route.abort();
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === "ready"));
  await page.evaluate((text) => window.postMessage({ type: "doc", text }, "*"), FILE);
  await page.waitForSelector(".cv-doc h1");
  return page;
}
// ProseMirror takes up a click's selection a moment after it (selectionchange is async): pause as a person would.
const click = async (page, selector, options) => { await page.click(selector, options); await page.waitForTimeout(120); };
const posted = (page, type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const lastEdit = async (page) => { await page.waitForTimeout(450); const edits = await posted(page, "edit"); return edits.at(-1)?.text; };

test("the canvas shows formatted: a heading, a table drawn as a table, money as text", async () => {
  const page = await open();
  assert.equal(await page.textContent(".cv-doc h1"), "Plan");
  assert.equal(await page.locator(".cv-raw table th, .cv-raw table td").count(), 4, "the table, rendered");
  assert.equal(await page.locator(".cv-doc .md-math").count(), 1, "x^2 is maths; $5 and $10 are money");
  assert.equal((await posted(page, "edit")).length, 0, "opening it sends nothing back");
  await page.close();
});

test("typing sends Markdown that changes only that block; the toolbar formats", async () => {
  const page = await open();
  await click(page, ".cv-doc p >> text=Day one.");
  await page.keyboard.press("End");
  await page.keyboard.type(" By the sea.");
  assert.equal(await lastEdit(page), FILE.replace("Day one.", "Day one. By the sea."));
  await page.dblclick(".cv-doc h1", { position: { x: 12, y: 12 } });      // on the word, not the heading's empty right
  await page.waitForTimeout(120);
  await click(page, '[data-do="strong"]');
  assert.equal(await page.getAttribute('[data-do="strong"]', "aria-pressed"), "true");
  assert.equal(await lastEdit(page), FILE.replace("Day one.", "Day one. By the sea.").replace("# Plan", "# **Plan**"));
  // Markdown typed as Markdown: a new list after the heading.
  await click(page, ".cv-doc h1");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("- milk");
  assert.equal(await page.locator(".cv-doc ul li").count(), 1);
  assert.match(await lastEdit(page), /^# \*\*Plan\*\*\n\n- milk\n\nDay one\. By the sea\.\n\n\| a \| b \|/);
  await page.close();
});

test("a key pressed right after the caret moves acts where the caret is now (End, then Enter, at machine speed)", async () => {
  const page = await open();
  await page.click(".cv-doc p >> text=Day one.", { position: { x: 5, y: 5 } });   // the caret near the start, no pause
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Day two.");
  assert.equal(await lastEdit(page), FILE.replace("Day one.\n", "Day one.\n\nDay two.\n"));
  await page.close();
});

test("the model's change flashes where it landed, and an ask carries the selection's lines in the file", async () => {
  const page = await open();
  const changed = FILE.replace("Day one.", "Day one, by the sea, with a long lunch.");
  await page.evaluate((text) => window.postMessage({ type: "doc", text, external: true }, "*"), changed);
  await page.waitForSelector(".cv-flash");
  assert.match(await page.textContent(".cv-flash"), /long lunch/);
  assert.equal(await page.locator(".cv-flash").count(), 1, "only the block that changed");
  // Select "long lunch" and ask about it.
  await page.evaluate(() => {
    const p = [...document.querySelectorAll(".cv-doc p")].find((n) => n.textContent.includes("long lunch"));
    const text = p.firstChild, at = text.textContent.indexOf("long lunch");
    const range = document.createRange(); range.setStart(text, at); range.setEnd(text, at + "long lunch".length);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
  });
  await page.waitForTimeout(100);
  await page.click("#cv-ask");
  const [ask] = await posted(page, "ask");
  assert.deepEqual(ask, { type: "ask", text: "long lunch", start_line: 3, end_line: 3 });
  assert.equal((await posted(page, "edit")).length, 0, "the model's change isn't sent back");
  await page.close();
});

test("an ask quotes what the file has: the words picked if they're there as they are, else the lines' Markdown", () => {
  const { selectionText } = hostModule.exports;
  const file = "# Plan\n\n**For** eight years, Bangalore was home.\nDay two.\n";
  assert.equal(selectionText(file, 3, 3, "Bangalore was home"), "Bangalore was home");
  assert.equal(selectionText(file, 3, 3, "For eight years, Bangalore"), "**For** eight years, Bangalore was home.");
  assert.equal(selectionText(file, 3, 4, "For eight years\n\nDay two."), "**For** eight years, Bangalore was home.\nDay two.");
});

test("the host replaces only what changed", () => {
  assert.deepEqual(minimalChange("# Plan\n\nDay one.\n", "# Plan\n\nDay one. More.\n"), { start: 16, end: 16, text: " More." });
  assert.equal(minimalChange("same", "same"), undefined);
  assert.deepEqual(minimalChange("aXc", "aYYc"), { start: 1, end: 2, text: "YY" });
});
