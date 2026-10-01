"""A TUI worktree or fleet agent works in a checkout of the launch project and keeps its rules.

Both build a fresh Config rooted in the checkout -- a sibling folder, or one under ~/.dgc -- which is
never in trusted_dirs. So the project's .dgc/permissions.json was never loaded there while the stored
auto mode carried over: `rm -rf` the project denies ran in the worktree and in every fleet agent.
"""
import contextlib
import json
import os
import shutil
import subprocess
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
            "tests/test_checkout_trust.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-checkout-trust-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.permissions import PermissionEngine  # noqa: E402

_GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, env={**os.environ, **_GIT_ENV})


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


@unittest.skipUnless(shutil.which("git"), "needs git")
class CheckoutTrustTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-checkout-trust-")).resolve()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.repo = tmp / "proj"
        (self.repo / ".dgc").mkdir(parents=True)
        (self.repo / ".dgc" / "permissions.json").write_text(json.dumps({"deny": ["Bash(rm -rf *)"]}))
        (self.repo / "README.md").write_text("fixture\n")
        _git(self.repo, "init", "-q")
        _git(self.repo, "add", "-A")
        _git(self.repo, "commit", "-qm", "init")
        user_dgc = tmp / "user-dgc"
        user_dgc.mkdir()
        for name, value in (("USER_HOME", user_dgc), ("USER_CONFIG", user_dgc / "config.json"),
                            ("USER_SECRETS", user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (user_dgc / "config.json").write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "mode": "auto",
            "trusted_dirs": [str(self.repo)], "fleet_worktree_root": str(tmp / "fleet"),
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        self.config = Config(project_root=self.repo)
        self.agent = Agent(self.config, _QuietUI())
        self.addCleanup(self.agent.mcp.stop_all)

    def tui(self):
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput
        from dgc.tui import TUI

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=30, columns=120)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        return TUI(self.config, agent=self.agent)

    @staticmethod
    def decide(agent) -> str:
        config = agent.config
        return PermissionEngine(agent.mode, config.permissions, config.project_root).decide(
            "bash", {"command": "rm -rf build"})[0]

    def test_a_fleet_agent_keeps_the_projects_rules(self):
        self.assertEqual(self.decide(self.agent), "deny", "premise: the launch session denies it")
        ui = self.tui()
        session = ui._new_session_reserved("helper")
        self.assertIsNotNone(session, getattr(ui, "_flash_msg", ""))
        self.addCleanup(session.agent.mcp.stop_all)
        self.assertNotEqual(Path(session.agent.config.project_root).resolve(), self.repo,
                            "premise: the fleet agent works in its own checkout")
        self.assertEqual(session.agent.mode, "auto")
        self.assertEqual(self.decide(session.agent), "deny", "the fleet agent ran what the project denies")

    def test_a_worktree_session_keeps_the_projects_rules(self):
        ui = self.tui()
        ui._handle_slash("/worktree feature")
        agent = ui.active.agent
        self.addCleanup(agent.mcp.stop_all)
        self.assertNotEqual(Path(agent.config.project_root).resolve(), self.repo,
                            "premise: the session moved into the worktree")
        self.assertEqual(self.decide(agent), "deny", "the worktree session ran what the project denies")


if __name__ == "__main__":
    unittest.main()
