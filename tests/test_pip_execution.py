"""Reviewed action, private artifacts and real Linux confinement; no network/sleeps."""
from __future__ import annotations

import copy
import errno
import hashlib
import json
import io
import itertools
import os
import signal
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from dgc import pip_execution as execution
from dgc.workspace_registry import RegistryError


def patch_action(tests=None):
    return execution.validate_action('patch', {'kind': 'patch', 'write_paths': ['source.py'], 'tests': tests or []})


def test_action(argv=None):
    return execution.validate_action('pulse', {'kind': 'test', 'tests': [{'argv': argv if argv is not None else ['python3', '-c', 'print(42)'], 'cwd': '.'}]})


class ActionTests(unittest.TestCase):
    def test_actions_canonical_detached_and_digest_exact(self):
        raw = {'kind': 'patch', 'write_paths': ['z.py', 'a.py'], 'tests': []}
        value = execution.validate_action('patch', raw)
        self.assertEqual(value['write_paths'], ['a.py', 'z.py'])
        self.assertFalse(value['network'])
        self.assertEqual(value['limits'], execution.LIMITS)
        self.assertNotIn('limits', raw)
        raw['write_paths'].append('extra.py')
        self.assertNotIn('extra.py', value['write_paths'])
        self.assertEqual(execution.action_digest(value), execution.action_digest(copy.deepcopy(value)))
        other = {**value, 'write_paths': ['different.py']}
        self.assertNotEqual(execution.action_digest(value), execution.action_digest(other))
        for role in ('rook', 'scout', 'lens', 'lock'):
            self.assertEqual(execution.validate_action(role, {'kind': 'read_only'}), {'kind': 'read_only'})

    def test_unknown_types_and_expanded_grants_fail_closed(self):
        cases = [('core', {'kind': 'read_only'}), ('quill', {'kind': 'patch'}), ('rook', patch_action()),
                 ('patch', test_action()), ('pulse', patch_action()), ('patch', None), ('patch', []),
                 ('patch', {**patch_action(), 'network': True}), ('patch', {**patch_action(), 'network': 0}),
                 ('patch', {**patch_action(), 'environment': {'TOKEN': 'secret'}}),
                 ('patch', {**patch_action(), 'limits': {**execution.LIMITS, 'wall_seconds': 61}}),
                 ('patch', {**patch_action(), 'limits': {**execution.LIMITS, 'processes': True}}),
                 ([], {'kind': []})]
        for role, value in cases:
            with self.subTest(role=role, value=value), self.assertRaises(RegistryError):
                execution.validate_action(role, value)
        with self.assertRaises(RegistryError):
            execution.action_digest({'kind': []})

    def test_path_traversal_metadata_wildcards_and_oversize_are_rejected(self):
        for name in ('', '.', '..', '../x', '/tmp/x', 'a/../x', 'a//x', './x', '.git/config', 'a/.GIT/x',
                     'src/*.py', 'file?.py', 'x[1]', 'C:/x', 'a\\b', 'x\x00', '\ud800', 'x' * 1025):
            with self.subTest(path=repr(name)), self.assertRaises(RegistryError):
                execution.validate_action('patch', {'kind': 'patch', 'write_paths': [name], 'tests': []})
        for paths in ([], ['source.py'] * 2, [f'f{i}' for i in range(33)]):
            with self.subTest(paths=paths), self.assertRaises(RegistryError):
                execution.validate_action('patch', {'kind': 'patch', 'write_paths': paths, 'tests': []})

    def test_argv_is_exact_data_not_a_shell_safety_allowlist(self):
        argv = ['sh', '-c', 'printf "%s" "$(id)"']
        self.assertEqual(test_action(argv)['tests'][0]['argv'], argv)
        # This accepts syntax only: mandatory OS confinement makes execution safe.
        for argv in ([], ['x'] * 33, ['x' * 1025], ['x', '\ud800'], ['x', 'a\nb'], [True], ['x'] + ['y' * 1024] * 9):
            with self.subTest(argv=repr(argv)), self.assertRaises(RegistryError):
                test_action(argv)
        for tests in ([], [{'argv': ['true'], 'cwd': '..'}], [{'argv': ['true'], 'cwd': '.', 'env': {}}],
                      [{'argv': ['true'], 'cwd': '.'}] * 5):
            with self.subTest(tests=tests), self.assertRaises(RegistryError):
                execution.validate_action('pulse', {'kind': 'test', 'tests': tests})

    def test_missing_runtime_never_falls_back_to_unconfined_commands(self):
        with patch.object(execution.sys, 'platform', 'sunos5'), patch.object(execution.subprocess, 'Popen') as spawn:
            capability = execution.capability()
            self.assertFalse(capability['available'])
            self.assertIsNone(capability['backend'])
            self.assertIn('Linux', capability['reason']); self.assertIn('macOS', capability['reason'])
            with self.assertRaises(RegistryError):
                execution.require_capability()
            spawn.assert_not_called()

    def test_darwin_without_developer_tools_is_unavailable_and_never_runs_a_shim(self):
        # The /usr/bin python3 and git shims open an install dialog when no developer
        # folder exists. Only xcode-select, which merely reports the selection, may run.
        refused = {'status': 'failed', 'exit_code': 2, 'data': b'xcode-select: error: unable to get active developer directory', 'truncated': False}
        with patch.object(execution.sys, 'platform', 'darwin'), patch.object(execution, '_helpers'), \
             patch.object(execution, '_capture', return_value=refused) as capture, \
             patch.object(execution.subprocess, 'Popen', side_effect=AssertionError('no process may start')):
            execution._PROBE_CACHE.clear()
            capability = execution.capability()
        self.assertFalse(capability['available'])
        self.assertIsNone(capability['backend'])
        self.assertIn('macOS', capability['reason'])
        self.assertEqual([call.args[0] for call in capture.call_args_list], [['/usr/bin/xcode-select', '-p']])
        self.assertEqual(capture.call_args.kwargs['env'], {'PATH': '/usr/bin:/bin'})
        for output in (b'', b'relative/path\n', b'/a\n/b\n', b'\xff'):
            with self.subTest(output=output), patch.object(execution, '_capture', return_value={**refused, 'status': 'passed', 'data': output}), \
                 self.assertRaises(RegistryError):
                execution._developer_directory()


class IsolatedRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dgc-execution-test-')
        self.addCleanup(self.temp.cleanup)
        self.run = Path(self.temp.name)
        self.source = self.run / 'source'
        self.source.mkdir()
        (self.source / 'source.py').write_text('value = 1\n', encoding='utf-8')
        self.gate = patch.object(execution, 'require_capability', return_value={'available': True})
        self.gate.start()
        self.addCleanup(self.gate.stop)

    def prepare(self):
        return execution.prepare_isolated_repo(self.source, self.run)

    def test_private_git_baseline_and_diff_never_change_original_tree(self):
        prepared = self.prepare()
        root = Path(prepared['worktree'])
        self.assertFalse((root / '.git').exists())
        self.assertEqual(Path(prepared['git_dir']).parent, self.run)
        action = patch_action()
        execution.authorize_write(root, 'source.py', action).write_text('value = 2\n')
        changes = execution.collect_artifacts(prepared, action)
        self.assertEqual(changes['changed_files'], ['source.py'])
        self.assertIn('-value = 1', changes['diff'])
        self.assertIn('+value = 2', changes['diff'])
        self.assertEqual((self.source / 'source.py').read_text(), 'value = 1\n')
        artifact = self.run / changes['artifact']['path']
        self.assertEqual(hashlib.sha256(artifact.read_bytes()).hexdigest(), changes['artifact']['sha256'])
        self.assertEqual(artifact.stat().st_mode & 0o777, 0o400)
        self.assertFalse((self.source / '.git').exists())

    def test_source_is_checked_before_copy_and_git_work(self):
        for setup in ('symlink', 'hardlink', 'fifo', 'git', 'oversize'):
            with self.subTest(setup=setup):
                bad = self.source / ('bad' if setup != 'git' else '.git')
                if setup == 'symlink': bad.symlink_to(self.source / 'source.py')
                elif setup == 'hardlink': os.link(self.source / 'source.py', bad)
                elif setup == 'fifo': os.mkfifo(bad)
                elif setup == 'git': bad.mkdir()
                else:
                    with bad.open('wb') as stream: stream.truncate(execution.MAX_FILE_BYTES + 1)
                with patch.object(execution, '_git', side_effect=AssertionError('unsafe source reached Git')), self.assertRaises(RegistryError):
                    self.prepare()
                if bad.is_dir(): bad.rmdir()
                else: bad.unlink()
                self.assertFalse((self.run / 'worktree').exists())

    def test_existing_metadata_and_wrong_snapshot_parent_never_reused_or_deleted(self):
        metadata = self.run / 'private-git'
        metadata.mkdir()
        (metadata / 'sentinel').write_text('keep')
        with self.assertRaises(RegistryError): self.prepare()
        self.assertEqual((metadata / 'sentinel').read_text(), 'keep')
        other = self.run / 'other'
        other.mkdir()
        with self.assertRaises(RegistryError): execution.prepare_isolated_repo(other, self.run)
        self.assertTrue(self.source.is_dir())

    def test_directory_walk_is_bounded_even_for_empty_directories(self):
        for i in range(5): (self.source / f'd{i}').mkdir()
        with patch.object(execution, 'MAX_FILES', 3), self.assertRaises(RegistryError): self.prepare()
        self.assertFalse((self.run / 'worktree').exists())

    def test_write_scope_rejects_external_relative_links_and_unreviewed_paths(self):
        prepared = self.prepare(); root = Path(prepared['worktree']); action = patch_action()
        self.assertEqual(execution.authorize_write(root, str(root / 'source.py'), action), root / 'source.py')
        for path in ('../source/source.py', str(self.source / 'source.py'), 'other.py', '.git/config'):
            with self.subTest(path=path), self.assertRaises(RegistryError): execution.authorize_write(root, path, action)
        (root / 'source.py').unlink(); (root / 'source.py').symlink_to(self.source / 'source.py')
        with self.assertRaises(RegistryError): execution.authorize_write(root, 'source.py', action)
        with self.assertRaises(RegistryError): execution.collect_artifacts(prepared, action)

    def test_undocumented_changes_and_pulse_changes_refused_before_diff_artifact(self):
        prepared = self.prepare(); root = Path(prepared['worktree'])
        (root / 'other.py').write_text('unauthorized')
        for action in (patch_action(), test_action()):
            with self.assertRaises(RegistryError): execution.collect_artifacts(prepared, action)
        self.assertFalse((self.run / 'artifacts/changes.patch').exists())

    def test_post_edit_file_and_diff_budgets_fail_closed(self):
        prepared = self.prepare(); root = Path(prepared['worktree'])
        with (root / 'source.py').open('wb') as stream: stream.truncate(execution.MAX_FILE_BYTES + 1)
        with self.assertRaises(RegistryError): execution.collect_artifacts(prepared, patch_action())
        (root / 'source.py').write_text('large change\n' * 100)
        with patch.object(execution, 'MAX_DIFF_BYTES', 32), self.assertRaises(RegistryError):
            execution.collect_artifacts(prepared, patch_action())
        self.assertFalse((self.run / 'artifacts/changes.patch').exists())

    def test_artifact_directory_symlink_never_redirects_output(self):
        prepared = self.prepare()
        (self.run / 'artifacts').symlink_to(self.source, target_is_directory=True)
        with self.assertRaises(RegistryError): execution.collect_artifacts(prepared, patch_action())
        self.assertFalse((self.source / 'changes.patch').exists())


