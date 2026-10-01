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


if __name__ == "__main__":
    unittest.main()
