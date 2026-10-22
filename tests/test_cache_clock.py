"""The prompt cache's clock for a Work chat (0.48): what the backend tells the editor, and when.

The editor shows a small clock after the context meter, as Claude Code does: whole minutes left
while the provider's cache is warm, the clock alone in the error colour once it is gone, nothing at
all where DGC cannot know. Known means the provider said so itself: Anthropic's own cache
read/write report and the TTL its write used (anchored at the request's send time), or a local
Ollama's /api/ps unload time for the loaded model. OpenAI, DeepSeek, an Ollama ``:cloud`` model and a
subscription CLI stay hidden. No model is contacted: a local server answers like each provider.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError("tests/test_cache_clock.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-cache-clock-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import cache_clock  # noqa: E402
from dgc import config as config_module  # noqa: E402
from dgc import editor_protocol as ep  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.llm import ChatResult  # noqa: E402
from fake_providers import FakeProviders, say  # noqa: E402


def client(api_mode="anthropic", base_url="https://api.anthropic.com/v1", model="claude-sonnet-5-5",
           family=""):
    return SimpleNamespace(api_mode=api_mode, base_url=base_url, model=model,
                           family=family or ("ollama" if api_mode == "ollama" else api_mode))


def anthropic_reply(ttl="5m", read=0, write=3000, prompt=3040):
    cache = {"provider": "anthropic", "read_tokens": read, "write_tokens": write,
             "write_5m_tokens": write if ttl == "5m" else 0, "write_1h_tokens": write if ttl == "1h" else 0,
             "ttl": ttl if write else "", "prompt_tokens": prompt, "requested_ttl": "5m"}
    return ChatResult(content="ok", cache=cache)


def ollama_time(moment: datetime) -> str:
    """As Ollama writes it: nanoseconds and the machine's offset."""
    local = moment.astimezone(timezone(timedelta(hours=5, minutes=30)))
    return local.strftime("%Y-%m-%dT%H:%M:%S.") + f"{local.microsecond:06d}123" + "+05:30"


class Rules(unittest.TestCase):
    def test_anthropic_warm_for_the_ttl_its_write_used_from_the_send_time(self):
        sent = 1_800_000_000.0
        for ttl, seconds in (("5m", 300), ("1h", 3600)):
            record = cache_clock.record_from_reply(client(), anthropic_reply(ttl), sent)
            self.assertEqual((record["source"], record["ttl_s"], record["anchor_ms"]),
                             ("anthropic", seconds, int(sent * 1000)))
            state = cache_clock.wire_state(record, now_ms=int(sent * 1000) + 60_000)
            self.assertEqual(state["state"], "warm")
            self.assertEqual(state["expires_ms"] - state["anchor_ms"], seconds * 1000)
            gone = cache_clock.wire_state(record, now_ms=int(sent * 1000) + seconds * 1000 + 1)
            self.assertEqual((gone["state"], gone["reason"]), ("cold", "expired"))

    def test_a_reply_that_only_read_keeps_the_lifetime_its_entry_was_written_with(self):
        first = cache_clock.record_from_reply(client(), anthropic_reply("1h"), 1_800_000_000.0)
        read_only = anthropic_reply("1h", read=3000, write=0)
        second = cache_clock.record_from_reply(client(), read_only, 1_800_000_100.0, first)
        self.assertEqual(second["ttl_s"], 3600)
        self.assertEqual(second["anchor_ms"], 1_800_000_100_000, "a read refreshes the entry from its start")

    def test_shown_only_after_a_reply_actually_reported_cache_use(self):
        self.assertIsNone(cache_clock.record_from_reply(client(), ChatResult(content="ok"), 1.0e9))
        self.assertEqual(cache_clock.wire_state(None), {"state": "unknown"})

    def test_routes_that_publish_no_lifetime_stay_hidden(self):
        for route in (client("chat_completions", "https://api.deepseek.com/v1", "deepseek-chat", "deepseek"),
                      client("responses", "https://api.openai.com/v1", "gpt-5", "openai"),
                      client("ollama", "http://localhost:11434", "deepseek-v4.1-flash:cloud"),
                      client("ollama", "https://ollama.com", "gpt-oss:120b", "ollama")):
            with self.subTest(route=route):
                result = ChatResult(content="ok", usage={"input_tokens": 9000, "cached_input_tokens": 8000})
                self.assertIsNone(cache_clock.record_from_reply(route, result, 1.0e9))

    def test_a_local_ollama_is_warm_until_its_own_unload_time(self):
        record = cache_clock.record_from_reply(
            client("ollama", "http://127.0.0.1:11434/v1", "qwen3.8:27b"),
            ChatResult(content="ok", usage={"input_tokens": 7000}), 1_800_000_000.0)
        self.assertEqual((record["source"], record["endpoint"], record["tokens"]),
                         ("ollama", "http://127.0.0.1:11434", 7000))
        now = 1_800_000_060_000
        warm = cache_clock.wire_state(record, now_ms=now, listed=(True, now + 29 * 60_000))
        self.assertEqual((warm["state"], warm["expires_ms"]), ("warm", now + 29 * 60_000))
        gone = cache_clock.wire_state(record, now_ms=now, listed=(False, 0))
        self.assertEqual((gone["state"], gone["reason"]), ("cold", "unloaded"))
        self.assertEqual(cache_clock.wire_state(record, now_ms=now, listed=None), {"state": "unknown"},
                         "Ollama could not be asked: DGC does not know")
        kept = cache_clock.wire_state(record, now_ms=now, listed=(True, now + 300 * 365 * 86_400_000))
        self.assertEqual(kept["state"], "warm")
        self.assertNotIn("expires_ms", kept, "kept until Ollama stops: no countdown")

    def test_a_compacted_conversation_is_not_covered(self):
        record = cache_clock.record_from_reply(client(), anthropic_reply(), 1_800_000_000.0)
        state = cache_clock.wire_state(cache_clock.compacted(record, at=1_800_000_010.0),
                                       now_ms=1_800_000_020_000)
        self.assertEqual((state["state"], state["reason"], state["anchor_ms"]),
                         ("cold", "compacted", 1_800_000_010_000))

    def test_ollama_times(self):
        moment = datetime(2026, 10, 23, 5, 42, 3, 545289, tzinfo=timezone.utc)
        self.assertEqual(cache_clock.parse_time_ms(ollama_time(moment)), int(moment.timestamp() * 1000))
        self.assertEqual(cache_clock.parse_time_ms("2026-10-23T05:42:03Z"),
                         int(datetime(2026, 10, 23, 5, 42, 3, tzinfo=timezone.utc).timestamp() * 1000))
        self.assertEqual(cache_clock.parse_time_ms("soon"), 0)

    def test_every_state_is_a_valid_event(self):
        record = cache_clock.record_from_reply(client(), anthropic_reply(), 1_800_000_000.0)
        for state in (cache_clock.wire_state(None), cache_clock.wire_state(record, now_ms=1_800_000_001_000),
                      cache_clock.wire_state(record, now_ms=1_900_000_000_000),
                      cache_clock.wire_state(cache_clock.compacted(record))):
            self.assertIsNone(ep.event_error({"type": "cache_clock", "seq": 1, **state, "session_id": "s", "resumed": True}))


