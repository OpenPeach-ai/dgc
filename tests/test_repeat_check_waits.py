"""Checking a running task again with nothing new since the last check waits instead of answering at once.

The goal soak (16 Nov): in one hour 233 of 270 saved steps were the model saying "Still waiting on the full
verification run." and checking the same background run again (bash_output, "(no output yet)"), each one a whole model
request over a long context. The prompt already says never to poll. Now DGC makes a repeated check cost nothing: when
bash_output is asked for the newest output of a task that is still running and nothing has changed since this caller's
last look (no new output, no change in how it is running), it waits until new output comes, the task's state changes or
tools.REPEAT_CHECK_WAIT_S passes, then answers as before. Paging (offset, query) and a task that has ended never wait,
and Stop ends a wait at once.

A fake task stands in for a process: its output and its end are driven by the test.
"""
from __future__ import annotations

import threading
import time
import types
import unittest
import uuid
from unittest import mock

from dgc import tools


class FakeProc:
    def __init__(self):
        self.returncode = None
        self.pid = 999_999_999

    def poll(self):
        return self.returncode


class Case(unittest.TestCase):
    def setUp(self):
        self.ctx = types.SimpleNamespace(tool_owner="owner-" + uuid.uuid4().hex, cancelled=threading.Event(),
                                         monitors=None)
        self.proc = FakeProc()
        self.bid = "bgfake" + uuid.uuid4().hex[:8]
        self.entry = {"proc": self.proc, "buf": [], "buf_chars": 0, "dropped_chars": 0, "bytes_written": 0,
                      "lock": threading.Lock(), "command": "python3 -m unittest discover",
                      "owner": self.ctx.tool_owner, "started": time.time(), "finished": None, "thread": None,
                      "killed": False, "notify_epoch": 0, "on_change": None}
        with tools._BG_LOCK:
            tools._BG[self.bid] = self.entry
        self.addCleanup(lambda: tools._BG.pop(self.bid, None))
        patcher = mock.patch.object(tools, "REPEAT_CHECK_WAIT_S", 1.0, create=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def check(self, **args):
        started = time.monotonic()
        out = tools.bash_output({"id": self.bid, **args}, self.ctx)
        return out, time.monotonic() - started

    def later(self, seconds, action):
        timer = threading.Timer(seconds, action)
        timer.daemon = True
        timer.start()
        self.addCleanup(timer.cancel)

    def prints(self, text):
        tools._bg_append(self.entry, text)

    def ends(self, code=0):
        self.proc.returncode = code
        self.entry["finished"] = time.time()


class TheFirstLookAnswersAtOnce(Case):
    def test_the_first_check_never_waits(self):
        out, took = self.check(limit=10)
        self.assertIn("(no output yet)", out)
        self.assertLess(took, 0.3)

    def test_a_check_after_new_output_answers_at_once(self):
        self.check()
        self.prints("Ran 12 tests\n")
        out, took = self.check()
        self.assertIn("Ran 12 tests", out)
        self.assertLess(took, 0.3)


class ARepeatedCheckWaits(Case):
    def test_it_waits_for_new_output_and_returns_it(self):
        self.check(limit=10)
        self.later(0.3, lambda: self.prints("....F\n"))
        out, took = self.check(limit=10)
        self.assertIn("....F", out)
        self.assertGreaterEqual(took, 0.25)
        self.assertLess(took, 0.9, "it answers as soon as the output comes, not at the cap")

    def test_it_waits_for_the_task_to_end(self):
        self.prints("started\n")
        self.check()
        self.later(0.3, self.ends)
        out, took = self.check()
        self.assertIn("exited 0", out.split("\n", 1)[0])
        self.assertGreaterEqual(took, 0.25)
        self.assertLess(took, 0.9)

    def test_with_nothing_new_it_answers_at_the_cap_and_says_it_waited(self):
        self.check(limit=10)
        out, took = self.check(limit=10)
        self.assertGreaterEqual(took, 0.95)
        self.assertIn("(no output yet)", out)
        self.assertIn("Nothing new since your last check", out)

    def test_stop_ends_the_wait_at_once(self):
        self.check()
        self.later(0.2, self.ctx.cancelled.set)
        _out, took = self.check()
        self.assertLess(took, 0.6)


class WhatNeverWaits(Case):
    def test_paging_and_searching_never_wait(self):
        self.prints("one\ntwo\nthree\n")
        self.check()
        for args in ({"offset": 1, "limit": 2}, {"query": "two"}):
            with self.subTest(args=args):
                _out, took = self.check(**args)
                self.assertLess(took, 0.3)

    def test_a_persons_own_look_never_waits(self):
        """The terminal's /monitors show is the person looking, on the terminal's own thread."""
        self.check()
        started = time.monotonic()
        out = tools.bash_output({"id": self.bid}, self.ctx, model_look=False)
        self.assertLess(time.monotonic() - started, 0.3)
        self.assertIn("(no output yet)", out)

    def test_an_ended_task_never_waits(self):
        self.prints("done\n")
        self.ends()
        self.check()
        out, took = self.check()
        self.assertLess(took, 0.3)
        self.assertIn("exited 0", out)


if __name__ == "__main__":
    unittest.main()
