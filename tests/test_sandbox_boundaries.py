"""The sandbox's boundary comes from DGC's own record, never from what the model wrote (9 Nov).

Checked against OpenAI Codex's advisory GHSA-w5fx-fh39-j5rw (a model-chosen folder became the sandbox's writable root).
DGC's shell, background and monitor commands take no folder from the model, but three things were found:

1. The sandbox read a `.git` pointer file from inside the project and, after hiding the home, re-exposed the folder it
   named (read-only). The model can write that file: `gitdir: /home/<you>` made ~/.dgc readable inside the sandbox.
   Only a real linked worktree, whose own record points back at this folder, may re-expose its repository's `.git`.
2. Started in the home folder, the project holds DGC's own state (~/.dgc: config, keys, sessions), which stayed
   writable inside the sandbox; and a restarted monitor or background command took its folder from a saved record.
3. With DGC's sandbox on, delegated Claude Code and Codex still ran with their own sandbox off in auto mode
   (the user's call: DGC's sandbox applies to them too, through their own sandboxes).
"""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import sandbox, subscriptions, worktree                       # noqa: E402


def git(*args, cwd) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


class APointerFileIsNotARecord(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="dgc-sbx-forged-")).resolve()
        self.addCleanup(shutil.rmtree, self.base, True)

    def test_a_forged_pointer_naming_the_home_re_exposes_nothing(self) -> None:
        project = self.base / "project"
        project.mkdir()
        home = self.base / "home"
        (home / ".dgc").mkdir(parents=True)
        (project / ".git").write_text(f"gitdir: {home}\n", encoding="utf-8")
        self.assertIsNone(sandbox._worktree_git_common_dir(project))

    def test_a_pointer_to_another_checkouts_worktree_re_exposes_nothing(self) -> None:
        """A real linked worktree of some other folder: its record points back there, not here."""
        main = self.base / "main"
        main.mkdir()
        git("init", "-q", ".", cwd=main)
        git("config", "user.email", "t@t", cwd=main)
        git("config", "user.name", "t", cwd=main)
        (main / "a.txt").write_text("v1\n", encoding="utf-8")
        git("add", "-A", cwd=main)
        git("commit", "-qm", "init", cwd=main)
        workspace, error = worktree.TaskWorkspace.prepare(main, "child", self.base / "store")
        self.assertIsNotNone(workspace, error)
        real_pointer = (workspace.project_root / ".git").read_text(encoding="utf-8")
        intruder = self.base / "intruder"
        intruder.mkdir()
        (intruder / ".git").write_text(real_pointer, encoding="utf-8")
        self.assertIsNone(sandbox._worktree_git_common_dir(intruder))
        self.assertEqual(sandbox._worktree_git_common_dir(workspace.project_root), (main / ".git").resolve(strict=False),
                         "the real worktree still finds its repository")

    def test_a_forged_commondir_is_not_followed(self) -> None:
        """A private folder whose record points back here, but whose commondir names something other than its repo."""
        project = self.base / "project"
        project.mkdir()
        private = self.base / "repo" / ".git" / "worktrees" / "x"
        private.mkdir(parents=True)
        (private / "gitdir").write_text(str(project / ".git") + "\n", encoding="utf-8")
        (private / "commondir").write_text(str(self.base / "home") + "\n", encoding="utf-8")
        (project / ".git").write_text(f"gitdir: {private}\n", encoding="utf-8")
        self.assertIsNone(sandbox._worktree_git_common_dir(project))


class StartedInTheHomeFolder(unittest.TestCase):
    def setUp(self) -> None:
        self.base = Path(tempfile.mkdtemp(prefix="dgc-sbx-home-")).resolve()
        self.addCleanup(shutil.rmtree, self.base, True)
        self.home = self.base / "home"
        (self.home / ".dgc").mkdir(parents=True)
        bwrap = self.base / "bin" / "bwrap"
        bwrap.parent.mkdir()
        bwrap.write_text("#!/bin/sh\n", encoding="utf-8")
        for patcher in (mock.patch.object(sandbox, "_backend", return_value=("bwrap", str(bwrap))),
                        mock.patch.object(Path, "home", classmethod(lambda cls: self.home)),
                        mock.patch.object(sandbox, "_account_home", return_value=None),
                        mock.patch.object(sandbox, "_isolated_state_dir", return_value=None),
                        mock.patch.object(sandbox, "_session", return_value=None)):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_dgcs_own_state_stays_hidden_when_the_project_is_the_home(self) -> None:
        argv = sandbox.wrap("true", self.home, None)
        self.assertIsNotNone(argv)
        pairs = list(zip(argv, argv[1:]))
        self.assertIn(("--tmpfs", "/mnt/.dgc"), pairs, "its config, keys and sessions are not the project's to change")
        # At its own path too, unless that path is only the link to /mnt (a home under a masked folder, as here in /tmp).
        self.assertTrue(("--tmpfs", str(self.home / ".dgc")) in pairs or ("--symlink", "/mnt") in pairs, argv)
        bind = argv.index("/mnt")
        self.assertGreater(argv.index("/mnt/.dgc"), bind, "after the project is bound, so it wins")

    def test_a_home_under_no_mask_is_hidden_at_its_own_path_too(self) -> None:
        """The usual case, /home/<you>: reachable through the read-only root, so masked there as well."""
        here = Path(tempfile.mkdtemp(prefix="dgc-sbx-realhome-", dir=str(PROJECT.parent))).resolve()
        self.addCleanup(shutil.rmtree, here, True)
        (here / ".dgc").mkdir()
        with mock.patch.object(Path, "home", classmethod(lambda cls: here)):
            argv = sandbox.wrap("true", here, None)
        pairs = list(zip(argv, argv[1:]))
        self.assertIn(("--tmpfs", "/mnt/.dgc"), pairs)
        self.assertIn(("--tmpfs", str(here / ".dgc")), pairs)

    def test_an_ordinary_project_is_as_before(self) -> None:
        project = self.home / "work" / "app"
        project.mkdir(parents=True)
        argv = sandbox.wrap("true", project, None)
        self.assertIn(("--tmpfs", str(self.home)), list(zip(argv, argv[1:])), "the whole home is hidden, as before")
        self.assertNotIn("/mnt/.dgc", argv)


