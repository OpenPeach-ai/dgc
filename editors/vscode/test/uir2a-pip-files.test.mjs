// 15 Nov ask 59, in real Chromium on a Pip's real chat page: a Pip sends files in its chat, like a person (Pips API 101).
// Its reply carries `files` beside its `images`: each is a file card (its name, its size, Open, Save a copy…); a video
// plays inline with its controls and a sound plays. The files you sent on your own message open and save the same way.
// The page never names a file's place: it asks its host (pipsOpenFile, pipsFileData), which asks DGC.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openPipFiles } from "./support/uir2a-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const facts = (page) => page.evaluate(() => {
  const root = window.__pipsRoot || document, all = (s, from = root) => [...from.querySelectorAll(s)];
  const reply = all(".pip-message.assistant").at(-1), mine = all(".pip-message.user")[0], log = root.querySelector(".conversation-log");
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }; };
  const card = (n) => ({ name: n.querySelector(".dgc-doc-name")?.textContent, meta: n.querySelector(".dgc-doc-meta")?.textContent, box: box(n),
    open: n.querySelector("[data-message-file]")?.getAttribute("aria-label") || "", save: n.querySelector("[data-message-file-save]")?.getAttribute("aria-label") || "",
    saveTitle: n.querySelector("[data-message-file-save]")?.title || "", saveBox: n.querySelector("[data-message-file-save]") ? box(n.querySelector("[data-message-file-save]")) : null });
  const video = reply.querySelector("video"), audio = reply.querySelector("audio");
  return { cards: all(".msg-sent-file", reply).map(card), pictures: all("img[data-message-image]", reply).length, pictureCards: all(".msg-made-file:not(.msg-sent-file)", reply).length,
    video: video ? { controls: video.controls, src: video.currentSrc || video.src || "", ready: video.readyState, w: video.videoWidth, box: box(video), label: video.getAttribute("aria-label") } : null,
    audio: audio ? { controls: audio.controls, src: audio.currentSrc || audio.src || "", box: box(audio) } : null,
    mine: all(".msg-file", mine).map((n) => ({ name: n.querySelector(".chat-file-name")?.textContent, open: n.querySelector("[data-message-file]")?.getAttribute("aria-label") || "", save: n.querySelector("[data-message-file-save]")?.getAttribute("aria-label") || "", box: box(n) })),
    column: { left: Math.round(log.getBoundingClientRect().left), right: Math.round(log.getBoundingClientRect().left + log.clientWidth) }, sideways: log.scrollWidth - log.clientWidth,
    asked: (window.__sent || []).map((r) => r.type), words: JSON.stringify(window.__all || []) };
});

