// A question the turn did not stop for.
//
// The picker docks over the composer and the turn waits. This one is a row in the transcript
// while work carries on behind it, and it folds to a single clickable line if you do not answer.
//
// The behaviours that matter are the ones that protect the transcript: an answer must say which
// question it answers, and a question must never vanish without a record that it was asked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss, mainJs } from "./support/webview-dom.mjs";

function panel() {
  // The harness collects everything the webview posts into `posted`.
  const { doc, send, errors, dom, posted } = makeDom();
  return {
    doc, dom, errors,
    event: (data) => send({ type: "event", event: data }),
    messages: () => posted,
  };
}

const QUESTION = "Which staging host should I deploy to?";

function askOpened(p, extra = {}) {
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  p.event({ type: "ask_request", ask_id: "a1", question: QUESTION, ...extra });
  return p.doc.querySelector('.open-ask[data-ask-id="a1"]');
}

test("an open question appears in the transcript, not over the composer", () => {
  const p = panel();
  const row = askOpened(p);
  assert.ok(row, "the card is in the transcript");
  assert.equal(row.dataset.state, "open");
  assert.equal(row.querySelector(".open-ask-q").textContent, QUESTION);
  assert.ok(row.querySelector(".open-ask-input"), "there is somewhere to type");
  assert.ok(row.querySelector(".open-ask-send"));
  assert.ok(row.querySelector(".open-ask-skip"));
  // The picker's docked card must not have been raised: the turn is still running.
  assert.equal(p.doc.querySelector(".ask"), null, "no docked picker");
  assert.deepEqual(p.errors, []);
});

test("an answer says which question it answers", () => {
  const p = panel();
  const row = askOpened(p);
  const before = p.messages().length;
  row.querySelector(".open-ask-input").value = "staging-2";
  row.querySelector(".open-ask-send").click();

  const sent = p.messages().slice(before).filter((m) => m && m.type === "prompt");
  assert.equal(sent.length, 1, "one prompt is posted");
  assert.equal(sent[0].text, "staging-2");
  // Structural compare: the payload is built inside the jsdom realm, so its prototype is not
  // this module's Object and a strict deepEqual would fail on that alone.
  assert.equal(sent[0].answers.length, 1);
  assert.equal(sent[0].answers[0].ask_id, "a1",
               "without this tag the backend would treat it as an ordinary message");
  assert.equal(sent[0].answers[0].question, QUESTION);
});

test("an empty answer sends nothing", () => {
  const p = panel();
  const row = askOpened(p);
  const before = p.messages().length;
  row.querySelector(".open-ask-input").value = "   ";
  row.querySelector(".open-ask-send").click();
  assert.equal(p.messages().slice(before).filter((m) => m && m.type === "prompt").length, 0);
});

test("a suggestion answers in one click", () => {
  const p = panel();
  const row = askOpened(p, { suggestions: ["staging-1", "staging-2"] });
  const chips = [...row.querySelectorAll(".open-ask-chip")];
  assert.deepEqual(chips.map((c) => c.textContent), ["staging-1", "staging-2"]);
  const before = p.messages().length;
  chips[1].click();
  const sent = p.messages().slice(before).filter((m) => m && m.type === "prompt");
  assert.equal(sent[0].text, "staging-2");
  assert.equal(sent[0].answers[0].ask_id, "a1");
});

test("Skip tells the backend, so the model is told to decide", () => {
  const p = panel();
  const row = askOpened(p);
  const before = p.messages().length;
  row.querySelector(".open-ask-skip").click();
  const sent = p.messages().slice(before).filter((m) => m && m.type === "askSkip");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].askId, "a1");
});

