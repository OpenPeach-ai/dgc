// The extension keeps the chat lines a user closed with their × (src/dismissedNotes.ts): a page says {type: "dismissNote",
// id}, every page that starts is told {type: "dismissedNotes", ids}. Only a line's own name is kept, the newest 500.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";

const require = createRequire(import.meta.url);
const built = buildSync({ entryPoints: [new URL("../src/dismissedNotes.ts", import.meta.url).pathname], bundle: true, write: false,
  platform: "node", format: "cjs", external: ["vscode"] }).outputFiles[0].text;
const mod = { exports: {} };
new Function("module", "exports", "require", built)(mod, mod.exports, (name) => (name === "vscode" ? {} : require(name)));
const { dismissedNotesMessage, rememberDismissedNote } = mod.exports;

const context = () => { const store = new Map(); return { store, globalState: { get: (k) => store.get(k), update: async (k, v) => { store.set(k, v); } } }; };

test("a closed line is kept by its name, once, and every page is told", () => {
  const c = context();
  assert.deepEqual(dismissedNotesMessage(c), { type: "dismissedNotes", ids: [] });
  assert.equal(rememberDismissedNote(c, { type: "dismissNote", id: "0123456789ab:stopped:1764000000" }), true);
  assert.equal(rememberDismissedNote(c, { type: "dismissNote", id: "0123456789ab:stopped:1764000000" }), true);
  assert.deepEqual(dismissedNotesMessage(c).ids, ["0123456789ab:stopped:1764000000"], "once");
  assert.equal(rememberDismissedNote(c, { type: "somethingElse" }), false, "not its message: not taken");
  for (const bad of ["", ":stopped:0", "x:stopped", "../x:stopped:1", "a b:stopped:1", "k:Stopped:1", `k:stopped:${"9".repeat(17)}`]) {
    assert.equal(rememberDismissedNote(c, { type: "dismissNote", id: bad }), true, "taken, never kept");
  }
  assert.deepEqual(dismissedNotesMessage(c).ids, ["0123456789ab:stopped:1764000000"], "nothing else kept");
});

test("the newest 500 are kept", () => {
  const c = context();
  for (let i = 0; i < 520; i++) rememberDismissedNote(c, { type: "dismissNote", id: `k${i}:stopped:${i + 1}` });
  const ids = dismissedNotesMessage(c).ids;
  assert.equal(ids.length, 500);
  assert.equal(ids[0], "k20:stopped:21");
  assert.equal(ids.at(-1), "k519:stopped:520");
});

test("the host takes a page's dismissNote and tells a starting page what was closed", () => {
  const panel = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
  assert.match(panel, /if \(rememberDismissedNote\(this\.context, msg\)\) return;/);
  assert.match(panel, /case "webviewReady": \{[^]*?this\.post\(dismissedNotesMessage\(this\.context\)\);[^]*?this\.repaintFromBackend\(\);/,
    "told before the chat is painted again");
});
