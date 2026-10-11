"""Writing blocks (ChatGPT's): a draft the user will send as it is sits in an ```email or ```draft block, and an edit
made in place replaces exactly that block's words in the saved reply, so the model reads the user's version next."""
import unittest

from dgc.chatdgc.engine import _with_draft
from dgc.chatdgc.prompt import DRAFTS, system_prompt

EMAIL = "Subject: Moving out\n\nDear Mr Rao,\n\nI'm leaving flat 4B on 30 November."


class Drafts(unittest.TestCase):
    def test_the_model_is_told_to_put_a_draft_in_its_own_block(self):
        self.assertIn(DRAFTS, system_prompt())
        self.assertIn("```email (on that same line)", DRAFTS)
        self.assertIn("```draft for anything else", DRAFTS)

    def test_an_edit_replaces_only_that_blocks_words(self):
        reply = f"Here it is.\n\n```email\n{EMAIL}\n```\n\nAnd as code:\n\n```text\n{EMAIL}\n```\n"
        edited = EMAIL.replace("Dear Mr Rao", "Dear Mr and Mrs Rao")
        self.assertEqual(_with_draft(reply, EMAIL, edited),
                         f"Here it is.\n\n```email\n{edited}\n```\n\nAnd as code:\n\n```text\n{EMAIL}\n```\n",
                         "a code block with the same words is not a draft")

    def test_the_label_on_its_own_line_inside_a_list_and_a_block_cut_short(self):
        split = "Try:\n\n```\ndraft\nHey all, party at 7!\n```"
        self.assertEqual(_with_draft(split, "Hey all, party at 7!", "Hey all, party at 8!"),
                         "Try:\n\n```\ndraft\nHey all, party at 8!\n```")
        listed = "1. Send this:\n\n   ```draft\n   Thanks for today.\n   ```\n2. Then rest."
        self.assertEqual(_with_draft(listed, "Thanks for today.", "Thanks for today.\n\nSee you soon."),
                         "1. Send this:\n\n   ```draft\n   Thanks for today.\n\n   See you soon.\n   ```\n2. Then rest.",
                         "indented as the fence is, so it stays in the list")
        cut = "```email\nSubject: Hi\n\nHello"
        self.assertEqual(_with_draft(cut, "Subject: Hi\n\nHello", "Subject: Hi\n\nHello there"), "```email\nSubject: Hi\n\nHello there")

    def test_words_that_changed_since_find_nothing(self):
        self.assertIsNone(_with_draft(f"```email\n{EMAIL}\n```", "Subject: Something else", "x"))
        self.assertIsNone(_with_draft(f"```python\nprint(1)\n```", "print(1)", "print(2)"))


if __name__ == "__main__":
    unittest.main()
