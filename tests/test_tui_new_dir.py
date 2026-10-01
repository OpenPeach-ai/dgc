"""`/new DIR` in the full-screen terminal: an agent in another folder.

It opens the way `dgc serve` opens a chat in another folder -- that folder's project root, config,
trust, rules, named agents, skills, MCP servers and saved chats -- behind the terminal's own trust
gate, which never let a folder it was not told to trust run anything. A bare `/new`, Ctrl+N, the
welcome card and the dashboard's "+ New agent" keep meaning the launch project.
"""
import contextlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

# Hermetic like tests/test_checkout_trust.py: redirect HOME before any dgc module reads it.


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
            "tests/test_tui_new_dir.py needs HOME redirected before dgc is imported — run it "
            "through tests/run_tests.py or with HOME=<tmp>")
else:
    _ISOLATED_HOME = tempfile.TemporaryDirectory(prefix="dgc-tui-new-dir-home-")
    os.environ["HOME"] = os.path.realpath(_ISOLATED_HOME.name)
    os.environ["USERPROFILE"] = os.environ["HOME"]
    os.environ.pop("XDG_CONFIG_HOME", None)
    os.environ.pop("XDG_DATA_HOME", None)

from dgc import config as config_module  # noqa: E402
from dgc import peers, sessions, trust  # noqa: E402
from dgc import tui as tui_mod  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config  # noqa: E402
from dgc.permissions import PermissionEngine  # noqa: E402

_GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
            "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid",
            "GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
_ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def _git(cwd, *args):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                   env={**os.environ, **_GIT_ENV})


def _repo(path: Path, branch: str, *, deny=(), files=None) -> Path:
    (path / ".dgc").mkdir(parents=True, exist_ok=True)
    if deny:
        (path / ".dgc" / "permissions.json").write_text(json.dumps({"deny": list(deny)}))
    (path / "README.md").write_text("fixture\n")
    for rel, text in (files or {}).items():
        target = path / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)
    _git(path, "init", "-q", "-b", branch)
    _git(path, "add", "-A")
    _git(path, "commit", "-qm", "init")
    return path


class _QuietUI:
    non_interactive = False

    def __getattr__(self, name):
        if name.startswith("_") or name == "console":
            raise AttributeError(name)
        return lambda *args, **kwargs: None


