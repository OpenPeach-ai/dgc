"""The inline picker must measure terminal columns, not Unicode code points."""

import unittest

from rich.cells import cell_len

from dgc.menu import _vtrunc


class MenuCellWidthTests(unittest.TestCase):
    def test_wide_label_never_exceeds_its_column_budget(self):
        for width in range(1, 9):
            shown = _vtrunc("文件选择", width)
            self.assertLessEqual(cell_len(shown), width)
        self.assertEqual(_vtrunc("文件选择", 5), "文件…")


if __name__ == "__main__":
    unittest.main()
