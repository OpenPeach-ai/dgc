// Work in the 0.52 look, in real Chromium on the real session page (test/support/codex-look-scene.mjs): the greys are the
// editor's, and purple is left for Send and live marks. A sent prompt's bubble is a quiet raised grey with no light or
// grain on it; the one main button on a card is a fill of the text colour; a running step's label is plain shimmering
// text while the live verb beside it keeps the purple; the prompt box has the 22 px corner and its own soft edge; and
// the model menu is a raised grey with a half-pixel ring. Dark and light, 700 and 300 px.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openRunningTurn, READY } from "./support/codex-look-scene.mjs";
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
      assert.equal(bubble.corner, "20px");
      const allow = await look(x.page, ".card button.act.primary");
      assert.deepEqual([allow.fill, allow.words], [token["--solid"], token["--on-solid"]], "Allow once: a fill of the text colour, the ground's colour for its words");
      const send = await look(x.page, "#send");
      assert.equal(send.fill, token["--accent-fill"], "Send stays the one purple button");
      const label = await look(x.page, ".tool-group.running > summary .tg-label-text");
      assert.ok(label, "a step is running");
      assert.equal(isPurple(label.words) || /167, ?139, ?250|109, ?73, ?232/.test(label.image), false, `a running step's label is not purple: ${label.words} ${label.image.slice(0, 120)}`);
      const box = await look(x.page, "#cbox");
      assert.equal(box.corner, "22px", "the prompt box's corner");
      assert.equal(isPurple(box.line), false);
      // Everything filled purple on the page: Send, and small live marks. Nothing wider than a button.
      const filled = await x.page.evaluate(() => [...document.querySelectorAll("body *")].filter((n) => n.checkVisibility()).map((n) => { const s = getComputedStyle(n), r = n.getBoundingClientRect(); return { n: n.id || n.className, c: s.backgroundColor, w: r.width, h: r.height }; }).filter((m) => m.w > 40 && m.h > 16));
      assert.deepEqual(filled.filter((m) => isPurple(m.c)).map((m) => m.n), [], "no purple fill larger than a mark");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });
}

for (const theme of ["dark-modern", "light-modern"]) test(`the model menu is a raised grey with a half-pixel ring and a 15px corner (${theme})`, async (t) => {
  if (skipOrFail(t)) return;
  const x = await openWorkTab(browser, { theme, width: 700, height: 620 });
  try {
    await x.send({ type: "event", event: READY });
    await x.page.evaluate(() => document.getElementById("modelname").closest("button").click());
    await x.send({ type: "models", ids: ["qwen3.8:27b", "deepseek-v4.1-flash:cloud"], current: "qwen3.8:27b" });
    await x.page.waitForTimeout(250);
    const menu = await look(x.page, "#modelmenu"), token = await tokenColours(x.page, ["--surface2"]);
    assert.equal(menu.corner, "15px");
    assert.equal(menu.fill, token["--surface2"], "the raised grey");
    assert.match(menu.shadow, /0px 0px 0px 0\.5px/, `a half-pixel ring: ${menu.shadow}`);
    assert.match(menu.shadow, /0px 8px 16px -4px/, `and one low shadow: ${menu.shadow}`);
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});
