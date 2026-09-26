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


def watcher(target, stream=None, *, after=900.0, wake=None):
    return _EditorLiveness(target, stream if stream is not None else _Stream(), after=after,
                           wake=wake)


def age(watch: _EditorLiveness, seconds: float) -> None:
    """Move the last-seen time into the past rather than waiting for the clock."""
    watch._last = time.monotonic() - seconds


def age_renderer(watch: _EditorLiveness, seconds: float) -> None:
    """Move the chat panel's last statement into the past. The takeover clock, once it exists."""
    watch._last_renderer = time.monotonic() - seconds


def age_closed(watch: _EditorLiveness, seconds: float) -> None:
    """Move the host's "the view was disposed" claim into the past."""
    watch._view_closed_at = time.monotonic() - seconds


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
    def test_it_ends_the_read_loop_by_the_fastest_route_it_has(self):
        # The invariant is "the loop reaches its normal end of input, so the transcript is persisted
        # and the lease released" -- NOT "the stream was closed". The old name asserted the closing
        # of the stream as a proxy for that and so defended the bug: closing a stream another thread
        # is blocked reading takes the lock that reader holds, so the CLOSER blocks and the reader
        # comes out only when a byte happens to arrive. Where a signal can be sent, that is the
        # route; the close is the fallback for a platform with none.
        stream = _Stream()
        woke = []
        watch = watcher(backend(), stream, wake=lambda: woke.append(True))
        watch.pinged()
        age(watch, 10_000)
        self.assertTrue(watch.check())
        self.assertEqual(woke, [True], "the waker is the route where there is one")
        self.assertFalse(stream.closed_by_watchdog,
                         "and then the stream is NOT closed from this thread, which would block it")
        self.assertTrue(watch.abandoned)

    def test_with_no_waker_it_still_ends_the_loop_without_blocking_the_caller(self):
        stream = _Stream()
        watch = watcher(backend(), stream)
        watch.pinged()
        age(watch, 10_000)
        self.assertTrue(watch.check())
        # Off the calling thread by design: whoever stood us down must never be the thread that
        # blocks on the reader's lock.
        self.assertIsNotNone(watch._closer)
        watch._closer.join(2)
        self.assertTrue(stream.closed_by_watchdog)
        self.assertTrue(watch.abandoned)

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


