// A picture in a Work session (asked 18 Nov): Download in its viewer saves it on the computer the editor runs on, from
// the page itself (media/shared/download.js), and Save to Library keeps it in DGC's Library (ready.capabilities
// .library_picture: Work's `library_picture` by the picture's ref), "In Library" (off) once it is there, so nothing is kept
// twice: a picture DGC made says so from the start. Beside a made picture's Save to project… and in its viewer. Real
// Chromium on Work's own page (src/panel.ts's document, media/main.css, the page's scripts). Pictures kept for the report.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { readStylesheet } from "./support/stylesheet.mjs";
import { mainJs } from "./support/webview-dom.mjs";

const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, html, markdownJs;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
const PICTURES = process.env.DGC_PICTURES_DIR || `${tmpdir()}/dgc-test-pictures`;
const LIGHT = `--vscode-sideBar-background:#F8F8F8; --vscode-editor-background:#FFFFFF; --vscode-input-background:#FFFFFF; --vscode-panel-border:#E5E5E5;
  --vscode-widget-border:#E5E5E5; --vscode-input-border:#CECECE; --vscode-foreground:#3B3B3B; --vscode-editor-foreground:#1F1F1F;
  --vscode-descriptionForeground:#616161; --vscode-disabledForeground:#6E6E6E; --vscode-list-activeSelectionBackground:#E8E8E8; --vscode-focusBorder:#005FB8;`;

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; return; }
  const panelSrc = readFileSync(here + "/../src/panel.ts", "utf8");
  const css = readStylesheet(here + "/../media/main.css");
  const codicon = readFileSync(here + "/../media/codicon.css", "utf8")
    .replace(/url\([^)]*codicon\.ttf[^)]*\)/, `url("data:font/ttf;base64,${readFileSync(here + "/../media/codicon.ttf").toString("base64")}")`);
  markdownJs = buildSync({ entryPoints: [here + "/../src/markdown.ts"], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0]).find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  html = skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`);
});
after(async () => { await browser?.close(); });

async function openPanel(width, { theme = "dark", library = true } = {}) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${theme === "light" ? LIGHT : ""} }
    body { background: var(--bg); color: var(--text); }` });
  await page.evaluate(([mjs, mdjs, cls]) => {
    window.__posts = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posts.push(m); }, getState: () => undefined, setState() {} });
    document.body.classList.add(cls);
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [readFileSync(here + "/../media/shared/filemenu.js", "utf8") + "\n" + mainJs, markdownJs, theme === "light" ? "vscode-light" : "vscode-dark"]);   // (the file menu, as the real page loads it)
  const events = (list) => page.evaluate(async (items) => {
    for (const event of items) { window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event } })); await new Promise((d) => setTimeout(d, 2)); }
  }, list);
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 80)))));
  await events([{ type: "ready", capabilities: { image_views: true, history_snapshot: true, ...(library ? { library_picture: 1 } : {}) }, model: "qwen3-vl:8b",
    mode: "default", think: "off", commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" }]);
  const posts = (type) => page.evaluate((t) => window.__posts.filter((m) => m.type === t), type);
  return { page, events, settle, posts, close: () => context.close() };
}
const png = (page) => page.evaluate(() => { const c = document.createElement("canvas"); c.width = 384; c.height = 160; const g = c.getContext("2d");
  g.fillStyle = "#c2410c"; g.fillRect(0, 0, 384, 160); g.fillStyle = "#fde68a"; g.beginPath(); g.arc(192, 80, 50, 0, 7); g.fill(); return c.toDataURL("image/png"); });
const REF = "img_" + "a".repeat(32);
const turn = (data) => [
  { type: "turn_start", turn_id: "t1", prompt: "Make a banner of a fox barista", kind: "prompt" },
  { type: "tool_call", call_id: "g1", name: "generate_image", args: { prompt: "a fox barista" }, summary: "ComfyUI · 1 × 768x320 · free" },
  { type: "tool_images", call_id: "g1", caption: "generated image", images: [data],
    items: [{ ref: REF, name: "a-fox-barista.png", mime: "image/png", width: 384, height: 160, bytes: 4000, source: "view_image", host: "" }] },
  { type: "tool_result", call_id: "g1", name: "generate_image", output: "Made 1 image with ComfyUI · 768×320 · free", is_error: false, is_diff: false },
  { type: "text_delta", text: "Made the banner." },
  { type: "stream_end", message_id: "t1:2", phase: "answer" },
  { type: "turn_end", turn_id: "t1", reason: "completed", token_estimate: 0, final_message_id: "t1:2" },
];
const answer = async (x, keep, fields) => {
  const asked = (await x.posts("libraryPicture")).filter((m) => m.keep === keep && !m.__answered);
  for (const m of asked) await x.events([{ type: "library_picture", request_id: m.requestId, ...fields }]);
  await x.settle();
  return asked;
};

test("a made picture shows Save to Library beside Save to project…; a picture DGC made is In Library from the start", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark", "light"]) {
    const x = await openPanel(440, { theme });
    try {
      await x.events(turn(await png(x.page)));
      await x.settle();
      const lib = x.page.locator(".made-pictures .made-image-lib");
      assert.equal(await lib.count(), 1, "one Save to Library on the made picture");
      const asked = await answer(x, false, { in_library: true, kept: false, title: "a fox barista" });
      assert.deepEqual(asked.map((m) => m.ref), [REF], "asked once, by the picture's ref, whether it is in the Library");
      assert.equal(await lib.getAttribute("aria-label"), "In Library");
      assert.equal(await lib.isDisabled(), true, "made by DGC: in the Library already, nothing kept twice");
      assert.equal(await lib.evaluate((b) => b.querySelector("svg")?.dataset.icon), "library");
      try { mkdirSync(PICTURES, { recursive: true }); await x.page.locator(".made-pictures").screenshot({ path: `${PICTURES}/work-made-picture-${theme}-440.png` }); } catch { /* still checked */ }
    } finally { await x.close(); }
  }
});

