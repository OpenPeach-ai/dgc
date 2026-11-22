// Home's Artifacts card and the Library's favorites (0.52): a star in the card's head. Pressed, the card shows only the
// artifacts starred in the Library and the star is filled, in the accent; pressed again, all of them. The host keeps
// which (a reload finds it as it was left), and says which artifacts are favorites. In real Chromium on the real side
// bar (support/home-grid-scene.mjs, with a stand-in for the host), at 300, 440 and 700 px, dark and light: at 300 px
// the card is Small (it opens whole when pressed, and its star is in the opened card's head; the Small card says
// "only favorites" with a small filled star beside its name). Pictures go to DGC_SHOTS when it names a folder.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { openGrid, ARTIFACTS } from "./support/home-grid-scene.mjs";

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
const SHOTS = process.env.DGC_SHOTS || "";
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/home-artifacts-${name}.png` }); };

// Six artifacts; the second and the fifth are favorites.
const STARRED = ARTIFACTS.map((a, k) => (k === 1 || k === 4 ? { ...a, favorite: true } : a));
const LAYOUT = ["artifacts", "recent"];
/** The Artifacts card as drawn, in the grid or opened whole. */
const cardNow = (page) => page.evaluate(() => {
  const probe = document.createElement("span"); probe.style.color = "var(--accent-text)"; document.body.append(probe);
  const accent = getComputedStyle(probe).color; probe.remove();
  const hub = document.getElementById("home-hub"), opened = hub.querySelector(".hc-open:not([hidden]) .hc-card[data-card='artifacts']"), card = opened || hub.querySelector(".hc-grid .hc-card[data-card='artifacts']");
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const star = card.querySelector(".hc-fav"), cs = star ? getComputedStyle(star) : null, svg = star?.querySelector("svg"), link = card.querySelector(".hc-all"), name = card.querySelector(".hc-ct"), mark = card.querySelector(".hc-favmark");
  return { accent, form: card.dataset.form, opened: !!opened, tiles: [...card.querySelectorAll(".hc-mtile .hc-tile-t")].map((n) => n.textContent), quiet: card.querySelector(".hc-quiet, .hc-sub")?.textContent || "",
    star: star ? { tag: star.tagName, pressed: star.getAttribute("aria-pressed"), label: star.getAttribute("aria-label"), icon: svg?.dataset.icon || "", fill: svg?.getAttribute("fill") || "", color: cs.color, radius: parseFloat(cs.borderTopLeftRadius), ...box(star), w: star.offsetWidth, h: star.offsetHeight } : null,
    link: link ? box(link) : null, name: name ? box(name) : null, mark: mark ? { color: getComputedStyle(mark).color, icon: mark.querySelector("svg")?.dataset.icon || "" } : null, card: box(card),
    cap: card.querySelector(".hc-cap")?.textContent || "", count: card.querySelector(".hc-cnt")?.textContent || "", pages: card.querySelectorAll(".hc-dot").length,
    live: hub.querySelector(".hc-live")?.textContent || "", sideways: document.documentElement.scrollWidth > innerWidth + 1, focus: document.activeElement?.className || "" };
});

test("a DGC that keeps no favorites: the Artifacts card has no star, and shows every artifact", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700, layout: LAYOUT, artifacts: STARRED, settings: { artifacts: { favorites: true } } });
  try {
    const c = await cardNow(x.page);
    assert.equal(c.star, null); assert.equal(c.tiles.length, 4, "a Large card's four, of all six"); assert.equal(c.pages, 2);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const theme of ["dark", "light"]) {
  for (const width of [440, 700]) {
    test(`${theme} ${width}px: the star in the Artifacts card's head shows only the favorites, filled in the accent; pressed again, all; the host keeps it`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openGrid(browser, { width, theme: `${theme}-modern`, layout: LAYOUT, artifacts: STARRED, favorites: true });
      try {
        const p = x.page, per = width >= 620 ? 4 : 2;
        let c = await cardNow(p);
        assert.deepEqual([c.star.tag, c.star.pressed, c.star.label, c.star.icon, c.star.fill], ["BUTTON", "false", "Show only favorites", "favorite", "none"]);
        assert.deepEqual([c.star.w, c.star.h, c.star.radius], [26, 26, 6], "the card heads' icon button: its size and 6 px corner");
        assert.ok(c.star.left >= c.name.right && c.star.right <= c.link.left + 0.5, "in the head, between the card's name and All artifacts");
        assert.ok(c.link.right <= c.card.right + 0.5 && c.star.top >= c.card.top, "inside the card");
        assert.equal(c.tiles.length, per); assert.equal(c.pages, Math.ceil(6 / per));
        await x.rest(600); await shot(p, `all-${theme}-${width}`);
        await p.click('.hc-grid .hc-card[data-card="artifacts"] .hc-fav'); await x.rest(300);
        c = await cardNow(p);
        assert.deepEqual([c.star.pressed, c.star.icon, c.star.fill, c.star.label], ["true", "unfavorite", "currentColor", "Showing only favorites. Show all artifacts"]);
        assert.equal(c.star.color, c.accent, "filled in the accent's text tone, from its token");
        assert.deepEqual(c.tiles, [STARRED[1].title, STARRED[4].title], "only the favorites, the newest first");
        assert.equal(c.pages, 1); assert.equal(c.live, "Artifacts: showing only your favorites.");
        assert.equal(c.focus.includes("hc-fav"), true, "the keyboard stays on the star");
        assert.equal(c.sideways, false);
        assert.deepEqual((await x.host()).settings.artifacts, { favorites: true }, "the host is told, and keeps it");
        await shot(p, `favorites-${theme}-${width}`);
        // A tile still opens its artifact.
        await p.click(`.hc-grid .hc-card[data-card="artifacts"] button[data-tile="${STARRED[4].id}"]`); await x.rest(150);
        // Pressed again from the keyboard: all of them.
        await p.focus('.hc-grid .hc-card[data-card="artifacts"] .hc-fav'); await p.keyboard.press("Enter"); await x.rest(300);
        c = await cardNow(p);
        assert.equal(c.star.pressed, "false"); assert.equal(c.tiles.length, per); assert.equal(c.live, "Artifacts: showing all.");
        assert.equal((await x.host()).settings.artifacts.favorites, false);
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    });
  }

  test(`${theme} 300px: a Small Artifacts card says it shows only favorites, and its star is in the card opened whole`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width: 300, theme: `${theme}-modern`, layout: LAYOUT, artifacts: STARRED, favorites: true });
    try {
      const p = x.page;
      let c = await cardNow(p);
      assert.equal(c.form, "s"); assert.equal(c.star, null, "a Small card is one button: it opens whole"); assert.equal(c.mark, null); assert.equal(c.count, "6");
      await shot(p, `all-${theme}-300`);
      await p.click('.hc-grid .hc-card[data-card="artifacts"]'); await x.rest(350);
      c = await cardNow(p);
      assert.equal(c.opened, true); assert.equal(c.tiles.length, 6);
      assert.deepEqual([c.star.pressed, c.star.w, c.star.h, c.star.radius], ["false", 26, 26, 6]);
      assert.ok(c.star.right <= c.link.left + 0.5 && c.link.right <= c.card.right + 0.5 && c.star.left >= c.name.right, "the star fits the head at 300 px");
      await shot(p, `open-all-${theme}-300`);
      await p.click(".hc-open .hc-fav"); await x.rest(300);
      c = await cardNow(p);
      assert.deepEqual([c.star.pressed, c.tiles.length], ["true", 2]); assert.equal(c.star.color, c.accent); assert.match(c.cap, /^2 favorites, newest first$/);
      assert.equal(c.focus.includes("hc-fav"), true); assert.equal(c.sideways, false);
      await shot(p, `open-favorites-${theme}-300`);
      // Back on Home, the Small card shows the favorites, and says so beside its name.
      await p.click("#home-hub .hc-back"); await x.rest(350);
      c = await cardNow(p);
      assert.deepEqual([c.form, c.count, c.tiles], ["s", "2", [STARRED[1].title]]);
      assert.deepEqual([c.mark?.icon, c.mark?.color], ["unfavorite", c.accent], "a small filled star, in the accent");
      await shot(p, `favorites-${theme}-300`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("only favorites, and none starred: one line says so, with the star still there to press; a reload finds the star as it was left", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 440, layout: LAYOUT, artifacts: ARTIFACTS, favorites: true, settings: { artifacts: { favorites: true } } });
  try {
    const p = x.page;
    let c = await cardNow(p);
    assert.equal(c.star.pressed, "true", "kept by the host: on from the start");
    assert.deepEqual(c.tiles, []); assert.equal(c.quiet, "No favorites here yet. Star an item to keep it here.");
    await shot(p, "empty-dark-440");
    // Starred in the Library since: the host says the artifacts again, and the card shows it.
    await p.evaluate((items) => window.dispatchEvent(new MessageEvent("message", { data: { type: "homeArtifacts", offered: true, favorites: true, items } })), ARTIFACTS.map((a, k) => (k === 2 ? { ...a, favorite: true } : a)));
    await x.rest(250);
    c = await cardNow(p);
    assert.deepEqual(c.tiles, [ARTIFACTS[2].title]);
    await p.click('.hc-grid .hc-card[data-card="artifacts"] .hc-fav'); await x.rest(300);
    assert.equal((await cardNow(p)).tiles.length, 2);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
  const small = await openGrid(browser, { width: 300, layout: LAYOUT, artifacts: ARTIFACTS, favorites: true, settings: { artifacts: { favorites: true } } });
  try {
    const c = await cardNow(small.page);
    assert.equal(c.quiet, "No favorites yet"); assert.equal(c.mark?.icon, "unfavorite");
    assert.deepEqual(small.errors, []);
  } finally { await small.close(); }
});
