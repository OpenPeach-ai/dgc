// Live round 1, finding 49 (15 Nov): in the side bar's Library at 170 px, a pointed-at Images row's ⋯ lay over its
// title, which then stopped mid-word with no "…" ("A beach at dus" under the button). The ⋯ lies over the row's end by
// design (nothing moves under the pointer), so while it shows, the row's words end before it: a title too long for
// what is left ends in "…" before the ⋯, at every width, on every tab; a title that fits is not touched.
// In real Chromium, on the real side bar (media/library.js, media/shared/library.css).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openLibraryTab } from "./support/library-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

// Every row on show, pointed at in turn: where its title's words end, where its second line's end, and where the ⋯ is.
const rows = async (x) => {
  const count = await x.page.evaluate(() => [...document.querySelectorAll("#library-home .lib-row")].filter((r) => r.checkVisibility()).length);
  const out = [];
  for (let i = 0; i < count; i++) {
    const at = await x.page.evaluate((n) => { const r = [...document.querySelectorAll("#library-home .lib-row")].filter((e) => e.checkVisibility())[n]; r.scrollIntoView({ block: "center" }); const b = r.getBoundingClientRect(); return { x: b.left + 24, y: b.top + b.height / 2 }; }, i);
    await x.page.mouse.move(at.x, at.y); await x.settle();
    out.push(await x.page.evaluate((n) => {
      const r = [...document.querySelectorAll("#library-home .lib-row")].filter((e) => e.checkVisibility())[n], name = r.querySelector(".lib-row-name"), meta = r.querySelector(".lib-row-meta"), more = r.querySelector(".lib-row-more");
      const box = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right }; };
      const shown = !!more && more.checkVisibility() && getComputedStyle(more).display !== "none";
      return { title: name.textContent, name: box(name), clips: getComputedStyle(name).overflowX, cut: name.scrollWidth > name.clientWidth, ellipsis: getComputedStyle(name).textOverflow, meta: meta ? box(meta) : null,
        more: shown ? { ...box(more), over: getComputedStyle(more).position === "absolute" } : null, hovered: r.matches(":hover") };
    }, i));
  }
  return out;
};

for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 220, 300, 440]) {
  test(`a pointed-at row's title ends before its ⋯, in “…” when it is too long, on every Library tab (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openLibraryTab(browser, { width, theme });
    try {
      let seen = 0, shortened = 0;
      for (const tab of ["images", "artifacts", "widgets", "videos", "files"]) {
        await x.libTab(tab); await x.page.mouse.move(1, 1); await x.settle();
        for (const r of await rows(x)) {
          assert.equal(r.hovered, true, `${tab}: “${r.title}” is pointed at`);
          if (!r.more) continue;   // (a wide side bar shows each action as its own button, beside the words)
          seen++;
          assert.ok(r.name.right <= r.more.left + 0.5, `${tab}: “${r.title}” ends before the ⋯ (its box ends at ${r.name.right}, the ⋯ starts at ${r.more.left})`);
          assert.equal(r.clips, "hidden", `${tab}: none of “${r.title}” is drawn outside its box (so none under the ⋯)`);
          if (r.meta) assert.ok(r.meta.right <= r.more.left + 0.5, `${tab}: the line under “${r.title}” ends before the ⋯ too`);
          if (r.cut) { shortened++; assert.equal(r.ellipsis, "ellipsis", `${tab}: “${r.title}” is too long, and ends in “…”`); }
        }
      }
      assert.ok(seen >= 8, `rows with a ⋯ were measured (${seen})`);
      if (width <= 220) assert.ok(shortened >= 3, `at ${width} px some titles are too long and end in “…” (${shortened})`);
      assert.deepEqual(x.errors || [], []);
    } finally { await x.close(); }
  });
}

test("a row's words end just before its ⋯, which is on every row (16 Nov): its title is cut no sooner than that, pointed at or not", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300, theme: "dark-modern" });
  try {
    await x.libTab("images"); await x.page.mouse.move(1, 1); await x.settle();
    const rest = await x.page.evaluate(() => [...document.querySelectorAll("#library-home .lib-row")].map((r) => { const m = r.querySelector(".lib-row-main"); return [r.querySelector(".lib-row-name").textContent, Math.round(m.getBoundingClientRect().right - r.getBoundingClientRect().right), getComputedStyle(m).paddingRight]; }));
    // (The ⋯ is 28px, 3px from the row's end, and the words stop a gap before it: 10px at this width.)
    for (const [title, gap, pad] of rest) { assert.equal(pad, "0px", `“${title}” gives no room away beyond the ⋯'s own`); assert.ok(gap >= -45 && gap <= -36, `“${title}” runs to its row's ⋯ (${gap}px)`); }
    const first = await x.page.evaluate(() => { const r = document.querySelector("#library-home .lib-row"), m = r.querySelector(".lib-row-main").getBoundingClientRect(), d = r.querySelector(".lib-row-more").getBoundingClientRect(); return { gap: Math.round(d.left - m.right), w: Math.round(m.width) }; });
    await x.page.hover("#library-home .lib-row"); await x.settle();
    const hot = await x.page.evaluate(() => { const r = document.querySelector("#library-home .lib-row"), m = r.querySelector(".lib-row-main").getBoundingClientRect(); return Math.round(m.width); });
    assert.ok(first.gap >= 2, "the words never run under the ⋯"); assert.equal(hot, first.w, "and pointing at the row moves nothing");
  } finally { await x.close(); }
});
