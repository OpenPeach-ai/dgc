"""Offline exact approval, native command receipt and reservation authority tests."""
import copy
import hashlib
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pips, pip_approvals, pip_execution as execution, pip_pulse_plans as plans, pip_schedules
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, identifier
from tests import test_pips_local as fixtures


SNAPSHOT={'sha256':'a'*64,'files':1,'bytes':4}


def plan(count=2):
    return plans.validate_plan({'schema_version':1,'action':{'kind':'test','tests':[{'argv':['/usr/bin/python3','-c',f'print({i})'],'cwd':'.'} for i in range(count)]}})


def outcome(manifest,index=0,status='passed',code=0):
    test=manifest['job']['verification_plan']['action']['tests'][index]
    return {'index':index,**copy.deepcopy(test),'status':status,'exit_code':code,'output':'','output_truncated':False,
            'artifact':{'path':f'artifacts/test-{index+1}.txt','sha256':hashlib.sha256(b'').hexdigest(),'bytes':0}}


class PulsePlanTests(unittest.TestCase):
    setUp=fixtures.LocalPipsTests.setUp

    def approved(self, *, count=2,schedule=None, disposition='approved'):
        job=self.store.create(self.workspace['id'],'Verifier','Check the committed source.','human',pip_type='pulse')
        body=json.loads(self.registry.db.execute('SELECT definition FROM pip_versions WHERE pip_id=?',(job['id'],)).fetchone()[0])
        body.update(verification_plan=plan(count),schedule=pip_schedules.validate_schedule(schedule),trigger='schedule' if schedule else 'manual')
        raw=pips._json(body); now=self.registry.clock(); pid=identifier('proposal')
        with self.registry.transaction():
            self.registry.db.execute('INSERT INTO pip_proposals VALUES(?,?,?,?,?,?,?,?)',(pid,job['id'],1,raw,'human','Reviewed exact commands','proposed',now))
            prop=self.registry.db.execute('SELECT * FROM pip_proposals WHERE id=?',(pid,)).fetchone()
            aid=pip_approvals.create(self.registry,prop,self.workspace['id'])
            if disposition!='pending':
                row=self.registry.db.execute('SELECT * FROM pip_approvals WHERE id=?',(aid,)).fetchone()
                pip_approvals.resolve(self.registry,row,disposition,'human',now)
                self.registry.db.execute('UPDATE pip_proposals SET status=? WHERE id=?',('accepted' if disposition=='approved' else disposition,pid))
            # This helper isolates lineage validation independently from the
            # separate core integration: invalid disposition intentionally pins
            # a version that was NOT actually approved and must be refused.
            self.registry.db.execute('INSERT INTO pip_versions VALUES(?,?,?,?,?,?)',(job['id'],2,raw,'human','Reviewed exact commands',now))
            self.registry.db.execute('UPDATE pips SET current_version=2 WHERE id=?',(job['id'],))
        return {**job,**body,'current_version':2},aid

    def manifest(self, job, *, scheduled=False):
        binding=self.registry.binding(self.workspace['id'])
        value={'schema_version':1,'pip_type':'pulse','run_kind':'test','job_version':2,
               'job':{k:job[k] for k in plans.JOB_FIELDS}, 'source_policy':{'mode':'committed_only'},
               'source_revision':'1'*40,'source_snapshot':None,'workspace_id':self.workspace['id'],'pip_id':job['id'],
               'runner_id':self.registry.runner_id,'binding_id':binding['id'],'model':None,'model_settings':None,
               'tools':[],'policy':'review_required','policy_digest':execution.action_digest(job['verification_plan']['action']),
               'trigger':'schedule' if scheduled else 'manual','requested_by':'local-scheduler' if scheduled else 'human'}
        request={'expected_version':2,'expected_lifecycle_revision':0,'expected_plan_digest':plans.plan_digest(job['verification_plan']),
                 'actor':'human','idempotency_key':'pulse-fixture'}
        occurrence=None
        if scheduled:
            first=pip_schedules.next_due(job['schedule'],self.registry.clock(),self.registry.clock())
            due=pip_schedules.plan_due(job['schedule'],first,first,self.registry.clock())
            occurrence={'job_version':2,**{k:due[k] for k in ('expected_next_due','scheduled_at','next_due_at','checked_at')}}
            value.update(schedule=job['schedule'],scheduled_at=due['scheduled_at'])
        with self.registry.transaction():
            value['pulse_verification']=plans.pin(self.store,job,value,manual_request=None if scheduled else request,
                                                  schedule_occurrence=occurrence,anchor_at=self.registry.clock() if scheduled else None)
        return value,request,occurrence

    def queued(self, *, count=2,status='running'):
        job,_=self.approved(count=count); manifest,request,_=self.manifest(job); rid=identifier('run')
        self.registry.db.execute('''INSERT INTO pip_runs(id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at)
          VALUES(?,?,?,?,?,?,?,?,?)''',(rid,job['id'],self.workspace['id'],manifest['binding_id'],request['idempotency_key'],'human',pips._json(manifest),status,self.registry.clock()))
        return job,rid,manifest,request

    def row(self,rid):
        return self.registry.db.execute('SELECT * FROM pip_runs WHERE id=?',(rid,)).fetchone()

    def test_canonical_no_model_grant_and_original_approval(self):
        job,rid,m,request=self.queued()
        self.assertFalse(m['pulse_verification']['model']['invoked'])
        with patch.object(self.registry,'binding',side_effect=AssertionError('Historical read must not inspect live binding')):
            self.assertEqual(plans.validate_parent(SimpleNamespace(db=self.registry.db),self.row(rid),m),m['pulse_verification'])
        self.assertTrue(plans.validate_retry(self.row(rid),manual_request=request))
        self.assertIsNone(m['model']); self.assertIsNone(m['model_settings'])

    def test_pending_rejected_and_expired_cannot_grant(self):
        for state in ('pending','rejected','expired'):
            with self.subTest(state=state):
                job,_=self.approved(disposition=state)
                with self.assertRaises(RegistryError): self.manifest(job)

    def test_self_resigned_grant_cannot_replace_original_job(self):
        _,rid,m,_=self.queued(); m=copy.deepcopy(m); m['job']['goal']='Forged goal'
        with self.assertRaises(RegistryError): plans.validate_parent(SimpleNamespace(db=self.registry.db),self.row(rid),m)

    def test_each_manual_retry_pin_and_actor_is_exact(self):
        _,rid,m,request=self.queued()
        for field in request:
            bad={**request,field:3 if field.startswith('expected_') and field!='expected_plan_digest' else 'b'*64}
            with self.subTest(field=field),self.assertRaises(RegistryError): plans.validate_retry(self.row(rid),manual_request=bad)
        for field,value in (('requested_by','another-human'),('idempotency_key','another-key'),('workspace_id','ws_'+'f'*32)):
            with self.subTest(row_field=field),self.assertRaises(RegistryError):
                plans.validate_retry({**dict(self.row(rid)),field:value},manual_request=request)

    def test_legacy_retry_does_not_acquire_pulse_structural_limits(self):
        legacy={'run_kind':'audit','job_version':1,'historical_counter':2**53}
        self.assertFalse(plans.validate_retry({'manifest':pips._json(legacy)}))
        with self.assertRaises(RegistryError):
            plans.validate_retry({'manifest':pips._json(legacy)},manual_request={})

    def test_standalone_retry_still_rejects_duplicate_json_fields(self):
        _,rid,manifest,request=self.queued()
        raw=pips._json(manifest)
        duplicate='{"run_kind":"test",'+raw[1:]
        with self.assertRaises(RegistryError):
            plans.validate_retry({**dict(self.row(rid)),'manifest':duplicate},manual_request=request)

    def test_history_survives_move_and_new_version_but_current_refuses(self):
        job,rid,m,request=self.queued()
        self.registry.db.execute('UPDATE bindings SET canonical_root=?,updated_at=? WHERE id=?',('/unavailable/historical','2026-10-02T00:00:00.000Z',m['binding_id']))
        self.registry.db.execute('UPDATE pips SET current_version=3 WHERE id=?',(job['id'],))
        self.assertIsNotNone(plans.validate_parent(SimpleNamespace(db=self.registry.db),self.row(rid),m))
        self.assertTrue(plans.validate_retry(self.row(rid),manual_request=request))
        with self.assertRaises(RegistryError) as exc: plans.require_current(self.registry,self.row(rid),m)
        self.assertEqual(exc.exception.code,'stale_grant')

    def test_lifecycle_aba_does_not_rearm_old_manual_request(self):
        job,rid,m,request=self.queued()
        self.registry.db.execute("UPDATE pips SET status='paused' WHERE id=?",(job['id'],))
        self.registry.db.execute("UPDATE pips SET status='active' WHERE id=?",(job['id'],))
        with self.assertRaises(RegistryError): plans.require_current(self.registry,self.row(rid),m)
        self.assertTrue(plans.validate_retry(self.row(rid),manual_request=request))
        with self.assertRaises(RegistryError): self.manifest(job)

    def test_foreign_runner_binding_is_historical_only(self):
        _,rid,m,_=self.queued()
        foreign='runner_'+'f'*32
        self.registry.db.execute('UPDATE bindings SET runner_id=? WHERE id=?',(foreign,m['binding_id']))
        m=copy.deepcopy(m);m['runner_id']=foreign;grant=m['pulse_verification'];grant['runner_id']=foreign
        grant['binding_digest']=plans._binding(self.registry,m['binding_id'],m['workspace_id'],foreign)
        grant['digest']=plans._grant_digest({k:v for k,v in grant.items() if k!='digest'})
        self.assertIsNotNone(plans.validate_parent(SimpleNamespace(db=self.registry.db),self.row(rid),m))
        with self.assertRaises(RegistryError) as exc:plans.require_current(self.registry,self.row(rid),m)
        self.assertEqual(exc.exception.code,'stale_grant')

    def test_every_existing_calendar_and_forged_cursor_membership(self):
        for schedule in ({'type':'interval','minutes':5},{'type':'daily','time':'10:05','timezone':'UTC'},
                         {'type':'once','at':'2026-10-01T10:05:00Z'},{'type':'cron','cron':'5 10 * * *','timezone':'UTC'}):
            with self.subTest(schedule=schedule):
                job,_=self.approved(schedule=schedule); m,_,occ=self.manifest(job,scheduled=True)
                self.assertEqual(plans.validate_manifest(m)['request']['occurrence']['scheduled_at'],occ['scheduled_at'])
                m=copy.deepcopy(m); g=m['pulse_verification']; g['request']['occurrence']['expected_next_due']='2026-10-01T10:04:00.000Z'
                g['digest']=plans._grant_digest({k:v for k,v in g.items() if k!='digest'})
                with self.assertRaises(RegistryError): plans.validate_manifest(m)

    def test_closed_plan_source_role_and_no_expanded_permissions(self):
        for change in ({'network':True},{'environment':{}},{'write_paths':['x']},{'specialists':{}},{'limits':{}}):
            bad=plan(); bad['action'].update(change)
            with self.subTest(change=change),self.assertRaises(RegistryError): plans.validate_plan(bad)
        for role,source,event in (('patch',{'mode':'committed_only'},None),('pulse',{'mode':'current_tree','exclusions':'safe_source_v1'},None),('pulse',{'mode':'committed_only'},{'events':['context_updated']})):
            with self.assertRaises(RegistryError): plans.validate_job(pip_type=role,plan=plan(),source_policy=source,schedule=None,event_trigger=event)
        self.assertIsNone(plans.validate_plan(None))

    def test_hostile_structure_and_bytes_before_json_serialization(self):
        cycle={}; cycle['cycle']=cycle
        for bad in (cycle,{'schema_version':True,'action':{}},{'schema_version':1,'action':{'kind':'test','tests':[{'argv':['x'*50000],'cwd':'.'}]}}, {'schema_version':1,'action':{'kind':'test','tests':[{'argv':['\ud800'],'cwd':'.'}]}}):
            with self.subTest(kind=type(bad).__name__),self.assertRaises(RegistryError): plans.validate_plan(bad)
        with patch.object(plans.json,'dumps',side_effect=AssertionError('Unbounded data reached serializer')), self.assertRaises(RegistryError):
            plans.validate_plan({'huge':'x'*(plans.MAX_PLAN_BYTES+1)})

    def test_missing_mixed_grants_and_provider_fields_refuse(self):
        _,_,m,_=self.queued()
        cases=[]
        bad=copy.deepcopy(m); del bad['pulse_verification']; cases.append(bad)
        for key,value in (('handoff',{}),('model','fixture'),('model_settings',{}),('tools',['read_file']),('policy','read_only'),('pip_memory',{}),('workspace_context',{})):
            cases.append({**m,key:value})
        for bad in cases:
            with self.assertRaises(RegistryError): plans.validate_manifest(bad)
        self.assertIsNone(plans.validate_manifest({'run_kind':'audit'}))

    def test_progress_requires_snapshot_and_strict_sequential_reservation(self):
        _,rid,m,_=self.queued()
        with self.assertRaises(RegistryError): plans.reserve_command(self.registry,rid,0)
        initial=plans.initialize_progress(self.registry,rid,SNAPSHOT)
        self.assertEqual(initial,plans.initialize_progress(self.registry,rid,SNAPSHOT))
        with self.assertRaises(RegistryError): plans.reserve_command(self.registry,rid,1)
        plans.reserve_command(self.registry,rid,0)
        with self.assertRaises(RegistryError): plans.reserve_command(self.registry,rid,0)
        with self.assertRaises(RegistryError): plans.initialize_progress(self.registry,rid,SNAPSHOT)
        completed=plans.complete_command(self.registry,rid,0,outcome(m))
        self.assertEqual(completed,plans.complete_command(self.registry,rid,0,outcome(m)))
        with self.assertRaises(RegistryError): plans.complete_command(self.registry,rid,0,outcome(m,status='failed',code=1))
        plans.reserve_command(self.registry,rid,1); completed=plans.complete_command(self.registry,rid,1,outcome(m,1,status='failed',code=1))
        sealed=plans.seal_receipt(completed,m,run_status='succeeded',terminal_reason='complete')
        self.assertEqual(sealed['commands'][1]['outcome']['status'],'failed')

    def test_cancel_before_spawn_not_started_and_reserved_crash_unknown(self):
        _,rid,m,_=self.queued()
        initial=plans.initial_receipt(m)
        cancelled=plans.seal_receipt(initial,m,run_status='cancelled',terminal_reason='cancelled')
        self.assertTrue(all(c['launch_state']=='not_started' for c in cancelled['commands']))
        plans.initialize_progress(self.registry,rid,SNAPSHOT); reserved=plans.reserve_command(self.registry,rid,0)
        interrupted=plans.seal_receipt(reserved,m,run_status='failed',terminal_reason='interrupted')
        self.assertEqual(interrupted['commands'][0],{'index':0,'launch_state':'launch_reserved','outcome':None})
        self.registry.db.execute("UPDATE pip_runs SET status='cancelling' WHERE id=?",(rid,))
        complete=plans.complete_command(self.registry,rid,0,outcome(m,status='cancelled',code=None))
        sealed=plans.seal_receipt(complete,m,run_status='cancelled',terminal_reason='cancelled')
        self.assertIsNone(sealed['commands'][0]['outcome']['exit_code'])
        with self.assertRaises(RegistryError): plans.reserve_command(self.registry,rid,1)

    def test_withdrawal_does_not_prevent_recording_a_process_fact(self):
        job,rid,m,_=self.queued(); plans.initialize_progress(self.registry,rid,SNAPSHOT); plans.reserve_command(self.registry,rid,0)
        self.registry.db.execute("UPDATE pips SET status='paused' WHERE id=?",(job['id'],))
        plans.complete_command(self.registry,rid,0,outcome(m))
        with self.assertRaises(RegistryError): plans.reserve_command(self.registry,rid,1)

    def test_transaction_rollback_retains_reservation_unknown(self):
        _,rid,m,_=self.queued(); plans.initialize_progress(self.registry,rid,SNAPSHOT); plans.reserve_command(self.registry,rid,0)
        before=self.row(rid)['result']
        with self.assertRaises(RuntimeError),self.registry.transaction():
            plans.complete_command(self.registry,rid,0,outcome(m)); raise RuntimeError('injected commit failure')
        self.assertEqual(before,self.row(rid)['result'])

    def test_two_connections_cannot_reserve_same_invocation(self):
        _,rid,_,_=self.queued(); plans.initialize_progress(self.registry,rid,SNAPSHOT)
        barrier=threading.Barrier(2); results=[]
        def reserve():
            with WorkspaceRegistry(self.registry.directory) as registry:
                barrier.wait()
                try: plans.reserve_command(registry,rid,0); results.append('reserved')
                except RegistryError: results.append('refused')
        threads=[threading.Thread(target=reserve) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join(10)
        self.assertEqual(sorted(results),['refused','reserved'])

    def test_forged_outcomes_and_terminal_mutation_refuse(self):
        _,rid,m,_=self.queued(count=1); plans.initialize_progress(self.registry,rid,SNAPSHOT); plans.reserve_command(self.registry,rid,0)
        for field,value in (('argv',['echo','forged']),('index',True),('exit_code',True),('exit_code',None),('output','x'*4097),('artifact',{'path':'../x','sha256':'a'*64,'bytes':0})):
            with self.subTest(field=field),self.assertRaises(RegistryError): plans.complete_command(self.registry,rid,0,{**outcome(m),field:value})
        value=plans.complete_command(self.registry,rid,0,outcome(m)); sealed=plans.seal_receipt(value,m,run_status='succeeded',terminal_reason='complete')
        self.registry.db.execute("UPDATE pip_runs SET result=?,status='succeeded' WHERE id=?",(pips._json(sealed),rid))
        with self.assertRaises(RegistryError): plans.complete_command(self.registry,rid,0,outcome(m))
        with self.assertRaises(RegistryError): plans.seal_receipt(sealed,m,run_status='failed',terminal_reason='interrupted')

    def test_bounded_corrupt_stored_progress_refuses_before_load(self):
        _,rid,_,_=self.queued(); self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?',('x'*65537,rid))
        with patch.object(plans,'_load',side_effect=AssertionError('Oversize reached decoder')),self.assertRaises(RegistryError):
            plans.initialize_progress(self.registry,rid,SNAPSHOT)


if __name__=='__main__': unittest.main()
