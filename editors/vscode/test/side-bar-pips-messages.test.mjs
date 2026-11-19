// Every message the embedded Pips page handles reaches it in the side bar too (20 Nov: the side bar passed on only a
// list, and a Pip chat's picture pop-up waited for the original that never came: its Download did nothing; Copy, a
// file's "saved" note and commit links were lost the same way). A new type on the Pips page must join the list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
test("the side bar passes on every message type the Pips page listens for", () => {
  const client = read("src/pipsClient.js"), main = read("media/main.js");
  const handled = new Set([...client.matchAll(/message\.type===['"](pips?[A-Z]\w*)['"]/g)].map((m) => m[1]));
  // Delivered by their own paths in the side bar: the connection, replies, visibility, setup cards.
  const own = new Set(["pipsConnection", "pipsReply", "pipsVisibility", "pipSetupChanged"]);
  const listed = new Set([...main.matchAll(/"(pips?[A-Z]\w*)"/g)].map((m) => m[1]));
  const missing = [...handled].filter((t) => !own.has(t) && !listed.has(t));
  assert.deepEqual(missing, [], `the side bar never passes these on: ${missing.join(", ")}`);
});
