// The end-of-turn "Edited N files" card, rebuilt to the shape Codex ships (founder, 2026-09-24).
//
// The bug this carries a fix for: DGC recorded every edit as a pair of line counts and nothing
// else, so a file it could not diff -- a brand-new file, a binary write, a change past
// MAX_DIFF_BYTES -- arrived as 0/0, indistinguishable from "we diffed it and nothing changed".
// The header then summed those zeroes and printed "+0 −0", which reads as "nothing happened" when
// it means "there was never a diff to count". The review panel already drew that distinction; the
// end-of-turn summary never got the data to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDom, mainCss } from "./support/webview-dom.mjs";

// The panel takes an edited file's path from the DIFF it rendered, not from the tool arguments,
// so a fixture's diff has to name the same file or every case silently folds into one row.
const diffFor = (path) =>
  `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n`;

function turnThatEdited(files) {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "turn_start", turn_id: "t", prompt: "change things" });
  files.forEach((f, i) => {
    event({ type: "tool_call", call_id: `c${i}`, name: f.diff ? "edit_file" : "write_file",
            args: { path: f.path } });
    const diff = diffFor(f.path);
    event(f.diff
      ? { type: "tool_result", call_id: `c${i}`, name: "edit_file", output: diff, is_diff: true, diff }
      : { type: "tool_result", call_id: `c${i}`, name: "write_file", output: "wrote it" });
  });
  event({ type: "text_delta", text: "done" });
  event({ type: "turn_end", turn_id: "t", reason: "completed" });
  return h.doc.querySelector(".turn-summary");
}

test("a file with no diff is never reported as +0 −0", () => {
  const card = turnThatEdited([{ path: "assets/logo.png" }]);
  const row = card.querySelector(".ts-row");
  assert.equal(row.querySelector(".change-add"), null, "a file with no line count shows no +0");
  assert.equal(row.querySelector(".change-del"), null, "and no −0");
  assert.ok(row.querySelector(".ts-uncounted"), "it says so instead");
  const head = card.querySelector(".ts-head");
  assert.equal(head.querySelector(".change-add"), null,
    "and the header does not sum uncounted files into a misleading +0");
  assert.match(head.textContent, /no line count/);
});

test("a diffed file still shows its real counts", () => {
  const card = turnThatEdited([{ path: "src/a.py", diff: true }]);
  assert.equal(card.querySelector(".ts-row .change-add").textContent, "+1");
  assert.equal(card.querySelector(".ts-row .change-del").textContent, "−1");
  assert.equal(card.querySelector(".ts-head .change-add").textContent, "+1");
});

test("a mixed turn counts only what it could count", () => {
  const card = turnThatEdited([{ path: "src/a.py", diff: true }, { path: "logo.png" }]);
  assert.equal(card.querySelector(".ts-head .change-add").textContent, "+1",
    "the diffable file's numbers are still reported");
  const rows = [...card.querySelectorAll(".ts-row")];
  assert.equal(rows.length, 2);
  assert.ok(rows[1].querySelector(".ts-uncounted"), "the undiffable one is marked, not zeroed");
});

test("the path is drawn in two tones so the filename leads", () => {
  const card = turnThatEdited([{ path: "docs/APP_CONNECTORS.md", diff: true }]);
  const path = card.querySelector(".ts-row .change-path");
  assert.equal(path.querySelector(".path-dir").textContent, "docs/");
  assert.equal(path.querySelector(".path-name").textContent, "APP_CONNECTORS.md");
  assert.match(mainCss, /\.path-dir \{[^}]*color: var\(--muted\)/, "the directory is the muted half");
});

test("a bare filename gets no dimmed half", () => {
  const card = turnThatEdited([{ path: "README.md", diff: true }]);
  const path = card.querySelector(".ts-row .change-path");
  assert.equal(path.querySelector(".path-dir"), null);
  assert.equal(path.querySelector(".path-name").textContent, "README.md");
});

test("a long list collapses to three rows behind an expander", () => {
  const many = ["a", "b", "c", "d", "e"].map((n) => ({ path: `src/${n}.py`, diff: true }));
  const card = turnThatEdited(many);
  const visible = card.querySelectorAll(".ts-list > .ts-row");
  assert.equal(visible.length, 3, "three files, then an expander");
  const more = card.querySelector(".ts-more");
  assert.ok(more.hidden, "the rest start hidden");
  const expand = card.querySelector(".ts-expand");
  assert.match(expand.textContent, /Show 2 more files/);
  expand.click();
  assert.equal(more.hidden, false, "clicking reveals them");
  assert.equal(card.querySelectorAll(".ts-row").length, 5);
});

test("a short list has no expander at all", () => {
  const card = turnThatEdited([{ path: "src/a.py", diff: true }, { path: "src/b.py", diff: true }]);
  assert.equal(card.querySelector(".ts-expand"), null);
  assert.equal(card.querySelector(".ts-more"), null);
});

test("rows carry no chevron, and the actions sit in the header", () => {
  const card = turnThatEdited([{ path: "src/a.py", diff: true }]);
  assert.equal(card.querySelector(".ts-row .codicon"), null, "the whole row is the target");
  const actions = card.querySelector(".ts-head .ts-actions");
  assert.ok(actions, "Undo and Review belong to the header, not a footer bar");
  assert.ok(actions.querySelector(".ts-undo") && actions.querySelector(".ts-review"));
});

test("the totals sit under the title, not beside it", () => {
  const card = turnThatEdited([{ path: "src/a.py", diff: true }]);
  const heading = card.querySelector(".ts-head .ts-heading");
  assert.ok(heading.querySelector(".ts-title"), "title inside the heading block");
  assert.ok(heading.querySelector(".ts-totals"), "and the totals with it");
  assert.match(mainCss, /\.ts-heading \{[^}]*flex-direction: column/, "stacked, not side by side");
});

test("Undo and Review still do what they did", () => {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "turn_start", turn_id: "t", prompt: "fix it" });
  event({ type: "tool_call", call_id: "c1", name: "edit_file", args: { path: "src/a.py" } });
  const diff = diffFor("src/a.py");
  event({ type: "tool_result", call_id: "c1", name: "edit_file", output: diff, is_diff: true, diff });
  event({ type: "text_delta", text: "done" });   // the card lives inside the answer block
  event({ type: "turn_end", turn_id: "t", reason: "completed" });
  const card = h.doc.querySelector(".turn-summary");
  card.querySelector(".ts-row").click();
  assert.equal(h.posted.at(-1).type, "reviewChange");
  card.querySelector(".ts-undo").click();
  assert.equal(h.posted.at(-1).type, "undoTurn");
  assert.equal(h.posted.at(-1).prompt, "fix it");
});
