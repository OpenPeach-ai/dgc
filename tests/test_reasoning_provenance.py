"""Thinking provenance (0.40.0, editor protocol v14): the resolver, placement, the tracker, the
parsers' origins through a real Agent/Backend/HeadlessUI, persistence, history replay, the TUI and
the line CLI.

The provider fixtures (tests/fixtures/reasoning/*.json, written by build_fixtures.py) replace
``dgc.llm.requests.post``/``get``: no sockets, a temp HOME, and every request body and header set is
captured. Time is a fake clock that the fixture streams advance.
"""
from __future__ import annotations

import copy
import io
import json
import logging
import math
import os
import subprocess
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import editor_protocol as ep
from dgc import reasoning as R
from dgc.agent import Agent, _SubUI
from dgc.config import DEFAULTS, Config
from dgc.headless import Backend, HeadlessUI
from dgc.protocol import Emitter, PendingRequests
from dgc.redaction import StreamingRedactor

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / "tests" / "fixtures" / "reasoning"


# ---- shared helpers ---------------------------------------------------------------------------------

def fixture_config(root: Path, **overrides) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False, eta=False,
                       api_key="fixture-key", model_stall_notice_s=0)
    config.data.update(overrides)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class FakeClock:
    def __init__(self):
        self.t = 1000.0
        self.lock = threading.Lock()

    def __call__(self):
        return self.t

    def advance(self, seconds):
        with self.lock:
            self.t += float(seconds)


class FakeResponse:
    def __init__(self, entry: dict, clock: FakeClock):
        self.status_code = int(entry.get("status", 200))
        self.headers = {"Content-Type": entry.get("content_type", "text/event-stream")}
        self._entry = entry
        self._clock = clock
        self.encoding = "utf-8"
        body = entry.get("body")
        self.text = json.dumps(body) if body is not None else ""

    def iter_lines(self, decode_unicode=True):
        if "body" in self._entry:
            yield self.text
            return
        for line in self._entry.get("lines", []):
            if isinstance(line, dict):
                self._clock.advance(line.get("advance", 0))
                continue
            yield line

    def json(self):
        return self._entry.get("body")

    def close(self):
        pass


class NotFound:
    status_code = 404
    headers = {"Content-Type": "application/json"}
    text = '{"error": "not found"}'
    encoding = "utf-8"

    def json(self):
        return {"error": "not found"}

    def iter_lines(self, decode_unicode=True):
        yield self.text

    def iter_content(self, chunk_size=1):
        yield self.text.encode()

    def close(self):
        pass


class FakeProvider:
    """Routes POSTs to the fixture's scripted responses by URL substring, in order. Only the
    fixture's own endpoints may consume a script: ``requests`` is patched process-wide, and a stray
    request from another test's background thread must never take this fixture's response."""

    def __init__(self, entries: list, clock: FakeClock, endpoints=()):
        self.endpoints = tuple(str(endpoint).rstrip("/") for endpoint in endpoints if endpoint)
        self.entries = [dict(entry) for entry in entries]
        self.used = [False] * len(self.entries)
        self.clock = clock
        self.captured: list[dict] = []
        self.lock = threading.Lock()

    def post(self, url, **kwargs):
        if self.endpoints and not str(url).startswith(self.endpoints):
            return NotFound()
        with self.lock:
            self.captured.append({"url": url, "json": copy.deepcopy(kwargs.get("json")),
                                  "headers": dict(kwargs.get("headers") or {})})
            if url.endswith("/api/show"):
                return NotFound()
            for index, entry in enumerate(self.entries):
                if entry["match"] in url and (entry.get("repeat") or not self.used[index]):
                    self.used[index] = True
                    return FakeResponse(entry, self.clock)
        tail = [(m.get("role"), str(m.get("content"))[:160]) for m in
                (self.captured[-1]["json"] or {}).get("messages", [])[-3:]] if self.captured else []
        raise AssertionError(f"no scripted response for {url} (request {len(self.captured)}; last messages {tail})")

    def get(self, url, **kwargs):
        return NotFound()


def frames_of(stream: io.StringIO) -> list[dict]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line.strip()]


def live_blocks(frames: list[dict]) -> list[dict]:
    """Blocks in order of first appearance with their concatenated text and end fields."""
    order, blocks = [], {}
    for frame in frames:
        if frame.get("type") not in ("thinking_delta", "thinking_end"):
            continue
        bid = frame["block"]
        if bid not in blocks:
            order.append(bid)
            blocks[bid] = {"block": bid, "source": frame["source"], "provider": frame.get("provider", ""),
                           "agent": frame.get("agent", ""), "text": "", "end": None}
        if frame["type"] == "thinking_delta":
            blocks[bid]["text"] += frame["text"]
        else:
            blocks[bid]["end"] = frame
    return [blocks[bid] for bid in order]


class Harness:
    """One fixture through a real Agent + HeadlessUI + Emitter(validator) + Backend._history."""

    def __init__(self, test: unittest.TestCase, fixture: dict, *, extra_entries=(), git=False):
        self.test = test
        self.fixture = fixture
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-reasoning-")
        root = Path(self.tmp.name)
        if git:
            subprocess.run(["git", "init", "-q"], cwd=root, check=True)
            (root / "README.md").write_text("fixture\n")
            subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "add", "README.md"],
                           cwd=root, check=True)
            subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m",
                            "fixture"], cwd=root, check=True)
        overrides = {"base_url": fixture["base_url"], "model": fixture["model"],
                     "api_mode": fixture["api_mode"], **fixture.get("config", {})}
        self.config = fixture_config(root, **overrides)
        self.stream = io.StringIO()
        self.emitter = Emitter(self.stream, validator=ep.event_error)
        self.pending = PendingRequests()
        self.ui = HeadlessUI(self.emitter, self.pending, approval_timeout_s=5)
        self.clock = FakeClock()
        endpoints = [fixture["base_url"]] + [fixture.get("config", {}).get(key, "")
                                             for key in ("fallback_base_url", "subagent_base_url")]
        self.provider = FakeProvider(list(fixture["requests"]) + list(extra_entries), self.clock, endpoints)
        self.patches = [patch("dgc.llm.requests.post", self.provider.post),
                        patch("dgc.llm.requests.get", self.provider.get),
                        patch("dgc.reasoning.now", self.clock)]
        for active in self.patches:
            active.start()
        self.backend = object.__new__(Backend)
        self.backend.config, self.backend.em, self.backend.pending = self.config, self.emitter, self.pending
        self.backend.ui = self.ui
        self.agent = Agent(self.config, self.ui)
        self.backend.agent = self.agent
        self.ui.cancelled = self.agent.cancelled

    def close(self):
        try:
            self.agent.mcp.stop_all()
        finally:
            for active in reversed(self.patches):
                active.stop()
            self.tmp.cleanup()

    def run(self, prompt="go", turn_id="t1"):
        self.ui.turn_id = turn_id
        self.ui.reset_turn_messages()
        self.emitter.emit("turn_start", turn_id=turn_id, prompt=prompt, kind="prompt")
        outcome = self.agent.run_turn(prompt)
        self.safety_net = self.ui.close_open_reasoning()
        self.emitter.emit("turn_end", turn_id=turn_id, reason="completed", token_estimate=0,
                          final_message_id=self.ui.final_message_id)
        self.ui.turn_id = ""
        return outcome

    def frames(self):
        return frames_of(self.stream)

    def history(self):
        return self.backend._history()


# ---- the resolver -------------------------------------------------------------------------------------

