// The license files and notices for what DGC bundles into its pages name exactly what the bundles hold, at the versions
// installed (10 Nov: the hand-kept files named mermaid 12.0.0, KaTeX 0.16.47 and chevrotain 11 while 12.2.0, 0.18.2 and
// 13 shipped, and left out six packages bundled in a second version). After a dependency update:
// node scripts/bundle-licenses.mjs, and the versions in THIRD_PARTY_NOTICES.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FILES, render, bundled } from "../scripts/bundle-licenses.mjs";

const here = (path) => new URL(`../${path}`, import.meta.url);
const installed = (name) => JSON.parse(readFileSync(here(`node_modules/${name}/package.json`), "utf8")).version;

for (const spec of FILES) {
  test(`${spec.file} is what ${spec.entry} bundles, at the installed versions`, async () => {
    const want = await render(spec), have = readFileSync(here(spec.file), "utf8");
    const heads = (s) => s.split("\n").filter((line, i, all) => all[i + 1] === "-".repeat(60));
    assert.deepEqual(heads(have), heads(want), "run node scripts/bundle-licenses.mjs");
    assert.equal(have, want, "the license texts too: run node scripts/bundle-licenses.mjs");
  });
}

test("THIRD_PARTY_NOTICES.md names the versions that ship", async () => {
  const notices = readFileSync(here("THIRD_PARTY_NOTICES.md"), "utf8");
  assert.match(notices, new RegExp(`\\[mermaid\\]\\([^)]*\\) ${installed("mermaid").replace(/\./g, "\\.")} and the (\\d+)`));
  const count = Number(/\[mermaid\]\([^)]*\) [\d.]+ and the (\d+)/.exec(notices)[1]);
  const mermaid = await bundled("src/mermaid-entry.mts");
  assert.equal(count, mermaid.filter((p) => p.name !== "mermaid").length, "the number of packages mermaid's bundle holds");
  assert.match(notices, new RegExp(`\\[KaTeX\\]\\([^)]*\\) ${installed("katex").replace(/\./g, "\\.")}:`));
  const list = /\(prosemirror-model [^)]*\)/.exec(notices)[0];
  for (const part of ["model", "state", "view", "transform", "commands", "history", "inputrules", "keymap", "schema-list", "markdown", "tables"]) {
    const named = new RegExp(`(?:prosemirror)?-${part} (\\d+\\.\\d+\\.\\d+)`).exec(list)?.[1];
    assert.equal(named, installed(`prosemirror-${part}`), `prosemirror-${part}`);
  }
});
