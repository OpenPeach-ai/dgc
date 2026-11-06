"""Display-only mentions (Work, ChatDGC, a Pip's chat) cannot change the text a model receives."""

import unittest

from dgc.prompt_display import checked_mentions, named_pips


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

    def test_a_mark_whose_name_is_the_words_must_spell_them(self):
        pip = {"start": 4, "kind": "pip", "label": "Scout", "identity": "pip_" + "a" * 32, "pip_type": "scout", "wired": True}
        self.assertEqual(checked_mentions([pip], "Ask Scout now"), [pip])
        self.assertEqual(checked_mentions([pip], "Ask Rook now"), [], "the words no longer say it")
        self.assertEqual(checked_mentions([{**pip, "wired": False}], "Ask Scout now"), [])
        self.assertEqual(checked_mentions([{"start": 0, "kind": "plugin", "label": "Ask", "identity": "x", "wired": True}], "Ask"), [],
                         "a plugin's name is always its words: it has no other way to be")
        # What stands on the words takes them, so a mark after it can't start inside them.
        file = {"start": 6, "kind": "file", "label": "src/a.py", "identity": "file", "wired": True}
        self.assertEqual(checked_mentions([{**pip, "start": 0}, {**file, "start": 6}], "Scout src/a.py"), [{**pip, "start": 0}, {**file, "start": 6}])
        self.assertEqual(checked_mentions([{**pip, "start": 0}, {**file, "start": 3}], "Scout src/a.py"), [])

    def test_the_pips_a_prompt_names_are_each_named_once(self):
        a, b = "pip_" + "a" * 32, "pip_" + "b" * 32
        marks = [{"start": 0, "kind": "plugin", "label": "Composio", "identity": "composio"},
                 {"start": 9, "kind": "pip", "label": "Scout", "identity": a, "pip_type": "scout", "wired": True},
                 {"start": 15, "kind": "pip", "label": "Scout", "identity": a, "pip_type": "scout", "wired": True},
                 {"start": 21, "kind": "pip", "label": "Rook", "identity": b, "pip_type": "rook", "wired": True}]
        self.assertEqual(named_pips(marks), [{"identity": a, "label": "Scout", "pip_type": "scout"},
                                             {"identity": b, "label": "Rook", "pip_type": "rook"}])
        self.assertEqual(named_pips(None), [])
