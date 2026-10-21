// Every section in Settings' side menu has an icon of its own. Web search and ChatDGC had none, so both fell back to
// the Plugins icon and three rows looked alike (founder, 2026-10-21: "the ChatDGC icon is the same as Web Search").
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "settingsClient.js"), "utf8");
const table = (name) => {
  const line = source.split("\n").find((l) => l.startsWith(`const ${name} =`));
  assert.ok(line, `settingsClient.js defines ${name}`);
  return Function(`return ${line.slice(line.indexOf("=") + 1).trim().replace(/;$/, "")}`)();
};

test("every Settings section has its own side-menu icon", () => {
  const paths = table("paths"), sections = table("sections");
  const missing = sections.filter(([id]) => !paths[id]).map(([id]) => id);
  assert.deepEqual(missing, [], "a section without an icon shows the Plugins one");
  const shapes = sections.map(([id]) => paths[id]);
  const shared = sections.filter(([id], i) => shapes.indexOf(paths[id]) !== i).map(([id]) => id);
  assert.deepEqual(shared, [], "no two sections share an icon");
});
