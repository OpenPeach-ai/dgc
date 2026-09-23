"""Taking a saved session back from the window that is holding it.

The 25-hour dead end this is the answer to: a Cursor reload left a `dgc serve` alive with a wedged
turn, so it held the session lease forever -- the abandonment watchdog would have ended it, but
"a turn is running" is exactly the work that watchdog refuses to interrupt. Every new window was
told "another DGC process has an active turn" and given nothing to do about it.

Three things are being tested here, in rising order of how much damage getting them wrong would do:

1. The refusal NAMES the holder. Pure read, no behaviour change, and on its own it turns a dead
   end into a fact the person can act on.
2. The holder decides. Nothing in this feature forces a lock away, signals a process or deletes a
   lease -- an asker cannot tell a wedged turn from a productive one, and the holder can.
3. A terminal DGC never hands over, and an older DGC is never waited on.

The clock is passed in everywhere it matters, so none of this sleeps for real elapsed time.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import peers                                        # noqa: E402


class _Home(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self._prior = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)

    def tearDown(self):
        if self._prior is not None:
            os.environ["HOME"] = self._prior

    def note(self, **over) -> dict:
        base = {"pid": os.getpid() + 1, "proc_start": "", "kind": "serve",
                "session": "/s/one.json", "cwd": "/w", "project_root": "/w",
                "git_common_dir": "/w/.git", "status": "idle", "takeover": True,
                "heartbeat": time.time()}
        base.update(over)
        return base

    def write(self, record: dict) -> Path:
        directory = peers.peers_dir()
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{record['pid']}.json"
        path.write_text(json.dumps(record))
        return path


class FindingTheHolder(_Home):
    def test_the_note_claiming_this_session_is_found(self):
        self.write(self.note())
        with patch.object(peers, "liveness", return_value="live"):
            found = peers.session_holder("/s/one.json")
        self.assertIsNotNone(found)
        self.assertEqual(found["pid"], os.getpid() + 1)

    def test_a_holder_in_another_checkout_is_still_found(self):
        """A session is a session wherever it was opened from.

        ``others`` defaults to same-checkout-only, which is right for "who else is editing here"
        and wrong for "who has my session": the window holding it may be a terminal somewhere
        else entirely, and refusing to name it is the dead end all over again.
        """
        self.write(self.note(cwd="/elsewhere", project_root="/elsewhere",
                             git_common_dir="/elsewhere/.git"))
        with patch.object(peers, "liveness", return_value="live"):
            self.assertIsNotNone(peers.session_holder("/s/one.json"))

    def test_a_different_session_is_not_a_holder(self):
        self.write(self.note(session="/s/other.json"))
        with patch.object(peers, "liveness", return_value="live"):
            self.assertIsNone(peers.session_holder("/s/one.json"))

    def test_no_session_no_holder(self):
        self.write(self.note())
        with patch.object(peers, "liveness", return_value="live"):
            self.assertIsNone(peers.session_holder(""))

    def test_the_description_names_who_where_and_what(self):
        line = peers.describe_holder(self.note(pid=4242, status="working", liveness="live"))
        self.assertIn("4242", line)
        self.assertIn("/w", line)
        self.assertIn("editor window", line)
        self.assertIn("running a turn", line)

    def test_a_terminal_holder_is_described_as_a_terminal(self):
        self.assertIn("terminal", peers.describe_holder(self.note(kind="tui", liveness="live")))

    def test_an_unproven_holder_is_not_described_as_certain(self):
        line = peers.describe_holder(self.note(liveness="unknown"))
        self.assertIn("may or may not", line)


class TheExchange(_Home):
    def test_ask_then_answer_round_trips(self):
        record = self.note(pid=os.getpid())
        self.assertTrue(peers.request_release(record, "/s/one.json"))
        self.assertIsNotNone(peers.pending_release("/s/one.json"))
        peers.answer_release(granted=True)
        answer = peers.release_answer(os.getpid())
        self.assertIsNotNone(answer)
        self.assertTrue(answer["granted"])

    def test_answering_consumes_the_ask(self):
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        peers.answer_release(granted=False, reason="busy")
        self.assertIsNone(peers.pending_release("/s/one.json"),
                          "an answered ask must not be answered again on the next tick")

    def test_an_ask_for_another_session_is_not_ours_to_answer(self):
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        self.assertIsNone(peers.pending_release("/s/different.json"))

    def test_an_ask_naming_another_holder_is_ignored(self):
        """Written at OUR path but addressed to someone else -- a confused or older asker.

        Writing it at the other holder's path instead proves nothing: the filename alone would
        keep it away from us, and the check inside would never run.
        """
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        path = peers.takeover_dir() / f"{os.getpid()}.ask.json"
        payload = json.loads(path.read_text())
        payload["holder"] = os.getpid() + 7
        path.write_text(json.dumps(payload))
        self.assertIsNone(peers.pending_release("/s/one.json"))

    def test_a_stale_ask_is_dropped_not_answered(self):
        """The asker gave up minutes ago; standing down now would cost a turn for nobody."""
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        path = peers.takeover_dir() / f"{os.getpid()}.ask.json"
        payload = json.loads(path.read_text())
        payload["at"] = time.time() - peers.RELEASE_REQUEST_FRESH_S - 1
        path.write_text(json.dumps(payload))
        self.assertIsNone(peers.pending_release("/s/one.json"))
        self.assertFalse(path.exists(), "a stale ask should be cleared, not left to be re-read")

    def test_asking_clears_the_previous_answer(self):
        """Otherwise round two reads round one's reply and acts on a decision nobody made."""
        record = self.note(pid=os.getpid())
        peers.request_release(record, "/s/one.json")
        peers.answer_release(granted=True)
        peers.request_release(record, "/s/one.json")
        self.assertIsNone(peers.release_answer(os.getpid()),
                          "a fresh ask must not inherit the last exchange's answer")

    def test_an_answer_from_the_wrong_holder_is_not_read(self):
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        peers.answer_release(granted=True)
        path = peers.takeover_dir() / f"{os.getpid()}.ans.json"
        payload = json.loads(path.read_text())
        payload["holder"] = os.getpid() + 99
        path.write_text(json.dumps(payload))
        self.assertIsNone(peers.release_answer(os.getpid()))

    def test_takeover_files_survive_a_peer_listing(self):
        """``others`` unlinks every ``*.json`` it judges gone, and an ask has no ``pid`` field.

        Left beside the notes these files were deleted mid-exchange by any peer that happened to
        list at that moment, so they live in a subdirectory that the note glob cannot reach.
        """
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        peers.answer_release(granted=True)
        peers.others(project_root="/w", git_common_dir="/w/.git")
        self.assertIsNotNone(peers.release_answer(os.getpid()),
                            "listing peers must not delete an exchange in progress")

    def test_an_ask_for_a_holder_that_does_not_claim_the_session_is_refused(self):
        self.assertFalse(peers.request_release(self.note(session="/s/other.json"), "/s/one.json"))

    def test_announce_records_whether_this_build_answers(self):
        peers.announce(kind="serve", session="/s/one.json", takeover=True)
        record = json.loads((peers.peers_dir() / f"{os.getpid()}.json").read_text())
        self.assertIs(record["takeover"], True)
        peers.announce(kind="serve", session="/s/one.json")
        record = json.loads((peers.peers_dir() / f"{os.getpid()}.json").read_text())
        self.assertIs(record["takeover"], False, "the default must be the older build's behaviour")


