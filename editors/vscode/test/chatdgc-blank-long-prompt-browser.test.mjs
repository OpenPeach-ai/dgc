// A new chat with a long prompt pasted (17 Nov, his report: "the prompt box goes down and cut from bottom, no way to
// then see or access the prompt box"). The welcome and the box share a new chat's page; the box must always be whole
// and reachable, its buttons inside the window, however long the prompt, from a tall editor to a short one. In real
// Chromium, on ChatDGC's own page.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { conversation, openChat } from "./support/chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const LONG = "We ran an exchange where buyers and sellers placed orders and traded with each other; we only provided the platform. ".repeat(28);

async function blankChat(width, height, words) {
  const s = await openChat(browser, { width, height });
  await s.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
  await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud" });
  if (words) {
    await s.page.evaluate((text) => { const box = document.getElementById("cd-input"); box.focus();
      const data = new DataTransfer(); data.setData("text/plain", text);
      box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true })); }, words);
    await s.page.waitForTimeout(300);
  }
  const at = await s.page.evaluate(() => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
    return { vh: innerHeight, blank: document.body.classList.contains("cd-blank"), input: box("#cd-input"), send: box("#cd-send"),
      composer: box(".cd-foot .cd-column"), welcome: box("#cd-empty h2") };
  });
  return { s, at };
}

for (const [width, height] of [[1060, 800], [1060, 600], [420, 700], [1060, 460]]) {
  test(`a long prompt in a new chat keeps the whole box in the window (${width}×${height})`, async (t) => {
    if (skipOrFail(t)) return;
    const { s, at } = await blankChat(width, height, LONG);
    try {
      assert.equal(at.blank, true, "still a new chat until it is sent");
      assert.ok(at.send && at.send.bottom <= at.vh, `the send button is inside the window: ${JSON.stringify(at)}`);
      assert.ok(at.input && at.input.bottom <= at.vh && at.input.top >= 0, `the box is inside the window: ${JSON.stringify(at)}`);
      assert.ok(!at.welcome || at.welcome.bottom <= at.composer.top + 1, "the welcome never sits on the box");
      // The box scrolls inside itself: the end of what was pasted can be reached.
      const scrolls = await s.page.evaluate(() => { const box = document.getElementById("cd-input"); return box.scrollHeight > box.clientHeight + 1; });
      assert.equal(scrolls, true, "the long prompt scrolls inside the box");
    } finally { await s.page.close(); }
  });
}

test("a new chat with nothing typed keeps the welcome and the box together near the middle", async (t) => {
  if (skipOrFail(t)) return;
  const { s, at } = await blankChat(1060, 800, "");
  try {
    assert.ok(at.welcome, "the welcome shows");
    const middle = (at.welcome.top + at.composer.bottom) / 2;
    assert.ok(middle > at.vh * 0.35 && middle < at.vh * 0.65, `the pair sits near the middle: ${JSON.stringify(at)}`);
    assert.ok(at.composer.top - at.welcome.bottom < 80, "the welcome sits just above the box");
  } finally { await s.page.close(); }
});
