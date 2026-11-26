"""Switched off, a Pip runs nothing on its own, its computer included (reported 25 Nov: "switching off a Pip should
switch off its personal computer as well ... i switched off a pip, but its personal computer kept running").

A Pip that is off (paused) or archived has each of its computers closed by the supervisor as soon as nothing uses it: no
run of the Pip has it (an Off Pip still answers when you write to it, and that answer may use its computer) and nothing
on it waits for the person. A Pip that is on keeps its computer until it idles out, as before.
"""
from __future__ import annotations

import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_computer
from tests import test_pips_local as fixtures


def host(pip_id, *, run_id=None, held=()):
    return SimpleNamespace(pip_id=pip_id, run_id=run_id, last_used=time.monotonic(), browser=SimpleNamespace(held=set(held)))


class OffPipsComputers(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.commit()
        self.on = self.store.create(self.workspace["id"], "Watcher", "Watch the shop", "user", "HEAD")
        self.off = self.store.create(self.workspace["id"], "Sleeper", "Read the mail", "user", "HEAD")
        self.store.set_paused(self.off["id"], True, "device_1")
        self.saved = dict(pip_computer.HOSTS)
        pip_computer.HOSTS.clear()
        self.addCleanup(lambda: (pip_computer.HOSTS.clear(), pip_computer.HOSTS.update(self.saved)))

    def closed(self):
        stopped = []
        with patch.object(pip_computer, "stop_one", side_effect=lambda key: (stopped.append(key), pip_computer.HOSTS.pop(key, None))):
            count = pip_computer.close_switched_off(self.registry)
        self.assertEqual(count, len(stopped))
        return stopped

    def test_an_off_pips_idle_computers_close_at_once_and_an_on_pips_stay(self):
        pip_computer.HOSTS[(self.off["id"], 1)] = host(self.off["id"])
        pip_computer.HOSTS[(self.off["id"], 2)] = host(self.off["id"])
        pip_computer.HOSTS[(self.on["id"], 1)] = host(self.on["id"])
        self.assertEqual(sorted(self.closed()), [(self.off["id"], 1), (self.off["id"], 2)], "both of the Off Pip's, at once")
        self.assertIn((self.on["id"], 1), pip_computer.HOSTS, "the Pip that is on keeps its computer until it idles out")

    def test_an_off_pip_answering_you_or_waiting_on_you_keeps_its_computer(self):
        pip_computer.HOSTS[(self.off["id"], 1)] = host(self.off["id"], run_id="run_" + "a" * 32)
        pip_computer.HOSTS[(self.off["id"], 2)] = host(self.off["id"], held={"req_1"})
        self.assertEqual(self.closed(), [], "a run of it has one, and a card waits on the other")
        pip_computer.HOSTS[(self.off["id"], 1)].run_id = None
        self.assertEqual(self.closed(), [(self.off["id"], 1)], "the answer done: it closes")

    def test_an_archived_pips_computer_closes_too(self):
        self.store.set_paused(self.off["id"], False, "device_1")
        self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (self.off["id"],))
        pip_computer.HOSTS[(self.off["id"], 1)] = host(self.off["id"])
        self.assertEqual(self.closed(), [(self.off["id"], 1)])

    def test_the_supervisors_pass_does_it(self):
        source = (fixtures.REPO if hasattr(fixtures, "REPO") else __import__("pathlib").Path(__file__).resolve().parents[1]) / "dgc" / "pip_computer.py"
        self.assertIn("close_switched_off(registry)", source.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
