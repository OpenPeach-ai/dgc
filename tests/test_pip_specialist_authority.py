"""Independent hostile checks of reviewed specialist authority; no live providers."""
import copy
import json
import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_execution,pip_specialists as specialists,pips
from dgc.llm import ChatResult,LLMClient,ToolCall
from dgc.workspace_registry import RegistryError
from tests import test_pip_handoff_execution as fixtures

GRANT={'roles':['explorer','critic','worker'],'max_calls':3}
SETTINGS={'base_url':'http://fixture.invalid/v1','model':'fixture','api_mode':'chat_completions'}


class SpecialistBudgetAuthorityTests(unittest.TestCase):
    def budget(self):
        self.clock=[10.0];self.cancel=threading.Event()
        return specialists.SharedBudget(GRANT,SETTINGS,self.cancel,clock=lambda:self.clock[0])

    def client(self,attempts=1):
        client=SimpleNamespace(**SETTINGS,max_tokens=4096,requested_api_mode='chat_completions')
        client._begin_attempt=lambda *a,**k:None
        client.compact_responses=lambda *a,**k: (_ for _ in ()).throw(AssertionError('No unbudgeted native compaction'))
        def chat(*args,**kwargs):
            for _ in range(attempts):client._begin_attempt(None,'fixture')
            return 'reply'
        client.chat=chat
        return client

    def test_retry_attempts_reserve_again_with_no_request_ceiling(self):
        budget=self.budget();client=budget.wrap(self.client(attempts=3))
        for _ in range(5):self.assertEqual(client.chat([]),'reply')
        self.assertEqual((budget.requests,budget.model_calls,budget.transport_attempts),(15,5,15))
        self.assertEqual(budget.output_token_reservations,15*4096)
        self.assertFalse(self.cancel.is_set())

    def test_parent_and_auxiliary_child_clients_share_one_request_budget(self):
        budget=self.budget();record=budget.begin('worker','fixture')
        parent=budget.wrap(self.client());child=budget.wrap(self.client(),record);aux=budget.wrap(self.client(),record)
        for _ in range(5):parent.chat([]);child.chat([]);aux.chat([])
        self.assertEqual(budget.requests,15);self.assertEqual(record['requests'],10)
        self.assertIsNone(aux.compact_responses([]))
        self.cancel.set()                                         # Stop on the run is what ends them all
        with self.assertRaises(RegistryError):aux.chat([])

    def test_route_model_api_mode_and_output_cap_changes_refuse_before_call(self):
        for field,value in (('base_url','https://other.invalid/v1'),('model','other'),
                            ('requested_api_mode','responses'),('max_tokens',specialists.OUTPUT_CEILING+1),('max_tokens',True)):
            budget=self.budget();client=self.client();setattr(client,field,value)
            client=budget.wrap(client)
            with self.subTest(field=field),self.assertRaises(RegistryError):client.chat([])
            self.assertEqual((budget.requests,budget.transport_attempts),(0,0))

    def test_cancel_and_a_passed_deadline_refuse_before_attempt_but_time_alone_does_not(self):
        budget=self.budget();client=budget.wrap(self.client())
        self.clock[0]=10.0+3600                                   # an hour in: version 1 stopped at 300 s
        self.assertEqual(client.chat([]),'reply')
        self.cancel.set()
        with self.assertRaises(RegistryError):client.chat([])
        self.assertEqual(budget.transport_attempts,1)
        self.cancel=threading.Event()
        timed=specialists.SharedBudget(GRANT,SETTINGS,self.cancel,deadline=20.0,clock=lambda:self.clock[0])
        with self.assertRaises(RegistryError):timed.wrap(self.client()).chat([])
        self.assertEqual(timed.transport_attempts,0)

    def test_tool_calls_are_counted_across_children_past_the_old_sixty_four(self):
        budget=self.budget();parent=pips._WorkerUI(lambda event:None)
        parent.agent=SimpleNamespace(cancelled=self.cancel)
        first=specialists.SpecialistUI(parent,budget.begin('explorer','fixture'),budget)
        second=specialists.SpecialistUI(parent,budget.begin('worker','fixture'),budget)
        for _ in range(50):first.tool_call('read_file',{'path':'source.py'})
        for _ in range(50):second.tool_call('read_file',{'path':'source.py'})
        self.assertEqual(parent.calls,100);self.assertFalse(self.cancel.is_set())
        self.assertEqual([c['tool_calls'] for c in budget.calls],[50,50])
        for call in budget.calls:call['status']='completed'
        receipt=budget.result(specialists.pin({'kind':'patch','specialists':GRANT}),100)
        self.assertEqual(specialists.validate_result(receipt,GRANT)['tool_calls'],100)
        self.cancel.set()
        with self.assertRaises(RegistryError):first.tool_call('read_file',{'path':'source.py'})

    def test_nested_bridge_refuses_before_constructing_another_agent(self):
        budget=self.budget()
        with self.assertRaises(RegistryError):
            specialists.run(SimpleNamespace(depth=1),'worker','Nested','Inspect',budget=budget,
                make_child=lambda *args: (_ for _ in ()).throw(AssertionError('No child construction')))
        self.assertEqual(budget.calls,[])

    def test_huge_unknown_custom_background_and_route_fields_refuse(self):
        valid={'agent':'worker','description':'Bounded edit','prompt':'Inspect source'}
        bad=[{**valid,'background':False},{**valid,'agent':'researcher'},{**valid,'agent':'../../worker'},
             {**valid,'model':'other'},{**valid,'base_url':'https://other.invalid'},
             {**valid,'prompt':'x'*4001},{**valid,'prompt':'\ud800'}]
        for value in bad:
            with self.subTest(value=repr(value)[:80]),self.assertRaises(RegistryError):specialists.validate_call(value,GRANT)

    def test_grants_are_patch_only_and_absence_preserves_original_action(self):
        old={'kind':'patch','write_paths':['source.py'],'tests':[]}
        original=pip_execution.validate_action('patch',old)
        self.assertNotIn('specialists',original)
        self.assertIsNone(specialists.pin(original))
        for role,action in [('pulse',{'kind':'test','tests':[{'argv':['true'],'cwd':'.'}],'specialists':GRANT}),
                            ('rook',{'kind':'read_only','specialists':GRANT})]:
            with self.assertRaises(RegistryError):pip_execution.validate_action(role,action)
        for bad in ({'roles':['worker'],'max_calls':True},{'roles':['worker','worker'],'max_calls':1},
                    {'roles':['worker'],'max_calls':4},{'roles':['worker'],'max_calls':1,'network':True}):
            with self.assertRaises(RegistryError):pip_execution.validate_action('patch',{**old,'specialists':bad})

    def test_empty_output_fragments_do_not_allocate_unbounded_fragment_list(self):
        budget=self.budget();record=budget.begin('worker','fixture')
        ui=specialists.SpecialistUI(SimpleNamespace(),record,budget)
        for _ in range(10000):ui.on_text('')
        self.assertEqual(ui.parts,[])
        ui.on_text('x'*32768)
        ui.on_text('x')                                           # kept no longer, and nothing fails
        self.assertEqual(len(ui.parts),1);self.assertFalse(self.cancel.is_set())

    def test_receipt_reservations_cannot_claim_fewer_tokens_than_requests(self):
        budget=self.budget();client=budget.wrap(self.client());client.chat([])
        receipt=budget.result(specialists.pin({'kind':'patch','specialists':GRANT}),0)
        receipt.update(requests=2,output_token_reservations=1)
        with self.assertRaises(RegistryError):specialists.validate_result(receipt,GRANT)

    def test_result_pin_and_model_cannot_change_independently(self):
        budget=self.budget();record=budget.begin('worker','fixture');record['status']='completed'
        policy=specialists.pin({'kind':'patch','specialists':GRANT})
        result={'tools_called':0,'specialists':budget.result(policy,0)}
        manifest={'run_kind':'patch','model':'fixture','specialists':policy,
                  'handoff':{'payload':{'action':{'kind':'patch','specialists':GRANT}}},
                  'limits':{'iterations':0,'tool_calls':0,'wall_seconds':0}}
        specialists.validate_result_for_manifest(result,manifest)
        bad=copy.deepcopy(result);bad['specialists']['calls'][0]['model']='other'
        with self.assertRaises(RegistryError):specialists.validate_result_for_manifest(bad,manifest)
        for key in ('specialists','handoff'):
            bad_manifest=copy.deepcopy(manifest);bad_manifest.pop(key)
            with self.assertRaises(RegistryError):specialists.validate_result_for_manifest(result,bad_manifest)


