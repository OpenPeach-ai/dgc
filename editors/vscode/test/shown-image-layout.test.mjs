// A shown image (show_file on a PNG) is a layout fact, so it is measured in real Chromium: the picture sits in its
// tile at its own shape, the caption reads under it in both themes, one image alone may use the card's width but
// never the panel's sideways scroll, several sit in a row of tiles, and a non-image chip with a caption stays one
// line at 300px. Reported 28 Oct: a screenshot the model showed was only a file name.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { contrastRatio } from "./support/webview-dom.mjs";
import { ONE, TWO, openShownImages } from "./support/shown-image-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)"
  : !browser ? "Chromium could not start" : "");
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

const facts = (page) => page.evaluate(() => {
  const rect = (node) => node.getBoundingClientRect().toJSON();
  const turn = document.querySelector(".made-files").closest(".turn, .msg, .assistant") || document.querySelector(".made-files").parentElement;
  return {
    overflowX: document.documentElement.scrollWidth > innerWidth || document.body.scrollWidth > innerWidth,
    turn: rect(turn),
    figures: [...document.querySelectorAll(".made-image")].map((f) => ({ figure: rect(f), tile: rect(f.querySelector(".image-tile")),
      img: rect(f.querySelector("img")), natural: [f.querySelector("img").naturalWidth, f.querySelector("img").naturalHeight],
      caption: rect(f.querySelector("figcaption")), captionColor: getComputedStyle(f.querySelector("figcaption")).color,
      captionClipped: f.querySelector("figcaption").scrollWidth > f.querySelector("figcaption").clientWidth + 1 })),
    chips: [...document.querySelectorAll(".chip.made-file")].map((c) => ({ rect: rect(c), label: rect(c.querySelector(".chip-label")),
      // The text's own width, not scrollWidth: a 0.06px squeeze rounds away there but still draws an ellipsis.
      labelClipped: (() => { const label = c.querySelector(".chip-label"), range = document.createRange();
        range.selectNodeContents(label); return range.getBoundingClientRect().width > label.getBoundingClientRect().width + 0.01; })(),
      caption: c.querySelector(".chip-caption") ? rect(c.querySelector(".chip-caption")) : null,
      captionColor: c.querySelector(".chip-caption") ? getComputedStyle(c.querySelector(".chip-caption")).color : "" })),
    ground: getComputedStyle(document.body).backgroundColor,
  };
});
// Resolve a computed rgb()/rgba() over the panel ground to hex.
const hex = (page, color, ground) => page.evaluate(([value, under]) => {
  const c = document.createElement("canvas"); c.width = c.height = 1;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = under; g.fillRect(0, 0, 1, 1); g.fillStyle = value; g.fillRect(0, 0, 1, 1);
  return "#" + [...g.getImageData(0, 0, 1, 1).data].slice(0, 3).map((n) => n.toString(16).padStart(2, "0")).join("");
}, [color, ground]);

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}, one shown image: the whole picture at its own shape, the caption under it and readable`, async (t) => {
    if (skipOrFail(t)) return;
    const { page, errors } = await openShownImages(browser, { theme });
    try {
      const g = await facts(page);
      assert.equal(g.overflowX, false);
      const [f] = g.figures;
      t.diagnostic(`tile ${Math.round(f.tile.width)}x${Math.round(f.tile.height)}, picture ${Math.round(f.img.width)}x${Math.round(f.img.height)}`);
      assert.ok(f.tile.width >= 300, `one image uses the card's width (${f.tile.width}px), not a 150px square`);
      assert.ok(f.tile.width <= 420.5, "but no wider than a viewed one");
      assert.ok(f.tile.right <= g.turn.right + 0.5, "inside the answer");
      const shape = f.natural[0] / f.natural[1], drawn = f.img.width / f.img.height;
      assert.ok(Math.abs(shape - drawn) < 0.02, `the picture keeps its shape (${shape.toFixed(2)} drawn ${drawn.toFixed(2)})`);
      assert.ok(f.caption.top >= f.tile.bottom - 0.5, "the caption sits under the picture");
      assert.ok(f.caption.left >= f.tile.left - 0.5 && f.caption.right <= f.tile.right + 0.5, "and within its width");
      const ratio = contrastRatio(await hex(page, f.captionColor, g.ground), await hex(page, g.ground, "#000"));
      assert.ok(ratio >= 4.5, `caption contrast ${ratio.toFixed(2)}`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  });
}

test("two shown images and a report: a row of tiles, then a one-line chip whose caption gives way, at 300px", async (t) => {
  if (skipOrFail(t)) return;
  for (const width of [300, 900]) {
    const { page, errors } = await openShownImages(browser, { width, items: TWO });
    try {
      const g = await facts(page);
      assert.equal(g.overflowX, false, `${width}: no sideways scroll`);
      assert.equal(g.figures.length, 2);
      for (const f of g.figures) {
        assert.ok(f.tile.width <= 150.5, `${width}: a tile in a row, ${f.tile.width}px`);
        assert.ok(f.img.width <= f.tile.width + 0.5 && f.img.height <= f.tile.height + 0.5, "the whole picture, contained");
        assert.ok(f.caption.top >= f.tile.bottom - 0.5);
      }
      if (width === 900) assert.equal(Math.round(g.figures[0].tile.top), Math.round(g.figures[1].tile.top), "side by side");
      const [chip] = g.chips;
      assert.ok(chip.rect.height <= 26, `${width}: the chip stays one line (${chip.rect.height}px)`);
      assert.equal(chip.labelClipped, false, `${width}: the name is never the part cut`);
      assert.ok(chip.caption && chip.caption.left >= chip.label.right - 0.5, "the caption follows the name");
      const ratio = contrastRatio(await hex(page, chip.captionColor, g.ground), await hex(page, g.ground, "#000"));
      assert.ok(ratio >= 4.5, `chip caption contrast ${ratio.toFixed(2)}`);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});
