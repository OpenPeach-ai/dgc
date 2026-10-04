"""Standing Pulse integration in disposable committed workspaces only."""
import copy
import json
import os
import unittest
from unittest.mock import patch

from dgc import pips, pip_pulse_plans as plans, pip_schedules as schedules
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class PulseIntegrationTests(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.now = '2026-10-01T10:00:00.000Z'
        self.registry.clock = lambda:self.now
        self.commit()
        from dgc import pip_execution
        native = {
            'test_real_commands_without_model_and_nonzero_exit_is_retained',
            'test_withdrawal_after_first_command_preserves_final_and_stops_next',
            'test_completion_write_failure_leaves_unknown_and_never_starts_next',
            'test_cancel_after_reservation_before_spawn_is_known_unexecuted',
            'test_export_exact_receipt_without_model_or_registry_mutation',
            'test_public_display_redacts_preview_and_refuses_changed_exact_arguments',
            'test_terminal_event_failure_rolls_back_seal_with_fact_preserved',
            'test_pulse_execution_reference_tool_keeps_whole_command_budget',
        }
        if self._testMethodName in native:
            capability = pip_execution.capability()
            if not capability.get('available'):
                self.skipTest('Actual Linux bubblewrap execution unavailable: '+capability.get('reason','unsupported platform'))
        else:
            # These cases test queue/SQL authority, not sandbox capability.
            gate = patch.object(pip_execution,'capability',return_value={'available':True})
            gate.start();self.addCleanup(gate.stop)

    def create(self):
        return self.store.create(self.workspace['id'],'Verifier','Run reviewed commands.','human',pip_type='pulse')

    def plan(self, tests=None):
        return plans.validate_plan({'schema_version':1,'action':{'kind':'test',
            'tests':tests or [{'argv':['/usr/bin/python3','-c','print("recorded")'],'cwd':'.'}]}})

    def approve(self, job, changes):
        proposal=self.store.propose(job['id'],job['current_version'],changes,'human')
        return self.store.accept(job['id'],proposal['id'],job['current_version'],'human')

    def planned(self, **changes):
        return self.approve(self.create(),{'verification_plan':self.plan(),**changes})

    def request(self, job, key='pulse-1'):
        return {'expected_version':job['current_version'],'expected_lifecycle_revision':job['lifecycle_revision'],
            'expected_plan_digest':job['verification_plan_digest'],'actor':'human','idempotency_key':key}

    def enqueue(self, job, key='pulse-1', request=None):
        return self.store.enqueue(job['id'],key,'human',self.cfg,pulse_request=request or self.request(job,key))

    def raw(self, run):
        return json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?',(run['id'],)).fetchone()[0])

    def test_review_queue_is_command_only_without_model_resolution(self):
        job=self.planned()
        self.cfg.data.update(model='',base_url='',subscription_engine='unavailable')
        with patch.object(pips,'_model_settings',side_effect=AssertionError('No model resolution')):
            run=self.enqueue(job)
        manifest=self.raw(run)
        self.assertIsNone(manifest['model']);self.assertIsNone(manifest['model_settings'])
        self.assertEqual(manifest['tools'],[]);self.assertEqual(manifest['policy'],'review_required')
        self.assertEqual(plans.validate_manifest(manifest)['plan_digest'],job['verification_plan_digest'])
        for key in ('handoff','workspace_context','pip_memory','audit_checkpoint','specialists'):
            self.assertNotIn(key,manifest)

    def test_new_manual_requests_require_exact_pins_and_authority_path(self):
        job=self.planned()
        with self.assertRaises(RegistryError):self.store.enqueue(job['id'],'missing','human',self.cfg)
        for field,value in [('expected_version',1),('expected_lifecycle_revision',True),('expected_plan_digest','0'*64)]:
            request=self.request(job);request[field]=value
            with self.subTest(field=field), patch.object(pips,'source_revision',side_effect=AssertionError('No source preparation')), self.assertRaises(RegistryError):
                self.enqueue(job,request=request)
        with self.assertRaises(RegistryError):
            self.store.enqueue(job['id'],'pulse-1','human',self.cfg,pulse_request=self.request(job),handoff={})

    def test_old_omitted_plan_bytes_and_explicit_plan_removal(self):
        job=self.create()
        original=self.registry.db.execute('SELECT definition FROM pip_versions WHERE pip_id=? AND version=1',(job['id'],)).fetchone()[0]
        self.assertNotIn('verification_plan',json.loads(original))
        self.assertIsNone(job['verification_plan']);self.assertIsNone(job['verification_plan_digest'])
        planned=self.approve(job,{'verification_plan':self.plan()})
        removed=self.approve(planned,{'verification_plan':None})
        self.assertIsNone(removed['verification_plan_digest'])
        self.assertEqual(self.registry.db.execute('SELECT definition FROM pip_versions WHERE pip_id=? AND version=1',(job['id'],)).fetchone()[0],original)

    def test_calendar_requires_plan_and_queues_exact_occurrence(self):
        plain=self.create()
        with self.assertRaises(RegistryError):self.approve(plain,{'schedule':{'type':'interval','minutes':5}})
        job=self.planned(schedule={'type':'interval','minutes':5})
        self.now='2026-10-01T10:15:00.000Z'
        with patch.object(pips,'_model_settings',side_effect=AssertionError('No model resolution')):
            self.assertEqual(schedules.tick(self.registry,self.cfg)['enqueued'],1)
        manifest=self.raw(self.store.runs(job['id'])[0])
        grant=plans.validate_manifest(manifest)
        self.assertEqual(grant['trigger'],'schedule')
        self.assertEqual(grant['request']['occurrence']['scheduled_at'],self.now)

    def test_legacy_unplanned_and_other_roles_cannot_get_standing_grant(self):
        job=self.create()
        with self.assertRaises(RegistryError):self.enqueue(job)
        quill=self.store.create(self.workspace['id'],'Docs','Draft source notes.','human',pip_type='quill')
        with self.assertRaises(RegistryError):self.approve(quill,{'verification_plan':self.plan()})
        with self.assertRaises(RegistryError):self.planned(event_trigger={'events':['context_updated']})

    def execute(self, job, key='pulse-1'):
        run=self.enqueue(job,key)
        row=self.store.claim_next()
        with patch('dgc.agent.Agent',side_effect=AssertionError('No Agent')), patch('dgc.llm.LLMClient',side_effect=AssertionError('No provider')):
            result=pips._execute_run(self.registry,row,self.cfg)
        return self.store.finish(run['id'],result=result)

    def test_real_commands_without_model_and_nonzero_exit_is_retained(self):
        job=self.planned(verification_plan=self.plan([
            {'argv':['/usr/bin/python3','-c','print("first")'],'cwd':'.'},
            {'argv':['/usr/bin/python3','-c','print("tests passed");raise SystemExit(7)'],'cwd':'.'},
            {'argv':['/usr/bin/python3','-c','print("third")'],'cwd':'.'}]))
        source=(self.root/'source.py').read_bytes();before=self.git('status','--porcelain')
        self.cfg.data.update(model='',base_url='',subscription_engine='unavailable')
        run=self.execute(job)
        self.assertEqual(run['status'],'succeeded')
        self.assertEqual(run['command_progress'],{'phase':'terminal','terminal_reason':'complete','passed':2,'failed':1,'stopped':0,'unexecuted':0,'unknown':0,'total':3})
        self.assertEqual([item['outcome']['exit_code'] for item in run['result']['commands']],[0,7,0])
        self.assertEqual((self.root/'source.py').read_bytes(),source);self.assertEqual(self.git('status','--porcelain'),before)
        self.assertIsNone(run['manifest']['model']);self.assertIsNone(run['manifest']['model_settings'])
        from dgc import pip_execution_reviews, pip_context_execution, pip_chat
        self.assertIsNone(pip_execution_reviews.for_run(self.store,run['id']))
        with self.assertRaises(RegistryError):pip_execution_reviews.review(self.store,run['id'],'accepted',0,'human','Review')
        projected=pip_context_execution.projection(self.registry,self.workspace['id'],run['id'],0,2)
        self.assertEqual(projected['next_offset'],2);self.assertNotIn('model_summary_preview',projected)
        reference=pip_chat._last_report(self.store,job['id'])
        self.assertEqual(reference['classification'],'historical_command_outcomes')
        pip_chat.validate_context({'text':'Explain the outcomes','history':[],'history_omitted_count':0,'last_report':reference})

    def test_queued_cancel_and_recovery_preserve_unknown_without_replay(self):
        job=self.planned();run=self.enqueue(job)
        cancelled=self.store.cancel(run['id'],'human')
        self.assertEqual(cancelled['command_progress']['unexecuted'],1)
        self.assertEqual(cancelled['result']['terminal_reason'],'cancelled')
        run=self.enqueue(job,'second');row=self.store.claim_next()
        plans.initialize_progress(self.registry,run['id'],{'sha256':'a'*64,'files':1,'bytes':5})
        plans.reserve_command(self.registry,run['id'],0)
        with patch.object(pips,'_execute_run',side_effect=AssertionError('Never replay')):
            self.assertEqual(self.store.recover(),1)
        recovered=self.store.run(run['id'])
        self.assertEqual(recovered['status'],'failed');self.assertEqual(recovered['command_progress']['unknown'],1)
        self.assertEqual(recovered['result']['terminal_reason'],'interrupted')

    def test_stale_plan_refuses_before_source_and_finishes_with_no_commands(self):
        job=self.planned();run=self.enqueue(job);row=self.store.claim_next()
        self.approve(job,{'verification_plan':None})
        with patch.object(pips,'clean_snapshot',side_effect=AssertionError('No source')),self.assertRaises(RegistryError) as error:
            pips._execute_run(self.registry,row,self.cfg)
        self.assertEqual(error.exception.code,'stale_grant')
        ended=self.store.finish(run['id'],error={'code':error.exception.code,'message':'Stopped'})
        self.assertEqual(ended['result']['terminal_reason'],'stale_grant');self.assertEqual(ended['command_progress']['unexecuted'],1)

    def test_corrupt_grant_and_progress_still_terminalize_and_do_not_block_recovery(self):
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        for corruption in ('missing','mismatch','invalid_progress','oversized_progress'):
            with self.subTest(corruption=corruption):
                job=self.planned();run=self.enqueue(job);row=self.store.claim_next();manifest=self.raw(run)
                if corruption=='missing':manifest.pop('pulse_verification')
                elif corruption=='mismatch':manifest['pulse_verification']['plan_digest']='0'*64
                self.registry.db.execute('UPDATE pip_runs SET manifest=?,result=? WHERE id=?',
                    (json.dumps(manifest),'[]' if corruption=='invalid_progress' else 'x'*70000 if corruption=='oversized_progress' else None,run['id']))
                ended=self.store.finish(run['id'],error={'code':'invalid_pulse_plan','message':'Rejected'})
                self.assertEqual(ended['status'],'failed')
                raw=self.registry.db.execute('SELECT status,result FROM pip_runs WHERE id=?',(run['id'],)).fetchone()
                self.assertEqual(raw['status'],'failed');self.assertIsNone(raw['result'])
        job=self.planned();run=self.enqueue(job);self.store.claim_next()
        self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?',('x'*70000,run['id']))
        good=self.enqueue(self.planned(),'good');self.store.claim_next()
        self.assertEqual(self.store.recover(),2)
        self.assertEqual(self.store.run(good['id'])['result']['terminal_reason'],'interrupted')

    def test_scope_before_decode_and_oversized_progress_refuses(self):
        from dgc.pip_pulse_results import stored
        run=self.enqueue(self.planned())
        self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?',('x'*70000,run['id']))
        with self.assertRaises(RegistryError) as error:stored(self.registry,'ws_'+'f'*32,run['id'])
        self.assertEqual(error.exception.code,'not_found')
        with self.assertRaises(RegistryError) as error:stored(self.registry,self.workspace['id'],run['id'])
        self.assertEqual(error.exception.code,'stored_data_limit')

    def test_withdrawal_after_first_command_preserves_final_and_stops_next(self):
        job=self.planned(verification_plan=self.plan([
            {'argv':['/usr/bin/python3','-c','print("first")'],'cwd':'.'},
            {'argv':['/usr/bin/python3','-c','print("second")'],'cwd':'.'}]))
        run=self.enqueue(job);row=self.store.claim_next();complete=plans.complete_command
        def withdraw(registry,run_id,index,outcome):
            result=complete(registry,run_id,index,outcome)
            self.approve(job,{'verification_plan':None})
            return result
        with patch.object(plans,'complete_command',side_effect=withdraw),self.assertRaises(RegistryError) as error:
            pips._execute_run(self.registry,row,self.cfg)
        self.assertEqual(error.exception.code,'stale_grant')
        ended=self.store.finish(run['id'],error={'code':'stale_grant','message':'Withdrawn'})
        self.assertEqual(ended['command_progress']['passed'],1);self.assertEqual(ended['command_progress']['unexecuted'],1)
        self.assertFalse((self.registry.directory/'runs'/run['id']/'artifacts'/'test-2.txt').exists())
        self.assertEqual(self.enqueue(job)['id'],run['id']) # Exact old request is historical only.

    def test_completion_write_failure_leaves_unknown_and_never_starts_next(self):
        job=self.planned(verification_plan=self.plan([
            {'argv':['/usr/bin/python3','-c','print("first")'],'cwd':'.'},
            {'argv':['/usr/bin/python3','-c','print("second")'],'cwd':'.'}]))
        run=self.enqueue(job);row=self.store.claim_next()
        with patch.object(plans,'complete_command',side_effect=RegistryError('storage_failure','Unavailable')),self.assertRaises(RegistryError):
            pips._execute_run(self.registry,row,self.cfg)
        ended=self.store.finish(run['id'],error={'code':'storage_failure','message':'Unavailable'})
        self.assertEqual(ended['command_progress']['unknown'],1);self.assertEqual(ended['command_progress']['unexecuted'],1)
        self.assertFalse((self.registry.directory/'runs'/run['id']/'artifacts'/'test-2.txt').exists())

    def test_cancel_after_reservation_before_spawn_is_known_unexecuted(self):
        job=self.planned();run=self.enqueue(job);row=self.store.claim_next();reserve=plans.reserve_command
        def stop(registry,run_id,index):
            result=reserve(registry,run_id,index)
            self.store.cancel(run_id,'human')
            return result
        with patch.object(plans,'reserve_command',side_effect=stop),self.assertRaises(RegistryError):
            pips._execute_run(self.registry,row,self.cfg)
        ended=self.store.finish(run['id'],error={'code':'cancelled','message':'Stopped'})
        self.assertEqual(ended['status'],'cancelled');self.assertEqual(ended['command_progress']['unexecuted'],1)
        command=ended['result']['commands'][0]
        self.assertEqual(command['launch_state'],'finished');self.assertEqual(command['outcome']['status'],'cancelled')
        self.assertIsNone(command['outcome']['exit_code'])

    def test_export_exact_receipt_without_model_or_registry_mutation(self):
        import hashlib
        from dgc.pip_export import export_run
        run=self.execute(self.planned());before='\n'.join(self.registry.db.iterdump())
        destination=self.base/'pulse.jsonl'
        if not os.path.isdir('/proc/self/fd'):
            # Documented: the pinned read-only export needs Linux procfs. It must refuse, not degrade.
            with self.assertRaises(RegistryError) as refused:
                export_run(self.cfg,run['id'],destination,directory=self.registry.directory)
            self.assertEqual(refused.exception.code,'unsupported_platform')
            self.assertFalse(destination.exists());self.assertEqual('\n'.join(self.registry.db.iterdump()),before)
            return
        export_run(self.cfg,run['id'],destination,directory=self.registry.directory)
        self.assertEqual('\n'.join(self.registry.db.iterdump()),before)
        lines=destination.read_bytes().splitlines(keepends=True);rows=[json.loads(line) for line in lines]
        self.assertEqual(rows[-1]['data']['sha256'],hashlib.sha256(b''.join(lines[:-1])).hexdigest())
        receipt=next(item['data'] for item in rows if item['type']=='recorded_result')
        self.assertEqual(receipt,run['result'])
        self.assertFalse(any(item['type']=='execution_review' for item in rows))

    def test_public_display_redacts_preview_and_refuses_changed_exact_arguments(self):
        from dgc.pip_pulse_results import prepare_display
        run=self.execute(self.planned(verification_plan=self.plan([{'argv':['/usr/bin/python3','-c','print(chr(122)*17)'],'cwd':'.'}])))
        safe=prepare_display(run,['z'*17])
        self.assertNotIn('z'*17,safe['result']['commands'][0]['outcome']['output'])
        with self.assertRaises(RegistryError):prepare_display(run,['/usr/bin/python3'])
        self.assertEqual(self.store.run(run['id'])['result'],run['result'])

    def test_public_reader_reloads_coherent_bounded_row(self):
        run=self.enqueue(self.planned());old=self.store._transition_row(run['id'])
        self.store.cancel(run['id'],'human')
        current=self.store._run(old,full=False)
        self.assertEqual(current['status'],'cancelled');self.assertEqual(current['command_progress']['phase'],'terminal')
        self.registry.db.execute('UPDATE pip_runs SET result=? WHERE id=?',('x'*70000,run['id']))
        with self.assertRaises(RegistryError) as error:self.store.run(run['id'])
        self.assertEqual(error.exception.code,'stored_data_limit')

    def test_hostile_plan_request_is_bounded_before_generic_serialization(self):
        cyclic={};cyclic['self']=cyclic
        for value in (cyclic, {'huge':'x'*20000}, {'deep':[[[[[[[[[[[[[[0]]]]]]]]]]]]]]}):
            request={'type':'propose_pip_update','request_id':'bounded','pip_id':'unused',
                     'expected_version':1,'changes':{'verification_plan':value}}
            with self.subTest(value_type=type(value).__name__), patch.object(pips,'_json',side_effect=AssertionError('No generic serialization')):
                response=pips.handle_control(self.cfg,request,'human',start_worker=False)
            self.assertFalse(response['ok']);self.assertEqual(response['error']['code'],'invalid_pulse_plan')

    def occurrence(self, job):
        state=job['schedule_state']
        due=schedules.plan_due(job['schedule'],state['next_due_at'],self.now,state['anchor_at'])
        return {**{key:due[key] for key in ('expected_next_due','scheduled_at','next_due_at','checked_at')},
                'job_version':job['current_version']}

    def scheduled_enqueue(self, job, occurrence):
        return self.store.enqueue(job['id'],schedules.occurrence_key(job['current_version'],occurrence['scheduled_at']),
            'local-scheduler',self.cfg,schedule_occurrence=occurrence)

    def test_calendar_cursor_and_queue_rollback_atomically(self):
        job=self.planned(schedule={'type':'interval','minutes':5});self.now='2026-10-01T10:15:00.000Z'
        occurrence=self.occurrence(job);before=dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?',(job['id'],)).fetchone())
        event=self.registry.event
        def fail(workspace,event_type,**fields):
            if event_type=='pip_run_queued':raise RegistryError('fixture_failure','Rollback')
            return event(workspace,event_type,**fields)
        with patch.object(self.registry,'event',side_effect=fail),self.assertRaises(RegistryError):self.scheduled_enqueue(job,occurrence)
        self.assertEqual(self.store.runs(job['id']),[])
        self.assertEqual(dict(self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?',(job['id'],)).fetchone()),before)
        queued=self.scheduled_enqueue(job,occurrence);self.store.cancel(queued['id'],'human')
        self.assertEqual(self.scheduled_enqueue(job,occurrence)['id'],queued['id'])
        self.assertEqual(len(self.store.runs(job['id'])),1)

    def test_concurrent_schedule_retry_compares_all_approved_occurrence_fields(self):
        job=self.planned(schedule={'type':'interval','minutes':5});self.now='2026-10-01T10:15:00.001Z'
        original=self.occurrence(job);original['checked_at']='2026-10-01T10:15:00.000Z'
        changed={**original,'checked_at':self.now};winners=[];resolve=pips.source_revision
        with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as other:
            def prepare(*args,**kwargs):
                self.assertFalse(self.registry.db.in_transaction)
                revision=resolve(*args,**kwargs)
                if not winners:
                    winners.append(None)
                    winners[0]=pips.PipStore(other).enqueue(job['id'],schedules.occurrence_key(job['current_version'],original['scheduled_at']),
                        'local-scheduler',self.cfg,schedule_occurrence=original)
                return revision
            with patch.object(pips,'source_revision',side_effect=prepare),self.assertRaises(RegistryError) as error:
                self.scheduled_enqueue(job,changed)
        self.assertEqual(error.exception.code,'conflict');self.assertEqual(len(self.store.runs(job['id'])),1)
        self.assertEqual(self.raw(winners[0])['pulse_verification']['request']['occurrence']['checked_at'],original['checked_at'])

    def test_successful_finish_cannot_forge_or_drop_saved_progress(self):
        run=self.enqueue(self.planned());self.store.claim_next()
        with self.assertRaises(RegistryError):self.store.finish(run['id'],result={'anything':'success'})
        self.assertEqual(self.store.run(run['id'])['status'],'running')
        ended=self.store.finish(run['id'],error={'code':'fixture_failure','message':'No commands'})
        self.assertEqual(ended['command_progress']['unexecuted'],1)

    def test_terminal_event_failure_rolls_back_seal_with_fact_preserved(self):
        run=self.enqueue(self.planned());row=self.store.claim_next()
        result=pips._execute_run(self.registry,row,self.cfg)
        event=self.registry.event
        def fail(workspace,event_type,**fields):
            if event_type=='pip_run_succeeded':raise RegistryError('fixture_failure','Rollback')
            return event(workspace,event_type,**fields)
        with patch.object(self.registry,'event',side_effect=fail),self.assertRaises(RegistryError):self.store.finish(run['id'],result=result)
        current=self.store.run(run['id'])
        self.assertEqual(current['status'],'running');self.assertEqual(current['result'],result)
        self.assertEqual(self.store.finish(run['id'],result=result)['status'],'succeeded')

    def test_pulse_execution_reference_tool_keeps_whole_command_budget(self):
        from types import SimpleNamespace
        from dgc import pip_context_tool
        run=self.execute(self.planned())
        with patch.object(pip_context_tool,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory)):
            text=pip_context_tool.read({'action':'execution','run_id':run['id'],'limit':1},
                SimpleNamespace(config=self.cfg,project_root=self.root))
        value=json.loads(text)
        self.assertLessEqual(len(text.encode()),24576);self.assertEqual(value['execution_mode'],'standalone_plan')
        self.assertEqual(value['commands'][0]['outcome']['argv'],self.raw(run)['job']['verification_plan']['action']['tests'][0]['argv'])
        self.assertNotIn('model_summary_preview',value);self.assertIsNone(value['execution_review'])

    def test_new_secret_overlap_refuses_accept_before_approval_mutation(self):
        job=self.create();proposal=self.store.propose(job['id'],job['current_version'],{'verification_plan':self.plan()},'human')
        before=self.registry.db.execute('SELECT status FROM pip_proposals WHERE id=?',(proposal['id'],)).fetchone()[0]
        from dgc import redaction
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory)), patch.object(redaction,'secret_values',return_value=['/usr/bin/python3']):
            response=pips.handle_control(self.cfg,{'type':'accept_pip_update','request_id':'secret-approval',
                'pip_id':job['id'],'proposal_id':proposal['id'],'expected_version':1},'human',start_worker=False)
        self.assertFalse(response['ok']);self.assertEqual(response['error']['code'],'secret_detected')
        self.assertEqual(self.registry.db.execute('SELECT status FROM pip_proposals WHERE id=?',(proposal['id'],)).fetchone()[0],before)
        self.assertEqual(self.store.get(job['id'])['current_version'],1)


if __name__=='__main__':unittest.main()
