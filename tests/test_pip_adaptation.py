"""Reviewed metadata authority, immutable versions and exact retry semantics."""
import json
import sqlite3
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from dgc import pip_adaptation, pips, workspace_registry
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class AdaptationTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    create = fixtures.LocalPipsTests.create

    def reviewed(self, pip=None, mode='bounded_adaptive', fields=None, **other):
        pip = pip or self.create()
        fields = fields if fields is not None else (['name', 'source_ref'] if mode == 'autonomous' else ['name'] if mode == 'bounded_adaptive' else [])
        proposal = self.store.propose(pip['id'], pip['current_version'],
            {'adaptation_policy': {'mode': mode, 'allowed_fields': fields}, **other}, 'human', 'Reviewed scope')
        return self.store.accept(pip['id'], proposal['id'], pip['current_version'], 'human')

    def adapt(self, pip, changes=None, key='metadata-one', version=None, store=None, session='main-chat'):
        self.registry.associate_session(session, self.root)
        return (store or self.store).adapt(pip['id'], version or pip['current_version'], changes or {'name': 'Source reviewer'},
            'The name now reflects the reviewed task.', origin_session_id=session, request_key=key,
            expected_workspace_id=pip['workspace_id'])

    def test_canonical_modes_and_hostile_policies(self):
        for mode in pip_adaptation.MODES:
            fields = ['name'] if mode == 'bounded_adaptive' else ['name', 'source_ref'] if mode == 'autonomous' else []
            self.assertEqual(pip_adaptation.policy({'mode': mode, 'allowed_fields': fields})['mode'], mode)
        for value in (None, True, [], {}, 'bogus', 'bounded_adaptive',
                      {'mode': 'bounded_adaptive', 'allowed_fields': []},
                      {'mode': 'bounded_adaptive', 'allowed_fields': ['name', 'name']},
                      {'mode': 'bounded_adaptive', 'allowed_fields': ['goal']},
                      {'mode': 'autonomous', 'allowed_fields': ['name']},
                      {'mode': 'locked', 'allowed_fields': ['source_ref']},
                      {'mode': 'autonomous', 'allowed_fields': ['name', 'source_ref'], 'shell': True}):
            with self.subTest(value=value), self.assertRaises(RegistryError):
                pip_adaptation.policy(value)

    def test_no_automatic_authority_before_explicit_human_approval(self):
        pip = self.create()
        with self.assertRaisesRegex(RegistryError, 'reviewed adaptation policy'):
            self.adapt(pip)
        proposed = self.store.propose(pip['id'], 1, {'adaptation_policy': {'mode': 'autonomous', 'allowed_fields': ['name', 'source_ref']}}, 'human')
        with self.assertRaises(RegistryError):
            self.adapt(pip)
        self.store.reject(pip['id'], proposed['id'], 1, 'human')
        with self.assertRaises(RegistryError):
            self.adapt(pip)
        self.assertEqual(self.store.get(pip['id'])['current_version'], 1)
        self.assertEqual(self.store.adaptations(pip['id'])['adaptations'], [])

    def test_locked_and_context_modes_refuse_model_changes_but_allow_human_review(self):
        for mode in ('locked', 'context_adaptive'):
            pip = self.reviewed(mode=mode)
            with self.assertRaises(RegistryError):
                self.adapt(pip)
            with self.assertRaisesRegex(RegistryError, 'does not allow model proposals'):
                self.store.propose(pip['id'], 2, {'goal': 'Model wants a new goal'}, 'core_proposal',
                    origin_session_id='main-chat', request_key=mode, expected_workspace_id=pip['workspace_id'])
            proposal = self.store.propose(pip['id'], 2, {'goal': 'User requests another task'}, 'human')
            updated = self.store.accept(pip['id'], proposal['id'], 2, 'human')
            self.assertEqual(updated['goal'], 'User requests another task')
            self.assertEqual(updated['adaptation_policy']['mode'], mode)

    def test_authorized_edit_is_immutable_attributed_and_does_not_enqueue(self):
        pip = self.reviewed()
        before_approvals = self.registry.db.execute('SELECT count(*) FROM pip_approvals').fetchone()[0]
        first = self.adapt(pip)
        record = first['adaptation']
        self.assertEqual((record['from_version'], record['to_version'], record['policy_version']), (2, 3, 2))
        self.assertTrue(first['job_changed_by_this_call'])
        self.assertFalse(first['execution_started'])
        self.assertEqual(record['policy'], pip['adaptation_policy'])
        self.assertNotIn('origin_session_id', record)
        self.assertNotIn('request_key', record)
        job = self.store.get(pip['id'])
        for key in ('goal', 'source_ref', 'pip_type', 'model_choice', 'policy', 'status', 'adaptation_policy'):
            self.assertEqual(job[key], pip[key])
        self.assertEqual(job['name'], 'Source reviewer')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_approvals').fetchone()[0], before_approvals)
        for sql in ('UPDATE pip_adaptations SET reason=\'rewrite\'', 'DELETE FROM pip_adaptations'):
            with self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute(sql)

    def test_safe_allowlist_protected_fields_and_noncanonical_source(self):
        pip = self.reviewed()
        for changes in ({'source_ref': 'main'}, {'goal': 'New goal'}, {'model_choice': {'mode': 'default'}},
                        {'schedule': None}, {'event_trigger': None}, {'policy': 'write'}, {'pip_type': 'patch'},
                        {'adaptation_policy': 'autonomous'}, {'name': '\ud800'}, {'name': 'x' * 121},
                        {'name': 'injected\x00control'}):
            with self.subTest(changes=changes), self.assertRaises(RegistryError):
                self.adapt(pip, changes)
        pip = self.reviewed(pip, 'autonomous')
        for ref in ('../main', 'HEAD;touch /tmp/no', '-option', 'HEAD\nmain'):
            with self.assertRaises(RegistryError):
                self.adapt(pip, {'source_ref': ref})
        result = self.adapt(pip, {'source_ref': 'main'})
        self.assertEqual(result['adaptation']['changes'], {'source_ref': 'main'})

    def test_schedule_cursor_and_paused_state_remain_unchanged(self):
        pip = self.reviewed(schedule={'type': 'interval', 'minutes': 60})
        self.store.set_paused(pip['id'], True, 'human')
        before = dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?', (pip['id'],)).fetchone())
        self.adapt(pip)
        after = dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?', (pip['id'],)).fetchone())
        self.assertEqual(after, {**before, 'job_version': 3})
        self.assertEqual(self.store.get(pip['id'])['status'], 'paused')

    def test_exact_retry_survives_later_versions_and_policy_revocation(self):
        pip = self.reviewed()
        first = self.adapt(pip)
        current = self.store.get(pip['id'])
        self.reviewed(current, 'locked')
        retry = self.adapt(pip)
        self.assertEqual(first['adaptation'], retry['adaptation'])
        self.assertTrue(retry['replayed'])
        self.assertFalse(retry['job_changed_by_this_call'])
        self.assertEqual(self.store.get(pip['id'])['current_version'], 4)
        with self.assertRaisesRegex(RegistryError, 'different request'):
            self.adapt(pip, {'name': 'Different'})
        with self.assertRaisesRegex(RegistryError, 'changed'):
            self.adapt(pip, key='new-key')

    def test_autonomous_proposals_remain_pending_and_queued_runs_stay_pinned(self):
        pip = self.reviewed(mode='autonomous')
        self.registry.associate_session('main-chat', self.root)
        proposal = self.store.propose(pip['id'], 2, {'goal':'A suggested new purpose'}, 'core_proposal',
            origin_session_id='main-chat', request_key='propose-only', expected_workspace_id=pip['workspace_id'])
        self.assertEqual(proposal['status'], 'proposed')
        self.assertEqual(self.store.get(pip['id'])['goal'], pip['goal'])
        with patch.object(pips, 'source_revision', return_value='a' * 40), patch.object(pips, '_require_runner_platform'):
            queued = self.store.enqueue(pip['id'], 'queued-before-adapt', 'human', self.cfg)
        self.adapt(pip)
        saved = self.store.run(queued['id'])
        self.assertEqual(saved['status'], 'queued')
        self.assertEqual(saved['manifest'], queued['manifest'])
        self.assertEqual(saved['manifest']['job_version'], 2)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 1)

    def test_noop_and_corrupt_schedule_cas_roll_back_everything(self):
        pip = self.reviewed(schedule={'type': 'interval', 'minutes': 60})
        with self.assertRaisesRegex(RegistryError, 'already matches'):
            self.adapt(pip, {'name': pip['name']})
        self.registry.db.execute('UPDATE pip_schedule_state SET job_version=1 WHERE pip_id=?', (pip['id'],))
        with self.assertRaisesRegex(RegistryError, 'schedule cursor'):
            self.adapt(pip)
        self.assertEqual(self.store.get(pip['id'])['current_version'], 2)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_adaptations').fetchone()[0], 0)
        self.assertEqual(len(self.store.versions(pip['id'])['versions']), 2)

    def test_missing_human_authority_refused_even_with_forged_policy_definition(self):
        pip = self.create()
        definition = pips._definition(pip['name'], pip['goal'], adaptation_policy='autonomous')
        self.registry.db.execute('INSERT INTO pip_versions VALUES(?,?,?,?,?,?)',
            (pip['id'], 2, json.dumps(definition), 'manual-import', 'No review', self.registry.clock()))
        self.registry.db.execute('UPDATE pips SET current_version=2 WHERE id=?', (pip['id'],))
        with self.assertRaisesRegex(RegistryError, 'no matching human approval'):
            self.adapt(self.store.get(pip['id']))

    def test_scope_authority_and_pending_review_supersession(self):
        pip = self.reviewed()
        other = self.base / 'other'; other.mkdir()
        self.registry.associate_session('elsewhere', other)
        with patch.object(self.store, '_job', side_effect=AssertionError('Do not decode foreign definition')):
            with self.assertRaisesRegex(RegistryError, 'belong to this workspace'):
                self.store.adapt(pip['id'], 2, {'name': 'x'}, 'reason', origin_session_id='elsewhere', request_key='k', expected_workspace_id=pip['workspace_id'])
        proposal = self.store.propose(pip['id'], 2, {'goal': 'Still pending'}, 'human')
        self.adapt(pip)
        row = self.registry.db.execute('SELECT status FROM pip_approvals WHERE id=?', (proposal['approval_id'],)).fetchone()
        self.assertEqual(row[0], 'superseded')
        with self.assertRaises(RegistryError):
            self.store.accept(pip['id'], proposal['id'], 2, 'human')

    def test_history_is_durable_paginated_and_private(self):
        pip = self.reviewed()
        seen_ids = []
        for i in range(5):
            result = self.adapt(self.store.get(pip['id']), {'name': 'Review ' + str(i)}, key='key-' + str(i))
            seen_ids.append(result['adaptation']['id'])
        with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as reopened:
            store = pips.PipStore(reopened)
            first = store.adaptations(pip['id'], limit=2)
            second = store.adaptations(pip['id'], first['next_before_id'], 2)
            third = store.adaptations(pip['id'], second['next_before_id'], 2)
            self.assertEqual([r['id'] for p in (first,second,third) for r in p['adaptations']], seen_ids[::-1])
            self.assertIsNone(third['next_before_id'])
        with self.assertRaises(RegistryError):
            self.store.adaptations(self.create()['id'], seen_ids[0])
        for limit in (True, 0, 51, '2'):
            with self.assertRaises(RegistryError):
                self.store.adaptations(pip['id'], limit=limit)

    def test_concurrent_exact_retries_create_one_version(self):
        pip = self.reviewed()
        self.registry.associate_session('main-chat', self.root)
        barrier = threading.Barrier(2)
        def one():
            with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as registry:
                barrier.wait(timeout=5)
                return pips.PipStore(registry).adapt(pip['id'], 2, {'name': 'Concurrent'}, 'Same request',
                    origin_session_id='main-chat', request_key='retry', expected_workspace_id=pip['workspace_id'])
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: one(), range(2)))
        self.assertEqual({r['replayed'] for r in results}, {True,False})
        self.assertEqual(len({r['adaptation']['id'] for r in results}), 1)
        self.assertEqual(self.store.get(pip['id'])['current_version'], 3)

    def test_event_cursor_and_commit_observation_preserve_authority(self):
        pip = self.reviewed(mode='autonomous', event_trigger={'events':['commit_changed'], 'minimum_minutes':5})
        self.registry.db.execute("UPDATE pip_commit_observations SET revision=?,last_checked_at=?,observed_changes=2 WHERE pip_id=?",
                                 ('a' * 40, self.registry.clock(), pip['id']))
        cursor = dict(self.registry.db.execute('SELECT * FROM pip_event_trigger_state WHERE pip_id=?', (pip['id'],)).fetchone())
        observer = dict(self.registry.db.execute('SELECT * FROM pip_commit_observations WHERE pip_id=?', (pip['id'],)).fetchone())
        with patch('dgc.pip_event_triggers.reset_trigger', side_effect=AssertionError('Do not rearm triggers')):
            self.adapt(pip)
        current = self.store.get(pip['id'])
        self.assertEqual(current['event_trigger'], pip['event_trigger'])
        self.assertEqual(dict(self.registry.db.execute('SELECT * FROM pip_event_trigger_state WHERE pip_id=?', (pip['id'],)).fetchone()), {**cursor,'job_version':3})
        self.assertEqual(dict(self.registry.db.execute('SELECT * FROM pip_commit_observations WHERE pip_id=?', (pip['id'],)).fetchone()), {**observer,'job_version':3})
        self.adapt(current, {'source_ref':'main'}, key='source-change')
        changed = dict(self.registry.db.execute('SELECT * FROM pip_commit_observations WHERE pip_id=?', (pip['id'],)).fetchone())
        self.assertIsNone(changed['revision'])
        self.assertIsNone(changed['last_checked_at'])
        self.assertEqual(changed['observed_changes'], 2)
        self.assertEqual(dict(self.registry.db.execute('SELECT * FROM pip_event_trigger_state WHERE pip_id=?', (pip['id'],)).fetchone()), {**cursor,'job_version':4})
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM workspace_events WHERE event_type='workspace_commit_changed'").fetchone()[0], 0)

    def test_archive_cap_and_midtransaction_failure_leave_no_version(self):
        pip = self.reviewed()
        with patch.object(pip_adaptation, 'MAX_RECORDS', 0), self.assertRaisesRegex(RegistryError, 'archive is full'):
            self.adapt(pip)
        with patch('dgc.pip_commit_detector.reset_observation', side_effect=RuntimeError('Injected observer failure')):
            with self.assertRaisesRegex(RuntimeError, 'Injected'):
                self.adapt(pip)
        self.assertEqual(self.store.get(pip['id'])['current_version'], 2)
        self.assertEqual(self.store.adaptations(pip['id'])['adaptations'], [])

    def test_corrupt_history_refuses_bounded_rows_without_reflecting_input(self):
        pip = self.reviewed()
        self.adapt(pip)
        self.registry.db.execute('DROP TRIGGER immutable_pip_adaptation')
        for raw in ('x' * 5000, '{broken', '{"goal":"unreviewed"}', '{"name":"\\ud800"}'):
            self.registry.db.execute('UPDATE pip_adaptations SET changes=? WHERE pip_id=?', (raw, pip['id']))
            with self.assertRaises(RegistryError) as caught:
                self.store.adaptations(pip['id'])
            self.assertNotIn(raw, str(caught.exception))

    def test_concurrent_different_requests_use_compare_and_swap(self):
        pip = self.reviewed()
        self.registry.associate_session('main-chat', self.root)
        barrier = threading.Barrier(2)
        def one(index):
            with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as registry:
                barrier.wait(timeout=5)
                try:
                    return pips.PipStore(registry).adapt(pip['id'], 2, {'name': 'Choice ' + str(index)}, 'Competing request',
                        origin_session_id='main-chat', request_key='choice-' + str(index), expected_workspace_id=pip['workspace_id'])
                except RegistryError as error:
                    return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(one, range(2)))
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertIn('conflict', results)
        self.assertEqual(self.store.get(pip['id'])['current_version'], 3)
        self.assertEqual(len(self.store.adaptations(pip['id'])['adaptations']), 1)

    def test_schema8_upgrade_and_failed_migration_rollback(self):
        pip = self.create()
        from tests.pip_test_migrations import drop_archive_schema
        drop_archive_schema(self.registry.db)
        for table in ('pip_memories', 'pip_notifications', 'pip_notification_seen', 'pip_notification_state'):
            self.registry.db.execute('DROP TABLE '+table)
        self.registry.db.execute('DROP TABLE IF EXISTS pip_lifecycle_requests')
        self.registry.db.execute('DROP TABLE IF EXISTS workspace_session_outcomes')
        self.registry.db.execute('DROP TABLE IF EXISTS session_pip_attachments')
        self.registry.db.execute('DROP TABLE IF EXISTS pip_commit_observations')
        self.registry.db.execute('DROP TABLE IF EXISTS pip_event_trigger_state')
        self.registry.db.execute('DROP INDEX IF EXISTS pip_event_source')
        self.registry.db.execute('DROP TABLE pip_adaptations')
        # Later schemas may be present; this fixture rewinds only the adaptation migration.
        self.registry.db.execute('PRAGMA user_version=8')
        original = workspace_registry._execute_schema
        def failure(db, sql):
            original(db, sql)
            if sql == pip_adaptation.SCHEMA:
                raise RuntimeError('Injected adaptation migration failure')
        with patch.object(workspace_registry, '_execute_schema', failure), self.assertRaisesRegex(RuntimeError, 'Injected'):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 8)
        self.assertIsNone(self.registry.db.execute("SELECT name FROM sqlite_master WHERE name='pip_adaptations'").fetchone())
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(pips.PipStore(reopened).get(pip['id'])['name'], pip['name'])
            self.assertEqual(reopened.db.execute('PRAGMA user_version').fetchone()[0], workspace_registry.SCHEMA_VERSION)


if __name__ == '__main__':
    unittest.main()
