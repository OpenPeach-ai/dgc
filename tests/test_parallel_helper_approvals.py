"""Concurrent helpers share one approval lane and use live permission rechecks."""
import threading
import time
import unittest

from dgc.agent import _SubUI, interaction_helper_label


class ParallelApprovalTest(unittest.TestCase):
    def test_helper_model_usage_is_not_attributed_to_the_parent_trace(self):
        class Parent:
            def __init__(self):
                self.trace_tokens = []
            def trace_usage(self, tokens):
                self.trace_tokens.append(tokens)

        parent = Parent()
        _SubUI(parent, "Reviewer").trace_usage(420)
        self.assertEqual(parent.trace_tokens, [])

    def test_always_allow_recheck_skips_the_next_card(self):
        class Parent:
            deny_reason = ""
            def __init__(self):
                self.calls = []
                self.allowed = False
                self.first_open = threading.Event()
                self.release = threading.Event()

            def approve_live(self, name, args, call_id, *, recheck=None):
                self.calls.append((name, call_id, interaction_helper_label()))
                self.first_open.set()
                self.release.wait(2)
                return "always"

            def add_permission_rule(self, name, args):
                self.allowed = True
                return "Bash"

        parent = Parent()
        lock = threading.Lock()
        first = _SubUI(parent, "Read invoices", interaction_lock=lock, cancel=threading.Event())
        second = _SubUI(parent, "Read orders", interaction_lock=lock, cancel=threading.Event())
        answers = {}
        def approve_and_save():
            answers["first"] = first.approve_live("bash", {}, "a")
            if answers["first"] == "always":
                first.add_permission_rule("bash", {})

        one = threading.Thread(target=approve_and_save)
        two = threading.Thread(target=lambda: answers.setdefault("second", second.approve_live(
            "bash", {}, "b", recheck=lambda: "once" if parent.allowed else None)))
        one.start()
        self.assertTrue(parent.first_open.wait(2))
        two.start()
        time.sleep(0.05)
        self.assertEqual(len(parent.calls), 1, "approval cards overlapped")
        parent.release.set()
        one.join(2)
        two.join(2)
        self.assertEqual(answers, {"first": "always", "second": "once"})
        self.assertEqual(parent.calls, [("bash", first.agent_id + ":a", "Read invoices")])

    def test_stopped_helper_waiting_for_the_lane_does_not_open_a_card(self):
        class Parent:
            deny_reason = ""
            def __init__(self):
                self.calls = []
                self.open = threading.Event()
                self.release = threading.Event()

            def approve_live(self, name, args, call_id, *, recheck=None):
                self.calls.append(call_id)
                self.open.set()
                self.release.wait(2)
                return "once"

        parent = Parent()
        lock = threading.Lock()
        first = _SubUI(parent, "One", interaction_lock=lock, cancel=threading.Event())
        stop = threading.Event()
        second = _SubUI(parent, "Two", interaction_lock=lock, cancel=stop)
        answers = {}
        one = threading.Thread(target=lambda: answers.setdefault("one", first.approve_live("bash", {}, "a")))
        two = threading.Thread(target=lambda: answers.setdefault("two", second.approve_live("bash", {}, "b")))
        one.start()
        self.assertTrue(parent.open.wait(2))
        two.start()
        stop.set()
        parent.release.set()
        one.join(2)
        two.join(2)
        self.assertEqual(answers, {"one": "once", "two": "no"})
        self.assertEqual(parent.calls, [first.agent_id + ":a"])

    def test_nested_helper_releases_both_lanes_after_one_time_always(self):
        class Parent:
            deny_reason = ""
            def approve_live(self, name, args, call_id, *, recheck=None):
                return "always"

        outer_lock, inner_lock = threading.Lock(), threading.Lock()
        outer = _SubUI(Parent(), "Outer", interaction_lock=outer_lock)
        inner = _SubUI(outer, "Inner", interaction_lock=inner_lock)
        self.assertEqual(inner.approve_live("bash", {}, "step"), "always")
        inner.finish_approval()  # credential-bearing approval saves no rule
        self.assertTrue(inner_lock.acquire(blocking=False))
        inner_lock.release()
        self.assertTrue(outer_lock.acquire(blocking=False))
        outer_lock.release()


if __name__ == "__main__":
    unittest.main()
