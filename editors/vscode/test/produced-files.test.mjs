// A file the model made, shown as a chip you can click.
//
// The founder's case was "record a video and show me". DGC could show an IMAGE — a thumbnail
// inside a collapsed tool card — and nothing else. Codex shows a chip; clicking it opens the file
// in the editor. Neither Codex nor Claude Code's extension offers a download, because the file is
// already on the user's own disk.
//
// The property that matters most here: the event carries a PATH and the panel opens it through
// the extension host. Nothing reads bytes in the webview, so a 300 MB recording costs exactly what
// a one-line report costs, and the 4 MiB protocol frame is never in play.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom } from "./support/webview-dom.mjs";

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

test("a caption rides along without crowding the name", () => {
  const { doc } = turnWith([
    { name: "demo.mp4", rel: "out/demo.mp4", bytes: 10, caption: "the recording" },
  ]);
  const chip = doc.querySelector(".chip.made-file");
  assert.match(chip.getAttribute("aria-label"), /demo\.mp4 — the recording/);
  assert.equal(chip.textContent.includes("the recording"), false,
    "the caption belongs in the label and the hover, not in a chip that has to stay one line");
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
