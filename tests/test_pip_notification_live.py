"""Controller approval receipts must not impersonate or block human steering."""
import json
import threading
import unittest
from unittest.mock import patch
from dgc.llm import ChatResult
from dgc.pip_setup_notification import PREFIX
from dgc.agent import _real_user_turns, summariser_role
from tests import test_live_controls as fixtures

class PipNotificationLiveTests(unittest.TestCase):
    setUp=fixtures.LiveControlTests.setUp
    wait=fixtures.LiveControlTests.wait

    def receipt(self):
        return {'setup_id':'setup_'+'a'*32,'pip_id':'pip_'+'b'*32,'name':'Daily review','pip_type':'rook','run_id':None}

    def text(self):
        return PREFIX+json.dumps(self.receipt())+'\nController receipt. Continue the existing task.'

    def test_midturn_receipt_and_human_followup_share_turn_without_user_receipt_bubble(self):
        entered=threading.Event(); requests=[]
        def chat(messages,**kwargs):
            requests.append(list(messages))
            if len(requests)==1:
                entered.set();self.assertTrue(self.release.wait(5))
            return ChatResult(content='Completed')
        with patch.object(self.agent.client,'chat',side_effect=chat):
            self.backend.dispatch({'type':'prompt','text':'Build the project','request_id':'first'})
            self.assertTrue(entered.wait(5))
            self.agent._ask_user('question',{'question':'Which deployment host?'},set())
            questions=dict(self.agent._open_asks())
            state,count=self.backend._start_turn(self.text(),delivery='steer',kind='pip_setup')
            self.assertEqual((state,count),('steered',0))
            self.backend.dispatch({'type':'prompt','text':'Use a compact layout','request_id':'person','delivery':'steer'})
            self.wait('prompt_accepted',request_id='person',state='steered')
            self.release.set();self.wait('turn_end',reason='completed')
        self.assertEqual(len([e for e in self.events if e['type']=='turn_start']),1)
        self.assertEqual(self.agent._open_asks(),questions)
        receipts=[m for m in self.agent.messages if m.get('_dgc_pip_setup')]
        self.assertEqual([m['_dgc_pip_setup'] for m in receipts],[self.receipt()])
        self.assertNotIn(receipts[0],_real_user_turns(self.agent.messages))
        self.assertEqual(summariser_role(receipts[0]),'dgc-generated (not the user)')
        self.assertFalse(any(e['type']=='queued' and e.get('count',0)>0 for e in self.events))
        self.assertEqual([e['request_id'] for e in self.events if e['type']=='prompt_accepted'],['first','person'])
        self.assertFalse(self.backend._steer_payloads)
        self.assertTrue(receipts[0]["_dgc_pip_setup_inline"])
        history=self.backend._history()
        self.assertEqual(len([e for e in history if e.get("type")=="turn_start"]),1)
        self.assertFalse(any(e.get("prompt", "").startswith(PREFIX) for e in history))

    def test_closed_steering_queues_receipt_behind_people_without_counting_it(self):
        self.backend._worker=object()
        try:
            state,count=self.backend._start_turn(self.text(),delivery='steer',kind='pip_setup')
            self.assertEqual((state,count),('queued',0))
            state,count=self.backend._start_turn('Real human input',delivery='queue',request_id='human')
            self.assertEqual((state,count),('queued',1))
            self.assertEqual([item[3] for item in self.backend._queue],['prompt','pip_setup'])
        finally:
            self.backend._worker=None;self.backend._queue.clear()

    def test_unconsumed_receipt_retains_controller_kind(self):
        self.backend._steer_payloads={'receipt':(self.text(),None,None,None,self.receipt())}
        self.backend._finish_steering(False,False)
        self.assertEqual(self.backend._queue[0][3],'pip_setup')
        self.assertEqual(self.backend._queued_prompt_count(),0)
        self.assertFalse(any(e['type']=='steering_update' for e in self.events))

    def test_deferred_receipts_stay_behind_already_queued_user_input(self):
        self.backend._queue=[('User next turn',None,None,'prompt','human')]
        self.backend._steer_payloads={'receipt':(self.text(),None,None,None,self.receipt())}
        self.backend._finish_steering(False,False)
        self.assertEqual([x[3] for x in self.backend._queue],['prompt','pip_setup'])
        self.assertEqual(self.backend._queued_prompt_count(),1)
