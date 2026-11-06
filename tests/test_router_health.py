"""DGC Router: the cheap health check every 60 s, and a sub-agent moving off a system that dies mid-task.

The move is driven through the real LLMClient against fake Ollama servers: the dead one gets the client's own
retries first (four tries), then the sub-agent moves and finishes on the other system.
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from router_fakes import FakeServer  # noqa: E402
from test_subagents import Harness, clone_fixture  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc.agent import _SubUI  # noqa: E402
from dgc.config import Config  # noqa: E402


def system(id, url, name, model="qwen3.5:9b", context=16384):
    return {"id": id, "name": name, "base_url": url, "server": "ollama", "jobs": ["subagents", "pips"],
            "workers": 1, "models": [{"name": model, "workers": 1, "context": context}]}


class HealthCase(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-health-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.router = R.Router()
        swap = patch.object(R, "ROUTER", self.router)
        swap.start()
        self.addCleanup(swap.stop)

    def harness(self, block, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-router-health-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), **data)
        self.addCleanup(harness.close)
        harness.config.data["router"] = block
        return harness


class HealthChecks(HealthCase):
    def test_offline_after_two_misses_and_back_after_one_answer(self):
        with FakeServer("ollama") as fake:
            harness = self.harness({"enabled": True, "systems": [system("nas", fake.url, "NAS")]})
            changes = []
            self.router.listen(changes.append)
            self.router.check(harness.config)
            self.assertEqual(self.router.health("nas")["state"], "online")
            fake.dead = True
            self.router.check(harness.config)
            self.assertEqual(self.router.health("nas")["state"], "online", "one miss is not offline")
            self.router.check(harness.config)
            self.assertEqual(self.router.health("nas")["state"], "offline")
            self.assertIn("offline", changes)
            got, why = self.router.acquire(harness.config, "subagents", wait=False)
            self.assertEqual((got, why), (None, "none"), "an offline system takes no work")
            fake.dead = False
            self.router.check(harness.config)
            self.assertEqual(self.router.health("nas")["state"], "online")
            self.assertIn("online", changes)

    def test_the_loop_runs_while_the_router_is_on_and_stops_when_it_is_off(self):
        with FakeServer("ollama") as fake, patch.object(R, "HEALTH_EVERY_S", 0.05):
            harness = self.harness({"enabled": True, "systems": [system("nas", fake.url, "NAS")]})
            self.router.ensure_health(harness.config)
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and len([r for r in fake.requests if r["path"] == "/api/version"]) < 3:
                time.sleep(0.02)
            self.assertGreaterEqual(len([r for r in fake.requests if r["path"] == "/api/version"]), 3)
            harness.config.data["router"]["enabled"] = False
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline and self.router._health_thread is not None:
                time.sleep(0.02)
            self.assertIsNone(self.router._health_thread)

    def test_off_never_checks_anything(self):
        with FakeServer("ollama") as fake:
            harness = self.harness({"enabled": False, "systems": [system("nas", fake.url, "NAS")]})
            self.router.ensure_health(harness.config)
            R.status(harness.config, router=self.router)
            time.sleep(0.2)
            self.assertEqual(fake.requests, [])
            self.assertIsNone(self.router._health_thread)


class MovesThroughTheRealClient(HealthCase):
    def test_after_the_clients_own_retries_the_helper_moves_and_finishes(self):
        with FakeServer("ollama") as mac, FakeServer("ollama") as nas, \
                patch.object(R.Router, "ensure_health", lambda self, config: None):
            mac.dead = True
            block = {"enabled": True, "systems": [system("mac", mac.url, "Mac"),
                                                  system("nas", nas.url, "NAS")]}
            harness = self.harness(block, model_stall_retries=1)
            agent = harness.agent
            agent._router_hints = {"call-1": {"system": "mac"}}
            with patch.object(Config, "clone_for_root", clone_fixture):
                failure, result, start = agent._execute_prepared_subagent(
                    "count", "Count to five.", "", None, _SubUI(harness.ui, "count", cancel=agent.cancelled),
                    "call-1")
            self.assertEqual((failure, start), ("", ""), result)
            dead_tries = [r for r in mac.requests if r["path"] == "/api/chat"]
            self.assertEqual(dead_tries, [], "a dead box answers nothing")
            chats = nas.chats()
            self.assertTrue(chats, "the work finished on the other system")
            self.assertEqual(chats[0]["json"]["options"]["num_ctx"], 16384, "with that system's fixed context")
            self.assertIn("one, two, three, four, five.", result)
            self.assertIn("Moved from Mac (qwen3.5:9b) to NAS (qwen3.5:9b) after 4 failed tries", result)
            self.assertEqual(self.router.leases(), [])


if __name__ == "__main__":
    unittest.main()
