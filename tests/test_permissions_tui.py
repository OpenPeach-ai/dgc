"""The TUI's `/permissions allow|ask|deny` saves the user's own rule even when a project has it too."""
import contextlib
import copy
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

# Hermetic like tests/test_todo_lifecycle.py: an Agent takes its workspace lease under HOME/.dgc and
# the system prompt loads ~/.dgc memory, so HOME is redirected before any dgc module reads it.


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
            "tests/test_permissions_tui.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-permissions-tui-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import sessions  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config, DEFAULTS  # noqa: E402


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


class TuiPermissionsTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-permissions-tui-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        scoped = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        cfg = object.__new__(Config)
        cfg.project_root, cfg.project_dir, cfg._persist = self.root, self.root / ".dgc", False
        cfg.data = copy.deepcopy(DEFAULTS)
        cfg.data.update(base_url="http://localhost.invalid/v1", model="fixture", hooks={},
                        mcp_servers={}, suggest=False, artifact_autostart=False, thinking="off")
        cfg._stored_secrets, cfg._env_secret_keys = {}, set()
        # A trusted project's deny, live and recorded as the project's -- as apply_project_permissions
        # leaves it.
        cfg.permissions = {"allow": [], "ask": [], "deny": ["Bash(rm -rf *)"]}
        cfg._project_rules = {"allow": [], "ask": [], "deny": ["Bash(rm -rf *)"]}
        self.config = cfg
        self.agent = Agent(cfg, _QuietUI())
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

    def test_a_user_deny_that_a_project_also_has_is_the_users_own(self):
        """Deduped against the live list, the TUI saw the project's copy and saved nothing: a deny the
        user added for every project applied only inside this one."""
        ui = self.tui()
        ui._handle_slash("/permissions deny Bash(rm -rf *)")
        self.assertEqual(self.config.user_permissions()["deny"], ["Bash(rm -rf *)"],
                         "what save() writes has no user deny, so other projects run rm -rf")

    def test_adding_a_rule_the_user_already_has_adds_nothing(self):
        self.config.permissions["deny"].append("Bash(curl *)")
        ui = self.tui()
        ui._handle_slash("/permissions deny Bash(curl *)")
        self.assertEqual(self.config.permissions["deny"].count("Bash(curl *)"), 1)

    def test_a_rule_the_user_and_the_project_both_have_is_listed_once(self):
        ui = self.tui()
        ui._handle_slash("/permissions deny Bash(rm -rf *)")
        shown = []
        ui._rich = lambda text: text
        ui._append = shown.append
        ui._handle_slash("/permissions")
        self.assertEqual(shown[-1].count("Bash(rm -rf *)"), 1, shown[-1])


if __name__ == "__main__":
    unittest.main()
