// Work in the 0.52 look, in real Chromium on the real session page (test/support/dgc-look-scene.mjs): the greys are the
// editor's, and purple is left for Send and live marks. A sent prompt's bubble is a quiet raised grey with no light or
// grain on it; the one main button on a card is a fill of the text colour; a running step's label is plain shimmering
// text while the live verb beside it keeps the purple; the prompt box has the buttons' 6 px corner (14 Nov; it was 22 px) and its own soft edge; and
// the model picker is a raised grey dialog. Dark and light, 700 and 300 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openRunningTurn, READY } from "./support/dgc-look-scene.mjs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { chromiumOrNull, isPurple, look, tokenColours } from "./support/look-probe.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
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

for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`a running turn: a grey bubble, one neutral main button, purple only on Send and the live verb (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openRunningTurn(browser, { theme, width, approval: true });
    try {
      const token = await tokenColours(x.page, ["--bubble", "--solid", "--on-solid", "--accent-fill", "--surface2", "--text"]);
      const bubble = await look(x.page, ".msg.user .bubble");
      assert.equal(bubble.fill, token["--bubble"], "the sent prompt is the shared grey");
      assert.equal(isPurple(bubble.fill), false);
      assert.equal(bubble.image, "none", "no light on it");
      assert.equal(bubble.grain, "none", "and no grain over it");
      assert.equal(bubble.corner, "10px", "the sent bubble's corner, on every surface (16 Nov)");
      const allow = await look(x.page, ".card button.act.primary");
      assert.deepEqual([allow.fill, allow.words], [token["--solid"], token["--on-solid"]], "Allow once: a fill of the text colour, the ground's colour for its words");
      const send = await look(x.page, "#send");
      assert.equal(send.fill, token["--accent-fill"], "Send stays the one purple button");
      const label = await look(x.page, ".tool-group.running > summary .tg-label-text");
      assert.ok(label, "a step is running");
      assert.equal(isPurple(label.words) || /167, ?139, ?250|109, ?73, ?232/.test(label.image), false, `a running step's label is not purple: ${label.words} ${label.image.slice(0, 120)}`);
      const box = await look(x.page, "#cbox");
      assert.equal(box.corner, "6px", "the prompt box's corner");
      assert.equal(isPurple(box.line), false);
      // Everything filled purple on the page: Send, and small live marks. Nothing wider than a button.
      const filled = await x.page.evaluate(() => [...document.querySelectorAll("body *")].filter((n) => n.checkVisibility()).map((n) => { const s = getComputedStyle(n), r = n.getBoundingClientRect(); return { n: n.id || n.className, c: s.backgroundColor, w: r.width, h: r.height }; }).filter((m) => m.w > 40 && m.h > 16));
      assert.deepEqual(filled.filter((m) => isPurple(m.c)).map((m) => m.n), [], "no purple fill larger than a mark");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) test(`the model picker is a raised grey dialog: the dialog's corner and lift, over a dimmed page (${theme})`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkTab(browser, { theme, width: 700, height: 620 });
  try {
    await x.send({ type: "event", event: READY });
    await x.page.evaluate(() => document.getElementById("modelname").closest("button").click());
    await x.send({ type: "models", ids: ["qwen3.8:27b", "deepseek-v4.1-flash:cloud"], current: "qwen3.8:27b" });
    await x.page.waitForTimeout(250);
    const dialog = await look(x.page, ".dgc-mp"), token = await tokenColours(x.page, ["--surface2"]);
    assert.equal(dialog.corner, "20px", "the dialog's corner");
    // His reference look (17 Nov): a two-tone dialog, the card of models in the raised grey on a frame a shade apart,
    // a neutral grey (never purple).
    const card = await look(x.page, ".dgc-mp-card");
    assert.equal(card.fill, token["--surface2"], "the card: the raised grey");
    assert.notEqual(dialog.fill, card.fill, "the frame is a shade apart from the card");
    assert.equal(isPurple(dialog.fill), false, `the frame is a grey: ${dialog.fill}`);
    assert.match(dialog.shadow, /0px 24px 48px -16px/, `the dialog's lift: ${dialog.shadow}`);
    const scrim = await x.page.evaluate(() => { const s = getComputedStyle(document.querySelector(".dgc-mp-layer")); return [s.backgroundColor, s.backdropFilter || s.webkitBackdropFilter]; });
    assert.match(scrim[0], /rgba\(0, 0, 0, 0\.\d+\)/, "the page is dimmed");
    assert.match(scrim[1], /blur\(2px\)/, "with the shared scrim's blur");
    // Purple is a mark here, never a fill: the check, the session's own connection, nothing larger.
    const purple = await x.page.evaluate(() => [...document.querySelectorAll(".dgc-mp *")].filter((n) => n.checkVisibility()).map((n) => { const s = getComputedStyle(n), r = n.getBoundingClientRect(); return { n: n.className, c: s.backgroundColor, w: r.width, h: r.height }; }).filter((m) => m.w > 40 && m.h > 16));
    assert.deepEqual(purple.filter((m) => isPurple(m.c)).map((m) => m.n), [], "no purple fill larger than a mark");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
