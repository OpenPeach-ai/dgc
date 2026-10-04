"""Live goal replacement boundaries. Deterministic local fixtures, no sleeps/network."""
import copy
import threading
import unittest
from unittest.mock import patch
from tests import test_goals as goal_fixtures
from tests import test_session_restore as session_fixtures
from dgc import goals

class LiveGoalReplacementTests(unittest.TestCase):
    setUp = goal_fixtures.GoalTests.setUp

    def running(self):
        self.assertTrue(self.agent.set_goal('Original',token_budget=1000))
        self.agent._goal_running=True
        self.agent._goal_owner=threading.get_ident()
        self.agent._accepting_steer=True
        self.agent._goal_cycle_token_start=0
        self.addCleanup(setattr,self.agent,'_goal_running',False)
        return self.agent.goal_snapshot()['id']

    def queue(self,goal_id,**kw):
        return self.agent.queue_goal_replacement('New objective',expected_goal_id=goal_id,
            request_id='replacement-one',**kw)

    def test_queue_changes_nothing_until_boundary_then_persists_goal_and_history(self):
        old=self.running();self.agent.usage_totals['input_tokens']=900
        self.assertTrue(self.queue(old,token_budget=1500))
        self.assertEqual(self.agent.goal,'Original')
        self.assertFalse(self.queue(old)) # a second click never displaces an accepted draft
        self.assertTrue(self.agent._drain_steer(close_if_empty=True))
        self.assertTrue(self.agent._accepting_steer)
        self.assertEqual(self.agent.goal,'New objective');self.assertNotEqual(self.agent.goal_snapshot()['id'],old)
        self.assertEqual(self.agent._goal_cycle_token_start,900)
        self.assertEqual(self.agent._goal_details['tokens_used'],0)
        self.assertEqual(self.agent.messages[-1]['_dgc_steering'],['New objective'])
        self.assertFalse(self.agent.cancelled.is_set())
        self.assertFalse(self.queue(old)) # stale review
        self.assertIsNone(self.agent.take_goal_replacement())

    def test_cancel_and_finalization_return_draft_without_applying(self):
        old=self.running();self.assertTrue(self.queue(old));self.agent.cancelled.set()
        self.assertFalse(self.agent._drain_steer());self.assertEqual(self.agent.goal,'Original')
        self.assertEqual(self.agent.take_goal_replacement()['request_id'],'replacement-one')
        self.agent.cancelled.clear();self.agent._accepting_steer=False
        self.assertFalse(self.queue(old))

    def test_failed_save_retains_old_goal_and_no_replacement_history(self):
        old=self.running();before=copy.deepcopy(self.agent.messages)
        self.assertTrue(self.queue(old))
        with patch.object(self.agent,'_persist',return_value=False):
            self.assertFalse(self.agent._drain_steer())
        self.assertEqual(self.agent.goal,'Original');self.assertEqual(self.agent.goal_snapshot()['id'],old)
        self.assertEqual(self.agent.messages,before)
        events=[e for e in self.ui.events if e[0]=='goal_replacement_result']
        self.assertEqual(events[-1][1][2],False)

    def test_missing_attachment_or_changed_identity_refuses_without_committing(self):
        old=self.running();self.assertTrue(self.queue(old,inputs={'skills':['does-not-exist']}))
        self.assertFalse(self.agent._drain_steer());self.assertEqual(self.agent.goal,'Original')
        self.assertTrue(self.queue(old));self.agent._goal_details['id']='f'*32
        self.assertFalse(self.agent._drain_steer());self.assertEqual(self.agent.goal,'Original')

    def test_reset_discards_queued_authority_from_old_session(self):
        old=self.running();self.assertTrue(self.queue(old))
        self.agent._goal_running=False
        self.agent.reset()
        self.assertIsNone(self.agent.take_goal_replacement())
        self.assertEqual(self.agent.goal,'')

    def test_cycle_finish_charges_only_requests_after_replacement(self):
        self.assertTrue(self.agent.set_goal('Original'))
        old=self.agent.goal_snapshot()['id']
        def step(_):
            self.agent.usage_totals['input_tokens']+=700
            self.assertTrue(self.queue(old,token_budget=100))
            self.assertTrue(self.agent._drain_steer())
            self.agent.usage_totals['input_tokens']+=25
            self.agent._pending_goal_report={'status':'completed','summary':'done','evidence':[]}
            return True
        with patch.object(self.agent,'_persist',return_value=True):
            self.assertTrue(self.agent._run_goal_steps('work',step))
        self.assertEqual(self.agent.goal,'New objective')
        self.assertEqual(self.agent.goal_snapshot()['tokens_used'],25)
        self.assertEqual(self.agent.goal_status,'completed')

    def test_real_native_loop_applies_replacement_after_old_response_and_finishes_new_goal(self):
        from dgc.llm import ChatResult, ToolCall
        self.assertTrue(self.agent.set_goal('Original',token_budget=100))
        old=self.agent.goal_snapshot()['id'];calls=[]
        def chat(messages,**kwargs):
            calls.append(copy.deepcopy(messages))
            if len(calls)==1:
                self.assertTrue(self.queue(old,token_budget=200))
                self.assertEqual(self.agent.goal,'Original')
                return ChatResult(content='Prior work',usage={'input_tokens':120,'output_tokens':10})
            self.assertIn('New objective',str(messages))
            if len(calls)==2:
                return ChatResult(content='',tool_calls=[ToolCall('done','update_goal',{'status':'completed','summary':'New work verified','evidence':['Fixture finished']})],usage={'input_tokens':20,'output_tokens':5})
            return ChatResult(content='New work complete',usage={'input_tokens':20,'output_tokens':5})
        with patch.object(self.agent.client,'chat',side_effect=chat):
            self.assertTrue(self.agent.run_turn('Original'))
        self.assertEqual(self.agent.goal,'New objective');self.assertEqual(self.agent.goal_status,'completed')
        self.assertEqual(self.agent.goal_snapshot()['tokens_used'],50)
        self.assertEqual(len(calls),3)

    def test_live_edit_preserves_identity_inputs_usage_and_cycle_baseline(self):
        old = self.running()
        self.agent._goal_details["tokens_used"] = 300
        self.agent._goal_details["cycles"] = 2
        self.agent.usage_totals["input_tokens"] = 900
        self.agent._goal_cycle_token_start = 700
        self.assertTrue(self.queue(old, replace=False, token_budget=2000))
        self.assertTrue(self.agent._drain_steer())
        snapshot = self.agent.goal_snapshot()
        self.assertEqual(snapshot["id"], old)
        self.assertEqual(snapshot["tokens_used"], 300)  # live delta remains on the unchanged cycle baseline
        self.assertEqual(snapshot["cycles"], 2)
        self.assertEqual(snapshot["token_budget"], 2000)
        self.assertEqual(self.agent._goal_cycle_token_start, 700)
        self.assertIn("user edited the standing goal", self.agent.messages[-1]["content"])
        self.assertEqual(self.ui.events[-1][0], "goal_edit_result")

    def test_live_edit_charges_all_usage_and_honours_lowered_budget(self):
        self.assertTrue(self.agent.set_goal("Original", token_budget=1000))
        old = self.agent.goal_snapshot()["id"]
        def step(_):
            self.agent.usage_totals["input_tokens"] += 700
            self.assertTrue(self.queue(old, replace=False, token_budget=600))
            self.assertTrue(self.agent._drain_steer())
            self.assertTrue(self.agent.goal_budget_exhausted())
            return True
        self.assertTrue(self.agent._run_goal_steps("work", step))
        self.assertEqual(self.agent.goal_snapshot()["id"], old)
        self.assertEqual(self.agent.goal_snapshot()["tokens_used"], 700)
        self.assertEqual(self.agent.goal_status, "paused")

    def test_live_edit_save_failure_preserves_existing_goal_and_accounting(self):
        old = self.running()
        self.agent._goal_details["tokens_used"] = 300
        before = copy.deepcopy(self.agent.messages)
        self.assertTrue(self.queue(old, replace=False, token_budget=5000))
        with patch.object(self.agent, "_persist", return_value=False):
            self.assertFalse(self.agent._drain_steer())
        self.assertEqual(self.agent.goal, "Original")
        self.assertEqual(self.agent.goal_snapshot()["id"], old)
        self.assertEqual(self.agent.goal_snapshot()["token_budget"], 1000)
        self.assertEqual(self.agent._goal_details["tokens_used"], 300)
        self.assertEqual(self.agent.messages, before)
        self.assertEqual(self.ui.events[-1][0], "goal_edit_result")
        self.assertFalse(self.ui.events[-1][1][2])

