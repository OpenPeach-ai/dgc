"""Private provisional current-tree copies, retained only by a successful queue CAS."""
from __future__ import annotations

import contextlib
import os
import re
import stat
from pathlib import Path

from . import pip_tree_snapshot as trees
from .workspace_registry import RegistryError


def root_identity(root):
    parent = fd = None
    try:
        _, parent, fd, info = trees._root(root)
        return {'device': info.st_dev, 'inode': info.st_ino}
    except (OSError, trees.WorkspaceBoundaryError) as exc:
        raise RegistryError('source_changed', 'The workspace directory is unavailable or changed. Review its binding before queuing a new run.') from exc
    finally:
        for descriptor in (fd, parent):
            if descriptor is not None:
                os.close(descriptor)


def check_root(root, expected):
    if (not isinstance(expected, dict) or set(expected) != {'device', 'inode'}
            or any(type(expected[key]) is not int or expected[key] < 0 for key in expected)
            or root_identity(root) != expected):
        raise RegistryError('source_changed', 'The workspace directory changed since this source was captured. Queue a new run after reviewing its binding.')


class PreparedSource:
    def __init__(self, run_id, path, receipt, identity, left_out=None):
        self.run_id, self.path, self.receipt, self.root_identity = run_id, path, receipt, identity
        self.left_out = left_out    # safe_source_v2: what the copy skipped or excluded
        self.retained = False

    def retain(self):
        # Called only after the owning queue transaction has actually committed.
        self.retained = True


@contextlib.contextmanager
def prepare(directory, root, run_id, *, secrets=(), policy=None):
    """Capture outside SQL; discard only our exclusive directory on failure/retry.

    No filesystem I/O deadline is claimed. A malicious same-user replacement may
    leave a private orphan; cleanup never follows it into a different directory.
    """
    if not isinstance(run_id, str) or not re.fullmatch(r'run_[0-9a-f]{32}', run_id):
        raise RegistryError('invalid_run', 'The private source requires a controller-created run identity.')
    directory = Path(directory)
    parent = state = runs = owned = None
    created, identity, source_identity, result = False, None, None, None
    try:
        _, parent, state, info = trees._root(directory)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise RegistryError('unsafe_snapshot', 'Source storage must be a private owner-only directory.')
        try:
            os.mkdir('runs', mode=0o700, dir_fd=state)
        except FileExistsError:
            pass
        runs = os.open('runs', trees._flags(True), dir_fd=state)
        info = os.fstat(runs)
        if info.st_uid != os.geteuid():
            raise RegistryError('unsafe_snapshot', 'Run storage must be a private owner-only directory.')
        # Older committed-source runs created this intermediate directory with
        # ambient modes under the private registry. Narrow, never broaden them.
        os.fchmod(runs, 0o700)
        os.mkdir(run_id, mode=0o700, dir_fd=runs)
        created = True
        owned = os.open(run_id, trees._flags(True), dir_fd=runs)
        info = os.fstat(owned)
        identity = (info.st_dev, info.st_ino)
        expected = root_identity(root)
        path = directory / 'runs' / run_id / 'source'
        report = {}
        receipt = trees.capture(root, path, secrets=secrets, expected_root=expected, policy=policy, report=report)
        source_info = os.stat('source', dir_fd=owned, follow_symlinks=False)
        source_identity = (source_info.st_dev, source_info.st_ino)
        result = PreparedSource(run_id, path, receipt, expected, report.get('left_out'))
        yield result
    except (OSError, trees.WorkspaceBoundaryError) as exc:
        raise RegistryError('snapshot_unavailable', 'The private run source could not be prepared safely. No new source was queued.') from exc
    finally:
        if created and owned is not None and (result is None or not result.retained):
            try:
                current = os.stat(run_id, dir_fd=runs, follow_symlinks=False)
                if (current.st_dev, current.st_ino) == identity:
                    # The run parent adds one entry/level beyond the capture's
                    # 10,000-entry source inventory. Remove its source separately.
                    try:
                        source_info = os.stat('source', dir_fd=owned, follow_symlinks=False)
                        if source_identity is None or (source_info.st_dev, source_info.st_ino) != source_identity:
                            raise OSError('Private source identity changed')
                        child = os.open('source', trees._flags(True), dir_fd=owned)
                        if (os.fstat(child).st_dev, os.fstat(child).st_ino) != source_identity:
                            os.close(child)
                            raise OSError('Private source changed while opening cleanup')
                    except FileNotFoundError:
                        child = None
                    if child is not None:
                        try:
                            trees._remove_private(child)
                        finally:
                            os.close(child)
                        os.rmdir('source', dir_fd=owned)
                    os.rmdir(run_id, dir_fd=runs)
            except OSError:
                pass
        for descriptor in (owned, runs, state, parent):
            if descriptor is not None:
                os.close(descriptor)
