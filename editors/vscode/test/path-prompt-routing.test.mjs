import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, panelSrc } from "./support/webview-dom.mjs";

function submit(text) {
  const h = makeDom();
  h.send({ type: "event", event: { type: "ready", session_id: "chat-a", capabilities: {} } });
  const input = h.doc.getElementById("input");
  input.value = text;
  input.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  return h;
}

test("an absolute project path at the start of a prompt is sent as prose", () => {
  const text = "/home/fungigb10/pregnancy-tracker , this is the directory that runs bearbloom";
  const h = submit(text);
  assert.equal(h.posted.some((message) => message.type === "slashText"), false);
  assert.equal(h.posted.findLast((message) => message.type === "prompt")?.text, text);
  assert.deepEqual(h.errors, []);
});

test("a real slash command keeps the command route", () => {
  const h = submit("/model gpt-6");
  assert.equal(h.posted.findLast((message) => message.type === "slashText")?.text, "/model gpt-6");
  assert.equal(h.posted.some((message) => message.type === "prompt"), false);
});

test("path prompts retain the extension's live editor context", () => {
  assert.match(panelSrc,
    /workflow \|\| \(text && !isSlashCommandText\(text\)\) \? this\.editorContext\(\) : \[\]/);
});
