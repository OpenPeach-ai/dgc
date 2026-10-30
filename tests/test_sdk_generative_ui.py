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

    def test_invalid_or_unsafe_cards_ignored(self):
        def parse(block):
            return extract_generative_ui("```dgc-ui\n" + json.dumps({"version": "1", "title": "x", "blocks": [block]}) + "\n```")
        self.assertEqual(parse({"type": "choices", "items": [{"label": "Run", "reply": "/init"}]}), [])
        self.assertEqual(parse({"type": "bars", "items": [{"label": "Bad", "value": float("nan") }]}), [])
        self.assertEqual(parse({"type": "html", "body": "<script/>"}), [])
        self.assertEqual(extract_generative_ui("```dgc-ui\n" + "x" * 17000 + "\n```"), [])


if __name__ == "__main__":
    unittest.main()
