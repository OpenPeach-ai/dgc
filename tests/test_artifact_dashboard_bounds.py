"""Plugin dashboard results stay bounded and malformed cache rows stay local to a widget."""

import unittest

from dgc import artifact_dashboard as dashboard


class DashboardBoundsTests(unittest.TestCase):
    def test_plugin_rows_are_bounded_before_conversion(self):
        values = [{"number": n} for n in range(dashboard.MAX_ROWS + 200)]
        names, rows, more = dashboard.run_plugin(
            {"server": "shop"}, {"tool": "read", "path": "rows[*]"},
            call=lambda *_args: {"rows": values}, is_read_only=lambda *_args: True)
        self.assertEqual(names, ["number"])
        self.assertEqual(len(rows), dashboard.MAX_ROWS)
        self.assertTrue(more)
        self.assertEqual(rows[-1], [dashboard.MAX_ROWS - 1])

    def test_ragged_header_gets_all_column_names(self):
        names, rows = dashboard.table_of([["name"], ["A", 2]])
        self.assertEqual(names, ["name", "column_2"])
        self.assertEqual(rows, [["A", 2]])

    def test_nested_value_and_saved_result_are_bounded(self):
        names, rows = dashboard.table_of([{"x": {"large": "z" * 100_000}}])
        self.assertEqual(names, ["x"])
        self.assertLessEqual(len(rows[0][0]), dashboard.MAX_CELL)
        self.assertIsNotNone(dashboard._render_result({"columns": ["x"], "rows": [["ok"]],
                                                      "more": False, "ms": 1}))
        for result in ({"columns": ["x"], "rows": [["z" * (dashboard.MAX_CELL + 1)]]},
                       {"columns": ["x"], "rows": [["ok"], ["extra", "column"]]},
                       {"columns": ["x"], "rows": [["ok"]], "more": "yes"}):
            self.assertIn("error", dashboard._render_result(result))


if __name__ == "__main__":
    unittest.main()
