// Your Browser on the side bar (Pips API 107; his calls, 17 Nov), measured in real Chromium on the side bar's real page
// (support/dock-scene.mjs and support/home-scene.mjs):
//   - the dock: Your Browser is always there, just before "+", on the right of the "|" divider with it. It can't be
//     unpinned or moved, nothing is dropped past it, and a click opens Your Browser to the right of the editor (the page
//     sends where the editor's window is and its screen's work area). An open DGC refuses says why on the tile.
//   - Home's Browser card: a search field and, under it, the last links visited there. What is typed (a search or an
//     address) opens Your Browser with it; a link opens that link. Small, Medium and Large, both themes, every width from
//     170 to 1200 px, nothing past the card's edge.
//   - an older DGC (API 106) shows neither the dock item nor the card, and the card library doesn't offer it.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow, PINS } from "./support/dock-scene.mjs";
import { openHome, homeState } from "./support/home-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
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

const LINKS = [
  { url: "https://news.example.org/today", title: "Today's news: the long headline that keeps going past the card", host: "news.example.org", at: "2026-11-18T09:00:00Z" },
  { url: "https://mail.example.net/inbox", title: "Inbox (3)", host: "mail.example.net", at: "2026-11-18T08:00:00Z" },
  { url: "https://docs.python.org/3/library/", title: "The Python Standard Library", host: "docs.python.org", at: "2026-11-18T07:00:00Z" },
];
const withBrowser = (more = {}) => ({ ...homeState(), browser: { recent: { links: LINKS, open: false, available: true, reason: "" }, ...more } });
const requests = (page, type) => page.evaluate((t) => window.__requests.filter((r) => r.type === t), type);
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];

// ---- the dock ---------------------------------------------------------------------------------------------------------
test("the dock: Your Browser sits just before +, on the right of the divider, and opens to the right of the editor", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 440, height: 700, api: 107, state: withBrowser() });
  try {
    await waitFor(x.page, () => !!document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]'));
    const d = await dockNow(x.page), keys = d.items.map((i) => i.key);
    assert.deepEqual(keys.slice(-2), ["browser", "+"], "Browser, then +, last");
    assert.deepEqual(keys.slice(0, PINS.length), PINS.map((p) => p.key), "the pinned items keep their order before it");
    const sep = await x.page.evaluate(() => document.querySelector("#dgc-dock .dgc-dock-sep").getBoundingClientRect().left);
    const tile = d.items.find((i) => i.key === "browser");
    assert.ok(sep < tile.left && tile.right <= d.items.at(-1).left, "on the right of the | divider, before +");
    assert.ok(d.bar.left >= 7.5 && d.bar.right <= d.width - 7.5, "the bar still keeps 8 px from each edge");
    const halo = await x.page.evaluate(() => { const h = document.querySelector('#dgc-dock [data-key="browser"] .halo'), t = h?.closest(".dgc-dock-tile"); if (!h) return null; const a = h.getBoundingClientRect(), b = t.getBoundingClientRect(); return { inside: a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, share: a.width / b.width }; });
    assert.ok(halo, "his Halo is its mark");
    assert.ok(halo.inside && halo.share > 0.6 && halo.share < 0.8, `the Halo sits in its tile, as a mark does (${JSON.stringify(halo)})`);
    // A click opens it, with where the editor's window is.
    await x.page.mouse.click(...centre(tile));
    await waitFor(x.page, () => window.__requests.some((r) => r.type === "open_your_browser"));
    const [asked] = await requests(x.page, "open_your_browser");
    assert.equal(asked.url, undefined, "nothing typed: its window comes forward");
    for (const name of ["x", "y", "width", "height"]) assert.equal(typeof asked.editor_bounds[name], "number", name);
    assert.ok(asked.editor_bounds.width > 0 && asked.editor_bounds.screen.width > 0, JSON.stringify(asked.editor_bounds));
  } finally { await x.close(); }
});

