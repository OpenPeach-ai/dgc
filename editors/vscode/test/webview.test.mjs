// Headless render test for the DGC webview (media/main.js).
//
// We can't drive the real editor UI headlessly — VS Code's webview host, the
// activity-bar panel and the native QuickPicks need a running editor. What we CAN
// verify here is the webview's own logic in a real DOM: load the exact HTML skeleton
// that panel.ts ships, eval media/main.js against it, feed it a scripted `dgc serve`
// event stream, and assert the elements render with zero JS errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";

const dir = fileURLToPath(new URL(".", import.meta.url));
const panelSrc = readFileSync(dir + "../src/panel.ts", "utf8");
const mainJs = readFileSync(dir + "../media/main.js", "utf8");

// Pull the real HTML template out of panel.ts's html() and neutralise the
// `${nonce}` / `${css}` / `${csp}` interpolations so the markup stays in sync
// with what ships — the test never hand-rolls its own DOM.
const htmlMatch = panelSrc.match(/<!doctype html>[\s\S]*?<\/body><\/html>/i);
assert.ok(htmlMatch, "could not extract the webview HTML template from panel.ts");
const html = htmlMatch[0].replace(/\$\{[^}]*\}/g, "");

function makeDom() {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  const posted = [];
  dom.window.acquireVsCodeApi = () => ({
    postMessage: (m) => posted.push(m),
    getState: () => undefined,
    setState: () => undefined,
  });
  dom.window.eval(mainJs); // runs the webview IIFE against this DOM
  const send = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  return { dom, errors, posted, send, doc: dom.window.document };
}

test("webview renders a full turn: thinking → text → 2 tool cards → diff → permission round-trip", () => {
  const { dom, errors, posted, send, doc } = makeDom();

  // model / mode state
  send({ type: "state", state: { model: "qwen3:8b", mode: "default", think: "off" } });
  assert.equal(doc.getElementById("pmodel").textContent, "qwen3:8b");
  assert.equal(doc.getElementById("modelname").textContent, "qwen3:8b");

  send({ type: "event", event: { type: "ready", commands: [] } });
  send({ type: "event", event: { type: "turn_start" } });

  // subtle thinking indicator is present
  assert.ok(doc.querySelector(".thinking"), "thinking indicator did not render");

  // reasoning stream → collapsible disclosure
  send({ type: "event", event: { type: "thinking_delta", text: "Reading the token module first." } });
  assert.ok(doc.querySelector(".disclosure"), "thinking disclosure did not render");
  assert.match(doc.querySelector(".reasoning").textContent, /token module/);

  // streamed assistant markdown
  send({ type: "event", event: { type: "text_delta", text: "I'll add an `iat` claim, " } });
  send({ type: "event", event: { type: "text_delta", text: "then run the tests.\n" } });
  assert.match(doc.querySelector(".text").textContent, /iat/);
  assert.ok(doc.querySelector(".text code"), "inline code did not render");

  // tool card 1 — read_file (glyph →)
  send({ type: "event", event: { type: "tool_call", name: "read_file", summary: "src/auth.ts", call_id: "c1" } });
  send({ type: "event", event: { type: "tool_result", call_id: "c1", name: "read_file", output: "line one\nline two", is_diff: false } });

  // tool card 2 — edit_file (glyph ✎) with an inline unified diff
  send({ type: "event", event: { type: "tool_call", name: "edit_file", summary: "src/auth.ts", call_id: "c2" } });
  send({
    type: "event",
    event: {
      type: "tool_result", call_id: "c2", name: "edit_file", is_diff: true,
      diff: "--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -5,3 +5,3 @@\n-  return jwt.sign({ sub }, KEY, {\n+  return jwt.sign({ sub, iat: now }, KEY, {\n   algorithm: \"HS256\",",
    },
  });

  const tools = doc.querySelectorAll(".tool");
  assert.equal(tools.length, 2, "expected exactly 2 tool cards");
  assert.equal(tools[0].querySelector(".glyph").textContent, "→", "read_file glyph");
  assert.equal(tools[0].querySelector(".verb").textContent, "read_file");
  assert.equal(tools[1].querySelector(".glyph").textContent, "✎", "edit_file glyph");

  const diff = doc.querySelector(".diff");
  assert.ok(diff, "inline diff did not render");
  assert.ok(diff.querySelector(".add"), "diff add line missing");
  assert.ok(diff.querySelector(".del"), "diff del line missing");
  assert.match(diff.querySelector(".add").textContent, /iat/, "diff add line content");
  // mono+purple diff: added lines carry .add (styled purple), never a green class
  assert.equal(diff.querySelectorAll(".green, .add-green").length, 0);

  // inline permission card + approval round-trip
  send({
    type: "event",
    event: { type: "permission_request", id: "p1", name: "bash", command: "npm test", suggested_rule: "bash(npm test)", args: { command: "npm test" } },
  });
  const card = doc.querySelector(".card");
  assert.ok(card, "permission card did not render");
  const btns = card.querySelectorAll("button");
  assert.equal(btns.length, 3, "permission card should offer Allow once / Always / Deny");

  card.querySelector('button[data-d="once"]').click();
  const resp = posted.find((m) => m.type === "permission_response");
  assert.ok(resp, "no permission_response was posted");
  assert.equal(resp.id, "p1");
  assert.equal(resp.decision, "once");
  assert.ok(card.classList.contains("resolved"), "card should be marked resolved after a decision");

  send({ type: "event", event: { type: "turn_end" } });
  assert.ok(doc.querySelector(".thinking.done"), "turn footer did not settle");

  assert.deepEqual(errors, [], "webview raised JS errors: " + errors.map((e) => e && e.message).join("; "));
  dom.window.close();
});

test("composer submit posts a prompt and echoes the user bubble", () => {
  const { dom, errors, posted, doc } = makeDom();
  const input = doc.getElementById("input");
  input.value = "explain this file";
  // Enter (no shift) submits
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

  const prompt = posted.find((m) => m.type === "prompt");
  assert.ok(prompt, "submit did not post a prompt");
  assert.equal(prompt.text, "explain this file");
  assert.ok(doc.querySelector(".msg.user .bubble"), "user bubble did not render");
  assert.deepEqual(errors, [], "webview raised JS errors on submit");
  dom.window.close();
});
