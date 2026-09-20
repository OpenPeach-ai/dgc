"""Wait for a thing to happen, instead of sleeping long enough that it probably has.

A test that does `time.sleep(0.15)` and then asserts is really asserting that 150 ms was enough
for another thread, a timer or a subprocess to get there. On a developer's idle machine it always
is. On a shared CI runner it sometimes is not, and the test fails while nothing is broken. That is
how DGC lost the GitHub Release object for 0.41.8 and 0.41.9: every release run failed on a
different one of these, each time on a loaded macOS runner, each time passing everywhere else.

`wait_until` inverts it. It polls for the thing the test actually cares about, so it returns as
soon as the work lands -- usually on the first poll, which makes the suite *faster* than the fixed
sleeps it replaces -- and it only spends the long timeout when the machine is genuinely slow.

    self.assertEqual(rec.events[-1][1].get("activity"), "")        # racy
    wait_until(lambda: rec.events[-1][1].get("activity") == "",    # waits for it
               what="the activity to clear")

The timeout is a failure deadline, never an expected duration: make it far longer than the work
could plausibly need. A test that waits 10 s to fail on a wedged runner costs nothing; a test that
sleeps 0.15 s and fails on a busy one costs a release.
"""
from __future__ import annotations

import time
from typing import Callable, TypeVar

T = TypeVar("T")

# Short enough that a test returns as soon as the work lands, long enough not to spin a core.
POLL_INTERVAL = 0.005


def wait_until(predicate: Callable[[], T], *, timeout: float = 10.0,
               interval: float = POLL_INTERVAL, what: str = "the condition") -> T:
    """Poll `predicate` until it returns something truthy, and return that.

    Raises AssertionError naming `what` if the deadline passes, so a genuine failure reads as a
    failure rather than as a mysterious assertion three lines later.
    """
    deadline = time.monotonic() + timeout
    while True:
        value = predicate()
        if value:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(f"timed out after {timeout:g}s waiting for {what}")
        time.sleep(interval)


def wait_for_value(read: Callable[[], T], expected: object, *, timeout: float = 10.0,
                   interval: float = POLL_INTERVAL, what: str = "the value") -> T:
    """Wait until `read()` equals `expected`; report both sides when it never does.

    Separate from `wait_until` because equality is the common case and a bare "timed out" hides
    what the value actually was -- which is the first thing anyone reading a CI log wants.
    """
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if value == expected:
            return value
        if time.monotonic() >= deadline:
            raise AssertionError(
                f"timed out after {timeout:g}s waiting for {what}: "
                f"expected {expected!r}, last saw {value!r}")
        time.sleep(interval)
