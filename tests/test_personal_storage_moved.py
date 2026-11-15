"""Pips keep working when DGC's folder moves (user-test round 1, P1, 15 Nov: "Pips didn't load · The personal workspace
binding changed", and Reconnect, Refresh and a restart did nothing).

A Pip's own storage is DGC's own folder, <DGC's Pips folder>/personal. Its binding kept the absolute path it had when it
was made, so a home folder that moved, a backup restored elsewhere, or a copied DGC folder stopped every Pip for good.
That storage is always the registry's own folder, so the binding follows it: put right once, said in the event log.
A personal folder that is a link is still refused, and so is one already bound to something else."""
import os
import shutil
import tempfile
import unittest
from pathlib import Path

from dgc import pip_run_tool
from dgc.workspace_registry import RegistryError, WorkspaceRegistry


class StorageMoved(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-moved-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.old = self.base / "old-home" / "pips"
        self.new = self.base / "new-home" / "pips"
        self.old.mkdir(parents=True)
        with WorkspaceRegistry(self.old) as registry:
            self.workspace = registry.personal()
        shutil.copytree(self.old, self.new)

    def test_a_moved_folder_keeps_its_pips_and_says_it_was_put_right(self):
        shutil.rmtree(self.old)                                   # moved: the old folder is gone
        with WorkspaceRegistry(self.new) as registry:
            workspace = registry.personal()
            self.assertEqual(workspace["id"], self.workspace["id"], "the same Pips, not a new empty space")
            self.assertEqual(registry.binding(workspace["id"])["canonical_root"],
                             str((self.new / "personal").resolve()))
            said = registry.db.execute("SELECT event_type FROM workspace_events WHERE workspace_id=? ORDER BY seq",
                                       (workspace["id"],)).fetchall()
            self.assertIn("workspace_rebound", [row[0] for row in said])

    def test_a_copy_restored_elsewhere_works_too(self):
        # The copy's own folder is its storage, whether or not the original is still there (a restored backup).
        with WorkspaceRegistry(self.new) as registry:
            self.assertEqual(registry.personal()["id"], self.workspace["id"])
        with WorkspaceRegistry(self.old) as original:
            self.assertEqual(original.personal()["id"], self.workspace["id"], "the original keeps working too")

    def test_the_main_chats_pip_tool_puts_it_right_too_and_never_makes_one(self):
        shutil.rmtree(self.old)
        with WorkspaceRegistry(self.new) as registry:
            self.assertEqual(pip_run_tool.personal_workspace(registry)["id"], self.workspace["id"])

    def test_a_personal_folder_that_is_a_link_is_still_refused(self):
        shutil.rmtree(self.old)
        target = self.base / "elsewhere"
        shutil.move(str(self.new / "personal"), target)
        os.symlink(target, self.new / "personal")
        with WorkspaceRegistry(self.new) as registry, self.assertRaises(RegistryError):
            pip_run_tool.personal_workspace(registry)

    def test_a_folder_already_bound_to_something_else_is_refused_and_says_what_to_do(self):
        shutil.rmtree(self.old)
        with WorkspaceRegistry(self.new) as registry:
            registry.db.execute("INSERT INTO workspaces VALUES('ws_other','Other','project','t','t')")
            registry.db.execute("INSERT INTO bindings VALUES('b_other','ws_other',?,?,'t')",
                                (registry.runner_id, str((self.new / "personal").resolve())))
            with self.assertRaises(RegistryError) as caught:
                registry.personal()
            self.assertIn("already", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
