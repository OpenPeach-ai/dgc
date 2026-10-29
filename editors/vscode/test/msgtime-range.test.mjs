import test from "node:test";
import assert from "node:assert/strict";
import "../media/msgtime.js";

test("out-of-range saved timestamps do not crash message rendering", () => {
  const time = globalThis.DgcTime;
  for (const at of [NaN, Infinity, 8.64e15 + 1, 1e20]) {
    assert.equal(time.label(at), "");
    assert.equal(time.title(at), "");
    assert.equal(time.markup(at), "");
    assert.equal(time.node(at), null);
  }
  assert.match(time.markup(1_700_000_000_000), /^<time /);
});
