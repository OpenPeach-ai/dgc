"""DGC Router: server detection, discovery and the probes, against fakes that replay each server's documented answers.

Live runs against real Ollama servers and a real llama.cpp llama-server are recorded in the release evidence; vLLM,
SGLang and TGI are covered here only.
"""
from __future__ import annotations

import ipaddress
import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from router_fakes import FakeServer, slot_clock  # noqa: E402

from dgc import router_probe as P  # noqa: E402
from dgc import router_state  # noqa: E402


class Detection(unittest.TestCase):
    def test_each_server_type_is_told_apart(self):
        for kind, server in (("ollama", "ollama"), ("llamacpp", "llamacpp"), ("vllm", "vllm"),
                             ("sglang", "sglang"), ("tgi", "tgi"), ("lmstudio", "lmstudio"),
                             ("openai", "openai_compatible")):
            with self.subTest(kind=kind), FakeServer(kind) as fake:
                found = P.detect(fake.url)
                self.assertEqual(found["server"], server)
                self.assertEqual(found["base_url"], fake.url)

    def test_a_server_that_wants_a_key_says_so(self):
        with FakeServer("openai", key="sk-test-1") as fake:
            self.assertTrue(P.detect(fake.url).get("needs_key"))
            self.assertEqual(P.detect(fake.url, "sk-test-1")["server"], "openai_compatible")

    def test_a_bare_host_tries_the_known_ports(self):
        self.assertEqual(P.candidates("gpu-box.local"),
                         [f"http://gpu-box.local:{port}" for port in P.MODEL_PORTS])
        self.assertEqual(P.candidates("gpu-box.local:8080"), ["http://gpu-box.local:8080"])
        with FakeServer("ollama") as fake:
            with patch.object(P, "MODEL_PORTS", (1, fake.port)):
                found = P.detect("127.0.0.1")
            self.assertEqual(found, {"base_url": fake.url, "server": "ollama", "version": "0.32.13"})

    def test_nothing_listening_is_a_plain_error_and_quick(self):
        started = time.monotonic()
        with self.assertRaises(P.ProbeError) as raised:
            P.detect("http://127.0.0.1:9")
        self.assertIn("no model server", str(raised.exception))
        self.assertLess(time.monotonic() - started, P.CONNECT_TIMEOUT + P.READ_TIMEOUT + 1)


