"""Schema17 history survives the additive completion ledger migration atomically."""
import sqlite3
import unittest
from unittest.mock import patch

from dgc import session_turn_events as events, workspace_context, workspace_registry
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_workspace_session_execution_record as fixture
from tests.pip_test_migrations import drop_session_turn_schema


class SessionTurnMigrationTests(unittest.TestCase):
    setUp = fixture.SessionExecutionRecordTests.setUp
    begin = fixture.SessionExecutionRecordTests.begin
    facts = fixture.SessionExecutionRecordTests.facts
    rows = fixture.SessionExecutionRecordTests.rows
    ready = fixture.SessionExecutionRecordTests.ready
    hub = fixture.SessionExecutionRecordTests.hub
    workspace = fixture.SessionExecutionRecordTests.workspace
    get = fixture.SessionExecutionRecordTests.get
    args = fixture.SessionExecutionRecordTests.args

    @staticmethod
    def snapshot(registry):
        names = [row[0] for row in registry.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('session_turn_completions','pip_memory_statements','pip_commit_path_observations','pip_setup_proposals','pip_app_actions','pip_message_drafts','pip_calendar_drafts','pip_connector_drafts','pip_notify_settings','pip_digest_state','pip_computer_actions','pip_chat_images','pip_chat_files') ORDER BY name")]
        return {name: [tuple(row) for row in registry.db.execute(
            'SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid')] for name in names}

    def legacy(self):
        self.ready(text='tests passed; exit code: 0', code=7)
        self.hub.record(**self.args())
        pin = workspace_context.ContextStore(self.registry).snapshot(self.workspace)
        drop_session_turn_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=17')
        self.assertIsNone(self.registry.db.execute(
            "SELECT 1 FROM sqlite_master WHERE name LIKE '%session_turn_completion%'").fetchone())
        return self.snapshot(self.registry), pin

    def test_schema_seventeen_to_eighteen_preserves_all_rows_and_native_context_pin(self):
        before, pin = self.legacy()
        with WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0], workspace_registry.SCHEMA_VERSION)
            self.assertEqual(self.snapshot(upgraded), before)
            self.assertEqual(workspace_context.ContextStore(upgraded).snapshot(self.workspace), pin)
            self.assertEqual(upgraded.db.execute('SELECT count(*) FROM session_turn_completions').fetchone()[0], 0)
            self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(), [])
            objects = {row[0] for row in upgraded.db.execute(
                "SELECT name FROM sqlite_master WHERE name LIKE '%session_turn_completion%'")}
            self.assertTrue({'session_turn_completions', 'session_turn_completion_scope',
                             'immutable_session_turn_completion_update',
                             'immutable_session_turn_completion_delete'} <= objects)

    def test_failed_eighteen_migration_rolls_back_table_index_triggers_and_version(self):
        before, pin = self.legacy()
        with patch.object(events, 'SCHEMA', events.SCHEMA + '\nBROKEN MIGRATION;'), \
             self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 17)
        self.assertIsNone(self.registry.db.execute(
            "SELECT 1 FROM sqlite_master WHERE name LIKE '%session_turn_completion%'").fetchone())
        self.assertEqual(self.snapshot(self.registry), before)
        with WorkspaceRegistry(self.registry.directory) as recovered:
            self.assertEqual(self.snapshot(recovered), before)
            self.assertEqual(workspace_context.ContextStore(recovered).snapshot(self.workspace), pin)
            self.assertEqual(recovered.db.execute('SELECT count(*) FROM session_turn_completions').fetchone()[0], 0)
