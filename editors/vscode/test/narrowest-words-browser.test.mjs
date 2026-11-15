// The narrowest widths (live round 1, findings 28, 2, 5 and 6; 14 Nov): at VS Code's narrowest side bar (170 px) and
// at 220 and 300 px, on EVERY page and sub-page the polish pass walks (test/support/polish-scenes.mjs: Home and its
// cards, Work, Chat, the Pips list, a Pip's chat, page and settings, Settings, the agent map, the dialogs and menus):
//   - no word is drawn on more than one line: a heading never breaks inside a word ("Your Pips" stood one letter per
//     line beside its buttons; "Workflows" broke to "Workflow / s"). Buttons beside a heading turn to icons first,
//     then the heading ends in "…";
//   - no word is cut part-way with no "…" ("Trace" read "Tr" under an answer);
//   - no button's own words are cut, "…" or not (finding 45: a Pip's site card read "Allow…" and "Not n…" at 170 px):
//     the buttons go one under the other, or become icons;
//   - nothing has a sideways scrollbar it should not have (the composer's, at about 220 px), and the page itself never
//     runs off sideways;
//   - a card on Home never scrolls by itself (the Needs you card's own scrollbar).
// Measured with test/support/narrow-audit.mjs on the real pages in real Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { narrowAudit } from "./support/narrow-audit.mjs";
import { SCENES } from "./support/polish-scenes.mjs";
import { cleanup } from "./support/notes-host.mjs";
import { openGrid } from "./support/home-grid-scene.mjs";
import { homeState } from "./support/home-scene.mjs";

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
after(async () => { await browser?.close(); cleanup(); });

// Boxes that scroll sideways on purpose: what they hold is wider than any side bar by its nature.
const SCROLLS_ON_PURPOSE = /(^|> )pre\b|\bcode\b|table|\.katex|\.mermaid|\.dgc-sheet|\.cv-/;
const WIDTHS = [170, 220, 300];

for (const scene of Object.keys(SCENES)) for (const width of WIDTHS) {
  test(`${scene} at ${width} px: no word on two lines, none cut without “…”, no button's words cut, no sideways scrollbar, no card scrolling by itself`, async (t) => {
    if (skipOrFail(t)) return;
    const found = { broken: [], cut: [], clipped: [], sideways: [], inner: [], page: [] }, states = [];
    await SCENES[scene](browser, { width, theme: "dark", touch: false }, async (state, page, o = {}) => {
      await page.mouse.move(1, 1);
      await page.evaluate(() => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, 120)))));
      const a = await page.evaluate(narrowAudit, { scope: o.scope || "" });
      states.push(state);
      for (const key of ["broken", "cut", "clipped", "sideways", "inner"]) for (const x of a[key]) {
        if (key === "sideways" && SCROLLS_ON_PURPOSE.test(x.what)) continue;
        const line = key === "broken" ? `${state}: “${x.text}” on ${x.lines} lines in ${x.what} (${x.box}px)` : key === "cut" ? `${state}: “${x.text}” cut by ${x.hidden}px in ${x.what} (by ${x.by})`
          : key === "clipped" ? `${state}: the button “${x.text}” is cut by ${x.hidden}px in ${x.what} (by ${x.by})` : `${state}: ${x.what} ${key === "inner" ? "scrolls by itself" : "scrolls sideways"}: ${x.text}`;
        if (!found[key].includes(line)) found[key].push(line);
      }
      if (a.page) found.page.push(state);
    });
    assert.ok(states.length > 0, "the scene showed something");
    t.diagnostic(`${scene} ${width}px: ${states.length} states`);
    assert.deepEqual(found, { broken: [], cut: [], clipped: [], sideways: [], inner: [], page: [] });
  });
}

// The Needs you card's own scrollbar (finding 6): on a wide Home the card held one row and "Show 1 more" and was one
// pixel short for them, so it drew a scrollbar of its own. A card on Home never scrolls by itself, at any width: what
// does not fit is behind "Show more", which opens the card.
for (const width of [300, 440, 560, 700, 940, 1200]) {
  test(`Home at ${width} px, two things waiting: the Needs you card does not scroll by itself, by a pixel either`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openGrid(browser, { width, theme: "dark-modern", layout: ["needs", "recent", "clock", "running"], state: homeState("busy"), height: 700 });
    try {
      await x.rest(500);
      const a = await x.page.evaluate(narrowAudit, {});
      const card = await x.page.evaluate(() => { const c = document.querySelector('.hc-grid .hc-card[data-card="needs"]'), s = getComputedStyle(c); return { over: c.scrollHeight - c.clientHeight, scrolls: /auto|scroll/.test(s.overflowY), text: c.innerText.replace(/\s+/g, " ") }; });
      assert.deepEqual(a.inner, [], "no card scrolls by itself");
      assert.equal(card.scrolls, false, "the card is never a scroller");
      assert.ok(card.over <= 0, `what it shows fits it: ${card.over}px over`);
      assert.match(card.text, /Needs you/);
    } finally { await x.close(); }
  });
}
