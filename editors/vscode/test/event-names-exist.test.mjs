// Every event name the panel switches on must be one the protocol actually emits.
//
// routeEvent's background handler listed `plan_request`, `question_request` and `ask`. None of
// those exist: the real names are `ask_request` and `plan_proposal`. A `case` for a name that is
// never sent is silently dead — the chat blocked on a question simply showed no "waiting for you"
// dot, and nothing failed. TypeScript catches this for typed positions; this catches the rest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "../../..");

function protocolEventNames() {
  const schema = JSON.parse(
    readFileSync(join(repo, "schemas/editor-protocol-v14.schema.json"), "utf8"));
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const konst = node.properties?.type?.const;
    if (typeof konst === "string") names.add(konst);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") walk(value);
    }
  };
  walk(schema);
  return names;
}

test("the background chat handler only matches events the protocol sends", () => {
  const src = readFileSync(join(here, "../src/panel.ts"), "utf8");
  const start = src.indexOf("private backgroundEvent(");
  assert.ok(start > 0, "backgroundEvent still exists");
  const body = src.slice(start, src.indexOf("\n  }\n", start));
  const cases = [...body.matchAll(/case\s+"([a-z_]+)"\s*:/g)].map((m) => m[1]);
  assert.ok(cases.length >= 6, `expected several cases, found ${cases.length}`);

  const real = protocolEventNames();
  const invented = cases.filter((name) => !real.has(name));
  assert.deepEqual(invented, [],
    `backgroundEvent matches names the protocol never emits, so those chips never light: ${invented}`);
});

test("the decision bookkeeping matches real event names too", () => {
  const src = readFileSync(join(here, "../src/panel.ts"), "utf8");
  const start = src.indexOf("this.openDecisions.add(");
  assert.ok(start > 0, "the open-decision bookkeeping still exists");
  // The run of `case` labels immediately above the add().
  const before = src.slice(Math.max(0, start - 500), start);
  const cases = [...before.matchAll(/case\s+"([a-z_]+)"\s*:/g)].map((m) => m[1]);
  const real = protocolEventNames();
  const invented = cases.filter((name) => !real.has(name));
  assert.deepEqual(invented, [], `openDecisions tracks names that are never sent: ${invented}`);
});
