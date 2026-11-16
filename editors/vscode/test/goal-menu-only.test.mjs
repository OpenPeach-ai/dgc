// A goal starts only when Goal is chosen from the "/" menu (decided 12 Nov).
// The composer's goal paths, in the panel's own script (media/main.js) with a stub host:
//   - Goal chosen in the menu (Enter, Tab or a click on its row) pins the Goal choice to this draft; what is sent
//     next is the goal's objective;
//   - the whole token "/goal" typed pins nothing by itself;
//   - "/goal some text" typed and sent without the menu, and a message that ends in " /goal", go as plain text;
//   - the words that manage a goal stay commands, typed or with Goal chosen: pause, resume, clear, budget N.
// Real keys and the menu's look are checked in Chromium (goal-menu-browser.test.mjs, composer-pills-live.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function panel() {
  const h = makeDom(), win = h.dom.window, doc = h.doc, input = doc.getElementById("input");
  h.send({ type: "session_ready", sessionId: "s1" });
  const of = (type) => h.posted.filter((m) => m?.type === type);
  return { ...h, input, pop: doc.getElementById("pop"), goal: doc.getElementById("btn-goal"), of,
    /** Typed, with the caret at the end: the menu follows what is typed. */
    type(text) { input.value = text; input.selectionStart = input.selectionEnd = text.length; input.dispatchEvent(new win.Event("input", { bubbles: true })); },
    key(key) { input.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); },
    menu: () => (doc.getElementById("pop").style.display === "block" ? [...doc.querySelectorAll("#pop .pi")].map((row) => row.textContent.trim()) : null),
    sentAs: () => ({ goals: of("startGoal").map((m) => m.text), prompts: of("prompt").map((m) => m.text), commands: of("slashText").map((m) => m.text) }) };
}

test("typing the whole /goal token pins nothing: the menu lists Goal, and the text stays as typed", () => {
  for (const text of ["/goal", "finish the build /goal"]) {
    const p = panel();
    p.type(text);
    assert.equal(p.goal.hidden, true, `${text}: no Goal choice`);
    assert.equal(p.input.value, text, "the token is not taken out of the draft");
    assert.match(p.menu()?.[0] || "", /^goal/, "the menu is open, Goal first");
    assert.deepEqual(p.sentAs(), { goals: [], prompts: [], commands: [] });
    assert.deepEqual(p.errors, []);
  }
});

test("Goal chosen in the menu, by Enter, Tab or a click, pins the choice; the next message is its objective", () => {
  for (const how of ["Enter", "Tab", "click"]) {
    const p = panel();
    p.type("/go");
    assert.match(p.menu()?.[0] || "", /^goal/);
    if (how === "click") p.doc.querySelector("#pop .pi").click(); else p.key(how);
    assert.equal(p.goal.hidden, false, `${how}: Goal is pinned to this draft`);
    assert.equal(p.goal.dataset.state, "draft");
    assert.equal(p.input.value, "", "the slash token leaves the text");
    assert.equal(p.menu(), null, "the menu closes");
    assert.deepEqual(p.sentAs().goals, [], "choosing it starts nothing");
    p.input.value = "Ship the release"; p.key("Enter");
    assert.deepEqual(p.sentAs(), { goals: ["Ship the release"], prompts: [], commands: [] });
    assert.equal(p.goal.hidden, true, "the choice leaves with the message");
    assert.deepEqual(p.errors, []);
  }
});

test("Goal chosen at the end of a message that is already written keeps the message as its objective", () => {
  const p = panel();
  p.type("finish the build /goal"); p.key("Enter");
  assert.equal(p.goal.hidden, false); assert.equal(p.input.value, "finish the build ");
  p.key("Enter");
  assert.deepEqual(p.sentAs(), { goals: ["finish the build"], prompts: [], commands: [] });
});

test('"/goal some text" typed and sent without the menu goes as plain text', () => {
  const p = panel();
  p.type("/goal fix the build");
  assert.equal(p.menu(), null, "no menu: the caret is past the token");
  assert.equal(p.goal.hidden, true);
  p.key("Enter");
  assert.deepEqual(p.sentAs(), { goals: [], prompts: ["/goal fix the build"], commands: [] });
  assert.equal(p.doc.querySelector(".goal-prompt"), null, "no goal row in the transcript");
  assert.equal([...p.doc.querySelectorAll(".msg.user .bubble")].at(-1).textContent, "/goal fix the build", "your message, as you wrote it");
  assert.equal(p.input.value, "");
  // Pasted or set without an input event (no menu was ever open), and with a budget flag: the same.
  const q = panel();
  q.input.value = "/goal --tokens 9000 Prepare a weekly plan"; q.key("Enter");
  assert.deepEqual(q.sentAs(), { goals: [], prompts: ["/goal --tokens 9000 Prepare a weekly plan"], commands: [] });
  assert.deepEqual([...p.errors, ...q.errors], []);
});

test('" /goal" at the end of a message is plain text unless Goal is chosen from the menu', () => {
  // Sent with no menu open.
  const p = panel();
  p.input.value = "Verify the release /goal"; p.key("Enter");
  assert.deepEqual(p.sentAs(), { goals: [], prompts: ["Verify the release /goal"], commands: [] });
  // The menu opened as it was typed, and was closed with Escape: still plain text.
  const q = panel();
  q.type("Verify the release /goal");
  assert.match(q.menu()?.[0] || "", /^goal/);
  q.key("Escape");
  assert.equal(q.menu(), null); assert.equal(q.goal.hidden, true);
  q.key("Enter");
  assert.deepEqual(q.sentAs(), { goals: [], prompts: ["Verify the release /goal"], commands: [] });
  assert.deepEqual([...p.errors, ...q.errors], []);
});

test("the words that manage a goal stay commands when typed: pause, resume, clear, budget N", () => {
  for (const text of ["/goal pause", "/goal resume", "/goal clear", "/goal budget 5000", "/goal budget off", "/GOAL Pause"]) {
    const p = panel();
    p.type(text); p.key("Enter");
    assert.deepEqual(p.sentAs(), { goals: [], prompts: [], commands: [text] }, text);
    assert.equal(p.input.value, "");
    assert.deepEqual(p.errors, []);
  }
});

test("and with Goal chosen from the menu: the word alone is the command, and the choice is spent", () => {
  for (const [word, command] of [["pause", "/goal pause"], ["resume", "/goal resume"], ["clear", "/goal clear"], ["budget 9000", "/goal budget 9000"]]) {
    const p = panel();
    p.type("/goal"); p.key("Enter");
    assert.equal(p.goal.hidden, false);
    p.input.value = word; p.key("Enter");
    assert.deepEqual(p.sentAs(), { goals: [], prompts: [], commands: [command] }, word);
    assert.equal(p.goal.hidden, true);
    assert.deepEqual(p.errors, []);
  }
});

test("/goal alone, sent with the menu closed, asks about the goal there is and starts nothing", () => {
  const p = panel();
  p.type("/goal"); p.key("Escape"); p.key("Enter");
  assert.deepEqual(p.sentAs(), { goals: [], prompts: [], commands: ["/goal"] });
  assert.equal(p.goal.hidden, true);
  assert.deepEqual(p.errors, []);
});

test("a word that only starts like it is no goal: /goalie is the command it always was", () => {
  const p = panel();
  p.input.value = "/goalie save"; p.key("Enter");
  assert.deepEqual(p.sentAs(), { goals: [], prompts: [], commands: ["/goalie save"] });
});