class LiveFirstGoalTests(unittest.TestCase):
    setUp = goal_fixtures.GoalTests.setUp

    def queue(self, **kw):
        return self.agent.queue_goal_replacement("New standing objective", expected_goal_id="",
            request_id="first-goal", token_budget=200, **kw)

    def test_real_native_turn_adopts_first_goal_and_charges_only_post_adoption_usage(self):
        from dgc.llm import ChatResult, ToolCall
        calls = []
        def chat(messages, **kwargs):
            calls.append(copy.deepcopy(messages))
            offered = {t["function"]["name"] for t in kwargs.get("tools", [])}
            if len(calls) == 1:
                self.assertNotIn("update_goal", offered)
                self.assertFalse(self.agent._goal_running)
                self.assertTrue(self.queue())
                self.assertEqual(self.agent.goal, "")
                return ChatResult(content="Earlier ordinary work", usage={"input_tokens":100,"output_tokens":10})
            self.assertTrue(self.agent._goal_running)
            self.assertIn("update_goal", offered)
            self.assertIn("New standing objective", str(messages))
            if len(calls) == 2:
                return ChatResult(content="", tool_calls=[ToolCall("done", "update_goal", {
                    "status":"completed", "summary":"New objective complete", "evidence":["Fixture verified"]})],
                    usage={"input_tokens":20,"output_tokens":5})
            return ChatResult(content="New work complete", usage={"input_tokens":20,"output_tokens":5})
        with patch.object(self.agent.client, "chat", side_effect=chat):
            self.assertTrue(self.agent.run_turn("Ordinary request"))
        self.assertEqual(self.agent.goal_status, "completed")
        self.assertEqual(self.agent.goal_snapshot()["tokens_used"], 50)
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 1)
        self.assertEqual(len(calls), 3)
        self.assertFalse(self.agent._goal_accepts_start)
        self.assertFalse(self.agent._goal_running)
        self.assertFalse(self.queue())

    def test_adopted_goal_continues_into_another_cycle_with_existing_limits(self):
        prompts=[]
        def step(prompt):
            prompts.append(prompt)
            if len(prompts)==1:
                self.assertTrue(self.queue())
                self.assertTrue(self.agent._drain_steer())
                self.agent.usage_totals["output_tokens"] += 5
            else:
                self.agent.usage_totals["output_tokens"] += 7
                self.agent._pending_goal_report={"status":"completed","summary":"Done","evidence":["Fixture"]}
            return True
        self.agent._accepting_steer=True
        self.assertTrue(self.agent._run_goal_steps("Ordinary request", step))
        self.assertEqual(len(prompts), 2)
        self.assertIn("New standing objective", prompts[1])
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 2)
        self.assertEqual(self.agent.goal_snapshot()["tokens_used"], 12)

    def test_ordinary_turn_does_not_resume_or_charge_a_paused_goal(self):
        self.assertTrue(self.agent.set_goal("Paused work", status="paused", token_budget=1))
        before=copy.deepcopy(self.agent.goal_snapshot())
        before_events=len(self.ui.events)
        def step(prompt):
            self.agent.usage_totals["input_tokens"] += 500
            return "ordinary result"
        self.assertEqual(self.agent._run_goal_steps("Ordinary",step), "ordinary result")
        self.assertEqual(self.agent.goal_snapshot(), before)
        self.assertFalse(any(e[0]=="goal_changed" for e in self.ui.events[before_events:]))
        self.assertFalse(self.agent._goal_accepts_start)

    def test_failed_adoption_save_does_not_leave_a_ghost_goal_or_live_owner(self):
        def step(prompt):
            self.assertTrue(self.queue())
            with patch.object(self.agent, "_persist", return_value=False):
                self.assertFalse(self.agent._drain_steer())
            self.assertFalse(self.agent._goal_running)
            return True
        self.assertTrue(self.agent._run_goal_steps("Ordinary",step))
        self.assertFalse(self.agent.goal)
        self.assertEqual(self.agent.goal_status, "none")
        self.assertFalse(any(m.get("_dgc_steering") for m in self.agent.messages))
        self.assertFalse(self.agent._goal_accepts_start)
        self.assertIsNone(self.agent._goal_owner)

    def test_cancelled_adoption_is_returnable_and_never_creates_a_goal(self):
        def step(prompt):
            self.assertTrue(self.queue())
            self.agent.cancelled.set()
            self.assertFalse(self.agent._drain_steer())
            return False
        self.assertFalse(self.agent._run_goal_steps("Ordinary",step))
        self.assertFalse(self.agent.goal)
        self.assertEqual(self.agent.take_goal_replacement()["request_id"],"first-goal")
        self.assertFalse(self.agent._goal_accepts_start)

    def test_stale_identity_and_edit_without_goal_are_refused(self):
        def step(prompt):
            self.assertFalse(self.agent.queue_goal_replacement("New", expected_goal_id="stale",request_id="stale"))
            self.assertFalse(self.queue(replace=False))
            return True
        self.assertTrue(self.agent._run_goal_steps("Ordinary",step))
        self.assertFalse(self.agent.goal)

    def test_monitor_child_and_delegated_turns_cannot_adopt_a_goal(self):
        for route in ("monitor","child","external"):
            with self.subTest(route=route):
                self.agent._monitor_turn=route=="monitor"
                self.agent.depth=1 if route=="child" else 0
                self.agent._accepting_steer=True
                def step(prompt):
                    self.assertFalse(self.queue())
                    return True
                self.assertTrue(self.agent._run_goal_steps("Ordinary",step,external=route=="external"))
                self.assertFalse(self.agent.goal)
        self.agent.depth=0;self.agent._monitor_turn=False

    def test_exception_releases_adoption_window_without_publishing_a_goal(self):
        def step(prompt):
            self.assertTrue(self.agent._goal_accepts_start)
            raise ValueError("fixture failure")
        with self.assertRaisesRegex(ValueError,"fixture failure"):
            self.agent._run_goal_steps("Ordinary",step)
        self.assertFalse(self.agent._goal_accepts_start)
        self.assertFalse(self.agent._goal_running)
        self.assertIsNone(self.agent._goal_owner)
        self.assertFalse(self.agent.goal)