class ProcessCaptureTests(unittest.TestCase):
    def test_process_exit_during_proc_read_is_transient_but_permission_error_is_not(self):
        class Vanished(io.BytesIO):
            def read(self, *_):
                raise ProcessLookupError(errno.ESRCH, 'Process exited after open')
        with patch('builtins.open', side_effect=lambda *_: Vanished()), \
             patch.object(execution.os, 'sysconf', return_value=4096):
            self.assertEqual(execution._descendant_usage(123), (1, 0))
        with patch('builtins.open', side_effect=PermissionError(errno.EACCES, 'Denied')), \
             patch.object(execution.os, 'sysconf', return_value=4096), self.assertRaises(PermissionError):
            execution._descendant_usage(123)

    def test_precancel_never_spawns(self):
        stop = threading.Event(); stop.set()
        with patch.object(execution.subprocess, 'Popen', side_effect=AssertionError('must not spawn')):
            result = execution._capture(['/not/run'], maximum=64, timeout=10, env={}, cancelled=stop)
        self.assertEqual(result['status'], 'cancelled'); self.assertIsNone(result['exit_code'])

    def test_controlled_deadline_kills_owned_process_without_sleep(self):
        with patch.object(execution.time, 'monotonic', side_effect=[0, 2]):
            result = execution._capture([execution.sys.executable, '-I', '-c', 'import os;os.read(0,1)'], maximum=64, timeout=1, env={})
        self.assertEqual(result['status'], 'timed_out')

    def test_sampled_memory_overflow_kills_before_unbounded_capture(self):
        monitor = Mock(interval=0.1); monitor.exceeded.return_value = True
        with patch.object(execution, '_process_monitor', return_value=monitor):
            result = execution._capture([execution.sys.executable, '-I', '-c', 'print(1)'], maximum=64, timeout=10, env={}, monitor=True)
        self.assertEqual(result['status'], 'resource_limit')
        monitor.attach.assert_called_once(); monitor.stop.assert_called_once()

    def test_linux_monitor_keeps_namespace_overhead_and_sampled_ceilings(self):
        monitor = execution._LinuxProcesses(); monitor.attach(123)
        for usage, exceeded in (((34, 0), False), ((35, 0), True), ((1, execution.LIMITS['memory_bytes']), False),
                                ((1, execution.LIMITS['memory_bytes'] + 1), True)):
            with self.subTest(usage=usage), patch.object(execution, '_descendant_usage', return_value=usage) as usage_of:
                self.assertEqual(monitor.exceeded(), exceeded)
                usage_of.assert_called_once_with(123)

    def test_process_monitor_finds_child_forked_by_nonleader_thread(self):
        class Entries:
            def __init__(self, names): self.items = [Mock(name='task') for _ in names]; self.names = names
            def __enter__(self):
                for item, name in zip(self.items, self.names): item.name = name
                return iter(self.items)
            def __exit__(self, *_): pass
        files = {
            '/proc/100/statm': b'100 2 0', '/proc/100/task/100/children': b'',
            '/proc/100/task/101/children': b'200', '/proc/200/statm': b'100 7 0',
            '/proc/200/task/200/children': b'',
        }
        def scan(path): return Entries(['100', '101'] if path == '/proc/100/task' else ['200'])
        with patch.object(execution.os, 'scandir', side_effect=scan), \
             patch('builtins.open', side_effect=lambda path, *_: io.BytesIO(files[path])), \
             patch.object(execution.os, 'sysconf', return_value=4096):
            count, rss = execution._descendant_usage(100)
        self.assertEqual(count, 2)
        self.assertEqual(rss, 9 * 4096)

    def test_stdout_close_does_not_skip_owned_deadline(self):
        code = 'import os;os.close(1);os.close(2);r,w=os.pipe();os.read(r,1)'
        # The fake clock advances deterministically; no elapsed-time assertion. It stays past the
        # deadline once there: a loaded machine makes _capture look at the clock more often, and a
        # fixed list of four readings ran out (StopIteration) under the full suite.
        with patch.object(execution.time, 'monotonic', side_effect=itertools.chain([0, 0, 0], itertools.repeat(2))):
            result = execution._capture([execution.sys.executable, '-I', '-c', code], maximum=64, timeout=1, env={})
        self.assertEqual(result['status'], 'timed_out')

    def test_capture_ceiling_and_utf8_replacement_are_bounded(self):
        result = execution._capture([execution.sys.executable, '-I', '-c', 'import os;os.write(1,b"x"*10000)'], maximum=64, timeout=10, env={})
        self.assertEqual(result['status'], 'output_limit')
        self.assertEqual(len(result['data']), 64); self.assertTrue(result['truncated'])
        preview, clipped = execution._preview(b'\xff' * 4096, 4096)
        self.assertLessEqual(len(preview.encode('utf-8')), 4096); self.assertTrue(clipped)


