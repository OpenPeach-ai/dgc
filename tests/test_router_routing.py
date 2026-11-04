"""DGC Router: worker leases (one process and several), routing a sub-agent, and moving it when its system fails.

With the Router off, a sub-agent's route, the system prompt and the `task` tool are exactly 0.50's.
"""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_subagents import Harness, clone_fixture  # noqa: E402

from dgc import router as R  # noqa: E402
from dgc import router_state  # noqa: E402
from dgc.agent import Agent, _SubUI  # noqa: E402
from dgc.agents import AgentDef  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.llm import ChatResult, LLMClient, LLMError, ToolCall  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]


def system(id, base_url, models, *, workers=None, jobs=("subagents", "pips"), one=False, server="ollama", **extra):
    return {"id": id, "name": extra.pop("name", id.upper()), "base_url": base_url, "server": server,
            "jobs": list(jobs), "workers": workers or max(m.get("workers", 1) for m in models),
            "one_model_at_a_time": one, "models": models, **extra}


def model(name, workers=1, context=16384, **extra):
    return {"name": name, "workers": workers, "context": context, **extra}


class RouterCase(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp(prefix="dgc-router-routing-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.home)})
        env.start()
        self.addCleanup(env.stop)
        self.router = R.Router()
        # Leases a test still holds are given back while DGC_HOME is still its own: otherwise this Router's heartbeat
        # thread writes them into the process's real HOME once the patch is gone.
        self.addCleanup(lambda: [self.router.release(lease["id"]) for lease in self.router.held()])
        swap = patch.object(R, "ROUTER", self.router)
        swap.start()
        self.addCleanup(swap.stop)
        # No health thread or network in these tests unless one asks for it.
        quiet = patch.object(R.Router, "ensure_health", lambda self, config: None)
        quiet.start()
        self.addCleanup(quiet.stop)

    def config(self, block=None, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-router-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), **data)
        self.addCleanup(harness.close)
        if block is not None:
            harness.config.data["router"] = block
        self.harness = harness
        return harness.config


class RouterOffIs050(RouterCase):
    """Off (or never set up), every route, prompt and schema is what 0.50 had."""

    def test_the_sub_agent_route_is_unchanged(self):
        plain = self.config()
        off = Config.router_block(plain)
        self.assertFalse(off["enabled"])
        agent = self.harness.agent
        self.assertIsNone(agent._subagent_client(None))
        self.assertIsNone(agent._subagent_client(None, lease_for="sub-1", hint={"system": "nas"}))
        self.config({"enabled": False, "systems": [system("nas", "http://nas.local:11434", [model("qwen3:8b")])]})
        agent = self.harness.agent
        self.assertIsNone(agent._subagent_client(None, lease_for="sub-1"))
        self.assertEqual(router_state.read("leases"), {}, "nothing was leased")
        routed = self.config({"enabled": False, "systems": [system("nas", "http://nas.local:11434",
                                                                       [model("qwen3:8b")])]},
                             subagent_model="sub-model", subagent_base_url="http://gpu:11434/v1")
        client = self.harness.agent._subagent_client(None, lease_for="sub-1")
        self.assertEqual((client.base_url, client.model), ("http://gpu:11434/v1", "sub-model"))
        self.assertIsNone(getattr(client, "_router_route", None))
        self.assertTrue(routed)

    def test_the_prompt_and_the_task_schema_are_unchanged(self):
        self.config()
        before_prompt = self.harness.agent.system_prompt()
        before_task = next(t for t in self.harness.agent._tool_schemas() if t["function"]["name"] == "task")
        self.harness.config.data["router"] = {"enabled": False, "systems": [
            system("nas", "http://nas.local:11434", [model("qwen3:8b")])]}
        after_prompt = self.harness.agent.system_prompt()
        after_task = next(t for t in self.harness.agent._tool_schemas() if t["function"]["name"] == "task")
        self.assertEqual(before_prompt, after_prompt)
        self.assertNotIn("DGC Router", after_prompt)
        self.assertEqual(before_task, after_task)

    def test_a_task_naming_a_system_runs_as_before_and_says_so(self):
        self.config()
        agent = self.harness.agent
        self.assertEqual(R.task_hint_error(agent.config, {"prompt": "x", "system": "nas"}), "")
        self.assertIsNone(agent._subagent_client(None, lease_for="sub-9", hint={"system": "nas"}))
        self.assertIn("DGC Router is off", R.result_note(agent, "sub-9"))


class Leases(RouterCase):
    def block(self, **kwargs):
        return {"enabled": True, "when_busy": kwargs.pop("when_busy", "wait"), "systems": kwargs.pop("systems")}

    def test_system_and_model_ceilings(self):
        config = self.config(self.block(systems=[
            system("box", "http://box.local:11434", [model("big", workers=1), model("small", workers=3)], workers=3)]))
        a, _ = self.router.acquire(config, "subagents", model="big", wait=False)
        b, why = self.router.acquire(config, "subagents", model="big", wait=False)
        self.assertIsNotNone(a)
        self.assertEqual((b, why), (None, "busy"), "big takes one worker at a time")
        c, _ = self.router.acquire(config, "subagents", model="small", wait=False)
        d, _ = self.router.acquire(config, "subagents", model="small", wait=False)
        e, why = self.router.acquire(config, "subagents", model="small", wait=False)
        self.assertTrue(c and d)
        self.assertEqual((e, why), (None, "busy"), "the system holds three in all")
        self.router.release(a)
        f, _ = self.router.acquire(config, "subagents", model="small", wait=False)
        self.assertIsNotNone(f)
        self.assertEqual(len(self.router.leases()), 3)

    def test_one_model_at_a_time_never_mixes_models(self):
        config = self.config(self.block(systems=[
            system("mac", "http://mac.local:11434", [model("a", workers=2), model("b", workers=2)], workers=4, one=True)]))
        first, _ = self.router.acquire(config, "subagents", model="a", wait=False)
        other, why = self.router.acquire(config, "subagents", model="b", wait=False)
        self.assertEqual((other, why), (None, "busy"))
        same, _ = self.router.acquire(config, "subagents", model="a", wait=False)
        self.assertIsNotNone(same)
        self.router.release(first)
        self.router.release(same)
        switched, _ = self.router.acquire(config, "subagents", model="b", wait=False)
        self.assertIsNotNone(switched, "idle again, it may switch")

    def test_a_dead_process_lease_is_dropped_and_a_stale_one_expires(self):
        config = self.config(self.block(systems=[system("nas", "http://nas.local:11434", [model("m")])]))
        dead = subprocess.Popen([sys.executable, "-c", "pass"])
        dead.wait()
        router_state.write("leases", {"leases": [{"id": "x1", "system": "nas", "model": "m", "pid": dead.pid,
                                                  "heartbeat": time.time(), "started": time.time()}]})
        got, _ = self.router.acquire(config, "subagents", wait=False)
        self.assertIsNotNone(got, "a dead PID's lease is gone at once")
        self.router.release(got)
        alive = os.getppid()
        router_state.write("leases", {"leases": [{"id": "x2", "system": "nas", "model": "m", "pid": alive,
                                                  "heartbeat": time.time() - 5, "started": time.time()}]})
        busy, why = self.router.acquire(config, "subagents", wait=False)
        self.assertEqual((busy, why), (None, "busy"), "a live process's recent lease stands")
        router_state.write("leases", {"leases": [{"id": "x3", "system": "nas", "model": "m", "pid": alive,
                                                  "heartbeat": time.time() - R.LEASE_STALE_S - 1,
                                                  "started": time.time()}]})
        got, _ = self.router.acquire(config, "subagents", wait=False)
        self.assertIsNotNone(got, "no heartbeat for 30 s: the lease expired")

    def test_waiting_for_a_worker_and_the_default_route(self):
        config = self.config(self.block(systems=[system("nas", "http://nas.local:11434", [model("m")])]))
        held, _ = self.router.acquire(config, "subagents")
        threading.Timer(0.6, lambda: self.router.release(held)).start()
        started = time.monotonic()
        waited, why = self.router.acquire(config, "subagents")
        self.assertIsNotNone(waited, why)
        self.assertGreaterEqual(time.monotonic() - started, 0.5)
        self.assertGreaterEqual(waited.waited_s, 0.5)
        cancel = threading.Event()
        threading.Timer(0.3, cancel.set).start()
        self.assertEqual(self.router.acquire(config, "subagents", cancel=cancel), (None, "cancelled"))
        config.data["router"]["when_busy"] = "default"
        self.assertEqual(self.router.acquire(config, "subagents"), (None, "busy"))
        agent = self.harness.agent
        self.assertIsNone(agent._subagent_client(None, lease_for="sub-2"))
        self.assertIn("every worker was busy", R.result_note(agent, "sub-2"))

    def test_choice_by_name_size_speed_and_tools(self):
        config = self.config(self.block(systems=[
            system("nas", "http://nas.local:11434", [model("qwen3:4b", workers=2), model("dumb:3b", tools=False)]),
            system("gpu", "http://gpu-box.local:11434", [model("qwen3.8:32b"), model("qwen3:8b", workers=2)],
                   workers=3),
            system("pips", "http://pips.local:11434", [model("qwen3:1.7b")], jobs=("pips",))]))
        large, _ = self.router.acquire(config, "subagents", size="large", wait=False)
        self.assertEqual((large.system_id, large.model), ("gpu", "qwen3.8:32b"))
        small, _ = self.router.acquire(config, "subagents", size="small", wait=False)
        self.assertEqual(small.model, "qwen3:4b")
        named, _ = self.router.acquire(config, "subagents", system="GPU", wait=False)
        self.assertEqual(named.system_id, "gpu", "a system's name is as good as its id")
        router_state.save_probe("nas", "qwen3:4b", {"speed": {"ok": True, "tokens_per_s": 10.0}})
        router_state.save_probe("gpu", "qwen3:8b", {"speed": {"ok": True, "tokens_per_s": 90.0}})
        self.router.release(small)
        fast, _ = self.router.acquire(config, "subagents", size="small", wait=False)
        self.assertEqual(fast.model, "qwen3:8b", "the faster of two small models")
        names = {(s["id"], m["name"]) for s, m, _f in self.router.candidates(config, "subagents")}
        self.assertNotIn(("nas", "dumb:3b"), names, "a model that can't call tools never gets sub-agent work")
        self.assertNotIn(("pips", "qwen3:1.7b"), names, "a system without the sub-agents job")
        self.assertIn(("nas", "dumb:3b"), {(s["id"], m["name"]) for s, m, _f in self.router.candidates(config, "pips")})
        with self.assertRaises(R.RouteRefused):
            self.router.candidates(config, "subagents", system="mars")
        self.assertIn("no system named", R.task_hint_error(config, {"prompt": "x", "system": "mars"}))
        self.assertIn("no system with the model",
                      R.task_hint_error(config, {"tasks": [{"description": "a", "prompt": "b", "model": "nope"}]}))
        self.assertEqual(R.task_hint_error(config, {"prompt": "x", "system": "nas"}), "")

    def test_an_offline_system_is_skipped(self):
        config = self.config(self.block(systems=[
            system("mac", "http://mac.local:11434", [model("m")]), system("nas", "http://nas.local:11434", [model("m")])]))
        for _ in range(R.OFFLINE_AFTER):
            self.router.record_health("mac", False, 0, "connection refused")
        self.assertTrue(self.router.offline("mac"))
        got, _ = self.router.acquire(config, "subagents", wait=False)
        self.assertEqual(got.system_id, "nas")
        self.assertIn("mac offline", R.prompt_line(config))
        self.router.record_health("mac", True, 4)
        self.assertFalse(self.router.offline("mac"))

    def test_two_processes_never_oversubscribe(self):
        config = self.config(self.block(systems=[system("box", "http://box.local:11434", [model("m", workers=3)])]))
        block_path = self.home / "block.json"
        block_path.write_text(json.dumps(config.data["router"]))
        script = (
            "import json, os, sys, time\n"
            "from dgc import router as R\n"
            "from dgc.config import validate_router\n"
            "block = validate_router(json.load(open(sys.argv[1])))[0]\n"
            "class C:\n"
            "    def router_block(self): return block\n"
            "    def router_key(self, i): return ''\n"
            "R.Router.ensure_health = lambda self, c: None\n"
            "got = []\n"
            "deadline = time.time() + 2.0\n"
            "while time.time() < deadline:\n"
            "    route, why = R.ROUTER.acquire(C(), 'subagents', wait=False)\n"
            "    if route: got.append(route)\n"
            "    time.sleep(0.01)\n"
            "    if len(got) > 1: R.ROUTER.release(got.pop(0))\n"
            "print(len(R.ROUTER.leases()))\n")
        env = {**os.environ, "DGC_HOME": str(self.home), "PYTHONPATH": str(ROOT)}
        peak = []
        stop = threading.Event()

        def watch():
            while not stop.is_set():
                peak.append(len(router_state.read("leases").get("leases") or []))
                time.sleep(0.005)
        watcher = threading.Thread(target=watch, daemon=True)
        watcher.start()
        procs = [subprocess.Popen([sys.executable, "-c", script, str(block_path)], env=env, stdout=subprocess.PIPE,
                                  text=True) for _ in range(3)]
        outs = [p.communicate(timeout=60)[0] for p in procs]
        stop.set()
        watcher.join()
        self.assertTrue(all(p.returncode == 0 for p in procs), outs)
        self.assertLessEqual(max(peak), 3, "three DGC processes on a three-worker system never hold more than three")
        self.assertGreater(max(peak), 1, "they did contend")
        self.assertEqual(self.router.leases(), [], "every process's leases ended with it")


class Routing(RouterCase):
    def setUp(self):
        super().setUp()
        self.block = {"enabled": True, "when_busy": "wait", "systems": [
            system("nas", "http://nas.local:11434", [model("qwen3.5:9b", context=16384)], name="NAS"),
            system("mini", "http://mini.local:8080", [model("qwen2.5:7b", context=8192)], server="llamacpp",
                   name="Mini PC")]}

    def test_a_sub_agent_gets_the_workers_route_and_its_fixed_context(self):
        config = self.config(copy.deepcopy(self.block))
        router_state.save_discovery("nas", {"models": [{"name": "qwen3.5:9b", "pinned": True, "params_b": 9.7}]})
        client = self.harness.agent._subagent_client(None, lease_for="sub-1", hint={"system": "nas"})
        route = client._router_route
        self.assertEqual((client.base_url, client.model, client.api_mode), ("http://nas.local:11434/v1",
                                                                            "qwen3.5:9b", "ollama"))
        self.assertEqual(client.context_size, 16384)
        self.assertEqual(client.keep_alive, -1, "a model the server keeps loaded stays loaded")
        self.assertEqual(route.system_name, "NAS")
        other = self.harness.agent._subagent_client(None, lease_for="sub-2", hint={"system": "mini"})
        self.assertEqual((other.base_url, other.api_mode, other.context_size),
                         ("http://mini.local:8080/v1", "chat_completions", 8192))
        self.assertEqual(other.keep_alive, "", "another computer's own keep-alive applies, not this one's")
        self.assertEqual(len(self.router.leases()), 2)
        R.release_agent(type("Child", (), {"client": client})())
        self.assertEqual(len(self.router.leases()), 1)
        self.assertTrue(config)

    def test_an_agent_definition_with_its_own_model_still_wins(self):
        self.config(copy.deepcopy(self.block))
        adef = AgentDef(name="r", description="", body="", model="def-model", base_url="http://def:1/v1")
        client = self.harness.agent._subagent_client(adef, lease_for="sub-1")
        self.assertEqual((client.model, client.base_url), ("def-model", "http://def:1/v1"))
        self.assertEqual(self.router.leases(), [])

    def test_the_child_runs_on_its_worker_with_its_context_and_gives_it_back(self):
        self.config(copy.deepcopy(self.block), context_size=65536)
        seen = {}

        def run_child(child, prompt):
            seen.update(config=child.config.get("context_size"), client=child.client.context_size,
                        model=child.client.model, url=child.client.base_url, window=child.context_size(),
                        leases=len(self.router.leases()))
            child.ui.on_text("Looked.")
            child.ui.end_stream()
            return True
        agent = self.harness.agent
        agent._router_hints = {"call-1": {"system": "mini"}}
        with patch.object(Config, "clone_for_root", clone_fixture), patch.object(Agent, "run_turn", run_child):
            failure, result, start = agent._execute_prepared_subagent(
                "look", "Look around.", "", None, _SubUI(self.harness.ui, "look", cancel=agent.cancelled), "call-1")
        self.assertEqual((failure, start), ("", ""))
        self.assertEqual(seen, {"config": 8192, "client": 8192, "model": "qwen2.5:7b",
                                "url": "http://mini.local:8080/v1", "window": 8192, "leases": 1})
        self.assertIn("DGC Router: ran on Mini PC (qwen2.5:7b)", result)
        self.assertEqual(self.router.leases(), [], "its worker was given back")
        self.assertEqual(agent.config.get("context_size"), 65536, "the main window is untouched")

    def test_a_busy_worker_names_the_helpers_job_and_keeps_its_id_for_json(self):
        from dgc import router_tools
        self.config(copy.deepcopy(self.block))
        seen = {}

        def run_child(child, prompt):
            status = R.status(child.config)
            nas = next(s for s in status["systems"] if s["id"] == "mini")
            seen.update(lease=nas["leases"][0], text=router_tools.status_text(status))
            child.ui.on_text("Counted.")
            child.ui.end_stream()
            return True
        agent = self.harness.agent
        agent._router_hints = {"call-1": {"system": "mini"}}
        with patch.object(Config, "clone_for_root", clone_fixture), patch.object(Agent, "run_turn", run_child):
            agent._execute_prepared_subagent("count bolts", "Count the bolts.", "", None,
                                             _SubUI(self.harness.ui, "count bolts", cancel=agent.cancelled), "call-1")
        self.assertIn("busy: qwen2.5:7b for count bolts", seen["text"])
        self.assertNotRegex(seen["text"], r"sub-[0-9a-f]{6,}|call-1", "never an internal id")
        self.assertEqual(seen["lease"]["label"], "count bolts")
        self.assertTrue(seen["lease"]["owner"], "the id stays in the status for --json and the agent map")
        self.assertNotEqual(seen["lease"]["owner"], "count bolts")

    def test_a_lease_without_a_label_says_what_kind_of_job_it_is(self):
        self.assertEqual(R.lease_label({"owner": "sub-423ad447a0ed", "job": "subagents"}), "a helper")
        self.assertEqual(R.lease_label({"owner": "main turn", "job": "main"}), "the main chat")
        self.assertEqual(R.lease_label({"owner": "Pip run run_1", "job": "pips"}), "a Pip run")
        self.assertEqual(R.lease_label({"owner": "probe", "job": ""}), "a test")

    def test_hints_follow_each_helper_of_a_batch(self):
        self.config(copy.deepcopy(self.block))
        agent = self.harness.agent
        agent._note_router_hints([ToolCall("c1", "task", {"size": "small", "tasks": [
            {"description": "a", "prompt": "a", "system": "nas"}, {"description": "b", "prompt": "b"}]}),
            ToolCall("c2", "task", {"description": "c", "prompt": "c", "model": "qwen2.5:7b"}),
            ToolCall("c3", "read_file", {"path": "x"})])
        self.assertEqual(agent._router_hint("c1#1"), {"size": "small", "system": "nas"})
        self.assertEqual(agent._router_hint("c1#2"), {"size": "small"})
        self.assertEqual(agent._router_hint("c2"), {"model": "qwen2.5:7b"})
        self.assertEqual(agent._router_hint("c3"), {})

    def test_an_sdk_runs_system_is_its_helpers_default_and_the_turn_clears_it(self):
        self.config(copy.deepcopy(self.block))
        agent = self.harness.agent
        agent._router_prefer = {"system": "mini", "model": ""}
        agent._router_hints = {"c1": {"system": "nas"}, "c2": {"size": "small"}}
        self.assertEqual(agent._router_hint("c1"), {"system": "nas"}, "the model's own choice still wins")
        self.assertEqual(agent._router_hint("c2"), {"size": "small", "system": "mini"})
        self.assertEqual(agent._router_hint("c3"), {"system": "mini"})
        with patch.object(Agent, "_run_goal_steps", lambda self, text, run: True):
            agent.run_turn("hello")
        self.assertIsNone(agent._router_prefer)

    def test_ultras_background_helpers_route_the_same_way(self):
        """DGC Ultra's proactive fan-out: a batch of background helpers, each placed on its own system."""
        self.config(copy.deepcopy(self.block), ultra_mode=True)
        agent = self.harness.agent
        seen = {}

        def run_child(child, prompt):
            seen[prompt[-1]] = (child.client._router_route.system_id, child.config.get("context_size"))
            child.ui.on_text("Done.")
            child.ui.end_stream()
            return True
        call = ToolCall("c9", "task", {"tasks": [{"description": "a", "prompt": "look at a", "system": "nas"},
                                                 {"description": "b", "prompt": "look at b", "system": "mini"}]})
        agent._normalize_ultra_task_batch([call])
        self.assertTrue(call.arguments["background"], "Ultra runs an omitted-background batch in the background")
        agent._note_router_hints([call])
        with patch.object(Config, "clone_for_root", clone_fixture), patch.object(Agent, "run_turn", run_child):
            agent._run_task_batch(call.arguments, "c9")
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and (len(seen) < 2 or agent._detached_jobs):
                time.sleep(0.05)
        self.assertEqual(seen, {"a": ("nas", 16384), "b": ("mini", 8192)})
        self.assertEqual(self.router.leases(), [])

    def test_while_on_the_prompt_lists_systems_and_the_task_schema_names_them(self):
        self.config(copy.deepcopy(self.block))
        prompt = self.harness.agent.system_prompt()
        self.assertIn("Systems: nas qwen3.5:9b 1/1 · mini qwen2.5:7b 1/1", prompt)
        self.assertIn("Small models suit search", prompt)
        task = next(t for t in self.harness.agent._tool_schemas() if t["function"]["name"] == "task")
        self.assertIn("nas (qwen3.5:9b); mini (qwen2.5:7b)", task["function"]["parameters"]["properties"]["system"]
                      ["description"])

    def test_the_main_turn_holds_a_worker_on_its_own_system(self):
        self.config(copy.deepcopy(self.block), base_url="http://nas.local:11434/v1", model="qwen3.5:9b")
        lease = R.hold_main(self.harness.agent)
        self.assertTrue(lease)
        self.assertEqual(self.router.acquire(self.harness.config, "subagents", system="nas", wait=False),
                         (None, "busy"))
        self.assertIn("nas qwen3.5:9b 1/1", R.prompt_line(self.harness.config),
                      "the turn's own hold does not change the prompt from turn to turn")
        R.release_main(lease)
        got, _ = self.router.acquire(self.harness.config, "subagents", system="nas", wait=False)
        self.assertIsNotNone(got)

    def delegate(self, task):
        """A whole main turn on the system's own model that runs one helper, with when_busy = wait: what the helper and
        the main model's requests saw of the leases. Fails, instead of hanging, when the turn waits on itself."""
        from test_subagents import Script, child
        seen = {"main": [], "child": []}
        jobs = lambda: sorted((lease["job"], lease["model"]) for lease in self.router.leases())

        def main(messages, results, cancel):
            seen["main"].append(jobs())
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {"description": "look around", **task})])
            return ChatResult(content="done")
        helper = child()

        def run_child(messages, results, cancel):
            seen["child"].append(jobs())
            return helper(messages, results, cancel)
        agent, outcome = self.harness.agent, []
        # Nothing leaves this process: the scripted replies answer every request, and no model's metadata is fetched.
        with patch.object(LLMClient, "chat", Script([("CHILD", run_child), ("go", main)])), \
                patch.object(LLMClient, "prepare_model", lambda self, **kwargs: {}), \
                patch.object(Config, "clone_for_root", clone_fixture):
            turn = threading.Thread(target=lambda: outcome.append(agent.run_turn("go")), daemon=True)
            turn.start()
            turn.join(20)
            stuck = turn.is_alive()
            if stuck:
                agent.cancelled.set()             # what Stop would do; the turn then ends
                turn.join(10)
        self.assertFalse(stuck, f"the turn waited on its own worker: {seen}")
        self.assertEqual(outcome, [True])
        self.assertEqual(self.router.leases(), [], "every worker was given back")
        return seen

    def test_a_turn_that_delegates_on_a_one_worker_system_lends_its_worker_to_the_helper(self):
        """The main model is idle while its helper works: its worker is free for that helper (holding it, the helper
        waited for the turn and the turn for the helper), and the main model takes it back for its next request."""
        self.config({"enabled": True, "when_busy": "wait", "systems": [
            system("box", "http://box.invalid:11434", [model("qwen3.5:9b")], workers=1, jobs=("subagents",))]},
            base_url="http://box.invalid:11434/v1", model="qwen3.5:9b")
        seen = self.delegate({"prompt": "CHILD look"})
        self.assertEqual(seen["main"][0], [("main", "qwen3.5:9b")], "the main model holds its worker while it answers")
        self.assertTrue(seen["child"])
        self.assertEqual(set(map(tuple, seen["child"])), {(("subagents", "qwen3.5:9b"),)},
                         "the helper ran on that worker, with no main hold beside it")
        self.assertEqual(seen["main"][-1], [("main", "qwen3.5:9b")], "and the main model took it back")

    def test_a_one_model_system_runs_the_helpers_other_model_while_the_main_model_waits(self):
        self.config({"enabled": True, "when_busy": "wait", "systems": [
            system("mac", "http://mac.invalid:11434", [model("big"), model("small")], workers=2, one=True,
                   jobs=("subagents",))]},
            base_url="http://mac.invalid:11434/v1", model="big")
        seen = self.delegate({"prompt": "CHILD look", "model": "small"})
        self.assertEqual(seen["main"][0], [("main", "big")])
        self.assertEqual(set(map(tuple, seen["child"])), {(("subagents", "small"),)})
        self.assertEqual(seen["main"][-1], [("main", "big")])


