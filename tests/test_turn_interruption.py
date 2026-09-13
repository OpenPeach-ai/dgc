"""What DGC says when a turn ends for a reason nobody chose.

A person pressing stop and a backend being torn down both cancel the turn. Reporting the second
as "Stopped by user" is how a goal that died with its process came back looking like the user's
own doing — no error anywhere, just a paused goal and a person who had to resume it by hand.
"""
from __future__ import annotations

import json
import os
import pwd
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_turn_interruption.py needs HOME redirected before dgc is "
                           "imported — run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-interruption-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc.agent import Agent            # noqa: E402  (after the redirect above)
from dgc.config import Config          # noqa: E402
from dgc import sessions               # noqa: E402

PROJECT = Path(__file__).resolve().parents[1]


class QuietUI:
    def __init__(self):
        self.infos, self.errors = [], []

    def info(self, message):
        self.infos.append(message)

    def error(self, message):
        self.errors.append(message)

    def __getattr__(self, name):
        return lambda *a, **k: None


class CancelReasonTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="dgc-interruption-")
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        cfg = Config()
        cfg.project_root = self.root
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})
        self.agent = Agent(cfg, QuietUI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.agent.session_file = sessions.new_path(self.root)

    def test_a_person_pressing_stop_still_reads_as_the_user(self):
        self.agent.cancelled.set()
        self.assertEqual(self.agent._cancel_reason(), "Stopped by user")

    def test_a_backend_shutdown_does_not_claim_the_user_stopped_it(self):
        self.agent.stopping = True
        reason = self.agent._cancel_reason()
        self.assertIn("backend stopped", reason)
        self.assertNotIn("Stopped by user", reason)
        self.assertIn("resume", reason.lower())

    def test_a_goal_cancelled_by_shutdown_records_the_real_reason(self):
        self.assertTrue(self.agent.set_goal("Ship the thing"))

        def step(_prompt):
            self.agent.stopping = True          # the process goes down mid-cycle
            self.agent.cancelled.set()
            return False
        self.agent._run_turn = step
        self.agent.run_turn("Continue")
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["status"], "paused")
        self.assertIn("backend stopped", snapshot["reason"])
        history = [h for h in (self.agent._goal_details.get("history") or []) if isinstance(h, dict)]
        self.assertTrue(any("backend stopped" in str(h.get("reason", "")) for h in history))
        self.assertFalse(any(str(h.get("reason", "")) == "Stopped by user" for h in history))


class ServeShutdownLogTests(unittest.TestCase):
    """`serve.log` has to answer, days later, which of three shutdowns happened."""

    def run_serve(self, commands: str) -> str:
        home = tempfile.TemporaryDirectory(prefix="dgc-serve-log-")
        self.addCleanup(home.cleanup)
        work = tempfile.TemporaryDirectory(prefix="dgc-serve-proj-")
        self.addCleanup(work.cleanup)
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT))
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
            env[var] = home.name
        subprocess.run([sys.executable, "-m", "dgc", "serve"], input=commands, text=True,
                       cwd=work.name, env=env, capture_output=True, timeout=90)
        return (Path(home.name) / ".dgc" / "logs" / "serve.log").read_text(encoding="utf-8")

    def test_stdin_eof_names_the_parent_and_the_work_in_flight(self):
        log = self.run_serve(json.dumps({"type": "status", "request_id": "s1"}) + "\n")
        self.assertIn(f"parent pid {os.getpid()}", log)
        self.assertIn("stdin closed while the parent", log)
        self.assertIn("1 commands, last 'status'", log)
        self.assertIn("turn running: no", log)
        self.assertIn("backend closed cleanly", log)

    def test_an_asked_for_shutdown_is_not_reported_as_a_closed_pipe(self):
        log = self.run_serve(json.dumps({"type": "shutdown"}) + "\n")
        self.assertIn("the editor asked us to shut down", log)
        self.assertNotIn("stdin closed", log)


class PlanHandoffPromptTests(unittest.TestCase):
    """After an approved plan, the answer contract changes: finish the part, then hand back."""

    def agent(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-plan-prompt-")
        self.addCleanup(tmp.cleanup)
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg.data.update({"model": "fixture", "base_url": "http://fixture", "mode": "default"})
        agent = Agent(cfg, QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def test_no_plan_means_no_extra_instructions(self):
        self.assertNotIn("# Approved plan", self.agent().system_prompt())

    def test_leaving_plan_mode_after_presenting_one_adds_the_hand_back(self):
        agent = self.agent()
        agent.set_mode("plan")
        agent._plan_presented = True                 # present_plan succeeded
        agent.exit_plan("default")                   # the user approved it
        prompt = agent.system_prompt()
        self.assertIn("# Approved plan", prompt)
        self.assertIn("naming what comes next", prompt)
        self.assertIn("whether to continue", prompt)

    def test_leaving_plan_mode_without_a_plan_adds_nothing(self):
        agent = self.agent()
        agent.set_mode("plan")
        agent.exit_plan("default")
        self.assertNotIn("# Approved plan", agent.system_prompt())

    def test_a_new_chat_forgets_the_plan(self):
        agent = self.agent()
        agent._plan_presented = True
        agent.exit_plan("default")
        self.assertIn("# Approved plan", agent.system_prompt())
        agent.reset()
        self.assertNotIn("# Approved plan", agent.system_prompt())

    def test_the_shared_guidance_asks_for_the_hand_back_everywhere(self):
        from dgc.presentation import RESPONSE_GUIDANCE
        self.assertIn("finish that part", RESPONSE_GUIDANCE)
        self.assertIn("whether to continue", RESPONSE_GUIDANCE)


if __name__ == "__main__":
    unittest.main()
