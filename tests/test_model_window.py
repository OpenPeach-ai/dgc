"""The context window follows the model.

Three defects, all found 2026-10-22:

* A model switch OVERWROTE context_size with the new model's name-table guess, so switching back
  lost the 1M window the user had chosen. The window chosen for each model is now remembered and a
  switch back restores it.
* The name table ("deepseek" -> 64k, "qwen" -> 32k) beat a larger maximum the provider REPORTED,
  even for an Ollama ``:cloud`` model, which loads nothing on this machine. A reported maximum now
  wins; the table is a memory-conscious recommendation for local models only.
* A provider that reports no maximum overflowed, DGC compacted and retried once, and forgot. The
  limit the refusal names ("maximum context length is 262144") is now remembered for that
  endpoint+model, so later requests (and the next session) fit it.
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
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
        raise RuntimeError("tests/test_model_window.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-model-window-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.agent import Agent, recommended_window  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.llm import ContextOverflowError, LLMClient, learned_context_limit, overflow_limit  # noqa: E402
from fake_providers import FakeProviders, Reply, say  # noqa: E402
from test_monitors import FrontendUI  # noqa: E402


class IsolatedHome(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-model-window-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.root = tmp / "project"
        (self.root / ".git").mkdir(parents=True)
        self.server = FakeProviders()
        self.addCleanup(self.server.close)

    def config(self, **values) -> Config:
        (self.user / "config.json").write_text(json.dumps({
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, **values}))
        return Config(project_root=self.root)

    def agent(self, config) -> Agent:
        agent = Agent(config, FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        return agent

    def switch(self, agent, model):
        previous = agent.config.model
        agent.config.set("model", model)
        agent.refresh_client()
        agent.window_after_switch(previous)


class PerModelMemory(IsolatedHome):
    def test_switching_back_restores_the_window_chosen_for_that_model(self):
        cfg = self.config(model="deepseek-v4.1-flash:cloud", base_url=self.server.url, api_mode="ollama")
        agent = self.agent(cfg)
        cfg.set("context_size", 1_048_576)                    # the user's own choice
        self.server.show_context = 0                           # qwen reports nothing
        self.switch(agent, "qwen3.8:27b")
        self.assertEqual(cfg.get("context_size"), 65_536, "a local model gets its memory-conscious window")
        self.switch(agent, "deepseek-v4.1-flash:cloud")
        self.assertEqual(cfg.get("context_size"), 1_048_576, "switching back restores the user's 1M")
        saved = json.loads((self.user / "config.json").read_text())
        self.assertEqual(saved["model_context_sizes"]["deepseek-v4.1-flash:cloud"], 1_048_576)
        self.assertNotIn("qwen3.8:27b", saved["model_context_sizes"],
                         "a window DGC picked on a switch is not remembered as the user's choice")
        cfg.set("context_size", 32_768)
        self.switch(agent, "qwen3.8:27b")
        self.switch(agent, "deepseek-v4.1-flash:cloud")
        self.assertEqual(cfg.get("context_size"), 32_768, "the latest choice is the one kept")

    def test_a_window_chosen_before_this_release_is_kept_for_its_model(self):
        # config.json from 0.47: an explicit 1M and no per-model memory yet.
        cfg = self.config(model="deepseek-v4.1-flash:cloud", base_url=self.server.url, api_mode="ollama",
                          context_size=1_048_576)
        agent = self.agent(cfg)
        self.switch(agent, "qwen3.8:27b")
        self.assertEqual(cfg.get("context_size"), 65_536)
        self.switch(agent, "deepseek-v4.1-flash:cloud")
        self.assertEqual(cfg.get("context_size"), 1_048_576)

    def test_two_windows_remembering_two_models_keep_both(self):
        a = self.config(model="model-a", base_url=self.server.url)
        b = Config(project_root=self.root)
        b.set("model", "model-b")
        a.set("context_size", 131_072)
        b.set("context_size", 262_144)
        saved = json.loads((self.user / "config.json").read_text())["model_context_sizes"]
        self.assertEqual(saved, {"model-a": 131_072, "model-b": 262_144})

    def test_the_editor_switch_restores_it_and_tells_the_editor(self):
        self.config(model="deepseek-v4.1-flash:cloud", base_url=self.server.url, api_mode="ollama")
        wire = io.StringIO()
        with patch.object(sessions, "SESSIONS_DIR", self.user / "sessions"):
            host = headless.Host(Config(project_root=self.root))
            host.core.fp = wire
            self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(host.chats.values())])
            host.dispatch({"type": "set_config", "request_id": "s1", "values": {"context_size": 1_048_576}})
            host.dispatch({"type": "set_model", "request_id": "m1", "model": "qwen3.8:27b"})
            host.dispatch({"type": "set_model", "request_id": "m2", "model": "deepseek-v4.1-flash:cloud"})
        frames = [json.loads(line) for line in wire.getvalue().splitlines()]
        self.assertEqual([f for f in frames if f["type"] == "command_rejected"], [])
        self.assertEqual(host.default.config.get("context_size"), 1_048_576)
        after = frames[next(i for i, f in enumerate(frames) if f.get("request_id") == "m2"):]
        self.assertTrue(any(f["type"] == "config" and f.get("context_size") == 1_048_576 for f in after),
                        "the editor is told the window it shows as chosen")


class ReportedMaximum(IsolatedHome):
    def test_a_cloud_model_starts_at_a_moderate_window_not_the_tables_local_64k_or_its_whole_maximum(self):
        # Reported 2026-10-22: an unset window starts moderate; the maximum is the user's choice.
        self.server.show_context = 1_048_576
        cfg = self.config(model="qwen2.5:14b", base_url=self.server.url, api_mode="ollama")
        agent = self.agent(cfg)
        self.switch(agent, "deepseek-v4.1-flash:cloud")       # the table alone says 64k for "deepseek"
        self.assertEqual(cfg.get("context_size"), 131_072)
        self.assertEqual(agent.context_size(), 131_072)

    def test_a_cloud_model_that_holds_less_than_the_start_gets_what_it_holds(self):
        self.server.show_context = 32_768
        cfg = self.config(model="qwen2.5:14b", base_url=self.server.url, api_mode="ollama")
        agent = self.agent(cfg)
        self.switch(agent, "deepseek-v4.1-flash:cloud")
        self.assertEqual(cfg.get("context_size"), 32_768)

    def test_the_maximum_chosen_for_a_cloud_model_is_kept_for_it(self):
        self.server.show_context = 1_048_576
        cfg = self.config(model="qwen2.5:14b", base_url=self.server.url, api_mode="ollama")
        agent = self.agent(cfg)
        self.switch(agent, "deepseek-v4.1-flash:cloud")
        cfg.set("context_size", 1_048_576)                    # chosen in the context meter
        self.switch(agent, "qwen2.5:14b")
        self.switch(agent, "deepseek-v4.1-flash:cloud")
        self.assertEqual(cfg.get("context_size"), 1_048_576)
        self.assertEqual(agent.context_size(), 1_048_576)

    def test_a_local_model_keeps_its_memory_conscious_window_under_its_reported_maximum(self):
        self.server.show_context = 262_144
        cfg = self.config(model="deepseek-v4.1-flash:cloud", base_url=self.server.url, api_mode="ollama")
        agent = self.agent(cfg)
        self.switch(agent, "qwen3.8:27b")
        self.assertEqual(cfg.get("context_size"), 65_536, "a trained maximum is memory, not a free window")
        self.server.show_context = 16_384
        agent.client.invalidate_capabilities()
        self.assertEqual(recommended_window(cfg, agent.client, "qwen3.8:27b"), 16_384,
                         "and never above what the model holds")

    def test_an_anthropic_model_s_reported_maximum_and_an_unset_window(self):
        self.server.anthropic_max_input = 1_000_000
        cfg = self.config(model="claude-sonnet-5-5", base_url=self.server.url + "/v1", api_mode="anthropic")
        agent = self.agent(cfg)
        agent.client.prepare_model()
        self.assertEqual(agent.context_size(), 200_000,
                         "a window left unset starts at the family's window, never the whole 1M maximum")

    def test_a_cloud_model_that_reports_nothing_keeps_the_family_window_or_the_current_one(self):
        cfg = self.config(model="gpt-5", base_url="https://api.example.invalid/v1")
        self.assertEqual(recommended_window(cfg, None, "gpt-5", probe=False), 400_000)
        self.assertIsNone(recommended_window(cfg, None, "some-new-model", probe=False))


class LearnedFromTheRefusal(IsolatedHome):
    def test_the_phrasings_providers_use(self):
        for text, limit in (
                ("This model's maximum context length is 262144 tokens. However, you requested 300000", 262_144),
                ("prompt is too long: 215000 tokens > 200000 maximum", 200_000),
                ("maximum prompt length is 131072", 131_072),
                ("the request exceeds the available context size, try increasing it", 0),
                ('{"error":{"type":"exceed_context_size_error","n_prompt_tokens":5000,"n_ctx":4096}}', 4096),
                ("However, the model is loaded with context length of only 8192 tokens", 8192),
                ("Range of input length should be [1, 30720]", 30_720),
                ("This model's maximum context length is 128,000 tokens.", 128_000),
                ("context window exceeded", 0)):
            with self.subTest(text=text):
                self.assertEqual(overflow_limit(text), limit)

    def test_an_overflow_teaches_the_window_and_the_next_session_starts_from_it(self):
        refusals = []

        def script(kind, body, index):
            if not refusals:
                refusals.append(index)
                return Reply(status=400, error=json.dumps({"error": {
                    "message": "This model's maximum context length is 262144 tokens. However, your "
                               "messages resulted in 300000 tokens.", "type": "invalid_request_error"}}))
            return say("fits now")
        self.server.script = script
        client = LLMClient(self.server.url + "/v1", "k", "deepseek-chat", api_mode="chat_completions",
                           context_size=1_048_576)
        with self.assertRaises(ContextOverflowError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.limit, 262_144)
        self.assertEqual(client.effective_context_size(), 262_144)
        self.assertEqual(learned_context_limit(self.server.url + "/v1", "deepseek-chat"), 262_144)
        later = LLMClient(self.server.url + "/v1", "k", "deepseek-chat", api_mode="chat_completions",
                          context_size=1_048_576)
        self.assertEqual(later.effective_context_size(), 262_144, "a new client, as in the next session")
        stored = json.loads((self.user / "model-limits.json").read_text())
        self.assertEqual(stored["limits"][f"{self.server.url}/v1|deepseek-chat"]["tokens"], 262_144)
        other = LLMClient(self.server.url + "/v1", "k", "deepseek-reasoner", context_size=1_048_576)
        self.assertEqual(other.effective_context_size(), 1_048_576, "for that endpoint+model only")

    def test_the_turn_compacts_to_the_learned_window_and_says_so(self):
        cfg = self.config(model="deepseek-chat", base_url=self.server.url + "/v1",
                          api_mode="chat_completions", mode="auto", context_size=1_048_576)
        agent = self.agent(cfg)
        sent = []

        def script(kind, body, index):
            sent.append(index)
            if index == 1:
                return Reply(status=400, error=json.dumps({"error": {
                    "message": "This model's maximum context length is 131072 tokens."}}))
            return say("ok")
        self.server.script = script
        infos = []
        agent.ui.info = lambda message, *a, **k: infos.append(str(message))
        self.assertTrue(agent.run_turn("hello"), agent._last_turn_error)
        self.assertEqual(agent.context_size(), 131_072)
        self.assertEqual(cfg.get("context_size"), 1_048_576, "the user's choice stands; the model holds less")
        self.assertTrue(any("this model holds 131,072 tokens" in line for line in infos), infos)


if __name__ == "__main__":
    unittest.main()
