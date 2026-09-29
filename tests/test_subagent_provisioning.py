"""What a delegated sub-agent's isolated checkout does and does not have.

Measured first, with real DGC delegations on a real model (deepseek-v4.1-flash:cloud), because the
design question -- should a task worktree be provisioned from the parent? -- had two plausible
answers and no evidence:

    Python  the child ran `python -m pytest` with no `.venv` of its own, saw its OWN assertion
            failure, fixed it, re-ran to `3 passed`. Nothing was missing that mattered.
    Node    `npm test` -> `sh: 1: jest: not found`, EXIT=127. The child recovered by itself with
            `npm install` INTO ITS OWN CHECKOUT (196 packages), then read `Expected: 12 Received: 7`,
            fixed it, and got `PASS`. The parent's `node_modules` mtime was unchanged afterwards.

So isolation holds and costs one install. Symlinking the parent's `node_modules` in by default
would have routed that `npm install` into the user's own tree, which is the failure this design
exists to prevent. What the run did show is the child paying a turn to LEARN what is absent, and
the install being cheap only because the package cache is shared through `$HOME`.

These tests pin the three properties that follow:
  1. the child is told what its checkout lacks, before it runs anything;
  2. the package cache stays shared, so a fresh worktree's install is a cache hit;
  3. sharing a directory is possible, opt-in only, never reaches the integration delta, and never
     lets cleanup delete the user's copy.
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import sandbox, worktree                                      # noqa: E402
from dgc.agent import Agent                                            # noqa: E402
from dgc.config import Config, DEFAULTS                                # noqa: E402


def git(*args, cwd) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def project(names=("node_modules/jest/index.js", ".venv/bin/python"), ignore=None) -> Path:
    """A repository with tracked sources and some ignored build/dependency directories."""
    root = Path(tempfile.mkdtemp(prefix="dgc-prov-")).resolve() / "main"
    root.mkdir(parents=True)
    git("init", "-q", ".", cwd=root)
    git("config", "user.email", "t@t", cwd=root)
    git("config", "user.name", "t", cwd=root)
    (root / "app.py").write_text("x = 1\n", encoding="utf-8")
    ignored = list(ignore) if ignore else sorted({name.split("/")[0] for name in names})
    (root / ".gitignore").write_text("".join(f"{name}\n" for name in ignored) + ".dgc\n",
                                     encoding="utf-8")
    for name in names:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("PRECIOUS\n", encoding="utf-8")
    git("add", "-A", cwd=root)
    git("commit", "-qm", "init", cwd=root)
    return root


def prepared(root: Path, **kwargs):
    store = root.parent / "store"
    workspace, error = worktree.TaskWorkspace.prepare(root, "task", store, **kwargs)
    if workspace is None:
        raise AssertionError(f"prepare failed: {error}")
    return workspace


class AnIsolatedCheckoutLacksTheIgnoredDirectoriesTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = project()
        self.workspace = prepared(self.root)

    def test_git_really_leaves_them_out(self) -> None:
        """The premise. Without it every hint below is describing something that isn't true."""
        self.assertTrue((self.root / "node_modules").is_dir())
        self.assertFalse((self.workspace.project_root / "node_modules").exists(),
                         "a worktree checks out tracked files only")

    def test_they_are_named(self) -> None:
        names = worktree.absent_ignored_dirs(self.root, self.workspace.project_root)
        self.assertIn("node_modules", names)
        self.assertIn(".venv", names)

    def test_gits_own_directory_and_dgc_state_are_not_reported(self) -> None:
        (self.root / ".dgc").mkdir(exist_ok=True)
        (self.root / ".dgc" / "state.json").write_text("{}", encoding="utf-8")
        names = worktree.absent_ignored_dirs(self.root, self.workspace.project_root)
        self.assertNotIn(".dgc", names)
        self.assertNotIn(".git", names)

    def test_shallowest_first_and_bounded(self) -> None:
        deep = project(("node_modules/a.js", "dist/b.js", "target/c.o", "packages/a/build/d.o",
                        "packages/a/keep.txt"),
                       ignore=["node_modules", "dist", "target", "build"])
        workspace = prepared(deep)
        all_names = worktree.absent_ignored_dirs(deep, workspace.project_root)
        self.assertIn("packages/a/build", all_names, "a nested ignored directory is absent too")
        names = worktree.absent_ignored_dirs(deep, workspace.project_root, limit=3)
        self.assertEqual(len(names), 3, all_names)
        self.assertNotIn("packages/a/build", names,
                         "the top-level directories a task is most likely to need come first")

    def test_a_directory_the_child_already_has_is_not_called_absent(self) -> None:
        (self.workspace.project_root / "node_modules").mkdir()
        names = worktree.absent_ignored_dirs(self.root, self.workspace.project_root)
        self.assertNotIn("node_modules", names)

    def test_the_parent_is_told_nothing(self) -> None:
        self.assertEqual(worktree.absent_ignored_dirs(self.root, self.root), [],
                         "a non-isolated run has no checkout to describe")

    def test_a_failure_is_silent_rather_than_fatal(self) -> None:
        with mock.patch.object(worktree, "_git_bytes", side_effect=OSError("git is gone")):
            self.assertEqual(
                worktree.absent_ignored_dirs(self.root, self.workspace.project_root), [],
                "a hint must never be the reason a delegation is refused")


