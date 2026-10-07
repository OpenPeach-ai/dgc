"""Schema20 changes interpretation only; old private evidence remains intact."""
import sqlite3
import unittest
from unittest.mock import patch

from dgc import workspace_registry as schema
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from dgc.pips import PipStore
from dgc import pip_memory_statements as statements
from tests import test_pip_drafts as drafts
from tests.pip_test_migrations import drop_commit_path_schema


class QuillSemanticMigrationTests(unittest.TestCase):
    setUp = drafts.DraftTests.setUp
    git = drafts.DraftTests.git
    commit = drafts.DraftTests.commit
    create = drafts.DraftTests.create
    queued = drafts.DraftTests.queued

    @staticmethod
    def snapshot(db):
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('pip_commit_path_observations','pip_setup_proposals','pip_app_actions','pip_message_drafts','pip_calendar_drafts','pip_connector_drafts','pip_notify_settings','pip_digest_state','pip_computer_actions','pip_chat_images','pip_chat_files') AND name NOT LIKE 'pip_chat_fts%' ORDER BY name")]   # the chat search index is not data
        rows = {name: [tuple(row) for row in db.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid')]
                for name in tables}
        definitions = [tuple(row) for row in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE tbl_name NOT IN ('pip_commit_path_observations','pip_setup_proposals','pip_app_actions','pip_message_drafts','pip_calendar_drafts','pip_connector_drafts','pip_notify_settings','pip_digest_state','pip_computer_actions','pip_chat_images','pip_chat_files') ORDER BY type,name")]
        return rows, definitions

    def legacy(self):
        self.commit()
        job, run, manifest = self.queued()
        candidate = statements.anchor(self.store, job['id'])
        saved = statements.record(self.store, job['id'], 'preference', 'Draft style',
            'Use short paragraphs.', 'Human review', None, candidate['digest'], 'once', 'human')['memory']
        self.assertNotIn('draft_automation', manifest)
        # 19 and20 have identical DDL. This is a real schema19 data fixture:
        # only an existing manual draft and a schema19 statement are stored.
        drop_commit_path_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=19')
        return self.snapshot(self.registry.db), job, run, saved

    def test_semantic_upgrade_preserves_old_ddl_and_queued_manual_bytes(self):
        before, job, run, saved = self.legacy()
        from dgc.pip_commit_paths import SCHEMA_V22
        from dgc.pip_setup import SCHEMA as SETUP_SCHEMA
        from dgc.pip_chat_continuity import SCHEMA as CONTINUITY_SCHEMA
        from dgc.pip_app_actions import SCHEMA as APP_ACTION_SCHEMA
        from dgc.pip_message_drafts import SCHEMA as MESSAGE_DRAFT_SCHEMA, CALENDAR_SCHEMA, CONNECTOR_SCHEMA
        from dgc.pip_digest import SCHEMA as DIGEST_SCHEMA
        from dgc.pip_computer import SCHEMA as COMPUTER_SCHEMA
        from dgc.pip_chat import IMAGES_SCHEMA, FILES_SCHEMA, CHOICES_SCHEMA
        from dgc.pip_app_links import SCHEMA as APP_LINKS_SCHEMA
        from dgc.pip_routines import SCHEMA as ROUTINES_SCHEMA
        from dgc.pip_profile import SCHEMA as PROFILE_SCHEMA
        from dgc.pip_plugins import SCHEMA as PLUGINS_SCHEMA
        from dgc.pip_notes import SCHEMA as NOTES_SCHEMA
        with patch.object(schema, '_execute_schema', wraps=schema._execute_schema) as ddl:
            with WorkspaceRegistry(self.registry.directory, clock=self.registry.clock) as upgraded:
                self.assertEqual([call.args for call in ddl.call_args_list],
                                 [(upgraded.db, SCHEMA_V22), (upgraded.db, SETUP_SCHEMA),
                                  (upgraded.db, CONTINUITY_SCHEMA), (upgraded.db, APP_ACTION_SCHEMA), (upgraded.db, MESSAGE_DRAFT_SCHEMA), (upgraded.db, CALENDAR_SCHEMA), (upgraded.db, CONNECTOR_SCHEMA), (upgraded.db, DIGEST_SCHEMA), (upgraded.db, COMPUTER_SCHEMA), (upgraded.db, IMAGES_SCHEMA), (upgraded.db, FILES_SCHEMA),
                                  (upgraded.db, APP_LINKS_SCHEMA), (upgraded.db, CHOICES_SCHEMA), (upgraded.db, ROUTINES_SCHEMA), (upgraded.db, PROFILE_SCHEMA), (upgraded.db, PLUGINS_SCHEMA), (upgraded.db, NOTES_SCHEMA)])
                self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_commit_path_observations').fetchone()[0], 0)
                self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
                self.assertEqual(self.snapshot(upgraded.db), before)
                store = PipStore(upgraded)
                self.assertEqual(store.run(run['id']), run)
                self.assertEqual(statements.get(store, job['id'], saved['id'])['memory'], saved)
                self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_failure_after_version_write_rolls_back_without_touching_history(self):
        before, _, _, _ = self.legacy()
        initialize = WorkspaceRegistry._initialize_schema
        def fail_after_version(registry):
            initialize(registry)
            self.assertEqual(registry.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
            raise sqlite3.OperationalError('fixture interrupted semantic migration')
        with patch.object(WorkspaceRegistry, '_initialize_schema', fail_after_version):
            with self.assertRaisesRegex(sqlite3.OperationalError, 'interrupted semantic migration'):
                WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 19)
        self.assertEqual(self.snapshot(self.registry.db), before)
        with WorkspaceRegistry(self.registry.directory) as recovered:
            self.assertEqual(recovered.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
            self.assertEqual(self.snapshot(recovered.db), before)

    def test_version19_reader_refuses_new_semantics_before_loading_jobs(self):
        before, _, _, _ = self.legacy()
        with WorkspaceRegistry(self.registry.directory):
            pass
        with patch.object(schema, 'SCHEMA_VERSION', 19), \
             patch.object(PipStore, '_job', side_effect=AssertionError('Old reader must not load jobs')):
            with self.assertRaisesRegex(RegistryError, 'compatible DGC version'):
                WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], schema.SCHEMA_VERSION)
        self.assertEqual(self.snapshot(self.registry.db), before)


if __name__ == '__main__':
    unittest.main()
