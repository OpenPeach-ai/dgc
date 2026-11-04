"""DGC Router's hardware readout: exporters the user already runs (node_exporter, NVIDIA DCGM, AMD's device-metrics
exporter, Glances, Netdata) and a dgc node, read by DGC itself (never the model), at most once a minute, short
timeouts and no redirects. The dgc node's pairing token lives in secrets.json, bound to the readout's address."""
from __future__ import annotations

import json
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import router_hw_fixtures as F  # noqa: E402
from router_fakes import FakeServer  # noqa: E402
from test_subagents import Harness  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc import router_hardware as H  # noqa: E402
from dgc import router_state, router_tools as T  # noqa: E402
from dgc.config import router_hardware_url, validate_router  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402

GIB = 1024 ** 3


class Readers(unittest.TestCase):
    def test_node_exporter_memory_load_and_cpu(self):
        snap = H.from_prometheus(F.NODE_EXPORTER)
        self.assertEqual(snap["kind"], "node_exporter")
        self.assertEqual(snap["memory"], {"total_bytes": 128524308480, "available_bytes": 86624342016})
        self.assertEqual((snap["cpu"]["load1"], snap["cpu"]["cores"]), (2.39, 2))
        self.assertEqual(snap["gpus"], [], "node_exporter sees no NVIDIA GPU: simply absent")
        self.assertEqual(H.line(snap), "no GPU reported · 39 of 120 GB memory · load 2.39")
        darwin = H.from_prometheus(F.NODE_EXPORTER_DARWIN)
        self.assertEqual(darwin["memory"]["available_bytes"], 4294967296 + 17179869184, "macOS: free + inactive")

    def test_node_exporters_drm_collector_on_an_apu(self):
        snap = H.from_prometheus(F.NODE_EXPORTER_DRM_APU)
        gpu = snap["gpus"][0]
        self.assertTrue(gpu["unified"])
        self.assertEqual(gpu["memory_total_bytes"], 2 * GIB + 112742891520)
        self.assertEqual((gpu["util_pct"], gpu["temp_c"]), (12, 30))

    def test_dcgm_on_a_gb10_and_on_two_cards(self):
        snap = H.from_prometheus(F.DCGM_GB10)
        self.assertEqual(snap["kind"], "dcgm")
        self.assertEqual(H.line(snap), "GB10 · 34% · 46°C · 12 W", "no frame buffer reported: no memory shown")
        two = H.from_prometheus(F.DCGM_TWO_CARDS)
        self.assertEqual(len(two["gpus"]), 2)
        self.assertEqual(two["gpus"][0]["memory_total_bytes"], (18000 + 6000 + 576) * 1048576)
        self.assertEqual(H.line(two), "2 × RTX 3090 · 25 of 48 GB · 30% · 61°C · 451 W")

    def test_amds_device_metrics_exporter(self):
        snap = H.from_prometheus(F.AMD_EXPORTER)
        self.assertEqual(snap["kind"], "amd")
        gpu = snap["gpus"][0]
        self.assertEqual((gpu["name"], gpu["memory_total_bytes"], gpu["util_pct"], gpu["power_w"]),
                         ("AMD Instinct MI300X", 196592 * 1048576, 55, 412))
        self.assertEqual(H.line(snap), "Instinct MI300X · 96 of 192 GB · 55% · 0°C · 412 W")

    def test_a_page_dgc_doesnt_know_is_said_plainly(self):
        with self.assertRaises(H.HardwareError) as raised:
            H.from_prometheus("http_requests_total 5\n")
        self.assertIn("node_exporter, DCGM and AMD", str(raised.exception))

    def test_glances(self):
        with F.FakeHardware("glances") as fake:
            snap = H.read(fake.url + "/api/4", "exporter")
        self.assertEqual(snap["kind"], "glances")
        self.assertEqual(snap["memory"]["total_bytes"], 128524308480)
        self.assertEqual(snap["cpu"], {"util_pct": 12.5, "cores": 20, "load1": 2.47})
        self.assertEqual(H.line(snap), "GB10 · RAM 39 of 120 GB · 0% · 46°C",
                         "Glances gives no GPU memory there: the computer's, called RAM")

    def test_netdata(self):
        with F.FakeHardware("netdata") as fake:
            snap = H.read(fake.url + "/api/v1", "exporter")
        self.assertEqual(snap["kind"], "netdata")
        self.assertEqual(snap["memory"], {"total_bytes": 64 * GIB, "available_bytes": 40 * GIB})
        self.assertEqual(snap["cpu"], {"cores": 16, "util_pct": 26.0, "load1": 1.25})
        self.assertEqual(H.line(snap), "RTX PRO 2000 Blackwell · 6 of 16 GB · 77% · 64°C · 62 W")

    def test_short_names(self):
        for name, short in (("NVIDIA GeForce RTX 4090", "RTX 4090"), ("NVIDIA GB10", "GB10"),
                            ("Radeon 8060S Graphics", "Radeon 8060S"), ("Apple M2 Ultra", "M2 Ultra")):
            self.assertEqual(H.short_name(name), short)