class LiveGoalBackendTests(unittest.TestCase):
    setUp=session_fixtures.SessionRestoreTests.setUp
    def test_busy_start_goal_uses_boundary_queue_and_never_starts_another_turn(self):
        self.assertTrue(self.agent.set_goal('Original'))
        self.agent._goal_running=True;self.agent._goal_owner=threading.get_ident();self.agent._accepting_steer=True
        self.addCleanup(setattr,self.agent,'_goal_running',False)
        self.backend._busy=lambda:True
        self.backend._start_turn=lambda *a,**k:self.fail('No second foreground turn')
        self.backend.dispatch({'type':'start_goal','text':'Replacement','request_id':'reviewed',
            'expected_goal_id':self.agent.goal_snapshot()['id']})
        self.assertEqual(self.events[-1],{'type':'prompt_accepted','request_id':'reviewed','state':'steered'})
        self.assertEqual(self.agent.goal,'Original')
        self.assertTrue(self.agent._drain_steer());self.assertEqual(self.agent.goal,'Replacement')
    def test_busy_first_goal_adopts_existing_ordinary_turn_without_starting_another(self):
        self.backend._busy = lambda: True
        self.backend._start_turn = lambda *a, **k: self.fail("No second foreground turn")
        def step(prompt):
            self.backend.dispatch({"type":"start_goal", "text":"First standing goal", "request_id":"first",
                                   "expected_goal_id":"", "token_budget":500})
            self.assertEqual(self.events[-1], {"type":"prompt_accepted", "request_id":"first", "state":"steered"})
            self.assertFalse(self.agent.goal)
            self.assertTrue(self.agent._drain_steer())
            self.agent._pending_goal_report={"status":"completed", "summary":"Done", "evidence":["Fixture"]}
            return True
        self.assertTrue(self.agent._run_goal_steps("Ordinary request", step))
        self.assertEqual(self.agent.goal, "First standing goal")
        self.assertEqual(self.agent.goal_status, "completed")
        self.assertEqual(self.agent.goal_snapshot()["cycles"], 1)

    def test_cancelled_queued_replacement_is_not_replayed_as_an_ordinary_prompt(self):
        self.assertTrue(self.agent.set_goal('Original'));self.agent._goal_running=True;self.agent._accepting_steer=True
        self.addCleanup(setattr,self.agent,'_goal_running',False)
        self.assertTrue(self.agent.queue_goal_replacement('Replacement',request_id='cancelled',expected_goal_id=self.agent.goal_snapshot()['id']))
        self.backend._queue=[];self.backend._steer_payloads={}
        self.backend._finish_steering(True,False)
        self.assertEqual(self.backend._queue,[])
        self.assertEqual(self.agent.goal,'Original')
        self.assertEqual(self.events[-1]['state'],'returned')

    def edit_backend(self):
        from dgc.headless import HeadlessUI
        self.backend.ui = object.__new__(HeadlessUI)
        self.backend.ui.em = self.backend.em
        self.backend.ui._goal_hook = lambda request_id: self.events.append({
            "type": "goal_changed", "request_id": request_id, "goal": self.agent.goal})
        self.agent.ui.goal_edit_result = self.backend.ui.goal_edit_result
        self.assertTrue(self.agent.set_goal("Original"))
        self.agent._goal_running = True
        self.agent._goal_owner = threading.get_ident()
        self.agent._accepting_steer = True
        self.addCleanup(setattr, self.agent, "_goal_running", False)
        self.backend._busy = lambda: True
        self.backend._queue = []
        self.backend._steer_payloads = {}
        self.backend._start_turn = lambda *a, **k: self.fail("No second turn")
        return {"type": "set_goal", "text": "Edited", "request_id": "edit",
                "expected_goal_id": self.agent.goal_snapshot()["id"], "token_budget": 5000}

    def test_busy_edit_is_acknowledged_only_after_commit(self):
        cmd = self.edit_backend()
        self.backend.dispatch(cmd)
        self.assertEqual(self.events, [])
        self.assertEqual(self.agent.goal, "Original")
        self.assertTrue(self.agent._drain_steer())
        self.assertEqual(self.events[-1], {"type": "goal_changed", "request_id": "edit", "goal": "Edited"})
        self.assertEqual(self.agent.goal_snapshot()["id"], cmd["expected_goal_id"])
        restored = self.backend._history()
        self.assertFalse(any(item.get("role") == "steering" for item in restored))
        notice = {"type": "info", "message": "Goal updated. Continuing with the revised objective."}
        self.assertIn({"role": "goal_edit", "text": notice["message"]}, restored)
        self.assertIn(notice, self.events)

    def test_cancelled_edit_returns_correlated_refusal_and_never_replays(self):
        cmd = self.edit_backend()
        self.backend.dispatch(cmd)
        self.backend._finish_steering(True, False)
        self.assertEqual(self.agent.goal, "Original")
        self.assertEqual(self.backend._queue, [])
        self.assertEqual(self.events[-1]["type"], "command_rejected")
        self.assertEqual(self.events[-1]["request_id"], "edit")

    def test_busy_state_change_and_stale_edit_refused_without_mutation(self):
        cmd = self.edit_backend()
        for change in ({"status": "none"}, {"status": "paused"}, {"replace": True},
                       {"expected_goal_id": "stale"}):
            self.backend.dispatch({**cmd, **change})
            self.assertEqual(self.events[-1]["type"], "command_rejected")
            self.assertEqual(self.agent.goal, "Original")
            self.assertIsNone(self.agent.take_goal_replacement())

class LiveGoalEditHistoryTests(unittest.TestCase):
    def test_mid_turn_reload_retains_one_compact_edit_notice(self):
        import io
        from dgc.history_stream import HistoryEmitter
        em = HistoryEmitter(io.StringIO())
        em.emit("turn_start", turn_id="active", prompt="Original")
        em.remember_goal_edit()
        em.emit("info", message="Goal updated. Continuing with the revised objective.")
        items, complete = em.include_live([], {"id": "active"})
        self.assertTrue(complete)
        self.assertEqual([i for i in items if i.get("role")], [
            {"role": "goal_edit", "text": "Goal updated. Continuing with the revised objective."}])

if __name__=='__main__':unittest.main()