@unittest.skipUnless(shutil.which("git"), "needs git")
class NewDirTest(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix="dgc-tui-new-dir-")).resolve()
        self.addCleanup(shutil.rmtree, tmp, True)
        self.tmp = tmp
        self.launch = _repo(tmp / "launch", "main", deny=["Bash(rm -rf *)"],
                            files={"src/app.py": "x = 1\n"})
        self.other = _repo(tmp / "other", "feature", deny=["Bash(curl *)"], files={
            "DGC.md": "OTHER-PROJECT-MEMORY: answer in haiku.\n",
            ".dgc/agents/reviewer.md": "---\nname: reviewer\ndescription: reviews\n---\nReview it.\n",
            ".dgc/skills/other-skill/SKILL.md": ("---\nname: other-skill\ndescription: a skill\n---\n"
                                                 "Do the other thing.\n")})
        self.plain = tmp / "plain"
        self.plain.mkdir()
        (self.plain / "DGC.md").write_text("PLAIN-MEMORY\n")
        self.wild = _repo(tmp / "wild", "main", deny=["Bash(wget *)"])
        user_dgc = tmp / "user-dgc"
        user_dgc.mkdir()
        for name, value in (("USER_HOME", user_dgc), ("USER_CONFIG", user_dgc / "config.json"),
                            ("USER_SECRETS", user_dgc / "secrets.json")):
            patcher = patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.user_config = user_dgc / "config.json"
        self.user_config.write_text(json.dumps({
            "model": "fixture", "base_url": "http://localhost.invalid/v1", "mode": "auto",
            "trusted_dirs": [str(self.launch), str(self.other), str(self.plain)],
            "fleet_worktree_root": str(tmp / "fleet"), "subagent_worktree_root": str(tmp / "tasks"),
            "suggest": False, "artifact_autostart": False, "mcp_servers": {}, "notes": False}))
        scoped = patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        self.config = Config(project_root=self.launch)
        self.agent = Agent(self.config, _QuietUI())
        self.addCleanup(self.agent.mcp.stop_all)

    # ---- helpers -------------------------------------------------------------------------------
    def tui(self, width=120, height=30):
        from prompt_toolkit.application.current import create_app_session
        from prompt_toolkit.data_structures import Size
        from prompt_toolkit.input.defaults import create_pipe_input
        from prompt_toolkit.output import DummyOutput

        class Output(DummyOutput):
            def get_size(self):
                return Size(rows=height, columns=width)

        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        pipe = stack.enter_context(create_pipe_input())
        stack.enter_context(create_app_session(input=pipe, output=Output()))
        ui = tui_mod.TUI(self.config, agent=self.agent)
        ui._width, ui._height = width, height
        self.addCleanup(ui._shutdown_fleet)
        return ui

    @staticmethod
    def decide(agent, command: str) -> str:
        """What the agent's own permission check answers: saved rules plus the session's."""
        config = agent.config
        extra = getattr(config, "session_permissions", None) or {}
        rules = {action: [*(config.permissions.get(action, []) or []), *(extra.get(action, []) or [])]
                 for action in ("allow", "ask", "deny")}
        return PermissionEngine(agent.mode, rules, config.project_root).decide(
            "bash", {"command": command})[0]

    def opened(self, ui, raw: str):
        """`/new raw` as the composer sends it: Enter has already emptied the composer."""
        ui.input_buf.reset()
        before = len(ui._sessions)
        ui._handle_slash(f"/new {raw}")
        self.assertEqual(len(ui._sessions), before + 1, ui._flash_msg)
        return ui.active

    def plain_text(self, value) -> str:
        return _ANSI.sub("", str(getattr(value, "value", value)))

    # ---- the launch project ----------------------------------------------------------------------
    def test_a_bare_new_is_still_ctrl_n_with_the_same_words(self):
        ui = self.tui()
        ui.input_buf.reset()
        ui._handle_slash("/new")
        sess = ui.active
        self.assertEqual(len(ui._sessions), 2)
        self.assertEqual(sess.agent.session_root, self.launch)
        self.assertEqual(sess.workspace_kind, "managed")
        self.assertRegex(ui._flash_msg, r"^new agent · 2 agents · isolated dgc/fleet-agent-2-[0-9a-f]{10}$")
        self.assertLess(ui._flash_until - time.monotonic(), 3.0, "the launch flash keeps its default time")

    def test_a_folder_of_the_launch_project_is_ctrl_n(self):
        ui = self.tui()
        for raw in (".", "src", "./src/", str(self.launch), f'"{self.launch}"'):
            with self.subTest(raw=raw):
                sess = self.opened(ui, raw)
                self.assertEqual(sess.agent.session_root, self.launch)
                self.assertEqual(sess.workspace_kind, "managed", "isolated, as Ctrl+N is")
                self.assertRegex(ui._flash_msg,
                                 r"^new agent · \d+ agents · isolated dgc/fleet-agent-\d+-[0-9a-f]{10}$",
                                 "exactly what Ctrl+N says")
                self.assertIsNone(ui._overlay, "no trust card for the launch project")

    # ---- refusals --------------------------------------------------------------------------------
    def test_a_folder_that_cannot_be_opened_opens_nothing_and_the_command_comes_back(self):
        ui = self.tui()
        (self.tmp / "fleet" / "dgc-fleet-x").mkdir(parents=True)
        (self.tmp / "tasks" / "task-1").mkdir(parents=True)
        (config_module.USER_HOME / "plugins").mkdir(parents=True)
        cases = [
            (str(self.tmp / "missing"), "no such folder"),
            (str(self.launch / "README.md"), "that's a file"),
            (str(config_module.USER_HOME / "plugins"), "DGC's own storage"),
            (str(self.tmp / "fleet" / "dgc-fleet-x"), "DGC's own storage"),
            (str(self.tmp / "tasks" / "task-1"), "DGC's own storage"),
            ("~no-such-user-dgc-test/x", "can't open that folder"),
            ('""', "/new takes a folder"),
        ]
        if hasattr(os, "geteuid") and os.geteuid() != 0:
            locked = self.tmp / "locked"
            locked.mkdir()
            locked.chmod(0)
            self.addCleanup(locked.chmod, 0o700)
            cases.append((str(locked), "isn't readable"))
        for raw, reason in cases:
            with self.subTest(raw=raw):
                ui.input_buf.reset()
                ui._handle_slash(f"/new {raw}")
                self.assertEqual(len(ui._sessions), 1, "nothing was opened")
                self.assertIsNone(ui._overlay)
                self.assertIn(reason, ui._flash_msg)
                self.assertEqual(ui.input_buf.text, f"/new {raw}", "the command is back to fix")

    def test_a_pinned_dgc_opens_no_other_folder(self):
        ui = self.tui()
        with patch.dict(os.environ, {"DGC_PROJECT_ROOT": str(self.launch)}):
            ui.input_buf.reset()
            ui._handle_slash(f"/new {self.other}")
            self.assertEqual(len(ui._sessions), 1)
            self.assertIn("DGC_PROJECT_ROOT", ui._flash_msg)
            ui._open_dashboard()
            self.assertNotIn("folder", [row["value"][0] for row in ui._overlay["rows"]],
                             "the dashboard does not offer what cannot work")
            ui._close_overlay()
            ui._handle_slash("/new")
            self.assertEqual(len(ui._sessions), 2, "a bare /new still opens an agent here")

    # ---- trust -----------------------------------------------------------------------------------
    def test_an_untrusted_folder_asks_first_and_nothing_runs_before_the_answer(self):
        ui = self.tui()
        built, spawned = [], []
        real_agent, real_popen = tui_mod.Agent, subprocess.Popen

        class Recording(real_agent):
            def __init__(inner, config, frontend):
                built.append(Path(config.project_root))
                super().__init__(config, frontend)

        def popen(*args, **kwargs):
            spawned.append(str(kwargs.get("cwd") or os.getcwd()))
            return real_popen(*args, **kwargs)

        disk = self.user_config.read_bytes()
        with patch.object(tui_mod, "Agent", Recording), patch("subprocess.Popen", popen):
            ui.input_buf.reset()
            ui._handle_slash(f"/new {self.wild}")
            self.assertEqual(built, [], "an agent was built before the folder was trusted")
            self.assertEqual([cwd for cwd in spawned if cwd.startswith(str(self.wild))], [],
                             "something ran in the folder before it was trusted")
            ov = ui._overlay
            self.assertEqual(ov["title"], "Open a folder")
            labels = [row["label"] for row in ui._overlay_rows()]
            self.assertEqual(len(labels), 2)
            self.assertIn("Trust it and open", labels[0])
            self.assertIn("Cancel", labels[1])
            header = " ".join(line.plain for line in ov["header"])
            self.assertIn(trust.TRUST_QUESTION, header)
            self.assertIn("wild", header)
            ui.input_buf.text = "cancel"
            self.assertEqual([row["label"] for row in ui._overlay_rows()], labels,
                             "typed characters never filter which row Enter picks")
            ui.input_buf.reset()
            ov["sel"] = 1
            ui._overlay_select()                                     # Cancel
            self.assertEqual(len(ui._sessions), 1)
            self.assertIn("not opened", ui._flash_msg)
            ui._handle_slash(f"/new {self.wild}")
            ui._close_overlay()                                      # what Esc does
            self.assertEqual(len(ui._sessions), 1)
            self.assertEqual(built, [])
        self.assertEqual(self.user_config.read_bytes(), disk, "Cancel and Esc wrote nothing")
        self.assertFalse(trust.is_trusted(Config(project_root=self.wild), self.wild))

        ui._handle_slash(f"/new {self.wild}")
        ui._overlay_select()                                         # Trust it and open (row 0)
        self.assertEqual(len(ui._sessions), 2, ui._flash_msg)
        sess = ui.active
        stored = json.loads(self.user_config.read_text())["trusted_dirs"]
        self.assertIn(os.path.realpath(self.wild), stored, "trust is remembered, by its real path")
        self.assertEqual(sess.agent.session_root, self.wild)
        self.assertEqual(sess.workspace_kind, "folder")
        self.assertEqual(self.decide(sess.agent, "wget http://x"), "deny", "the folder's own rules")
        self.assertEqual(self.decide(sess.agent, "rm -rf build"), "allow",
                         "the launch project's rules are not the folder's")

    def test_a_folder_whose_trust_covers_far_more_defaults_to_cancel(self):
        ui = self.tui()
        home = Path(os.path.expanduser("~")).resolve()
        ui._handle_slash("/new ~")
        ov = ui._overlay
        self.assertIsNotNone(ov, ui._flash_msg)
        rows = ui._overlay_rows()
        self.assertIn("Cancel", rows[0]["label"], "Enter on a broad folder must not trust it")
        self.assertIn("home directory", " ".join(line.plain for line in ov["header"]))
        ui._overlay_select()
        self.assertEqual(len(ui._sessions), 1)
        self.assertFalse(trust.is_trusted(Config(project_root=home), home))

    def test_the_builder_itself_refuses_an_untrusted_folder(self):
        ui = self.tui()
        self.assertIsNone(ui._new_session(home=self.wild, in_place=True))
        self.assertIn("isn't trusted", ui._flash_msg)
        self.assertEqual(len(ui._sessions), 1)

    def test_the_card_fits_and_keeps_both_choices_on_a_small_terminal(self):
        for width, height in ((120, 30), (80, 24), (60, 20)):
            with self.subTest(size=(width, height)):
                ui = self.tui(width, height)
                ui._handle_slash(f"/new {self.wild}")
                rendered = self.plain_text(ui._render_overlay())
                self.assertIn("Trust it and open", rendered)
                self.assertIn("Cancel", rendered)
                self.assertLessEqual(len(rendered.splitlines()), ui._overlay_height(),
                                     "the card is clipped by its own window")
                self.assertEqual(sorted(ui._overlay["_rowmap"].values()), [0, 1])
                if height >= 30:
                    self.assertIn("Your answer is remembered", rendered)
                ui._close_overlay()

    # ---- an agent in another folder --------------------------------------------------------------
    def test_a_folder_agent_brings_its_own_project_and_keeps_the_runs_key(self):
        self.config.set_runtime_secret("api_key", "sk-launch-runtime")
        ui = self.tui()
        sess = self.opened(ui, str(self.other))
        agent, config = sess.agent, sess.agent.config
        self.assertEqual(sess.workspace_kind, "folder", "the first agent works in the folder itself")
        self.assertEqual(Path(config.project_root), self.other)
        self.assertEqual(Path(sess.workspace_path), self.other)
        self.assertEqual(agent.session_root, self.other)
        self.assertIsNone(getattr(config, "_trust_origin", None), "never the launch project's trust")
        self.assertEqual(self.decide(agent, "curl https://x"), "deny")
        self.assertEqual(self.decide(agent, "rm -rf build"), "allow")
        self.assertEqual(agent.mode, "auto")
        self.assertEqual(config.api_key, "sk-launch-runtime",
                         "a --api-key-env key: every request would have gone out without it")
        self.assertIn("reviewer", agent.agent_defs)
        self.assertIn("other-skill", agent.skills)
        self.assertIn("OTHER-PROJECT-MEMORY", str(agent.messages[0].get("content")))
        self.assertEqual(agent.mcp.root, self.other, "its MCP servers start in that folder")
        self.assertEqual(Path(agent.session_file).parent, sessions.project_dir(self.other))
        self.assertIn("in ", ui._flash_msg)
        self.assertIn("other", ui._flash_msg)
        self.assertGreater(ui._flash_until - time.monotonic(), 4.0)

    def test_paths_are_read_from_the_agent_on_screen(self):
        ui = self.tui()
        self.opened(ui, "../other")                     # relative to the launch project
        self.assertEqual(ui.active.agent.session_root, self.other)
        self.opened(ui, "'../plain'")                   # now relative to other, quotes removed
        self.assertEqual(ui.active.agent.session_root, self.plain.resolve())
        nested = self.other / "pkg" / "deep"
        nested.mkdir(parents=True)
        ui._switch_to(1)
        before = len(ui._sessions)
        ui._handle_slash("/new pkg/deep")              # inside other: its project root is other
        self.assertEqual(len(ui._sessions), before + 1)
        self.assertEqual(ui.active.agent.session_root, self.other)

    def test_a_second_agent_in_an_occupied_checkout_is_isolated(self):
        ui = self.tui()
        first = self.opened(ui, str(self.other))
        second = self.opened(ui, str(self.other))
        self.assertEqual(first.workspace_kind, "folder")
        self.assertEqual(second.workspace_kind, "managed", "never two agents in one checkout")
        self.assertRegex(second.workspace_branch, r"^dgc/fleet-other-agent-3-[0-9a-f]{10}$")
        self.assertEqual(second.agent.session_root, self.other)
        self.assertNotEqual(Path(second.agent.config.project_root), self.other)
        self.assertIn("another agent here already works in that checkout", ui._flash_msg)
        self.assertEqual(self.decide(second.agent, "curl https://x"), "deny", "the folder's rules")
        self.assertEqual(self.decide(second.agent, "rm -rf build"), "allow")
        sidecar = sessions.load_workspace(second.agent.session_file, self.other)
        self.assertEqual(sidecar["branch"], second.workspace_branch)
        second.agent.set_mode("plan")
        self.assertEqual(second.agent.exit_plan("auto"), "auto", "it answers for its folder's trust")

        # Changed work is retained on close, then /resume in the folder reattaches it.
        (second.workspace.project_root / "work.txt").write_text("keep me")
        self.assertTrue(second.agent.name_session("isolated work"))
        path, kept = second.agent.session_file, second.workspace.path
        ui._close_session(ui._sessions.index(second))
        self.assertTrue(kept.exists(), "changed work is retained")
        ui._switch_to(ui._sessions.index(first))
        ui._handle_slash("/resume")
        rows = ui._overlay_rows()
        target = next(i for i, row in enumerate(rows) if "isolated work" in row["label"])
        ui._overlay["sel"] = target
        ui._overlay_select()
        reopened = ui.active
        self.assertEqual(Path(reopened.agent.session_file), Path(path))
        self.assertEqual(reopened.workspace_kind, "managed")
        self.assertEqual(reopened.workspace.path, kept, "reattached to the same checkout")
        self.assertEqual(reopened.agent.session_root, self.other)

        # An untouched one is removed on close, its sidecar settled in the folder's own chats.
        untouched = self.opened(ui, str(self.other))
        self.assertEqual(untouched.workspace_kind, "managed")
        gone, branch = untouched.workspace.path, untouched.workspace_branch
        ui._close_session(ui._sessions.index(untouched))
        self.assertIn(f"removed untouched {branch}", ui._flash_msg)
        self.assertFalse(gone.exists())

    def test_a_second_agent_in_a_non_git_folder_shares_it_and_they_see_each_other(self):
        ui = self.tui()
        first = self.opened(ui, str(self.plain))
        second = self.opened(ui, str(self.plain))
        self.assertEqual(first.workspace_kind, "folder")
        self.assertEqual(second.workspace_kind, "shared")
        self.assertIn("non-Git shared checkout · writes serialized", ui._flash_msg)
        found = first.agent._peers_here()
        mine = [record for record in found if record.get("pid") == os.getpid()]
        self.assertEqual(len(mine), 1, "an agent of this terminal in the same folder")
        self.assertTrue(peers.model_line(found), "and the model is told")
        self.assertEqual([r for r in ui._sessions[0].agent._peers_here() if r.get("pid") == os.getpid()],
                         [], "an agent elsewhere is not in this folder")
        ui._switch_to(0)
        ui._handle_slash("/new")                             # an isolated fleet agent of a Git project
        self.assertEqual([r for r in ui.active.agent._peers_here() if r.get("pid") == os.getpid()],
                         [], "an isolated worktree was told it shared a checkout")
        second.agent.session_file = first.agent.session_file
        self.assertIn("open in another chat in this window",
                      second.agent._held_session_message("Try again."))

    # ---- the launch project's own checkouts ------------------------------------------------------
    def test_a_ctrl_n_agent_keeps_auto_through_a_plan_and_a_reopen(self):
        ui = self.tui()
        ui._handle_slash("/new")
        agent = ui.active.agent
        agent.set_mode("plan")
        self.assertEqual(agent.exit_plan("auto"), "auto")
        agent._restore_session_mode({"mode": "auto"})
        self.assertEqual(agent.mode, "auto")

    def test_worktree_from_a_ctrl_n_agent_keeps_the_projects_rules(self):
        ui = self.tui()
        ui._handle_slash("/new")
        ui._handle_slash("/worktree feat")
        sess = ui.active
        self.assertEqual(sess.workspace_kind, "manual", ui._flash_msg)
        self.assertEqual(sess.agent.session_root, self.launch)
        self.assertEqual(self.decide(sess.agent, "rm -rf build"), "deny")
        self.assertEqual(sess.agent.mode, "auto")

    def test_worktree_in_a_folder_agent_belongs_to_that_folder(self):
        ui = self.tui()
        self.opened(ui, str(self.other))
        ui._handle_slash("/worktree feat")
        sess = ui.active
        self.assertEqual(sess.workspace_kind, "manual", ui._flash_msg)
        self.assertEqual(Path(sess.workspace_path), (self.tmp / "other-feat").resolve())
        self.assertFalse((self.tmp / "launch-feat").exists(), "not a worktree of the launch project")
        self.assertEqual(sess.agent.session_root, self.other)
        self.assertEqual(sessions.load_workspace(sess.agent.session_file, self.other)["kind"], "manual")
        self.assertEqual(self.decide(sess.agent, "curl https://x"), "deny")
        ui._handle_slash("/clear")
        self.assertEqual(sessions.load_workspace(sess.agent.session_file, self.other)["kind"], "manual",
                         "/clear keeps the association, in the folder's own chats")

    def test_resume_in_a_folder_agent_lists_and_loads_that_folders_chats(self):
        ui = self.tui()
        self.assertTrue(self.agent.name_session("launch chat"))
        sess = self.opened(ui, str(self.other))
        older = sessions.new_path(self.other)
        sessions.save(older, [{"role": "system", "content": "s"},
                              {"role": "user", "content": "an older question"}], self.other,
                      name="older other chat")
        ui._handle_slash("/resume")
        labels = [row["label"] for row in ui._overlay_rows()]
        self.assertTrue(any("older other chat" in label for label in labels), labels)
        self.assertFalse(any("launch chat" in label for label in labels), labels)
        self.assertIn("other", ui._overlay["title"])
        ui._overlay["sel"] = next(i for i, label in enumerate(labels) if "older other chat" in label)
        ui._overlay_select()
        self.assertEqual(Path(sess.agent.session_file), Path(older), "it loads into this agent")

    def test_trust_here_means_the_agents_project(self):
        ui = self.tui()
        ui._handle_slash("/new")
        shown = []
        ui._append_md = shown.append
        ui._handle_slash("/trust")
        self.assertIn("covers this project", shown[-1], "a fleet agent's project is the launch project")

    # ---- user-wide state -------------------------------------------------------------------------
    def test_a_rule_added_in_one_agent_binds_every_other_at_once(self):
        ui = self.tui()
        ui._handle_slash("/new")
        self.opened(ui, str(self.other))
        fleet, folder = ui._sessions[1].agent, ui._sessions[2].agent
        self.assertEqual(self.decide(fleet, "nc -l 9"), "allow")
        ui._switch_to(0)
        ui._handle_slash("/permissions deny Bash(nc *)")
        self.assertEqual(self.decide(fleet, "nc -l 9"), "deny", "the fleet agent ran what was denied")
        self.assertEqual(self.decide(folder, "nc -l 9"), "deny", "the folder agent ran it")
        self.assertEqual(self.decide(folder, "curl https://x"), "deny", "its own rules survive")
        ui._switch_to(2)
        ui._handle_slash("/permissions ask Bash(git push *)")      # saved by the folder agent
        self.assertEqual(self.decide(self.agent, "git push origin main"), "ask")
        self.assertEqual(self.decide(fleet, "git push origin main"), "ask")

        # A revoked folder reaches the agent that answers for it, too.
        ui._switch_to(2)
        ui._append_md = lambda text: None
        ui._handle_slash(f"/trust revoke {self.launch}")
        fleet.set_mode("plan")
        self.assertEqual(fleet.exit_plan("auto"), "default", "trust revoked elsewhere still held")

    def test_new_agents_keep_the_runs_restrictions_but_not_its_grants(self):
        from dgc.cli import apply_run_flags
        args = SimpleNamespace(sandbox="read-only", allow_tool=["Bash(ls *)"], add_dir=[str(self.plain)])
        apply_run_flags(self.config, args, SimpleNamespace(error=self.fail))
        ui = self.tui()
        for sess in (self.opened(ui, ""), self.opened(ui, str(self.other))):
            config = sess.agent.config
            with self.subTest(kind=sess.workspace_kind):
                self.assertIs(config.data.get("sandbox"), True)
                self.assertIs(config.data.get("sandbox_read_only"), True)
                self.assertTrue({"sandbox", "sandbox_read_only"} <= set(config._ephemeral_keys))
                self.assertEqual(config.session_permissions["deny"],
                                 self.config.session_permissions["deny"])
                self.assertIn("Python", config.session_permissions["deny"])
                self.assertEqual(config.session_permissions["allow"], [],
                                 "an --allow-tool or --add-dir was for the launch project only")
        self.assertNotIn("sandbox", json.loads(self.user_config.read_text()),
                         "this run's sandbox is never saved as the user's")

    def test_an_agent_built_while_a_rule_is_saved_still_takes_it(self):
        """Building an agent connects its MCP servers, which takes seconds; a rule another agent saved
        meanwhile reached only the agents already open."""
        ui = self.tui()
        test = self
        real = tui_mod.Agent

        class SavedMeanwhile(real):
            def __init__(inner, config, frontend):
                super().__init__(config, frontend)
                test.config.permissions["deny"].append("Bash(nc *)")    # the launch agent saves
                test.config.save()

        with patch.object(tui_mod, "Agent", SavedMeanwhile):
            sess = self.opened(ui, str(self.other))
        self.assertEqual(self.decide(sess.agent, "nc -l 9"), "deny")

    def test_a_reopened_chat_in_a_folder_agent_never_raises_its_mode(self):
        stored = json.loads(self.user_config.read_text())
        stored["mode"] = "default"
        self.user_config.write_text(json.dumps(stored))
        ui = self.tui()
        sess = self.opened(ui, str(self.other))
        self.assertEqual(sess.agent.mode, "default")
        for name, mode in (("ran in auto", "auto"), ("was planning", "plan")):
            sessions.save(sessions.new_path(self.other),
                          [{"role": "system", "content": "s"}, {"role": "user", "content": name}],
                          self.other, name=name, mode=mode)
        expected = {"ran in auto": "default", "was planning": "plan"}
        for name, mode in expected.items():
            with self.subTest(chat=name):
                ui._handle_slash("/resume")
                labels = [row["label"] for row in ui._overlay_rows()]
                ui._overlay["sel"] = next(i for i, label in enumerate(labels) if name in label)
                ui._overlay_select()
                self.assertEqual(sess.agent.mode, mode,
                                 "a reopened chat lowers the mode, never raises it")

    # ---- peers -----------------------------------------------------------------------------------
    def test_the_note_names_every_agent_and_any_of_them_refuses_a_takeover(self):
        ui = self.tui()
        self.addCleanup(peers.withdraw)
        folder = self.opened(ui, str(self.other))
        ui._announce_peer("idle")
        note = json.loads((peers.peers_dir() / f"{os.getpid()}.json").read_text())
        listed = {item["project_root"] for item in note.get("sessions", [])}
        self.assertIn(str(self.launch), listed)
        self.assertIn(str(self.other), listed)
        ui._switch_to(0)                                     # the folder agent is in the background
        wanted = str(folder.agent.session_file)
        self.assertTrue(peers.request_release({"pid": os.getpid(), "session": wanted}, wanted))
        ui._consider_release()
        answer = peers.release_answer(os.getpid())
        self.assertIsNotNone(answer, "an ask for a background agent's session went unanswered")
        self.assertIs(answer["granted"], False)

    # ---- what the terminal shows -----------------------------------------------------------------
    def test_the_branch_follows_the_agent_on_screen(self):
        ui = self.tui()
        self.assertEqual(ui._git_branch(), "main")
        self.opened(ui, str(self.other))
        self.assertEqual(ui._git_branch(), "feature", "the previous folder's branch was shown")
        self.assertIsInstance(ui._branch_cache, tuple)
        ui._switch_to(0)
        self.assertEqual(ui._git_branch(), "main")

    def test_new_dir_runs_while_a_turn_runs(self):
        from dgc.commands import resolve_command
        spec = resolve_command("new", "tui")
        self.assertTrue(spec.available_while_running)
        self.assertEqual((spec.usage, spec.accepts_args), ("", False), "nothing leaks to other surfaces")
        ui = self.tui()
        launch = ui.active
        launch._turn.set()
        try:
            self.assertEqual(ui._dispatch_composer_text(f"/new {self.other}"), "local-command")
        finally:
            launch._turn.clear()
        self.assertEqual(len(ui._sessions), 2, ui._flash_msg)
        self.assertNotIn("waits for this turn", ui._flash_msg)

    def test_the_dashboard_keeps_its_rows_and_offers_another_folder(self):
        ui = self.tui()
        self.opened(ui, str(self.other))
        ui.input_buf.text = "a draft I was writing"        # in the folder agent's composer
        ui._open_dashboard()
        rows = ui._overlay["rows"]
        kinds = [row["value"][0] for row in rows]
        self.assertEqual(kinds[0], "new")
        self.assertIn("launch", rows[0]["desc"], "+ New agent names the launch project")
        self.assertEqual(kinds[1], "switch")
        at = kinds.index("folder")
        self.assertEqual(set(kinds[1:at]), {"switch"}, "after every live agent")
        self.assertTrue(set(kinds[at + 1:]) <= {"open"}, "before the saved chats")
        folder_row = next(row for row in rows if row["value"][0] == "switch"
                          and row["value"][1].agent.session_root == self.other)
        self.assertIn("in ", folder_row["desc"])
        self.assertIn("other", folder_row["desc"])
        ui._overlay["sel"] = at
        ui._overlay_select()
        self.assertIsNotNone(ui._input, "it asks for the folder")
        self.assertIn("relative to", ui._input["prompt"])
        cb = ui._input["cb"]
        ui._input = None
        ui.input_buf.reset()                                 # what Enter does before calling back
        cb("../plain")                                       # relative to the folder agent on screen
        self.assertEqual(ui.active.agent.session_root, self.plain.resolve())
        self.assertEqual(ui._sessions[1].draft, "a draft I was writing",
                         "the draft stayed with the agent it was written in")

    def test_switching_to_another_project_closes_a_files_pane(self):
        ui = self.tui()
        self.opened(ui, str(self.other))
        ui._handle_slash("/new")                             # a fleet agent of the launch project
        ui._switch_to(0)
        ui._open_files("")
        self.assertEqual(getattr(ui._pane, "kind", ""), "files")
        ui._switch_to(2)
        self.assertEqual(getattr(ui._pane, "kind", ""), "files", "the same project keeps it")
        ui._switch_to(1)
        self.assertIsNone(ui._pane, "an @path from the launch project would reach the folder agent")

    def test_closing_a_folder_agent_stops_it_and_says_where_its_chats_are(self):
        ui = self.tui()
        sess = self.opened(ui, str(self.other))
        self.assertTrue(sess.agent.name_session("other work"))
        stopped = []
        real_stop = sess.agent.mcp.stop_all
        sess.agent.mcp.stop_all = lambda: (stopped.append(True), real_stop())[1]
        ui._close_session(ui._sessions.index(sess))
        self.assertTrue(stopped, "its MCP servers stop with it")
        self.assertIn("closed agent in", ui._flash_msg)
        self.assertIn("/resume", ui._flash_msg)
        listed = [Path(row[0]) for row in sessions.listing(self.other)]
        self.assertIn(Path(sess.agent.session_file), listed, "its chat stays in the folder's list")

    def test_the_welcome_card_and_status_name_the_folder(self):
        ui = self.tui(120, 40)
        self.opened(ui, str(self.other))
        card = self.plain_text(ui._welcome_card())
        title = next(line for line in card.splitlines() if "Vibe DGC" in line)
        self.assertIn("other", title)
        self.assertIn("this folder (in place)", ui._status_block())
        ui._handle_slash("/new")                             # a fleet agent of the launch project
        block = ui._status_block()
        self.assertIn("project", block)
        self.assertIn(str(self.launch), block)

    def test_the_classic_terminal_says_where_new_dir_works_and_keeps_the_chat(self):
        from dgc.cli import CLI
        errors, infos, resets = [], [], []
        cli = object.__new__(CLI)
        cli.config = SimpleNamespace(project_root=self.launch)
        cli.ui = SimpleNamespace(error=errors.append, info=infos.append)
        cli.agent = SimpleNamespace(reset=lambda: resets.append(True), session_file="kept")
        self.assertTrue(cli.handle_slash(f"/new {self.other}"))
        self.assertEqual(resets, [], "the chat was reset and the folder ignored")
        self.assertEqual(cli.agent.session_file, "kept")
        self.assertIn("full-screen terminal", errors[-1])
        self.assertIn("dgc --classic", errors[-1])
        cli.handle_slash('/new "~/my work"')
        self.assertIn("cd ~/'my work' && dgc --classic", errors[-1], "a command that works as typed")
        cli.handle_slash("/new")
        self.assertEqual(resets, [True], "a bare /new still starts a new chat")

    def test_the_docs_say_how(self):
        from dgc import docs
        pages = {title: " ".join(body.split()) for title, _summary, body in docs.DOCS}
        self.assertIn("/new DIR", pages["Multiple agents"])
        self.assertIn("Trust it and open", pages["Multiple agents"])
        self.assertIn("/new DIR", pages["Sessions & rewind"])
        self.assertIn("/new DIR", pages["Keyboard shortcuts"])


if __name__ == "__main__":
    unittest.main()
