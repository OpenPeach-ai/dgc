"""Controller callback boundaries; local Git fixtures, no provider or network."""
import copy
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_execution as execution
from dgc.workspace_registry import RegistryError
from tests.test_pip_pulse_plans import plan


class PulseExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='dgc-pulse-execution-'); self.addCleanup(self.temp.cleanup)
        self.run=Path(self.temp.name); self.source=self.run/'source'; self.source.mkdir()
        (self.source/'source.py').write_text('answer = 42\n')
        self.gate=patch.object(execution,'require_capability',return_value={'available':True}); self.gate.start();self.addCleanup(self.gate.stop)
        self.prepared=execution.prepare_isolated_repo(self.source,self.run)
        self.action=plan()['action']

    def captured(self,**overrides):
        return {'status':'passed','exit_code':0,'data':b'fixture\n','truncated':False,**overrides}

    def test_callbacks_cannot_rewrite_native_commands_or_outcomes(self):
        seen=[]
        def before(index,command):
            seen.append(('before',index)); command['argv'][:]=['UNAPPROVED'];command['cwd']='../escape'
        def after(index,result):
            seen.append(('after',index));result['status']='failed';result['exit_code']=42
        with patch.object(execution,'_capture',return_value=self.captured()) as capture:
            result=execution.run_reviewed_tests(self.prepared,self.action,before_command=before,after_command=after)
        self.assertEqual(seen,[('before',0),('after',0),('before',1),('after',1)])
        self.assertTrue(all(v['status']=='passed' and v['exit_code']==0 for v in result))
        for index,call in enumerate(capture.call_args_list):
            self.assertEqual(call.args[0][-3:],self.action['tests'][index]['argv'][-3:])
            self.assertNotIn('UNAPPROVED',call.args[0])

    def test_reservation_failure_prevents_capture_and_any_later_command(self):
        with patch.object(execution,'_capture') as capture,self.assertRaises(RuntimeError):
            execution.run_reviewed_tests(self.prepared,self.action,before_command=lambda *_:(_ for _ in ()).throw(RuntimeError('reservation failed')))
        capture.assert_not_called()

    def test_failed_final_persistence_prevents_next_command(self):
        with patch.object(execution,'_capture',return_value=self.captured()) as capture,self.assertRaises(RuntimeError):
            execution.run_reviewed_tests(self.prepared,self.action,after_command=lambda *_:(_ for _ in ()).throw(RuntimeError('final persistence failed')))
        self.assertEqual(capture.call_count,1)

    def test_cancel_after_reservation_is_native_unexecuted_with_no_popen(self):
        cancelled=threading.Event(); completed=[]
        with patch.object(execution.subprocess,'Popen') as popen:
            result=execution.run_reviewed_tests(self.prepared,self.action,cancelled=cancelled,
                        before_command=lambda *_:cancelled.set(),after_command=lambda i,v:completed.append(v))
        popen.assert_not_called()
        self.assertEqual(len(result),1);self.assertEqual(result,completed)
        self.assertEqual(result[0]['status'],'cancelled');self.assertIsNone(result[0]['exit_code'])
        self.assertEqual(result[0]['artifact']['bytes'],0)

    def test_stopped_invocation_prevents_reserving_remaining_commands(self):
        before=[]
        with patch.object(execution,'_capture',return_value=self.captured(status='output_limit',exit_code=-9,truncated=True)) as capture:
            result=execution.run_reviewed_tests(self.prepared,self.action,before_command=lambda i,_:before.append(i))
        self.assertEqual(before,[0]);self.assertEqual(len(result),1);self.assertEqual(capture.call_count,1)

    def test_unmodified_checks_do_not_republish_and_detect_file_change(self):
        execution.collect_artifacts(self.prepared,self.action)
        for _ in range(2): execution.verify_unmodified(self.prepared,self.action)
        target=Path(self.prepared['worktree'])/'source.py';target.chmod(0o600);target.write_text('changed\n')
        with self.assertRaises(RegistryError):execution.verify_unmodified(self.prepared,self.action)
        self.assertEqual((self.source/'source.py').read_text(),'answer = 42\n')
        self.assertEqual((self.run/'artifacts'/'changes.patch').stat().st_size,0)

    def test_legacy_omitted_callbacks_keep_native_result_shape(self):
        with patch.object(execution,'_capture',return_value=self.captured()):
            result=execution.run_reviewed_tests(self.prepared,self.action)
        for i,value in enumerate(result): self.assertEqual(value,execution.validate_command_result(value,self.action,i))
        self.assertEqual(len(result),2)


if __name__=='__main__':unittest.main()
