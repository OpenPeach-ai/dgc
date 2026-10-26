"""One session file, reached through a symlinked folder and through its real path, is one session.

macOS reaches /tmp and /var through symlinks (/private/tmp, /private/var), and a home folder can be a symlink
too, so two DGCs can name the same session file two ways. Compared as written, a terminal's Open here asked a
window to give up "another" session: the window never let it go, and the terminal said the session was open
elsewhere. Found on a Mac Studio running the 0.48 suite (26 Oct 2026).
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import peers


class SymlinkedSessionPathTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.home = self.base / "home"
        self.home.mkdir()
        self._home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.home)
        self.addCleanup(self._restore_home)
        real = self.base / "real"
        (real / "sessions").mkdir(parents=True)
        link = self.base / "link"
        link.symlink_to(real, target_is_directory=True)
        self.real = real / "sessions" / "20261026-120000-abcdef12.json"
        self.real.write_text("{}")
        self.link = link / "sessions" / self.real.name

    def _restore_home(self):
        if self._home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._home

    def note(self, session: Path) -> dict:
        return {"pid": os.getpid(), "proc_start": peers._proc_start(os.getpid()), "kind": "serve",
                "session": str(session), "cwd": str(self.base), "project_root": str(self.base),
                "status": "idle", "heartbeat": time.time()}

    def test_the_same_file_through_a_symlinked_folder_is_the_same_session(self):
        self.assertNotEqual(str(self.link), str(self.real), "the two spellings really differ")
        self.assertTrue(peers._same_session(self.note(self.link), str(self.real)))
        self.assertTrue(peers._same_session(self.note(self.real), str(self.link)))
        self.assertEqual(peers.session_key(self.link), peers.session_key(self.real))

    def test_another_file_in_the_same_folder_is_still_another_session(self):
        other = self.real.with_name("20261026-120001-99999999.json")
        self.assertFalse(peers._same_session(self.note(self.link), str(other)))
        self.assertFalse(peers._same_session(self.note(self.link), ""))

    def test_an_open_here_ask_reaches_a_holder_that_names_the_session_the_other_way(self):
        # The terminal names the session by its real path; the window holding it, through the symlink.
        holder = self.note(self.link)
        self.assertTrue(peers.request_release(holder, str(self.real), open_here=True, by="the terminal"))
        ask = peers.pending_release(str(self.link))
        self.assertIsNotNone(ask, "the holder must see the ask as being for its own session")
        self.assertTrue(ask.get("open_here"))

    def test_the_holder_is_described_by_the_chat_that_holds_it_either_way(self):
        record = self.note(self.base / "elsewhere.json")
        record["sessions"] = [{"session": str(self.link), "cwd": "/the/chat/folder", "status": "idle"}]
        self.assertIn("/the/chat/folder", peers.describe_holder(record, str(self.real)))

    def test_the_session_this_process_holds_has_one_spelling(self):
        from dgc import agent
        self.assertEqual(agent._owner_key(self.link), agent._owner_key(self.real))


if __name__ == "__main__":
    unittest.main()
