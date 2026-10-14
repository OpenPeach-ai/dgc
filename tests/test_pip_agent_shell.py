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

    def test_a_dgc_started_from_a_chats_shell_is_not_the_user(self):
        # `printf '/pips create ...' | dgc --classic` from the model's shell reached /pips (in_chat)
        # carrying the marker, and the guard waved it through.
        argv = ("create", "Mine", "--personal", "--goal", "Mine", "--json")
        code, _, err = self.cli(*argv, shell=True, in_chat=True)
        self.assertEqual(code, 2, err)
        self.assertIn("changing Pips is your decision", err)
        code, _, err = self.cli(*argv, in_chat=True)
        self.assertEqual(code, 0, err)   # the DGC the user started has no marker: its /pips is theirs

    def test_memory_statements_are_read_here_but_never_recorded_or_revoked(self):
        parse = lambda *argv: pip_cli.parser().parse_args(list(argv))
        pip = "pip_" + "1" * 32
        self.assertTrue(pip_cli.agent_shell_allows(parse("memory", "statements", "list", pip)))
        self.assertTrue(pip_cli.agent_shell_allows(parse("memory", "statements", "anchor", pip)))
        for argv in (("memory", "statements", "record", pip, "--kind", "preference", "--title", "t", "--statement", "s",
                      "--reason", "r", "--request-key", "k", "--anchor-digest", "a" * 64, "--no-expiry"),
                     ("memory", "statements", "revoke", pip, "m1", "--expected-revision", "1", "--reason", "r"),
                     ("memory", "record", pip, "run_1", "0", "--source-digest", "d", "--reason", "r", "--request-key", "k"),
                     ("memory", "revoke", pip, "m1", "--expected-revision", "1", "--reason", "r")):
            with self.subTest(argv=argv[:3]):
                self.assertFalse(pip_cli.agent_shell_allows(parse(*argv)))

    def test_usage_has_no_daily_limit_to_set(self):
        """Pips have no daily token limit (founder, 2026-10-14): the option is gone, not ignored."""
        pip_id = self.personal()
        code, _, err = self.cli("usage", pip_id, "--daily-limit", "200k")
        self.assertNotEqual(code, 0)
        self.assertIn("--daily-limit", err)

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


class AgentShellBackendTests(unittest.TestCase):
    """`dgc serve`, or a script's SDK, started from the model's shell: it reads and stops, never decides."""

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        from dgc.headless import Backend
        self.backend = Backend.__new__(Backend)
        self.backend.config = self.cfg
        self.failures = []
        self.backend._pips_failure = lambda cmd, code, message: self.failures.append((code, message))

    def refused(self, cmd, marked=True):
        env = {k: v for k, v in os.environ.items() if k != sandbox.AGENT_SHELL}
        if marked:
            env[sandbox.AGENT_SHELL] = "1"
        with patch.dict(os.environ, env, clear=True):
            return self.backend._pips_policy_refusal(cmd)

    def test_decisions_are_refused_and_reads_and_stops_are_served(self):
        control = lambda kind: {"type": "pips_control", "request": {"type": kind, "request_id": "r"}}
        for cmd in (control("accept_pip_setup"), control("create_pip"), control("run_pip"), control("set_pip_feedback"),
                    control("propose_starter_pip"), control("import_pip_document"), control("set_pips_keep_running"),
                    control("set_pip_daily_cap"), {"type": "pips_enable", "enabled": True},
                    {"type": "pips_runtime", "action": "resume", "request_id": "r"}):
            with self.subTest(cmd=cmd.get("request", cmd)["type"]):
                self.assertTrue(self.refused(cmd))
        self.assertEqual({code for code, _ in self.failures}, {"agent_shell"})
        self.assertIn("changing Pips is your decision", self.failures[0][1])
        self.failures.clear()
        for cmd in (control("list_pips"), control("get_pip_usage"), control("inspect_pip_connection"),
                    control("list_pip_starters"), control("stop_pips"), control("export_pip"),
                    {"type": "pips_enable", "enabled": False}):
            with self.subTest(cmd=cmd.get("request", cmd)["type"]):
                self.assertFalse(self.refused(cmd))
        self.assertEqual(self.failures, [])
        self.assertFalse(self.refused(control("accept_pip_setup"), marked=False), "the user's own editor decides")


