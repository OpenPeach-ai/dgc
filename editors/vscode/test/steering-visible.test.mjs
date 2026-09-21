// A message sent mid-turn says what became of it.
//
// The agent stops printing its own "steering:" line for a frontend that reports which messages
// landed (dgc/agent.py, _drain_steer) -- on the grounds that such a frontend shows each as its own
// bubble. The editor is that frontend, and what it "showed" was the .role element, which is
// screen-reader-only: 1px, clipped, invisible. So a sighted user sent a message mid-turn and got
// no sign at all that the model had picked it up. The founder noticed it had gone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

function panel() {
  const view = makeDom();
  const { doc, send, errors, dom, posted } = view;
  return { doc, dom, posted, send, errors, event: (data) => send({ type: "event", event: data }) };
}

// Type into the composer and send, which is what puts the message in pendingPrompts. Posting a
// "prompt" message INTO the webview is not the same thing and registers nothing.
function steerDuringTurn(p, text = "use staging-2") {
  p.event({ type: "ready", capabilities: { live_steering: true }, model: "m", mode: "default",
            think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [],
            custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 });
  p.event({ type: "turn_start", turn_id: "t1", prompt: "deploy it", kind: "prompt" });
  const input = p.doc.getElementById("input");
  input.value = text;
  input.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  p.doc.getElementById("send").click();
  const sent = [...p.posted].reverse().find((m) => m?.type === "prompt");
  return String(sent?.requestId || "");
}

const bubble = (doc) => [...doc.querySelectorAll(".msg.user")].at(-1);

test("a steered message reports each stage it reaches", () => {
  const p = panel();
  const id = steerDuringTurn(p);
  assert.ok(id, "the composer sent a prompt with a request id");

  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  assert.equal(bubble(p.doc)?.dataset.steer, "pending",
               "accepted by the backend, not yet read by the model");

  p.event({ type: "steering_update", request_id: id, state: "applied" });
  assert.equal(bubble(p.doc)?.dataset.steer, "applied",
               "the model has now read it -- this is the moment that had no visible sign");
});

test("a queued message says so instead", () => {
  const p = panel();
  const id = steerDuringTurn(p);
  p.event({ type: "prompt_accepted", request_id: id, state: "queued", count: 1 });
  assert.equal(bubble(p.doc)?.dataset.steer, "queued");
});

test("every state is drawn, and not with the screen-reader-only label", () => {
  // A fresh panel per state: a queued prompt is re-parented to the waiting area, so reusing one
  // panel makes "the last .msg.user" the queued row rather than the one just sent.
  for (const [state, words] of [["pending", /steering/], ["queued", /queued/], ["applied", /steered/]]) {
    const p = panel();
    const id = steerDuringTurn(p, `answer ${state}`);
    p.event({ type: "prompt_accepted", request_id: id,
              state: state === "queued" ? "queued" : "steered", count: 1 });
    if (state === "applied") p.event({ type: "steering_update", request_id: id, state: "applied" });
    const row = [...p.doc.querySelectorAll(".msg.user")].find((n) => n.dataset.steer === state);
    assert.ok(row, `no row reached the ${state} state`);
    const note = row.querySelector(":scope > .steer-note");
    assert.ok(note, `${state} draws nothing, so it would be invisible like .role is`);
    assert.match(note.textContent, words);
  }
  // .role must stay screen-reader-only AND not be the only thing carrying this information.
  assert.match(mainCss, /\.role \{[^}]*clip-path:\s*inset\(50%\)/,
               ".role is still for screen readers, as it should be");
  assert.match(mainCss, /\.msg\.user > \.steer-note/, "and something visible carries it too");
});

test("the applied line is the one that stands out", () => {
  const applied = /\.msg\.user\[data-steer="applied"\] > \.steer-note \{([^}]*)\}/.exec(mainCss)?.[1] ?? "";
  assert.match(applied, /color:/, "the moment the model reads it is worth a colour of its own");
});

test("the note sits under the bubble, not inside it", () => {
  // It lived in the bubble for one release-candidate, purely to keep the transcript's spacing
  // measurements quiet. Inside, a status line about the message reads as words the user typed --
  // the founder caught it in a recording. The spacing check now measures the prompt's real foot.
  const p = panel();
  const id = steerDuringTurn(p);
  p.event({ type: "prompt_accepted", request_id: id, state: "steered" });
  const row = bubble(p.doc);
  assert.ok(row.querySelector(":scope > .steer-note"), "the note is a child of the message row");
  assert.equal(row.querySelector(".bubble .steer-note"), null,
               "and never inside the bubble, where it would read as something you said");
  assert.doesNotMatch(mainCss, /\.bubble::after/,
                      "no pseudo-element route back into the bubble either");
});
