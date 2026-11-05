"""Display-only Work mentions cannot change the text a model receives."""

import unittest

from dgc.prompt_display import checked_mentions


class PromptDisplayTests(unittest.TestCase):
    def test_inline_marks_and_zero_width_pip_at_end(self):
        text = "Use Composio for a Page"
        marks = [
            {"start": 4, "kind": "plugin", "label": "Composio", "identity": "composio"},
            {"start": 19, "kind": "artifact", "label": "Page", "identity": "page"},
            {"start": len(text), "kind": "pip", "label": "Core", "identity": "pip_" + "a" * 32,
             "pip_type": "core"},
        ]
        self.assertEqual(checked_mentions(marks, text), marks)
        self.assertEqual(text, "Use Composio for a Page")

    def test_mismatched_or_untrusted_marks_are_discarded_together(self):
        text = "Use Composio"
        valid = {"start": 4, "kind": "plugin", "label": "Composio", "identity": "composio"}
        self.assertEqual(checked_mentions([valid, {**valid, "start": 3}], text), [])
        self.assertEqual(checked_mentions([{**valid, "label": "Notion"}], text), [])
        self.assertEqual(checked_mentions([{**valid, "identity": "composio\nsecret"}], text), [])
        self.assertEqual(checked_mentions([{**valid, "extra": "ignored"}], text), [])
        self.assertEqual(checked_mentions([{**valid, "kind": ["plugin"]}], text), [])
        self.assertEqual(checked_mentions([{"start": len(text), "kind": "pip", "label": "Core",
                                            "identity": "pip_" + "a" * 32, "pip_type": ["core"]}], text), [])
        self.assertEqual(checked_mentions([{"start": len(text) + 1, "kind": "pip", "label": "Core",
                                            "identity": "pip_" + "a" * 32, "pip_type": "core"}], text), [])

    def test_inline_skill_file_and_command_are_cosmetic(self):
        text = "Use  in  then /review the result"
        marks = [
            {"start": 4, "kind": "skill", "label": "onboard", "identity": "skill"},
            {"start": 8, "kind": "file", "label": "src/main.py", "identity": "file"},
            {"start": 14, "kind": "command", "label": "review", "identity": "command"},
        ]
        self.assertEqual(checked_mentions(marks, text), marks)
        self.assertEqual(checked_mentions([{**marks[-1], "label": "delete"}], text), [])
        self.assertEqual(text, "Use  in  then /review the result")


if __name__ == "__main__":
    unittest.main()
