"""Reviewed Quill occurrences: real Git/native Agent, controlled clocks, no network."""
import copy
import hashlib
import io
import json
import os
import unittest
from unittest.mock import Mock, patch

from dgc import pip_quill_automation as automation, pip_schedules as schedules
from dgc import pip_event_triggers as events, pip_drafts as drafts, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_drafts as fixtures


class QuillAutomationTests(unittest.TestCase):
    git = fixtures.DraftTests.git
    commit = fixtures.DraftTests.commit
    body = fixtures.DraftTests.body
    worker_result = fixtures.DraftTests.worker_result

    def setUp(self):
        fixtures.DraftTests.setUp(self)
        self.now = '2026-10-01T10:00:00.000Z'
        self.registry.clock = lambda:self.now
        self.commit()

    def create(self, **changes):
        return self.store.create(self.workspace['id'], 'Docs', 'Explain the source helper.', 'human', pip_type='quill', **changes)

    def approve(self, job, changes):
        p = self.store.propose(job['id'], job['current_version'], changes, 'human', 'Reviewed recurring draft')
        return self.store.accept(job['id'], p['id'], job['current_version'], 'human')

    def scheduled(self, spec=None):
        return self.approve(self.create(), {'schedule':spec or {'type':'interval','minutes':5}})

    def occurrence(self, job):
        row = self.registry.db.execute('SELECT * FROM pip_schedule_state WHERE pip_id=?', (job['id'],)).fetchone()
        plan = schedules.plan_due(job['schedule'], row['next_due_at'], self.now, row['anchor_at'])
        return {'job_version':job['current_version'], **{k:plan[k] for k in ('expected_next_due','scheduled_at','next_due_at','checked_at')}}

    def enqueue(self, job, occurrence=None):
        occurrence = occurrence or self.occurrence(job)
        return self.store.enqueue(job['id'], schedules.occurrence_key(job['current_version'], occurrence['scheduled_at']),
                                  'local-scheduler', self.cfg, schedule_occurrence=occurrence)

    def raw(self, run):
        return json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run['id'],)).fetchone()[0])

    def resign(self, manifest):
        grant = manifest['draft_automation']
        grant['digest'] = automation._digest({k:v for k,v in grant.items() if k!='digest'})

    def test_all_calendar_forms_use_checked_occurrence_and_original_definition(self):
        cases = [({'type':'interval','minutes':5}, '2026-10-01T10:15:00.000Z'),
                 ({'type':'daily','time':'10:05','timezone':'UTC'}, '2026-10-01T10:05:00.000Z'),
                 ({'type':'once','at':'2026-10-01T10:05:00Z'}, '2026-10-01T10:05:00.000Z'),
                 ({'type':'cron','cron':'5 10 * * *','timezone':'UTC'}, '2026-10-01T10:05:00.000Z')]
        for spec, now in cases:
            with self.subTest(spec=spec):
                self.now = '2026-10-01T10:00:00.000Z'; job = self.scheduled(spec); self.now = now
                run = self.enqueue(job); manifest = self.raw(run); grant = automation.validate_manifest(manifest)
                raw = self.registry.db.execute('SELECT definition FROM pip_versions WHERE pip_id=? AND version=2', (job['id'],)).fetchone()[0]
                self.assertEqual(grant['definition_digest'], hashlib.sha256(raw.encode()).hexdigest())
                self.assertEqual(grant['policy'], job['schedule'])
                self.assertEqual(grant['occurrence']['anchor_at'], '2026-10-01T10:00:00.000Z')
                self.assertEqual(manifest['run_kind'], 'draft')
                for key in ('audit_checkpoint','changes_since_checkpoint','pip_memory','handoff','specialists'):
                    self.assertNotIn(key, manifest)

    def test_all_existing_event_categories_enqueue_drafts_without_payloads(self):
        for event_kind, source_kind in [('context_updated','workspace_context_recorded'),
                                       ('finding_accepted','pip_finding_accepted'),
                                       ('commit_changed','workspace_commit_changed'),
                                       ('session_turn_completed','workspace_session_turn_completed')]:
            with self.subTest(kind=event_kind):
                job = self.approve(self.create(), {'event_trigger':{'events':[event_kind]}})
                self.registry.event(self.workspace['id'], source_kind, pip_id=job['id'], payload={'text':'UNTRUSTED_EVENT_BODY'})
                occurrence = events.plan(self.registry, job['id'], now=self.now)
                run = self.store.enqueue(job['id'], events.occurrence_key(job['current_version'], occurrence['event']['seq']),
                                          'local-event-trigger', self.cfg, event_occurrence=occurrence)
                manifest = self.raw(run); grant = automation.validate_manifest(manifest)
                self.assertEqual(grant['occurrence'], occurrence)
                self.assertEqual(grant['trigger'], 'event')
                self.assertNotIn('UNTRUSTED_EVENT_BODY', json.dumps(manifest))

    def test_pending_rejected_expired_and_stale_reviews_never_arm(self):
        for disposition in ('pending','rejected','expired','stale'):
            with self.subTest(disposition=disposition):
                self.now = '2026-10-01T10:00:00.000Z'; job = self.create()
                proposal = self.store.propose(job['id'],1,{'schedule':{'type':'interval','minutes':5}},'human')
                if disposition == 'rejected': self.store.reject(job['id'],proposal['id'],1,'human')
                elif disposition == 'expired':
                    self.now = '2026-11-01T10:00:00.000Z'
                    with self.assertRaises(RegistryError): self.store.accept(job['id'],proposal['id'],1,'human')
                elif disposition == 'stale':
                    self.approve(job, {'name':'Renamed'})
                    with self.assertRaises(RegistryError): self.store.accept(job['id'],proposal['id'],1,'human')
                self.assertIsNone(self.registry.db.execute('SELECT 1 FROM pip_schedule_state WHERE pip_id=?',(job['id'],)).fetchone())
                self.assertEqual(self.store.runs(job['id']), [])

    def test_exact_retry_is_historical_and_every_changed_occurrence_field_conflicts(self):
        job = self.scheduled(); self.now = '2026-10-01T10:15:00.000Z'
        occurrence = self.occurrence(job); run = self.enqueue(job, occurrence)
        with patch.object(pips, 'source_revision', side_effect=AssertionError('No new source work')):
            self.assertEqual(self.enqueue(job, occurrence)['id'], run['id'])
            for key in occurrence:
                changed = dict(occurrence); changed[key] = 3 if key=='job_version' else '2026-10-01T10:10:00.000Z'
                with self.subTest(key=key), self.assertRaises(RegistryError):
                    self.store.enqueue(job['id'], schedules.occurrence_key(2,occurrence['scheduled_at']), 'local-scheduler', self.cfg, schedule_occurrence=changed)

    def test_queue_failure_rolls_back_occurrence_and_event_cursor(self):
        for trigger in ('schedule','event'):
            with self.subTest(trigger=trigger):
                self.now = '2026-10-01T10:00:00.000Z'
                job = self.scheduled() if trigger=='schedule' else self.approve(self.create(), {'event_trigger':{'events':['context_updated']}})
                self.now = '2026-10-01T10:05:00.000Z'
                if trigger=='event': self.registry.event(self.workspace['id'],'workspace_context_recorded')
                before = '\n'.join(self.registry.db.iterdump()); original = self.registry.event
                def fail(workspace, kind, **kwargs):
                    if kind=='pip_run_queued': raise RegistryError('fixture', 'Queue event failure')
                    return original(workspace,kind,**kwargs)
                with patch.object(self.registry,'event',side_effect=fail), self.assertRaises(RegistryError):
                    if trigger=='schedule': self.enqueue(job)
                    else:
                        occurrence = events.plan(self.registry,job['id'],now=self.now)
                        self.store.enqueue(job['id'],events.occurrence_key(2,occurrence['event']['seq']),'local-event-trigger',self.cfg,event_occurrence=occurrence)
                self.assertEqual('\n'.join(self.registry.db.iterdump()),before)

    def test_worker_rejects_forged_mixed_or_missing_grants_before_agent(self):
        job = self.scheduled(); self.now='2026-10-01T10:05:00.000Z'; manifest=self.raw(self.enqueue(job))
        cases=[]
        missing=copy.deepcopy(manifest); missing.pop('draft_automation'); cases.append(missing)
        for key,value in [('run_kind','audit'),('pip_type','rook'),('policy','review_required'),('tools',['bash']),
                          ('trigger','manual'),('event_trigger',{}),('pip_memory',{}),('handoff',{})]:
            changed=copy.deepcopy(manifest); changed[key]=value; cases.append(changed)
        for key,value in [('scheduled_at','2026-10-01T10:06:00.000Z'),('next_due_at',None),('anchor_at','2026-10-01T10:01:00.000Z'),
                          ('expected_next_due','2026-10-01T10:04:00.000Z')]:
            changed=copy.deepcopy(manifest); changed['draft_automation']['occurrence'][key]=value; self.resign(changed); cases.append(changed)
        changed=copy.deepcopy(manifest); changed['job']['goal']='Forged goal'; cases.append(changed)
        for changed in cases:
            with patch('dgc.agent.Agent.__init__',side_effect=AssertionError('No Agent')), self.assertRaises(RegistryError):
                pips.execute_native(self.cfg,self.root,changed,lambda event:None)

    def test_parent_checks_actual_original_definition_not_only_self_consistent_hashes(self):
        job=self.scheduled(); self.now='2026-10-01T10:05:00.000Z'; run=self.enqueue(job); manifest=self.raw(run)
        row=self.registry.db.execute('SELECT * FROM pip_runs WHERE id=?',(run['id'],)).fetchone()
        automation.validate_parent(self.registry,row,manifest)
        changed=copy.deepcopy(manifest); changed['job']['goal']='Forged goal'
        changed['draft_automation']['job_digest']=automation._job(changed['job']); self.resign(changed)
        automation.validate_manifest(changed)
        with self.assertRaises(RegistryError): automation.validate_parent(self.registry,row,changed)
        newer=self.approve(job, {'name':'Later reviewed name'})
        automation.validate_parent(self.registry,row,manifest)
        self.assertEqual(newer['current_version'],3)

    def test_current_tree_automation_and_handoffs_remain_refused(self):
        policy={'mode':'current_tree','exclusions':'safe_source_v1'}
        job=self.approve(self.create(), {'source_policy':policy})
        for change in ({'schedule':{'type':'interval','minutes':5}}, {'event_trigger':{'events':['context_updated']}}):
            with self.assertRaises(RegistryError): self.approve(job,change)
        with self.assertRaises(RegistryError): self.store.enqueue(job['id'],'handoff','human',self.cfg,handoff={'run_id':'run_fake'})

    def test_manual_legacy_draft_keeps_original_no_grant_contract(self):
        job=self.create(); run=self.store.enqueue(job['id'],'manual','human',self.cfg); manifest=self.raw(run)
        before=json.dumps(manifest,sort_keys=True)
        self.assertIsNone(automation.validate_manifest(manifest))
        self.assertEqual(json.dumps(manifest,sort_keys=True),before)
        self.assertNotIn('draft_automation',manifest)
        self.assertEqual(self.store.enqueue(job['id'],'manual','human',self.cfg)['id'],run['id'])

    def test_actual_native_agent_uses_same_read_only_draft_contract(self):
        job=self.scheduled(); self.now='2026-10-01T10:05:00.000Z'; manifest=self.raw(self.enqueue(job)); seen=[]
        replies=iter([ChatResult(tool_calls=[ToolCall('bad','bash',{'command':'touch forbidden'})]),
                      ChatResult(tool_calls=[ToolCall('read','read_file',{'path':'source.py'})]),
                      ChatResult(content=json.dumps(self.body()))])
        def chat(client,messages,tools=None,on_text=None,**kwargs):
            seen.append(copy.deepcopy(messages)); self.assertTrue({t['function']['name'] for t in tools}<=pips.READ_TOOLS)
            reply=next(replies)
            if reply.content and on_text:on_text(reply.content)
            return reply
        source=(self.root/'source.py').read_bytes(); emitted=[]
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy())}), \
             patch.object(LLMClient,'chat',chat), patch('dgc.agent.discover_skills',return_value={}), \
             patch('dgc.agent.load_memories',side_effect=AssertionError('No ambient authority')), \
             patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
            result=pips.execute_native(self.cfg,self.root,manifest,emitted.append)
        self.assertEqual(result['draft']['markdown'],self.body()['markdown'])
        self.assertFalse(result['tests_executed']); self.assertEqual(result['verification'],drafts.VERIFICATION)
        self.assertEqual((self.root/'source.py').read_bytes(),source); self.assertFalse((self.root/'forbidden').exists())
        self.assertTrue(any(e['kind']=='tool_denied' for e in emitted))
        self.assertIn(drafts.SYSTEM,seen[0][0]['content'])

    def test_concurrent_key_winner_requires_full_occurrence_on_inner_retry(self):
        job=self.scheduled(); self.now='2026-10-01T10:15:00.001Z'
        original=self.occurrence(job); original['checked_at']='2026-10-01T10:15:00.000Z'
        changed={**original, 'checked_at':self.now}; winners=[]
        resolve=pips.source_revision
        with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as other:
            def prepare(*args, **kwargs):
                self.assertFalse(self.registry.db.in_transaction)
                revision=resolve(*args,**kwargs)
                if not winners:
                    winners.append(None)
                    winners[0]=pips.PipStore(other).enqueue(job['id'],schedules.occurrence_key(2,original['scheduled_at']),
                        'local-scheduler',self.cfg,schedule_occurrence=original)
                return revision
            with patch.object(pips,'source_revision',side_effect=prepare), self.assertRaises(RegistryError) as caught:
                self.enqueue(job,changed)
        self.assertEqual(caught.exception.code,'conflict')
        self.assertEqual(len(self.store.runs(job['id'])),1)
        self.assertEqual(self.raw(winners[0])['draft_automation']['occurrence']['checked_at'],original['checked_at'])

    def test_tick_restart_cancelled_retry_and_busy_coalescing_never_duplicate(self):
        for trigger in ('schedule','event'):
            with self.subTest(trigger=trigger):
                self.now='2026-10-01T10:00:00.000Z'
                job=self.scheduled() if trigger=='schedule' else self.approve(self.create(),{'event_trigger':{'events':['context_updated']}})
                self.now='2026-10-01T10:15:00.000Z'
                if trigger=='event': self.registry.event(self.workspace['id'],'workspace_context_recorded')
                occurrence=self.occurrence(job) if trigger=='schedule' else events.plan(self.registry,job['id'],now=self.now)
                tick=schedules.tick if trigger=='schedule' else events.tick
                self.assertEqual(tick(self.registry,self.cfg)['enqueued'],1)
                run=self.store.run(self.store.runs(job['id'])[0]['id'])
                with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as reopened:
                    self.assertEqual(tick(reopened,self.cfg)['enqueued'],0)
                self.now='2026-10-01T10:20:00.000Z'
                if trigger=='event': self.registry.event(self.workspace['id'],'workspace_context_recorded')
                self.assertEqual(tick(self.registry,self.cfg)['skipped'],1)
                self.store.cancel(run['id'],'human')
                args={'schedule_occurrence':occurrence} if trigger=='schedule' else {'event_occurrence':occurrence}
                key=schedules.occurrence_key(2,occurrence['scheduled_at']) if trigger=='schedule' else events.occurrence_key(2,occurrence['event']['seq'])
                with patch.object(pips,'source_revision',side_effect=AssertionError('Historical retry')):
                    retry=self.store.enqueue(job['id'],key,'local-scheduler' if trigger=='schedule' else 'local-event-trigger',self.cfg,**args)
                self.assertEqual(retry['id'],run['id']); self.assertEqual(retry['status'],'cancelled')
                self.assertEqual(tick(self.registry,self.cfg)['enqueued'],0)
                self.store.set_paused(job['id'],True,'human')

    def test_commit_observer_targets_quill_and_pins_latest_committed_source(self):
        from dgc import pip_commit_detector as detector
        job=self.approve(self.create(),{'event_trigger':{'events':['commit_changed']}})
        self.assertEqual(detector.tick(self.registry,self.cfg)['baselined'],1)
        self.assertEqual(events.tick(self.registry,self.cfg)['enqueued'],0)
        (self.root/'source.py').write_text("def hello():\n    return 'new greeting'\n")
        self.git('add','source.py'); self.git('commit','-qm','next')
        self.now='2026-10-01T10:01:00.000Z'
        self.assertEqual(detector.tick(self.registry,self.cfg)['changed'],1)
        self.assertEqual(events.tick(self.registry,self.cfg)['enqueued'],1)
        manifest=self.raw(self.store.runs(job['id'])[0])
        self.assertEqual(manifest['source_revision'],self.git('rev-parse','HEAD'))
        self.assertEqual(automation.validate_manifest(manifest)['trigger'],'event')

    def test_event_retry_requires_exact_retention_and_event_pin(self):
        job=self.approve(self.create(),{'event_trigger':{'events':['context_updated']}})
        self.registry.event(self.workspace['id'],'workspace_context_recorded')
        occurrence=events.plan(self.registry,job['id'],now=self.now)
        key=events.occurrence_key(2,occurrence['event']['seq'])
        run=self.store.enqueue(job['id'],key,'local-event-trigger',self.cfg,event_occurrence=occurrence)
        with patch.object(pips,'source_revision',side_effect=AssertionError('Historical retry')):
            self.assertEqual(self.store.enqueue(job['id'],key,'local-event-trigger',self.cfg,event_occurrence=occurrence)['id'],run['id'])
            for field,value in [('history_may_be_incomplete',not occurrence['history_may_be_incomplete']),('expected_after_seq',0),('checked_at','2026-10-01T10:00:00.001Z')]:
                if occurrence[field]==value: continue
                changed={**occurrence,field:value}
                with self.subTest(field=field), self.assertRaises(RegistryError):
                    self.store.enqueue(job['id'],key,'local-event-trigger',self.cfg,event_occurrence=changed)

    def test_completion_revalidates_grant_and_original_definition_without_new_source(self):
        job=self.scheduled(); self.now='2026-10-01T10:05:00.000Z'; run=self.enqueue(job); original=self.raw(run)
        self.store.claim_next()
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        result=fixtures.DraftTests.complete_result(self)
        directory=self.registry.directory/'runs'/run['id']; directory.mkdir(mode=0o700,parents=True)
        saved=drafts.publish(result,self.root,directory)
        missing=copy.deepcopy(original); missing.pop('draft_automation')
        forged=copy.deepcopy(original); forged['draft_automation']['definition_digest']='0'*64; self.resign(forged)
        for changed in (missing,forged):
            with self.subTest(grant=changed.get('draft_automation')):
                self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(pips._json(changed),run['id']))
                with self.assertRaises(RegistryError): self.store.finish(run['id'],result=saved)
                self.assertEqual(self.store.run(run['id'])['status'],'running')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(pips._json(original),run['id']))
        self.approve(job,{'goal':'A subsequently reviewed goal'})
        with patch.object(pips,'source_revision',side_effect=AssertionError('No source reread')):
            finished=self.store.finish(run['id'],result=saved)
        self.assertEqual(finished['status'],'succeeded')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_checkpoints').fetchone()[0],0)
        # Historical projection needs the original saved version, never a live source.
        self.root.rename(self.base/'moved-source')
        identity, historical=drafts.stored(self.registry,self.workspace['id'],run['id'])
        self.assertEqual(identity['job_version'],2); self.assertEqual(historical,finished['result'])
        for changed in (missing,forged):
            self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(pips._json(changed),run['id']))
            with self.assertRaises(RegistryError): drafts.stored(self.registry,self.workspace['id'],run['id'])

    def test_controller_automatic_draft_publication_has_no_audit_or_execution_result(self):
        job=self.scheduled(); self.now='2026-10-01T10:05:00.000Z'; run=self.enqueue(job); manifest=self.raw(run)
        row=self.store.claim_next(); result=fixtures.DraftTests.worker_result(self)
        output=[{'kind':'policy_ready','digest':manifest['policy_digest']},{'kind':'result','result':result}]
        process=Mock(stdin=io.BytesIO(),stdout=io.BytesIO(b''.join((json.dumps(e)+'\n').encode() for e in output)))
        process.wait.return_value=0; process.poll.return_value=0
        popen=pips.subprocess.Popen
        def worker(argv,**kwargs):
            return process if argv[1:3]==['-m','dgc.pips'] else popen(argv,**kwargs)
        source=(self.root/'source.py').read_bytes()
        with patch.object(pips.subprocess,'Popen',side_effect=worker), patch.object(pips.threading,'Timer',return_value=Mock()), patch.object(pips.threading,'Thread',return_value=Mock()):
            final=pips._execute_run(self.registry,row,self.cfg)
        finished=self.store.finish(run['id'],result=final)
        self.assertEqual(finished['status'],'succeeded'); self.assertFalse(final['tests_executed'])
        self.assertEqual(final['draft']['artifact']['path'],drafts.ARTIFACT_PATH)
        self.assertEqual((self.root/'source.py').read_bytes(),source)
        self.assertNotIn('findings',final); self.assertNotIn('execution',final)

    def test_original_definition_cell_is_bounded_before_decode(self):
        job=self.scheduled()
        for row in self.registry.db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='pip_versions'").fetchall():
            self.registry.db.execute('DROP TRIGGER '+row[0])
        self.registry.db.execute('UPDATE pip_versions SET definition=? WHERE pip_id=? AND version=2',('x'*(automation.MAX_DEFINITION_BYTES+1),job['id']))
        with patch('dgc.pip_overview._json_object',side_effect=AssertionError('No oversized decode')), self.assertRaises(RegistryError):
            automation._definition(self.registry,job['id'],self.workspace['id'],2)

    def test_missing_grant_failed_run_stays_recordable(self):
        job=self.scheduled(); self.now='2026-10-01T10:05:00.000Z'; run=self.enqueue(job); manifest=self.raw(run)
        self.store.claim_next(); manifest.pop('draft_automation')
        self.registry.db.execute('DROP TRIGGER immutable_run_manifest')
        self.registry.db.execute('UPDATE pip_runs SET manifest=? WHERE id=?',(pips._json(manifest),run['id']))
        self.assertEqual(self.store.finish(run['id'],error={'code':'invalid_draft_automation','message':'Refused'})['status'],'failed')

    def test_pause_stop_archive_and_restore_keep_automation_inactive(self):
        from dgc import pip_archive, pip_daemon
        for trigger in ('schedule','event'):
            with self.subTest(trigger=trigger):
                self.now='2026-10-01T10:00:00.000Z'
                job=self.scheduled() if trigger=='schedule' else self.approve(self.create(),{'event_trigger':{'events':['context_updated']}})
                tick=schedules.tick if trigger=='schedule' else events.tick
                self.store.set_paused(job['id'],True,'human')
                self.now='2026-10-01T10:15:00.000Z'
                if trigger=='event': self.registry.event(self.workspace['id'],'workspace_context_recorded')
                self.assertEqual(tick(self.registry,self.cfg)['enqueued'],0)
                self.store.set_paused(job['id'],False,'human')
                self.assertEqual(tick(self.registry,self.cfg)['enqueued'],0)
                pip_daemon._set_paused(self.registry,True,'human')
                self.now='2026-10-01T10:30:00.000Z'
                if trigger=='event': self.registry.event(self.workspace['id'],'workspace_context_recorded')
                self.assertTrue(tick(self.registry,self.cfg)['stopped'])
                # Consume due calendar work while archived as well as event backlog.
                current=self.store.get(job['id'])
                archived=pip_archive.transition(self.store,job['id'],archived=True,expected_version=2,
                    expected_lifecycle_revision=current['lifecycle_revision'],request_key='archive-'+trigger,reason='Review complete',actor='human')['pip']
                self.now='2026-10-01T11:00:00.000Z'
                if trigger=='event': self.registry.event(self.workspace['id'],'workspace_context_recorded')
                restored=pip_archive.transition(self.store,job['id'],archived=False,expected_version=2,
                    expected_lifecycle_revision=archived['lifecycle_revision'],request_key='restore-'+trigger,reason='Resume later',actor='human')['pip']
                self.assertEqual(restored['status'],'paused')
                pip_daemon._set_paused(self.registry,False,'human')
                self.assertEqual(tick(self.registry,self.cfg)['enqueued'],0)
                self.store.set_paused(job['id'],False,'human',expected_lifecycle_revision=restored['lifecycle_revision'])
                self.assertEqual(tick(self.registry,self.cfg)['enqueued'],0)
                self.assertEqual(self.store.runs(job['id']),[])
                self.store.set_paused(job['id'],True,'human')

    def test_strict_grant_bounds_and_parent_row_identity(self):
        job=self.scheduled(); self.now='2026-10-01T10:05:00.000Z'; run=self.enqueue(job); original=self.raw(run)
        for field,value in [('schema_version',True),('job_version',True),('definition_digest','A'*64),
                            ('policy',{'type':'interval','minutes':True}),('extra',0),('digest','\ud800'),
                            ('occurrence',{'huge':'x'*4097})]:
            invalid=copy.deepcopy(original); invalid['draft_automation'][field]=value
            with self.subTest(field=field), self.assertRaises(RegistryError): automation.validate_manifest(invalid)
        row=dict(self.registry.db.execute('SELECT * FROM pip_runs WHERE id=?',(run['id'],)).fetchone())
        for field,value in [('pip_id','pip_'+'0'*32),('workspace_id','ws_'+'0'*32),('binding_id','bind_wrong'),
                            ('requested_by','human'),('idempotency_key','schedule:2:2026-10-01T10:10:00.000Z')]:
            with self.subTest(field=field), self.assertRaises(RegistryError):
                automation.validate_parent(self.registry,{**row,field:value},original)

    def test_event_pure_and_parent_checks_refuse_self_consistent_forged_policy(self):
        job=self.approve(self.create(),{'event_trigger':{'events':['context_updated']}})
        self.registry.event(self.workspace['id'],'workspace_context_recorded')
        occurrence=events.plan(self.registry,job['id'],now=self.now)
        run=self.store.enqueue(job['id'],events.occurrence_key(2,occurrence['event']['seq']),'local-event-trigger',self.cfg,event_occurrence=occurrence)
        original=self.raw(run); changed=copy.deepcopy(original)
        changed['event_trigger']['policy']['minimum_minutes']=60
        changed['draft_automation']['policy']['minimum_minutes']=60; self.resign(changed)
        automation.validate_manifest(changed)
        row=self.registry.db.execute('SELECT * FROM pip_runs WHERE id=?',(run['id'],)).fetchone()
        with self.assertRaises(RegistryError): automation.validate_parent(self.registry,row,changed)
        changed=copy.deepcopy(original); changed['draft_automation']['occurrence']['history_may_be_incomplete']=True; self.resign(changed)
        with patch('dgc.agent.Agent.__init__',side_effect=AssertionError('No Agent')), self.assertRaises(RegistryError):
            pips.execute_native(self.cfg,self.root,changed,lambda event:None)


if __name__=='__main__': unittest.main()
