"""Reasoning watchdog per level, and the prompt "think" keywords.

The over-thinking watchdog (``think_budget_tokens``) used to stop every level at 8,000 tokens of
reasoning, which is below the thinking budget DGC itself requests for High and Extra high. Its
default is now a per-level "auto" schedule; a number is still a uniform override and 0 is off.

A prompt word ("think", "think hard", "think harder", "ultrathink") may now only lift thinking
from Off. A level the user set, a sub-agent's own effort, or Ultra is never changed by it.
"""
from __future__ import annotations

import json
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import config as config_mod  # noqa: E402
from dgc import llm as llm_mod  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import DEFAULTS, Config  # noqa: E402
from dgc.llm import LLMClient  # noqa: E402

LEVELS = ("off", "low", "medium", "high", "xhigh")


class WatchdogScheduleTest(unittest.TestCase):
    def test_default_config_is_auto(self):
        self.assertEqual(DEFAULTS["think_budget_tokens"], "auto")

    def test_auto_allows_at_least_what_dgc_requests_from_the_provider(self):
        client = LLMClient("http://127.0.0.1:9/v1", "k", "m")
        for level in ("low", "medium", "high", "xhigh"):
            requested = llm_mod._reasoning_payload("anthropic", "claude-x", level)[
                "thinking"]["budget_tokens"]
            self.assertGreaterEqual(client._think_budget(level), requested * 4, level)
        # Extra high (and Ultra, which raises native effort to xhigh) get room for deep work.
        self.assertGreaterEqual(client._think_budget("xhigh"), 32_000 * 4)
        self.assertGreaterEqual(client._think_budget("max"), 32_000 * 4)
        # Deeper levels never get less than shallower ones.
        budgets = [client._think_budget(level) for level in LEVELS]
        self.assertEqual(budgets, sorted(budgets), budgets)

    def test_auto_still_bounds_every_level(self):
        client = LLMClient("http://127.0.0.1:9/v1", "k", "m", think_budget_tokens="auto")
        for level in (*LEVELS, "max", "none", None, "", "unknown"):
            budget = client._think_budget(level)
            self.assertGreater(budget, 0, level)
            self.assertLessEqual(budget, 64_000 * 4, level)
        self.assertEqual(client._think_budget("off"), 8000 * 4)
        self.assertEqual(client._think_budget(None), 8000 * 4)

    def test_a_number_overrides_every_level_and_zero_is_off(self):
        ten = LLMClient("http://127.0.0.1:9/v1", "k", "m", think_budget_tokens=10)
        self.assertEqual({ten._think_budget(level) for level in LEVELS}, {40})
        text = LLMClient("http://127.0.0.1:9/v1", "k", "m", think_budget_tokens="12000")
        self.assertEqual({text._think_budget(level) for level in LEVELS}, {48_000})
        off = LLMClient("http://127.0.0.1:9/v1", "k", "m", think_budget_tokens=0)
        self.assertEqual({off._think_budget(level) for level in LEVELS}, {0})
        negative = LLMClient("http://127.0.0.1:9/v1", "k", "m", think_budget_tokens=-5)
        self.assertEqual(negative._think_budget("xhigh"), 0)

    def test_unreadable_values_fall_back_to_auto(self):
        for value in ("auto", "AUTO", "", None, "lots", True, float("nan")):
            self.assertIsNone(llm_mod.resolve_think_budget(value), value)


