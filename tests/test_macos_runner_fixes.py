"""What GitHub's macOS runners found in 0.48.0 that a newer Python, a slower machine or a quicker network hid.

1. A troupe's snapshot unpacked its Git archive with tarfile's ``filter="data"``, which Python 3.10.0-3.10.11 and
   3.11.0-3.11.3 do not have (python.org's last 3.10 for macOS is 3.10.11): every troupe routine failed there with
   a TypeError. Without the filter, DGC checks what it would, member by member.
2. The PDF worker's memory watchdog read an exiting worker's resident size a moment after macOS had dropped its
   task but before waitpid could reap it (ESRCH), and reported that the sandbox hid the worker.
3. On a Mac whose login keychain is locked (a runner, a Pip running with the screen locked), the Chrome DGC starts
   with a throwaway profile asked the Keychain for its storage key and its first navigation never answered.
4. A remote MCP sign-in's loopback listener named itself by a reverse DNS lookup of 127.0.0.1 and ::1 (HTTPServer
   does, and macOS asks the network): where nothing answers it, the sign-in waited for that lookup to time out
   before its browser could open, past the 30 s a connection is given.
"""
from __future__ import annotations

import io
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from urllib.request import urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc import browser, documents, mcp_remote, troupe_routines
from dgc.workspace_registry import RegistryError


def _old_python_tarfile():
    """tarfile as Python 3.10.11 has it: no data_filter, and extractall() takes no filter."""
    real = tarfile.TarFile.extractall

    def extractall(self, path=".", members=None, *, numeric_owner=False, **kwargs):
        if "filter" in kwargs:
            raise TypeError("TarFile.extractall() got an unexpected keyword argument 'filter'")
        return real(self, path, members, numeric_owner=numeric_owner)
    patches = [mock.patch.object(tarfile.TarFile, "extractall", extractall)]
    if hasattr(tarfile, "data_filter"):
        patches.append(mock.patch.dict(tarfile.__dict__))
    return patches


class TroupeSnapshotOnOlderPythonTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base, True)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        git = lambda *args: subprocess.run(["git", "-C", str(self.repo), *args], check=True, capture_output=True,
                                           stdin=subprocess.DEVNULL)
        git("init", "-q")
        (self.repo / "app.py").write_text("print('hello')\n")
        (self.repo / "docs").mkdir()
        (self.repo / "docs" / "guide.md").write_text("# Guide\n")
        os.symlink("guide.md", self.repo / "docs" / "README.md")
        git("add", "-A")
        git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "-m", "one")
        self.commit = subprocess.run(["git", "-C", str(self.repo), "rev-parse", "HEAD"], capture_output=True,
                                     text=True, check=True).stdout.strip()

    def old_python(self):
        patches = _old_python_tarfile()
        for patch in patches:
            patch.start()
            self.addCleanup(patch.stop)
        if "data_filter" in tarfile.__dict__:
            del tarfile.data_filter

    def test_a_snapshot_unpacks_on_a_python_without_tar_filters(self):
        self.old_python()
        dest = self.base / "snapshot"
        dest.mkdir()
        troupe_routines.snapshot(str(self.repo), self.commit, dest)
        self.assertEqual((dest / "app.py").read_text(), "print('hello')\n")
        self.assertEqual((dest / "docs" / "guide.md").read_text(), "# Guide\n")
        self.assertTrue((dest / "docs" / "README.md").is_symlink())
        self.assertFalse((dest / ".git").exists())

    def test_without_filters_a_member_or_link_leaving_the_folder_is_refused(self):
        self.old_python()
        for name, kind, link in (("../outside.txt", tarfile.REGTYPE, ""), ("/etc/evil", tarfile.REGTYPE, ""),
                                 ("escape", tarfile.SYMTYPE, "../../etc/passwd"), ("abs", tarfile.SYMTYPE, "/etc/passwd"),
                                 ("fifo", tarfile.FIFOTYPE, "")):
            with self.subTest(name=name):
                raw = io.BytesIO()
                with tarfile.open(fileobj=raw, mode="w") as tar:
                    member = tarfile.TarInfo(name)
                    member.type, member.linkname = kind, link
                    tar.addfile(member, io.BytesIO(b"") if kind == tarfile.REGTYPE else None)
                dest = self.base / f"dest-{abs(hash(name))}"
                dest.mkdir()
                raw.seek(0)
                with tarfile.open(fileobj=raw) as tar, self.assertRaises(RegistryError):
                    troupe_routines._check_snapshot_members(tar, dest)
                self.assertEqual(list(dest.iterdir()), [])


class FakeWorker:
    """A PDF worker that has just exited: its task is gone, and waitpid has not reaped it yet."""

    def __init__(self, reaped_after_wait: bool):
        self.pid = 4242
        self.args = ["pdf-worker"]
        self.reaped_after_wait = reaped_after_wait
        self.waits = []

    def poll(self):
        return None

    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.reaped_after_wait:
            return 0
        raise subprocess.TimeoutExpired(self.args, timeout)


class PdfWatchdogExitRaceTests(unittest.TestCase):
    @staticmethod
    def gone(pid):
        raise ProcessLookupError(3, "could not sample child RSS")

    def test_a_worker_whose_task_is_gone_is_given_the_moment_to_be_reaped(self):
        worker = FakeWorker(reaped_after_wait=True)
        documents._wait_pdf_worker(worker, self.gone)            # no error: it finished
        self.assertEqual(worker.waits, [documents.PDF_EXIT_GRACE_SECONDS])

    def test_a_worker_still_there_without_a_readable_size_is_still_refused(self):
        worker = FakeWorker(reaped_after_wait=False)
        with self.assertRaisesRegex(Exception, "could not sample the worker"):
            documents._wait_pdf_worker(worker, self.gone)

    def test_any_other_sampling_failure_is_refused_at_once(self):
        worker = FakeWorker(reaped_after_wait=True)

        def denied(pid):
            raise PermissionError(1, "could not sample child RSS")
        with self.assertRaisesRegex(Exception, "could not sample the worker"):
            documents._wait_pdf_worker(worker, denied)
        self.assertEqual(worker.waits, [])


class ThrowawayChromeKeychainTests(unittest.TestCase):
    def flags(self, platform):
        session = browser.BrowserSession(Path("/x/chrome"))
        self.addCleanup(session.close)
        with mock.patch.object(sys, "platform", platform):
            return session._flags(True)

    def test_on_a_mac_the_throwaway_profile_never_asks_the_keychain(self):
        flags = self.flags("darwin")
        self.assertIn("--use-mock-keychain", flags)
        self.assertEqual(flags[-1], "about:blank")

    def test_elsewhere_nothing_changes(self):
        self.assertNotIn("--use-mock-keychain", self.flags("linux"))


class SignInListenerTests(unittest.TestCase):
    def test_the_sign_in_listener_never_looks_up_its_own_address(self):
        asked = []

        def getfqdn(name=""):
            asked.append(name)
            return name
        port = mcp_remote.free_port()
        with mock.patch("socket.getfqdn", side_effect=getfqdn):
            callback = mcp_remote._Callback(port, "the-state")
        self.addCleanup(callback.close)
        self.assertEqual(asked, [], "no reverse lookup of the loopback address")
        self.assertEqual(callback.servers[0].server_name, "127.0.0.1")
        with urlopen(f"http://127.0.0.1:{port}/oauth/callback?state=the-state&code=the-code", timeout=10) as reply:
            self.assertIn(b"DGC is signed in", reply.read())
        self.assertTrue(callback.done.wait(5))
        self.assertEqual(callback.code, "the-code")


if __name__ == "__main__":
    unittest.main()