class ResolverTableTests(unittest.TestCase):
    """Design section 3.2, row by row, plus the strict host predicates."""

    ROWS = [
        # api_mode, channel, base_url, model, display -> source, provider
        ("ollama", "ollama.thinking", "http://127.0.0.1:11434", "qwen3.8:27b", "", "raw", ""),
        ("ollama", "ollama.thinking", "http://127.0.0.1:11434", "claude-sonnet-5", "", "unknown", ""),
        ("ollama", "tags", "http://127.0.0.1:11434", "qwen3", "", "raw", ""),
        ("chat_completions", "tags", "http://127.0.0.1:8000/v1", "qwen3", "", "raw", ""),
        ("chat_completions", "tags", "https://openrouter.ai/api/v1", "qwen3", "", "unknown", ""),
        ("chat_completions", "tags", "http://127.0.0.1:1234/v1", "gpt-5", "", "unknown", ""),
        ("chat_completions", "chat.reasoning", "http://127.0.0.1:11434/v1", "qwen3", "", "raw", ""),
        ("chat_completions", "chat.reasoning_content", "http://127.0.0.1:8000/v1", "qwen3", "", "raw", ""),
        ("chat_completions", "chat.reasoning_content", "http://127.0.0.1:4000/v1", "qwen3", "", "unknown", ""),
        ("chat_completions", "chat.reasoning", "http://127.0.0.1:11434/v1", "gpt-5", "", "unknown", ""),
        ("chat_completions", "chat.reasoning", "https://openrouter.ai/api/v1", "anthropic/claude-sonnet-5", "",
         "unknown", ""),
        ("chat_completions", "chat.reasoning_content", "https://api.deepseek.com/v1", "deepseek-reasoner", "",
         "unknown", ""),
        ("responses", "responses.summary", "https://api.openai.com/v1", "gpt-5", "", "summarized", "openai"),
        ("responses", "responses.summary", "https://myco.openai.azure.com/openai", "gpt-5", "",
         "summarized", "openai"),
        ("responses", "responses.summary", "https://myco.cognitiveservices.azure.com", "gpt-5", "", "unknown", ""),
        ("responses", "responses.summary", "http://127.0.0.1:11434/v1", "gpt-oss:20b", "", "raw", ""),
        ("responses", "responses.reasoning_text", "http://127.0.0.1:8000/v1", "gpt-oss-120b", "", "raw", ""),
        ("responses", "responses.reasoning_text", "https://api.openai.com/v1", "gpt-5", "", "unknown", ""),
        ("responses", "responses.no_text", "https://api.openai.com/v1", "gpt-5", "", "withheld", "openai"),
        ("responses", "responses.no_text", "http://127.0.0.1:11434/v1", "gpt-oss:20b", "", "unknown", ""),
        ("responses", "responses.other", "https://api.openai.com/v1", "gpt-5", "", "unknown", ""),
        ("anthropic", "anthropic.thinking", "https://api.anthropic.com/v1", "claude-opus-4-8", "summarized",
         "summarized", "anthropic"),
        ("anthropic", "anthropic.thinking", "https://api.anthropic.com/v1", "claude-mythos-preview", "summarized",
         "summarized", "anthropic"),
        ("anthropic", "anthropic.thinking", "https://api.anthropic.com/v1", "claude-fable-5-1", "updates",
         "narration", "anthropic"),
        ("anthropic", "anthropic.thinking", "https://api.anthropic.com/v1", "claude-sonnet-4-5", "", "unknown", ""),
        ("anthropic", "anthropic.thinking", "https://api.anthropic.com/v1", "claude-3-7-sonnet-20250219", "",
         "unknown", ""),
        ("anthropic", "anthropic.redacted", "https://api.anthropic.com/v1", "claude-opus-4-8", "", "withheld",
         "anthropic"),
        ("anthropic", "anthropic.thinking", "http://127.0.0.1:11434", "qwen3", "", "raw", ""),
        ("anthropic", "anthropic.thinking", "http://localhost:4000/anthropic", "claude-opus-4-8", "summarized",
         "unknown", ""),
        ("anthropic", "anthropic.thinking", "https://api.anthropic.com.evil.test/v1", "claude-opus-4-8",
         "summarized", "unknown", ""),
        ("anthropic", "anthropic.redacted", "http://127.0.0.1:11434", "qwen3", "", "unknown", ""),
        ("", "subscription", "", "claude-opus-4-8", "", "unknown", ""),
        ("", "subscription", "https://api.anthropic.com", "gpt-5", "", "unknown", ""),
    ]

    def setUp(self):
        R._resolve.cache_clear()
        R._LOGGED.clear()

    def test_table(self):
        with self.assertNoLogs("dgc.reasoning", level="WARNING"):
            for api_mode, channel, base, model, display, source, provider in self.ROWS:
                with self.subTest(channel=channel, base=base, model=model):
                    got = R.resolve_source(api_mode=api_mode, channel=channel, base_url=base, model=model,
                                           requested_display=display)
                    self.assertEqual((got.source, got.provider), (source, provider))
        # The unit table shows R2 fires for no row: the downgrade is a guard, never the mechanism.

    def test_private_hosts_never_yield_provider_sources(self):
        hosts = ["http://[::1]:11434", "http://100.101.1.1:8000/v1", "http://gb10:11434",
                 "http://mac-studio.local:1234/v1", "https://box.tail123.ts.net/v1", "http://NAS.LAN:8000/v1",
                 "http://LOCALHOST:11434", "http://127.0.0.1.:11434", "http://user:pw@127.0.0.1:11434",
                 "http://10.0.0.5:8080/v1", "http://192.168.1.60:11434", "http://172.16.0.1/v1",
                 "http://169.254.10.10/v1", "http://[fd12::1]:8000/v1", "http://api.internal/v1",
                 "http://router.home.arpa/v1", "http://[::ffff:127.0.0.1]:11434", "localhost:11434"]
        for host in hosts:
            self.assertTrue(R.private_host(R.host_of(host)), host)
            for channel in R.CHANNELS:
                for api_mode in ("ollama", "chat_completions", "responses", "anthropic", ""):
                    for model in ("claude-opus-4-8", "gpt-5", "qwen3"):
                        for display in ("", "summarized", "updates"):
                            got = R.resolve_source(api_mode=api_mode, channel=channel, base_url=host,
                                                   model=model, requested_display=display)
                            self.assertNotIn(got.source, R.PROVIDER_SOURCES, (host, channel, api_mode, model))
                            self.assertTrue(got.private)
        self.assertEqual(R.host_of("http://user:pw@127.0.0.1:11434"), "127.0.0.1")
        self.assertEqual(R.host_of("https://API.Anthropic.COM./v1"), "api.anthropic.com")
        for public in ("api.anthropic.com", "api.openai.com", "openrouter.ai", "8.8.8.8"):
            self.assertFalse(R.private_host(public), public)

    def test_r1_r2_guard_downgrades_and_logs_without_urls(self):
        with self.assertLogs("dgc.reasoning", level="WARNING") as logs:
            self.assertEqual(R.enforce_rules("summarized", "anthropic", private=True, channel="anthropic.thinking",
                                             klass="private"), ("unknown", ""))
            self.assertEqual(R.enforce_rules("withheld", "", private=False, channel="responses.no_text",
                                             klass="openai"), ("unknown", ""))
            R.enforce_rules("summarized", "anthropic", private=True, channel="anthropic.thinking", klass="private")
        self.assertEqual(len(logs.output), 2, "once per rule/host class/channel")
        self.assertIn("rule=R2 host_class=private channel=anthropic.thinking", logs.output[0])
        for line in logs.output:
            self.assertNotIn("://", line)
            self.assertNotIn("127.0.0.1", line)
        self.assertEqual(R.enforce_rules("raw", "openai", private=True, channel="tags", klass="private"),
                         ("raw", ""), "a provider never rides on raw")

    def test_claude_summarizing_model_is_the_adaptive_rule(self):
        from dgc.llm import LLMClient
        for model in ("claude-opus-4-8", "claude-sonnet-4-6", "claude-fable-5-1", "claude-mythos-preview",
                      "claude-sonnet-4-5", "claude-3-7-sonnet-20250219", "claude-haiku-4-5", "claude-opus-5"):
            self.assertEqual(R.claude_summarizing_model(model), LLMClient._anthropic_adaptive_model(model), model)
        self.assertTrue(R.closed_reasoning_model("anthropic/claude-sonnet-5"))
        self.assertFalse(R.closed_reasoning_model("qwen3.8:27b"))
        self.assertFalse(R.closed_reasoning_model("gpt-oss:20b"))


# ---- placement and the tracker -----------------------------------------------------------------------

