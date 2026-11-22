// The end-of-turn "Edited N files" card, rebuilt (reported 2026-09-24).
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

// The user's changed-files look (their reference card, 7 Nov): files grouped by folder, each folder a row with its own
// counts that folds. A long turn starts with its folders folded (three rows and "Show N more" did that job before).
test("files are grouped by folder, each folder with its counts, folding both ways", () => {
  const card = turnThatEdited([{ path: "README.md", diff: true }, { path: "src/a.py", diff: true }, { path: "src/b.py", diff: true },
                               { path: "docs/guide.md", diff: true }]);
  const folders = [...card.querySelectorAll(".ts-folder-row")];
  assert.deepEqual(folders.map((f) => f.querySelector(".ts-folder-name").textContent), ["src", "docs"], "in the order their first file came");
  assert.equal(folders[0].querySelector(".change-add").textContent, "+2", "a folder's counts add up its files");
  assert.equal(folders[0].getAttribute("aria-expanded"), "true", "a short turn starts open");
  const srcFiles = folders[0].nextElementSibling;
  assert.deepEqual([...srcFiles.querySelectorAll(".ts-row .path-name")].map((n) => n.textContent), ["a.py", "b.py"]);
  assert.equal(srcFiles.querySelector(".path-dir"), null, "inside its folder a file is just its name");
  assert.equal(card.querySelector(".ts-list > .ts-row .path-name").textContent, "README.md", "a top-level file has no folder row");
  folders[0].click();
  assert.equal(srcFiles.hidden, true, "a folder folds");
  assert.equal(folders[0].getAttribute("aria-expanded"), "false");
  folders[0].click();
  assert.equal(srcFiles.hidden, false, "and opens again: a one-way control is a trap");
});

test("a long turn starts with its folders folded, and the whole card folds from its chevron", () => {
  const many = ["a", "b", "c", "d", "e", "f", "g"].map((n) => ({ path: `src/${n}.py`, diff: true }));
  const card = turnThatEdited(many);
  const folder = card.querySelector(".ts-folder-row");
  assert.equal(folder.getAttribute("aria-expanded"), "false", "seven files: folded to start, the header stays near");
  assert.equal(folder.nextElementSibling.hidden, true);
  assert.equal(folder.querySelector(".change-add").textContent, "+7", "its counts still say what changed");
  folder.click();
  assert.equal(card.querySelectorAll(".ts-row").length, 7);
  const fold = card.querySelector(".ts-head .ts-fold"), list = card.querySelector(".ts-list");
  assert.equal(fold.getAttribute("aria-controls"), list.id);
  fold.click();
  assert.equal(list.hidden, true, "the card folds to its header");
  assert.equal(fold.getAttribute("aria-expanded"), "false");
  assert.equal(fold.getAttribute("aria-label"), "Show the changed files", "it says what it does next");
  fold.click();
  assert.equal(list.hidden, false);
});

// A live run (22 Nov): a command made a whole tree of new files (a virtual environment) and the card drew one row per
// folder of it, about 400, screen after screen under the turn. Past eight folders the card groups by top folder, and a
// folder whose files have no line count says how many files it holds.
test("a turn whose files fall in many folders is grouped by top folder, each saying how many files it holds", () => {
  const tree = Array.from({ length: 30 }, (_, i) => ({ path: `.venv/lib/p${Math.floor(i / 2)}/m${i}.py` }));
  const card = turnThatEdited([...tree, { path: "src/a.py", diff: true }, { path: "README.md", diff: true }]);
  const folders = [...card.querySelectorAll(".ts-folder-row")];
  assert.deepEqual(folders.map((f) => f.querySelector(".ts-folder-name").textContent), [".venv", "src"], "one row per top folder, not 15");
  assert.equal(folders[0].querySelector(".ts-uncounted").textContent, "30 files", "a folder with no line counts says how many files");
  assert.equal(folders[1].querySelector(".change-add").textContent, "+1", "a counted folder keeps its counts");
  assert.equal(folders[1].querySelector(".ts-uncounted"), null, "and nothing else");
  assert.equal(folders[0].getAttribute("aria-expanded"), "false", "folded, as any long turn starts");
  folders[0].click();
  const first = folders[0].nextElementSibling.querySelector(".ts-row");
  assert.equal(first.querySelector(".path-dir").textContent, "lib/p0/", "inside the top folder, the rest of its path, dimmed");
  assert.equal(first.querySelector(".path-name").textContent, "m0.py");
  assert.equal(card.querySelector(".ts-list > .ts-row .path-name").textContent, "README.md", "a top-level file is still its own row");
});

