"""@ a project in a Personal Pip's chat (pips-22's sibling, pips-21; decided 12 Nov).

Asked: "@ a project in a Personal Pip's chat: DGC puts a private copy in its box, the Pip works freely there, and what
changed comes back as one card with the diff: Apply or Discard, plus Continue in Work. Applying is always your click."
Defaults agreed 12 Nov: a Pip without a computer is told to get one first; installed packages are left out of the copy
(the card says tests weren't run unless the Pip ran them); a copy is 200 MB at most, raisable in Dev Mode.

A real Git project in a temporary folder, a Personal Pip with a computer (its Files folder on disk), the backend's own
functions and the Pips controls. No model.
"""
from __future__ import annotations

import json
import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

from tests.test_pip_sdk_apps import AppWorld  # noqa: E402
from dgc import pip_chat, pip_project_copies as copies  # noqa: E402
from dgc.pip_computer import computer_root  # noqa: E402
from dgc.pip_computer_files import files_root  # noqa: E402
from dgc.workspace_registry import RegistryError  # noqa: E402


def git(root, *args):
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True,
                   env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.com",
                        "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.com"})


class ProjectWorld(AppWorld):
    def setUp(self):
        super().setUp()
        self.pip = self.computer_pip()
        self.root = Path(self.base) / "shop"
        self.root.mkdir()
        files = {"app.py": "def total(items):\n    return sum(items)\n", "util.py": "X = 1\n", "README.md": "# Shop\n",
                 ".gitignore": ".env\nnode_modules/\n", ".env": "SECRET=never-copied\n",
                 "node_modules/left/index.js": "module.exports = 1\n"}
        for rel, text in files.items():
            path = self.root / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        git(self.root, "init", "-q")
        git(self.root, "add", "-A")
        git(self.root, "commit", "-qm", "start")
        (self.root / "notes.txt").write_text("not committed yet\n")      # untracked, not ignored: copied
        self.workspace = self.registry.resolve(self.root)

    def computer_pip(self, name="Coder"):
        pip = self.store.create(self.registry.personal()["id"], name, None, "editor-user", pip_type="patch")
        proposal = self.store.propose(pip["id"], 1, {"computer_plan": {"schema_version": 1}}, "local-console")
        self.store.accept(pip["id"], proposal["id"], 1, "local-console")
        return self.store.get(pip["id"])

    def mark(self):
        return {"start": 0, "kind": "project", "label": "shop", "identity": self.workspace["id"]}

    def copy(self, pip=None):
        return copies.prepare(self.store, (pip or self.pip)["id"], [self.mark()], "key-1")

    def box(self, pip=None):
        return files_root(computer_root(self.registry.directory, (pip or self.pip)["id"])) / "projects" / "shop"

    def changes(self):
        return self.control("list_pip_project_changes", pip_id=self.pip["id"])["changes"]


class TheCopy(ProjectWorld, unittest.TestCase):
    def test_a_copy_has_the_project_and_nothing_it_ignores(self):
        [told] = self.copy()
        self.assertEqual((told["name"], told["folder"]), ("shop", "projects/shop"))
        box = self.box()
        found = sorted(str(p.relative_to(box)) for p in box.rglob("*") if p.is_file())
        self.assertEqual(found, [".gitignore", "README.md", "app.py", "notes.txt", "util.py"],
                         "tracked and new files; never .env, node_modules or .git")
        self.assertEqual(told["files"], 5)
        self.assertNotIn("never-copied", json.dumps(told))
        self.assertEqual(self.changes(), [], "an untouched copy has nothing to show")

    def test_a_pip_without_a_computer_is_told_to_get_one(self):
        bare = self.store.create(self.registry.personal()["id"], "Plain", None, "editor-user", pip_type="quill")
        with self.assertRaises(RegistryError) as raised:
            copies.prepare(self.store, bare["id"], [self.mark()], "k")
        self.assertEqual(raised.exception.code, "needs_computer")
        self.assertIn("computer", str(raised.exception))

    def test_too_big_copies_nothing_and_says_the_limit(self):
        with patch.object(copies, "copy_limit", lambda: 10):
            with self.assertRaises(RegistryError) as raised:
                self.copy()
        self.assertEqual(raised.exception.code, "project_too_big")
        self.assertIn("Dev Mode", str(raised.exception))
        self.assertFalse(self.box().exists())

    def test_only_a_project_of_this_computer(self):
        for bad in (self.registry.personal()["id"], "ws_" + "0" * 32, "../etc"):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                copies.prepare(self.store, self.pip["id"], [{**self.mark(), "identity": bad}], "k")

    def test_the_choices_are_the_projects_here(self):
        listed = self.control("list_pip_project_choices", pip_id=self.pip["id"])["projects"]
        self.assertIn({"workspace_id": self.workspace["id"], "name": "shop"}, listed)
        self.assertNotIn(self.registry.personal()["id"], [p["workspace_id"] for p in listed])


