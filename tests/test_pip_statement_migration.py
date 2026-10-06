"""Schema18 evidence remains byte-identical across the additive statement ledger."""
import sqlite3
import unittest
from unittest.mock import patch

from dgc import pip_memory, pip_memory_statements as statements, workspace_registry
from dgc.pips import PipStore
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_memory as fixtures
from tests.pip_test_migrations import drop_statement_schema


class StatementMigrationTests(unittest.TestCase):
    setUp=fixtures.PipMemoryTests.setUp
    new_pip=fixtures.PipMemoryTests.new_pip
    finding=fixtures.PipMemoryTests.finding
    report=fixtures.PipMemoryTests.report
    source_run=fixtures.PipMemoryTests.source_run
    complete=fixtures.PipMemoryTests.complete
    record=fixtures.PipMemoryTests.record
    snap=fixtures.PipMemoryTests.snap

    @staticmethod
    def rows(registry):
        tables=[row[0] for row in registry.db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('pip_memory_statements','pip_commit_path_observations','pip_setup_proposals','pip_app_actions','pip_message_drafts','pip_calendar_drafts','pip_connector_drafts','pip_notify_settings','pip_digest_state','pip_computer_actions','pip_chat_images','pip_chat_files') ORDER BY name")]
        return {name:[tuple(row) for row in registry.db.execute('SELECT * FROM "'+name.replace('"','""')+'" ORDER BY rowid')] for name in tables}

    def legacy(self):
        ContextStore(self.registry).record(self.workspace['id'],'decision','Keep local','No external sharing',0,'human')
        run,_=self.complete()
        saved=self.record(run)['memory'];candidate=pip_memory.source_exception(self.store,self.job['id'],run,0)
        pin=self.snap();self.assertEqual(pin['schema_version'],1)
        drop_statement_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=18')
        return self.rows(self.registry),pin,saved,candidate

    def test_eighteen_upgrade_preserves_all_old_rows_and_legacy_exception_pin(self):
        before,pin,saved,candidate=self.legacy()
        with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as upgraded:
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0],workspace_registry.SCHEMA_VERSION)
            self.assertEqual(self.rows(upgraded),before)
            self.assertEqual(pip_memory.snapshot(PipStore(upgraded),self.job['id'],fixtures.SOURCE,1,fixtures.NOW),pin)
            self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_memory_statements').fetchone()[0],0)
            self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(),[])
            names={row[0] for row in upgraded.db.execute("SELECT name FROM sqlite_master WHERE name LIKE '%pip_statement%' OR name='pip_memory_statements'")}
            self.assertTrue({'pip_memory_statements','pip_statement_history','immutable_pip_statement',
                             'revoke_pip_statement_once','retain_pip_statement'}<=names)

    def test_failed_migration_rolls_back_new_objects_and_version_then_retries(self):
        before,pin,_,_=self.legacy()
        with patch.object(statements,'SCHEMA',statements.SCHEMA+'\nINVALID MIGRATION;\n'),self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0],18)
        self.assertIsNone(self.registry.db.execute("SELECT name FROM sqlite_master WHERE name LIKE '%pip_statement%' OR name='pip_memory_statements'").fetchone())
        self.assertEqual(self.rows(self.registry),before)
        with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as recovered:
            self.assertEqual(self.rows(recovered),before)
            self.assertEqual(pip_memory.snapshot(PipStore(recovered),self.job['id'],fixtures.SOURCE,1,fixtures.NOW),pin)

    def test_older_reader_refuses_before_loading_new_or_old_statement_data(self):
        before=self.rows(self.registry)
        with patch.object(workspace_registry,'SCHEMA_VERSION',18),patch.object(statements,'_load',side_effect=AssertionError('No statement load')):
            with self.assertRaisesRegex(RegistryError,'compatible DGC version'):WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.rows(self.registry),before)

    def test_existing_exception_exact_retry_survives_upgrade_and_full_combined_cap(self):
        _,_,saved,candidate=self.legacy()
        with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as upgraded:
            store=PipStore(upgraded);before=self.rows(upgraded)
            with patch.object(statements,'MAX_ACTIVE',1):
                retry=pip_memory.record_exception(store,self.job['id'],candidate['source']['run_id'],0,
                    candidate['digest'],'Accepted fixture risk',None,'record-one','review-device')
            self.assertTrue(retry['replayed']);self.assertEqual(retry['memory'],saved)
            self.assertEqual(self.rows(upgraded),before)


if __name__=='__main__':unittest.main()
