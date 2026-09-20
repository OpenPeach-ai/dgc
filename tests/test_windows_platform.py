"""The Windows platform contract: which shell runs, which spelling of a path a rule sees, and
what the ready frame promises about confinement.

Most of it is testable on any OS, on purpose: Windows path rules are parsed with Windows rules
(``ntpath``) rather than the host's, and the identity-width tolerance is a switch rather than a
platform check. The handful of cases that need a real Windows filesystem — resolving Git for
Windows bash, running a command through it — are skipped elsewhere and named as such.
"""
from __future__ import annotations

import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import headless, permissions, protocol_cli, shell, workspace  # noqa: E402
from dgc.workspace import FileVersion, WorkspaceBoundaryError          # noqa: E402

WINDOWS = os.name == "nt"


class ShellResolverTests(unittest.TestCase):
    def setUp(self):
        shell.reset_cache()
        self.addCleanup(shell.reset_cache)

    def test_the_windows_bash_exe_is_never_the_wsl_launcher(self):
        for text in (r"C:\Windows\System32\bash.exe", r"C:\WINDOWS\system32\bash.exe",
                     r"C:\Windows\Sysnative\bash.exe", r"C:\Windows\SysWOW64\bash.exe"):
            self.assertTrue(shell.is_wsl_launcher(text), text)
        for text in (r"C:\Program Files\Git\bin\bash.exe",
                     r"C:\Users\me\scoop\apps\git\current\bin\bash.exe", "/bin/bash"):
            self.assertFalse(shell.is_wsl_launcher(text), text)

    def test_git_for_windows_is_looked_for_before_anything_on_path(self):
        env = {"ProgramFiles": r"C:\Program Files", "LOCALAPPDATA": r"C:\Users\me\AppData\Local",
               "PATH": ""}
        candidates = shell.windows_candidates(env)
        self.assertEqual(candidates[0], r"C:\Program Files\Git\bin\bash.exe")
        self.assertIn(r"C:\Users\me\AppData\Local\Programs\Git\bin\bash.exe", candidates)
        self.assertTrue(all("System32" not in item for item in candidates))

    def test_the_missing_bash_sentence_is_the_one_the_sdk_repeats(self):
        self.assertEqual(shell.WINDOWS_MISSING_BASH,
                         "no bash found: install Git for Windows "
                         "(https://git-scm.com/download/win)")

    def test_a_resolved_shell_reports_itself_as_a_capability(self):
        capability = shell.capability()
        self.assertEqual(set(capability), {"path", "kind", "reason"})
        if capability["kind"] is None:
            self.assertEqual(capability["path"], "")
            self.assertTrue(capability["reason"])
        else:
            self.assertIn(capability["kind"], ("bash", "git-bash"))
            self.assertTrue(os.path.isabs(capability["path"]))
            self.assertEqual(capability["reason"], "")

    def test_the_argv_is_the_same_shape_everywhere(self):
        if not shell.resolve().available:
            self.skipTest("this machine has no shell at all")
        self.assertEqual(shell.argv("echo hi")[1:], ["-o", "pipefail", "-c", "echo hi"])
        self.assertEqual(shell.argv("echo hi", login=True, pipefail=False)[1:],
                         ["-l", "-c", "echo hi"])

    def test_an_override_that_is_not_a_shell_is_refused_with_a_reason(self):
        with tempfile.TemporaryDirectory() as folder:
            missing = os.path.join(folder, "nope")
            resolved = shell.resolve({shell.SHELL_ENV: missing})
            self.assertIsNone(resolved.kind)
            # The ready frame's `reason` is the frozen sentence and nothing else; the note about
            # the bad override travels in `detail`, where an error message picks it up.
            self.assertEqual(resolved.reason,
                             shell.WINDOWS_MISSING_BASH if os.name == "nt"
                             else shell.POSIX_MISSING_BASH)
            self.assertIn("is not a usable shell", resolved.detail)
            self.assertEqual(resolved.capability()["reason"], resolved.reason)
            with patch.dict(os.environ, {shell.SHELL_ENV: missing}):
                shell.reset_cache()
                with self.assertRaises(shell.ShellUnavailable) as raised:
                    shell.argv("echo hi")
                self.assertIn("is not a usable shell", str(raised.exception))

    @unittest.skipUnless(WINDOWS, "needs a real Git for Windows install")
    def test_a_command_runs_through_git_bash_with_its_exit_code(self):
        resolved = shell.resolve()
        self.assertEqual(resolved.kind, "git-bash", resolved.reason)
        done = subprocess.run(shell.argv("echo hi && exit 3"), capture_output=True, text=True)
        self.assertEqual(done.returncode, 3)
        self.assertIn("hi", done.stdout)

    @unittest.skipUnless(WINDOWS, "needs a real Git for Windows install")
    def test_pipefail_is_on_so_an_earlier_failure_is_not_hidden(self):
        done = subprocess.run(shell.argv("false | cat"), capture_output=True, text=True)
        self.assertNotEqual(done.returncode, 0)


