// A Pip's reply past 256 KB keeps its start in the chat and the whole of it as the Pip's document (Limits for everyone,
// 10 Nov; Pips API 79): the reply carries `artifact`, and its bubble shows the same document card a run's post does,
// which opens the document. A reply without one, a user message, and a malformed one show none.
import { test } from "node:test";
import assert from "node:assert/strict";
import { messageMarkup } from "../src/pipsTranscript.js";

const base = { id: "m2", pip_id: "pip_" + "a".repeat(32), workspace_id: "ws_" + "b".repeat(32), run_id: "run_" + "c".repeat(32),
  model: "m", created_at: "2026-11-11T08:00:00Z", status: "succeeded" };
const draw = (m) => messageMarkup(m, { name: "Mornings", formatDate: (x) => x, renderMarkdown: (t) => `<p>${t}</p>`, prompt: null, canSend: true, activity: null });
const doc = { id: "ar_0123456789abcdef", type: "doc", title: "The whole manual", version: 2 };

test("a long reply's bubble shows its document's card, which opens the document", () => {
  const html = draw({ ...base, role: "assistant", text: "Part 1 …\n\nThe rest is in its document.", artifact: doc });
  assert.match(html, /data-artifact-open="ar_0123456789abcdef"/);
  assert.match(html, /The whole manual/);
  assert.match(html, /Document · version 2/);
});

test("no card without one, on a user message, or for a malformed one", () => {
  assert.doesNotMatch(draw({ ...base, role: "assistant", text: "Short." }), /data-artifact-open/);
  assert.doesNotMatch(draw({ ...base, role: "user", text: "Hi", artifact: doc }), /data-artifact-open/);
  assert.doesNotMatch(draw({ ...base, role: "assistant", text: "x", artifact: { ...doc, id: "../etc" } }), /data-artifact-open/);
});
