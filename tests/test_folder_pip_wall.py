"""Every Pip has its own box, step 2: a folder Pip's level and the wall (0.52, pips-sandbox-design §2).

Inside its box nothing asks; only what crosses the wall follows its level. For a folder Pip with a box: its level
(Ask me first / Approve for me / Do it all) governs its computer as a Personal Pip's does, careful mode is its user's to
turn off, and at Do it all what it changed in its copy is applied to the real folder when its turn ends, file by file,
never over a file the user changed meanwhile, always with Undo. A level chosen before folder Pips had a box was about
handoffs only ("never changes your files"), so it keeps that meaning: the box reads Ask until the level is chosen again.
"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from tests.test_folder_pip_box import FolderPipWorld  # noqa: E402
from dgc import pip_careful, pip_levels as levels, pip_project_copies as copies, pips  # noqa: E402


class WithABox(FolderPipWorld):
    def setUp(self):
        super().setUp()
        boxes = patch.object(pips, "folder_boxes", return_value=True)
        boxes.start()
        self.addCleanup(boxes.stop)

    def choose(self, level):
        return levels.set_level(self.registry, self.helper["id"], level, "editor-user")

    def edit_its_copy(self, rel="app.py", text="def total(items):\n    return sum(items) + 0\n"):
        copies.own_folder(self.store, self.helper["id"])
        (self.home() / rel).write_text(text)


class ItsLevel(WithABox, unittest.TestCase):
    def test_a_level_chosen_now_governs_its_box(self):
        said = self.choose(levels.APPROVE)
        self.assertEqual(levels.level(self.registry, self.helper["id"]), levels.APPROVE)
        self.assertEqual(said["kind"], "project")
        self.assertIn("computer", said["levels"][2]["says"])
        self.assertIn("applies what it changed to your folder", said["levels"][2]["says"])

    def test_a_level_chosen_before_folder_pips_had_a_box_keeps_its_old_meaning(self):
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (
                levels.KEY + self.helper["id"], json.dumps({"level": "full", "at": "2026-11-12T10:00:00.000Z",
                                                            "by": "editor-user"})))
        self.assertEqual(levels.level(self.registry, self.helper["id"]), levels.ASK, "its box asks until chosen again")
        self.assertEqual(levels.project_level(self.registry, self.helper["id"]), levels.FULL, "its handoffs as chosen")

    def test_careful_mode_is_its_users_to_turn_off(self):
        said = pip_careful.set_on(self.registry, self.helper["id"], False, "editor-user")
        self.assertFalse(said["careful"])
        self.assertFalse(pip_careful.is_on(self.registry, self.helper["id"]))


class WithoutABox(FolderPipWorld, unittest.TestCase):
    def test_without_a_box_its_level_is_about_its_handoffs_only(self):
        said = levels.set_level(self.registry, self.helper["id"], levels.FULL, "editor-user")
        self.assertEqual(levels.level(self.registry, self.helper["id"]), levels.ASK)
        self.assertEqual(said["levels"][2]["says"], levels.PROJECT_SAYS[levels.FULL])
        with self.assertRaises(Exception):
            pip_careful.set_on(self.registry, self.helper["id"], False, "editor-user")


class TheWall(WithABox, unittest.TestCase):
    def test_at_do_it_all_its_change_is_applied_to_the_folder(self):
        self.choose(levels.FULL)
        self.edit_its_copy()
        applied = copies.auto_apply(self.store, self.helper["id"])
        self.assertEqual([c["status"] for c in applied], ["applied"])
        self.assertIn("sum(items) + 0", (self.root / "app.py").read_text())
        [change] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        self.assertEqual(change["status"], "applied")
        self.assertEqual(change["result"]["by"], "pip-level:full")
        undone = self.control("undo_pip_project_change", pip_id=self.helper["id"], change_id=change["id"])
        self.assertNotIn("+ 0", (self.root / "app.py").read_text(), "Undo as for one you applied")
        self.assertTrue(undone)

    def test_a_file_you_changed_meanwhile_is_held_back(self):
        self.choose(levels.FULL)
        self.edit_its_copy()
        (self.root / "app.py").write_text("# yours\n")
        [change] = copies.auto_apply(self.store, self.helper["id"])
        self.assertEqual((self.root / "app.py").read_text(), "# yours\n", "never over your edit")
        self.assertIn(change["status"], ("not_applied", "partial"))

    def test_below_do_it_all_it_waits_for_you(self):
        for level in (levels.ASK, levels.APPROVE):
            self.choose(level)
            self.edit_its_copy()
            self.assertEqual(copies.auto_apply(self.store, self.helper["id"]), [])
            self.assertNotIn("+ 0", (self.root / "app.py").read_text())
        [change] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        self.assertEqual(change["status"], "pending")

    def test_an_older_do_it_all_never_applies(self):
        with self.registry.transaction():
            self.registry.db.execute("INSERT OR REPLACE INTO metadata VALUES(?,?)", (
                levels.KEY + self.helper["id"], json.dumps({"level": "full", "at": "2026-11-12T10:00:00.000Z",
                                                            "by": "editor-user"})))
        self.edit_its_copy()
        self.assertEqual(copies.auto_apply(self.store, self.helper["id"]), [])
        self.assertNotIn("+ 0", (self.root / "app.py").read_text())

    def test_it_shows_in_what_it_did_on_its_own(self):
        self.choose(levels.FULL)
        self.edit_its_copy()
        copies.auto_apply(self.store, self.helper["id"])
        done = levels.on_its_own(self.registry, self.helper["id"])
        self.assertTrue(any("shop" in item["what"] and item["level"] == "full" for item in done), done)


class TheRunnerApplies(WithABox, unittest.TestCase):
    """A whole chat turn through the runner and a real worker (its model stood in): the Pip's edit in its copy, made
    during the turn, is in the real folder when the turn ends at Do it all, and waits for the user below it."""

    def turn(self):
        import subprocess
        import sys
        from dgc import pip_chat
        sent = pip_chat.send(self.store, self.helper["id"], "Make total add zero", "w-1", "device_1", self.cfg)
        row = self.store.claim_next()
        target = str(self.home() / "app.py")
        fixture = f'''from unittest.mock import patch
from dgc.llm import ChatResult, LLMClient
from dgc.pips import _worker_main
from pathlib import Path

def chat(self, messages, tools=None, on_text=None, **kwargs):
    Path({target!r}).write_text("def total(items):\\n    return sum(items) + 0\\n")   # its edit, in its copy
    return ChatResult(content="Done: total now adds zero.")
with patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''
        original = subprocess.Popen

        def launch(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return original(argv, *args, **kwargs)
        with patch.object(pips.subprocess, "Popen", side_effect=launch):
            result = pips._execute_run(self.registry, row, self.cfg)
        self.store.finish(sent["run"]["id"], result=result)
        return result

    def test_at_do_it_all_its_edit_is_in_the_folder_when_the_turn_ends(self):
        self.choose(levels.FULL)
        self.turn()
        self.assertIn("sum(items) + 0", (self.root / "app.py").read_text())

    def test_below_do_it_all_it_waits_as_a_card(self):
        self.choose(levels.APPROVE)
        self.turn()
        self.assertNotIn("+ 0", (self.root / "app.py").read_text())
        [change] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        self.assertEqual(change["status"], "pending")


if __name__ == "__main__":
    unittest.main()
