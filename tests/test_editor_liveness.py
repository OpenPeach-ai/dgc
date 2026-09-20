"""A backend whose editor has gone away lets go of the session.

The founder hit this live: a Cursor reload on 192.168.1.111 left the old extension host alive for
25 hours with its `dgc serve` child still holding the session lease, so every new window was
refused with "this session has an active turn in another DGC process" and offered no way out. The
backend was behaving correctly by every check it had -- its stdin was open and its parent process
was alive -- because neither of those tells you the *window* is gone.

So the editor now says it is still there, and a backend that was being pinged and then stops being
pinged concludes the window closed. Two properties matter as much as the timeout itself: it never
arms for an editor that does not ping (an older build must keep working), and it never fires while
there is work in flight that the user would be sad to lose.

Nothing here sleeps or measures elapsed time. `check()` is driven directly and the clock is moved
by hand, so these tests cannot become the flaky ones they were written alongside.
"""
from __future__ import annotations

import io
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import editor_protocol as ep                       # noqa: E402
from dgc.headless import _EditorLiveness                    # noqa: E402


class _Stream(io.StringIO):
    """A command stream that records the close the watchdog uses to end the read loop."""

    def __init__(self) -> None:
        super().__init__()
        self.closed_by_watchdog = False

    def close(self) -> None:
        self.closed_by_watchdog = True
        super().close()


class _Monitors:
    def __init__(self, running=(), pending=0) -> None:
        self._running = list(running)
        self._pending = pending

    def running(self):
        return self._running

    def pending_count(self):
        return self._pending


def backend(*, busy=False, monitors=None, detached=None, goal="") -> SimpleNamespace:
    agent = SimpleNamespace(monitors=monitors or _Monitors(), _detached_jobs=detached or {},
                            goal=goal)
    return SimpleNamespace(agent=agent, _busy=lambda: busy)


def watcher(target, stream=None, *, after=900.0):
    return _EditorLiveness(target, stream if stream is not None else _Stream(), after=after)


def age(watch: _EditorLiveness, seconds: float) -> None:
    """Move the last-seen time into the past rather than waiting for the clock."""
    watch._last = time.monotonic() - seconds


class ArmingTest(unittest.TestCase):
    def test_an_editor_that_never_pings_is_never_abandoned(self):
        watch = watcher(backend())
        age(watch, 10_000)
        self.assertFalse(watch.check(), "an older editor must keep the previous behaviour")
        self.assertFalse(watch.abandoned)
        self.assertFalse(watch.stream.closed_by_watchdog)

    def test_one_ping_arms_it(self):
        watch = watcher(backend())
        watch.pinged()
        self.assertTrue(watch.armed)
        age(watch, 10_000)
        self.assertTrue(watch.check())
        self.assertTrue(watch.abandoned)

    def test_a_ping_before_the_deadline_keeps_it_alive(self):
        watch = watcher(backend(), after=900.0)
        watch.pinged()
        age(watch, 899)
        self.assertFalse(watch.check(), "inside the window")
        watch.pinged()                                      # the editor spoke again
        self.assertFalse(watch.check())
        self.assertFalse(watch.abandoned)

    def test_any_command_counts_as_the_editor_being_alive(self):
        watch = watcher(backend())
        watch.pinged()
        age(watch, 10_000)
        watch.saw_command()                                 # a prompt, a mode change, anything
        self.assertFalse(watch.check())


class WorkInFlightTest(unittest.TestCase):
    """Whatever the clock says, work the user would lose keeps the backend alive."""

    def _abandoned_with(self, **kwargs) -> bool:
        watch = watcher(backend(**kwargs))
        watch.pinged()
        age(watch, 10_000)
        return watch.check()

    def test_a_running_turn_keeps_it(self):
        self.assertFalse(self._abandoned_with(busy=True))

    def test_a_live_monitor_keeps_it(self):
        self.assertFalse(self._abandoned_with(monitors=_Monitors(running=["build"])))

    def test_a_monitor_with_unread_events_keeps_it(self):
        self.assertFalse(self._abandoned_with(monitors=_Monitors(pending=3)))

    def test_a_detached_subagent_keeps_it(self):
        self.assertFalse(self._abandoned_with(detached={"a1": object()}))

    def test_an_open_goal_keeps_it(self):
        self.assertFalse(self._abandoned_with(goal="ship the release"))

    def test_an_idle_backend_is_released(self):
        self.assertTrue(self._abandoned_with())

    def test_unreadable_state_keeps_it_rather_than_guessing(self):
        class Exploding:
            def running(self):
                raise RuntimeError("monitor hub is mid-restart")

            def pending_count(self):
                return 0

        watch = watcher(backend(monitors=Exploding()))
        watch.pinged()
        age(watch, 10_000)
        self.assertFalse(watch.check(), "a watchdog that cannot read the state must not act on it")
        self.assertIn("unreadable", watch.working())

    def test_the_reason_names_the_work(self):
        self.assertEqual(watcher(backend(busy=True)).working(), "a turn is running")
        self.assertIn("monitor", watcher(backend(monitors=_Monitors(running=["x"]))).working())
        self.assertIn("sub-agent", watcher(backend(detached={"a": 1})).working())
        self.assertIn("goal", watcher(backend(goal="g")).working())
        self.assertEqual(watcher(backend()).working(), "")


