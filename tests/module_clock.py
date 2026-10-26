"""One module's own clock, for a test.

Patching time.monotonic itself hands a test's readings to every thread in the suite: another test's thread that took
one ran the test out of them (StopIteration, GitHub's runners, 26 Oct 2026). Patched as the module's own `time`, only
that module reads them; everything else, and every other function of `time`, stays real.
"""
from __future__ import annotations

import itertools
import time
from unittest import mock


class ModuleClock:
    def __init__(self, readings, then_last: bool = False):
        readings = list(readings)
        self._readings = itertools.chain(readings, itertools.repeat(readings[-1])) if then_last else iter(readings)

    def monotonic(self):
        return next(self._readings)

    def __getattr__(self, name):
        return getattr(time, name)


def own_clock(module, *readings, then_last: bool = False):
    """patch.object(MODULE, "time", ...): its time.monotonic() reads READINGS in order (with THEN_LAST, the last one
    for good after them; without it, one read too many is StopIteration, as with side_effect=[...])."""
    return mock.patch.object(module, "time", ModuleClock(readings, then_last))
