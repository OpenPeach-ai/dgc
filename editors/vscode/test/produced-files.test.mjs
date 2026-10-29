// A file the model made, shown as a chip you can click.
//
// A user's case was "record a video and show me". DGC could show an IMAGE — a thumbnail
// inside a collapsed tool card — and nothing else. Codex shows a chip; clicking it opens the file
// in the editor. Neither Codex nor Claude Code's extension offers a download, because the file is
// already on the user's own disk.
//
// The property that matters most here: the event carries a PATH and the panel opens it through
// the extension host. Nothing reads bytes in the webview, so a 300 MB recording costs exactly what
// a one-line report costs, and the 4 MiB protocol frame is never in play.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

function turnWith(items) {
  const harness = makeDom();
  const event = (data) => harness.send({ type: "event", event: data });
  event({ type: "ready", capabilities: { produced_files: true } });
  event({ type: "turn_start", turn_id: "t", prompt: "record it" });
  event({ type: "tool_call", call_id: "c1", name: "bash", args: { command: "ffmpeg ..." } });
  event({ type: "tool_result", call_id: "c1", name: "bash", is_error: false, output: "done" });
  event({ type: "files_ready", call_id: "c1", items });
  event({ type: "turn_end", reason: "completed" });
  return harness;
}

test("a produced file becomes a chip in the transcript", () => {
  const { doc, errors } = turnWith([{ name: "demo.mp4", rel: "out/demo.mp4", bytes: 314_572_800 }]);
  const chip = doc.querySelector(".made-files .chip.made-file");
  assert.ok(chip, "the file should appear as a chip");
  assert.match(chip.textContent, /demo\.mp4/);
  assert.match(chip.textContent, /300 MB/, "its size should be readable at a glance");
  assert.deepEqual(errors, []);
});

test("clicking it asks the EXTENSION to open it, by path", () => {
  const { doc, posted } = turnWith([{ name: "demo.mp4", rel: "out/demo.mp4", bytes: 10 }]);
  doc.querySelector(".chip.made-file").click();
  const sent = posted.filter((m) => m.type === "openFile").at(-1);
  assert.ok(sent, "a click should ask the host to open the file");
  assert.equal(sent.path, "out/demo.mp4");
  // The webview never navigates or fetches on its own; the host re-validates the path.
  assert.equal(posted.some((m) => m.type === "openExternal"), false);
});

test("no bytes cross the protocol, at any size", () => {
  const { doc } = turnWith([{ name: "huge.mov", rel: "out/huge.mov", bytes: 8_000_000_000 }]);
  const chip = doc.querySelector(".chip.made-file");
  assert.ok(chip, "an 8 GB file chips exactly like a small one");
  assert.equal(chip.querySelector("img"), null, "nothing is embedded in the chip");
  assert.equal(doc.querySelector(".made-files img, .made-files video"), null);
});

test("the chip wears the same kind mark a file link wears", () => {
  const { doc } = turnWith([
    { name: "clamp.py", rel: "src/clamp.py", bytes: 120 },
    { name: "notes.md", rel: "docs/notes.md", bytes: 40 },
  ]);
  const kinds = [...doc.querySelectorAll(".chip.made-file")].map((c) => c.dataset.fileKind);
  assert.deepEqual(kinds, ["python", "doc"],
    "a produced .py and a mentioned .py should read as the same kind of thing");
});

test("a caption rides along on the chip, after the name, without crowding it", () => {
  // Reported 28 Oct: what the model said a file IS was only in the hover label, so nobody saw it.
  const { doc } = turnWith([
    { name: "demo.mp4", rel: "out/demo.mp4", bytes: 10, caption: "the recording" },
  ]);
  const chip = doc.querySelector(".chip.made-file");
  assert.match(chip.getAttribute("aria-label"), /demo\.mp4 — the recording/);
  const parts = [...chip.children].map((c) => c.className);
  assert.deepEqual(parts, ["chip-label", "chip-size", "chip-caption"], "name first, the caption last");
  assert.equal(chip.querySelector(".chip-caption").textContent, "the recording");
  // The chip stays one line: the caption is the part that gives way.
  const rule = /\.chip\.made-file \.chip-caption\s*\{([^}]*)\}/.exec(mainCss);
  assert.ok(rule, "the caption has its own rule");
  assert.match(rule[1], /text-overflow:\s*ellipsis/);
  assert.match(rule[1], /white-space:\s*nowrap/);
});