for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440, 700]) {
  test(`59: a Pip's reply shows the picture, the video and the zip it sent, each file a card with Open and Save a copy… (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPipFiles(browser, { theme, width });
    try {
      await x.page.waitForFunction(() => { const v = (window.__pipsRoot || document).querySelector(".pip-message.assistant video"); return v && v.readyState >= 1; }, null, { timeout: 8000 }).catch(() => {});
      const f = await facts(x.page);
      assert.equal(f.pictures, 1, "its picture shows as before"); assert.equal(f.pictureCards, 1, "with the row a made picture has");
      assert.deepEqual(f.cards.map((c) => c.name), ["checkout-flow.webm", "checkout-logs-2026-11-16.zip"], "a card for each file it sent");
      assert.match(f.cards[0].meta, /16 KB/); assert.match(f.cards[1].meta, /ZIP.*4\.2 MB/);
      for (const c of f.cards) {
        assert.equal(c.open, `Open ${c.name}`); assert.equal(c.save, `Save a copy of ${c.name}`); assert.equal(c.saveTitle, "Save a copy…");
        assert.ok(c.box.left >= f.column.left - 1 && c.box.right <= f.column.right + 1, `the card is inside the chat's column (${JSON.stringify(c.box)})`);
        assert.ok(c.saveBox.width >= 24 && c.saveBox.right <= c.box.right, "Save a copy… is inside its card");
      }
      assert.ok(f.video, "the video is a player"); assert.equal(f.video.controls, true, "with its controls");
      assert.match(f.video.src, /^blob:/, "its bytes came from the host"); assert.ok(f.video.ready >= 1 && f.video.w === 320, "and it is a video Chromium can play");
      assert.ok(f.video.box.left >= f.column.left - 1 && f.video.box.right <= f.column.right + 1 && f.video.box.height > 60, "the player is inside the column");
      assert.ok(f.video.box.bottom <= f.cards[0].box.top + 1, "the player stands over its card");
      assert.equal(f.sideways, 0, "nothing scrolls sideways");
      // What the page asked: the host for the bytes, never DGC for the file, and never a place on disk.
      assert.deepEqual((await x.posted("pipsFileData")).map(({ pip_id, message_id, index }) => ({ message_id, index, pip: /^pip_/.test(pip_id) })), [{ message_id: "a1", index: 0, pip: true }]);
      assert.equal(f.asked.includes("get_pip_message_file"), false, "the page never asks DGC where a file is kept");
      assert.equal(/"path"/.test(f.words), false, "and never names a path");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("59: Open and Save a copy… on a file the Pip sent, and on a file you sent, ask the host; a sound plays", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPipFiles(browser, { width: 440, sent: "audio" });
  try {
    const p = x.page;
    await p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-message.assistant audio")?.src?.startsWith("blob:"), null, { timeout: 8000 }).catch(() => {});
    let f = await facts(p);
    assert.deepEqual(f.cards.map((c) => c.name), ["checkout-flow.webm", "checkout-logs-2026-11-16.zip", "voice-note.wav"]);
    assert.ok(f.audio, "a sound is a player"); assert.equal(f.audio.controls, true); assert.match(f.audio.src, /^blob:/);
    const zip = ".pip-message.assistant .msg-sent-file:nth-of-type(2)";
    await p.click(`.pip-message.assistant .msg-sent-file >> nth=1 >> [data-message-file-save]`);
    await p.locator(".pip-message.assistant .msg-sent-file").nth(1).locator("[data-message-file]").click({ position: { x: 60, y: 10 }, force: true });
    await p.click(".pip-message.user [data-message-file]");
    await p.click(".pip-message.user [data-message-file-save]");
    const asked = (await x.posted("pipsOpenFile")).map(({ type, pip_id, ...rest }) => rest);
    assert.deepEqual(asked, [{ message_id: "a1", index: 1, save: true }, { message_id: "a1", index: 1 }, { message_id: "u1", index: 0 }, { message_id: "u1", index: 0, save: true }]);
    f = await facts(p);
    assert.deepEqual(f.mine.map((m) => [m.name, m.open, m.save]), [["checkout-notes.md", "Open checkout-notes.md", "Save a copy of checkout-notes.md"]], "your own file opens and saves the same way");
    // The keyboard reaches both, by name.
    assert.equal(await p.getByRole("button", { name: "Open checkout-logs-2026-11-16.zip" }).count(), 1);
    assert.equal(await p.getByRole("button", { name: "Save a copy of checkout-logs-2026-11-16.zip" }).count(), 1);
    assert.deepEqual(x.errors, []); void zip;
  } finally { await x.close(); }
});

test("59: a large video waits for you to press play; when the host can't hand a file over, the card is still there", async (t) => {
  if (skipOrFail(t)) return;
  const big = await openPipFiles(browser, { width: 440, sent: "big" });
  try {
    await big.page.waitForTimeout(300);
    assert.deepEqual(await big.posted("pipsFileData"), [], "96 MB is not loaded just for being on screen");
    const load = big.page.locator(".pip-message.assistant .msg-sent-media [data-media-load]");
    assert.equal(await load.count(), 1, "it shows a play button instead"); assert.match(await load.getAttribute("aria-label"), /Play checkout-flow\.webm/);
    await load.click();
    await big.page.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-message.assistant video")?.src?.startsWith("blob:"), null, { timeout: 8000 });
    assert.equal((await big.posted("pipsFileData")).length, 1);
    assert.deepEqual(big.errors, []);
  } finally { await big.close(); }
  const none = await openPipFiles(browser, { width: 440, media: false });
  try {
    await none.page.waitForFunction(() => (window.__pipsRoot || document).querySelector(".pip-message.assistant .msg-sent-media [role=status]"), null, { timeout: 8000 });
    const f = await facts(none.page);
    assert.equal(f.cards.length, 2, "its card stays, with Open and Save a copy…");
    assert.match(await none.page.locator(".pip-message.assistant .msg-sent-media [role=status]").textContent(), /can't be played here|no longer available/i);
    assert.deepEqual(none.errors, []);
  } finally { await none.close(); }
});

test("59: an older DGC (Pips API 100) shows your files as before, with nothing to press", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openPipFiles(browser, { width: 440, api: 100 });
  try {
    const f = await facts(x.page);
    assert.deepEqual(f.mine.map((m) => [m.name, m.open, m.save]), [["checkout-notes.md", "", ""]]);
    assert.deepEqual([f.cards.length, f.video, f.audio], [0, null, null]);
    assert.deepEqual(await x.posted("pipsFileData"), []);
  } finally { await x.close(); }
});
