// The answers on a card are one small system (media/shared/card.css for every card in the side bar; on Home's slim
// cards media/shared/iconactions.css, asked 12 Nov: a card's answers rest as small icon buttons and the one pointed at
// turns into the full button): exactly one filled answer marks a card's main answer, in the text's own colour; every
// other answer is one hairline outline. One 6 px corner, one size (a 24 px square), 2 px apart. A square never moves
// (it is what the pointer finds): pointed at, its pill shows; pressed, the pill gives a little; reduced motion rests.
// Measured in real Chromium on the side bar's real page:
//   - Home at 300, 460, 700 and 1000 px, dark, light and high contrast: the sizes, one filled answer a card, never a third style
//   - icons at 4.5:1 or better, an outline's line at 3:1 in high contrast
//   - hover, press, focus (the ring is the pill's); reduced motion
//   - the way to all of it is an icon like the others, 24 px to hit
//   - the command card's answers beside its sentence at every width, and a side bar under 225 px
//   - the same card anywhere else in the side bar wears the same corner, styles and steps, as full buttons
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openCards, K } from "./support/home-cards-scene.mjs";

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
const settle = (page, ms = 220) => page.evaluate((wait) => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, wait)))), ms);

/** Every card's answers as they are drawn: each one's kind (filled, outline, link), box, shape, label and contrast. */
const answers = (page, within = "#home-hub") => page.evaluate((scope) => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (ink, g) => { const c = over(parse(ink), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const probe = document.createElement("i"); document.body.append(probe); probe.style.backgroundColor = "var(--solid)"; const solid = getComputedStyle(probe).backgroundColor; probe.remove();
  return [...document.querySelectorAll(`${scope} .dgc-card`)].map((card) => { const box = card.getBoundingClientRect();
    const buttons = [...card.querySelectorAll(".dgc-card-actions :is(.dgc-card-btn, .dgc-ia-btn)")].map((b) => { const s = getComputedStyle(b), r = b.getBoundingClientRect(), fill = parse(s.backgroundColor);
      const kind = s.backgroundColor === solid ? "filled" : fill[3] === 0 && parseFloat(s.borderTopWidth) === 1 && parse(s.borderTopColor)[3] > 0 ? "outline" : fill[3] === 0 && (parseFloat(s.borderTopWidth) === 0 || parse(s.borderTopColor)[3] === 0) && s.textDecorationLine.includes("underline") ? "link" : "other";   // (a link has no edge at all: forced colours draw every edge, a clear one too)
      const under = ground(b.parentElement);
      return { word: b.textContent, kind, primary: b.matches(".primary, .dgc-ia-main"), height: Math.round(r.height * 10) / 10, width: Math.round(r.width * 10) / 10, radius: s.borderTopLeftRadius, size: s.fontSize, weight: s.fontWeight, pad: [s.paddingLeft, s.paddingRight],
        label: ratio(s.color, kind === "filled" ? over(fill, under) : under), line: kind === "outline" ? ratio(s.borderTopColor, under) : null, inside: r.left >= box.left + 3 && r.right <= box.right - 3 && r.top >= box.top + 3 && r.bottom <= box.bottom - 3,
        whole: b.scrollWidth <= b.clientWidth + 1, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    const col = card.querySelector(".dgc-card-actions")?.getBoundingClientRect();
    return { key: card.dataset.key || card.dataset.dgcCard, mono: card.classList.contains("dgc-hub-mono"), height: Math.round(box.height * 2) / 2, width: Math.round(box.width), column: col ? Math.round(col.width * 10) / 10 : 0, buttons }; });
}, within);

for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 460, 700, 1000]) {
  test(`${theme} ${width}px: one filled answer a card, every other an outline; one corner and size; icons at 4.5:1`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openCards(browser, { theme, width });
    try {
      const cards = await answers(x.page);
      assert.ok(cards.length >= 10, `every kind of card is on Home (${cards.length})`);
      const all = cards.flatMap((c) => c.buttons.map((b) => ({ ...b, key: c.key })));
      assert.deepEqual([...new Set(all.map((b) => b.kind))].sort(), ["filled", "outline"], "two kinds and never a third (the way to all of it is an icon like the others, no longer a text link)");
      for (const c of cards) {
        assert.equal(c.buttons.filter((b) => b.kind === "filled").length, 1, `${c.key}: exactly one filled answer (${c.buttons.map((b) => `${b.word}:${b.kind}`)})`);
        assert.deepEqual(c.buttons.filter((b) => b.kind === "filled").map((b) => b.primary), [true], `${c.key}: and it is the main answer`);
        assert.equal(c.buttons.filter((b) => b.kind === "link").length, 0, `${c.key}: no text link among its answers`);
        assert.deepEqual(c.buttons.filter((b) => !b.inside || !b.whole).map((b) => b.word), [], `${c.key}: every answer is inside its card and whole`);
      }
      // (12 Nov: every answer is one 24 px square, whatever its word; before, one 76 by 22 px box.)
      assert.deepEqual([...new Set(all.map((b) => `${b.width}x${b.height}/${b.radius}/${b.size}/${b.weight}`))], ["24x24/6px/11px/500"], "one square, corner and label size for every answer: Open and Mark read are the same size");
      const low = all.filter((b) => b.label < 4.5).map((b) => `${b.key} ${b.word} ${b.label}`);
      assert.deepEqual(low, [], "every icon reads at 4.5:1");
      if (theme === "hc") assert.deepEqual(all.filter((b) => b.kind === "outline" && b.line < 3).map((b) => `${b.word} ${b.line}`), [], "in high contrast an outline's line is 3:1");
      // The answers' row is one, two or three squares 2 px apart: never wider than the 76 px column it replaces.
      assert.deepEqual([...new Set(cards.map((c) => c.column))].filter((w) => ![24, 50, 76].includes(w)), [], "a row is 24, 50 or 76 px wide");
      for (const c of cards) {
        assert.equal(new Set(c.buttons.map((b) => Math.round(b.top * 10))).size, 1, `${c.key}: its answers on one row`);
        for (let i = 1; i < c.buttons.length; i++) assert.equal(Math.round((c.buttons[i].left - c.buttons[i - 1].right) * 10) / 10, 2, `${c.key}: 2 px apart, in the order they are read`);
      }
      // The rows end on one line down the page, one line a column of cards.
      const edges = new Set(cards.map((c) => Math.round(c.buttons.at(-1).right)));
      assert.ok(edges.size <= (width >= 1000 ? 3 : width >= 700 ? 2 : 1), `the rows line up at the cards' right down the page, one line a column of cards (${[...edges]})`);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("an answer's square never moves: pointed at, its pill shows in its place; pressed, the pill gives a little", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 700 });
  try {
    const card = `.dgc-hub-card[data-key="${K.visit}"]`;
    const now = (sel) => x.page.evaluate(([c, s]) => { const b = document.querySelector(s), cs = getComputedStyle(b), r = b.getBoundingClientRect(), pill = document.querySelector(`${c} .dgc-ia-pill`), ps = getComputedStyle(pill);
      return { at: [r.left, r.top, r.width, r.height], moved: cs.transform, fill: cs.backgroundColor, ms: cs.transitionDuration.split(",")[0].trim(), pill: Number(ps.opacity) === 1 ? pill.textContent.trim() : "", pillFill: ps.backgroundColor, pillLine: ps.borderTopColor,
        pillScale: Math.round(new DOMMatrixReadOnly(ps.transform === "none" ? "" : ps.transform).a * 1000) / 1000 }; }, [card, sel]);
    // (Before 12 Nov a button stepped up 1 px when pointed at and sank 1 px when pressed. An icon's box must stay put,
    // or the pointer misses the next one: what answers the pointer is the pill.)
    for (const [name, sel, word] of [["the filled answer", `${card} .dgc-ia-btn.dgc-ia-main`, "Allow"], ["an outline", `${card} [data-hub-act="no"]`, "Not now"]]) {
      const rest = await now(sel);
      assert.deepEqual([rest.moved, rest.pill, rest.ms], ["none", "", "0.12s"], `${name}: at rest (its colours settle in the shared 120 ms)`);
      await x.page.hover(sel); await settle(x.page, 320);
      const pointed = await now(sel);
      assert.deepEqual([pointed.at, pointed.moved], [rest.at, "none"], `${name}: pointed at, its box is where it was`);
      assert.deepEqual([pointed.pill, pointed.pillScale], [word, 1], `${name}: and its pill says its word`);
      if (name === "an outline") assert.notEqual(pointed.pillLine, "rgba(0, 0, 0, 0)", "an outline's pill has its line");
      else assert.notEqual(pointed.pillFill, "rgba(0, 0, 0, 0)", "the filled answer's pill is filled");
      await x.page.mouse.down(); await settle(x.page);
      const pressed = await now(sel);
      assert.deepEqual([pressed.at, pressed.moved, pressed.pillScale], [rest.at, "none", 0.97], `${name}: pressed, the pill gives a little and the box stays`);
      // (Let go away from it, so nothing is answered.)
      await x.page.mouse.move(2, 2); await x.page.mouse.up(); await settle(x.page, 320);
      assert.deepEqual([(await now(sel)).pill, (await now(sel)).fill], ["", rest.fill], `${name}: and rests again`);
    }
  } finally { await x.close(); }
});

test("reduced motion: nothing steps, slides or gives, and the pill still answers", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 700, motion: "reduce" });
  try {
    const card = `.dgc-hub-card[data-key="${K.visit}"]`, sel = `${card} [data-hub-act="no"]`;
    const now = () => x.page.evaluate(([c, s]) => { const pill = document.querySelector(`${c} .dgc-ia-pill`), ps = getComputedStyle(pill);
      return [getComputedStyle(document.querySelector(s)).transform, ps.transform, Number(ps.opacity) === 1 ? pill.textContent.trim() : "", document.querySelector(`${c} .dgc-ia`).getAnimations({ subtree: true }).length]; }, [card, sel]);
    assert.deepEqual(await now(), ["none", "none", "", 0]);
    await x.page.hover(sel);
    assert.deepEqual(await now(), ["none", "none", "Not now", 0], "the pill is there at once: no step, no slide");
    await x.page.mouse.down(); await settle(x.page);
    assert.deepEqual((await now()).slice(0, 2), ["none", "none"], "no press move");
    await x.page.mouse.move(2, 2); await x.page.mouse.up();
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern", "hc"]) {
  test(`${theme}: the keyboard shows a ring on every answer, 3:1 against the card, clear of the next answer`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openCards(browser, { theme, width: 300 });
    try {
      await x.page.focus("#home-hub .dgc-hub-show");
      const seen = [];
      for (let i = 0; i < 12; i++) {
        await x.page.keyboard.press("Tab");
        // (An icon's ring is its pill's: the answer in full, over the row.)
        const at = await x.page.evaluate(() => { const a = document.activeElement; if (!a?.dataset?.hubAct) return null; const s = getComputedStyle(a.matches(".dgc-ia-btn") ? a.closest(".dgc-ia").querySelector(".dgc-ia-pill") : a);
          const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g).map(Number); return c.startsWith("color(srgb") ? m.slice(0, 3).map((v) => v * 255) : m.slice(0, 3); };
          const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
          let ground = [255, 255, 255]; for (let n = a.closest(".dgc-card"); n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; if (!/rgba\(.*, 0\)|transparent/.test(c) && !/\/ 0\)/.test(c)) { const m = c.match(/-?[\d.]+/g).map(Number); if ((m[3] ?? 1) >= 1) { ground = parse(c); break; } } }
          const [hi, lo] = [lum(parse(s.outlineColor)), lum(ground)].sort((p, q) => q - p);
          return { word: a.textContent, style: s.outlineStyle, width: parseFloat(s.outlineWidth), ratio: Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100 }; });
        if (at) seen.push(at);
      }
      assert.ok(seen.length >= 8, `the answers are reached (${seen.length})`);
      assert.deepEqual(seen.filter((a) => a.style === "none" || a.width < 1 || a.ratio < 3), [], "each shows a ring that reads at 3:1");
    } finally { await x.close(); }
  });
}

