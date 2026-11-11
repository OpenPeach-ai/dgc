// The answers on a card are one small system (media/shared/card.css for every card in the side bar, media/shared/hub.css
// for Home's slim ones; the look picked on 11 Nov, "compact squares"): exactly one filled button marks a card's main
// answer, in the text's own colour; every other answer is one hairline outline; the way to all of it is a text link.
// One 6 px corner, one height, one label size and side padding. Each button answers the pointer (a 1 px step up, a
// 1 px press), shows a focus ring, and rests under reduced motion. Measured in real Chromium on the side bar's real page:
//   - Home at 300, 460 and 700 px, dark, light and high contrast: the sizes, one filled button a card, never a third style
//   - labels at 4.5:1 or better, an outline's line at 3:1 in high contrast
//   - hover, press, focus; reduced motion
//   - the quiet link's hit area is 22 px tall, like a button's
//   - the command card in one row (a card from about 420 px), and a side bar under 225 px
//   - the same card anywhere else in the side bar wears the same corner, styles and steps
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
    const buttons = [...card.querySelectorAll(".dgc-card-actions .dgc-card-btn")].map((b) => { const s = getComputedStyle(b), r = b.getBoundingClientRect(), fill = parse(s.backgroundColor);
      const kind = s.backgroundColor === solid ? "filled" : fill[3] === 0 && parseFloat(s.borderTopWidth) === 1 && parse(s.borderTopColor)[3] > 0 ? "outline" : fill[3] === 0 && (parseFloat(s.borderTopWidth) === 0 || parse(s.borderTopColor)[3] === 0) && s.textDecorationLine.includes("underline") ? "link" : "other";   // (a link has no edge at all: forced colours draw every edge, a clear one too)
      const under = ground(b.parentElement);
      return { word: b.textContent, kind, primary: b.classList.contains("primary"), height: Math.round(r.height * 10) / 10, width: Math.round(r.width * 10) / 10, radius: s.borderTopLeftRadius, size: s.fontSize, weight: s.fontWeight, pad: [s.paddingLeft, s.paddingRight],
        label: ratio(s.color, kind === "filled" ? over(fill, under) : under), line: kind === "outline" ? ratio(s.borderTopColor, under) : null, inside: r.left >= box.left + 3 && r.right <= box.right - 3 && r.top >= box.top + 3 && r.bottom <= box.bottom - 3,
        whole: b.scrollWidth <= b.clientWidth + 1, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; });
    const col = card.querySelector(".dgc-card-actions")?.getBoundingClientRect();
    return { key: card.dataset.key || card.dataset.dgcCard, mono: card.classList.contains("dgc-hub-mono"), height: Math.round(box.height * 2) / 2, width: Math.round(box.width), column: col ? Math.round(col.width * 10) / 10 : 0, buttons }; });
}, within);

