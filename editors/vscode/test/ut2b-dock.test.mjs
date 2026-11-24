// User test round 2, B3, the dock. "Clear browsing data…" was the one row of Your Browser's menu with no icon (it named
// a mark the menu does not have). And a tile's name stopped coming after the dock had been used: the dock draws its
// tiles again whenever something on it changes (a Pip starts working in Your Browser, a session's state), and a drawing
// dropped the name that was up, and the one about to come to a resting pointer.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor, shot } from "./support/ut2b-common.mjs";
import { openDock, PINS, LIBRARY_PINS } from "./support/dock-scene.mjs";
import { homeState } from "./support/home-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);
const tip = (p) => p.evaluate(() => { const t = document.querySelector("#dgc-dock .dgc-dock-tip"); return t.hidden ? "" : t.querySelector("b").textContent; });
const tiles = (p) => p.evaluate(() => [...document.querySelectorAll(".dgc-dock-item[data-key]")].map((n) => { const r = n.getBoundingClientRect(); return { key: n.dataset.key, x: r.left + r.width / 2, y: r.top + r.height / 2 }; }));
/** The dock is told again, with one pin's state changed: it draws its tiles again. */
const redraw = (p, n) => p.evaluate((count) => { const state = window.__dock; state.pins = state.pins.map((pin, i) => (i === state.pins.length - 1 ? { ...pin, sub: `Page · version ${count + 10}` } : pin));
  window.dispatchEvent(new MessageEvent("message", { data: JSON.parse(JSON.stringify({ type: "dock", ...state })) })); }, n);

test("B3: a tile's name still comes to a resting pointer when the dock draws itself again, and stays up through a drawing", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await openDock(C.state.browser, { pins: [...PINS, LIBRARY_PINS[0]] });
  try {
    const p = x.page, [first] = await tiles(p);
    await p.mouse.move(first.x - 4, first.y); await p.mouse.move(first.x, first.y, { steps: 2 });
    await p.waitForTimeout(350);
    assert.equal(await tip(p), "", "premise: a name waits for the pointer to rest");
    await p.evaluate(() => { window.__first = document.querySelector(".dgc-dock-item[data-key]"); });
    await redraw(p, 1); await p.waitForTimeout(150);
    assert.equal(await p.evaluate(() => window.__first !== document.querySelector(".dgc-dock-item[data-key]")), true, "premise: the tiles were drawn again");
    await p.waitForTimeout(900);
    assert.equal(await tip(p), "Mail watch", "the pointer never moved: the tile under it is named all the same");
    await redraw(p, 2); await p.waitForTimeout(120);
    assert.equal(await tip(p), "Mail watch", "a name that is up stays up when the tiles are drawn again");
    assert.ok(await p.evaluate(() => { const b = document.querySelector(".dgc-dock-item[data-key]"); return b.getAttribute("aria-describedby") === document.querySelector(".dgc-dock-tip").id; }), "and belongs to the new tile");
    await shot(p, "b3-dock-name-dark-300");
    await p.mouse.move(10, 10); await p.waitForTimeout(200);
    assert.equal(await tip(p), "", "it goes with the pointer");
    await redraw(p, 3); await p.waitForTimeout(1000);
    assert.equal(await tip(p), "", "and a drawing brings no name back to a tile nobody points at");
    assert.deepEqual(x.errors || [], []);
  } finally { await x.page.close(); }
});

const withBrowser = () => ({ ...homeState(), browser: { recent: { links: [{ url: "https://news.example.org/", title: "News", host: "news.example.org" }], open: false, available: true, reason: "", install: null } } });
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`B3: every row of Your Browser's menu wears an icon (${theme}, ${width}px)`, async (t) => {
    if (C.skipOrFail(t)) return;
    const x = await openDock(C.state.browser, { width, height: 700, theme: theme.split("-")[0] === "light" ? "light-modern" : "dark-modern", api: 113, state: withBrowser() });
    try {
      const p = x.page;
      await p.waitForFunction(() => /Your Browser/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""), null, { timeout: 15000 });
      await p.locator('#dgc-dock .dgc-dock-item[data-key="browser"]').click({ button: "right" });
      await p.waitForSelector(".dgc-pop .dgc-menu-row");
      const rows = await p.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => { const svg = r.querySelector(".dgc-pop-icon svg"), b = svg?.getBoundingClientRect();
        return { label: r.querySelector(".dgc-menu-label").textContent, drawn: !!svg && svg.querySelectorAll("path, circle, rect, line, polyline").length > 0 && b.width >= 12 && b.height >= 12 }; }));
      await shot(p, `b3-dock-menu-${theme.split("-")[0]}-${width}`);
      assert.ok(rows.some((r) => r.label === "Clear browsing data…"), `premise: the row is there (${rows.map((r) => r.label)})`);
      for (const r of rows) assert.equal(r.drawn, true, `“${r.label}” has its icon`);
    } finally { await x.close(); }
  });
}
