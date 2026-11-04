"""DGC Router fixes from testing.

- Adding a system ticks only the model(s) its server has loaded now, never a cloud or embedding model. With nothing
  loaded it ticks none and the user chooses: the model's tool gets the list to ask from, `dgc router add` says
  "Choose with --models", and Settings' Add (and the SDK, and /router add) adds it with none chosen and says so.
- Test tests only the models a system uses, and never loads one that isn't loaded without saying so first: naming the
  model is how it is tested anyway.
- `dgc router status`, /router and router_status fold the models a system doesn't use into one line.
- Look on my network asks about exactly the ports it looks on.
- Suggest speaks each surface's own words, and after Apply says what was applied.
- A system at the main model's address holds a worker during a main turn only when the main model runs on that
  computer: an Ollama cloud model uses no GPU there.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from router_fakes import FakeServer  # noqa: E402
from test_subagents import Harness  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc import router_probe, router_state, router_suggest, router_tools as T  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def loaded(fake, names):
    """The fake Ollama holds exactly ``names`` in memory (its /api/ps)."""
    original = fake.get

    def get(path):
        if path == "/api/ps":
            return 200, {"models": [{"name": name, "model": name, "context_length": 16384,
                                     "expires_at": "2026-11-02T10:00:00Z"} for name in names]}
        return original(path)
    fake.get = get
    return fake


class Case(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-qa-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop("DGC_SESSION_POLICY", None)
        self.router = R.Router()
        self.addCleanup(lambda: [self.router.release(lease["id"]) for lease in self.router.held()])
        for item in (patch.object(R, "ROUTER", self.router),
                     patch.object(R.Router, "ensure_health", lambda self, config: None)):
            item.start()
            self.addCleanup(item.stop)

    def harness(self, block=None, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-router-qa-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), **data)
        self.addCleanup(harness.close)
        if block is not None:
            harness.config.data["router"] = block
        return harness


class AddTicksWhatIsLoaded(Case):
    def test_only_the_loaded_model_never_a_cloud_or_embedding_one(self):
        config = self.harness().config
        with FakeServer("ollama") as fake:                # its /api/ps: qwen3:8b
            plan = T.plan_update(config, {"action": "add_system", "name": "GPU box", "base_url": fake.url})
        self.assertEqual([m["name"] for m in plan.after["systems"][0]["models"]], ["qwen3:8b"])
        self.assertEqual(plan.after["systems"][0]["models"][0]["context"], 16384, "its loaded context: no reload")

    def test_a_loaded_cloud_or_embedding_model_is_never_ticked(self):
        config = self.harness().config
        with loaded(FakeServer("ollama"), ["glm-5.3:cloud", "nomic-embed-text:latest"]) as fake:
            with self.assertRaises(T.ChooseModels) as raised:
                T.plan_update(config, {"action": "add_system", "name": "GPU box", "base_url": fake.url})
        self.assertEqual(raised.exception.choices[:2], ["glm-5.3:cloud", "qwen3:8b"], "loaded first, then the rest")
        self.assertNotIn("nomic-embed-text:latest", raised.exception.choices)

    def test_nothing_loaded_the_models_tool_gets_the_list_to_ask_from_and_no_card(self):
        harness = self.harness()
        harness.answer("permission_request", {"decision": "no"})    # were a card shown, it is refused, never waited on
        with loaded(FakeServer("ollama"), []) as fake:
            out = harness.agent._handle_call(ToolCall("u1", "router_update", {"action": "add_system",
                                                                              "name": "Mac", "base_url": fake.url}))
            self.assertTrue(out.startswith("error: nothing is loaded on Mac now, so DGC didn't choose its models"),
                            out)
            self.assertIn("Ask the user which to use", out)
            self.assertIn("It serves: qwen3:8b, qwen3.6:35b-a3b-mlx, glm-5.3:cloud", out)
            self.assertFalse([f for f in harness.stream.frames() if f["type"] == "permission_request"])
            # Asked, the model names one: that one, and only that one.
            plan = T.plan_update(harness.config, {"action": "add_system", "name": "Mac", "base_url": fake.url,
                                                  "models": ["qwen3.6:35b-a3b-mlx"]})
        self.assertEqual([m["name"] for m in plan.after["systems"][0]["models"]], ["qwen3.6:35b-a3b-mlx"])

    def test_nothing_loaded_settings_adds_it_with_none_chosen_and_says_so(self):
        config = self.harness().config
        with loaded(FakeServer("ollama"), []) as fake:
            plan = T.plan_update(config, {"action": "add_system", "name": "Mac", "base_url": fake.url},
                                 pick_later=True)
        self.assertEqual(plan.after["systems"][0]["models"], [])
        self.assertIn("Nothing is loaded on Mac now, so DGC chose no model", plan.said())

    def test_a_server_that_serves_one_model_and_doesnt_say(self):
        self.assertEqual([m["name"] for m in T.suggest_models({"models": [{"name": "big-model"}]})], ["big-model"])
        self.assertEqual(T.suggest_models({"models": [{"name": "a"}, {"name": "b"}]}), [])
        self.assertEqual(T.suggest_models({"models": [{"name": "glm-5.3:cloud"}]}), [], "never a cloud model")

    def test_llama_server_vllm_and_friends_serve_what_they_loaded(self):
        for kind in ("llamacpp", "vllm"):
            with self.subTest(kind=kind), FakeServer(kind) as fake:
                found = router_probe.discover(fake.url, kind)
                self.assertEqual(len(T.suggest_models(found)), 1)

    def test_the_command_line_says_choose_with_models(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-router-qa-cli-"))
        (home / "project").mkdir()
        env = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")}
        env.update(HOME=str(home), PYTHONPATH=str(ROOT))
        with loaded(FakeServer("ollama"), []) as fake:
            added = subprocess.run([sys.executable, "-m", "dgc", "router", "add", fake.url, "--name", "Mac"],
                                   cwd=home / "project", env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(added.returncode, 1, added.stdout)
        self.assertIn("nothing is loaded on Mac now, so DGC didn't choose its models", added.stderr)
        self.assertIn("Choose with --models, e.g. --models qwen3:8b", added.stderr)
        config = home / ".dgc" / "config.json"
        self.assertFalse(config.exists() and json.loads(config.read_text()).get("router", {}).get("systems"),
                         "nothing was added")


class TestNeverLoadsUnasked(Case):
    def block(self, url, models):
        return {"enabled": True, "when_busy": "wait", "systems": [
            {"id": "mac", "name": "Mac", "base_url": url, "server": "ollama", "jobs": ["subagents"], "workers": 2,
             "models": [{"name": name, "workers": 1, "context": 16384, **({"use": False} if not use else {})}
                        for name, use in models]}]}

    def test_a_used_model_that_isnt_loaded_is_not_tested_and_says_why(self):
        with FakeServer("ollama") as fake:                  # qwen3:8b loaded
            config = self.harness(self.block(fake.url, [("qwen3:8b", True), ("qwen3.6:35b-a3b-mlx", True),
                                                        ("glm-5.3:cloud", True), ("llama3:70b", False)])).config
            router_state.save_discovery("mac", router_probe.discover(fake.url, "ollama"))
            result = T.probe(config, "mac", checks=["speed"])
            chatted = {r["json"]["model"] for r in fake.chats()}
        self.assertEqual(chatted, {"qwen3:8b", "glm-5.3:cloud"}, "the loaded one and the cloud one, never the rest")
        skipped = result["results"]["qwen3.6:35b-a3b-mlx"]
        self.assertTrue(skipped["not_loaded"])
        self.assertEqual(skipped["error"], "not loaded on Mac now: testing it would load it there (about 20 GB)")
        self.assertNotIn("llama3:70b", result["results"], "an unticked model is never tested")
        self.assertIn("- qwen3.6:35b-a3b-mlx: not loaded on Mac now: testing it would load it there (about 20 GB). "
                      "Not tested; dgc router test mac --model qwen3.6:35b-a3b-mlx loads it and tests it.",
                      T.probe_text(result, surface="cli"))
        self.assertIn("router_probe with this model loads it: ask the user first", T.probe_text(result))
        self.assertIn("/router test mac qwen3.6:35b-a3b-mlx loads it", T.probe_text(result, surface="tui"))

    def test_naming_the_model_tests_it(self):
        with FakeServer("ollama") as fake:
            config = self.harness(self.block(fake.url, [("qwen3.6:35b-a3b-mlx", True)])).config
            result = T.probe(config, "mac", model="qwen3.6:35b-a3b-mlx", checks=["speed"])
            self.assertEqual({r["json"]["model"] for r in fake.chats()}, {"qwen3.6:35b-a3b-mlx"})
        self.assertTrue(result["results"]["qwen3.6:35b-a3b-mlx"]["speed"]["ok"])


class StatusFoldsUnused(Case):
    def test_one_line_for_the_models_a_system_doesnt_use(self):
        block = {"enabled": True, "when_busy": "wait", "systems": [
            {"id": "box", "name": "Box", "base_url": "http://box.local:11434", "server": "ollama",
             "jobs": ["subagents"], "workers": 1,
             "models": [{"name": "qwen2.5:7b", "workers": 1, "context": 32768}]
             + [{"name": f"big-{n}:cloud", "workers": 1, "context": 32768, "use": False} for n in range(8)]}]}
        config = self.harness(block).config
        status = R.status(config)
        text = T.status_text(status)
        self.assertIn("  · qwen2.5:7b: 7B · context 32K · 1/1 free\n", text)
        self.assertIn("  · 8 more models not used\n", text + "\n")
        self.assertNotIn("big-0:cloud", text)
        self.assertNotIn("not for sub-agents: not used", text)
        self.assertIn("8 more models not used: big-0:cloud, big-1:cloud", T.status_text(status, unused_names=True),
                      "the model's router_status can still name one")
        self.assertEqual(len(status["systems"][0]["models"]), 9, "--json keeps every row")


class LookOnMyNetwork(unittest.TestCase):
    def test_the_question_names_exactly_the_ports_it_looks_on(self):
        source = (ROOT / "editors/vscode/src/settingsRouter.js").read_text()
        ports = re.search(r"const ROUTER_PORTS = '([^']+)'", source).group(1)
        self.assertEqual(tuple(int(p) for p in re.findall(r"\d+", ports)), router_probe.KNOWN_PORTS)
        self.assertIn("11434, 8080, 1234, 8000, 30000, 8188", T.SCHEMAS[3]["function"]["description"])


class SuggestWords(Case):
    def system(self, **extra):
        return {"enabled": True, "when_busy": "wait", "systems": [
            {"id": "nas", "name": "NAS", "base_url": "http://nas.local:11434", "server": "ollama", "jobs": ["pips"],
             "workers": 1, "models": [{"name": "qwen3.5:9b", "workers": 1, "context": 16384}], **extra}]}

    def measured(self):
        router_state.save_discovery("nas", {"models": [{"name": "qwen3.5:9b", "params_b": 9.7, "quant": "Q4_K_M"}]})
        router_state.save_probe("nas", "qwen3.5:9b", {"parallel": {"ok": True, "runs": 2, "context": 16384}})

    def test_each_surface_says_how_in_its_own_words(self):
        config = self.harness(self.system()).config
        self.measured()
        result = router_suggest.suggest(config, "nas")
        cli = router_suggest.text(result, surface="cli")
        self.assertIn("Apply it: dgc router suggest nas --apply", cli)
        self.assertIn("Give it: dgc router hardware nas ADDRESS, or dgc router edit nas --memory-gb N.", cli)
        tool = router_suggest.text(result)
        self.assertIn("Apply it with router_update apply_suggestion.", tool)
        for words in (" ".join(result["notes"]), " ".join(plan["line"] for plan in result["models"])):
            self.assertNotIn("memory_gb", words, "Settings draws these: no internal names")
            self.assertNotIn("router_update", words)
            self.assertNotIn("dgc router hardware", words)
        self.assertNotIn("router_update", cli)

    def test_the_memory_typed_in_is_named_in_words(self):
        config = self.harness(self.system(memory_gb=16)).config
        self.measured()
        result = router_suggest.suggest(config, "nas")
        self.assertIn("Memory: 16 GB, from the memory set for it.", result["notes"])

    def test_after_apply_it_says_what_was_applied(self):
        config = self.harness(self.system()).config
        self.measured()
        plan = T.plan_update(config, {"action": "apply_suggestion", "system": "nas"})
        self.assertEqual(plan.summary, "Use the suggestion for NAS: qwen3.5:9b · 2 workers at 16K")
        T.apply_plan(config, plan)
        self.assertEqual(plan.said(), "Applied: NAS · qwen3.5:9b · 2 workers at 16K.")
        self.assertEqual(config.data["router"]["systems"][0]["workers"], 2)


class MainTurnHold(Case):
    def block(self):
        return {"enabled": True, "when_busy": "wait", "systems": [
            {"id": "gb", "name": "GB", "base_url": "http://gpu-box.local:11434", "server": "ollama",
             "jobs": ["subagents"], "workers": 1,
             "models": [{"name": "glm-5.3:cloud", "workers": 1, "context": 32768}]}]}

    def test_a_cloud_main_model_holds_no_worker_there(self):
        harness = self.harness(self.block(), base_url="http://gpu-box.local:11434/v1", model="deepseek-v4.1-flash:cloud")
        self.assertIsNone(R.hold_main(harness.agent))
        got, why = self.router.acquire(harness.config, "subagents", system="gb", wait=False)
        self.assertIsNotNone(got, why)

    def test_a_model_discovery_found_to_be_cloud_holds_none_either(self):
        harness = self.harness(self.block(), base_url="http://gpu-box.local:11434/v1", model="gpt-oss:120b")
        router_state.save_discovery("gb", {"models": [{"name": "gpt-oss:120b", "cloud": True}]})
        self.assertIsNone(R.hold_main(harness.agent))

    def test_a_local_main_model_still_holds_one(self):
        harness = self.harness(self.block(), base_url="http://gpu-box.local:11434/v1", model="qwen3.8:27b")
        lease = R.hold_main(harness.agent)
        self.assertTrue(lease)
        self.assertEqual(self.router.acquire(harness.config, "subagents", system="gb", wait=False), (None, "busy"))
        R.release_main(lease)


class PipsDefaultWords(unittest.TestCase):
    """`dgc pips models` with Settings -> Pips run on the Router says where a Pip on Default runs."""

    def listing(self, pin):
        return {"default_model": "deepseek-v4.1-flash:cloud", "models": [{"id": "m", "name": "m"}],
                "router": {"enabled": True, "pips_default": pin, "systems": [
                    {"id": "nas", "name": "NAS", "online": True, "models": [{"name": "qwen3.5:9b"}]}]}}

    def test_any_pip_system_or_one(self):
        from dgc import pip_cli
        self.assertEqual(pip_cli._format(self.listing("router")).splitlines()[0],
                         "Pips on Default run on: DGC Router · any Pip system")
        self.assertEqual(pip_cli._format(self.listing("router:nas/qwen3.5:9b")).splitlines()[0],
                         "Pips on Default run on: NAS · qwen3.5:9b")
        plain = self.listing("")
        self.assertEqual(pip_cli._format(plain).splitlines()[0], "DGC default: deepseek-v4.1-flash:cloud")


class SettingsOnTheWire(unittest.TestCase):
    """A real `dgc serve`: Settings' Add of a server with nothing loaded adds it with none chosen and says so, and
    Apply says what was applied."""

    def test_add_with_nothing_loaded_and_apply(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-router-qa-wire-"))
        project = home / "project"
        project.mkdir()
        (project / ".git").mkdir()
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({"base_url": "http://127.0.0.1:9/v1", "model": "m",
                                                               "pips_enabled": False}))
        env = {key: value for key, value in os.environ.items() if not key.startswith("DGC_")}
        env.update(HOME=str(home), PYTHONPATH=str(ROOT))
        fake = loaded(FakeServer("ollama"), [])
        self.addCleanup(fake.close)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=project, env=env, stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

        def send(command):
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def until(predicate, timeout=60):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                line = proc.stdout.readline()
                if not line:
                    break
                event = json.loads(line)
                if predicate(event):
                    return event
            self.fail("no matching event")
        try:
            until(lambda e: e["type"] == "ready")
            send({"type": "router_update", "request_id": "a1", "action": "add_system", "base_url": fake.url,
                  "name": "Mac"})
            added = until(lambda e: e.get("request_id") == "a1")
            self.assertEqual(added["type"], "router_status", added)
            self.assertIn("Nothing is loaded on Mac now, so DGC chose no model", added["change"])
            row = next(s for s in added["status"]["systems"] if s["id"] == "mac")
            self.assertEqual(row["models"], [])
            self.assertIn("qwen3:8b", [m["name"] for m in row["available"]], "the form offers what it serves")
        finally:
            send({"type": "shutdown"})
            try:
                proc.wait(timeout=20)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
            proc.stdin.close()
            proc.stdout.close()


if __name__ == "__main__":
    unittest.main()
