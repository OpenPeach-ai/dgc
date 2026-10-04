"""Explicit specialist grants, shared budgets and native constrained child loops."""
import copy
import json
import os
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_specialists as specialists, pip_execution as execution, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import PermissionEngine, DENY
from dgc.workspace_registry import RegistryError
from tests import test_pip_handoffs as fixtures


def grant(roles=None,calls=3): return {'roles': roles or ['explorer','critic','worker'], 'max_calls':calls}
def action(roles=None,calls=3): return {'kind':'patch','write_paths':['source.py'],'tests':[],'specialists':grant(roles,calls)}


class SpecialistContractTests(unittest.TestCase):
    def test_optional_action_omission_preserves_old_canonical_bytes(self):
        raw={'kind':'patch','write_paths':['source.py'],'tests':[]}
        expected={**raw,'network':False,'limits':dict(execution.LIMITS)}
        self.assertEqual(pips._json(execution.validate_action('patch',raw)),pips._json(expected))
        self.assertIsNone(specialists.pin(expected))
        self.assertIsNone(specialists.validate_manifest({},expected))
        specialists.validate_result_for_manifest({}, {'run_kind':'patch'})
        self.assertEqual(execution.validate_action('patch',action(['worker','explorer']))['specialists'],grant(['explorer','worker']))
        self.assertNotEqual(execution.action_digest(raw),execution.action_digest(action()))

    def test_invalid_or_unreviewed_roles_and_expansion_refused(self):
        for value in (None,{}, {'roles':[],'max_calls':1},grant(['custom']),grant(['worker','worker']),grant(calls=True),grant(calls=0),grant(calls=4),{**grant(),'model':'other'},grant([{}])):
            with self.subTest(value=value),self.assertRaises(RegistryError): execution.validate_action('patch',{**action(),'specialists':value})
        for role,value in [('rook',{'kind':'read_only','specialists':grant()}),('pulse',{'kind':'test','tests':[{'argv':['true'],'cwd':'.'}],'specialists':grant()})]:
            with self.subTest(role=role),self.assertRaises(RegistryError): execution.validate_action(role,value)

    def test_pinned_builtin_instructions_and_policy_are_exact(self):
        selected=execution.validate_action('patch',action())
        pin=specialists.pin(selected)
        manifest={'run_kind':'patch','specialists':pin,'limits':{'iterations':12,'tool_calls':64,'wall_seconds':300}}
        self.assertEqual(specialists.validate_manifest(manifest,selected),pin)
        with patch.object(specialists,'GUIDANCE',specialists.GUIDANCE+' Changed.'),self.assertRaises(RegistryError): specialists.validate_manifest(manifest,selected)
        for field,value in [('version',True),('digest','0'*64),('extra',True)]:
            changed=copy.deepcopy(manifest);changed['specialists'][field]=value
            with self.subTest(field=field),self.assertRaises(RegistryError): specialists.validate_manifest(changed,selected)
        with self.assertRaises(RegistryError): specialists.validate_manifest(manifest,{'kind':'patch'})

    def test_task_calls_cannot_select_defaults_background_nested_routes_or_long_input(self):
        good={'agent':'explorer','description':'Map source','prompt':'Read source.py'}
        self.assertEqual(specialists.validate_call(good,grant()),good)
        for changed in ({k:v for k,v in good.items() if k!='agent'}, {**good,'background':False}, {**good,'agent':'researcher'},
                        {**good,'model':'other'}, {**good,'prompt':'界'*1400}, {**good,'description':'\ud800'}):
            with self.subTest(changed=changed),self.assertRaises(RegistryError): specialists.validate_call(changed,grant())
        shape=specialists.schema(grant(['critic']))['function']['parameters']
        self.assertFalse(shape['additionalProperties'])
        self.assertEqual(shape['properties']['agent']['enum'],['critic'])

    def test_historical_receipt_survives_persona_update_but_queued_execution_refuses(self):
        selected=execution.validate_action('patch',action())
        policy=specialists.pin(selected)
        budget=self.budget()
        receipt=budget.result(policy,0)
        manifest={'run_kind':'patch','model':'fixture','specialists':policy,
                  'limits':{'iterations':12,'tool_calls':64,'wall_seconds':300},
                  'handoff':{'payload':{'action':selected}}}
        with patch.object(specialists,'GUIDANCE',specialists.GUIDANCE+' Runtime update.'):
            specialists.validate_result_for_manifest({'tools_called':0,'specialists':receipt},manifest)
            with self.assertRaises(RegistryError):specialists.validate_manifest(manifest,selected)
        forged=copy.deepcopy(receipt);forged['policy_digest']='0'*64
        with self.assertRaises(RegistryError):specialists.validate_result_for_manifest({'tools_called':0,'specialists':forged},manifest)

    def budget(self):
        self.now=100.0;self.cancel=threading.Event()
        return specialists.SharedBudget(grant(),{'model':'fixture','base_url':'http://localhost.invalid/v1','api_mode':'chat_completions'},self.cancel,deadline=400,clock=lambda:self.now)

    def client(self, reply=None):
        return SimpleNamespace(model='fixture',base_url='http://localhost.invalid/v1',api_mode='chat_completions',max_tokens=4096,
                               chat=reply or (lambda **kwargs:ChatResult(content='done')),compact_responses=lambda *a,**k:'UNBUDGETED')

    def test_twelve_total_model_calls_not_twelve_per_child(self):
        budget=self.budget();record=budget.begin('worker','fixture')
        parent=budget.wrap(self.client());child=budget.wrap(self.client(),record)
        for _ in range(8):parent.chat()
        for _ in range(4):child.chat()
        with self.assertRaisesRegex(RegistryError,'shared twelve'): parent.chat()
        self.assertEqual(budget.requests,12);self.assertEqual(record['requests'],4)
        self.assertEqual(budget.model_calls,12);self.assertEqual(budget.transport_attempts,0)
        self.assertEqual(budget.output_token_reservations,49152)
        self.assertTrue(self.cancel.is_set())
        self.assertIsNone(parent.compact_responses())

    def test_auxiliary_metadata_and_load_probes_are_disabled_on_wrapped_client(self):
        budget=self.budget();client=self.client()
        client.prepare_model=lambda **kwargs:self.fail('unbudgeted metadata')
        client._ollama_load_probe=lambda:self.fail('unbudgeted load polling')
        budget.wrap(client)
        self.assertEqual(client.prepare_model(),{})
        self.assertIsNone(client._ollama_load_probe())
        self.assertEqual(budget.requests,0)

    def test_transport_retries_reserve_before_attempt_and_distinguish_measured_calls(self):
        budget=self.budget();client=self.client()
        begun=[]
        client._begin_attempt=lambda *a,**k:begun.append(True)
        def retry(**kwargs):
            for _ in range(13):client._begin_attempt(None,'fixture')
        client.chat=retry
        budget.wrap(client)
        with self.assertRaises(RegistryError):client.chat()
        self.assertEqual(len(begun),12)
        self.assertEqual(budget.requests,12);self.assertEqual(budget.model_calls,1)
        self.assertEqual(budget.transport_attempts,12)

    def test_stop_deadline_routes_and_output_caps_refuse_before_model(self):
        for changed in ({'model':'other'},{'base_url':'https://other.invalid'},{'api_mode':'responses'},{'max_tokens':4097}):
            budget=self.budget();client=self.client(reply=lambda **kw:self.fail('provider called'))
            for key,value in changed.items():setattr(client,key,value)
            with self.subTest(changed=changed),self.assertRaises(RegistryError):budget.wrap(client).chat()
        budget=self.budget();self.now=400
        with self.assertRaises(RegistryError):budget.wrap(self.client()).chat()
        budget=self.budget();self.cancel.set()
        with self.assertRaises(RegistryError):budget.begin('worker','fixture')
        for invalid in (True,float('nan'),float('inf'),401):
            with self.subTest(deadline=invalid),self.assertRaises(RegistryError):specialists.SharedBudget(grant(),{},threading.Event(),deadline=invalid,clock=lambda:100)

    def test_grant_cap_and_bounded_ui_output(self):
        budget=self.budget()
        for _ in range(3):budget.begin('critic','fixture')
        with self.assertRaises(RegistryError):budget.begin('critic','fixture')
        ui=specialists.SpecialistUI(SimpleNamespace(),budget.calls[0],budget)
        ui.on_text('界'*10000)
        with self.assertRaisesRegex(RegistryError,'budget'):ui.on_text('界'*1000)
        self.assertTrue(self.cancel.is_set())
        text=specialists.summary('界'*1000)
        self.assertLessEqual(len(text.encode()),1200)
        self.assertIn('truncated',text)

    def test_receipt_types_counts_and_unapproved_models_refused(self):
        budget=self.budget();rec=budget.begin('worker','fixture');rec['status']='completed'
        value=budget.result(specialists.pin(action()),0)
        self.assertEqual(value['calls'][0]['summary'],'')
        manifest={'run_kind':'patch','model':'fixture','specialists':specialists.pin(action()),'limits':{'iterations':12,'tool_calls':64,'wall_seconds':300},'handoff':{'payload':{'action':action()}}}
        specialists.validate_result_for_manifest({'tools_called':0,'specialists':value},manifest)
        for mutate in (lambda x:x.update(version=True),lambda x:x.update(requests=True),lambda x:x['calls'][0].update(status='running'),
                       lambda x:x['calls'][0].update(tool_calls=1),lambda x:x['calls'][0].update(summary='界'*401),lambda x:x['calls'].append(x['calls'][0])):
            bad=copy.deepcopy(value);mutate(bad)
            with self.assertRaises(RegistryError):specialists.validate_result(bad,grant())
        bad=copy.deepcopy(value);bad['calls'][0]['model']='other'
        with self.assertRaises(RegistryError):specialists.validate_result_for_manifest({'tools_called':0,'specialists':bad},manifest)