test("the way to all of it is an icon like the others: 24 px to hit, clear of the answer beside it", async (t) => {
  if (skipOrFail(t)) return;
  // (Before 12 Nov it was a quiet text link under the two buttons, with a 22 px hit area of its own.)
  for (const width of [300, 700]) {
    const x = await openCards(browser, { width });
    try {
      const hits = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-answers [data-hub-act='open']")].map((b) => { const r = b.getBoundingClientRect(), cy = (r.top + r.bottom) / 2, cx = (r.left + r.right) / 2;
        let top = cy, bottom = cy, left = cx, right = cx;
        while (top > r.top - 30 && document.elementFromPoint(cx, top - 0.5)?.closest("button") === b) top -= 0.5;
        while (bottom < r.bottom + 30 && document.elementFromPoint(cx, bottom + 0.5)?.closest("button") === b) bottom += 0.5;
        while (left > r.left - 30 && document.elementFromPoint(left - 0.5, cy)?.closest("button") === b) left -= 0.5;
        while (right < r.right + 30 && document.elementFromPoint(right + 0.5, cy)?.closest("button") === b) right += 0.5;
        const before = b.previousElementSibling?.getBoundingClientRect(), card = b.closest(".dgc-hub-card").getBoundingClientRect();
        return { key: b.closest(".dgc-hub-card").dataset.key, tall: Math.round((bottom - top) * 10) / 10, wide: Math.round((right - left) * 10) / 10, clear: !before || left >= before.right - 0.5, inCard: bottom <= card.bottom + 0.5 && top >= card.top - 0.5 && right <= card.right }; }));
      assert.ok(hits.length >= 2, `${width}px: the answered cards are there (${hits.length})`);
      for (const h of hits) assert.ok(h.tall >= 23 && h.wide >= 23 && h.clear && h.inCard, `${width}px ${h.key}: ${JSON.stringify(h)}`);
    } finally { await x.close(); }
  }
});

