"""Exact inert connector drafts. Offline contracts, never live provider evidence."""
import copy
import json
import sqlite3
import unittest
from unittest.mock import patch
from dgc import pip_connector_drafts as connector,pip_connector_actions as adapter,pip_message_drafts as drafts,pip_chat,pips
from dgc.workspace_registry import RegistryError,WorkspaceRegistry
from tests import test_pip_connector_actions as fixtures

class ConnectorDraftTests(unittest.TestCase):
    def setUp(self):
        fixtures.ConnectorActionTests.setUp(self)
        self.cfg.data['mcp_servers']={'make':self.cfg.data['mcp_servers']['make']}
        self.context={'schema_version':1,'connections':[{k:self.inspection[k] for k in ('server','connection_digest','tools')}],'unavailable':[]}
        self.value=connector.candidate({'server':'make',**self.call},self.context)
        self.discovery=patch.object(adapter,'inspect',return_value=self.inspection);self.discovery.start();self.addCleanup(self.discovery.stop)
    def save(self,**changes):
        args=dict(run_id=self.run['id'],message=self.value,actor='main-connector:'+'a'*32,key='b'*64,kind='connector');args.update(changes);return drafts.save(self.store,**args)
    def reply(self,key='one'):
        run=pip_chat.send(self.store,self.source['id'],'Prepare this workflow for review, do not run it.',key,'user',self.cfg)['run'];self.store.claim_next();return run
    def test_parent_discovers_metadata_without_calls_worker_receives_only_bounded_snapshot(self):
        seen=[]
        def inspect(config,name,**kwargs):seen.append((name,kwargs['deadline']));return self.inspection
        context=connector.snapshot(self.cfg,inspect=inspect,clock=lambda:2)
        self.assertEqual(context,self.context);self.assertEqual(seen,[('make',32)]);self.assertEqual(self.manager.calls,[])
        run=self.reply();self.assertEqual(run['manifest']['connector_draft'],self.context);self.assertNotIn('url',json.dumps(self.context));self.assertNotIn('headers',json.dumps(self.context))
    def test_discovery_failure_and_oversized_metadata_cannot_block_ordinary_reply_or_fabricate_tools(self):
        for response in (RegistryError('offline','private detail'),{**self.inspection,'tools':[{**self.inspection['tools'][0],'description':'x'*17000}]}):
            def inspect(*a,**kw):
                if isinstance(response,Exception):raise response
                return response
            value=connector.snapshot(self.cfg,inspect=inspect,clock=lambda:0)
            self.assertEqual(value['connections'],[]);self.assertEqual(len(value['unavailable']),1);self.assertNotIn('private detail',json.dumps(value))
            with self.assertRaises(RegistryError):connector.candidate({'server':'make',**self.call},value)
    def test_unknown_tool_wrong_pin_or_secret_never_save(self):
        for args in ({'server':'make','tool':'invented','arguments':{}},{'server':'notion',**self.call},{'server':'make',**self.call,'execute':True}):
            with self.assertRaises(RegistryError):connector.candidate(args,self.context)
        with self.assertRaises(RegistryError):drafts.validate_message({**self.value,'call':{**self.call,'arguments':{'secret':'private-fixture-secret'}}},['private-fixture-secret'],kind='connector')
        run=self.reply()
        with self.assertRaises(RegistryError):self.store.finish(run['id'],result={'text':'Draft','connector_action_draft':{**self.value,'schema_digest':'f'*64}})
        self.assertEqual(drafts.history(self.store,self.source['id'],kind='connector')['drafts'],[])
    def test_successful_reply_commits_one_inert_draft_and_human_prepare_never_executes(self):
        run=self.reply();self.store.finish(run['id'],result={'text':'Review the action before it runs.','connector_action_draft':self.value})
        page=drafts.history(self.store,self.source['id'],kind='connector');self.assertEqual(len(page['drafts']),1)
        d=drafts.get(self.store,page['drafts'][0]['id'],kind='connector');self.assertEqual(d['payload']['action'],self.value);self.assertIsNone(d['action_id'])
        a=connector.prepare(self.store,d['id'],d['digest'],None,'editor-user',self.cfg);self.assertEqual(a['status'],'pending');self.assertEqual(a['payload']['call'],self.call)
        self.assertEqual(connector.prepare(self.store,d['id'],d['digest'],None,'local-console',self.cfg)['id'],a['id']);self.assertEqual(self.manager.calls,[])
        with self.assertRaises(RegistryError):connector.prepare(self.store,d['id'],d['digest'],{**self.call,'arguments':{'workflow_id':'changed'}},'editor-user',self.cfg)
    def test_cancel_failed_or_stale_reply_commits_nothing(self):
        run=self.reply();self.store.cancel(run['id'],'user');self.store.finish(run['id'],result={'text':'Draft','connector_action_draft':self.value})
        self.assertEqual(drafts.history(self.store,self.source['id'],kind='connector')['drafts'],[])
        run=self.reply('stale');self.store.set_paused(self.source['id'],True,'local-console');self.store.finish(run['id'],result={'text':'Draft','connector_action_draft':self.value})
        self.assertEqual(drafts.history(self.store,self.source['id'],kind='connector')['drafts'],[])
    def test_saved_draft_is_immutable_and_only_human_can_prepare(self):
        d=self.save();self.assertEqual(d,self.save())
        for actor in ('model','remote-device'):
            with self.assertRaises(RegistryError):connector.prepare(self.store,d['id'],d['digest'],None,actor,self.cfg)
        with self.assertRaises(sqlite3.IntegrityError):self.store.db.execute('DELETE FROM pip_connector_drafts WHERE id=?',(d['id'],))
        dismissed=drafts.dismiss(self.store,d['id'],d['digest'],'editor-user',kind='connector');self.assertEqual(dismissed['status'],'dismissed')
        with self.assertRaises(RegistryError):connector.prepare(self.store,d['id'],d['digest'],None,'editor-user',self.cfg)
    def test_changed_live_descriptor_or_connection_rejects_main_draft(self):
        connector.check_current(self.value,self.cfg)
        with patch.object(adapter,'inspect',return_value={**self.inspection,'connection_digest':'f'*64}),self.assertRaises(RegistryError):connector.check_current(self.value,self.cfg)
        with patch.object(adapter,'inspect',return_value={**self.inspection,'tools':[]}),self.assertRaises(RegistryError):connector.check_current(self.value,self.cfg)
    def test_missing_or_project_context_cannot_inject_worker_drafts(self):
        self.assertIsNone(connector.pin({}))
        with self.assertRaises(RegistryError):connector.pin({'run_kind':'audit','source_policy':{'mode':'personal'},'connector_draft':self.context})
        with self.assertRaises(RegistryError):connector.validate_snapshot({**self.context,'execute':True})
    def test_controller_controls_closed_and_local(self):
        d=self.save()
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=self.registry.clock)):
            req={'type':'get_pip_connector_draft','request_id':'test','draft_id':d['id']}
            for actor in ('model','remote-device'):
                answer=pips.handle_control(self.cfg,req,actor,start_worker=False);self.assertFalse(answer['ok'])
            answer=pips.handle_control(self.cfg,req,'editor-user',start_worker=False);self.assertTrue(answer['ok'],answer)
            answer=pips.handle_control(self.cfg,{**req,'execute':True},'editor-user',start_worker=False);self.assertFalse(answer['ok'])
    def test_schema30_upgrade_preserves_existing_drafts_and_actions(self):
        before=self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0]
        self.store.db.execute('DROP TABLE pip_connector_drafts');self.store.db.execute('PRAGMA user_version=30')
        with WorkspaceRegistry(self.registry.directory) as registry:
            self.assertEqual(registry.db.execute('PRAGMA user_version').fetchone()[0],32);self.assertEqual(registry.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],before)
    def test_native_worker_discovers_and_drafts_without_an_mcp_process(self):
        import os
        from dgc.llm import LLMClient,ChatResult,ToolCall
        run=self.reply();calls=[]
        def chat(client,messages,tools=None,**kwargs):
            calls.append(1);names={t['function']['name'] for t in tools};self.assertIn('list_connector_tools',names);self.assertIn('draft_connector_action',names)
            self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_connector_drafts').fetchone()[0],0)
            if len(calls)==1:return ChatResult(content='',tool_calls=[ToolCall('metadata','list_connector_tools',{})])
            if len(calls)==2:
                self.assertIn('run_selected_workflow',json.dumps(messages));return ChatResult(content='',tool_calls=[ToolCall('draft','draft_connector_action',{'server':'make',**self.call})])
            return ChatResult(content='Review the workflow draft. Nothing has run.')
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(personal=True))}),patch.object(LLMClient,'chat',chat),patch('dgc.agent.discover_skills',return_value={}),patch('requests.get',side_effect=RuntimeError('offline')),patch('dgc.mcp.MCPManager.connect_all',side_effect=AssertionError('No MCP in worker')):
            result=pips.execute_native(self.cfg,self.root,run['manifest'],lambda e:None)
        self.assertEqual(result['connector_action_draft'],self.value);self.store.finish(run['id'],result=result);self.assertEqual(len(drafts.history(self.store,self.source['id'],kind='connector')['drafts']),1);self.assertEqual(self.manager.calls,[])

