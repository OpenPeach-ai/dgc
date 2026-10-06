"""Schema21 preserves schema20 data while gating standalone command semantics."""
import sqlite3
import unittest
from unittest.mock import patch

from dgc import workspace_registry as schema, pip_quill_automation as quill
from dgc.pips import PipStore
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_quill_automation as fixtures
from tests import test_pip_quill_migration as migrations
from tests.pip_test_migrations import drop_commit_path_schema


class PulseSemanticMigrationTests(unittest.TestCase):
    setUp = fixtures.QuillAutomationTests.setUp
    git = fixtures.QuillAutomationTests.git
    commit = fixtures.QuillAutomationTests.commit
    create = fixtures.QuillAutomationTests.create
    approve = fixtures.QuillAutomationTests.approve
    scheduled = fixtures.QuillAutomationTests.scheduled
    occurrence = fixtures.QuillAutomationTests.occurrence
    enqueue = fixtures.QuillAutomationTests.enqueue
    raw = fixtures.QuillAutomationTests.raw
    snapshot = staticmethod(migrations.QuillSemanticMigrationTests.snapshot)

    def legacy(self):
        job = self.scheduled({'type': 'once', 'at': '2026-10-01T10:05:00.000Z'})
        self.now = '2026-10-01T10:05:00.000Z'
        run = self.enqueue(job)
        manifest = self.raw(run)
        self.assertIsNotNone(quill.validate_manifest(manifest))
        self.assertNotIn('verification_plan', manifest['job'])
        pulse = self.store.create(self.workspace['id'], 'Existing Pulse', 'Reviewed handoffs only', 'human', pip_type='pulse')
        raw_definition = self.registry.db.execute('SELECT definition FROM pip_versions WHERE pip_id=?', (pulse['id'],)).fetchone()[0]
        self.assertNotIn('verification_plan', raw_definition)
        # Real pre-21 semantics with identical DDL; no standing plan/progress rows.
        drop_commit_path_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=20')
        return self.snapshot(self.registry.db), run, manifest

    def test_upgrade_preserves_definitions_approvals_occurrence_and_manifest_bytes(self):
        before, run, manifest = self.legacy()
        from dgc.pip_commit_paths import SCHEMA_V22
        from dgc.pip_setup import SCHEMA as SETUP_SCHEMA
        from dgc.pip_chat_continuity import SCHEMA as CONTINUITY_SCHEMA
        from dgc.pip_app_actions import SCHEMA as APP_ACTION_SCHEMA
        from dgc.pip_message_drafts import SCHEMA as MESSAGE_DRAFT_SCHEMA, CALENDAR_SCHEMA, CONNECTOR_SCHEMA
        from dgc.pip_digest import SCHEMA as DIGEST_SCHEMA
        from dgc.pip_computer import SCHEMA as COMPUTER_SCHEMA
        from dgc.pip_chat import IMAGES_SCHEMA, FILES_SCHEMA
        with patch.object(schema, '_execute_schema', wraps=schema._execute_schema) as ddl:
            with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as upgraded:
                self.assertEqual([call.args for call in ddl.call_args_list],
                                 [(upgraded.db, SCHEMA_V22), (upgraded.db, SETUP_SCHEMA),
                                  (upgraded.db, CONTINUITY_SCHEMA), (upgraded.db, APP_ACTION_SCHEMA), (upgraded.db, MESSAGE_DRAFT_SCHEMA), (upgraded.db, CALENDAR_SCHEMA), (upgraded.db, CONNECTOR_SCHEMA), (upgraded.db, DIGEST_SCHEMA), (upgraded.db, COMPUTER_SCHEMA), (upgraded.db, IMAGES_SCHEMA), (upgraded.db, FILES_SCHEMA)])
                self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_commit_path_observations').fetchone()[0], 0)
                self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
                self.assertEqual(self.snapshot(upgraded.db), before)
                self.assertEqual(PipStore(upgraded).run(run['id']), run)
                row = upgraded.db.execute('SELECT * FROM pip_runs WHERE id=?', (run['id'],)).fetchone()
                quill.validate_parent(upgraded, row, manifest)
                self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_failed_semantic_migration_rolls_back_version_and_every_existing_row(self):
        before, _, _ = self.legacy()
        initialize = WorkspaceRegistry._initialize_schema
        def fail_after_version(registry):
            initialize(registry)
            self.assertEqual(registry.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
            raise sqlite3.OperationalError('fixture stopped semantic migration')
        with patch.object(WorkspaceRegistry, '_initialize_schema', fail_after_version):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'stopped semantic migration'):
                WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 20)
        self.assertEqual(self.snapshot(self.registry.db), before)
        with WorkspaceRegistry(self.registry.directory) as retried:
            self.assertEqual(retried.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
            self.assertEqual(self.snapshot(retried.db), before)

    def test_old_reader_refuses_new_schema_before_loading_any_job(self):
        before, _, _ = self.legacy()
        with WorkspaceRegistry(self.registry.directory):
            pass
        with patch.object(schema, 'SCHEMA_VERSION', 20), \
             patch.object(PipStore, '_job', side_effect=AssertionError('Old reader must not load jobs')):
            with self.assertRaisesRegex(RegistryError, 'compatible DGC version'):
                WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
        self.assertEqual(self.snapshot(self.registry.db), before)


if __name__ == '__main__': unittest.main()
