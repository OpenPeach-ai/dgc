import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { openWorkTab } from "./support/work-tab-scene.mjs";

// One prompt box, with attachment pills (0.52, UI step 3; the visual references of 7 Nov): a picture attaches as a pill
// (a small picture, its name, a remove button) that opens the picture large just above the box without moving the
// prompt; files dragged over the box show "Drop to attach"; an upload fills its pill from the left; Send turns into Stop,
// a square inside a spinning arc, while a reply runs. The same pieces in Work, ChatDGC and a Pip's chat.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};

function page(markup = `<div id="box" style="position:relative"></div>`) {
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/composer.js"));
  return dom;
}

test("a pill: a small picture or a file's icon, its name, a remove button; it fills as it uploads and says when it failed", () => {
  const dom = page(), { DgcComposer } = dom.window, removed = [], opened = [];
  const pic = DgcComposer.pill({ name: "Screenshot of the dispatch screen.png", src: "data:image/png;base64,iVBORw0KGgo=", classes: "chip image-att-chip",
    thumbClass: "image-tile", nameClass: "image-caption", removeClass: "x", onRemove: () => removed.push(1), onOpen: (n) => opened.push(n) });
  assert.ok(pic.matches(".dgc-att.chip.image-att-chip"), "the box's own hooks stay beside the shared ones");
  assert.ok(pic.querySelector(".dgc-att-thumb.image-tile img"));
  assert.equal(pic.querySelector(".dgc-att-name.image-caption").textContent, "Screenshot of the dispatch screen.png");
  pic.querySelector(".dgc-att-open").click(); assert.deepEqual(opened, [pic]);
  pic.querySelector(".dgc-att-x.x").click(); assert.deepEqual(removed, [1]);
  assert.equal(pic.querySelector(".dgc-att-x").getAttribute("aria-label"), "Remove Screenshot of the dispatch screen.png");
  const file = DgcComposer.pill({ name: "Q3 report.pdf", icon: "file-pdf", progress: 0.4 });
  assert.ok(file.querySelector(".codicon-file-pdf"), "a file's icon where a picture would be");
  assert.equal(file.dataset.progress, "40"); assert.equal(file.style.getPropertyValue("--dgc-progress"), "0.4");
  DgcComposer.setProgress(file, null);
  assert.equal(file.hasAttribute("data-progress"), false, "done: no fill");
  const failed = DgcComposer.pill({ name: "big.mov", failed: true });
  assert.ok(failed.hasAttribute("data-failed")); assert.match(failed.textContent, /Failed/);
});

test("Drop to attach while files are over the box, gone when they leave or drop; Stop is a square in an arc", () => {
  const dom = page(), { DgcComposer } = dom.window, box = dom.window.document.getElementById("box");
  DgcComposer.dropZone(box);
  const overlay = box.querySelector(".dgc-drop");
  const drag = (type, types = ["Files"]) => { const e = new dom.window.Event(type, { bubbles: true }); Object.defineProperty(e, "dataTransfer", { value: { types } }); box.dispatchEvent(e); };
  assert.equal(overlay.hidden, true);
  drag("dragenter"); assert.equal(overlay.hidden, false); assert.equal(overlay.textContent, "Drop to attach");
  drag("dragleave"); assert.equal(overlay.hidden, true);
  drag("dragenter", ["text/plain"]); assert.equal(overlay.hidden, true, "text being dragged is not an attachment");
  drag("dragenter"); drag("drop"); assert.equal(overlay.hidden, true);
  assert.match(DgcComposer.STOP, /<rect[^>]*>.*class="dgc-stop-arc"/s);
});