class TheChange(ProjectWorld, unittest.TestCase):
    def work(self):
        """What the Pip does in its copy: changes app.py, adds tests, removes README.md."""
        self.copy()
        box = self.box()
        (box / "app.py").write_text("def total(items):\n    return round(sum(items), 2)\n")
        (box / "test_app.py").write_text("from app import total\n\ndef test_total():\n    assert total([1]) == 1\n")
        (box / "README.md").unlink()

    def test_what_changed_is_one_change_with_its_diff(self):
        self.work()
        [change] = self.changes()
        self.assertEqual(change["status"], "pending")
        self.assertEqual(change["name"], "shop")
        self.assertEqual({f["path"]: f["change"] for f in change["files"]},
                         {"app.py": "modified", "test_app.py": "added", "README.md": "deleted"})
        app = next(f for f in change["files"] if f["path"] == "app.py")
        self.assertEqual((app["plus"], app["minus"]), (1, 1))
        one = self.control("get_pip_project_change", pip_id=self.pip["id"], change_id=change["id"], path="app.py")
        self.assertIn("-    return sum(items)", one["diff"])
        self.assertIn("+    return round(sum(items), 2)", one["diff"])
        whole = self.control("get_pip_project_change", pip_id=self.pip["id"], change_id=change["id"])
        self.assertIn("+++ b/test_app.py", whole["patch"])
        self.assertEqual((self.root / "app.py").read_text(), "def total(items):\n    return sum(items)\n",
                         "nothing reaches the project before Apply")

    def test_apply_writes_it_and_holds_back_a_file_you_changed_meanwhile(self):
        self.copy()
        (self.box() / "app.py").write_text("def total(items):\n    return round(sum(items), 2)\n")
        (self.box() / "util.py").write_text("X = 2\n")
        (self.root / "util.py").write_text("X = 3  # mine\n")             # the user, in the meantime
        [change] = self.changes()
        done = self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=change["id"],
                            expected_digest=change["digest"])
        self.assertEqual(done["status"], "partial")
        self.assertEqual(done["result"]["applied"], ["app.py"])
        self.assertEqual([h["path"] for h in done["result"]["held_back"]], ["util.py"])
        self.assertIn("round", (self.root / "app.py").read_text())
        self.assertEqual((self.root / "util.py").read_text(), "X = 3  # mine\n", "yours is kept")

    def test_apply_adds_and_removes_files(self):
        self.work()
        [change] = self.changes()
        done = self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=change["id"],
                            expected_digest=change["digest"])
        self.assertEqual(done["status"], "applied")
        self.assertTrue((self.root / "test_app.py").exists())
        self.assertFalse((self.root / "README.md").exists())
        self.assertEqual(self.changes()[0]["status"], "applied", "and no new change appears for what landed")
        self.assertEqual(len(self.changes()), 1)

    def test_a_change_that_moved_since_you_looked_is_not_applied(self):
        self.work()
        [change] = self.changes()
        (self.box() / "app.py").write_text("something else\n")
        with self.assertRaises(RegistryError) as raised:
            self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=self.changes()[0]["id"],
                         expected_digest=change["digest"])
        self.assertEqual(raised.exception.code, "conflict")

    def test_undo_puts_files_back_only_while_they_hold_what_apply_wrote(self):
        self.work()
        [change] = self.changes()
        self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=change["id"],
                     expected_digest=change["digest"])
        (self.root / "test_app.py").write_text("# I edited this after\n")
        undone = self.control("undo_pip_project_change", pip_id=self.pip["id"], change_id=change["id"])
        self.assertEqual(undone["status"], "undone")
        self.assertEqual((self.root / "app.py").read_text(), "def total(items):\n    return sum(items)\n")
        self.assertEqual((self.root / "README.md").read_text(), "# Shop\n")
        self.assertEqual([k["path"] for k in undone["result"]["kept"]], ["test_app.py"])
        self.assertEqual((self.root / "test_app.py").read_text(), "# I edited this after\n")

    def test_discard_puts_the_copy_back_and_leaves_the_project(self):
        self.work()
        [change] = self.changes()
        gone = self.control("discard_pip_project_change", pip_id=self.pip["id"], change_id=change["id"])
        self.assertEqual(gone["status"], "discarded")
        self.assertEqual((self.box() / "app.py").read_text(), "def total(items):\n    return sum(items)\n")
        self.assertTrue((self.box() / "README.md").exists())
        self.assertFalse((self.box() / "test_app.py").exists())
        self.assertEqual([c["status"] for c in self.changes()], ["discarded"])

    def test_a_later_turn_keeps_working_on_the_same_copy(self):
        self.work()
        [first] = self.changes()
        self.copy()                                   # named again while a change waits: the copy is kept as is
        self.assertFalse((self.box() / "README.md").exists())
        (self.box() / "util.py").write_text("X = 9\n")
        [now] = [c for c in self.changes() if c["status"] == "pending"]
        self.assertEqual(now["id"], first["id"], "one change per copy, growing")
        self.assertIn("util.py", [f["path"] for f in now["files"]])


