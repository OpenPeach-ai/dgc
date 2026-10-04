"""Reviewed action, private artifacts and real Linux confinement; no network/sleeps."""
from __future__ import annotations

import copy
import errno
import hashlib
import json
import io
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
        with patch.object(execution.sys, 'platform', 'darwin'), patch.object(execution.subprocess, 'Popen') as spawn:
            capability = execution.capability()
            self.assertFalse(capability['available'])
            self.assertIsNone(capability['backend'])
            with self.assertRaises(RegistryError):
                execution.require_capability()
            spawn.assert_not_called()


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
            result = execution._capture(['/usr/bin/python3', '-I', '-c', 'import os;os.read(0,1)'], maximum=64, timeout=1, env={})
        self.assertEqual(result['status'], 'timed_out')

    def test_sampled_memory_overflow_kills_before_unbounded_capture(self):
        with patch.object(execution, '_descendant_usage', return_value=(1, execution.LIMITS['memory_bytes'] + 1)):
            result = execution._capture(['/usr/bin/python3', '-I', '-c', 'print(1)'], maximum=64, timeout=10, env={}, monitor=True)
        self.assertEqual(result['status'], 'resource_limit')

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
        # The fake clock advances deterministically; no elapsed-time assertion.
        with patch.object(execution.time, 'monotonic', side_effect=[0, 0, 0, 2]):
            result = execution._capture(['/usr/bin/python3', '-I', '-c', code], maximum=64, timeout=1, env={})
        self.assertEqual(result['status'], 'timed_out')

    def test_capture_ceiling_and_utf8_replacement_are_bounded(self):
        result = execution._capture(['/usr/bin/python3', '-I', '-c', 'import os;os.write(1,b"x"*10000)'], maximum=64, timeout=10, env={})
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
