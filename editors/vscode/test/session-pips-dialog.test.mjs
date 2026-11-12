// Deleting or archiving a Work session that is the owner of Project Pips (0.52, asked 12 Nov): "a pop up on delete
// should come, stating what all project pips that session is the owner of, and if user would like to delete those
// project pips also, or change the owner session of those pips." The host asks (sessionPipsAsk: the session's title,
// its Pips, the project's other sessions); the page's dialog names the Pips and answers once (sessionPipsAnswer):
//   delete:  Move them to another session (a session picker) · Delete them too (behind the Pips view's own words)
//   archive: Keep them here; they come back when you restore it (the default) · Move them to another session
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

const hex = (c) => c.repeat(32);
const PIPS = [{ id: "pip_" + hex("a"), name: "Billing audit", pip_type: "rook" }, { id: "pip_" + hex("b"), name: "Docs writer", pip_type: "quill" },
  { id: "pip_" + hex("c"), name: "Fixer", pip_type: "patch" }, { id: "pip_" + hex("d"), name: "Test runner", pip_type: "pulse" }];
const SESSIONS = [{ id: "20261106-091200-b2", title: "Visits page alignment" }, { id: "20261105-221000-c3", title: "What does nextWatering return?" }];
const ID = "f".repeat(32);
const ask = (extra = {}) => ({ type: "sessionPipsAsk", requestId: ID, mode: "delete", title: "Invoice totals round the wrong way", pips: PIPS, sessions: SESSIONS, ...extra });
const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
function open(extra) {
  const v = makeDom({});
  v.send(ask(extra));
  const dialog = () => v.doc.querySelector(".session-pips-dialog");
  const answers = () => JSON.parse(JSON.stringify(v.posted.filter((m) => m.type === "sessionPipsAnswer")));   // (plain objects: the page is its own window)
  const choice = (value) => dialog().querySelector(`input[name="session-pips-choice"][value="${value}"]`);
  const pick = (value) => { const input = choice(value); assert.ok(input, `the choice ${value}`); input.checked = true; input.dispatchEvent(new v.dom.window.Event("change", { bubbles: true })); };
  const press = (selector) => { const button = dialog().querySelector(selector); assert.ok(button, `Missing ${selector}`); button.click(); };
  return { v, dialog, answers, choice, pick, press };
}

test("deleting a session that owns Project Pips: the dialog names them and asks what becomes of them", () => {
  const x = open();
  assert.ok(x.dialog(), "a dialog");
  assert.equal(text(x.dialog().querySelector("h2")), "Delete “Invoice totals round the wrong way”?");
  assert.match(text(x.dialog().querySelector(".session-pips-intro")), /^This session is the owner of 4 Project Pips\. Their reports come to it\./);
  assert.deepEqual([...x.dialog().querySelectorAll(".session-pips-list li")].map(text), PIPS.map((p) => p.name), "each Pip by its name");
  assert.deepEqual([...x.dialog().querySelectorAll('input[name="session-pips-choice"]')].map((i) => [i.value, text(i.closest("label")), i.checked]),
    [["move", "Move them to another session", true], ["delete", "Delete them too", false]]);
  assert.deepEqual([...x.dialog().querySelectorAll(".session-pips-to option")].map((o) => [o.value, o.textContent]),
    [...SESSIONS.map((s) => [s.id, s.title]), ["", "No session: their reports wait in the Pips view"]], "the project's other sessions, by title, then No session");
  assert.deepEqual([...x.dialog().querySelectorAll(".session-pips-buttons button")].map(text), ["Cancel", "Delete session"]);
  assert.deepEqual(x.answers(), [], "nothing is answered until a button is");
});

test("Move them to another session: the answer names the session chosen", () => {
  const x = open();
  const to = x.dialog().querySelector(".session-pips-to");
  to.value = SESSIONS[1].id;
  x.press(".session-pips-confirm");
  assert.deepEqual(x.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "move", to: SESSIONS[1].id }]);
  assert.equal(x.dialog(), null, "and the dialog goes");
  const none = open({ sessions: [] });
  assert.deepEqual([...none.dialog().querySelectorAll(".session-pips-to option")].map((o) => o.value), [""], "no other session: No session is the one place left");
  none.press(".session-pips-confirm");
  assert.deepEqual(none.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "move", to: "" }]);
});

test("Move them to another session: sessions with the same title are told apart by when each is from", () => {
  // (12 Nov night.) "title · 2h", in the Work list's own words; a session with no time the page can read is its title alone.
  const pad = (n) => String(n).padStart(2, "0");
  const ago = (minutes) => { const d = new Date(Date.now() - minutes * 60000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const HELLO = "Say hello in three words.";
  const sessions = [{ id: "20261112-190000-e5", title: HELLO, when: ago(150) }, { id: "20261111-180000-d4", title: HELLO, when: ago(26 * 60) }, { id: "20261021-080000-g7", title: HELLO, when: ago(22 * 1440) },
    { id: "20261020-080000-h8", title: HELLO }, { id: "20261019-080000-i9", title: HELLO, when: "<b>soon</b>" }];
  const x = open({ sessions });
  assert.deepEqual([...x.dialog().querySelectorAll(".session-pips-to option")].map((o) => [o.value, o.textContent]),
    [[sessions[0].id, `${HELLO} · 2h`], [sessions[1].id, `${HELLO} · 1d`], [sessions[2].id, `${HELLO} · 3w`], [sessions[3].id, HELLO], [sessions[4].id, HELLO], ["", "No session: their reports wait in the Pips view"]]);
  const to = x.dialog().querySelector(".session-pips-to");
  to.value = sessions[1].id;
  x.press(".session-pips-confirm");
  assert.deepEqual(x.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "move", to: sessions[1].id }], "the answer is the session, as before");
});

