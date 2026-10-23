"""The terminal's turn end: a finished turn that used tools says "Worked for 43s · 5 tools" above its answer, as
the editor's fold row does; every other end keeps "· done · 3s" under the turn."""
import re
import types
import unittest

ANSI_ESCAPE = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def bare_tui():
    from dgc.tui import TUI
    tui = object.__new__(TUI)
    tui.app = None
    tui._width = 100
    tui._height = 30
    tui._follow = True
    tui._scroll_off = 0
    tui._tool_count = 0
    tui.blocks = []
    tui.config = types.SimpleNamespace(get=lambda key, default=None: default)
    return tui


def plain(block) -> str:
    if isinstance(block, dict):
        return f"<{block.get('kind')}:{block.get('text') or block.get('name')}>"
    return ANSI_ESCAPE.sub("", block).strip()


class WorkedForTests(unittest.TestCase):
    def setUp(self):
        self.tui = bare_tui()

    def turn(self, *blocks, tools=0):
        self.tui.blocks = [{"kind": "user", "text": "fix the test"}, *blocks]
        self.tui._tool_count = tools
        return self.tui

    def lines(self):
        return [plain(block) for block in self.tui.blocks]

    def test_a_finished_turn_with_steps_says_worked_for_above_its_answer(self):
        self.turn({"kind": "md", "text": "Looking at the test first."},
                  {"kind": "tool", "name": "bash"}, {"kind": "tool", "name": "edit_file"},
                  {"kind": "md", "text": "Fixed: the test now waits for the server."}, tools=2)
        self.tui._mark_turn_end("done", 43.7)
        self.assertEqual(self.lines(), [
            "<user:fix the test>", "<md:Looking at the test first.>", "<tool:bash>", "<tool:edit_file>",
            "· Worked for 43s · 2 tools", "<md:Fixed: the test now waits for the server.>"])

    def test_an_answer_in_several_parts_gets_the_line_above_its_first_part(self):
        self.turn({"kind": "tool", "name": "bash"}, {"kind": "md", "text": "Part one."},
                  {"kind": "md", "text": "Part two."}, tools=1)
        self.tui._mark_turn_end("done", 5)
        self.assertEqual(self.lines()[2:], ["· Worked for 5s · 1 tool", "<md:Part one.>", "<md:Part two.>"])

    def test_an_answer_with_no_steps_keeps_the_line_under_it(self):
        self.turn({"kind": "md", "text": "4."})
        self.tui._mark_turn_end("done", 3.2)
        self.assertEqual(self.lines(), ["<user:fix the test>", "<md:4.>", "· done · 3s"])

    def test_a_stopped_failed_or_paused_turn_keeps_the_line_under_it(self):
        for verb in ("stopped", "failed", "paused"):
            with self.subTest(verb=verb):
                self.turn({"kind": "tool", "name": "bash"}, {"kind": "md", "text": "So far."}, tools=1)
                self.tui._mark_turn_end(verb, 9)
                self.assertEqual(self.lines()[-2:], ["<md:So far.>", f"· {verb} · 9s · 1 tool"])

    def test_steps_with_no_answer_keep_the_line_under_them(self):
        self.turn({"kind": "tool", "name": "bash"}, tools=1)
        self.tui._mark_turn_end("done", 12)
        self.assertEqual(self.lines()[-2:], ["<tool:bash>", "· done · 12s · 1 tool"])

    def test_steps_from_an_earlier_turn_do_not_count(self):
        self.tui.blocks = [{"kind": "user", "text": "first"}, {"kind": "tool", "name": "bash"},
                           {"kind": "md", "text": "Done."}, "· Worked for 4s · 1 tool",
                           {"kind": "user", "text": "thanks"}, {"kind": "md", "text": "You're welcome."}]
        self.tui._tool_count = 1      # a counter that wasn't reset must not put the line above a reply with no steps
        self.tui._mark_turn_end("done", 2)
        self.assertEqual(self.lines()[-2:], ["<md:You're welcome.>", "· done · 2s · 1 tool"])


if __name__ == "__main__":
    unittest.main()
