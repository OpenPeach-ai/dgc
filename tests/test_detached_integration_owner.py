"""A detached child's integration runs where the session can be saved.

Reproduced with `dgc -p` and a background task the model then waited on: "integration failed: could
not capture rewind checkpoint: notes.md" -- the child's finished work was retained in a worktree
instead of reaching the project. Saving the session is reserved to the thread holding it for a
turn, and the child integrated on its own thread while the parent's turn still held it.
"""
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

# Hermetic like tests/test_todo_lifecycle.py: redirect HOME before any dgc module reads it.


def _real_account_home() -> Path:
    try:
        import pwd
        return Path(pwd.getpwuid(os.getuid()).pw_dir).resolve(strict=False)
    except (ImportError, KeyError, AttributeError):
        return Path(os.path.expanduser("~")).resolve(strict=False)


if "dgc.config" in sys.modules:
    _user_home = Path(sys.modules["dgc.config"].USER_HOME).resolve(strict=False)
    _account_home = _real_account_home()
    if _user_home == _account_home or _account_home in _user_home.parents:
        raise RuntimeError(
            "tests/test_detached_integration_owner.py needs HOME redirected before dgc is imported "
            "— run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-owner-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.llm import ChatResult  # noqa: E402


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class SessionOwnerTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-owner-")).resolve()
        user_dgc = tmp / "user-dgc"
        user_dgc.mkdir()
        for name, value in (("USER_HOME", user_dgc), ("USER_CONFIG", user_dgc / "config.json"),
                            ("USER_SECRETS", user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (user_dgc / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}, "mode": "auto"}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        (tmp / "project").mkdir()
        self.agent = Agent(Config(project_root=tmp / "project"), _QuietUI())
        self.addCleanup(self.agent.mcp.stop_all)
        self.agent.session_file = sessions.new_path(tmp / "project")

    def saving(self, record):
        """What an integration needs: the session reservation it saves under."""
        def operation():
            record["thread"] = threading.get_ident()
            with self.agent._session_turn_scope() as reserved:
                record["reserved"] = reserved
            return "integrated"
        return operation

    def test_with_no_turn_it_runs_right_here(self):
        record = {}
        self.assertEqual(self.agent._as_session_owner(self.saving(record)), "integrated")
        self.assertEqual(record, {"thread": threading.get_ident(), "reserved": True})

    def test_during_a_turn_it_runs_on_the_turns_own_thread(self):
        record, holding, answer = {}, threading.Event(), {}

        def turn():
            with self.agent._session_turn_scope(reentrant=False) as reserved:
                record["turn"] = threading.get_ident()
                holding.set()
                while "thread" not in record:          # the turn reaches a boundary, again and again
                    self.agent._run_handed_over()
                    threading.Event().wait(0.02)
        owner = threading.Thread(target=turn)
        owner.start()
        self.assertTrue(holding.wait(5))
        answer["value"] = self.agent._as_session_owner(self.saving(record))
        owner.join(5)
        self.assertEqual(answer["value"], "integrated")
        self.assertEqual(record["thread"], record["turn"], "it ran on the child's thread, and could not save")
        self.assertTrue(record["reserved"])

    def test_a_turn_that_ends_first_leaves_it_to_the_waiting_thread(self):
        record, holding, release = {}, threading.Event(), threading.Event()

        def turn():
            with self.agent._session_turn_scope(reentrant=False):
                holding.set()
                release.wait(5)                      # ends WITHOUT reaching a boundary
        owner = threading.Thread(target=turn)
        owner.start()
        self.assertTrue(holding.wait(5))
        threading.Timer(0.3, release.set).start()
        self.assertEqual(self.agent._as_session_owner(self.saving(record)), "integrated")
        owner.join(5)
        self.assertEqual(record["thread"], threading.get_ident())
        self.assertTrue(record["reserved"], "the session was free by then, so it saved")

    def test_a_failure_reaches_the_thread_that_asked(self):
        holding = threading.Event()
        stop = threading.Event()

        def turn():
            with self.agent._session_turn_scope(reentrant=False):
                holding.set()
                while not stop.is_set():
                    self.agent._run_handed_over()
                    threading.Event().wait(0.02)
        owner = threading.Thread(target=turn)
        owner.start()
        self.assertTrue(holding.wait(5))

        def boom():
            raise RuntimeError("integration failed")
        try:
            with self.assertRaises(RuntimeError):
                self.agent._as_session_owner(boom)
        finally:
            stop.set()
            owner.join(5)

    def test_a_real_turn_runs_what_was_handed_to_it_before_it_saves(self):
        record, in_request, finished = {}, threading.Event(), threading.Event()

        class Client:
            tools_supported = True

            def chat(_self, *_args, **_kwargs):
                in_request.set()
                finished.wait(5)
                return ChatResult(content="done")
        self.agent.client = Client()
        record["turn"] = None
        runner = threading.Thread(target=lambda: record.update(turn=threading.get_ident())
                                  or self.agent.run_turn("work"))
        runner.start()
        self.assertTrue(in_request.wait(5))
        asked = threading.Thread(target=lambda: record.update(
            value=self.agent._as_session_owner(self.saving(record))))
        asked.start()
        threading.Event().wait(0.2)
        finished.set()
        runner.join(10)
        asked.join(10)
        self.assertEqual(record.get("value"), "integrated")
        self.assertEqual(record["thread"], record["turn"], "the turn did not run it at its end")
        self.assertTrue(record["reserved"])


    def test_a_background_child_finishing_during_the_turn_integrates_on_the_turns_thread(self):
        from types import SimpleNamespace
        from dgc import agent as agent_module
        agent = self.agent
        agent._detached_jobs, agent._finalizing, agent._finished_jobs = {}, {}, {}
        agent._finalizing_lock = threading.Lock()
        record, holding, stop = {}, threading.Event(), threading.Event()
        agent._execute_prepared_subagent = lambda *args, **kwargs: ("", "the child's answer")

        def finalize(description, workspace, failure, result, start_error="", *, cancel=None, keeper=None):
            record["thread"] = threading.get_ident()
            with agent._session_turn_scope() as reserved:      # what saving its rewind point needs
                record["reserved"] = reserved
            return agent_module._TaskOutcome("integrated", integrated=True)
        agent._finalize_subagent = finalize

        def turn():
            with agent._session_turn_scope(reentrant=False):
                record["turn"] = threading.get_ident()
                holding.set()
                while not stop.is_set():
                    agent._run_handed_over()
                    threading.Event().wait(0.02)
        owner = threading.Thread(target=turn)
        owner.start()
        self.assertTrue(holding.wait(5))
        try:
            agent._spawn_detached_subagent("write notes.md", "do it", "", None,
                                           SimpleNamespace(agent_id="sub-0123456789ab"), None,
                                           threading.Event())
            for _ in range(250):
                if "thread" in record and not agent._detached_jobs:
                    break
                threading.Event().wait(0.02)
        finally:
            stop.set()
            owner.join(5)
        self.assertEqual(record.get("thread"), record["turn"],
                         "the child integrated on its own thread, where the session cannot be saved")
        self.assertTrue(record["reserved"])

if __name__ == "__main__":
    unittest.main()
