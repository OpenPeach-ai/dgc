"""DGC Router's Suggest: workers per model at a chosen context, from what DGC knows (model size × quant, KV bytes per
token from Ollama's architecture, llama.cpp's slots, vLLM's KV blocks, memory from the hardware readout or memory_gb,
the parallel test). It shows the arithmetic in one line and never claims a fit it can't back."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from router_fakes import FakeServer  # noqa: E402
from test_subagents import fixture_config  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc import router_probe, router_state, router_tools as T  # noqa: E402
from dgc.router_suggest import SuggestError, suggest, text  # noqa: E402

GIB = 1024 ** 3
QWEN8 = {"name": "qwen3:8b", "size_bytes": 5225388164, "quant": "Q4_K_M", "params_b": 8.19,
         "kv_bytes_per_token": 36 * 8 * (128 + 128) * 2, "context_max": 40960, "tools": True}


class SuggestCase(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-suggest-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.router = R.Router()
        for item in (patch.object(R, "ROUTER", self.router),
                     patch.object(R.Router, "ensure_health", lambda self, config: None)):
            item.start()
            self.addCleanup(item.stop)

    def config(self, *systems, enabled=True):
        config = fixture_config(Path(tempfile.mkdtemp(prefix="dgc-router-suggest-project-")))
        config.data["router"] = {"enabled": enabled, "systems": list(systems)}
        return config

    def system(self, models, **extra):
        return {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama",
                "models": models, **extra}


class Arithmetic(SuggestCase):
    def test_malformed_discovery_and_probe_numbers_do_not_break_a_suggestion(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=16))
        router_state.save_discovery("nas", {"models": [{"name": "qwen3:8b", "context_max": "NaN",
                                                        "size_bytes": 10 ** 400, "params_b": "Infinity",
                                                        "kv_bytes_per_token": "bad"}]})
        router_state.save_probe("nas", "qwen3:8b", {"parallel": {"ok": True, "runs": -2,
                                                                 "context": "Infinity"}})
        result = suggest(config, "nas")
        self.assertIsNone(result["models"][0]["workers"])
        self.assertIn("can't back a number yet", result["models"][0]["line"])
        with self.assertRaises(SuggestError):
            suggest(config, "nas", context="Infinity")
        self.assertEqual(suggest(config, "nas", context="16K")["models"][0]["context"], 16384)

    def test_memory_weights_and_context_in_one_line(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=16))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        result = suggest(config, "nas")
        plan = result["models"][0]
        self.assertEqual((plan["workers"], plan["basis"]), (2, "memory"))
        self.assertEqual(plan["line"], "qwen3:8b: 8.2B Q4 ≈ 4.9 GB + 2 × 32K context ≈ 9 GB → 2 workers fit in 16 GB "
                                       "(1.6 GB kept free); Test checks how many it really runs at once")
        self.assertEqual(result["memory"], {"total_gb": 16.0, "source": "the memory set for it", "unified": False})
        self.assertEqual(result["workers"], 2)
        at_8k = suggest(config, "nas", context=8192)["models"][0]
        self.assertEqual((at_8k["workers"], at_8k["context"]), (8, 8192), "a smaller context fits more")

    def test_the_server_runs_fewer_at_once_than_fit(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 8192}], memory_gb=16))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        router_state.save_probe("nas", "qwen3:8b", {"parallel": {"ok": True, "runs": 2, "context": 8192}})
        plan = suggest(config, "nas")["models"][0]
        self.assertEqual((plan["workers"], plan["basis"]), (2, "measured"))
        self.assertTrue(plan["line"].endswith("; the server runs 2 at once (measured), so 2"), plan["line"])

    def test_measured_at_this_context_beats_the_conservative_arithmetic(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=12))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        router_state.save_probe("nas", "qwen3:8b", {"parallel": {"ok": True, "runs": 4, "context": 32768}})
        plan = suggest(config, "nas")["models"][0]
        self.assertEqual((plan["workers"], plan["basis"]), (4, "measured"), "it ran 4 together at 32K: it fits")

    def test_unknown_memory_says_so_and_never_claims_a_fit(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}]))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        result = suggest(config, "nas")
        self.assertIsNone(result["models"][0]["workers"])
        self.assertIn("DGC can't back a number yet", result["models"][0]["line"])
        self.assertIn("its memory (a hardware readout, or its memory in GB)", result["models"][0]["line"])
        self.assertFalse(result["applicable"])
        self.assertIn("Memory: unknown", text(result))
        router_state.save_probe("nas", "qwen3:8b", {"parallel": {"ok": True, "runs": 2, "context": 32768}})
        plan = suggest(config, "nas")["models"][0]
        self.assertEqual((plan["workers"], plan["basis"]), (2, "measured"))
        self.assertEqual(plan["line"], "qwen3:8b: memory unknown; it ran 2 at once (measured) → 2 workers")

    def test_a_model_that_doesnt_fit_is_told_a_context_that_does(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=8))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        plan = suggest(config, "nas")["models"][0]
        self.assertIsNone(plan["workers"])
        self.assertIn("doesn't fit in 8 GB", plan["line"])
        self.assertIn("; 15K fits one", plan["line"])
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=5))
        self.assertIn("8.2B Q4 ≈ 4.9 GB doesn't fit in 5 GB", suggest(config, "nas")["models"][0]["line"])

    def test_the_hardware_readout_is_the_memory_when_there_is_one(self):
        system = self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=8,
                             hardware={"source": "node", "url": "http://nas.local:8577"})
        config = self.config(system)
        router_state.save_discovery("nas", {"models": [QWEN8]})
        router_state.write("hardware", {"nas": {"url": "http://nas.local:8577", "kind": "dgc_node", "gpus": [
            {"name": "NVIDIA GeForce RTX 4090", "memory_total_bytes": 24 * GIB, "memory_used_bytes": 6 * GIB}]}})
        result = suggest(config, "nas")
        self.assertEqual(result["memory"]["source"], "the hardware readout (dgc node)")
        self.assertEqual(result["models"][0]["workers"], 3)
        router_state.write("hardware", {"nas": {"url": "http://nas.local:8577", "kind": "dgc_node", "unified_memory":
                                                True, "gpus": [{"name": "Apple M2 Ultra", "unified": True,
                                                                "memory_total_bytes": 192 * GIB}]}})
        result = suggest(config, "nas")
        self.assertTrue(result["memory"]["unified"])
        self.assertIn("(29 GB kept free)", result["models"][0]["line"],
                      "a computer that shares its memory keeps more free")

    def test_models_side_by_side_share_the_memory(self):
        small = {**QWEN8, "name": "qwen3:4b", "size_bytes": 2_600_000_000, "params_b": 4.0}
        config = self.config(self.system([{"name": "qwen3:8b", "context": 8192}, {"name": "qwen3:4b", "context": 8192}],
                                         memory_gb=24))
        router_state.save_discovery("nas", {"models": [QWEN8, small]})
        result = suggest(config, "nas")
        self.assertTrue(all("beside the other models" in plan["line"] for plan in result["models"]))
        self.assertEqual(result["workers"], sum(plan["workers"] for plan in result["models"]))
        alone = self.config(self.system([{"name": "qwen3:8b", "context": 8192}, {"name": "qwen3:4b", "context": 8192}],
                                        memory_gb=24, one_model_at_a_time=True))
        result = suggest(alone, "nas")
        self.assertEqual(result["workers"], max(plan["workers"] for plan in result["models"]))

    def test_a_context_past_the_models_own_is_clipped(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=48))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        plan = suggest(config, "nas", context=131072)["models"][0]
        self.assertEqual(plan["context"], 40960)
        self.assertEqual(plan["note"], "qwen3:8b takes at most 40K")


class ContextMemory(unittest.TestCase):
    """KV bytes per token from what Ollama's /api/show says (fields as Ollama 0.30 reports them)."""

    def test_a_plain_model_qwen2_without_key_length_and_a_hybrid_one(self):
        self.assertEqual(router_probe.kv_bytes_per_token({"block_count": 36, "head_count": 32, "head_count_kv": 8,
                                                          "key_length": 128, "value_length": 128}),
                         (36 * 8 * 256 * 2, False))
        # qwen2.5:7b: no key_length; the head size is 3584 / 28 = 128.
        self.assertEqual(router_probe.kv_bytes_per_token({"block_count": 28, "head_count": 28, "head_count_kv": 4,
                                                          "embedding_length": 3584}), (28 * 4 * 256 * 2, False))
        # qwen3.5:9b: every 4th of 32 layers has a cache, and its KV heads are a per-layer list Ollama leaves out.
        self.assertEqual(router_probe.kv_bytes_per_token({"block_count": 32, "head_count": 16, "key_length": 256,
                                                          "value_length": 256, "full_attention_interval": 4}),
                         (8 * 16 * 512 * 2, True))
        self.assertIsNone(router_probe.kv_bytes_per_token({"block_count": 32}))

    def test_an_upper_bound_is_said(self):
        home = tempfile.mkdtemp(prefix="dgc-router-suggest-")
        with patch.dict(os.environ, {"DGC_HOME": home}):
            config = fixture_config(Path(tempfile.mkdtemp(prefix="dgc-router-suggest-project-")))
            config.data["router"] = {"enabled": False, "systems": [
                {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama", "memory_gb": 16,
                 "models": [{"name": "qwen3.5:9b", "context": 16384}]}]}
            router_state.save_discovery("nas", {"models": [{"name": "qwen3.5:9b", "size_bytes": 6_591_000_000,
                                                            "params_b": 9.65, "quant": "Q4_K_M",
                                                            "kv_bytes_per_token": 131072, "kv_upper_bound": True}]})
            line = suggest(config, "nas")["models"][0]["line"]
        self.assertIn("its context is counted high (the server doesn't say its KV heads)", line)