for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 460, 700, 1000]) {
  test(`${theme} ${width}px: one filled button a card, every other an outline, the rest a link; one corner, height and label size; labels at 4.5:1`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openCards(browser, { theme, width });
    try {
      const cards = await answers(x.page);
      assert.ok(cards.length >= 10, `every kind of card is on Home (${cards.length})`);
      const all = cards.flatMap((c) => c.buttons.map((b) => ({ ...b, key: c.key })));
      assert.deepEqual([...new Set(all.map((b) => b.kind))].sort(), ["filled", "link", "outline"], "three kinds and never a fourth");
      for (const c of cards) {
        assert.equal(c.buttons.filter((b) => b.kind === "filled").length, 1, `${c.key}: exactly one filled button (${c.buttons.map((b) => `${b.word}:${b.kind}`)})`);
        assert.deepEqual(c.buttons.filter((b) => b.kind === "filled").map((b) => b.primary), [true], `${c.key}: and it is the main answer`);
        assert.ok(c.buttons.filter((b) => b.kind === "link").length <= 1, `${c.key}: at most one link`);
        assert.deepEqual(c.buttons.filter((b) => !b.inside || !b.whole).map((b) => b.word), [], `${c.key}: every answer is inside its card and whole`);
      }
      const boxed = all.filter((b) => b.kind !== "link");
      // (11 Nov, "all buttons sizes should be fixed": every button is one box, 76 by 22 px, whatever its words. A side bar under about 225 px shares a row equally instead: its own test.)
      assert.deepEqual([...new Set(boxed.map((b) => `${b.width}x${b.height}/${b.radius}/${b.size}/${b.weight}`))], ["76x22/6px/11px/500"], "one box, corner and label size for every button: Open and Mark read are the same size");
      assert.deepEqual([...new Set(all.filter((b) => b.kind === "link").map((b) => b.size))], ["11px"], "the link's words are the same size");
      const low = all.filter((b) => b.label < 4.5).map((b) => `${b.key} ${b.word} ${b.label}`);
      assert.deepEqual(low, [], "every label reads at 4.5:1");
      if (theme === "hc") assert.deepEqual(all.filter((b) => b.kind === "outline" && b.line < 3).map((b) => `${b.word} ${b.line}`), [], "in high contrast an outline's line is 3:1");
      // In a roomy card the answers' column is one width, so they line up down the page.
      assert.deepEqual([...new Set(cards.filter((c) => !c.mono).map((c) => c.column))], [76], "one column width on every card");
      for (const c of cards.filter((k) => !k.mono)) assert.ok(new Set(c.buttons.filter((b) => b.kind !== "link").map((b) => `${Math.round(b.left * 10)}/${Math.round(b.right * 10)}`)).size === 1, `${c.key}: its buttons line up on both edges`);
      const edges = new Map(); for (const c of cards.filter((k) => !k.mono)) for (const b of c.buttons.filter((k) => k.kind !== "link")) edges.set(Math.round(b.left), (edges.get(Math.round(b.left)) || 0) + 1);
      assert.ok(edges.size <= (width >= 1000 ? 3 : width >= 700 ? 2 : 1), `the columns line up down the page, one line of buttons a column of cards (${[...edges.keys()]})`);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "nothing runs off the side");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a button answers the pointer: 1 px up when pointed at (an outline gains a faint fill and a firmer line), 1 px down when pressed; a link stays put", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 700 });
  try {
    const card = `.dgc-hub-card[data-key="${K.visit}"]`;
    const now = (sel) => x.page.evaluate((s) => { const b = document.querySelector(s), c = getComputedStyle(b), m = new DOMMatrixReadOnly(c.transform === "none" ? "" : c.transform);
      return { y: Math.round(m.f * 100) / 100, scale: Math.round(m.a * 1000) / 1000, fill: c.backgroundColor, line: c.borderTopColor, moves: c.transitionProperty.includes("transform"), ms: c.transitionDuration.split(",")[0].trim() }; }, sel);
    for (const [name, sel] of [["the filled button", `${card} .dgc-card-btn.primary`], ["an outline", `${card} [data-hub-act="no"]`]]) {
      const rest = await now(sel);
      assert.deepEqual([rest.y, rest.scale, rest.moves, rest.ms], [0, 1, true, "0.12s"], `${name}: at rest (it settles back in the shared 120 ms)`);
      await x.page.hover(sel); await settle(x.page);
      const pointed = await now(sel);
      assert.deepEqual([pointed.y, pointed.scale, pointed.ms], [-1, 1, "0.15s"], `${name}: pointed at, it steps up 1 px, in 150 ms`);
      assert.notEqual(pointed.fill, rest.fill, `${name}: and its fill changes`);
      if (name === "an outline") assert.notEqual(pointed.line, rest.line, "an outline's line firms up");
      await x.page.mouse.down(); await settle(x.page);
      const pressed = await now(sel);
      assert.deepEqual([pressed.y, pressed.scale, pressed.ms], [1, 0.985, "0.09s"], `${name}: pressed, it sinks 1 px below rest, in 90 ms`);
      // (Let go away from it, so nothing is answered.)
      await x.page.mouse.move(2, 2); await x.page.mouse.up(); await settle(x.page);
      assert.deepEqual([(await now(sel)).y, (await now(sel)).fill], [0, rest.fill], `${name}: and rests again`);
    }
    const link = `${card} .dgc-hub-open`;
    await x.page.hover(link); await settle(x.page);
    assert.equal((await now(link)).y, 0, "the link does not step: it is words");
  } finally { await x.close(); }
});