class NativeSpecialistTests(unittest.TestCase):
    setUp=fixtures.PipHandoffTests.setUp
    git=fixtures.PipHandoffTests.git
    commit=fixtures.PipHandoffTests.commit
    setup_source=fixtures.PipHandoffTests.setup_source
    propose=fixtures.PipHandoffTests.propose
    accept=fixtures.PipHandoffTests.accept
    raw_manifest=fixtures.PipHandoffTests.raw_manifest

    def prepare(self,roles=None,calls=3):
        self.setup_source()
        self.target=self.store.create(self.workspace['id'],'Fixer','Prepare reviewed source change','device',pip_type='patch')
        self.action=execution.validate_action('patch',action(roles,calls))
        with patch.object(execution,'capability',return_value={'available':True}):
            accepted=self.accept(self.propose(action=self.action))
        self.manifest=self.raw_manifest(accepted['run']['id'])
        self.snapshot=self.base/'private-source'
        pips.clean_snapshot(self.root,self.manifest['source_revision'],self.snapshot)
        self.worker=self.cfg.clone_for_root(self.snapshot)
        self.worker.data.update(self.manifest['model_settings'])
        self.worker.data.update(mode='acceptEdits',max_subagent_depth=1,fallback_model='',fallback_base_url='',hooks={})
        self.worker.permissions={'allow':['Task'],'ask':[],'deny':[]}
        self.events=[]

    def execute(self,chat):
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(self.action))}), \
             patch.object(LLMClient,'chat',chat), patch('dgc.agent.Agent._run_subagent',side_effect=AssertionError('generic child fallback')), \
             patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
            return pips.execute_native(self.worker,self.snapshot,self.manifest,self.events.append)

    def test_real_agent_bridge_reads_edits_reviews_without_mutating_original_checkout(self):
        self.prepare()
        parent_step=[0]; seen_roles=[]
        def chat(client,messages,tools=None,**kwargs):
            system=messages[0]['content']
            if 'You are a synchronous specialist' in system:
                role=next(name for name,needle in [('explorer','read-only explorer'),('critic','You are a critic'),('worker','You are a worker')] if needle in system)
                seen_roles.append(role)
                names={tool['function']['name'] for tool in tools}
                self.assertNotIn('task',names);self.assertNotIn('bash',names);self.assertNotIn('web_fetch',names)
                results=[m for m in messages if m.get('role')=='tool']
                if not results:
                    call=ToolCall('child-write','write_file',{'path':'source.py','content':"def hello():\n    return 'fixed'\n"}) if role=='worker' else ToolCall('child-read','read_file',{'path':'source.py'})
                    return ChatResult(tool_calls=[call],usage={'prompt_tokens':10,'completion_tokens':5})
                return ChatResult(content='Source-backed assessment; tests were not executed.',usage={'prompt_tokens':10,'completion_tokens':5})
            role=['explorer','worker','critic'][parent_step[0]] if parent_step[0]<3 else None
            parent_step[0]+=1
            if role:
                return ChatResult(tool_calls=[ToolCall('delegate-'+role,'task',{'agent':role,'description':'Inspect '+role,'prompt':'Inspect or update only source.py within the approved action.'})],usage={'prompt_tokens':10,'completion_tokens':5})
            return ChatResult(content='Prepared the reviewed edit; controller verification is pending.',usage={'prompt_tokens':10,'completion_tokens':5})
        result=self.execute(chat)
        self.assertEqual((self.root/'source.py').read_text(),"def hello():\n    return 'hello'\n")
        self.assertEqual((self.snapshot/'source.py').read_text(),"def hello():\n    return 'fixed'\n")
        self.assertEqual([r['role'] for r in result['specialists']['calls']],['explorer','worker','critic'])
        self.assertTrue(all(r['status']=='completed' for r in result['specialists']['calls']))
        self.assertEqual(result['specialists']['requests'],10)
        self.assertEqual(result['specialists']['model_calls'],10)
        self.assertEqual(result['specialists']['transport_attempts'],0)  # provider replaced by deterministic fixture
        self.assertEqual(result['usage']['requests'],10)
        self.assertEqual(result['tools_called'],6)
        self.assertFalse(result['tests_executed'])

    def test_unapproved_and_custom_task_calls_never_invoke_a_child(self):
        self.prepare(['explorer'],calls=1)
        requests=[0]
        def chat(client,messages,tools=None,**kwargs):
            requests[0]+=1
            if requests[0]==1:
                return ChatResult(tool_calls=[ToolCall('custom','task',{'agent':'user-agent','description':'bad','prompt':'bad'}),
                    ToolCall('background','task',{'agent':'explorer','description':'bad','prompt':'bad','background':True})])
            return ChatResult(content='Unsupported delegation refused; no edits prepared.')
        result=self.execute(chat)
        self.assertEqual(result['specialists']['calls'],[])
        self.assertEqual(requests[0],2)
        self.assertEqual(len([e for e in self.events if e.get('kind')=='tool_denied']),2)

    def test_policy_pin_tamper_refused_before_any_agent(self):
        self.prepare()
        self.manifest['specialists']['instructions']['worker']='0'*64
        with patch('dgc.agent.Agent',side_effect=AssertionError('No Agent before pin validation')):
            with self.assertRaises(RegistryError):pips.execute_native(self.worker,self.snapshot,self.manifest,self.events.append)

    def test_old_action_still_denies_task_in_every_permission_mode(self):
        raw={'kind':'patch','write_paths':['source.py'],'tests':[]}
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(raw))}):
            for mode in ('default','auto','acceptEdits','plan'):
                self.assertEqual(PermissionEngine(mode,{'allow':['*']},self.root).decide('task',{'description':'x'})[0],DENY)


if __name__=='__main__': unittest.main()
