// A picture in a ChatDGC chat (asked 18 Nov): a click opens it large in a pop-up inside the chat (it used to grow in
// place), with Download (saved by the page on the person's own computer), Save to Library (kept by you, "In Library"
// once it is there: capabilities.chatdgc.library_picture) and Open in editor (the old way, now second). A made file's
// Save a copy is a download too. The document src/chatdgc.ts serves, with its own scripts, in real Chromium; what it
// posts is what the extension host would receive. Pictures of it are kept for the report.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { THEMES } from "./support/options-scene.mjs";
import { readStylesheet } from "./support/stylesheet.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });
const PICTURES = process.env.DGC_PICTURES_DIR || `${tmpdir()}/dgc-test-pictures`;

const ID = `chat_${"a".repeat(32)}`;
const M = (n) => `msg_${String(n).repeat(32).slice(0, 32)}`;
const ATT = (c) => `att_${c.repeat(32)}`;
let cached;
function screenHtml() {
  if (cached) return cached;
  const source = readFileSync(join(root, "src/chatdgc.ts"), "utf8");
  const page = source.match(/return `(<!doctype html>[\s\S]*?<\/html>)`;/)[1];
  const doc = page.replace(/<link [^>]*>/g, "").replace(/<script [^>]*><\/script>/g, "").replace(/\$\{[^}]*\}/g, "").replace("font-src ;", "font-src data:;");
  const codicon = readFileSync(join(root, "media/codicon.css"), "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(join(root, "media/codicon.ttf")).toString("base64")}")`);
  const css = readStylesheet(join(root, "media/main.css")).replace(/@import[^;]*;/, "");
  const own = ["media/mentions.css", "media/trace.css", "media/chatdgc.css"].map((f) => readFileSync(join(root, f), "utf8")).join("\n");
  // The page's own scripts, in the order chatdgc.ts loads them (download.js and picturepop.js among them).
  const scripts = [...page.matchAll(/asset\("media\/((?:shared\/)?[\w-]+\.js)"\)/g)].map((m) => m[1]);
  const js = scripts.map((f) => readFileSync(join(root, "media", f), "utf8")).join("\n");
  const markdownJs = buildSync({ entryPoints: [join(root, "src/markdown.ts")], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  cached = { html: doc.replace("</head>", `<style>${codicon}</style><style>${css}</style><style>${own}</style></head>`), js, markdownJs, scripts };
  return cached;
}
async function openScreen({ width = 700, height = 760, theme = "dark-modern" } = {}) {
  const { html, js, markdownJs } = screenHtml();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([code, md]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(md + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(code);
  }, [js, markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => !t || m.type === t), type);
  return { page, send, posted, errors, close: () => context.close() };
}
const drawn = (hue) => `(() => { const c = document.createElement("canvas"); c.width = 640; c.height = 420; const g = c.getContext("2d");
  g.fillStyle = "hsl(${hue},60%,55%)"; g.fillRect(0, 0, 640, 420); g.fillStyle = "rgba(255,255,255,.85)"; g.beginPath(); g.arc(320, 210, 80, 0, 7); g.fill(); return c.toDataURL("image/png"); })()`;
const conversation = { id: ID, title: "Cafe fronts", model: null, thinking: null, pinned: false, archived: false, temporary: false };
const at = "2026-11-18T10:00:00.000Z";
async function chat(s, { library = true } = {}) {
  await s.send({ type: "libraryOffered", on: library });
  await s.send({ type: "opened", conversation, earlier: 0, busy: false, messages: [
    { id: M(1), role: "user", text: "Make two café fronts", created_at: at, attachments: [{ id: ATT("c"), kind: "image", name: "sketch.png", size: 2048 }] },
    { id: M(2), role: "assistant", text: "Here are two.", created_at: at, finish: "stop", model: "m",
      files: [{ id: ATT("a"), kind: "image", name: "cafe-1.png", format: "png", size: 48213, prompt: "a café front" },
              { id: ATT("b"), kind: "image", name: "cafe-2.png", format: "png", size: 51200, prompt: "a café front" },
              { id: ATT("d"), kind: "file", name: "menu.pdf", format: "pdf", size: 9000 }] }] });
  const asked = new Set((await s.posted("image")).map((m) => m.id));
  for (const [id, hue] of [[ATT("a"), 30], [ATT("b"), 200], [ATT("c"), 120]]) if (asked.has(id)) await s.send({ type: "image", id, data: await s.page.evaluate(drawn(hue)) });
}

test("a picture opens large in the chat with Download, Save to Library and Open in editor; Download saves from the page", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await chat(s);
    await s.page.click(`.cd-file-image:has(.cd-thumb[data-att="${ATT("a")}"]) .cd-file-open`);
    const pop = s.page.locator(".dgc-picpop");
    assert.equal(await pop.count(), 1, "a pop-up over the chat, not the picture growing in place");
    assert.equal(await s.page.textContent(".dgc-picpop-name"), "cafe-1.png");
    assert.equal(await s.page.textContent(".dgc-picpop-meta"), "47 KB · 1 of 2", "the reply's two pictures");
    assert.deepEqual(await s.page.$$eval(".dgc-picpop-acts button:not([hidden])", (bs) => bs.map((b) => b.getAttribute("aria-label"))), ["Download", "Save to Library", "Open in editor", "Close"]);
    // One action, one icon: the pop-up's Download is the card's Save a copy (the arrow into a tray, the icon module's own).
    const glyphs = await s.page.evaluate(() => { const g = (svg) => svg ? [svg.dataset.icon || "", [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|")] : null;
      return [g(document.querySelector(".cd-file .cd-file-save svg")), g(document.querySelector('.dgc-picpop [data-act="download"] svg'))]; });
    assert.deepEqual(glyphs[1], glyphs[0], "the same Download glyph on the card and in the pop-up");
    assert.equal(glyphs[0]?.[0], "download");
    const caught = s.page.waitForEvent("download");
    await s.page.click('.dgc-picpop [data-act="download"]');
    const download = await caught;
    assert.equal(download.suggestedFilename(), "cafe-1.png");
    assert.deepEqual([...readFileSync(await download.path()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47], "the picture itself");
    assert.equal((await s.posted("fileSave")).length, 0, "nothing asked of the host: the page had it");
    await s.page.keyboard.press("ArrowRight");
    assert.equal(await s.page.textContent(".dgc-picpop-name"), "cafe-2.png");
    try { mkdirSync(PICTURES, { recursive: true }); await s.page.screenshot({ path: `${PICTURES}/chatdgc-popup-700.png` }); } catch { /* still checked */ }
    await s.page.click('.dgc-picpop [data-act="editor"]');
    assert.deepEqual((await s.posted("fileOpen")).map((m) => [m.messageId, m.fileId]), [[M(2), ATT("b")]], "Open in editor: the old way");
    await s.page.keyboard.press("Escape");
    assert.equal(await pop.count(), 0);
    // A picture you attached opens the same way.
    await s.page.click(`.cd-thumb-card button.cd-thumb[data-att="${ATT("c")}"]`);
    assert.equal(await s.page.textContent(".dgc-picpop-name"), "sketch.png");
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test("Save to Library on a picture's card and in its pop-up: asked once, kept once, then In Library (off)", async (t) => {
  if (skipOrFail(t)) return;
  for (const [theme, width] of [["dark-modern", 300], ["light-modern", 440], ["dark-modern", 700]]) {
    const s = await openScreen({ theme, width });
    try {
      await chat(s);
      const checks = (await s.posted("libraryPicture")).filter((m) => !m.keep).map((m) => m.fileId).sort();
      assert.deepEqual(checks, [ATT("a"), ATT("b")], "each made picture asked once whether it is there");
      await s.send({ type: "libraryPicture", fileId: ATT("b"), in_library: true, kept: false });
      const lib = (id) => s.page.locator(`.dgc-doc-lib[data-lib-id="${id}"]`);
      assert.equal(await lib(ATT("b")).getAttribute("aria-label"), "In Library");
      assert.equal(await lib(ATT("b")).isDisabled(), true, "a picture DGC made is in the Library already");
      assert.equal(await lib(ATT("a")).getAttribute("aria-label"), "Save to Library");
      assert.equal(await lib(ATT("a")).evaluate((b) => b.querySelector("svg")?.dataset.icon), "library");
      try { mkdirSync(PICTURES, { recursive: true }); await s.page.locator(`.cd-file:has([data-lib-id="${ATT("a")}"])`).screenshot({ path: `${PICTURES}/chatdgc-card-${theme}-${width}.png` }); } catch { /* still checked */ }
      await lib(ATT("a")).click();
      assert.deepEqual((await s.posted("libraryPicture")).filter((m) => m.keep).map((m) => m.fileId), [ATT("a")]);
      await s.send({ type: "libraryPicture", fileId: ATT("a"), in_library: true, kept: true });
      assert.equal(await lib(ATT("a")).getAttribute("aria-label"), "In Library");
      assert.equal(await lib(ATT("a")).isDisabled(), true);
      await s.page.click(`.cd-file-image:has(.cd-thumb[data-att="${ATT("a")}"]) .cd-file-open`);
      assert.equal(await s.page.locator('.dgc-picpop [data-act="library"]').getAttribute("aria-label"), "In Library", "the pop-up says so too");
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
});

test("an older DGC offers no Save to Library: no button, nothing asked", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await chat(s, { library: false });
    assert.equal(await s.page.locator(".dgc-doc-lib").count(), 0);
    assert.deepEqual(await s.posted("libraryPicture"), []);
    await s.page.click(`.cd-file-image:has(.cd-thumb[data-att="${ATT("a")}"]) .cd-file-open`);
    assert.equal(await s.page.locator('.dgc-picpop [data-act="library"]').isHidden(), true);
  } finally { await s.close(); }
});

test("a made file's Save a copy is a download: the host hands the page the file, and \"Downloaded\" is said beside it", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openScreen();
  try {
    await chat(s);
    const save = s.page.locator(`.cd-file:has-text("menu.pdf") .cd-file-save`);
    await save.click();
    assert.deepEqual((await s.posted("fileSave")).map((m) => [m.fileId, m.name, !!m.project]), [[ATT("d"), "menu.pdf", false]]);
    const caught = s.page.waitForEvent("download");
    await s.page.evaluate(() => window.postMessage({ type: "dgcDownload", name: "menu.pdf", mime: "application/pdf", data: new TextEncoder().encode("%PDF-1.7") }, "*"));
    assert.equal((await caught).suggestedFilename(), "menu.pdf");
    const [said, button] = [await s.page.locator(".dgc-download-said").boundingBox(), await save.boundingBox()];
    assert.equal(await s.page.textContent(".dgc-download-said"), "Downloaded");
    assert.ok(Math.abs(said.y + said.height - button.y) < 16, "beside the button it was asked from");
  } finally { await s.close(); }
});