class Moving(RouterCase):
    """A system that fails mid-task: after the stall retries, the sub-agent moves, and its result says so."""

    def setUp(self):
        super().setUp()
        self.block = {"enabled": True, "when_busy": "wait", "systems": [
            system("mac", "http://mac.local:11434", [model("qwen3.6:35b-a3b", context=32768)], name="Mac"),
            system("mini", "http://mini.local:11434", [model("qwen3.6:35b-a3b", context=32768)], name="Mini PC"),
            system("nas", "http://nas.local:11434", [model("qwen3.5:9b", context=16384)], name="NAS")]}

    def test_it_moves_to_the_same_model_first(self):
        self.config(copy.deepcopy(self.block))
        calls = []

        def chat(client, messages, tools=None, **kwargs):
            calls.append(client.base_url)
            if client.base_url.startswith("http://mac.local"):
                raise LLMError("connection: [Errno 111] Connection refused")
            kwargs.get("on_text") and kwargs["on_text"]("Done on the other box.")
            return ChatResult(content="Done on the other box.")
        agent = self.harness.agent
        agent._router_hints = {"call-1": {"system": "mac"}}
        with patch.object(Config, "clone_for_root", clone_fixture), \
                patch.object(LLMClient, "chat", lambda self, *a, **k: chat(self, *a, **k)):
            failure, result, start = agent._execute_prepared_subagent(
                "work", "Do the work.", "", None, _SubUI(self.harness.ui, "work", cancel=agent.cancelled), "call-1")
        self.assertEqual((failure, start), ("", ""), result)
        self.assertEqual(calls, ["http://mac.local:11434/v1", "http://mini.local:11434/v1"])
        self.assertIn("Done on the other box.", result)
        self.assertIn("Moved from Mac (qwen3.6:35b-a3b) to Mini PC (qwen3.6:35b-a3b) after it failed", result)
        self.assertEqual(self.router.leases(), [])
        self.assertEqual(self.router.health("mac")["misses"], 1)

    def test_with_no_same_model_left_a_compatible_one_takes_it(self):
        block = copy.deepcopy(self.block)
        block["systems"][1]["enabled"] = False
        self.config(block)
        agent = self.harness.agent
        client = agent._subagent_client(None, lease_for="sub-1", hint={"system": "mac"})
        child = type("Child", (), {})()
        child.client, child.config, child.cancelled = client, clone_fixture(agent.config, agent.config.project_root), None
        moved = R.move(child, "connection refused")
        self.assertEqual((moved._router_route.system_id, moved.model), ("nas", "qwen3.5:9b"))
        self.assertEqual(child.config.data["context_size"], 16384, "compaction follows the new worker's context")
        child.client = moved
        self.assertIn("to NAS (qwen3.5:9b)", R.child_note(child))

    def test_when_nowhere_else_can_take_it_the_task_fails_with_the_reason(self):
        block = copy.deepcopy(self.block)
        block["systems"] = block["systems"][:1]
        self.config(block)

        def chat(client, messages, tools=None, **kwargs):
            raise LLMError("connection: [Errno 111] Connection refused")
        agent = self.harness.agent
        with patch.object(Config, "clone_for_root", clone_fixture), \
                patch.object(LLMClient, "chat", lambda self, *a, **k: chat(self, *a, **k)):
            failure, _result, _start = agent._execute_prepared_subagent(
                "work", "Do the work.", "", None, _SubUI(self.harness.ui, "work", cancel=agent.cancelled), "call-1")
        self.assertIn("Mac failed", failure)
        self.assertIn("no other system could take the work", failure)
        self.assertEqual(self.router.leases(), [])


if __name__ == "__main__":
    unittest.main()
