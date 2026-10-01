"""`Chat` and `Backend._chat()` — the objects P1 introduces, before anything uses them.

Dead code in this step, deliberately: nothing reads or writes through them yet, so the only thing
that can break is the import, which fails the whole gate. What these tests pin is that when the
next step DOES wire them up, the state it finds behaves like the plain attributes it replaces.
"""
from __future__ import annotations

import sys
import threading
import unittest
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.headless import Backend, Chat                                 # noqa: E402


class ChatCarriesOneConversationsStateTest(unittest.TestCase):
    def test_every_slot_starts_unset_rather_than_defaulted(self) -> None:
        """The contract the properties must reproduce. A Chat with defaults would make
        `hasattr(backend, "_worker")` true on a Backend nothing has touched, and the 20 sites that
        read `getattr(self, "agent", None)` would start succeeding with None -- eleven functions
        become no-ops with a green suite. Absent and None are different answers."""
        chat = Chat()
        for name in Chat.__slots__:
            with self.subTest(field=name):
                self.assertFalse(hasattr(chat, name), f"{name} must start ABSENT")
                with self.assertRaises(AttributeError):
                    getattr(chat, name)

    def test_none_is_storable_and_makes_the_slot_present(self) -> None:
        """`self._worker = None` is how a turn retires. Storing None must make the slot PRESENT,
        or the retire path starts reading as 'never set'."""
        chat = Chat()
        chat._worker = None
        self.assertTrue(hasattr(chat, "_worker"))
        self.assertIsNone(chat._worker)

    def test_backend_init_supplies_every_default_itself(self) -> None:
        """Why leaving the slots unset costs nothing: there is exactly one source for each default
        and it is Backend.__init__, so a second copy here could only drift from it. `_live_turn` is
        the one field it does NOT assign -- absent is its correct post-init state."""
        import inspect
        init = inspect.getsource(Backend.__init__)
        assigned = {name for name in Chat.__slots__ if f"self.{name} " in init or f"self.{name}:" in init}
        self.assertEqual(set(Chat.__slots__) - assigned, {"_live_turn"},
                         "Backend.__init__ must assign every per-chat field except _live_turn")

    def test_the_turn_lock_is_reentrant(self) -> None:
        """Four live paths take it twice. A plain Lock deadlocks there, and a deadlock reads as a
        hang rather than a failure, which is the worst way for this to go wrong."""
        chat = Chat()
        chat._turn_lock = threading.RLock()
        self.assertEqual(type(chat._turn_lock).__name__, "RLock")
        with chat._turn_lock:
            with chat._turn_lock:
                pass

    def test_each_chat_owns_its_mutable_state(self) -> None:
        """The classic shared-default bug, and the one that would make two chats corrupt each
        other's queue while every test still passed with one chat."""
        a, b = Chat(), Chat()
        for chat in (a, b):
            chat._queue, chat._steer_payloads, chat._agent_wakes = [], {}, []
            chat._turn_lock = threading.RLock()
        for name in ("_queue", "_steer_payloads", "_agent_wakes", "_turn_lock"):
            with self.subTest(field=name):
                self.assertIsNot(getattr(a, name), getattr(b, name))
        a._queue.append(("prompt", None, []))
        a._steer_payloads["s1"] = ()
        a._agent_wakes.append({"id": "x"})
        self.assertEqual(b._queue, [])
        self.assertEqual(b._steer_payloads, {})
        self.assertEqual(b._agent_wakes, [])

    def test_a_typo_is_refused_rather_than_silently_stored(self) -> None:
        """__slots__ earns its place here: `chat._quue = []` in a later step would otherwise be a
        new attribute that nothing reads, and the queue it was meant for would stay empty."""
        chat = Chat()
        with self.assertRaises(AttributeError):
            chat._quue = []

    def test_the_state_that_must_not_move_is_absent(self) -> None:
        """Each of these would be a real defect if it lived here: two emitters look like a corrupt
        stream, two PendingRequests both mint `r1`, and the wake counter is per COMMAND."""
        for name in ("em", "pending", "config", "_wake_suppressed",
                     "_monitors_timer", "_agents_timer", "workspace_trusted"):
            with self.subTest(field=name):
                self.assertNotIn(name, Chat.__slots__)


