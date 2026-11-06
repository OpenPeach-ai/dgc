import json
import unittest

from dgc_sdk import extract_generative_ui


class GenerativeUiSdkTests(unittest.TestCase):
    def test_card_and_choice_are_data(self):
        card = {"version": "1", "title": "ERP status", "blocks": [
            {"type": "metrics", "items": [{"label": "Alerts", "value": "1"}]},
            {"type": "choices", "items": [{"label": "Review", "reply": "Review the alert"}]},
        ]}
        self.assertEqual(extract_generative_ui("Here is the status.\n```dgc-ui\n" + json.dumps(card) + "\n```"), [card])

    def test_numbers_and_true_false_read_as_their_text_as_the_editor_draws_them(self):
        card = {"version": "1", "title": "Tests", "blocks": [
            {"type": "metrics", "items": [{"label": "Passed", "value": 42, "detail": 3},
                                          {"label": "Coverage", "value": 81.5}]},
            {"type": "table", "columns": ["File", "Lines", "Typed"], "rows": [["a.py", 120, True], ["b.py", 2.0, False]]},
            {"type": "bars", "items": [{"label": 2026, "value": 8}]},
        ]}
        self.assertEqual(extract_generative_ui("```dgc-ui\n" + json.dumps(card) + "\n```"), [{
            "version": "1", "title": "Tests", "blocks": [
                {"type": "metrics", "items": [{"label": "Passed", "value": "42", "detail": "3"},
                                              {"label": "Coverage", "value": "81.5"}]},
                {"type": "table", "columns": ["File", "Lines", "Typed"],
                 "rows": [["a.py", "120", "true"], ["b.py", "2", "false"]]},
                {"type": "bars", "items": [{"label": "2026", "value": 8}]},
            ]}])
        bad = {"version": "1", "title": "T", "blocks": [{"type": "table", "columns": ["A"], "rows": [[{"n": 1}]]}]}
        self.assertEqual(extract_generative_ui("```dgc-ui\n" + json.dumps(bad) + "\n```"), [])

    def test_invalid_or_unsafe_cards_ignored(self):
        def parse(block):
            return extract_generative_ui("```dgc-ui\n" + json.dumps({"version": "1", "title": "x", "blocks": [block]}) + "\n```")
        self.assertEqual(parse({"type": "choices", "items": [{"label": "Run", "reply": "/init"}]}), [])
        self.assertEqual(parse({"type": "bars", "items": [{"label": "Bad", "value": float("nan") }]}), [])
        self.assertEqual(parse({"type": "html", "body": "<script/>"}), [])
        self.assertEqual(extract_generative_ui("```dgc-ui\n" + "x" * 17000 + "\n```"), [])


    def test_the_same_reading_as_the_typescript_sdk(self):
        from pathlib import Path
        cases = json.loads((Path(__file__).resolve().parent / "fixtures" / "sdk_generative_ui.json").read_text())
        for case in cases:
            with self.subTest(case["why"]):
                self.assertEqual(len(extract_generative_ui(case["reply"])), case["cards"])


if __name__ == "__main__":
    unittest.main()
