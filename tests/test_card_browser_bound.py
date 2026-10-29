"""Browser typing cannot bypass the payment-card guard with length or Unicode digits."""

import unittest


class CardBrowserBoundTests(unittest.TestCase):
    def test_unicode_decimal_digits_are_normalized_for_card_detection(self):
        from dgc.cards import card_number
        translated = "4111111111111111".translate(str.maketrans("0123456789", "٠١٢٣٤٥٦٧٨٩"))
        self.assertEqual(card_number(translated), "4111111111111111")

    def test_browser_rejects_text_beyond_the_card_scan_budget(self):
        from dgc.cards import card_number
        from dgc.tools import _browser_args_error
        text = "x" * 100_000 + "4111111111111111"
        self.assertIsNone(card_number(text))
        self.assertIn("too long", _browser_args_error("type", {"ref": "e1", "text": text}))


if __name__ == "__main__":
    unittest.main()
