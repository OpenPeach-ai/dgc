// "View all" on the Pips page's Needs attention (asked 12 Nov: "we only show one card there, let's add a clickable text
// there 'View all', which opens its own page, where all of them gets listed vertically and scrollable"). In real
// Chromium, with the real client and its CSS, in the side bar (300 px) and as a tab (700 px), dark and light: the words
// on the heading row; the page with every card one under another, nothing clipped or overlapping; it scrolls as the
// view does; a card arriving or leaving above moves nothing on screen; an answer is held in its own place; the last one
// answered says nothing needs you and offers Back; Back and Escape return to the list of Pips.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { client, openChat } from "./support/pip-chat-scene.mjs";

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

const count = (p, n) => p.waitForFunction((n) => (window.__pipsRoot || document).querySelector(".attention-count, .attention-all-count")?.textContent === String(n), n);
const open = async (t, { width = 300, theme = "dark", total, ...scene } = {}) => {
  const x = await openChat(browser, { width, height: 800, theme, where: width > 400 ? "tab" : "side", home: true, ...scene });
  t.after(x.close);
  await x.p.waitForSelector(".attention-toggle");
  if (total) await count(x.p, total);
  return x;
};
const all = async (x) => { await x.p.click("#attention-view-all"); await x.p.waitForSelector(".attention-all"); await x.p.mouse.move(2, 2); };
/** What scrolls the view: the side bar's own root; in a tab its body (or the page, where that is what scrolls). Run in the page. */
const SCROLLER = "(window.__pipsRoot ? window.__pipsRoot.querySelector('.pip-app-root') : document.scrollingElement.scrollHeight > document.scrollingElement.clientHeight + 1 ? document.scrollingElement : document.body)";
const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
/** The heading row as it is drawn. */
const heading = `(() => { const box = ${box.toString()}; const r = window.__pipsRoot || document, s = r.querySelector(".attention"), link = s.querySelector("#attention-view-all"), toggle = s.querySelector(".attention-toggle");
  const words = document.createRange(); words.selectNodeContents(toggle.firstChild);
  return { section: box(s), toggle: box(toggle), words: box(words), pill: box(s.querySelector(".attention-count")), chevron: box(toggle.querySelector(".codicon")), link: link && box(link), text: link?.textContent || "",
    ink: link ? getComputedStyle(link).color : "", ground: link ? getComputedStyle(link).backgroundColor : "", cards: s.querySelectorAll(".attention-row, .dgc-card").length,
    sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth }; })()`;
/** The page as it is drawn. */
const page = `(() => { const box = ${box.toString()}; const r = window.__pipsRoot || document, view = ${SCROLLER}, content = r.querySelector('.simple-content[data-view="attention-all"]'), bar = r.querySelector(".pip-topbar");
  const seen = (n) => !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden";
  const cards = [...r.querySelectorAll(".attention-all-list > li")].map((li) => { const copy = li.querySelector(".attention-copy, .dgc-card-body, .dgc-card-title"), answers = li.querySelector(".dgc-ia, .attention-undo");
    return { ...box(li), key: li.dataset.attentionKey, title: li.querySelector(".attention-copy strong, .dgc-card-title")?.textContent || "", card: box(li.querySelector(".attention-row, .dgc-card")),
      buttons: [...li.querySelectorAll(".dgc-ia-btn, .dgc-card-actions button, .attention-undo")].filter(seen).map(box), copy: box(copy), answers: box(answers), held: li.classList.contains("attention-held"),
      wide: li.scrollWidth - li.clientWidth }; });
  const active = r.activeElement, empty = r.querySelector(".attention-all-empty");
  return { content: box(content), bar: box(bar), back: box(bar?.querySelector("#attention-all-back")), backLabel: bar?.querySelector("#attention-all-back")?.getAttribute("aria-label") || "",
    title: bar?.querySelector(".pip-pill span")?.textContent || "", titleBox: box(bar?.querySelector(".pip-pill span")), count: bar?.querySelector(".attention-all-count")?.textContent || "", countBox: box(bar?.querySelector(".attention-all-count")),
    countInk: bar?.querySelector(".attention-all-count") ? getComputedStyle(bar.querySelector(".attention-all-count")).color : "",
    cards, home: !!r.querySelector(".simple-home"), focus: active ? active.id || active.className : "", empty: empty && { ...box(empty), words: empty.querySelector("p").textContent, button: box(empty.querySelector("button")), label: empty.querySelector("button").textContent },
    scroll: { top: view.scrollTop, height: view.scrollHeight, client: view.clientHeight, viewTop: window.__pipsRoot ? view.getBoundingClientRect().top : 0, viewBottom: window.__pipsRoot ? view.getBoundingClientRect().bottom : window.innerHeight },
    sideways: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, view.scrollWidth - view.clientWidth) }; })()`;
