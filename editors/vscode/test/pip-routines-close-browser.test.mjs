// The Routines pop-up's close button (a screenshot, 15 Nov): in a Pip's chat, the composer's Routines pop-up drew its ×
// as a wide box with a border (104 px by 28, the roomy button's own size) at its top right. Its markup gave it the
// class "quiet", and the one-shape rule for the Pips view's worded buttons (button.quiet: the fixed width, the
// outline) comes later in the cascade than .pip-routines-head button, which only asks for a minimum size. A close
// button is an icon, not a worded button: it is the small square icon button the other pop-ups close with (26 px, the
// header's height, the 6 px corner, no line, a wash under the pointer), at the header's right end.
// Measured on the real page in real Chromium, dark and light, at 300, 440 and 700 px, in the side bar and in a tab.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { openChat } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const measure = () => {
  const root = window.__pipsRoot || document, pop = root.querySelector(".pip-routines-popover"), head = pop.querySelector(".pip-routines-head"), b = root.querySelector("#chat-routines-close");
  const r = b.getBoundingClientRect(), h = head.getBoundingClientRect(), p = pop.getBoundingClientRect(), s = getComputedStyle(b), mark = b.querySelector("svg"), m = mark?.getBoundingClientRect();
  const title = head.querySelector("strong"), tr = title.getBoundingClientRect();
  return { w: r.width, h: r.height, radius: parseFloat(s.borderTopLeftRadius), line: parseFloat(s.borderTopWidth), lineInk: s.borderTopColor, ground: s.backgroundColor, cursor: s.cursor, label: b.getAttribute("aria-label"), tip: b.getAttribute("title") || "",
    fromRight: h.right - r.right, fromTop: r.top - h.top, headH: h.height, inPop: r.left >= p.left && r.right <= p.right && r.top >= p.top,
    mark: m ? { w: m.width, h: m.height, dx: (m.left + m.right) / 2 - (r.left + r.right) / 2, dy: (m.top + m.bottom) / 2 - (r.top + r.bottom) / 2 } : null, words: b.textContent.trim(),
    title: title.textContent, titleLines: Math.round(tr.height / parseFloat(getComputedStyle(title).lineHeight || "16")) || 1, titleCut: title.scrollWidth > title.clientWidth + 1,
    popW: p.width, sideways: document.documentElement.scrollWidth > innerWidth + 1 };
};

for (const theme of ["dark", "light"]) for (const [where, width] of [["side", 300], ["side", 440], ["side", 700], ["tab", 440], ["tab", 700]]) {
  test(`the Routines pop-up closes with a small icon button, never a wide box (${where}, ${width} px, ${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const { p, close, errors } = await openChat(browser, { width, theme, where });
    try {
      await p.click("#chat-routines"); await p.waitForSelector(".pip-routines-popover"); await p.waitForTimeout(250);
      const m = await p.evaluate(measure);
      assert.deepEqual([Math.round(m.w * 10) / 10, Math.round(m.h * 10) / 10], [26, 26], `a 26 px square (it was 104 by 28): ${m.w} by ${m.h}`);
      assert.equal(m.radius, 6, "the 6 px corner: never a pill, never a circle");
      assert.ok(m.line === 0 || /, 0\)$|transparent/.test(m.lineInk), `no line round it (${m.line}px ${m.lineInk})`);
      assert.match(m.ground, /rgba\(0, 0, 0, 0\)|transparent/, "no fill at rest");
      assert.ok(Math.abs(m.fromRight) <= 0.5, `at the header's right end (${m.fromRight}px in)`);
      assert.ok(m.headH <= 28, `the header is one line of its height (${m.headH}px)`);
      assert.ok(m.inPop, "inside the pop-up");
      assert.ok(m.mark && m.mark.w >= 10 && m.mark.w <= 16 && Math.abs(m.mark.dx) <= 0.6 && Math.abs(m.mark.dy) <= 0.6, `its × is a drawn mark, centred (${JSON.stringify(m.mark)})`);
      assert.equal(m.words, "", "no letter stands in for the mark");
      assert.equal(m.label, "Close routines"); assert.equal(m.tip, "Close");
      assert.deepEqual([m.title, m.titleLines, m.titleCut], ["Routines", 1, false], "the heading is whole, on one line");
      assert.equal(m.sideways, false);
      // Under the pointer it gains the wash every icon button has; reached by Tab, the ring.
      await p.hover("#chat-routines-close"); await p.waitForTimeout(200);
      const hovered = await p.evaluate(measure);
      assert.doesNotMatch(hovered.ground, /rgba\(0, 0, 0, 0\)|transparent/, "a wash under the pointer");
      assert.deepEqual([hovered.w, hovered.h], [m.w, m.h], "and it does not grow");
      assert.equal(hovered.cursor, "pointer");
      // It opens with the keyboard on the close button; pressing it closes the pop-up and goes back to the chip.
      assert.equal(await p.evaluate(() => (window.__pipsRoot || document).activeElement?.id), "chat-routines-close");
      await p.click("#chat-routines-close"); await p.waitForTimeout(150);
      assert.equal(await p.locator(".pip-routines-popover").count(), 0, "it closes the pop-up");
      assert.equal(await p.evaluate(() => (window.__pipsRoot || document).activeElement?.id), "chat-routines", "and the keyboard is back on the Routines chip");
      assert.deepEqual(errors, []);
    } finally { await close(); }
  });
}
