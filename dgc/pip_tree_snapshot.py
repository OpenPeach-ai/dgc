"""Bounded, non-atomic current-tree captures for explicitly reviewed read-only Pips.

No Git, project ignore files, executable hooks, subprocesses or restoration. A
controller must authorize the source policy before capture and verify the pinned
receipt before use. This helper alone does not add current-tree run support.
"""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import stat

from .workspace import _absolute_frozen, _open_parent_fd, _dirfd_supported, WorkspaceBoundaryError
from .workspace_registry import RegistryError

MAX_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 4 * 1024 * 1024
MAX_ENTRIES = 10000
MAX_DEPTH = 32
MAX_PATH_BYTES = 1024
MAX_INDEX_BYTES = 4 * 1024 * 1024
CHUNK_BYTES = 65536
EXCLUSIONS = 'safe_source_v1'
CONSISTENCY = 'checked_non_atomic'
_EXCLUDED_DIRS = frozenset({'.git', '.hg', '.svn', '.dgc', '.ssh', '.aws', '.azure', '.gcloud',
    '.config', 'node_modules', 'vendor', '.venv', 'venv', '__pycache__', '.cache', '.pytest_cache',
    '.mypy_cache', '.ruff_cache', '.next', '.nuxt', '.turbo', '.gradle', 'build', 'dist', 'target', 'coverage'})
_EXCLUDED_FILES = frozenset({'.npmrc', '.pypirc', '.netrc', '.git-credentials', '.ds_store',
    'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519', 'credentials', 'credentials.json', 'credentials.yaml',
    'credentials.yml', 'secrets', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'kubeconfig'})
_EXCLUDED_SUFFIXES = ('.pem', '.key', '.p12', '.pfx', '.jks', '.keystore', '.tfstate', '.tfstate.backup')
_RECEIPT_KEYS = {'schema_version', 'kind', 'sha256', 'files', 'bytes', 'exclusions',
                 'excluded_entries', 'excluded_directories', 'consistency'}


def _error(code, message):
    return RegistryError(code, message)


def validate_policy(value):
    if value == {'mode': 'committed_only'}:
        return {'mode': 'committed_only'}
    if value == {'mode': 'current_tree', 'exclusions': EXCLUSIONS}:
        return {'mode': 'current_tree', 'exclusions': EXCLUSIONS}
    raise _error('invalid_source_policy', 'Choose committed_only, or explicitly review current_tree with safe_source_v1 exclusions.')


def validate_receipt(value):
    if not isinstance(value, dict) or set(value) != _RECEIPT_KEYS:
        raise _error('invalid_snapshot', 'The current-tree snapshot receipt is incomplete or unsupported.')
    if (type(value['schema_version']) is not int or value['schema_version'] != 1
            or value['kind'] != 'current_tree' or value['exclusions'] != EXCLUSIONS
            or value['consistency'] != CONSISTENCY
            or not isinstance(value['sha256'], str) or not re.fullmatch(r'[0-9a-f]{64}', value['sha256'])):
        raise _error('invalid_snapshot', 'The current-tree snapshot identity is invalid.')
    for key, minimum, maximum in (('files', 1, MAX_ENTRIES), ('bytes', 0, MAX_BYTES),
                                 ('excluded_entries', 0, MAX_ENTRIES), ('excluded_directories', 0, MAX_ENTRIES)):
        if type(value[key]) is not int or not minimum <= value[key] <= maximum:
            raise _error('invalid_snapshot', 'The current-tree snapshot counts exceed their bounds.')
    if value['excluded_directories'] > value['excluded_entries'] or value['files'] + value['excluded_entries'] > MAX_ENTRIES:
        raise _error('invalid_snapshot', 'The current-tree snapshot exclusion counts are inconsistent.')
    return dict(value)


def _platform():
    if not _dirfd_supported() or os.scandir not in os.supports_fd:
        raise _error('unsupported_platform', 'Current-tree Pips need POSIX descriptor-relative no-follow filesystem access on this runner.')


