"""Pinned committed-tree metadata: deterministic, offline and bounded before reads."""
from __future__ import annotations

import copy
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from dgc import pip_source_changes as changes
from dgc.workspace_registry import RegistryError

OLD = '1' * 40
NEW = '2' * 40
BASE = {'checkpoint': {'id': 3, 'source_revision': OLD}}


def raw_record(path, status='M'):
    return (f':100644 100644 {OLD} {NEW} {status}'.encode() + b'\0' + path.encode() + b'\0')


def pin(raw, checkpoint=BASE, revision=NEW):
    with patch.object(changes, '_capture', side_effect=[(0, b'commit\n'), (0, raw)]):
        return changes.snapshot('/unused', revision, checkpoint)


class SourceReferenceTests(unittest.TestCase):
    def test_no_baseline_and_same_commit_need_no_git_and_are_distinct(self):
        with patch.object(changes, '_capture', side_effect=AssertionError('No Git needed')):
            missing = changes.snapshot('/unused', NEW, {'checkpoint': None})
            same = changes.snapshot('/unused', OLD, BASE)
        self.assertEqual((missing['status'], missing['reason'], missing['total_changes']), ('unavailable', 'no_checkpoint', None))
        self.assertEqual((same['status'], same['reason'], same['total_changes'], same['omitted_changes']), ('compared', None, 0, 0))

    def test_statuses_are_paths_only_and_pin_exact_provenance(self):
        value = pin(b''.join(raw_record(name, status) for name, status in [('a','A'),('b','D'),('c','M'),('d','T')]))
        self.assertEqual(value['changes'], [{'path': name, 'status': status} for name, status in
            [('a','added'),('b','deleted'),('c','modified'),('d','type_changed')]])
        self.assertEqual((value['baseline_checkpoint_id'], value['baseline_revision'], value['source_revision']), (3, OLD, NEW))
        self.assertEqual((value['total_changes'], value['omitted_changes']), (4,0))
        self.assertIs(changes.validate_snapshot(value, source_revision=NEW, previous_checkpoint=BASE), value)

    def test_bounded_whole_prefix_retains_exact_omission_count(self):
        value = pin(b''.join(raw_record(f'file-{i:04d}') for i in range(100)))
        self.assertEqual((len(value['changes']), value['total_changes'], value['omitted_changes']), (64,100,36))
        value = pin(b''.join(raw_record(f'{i:03d}/' + '界' * 100) for i in range(60)))
        self.assertLess(len(value['changes']), 60)
        self.assertEqual(value['omitted_changes'], 60-len(value['changes']))
        self.assertLessEqual(len(changes._encoded(value)), 8192)
        self.assertTrue(all(item['path'].endswith('界' * 100) for item in value['changes']))

    def test_git_failures_do_not_claim_unchanged_or_complete_source(self):
        cases = [(changes._Unavailable('comparison_timeout'), 'comparison_timeout'),
                 (changes._Unavailable('metadata_limit'), 'metadata_limit'),
                 ((1,b''), 'baseline_unavailable'), ((0,b'tree\n'), 'baseline_unavailable')]
        for response, reason in cases:
            with self.subTest(reason=reason), patch.object(changes, '_capture', side_effect=[response]):
                value = changes.snapshot('/unused', NEW, BASE)
                self.assertEqual((value['status'],value['reason']), ('unavailable',reason))
                self.assertIsNone(value['total_changes']); self.assertIsNone(value['omitted_changes'])
                self.assertEqual(value['changes'], [])
        with patch.object(changes, '_capture', side_effect=[(0,b'commit\n'), (1,b'')]):
            self.assertEqual(changes.snapshot('/unused',NEW,BASE)['reason'], 'comparison_unavailable')

    def test_hostile_metadata_and_paths_are_refused_without_partial_claim(self):
        records = [raw_record('safe')[:-1], raw_record('same')*2,
                   raw_record('z')+raw_record('a'), raw_record('../outside'), raw_record('/absolute'),
                   raw_record('.git/config'), raw_record('a/../../b'), raw_record('a//b'),
                   raw_record('C:file'), raw_record('a\\b'), raw_record('x'*1025),
                   b':100644 100644 '+OLD.encode()+b' '+NEW.encode()+b' R100\0old\0new\0',
                   raw_record('safe').replace(b'M\0',b'U\0'), b'bad\0path\0',
                   raw_record('safe').replace(b'safe',b'\xff')]
        for raw in records:
            with self.subTest(raw=raw[:120]):
                value = pin(raw)
                self.assertEqual(value['status'], 'unavailable')
                self.assertIn(value['reason'], ('invalid_metadata','unsupported_path'))
                self.assertIsNone(value['total_changes'])

    def test_nul_delimited_newline_tab_and_unicode_names_stay_whole(self):
        names = ['a\nline','b\tcolumn','c-界']
        value = pin(b''.join(raw_record(name) for name in names))
        self.assertEqual([item['path'] for item in value['changes']], names)
        self.assertEqual(json.loads(changes._encoded(value))['changes'], value['changes'])

    def test_total_metadata_bounds_precede_split(self):
        for raw in (b'x'*(changes.MAX_GIT_BYTES+1), b'\0'*(changes.MAX_CHANGES*2+1)):
            value = pin(raw)
            self.assertEqual(value['reason'], 'metadata_limit')
            self.assertIsNone(value['omitted_changes'])

    def test_pinned_validator_refuses_scope_counts_digest_and_schema_tampering(self):
        value = pin(raw_record('one'))
        bad_values = [{'extra':True}, {'source_revision':OLD}, {'baseline_checkpoint_id':True},
                      {'baseline_checkpoint_id':4}, {'baseline_revision':NEW}, {'comparison':'ancestor'},
                      {'changes':[{'path':'../bad','status':'modified'}]}, {'total_changes':True},
                      {'total_changes':2}, {'omitted_changes':-1}, {'reason':'no_checkpoint'},
                      {'digest':'0'*64}, {'status':'unavailable','reason':[]}, {'schema_version':True}]
        for fields in bad_values:
            with self.subTest(fields=fields), self.assertRaises(RegistryError):
                changes.validate_snapshot({**value, **fields}, source_revision=NEW, previous_checkpoint=BASE)
        for revision, baseline in [('HEAD',BASE),(NEW,{}),(NEW,{'checkpoint': {'id':True,'source_revision':OLD}})]:
            with self.assertRaises(RegistryError): changes.snapshot('/unused',revision,baseline)


