"""Sheet artifacts: a spreadsheet is data the model writes, and DGC computes, shows and exports it.

What matters: formulas mean what they mean in a spreadsheet (precedence, ranges, other sheets, rounding) and are
parsed, never evaluated as code; a loop or a bad reference shows a spreadsheet's error and says why instead of
crashing; every edit moves references the way a spreadsheet does, and applies whole or not at all; the Excel file
is a real workbook whose formulas stay formulas, and LibreOffice computes them to the same values; the page loads
nothing and turns no cell into markup.
"""
from __future__ import annotations

import csv
import inspect
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest import mock
from xml.dom import minidom

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import artifact_sheet as S
from dgc.artifact_sheet import CellError, SheetError
from dgc.artifact_store import Store
from dgc.chatdgc import data as tabledata
from dgc.chatdgc import made

RUPEES = {"type": "currency", "currency": "₹"}


def _budget() -> dict:
    return {"sheets": [
        {"name": "October", "columns": [{"name": "Category", "type": "text"}, {"name": "Planned", **RUPEES},
                                        {"name": "Spent", **RUPEES}, {"name": "Left", **RUPEES},
                                        {"name": "Share", "type": "percent"}, {"name": "Paid on", "type": "date"},
                                        {"name": "Recurring", "type": "bool"}],
         "rows": [["Rent", 42000, 42000, "=B2-C2", "=C2/$C$6", "2026-10-01", True],
                  ["Groceries", 14000, 15350, "=B3-C3", "=C3/$C$6", "2026-10-26", False],
                  ["Electricity", 3200, 2875, "=B4-C4", "=C4/$C$6", "2026-10-09", True],
                  ["Eating out", 5000, 6120.5, "=B5-C5", "=C5/$C$6", "2026-10-25", False],
                  ["Total", "=SUM(B2:B5)", "=SUM(C2:C5)", "=SUM(D2:D5)", "=SUM(E2:E5)", None, None]]},
        {"name": "Summary", "columns": [{"name": "Measure", "type": "text"}, {"name": "Amount", **RUPEES},
                                        {"name": "Note", "type": "text"}],
         "rows": [["Take-home pay", 148000, None],
                  ["Spent", "=October!C6", "=IF(B3>October!B6, \"Over plan\", \"Within plan\")"],
                  ["Left", "=B2-B3", "=CONCAT(\"Saved \", ROUND(B4/B2*100, 1), \"% of pay\")"]]}]}


def _values(book, name):
    return next(s["rows"] for s in S.compute(book) if s["name"] == name)


def _one(formula, rows=None, columns=None):
    """What one formula in B2 of a one-sheet workbook shows (A1 is "x", A2.. hold ``rows``)."""
    columns = columns or [{"name": "x", "type": "number"}, {"name": "f", "type": "text"}]
    body = [[v, None] for v in (rows or [])] or [[None, None]]
    body[0][1] = formula
    return S.compute({"sheets": [{"name": "S", "columns": columns, "rows": body}]})[0]["rows"][0][1]


