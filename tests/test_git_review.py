"""Real repositories exercise review content, scope, and no-execution boundaries."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from dgc import git_review, tools
from dgc.permissions import PermissionEngine


class GitReviewTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-git-review-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Fixture")
        self.git("config", "user.email", "fixture@example.invalid")
        self.ctx = types.SimpleNamespace(project_root=self.root, config=None, cancelled=threading.Event())

    def git(self, *args):
        return subprocess.run(["git", *args], cwd=self.root, check=True, stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, env={**os.environ, "GIT_CONFIG_NOSYSTEM": "1",
                                                          "GIT_CONFIG_GLOBAL": os.devnull}).stdout.decode().strip()

    def write(self, name, text):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
        return path

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def review(self, **args):
        return tools.execute("git_diff", args, self.ctx)

    def test_unborn_staged_working_untracked_and_clean(self):
        self.write("one.py", "before\n")
        self.git("add", "one.py")
        unborn = self.review()
        self.assertIn("+before", unborn)
        self.assertNotIn("partial", unborn)
        self.commit()
        self.assertIn("No changes", self.review())
        self.write("one.py", "staged\n")
        self.git("add", "one.py")
        self.write("one.py", "working\n")
        self.write("new.py", "untracked\n")
        output = self.review()
        for line in ("-before", "+staged", "-staged", "+working", "+untracked"):
            self.assertIn(line, output)
        self.assertNotIn("+working", self.review(view="staged"))
        self.assertNotIn("-before", self.review(view="working"))

    def test_branch_merge_base_and_root_commit(self):
        self.write("one.py", "base\n")
        initial = self.commit()
        self.git("branch", "review-base")
        self.write("one.py", "changed\n")
        self.commit()
        self.write("dirty.py", "not part of branch review\n")
        for args in ({"view": "base", "ref": "review-base"}, {"view": "commit"}):
            out = self.review(**args)
            self.assertIn("-base", out)
            self.assertIn("+changed", out)
            self.assertNotIn("dirty", out)
        root = self.review(view="commit", ref=initial)
        self.assertIn("empty tree", root)
        self.assertIn("+base", root)
        self.assertIn("partial", self.review(view="base", ref="--output=escaped"))
        self.assertFalse((self.root / "escaped").exists())

    def test_literal_scope_and_parent_repository(self):
        self.write("app/one.py", "before\n")
        self.write("private.py", "PARENT_SECRET_SENTINEL\n")
        self.write("app/[literal].py", "before\n")
        self.commit()
        self.write("app/one.py", "changed\n")
        self.write("private.py", "PARENT_SECRET_SENTINEL_CHANGED\n")
        self.write("app/[literal].py", "literal change\n")
        self.ctx.project_root = self.root / "app"
        out = self.review()
        self.assertIn("+changed", out)
        self.assertNotIn("PARENT_SECRET", out)
        literal = self.review(path="[literal].py")
        self.assertIn("+literal change", literal)
        self.assertNotIn("one.py", literal)
        self.assertTrue(self.review(path="../private.py").startswith("error:"))

    def test_no_filters_textconv_hooks_fsmonitor_or_external_diff(self):
        self.write("one.py", "before\n")
        self.commit()
        # Only install the hostile config after the test's own git-add has finished.
        script = self.write("malicious.sh", "#!/bin/sh\nprintf executed > ran-hook\ncat\n")
        script.chmod(0o755)
        self.write(".gitattributes", "*.py filter=evil diff=evil\n")
        for key in ("filter.evil.clean", "filter.evil.smudge", "filter.evil.process",
                    "diff.evil.command", "diff.evil.textconv", "diff.external", "core.fsmonitor"):
            self.git("config", key, str(script))
        self.git("config", "core.hooksPath", str(self.root))
        self.write("one.py", "after\n")
        out = self.review(path="one.py")
        self.assertIn("+after", out)
        self.assertFalse((self.root / "ran-hook").exists())
        # Positive control: even the ordinary diff's no-ext-diff/no-textconv options do not
        # suppress clean filters. The fixture must be capable of detecting that execution.
        self.git("config", "--unset", "filter.evil.process")
        self.git("-c", "core.fsmonitor=false", "diff", "--no-ext-diff", "--no-textconv", "--", "one.py")
        self.assertTrue((self.root / "ran-hook").exists())

    def test_no_symlink_or_fifo_reads_and_limits_are_visible(self):
        self.write("one.py", "before\n")
        self.commit()
        outside = self.root.parent / (self.root.name + "-outside")
        outside.write_text("OUTSIDE_SECRET_SENTINEL")
        self.addCleanup(outside.unlink)
        (self.root / "one.py").unlink()
        (self.root / "one.py").symlink_to(outside)
        (self.root / "inside-link").symlink_to(self.root / "empty")
        self.write("empty", "safe")
        os.mkfifo(self.root / "pipe")
        out = self.review()
        self.assertIn("partial", out)
        self.assertNotIn("OUTSIDE_SECRET", out)
        self.assertIn("Skipped", out)
        with patch.object(git_review, "MAX_FILE_BYTES", 2):
            self.assertIn("partial", self.review(path="empty"))
        with patch.object(git_review, "MAX_OUTPUT", 50):
            self.assertIn("limit", self.review())
        self.ctx.cancelled.set()
        self.assertIn("cancelled", self.review())

    def test_deletions_modes_binary_newline_and_permission_order(self):
        path = self.write("one.py", "line\n")
        self.commit()
        path.chmod(0o755)
        self.assertIn("100644 → 100755", self.review())
        path.write_text("line")
        self.assertIn("Final newline changed", self.review())
        path.write_bytes(b"binary\0data")
        self.assertIn("Binary content changed", self.review())
        path.unlink()
        self.assertIn("-line", self.review())
        for mode in ("default", "plan", "acceptEdits", "auto"):
            policy = PermissionEngine(mode, {"deny": ["GitDiff"], "ask": [], "allow": ["*"]}, self.root)
            self.assertEqual(policy.decide("git_diff", {})[0], "deny")
        policy = PermissionEngine("default", {"deny": [], "ask": ["GitDiff(one.py)"], "allow": ["*"]}, self.root)
        self.assertEqual(policy.decide("git_diff", {"path": "one.py"})[0], "ask")
        self.assertEqual(PermissionEngine("plan", {}, self.root).decide("git_diff", {})[0], "allow")

    def test_no_lazy_fetch_network_or_repository_path_shadow(self):
        self.write("one.py", "before\n")
        self.commit()
        calls = []
        real = subprocess.Popen
        def observe(*args, **kwargs):
            calls.append(kwargs["env"])
            return real(*args, **kwargs)
        with patch("dgc.worktree.subprocess.Popen", side_effect=observe):
            self.review(view="commit")
        self.assertTrue(calls)
        for env in calls:
            self.assertEqual(env["GIT_ALLOW_PROTOCOL"], "")
            self.assertEqual(env["GIT_NO_LAZY_FETCH"], "1")
            self.assertEqual(env["GIT_OPTIONAL_LOCKS"], "0")
        fake = self.write("bin/git", "#!/bin/sh\nprintf executed > ran-fake\n")
        fake.chmod(0o755)
        with patch.dict(os.environ, {"PATH": str(fake.parent) + os.pathsep + os.environ["PATH"]}):
            self.assertIn("trusted git executable", self.review())
        self.assertFalse((self.root / "ran-fake").exists())

    def test_sparse_checkout_does_not_report_omitted_files_as_deletions(self):
        self.write("included/one.py", "keep\n")
        self.write("omitted/two.py", "sparse\n")
        self.commit()
        self.git("sparse-checkout", "init", "--cone")
        self.git("sparse-checkout", "set", "included")
        self.assertFalse((self.root / "omitted/two.py").exists())
        self.assertIn("No changes", self.review())


if __name__ == "__main__":
    unittest.main()