class PathSpellingTests(unittest.TestCase):
    """One Windows path, one spelling — parsed with Windows rules on every host."""

    def test_the_extended_length_prefix_is_removed(self):
        self.assertEqual(workspace.windows_canonical_text(r"\\?\C:\work\file.txt"),
                         r"C:\work\file.txt")
        self.assertEqual(workspace.windows_canonical_text(r"\\?\UNC\server\share\file.txt"),
                         r"\\server\share\file.txt")

    def test_forward_slashes_and_dot_segments_normalise(self):
        self.assertEqual(workspace.windows_canonical_text("C:/work/./sub/../file.txt"),
                         r"C:\work\file.txt")

    def test_an_alternate_data_stream_is_refused(self):
        with self.assertRaises(WorkspaceBoundaryError):
            workspace.windows_canonical_text(r"C:\work\secret.txt:hidden")
        with self.assertRaises(WorkspaceBoundaryError):
            workspace.windows_canonical_text(r"C:\work\secret.txt:$DATA")

    def test_a_drive_letter_is_not_mistaken_for_a_stream(self):
        self.assertEqual(workspace.windows_canonical_text(r"C:\work"), r"C:\work")

    def test_a_device_name_keeps_its_prefix_instead_of_becoming_relative(self):
        self.assertEqual(workspace.windows_canonical_text(r"\\.\PhysicalDrive0"),
                         r"\\.\PhysicalDrive0")

    def test_a_deny_rule_also_sees_the_stream_and_prefix_spellings(self):
        spellings = permissions.windows_spellings(r"\\?\C:\work\secret.txt:hidden", windows=True)
        self.assertIn(r"C:\work\secret.txt", spellings)
        self.assertNotIn(r"\\?\C:\work\secret.txt:hidden", spellings)

    def test_nothing_extra_is_produced_off_windows(self):
        self.assertEqual(permissions.windows_spellings(r"C:\work\x", windows=False), [])


class JunctionTests(unittest.TestCase):
    """A junction is a reparse point that S_ISLNK does not flag (critic C6)."""

    @staticmethod
    def _info(attributes: int, tag: int):
        class _Stat:
            st_file_attributes = attributes
            st_reparse_tag = tag
            st_mode = stat.S_IFDIR | 0o755
        return _Stat()

    def test_a_junction_and_a_symlink_are_both_redirects(self):
        with patch.object(workspace.os, "name", "nt"):
            self.assertTrue(workspace._redirects_elsewhere(self._info(0x400, 0xA0000003)))
            self.assertTrue(workspace._redirects_elsewhere(self._info(0x400, 0xA000000C)))

    def test_an_ordinary_directory_and_other_reparse_tags_are_not(self):
        with patch.object(workspace.os, "name", "nt"):
            self.assertFalse(workspace._redirects_elsewhere(self._info(0x10, 0)))
            # A cloud placeholder (OneDrive) is a reparse point that names the same file.
            self.assertFalse(workspace._redirects_elsewhere(self._info(0x400, 0x9000001A)))


