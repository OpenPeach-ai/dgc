"""Mod-controlled numbers cannot crash or overallocate the terminal renderer."""
import unittest
from unittest.mock import patch

from dgc.mods import ui


class ModUILimitsTests(unittest.TestCase):
    def test_nonfinite_and_unrepresentable_numbers_are_rejected(self):
        for value in (float("nan"), float("inf"), -float("inf"), 10 ** 400):
            trees = [
                {"type": "Bar", "segments": [{"value": value}]},
                {"type": "Bar", "segments": [], "total": value},
                {"type": "Sparkline", "values": [value]},
                {"type": "Table", "columns": ["Value"], "rows": [[value]]},
            ]
            for tree in trees:
                with self.subTest(kind=tree["type"], value=str(value)[:30]), self.assertRaises(ui.UIError):
                    ui.clean(tree)

    def test_select_requires_actual_options(self):
        for options in ([None], ["plain string"], [{"value": "ok"}, None]):
            with self.subTest(options=options), self.assertRaises(ui.UIError):
                ui.clean({"type": "Select", "id": "choice", "options": options})

    def test_bar_never_creates_a_segment_wider_than_the_available_space(self):
        tree = ui.clean({"type": "Bar", "total": 1, "segments": [{"value": 2}, {"value": 2}]})
        made = []
        segment = ui.Segment
        def record(text, *args, **kwargs):
            made.append(len(text))
            return segment(text, *args, **kwargs)
        with patch.object(ui, "Segment", record):
            lines = ui.lines(tree, 10)
        self.assertLessEqual(max(made), 10)
        self.assertEqual(sum(len(s.text) for s in lines[0]), 10)

    def test_large_finite_numbers_still_draw(self):
        bar = ui.clean({"type": "Bar", "segments": [{"value": 1e308}, {"value": 1e308}]})
        self.assertEqual("".join(s.text for s in ui.lines(bar, 10)[0]), "█" * 10)
        spark = ui.clean({"type": "Sparkline", "values": [-1e308, 0, 1e308]})
        self.assertEqual("".join(s.text for s in ui.lines(spark, 10)[0]), "▁▄█")