class Formulas(unittest.TestCase):
    def test_operators_follow_a_spreadsheets_precedence(self):
        cases = {"=1+2*3": 7, "=-2^2": 4, "=2^3^2": 64, "=50%*10": 5, "=(1+2)*3": 9, "=10/4": 2.5,
                 "=\"a\"&1&TRUE": "a1TRUE", "=\"abc\"=\"ABC\"": True, "=2<\"a\"": True, "=3<>3": False,
                 "=0.1+0.2": 0.3, "=\"12\"+1": 13, "=\"1,200\"*2": 2400, "=-(-3)": 3}
        for formula, expected in cases.items():
            with self.subTest(formula):
                self.assertEqual(_one(formula), expected)

    def test_functions_read_ranges_the_way_a_spreadsheet_does(self):
        def calc(formula):
            book = {"sheets": [{"name": "S", "columns": [{"name": "n", "type": "number"}, {"name": "t", "type": "text"},
                                                         {"name": "b", "type": "bool"}, {"name": "f", "type": "text"}],
                                "rows": [[4, "note", True, formula], [6, "5", False, None], [None, None, None, None],
                                         [10, None, None, None]]}]}
            return S.compute(book)[0]["rows"][0][3]
        self.assertEqual(calc("=SUM(A2:C5)"), 20, "text (even \"5\"), TRUE/FALSE and empty cells are skipped")
        self.assertEqual(calc("=SUM(A:A)"), 20, "a whole column, its name in row 1 skipped")
        self.assertAlmostEqual(calc("=AVERAGE(A2:A5)"), 20 / 3, places=12)
        self.assertEqual(calc("=MIN(A2:C5)"), 4)
        self.assertEqual(calc("=MAX(A2:A5, 11)"), 11)
        self.assertEqual(calc("=COUNT(A2:C5)"), 3)
        self.assertEqual(calc("=COUNTA(A2:C5)"), 7)
        rows = [4, 6, None, 10]
        self.assertEqual(_one("=SUM(TRUE, \"2\", 3)", rows), 6, "values written in the formula are turned into numbers")
        self.assertEqual(_one("=ROUND(2.675, 2)", rows), 2.68, "half away from zero, as a spreadsheet rounds")
        self.assertEqual(_one("=ROUND(-2.5, 0)", rows), -3)
        self.assertEqual(_one("=ROUND(1234.5, -2)", rows), 1200)
        self.assertEqual(_one("=ABS(-7.5)", rows), 7.5)
        self.assertEqual(_one("=CONCAT(\"Total: \", SUM(A2:A3), \"!\")", rows), "Total: 10!")
        self.assertEqual(_one("=IF(A4=0, \"none\", 1/A4)", rows), "none", "IF only computes the branch it takes")
        self.assertEqual(_one("=IF(A2>5, \"big\")", rows), False)
        self.assertEqual(_one("=MAX(A9:A12)", rows), 0, "MAX of nothing is 0, as in a spreadsheet")

    def test_other_sheets_absolute_references_and_dates(self):
        book = S.normalize(_budget())
        october, summary = _values(book, "October"), _values(book, "Summary")
        self.assertEqual(october[4][1:4], [64200, 66345.5, -2145.5])
        self.assertAlmostEqual(october[4][4], 1.0)
        self.assertEqual(summary[1][1], 66345.5)
        self.assertEqual(summary[1][2], "Over plan")
        self.assertEqual(summary[2][2], "Saved 55.2% of pay")
        dates = {"sheets": [{"name": "Trips", "columns": [{"name": "Leave", "type": "date"},
                                                          {"name": "Back", "type": "date"},
                                                          {"name": "Days", "type": "number"}],
                             "rows": [["2026-10-28", "=A2+12", "=B2-A2"]]}]}
        self.assertEqual(S.compute(dates)[0]["rows"][0], ["2026-10-28", "2026-11-09", 12])
        quoted = {"sheets": [{"name": "Q3 plan", "columns": ["Amount"], "rows": [[5]]},
                             {"name": "Use", "columns": [{"name": "v", "type": "number"}],
                              "rows": [["='Q3 plan'!A2*2"], ["='q3 PLAN'!$A$2+1"]]}]}
        self.assertEqual(_values(quoted, "Use"), [[10], [6]])

    def test_errors_show_as_a_spreadsheet_shows_them_and_say_why(self):
        book = {"sheets": [{"name": "Checks", "columns": [{"name": "What", "type": "text"},
                                                          {"name": "Value", "type": "number"}],
                            "rows": [["zero", 0], ["divide", "=10/B2"], ["uses it", "=B3+1"],
                                     ["unknown", "=VLOOKUP(1, A:A, 1)"], ["no sheet", "=Nowhere!A1"],
                                     ["text sum", "=\"lots\"+1"], ["empty average", "=AVERAGE(B20:B30)"],
                                     ["range alone", "=B2:B3"], ["a name", "=total"]]}]}
        shown = [row[1] for row in S.compute(book)[0]["rows"]]
        self.assertEqual(shown[1:], ["#DIV/0!", "#DIV/0!", "#NAME?", "#REF!", "#VALUE!", "#DIV/0!", "#VALUE!",
                                     "#NAME?"])
        self.assertTrue(all(isinstance(v, CellError) for v in shown[1:]))
        self.assertEqual(json.loads(json.dumps(shown[1])), "#DIV/0!", "an error serializes as its code")
        trouble = "\n".join(S.problems(book))
        self.assertIn("Checks!B3 shows #DIV/0!: it divides by zero", trouble)
        self.assertIn("1 other cell shows it because they use it", trouble)
        self.assertIn("don't know VLOOKUP", trouble)
        self.assertIn("no sheet named “Nowhere”", trouble)
        self.assertIn("“lots”, which is text", trouble)
        self.assertNotIn("Checks!B4 shows", trouble, "a cell that only passes an error on isn't its own problem")

    def test_a_loop_of_formulas_shows_cycle_and_a_long_chain_still_computes(self):
        book = {"sheets": [{"name": "S", "columns": [{"name": "a", "type": "number"}, {"name": "b", "type": "number"}],
                            "rows": [["=B2+1", "=A3"], ["=A2*2", 5], ["=A4", "=A2+B3"]]}]}
        rows = S.compute(book)[0]["rows"]
        self.assertEqual([rows[0][0], rows[0][1], rows[1][0], rows[2][0]], ["#CYCLE"] * 4,
                         "A2 → B2 → A3 → A2 is a loop, and A4 reads itself")
        self.assertEqual(rows[2][1], "#CYCLE", "a cell that reads a loop shows its error too")
        self.assertIn("loop of formulas", S.problems(book)[0])
        chain = [[1]] + [[f"=A{r - 1}+1"] for r in range(3, 6002)]           # 6,000 formulas, each reading the last
        long = {"sheets": [{"name": "Run", "columns": [{"name": "n", "type": "number"}], "rows": chain}]}
        self.assertEqual(S.compute(long)[0]["rows"][-1][0], 6000)

    def test_formula_dependencies_are_bounded_even_when_a_branch_is_not_evaluated(self):
        repeated = ",".join(["A2"] * 8)
        book = {"sheets": [{"name": "S", "columns": ["n"], "rows":
                            [["=1"], [f"=IF(TRUE,1,SUM({repeated}))"],
                             [f"=IF(TRUE,1,SUM({repeated}))"], ["=2"]]}]}
        with mock.patch.object(S, "MAX_DEP_WORK", 12):
            shown = [row[0] for row in S.compute(book)[0]["rows"]]
        self.assertEqual(shown[:2], [1, 1])
        self.assertEqual(shown[2:], ["#CALC!", "#CALC!"])

    def test_formulas_are_read_by_a_parser_and_never_run_as_code(self):
        source = inspect.getsource(S)
        self.assertIsNone(re.search(r"(?<![\w.])(eval|exec|compile)\(", source))
        for formula in ("=__import__(\"os\").system(\"touch /tmp/x\")", "=SUM(B2:", "=(1+2", "=1+", "=\"open",
                        "=ROUND(1)", "=IF(1)", "=SUM(,)"):
            with self.subTest(formula), self.assertRaises(SheetError) as caught:
                S.normalize({"sheets": [{"name": "S", "columns": ["a"], "rows": [[formula]]}]})
            self.assertIn("S!A2 (row 2, column A “a”)", str(caught.exception))
        with self.assertRaisesRegex(SheetError, r"ROUND takes 2 values, like =ROUND\(B2, 2\)"):
            S.normalize({"sheets": [{"name": "S", "columns": ["a"], "rows": [["=ROUND(1)"]]}]})
        with self.assertRaisesRegex(SheetError, "nests too deeply"):
            S.normalize({"sheets": [{"name": "S", "columns": ["a"], "rows": [["=" + "(" * 200 + "1" + ")" * 200]]}]})