test("an item with no path is ignored rather than rendered as a dead chip", () => {
  const { doc, errors } = turnWith([{ name: "ghost.mp4" }, { name: "ok.txt", rel: "ok.txt", bytes: 1 }]);
  const chips = [...doc.querySelectorAll(".chip.made-file")];
  assert.equal(chips.length, 1, "a chip that could not open anything must not be drawn");
  assert.deepEqual(errors, []);
});

test("an empty event renders nothing at all", () => {
  const { doc, errors } = turnWith([]);
  assert.equal(doc.querySelector(".made-files"), null, "no empty list, no stray heading");
  assert.deepEqual(errors, []);
});

test("one step cannot flood the transcript", () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ name: `f${i}.txt`, rel: `f${i}.txt`, bytes: 1 }));
  const { doc } = turnWith(many);
  assert.equal(doc.querySelectorAll(".chip.made-file").length, 8,
    "the panel caps what it draws even if a backend sends more");
});

test("the name is escaped, not interpreted", () => {
  const { doc, errors } = turnWith([
    { name: '<img src=x onerror="alert(1)">.mp4', rel: "out/x.mp4", bytes: 1 },
  ]);
  const chip = doc.querySelector(".chip.made-file");
  assert.equal(chip.querySelector("img"), null, "a crafted file name must never become an element");
  assert.match(chip.textContent, /<img src=x/, "it reads back as the text it is");
  assert.deepEqual(errors, []);
});


test("a chip is actually styled, not a bare browser button", () => {
  // It shipped as a WHITE BOX in 0.29.0. `.chip` is not a base class — the only other chip rule is
  // scoped to `.user .bubble .prompt-att.chip` — so a <button class="chip made-file"> outside a
  // prompt bubble kept the user agent's default button appearance. jsdom does not cascade, so no
  // DOM assertion could see it; this reads the stylesheet.
  const rule = /\.chip\.made-file\s*\{([^}]*)\}/.exec(mainCss);
  assert.ok(rule, ".chip.made-file must have its own rule");
  for (const prop of ["background", "border", "color", "padding"]) {
    assert.match(rule[1], new RegExp(`(^|[;\\s])${prop}\\s*:`),
      `.chip.made-file must set ${prop} itself — inheriting means the browser's default button`);
  }
  assert.match(mainCss, /\.chip\.made-file:focus-visible/,
    "a chip is a button; a keyboard user must be able to see which one is focused");
});

// An image the model shows on purpose is SHOWN: a picture tile with its caption, as a viewed image is, not a file
// name (reported 28 Oct). The picture comes from the extension host by path, never from the event.
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
function shownImage(reply, items = [{ name: "login.png", rel: "out/login.png", bytes: 2048, caption: "the login page" }]) {
  const harness = turnWith(items);
  const asks = harness.posted.filter((m) => m.type === "fileThumb");
  if (reply !== undefined) for (const ask of asks) harness.send({ type: "fileThumb", requestId: ask.requestId, src: reply });
  return { ...harness, asks };
}

test("a shown image asks the host for its picture by path, and waits in a tile with its caption", () => {
  const { doc, asks, errors } = shownImage(undefined);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].path, "out/login.png", "the workspace path the event named; the host checks it");
  assert.match(asks[0].requestId, /^[A-Za-z0-9_.:-]{1,128}$/, "an id the host accepts");
  const figure = doc.querySelector(".made-files .made-image");
  assert.ok(figure.querySelector(".image-tile.skeleton"), "a waiting tile, not an empty gap");
  assert.equal(figure.querySelector("figcaption").textContent, "the login page");
  assert.equal(doc.querySelector(".chip.made-file"), null);
  assert.deepEqual(errors, []);
});

