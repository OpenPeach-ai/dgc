"""A refused resumed prompt must not export a previous reply as its own result."""
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from dgc.cli import _run_oneshot

class OneShotPreflightTests(unittest.TestCase):
    def test_failed_preflight_outputs_error_and_no_stale_answer(self):
        with tempfile.TemporaryDirectory() as tmp:
            output=Path(tmp)/'result.txt'
            agent=SimpleNamespace(messages=[{'role':'assistant','content':'Old successful reply'}],mode='default',
                run_turn=Mock(return_value=False),session_file=None,cancelled=threading.Event(),
                estimate_tokens=lambda:10,usage_totals={})
            ui=Mock();cli=SimpleNamespace(agent=agent,ui=ui,expand_mentions=lambda x:x)
            config=SimpleNamespace(data={'mode':'default'})
            args=SimpleNamespace(output_format='json',prompt='$disabled Task',cont=True,resume=None,
                model=None,think=None,output=str(output),print_session_id=False)
            with patch('dgc.cli._end_one_shot_children'):
                self.assertEqual(_run_oneshot(cli,config,args,Mock(),''),1)
            self.assertEqual(output.read_text(),'')
            event=[call for call in ui.em.emit.call_args_list if call.args[0]=='result'][0]
            self.assertFalse(event.kwargs['ok']);self.assertEqual(event.kwargs['text'],'')
            end=[call for call in ui.em.emit.call_args_list if call.args[0]=='turn_end'][0]
            self.assertEqual(end.kwargs['reason'],'error')