class NativeOllamaThinkTagTests(unittest.TestCase):
    """Native Ollama reasoning some templates wrap in a literal <think> ... </think> (qwen3-vl)."""

    class _Response:
        def __init__(self, frames):
            self.headers = {"Content-Type": "application/x-ndjson"}
            self.status_code = 200
            self.encoding = None
            self._text = "".join(json.dumps(frame) + "\n" for frame in frames)

        def iter_content(self, chunk_size=1, decode_unicode=False):
            yield self._text.encode()

        def close(self):
            pass

    @staticmethod
    def frames(thinking, content="Answer", done=True):
        out = [{"message": {"role": "assistant", "thinking": piece}, "done": False} for piece in thinking]
        out.append({"message": {"role": "assistant", "content": content}, "done": False})
        if done:
            out.append({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop"})
        return out

    def consume(self, frames):
        from dgc.llm import LLMClient
        client = LLMClient("http://127.0.0.1:11434", "k", "qwen3-vl:30b", api_mode="ollama")
        seen = []
        result = client._consume_ollama(self._Response(frames), None, lambda chunk, origin=None: seen.append(chunk))
        return result, seen

    def test_a_tag_split_across_chunks_is_stripped_before_the_ui_and_the_saved_thinking(self):
        result, seen = self.consume(self.frames(["<th", "ink>\n", "Plan it.", "\n</thi", "nk>"]))
        self.assertEqual("".join(seen), "Plan it.\n")
        self.assertEqual(result.thinking, "Plan it.\n")
        self.assertNotIn("<", "".join(seen))
        self.assertEqual(result.content, "Answer")
        self.assertEqual(result.provider_message["thinking"], "<think>\nPlan it.\n</think>",
                         "the provider's own text is what continuation sends back")

    def test_whole_tags_in_one_chunk_and_text_that_only_looks_like_a_tag(self):
        result, _ = self.consume(self.frames(["<think>Checking the file.</think>"]))
        self.assertEqual(result.thinking, "Checking the file.")
        result, _ = self.consume(self.frames(["<thinking about it", " carefully"]))
        self.assertEqual(result.thinking, "<thinking about it carefully", "not the tag: kept")
        result, _ = self.consume(self.frames(["a </think> b"]))
        self.assertEqual(result.thinking, "a </think> b", "a closing tag mid-text is text")
        result, _ = self.consume(self.frames(["Plain reasoning, no tags."]))
        self.assertEqual(result.thinking, "Plain reasoning, no tags.")

    def test_a_stream_that_ends_inside_the_thinking_keeps_what_it_held(self):
        result, seen = self.consume(self.frames(["<think>", "partial </th"], content="", done=False))
        self.assertEqual("".join(seen), "partial </th")
        self.assertEqual(result.finish_reason, "incomplete")


class PlacementTests(unittest.TestCase):
    def place(self, source, text, tools=True, **kwargs):
        options = {"inline_enabled": True, "max_chars": 280, "from_subagent": False, **kwargs}
        return R.placement(source, text, round_called_tools=tools, **options)

    def decide(self, source, text, **kwargs):
        options = {"inline_enabled": True, "max_chars": 280, "from_subagent": False, **kwargs}
        return R.can_decide_at_close(source, text, **options)

    def test_summarized_rules(self):
        self.assertEqual(self.place("summarized", "x" * 280), "inline")
        self.assertEqual(self.place("summarized", "x" * 281), "collapsed")
        self.assertEqual(self.place("summarized", "a\nb\nc\nd"), "inline")        # 4 lines
        self.assertEqual(self.place("summarized", "a\nb\nc\nd\ne"), "collapsed")  # 5 lines
        self.assertEqual(self.place("summarized", "use ```x```"), "collapsed")
        self.assertEqual(self.place("summarized", "short", tools=None), "collapsed")
        self.assertEqual(self.place("summarized", "short", tools=False), "collapsed")
        self.assertEqual(self.place("summarized", "short", from_subagent=True), "collapsed")
        self.assertEqual(self.place("summarized", "short", inline_enabled=False), "collapsed")
        self.assertEqual(self.place("summarized", "short", max_chars=0), "collapsed")
        self.assertEqual(self.place("narration", "short", max_chars=0, tools=None), "inline")
        self.assertEqual(self.place("narration", "x" * 1201), "collapsed")
        self.assertEqual(self.place("narration", "short", from_subagent=True), "collapsed")
        for source in ("raw", "unknown", "withheld"):
            self.assertEqual(self.place(source, "short"), "collapsed", source)

    def test_can_decide_at_close(self):
        self.assertFalse(self.decide("summarized", "x" * 280))
        self.assertTrue(self.decide("summarized", "x" * 281))
        self.assertFalse(self.decide("summarized", "a\nb\nc\nd"))
        self.assertTrue(self.decide("summarized", "a\nb\nc\nd\ne"))
        self.assertTrue(self.decide("summarized", "```"))
        self.assertTrue(self.decide("summarized", "short", from_subagent=True))
        self.assertTrue(self.decide("summarized", "short", inline_enabled=False))
        self.assertTrue(self.decide("summarized", "short", max_chars=0))
        for source in ("raw", "unknown", "narration", "withheld"):
            self.assertTrue(self.decide(source, "short"), source)
        self.assertEqual(R.clamp_max_chars(5000), 1000)
        self.assertEqual(R.clamp_max_chars(-3), 0)
        self.assertEqual(R.clamp_max_chars(True), 280)


class RecordingUI:
    def __init__(self):
        self.events = []

    def on_thinking(self, chunk, block=None):
        self.events.append(("delta", chunk, block))

    def on_thinking_end(self, block):
        self.events.append(("end", block))


class TrackerTests(unittest.TestCase):
    def tracker(self, ui, secrets=(), **kwargs):
        counter = {"n": 0}

        def seq():
            counter["n"] += 1
            return counter["n"]
        return R.ReasoningTracker(ui, seq=seq, redactor_factory=lambda: StreamingRedactor(secrets), **kwargs)

    def origin(self, source="raw", provider="", part="1:a0", **kwargs):
        return R.ReasoningOrigin(source=source, provider=provider, part=part, **kwargs)

    def test_secret_split_across_two_chunks_of_one_block_is_redacted(self):
        ui = RecordingUI()
        secret = "sk-live-" + "Z9" * 12
        tracker = self.tracker(ui, secrets=(secret,))
        tracker.thinking("the key is " + secret[:10], self.origin())
        tracker.thinking(secret[10:] + " and more", self.origin())
        blocks = tracker.finish(round_called_tools=False)
        streamed = "".join(event[1] for event in ui.events if event[0] == "delta")
        self.assertNotIn(secret, streamed)
        self.assertNotIn(secret, blocks[0].text)
        self.assertIn("[REDACTED", blocks[0].text)

    def test_a_block_change_flushes_the_redactor_first(self):
        ui = RecordingUI()
        secret = "sk-live-" + "Q7" * 12
        tracker = self.tracker(ui, secrets=(secret,))
        tracker.thinking("tail " + secret[:6], self.origin(part="1:a0"))
        tracker.thinking("second block", self.origin(part="1:a1"))
        kinds = [(event[0], event[1] if event[0] == "delta" else event[1].key) for event in ui.events]
        first_end = kinds.index(("end", "r1"))
        self.assertTrue(any(kind == "delta" and "sk-liv" in text or kind == "delta" and text.endswith(secret[:6])
                            for kind, text in kinds[:first_end]), kinds)
        self.assertEqual(kinds[-1], ("delta", "second block"))
        self.assertEqual(ui.events[-1][2].key, "r2")

    def test_seconds_use_stamps_and_last_delta_never_later_events(self):
        clock = FakeClock()
        ui = RecordingUI()
        with patch("dgc.reasoning.now", clock):
            tracker = self.tracker(ui)
            tracker.thinking("a", self.origin(t_start=clock() - 2.0))
            clock.advance(1.0)
            tracker.thinking("b", self.origin())
            clock.advance(5.0)                   # tool-argument generation: never counted
            blocks = tracker.finish(round_called_tools=True)
        self.assertEqual(blocks[0].seconds, 3.0)
        self.assertTrue(blocks[0].tools)

    def test_withheld_items_merge_and_empty_blocks_show_nothing(self):
        ui = RecordingUI()
        tracker = self.tracker(ui)
        tracker.thinking("", self.origin(source="withheld", provider="anthropic", part="1:a0", event="withheld"))
        tracker.thinking("", self.origin(source="withheld", provider="anthropic", part="1:a1", event="withheld"))
        tracker.thinking("", self.origin(source="unknown", part="1:a2", event="withheld"))   # proves nothing
        tracker.thinking("", self.origin(part="1:a3", event="stop"))                          # no block
        tracker.text_boundary()
        blocks = tracker.finish(round_called_tools=False)
        self.assertEqual([(b.source, b.provider) for b in blocks], [("withheld", "anthropic")])
        self.assertEqual([event[0] for event in ui.events], ["end"])

    def test_pending_summary_waits_for_the_request_and_decidable_blocks_do_not(self):
        ui = RecordingUI()
        tracker = self.tracker(ui)
        tracker.thinking("short note", self.origin(source="summarized", provider="openai", part="1:rs0"))
        tracker.thinking("x" * 300, self.origin(source="summarized", provider="openai", part="1:rs1"))
        tracker.thinking("", self.origin(source="summarized", provider="openai", part="1:rs1", event="stop"))
        self.assertEqual([e[1].key for e in ui.events if e[0] == "end"], ["r2"], "the long one is decidable")
        blocks = tracker.finish(round_called_tools=True)
        ends = [e[1] for e in ui.events if e[0] == "end"]
        self.assertEqual([(b.key, b.placement) for b in ends], [("r2", "collapsed"), ("r1", "inline")])
        self.assertEqual([b.key for b in blocks], ["r1", "r2"])
        self.assertEqual(tracker.finish(round_called_tools=True), [])

    def test_text_boundary_marks_after_text(self):
        ui = RecordingUI()
        tracker = self.tracker(ui)
        tracker.thinking("before", self.origin(part="1:a0"))
        tracker.text_boundary()
        tracker.thinking("after", self.origin(part="1:a2"))
        blocks = tracker.finish(round_called_tools=False)
        self.assertEqual([(b.text, b.after_text) for b in blocks], [("before", False), ("after", True)])

    def test_subagent_block_keeps_the_innermost_agent(self):
        block = R.ReasoningBlock(key="r1", source="summarized", provider="anthropic", placement="inline")
        inner = R.subagent_block(block, "sub-aaaaaaaaaaaa", end=True)
        outer = R.subagent_block(inner, "sub-bbbbbbbbbbbb", end=True)
        self.assertEqual((inner.key, inner.agent, inner.placement), ("sub-aaaaaaaaaaaa:r1", "sub-aaaaaaaaaaaa",
                                                                      "collapsed"))
        self.assertEqual((outer.key, outer.agent), ("sub-bbbbbbbbbbbb:sub-aaaaaaaaaaaa:r1", "sub-aaaaaaaaaaaa"))

    def test_one_argument_ui_still_works(self):
        seen = []

        class Old:
            def on_thinking(self, chunk):
                seen.append(chunk)
        tracker = self.tracker(Old())
        tracker.thinking("legacy", self.origin())
        tracker.finish(round_called_tools=None)
        self.assertEqual(seen, ["legacy"])

    def test_frame_invariants_catch_each_violation(self):
        ok = [{"type": "thinking_delta", "block": "t1:think1", "text": "a", "source": "raw"},
              {"type": "thinking_end", "block": "t1:think1", "source": "raw", "placement": "collapsed"},
              {"type": "stream_end"}]
        self.assertIsNone(R.reasoning_frame_error(ok))
        bad = {
            "changed source": ok[:1] + [{**ok[1], "source": "unknown"}],
            "no end": ok[:1] + [{"type": "stream_end"}],
            "two ends": ok[:2] + [ok[1]],
            "inline raw": ok[:1] + [{**ok[1], "placement": "inline"}],
            "withheld delta": [{**ok[0], "source": "withheld", "provider": "anthropic"}],
            "r1": [{**ok[0], "source": "summarized"}],
            "end without delta": [ok[1]],
        }
        for label, frames in bad.items():
            self.assertIsNotNone(R.reasoning_frame_error(frames), label)
        summarized = [{**ok[0], "source": "summarized", "provider": "anthropic"}]
        self.assertIsNotNone(R.reasoning_frame_error(summarized, private=True), "R2 sweep")


# ---- fixtures through the real Agent/Backend/HeadlessUI ---------------------------------------------

def load_fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"{name}.json").read_text())