class _Runaway(BaseHTTPRequestHandler):
    """A /v1 endpoint that reasons ``reasoning_tokens`` tokens before answering "done"."""

    reasoning_tokens = 0
    requests: list = []

    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        type(self).requests.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunk = "x" * 4000                                  # ~1,000 tokens per frame
        frames = []
        for _ in range(self.reasoning_tokens // 1000):
            frames.append({"choices": [{"index": 0, "delta": {"reasoning": chunk},
                                        "finish_reason": None}]})
        frames.append({"choices": [{"index": 0, "delta": {"content": "done"},
                                    "finish_reason": None}]})
        frames.append({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
        try:
            for frame in frames:
                self.wfile.write(("data: " + json.dumps(frame) + "\n\n").encode())
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass                                            # the watchdog closed the stream


class WatchdogStreamTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _Runaway)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}/v1"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        _Runaway.requests = []

    def client(self, **kwargs) -> LLMClient:
        client = LLMClient(self.url, "k", "m", api_mode="chat_completions",
                           provider_capabilities={"reasoning": True}, **kwargs)
        client._report_usage = lambda result: None
        return client

    def test_xhigh_may_reason_past_the_old_8000_token_cap(self):
        _Runaway.reasoning_tokens = 12_000
        result = self.client().chat([{"role": "user", "content": "hard task"}],
                                    reasoning_effort="xhigh")
        self.assertEqual(result.content, "done")
        self.assertNotEqual(result.finish_reason, "overthink")
        self.assertEqual(len(_Runaway.requests), 1, "the watchdog must not have retried")

    def test_the_wire_cap_grows_with_the_level(self):
        _Runaway.reasoning_tokens = 0
        client = self.client(max_tokens=16_384, context_size=400_000)
        client.model_context_limit = lambda: 0
        client.chat([{"role": "user", "content": "hi"}], reasoning_effort="off")
        client.chat([{"role": "user", "content": "hard task"}], reasoning_effort="xhigh")
        caps = [request.get("max_tokens") for request in _Runaway.requests]
        self.assertEqual(caps, [16_384, 16_384 + 64_000])

    def test_off_still_stops_a_runaway_model(self):
        _Runaway.reasoning_tokens = 12_000
        result = self.client().chat([{"role": "user", "content": "hi"}],
                                    reasoning_effort="off")
        self.assertEqual(result.finish_reason, "overthink")
        self.assertEqual(result.content, "")

    def test_an_explicit_number_still_caps_xhigh(self):
        _Runaway.reasoning_tokens = 12_000
        client = self.client(think_budget_tokens=8000)
        result = client.chat([{"role": "user", "content": "hard task"}],
                             reasoning_effort="xhigh")
        # xhigh overthinks, steps down level by level, and ends at off still over budget.
        self.assertEqual(result.finish_reason, "overthink")
        self.assertGreater(len(_Runaway.requests), 1)


class RequestOutputCapTest(unittest.TestCase):
    """Reasoning counts against a provider's output cap, so a request that asks for reasoning
    sends max_tokens plus the level's reasoning allowance, bounded by what the model can take."""

    def client(self, *, context_size=0, output_limit=0, reasoning=True, **kwargs) -> LLMClient:
        client = LLMClient("http://127.0.0.1:9/v1", "k", "m", api_mode="chat_completions",
                           provider_capabilities={"reasoning": reasoning},
                           context_size=context_size, **kwargs)
        client.model_output_limit = lambda: output_limit
        client.model_context_limit = lambda: 0
        return client

    def test_off_keeps_max_tokens(self):
        client = self.client(max_tokens=16_384, context_size=400_000)
        for level in ("off", "none", None, ""):
            self.assertEqual(client._request_max_tokens(level), 16_384, level)

    def test_each_level_adds_its_reasoning_allowance(self):
        client = self.client(max_tokens=16_384, context_size=400_000)
        for level in ("low", "medium", "high", "xhigh", "max"):
            self.assertEqual(client._request_max_tokens(level),
                             16_384 + llm_mod.AUTO_THINK_BUDGET_TOKENS[level], level)
        # Extra high can now reason past the old 16,384 output cap.
        self.assertGreater(client._request_max_tokens("xhigh"), 64_000)

    def test_a_small_context_window_keeps_the_old_cap(self):
        client = self.client(max_tokens=16_384, context_size=32_768)
        self.assertEqual(client._request_max_tokens("xhigh"), 16_384)
        client = self.client(max_tokens=16_384, context_size=131_072)
        self.assertEqual(client._request_max_tokens("xhigh"), 65_536)

    def test_the_model_output_limit_bounds_it_but_never_below_max_tokens(self):
        client = self.client(max_tokens=16_384, context_size=400_000, output_limit=32_000)
        self.assertEqual(client._request_max_tokens("xhigh"), 32_000)
        client = self.client(max_tokens=16_384, context_size=400_000, output_limit=8_000)
        self.assertEqual(client._request_max_tokens("xhigh"), 16_384)

    def test_zero_sends_nothing_and_no_reasoning_support_adds_nothing(self):
        self.assertEqual(self.client(max_tokens=0)._request_max_tokens("xhigh"), 0)
        client = self.client(max_tokens=16_384, context_size=400_000, reasoning=False)
        self.assertEqual(client._request_max_tokens("xhigh"), 16_384)

    def test_a_uniform_watchdog_number_sets_the_allowance(self):
        client = self.client(max_tokens=16_384, context_size=400_000, think_budget_tokens=10_000)
        self.assertEqual(client._request_max_tokens("xhigh"), 26_384)
        client = self.client(max_tokens=16_384, context_size=400_000, think_budget_tokens=0)
        self.assertEqual(client._request_max_tokens("xhigh"), 16_384 + 64_000)

    def test_anthropic_legacy_thinking_gets_its_full_xhigh_budget(self):
        client = LLMClient("https://api.anthropic.com", "k", "claude-sonnet-4-5",
                           max_tokens=16_384, context_size=200_000)
        client.model_output_limit = lambda: 64_000
        client.model_context_limit = lambda: 0
        payload = client._anthropic_payload([{"role": "user", "content": "hi"}], None, "xhigh",
                                            set())
        self.assertEqual(payload["max_tokens"], 64_000)
        # Legacy extended thinking: before, the 16,384 cap held xhigh to 12,288 of its 24,576.
        self.assertEqual(payload["thinking"], {"type": "enabled", "budget_tokens":
                                               llm_mod._ANTHROPIC_THINKING_BUDGET["xhigh"]})
        off = client._anthropic_payload([{"role": "user", "content": "hi"}], None, "off", set())
        self.assertEqual(off["max_tokens"], 16_384)


class LegacyDefaultMigrationTest(unittest.TestCase):
    def load(self, stored: dict) -> Config:
        home = Path(tempfile.mkdtemp(prefix="dgc-think-home-"))
        project = Path(tempfile.mkdtemp(prefix="dgc-think-project-"))
        user_config = home / "config.json"
        user_config.write_text(json.dumps(stored))
        with patch.object(config_mod, "USER_CONFIG", user_config), \
                patch.object(config_mod, "USER_SECRETS", home / "secrets.json"):
            config = Config(project)
        self.written = json.loads(user_config.read_text())
        return config

    def test_the_old_persisted_default_becomes_auto(self):
        config = self.load({"think_budget_tokens": 8000})
        self.assertEqual(config.get("think_budget_tokens"), "auto")
        self.assertEqual(self.written.get("think_budget_tokens"), "auto")

    def test_a_chosen_number_or_zero_is_kept(self):
        self.assertEqual(self.load({"think_budget_tokens": 12000}).get("think_budget_tokens"),
                         12000)
        self.assertEqual(self.load({"think_budget_tokens": 0}).get("think_budget_tokens"), 0)


class _Config(dict):
    def get(self, key, default=None):
        return super().get(key, default)


def _agent(thinking="off", ultra=False, override=None) -> Agent:
    agent = object.__new__(Agent)
    agent.config = _Config(thinking=thinking, ultra_mode=ultra)
    agent._effort_override = override
    return agent


class ThinkKeywordTest(unittest.TestCase):
    def test_keywords_raise_thinking_from_off(self):
        agent = _agent("off")
        self.assertEqual(agent._effective_thinking("I think the bug is here"), "low")
        self.assertEqual(agent._effective_thinking("think hard about the cache"), "medium")
        self.assertEqual(agent._effective_thinking("Think harder, please"), "high")
        self.assertEqual(agent._effective_thinking("ultrathink: fix it"), "high")
        self.assertEqual(agent._effective_thinking("fix the parser"), "off")

    def test_a_set_level_is_never_changed_by_prompt_words(self):
        for level in ("low", "medium", "high", "xhigh"):
            agent = _agent(level)
            for prompt in ("think", "think hard", "think harder", "ultrathink", "plain"):
                self.assertEqual(agent._effective_thinking(prompt), level, (level, prompt))

    def test_ultra_is_never_changed_by_prompt_words(self):
        for level in ("off", "low", "high"):
            agent = _agent(level, ultra=True)
            self.assertEqual(agent._effective_thinking("ultrathink"), "xhigh")
            self.assertEqual(agent._effective_thinking("think"), "xhigh")

    def test_a_sub_agent_effort_override_is_never_changed(self):
        agent = _agent("off", override="low")
        self.assertEqual(agent._effective_thinking("ultrathink"), "low")
        agent = _agent("xhigh", override="medium")
        self.assertEqual(agent._effective_thinking("think harder"), "medium")


if __name__ == "__main__":
    unittest.main()
