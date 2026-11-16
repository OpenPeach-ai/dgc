// Rows with buttons at narrow widths (his pictures, 16 Nov), in real Chromium on the real pages. The rule, for every
// list: where a row's icon buttons don't fit they are in the row's ⋯ menu, and the ⋯ is on every row at those widths
// (seen without pointing at the row, reached by Tab); a row is one height at every width; a long name ends in "…" with
// the whole name in its label; a label belongs to the row under the pointer and never lies over that row's own words.
// The lists: the Library's rows, Work's sessions, Chat's chats, the Pips list.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openLibraryTab, openLibraryPage, LIB_FILES, ar } from "./support/library-scene.mjs";
import { openDock, DOCK_SESSIONS } from "./support/dock-scene.mjs";
import { CHATS } from "./support/home-scene.mjs";
import { openOnePips, MORNINGS } from "./support/one-pips-scene.mjs";
import { readRows } from "./support/uir2c-rows-probe.mjs";

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
const WIDTHS = [300, 360, 440, 700];
const LIB = "#library-list .lib-row";
const menuWords = (page) => page.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => r.querySelector(".dgc-menu-label")?.textContent.trim() || r.textContent.trim()));
const seenLabels = (row) => row.buttons.filter((b) => b.seen).map((b) => b.label);
const away = async (page) => { await page.mouse.move(2, 2); await page.waitForTimeout(120); };

