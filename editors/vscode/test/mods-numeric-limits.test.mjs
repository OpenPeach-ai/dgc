import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

test("mod bars with large finite values fit exactly within their track", () => {
  const view = makeDom();
  const draw = view.dom.window.DgcMods.draw;
  for (const tree of [
    { type: "Bar", segments: [{ value: 1e308 }, { value: 1e308 }] },
    { type: "Bar", total: 1, segments: [{ value: 2 }, { value: 2 }] },
  ]) {
    const bar = draw(tree);
    const widths = [...bar.querySelectorAll(".mod-bar-part")].map((part) => Number.parseFloat(part.style.width));
    assert.ok(widths.every(Number.isFinite), String(widths));
    assert.ok(Math.abs(widths.reduce((a, b) => a + b, 0) - 100) < 0.01, String(widths));
  }
});

test("mod sparklines with opposite large values retain finite plotted points", () => {
  const view = makeDom();
  const spark = view.dom.window.DgcMods.draw({ type: "Sparkline", values: [-1e308, 0, 1e308] });
  const points = spark.querySelector("polyline").getAttribute("points");
  assert.doesNotMatch(points, /NaN|Infinity/);
  assert.equal(points.split(" ").length, 3);
});
