"""Reviewed, queue-time source captures with deterministic races and real workers."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pips, pip_sources, pip_source_storage, pip_tree_snapshot, pip_source_changes
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures

TREE = {'mode': 'current_tree', 'exclusions': 'safe_source_v1'}


class CurrentTreeTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def create(self, role='rook'):
        return self.store.create(self.workspace['id'], 'Source reviewer', 'Inspect source.py', 'user', pip_type=role)

    def review(self, job, changes):
        proposal = self.store.propose(job['id'], job['current_version'], changes, 'user', 'Explicit source review')
        return self.store.accept(job['id'], proposal['id'], job['current_version'], 'user')

    def tree(self, role='rook'):
        (self.root / 'source.py').write_text("answer = 41\n", encoding='utf-8')
        return self.review(self.create(role), {'source_policy': TREE})

    def queue(self, job, key='first', **kwargs):
        return self.store.enqueue(job['id'], key, 'user', self.cfg, **kwargs)

    def copies(self):
        root = self.registry.directory / 'runs'
        return sorted(root.iterdir()) if root.exists() else []

    def raw(self, run):
        return json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run['id'],)).fetchone()[0])

    def test_explicit_review_required_and_model_cannot_change_source(self):
        job = self.create()
        proposal = self.store.propose(job['id'], 1, {'source_policy': TREE}, 'user')
        self.assertEqual(self.store.get(job['id'])['source_policy'], {'mode': 'committed_only'})
        with self.assertRaises(RegistryError): self.queue(job)
        self.registry.associate_session('chat', self.root)
        with self.assertRaises(RegistryError):
            self.store.propose(job['id'], 1, {'source_policy': TREE}, 'core_proposal', origin_session_id='chat',
                               request_key='change', expected_workspace_id=self.workspace['id'])
        self.assertEqual(self.store.get(job['id'])['current_version'], 1)
        self.store.accept(job['id'], proposal['id'], 1, 'user')
        self.assertEqual(self.store.get(job['id'])['source_policy'], TREE)

    def test_non_git_capture_is_private_excludes_secrets_and_preserves_old_bytes(self):
        job = self.tree()
        (self.root / '.env').write_text('SECRET=private')
        with patch.object(pips, '_git', side_effect=AssertionError('No Git for current tree')):
            run = self.queue(job)
        source = self.registry.directory / 'runs' / run['id'] / 'source'
        self.assertEqual((source / 'source.py').read_text(), 'answer = 41\n')
        self.assertFalse((source / '.env').exists())
        self.assertEqual(source.stat().st_mode & 0o777, 0o500)
        self.assertEqual((source / 'source.py').stat().st_mode & 0o777, 0o400)
        self.assertIsNone(run['manifest']['source_revision'])
        self.assertEqual(run['manifest']['source_snapshot']['excluded_entries'], 1)
        self.assertNotIn('source_root_identity', run['manifest'])
        (self.root / 'source.py').write_text('answer = 42\n')
        pip_tree_snapshot.verify(source, run['manifest']['source_snapshot'])
        self.assertEqual((source / 'source.py').read_text(), 'answer = 41\n')

    def test_capture_occurs_outside_queue_transaction_and_retry_never_recaptures(self):
        job = self.tree(); real = pip_tree_snapshot.capture
        def capture(*args, **kwargs):
            self.assertFalse(self.registry.db.in_transaction)
            return real(*args, **kwargs)
        with patch.object(pip_tree_snapshot, 'capture', capture): first = self.queue(job)
        with patch.object(pip_tree_snapshot, 'capture', side_effect=AssertionError('No retry copy')):
            self.assertEqual(self.queue(job)['id'], first['id'])
        self.assertEqual(len(self.copies()), 1)
        with self.registry.transaction(), self.assertRaisesRegex(RegistryError, 'outside'):
            self.queue(job, 'nested')

    def test_version_conflict_discards_only_its_provisional_copy(self):
        job = self.tree(); real = pip_tree_snapshot.capture
        def capture(*args, **kwargs):
            receipt = real(*args, **kwargs)
            self.review(job, {'name': 'New reviewed name'})
            return receipt
        with patch.object(pip_tree_snapshot, 'capture', capture), self.assertRaisesRegex(RegistryError, 'job changed'):
            self.queue(job)
        self.assertEqual(self.copies(), [])
        self.assertEqual(self.store.runs(job['id']), [])

    def test_concurrent_exact_retry_retains_one_copy_and_one_run(self):
        job = self.tree(); real = pip_tree_snapshot.capture
        entered = False
        winner = []
        def capture(*args, **kwargs):
            nonlocal entered
            receipt = real(*args, **kwargs)
            if not entered:
                entered = True
                with WorkspaceRegistry(self.registry.directory) as second:
                    winner.append(pips.PipStore(second).enqueue(job['id'], 'first', 'user', self.cfg))
            return receipt
        with patch.object(pip_tree_snapshot, 'capture', capture): loser = self.queue(job)
        self.assertEqual(loser['id'], winner[0]['id'])
        self.assertEqual([p.name for p in self.copies()], [winner[0]['id']])
        self.assertEqual(len(self.store.runs(job['id'])), 1)

    def test_root_replacement_after_capture_refuses_and_cleans(self):
        job = self.tree(); real = pip_tree_snapshot.capture
        def capture(*args, **kwargs):
            receipt = real(*args, **kwargs)
            self.root.rename(self.base / 'old-root')
            self.root.mkdir()
            (self.root / 'source.py').write_text('different root\n')
            return receipt
        with patch.object(pip_tree_snapshot, 'capture', capture), self.assertRaisesRegex(RegistryError, 'directory changed'):
            self.queue(job)
        self.assertEqual(self.copies(), [])

    def test_queue_transaction_rollback_discards_its_source_copy(self):
        job=self.tree(); real=self.registry.event
        def event(workspace_id,event_type,**kwargs):
            if event_type=='pip_run_queued': raise RegistryError('fixture','Queue event failed')
            return real(workspace_id,event_type,**kwargs)
        with patch.object(self.registry,'event',event), self.assertRaisesRegex(RegistryError,'Queue event failed'):
            self.queue(job)
        self.assertEqual(self.copies(),[])
        self.assertEqual(self.store.runs(job['id']),[])

    def test_cleanup_does_not_delete_a_replacement_source_directory(self):
        job=self.tree()
        outside=self.base/'unrelated';outside.mkdir();(outside/'keep').write_text('untouched')
        from dgc import pip_checkpoints
        real=pip_checkpoints.snapshot
        def checkpoint(*args,**kwargs):
            if not self.registry.db.in_transaction and self.copies():
                source=self.copies()[0]/'source'
                source.rename(self.copies()[0]/'captured-source')
                outside.rename(source)
                raise RegistryError('fixture','Queue preparation failed')
            return real(*args,**kwargs)
        with patch.object(pip_checkpoints,'snapshot',checkpoint),self.assertRaisesRegex(RegistryError,'Queue preparation failed'):
            self.queue(job)
        self.assertEqual((self.copies()[0]/'source'/'keep').read_text(),'untouched')
        self.assertEqual(self.store.runs(job['id']),[])

    def test_rebind_after_capture_refuses_without_source_remap(self):
        job = self.tree(); real = pip_tree_snapshot.capture
        moved = self.base / 'moved'
        def capture(*args, **kwargs):
            receipt = real(*args, **kwargs)
            self.root.rename(moved)
            self.registry.rebind(self.workspace['id'], moved, expected_root=self.root)
            return receipt
        with patch.object(pip_tree_snapshot, 'capture', capture), self.assertRaisesRegex(RegistryError, 'binding changed'):
            self.queue(job)
        self.assertEqual(self.copies(), [])

    def test_oversize_symlink_secret_and_queue_failure_leave_no_run(self):
        job = self.tree()
        for kind in ('symlink', 'oversize', 'secret', 'queue'):
            with self.subTest(kind=kind):
                suspect = self.root / 'suspect'
                if kind == 'symlink': suspect.symlink_to(self.root / 'source.py')
                elif kind == 'oversize':
                    with suspect.open('wb') as stream: stream.truncate(4 * 1024 * 1024 + 1)
                elif kind == 'secret': suspect.write_text('private-configured-fixture-token')
                context = patch.object(pips, 'MAX_QUEUE', 0) if kind == 'queue' else patch('dgc.redaction.secret_values', return_value=['private-configured-fixture-token'])
                with context, self.assertRaises(RegistryError): self.queue(job, kind)
                if suspect.is_symlink() or suspect.exists(): suspect.unlink()
                self.assertEqual(self.copies(), [])
                self.assertEqual(self.store.runs(job['id']), [])

    def test_automatic_roles_and_combined_policy_switch(self):
        job = self.create()
        schedule = {'type':'interval', 'minutes':60}
        job = self.review(job, {'schedule':schedule})
        with self.assertRaisesRegex(RegistryError, 'manual'): self.review(job, {'source_policy':TREE})
        job = self.review(job, {'source_policy':TREE, 'schedule':None, 'event_trigger':None})
        self.assertIsNone(job['schedule'])
        for field in ({'schedule':schedule}, {'event_trigger':{'events':['context_updated'],'minimum_minutes':5}}):
            with self.assertRaises(RegistryError): self.review(job, field)
        for role in ('patch','pulse'):
            with self.assertRaises(RegistryError): self.review(self.create(role), {'source_policy':TREE})
        back = self.review(job, {'source_policy':{'mode':'committed_only'}})
        self.assertIsNone(back['schedule']); self.assertIsNone(back['event_trigger'])

    def test_source_diff_receipts_are_unavailable_and_domain_bound(self):
        current = pip_sources.pin(TREE, source_revision=None, source_snapshot={
            'schema_version':1,'kind':'current_tree','sha256':'b'*64,'files':1,'bytes':12,
            'exclusions':'safe_source_v1','excluded_entries':0,'excluded_directories':0,'consistency':'checked_non_atomic'})
        for previous in (None, {'id':1,'source_revision':'a'*40}, {'id':2,**current}):
            checkpoint={'checkpoint':previous}
            with patch.object(pip_source_changes, '_capture', side_effect=AssertionError('No Git diff')):
                value=pip_source_changes.snapshot_for_source(self.root,current,checkpoint)
            self.assertEqual(value['schema_version'],2)
            self.assertIsNone(value['total_changes'])
            self.assertEqual(value['reason'],'current_tree_source')
            self.assertEqual(pip_source_changes.validate_for_source(value,current,checkpoint),value)
            with self.assertRaises(RegistryError):
                pip_source_changes.validate_for_source({**value,'total_changes':0},current,checkpoint)
        committed=pip_sources.pin('committed_only',source_revision='c'*40)
        checkpoint={'checkpoint':{'id':2,**current}}
        with patch.object(pip_source_changes,'_capture',side_effect=AssertionError('No mixed-domain Git diff')):
            value=pip_source_changes.snapshot_for_source(self.root,committed,checkpoint)
        self.assertEqual(value['reason'],'current_tree_source')
        self.assertIsNone(value['total_changes'])
        self.assertEqual(pip_source_changes.validate_for_source(value,committed,checkpoint),value)

    def test_snapshot_result_mismatch_cannot_be_finished(self):
        job=self.tree();run=self.queue(job);self.store.claim_next()
        result={'summary':'Source inspected','findings':[],'limitations':[],
                'verification':'Source excerpts checked against the pinned snapshot; findings are model assessments.',
                'tests_executed':False,'snapshot':{'sha256':'a'*64,'files':1,'bytes':1}}
        with self.assertRaisesRegex(RegistryError,'does not match'):
            self.store.finish(run['id'],result=result)
        self.assertEqual(self.store.run(run['id'])['status'],'running')

    def test_metadata_and_text_proposals_preserve_reviewed_source(self):
        job=self.tree()
        job=self.review(job,{'adaptation_policy':{'mode':'autonomous','allowed_fields':['name','source_ref']}})
        self.registry.associate_session('source-chat',self.root)
        result=self.store.adapt(job['id'],job['current_version'],{'name':'New display name'},'Metadata only',
            origin_session_id='source-chat',request_key='name',expected_workspace_id=job['workspace_id'])
        changed=self.store.get(job['id'])
        self.assertTrue(result['job_changed_by_this_call'])
        self.assertEqual(changed['source_policy'],TREE)
        with self.assertRaisesRegex(RegistryError,'does not use a Git source ref'):
            self.store.adapt(job['id'],changed['current_version'],{'source_ref':'another-branch'},'Dormant source',
                origin_session_id='source-chat',request_key='ref',expected_workspace_id=job['workspace_id'])
        changed=self.review(changed,{'goal':'Review the captured current source'})
        self.assertEqual(changed['source_policy'],TREE)
        self.assertEqual(self.store.runs(job['id']),[])

    def test_main_chat_pin_is_manual_and_preserves_private_origin(self):
        job=self.tree()
        from dgc import pip_run_tool
        self.registry.associate_session('source-chat',self.root)
        pin={'schema_version':1,'pip_id':job['id'],'expected_version':job['current_version'],
             'reason':'Inspect current source','request_key':'current','session_id':'source-chat',
             'workspace_id':job['workspace_id']}
        actor,key=pip_run_tool.identities(pin)
        run=self.store.enqueue(job['id'],key,actor,self.cfg,main_chat_request=pin)
        self.assertEqual(run['manifest']['trigger'],'main_chat')
        self.assertEqual(run['manifest']['source_policy'],TREE)
        self.assertNotIn('main_chat_request',run['manifest'])
        self.assertEqual(self.raw(run)['main_chat_request'],pin)

    def test_private_run_storage_symlink_refused_without_touching_target(self):
        job=self.tree()
        outside=self.base/'outside';outside.mkdir()
        (outside/'marker').write_text('untouched')
        (self.registry.directory/'runs').symlink_to(outside,target_is_directory=True)
        with self.assertRaises(RegistryError): self.queue(job)
        self.assertEqual(list(outside.iterdir()),[outside/'marker'])
        self.assertEqual((outside/'marker').read_text(),'untouched')

    def test_parent_refuses_changed_copy_or_replaced_root_before_spawn(self):
        for kind in ('copy','root'):
            with self.subTest(kind=kind):
                job=self.tree(); run=self.queue(job,kind); row=self.store.claim_next()
                if kind=='copy':
                    source=self.registry.directory/'runs'/run['id']/'source'/'source.py'
                    source.chmod(0o600); source.write_text('tampered\n'); source.chmod(0o400)
                else:
                    self.root.rename(self.base/'old-at-claim'); self.root.mkdir()
                with patch.object(pips.subprocess,'Popen',side_effect=AssertionError('No worker')), self.assertRaises(RegistryError):
                    pips._execute_run(self.registry,row,self.cfg)
                self.store.finish(run['id'],error={'code':'fixture','message':'Rejected unsafe source'})

    def test_worker_and_result_use_queue_time_non_git_source(self):
        job=self.tree(); run=self.queue(job); row=self.store.claim_next()
        (self.root/'source.py').write_text('answer = 99\n')
        fixture=r'''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
responses=iter([ChatResult(tool_calls=[ToolCall('read','read_file',{'path':'source.py'})]),
 ChatResult(content=json.dumps({'summary':'Inspected queue-time source','findings':[{'title':'Fixture evidence',
 'severity':'low','path':'source.py','line':1,'evidence':'answer = 41'}],'limitations':['No tests run']}))])
def chat(self,messages,tools=None,on_text=None,**kwargs):
 assert all(tool['function']['name'] in {'read_file','glob','grep','repo_map','todo'} for tool in tools)
 assert 'captured current-tree snapshot' in messages[0]['content']
 value=next(responses)
 if value.content and on_text: on_text(value.content)
 return value
with patch.object(LLMClient,'chat',chat),patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
 raise SystemExit(_worker_main())
'''
        original=subprocess.Popen
        def process(argv,*args,**kwargs):
            if argv[1:]==['-m','dgc.pips','--worker']: argv=[sys.executable,'-c',fixture]
            return original(argv,*args,**kwargs)
        with patch.object(pips.subprocess,'Popen',side_effect=process), patch.object(pips,'clean_snapshot',side_effect=AssertionError('No Git source copy')):
            result=pips._execute_run(self.registry,row,self.cfg)
        finished=self.store.finish(run['id'],result=result)
        self.assertEqual(finished['status'],'succeeded')
        self.assertEqual(finished['result']['tools_called'],1)
        self.assertEqual(finished['result']['findings'][0]['evidence'],'answer = 41')
        self.assertEqual((self.root/'source.py').read_text(),'answer = 99\n')
        from dgc.pip_checkpoints import for_run
        checkpoint=for_run(self.store,run['id'])
        self.assertEqual(checkpoint['schema_version'],2)
        self.assertIsNone(checkpoint['source_revision'])
        self.assertEqual(checkpoint['source_snapshot'],run['manifest']['source_snapshot'])
        from dgc.workspace_context import ContextStore, validate_snapshot
        contexts=ContextStore(self.registry)
        contexts.accept_finding(self.workspace['id'],run['id'],0,0,'user')
        context=contexts.snapshot(self.workspace['id'])
        validate_snapshot(context,self.workspace['id'])
        provenance=context['entries'][0]['provenance']
        self.assertEqual(provenance['schema_version'],2)
        self.assertIsNone(provenance['source_revision'])

    def test_quill_artifact_and_paused_conversation_reuse_source_contract(self):
        job=self.tree('quill')
        draft={'title':'Source notes','summary':'A small draft','markdown':'# Source notes\nThe answer is 41.\n',
               'citations':[{'path':'source.py','line':1,'excerpt':'answer = 41'}]}
        from dgc import pip_chat, pip_drafts
        replies=[draft,'The captured source sets answer to 41.']
        for index,reply in enumerate(replies):
            if index==0: run=self.queue(job,'draft')
            else:
                self.store.set_paused(job['id'],True,'user')
                run=pip_chat.send(self.store,job['id'],'Explain the draft','conversation','user',self.cfg)['run']
            row=self.store.claim_next()
            fixture='''
import json
from unittest.mock import patch
from dgc.llm import LLMClient, ChatResult, ToolCall
from dgc.pips import _worker_main
reply = %r
responses=iter([ChatResult(tool_calls=[ToolCall('read','read_file',{'path':'source.py'})]),ChatResult(content=reply)])
def chat(self,messages,tools=None,on_text=None,**kwargs):
 assert 'captured current-tree snapshot' in messages[0]['content']
 value=next(responses)
 if value.content and on_text: on_text(value.content)
 return value
with patch.object(LLMClient,'chat',chat),patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
 raise SystemExit(_worker_main())
''' % (json.dumps(reply) if isinstance(reply,dict) else reply)
            original=subprocess.Popen
            def process(argv,*args,**kwargs):
                if argv[1:]==['-m','dgc.pips','--worker']: argv=[sys.executable,'-c',fixture]
                return original(argv,*args,**kwargs)
            with patch.object(pips.subprocess,'Popen',side_effect=process): result=pips._execute_run(self.registry,row,self.cfg)
            completed=self.store.finish(run['id'],result=result)
            self.assertEqual(completed['status'],'succeeded')
            if index==0:
                identity,saved=pip_drafts.stored(self.registry,job['workspace_id'],run['id'])
                self.assertEqual(identity['source_policy'],TREE)
                self.assertIsNone(identity['source_revision'])
                self.assertEqual((self.registry.directory/'runs'/run['id']/saved['draft']['artifact']['path']).read_text(),draft['markdown'])
            else:
                raw=self.raw(run)
                self.assertEqual(raw['conversation']['last_report']['source_policy'],TREE)
                messages=pip_chat.list_messages(self.store,job['id'])['messages']
                self.assertEqual(next(item['text'] for item in messages if item['role']=='assistant'),reply)


if __name__=='__main__': unittest.main()
