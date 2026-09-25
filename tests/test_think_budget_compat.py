"""Saved thinking budgets remain usable when switching between DGC builds."""
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import requests

from dgc.agent import Agent
from dgc.config import DEFAULTS
from dgc.llm import LLMClient


class ThinkBudgetCompatibilityTests(unittest.TestCase):
    def client(self, value=8000, **kwargs):
        return LLMClient("http://localhost.invalid/v1", "fixture", "fixture",
                         think_budget_tokens=value, first_token_timeout=0,
                         idle_timeout=0, stall_notice=0, **kwargs)

    def test_auto_budget_tracks_request_level(self):
        client = self.client("auto")
        for level, tokens in ((None, 8000), ("off", 8000), ("low", 8000),
                              ("medium", 16000), ("high", 32000),
                              ("xhigh", 64000), ("max", 64000)):
            with self.subTest(level=level):
                self.assertEqual(client._think_budget(level), tokens * 4)

    def test_numeric_override_and_disabled_budget_are_preserved(self):
        for value, tokens in ((8000, 8000), (20, 20), ("20", 20),
                              (0, 0), ("0", 0), (-1, 0)):
            with self.subTest(value=value):
                client = self.client(value)
                for level in ("off", "high", "xhigh"):
                    self.assertEqual(client._think_budget(level), tokens * 4)
        self.assertEqual(self.client().think_budget_chars, 32000)

    def test_unreadable_values_keep_a_finite_watchdog(self):
        for value in (None, True, False, "", " AUTO ", "default", "invalid",
                      [], {}, float("nan"), float("inf"), float("-inf"),
                      "NaN", "Infinity", "-Infinity", 10 ** 1000):
            with self.subTest(value=str(value)[:40]):
                self.assertEqual(self.client(value)._think_budget("high"), 128000)

    def test_agent_client_creation_does_not_rewrite_saved_auto(self):
        agent = object.__new__(Agent)
        agent.config = copy.deepcopy(DEFAULTS)
        agent.config["think_budget_tokens"] = "auto"
        for source in ("main", "fallback", "subagent"):
            client = agent._new_client("http://localhost.invalid/v1", "fixture",
                                       "fixture", source=source)
            self.assertEqual(client._think_budget("high"), 128000)
        self.assertEqual(agent.config["think_budget_tokens"], "auto")

    def test_auto_watchdog_retries_stream_with_lower_budget(self):
        client = self.client("auto", api_mode="chat_completions")
        # First request exhausts high; the second exhausts medium but would fit high.
        # A third request produces an answer. No clock or network is involved.
        deltas = [{"reasoning_content": "x" * 128001},
                  {"reasoning_content": "x" * 64001}, {"content": "Recovered."}]
        def post(url, **kwargs):
            response = requests.Response()
            response.status_code = 200
            response.encoding = "utf-8"
            response.headers["Content-Type"] = "text/event-stream"
            delta = deltas.pop(0)
            response.raw = io.BytesIO(("data: " + json.dumps({"choices": [
                {"index": 0, "delta": delta, "finish_reason": "stop"}]})
                + "\n\ndata: [DONE]\n\n").encode())
            return response
        with patch("dgc.llm.requests.post", side_effect=post) as request:
            result = client.chat([{"role": "user", "content": "fixture"}],
                                 reasoning_effort="high")
        self.assertEqual(result.content, "Recovered.")
        self.assertEqual(request.call_count, 3)

    def test_backend_accepts_plugin_commands_with_saved_auto(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            (home / ".dgc").mkdir()
            config = home / ".dgc" / "config.json"
            original = json.dumps({"think_budget_tokens": "auto", "mcp_servers": {},
                                   "hooks": {}, "suggest": False,
                                   "artifact_autostart": False}).encode()
            config.write_bytes(original)
            commands = [{"type": "list_plugins", "request_id": "plugins"},
                        {"type": "list_plugin_marketplaces", "request_id": "markets"},
                        {"type": "status", "request_id": "status"}, {"type": "shutdown"}]
            env = dict(os.environ, HOME=str(home), PYTHONPATH=str(root))
            # Any accidental startup HTTP access fails this fixture without using sockets.
            script = ("import runpy,sys,requests; "
                      "requests.sessions.Session.request=lambda *a,**k: "
                      "(_ for _ in ()).throw(AssertionError('unexpected network')); "
                      "sys.argv=['dgc','serve']; runpy.run_module('dgc',run_name='__main__')")
            result = subprocess.run([sys.executable, "-c", script], cwd=home, env=env,
                                    input="".join(json.dumps(c) + "\n" for c in commands),
                                    capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stderr)
            frames = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
            self.assertTrue(any(frame.get("type") == "ready" for frame in frames))
            self.assertFalse([frame for frame in frames if frame.get("type") == "error"])
            for request_id in ("plugins", "markets", "status"):
                self.assertTrue(any(f.get("request_id") == request_id for f in frames),
                                request_id)
            self.assertEqual(config.read_bytes(), original)


if __name__ == "__main__":
    unittest.main()
