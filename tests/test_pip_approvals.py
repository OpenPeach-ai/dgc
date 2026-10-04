"""Deterministic persisted reviews: no provider, real clock waits or live state."""
import json
import sqlite3
import unittest
from unittest.mock import patch

from dgc import pip_approvals, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class DurableReviewTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    create = fixtures.LocalPipsTests.create

    def proposal(self, **kwargs):
        pip = kwargs.pop('pip', None) or self.create()
        return self.store.propose(pip['id'], pip['current_version'], kwargs.pop('changes', {'goal': 'Inspect authorization'}),
                                  kwargs.pop('actor', 'human'), **kwargs)

    def review(self, proposal, accept=True):
        return (self.store.accept if accept else self.store.reject)(proposal['pip_id'], proposal['id'], proposal['expected_version'], 'reviewer')

    def test_pending_review_survives_reopen_and_does_not_change_job(self):
        proposal = self.proposal()
        with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as reopened:
            store = pips.PipStore(reopened)
            self.assertEqual(store.get(proposal['pip_id'])['current_version'], 1)
            saved = store.get(proposal['pip_id'])['proposals'][0]
            self.assertEqual(saved['approval_id'], proposal['approval_id'])
            record = store.approvals(proposal['pip_id'])['approvals'][0]
            self.assertEqual(record['status'], 'pending')
            self.assertEqual(record['expires_at'], '2026-10-08T10:00:00.000Z')
            self.assertNotIn('session_id', record)

    def test_review_is_once_only_with_actor_and_timestamp(self):
        proposal = self.proposal()
        self.review(proposal)
        record = self.store.approvals(proposal['pip_id'])['approvals'][0]
        self.assertEqual((record['status'], record['resolved_by'], record['resolved_at']),
                         ('approved', 'reviewer', self.registry.clock()))
        for accept in (True, False):
            with self.assertRaises(RegistryError):
                self.review(proposal, accept)
        self.assertEqual(len(self.store.versions(proposal['pip_id'])['versions']), 2)

    def test_expiry_at_deadline_refuses_apply_and_persists_terminal_state(self):
        proposal = self.proposal()
        self.registry.clock = lambda: proposal['expires_at']
        with self.assertRaises(RegistryError):
            self.review(proposal)
        self.assertEqual(self.store.approvals(proposal['pip_id'])['approvals'][0]['status'], 'expired')
        self.assertEqual(self.store.get(proposal['pip_id'])['proposals'], [])
        self.assertEqual(self.store.get(proposal['pip_id'])['current_version'], 1)

    def test_accept_supersedes_other_reviews_of_previous_version(self):
        pip = self.create()
        first = self.proposal(pip=pip)
        second = self.proposal(pip=pip, changes={'name': 'Alternative'})
        self.review(second)
        statuses = {row['proposal_id']: row['status'] for row in self.store.approvals(pip['id'])['approvals']}
        self.assertEqual(statuses, {first['id']: 'superseded', second['id']: 'approved'})
        with self.assertRaises(RegistryError):
            self.review(first)

    def test_expiry_boundary_uses_one_decision_instant_under_write_lock(self):
        proposal = self.proposal()
        first = '2026-10-08T09:59:59.999Z'
        clock = iter([first, proposal['expires_at']])
        self.registry.clock = lambda: next(clock, proposal['expires_at'])
        self.review(proposal)
        review = self.store.approvals(proposal['pip_id'])['approvals'][0]
        self.assertEqual(review['resolved_at'], first)
        self.assertLess(review['resolved_at'], review['expires_at'])

    def test_reject_preserves_definition_and_does_not_arm_schedule(self):
        proposal = self.proposal(changes={'schedule': {'type': 'interval', 'minutes': 60}})
        self.review(proposal, False)
        pip = self.store.get(proposal['pip_id'])
        self.assertEqual(pip['current_version'], 1)
        self.assertIsNone(pip['schedule_state'])
        self.assertEqual(self.store.approvals(pip['id'])['approvals'][0]['status'], 'rejected')

    def test_review_and_schedule_cursor_commit_or_rollback_together(self):
        proposal = self.proposal(changes={'schedule': {'type': 'interval', 'minutes': 60}})
        with patch('dgc.pip_schedules.reset_schedule', side_effect=RuntimeError('injected write failure')):
            with self.assertRaisesRegex(RuntimeError, 'injected'):
                self.review(proposal)
        pip = self.store.get(proposal['pip_id'])
        self.assertEqual(pip['current_version'], 1)
        self.assertIsNone(pip['schedule_state'])
        self.assertEqual(self.store.approvals(pip['id'])['approvals'][0]['status'], 'pending')
        self.review(proposal)
        self.assertEqual(self.store.get(pip['id'])['schedule_state']['next_due_at'], '2026-10-01T11:00:00.000Z')

    def test_retry_same_model_request_is_idempotent_after_user_review(self):
        pip = self.create()
        self.registry.associate_session('session-one', self.root)
        args = dict(origin_session_id='session-one', request_key='draft-1', expected_workspace_id=pip['workspace_id'])
        first = self.store.propose(pip['id'], 1, {'goal': 'Model suggestion'}, 'core_proposal', **args)
        self.review(first)
        retry = self.store.propose(pip['id'], 1, {'goal': 'Model suggestion'}, 'core_proposal', **args)
        self.assertEqual(retry['id'], first['id'])
        self.assertEqual(retry['approval_status'], 'approved')
        with self.assertRaisesRegex(RegistryError, 'different content'):
            self.store.propose(pip['id'], 1, {'goal': 'Different'}, 'core_proposal', **args)

    def test_model_cannot_schedule_or_use_another_session_workspace(self):
        pip = self.create()
        self.registry.associate_session('session-one', self.root)
        args = dict(origin_session_id='session-one', request_key='draft-1', expected_workspace_id=pip['workspace_id'])
        with self.assertRaises(RegistryError):
            self.store.propose(pip['id'], 1, {'schedule': {'type': 'interval', 'minutes': 5}}, 'core_proposal', **args)
        other = self.base / 'other'; other.mkdir()
        self.registry.associate_session('session-other', other)
        args['origin_session_id'] = 'session-other'
        with self.assertRaisesRegex(RegistryError, 'not associated'):
            self.store.propose(pip['id'], 1, {'goal': 'Wrong workspace'}, 'core_proposal', **args)
        self.assertEqual(self.store.get(pip['id'])['proposals'], [])

    def test_identical_model_retry_after_expiry_reports_expired(self):
        pip = self.create()
        self.registry.associate_session('session-one', self.root)
        args = dict(origin_session_id='session-one', request_key='draft-1', expected_workspace_id=pip['workspace_id'])
        first = self.store.propose(pip['id'], 1, {'goal': 'Model suggestion'}, 'core_proposal', **args)
        self.registry.clock = lambda: first['expires_at']
        retry = self.store.propose(pip['id'], 1, {'goal': 'Model suggestion'}, 'core_proposal', **args)
        self.assertEqual(retry['id'], first['id'])
        self.assertEqual(retry['status'], 'expired')
        self.assertEqual(retry['approval_status'], 'expired')

    def test_saved_request_and_review_content_are_immutable(self):
        proposal = self.proposal()
        for query, args in [
            ('UPDATE pip_proposals SET definition=? WHERE id=?', ('{}', proposal['id'])),
            ('UPDATE pip_approvals SET expires_at=? WHERE id=?', ('2099-01-01T00:00:00.000Z', proposal['approval_id'])),
        ]:
            with self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute(query, args)
        self.review(proposal)
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute("UPDATE pip_approvals SET status='pending' WHERE id=?", (proposal['approval_id'],))

    def test_history_cursor_belongs_to_job_and_tied_timestamps_page_without_gaps(self):
        pip = self.create()
        ids = {self.proposal(pip=pip, changes={'name': 'Choice ' + str(n)})['approval_id'] for n in range(5)}
        seen = []
        cursor = None
        while True:
            page = self.store.approvals(pip['id'], cursor, 2)
            seen.extend(row['id'] for row in page['approvals'])
            cursor = page['next_before_id']
            if cursor is None:
                break
        self.assertEqual(len(seen), 5)
        self.assertEqual(set(seen), ids)
        with self.assertRaises(RegistryError):
            self.store.approvals(self.create()['id'], seen[0])
        for limit in (True, 0, 21, '2'):
            with self.assertRaises(RegistryError):
                self.store.approvals(pip['id'], limit=limit)

    def test_legacy_proposals_migrate_preserving_exact_saved_definition(self):
        # Separate v2 fixture: migration creates pending records, never accepts them.
        from dgc import workspace_registry as registry_module
        directory = self.base / 'legacy'; directory.mkdir()
        definition = pips._definition('Legacy', 'Original')
        with sqlite3.connect(directory / 'registry.sqlite3') as db:
            registry_module._execute_schema(db, registry_module._SCHEMA_V1)
            registry_module._execute_schema(db, registry_module._SCHEMA_V2)
            db.execute("INSERT INTO metadata VALUES('runner_id','runner-legacy')")
            db.execute("INSERT INTO workspaces VALUES('ws','Legacy','git','2026-10-01T10:00:00.000Z','2026-10-01T10:00:00.000Z')")
            db.execute("INSERT INTO pips VALUES('pip','ws','active',1,'2026-10-01T10:00:00.000Z','2026-10-01T10:00:00.000Z')")
            db.execute('INSERT INTO pip_versions VALUES(?,?,?,?,?,?)', ('pip',1,json.dumps(definition),'user','','2026-10-01T10:00:00.000Z'))
            db.execute('INSERT INTO pip_proposals VALUES(?,?,?,?,?,?,?,?)', ('proposal','pip',1,json.dumps(definition),'model','Original reason','proposed','2026-10-01T10:00:00.000Z'))
            db.execute('PRAGMA user_version=2')
        with WorkspaceRegistry(directory, clock=self.registry.clock) as upgraded:
            self.assertEqual(upgraded.runner_id, 'runner-legacy')
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0], registry_module.SCHEMA_VERSION)
            record = pips.PipStore(upgraded).approvals('pip')['approvals'][0]
            self.assertEqual(record['status'], 'pending')
            self.assertEqual(upgraded.db.execute('SELECT definition FROM pip_proposals').fetchone()[0], json.dumps(definition))


if __name__ == '__main__':
    unittest.main()