class RestartsUseTheSessionsFolder(unittest.TestCase):
    def test_a_background_command_whose_record_names_another_folder_is_not_run_again(self) -> None:
        from types import SimpleNamespace
        from dgc import stopped_work
        base = Path(tempfile.mkdtemp(prefix="dgc-sbx-rerun-")).resolve()
        self.addCleanup(shutil.rmtree, base, True)
        (base / "session").mkdir()
        (base / "elsewhere").mkdir()
        agent = SimpleNamespace(config=SimpleNamespace(project_root=base / "session"), ctx=SimpleNamespace(project_root=base / "session"))
        said, _ = stopped_work._start_shell(agent, {"cwd": str(base / "elsewhere"), "command": "true"})
        self.assertIn("not this session's folder", said)


class TheClisSandboxFollowsDgcs(unittest.TestCase):
    def argv(self, key, mode, **kwargs):
        engine = subscriptions.get_engine(key)
        return engine.build_argv("/bin/" + key, "hello", cont=False, mode=mode, **kwargs)

    def test_codex_never_bypasses_its_sandbox_while_dgcs_is_on(self) -> None:
        for mode in ("auto", "acceptEdits"):
            argv = self.argv("codex", mode, sandboxed=True)
            self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", argv, mode)
            self.assertEqual(argv[argv.index("--sandbox") + 1], "workspace-write", mode)
        argv = self.argv("codex", "auto", sandboxed=True, network=True)
        self.assertIn("sandbox_workspace_write.network_access=true", argv, "DGC's sandbox lets it reach the network")
        self.assertIn("--dangerously-bypass-approvals-and-sandbox", self.argv("codex", "auto"), "its sandbox off: as before")

    def test_claude_code_runs_its_own_sandbox_and_never_skips_every_check_while_dgcs_is_on(self) -> None:
        argv = self.argv("claude", "auto", sandboxed=True)
        self.assertNotIn("--dangerously-skip-permissions", argv)
        self.assertEqual(argv[argv.index("--permission-mode") + 1], "acceptEdits", "edits in the project, no prompts")
        settings = json.loads(argv[argv.index("--settings") + 1])
        self.assertEqual(settings["sandbox"], {"enabled": True, "autoAllowBashIfSandboxed": True,
                                               "allowUnsandboxedCommands": False})
        plan = self.argv("claude", "plan", sandboxed=True)
        self.assertIn("--settings", plan)
        self.assertIn("--dangerously-skip-permissions", self.argv("claude", "auto"), "its sandbox off: as before")

    def test_a_vendor_thread_made_without_the_sandbox_is_not_resumed_with_it(self) -> None:
        """Codex keeps the sandbox its thread was made with: turning DGC's on starts a new thread."""
        self.assertNotEqual(subscriptions.session_mode("auto", sandboxed=True), subscriptions.session_mode("auto", sandboxed=False))
        self.assertEqual(subscriptions.session_mode("auto", sandboxed=False), "auto", "unchanged for a session without it")
        from dgc import sessions
        kept = sessions._clean_subscription_sessions({"codex": {"id": "th_1", "mode": "auto+sandbox", "model": "", "effort": ""}})
        self.assertEqual(kept.get("codex", {}).get("mode"), "auto+sandbox", "a sandboxed thread is kept with the session")
        self.assertEqual(sessions._clean_subscription_sessions({"codex": {"id": "th_1", "mode": "auto+other", "model": "", "effort": ""}}), {})


if __name__ == "__main__":
    unittest.main()