test("the dock: Your Browser can't be unpinned, moved or passed", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 700, height: 700, api: 107, state: withBrowser() });
  try {
    await waitFor(x.page, () => !!document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]'));
    let d = await dockNow(x.page);
    // Its menu: Open alone.
    const tile = d.items.find((i) => i.key === "browser");
    await x.page.mouse.click(...centre(tile), { button: "right" });
    await waitFor(x.page, () => document.querySelectorAll(".dgc-pop .dgc-menu-row").length > 0);
    d = await dockNow(x.page);
    assert.deepEqual(d.menu, ["Open Your Browser"]);
    await x.page.keyboard.press("Escape");
    // Dragged: nothing moves, and nothing is posted.
    const before = (await dockNow(x.page)).items.map((i) => i.key);
    await x.page.mouse.move(...centre(tile)); await x.page.mouse.down();
    await x.page.mouse.move(d.items[0].left + 4, tile.top + tile.height / 2, { steps: 8 }); await x.page.mouse.up();
    await x.settle();
    assert.deepEqual((await dockNow(x.page)).items.map((i) => i.key), before);
    assert.equal((await x.posted("dockPlace")).length, 0);
    // A pinned item dragged past it lands before it: nothing is dropped past it.
    const first = (await dockNow(x.page)).items[0], plus = (await dockNow(x.page)).items.at(-1);
    await x.page.mouse.move(...centre(first)); await x.page.mouse.down();
    await x.page.mouse.move(plus.right + 20, first.top + first.height / 2, { steps: 12 }); await x.page.mouse.up();
    await x.settle();
    const keys = (await dockNow(x.page)).items.map((i) => i.key);
    assert.deepEqual(keys.slice(-2), ["browser", "+"]);
    // Alt+Left on it says where it stays.
    await x.page.focus('#dgc-dock [data-key="browser"]');
    await x.page.keyboard.press("Alt+ArrowLeft");
    assert.match(await x.page.evaluate(() => document.querySelector("#dgc-dock .dgc-dock-live").textContent), /Always here/);
    assert.deepEqual((await dockNow(x.page)).items.map((i) => i.key).slice(-2), ["browser", "+"]);
  } finally { await x.close(); }
});

test("the dock: an open DGC refuses says why on the tile", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 440, height: 700, api: 107, state: withBrowser({ refuse: "Your Browser opens with the Pips runner, which isn't running." }) });
  try {
    await waitFor(x.page, () => !!document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]'));
    const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
    await x.page.mouse.click(...centre(tile));
    await waitFor(x.page, () => { const tip = document.querySelector("#dgc-dock .dgc-dock-tip"); return tip && !tip.hidden && /runner/.test(tip.textContent); });
    const d = await dockNow(x.page);
    assert.equal(d.tip.title, "Your Browser");
    assert.ok(d.tip.left >= 0 && d.tip.right <= d.width, "the note stays on the page");
  } finally { await x.close(); }
});

test("an older DGC shows no Browser on the dock and offers no Browser card", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 440, height: 700, api: 106, state: withBrowser(), tab: "home", grid: true });
  try {
    const d = await dockNow(x.page);
    assert.ok(!d.items.some((i) => i.key === "browser"));
    assert.equal(d.items.at(-1).key, "+");
    await x.page.click("#home-hub .hc-cards-btn");
    await waitFor(x.page, () => document.querySelectorAll(".hc-lib-item").length > 3);
    assert.equal(await x.page.evaluate(() => !!document.querySelector('.hc-lib-item[data-card="browser"]')), false);
    assert.equal((await requests(x.page, "get_your_browser_recent")).length, 0, "an older DGC is never asked");
  } finally { await x.close(); }
});

// ---- Home's Browser card --------------------------------------------------------------------------------------------------
/** Home with the Browser card on it (kept as the host keeps the layout), at `width`. */
async function homeWithCard(width, theme = "dark-modern", state = withBrowser(), height = 900) {
  const x = await openHome(browser, { width, height, theme, api: 107, state, grid: true, tab: "home" });
  await x.send({ type: "homeCards", order: ["browser", "needs", "quick"], settings: {} });
  await waitFor(x.page, () => !!document.querySelector('#home-hub .hc-grid .hc-card[data-card="browser"] .hc-url'));
  await waitFor(x.page, () => document.querySelectorAll('#home-hub .hc-grid .hc-card[data-card="browser"] .hc-link').length > 0);
  return x;
}
const card = (page) => page.evaluate(() => {
  const c = document.querySelector('#home-hub .hc-grid .hc-card[data-card="browser"]'), r = c.getBoundingClientRect();
  const inside = [...c.querySelectorAll(".hc-url, .hc-go, .hc-link, .hc-nm, .hc-lbl, .hc-ct, .hc-browse-why")].filter((n) => n.checkVisibility())
    .map((n) => { const b = n.getBoundingClientRect(); return { what: n.className, left: b.left, right: b.right, bottom: b.bottom, overflows: n.scrollWidth > n.clientWidth + 1 && !/hc-nm|hc-meta/.test(n.className) }; });
  return { form: c.dataset.form, left: r.left, right: r.right, top: r.top, bottom: r.bottom, links: [...c.querySelectorAll(".hc-link")].map((b) => b.dataset.browse),
    titles: [...c.querySelectorAll(".hc-link .hc-nm")].map((n) => n.textContent), inside, pageOverflow: document.documentElement.scrollWidth > innerWidth };
});

