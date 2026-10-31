// The grid editor saves a whole workbook (artifact_update), so when it inserts, deletes or sorts it moves every
// formula's references itself (media/sheetRefs.js). A total that kept pointing at the old rows would be wrong without
// any error, so each case here runs the same change through the backend's own ops (dgc/artifact_sheet.py
// apply_edits) and requires the two workbooks to be the same, formula for formula.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { pickPython } from "./support/panel-live.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..");
const refs = createRequire(import.meta.url)(join(here, "..", "media", "sheetRefs.js"));

test("numeric sheet input never stores infinity as a cell", () => {
  const context = { window: {} };
  runInNewContext(readFileSync(join(here, "..", "media", "artifactSheet.js"), "utf8"), context);
  const typed = context.window.DgcArtifact.sheet.typed;
  assert.equal(typed("1e999", { type: "number" }), "1e999");
  assert.equal(typed("-1e999", { type: "currency" }), "-1e999");
  assert.equal(typed("1e3", { type: "number" }), 1000);
});

const book = () => ({ sheets: [
  { name: "Budget", columns: [{ name: "Item", type: "text" }, { name: "Planned", type: "number" }, { name: "Actual", type: "number" }, { name: "Gap", type: "number" }],
    rows: [["Rent", 45000, 45000, "=C2-B2"], ["Groceries", 18000, 21000, "=C3-B3"], ["Power", 4200, 3900, "=C4-B4"],
           ["Travel", 9000, 12500, "=C5-B5"], ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM($D$2:D5)"]], frozen: 1 },
  { name: "Q3 plan", columns: [{ name: "What", type: "text" }, { name: "Value", type: "number" }],
    rows: [["Rent share", "=Budget!B2/Budget!B6"], ["Gap total", "=Budget!D6"], ["Cols", "=SUM(Budget!B:C)"], ["Row", "=SUM(Budget!B3:D3)"]], frozen: 1 },
] });

// [what, the JS change, the backend's edits]
const CASES = [
  ["a row inserted above the total joins its range", (s) => refs.insertRows(s, 0, 6, 1), [{ op: "insert_rows", sheet: "Budget", row: 6, count: 1 }]],
  ["two rows inserted in the middle", (s) => refs.insertRows(s, 0, 3, 2), [{ op: "insert_rows", sheet: "Budget", row: 3, count: 2 }]],
  ["a row inserted at the top of the data", (s) => refs.insertRows(s, 0, 2, 1), [{ op: "insert_rows", sheet: "Budget", row: 2, count: 1 }]],
  ["a row deleted from the middle", (s) => refs.deleteRows(s, 0, 3, 1), [{ op: "delete_rows", sheet: "Budget", row: 3, count: 1 }]],
  ["the row another sheet reads is deleted: #REF!", (s) => refs.deleteRows(s, 0, 2, 1), [{ op: "delete_rows", sheet: "Budget", row: 2, count: 1 }]],
  ["the total row itself is deleted", (s) => refs.deleteRows(s, 0, 6, 1), [{ op: "delete_rows", sheet: "Budget", row: 6, count: 1 }]],
  ["a column inserted between Planned and Actual", (s) => refs.insertColumns(s, 0, 2, [{ name: "Notes", type: "text" }]),
    [{ op: "insert_columns", sheet: "Budget", column: "C", columns: [{ name: "Notes", type: "text" }] }]],
  ["a column added at the end", (s) => refs.insertColumns(s, 0, 4, [{ name: "Owner", type: "text" }]),
    [{ op: "insert_columns", sheet: "Budget", column: "E", columns: [{ name: "Owner", type: "text" }] }]],
  ["the Planned column deleted", (s) => refs.deleteColumns(s, 0, 1, 1), [{ op: "delete_columns", sheet: "Budget", column: "B", count: 1 }]],
  ["the Gap column deleted", (s) => refs.deleteColumns(s, 0, 3, 1), [{ op: "delete_columns", sheet: "Budget", column: "D", count: 1 }]],
  ["a row inserted on the other sheet", (s) => refs.insertRows(s, 1, 2, 1), [{ op: "insert_rows", sheet: "Q3 plan", row: 2, count: 1 }]],
  ["the sheet renamed", (s) => refs.renameSheet(s, 0, "Home budget"), [{ op: "rename_sheet", sheet: "Budget", name: "Home budget" }]],
  ["the sheet another reads deleted", (s) => refs.deleteSheet(s, 0), [{ op: "delete_sheet", sheet: "Budget" }]],
  ["sorted by Actual, the total staying put", (s) => refs.sortRows(s, 0, 2, false, (row, c) => row[c]),
    [{ op: "sort", sheet: "Budget", column: "C", rows: "2:5" }]],
  ["sorted by Item, descending", (s) => refs.sortRows(s, 0, 0, true, (row, c) => row[c]),
    [{ op: "sort", sheet: "Budget", column: "A", descending: true, rows: "2:5" }]],
];

const python = pickPython();
const skipOrFail = (t) => {
  if (python) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: no Python that imports this checkout's dgc");
  t.skip("no Python that imports this checkout's dgc");
  return true;
};

function backend(cases) {
  const program = `
import json, sys
from dgc import artifact_sheet as sheet
out = []
for case in json.load(sys.stdin):
    theirs = sheet.apply_edits(case["book"], case["edits"])
    ours = sheet.normalize(case["ours"])
    out.append({"theirs": theirs, "ours": ours})
json.dump(out, sys.stdout)
`;
  const run = spawnSync(python, ["-c", program], { cwd: repoRoot, input: JSON.stringify(cases), encoding: "utf8",
    env: { ...process.env, PYTHONPATH: repoRoot }, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test("the grid's inserts, deletes, renames and sorts move every reference the way the backend moves them", (t) => {
  if (skipOrFail(t)) return;
  const prepared = CASES.map(([name, change, edits]) => {
    const ours = book();
    change(ours.sheets);
    return { name, book: book(), edits, ours };
  });
  const results = backend(prepared.map(({ book: b, edits, ours }) => ({ book: b, edits, ours })));
  results.forEach((r, i) => assert.deepEqual(r.ours, r.theirs, prepared[i].name));
});

test("a formula reading the rows being sorted is never scrambled", () => {
  const b = { sheets: [{ name: "S", columns: [{ name: "A", type: "number" }, { name: "B", type: "number" }],
    rows: [[3, "=SUM(A2:A4)"], [1, null], [2, null]] }] };
  assert.throws(() => refs.sortRows(b.sheets, 0, 0, false, (row, c) => row[c]), /reads the rows being sorted/);
  assert.deepEqual(b.sheets[0].rows, [[3, "=SUM(A2:A4)"], [1, null], [2, null]], "nothing moved");
});

test("an unreadable formula is left exactly as it was", () => {
  const b = { sheets: [{ name: "S", columns: [{ name: "A", type: "text" }], rows: [["=A2 @ 3"], ["x"]] }] };
  refs.insertRows(b.sheets, 0, 2, 1);
  assert.deepEqual(b.sheets[0].rows, [[null], ["=A2 @ 3"], ["x"]], "as the backend leaves a formula its tokenizer can't read");
});