class TheAccessorWorksOnTheFixtureShapeTest(unittest.TestCase):
    """29 test files build a Backend with object.__new__ and assign two or three fields. The
    accessor has to cope with that, or the refactor breaks every one of them at once."""

    def test_it_makes_a_chat_from_nothing(self) -> None:
        backend = object.__new__(Backend)
        self.assertIsInstance(backend._chat(), Chat)

    def test_it_returns_the_same_chat_every_time(self) -> None:
        backend = object.__new__(Backend)
        self.assertIs(backend._chat(), backend._chat())

    def test_two_backends_do_not_share_one(self) -> None:
        self.assertIsNot(object.__new__(Backend)._chat(), object.__new__(Backend)._chat())

    def test_exactly_the_fields_moved_so_far_live_on_the_chat(self) -> None:
        """Which names are chat-backed, checked by BEHAVIOUR rather than by reading source.

        Its predecessor counted the text `self._chat()` inside Backend's source to prove nothing
        called the accessor yet, and passed straight through the step that gave it callers -- the
        properties call it from a module-level closure, where that text never appears. A textual
        proxy for a behavioural fact. This asserts the fact: a value assigned through Backend
        either lands on the chat (moved) or in the Backend's own __dict__ (not yet moved).

        Update MOVED as each step lands. If a field moves without being added here, or is added
        here without moving, this fails and says which.
        """
        MOVED = set(Chat.__slots__)       # P1 step 5: every per-chat field now lives on the chat
        for name in Chat.__slots__:
            with self.subTest(field=name):
                backend = object.__new__(Backend)
                marker = object()
                setattr(backend, name, marker)
                on_chat = getattr(backend._chat(), name, None) is marker
                in_dict = backend.__dict__.get(name) is marker
                if name in MOVED:
                    self.assertTrue(on_chat, f"{name} should be stored on the chat")
                    self.assertFalse(in_dict, f"{name} must not ALSO sit in Backend.__dict__")
                else:
                    self.assertTrue(in_dict, f"{name} has not moved yet and should be a plain attribute")
                    self.assertFalse(on_chat, f"{name} reached the chat before its step")


class ChatCreationIsSingularUnderConcurrencyTest(unittest.TestCase):
    """Two threads first-touching a fresh Backend must get ONE chat.

    If each built its own, whatever the losing thread wrote -- a queued turn, a worker reference --
    would vanish with the object it wrote to. Production avoids this today only by an ordering
    nobody wrote down (`__init__` assigns `self.ui` before any thread exists); P3 creates chats
    mid-session, where that stops holding.

    The window is widened on purpose: Chat construction is made slow, so an unguarded accessor
    reliably lets several threads through. A test that only passes because the race is narrow is
    not testing the lock.
    """

    def test_every_thread_gets_the_same_chat(self) -> None:
        import dgc.headless as headless
        real_chat = headless.Chat
        built = []

        class SlowChat(real_chat):
            __slots__ = ()

            def __init__(self):
                built.append(self)
                import time
                time.sleep(0.05)          # widen the window between the check and the store

        headless.Chat = SlowChat
        try:
            backend = object.__new__(Backend)
            seen, barrier = [], threading.Barrier(12)

            def touch():
                barrier.wait()
                seen.append(backend._chat())

            threads = [threading.Thread(target=touch) for _ in range(12)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(10)
        finally:
            headless.Chat = real_chat
        self.assertEqual(len(seen), 12)
        self.assertEqual(len({id(chat) for chat in seen}), 1, "threads were handed different chats")
        # Several may be CONSTRUCTED -- allocation happens outside the lock so a GC pass during it
        # cannot run with the lock held -- but exactly one is PUBLISHED, and the rest are discarded
        # before anything is written to them. The published one is the one everybody holds.
        self.assertIn(seen[0], built, "the chat everyone holds must be one that was built")
        self.assertIs(backend._chat(), seen[0], "and it is the one the backend keeps")


    def test_code_run_inside_the_creation_lock_can_still_create_another_chat(self) -> None:
        """The deadlock an adversarial review found in this accessor's first version.

        Python runs arbitrary code on the creating thread while the creation lock is held -- every
        CALL is an eval-breaker where CPython runs GC finalizers and signal handlers. If that code
        first-touches a DIFFERENT fresh Backend, it re-enters `_chat()` on the same thread. With a
        plain Lock that thread blocks forever on a lock it already holds; and because the lock is
        module-global and never released, every later chat creation in the PROCESS hangs too.

        Run in a SUBPROCESS, deliberately. The first version of this test ran in a thread, and when
        it was mutation-checked against a plain Lock it did fail -- and then the stuck thread kept
        the module-global lock forever, so the NEXT test in this file hung until the runner was
        killed. That is the bug faithfully reproducing itself, and it is also a test freezing the
        suite on regression, which is the one failure a runner reports as nothing at all. A process
        boundary means a regression can only kill the probe.
        """
        import subprocess
        probe = (
            "import threading, sys\n"
            "sys.path.insert(0, %r)\n"
            "import dgc.headless as h\n"
            "with h._CHAT_CREATE_LOCK:\n"                  # where a finalizer would be running
            "    other = object.__new__(h.Backend)._chat()\n"
            "assert isinstance(other, h.Chat)\n"
            "assert isinstance(object.__new__(h.Backend)._chat(), h.Chat)\n"   # still healthy
            "print('OK')\n"
        ) % str(PROJECT)
        try:
            result = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True,
                                    timeout=20)
        except subprocess.TimeoutExpired:
            self.fail("creating a chat inside the held creation lock deadlocked the process")
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        self.assertIn("OK", result.stdout)


if __name__ == "__main__":
    unittest.main()
