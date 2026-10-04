"""Real context CAS/rollback/replay through the production provenance validator."""
import copy
import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
import unittest
from unittest.mock import patch

from dgc import workspace_context as context
from dgc import workspace_registry
from dgc import workspace_session_execution as review
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_workspace_session_execution as fixtures
from tests.test_pips_local import config


class SessionExecutionRecordTests(unittest.TestCase):
    setUp = fixtures.SessionExecutionReadTests.setUp
    begin = fixtures.SessionExecutionReadTests.begin
    facts = fixtures.SessionExecutionReadTests.facts
    rows = fixtures.SessionExecutionReadTests.rows
    ready = fixtures.SessionExecutionReadTests.ready
    hub = fixtures.SessionExecutionReadTests.hub
    workspace = fixtures.SessionExecutionReadTests.workspace
    get = fixtures.SessionExecutionReadTests.get

    def args(self, **changes):
        receipt = self.get()['receipt']
        args = dict(workspace_id=self.workspace, attempt_id=receipt['id'],
                    expected_attempt_digest=receipt['attempt_digest'], expected_final_digest=receipt['final_digest'],
                    expected_view_digest=receipt['view_digest'], expected_context_revision=0, actor='human', config=self.cfg)
        args.update(changes)
        return args

    def context(self):
        return context.ContextStore(self.registry).get(self.workspace)

    def state(self):
        return {table: [tuple(row) for row in self.registry.db.execute('SELECT * FROM ' + table + ' ORDER BY rowid')]
                for table in ('workspace_context_entries', 'workspace_context_revisions', 'workspace_events',
                              'session_execution_attempts', 'session_execution_finals', 'pip_runs')}

    def test_record_is_real_context_with_exact_native_facts_and_no_execution(self):
        self.ready(text='tests passed; exit code: 0\n', code=7)
        args = self.args(); original = (self.root / 'source.py').read_bytes()
        runs_before = self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0]
        with patch('subprocess.Popen', side_effect=AssertionError('No command')), \
             patch.object(review.native, 'observe', side_effect=AssertionError('No source observation')):
            saved = self.hub.record(**args)
        self.assertFalse(saved['replayed']); self.assertEqual(saved['context']['revision'], 1)
        entry = saved['context']['entries'][0]
        self.assertEqual(entry['kind'], 'command')
        self.assertEqual(entry['provenance']['facts']['exit_code'], 7)
        self.assertNotIn('tests passed; exit code', json.dumps(saved))
        self.assertEqual(entry['provenance']['attempt_digest'], args['expected_attempt_digest'])
        self.assertEqual(saved['recording']['id'], entry['id'])
        pin = context.ContextStore(self.registry).snapshot(self.workspace)
        self.assertEqual(context.validate_snapshot(pin, self.workspace), pin)
        self.assertEqual((self.root / 'source.py').read_bytes(), original)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], runs_before)
        after = self.get()['receipt']
        self.assertFalse(after['can_record']); self.assertEqual(after['record_blocked_reason'], 'already_recorded')

    def test_exact_actor_bound_retry_never_recreates_an_archived_reference(self):
        self.ready(); args = self.args()
        saved = self.hub.record(**args)
        before = self.state()
        self.assertTrue(self.hub.record(**args)['replayed'])
        self.assertEqual(self.state(), before)
        with self.assertRaises(RegistryError):
            self.hub.record(**{**args, 'actor': 'different-human'})
        context.ContextStore(self.registry).archive(self.workspace, saved['recording']['id'], 1, 'human')
        before = self.state()
        replay = self.hub.record(**args)
        self.assertTrue(replay['replayed']); self.assertEqual(replay['recording']['status'], 'archived')
        self.assertEqual(replay['context']['entries'], []); self.assertEqual(replay['context']['revision'], 2)
        self.assertEqual(self.state(), before)
        self.assertTrue(self.get()['receipt']['can_record'])
        renewed = self.hub.record(**{**args, 'expected_context_revision': 2})
        self.assertFalse(renewed['replayed']); self.assertEqual(renewed['context']['revision'], 3)
        self.assertNotEqual(renewed['recording']['id'], saved['recording']['id'])

    def test_stale_context_digest_and_redacted_view_pins_refuse_without_writes(self):
        secret = 'a-future-credential-for-command-123456'
        self.cfg.data['verify_command'] = 'printf ' + secret
        self.ready(); args = self.args()
        for key in ('expected_attempt_digest', 'expected_final_digest', 'expected_view_digest'):
            before = self.state()
            with self.assertRaises(RegistryError):
                self.hub.record(**{**args, key: '0' * 64})
            self.assertEqual(self.state(), before)
        with patch.object(review, 'secret_values', return_value=(secret,)), self.assertRaisesRegex(RegistryError, 'displayed receipt changed'):
            self.hub.record(**args)
        self.assertEqual(self.context()['revision'], 0)
        context.ContextStore(self.registry).record(self.workspace, 'decision', 'Choice', 'A human decision', 0, 'human')
        before = self.state()
        with self.assertRaisesRegex(RegistryError, 'context changed'):
            self.hub.record(**args)
        self.assertEqual(self.state(), before)

    def test_two_connections_exact_retry_records_once(self):
        self.ready(); args = self.args(); barrier = Barrier(2)
        def write():
            with WorkspaceRegistry(self.registry.directory) as registry:
                barrier.wait(timeout=5)
                return review.SessionExecutionStore(registry).record(**args)
        with ThreadPoolExecutor(2) as pool:
            first, second = pool.submit(write), pool.submit(write)
            results = [first.result(timeout=10), second.result(timeout=10)]
        self.assertEqual(sorted(r['replayed'] for r in results), [False, True])
        self.assertEqual(self.context()['revision'], 1)
        self.assertEqual(len(self.context()['entries']), 1)

    def test_two_distinct_receipts_with_same_context_cas_do_not_both_record(self):
        self.ready(); first_args = self.args()
        self.ready(); second_args = self.args()
        barrier = Barrier(2)
        def write(args):
            with WorkspaceRegistry(self.registry.directory) as registry:
                barrier.wait(timeout=5)
                try:
                    return review.SessionExecutionStore(registry).record(**args)
                except RegistryError as error:
                    return error.code
        with ThreadPoolExecutor(2) as pool:
            first, second = pool.submit(write, first_args), pool.submit(write, second_args)
            results = [first.result(timeout=10), second.result(timeout=10)]
        self.assertEqual(sum(isinstance(v, dict) for v in results), 1)
        self.assertIn('context_conflict', results)
        self.assertEqual(self.context()['revision'], 1)

    def test_failure_after_context_insert_rolls_back_entry_revision_and_event(self):
        self.ready(); args = self.args(); before = self.state()
        with patch.object(self.registry, 'event', side_effect=RuntimeError('Injected event failure')), self.assertRaises(RuntimeError):
            self.hub.record(**args)
        self.assertEqual(self.state(), before)
        self.assertFalse(self.registry.db.in_transaction)

    def test_context_budget_failure_is_atomic(self):
        self.ready(); args = self.args(); before = self.state()
        with patch.object(context, 'MAX_ACTIVE_ENTRIES', 0), self.assertRaises(RegistryError):
            self.hub.record(**args)
        self.assertEqual(self.state(), before)

    def test_foreign_record_refused_before_prose_and_no_workspace_is_created(self):
        self.ready(); args = self.args()
        other = self.base / 'other'; other.mkdir()
        other_workspace = self.registry.resolve(other)['id']
        before = self.state()
        with patch.object(review, '_object', side_effect=AssertionError('No foreign prose')), self.assertRaises(RegistryError):
            self.hub.record(**{**args, 'workspace_id': other_workspace, 'config': config(other)})
        self.assertEqual(self.state(), before)

    def test_unfinalized_and_bad_cas_types_cannot_record(self):
        self.receipt = self.begin(); receipt = self.get()['receipt']
        args = dict(workspace_id=self.workspace, attempt_id=receipt['id'], expected_attempt_digest=receipt['attempt_digest'],
                    expected_final_digest='0' * 64, expected_view_digest=receipt['view_digest'], expected_context_revision=0,
                    actor='human', config=self.cfg)
        before = self.state()
        with self.assertRaisesRegex(RegistryError, 'Unfinalized'):
            self.hub.record(**args)
        for value in (True, None, -1, 1.0, '0'):
            with self.assertRaises(RegistryError):
                self.hub.record(**{**args, 'expected_context_revision': value})
        self.assertEqual(self.state(), before)

    def test_scope_binding_is_rechecked_at_record_time(self):
        self.ready(); args = self.args()
        moved = self.base / 'moved'; self.root.rename(moved)
        binding = self.registry.binding(self.workspace)
        self.registry.db.execute('UPDATE bindings SET canonical_root=? WHERE id=?', (str(moved), binding['id']))
        before = self.state()
        with self.assertRaises(RegistryError):
            self.hub.record(**args)
        self.assertEqual(self.state(), before)
        self.cfg.project_root = moved
        self.assertFalse(self.hub.record(**args)['replayed'])

    def test_missing_source_folder_does_not_prevent_explicit_historical_record(self):
        self.ready(); args = self.args()
        (self.root / 'source.py').unlink(); self.root.rmdir()
        with patch('pathlib.Path.resolve', side_effect=AssertionError('No source resolve')), \
             patch('pathlib.Path.stat', side_effect=AssertionError('No source stat')):
            self.assertFalse(self.hub.record(**args)['replayed'])

    def test_context_enclosing_workspace_and_manual_provenance_stay_closed(self):
        self.ready(); saved = self.hub.record(**self.args())
        entry = saved['context']['entries'][0]
        other = self.base / 'other'; other.mkdir(); other_workspace = self.registry.resolve(other)['id']
        changed = copy.deepcopy(saved['context']); changed['workspace_id'] = other_workspace
        with self.assertRaises(RegistryError):
            context._snapshot(changed)
        hub = context.ContextStore(self.registry)
        manual = hub.record(self.workspace, 'command', 'Manual', 'Run the existing command', 1, 'human')
        self.assertEqual(manual['entries'][-1]['provenance'], {'source': 'user_recorded', 'classification': 'user_record'})
        corrupt = copy.deepcopy(entry); corrupt['provenance']['source'] = 'user_recorded'
        with self.assertRaises(RegistryError):
            context._validate_provenance(corrupt)

    def test_new_sensitive_active_context_rolls_back_new_record_response(self):
        secret = 'credential-later-found-in-context-123456'
        hub = context.ContextStore(self.registry)
        hub.record(self.workspace, 'decision', 'Old decision', secret, 0, 'human')
        self.ready(); args = self.args(expected_context_revision=1); before = self.state()
        with patch.object(review, 'secret_values', return_value=(secret,)), self.assertRaisesRegex(RegistryError, 'additional redaction'):
            self.hub.record(**args)
        self.assertEqual(self.state(), before)

    def test_new_sensitive_preview_refuses_active_replay_but_archived_replay_remains_history(self):
        secret = 'credential-later-found-in-preview-123456'
        self.cfg.data['verify_command'] = 'printf ' + secret
        self.ready(); args = self.args(); saved = self.hub.record(**args)
        before = self.state()
        with patch.object(review, 'secret_values', return_value=(secret,)), self.assertRaisesRegex(RegistryError, 'additional redaction'):
            self.hub.record(**args)
        self.assertEqual(self.state(), before)
        context.ContextStore(self.registry).archive(self.workspace, saved['recording']['id'], 1, 'human')
        before = self.state()
        with patch.object(review, 'secret_values', return_value=(secret,)):
            replay = self.hub.record(**args)
        self.assertTrue(replay['replayed']); self.assertEqual(replay['recording']['status'], 'archived')
        self.assertEqual(replay['context']['entries'], []); self.assertEqual(self.state(), before)

    def test_schema_seventeen_is_interpretation_only_and_preserves_old_rows_and_snapshot(self):
        from dgc import session_turn_events, pip_memory_statements
        from tests.pip_test_migrations import drop_session_turn_schema
        self.ready()
        hub = context.ContextStore(self.registry)
        hub.record(self.workspace, 'command', 'Existing command', 'A manually recorded command', 0, 'human')
        old_pin = hub.snapshot(self.workspace)
        drop_session_turn_schema(self.registry.db)
        before = self.state()
        schema = [tuple(row) for row in self.registry.db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name')]
        self.registry.db.execute('PRAGMA user_version=16')
        # Exercise the historical interpretation-only transition specifically;
        # the separately tested schema18 adds its own table after this version.
        from dgc import pip_commit_paths, pip_setup, pip_app_actions, pip_message_drafts
        with patch.object(workspace_registry, 'SCHEMA_VERSION', 17), \
             patch.object(session_turn_events, 'SCHEMA', ''), \
             patch.object(pip_memory_statements, 'SCHEMA', ''), \
             patch.object(pip_commit_paths, 'SCHEMA_V22', ''), \
             patch.object(pip_setup, 'SCHEMA', ''), \
             patch.object(pip_app_actions, 'SCHEMA', ''), \
             patch.object(pip_message_drafts, 'SCHEMA', ''), \
             patch.object(pip_message_drafts, 'CALENDAR_SCHEMA', ''), \
             patch.object(pip_message_drafts, 'CONNECTOR_SCHEMA', ''), \
             WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0], 17)
            self.assertEqual(context.ContextStore(upgraded).snapshot(self.workspace), old_pin)
            self.assertEqual([tuple(row) for row in upgraded.db.execute('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY name')], schema)
            self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(), [])
        self.assertEqual(self.state(), before)

    def test_schema_sixteen_reader_refuses_the_new_interpretation_before_context_decode(self):
        self.ready(); self.hub.record(**self.args())
        before = self.state()
        with patch.object(workspace_registry, 'SCHEMA_VERSION', 16), \
             self.assertRaisesRegex(RegistryError, 'compatible DGC version'):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], workspace_registry.SCHEMA_VERSION)
        self.assertEqual(self.state(), before)


if __name__ == '__main__':
    unittest.main()