class Detecting(unittest.TestCase):
    def test_each_kind_by_its_address(self):
        cases = (("dcgm", F.DCGM_GB10, "dcgm"), ("node_exporter", F.NODE_EXPORTER, "node_exporter"),
                 ("amd", F.AMD_EXPORTER, "amd"))
        for fake_kind, page, kind in cases:
            with self.subTest(kind=kind), F.FakeHardware(fake_kind, page=page) as fake:
                found = H.detect(fake.url)                         # a port, no path: the known paths are tried
                self.assertEqual((found["source"], found["kind"], found["url"]), ("exporter", kind, fake.url + "/metrics"))
        with F.FakeHardware("glances") as fake:
            self.assertEqual(H.detect(fake.url)["url"], fake.url + "/api/4")
            self.assertEqual(H.detect(fake.url + "/api/4")["kind"], "glances")
        with F.FakeHardware("netdata") as fake:
            self.assertEqual(H.detect(fake.url)["url"], fake.url + "/api/v1")

    def test_a_dgc_node_wants_its_token(self):
        with F.FakeHardware("dgc_node", token="dgcn_t") as fake:
            found = H.detect(fake.url)
            self.assertEqual((found["source"], found["kind"], found["url"], found.get("needs_token")),
                             ("node", "dgc_node", fake.url, True))
            self.assertEqual(H.detect(fake.url + "/v1/stats")["url"], fake.url)
            with self.assertRaises(H.HardwareError) as raised:
                H.read(fake.url, "node")
            self.assertIn("pairing token", str(raised.exception))
            snap = H.read(fake.url, "node", "dgcn_t")
            self.assertEqual(fake.reads[-1]["auth"], "Bearer dgcn_t")
        self.assertEqual(H.line(snap), "RTX 4090 · 18 of 24 GB · 34% · 61°C · 288 W")

    def test_no_redirect_is_followed_and_nothing_answering_is_said(self):
        with F.FakeHardware("redirect") as fake:
            with self.assertRaises(H.HardwareError) as raised:
                H.read(fake.url + "/metrics", "exporter")
            self.assertIn("redirect", str(raised.exception))
            self.assertEqual(len(fake.reads), 1)
        with self.assertRaises(H.HardwareError) as raised:
            H.detect("http://127.0.0.1:9/metrics")
        self.assertIn("no exporter or dgc node answered", str(raised.exception))

    def test_an_address_never_carries_a_token(self):
        for bad in ("http://user:pw@nas.local:9100/metrics", "http://nas.local:8577/v1/stats?token=x",
                    "http://nas.local:8577/#t"):
            self.assertTrue(router_hardware_url(bad)[1], bad)
        self.assertEqual(router_hardware_url("nas.local:9100/metrics/"), ("http://nas.local:9100/metrics", ""))


