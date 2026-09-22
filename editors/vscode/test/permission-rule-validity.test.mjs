// A permission rule that does not parse must be marked as such in the editor.
//
// The engine drops an unparseable rule but the file keeps it, so a listing that shows it plain
// lets someone read their own `deny` back and believe it is in force. Both terminal listings say
// so; the editor's surface was showing them exactly like the rules that work.
//
// The backend now sends `invalid: true` on those items (dgc/headless.py _emit_permissions). This
// is the other half: the webview has to render it. The field travels inside `items`, which the
// protocol leaves unconstrained, so an older editor ignores it rather than refusing the event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const RULES = [
  { action: "deny", rule: "Bash(rm -rf /)" },
  { action: "allow", rule: "Bash(npm test *" },          // unbalanced: the engine drops this one
  { action: "ask", rule: "Write(src/**)" },
];

function openPermissions(send, doc, items) {
  send({ type: "surface_open", surface: "permissions" });
  send({ type: "event", event: { type: "permissions", request_id: "p1",
    total: items.length, items } });
  return doc.getElementById("surface");
}

test("a rule the engine dropped is marked invalid, not listed as if it applied", (t) => {
  const { dom, errors, send, doc } = makeDom();
  t.after(() => dom.window.close());
  const items = RULES.map((r) => (r.rule.includes("npm test") ? { ...r, invalid: true } : r));
  const surface = openPermissions(send, doc, items);

  const cards = [...surface.querySelectorAll("article.surface-card")];
  assert.equal(cards.length, 3, "every rule is still listed");
  const marked = cards.filter((c) => c.querySelector(".surface-state.err"));
  assert.equal(marked.length, 1, "exactly the unparseable rule carries the marker");
  assert.match(marked[0].textContent, /npm test/);
  assert.match(marked[0].textContent, /invalid/);
  assert.deepEqual(errors, []);
});

test("the surface says how many rules are not in force", (t) => {
  const { dom, send, doc } = makeDom();
  t.after(() => dom.window.close());
  const surface = openPermissions(send, doc,
    RULES.map((r) => (r.action === "deny" ? r : { ...r, invalid: true })));
  assert.match(surface.textContent, /2 rules do not parse and are not in force/);
});

test("one bad rule is described in the singular", (t) => {
  const { dom, send, doc } = makeDom();
  t.after(() => dom.window.close());
  const surface = openPermissions(send, doc,
    RULES.map((r) => (r.action === "ask" ? { ...r, invalid: true } : r)));
  assert.match(surface.textContent, /1 rule does not parse and is not in force/);
});

test("rules that all parse get no marker and no notice", (t) => {
  const { dom, send, doc } = makeDom();
  t.after(() => dom.window.close());
  const surface = openPermissions(send, doc, RULES);
  assert.equal(surface.querySelectorAll(".surface-state.err").length, 0);
  assert.doesNotMatch(surface.textContent, /not in force/);
});

test("an older backend that sends no flag still lists every rule", (t) => {
  // The field is additive: a CLI that predates it sends items without `invalid`.
  const { dom, errors, send, doc } = makeDom();
  t.after(() => dom.window.close());
  const surface = openPermissions(send, doc, RULES);
  assert.equal(surface.querySelectorAll("article.surface-card").length, 3);
  assert.deepEqual(errors, []);
});