class EndingTest(unittest.TestCase):
    def test_it_ends_by_closing_the_stream_not_by_signalling(self):
        stream = _Stream()
        watch = watcher(backend(), stream)
        watch.pinged()
        age(watch, 10_000)
        self.assertTrue(watch.check())
        self.assertTrue(stream.closed_by_watchdog,
                        "the read loop must end through its normal end-of-input path, so the "
                        "transcript is persisted and the session lease released")

    def test_it_only_fires_once(self):
        watch = watcher(backend())
        watch.pinged()
        age(watch, 10_000)
        self.assertTrue(watch.check())
        self.assertFalse(watch.check(), "a second close would be a no-op at best")

    def test_a_stream_that_will_not_close_still_marks_it_abandoned(self):
        class Stubborn(_Stream):
            def close(self):
                raise OSError("already gone")

        watch = watcher(backend(), Stubborn())
        watch.pinged()
        age(watch, 10_000)
        self.assertTrue(watch.check())
        self.assertTrue(watch.abandoned)

    def test_describe_reports_the_wait_for_the_log(self):
        watch = watcher(backend(), after=900.0)
        watch.pinged()
        age(watch, 1000)
        watch.check()
        described = watch.describe()
        self.assertIn("no editor traffic", described)
        self.assertIn("900", described)


class ProtocolTest(unittest.TestCase):
    def test_ping_is_a_valid_command(self):
        self.assertIsNone(ep.command_error({"type": "ping"}))

    def test_an_older_backend_rejects_it_without_dying(self):
        # The schema is how the backend decides; an unknown command becomes command_rejected in
        # _dispatch rather than ending the connection. Prove the shape a newer editor would send
        # is well formed, so the only thing an older build can do with it is reject it.
        self.assertIn("ping", ep.COMMAND_FIELDS)
        self.assertEqual(ep.COMMAND_FIELDS["ping"], {})


if __name__ == "__main__":
    unittest.main()


class RefusalRemedyTest(unittest.TestCase):
    """A refusal that offers nothing is what made the stale lease a dead end."""

    def test_the_message_says_what_will_happen_and_what_to_do(self):
        from dgc.agent import _HELD_SESSION_REMEDY
        self.assertIn("releases the session", _HELD_SESSION_REMEDY,
                      "say that a stranded backend now lets go by itself")
        self.assertIn("new session", _HELD_SESSION_REMEDY,
                      "and what the user can do right now")
        self.assertNotIn("Wait for it to finish", _HELD_SESSION_REMEDY,
                         "waiting was the whole problem: the other window was never coming back")

    def test_the_remedy_matches_what_the_watchdog_actually_does(self):
        from dgc.headless import ABANDONED_AFTER_S
        from dgc.agent import _HELD_SESSION_REMEDY
        minutes = int(ABANDONED_AFTER_S // 60)
        self.assertIn(f"{minutes} minutes", _HELD_SESSION_REMEDY,
                      "the promise in the message must track the constant, not drift from it")


class DocumentedTest(unittest.TestCase):
    """Documentation is a release gate here: a behaviour change lands in /docs with the change."""

    def _sessions_page(self) -> str:
        from dgc import docs
        page = docs.find("Sessions & rewind")
        self.assertIsNotNone(page, "the Sessions page must exist")
        # Docs are wrapped prose, so a phrase can straddle a line break. Match on the words, not
        # on where the paragraph happens to wrap.
        return " ".join(page[2].split())

    def test_the_lease_and_how_it_is_released_are_documented(self):
        body = self._sessions_page()
        self.assertIn("active turn in another DGC process", body,
                      "the message a user will search for must appear in the docs")
        self.assertIn("still there", body, "say that the editor reports liveness")
        for promise in ("turn running", "monitor", "sub-agent", "goal"):
            self.assertIn(promise, body,
                          f"the docs must say a live {promise} keeps the backend up")

    def test_the_documented_wait_matches_the_constant(self):
        from dgc.headless import ABANDONED_AFTER_S
        body = self._sessions_page()
        # Fifteen minutes, spelled the way the page spells it.
        self.assertEqual(ABANDONED_AFTER_S, 15 * 60.0)
        self.assertIn("fifteen minutes", body,
                      "the documented wait must track ABANDONED_AFTER_S, not drift from it")