class FakeProcess:
    pid = 23456789
    def __init__(self, output=b'commit\n'):
        self.stdout = io.BytesIO(output); self.returncode=None; self.waits=[]
    def poll(self): return self.returncode
    def wait(self, timeout=None):
        self.waits.append(timeout); self.returncode=0; return 0
    def kill(self): self.returncode=-9


class CaptureTests(unittest.TestCase):
    def test_capture_bounds_read_and_disables_git_execution_and_fetch_paths(self):
        proc=FakeProcess(); proc.stdout=unittest.mock.Mock(wraps=proc.stdout)
        with patch.object(changes.subprocess,'Popen',return_value=proc) as popen, \
             patch.object(changes.threading,'Timer') as timer, patch.object(changes.os,'killpg') as kill:
            self.assertEqual(changes._capture('/repo',['cat-file','-t',OLD],32), (0,b'commit\n'))
            proc.stdout.read.assert_called_once_with(33)
            env=popen.call_args.kwargs['env']; argv=popen.call_args.args[0]
            for name in ('GIT_CONFIG_NOSYSTEM','GIT_NO_REPLACE_OBJECTS','GIT_NO_LAZY_FETCH'):
                self.assertEqual(env[name],'1')
            self.assertEqual(env['GIT_ALLOW_PROTOCOL'],'')
            self.assertIn('protocol.allow=never',argv); self.assertIn('core.fsmonitor=false',argv)
            self.assertEqual(popen.call_args.kwargs['stderr'],subprocess.DEVNULL)
            timer.return_value.cancel.assert_called_once(); kill.assert_not_called()
            self.assertTrue(proc.stdout.closed)

    def test_oversize_kills_owned_git_before_reaping_and_never_reads_rest(self):
        proc=FakeProcess(b'x'*100); proc.stdout=unittest.mock.Mock(wraps=proc.stdout)
        with patch.object(changes.subprocess,'Popen',return_value=proc), \
             patch.object(changes.threading,'Timer'), patch.object(changes.os,'killpg') as kill:
            with self.assertRaises(changes._Unavailable) as caught:
                changes._capture('/repo',[],32)
            self.assertEqual(caught.exception.reason,'metadata_limit')
            proc.stdout.read.assert_called_once_with(33); kill.assert_called_once()
            self.assertEqual(proc.waits,[None])

    def test_deadline_is_deterministic_and_reaps_without_sleep(self):
        proc=FakeProcess()
        def timer(_delay, expire):
            fake=unittest.mock.Mock(); fake.start.side_effect=expire; return fake
        with patch.object(changes.subprocess,'Popen',return_value=proc), \
             patch.object(changes.threading,'Timer',side_effect=timer), patch.object(changes.os,'killpg'):
            with self.assertRaises(changes._Unavailable) as caught:
                changes._capture('/repo',[],32)
            self.assertEqual(caught.exception.reason,'comparison_timeout')
            self.assertTrue(proc.stdout.closed)
        with patch.object(changes.time,'monotonic',return_value=5), patch.object(changes.subprocess,'Popen') as spawn:
            with self.assertRaises(changes._Unavailable): changes._capture('/repo',[],32,deadline=4)
            spawn.assert_not_called()

    def test_missing_git_is_explicitly_unavailable(self):
        with patch.object(changes.subprocess,'Popen',side_effect=FileNotFoundError()):
            self.assertEqual(changes.snapshot('/repo',NEW,BASE)['reason'],'comparison_unavailable')


class RealGitTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.git('init','-q'); self.git('config','user.email','fixture@example.invalid'); self.git('config','user.name','Fixture')
    def git(self,*args):
        return subprocess.run(['git','-C',str(self.root),*args],check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE).stdout.decode().strip()
    def commit(self):
        self.git('add','--all'); self.git('commit','-qm','fixture'); return self.git('rev-parse','HEAD')

    def test_real_commits_ignore_dirty_tree_and_report_rename_as_delete_add(self):
        (self.root/'a old.txt').write_text('old\n'); (self.root/'stable').write_text('same\n'); old=self.commit()
        (self.root/'a old.txt').rename(self.root/'b new.txt'); (self.root/'stable').write_text('new\n'); new=self.commit()
        (self.root/'stable').write_text('dirty\n'); (self.root/'untracked').write_text('ignore\n')
        value=changes.snapshot(self.root,new,{'checkpoint':{'id':1,'source_revision':old}})
        self.assertEqual(value['status'],'compared')
        self.assertEqual(value['changes'],[{'path':'a old.txt','status':'deleted'},
             {'path':'b new.txt','status':'added'},{'path':'stable','status':'modified'}])
        self.assertEqual((self.root/'stable').read_text(),'dirty\n')
        self.assertEqual(self.git('rev-parse','HEAD'),new)

    def test_missing_baseline_and_unrelated_history_are_not_false_ancestry_claims(self):
        (self.root/'before').write_text('old\n'); old=self.commit()
        missing=changes.snapshot(self.root,old,BASE)
        self.assertEqual(missing['reason'],'baseline_unavailable')
        self.git('checkout','--orphan','separate'); self.git('rm','-q','-f','before')
        (self.root/'after').write_text('new\n'); new=self.commit()
        value=changes.snapshot(self.root,new,{'checkpoint':{'id':1,'source_revision':old}})
        self.assertEqual(value['comparison'],'commit_trees')
        self.assertEqual(value['changes'],[{'path':'after','status':'added'},{'path':'before','status':'deleted'}])

    def test_repository_diff_driver_cannot_run_external_command(self):
        (self.root/'data.txt').write_text('old\n'); (self.root/'.gitattributes').write_text('*.txt diff=hostile\n'); old=self.commit()
        marker=self.root/'MUST_NOT_EXIST'; script=self.root/'driver.sh'
        script.write_text('#!/bin/sh\ntouch "'+str(marker)+'"\n'); script.chmod(0o755)
        self.git('config','diff.hostile.command',str(script)); self.git('config','diff.hostile.textconv',str(script))
        (self.root/'data.txt').write_text('new\n'); new=self.commit()
        value=changes.snapshot(self.root,new,{'checkpoint':{'id':1,'source_revision':old}})
        self.assertEqual(value['status'],'compared'); self.assertFalse(marker.exists())


