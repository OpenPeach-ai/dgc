"""safe_source_v2: what a Pip's source copy leaves out, and that a big project never fails every run.

Real files and real Git repositories, the real queue/controller and a real worker process with only
the model replaced. New modules are imported inside the tests so that, against the code before
safe_source_v2, each test fails on its own behaviour rather than the whole file failing to import.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pips, pip_sources, pip_tree_snapshot as tree
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as local

MiB = 1024 * 1024
V2 = {'mode': 'committed_only', 'exclusions': 'safe_source_v2'}
TREE_V2 = {'mode': 'current_tree', 'exclusions': 'safe_source_v2'}


def sparse(path, size):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as file:
        file.truncate(size)


@unittest.skipUnless(os.name == 'posix', 'POSIX descriptor confinement required')
class CurrentTreeRulesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.root = base / 'workspace'; self.root.mkdir()
        self.private = base / 'private'; self.private.mkdir(mode=0o700)
        self.n = 0
        (self.root / 'app.py').write_text('print("hello")\n')

    def capture(self, policy=TREE_V2, **kw):
        self.n += 1
        report = {}
        receipt = tree.capture(self.root, self.private / f'copy{self.n}', policy=policy, report=report, **kw)
        self.copy = self.private / f'copy{self.n}'
        return receipt, report.get('left_out')

    def copied(self):
        return sorted(str(p.relative_to(self.copy)) for p in self.copy.rglob('*') if p.is_file())

    def test_oversize_file_is_skipped_and_listed_while_v1_still_refuses(self):
        sparse(self.root / 'media' / 'intro.mp4', tree.MAX_FILE_BYTES + 1)
        with self.assertRaises(RegistryError) as caught:
            tree.capture(self.root, self.private / 'v1')
        self.assertEqual(caught.exception.code, 'snapshot_limit')
        self.assertIn('media/intro.mp4', str(caught.exception))         # the plain message names it
        self.assertIn('--source-rules v2', str(caught.exception))
        receipt, left = self.capture()
        self.assertEqual(receipt['exclusions'], 'safe_source_v2')
        self.assertEqual(receipt['skipped_files'], 1)
        self.assertEqual(left['skipped'], [{'path': 'media/intro.mp4', 'reason': 'too_large', 'bytes': tree.MAX_FILE_BYTES + 1}])
        self.assertEqual(self.copied(), ['app.py'])
        tree.verify(self.copy, receipt)
        self.assertEqual(tree.validate_receipt(receipt), receipt)

    def test_ignore_files_only_leave_things_out_and_never_reach_credentials(self):
        (self.root / '.gitignore').write_text('uploads/\n*.log\n!keep.log\n!.env\n!credentials.json\n!node_modules/\n')
        for name in ('uploads/a.pdf', 'logs/a.log', 'logs/keep.log', 'src/deep/.gitignore', 'src/deep/cache.tmp',
                     'src/deep/code.py', '.env', 'credentials.json', 'node_modules/x/index.js'):
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('*.tmp\n' if name.endswith('.gitignore') else 'SECRET=value\n' if 'env' in name or 'cred' in name else 'x\n')
        (self.root / '.git' / 'info').mkdir(parents=True)
        (self.root / '.git' / 'info' / 'exclude').write_text('local-notes.md\n')
        (self.root / 'local-notes.md').write_text('mine\n')
        with patch('subprocess.Popen', side_effect=AssertionError('No Git or other helper process')), \
             patch('subprocess.run', side_effect=AssertionError('No Git or other helper process')):
            receipt, left = self.capture()
        copied = self.copied()
        self.assertEqual(copied, ['.gitignore', 'app.py', 'logs/keep.log', 'src/deep/.gitignore', 'src/deep/code.py'])
        for secret in ('.env', 'credentials.json', 'node_modules/x/index.js'):
            self.assertNotIn(secret, copied)                    # a ! line never pulls in a fixed exclusion
        rules = {item['path']: item['rule'] for item in left['excluded']}
        self.assertEqual(rules, {'uploads/': 'gitignore', 'logs/a.log': 'gitignore', 'src/deep/cache.tmp': 'gitignore',
                                 'local-notes.md': 'gitignore'})
        self.assertEqual(left['excluded_count']['fixed'], 4)        # .git, .env, credentials.json, node_modules
        self.assertNotIn('.env', json.dumps(left))                  # fixed exclusions are counted, never named

    def test_dgcignore_and_pip_exclusions_leave_out_and_cannot_reinclude_gitignored(self):
        (self.root / '.gitignore').write_text('exports/\n')
        (self.root / 'docs').mkdir()
        (self.root / 'docs' / '.dgcignore').write_text('screenshots/\n!../exports/\n')
        (self.root / '.dgcignore').write_text('*.sql\n!exports/\n')
        for name in ('docs/screenshots/one.png', 'docs/guide.md', 'exports/data.csv', 'dump.sql', 'vendor-template/a.css',
                     'uploads/b.pdf'):
            path = self.root / name; path.parent.mkdir(parents=True, exist_ok=True); path.write_text('x\n')
        receipt, left = self.capture({**TREE_V2, 'exclude': ['uploads/', 'vendor-template/']})
        self.assertEqual(self.copied(), ['.dgcignore', '.gitignore', 'app.py', 'docs/.dgcignore', 'docs/guide.md'])
        rules = {item['path']: item['rule'] for item in left['excluded']}
        self.assertEqual(rules, {'docs/screenshots/': 'dgcignore', 'dump.sql': 'dgcignore', 'exports/': 'gitignore',
                                 'uploads/': 'pip', 'vendor-template/': 'pip'})

    def test_links_hard_links_special_files_and_unsafe_names_are_skipped_and_listed(self):
        (self.root / 'outside-link').symlink_to('/etc/hostname')
        (self.root / 'shared.txt').write_text('two names\n')
        os.link(self.root / 'shared.txt', self.root / 'shared-again.txt')
        os.mkfifo(self.root / 'pipe')
        (self.root / 'report:2026.txt').write_text('colon\n')
        receipt, left = self.capture()
        reasons = {item['path']: item['reason'] for item in left['skipped']}
        self.assertEqual(reasons, {'outside-link': 'link', 'shared.txt': 'hard_link', 'shared-again.txt': 'hard_link',
                                   'pipe': 'special', 'report:2026.txt': 'unsupported_name'})
        self.assertEqual(self.copied(), ['app.py'])
        self.assertEqual(receipt['skipped_files'], 5)

    def test_file_with_a_configured_secret_is_skipped_not_fatal(self):
        (self.root / 'settings.py').write_text('TOKEN = "EXACT_CONFIGURED_SECRET"\n')
        with self.assertRaises(RegistryError) as caught:
            tree.capture(self.root, self.private / 'v1', secrets=('EXACT_CONFIGURED_SECRET',))
        self.assertEqual(caught.exception.code, 'secret_in_source')
        receipt, left = self.capture(secrets=('EXACT_CONFIGURED_SECRET',))
        self.assertEqual(self.copied(), ['app.py'])
        self.assertEqual(left['skipped'], [{'path': 'settings.py', 'reason': 'secret', 'bytes': 34}])
        self.assertNotIn('EXACT_CONFIGURED_SECRET', json.dumps(left))
        tree.verify(self.copy, receipt)

    def test_still_too_big_names_the_biggest_folders_and_how_to_leave_them_out(self):
        from dgc import pip_source_rules as rules
        for i in range(3):
            (self.root / 'docs' / 'screenshots').mkdir(parents=True, exist_ok=True)
            (self.root / 'docs' / 'screenshots' / f'{i}.png').write_bytes(b'p' * 4000)
        (self.root / 'backend').mkdir()
        (self.root / 'backend' / 'server.py').write_bytes(b's' * 3000)
        with patch.object(rules, 'MAX_BYTES', 10000), self.assertRaises(RegistryError) as caught:
            self.capture()
        message = str(caught.exception)
        self.assertEqual(caught.exception.code, 'snapshot_limit')
        self.assertIn('Biggest folders: docs/screenshots 12 KiB, backend 3 KiB', message)
        self.assertIn('Excluded folders', message)
        self.assertIn('.dgcignore', message)
        self.assertNotIn('committed source or a smaller workspace', message)
        self.assertEqual(caught.exception.source_size['biggest_folders'][0]['path'], 'docs/screenshots')
        self.assertFalse(list(self.private.iterdir()))              # nothing was copied
        with patch.object(rules, 'MAX_BYTES', 10000):
            receipt, left = self.capture({**TREE_V2, 'exclude': ['docs/screenshots/']})
        self.assertEqual(left['excluded'], [{'path': 'docs/screenshots/', 'rule': 'pip'}])

    def test_ignored_entries_do_not_count_against_the_copy_limit(self):
        (self.root / '.gitignore').write_text('*.log\n')
        (self.root / 'logs').mkdir()
        for i in range(40):
            (self.root / 'logs' / f'{i}.log').write_text('x')
        with patch.object(tree, 'MAX_ENTRIES', 20), self.assertRaises(RegistryError):
            tree.capture(self.root, self.private / 'v1')               # v1 counts every entry it looks at
        from dgc import pip_source_rules as rules
        with patch.object(rules, 'MAX_ENTRIES', 20):
            receipt, left = self.capture()
        self.assertEqual(receipt['files'], 2)                           # .gitignore and app.py
        self.assertEqual(left['excluded_count']['gitignore'], 40)

    def test_policies_and_receipts_are_versioned(self):
        self.assertEqual(tree.validate_policy({'mode': 'current_tree', 'exclusions': 'safe_source_v1'})['exclusions'], 'safe_source_v1')
        self.assertEqual(pip_sources.validate_policy({**TREE_V2, 'exclude': ['uploads/']}), {**TREE_V2, 'exclude': ['uploads/']})
        self.assertEqual(pip_sources.validate_policy(V2), V2)
        for bad in ({**V2, 'exclude': []}, {**V2, 'exclude': ['!.env']}, {**V2, 'exclude': ['../outside/']},
                    {**V2, 'exclude': ['a\\b']}, {**V2, 'exclude': ['./uploads/']}, {**V2, 'exclude': ['x', 'x']},
                    {**V2, 'exclusions': 'safe_source_v3'}, {**V2, 'extra': 1}, {'mode': 'committed_only', 'exclude': ['x']},
                    {**V2, 'exclude': ['p'] * 33}, {**V2, 'exclude': ['*']}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                pip_sources.validate_policy(bad)
        old = {'schema_version': 1, 'kind': 'current_tree', 'sha256': 'a' * 64, 'files': 2, 'bytes': 21,
               'exclusions': 'safe_source_v1', 'excluded_entries': 1, 'excluded_directories': 0, 'consistency': 'checked_non_atomic'}
        self.assertEqual(tree.validate_receipt(old), old)                # existing v1 receipts still validate
        for bad in ({**old, 'skipped_files': 0}, {**old, 'bytes': 64 * MiB + 1},
                    {**old, 'exclusions': 'safe_source_v2'}, {**old, 'schema_version': 2, 'exclusions': 'safe_source_v2'}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                tree.validate_receipt(bad)
        new = {**old, 'schema_version': 2, 'exclusions': 'safe_source_v2', 'skipped_files': 3, 'bytes': 200 * MiB}
        self.assertEqual(tree.validate_receipt(new), new)
        with self.assertRaises(RegistryError):
            pip_sources.validate_job(V2, pip_type='pulse')               # Patch and Pulse keep the original rules
        self.assertEqual(pip_sources.default_policy('rook'), V2)
        self.assertEqual(pip_sources.default_policy('patch'), {'mode': 'committed_only'})


class PatternTests(unittest.TestCase):
    def matches(self, lines, path, directory=False, base=''):
        from dgc import pip_source_rules as rules
        return rules.decide((('gitignore', rules.parse(lines, base)),), path, directory) is not None

    def test_gitignore_semantics(self):
        cases = [('build/', 'build', True, True), ('build/', 'build', False, False), ('build/', 'src/build', True, True),
                 ('/build', 'src/build', True, False), ('/build', 'build', False, True), ('docs/shots', 'docs/shots', True, True),
                 ('docs/shots', 'x/docs/shots', True, False), ('*.mp4', 'a/b/c.mp4', False, True), ('**/fixtures', 'a/b/fixtures', True, True),
                 ('a/**/z', 'a/z', False, True), ('a/**/z', 'a/b/c/z', False, True), ('logs/**', 'logs/a/b.txt', False, True),
                 ('logs/**', 'logs', True, False), ('*.log\n!keep.log', 'keep.log', False, False), ('file?.txt', 'file1.txt', False, True),
                 ('[ab].txt', 'b.txt', False, True), ('[!ab].txt', 'b.txt', False, False), ('\\#hash', '#hash', False, True),
                 ('# comment', '# comment', False, False), ('trailing   ', 'trailing', False, True)]
        for lines, path, directory, expected in cases:
            with self.subTest(lines=lines, path=path):
                self.assertEqual(self.matches(lines, path, directory), expected)
        self.assertTrue(self.matches('*.tmp', 'src/x.tmp', base='src'))
        self.assertFalse(self.matches('*.tmp', 'other/x.tmp', base='src'))
        self.assertFalse(self.matches('*.tmp', 'src', True, base='src'))


class CommittedRulesTests(unittest.TestCase):
    setUp = local.LocalPipsTests.setUp
    git = local.LocalPipsTests.git

    def commit_files(self, files, message='project'):
        if not (self.root / '.git').exists():
            self.git('init', '-q')
        for name, data in files.items():
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(data, int):
                sparse(path, data)
            else:
                path.write_bytes(data if isinstance(data, bytes) else data.encode())
        self.git('add', '-A', '-f')
        self.git('commit', '-qm', message)
        return self.git('rev-parse', 'HEAD')

    def test_oversize_link_and_submodule_are_skipped_and_listed(self):
        revision = self.commit_files({'app.py': 'x = 1\n', 'media/intro.mp4': 5 * MiB})
        (self.root / 'latest').symlink_to('app.py')
        self.git('add', 'latest')
        self.git('update-index', '--add', '--cacheinfo', '160000,' + revision + ',vendor/lib')
        self.git('commit', '-qm', 'link and submodule')
        revision = self.git('rev-parse', 'HEAD')
        with self.assertRaises(RegistryError):
            pips.clean_snapshot(self.root, revision, self.base / 'v1')     # the original rules still fail
        info, left = pips.copy_committed(self.root, revision, self.base / 'copy', V2)
        self.assertEqual(info['files'], 1)
        self.assertEqual({item['path']: item['reason'] for item in left['skipped']},
                         {'media/intro.mp4': 'too_large', 'latest': 'link', 'vendor/lib/': 'submodule'})
        self.assertEqual(sorted(p.name for p in (self.base / 'copy').rglob('*') if p.is_file()), ['app.py'])

    def test_committed_dgcignore_and_pip_exclusions_apply_but_gitignore_does_not_reach_tracked_files(self):
        revision = self.commit_files({'app.py': 'x\n', '.gitignore': 'uploads/\n', 'uploads/kept-by-git.pdf': 'tracked\n',
                                      '.dgcignore': 'docs/screenshots/\n*.sql\n', 'docs/screenshots/a.png': b'p' * 300,
                                      'docs/screenshots/b.png': b'p' * 200, 'dump.sql': 'sql\n', 'exports/x.csv': 'csv\n'})
        (self.root / '.dgcignore').write_text('app.py\n')                  # uncommitted: never read for committed source
        info, left = pips.copy_committed(self.root, revision, self.base / 'copy', {**V2, 'exclude': ['exports/']})
        copied = sorted(str(p.relative_to(self.base / 'copy')) for p in (self.base / 'copy').rglob('*') if p.is_file())
        self.assertEqual(copied, ['.dgcignore', '.gitignore', 'app.py', 'uploads/kept-by-git.pdf'])
        self.assertEqual(left['excluded'], [{'path': 'docs/screenshots/', 'rule': 'dgcignore', 'files': 2, 'bytes': 500},
                                            {'path': 'dump.sql', 'rule': 'dgcignore', 'files': 1, 'bytes': 4},
                                            {'path': 'exports/', 'rule': 'pip', 'files': 1, 'bytes': 4}])

    def test_still_too_big_message_names_folders_and_the_v1_message_names_files(self):
        from dgc import pip_source_rules as rules
        revision = self.commit_files({'docs/screenshots/a.png': b'p' * 6000, 'backend/server.py': b's' * 3000,
                                      'frontend/video.mp4': 5 * MiB})
        with self.assertRaises(RegistryError) as caught:
            pips.clean_snapshot(self.root, revision, self.base / 'v1')
        self.assertIn('frontend/video.mp4 (5.0 MiB)', str(caught.exception))
        self.assertIn('older source rules', str(caught.exception))
        with patch.object(rules, 'MAX_BYTES', 8000), self.assertRaises(RegistryError) as caught:
            pips.copy_committed(self.root, revision, self.base / 'v2', V2)
        message = str(caught.exception)
        self.assertIn('9 KiB in 2 files, over the 8 KiB limit', message)
        self.assertIn('after leaving out 1 files DGC can’t copy (5.0 MiB)', message)
        self.assertIn('Biggest folders: docs/screenshots 6 KiB, backend 3 KiB', message)
        self.assertIn('committed at the project root', message)
        self.assertFalse((self.base / 'v2').exists())


class SourcePipTests(unittest.TestCase):
    """Queue, approval, checkpoints and the main-chat tools around safe_source_v2."""
    setUp = local.LocalPipsTests.setUp
    git = local.LocalPipsTests.git
    commit_files = CommittedRulesTests.commit_files

    def create(self, **kw):
        return self.store.create(self.workspace['id'], 'ERP reviewer', 'Review the backend.', 'user', **kw)

    def review(self, job, changes, actor='user'):
        proposal = self.store.propose(job['id'], job['current_version'], changes, actor, 'Reviewed source rules')
        return self.store.accept(job['id'], proposal['id'], job['current_version'], actor)

    def control(self, request):
        with patch('dgc.workspace_registry.state_directory', return_value=self.registry.directory):
            return pips.handle_control(self.cfg, {'request_id': 'source-test', **request}, 'editor-user', start_worker=False)

    def worker(self, row, fixture):
        original = subprocess.Popen

        def process(argv, *args, **kwargs):
            if argv[1:] == ['-m', 'dgc.pips', '--worker']:
                argv = [sys.executable, '-c', fixture]
            return original(argv, *args, **kwargs)
        with patch.object(pips.subprocess, 'Popen', side_effect=process):
            return pips._execute_run(self.registry, row, self.cfg)

    def test_existing_v1_pip_keeps_failing_until_v2_is_approved_then_runs_and_the_pip_is_told(self):
        """End to end: the founder's shape in small. Real queue, controller and worker process."""
        self.commit_files({'backend/server.py': 'def health():\n    return "ok"\n', 'frontend/intro.mp4': 5 * MiB,
                           'portal/intro.mp4': 5 * MiB})
        job = self.create(source_policy={'mode': 'committed_only'})      # a Pip from before this change
        queued = self.store.enqueue(job['id'], 'v1', 'user', self.cfg)
        with self.assertRaises(RegistryError) as caught:
            self.worker(self.store.claim_next(), 'raise SystemExit(9)')
        self.assertEqual(caught.exception.code, 'snapshot_limit')
        self.assertIn('frontend/intro.mp4', str(caught.exception))
        self.store.finish(queued['id'], error={'code': caught.exception.code, 'message': str(caught.exception)})
        job = self.review(self.store.get(job['id']), {'source_policy': V2})   # the one approval it needs
        queued = self.store.enqueue(job['id'], 'v2', 'user', self.cfg)
        fixture = r'''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
responses = iter([ChatResult(tool_calls=[ToolCall("r1", "read_file", {"path": "backend/server.py"})]),
                  ChatResult(content=json.dumps({"summary": "Reviewed the backend", "findings": [],
                                                 "limitations": ["Static inspection only"]}))])
def chat(self, messages, tools=None, on_text=None, **kwargs):
    prompt = "\n".join(str(m.get("content")) for m in messages)
    assert "Left out of this source copy" in prompt, "the Pip was not told what its copy left out"
    assert "frontend/intro.mp4: skipped, over the 4 MiB per-file limit (5.0 MiB)" in prompt
    assert "do not conclude they are missing" in prompt
    result = next(responses)
    if result.content and on_text:
        on_text(result.content)
    return result
with patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''
        result = self.worker(self.store.claim_next(), fixture)
        finished = self.store.finish(queued['id'], result=result)
        self.assertEqual(finished['status'], 'succeeded')
        self.assertEqual(finished['result']['snapshot']['files'], 1)
        source = self.control({'type': 'get_pip_run_source', 'run_id': queued['id']})
        self.assertTrue(source['ok'], source)
        self.assertEqual(source['result']['status'], 'recorded')
        self.assertEqual([item['path'] for item in source['result']['left_out']['skipped']],
                         ['frontend/intro.mp4', 'portal/intro.mp4'])
        from dgc import pip_checkpoints
        checkpoint = pip_checkpoints.for_run(self.store, queued['id'])
        self.assertEqual(checkpoint['source_policy'], V2)
        # Its v1 runs all failed, so there is no earlier report: this first one is compared with nothing.
        self.assertEqual(checkpoint['comparison'], {'status': 'compared', 'reason': None, 'previous_checkpoint_id': None})

    def test_v1_to_v2_needs_a_reviewed_change_and_checkpoints_say_the_rules_changed(self):
        from dgc import pip_checkpoints
        revision = self.commit_files({'source.py': 'answer = 41\n'})
        job = self.create(source_policy={'mode': 'committed_only'})
        finding = {'title': 'Fixture', 'severity': 'low', 'path': 'source.py', 'line': 1, 'evidence': 'answer = 41'}

        def complete(key):
            run = self.store.enqueue(job['id'], key, 'user', self.cfg)
            self.store.claim_next()
            result = {'summary': 'Checked', 'findings': [{**finding, 'verification': 'source_excerpt_only'}],
                      'limitations': [], 'tests_executed': False, 'verification': pip_checkpoints._SOURCE_VERIFICATION,
                      'snapshot': {'sha256': 'a' * 64, 'files': 1, 'bytes': 12}}
            self.store.finish(run['id'], result=result)
            return pip_checkpoints.for_run(self.store, run['id'])

        first = complete('one')
        self.assertEqual(first['counts']['new'], 1)
        proposal = self.store.propose(job['id'], 1, {'source_policy': V2}, 'user', 'Current rules')
        self.assertEqual(self.store.get(job['id'])['source_policy'], {'mode': 'committed_only'})   # nothing until accepted
        self.store.accept(job['id'], proposal['id'], 1, 'user')
        job = self.store.get(job['id'])
        switched = complete('two')
        self.assertEqual(switched['comparison'], {'status': 'unavailable', 'reason': 'source_policy_changed',
                                                  'previous_checkpoint_id': first['id']})
        self.assertIsNone(switched['counts']['new'])
        again = complete('three')
        self.assertEqual(again['comparison']['status'], 'compared')
        self.assertEqual(again['counts']['repeated'], 1)
        fresh = self.create()
        self.assertEqual(fresh['source_policy'], V2)
        job = fresh
        first_new = complete('fresh')
        self.assertEqual(first_new['comparison'], {'status': 'compared', 'reason': None, 'previous_checkpoint_id': None})
        self.assertEqual(first_new['counts'], {'total': 1, 'new': 1, 'repeated': 0, 'not_observed': 0})
        self.assertEqual(revision, self.git('rev-parse', 'HEAD'))

    def test_chat_can_set_excluded_folders_but_not_where_the_source_comes_from(self):
        from dgc import pip_proposal_tool
        from tests import test_pip_proposal_tool as proposal_fixtures
        self.commit_files({'source.py': 'x\n'})
        job = self.create(source_policy={'mode': 'committed_only'})
        ctx = proposal_fixtures.PipProposalToolTests.context(self)
        args = {'pip_id': job['id'], 'expected_version': 1, 'changes': {'source_exclude': ['docs/screenshots/', 'uploads/']},
                'reason': 'Runs fail: the source is too big.', 'request_key': 'exclude-1'}
        with patch.object(pip_proposal_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            receipt = json.loads(pip_proposal_tool.propose(args, ctx))
        self.assertTrue(receipt['job_changed_by_this_call'])            # allowed like any pips_propose call
        self.assertEqual(self.store.get(job['id'])['source_policy'], {**V2, 'exclude': ['docs/screenshots/', 'uploads/']})
        self.registry.associate_session('chat-one', self.root)
        with self.assertRaisesRegex(RegistryError, 'not where its source'):
            self.store.propose(job['id'], 2, {'source_policy': TREE_V2}, 'core_proposal', origin_session_id='chat-one',
                               request_key='switch', expected_workspace_id=self.workspace['id'])
        with self.assertRaises(RegistryError):
            self.store.propose(job['id'], 2, {'source_policy': {'mode': 'committed_only'}}, 'core_proposal',
                               origin_session_id='chat-one', request_key='back', expected_workspace_id=self.workspace['id'])

    def test_run_pip_now_refuses_a_source_that_cannot_fit_and_queues_nothing(self):
        from dgc import pip_run_tool, pip_source_rules as rules
        from tests import test_pip_proposal_tool as proposal_fixtures
        self.commit_files({'docs/screenshots/a.png': b'p' * 6000, 'backend/server.py': b's' * 3000})
        job = self.create()
        ctx = proposal_fixtures.PipProposalToolTests.context(self)
        args = {'pip_id': job['id'], 'expected_version': 1, 'reason': 'Review now.', 'request_key': 'now-1'}
        with patch.object(pip_run_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}), \
             patch.object(rules, 'MAX_BYTES', 8000), self.assertRaises(RegistryError) as caught:
            pip_run_tool.run(args, ctx)
        self.assertEqual(caught.exception.code, 'snapshot_limit')
        self.assertIn('Biggest folders: docs/screenshots', str(caught.exception))
        self.assertIn('Nothing was queued', str(caught.exception))
        self.assertEqual(self.store.runs(job['id']), [])

    def test_setup_tool_and_check_control_report_the_size_before_any_run(self):
        from dgc import pip_setup_tool, pip_source_rules as rules
        self.commit_files({'docs/screenshots/a.png': b'p' * 6000, 'backend/server.py': b's' * 3000, 'media/v.mp4': 5 * MiB})
        self.registry.associate_session('main-chat', self.root)
        request = {'target_root': str(self.root), 'name': 'Reviewer', 'goal': 'Review committed source.', 'pip_type': 'rook',
                   'work_kind': 'source_review', 'schedule': None, 'run_now': False, 'request_key': 'setup-1',
                   'reason': 'Asked for a reviewer.'}
        ctx = SimpleNamespace(config=self.cfg, project_root=self.root,
                              pip_proposal_origin=lambda: {'session_id': 'main-chat', 'workspace_id': self.workspace['id']})
        with patch.object(pip_setup_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(rules, 'MAX_BYTES', 8000):
            answer = json.loads(pip_setup_tool.propose(request, ctx))
        self.assertIs(answer['source_check']['fits'], False)
        self.assertIn('Biggest folders: docs/screenshots', answer['message'])
        self.assertIn('source_exclude', answer['message'])
        job = self.create()
        checked = self.control({'type': 'check_pip_source', 'pip_id': job['id']})
        self.assertTrue(checked['ok'], checked)
        check = checked['result']['check']
        self.assertEqual((check['fits'], check['rules'], check['files']), (True, 'safe_source_v2', 2))
        self.assertEqual(check['left_out']['skipped'], [{'path': 'media/v.mp4', 'reason': 'too_large', 'bytes': 5 * MiB}])
        with patch.object(rules, 'MAX_BYTES', 8000):
            unsaved = self.control({'type': 'check_pip_source', 'pip_id': job['id'],
                                    'source_policy': {**V2, 'exclude': ['docs/screenshots/']}})['result']['check']
            saved = self.control({'type': 'check_pip_source', 'pip_id': job['id']})['result']['check']
        self.assertTrue(unsaved['fits'])
        self.assertFalse(saved['fits'])
        self.assertEqual(self.store.get(job['id'])['source_policy'], V2)  # checking saves nothing
        self.assertFalse(self.control({'type': 'check_pip_source', 'pip_id': job['id'], 'source_policy': {'mode': 'personal'}})['ok'])


class CliSourceTests(unittest.TestCase):
    def test_cli_excludes_keep_the_current_source_and_v1_stays_available(self):
        from dgc import pip_cli
        args = SimpleNamespace(source_rules=None, exclude=['uploads/', 'docs/screenshots/'], no_excludes=False, source_policy=None)
        self.assertEqual(pip_cli._source_policy_from_args(args, 'current_tree'), {**TREE_V2, 'exclude': ['uploads/', 'docs/screenshots/']})
        args = SimpleNamespace(source_rules='v1', exclude=None, no_excludes=False, source_policy='committed_only')
        self.assertEqual(pip_cli._source_policy_from_args(args, 'committed_only'), {'mode': 'committed_only'})
        args = SimpleNamespace(source_rules='v1', exclude=['x/'], no_excludes=False, source_policy=None)
        with self.assertRaises(RegistryError):
            pip_cli._source_policy_from_args(args, 'committed_only')
        text = pip_cli._format({'check': {'applies': True, 'fits': True, 'rules': 'safe_source_v2', 'files': 3, 'bytes': 2 * MiB,
                                          'limits': {'bytes': 256 * MiB, 'entries': 10000, 'file_bytes': 4 * MiB},
                                          'biggest_folders': [{'path': 'backend', 'bytes': MiB, 'files': 2}],
                                          'left_out': {'schema_version': 1, 'rules': 'safe_source_v2',
                                                       'skipped': [{'path': 'a.mp4', 'reason': 'too_large', 'bytes': 7 * MiB}],
                                                       'skipped_count': 1, 'skipped_bytes': 7 * MiB, 'excluded': [],
                                                       'excluded_count': {'fixed': 0, 'gitignore': 0, 'dgcignore': 0, 'pip': 0},
                                                       'omitted': 0}, 'message': None, 'mode': 'committed_only', 'revision': None}})
        self.assertIn('Fits: 3 files, 2.0 MiB of the 256.0 MiB limit', text)
        self.assertIn('a.mp4: skipped, over the 4 MiB per-file limit (7.0 MiB)', text)
        self.assertIn('Biggest folders: backend 1.0 MiB', text)


if __name__ == '__main__':
    unittest.main()