class TheChildIsToldBeforeItRunsAnythingTest(unittest.TestCase):
    """The system prompt, because the child must know at its FIRST tool call, not after one fails."""

    def agent(self) -> Agent:
        class _UI:
            def __getattr__(self, _name):
                return lambda *a, **kw: None
        config = Config(project_root=Path(tempfile.mkdtemp(prefix="dgc-prov-agent-")))
        # In memory only, never persisted. Constructing an Agent otherwise CONNECTS whatever MCP
        # servers the machine running the suite happens to have -- 40 seconds per test here, and a
        # result that depends on someone's local configuration. Nothing below involves MCP.
        config.data["mcp_servers"] = {}
        config.data["disabled_mcp_servers"] = []
        return Agent(config, _UI())

    def test_an_ordinary_agent_says_nothing_about_missing_directories(self) -> None:
        prompt = self.agent().system_prompt()
        self.assertNotIn("Not in this checkout", prompt,
                         "the main agent's prompt must not change")

    def test_an_isolated_child_is_told_what_is_absent(self) -> None:
        agent = self.agent()
        agent._absent_dirs = ["node_modules", ".venv"]
        prompt = agent.system_prompt()
        self.assertIn("Not in this checkout", prompt)
        self.assertIn("node_modules", prompt)
        self.assertIn(".venv", prompt)

    def test_a_shared_directory_is_flagged_as_not_isolated(self) -> None:
        agent = self.agent()
        agent._shared_dirs = ["node_modules"]
        prompt = agent.system_prompt()
        self.assertIn("Shared with the real project", prompt,
                      "a child writing into the user's own tree must know that is what it is doing")

    def test_the_line_reaches_a_refreshed_prompt(self) -> None:
        """`_refresh_system` is how the child gets this after construction."""
        agent = self.agent()
        agent._absent_dirs = ["node_modules"]
        agent._refresh_system()
        self.assertIn("node_modules", agent.messages[0]["content"])


class ThePackageCacheStaysSharedTest(unittest.TestCase):
    """The measured `npm install` was cheap because `$HOME` is the parent's. Pin it.

    Nothing in DGC gives a sub-agent a private HOME today, so this is a test that something LATER
    must not break: isolate `$HOME` for a child and every delegation into a fresh worktree becomes
    a full cold download instead of a cache hit.
    """
    CACHE_VARS = {"HOME": "/home/someone", "XDG_CACHE_HOME": "/home/someone/.cache",
                  "npm_config_cache": "/home/someone/.npm", "PIP_CACHE_DIR": "/home/someone/.pip",
                  "CARGO_HOME": "/home/someone/.cargo", "GOMODCACHE": "/home/someone/go/pkg/mod"}

    def test_an_unsandboxed_tool_inherits_the_cache_environment(self) -> None:
        with mock.patch.dict(os.environ, self.CACHE_VARS, clear=False):
            env = sandbox.tool_env()
        for name, value in self.CACHE_VARS.items():
            self.assertEqual(env.get(name), value, f"{name} must reach a delegated child's shell")

    def test_that_is_not_vacuous(self) -> None:
        """tool_env does filter the environment -- it just must not filter the caches."""
        with mock.patch.dict(os.environ, {**self.CACHE_VARS, "DGC_API_KEY": "sk-secret"},
                             clear=False):
            env = sandbox.tool_env()
        self.assertNotIn("DGC_API_KEY", env, "tool_env does filter -- it strips provider keys")

    def test_the_child_config_introduces_no_private_home(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="dgc-prov-cfg-")).resolve()
        child_root = root / "child"
        child_root.mkdir()
        clone = Config(project_root=root).clone_for_root(child_root)
        self.assertEqual(clone.project_root, child_root)
        for key, value in clone.data.items():
            self.assertNotIn("HOME", str(key).upper().split("_"),
                             f"{key}={value!r} looks like a per-child home override")


class SharingIsOptInAndContainedTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = project()

    def test_the_default_shares_nothing(self) -> None:
        self.assertEqual(DEFAULTS["subagent_link_paths"], [],
                         "isolation is the default; the measured run showed it working")
        self.assertEqual(prepared(self.root).linked, [])

    def test_an_opted_in_directory_is_shared(self) -> None:
        workspace = prepared(self.root, link_paths=["node_modules"])
        self.assertEqual(workspace.linked, ["node_modules"])
        link = workspace.project_root / "node_modules"
        self.assertTrue(link.is_symlink())
        self.assertEqual((link / "jest" / "index.js").read_text(encoding="utf-8"), "PRECIOUS\n")

    def test_a_shared_directory_never_reaches_the_integration_delta(self) -> None:
        """The property that makes this safe: the parent is never offered a symlink to write."""
        workspace = prepared(self.root, link_paths=["node_modules"])
        self.assertNotIn("node_modules", " ".join(workspace.changed_paths()))

    def test_a_tracked_path_is_refused(self) -> None:
        workspace = prepared(self.root, link_paths=["app.py"])
        self.assertEqual(workspace.linked, [])
        self.assertEqual(workspace.link_errors, ["app.py: already present in the isolated checkout"],
                         "the checkout has its own copy of every tracked file")
        self.assertFalse((workspace.project_root / "app.py").is_symlink(),
                         "the checkout's own copy of a tracked file must survive")
        self.assertEqual((workspace.project_root / "app.py").read_text(encoding="utf-8"), "x = 1\n")

    def test_an_unignored_path_is_refused(self) -> None:
        """The gate that keeps a symlink out of the integration delta.

        It sits behind the presence check and an EMPTY directory is the one shape that reaches it:
        a tracked path is checked out into the worktree, and an untracked one with any content is
        copied there as part of the dirty baseline, so both are refused earlier as already present.
        It is still the gate that makes sharing safe -- `changed_paths()` reads git's view of the
        worktree, and any linked path git does not ignore would be offered to the user's project as
        a symlink -- so it is pinned here rather than left to the checks in front of it.
        """
        (self.root / "scratch").mkdir()
        workspace = prepared(self.root, link_paths=["scratch"])
        self.assertEqual(workspace.linked, [])
        self.assertTrue(any("not ignored" in message for message in workspace.link_errors),
                        workspace.link_errors)
        self.assertFalse((workspace.project_root / "scratch").exists())

    def test_an_escape_is_refused_and_says_why(self) -> None:
        """Each entry names the reason it was refused: a user who mistyped one path in a config
        list has to be able to tell which entry is wrong and what is wrong with it."""
        workspace = prepared(self.root, link_paths=["../../etc", "/etc", "", "nope"])
        self.assertEqual(workspace.linked, [])
        reasons = dict(message.split(": ", 1) for message in workspace.link_errors)
        self.assertEqual(sorted(reasons), ["../../etc", "/etc", "nope"], workspace.link_errors)
        self.assertIn("relative path", reasons["../../etc"])
        self.assertIn("relative path", reasons["/etc"])
        self.assertIn("not present", reasons["nope"])
        self.assertFalse((workspace.path.parent / "etc").exists())

    def test_a_symlink_in_the_middle_of_the_path_cannot_reach_outside(self) -> None:
        """A tracked symlink is checked out into the worktree, so `esc/child` has no `..` in it and
        still names a directory outside the checkout. Containment is decided before anything
        follows the path, which is the only reason the two presence checks are asked about the
        right file."""
        outside = self.root.parent / "outside"
        (outside / "child").mkdir(parents=True)
        (outside / "child" / "loot.txt").write_text("loot\n", encoding="utf-8")
        (self.root / "esc").symlink_to(outside)
        git("add", "-A", cwd=self.root)
        git("commit", "-qm", "symlink", cwd=self.root)
        workspace = prepared(self.root, link_paths=["esc/child"])
        self.assertEqual(workspace.linked, [])
        self.assertTrue(any("outside" in message for message in workspace.link_errors),
                        workspace.link_errors)
        self.assertEqual(sorted(p.name for p in outside.iterdir()), ["child"],
                         "nothing may be created through the symlink")

    def test_cleanup_does_not_follow_the_link_into_the_users_project(self) -> None:
        """The data-loss boundary. Measured against real git before this was allowed at all."""
        workspace = prepared(self.root, link_paths=["node_modules"])
        self.assertIsNone(workspace.cleanup())
        self.assertEqual((self.root / "node_modules" / "jest" / "index.js").read_text(
            encoding="utf-8"), "PRECIOUS\n", "removing the checkout must not touch the real tree")

    def test_a_shared_directory_is_not_also_reported_as_absent(self) -> None:
        workspace = prepared(self.root, link_paths=["node_modules"])
        names = worktree.absent_ignored_dirs(self.root, workspace.project_root)
        self.assertNotIn("node_modules", names)
        self.assertIn(".venv", names, "the ones that are still missing are still named")


if __name__ == "__main__":
    unittest.main()
