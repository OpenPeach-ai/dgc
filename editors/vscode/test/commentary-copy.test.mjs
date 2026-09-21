// Copying one mid-turn line, and how long a hover label makes you wait.
//
// Response actions attach to a single block per turn -- the final answer -- so the running
// commentary above it, often the most quotable text in the transcript, had no way to be copied.
//
// What matters beyond "a button exists": it must reach the keyboard, it must copy its OWN block,
// and a block that turns out to be the answer must not keep an affordance it should never have had.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss, mainJs } from "./support/webview-dom.mjs";

const LINE_ONE = "Let me look at how the API reads the Turnstile keys.";
const LINE_TWO = "Found it: the secret key and the site key are from different widgets.";
const ANSWER = "Copy the matching pair into `.env` and restart the API.";

function panel() {
  const { doc, send, errors } = makeDom();
  return { doc, event: (data) => send({ type: "event", event: data }), errors };
}

function turnWithCommentary(event, id = "t1") {
  event({ type: "turn_start", turn_id: id, prompt: "check the keys", kind: "prompt" });
  event({ type: "text_delta", text: LINE_ONE });
  event({ type: "stream_end", message_id: `${id}:1`, phase: "commentary" });
  event({ type: "tool_call", call_id: `${id}c1`, name: "bash",
          args: { command: "grep -n TURNSTILE .env" }, summary: "grep -n TURNSTILE .env" });
  event({ type: "tool_result", call_id: `${id}c1`, name: "bash", is_error: false,
          is_diff: false, diff: "", output: ".env:14:TURNSTILE_SITE_KEY=0x4AAA" });
  event({ type: "text_delta", text: LINE_TWO });
  event({ type: "stream_end", message_id: `${id}:2`, phase: "commentary" });
  event({ type: "text_delta", text: ANSWER });
  event({ type: "stream_end", message_id: `${id}:3`, phase: "answer" });
  event({ type: "turn_end", turn_id: id, reason: "completed", token_estimate: 0,
          final_message_id: `${id}:3` });
}

const commentaryBlocks = (doc) => [...doc.querySelectorAll(".text.commentary")];
const copyButton = (block) => block.querySelector(":scope > .commentary-actions button");

test("every mid-turn line gets its own copy; the answer keeps the full actions", () => {
  const { doc, event, errors } = panel();
  turnWithCommentary(event);
  assert.deepEqual(errors, []);

  const blocks = commentaryBlocks(doc);
  assert.equal(blocks.length, 2, "both mid-turn lines are commentary");
  for (const block of blocks) assert.ok(copyButton(block), "each carries a copy button");

  const answer = [...doc.querySelectorAll(".text")].find((n) => !n.classList.contains("commentary"));
  assert.ok(answer, "the turn has a non-commentary answer");
  assert.equal(answer.querySelector(":scope > .commentary-actions"), null,
               "the answer must not grow a second, lesser copy button");
  assert.ok(doc.querySelector(".response-actions .ract-copy"),
            "the answer still has the full response actions");
});

test("the copy is reachable without a mouse", () => {
  const { doc, event } = panel();
  turnWithCommentary(event);
  const button = copyButton(commentaryBlocks(doc)[0]);

  assert.equal(button.tagName, "BUTTON");
  assert.equal(button.getAttribute("type"), "button");
  assert.ok(button.getAttribute("aria-label"), "it announces itself to a screen reader");
  assert.equal(button.getAttribute("tabindex"), null, "left in the natural tab order");

  const css = mainCss;
  assert.match(css, /\.commentary-actions:focus-within/,
               "focus must reveal it, or keyboard users get an invisible control");
  assert.match(css, /\.text\.commentary:hover \.commentary-actions/, "hover reveals it too");
  assert.doesNotMatch(css, /\.commentary-actions\s*\{[^}]*display:\s*none/,
                      "hidden with opacity, not display:none, so it stays focusable");
});