test("Delete them too asks once more, in the Pips view's own words, before anything is answered", () => {
  const x = open();
  x.pick("delete");
  assert.equal(x.dialog().querySelector(".session-pips-to").disabled, true, "the session picker is for Move");
  x.press(".session-pips-confirm");
  assert.deepEqual(x.answers(), [], "not yet");
  assert.equal(text(x.dialog().querySelector("h2")), "Delete 4 Pips permanently?");
  assert.match(text(x.dialog().querySelector(".session-pips-intro")),
    /^This erases each one’s chat, runs, computer files, what it kept in your memory, saved sign-ins used only by that Pip, Pip-created artifacts and audit receipts\. It also removes references to them from other Pips\. This cannot be undone\.$/);
  assert.deepEqual([...x.dialog().querySelectorAll(".session-pips-list li")].map(text), PIPS.map((p) => p.name), "still named");
  assert.deepEqual([...x.dialog().querySelectorAll(".session-pips-buttons button")].map(text), ["Back", "Delete permanently"]);
  x.press(".session-pips-back");
  assert.equal(text(x.dialog().querySelector("h2")), "Delete “Invoice totals round the wrong way”?", "Back is the first question again");
  assert.equal(x.choice("delete").checked, true, "with the choice kept");
  x.press(".session-pips-confirm");
  x.press(".session-pips-confirm");
  assert.deepEqual(x.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "delete" }]);
  assert.equal(x.dialog(), null);
  const one = open({ pips: PIPS.slice(0, 1) });
  assert.match(text(one.dialog().querySelector(".session-pips-intro")), /^This session is the owner of 1 Project Pip\. Its reports come to it\./);
  assert.deepEqual([...one.dialog().querySelectorAll('input[name="session-pips-choice"]')].map((i) => text(i.closest("label"))), ["Move it to another session", "Delete it too"]);
  one.pick("delete"); one.press(".session-pips-confirm");
  assert.equal(text(one.dialog().querySelector("h2")), "Delete Billing audit permanently?");
  assert.match(text(one.dialog().querySelector(".session-pips-intro")), /^This erases its chat, runs, computer files, what it kept in your memory, saved sign-ins used only by this Pip, Pip-created artifacts and audit receipts\. It also removes references to this Pip from other Pips\. This cannot be undone\.$/);
});

test("Cancel, Esc and a newer question each answer cancel, once", () => {
  const x = open();
  x.press(".session-pips-cancel");
  assert.deepEqual(x.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "cancel" }]);
  assert.equal(x.dialog(), null);
  const y = open();
  y.dialog().dispatchEvent(new y.v.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.deepEqual(y.answers().map((m) => m.choice), ["cancel"]);
  const z = open();
  z.v.send(ask({ requestId: "e".repeat(32), title: "Another" }));
  assert.deepEqual(z.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "cancel" }], "the first is cancelled when a second arrives");
  assert.equal(z.v.doc.querySelectorAll(".session-pips-dialog").length, 1);
  assert.equal(text(z.dialog().querySelector("h2")), "Delete “Another”?");
});

test("archiving asks the same, with Keep them here as the default in Delete's place", () => {
  const x = open({ mode: "archive" });
  assert.equal(text(x.dialog().querySelector("h2")), "Archive “Invoice totals round the wrong way”?");
  assert.deepEqual([...x.dialog().querySelectorAll('input[name="session-pips-choice"]')].map((i) => [i.value, text(i.closest("label")), i.checked]),
    [["keep", "Keep them here; they come back when you restore it", true], ["move", "Move them to another session", false]]);
  assert.equal(x.dialog().querySelector(".session-pips-to").disabled, true, "the picker waits for Move");
  assert.deepEqual([...x.dialog().querySelectorAll(".session-pips-buttons button")].map(text), ["Cancel", "Archive session"]);
  x.press(".session-pips-confirm");
  assert.deepEqual(x.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "keep" }]);
  const y = open({ mode: "archive" });
  y.pick("move");
  assert.equal(y.dialog().querySelector(".session-pips-to").disabled, false);
  y.press(".session-pips-confirm");
  assert.deepEqual(y.answers(), [{ type: "sessionPipsAnswer", requestId: ID, choice: "move", to: SESSIONS[0].id }]);
});

test("a question the page can't trust is not shown", () => {
  assert.ok(open().dialog(), "a whole question is");
  for (const bad of [{ requestId: "nope" }, { pips: [] }, { mode: "erase" }, { pips: [{ id: "x", name: "y", pip_type: "rook" }] }]) {
    const x = open(bad);
    assert.equal(x.dialog(), null, JSON.stringify(bad));
  }
});
