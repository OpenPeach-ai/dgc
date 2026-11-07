// In a short editor (VS Code's bottom panel open) the model menus scroll inside themselves: they never run past the top of
// the chat, where "← Providers" sat under the tab bar and couldn't be clicked (final check, 2026-11-07).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const rows = Array.from({ length: 40 }, (_, i) => `<button style="display:block;height:28px;width:100%">Model ${i}</button>`).join("");
for (const [name, sheet, menu] of [["ChatDGC", "media/chatdgc.css", `<div class="cd-model-menu">${rows}</div>`],
                                    ["Work", "media/main.css", `<div id="modelmenu" class="cmenu"><div class="reasoning-card" style="height:90px">Thinking</div><div class="model-options"><div class="model-list-scroll">${rows}</div></div></div>`]]) {
  test(`${name}'s model menu stays inside a 360 px editor`, async (t) => {
    if (skipOrFail(t)) return;
    const page = await browser.newPage({ viewport: { width: 500, height: 360 } });
    try {
      const css = readFileSync(new URL(`../${sheet}`, import.meta.url), "utf8");
      await page.setContent(`<style>${css}</style><div style="position:fixed;left:0;right:0;bottom:0;height:120px"><div style="position:relative;height:100%">${menu}</div></div>`);
      const box = await page.locator(".cd-model-menu, #modelmenu").first().boundingBox();
      assert.ok(box.y >= 0, `its top is inside the page (${box.y})`);
      const scrolls = await page.locator(".cd-model-menu, #modelmenu .model-list-scroll").first().evaluate((n) => n.scrollHeight > n.clientHeight && getComputedStyle(n).overflowY === "auto");
      assert.ok(scrolls, "the rest scrolls inside it");
    } finally { await page.close(); }
  });
}
