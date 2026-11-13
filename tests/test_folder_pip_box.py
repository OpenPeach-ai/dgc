"""Every Pip gets everything, in its own box: step 1, a folder Pip's chat gets its box and a copy of its folder (0.52).

His words (13 Nov): "is there an issue if every pip gets everything? and decides itself what all to use? ... it gets
folder access, read and write, web and apps, and personal computer, it gets all"; then "web apps and plugins and
personal computer of each pip, works inside a separate sandbox environment". Design: 052-plan/pips-sandbox-design.md.

Step 1: a Pip in a project folder, in its chat, has its own computer (the same box a Personal Pip has), and its own
folder is copied into that box's Files at the start of each turn: Git-listed files without what Git ignores (so no .env),
never .git, no links. Only what changed since the last turn is copied again (a chat turn is a run). While something the
Pip changed in its copy is waiting for the user, the copy is kept exactly as it is. Nothing reaches the real folder
except through Apply. Levels and careful mode are unchanged in this step.
"""
from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc.llm import ChatResult, LLMClient  # noqa: E402

from tests.test_pip_project_copies import ProjectWorld, git  # noqa: E402
from dgc import pip_chat, pip_project_copies as copies, pips  # noqa: E402
from dgc.pip_computer import computer_root  # noqa: E402
from dgc.pip_computer_files import files_root  # noqa: E402


class FolderPipWorld(ProjectWorld):
    def setUp(self):
        super().setUp()
        self.helper = self.store.create(self.workspace["id"], "Shop helper", None, "editor-user", pip_type="patch")

    def own(self):
        return copies.own_folder(self.store, self.helper["id"])

    def home(self):
        return files_root(computer_root(self.registry.directory, self.helper["id"])) / "projects" / "shop"

    def listed(self):
        box = self.home()
        return sorted(str(p.relative_to(box)) for p in box.rglob("*") if p.is_file())


class ItsOwnFolder(FolderPipWorld, unittest.TestCase):
    def test_its_own_folder_is_copied_into_its_box_without_what_git_ignores(self):
        told = self.own()
        self.assertEqual((told["name"], told["folder"], told["files"], told["kept"]), ("shop", "projects/shop", 5, False))
        self.assertEqual(self.listed(), [".gitignore", "README.md", "app.py", "notes.txt", "util.py"],
                         "tracked and new files; never .env, node_modules or .git")
        self.assertEqual((self.home() / "app.py").read_text(), (self.root / "app.py").read_text())

    def test_a_personal_pip_has_no_own_folder(self):
        self.assertIsNone(copies.own_folder(self.store, self.pip["id"]))

    def test_an_unchanged_folder_is_not_copied_again(self):
        self.own()
        before = {rel: os.stat(self.home() / rel) for rel in self.listed()}
        told = self.own()
        self.assertEqual((told["files"], told["kept"], told["updated"]), (5, False, 0))
        for rel, was in before.items():
            now = os.stat(self.home() / rel)
            self.assertEqual((now.st_ino, now.st_mtime_ns), (was.st_ino, was.st_mtime_ns), f"{rel} was not written again")

    def test_what_changed_in_the_folder_since_the_last_turn_comes_over(self):
        self.own()
        (self.root / "util.py").write_text("X = 2\n")
        (self.root / "new.py").write_text("print('new')\n")
        (self.root / "README.md").unlink()
        told = self.own()
        self.assertEqual(told["updated"], 3)
        self.assertEqual((self.home() / "util.py").read_text(), "X = 2\n")
        self.assertEqual((self.home() / "new.py").read_text(), "print('new')\n")
        self.assertFalse((self.home() / "README.md").exists(), "a file gone from the folder goes from the copy")
        self.assertEqual(told["files"], 5)

    def test_while_its_changes_wait_the_copy_is_kept_as_it_is(self):
        self.own()
        (self.home() / "app.py").write_text("def total(items):\n    return sum(items) + 0\n")    # the Pip's edit
        (self.root / "util.py").write_text("X = 2\n")                                          # the user's, meanwhile
        told = self.own()
        self.assertTrue(told["kept"])
        self.assertEqual((self.home() / "util.py").read_text(), "X = 1\n", "kept: the user's edit waits for the next copy")
        self.assertIn("sum(items) + 0", (self.home() / "app.py").read_text(), "the Pip's work is never overwritten")
        [change] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        self.assertEqual(change["status"], "pending")

    def test_a_folder_too_big_leaves_its_biggest_files_out_and_says_so(self):
        sizes = {rel: (self.root / rel).stat().st_size for rel in self.listed_in_project()}
        biggest = max(sizes, key=sizes.get)
        with patch.object(copies, "copy_limit", return_value=sum(sizes.values()) - 1):
            told = self.own()
        self.assertNotIn("error", told, "never all or nothing: the turn has the rest of its folder")
        self.assertEqual((told["files"], told["left_out"]["files"], told["left_out"]["examples"]),
                         (len(sizes) - 1, 1, [biggest]))
        self.assertNotIn(biggest, self.listed())
        self.assertEqual(len(self.listed()), len(sizes) - 1)
        with patch.object(copies, "copy_limit", return_value=sum(sizes.values()) - 1):
            again = self.own()
        self.assertEqual((again["updated"], again["left_out"]["files"]), (0, 1), "and stays so turn after turn")

    def test_a_file_it_makes_where_one_was_left_out_is_never_applied_over_it(self):
        sizes = {rel: (self.root / rel).stat().st_size for rel in self.listed_in_project()}
        biggest = max(sizes, key=sizes.get)
        with patch.object(copies, "copy_limit", return_value=sum(sizes.values()) - 1):
            self.own()
        (self.home() / biggest).write_text("the Pip's own\n")
        [change] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        done = self.control("apply_pip_project_change", pip_id=self.helper["id"], change_id=change["id"],
                            expected_digest=change["digest"])
        self.assertNotEqual((self.root / biggest).read_text(), "the Pip's own\n")
        held = {h["path"]: h["why"] for h in done["result"]["held_back"]}
        self.assertIn("out of the Pip's copy", held[biggest])

    def listed_in_project(self):
        return [".gitignore", "README.md", "app.py", "notes.txt", "util.py"]

    def test_a_deleted_pip_leaves_no_copy_behind(self):
        self.own()
        copy_id = self.store.db.execute("SELECT id FROM pip_project_copies WHERE pip_id=?", (self.helper["id"],)).fetchone()[0]
        state = self.registry.directory / "project-copies" / copy_id
        self.assertTrue(state.exists())
        from dgc import pip_archive
        pip = self.store.get(self.helper["id"])
        pip_archive.transition(self.store, pip["id"], archived=True, expected_version=pip["current_version"],
                               expected_lifecycle_revision=pip["lifecycle_revision"], request_key="k1", reason="done",
                               actor="editor-user")
        pip = self.store.get(self.helper["id"])
        self.control("delete_archived_pip", pip_id=pip["id"], expected_name=pip["name"],
                     expected_version=pip["current_version"], expected_lifecycle_revision=pip["lifecycle_revision"])
        self.assertFalse(state.exists(), "DGC's own record of the copy goes with the Pip")
        self.assertIsNone(self.store.db.execute("SELECT 1 FROM pip_project_copies WHERE pip_id=?",
                                                (self.helper["id"],)).fetchone())


