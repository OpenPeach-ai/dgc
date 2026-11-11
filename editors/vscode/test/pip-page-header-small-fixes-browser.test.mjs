// Small things from the 0.51 checks on a Pip's pages (src/pipsClient.js, src/pips.css), in real Chromium with the real
// client and its CSS, dark and light:
//  - at 300 px a page's header cut the Pip's name ("Morni…  History"; "M…  Notifications") while the word beside it
//    kept its whole width, and History's first line ran to six lines. The name keeps its room (the page's word gives
//    way first, and goes in a narrow bar, as a conversation's name does); History says what it is in two lines.
//  - Pips opened from a report card (its run, under History) says whose page it is: the Pip's name, whole, in the
//    side bar and in a tab.
// DGC_SMALL_FIXES_SHOTS=<folder> (and DGC_SMALL_FIXES_TAG=before|after) also writes the pictures.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { client, openChat, PIP } from "./support/pip-chat-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : "";
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
await client();   // built before the first test is registered (a pending top-level await would end the file early)

const SHOTS = process.env.DGC_SMALL_FIXES_SHOTS || "", TAG = process.env.DGC_SMALL_FIXES_TAG || "after";
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: join(SHOTS, `${name}-${TAG}.png`) }); };

/** The page's header as drawn: the Pip's name (whole or cut), the word beside it, and whether anything left the bar. */
const header = () => {
  const root = window.__pipsRoot || document, bar = root.querySelector(".pip-topbar");
  if (!bar) return null;
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && n.getBoundingClientRect().width > 0;
  const pill = bar.querySelector(".pip-pill");
  // Cut by any part of a pixel (an ellipsis is drawn for less than one): the words' own width against their box's.
  const cut = (n) => { const range = document.createRange(); range.selectNodeContents(n); const over = range.getBoundingClientRect().width - n.getBoundingClientRect().width; return over > 0.01 ? Math.ceil(over) : 0; };
  const name = pill.querySelector(".pip-convs-name") || pill.querySelector(":scope > span:not(.avatar)"), word = pill.querySelector(":scope > small");
  const b = bar.getBoundingClientRect(), acts = bar.querySelector(".topbar-actions")?.getBoundingClientRect(), p = pill.getBoundingClientRect();
  return { name: name?.textContent || "", nameSeen: seen(name), nameCut: name ? cut(name) : 0, nameWidth: name ? Math.round(name.getBoundingClientRect().width) : 0,
    word: seen(word) ? word.textContent : "", wordCut: seen(word) ? word.scrollWidth - word.clientWidth : 0,
    overlaps: !!acts && p.right > acts.left + 0.5, sideways: bar.scrollWidth > bar.clientWidth + 1 || b.right > innerWidth + 0.5, lines: Math.round(b.height) };
};
/** How many lines a block of the page takes. */
const linesOf = (selector) => {
  const root = window.__pipsRoot || document, node = root.querySelector(selector);
  if (!node) return null;
  const range = document.createRange(); range.selectNodeContents(node);
  return { text: node.textContent, lines: new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top))).size };
};
const goTo = async (p, tab) => { await p.click(".pip-menu > summary"); await p.click(`.pip-menu [data-tab="${tab}"]`); await p.waitForTimeout(250); };
const INTRO = '.simple-content[data-view="runs"] .section > p.muted';