const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;
const inside = (a, b) => a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5;
const chroma = (rgb) => { const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number); return Math.max(...c) - Math.min(...c); };

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`View all on the heading row, and its page with twelve cards (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(t, { width, theme, setups: 2, waiting: 9, total: 12 });
    const h = await x.p.evaluate(heading);
    assert.equal(h.text, "View all");
    assert.equal(h.cards, 1, "the one-card view is as it was");
    assert.ok(h.sideways <= 0, "nothing runs off the side");
    assert.ok(inside(h.link, h.section), "inside the section");
    assert.ok(h.link.top >= h.toggle.top - 0.5 && h.link.bottom <= h.toggle.bottom + 0.5, "on the heading row");
    assert.ok(h.link.left > h.section.left + h.section.width / 2, "at its right");
    assert.ok(apart(h.link, h.words) && apart(h.link, h.pill), "never on the heading's words or its count");
    assert.ok(h.link.left - h.pill.right >= 8, `with room between (${h.link.left - h.pill.right}px)`);
    assert.ok(apart(h.link, h.toggle), "the fold's own button ends before it: neither lies on the other");
    assert.ok(h.chevron.right <= h.link.left + 0.5, "the fold's chevron stays in its button, left of the words");
    assert.ok(Math.abs(h.link.right - h.section.right) <= 1, "at the row's right end, in line with the card's edge");
    assert.ok(h.link.height >= 24 && h.link.width >= 44, `big enough to hit (${h.link.width} by ${h.link.height})`);
    assert.ok(chroma(h.ink) <= 12, `quiet grey words, not the accent (${h.ink})`);
    assert.match(h.ground, /rgba\(0, 0, 0, 0\)|transparent/, "words, not a filled button");

    await all(x);
    const v = await x.p.evaluate(page);
    assert.equal(v.home, false, "a page of its own: the list of Pips is not on it");
    assert.equal(v.backLabel, "Your Pips"); assert.equal(v.title, "Needs attention"); assert.equal(v.count, "12");
    assert.ok(v.back.width >= 24 && v.back.height >= 24 && v.back.left < v.titleBox.left, "the back button at the bar's left");
    assert.ok(v.countBox.width > 0 && v.countBox.left >= v.titleBox.right && inside(v.countBox, v.bar), "the count beside the title, in sight at this width");
    assert.ok(apart(v.back, v.titleBox), "the title clear of the back button");
    assert.ok(chroma(v.countInk) <= 12, "the count is grey");
    assert.equal(v.focus, "attention-all-back", "the keyboard is on the page");
    assert.equal(v.scroll.top, 0, "opened at its top");
    assert.ok(v.sideways <= 0, "nothing runs off the side");
    assert.equal(v.cards.length, 12, "every card");
    assert.equal(v.cards[0].title, "Create the Pip “Bills”?");
    v.cards.forEach((c, i) => {
      assert.ok(c.left >= v.content.left - 0.5 && c.right <= v.content.right + 0.5, `card ${i + 1} is inside the page`);
      assert.ok(c.card.width >= c.width - 1 && c.width >= v.content.width - 30, `card ${i + 1} has the page's width (${c.card.width} of ${v.content.width})`);
      assert.ok(c.wide <= 0, `card ${i + 1} clips nothing sideways`);
      if (i) assert.ok(c.top >= v.cards[i - 1].bottom + 4, `card ${i + 1} is under card ${i}, with a gap (${c.top - v.cards[i - 1].bottom}px)`);
      assert.ok(c.buttons.length >= 1, `card ${i + 1} has its answers`);
      for (const b of c.buttons) assert.ok(inside(b, c.card), `card ${i + 1}: a button is inside its card`);
      if (c.answers && c.copy) assert.ok(c.copy.right <= c.answers.left + 0.5, `card ${i + 1}: its words stop before its answers`);
    });
    // It scrolls as the view does, down to the last card.
    assert.ok(v.scroll.height > v.scroll.client + 100, `twelve cards are taller than the view (${v.scroll.height} in ${v.scroll.client})`);
    assert.ok(v.cards.at(-1).top > v.scroll.viewBottom, "the last card starts out of sight");
    await x.p.evaluate(`${SCROLLER}.scrollTop = 100000`);
    const end = await x.p.evaluate(page);
    assert.ok(end.scroll.top > 100, "the view scrolled");
    assert.ok(end.cards.at(-1).bottom <= end.scroll.viewBottom + 0.5 && end.cards.at(-1).top >= end.scroll.viewTop, "the last card is in sight at the end");
    assert.ok(end.bar.bottom <= end.scroll.viewTop + 0.5, "the bar went with the page: the whole view scrolls");
    assert.deepEqual(x.errors, []);
  });
}