@unittest.skipUnless(os.name == 'posix' and execution.sys.platform.startswith('linux'), 'Linux confinement integration')
class RealConfinementTests(unittest.TestCase):
    def setUp(self):
        if not execution.capability()['available']:
            self.skipTest('Mandatory bubblewrap confinement unavailable; execution correctly gated')
        self.temp = tempfile.TemporaryDirectory(prefix='dgc-real-execution-')
        self.addCleanup(self.temp.cleanup)
        self.run = Path(self.temp.name); self.source = self.run / 'source'; self.source.mkdir()
        (self.source / 'source.py').write_text('value = 1\n')
        self.prepared = execution.prepare_isolated_repo(self.source, self.run)

    def execute(self, code):
        if '\n' in code: code = 'exec(' + repr(code) + ')'
        return execution.run_reviewed_tests(self.prepared, test_action(['python3', '-I', '-c', code]))[0]

    def test_real_namespace_hides_home_strips_keys_and_mounts_only_readonly_source(self):
        host_net = os.readlink('/proc/self/ns/net')
        code = ("import os,resource; assert os.readlink('/proc/self/ns/net')!=" + repr(host_net) + "; "
                "assert not os.path.exists('/home'); assert not os.path.exists('/root'); "
                "assert not os.path.exists('/workspace/.git'); assert 'DGC_API_KEY' not in os.environ; "
                "assert 'PYTHONPATH' not in os.environ; assert os.statvfs('/workspace').f_flag&os.ST_RDONLY; "
                "assert os.statvfs('/').f_flag&os.ST_RDONLY; assert os.statvfs('/dev/shm').f_flag&os.ST_RDONLY; "
                "assert resource.getrlimit(resource.RLIMIT_AS)==(536870912,536870912); "
                "assert resource.getrlimit(resource.RLIMIT_NPROC)==(32,32); "
                "open('/tmp/result','w').write('scratch'); print('confined')")
        with patch.dict(os.environ, {'DGC_API_KEY': 'SECRET_TEST_KEY', 'PYTHONPATH': '/private/injection'}):
            result = self.execute(code)
        self.assertEqual(result['status'], 'passed', result['output'])
        self.assertEqual(result['output'], 'confined\n')
        self.assertNotIn('SECRET_TEST_KEY', result['output'])
        self.assertEqual((self.source / 'source.py').read_text(), 'value = 1\n')
        self.assertFalse((self.run / 'result').exists())

    def test_real_test_cannot_write_isolated_source_or_source_original(self):
        code = "open('/workspace/source.py','w').write('changed')"
        result = self.execute(code)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('Read-only file system', result['output'])
        self.assertEqual((Path(self.prepared['worktree']) / 'source.py').read_text(), 'value = 1\n')
        self.assertEqual((self.source / 'source.py').read_text(), 'value = 1\n')

    def test_real_reviewed_output_and_private_artifact_limit(self):
        result = self.execute('import os;os.write(1,b"z"*70000)')
        self.assertEqual(result['status'], 'output_limit')
        self.assertEqual(result['artifact']['bytes'], 65536)
        self.assertLessEqual(len(result['output'].encode()), 4096)
        self.assertTrue(result['output_truncated'])
        path = self.run / result['artifact']['path']
        self.assertEqual(path.stat().st_size, 65536)

    def test_real_namespace_enforces_process_cap_and_reaps_children(self):
        code = """import os,json
r,w=os.pipe();children=[];refused=False
try:
 for i in range(40):
  try: pid=os.fork()
  except OSError: refused=True;break
  if pid==0:
   os.close(w);os.read(r,1);os._exit(0)
  children.append(pid)
finally:
 os.close(r);os.write(w,b'x'*len(children));os.close(w)
 for pid in children: os.waitpid(pid,0)
assert refused and 0<len(children)<=30
print(json.dumps({'limited':refused,'children':len(children)}))
"""
        result = self.execute(code)
        self.assertEqual(result['status'], 'passed', result['output'])
        evidence = json.loads(result['output'])
        self.assertTrue(evidence['limited'])
        self.assertLessEqual(evidence['children'], 30)

    def test_real_namespace_removes_orphan_when_reviewed_parent_exits(self):
        code = """import os
r,w=os.pipe()
pid=os.fork()
if pid==0:
 os.read(r,1);os._exit(0)
print('parent finished',flush=True)
"""
        result = self.execute(code)
        self.assertEqual(result['status'], 'passed', result['output'])
        self.assertEqual(result['output'], 'parent finished\n')

    def test_real_missing_project_dependency_is_failed_not_mock_success(self):
        result = self.execute('import dgc_intentionally_missing_test_dependency')
        self.assertEqual(result['status'], 'failed'); self.assertNotEqual(result['exit_code'], 0)
        self.assertIn('ModuleNotFoundError', result['output'])


