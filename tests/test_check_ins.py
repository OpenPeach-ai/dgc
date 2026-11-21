"""Check-ins (his call, 18 Nov: "Build it in 0.52"; his idea, 14 Nov).

When the model starts a background command or a background sub-agent it says how long it expects (expect_minutes). Its
end already wakes the chat. Past that time, or when it has printed nothing new (taken no new step) for 10 minutes, DGC
checks in: one note with its latest output or steps, so the model decides whether to keep going, correct it, stop it,
or start it again better. Keeping going needs nothing: the next check-in comes later, the gap growing (at least five
minutes, at most an hour). A job with no expected time (a dev server, a watcher) is never checked in on.
"""
from __future__ import annotations

import unittest

from dgc import monitors


class Hub(unittest.TestCase):
    def setUp(self):
        self.hub = monitors.MonitorHub("test", {}, ".")
        self.hub._manual_ticks = True                # the test drives the clock
        self.addCleanup(self.hub.shutdown)
        self.out = 0
        self.lines = ["compiling 1/40", "compiling 2/40"]
        self.alive = True

    def watch(self, expect=10, kind="command"):
        self.hub.watch("bg1", "npm run build", kind=kind, expect_minutes=expect, started=1000.0,
                       progress=lambda: self.out if self.alive else None, tail=lambda: list(self.lines), now=1000.0)

    def due(self, minutes):
        return self.hub.check_ins_due(now=1000.0 + minutes * 60)

    def notes(self):
        note = self.hub.take_pending()
        return [] if note is None else note.batches

    def test_past_its_time_one_check_in_with_its_latest_output(self):
        self.watch(10)
        self.assertEqual(self.due(9), 0)
        self.out = 5
        self.assertEqual(self.due(10), 1)
        [batch] = self.notes()
        self.assertEqual(batch.kind, "check_in")
        self.assertIn("running 10 min, past the 10 you expected", batch.lines[0])
        self.assertIn("compiling 2/40", "\n".join(batch.lines))
        self.assertIn("bash_kill", "\n".join(batch.lines), "how to stop it")
        text = monitors.render_notification([batch])
        self.assertIn("checking in", text)
        self.assertIn("NOT a message from the user", text)

    def test_keeping_going_needs_nothing_and_the_gap_grows(self):
        self.watch(10)
        self.out = 1
        self.assertEqual(self.due(10), 1)
        self.notes()
        self.out = 2
        self.assertEqual(self.due(14), 0, "at least five minutes apart")
        self.assertEqual(self.due(15), 1)
        self.notes()
        self.out = 3
        self.assertEqual(self.due(24), 0, "the gap grows")
        self.assertEqual(self.due(25), 1)

    def test_quiet_for_ten_minutes_checks_in_early(self):
        self.watch(60)
        self.out = 1
        self.due(1)                                   # it printed something at minute 1
        self.assertEqual(self.due(10), 0)
        self.assertEqual(self.due(11), 1)
        [batch] = self.notes()
        self.assertIn("nothing new for 10 min", batch.lines[0])

    def test_a_quiet_server_is_checked_in_on_once_not_every_five_minutes(self):
        # (His 21 Nov session: an idle dev server woke the session every five minutes, hours after its turn ended,
        # and the model said "no action needed" each time.)
        self.watch(5)
        self.out = 1
        self.assertEqual(self.due(5), 1, "past its time: once")
        self.notes()
        woke = sum(self.due(m) for m in range(6, 240))
        self.assertEqual(woke, 0, "nothing new since it was looked at: no more wakes")
        self.out = 2                                   # it printed again (a rebuild)
        self.assertEqual(sum(self.due(m) for m in range(240, 400)), 1, "something new: one more look")

    def test_quiet_check_ins_follow_the_growing_gap(self):
        self.watch(600)
        self.out = 1
        self.due(1)
        self.assertEqual(self.due(11), 1)
        self.notes()
        self.out = 2
        self.due(12)
        self.assertEqual(sum(self.due(m) for m in range(13, 16)), 0, "its next look waits for the gap")
        self.assertEqual(self.due(16), 1)
        self.notes()
        self.assertEqual(sum(self.due(m) for m in range(17, 120)), 0, "and nothing new: none after")

    def test_a_job_that_ended_or_has_no_time_is_never_checked_in_on(self):
        self.watch(10)
        self.alive = False
        self.assertEqual(self.due(30), 0)
        self.assertEqual(self.hub.watched(), [], "it is dropped once it ends")
        self.hub.watch("bg2", "npm run dev", kind="command", expect_minutes=0, started=1000.0,
                       progress=lambda: 0, tail=lambda: [], now=1000.0)
        self.assertEqual(self.hub.watched(), [], "a server or a watcher: no check-ins")

    def test_a_sub_agent_is_told_how_to_correct_or_stop_it(self):
        self.watch(20, kind="agent")
        self.out = 3
        self.due(20)
        [batch] = self.notes()
        self.assertIn("message_task", "\n".join(batch.lines))
        self.assertIn("close_task", "\n".join(batch.lines))

    def test_a_replaced_conversation_forgets_them(self):
        self.watch(10)
        self.hub.new_epoch()
        self.assertEqual(self.hub.watched(), [])

    def test_the_editor_sees_it_as_an_ordinary_event(self):
        # The released monitor_event names three kinds; a check-in travels as "output" (never a new protocol value).
        self.assertEqual(monitors.wire_kind("check_in"), "output")
        self.assertEqual(monitors.wire_kind("background_exit"), "background_exit")