test("Home's Browser card: a search field and the last links; typing or a link opens Your Browser", async (t) => {
  if (skipOrFail(t)) return;
  const x = await homeWithCard(440);
  try {
    const c = await card(x.page);
    assert.equal(c.form, "m");
    assert.deepEqual(c.links, LINKS.map((l) => l.url), "the newest three, newest first");
    assert.equal(c.titles[1], "Inbox (3)");
    await x.page.fill('#home-hub .hc-card[data-card="browser"] .hc-url', "weather in pune");
    await x.page.keyboard.press("Enter");
    await waitFor(x.page, () => window.__requests.some((r) => r.type === "open_your_browser"));
    let asked = await requests(x.page, "open_your_browser");
    assert.equal(asked[0].url, "weather in pune", "DGC makes it a search or an address");
    assert.ok(asked[0].editor_bounds?.screen, "with where the editor is");
    assert.equal(await x.page.inputValue('#home-hub .hc-card[data-card="browser"] .hc-url'), "", "the field is ready for the next");
    await x.page.click(`#home-hub .hc-card[data-card="browser"] .hc-link[data-browse="${LINKS[1].url}"]`);
    await waitFor(x.page, () => window.__requests.filter((r) => r.type === "open_your_browser").length === 2);
    asked = await requests(x.page, "open_your_browser");
    assert.equal(asked[1].url, LINKS[1].url);
    // An empty field opens nothing.
    await x.page.click('#home-hub .hc-card[data-card="browser"] .hc-go');
    await x.page.waitForTimeout(150);
    assert.equal((await requests(x.page, "open_your_browser")).length, 2);
  } finally { await x.close(); }
});

test("Home's Browser card in the card library, and why it can't open here", async (t) => {
  if (skipOrFail(t)) return;
  const reason = "Your Browser needs Google Chrome's own sandbox, which this Ubuntu keeps from DGC's copy of Chrome. Run this once in a terminal, then open it again: printf 'abi <abi/4.0>,...' '/home/someone/.dgc/desktop/arm64/v-*/root/opt/google/chrome/chrome' | sudo tee /etc/apparmor.d/dgc-chrome";
  const x = await openHome(browser, { width: 440, height: 900, api: 107, state: withBrowser({ recent: { links: [], open: false, available: false, reason } }), grid: true, tab: "home" });
  try {
    await x.page.click("#home-hub .hc-cards-btn");
    await waitFor(x.page, () => !!document.querySelector('.hc-lib-item[data-card="browser"] .hc-add'));
    assert.match(await x.page.evaluate(() => document.querySelector('.hc-lib-item[data-card="browser"]').textContent), /Browser.*Search or type an address/);
    await x.page.click('.hc-lib-item[data-card="browser"] .hc-add');
    await x.page.keyboard.press("Escape");
    await waitFor(x.page, () => !!document.querySelector('#home-hub .hc-grid .hc-card[data-card="browser"] .hc-browse-why'));
    const why = await x.page.evaluate(() => { const n = document.querySelector('#home-hub .hc-card[data-card="browser"] .hc-browse-why'), c = n.closest(".hc-card").getBoundingClientRect(), r = n.getBoundingClientRect(); return { text: n.textContent, inside: r.left >= c.left && r.right <= c.right + 0.5 }; });
    assert.match(why.text, /sandbox/);
    assert.ok(why.inside, "its words stay inside the card");
    assert.equal(await x.page.evaluate(() => !!document.querySelector('#home-hub .hc-card[data-card="browser"] .hc-link')), false);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [170, 300, 440, 700, 1200]) {
    test(`Home's Browser card at ${width}px (${theme}): its form, its links, nothing past its edge`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await homeWithCard(width, theme);
      try {
        const c = await card(x.page);
        assert.equal(c.form, width < 380 ? "s" : "m", "Small under 380 px, else Medium (it has no Large form)");
        assert.equal(c.links.length, width < 380 ? 2 : width >= 620 ? 2 : 3, "two on a Small card or a short Large-grid row, three on a Medium one");
        assert.equal(c.pageOverflow, false, "no sideways scroll");
        for (const part of c.inside) {
          assert.ok(part.left >= c.left - 0.5 && part.right <= c.right + 0.5, `${part.what} stays inside the card (${part.left}-${part.right} in ${c.left}-${c.right})`);
          assert.ok(part.bottom <= c.bottom + 0.5, `${part.what} isn't cut at the card's foot`);
          assert.equal(part.overflows, false, `${part.what} isn't cut sideways`);
        }
        if (width < 380) {
          const halo = await x.page.evaluate(() => { const h = document.querySelector('#home-hub .hc-card[data-card="browser"] .hc-lbl .halo'); return h ? h.getBoundingClientRect().width : 0; });
          assert.ok(halo > 10 && halo < 18, `the Small card's Halo is a label's size (${halo})`);
        }
        const field = await x.page.evaluate(() => { const f = document.querySelector('#home-hub .hc-card[data-card="browser"] .hc-url'), s = getComputedStyle(f); return { radius: s.borderTopLeftRadius, height: f.getBoundingClientRect().height }; });
        assert.equal(field.radius, "6px", "one design language: 6 px corners, never a pill");
        assert.ok(field.height >= 24 && field.height <= 28, `the cards' field height (${field.height})`);
      } finally { await x.close(); }
    });
  }
}