class SeatbeltPolicyTests(unittest.TestCase):
    """macOS argv, profile, environment and rlimit choices; pure, so they run on any host."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='dgc-seatbelt-unit-')
        self.addCleanup(self.temp.cleanup)
        self.run = Path(self.temp.name).resolve() / 'pips' / 'runs' / 'run_x'
        self.run.mkdir(parents=True)
        self.worktree = self.run / 'worktree'; self.worktree.mkdir()
        (self.worktree / 'source.py').write_text('value = 1\n')

    def test_darwin_prelude_sets_only_cpu_file_descriptor_and_core_limits(self):
        import resource
        self.assertEqual(execution._DARWIN_RLIMITS, (('RLIMIT_CPU', 30), ('RLIMIT_FSIZE', 67108864),
                                                     ('RLIMIT_NOFILE', 64), ('RLIMIT_CORE', 0)))
        for name in ('NPROC', 'AS', 'DATA', 'RSS', 'MEMLOCK'):
            self.assertNotIn(name, execution._LIMIT_EXEC_DARWIN)
        self.assertIn('RLIMIT_NPROC', execution._LIMIT_EXEC)
        self.assertIn('RLIMIT_AS', execution._LIMIT_EXEC)
        with patch.object(resource, 'setrlimit') as limits, patch.object(execution.os, 'execvpe') as replace, \
             patch.object(execution.sys, 'argv', ['-c', 'python3', '-m', 'unittest']):
            exec(compile(execution._LIMIT_EXEC_DARWIN, 'prelude', 'exec'), {})
        self.assertEqual(limits.call_args_list, [
            unittest.mock.call(resource.RLIMIT_CPU, (30, 30)), unittest.mock.call(resource.RLIMIT_FSIZE, (67108864, 67108864)),
            unittest.mock.call(resource.RLIMIT_NOFILE, (64, 64)), unittest.mock.call(resource.RLIMIT_CORE, (0, 0))])
        self.assertEqual(replace.call_args.args[:2], ('python3', ['python3', '-m', 'unittest']))

    def test_argv_is_sandbox_exec_profile_then_exact_command_with_no_shell(self):
        scratch = execution._make_scratch(self.run)
        command = ['/dev/python3', '-I', '-c', execution._LIMIT_EXEC_DARWIN, 'sh', '-c', 'echo "$HOME"']
        argv = execution._seatbelt_argv('/usr/bin/sandbox-exec', self.run, self.worktree, scratch, command)
        self.assertEqual(argv[:2], ['/usr/bin/sandbox-exec', '-p'])
        self.assertEqual(argv[3:], command)
        self.assertNotIn('/bin/bash', argv)
        execution._remove_scratch(scratch)

    def test_profile_denies_writes_network_signals_and_hides_homes_state_and_temp(self):
        scratch = execution._make_scratch(self.run)
        self.addCleanup(execution._remove_scratch, scratch)
        with patch.dict(os.environ, {'DGC_SDK_ISOLATED': '1', 'DGC_HOME': str(self.run.parent / 'sdk' / 'home')}):
            profile = execution._seatbelt_argv('/usr/bin/sandbox-exec', self.run, self.worktree, scratch, ['true'])[2]
        q = lambda path: f'(subpath "{Path(path).resolve()}")'
        self.assertTrue(profile.startswith('(version 1)(allow default)(deny file-write*)'))
        self.assertIn(f'(allow file-write* {q(scratch)} (literal "/dev/null")', profile)
        self.assertNotIn(f'(allow file-write* {q(self.worktree)}', profile)
        hidden = [Path.home(), '/Users', self.run, self.run.parent, self.run.parent.parent, self.run.parent / 'sdk',
                  '/private/tmp', '/private/var/tmp', '/private/var/folders']
        for path in hidden:
            self.assertIn(f'(deny file-read* {q(path)})', profile, path)
        # Seatbelt applies the last matching rule: the copy and scratch are re-allowed after.
        last_hide = max(profile.index(f'(deny file-read* {q(path)})') for path in hidden)
        for path in (self.worktree, scratch):
            self.assertGreater(profile.index(f'(allow file-read* {q(path)})'), last_hide)
            self.assertIn(f'(path-ancestors "{Path(path).resolve()}")', profile)
        for rule in ('(deny signal)(allow signal (target same-sandbox))', '(deny process-info*)',
                     '(sysctl-name-prefix "kern.procargs")', '"com.apple.pasteboard.1"', '"com.apple.SecurityServer"',
                     '(deny file-write-acl)'):
            self.assertIn(rule, profile)
        self.assertTrue(profile.endswith('(deny network*)'))
        self.assertNotIn('(allow network', profile)
        self.assertNotIn('(subpath "/")', profile)

    def test_environment_is_explicit_with_private_home_and_developer_tools_first(self):
        scratch = execution._make_scratch(self.run)
        self.addCleanup(execution._remove_scratch, scratch)
        with patch.dict(os.environ, {'DGC_API_KEY': 'SECRET', 'PYTHONPATH': '/x', 'DEVELOPER_DIR': '/evil'}):
            env = execution._seatbelt_env(scratch, '/Applications/Xcode.app/Contents/Developer/usr/bin/python3')
        self.assertEqual(set(env), {'PATH', 'HOME', 'TMPDIR', 'LANG', 'PYTHONDONTWRITEBYTECODE', 'PYTHONNOUSERSITE'})
        self.assertEqual((env['HOME'], env['TMPDIR']), (str(scratch / 'home'), str(scratch / 'tmp')))
        path = env['PATH'].split(':')
        self.assertLess(path.index('/Applications/Xcode.app/Contents/Developer/usr/bin'), path.index('/usr/bin'))
        self.assertTrue((scratch / 'home').is_dir() and (scratch / 'tmp').is_dir())
        self.assertEqual(scratch.stat().st_mode & 0o777, 0o700)

    def test_scratch_removal_undoes_test_modes_and_never_follows_links(self):
        scratch = execution._make_scratch(self.run)
        locked = scratch / 'tmp' / 'locked'; locked.mkdir(); (locked / 'file').write_text('x')
        (scratch / 'tmp' / 'link').symlink_to(self.worktree, target_is_directory=True)
        locked.chmod(0)
        execution._remove_scratch(scratch)
        self.assertFalse(scratch.exists())
        self.assertEqual((self.worktree / 'source.py').read_text(), 'value = 1\n')
        stale = execution._make_scratch(self.run); (stale / 'tmp' / 'leftover').write_text('x')
        self.assertEqual(sorted(p.name for p in execution._make_scratch(self.run).iterdir()), ['home', 'tmp'])
        execution._remove_scratch(stale)

    def test_scratch_size_walk_is_bounded(self):
        scratch = execution._make_scratch(self.run)
        self.addCleanup(execution._remove_scratch, scratch)
        (scratch / 'tmp' / 'data').write_bytes(b'x' * 65536)
        self.assertGreaterEqual(execution._scratch_bytes(scratch, 1 << 30), 65536)
        for i in range(5): (scratch / 'tmp' / f'f{i}').write_text('x')
        with patch.object(execution, 'MAX_FILES', 3):
            self.assertEqual(execution._scratch_bytes(scratch, 1 << 30), (1 << 30) + 1)

    def test_darwin_run_uses_seatbelt_real_cwd_clean_env_and_removes_scratch(self):
        source = self.run / 'source'; source.mkdir(); (source / 'source.py').write_text('value = 1\n')
        (source / 'pkg').mkdir(); (source / 'pkg' / 'mod.py').write_text('')
        self.worktree.rename(self.run / 'unused')
        seen = {}
        def capture(argv, **kwargs):
            seen.update(kwargs, argv=argv, scratch_exists=kwargs['scratch'].is_dir())
            return {'status': 'passed', 'exit_code': 0, 'data': b'ok\n', 'truncated': False}
        with patch.object(execution, 'require_capability'):
            prepared = execution.prepare_isolated_repo(source, self.run)
        with patch.object(execution, 'require_capability'), patch.object(execution, '_backend', return_value='seatbelt'), \
             patch.object(execution, '_runtime', return_value=('/usr/bin/sandbox-exec', '/dev/xcode/usr/bin/python3')), \
             patch.object(execution, '_capture', side_effect=capture), patch.object(execution, '_sandbox_argv', side_effect=AssertionError('bwrap on darwin')):
            action = execution.validate_action('pulse', {'kind': 'test', 'tests': [{'argv': ['python3', '-c', 'print(1)'], 'cwd': 'pkg'}]})
            result = execution.run_reviewed_tests(prepared, action)
        self.assertEqual(result[0]['status'], 'passed')
        self.assertEqual(seen['argv'][:2], ['/usr/bin/sandbox-exec', '-p'])
        self.assertEqual(seen['argv'][3:], ['/dev/xcode/usr/bin/python3', '-I', '-c', execution._LIMIT_EXEC_DARWIN, 'python3', '-c', 'print(1)'])
        self.assertEqual(seen['cwd'], str(self.run / 'worktree' / 'pkg'))
        self.assertTrue(seen['monitor']); self.assertTrue(seen['scratch_exists'])
        self.assertEqual(seen['env']['HOME'], str(self.run / 'scratch' / 'home'))
        self.assertFalse((self.run / 'scratch').exists())

    def test_probe_refuses_when_the_controller_git_shim_fails_before_any_sandbox_starts(self):
        # For example an unaccepted Xcode license: every run would fail at preparation.
        refused = {'status': 'failed', 'exit_code': 69, 'data': b'You have not agreed to the Xcode license', 'truncated': False}
        with patch.object(execution, '_capture', return_value=refused) as capture:
            self.assertFalse(execution._probe_darwin('/usr/bin/sandbox-exec', '/dev/xcode/usr/bin/python3'))
        self.assertEqual([call.args[0] for call in capture.call_args_list], [['/usr/bin/git', '--version']])
        self.assertIs(capture.call_args.kwargs['env'], execution._GIT_ENV)

    def test_capability_reports_seatbelt_scope_and_limitations_honestly(self):
        execution._PROBE_CACHE.clear()
        with patch.object(execution, '_backend', return_value='seatbelt'), \
             patch.object(execution, '_runtime', return_value=(execution.sys.executable, execution.sys.executable)), \
             patch.object(execution, '_probe_darwin', return_value=True) as probe:
            capability = execution.capability()
        execution._PROBE_CACHE.clear()
        probe.assert_called_once()
        self.assertTrue(capability['available'])
        self.assertEqual(capability['backend'], 'seatbelt')
        self.assertIs(capability['network'], False)
        self.assertEqual(capability['test_workspace'], 'read_only')
        self.assertEqual(capability['limits'], execution.LIMITS)
        self.assertEqual(capability['memory_scope'], 'sampled_aggregate_footprint')
        self.assertEqual(capability['process_scope'], 'sampled_process_tree')
        text = ' '.join(capability['limitations'])
        for claim in ('process namespace', 'loopback', 'System paths', 'sampled', 'deprecated'):
            self.assertIn(claim, text)
        with patch.object(execution, '_backend', return_value='seatbelt'), \
             patch.object(execution, '_runtime', return_value=(execution.sys.executable, execution.sys.executable)), \
             patch.object(execution, '_probe_darwin', return_value=False):
            refused = execution.capability()
        execution._PROBE_CACHE.clear()
        self.assertFalse(refused['available']); self.assertIsNone(refused['backend'])
        self.assertEqual(refused['limitations'], capability['limitations'])


class FakeLibproc:
    """A process table for the darwin monitor: pid -> (ppid, pgid, start), plus memory."""

    def __init__(self, table, memory=None, uid=None):
        self.table, self.memory_of, self.uid = dict(table), memory or {}, os.getuid() if uid is None else uid

    def identity(self, pid):
        if pid not in self.table:
            return None
        ppid, pgid, start = self.table[pid]
        from dgc.darwin_libproc import Identity
        return Identity(pid, ppid, pgid, self.uid, start)

    def children(self, pid, capacity):
        return [p for p, (ppid, _, _) in self.table.items() if ppid == pid][:capacity]

    def group(self, pgid, capacity):
        return [p for p, (_, group, _) in self.table.items() if group == pgid][:capacity]

    def memory(self, pid):
        return self.memory_of.get(pid, 1024) if pid in self.table else None


class DarwinMonitorTests(unittest.TestCase):
    def monitor(self, table, **kwargs):
        with patch('dgc.darwin_libproc.Libproc', return_value=FakeLibproc(table, **kwargs)):
            monitor = execution._DarwinProcesses()
        monitor._since = 1000.0
        return monitor

    def test_tree_and_detached_group_members_are_counted_but_old_or_recycled_pids_are_not(self):
        table = {10: (1, 10, 1000.5), 11: (10, 10, 1001.0), 12: (11, 12, 1001.2),
                 13: (1, 12, 1001.3),   # daemonized: reparented to launchd, still in group 12
                 50: (1, 50, 900.0),    # an unrelated older process
                 51: (1, 10, 900.0)}    # predates the run: never ours, even in a matching group
        monitor = self.monitor(table); monitor.attach(10)
        self.assertEqual(sorted(monitor._members(32)), [10, 11, 12, 13])
        monitor._proc.table[11] = (1, 99, 2000.0)  # pid 11 exited and was recycled by another process
        self.assertEqual(sorted(monitor._members(32)), [10, 12, 13])

    def test_process_and_aggregate_memory_caps(self):
        table = {10: (1, 10, 1001.0), **{100 + i: (10, 10, 1001.0) for i in range(32)}}
        monitor = self.monitor(table); monitor.attach(10)
        self.assertTrue(monitor.exceeded())
        table = {10: (1, 10, 1001.0), 11: (10, 10, 1001.0)}
        limit = execution.LIMITS['memory_bytes']
        monitor = self.monitor(table, memory={10: limit // 2, 11: limit // 2}); monitor.attach(10)
        self.assertFalse(monitor.exceeded())
        monitor._proc.memory_of[11] += 1
        self.assertTrue(monitor.exceeded())

    def test_reviewed_command_exit_kills_everything_it_left(self):
        table = {11: (1, 10, 1001.0), 12: (11, 12, 1001.1)}  # root 10 has exited
        monitor = self.monitor(table)
        monitor._root, monitor._known = 10, {10: 1000.5}
        killed, groups = [], []
        def kill(pid, sig):
            killed.append(pid); monitor._proc.table.pop(pid, None)
        with patch.object(execution.os, 'kill', side_effect=kill), patch.object(execution.os, 'killpg', side_effect=lambda g, s: groups.append(g)), \
             patch.object(execution.time, 'sleep'):
            self.assertFalse(monitor.exceeded())
        self.assertEqual(sorted(killed), [11, 12]); self.assertEqual(sorted(groups), [10, 12])

    def test_zombie_root_is_never_reaccepted_after_its_pid_is_recycled(self):
        monitor = self.monitor({})
        monitor.attach(10)                      # already exited: no identity
        self.assertEqual(monitor._known[10], -1.0)
        monitor._proc.table[10] = (1, 10, 1005.0)  # recycled by an unrelated process
        self.assertEqual(monitor._members(32), {})

    def test_stop_gives_up_loudly_when_processes_survive(self):
        monitor = self.monitor({10: (1, 10, 1001.0)}); monitor.attach(10)
        with patch.object(execution.os, 'kill'), patch.object(execution.os, 'killpg'), patch.object(execution.time, 'sleep'), \
             self.assertRaises(RegistryError) as raised:
            monitor.stop()
        self.assertEqual(raised.exception.code, 'execution_monitor_failed')

    def test_unreadable_live_memory_fails_closed(self):
        monitor = self.monitor({10: (1, 10, 1001.0)}); monitor.attach(10)
        monitor._proc.memory = Mock(side_effect=PermissionError(errno.EPERM, 'denied'))
        with self.assertRaises(RegistryError):
            monitor.exceeded()


@unittest.skipUnless(execution.sys.platform == 'darwin', 'macOS Seatbelt confinement integration')
class RealDarwinConfinementTests(unittest.TestCase):
    """The guarantees on a real Mac. The process cap, memory cap and scratch cap are sampled."""

    def setUp(self):
        capability = execution.capability()
        if not capability['available']:
            self.skipTest('Seatbelt confinement unavailable; execution correctly gated: ' + str(capability['reason']))
        self.assertEqual(capability['backend'], 'seatbelt')
        self.temp = tempfile.TemporaryDirectory(prefix='dgc-real-seatbelt-')
        self.addCleanup(self.temp.cleanup)
        self.base, self.count = Path(self.temp.name).resolve(), 0
        self.fresh()
        self.started = execution.time.time()

    def fresh(self):
        # One prepared run per reviewed command: artifacts are write-once per run.
        self.count += 1
        self.run = self.base / f'run{self.count}'; self.source = self.run / 'source'; self.source.mkdir(parents=True)
        (self.source / 'source.py').write_text('value = 1\n')

    def execute(self, code):
        # The script is part of the reviewed source copy, so its length is not an argv limit.
        (self.source / 'check.py').write_text(code)
        self.prepared = execution.prepare_isolated_repo(self.source, self.run)
        return execution.run_reviewed_tests(self.prepared, test_action(['python3', 'check.py']))[0]

    def assertGone(self, pids):
        from dgc.darwin_libproc import Libproc
        libproc = Libproc()
        for _ in range(100):
            alive = [pid for pid in pids if (info := libproc.identity(pid)) is not None and info.start >= self.started - 1]
            if not alive:
                return
            execution.time.sleep(0.02)
        self.fail(f'processes outlived their command: {alive}')

    def test_real_home_state_keys_and_other_runs_are_hidden_and_source_is_read_only(self):
        from dgc.sandbox import _account_home
        hidden = [str(Path.home().resolve()), str(_account_home().resolve()), str(self.run), str(self.run / 'private-git'),
                  str(self.run / 'source'), '/private/tmp', '/private/var/folders']
        code = ("import errno,os,resource\n"
                "def refused(f):\n try: f()\n except PermissionError as e: return e.errno==errno.EPERM\n return False\n"
                f"for path in {hidden!r}: assert refused(lambda: os.listdir(path)), path\n"
                "assert refused(lambda: open('source.py','w')); assert refused(lambda: open('new.py','x'))\n"
                "assert refused(lambda: os.chmod('source.py',0o777)); assert refused(lambda: os.unlink('source.py'))\n"
                "assert 'DGC_API_KEY' not in os.environ and 'PYTHONPATH' not in os.environ\n"
                "home=os.environ['HOME']; tmp=os.environ['TMPDIR']\n"
                f"assert home.startswith({str(self.run / 'scratch') + '/'!r}) and tmp.startswith({str(self.run / 'scratch') + '/'!r})\n"
                "open(os.path.join(tmp,'x'),'w').write('scratch'); open(os.path.join(home,'y'),'w').write('home')\n"
                "assert resource.getrlimit(resource.RLIMIT_CPU)==(30,30) and resource.getrlimit(resource.RLIMIT_NOFILE)==(64,64)\n"
                "assert resource.getrlimit(resource.RLIMIT_FSIZE)==(67108864,67108864) and resource.getrlimit(resource.RLIMIT_CORE)==(0,0)\n"
                "assert resource.getrlimit(resource.RLIMIT_NPROC)!=(32,32)\n"
                "print('confined', os.getcwd())")
        with patch.dict(os.environ, {'DGC_API_KEY': 'SECRET_TEST_KEY', 'PYTHONPATH': '/private/injection'}):
            result = self.execute(code)
        self.assertEqual(result['status'], 'passed', result['output'])
        self.assertEqual(result['output'], f"confined {self.run / 'worktree'}\n")
        self.assertEqual((Path(self.prepared['worktree']) / 'source.py').read_text(), 'value = 1\n')
        self.assertFalse((self.run / 'scratch').exists())

    def test_real_worktree_write_fails_with_eperm(self):
        result = self.execute("open('source.py','w').write('changed')")
        self.assertEqual(result['status'], 'failed')
        self.assertIn('Operation not permitted', result['output'])
        self.assertEqual((Path(self.prepared['worktree']) / 'source.py').read_text(), 'value = 1\n')
        execution.verify_unmodified(self.prepared, test_action())

    def test_real_network_is_denied_even_to_a_listening_loopback_port(self):
        import socket
        server = socket.socket(); server.bind(('127.0.0.1', 0)); server.listen(1); self.addCleanup(server.close)
        port = server.getsockname()[1]
        code = ("import errno,socket\ns=socket.socket()\n"
                f"try: s.connect(('127.0.0.1',{port}))\nexcept PermissionError as e: print('refused', e.errno==errno.EPERM)\n"
                "else: print('CONNECTED')\n"
                "try: socket.getaddrinfo('example.com',80); print('RESOLVED')\nexcept OSError: print('no dns')")
        result = self.execute(code)
        self.assertEqual(result['output'], 'refused True\nno dns\n', result['output'])

    def test_real_other_processes_cannot_be_signalled_or_have_their_environment_read(self):
        code = ("import ctypes,os,subprocess\nlibc=ctypes.CDLL(None,use_errno=True)\n"
                "def env_of(pid):\n mib=(ctypes.c_int*3)(1,49,pid); size=ctypes.c_size_t(65536); buf=ctypes.create_string_buffer(65536)\n"
                " return libc.sysctl(mib,3,buf,ctypes.byref(size),None,0)==0 and b'PATH=' in buf.raw[:size.value]\n"
                f"try: os.kill({os.getpid()},0); print('SIGNALLED')\nexcept PermissionError: print('signal refused')\n"
                f"print('read parent env', env_of({os.getpid()}))\n"
                "p=subprocess.Popen(['/bin/sleep','5']); p.kill(); print('own child', p.wait())\n"
                "r=subprocess.run(['/bin/sh','-c','/usr/bin/pbpaste >/dev/null 2>&1; echo $?'],capture_output=True,text=True)\n"
                "print('clipboard exit', r.stdout.strip()!='0')")
        result = self.execute(code)
        self.assertEqual(result['output'], 'signal refused\nread parent env False\nown child -9\nclipboard exit True\n', result['output'])

    def test_real_output_limit_and_private_artifact(self):
        result = self.execute('import os;os.write(1,b"z"*70000)')
        self.assertEqual(result['status'], 'output_limit')
        self.assertEqual(result['artifact']['bytes'], 65536)
        self.assertEqual((self.run / result['artifact']['path']).stat().st_size, 65536)

    def test_real_fork_bomb_is_stopped_by_the_sampled_process_cap(self):
        code = """import os,sys,time
