// Sent and goal bubbles are clean on every surface: no stripe down a side (his call, 19 Nov: a goal's prompt bubble
// had a 2px grey inset on its left).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const files = ["media/main.css", "media/chatdgc.css", "src/pips.css", "src/pipChat.css"];
test("no bubble rule draws a side stripe (an inset side shadow or a one-sided border)", () => {
  for (const file of files) {
    const css = readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      // The bubble itself (a rule whose last part is the bubble), not a quote line inside one.
      if (!selector.split(",").some((part) => /bubble[\w-]*\s*$/.test(part.trim()))) continue;
      assert.doesNotMatch(body, /box-shadow:\s*inset\s+-?[1-9]\d*px\s+0\b/, `${file}: ${selector.trim()} draws a side stripe`);
      assert.doesNotMatch(body, /border-(left|right):\s*[1-9]/, `${file}: ${selector.trim()} has a one-sided border`);
    }
  }
});