class FixtureTests(unittest.TestCase):
    maxDiff = None

    def check_common(self, harness: Harness, fixture: dict, frames: list[dict], *, history=True):
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        private = bool(fixture.get("private"))
        self.assertIsNone(R.reasoning_frame_error(frames, private=private))
        self.assertEqual(harness.ui.reasoning_fallback_fired, 0, "block=None never fires in-tree")
        self.assertEqual(harness.ui.reasoning_safety_net_fired, 0, "the safety net never fires in-tree")
        self.assertEqual(harness.safety_net, 0)
        for request in harness.provider.captured:
            self.assertNotIn("_dgc_reasoning", json.dumps(request["json"]))
            self.assertNotIn("_dgc_think_splice", json.dumps(request["json"]))
            self.assertNotIn("anthropic-beta", {key.lower() for key in request["headers"]})
        blocks = live_blocks(frames)
        expected = fixture["expect"]["blocks"]
        self.assertEqual([[b["source"], b["provider"], b["end"]["placement"]] for b in blocks], expected)
        if private:
            self.assertFalse({b["source"] for b in blocks} & R.PROVIDER_SOURCES, "R2 sweep")
        if "seconds" in fixture["expect"]:
            self.assertEqual([b["end"].get("seconds") for b in blocks], fixture["expect"]["seconds"])
        # persisted == live
        persisted = [entry for message in harness.agent.messages if message.get("role") == "assistant"
                     for entry in message.get("_dgc_reasoning", [])]
        self.assertEqual([(e["source"], e["provider"], e["text"]) for e in persisted],
                         [(b["source"], b["provider"], b["text"]) for b in blocks])
        if not history:
            return blocks
        items = harness.history()
        for item in items:
            if isinstance(item.get("type"), str):
                self.assertIsNone(ep.event_error({**item, "seq": 0}), item)
        self.assertIsNone(R.reasoning_frame_error(
            [item for item in items if isinstance(item.get("type"), str)], history=True, private=private))
        replayed = live_blocks([item for item in items if isinstance(item.get("type"), str)])
        self.assertEqual([(b["source"], b["provider"], b["end"]["placement"], b["text"]) for b in replayed],
                         [(b["source"], b["provider"], b["end"]["placement"], b["text"]) for b in blocks])
        if fixture["expect"].get("no_think_in_history"):
            for item in items:
                if item.get("type") == "text_delta":
                    self.assertNotIn("<think>", item["text"])
        return blocks

    def run_fixture(self, name: str, **kwargs):
        fixture = load_fixture(name)
        harness = Harness(self, fixture, **kwargs)
        self.addCleanup(harness.close)
        harness.run()
        frames = harness.frames()
        return fixture, harness, frames

    def test_simple_rows(self):
        for name in ("02-ollama-split-tags", "03-ollama-closed-model", "05-chat-vllm-reasoning-content",
                     "06-chat-unknown-local-proxy", "07-chat-ollama-closed-model", "08-chat-openrouter",
                     "11-responses-ollama-summary-events", "11b-responses-ollama-json-summary",
                     "12-responses-vllm-reasoning-text", "13-responses-vllm-json-reasoning-text",
                     "14b-anthropic-sonnet-4-5-unknown", "18-anthropic-shape-on-ollama",
                     "19-anthropic-localhost-proxy", "20-anthropic-lookalike-host", "21-anthropic-retired-3-7"):
            with self.subTest(name):
                fixture, harness, frames = self.run_fixture(name)
                self.check_common(harness, fixture, frames)

    def test_row_1_ollama_raw_ends_before_the_first_text(self):
        fixture, harness, frames = self.run_fixture("01-ollama-native-thinking")
        self.check_common(harness, fixture, frames)
        kinds = [frame["type"] for frame in frames]
        self.assertLess(kinds.index("thinking_end"), kinds.index("text_delta"))
        ids = [frame["block"] for frame in frames if frame["type"] == "thinking_end"]
        self.assertEqual(ids, ["t1:think1", "t1:think2"])

    def test_row_2b_whitespace_between_thinking_keeps_one_block_live_and_in_history(self):
        fixture, harness, frames = self.run_fixture("02b-ollama-whitespace-between-thinking")
        blocks = self.check_common(harness, fixture, frames)
        self.assertEqual(blocks[0]["text"], "first half second half")
        kinds = [frame["type"] for frame in frames if frame["type"] in ("thinking_delta", "thinking_end",
                                                                        "text_delta")]
        kinds = [kind for index, kind in enumerate(kinds) if index == 0 or kinds[index - 1] != kind]
        # No prose frame inside the block: a frontend would close it there and draw the rest after
        # the answer.
        self.assertEqual(kinds, ["thinking_delta", "thinking_end", "text_delta"])
        texts = [frame["text"] for frame in frames if frame["type"] == "text_delta"]
        self.assertEqual(texts, ["\n\nAnswer."], "the whitespace joins the answer")
        history = [item for item in harness.history() if item.get("type") in
                   ("thinking_delta", "thinking_end", "text_delta")]
        self.assertEqual([item["type"] for item in history], ["thinking_delta", "thinking_end", "text_delta"])

    def test_whitespace_alone_while_a_block_is_open_is_delivered_after_its_end(self):
        fixture = copy.deepcopy(load_fixture("02b-ollama-whitespace-between-thinking"))
        fixture["requests"] = [{**fixture["requests"][0], "lines": [
            json.dumps({"model": "m", "message": {"role": "assistant", "thinking": "only thinking"}, "done": False}),
            json.dumps({"model": "m", "message": {"role": "assistant", "content": "\n"}, "done": False}),
            json.dumps({"model": "m", "message": {"role": "assistant", "content": ""}, "done": True,
                        "done_reason": "stop"})]}]
        # The reasoning-only reply earns a nudge; the second request answers.
        answer = [json.dumps({"model": "m", "message": {"role": "assistant", "content": "Answer."}, "done": False}),
                  json.dumps({"model": "m", "message": {"role": "assistant", "content": ""}, "done": True,
                              "done_reason": "stop"})]
        fixture["requests"].append({**fixture["requests"][0], "lines": answer})
        harness = Harness(self, fixture)
        self.addCleanup(harness.close)
        harness.run()
        frames = harness.frames()
        kinds = [frame["type"] for frame in frames if frame["type"] in ("thinking_delta", "thinking_end",
                                                                        "text_delta")]
        self.assertLess(kinds.index("thinking_end"), kinds.index("text_delta"),
                        "trailing whitespace is sent after the block's end")

    def test_row_4_chat_raw_with_preserve_thinking(self):
        fixture, harness, frames = self.run_fixture("04-chat-ollama-reasoning")
        self.check_common(harness, fixture, frames)
        saved = [m for m in harness.agent.messages if m.get("role") == "assistant"][-1]
        self.assertTrue(saved["content"].startswith("<think>\n"))
        self.assertEqual(saved["content"][saved["_dgc_think_splice"]:], "Here is the answer.")

    def test_row_9_openai_summaries_inline_then_collapsed(self):
        fixture, harness, frames = self.run_fixture("09-responses-openai-summaries")
        blocks = self.check_common(harness, fixture, frames)
        first = [m for m in harness.agent.messages if m.get("role") == "assistant"][0]
        short, long = fixture["expect"]["thinking_join"]
        self.assertTrue(first["content"].startswith("<think>\n" + short + "\n\n" + long + "\n</think>\n"),
                        "ChatResult.thinking joins parts with a blank line")
        self.assertEqual(first["_dgc_reasoning"][0]["tools"], True)
        self.assertEqual(len(blocks), 2)

    def test_rows_10_withheld_rows_precede_the_text(self):
        for name in ("10-responses-openai-encrypted-withheld", "10b-responses-openai-stateful-withheld",
                     "15-anthropic-redacted"):
            with self.subTest(name):
                fixture, harness, frames = self.run_fixture(name)
                self.check_common(harness, fixture, frames)
                kinds = [frame["type"] for frame in frames]
                self.assertEqual(kinds.count("thinking_end"), 1)
                self.assertNotIn("thinking_delta", kinds, "withheld and empty blocks stream nothing")
                self.assertLess(kinds.index("thinking_end"), kinds.index("text_delta"))

    def test_row_14_anthropic_summarized_inline_then_collapsed(self):
        fixture, harness, frames = self.run_fixture("14-anthropic-summarized")
        self.check_common(harness, fixture, frames)
        bodies = [request["json"] for request in harness.provider.captured if request["url"].endswith("/messages")]
        self.assertTrue(bodies)
        for body in bodies:
            self.assertEqual(body["thinking"], {"type": "adaptive", "display": "summarized"})
        end = next(frame for frame in frames if frame["type"] == "thinking_end")
        self.assertEqual(end["placement"], "inline")
        stream_end = next(i for i, frame in enumerate(frames) if frame["type"] == "stream_end")
        self.assertLess(frames.index(end), stream_end, "a pending summary ends before its stream_end")

    def test_seconds_exclude_function_call_arguments(self):
        fixture, harness, frames = self.run_fixture("seconds-responses-arguments")
        self.check_common(harness, fixture, frames)

    def test_row_24_overthink_repost_gives_two_blocks(self):
        fixture, harness, frames = self.run_fixture("24-anthropic-overthink-repost")
        blocks = self.check_common(harness, fixture, frames)
        self.assertEqual(len({b["block"] for b in blocks}), 2)
        self.assertNotIn("Short.", blocks[0]["text"])
        self.assertEqual(blocks[1]["text"], "Short.")
        self.assertEqual(len([r for r in harness.provider.captured if r["url"].endswith("/messages")]), 2)

    def test_row_25_fallback_keeps_both_blocks(self):
        fixture, harness, frames = self.run_fixture("25-fallback-anthropic-then-ollama")
        self.check_common(harness, fixture, frames)
        saved = [m for m in harness.agent.messages if m.get("role") == "assistant"]
        self.assertEqual(len(saved), 1)
        self.assertEqual([e["source"] for e in saved[0]["_dgc_reasoning"]], ["summarized", "raw"])

    def test_row_26_pause_turn_keeps_both_requests(self):
        fixture, harness, frames = self.run_fixture("26-anthropic-pause-turn")
        self.check_common(harness, fixture, frames)
        saved = [m for m in harness.agent.messages if m.get("role") == "assistant"]
        self.assertEqual(len(saved), 1)
        self.assertEqual([e["text"] for e in saved[0]["_dgc_reasoning"]],
                         ["Searching the docs.", "Found the answer."])

    def test_row_27_ids_unique_live_and_in_history(self):
        fixture, harness, frames = self.run_fixture("27-multi-round-turn")
        self.check_common(harness, fixture, frames)
        live = [frame["block"] for frame in frames if frame["type"] == "thinking_end"]
        self.assertEqual(live, fixture["expect"]["live_ids"])
        history = [item["block"] for item in harness.history() if item.get("type") == "thinking_end"]
        self.assertEqual(history, fixture["expect"]["history_ids"])

    def test_row_22_parallel_subagents_carry_agent_and_never_merge(self):
        child_lines = [json.dumps({"model": "m", "message": {"role": "assistant", "thinking": "Child looks."},
                                   "done": False}),
                       json.dumps({"model": "m", "message": {"role": "assistant", "content": "Child done."},
                                   "done": False}),
                       json.dumps({"model": "m", "message": {"role": "assistant", "content": ""}, "done": True,
                                   "done_reason": "stop"})]
        parent = load_fixture("14-anthropic-summarized")
        first = parent["requests"][0]["lines"]
        tasks = []
        for line in first:
            tasks.append(line)
        # Replace the single ls call with two task calls (a parallel, auto-approved batch).
        text = "\n".join(line if isinstance(line, str) else "" for line in first)
        self.assertIn("toolu_1", text)
        parent["requests"][0]["lines"] = [
            line.replace('"name": "glob"', '"name": "task"').replace(
                '{\\"pattern\\": \\"*\\"}', '{\\"description\\": \\"look\\", \\"prompt\\": \\"look around\\"}')
            if isinstance(line, str) else line for line in first]
        second_tool = []
        for line in parent["requests"][0]["lines"]:
            second_tool.append(line)
        # Build a second tool_use block by duplicating index 1 as index 2.
        lines = parent["requests"][0]["lines"]
        start = next(i for i, l in enumerate(lines) if isinstance(l, str) and '"index": 1' in l
                     and "content_block_start" in l) - 1
        stop = next(i for i, l in enumerate(lines) if isinstance(l, str) and '"index": 1' in l
                    and "content_block_stop" in l) + 2
        duplicate = [l.replace('"index": 1', '"index": 2').replace("toolu_1", "toolu_2")
                     if isinstance(l, str) else l for l in lines[start:stop]]
        parent["requests"][0]["lines"] = lines[:stop] + duplicate + lines[stop:]
        parent["config"] = {**parent.get("config", {}), "subagent_base_url": "http://127.0.0.1:11434",
                            "subagent_model": "qwen3.8:27b", "subagent_api_mode": "ollama",
                            "max_parallel_tasks": 4}
        parent["private"] = False
        harness = Harness(self, parent, git=True,
                          extra_entries=[{"match": "11434/api/chat", "status": 200,
                                          "content_type": "application/x-ndjson", "lines": child_lines,
                                          "repeat": True}])
        self.addCleanup(harness.close)
        with patch.object(harness.config, "clone_for_root", lambda root: harness.config, create=True):
            harness.run()
        frames = harness.frames()
        for frame in frames:
            self.assertIsNone(ep.event_error(frame), frame)
        self.assertIsNone(R.reasoning_frame_error(frames))
        self.assertEqual(harness.ui.reasoning_fallback_fired + harness.ui.reasoning_safety_net_fired, 0)
        blocks = live_blocks(frames)
        children = [b for b in blocks if b["agent"]]
        self.assertEqual(len(children), 2, [b["block"] for b in blocks])
        self.assertEqual(len({b["agent"] for b in children}), 2)
        for child in children:
            self.assertRegex(child["agent"], r"^sub-[0-9a-f]{12}$")
            self.assertEqual((child["source"], child["end"]["placement"]), ("raw", "collapsed"))
            positions = [i for i, f in enumerate(frames)
                         if f.get("type", "").startswith("thinking_") and f.get("block") == child["block"]]
            self.assertEqual(positions, list(range(positions[0], positions[-1] + 1)),
                             "a buffered child's reasoning replays contiguously")
        parents = [b for b in blocks if not b["agent"]]
        self.assertTrue(parents and all(b["source"] == "summarized" for b in parents))

    def test_row_23_subscription_thinking_is_unknown(self):
        from dgc import subscriptions as S
        claude_lines = [
            {"type": "system", "session_id": "sess-1"},
            {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "Reading the repo."}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "\n\n"}]}},
            {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": " Found it."}]}},
            {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Bash",
                                                           "input": {"command": "ls"}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "a"}]}},
            {"type": "assistant", "message": {"content": [{"type": "thinking", "thinking": "Now answer."}]}},
            {"type": "assistant", "message": {"content": [{"type": "text", "text": "Done."}]}},
            {"type": "result", "result": "Done.", "session_id": "sess-1"},
        ]
        codex_lines = [
            {"type": "thread.started", "thread_id": "th-1"},
            {"type": "item.completed", "item": {"type": "reasoning", "id": "r1", "text": "Planning."}},
            {"type": "item.started", "item": {"type": "command_execution", "id": "c1", "command": "ls"}},
            {"type": "item.completed", "item": {"type": "command_execution", "id": "c1",
                                                "aggregated_output": "a", "exit_code": 0}},
            {"type": "item.completed", "item": {"type": "reasoning", "id": "r2", "text": "Wrap up."}},
            {"type": "item.completed", "item": {"type": "agent_message", "id": "m1", "text": "Done."}},
        ]
        for stream, lines, expected_blocks in (("claude", claude_lines, 2), ("codex", codex_lines, 2)):
            with self.subTest(stream):
                with tempfile.TemporaryDirectory(prefix="dgc-sub-") as directory:
                    config = fixture_config(Path(directory), subscription_engine=stream)
                    out = io.StringIO()
                    emitter = Emitter(out, validator=ep.event_error)
                    ui = HeadlessUI(emitter, PendingRequests())
                    ui.turn_id = "t1"
                    ui.reset_turn_messages()
                    agent = types.SimpleNamespace(
                        cancelled=threading.Event(), _active_goal_request=None,
                        _secret_values=lambda: (), subscription_session_id=lambda *a: "",
                        remember_subscription_session=lambda *a: None,
                        run_external_turn=lambda prompt, runner, reset_cancel=False: runner(prompt))

                    def fake_run_turn(engine, prompt, workdir, *, on_event=None, **kwargs):
                        for line in lines:
                            for event in S.parse_stream_events(stream, json.dumps(line)):
                                on_event(event)
                        return {"rc": 0, "text": "Done.", "ok": True}
                    with patch.object(S, "run_turn", fake_run_turn):
                        S.delegate_turn(config, agent, ui, S.get_engine(stream), "go")
                    self.assertEqual(ui.close_open_reasoning(), 0)
                    emitter.emit("turn_end", turn_id="t1", reason="completed", token_estimate=0,
                                 final_message_id=ui.final_message_id)
                frames = frames_of(out)
                for frame in frames:
                    self.assertIsNone(ep.event_error(frame), frame)
                self.assertIsNone(R.reasoning_frame_error(frames))
                blocks = live_blocks(frames)
                self.assertEqual(len(blocks), expected_blocks)
                self.assertEqual({b["source"] for b in blocks}, {"unknown"})
                ends = [frame for frame in frames if frame["type"] == "thinking_end"]
                self.assertEqual(len(ends), len(blocks), "one thinking_end per block")
                self.assertEqual(ui.reasoning_fallback_fired, 0)
                first_block = blocks[0]["block"]
                first_end = next(i for i, f in enumerate(frames)
                                 if f["type"] == "thinking_end" and f["block"] == first_block)
                self.assertNotIn("text_delta", [f["type"] for f in frames[:first_end]],
                                 "whitespace inside an open block is not sent as prose")


