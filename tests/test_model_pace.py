"""Each model's own pace (dgc/model_pace.py): "No response from the model" waits until a request is well past what
that model usually takes to start replying. Reported 28 Oct: a large cloud model behind a local Ollama took longer
than the fixed 45 s on most turns, and the notice said "No response" while nothing was wrong."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dgc import config as config_module
from dgc import model_pace
from dgc.agent import Agent
from dgc.llm import LLMClient
from dgc.model_watch import RequestWatch, WaitEvent


class PaceStore(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-pace-"))
        patcher = patch.object(config_module, "USER_HOME", self.home)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_the_plain_setting_until_the_model_has_been_seen_enough(self):
        for _ in range(model_pace.MIN_SAMPLES - 1):
            model_pace.record("slow:cloud", "localhost:11434", 60)
        self.assertEqual(model_pace.notice_after(45, "slow:cloud", "localhost:11434", 300), (45, 0.0))
        model_pace.record("slow:cloud", "localhost:11434", 60)
        self.assertEqual(model_pace.notice_after(45, "slow:cloud", "localhost:11434", 300), (120, 60))

    def test_malformed_or_oversized_pace_store_keeps_plain_notice(self):
        path = self.home / "model-pace.json"
        path.write_text(json.dumps({"m@e": {"waits": [10] * 5, "at": "bad"}}), encoding="utf-8")
        self.assertEqual(model_pace.notice_after(5, "m", "e", 100), (20, 10))
        model_pace.record("m", "e", 11)
        self.assertEqual(model_pace._load()["m@e"]["at"] > 0, True)
        path.write_bytes(b" " * (model_pace.MAX_STORE_BYTES + 1))
        self.assertEqual(model_pace.notice_after(5, "m", "e", 100), (5, 0.0))
        path.unlink()
        external = self.home / "external.json"
        external.write_text(json.dumps({"m@e": {"waits": [99] * 5, "at": 1}}))
        path.symlink_to(external)
        self.assertEqual(model_pace.notice_after(5, "m", "e", 100), (5, 0.0))

    def test_twice_its_usual_wait_never_sooner_than_the_setting_and_always_before_the_retry(self):
        for wait in (10, 12, 15, 20, 70):                      # its 90th percentile: 70
            model_pace.record("m", "e", wait)
        self.assertEqual(model_pace.notice_after(45, "m", "e", 300), (140, 70))
        self.assertEqual(model_pace.notice_after(45, "m", "e", 100), (80, 70), "before the 100 s retry")
        self.assertEqual(model_pace.notice_after(200, "m", "e", 300), (200, 70), "never sooner than the setting")
        self.assertEqual(model_pace.notice_after(0, "m", "e", 300), (0, 0.0), "0 keeps the notice off")
        for _ in range(model_pace.MIN_SAMPLES):
            model_pace.record("fast", "e", 2)
        self.assertEqual(model_pace.notice_after(45, "fast", "e", 300), (45, 2), "a fast model keeps 45 s")

    def test_each_model_and_endpoint_on_its_own_and_the_store_stays_small(self):
        for _ in range(model_pace.MIN_SAMPLES):
            model_pace.record("m", "here", 80)
        self.assertIsNone(model_pace.usual("m", "there"))
        for n in range(model_pace.KEEP + 7):
            model_pace.record("m", "here", 1 + n)
        data = json.loads((self.home / "model-pace.json").read_text())
        self.assertEqual(len(data["m@here"]["waits"]), model_pace.KEEP, "the last waits only")
        for n in range(model_pace.MODELS + 5):
            model_pace.record(f"model-{n}", "e", 3)
        self.assertLessEqual(len(json.loads((self.home / "model-pace.json").read_text())), model_pace.MODELS)
        self.assertEqual([p.name for p in self.home.iterdir() if p.name.startswith(".model-pace-")], [],
                         "no temporary file left behind")

    def test_an_unreadable_store_only_means_the_plain_setting(self):
        (self.home / "model-pace.json").write_text("{not json")
        self.assertEqual(model_pace.notice_after(45, "m", "e", 300), (45, 0.0))
        model_pace.record("m", "e", 5)                          # and a new wait replaces it
        self.assertEqual(model_pace._load()["m@e"]["waits"], [5])

    def test_the_watcher_records_the_wait_for_the_first_token_without_a_model_load(self):
        now = [100.0]
        watch = RequestWatch(None, model="m", endpoint="e", pace=True, clock=lambda: now[0])
        now[0] = 112.5
        watch.progress()
        now[0] = 130.0
        watch.progress()                                        # later tokens are not first tokens
        self.assertEqual(model_pace._load()["m@e"]["waits"], [12.5])
        quiet = RequestWatch(None, model="q", endpoint="e", clock=lambda: now[0])
        quiet.progress()
        self.assertNotIn("q@e", model_pace._load(), "a bare watch learns nothing")

    def test_the_notice_says_what_is_normal_for_this_model(self):
        ev = WaitEvent(kind="notice", phase="first_token", threshold_s=160, usual_s=80,
                       model="deepseek-v4-pro:cloud", endpoint="http://localhost:11434")
        label, detail = Agent._model_wait_text(ev)
        self.assertEqual(label, "No response from the model")
        self.assertIn("no tokens for 2m 40s+", detail)
        self.assertIn("it usually starts within 1m 20s", detail)
        plain = WaitEvent(kind="notice", phase="headers", threshold_s=45, model="m", endpoint="http://h:1")
        self.assertEqual(Agent._model_wait_text(plain)[1], "m at h:1 · no reply for 45s+")


class PaceEndToEnd(unittest.TestCase):
    """A real request loop against a local server: a model that always takes 0.5 s to start is flagged at a 0.2 s
    setting until DGC has seen it a few times, then not."""

    def setUp(self):
        from test_model_stall import _Server
        self.home = Path(tempfile.mkdtemp(prefix="dgc-pace-e2e-"))
        patcher = patch.object(config_module, "USER_HOME", self.home)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.server = _Server()
        self.addCleanup(self.server.close)

    def test_a_slow_model_stops_being_flagged_once_its_pace_is_known(self):
        from test_model_stall import MESSAGES, _Events, chat_answer
        self.server.behaviours["/chat/completions"] = chat_answer("ok", delay=0.5)
        client = LLMClient(self.server.url + "/v1", "key", "slow-model", read_timeout=10, stall_notice=0.2,
                           first_token_timeout=5, stall_retries=0, learn_pace=True)
        noticed = []
        for _ in range(model_pace.MIN_SAMPLES + 1):
            events = _Events()
            client.stall_listener = events
            self.assertEqual(client.chat(MESSAGES).content, "ok")
            noticed.append("notice" in events.kinds())
        self.assertEqual(noticed, [True] * model_pace.MIN_SAMPLES + [False], noticed)
        bare = LLMClient(self.server.url + "/v1", "key", "other-model", read_timeout=10, stall_notice=0.2,
                         first_token_timeout=5, stall_retries=0)
        bare.chat(MESSAGES)
        self.assertNotIn("other-model", json.dumps(model_pace._load()), "a bare client learns nothing")


if __name__ == "__main__":
    unittest.main()
