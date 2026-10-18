import json
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from dgc.pip_report_format import finish
from dgc.workspace_registry import RegistryError

class ReportFormatTests(unittest.TestCase):
    def setUp(self):
        temp=tempfile.TemporaryDirectory();self.addCleanup(temp.cleanup)
        self.root=Path(temp.name);(self.root/'app.py').write_text('value = 1\n')
        self.valid=json.dumps({'summary':'Inspected the source.','findings':[],'limitations':['No tests ran.']})
        self.client=SimpleNamespace(chat=Mock(return_value=SimpleNamespace(content=self.valid,tool_calls=[],usage={'input_tokens':20})))
        self.agent=SimpleNamespace(cancelled=threading.Event(),context_size=lambda:32768,_aux_client=Mock(return_value=self.client),_record_usage=Mock())
    def test_valid_report_needs_no_extra_model_request(self):
        self.assertEqual(finish(self.agent,self.valid,self.root,1)['summary'],'Inspected the source.')
        self.agent._aux_client.assert_not_called()
    def test_prose_gets_one_tool_free_bounded_format_attempt(self):
        value=finish(self.agent,'Inspected source; no confirmed issue. Tests were not run.',self.root,1)
        self.assertTrue(value['report_reformatted']);self.assertFalse(value['tests_executed'])
        self.assertEqual(self.client.chat.call_count,1)
        self.assertIsNone(self.client.chat.call_args.kwargs['tools'])
        self.assertEqual(self.client.chat.call_args.kwargs['reasoning_effort'],'off')
        self.assertLessEqual(self.agent._aux_client.call_args.kwargs['max_tokens'],4096)
        self.agent._record_usage.assert_called_once()
    def test_invalid_second_reply_fails_without_retry_loop(self):
        self.client.chat.return_value.content='Still prose'
        with self.assertRaises(RegistryError):finish(self.agent,'Prose',self.root,1)
        self.assertEqual(self.client.chat.call_count,1)
    def test_a_citation_that_does_not_verify_costs_that_finding_never_the_report(self):
        # ERP session review (2026-10-18): one finding's excerpt was off and the whole report was thrown away
        # (unverified_report). The verified findings stay; the other is named in limitations; no model request.
        value=json.dumps({'summary':'Issue','findings':[
            {'title':'Real','severity':'high','path':'app.py','line':1,'evidence':'value = 1'},
            {'title':'Mismatch','severity':'low','path':'app.py','line':1,'evidence':'invented'}],'limitations':['No tests ran.']})
        result=finish(self.agent,value,self.root,1)
        self.assertEqual([f['title'] for f in result['findings']],['Real'])
        self.assertTrue(all(f['verification']=='source_excerpt_only' for f in result['findings']))
        self.assertEqual(result['limitations'][1:],['No tests ran.'])
        self.assertIn("DGC left out 1 finding whose evidence it could not verify",result['limitations'][0])
        self.assertIn("2 'Mismatch' (app.py, line 1): its quoted code isn't at that line",result['limitations'][0])
        self.assertNotIn('invented',result['limitations'][0],'never the rejected excerpt')
        self.client.chat.assert_not_called()
    def test_reformatted_citations_are_still_verified(self):
        self.client.chat.return_value.content=json.dumps({'summary':'Issue','findings':[{'title':'Mismatch','severity':'low','path':'app.py','line':1,'evidence':'invented'}],'limitations':[]})
        result=finish(self.agent,'A prose issue',self.root,1)
        self.assertEqual(result['findings'],[],'an unverified citation is never reported as a finding')
        self.assertIn("1 'Mismatch' (app.py, line 1)",result['limitations'][0])
        self.assertTrue(result['report_reformatted'])
    def test_the_repair_is_told_exactly_what_was_wrong(self):
        # ERP session review (2026-10-18): "Finding 1 has invalid fields: unexpected severity_note" failed the run.
        bad=json.dumps({'summary':'Issue','findings':[{'title':'T','severity':'low','path':'app.py','line':1,
                        'evidence':'value = 1','severity_note':'watch it'}],'limitations':[]})
        self.client.chat.return_value.content=json.dumps({'summary':'Issue','findings':[{'title':'T','severity':'low',
            'path':'app.py','line':1,'evidence':'value = 1'}],'limitations':['Severity note: watch it']})
        result=finish(self.agent,bad,self.root,1)
        self.assertEqual(len(result['findings']),1)
        asked=self.client.chat.call_args.args[0][1]['content']
        self.assertIn('Finding 1 has invalid fields: unexpected severity_note',asked)
        self.assertIn('Move anything a finding cannot hold',asked)
    def test_a_long_report_gets_room_and_time_to_be_rewritten(self):
        # The broken-JSON report ("column 10898") was re-asked within 4,096 output tokens and 30 seconds: too
        # little to copy a report of more than 10 KB, so the copy was cut off and the original error stood.
        draft='{"summary":"'+'x'*20000+'", "findings": [}'
        self.client.chat.return_value.content=self.valid
        finish(self.agent,draft,self.root,1)
        kwargs=self.agent._aux_client.call_args.kwargs
        self.assertGreaterEqual(kwargs['max_tokens'],11000,'room to re-emit the whole draft')
        self.assertGreaterEqual(kwargs['read_timeout'],400,'time for a slow cloud model to write it')
        from dgc.pip_report_format import budget
        self.assertEqual(budget('x'*100,4096),(1024,100),'a short report keeps a small request')
        self.assertLessEqual(budget('x'*32000,8192)[0],(8192-2048)//2+1,'never more than the window allows')
    def test_a_repair_cut_off_at_its_limit_says_so(self):
        self.client.chat.return_value=SimpleNamespace(content='{"summary":"Inspected the',tool_calls=[],usage={},finish_reason='length')
        with self.assertRaises(RegistryError) as caught:finish(self.agent,'{"summary":"x", "findings": [}',self.root,1)
        self.assertEqual(caught.exception.code,'invalid_report')
        self.assertIn('The audit response is not valid JSON',str(caught.exception))
        self.assertIn('repair was cut off at its output limit',str(caught.exception))
        self.assertEqual(self.client.chat.call_count,1,'one repair, never a loop')
    def test_no_calls_after_cancellation_deadline_or_oversize(self):
        for text,deadline,cancel in [('x',0,False),('x'*32001,None,False),('x',None,True)]:
            if cancel:self.agent.cancelled.set()
            with self.assertRaises(RegistryError):finish(self.agent,text,self.root,1,deadline=deadline)
        self.client.chat.assert_not_called()
    def test_a_lone_surrogate_is_refused_as_it_was_never_a_codec_error(self):
        # Adversarial review (2026-10-13): the size guard encoded the reply and raised UnicodeEncodeError inside the
        # handler, so the worker reported a Python codec message instead of the fixed refusal.
        self.client.chat.return_value.content='Still prose'
        with self.assertRaises(RegistryError) as caught:finish(self.agent,'\ud800 not json',self.root,1)
        self.assertEqual(caught.exception.code,'invalid_report')
    def test_tool_call_from_formatter_is_never_executed(self):
        self.client.chat.return_value.tool_calls=[{'name':'bash'}]
        with self.assertRaises(RegistryError):finish(self.agent,'Prose',self.root,1)

    def test_reformatted_report_survives_checkpoint_contract(self):
        from dgc.pip_checkpoints import encode_result, _SOURCE_VERIFICATION
        value=finish(self.agent,'Inspected source; no issues found. No tests ran.',self.root,1)
        self.assertEqual(value['verification'],_SOURCE_VERIFICATION)
        self.assertEqual(json.loads(encode_result(value)),value)
        for bad in (False, 1, 'true'):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                encode_result({**value,'report_reformatted':bad})
