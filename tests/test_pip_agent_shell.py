"""A DGC chat's own shell cannot make Pip decisions through the `dgc pips` CLI.

The CLI acts as the local user, and auto mode approves every shell command, so a chat that ran
`dgc pips create`/`accept --yes` in its shell approved its own Pips. Every shell DGC runs for the
model carries sandbox.AGENT_SHELL; `dgc pips` refuses changes there and still reads.
"""
import argparse
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_cli, sandbox, tools
from tests import test_pips_local as fixtures


class Ctx:
    def __init__(self, root):
        self.project_root = root
        self.todos, self.skills, self.on_todo = [], {}, None

        class Cfg:
            def get(self, key, default=None):
                return default
        self.config = Cfg()


class ShellMarkerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.ctx = Ctx(Path(temp.name))
        clean = {k: v for k, v in os.environ.items() if k != sandbox.AGENT_SHELL}
        p = patch.dict(os.environ, clean, clear=True)
        p.start(); self.addCleanup(p.stop)

    def test_the_models_shell_is_marked_and_a_command_the_user_typed_is_not(self):
        probe = 'printf "marker=%s" "${DGC_AGENT_SHELL:-none}"'
        self.assertIn("marker=1", tools.bash({"command": probe}, self.ctx))
        self.assertIn("marker=none", tools.direct_bash(probe, self.ctx), "`!cmd` is the user's own")
        self.assertIn("marker=1", tools.bash({"command": probe}, self.ctx), "and the next model call is marked again")

    def test_every_environment_dgc_builds_for_a_tool_is_marked(self):
        self.assertEqual(sandbox.tool_env()[sandbox.AGENT_SHELL], "1")
        self.assertEqual(sandbox.process_env()[sandbox.AGENT_SHELL], "1")
        self.assertNotIn(sandbox.AGENT_SHELL, sandbox.tool_env(agent=False))
        with patch.dict(os.environ, {sandbox.AGENT_SHELL: "1"}):
            self.assertEqual(sandbox.tool_env(agent=False)[sandbox.AGENT_SHELL], "1",
                             "a DGC started from a chat's shell never unmarks its children")
            self.assertEqual(sandbox.process_env(agent=False)[sandbox.AGENT_SHELL], "1")


class AgentShellCommandTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        clean = {k: v for k, v in os.environ.items() if k != sandbox.AGENT_SHELL}
        p = patch.dict(os.environ, clean, clear=True)
        p.start(); self.addCleanup(p.stop)

    def cli(self, *argv, shell=False, in_chat=False):
        out, err = io.StringIO(), io.StringIO()
        env = {sandbox.AGENT_SHELL: "1"} if shell else {}
        with patch.dict(os.environ, env), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err), \
                patch("sys.stdin", io.StringIO()):
            code = pip_cli.handle_command(self.cfg, list(argv), in_chat=in_chat)
        return code, out.getvalue(), err.getvalue()

    def personal(self, name="Planner"):
        code, text, err = self.cli("create", name, "--personal", "--goal", "Plan my week", "--json")
        self.assertEqual(code, 0, err)
        return json.loads(text)["pip"]["id"]

    def test_a_chat_cannot_create_or_approve_a_pip_from_its_shell(self):
        pip_id = self.personal()
        listed = lambda: json.loads(self.cli("list", "--personal", "--json")[1])
        shown = lambda: json.loads(self.cli("show", pip_id, "--json")[1])
        before, version = listed(), shown()["pip"]["current_version"]
        for argv in (("create", "Trader", "--personal", "--goal", "Trade for me", "--json"),
                     ("propose", pip_id, "--expected-version", "1", "--goal", "Changed", "--reason", "r"),
                     ("accept", pip_id, "proposal_x", "--expected-version", "1"),
                     ("run", pip_id), ("pause", pip_id), ("resume",), ("enable",),
                     ("setup", "accept", "setup_" + "1" * 32, "--expected-digest", "a" * 64, "--yes"), ("notify", pip_id, "--alerts", "off"),
                     ("schedule", pip_id, "--expected-version", "1", "--daily", "09:00", "--timezone", "UTC", "--reason", "r")):
            with self.subTest(argv=argv[:2]):
                code, text, err = self.cli(*argv, shell=True)
                self.assertEqual(code, 2, (text, err))
                self.assertIn("changing Pips is your decision", err)
                self.assertIn("pips_setup", err, "it says what to do instead")
        self.assertEqual(listed(), before, "nothing was created")
        self.assertEqual(shown()["pip"]["current_version"], version, "nothing was changed")

    def test_reading_still_works_and_the_digest_is_not_marked_seen_for_the_user(self):
        pip_id = self.personal()
        for argv in (("list", "--personal", "--json"), ("show", pip_id, "--json"), ("notify", pip_id, "--json"),
                     ("starters", "--json"), ("status", "--json")):
            with self.subTest(argv=argv[:1]):
                code, _, err = self.cli(*argv, shell=True)
                self.assertNotEqual(code, 2, err)
                self.assertNotIn("your decision", err)
        self.cli("digest", "--json", shell=True)
        code, text, err = self.cli("digest", "--json", "--keep")
        self.assertEqual(code, 0, err)
        self.assertIs(json.loads(text)["digest"]["first"], True, "the chat reading it never marks it seen for you")
        self.cli("digest", "--json")
        self.assertIs(json.loads(self.cli("digest", "--json", "--keep")[1])["digest"]["first"], False,
                      "premise: the user reading it does")

    def test_the_emergency_stop_works_from_anywhere(self):
        code, _, err = self.cli("stop", "--yes", "--json", shell=True)
        self.assertEqual(code, 0, err)

    def test_the_user_typing_pips_in_dgc_is_the_user(self):
        code, text, err = self.cli("create", "Mine", "--personal", "--goal", "Mine", "--json", shell=True, in_chat=True)
        self.assertEqual(code, 0, err)

    def test_every_allowed_name_is_a_real_read_command(self):
        """The allow list names only commands and actions that exist, and only reading ones."""
        commands = {}
        for action in pip_cli.parser()._actions:
            if isinstance(action, argparse._SubParsersAction):
                commands = action.choices
        for name in pip_cli._AGENT_SHELL_READS:
            self.assertIn(name, commands)
        for name, (dest, actions) in pip_cli._AGENT_SHELL_READ_ACTIONS.items():
            sub = next(a for a in commands[name]._actions if isinstance(a, argparse._SubParsersAction))
            self.assertEqual(sub.dest, dest, name)
            self.assertTrue(actions <= set(sub.choices), (name, actions - set(sub.choices)))
            self.assertFalse(actions & {"accept", "reject", "record", "propose", "install", "start", "prepare", "read"},
                             f"{name}: only reading actions")
        self.assertFalse(pip_cli._AGENT_SHELL_READS & {"create", "accept", "reject", "propose", "run", "enable", "resume",
                                                       "starter", "serve", "service", "schedule", "send"})


if __name__ == "__main__":
    unittest.main()