class TheHolderDecides(_Home):
    """`dgc serve` hands over only when its own editor has plainly gone."""

    def backend(self, *, gone: bool, session: str = "/s/one.json"):
        from dgc import headless

        class _Watch:
            def __init__(self) -> None:
                self.stood_down = False

            def editor_gone(self):
                return gone

            def stand_down(self):
                self.stood_down = True
                return True

        backend = SimpleNamespace(agent=SimpleNamespace(session_file=session),
                                  _editor_liveness=_Watch(),
                                  _announce_peer=lambda status="idle": None)
        backend._consider_release = headless.Backend._consider_release.__get__(backend)
        return backend

    def test_it_stands_down_when_its_editor_has_gone(self):
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        backend = self.backend(gone=True)
        self.assertTrue(backend._consider_release())
        self.assertTrue(backend._editor_liveness.stood_down)
        self.assertTrue(peers.release_answer(os.getpid())["granted"])

    def test_it_keeps_the_session_while_its_editor_is_connected(self):
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        backend = self.backend(gone=False)
        self.assertFalse(backend._consider_release())
        self.assertFalse(backend._editor_liveness.stood_down)
        answer = peers.release_answer(os.getpid())
        self.assertFalse(answer["granted"])
        self.assertIn("still connected", answer["reason"])

    def test_no_ask_means_no_answer_and_no_ending(self):
        backend = self.backend(gone=True)
        self.assertFalse(backend._consider_release())
        self.assertFalse(backend._editor_liveness.stood_down)
        self.assertIsNone(peers.release_answer(os.getpid()))

    def test_an_ask_for_a_session_it_does_not_hold_is_left_alone(self):
        peers.request_release(self.note(pid=os.getpid()), "/s/one.json")
        backend = self.backend(gone=True, session="/s/another.json")
        self.assertFalse(backend._consider_release())
        self.assertFalse(backend._editor_liveness.stood_down)

    def test_a_terminal_never_hands_over(self):
        """A running TUI has a person in front of it, and nothing here can tell if they left."""
        from dgc import tui
        peers.request_release(self.note(pid=os.getpid(), kind="tui"), "/s/one.json")
        app = SimpleNamespace(agent=SimpleNamespace(session_file="/s/one.json"))
        tui.TUI._consider_release(app)
        answer = peers.release_answer(os.getpid())
        self.assertIsNotNone(answer, "a terminal must answer, so the asker need not wait it out")
        self.assertFalse(answer["granted"])
        self.assertIn("terminal", answer["reason"])


