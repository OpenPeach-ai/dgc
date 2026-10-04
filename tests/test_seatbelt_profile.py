"""The shared Seatbelt profile builder, and the shell sandbox's exact sandbox-exec profile."""
from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from dgc import sandbox, seatbelt


class Cfg(dict):
    def get(self, key, default=None):
        return super().get(key, default)


class ProfileBuilderTests(unittest.TestCase):
    def test_order_is_deny_writes_hide_then_reexpose_then_network(self):
        profile = seatbelt.profile(writable=['/w'], hidden=['/h'], readable=['/h/r'], reachable=['/h/r'],
                                   rules=['(deny signal)'])
        self.assertEqual(profile, (
            '(version 1)(allow default)(deny file-write*)'
            '(allow file-write* (subpath "/w") ' + seatbelt.DEVICE_WRITES + ')'
            '(deny file-read* (subpath "/h"))(allow file-read* (subpath "/h/r"))'
            '(allow file-read-metadata file-test-existence (path-ancestors "/h/r"))'
            '(deny signal)(deny network*)'))
        self.assertFalse(seatbelt.profile(network=True).endswith('(deny network*)'))

    def test_quotes_and_backslashes_cannot_close_a_string(self):
        self.assertEqual(seatbelt.quote('a"b\\c'), 'a\\"b\\\\c')
        self.assertIn('(subpath "/x\\"y")', seatbelt.profile(hidden=['/x"y']))


class ShellSandboxProfileTests(unittest.TestCase):
    """sandbox.wrap() emits exactly the profile it did before the builder was shared."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dgc-seatbelt-shell-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).resolve()
        self.home = self.base / 'home'; self.home.mkdir()
        self.account = self.base / 'account'

    def wrap(self, root, config, env=None):
        with mock.patch.object(sandbox, '_backend', return_value=('sandbox-exec', Path('/usr/bin/sandbox-exec'))), \
             mock.patch.object(sandbox, '_session', return_value=None), \
             mock.patch.object(sandbox, '_account_home', return_value=self.account), \
             mock.patch.object(Path, 'home', return_value=self.home), mock.patch.dict(os.environ, env or {}):
            return sandbox.wrap('echo hi', root, config)

    def test_read_only_networked_project_outside_home(self):
        root = self.base / 'outside'; root.mkdir()
        argv = self.wrap(root, Cfg(sandbox_read_only=True, sandbox_network=True))
        self.assertEqual(argv, ['/usr/bin/sandbox-exec', '-p',
            '(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "/tmp") (subpath "/private/tmp") '
            '(literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (literal "/dev/dtracehelper") '
            f'(subpath "/dev/fd"))(deny file-read* (subpath "{self.home}"))(deny file-read* (subpath "{self.account}"))'
            f'(allow file-read* (subpath "{root}"))(allow file-read-metadata file-test-existence (path-ancestors "{root}"))',
            '/bin/bash', '-o', 'pipefail', '-c', 'echo hi'])

    def test_sdk_worktree_with_shared_git_inside_home(self):
        repo = self.home / 'repo'; (repo / '.git' / 'worktrees' / 'wt').mkdir(parents=True)
        (repo / '.git' / 'worktrees' / 'wt' / 'commondir').write_text('../..\n')
        root = self.base / 'wt'; root.mkdir(); (root / '.git').write_text(f'gitdir: {repo}/.git/worktrees/wt\n')
        argv = self.wrap(root, Cfg(), {'DGC_SDK_ISOLATED': '1', 'DGC_HOME': str(self.base / 'state' / 'home')})
        self.assertEqual(argv[2],
            f'(version 1)(allow default)(deny file-write*)(allow file-write* (subpath "{root}") (subpath "/tmp") '
            '(subpath "/private/tmp") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") '
            f'(literal "/dev/dtracehelper") (subpath "/dev/fd"))(deny file-read* (subpath "{self.home}"))'
            f'(deny file-read* (subpath "{self.account}"))(deny file-read* (subpath "{self.base / "state"}"))'
            f'(allow file-read* (subpath "{root}"))(allow file-read* (subpath "{repo / ".git"}"))'
            f'(allow file-read-metadata file-test-existence (path-ancestors "{root}"))'
            f'(allow file-read-metadata file-test-existence (path-ancestors "{repo / ".git"}"))(deny network*)')


if __name__ == '__main__':
    unittest.main()
