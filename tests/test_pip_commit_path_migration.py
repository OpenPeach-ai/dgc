"""Schema22 adds empty observer state; it cannot observe or schedule work."""
import sqlite3
import unittest
from unittest.mock import patch

from dgc import pips, pip_commit_paths as paths, workspace_registry as schema
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_pulse_integration as fixtures
from tests import test_pip_quill_migration as migrations
from tests.pip_test_migrations import drop_commit_path_schema


class CommitPathMigrationTests(unittest.TestCase):
    setUp = fixtures.PulseIntegrationTests.setUp
    git = fixtures.PulseIntegrationTests.git
    commit = fixtures.PulseIntegrationTests.commit
    create = fixtures.PulseIntegrationTests.create
    plan = fixtures.PulseIntegrationTests.plan
    approve = fixtures.PulseIntegrationTests.approve
    planned = fixtures.PulseIntegrationTests.planned
    request = fixtures.PulseIntegrationTests.request
    enqueue = fixtures.PulseIntegrationTests.enqueue
    snapshot = staticmethod(migrations.QuillSemanticMigrationTests.snapshot)

    def legacy(self):
        job = self.planned()
        run = self.enqueue(job)
        saved = self.store.cancel(run['id'], 'human')
        drop_commit_path_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=21')
        return self.snapshot(self.registry.db), job, saved

    def test_upgrade_adds_only_empty_table_and_index_without_observing_or_running(self):
        before, job, run = self.legacy()
        with patch.object(pips, 'source_revision', side_effect=AssertionError('No Git during migration')), \
             patch.object(pips.PipStore, 'enqueue', side_effect=AssertionError('No runs during migration')):
            with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as upgraded:
                self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
                self.assertEqual(self.snapshot(upgraded.db), before)
                self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_commit_path_observations').fetchone()[0], 0)
                objects = {tuple(row) for row in upgraded.db.execute(
                    "SELECT type,name FROM sqlite_master WHERE tbl_name='pip_commit_path_observations'")}
                self.assertIn(('table', 'pip_commit_path_observations'), objects)
                self.assertIn(('index', 'pip_commit_path_observation_due'), objects)
                self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(), [])
                self.assertEqual(pips.PipStore(upgraded).get(job['id'])['verification_plan'], job['verification_plan'])
                self.assertEqual(pips.PipStore(upgraded).run(run['id']), run)
                self.assertIsNone(upgraded.db.execute("SELECT value FROM metadata WHERE key='pip_commit_probe_cursor'").fetchone())

    def test_failure_after_ddl_rolls_back_every_new_object_and_preserves_history(self):
        before, _, saved = self.legacy()
        with patch.object(paths, 'SCHEMA_V22', paths.SCHEMA_V22 + '\nINVALID MIGRATION;'), \
             self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 21)
        self.assertIsNone(self.registry.db.execute("SELECT name FROM sqlite_master WHERE tbl_name='pip_commit_path_observations'").fetchone())
        self.assertEqual(self.snapshot(self.registry.db), before)
        with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as recovered:
            self.assertEqual(self.snapshot(recovered.db), before)
            self.assertEqual(pips.PipStore(recovered).run(saved['id']), saved)
            self.assertEqual(recovered.db.execute('SELECT count(*) FROM pip_commit_path_observations').fetchone()[0], 0)

    def test_version21_reader_refuses_new_schema_before_any_job_load(self):
        before = self.snapshot(self.registry.db)
        with patch.object(schema, 'SCHEMA_VERSION', 21), \
             patch.object(pips.PipStore, '_job', side_effect=AssertionError('No older job load')):
            with self.assertRaisesRegex(RegistryError, 'compatible DGC version'):
                WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.snapshot(self.registry.db), before)

    def test_reopening_schema22_runs_no_migration_and_changes_no_rows(self):
        before = '\n'.join(self.registry.db.iterdump())
        with patch.object(schema, '_execute_schema', side_effect=AssertionError('No repeated migration')):
            with WorkspaceRegistry(self.registry.directory): pass
        self.assertEqual('\n'.join(self.registry.db.iterdump()), before)

    def test_internal_event_time_binds_payload_and_row_without_reconsulting_clock(self):
        at = '2026-10-02T01:23:45.678Z'
        with patch.object(self.registry, 'clock', side_effect=AssertionError('Use the captured observation instant')):
            self.registry.event(self.workspace['id'], 'fixture_observation', payload={'observed_at': at}, created_at=at)
        row = self.registry.db.execute("SELECT * FROM workspace_events WHERE event_type='fixture_observation'").fetchone()
        self.assertEqual(row['created_at'], at)
        self.assertEqual(row['payload'], '{"observed_at":"' + at + '"}')
        self.registry.event(self.workspace['id'], 'fixture_legacy_clock')
        self.assertEqual(self.registry.db.execute("SELECT created_at FROM workspace_events WHERE event_type='fixture_legacy_clock'").fetchone()[0], self.now)

    def test_invalid_internal_event_times_refuse_without_rows_or_secret_echo(self):
        before = '\n'.join(self.registry.db.iterdump())
        for value in (True, 1, {}, '', 'secret-' * 1000, '2026-02-30T01:23:45.678Z',
                      '2026-10-02T01:23:45Z', '2026-10-02T01:23:45.678+00:00',
                      '2026-10-02 01:23:45.678Z', '2026-10-02T25:23:45.678Z',
                      '0000-10-02T01:23:45.678Z'):
            with self.subTest(value=str(value)[:30]), self.assertRaises(RegistryError) as caught:
                self.registry.event(self.workspace['id'], 'fixture_invalid', created_at=value)
            self.assertEqual(caught.exception.code, 'invalid_event_time')
            self.assertNotIn('secret', str(caught.exception))
        self.assertEqual('\n'.join(self.registry.db.iterdump()), before)


if __name__ == '__main__': unittest.main()
