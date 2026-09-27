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

test("a pill is shorter than the line it sits on, and never wraps mid-label", () => {
  // A box that jumps when a pill appears reads as a jolt while typing -- and two pills on
  // consecutive wrapped lines must not touch. Both need the same thing: the pill has to be SHORTER
  // than the line box. This used to assert that the pill shares the composer's line-height, which
  // is the opposite: matching it made the pill 18.9px against an 18.85px line box, so a line
  // holding one was taller than a line of plain text AND pills on adjacent lines sat 1px apart.
  // jsdom has no layout, so the real check is the measured one in composer-pills-live.test.mjs;
  // this pins the relationship in the source so the two values cannot drift back together.
  const pillLine = /\.composer-pill \{[^}]*\/([\d.]+) var\(--sans\)/.exec(mainCss);
  const inputLine = /#input \{[^}]*\/([\d.]+) var\(--sans\)/.exec(mainCss);
  assert.ok(pillLine && inputLine, "both line-heights are declared");
  assert.ok(Number(pillLine[1]) < Number(inputLine[1]),
    `pill line-height ${pillLine[1]} must be below the composer's ${inputLine?.[1]}`);
  assert.match(mainCss, /\.composer-pill \{[^}]*white-space: nowrap/,
    "and never wraps mid-label");
});

test("high contrast gets a visible pill border", () => {
  // A pill carries no border of its own any more (Codex's treatment: a mark and the name in the
  // accent colour), so forced colours must supply the WHOLE border, not recolour one.
  assert.match(mainCss, /forced-colors: active\) \{ \.composer-pill \{ border: 1px solid CanvasText/);
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

test("a pasted link fetches nothing: the disclosure waits for the send", () => {
  // The transcript's trade is that the icon service learns the hosts you SENT. A draft is not a
  // send. Building the pill used to set img.src on a DETACHED element -- before the insertion was
  // even attempted, so it fired on the path where the insertion throws and no pill renders -- which
  // moved the boundary to "when you paste": paste an internal wiki or Jira URL, think better of it,
  // delete the pill, never send, and the host has already left the machine.
  const h = panelWithSkill();
  pasteInto(h, "https://example.test/secret-path?token=abc123");
  assert.ok(h.doc.querySelector("#input .composer-pill.pill-link"), "the pill is still drawn");
  assert.equal(h.doc.querySelector("#input img.link-favicon"), null,
    "and it costs no request for a URL the user may yet delete");
  assert.equal(h.doc.querySelectorAll("img.link-favicon").length, 0,
    "nowhere else either -- the element is built detached, so a stray one would not be in #input");
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

// ---- the attachment row, and what happens when a pill cannot survive ---------------------------

test("a pill is not repeated as a chip underneath", () => {
  const h = panelWithSkill();
  pickSkill(h);
  assert.equal(h.doc.querySelectorAll("#input .composer-pill").length, 1);
  assert.equal(h.doc.querySelectorAll("#attachments .invocation-chip").length, 0,
    "the row carries what is NOT already visible inline");
});

test("a selection with no pill still gets its chip", () => {
  // The condition for hiding a chip is the pill's existence, never the kind. A skill restored from
  // a draft, or added from the + menu, has no pill -- hiding its chip would leave the user with a
  // selection they can neither see nor remove, which is worse than showing it twice.
  const h = panelWithSkill();
  pickSkill(h);
  const input = h.doc.getElementById("input");
  // Assigning the value rebuilds the composer from serialized text, and a pill serialises to "",
  // so the pill goes. The SELECTION survives in attachments, and the row must show it again.
  input.value = "still drafting";
  // Route through onInput, which is where reconcilePills runs. Without it this test passes even
  // when setComposerValue forgets to retire the fromPill flag, because nothing re-reads the pair.
  input.dispatchEvent(new h.dom.window.Event("input", { bubbles: true }));
  assert.equal(h.doc.querySelectorAll("#input .composer-pill").length, 0, "the pill is gone");
  assert.equal(h.doc.querySelectorAll("#attachments .invocation-chip").length, 1,
    "so the row takes it back rather than losing it silently");
});

test("what the model receives is unchanged either way", () => {
  const h = panelWithSkill();
  const input = pickSkill(h);
  const before = input.value;
  input.value = before;                       // round-trip through the serializer
  assert.equal(input.value, "Review  after", "the prose is stable across a rebuild");
});