from tests import test_pip_personal_handoff_tool as main_fixtures
from tests.test_app_connectors import spec
class MainConnectorDraftTests(unittest.TestCase):
    setUp=main_fixtures.PersonalHandoffToolTests.setUp
    prepare=main_fixtures.PersonalHandoffToolTests.prepare
    context=main_fixtures.PersonalHandoffToolTests.context
    def test_main_tool_discovers_actual_descriptor_then_saves_once_without_running(self):
        from dgc import pip_email_tool as tool
        self.cfg.data['mcp_servers']={'make':spec('make')};manager=fixtures.Manager('make')
        inspection=adapter.inspect(self.cfg,'make',manager_factory=lambda *a:manager,clock=lambda:0)
        value=connector.candidate({'server':'make','tool':'run_selected_workflow','arguments':{'workflow_id':'selected'}},{'schema_version':1,'connections':[{k:inspection[k] for k in ('server','connection_digest','tools')}],'unavailable':[]})
        args={'scope':'personal','source_run_id':self.run['id'],'action':value,'request_key':'once'}
        with patch.object(tool,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=self.registry.clock)),patch.object(adapter,'inspect',return_value=inspection) as read:
            result=json.loads(tool.propose(args,self.context(),kind='connector'));self.assertEqual(read.call_count,1);self.assertFalse(result['execute_authorized']);self.assertEqual(result['draft_kind'],'connector')
            read.side_effect=AssertionError('A retry must return its existing receipt without reconnecting')
            self.assertEqual(json.loads(tool.propose(args,self.context(),kind='connector')),result)
            with self.assertRaises(RegistryError):tool.propose({**args,'action':{**value,'call':{**value['call'],'arguments':{}}}},self.context(),kind='connector')
        self.assertEqual(manager.calls,[]);self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
    def test_permission_asks_deny_wins_and_restricted_tools_are_hidden(self):
        from dgc.permissions import PermissionEngine,ASK,DENY
        self.assertEqual(PermissionEngine('default',{},self.root).decide('draft_pip_connector_action',{})[0],ASK)
        self.assertEqual(PermissionEngine('auto',{'allow':['*'],'deny':['PipsConnectorDraft']},self.root).decide('draft_pip_connector_action',{})[0],DENY)
