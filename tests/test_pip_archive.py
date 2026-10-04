"""Archival is reversible retained history, never hidden cancellation or dispatch."""
import copy
import json
import sqlite3
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from dgc import pip_archive as archive,pip_chat,pip_handoffs as handoffs,pip_checkpoints,pips
from dgc.workspace_registry import WorkspaceRegistry,RegistryError,SCHEMA_VERSION
from tests import test_pip_handoffs as fixtures
from tests.pip_test_migrations import drop_archive_schema


class PipArchiveTests(unittest.TestCase):
    setUp=fixtures.PipHandoffTests.setUp
    git=fixtures.PipHandoffTests.git
    commit=fixtures.PipHandoffTests.commit
    setup_source=fixtures.PipHandoffTests.setup_source
    propose=fixtures.PipHandoffTests.propose
    accept=fixtures.PipHandoffTests.accept

    def change(self,pip=None,archived=True,key='archive',**kwargs):
        pip=pip or self.source
        current=self.store.get(pip['id'])
        return archive.transition(self.store,pip['id'],**{'archived':archived,
            'expected_version':current['current_version'],'expected_lifecycle_revision':current['lifecycle_revision'],
            'request_key':key,'reason':'Explicit test review','actor':'device',**kwargs})

    def cycle(self,pip,store=None):
        store=store or self.store
        current=store.get(pip['id'])
        for archived,key in ((True,'race-archive'),(False,'race-restore')):
            result=archive.transition(store,pip['id'],archived=archived,expected_version=current['current_version'],
                expected_lifecycle_revision=current['lifecycle_revision'],request_key=key,
                reason='Competing explicit lifecycle change',actor='other-device')
            current=result['pip']
        store.set_paused(pip['id'],False,'other-device',expected_lifecycle_revision=current['lifecycle_revision'])

    def test_archive_restore_preserves_evidence_and_never_resumes(self):
        self.setup_source(); before=copy.deepcopy(self.store.run(self.source_run['id']))
        result=self.change()
        self.assertEqual(result['pip']['status'],'archived')
        self.assertEqual(result['receipt']['status_before'],'active')
        self.assertEqual(result['pip']['lifecycle_revision'],1)
        self.assertEqual(self.store.run(self.source_run['id']),before)
        self.assertIn(self.source['id'],[p['id'] for p in self.store.list(self.workspace['id'])])
        reviewed=pip_checkpoints.review_finding(self.store,self.source_run['id'],0,'accepted',0,'user','Historical assessment')
        self.assertEqual(reviewed['findings'][0]['review']['status'],'accepted')
        restored=self.change(archived=False,key='restore')
        self.assertEqual(restored['pip']['status'],'paused')
        self.assertEqual(restored['pip']['lifecycle_revision'],2)
        self.assertEqual(len(self.store.runs(self.source['id'])),1)
        self.assertEqual(restored['pip']['current_version'],self.source['current_version'])

    def test_exact_retry_is_historical_and_does_not_rearchive(self):
        self.setup_source(); first=self.change()
        self.change(archived=False,key='restore')
        retried=self.change(expected_lifecycle_revision=0)
        self.assertTrue(retried['replayed'])
        self.assertEqual(retried['receipt'],first['receipt'])
        self.assertEqual(retried['pip']['status'],'paused')
        with self.assertRaisesRegex(RegistryError,'retry key'):self.change(reason='Changed reason',expected_lifecycle_revision=0)
        with self.assertRaises(RegistryError):self.change(archived=False,key='archive',expected_lifecycle_revision=0)
        with self.assertRaises(RegistryError):self.change(pip=self.target,key='archive')

    def test_job_and_lifecycle_cas_catch_status_aba(self):
        self.setup_source()
        self.store.set_paused(self.source['id'],True,'device')
        self.store.set_paused(self.source['id'],False,'device')
        self.assertEqual(self.store.get(self.source['id'])['lifecycle_revision'],2)
        with self.assertRaisesRegex(RegistryError,'changed'):self.change(expected_lifecycle_revision=0)
        with self.assertRaisesRegex(RegistryError,'changed'):self.change(expected_version=2)
        with self.assertRaises(RegistryError):self.change(expected_lifecycle_revision=True)

    def test_archived_refuses_new_work_and_direct_pause_resume_before_source_io(self):
        self.setup_source(); self.change()
        with patch.object(pips,'source_revision',side_effect=AssertionError('No archived source preparation')):
            for operation in (lambda:self.store.enqueue(self.source['id'],'new','device',self.cfg),
                              lambda:pip_chat.send(self.store,self.source['id'],'Hi','new-chat','device',self.cfg),
                              lambda:self.store.set_paused(self.source['id'],True,'device'),
                              lambda:self.store.set_paused(self.source['id'],False,'device'),
                              lambda:self.store.propose(self.source['id'],1,{'goal':'Changed'},'device'),
                              lambda:self.propose()):
                with self.assertRaisesRegex(RegistryError,'archived'):operation()
        old=self.store.enqueue(self.source['id'],'source-audit','device',self.cfg)
        self.assertEqual(old['id'],self.source_run['id']);self.assertEqual(old['status'],'succeeded')
        self.assertIsNone(self.store.claim_next())

    def test_restored_resume_requires_fresh_explicit_lifecycle_pin(self):
        self.setup_source(); self.change(); self.change(archived=False,key='restore')
        with self.assertRaisesRegex(RegistryError,'revision'):self.store.set_paused(self.source['id'],False,'device')
        with self.assertRaisesRegex(RegistryError,'changed'):self.store.set_paused(self.source['id'],False,'device',expected_lifecycle_revision=0)
        self.assertEqual(self.store.set_paused(self.source['id'],False,'device',expected_lifecycle_revision=2)['status'],'active')

    def test_every_nonterminal_run_blocks_without_cancellation(self):
        self.setup_source(); run=self.store.enqueue(self.target['id'],'work','device',self.cfg)
        for status in ('queued','running','cancelling','waiting','waiting_approval'):
            self.registry.db.execute('UPDATE pip_runs SET status=? WHERE id=?',(status,run['id']))
            with self.subTest(status=status),self.assertRaisesRegex(RegistryError,'Finish or explicitly cancel'):
                self.change(self.target)
            self.assertEqual(self.store.run(run['id'])['status'],status)
            self.assertEqual(self.store.get(self.target['id'])['status'],'active')

    def test_pending_job_or_orphan_proposal_blocks_archive(self):
        self.setup_source(); proposal=self.store.propose(self.source['id'],1,{'goal':'Changed'},'device')
        with self.assertRaisesRegex(RegistryError,'pending job'):self.change()
        self.registry.db.execute('DELETE FROM pip_approvals WHERE proposal_id=?',(proposal['id'],))
        with self.assertRaisesRegex(RegistryError,'pending job'):self.change()
        self.assertEqual(self.registry.db.execute('SELECT status FROM pip_proposals WHERE id=?',(proposal['id'],)).fetchone()[0],'proposed')

    def test_pending_incoming_and_outgoing_handoffs_block_until_reviewed(self):
        self.setup_source(); handoff=self.propose()
        for pip in (self.source,self.target):
            with self.assertRaisesRegex(RegistryError,'incoming and outgoing'):self.change(pip)
        handoffs.reject(self.store,handoff['id'],0,'device','Do not proceed')
        self.assertEqual(self.change()['pip']['status'],'archived')
        self.assertEqual(handoffs.get(self.store,handoff['id'])['status'],'rejected')

    def test_preparation_rechecks_lifecycle_after_archive_restore_aba_without_db_lock(self):
        self.setup_source(); real=pips.source_revision; called=[]
        def changed(*args):
            if not called:
                called.append(True)
                with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as second:
                    self.cycle(self.target,pips.PipStore(second))
            return real(*args)
        with patch.object(pips,'source_revision',side_effect=changed):
            with self.assertRaisesRegex(RegistryError,'lifecycle changed'):
                self.store.enqueue(self.target['id'],'raced','device',self.cfg)
        self.assertEqual(self.store.runs(self.target['id']),[])

    def test_handoff_proposal_preparation_rechecks_lifecycle_aba(self):
        self.setup_source(); real=handoffs._current
        def changed(*args):
            self.cycle(self.target)
            return real(*args)
        with patch.object(handoffs,'_current',side_effect=changed):
            with self.assertRaisesRegex(RegistryError,'lifecycle changed'):self.propose()
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0],0)

    def test_offline_archival_consumes_due_schedule_without_changing_anchor(self):
        self.setup_source()
        proposal=self.store.propose(self.target['id'],1,{'schedule':{'type':'interval','minutes':5}},'device')
        self.store.accept(self.target['id'],proposal['id'],1,'device')
        before=dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?',(self.target['id'],)).fetchone())
        self.change(self.target)
        self.now='2026-10-01T11:00:00.000Z'
        result=self.change(self.target,False,'restore')
        state=dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?',(self.target['id'],)).fetchone())
        self.assertEqual(state['anchor_at'],before['anchor_at'])
        self.assertEqual(state['next_due_at'],'2026-10-01T11:05:00.000Z')
        self.assertEqual(state['last_due_at'],self.now)
        self.store.set_paused(self.target['id'],False,'device',expected_lifecycle_revision=result['pip']['lifecycle_revision'])
        from dgc.pip_schedules import tick
        self.assertEqual(tick(self.registry,self.cfg,now=self.now)['enqueued'],0)

    def test_offline_one_shot_is_consumed_not_revived(self):
        self.setup_source()
        proposal=self.store.propose(self.target['id'],1,{'schedule':{'type':'once','at':'2026-10-01T10:10:00.000Z'}},'device')
        self.store.accept(self.target['id'],proposal['id'],1,'device')
        self.change(self.target);self.now='2026-10-01T11:00:00.000Z'
        self.change(self.target,False,'restore')
        self.assertIsNone(self.registry.db.execute('SELECT next_due_at FROM pip_schedule_state WHERE pip_id=?',(self.target['id'],)).fetchone()[0])

    def test_two_connection_archive_cas_records_one_transition(self):
        self.setup_source(); barrier=threading.Barrier(2)
        def one(index):
            with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as registry:
                barrier.wait(timeout=5)
                try:return archive.transition(pips.PipStore(registry),self.source['id'],archived=True,expected_version=1,
                    expected_lifecycle_revision=0,request_key=f'race-{index}',reason='Concurrent review',actor='device')
                except RegistryError as exc:return exc.code
        with ThreadPoolExecutor(max_workers=2) as pool:result=list(pool.map(one,range(2)))
        self.assertEqual(sum(isinstance(x,dict) for x in result),1);self.assertIn('conflict',result)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_archive_requests').fetchone()[0],1)

    def test_schema14_upgrade_retains_exact_existing_evidence_and_rolls_back(self):
        self.setup_source()
        tables=('pips','pip_versions','pip_runs','pip_checkpoints','workspace_context_entries')
        before={table:[tuple(row) for row in self.registry.db.execute('SELECT * FROM '+table)] for table in tables}
        drop_archive_schema(self.registry.db);self.registry.db.execute('PRAGMA user_version=14')
        with patch.object(archive,'SCHEMA',archive.SCHEMA+'\nSELECT * FROM missing_archive_fixture;'),self.assertRaises(sqlite3.OperationalError):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0],14)
        self.assertIsNone(self.registry.db.execute("SELECT name FROM sqlite_master WHERE name='pip_lifecycle_state'").fetchone())
        with WorkspaceRegistry(self.registry.directory) as migrated:
            self.assertEqual(migrated.db.execute('PRAGMA user_version').fetchone()[0],SCHEMA_VERSION)
            self.assertEqual({table:[tuple(row) for row in migrated.db.execute('SELECT * FROM '+table)] for table in tables},before)
            self.assertEqual(archive.revision(migrated,self.source['id']),0)


if __name__=='__main__':unittest.main()
