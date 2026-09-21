// The "@" file picker in the composer.
//
// The workspace file list is fetched lazily, the first time an "@" is typed. That created a
// papercut nobody would report as a bug: you type "@", nothing happens, and the picker only
// appears once you type another character -- because showPop([]) calls hidePop(), hidePop clears
// popMode, and the retry when the list arrived was guarded on popMode === "@".
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

function panel() {
  const { doc, send, dom, posted } = makeDom();
  send({ type: "event", event: { type: "ready", capabilities: {}, model: "m", mode: "default",
        think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [],
        custom_commands: [], goal: { text: "", status: "none" }, context_size: 1 } });
  return { doc, dom, posted, send };
}

const FILES = [
  { label: "supplier-review.docx", path: "/ws/supplier-review.docx", uri: "file:///ws/supplier-review.docx",
    relative_path: "supplier-review.docx", workspace: "ws" },
  { label: "README.md", path: "/ws/README.md", uri: "file:///ws/README.md",
    relative_path: "README.md", workspace: "ws" },
];

function typeAt(p, text = "@") {
  const input = p.doc.getElementById("input");
  input.value = text;
  input.selectionStart = input.selectionEnd = text.length;
  input.dispatchEvent(new p.dom.window.Event("input", { bubbles: true }));
  return input;
}

const popVisible = (p) => p.doc.getElementById("pop").style.display === "block";

test("the first @ asks for the workspace file list", () => {
  const p = panel();
  typeAt(p);
  assert.ok(p.posted.some((m) => m?.type === "reqFiles"), "it asks the extension for candidates");
});

test("the picker opens when that list arrives, without another keystroke", () => {
  const p = panel();
  typeAt(p);
  assert.equal(popVisible(p), false, "nothing to show yet");
  p.send({ type: "files", files: FILES });
  assert.equal(popVisible(p), true, "the list arrived, so the picker opens itself");
  assert.match(p.doc.getElementById("pop").textContent, /supplier-review\.docx/);
});

test("a later @ opens straight away", () => {
  const p = panel();
  typeAt(p);
  p.send({ type: "files", files: FILES });
  typeAt(p, "look at @READ");
  assert.equal(popVisible(p), true);
  assert.match(p.doc.getElementById("pop").textContent, /README\.md/);
  assert.doesNotMatch(p.doc.getElementById("pop").textContent, /supplier-review/, "filtered");
});

test("a late list does not pop open under a caret that has moved on", () => {
  // onInput re-reads the caret, so the reopen is only ever what the caret currently justifies.
  const p = panel();
  typeAt(p);
  typeAt(p, "never mind");          // the "@" is gone before the list lands
  p.send({ type: "files", files: FILES });
  assert.equal(popVisible(p), false);
});

test("choosing a file stages it as a file_mention and clears the token", () => {
  const p = panel();
  typeAt(p, "read @supplier");
  p.send({ type: "files", files: FILES });
  p.doc.querySelector("#pop .pi").dispatchEvent(new p.dom.window.MouseEvent("click", { bubbles: true }));
  const input = p.doc.getElementById("input");
  assert.doesNotMatch(input.value, /@supplier/, "the typed token is replaced by the chip");
  assert.match(p.doc.getElementById("attachments").textContent, /supplier-review\.docx/,
               "and the file shows as an attachment chip");
});
