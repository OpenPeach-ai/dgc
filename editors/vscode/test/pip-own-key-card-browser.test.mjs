// How a Personal Pip's own key card and its Keys list look (src/pipKeys.js, src/pips.css, the shared card and button),
// in real Chromium, in the side bar (a shadow root on Work's page), dark and light at 300 and 700 px. The card is the
// plugin key card's box for box (measured against it): one filled answer and one outline at one size, the 6 px corner
// on the box too, the key masked, everything inside the card and the panel, words at 4.5:1, no purple. Typed, Save
// comes on; saved, the card says so and the key is nowhere on the page; Not now leaves one quiet line; a key its site
// turned away says so. On the Pip's page, Keys: each row inside the panel, and Remove asks in the row with the danger
// button (red fill, white words) beside Keep it. What it sends is pip-own-key-card.test.mjs.
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
// What `selector` (a card, a line, or the Keys group) measures as. Colours are read as painted over their ground.
const look = (p, selector) => p.evaluate((selector) => {
  const root = window.__pipsRoot || document, card = root.querySelector(selector); if (!card) return null;
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement || n.getRootNode().host) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (n) => { const g = ground(n), c = over(parse(getComputedStyle(n).color), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const box = card.getBoundingClientRect(), r = (n) => n.getBoundingClientRect(), inside = (n) => r(n).left >= box.left - 0.5 && r(n).right <= box.right + 0.5 && r(n).top >= box.top - 0.5 && r(n).bottom <= box.bottom + 0.5;
  // Purple: blue well over green, red between. Read on everything the box draws (its ink, ground and edges).
  const purple = (c) => c[3] > 0.05 && c[2] - c[1] > 40 && c[0] - c[1] > 15;
  const purples = [card, ...card.querySelectorAll("*")].filter((n) => { const s = getComputedStyle(n); return [s.color, s.backgroundColor, s.borderTopColor].some((c) => purple(parse(c))) && (n.textContent.trim() || n.tagName === "INPUT"); }).map((n) => n.tagName + "." + n.className);
  const buttons = [...card.querySelectorAll("button:not(.pip-tip-btn)")].map((b) => { const s = getComputedStyle(b), bg = parse(s.backgroundColor); return { word: b.textContent, filled: bg[3] > 0.9, outline: bg[3] === 0 && parseFloat(s.borderTopWidth) === 1,
    red: bg[3] > 0.9 && bg[0] > 150 && bg[1] < 60 && bg[2] < 60, ink: parse(s.color).slice(0, 3).map(Math.round).join(), radius: s.borderTopLeftRadius, width: Math.round(r(b).width), height: Math.round(r(b).height), off: b.disabled,
    ratio: b.disabled ? null : ratio(b), inside: inside(b), whole: b.scrollWidth <= b.clientWidth + 1, top: Math.round(r(b).top) }; });
  const inputs = [...card.querySelectorAll("input")].map((i) => ({ type: i.type, radius: getComputedStyle(i).borderTopLeftRadius, height: Math.round(r(i).height), inside: inside(i), label: root.querySelector(`label[for="${i.id}"]`)?.textContent, labelRatio: ratio(root.querySelector(`label[for="${i.id}"]`)), value: i.value }));
  const s = getComputedStyle(card), words = (q) => [...card.querySelectorAll(q)].map((n) => ({ text: n.textContent, ratio: ratio(n), inside: inside(n) }));
  return { state: card.dataset.state, tag: card.tagName, text: card.textContent, shared: card.classList.contains("dgc-card"), buttons, inputs, purples, ratio: ratio(card),
    box: { ground: s.backgroundColor, edge: s.borderTopColor, radius: s.borderTopLeftRadius, pad: s.padding }, title: card.querySelector("strong") ? ratio(card.querySelector("strong")) : null,
    notes: words(".app-link-note"), refused: words("[data-pip-key-refused]"), small: words("small"), rows: words("[data-pip-key]"), asks: words(".pip-key-ask"),
    left: box.left, right: box.right, vw: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, html: (root.querySelector("#app") || document.body).innerHTML };
}, selector);
const CARD = "[data-pip-key-card]";

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: the Pip's own key card is the plugin key card's box, the key is masked, Save comes on when it is typed, and saved it says so`, async (t) => {
    if (skipOrFail(t)) return;
    const model = await openChat(browser, { width, theme, api: 82, keys: true });
    let plugin;
    try { await model.p.waitForSelector("[data-key-card]"); plugin = await look(model.p, "[data-key-card]"); } finally { await model.close(); }
    const x = await openChat(browser, { width, theme, api: 82, ownKeys: true });
    try {
      await x.p.waitForSelector(CARD);
      const v = await look(x.p, CARD);
      assert.deepEqual([v.state, v.shared], ["requested", true]);
      assert.match(v.text, /Mornings needs the Invoicely API key.*To read your unpaid invoices for the morning brief\..*Only sent to api\.invoicely\.example, by DGC\. Mornings never sees it\./);
      assert.deepEqual(v.box, plugin.box, "the plugin key card's own box: ground, edge, corner, padding");
      assert.deepEqual(v.buttons.map((b) => [b.word, b.filled, b.outline, b.radius, b.off]), [["Save", true, false, "6px", true], ["Not now", false, true, "6px", false]], "one filled answer (off until the key is typed), one outline, the 6 px corner");
      assert.deepEqual(v.buttons.map((b) => [b.width, b.height]), plugin.buttons.map((b) => [b.width, b.height]), "the answers at the plugin key card's size");
      assert.equal(new Set(v.buttons.map((b) => b.top)).size, 1, "on one line");
      assert.deepEqual(v.inputs.map((i) => [i.type, i.radius, i.height, i.label, i.inside]), [["password", "6px", plugin.inputs[0].height, "Invoicely API key", true]], "one masked box, the same corner and height, its label the key's name");
      assert.ok(v.buttons.every((b) => b.inside && b.whole) && v.right <= v.vw && !v.sideways, "everything inside the card and the panel");
      assert.ok(v.notes.every((n) => n.inside && n.ratio >= 4.5) && v.small.every((n) => n.inside && n.ratio >= 4.5), "every line inside the card, at 4.5:1");
      assert.ok(v.title >= 4.5 && v.inputs[0].labelRatio >= 4.5 && v.buttons[1].ratio >= 4.5, `words at 4.5:1 (${v.title}, ${v.inputs[0].labelRatio}, ${v.buttons[1].ratio})`);
      assert.deepEqual(v.purples, [], "no purple on the card");
      await x.p.locator(`${CARD} input`).fill(KEY);
      const typed = await look(x.p, CARD);
      assert.deepEqual([typed.buttons[0].off, typed.inputs[0].value === KEY], [false, true], "typed: Save is on");
      assert.ok(typed.buttons[0].ratio >= 4.5, `Save's label at 4.5:1 (${typed.buttons[0].ratio})`);
      assert.ok(!typed.html.includes(KEY), "the key is in its box only, never in the page's markup");
      await x.p.locator(`${CARD} button.primary`).click();
      await x.p.waitForSelector(`${CARD}[data-state="saved"]`);
      const saved = await look(x.p, CARD);
      assert.match(saved.text, /Mornings has the Invoicely API key.*Saved · it never saw the key/);
      assert.deepEqual([saved.inputs.length, saved.buttons.length], [0, 0]);
      assert.ok(saved.title >= 4.5 && saved.small.every((n) => n.ratio >= 4.5));
      assert.ok(!saved.html.includes(KEY), "nowhere on the page once sent");
      assert.deepEqual(await x.p.evaluate(() => window.__ownKeySent), { fields: ["key_id", "pip_id", "type", "value"], key_id: KEYID, chars: KEY.length });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${theme} ${width}px: a key its site turned away says so on the card; Not now leaves one quiet line`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, theme, api: 82, ownKeys: "refused" });
    try {
      await x.p.waitForSelector(CARD);
      const v = await look(x.p, CARD);
      assert.deepEqual(v.refused.map((n) => [n.text, n.inside, n.ratio >= 4.5]), [["api.invoicely.example turned the saved key away. Paste a new one.", true, true]], JSON.stringify(v.refused));
      assert.ok(v.buttons.every((b) => b.inside && b.whole) && v.right <= v.vw && !v.sideways);
      await x.p.locator(`${CARD} input`).fill(KEY);
      await x.p.locator(`${CARD} [data-pip-key-decline]`).click();
      await x.p.waitForSelector(`${CARD}[data-state="declined"]`);
      const line = await look(x.p, CARD);
      assert.deepEqual([line.tag, line.text, line.shared, line.buttons.length, line.inputs.length], ["P", "Not now · Invoicely API key", false, 0, 0]);
      assert.ok(line.ratio >= 4.5 && line.left >= 0 && line.right <= line.vw && !line.sideways, `the line reads at 4.5:1 (${line.ratio}), inside the panel`);
      assert.ok(!line.html.includes(KEY), "what was typed is gone");
      assert.equal(await x.p.evaluate(() => window.__ownKeySent), undefined, "and was never sent");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${theme} ${width}px: Keys on the Pip's page: each row inside the panel, and Remove asks in the row with the danger button`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, height: 900, theme, api: 82, settings: true, ownKeys: "list" });
    const GROUP = 'section[aria-label="Keys"]';
    try {
      await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
      await x.p.waitForSelector(GROUP);
      await x.p.locator(GROUP).scrollIntoViewIfNeeded();
      const v = await look(x.p, GROUP);
      assert.deepEqual(v.rows.map((r) => r.text), ["Invoicely API keyapi.invoicely.example · SavedRemove", "Weather keyapi.weather.example · Waiting for youRemove", "Flights keyapi.flights.example · Not nowRemove"]);
      assert.ok(v.rows.every((r) => r.inside) && v.buttons.every((b) => b.inside && b.whole) && v.right <= v.vw && !v.sideways, "every row and button inside the panel");
      assert.deepEqual([...new Set(v.buttons.map((b) => [b.word, b.outline, b.radius, b.width, b.height].join()))].length, 1, "one Remove, the shared outline, at one size");
      assert.ok(v.small.every((n) => n.ratio >= 4.5) && v.buttons.every((b) => b.ratio >= 4.5), "words at 4.5:1");
      assert.deepEqual(v.purples, [], "no purple in Keys");
      await x.p.locator(`[data-pip-key-ask-remove="${KEYID}"]`).click();
      await x.p.waitForSelector(".pip-key-confirm");
      const asked = await look(x.p, `[data-pip-key="${KEYID}"]`);
      assert.deepEqual(asked.asks.map((n) => [n.text, n.inside, n.ratio >= 4.5]), [["Remove the Invoicely API key? Mornings can’t read api.invoicely.example until you save it again.", true, true]]);
      assert.deepEqual(asked.buttons.map((b) => [b.word, b.red, b.ink, b.outline, b.radius]), [["Remove", true, "255,255,255", false, "6px"], ["Keep it", false, asked.buttons[1].ink, true, "6px"]], "the danger button (red fill, white words) beside an outline");
      assert.ok(asked.buttons[0].ratio >= 4.5 && asked.buttons[1].ratio >= 4.5, `both read at 4.5:1 (${asked.buttons.map((b) => b.ratio)})`);
      assert.deepEqual([new Set(asked.buttons.map((b) => b.width)).size, new Set(asked.buttons.map((b) => b.height)).size, new Set(asked.buttons.map((b) => b.top)).size], [1, 1, 1], "one size, one line");
      assert.ok(asked.buttons.every((b) => b.inside && b.whole) && asked.right <= asked.vw && !asked.sideways, "inside the row and the panel");
      assert.equal(await x.p.evaluate(() => (window.__pipsRoot || document).activeElement?.textContent), "Keep it", "the keyboard lands on Keep it, not on Remove");
      await x.p.locator(`[data-pip-key-remove="${KEYID}"]`).click();
      await x.p.waitForSelector(`[data-pip-key="${KEYID}"]`, { state: "detached" });
      assert.equal((await look(x.p, GROUP)).rows.length, 2, "the removed key's row is gone");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
