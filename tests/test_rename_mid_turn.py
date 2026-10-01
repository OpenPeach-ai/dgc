"""Renaming a chat while its turn runs.

The rename was refused twice over while a turn ran: the editor command was on the busy list, and
the session reservation refused any thread but the turn's own. A rename rewrites one field, under
the same lock every save of that turn takes, so it joins the reservation THIS agent's turn holds.
Another agent -- or another process -- holding the session still cannot rename it.
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
            "tests/test_rename_mid_turn.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-rename-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import headless, sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.llm import ChatResult  # noqa: E402


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class RenameMidTurnTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-rename-")).resolve()
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
        self.root = tmp / "project"
        self.root.mkdir()

    def agent(self) -> Agent:
        agent = Agent(Config(project_root=self.root), _QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def running_turn(self, agent):
        """A turn that is inside its model request, holding the session, until released."""
        started, release = threading.Event(), threading.Event()

        class Blocking:
            tools_supported = True

            def chat(self, *_args, **_kwargs):
                started.set()
                release.wait(10)
                return ChatResult(content="done")
        agent.client = Blocking()
        worker = threading.Thread(target=agent.run_turn, args=("work for a while",), daemon=True)
        worker.start()
        self.assertTrue(started.wait(5), "premise: the turn is running")
        return worker, release

    def test_a_chat_can_be_renamed_while_its_turn_runs(self):
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        worker, release = self.running_turn(agent)
        try:
            self.assertTrue(agent.name_session("renamed mid-turn"),
                            getattr(agent, "_last_persist_error", ""))
        finally:
            release.set()
            worker.join(10)
        saved = json.loads(Path(agent.session_file).read_text())
        self.assertEqual(saved.get("name"), "renamed mid-turn", "the turn's own save lost the new name")

    def test_another_agent_holding_the_session_still_cannot_rename_it(self):
        owner = self.agent()
        owner.session_file = sessions.new_path(self.root)
        owner.name_session("owner's")                       # saved, so another agent can load it
        worker, release = self.running_turn(owner)
        try:
            contender = self.agent()
            contender.load_session(owner.session_file)
            self.assertFalse(contender.name_session("must not save"))
        finally:
            release.set()
            worker.join(10)

    def test_the_editor_command_is_not_refused_mid_turn(self):
        backend = object.__new__(headless.Backend)
        events, renamed = [], []
        backend.em = type("Em", (), {"emit": lambda _self, kind, **fields: events.append({"type": kind, **fields})})()
        backend._busy = lambda: True
        backend.agent = type("A", (), {"session_name": "",
                                       "name_session": lambda _self, name: renamed.append(name) or True})()
        backend._dispatch({"type": "name_session", "name": "while busy", "request_id": "n1"})
        self.assertEqual(renamed, ["while busy"])
        self.assertFalse([e for e in events if e["type"] == "command_rejected"], events)


    def test_an_unsaved_chat_renamed_mid_turn_is_named_by_its_turns_save(self):
        """A first turn that has not saved yet (its SessionStart hooks, a subscription turn): the
        rename tried to save from the command thread and was refused as another process's turn."""
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        holding, release = threading.Event(), threading.Event()

        def turn():
            with agent._session_turn_scope() as reserved:
                self.assertTrue(reserved)
                holding.set()
                release.wait(10)
                agent.messages.append({"role": "user", "content": "hello"})
                agent._persist()
        worker = threading.Thread(target=turn, daemon=True)
        worker.start()
        self.assertTrue(holding.wait(5))
        try:
            self.assertTrue(agent.name_session("named early"), agent._last_persist_error)
            self.assertFalse(Path(agent.session_file).exists(),
                             "the rename wrote the transcript from outside the turn writing it")
        finally:
            release.set()
            worker.join(10)
        saved = json.loads(Path(agent.session_file).read_text())
        self.assertEqual(saved.get("name"), "named early")

    def test_a_rename_at_the_end_of_a_turn_never_refuses_the_next_turn(self):
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        holding, joined, leave = threading.Event(), threading.Event(), threading.Event()

        def first_turn():
            with agent._session_turn_scope() as reserved:
                self.assertTrue(reserved)
                holding.set()
                joined.wait(5)                # the rename joins just before the turn ends

        def rename():
            with agent._session_turn_scope(shared=True) as reserved:
                self.assertTrue(reserved)
                joined.set()
                leave.wait(5)                 # and is still writing as the next turn starts
        turn = threading.Thread(target=first_turn, daemon=True)
        turn.start()
        self.assertTrue(holding.wait(5))
        renaming = threading.Thread(target=rename, daemon=True)
        renaming.start()
        turn.join(5)
        threading.Timer(0.3, leave.set).start()
        with agent._session_turn_scope() as reserved:   # the next queued turn, on its own thread
            self.assertTrue(reserved, "the next turn was refused as another DGC process's")
        renaming.join(5)
        self.assertIsNone(agent._session_turn_lease, "the session was left reserved")

    def test_a_plugin_installed_mid_turn_reaches_the_running_turns_prompt(self):
        agent = self.agent()
        agent._mode_prompt_dirty = False
        agent.reload_skills()
        self.assertTrue(agent._mode_prompt_dirty, "the running turn kept the old skill list")

    def test_a_busy_workspace_never_holds_the_turn_at_a_boundary(self):
        """A background child's integration, handed to the parent's turn, waited on the workspace
        lease another chat's long command held -- and the turn, and its Stop, with it."""
        import time
        from types import SimpleNamespace
        from dgc.scheduler import workspace_mutation_lock
        agent = self.agent()
        agent.session_file = sessions.new_path(self.root)
        integrated = []
        workspace = SimpleNamespace(integrate=lambda keeper: integrated.append(True) or SimpleNamespace(
            status="applied", paths=["a.txt"], merged=[], head_moved=False, cleanup_error="",
            conflicts=[]))
        lease = workspace_mutation_lock(self.root)
        holder_has_it, holder_release = threading.Event(), threading.Event()

        def other_chats_command():
            self.assertTrue(lease.acquire(timeout=5))
            holder_has_it.set()
            holder_release.wait(10)
            lease.release()
        holder = threading.Thread(target=other_chats_command, daemon=True)
        holder.start()
        self.assertTrue(holder_has_it.wait(5))
        outcome = {}
        with agent._session_turn_scope() as reserved:      # the parent's turn holds the session
            self.assertTrue(reserved)
            child = threading.Thread(target=lambda: outcome.setdefault("value", agent._as_session_owner(
                lambda: agent._finalize_subagent("part", workspace, "", "ok",
                                                 cancel=threading.Event(), keeper=object()))),
                daemon=True)
            child.start()
            deadline = time.monotonic() + 5
            while agent._handed_over.empty() and time.monotonic() < deadline:
                time.sleep(0.01)
            started = time.monotonic()
            safety = threading.Timer(4.0, holder_release.set)   # a turn that waits still ends
            safety.start()
            agent._run_handed_over()                       # a boundary of the parent's turn
            self.assertLess(time.monotonic() - started, 3.0, "the turn waited on the workspace")
            self.assertEqual(integrated, [], "premise: the workspace was busy")
            safety.cancel()
            holder_release.set()
            holder.join(5)
            agent._run_handed_over()                       # the next boundary integrates it
        child.join(5)
        self.assertEqual(integrated, [True])
        self.assertTrue(outcome["value"].integrated)


if __name__ == "__main__":
    unittest.main()
