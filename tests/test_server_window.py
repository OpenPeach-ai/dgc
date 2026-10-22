"""vLLM, SGLang and llama.cpp: the window the server was started with (2026-10-22).

These servers size the context window themselves when they start (vLLM ``--max-model-len``, SGLang
``--context-length``, llama.cpp ``-c``) and set aside the memory for it; nothing DGC sends changes it.
DGC never read it: the meter showed DGC's own 32K against a server holding 8K (every long turn then
overflowed, compacted and retried) or 128K (DGC compacted at a quarter of what the server holds).

Now the server's own word is read -- vLLM and SGLang list ``max_model_len`` in ``GET /v1/models``,
llama.cpp lists ``meta.n_ctx`` there (an older llama-server only in ``GET /props``) -- bounded, cached
and advisory, and it caps the window: the meter is right from the first turn, a window set above it
can't apply, and below it DGC's own setting only decides when to compact. The numbers in these
fixtures are the shapes real servers answered on this machine: vLLM 0.9.2 (``max_model_len`` 8192),
llama.cpp b11815 (``meta.n_ctx`` 6144, ``n_ctx_train`` 32768, ``/props`` n_ctx 6144).
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
        raise RuntimeError("tests/test_server_window.py needs HOME redirected before dgc is imported")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-server-window-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import llm as llm_module  # noqa: E402
from dgc.agent import Agent, recommended_window  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.llm import ContextOverflowError, LLMClient, remember_context_limit  # noqa: E402
from fake_providers import FakeProviders, Reply, say  # noqa: E402
from test_monitors import FrontendUI  # noqa: E402

# What vLLM 0.9.2 answered for `--served-model-name qwen2.5-0.5b --max-model-len 8192` (permission elided).
VLLM_ENTRY = {"id": "qwen2.5-0.5b", "object": "model", "created": 1792665010, "owned_by": "vllm",
              "root": "/model", "parent": None, "max_model_len": 8192, "permission": []}
GGUF = "/models/qwen2.5-0.5b-instruct-q4_k_m.gguf"
# What llama.cpp b11815 answered for `-c 6144` (four slots sharing one KV cache).
LLAMACPP_ENTRY = {"id": GGUF, "aliases": [GGUF], "tags": [], "object": "model", "created": 1792664654,
                  "owned_by": "llamacpp", "meta": {"vocab_type": 2, "n_vocab": 151936, "n_ctx": 6144,
                                                    "n_ctx_train": 32768, "n_embd": 896}}


class IsolatedHome(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-server-window-")).resolve()
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

    def client(self, model="qwen2.5-0.5b", path="/v1", **options) -> LLMClient:
        return LLMClient(self.server.url + path, "sk-local", model, **options)

    def config(self, **values) -> Config:
        (self.user / "config.json").write_text(json.dumps({
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, **values}))
        return Config(project_root=self.root)

    def agent(self, config) -> Agent:
        agent = Agent(config, FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        return agent

    def model_gets(self) -> list[str]:
        return [path for path in self.server.gets if path.endswith(("/models", "/props"))]


class TheServersOwnWord(IsolatedHome):
    def test_vllm_says_its_max_model_len(self):
        self.server.served_models = [VLLM_ENTRY]
        client = self.client(context_size=32_768)
        client.prepare_model()
        self.assertEqual(client.server_window(), {"window": 8192, "server": "vllm"})
        self.assertEqual(client.model_context_limit(), 8192)
        self.assertEqual(client.window_limit(), 8192)
        self.assertEqual(client.effective_context_size(), 8192, "DGC's 32K can't apply on an 8K server")
        self.assertEqual(self.model_gets(), ["/v1/models"])

    def test_llama_cpp_says_its_slot_window_and_what_the_model_was_trained_for(self):
        self.server.served_models = [LLAMACPP_ENTRY]
        client = self.client(model="local")        # llama-server answers any name with the model it loaded
        client.prepare_model()
        self.assertEqual(client.server_window(), {"window": 6144, "server": "llamacpp", "trained": 32768})
        self.assertEqual(client.effective_context_size(131_072), 6144)
        self.assertEqual(self.model_gets(), ["/v1/models"], "the model list says it: /props isn't needed")

    def test_an_older_llama_server_says_it_in_props(self):
        self.server.served_models = [{"id": GGUF, "object": "model", "owned_by": "llamacpp",
                                      "meta": {"n_ctx_train": 32768}}]
        self.server.llamacpp_props = {"default_generation_settings": {"n_ctx": 4096}, "total_slots": 1}
        client = self.client(model=GGUF)
        client.prepare_model()
        self.assertEqual(client.server_window(), {"window": 4096, "server": "llamacpp", "trained": 32768})
        self.assertEqual(self.model_gets(), ["/v1/models", "/props"])

    def test_a_llama_cpp_port_with_no_model_list_still_has_props(self):
        self.server.llamacpp_props = {"default_generation_settings": {"n_ctx": 2048}}
        client = self.client(path="/llamacpp/v1")   # family llamacpp, as :8080 is
        self.assertEqual(client.family, "llamacpp")
        client.prepare_model()
        self.assertEqual(client.server_window(), {"window": 2048, "server": "llamacpp"})
        self.assertEqual(self.model_gets(), ["/llamacpp/v1/models", "/llamacpp/props"])

    def test_sglang_says_it_like_vllm(self):
        self.server.served_models = [{"id": "qwen", "object": "model", "owned_by": "sglang", "root": "qwen",
                                      "max_model_len": 32768}]
        client = self.client(model="qwen", path="/sglang/v1")       # :30000 and "sglang" are the vllm family
        self.assertEqual(client.family, "vllm")
        client.prepare_model()
        self.assertEqual(client.server_window(), {"window": 32768, "server": "sglang"})

    def test_the_entry_for_this_model_by_id_or_alias(self):
        self.server.served_models = [
            {"id": "big", "owned_by": "vllm", "max_model_len": 131072},
            {"id": "small", "aliases": ["tiny"], "owned_by": "vllm", "max_model_len": 4096}]
        for model, window in (("big", 131072), ("small", 4096), ("tiny", 4096)):
            with self.subTest(model=model):
                client = self.client(model=model)
                client.prepare_model()
                self.assertEqual(client.server_window()["window"], window)
        stranger = self.client(model="not-served")
        stranger.prepare_model()
        self.assertEqual(stranger.server_window(), {}, "two models and neither is it: no guess")

    def test_what_is_not_a_window_is_not_taken_for_one(self):
        for raw, window in ((True, 0), (-1, 0), (0, 0), (10**12, 0), (None, 0), ([8192], 0),
                            ({"tokens": 8192}, 0), ("8192", 8192), (8192.0, 8192)):
            with self.subTest(raw=raw):
                self.server.served_models = [{"id": "m", "owned_by": "vllm", "max_model_len": raw}]
                client = self.client(model=f"m-{raw!r}")
                client.prepare_model()
                self.assertEqual(client.server_window().get("window", 0), window)

    def test_an_endpoint_that_names_no_window_keeps_dgc_s_own(self):
        self.server.served_models = [{"id": "qwen2.5-0.5b", "object": "model", "owned_by": "organization_owner"}]
        client = self.client(context_size=32_768)
        client.prepare_model()
        self.assertEqual(client.server_window(), {})
        self.assertEqual(client.effective_context_size(), 32_768)
        client.prepare_model()
        self.assertEqual(self.model_gets(), ["/v1/models"], "an answer without a window is an answer: cached")


class Advisory(IsolatedHome):
    def test_a_server_that_is_down_costs_nothing_and_blocks_nothing(self):
        url = self.server.url
        self.server.close()
        client = LLMClient(url + "/v1", "sk-local", "qwen2.5-0.5b", context_size=32_768)
        started = time.monotonic()
        self.assertEqual(client.prepare_model(), {})
        self.assertLess(time.monotonic() - started, 3.0)
        self.assertEqual(client.effective_context_size(), 32_768)

    def test_a_list_that_is_too_big_is_not_read(self):
        self.server.served_models = [{"id": f"m{i}", "owned_by": "vllm", "max_model_len": 8192,
                                      "pad": "x" * 4096} for i in range(600)]
        client = self.client(model="m1")
        self.assertEqual(client.prepare_model(), {})
        self.assertEqual(client.server_window(), {})

    def test_read_once_then_cached_for_a_minute_at_most(self):
        self.server.served_models = [VLLM_ENTRY]
        client = self.client(capability_cache_ttl_s=3600)
        client.prepare_model()
        client.prepare_model()
        self.assertEqual(self.model_gets(), ["/v1/models"])
        expiry = client._model_metadata_cache[client._model_metadata_key()][0]
        self.assertLessEqual(expiry - time.monotonic(), 60.5,
                             "a restart with another window shows by the next turn")

    def test_cloud_apis_ollama_and_anthropic_are_not_asked(self):
        def no_network(*args, **kwargs):
            raise AssertionError(f"asked {args[0] if args else kwargs.get('url')}")
        for base_url in ("https://api.openai.com/v1", "https://api.example.invalid/v1",
                         "https://openrouter.ai/api/v1"):
            with self.subTest(base_url=base_url), patch.object(llm_module.requests, "get", no_network):
                client = LLMClient(base_url, "k", "some-model")
                self.assertEqual(client.prepare_model(), {})
                self.assertEqual(client.server_window(), {})
        self.server.show_context = 262_144
        ollama = self.client(model="qwen3.8:27b", path="", api_mode="ollama")
        ollama.prepare_model()
        self.assertEqual(ollama.server_window(), {}, "Ollama's window is DGC's to choose")
        self.assertEqual(ollama.model_context_limit(), 262_144)


class TheWindowDGCUses(IsolatedHome):
    def test_the_server_s_window_beats_what_an_earlier_refusal_taught(self):
        # Overflowed on llama-server -c 4096, then restarted it with -c 32768.
        remember_context_limit(self.server.url + "/v1", "qwen2.5-0.5b", 4096)
        self.server.served_models = [dict(VLLM_ENTRY, max_model_len=32768)]
        client = self.client(context_size=65_536)
        client.prepare_model()
        self.assertEqual(client.effective_context_size(), 32_768)

    def test_a_refusal_naming_another_window_reads_the_server_again(self):
        self.server.served_models = [VLLM_ENTRY]

        def script(kind, body, index):
            return Reply(status=400, error=json.dumps({"object": "error", "message": (
                "This model's maximum context length is 4096 tokens. However, you requested 5000 tokens "
                "(4980 in the messages, 20 in the completion)."), "type": "BadRequestError", "code": 400}))
        self.server.script = script
        client = self.client(api_mode="chat_completions")
        client.prepare_model()
        self.server.served_models = [dict(VLLM_ENTRY, max_model_len=4096)]    # restarted meanwhile
        with self.assertRaises(ContextOverflowError) as caught:
            client.chat([{"role": "user", "content": "hi"}])
        self.assertEqual(caught.exception.limit, 4096)
        client.prepare_model()
        self.assertEqual(client.server_window()["window"], 4096)
        self.assertEqual(self.model_gets(), ["/v1/models", "/v1/models"])

    def test_the_meter_is_right_from_the_first_turn(self):
        self.server.served_models = [VLLM_ENTRY]
        cfg = self.config(model="qwen2.5-0.5b", base_url=self.server.url + "/v1", mode="auto")
        agent = self.agent(cfg)
        self.assertTrue(agent.run_turn("hello"), agent._last_turn_error)
        self.assertEqual(agent.context_size(), 8192)
        self.assertEqual(self.model_gets()[0], "/v1/models", "read before the first request")

    def test_an_unset_window_is_the_server_s_whole_window(self):
        # The name table says 32K for qwen; the server set aside 128K.
        self.server.served_models = [dict(VLLM_ENTRY, max_model_len=131072)]
        cfg = self.config(model="other", base_url=self.server.url + "/v1")
        agent = self.agent(cfg)
        cfg.set("model", "qwen2.5-0.5b")
        agent.refresh_client()
        agent.window_after_switch("other")
        self.assertEqual(cfg.get("context_size"), 131_072)
        self.assertEqual(agent.context_size(), 131_072)
        saved = json.loads((self.user / "config.json").read_text()).get("model_context_sizes", {})
        self.assertNotIn("qwen2.5-0.5b", saved, "the server's window is not remembered as your choice")
        self.assertEqual(recommended_window(cfg, agent.client, "qwen2.5-0.5b"), 131_072)

    def test_above_it_can_t_apply_below_it_decides_when_to_compact(self):
        self.server.served_models = [VLLM_ENTRY]
        cfg = self.config(model="qwen2.5-0.5b", base_url=self.server.url + "/v1")
        agent = self.agent(cfg)
        agent.client.prepare_model()
        cfg.set("context_size", 1_048_576)
        self.assertEqual(agent.context_size(), 8192)
        cfg.set("context_size", 4096)
        self.assertEqual(agent.context_size(), 4096, "a smaller window of your own compacts sooner")

    def test_how_to_change_it_for_each_server(self):
        hint = llm_module.server_window_hint
        self.assertEqual(hint("vllm"), "restart vLLM with --max-model-len")
        self.assertEqual(hint("sglang"), "restart SGLang with --context-length")
        self.assertEqual(hint("llamacpp"), "restart llama-server with -c")
        self.assertEqual(hint("aphrodite"), "restart the server with a larger context")


if __name__ == "__main__":
    unittest.main()