test("in the viewer: Download saves it on this computer from the page; Save to Library keeps it once, then In Library", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPanel(700);
  try {
    await x.events(turn(await png(x.page)));
    await x.settle();
    await answer(x, false, { in_library: false, kept: false });
    await x.page.click(".made-pictures .image-chip");
    await x.settle();
    const viewer = x.page.locator("#image-viewer");
    assert.equal(await viewer.locator(".iv-save").getAttribute("aria-label"), "Download");
    assert.equal(await viewer.locator(".iv-open").getAttribute("aria-label"), "Open in editor");
    const lib = viewer.locator(".iv-library");
    assert.equal(await lib.getAttribute("aria-label"), "Save to Library");
    const caught = x.page.waitForEvent("download");
    await viewer.locator(".iv-save").click();
    const download = await caught;
    assert.equal(download.suggestedFilename(), "a-fox-barista.png");
    assert.deepEqual([...readFileSync(await download.path()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
    assert.equal((await x.posts("saveImage")).length, 0, "nothing asked of the host: no save dialog");
    await lib.click();
    const keep = (await x.posts("libraryPicture")).filter((m) => m.keep === true);
    assert.deepEqual(keep.map((m) => m.ref), [REF]);
    await x.events([{ type: "library_picture", request_id: keep[0].requestId, in_library: true, kept: true, title: "a-fox-barista" }]);
    await x.settle();
    assert.equal(await lib.getAttribute("aria-label"), "In Library");
    assert.equal(await lib.isDisabled(), true);
    assert.equal(await x.page.locator(".made-pictures .made-image-lib").getAttribute("aria-label"), "In Library", "the row says so too");
    try { mkdirSync(PICTURES, { recursive: true }); await x.page.screenshot({ path: `${PICTURES}/work-viewer-700.png` }); } catch { /* still checked */ }
  } finally { await x.close(); }
});

// One action, one icon (16 Nov): the viewer's Download is the arrow into a tray a file's row wears; and a note saying
// what happened ("Saved to Library") takes the hover label's place, never both at once (his review of the viewer, 18 Nov).
test("the viewer's Download is the row's Download glyph, and a note never stands beside a hover label", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPanel(700);
  try {
    await x.events(turn(await png(x.page)));
    await x.settle();
    await answer(x, false, { in_library: false, kept: false });
    await x.page.click(".made-pictures .image-chip");
    await x.settle();
    await x.page.addScriptTag({ content: readFileSync(here + "/../media/shared/filesheet.js", "utf8") });
    const seen = await x.page.evaluate(() => {
      const glyph = (svg) => svg ? [svg.dataset.icon || "", [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|")] : null;
      const box = document.createElement("div"); box.innerHTML = window.DgcFileSheet.DOWNLOAD;
      return { viewer: glyph(document.querySelector("#image-viewer .iv-save svg")), row: glyph(box.querySelector("svg")),
               font: !!document.querySelector("#image-viewer .iv-save .codicon") };
    });
    assert.deepEqual(seen.viewer, ["download", "M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13h10"]);
    assert.deepEqual(seen.viewer, seen.row, "the same drawing as a file's row");
    assert.equal(seen.font, false, "not the font's monitor-and-arrow");
    // Download pressed ("Downloaded"), then the pointer rests on it until its label shows; Save to Library is pressed from
    // the keyboard.
    const caught = x.page.waitForEvent("download");
    await x.page.click("#image-viewer .iv-save");
    await caught;
    await x.page.mouse.move(5, 300);
    // (No label while "Downloaded" stands; then, resting on Download, its label shows.)
    await x.page.hover("#image-viewer .iv-save"); await x.page.waitForTimeout(900);
    assert.equal(await x.page.locator("#hover-tip:not([hidden])").count(), 0, "no label while Downloaded stands");
    await x.page.waitForTimeout(1200);
    await x.page.mouse.move(5, 300);
    await x.page.hover("#image-viewer .iv-save");
    await x.page.waitForSelector("#hover-tip:not([hidden])", { timeout: 3000 });
    await x.page.evaluate(() => document.querySelector("#image-viewer .iv-library").click());
    const keep = (await x.posts("libraryPicture")).filter((m) => m.keep === true);
    await x.events([{ type: "library_picture", request_id: keep[0].requestId, in_library: true, kept: true, title: "a-fox-barista" }]);
    await x.page.waitForFunction(() => [...document.querySelectorAll(".dgc-file-said")].some((n) => n.textContent === "Saved to Library"), null, { timeout: 3000 });
    assert.deepEqual(await x.page.locator(".dgc-file-said").allTextContents(), ["Saved to Library"], "one note at a time: it takes Downloaded's place");
    assert.equal(await x.page.locator("#hover-tip:not([hidden])").count(), 0, "the label hides while the note stands");
    try { await x.page.screenshot({ path: `${PICTURES}/work-viewer-saved-700.png` }); } catch { /* still checked */ }
    await x.page.mouse.move(5, 300); await x.page.hover("#image-viewer .iv-close"); await x.page.waitForTimeout(900);
    assert.equal(await x.page.locator("#hover-tip:not([hidden])").count(), 0, "and none comes back over it while it stands");
  } finally { await x.close(); }
});

test("a DGC without library_picture shows no Save to Library and asks nothing of it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPanel(700, { library: false });
  try {
    await x.events(turn(await png(x.page)));
    await x.settle();
    assert.equal(await x.page.locator(".made-image-lib").count(), 0);
    await x.page.click(".made-pictures .image-chip");
    await x.settle();
    assert.equal(await x.page.locator("#image-viewer .iv-library").isHidden(), true);
    assert.deepEqual(await x.posts("libraryPicture"), []);
  } finally { await x.close(); }
});
