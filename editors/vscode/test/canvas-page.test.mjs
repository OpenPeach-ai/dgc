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
// KaTeX as the page loads it (src/katex-entry.mts), for a formula drawn as it really is.
const katexScript = (await build({ entryPoints: [src("katex-entry.mts")], bundle: true, write: false, format: "iife",
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

async function open(file = FILE) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.addInitScript(() => { window.__posted = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m) }); });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: html });
    if (url.endsWith("/dist/canvas.js")) return route.fulfill({ contentType: "text/javascript", body: script });
    if (url.endsWith("/media/canvas.css")) return route.fulfill({ contentType: "text/css", body: readFileSync(media("canvas.css")) });
    if (url.endsWith("/media/codicon.css")) return route.fulfill({ contentType: "text/css", body: readFileSync(media("codicon.css")) });
    if (url.endsWith("/dist/katex/katex.js")) return route.fulfill({ contentType: "text/javascript", body: katexScript });
    if (url.endsWith("/dist/katex/katex.css")) return route.fulfill({ contentType: "text/css", body: readFileSync(require.resolve("katex/dist/katex.min.css")) });
    return route.abort();
  });
  await page.goto(`${ORIGIN}/`);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === "ready"));
  await page.evaluate((text) => window.postMessage({ type: "doc", text }, "*"), file);
  await page.waitForSelector(".cv-doc > *");
  return page;
}
// ProseMirror takes up a click's selection a moment after it (selectionchange is async): pause as a person would.
const click = async (page, selector, options) => { await page.click(selector, options); await page.waitForTimeout(120); };
const posted = (page, type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const lastEdit = async (page) => { await page.waitForTimeout(450); const edits = await posted(page, "edit"); return edits.at(-1)?.text; };

test("the canvas shows formatted: a heading, a table drawn as a table, money as text", async () => {
  const page = await open();
  assert.equal(await page.textContent(".cv-doc h1"), "Plan");
  assert.equal(await page.locator(".cv-doc table th, .cv-doc table td").count(), 4, "the table, the editor's own");
  assert.equal(await page.locator(".cv-raw").count(), 0, "nothing kept aside");
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

test("a table: type in a cell, Tab past the last for a new row, Enter goes down; columns and alignment from its tools", async () => {
  const page = await open("Costs:\n\n| Day | Cost |\n| - | - |\n| 1 | 2 |\n\nEnd.\n");
  assert.equal(await page.isHidden("#cv-table-bar"), true, "its tools only show in a table");
  await click(page, ".cv-doc td >> text=2");
  assert.equal(await page.isVisible("#cv-table-bar"), true);
  await page.keyboard.press("End");
  await page.keyboard.type("00");
  await page.keyboard.press("Tab");                                   // the last cell: a new row
  await page.keyboard.type("2");
  await page.keyboard.press("Tab");
  await page.keyboard.type("350");
  assert.equal(await lastEdit(page), "Costs:\n\n| Day | Cost |\n| --- | --- |\n| 1 | 200 |\n| 2 | 350 |\n\nEnd.\n");
  await page.keyboard.press("Enter");                                 // the cell below: a new row, not a new line
  await page.keyboard.type("3");
  await page.selectOption("#cv-insert", "colRight");
  assert.equal(await page.inputValue("#cv-insert"), "", "a menu: it shows its name again");
  await page.selectOption("#cv-align", "right");
  assert.equal(await page.inputValue("#cv-align"), "right", "it shows the column's alignment");
  assert.equal(await lastEdit(page), "Costs:\n\n| Day | Cost |  |\n| --- | ---: | --- |\n| 1 | 200 |  |\n| 2 | 350 |  |\n|  | 3 |  |\n\nEnd.\n");
  await page.keyboard.press("Tab");                                   // into the new column: it's the one deleted
  await page.selectOption("#cv-delete", "delCol");
  assert.equal(await page.isVisible("#cv-table-bar"), true, "still in the table: its tools stay");
  await page.selectOption("#cv-delete", "delRow");
  assert.equal(await lastEdit(page), "Costs:\n\n| Day | Cost |\n| --- | ---: |\n| 1 | 200 |\n| 2 | 350 |\n\nEnd.\n");
  // A new table from the toolbar, on an empty line.
  await click(page, ".cv-doc p >> text=End.");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await click(page, '[data-do="table"]');
  await page.keyboard.type("Item");
  assert.match(await lastEdit(page), /End\.\n\n\| Item \|  \|  \|\n\| --- \| --- \| --- \|\n\|  \|  \|  \|\n\|  \|  \|  \|\n$/);
  await page.close();
});

test("maths: a formula clicked opens its TeX with the result drawn; typed $…$ becomes one; $$ makes an equation", async () => {
  const page = await open("The sum is $x^2$, for $5 and $10.\n\nNext.\n");
  await click(page, ".cv-doc .cv-math");
  await page.waitForSelector(".cv-tex input");
  assert.equal(await page.inputValue(".cv-tex input"), "x^2");
  await page.fill(".cv-tex input", "x^3 + 1");
  assert.equal(await page.getAttribute(".cv-tex-preview", "data-tex"), "x^3 + 1", "drawn as you type");
  await page.keyboard.press("Enter");
  assert.equal(await page.locator(".cv-tex").count(), 0);
  assert.equal(await lastEdit(page), "The sum is $x^3 + 1$, for $5 and $10.\n\nNext.\n");
  await click(page, ".cv-doc .cv-math");
  await page.fill(".cv-tex input", "nothing kept");
  await page.keyboard.press("Escape");
  assert.match(await page.textContent(".cv-doc p"), /x\^3 \+ 1/, "Esc keeps it as it was");
  // Typed: a formula, and money left as money.
  await click(page, ".cv-doc p >> text=Next.");
  await page.keyboard.press("End");
  await page.keyboard.type(" Then $a+b$ and $3 or $4.");
  assert.equal(await page.locator(".cv-doc .cv-math").count(), 2);
  assert.equal(await lastEdit(page), "The sum is $x^3 + 1$, for $5 and $10.\n\nNext. Then $a+b$ and $3 or $4.\n");
  // "$$ " on an empty line: an equation, opened to write.
  await page.keyboard.press("Enter");
  await page.keyboard.type("$$ ");
  await page.waitForSelector(".cv-tex textarea");
  await page.keyboard.type("\\sum_i c_i");
  await page.keyboard.press("Control+Enter");
  assert.equal(await lastEdit(page), "The sum is $x^3 + 1$, for $5 and $10.\n\nNext. Then $a+b$ and $3 or $4.\n\n$$\n\\sum_i c_i\n$$\n");
  // The toolbar's Equation, inside a line: a formula; emptied, it's gone.
  await click(page, ".cv-doc p >> text=Next.");
  await page.keyboard.press("Home");
  await click(page, '[data-do="equation"]');
  await page.waitForSelector(".cv-tex input");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".cv-doc .cv-math-empty").count(), 0, "a new one left empty is removed");
  await page.close();
});

test("a drawn fraction is one thing to click: the click lands on it, not through its gaps to the paragraph", async () => {
  const page = await open("Per day: $C_{\\text{day}} = \\frac{C_{\\text{total}}}{n}$ with $n = 3$.\n");
  await page.waitForSelector(".cv-math .katex");                      // drawn by KaTeX
  await page.locator(".cv-math").first().click({ timeout: 5000 });   // its middle: between the fraction's pieces
  await page.waitForSelector(".cv-tex input");
  assert.equal(await page.inputValue(".cv-tex input"), "C_{\\text{day}} = \\frac{C_{\\text{total}}}{n}");
  await page.close();
});

test("a checklist: a box you tick, the toolbar makes one, Enter adds an unticked item", async () => {
  const page = await open("Packing:\n\n- [ ] Passport\n- [x] Tickets\n\nTo buy\n");
  assert.deepEqual(await page.$$eval(".cv-task input", (boxes) => boxes.map((b) => b.checked)), [false, true]);
  await page.click(".cv-task input >> nth=0");
  assert.equal(await lastEdit(page), "Packing:\n\n- [x] Passport\n- [x] Tickets\n\nTo buy\n");
  await click(page, ".cv-task-text >> text=Tickets");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Hat");
  assert.equal(await lastEdit(page), "Packing:\n\n- [x] Passport\n- [x] Tickets\n- [ ] Hat\n\nTo buy\n");
  await page.keyboard.press("Control+Enter");                         // ticks the item you're in
  await click(page, ".cv-doc > p >> text=To buy");
  await click(page, '[data-do="checklist"]');
  assert.equal(await lastEdit(page), "Packing:\n\n- [x] Passport\n- [x] Tickets\n- [x] Hat\n\n- [ ] To buy\n");
  assert.equal(await page.getAttribute('[data-do="checklist"]', "aria-pressed"), "true");
  await page.close();
});

test("the host replaces only what changed", () => {
  assert.deepEqual(minimalChange("# Plan\n\nDay one.\n", "# Plan\n\nDay one. More.\n"), { start: 16, end: 16, text: " More." });
  assert.equal(minimalChange("same", "same"), undefined);
  assert.deepEqual(minimalChange("aXc", "aYYc"), { start: 1, end: 2, text: "YY" });
});