class WhatServersSay(SuggestCase):
    def test_llama_cpp_slots(self):
        config = self.config({"id": "mini", "name": "Mini", "base_url": "http://mini.local:8080", "server": "llamacpp",
                              "models": [{"name": "qwen2.5-7b-q4_k_m.gguf", "context": 32768}]})
        router_state.save_discovery("mini", {"slots": 4, "slot_context": 8192, "models": [
            {"name": "qwen2.5-7b-q4_k_m.gguf", "loaded_context": 8192}]})
        plan = suggest(config, "mini")["models"][0]
        self.assertEqual((plan["workers"], plan["context"], plan["basis"]), (4, 8192, "slots"))
        self.assertEqual(plan["line"], "qwen2.5-7b-q4_k_m.gguf: llama-server runs 4 slots of 8K each → 4 workers at 8K")
        self.assertIn("--ctx-size", plan["note"])

    def test_vllm_kv_blocks(self):
        config = self.config({"id": "v", "name": "vLLM box", "base_url": "http://gpu-box.local:8000", "server": "vllm",
                              "models": [{"name": "Qwen/Qwen3-8B", "context": 8192}]})
        router_state.save_discovery("v", {"kv_tokens": 2048 * 16, "models": [{"name": "Qwen/Qwen3-8B"}]})
        plan = suggest(config, "v")["models"][0]
        self.assertEqual((plan["workers"], plan["basis"]), (4, "kv_tokens"))
        self.assertEqual(plan["line"], "Qwen/Qwen3-8B: vLLM holds 32,768 tokens of context → 4 workers at 8K")

    def test_a_cloud_model_uses_no_memory_here(self):
        config = self.config(self.system([{"name": "glm-5.3:cloud", "context": 32768}], memory_gb=16))
        router_state.save_discovery("nas", {"models": [{"name": "glm-5.3:cloud", "cloud": True, "size_bytes": 293}]})
        self.assertIn("a cloud model (no memory here)", suggest(config, "nas")["models"][0]["line"])


