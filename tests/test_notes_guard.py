"""Home's Notes are kept from the model (0.52, decided 14 Nov: "never shown to the model unless you share a note").

The editor keeps each note as a file in its storage for the extension (<editor storage>/globalStorage/vibedgc.dgc/notes/).
DGC's file tools reached it: outside the project a path asks in default mode and is allowed in auto mode. Now any file or
search tool aimed inside that folder is refused in every mode, whatever rule allows it; a search from a folder above it
never walks into it; and a shell command that names it is refused. Honest gap: a shell command can still reach it without
naming it (it runs as the user); a locked note is ciphertext whose key is not on disk.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from dgc import notes_guard
from dgc.permissions import DENY, PermissionEngine


class TheNotesFolder(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-notes-guard-")
        self.addCleanup(temp.cleanup)
        self.base = Path(temp.name)
        self.project = self.base / "project"
        self.project.mkdir()
        self.storage = self.base / ".config" / "Code" / "User" / "globalStorage" / "vibedgc.dgc"
        self.notes = self.storage / "notes"
        self.notes.mkdir(parents=True)
        (self.notes / "n1.md").write_text("Passport 1234 and the alarm code\n")
        (self.storage / "other.json").write_text("{}\n")

    def engine(self, mode="auto", rules=None):
        return PermissionEngine(mode, rules or {}, self.project)

    def test_a_note_is_never_read_in_any_mode_even_when_a_rule_allows_it(self):
        for mode in ("auto", "default", "acceptEdits", "bypassPermissions"):
            with self.subTest(mode=mode):
                action, why = self.engine(mode, {"allow": ["Read(**)", f"ExternalDirectory({self.base}/**)"]}).decide(
                    "read_file", {"path": str(self.notes / "n1.md")})
                self.assertEqual(action, DENY, why)
                self.assertIn("notes", why.lower())

    def test_searching_or_listing_the_notes_folder_is_refused(self):
        for tool, args in (("grep", {"pattern": "Passport", "path": str(self.notes)}), ("glob", {"pattern": "*.md", "path": str(self.notes)}),
                           ("write_file", {"path": str(self.notes / "n2.md"), "content": "x"})):
            with self.subTest(tool=tool):
                self.assertEqual(self.engine().decide(tool, args)[0], DENY)

    def test_the_rest_of_the_extensions_storage_and_other_folders_are_untouched(self):
        action, _ = self.engine().decide("read_file", {"path": str(self.storage / "other.json")})
        self.assertNotEqual(action, DENY, "only the notes folder is kept")
        self.assertNotEqual(self.engine().decide("read_file", {"path": str(self.project / "notes" / "todo.md")})[0], DENY,
                            "a project's own notes folder is the user's code")

    def test_a_shell_command_that_names_the_folder_is_refused(self):
        for command in (f"cat {self.notes}/n1.md", "ls ~/.config/Code/User/globalStorage/vibedgc.dgc/notes",
                        r"type %APPDATA%\Code\User\globalStorage\vibedgc.dgc\notes\n1.md"):
            with self.subTest(command=command):
                self.assertEqual(self.engine().decide("bash", {"command": command})[0], DENY)
        self.assertNotEqual(self.engine().decide("bash", {"command": "ls notes/"})[0], DENY)

    def test_the_path_and_command_checks(self):
        self.assertTrue(notes_guard.is_notes_path(self.notes / "n1.md"))
        self.assertTrue(notes_guard.is_notes_path(Path("/Users/me/Library/Application Support/Cursor/User/globalStorage/vibedgc.dgc/notes")))
        self.assertFalse(notes_guard.is_notes_path(self.storage / "other.json"))
        self.assertFalse(notes_guard.is_notes_path(self.project / "notes" / "a.md"))
        self.assertTrue(notes_guard.mentions_notes("rg secret ~/.vscode-server/data/User/globalStorage/vibedgc.dgc/notes/"))

    def test_a_search_from_a_folder_above_never_walks_into_it(self):
        from dgc import tools
        self.assertIn("!**/vibedgc.dgc/notes/**", tools._rg_exclusions())


if __name__ == "__main__":
    unittest.main()