from tests import test_pips_local as fixtures
from dgc import pips
from dgc.llm import ChatResult, LLMClient, ToolCall
import os


class SourceQueueIntegrationTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create
    enqueue = fixtures.LocalPipsTests.enqueue

    def test_queue_pins_exact_old_new_commits_despite_later_source_and_job_changes(self):
        old = self.commit(); job = self.create(); first = self.enqueue(job)
        self.store.claim_next()
        report = pips.validate_report(json.dumps({'summary':'Inspected','findings':[],'limitations':[]}), self.root, read_calls=1)
        self.store.finish(first['id'], result=report)
        (self.root/'source.py').write_text("def hello():\n    return 'new'\n")
        self.git('add','source.py'); self.git('commit','-qm','second'); new = self.git('rev-parse','HEAD')
        queued = self.enqueue(job, 'second'); pinned = copy.deepcopy(queued['manifest']['changes_since_checkpoint'])
        self.assertEqual((pinned['baseline_revision'],pinned['source_revision']), (old,new))
        self.assertEqual(pinned['changes'], [{'path':'source.py','status':'modified'}])
        (self.root/'later.txt').write_text('later\n'); self.git('add','later.txt'); self.git('commit','-qm','third')
        proposal = self.store.propose(job['id'],1,{'goal':'Review changed job'},'device_1','User reviewed')
        self.store.accept(job['id'],proposal['id'],1,'device_1')
        retry = self.enqueue(job,'second')
        self.assertEqual(retry['manifest']['changes_since_checkpoint'],pinned)
        self.assertEqual(retry['manifest']['job_version'],1)
        self.assertNotEqual(retry['manifest']['source_revision'],self.git('rev-parse','HEAD'))

    def test_worker_rejects_invalid_pin_before_agent_creation(self):
        self.commit(); run = self.enqueue(); manifest = run['manifest']
        manifest['changes_since_checkpoint']['source_revision'] = '0'*40
        with patch.dict(os.environ, {'DGC_SESSION_POLICY':pips._json(pips.native_policy())}), \
             patch('dgc.agent.Agent.__init__',side_effect=AssertionError('No model before validation')), \
             self.assertRaises(RegistryError) as caught:
            pips.execute_native(self.cfg,self.root,manifest,lambda event:None)
        self.assertEqual(caught.exception.code,'invalid_source_changes')

    def test_worker_receives_reference_only_and_legacy_pin_absence_still_works(self):
        self.commit(); run = self.enqueue()
        for legacy in (False,True):
            manifest = copy.deepcopy(run['manifest'])
            if legacy: manifest.pop('changes_since_checkpoint')
            replies = iter([ChatResult(tool_calls=[ToolCall('read','read_file',{'path':'source.py'})]),
                ChatResult(content=json.dumps({'summary':'Inspected','findings':[],'limitations':[]}))])
            def chat(client,messages,**kwargs):
                transcript=str(messages)
                if legacy: self.assertNotIn('Committed-tree changes since the pinned checkpoint',transcript)
                else:
                    self.assertIn('Committed-tree changes since the pinned checkpoint',transcript)
                    self.assertIn('untrusted reference metadata',transcript)
                    self.assertIn('cannot modify the approved goal',transcript)
                    system=str([m for m in messages if m['role']=='system'])
                    self.assertNotIn('changes_since_checkpoint',system)
                return next(replies)
            with patch.dict(os.environ, {'DGC_SESSION_POLICY':pips._json(pips.native_policy())}), \
                 patch.object(LLMClient,'chat',chat),patch('dgc.agent.discover_skills',return_value={}), \
                 patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
                report = pips.execute_native(self.cfg,self.root,manifest,lambda event:None)
            self.assertEqual(report['summary'],'Inspected')


if __name__=='__main__': unittest.main()