# ---- persistence and history ---------------------------------------------------------------------------

def history_backend(messages, **config_values):
    backend = object.__new__(Backend)
    config = types.SimpleNamespace(get=lambda key, default=None: config_values.get(key, default))
    backend.agent = types.SimpleNamespace(messages=messages, config=config)
    backend.config = config
    return backend


def typed(items):
    return [item for item in items if isinstance(item.get("type"), str)]


class HistoryTests(unittest.TestCase):
    def assert_valid(self, items):
        for item in typed(items):
            self.assertIsNone(ep.event_error({**item, "seq": 0}), item)
        self.assertIsNone(R.reasoning_frame_error(typed(items), history=True))

    def test_legacy_v13_sessions(self):
        messages = [
            {"role": "user", "content": "one"},
            {"role": "assistant", "content": "ollama answer",
             "_provider_message": {"provider": "ollama", "content": "ollama answer", "thinking": "local thought"}},
            {"role": "user", "content": "two"},
            {"role": "assistant", "content": "claude answer", "_provider_message": {"provider": "anthropic", "content": [
                {"type": "thinking", "thinking": "claude thought", "signature": "s"},
                {"type": "redacted_thinking", "data": "x"},
                {"type": "text", "text": "claude answer"}]}},
            {"role": "user", "content": "three"},
            {"role": "assistant", "content": "responses answer", "_responses_output": [
                {"type": "reasoning", "summary": [{"type": "summary_text", "text": "part a"},
                                                  {"type": "summary_text", "text": "part b"}]}]},
            {"role": "user", "content": "four"},
            {"role": "assistant", "content": "<think>\nspliced thought\n</think>\nspliced answer"},
        ]
        items = history_backend(messages)._history()
        self.assert_valid(items)
        blocks = live_blocks(typed(items))
        self.assertEqual([(b["source"], b["text"]) for b in blocks],
                         [("raw", "local thought"), ("unknown", "claude thought"),
                          ("unknown", "part a\n\npart b"), ("unknown", "spliced thought")])
        texts = [item["text"] for item in items if item.get("type") == "text_delta"]
        self.assertEqual(texts[-1], "spliced answer")
        self.assertNotIn("<think>", "".join(texts))

    def test_splice_marker_strips_exactly(self):
        content = "<think>\nplan\n</think>\nanswer with <think>\nliteral\n</think>\n tags"
        message = {"role": "assistant", "content": content, "_dgc_think_splice": len("<think>\nplan\n</think>\n"),
                   "_dgc_reasoning": [{"v": 1, "source": "raw", "text": "plan"}]}
        items = history_backend([{"role": "user", "content": "q"}, message])._history()
        text = next(item["text"] for item in items if item.get("type") == "text_delta")
        self.assertEqual(text, "answer with <think>\nliteral\n</think>\n tags")

    def test_splice_marker_survives_a_later_save_with_a_new_secret(self):
        from dgc import sessions
        secret = "correct-horse-battery-staple-42"
        thinking = f"The deploy password is {secret}; do not print it."
        answer = "Answer without the password, and a literal <think>\nx\n</think>\n tag."
        content = "<think>\n" + thinking + "\n</think>\n" + answer
        message = {"role": "assistant", "content": content,
                   "_dgc_think_splice": R.splice_prefix_length(content, thinking),
                   "_dgc_reasoning": [{"v": 1, "source": "raw", "private": True, "text": thinking}]}
        with tempfile.TemporaryDirectory(prefix="dgc-splice-") as directory:
            root = Path(directory)
            path = sessions.new_path(root)
            # The secret was configured after the message was first saved: this save re-redacts it.
            self.assertTrue(sessions.save(path, [{"role": "user", "content": "q"}, message], root,
                                          redact_secrets=[secret]))
            loaded = sessions.load(path, root)
        saved = loaded[-1]
        self.assertNotIn(secret, json.dumps(loaded))
        marker = saved["_dgc_think_splice"]
        self.assertFalse(saved["content"][:marker].endswith("\n</think>\n"), "the marker no longer matches")
        self.assertEqual(R.display_text(saved, saved["content"]), answer)
        items = typed(history_backend(loaded)._history())
        self.assertEqual([item["text"] for item in items if item["type"] == "text_delta"], [answer])
        self.assert_valid(items)
        rows = bare_tui()._message_rows(loaded)[0][0]
        self.assertEqual([row["body"] for row in rows if row["who"] == "assistant"], [answer.strip()])
        # A marker with no closing tag anywhere leaves the text alone.
        self.assertEqual(R.display_text({"_dgc_think_splice": 12}, "<think>\nno close"), "<think>\nno close")

    def test_session_fuzz_never_raises_and_every_item_validates(self):
        huge = "y" * (2 * 1024 * 1024)
        cases = [
            "not a list", {"source": "raw"}, [None, 3, "x"],
            [{"source": "summary", "provider": "anthropic", "text": "bad enum"}],
            [{"source": "raw", "seconds": float("nan"), "text": "nan"}],
            [{"source": "raw", "seconds": -4, "text": "negative"}],
            [{"source": "raw", "seconds": 10 ** 12, "text": "huge seconds"}],
            [{"source": "raw", "seconds": True, "text": "bool seconds"}],
            [{"source": "raw", "text": huge}],
            [{"source": "raw", "text": f"entry {i}"} for i in range(10_000)],
            [{"source": "summarized", "provider": "anthropic", "private": True, "text": "r2 on replay"}],
            [{"source": "summarized", "provider": "ollama", "text": "bad provider"}],
            [{"source": "withheld", "text": "no provider"}],
            [{"source": "raw", "provider": "openai", "text": 42, "tools": "yes", "after_text": 1}],
        ]
        for case in cases:
            with self.subTest(repr(case)[:60]):
                messages = [{"role": "user", "content": "q"},
                            {"role": "assistant", "content": "a", "_dgc_reasoning": case}]
                items = history_backend(messages)._history()
                self.assert_valid(items)
                self.assertTrue(any(item.get("type") == "text_delta" for item in items))
                for block in live_blocks(typed(items)):
                    self.assertLessEqual(len(block["text"]), R.REPLAY_BLOCK_CHARS)
                    if block["source"] in R.PROVIDER_SOURCES:
                        self.assertTrue(block["provider"])
                if isinstance(case, list) and len(case) == 10_000:
                    self.assertEqual(len(live_blocks(typed(items))), R.PERSIST_MAX_BLOCKS)
        r2 = history_backend([{"role": "user", "content": "q"}, {"role": "assistant", "content": "a",
                              "_dgc_reasoning": cases[10]}])._history()
        self.assertEqual(live_blocks(typed(r2))[0]["source"], "unknown")

    def test_budget_keeps_recent_prose_and_bounds_reasoning(self):
        messages = []
        for n in range(300):
            messages.append({"role": "user", "content": f"prompt {n}"})
            messages.append({"role": "assistant", "content": f"answer {n}",
                             "_dgc_reasoning": [{"v": 1, "source": "raw", "text": f"{n:04d}" + "r" * 7996}]})
        items = history_backend(messages)._history()
        self.assert_valid(items)
        reasoning_chars = sum(len(item["text"]) for item in items if item.get("type") == "thinking_delta")
        self.assertLessEqual(reasoning_chars, R.REPLAY_PAYLOAD_CHARS)
        prompts = [item["prompt"] for item in items if item.get("type") == "turn_start"]
        self.assertGreaterEqual(len(prompts), 40)
        self.assertEqual(prompts[-40:], [f"prompt {n}" for n in range(260, 300)])
        newest = [item for item in items if item.get("type") == "thinking_delta"][-1]
        self.assertEqual(len(newest["text"]), R.REPLAY_BLOCK_CHARS)
        ends = [item for item in items if item.get("type") == "thinking_end"]
        self.assertTrue(all(end.get("truncated") for end in ends), "every 8,000-char block was cut")

    def test_settings_apply_on_replay(self):
        entry = {"v": 1, "source": "summarized", "provider": "anthropic", "text": "Short note.", "tools": True}
        messages = [{"role": "user", "content": "q"},
                    {"role": "assistant", "content": "", "tool_calls": [
                        {"id": "c1", "type": "function", "function": {"name": "ls", "arguments": "{}"}}],
                     "_dgc_reasoning": [entry]},
                    {"role": "tool", "tool_call_id": "c1", "content": "ok"}]
        on = history_backend(messages)._history()
        off = history_backend(messages, thinking_inline=False)._history()
        self.assertEqual([i["placement"] for i in on if i.get("type") == "thinking_end"], ["inline"])
        self.assertEqual([i["placement"] for i in off if i.get("type") == "thinking_end"], ["collapsed"])
        zero = history_backend(messages, thinking_inline_max_chars=0)._history()
        self.assertEqual([i["placement"] for i in zero if i.get("type") == "thinking_end"], ["collapsed"])

    def test_after_text_order_and_history_ids(self):
        messages = [{"role": "user", "content": "q"},
                    {"role": "assistant", "content": "prose", "_dgc_reasoning": [
                        {"v": 1, "source": "raw", "text": "before"},
                        {"v": 1, "source": "withheld", "provider": "anthropic", "text": "", "seconds": 6.0},
                        {"v": 1, "source": "raw", "text": "after", "after_text": True}]},
                    {"role": "user", "content": "q2"},
                    {"role": "assistant", "content": "prose2", "_dgc_reasoning": [
                        {"v": 1, "source": "raw", "text": "second turn"}]}]
        items = typed(history_backend(messages)._history())
        sequence = [(item["type"], item.get("block") or item.get("text")) for item in items
                    if item["type"] in ("thinking_delta", "thinking_end", "text_delta")]
        self.assertEqual(sequence, [
            ("thinking_delta", "h1:think1"), ("thinking_end", "h1:think1"), ("thinking_end", "h1:think2"),
            ("text_delta", "prose"), ("thinking_delta", "h1:think3"), ("thinking_end", "h1:think3"),
            ("thinking_delta", "h2:think1"), ("thinking_end", "h2:think1"), ("text_delta", "prose2")])

    def test_persisted_bounds_and_pause_merge(self):
        blocks = [R.ReasoningBlock(key=f"r{i}", source="raw", text="z" * 9000) for i in range(70)]
        entries = R.persisted_reasoning(blocks)
        self.assertEqual(len(entries), R.PERSIST_MAX_BLOCKS)
        self.assertEqual([len(e["text"]) for e in entries[:4]], [8000, 8000, 8000, 0])
        self.assertLessEqual(sum(len(e["text"]) for e in entries), R.PERSIST_MESSAGE_CHARS)
        self.assertTrue(all(e["truncated"] for e in entries), "past a bound the text is cut and flagged")
        many = R.persisted_reasoning([R.ReasoningBlock(key=f"r{i}", source="raw", text="z") for i in range(70)])
        self.assertEqual(len(many), 64)
        merged = R.extend_persisted_reasoning([{"text": "a" * 7000}] * 2, [{"text": "b" * 7000}] * 2)
        self.assertEqual([len(e["text"]) for e in merged], [7000, 7000, 7000, 3000])
        self.assertTrue(merged[3]["truncated"] and not merged[0].get("truncated"))

    def test_estimate_tokens_fallback_skips_reasoning(self):
        agent = object.__new__(Agent)
        agent.client = object()
        agent.messages = [{"role": "assistant", "content": "hi", "_dgc_reasoning": [{"text": "x" * 40000}]}]
        self.assertLess(agent.estimate_tokens(tools=None), 100)


