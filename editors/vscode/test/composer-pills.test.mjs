// A picked skill, template or @file becomes a pill where it was typed.
//
// The rule that shapes everything: a pill contributes NOTHING to prompt.text. Its payload already
// travels in `skills`, `templates` or `context`, and duplicating it into the prose would send the
// model the same thing twice. So `data-pill` holds the pill's wire text and for these kinds it is
// the empty string -- the attribute's PRESENCE marks a pill, its value is what the model reads.
// That is why the existing assertions on "Review  after" pass unchanged; if they had needed
// editing, the serializer would be wrong.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

function panelWithSkill() {
  const h = makeDom();
  h.send({ type: "event", event: { type: "ready", skills: ["fixture"], custom_commands: [] } });
  return h;
}

// The picker only opens on a token AT the caret, so the caret goes where the token ends -- the
// same shape the existing skill test uses.
function pickSkill(h, typed = "Review $fixture after", caret = 15) {
  const input = h.doc.getElementById("input");
  input.value = typed;
  input.selectionStart = input.selectionEnd = caret;
  input.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
  input.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
  return input;
}

test("a picked skill becomes a visible pill in the composer", () => {
  const h = panelWithSkill();
  pickSkill(h);
  const pill = h.doc.querySelector("#input .composer-pill");
  assert.ok(pill, "the skill is shown where it was typed, not only in a row underneath");
  assert.equal(pill.getAttribute("contenteditable"), "false", "the caret treats it as one object");
  assert.equal(pill.textContent, "fixture");
});

test("a pill sends nothing of itself to the model", () => {
  const h = panelWithSkill();
  const input = pickSkill(h);
  assert.equal(input.value.includes("fixture"), false,
    "the skill travels in `skills`; putting it in the prose too would send it twice");
  assert.equal(input.value, "Review  after", "exactly what the textarea produced");
});

test("the pill is marked by the attribute, not by a truthy value", () => {
  // The placeholder IS the empty string here. Testing dataset.pill for truthiness would skip the
  // atomic branch and serialize the pill's LABEL into the prompt.
  const h = panelWithSkill();
  pickSkill(h);
  const pill = h.doc.querySelector("#input .composer-pill");
  assert.equal(pill.getAttribute("data-pill"), "", "an empty wire text is the point");
  assert.ok(pill.hasAttribute("data-pill"));
});

test("Backspace removes a whole pill, not one character of its label", () => {
  const h = panelWithSkill();
  const input = pickSkill(h);
  const pill = h.doc.querySelector("#input .composer-pill");
  const sel = h.dom.window.getSelection();
  const range = h.doc.createRange();
  range.setStartAfter(pill); range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
  input.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  assert.equal(h.doc.querySelector("#input .composer-pill"), null, "the pill goes whole");
  assert.equal(input.value.includes("fixture"), false);
  assert.deepEqual(h.errors, []);
});

test("removing a pill gives back what it stood for", () => {
  const h = panelWithSkill();
  const input = pickSkill(h);
  const pill = h.doc.querySelector("#input .composer-pill");
  const sel = h.dom.window.getSelection();
  const range = h.doc.createRange();
  range.setStartAfter(pill); range.collapse(true);
  sel.removeAllRanges(); sel.addRange(range);
  input.dispatchEvent(new h.dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true }));
  const sent = [...h.doc.querySelectorAll("#attachments .chip")].map((c) => c.textContent);
  assert.equal(sent.some((t) => t.includes("fixture")), false,
    "a selection must not outlive the pill that showed it");
});

test("a pill does not make its line taller than a line of text", () => {
  // A box that jumps when a pill appears reads as a jolt while typing.
  assert.match(mainCss, /\.composer-pill \{[^}]*\/1\.45/,
    "the pill shares the composer's line-height");
  assert.match(mainCss, /\.composer-pill \{[^}]*white-space: nowrap/,
    "and never wraps mid-label");
});

test("high contrast gets a visible pill border", () => {
  assert.match(mainCss, /forced-colors: active\) \{ \.composer-pill \{ border-color: CanvasText/);
});

// ---- link pills ------------------------------------------------------------------------------
// Pasting a link shows it with its favicon, which is what Codex does. The difference from a skill
// pill is the whole point: this one's wire text IS the URL, so the model receives exactly the
// characters that were pasted. The pill SHOWS the link; it does not stand in for it.

function pasteInto(h, text) {
  const input = h.doc.getElementById("input");
  const event = new h.dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { items: [], getData: () => text } });
  input.dispatchEvent(event);
  return { input, event };
}

test("a pasted link becomes a pill carrying the host", () => {
  const h = panelWithSkill();
  const { input } = pasteInto(h, "https://example.test/docs/page?token=secret");
  const pill = h.doc.querySelector("#input .composer-pill.pill-link");
  assert.ok(pill, "the link is shown as a pill");
  assert.match(pill.textContent, /example\.test/, "the host is what a reader needs");
  assert.equal(pill.title, "https://example.test/docs/page?token=secret", "the whole URL on hover");
  assert.equal(input.value, "https://example.test/docs/page?token=secret",
    "and the model receives exactly what was pasted, not a shortened form");
});

test("the favicon is requested for the ORIGIN only", () => {
  // A URL can carry a token in its path or query. The icon service learns the host and nothing
  // else -- the same trade the transcript's link favicons already make.
  const h = panelWithSkill();
  pasteInto(h, "https://example.test/secret-path?token=abc123");
  const img = h.doc.querySelector("#input .composer-pill.pill-link img.link-favicon");
  if (img) {
    assert.equal(img.src.includes("secret-path"), false, "the path must not leave the machine");
    assert.equal(img.src.includes("abc123"), false, "nor the query");
    assert.equal(img.referrerPolicy, "no-referrer");
  }
});

test("pasting prose that contains a link stays prose", () => {
  const h = panelWithSkill();
  const { input } = pasteInto(h, "see https://example.test for more");
  assert.equal(h.doc.querySelector("#input .composer-pill.pill-link"), null,
    "rewriting the middle of a pasted paragraph would be presumptuous");
  assert.equal(input.value, "see https://example.test for more");
});

test("a pasted link is still one paste to undo", () => {
  const h = panelWithSkill();
  const { event } = pasteInto(h, "https://example.test/x");
  assert.equal(event.defaultPrevented, true, "the browser never inserts it itself");
});
