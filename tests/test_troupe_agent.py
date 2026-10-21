"""Troupe inside the Agent and the editor backend (dgc/troupe_agent.py): when the tool is offered, what each kind of
agent may do, the wake when a run ends (and no wake in a chat that was replaced), stopping, a writing agent's change
merged from its own checkout, and the editor's events checked against the protocol. Sub-agents are stood in for at
Agent._execute_prepared_subagent, the one seam every troupe agent goes through; the merge is the real one."""
from __future__ import annotations

import copy
import io
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

PROJECT = Path(__file__).resolve().parents[1]
for path in (PROJECT,):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))

if "dgc.config" not in sys.modules:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-troupe-agent-home-")
    os.environ["HOME"] = os.path.realpath(_HOME.name)
    os.environ.pop("XDG_CONFIG_HOME", None)

from dgc import config as config_module, editor_protocol as ep, troupe, troupe_agent  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.permissions import PermissionEngine  # noqa: E402
from dgc.config import DEFAULTS, Config  # noqa: E402


class _QuietUI:
    # A `dgc -p --mode auto` run: nobody can answer a question, so the agent never offers one.
    non_interactive = True

    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


def _isolated_config(root: Path) -> Config:
    """A Config that never reads or writes the real ~/.dgc: an auto-mode native-Ollama profile."""
    config = object.__new__(Config)
    config.project_root = root
    config.project_dir = root / ".dgc"
    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update({
        "base_url": "http://127.0.0.1:11434", "api_key": "placeholder", "model": "qwen3.8:27b-q4km",
        "api_mode": "ollama", "mode": "auto", "thinking": "off", "suggest": False,
        "logo_animation": False, "artifact_autostart": False, "background": "inherit",
        "show_reasoning": False, "max_turns": 40, "context_size": 32_768, "turn_budget_s": 585,
        "verify_before_done": True, "verify_command": "pytest -q", "request_timeout": 300,
        "mcp_servers": {}, "hooks": {},
    })
    config._stored_secrets = {}
    config._env_secret_keys = set()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


def git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


class Recorder:
    """A UI that records troupe events and answers nothing (an editor-like, interactive one)."""
    non_interactive = False

    def __init__(self):
        self.events = []

    def troupe_event(self, kind, fields):
        self.events.append((kind, json.loads(json.dumps(fields))))

    def __getattr__(self, _name):
        return lambda *args, **kwargs: None


