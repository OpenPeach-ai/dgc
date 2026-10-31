import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDom } from "./support/webview-dom.mjs";

test("numbered continuation keeps indentation and punctuation, and leaves ordinary lines alone", () => {
  const code = readFileSync(new URL("../media/numbered-list.js", import.meta.url), "utf8");
  const scope = {};
  new Function("globalThis", code)(scope);
  const next = scope.DgcNumberedList.continuation;
  assert.equal(next("1. First point", 14, 14), "\n2. ");
  assert.equal(next("  9) Another", 12, 12), "\n  10) ");
  assert.equal(next("1. First\n2. Second", 18, 18), "\n3. ");
  assert.equal(next("A plain line", 12, 12), "\n");
  assert.equal(next("1. ", 3, 3), "\n", "an empty item does not grow an endless numbered list");
  assert.equal(next("1. First", 3, 8), "\n", "a selection is replaced with a plain break");
});

test("Work Shift+Enter continues numbered prompts as one composer edit", () => {
  const { doc, dom, errors } = makeDom();
  const input = doc.getElementById("input");
  input.value = "1. First point";
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(input.value, "1. First point\n2. ");
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  assert.equal(input.value, "1. First point\n2. \n", "an empty item gets an ordinary new line");
  assert.deepEqual(errors, []);
});