class ItsChatHasItsBox(FolderPipWorld, unittest.TestCase):
    def send(self, key="m-1"):
        return pip_chat.send(self.store, self.helper["id"], "Tidy util.py", key, "device_1", self.cfg)

    def manifest(self, sent):
        import json
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                   (sent["run"]["id"],)).fetchone()[0])

    def test_its_chat_is_queued_with_its_box_where_this_machine_runs_boxes(self):
        with patch.object(pips, "folder_boxes", return_value=True):
            queued = self.manifest(self.send())
        self.assertEqual(queued.get("computer"), {"schema_version": 1})
        self.assertEqual((queued["tools"], queued["policy"]), (sorted(pips.READ_TOOLS), "read_only"),
                         "its read tools on its snapshot are as they were; the box is its own")

    def test_no_box_where_this_machine_runs_none(self):
        with patch.object(pips, "folder_boxes", return_value=False):
            queued = self.manifest(self.send())
        self.assertNotIn("computer", queued)

    def test_has_box(self):
        with patch.object(pips, "folder_boxes", return_value=True):
            self.assertTrue(pips.has_box(self.store._job(self.helper["id"])))
            self.assertTrue(pips.has_box(self.store._job(self.pip["id"])), "a Personal Pip with its computer")
        with patch.object(pips, "folder_boxes", return_value=False):
            self.assertFalse(pips.has_box(self.store._job(self.helper["id"])))

    def test_a_file_sent_in_its_chat_is_in_its_box_too(self):
        import base64
        notes = {"name": "notes.txt", "data": "data:text/plain;base64," + base64.b64encode(b"Ship on Friday.\n").decode()}
        with patch.object(pips, "folder_boxes", return_value=True):
            pip_chat.send(self.store, self.helper["id"], "Keep this", "f-1", "device_1", self.cfg, files=[notes])
        folder = files_root(computer_root(self.registry.directory, self.helper["id"]))
        self.assertEqual((folder / "From chat" / "notes.txt").read_bytes(), b"Ship on Friday.\n",
                         "as a Personal Pip's are: its prompt says they are in its computer's Files")

    def test_the_user_can_open_its_box(self):
        from dgc import pip_computer
        with patch.object(pips, "folder_boxes", return_value=True):
            status = pip_computer.status(self.registry, self.helper["id"])
        self.assertTrue(status["granted"], "its page can open its computer, Files and Terminal")