# ---- HeadlessUI ---------------------------------------------------------------------------------------

class HeadlessUITests(unittest.TestCase):
    def ui(self):
        stream = io.StringIO()
        ui = HeadlessUI(Emitter(stream, validator=ep.event_error), PendingRequests())
        ui.turn_id = "t9"
        ui.reset_turn_messages()
        return ui, stream

    def test_ids_are_minted_per_block_and_reset_per_turn(self):
        ui, stream = self.ui()
        a = R.ReasoningBlock(key="r5", source="summarized", provider="anthropic")
        ui.on_thinking("x", a)
        ui.on_thinking_end(R.ReasoningBlock(key="r5", source="summarized", provider="anthropic",
                                            placement="inline", seconds=2.14))
        ui.on_thinking_end(R.ReasoningBlock(key="r6", source="withheld", provider="anthropic", seconds=6))
        ui.turn_id = "t10"
        ui.reset_turn_messages()
        ui.on_thinking("y", R.ReasoningBlock(key="r7", source="raw", agent="sub-0123456789ab"))
        ui.on_thinking_end(R.ReasoningBlock(key="r7", source="raw", agent="sub-0123456789ab",
                                            placement="inline"))
        frames = frames_of(stream)
        self.assertEqual([(f["type"], f["block"]) for f in frames if "block" in f],
                         [("thinking_delta", "t9:think1"), ("thinking_end", "t9:think1"),
                          ("thinking_end", "t9:think2"), ("thinking_delta", "t10:think1"),
                          ("thinking_end", "t10:think1")])
        ends = [f for f in frames if f["type"] == "thinking_end"]
        self.assertEqual((ends[0]["placement"], ends[0]["seconds"]), ("inline", 2.1))
        self.assertEqual(ends[2]["placement"], "collapsed", "a sub-agent block is never inline")
        self.assertEqual(ends[2]["agent"], "sub-0123456789ab")

    def test_block_none_fallback_and_safety_net(self):
        ui, stream = self.ui()
        ui.on_thinking("old caller")
        ui.on_thinking(" more")
        ui.on_text("prose")
        ui.on_thinking("dangling", R.ReasoningBlock(key="r1", source="raw"))
        self.assertEqual(ui.close_open_reasoning(), 1)
        frames = frames_of(stream)
        self.assertIsNone(R.reasoning_frame_error(frames))
        self.assertEqual((ui.reasoning_fallback_fired, ui.reasoning_safety_net_fired), (1, 1))
        kinds = [f["type"] for f in frames if f["type"] != "turn_activity"]
        self.assertEqual(kinds, ["thinking_delta", "thinking_delta", "thinking_end", "text_delta",
                                 "thinking_delta", "thinking_end"])

    def test_r1_and_enum_checks(self):
        ui, stream = self.ui()
        ui.on_thinking("x", R.ReasoningBlock(key="r1", source="summarized", provider=""))
        ui.on_thinking("x", R.ReasoningBlock(key="r2", source="made-up", provider="google"))
        frames = [f for f in frames_of(stream) if f["type"] == "thinking_delta"]
        self.assertEqual([(f["source"], f.get("provider")) for f in frames], [("unknown", None), ("unknown", None)])

    def test_config_keys_touch_points(self):
        from dgc import headless
        self.assertIn("thinking_inline", headless._LIVE_SAFE_CONFIG_KEYS)
        self.assertIn("thinking_inline_max_chars", headless._LIVE_SAFE_CONFIG_KEYS)
        self.assertIn("thinking_inline", headless._CONFIG_BOOLEAN_KEYS)
        self.assertEqual(headless._CONFIG_INTEGER_RANGES["thinking_inline_max_chars"], (0, 1000))
        self.assertEqual((DEFAULTS["thinking_inline"], DEFAULTS["thinking_inline_max_chars"]), (True, 280))
        values, problem = headless._validated_config_values({"thinking_inline": False,
                                                             "thinking_inline_max_chars": 0}, ())
        self.assertIsNone(problem)
        self.assertIsNotNone(headless._validated_config_values({"thinking_inline_max_chars": 1001}, ())[1])
        self.assertIsNotNone(headless._validated_config_values({"thinking_inline": "yes"}, ())[1])

    def test_protocol_requires_block_and_source(self):
        ok = {"type": "thinking_delta", "seq": 0, "text": "x", "block": "t1:think1", "source": "raw"}
        self.assertIsNone(ep.event_error(ok))
        for missing in ("block", "source"):
            self.assertIsNotNone(ep.event_error({k: v for k, v in ok.items() if k != missing}))