test("a command card's three answers stand beside its sentence at every width, over its command's line", async (t) => {
  if (skipOrFail(t)) return;
  // (Before 12 Nov: beside the sentence only in a card about 420 px wide or more, under the command in a narrower one.)
  for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 460]) {
    const x = await openCards(browser, { theme, width });
    try {
      const cards = await answers(x.page), run = cards.find((c) => c.key === K.run), usual = cards.find((c) => c.key === K.mail);
      assert.deepEqual(run.buttons.map((b) => `${b.word}:${b.kind}`), ["Allow once:filled", "Deny:outline", "Open:outline"]);
      if (width >= 460) assert.equal(run.height, usual.height, `${theme}: the others' height (${run.height})`);
      else assert.ok(run.height >= usual.height && run.height <= 100, `${theme} ${width}px: a little taller where its sentence takes two lines (${run.height})`);
      assert.equal(new Set(run.buttons.map((b) => Math.round(b.top))).size, 1, "its three answers on one line");
      const note = await x.page.evaluate((key) => { const n = document.querySelector(`.dgc-hub-card[data-key="${key}"] .dgc-card-note`); return { whole: n.scrollWidth <= n.clientWidth, top: n.getBoundingClientRect().top }; }, K.run);
      assert.ok(note.whole && run.buttons.every((b) => b.bottom <= note.top + 0.5 && b.inside), `${theme} ${width}px: the answers stand over the command's line, which is whole`);
      // The order they are drawn in is the order Tab takes and the order they are read: Allow once, Deny, Open.
      for (let i = 1; i < run.buttons.length; i++) assert.ok(run.buttons[i].left >= run.buttons[i - 1].right - 0.5, "left to right, no answer over another");
    } finally { await x.close(); }
  }
});

