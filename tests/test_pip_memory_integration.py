"""Queue and real subprocess/native Agent reference plumbing with mocked model I/O."""
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pip_memory as memory,pips
from dgc.workspace_registry import RegistryError
from tests import test_pip_checkpoint_integration as fixtures


class MemoryIntegrationTests(unittest.TestCase):
    setUp=fixtures.CheckpointIntegrationTests.setUp
    git=fixtures.CheckpointIntegrationTests.git
    commit=fixtures.CheckpointIntegrationTests.commit
    create=fixtures.CheckpointIntegrationTests.create
    completed=fixtures.CheckpointIntegrationTests.completed
    control=fixtures.CheckpointIntegrationTests.control

    def prepare(self):
        job=self.create();first=self.completed(job,'first')
        candidate=memory.source_exception(self.store,job['id'],first['id'],0)
        saved=memory.record_exception(self.store,job['id'],first['id'],0,candidate['digest'],
            'Known fixture tradeoff; inspect again',None,'fixture-exception','device')['memory']
        return job,first,saved

    def test_queue_pins_current_memory_and_revoke_does_not_rewrite_it(self):
        job,_,saved=self.prepare();run=self.store.enqueue(job['id'],'second','device_1',self.cfg)
        pin=run['manifest']['pip_memory']
        self.assertEqual(pin['entries'][0]['memory']['id'],saved['id'])
        memory.revoke_exception(self.store,job['id'],saved['id'],0,'Reconsider','device')
        self.assertEqual(self.store.run(run['id'])['manifest']['pip_memory'],pin)
        self.assertEqual(self.store.enqueue(job['id'],'second','device_1',self.cfg)['id'],run['id'])
        next_run=self.store.enqueue(job['id'],'third','device_1',self.cfg)
        self.assertEqual(next_run['manifest']['pip_memory']['entries'],[])

    def test_conversation_pins_validated_exception_reference(self):
        job,_,saved=self.prepare()
        from dgc import pip_chat
        run=pip_chat.send(self.store,job['id'],'Discuss source','chat-key','device_1',self.cfg)['run']
        manifest=run['manifest']
        pin=memory.validate_snapshot(manifest['pip_memory'],pip_id=job['id'],
            workspace_id=job['workspace_id'],job_version=manifest['job_version'],
            source={key:manifest[key] for key in ('source_policy','source_revision','source_snapshot')})
        self.assertEqual(pin['entries'][0]['memory'],saved)
        self.assertEqual(pin['entries'][0]['applicability'],'exact_source_and_job')
        self.assertEqual(pin['entries'][0]['memory']['effect'],'reference_only')

    def test_memory_failure_rolls_back_queue_and_event(self):
        job,_,_=self.prepare();before=self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0]
        with patch('dgc.pip_memory.snapshot',side_effect=RegistryError('memory_limit','Fixture')),self.assertRaises(RegistryError):
            self.store.enqueue(job['id'],'second','device_1',self.cfg)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0],before)

    def test_real_worker_receives_reference_without_suppressing_report(self):
        job,_,_=self.prepare();run=self.store.enqueue(job['id'],'second','device_1',self.cfg);row=self.store.claim_next()
        fixture='''
import json
from unittest.mock import patch
from dgc.llm import LLMClient,ChatResult,ToolCall
from dgc.pips import _worker_main
calls=0
def chat(self,messages,tools=None,on_text=None,**kwargs):
 global calls
 calls+=1
 joined=json.dumps(messages)
 assert 'Pip-local exceptions' in joined
 assert 'Known fixture tradeoff; inspect again' in joined
 assert 'do not suppress findings' in joined
 assert 'not mean current workspace' in joined
 assert 'reference_only' in joined
 assert 'record_pip_exception' not in json.dumps(tools)
 result=(ChatResult(tool_calls=[ToolCall('read1','read_file',{'path':'source.py'})]) if calls==1 else ChatResult(content=json.dumps({'summary':'Still report the finding','findings':[{'title':'Review return value','severity':'low','path':'source.py','line':2,'evidence':"    return 'hello'"}],'limitations':['Exception does not prove correctness']})))
 if result.content and on_text:on_text(result.content)
 return result
with patch.object(LLMClient,'chat',chat),patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
 raise SystemExit(_worker_main())
'''
        original=subprocess.Popen
        def process(argv,*args,**kwargs):
            if argv[1:]==['-m','dgc.pips','--worker']:argv=[sys.executable,'-c',fixture]
            return original(argv,*args,**kwargs)
        with patch.object(pips.subprocess,'Popen',side_effect=process):
            result=pips._execute_run(self.registry,row,self.cfg)
        self.assertEqual(len(result['findings']),1)
        self.store.finish(run['id'],result=result)
        from dgc.pip_checkpoints import for_run
        self.assertEqual(for_run(self.store,run['id'])['findings'][0]['review']['status'],'open')


if __name__=='__main__':unittest.main()