for (const theme of ["dark", "light"]) {
  test(`${theme} 300px: a Personal Pip's pages keep its name whole in the header, and History's first line is short`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width: 300, theme, settings: true });
    t.after(x.close);
    const seenOn = {};
    for (const [tab, word] of [["runs", "History"], ["notifications", "Notifications"], ["revisions", "Versions"], ["job", "Settings"]]) {   // (Settings last: its menu is its own)
      await goTo(x.p, tab);
      seenOn[word] = await x.p.evaluate(header);
      if (tab === "runs") { seenOn.intro = await x.p.evaluate(linesOf, INTRO); await shot(x.p, `pip-history-300-${theme}`); }
      if (tab === "job") await shot(x.p, `pip-settings-300-${theme}`);
      if (tab === "notifications") await shot(x.p, `pip-notifications-300-${theme}`);
    }
    assert.deepEqual(x.errors, []);
    for (const word of ["History", "Settings", "Notifications", "Versions"]) {
      const h = seenOn[word];
      assert.deepEqual([h.name, h.nameSeen, h.nameCut], ["Mornings", true, 0], `${word}: the name is whole: ${JSON.stringify(h)}`);
      assert.deepEqual([h.overlaps, h.sideways, h.wordCut], [false, false, 0], `${word}: nothing runs into the buttons, and no half word: ${JSON.stringify(h)}`);
      assert.ok(h.lines <= 52, `${word}: the header is one line (${h.lines}px)`);
    }
    // History: what it is, in at most three lines at 300 px (it ran to six), still saying where else a result is.
    assert.ok(seenOn.intro.lines <= 3, `History's first line takes ${seenOn.intro.lines} lines: "${seenOn.intro.text}"`);
    assert.match(seenOn.intro.text, /Mornings/);
    assert.match(seenOn.intro.text, /newest first/);
    assert.match(seenOn.intro.text, /in its chat/);
    // Nothing has run and it has no schedule: how to get a result is still said, once.
    await x.p.click("#simple-to-chat"); await x.p.waitForSelector("#chat-form");
    await goTo(x.p, "runs");
    const history = await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('.simple-content[data-view="runs"]').textContent);
    assert.match(history, /No results yet\./);
    assert.equal(history.split("every morning, send me the news").length - 1, 1, "the example of a schedule is said once");
  });

  test(`${theme} 300px: a Project Pip's header keeps its name whole, in its chat and on its pages`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width: 300, theme, project: true });
    t.after(x.close);
    const chat = await x.p.evaluate(header);
    await shot(x.p, `pip-project-chat-300-${theme}`);
    assert.deepEqual([chat.name, chat.nameSeen, chat.nameCut], ["Billing review", true, 0], `its chat: ${JSON.stringify(chat)}`);
    assert.deepEqual([chat.overlaps, chat.sideways], [false, false]);
    for (const tab of ["runs", "schedule", "handoffs"]) {
      await goTo(x.p, tab);
      const h = await x.p.evaluate(header);
      assert.deepEqual([h.name, h.nameSeen, h.nameCut, h.overlaps, h.sideways], ["Billing review", true, 0, false, false], `${tab}: ${JSON.stringify(h)}`);
    }
    assert.deepEqual(x.errors, []);
  });

  // What a report card's Open sends: the Pip, History, and the run (media/main.js openReport).
  const FROM_CARD = { pip: PIP, section: "runs", run: "run_" + "a".repeat(32) };
  for (const [where, width] of [["side", 300], ["tab", 300], ["tab", 760]]) {
    test(`${theme} ${where} ${width}px: Pips opened from a report card says whose page it is`, async (t) => {
      if (skipOrFail(t)) return;
      // From the list of Pips, as when Pips was not open on that Pip before.
      const x = await openChat(browser, { width, theme, where, home: true, ran: true });
      t.after(x.close);
      await x.p.evaluate(([nav, side]) => (side ? window.__pipsApp.navigate(nav) : window.postMessage({ type: "pipsNavigate", navigation: nav }, "*")), [FROM_CARD, where === "side"]);
      await x.p.waitForSelector('.simple-content[data-view="runs"]');
      await x.p.waitForTimeout(300);
      const h = await x.p.evaluate(header);
      await shot(x.p, `pip-from-card-${where}-${width}-${theme}`);
      assert.deepEqual(x.errors, []);
      assert.deepEqual([h.name, h.nameSeen, h.nameCut], ["Mornings", true, 0], `the Pip's name, whole: ${JSON.stringify(h)}`);
      assert.deepEqual([h.overlaps, h.sideways], [false, false]);
      if (width > 340) assert.equal(h.word, "History", "with room, the page's word is beside it");
      assert.match(await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('.simple-content[data-view="runs"] h2').textContent), /^History$/, "and the page itself says History");
    });
  }
}