class TheAskerRetries(_Home):
    """`Agent._reclaim_session_lease` -- what the window that wants the session does."""

    def agent(self, session: str = "/s/one.json"):
        from dgc.agent import Agent
        holder = SimpleNamespace(
            session_file=session,
            _session_holder=lambda: peers.session_holder(session),
            _reclaim_session_lease=None)
        holder._reclaim_session_lease = Agent._reclaim_session_lease.__get__(holder)
        return holder

    def replies(self, **answer):
        """The holder's reply, delivered the way the asker really reads it.

        Patched rather than written to disk because ``request_release`` deliberately clears the
        previous answer before leaving a new ask -- a file staged beforehand is not the reply to
        THIS ask, and the code is right to discard it.
        """
        return patch.object(peers, "release_answer", lambda pid: dict(answer, holder=pid))

    def test_an_unclaimed_lease_is_worth_one_more_try(self):
        """Nobody left a note: the holder died with the lease and the OS has already freed it."""
        wait, why = self.agent()._reclaim_session_lease()
        self.assertEqual(wait, 0.0)
        self.assertEqual(why, "")

    def test_an_older_dgc_is_never_waited_on(self):
        """A note with no ``takeover`` key is a build that will never reply.

        Asking anyway still ends in "no", so the verdict alone proves nothing -- what must not
        happen is the person watching a spinner for the full answer window first.
        """
        self.write(self.note(takeover=False))
        asked = []
        with patch.object(peers, "liveness", return_value="live"), \
             patch.object(peers, "RELEASE_ANSWER_WAIT_S", 30.0), \
             patch.object(peers, "request_release",
                          lambda note, session: asked.append(note) or True):
            started = time.monotonic()
            wait, why = self.agent()._reclaim_session_lease()
            elapsed = time.monotonic() - started
        self.assertIsNone(wait)
        self.assertEqual(asked, [], "a build that cannot answer must not even be asked")
        self.assertLess(elapsed, 1.0, "it must not cost the asker the full answer window")
        self.assertEqual(why, "")

    def test_a_refusal_comes_back_in_the_holders_own_words(self):
        self.write(self.note())
        with patch.object(peers, "liveness", return_value="live"), \
             self.replies(granted=False, reason="its editor window is still connected"):
            wait, why = self.agent()._reclaim_session_lease()
        self.assertIsNone(wait)
        self.assertEqual(why, "its editor window is still connected")

    def test_a_grant_buys_time_for_the_holder_to_finish_saving(self):
        from dgc.agent import _RECLAIM_WAIT_S
        self.write(self.note())
        with patch.object(peers, "liveness", return_value="live"), \
             self.replies(granted=True):
            wait, _ = self.agent()._reclaim_session_lease()
        self.assertEqual(wait, _RECLAIM_WAIT_S)

    def test_the_wait_covers_the_backends_own_shutdown_grace(self):
        """It agrees at once but then finishes its step and saves, so the lease frees later."""
        from dgc.agent import _RECLAIM_WAIT_S
        from dgc.headless import SHUTDOWN_GRACE_S
        self.assertGreater(_RECLAIM_WAIT_S, SHUTDOWN_GRACE_S)

    def test_an_unanswered_ask_gives_up_instead_of_hanging(self):
        self.write(self.note())
        with patch.object(peers, "liveness", return_value="live"), \
             patch.object(peers, "RELEASE_ANSWER_WAIT_S", 0.3):
            wait, why = self.agent()._reclaim_session_lease()
        self.assertIsNone(wait)
        self.assertIn("did not answer", why)

    def test_a_sessionless_agent_asks_nobody(self):
        wait, why = self.agent(session="")._reclaim_session_lease()
        self.assertIsNone(wait)
        self.assertEqual(why, "")


