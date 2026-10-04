"""Independent archival ABA checks on native lifecycle authority."""
import hashlib
import json
import unittest
from unittest.mock import patch

from dgc import pip_archive, pip_lifecycle_tool as lifecycle
from dgc.tools import TOOL_SCHEMAS
from dgc.workspace_registry import RegistryError, identifier
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_pip_lifecycle_tool as fixtures


class ArchiveLifecycleAuthorityTests(unittest.TestCase):
    setUp = fixtures.PipLifecycleToolTests.setUp
    create = fixtures.PipLifecycleToolTests.create
    context = fixtures.PipLifecycleToolTests.context
    args = fixtures.PipLifecycleToolTests.args
    call = fixtures.PipLifecycleToolTests.call

    def cycle(self, pip_id):
        for archived, key in ((True,'archive-once'),(False,'restore-once')):
            job=self.store.get(pip_id)
            pip_archive.transition(self.store,pip_id,archived=archived,expected_version=job['current_version'],
                expected_lifecycle_revision=job['lifecycle_revision'],request_key=key,reason='Reviewed lifecycle change',actor='user')

    def test_old_unsent_resume_cannot_activate_restored_paused_pip(self):
        args=self.args();self.cycle(args['pip_id'])
        with self.assertRaisesRegex(RegistryError,'lifecycle changed'):
            self.call('resume_pip',args)
        job=self.store.get(args['pip_id'])
        self.assertEqual(job['status'],'paused');self.assertEqual(job['current_version'],1)
        self.assertEqual(job['lifecycle_revision'],2)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_lifecycle_requests').fetchone()[0],0)
        current={**args,'expected_lifecycle_revision':2}
        result=self.call('resume_pip',current)
        self.assertEqual(result['current']['status'],'active')
        self.assertEqual(result['receipt']['lifecycle_revision_before'],2)
        self.assertEqual(result['receipt']['lifecycle_revision_after'],3)

    def test_old_unsent_attachment_cannot_cross_archive_restore(self):
        args=self.args();self.cycle(args['pip_id'])
        with self.assertRaisesRegex(RegistryError,'lifecycle changed'):
            self.call('attach_pip_to_session',args)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM session_pip_attachments').fetchone()[0],0)

    def test_exact_new_retry_is_historical_after_archive_restore(self):
        args=self.args(); first=self.call('pause_pip',args)
        self.cycle(args['pip_id'])
        retried=self.call('pause_pip',args)
        self.assertTrue(retried['replayed']);self.assertFalse(retried['state_changed_by_this_call'])
        self.assertEqual(retried['receipt'],first['receipt'])
        self.assertEqual(retried['current']['lifecycle_revision'],3)
        self.assertEqual(retried['current']['status'],'paused')

    def test_status_change_during_supervisor_check_is_rechecked_under_transaction(self):
        args=self.args()
        self.supervisor.side_effect=lambda _config:self.cycle(args['pip_id'])
        with self.assertRaisesRegex(RegistryError,'lifecycle changed'):
            self.call('resume_pip',args)
        self.assertEqual(self.store.get(args['pip_id'])['status'],'paused')

    def test_missing_pin_refuses_new_requests_without_supervisor_or_side_effect(self):
        args=self.args();args.pop('expected_lifecycle_revision')
        for op in lifecycle.OPERATIONS:
            with self.subTest(op=op),self.assertRaisesRegex(RegistryError,'expected_lifecycle_revision'):
                self.call(op,args)
        self.supervisor.assert_not_called()
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_lifecycle_requests').fetchone()[0],0)

    def test_exact_legacy_retry_remains_readable_without_a_new_mutation(self):
        args=self.args();args.pop('expected_lifecycle_revision')
        ctx=self.context();origin=ctx.pip_proposal_origin()
        receipt={'id':identifier('lifecycle'),'operation':'pause_pip','pip_id':args['pip_id'],
            'workspace_id':self.workspace['id'],'job_version':1,'reason':args['reason'],'created_at':self.registry.clock(),
            'status_before':'active','status_after':'paused','attached':False,'attached_version':None,'changed':True}
        digest=hashlib.sha256(lifecycle._json({'operation':'pause_pip',**args}).encode()).hexdigest()
        self.registry.db.execute('INSERT INTO pip_lifecycle_requests VALUES(?,?,?,?,?,?,?,?)',
            (receipt['id'],origin['session_id'],args['request_key'],digest,'pause_pip',args['pip_id'],self.workspace['id'],lifecycle._json(receipt)))
        self.cycle(args['pip_id'])
        result=self.call('pause_pip',args,ctx)
        self.assertEqual(result['receipt'],receipt);self.assertTrue(result['replayed'])
        self.assertEqual(result['current']['lifecycle_revision'],2)
        self.assertFalse(result['state_changed_by_this_call'])
        with self.assertRaisesRegex(RegistryError,'expected_lifecycle_revision'):
            self.call('pause_pip',{**args,'request_key':'fresh'},ctx)

    def test_invalid_or_removed_pin_cannot_alias_new_receipt(self):
        args=self.args();self.call('pause_pip',args)
        for value in (None,True,-1,0.5,2**53,'0'):
            with self.subTest(value=value),self.assertRaises(RegistryError):
                self.call('pause_pip',{**args,'expected_lifecycle_revision':value})
        old={k:v for k,v in args.items() if k!='expected_lifecycle_revision'}
        with self.assertRaisesRegex(RegistryError,'different lifecycle'):
            self.call('pause_pip',old)

    def test_each_discovered_native_lifecycle_schema_requires_exact_pin(self):
        for name in lifecycle.OPERATIONS:
            schema=next(item['function']['parameters'] for item in TOOL_SCHEMAS if item['function']['name']==name)
            self.assertIn('expected_lifecycle_revision',schema['required'])
            self.assertEqual(schema['properties']['expected_lifecycle_revision']['maximum'],2**53-1)

    def test_main_chat_can_read_the_new_pin_before_requesting_a_change(self):
        from dgc import pip_context_tool
        args=self.args();self.cycle(args['pip_id'])
        with patch.object(pip_context_tool,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory)):
            definition=json.loads(pip_context_tool.read({'action':'definition','pip_id':args['pip_id']},self.context()))
            listing=json.loads(pip_context_tool.read({'action':'list'},self.context()))
        self.assertEqual(definition['pip']['lifecycle_revision'],2)
        self.assertEqual(listing['pips'][0]['lifecycle_revision'],2)

    def test_offline_archive_restore_consumes_time_schedule_backlog(self):
        from dgc.pip_schedules import plan_due
        job=self.create()
        proposal=self.store.propose(job['id'],1,{'schedule':{'type':'interval','minutes':5}},'user')
        self.store.accept(job['id'],proposal['id'],1,'user')
        initial=dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?',(job['id'],)).fetchone())
        current=self.store.get(job['id'])
        pip_archive.transition(self.store,job['id'],archived=True,expected_version=2,
            expected_lifecycle_revision=current['lifecycle_revision'],request_key='archive-time',reason='Idle',actor='user')
        self.registry.clock=lambda:'2026-10-01T11:01:00.000Z'
        current=self.store.get(job['id'])
        pip_archive.transition(self.store,job['id'],archived=False,expected_version=2,
            expected_lifecycle_revision=current['lifecycle_revision'],request_key='restore-time',reason='Review first',actor='user')
        state=dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?',(job['id'],)).fetchone())
        self.assertEqual(state['anchor_at'],initial['anchor_at'])
        self.assertIsNone(plan_due(self.store.get(job['id'])['schedule'],state['next_due_at'],self.registry.clock(),state['anchor_at']))
        self.assertGreater(state['next_due_at'],self.registry.clock())
        self.assertEqual(self.store.get(job['id'])['status'],'paused')

    def test_supervisor_readiness_does_not_wake_for_archived_time_or_event_jobs(self):
        from dgc.pip_schedules import has_due_schedule
        from dgc.pip_event_triggers import has_due_trigger
        for field,spec in (('schedule',{'type':'interval','minutes':5}),
                           ('event_trigger',{'events':['context_updated'],'minimum_minutes':5,'missed_policy':'coalesce_latest'})):
            job=self.create()
            proposal=self.store.propose(job['id'],1,{field:spec},'user')
            self.store.accept(job['id'],proposal['id'],1,'user')
            current=self.store.get(job['id'])
            pip_archive.transition(self.store,job['id'],archived=True,expected_version=2,
                expected_lifecycle_revision=current['lifecycle_revision'],request_key='archive-'+field,reason='Idle',actor='user')
        self.registry.clock=lambda:'2026-10-01T11:01:00.000Z'
        self.assertFalse(has_due_schedule(self.registry))
        self.assertFalse(has_due_trigger(self.registry))
