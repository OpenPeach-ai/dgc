"""The contract the per-chat refactor must not break, pinned against UNMODIFIED code.

P1 moves Backend's per-chat state into a `Chat` object and re-exposes it as settable properties.
That is only safe if the properties behave exactly like the plain attributes they replace, and
three of those behaviours are load-bearing in ways nothing currently guards:

  * 20 sites read the agent as `getattr(self, "agent", None)` -- WITH a default -- and
    `_maybe_wake` guards itself with `if not hasattr(self, "_queue")` (headless.py:2306). A
    property that RETURNS None where the attribute used to be ABSENT turns each of those into a
    silent no-op and the suite stays green. Absent and None are different answers here.
  * `_live_turn` is read as a PAIR with `_running_turn_kind` (headless.py:3157) and does not appear
    in `__init__` at all -- so the obvious recipe, "move what __init__ assigns", misses it, and the
    panel is then handed a snapshot claiming the turn is complete while it is still running.
  * `_turn_lock` is re-entered on four live paths, so it must stay an RLock AND stay the same
    object the caller assigned.

These tests pass today. If they still pass after the refactor, the properties are faithful.
"""
from __future__ import annotations

import io
import sys
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc.headless import Backend                                       # noqa: E402
from dgc.history_stream import HistoryEmitter                          # noqa: E402
from dgc.editor_protocol import event_error                            # noqa: E402

# Derived from Chat.__slots__, not written out by hand. The hand-written list this replaced named
# twelve fields and silently left out `_wake_yield`, `_wake_timer` and `_agent_wakes` -- the last of
# which no test assigns anywhere, so nothing guarded it at all. A list that can drift from the thing
# it describes will.
from dgc.headless import Chat                                          # noqa: E402

PER_CHAT = tuple(Chat.__slots__)


class AbsentIsNotNoneTest(unittest.TestCase):
    """The distinction 20 call sites depend on."""

    def test_an_untouched_backend_does_not_have_the_attribute_at_all(self) -> None:
        backend = object.__new__(Backend)
        for name in PER_CHAT:
            with self.subTest(attribute=name):
                self.assertFalse(hasattr(backend, name),
                                 f"{name} must be ABSENT, not None, before anything sets it")

    def test_reading_one_raises_rather_than_returning_none(self) -> None:
        backend = object.__new__(Backend)
        for name in PER_CHAT:
            with self.subTest(attribute=name):
                with self.assertRaises(AttributeError):
                    getattr(backend, name)

    def test_the_defaulted_readers_still_get_their_default(self) -> None:
        """`getattr(self, "agent", None)` must yield None when absent -- that is what the 20
        sites are written against -- and the real object once it is set."""
        backend = object.__new__(Backend)
        self.assertIsNone(getattr(backend, "agent", None))
        sentinel = SimpleNamespace(name="agent")
        backend.agent = sentinel
        self.assertIs(getattr(backend, "agent", None), sentinel)

    def test_assignment_then_identity(self) -> None:
        backend = object.__new__(Backend)
        for name in PER_CHAT:
            with self.subTest(attribute=name):
                marker = SimpleNamespace(field=name)
                setattr(backend, name, marker)
                self.assertIs(getattr(backend, name), marker, "a property must round-trip")
                self.assertTrue(hasattr(backend, name))

    def test_deleting_one_makes_it_absent_again_not_none(self) -> None:
        """`del backend.agent` must restore the unassigned state. A property whose deleter merely
        stored None would leave `hasattr` true afterwards, and every `getattr(..., None)` reader
        could no longer tell 'cleared' from 'set to None'. Mutation-found: this behaviour was
        promised in `_chat_field`'s docstring and nothing pinned it."""
        backend = object.__new__(Backend)
        for name in ("agent", "ui"):
            with self.subTest(attribute=name):
                setattr(backend, name, object())
                delattr(backend, name)
                self.assertFalse(hasattr(backend, name), f"del {name} must make it ABSENT")
                with self.assertRaises(AttributeError):
                    getattr(backend, name)

    def test_none_is_storable_and_distinct_from_absent(self) -> None:
        """`self._worker = None` is how a turn retires (headless.py:2146). Storing None must make
        the attribute PRESENT, or the retire path starts reading as "never set"."""
        backend = object.__new__(Backend)
        backend._worker = None
        self.assertTrue(hasattr(backend, "_worker"))
        self.assertIsNone(backend._worker)


class TheTurnLockIsReentrantAndIsTheOneAssignedTest(unittest.TestCase):
    def test_it_is_the_same_object_back(self) -> None:
        backend = object.__new__(Backend)
        lock = threading.RLock()
        backend._turn_lock = lock
        self.assertIs(backend._turn_lock, lock)

    def test_it_can_be_re_entered(self) -> None:
        """Four live paths take it twice (2310->2291, 3638->3656, 3798->3807, 4598->4599).
        A plain Lock would deadlock there, and the deadlock would look like a hang, not a failure."""
        backend = object.__new__(Backend)
        backend._turn_lock = threading.RLock()
        with backend._turn_lock:
            with backend._turn_lock:
                pass


class TheLiveTurnTravelsWithItsKindTest(unittest.TestCase):
    """`_live_turn` and `_running_turn_kind` are read together at headless.py:3157. If the refactor
    put them on different objects, or moved one and not the other, the panel would be told a
    running turn is finished -- and nothing else in the suite asks."""

    def make(self):
        emitter = HistoryEmitter(io.StringIO(), validator=event_error)
        backend = object.__new__(Backend)
        backend.em = emitter
        backend.config = None
        backend.agent = SimpleNamespace(messages=[{"role": "user", "content": "hi"}], todos=[])
        return backend, emitter

    def test_a_running_turn_is_reported_as_live(self) -> None:
        backend, emitter = self.make()
        backend._running_turn_kind = "prompt"
        backend._live_turn = {"id": "t1", "anchor": None}
        emitter.emit("turn_start", turn_id="t1", prompt="hi", kind="prompt")
        live = (getattr(backend, "_live_turn", None)
                if getattr(backend, "_running_turn_kind", "") else None)
        self.assertEqual(live, {"id": "t1", "anchor": None})

    def test_an_idle_backend_reports_no_live_turn_even_with_one_recorded(self) -> None:
        """The kind is what decides. A stale `_live_turn` with no running kind is NOT live, and
        that asymmetry is the reason the pair cannot be separated."""
        backend, _ = self.make()
        backend._running_turn_kind = ""
        backend._live_turn = {"id": "stale", "anchor": None}
        live = (getattr(backend, "_live_turn", None)
                if getattr(backend, "_running_turn_kind", "") else None)
        self.assertIsNone(live)

    def test_both_are_absent_on_an_untouched_backend(self) -> None:
        backend = object.__new__(Backend)
        self.assertFalse(hasattr(backend, "_live_turn"))
        self.assertFalse(hasattr(backend, "_running_turn_kind"))


if __name__ == "__main__":
    unittest.main()