class TheRefusalSaysWhoHasIt(_Home):
    def message(self, note, reason=""):
        from dgc.agent import Agent
        holder = SimpleNamespace(_held_session_note=note, _held_session_reason=reason)
        return Agent._held_session_message.__get__(holder)("Nothing was started.")

    def test_it_names_the_window_and_repeats_what_it_said(self):
        text = self.message(self.note(pid=321, status="working", liveness="live"),
                            "its editor window is still connected")
        self.assertIn("321", text)
        self.assertIn("still connected", text)
        self.assertIn("Nothing was started.", text)

    def test_a_terminal_holder_gets_the_remedy_that_works_on_a_terminal(self):
        text = self.message(self.note(kind="tui", liveness="live"))
        self.assertIn("terminal", text)
        self.assertNotIn("15 minutes", text,
                         "a terminal does not release itself; do not promise that it will")

    def test_with_no_note_it_falls_back_to_the_message_we_always_had(self):
        from dgc.agent import _HELD_SESSION_REMEDY
        text = self.message(None)
        self.assertIn(_HELD_SESSION_REMEDY, text)
        self.assertIn("Nothing was started.", text)


class RetryingTheAcquire(unittest.TestCase):
    class _Lease:
        def __init__(self, free_after: int) -> None:
            self.free_after = free_after
            self.tries = 0

        def acquire(self, blocking=False):
            self.tries += 1
            return self.tries > self.free_after

    def retry(self, lease, wait_s):
        from dgc.agent import Agent
        return Agent._retry_acquire(lease, wait_s)

    def test_an_already_free_lease_costs_no_wait(self):
        lease = self._Lease(free_after=0)
        started = time.monotonic()
        self.assertTrue(self.retry(lease, 10.0))
        self.assertEqual(lease.tries, 1)
        self.assertLess(time.monotonic() - started, 0.5)

    def test_it_keeps_trying_while_the_holder_shuts_down(self):
        lease = self._Lease(free_after=2)
        self.assertTrue(self.retry(lease, 5.0))

    def test_it_gives_up_rather_than_blocking_the_window_forever(self):
        lease = self._Lease(free_after=10_000)
        started = time.monotonic()
        self.assertFalse(self.retry(lease, 0.6))
        self.assertLess(time.monotonic() - started, 5.0)