for _ in range(9):
 os.fork()
sys.stdout.write(f'{os.getpid()}\\n'); sys.stdout.flush()
time.sleep(30)
"""
        result = self.execute(code)
        self.assertEqual(result['status'], 'resource_limit', result['output'][:200])
        self.assertIsNotNone(result['exit_code'])
        self.assertGone([int(line) for line in result['output'].split() if line.isdigit()])

    def test_real_memory_hog_and_aggregate_footprint_are_stopped(self):
        hog = "import time\nx=bytearray(1024*1024*1024)\nprint('allocated',flush=True)\ntime.sleep(30)\n"
        result = self.execute(hog)
        self.assertEqual(result['status'], 'resource_limit', result['output'])
        self.fresh()
        spread = """import os,time
pids=[]
for i in range(4):
 pid=os.fork()
 if pid==0:
  x=bytearray(200*1024*1024); print(os.getpid(),flush=True); time.sleep(30); os._exit(0)
 pids.append(pid)
time.sleep(30)
"""
        result = self.execute(spread)
        self.assertEqual(result['status'], 'resource_limit', result['output'])
        self.assertGone([int(line) for line in result['output'].split() if line.isdigit()])

    def test_real_scratch_size_is_sampled_and_file_size_is_a_hard_limit(self):
        fill = """import os,time
