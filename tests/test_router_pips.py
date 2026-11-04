"""Pips on DGC Router (Pips API 70): the brain choice, the run's pin, a worker leased as the run leaves the queue,
and the queue holding a run while every worker that could take it is busy."""
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

from dgc import headless, pip_models, pips  # noqa: E402
from dgc import router as R  # noqa: E402
from dgc.workspace_registry import RegistryError, WorkspaceRegistry  # noqa: E402

BLOCK = {"enabled": True, "when_busy": "wait", "systems": [
    {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama", "jobs": ["pips"],
     "models": [{"name": "qwen3.5:9b", "workers": 1, "context": 16384}]},
    {"id": "gpu", "name": "GPU box", "base_url": "http://gpu-box.local:8080", "server": "llamacpp",
     "jobs": ["subagents"], "models": [{"name": "qwen3:8b", "workers": 2, "context": 8192}]}]}


class RouterPipCase(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-pips-"))
        for item in (patch.dict(os.environ, {"DGC_HOME": str(self.home)}),
                     patch.object(R, "ROUTER", R.Router()),
                     patch.object(R.Router, "ensure_health", lambda self, config: None)):
            item.start()
            self.addCleanup(item.stop)
        pips._ROUTER_RUNS.clear()
        self.config = fixture_config(self.home, router=json.loads(json.dumps(BLOCK)))


class Choice(RouterPipCase):
    def test_the_two_router_choices_and_nothing_else(self):
        self.assertEqual(pip_models.validate_model_choice({"mode": "router"}), {"mode": "router"})
        self.assertEqual(pip_models.validate_model_choice({"mode": "router", "system": "nas", "model": "qwen3.5:9b"}),
                         {"mode": "router", "system": "nas", "model": "qwen3.5:9b"})
        for bad in ({"mode": "router", "system": "nas"}, {"mode": "router", "system": "Bad Id", "model": "m"},
                    {"mode": "router", "base_url": "http://x"}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                pip_models.validate_model_choice(bad)

    def test_resolving_checks_the_router_now(self):
        self.assertEqual(pip_models.resolve_model_choice(self.config, {"mode": "router"}), "router")
        self.assertEqual(pip_models.resolve_model_choice(
            self.config, {"mode": "router", "system": "nas", "model": "qwen3.5:9b"}), "router:nas/qwen3.5:9b")
        with self.assertRaises(RegistryError) as raised:
            pip_models.resolve_model_choice(self.config, {"mode": "router", "system": "gpu", "model": "qwen3:8b"})
        self.assertIn("doesn't offer", str(raised.exception), "the GPU box has no Pips job")
        self.config.data["router"]["enabled"] = False
        with self.assertRaises(RegistryError) as raised:
            pip_models.resolve_model_choice(self.config, {"mode": "router"})
        self.assertEqual(raised.exception.code, "router_off")

    def test_the_model_list_names_the_pip_systems(self):
        with patch.object(pip_models, "_catalog", return_value=["qwen3:8b"]):
            listing = pip_models.list_pip_models(self.config)
        self.assertEqual(listing["router"], {"enabled": True, "systems": [
            {"id": "nas", "name": "NAS", "online": True,
             "models": [{"name": "qwen3.5:9b", "context_window": 16384}]}]})
        self.assertNotIn("nas.local", json.dumps(listing), "no address leaves the CLI")

    def test_the_run_pins_the_choice_not_an_address(self):
        settings = pips._model_settings(self.config, {"mode": "router"}, personal=True)
        self.assertEqual(settings["router"], {"system": "", "model": ""})
        self.assertEqual(settings["model"], "router")
        self.assertNotIn("base_url", settings)
        pip_models.validate_pinned_connection(self.config, settings)
        self.config.data["router"]["enabled"] = False
        with self.assertRaises(RegistryError) as raised:
            pip_models.validate_pinned_connection(self.config, settings)
        self.assertIn("turned off after this run was queued", str(raised.exception))

    def test_the_api_version_is_70_or_later(self):
        self.assertGreaterEqual(headless.PIPS_API_VERSION, 70)


class Queue(RouterPipCase):
    def setUp(self):
        super().setUp()
        self.registry = WorkspaceRegistry(self.home / "state", clock=lambda: "2026-11-01T10:00:00.000Z")
        self.addCleanup(self.registry.close)
        root = self.home / "workspace"
        root.mkdir()
        self.workspace = self.registry.resolve(root)
        self.store = pips.PipStore(self.registry)
        self.pips = [self.store.create(self.workspace["id"], f"Pip {n}", "Look around.", "fixture") for n in range(3)]
        self.serial = 0

    def queue(self, pip, settings, **manifest):
        self.serial += 1
        run_id = f"run_{self.serial:032x}"
        self.registry.db.execute('''INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)''', (run_id, pip["id"], self.workspace["id"], self.workspace["binding_id"],
                                           f"{self.serial:032x}", "fixture",
                                           json.dumps({"model_settings": settings, **manifest}), "queued",
                                           f"2026-11-01T10:00:0{self.serial}.000Z"))
        return run_id

    def admit(self, run_id, manifest):
        return pips._router_admit(self.config, run_id, manifest) is not False

    def test_a_router_run_waits_in_the_queue_while_its_worker_is_busy(self):
        router_run = self.queue(self.pips[0], {"model": "router", "router": {"system": "", "model": ""}})
        plain_run = self.queue(self.pips[1], {"model": "qwen3:8b", "base_url": "http://localhost:11434/v1"})
        held, _ = R.ROUTER.acquire(self.config, "pips", wait=False)          # the NAS's only Pips worker
        first = self.store.claim_next(admit=self.admit)
        self.assertEqual(first["id"], plain_run, "the next run in line goes ahead")
        self.assertIsNone(self.store.claim_next(admit=self.admit), "the Router run waits")
        self.assertEqual(self.registry.db.execute("SELECT status FROM pip_runs WHERE id=?", (router_run,)).fetchone()[0],
                         "queued")
        R.ROUTER.release(held)
        claimed = self.store.claim_next(admit=self.admit)
        self.assertEqual(claimed["id"], router_run)
        self.assertIn(router_run, pips._ROUTER_RUNS)
        route, settings = pips._router_route_for(self.config, claimed, json.loads(claimed["manifest"]))
        self.assertEqual((settings["base_url"], settings["model"], settings["api_mode"], settings["context_size"]),
                         ("http://nas.local:11434/v1", "qwen3.5:9b", "ollama", 16384))
        self.assertNotIn("router", settings)
        self.assertEqual(settings["ollama_keep_alive"], "", "the NAS's own keep-alive applies")
        self.assertEqual(len(R.ROUTER.leases()), 1)
        pips._router_release(claimed["id"])
        self.assertEqual(R.ROUTER.leases(), [])

    def test_a_pip_runs_worker_is_shown_by_the_pips_name(self):
        from dgc import router_tools
        run = self.queue(self.pips[0], {"model": "router", "router": {"system": "", "model": ""}}, job={"name": "Inbox"})
        self.addCleanup(pips._router_release, run)
        claimed = self.store.claim_next(admit=self.admit)
        self.assertEqual(claimed["id"], run)
        status = R.status(self.config)
        lease = next(lease for s in status["systems"] for lease in s["leases"])
        self.assertEqual((lease["label"], lease["owner"]), ("Pip Inbox", f"Pip run {run}"))
        text = router_tools.status_text(status)
        self.assertIn("for Pip Inbox", text)
        self.assertNotIn(run, text, "the run's id stays in --json")

    def test_without_admission_the_queue_is_as_before(self):
        run = self.queue(self.pips[0], {"model": "router", "router": {"system": "", "model": ""}})
        self.assertEqual(self.store.claim_next()["id"], run)
        self.assertEqual(R.ROUTER.leases(), [], "nothing leased by a caller that doesn't route")

    def test_a_run_nowhere_can_take_starts_and_fails_with_the_reason(self):
        self.config.data["router"]["systems"][0]["enabled"] = False
        run = self.queue(self.pips[0], {"model": "router", "router": {"system": "", "model": ""}})
        claimed = self.store.claim_next(admit=self.admit)
        self.assertEqual(claimed["id"], run)
        with self.assertRaises(RegistryError) as raised:
            pips._router_route_for(self.config, claimed, json.loads(claimed["manifest"]))
        self.assertIn("no system with the Pips job is online", str(raised.exception))

    def test_parallel_runs_stay_the_ceiling(self):
        self.assertEqual(pips.parallel_runs(fixture_config(self.home, pips_parallel_runs=2)), 2)


class CommandLine(unittest.TestCase):
    def test_create_and_propose_take_router(self):
        from dgc import pip_cli
        args = pip_cli.parser().parse_args(["create", "Inbox", "--goal", "Read my mail", "--router"])
        self.assertEqual(pip_cli._request(args)["model_choice"], {"mode": "router"})
        args = pip_cli.parser().parse_args(["create", "Inbox", "--goal", "Read my mail", "--router", "nas/qwen3.5:9b"])
        self.assertEqual(pip_cli._request(args)["model_choice"],
                         {"mode": "router", "system": "nas", "model": "qwen3.5:9b"})
        with self.assertRaises(RegistryError):
            pip_cli._router_choice("nas")


if __name__ == "__main__":
    unittest.main()