class SpecialistDispatchAuthorityTests(unittest.TestCase):
    setUp=fixtures.HandoffExecutionTests.setUp
    git=fixtures.HandoffExecutionTests.git
    commit=fixtures.HandoffExecutionTests.commit
    setup_source=fixtures.HandoffExecutionTests.setup_source
    propose=fixtures.HandoffExecutionTests.propose
    accept=fixtures.HandoffExecutionTests.accept
    raw_manifest=fixtures.HandoffExecutionTests.raw_manifest
    prepare=fixtures.HandoffExecutionTests.prepare

    def test_actual_native_children_deny_extra_paths_shell_nested_and_readonly_writes(self):
        self.prepare('patch',{'kind':'patch','write_paths':['source.py'],'tests':[],'specialists':GRANT})
        self.worker_cfg.permissions['allow']=['Task']
        self.worker_cfg.data.update(self.manifest['model_settings'])
        self.worker_cfg.data.update(max_subagent_depth=1,tool_profile='standard')
        before=(self.root/'source.py').read_text();events=[];calls={};order=[]
        def chat(client,messages,tools=None,**kwargs):
            system=messages[0]['content']
            role=next((r for r,marker in [('explorer','You are a read-only explorer.'),
                                        ('critic','You are a critic.'),('worker','You are a worker.')]
                       if marker in system),'parent')
            calls[role]=calls.get(role,0)+1;order.append(role)
            names={t['function']['name'] for t in tools}
            self.assertFalse(names&{'bash','python','fetch_url','pips_propose','mcp_call'})
            if role!='parent':self.assertNotIn('task',names)
            if role in ('explorer','critic'):self.assertFalse(names&pip_execution.WRITE_TOOLS)
            if calls[role]>1:
                return ChatResult(content=role+' finished source assessment; tests did not run.')
            if role=='parent':
                return ChatResult(tool_calls=[ToolCall(r,'task',{'agent':r,'description':'Scoped '+r,'prompt':'Perform the reviewed task.'}) for r in ('explorer','worker','critic')])
            if role=='worker':
                return ChatResult(tool_calls=[
                    ToolCall('bad-relative','write_file',{'path':'other.py','content':'unauthorized'}),
                    ToolCall('bad-absolute','write_file',{'path':str(self.root/'source.py'),'content':'unauthorized'}),
                    ToolCall('nested','task',{'agent':'worker','description':'nest','prompt':'Broaden scope'}),
                    ToolCall('shell','bash',{'command':'touch nope'}),
                    ToolCall('approved','write_file',{'path':'source.py','content':"def hello():\n    return 'reviewed'\n"})])
            return ChatResult(tool_calls=[ToolCall('readonly-write','write_file',{'path':'source.py','content':'unauthorized'})])
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(self.action))}), \
                patch.object(LLMClient,'chat',chat),patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
            result=pips.execute_native(self.worker_cfg,self.worktree,self.manifest,events.append)
        self.assertEqual((self.root/'source.py').read_text(),before)
        self.assertEqual((self.worktree/'source.py').read_text(),"def hello():\n    return 'reviewed'\n",json.dumps({'order':order,'events':events,'result':result}))
        self.assertFalse((self.worktree/'other.py').exists())
        self.assertFalse((self.worktree/'nope').exists())
        self.assertEqual(order,['parent','explorer','explorer','worker','worker','critic','critic','parent'])
        self.assertEqual(len(result['specialists']['calls']),3)
        self.assertEqual(result['specialists']['requests'],8)
        self.assertGreaterEqual(len([e for e in events if e['kind']=='tool_denied']),6)
        self.assertFalse(result['tests_executed'])
        specialists.validate_result_for_manifest(result,self.manifest)
        # Historical evidence remains readable after a builtin persona changes;
        # that same queued authority must not execute new instructions silently.
        result.update(verification=pip_execution.VERIFICATION,
            execution={'changes':pip_execution.collect_artifacts(self.prepared,self.action),'tests':[]})
        claimed=self.store.claim_next();self.assertEqual(claimed['id'],self.run_record['id'])
        finished=self.store.finish(self.run_record['id'],result=result)
        saved_json=self.registry.db.execute('SELECT result FROM pip_runs WHERE id=?',(self.run_record['id'],)).fetchone()[0]
        from dgc import pip_execution_reviews
        historical=pip_execution_reviews.for_run(self.store,self.run_record['id'])
        with patch.object(specialists,'GUIDANCE',specialists.GUIDANCE+' Changed builtins.'), \
                patch.object(LLMClient,'chat',side_effect=AssertionError('Drift must refuse before model')):
            self.assertEqual(pip_execution_reviews.for_run(self.store,self.run_record['id']),historical)
            self.assertEqual(self.registry.db.execute('SELECT result FROM pip_runs WHERE id=?',(self.run_record['id'],)).fetchone()[0],saved_json)
            with self.assertRaises(RegistryError):
                pips.execute_native(self.worker_cfg,self.worktree,self.manifest,events.append)


if __name__=='__main__':unittest.main()
