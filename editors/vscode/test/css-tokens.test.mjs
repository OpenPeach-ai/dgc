// Every custom property the chat panel's stylesheet reads must exist. An undefined one with no
// fallback does not fail: the declaration silently computes to its initial value, which for a border
// colour is the text colour. That is how --line, a token of the Pips sheet, drew a white border round
// a new chat's tab here. --vscode-* come from the editor; a few are set by main.js at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../media/main.css", import.meta.url), "utf8");
const js = readFileSync(new URL("../media/main.js", import.meta.url), "utf8");

test("main.css reads no custom property it never defines", () => {
  const defined = new Set([...css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
  for (const m of js.matchAll(/setProperty\(\s*["'`](--[\w-]+)/g)) defined.add(m[1]);
  const missing = new Set();
  for (const [, name, end] of css.matchAll(/var\(\s*(--[\w-]+)\s*([,)])/g)) {
    if (name.startsWith("--vscode-") || end === "," || defined.has(name)) continue;
    missing.add(name);
  }
  assert.deepEqual([...missing], [], "each needs a definition in :root, or a fallback in the var()");
});