test("the picture arrives in the tile; clicking it opens the image viewer, whose Open opens the file", () => {
  const { doc, posted, errors } = shownImage(PNG);
  const tile = doc.querySelector(".made-image .image-chip");
  assert.ok(tile, "the picture tile replaces the waiting one");
  assert.equal(tile.querySelector("img").getAttribute("src"), PNG);
  assert.equal(doc.querySelector(".made-image .skeleton"), null);
  assert.equal(doc.querySelector(".made-image figcaption").textContent, "the login page", "the caption stays under it");
  assert.match(tile.getAttribute("aria-label"), /login\.png: the login page/);
  tile.click();
  const viewer = doc.getElementById("image-viewer");
  assert.ok(viewer && !viewer.hidden, "the image viewer opens");
  const open = viewer.querySelector('[aria-label="Open file"]');
  assert.equal(open.hidden, false, "a shown file can always be opened");
  open.click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), { type: "openFile", path: "out/login.png" });
  assert.deepEqual(errors, []);
});

test("an image the host won't read stays the plain chip, caption and all", () => {
  for (const reply of ["", "data:text/html;base64,PHNjcmlwdD4=", "javascript:alert(1)", 42]) {
    const { doc, errors } = shownImage(reply);
    assert.equal(doc.querySelector(".made-image"), null, `no tile for ${JSON.stringify(reply)}`);
    const chip = doc.querySelector(".chip.made-file");
    assert.ok(chip, "the file is never lost");
    assert.equal(chip.querySelector(".chip-caption").textContent, "the login page");
    assert.equal(doc.querySelector(".made-files img"), null);
    assert.deepEqual(errors, []);
  }
});

test("only raster pictures are asked for; an SVG, a video or a PDF stays a chip", () => {
  const { doc, asks } = shownImage(PNG, [
    { name: "logo.svg", rel: "logo.svg", bytes: 10 },
    { name: "demo.mp4", rel: "demo.mp4", bytes: 10 },
    { name: "report.pdf", rel: "report.pdf", bytes: 10 },
    { name: "a.JPG", rel: "a.JPG", bytes: 10 },
  ]);
  assert.deepEqual(asks.map((a) => a.path), ["a.JPG"]);
  assert.equal(doc.querySelectorAll(".chip.made-file").length, 3);
  assert.equal(doc.querySelectorAll(".made-image .image-chip").length, 1);
});

test("several shown images page through the viewer together", () => {
  const { doc } = shownImage(PNG, [
    { name: "before.png", rel: "before.png", bytes: 10, caption: "before" },
    { name: "after.webp", rel: "after.webp", bytes: 10, caption: "after" },
  ]);
  const tiles = [...doc.querySelectorAll(".made-image .image-chip")];
  assert.equal(tiles.length, 2);
  tiles[0].click();
  const viewer = doc.getElementById("image-viewer");
  assert.match(viewer.querySelector(".iv-pos").textContent, /1\s*(of|\/)\s*2/);
});

test("a late answer for a tile that has gone does nothing", () => {
  const harness = turnWith([{ name: "x.png", rel: "x.png", bytes: 1 }]);
  const ask = harness.posted.find((m) => m.type === "fileThumb");
  harness.doc.querySelector(".made-image").remove();
  harness.send({ type: "fileThumb", requestId: ask.requestId, src: PNG });
  harness.send({ type: "fileThumb", requestId: ask.requestId, src: PNG });
  harness.send({ type: "fileThumb", requestId: "never-asked", src: PNG });
  assert.equal(harness.doc.querySelector(".made-files img"), null);
  assert.deepEqual(harness.errors, []);
});