test("reduced motion: nothing steps or sinks, and the colours still answer", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openCards(browser, { width: 700, motion: "reduce" });
  try {
    const sel = `.dgc-hub-card[data-key="${K.visit}"] [data-hub-act="no"]`;
    const now = () => x.page.evaluate((s) => { const c = getComputedStyle(document.querySelector(s)); return [c.transform, c.backgroundColor]; }, sel);
    const rest = await now();
    await x.page.hover(sel); await settle(x.page);
    const pointed = await now();
    assert.equal(pointed[0], "none", "no step");
    assert.notEqual(pointed[1], rest[1], "the fill still answers");
    await x.page.mouse.down(); await settle(x.page);
    assert.equal((await now())[0], "none", "no press move");
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
        const at = await x.page.evaluate(() => { const a = document.activeElement; if (!a?.dataset?.hubAct) return null; const s = getComputedStyle(a);
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

test("the quiet link is as easy to hit as a button: 22 px tall where it is pressed, and never over the answer above it", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 700]) {
    const x = await openCards(browser, { width });
    try {
      const hits = await x.page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card .dgc-hub-open")].map((link) => { const r = link.getBoundingClientRect(), cx = (r.left + r.right) / 2;
        let top = r.top, bottom = r.bottom;
        while (top > r.top - 30 && document.elementFromPoint(cx, top - 0.5) === link) top -= 0.5;
        while (bottom < r.bottom + 30 && document.elementFromPoint(cx, bottom + 0.5) === link) bottom += 0.5;
        const above = [...link.parentElement.querySelectorAll(".dgc-card-btn:not(.dgc-hub-open)")].map((b) => b.getBoundingClientRect()).filter((b) => b.bottom <= r.top + 1 && b.left < r.right && b.right > r.left);
        const card = link.closest(".dgc-hub-card").getBoundingClientRect();
        return { key: link.closest(".dgc-hub-card").dataset.key, tall: Math.round((bottom - top) * 10) / 10, wide: Math.round(r.width), clear: above.every((b) => top >= b.bottom - 0.5), inCard: bottom <= card.bottom + 0.5 && top >= card.top - 0.5 }; }));
      assert.ok(hits.length >= 2, `${width}px: the links are there (${hits.length})`);
      for (const h of hits) assert.ok(h.tall >= 22 && h.clear && h.inCard && h.wide >= 28, `${width}px ${h.key}: ${JSON.stringify(h)}`);
    } finally { await x.close(); }
  }
});

test("a command card about 420 px wide or more is one row: its three answers beside its sentence, the others' height", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern", "hc"]) {
    const x = await openCards(browser, { theme, width: 460 });
    try {
      const cards = await answers(x.page), run = cards.find((c) => c.key === K.run), usual = cards.find((c) => c.key === K.mail);
      assert.deepEqual(run.buttons.map((b) => `${b.word}:${b.kind}`), ["Allow once:filled", "Deny:outline", "Open:link"]);
      assert.equal(run.height, usual.height, `${theme}: the others' height (${run.height})`);
      const tops = run.buttons.filter((b) => b.kind !== "link").map((b) => Math.round(b.top));
      assert.equal(new Set(tops).size, 1, "its two buttons on one line");
      const note = await x.page.evaluate((key) => { const n = document.querySelector(`.dgc-hub-card[data-key="${key}"] .dgc-card-note`); return { whole: n.scrollWidth <= n.clientWidth, top: n.getBoundingClientRect().top }; }, K.run);
      assert.ok(note.whole && run.buttons.every((b) => b.bottom <= note.top + 0.5 && b.inside), `${theme}: the answers stand over the command's line, which is whole`);
      // The order they are drawn in is the order Tab takes: Allow once, Deny, Open is read left to right as Open, Allow once, Deny only in a narrow card.
      for (let i = 1; i < run.buttons.length; i++) for (let j = 0; j < i; j++) assert.ok(run.buttons[i].left >= run.buttons[j].right - 0.5 || run.buttons[j].left >= run.buttons[i].right - 0.5, "no answer over another");
    } finally { await x.close(); }
  }
});

test("a side bar under 225 px: the answers go under the words in one row, the same buttons, nothing cut", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [170, 220]) {
    const x = await openCards(browser, { theme, width });
    try {
      const cards = await answers(x.page), all = cards.flatMap((c) => c.buttons.map((b) => ({ ...b, key: c.key })));
      for (const c of cards) {
        assert.equal(c.buttons.filter((b) => b.kind === "filled").length, 1, `${theme} ${width}px ${c.key}: one filled button`);
        assert.deepEqual(c.buttons.filter((b) => !b.inside || !b.whole).map((b) => b.word), [], `${theme} ${width}px ${c.key}: every answer inside its card and whole`);
        if (!c.mono) assert.equal(new Set(c.buttons.map((b) => Math.round((b.top + b.bottom) / 2))).size, 1, `${theme} ${width}px ${c.key}: its answers on one row`);
      }
      assert.deepEqual([...new Set(all.filter((b) => b.kind !== "link").map((b) => `${b.height}/${b.radius}/${b.size}`))], ["22/6px/11px"], `${theme} ${width}px: the same buttons`);
      assert.deepEqual(all.filter((b) => b.label < 4.5).map((b) => `${b.word} ${b.label}`), [], `${theme} ${width}px: labels at 4.5:1`);
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
