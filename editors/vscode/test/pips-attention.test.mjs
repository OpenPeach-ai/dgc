// A Pip that needs you is said once, by the editor, whether or not the DGC panel is on screen.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";

const code = buildSync({ entryPoints: [fileURLToPath(new URL("../src/pipsAttention.ts", import.meta.url))], bundle: true, write: false, format: "cjs", platform: "node" }).outputFiles[0].text;
const mod = { exports: {} }; new Function("module", "exports", code)(mod, mod.exports);
const { pipsAttention } = mod.exports;
const run = "run_" + "b".repeat(32);
const digest = (extra = {}) => ({ reason: "alert", headline: "1 new finding from Commit reviewer (worst: high)", pending_reviews: 0, pending_setups: 0,
  pips: [{ alert: true, new_findings: [{ run_id: run, finding_index: 0 }] }], ...extra });

test("a new alert is said with the digest's headline, once", () => {
  const first = pipsAttention(digest(), undefined);
  assert.equal(first.text, "DGC Pips: 1 new finding from Commit reviewer (worst: high)");
  assert.equal(pipsAttention(digest(), first.state), null, "the same alert is never said twice");
  const second = pipsAttention(digest({ pips: [{ alert: true, new_findings: [{ run_id: run, finding_index: 0 }, { run_id: run, finding_index: 1 }] }] }), first.state);
  assert.match(second.text, /^DGC Pips: /, "a further finding is new");
});

test("reviews are said when there are more than last time, never when they drop", () => {
  const one = pipsAttention(digest({ reason: "daily", pips: [], pending_reviews: 1 }), undefined);
  assert.equal(one.text, "DGC Pips: 1 review waiting for you.");
  const fewer = pipsAttention(digest({ reason: null, pips: [], pending_reviews: 0 }), one.state);
  assert.equal(fewer.text, null);
  assert.equal(fewer.state.reviews, 0, "but remembered, so the next one is news");
  const again = pipsAttention(digest({ reason: "daily", pips: [], pending_reviews: 1, pending_setups: 1 }), fewer.state);
  assert.equal(again.text, "DGC Pips: 2 reviews waiting for you.");
});

test("a finding below the alert level, or no digest, says nothing", () => {
  assert.equal(pipsAttention(digest({ reason: "daily", pips: [{ alert: false, new_findings: [{ run_id: run, finding_index: 0 }] }] }), undefined), null);
  assert.equal(pipsAttention(null, undefined), null);
  assert.equal(pipsAttention({ pips: "x" }, undefined), null);
});

test("an action a Pip drafted for your approval counts as waiting for you", () => {
  const said = pipsAttention(digest({ reason: "daily", pips: [], pending_actions: 2 }), undefined);
  assert.equal(said.text, "DGC Pips: 2 reviews waiting for you.");
});

test("with Needs attention (API 44) the notice counts every card the Pips home lists, never fewer than the digest", () => {
  const five = pipsAttention(digest({ reason: null, pips: [], pending_actions: 2 }), undefined, 5);
  assert.equal(five.text, "DGC Pips: 5 things are waiting for you.", "Connect, plugin and routine cards count too");
  assert.equal(pipsAttention(digest({ reason: null, pips: [], pending_actions: 2 }), five.state, 5), null, "said once");
});

test("the notice says the number the Pips home says, whatever the digest counted (08-i8-07)", () => {
  // The digest counted the held form and a workflow's handoff; Needs attention said 1, the notice 2.
  const seen = pipsAttention(digest({ reason: null, pips: [], pending_reviews: 2 }), undefined, 1);
  assert.equal(seen.text, "DGC Pips: 1 thing is waiting for you.");
  assert.equal(seen.state.reviews, 1);
  assert.equal(pipsAttention(digest({ reason: null, pips: [], pending_reviews: 2 }), seen.state, 1), null, "the digest's larger count is no news");
  const none = pipsAttention(digest({ reason: null, pips: [], pending_reviews: 2 }), undefined, 0);
  assert.equal(none?.text ?? null, null, "nothing on the list: nothing to say");
});

test("reviews in a project are named apart, never added into that number", () => {
  const both = pipsAttention(digest({ reason: null, pips: [], pending_reviews: 3 }), undefined, 2, 1);
  assert.equal(both.text, "DGC Pips: 2 things are waiting for you, and 1 review in a project.");
  assert.equal(pipsAttention(digest({ reason: null, pips: [], pending_reviews: 3 }), both.state, 2, 1), null, "said once");
  const more = pipsAttention(digest({ reason: null, pips: [] }), both.state, 2, 2);
  assert.equal(more.text, "DGC Pips: 2 things are waiting for you, and 2 reviews in a project.", "a new one is news");
  assert.equal(pipsAttention(digest({ reason: null, pips: [] }), undefined, 0, 1).text, "DGC Pips: 1 review waiting for you in a project.");
  assert.equal(pipsAttention(digest({ reason: null, pips: [] }), undefined, 0, 3).text, "DGC Pips: 3 reviews waiting for you in a project.");
});