test("one card, or folded: no View all", async (t) => {
  if (skipOrFail(t)) return;
  const one = await open(t, { waiting: 1, total: 1 });
  assert.equal(await one.p.locator("#attention-view-all").count(), 0, "one card");
  const x = await open(t, { setups: 1, waiting: 1, total: 3 });
  assert.equal(await x.p.locator("#attention-view-all").count(), 1);
  await x.p.click(".attention-toggle");
  await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention-toggle").getAttribute("aria-expanded") === "false");
  assert.equal(await x.p.locator("#attention-view-all").count(), 0, "folded");
  // Its own click never folds the section, and the fold's never opens the page.
  await x.p.click(".attention-toggle"); await x.p.waitForSelector("#attention-view-all");
  assert.equal(await x.p.locator(".attention-all").count(), 0);
});

for (const width of [300, 700]) test(`a card arriving or leaving above what you are reading moves nothing on screen (${width}px)`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, { width, setups: 2, waiting: 9, total: 12 });
  await all(x);
  // Scroll until the seventh card is the first in sight.
  await x.p.evaluate(`(() => { const r = window.__pipsRoot || document, view = ${SCROLLER}, li = r.querySelectorAll(".attention-all-list > li")[6];
    view.scrollTop += li.getBoundingClientRect().top - ${width > 400 ? 0 : "view.getBoundingClientRect().top"} - 10; })()`);
  let v = await x.p.evaluate(page);
  const on = v.cards[6], scrolled = v.scroll.top;
  assert.ok(scrolled > 200);
  const fresh = await x.p.evaluate(() => { const id = window.__attention.add(); window.__attention.read(); return id; });
  await count(x.p, 13);
  v = await x.p.evaluate(page);
  assert.equal(v.cards.length, 13); assert.equal(v.cards[0].key, fresh, "the new card is first, as the newest");
  let now = v.cards.find((c) => c.key === on.key);
  assert.ok(Math.abs(now.top - on.top) < 1, `the card you were reading is where it was (${now.top} from ${on.top})`);
  assert.ok(v.scroll.top > scrolled + 20, "the view moved down by the new card's height, so nothing on screen moved");
  // One above it answered somewhere else: the same.
  await x.p.evaluate((key) => { window.__attention.remove(key); window.__attention.read(); }, v.cards[3].key);
  await count(x.p, 12);
  v = await x.p.evaluate(page);
  now = v.cards.find((c) => c.key === on.key);
  assert.ok(Math.abs(now.top - on.top) < 1, `still where it was (${now.top} from ${on.top})`);
  // At the very top a new card shows at the top, and the page stays at its top.
  await x.p.evaluate(`${SCROLLER}.scrollTop = 0`);
  await x.p.evaluate(() => { window.__attention.add(); window.__attention.read(); });
  await count(x.p, 13);
  assert.equal((await x.p.evaluate(page)).scroll.top, 0);
  assert.deepEqual(x.errors, []);
});