# ---- TUI and line CLI ---------------------------------------------------------------------------------

def bare_tui(width=80, **config):
    from dgc.tui import TUI
    tui = object.__new__(TUI)
    tui._width = width
    tui._scroll_off = 0
    tui._invalidate = lambda: None
    tui._buf = ""
    tui._think = ""
    tui._think_t0 = None
    tui._thinking = False
    tui._model_wait = None
    tui._backend_activity = None
    tui._streaming = False
    tui._cur_tool = None
    tui.blocks = []
    tui.config = {"show_reasoning": True, "thinking_inline": True, **config}
    return tui


def plain(frags) -> str:
    from prompt_toolkit.formatted_text import fragment_list_to_text
    return fragment_list_to_text(frags)


class TUITests(unittest.TestCase):
    def test_suffix_per_source_and_width(self):
        tui = bare_tui(80)
        cases = {("raw", ""): "Thought for 3.2s · raw",
                 ("summarized", "anthropic"): "Thought for 3.2s · summarized by Anthropic",
                 ("summarized", "openai"): "Thought for 3.2s · summarized by OpenAI",
                 ("unknown", ""): "Thought for 3.2s"}
        for (source, provider), label in cases.items():
            text = plain(tui._think_frags({"kind": "think", "secs": 3.2, "text": "t", "source": source,
                                           "provider": provider}))
            self.assertTrue(text.endswith(label), text)
            self.assertIn("▸", text)
        narrow = bare_tui(50)
        text = plain(narrow._think_frags({"kind": "think", "secs": 3.2, "text": "t", "source": "summarized",
                                          "provider": "anthropic"}))
        self.assertTrue(text.endswith("· summarized"), text)

    def test_withheld_has_no_handler_or_caret(self):
        tui = bare_tui()
        frags = tui._think_frags({"kind": "think", "withheld": True, "secs": 6, "source": "withheld",
                                  "provider": "anthropic", "text": ""})
        self.assertEqual(plain(frags), "◆   Thought for 6.0s · hidden by Anthropic".replace("◆", frags[0][1][0]))
        header = plain(tui._think_frags({"kind": "think", "secs": 6, "source": "raw", "text": "t"}))
        self.assertEqual(plain(frags).index("Thought"), header.index("Thought"), "labels line up")
        self.assertFalse(any(len(f) > 2 for f in frags))
        self.assertNotIn("▸", plain(frags))

    def test_sub_tenth_second_reads_thought_and_truncated_blocks_say_so(self):
        tui = bare_tui()
        self.assertTrue(plain(tui._think_frags({"kind": "think", "secs": 0.02, "text": "t", "source": "raw"}))
                        .endswith("▸ Thought · raw"))
        cut = plain(tui._think_frags({"kind": "think", "secs": 3, "text": "a first slice", "source": "raw",
                                      "truncated": True, "exp": True}))
        self.assertIn("a first slice", cut)
        self.assertTrue(cut.endswith("… the rest of this reasoning was not kept."), cut)
        whole = plain(tui._think_frags({"kind": "think", "secs": 3, "text": "all of it", "source": "raw",
                                        "exp": True}))
        self.assertNotIn("not kept", whole)
        messages = [{"role": "user", "content": "q"},
                    {"role": "assistant", "content": "answer",
                     "_dgc_reasoning": [{"source": "raw", "text": "", "truncated": True, "seconds": 12},
                                        {"source": "raw", "text": "", "seconds": 1}]}]
        from dgc.tui import TUI
        tui._rich = lambda value: str(value)
        blocks, _ = TUI._history_blocks(tui, tui._message_rows(messages)[0][0])
        thinks = [b for b in blocks if isinstance(b, dict) and b.get("kind") == "think"]
        self.assertEqual(len(thinks), 1, "a header-only block is kept only when it was cut")
        thinks[0]["exp"] = True
        self.assertTrue(plain(tui._think_frags(thinks[0])).endswith("The text of this reasoning was not kept."))

    def test_thoughts_submenu_marks_the_current_of_three_states(self):
        from dgc.tui import TUI
        options, current = TUI._SUBMENUS["thoughts"]
        values = {value for _, value in options}
        for config, expected in (({"show_reasoning": False}, "hide"),
                                 ({"show_reasoning": True, "thinking_inline": True}, "inline"),
                                 ({"show_reasoning": True, "thinking_inline": False}, "collapsed"),
                                 ({}, "inline")):
            tui = types.SimpleNamespace(config=dict(config))
            self.assertEqual(current(tui), expected, config)
            self.assertIn(expected, values)

    def test_note_hint_on_last_line_or_after_a_list(self):
        tui = bare_tui(60)
        lines = tui._narration_lines("Checked the tests. Now editing the gate.", 58)
        self.assertEqual(lines, [("Checked the tests. Now editing the gate.", True)])
        text = plain(tui._narration_frags({"kind": "narration", "text": "Checked the tests."}))
        self.assertEqual(text, "Checked the tests. · summarized")
        listed = tui._narration_lines("Plan:\n- run tests\n- fix gate", 58)
        self.assertEqual(listed[-1], ("· summarized", True))
        self.assertEqual(listed[-2], ("- fix gate", False))

    def test_show_reasoning_false_renders_nothing(self):
        tui = bare_tui(show_reasoning=False)
        tui.on_thinking("hidden", R.ReasoningBlock(key="r1", source="raw"))
        tui.on_thinking_end(R.ReasoningBlock(key="r1", source="raw", seconds=1.0))
        tui.on_thinking_end(R.ReasoningBlock(key="r2", source="withheld", provider="anthropic"))
        tui.on_text("answer")
        tui._flush_think()
        self.assertEqual([b for b in tui.blocks if isinstance(b, dict) and b.get("kind") in ("think", "narration")], [])
        self.assertNotIn("hidden", plain(tui._transcript()))

    def test_two_keys_in_one_round_give_two_blocks_and_ends_relabel(self):
        tui = bare_tui()
        tui.on_thinking("first", R.ReasoningBlock(key="r1", source="summarized", provider="anthropic"))
        tui.on_thinking("second", R.ReasoningBlock(key="r2", source="summarized", provider="anthropic"))
        tui.on_thinking_end(R.ReasoningBlock(key="r2", source="summarized", provider="anthropic", seconds=4.0))
        tui.on_thinking_end(R.ReasoningBlock(key="r1", source="summarized", provider="anthropic",
                                             placement="inline", seconds=1.5))
        kinds = [(b["kind"], b["text"], b["secs"]) for b in tui.blocks]
        self.assertEqual(kinds, [("narration", "first", 1.5), ("think", "second", 4.0)])
        text = plain(tui._transcript())
        self.assertIn("first · summarized", text)
        self.assertIn("Thought for 4.0s · summarized by Anthropic", text)

    def test_live_header_suffix_and_subagent_prefix(self):
        tui = bare_tui()
        tui.on_thinking("streaming", R.ReasoningBlock(key="r1", source="raw", agent="sub-0123456789ab"))
        text = plain(tui._transcript())
        self.assertIn("sub-agent · Thinking… · raw", text)

    def test_restore_reads_sanitized_reasoning(self):
        tui = bare_tui()
        messages = [{"role": "user", "content": "q"},
                    {"role": "assistant", "content": "answer", "tool_calls": [{"function": {"name": "ls"}}],
                     "_dgc_reasoning": [{"source": "summarized", "provider": "anthropic", "text": "short",
                                         "tools": True, "seconds": 2},
                                        {"source": "withheld", "provider": "anthropic", "seconds": 6},
                                        {"source": "bogus", "text": "odd", "after_text": True}]}]
        rows = tui._message_rows(messages)[0][0]
        from dgc.tui import TUI
        tui._rich = lambda value: str(value)
        blocks, _ = TUI._history_blocks(tui, rows)
        kinds = [(b.get("kind"), b.get("source"), b.get("withheld", False)) for b in blocks
                 if isinstance(b, dict) and b.get("kind") != "user"]
        self.assertEqual(kinds[:4], [("narration", "summarized", False), ("think", "withheld", True),
                                     ("md", None, False), ("think", "unknown", False)])
        tui.config["thinking_inline"] = False
        blocks, _ = TUI._history_blocks(tui, rows)
        self.assertEqual(blocks[1]["kind"], "think")