def _flags(directory=False):
    return os.O_RDONLY | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0) | getattr(os, 'O_NONBLOCK', 0) | (os.O_DIRECTORY if directory else 0)


def _version(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def _path(value):
    try:
        return _absolute_frozen(value)
    except (OSError, ValueError, TypeError, WorkspaceBoundaryError):
        raise _error('unsafe_snapshot', 'Snapshot paths must be absolute canonical directories without traversals or untrusted aliases.') from None


def _name(value):
    if not isinstance(value, str) or not value or value in ('.', '..') or any(ord(c) < 32 or ord(c) == 127 for c in value) or '\\' in value or ':' in value or '/' in value:
        raise _error('unsafe_snapshot', 'The source contains an unsupported filename; no snapshot was published.')
    try:
        encoded = value.encode('utf-8')
    except UnicodeError:
        raise _error('unsafe_snapshot', 'Current-tree filenames must be valid UTF-8.') from None
    return encoded


def _root(value, expected=None, *, private=False):
    path = _path(value)
    parent = _open_parent_fd(path, create=False)
    try:
        before = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISDIR(before.st_mode):
            raise _error('unsafe_snapshot', 'The snapshot source or destination must be a real directory, not a link.')
        fd = os.open(path.name, _flags(True), dir_fd=parent)
        try:
            now = os.fstat(fd)
            if _version(now) != _version(before):
                raise _error('source_changed', 'The source directory changed while opening it. Retry after edits finish.')
            if expected is not None and (not isinstance(expected, dict) or set(expected) != {'device', 'inode'}
                    or any(type(expected[k]) is not int or expected[k] < 0 for k in expected)
                    or (now.st_dev, now.st_ino) != (expected['device'], expected['inode'])):
                raise _error('source_changed', 'The workspace directory no longer matches the expected filesystem identity.')
            if private and (now.st_uid != os.geteuid() or stat.S_IMODE(now.st_mode) != 0o500):
                raise _error('unsafe_snapshot', 'Published snapshots must remain owner-only and read-only.')
        except BaseException:
            os.close(fd)
            raise
        return path, parent, fd, now
    except BaseException:
        os.close(parent)
        raise


def _excluded(name, directory):
    low = name.lower()
    return (low.startswith('.env') or low in _EXCLUDED_FILES or low.endswith(_EXCLUDED_SUFFIXES)
            or (directory and low in _EXCLUDED_DIRS) or low in {'.git', '.dgc', '.ssh', '.aws', '.azure', '.gcloud'})


def _scan(root_fd, *, exclude, private=False):
    records, count, total, index_bytes = {}, 0, 0, 0
    skipped, skipped_dirs, seen = 0, 0, set()
    root_device = os.fstat(root_fd).st_dev

    def walk(fd, prefix, depth):
        nonlocal count, total, index_bytes, skipped, skipped_dirs
        info = os.fstat(fd)
        identity = (info.st_dev, info.st_ino)
        if identity in seen or info.st_dev != root_device or depth > MAX_DEPTH:
            raise _error('unsafe_snapshot', 'The source contains a repeated directory, mount boundary or excessive nesting.')
        seen.add(identity)
        if private and (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o500):
            raise _error('unsafe_snapshot', 'A published snapshot directory is no longer owner-only and read-only.')
        records[prefix] = ('directory', _version(info))
        # scandir on a fresh description prevents a previous scan's directory
        # offset from hiding entries during the second inventory.
        listing = os.open('.', _flags(True), dir_fd=fd)
        try:
            with os.scandir(listing) as entries:
                for entry in entries:
                    count += 1
                    if count > MAX_ENTRIES:
                        raise _error('snapshot_limit', 'The current tree exceeds 10,000 inspected entries; choose a narrower workspace or committed source.')
                    name = entry.name
                    _name(name)
                    relative = prefix + '/' + name if prefix else name
                    path_bytes = len(relative.encode('utf-8'))
                    index_bytes += path_bytes
                    if path_bytes > MAX_PATH_BYTES or index_bytes > MAX_INDEX_BYTES:
                        raise _error('snapshot_limit', 'The current tree exceeds its path or inventory byte budget.')
                    before = os.stat(name, dir_fd=fd, follow_symlinks=False)
                    directory = stat.S_ISDIR(before.st_mode)
                    if exclude and _excluded(name, directory):
                        skipped += 1
                        skipped_dirs += int(directory)
                        continue
                    if before.st_dev != root_device:
                        raise _error('unsafe_snapshot', 'Current-tree capture does not cross filesystem mount boundaries.')
                    if directory:
                        child = os.open(name, _flags(True), dir_fd=fd)
                        try:
                            if _version(os.fstat(child)) != _version(before):
                                raise _error('source_changed', 'A source directory changed during inventory. Retry after edits finish.')
                            walk(child, relative, depth + 1)
                        finally:
                            os.close(child)
                    else:
                        if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                            raise _error('unsafe_snapshot', 'Current-tree capture refuses symbolic links, hard-linked files and special files outside excluded paths.')
                        if before.st_size > MAX_FILE_BYTES or before.st_size < 0 or total + before.st_size > MAX_BYTES:
                            raise _error('snapshot_limit', 'The current tree exceeds 4 MiB per file or 64 MiB total before copying; choose committed source or a smaller workspace.')
                        if private and (before.st_uid != os.geteuid() or stat.S_IMODE(before.st_mode) != 0o400):
                            raise _error('unsafe_snapshot', 'A published snapshot file is no longer owner-only and read-only.')
                        total += before.st_size
                        records[relative] = ('file', _version(before))
        finally:
            os.close(listing)
        if _version(os.fstat(fd)) != records[prefix][1]:
            raise _error('source_changed', 'The source directory changed during inventory. Retry after edits finish.')

    walk(root_fd, '', 0)
    if not any(kind == 'file' for kind, _ in records.values()):
        raise _error('empty_snapshot', 'No eligible source files remain after default credential, dependency and build exclusions. Choose a source workspace containing readable files.')
    return records, skipped, skipped_dirs


def _descend(fd, parts):
    current = os.dup(fd)
    try:
        for part in parts:
            child = os.open(part, _flags(True), dir_fd=current)
            os.close(current)
            current = child
        return current
    except BaseException:
        os.close(current)
        raise


def _secrets(values):
    if not isinstance(values, (tuple, list, set, frozenset)) or len(values) > 64:
        raise _error('snapshot_limit', 'Configured secret inspection exceeds the bounded snapshot budget.')
    encoded, total = [], 0
    for value in values:
        if not isinstance(value, str) or not value or len(value) > 8192:
            raise _error('snapshot_limit', 'A configured secret cannot be inspected within the snapshot budget.')
        try:
            raw = value.encode('utf-8')
        except UnicodeError:
            raise _error('unsafe_snapshot', 'A configured secret has unsupported text encoding.') from None
        total += len(raw)
        if len(raw) > 8192 or total > 32768:
            raise _error('snapshot_limit', 'Configured secret inspection exceeds the bounded snapshot budget.')
        encoded.append(raw)
    return tuple(encoded)


def _read(root_fd, relative, expected, digest, target_fd=None, secrets=()):
    parts = relative.split('/')
    parent = _descend(root_fd, parts[:-1])
    try:
        before = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if _version(before) != expected or not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
            raise _error('source_changed', 'A source file changed identity before copying. Retry after edits finish.')
        fd = os.open(parts[-1], _flags(), dir_fd=parent)
        try:
            if _version(os.fstat(fd)) != expected:
                raise _error('source_changed', 'A source file changed while opening it. No snapshot was published.')
            remaining = expected[4]
            path_bytes = relative.encode('utf-8')
            digest.update(b'F' + len(path_bytes).to_bytes(8, 'big') + path_bytes + remaining.to_bytes(8, 'big'))
            tail, retained = b'', max((len(s) for s in secrets), default=1) - 1
            while remaining:
                part = os.read(fd, min(CHUNK_BYTES, remaining))
                if not part:
                    raise _error('source_changed', 'A source file was truncated during capture. Retry after edits finish.')
                if secrets:
                    window = tail + part
                    if any(secret in window for secret in secrets):
                        raise _error('secret_in_source', 'An eligible source file contains a configured secret. Remove it or select committed source; no snapshot was published.')
                    tail = window[-retained:] if retained else b''
                digest.update(part)
                if target_fd is not None:
                    offset = 0
                    while offset < len(part):
                        written = os.write(target_fd, part[offset:])
                        if not written:
                            raise OSError('Snapshot write made no progress')
                        offset += written
                remaining -= len(part)
            if os.read(fd, 1) or _version(os.fstat(fd)) != expected:
                raise _error('source_changed', 'A source file changed during capture. Retry after edits finish.')
        finally:
            os.close(fd)
    finally:
        os.close(parent)


def _unchanged(root_path, parent_fd, root_fd, before, records, *, exclude, private=False):
    if (_version(os.fstat(root_fd)) != _version(before)
            or _version(os.stat(root_path.name, dir_fd=parent_fd, follow_symlinks=False)) != _version(before)):
        raise _error('source_changed', 'The workspace root changed during capture. No snapshot was published.')
    # Re-open the absolute descriptor chain too: an ancestor may have been
    # renamed/replaced while the original parent descriptor remained valid.
    check_parent = check_fd = None
    try:
        _, check_parent, check_fd, fresh = _root(root_path, private=private)
        if _version(fresh) != _version(before):
            raise _error('source_changed', 'The workspace path changed during capture. No snapshot was published.')
    finally:
        for descriptor in (check_fd, check_parent):
            if descriptor is not None:
                os.close(descriptor)
    after, _, _ = _scan(root_fd, exclude=exclude, private=private)
    if after != records:
        raise _error('source_changed', 'The source tree changed during capture. Retry after edits finish.')


def _remove_private(fd, budget=None, depth=0):
    """Cleanup only the exclusively created descriptor tree, never follow links."""
    if budget is None:
        budget = [MAX_ENTRIES]
    if depth > MAX_DEPTH or budget[0] <= 0:
        return
    os.fchmod(fd, 0o700)
    listing = os.open('.', _flags(True), dir_fd=fd)
    try:
        with os.scandir(listing) as entries:
            for entry in entries:
                budget[0] -= 1
                if budget[0] < 0:
                    return
                info = os.stat(entry.name, dir_fd=fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(entry.name, _flags(True), dir_fd=fd)
                    try:
                        _remove_private(child, budget, depth + 1)
                    finally:
                        os.close(child)
                    os.rmdir(entry.name, dir_fd=fd)
                else:
                    os.unlink(entry.name, dir_fd=fd)
    finally:
        os.close(listing)


def _digest(records):
    digest = hashlib.sha256(b'dgc-current-tree-v1\0')
    for relative, (kind, _) in sorted(records.items()):
        if kind == 'directory':
            path_bytes = relative.encode('utf-8')
            digest.update(b'D' + len(path_bytes).to_bytes(8, 'big') + path_bytes)
    return digest


def capture(root, destination, *, secrets=(), expected_root=None):
    """Capture selected current bytes into a NEW private directory; never restore.

    Expected root, when supplied, is {device:int,inode:int} captured by the owning
    controller. The receipt contains no source paths or excluded filenames.
    """
    _platform()
    secret_bytes = _secrets(secrets)
    destination = _path(destination)
    root_path = _path(root)
    if destination == root_path or root_path in destination.parents:
        raise _error('unsafe_snapshot', 'The private snapshot must be outside the source workspace.')
    source_parent = source_fd = target_parent = target_fd = None
    created = False
    target_identity = None
    try:
        root_path, source_parent, source_fd, before = _root(root_path, expected_root)
        records, skipped, skipped_dirs = _scan(source_fd, exclude=True)
        # Complete type/size inventory precedes allocation of any destination.
        target_parent = _open_parent_fd(destination, create=False)
        parent_info = os.fstat(target_parent)
        if parent_info.st_uid != os.geteuid() or stat.S_IMODE(parent_info.st_mode) & 0o077:
            raise _error('unsafe_snapshot', 'Snapshot parent must be an existing owner-only private directory.')
        os.mkdir(destination.name, mode=0o700, dir_fd=target_parent)
        created = True
        target_fd = os.open(destination.name, _flags(True), dir_fd=target_parent)
        target_identity = (os.fstat(target_fd).st_dev, os.fstat(target_fd).st_ino)
        directories = sorted((path for path, (kind, _) in records.items() if path and kind == 'directory'), key=lambda p: (p.count('/'), p))
        for relative in directories:
            parts = relative.split('/')
            parent = _descend(target_fd, parts[:-1])
            try:
                os.mkdir(parts[-1], mode=0o700, dir_fd=parent)
            finally:
                os.close(parent)
        digest, total, files = _digest(records), 0, 0
        for relative, (kind, version) in sorted(records.items()):
            if kind != 'file':
                continue
            parts = relative.split('/')
            parent = _descend(target_fd, parts[:-1])
            try:
                out = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | getattr(os, 'O_CLOEXEC', 0), 0o600, dir_fd=parent)
                try:
                    _read(source_fd, relative, version, digest, out, secret_bytes)
                    os.fsync(out)
                    os.fchmod(out, 0o400)
                finally:
                    os.close(out)
            finally:
                os.close(parent)
            total += version[4]
            files += 1
        _unchanged(root_path, source_parent, source_fd, before, records, exclude=True)
        for relative in reversed(directories):
            directory = _descend(target_fd, relative.split('/'))
            try:
                os.fchmod(directory, 0o500)
            finally:
                os.close(directory)
        os.fchmod(target_fd, 0o500)
        os.fsync(target_fd)
        receipt = validate_receipt({'schema_version':1, 'kind':'current_tree', 'sha256':digest.hexdigest(),
            'files':files, 'bytes':total, 'exclusions':EXCLUSIONS, 'excluded_entries':skipped,
            'excluded_directories':skipped_dirs, 'consistency':CONSISTENCY})
        verify(destination, receipt)
        return receipt
    except (RegistryError, OSError, WorkspaceBoundaryError) as error:
        if created and target_fd is not None:
            try:
                current = os.stat(destination.name, dir_fd=target_parent, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == target_identity:
                    _remove_private(target_fd)
                    os.rmdir(destination.name, dir_fd=target_parent)
            except OSError:
                pass  # A partial private copy has no valid receipt and cannot be used.
        if isinstance(error, RegistryError):
            raise
        raise _error('snapshot_unavailable', 'The source changed, is unsafe or could not be copied into private storage. No usable snapshot was published.') from error
    finally:
        for fd in (target_fd, target_parent, source_fd, source_parent):
            if fd is not None:
                os.close(fd)


def verify(destination, receipt):
    """Recompute all content/paths from the private copy before handing it to a worker."""
    _platform()
    expected = validate_receipt(receipt)
    parent = fd = None
    try:
        path, parent, fd, before = _root(destination, private=True)
        records, _, _ = _scan(fd, exclude=False, private=True)
        digest, files, total = _digest(records), 0, 0
        for relative, (kind, version) in sorted(records.items()):
            if kind == 'file':
                _read(fd, relative, version, digest)
                files += 1
                total += version[4]
        _unchanged(path, parent, fd, before, records, exclude=False, private=True)
        if (digest.hexdigest(), files, total) != (expected['sha256'], expected['files'], expected['bytes']):
            raise _error('snapshot_changed', 'The private current-tree snapshot no longer matches its pinned contents. Queue a new run after review.')
    except (OSError, WorkspaceBoundaryError) as error:
        raise _error('snapshot_unavailable', 'The private current-tree snapshot could not be verified safely.') from error
    finally:
        for descriptor in (fd, parent):
            if descriptor is not None:
                os.close(descriptor)
