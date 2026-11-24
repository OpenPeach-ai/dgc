// User test round 2, A8, a DGC document's comments (src/canvasEditor.ts with media/shared/comments.js) in real Chromium.
// A comment's text showed its Markdown backticks raw (`totals.py`): inline code is drawn as code. The floating Comment
// button sat on the line under the picked words and hid its first letters: it stands in the page's margin now, as its
// mark alone where the margin is narrow, and over no words.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readStylesheet } from "./support/stylesheet.mjs";
import { THEMES } from "./support/options-scene.mjs";
import { shot } from "./support/ut2b-common.mjs";

const require = createRequire(import.meta.url);
const src = (name) => new URL(`../src/${name}`, import.meta.url).pathname;
const media = (name) => new URL(`../media/${name}`, import.meta.url).pathname;
const script = (await build({ entryPoints: [src("canvasEditor.ts")], bundle: true, write: false, format: "iife",
  platform: "browser", target: "chrome108" })).outputFiles[0].text;
const hostCode = (await build({ entryPoints: [src("canvasDoc.ts")], bundle: true, write: false, platform: "node", format: "cjs",
  external: ["vscode"] })).outputFiles[0].text;
const hostModule = { exports: {} };
new Function("module", "exports", "require", hostCode)(hostModule, hostModule.exports, (id) => id === "vscode" ? {} : require(id));
const { canvasDocDocument } = hostModule.exports;

const ORIGIN = "https://canvas.invalid";
const html = canvasDocDocument((name) => `${ORIGIN}/${name}`, ORIGIN, true);
const LINE = "Billing is two small, independent modules in this repository. Neither knows about the other, and neither is wired to the cart yet. ";
const FILE = "# Billing in Lime Tiles\n\n## The big picture\n\n" + LINE.repeat(4) + "\n\n" + LINE.repeat(3) + "\n";
const FILE0 = "# Trip plan\n\n## Getting there\n\nWe take the **early train** to Pune on Friday.\n\n## Back\n\nWe take the early train home on Sunday.\n";
const AT = "2026-11-22T10:00:00Z";

