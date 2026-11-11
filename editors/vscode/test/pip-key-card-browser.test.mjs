// How a plugin's key card looks in a Personal Pip's chat (src/pipPlugins.js keyCardMarkup, src/pips.css, the shared
// card's answers in media/shared/card.css), in real Chromium, in the side bar (a shadow root on Work's page), dark and
// light at 300 and 700 px: the cards' own look (one filled answer, one outline, the 6 px corner, on the box too), the
// key masked, everything inside the card and the panel, labels at 4.5:1; typed, Allow comes on; saved, the card says so
// and the key is nowhere on the page. What it sends is pip-key-card.test.mjs.
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

const KEY = "pat_test_0123456789abcdefSECRET";
const look = (p) => p.evaluate(() => {
  const root = window.__pipsRoot || document, card = root.querySelector("[data-key-card]"); if (!card) return null;
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement || n.getRootNode().host) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (n) => { const g = ground(n), c = over(parse(getComputedStyle(n).color), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const box = card.getBoundingClientRect(), r = (n) => n.getBoundingClientRect(), inside = (n) => r(n).left >= box.left - 0.5 && r(n).right <= box.right + 0.5 && r(n).top >= box.top - 0.5 && r(n).bottom <= box.bottom + 0.5;
  const buttons = [...card.querySelectorAll(".dgc-card-actions button")].map((b) => { const s = getComputedStyle(b); return { word: b.textContent, filled: parse(s.backgroundColor)[3] > 0.9, outline: parse(s.backgroundColor)[3] === 0 && parseFloat(s.borderTopWidth) === 1,
    radius: s.borderTopLeftRadius, height: Math.round(r(b).height), off: b.disabled, ratio: b.disabled ? null : ratio(b), inside: inside(b), whole: b.scrollWidth <= b.clientWidth + 1 }; });
  const inputs = [...card.querySelectorAll("input")].map((i) => ({ type: i.type, radius: getComputedStyle(i).borderTopLeftRadius, height: Math.round(r(i).height), inside: inside(i), label: root.querySelector(`label[for="${i.id}"]`)?.textContent, labelRatio: ratio(root.querySelector(`label[for="${i.id}"]`)), value: i.value }));
  return { state: card.dataset.state, text: card.textContent, shared: card.classList.contains("dgc-card"), buttons, inputs, title: ratio(card.querySelector("strong")), note: card.querySelector(".app-link-note") ? ratio(card.querySelector(".app-link-note")) : null,
    right: box.right, vw: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, html: (root.querySelector("#app") || document.body).innerHTML };
});

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  test(`${theme} ${width}px: the key card wears the cards' look, the key is masked, Allow comes on when it is typed, and saved it says so`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChat(browser, { width, theme, api: 81, keys: true });
    try {
      await x.p.waitForSelector("[data-key-card]");
      const v = await look(x.p);
      assert.deepEqual([v.state, v.shared], ["requested", true]);
      assert.match(v.text, /Airtable needs its Airtable token.*To read your Plans table for the morning brief\./);
      assert.deepEqual(v.buttons.map((b) => [b.word, b.filled, b.outline, b.radius, b.off]), [["Allow", true, false, "6px", true], ["Not now", false, true, "6px", false]], "one filled answer (off until the key is typed), one outline, the 6 px corner");
      assert.equal(new Set(v.buttons.map((b) => b.height)).size, 1, "one height");
      assert.deepEqual(v.inputs.map((i) => [i.type, i.radius, i.label, i.inside]), [["password", "6px", "Airtable token", true]], "one masked box, the same corner, its label the key's name");
      assert.ok(v.buttons.every((b) => b.inside && b.whole) && v.right <= v.vw && !v.sideways, "everything inside the card and the panel");
      assert.ok(v.title >= 4.5 && v.note >= 4.5 && v.inputs[0].labelRatio >= 4.5 && v.buttons[1].ratio >= 4.5, `words at 4.5:1 (${v.title}, ${v.note}, ${v.inputs[0].labelRatio}, ${v.buttons[1].ratio})`);
      await x.p.locator("[data-key-card] input").fill(KEY);
      const typed = await look(x.p);
      assert.deepEqual([typed.buttons[0].off, typed.inputs[0].value === KEY], [false, true], "typed: Allow is on");
      assert.ok(typed.buttons[0].ratio >= 4.5, `Allow's label at 4.5:1 (${typed.buttons[0].ratio})`);
      assert.ok(!typed.html.includes(KEY), "the key is in its box only, never in the page's markup");
      await x.p.locator("[data-key-card] button.primary").click();
      await x.p.waitForSelector('[data-key-card][data-state="saved"]');
      const saved = await look(x.p);
      assert.match(saved.text, /Mornings can use Airtable.*Saved · it never saw the key/);
      assert.deepEqual([saved.inputs.length, saved.buttons.length], [0, 0]);
      assert.ok(!saved.html.includes(KEY), "nowhere on the page once sent");
      assert.deepEqual(await x.p.evaluate(() => window.__keysSent), ["AIRTABLE_TOKEN"]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
