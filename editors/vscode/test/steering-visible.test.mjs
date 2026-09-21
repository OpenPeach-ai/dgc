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
  const css = mainCss;
  for (const state of ["pending", "queued", "applied"]) {
    assert.match(css, new RegExp(`\\[data-steer="${state}"\\] > \\.bubble::after`),
                 `${state} has no visible text, so it would be invisible like .role is`);
  }
  // The regression in one assertion: .role must stay screen-reader-only AND not be the only
  // thing carrying this information.
  assert.match(css, /\.role \{[^}]*clip-path:\s*inset\(50%\)/,
               ".role is still for screen readers, as it should be");
  assert.match(css, /\.msg\.user\[data-steer\] > \.bubble::after/, "and something visible carries it too");
});

test("the applied line is the one that stands out", () => {
  const css = mainCss;
  const applied = /\.msg\.user\[data-steer="applied"\] > \.bubble::after \{([^}]*)\}/.exec(css)?.[1] ?? "";
  assert.match(applied, /content:/);
  assert.match(applied, /color:/, "the moment the model reads it is worth a colour of its own");
});

test("the note is inside the bubble, not hung under the row", () => {
  // Hung off .msg.user it lay outside the bubble's box, so transcript-spacing measured its height
  // as empty space and read 47px where the design calls for 24px between a prompt and what follows.
  const css = mainCss;
  assert.doesNotMatch(css, /\.msg\.user\[data-steer\]::after/,
                      "the note must not hang off the row again -- see transcript-spacing.test.mjs");
});