test("a block promoted to the answer loses the commentary copy", () => {
  const { doc, event } = panel();
  event({ type: "turn_start", turn_id: "t9", prompt: "one line only", kind: "prompt" });
  event({ type: "text_delta", text: ANSWER });
  event({ type: "stream_end", message_id: "t9:1", phase: "commentary" });
  event({ type: "turn_end", turn_id: "t9", reason: "completed", token_estimate: 0,
          final_message_id: "t9:1" });

  const promoted = [...doc.querySelectorAll(".text")].find((n) => n.textContent.includes("restart the API"));
  assert.ok(promoted, "the block is still in the transcript");
  assert.equal(promoted.classList.contains("commentary"), false, "it is the answer now");
  assert.equal(promoted.querySelector(":scope > .commentary-actions"), null,
               "and it dropped the affordance it briefly had");
});

test("re-rendering does not stack copies", () => {
  const { doc, event } = panel();
  turnWithCommentary(event, "t1");
  turnWithCommentary(event, "t2");
  for (const block of commentaryBlocks(doc)) {
    assert.equal(block.querySelectorAll(":scope > .commentary-actions").length, 1,
                 "exactly one copy row per block");
  }
});

test("a hover label waits, and stops feeling instant sooner", () => {
  // Codex's own numbers, read from its shipped webview bundle: delayDuration 700,
  // skipDelayDuration 300. Ours were 380/500 -- twice as eager, and instant for longer.
  const js = mainJs;
  assert.match(js, /TIP_DELAY_MS = 700/, "a first hover waits 700ms");
  assert.match(js, /TIP_WARM_MS = 300/, "and the instant-for-neighbours window is 300ms");
  assert.doesNotMatch(js, /Date\.now\(\) - warm < 500 \? 0 : 380/, "the old eager pair is gone");
});

test("a card that ran a command offers to copy it", () => {
  const { doc, event } = panel();
  const COMMAND = "npm run build -- --watch";
  event({ type: "turn_start", turn_id: "c1", prompt: "build it", kind: "prompt" });
  event({ type: "tool_call", call_id: "x1", name: "bash", args: { command: COMMAND },
          summary: COMMAND });
  event({ type: "tool_result", call_id: "x1", name: "bash", is_error: false, is_diff: false,
          diff: "", output: "built" });

  const card = doc.querySelector('.tool[data-call-id="x1"]');
  assert.ok(card, "the command card is in the transcript");
  const button = card.querySelector(".head .tool-copy-cmd");
  assert.ok(button, "it carries a copy");
  assert.equal(button.getAttribute("aria-label"), "Copy command");
  assert.equal(button.getAttribute("type"), "button");
});

test("a card that ran no command does not", () => {
  const { doc, event } = panel();
  event({ type: "turn_start", turn_id: "c2", prompt: "read it", kind: "prompt" });
  event({ type: "tool_call", call_id: "x2", name: "read_file", args: { path: "a.py" },
          summary: "a.py" });
  event({ type: "tool_result", call_id: "x2", name: "read_file", is_error: false, is_diff: false,
          diff: "", output: "print(1)" });

  const card = doc.querySelector('.tool[data-call-id="x2"]');
  assert.ok(card, "the read card is in the transcript");
  assert.equal(card.querySelector(".head .tool-copy-cmd"), null,
               "a file path is not a command; Open already sits beside it");
  assert.ok(card.querySelector(".head .open-file"), "and Open is what it gets instead");
});

test("the command copy is revealed on hover and focus, never display:none", () => {
  const css = mainCss;
  assert.match(css, /\.tool:hover \.tool-copy-cmd/, "hovering the card reveals it");
  assert.match(css, /\.tool \.tool-copy-cmd:focus-visible/, "and keyboard focus does too");
  assert.doesNotMatch(css, /\.tool \.tool-copy-cmd\s*\{[^}]*display:\s*none/,
                      "faded, not removed, so Tab still reaches it");
});