for (const width of [300, 700]) test(`an answer is held where its card was, with Undo, and the cards around it stay (${width}px)`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, { width, setups: 2, waiting: 4, answers: true, total: 9 });
  await x.p.evaluate(() => { const later = window.setTimeout.bind(window); window.__holds = [];
    window.setTimeout = (fn, ms, ...rest) => (ms === 6000 ? (window.__holds.push(fn), 900000 + window.__holds.length) : later(fn, ms, ...rest));
    const clear = window.clearTimeout.bind(window); window.clearTimeout = (id) => { if (id > 900000) window.__holds[id - 900001] = null; else clear(id); }; });
  const fire = () => x.p.evaluate(() => { const due = window.__holds.filter(Boolean); window.__holds = []; due.forEach((fn) => fn()); return due.length; });
  const sent = () => x.p.evaluate(() => (window.__sent || []).filter((r) => /^(accept_pip_update|reject_pip_update|decide_pip_computer_action|reject_pip_setup)$/.test(r.type)).map((r) => r.type));
  await all(x);
  const ROW = '.attention-all-list > li[data-attention-key^="approval:"]';
  await x.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ROW);
  let v = await x.p.evaluate(page);
  const at = v.cards.findIndex((c) => c.key.startsWith("approval:")), before = v.cards[at], next = v.cards[at + 1];
  await x.p.click(`${ROW} [data-attention-answer="yes"]`);
  await x.p.waitForSelector(`${ROW}.attention-held`);
  await x.p.mouse.move(2, 2);
  v = await x.p.evaluate(page);
  const held = v.cards[at];
  assert.equal(held.key, before.key, "in its own place"); assert.equal(held.title, "Applied. Mornings is changed.");
  assert.ok(Math.abs(held.top - before.top) < 1, "where it was");
  assert.equal(held.buttons.length, 1, "Undo alone");
  assert.ok(inside(held.buttons[0], held.card) && held.copy.right <= held.buttons[0].left + 0.5, "Undo inside the card, clear of its words");
  assert.ok(Math.abs(v.cards[at + 1].top - next.top) <= Math.abs(held.height - before.height) + 1, "the card under it stays (but for the row's own height)");
  assert.equal(v.focus, `attention-undo-${before.key.split(":")[1]}`, "the keyboard is on Undo");
  assert.equal(v.cards.length, 9);
  assert.deepEqual(await sent(), [], "nothing is sent yet");
  await x.p.click(`${ROW} .attention-undo`);
  await x.p.waitForFunction((s) => (window.__pipsRoot || document).querySelectorAll(`${s} .dgc-ia-btn`).length === 3, ROW);
  assert.equal(await fire(), 0, "Undo called it off");
  // For good: sent once, and the card leaves.
  await x.p.click(`${ROW} [data-attention-answer="no"]`); await x.p.waitForSelector(`${ROW}.attention-held`);
  assert.equal(await fire(), 1);
  await count(x.p, 8);
  assert.deepEqual(await sent(), ["reject_pip_update"]);
  assert.equal(await x.p.locator(ROW).count(), 0, "answered: it left the list");
  // A new Pip rejected: said on its own card, with Undo, and out of the count at once.
  const CARD = '.attention-all-list > li[data-attention-key^="setup:"]';
  v = await x.p.evaluate(page);
  const first = v.cards.find((c) => c.key.startsWith("setup:"));
  await x.p.click(`${CARD} >> nth=0 >> [data-attention-dismiss]`);
  await x.p.waitForSelector(`${CARD}.attention-held`);
  await count(x.p, 7);
  v = await x.p.evaluate(page);
  const said = v.cards.find((c) => c.key === first.key);
  assert.equal(said.title, "Rejected. No Pip was created."); assert.ok(Math.abs(said.top - first.top) < 1, "where its card was");
  assert.ok(inside(said.buttons[0], said.card) && said.copy.right <= said.buttons[0].left + 0.5, "Undo inside it, clear of its words");
  assert.equal(await x.p.locator(".undo-reject").count(), 0, "said once");
  await x.p.click(`${CARD}.attention-held [data-undo-reject]`);
  await count(x.p, 8);
  assert.equal(await x.p.locator(`${CARD}.attention-held`).count(), 0, "Undo: its card again");
  assert.deepEqual(await sent(), ["reject_pip_update"], "and nothing sent for it");
  assert.deepEqual(x.errors, []);
});