class Discovery(unittest.TestCase):
    def test_ollama_sizes_context_capabilities_and_what_is_loaded(self):
        with FakeServer("ollama") as fake:
            found = P.discover(fake.url, "ollama")
        models = {m["name"]: m for m in found["models"]}
        qwen = models["qwen3:8b"]
        self.assertEqual((qwen["params_b"], qwen["size_class"], qwen["quant"]), (8.2, "small", "Q4_K_M"))
        self.assertEqual(qwen["context_max"], 40960)
        self.assertTrue(qwen["tools"] and qwen["thinking"] and not qwen["vision"])
        self.assertEqual((qwen["loaded"], qwen["loaded_context"], qwen["pinned"]), (True, 16384, True))
        self.assertEqual(qwen["kv_bytes_per_token"], 36 * 8 * 256 * 2)
        # An MLX model names no size in /api/tags: /api/show's count is used.
        self.assertEqual(models["qwen3.6:35b-a3b-mlx"]["params_b"], 35.107)
        self.assertTrue(models["qwen3.6:35b-a3b-mlx"]["vision"])
        self.assertEqual(models["nomic-embed-text:latest"]["kind"], "embedding")
        self.assertTrue(models["glm-5.3:cloud"]["cloud"])

    def test_an_mlx_model_with_no_size_anywhere_falls_back_to_its_file(self):
        rows = [{"name": "mystery-mlx", "size": 21909210142,
                 "details": {"format": "safetensors", "parameter_size": "", "quantization_level": "nvfp4"}}]
        with FakeServer("ollama", models=rows) as fake:
            model = P.discover(fake.url, "ollama")["models"][0]
        self.assertAlmostEqual(model["params_b"], 39.1, delta=0.2)
        self.assertEqual(model["size_class"], "medium")

    def test_llamacpp_slots_context_and_live_load(self):
        with FakeServer("llamacpp") as fake:
            found = P.discover(fake.url, "llamacpp")
        self.assertEqual((found["slots"], found["slot_context"]), (2, 8192))
        self.assertEqual(found["load"], {"running": 1, "slots": 2, "waiting": 0, "kv_used_pct": 10.0,
                                         "tokens_per_s": 42.5})
        self.assertEqual(found["models"][0]["params_b"], 0.494)
        self.assertEqual(found["models"][0]["context_max"], 32768)

    def test_vllm_context_kv_capacity_and_load(self):
        with FakeServer("vllm") as fake:
            found = P.discover(fake.url, "vllm")
        self.assertEqual(found["models"][0]["loaded_context"], 32768)
        self.assertEqual(found["kv_tokens"], 2048 * 16)
        self.assertEqual(found["load"], {"running": 1, "waiting": 2, "kv_used_pct": 25.0})
        self.assertEqual(found["version"], "0.11.0")

    def test_sglang_and_tgi(self):
        with FakeServer("sglang") as fake:
            sgl = P.discover(fake.url, "sglang")
        self.assertEqual((sgl["slots"], sgl["kv_tokens"]), (48, 400000))
        self.assertEqual(sgl["load"], {"running": 3, "waiting": 1, "kv_used_pct": 40.0})
        with FakeServer("tgi") as fake:
            tgi = P.discover(fake.url, "tgi")
        self.assertEqual(tgi["slots"], 128)
        self.assertEqual(tgi["models"][0]["loaded_context"], 8192)
        self.assertEqual(tgi["load"], {"waiting": 2, "running": 3})

    def test_lmstudio_and_plain_openai(self):
        with FakeServer("lmstudio") as fake:
            models = {m["name"]: m for m in P.discover(fake.url, "lmstudio")["models"]}
        self.assertTrue(models["meta-llama-3.1-8b-instruct"]["loaded"])
        self.assertEqual(models["meta-llama-3.1-8b-instruct"]["loaded_context"], 8192)
        self.assertTrue(models["meta-llama-3.1-8b-instruct"]["tools"])
        self.assertEqual(models["text-embedding-nomic-embed-text-v1.5"]["kind"], "embedding")
        with FakeServer("openai") as fake:
            names = [m["name"] for m in P.discover(fake.url, "openai_compatible")["models"]]
        self.assertEqual(names, ["gpt-small-8b", "text-embedding-3-small"])

    def test_health_is_one_quick_read(self):
        with FakeServer("ollama") as fake:
            self.assertEqual(P.health(fake.url, "ollama")[0], True)
            self.assertEqual(fake.requests[-1]["path"], "/api/version")
        ok, _ms, why = P.health("http://127.0.0.1:9", "ollama")
        self.assertFalse(ok)
        self.assertIn("refused", why)


class Sizes(unittest.TestCase):
    def test_parameter_counts(self):
        self.assertEqual(P.parse_params("9.7B"), 9.7)
        self.assertEqual(P.parse_params("566.70M"), 0.567)
        self.assertEqual(P.parse_params("1.65T"), 1650.0)
        self.assertEqual(P.parse_params("753329940480"), 753.33)
        self.assertIsNone(P.parse_params(""))
        self.assertEqual(P.params_from_name("qwen3:8b"), 8.0)
        self.assertEqual(P.params_from_name("qwen3.6:35b-a3b-mlx"), 35.0)
        self.assertEqual(P.params_from_name("llama3.1:8b-instruct-q8_0"), 8.0)
        self.assertIsNone(P.params_from_name("glm-5.3:cloud"))
        self.assertEqual([P.size_class(v) for v in (4, 12, 13, 40, 70)],
                         ["small", "small", "medium", "medium", "large"])


