// The ChatDGC Library in its editor tab (media/library.js, the page src/chatdgc.ts serves) scrolls (13 Nov: with many
// artifacts the list could not be scrolled at all: the page takes main.css, whose body never scrolls, and nothing in the
// Library did). The one Library module draws it since Library v2; in its editor tab the list scrolls inside the page.
// In real Chromium on the real page: with 200 of them, in each tab (Files, Widgets, Artifacts), the last
// row is reached by the wheel and by the keyboard (the list takes the keyboard; End, PageDown and the arrows scroll
// it), while the title, the search field and the tab strip stay where they are, at any window height.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openLibrary } from "./support/chat-scene.mjs";

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

const hex = (n, len) => n.toString(16).padStart(len, "0");
export const ARTIFACTS = Array.from({ length: 200 }, (_, i) => ({ id: `ar_${hex(i + 1, 16)}`, type: ["doc", "slides", "sheet", "page", "dashboard"][i % 5], label: ["Document", "Slides", "Spreadsheet", "Page", "Dashboard"][i % 5],
  title: `Artifact number ${i + 1}`, version: 1 + (i % 3), created: "2026-10-26T10:00:00Z", updated: "2026-10-28T08:40:00Z", origin: { surface: ["chat", "work", "pip"][i % 3] }, exports: ["pdf"] }));
export const FILES = Array.from({ length: 200 }, (_, i) => ({ id: `att_${hex(i + 1, 32)}`, name: `Report number ${i + 1}.pdf`, kind: "pdf", size: 1000 + i, created_at: "2026-10-26T10:00:00Z", conversation_id: `chat_${"a".repeat(32)}`, conversation_title: "Q3 planning" }));
export const WIDGETS = Array.from({ length: 200 }, (_, i) => ({ id: `wg_${hex(i + 1, 16)}`, title: `Widget number ${i + 1}`, conversation_id: `chat_${"a".repeat(32)}`, conversation_title: "Growth", created_at: "2026-10-26T10:00:00Z", updated_at: "2026-10-26T10:00:00Z" }));
/** The Library with 200 of everything, as the host says them. */
export async function fullLibrary(page, send) {
  await send({ type: "widgetsOffered", on: true });
  await send({ type: "artifactsOffered", on: true });
  await send({ type: "library", files: FILES, total: FILES.length, next: null, counts: { pdf: FILES.length }, origins: {} });
  await page.waitForTimeout(80);
}
const now = (page) => page.evaluate(() => {
  const list = document.getElementById("library-list"), rows = [...list.children], last = rows.at(-1), box = (n) => { const r = n.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; };
  const seen = (n) => { if (!n) return false; const r = n.getBoundingClientRect(), mid = (r.top + r.bottom) / 2, at = document.elementFromPoint(r.left + 20, mid); return r.top >= -0.5 && r.bottom <= innerHeight + 0.5 && !!at && n.contains(at); };
  return { rows: rows.length, lastSeen: seen(last), firstSeen: seen(rows[0]), title: box(document.querySelector(".dgc-lib .dgc-pagehead-title")), search: box(document.getElementById("library-search")), tabs: box(document.getElementById("library-tabs")),
    tabsSeen: document.getElementById("library-tabs").checkVisibility() && box(document.getElementById("library-tabs")).top >= 0, sideways: document.documentElement.scrollWidth > innerWidth + 1, focus: document.activeElement?.id || document.activeElement?.className || "" };
});
const TABS = [["files", "Files", "library"], ["widgets", "Widgets", "widgets"], ["artifacts", "Artifacts", "artifacts"]];
for (const theme of ["dark-modern", "light-modern"]) for (const [width, height] of [[900, 760], [420, 420]]) {
  test(`the Library's every tab scrolls to its last row by the wheel and by the keyboard, its header and tabs in place (${theme}, ${width}×${height})`, async (t) => {
    if (skipOrFail(t)) return;
    const s = await openLibrary(browser, { width, height, theme });
    try {
      const p = s.page;
      await fullLibrary(p, s.send);
      for (const [view, name] of TABS) {
        await p.click(`#library-tab-${view}`);
        if (view === "widgets") await s.send({ type: "widgets", widgets: WIDGETS, next: null });
        if (view === "artifacts") await s.send({ type: "artifacts", items: ARTIFACTS });
        if (view === "files") await s.send({ type: "library", files: FILES, total: FILES.length, next: null, counts: { pdf: FILES.length }, origins: {} });
        await p.waitForTimeout(150);
        const top = await now(p);
        assert.equal(top.rows, 200, `${name}: its 200 rows are in the list`);
        assert.deepEqual([top.firstSeen, top.lastSeen, top.tabsSeen, top.sideways], [true, false, true, false], `${name}: the first row shows, the last is far below, the tabs are in sight`);
        // The wheel, over the list.
        const first = await p.locator("#library-list > *").first().boundingBox();
        await p.mouse.move(first.x + 40, first.y + 10);
        for (let i = 0; i < 60 && !(await now(p)).lastSeen; i++) { await p.mouse.wheel(0, 900); await p.waitForTimeout(25); }
        const wheeled = await now(p);
        assert.equal(wheeled.lastSeen, true, `${name}: the wheel reaches the last row`);
        assert.deepEqual([wheeled.title, wheeled.search, wheeled.tabs], [top.title, top.search, top.tabs], `${name}: the title, the search field and the tab strip stayed where they were`);
        // Back to the top with the keyboard, then to the end: the list takes the keyboard.
        await p.focus("#library-list");
        const until = (what, check) => p.waitForFunction(check, null, { timeout: 4000 }).then(() => true, () => false).then((ok) => assert.equal(ok, true, `${name}: ${what}`));
        await p.keyboard.press("Home");
        await until("Home goes back to the first row", () => document.getElementById("library-list").scrollTop === 0);
        assert.equal((await now(p)).firstSeen, true, `${name}: the first row shows again`);
        await p.keyboard.press("PageDown");
        await until("PageDown scrolls the list", () => document.getElementById("library-list").scrollTop > 40);
        await p.keyboard.press("End");
        await until("End reaches the list's end", () => { const l = document.getElementById("library-list"); return l.scrollTop + l.clientHeight >= l.scrollHeight - 1; });
        const keyed = await now(p);
        assert.equal(keyed.lastSeen, true, `${name}: End reaches the last row`);
        assert.deepEqual([keyed.title, keyed.tabs], [top.title, top.tabs], `${name}: and the header is still in place`);
        await p.keyboard.press("Home");
        await until("Home again", () => document.getElementById("library-list").scrollTop === 0);
        for (let i = 0; i < 6; i++) await p.keyboard.press("ArrowDown");
        await until("the arrows scroll it", () => document.getElementById("library-list").scrollTop > 0);
      }
      assert.deepEqual(s.errors || [], []);
    } finally { await s.page.close(); }
  });
}
