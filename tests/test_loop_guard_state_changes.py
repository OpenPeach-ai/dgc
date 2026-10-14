"""The identical-call loop guard and steps that change state (dgc/agent.py _forget_reads_after_action): a Pip that
keeps going on its computer reads the same page again after a click, which is a new look, not a loop. An action
repeated with the same arguments is still a loop."""
import json
import unittest

from dgc.agent import _LOOP_HARD, _forget_reads_after_action, _note_new_look


def sig(name, **args):
    return (name, json.dumps(args, sort_keys=True, default=str))


class StateChangeTests(unittest.TestCase):
    def count(self, counts, name, out="same page", outputs=None, **args):
        """As the run loop does: before the call, a state change forgets the reads; after it, a read that differs
        from the same read before forgets the actions."""
        _forget_reads_after_action(counts, name, args)
        key = sig(name, **args)
        counts[key] = counts.get(key, 0) + 1
        if outputs is not None:
            _note_new_look(counts, outputs.get(key), name, args, out)
            outputs[key] = out
        return counts[key]

    def test_a_read_after_a_click_is_a_new_look(self):
        counts, outputs = {}, {}
        for page in range(20):                    # read, click Next, read the next page: a long computer session
            self.assertEqual(self.count(counts, "computer", f"page {page}", outputs, op="read"), 1)
            self.count(counts, "computer", "clicked", outputs, op="click", args={"ref": "e12"})
        self.assertLessEqual(max(counts.values()), _LOOP_HARD)

    def test_clicking_and_reading_a_page_that_never_changes_is_a_loop(self):
        counts, outputs = {}, {}
        for n in range(1, 8):
            self.count(counts, "computer", "the same page", outputs, op="read")
            self.assertEqual(self.count(counts, "computer", "clicked", outputs, op="click", args={"ref": "e12"}), n)

    def test_the_same_action_again_and_again_is_still_a_loop(self):
        counts = {}
        for n in range(1, 8):
            self.assertEqual(self.count(counts, "computer", op="click", args={"ref": "e12"}), n)

    def test_reads_with_nothing_between_are_still_counted(self):
        counts = {}
        for n in range(1, 5):
            self.assertEqual(self.count(counts, "computer", op="read"), n)

    def test_the_browser_is_the_same_and_other_tools_untouched(self):
        counts = {sig("read_file", path="a.py"): 3}
        self.count(counts, "browser", operation="snapshot")
        self.count(counts, "browser", operation="click", ref="e3")
        self.assertEqual(self.count(counts, "browser", operation="snapshot"), 1)
        self.assertEqual(counts[sig("read_file", path="a.py")], 3, "another tool's count is its own")
        self.count(counts, "computer", op="weird")    # not a state-changing step
        self.assertEqual(counts[sig("browser", operation="snapshot")], 1)


if __name__ == "__main__":
    unittest.main()