class OtherMarkedShellsTests(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        clean = {k: v for k, v in os.environ.items() if k != sandbox.AGENT_SHELL}
        p = patch.dict(os.environ, clean, clear=True)
        p.start(); self.addCleanup(p.stop)

    def test_a_subscription_engine_runs_marked_like_dgcs_own_shell(self):
        # Claude Code or Codex driving a chat has its own Bash tool; it is the model's shell too.
        from dgc import subscriptions
        seen = {}

        def popen(argv, **kwargs):
            seen.update(kwargs["env"])
            raise OSError("stop before launching")
        with patch.object(subscriptions, "preflight", return_value="/bin/true"), patch("subprocess.Popen", side_effect=popen):
            with self.assertRaises(subscriptions.EngineLaunchError):
                subscriptions.run_turn(subscriptions.ENGINES["claude"], "hi", str(self.root), env={sandbox.AGENT_SHELL: "0"})
        self.assertEqual(seen[sandbox.AGENT_SHELL], "1")
        if os.name != "nt":
            self.assertEqual(seen["PATH"].split(os.pathsep)[0], sandbox.own_dgc_directory(),
                             "and finds this build's dgc first")

    def test_the_users_own_hooks_and_gate_are_not_marked_as_the_models(self):
        from types import SimpleNamespace
        from dgc import hooks
        from dgc.agent import Agent
        probe = 'printf "marker=%s" "${DGC_AGENT_SHELL:-none}"'
        _, out, _ = hooks._run_one(probe, b"{}", self.cfg, self.root, 10)
        self.assertIn("marker=none", out)
        with patch.dict(os.environ, {sandbox.AGENT_SHELL: "1"}):
            _, out, _ = hooks._run_one(probe, b"{}", self.cfg, self.root, 10)
        self.assertIn("marker=1", out, "a DGC the model started keeps its children marked")
        agent = Agent.__new__(Agent)
        agent.autonomous_gate, agent.config = probe, self.cfg
        agent.ctx = SimpleNamespace(project_root=self.root)
        agent._safe_text = lambda value: value
        seen = {}

        def popen(argv, **kwargs):
            seen.update(kwargs["env"])
            raise OSError("stop before launching")
        with patch("subprocess.Popen", side_effect=popen):
            agent._run_autonomous_gate()
        self.assertNotIn(sandbox.AGENT_SHELL, seen, "the gate is the user's command")


if __name__ == "__main__":
    unittest.main()


@unittest.skipIf(os.name == "nt", "the shell keeps the user's PATH on Windows")
class OwnDgcTests(unittest.TestCase):
    """The guard lives in the `dgc` CLI, so the model's shell must run a `dgc` that has it: this
    build, not an older install earlier on the user's PATH or a `dgc` folder in the project."""

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        base = Path(temp.name)
        self.ctx = Ctx(base / "project")
        (base / "project" / "dgc").mkdir(parents=True)                      # a project with its own dgc folder
        (base / "project" / "dgc" / "__init__.py").write_text('raise SystemExit("the project\'s dgc")\n')
        old = base / "old-bin"
        old.mkdir()
        (old / "dgc").write_text("#!/bin/sh\necho an-old-dgc-without-the-guard\n")
        (old / "dgc").chmod(0o755)
        clean = {k: v for k, v in os.environ.items() if k != sandbox.AGENT_SHELL}
        clean.update(PATH=os.pathsep.join([str(old), clean.get("PATH", "")]), HOME=str(base / "home"))
        clean.pop("DGC_HOME", None)
        p = patch.dict(os.environ, clean, clear=True)
        p.start(); self.addCleanup(p.stop)

    def test_the_models_shell_runs_this_builds_dgc_and_its_guard(self):
        import dgc
        out = tools.bash({"command": "dgc --version"}, self.ctx)
        self.assertIn(f"dgc {dgc.__version__}", out)
        self.assertNotIn("an-old-dgc", out)
        self.assertNotIn("the project's dgc", out)
        out = tools.bash({"command": "dgc pips create Planner --personal --goal 'Plan my week'; echo exit=$?"}, self.ctx)
        self.assertIn("exit=2", out)
        self.assertIn("chat", out.lower(), "refused by the guard, with the reason")

    def test_a_command_the_user_typed_keeps_their_own_path(self):
        self.assertIn("an-old-dgc-without-the-guard", tools.direct_bash("dgc --version", self.ctx))
        self.assertNotIn(sandbox.own_dgc_directory() or "-", sandbox.tool_env(agent=False)["PATH"])

    def test_the_launcher_is_made_again_if_something_cleans_it_away(self):
        import shutil
        first = sandbox.own_dgc_directory()
        shutil.rmtree(first)
        again = sandbox.own_dgc_directory()
        self.assertTrue(Path(again, "dgc").is_file())
        self.assertEqual(sandbox.tool_env()["PATH"].split(os.pathsep)[0], again)
        self.assertEqual(sandbox.tool_env()["PATH"].count(again), 1, "never added twice")

