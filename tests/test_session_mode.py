"""A reopened session comes back in the mode it ran in.

Mode is per chat -- a risky refactor sits in default while a scratch chat runs auto -- so it belongs
to the conversation, the way Codex keeps it per thread. Reopening is re-checked rather than trusted
from the file, and never rewrites the user's own default.
"""
import json
import os
import sys
import tempfile
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
            "tests/test_session_mode.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-session-mode-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.trust import mark_trusted, revoke_trust  # noqa: E402


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class SessionModeTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-session-mode-")).resolve()
        self.user_dgc = tmp / "user-dgc"
        self.user_dgc.mkdir()
        for name, value in (("USER_HOME", self.user_dgc), ("USER_CONFIG", self.user_dgc / "config.json"),
                            ("USER_SECRETS", self.user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user_dgc / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}, "mode": "default"}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        self.root = tmp / "project"
        self.root.mkdir()

    def stored_mode(self) -> str:
        return json.loads((self.user_dgc / "config.json").read_text()).get("mode", "")

    def agent(self) -> Agent:
        agent = Agent(Config(project_root=self.root), _QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def saved_in(self, mode: str, *, trusted: bool = True) -> Path:
        agent = self.agent()
        if trusted:
            mark_trusted(agent.config, self.root)
        agent.session_file = sessions.new_path(self.root)
        agent.config.data["mode"] = mode            # the chat ran in this mode
        agent.messages.append({"role": "user", "content": "hello"})
        self.assertTrue(agent._persist(), agent._last_persist_error)
        return agent.session_file

    def test_a_chat_reopens_in_the_mode_it_ran_in(self):
        path = self.saved_in("plan")
        reopened = self.agent()
        self.assertEqual(reopened.mode, "default", "premise: a fresh chat starts in the default")
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "plan")

    def test_reopening_never_rewrites_the_users_default(self):
        path = self.saved_in("acceptEdits")
        reopened = self.agent()
        reopened.load_session(path)
        reopened.config.set("thinking", "high")     # any later save
        self.assertEqual(self.stored_mode(), "default", "reopening a chat changed every new chat's mode")

    def test_a_mode_chosen_after_reopening_is_saved_as_the_default(self):
        path = self.saved_in("plan")
        reopened = self.agent()
        reopened.load_session(path)
        reopened.set_mode("acceptEdits")
        self.assertEqual(self.stored_mode(), "acceptEdits")

    def test_auto_comes_back_only_while_the_folder_is_trusted(self):
        path = self.saved_in("auto")
        reopened = self.agent()
        revoke_trust(reopened.config, self.root)
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "default", "an untrusted folder reopened in auto")

    def test_a_session_saved_before_modes_were_recorded_keeps_the_current_mode(self):
        path = self.saved_in("plan")
        record = json.loads(path.read_text())
        record.pop("mode", None)
        path.write_text(json.dumps(record))
        reopened = self.agent()
        reopened.load_session(path)
        self.assertEqual(reopened.mode, "default")

    def test_the_editor_is_told_when_a_reopened_chat_changes_mode(self):
        from types import SimpleNamespace
        from dgc import headless
        path = self.saved_in("plan")
        backend = object.__new__(headless.Backend)
        events = []
        backend.em = SimpleNamespace(emit=lambda event_type, **fields: events.append({"type": event_type, **fields}))
        backend._busy = lambda: False
        backend.agent = self.agent()
        backend.config = backend.agent.config
        backend.workspace_trusted = True
        for name in ("_emit_history", "_emit_agents", "_emit_context", "_emit_goal", "_emit_monitors"):
            setattr(backend, name, lambda *args, **kwargs: None)
        backend._dispatch({"type": "resume_session", "path": path.name, "request_id": "r1"})
        changed = [e for e in events if e["type"] == "mode_changed"]
        self.assertEqual([e["mode"] for e in changed], ["plan"], events)


if __name__ == "__main__":
    unittest.main()
