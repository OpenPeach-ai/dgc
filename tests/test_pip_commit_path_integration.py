"""Reviewed path wakeups: real disposable Git, deterministic CAS, no providers."""
import copy
import json
import os
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pips, pip_commit_detector as detector, pip_commit_paths as paths, pip_event_triggers as triggers
from dgc import pip_daemon, pip_cli
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class CommittedPathIntegrationTests(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.now = '2026-10-01T10:00:00.000Z'
        self.registry.clock = lambda:self.now
        self.initial = self.commit()
        self.serial = 0

    def revise(self, job, **changes):
        current = self.store.get(job['id'])
        proposal = self.store.propose(job['id'],current['current_version'],changes,'user','Reviewed fixture')
        return self.store.accept(job['id'],proposal['id'],current['current_version'],'user')

    def job(self, *, kind='rook', rules=None, events=None, **extra):
        job = self.store.create(self.workspace['id'],'Path observer','Inspect the source and describe it.','user',pip_type=kind)
        spec = {'events':events or ['committed_paths_changed'],'commit_paths':rules or [{'kind':'exact','path':'source.py'}]}
        return self.revise(job,event_trigger=spec,**extra)

    def change(self, name='source.py'):
        self.serial += 1
        path = self.root/name; path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text('value = '+str(self.serial)+'\n')
        self.git('add',name); self.git('commit','-qm','change '+str(self.serial))
        return self.git('rev-parse','HEAD')

    def events(self, pip_id=None):
        return self.registry.db.execute("SELECT * FROM workspace_events WHERE event_type='workspace_committed_paths_changed' AND (? IS NULL OR pip_id=?) ORDER BY seq",(pip_id,pip_id)).fetchall()

    def match(self, job):
        self.assertEqual(detector.tick(self.registry,self.cfg)['baselined'],1)
        after = self.change(); self.now='2026-10-01T10:00:30.000Z'
        self.assertEqual(detector.tick(self.registry,self.cfg)['changed'],1)
        return after

    def enqueue(self, job):
        occurrence = triggers.plan(self.registry,job['id'],now=self.now)
        return self.store.enqueue(job['id'],triggers.occurrence_key(occurrence['job_version'],occurrence['event']['seq']),
                                  'local-event-trigger',self.cfg,event_occurrence=occurrence), occurrence

    def raw(self, run):
        return self.registry.db.execute('SELECT * FROM pip_runs WHERE id=?',(run['id'],)).fetchone()

    def test_silent_baseline_matching_event_and_exact_retry(self):
        job=self.job(); after=self.match(job); event=self.events()[0]; value=json.loads(event['payload'])
        self.assertEqual(value['comparison']['before_revision'],self.initial)
        self.assertEqual(value['comparison']['after_revision'],after)
        self.assertEqual(value['observed_at'],event['created_at'])
        self.assertEqual(value['comparison']['matched_rule_indices'],[0])
        self.assertNotIn('source.py',event['payload']); self.assertNotIn(str(self.root),event['payload'])
        run, occurrence=self.enqueue(job); state=triggers._state(self.registry,job['id'])
        self.assertEqual(run['manifest']['event_trigger']['commit_path_match'],value)
        with patch.object(pips,'source_revision',side_effect=AssertionError('Retry must not observe source')):
            replay=self.store.enqueue(job['id'],triggers.occurrence_key(2,event['seq']),'local-event-trigger',self.cfg,event_occurrence=occurrence)
        self.assertEqual(replay['id'],run['id']);self.assertEqual(triggers._state(self.registry,job['id']),state)

    def test_unmatched_advances_baseline_without_wakeup(self):
        job=self.job(rules=[{'kind':'directory','path':'docs'}]);detector.tick(self.registry,self.cfg)
        after=self.change();self.now='2026-10-01T10:00:30.000Z';detector.tick(self.registry,self.cfg)
        self.assertEqual(self.events(),[])
        view=self.store.get(job['id'])['commit_path_observation']
        self.assertEqual((view['revision'],view['last_comparison']['status'],view['observed_changes']),(after,'unmatched',1))

    def test_unavailable_ref_preserves_comparison_and_throttles(self):
        self.git('branch','watched');job=self.job(source_ref='watched');detector.tick(self.registry,self.cfg)
        self.change();self.git('branch','-f','watched','HEAD');self.now='2026-10-01T10:00:30.000Z';detector.tick(self.registry,self.cfg)
        first=self.store.get(job['id'])['commit_path_observation'];self.git('branch','-D','watched')
        self.now='2026-10-01T10:01:00.000Z';detector.tick(self.registry,self.cfg)
        after=self.store.get(job['id'])['commit_path_observation']
        self.assertEqual(after['last_probe']['status'],'unavailable');self.assertIsNone(after['last_probe']['after_revision'])
        self.assertEqual(after['last_comparison'],first['last_comparison']);self.assertEqual(after['last_comparison_at'],first['last_comparison_at'])
        with patch.object(detector,'_path_probe',side_effect=AssertionError('Thirty-second throttle')):
            self.assertEqual(detector.tick(self.registry,self.cfg)['checked'],0)

    def test_full_diff_failure_after_matching_prefix_never_emits(self):
        job=self.job();detector.tick(self.registry,self.cfg);self.change();self.now='2026-10-01T10:00:30.000Z'
        with patch.object(paths,'compare',side_effect=lambda *a,**kw: paths.validate_comparison(paths._seal({
            'schema_version':1,'comparison':'commit_trees','before_revision':a[1],'after_revision':a[2],
            'policy_digest':paths.rules_digest(a[3]),'status':'unavailable','reason':'invalid_metadata',
            'changed_entries':None,'matched_rule_indices':[]},2048,paths.COMPARISON_DOMAIN),before_revision=a[1],after_revision=a[2],rules=a[3])):
            self.assertEqual(detector.tick(self.registry,self.cfg)['unavailable'],1)
        self.assertEqual(self.events(),[]);self.assertEqual(detector._path_state(self.registry,job['id'])['revision'],self.initial)

    def test_two_connections_same_baseline_emit_only_once(self):
        job=self.job();detector.tick(self.registry,self.cfg);self.change();self.now='2026-10-01T10:00:30.000Z'
        other=WorkspaceRegistry(self.registry.directory,clock=lambda:self.now);self.addCleanup(other.close)
        original=detector._path_probe;entered=False
        def race(*args,**kwargs):
            nonlocal entered
            self.assertFalse(self.registry.db.in_transaction)
            if not entered:
                entered=True
                with patch.object(detector,'_path_probe',original):
                    detector.tick(other,self.cfg)
            return original(*args,**kwargs)
        with patch.object(detector,'_path_probe',race):result=detector.tick(self.registry,self.cfg)
        self.assertEqual(result['skipped'],1);self.assertEqual(len(self.events()),1)

    def test_pause_resume_and_global_stop_aba_reject_initial_detached_probe(self):
        for global_stop in (False,True):
            with self.subTest(global_stop=global_stop):
                job=self.job();other=WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)
                try:
                    original=detector._path_probe
                    def race(*args,**kwargs):
                        result=original(*args,**kwargs)
                        self.assertFalse(self.registry.db.in_transaction)
                        if global_stop:
                            pip_daemon._set_paused(other,True,'user');pip_daemon._set_paused(other,False,'user')
                        else:
                            store=pips.PipStore(other);store.set_paused(job['id'],True,'user');store.set_paused(job['id'],False,'user')
                        return result
                    with patch.object(detector,'_path_probe',race):
                        self.assertEqual(detector._observe_paths(self.registry,self.cfg,job['id'],self.now,None),'skipped')
                    self.assertIsNone(detector._path_state(self.registry,job['id'])['revision'])
                finally:other.close()

    def test_baseline_and_event_insert_roll_back_together(self):
        job=self.job();detector.tick(self.registry,self.cfg);self.change();self.now='2026-10-01T10:00:30.000Z'
        before=detector._path_state(self.registry,job['id']);original=self.registry.event
        def fail(workspace,kind,**kwargs):
            if kind=='workspace_committed_paths_changed':raise RegistryError('fixture','insertion failed')
            return original(workspace,kind,**kwargs)
        with patch.object(self.registry,'event',fail):self.assertEqual(detector.tick(self.registry,self.cfg)['unavailable'],1)
        self.assertEqual(detector._path_state(self.registry,job['id']),before);self.assertEqual(self.events(),[])

    def test_wrong_pip_cannot_consume_match_in_same_workspace(self):
        first=self.job();self.match(first);second=self.job()
        state=triggers._state(self.registry,second['id'])
        self.registry.db.execute('UPDATE pip_event_trigger_state SET after_seq=0 WHERE pip_id=?',(second['id'],))
        self.assertIsNone(triggers.plan(self.registry,second['id'],now=self.now))
        self.assertGreater(state['after_seq'],0)

    def test_retention_or_payload_replacement_before_enqueue_refuses(self):
        job=self.job();self.match(job);occurrence=triggers.plan(self.registry,job['id'],now=self.now)
        self.registry.db.execute("UPDATE workspace_events SET payload='{}' WHERE seq=?",(occurrence['event']['seq'],))
        with patch.object(pips,'source_revision',side_effect=AssertionError('Refuse before source')):
            with self.assertRaises(RegistryError):self.store.enqueue(job['id'],triggers.occurrence_key(2,occurrence['event']['seq']),'local-event-trigger',self.cfg,event_occurrence=occurrence)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0],0)
        self.assertEqual(triggers._state(self.registry,job['id'])['after_seq'],occurrence['expected_after_seq'])

    def test_version_change_discards_pending_match_preserves_cooldown_and_baseline(self):
        job=self.job();after=self.match(job)
        self.registry.db.execute("UPDATE pip_event_trigger_state SET next_allowed_at='2026-10-01T10:20:00.000Z' WHERE pip_id=?",(job['id'],))
        revised=self.revise(job,name='Renamed')
        state=triggers._state(self.registry,job['id']); observation=detector._path_state(self.registry,job['id'])
        self.assertEqual(observation['revision'],after);self.assertEqual(state['next_allowed_at'],'2026-10-01T10:20:00.000Z')
        self.assertEqual(state['job_version'],revised['current_version']);self.assertGreaterEqual(state['after_seq'],self.events()[0]['seq'])

    def test_rules_change_rebaselines_without_replaying_history(self):
        job=self.job();self.match(job)
        self.revise(job,event_trigger={'events':['committed_paths_changed'],'commit_paths':[{'kind':'directory','path':'docs'}]})
        state=detector._path_state(self.registry,job['id'])
        for key in ('revision','last_checked_at','last_probe','last_comparison','last_comparison_at'):self.assertIsNone(state[key])
        self.assertIsNone(triggers.plan(self.registry,job['id'],now=self.now))

    def test_observed_commit_can_differ_from_enqueued_source(self):
        job=self.job();observed=self.match(job);current=self.change('other.txt');run,_=self.enqueue(job)
        self.assertNotEqual(observed,current)
        self.assertEqual(run['manifest']['source_revision'],current)
        self.assertEqual(run['manifest']['event_trigger']['commit_path_match']['comparison']['after_revision'],observed)

    def test_history_survives_event_retention_source_move_and_new_job_version(self):
        job=self.job();self.match(job);run,_=self.enqueue(job)
        self.registry.db.execute('DELETE FROM workspace_events')
        self.revise(job,name='Later name')
        self.root.rename(self.base/'moved')
        with patch.object(paths,'compare',side_effect=AssertionError('No historical Git')):
            saved=self.store.run(run['id']);checked=paths.validate_parent(self.registry,self.raw(run),saved['manifest'] | {'model_settings':json.loads(self.raw(run)['manifest'])['model_settings']})
        self.assertIsNotNone(checked['match'])

    def test_corrupt_manifest_refused_before_agent_success_and_history_but_failure_records(self):
        job=self.job();self.match(job);run,_=self.enqueue(job);self.store.claim_next()
        raw=self.raw(run);manifest=json.loads(raw['manifest']);manifest['event_trigger']['commit_path_match']['comparison']['matched_rule_indices']=[]
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(json.dumps(manifest),run['id']))
        with patch('dgc.agent.Agent',side_effect=AssertionError('No Agent')),patch.object(pips,'clean_snapshot',side_effect=AssertionError('No source')):
            with self.assertRaises(RegistryError):pips._execute_run(self.registry,self.raw(run),self.cfg)
        with self.assertRaises(RegistryError):self.store.run(run['id'])
        with self.assertRaises(RegistryError):self.store.finish(run['id'],result={'summary':'forged'})
        self.assertEqual(self.store.finish(run['id'],error={'code':'invalid_commit_paths','message':'Refused'})['status'],'failed')

    def test_cli_exact_rules_and_no_silent_downgrade(self):
        args=pip_cli.parser().parse_args(['trigger','pip_'+'a'*32,'--expected-version','2','--events','committed_paths_changed','context_updated','--path','z.txt','--directory','src'])
        spec=pip_cli._request(args)['changes']['event_trigger']
        self.assertEqual(spec['commit_paths'],[{'kind':'directory','path':'src'},{'kind':'exact','path':'z.txt'}])
        for values in (['--off','--path','source.py'],['--events','commit_changed','--path','source.py'],['--events','committed_paths_changed']):
            args=pip_cli.parser().parse_args(['trigger','pip_'+'a'*32,'--expected-version','2',*values])
            with self.assertRaises(RegistryError):pip_cli._request(args)

    def test_control_refuses_secret_rules_before_proposal_and_acceptance(self):
        job=self.store.create(self.workspace['id'],'Observer','Inspect','user')
        self.cfg.set('api_key','UNIQUE_PRIVATE_PATH',persist=False)
        request={'type':'propose_pip_update','request_id':'req','pip_id':job['id'],'expected_version':1,
            'changes':{'event_trigger':{'events':['committed_paths_changed'],'commit_paths':[{'kind':'exact','path':'UNIQUE_PRIVATE_PATH'}]}}}
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)):
            reply=pips.handle_control(self.cfg,request,'user',start_worker=False)
        self.assertFalse(reply['ok']);self.assertEqual(reply['error']['code'],'secret_detected')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_proposals').fetchone()[0],0)
        proposal=self.store.propose(job['id'],1,request['changes'],'user','fixture')
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)):
            reply=pips.handle_control(self.cfg,{'type':'accept_pip_update','request_id':'accept','pip_id':job['id'],'proposal_id':proposal['id'],'expected_version':1},'user',start_worker=False)
        self.assertFalse(reply['ok']);self.assertEqual(self.store.get(job['id'])['current_version'],1)

    def test_quill_max_rules_real_worker_and_context_selection(self):
        from tests.test_pip_commit_paths import max_rules
        from dgc import pip_drafts, pip_quill_automation
        rules=max_rules()
        for selected in ('paths','context'):
            with self.subTest(selected=selected):
                job=self.job(kind='quill',rules=rules,events=['committed_paths_changed','context_updated','finding_accepted','session_turn_completed'])
                if selected=='paths':
                    detector._observe_paths(self.registry,self.cfg,job['id'],self.now,None)
                    self.change(rules[-1]['path']+'/file.txt');self.now='2026-10-01T10:00:30.000Z'
                    detector._observe_paths(self.registry,self.cfg,job['id'],self.now,None)
                else:
                    self.registry.event(self.workspace['id'],'workspace_context_recorded',payload={'untrusted':'Not model instructions'})
                run,_=self.enqueue(job);row=self.raw(run);manifest=json.loads(row['manifest'])
                self.assertLessEqual(len(pip_quill_automation._encode(manifest['draft_automation'],4096)),4096)
                self.assertEqual(len(paths._encode(manifest['event_trigger']['policy']['commit_paths'],2048)),2048)
                self.assertEqual('commit_path_match' in manifest['event_trigger'],selected=='paths')
                self.assertEqual(paths.validate_parent(self.registry,row,manifest)['match'] is not None,selected=='paths')
                body={'title':'Greeting','summary':'Source discussion','markdown':'# Greeting\n\nThe source defines hello.',
                    'citations':[{'path':'source.py','line':1,'excerpt':"def hello():\n    return 'hello'"}]}
                replies=iter([ChatResult(tool_calls=[ToolCall('read','read_file',{'path':'source.py'})]),ChatResult(content=json.dumps(body))])
                def chat(_client,_messages,tools=None,on_text=None,**kwargs):
                    reply=next(replies)
                    if reply.content and on_text:on_text(reply.content)
                    return reply
                with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy())}),patch.object(LLMClient,'chat',chat),\
                     patch('dgc.agent.discover_skills',return_value={}),patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
                    result=pips.execute_native(self.cfg,self.root,manifest,lambda event:None)
                result['snapshot']={'sha256':'a'*64,'files':2,'bytes':48}
                directory=self.registry.directory/'runs'/run['id'];directory.mkdir(mode=0o700,parents=True,exist_ok=True)
                saved=pip_drafts.publish(result,self.root,directory)
                self.store.claim_next();finished=self.store.finish(run['id'],result=saved)
                self.assertEqual(finished['status'],'succeeded')
                self.registry.db.execute('DELETE FROM workspace_events')
                self.revise(job,name='Later reviewed name')
                self.assertEqual(pip_drafts.stored(self.registry,self.workspace['id'],run['id'])[1],saved)

    def test_fair_eight_selections_progress_past_corrupt_rows(self):
        jobs=[]
        for index in range(10):
            if index%2:jobs.append(self.job())
            else:
                raw=self.store.create(self.workspace['id'],'Broad observer','Inspect','user')
                jobs.append(self.revise(raw,event_trigger={'events':['commit_changed']}))
        jobs.sort(key=lambda job:job['id'])
        self.registry.db.execute('DROP TRIGGER immutable_job_version')
        for job in jobs[:8]:
            self.registry.db.execute("UPDATE pip_versions SET definition='{}' WHERE pip_id=? AND version=?",(job['id'],job['current_version']))
        first=detector.tick(self.registry,self.cfg);self.assertEqual(first['unavailable'],8)
        second=detector.tick(self.registry,self.cfg);self.assertEqual(second['baselined'],2)
        value=self.registry.db.execute('SELECT value FROM metadata WHERE key=?',(detector.PROBE_CURSOR_KEY,)).fetchone()[0]
        self.assertLessEqual(len(value.encode()),256)
        self.assertEqual(set(json.loads(value)),{'schema_version','last_pip_id','last_kind'})

    def test_automatic_name_ref_adaptation_never_changes_filter_or_revives_old_events(self):
        policy={'mode':'bounded_adaptive','allowed_fields':['name','source_ref']}
        job=self.job(adaptation_policy=policy);after=self.match(job)
        self.registry.associate_session('owned-chat',self.root)
        self.registry.db.execute("UPDATE pip_event_trigger_state SET next_allowed_at='2026-10-01T10:20:00.000Z' WHERE pip_id=?",(job['id'],))
        result=self.store.adapt(job['id'],job['current_version'],{'name':'Adapted'},'Reviewed safe metadata',origin_session_id='owned-chat',request_key='name',expected_workspace_id=self.workspace['id'])
        current=self.store.get(job['id'])
        self.assertEqual(detector._path_state(self.registry,job['id'])['revision'],after)
        self.assertGreaterEqual(triggers._state(self.registry,job['id'])['after_seq'],self.events()[0]['seq'])
        self.assertEqual(triggers._state(self.registry,job['id'])['next_allowed_at'],'2026-10-01T10:20:00.000Z')
        self.git('branch','other-ref')
        self.store.adapt(job['id'],current['current_version'],{'source_ref':'other-ref'},'Reviewed safe ref',origin_session_id='owned-chat',request_key='ref',expected_workspace_id=self.workspace['id'])
        self.assertIsNone(detector._path_state(self.registry,job['id'])['revision'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0],0)
        with self.assertRaises(RegistryError):self.store.adapt(job['id'],current['current_version']+1,{'event_trigger':None},'No authority',origin_session_id='owned-chat',request_key='forbidden',expected_workspace_id=self.workspace['id'])

    def test_new_trigger_direct_bounds_precede_generic_json_and_redaction(self):
        job=self.store.create(self.workspace['id'],'Observer','Inspect','user')
        bad=[{'events':['committed_paths_changed']*100000}, {'events':'committed_paths_changed'*100000},
             {'events':['committed_paths_changed'],'commit_paths':[{'kind':'exact','path':'x'*100000}]}]
        cycle={'events':['committed_paths_changed']};cycle['commit_paths']=[cycle];bad.append(cycle)
        for spec in bad:
            request={'type':'propose_pip_update','request_id':'bounded','pip_id':job['id'],'expected_version':1,'changes':{'event_trigger':spec}}
            with self.subTest(kind=type(spec['events']).__name__),patch.object(pips,'_json',side_effect=AssertionError('Bound before generic serialization')),\
                 patch('dgc.redaction.redact_value',side_effect=AssertionError('Bound before redaction')):
                reply=pips.handle_control(self.cfg,request,'user',start_worker=False)
                self.assertFalse(reply['ok'])
                with self.assertRaises(RegistryError):self.store.propose(job['id'],1,request['changes'],'user','Bound first')

    def test_stop_or_root_replacement_during_probe_never_publishes(self):
        job=self.job();detector.tick(self.registry,self.cfg);self.change();self.now='2026-10-01T10:00:30.000Z'
        cancelled=threading.Event();original=detector._path_probe
        def stop(*args,**kwargs):
            result=original(*args,**kwargs);cancelled.set();return result
        with patch.object(detector,'_path_probe',stop):
            self.assertEqual(detector.tick(self.registry,self.cfg,stop_event=cancelled)['skipped'],1)
        self.assertEqual(self.events(),[])
        original_identity=detector._root_identity;calls=0
        def moved(root):
            nonlocal calls
            calls+=1;value=original_identity(root)
            return value if calls==1 else (*value,(1,2))
        with patch.object(detector,'_root_identity',moved):
            self.assertEqual(detector.tick(self.registry,self.cfg)['unavailable'],1)
        self.assertEqual(self.events(),[]);self.assertEqual(detector._path_state(self.registry,job['id'])['revision'],self.initial)

    def test_diagnostic_cross_links_refuse_display_and_future_probe(self):
        job=self.job();self.match(job);state=detector._path_state(self.registry,job['id'])
        original=json.loads(state['last_probe'])
        cases=[({**original,'before_revision':'3'*40},state['last_comparison_at']),
               ({**original,'status':'unavailable','reason':'comparison_unavailable','comparison_digest':None,
                 'before_revision':state['revision'],'after_revision':None},'2026-10-01T11:00:00.000Z'),
               ({**original,'after_revision':'4'*40},state['last_comparison_at'])]
        for probe,comparison_at in cases:
            self.registry.db.execute('UPDATE pip_commit_path_observations SET last_probe=?,last_comparison_at=? WHERE pip_id=?',
                                     (json.dumps(probe),comparison_at,job['id']))
            with patch.object(detector,'_path_probe',side_effect=AssertionError('Corrupt history must not initiate Git')):
                self.assertEqual(detector.path_observation(self.registry,job['id']),
                    {'schema_version':1,'status':'unavailable','reason':'invalid_stored_observation'})
                self.now='2026-10-01T10:01:00.000Z'
                self.assertEqual(detector.tick(self.registry,self.cfg)['unavailable'],1)

    def test_ref_rule_version_or_binding_change_invalidates_detached_probe(self):
        self.git('branch','other-ref')
        for change in ('name','source_ref','rules','binding'):
            with self.subTest(change=change):
                job=self.job();original=detector._path_probe
                def race(*args,**kwargs):
                    value=original(*args,**kwargs)
                    if change=='binding':
                        target=self.base/'new-binding';self.root.rename(target)
                        self.registry.rebind(self.workspace['id'],target,expected_root=self.root)
                    else:
                        updates=({'name':'New approved name'} if change=='name' else {'source_ref':'other-ref'} if change=='source_ref'
                            else {'event_trigger':{'events':['committed_paths_changed'],'commit_paths':[{'kind':'directory','path':'docs'}]}})
                        self.revise(job,**updates)
                    return value
                with patch.object(detector,'_path_probe',race):
                    self.assertEqual(detector._observe_paths(self.registry,self.cfg,job['id'],self.now,None),'skipped')
                self.assertIsNone(detector._path_state(self.registry,job['id'])['revision'])
                self.assertEqual(self.events(),[])

    def test_one_deadline_covers_ref_resolution_and_comparison(self):
        job=self.job();detector.tick(self.registry,self.cfg);self.change();self.now='2026-10-01T10:00:30.000Z'
        deadlines=[];original=detector._capture
        def capture(*args,**kwargs):
            deadlines.append(kwargs['deadline']);return original(*args,**kwargs)
        with patch.object(detector,'_capture',capture),patch('dgc.pip_source_changes._capture',capture):
            self.assertEqual(detector.tick(self.registry,self.cfg)['changed'],1)
        self.assertGreaterEqual(len(deadlines),3);self.assertEqual(len(set(deadlines)),1)

    def test_queue_event_failure_rolls_back_run_and_occurrence(self):
        job=self.job();self.match(job);before=triggers._state(self.registry,job['id']);original=self.registry.event
        def fail(workspace,kind,**kwargs):
            if kind=='pip_run_queued':raise RegistryError('fixture','queue write failed')
            return original(workspace,kind,**kwargs)
        with patch.object(self.registry,'event',fail),self.assertRaises(RegistryError):self.enqueue(job)
        self.assertEqual(triggers._state(self.registry,job['id']),before)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0],0)

    def test_duplicate_or_oversized_retained_payload_cannot_enqueue(self):
        job=self.job();self.match(job);event=self.events()[0];original=event['payload']
        values=['x'*4097,'{"schema_version":1,'+original[1:]]
        for value in values:
            self.registry.db.execute('UPDATE workspace_events SET payload=? WHERE seq=?',(value,event['seq']))
            with self.assertRaises(RegistryError):triggers.plan(self.registry,job['id'],now=self.now)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0],0)

    def test_legacy_pause_control_read_stays_compatible_but_paths_require_revision(self):
        self.registry.db.execute('INSERT INTO metadata(key,value) VALUES(?,?)',(pip_daemon.CONTROL_KEY,json.dumps({'schema_version':1,'paused':False})))
        old=self.store.create(self.workspace['id'],'Legacy observer','Inspect','user')
        self.revise(old,event_trigger={'events':['commit_changed']});new=self.job()
        result=detector.tick(self.registry,self.cfg)
        self.assertEqual(result['baselined'],1);self.assertEqual(result['unavailable'],1)
        self.assertIsNone(detector._path_state(self.registry,new['id'])['revision'])

    def test_conversation_reference_checks_original_filtered_audit_authority(self):
        from dgc import pip_chat
        job=self.job();self.match(job);run,_=self.enqueue(job);self.store.claim_next()
        result=pips.validate_report(json.dumps({'summary':'Fixture source inspection','findings':[],'limitations':['No tests executed']}),self.root,read_calls=1)
        result.update(usage={},tools_called=1,snapshot={'sha256':'a'*64,'files':1,'bytes':10})
        self.assertEqual(self.store.finish(run['id'],result=result)['status'],'succeeded')
        self.assertEqual(pip_chat._last_report(self.store,job['id'])['run_id'],run['id'])
        raw=self.raw(run);manifest=json.loads(raw['manifest']);manifest['event_trigger'].pop('commit_path_match')
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(json.dumps(manifest),run['id']))
        with self.assertRaises(RegistryError):pip_chat._last_report(self.store,job['id'])

    def test_context_promotion_checks_original_filtered_audit_authority(self):
        from dgc.workspace_context import ContextStore
        job=self.job();self.match(job);run,_=self.enqueue(job);self.store.claim_next()
        result=pips.validate_report(json.dumps({'summary':'Fixture source inspection','findings':[
            {'title':'Review the fixture value','severity':'low','path':'source.py','line':1,
             'evidence':'value = 1'}],'limitations':['No tests executed']}),self.root,read_calls=1)
        result.update(usage={},tools_called=1,snapshot={'sha256':'a'*64,'files':1,'bytes':10})
        self.assertEqual(self.store.finish(run['id'],result=result)['status'],'succeeded')
        original=self.raw(run)['manifest'];manifest=json.loads(original)
        manifest['event_trigger'].pop('commit_path_match')
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(json.dumps(manifest),run['id']))
        context=ContextStore(self.registry);before=context.get(self.workspace['id'])
        changes=self.registry.db.total_changes
        with self.assertRaises(RegistryError):self.store.run(run['id'])
        with self.assertRaises(RegistryError):
            context.accept_finding(self.workspace['id'],run['id'],0,0,'user')
        self.assertEqual(context.get(self.workspace['id']),before)
        self.assertEqual(self.registry.db.total_changes,changes)
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(original,run['id']))
        self.revise(job,name='Later reviewed name')
        self.registry.db.execute('DELETE FROM workspace_events')
        self.root.rename(self.base/'offline-source')
        view=context.accept_finding(self.workspace['id'],run['id'],0,0,'user')
        self.assertEqual(view['entries'][0]['provenance']['run_id'],run['id'])
        self.assertEqual(view['entries'][0]['provenance']['job_version'],2)
        self.assertEqual(view['entries'][0]['provenance']['classification'],'model_assessment')


if __name__ == '__main__':
    unittest.main()