class BackgroundCommands(unittest.TestCase):
    """The real bash tool: a background command started with an expected time is watched, until it ends."""

    def setUp(self):
        import tempfile
        from pathlib import Path
        from tests.test_monitors import Ctx, make_config
        tmp = tempfile.TemporaryDirectory(prefix="dgc-check-ins-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.hub = monitors.MonitorHub("owner", make_config(self.root), self.root)
        self.hub._manual_ticks = True
        self.addCleanup(lambda: self.hub.shutdown(wait=2.0))
        self.ctx = Ctx(self.root, make_config(self.root), self.hub)

    def test_watched_with_its_time_and_told_so_and_dropped_when_killed(self):
        import time
        from dgc import tools
        out = tools.bash({"command": "echo step 1; sleep 30", "background": True, "expect_minutes": 5,
                          "_dgc_notify_exit": True}, self.ctx)
        self.assertIn("DGC checks in with you if it runs past 5 min", out)
        bid = out.split()[3].rstrip(":")
        self.assertEqual(self.hub.watched(), [bid])
        time.sleep(0.3)
        self.assertEqual(self.hub.check_ins_due(now=time.time() + 5 * 60 + 1), 1)
        [batch] = self.hub.take_pending().batches
        self.assertIn("step 1", batch.lines)
        tools.bash_kill({"id": bid}, self.ctx)
        self.hub.check_ins_due(now=time.time() + 30 * 60)
        self.assertEqual(self.hub.watched(), [], "a stopped command is never checked in on")

    def test_no_time_no_watch(self):
        from dgc import tools
        out = tools.bash({"command": "sleep 2", "background": True, "_dgc_notify_exit": True}, self.ctx)
        self.assertNotIn("checks in", out)
        self.assertEqual(self.hub.watched(), [])


class BackgroundSubAgents(unittest.TestCase):
    """Work's real agent: a background task started with an expected time is watched while it works."""

    def test_watched_while_it_works_and_dropped_when_it_ends(self):
        import tempfile
        import threading
        from pathlib import Path
        from dgc.llm import ToolCall
        from tests.test_subagents import Harness, calls_then
        from dgc.llm import ChatResult
        tmp = tempfile.TemporaryDirectory(prefix="dgc-check-ins-agent-")
        self.addCleanup(tmp.cleanup)
        harness = Harness(Path(tmp.name), mode="auto")
        self.addCleanup(harness.close)
        harness.agent.monitors._manual_ticks = True
        release, seen = threading.Event(), {}

        def helper(messages, results, cancel):
            seen["watched"] = harness.agent.monitors.watched()
            release.wait(10)
            return ChatResult(content="helper done", usage={})
        task = ToolCall("t1", "task", {"description": "Check the links", "prompt": "HELPER: check every link",
                                       "background": True, "expect_minutes": 7})
        routes = [("HELPER", helper), ("go", calls_then([task], final="started it"))]
        import time
        from unittest.mock import patch
        from dgc.config import Config
        from dgc.llm import LLMClient
        from tests.test_subagents import Script, clone_fixture
        # The script answers for the helper too, which outlives the turn: patched for the whole test.
        with patch.object(LLMClient, "chat", Script(routes)), patch.object(Config, "clone_for_root", clone_fixture):
            harness.ui.turn_id = "t1"
            harness.agent.run_turn("go")
            deadline = time.monotonic() + 10
            while "watched" not in seen and time.monotonic() < deadline:
                time.sleep(0.02)
            self.assertEqual(len(seen.get("watched") or []), 1, "its helper is watched while it works")
            release.set()
            deadline = time.monotonic() + 10
            while getattr(harness.agent, "_detached_jobs", None) and time.monotonic() < deadline:
                time.sleep(0.02)
        harness.agent.monitors.check_ins_due(now=time.time() + 3600)
        self.assertEqual(harness.agent.monitors.watched(), [], "an ended helper is never checked in on")


from tests.test_pip_computer_desk import BOXES  # noqa: E402


@unittest.skipUnless(BOXES, "needs Linux and a working bubblewrap")
class PipBackgroundCommands(unittest.TestCase):
    """A Pip's background command: its end tells the Pip, and with an expected time DGC checks in on it."""

    def setUp(self):
        import shutil
        import tempfile
        from pathlib import Path
        from dgc import pip_computer_files as desk
        from tests.test_pip_computer_jobs import _end_leftovers
        self.desk = desk
        self.root = Path(tempfile.mkdtemp(prefix="dgc-checkins-")) / "computer"
        self.addCleanup(shutil.rmtree, self.root.parent, True)
        self.addCleanup(_end_leftovers, str(self.root.parent))
        (self.root / "home").mkdir(parents=True)
        desk.files_root(self.root).mkdir(parents=True, exist_ok=True)

    def tearDown(self):
        for job in self.desk.jobs(self.root):
            if job["state"] == "running":
                self.desk.stop_job(self.root, job["id"])

    def wait(self, check, seconds=20):
        import time
        end = time.monotonic() + seconds
        while time.monotonic() < end:
            if check():
                return True
            time.sleep(0.1)
        return check()

    def test_its_end_is_told_once_and_a_stopped_one_is_not(self):
        ended = []
        job = self.desk.start_background(self.root, "echo built; echo done", "pip", on_end=ended.append)
        self.assertTrue(self.wait(lambda: ended), "its end tells whoever started it")
        self.assertEqual((ended[0]["id"], ended[0]["state"], ended[0]["exit"]), (job["id"], "finished", 0))
        self.assertIn("done", ended[0]["output"])
        stopped = []
        long = self.desk.start_background(self.root, "sleep 30", "pip", on_end=stopped.append)
        self.desk.stop_job(self.root, long["id"])
        self.assertFalse(self.wait(lambda: stopped, 2), "a job stopped on purpose isn't news")

    def test_past_its_time_it_is_checked_in_on_with_its_latest_lines(self):
        import time
        job = self.desk.start_background(self.root, "for i in 1 2 3; do echo line $i; done; sleep 30", "pip",
                                         expect_minutes=5, meta={"pip_id": "pip_x", "run_id": "run_y"})
        self.assertTrue(self.wait(lambda: self.desk._live_tail(job["id"])), "its output is there as it runs")
        self.assertEqual(self.desk.check_ins_due(now=time.time() + 60), [])
        [item] = self.desk.check_ins_due(now=time.time() + 5 * 60 + 1)
        self.assertEqual((item["job"], item["meta"]), (job["id"], {"pip_id": "pip_x", "run_id": "run_y"}))
        self.assertIn("past the 5 you expected", item["head"])
        self.assertIn("line 3", item["tail"])
        self.desk.stop_job(self.root, job["id"])
        self.wait(lambda: job["id"] not in self.desk._LIVE, 5)
        self.assertEqual(self.desk.check_ins_due(now=time.time() + 3600), [], "a stopped job is never checked in on")

    def test_no_expected_time_no_check_ins(self):
        import time
        job = self.desk.start_background(self.root, "sleep 30", "pip")
        self.assertEqual(self.desk.check_ins_due(now=time.time() + 3600), [])
        self.desk.stop_job(self.root, job["id"])


class PipChatTurns(unittest.TestCase):
    """The turns DGC writes in the Pip's chat: hidden (a DGC key), never the user's own."""

    def setUp(self):
        from tests import test_pips_local as local
        local.LocalPipsTests.setUp(self)
        self.pip = self.store.create(self.registry.personal()["id"], "Builder", "Build my site", "editor-user")

    def test_its_end_and_a_check_in_are_dgc_turns_in_its_chat(self):
        from dgc import pip_chat, pip_computer, pip_notes
        from unittest.mock import patch
        mine = pip_chat.send(self.store, self.pip["id"], "Build the site in the background", "k-1", "editor-user",
                             self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(mine["id"], result={"text": "Started the build."})
        pip_chat.after_job(self.store, self.pip["id"], {"id": "job_1a2b3c4d", "command": "make site", "state": "finished",
                                                        "exit": 0, "output": "wrote 12 pages\nok", "started": 100,
                                                        "ended": 400}, mine["id"], self.cfg)
        turn = self.registry.db.execute("SELECT run_id,request_key,text FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                        "ORDER BY seq DESC LIMIT 1", (self.pip["id"],)).fetchone()
        self.assertTrue(turn["request_key"].startswith(pip_chat.JOB_KEY))
        self.assertIn("`make site` finished (exit 0) after 5 min", turn["text"])
        self.assertIn("wrote 12 pages", turn["text"])
        run = self.store.claim_next()
        self.assertIsNone(pip_notes.user_turn(self.registry, run), "never the user's own turn")
        self.store.finish(run["id"], result={"text": "The site is built: 12 pages."})
        item = {"job": "job_1a2b3c4d", "command": "make site", "head": "running 12 min, past the 10 you expected",
                "tail": ["page 9 of 12"], "gap_minutes": 5, "meta": {"pip_id": self.pip["id"], "run_id": mine["id"]},
                "check": 1234}
        with patch("dgc.pip_computer_files.check_ins_due", return_value=[item]):
            self.assertEqual(pip_computer.job_check_ins(self.registry, self.cfg), 1)
        turn = self.registry.db.execute("SELECT text FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                        "ORDER BY seq DESC LIMIT 1", (self.pip["id"],)).fetchone()
        self.assertIn("Checking in on your background command `make site` (job_1a2b3c4d)", turn["text"])
        self.assertIn("stop_job job_1a2b3c4d", turn["text"])


class TheEditorEvent(unittest.TestCase):
    def test_a_check_in_reaches_the_editor_as_an_output_event(self):
        import inspect
        from dgc import headless
        self.assertIn("kind=wire_kind(batch.kind)", inspect.getsource(headless))
        from dgc.editor_protocol import EVENT_FIELDS
        allowed = EVENT_FIELDS["monitor_event"]["kind"]
        self.assertIn(monitors.wire_kind("check_in"), str(allowed))


if __name__ == "__main__":
    unittest.main()