class Probes(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp(prefix="dgc-router-probe-")
        self.env = patch.dict(os.environ, {"DGC_HOME": self.home})
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_speed_sends_the_fixed_context_every_time(self):
        with FakeServer("ollama") as fake:
            target = P.Target(fake.url, "ollama", "qwen3:8b", context=16384, thinking=True, keep_alive=-1)
            result = P.probe_speed(target)
            sent = fake.chats()[-1]["json"]
        self.assertTrue(result["ok"])
        self.assertGreater(result["tokens_per_s"], 0)
        self.assertGreaterEqual(result["ttft_ms"], 0)
        self.assertEqual(sent["options"]["num_ctx"], 16384)
        self.assertEqual((sent["think"], sent["keep_alive"]), (False, -1))

    def parallel(self, kind, server, model, slots, **target):
        """probe_parallel against a fake with ``slots`` slots that holds each round until all of it has arrived and
        times its replies on a clock of its own: (the probe's answer, the requests the fake saw in flight at once,
        round by round)."""
        widths = (1, 2, 4)                      # probe_parallel's own rounds
        with slot_clock(P) as clock, FakeServer(kind, parallel=slots, delay=0.25, bursts=widths, clock=clock) as fake:
            found = P.probe_parallel(P.Target(fake.url, server, model, **target), widths=widths)
        return found, fake.overlap

    def test_parallel_tells_a_queue_from_parallel_slots(self):
        """It once read 2 for a server with 4 slots under a full test run (its fake shared the busy process, and
        300 ms replies left 150 ms to spare): the fake now counts the requests in flight at once and times its replies
        on its own clock, so only what the server does decides it."""
        wide, seen = self.parallel("ollama", "ollama", "qwen3:8b", 4, context=8192)
        self.assertEqual(seen, [1, 2, 4], "each round's requests were in flight together")
        self.assertEqual(wide["runs"], 4)
        self.assertEqual([wide["rounds"][w]["slowest_ms"] for w in ("1", "2", "4")], [250, 250, 250])
        queued, seen = self.parallel("ollama", "ollama", "qwen3:8b", 1, context=8192)
        self.assertEqual(seen, [1, 2], "a queue shows at two, and the probe stops there")
        self.assertEqual(queued["runs"], 1)
        self.assertEqual(queued["rounds"]["2"]["slowest_ms"], 500, "the second waited for the first")
        two, seen = self.parallel("vllm", "vllm", "Qwen/Qwen3-8B", 2)
        self.assertEqual(seen, [1, 2, 4])
        self.assertEqual(two["runs"], 2)
        self.assertEqual(two["rounds"]["4"]["slowest_ms"], 500)

    def test_parallel_reads_the_same_on_a_busy_machine(self):
        """The same answers while other threads of this process keep the interpreter busy: two of them made the old
        test misread in four runs of six (2 or 1 for four slots, 4 for two)."""
        stop = threading.Event()

        def busy():
            while not stop.is_set():
                pass
        workers = [threading.Thread(target=busy, daemon=True) for _ in range(2)]
        for worker in workers:
            worker.start()
        try:
            answers = [self.parallel("ollama", "ollama", "qwen3:8b", slots, context=8192)[0]["runs"]
                       for slots in (4, 1, 2)]
        finally:
            stop.set()
            for worker in workers:
                worker.join()
        self.assertEqual(answers, [4, 1, 2])

    def test_tool_smoke_test(self):
        for kind, server in (("ollama", "ollama"), ("llamacpp", "llamacpp")):
            with self.subTest(kind=kind):
                with FakeServer(kind) as fake:
                    self.assertTrue(P.probe_tools(P.Target(fake.url, server, "m"))["ok"])
                with FakeServer(kind, tool_ok=False) as fake:
                    failed = P.probe_tools(P.Target(fake.url, server, "m"))
                self.assertFalse(failed["ok"])
                self.assertIn("words", failed["detail"])

    def test_results_are_saved_with_a_timestamp(self):
        with FakeServer("ollama") as fake:
            results = P.run_probes(P.Target(fake.url, "ollama", "qwen3:8b", context=8192),
                                   checks=("speed", "tools"))
        saved = router_state.save_probe("nas", "qwen3:8b", results)
        self.assertEqual(set(saved), {"speed", "tools"})
        self.assertTrue(all(isinstance(saved[c]["at"], float) for c in saved))
        self.assertTrue((Path(self.home) / ".dgc" / "router" / "probes.json").is_file())
        self.assertEqual(router_state.probes("nas")["qwen3:8b"]["tools"]["ok"], True)

    def test_a_failing_model_is_a_result_not_an_exception(self):
        results = P.run_probes(P.Target("http://127.0.0.1:9", "ollama", "x"), checks=("speed",))
        self.assertFalse(results["speed"]["ok"])
        self.assertIn("refused", results["speed"]["error"])


class Find(unittest.TestCase):
    def test_only_this_computers_own_network_and_the_known_ports(self):
        own = ipaddress.ip_network("10.9.8.0/24")
        with self.assertRaises(P.ProbeError):
            P.find("10.1.1.0/24", network=own)
        with self.assertRaises(P.ProbeError):
            P.find(network=own, ports=(22,))

    def test_it_finds_servers_on_open_known_ports(self):
        with FakeServer("ollama") as fake:
            seen = []

            def fake_open(host, port, timeout):
                seen.append((host, port))
                return host == "10.9.8.7" and port == 11434

            real_identify = P.identify
            with patch.object(P, "_open", fake_open), \
                    patch.object(P, "identify", lambda base, key="": real_identify(fake.url) if "10.9.8.7" in base
                                 else None):
                found = P.find(network=ipaddress.ip_network("10.9.8.0/24"))
        self.assertEqual(len(seen), 254 * len(P.KNOWN_PORTS))
        self.assertTrue(all(port in P.KNOWN_PORTS for _host, port in seen))
        self.assertEqual([item["server"] for item in found["found"]], ["ollama"])


if __name__ == "__main__":
    unittest.main()
