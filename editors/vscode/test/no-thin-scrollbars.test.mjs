// No DGC page asks for `scrollbar-width: thin` (media/shared/tokens.css: Chromium then draws its standard bar, with arrow
// buttons on Linux and Windows, and ignores the slim ::-webkit-scrollbar look every page shares). Seen 24 Nov in the RC
// check: a slides editor's strip had a bright standard bar with arrows in the dark theme.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const files = (dir) => readdirSync(new URL(dir, import.meta.url)).filter((f) => f.endsWith(".css")).map((f) => dir + f);
test("no stylesheet asks for a thin standard scrollbar", () => {
  const found = [];
  for (const file of [...files("../media/"), ...files("../media/shared/"), ...files("../src/")]) {
    const css = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    css.split("\n").forEach((line, i) => { if (/scrollbar-width\s*:\s*thin/.test(line)) found.push(`${file.replace("../", "")}:${i + 1}`); });
  }
  assert.deepEqual(found, [], "use the shared slim bars (tokens.css), or scrollbar-width: none for a bar that hides");
});