class Normalize(unittest.TestCase):
    def test_errors_name_the_sheet_the_cell_and_what_to_write(self):
        def refused(book, *words):
            with self.assertRaises(SheetError) as caught:
                S.normalize(book)
            for word in words:
                self.assertIn(word, str(caught.exception))
        cols = [{"name": "Item", "type": "text"}, {"name": "Amount", **RUPEES}, {"name": "Due", "type": "date"}]
        refused({"sheets": [{"name": "Bills", "columns": cols, "rows": [["Rent", "about 200", None]]}]},
                "Bills!B2 (row 2, column B “Amount”)", "isn't a number", "=B2*2")
        refused({"sheets": [{"name": "Bills", "columns": cols, "rows": [["Rent", 1, "28/10/2026"]]}]},
                "Bills!C2", "2026-10-28")
        refused({"sheets": [{"name": "Bills", "columns": cols, "rows": [["Rent", 1, None, "extra"]]}]},
                "row 2 has 4 cells but the sheet has 3 columns")
        refused({"sheets": [{"name": "Bills", "columns": [{"name": "x", "type": "money!"}], "rows": []}]},
                "text, number, currency, percent, date, bool")
        refused({"sheets": [{"name": "A", "columns": ["x"]}, {"name": "a", "columns": ["x"]}]}, "Two sheets")
        refused({"sheets": [{"name": "Q3: plan", "columns": ["x"]}]}, "can't have [ ] : * ? / \\")
        refused({"sheets": [{"name": "S", "columns": ["x", "X"]}]}, "two columns named")
        refused({"sheets": [{"name": "S", "columns": [{"name": "ok", "type": "bool"}], "rows": [["maybe"]]}]},
                "S!A2", "true or false")
        refused({"sheet": []}, '"sheets"')

    def test_limits_are_chatdgcs_own(self):
        self.assertEqual((S.MAX_SHEETS, S.MAX_CELLS), (made.MAX_SHEETS, made.MAX_CELLS))
        with self.assertRaisesRegex(SheetError, "100,000"):
            S.normalize({"sheets": [{"name": "Big", "columns": [f"c{i}" for i in range(100)],
                                     "rows": [[1] * 100 for _ in range(1001)]}]})
        with self.assertRaisesRegex(SheetError, "at most 20"):
            S.normalize({"sheets": [{"name": f"S{i}", "columns": ["x"]} for i in range(21)]})

    def test_defaults_are_filled_and_a_normalized_workbook_comes_back_unchanged(self):
        book = S.normalize({"name": "Team", "rows": [["Name", "Hours", "Rate", "Code"], ["Asha", "12.5", "₹1,200", "007"],
                                                      ["Ravi", 8, "₹950", "012"]]})
        sheet = book["sheets"][0]
        self.assertEqual([c["type"] for c in sheet["columns"]], ["text", "number", "currency", "text"])
        self.assertEqual(sheet["columns"][2]["currency"], "₹")
        self.assertEqual(sheet["rows"][0], ["Asha", 12.5, 1200, "007"], "a code keeps its leading zero")
        self.assertEqual(sheet["frozen"], 1)
        self.assertEqual(S.normalize(book), book)
        budget = S.normalize(_budget())
        self.assertEqual(S.normalize(budget), budget)
        self.assertEqual(budget["sheets"][0]["rows"][0][3], "=B2-C2")
        self.assertEqual(S.normalize({"sheets": [{"name": "S", "columns": ["a"], "rows": [["=sum(a1:a1)"]]}]})
                         ["sheets"][0]["rows"][0][0], "=SUM(A1:A1)", "kept the canonical way")

    def test_a_sheet_round_trips_through_the_artifact_store(self):
        with tempfile.TemporaryDirectory() as folder:
            store = Store(Path(folder) / "artifacts")
            book = S.normalize(_budget())
            art = store.create("sheet", "Budget", book, origin={"surface": "chat", "chat": "c"})
            self.assertEqual(store.source(art.id), book)