class ReclaimingDoesNotFreezeTheRest(_Home):
    """The reclaim waits on ANOTHER PROCESS, so it must not be done holding a local lock.

    Answering takes seconds and standing down takes tens of seconds. Held across that, the
    in-process session lock would stall every other thread that touches this session -- monitor
    delivery, a handoff, a second chat -- for half a minute, trading one stuck window for a
    stuck application.
    """

    class _Lease:
        def __init__(self) -> None:
            self.tries = 0

        def acquire(self, blocking=False):
            self.tries += 1
            return False

        def release(self):
            pass

    def scope(self, agent):
        from dgc.agent import Agent
        return Agent._session_turn_scope.__get__(agent)

    def test_the_state_lock_is_free_while_a_holder_is_being_asked(self):
        import threading
        from dgc import sessions
        held_during_reclaim = []
        state_lock = threading.Lock()
        agent = SimpleNamespace(depth=0, session_file="/s/one.json", session_root="/w",
                                _session_turn_state_lock=state_lock, _session_turn_lease=None,
                                _session_turn_owner=None, _session_turn_depth=0,
                                _held_session_note=None, _held_session_reason="",
                                _session_holder=lambda: None,
                                _retry_acquire=lambda lease, wait_s: False)

        def reclaim():
            # What another thread would find if it tried to start a turn right now.
            free = state_lock.acquire(blocking=False)
            held_during_reclaim.append(not free)
            if free:
                state_lock.release()
            return None, ""
        agent._reclaim_session_lease = reclaim

        with patch.object(sessions, "session_turn_lock", lambda *a: self._Lease()):
            with self.scope(agent)(reentrant=False, reclaim=True) as reserved:
                self.assertFalse(reserved)
        self.assertEqual(held_during_reclaim, [False],
                         "the in-process session lock must be free while a peer is being asked")

    def test_a_reclaimed_lease_is_tracked_so_it_is_released_again(self):
        """Won outside the state lock, it still has to be recorded, or nothing ever frees it."""
        import threading
        from dgc import sessions
        lease = self._Lease()
        agent = SimpleNamespace(depth=0, session_file="/s/one.json", session_root="/w",
                                _session_turn_state_lock=threading.Lock(),
                                _session_turn_lease=None, _session_turn_owner=None,
                                _session_turn_depth=0, _held_session_note=None,
                                _held_session_reason="", _session_holder=lambda: None,
                                _reclaim_session_lease=lambda: (0.0, ""),
                                _retry_acquire=lambda lock, wait_s: True)
        with patch.object(sessions, "session_turn_lock", lambda *a: lease):
            with self.scope(agent)(reentrant=False, reclaim=True) as reserved:
                self.assertTrue(reserved, "a granted takeover must actually reserve the session")
                self.assertIs(agent._session_turn_lease, lease)
                self.assertEqual(agent._session_turn_depth, 1)
        self.assertIsNone(agent._session_turn_lease, "and it must be given back on the way out")
        self.assertEqual(agent._session_turn_depth, 0)

    def test_without_reclaim_a_busy_session_is_still_refused_immediately(self):
        import threading
        from dgc import sessions
        asked = []
        agent = SimpleNamespace(depth=0, session_file="/s/one.json", session_root="/w",
                                _session_turn_state_lock=threading.Lock(),
                                _session_turn_lease=None, _session_turn_owner=None,
                                _session_turn_depth=0, _held_session_note=None,
                                _held_session_reason="", _session_holder=lambda: None,
                                _reclaim_session_lease=lambda: asked.append(1) or (None, ""),
                                _retry_acquire=lambda lock, wait_s: False)
        with patch.object(sessions, "session_turn_lock", lambda *a: self._Lease()):
            with self.scope(agent)(reentrant=False) as reserved:
                self.assertFalse(reserved)
        self.assertEqual(asked, [], "monitor delivery and handoffs must not stall on a takeover")


if __name__ == "__main__":
    unittest.main()