test("a side bar under 225 px: the answers stay at the card's right as icons, the same squares, nothing cut", async (t) => {
  if (skipOrFail(t)) return;
  // (Before 12 Nov the answers went under the words in one row that shared the card's width, and every card was 94 px.)
  for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [170, 220]) {
    const x = await openCards(browser, { theme, width });
    try {
      const cards = await answers(x.page), all = cards.flatMap((c) => c.buttons.map((b) => ({ ...b, key: c.key })));
      for (const c of cards) {
        assert.equal(c.buttons.filter((b) => b.kind === "filled").length, 1, `${theme} ${width}px ${c.key}: one filled answer`);
        assert.deepEqual(c.buttons.filter((b) => !b.inside || !b.whole).map((b) => b.word), [], `${theme} ${width}px ${c.key}: every answer inside its card and whole`);
        assert.equal(new Set(c.buttons.map((b) => Math.round((b.top + b.bottom) / 2))).size, 1, `${theme} ${width}px ${c.key}: its answers on one row`);
        assert.ok(c.column <= 76, `${theme} ${width}px ${c.key}: a row no wider than 76 px`);
      }
      assert.deepEqual([...new Set(all.map((b) => `${b.height}/${b.radius}/${b.size}`))], ["24/6px/11px"], `${theme} ${width}px: the same squares`);
      assert.deepEqual(all.filter((b) => b.label < 4.5).map((b) => `${b.word} ${b.label}`), [], `${theme} ${width}px: icons at 4.5:1`);
      assert.equal(new Set(cards.filter((c) => !c.mono).map((c) => c.height)).size, 1, `${theme} ${width}px: every card one height`);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    } finally { await x.close(); }
  }
});