test("it folds to one clickable line, and comes back", () => {
  const p = panel();
  const row = askOpened(p);
  // Fold by hand rather than waiting out the timer: the timer's duration is a product decision,
  // and a test that sleeps for it is the flake we spent a night removing.
  row.querySelector(".open-ask-input")
     .dispatchEvent(new p.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(row.dataset.state, "folded");
  const folded = row.querySelector(".open-ask-folded");
  assert.match(folded.textContent, /Answer question/);
  assert.equal(folded.title, QUESTION, "the question is still readable while folded");

  folded.click();
  assert.equal(row.dataset.state, "open", "clicking it brings the question back");
});

test("an answered question leaves the card behind; the user's bubble carries it", () => {
  const p = panel();
  askOpened(p);
  p.event({ type: "ask_resolved", ask_id: "a1", outcome: "answered", question: QUESTION,
            answer: "staging-2" });
  assert.equal(p.doc.querySelector('.open-ask[data-ask-id="a1"]'), null,
               "the answer already shows as the user's own message, quoted");
});

test("a skipped or unanswered question leaves a record, never nothing", () => {
  for (const [outcome, said] of [["skipped", /Skipped/], ["expired", /Not answered/]]) {
    const p = panel();
    askOpened(p);
    p.event({ type: "ask_resolved", ask_id: "a1", outcome, question: QUESTION });
    const row = p.doc.querySelector(".open-ask");
    assert.ok(row, `a ${outcome} question stays in the transcript`);
    assert.equal(row.dataset.outcome, outcome);
    assert.match(row.textContent, said);
    assert.match(row.textContent, /staging host/, "and still says what was asked");
  }
});

test("the same question is never drawn twice", () => {
  const p = panel();
  askOpened(p);
  p.event({ type: "ask_request", ask_id: "a1", question: QUESTION });
  assert.equal(p.doc.querySelectorAll('.open-ask[data-ask-id="a1"]').length, 1);
});

test("folding is styled, not achieved by deleting the card", () => {
  const css = mainCss;
  assert.match(css, /\.open-ask\[data-state="folded"\] \.open-ask-body/, "folded hides the body");
  assert.match(css, /\.open-ask\[data-state="open"\] \.open-ask-folded/, "open hides the one-liner");
  // The timer is a product constant; pin it so a change is deliberate.
  assert.match(mainJs, /ASK_FOLD_MS = 30000/);
});

// --- what the transcript keeps of an answer -------------------------------------------------------
// Found by watching a recording of the real panel: answering a question removed the card and put
// nothing in its place. The only trace left was the agent's own "steering:" line, which echoes the
// QUESTION clipped at 80 characters -- so the transcript showed the question twice and the answer
// never. The bubble below is what an answer is supposed to leave behind.
test("answering leaves the answer in the transcript", () => {
  const p = panel();
  const card = askOpened(p);
  card.querySelector(".open-ask-input").value = "staging-2.internal";
  card.querySelector(".open-ask-send").click();

  const bubble = [...p.doc.querySelectorAll(".msg.user")].at(-1);
  assert.ok(bubble, "the answer is drawn as a message of yours");
  assert.match(bubble.textContent, /staging-2\.internal/, "the answer itself is on screen");
  assert.equal(bubble.querySelector(".answered-q")?.textContent, QUESTION,
               "and the question it answers, because the card is about to be removed");
});

test("the answer is marked once the backend has taken it", () => {
  const p = panel();
  const card = askOpened(p);
  card.querySelector(".open-ask-input").value = "staging-2.internal";
  card.querySelector(".open-ask-send").click();
  const sent = p.messages().filter((m) => m?.type === "prompt").at(-1);
  assert.equal(sent.requestId, "ask-a1", "the answer is sent under an id the backend can match");

  // ask_resolved, NOT steering_update. An earlier version of this test used steering_update and
  // passed while the real panel did nothing: resolve_open_ask steers the answer and returns before
  // the steering bookkeeping, so no steering_update is ever emitted for an answer. A probe against
  // the real backend showed ask_resolved is the only event that arrives.
  p.event({ type: "ask_resolved", ask_id: "a1", outcome: "answered",
            question: QUESTION, answer: "staging-2.internal" });
  const bubble = [...p.doc.querySelectorAll(".msg.user")].at(-1);
  assert.equal(bubble.dataset.steer, "applied");
  assert.match(bubble.textContent, /staging-2\.internal/, "and it is still the answer's bubble");
});

test("a refused answer comes back instead of sitting there", () => {
  const p = panel();
  const card = askOpened(p);
  card.querySelector(".open-ask-input").value = "staging-2.internal";
  card.querySelector(".open-ask-send").click();
  // The backend refuses an answer whose question has already closed.
  p.event({ type: "command_rejected", command: "prompt", request_id: "ask-a1",
            reason: "unknown_ask", message: "no open question with that id" });
  const bubble = [...p.doc.querySelectorAll(".msg.user")].at(-1);
  assert.ok(bubble.classList.contains("rejected"),
            "an answer that never landed must not read as one that did");
});

test("and the card it came from can be used again", () => {
  // Send disables the card. If the backend then refuses the answer, the question is still OPEN on
  // the agent's side -- but nothing re-enabled the card, and the CSS keeps a "sent" card inert
  // (`pointer-events: none`, folded button hidden). The question became unanswerable.
  const p = panel();
  const card = askOpened(p);
  card.querySelector(".open-ask-input").value = "staging-2.internal";
  card.querySelector(".open-ask-send").click();
  assert.equal(card.dataset.state, "sent");
  assert.equal(card.querySelector(".open-ask-input").disabled, true);

  p.event({ type: "command_rejected", command: "prompt", request_id: "ask-a1",
            reason: "steer_refused", message: "DGC could not take that answer." });
  assert.equal(card.dataset.state, "open", "the card is live again");
  assert.equal(card.querySelector(".open-ask-input").disabled, false);
  assert.match(card.querySelector(".open-ask-why")?.textContent || "",
               /could not take that answer/, "and it says why");
});

test("a refusal for some other prompt leaves the card alone", () => {
  const p = panel();
  const card = askOpened(p);
  card.querySelector(".open-ask-input").value = "staging-2.internal";
  card.querySelector(".open-ask-send").click();
  p.event({ type: "command_rejected", command: "prompt", request_id: "p-7",
            reason: "full", message: "the queue is full" });
  assert.equal(card.dataset.state, "sent", "only its own refusal reopens it");
});