class Backend(unittest.TestCase):
    """The Work chat's backend, end to end: a real Agent and client, a local server for the provider."""

    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-cache-clock-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        self.root = tmp / "project"
        (self.root / ".git").mkdir(parents=True)
        self.server = FakeProviders()
        self.addCleanup(self.server.close)

    def host(self, **values):
        (self.user / "config.json").write_text(json.dumps({
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, "mode": "auto", **values}))
        self.wire = io.StringIO()
        host = headless.Host(Config(project_root=self.root))
        host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(host.chats.values())])
        self.addCleanup(lambda: [chat.close(process=False) for chat in list(host.chats.values())])
        return host

    def frames(self, kind=None):
        found = [json.loads(line) for line in self.wire.getvalue().splitlines()]
        return [f for f in found if kind is None or f["type"] == kind]

    def clocks(self, timeout=5.0, count=1):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            found = self.frames("cache_clock")
            if len(found) >= count:
                return found
            time.sleep(0.02)
        return self.frames("cache_clock")

    def prompt(self, host, text="hello"):
        host.dispatch({"type": "prompt", "text": text, "request_id": f"p-{time.monotonic_ns()}"})
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and not host.default._busy() and not self.frames("turn_end"):
            time.sleep(0.01)
        while time.monotonic() < deadline and host.default._busy():
            time.sleep(0.02)

    def test_an_anthropic_reply_with_a_one_hour_write_starts_a_one_hour_clock(self):
        self.server.script = lambda kind, body, index: say(
            "hi", input_tokens=40, cache_creation_input_tokens=5000,
            cache_creation={"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 5000})
        host = self.host(model="claude-sonnet-5-5", base_url=self.server.url + "/v1", api_mode="anthropic",
                         prompt_cache_ttl="1h")
        before = time.time() * 1000
        self.prompt(host)
        clock = [f for f in self.clocks() if f["state"] != "unknown"][-1]
        self.assertEqual((clock["state"], clock["source"], clock["ttl_s"]), ("warm", "anthropic", 3600))
        self.assertEqual(clock["expires_ms"] - clock["anchor_ms"], 3_600_000)
        self.assertGreaterEqual(clock["anchor_ms"], before - 1, "anchored at the request's send time")
        self.assertEqual(clock["tokens"], 5040)
        self.assertIsNone(ep.event_error(clock))
        # A compaction: the cache does not cover the new conversation.
        for text in ("second", "third", "fourth"):
            self.prompt(host, text)
        host.dispatch({"type": "compact", "request_id": "c1"})
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not any(f.get("reason") == "compacted" for f in self.frames("cache_clock")):
            time.sleep(0.02)
        self.assertEqual(self.frames("compacted")[-1]["status"], "compacted", self.frames("compacted"))
        compacted = [f for f in self.frames("cache_clock") if f.get("reason") == "compacted"]
        self.assertTrue(compacted, "a compacted conversation turns the clock cold")
        self.assertEqual(compacted[-1]["state"], "cold")
        # Another model: the clock is about one model's cache.
        host.dispatch({"type": "set_model", "request_id": "m1", "model": "claude-opus-5-5"})
        self.assertEqual(self.frames("cache_clock")[-1]["state"], "unknown")

    def test_providers_that_publish_no_lifetime_never_show_it(self):
        self.server.script = lambda kind, body, index: say(
            "hi", prompt_tokens=9000, prompt_tokens_details={"cached_tokens": 8000})
        host = self.host(model="deepseek-chat", base_url=self.server.url + "/v1", api_mode="chat_completions")
        self.prompt(host)
        self.assertTrue(all(f["state"] == "unknown" for f in self.frames("cache_clock")), self.frames("cache_clock"))

    def test_a_local_ollama_follows_its_own_unload_time_and_turns_cold_once_unloaded(self):
        expires = datetime.now(timezone.utc) + timedelta(minutes=29, seconds=30)
        self.server.ps_models = [{"name": "qwen3.8:27b", "model": "qwen3.8:27b", "expires_at": ollama_time(expires)}]
        host = self.host(model="qwen3.8:27b", base_url=self.server.url, api_mode="ollama")
        self.prompt(host)
        warm = [f for f in self.clocks() if f["state"] == "warm"]
        self.assertTrue(warm, self.frames("cache_clock"))
        self.assertEqual(warm[-1]["source"], "ollama")
        self.assertAlmostEqual(warm[-1]["expires_ms"], expires.timestamp() * 1000, delta=1000)
        self.assertIsNone(ep.event_error(warm[-1]))
        # Ollama let the model go: the next look (a repaint here) sees it.
        self.server.ps_models = []
        host.dispatch({"type": "get_history", "request_id": "h1"})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and self.frames("cache_clock")[-1].get("reason") != "unloaded":
            time.sleep(0.02)
        self.assertEqual((self.frames("cache_clock")[-1]["state"], self.frames("cache_clock")[-1]["reason"]),
                         ("cold", "unloaded"))

    def test_an_ollama_cloud_model_is_never_timed(self):
        self.server.ps_models = []
        host = self.host(model="deepseek-v4.1-flash:cloud", base_url=self.server.url, api_mode="ollama")
        self.prompt(host)
        self.assertTrue(all(f["state"] == "unknown" for f in self.frames("cache_clock")))

    def test_reopening_a_chat_whose_cache_went_cold_says_so(self):
        self.server.script = lambda kind, body, index: say(
            "hi", input_tokens=40, cache_creation_input_tokens=180_000,
            cache_creation={"ephemeral_5m_input_tokens": 180_000, "ephemeral_1h_input_tokens": 0})
        host = self.host(model="claude-sonnet-5-5", base_url=self.server.url + "/v1", api_mode="anthropic")
        self.prompt(host)
        agent = host.default.agent
        record = dict(agent.prompt_cache_record())
        record["anchor_ms"] -= (2 * 3600 + 5 * 60) * 1000          # two hours and five minutes ago
        agent._cache_record = record
        self.assertTrue(agent._persist())
        saved = json.loads(agent.session_file.read_text())
        self.assertEqual(saved["prompt_cache"]["source"], "anthropic")
        path = str(agent.session_file)
        other = self.host(model="claude-sonnet-5-5", base_url=self.server.url + "/v1", api_mode="anthropic")
        other.dispatch({"type": "resume_session", "path": path, "request_id": "r1"})
        frames = self.frames()
        clock = [f for f in frames if f["type"] == "cache_clock"][-1]
        self.assertEqual((clock["state"], clock["reason"], clock.get("resumed")), ("cold", "expired", True))
        self.assertEqual(clock["tokens"], 180_040)
        self.assertEqual(clock["session_id"], Path(path).stem)
        self.assertEqual(frames[-1]["type"], "cache_clock",
                         "last of the resume: an older SDK's replay drain stops at the first event it does not know")


if __name__ == "__main__":
    unittest.main()
