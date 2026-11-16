// A Pip's reply shows what it made (Pips API 102; live round r27, 16 Nov: the Pip "Made the page" and its reply had
// nothing to open it with): each page, doc, sheet, deck or dashboard it made or changed is the card Work draws, which
// opens it (data-artifact-open, the Pip page's own Open). None on a user message, none for a malformed one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { messageMarkup } from "../src/pipsTranscript.js";

const base = { id: "m2", pip_id: "pip_" + "a".repeat(32), workspace_id: "ws_" + "b".repeat(32), run_id: "run_" + "c".repeat(32),
  model: "m", created_at: "2026-11-16T08:41:00Z", status: "succeeded" };
const draw = (m) => messageMarkup(m, { name: "Tile checker", formatDate: (x) => x, renderMarkdown: (t) => `<p>${t}</p>`, prompt: null, canSend: true, activity: null });
const page = { id: "ar_0123456789abcdef", type: "page", title: "Today in big letters", op: "made" };
const sheet = { id: "ar_fedcba9876543210", type: "sheet", title: "Tide table", op: "changed" };

test("each thing the reply made or changed is a card that opens it", () => {
  const html = draw({ ...base, role: "assistant", text: "Made the page.", artifacts: [page, sheet] });
  assert.match(html, /data-artifact-open="ar_0123456789abcdef" data-artifact-type="page"/);
  assert.match(html, /data-artifact-open="ar_fedcba9876543210" data-artifact-type="sheet"/);
  assert.match(html, /Today in big letters/);
  assert.match(html, /Page · made/);
  assert.match(html, /Spreadsheet · changed/);
});

test("none on a user message, without one, or for a malformed one", () => {
  assert.doesNotMatch(draw({ ...base, role: "user", text: "Hi", artifacts: [page] }), /data-artifact-open/);
  assert.doesNotMatch(draw({ ...base, role: "assistant", text: "Short." }), /data-artifact-open/);
  for (const bad of [{ ...page, id: "../etc" }, { ...page, type: "video" }, { ...page, title: 3 }])
    assert.doesNotMatch(draw({ ...base, role: "assistant", text: "x", artifacts: [bad] }), /data-artifact-open/);
});
