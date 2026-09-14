import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The editor tabs, activity bar and secondary sidebar show DGC's own mark, the way Claude Code and
// Codex show theirs — not a generic terminal glyph. The editor paints these icons as a single-colour
// mask, so the file must be solid filled shapes in a 24px box.
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const icon = readFileSync(join(root, "media", "dgc.svg"), "utf8");

test("every DGC view container and view uses the mark", () => {
  const { viewsContainers, views } = manifest.contributes;
  const icons = [
    ...Object.values(viewsContainers).flat().map((item) => item.icon),
    ...Object.values(views).flat().map((item) => item.icon),
  ];
  assert.ok(icons.length >= 4);
  for (const path of icons) assert.equal(path, "media/dgc.svg");
});

test("the icon is the three-slash mark as solid shapes, not the old terminal glyph", () => {
  assert.match(icon, /viewBox="0 0 24 24"/);
  assert.match(icon, /fill="currentColor"/);
  const bars = icon.match(/<path d="M[^"]+Z"\/>/g) || [];
  assert.equal(bars.length, 3, "three slashes");
  assert.doesNotMatch(icon, /<rect|stroke=/, "no outlined terminal box");
  for (const bar of bars) {
    const points = [...bar.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    assert.equal(points.length, 4, "each slash is a parallelogram");
    for (const [x, y] of points) assert.ok(x >= 0 && x <= 24 && y >= 0 && y <= 24, "inside the 24px box");
    // Forward lean: the top edge sits to the right of the bottom edge.
    const top = Math.max(points[0][0], points[1][0]), bottom = Math.max(points[2][0], points[3][0]);
    assert.ok(top > bottom, "leans forward like /");
  }
});