test("a few folders are still each their own row", () => {
  const card = turnThatEdited([{ path: "app/x/1.py", diff: true }, { path: "app/y/2.py", diff: true }, { path: "lib/3.py" }]);
  assert.deepEqual([...card.querySelectorAll(".ts-folder-name")].map((n) => n.textContent), ["app/x", "app/y", "lib"]);
  assert.equal(card.querySelectorAll(".ts-folder-row")[2].querySelector(".ts-uncounted").textContent, "1 file");
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

test("the totals sit beside the title, and Open diff is the last action", () => {
  const card = turnThatEdited([{ path: "src/a.py", diff: true }]);
  const heading = card.querySelector(".ts-head .ts-heading");
  assert.ok(heading.querySelector(".ts-title"), "title inside the heading block");
  assert.ok(heading.querySelector(".ts-totals"), "and the totals with it");
  assert.match(mainCss, /\.ts-heading \{[^}]*flex-direction: row/, "side by side, as in the user's reference card");
  const actions = [...card.querySelectorAll(".ts-actions > button")].map((b) => b.className.split(" ").find((c) => c.startsWith("ts-")));
  assert.deepEqual(actions, ["ts-undo", "ts-fold", "ts-review"]);
  assert.equal(card.querySelector(".ts-review").textContent.trim(), "Open diff");
  assert.equal(card.querySelector(".ts-folder-row"), null, "one file is one row");
  assert.equal(card.querySelector(".ts-row .path-dir").textContent, "src/", "with its folder dimmed before its name");
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

// Only a file-editing tool's diff is one of this turn's edits (found on a real ERP session on .111,
// 2026-10-22). A shell that prints `git diff` shows changes made elsewhere; listing them offered an
// Undo for files this turn never touched.
function turnWithResults(results) {
  const h = makeDom();
  const event = (d) => h.send({ type: "event", event: d });
  event({ type: "turn_start", turn_id: "t", prompt: "look at things" });
  results.forEach((r, i) => {
    event({ type: "tool_call", call_id: `r${i}`, name: r.name, args: {} });
    const diff = diffFor(r.path);
    event({ type: "tool_result", call_id: `r${i}`, name: r.name, output: diff, is_diff: true, diff });
  });
  event({ type: "text_delta", text: "done" });
  event({ type: "turn_end", turn_id: "t", reason: "completed" });
  return h.doc;
}

test("a diff a shell printed is drawn but is not one of this turn's edits", () => {
  const doc = turnWithResults([{ name: "bash", path: "src/elsewhere.py" }]);
  assert.ok(doc.querySelector(".diff"), "the diff is still drawn where the command ran");
  assert.equal(doc.querySelector(".turn-summary"), null, "but no Edited card lists it");
});

test("an MCP tool's diff is not an edit either", () => {
  const doc = turnWithResults([{ name: "mcp__github__get_pull_request_diff", path: "README.md" }]);
  assert.equal(doc.querySelector(".turn-summary"), null);
});

test("a subscription engine's Edit and a Gemini replace are this turn's edits", () => {
  const doc = turnWithResults([{ name: "Edit", path: "src/a.py" }, { name: "replace", path: "src/b.py" },
                               { name: "bash", path: "src/c.py" }]);
  const rows = [...doc.querySelectorAll(".turn-summary .ts-row")].map(r => r.textContent);
  assert.equal(rows.length, 2, rows.join(" | "));
  assert.match(rows[0], /a\.py/);
  assert.match(rows[1], /b\.py/);
});
