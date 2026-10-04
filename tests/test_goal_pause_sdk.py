"""Offline SDK goal pause semantics. No model, network or sleeps."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'sdk/python'))
from dgc_sdk.session import _Accumulator, _TERMINAL
from dgc_sdk.types import RunResult
from dgc.editor_protocol import event_error

class GoalPauseSdkTests(unittest.TestCase):
    def test_pause_is_terminal_without_becoming_failure_or_completion(self):
        event = {'seq':1,'type':'turn_end','turn_id':'t1','reason':'paused','token_estimate':100,'final_message_id':None}
        self.assertIsNone(event_error(event))
        result = RunResult(session_id='session',run_id='run',status='running')
        acc = _Accumulator(result)
        acc.end_turn(event)
        self.assertEqual(acc.status,'paused')
        self.assertEqual(acc.reason,'paused')
        self.assertIsNone(acc.error)
        self.assertIn('paused',_TERMINAL)