class Wired(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-hw-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.router = R.Router()
        for item in (patch.object(R, "ROUTER", self.router),
                     patch.object(R.Router, "ensure_health", lambda self, config: None)):
            item.start()
            self.addCleanup(item.stop)
        directory = tempfile.TemporaryDirectory(prefix="dgc-router-hw-project-")
        self.addCleanup(directory.cleanup)
        self.harness = Harness(Path(directory.name))
        self.addCleanup(self.harness.close)
        self.config = self.harness.config
        self.config.data["router"] = {"enabled": True, "systems": [
            {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama",
             "models": [{"name": "qwen3.5:9b", "context": 16384}]}]}

    def test_the_config_takes_a_source_and_an_address(self):
        block, problems = validate_router({"systems": [{"id": "a", "base_url": "a.local", "hardware": {
            "source": "exporter", "url": "a.local:9100/metrics"}}]})
        self.assertEqual((problems, block["systems"][0]["hardware"]),
                         ([], {"source": "exporter", "url": "http://a.local:9100/metrics"}))
        _, problems = validate_router({"systems": [{"id": "a", "base_url": "a.local", "hardware": {
            "source": "node", "url": "http://a.local:8577?token=x"}}]})
        self.assertTrue(any("hardware.url" in p for p in problems))
        block, problems = validate_router({"systems": [{"id": "a", "base_url": "a.local"}]})
        self.assertEqual(block["systems"][0]["hardware"], {"source": "none"}, "off unless set up")

    def test_set_hardware_shows_the_change_reads_it_and_status_says_it(self):
        with F.FakeHardware("dcgm", page=F.DCGM_TWO_CARDS) as fake:
            plan = T.plan_update(self.config, {"action": "set_hardware", "system": "nas", "hardware_url": fake.url})
            self.assertIn('"source": "exporter"', plan.diff)
            self.assertEqual(plan.summary, f"Read NAS's hardware from NVIDIA DCGM exporter at {fake.url}/metrics")
            T.apply_plan(self.config, plan)
            self.assertIn("2 × RTX 3090", H.line(plan.reading))
            status = R.status(self.config, router=self.router)
        row = status["systems"][0]["hardware"]
        self.assertEqual((row["source"], row["kind"], row["line"]), ("exporter", "dcgm",
                                                                     "2 × RTX 3090 · 25 of 48 GB · 30% · 61°C · 451 W"))
        self.assertNotIn("_counters", json.dumps(row))
        text = T.status_text(status)
        self.assertIn("  · hardware: 2 × RTX 3090 · 25 of 48 GB · 30% · 61°C · 451 W (NVIDIA DCGM exporter, ", text)
        off = T.plan_update(self.config, {"action": "set_hardware", "system": "nas", "hardware_url": "off"})
        T.apply_plan(self.config, off)
        self.assertNotIn("hardware", R.status(self.config, router=self.router)["systems"][0])

    def test_the_token_never_passes_through_the_model(self):
        with F.FakeHardware("dgc_node", token="dgcn_secret") as fake:
            for args in ({"action": "set_hardware", "system": "nas", "hardware_url": fake.url, "token": "dgcn_secret"},
                         {"action": "set_hardware", "system": "nas", "hardware_url": fake.url + "?token=dgcn_secret"}):
                with self.subTest(args=args), self.assertRaises(T.UpdateError):
                    T.plan_update(self.config, args)
            self.harness.answer("permission_request", {"decision": "once"})
            out = self.harness.agent._handle_call(ToolCall("h1", "router_update", {
                "action": "set_hardware", "system": "nas", "hardware_url": fake.url}))
            self.assertIn("pairing token", out)
            self.assertIn("ask the user to paste it", out)
            self.assertEqual(self.config.data["router"]["systems"][0]["hardware"], {"source": "node", "url": fake.url})
            card = [f for f in self.harness.stream.frames() if f["type"] == "permission_request"][-1]
            self.assertEqual(card["choices"], ["once", "deny"])
            self.config.set_router_hardware_token("nas", "dgcn_secret")
            snap = H.read_system(self.config, self.config.router_block()["systems"][0], max_age=0)
            self.assertIn("RTX 4090", H.line(snap))
        secrets = json.loads((self.home / ".dgc" / "secrets.json").read_text()) if (self.home / ".dgc" /
                                                                                    "secrets.json").exists() else {}
        config_text = (self.home / ".dgc" / "config.json").read_text() if (self.home / ".dgc" /
                                                                          "config.json").exists() else ""
        self.assertNotIn("dgcn_secret", config_text)
        self.assertNotIn("dgcn_secret", json.dumps(R.status(self.config, router=self.router)))
        self.assertNotIn("dgcn_secret", T.run(self.harness.agent, "router_status", {}))
        self.assertTrue(R.status(self.config, router=self.router)["systems"][0]["hardware"]["has_token"])
        if secrets:
            self.assertEqual(secrets.get("router_key_nas:hardware"), "dgcn_secret")

    def test_a_new_address_drops_the_token(self):
        self.config.data["router"]["systems"][0]["hardware"] = {"source": "node", "url": "http://nas.local:8577"}
        self.config.set_router_hardware_token("nas", "dgcn_one", persist=False)
        self.assertEqual(self.config.router_hardware_token("nas"), "dgcn_one")
        self.assertEqual(self.config.router_key("nas"), "", "the model server's key is another slot")
        self.config.data["router"]["systems"][0]["hardware"] = {"source": "node", "url": "http://other.local:8577"}
        self.assertEqual(self.config.router_hardware_token("nas"), "")
        self.config.data["router"]["systems"][0]["hardware"] = {"source": "exporter", "url": "http://nas.local:8577"}
        self.assertEqual(self.config.router_hardware_token("nas"), "", "an exporter has no token")
        with self.assertRaises(ValueError):
            self.config.set_router_hardware_token("nas", "dgcn_two")

    def test_the_health_check_reads_it_at_most_once_a_minute(self):
        with F.FakeHardware("node_exporter", page=F.NODE_EXPORTER) as fake, FakeServer("ollama") as ollama:
            self.config.data["router"]["systems"][0].update(base_url=ollama.url, hardware={"source": "exporter",
                                                                                          "url": fake.url + "/metrics"})
            self.router.check(self.config)
            self.router.check(self.config)
            self.assertEqual(len(fake.reads), 1, "twice in a minute: read once")
            saved = H.saved("nas")
            saved["checked"] = time.time() - H.HARDWARE_EVERY_S - 1
            router_state.write("hardware", {"nas": saved})
            self.router.check(self.config)
            self.assertEqual(len(fake.reads), 2)
        self.assertIn("load 2.39", T.status_text(R.status(self.config, router=self.router)))

    def test_a_failed_read_keeps_the_last_good_one_and_says_so(self):
        with F.FakeHardware("dcgm", page=F.DCGM_GB10) as fake:
            self.config.data["router"]["systems"][0]["hardware"] = {"source": "exporter", "url": fake.url + "/metrics"}
            H.read_system(self.config, self.config.router_block()["systems"][0], max_age=0)
        H.read_system(self.config, self.config.router_block()["systems"][0], max_age=0)    # it is gone now
        text = T.hardware_text(H.status_row(self.config, self.config.router_block()["systems"][0]))
        self.assertIn("GB10 · 34% · 46°C · 12 W", text)
        self.assertIn("the last read failed: couldn't reach the exporter", text)

    def test_removing_a_system_forgets_its_reading(self):
        router_state.write("hardware", {"nas": {"url": "x", "gpus": []}})
        T.apply_plan(self.config, T.plan_update(self.config, {"action": "remove_system", "system": "nas"}))
        self.assertEqual(router_state.read("hardware"), {})

    def test_routing_never_depends_on_it(self):
        self.config.data["router"]["systems"][0]["hardware"] = {"source": "exporter", "url": "http://127.0.0.1:9/m"}
        route, why = self.router.acquire(self.config, "subagents", wait=False)
        self.assertEqual((route.system_id, why), ("nas", ""))
        self.router.release(route)


class Cli(unittest.TestCase):
    def test_dgc_router_hardware_from_the_agents_shell_is_refused(self):
        from dgc import router_cli
        with patch.dict(os.environ, {"DGC_AGENT_SHELL": "1"}):
            self.assertEqual(router_cli.main(["hardware", "nas", "http://nas.local:9100/metrics"]), 2)
            self.assertEqual(router_cli.main(["hardware", "nas", "--token"]), 2)
            self.assertEqual(router_cli.main(["suggest", "nas", "--apply"]), 2)


if __name__ == "__main__":
    unittest.main()
