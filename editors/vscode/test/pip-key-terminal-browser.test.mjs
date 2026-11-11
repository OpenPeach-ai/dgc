// How "Also let its Terminal use it" looks (pips-10 slice 2c; src/pipKeys.js, src/pips.css), in real Chromium, in the
// side bar (a shadow root on Work's page), dark and light at 300 and 700 px. At Do it all, with a computer: one quiet
// tick under the box of a site's key card, in the card's muted words at 4.5:1, inside the card and the panel with no
// word cut, no purple; the keyboard reaches it from the box (Tab), it shows a focus ring, and Space ticks it. Below Do
// it all the card is the one it always was, box for box. On the Pip's page, Keys: the row says where the key is, inside
// the panel. What it sends is pip-key-terminal.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";

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

// A stand-in, never a real key.
const KEY = "inv_test_0123456789abcdefSECRET";
const KEYID = "pipkey_" + "a".repeat(32);
const CARD = "[data-pip-key-card]", TICK = `${CARD} input[type="checkbox"]`;
const WORDS = "Also let its Terminal use it, as $INVOICELY_API_KEY (it could read it there)";
// What `selector` (the card, or the Keys group) measures as. Colours are read as painted over their ground.
const look = (p, selector) => p.evaluate((selector) => {
  const root = window.__pipsRoot || document, card = root.querySelector(selector); if (!card) return null;
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement || n.getRootNode().host) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (n) => { const g = ground(n), c = over(parse(getComputedStyle(n).color), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const box = card.getBoundingClientRect(), r = (n) => n.getBoundingClientRect(), inside = (n) => r(n).left >= box.left - 0.5 && r(n).right <= box.right + 0.5 && r(n).top >= box.top - 0.5 && r(n).bottom <= box.bottom + 0.5;
  const purple = (c) => c[3] > 0.05 && c[2] - c[1] > 40 && c[0] - c[1] > 15;
  const purples = [card, ...card.querySelectorAll("*")].filter((n) => { const s = getComputedStyle(n); return [s.color, s.backgroundColor, s.borderTopColor, s.accentColor, s.outlineStyle === "none" ? "" : s.outlineColor].some((c) => c && c !== "auto" && purple(parse(c))) && (n.textContent.trim() || n.tagName === "INPUT"); }).map((n) => n.tagName + "." + n.className);
  const buttons = [...card.querySelectorAll("button:not(.pip-tip-btn)")].map((b) => ({ word: b.textContent, width: Math.round(r(b).width), height: Math.round(r(b).height), top: Math.round(r(b).top), off: b.disabled, inside: inside(b), whole: b.scrollWidth <= b.clientWidth + 1 }));
  const s = getComputedStyle(card), tick = card.querySelector('input[type="checkbox"]'), label = tick?.closest("label"), words = label?.querySelector("span");
  const pass = card.querySelector('input[type="password"]'), note = card.querySelector(".app-link-note"), actions = card.querySelector(".dgc-card-actions");
  const ts = tick ? getComputedStyle(tick) : null, active = root.activeElement;
  return { state: card.dataset.state, text: card.textContent, buttons, purples,
    box: { ground: s.backgroundColor, edge: s.borderTopColor, radius: s.borderTopLeftRadius, pad: s.padding }, height: Math.round(box.height),
    tick: tick ? { checked: tick.checked, off: tick.disabled, width: r(tick).width, height: r(tick).height, inside: inside(tick), focused: active === tick, keys: tick.matches(":focus-visible"),
      ring: { style: ts.outlineStyle, width: parseFloat(ts.outlineWidth), offset: parseFloat(ts.outlineOffset) }, ringInside: r(tick).left - 4 >= box.left && r(tick).top - 4 >= box.top,
      // The ring against the card's ground (3:1 for something that is not words).
      ringRatio: (() => { const g = ground(label), c = over(parse(ts.outlineColor), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; })(),
      label: label.textContent, labelInside: inside(label), wordsInside: inside(words), whole: words.scrollWidth <= words.clientWidth + 1, ratio: ratio(words), size: getComputedStyle(words).fontSize, ink: getComputedStyle(words).color,
      noteInk: getComputedStyle(note).color, noteSize: getComputedStyle(note).fontSize, lines: Math.round(r(words).height / parseFloat(getComputedStyle(words).lineHeight)),
      // Left of its words, level with their first line; under the box and its note, above the answers.
      beside: r(tick).right <= r(words).left && Math.abs((r(tick).top + r(tick).height / 2) - (r(words).top + parseFloat(getComputedStyle(words).lineHeight) / 2)) <= 3,
      order: r(pass).bottom <= r(note).top + 0.5 && r(note).bottom <= r(label).top + 0.5 && r(label).bottom <= r(actions).top + 0.5, left: Math.round(r(tick).left - r(pass).left) } : null,
    passFocused: active === pass, activeTag: active?.tagName + (active?.type ? ":" + active.type : ""),
    small: [...card.querySelectorAll("small")].map((n) => ({ text: n.textContent, ratio: ratio(n), inside: inside(n), whole: n.scrollWidth <= n.clientWidth + 1 })),
    rows: [...card.querySelectorAll("[data-pip-key]")].map((n) => ({ text: n.textContent, inside: inside(n) })),
    right: box.right, vw: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, html: (root.querySelector("#app") || document.body).innerHTML };
}, selector);

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: at Do it all the site key card has one quiet tick under the box; the keyboard reaches it, it shows a ring, Space ticks it, and Save sends it`, async (t) => {
    if (skipOrFail(t)) return;
    const below = await openChat(browser, { width, height: 900, theme, api: 85, settings: true, level: "approve", ownKeys: true });
    let plain;
    try { await below.p.waitForSelector(CARD); plain = await look(below.p, CARD); assert.deepEqual(below.errors, []); } finally { await below.close(); }
    assert.equal(plain.tick, null, "below Do it all: no tick");
    assert.ok(!/Terminal/.test(plain.text), "and no word of a Terminal");
    const x = await openChat(browser, { width, height: 900, theme, api: 85, settings: true, level: "full", ownKeys: true });
    try {
      await x.p.waitForSelector(TICK);
      const v = await look(x.p, CARD);
      assert.deepEqual([v.tick.label, v.tick.checked, v.tick.off], [WORDS, false, false], "the tick, with the variable's name, off to begin");
      assert.deepEqual(v.box, plain.box, "the same card: ground, edge, corner, padding");
      assert.deepEqual(v.buttons.map((b) => [b.word, b.width, b.height, b.off]), plain.buttons.map((b) => [b.word, b.width, b.height, b.off]), "the same two answers at the same size");
      assert.equal(new Set(v.buttons.map((b) => b.top)).size, 1, "on one line");
      assert.ok(v.tick.order, "under the box and where the key goes, above Save");
      assert.ok(v.tick.beside && v.tick.left === 0, `the tick left of its words, level with their first line, in line with the box (${v.tick.left})`);
      assert.deepEqual([v.tick.width, v.tick.height], [14, 14], "a small tick");
      assert.deepEqual([v.tick.ink, v.tick.size], [v.tick.noteInk, v.tick.noteSize], "quiet: the ink and size of the card's own note");
      assert.ok(v.tick.ratio >= 4.5, `its words at 4.5:1 (${v.tick.ratio})`);
      assert.ok(v.tick.inside && v.tick.labelInside && v.tick.wordsInside && v.tick.whole && v.buttons.every((b) => b.inside && b.whole) && v.right <= v.vw && !v.sideways, "everything inside the card and the panel, no word cut");
      assert.ok(width === 300 ? v.tick.lines >= 2 : v.tick.lines === 1, `its words wrap in a narrow panel, and are one line in a wide one (${v.tick.lines})`);
      assert.deepEqual(v.purples, [], "no purple on the card");
      // The keyboard: Tab from the box lands on the tick, which shows a ring; Space ticks it; Tab again is Not now
      // (Save is off: nothing typed yet).
      await x.p.locator(`${CARD} input[type="password"]`).focus();
      await x.p.keyboard.press("Tab");
      const on = await look(x.p, CARD);
      assert.ok(on.tick.focused && on.tick.keys, `Tab from the box lands on the tick (${on.activeTag})`);
      assert.ok(on.tick.ring.style === "solid" && on.tick.ring.width >= 2 && on.tick.ring.offset >= 1 && on.tick.ringInside, `a ring that shows: ${JSON.stringify(on.tick.ring)}`);
      assert.ok(on.tick.ringRatio >= 3, `the ring at 3:1 on the card (${on.tick.ringRatio})`);
      assert.deepEqual(on.purples, [], "the ring is not purple");
      await x.p.keyboard.press("Space");
      const ticked = await look(x.p, CARD);
      assert.deepEqual([ticked.tick.checked, ticked.tick.focused, ticked.height], [true, true, v.height], "Space ticks it; the card does not move");
      await x.p.keyboard.press("Shift+Tab");
      assert.ok((await look(x.p, CARD)).passFocused, "Shift+Tab is back in the box");
      await x.p.keyboard.type(KEY);
      const typed = await look(x.p, CARD);
      assert.deepEqual([typed.tick.checked, typed.buttons[0].off], [true, false], "typed: Save is on, the tick still ticked");
      assert.ok(!typed.html.includes(KEY), "the key is in its box only, never in the page's markup");
      // A click on the words unticks and ticks it again.
      await x.p.locator(`${CARD} .pip-key-terminal span`).click();
      assert.equal((await look(x.p, CARD)).tick.checked, false, "its words are its label");
      await x.p.locator(`${CARD} .pip-key-terminal span`).click();
      await x.p.locator(`${CARD} button.primary`).click();
      await x.p.waitForSelector(`${CARD}[data-state="saved"]`);
      const saved = await look(x.p, CARD);
      assert.match(saved.text, /Mornings has the Invoicely API key.*Saved · In its Terminal as \$INVOICELY_API_KEY/);
      assert.ok(saved.small.every((n) => n.inside && n.ratio >= 4.5) && saved.right <= saved.vw && !saved.sideways, "said inside the card, at 4.5:1");
      assert.ok(!saved.html.includes(KEY), "nowhere on the page once sent");
      assert.deepEqual(await x.p.evaluate(() => window.__ownKeySent), { fields: ["key_id", "pip_id", "terminal", "type", "value"], key_id: KEYID, chars: KEY.length, terminal: true });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${theme} ${width}px: unticked, Save sends no terminal`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, height: 900, theme, api: 85, settings: true, level: "full", ownKeys: true });
    try {
      await x.p.waitForSelector(TICK);
      await x.p.locator(`${CARD} input[type="password"]`).fill(KEY);
      await x.p.locator(`${CARD} button.primary`).click();
      await x.p.waitForSelector(`${CARD}[data-state="saved"]`);
      assert.match((await look(x.p, CARD)).text, /Saved · it never saw the key/);
      assert.deepEqual(await x.p.evaluate(() => window.__ownKeySent), { fields: ["key_id", "pip_id", "type", "value"], key_id: KEYID, chars: KEY.length });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  for (const [level, says] of [["full", "api.invoicely.example · Saved · In its Terminal as $INVOICELY_API_KEY"], ["approve", "api.invoicely.example · Saved · In its Terminal at Do it all only"]]) {
    test(`${theme} ${width}px: Keys on the Pip's page (${level}): the ticked key's row says where it is, inside the panel`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openChat(browser, { width, height: 900, theme, api: 85, settings: true, level, ownKeys: "list-terminal" });
      const GROUP = 'section[aria-label="Keys"]';
      try {
        await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
        await x.p.waitForSelector(GROUP);
        await x.p.locator(GROUP).scrollIntoViewIfNeeded();
        await x.p.waitForFunction((says) => (window.__pipsRoot || document).querySelector('section[aria-label="Keys"] small')?.textContent === says, says);
        const v = await look(x.p, GROUP);
        assert.deepEqual(v.small.map((n) => n.text), [says, "api.weather.example · Waiting for you", "api.flights.example · Not now"]);
        assert.ok(v.rows.every((r) => r.inside) && v.small.every((n) => n.inside && n.whole && n.ratio >= 4.5) && v.buttons.every((b) => b.inside && b.whole) && v.right <= v.vw && !v.sideways, "every row, line and button inside the panel, no word cut, at 4.5:1");
        assert.equal(new Set(v.buttons.map((b) => [b.width, b.height].join())).size, 1, "Remove at one size on every row");
        assert.deepEqual(v.purples, [], "no purple in Keys");
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    });
  }
}
