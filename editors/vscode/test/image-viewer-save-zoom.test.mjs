// Two gaps in the image viewer the founder asked to close (2026-09-24): you could cycle and flip
// between fit/actual, but you could not KEEP a picture, and you could not meet it halfway.
//
// Worth recording what was already there, because the first survey got it wrong: images the MODEL
// viewed have always reached the viewer. `openImageViewer` has one call site, but it sits inside
// `imageChip`, which is called both for composer attachments and for a tool's returned images.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function viewerOpenOnToolImage() {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "ready", capabilities: {} });
  event({ type: "turn_start", turn_id: "t", prompt: "look at this" });
  event({ type: "tool_call", call_id: "c1", name: "read_file", args: { path: "shot.png" } });
  event({ type: "tool_result", call_id: "c1", name: "read_file", output: "ok" });
  // `images` carries the bytes. `items` is optional metadata, and a partial item is REJECTED
  // whole (it needs ref/mime/source/host and sane dimensions), taking its image's slot with it --
  // so a fixture either supplies a complete item or none, and the caption names the picture.
  event({ type: "tool_images", call_id: "c1", caption: "shot.png", images: [PNG] });
  // The chip row is drawn when the card is OPENED, so let the toggle do it -- setting the class
  // first only makes the click close the card again.
  h.doc.querySelector(".tool .tool-toggle").click();
  h.doc.querySelector(".image-chip").click();
  return h;
}

test("a tool's image opens the viewer, which is where it already went", () => {
  const h = viewerOpenOnToolImage();
  assert.ok(h.doc.getElementById("image-viewer"), "the model's images reach the same viewer");
  assert.deepEqual(h.errors, []);
});

test("saving an image asks the host, because a webview cannot write files", () => {
  const h = viewerOpenOnToolImage();
  const save = h.doc.querySelector("#image-viewer .iv-save");
  assert.ok(save, "the viewer offers a save control");
  save.click();
  const msg = h.posted.at(-1);
  assert.equal(msg.type, "saveImage");
  assert.equal(msg.name, "shot.png");
  assert.equal(msg.data, PNG, "the bytes it is showing, not a path it guessed");
});

test("the zoom shows a percentage and steps both ways", () => {
  const h = viewerOpenOnToolImage();
  const viewer = h.doc.getElementById("image-viewer");
  const level = viewer.querySelector(".iv-level");
  assert.equal(level.value, "100%", "it starts where the picture is");
  viewer.querySelector(".iv-in").click();
  assert.equal(level.value, "125%");
  viewer.querySelector(".iv-out").click();
  viewer.querySelector(".iv-out").click();
  assert.equal(level.value, "85%", "and back down past where it started");
});

test("zoom stops at both ends instead of running away", () => {
  const h = viewerOpenOnToolImage();
  const viewer = h.doc.getElementById("image-viewer");
  const level = () => viewer.querySelector(".iv-level").value;
  // The KEY, not the button: a disabled button cannot be clicked, so clicking it can never prove
  // the limit is enforced rather than merely hidden. The keyboard reaches the same code with no
  // such guard, which is exactly why the limit has to live in the stepping and not only in the
  // control's disabled state.
  const press = (key) => viewer.dispatchEvent(
    new h.dom.window.KeyboardEvent("keydown", { key, bubbles: true }));
  for (let i = 0; i < 20; i++) press("+");
  assert.equal(level(), "400%", "the top step holds however many times you press past it");
  assert.equal(viewer.querySelector(".iv-in").disabled, true, "and the control says so");
  for (let i = 0; i < 40; i++) press("-");
  assert.equal(level(), "25%", "and so does the bottom");
  assert.equal(viewer.querySelector(".iv-out").disabled, true);
});

test("the CSS actually scales the picture", () => {
  // An attribute test cannot see a cascade: the class and the variable are useless unless a rule
  // consumes them.
  assert.match(mainCss, /#image-viewer\.scaled \.iv-stage img \{[^}]*var\(--iv-scale/,
    "the scaled state must drive a width from --iv-scale");
  assert.match(mainCss, /#image-viewer\.scaled \.iv-stage \{[^}]*overflow: auto/,
    "and the stage must scroll once the picture is larger than it");
});