class Edits(unittest.TestCase):
    def setUp(self):
        self.book = S.normalize(_budget())

    def rows(self, book, name="October"):
        return next(s["rows"] for s in book["sheets"] if s["name"] == name)

    def test_set_a_cell_a_block_and_fill_a_range(self):
        book = S.apply_edits(self.book, [
            {"op": "set", "sheet": "October", "cell": "C3", "value": 14500},
            {"op": "set", "sheet": "October", "cell": "A1", "value": "Spending"},
            {"op": "set", "sheet": "Summary", "cell": "C2", "values": [["Salary"], ["After tax"]]},
            {"op": "set", "sheet": "October", "range": "D2:D5", "value": "=ROUND(B2-C2, -2)"},
            {"op": "set", "sheet": "October", "range": "B2:C3", "values": [[41000, 41000], [13000, 12500]]}])
        rows = self.rows(book)
        self.assertEqual([r[3] for r in rows[:4]], ["=ROUND(B2-C2, -2)", "=ROUND(B3-C3, -2)", "=ROUND(B4-C4, -2)",
                                                     "=ROUND(B5-C5, -2)"], "a formula filled down moves with its row")
        self.assertEqual(rows[1][1:3], [13000, 12500])
        self.assertEqual(book["sheets"][0]["columns"][0]["name"], "Spending", "row 1 is the column names")
        self.assertEqual(self.rows(book, "Summary")[0][2], "Salary")
        filled = S.apply_edits(self.book, [{"op": "set", "sheet": "October", "range": "E2:E5", "value": "=C2/$C$6"}])
        self.assertEqual(self.rows(filled)[3][4], "=C5/$C$6", "a $ part stays where it is")
        grown = S.apply_edits(self.book, [{"op": "set", "sheet": "Summary", "cell": "A6", "value": "Gifts"}])
        self.assertEqual(self.rows(grown, "Summary")[-1], ["Gifts", None, None], "setting past the end adds rows")

    def test_inserted_rows_move_references_and_a_total_takes_in_a_row_added_above_it(self):
        book = S.apply_edits(self.book, [{"op": "insert_rows", "sheet": "October", "row": 6,
                                          "rows": [["Fuel", 6500, 7240, "=B6-C6", "=C6/$C$7", "2026-10-24", False]]}])
        rows = self.rows(book)
        self.assertEqual(rows[5][1:4], ["=SUM(B2:B6)", "=SUM(C2:C6)", "=SUM(D2:D6)"])
        self.assertEqual(rows[0][4], "=C2/$C$7", "an absolute reference moves when its row moves")
        self.assertEqual(self.rows(book, "Summary")[1][1], "=October!C7", "another sheet's reference moves too")
        self.assertEqual(_values(book, "Summary")[1][1], 73585.5)
        top = S.apply_edits(self.book, [{"op": "insert_rows", "sheet": "October", "row": 2, "count": 2}])
        self.assertEqual(self.rows(top)[6][1], "=SUM(B4:B7)")
        self.assertEqual(self.rows(top)[0], [None] * 7)

    def test_deleted_rows_shrink_ranges_and_a_reference_to_a_deleted_cell_becomes_ref(self):
        book = S.apply_edits(self.book, [{"op": "delete_rows", "sheet": "October", "row": 3, "count": 2}])
        rows = self.rows(book)
        self.assertEqual([r[0] for r in rows], ["Rent", "Eating out", "Total"])
        self.assertEqual(rows[2][1], "=SUM(B2:B3)")
        self.assertEqual(rows[1][3], "=B3-C3")
        alone = S.apply_edits(self.book, [{"op": "delete_rows", "sheet": "October", "row": 6}])
        self.assertEqual(self.rows(alone, "Summary")[1][1], "=#REF!")
        self.assertEqual(_values(alone, "Summary")[1][1], "#REF!")

    def test_columns_insert_delete_and_change(self):
        book = S.apply_edits(self.book, [{"op": "insert_columns", "sheet": "October", "column": "C",
                                          "columns": [{"name": "Revised", **RUPEES}]},
                                         {"op": "set", "sheet": "October", "range": "C2:C5", "value": "=B2*1.1"}])
        rows = self.rows(book)
        self.assertEqual(book["sheets"][0]["columns"][2]["name"], "Revised")
        self.assertEqual(rows[0][4], "=B2-D2", "Left now reads Spent in column D")
        self.assertEqual(rows[4][3], "=SUM(D2:D5)")
        gone = S.apply_edits(self.book, [{"op": "delete_columns", "sheet": "October", "column": "Spent"}])
        self.assertEqual(self.rows(gone)[0][2], "=B2-#REF!")
        self.assertEqual(self.rows(gone, "Summary")[1][1], "=#REF!")
        typed = S.apply_edits(self.book, [{"op": "set_column", "sheet": "October", "column": "B", "type": "number",
                                           "decimals": 0, "name": "Plan"}])
        self.assertEqual(typed["sheets"][0]["columns"][1], {"name": "Plan", "type": "number", "decimals": 0})
        with self.assertRaisesRegex(SheetError, "October!A2 .*isn't a number"):
            S.apply_edits(self.book, [{"op": "set_column", "sheet": "October", "column": "A", "type": "number"}])

    def test_sheets_are_added_renamed_and_deleted_and_other_sheets_follow(self):
        book = S.apply_edits(self.book, [
            {"op": "add_sheet", "name": "November", "at": 2, "columns": [{"name": "Category", "type": "text"}]},
            {"op": "rename_sheet", "sheet": "October", "name": "Oct 2026"}])
        self.assertEqual([s["name"] for s in book["sheets"]], ["Oct 2026", "November", "Summary"])
        self.assertEqual(self.rows(book, "Summary")[1][1], "='Oct 2026'!C6")
        self.assertEqual(_values(book, "Summary")[1][1], 66345.5)
        gone = S.apply_edits(self.book, [{"op": "delete_sheet", "sheet": "October"}])
        self.assertEqual(self.rows(gone, "Summary")[1][1:], ["=#REF!", "=IF(B3>#REF!, \"Over plan\", \"Within plan\")"])
        with self.assertRaisesRegex(SheetError, "only sheet"):
            S.apply_edits({"sheets": [{"name": "S", "columns": ["a"]}]}, [{"op": "delete_sheet", "sheet": "S"}])

    def test_sort_moves_whole_rows_with_their_formulas_and_wont_scramble_a_total(self):
        book = S.apply_edits(self.book, [{"op": "sort", "sheet": "October", "column": "Spent", "descending": True,
                                          "rows": "2:5"}])
        rows = self.rows(book)
        self.assertEqual([r[0] for r in rows], ["Rent", "Groceries", "Eating out", "Electricity", "Total"])
        self.assertEqual(rows[2][3], "=B4-C4", "a row's own formula moves with it")
        self.assertEqual(_values(book, "October")[2][3], -1120.5)
        with self.assertRaisesRegex(SheetError, r"reads other rows being sorted, so sorting would scramble it. Sort only "
                                                r"the rows above it, like \"rows\": \"2:5\""):
            S.apply_edits(self.book, [{"op": "sort", "sheet": "October", "column": "B"}])
        frozen = S.apply_edits(self.book, [{"op": "freeze", "sheet": "October", "rows": 2}])
        self.assertEqual(frozen["sheets"][0]["frozen"], 2)

    def test_a_bad_edit_says_which_and_why_and_changes_nothing(self):
        before = json.dumps(self.book, sort_keys=True)
        cases = [([{"op": "set", "sheet": "October", "cell": "B2", "value": 1}, {"op": "explode"}], "Edit 2's op"),
                 ([{"op": "set", "cell": "B2", "value": 1}], 'Edit 1 (set) needs "sheet"'),
                 ([{"op": "set", "sheet": "October", "cell": "H2", "value": 1}], "columns A to G"),
                 ([{"op": "delete_rows", "sheet": "October", "row": 1}], "row 1 is the column names"),
                 ([{"op": "set", "sheet": "October", "cell": "B2", "value": "=SUM(B3:"}], "both its ends"),
                 ([{"op": "set", "sheet": "October", "cell": "B2", "value": "lots"}], "After the edits, October!B2"),
                 ([{"op": "insert_rows", "sheet": "October", "row": 3, "rows": [[1] * 8]}], "has 8 cells"),
                 ([{"op": "rename_sheet", "sheet": "October", "name": "Summary"}], "Two sheets are named"),
                 ([{"op": "set", "sheet": "October", "cell": "B2", "value": 1, "colour": "red"}], '"colour"')]
        for edits, words in cases:
            with self.subTest(words), self.assertRaises(SheetError) as caught:
                S.apply_edits(self.book, edits)
            self.assertIn(words, str(caught.exception))
        self.assertEqual(json.dumps(self.book, sort_keys=True), before)