class Applying(SuggestCase):
    def test_apply_suggestion_is_an_allow_card_with_the_diff(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=16))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        plan = T.plan_update(config, {"action": "apply_suggestion", "system": "nas", "context": 16384})
        self.assertEqual(plan.summary, "Use the suggestion for NAS: qwen3:8b · 4 workers at 16K")
        self.assertIn('-            "context": 32768', plan.diff)
        self.assertIn('+            "context": 16384', plan.diff)
        self.assertTrue(any("→ 4 workers fit in 16 GB" in note for note in plan.notes))
        T.apply_plan(config, plan)
        entry = config.data["router"]["systems"][0]
        self.assertEqual((entry["workers"], entry["models"][0]["workers"], entry["models"][0]["context"]), (4, 4, 16384))
        with self.assertRaises(T.UpdateError) as raised:
            T.plan_update(config, {"action": "apply_suggestion", "system": "nas", "context": 16384})
        self.assertIn("already matches", str(raised.exception))

    def test_nothing_backed_nothing_applied(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}]))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        with self.assertRaises(T.UpdateError) as raised:
            T.plan_update(config, {"action": "apply_suggestion", "system": "nas"})
        self.assertIn("can't back a suggestion for NAS yet", str(raised.exception))
        with self.assertRaises(SuggestError):
            suggest(config, "nowhere")

    def test_router_probe_ends_with_a_suggestion(self):
        with FakeServer("ollama", parallel=2, delay=0.4) as fake:
            config = self.config({"id": "gpu", "name": "GPU box", "base_url": fake.url, "server": "ollama",
                                  "memory_gb": 16, "models": [{"name": "qwen3:8b", "context": 16384}]})
            result = T.probe(config, "gpu", checks=["models", "parallel"])
        self.assertIn("suggest", result)
        self.assertEqual(result["suggest"]["models"][0]["basis"], "measured")
        self.assertEqual(result["suggest"]["models"][0]["workers"], 2)
        self.assertEqual(router_state.probes("gpu")["qwen3:8b"]["parallel"]["context"], 16384,
                         "the parallel test says at which context it ran")
        said = T.probe_text(result)
        self.assertIn("Suggest: GPU box: 2 workers in all.", said)
        self.assertIn("→ ", said)

    def test_the_cli_and_slash_command(self):
        from dgc import router_cli
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768}], memory_gb=16))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        body, _ = router_cli.slash(config, "suggest nas 16k")
        self.assertIn("qwen3:8b: 8.2B Q4 ≈ 4.9 GB + 4 × 16K context", body)
        self.assertIn("dgc router suggest nas --apply", body)
        self.assertEqual(router_cli.context_arg("32k"), 32768)


