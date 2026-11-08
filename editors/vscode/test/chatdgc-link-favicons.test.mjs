// A link in a ChatDGC reply wears its site's favicon, as a link in a Work reply does (reported 8 Nov: "why doesn't
// the link VibeDGC.com show its favicon, like it shows in work sessions?"). ChatDGC switched the reply's favicons off
// when it was built and its `favicons` message only ever reached the Sources chips, so every link kept the bundled
// glyph. Now dgc.linkFavicons means the same in both: on, the link asks Google's icon service about its origin only;
// off, nothing is asked; and an icon that cannot load gives the glyph back, never a blank gap.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { M, conversation, openChat } from "./support/chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

// One 16 px PNG, for the icon service when the test lets it answer.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAHUlEQVR4nGMsC/n2n4ECwESJ5lEDRg0YNWAwGQAAZakC32PgnS0AAAAASUVORK5CYII=", "base64");
const SAID = [{ id: M(1), role: "user", text: "Give me DGC's site.", created_at: "2026-11-08T17:20:00Z" },
              { id: M(2), role: "assistant", text: "Here it is: [vibedgc.com](https://vibedgc.com/pricing?ref=chat).", finish: "stop", created_at: "2026-11-08T17:20:05Z" }];
const link = (s) => s.page.evaluate(() => {
  const a = document.querySelector(".cd-body .md-link[data-link-kind='external']");
  const img = a?.querySelector("img.link-favicon");
  return a && { src: img?.getAttribute("src") || null, loaded: !!img && img.complete && img.naturalWidth > 0,
                glyph: a.dataset.linkSource || null, fallback: a.dataset.linkFallback || null };
});

async function chat({ icons }) {
  const s = await openChat(browser, { width: 900, height: 700 });
  const asked = [];
  await s.page.route("https://www.google.com/**", (route) => {
    asked.push(route.request().url());
    return icons === "answer" ? route.fulfill({ contentType: "image/png", body: PNG }) : route.abort();
  });
  await s.send({ type: "opened", conversation: conversation(), messages: SAID, earlier: 0, busy: false });
  return { s, asked };
}

test("on, a link in a reply wears its site's favicon, asked about its origin only", async (t) => {
  if (skipOrFail(t)) return;
  const { s, asked } = await chat({ icons: "answer" });
  try {
    const before = await link(s);
    assert.equal(before.src, null, "until the setting arrives, nothing is asked");
    assert.equal(before.glyph, "dgc");
    await s.send({ type: "favicons", on: true });
    await s.page.waitForFunction(() => document.querySelector(".cd-body .md-link img.link-favicon")?.naturalWidth > 0, null, { timeout: 5000 });
    const on = await link(s);
    assert.equal(on.src, "https://www.google.com/s2/favicons?domain=https%3A%2F%2Fvibedgc.com&sz=32", "the origin only, never the path or query");
    assert.ok(on.loaded, "the favicon drew");
    assert.equal(on.glyph, null, "with a favicon, the bundled glyph does not also draw");
    assert.ok(asked.every((u) => !/pricing|ref=chat/.test(u)), "the link's path and query never leave");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("an icon that cannot load gives the glyph back, never a blank gap", async (t) => {
  if (skipOrFail(t)) return;
  const { s } = await chat({ icons: "fail" });
  try {
    await s.send({ type: "favicons", on: true });
    await s.page.waitForFunction(() => {
      const a = document.querySelector(".cd-body .md-link[data-link-kind='external']");
      return a && !a.querySelector("img.link-favicon") && a.dataset.linkSource;
    }, null, { timeout: 5000 });
    const failed = await link(s);
    assert.equal(failed.glyph, "dgc", "the site's own bundled mark comes back");
    assert.equal(failed.fallback, null);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("off, a reply's links ask for nothing", async (t) => {
  if (skipOrFail(t)) return;
  const { s, asked } = await chat({ icons: "answer" });
  try {
    await s.send({ type: "favicons", on: false });
    await s.page.waitForTimeout(400);
    const off = await link(s);
    assert.equal(off.src, null);
    assert.equal(off.glyph, "dgc");
    assert.deepEqual(asked, [], "dgc.linkFavicons off: no request leaves for an icon");
  } finally { await s.page.close(); }
});