class Files(unittest.TestCase):
    def setUp(self):
        self.book = S.normalize(_budget())

    def test_the_xlsx_is_a_real_workbook_whose_formulas_stay_formulas(self):
        raw = S.export_xlsx(self.book)
        archive = zipfile.ZipFile(io.BytesIO(raw))
        self.assertIsNone(archive.testzip())
        parts = {n: archive.read(n) for n in archive.namelist()}
        for name, data in parts.items():
            if name.endswith((".xml", ".rels")):
                minidom.parseString(data)
        october = parts["xl/worksheets/sheet1.xml"].decode()
        summary = parts["xl/worksheets/sheet2.xml"].decode()
        styles = parts["xl/styles.xml"].decode()
        self.assertIn("<f>SUM(B2:B5)</f><v>64200</v>", october, "a formula, with the value DGC computed beside it")
        self.assertIn("<f>B2-C2</f><v>0</v>", october)
        self.assertIn('t="str"><f>IF(B3&gt;October!B6, &quot;Over plan&quot;, &quot;Within plan&quot;)</f>'
                      '<v>Over plan</v>', summary)
        self.assertIn("<f>_xlfn.CONCAT(", summary, "CONCAT is newer than the format: Excel keeps it under _xlfn.")
        self.assertIn('formatCode="&quot;₹&quot;#,##0.00;-&quot;₹&quot;#,##0.00"', styles)
        self.assertIn('formatCode="0.0%"', styles)
        self.assertIn('formatCode="d mmm yyyy"', styles)
        self.assertRegex(october, r'<c r="F2" s="\d+"><v>46296</v></c>', "a date is a date's day number")
        self.assertIn('<c r="G2" t="b"><v>1</v></c>', october)
        self.assertIn('ySplit="1"', october)
        bare = zipfile.ZipFile(io.BytesIO(S.export_xlsx(self.book, values=False))).read("xl/worksheets/sheet1.xml")
        self.assertIn(b"<f>SUM(B2:B5)</f></c>", bare)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "budget.xlsx"
            path.write_bytes(raw)
            back = S.from_table_file(path)
        self.assertEqual([c["type"] for c in back["sheets"][0]["columns"]],
                         ["text", "number", "number", "number", "number", "date", "bool"],
                         "ChatDGC's reader keeps numbers, dates and booleans (number formats aren't read)")
        self.assertEqual(back["sheets"][0]["rows"][4][:4], ["Total", 64200, 66345.5, -2145.5],
                         "read back through ChatDGC's own reader, a formula comes in as what it computed")

    def test_plain_workbooks_from_chatdgc_are_written_exactly_as_before(self):
        plain = [{"name": "Costs", "rows": [["Item", "Amount"], ["Flat", 450000], ["Fees", "12,500"],
                                            ["Total", "=SUM(B2:B3)"]], "header": True}]
        sheet = zipfile.ZipFile(io.BytesIO(made.xlsx(plain))).read("xl/worksheets/sheet1.xml").decode()
        styles = zipfile.ZipFile(io.BytesIO(made.xlsx(plain))).read("xl/styles.xml").decode()
        self.assertIn('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>', sheet)
        self.assertNotIn("numFmts", styles)
        self.assertIn('<cellXfs count="3">', styles)

    @unittest.skipUnless(shutil.which("soffice"), "LibreOffice isn't installed")
    def test_libreoffice_opens_it_and_computes_the_same_values(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / "budget.xlsx").write_bytes(S.export_xlsx(self.book, values=False))   # LibreOffice computes all
            done = subprocess.run(
                ["soffice", f"-env:UserInstallation=file://{base}/profile", "--headless", "--convert-to",
                 "csv:Text - txt - csv (StarCalc):44,34,76,1,,1033,false,true,false,false,false,-1",
                 "--outdir", str(base), str(base / "budget.xlsx")], capture_output=True, text=True, timeout=180)
            self.assertEqual(done.returncode, 0, done.stderr)
            types = {s["name"]: [c["type"] for c in s["columns"]] for s in self.book["sheets"]}
            checked = 0
            for sheet in S.compute(self.book):
                name = sheet["name"]
                read = list(csv.reader((base / f"budget-{name}.csv").read_text(encoding="utf-8").splitlines()))[1:]
                self.assertEqual(len(read), len(sheet["rows"]))
                for r, (ours, theirs) in enumerate(zip(sheet["rows"], read), 2):
                    for c, (a, b) in enumerate(zip(ours, theirs)):
                        where = f"{name}!{S.letters(c)}{r}"
                        if a is None or types[name][c] == "date":
                            continue
                        if isinstance(a, bool):
                            self.assertEqual(b, "TRUE" if a else "FALSE", where)
                        elif isinstance(a, (int, float)):
                            number = float(b.rstrip("%")) / (100 if b.endswith("%") else 1)
                            self.assertAlmostEqual(number, a, places=9, msg=where)
                        else:
                            self.assertEqual(b, a, where)
                        checked += 1
            self.assertGreater(checked, 30)

    def test_csv_holds_each_cells_plain_value(self):
        text = S.export_csv(self.book, "October")
        lines = text.splitlines()
        self.assertEqual(lines[0], "Category,Planned,Spent,Left,Share,Paid on,Recurring")
        self.assertEqual(lines[1], f"Rent,42000,42000,0,{42000 / 66345.5:.15g},2026-10-01,TRUE")
        self.assertEqual(lines[5], "Total,64200,66345.5,-2145.5,1,,")
        self.assertEqual(S.export_csv(self.book).splitlines()[0], lines[0], "the first sheet when none is named")
        self.assertIn("Over plan", S.export_csv(self.book, "summary"))
        with self.assertRaisesRegex(SheetError, "no sheet “Nope”"):
            S.export_csv(self.book, "Nope")

    def test_a_table_file_becomes_a_typed_sheet(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "expenses-2026.csv"
            path.write_text("Date,Payee,Amount,Tax,Code,Paid,Memo\n2026-10-02,Landlord,\"₹42,000\",18%,007,TRUE,"
                            "=HYPERLINK(\"x\")\n2026-10-09,BESCOM,\"₹2,875\",5%,012,FALSE,power\n", encoding="utf-8")
            book = S.from_table_file(path)
            with self.assertRaisesRegex(SheetError, ".csv, .tsv or .xlsx"):
                S.from_table_file(Path(folder) / "notes.txt")
        sheet = book["sheets"][0]
        self.assertEqual(sheet["name"], "expenses-2026")
        self.assertEqual([c["type"] for c in sheet["columns"]], ["date", "text", "currency", "percent", "text",
                                                                 "bool", "text"])
        self.assertEqual(sheet["rows"][0], ["2026-10-02", "Landlord", 42000, 0.18, "007", True,
                                            "'=HYPERLINK(\"x\")"], "text that starts with = stays text")
        self.assertEqual(S.compute(book)[0]["rows"][0][6], "=HYPERLINK(\"x\")")


class Page(unittest.TestCase):
    def setUp(self):
        self.book = S.normalize(_budget())

    def test_the_page_loads_nothing_and_its_one_script_carries_the_nonce(self):
        page = S.render_html(self.book, nonce="abcDEF123456")
        policy = re.search(r'http-equiv="Content-Security-Policy" content="([^"]+)"', page).group(1)
        self.assertIn("default-src 'none'", policy)
        self.assertIn("script-src 'nonce-abcDEF123456'", policy)
        self.assertEqual(re.findall(r"<script[^>]*>", page), ['<script nonce="abcDEF123456">'])
        self.assertIn('<style nonce="abcDEF123456">', page)
        self.assertIsNone(re.search(r"(src|href)=\"?(https?:)?//", page))
        self.assertNotIn("@import", page)
        with self.assertRaises(SheetError):
            S.render_html(self.book, nonce="bad nonce")

    def test_numbers_read_in_their_columns_format(self):
        page = S.render_html(self.book, title="Household budget")
        self.assertIn("<title>Household budget</title>", page)
        self.assertIn('<td class="n" data-v="42000">₹42,000</td>', page)
        self.assertIn('data-f="=SUM(D2:D5)">−₹2,145.50</td>', page)
        self.assertIn(">63.3%</td>", page)
        self.assertIn('data-v="2026-10-01">1 Oct 2026</td>', page)
        self.assertIn('aria-label="Yes"', page)
        self.assertEqual(page.count('role="tab"'), 2)

    def test_errors_show_their_reason_and_frozen_rows_stay_in_view(self):
        book = {"sheets": [{"name": "S", "frozen": 2, "columns": [{"name": "a", "type": "number"}],
                            "rows": [[1], ["=1/0"], [3]]}]}
        page = S.render_html(book)
        self.assertIn('<td class="e" title="It divides by zero (or by an empty cell)" data-f="=1/0">#DIV/0!</td>', page)
        self.assertIn("#p0 tr.f2>*{position:sticky;top:53px", page)
        self.assertIn("1 error", page)

    def test_nothing_in_a_cell_becomes_markup(self):
        book = {"sheets": [{"name": "<b>S<b>", "columns": [{"name": "<i>x</i>", "type": "text"}],
                            "rows": [["<script>alert(1)</script>"], ["=\"<img src=x onerror=alert(1)>\""]]}]}
        page = S.render_html(book)
        self.assertNotIn("<script>alert", page)
        self.assertNotIn("<img src=x", page)
        self.assertIn("&lt;script&gt;alert(1)&lt;/script&gt;", page)
        self.assertNotIn("<b>S<b>", page)
        self.assertIn("&lt;b&gt;S&lt;b&gt;", page)

    def test_the_outline_shows_every_cell_by_its_address(self):
        text = S.outline(self.book)
        self.assertIn("row 1 holds the column names and data starts at row 2", text)
        self.assertIn("B “Planned” currency ₹", text)
        self.assertIn("6: Total | =SUM(B2:B5) → ₹64,200", text)
        broken = S.outline({"sheets": [{"name": "S", "columns": ["a"], "rows": [["=1/0"]]}]})
        self.assertIn("Problems:\n- S!A2 shows #DIV/0!", broken)


if __name__ == "__main__":
    unittest.main()
