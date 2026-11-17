// The small ones of live round 1 (14 Nov). The thinking slider's row never says "Off … Off … Ultra" (the word in the
// middle is the level chosen: at either end it is that end's own word, said once) and its track has an edge at Off
// (finding 19). A right-click on a session's row opens DGC's own menu for the row, never the browser's Cut, Copy and
// Paste (22). In a Pip's chat the voice button keeps its purple circle when the model menu opens: it flickered,
// because each redraw drew it and the box's own "is there something to send" pass took it away again (17).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { openDock } from "./support/dock-scene.mjs";
import { setup as openPips } from "./support/one-pips-node.mjs";
import { GST } from "./support/one-pips-scene.mjs";
import { modelsMessage } from "./support/model-menu-scene.mjs";

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
const windows = [];
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); for (const w of windows) w.close(); });

test("a right-click on a session's row opens the row's own menu, not the browser's", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 300, height: 700 });
  try {
    await x.settle();
    const row = x.page.locator("#sessions-list .session-row").first();
    const prevented = await row.evaluate((node) => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 60, clientY: node.getBoundingClientRect().top + 8, button: 2 }); node.dispatchEvent(e); return e.defaultPrevented; });
    assert.equal(prevented, true, "the browser's menu is not shown");
    await x.page.waitForTimeout(300);
    const menu = await x.page.evaluate(() => { const m = [...document.querySelectorAll(".dgc-menu, [role='menu']")].find((n) => n.checkVisibility() && n.querySelector("[role^='menuitem']")); return m ? [...m.querySelectorAll("[role^='menuitem']")].map((r) => r.textContent.trim()).filter(Boolean) : null; });
    assert.ok(menu && menu.length >= 2, "the row's own menu is open");
    assert.ok(menu.some((w) => /Archive|Rename|Pin/.test(w)), `with the row's own choices (${menu})`);
    // Elsewhere in a field the editor's own menu still comes: text can be cut, copied and pasted.
    const field = await x.page.locator("#sessions-search").evaluate((node) => { const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true }); node.dispatchEvent(e); return e.defaultPrevented; });
    assert.equal(field, false);
  } finally { await x.close(); }
});

test("a Pip's chat: the voice button keeps its purple circle when the model menu opens (nothing takes it away and draws it again)", async () => {
  const media = (file) => readFileSync(new URL(`../media/${file}`, import.meta.url), "utf8");
  const x = openPips({ api: 97, scene: { sub: true, waiting: false, fix: "none" }, pre: [media("voicebar.js"), media("readaloud.js"), media("voicemode.js")] });
  windows.push(x.w);
  await x.drain(); await x.openPip(GST); await x.drain();
  assert.ok(x.$("#chat-voicemode"), "an empty box offers voice mode where Send is");
  assert.equal(x.$("#chat-voicemode").classList.contains("ready"), true, "with its circle, at rest");
  const lost = [];
  new x.w.MutationObserver((list) => { for (const r of list) if (r.type === "attributes" && r.target.id === "chat-voicemode" && !r.target.classList.contains("ready")) lost.push(r.target.className); }).observe(x.d, { subtree: true, attributes: true, attributeFilter: ["class"] });
  x.$("#chat-model").click(); await x.drain();
  assert.equal(x.$("#chat-voicemode").classList.contains("ready"), true, "still there with the menu open");
  assert.deepEqual(lost, [], "and it was never taken away in between");
  // A word typed: it is Send again, lit because there is something to send.
  x.type(x.$("#chatText"), "hello"); await x.drain();
  assert.equal(x.$("#chat-voicemode"), null); assert.equal(x.$(".chat-send").classList.contains("ready"), true);
});