let browser = null, launchError = "";
try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); }
catch (error) { launchError = String(error?.message || error).split("\n")[0]; }
after(() => browser?.close());
const test = (name, fn) => nodeTest(name, async (t) => {
  if (!browser) {
    if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: Chromium could not start: ${launchError}`);
    t.skip(`Chromium could not start: ${launchError}`);
    return;
  }
  return fn(t);
});

async function open({ width = 1000, height = 700, theme = "dark-modern" } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(() => { window.__posted = []; window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m) }); });
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (route.request().isNavigationRequest()) return route.fulfill({ contentType: "text/html", body: html });
    if (url.endsWith("/dist/canvas.js")) return route.fulfill({ contentType: "text/javascript", body: script });
    for (const js of ["shared/menu.js", "shared/icons.js", "shared/download.js", "shared/dismiss.js", "shared/comments.js"]) {
      if (url.endsWith(`/media/${js}`)) return route.fulfill({ contentType: "text/javascript", body: readFileSync(media(js)) });
    }
    if (url.endsWith("/media/canvas.css")) return route.fulfill({ contentType: "text/css", body: readStylesheet(media("canvas.css")) });
    if (url.endsWith("/media/codicon.css")) return route.fulfill({ contentType: "text/css", body: readFileSync(media("codicon.css")) });
    return route.abort();
  });
  await page.goto(`${ORIGIN}/`);
  await page.addStyleTag({ content: `:root { ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.waitForFunction(() => window.__posted.some((m) => m.type === "ready"));
  await page.evaluate((text) => window.postMessage({ type: "doc", text }, "*"), FILE);
  await page.waitForSelector(".cv-doc > *");
  return { page, errors };
}
const say = (page, message) => page.evaluate((m) => window.postMessage(m, "*"), message);
const posted = (page, type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const alpha = (c) => {
  const s = String(c || "");
  if (/transparent/.test(s)) return 0;
  const slash = s.match(/\/\s*([\d.]+)\s*\)/);
  if (slash) return Number(slash[1]);
  const n = s.match(/-?[\d.]+/g)?.map(Number) || [];
  return s.startsWith("rgba") && n.length >= 4 ? n[3] : 1;
};
/** Pick the words in the page as a person would: a drag over them, then a pause for ProseMirror to take it up. */
async function pick(page, words, nth = 0) {
  const box = await page.evaluate(({ words, nth }) => {
    const walk = document.createTreeWalker(document.querySelector(".cv-doc"), NodeFilter.SHOW_TEXT);
    let seen = 0;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      const at = n.data.indexOf(words);
      if (at < 0) continue;
      if (seen++ < nth) continue;
      const r = document.createRange(); r.setStart(n, at); r.setEnd(n, at + words.length);
      const b = r.getBoundingClientRect();
      return { x1: b.left + 1, x2: b.right - 1, y: b.top + b.height / 2 };
    }
    return null;
  }, { words, nth });
  assert.ok(box, `“${words}” is on the page`);
  await page.mouse.move(box.x1, box.y); await page.mouse.down(); await page.mouse.move(box.x2, box.y, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(160);
}
const thread = (over = {}) => ({ id: "t_" + "1".repeat(12), version: 2, status: "open", at: AT, by: "you", answering: false, found: "here",
  anchor: { kind: "text", quote: "early train home", before: "We take the ", after: " on Sunday." }, where: "a paragraph under “Back”",
  messages: [{ id: "m_a", by: "you", at: AT, text: "Is there a later one?", kind: "comment" }], suggestions: [], ...over });


/** The Comment button, and every run of words on the page it lies over. */
const chip = (page) => page.evaluate(() => {
  const n = document.querySelector(".dgc-cm-add"), r = n.getBoundingClientRect(), over = [];
  const walk = document.createTreeWalker(document.querySelector(".cv-doc"), NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) { const range = document.createRange(); range.selectNodeContents(t);
    for (const b of range.getClientRects()) if (Math.min(b.right, r.right) - Math.max(b.left, r.left) > 0.5 && Math.min(b.bottom, r.bottom) - Math.max(b.top, r.top) > 0.5) over.push(t.data.slice(0, 30)); }
  const sel = document.getSelection().getRangeAt(0).getBoundingClientRect();
  return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height, over, wide: document.documentElement.clientWidth, words: getComputedStyle(n.querySelector(".dgc-cm-words")).display !== "none" && n.querySelector(".dgc-cm-words").getBoundingClientRect().width > 2,
    title: n.title, label: n.getAttribute("aria-label"), radius: getComputedStyle(n).borderTopLeftRadius, selTop: sel.top, selBottom: sel.bottom };
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 380, 700, 1300]) {
  test(`A8: the Comment button hides no words of the document (${theme}, ${width}px)`, async () => {
    const { page, errors } = await open({ width, theme });
    await say(page, { type: "commentsOffer", on: true });
    await say(page, { type: "comments", id: "ar_" + "4".repeat(16), version: 2, threads: [] });
    await pick(page, "two");
    await page.locator(".dgc-cm-add").waitFor({ state: "visible" });
    const c = await chip(page);
    await shot(page, `a8-comment-button-${theme.split("-")[0]}-${width}`);
    assert.deepEqual(c.over, [], "it lies over no words");
    assert.ok(c.left >= 0 && c.right <= c.wide, "and is whole inside the page");
    assert.ok(c.bottom > c.selTop - 40 && c.top < c.selBottom + 40, `it stands level with what was picked (${Math.round(c.top)} by ${Math.round(c.selTop)})`);
    assert.equal(c.radius, "6px"); assert.equal(Math.round(c.h), 28);
    assert.match(c.title, /^Comment on what you picked/, "it says what it is on hover");
    if (width >= 1300) assert.equal(c.words, true, "with its word where the margin has room");
    // It still opens the box, for the words picked.
    await page.locator(".dgc-cm-add").click();
    await page.locator(".dgc-cm-compose").waitFor({ state: "visible" });
    await page.keyboard.type("Why two?"); await page.keyboard.press("Control+Enter");
    assert.equal((await posted(page, "comments")).at(-1).anchor.quote, "two");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "nothing runs off the side");
    assert.deepEqual(errors, []);
    await page.close();
  });
}

test("A8: a comment's inline code is drawn as code, never as backticks", async () => {
  const { page, errors } = await open({ width: 700 });
  await say(page, { type: "commentsOffer", on: true });
  await say(page, { type: "comments", id: "ar_" + "4".repeat(16), version: 2, threads: [thread({ anchor: { kind: "text", quote: "two", before: "Billing is ", after: " small" },
    messages: [{ id: "m_a", by: "you", at: AT, text: "Which two?", kind: "comment" },
               { id: "m_b", by: "DGC", at: AT, text: "They are `billing/totals.py` and `tax.py`; a lone ` stays, and <b>this</b> is not markup.", kind: "answer" }] })] });
  await page.locator(".dgc-cm-thread").first().waitFor({ state: "visible" });
  const m = await page.evaluate(() => { const p = [...document.querySelectorAll(".dgc-cm-text")].at(-1);
    return { text: p.textContent, code: [...p.querySelectorAll("code")].map((c) => c.textContent), bold: p.querySelectorAll("b").length, mono: /mono/i.test(getComputedStyle(p.querySelector("code")).fontFamily) }; });
  await shot(page, "a8-comment-code-dark-700");
  assert.deepEqual(m.code, ["billing/totals.py", "tax.py"]);
  assert.equal(m.text, "They are billing/totals.py and tax.py; a lone ` stays, and <b>this</b> is not markup.");
  assert.equal(m.bold, 0, "a comment's text is never read as markup");
  assert.equal(m.mono, true, "in the code face");
  assert.deepEqual(errors, []);
  await page.close();
});