class TheTakeoverClockTest(unittest.TestCase):
    """A takeover is decided on whether a WINDOW exists, not on whether a process is alive.

    This is the 25-hour bug's actual shape. A window reload leaves the extension host running --
    nothing in the VS Code API tells a host that it was orphaned -- so it goes on pinging, truthfully
    and uselessly, and every ping used to be read as "the window is fine". The chat panel's own
    webview is the one thing that cannot survive its window, so that is what the clock now counts.
    """

    def test_a_host_that_keeps_pinging_does_not_keep_the_session(self):
        watch = watcher(backend())
        watch.editor_state(source="renderer", view="open")
        age_renderer(watch, 200)
        watch.pinged()                  # the orphaned extension host, still on its 60s timer
        gone, _ = watch.editor_gone_for_takeover()
        self.assertTrue(gone, "a ping from a host whose window is gone must not hold the session")

    def test_without_renderer_evidence_the_traffic_clock_still_rules(self):
        # An older extension pings and knows nothing about `editor_state`. It must be judged exactly
        # as it shipped -- the alternative is that upgrading the CLI alone loses every session after
        # two minutes.
        watch = watcher(backend())
        watch.pinged()
        age(watch, 200)
        self.assertTrue(watch.editor_gone_for_takeover()[0])
        fresh = watcher(backend())
        fresh.pinged()
        age(fresh, 5)
        self.assertFalse(fresh.editor_gone_for_takeover()[0])

    def test_a_closed_view_buys_a_bounded_extra_wait_and_no_more(self):
        from dgc.headless import CLOSED_VIEW_GRACE_S, TAKEOVER_SILENCE_S
        watch = watcher(backend())
        watch.editor_state(source="renderer", view="open")
        age_renderer(watch, TAKEOVER_SILENCE_S + 5)
        watch.editor_state(source="host", view="closed")
        age_closed(watch, 5)
        self.assertFalse(watch.editor_gone_for_takeover()[0],
                         "the user unchecked the view: a live window with no panel to speak for it")
        age_renderer(watch, TAKEOVER_SILENCE_S + CLOSED_VIEW_GRACE_S + 5)
        self.assertTrue(watch.editor_gone_for_takeover()[0],
                        "bounded on purpose -- a host cannot prove its window is still there")

    def test_a_renderer_statement_clears_a_stale_closed_view_claim(self):
        from dgc.headless import TAKEOVER_SILENCE_S
        watch = watcher(backend())
        watch.editor_state(source="host", view="closed")
        watch.editor_state(source="renderer", view="open")
        age_renderer(watch, TAKEOVER_SILENCE_S + 1)
        self.assertTrue(watch.editor_gone_for_takeover()[0],
                        "the view came back, so one old closed claim must not buy 60s forever")

    def test_a_live_panel_is_on_screen_and_a_quiet_one_is_not(self):
        from dgc.headless import EDITOR_HEARTBEAT_S
        watch = watcher(backend())
        self.assertFalse(watch.renderer_on_screen(), "nothing has spoken yet")
        watch.editor_state(source="renderer", view="open")
        self.assertTrue(watch.renderer_on_screen())
        age_renderer(watch, 2 * EDITOR_HEARTBEAT_S + 1)
        self.assertFalse(watch.renderer_on_screen(),
                         "past two heartbeats it is a countdown, not a window on screen")

    def test_a_disposed_view_is_not_a_panel_on_screen(self):
        watch = watcher(backend())
        watch.editor_state(source="renderer", view="open")
        watch.editor_state(source="host", view="closed")
        self.assertFalse(watch.renderer_on_screen(),
                         "there is no panel then -- only a window that may or may not be there")

    def test_the_two_clocks_are_a_number_apart_that_cannot_drift(self):
        from dgc.headless import EDITOR_HEARTBEAT_S, TAKEOVER_SILENCE_S
        self.assertGreater(TAKEOVER_SILENCE_S, 4 * EDITOR_HEARTBEAT_S,
                           "a backgrounded window's timers can be throttled to once a minute; "
                           "losing a live session to a throttled renderer is the same bug in "
                           "the other direction")

    def test_the_heartbeat_the_backend_expects_is_the_one_the_panel_sends(self):
        # A drift gate between two files that must agree on one number. Not evidence of behaviour.
        import re
        from dgc.headless import EDITOR_HEARTBEAT_S
        panel = (PROJECT / "editors/vscode/media/main.js").read_text(encoding="utf-8")
        found = re.search(r"EDITOR_ALIVE_EVERY_MS\s*=\s*([0-9_]+)", panel)
        self.assertIsNotNone(found, "the panel must declare its heartbeat interval")
        self.assertEqual(int(found.group(1).replace("_", "")), int(EDITOR_HEARTBEAT_S * 1000))


class TheLogSaysWhichEndingItWasTest(unittest.TestCase):
    """A handover and a give-up are different events that used to print the same line."""

    def test_the_log_says_a_handover_was_a_handover(self):
        from dgc.headless import _liveness_end_cause
        handed = watcher(backend())
        handed.pinged()
        handed.stand_down()
        self.assertIn("handed this session", _liveness_end_cause(handed))
        self.assertNotIn("stopped talking", _liveness_end_cause(handed))
        gave_up = watcher(backend())
        gave_up.pinged()
        age(gave_up, 10_000)
        gave_up.check()
        self.assertIn("stopped talking", _liveness_end_cause(gave_up))

    def test_a_handover_gets_a_grace_that_fits_the_asker_s_budget(self):
        # Arithmetic, and labelled as such: a drift gate so nobody raises one constant alone. The
        # evidence that a handover completes is the live run, not this.
        from dgc.agent import _RECLAIM_WAIT_S
        from dgc.headless import SHUTDOWN_GRACE_S, STAND_DOWN_GRACE_S
        self.assertLessEqual(STAND_DOWN_GRACE_S + 2 + 2 + 1, _RECLAIM_WAIT_S,
                             "grace + worker join + monitor shutdown + session write must fit "
                             "inside the window the asking window actually waits")
        self.assertLess(STAND_DOWN_GRACE_S, SHUTDOWN_GRACE_S,
                        "somebody is at a keyboard waiting on a handover; nobody is waiting on a "
                        "backend that simply gave up")


