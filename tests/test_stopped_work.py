"""Background work a restart stopped (dgc/stopped_work.py): commands and sub-agents are shown with Run again and
never re-run on their own; troupes resume once from their journal; everything keyed on the owning process ending.

Agent tests reopen a saved session in a second Agent whose journal records name an owner process that has ended; one
serve test runs two real `dgc serve` processes, the first ended by end of input as a window reload ends it.
"""
from __future__ import annotations

import json
import os
import pwd
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_stopped_work.py needs HOME redirected before dgc is imported")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-stopped-work-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_monitor_restart import (FrontendUI, MockModel, Serve, make_config, sse_call, sse_text,  # noqa: E402
                                  tool_results, last_user, wait_for)

from dgc import monitor_restart, sessions, stopped_work, tools  # noqa: E402
from dgc.agent import Agent                                     # noqa: E402
from dgc.workflows import notice_kind                           # noqa: E402


def gone_owner() -> dict:
    """An owner that has ended: the pid of a process that exited and was reaped."""
    proc = subprocess.Popen(["true"])
    proc.wait()
    return {"pid": proc.pid, "stamp": "ended"}


class StoppedWorkTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-stopped-work-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.gone = gone_owner()

    def agent(self, mode="auto") -> Agent:
        agent = Agent(make_config(self.root, mode=mode), FrontendUI())
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        self.addCleanup(lambda: tools.shutdown_background(agent.ctx.tool_owner))
        return agent

    def saved(self, agent) -> Path:
        agent.messages += [{"role": "user", "content": "start the dev server"},
                           {"role": "assistant", "content": "Started."}]
        self.assertTrue(agent._persist(), agent._last_persist_error)
        return agent.session_file

    def first_run(self, work) -> Path:
        """A chat whose process then ended: `work(agent)` starts what was running."""
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        with mock.patch.object(monitor_restart, "owner", return_value=self.gone):
            work(agent)
        return self.saved(agent)

    def reopen(self, path: Path, mode="auto") -> tuple[Agent, list]:
        agent = self.agent(mode)
        agent.load_session(path)
        agent.config.data["mode"] = mode
        return agent, agent.restart_monitors()

    def shells(self, agent) -> list:
        return [item for item in tools.background_shells({agent.ctx.tool_owner: None}) if item["state"] == "running"]

    # ---- background commands -----------------------------------------------------------------------------------
    def test_a_command_the_restart_stopped_is_shown_and_never_run_again_on_its_own(self):
        def work(agent):
            out = tools.bash({"command": "sleep 60", "background": True}, agent.ctx)
            self.assertTrue(out.startswith("started background task"), out)
        path = self.first_run(work)
        record = stopped_work.read((path, self.root))[0]
        self.assertEqual((record["kind"], record["command"], record["cwd"]), ("shell", "sleep 60", str(self.root)))
        agent, outcomes = self.reopen(path)
        self.assertEqual([(o.kind, o.state, o.actions) for o in outcomes], [("shell", "stopped", ("run_again",))])
        self.assertIn("was stopped by a restart", outcomes[0].message)
        self.assertIn("It was not run again", outcomes[0].message)
        self.assertEqual(self.shells(agent), [], "never run again on its own")
        note = agent.messages[-1]
        self.assertEqual(notice_kind(note), "monitor_restart")
        self.assertIn("was NOT run again", note["content"])
        self.assertEqual(agent.restart_monitors(), [], "said once")
        self.assertEqual([r["id"] for r in stopped_work.stopped_shells(agent)], [record["id"]])
        # Run again: the same command, in the same folder.
        pressed = agent.rerun_task(outcomes[0].key)
        self.assertEqual((pressed.state, pressed.by_user), ("started", True))
        running = self.shells(agent)
        self.assertEqual([item["command"] for item in running], ["sleep 60"])
        self.assertEqual(pressed.id, running[0]["id"])
        self.assertIn("ran background command", agent.messages[-1]["content"])
        self.assertIsNone(agent.rerun_task(outcomes[0].key), "once")
        self.assertEqual(stopped_work.stopped_shells(agent), [])

    def test_a_deny_wins_over_run_again(self):
        path = self.first_run(lambda agent: tools.bash({"command": "sleep 60", "background": True}, agent.ctx))
        agent, outcomes = self.reopen(path, mode="plan")
        pressed = agent.rerun_task(outcomes[0].key)
        self.assertEqual((pressed.state, pressed.actions), ("stopped", ("run_again",)))
        self.assertIn("plan mode is on", pressed.message)
        self.assertEqual(self.shells(agent), [])

    def test_commands_that_ended_by_themselves_or_by_request_are_not_mentioned(self):
        def work(agent):
            tools.bash({"command": "true", "background": True}, agent.ctx)
            out = tools.bash({"command": "sleep 60", "background": True}, agent.ctx)
            tools.bash_kill({"id": out.split()[3].rstrip(":")}, agent.ctx)
            self.assertTrue(wait_for(lambda: all(r["state"] == "ended" for r in
                                                 stopped_work.read((agent.session_file, self.root))), 10))
        path = self.first_run(work)
        self.assertEqual(sorted(r["end"] for r in stopped_work.read((path, self.root))), ["exited", "killed"])
        _, outcomes = self.reopen(path)
        self.assertEqual(outcomes, [])

    def test_dgc_closing_marks_its_commands_stopped_before_they_go(self):
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        tools.bash({"command": "sleep 60", "background": True}, agent.ctx)
        tools.shutdown_background(agent.ctx.tool_owner)          # the chat or DGC going away
        self.assertEqual([r["end"] for r in stopped_work.read((agent.session_file, self.root))], ["dgc_stopped"])

    def test_a_command_carrying_a_credential_is_shown_without_run_again(self):
        def work(agent):
            agent.config.data["api_key"] = "sk-fixture-0123456789abcdefSECRET"
            tools.bash({"command": "curl -H 'k: sk-fixture-0123456789abcdefSECRET' x; sleep 60",
                        "background": True}, agent.ctx)
        path = self.first_run(work)
        self.assertNotIn("SECRET", (path.with_suffix(".tasks")).read_text())
        _, outcomes = self.reopen(path)
        self.assertEqual([(o.state, o.actions) for o in outcomes], [("stopped", ())])

    # ---- sub-agents ----------------------------------------------------------------------------------------------
    def test_a_sub_agent_the_restart_stopped_offers_resume_and_run_again(self):
        def work(agent):
            agent.subagents.start(id="sub-0123456789ab", description="audit the API", background=True)
            agent.subagents.append_log("sub-0123456789ab", {"type": "tool_call", "name": "grep",
                                                             "summary": "grep -n route api/"})
            agent.subagents.append_log("sub-0123456789ab", {"type": "tool_result", "name": "grep",
                                                             "output": "api/users.py:12: route"})
            stopped_work.agent_started(agent, "sub-0123456789ab", "audit the API", "Audit every route in api/.",
                                       "", background=True, call_id="c1")
        path = self.first_run(work)
        agent, outcomes = self.reopen(path)
        self.assertEqual([(o.kind, o.state, o.actions) for o in outcomes],
                         [("agent", "stopped", ("resume", "run_again"))])
        self.assertIn('Sub-agent "audit the API" was stopped by a restart', outcomes[0].message)
        self.assertEqual(agent.subagents.state("sub-0123456789ab"), "stopped")
        calls = []

        def run_subagent(description, prompt, name, call_id, *, background):
            calls.append((description, prompt, background))
            agent._detached_jobs = {**(getattr(agent, "_detached_jobs", None) or {}), "sub-feedfacecafe": object()}
            return "started in the background"
        with mock.patch.object(agent, "_run_subagent", side_effect=run_subagent):
            resumed = agent.rerun_task(outcomes[0].key, "resume")
        self.assertEqual((resumed.state, resumed.id), ("started", "sub-feedfacecafe"))
        description, prompt, background = calls[0]
        self.assertEqual((description, background), ("audit the API", True))
        self.assertTrue(prompt.startswith("Audit every route in api/."))
        self.assertIn("stopped when DGC stopped", prompt)
        self.assertIn("grep: grep -n route api/", prompt)
        self.assertIn("api/users.py:12", prompt)
        self.assertIn("the user resumed sub-agent", agent.messages[-1]["content"])

    def test_run_again_is_the_same_task_from_scratch(self):
        def work(agent):
            stopped_work.agent_started(agent, "sub-0123456789ab", "audit", "Audit api/.", "reviewer",
                                       background=False, call_id="c1")
        path = self.first_run(work)
        agent, outcomes = self.reopen(path)
        calls = []
        with mock.patch.object(agent, "_run_subagent", side_effect=lambda *a, **k: calls.append((a, k)) or (
                setattr(agent, "_detached_jobs", {"sub-aaaaaaaaaaaa": 1}) or "ok")):
            again = agent.rerun_task(outcomes[0].key, "again")
        self.assertEqual(again.state, "started")
        self.assertEqual(calls[0][0][:3], ("audit", "Audit api/.", "reviewer"))
        self.assertEqual(calls[0][1], {"background": True})

    def test_a_sub_agent_that_finished_or_was_stopped_by_the_user_is_not_mentioned(self):
        def work(agent):
            for identity, state in (("sub-000000000001", "finished"), ("sub-000000000002", "stopped")):
                stopped_work.agent_started(agent, identity, "x", "y", "", background=True, call_id="")
                stopped_work.agent_ended(agent, identity, state)
        path = self.first_run(work)
        _, outcomes = self.reopen(path)
        self.assertEqual(outcomes, [])

    def test_a_chat_closing_marks_its_sub_agents_and_troupes(self):
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        stopped_work.agent_started(agent, "sub-000000000003", "x", "y", "", background=True, call_id="")
        agent.stop_detached()
        stopped_work.agent_ended(agent, "sub-000000000003", "stopped")   # its own end lands later: too late
        self.assertEqual([r["end"] for r in stopped_work.read((agent.session_file, self.root))], ["dgc_stopped"])

    # ---- troupes ------------------------------------------------------------------------------------------------
    def troupe_record(self, agent, run_id="tr-0123456789", template=""):
        run = mock.MagicMock(id=run_id, state="running")
        run.plan.title = "review the API"
        run.plan.template = template
        stopped_work.troupe_started(agent, run)
        return run

    def test_a_troupe_resumes_once_from_its_journal(self):
        path = self.first_run(lambda agent: self.troupe_record(agent))
        from dgc import troupe_agent
        with mock.patch.object(troupe_agent, "start", return_value=(
                "Troupe tr-0123456789 started: review the API. 7 results from the earlier attempt are reused.")) as start:
            agent, outcomes = self.reopen(path)
            self.assertEqual([(o.kind, o.state) for o in outcomes], [("troupe", "resumed")])
            self.assertEqual(start.call_args.args[1], {"resume": "tr-0123456789"})
            self.assertIn("7 finished results kept", outcomes[0].message)
            self.assertEqual(agent.restart_monitors(), [])
            _, again = self.reopen(path)
            self.assertEqual(again, [], "once: the resumed run has a record of its own")
        self.assertEqual(start.call_count, 1)

    def test_a_troupe_plan_mode_forbids_is_offered_as_resume(self):
        path = self.first_run(lambda agent: self.troupe_record(agent))
        from dgc import troupe_agent
        with mock.patch.object(troupe_agent, "start") as start:
            agent, outcomes = self.reopen(path, mode="plan")
            self.assertEqual([(o.state, o.actions) for o in outcomes], [("stopped", ("resume",))])
            start.assert_not_called()

    def test_a_rule_for_its_template_covers_the_resume(self):
        path = self.first_run(lambda agent: self.troupe_record(agent, template="review"))
        from dgc import troupe_agent
        agent = self.agent("default")
        agent.config.permissions = {"allow": ["Troupe(review)"], "ask": [], "deny": []}
        agent.load_session(path)
        agent.config.data["mode"] = "default"
        with mock.patch.object(troupe_agent, "start", return_value="Troupe tr-0123456789 started") as start:
            outcomes = agent.restart_monitors()
        self.assertEqual([(o.kind, o.state) for o in outcomes], [("troupe", "resumed")],
                         "started in auto mode, now default: the rule is what allows it")
        self.assertEqual(start.call_count, 1)
        self.assertEqual(stopped_work.read((path, self.root))[0].get("template"), "review")

    def test_a_troupe_that_finished_is_not_resumed(self):
        def work(agent):
            run = self.troupe_record(agent)
            run.state = "done"
            stopped_work.troupe_ended(agent, run)
        path = self.first_run(work)
        _, outcomes = self.reopen(path)
        self.assertEqual(outcomes, [])

    # ---- keyed on the owning process ending ---------------------------------------------------------------------
    def test_work_whose_process_still_runs_is_left_alone_then_brought_back_once_it_ends(self):
        owner = subprocess.Popen(["sleep", "30"])
        self.addCleanup(lambda: (owner.kill(), owner.wait()))
        from dgc.monitors import _probes
        alive = {"pid": owner.pid, "stamp": _probes["starttime"](owner.pid)}
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        with mock.patch.object(monitor_restart, "owner", return_value=alive):
            agent.monitors.start({"command": "sleep 60", "description": "ERP sync", "persistent": True,
                                  "_dgc_permission": {"mode": "auto", "allowed_by": "policy"}}, agent.ctx)
            tools.bash({"command": "sleep 60", "background": True}, agent.ctx)
            agent.monitors.new_epoch("shutdown")
        path = self.saved(agent)
        reopened, outcomes = self.reopen(path)
        self.assertEqual(outcomes, [], "its DGC still has the session")
        self.assertEqual(reopened.monitor_restart_awaiting(), "wait")
        owner.kill()
        owner.wait()
        self.assertEqual(reopened.monitor_restart_awaiting(), "ready")
        later = reopened.restart_awaited_monitors()
        self.assertEqual(sorted((o.kind, o.state) for o in later), [("monitor", "restarted"), ("shell", "stopped")])
        self.assertEqual(reopened.monitor_restart_awaiting(), "")
        self.assertEqual(reopened.restart_awaited_monitors(), [])