test("every page loads the prompt box's shared pieces", () => {
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/composer\.css"\);/);
  const panel = read("src/panel.ts");
  assert.ok(panel.indexOf('src="${composerJs}"') > 0 && panel.indexOf('src="${composerJs}"') < panel.indexOf('src="${js}"'), "Work: before main.js");
  const chat = read("src/chatdgc.ts");
  assert.ok(chat.indexOf('asset("media/shared/composer.js")') > 0 && chat.indexOf('asset("media/shared/composer.js")') < chat.indexOf('asset("media/chatdgc.js")'), "ChatDGC: before chatdgc.js");
  assert.match(read("src/pipsClient.js"), /import '\.\.\/media\/shared\/composer\.css';\nimport '\.\.\/media\/shared\/composer\.js';/);
});

// ---- Work's box, in Chromium
async function workWithPicture() {
  const s = await openWorkTab(browser, { width: 900, height: 760 });
  await s.page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 1200; canvas.height = 800;
    const g = canvas.getContext("2d"); g.fillStyle = "#3b82f6"; g.fillRect(0, 0, 1200, 800);
    const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
    const data = new DataTransfer(); data.items.add(new File([blob], "dispatch screen.png", { type: "image/png" }));
    document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await s.page.waitForFunction(() => document.querySelector("#attachments .dgc-att img")?.naturalWidth > 0);
  return s;
}