class FileIdentityTests(unittest.TestCase):
    """os.stat() and os.fstat() report a Windows file's id at two widths (the 3.13 break)."""

    @staticmethod
    def _version(device: int, inode: int) -> FileVersion:
        return FileVersion(device, inode, stat.S_IFREG, 12, 1_000, 2_000)

    def test_the_two_widths_describe_the_same_file(self):
        handle = self._version(0x1234ABCD, 0x0001_0000_0000_0007)
        path = self._version(0x0000_0000_1234_ABCD, 0x0000_0000_0000_0000_0001_0000_0000_0007)
        with patch.object(workspace, "_TOLERATE_ID_WIDTH", True):
            self.assertEqual(handle, path)

    def test_a_windows_creation_time_is_not_a_change_signal(self):
        """st_ctime on Windows is the creation time, and the two stat paths disagree on it."""
        with patch.object(workspace, "_TOLERATE_ID_WIDTH", True):
            self.assertEqual(FileVersion(1, 7, stat.S_IFREG, 12, 1_000, 2_000),
                             FileVersion(1, 7, stat.S_IFREG, 12, 1_000, 2_004_000_000))
        with patch.object(workspace, "_TOLERATE_ID_WIDTH", False):
            self.assertNotEqual(FileVersion(1, 7, stat.S_IFREG, 12, 1_000, 2_000),
                                FileVersion(1, 7, stat.S_IFREG, 12, 1_000, 2_004_000_000))

    def test_a_different_file_is_still_a_different_file(self):
        with patch.object(workspace, "_TOLERATE_ID_WIDTH", True):
            self.assertNotEqual(self._version(1, 7), self._version(1, 8))
            self.assertNotEqual(self._version(1, 7),
                                FileVersion(1, 7, stat.S_IFREG, 13, 1_000, 2_000))
            self.assertNotEqual(self._version(1, 7),
                                FileVersion(1, 7, stat.S_IFREG, 12, 1_001, 2_000))
            self.assertNotEqual(self._version(1, 7),
                                FileVersion(1, 7, stat.S_IFLNK, 12, 1_000, 2_000))

    def test_posix_keeps_comparing_every_field_exactly(self):
        with patch.object(workspace, "_TOLERATE_ID_WIDTH", False):
            self.assertNotEqual(self._version(1, 1 << 64 | 7), self._version(1, 7))

    def test_a_mismatch_says_which_field_differs(self):
        detail = self._version(1, 7).difference(self._version(1, 8))
        self.assertEqual(detail, "inode 7 != 8")
        self.assertEqual(self._version(1, 7).difference(self._version(1, 7)), "no field differs")

    def test_a_real_read_round_trips_on_this_machine(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "file.txt"
            target.write_text("hello")
            data, version = workspace.read_regular_bytes(target)
            self.assertEqual(data, b"hello")
            self.assertEqual(workspace.capture_file_state(target)[1], b"hello")
            self.assertEqual(version.size, 5)


class ProtocolDescribeTests(unittest.TestCase):
    def test_describe_names_the_interpreter_dgc_runs_on(self):
        document = protocol_cli.describe_document()
        self.assertEqual(document["schema_version"], 1)
        self.assertEqual(document["python"], sys.executable)
        self.assertTrue(os.path.isabs(document["python"]))

    def test_describe_is_still_json(self):
        json.dumps(protocol_cli.describe_document())


class SandboxCapabilityTests(unittest.TestCase):
    """capabilities.session_policy.sandbox_capabilities — one boolean per guarantee."""

    FLAGS = ("process_isolated", "home_hidden", "private_temporary", "network_isolated",
             "keychain_hidden")

    def test_no_backend_promises_nothing(self):
        block = headless.sandbox_capabilities(None, None)
        self.assertIsNone(block["backend"])
        self.assertIsNone(block["profile"])
        self.assertTrue(all(block[flag] is False for flag in self.FLAGS))

    def test_every_flag_is_a_boolean_and_the_shape_is_exact(self):
        block = headless.sandbox_capabilities(None, None)
        self.assertEqual(set(block), {"backend", "profile", *self.FLAGS})
        self.assertTrue(all(isinstance(block[flag], bool) for flag in self.FLAGS))

    def test_bubblewrap_names_its_profile_and_hides_the_credential_store(self):
        block = headless.sandbox_capabilities(None, "bwrap")
        self.assertEqual(block["backend"], "bwrap")
        self.assertEqual(block["profile"], "bwrap-v1")
        self.assertTrue(block["home_hidden"])
        self.assertTrue(block["private_temporary"])
        self.assertTrue(block["process_isolated"])
        # A private home and a private runtime directory are where a Linux credential agent's
        # socket lives, so hiding them hides it.
        self.assertTrue(block["keychain_hidden"])

    def test_an_unnamed_profile_promises_nothing_even_with_a_backend(self):
        block = headless.sandbox_capabilities(None, "sandbox-exec")
        self.assertEqual(block["backend"], "sandbox-exec")
        self.assertIsNone(block["profile"],
                          "an allow-by-default profile must never be reported as strict-v1")
        self.assertTrue(all(block[flag] is False for flag in self.FLAGS))

    def test_a_published_block_is_used_when_it_has_the_agreed_shape(self):
        published = {"backend": "sandbox-exec", "profile": "strict-v1", "process_isolated": True,
                     "home_hidden": True, "private_temporary": True, "network_isolated": True,
                     "keychain_hidden": True}
        with patch("dgc.sandbox.capabilities_dict", create=True, return_value=dict(published)):
            self.assertEqual(headless.sandbox_capabilities(None, "sandbox-exec"), published)

    def test_a_malformed_published_block_is_ignored_rather_than_forwarded(self):
        for bad in ({"backend": "x"}, {"backend": "x", "profile": "y", "home_hidden": "yes"},
                    "not a dict", None):
            with patch("dgc.sandbox.capabilities_dict", create=True, return_value=bad):
                block = headless.sandbox_capabilities(None, "bwrap")
                self.assertEqual(block["profile"], "bwrap-v1")
                self.assertTrue(all(isinstance(block[flag], bool) for flag in self.FLAGS))

    def test_a_published_block_that_raises_is_not_fatal(self):
        with patch("dgc.sandbox.capabilities_dict", create=True, side_effect=RuntimeError("no")):
            block = headless.sandbox_capabilities(None, "bwrap")
            self.assertEqual(block["profile"], "bwrap-v1")
            self.assertIsNone(headless.sandbox_capabilities(None, None)["backend"])

    def test_a_session_with_no_sandbox_never_reports_one(self):
        """A host that could confine says nothing when this session is not confined."""
        published = {"backend": "bwrap", "profile": "bwrap-v1", "process_isolated": True,
                     "home_hidden": True, "private_temporary": True, "network_isolated": True,
                     "keychain_hidden": True}
        with patch("dgc.sandbox.capabilities_dict", create=True, return_value=published):
            with patch("dgc.sandbox.requested", return_value=False):
                block = headless.sandbox_capabilities(None)
        self.assertIsNone(block["backend"])
        self.assertTrue(all(block[flag] is False for flag in self.FLAGS))


@unittest.skipUnless(WINDOWS, "the Windows update path")
class WindowsUpdateTests(unittest.TestCase):
    def test_update_says_what_to_run_instead_of_reaching_for_bash(self):
        from rich.console import Console
        from dgc import update as update_mod
        stream = __import__("io").StringIO()
        code = update_mod._windows_update_instructions(Console(file=stream, width=100), None)
        text = stream.getvalue()
        self.assertEqual(code, update_mod.EXIT_FAILED)
        self.assertIn("pipx install", text)
        self.assertIn("uv tool install", text)
        self.assertIn("pip install dgc", text)


if __name__ == "__main__":
    unittest.main()