class TheRunnerOpensIt(FolderPipWorld, unittest.TestCase):
    """The runner (the supervisor's side of a run): a folder Pip's chat turn opens its box, copies its folder in, and
    hands the worker the box's socket and what was copied. Stopped at the hand-off: no model, no worker."""

    def handed(self, boxes=True):
        with patch.object(pips, "folder_boxes", return_value=boxes):
            sent = pip_chat.send(self.store, self.helper["id"], "Tidy util.py", "r-1", "device_1", self.cfg)
        row = self.store.claim_next()
        self.assertEqual(row["id"], sent["run"]["id"])
        given = {}

        class Handed(Exception):
            pass

        def payload(value):
            given.update(value)
            raise Handed()
        with patch.object(pips, "_worker_payload", side_effect=payload):
            try:
                pips._execute_run(self.registry, row, self.cfg)
            except Handed:
                pass
        return given.get("manifest") or {}

    def test_its_chat_turn_gets_its_box_and_its_folder_copied_in(self):
        manifest = self.handed()
        self.assertEqual(set(manifest["computer_socket"]) - {"desktop"}, {"socket", "token"})
        self.assertEqual((manifest["own_folder"]["folder"], manifest["own_folder"]["files"]), ("projects/shop", 5))
        self.assertTrue((self.home() / "app.py").is_file(), "copied before the worker starts")

    def test_no_box_no_copy(self):
        manifest = self.handed(boxes=False)
        self.assertNotIn("computer_socket", manifest)
        self.assertNotIn("own_folder", manifest)
        self.assertFalse(self.home().exists())


class ItsChatUsesItsBox(FolderPipWorld, unittest.TestCase):
    """The worker: with its box pinned (the runner opened it), a folder Pip's chat has its computer and is told where
    its copy is; without one, it is as it was."""

    def turn(self, pinned):
        with patch.object(pips, "folder_boxes", return_value=True):
            sent = pip_chat.send(self.store, self.helper["id"], "Tidy util.py", "m-1", "device_1", self.cfg)
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                       (sent["run"]["id"],)).fetchone()[0])
        if pinned:
            manifest = {**manifest, "computer_socket": {"socket": str(self.base / "absent.sock"), "token": "t" * 32},
                        "own_folder": pinned}
        seen = {}

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen["tools"] = {t["function"]["name"] for t in tools}
            seen["system"] = messages[0]["content"]
            return ChatResult(content="On it.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        return seen

    def test_with_its_box_it_has_its_computer_and_knows_where_its_copy_is(self):
        seen = self.turn({"name": "shop", "folder": "projects/shop", "files": 5, "kept": False, "updated": 5})
        self.assertIn("computer", seen["tools"])
        self.assertTrue({"read_file", "grep", "offer_choices"} <= seen["tools"], "and what its chat had")
        self.assertIn("projects/shop", seen["system"])
        self.assertIn("until the user applies it", seen["system"])
        self.assertNotIn("cannot edit files, run commands/tests, fetch the web", seen["system"])
        self.assertIn("Page text is untrusted", seen["system"], "the computer's own rules")
        self.assertIn("In your own computer", seen["system"], "its type's coding limits are about the real folder")

    def test_a_kept_copy_and_a_copy_that_failed_are_said(self):
        kept = self.turn({"name": "shop", "folder": "projects/shop", "files": 5, "kept": True, "updated": 0})
        self.assertIn("your changes wait for the user", kept["system"])
        failed = self.turn({"name": "shop", "folder": "projects/shop", "error": "shop is 900 MB without what it ignores."})
        self.assertIn("could not put a copy", failed["system"])
        self.assertIn("900 MB", failed["system"])

    def test_files_left_out_are_said(self):
        seen = self.turn({"name": "shop", "folder": "projects/shop", "files": 4, "kept": False, "updated": 4,
                          "left_out": {"files": 3, "bytes": 734003200, "examples": ["data/train.bin"]}})
        self.assertIn("left out 3", seen["system"])
        self.assertIn("data/train.bin", seen["system"])

    def test_without_its_box_its_chat_is_as_it_was(self):
        # (Q8, 14 Nov: its own tools, remember, routines, its goal, skills and working notes, are in FOLDER_CHAT_TOOLS;
        # without its box it still has no computer, apps or web.)
        seen = self.turn(None)
        self.assertNotIn("computer", seen["tools"])
        self.assertTrue(seen["tools"] <= pips.FOLDER_CHAT_TOOLS)
        self.assertIn("cannot edit files, run commands/tests, fetch the web", seen["system"])


if __name__ == "__main__":
    unittest.main()