class LineCLITests(unittest.TestCase):
    def test_labels(self):
        self.assertEqual(R.cli_thinking_label("raw", ""), "· thinking (raw)…")
        self.assertEqual(R.cli_thinking_label("summarized", "anthropic"), "· thinking (summarized by Anthropic)…")
        self.assertEqual(R.cli_thinking_label("unknown", ""), "· thinking…")
        self.assertEqual(R.cli_thinking_label("withheld", "anthropic"), "· thinking (hidden by Anthropic)")
        from rich.console import Console
        from dgc.cli import UI
        ui = object.__new__(UI)
        ui.console = Console(file=io.StringIO(), width=100, force_terminal=False)
        ui._thinking = False
        ui._streamed = False
        ui._work_stop = None
        ui.on_thinking("pondering", R.ReasoningBlock(key="r1", source="raw"))
        ui.on_thinking("summary", R.ReasoningBlock(key="r2", source="summarized", provider="anthropic"))
        ui.on_thinking_end(R.ReasoningBlock(key="r3", source="withheld", provider="anthropic"))
        out = ui.console.file.getvalue()
        self.assertIn("· thinking (raw)… pondering", out)
        self.assertIn("· thinking (summarized by Anthropic)… summary", out)
        self.assertIn("· thinking (hidden by Anthropic)", out)


if __name__ == "__main__":
    unittest.main()