test("Work: a pasted picture is a pill; a click shows it large above the box without moving the prompt; Escape and × work", async (t) => {
  if (skipOrFail(t)) return;
  const s = await workWithPicture();
  try {
    const pill = await s.page.evaluate(() => { const p = document.querySelector("#attachments .dgc-att"), th = p.querySelector(".dgc-att-thumb").getBoundingClientRect();
      return { height: p.offsetHeight, thumb: [th.width, th.height], name: p.querySelector(".dgc-att-name").textContent, remove: !!p.querySelector(".dgc-att-x") }; });
    assert.deepEqual(pill, { height: 32, thumb: [24, 24], name: "dispatch screen.png", remove: true });
    const boxBefore = await s.page.evaluate(() => { const r = document.getElementById("cbox").getBoundingClientRect(); return [r.top, r.height]; });
    await s.page.click("#attachments .dgc-att-open");
    const island = await s.page.evaluate(() => { const i = document.querySelector("#cbox .dgc-att-preview"), box = document.getElementById("cbox").getBoundingClientRect();
      if (!i) return null; const r = i.getBoundingClientRect(), img = i.querySelector("img").getBoundingClientRect();
      return { above: r.bottom <= box.top + 0.5, imgHeight: Math.round(img.height), ratio: Math.round((img.width / img.height) * 10) / 10, box: [box.top, box.height] }; });
    assert.ok(island, "the picture opens in an island");
    assert.equal(island.above, true, "just above the box");
    assert.ok(island.imgHeight <= 300 && island.imgHeight > 100, `at most 300 px tall: ${island.imgHeight}`);
    assert.equal(island.ratio, 1.5, "in the picture's own shape");
    assert.deepEqual(island.box, boxBefore, "the prompt itself never moves");
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.evaluate(() => !!document.querySelector(".dgc-att-preview")), false, "Escape closes it");
    await s.page.click("#attachments .dgc-att-open");
    await s.page.mouse.click(20, 20);
    assert.equal(await s.page.evaluate(() => !!document.querySelector(".dgc-att-preview")), false, "a click elsewhere closes it");
    await s.page.click("#attachments .dgc-att-x");
    assert.equal(await s.page.evaluate(() => document.querySelectorAll("#attachments .dgc-att").length), 0, "× removes it");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("Work: files dragged over the box say Drop to attach; Send turns into Stop, a square in a spinning arc", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWorkTab(browser, { width: 900, height: 760 });
  try {
    const shown = () => s.page.evaluate(() => { const o = document.querySelector("#cbox .dgc-drop"); return o && !o.hidden ? o.textContent : ""; });
    const drag = (type, target = "#cfooter") => s.page.evaluate(([type, target]) => {
      const dt = new DataTransfer(); dt.setData("text/uri-list", "file:///home/me/notes.md");
      document.querySelector(target).dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
    }, [type, target]);
    await drag("dragenter");
    assert.equal(await shown(), "Drop to attach", "over the footer too, not only the text");
    await drag("dragleave");
    assert.equal(await shown(), "");
    await drag("dragenter"); await drag("drop");
    assert.equal(await shown(), "", "gone once dropped");
    assert.equal((await s.posted("drop_uris")).length, 1, "and the box took the file, dropped on its footer");
    await s.send({ type: "event", event: { type: "turn_start", turn_id: "t1", prompt: "Look at the login page", kind: "prompt" } });
    await s.page.waitForFunction(() => document.getElementById("send").getAttribute("aria-label") === "Stop generation");
    assert.equal(await s.page.evaluate(() => !!document.querySelector("#send svg.dgc-stop rect") && !!document.querySelector("#send .dgc-stop-arc")), true);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

// ---- ChatDGC's box: "+" in place of the paperclip (U3), the same pills, island, overlay and Stop
import { openChat, conversation } from "./support/chat-scene.mjs";
test("ChatDGC: + opens the menu (Files and folders as @, the Library, Upload); a pasted picture is a pill that opens above the box; drop and Stop", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openChat(browser, { width: 900, height: 700 });
  try {
    await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    assert.equal(await s.page.locator("#cd-attach .codicon-add").count(), 1, "a +, not a paperclip");
    await s.page.click("#cd-attach");
    assert.deepEqual(await s.page.locator("#cd-add-menu .dgc-menu-row").evaluateAll((rows) => rows.map((r) => r.dataset.add)), ["files", "library", "upload"]);
    assert.equal(await s.page.locator("#cd-add-menu kbd").textContent(), "@");
    assert.equal((await s.posted("attach")).length, 0, "opening + asks for no file window");
    await s.page.locator('#cd-add-menu [data-add="files"]').click();
    assert.match(await s.page.evaluate(() => document.getElementById("cd-input").textContent), /@$/, "Files and folders types @, the list Work uses");
    await s.page.click("#cd-attach");
    await s.page.locator('#cd-add-menu [data-add="upload"]').click();
    assert.deepEqual((await s.posted("attach")).map((m) => m.from), ["upload"], "the file window only when asked");
    await s.page.evaluate(async () => {
      const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 600;
      canvas.getContext("2d").fillRect(0, 0, 900, 600);
      const blob = await new Promise((done) => canvas.toBlob(done, "image/png"));
      const data = new DataTransfer(); data.items.add(new File([blob], "receipt.png", { type: "image/png" }));
      document.getElementById("cd-input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await s.page.waitForFunction(() => document.querySelector("#cd-chips .dgc-att img")?.naturalWidth > 0);
    const box = () => s.page.evaluate(() => { const r = document.getElementById("cd-box").getBoundingClientRect(); return [r.top, r.height]; });
    const before = await box();
    await s.page.click("#cd-chips .dgc-att-open");
    const above = await s.page.evaluate(() => { const i = document.querySelector("#cd-box .dgc-att-preview"); return i && i.getBoundingClientRect().bottom <= document.getElementById("cd-box").getBoundingClientRect().top + 0.5; });
    assert.equal(above, true, "the picture opens just above the box");
    assert.deepEqual(await box(), before, "the prompt never moves");
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.locator(".dgc-att-preview").count(), 0);
    await s.page.evaluate(() => { const dt = new DataTransfer(); dt.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
      document.getElementById("cd-log").dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true })); });
    assert.equal(await s.page.evaluate(() => { const o = document.querySelector("#cd-box .dgc-drop"); return o && !o.hidden ? o.textContent : ""; }), "Drop to attach",
      "files over the tab: the box says it takes them");
    assert.equal(await s.page.evaluate(() => !!document.querySelector("#cd-stop svg.dgc-stop .dgc-stop-arc")), true, "Stop is a square in a spinning arc");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