class ServeStoppedWorkTests(unittest.TestCase):
    def test_a_background_command_after_a_reload_is_shown_with_run_again(self):
        home = Path(tempfile.mkdtemp(prefix="dgc-stopped-work-serve-home-"))
        work = Path(tempfile.mkdtemp(prefix="dgc-stopped-work-serve-work-"))
        (home / ".dgc").mkdir()

        def script(body):
            if not tool_results(body):
                return sse_call("bash", {"command": "sleep 300", "background": True})
            return sse_text("started")
        with MockModel(script) as model:
            (home / ".dgc" / "config.json").write_text(json.dumps({
                "base_url": model.url, "model": "mock-model", "api_mode": "chat_completions",
                "suggest": False, "notes": False}))
            first = Serve(self, model, home, work)
            first.mode("auto")
            first.send({"type": "prompt", "text": "start the dev server", "request_id": "p1"})
            self.assertTrue(first.wait(lambda e: e["type"] == "turn_end", 60))
            first.close()                                         # the window reloads

            second = Serve(self, model, home, work)
            second.mode("auto")
            second.send({"type": "list_background_shells", "request_id": "shells"})
            second.resume()
            line = second.wait(lambda e: e["type"] == "task_interrupted", 30)
            self.assertTrue(line, [e["type"] for e in second.events])
            self.assertEqual((line["kind"], line["state"], line["actions"]), ("shell", "stopped", ["run_again"]))
            self.assertIn("`sleep 300` was stopped by a restart", line["message"])
            listed = second.wait(lambda e: e["type"] == "background_shells" and any(
                i["state"] == "stopped" and i.get("rerun") == line["key"] for i in e["items"]), 10)
            self.assertTrue(listed, "the agent map shows it, with the key Run again takes")
            second.send({"type": "rerun_task", "key": line["key"], "request_id": "again"})
            again = second.wait(lambda e: e["type"] == "task_interrupted" and e.get("request_id") == "again", 30)
            self.assertEqual((again["state"], again["by_user"]), ("started", True))
            self.assertTrue(second.wait(lambda e: e["type"] == "background_shells" and any(
                i["state"] == "running" and i["command"] == "sleep 300" for i in e["items"]), 10))
            second.send({"type": "get_history", "request_id": "h"})
            history = second.wait(lambda e: e["type"] == "history" and e.get("request_id") == "h", 20)
            self.assertEqual([(i["kind"], i["state"]) for i in history["items"] if i.get("role") == "task_interrupted"],
                             [("shell", "stopped"), ("shell", "started")])
            self.assertIs(second.of("ready")[0]["capabilities"].get("task_interrupted"), True)
            second.close()
            second.assert_valid_stream(self)


if __name__ == "__main__":
    unittest.main()