if __name__ == "__main__":
    unittest.main()


class ContextNames(SuggestCase):
    """0.51 (Settings' Context each is a box you type in or pick from): a context reads the same everywhere, 16384,
    "16,384", "16K" or "16k", and the status tells Settings what a context costs on each system, as Suggest counts it."""

    def test_a_context_reads_the_same_everywhere(self):
        from dgc.router_cli import context_arg
        for text, tokens in (("16384", 16384), ("16,384", 16384), ("16K", 16384), ("16k", 16384), (" 24K ", 24576),
                             ("24,576", 24576), (32768, 32768), ("1.5K", 1536 * 1)):
            if tokens < 2048:
                with self.assertRaises(T.UpdateError):
                    T.context_tokens(text)
                continue
            self.assertEqual(T.context_tokens(text), tokens, text)
            self.assertEqual(context_arg(str(text)), tokens, text)
        for bad in ("", "lots", "16M", "1000", "99999999", True, "16.5",
                    "nan", "inf", "-inf", "nank", "infk", "1e5", "-16K"):     # never a ValueError or OverflowError
            with self.assertRaises(T.UpdateError, msg=repr(bad)):
                T.context_tokens(bad)

    def test_add_takes_one_context_for_its_models(self):
        with FakeServer("ollama") as fake:
            config = self.config()
            plan = T.plan_update(config, {"action": "add_system", "base_url": fake.url, "name": "GPU box",
                                          "models": ["qwen3:8b"], "context": "8K"})
            [model] = [s for s in plan.after["systems"] if s["name"] == "GPU box"][0]["models"]
            self.assertEqual(model["context"], 8192)

    def test_the_status_says_what_a_context_costs(self):
        config = self.config(self.system([{"name": "qwen3:8b", "context": 32768, "workers": 2}], memory_gb=64))
        router_state.save_discovery("nas", {"models": [QWEN8]})
        [system] = R.status(config)["systems"]
        self.assertEqual(system["memory"]["total_bytes"], 64 * GIB)
        self.assertEqual(system["memory"]["kept_free_bytes"], int(0.10 * 64 * GIB))
        [model] = system["models"]
        self.assertEqual(model["weights_bytes"], QWEN8["size_bytes"])
        self.assertEqual(model["kv_bytes_per_token"], QWEN8["kv_bytes_per_token"])
        [offered] = system["available"]
        self.assertEqual((offered["weights_bytes"], offered["kv_bytes_per_token"]), (QWEN8["size_bytes"], QWEN8["kv_bytes_per_token"]))