class AgentCase(unittest.TestCase):
    def make_agent(self, *, ultra=True, mode="auto", ui=None, git_repo=False):
        root = Path(tempfile.mkdtemp(prefix="dgc-troupe-agent-")).resolve()
        if git_repo:
            git("init", "-q", ".", cwd=root)
            git("config", "user.email", "t@t", cwd=root)
            git("config", "user.name", "t", cwd=root)
            (root / "a.txt").write_text("one\n")
            (root / "b.txt").write_text("two\n")
            git("add", "-A", cwd=root)
            git("commit", "-qm", "init", cwd=root)
        config = _isolated_config(root)
        config.data.update(ultra_mode=ultra, mode=mode, base_url="https://ollama.com/v1",
                           model="deepseek-v4.1-flash:cloud")
        agent = Agent(config, ui if ui is not None else _QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        journal = Path(tempfile.mkdtemp(prefix="dgc-troupe-journal-"))
        patcher = patch.object(config_module, "USER_HOME", journal)
        patcher.start()
        self.addCleanup(patcher.stop)
        return agent

    @staticmethod
    def names(agent):
        return {tool["function"]["name"] for tool in agent._tool_schemas()}


class ExposureTests(AgentCase):
    def test_offered_under_ultra_to_the_lead_agent_only(self):
        agent = self.make_agent(ultra=True)
        self.assertIn("troupe", self.names(agent))
        self.assertIn("start a `troupe`", agent.system_prompt())
        self.assertNotIn("troupe", self.names(self.make_agent(ultra=False)), "Ultra off: never offered")
        self.assertNotIn("start a `troupe`", self.make_agent(ultra=False).system_prompt())
        child = self.make_agent(ultra=True)
        child.depth = 1
        self.assertNotIn("troupe", self.names(child), "a sub-agent never starts one")
        plan = self.make_agent(ultra=True, mode="plan")
        self.assertNotIn("troupe", self.names(plan))
        woken = self.make_agent(ultra=True)
        woken._monitor_turn = True
        self.assertNotIn("troupe", self.names(woken), "a wake turn reports a troupe; it never starts the next")
        with patch("dgc.permissions.session_policy", return_value={"allow_tools": []}):
            self.assertNotIn("troupe", self.names(self.make_agent(ultra=True)), "an SDK policy session can't name it")

    def test_one_shot_says_it_returns_its_results(self):
        agent = self.make_agent(ultra=True)               # _QuietUI is non-interactive: a `dgc -p` run
        tool = next(t for t in agent._tool_schemas() if t["function"]["name"] == "troupe")
        self.assertIn("returns its results when it ends", tool["function"]["description"])
        self.assertNotIn("this chat wakes", tool["function"]["description"])
        interactive = self.make_agent(ultra=True, ui=Recorder())
        tool = next(t for t in interactive._tool_schemas() if t["function"]["name"] == "troupe")
        self.assertIn("this chat wakes with the results", tool["function"]["description"])

    def test_auto_mode_just_runs_it_other_modes_ask_plan_refuses(self):
        call = {"title": "t", "items": ["a"], "template": "review", "goal": "bugs"}
        self.assertEqual({mode: PermissionEngine(mode, {"allow": [], "ask": [], "deny": []}).decide("troupe", call)[0]
                          for mode in ("auto", "acceptEdits", "default", "plan")},
                         {"auto": "allow", "acceptEdits": "ask", "default": "ask", "plan": "deny"})
        self.assertEqual(PermissionEngine("auto", {"allow": [], "ask": [], "deny": ["Troupe"]}).decide("troupe", call)[0],
                         "deny", "a deny rule turns it off, auto mode included")


def fake_child(answers):
    """Stands in for _execute_prepared_subagent: answers by the prompt, records what each agent was given."""
    calls = []

    def run(self, description, prompt, agent_name, workspace, sub_ui, call_id=None, *, cancel=None, handle=None,
            tools=None, unattended=False, checker_box=None, tool_env=None, secrets=()):
        calls.append({"description": description, "prompt": prompt, "workspace": workspace, "tools": tools,
                      "unattended": unattended, "agent_name": agent_name, "checker_box": checker_box,
                      "tool_env": tool_env, "secrets": tuple(secrets)})
        return "", answers(prompt, workspace), ""
    return run, calls


REVIEW = {"title": "Review", "items": ["a.py", "b.py"], "template": "review", "goal": "bugs"}


def review_answers(prompt, workspace):
    if "Review this for bugs" in prompt:
        if "a.py" in prompt:
            return '```json\n{"findings": [{"title": "Off by one", "where": "a.py:2", "why": "<="}]}\n```'
        return '```json\n{"findings": []}\n```'
    return '```json\n{"real": true, "why": "seen"}\n```'


class RunTests(AgentCase):
    def test_the_model_is_told_exactly_what_each_kind_can_do(self):
        """ERP session review (2026-10-18): the schema said only "read only", so the model told its verifiers to re-run
        SQL and told the user they were "re-deriving each claim with their own SQL"."""
        from dgc.tools import TROUPE_TOOL_SCHEMA
        stage = TROUPE_TOOL_SCHEMA["function"]["parameters"]["properties"]["stages"]["items"]["properties"]
        self.assertIn("NO shell", stage["agent"]["description"])
        self.assertIn("can't run commands, tests or database queries", stage["agent"]["description"])
        self.assertIn("worker: a shell and writes", stage["agent"]["description"])
        self.assertIn('"unsure": true', stage["keep"]["description"])
        self.assertIn("no shell", troupe_agent.ROLE["verifier"])
        self.assertIn("say you are unsure, never that it is not real", troupe_agent.ROLE["verifier"])
        agent = self.make_agent(ultra=True, ui=Recorder())
        run, _ = fake_child(review_answers)
        with patch.object(Agent, "_execute_prepared_subagent", run):
            out = troupe_agent.start(agent, REVIEW, "c1")
            agent._troupes[out.split()[1]].join(20)
        self.assertIn("What its agents can do: Review (explorer) reads and searches the project's files and the web; "
                      "no shell", out)
        # A verifier's own line depends on this computer and project (its read-only box, its database):
        # tests/test_troupe_checker_box.py covers each case.
        self.assertIn("Verify (verifier) " + troupe_agent.abilities(agent.config.project_root)["verifier"], out)

    def test_while_it_runs_the_model_can_read_its_status_and_wait_for_it(self):
        """ERP session review (2026-10-18): asked twice for a Troupe update, list_tasks was "not offered on this
        request", so the model read ~/.dgc/troupes/<id>/results.jsonl with its own Python."""
        agent = self.make_agent(ultra=True, ui=Recorder())
        agent.on_detached_ended = lambda notice: None
        self.assertFalse({"list_tasks", "wait_tasks"} & self.names(agent), "nothing to read yet")
        release, verifying = threading.Event(), threading.Event()

        def answers(prompt, workspace):
            if "Review this for bugs" not in prompt:
                number = int(prompt.split("(number ")[1].split(")")[0])
                if number == 3:                       # the third vote waits until the test has looked
                    verifying.set()
                    release.wait(20)
                    return '```json\n{"real": false, "why": "no shell here", "unsure": true}\n```'
                return '```json\n{"real": true, "why": "seen"}\n```'
            return review_answers(prompt, workspace)
        run, _ = fake_child(answers)
        with patch.object(Agent, "_execute_prepared_subagent", run), patch.object(troupe_agent, "width", lambda a: 1):
            out = troupe_agent.start(agent, REVIEW, "c1")
            run_id = out.split()[1]
            self.assertTrue(verifying.wait(20))
            names = self.names(agent)
            self.assertIn("list_tasks", names, "offered on state: a troupe of this chat is running")
            self.assertIn("wait_tasks", names)
            self.assertFalse({"message_task", "close_task"} & names, "those act on sub-agents")
            status = agent._list_tasks_result()
            self.assertIn(f"- {run_id} · troupe · Review · running", status)
            self.assertIn("Review: 2 of 2 agents done, 1 kept", status)
            self.assertIn("Verify: 2 of 3 agents done (so far 2 said yes, 0 no)", status)
            self.assertIn(f"{agent._troupes[run_id].dir}/results.jsonl has every finished agent's reply so far", status)
            self.assertIn("5 agents", status, "the split's size is known once Verify started")
            waited = {}
            waiter = threading.Thread(target=lambda: waited.update(text=agent._wait_tasks_result(
                {"ids": [run_id], "timeout_s": 30}, "c2")))
            waiter.start()
            time.sleep(0.3)
            self.assertTrue(waiter.is_alive(), "it waits for the troupe instead of saying there is nothing to wait for")
            release.set()
            waiter.join(30)
        self.assertIn(f"Troupe {run_id}: Review", waited.get("text", ""))
        self.assertIn("Off by one", waited["text"])
        status = agent._list_tasks_result()
        self.assertIn(f"- {run_id} · troupe · Review · done", status)
        self.assertIn("Verify: 3 of 3 agents done, 1 kept", status)
        self.assertIn("report.md and results.json have the outcome", status)

    def test_a_one_shot_run_returns_the_report_and_its_agents_only_read(self):
        agent = self.make_agent(ultra=True)
        run, calls = fake_child(review_answers)
        with patch.object(Agent, "_execute_prepared_subagent", run):
            out = troupe_agent.start(agent, REVIEW, "c1")
        self.assertIn("State: done", out)
        self.assertIn("Review: 2 of 2 agents finished", out)
        self.assertIn("Verify: 3 of 3 agents finished, 1 kept", out)
        self.assertIn("Off by one", out)
        self.assertEqual(len(calls), 5)
        from dgc import checker_box
        boxed = not checker_box.unavailable_reason()
        for call in calls:
            self.assertIsNone(call["workspace"], "read-only agents need no checkout")
            verifier = call["prompt"].startswith("You are a verifier")
            # A verifier's shell is its read-only box (tests/test_troupe_checker_box.py), where this computer has one.
            self.assertEqual(call["tools"], troupe.READ_TOOLS | ({"bash"} if verifier and boxed else set()))
            self.assertEqual(call["checker_box"] is not None, verifier and boxed)
            self.assertTrue(call["unattended"])
        self.assertTrue(calls[0]["prompt"].startswith("You are a read-only explorer"))
        self.assertTrue(calls[-1]["prompt"].startswith("You are a verifier"))

    def test_in_an_editor_it_runs_in_the_background_and_wakes_the_chat_once(self):
        ui = Recorder()
        agent = self.make_agent(ultra=True, ui=ui)
        woken = []
        agent.on_detached_ended = woken.append
        run, _ = fake_child(review_answers)
        with patch.object(Agent, "_execute_prepared_subagent", run):
            out = troupe_agent.start(agent, REVIEW, "c1")
            self.assertRegex(out, r"^Troupe tr-[0-9a-f]{10} started: Review\. Review → Verify; 2 agents to start, then 3 "
                                  r"per item of Review's findings \(Verify\); at most 400 in all, up to 8 at a time")
            self.assertIn("this chat wakes with its results", out)
            run_id = out.split()[1]
            agent._troupes[run_id].join(20)
            deadline = time.monotonic() + 5
            while not woken and time.monotonic() < deadline:
                time.sleep(0.02)
        self.assertEqual(len(woken), 1)
        notice = woken[0]
        self.assertEqual((notice["id"], notice["description"]), (run_id, "Troupe: Review"))
        self.assertIn("Off by one", notice["message"])
        self.assertEqual(agent._detached_ledger()[1][run_id]["output"], notice["message"], "readable by id, as a task's")
        kinds = [kind for kind, _ in ui.events]
        self.assertEqual((kinds[0], kinds[-1]), ("started", "finished"))
        # `dgc serve` sends the protocol's fields of a snapshot (an in-process snapshot also has its estimate in words).
        from dgc.headless import _TROUPE_WIRE_FIELDS
        self.assertEqual(set(_TROUPE_WIRE_FIELDS), set(ep.EVENT_FIELDS["troupe_started"]))
        wire = [(k, {key: f[key] for key in _TROUPE_WIRE_FIELDS}) for k, f in ui.events]
        self.assertTrue(all(ep.event_error({"type": f"troupe_{k}", "seq": 0, **f}) is None for k, f in wire),
                        "every event the editor gets is valid protocol")

    def test_a_replaced_chat_is_never_woken(self):
        agent = self.make_agent(ultra=True, ui=Recorder())
        woken = []
        agent.on_detached_ended = woken.append
        gate = threading.Event()

        def slow(prompt, workspace):
            gate.wait(10)
            return review_answers(prompt, workspace)
        run, _ = fake_child(slow)
        with patch.object(Agent, "_execute_prepared_subagent", run):
            out = troupe_agent.start(agent, REVIEW, "c1")
            run_id = out.split()[1]
            agent.monitors.new_epoch("shutdown")          # /new or /clear while it runs
            gate.set()
            agent._troupes[run_id].join(20)
        time.sleep(0.2)
        self.assertEqual(woken, [])

    def test_stopping_the_chats_background_work_stops_it(self):
        agent = self.make_agent(ultra=True, ui=Recorder())
        agent.on_detached_ended = lambda notice: None
        gate = threading.Event()
        started = threading.Event()

        def held(prompt, workspace):
            started.set()
            gate.wait(10)
            return review_answers(prompt, workspace)
        run, calls = fake_child(held)
        with patch.object(Agent, "_execute_prepared_subagent", run):
            out = troupe_agent.start(agent, {**REVIEW, "items": [f"f{n}.py" for n in range(8)]}, "c1")
            run_id = out.split()[1]
            self.assertTrue(started.wait(10))
            self.assertEqual(agent.stop_detached(), 1)
            gate.set()
            agent._troupes[run_id].join(20)
        record = agent._troupes[run_id]
        self.assertEqual((record.state, record.stop_reason), ("stopped", "stopped by the user"))
        self.assertLess(len(calls), 8, "nothing more started once it was stopped")
        self.assertIn(run_id, troupe_agent.command_text(agent, ""))

    def test_a_bad_work_order_is_refused_with_what_to_change(self):
        agent = self.make_agent(ultra=True)
        out = troupe_agent.start(agent, {"title": "t", "items": ["a"], "template": "review"}, "c1")
        self.assertEqual(out, "error: this troupe was not started: goal must be a non-empty string.")
        out = troupe_agent.start(agent, {"title": "t", "items": ["a"], "resume": "tr-0000000000"}, "c1")
        self.assertIn("there is no troupe tr-0000000000 to resume", out)

    def test_the_token_cap_is_checked_before_it_starts(self):
        agent = self.make_agent(ultra=True)
        with patch.object(Agent, "turn_budget_exceeded", return_value=True):
            out = troupe_agent.start(agent, REVIEW, "c1")
        self.assertIn("token budget", out)
        self.assertFalse(getattr(agent, "_troupes", {}))


class WritingAgentTests(AgentCase):
    def test_a_worker_changes_its_own_checkout_and_the_change_is_merged(self):
        agent = self.make_agent(ultra=True, git_repo=True)
        self.assertTrue(agent.checkpoints.open(0, "turn", []), "a troupe starts inside a turn: its rewind point is open")
        root = agent.config.project_root
        seen = []

        def answers(prompt, workspace):
            if "You are a worker" in prompt:
                self.assertIsNotNone(workspace, "a writer always gets its own checkout")
                self.assertNotEqual(Path(workspace.project_root), root)
                name = "a.txt" if "In a.txt" in prompt else "b.txt"
                (Path(workspace.project_root) / name).write_text(f"{name} changed\n")
                seen.append(name)
                return '```json\n{"changed": true, "summary": "done"}\n```'
            return '```json\n{"correct": true, "why": "looks right"}\n```'
        run, calls = fake_child(answers)
        with patch.object(Agent, "_execute_prepared_subagent", run):
            out = troupe_agent.start(agent, {"title": "Mark files", "items": ["a.txt", "b.txt"], "template": "change",
                                             "goal": "write 'changed' into the file"}, "c1")
        self.assertIn("State: done", out)
        self.assertEqual(sorted(seen), ["a.txt", "b.txt"])
        self.assertEqual((root / "a.txt").read_text(), "a.txt changed\n", "merged into the user's checkout")
        self.assertEqual((root / "b.txt").read_text(), "b.txt changed\n")
        workers = [c for c in calls if c["workspace"] is not None]
        self.assertEqual(len(workers), 2)
        self.assertTrue(all(c["tools"] is None for c in workers), "a worker keeps its usual tools")


class BackendTests(unittest.TestCase):
    def test_the_editor_can_list_and_stop_troupes_and_its_events_are_valid(self):
        from dgc import headless
        from dgc.config import Config
        root = Path(tempfile.mkdtemp(prefix="dgc-troupe-host-")).resolve()
        (root / ".git").mkdir()
        user = root / "user"
        user.mkdir()
        wire = io.StringIO()
        with patch.object(config_module, "USER_HOME", user), patch.object(config_module, "USER_CONFIG", user / "config.json"):
            (user / "config.json").write_text(json.dumps({"model": "m", "base_url": "http://localhost.invalid/v1",
                                                          "suggest": False, "artifact_autostart": False}))
            host = headless.Host(Config(project_root=root))
            host.core.fp = wire
            try:
                agent = host.default.agent
                plan = troupe.plan_from_args(REVIEW)
                gate = threading.Event()

                class Held(troupe.Runner):
                    width = 1

                    def run(self, stage, prompt, label, cancel, check):
                        gate.wait(10)
                        return review_answers(prompt, None), ""

                    def event(self, kind, fields):
                        host.default.ui.troupe_event(kind, fields)
                held = troupe.Run(plan, Held(), user / "troupes")
                agent.__dict__.setdefault("_troupes", {})[held.id] = held
                held.start()
                host.dispatch({"type": "list_troupes", "request_id": "l1"})
                host.dispatch({"type": "stop_troupe", "run_id": held.id, "request_id": "s1"})
                gate.set()
                held.join(20)
                self.assertEqual(held.state, "stopped")
                host.dispatch({"type": "stop_troupe", "run_id": held.id, "request_id": "s2"})
                time.sleep(0.2)
                frames = [json.loads(line) for line in wire.getvalue().splitlines()]
                self.assertEqual(host.default._ready_payload()["capabilities"]["troupe"], 1)
                troupes = [f for f in frames if f["type"].startswith("troupe")]
                self.assertTrue({"troupe_started", "troupes", "troupe_finished"} <= {f["type"] for f in troupes})
                for frame in troupes:
                    self.assertIsNone(ep.event_error(frame), frame)
                listed = next(f for f in frames if f["type"] == "troupes" and f.get("request_id") == "l1")
                self.assertEqual(listed["runs"][0]["run_id"], held.id)
                self.assertTrue(any(f["type"] == "info" and "no running troupe" in f["message"] for f in frames))
                self.assertIsNone(ep.command_error({"type": "stop_troupe", "run_id": held.id}))
                self.assertIsNone(ep.command_error({"type": "list_troupes"}))
            finally:
                for chat in list(host.chats.values()):
                    chat.agent.mcp.stop_all()


class TerminalTests(unittest.TestCase):
    def test_only_milestones_reach_the_terminal(self):
        seen = set()
        started = {"run_id": "tr-0123456789", "title": "Review", "agents_planned": 5,
                   "stages": [{"name": "Review", "total": 0, "done": 0, "failed": 0, "kept": 0}]}
        self.assertEqual(troupe_agent.describe_event("started", started, seen),
                         "troupe tr-0123456789 · Review: Review, about 5 agents · /troupes stop tr-0123456789")
        self.assertNotIn("/troupes", troupe_agent.describe_event("started", started, seen, stop_hint=False))
        busy = {**started, "stages": [{"name": "Review", "total": 4, "done": 2, "failed": 0, "kept": 0}]}
        self.assertEqual(troupe_agent.describe_event("progress", busy, seen), "")
        done = {**started, "stages": [{"name": "Review", "total": 4, "done": 3, "failed": 1, "kept": 2}]}
        self.assertEqual(troupe_agent.describe_event("progress", done, seen),
                         "troupe tr-0123456789 · Review: 3 of 4 agents, 1 failed")
        self.assertEqual(troupe_agent.describe_event("progress", done, seen), "", "each stage once")


if __name__ == "__main__":
    unittest.main()
