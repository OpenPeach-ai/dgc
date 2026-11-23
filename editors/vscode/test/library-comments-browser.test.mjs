// The Library row of an artifact with open comments says how many, first on its line, with the comment glyph from the
// shared icons, in the side bar's Library tab and in its editor tab, at 300, 440 and 700 px, dark and light: it stays
// when the rest of the line gives way, and a row with none (or only resolved ones) says nothing. In real Chromium on the
// one Library module (media/library.js) against the scene's stand-in host (support/library-scene.mjs).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openLibraryTab, openLibraryPage, LIB_ARTIFACTS, ar } from "./support/library-scene.mjs";

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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const ARTIFACTS = LIB_ARTIFACTS.map((a) => (a.id === ar(2) ? { ...a, comments: { open: 2, all: 3 } } : a.id === ar(3) ? { ...a, comments: { open: 0, all: 1 } } : a));
const rows = (page) => page.evaluate(() => [...document.querySelectorAll(".lib-row")].map((li) => {
  const talk = li.querySelector(".lib-row-talk"), meta = li.querySelector(".lib-row-meta");
  const r = talk?.getBoundingClientRect(), m = meta?.getBoundingClientRect();
  return { key: li.dataset.key, talk: talk ? talk.textContent : null, glyph: talk?.querySelector("svg")?.dataset.icon || null, label: li.getAttribute("aria-label"),
           inside: talk ? r.width > 0 && r.left >= m.left - 0.5 && r.right <= m.right + 0.5 : null };
}));

for (const place of ["side", "tab"]) {
  for (const theme of ["dark-modern", "light-modern"]) {
    for (const width of [300, 440, 700]) {
      test(`${place} ${width} px ${theme}: a row with open comments counts them, first on its line`, async (t) => {
        if (skipOrFail(t)) return;
        const x = place === "side" ? await openLibraryTab(browser, { artifacts: ARTIFACTS, width, theme }) : await openLibraryPage(browser, { artifacts: ARTIFACTS, width, theme });
        try {
          await x.page.waitForSelector(".lib-row");
          const all = await rows(x.page);
          const sheet = all.find((r) => r.key === `artifact:${ar(2)}`), doc = all.find((r) => r.key === `artifact:${ar(3)}`);
          assert.ok(sheet && doc, "premise: both rows drawn");
          assert.equal(sheet.talk, "2");
          assert.equal(sheet.glyph, "comment");
          assert.equal(sheet.inside, true, "it stays inside the row's line, also at the narrowest");
          assert.match(sheet.label, /2 open comments/);
          assert.equal(doc.talk, null, "only resolved comments: nothing said");
          assert.equal(all.filter((r) => r.talk !== null).length, 1);
          assert.ok(await x.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), "no sideways scroll");
        } finally { await (x.close ? x.close() : x.page.close()); }
      });
    }
  }
}
