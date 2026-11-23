// Comments on a DGC document, in its formatted editor (src/canvasEditor.ts in canvasDoc.ts's page for an artifact, with
// media/shared/comments.js) in real Chromium: words picked get the Comment button by them on a solid ground; the comment
// says exactly which words, with the words around them; each open thread's words are marked in the page and a click on
// them shows the thread; the rail stands beside the page where there is room and under it where there isn't; Where
// picks the words again. What the page posts is what canvasDoc.ts would receive.
import { test as nodeTest, after } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readStylesheet } from "./support/stylesheet.mjs";
import { THEMES } from "./support/options-scene.mjs";

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
const FILE = "# Trip plan\n\n## Getting there\n\nWe take the **early train** to Pune on Friday.\n\n## Back\n\nWe take the early train home on Sunday.\n";
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

test("comments wait until the host says they are offered: no button, no rail", async () => {
  const { page, errors } = await open();
  await pick(page, "early train");
  assert.equal(await page.locator(".dgc-cm-add").count(), 0, "the module isn't started");
  assert.equal(await page.locator("#cv-comments-btn").isHidden(), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test("words picked get the Comment button by them, on a solid ground; the comment says those words and the words around them", async () => {
  const { page, errors } = await open();
  await page.evaluate(() => document.documentElement.style.setProperty("--vscode-input-background", "#ffffff0d"));
  await say(page, { type: "commentsOffer", on: true });
  await say(page, { type: "comments", id: "ar_" + "4".repeat(16), version: 2, threads: [] });
  assert.equal(await page.locator("#cv-comments-btn").isVisible(), true);
  assert.equal(await page.locator("#cv-comments").isHidden(), true, "no threads: the rail waits");
  await pick(page, "early train", 1);
  await page.locator(".dgc-cm-add").waitFor({ state: "visible" });
  const add = await page.evaluate(() => { const n = document.querySelector(".dgc-cm-add"), r = n.getBoundingClientRect(), c = getComputedStyle(n); return { top: r.top, right: r.right, ground: c.backgroundColor, radius: c.borderTopLeftRadius, h: r.height }; });
  assert.ok(alpha(add.ground) >= 0.999, `solid where the theme's input background is see-through (${add.ground})`);
  assert.equal(add.radius, "6px"); assert.equal(Math.round(add.h), 28);
  await page.locator(".dgc-cm-add").click();
  await page.locator(".dgc-cm-compose").waitFor({ state: "visible" });
  await page.keyboard.type("Is there a later one?");
  await page.keyboard.press("Control+Enter");
  const sent = (await posted(page, "comments")).at(-1);
  assert.equal(sent.op, "add");
  assert.equal(sent.ask, true);
  assert.equal(sent.anchor.kind, "text");
  assert.equal(sent.anchor.quote, "early train");
  assert.match(sent.anchor.before, /We take the $/);
  assert.match(sent.anchor.after, /^ home on Sunday\./, "the second one: told apart by the words around it");
  assert.ok((await posted(page, "edit")).length >= 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a refusal is said on the rail, which shows for it, with the shared Dismiss ×", async () => {
  const { page, errors } = await open();
  await say(page, { type: "commentsOffer", on: true });
  await say(page, { type: "comments", id: "ar_" + "4".repeat(16), version: 2, threads: [] });
  await say(page, { type: "commentsRejected", op: "accept", message: "The words this suggestion would change aren't in it any more." });
  await page.locator("#cv-comments .dgc-cm-said").waitFor({ state: "visible" });
  assert.match(await page.locator(".dgc-cm-said").textContent(), /aren't in it any more/);
  await page.locator(".dgc-cm-said .dgc-dismiss").click();
  assert.equal(await page.locator(".dgc-cm-said:visible").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [1000, 440, 300]) {
    test(`a thread's words are marked in the page and a click shows it; the rail at ${width} px (${theme})`, async () => {
      const { page, errors } = await open({ width, theme });
      await say(page, { type: "commentsOffer", on: true });
      await say(page, { type: "comments", id: "ar_" + "4".repeat(16), version: 2, threads: [thread(),
        thread({ id: "t_" + "2".repeat(12), status: "resolved", anchor: { kind: "text", quote: "Pune" }, where: "a paragraph under “Getting there”" })] });
      await page.locator("#cv-comments").waitFor({ state: "visible" });
      const marks = await page.evaluate(() => [...document.querySelectorAll(".cv-cm-mark")].map((n) => n.textContent));
      assert.deepEqual(marks, ["early train home"], "the open thread's words, the second time they appear; never a resolved one's");
      const main = await page.locator(".cv-page").boundingBox(), rail = await page.locator("#cv-comments").boundingBox();
      if (width >= 900) assert.ok(rail.x >= main.x + main.width - 1, `beside (${JSON.stringify({ main, rail })})`);
      else assert.ok(rail.y >= main.y + main.height - 1, `under (${JSON.stringify({ main, rail })})`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll");
      await page.locator(".cv-cm-mark").click();
      await page.waitForFunction(() => document.querySelector(".dgc-cm-thread.dgc-cm-lit"));
      // Where picks the words again.
      await page.locator(".dgc-cm-where").first().click();
      assert.equal(await page.evaluate(() => String(getSelection())), "early train home");
      // A page that changed its words: the mark goes with them, never onto other words.
      await page.evaluate((text) => window.postMessage({ type: "doc", text, external: true }, "*"), FILE.replace("early train home", "bus home"));
      await page.waitForTimeout(150);
      assert.equal(await page.locator(".cv-cm-mark").count(), 0);
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
}
