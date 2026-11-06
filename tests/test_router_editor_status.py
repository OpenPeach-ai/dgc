"""What the editor's Settings → Models → DGC Router reads beyond part 1's status, and the Pips default on the Router.

- Each system's status row carries ``available``: every model its server serves, as DGC last read it, so Settings
  can offer one that isn't used yet; and the server's own room (llama.cpp's context per slot, vLLM's and SGLang's
  tokens of context memory), for the check beside the total context.
- Settings → Models → Pips with the Router on: ``pips_model`` "router" (any Pip system) or
  "router:<system>/<model>" sends every Pip on Default there. With the Router off, Default follows DGC again.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_subagents import fixture_config  # noqa: E402

from dgc import headless, pip_models, pips, router_state  # noqa: E402
from dgc import router as R  # noqa: E402

BLOCK = {"enabled": True, "when_busy": "wait", "systems": [
    {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama", "jobs": ["pips"],
     "models": [{"name": "qwen3.5:9b", "workers": 1, "context": 16384}]},
    {"id": "gpu", "name": "GPU box", "base_url": "http://gpu-box.local:8080", "server": "llamacpp",
     "jobs": ["subagents", "pips"], "models": [{"name": "qwen3:8b", "workers": 2, "context": 8192}]}]}


class Case(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-editor-"))
        for item in (patch.dict(os.environ, {"DGC_HOME": str(self.home)}),
                     patch.object(R, "ROUTER", R.Router()),
                     patch.object(R.Router, "ensure_health", lambda self, config: None)):
            item.start()
            self.addCleanup(item.stop)
        pips._ROUTER_RUNS.clear()
        self.config = fixture_config(self.home, router=json.loads(json.dumps(BLOCK)))


class Available(Case):
    def test_status_lists_every_model_the_server_serves(self):
        router_state.save_discovery("nas", {"models": [
            {"name": "qwen3.5:9b", "params_b": 9.7, "quant": "Q4_K_M", "context_max": 262144, "tools": True,
             "loaded": True, "loaded_context": 16384, "size_bytes": 6_600_000_000, "family": "qwen35"},
            {"name": "llama3.1:8b", "params_b": 8.0, "quant": "Q4_0", "tools": False},
            {"name": "nomic-embed-text:latest", "kind": "embedding"}]})
        row = next(s for s in R.status(self.config)["systems"] if s["id"] == "nas")
        # weights_bytes: what Settings' context box says a choice costs (0.51), as Suggest counts the weights.
        self.assertEqual(row["available"], [
            {"name": "qwen3.5:9b", "params_b": 9.7, "quant": "Q4_K_M", "context_max": 262144, "tools": True,
             "loaded": True, "loaded_context": 16384, "weights_bytes": 6_600_000_000},
            {"name": "llama3.1:8b", "params_b": 8.0, "quant": "Q4_0", "tools": False, "weights_bytes": 4_800_000_000},
            {"name": "nomic-embed-text:latest", "kind": "embedding"}])
        self.assertNotIn("size_bytes", json.dumps(row["available"]), "only what Settings shows")

    def test_status_carries_the_servers_own_room(self):
        router_state.save_discovery("gpu", {"models": [{"name": "qwen3:8b"}], "slots": 2, "slot_context": 8192})
        router_state.save_discovery("nas", {"models": [{"name": "qwen3.5:9b"}], "kv_tokens": 98304})
        rows = {s["id"]: s for s in R.status(self.config)["systems"]}
        self.assertEqual((rows["gpu"]["server_slots"], rows["gpu"]["server_slot_context"]), (2, 8192))
        self.assertEqual(rows["nas"]["server_kv_tokens"], 98304)
        self.assertNotIn("server_kv_tokens", rows["gpu"])

    def test_a_system_never_read_has_no_list(self):
        row = next(s for s in R.status(self.config)["systems"] if s["id"] == "gpu")
        self.assertNotIn("available", row)

    def test_the_list_is_bounded(self):
        router_state.save_discovery("nas", {"models": [{"name": f"m{n}:1b"} for n in range(200)]})
        row = next(s for s in R.status(self.config)["systems"] if s["id"] == "nas")
        self.assertEqual(len(row["available"]), R.MAX_AVAILABLE)

    def test_the_capability_says_so(self):
        backend = headless.Backend.__new__(headless.Backend)
        backend.config = self.config
        capability = backend._router_capability()
        self.assertEqual((capability["pips_default"], capability["status"]), (1, 2))


class PipsDefault(Case):
    def test_any_pip_system_for_every_pip_on_default(self):
        self.config.data["pips_model"] = "router"
        self.assertEqual(pip_models.pips_default(self.config), "", "not a model on DGC's own connection")
        self.assertEqual(pip_models.pips_router_default(self.config), {"mode": "router"})
        settings = pips._model_settings(self.config, {"mode": "default"}, personal=True)
        self.assertEqual((settings["model"], settings["router"]), ("router", {"system": "", "model": ""}))
        self.assertEqual(pip_models.resolve_model_choice(self.config, {"mode": "default"}), "router")

    def test_one_system_and_model(self):
        self.config.data["pips_model"] = "router:nas/qwen3.5:9b"
        settings = pips._model_settings(self.config, {"mode": "default"}, personal=True)
        self.assertEqual(settings["router"], {"system": "nas", "model": "qwen3.5:9b"})
        self.assertEqual(settings["model"], "router:nas/qwen3.5:9b")

    def test_a_pip_with_its_own_choice_keeps_it(self):
        self.config.data["pips_model"] = "router"
        settings = pips._model_settings(self.config, {"mode": "router", "system": "gpu", "model": "qwen3:8b"},
                                        personal=True)
        self.assertEqual(settings["router"], {"system": "gpu", "model": "qwen3:8b"})

    def test_with_the_router_off_default_follows_dgc(self):
        self.config.data["pips_model"] = "router"
        self.config.data["router"]["enabled"] = False
        self.assertIsNone(pip_models.pips_router_default(self.config))
        self.assertEqual(pip_models.default_model(self.config), self.config.get("model"))
        with patch.object(pip_models, "_catalog", return_value=[self.config.get("model")]):
            listing = pip_models.list_pip_models(self.config)
        self.assertNotIn("router", listing, "off, the list is exactly what it was")
        self.assertEqual(listing["pips_model"], "")

    def test_the_model_list_says_where_default_runs(self):
        self.config.data["pips_model"] = "router:nas/qwen3.5:9b"
        with patch.object(pip_models, "_catalog", return_value=["qwen3:8b"]):
            listing = pip_models.list_pip_models(self.config)
        self.assertEqual(listing["router"]["pips_default"], "router:nas/qwen3.5:9b")
        self.assertEqual(listing["pips_model"], "")

    def test_labels(self):
        self.assertEqual(pip_models.router_choice_of("router"), {"mode": "router"})
        self.assertEqual(pip_models.router_choice_of("router:gpu/qwen3:8b"),
                         {"mode": "router", "system": "gpu", "model": "qwen3:8b"})
        for other in ("qwen3:8b", "router:", "router:Bad/x", "router:gpu/", "routers", ""):
            with self.subTest(other=other):
                self.assertIsNone(pip_models.router_choice_of(other))


if __name__ == "__main__":
    unittest.main()
