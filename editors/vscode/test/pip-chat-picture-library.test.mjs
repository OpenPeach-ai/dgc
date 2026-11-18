// A picture in a Pip's chat (his asks, 18 Nov): a click opens it large in a pop-up inside the chat (not an editor tab),
// with Download, Save to Library and Open in editor; Download on its row saves on the person's own computer (the host
// hands the page the original, media/shared/download.js); Save to Library keeps it in the Library (Pips API 108,
// library_pip_message_image), "In Library" (off) for one already there, so nothing is kept twice; an older DGC (before
// 108) shows no Save to Library. The real bundled page in real Chromium, in the side bar (a shadow root inside Work's
// page) and in an editor tab, with the stub host of support/pip-chat-scene.mjs. Pictures of it are kept for the report.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
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
const PICTURES = process.env.DGC_PICTURES_DIR || `${homedir()}/dgc-work/052-plan/image-popup-build/pictures`;
// The chat of a Pip that sends what it made (Pips API 101's scene): its reply "a1" carries a picture.
const open = (opts = {}) => openChat(browser, { width: 700, height: 820, api: 108, convs: true, details: true, sent: true, library: { held: [] }, ...opts });
const sent = (x, type) => x.p.evaluate((t) => (window.__sent || []).filter((r) => r.type === t), type);
const posted = (x, type) => x.p.evaluate((t) => (window.__posted || []).filter((m) => m.type === t), type);