for (const width of WIDTHS) {
  test(`the Library at ${width}px: every row shows its ⋯ without being pointed at, Tab reaches it, and what has no icon on the row is in its menu, Pin too`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openLibraryTab(browser, { width });
    try {
      await away(x.page);
      const rows = await readRows(x.page, LIB);
      assert.ok(rows.length >= 5);
      for (const r of rows) { const more = r.buttons.find((b) => b.label.startsWith("More for")); assert.ok(more?.seen, `row ${r.key}: its ⋯ shows with no pointer on it`); assert.ok(more.tab, "and Tab reaches it"); }
      const icons = seenLabels(rows[0]).filter((l) => !l.startsWith("More for") && !l.startsWith("Open Tile"));
      // (The first row is a page a Pip made: Open it, Save a copy…, Pin to the dock, Remove….)
      await x.page.locator(`${LIB} .lib-row-more`).first().click(); await x.page.waitForTimeout(300);
      const menu = await menuWords(x.page);
      for (const word of ["Open", "Save a copy…", "Pin to the dock", "Remove…"]) assert.ok(menu.includes(word), `the menu has “${word}” (${menu.join(" · ")})`);
      if (width < 560) assert.deepEqual(icons, [], "no icon buttons where they don't fit: they are in the ⋯");
      else assert.deepEqual(icons, ["Open it", "Save a copy…", "Pin to the dock: Tide pool walk, Saturday", "Remove…"], "where they fit, the icons stay");
      // Pin from the menu: it is pinned, and the menu then offers Unpin.
      await x.page.locator(".dgc-pop .dgc-menu-row", { hasText: "Pin to the dock" }).click(); await x.rest(200);
      assert.equal((await x.page.evaluate(() => window.__dock.pins.some((p) => p.key.startsWith("artifact:")))), true, "Pin, reached from the ⋯");
      await x.page.locator(`${LIB} .lib-row-more`).first().click(); await x.page.waitForTimeout(300);
      assert.ok((await menuWords(x.page)).includes("Unpin from the dock"));
      await x.page.keyboard.press("Escape");
      // From the keyboard: the row, then Tab to its ⋯ (past its maker's name), Enter opens the menu.
      await x.page.locator(LIB).first().focus();
      for (let i = 0; i < 8; i++) { await x.page.keyboard.press("Tab"); if (await x.page.evaluate(() => document.activeElement?.classList.contains("lib-row-more"))) break; }
      assert.equal(await x.page.evaluate(() => document.activeElement?.classList.contains("lib-row-more") && document.activeElement.closest(".lib-row") === document.querySelector("#library-list .lib-row")), true, "Tab reaches the first row's ⋯");
      await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(300);
      assert.ok((await menuWords(x.page)).length >= 8, "Enter opens its menu");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

test("the Library's ⋯ keeps what only a kind has in the order of the row's icons (a file: use, save to project, add to a space, pin)", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openLibraryTab(browser, { width: 300 });
  try {
    await x.libTab("files");
    await x.page.locator(`.lib-row[data-key="file:${LIB_FILES[0].id}"] .lib-row-more`).click(); await x.page.waitForTimeout(300);
    const menu = await menuWords(x.page);
    assert.deepEqual(menu.slice(8), ["Use in a new chat", "Save to project…", "Add a copy to a space…", "Pin to the dock"]);
  } finally { await x.page.close(); }
});

test("a Library row is one height at every width, in every tab, pointed at or not, in the side bar and in the editor tab", async (t) => {
  if (skipOrFail(t)) return;
  const heights = new Set(), seen = [];
  for (const width of WIDTHS) for (const place of ["side", "tab"]) {
    const x = place === "side" ? await openLibraryTab(browser, { width }) : await openLibraryPage(browser, { width });
    try {
      for (const tab of ["artifacts", "widgets", "images", "files"]) {
        await x.libTab(tab); await away(x.page);
        const rows = await readRows(x.page, LIB);
        await x.page.mouse.move(rows[0].left + 80, rows[0].top + 12); await x.page.waitForTimeout(150);
        const hovered = await readRows(x.page, LIB);
        for (const r of [...rows, hovered[0]]) heights.add(r.h);
        seen.push(`${place} ${width} ${tab}: ${[...new Set(rows.map((r) => r.h))].join("/")} → ${hovered[0].h}`);
      }
    } finally { await (x.close ? x.close() : x.page.close()); }
  }
  assert.equal(heights.size, 1, `one height (${[...heights].join(", ")}): ${seen.join("; ")}`);
});

const tipNow = (page) => page.evaluate(() => { const tip = [...document.querySelectorAll(".tip, .dgc-tip")].find((n) => !n.hidden && n.getClientRects().length); if (!tip) return null; const r = tip.getBoundingClientRect();
  return { text: tip.textContent, top: r.top, bottom: r.bottom, left: r.left, right: r.right }; });
const LONG = ar(9), LONG_NAME = "A page with a name so long that it cannot fit on one line of a narrow side bar, whatever the width";
for (const [place, width] of [["side", 300], ["side", 700], ["tab", 700]]) {
  test(`${place} ${width}px: a long name ends in "…" and its label is the whole name, for the row under the pointer, never over that row's own words`, async (t) => {
    if (skipOrFail(t)) return;
    const first = { id: ar(1), type: "page", label: "Page", title: "Another name far too long for one line of the Library, at any width a side bar or a tab is given", version: 1, created: "ago:5", updated: "ago:1", origin: { surface: "cli" }, made_by: { kind: "cli", id: "", name: "" }, exports: ["html"] };
    const x = place === "side" ? await openLibraryTab(browser, { width }) : await openLibraryPage(browser, { width });
    try {
      const words = (key) => x.page.evaluate((k) => { const row = document.querySelector(`.lib-row[data-key="${k}"]`), name = row.querySelector(".lib-row-name"), meta = row.querySelector(".lib-row-meta"), b = (n) => { const r = n.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        row.scrollIntoView({ block: "center" }); return { name: b(name), meta: b(meta), row: b(row), cut: name.scrollWidth > name.clientWidth + 1, ellipsis: getComputedStyle(name).textOverflow, rowTitle: row.getAttribute("title") }; }, key);
      const w = await words(`artifact:${LONG}`); await x.rest(60);
      const at = await words(`artifact:${LONG}`);
      assert.equal(at.cut && at.ellipsis === "ellipsis", true, "the long name is cut with …");
      assert.equal(at.rowTitle, null, "the row itself carries no label: its words are on it");
      await x.page.mouse.move(at.name.left + 40, (at.name.top + at.name.bottom) / 2); await x.page.waitForTimeout(1100);
      const tip = await tipNow(x.page);
      assert.ok(tip, "pointing at the cut name shows its label");
      assert.equal(tip.text, LONG_NAME, "the whole name, and nothing else");
      const over = (a, b) => a.left < b.right - 0.5 && a.right > b.left + 0.5 && a.top < b.bottom - 0.5 && a.bottom > b.top + 0.5;
      assert.equal(over(tip, at.name) || over(tip, at.meta), false, "it never lies over its own row's words");
      assert.ok(Math.min(Math.abs(tip.bottom - at.row.top), Math.abs(tip.top - at.row.bottom), Math.abs(tip.bottom - at.name.top)) <= 10, "and it sits against its own row");
      // A name that fits has no label: nothing to add to what the row says.
      await away(x.page);
      const short = await words(`artifact:${ar(2)}`); await x.rest(60); const s2 = await words(`artifact:${ar(2)}`);
      assert.equal(s2.cut, false, "premise: a short name fits");
      await x.page.mouse.move(s2.name.left + 20, (s2.name.top + s2.name.bottom) / 2); await x.page.waitForTimeout(1100);
      assert.equal(await tipNow(x.page), null, "no label for a name that is all there");
      // The list drawn again under the pointer (something was made): a label never outlives its row.
      await away(x.page); await x.page.mouse.move(at.name.left + 40, (at.name.top + at.name.bottom) / 2); await x.page.waitForTimeout(1100);
      assert.ok(await tipNow(x.page), "premise: the label is up");
      await x.page.evaluate((place) => { const say = (m) => window.dispatchEvent(new MessageEvent("message", { data: place === "side" ? { type: "sideLibrary", message: m } : m })); window.__lib.artifacts = window.__lib.artifacts.filter((a) => !a.title.startsWith("A page with a name so long")); say({ type: "artifacts", items: window.__lib.artifacts }); }, place);
      await x.page.waitForTimeout(700);
      assert.equal(await tipNow(x.page), null, "its row gone, the label goes with it");
    } finally { await (x.close ? x.close() : x.page.close()); }
    // The first row has no room over it: its label goes under the row, never over the line under its name.
    const y = place === "side" ? await openLibraryTab(browser, { width, height: 420, artifacts: [first] }) : await openLibraryPage(browser, { width, height: 420, artifacts: [first] });
    try {
      await y.page.evaluate(() => { for (const n of document.querySelectorAll(".dgc-pagehead, .lib-bar, .lib-tabs, .lib-filters, #side-tabs")) n.style.display = "none"; }); await y.rest(80);
      const b = await y.page.evaluate(() => { const row = document.querySelector(".lib-row"), name = row.querySelector(".lib-row-name"), meta = row.querySelector(".lib-row-meta"), r = (n) => { const q = n.getBoundingClientRect(); return { top: q.top, bottom: q.bottom, left: q.left, right: q.right }; }; return { name: r(name), meta: r(meta), row: r(row) }; });
      if (b.name.top < 40) {
        await y.page.mouse.move(b.name.left + 40, (b.name.top + b.name.bottom) / 2); await y.page.waitForTimeout(1100);
        const tip = await tipNow(y.page);
        assert.ok(tip, "the first row's cut name has its label");
        assert.ok(tip.top >= b.meta.bottom - 0.5, `under the row's words, not over them (label ${Math.round(tip.top)}–${Math.round(tip.bottom)}, the line under the name ${Math.round(b.meta.top)}–${Math.round(b.meta.bottom)})`);
      }
    } finally { await (y.close ? y.close() : y.page.close()); }
  });
}

for (const [name, tab, sel, first, removeWord] of [["Work's sessions", "work", "#sessions-list .session-row", DOCK_SESSIONS[2].name, "Delete session…"], ["Chat's chats", "chat", "#chats-list .chat-row", CHATS[0].title, "Delete chat…"]]) {
  for (const width of [300, 360]) {
    test(`${name} at ${width}px: the row's ⋯ is there without pointing at it, and holds what the icons did (Open in editor, Pin, Delete); pointing at the row lays nothing over its name`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openDock(browser, { width, tab, pins: [] });
      try {
        await away(x.page);
        const rows = await readRows(x.page, sel);
        assert.ok(rows.length >= 2);
        for (const r of rows) { const more = r.buttons.find((b) => b.label.startsWith("More for")); assert.ok(more?.seen && more.tab, `${r.key || "a row"}: its ⋯ shows with no pointer on it, and Tab reaches it`);
          assert.deepEqual(seenLabels(r).filter((l) => !l.startsWith("More for")), [], "its other buttons are in the ⋯ here"); }
        const nameBox = () => x.page.evaluate((s) => { const n = document.querySelector(`${s} .session-name`), r = n.getBoundingClientRect(); return { w: Math.round(r.width), right: r.right }; }, sel);
        const idle = await nameBox();
        await x.page.mouse.move(rows[0].left + 60, rows[0].top + 12); await x.page.waitForTimeout(200);
        const hovered = (await readRows(x.page, sel))[0], hot = await nameBox();
        assert.deepEqual(seenLabels(hovered).filter((l) => !l.startsWith("More for")), [], "pointed at: still only the ⋯");
        assert.equal(hot.w, idle.w, "the name keeps its width: nothing is laid over it");
        assert.equal(hovered.h, rows[0].h, "and the row keeps its height");
        await x.page.locator(`${sel} .session-more`).first().click(); await x.page.waitForTimeout(300);
        const menu = await menuWords(x.page);
        assert.deepEqual(menu.filter((w) => w !== "Archive"), ["Open in editor", "Pin to the dock", removeWord], `its menu (${menu.join(" · ")})`);
        await x.page.locator(".dgc-pop .dgc-menu-row", { hasText: removeWord }).click(); await x.page.waitForTimeout(100);
        const asked = await x.posted(tab === "work" ? "deleteSession" : "chatdgcDelete");
        assert.equal(asked.length, 1, "Delete asks the host, as the row's own button does");
        assert.deepEqual(x.errors, []);
      } finally { await x.page.close(); }
    });
  }
  test(`${name}: a row is one height at 300, 360, 440 and 700px, and from 440 its icons still come to the pointer`, async (t) => {
    if (skipOrFail(t)) return;
    const heights = new Set();
    for (const width of WIDTHS) {
      const x = await openDock(browser, { width, tab, pins: [] });
      try {
        await away(x.page);
        const rows = await readRows(x.page, sel); rows.forEach((r) => heights.add(r.h));
        await x.page.mouse.move(rows[0].left + 60, rows[0].top + 12); await x.page.waitForTimeout(200);
        const hovered = (await readRows(x.page, sel))[0]; heights.add(hovered.h);
        if (width >= 440) assert.ok(seenLabels(hovered).some((l) => l.startsWith("Delete")), `${width}px: pointed at, its icons show as before`);
      } finally { await x.page.close(); }
    }
    assert.equal(heights.size, 1, `one height (${[...heights].join(", ")})`);
  });
}

for (const width of [300, 360]) {
  test(`the Pips list at ${width}px: a row's ⋯ is there without pointing at it; its menu has Open in editor and Pin to the dock, by pointer and by keyboard`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, api: 103 });
    try {
      await x.send({ type: "dock", pins: [] });                       // this window has a dock, with nothing pinned
      await x.page.mouse.move(2, 2); await x.page.waitForTimeout(150);
      const read = () => x.inPips((root) => [...root.querySelectorAll(".pips-one-list .pip-row-slot")].map((slot) => { const more = slot.querySelector(".job-more"), s = more && getComputedStyle(more), r = more?.getBoundingClientRect(), name = slot.querySelector(".pip-row-name")?.getBoundingClientRect();
        const shown = (n) => !!n && n.getClientRects().length > 0 && Number(getComputedStyle(n).opacity) > 0.5;
        return { name: slot.querySelector(".pip-row-name")?.textContent, more: !!more && shown(more) && r.width >= 14, tab: !!more && more.tabIndex >= 0, clear: !!more && !!name && name.right <= r.left + 0.5, open: shown(slot.querySelector(".job-open")), pin: shown(slot.querySelector(".job-pin:not(.job-more)")), h: Math.round(slot.getBoundingClientRect().height) }; }));
      const rows = await read();
      assert.ok(rows.length >= 3);
      for (const r of rows) { assert.equal(r.more, true, `${r.name}: its ⋯ shows with no pointer on it`); assert.equal(r.tab, true); assert.equal(r.clear, true, `${r.name}: the name ends before it`); assert.deepEqual([r.open, r.pin], [false, false], "Open in editor and the pin are in the ⋯ here"); }
      await x.inPips((root, id) => root.querySelector(`.pip-row-slot:has([data-job="${id}"]) .job-more`).click(), MORNINGS); await x.page.waitForTimeout(200);
      const menu = () => x.inPips((root) => [...root.querySelectorAll("#pip-row-menu .dgc-menu-row")].map((r) => r.textContent.trim()));
      assert.deepEqual(await menu(), ["Open in editor", "Pin to the dock"]);
      const inside = await x.inPips((root) => { const m = root.querySelector("#pip-row-menu").getBoundingClientRect(); return m.left >= 0 && m.right <= innerWidth + 0.5 && m.width > 120; });
      assert.equal(inside, true, "the menu is inside the side bar");
      await x.inPips((root) => [...root.querySelectorAll("#pip-row-menu .dgc-menu-row")].find((r) => /Open in editor/.test(r.textContent)).click()); await x.page.waitForTimeout(150);
      assert.equal((await x.posted("pipsOpenChat")).at(-1)?.pip?.id, MORNINGS, "Open in editor opens that Pip's chat in a tab");
      assert.deepEqual(await menu(), [], "and the menu closes");
      // The keyboard: Enter on the ⋯ opens it on its first row, Down moves, Escape closes and goes back to the ⋯.
      await x.inPips((root, id) => root.querySelector(`.pip-row-slot:has([data-job="${id}"]) .job-more`).focus(), MORNINGS);
      await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(200);
      assert.equal((await menu()).length, 2);
      await x.page.keyboard.press("ArrowDown"); await x.page.keyboard.press("ArrowDown"); await x.page.waitForTimeout(60);
      const focused = await x.inPips((root) => (root.activeElement || document.activeElement)?.textContent.trim());
      assert.match(focused, /Open in editor|Pin to the dock/, "the arrows move through its rows");
      await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(150);
      assert.deepEqual(await menu(), []);
      assert.equal(await x.inPips((root) => (root.activeElement || document.activeElement)?.classList.contains("job-more")), true, "Escape goes back to the ⋯");
      // Pin from the menu.
      await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(200);
      await x.inPips((root) => [...root.querySelectorAll("#pip-row-menu .dgc-menu-row")].find((r) => /Pin to the dock/.test(r.textContent)).click()); await x.page.waitForTimeout(150);
      assert.ok((await x.posted("dockToggle")).some((m) => m.item?.kind === "pip" && m.item.id === MORNINGS), "Pin to the dock, reached from the ⋯");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the Pips list from 440px keeps its icons for the pointer, with no ⋯, and a row is one height at every width", async (t) => {
  if (skipOrFail(t)) return;
  const heights = new Set();
  for (const width of WIDTHS) {
    const x = await openOnePips(browser, { width, api: 103, where: "side" });
    try {
      await x.send({ type: "dock", pins: [] }); await x.page.waitForTimeout(80);
      const got = await x.inPips((root) => { const slot = root.querySelector(".pips-one-list .pip-row-slot"), more = slot.querySelector(".job-more"); return { h: Math.round(slot.getBoundingClientRect().height), more: !!more && more.getClientRects().length > 0, open: !!slot.querySelector(".job-open") }; });
      heights.add(got.h);
      if (width >= 440) assert.deepEqual([got.more, got.open], [false, true], `${width}px: no ⋯; Open in editor comes to the pointer as before`);
    } finally { await x.close(); }
  }
  assert.equal(heights.size, 1, `one height (${[...heights].join(", ")})`);
});

for (const width of [300, 360]) {
  test(`Home's folders at ${width}px: a folder's New work here and its pin are in sight without pointing at it`, async (t) => {
    if (skipOrFail(t)) return;
    const grid = await import("./support/home-grid-scene.mjs");
    const x = await grid.openGrid(browser, { width, layout: ["folders"] });
    try {
      await x.page.waitForSelector(".hc-tile"); await away(x.page);
      const tiles = await readRows(x.page, ".hc-tile:not(.hc-gone)");
      assert.ok(tiles.length >= 1);
      for (const tile of tiles) { const labels = seenLabels(tile); assert.ok(labels.some((l) => /^New work in /.test(l)), `New work here shows (${labels.join(" | ")})`); assert.ok(labels.some((l) => /^Pin to the dock|^Unpin/.test(l)), "and its pin"); }
    } finally { await x.page.close(); }
  });
}
