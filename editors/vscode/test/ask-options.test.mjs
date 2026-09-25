// An open question can carry options without becoming the blocking picker.
//
// The distinction that matters is PLACEMENT, not appearance. The rows deliberately look like the
// picker's, but this card lives in the transcript and must never dock into the composer: docking
// is what makes the picker modal, and the entire point of this surface is that the turn did not
// stop for it. Picking a row answers exactly as typing does -- one tagged prompt -- so nothing
// new crosses the wire in the other direction either.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function askedWith(options) {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "ready", capabilities: { open_asks: true, ask_options: true } });
  event({ type: "turn_start", turn_id: "t", prompt: "set it up" });
  event({ type: "ask_request", ask_id: "a1", question: "Where should this run?",
          ...(options ? { options } : {}) });
  return h;
}

const OPTIONS = [
  { label: "Local", description: "on this machine", recommended: true },
  { label: "Cloud", description: "on a rented box" },
];

test("the options are drawn as rows on the card", () => {
  const h = askedWith(OPTIONS);
  const rows = [...h.doc.querySelectorAll(".open-ask .oask-opt")];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].querySelector(".oask-label").textContent, "Local");
  assert.equal(rows[1].querySelector(".oask-desc").textContent, "on a rented box");
});

test("the recommended one is marked", () => {
  const h = askedWith(OPTIONS);
  const rows = [...h.doc.querySelectorAll(".open-ask .oask-opt")];
  assert.ok(rows[0].classList.contains("recommended"));
  assert.ok(rows[0].querySelector(".oask-mark"), "and says so in words, not colour alone");
  assert.equal(rows[1].classList.contains("recommended"), false);
});

test("the card stays in the transcript and never docks into the composer", () => {
  const h = askedWith(OPTIONS);
  const card = h.doc.querySelector(".open-ask");
  assert.ok(card.closest("#log"), "it belongs to the transcript");
  assert.equal(card.closest("#cbox"), null, "docking is what makes the picker modal");
  assert.equal(h.doc.body.classList.contains("ask-docked"), false);
  assert.equal(h.doc.getElementById("input").hidden, false, "you can still type a normal message");
});

test("picking an option answers the question the same way typing does", () => {
  const h = askedWith(OPTIONS);
  h.doc.querySelector(".open-ask .oask-opt").click();
  const sent = h.posted.at(-1);
  assert.equal(sent.type, "prompt");
  assert.equal(sent.text, "Local");
  // The message crosses a realm boundary (jsdom -> here), so its Array prototype is not this
  // realm's and deepStrictEqual rejects it on identity. Compare the values.
  assert.deepEqual(JSON.parse(JSON.stringify(sent.answers)),
                   [{ ask_id: "a1", question: "Where should this run?" }]);
});

test("a question with no options is unchanged", () => {
  const h = askedWith(null);
  assert.equal(h.doc.querySelector(".open-ask .oask-opt"), null);
  assert.ok(h.doc.querySelector(".open-ask-input"), "still a text box");
});

test("the folded line says how many options are waiting", () => {
  const h = askedWith(OPTIONS);
  const folded = h.doc.querySelector(".open-ask-folded");
  assert.match(folded.textContent, /2 options/,
    "the folded chip is all that survives, so it must be worth reopening");
  const plain = askedWith(null).doc.querySelector(".open-ask-folded");
  assert.equal(plain.textContent.includes("option"), false);
});

test("a malformed option is skipped, not fatal", () => {
  const h = askedWith([{ label: "Local" }, { description: "no label" }, { label: "" }]);
  const rows = [...h.doc.querySelectorAll(".open-ask .oask-opt")];
  assert.equal(rows.length, 1, "the good row survives");
  assert.deepEqual(h.errors, []);
});
