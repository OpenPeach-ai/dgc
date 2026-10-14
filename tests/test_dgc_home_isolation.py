"""An isolated SDK session (DGC_HOME) keeps every runtime file in its own home, never the account's ~/.dgc: peer notes,
workspace locks and the pasted-image spool (founder, 2026-10-14: isolation wins). The SDK's own end-to-end check
(test_dgc_sdk, "does not touch host") caught a peer note only when the child had not yet cleaned up: this one is exact."""
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import attachments, config, peers, scheduler


class IsolatedHomeTests(unittest.TestCase):
    def setUp(self):
        self.account = Path(tempfile.mkdtemp(prefix="dgc-account-"))
        self.own = Path(tempfile.mkdtemp(prefix="dgc-own-"))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.account, ignore_errors=True))
        self.addCleanup(lambda: __import__("shutil").rmtree(self.own, ignore_errors=True))

    def test_runtime_files_follow_dgc_home(self):
        with patch.dict(os.environ, {"HOME": str(self.account), "DGC_HOME": str(self.own)}):
            self.assertEqual(config.dgc_home(), self.own / ".dgc")
            self.assertEqual(peers.peers_dir(), self.own / ".dgc" / "peers")
            self.assertEqual(scheduler._lock_directory(), self.own / ".dgc" / "locks")
            spool = Path(attachments.spool_root(self.own))
            self.assertTrue(str(spool).startswith(str(self.own / ".dgc" / "spool")), spool)
        self.assertFalse((self.account / ".dgc").exists(), "nothing in the account's ~/.dgc")

    def test_without_dgc_home_it_is_the_account_home(self):
        env = {k: v for k, v in os.environ.items() if k != "DGC_HOME"}
        env["HOME"] = str(self.account)
        with patch.dict(os.environ, env, clear=True):
            self.assertEqual(peers.peers_dir(), self.account / ".dgc" / "peers")
            self.assertEqual(scheduler._lock_directory(), self.account / ".dgc" / "locks")


if __name__ == "__main__":
    unittest.main()
