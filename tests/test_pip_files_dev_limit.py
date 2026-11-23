"""A Pip computer's Files have no quota of their own (decided 15 Nov: "there should be no limit"); the disk floor keeps
the user's disk from filling. Dev Mode can still set one (asked 12 Nov): one row in its Limits table, in whole GB."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import dev_mode, pip_computer_files as files
from dgc.workspace_registry import RegistryError

GB = 1024 ** 3


def settings(on, gb=None):
    data = {"dev_mode": on}
    if gb is not None:
        data["dev_limits"] = {"pip_files_gb": gb}
    return patch.object(dev_mode, "_settings", return_value=data)


class FilesLimit(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name) / "files"
        self.root.mkdir()
        self.outside = Path(self.tmp.name) / "outside"
        self.outside.mkdir()

    def test_it_is_a_row_in_dev_modes_limits(self):
        row = next(r for r in dev_mode.listing() if r["name"] == "pip_files_gb")
        self.assertEqual((row["default"], row["ceiling"]), (1, 1))
        self.assertIn("GB", row["label"])
        self.assertTrue(row["cost"])

    def test_off_there_is_no_quota_whatever_is_saved(self):
        with settings(False, 5):
            self.assertEqual(files.folder_limit(), 0)
        with settings(True):
            self.assertEqual(files.folder_limit(), 0)

    def test_on_a_nearly_full_folder_takes_more_and_the_words_say_the_size(self):
        with patch.object(files, "folder_bytes", return_value=int(2.5 * GB)):
            with settings(True, 2), self.assertRaises(RegistryError) as caught:
                files._write_new(self.root, [], "note.txt", b"hello")
            self.assertIn("(2 GB)", str(caught.exception))
            with settings(False):
                files._write_new(self.root, [], "note.txt", b"hello")        # no quota of its own
        self.assertEqual((self.root / "note.txt").read_bytes(), b"hello")

    def test_one_file_can_be_as_big_as_the_limit_and_no_bigger(self):
        source = self.outside / "huge.bin"
        with open(source, "wb") as handle:                      # sparse: no real disk used
            handle.truncate(int(2.5 * GB))
        with settings(True, 2), self.assertRaises(RegistryError) as caught:
            files.copy_in(self.root, "", str(source))
        self.assertIn("up to 2 GB", str(caught.exception))
        self.assertEqual(list(self.root.iterdir()), [], "nothing written")
        roomy = type("Usage", (), {"total": 900 * GB, "used": 0, "free": 800 * GB})()
        with settings(False), patch.object(files.shutil, "disk_usage", return_value=roomy):
            files._room_for(self.root, int(2.5 * GB))                     # no quota: only the disk floor decides

    def test_the_terminal_and_background_commands_follow_it(self):
        computer = Path(self.tmp.name) / "computer"
        (computer / "files").mkdir(parents=True)
        with patch.object(files, "files_root", return_value=computer / "files"), \
                patch.object(files, "folder_bytes", return_value=int(1.5 * GB)):
            with settings(True, 1), self.assertRaises(RegistryError) as caught:
                files.run_command(computer, "echo hi", "pip")
            self.assertEqual(caught.exception.code, "computer_full")
            self.assertIn("(1 GB)", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
