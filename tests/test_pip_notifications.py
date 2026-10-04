"""Deterministic metadata-only notification cache, retention and acknowledgement."""
import json
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from dgc import pip_notifications as notices, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, _execute_schema
from tests import test_pips_local as fixtures
from tests import test_pip_handoffs as handoff_fixtures
from tests import test_workspace_session_outcomes as outcome_fixtures


def initialize(registry):
    if not registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='pip_notifications'").fetchone():
        with registry.transaction():
            _execute_schema(registry.db, notices.SCHEMA)


class NotificationTests(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    setup_source = handoff_fixtures.PipHandoffTests.setup_source
    propose_handoff = handoff_fixtures.PipHandoffTests.propose

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        initialize(self.registry)
        self.now = '2026-10-01T10:00:00.000Z'
        self.registry.clock = lambda: self.now
        self.ws = self.workspace['id']

    def job(self, workspace=None):
        return self.store.create(workspace or self.ws, 'PRIVATE_JOB_NAME', 'PRIVATE_JOB_GOAL', 'device')

    def proposal(self, job=None, *, schedule=False):
        job = job or self.job()
        changes = {'schedule': {'type':'interval','minutes':10,'missed_policy':'coalesce_latest'}} if schedule else {'goal':'PRIVATE_NEW_GOAL'}
        return self.store.propose(job['id'], 1, changes, 'device', 'PRIVATE_REASON')

    def failed(self, number=1, job=None, **overrides):
        job = job or self.job()
        run_id = 'run_' + format(number, '032x')
        binding = self.registry.db.execute('SELECT id FROM bindings WHERE workspace_id=?',(job['workspace_id'],)).fetchone()[0]
        fields = dict(id=run_id,pip_id=job['id'],workspace_id=job['workspace_id'],binding_id=binding,
                      idempotency_key=str(number),requested_by='device',manifest='PRIVATE_MANIFEST',status='failed',
                      created_at=self.now,started_at=self.now,finished_at=self.now,result='PRIVATE_RESULT',error='PRIVATE_SECRET_ERROR')
        fields.update(overrides)
        self.registry.db.execute('INSERT INTO pip_runs ('+','.join(fields)+') VALUES ('+','.join('?' for _ in fields)+')',tuple(fields.values()))
        self.registry.event(job['workspace_id'],'pip_run_failed',pip_id=job['id'],run_id=run_id,payload={'message':'PRIVATE_EVENT_SECRET'})
        return run_id

    def page(self, **kwargs):
        return notices.list_notifications(self.registry, **kwargs)

    def source_dump(self):
        return {name:[tuple(row) for row in self.registry.db.execute('SELECT * FROM '+name)] for name in
                ('pips','pip_versions','pip_proposals','pip_approvals','pip_runs','workspace_events')}

    def test_empty_has_explicit_retention_and_sync_metadata(self):
        page = self.page()
        self.assertEqual(page['notifications'], [])
        self.assertEqual(page['unread_count'], 0)
        self.assertIsNone(page['oldest_seq'])
        self.assertFalse(page['history_may_be_incomplete'])
        self.assertFalse(page['sync_pending'])
        self.assertEqual(page['retention_limit'], 500)
        self.assertEqual(page['sync_scanned'], 1)

    def test_real_job_and_schedule_reviews_have_exact_links_and_no_content(self):
        first = self.proposal()
        second = self.proposal(schedule=True)
        before = self.source_dump()
        page = self.page()
        rows = page['notifications']
        self.assertEqual([row['source_kind'] for row in rows], ['schedule_update','job_update'])
        self.assertEqual({row['reference']['proposal_id'] for row in rows}, {first['id'],second['id']})
        self.assertTrue(all(row['actionable'] and row['source_status']=='pending' for row in rows))
        self.assertTrue(all(set(row['reference'])=={'approval_id','proposal_id','pip_id'} for row in rows))
        self.assertNotIn('PRIVATE_',json.dumps(page))
        self.assertNotIn(str(self.root),json.dumps(page))
        self.assertEqual(self.source_dump(),before)

    def test_failed_run_never_reads_result_manifest_error_or_event_body(self):
        run_id = self.failed(result='x'*(2*1024*1024),manifest='y'*(2*1024*1024),error='z'*(2*1024*1024))
        self.registry.db.execute("UPDATE workspace_events SET payload=? WHERE event_type='pip_run_failed'",('q'*(2*1024*1024),))
        with patch.object(notices,'_object',wraps=notices._object) as parse:
            row = self.page()['notifications'][0]
        self.assertTrue(all(len(call.args[0])<=1024 for call in parse.call_args_list))
        self.assertEqual(row['reference']['run_id'],run_id)
        self.assertEqual(row['kind'],'run_failed')
        self.assertEqual(row['title'],'Pip run failed')

    def test_only_failed_not_cancelled_or_succeeded_events_materialize(self):
        self.failed(status='cancelled')
        self.failed(2,status='succeeded')
        self.assertEqual(self.page()['notifications'],[])

    def test_handoff_reads_target_review_without_task_or_evidence(self):
        self.setup_source()
        handoff = self.propose_handoff(task='PRIVATE_HANDOFF_TASK')
        page = self.page()
        row = next(row for row in page['notifications'] if row['source_kind']=='handoff')
        self.assertEqual(row['pip_id'],self.target['id'])
        self.assertEqual(row['reference'],{'handoff_id':handoff['id'],'target_pip_id':self.target['id']})
        self.assertNotIn('PRIVATE_HANDOFF_TASK',json.dumps(page))
        self.assertNotIn("return 'hello'",json.dumps(page))

    def test_resolution_and_expiry_change_actionability_not_source_or_read_state(self):
        job = self.job(); proposal = self.proposal(job)
        row = self.page()['notifications'][0]
        self.store.reject(job['id'],proposal['id'],1,'reviewer')
        before = self.source_dump()
        refreshed = self.page()['notifications'][0]
        self.assertEqual(refreshed['source_status'],'rejected')
        self.assertFalse(refreshed['actionable'])
        self.assertEqual(refreshed['revision'],0)
        self.assertEqual(self.source_dump(),before)
        result = notices.mark_read(self.registry,row['id'],0,'reader')
        self.assertEqual(result['notification']['source_status'],'rejected')
        self.assertEqual(self.source_dump(),before)
        self.proposal()
        self.now = '2026-10-11T10:00:00.000Z'
        self.assertEqual(len(self.page()['notifications']),1)  # expired before first observation
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_approvals WHERE status='pending'").fetchone()[0],1)

    def test_retained_pending_notification_expires_without_database_write(self):
        self.proposal()
        row = self.page()['notifications'][0]
        self.now = '2026-10-11T10:00:00.000Z'
        before = self.source_dump()
        current = self.page()['notifications'][0]
        self.assertEqual(current['id'],row['id'])
        self.assertEqual(current['source_status'],'expired')
        self.assertFalse(current['actionable'])
        self.assertEqual(self.source_dump(),before)

    def test_restart_and_duplicate_event_preserve_single_notification_and_read_receipt(self):
        run_id = self.failed()
        first = self.page()['notifications'][0]
        read = notices.mark_read(self.registry,first['id'],0,'original-reader')['notification']
        self.now = '2026-10-01T11:00:00.000Z'
        self.registry.event(self.ws,'pip_run_failed',pip_id=first['pip_id'],run_id=run_id)
        with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as restarted:
            page = notices.list_notifications(restarted)
            self.assertEqual(page['notifications'],[read])
            retry = notices.mark_read(restarted,first['id'],0,'another-reader')
            self.assertTrue(retry['replayed'])
            self.assertEqual(retry['notification'],read)

    def test_scan_budget_counts_every_event_not_only_relevant_matches(self):
        for _ in range(150): self.registry.event(self.ws,'pip_run_progress',payload={'message':'PRIVATE_PROGRESS'})
        self.failed()
        first = self.page()
        self.assertEqual(first['notifications'],[])
        self.assertEqual(first['sync_scanned'],100)
        self.assertTrue(first['sync_pending'])
        second = self.page()
        self.assertEqual(len(second['notifications']),1)
        self.assertLessEqual(second['sync_scanned'],100)
        self.assertFalse(second['sync_pending'])
        self.assertEqual(self.page()['sync_scanned'],0)

    def test_paging_retention_and_evicted_source_dedup(self):
        job = self.job()
        for number in range(1,506): self.failed(number,job=job)
        while self.page()['sync_pending']: pass
        first = self.page(limit=20)
        self.assertEqual(first['retained_count'],500)
        self.assertEqual(first['evicted_total'],5)
        self.assertTrue(first['history_may_be_incomplete'])
        seen = []; page = first
        while True:
            seen += [row['seq'] for row in page['notifications']]
            if not page['has_more']: break
            page = self.page(before_seq=page['next_before_seq'])
        self.assertEqual(len(seen),500)
        self.assertEqual(seen,sorted(set(seen),reverse=True))
        self.assertIsNone(page['next_before_seq'])
        self.registry.event(self.ws,'pip_run_failed',pip_id=job['id'],run_id='run_'+format(1,'032x'))
        after = self.page()
        self.assertEqual(after['notifications'],first['notifications'])
        self.assertEqual(after['evicted_total'],5)
        with self.assertRaisesRegex(RegistryError,'retained'):
            notices.mark_read(self.registry,notices._identity('run','run_'+format(1,'032x')),0,'reader')

    def test_seen_cap_skips_with_visible_omission_without_source_effect(self):
        self.failed()
        before = self.source_dump()
        with patch.object(notices,'SEEN_LIMIT',0):
            page = self.page()
        self.assertEqual(page['notifications'],[])
        self.assertEqual(page['unavailable_sources_total'],1)
        self.assertTrue(page['history_may_be_incomplete'])
        self.assertEqual(self.source_dump(),before)

    def test_event_retention_gap_sets_incomplete_but_not_ordinary_scope_gap(self):
        other = self.base/'other'; other.mkdir(); otherws=self.registry.resolve(other)['id']
        self.failed(job=self.job(otherws))
        self.failed(2)
        page = self.page(workspace_id=self.ws)
        self.assertEqual(len(page['notifications']),1)
        self.assertFalse(page['history_may_be_incomplete'])
        self.registry.event(self.ws,'temporary')
        self.registry.event(self.ws,'after_gap')
        self.registry.db.execute("DELETE FROM workspace_events WHERE event_type='temporary'")
        self.assertTrue(self.page()['history_may_be_incomplete'])

    def test_foreign_workspace_event_cannot_materialize_or_be_marked_through_other_scope(self):
        job = self.job(); run_id = self.failed(job=job)
        other = self.base/'other'; other.mkdir(); otherws=self.registry.resolve(other)['id']
        self.registry.event(otherws,'pip_run_failed',pip_id=job['id'],run_id=run_id)
        page = self.page()
        self.assertEqual(len(page['notifications']),1)
        self.assertEqual(page['unavailable_sources_total'],1)
        with self.assertRaisesRegex(RegistryError,'retained'):
            notices.mark_read(self.registry,page['notifications'][0]['id'],0,'reader',workspace_id=otherws)
        self.assertEqual(self.page(workspace_id=otherws)['notifications'],[])

    def test_unknown_workspace_refused_before_cache_materialization(self):
        self.failed()
        with patch.object(notices,'sync',side_effect=AssertionError('foreign cache mutation')):
            with self.assertRaisesRegex(RegistryError,'Workspace not found'):
                self.page(workspace_id='ws_'+'f'*32)

    def test_read_cas_is_shared_between_connections_and_never_approves(self):
        self.proposal()
        row = self.page()['notifications'][0]
        before = self.source_dump()
        with self.assertRaisesRegex(RegistryError,'changed'):
            notices.mark_read(self.registry,row['id'],1,'reader')
        with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as second:
            first = notices.mark_read(self.registry,row['id'],0,'first')
            retry = notices.mark_read(second,row['id'],0,'second')
        self.assertTrue(retry['replayed'])
        self.assertEqual(retry['notification'],first['notification'])
        self.assertEqual(self.page()['unread_count'],0)
        self.assertEqual(self.source_dump(),before)

    def test_scan_poison_is_bounded_skipped_and_cursor_advances(self):
        self.proposal()
        self.registry.db.execute("UPDATE workspace_events SET payload=? WHERE event_type='pip_job_update_proposed'",('x'*(2*1024*1024),))
        with patch.object(notices,'_object',wraps=notices._object) as parsed:
            page = self.page()
        self.assertEqual(page['unavailable_sources_total'],1)
        self.assertTrue(all(call.args[0] is None or len(call.args[0])<=8192 for call in parsed.call_args_list))
        self.assertEqual(self.page()['sync_scanned'],0)

    def test_invalid_event_json_is_rejected_as_whole_metadata(self):
        self.proposal()
        raws = ['[]','{','{"x":NaN}','{"x":1,"x":2}','{"x":"\\ud800"}','{"x":'+'['*30+'0'+']'*30+'}']
        original = self.registry.db.execute("SELECT payload,pip_id FROM workspace_events WHERE event_type='pip_job_update_proposed'").fetchone()
        self.registry.db.execute("DELETE FROM workspace_events WHERE event_type='pip_job_update_proposed'")
        for raw in raws:
            self.registry.event(self.ws,'pip_job_update_proposed',pip_id=original['pip_id'])
            self.registry.db.execute('UPDATE workspace_events SET payload=? WHERE seq=(SELECT max(seq) FROM workspace_events)',(raw,))
        page=self.page()
        self.assertEqual(page['notifications'],[])
        self.assertEqual(page['unavailable_sources_total'],len(raws))

    def test_corrupt_source_metadata_cannot_claim_actionability(self):
        self.proposal()
        row = self.page()['notifications'][0]
        self.registry.db.execute('DROP TRIGGER immutable_pip_approval')  # explicit hostile-storage fixture
        self.registry.db.execute('UPDATE pip_approvals SET expires_at=?',( 'x'*(2*1024*1024),))
        refreshed=self.page()['notifications'][0]
        self.assertEqual(refreshed['source_status'],'unavailable')
        self.assertFalse(refreshed['actionable'])
        self.assertEqual(notices.mark_read(self.registry,row['id'],0,'reader')['notification']['revision'],1)

    def test_concurrent_acknowledgements_keep_one_original_receipt(self):
        self.failed(); row = self.page()['notifications'][0]
        ready = Barrier(2)
        def acknowledge(actor):
            with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as connection:
                ready.wait(timeout=10)
                return notices.mark_read(connection,row['id'],0,actor)
        with ThreadPoolExecutor(max_workers=2) as executor:
            replies = list(executor.map(acknowledge,['reader-one','reader-two']))
        self.assertEqual(sorted(reply['replayed'] for reply in replies),[False,True])
        self.assertEqual(replies[0]['notification'],replies[1]['notification'])
        self.assertIn(replies[0]['notification']['read_by'],['reader-one','reader-two'])

    def test_malformed_time_and_cross_pip_event_cannot_create_notifications(self):
        job = self.job(); other = self.job()
        self.failed(job=job,finished_at='0001-01-01T00:00:00+23:59')
        self.failed(2,job=job)
        self.registry.db.execute("UPDATE workspace_events SET pip_id=? WHERE run_id=?",(other['id'],'run_'+format(2,'032x')))
        page = self.page()
        self.assertEqual(page['notifications'],[])
        self.assertEqual(page['unavailable_sources_total'],2)

    def test_foreign_runner_binding_is_excluded_from_scan_and_cache_read(self):
        self.failed(); row = self.page()['notifications'][0]
        self.registry.db.execute("UPDATE bindings SET runner_id='runner_other' WHERE workspace_id=?",(self.ws,))
        self.assertEqual(self.page()['notifications'],[])
        with self.assertRaisesRegex(RegistryError,'retained'):
            notices.mark_read(self.registry,row['id'],0,'reader')

    def test_cache_identity_and_read_receipts_immutable(self):
        self.failed(); row=self.page()['notifications'][0]
        with self.assertRaisesRegex(sqlite3.IntegrityError,'immutable'):
            self.registry.db.execute("UPDATE pip_notifications SET reference='{}'")
        with self.assertRaisesRegex(sqlite3.IntegrityError,'retained'):
            self.registry.db.execute('DELETE FROM pip_notification_seen')
        notices.mark_read(self.registry,row['id'],0,'reader')
        with self.assertRaisesRegex(sqlite3.IntegrityError,'once'):
            self.registry.db.execute('UPDATE pip_notifications SET revision=0,read_at=NULL,read_by=NULL')

    def test_failed_cache_write_rolls_back_cursor_seen_and_notification(self):
        self.failed()
        self.registry.db.execute("CREATE TRIGGER fixture_failure BEFORE INSERT ON pip_notification_seen BEGIN SELECT RAISE(ABORT,'fixture'); END")
        before = self.source_dump()
        with self.assertRaisesRegex(sqlite3.IntegrityError,'fixture'): self.page()
        self.assertEqual(self.registry.db.execute('SELECT after_event_seq FROM pip_notification_state').fetchone()[0],0)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_notifications').fetchone()[0],0)
        self.assertEqual(self.source_dump(),before)
        self.registry.db.execute('DROP TRIGGER fixture_failure')
        self.assertEqual(len(self.page()['notifications']),1)

    def test_strict_input_bounds_and_no_implicit_sync_in_readmark(self):
        for value in (True,0,-1,21,1.0,'1',2**70):
            with self.subTest(limit=value),self.assertRaises(RegistryError): self.page(limit=value)
        for value in (True,0,-1,1.0,'1',2**53):
            with self.subTest(cursor=value),self.assertRaises(RegistryError): self.page(before_seq=value)
        self.failed(); row=self.page()['notifications'][0]
        for value in (True,-1,2,1.0,'0'):
            with self.subTest(revision=value),self.assertRaises(RegistryError): notices.mark_read(self.registry,row['id'],value,'reader')
        for actor in ('', 'a'*129,'line\nbreak','\ud800'):
            with self.subTest(actor=repr(actor)),self.assertRaises(RegistryError): notices.mark_read(self.registry,row['id'],0,actor)
        with patch.object(notices,'sync',side_effect=AssertionError('ack scanned new events')):
            self.assertEqual(notices.mark_read(self.registry,row['id'],0,'reader')['notification']['revision'],1)


class SessionStatementNotifications(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    write = outcome_fixtures.SessionOutcomeTests.write
    propose = outcome_fixtures.SessionOutcomeTests.propose

    def setUp(self):
        outcome_fixtures.SessionOutcomeTests.setUp(self)
        initialize(self.registry)

    def test_real_statement_source_never_copies_transcript_or_statement(self):
        proposal=self.propose(statement='PRIVATE_OUTCOME_STATEMENT')
        page=notices.list_notifications(self.registry)
        row=page['notifications'][0]
        self.assertEqual(row['source_kind'],'session_outcome')
        self.assertIsNone(row['pip_id'])
        self.assertEqual(row['reference'],{'proposal_id':proposal['id']})
        self.assertNotIn('PRIVATE_',json.dumps(page))
        self.outcomes.reject(self.ws,proposal['id'],proposal['digest'],'reviewer')
        result=notices.mark_read(self.registry,row['id'],0,'reader')
        self.assertEqual(result['notification']['source_status'],'rejected')
        self.assertFalse(result['notification']['actionable'])
        self.assertEqual(self.hub.get(self.ws)['entries'],[])

    def test_schema_twelve_migration_preserves_context_and_statements_and_rolls_back(self):
        from dgc import workspace_registry as storage
        proposal = self.propose()
        self.hub.record(self.ws,'decision','Existing','Preserve exact approved context.',0,'reviewer')
        original = self.hub.snapshot(self.ws)
        tables = ('workspace_context_entries','workspace_context_revisions','workspace_session_outcomes')
        before = {table:[tuple(row) for row in self.registry.db.execute('SELECT * FROM '+table)] for table in tables}
        from tests.pip_test_migrations import drop_archive_schema
        drop_archive_schema(self.registry.db)
        for table in ('pip_memories', 'pip_notifications','pip_notification_state','pip_notification_seen'):
            self.registry.db.execute('DROP TABLE '+table)
        self.registry.db.execute('PRAGMA user_version=12')
        original_schema = notices.SCHEMA
        with patch.object(notices,'SCHEMA',original_schema+'\nSELECT * FROM fixture_missing_table;'), self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0],12)
        self.assertEqual(self.registry.db.execute("SELECT name FROM sqlite_master WHERE name LIKE 'pip_notification%'").fetchall(),[])
        with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as upgraded:
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0],storage.SCHEMA_VERSION)
            self.assertEqual({table:[tuple(row) for row in upgraded.db.execute('SELECT * FROM '+table)] for table in tables},before)
            from dgc.workspace_context import ContextStore
            self.assertEqual(ContextStore(upgraded).snapshot(self.ws),original)
            self.assertEqual(notices.list_notifications(upgraded)['notifications'][0]['reference'],{'proposal_id':proposal['id']})


if __name__ == '__main__': unittest.main()