for (const theme of ["dark", "light"]) for (const width of [700, 300]) test(`the last card answered: the page says nothing needs you and offers Back (${width}px, ${theme})`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, { width, theme, waiting: 2, total: 2 });
  await all(x);
  for (const key of await x.p.evaluate(() => window.__attention.ids())) await x.p.evaluate((key) => window.__attention.remove(key), key);
  await x.p.evaluate(() => window.__attention.read());
  await x.p.waitForSelector(".attention-all-empty");
  const v = await x.p.evaluate(page);
  assert.equal(v.cards.length, 0); assert.equal(v.count, "", "no count of nothing");
  assert.equal(v.empty.words, "Nothing needs you right now."); assert.equal(v.empty.label, "Back to your Pips");
  assert.ok(inside(v.empty.button, v.content) && v.empty.button.height >= 24, "its button is on the page");
  assert.ok(Math.abs((v.empty.button.left + v.empty.button.right) / 2 - (v.content.left + v.content.right) / 2) < 2, "in the middle");
  assert.equal(v.backLabel, "Your Pips", "the bar's back button too"); assert.ok(v.sideways <= 0);
  await x.p.click("#attention-all-done");
  await x.p.waitForSelector(".simple-home");
  assert.equal(await x.p.locator(".attention, .attention-all").count(), 0, "the list of Pips, with nothing waiting");
  assert.deepEqual(x.errors, []);
});

test("Back and Escape return to the list of Pips, on the card you opened it from or were last on", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, { setups: 2, waiting: 9, total: 12 });
  const place = () => x.p.evaluate(() => (window.__pipsRoot || document).querySelector(".attention-place")?.textContent || "");
  await x.p.click("#attention-next"); await x.p.click("#attention-next");
  assert.equal(await place(), "3 of 12");
  await all(x);
  await x.p.click("#attention-all-back");
  await x.p.waitForSelector(".simple-home");
  assert.equal(await place(), "3 of 12", "Back: the card it was opened from");
  assert.equal(await x.p.evaluate(() => (window.__pipsRoot || document).activeElement?.id), "attention-view-all", "and the keyboard is back on View all");
  // Tab to a card on the page, then Escape.
  await all(x);
  await x.p.focus(".attention-all-list > li >> nth=8 >> button.attention-row");
  await x.p.keyboard.press("Escape");
  await x.p.waitForSelector(".simple-home");
  assert.equal(await place(), "9 of 12", "Escape: the card you were last on");
  assert.equal(await x.p.locator(".attention-all").count(), 0);
  // Escape on the list of Pips is not the page's: nothing happens there.
  await x.p.keyboard.press("Escape"); await x.p.waitForTimeout(50);
  assert.equal(await x.p.locator(".simple-home").count(), 1);
  assert.deepEqual(x.errors, []);
});
