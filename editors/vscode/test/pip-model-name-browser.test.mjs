// A Pip's prompt box names its model (0.52, 15 Nov: "it says Model"): at a narrow side bar the chip showed the bare word
// "Model" in place of the name. It shows the name, cut to fit with "…", and the whole name on hover; never the word.
// The side bar's real page with the real Pips view, in Chromium, at the widths where it said "Model".
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const LONG = "deepseek-v4.1-flash:cloud", SHORT = "glm-5.3";
const chip = (x) => x.inPips((root) => {
  const b = root.querySelector("#chat-model"), n = b.querySelector(".composer-model-name"), s = getComputedStyle(n), r = n.getBoundingClientRect(), box = root.querySelector(".pip-composer").getBoundingClientRect(), br = b.getBoundingClientRect();
  const drawn = [b, ...b.querySelectorAll("*")].map((el) => getComputedStyle(el, "::before").content).filter((c) => c && c !== "none" && c !== "normal");
  const row = root.querySelector(".pip-composer .composer-controls"), kids = [...row.querySelectorAll("button")].filter((k) => k.getBoundingClientRect().width > 0).map((k) => { const q = k.getBoundingClientRect(); return { id: k.id, left: q.left, right: q.right, mid: (q.top + q.bottom) / 2 }; });
  return { name: n.textContent, shown: r.width > 0 && r.height > 0 && s.display !== "none" && s.visibility !== "hidden", width: r.width, cut: n.scrollWidth > n.clientWidth, how: [s.textOverflow, s.overflowX, s.whiteSpace].join(" "),
    drawn, title: b.getAttribute("title"), label: b.getAttribute("aria-label"), inside: br.left >= box.left - 0.5 && br.right <= box.right + 0.5, kids, scroll: row.scrollWidth - row.clientWidth };
});

for (const width of [300, 360, 440, 520, 640]) {
  for (const theme of ["dark-modern", "light-modern"]) {
    test(`a Pip's prompt box shows its model's name, cut to fit, never the word "Model", at ${width}px (${theme})`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openOnePips(browser, { api: 99, width, height: 700, theme, scene: { sub: true, waiting: false, model: LONG } });
      try {
        await x.openPip(GST); await x.waitIn("#chat-model .composer-model-name"); await x.page.waitForTimeout(200);
        const seen = await chip(x);
        assert.equal(seen.name, LONG, "the name is the chip's words");
        assert.ok(seen.shown, `the name shows at ${width}px`);
        assert.deepEqual(seen.drawn, [], "no word drawn in its place");
        assert.ok(seen.width >= 30, `enough of it to read at ${width}px (${seen.width}px)`);
        assert.equal(seen.how, "ellipsis hidden nowrap", "what doesn't fit ends in …");
        if (width <= 440) assert.ok(seen.cut, "a long name is cut here, not the row");
        assert.match(seen.title, new RegExp(LONG.replace(/[.]/g, "\\.")), "the whole name on hover");
        assert.ok(seen.inside, "inside the box");
        const mids = seen.kids.map((k) => k.mid); assert.ok(Math.max(...mids) - Math.min(...mids) <= 1, "one line");
        const inOrder = [...seen.kids].sort((a, b) => a.left - b.left);
        for (let i = 1; i < inOrder.length; i++) assert.ok(inOrder[i].left >= inOrder[i - 1].right - 0.5, `${inOrder[i].id} is not drawn over ${inOrder[i - 1].id}`);
        assert.ok(seen.scroll <= 1, "the row does not scroll sideways");
        assert.deepEqual(x.errors, []);
      } finally { await x.close(); }
    });
  }
}

test("a short name is whole where it fits, and the first sight of a Pip's chat already has it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openOnePips(browser, { api: 99, width: 440, height: 700, scene: { sub: true, waiting: false, model: SHORT } });
  try {
    await x.openPip(GST); await x.waitIn("#chat-model .composer-model-name");
    const seen = await chip(x);
    assert.equal(seen.name, SHORT); assert.ok(seen.shown); assert.equal(seen.cut, false, "nothing cut from a name that fits"); assert.deepEqual(seen.drawn, []);
  } finally { await x.close(); }
});
