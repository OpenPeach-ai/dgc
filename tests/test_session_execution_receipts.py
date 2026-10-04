"""Offline controller provenance and hostile source/output receipt boundaries."""
import copy
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import session_execution_receipts as receipts
from dgc.workspace_registry import WorkspaceRegistry, _execute_schema
from tests.test_pips_local import config
from tests.pip_test_profile import pips_in_use


class ExecutionReceiptTests(unittest.TestCase):
    def setUp(self):
        pips_in_use(self)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'workspace'; self.root.mkdir()
        (self.root / 'source.py').write_text('value = 1\n')
        self.cfg = config(self.root, verify_command='printf checked', pips_enabled=True)
        self.registry = WorkspaceRegistry(self.base / 'private')
        self.addCleanup(self.registry.close)
        if not self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='session_execution_attempts'").fetchone():
            with self.registry.transaction():
                _execute_schema(self.registry.db, receipts.SCHEMA)
        identity = self.registry.associate_session('chat-one', self.root)
        self.origin = {'session_id': 'chat-one', 'workspace_id': identity['workspace_id']}
        self.turn = 'turn_' + 'a' * 32
        self.notices = []
        self.opener = patch.object(receipts, 'WorkspaceRegistry', lambda directory=None: WorkspaceRegistry(directory or self.registry.directory))
        self.opener.start(); self.addCleanup(self.opener.stop)

    def begin(self, **kwargs):
        return receipts.begin(self.cfg, self.origin, self.cfg.get('verify_command'), self.turn,
                              notify=self.notices.append, **kwargs)

    def rows(self, table):
        return [json.loads(row[0]) for row in self.registry.db.execute('SELECT body FROM ' + table)]

    def facts(self, receipt, text='checked\n', code=0, state='exited'):
        native = receipts.NativeFacts(receipt)
        native.started(); native.feed_safe(text)
        native.complete(state, code, output_complete=True)
        return self.rows('session_execution_finals')[-1]

    def test_native_exit_not_output_claim_is_recorded_once(self):
        receipt = self.begin(); self.assertIsNotNone(receipt)
        final = self.facts(receipt, 'exit code: 0\ntests passed', code=7)
        self.assertEqual(final['facts']['exit_code'], 7)
        self.assertEqual(final['source_comparison'], 'unchanged_observation')
        self.assertEqual(receipt.attempt['source_relation'], 'observed_before_and_after_not_execution_attestation')
        self.assertNotIn('source_revision', receipt.attempt)
        self.assertTrue(receipt.complete(final['facts']))
        self.assertFalse(receipt.complete({**final['facts'], 'exit_code': 0}))
        self.assertEqual(len(self.rows('session_execution_finals')), 1)

    def test_attempt_precedes_launch_and_has_no_inferred_final(self):
        receipt = self.begin()
        self.assertEqual(self.rows('session_execution_attempts')[0]['id'], receipt.attempt['id'])
        self.assertEqual(self.rows('session_execution_finals'), [])
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(reopened.db.execute('SELECT count(*) FROM session_execution_finals').fetchone()[0], 0)

    def test_changed_source_is_observation_not_committed_attestation(self):
        receipt = self.begin()
        (self.root / 'source.py').write_text('value = 2\n')
        final = self.facts(receipt)
        self.assertEqual(final['source_comparison'], 'changed_observation')
        self.assertNotEqual(final['source_after']['sha256'], receipt.attempt['source_before']['sha256'])

    def test_denied_and_asked_read_never_scan_source(self):
        for action in ('deny', 'ask'):
            self.cfg.permissions = {action: ['Read(private/**)']}
            with patch.object(receipts.tree, '_scan', side_effect=AssertionError('No inventory access')):
                receipt = self.begin(mode='auto')
                self.assertIsNotNone(receipt)
                self.assertEqual(receipt.attempt['source_before'], {'status': 'unavailable', 'reason': 'source_permissions'})

    def test_denied_read_added_after_launch_preserves_actual_exit_only(self):
        receipt = self.begin()
        self.cfg.permissions = {'deny': ['Read(**)']}
        final = self.facts(receipt)
        self.assertEqual(final['source_comparison'], 'unavailable')
        self.assertEqual(final['facts']['exit_code'], 0)

    def test_links_special_and_oversize_source_are_unavailable(self):
        bad = self.root / 'bad'
        for create in (lambda: bad.symlink_to('source.py'), lambda: os.link(self.root / 'source.py', bad),
                       lambda: os.mkfifo(bad), lambda: bad.write_bytes(b'x' * (receipts.tree.MAX_FILE_BYTES + 1))):
            create()
            try:
                receipt = self.begin()
                self.assertEqual(receipt.attempt['source_before']['status'], 'unavailable')
            finally:
                bad.unlink()

    def test_configured_secret_source_and_command_are_not_saved(self):
        secret = 'secret-value-1234567890'
        with patch.object(receipts, 'secret_values', return_value=[secret]):
            (self.root / 'source.py').write_text(secret)
            receipt = self.begin()
            self.assertEqual(receipt.attempt['source_before']['reason'], 'secret_in_source')
            self.cfg.data['verify_command'] = 'echo ' + secret
            self.assertIsNone(self.begin())
        self.assertNotIn(secret, json.dumps(self.rows('session_execution_attempts')))

    def test_exclusions_do_not_copy_or_name_secret_file(self):
        (self.root / '.env').write_text('PRIVATE=not-for-context')
        receipt = self.begin()
        self.assertEqual(receipt.attempt['source_before']['excluded_entries'], 1)
        self.assertEqual(receipt.attempt['source_before']['files'], 1)
        serialized = json.dumps(receipt.attempt)
        self.assertNotIn('PRIVATE', serialized)
        self.assertNotIn('.env', serialized)

    def test_disabled_and_restricted_do_not_open_registry(self):
        with patch.object(receipts, 'WorkspaceRegistry', side_effect=AssertionError('No registry')):
            self.cfg.data['pips_enabled'] = False
            self.assertIsNone(self.begin())
            self.cfg.data['pips_enabled'] = True
            with patch.object(receipts, 'restricted', return_value=True):
                self.assertIsNone(self.begin())

    def test_wrong_scope_and_malformed_command_refuse_receipt(self):
        self.origin['workspace_id'] = 'ws_' + 'b' * 32
        self.assertIsNone(self.begin())
        for command in ('x' * 8193, '\ud800', 'a\0b'):
            self.cfg.data['verify_command'] = command
            self.assertIsNone(self.begin())
        self.assertEqual(self.rows('session_execution_attempts'), [])

    def test_source_capture_changes_are_unavailable_without_command_claim(self):
        real = receipts.tree._read
        def change(*args, **kwargs):
            real(*args, **kwargs)
            (self.root / 'source.py').write_text('changed while capturing')
        with patch.object(receipts.tree, '_read', side_effect=change):
            receipt = self.begin()
        self.assertEqual(receipt.attempt['source_before']['reason'], 'source_changed')

    def test_bounded_multibyte_output_hashes_all_redacted_text(self):
        receipt = self.begin()
        text = '🌱' * 10000
        final = self.facts(receipt, text)
        facts = final['facts']
        self.assertEqual(facts['output_sha256'], hashlib.sha256(text.encode()).hexdigest())
        self.assertEqual(facts['output_bytes'], 40000)
        self.assertLessEqual(facts['preview_bytes'], 4096)
        self.assertEqual(facts['preview_bytes'] + facts['omitted_bytes'], 40000)

    def test_failed_start_cancel_timeout_are_never_exited(self):
        for state, code in [('failed_to_start', None), ('cancelled', -15), ('timed_out', -9)]:
            receipt = self.begin(); native = receipts.NativeFacts(receipt)
            if state != 'failed_to_start':
                native.started()
            self.assertTrue(native.complete(state, code, output_complete=True))
            self.assertEqual(self.rows('session_execution_finals')[-1]['facts']['state'], state)

    def test_insert_failure_reports_receipt_unavailable_not_command_status(self):
        with patch.object(receipts, 'MAX_ATTEMPTS', 0):
            self.assertIsNone(self.begin())
        self.assertIn('will still run normally', self.notices[-1])
        receipt = self.begin()
        with patch.object(receipts, 'WorkspaceRegistry', side_effect=OSError('private secret path')):
            native = receipts.NativeFacts(receipt); native.started()
            self.assertFalse(native.complete('exited', 0, output_complete=True))
        self.assertNotIn('secret path', self.notices[-1])
        self.assertEqual(self.rows('session_execution_finals'), [])

    def test_immutable_sql_and_byte_bounds(self):
        receipt = self.begin(); self.facts(receipt)
        for table in ('session_execution_attempts', 'session_execution_finals'):
            with self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute('DELETE FROM ' + table)
            self.registry.db.rollback()
            with self.assertRaises(sqlite3.IntegrityError):
                self.registry.db.execute('UPDATE ' + table + " SET digest='" + '0' * 64 + "'")
            self.registry.db.rollback()

    def test_foreground_entry_excludes_children_monitors_and_restricted_before_origin(self):
        origin = unittest.mock.Mock(return_value=self.origin)
        agent = SimpleNamespace(config=self.cfg, depth=0, ui=SimpleNamespace(info=self.notices.append),
                                ctx=SimpleNamespace(project_root=self.root), mode='default',
                                _session_revision=3, _pip_proposal_origin=origin)
        for key, value in (('depth', 1), ('_monitor_turn', True), ('_parent_agent', object()),
                           ('_subagent_id', 'sub-example'), ('_agent_tool_allowlist', {'read_file'})):
            changed = copy.copy(agent); setattr(changed, key, value)
            self.assertIsNone(receipts.for_agent(changed, self.cfg.get('verify_command'), self.turn))
        origin.assert_not_called()
        result = receipts.for_agent(agent, self.cfg.get('verify_command'), self.turn)
        self.assertEqual(result.attempt['session_revision_at_attempt'], 3)

    def test_root_replacement_after_process_does_not_attest_source(self):
        receipt = self.begin()
        self.root.rename(self.base / 'old-workspace'); self.root.mkdir()
        (self.root / 'source.py').write_text('replacement')
        final = self.facts(receipt)
        self.assertEqual(final['source_after']['status'], 'unavailable')
        self.assertEqual(final['source_comparison'], 'unavailable')
        self.assertEqual(final['facts']['exit_code'], 0)

    def test_two_connections_finalize_exact_once_without_losing_retry(self):
        receipt = self.begin()
        sink = unittest.mock.Mock()
        native = receipts.NativeFacts(sink); native.started(); native.feed_safe('real facts')
        native.complete('exited', 0, output_complete=True)
        facts = sink.complete.call_args.args[0]
        barrier = Barrier(2)
        observed = receipt.attempt['source_before']
        def observe(*args, **kwargs):
            barrier.wait(timeout=5)
            return observed
        with patch.object(receipts, 'observe', side_effect=observe), ThreadPoolExecutor(2) as executor:
            first = executor.submit(receipt.complete, facts)
            second = executor.submit(receipt.complete, facts)
            self.assertTrue(first.result(timeout=10))
            self.assertTrue(second.result(timeout=10))
        self.assertEqual(len(self.rows('session_execution_finals')), 1)

    def test_schema_fifteen_upgrade_preserves_existing_scope_rows(self):
        from dgc.workspace_registry import SCHEMA_VERSION
        from tests.pip_test_migrations import drop_session_turn_schema
        before = [tuple(row) for row in self.registry.db.execute('SELECT * FROM session_workspaces')]
        with self.registry.transaction():
            drop_session_turn_schema(self.registry.db)
            self.registry.db.execute('DROP TABLE session_execution_finals')
            self.registry.db.execute('DROP TABLE session_execution_attempts')
            self.registry.db.execute('PRAGMA user_version=15')
        with WorkspaceRegistry(self.registry.directory) as migrated:
            self.assertEqual(migrated.db.execute('PRAGMA user_version').fetchone()[0], SCHEMA_VERSION)
            self.assertEqual([tuple(row) for row in migrated.db.execute('SELECT * FROM session_workspaces')], before)
            self.assertEqual(migrated.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_schema_sixteen_failure_rolls_back_all_new_tables(self):
        from tests.pip_test_migrations import drop_session_turn_schema
        with self.registry.transaction():
            drop_session_turn_schema(self.registry.db)
            self.registry.db.execute('DROP TABLE session_execution_finals')
            self.registry.db.execute('DROP TABLE session_execution_attempts')
            self.registry.db.execute('PRAGMA user_version=15')
        with patch.object(receipts, 'SCHEMA', receipts.SCHEMA + '\nCREATE TABLE transient_probe(x);\nBROKEN;'), \
             self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 15)
        for table in ('session_execution_attempts', 'session_execution_finals', 'transient_probe'):
            self.assertIsNone(self.registry.db.execute("SELECT name FROM sqlite_master WHERE name=?", (table,)).fetchone())
        with WorkspaceRegistry(self.registry.directory) as recovered:
            self.assertEqual(recovered.db.execute('SELECT count(*) FROM session_execution_attempts').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