class Safety(ProjectWorld, unittest.TestCase):
    def test_a_link_the_pip_made_is_never_followed_or_written(self):
        self.copy()
        outside = Path(self.base) / "outside.txt"
        outside.write_text("private\n")
        (self.box() / "util.py").unlink()
        os.symlink(outside, self.box() / "util.py")
        os.symlink("/etc", self.box() / "etc")
        [change] = self.changes()
        listed = {f["path"]: f for f in change["files"]}
        self.assertEqual(listed["util.py"]["change"], "link")
        self.assertNotIn("private", json.dumps(change))
        done = self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=change["id"],
                            expected_digest=change["digest"])
        self.assertEqual((self.root / "util.py").read_text(), "X = 1\n")
        self.assertFalse((self.root / "etc").exists())
        self.assertTrue(all(h["why"] for h in done["result"]["held_back"]))

    def test_a_file_the_project_ignores_or_git_itself_is_never_written(self):
        self.copy()
        before = (self.root / ".git" / "config").read_bytes()
        (self.box() / ".env").write_text("SECRET=pip-made\n")
        (self.box() / ".git").mkdir()
        (self.box() / ".git" / "config").write_text("[core]\n")
        (self.box() / "app.py").write_text("print(1)\n")
        [change] = self.changes()
        done = self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=change["id"],
                            expected_digest=change["digest"])
        self.assertEqual(done["result"]["applied"], ["app.py"])
        self.assertEqual(sorted(h["path"] for h in done["result"]["held_back"]), [".env", ".git/config"])
        self.assertEqual((self.root / ".env").read_text(), "SECRET=never-copied\n")
        self.assertEqual((self.root / ".git" / "config").read_bytes(), before)


class TheMessage(ProjectWorld, unittest.TestCase):
    def test_a_message_naming_a_project_makes_the_copy_and_tells_the_pip(self):
        sent = pip_chat.send(self.store, self.pip["id"], "shop: make total round to cents", "msg-1",
                                     "editor-user", self.cfg, display_mentions=[self.mark()])
        self.assertTrue((self.box() / "app.py").exists())
        context = self.store.run(sent["run"]["id"])["manifest"]["conversation"]
        [told] = context["projects"]
        self.assertEqual((told["name"], told["folder"]), ("shop", "projects/shop"))
        self.assertEqual(sent["message"]["display_mentions"][0]["kind"], "project")

    def test_without_a_computer_the_message_is_refused_before_it_is_kept(self):
        bare = self.store.create(self.registry.personal()["id"], "Plain", None, "editor-user", pip_type="quill")
        with self.assertRaises(RegistryError) as raised:
            pip_chat.send(self.store, bare["id"], "shop: look", "msg-2", "editor-user", self.cfg,
                                  display_mentions=[self.mark()])
        self.assertEqual(raised.exception.code, "needs_computer")


class TheCommands(ProjectWorld, unittest.TestCase):
    NAMES = {"list_pip_project_choices": {"pip_id"}, "list_pip_project_changes": {"pip_id"},
             "get_pip_project_change": {"pip_id", "change_id", "path"},
             "apply_pip_project_change": {"pip_id", "change_id", "expected_digest"},
             "discard_pip_project_change": {"pip_id", "change_id"}, "undo_pip_project_change": {"pip_id", "change_id"}}

    def test_api_91_and_local_only(self):
        from dgc import pips
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 91)
        for name, args in self.NAMES.items():
            with self.subTest(name=name):
                self.assertIn(name, pips.CONTROL_COMMANDS)
                self.assertEqual(pips._COMMAND_ARGS[name], args)
                fields = {"pip_id": self.pip["id"], "change_id": "pchange_" + "0" * 32, "path": "app.py",
                          "expected_digest": "x"}
                with self.assertRaises(RegistryError) as raised:
                    self.control(name, actor="main-chat:abc", **{k: v for k, v in fields.items() if k in args})
                self.assertEqual(raised.exception.code, "local_only")

    def test_both_sdks_know_them_at_91(self):
        import sys
        sys.path.insert(0, "sdk/python")
        from dgc_sdk import pips as sdk
        for name in ("list_pip_project_choices", "list_pip_project_changes", "get_pip_project_change"):
            self.assertIn(name, sdk.READ_COMMANDS)
        for name in ("apply_pip_project_change", "discard_pip_project_change", "undo_pip_project_change"):
            self.assertIn(name, sdk.MUTATION_COMMANDS)
        ts = Path("sdk/typescript/src/pips.ts").read_text(encoding="utf-8")
        self.assertIn("const API91_READS = new Set([", ts)
        self.assertIn("const API91_MUTATIONS = new Set([", ts)


if __name__ == "__main__":
    unittest.main()
