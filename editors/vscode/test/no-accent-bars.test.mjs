// Reported 24 Oct: no thick accent bar down the left edge of a card, "on these cards or anywhere else". A card's
// border and its own words say what it is. This scans every stylesheet the extension ships for that bar, drawn either
// way: an inset box-shadow or a left border of 2px or more in an accent colour. Grey rules (a quote, thinking) are not
// accents and stay; diff lines keep their green and red markers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const sheets = ["media", "src"].flatMap((dir) => readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".css"))
  .map((f) => join(dir, f)));
const ACCENT = "(?:--accent[\\w-]*|--lav[\\w-]*|--purple[\\w-]*|--link)";
const BAR = new RegExp(`(?:box-shadow:[^;}]*inset\\s+[2-9]px\\s+0\\s+0\\s+var\\(${ACCENT}\\)|border-(?:left|inline-start):\\s*[2-9]px\\s+\\w+\\s+var\\(${ACCENT}\\))`);

test("no stylesheet draws an accent bar down a card's left edge", () => {
  assert.ok(sheets.length >= 5, "found the stylesheets");
  const found = sheets.filter((path) => BAR.test(readFileSync(join(ROOT, path), "utf8")));
  assert.deepEqual(found, []);
});