test("a click on a picture opens it large in the chat with Download, Save to Library and Open in editor; never an editor tab", async (t) => {
  if (skipOrFail(t)) return;
  for (const where of ["side", "tab"]) {
    const x = await open({ where, width: where === "side" ? 440 : 700 });
    try {
      await x.p.waitForSelector('img[data-message-image="a1:0"][src]');
      await x.p.click('img[data-message-image="a1:0"]');
      await x.p.waitForSelector(".dgc-picpop");
      assert.equal(await x.p.textContent(".dgc-picpop-name"), "Picture 1.png");
      const acts = await x.p.$$eval(".dgc-picpop-acts button:not([hidden])", (bs) => bs.map((b) => b.getAttribute("aria-label")));
      assert.deepEqual(acts, ["Download", "Save to Library", "Open in editor", "Close"], where);
      // Styled where it is drawn (a shadow root in the side bar): the dim backdrop is there.
      assert.equal(await x.p.$eval(".dgc-picpop", (e) => getComputedStyle(e).position), "fixed", `${where}: its styles reach it`);
      // One action, one icon: the pop-up's Download is the row's (the arrow into a tray, the icon module's own).
      const glyphs = await x.p.evaluate(() => { const r = window.__pipsRoot || document, g = (svg) => svg ? [svg.dataset.icon || "", [...svg.querySelectorAll("path")].map((p) => p.getAttribute("d")).join("|")] : null;
        return [g(r.querySelector('button[data-message-download="a1:0"] svg')), g(r.querySelector('.dgc-picpop [data-act="download"] svg'))]; });
      assert.deepEqual(glyphs[1], glyphs[0], `${where}: the same Download glyph on the row and in the pop-up`);
      assert.equal(glyphs[0]?.[0], "download");
      const asked = await posted(x, "pipsOpenPhoto");
      assert.deepEqual(asked.map((m) => [m.message_id, m.index, m.view === true, m.save === true]), [["a1", 0, true, false]], "only the original asked for, to show");
      await x.p.waitForFunction(() => { const r = window.__pipsRoot || document; const img = r.querySelector(".dgc-picpop-img"); return img && img.naturalWidth >= 480; });
      if (where === "side") { try { mkdirSync(PICTURES, { recursive: true }); await x.p.screenshot({ path: `${PICTURES}/pip-chat-popup-440.png` }); } catch { /* still checked */ } }
      await x.p.click('.dgc-picpop [data-act="editor"]');
      const editor = (await posted(x, "pipsOpenPhoto")).at(-1);
      assert.deepEqual([editor.index, !!editor.view, !!editor.save], [0, false, false], "Open in editor: the old way");
      await x.p.keyboard.press("Escape");
      assert.equal(await x.p.locator(".dgc-picpop").count(), 0);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("Download on a picture's row asks the host for the original, and the page saves it on this computer", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab" });
  try {
    await x.p.click('button[data-message-download="a1:0"]');
    const asked = (await posted(x, "pipsOpenPhoto")).at(-1);
    assert.deepEqual([asked.message_id, asked.index, asked.save], ["a1", 0, true]);
    // The host's answer (src/pipsView.ts openPhoto): the bytes, which this page saves itself, "Downloaded" beside the row.
    const caught = x.p.waitForEvent("download");
    await x.p.evaluate(() => window.postMessage({ type: "dgcDownload", name: "Picture 1.png", mime: "image/png", data: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) }, "*"));
    assert.equal((await caught).suggestedFilename(), "Picture 1.png");
    assert.equal(await x.p.textContent(".dgc-download-said"), "Downloaded");
  } finally { await x.close(); }
});

test("Save to Library: each picture asked once; one already there says In Library (off); another is kept once, then says so", async (t) => {
  if (skipOrFail(t)) return;
  for (const [theme, width] of [["dark", 300], ["light", 440], ["dark", 700]]) {
    const x = await open({ where: "side", theme, width, library: { held: [] } });
    try {
      await x.p.waitForSelector('button[data-message-library="a1:0"]');
      const lib = x.p.locator('button[data-message-library="a1:0"]');
      assert.equal(await lib.getAttribute("aria-label"), "Save to Library");
      const checks = await sent(x, "library_pip_message_image");
      assert.deepEqual(checks.map((r) => [r.message_id, r.index, r.keep]), [["a1", 0, false]], "asked once whether it is there");
      // Beside Download, the same size, the Library's glyph.
      const [dl, kb] = [await x.p.locator('button[data-message-download="a1:0"]').boundingBox(), await lib.boundingBox()];
      assert.ok(Math.abs(dl.y - kb.y) < 1 && Math.abs(dl.height - kb.height) < 1, "a twin of Download, on its line");
      assert.equal(await lib.evaluate((b) => b.querySelector("svg")?.dataset.icon), "library");
      try { mkdirSync(PICTURES, { recursive: true }); await x.p.locator('[data-file-key="photo:a1:0"]').first().screenshot({ path: `${PICTURES}/pip-row-${theme}-${width}.png` }); } catch { /* still checked */ }
      await lib.click();
      await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector('button[data-message-library="a1:0"]')?.getAttribute("aria-label") === "In Library");
      assert.equal(await lib.isDisabled(), true, "kept: In Library, off, nothing kept twice");
      const keeps = (await sent(x, "library_pip_message_image")).filter((r) => r.keep);
      assert.deepEqual(keeps.map((r) => [r.message_id, r.index]), [["a1", 0]]);
      if (width === 440) { try { await x.p.locator('[data-file-key="photo:a1:0"]').first().screenshot({ path: `${PICTURES}/pip-row-in-library-${theme}-${width}.png` }); } catch { /* still checked */ } }
      // The pop-up says so too.
      await x.p.click('img[data-message-image="a1:0"]');
      const pop = x.p.locator('.dgc-picpop [data-act="library"]');
      assert.equal(await pop.getAttribute("aria-label"), "In Library");
      assert.equal(await pop.isDisabled(), true);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
  const held = await open({ where: "tab", library: { held: ["a1:0"] } });
  try {
    await held.p.waitForFunction(() => document.querySelector('button[data-message-library="a1:0"]')?.getAttribute("aria-label") === "In Library");
    assert.equal(await held.p.locator('button[data-message-library="a1:0"]').isDisabled(), true, "a generated picture is in the Library from the start");
  } finally { await held.close(); }
});

test("an older DGC (before Pips API 108) shows no Save to Library and asks nothing of it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ where: "tab", api: 107 });
  try {
    await x.p.waitForSelector('button[data-message-download="a1:0"]');
    assert.equal(await x.p.locator("button[data-message-library]").count(), 0);
    assert.deepEqual(await sent(x, "library_pip_message_image"), []);
    await x.p.click('img[data-message-image="a1:0"]');
    assert.equal(await x.p.locator('.dgc-picpop [data-act="library"]').isHidden(), true);
  } finally { await x.close(); }
});