class LivenessIsNotAUserActionTest(unittest.TestCase):
    """A heartbeat that looked like a user command starved every background monitor wake."""

    def _suppressions(self, command: dict) -> list:
        from dgc.headless import Backend
        seen: list = []
        fake = SimpleNamespace(_suppress_wakes=lambda on: seen.append(on),
                               _dispatch=lambda cmd: None)
        Backend.dispatch.__get__(fake)(command)
        return seen

    def test_a_heartbeat_is_not_treated_as_a_user_action(self):
        self.assertEqual(self._suppressions({"type": "ping"}), [])
        self.assertEqual(self._suppressions({"type": "editor_state", "source": "renderer",
                                             "view": "open"}), [])

    def test_a_real_command_still_is(self):
        self.assertEqual(self._suppressions({"type": "prompt", "text": "hi"}), [True, False])


class ProtocolTest(unittest.TestCase):
    def test_ping_is_a_valid_command(self):
        self.assertIsNone(ep.command_error({"type": "ping"}))

    def test_editor_state_is_a_valid_command(self):
        self.assertIsNone(ep.command_error({"type": "editor_state", "source": "renderer",
                                            "view": "open"}))
        self.assertIsNone(ep.command_error({"type": "editor_state", "source": "host",
                                            "view": "closed"}))

    def test_editor_state_fails_closed_on_anything_else(self):
        # Undeclared fields fail closed on this protocol -- which is exactly why nothing was added
        # to `ping` or to any existing event, and a whole new command was added instead.
        self.assertIsNotNone(ep.command_error({"type": "editor_state", "source": "renderer"}))
        self.assertIsNotNone(ep.command_error({"type": "editor_state", "source": "guess",
                                               "view": "open"}))
        self.assertIsNotNone(ep.command_error({"type": "editor_state", "source": "renderer",
                                               "view": "open", "window": 1}))

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


class WakingABlockedReaderTest(unittest.TestCase):
    """The defect that made a granted handover miss its own window, proved on a real pipe.

    `stand_down()` used to end the read loop by closing the command stream. CPython's
    ``BufferedReader.close()`` takes the same lock a blocked ``readline`` holds, so the closer blocks
    too and the reader comes out only when the next byte happens to arrive -- with a 60s editor ping
    that is ~30s on average against the 25s the asking window waits, so the window that had been
    granted the session usually reported a refusal anyway.

    Nothing is ever written to this pipe. That is the whole point: the read has to end with no byte.
    """

    @unittest.skipUnless(hasattr(signal := __import__("signal"), "SIGUSR1")
                         and hasattr(signal, "pthread_kill"),
                         "needs a signal we can send ourselves")
    def test_a_blocked_read_ends_with_no_byte_ever_written(self):
        import os
        import signal
        import threading as _threading

        from dgc import headless
        from dgc.headless import _ReadEnded

        read_fd, write_fd = os.pipe()
        self.addCleanup(os.close, write_fd)
        stream = os.fdopen(read_fd, "rb")
        self.addCleanup(stream.close)

        reader_ident = _threading.main_thread().ident
        previous = signal.signal(signal.SIGUSR1, lambda *_: (_ for _ in ()).throw(_ReadEnded()))
        self.addCleanup(signal.signal, signal.SIGUSR1, previous)

        # A refuted mutation must FAIL, not hang the suite: if the close-based route comes back, no
        # byte ever arrives and the read blocks forever.
        alarm_previous = signal.signal(signal.SIGALRM,
                                       lambda *_: (_ for _ in ()).throw(AssertionError(
                                           "the read never ended: closing the stream from another "
                                           "thread cannot interrupt a blocked readline")))
        signal.setitimer(signal.ITIMER_REAL, 5.0)
        self.addCleanup(signal.setitimer, signal.ITIMER_REAL, 0.0)
        self.addCleanup(signal.signal, signal.SIGALRM, alarm_previous)

        watch = _EditorLiveness(backend(), stream,
                                wake=lambda: signal.pthread_kill(reader_ident, signal.SIGUSR1))
        handover = _threading.Timer(0.2, watch.stand_down)
        handover.start()
        self.addCleanup(handover.cancel)

        ended = False
        try:
            for _line, _problem in headless._command_lines(stream):
                self.fail("nothing is ever written to this pipe")
        except _ReadEnded:
            ended = True
        signal.setitimer(signal.ITIMER_REAL, 0.0)
        self.assertTrue(ended, "the read must end through the wake, not by waiting for a byte")
        self.assertTrue(watch.stood_down, "and it must be recorded as a handover, not a give-up")
        self.assertIsNone(watch._closer, "the blocking close must not have been used at all")
