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
    def test_citation_failure_does_not_get_converted_into_empty_success(self):
        value=json.dumps({'summary':'Issue','findings':[{'title':'Mismatch','severity':'low','path':'app.py','line':1,'evidence':'invented'}],'limitations':[]})
        with self.assertRaises(RegistryError) as caught:finish(self.agent,value,self.root,1)
        self.assertEqual(caught.exception.code,'unverified_report');self.client.chat.assert_not_called()
    def test_reformatted_citations_are_still_verified(self):
        self.client.chat.return_value.content=json.dumps({'summary':'Issue','findings':[{'title':'Mismatch','severity':'low','path':'app.py','line':1,'evidence':'invented'}],'limitations':[]})
        with self.assertRaises(RegistryError) as caught:finish(self.agent,'A prose issue',self.root,1)
        self.assertEqual(caught.exception.code,'unverified_report')
    def test_no_calls_after_cancellation_deadline_or_oversize(self):
        for text,deadline,cancel in [('x',0,False),('x'*32001,None,False),('x',None,True)]:
            if cancel:self.agent.cancelled.set()
            with self.assertRaises(RegistryError):finish(self.agent,text,self.root,1,deadline=deadline)
        self.client.chat.assert_not_called()
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
