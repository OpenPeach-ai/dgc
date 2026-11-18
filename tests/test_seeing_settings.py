"""Settings -> Models -> "A model that can see" (the seeing command, dgc/seeing.py).

The page asks for every model that can see on the user's connections (DGC's, the Sub-agents model, each saved
provider, whose route the editor gives when the search reaches it) and the choice every chat starts from; it saves a
new one. Never an address or a key on the wire.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_subagents import Harness  # noqa: E402
from test_seeing import FakeHosts, SEES, TEXT  # noqa: E402

from dgc import editor_protocol as ep, seeing  # noqa: E402

PROVIDER = "provider_" + "a" * 32


class SeeingSettingsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.hosts = FakeHosts()

    @classmethod
    def tearDownClass(cls):
        cls.hosts.close()

    def setUp(self):
        seeing.forget()
        self.addCleanup(seeing.forget)
        self.state = Path(tempfile.mkdtemp(prefix="dgc-seeing-settings-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.state)})
        env.start()
        self.addCleanup(env.stop)
        directory = tempfile.TemporaryDirectory(prefix="dgc-seeing-settings-project-")
        self.addCleanup(directory.cleanup)
        self.harness = Harness(Path(directory.name), mode="default")
        self.addCleanup(self.harness.close)

    def frames(self, kind):
        return [f for f in self.harness.stream.frames() if f.get("type") == kind]

    def wait(self, kind, request_id, seconds=10):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            found = [f for f in self.frames(kind) if f.get("request_id") == request_id]
            if found:
                return found[-1]
            time.sleep(0.02)
        self.fail(f"no {kind} for {request_id}")

    def test_the_list_searches_every_connection_and_the_choice_is_saved(self):
        self.hosts.catalogs["sp1"] = {"vis-cloud": SEES, "txt-cloud": TEXT}
        backend = self.harness.backend
        backend._dispatch({"type": "set_helper_connections", "connections": [
            {"id": PROVIDER, "name": "Ollama Cloud", "host": "cloud.invalid", "kind": "api"},
            {"id": "claude", "name": "Claude Code", "host": "", "kind": "cli"}]})
        self.harness.answer("connection_route_request", {"base_url": self.hosts.url("sp1"), "api_mode": "ollama",
                                                         "api_key": "key-cloud", "model": ""})
        backend._dispatch({"type": "seeing", "op": "list", "request_id": "s1"})
        listed = self.wait("seeing", "s1")
        self.assertIsNone(ep.event_error(listed), "a valid v14 event")
        self.assertEqual(listed["choice"], {"choice": "ask"})
        self.assertEqual(listed["models"], [{"model": "vis-cloud", "tools": True,
                                             "connection": {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"}}])
        self.assertNotIn("key-cloud", json.dumps(self.harness.stream.frames()), "a key never goes back on the wire")
        asked = self.frames("connection_route_request")
        self.assertEqual([f["connection"] for f in asked], [PROVIDER], "never the CLI")
        saved = []
        # (Today's dgc.config: the handler imports it when it runs, and another test may have loaded it again.)
        with patch.object(sys.modules["dgc.config"].Config, "set", lambda cfg, key, value, persist=True: saved.append((key, value))):
            backend._dispatch({"type": "seeing", "op": "set", "choice": "relay", "model": "vis-cloud",
                               "connection": {"kind": "provider", "id": PROVIDER, "name": "Ollama Cloud"},
                               "request_id": "s2"})
        answered = self.wait("seeing", "s2")
        self.assertEqual(saved[0][0], "seeing")
        self.assertEqual((saved[0][1]["choice"], saved[0][1]["model"]), ("relay", "vis-cloud"))
        self.assertEqual(answered["choice"]["model"], "vis-cloud")
        # The running session counts it at once: its next picture uses it.
        self.assertEqual(seeing.settings_choice(self.harness.config)["model"], "vis-cloud")

    def test_a_choice_that_isnt_one_is_refused_in_words(self):
        self.harness.backend._dispatch({"type": "seeing", "op": "set", "choice": "relay", "request_id": "s3"})
        refused = [f for f in self.frames("command_rejected") if f.get("command") == "seeing"]
        self.assertTrue(refused)
        self.assertIn("a model that can see", refused[-1]["message"])

    def test_the_editor_is_told_dgc_takes_it(self):
        from dgc import headless
        source = Path(headless.__file__).read_text(encoding="utf-8")
        self.assertIn('"seeing": 1,', source)
        self.assertIn("seeing", ep.COMMAND_FIELDS)


if __name__ == "__main__":
    unittest.main()
