import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";

// An iPhone photo (HEIC) pasted into the Work chat, in a REAL browser: Chromium can't draw one, so the
// chip names it rather than showing a broken picture, and a backend with capabilities.heic_images is sent
// it (through the spool) to turn into a JPEG. A backend without it gets nothing, and the person is told
// what to do in one sentence.
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, page;

before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; return; }
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
});
after(async () => { await browser?.close(); });

async function ready(capabilities) {
  await page.evaluate((caps) => {
    window.__posted = [];
    document.getElementById("input").replaceChildren();
    window.postMessage({ type: "event", event: { type: "ready", skills: [], custom_commands: [], capabilities: caps } }, "*");
  }, capabilities);
  await page.waitForTimeout(50);
}
async function pasteHeic(name, type) {
  await page.evaluate(([name, type]) => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63])], name, { type }));
    document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  }, [name, type]);
  await page.waitForTimeout(100);
}

test("a pasted iPhone photo is named in its chip and sent for the backend to make a JPEG", async (t) => {
  if (!browser) { if (process.env.DGC_REQUIRE_CHROMIUM) assert.fail("Chromium could not start"); t.skip("no Chromium"); return; }
  await ready({ image_spool: true, image_spool_dir: "/tmp/spool", heic_images: true });
  await pasteHeic("IMG_4417.HEIC", "image/heic");
  const chip = await page.evaluate(() => {
    const chip = document.querySelector("#attachments .image-att-chip");
    return chip && { img: !!chip.querySelector("img"), title: chip.title, caption: chip.querySelector(".image-caption")?.textContent };
  });
  assert.ok(chip, "the photo is attached");
  assert.equal(chip.img, false, "no broken picture: Chromium can't draw HEIC");
  assert.match(chip.title, /iPhone photo, sent as a JPEG/);
  assert.equal(chip.caption, "IMG_4417.HEIC", "its own file name, as every pasted image's chip shows");
  await page.evaluate(() => { document.getElementById("input").textContent = "What do I owe?"; });
  await page.keyboard.press("Enter").catch(() => {});
  await page.evaluate(() => document.getElementById("send")?.click());
  await page.waitForTimeout(100);
  const prompt = await page.evaluate(() => window.__posted.find((m) => m.type === "prompt"));
  assert.ok(prompt, "it is sent");
  assert.match(prompt.images[0], /^data:image\/heic;base64,/);
  const bubble = await page.evaluate(() => [...document.querySelectorAll(".msg.user .prompt-att")].map((n) => ({ title: n.title, img: !!n.querySelector("img") })));
  assert.deepEqual(bubble, [{ title: "An iPhone photo, sent as a JPEG", img: false }]);
});

test("a photo with no type but a .heic name is taken too, and a backend without HEIC gets one sentence", async (t) => {
  if (!browser) { if (process.env.DGC_REQUIRE_CHROMIUM) assert.fail("Chromium could not start"); t.skip("no Chromium"); return; }
  await ready({ image_spool: true, image_spool_dir: "/tmp/spool", heic_images: true });
  await page.evaluate(() => document.getElementById("attachments").replaceChildren());
  await pasteHeic("IMG_4418.heic", "");
  assert.equal(await page.evaluate(() => document.querySelectorAll("#attachments .image-att-chip").length) >= 1, true);
  await ready({ image_spool: true, image_spool_dir: "/tmp/spool" });
  const before = await page.evaluate(() => document.querySelectorAll("#attachments .image-att-chip").length);
  await pasteHeic("IMG_4419.HEIC", "image/heic");
  assert.equal(await page.evaluate(() => document.querySelectorAll("#attachments .image-att-chip").length), before, "not attached");
  assert.match(await page.evaluate(() => document.body.textContent), /Update DGC to send iPhone photos \(HEIC\), or send the photo as a JPEG\./);
});
