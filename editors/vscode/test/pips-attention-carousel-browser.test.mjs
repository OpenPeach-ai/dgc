// Needs attention on the Pips page shows one card at a time (asked 11 Nov: "the need attention gets too long ... just
// one card, with dots below and arrows on left and right, so user can switch them and go next or back, but it always
// remains 1 card in the view"). In real Chromium, with the real client and its CSS, in the side bar and as a tab:
// one card in view at any count; the arrows and the dots move it and the arrows are off at the ends; twelve cards'
// dots stay one short row; the keyboard and a swipe move it; an answered card gives its place to the next; a new card
// moves nothing; the fold still folds; a short slide, and none under reduced motion.
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

// How many cards wait: a new Pip's card is taller than a row, and a row with a second line taller than one without.
const COUNTS = { 1: { waiting: 1 }, 3: { setups: 1, waiting: 1 }, 4: { setups: 2, waiting: 1 }, 12: { setups: 2, waiting: 9 } };
const open = async (t, count, { width = 300, theme = "dark", motion = "reduce" } = {}) => {
  const x = await openChat(browser, { width, height: 800, theme, motion, where: width > 400 ? "tab" : "side", home: true, ...COUNTS[count] });
  t.after(x.close);
  await x.p.waitForSelector(".attention-toggle");
  await x.p.waitForFunction((n) => (window.__pipsRoot || document).querySelector(".attention-count")?.textContent === String(n), count);
  return x;
};
/** Needs attention as it is drawn, read in the page. */
const read = () => {
  const r = window.__pipsRoot || document, section = r.querySelector(".attention"); if (!section) return null;
  const box = (n) => { if (!n) return null; const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const seen = (n) => !!n && n.getClientRects().length > 0 && getComputedStyle(n).visibility !== "hidden";
  const cards = [...section.querySelectorAll(".attention-row, .dgc-card")].filter(seen), card = cards[0];
  const arrow = (id) => { const b = section.querySelector("#" + id); return b && seen(b) ? { ...box(b), off: b.disabled, label: b.getAttribute("aria-label") } : null; };
  const dots = [...section.querySelectorAll(".attention-dot")].filter(seen).map((d) => ({ ...box(d), dot: box(d.querySelector("i")).width, current: d.getAttribute("aria-current") === "true",
    label: d.getAttribute("aria-label"), fill: getComputedStyle(d.querySelector("i")).backgroundColor, tab: d.tabIndex }));
  const place = section.querySelector(".attention-place"), stage = section.querySelector(".attention-stage"), active = r.activeElement;
  return { count: section.querySelector(".attention-count").textContent, open: section.querySelector(".attention-toggle").getAttribute("aria-expanded") === "true",
    cards: cards.length, items: section.querySelectorAll(".attention-item").length, title: card?.querySelector(".attention-copy strong, .dgc-card-title")?.textContent || "", key: card?.closest("[data-attention-key]")?.dataset.attentionKey || "",
    card: box(card), buttons: card ? [...card.querySelectorAll(".dgc-card-actions button")].map(box) : [], section: box(section), stage: box(stage), stageStyle: stage?.style.height || "",
    prev: arrow("attention-prev"), next: arrow("attention-next"), dots, place: place && seen(place) ? place.textContent : "", placeLive: place?.getAttribute("aria-live") || "", placeBox: box(place),
    more: section.querySelectorAll(".attention-more").length, focus: active ? active.id || active.className : "", focusInside: !!active && !!section.querySelector(".attention-carousel")?.contains(active),
    below: box(r.querySelector(".simple-home, .job-list"))?.top ?? null, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    moving: stage ? stage.getAnimations({ subtree: true }).map((a) => ({ name: a.animationName || a.transitionProperty, ms: a.effect.getTiming().duration }))
      .filter((m) => m.name === "height" || /^attention-from/.test(m.name)) : [] };   // the card's own slide and the height; a Pip's face moves as it always does
};
const at = async (x, words) => { await x.p.waitForFunction((w) => (window.__pipsRoot || document).querySelector(".attention-place")?.textContent === w, words); return x.p.evaluate(read); };
const apart = (a, b) => a.right <= b.left + 0.5 || b.right <= a.left + 0.5 || a.bottom <= b.top + 0.5 || b.bottom <= a.top + 0.5;

for (const theme of ["dark", "light"]) for (const width of [240, 300, 700]) for (const count of [1, 3, 12]) {
  test(`${count} waiting: one card in view, with its arrows and dots (${width}px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await open(t, count, { width, theme });
    const v = await x.p.evaluate(read);
    assert.equal(v.count, String(count), "the header keeps its count");
    assert.equal(v.cards, 1, "exactly one card in view");
    assert.equal(v.items, 1, "and no other card drawn under it");
    assert.equal(v.more, 0, "no Show all: it is always one card");
    assert.ok(v.sideways <= 0, "nothing runs off the side");
    assert.ok(v.card.left >= v.section.left - 0.5 && v.card.right <= v.section.right + 0.5, "the card is inside the section");
    if (count === 1) {
      assert.equal(v.prev, null); assert.equal(v.next, null); assert.equal(v.dots.length, 0); assert.equal(v.place, "", "one card needs no arrows, dots or count");
      assert.ok(v.card.width >= v.section.width - 1, "and it has the whole width");
      return;
    }
    assert.equal(v.place, `1 of ${count}`);
    assert.equal(v.placeLive, "polite", "said to a screen reader when it changes");
    assert.equal(v.dots.length, Math.min(count, 7), "a dot for each card, seven at most");
    assert.deepEqual(v.dots.map((d) => d.current), v.dots.map((_, i) => i === 0), "the first dot is the one filled");
    assert.ok(v.dots.every((d) => Math.abs(d.top - v.dots[0].top) < 0.5), "the dots are one row");
    assert.ok(v.dots[0].left >= v.section.left && v.dots.at(-1).right <= v.section.right, "inside the section");
    assert.ok(v.dots.every((d) => d.top >= v.card.bottom - 0.5), "below the card");
    for (const a of [v.prev, v.next]) {
      assert.ok(a.width >= 24 && a.height >= 24, `an arrow is at least 24 px to hit (${a.width} by ${a.height})`);
      assert.ok(apart(a, v.card), "an arrow never sits on the card");
      for (const b of v.buttons) assert.ok(apart(a, b), "nor on the card's own buttons");
      for (const d of v.dots) assert.ok(apart(a, d), "nor on a dot");
      assert.ok(apart(a, v.placeBox), "nor on the count");
    }
    assert.ok(v.prev.right <= v.next.left && v.prev.left < v.section.left + v.section.width / 2 && v.next.right > v.section.left + v.section.width / 2, "Previous at the left, Next at the right");
    assert.equal(v.prev.off, true, "Previous is off at the first card");
    assert.equal(v.next.off, false);
    assert.match(v.next.label, /^Next: .+\?$/, "Next says what it shows");
    // In a narrow view the card keeps the whole width; with room, the arrows stand beside it.
    if (width <= 300) assert.ok(v.card.width >= v.section.width - 1, `the card has the whole width (${v.card.width} of ${v.section.width})`);
    else assert.ok(v.prev.right <= v.card.left && v.next.left >= v.card.right && v.prev.top < v.card.bottom && v.prev.bottom > v.card.top, "the arrows stand beside the card");
    // The dot of the card showing is the one purple mark; the others, the arrows and the count are greys.
    const chroma = (rgb) => { const c = rgb.match(/[\d.]+/g).slice(0, 3).map(Number); return Math.max(...c) - Math.min(...c); };
    assert.ok(chroma(v.dots[0].fill) > 60, `the current dot is the live mark (${v.dots[0].fill})`);
    assert.ok(v.dots.slice(1).every((d) => chroma(d.fill) <= 12), "the other dots are greys");
    const inks = await x.p.evaluate(() => { const r = window.__pipsRoot || document; return ["#attention-prev", "#attention-next", ".attention-place"].map((s) => getComputedStyle(r.querySelector(s)).color); });
    assert.ok(inks.every((c) => chroma(c) <= 12), `the arrows and the count are greys (${inks})`);
    assert.deepEqual(x.errors, []);
  });
}

test("the arrows and the dots go to the next card and back; an arrow at an end is off", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, 3);
  let v = await x.p.evaluate(read);
  const first = v.title;
  assert.equal(first, "Create the Pip “Bills”?");
  await x.p.click("#attention-next"); v = await at(x, "2 of 3");
  assert.equal(v.title, "Link Gmail?"); assert.equal(v.cards, 1);
  assert.deepEqual(v.dots.map((d) => d.current), [false, true, false]);
  assert.equal(v.prev.off, false); assert.equal(v.prev.label, `Previous: ${first}`);
  assert.equal(v.next.label, "Next: Send email to sam@mail.example?");
  await x.p.click("#attention-next"); v = await at(x, "3 of 3");
  assert.equal(v.title, "Send email to sam@mail.example?");
  assert.equal(v.next.off, true, "Next is off at the last card: it never goes round");
  assert.equal(v.next.label, "Next");
  await x.p.click("#attention-prev"); v = await at(x, "2 of 3");
  assert.equal(v.title, "Link Gmail?");
  await x.p.click(".attention-dot >> nth=0"); v = await at(x, "1 of 3");
  assert.equal(v.title, first, "a dot goes to its card");
  assert.equal(v.dots[2].label, "Card 3 of 3: Send email to sam@mail.example?", "and says which");
  await x.p.click(".attention-dot >> nth=2"); v = await at(x, "3 of 3");
  assert.equal(v.title, "Send email to sam@mail.example?");
  assert.deepEqual(x.errors, []);
});

test("twelve cards at 300 px: the dots are a window of seven on one row, the end ones smaller", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, 12);
  const row = (v) => { assert.equal(v.dots.length, 7); assert.equal(v.cards, 1);
    assert.ok(v.dots.every((d) => Math.abs(d.top - v.dots[0].top) < 0.5), "one row");
    assert.ok(v.dots.at(-1).right - v.dots[0].left <= 130, `a short row (${v.dots.at(-1).right - v.dots[0].left}px)`);
    assert.equal(v.dots.filter((d) => d.current).length, 1); return v.dots.map((d) => d.dot); };
  let v = await x.p.evaluate(read);
  let sizes = row(v);
  assert.ok(sizes[6] < sizes[5] && sizes[5] < sizes[4], `more to the right: its end dots step down (${sizes})`);
  assert.ok(sizes.slice(0, 5).every((s) => s === sizes[0]), "none to the left: full size there");
  for (let i = 2; i <= 6; i++) { await x.p.click("#attention-next"); v = await at(x, `${i} of 12`); }
  sizes = row(v);
  assert.equal(v.dots.findIndex((d) => d.current), 3, "the current dot is the middle one");
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes[6] < sizes[5] && sizes[5] < sizes[4], `more both ways: both ends step down (${sizes})`);
  assert.equal(v.dots[0].label.startsWith("Card 3 of 12: "), true, "each dot still goes to its own card");
  await x.p.locator(".attention-dot").last().click(); v = await at(x, "9 of 12");
  await x.p.focus("#attention-next"); await x.p.keyboard.press("End"); v = await at(x, "12 of 12");
  sizes = row(v);
  assert.equal(v.dots.findIndex((d) => d.current), 6, "at the last card its dot is the last");
  assert.ok(sizes[0] < sizes[1] && sizes[1] < sizes[2] && sizes.slice(2).every((s) => s === sizes[2]), `only the left end steps down (${sizes})`);
  assert.equal(v.next.off, true);
  assert.ok(v.sideways <= 0);
});

test("the keyboard: Left and Right go a card along, Home and End to the first and the last, and the focus stays", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, 4);
  await x.p.focus("#attention-next");
  await x.p.keyboard.press("ArrowRight"); let v = await at(x, "2 of 4");
  assert.equal(v.focus, "attention-next", "the focus is where it was");
  await x.p.keyboard.press("ArrowRight"); await x.p.keyboard.press("ArrowRight"); v = await at(x, "4 of 4");
  assert.equal(v.focusInside, true, "Next went off at the end; the focus is still in the carousel");
  assert.equal(v.focus, "attention-dot-3", "on the dot of the card showing");
  await x.p.keyboard.press("ArrowRight"); v = await x.p.evaluate(read); assert.equal(v.place, "4 of 4", "Right at the end does nothing");
  await x.p.keyboard.press("ArrowLeft"); v = await at(x, "3 of 4");
  await x.p.keyboard.press("Home"); v = await at(x, "1 of 4"); assert.equal(v.focusInside, true);
  await x.p.keyboard.press("End"); v = await at(x, "4 of 4"); assert.equal(v.focusInside, true);
  // From the card's own button too: the card goes, and the focus stays in the carousel.
  await x.p.keyboard.press("Home"); v = await at(x, "1 of 4");
  await x.p.focus(".attention [data-setup-card] button");
  await x.p.keyboard.press("ArrowRight"); v = await at(x, "2 of 4"); assert.equal(v.focusInside, true);
  assert.deepEqual(v.dots.map((d) => d.tab), [-1, 0, -1, -1], "Tab stops at one dot, the current one");
  // Outside the carousel the keys are the page's own.
  await x.p.focus(".attention-toggle"); await x.p.keyboard.press("ArrowRight"); await x.p.waitForTimeout(50);
  assert.equal((await x.p.evaluate(read)).place, "2 of 4");
});

test("a swipe goes one card along: a finger across the card, or two fingers on a trackpad", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, 4);
  const drag = (dx, dy = 0) => x.p.evaluate(([dx, dy]) => { const r = window.__pipsRoot || document, el = r.querySelector(".attention-stage > li *"), b = el.getBoundingClientRect(), from = { x: b.left + b.width / 2, y: b.top + 4 };
    const fire = (type, x, y) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, composed: true, pointerId: 7, pointerType: "touch", isPrimary: true, clientX: x, clientY: y }));
    fire("pointerdown", from.x, from.y); fire("pointerup", from.x + dx, from.y + dy); }, [dx, dy]);
  const wheel = (dx, dy = 0) => x.p.evaluate(([dx, dy]) => { const r = window.__pipsRoot || document; r.querySelector(".attention-stage > li *").dispatchEvent(new WheelEvent("wheel", { bubbles: true, composed: true, deltaX: dx, deltaY: dy })); }, [dx, dy]);
  await drag(-90); let v = await at(x, "2 of 4");
  await drag(-90, 120); await x.p.waitForTimeout(50); assert.equal((await x.p.evaluate(read)).place, "2 of 4", "a swipe down the page is the page's own");
  await drag(-20); await x.p.waitForTimeout(50); assert.equal((await x.p.evaluate(read)).place, "2 of 4", "a short touch is not a swipe");
  await drag(90); v = await at(x, "1 of 4");
  await drag(90); await x.p.waitForTimeout(50); assert.equal((await x.p.evaluate(read)).place, "1 of 4", "nothing before the first");
  // A trackpad: one card for one swipe, however long it glides; the next swipe, after a rest, is another.
  for (let i = 0; i < 12; i++) await wheel(30);
  v = await at(x, "2 of 4");
  await x.p.waitForTimeout(350);
  await wheel(5, 80); await x.p.waitForTimeout(350); assert.equal((await x.p.evaluate(read)).place, "2 of 4", "scrolling the page moves no card");
  for (let i = 0; i < 4; i++) await wheel(-30);
  v = await at(x, "1 of 4");
  assert.deepEqual(x.errors, []);
});

test("an answered card gives its place to the next; the dots and the count follow; the last one leaves nothing", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, 4);
  await x.p.click("#attention-next"); let v = await at(x, "2 of 4");
  assert.equal(v.title, "Create the Pip “Inbox tidy”?");
  await x.p.click(".attention [data-setup-card] [data-attention-dismiss]");   // Reject, on the card
  v = await at(x, "2 of 3");
  assert.equal(v.title, "Link Gmail?", "the next card, in the same place");
  assert.equal(v.count, "3"); assert.equal(v.dots.length, 3); assert.equal(v.cards, 1);
  // Answered somewhere else (in the Pip's chat): the same.
  await x.p.evaluate((key) => { window.__attention.remove(key); window.__attention.read(); }, v.key);
  v = await at(x, "2 of 2");
  assert.equal(v.title, "Send email to sam@mail.example?");
  // The last card answered: the one before it shows.
  await x.p.evaluate((key) => { window.__attention.remove(key); window.__attention.read(); }, v.key);
  await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention-count")?.textContent === "1");
  v = await x.p.evaluate(read);
  assert.equal(v.title, "Create the Pip “Bills”?"); assert.equal(v.cards, 1); assert.equal(v.dots.length, 0, "one left: no dots");
  assert.deepEqual(x.errors, []);
});

test("a new card arriving does not move the view from the card you are on", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, 3);
  await x.p.click("#attention-next"); let v = await at(x, "2 of 3");
  const on = v.key, title = v.title;
  await x.p.evaluate(() => { window.__attention.add(); window.__attention.read(); });
  v = await at(x, "3 of 4");
  assert.equal(v.key, on, "the same card"); assert.equal(v.title, title);
  assert.equal(v.count, "4"); assert.equal(v.dots.length, 4);
  assert.deepEqual(v.dots.map((d) => d.current), [false, false, true, false]);
  assert.equal(v.cards, 1);
});

test("the fold still folds: folded it shows no card, opened it is back on the card you were on, and something new opens it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(t, 3);
  await x.p.click("#attention-next"); let v = await at(x, "2 of 3");
  const on = v.key;
  await x.p.click(".attention-toggle");
  await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention-toggle").getAttribute("aria-expanded") === "false");
  v = await x.p.evaluate(read);
  assert.equal(v.cards, 0); assert.equal(v.prev, null); assert.equal(v.dots.length, 0); assert.equal(v.place, ""); assert.equal(v.count, "3", "folded: the header and its count only");
  await x.p.click(".attention-toggle"); v = await at(x, "2 of 3");
  assert.equal(v.key, on, "opened again on the card you were on");
  await x.p.click(".attention-toggle");
  await x.p.waitForFunction(() => (window.__pipsRoot || document).querySelector(".attention-toggle").getAttribute("aria-expanded") === "false");
  const fresh = await x.p.evaluate(() => { const id = window.__attention.add(); window.__attention.read(); return id; });
  v = await at(x, "1 of 4");
  assert.equal(v.open, true, "something new came in: it opens");
  assert.equal(v.key, fresh, "on what came in");
});

test("moving is a short slide and the height follows the card; under reduced motion neither", async (t) => {
  if (skipOrFail(t)) return;
  // Click and read in one step, so the slide is caught as it starts.
  const step = (p, id) => p.evaluate(([id, reads]) => { (window.__pipsRoot || document).querySelector(id).click(); return (0, eval)(`(${reads})`)(); }, [id, read.toString()]);
  const moved = await open(t, 3, { motion: "no-preference" });
  const before = await moved.p.evaluate(read);
  let v = await step(moved.p, "#attention-next");
  assert.equal(v.place, "2 of 3");
  assert.deepEqual(v.moving.filter((m) => m.name === "attention-from-next").map((m) => m.ms), [180], "the card slides in from the side you are going to, 180 ms");
  assert.ok(v.moving.some((m) => m.name === "height" && m.ms === 180), "and the height follows it in the same time");
  assert.ok(Math.abs(v.stage.height - before.stage.height) < 2, `starting from the height it had (${v.stage.height} from ${before.stage.height})`);
  await moved.p.waitForFunction(() => { const s = (window.__pipsRoot || document).querySelector(".attention-stage"); return !s.style.height && !s.classList.contains("attention-moving"); });
  v = await moved.p.evaluate(read);
  assert.ok(v.stage.height < before.stage.height - 20, `a row is shorter than a new Pip's card (${v.stage.height} after ${before.stage.height})`);
  assert.ok(Math.abs(v.stage.height - v.card.height) < 1, "the section is as tall as the card showing");
  assert.ok(Math.abs((before.below - v.below) - (before.stage.height - v.stage.height)) < 1, "what is below moved by the card's own change, no more");
  assert.deepEqual(v.moving, []);
  v = await step(moved.p, "#attention-prev");
  assert.deepEqual(v.moving.filter((m) => /^attention-from/.test(m.name)).map((m) => m.name), ["attention-from-prev"], "going back, from the other side");
  // Reduced motion: the next card is simply there.
  const still = await open(t, 3, { motion: "reduce" });
  v = await step(still.p, "#attention-next");
  assert.equal(v.place, "2 of 3"); assert.deepEqual(v.moving, [], "no slide"); assert.equal(v.stageStyle, "", "no height in between");
  assert.ok(Math.abs(v.stage.height - v.card.height) < 1);
});
