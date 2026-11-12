"""Big files between this computer and a Pip computer's Files (pc-background-commands, Pips API 87).

A file the user picks on this computer is copied into the Pip computer's Files, and a file in its Files is copied
to a place the user picks, up to the Files folder's own limit (1 GB), streamed, never through the 2 MB editor
transport. Only the user, on this computer. A link in Files is never followed; a file over the limit says the limit.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_computer_files as files, pips
from dgc.headless import PIPS_API_VERSION
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests import test_pip_computer_desk as desk_tests


class BigFileTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp
    computer_pip, control, ok, folder = (desk_tests.DeskTests.computer_pip, desk_tests.DeskTests.control,
                                         desk_tests.DeskTests.ok, desk_tests.DeskTests.folder)

    def setUp(self):
        self.setUp_base()
        self.cfg.data["pips_enabled"] = True
        self.pip = self.computer_pip()
        self.outside = Path(tempfile.mkdtemp(prefix="dgc-bigfiles-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.outside, ignore_errors=True))

    def make(self, name, size):
        path = self.outside / name
        with open(path, "wb") as handle:
            block = os.urandom(1 << 16)
            left = size
            while left > 0:
                handle.write(block[:min(left, len(block))])
                left -= min(left, len(block))
        return path

    def test_the_api_says_it_has_copies(self):
        self.assertGreaterEqual(PIPS_API_VERSION, 87)

    def test_a_file_bigger_than_the_editor_transport_copies_in_and_back_out_exactly(self):
        source = self.make("dataset.bin", 5 * 1024 * 1024 + 7)            # past the 2 MB data-URI limit
        got = self.ok({"type": "copy_pip_computer_file_in", "pip_id": self.pip["id"], "path": "", "source": str(source)})
        self.assertEqual((got["name"], got["bytes"]), ("dataset.bin", source.stat().st_size))
        inside = self.folder(self.pip) / "dataset.bin"
        self.assertEqual(inside.read_bytes(), source.read_bytes())
        # Again: a second copy keeps the first, under a new name.
        again = self.ok({"type": "copy_pip_computer_file_in", "pip_id": self.pip["id"], "path": "", "source": str(source)})
        self.assertEqual(again["name"], "dataset (1).bin")
        # Out, to a place the user picked.
        target = self.outside / "back" / "copy.bin"
        target.parent.mkdir()
        out = self.ok({"type": "copy_pip_computer_file_out", "pip_id": self.pip["id"], "path": "dataset.bin", "target": str(target)})
        self.assertEqual(out["bytes"], source.stat().st_size)
        self.assertEqual(target.read_bytes(), source.read_bytes())
        self.assertEqual([p.name for p in target.parent.iterdir()], ["copy.bin"], "no temporary file is left beside it")

    def test_over_the_limit_it_says_the_limit_and_writes_nothing(self):
        source = self.outside / "huge.bin"
        with open(source, "wb") as handle:                                   # sparse: no real disk used
            handle.truncate(files.MAX_COPY_BYTES + 1)
        reply = self.control({"type": "copy_pip_computer_file_in", "pip_id": self.pip["id"], "path": "", "source": str(source)})
        self.assertFalse(reply["ok"])
        self.assertIn("1 GB", reply["error"]["message"])
        self.assertEqual([p for p in self.folder(self.pip).iterdir() if p.name != "Downloads"], [])
        # With the folder nearly full, a file that would pass it is refused the same way.
        self.make("small.bin", 4096)
        with patch.object(files, "folder_bytes", return_value=files.MAX_FOLDER_BYTES - 100):
            full = self.control({"type": "copy_pip_computer_file_in", "pip_id": self.pip["id"], "path": "",
                                 "source": str(self.outside / "small.bin")})
        self.assertFalse(full["ok"])
        self.assertIn("full", full["error"]["message"])

    def test_only_regular_files_and_never_through_a_link_in_files(self):
        for bad in (str(self.outside), str(self.outside / "missing.bin"), "relative/path.bin", ""):
            with self.subTest(source=bad):
                self.assertFalse(self.control({"type": "copy_pip_computer_file_in", "pip_id": self.pip["id"], "path": "",
                                               "source": bad})["ok"])
        secret = self.make("secret.txt", 64)
        os.symlink(secret, self.folder(self.pip) / "link.txt")                 # the Terminal could make one
        target = self.outside / "out.txt"
        reply = self.control({"type": "copy_pip_computer_file_out", "pip_id": self.pip["id"], "path": "link.txt", "target": str(target)})
        self.assertFalse(reply["ok"])
        self.assertFalse(target.exists(), "a link in Files is never followed out")
        # Out to a folder, or to a place that doesn't exist, is refused.
        self.make("in.bin", 10)
        self.ok({"type": "copy_pip_computer_file_in", "pip_id": self.pip["id"], "path": "", "source": str(self.outside / "in.bin")})
        for bad in (str(self.outside), str(self.outside / "nowhere" / "x.bin"), "relative.bin"):
            with self.subTest(target=bad):
                self.assertFalse(self.control({"type": "copy_pip_computer_file_out", "pip_id": self.pip["id"],
                                               "path": "in.bin", "target": bad})["ok"])

    def test_the_python_sdk_knows_them_and_refuses_them_before_api_87(self):
        from dgc_sdk.errors import DGCUnsupportedError
        from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS
        from tests.test_dgc_sdk_pips import CAPS, session
        self.assertEqual(set(COMMAND_FIELDS["copy_pip_computer_file_in"]), {"pip_id", "path", "source"})
        self.assertEqual(set(COMMAND_FIELDS["copy_pip_computer_file_out"]), {"pip_id", "path", "target"})
        self.assertTrue({"copy_pip_computer_file_in", "copy_pip_computer_file_out"} <= MUTATION_COMMANDS)
        with self.assertRaisesRegex(DGCUnsupportedError, "87"):
            session(caps={**CAPS, "pips_api_version": 86}).pips.mutate("copy_pip_computer_file_in",
                                                               {"pip_id": "pip_" + "a" * 32, "path": "", "source": "/tmp/a"}, approved=True)

    def test_only_the_user_on_this_computer(self):
        source = self.make("a.bin", 10)
        for command, fields in (("copy_pip_computer_file_in", {"path": "", "source": str(source)}),
                                ("copy_pip_computer_file_out", {"path": "a.bin", "target": str(self.outside / "b.bin")})):
            with self.subTest(command=command):
                reply = self.control({"type": command, "pip_id": self.pip["id"], **fields}, actor="remote-sdk")
                self.assertFalse(reply["ok"])


if __name__ == "__main__":
    unittest.main()