for i in range(8):
 open(os.path.join(os.environ['TMPDIR'],f'f{i}'),'wb').write(b'x'*(10*1024*1024))
time.sleep(30)
"""
        result = self.execute(fill)
        self.assertEqual(result['status'], 'resource_limit', result['output'])
        self.fresh()
        big = "import os\nopen(os.path.join(os.environ['TMPDIR'],'big'),'wb').write(b'x'*(65*1024*1024))"
        result = self.execute(big)
        self.assertEqual(result['status'], 'failed')
        self.assertFalse((self.run / 'scratch').exists())

    def test_real_orphans_and_detached_groups_end_with_the_reviewed_command(self):
        code = """import os,time
r,w=os.pipe()
if os.fork()==0:
 os.read(r,1); os._exit(0)
if os.fork()==0:
 os.setsid()
 if os.fork()==0:
  print(os.getpid(),flush=True); os.close(1); os.close(2); time.sleep(30); os._exit(0)
 time.sleep(0.5); os._exit(0)
time.sleep(1)
print('parent finished',flush=True)
"""
        result = self.execute(code)
        self.assertEqual(result['status'], 'passed', result['output'])
        self.assertTrue(result['output'].endswith('parent finished\n'), result['output'])
        self.assertGone([int(line) for line in result['output'].split() if line.isdigit()])

    def test_real_missing_project_dependency_is_failed_not_mock_success(self):
        result = self.execute('import dgc_intentionally_missing_test_dependency')
        self.assertEqual(result['status'], 'failed'); self.assertNotEqual(result['exit_code'], 0)
        self.assertIn('ModuleNotFoundError', result['output'])


class ExecutionResultTests(unittest.TestCase):
    def result(self, action=None):
        action = action or test_action()
        empty = hashlib.sha256(b'').hexdigest()
        value = {'summary': 'Reviewed command finished', 'verification': execution.VERIFICATION, 'tests_executed': True,
                 'execution': {'changes': {'kind': action['kind'], 'changed_files': [], 'diff': '', 'diff_truncated': False,
                   'artifact': {'path': 'artifacts/changes.patch', 'sha256': empty, 'bytes': 0}},
                   'tests': [{'index': 0, **action['tests'][0], 'status': 'passed', 'exit_code': 0, 'output': '',
                              'output_truncated': False, 'artifact': {'path': 'artifacts/test-1.txt', 'sha256': empty, 'bytes': 0}}]}}
        return value

    def test_canonical_result_keeps_actual_failed_test_and_counts_unstarted(self):
        action = test_action(); result = self.result(action)
        result['execution']['tests'][0].update(status='failed', exit_code=1)
        checked = execution.validate_execution_result(result, action)
        self.assertEqual(checked['execution']['tests'][0]['status'], 'failed')
        self.assertEqual(checked['execution']['tests_not_run'], 0)
        self.assertNotIn('tests_not_run', result['execution'])
        result['execution']['tests'][0].update(status='cancelled', exit_code=None)
        result['tests_executed'] = False
        self.assertEqual(execution.validate_execution_result(result, action)['execution']['tests_not_run'], 1)

    def test_result_cannot_invent_commands_changes_success_or_artifact_paths(self):
        mutations = [lambda v: v['execution']['tests'][0].update(argv=['different']),
                     lambda v: v['execution']['tests'][0].update(exit_code=1),
                     lambda v: v['execution']['tests'][0].update(index=True),
                     lambda v: v['execution']['tests'][0]['artifact'].update(path='/tmp/exfiltrate'),
                     lambda v: v['execution']['changes'].update(changed_files=['source.py']),
                     lambda v: v['execution'].update(tests=[]), lambda v: v.update(tests_executed=False),
                     lambda v: v.update(verification='Verified correct and deployed'),
                     lambda v: v['execution']['tests'][0].update(output='x'*4097),
                     lambda v: v.update(summary='\ud800')]
        for mutate in mutations:
            value = self.result(); mutate(value)
            with self.subTest(value=value), self.assertRaises(RegistryError):
                execution.validate_execution_result(value, test_action())

    def test_patch_without_tests_cannot_claim_execution(self):
        action = patch_action()
        value = self.result(test_action()); value['execution']['changes']['kind'] = 'patch'
        value['execution']['tests'] = []; value['tests_executed'] = False
        self.assertEqual(execution.validate_execution_result(value, action)['execution']['tests_not_run'], 0)
        value['tests_executed'] = True
        with self.assertRaises(RegistryError): execution.validate_execution_result(value, action)


if __name__ == '__main__':
    unittest.main()