for (const theme of ["dark-modern", "light-modern", "hc"]) {
  test(`${theme}: the same card anywhere else in the side bar wears the same corner, kinds and steps, at its own size`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openCards(browser, { theme, width: 460 });
    try {
      // The shared card as Work, ChatDGC and a Pip's chat draw it (media/shared/card.js), full size and thin.
      await x.page.evaluate(() => { const host = document.createElement("div"); host.id = "elsewhere"; host.style.cssText = "padding:12px;max-width:420px";
        for (const cls of ["", "dgc-card-thin"]) host.append(window.DgcCard.node({ id: `else-${cls || "full"}`, cls, icon: "app", title: "Connect Google Calendar?", sub: "So it can read your week.",
          chips: ["Reads events"], actions: [{ label: "Allow", primary: true }, { label: "Not now" }], details: { rows: [["Account", "me@mail.example"]] } }));
        document.getElementById("home-hub").after(host); });
      await settle(x.page);
      const cards = await answers(x.page, "#elsewhere");
      assert.equal(cards.length, 2);
      for (const c of cards) {
        assert.deepEqual(c.buttons.map((b) => `${b.word}:${b.kind}:${b.radius}`), ["Allow:filled:6px", "Not now:outline:6px"], `${c.key}: one filled, one outline, the 6 px corner`);
        assert.equal(new Set(c.buttons.map((b) => b.height)).size, 1, `${c.key}: one height (${c.buttons.map((b) => b.height)})`);
        assert.deepEqual(c.buttons.filter((b) => b.label < 4.5).map((b) => `${b.word} ${b.label}`), [], `${c.key}: labels at 4.5:1`);
      }
      assert.deepEqual(cards.map((c) => c.buttons[0].height), [28, 28], "at the shared card's own height, 28 px");
      const sel = '#elsewhere .dgc-card-btn:not(.primary)';
      const y = () => x.page.evaluate((s) => { const c = getComputedStyle(document.querySelector(s)); return new DOMMatrixReadOnly(c.transform === "none" ? "" : c.transform).f; }, sel);
      await x.page.hover(sel); await settle(x.page);
      assert.equal(await y(), -1, "pointed at, it steps up 1 px");
      await x.page.mouse.down(); await settle(x.page);
      assert.equal(await y(), 1, "pressed, 1 px down");
      await x.page.mouse.move(2, 2); await x.page.mouse.up();
    } finally { await x.close(); }
  });
}
