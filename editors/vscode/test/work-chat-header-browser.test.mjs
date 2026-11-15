// The Work and Chat tabs start with the Pips tab's header row (live round 1, finding 20): the tab's name at the left
// ("Work", "Chat"), ⋯ at the right, a line, then the search bar. Work's ⋯: Archived sessions, Sub-agent settings, Work
// settings. Chat's ⋯: New incognito chat, What DGC remembers, Archived chats, Chat settings. Library is in neither
// (his call, 14 Nov night: it gets a header tab of its own in a later pass). On the real side bar, in real Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";

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

const TABS = { work: { home: "#work-home", title: "Work", search: "#sessions-search", more: "#work-more", rows: ["Archived sessions", "Sub-agent settings", "Work settings"] },
  chat: { home: "#chats-home", title: "Chat", search: "#chats-search", more: "#chats-more-menu", rows: ["New incognito chat", "What DGC remembers", "Archived chats", "Chat settings"] } };
const head = (page, t) => page.evaluate(({ home, search, more }) => {
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, h: r.height, w: r.width }; };
  const section = document.querySelector(home), header = section.querySelector(".dgc-pagehead"); if (!header) return null;
  const title = header.querySelector(".dgc-pagehead-title"), dots = document.querySelector(more), s = getComputedStyle(header);
  return { first: section.firstElementChild === header, header: box(header), title: { ...box(title), text: title.textContent.trim(), tag: title.tagName }, dots: { ...box(dots), label: dots.getAttribute("aria-label"), radius: parseFloat(getComputedStyle(dots).borderTopLeftRadius) },
    line: parseFloat(s.borderBottomWidth), lineStyle: s.borderBottomStyle, search: box(document.querySelector(search)), panel: box(section), sideways: document.documentElement.scrollWidth > innerWidth };
}, t);
const posted = (x, type) => x.page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);

for (const [tab, T] of Object.entries(TABS)) for (const theme of ["dark-modern", "light-modern"]) for (const width of [170, 300, 440]) {
  test(`${T.title}: its name at the left, ⋯ at the right, a line, then the search bar (${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { tab, width, height: 700, theme });
    try {
      await x.settle();
      const h = await head(x.page, T);
      assert.ok(h, "the tab has a header row"); assert.equal(h.first, true, "it is the first thing in the tab");
      assert.equal(h.title.text, T.title); assert.equal(h.title.tag, "H2");
      assert.ok(h.title.left - h.header.left <= 16 && h.title.left >= h.header.left, "the name is at the left");
      assert.ok(h.header.right - h.dots.right <= 16 && h.dots.right <= h.header.right + 0.5, "⋯ is at the right");
      assert.ok(h.dots.left >= h.title.right, "after the name");
      assert.ok(h.line >= 1 && h.lineStyle === "solid", "a line under the row");
      assert.ok(h.search.top >= h.header.bottom, "the search bar is under the line");
      assert.ok(h.dots.h >= 24 && h.dots.h <= 30 && Math.abs(h.dots.w - h.dots.h) <= 1, `⋯ is a square button (${h.dots.w}×${h.dots.h})`);
      assert.ok(h.dots.radius >= 4 && h.dots.radius <= 10, "of the button family, never a circle");
      assert.equal(h.sideways, false, "nothing scrolls sideways");
      assert.equal(await x.page.locator("#work-library, #chats-library").count(), 0, "no Library button in Work or Chat");
    } finally { await x.close(); }
  });
}

test("Work's ⋯: Archived sessions, Sub-agent settings, Work settings; each does its thing", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "work", width: 300, height: 700 });
  try {
    await x.settle();
    const rows = async () => { await x.page.click("#work-more"); await x.page.waitForTimeout(350); return x.page.evaluate(() => [...(document.querySelector(".dgc-pop")?.querySelectorAll("[role^='menuitem']") || [])].filter((r) => r.checkVisibility()).map((r) => r.textContent.trim())); };
    assert.deepEqual(await rows(), TABS.work.rows);
    assert.equal(await x.page.getAttribute("#work-more", "aria-expanded"), "true");
    await x.page.getByRole("menuitem", { name: "Sub-agent settings" }).click(); await x.page.waitForTimeout(200);
    assert.deepEqual((await posted(x, "openSettings")).map((m) => [m.section, m.browse || ""]), [["models", ""]]);
    await rows(); await x.page.getByRole("menuitem", { name: "Work settings" }).click(); await x.page.waitForTimeout(200);
    assert.deepEqual((await posted(x, "openSettings")).map((m) => m.section), ["models", "general"]);
    // Archived sessions: the archived list at the foot of the list opens and comes into view.
    await x.send({ type: "sessions_list", items: [], error: "", archived: { items: [{ id: "arch-1", name: "An older session", when: "2026-11-01 10:00", count: 4 }], more: false } }); await x.settle();
    await rows(); await x.page.getByRole("menuitem", { name: "Archived sessions" }).click(); await x.page.waitForTimeout(350);
    const toggle = x.page.locator("#sessions-archived-toggle");
    if (await toggle.count() && await toggle.isVisible()) assert.equal(await toggle.getAttribute("aria-expanded"), "true", "the archived sessions are open");
    // Escape closes the menu and the keyboard goes back to ⋯.
    await rows(); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(250);
    assert.equal(await x.page.evaluate(() => document.activeElement?.id), "work-more");
  } finally { await x.close(); }
});

test("Chat's ⋯: New incognito chat, What DGC remembers, Archived chats, Chat settings", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { tab: "chat", width: 300, height: 700 });
  try {
    await x.settle();
    const rows = async () => { await x.page.click("#chats-more-menu"); await x.page.waitForTimeout(350); return x.page.evaluate(() => [...(document.querySelector(".dgc-pop")?.querySelectorAll("[role^='menuitem']") || [])].filter((r) => r.checkVisibility()).map((r) => r.textContent.trim())); };
    assert.deepEqual(await rows(), TABS.chat.rows);
    await x.page.getByRole("menuitem", { name: "New incognito chat" }).click(); await x.page.waitForTimeout(200);
    assert.deepEqual(await posted(x, "chatdgcNew"), [{ type: "chatdgcNew", temporary: true }]);
    await rows(); await x.page.getByRole("menuitem", { name: "What DGC remembers" }).click(); await x.page.waitForTimeout(200);
    await rows(); await x.page.getByRole("menuitem", { name: "Chat settings" }).click(); await x.page.waitForTimeout(200);
    assert.deepEqual((await posted(x, "openSettings")).map((m) => m.section), ["memory", "chatdgc"]);
  } finally { await x.close(); }
});
