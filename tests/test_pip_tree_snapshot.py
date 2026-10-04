"""Hostile current-tree snapshots: real files, deterministic mutations, no processes."""
import copy
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

from dgc import pip_tree_snapshot as tree
from dgc.workspace_registry import RegistryError


@unittest.skipUnless(os.name == 'posix', 'POSIX descriptor confinement required')
class TreeSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'workspace'; self.root.mkdir()
        self.private = self.base / 'private'; self.private.mkdir(mode=0o700)
        self.destination = self.private / 'source'
        (self.root / 'source.py').write_bytes(b'def hello():\n    return 1\n')

    def capture(self, **kw):
        return tree.capture(self.root, self.destination, **kw)

    def assert_refused(self, code=None, **kw):
        with self.assertRaises(RegistryError) as caught:
            self.capture(**kw)
        if code:
            self.assertEqual(caught.exception.code, code)
        self.assertFalse(self.destination.exists())
        self.assertNotIn(str(self.root), str(caught.exception))
        return caught.exception

    def test_non_git_source_capture_is_private_exact_and_deterministic(self):
        (self.root / 'docs').mkdir()
        (self.root / 'docs' / 'guide.md').write_bytes(b'# Local source\n')
        (self.root / 'empty').mkdir()
        (self.root / 'source.py').chmod(0o755)
        identity = self.root.stat()
        with patch('subprocess.Popen', side_effect=AssertionError('No helper execution')):
            receipt = self.capture(expected_root={'device':identity.st_dev, 'inode':identity.st_ino})
            tree.verify(self.destination, receipt)
        self.assertEqual(receipt['files'], 2)
        self.assertEqual(receipt['bytes'], 41)
        self.assertEqual(receipt['kind'], 'current_tree')
        self.assertEqual(receipt['consistency'], 'checked_non_atomic')
        self.assertNotIn('revision', receipt)
        self.assertNotIn(str(self.root), json.dumps(receipt))
        for path in self.destination.rglob('*'):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o500 if path.is_dir() else 0o400)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o500)
        self.assertEqual((self.destination / 'source.py').read_bytes(), (self.root / 'source.py').read_bytes())
        other = self.private / 'source-two'
        self.assertEqual(tree.capture(self.root, other), receipt)

    def test_directory_and_file_records_have_unambiguous_digest_framing(self):
        # Without typed, length-prefixed records the empty directory "5" plus
        # z(1 byte) encode like a file "directory" containing b"z\\01\\0x".
        (self.root / 'source.py').unlink()
        (self.root / '5').mkdir()
        (self.root / 'z').write_bytes(b'x')
        first = self.capture()
        other = self.base / 'other'; other.mkdir()
        (other / 'directory').write_bytes(b'z\0' + b'1\0x')
        second = tree.capture(other, self.private / 'other-copy')
        self.assertNotEqual(first['sha256'], second['sha256'])
        tree.verify(self.destination, first)
        tree.verify(self.private / 'other-copy', second)

    def test_default_exclusions_are_counted_without_exposing_filenames(self):
        for name in ('.env', '.env.production', '.npmrc', 'credentials.json', 'server.key'):
            (self.root / name).write_text('PRIVATE_CREDENTIAL')
        for name in ('.git', '.dgc', 'node_modules', 'dist'):
            (self.root / name).mkdir()
            (self.root / name / 'deep-secret').write_text('PRIVATE_CREDENTIAL')
        receipt = self.capture(secrets=('PRIVATE_CREDENTIAL',))
        self.assertEqual(receipt['excluded_entries'], 9)
        self.assertEqual(receipt['excluded_directories'], 4)
        self.assertEqual([p.name for p in self.destination.iterdir()], ['source.py'])
        self.assertNotIn('production', json.dumps(receipt))
        self.assertNotIn('server.key', json.dumps(receipt))

    def test_empty_eligible_copy_refused(self):
        (self.root / 'source.py').unlink()
        (self.root / '.env').write_text('private')
        self.assert_refused('empty_snapshot')

    def test_symlink_hardlink_and_fifo_rejected_before_copying(self):
        outside = self.base / 'outside'; outside.write_text('NOT_AUTHORIZED')
        (self.root / 'link').symlink_to(outside)
        with patch.object(tree, '_read', side_effect=AssertionError('Must preflight')):
            self.assert_refused('unsafe_snapshot')
        (self.root / 'link').unlink()
        os.link(outside, self.root / 'linked')
        with patch.object(tree, '_read', side_effect=AssertionError('Must preflight')):
            self.assert_refused('unsafe_snapshot')
        (self.root / 'linked').unlink()
        os.mkfifo(self.root / 'pipe')
        with patch.object(tree, '_read', side_effect=AssertionError('Must preflight')):
            self.assert_refused('unsafe_snapshot')
        self.assertEqual(outside.read_text(), 'NOT_AUTHORIZED')

    def test_symlink_root_ancestor_and_destination_never_followed(self):
        alias = self.base / 'alias'; alias.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RegistryError):
            tree.capture(alias, self.destination)
        parent_alias = self.base / 'parent-alias'; parent_alias.symlink_to(self.base, target_is_directory=True)
        with self.assertRaises(RegistryError):
            tree.capture(parent_alias / 'workspace', self.destination)
        self.destination.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(RegistryError):
            self.capture()
        self.assertTrue(self.destination.is_symlink())
        self.assertTrue((self.root / 'source.py').is_file())

    def test_oversize_sparse_file_total_entries_depth_and_path_bound_before_copy(self):
        with (self.root / 'oversize').open('wb') as file:
            file.truncate(tree.MAX_FILE_BYTES + 1)
        with patch.object(tree, '_read', side_effect=AssertionError('No source allocation')):
            self.assert_refused('snapshot_limit')
        (self.root / 'oversize').unlink()
        for constant, value in (('MAX_BYTES', 8), ('MAX_ENTRIES', 0), ('MAX_INDEX_BYTES', 2), ('MAX_PATH_BYTES', 2)):
            with patch.object(tree, constant, value), patch.object(tree, '_read', side_effect=AssertionError('No source allocation')):
                self.assert_refused('snapshot_limit')
        nested = self.root / 'a' / 'b'; nested.mkdir(parents=True)
        with patch.object(tree, 'MAX_DEPTH', 1):
            self.assert_refused('unsafe_snapshot')

    def test_configured_secret_is_refused_even_across_chunk_boundary(self):
        secret = 'EXACT_CONFIGURED_SECRET'
        (self.root / 'source.py').write_bytes(b'a' * (tree.CHUNK_BYTES - 4) + secret.encode() + b'z')
        error = self.assert_refused('secret_in_source', secrets=(secret,))
        self.assertNotIn(secret, str(error))
        self.assertNotIn('source.py', str(error))

    def test_secret_budget_and_bad_policy_refuse_without_copy(self):
        for secrets in ('not-a-list', ['x'] * 65, ['x' * 8193], ['\ud800']):
            self.assert_refused(secrets=secrets)
        for value in (None, {}, True, {'mode':'current_tree'}, {'mode':'current_tree','exclusions':'none'},
                      {'mode':'committed_only','extra':True}):
            with self.assertRaises(RegistryError): tree.validate_policy(value)
        self.assertEqual(tree.validate_policy({'mode':'committed_only'}), {'mode':'committed_only'})
        self.assertEqual(tree.validate_policy({'mode':'current_tree','exclusions':tree.EXCLUSIONS})['mode'], 'current_tree')

    def test_destination_must_be_new_private_and_outside_workspace(self):
        self.private.chmod(0o755)
        self.assert_refused('unsafe_snapshot')
        self.private.chmod(0o700)
        with self.assertRaises(RegistryError): tree.capture(self.root, self.root / 'snapshot')
        self.destination.mkdir()
        (self.destination / 'keep').write_text('existing')
        with self.assertRaises(RegistryError): self.capture()
        self.assertEqual((self.destination / 'keep').read_text(), 'existing')

    def test_expected_root_identity_and_traversal_refused(self):
        info = self.root.stat()
        self.assert_refused('source_changed', expected_root={'device':info.st_dev, 'inode':info.st_ino + 1})
        with self.assertRaises(RegistryError): tree.capture(self.root / '..' / 'workspace', self.destination)
        with self.assertRaises(RegistryError): tree.capture('workspace', self.destination)

    def test_unsupported_platform_fails_before_open(self):
        with patch.object(tree, '_dirfd_supported', return_value=False), patch.object(tree, '_root', side_effect=AssertionError('No filesystem')):
            self.assert_refused('unsupported_platform')

    def test_mutating_file_before_open_refuses_links_without_read(self):
        original = tree._read
        outside = self.base / 'outside'; outside.write_text('NOT_AUTHORIZED')
        def changed(fd, relative, expected, digest, *args):
            (self.root / relative).unlink()
            (self.root / relative).symlink_to(outside)
            return original(fd, relative, expected, digest, *args)
        with patch.object(tree, '_read', changed):
            self.assert_refused('source_changed')
        self.assertEqual(outside.read_text(), 'NOT_AUTHORIZED')

    def test_mutating_same_size_file_during_read_refused(self):
        original = os.read
        mutated = False
        def changed(fd, amount):
            nonlocal mutated
            part = original(fd, amount)
            if part and not mutated:
                mutated = True
                (self.root / 'source.py').write_bytes(b'x' * len((self.root / 'source.py').read_bytes()))
            return part
        with patch.object(tree.os, 'read', changed):
            self.assert_refused('source_changed')

    def test_tree_addition_and_root_replacement_during_capture_refused(self):
        original = tree._read
        def changed(*args, **kw):
            original(*args, **kw)
            (self.root / 'added').write_text('new')
        with patch.object(tree, '_read', changed): self.assert_refused('source_changed')
        (self.root / 'added').unlink()
        def replaced(*args, **kw):
            original(*args, **kw)
            self.root.rename(self.base / 'old-workspace')
            self.root.mkdir()
            (self.root / 'source.py').write_text('replacement')
        with patch.object(tree, '_read', replaced): self.assert_refused('source_changed')
        self.assertEqual((self.root / 'source.py').read_text(), 'replacement')

    def test_tampered_private_content_extra_file_and_empty_directory_refused(self):
        receipt = self.capture()
        file = self.destination / 'source.py'
        file.chmod(0o600); file.write_bytes(b'bad'); file.chmod(0o400)
        with self.assertRaisesRegex(RegistryError, 'pinned contents'): tree.verify(self.destination, receipt)
        file.chmod(0o600); file.write_bytes((self.root / 'source.py').read_bytes()); file.chmod(0o400)
        self.destination.chmod(0o700)
        extra = self.destination / '.env'; extra.write_text('unapproved'); extra.chmod(0o400)
        self.destination.chmod(0o500)
        with self.assertRaises(RegistryError): tree.verify(self.destination, receipt)
        self.destination.chmod(0o700); extra.unlink()
        extra.mkdir(); extra.chmod(0o500); self.destination.chmod(0o500)
        with self.assertRaisesRegex(RegistryError, 'pinned contents'): tree.verify(self.destination, receipt)

    def test_receipt_shape_counts_permissions_and_overwrite_fail_closed(self):
        receipt = self.capture()
        for changes in ({'files': True}, {'sha256':'g'*64}, {'schema_version':True}, {'exclusions':'none'},
                        {'bytes':tree.MAX_BYTES+1}, {'excluded_directories':100}, {'extra':1}):
            with self.assertRaises(RegistryError): tree.verify(self.destination, {**receipt, **changes})
        self.destination.chmod(0o700)
        with self.assertRaisesRegex(RegistryError, 'read-only'): tree.verify(self.destination, receipt)

    def test_exact_byte_and_entry_bounds_accept_without_overallocation(self):
        payload = (self.root / 'source.py').read_bytes()
        with patch.object(tree, 'MAX_FILE_BYTES', len(payload)), patch.object(tree, 'MAX_BYTES', len(payload)), patch.object(tree, 'MAX_ENTRIES', 1):
            receipt = self.capture()
            self.assertEqual(receipt['bytes'], len(payload))
            self.assertEqual(receipt['files'], 1)

    def test_sparse_aggregate_oversize_refused_before_first_file_read(self):
        for index in range(17):
            with (self.root / ('part-' + str(index))).open('wb') as stream:
                stream.truncate(tree.MAX_FILE_BYTES)
        with patch.object(tree, '_read', side_effect=AssertionError('No file copying before total-size validation')):
            self.assert_refused('snapshot_limit')

    def test_symlink_swap_at_open_cannot_read_outside(self):
        original = os.open
        outside = self.base / 'outside'; outside.write_text('NOT_AUTHORIZED')
        changed = False
        def opening(path, flags, *args, **kw):
            nonlocal changed
            if path == 'source.py' and flags & os.O_CREAT == 0 and not changed:
                changed = True
                (self.root / 'source.py').unlink()
                (self.root / 'source.py').symlink_to(outside)
            return original(path, flags, *args, **kw)
        with patch.object(tree.os, 'supports_dir_fd', os.supports_dir_fd | {opening}), patch.object(tree.os, 'open', opening):
            self.assert_refused('snapshot_unavailable')
        self.assertTrue(changed)
        self.assertEqual(outside.read_text(), 'NOT_AUTHORIZED')

    def test_file_growth_and_truncation_mid_copy_are_refused(self):
        original = os.read
        for payload in (b'', b'expanded ' * 20):
            (self.root / 'source.py').write_bytes(b'original bytes')
            changed = False
            def read(fd, size):
                nonlocal changed
                part = original(fd, size)
                if part and not changed:
                    changed = True
                    (self.root / 'source.py').write_bytes(payload)
                return part
            with patch.object(tree.os, 'read', read):
                self.assert_refused('source_changed')

    def test_ancestor_replacement_is_detected_even_if_old_root_fd_stays_valid(self):
        parent = self.base / 'parent'; parent.mkdir()
        self.root.rename(parent / 'workspace')
        self.root = parent / 'workspace'
        original = tree._read
        def replaced(*args, **kw):
            original(*args, **kw)
            parent.rename(self.base / 'old-parent')
            self.root.mkdir(parents=True)
            (self.root / 'source.py').write_text('new root')
        with patch.object(tree, '_read', replaced):
            self.assert_refused('source_changed')
        self.assertEqual((self.root / 'source.py').read_text(), 'new root')

    def test_source_directory_swap_is_detected(self):
        directory = self.root / 'inner'; directory.mkdir()
        (directory / 'inside').write_text('approved')
        original = tree._read
        replaced = False
        def changed(*args, **kw):
            nonlocal replaced
            original(*args, **kw)
            if not replaced:
                replaced = True
                directory.rename(self.root / 'old-inner')
                directory.mkdir()
                (directory / 'inside').write_text('unapproved')
        with patch.object(tree, '_read', changed):
            self.assert_refused('source_changed')

    def test_configured_secret_failure_has_no_private_partial_file(self):
        (self.root / 'a-safe').write_text('safe first copy')
        (self.root / 'source.py').write_text('a configured PRIVATE_SECRET')
        self.assert_refused('secret_in_source', secrets=('PRIVATE_SECRET',))
        self.assertEqual(list(self.private.iterdir()), [])

    def test_disk_write_failure_cleans_exclusive_copy_only(self):
        with patch.object(tree.os, 'write', side_effect=OSError('Simulated full disk')):
            self.assert_refused('snapshot_unavailable')
        self.assertEqual((self.root / 'source.py').read_bytes(), b'def hello():\n    return 1\n')

    def test_invalid_unicode_and_control_filenames_refused(self):
        for name in ('bad\nname', 'bad:name', 'bad\\name'):
            file = self.root / name; file.write_text('bad')
            self.assert_refused('unsafe_snapshot')
            file.unlink()
        bad = os.fsencode(self.root) + b'/invalid-\xff'
        descriptor = os.open(bad, os.O_CREAT | os.O_WRONLY, 0o600); os.close(descriptor)
        self.assert_refused('unsafe_snapshot')


if __name__ == '__main__': unittest.main()
