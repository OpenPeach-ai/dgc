"""Execution-result decisions are durable CAS records, never execution authority."""
import json
import sqlite3
import unittest
from unittest.mock import patch

from dgc import pip_execution, pip_execution_reviews as reviews, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_handoffs as fixtures


class ExecutionReviewTests(unittest.TestCase):
    setUp = fixtures.PipHandoffTests.setUp
    git = fixtures.PipHandoffTests.git
    commit = fixtures.PipHandoffTests.commit
    setup_source = fixtures.PipHandoffTests.setup_source
    propose = fixtures.PipHandoffTests.propose
    accept = fixtures.PipHandoffTests.accept

    def completed(self):
        self.setup_source()
        job = self.store.create(self.workspace['id'], 'Fixer', 'Reviewed fix', 'device', pip_type='patch')
        action = {'kind': 'patch', 'write_paths': ['source.py'], 'tests': []}
        with patch.object(pip_execution, 'capability', return_value={'available': True}):
            proposed = self.propose(target_pip_id=job['id'], action=action)
            queued = self.accept(proposed)['run']
        self.store.claim_next()
        result = {'summary': 'No change needed after inspection', 'verification': pip_execution.VERIFICATION,
                  'tests_executed': False, 'execution': {'tests': [], 'changes': {'kind': 'patch',
                  'changed_files': [], 'diff': '', 'diff_truncated': False,
                  'artifact': {'path': 'artifacts/changes.patch', 'sha256': '0' * 64, 'bytes': 0}}}}
        self.store.finish(queued['id'], result=result)
        return queued['id']

    def test_initial_open_is_not_an_approval_and_read_does_not_insert(self):
        run = self.completed()
        value = reviews.for_run(self.store, run)
        self.assertEqual((value['status'], value['revision'], value['actor']), ('open', 0, None))
        self.assertEqual(len(value['result_digest']), 64)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_execution_reviews').fetchone()[0], 0)

    def test_accept_dismiss_reopen_history_durable_without_run_or_source_mutation(self):
        run = self.completed()
        before = (self.root / 'source.py').read_bytes()
        before_runs = self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0]
        for revision, status in enumerate(('accepted', 'dismissed', 'open')):
            value = reviews.review(self.store, run, status, revision, 'reviewer', 'Reason: ' + status)
            self.assertEqual((value['status'], value['revision']), (status, revision + 1))
        with WorkspaceRegistry(self.registry.directory) as reopened:
            found = reviews.for_run(pips.PipStore(reopened), run)
        self.assertEqual(found, value)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], before_runs)
        self.assertEqual((self.root / 'source.py').read_bytes(), before)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_execution_reviews').fetchone()[0], 3)

    def test_stale_revision_and_wrong_types_fail_closed(self):
        run = self.completed()
        reviews.review(self.store, run, 'accepted', 0, 'reviewer', 'Inspected diff')
        with self.assertRaisesRegex(RegistryError, 'changed'):
            reviews.review(self.store, run, 'dismissed', 0, 'another', 'Stale')
        for status, revision, reason in [(None, 1, 'Reason'), ('accepted', True, 'Reason'),
                                        ('accepted', -1, 'Reason'), ('accepted', 100, 'Reason'),
                                        ('accepted', 1, ''), ('accepted', 1, 'x' * 2001)]:
            with self.subTest(status=status, revision=revision), self.assertRaises(RegistryError):
                reviews.review(self.store, run, status, revision, 'reviewer', reason)
        self.assertEqual(reviews.for_run(self.store, run)['revision'], 1)

    def test_nonexecution_runs_never_get_result_approval(self):
        self.setup_source()
        self.assertIsNone(reviews.for_run(self.store, self.source_run['id']))
        with self.assertRaises(RegistryError):
            reviews.review(self.store, self.source_run['id'], 'accepted', 0, 'reviewer', 'Not execution')
        with self.assertRaises(RegistryError):
            reviews.for_run(self.store, 'missing')

    def test_changed_evidence_cannot_reuse_a_previous_result_decision(self):
        run = self.completed()
        reviews.review(self.store, run, 'accepted', 0, 'reviewer', 'Inspected evidence')
        result = json.loads(self.registry.db.execute('SELECT result FROM pip_runs WHERE id=?', (run,)).fetchone()[0])
        result['summary'] = 'Different evidence'
        self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?', (json.dumps(result), run))
        with self.assertRaisesRegex(RegistryError, 'changed'):
            reviews.for_run(self.store, run)
        with self.assertRaises(RegistryError):
            reviews.review(self.store, run, 'accepted', 1, 'reviewer', 'Cannot silently reuse')

    def test_history_is_immutable_and_failed_event_rolls_back(self):
        run = self.completed()
        with patch.object(self.registry, 'event', side_effect=RuntimeError('fixture event')), self.assertRaises(RuntimeError):
            reviews.review(self.store, run, 'accepted', 0, 'reviewer', 'Atomic')
        self.assertEqual(reviews.for_run(self.store, run)['revision'], 0)
        reviews.review(self.store, run, 'accepted', 0, 'reviewer', 'Atomic')
        for sql in ['UPDATE pip_execution_reviews SET status="dismissed"', 'DELETE FROM pip_execution_reviews']:
            with self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute(sql)

    def test_corrupt_manifest_and_cross_run_identity_cannot_acquire_review(self):
        run = self.completed()
        raw = self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run,)).fetchone()[0]
        original = json.loads(raw)
        # Simulate externally corrupted private storage, beyond normal immutable writes.
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        for manifest in ([], {**original, 'workspace_id': 'another-workspace'},
                         {**original, 'pip_id': 'another-pip'}):
            self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?', (json.dumps(manifest), run))
            with self.assertRaises(RegistryError):
                reviews.review(self.store, run, 'accepted', 0, 'reviewer', 'Corrupt identity')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?', (raw, run))
        self.assertEqual(reviews.for_run(self.store, run)['revision'], 0)

    def test_oversized_saved_reason_is_refused_before_text_fetch(self):
        run = self.completed()
        digest = reviews.for_run(self.store, run)['result_digest']
        self.registry.db.execute('INSERT INTO pip_execution_reviews VALUES(?,?,?,?,?,?,?)',
            (run, 1, digest, 'accepted', 'reviewer', 'x' * 100000, self.now))
        with self.assertRaises(RegistryError):
            reviews.for_run(self.store, run)

    def test_api_exposes_current_review_and_records_explicit_decision(self):
        run = self.completed()
        with patch.object(pips, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {'type': 'get_pip_run', 'request_id': 'get', 'run_id': run}, 'reviewer', start_worker=False)
            self.assertEqual(response['result']['run']['execution_review']['revision'], 0)
            response = pips.handle_control(self.cfg, {'type': 'review_pip_execution', 'request_id': 'review',
                'run_id': run, 'status': 'dismissed', 'expected_revision': 0, 'reason': 'Insufficient fix'}, 'reviewer', start_worker=False)
            self.assertTrue(response['ok'], response)
            self.assertEqual(response['result']['review']['status'], 'dismissed')


if __name__ == '__main__':
    unittest.main()
