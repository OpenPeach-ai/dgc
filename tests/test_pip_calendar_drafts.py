"""Inert calendar drafting: real local persistence, no network or sleeps."""
import copy
import json
import os
import sqlite3
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch
from dgc import pip_message_drafts as drafts,pip_chat,pips,pip_email_tool as tool
from dgc import workspace_registry
from dgc.workspace_registry import WorkspaceRegistry,RegistryError
from tests import test_pip_calendar_actions as action_fixtures
from tests import test_pip_personal_handoff_tool as tool_fixtures
from tests import test_pip_message_drafts as mail_fixtures

EVENT=action_fixtures.EVENT

class CalendarDraftTests(unittest.TestCase):
    setUp=action_fixtures.CalendarActionTests.setUp
    prepare_source=action_fixtures.CalendarActionTests.prepare_source
    def save(self,**changes):
        args=dict(run_id=self.run['id'],message=EVENT,actor='main-calendar:'+'a'*32,key='b'*64,kind='calendar');args.update(changes)
        return drafts.save(self.store,**args)
    def prepare(self,draft,**changes):
        args=dict(draft_id=draft['id'],expected_digest=draft['digest'],server='composio',connection_digest=self.inspection['connection_digest'],account='ca_test',schema_digest=self.inspection['schema_digest'],message=EVENT,actor='editor-user',config=self.cfg,kind='calendar');args.update(changes)
        return drafts.prepare(self.store,**args)
    def test_draft_and_preparation_do_not_create_or_select_an_account_implicitly(self):
        d=self.save();self.assertTrue(d['id'].startswith('caldraft_'));self.assertEqual(d['payload']['event'],EVENT)
        self.assertNotIn('account',d['payload']);self.assertEqual(self.manager.calls,[])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
        a=self.prepare(d);self.assertEqual(a['status'],'pending');self.assertEqual(a['payload']['kind'],'calendar_create')
        self.assertEqual(self.prepare(d,actor='local-console')['id'],a['id']);self.assertEqual(self.manager.calls,[])
        with self.assertRaises(RegistryError):self.prepare(d,message={**EVENT,'summary':'Changed'})
        with self.assertRaises(RegistryError):drafts.get(self.store,d['id'])
        self.assertEqual(drafts.history(self.store,self.source['id'])['drafts'],[])
    def test_concurrent_human_preparation_is_one_action(self):
        saved=self.save();barrier=threading.Barrier(2)
        def prepare(actor):
            with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as registry:
                store=pips.PipStore(registry);barrier.wait(timeout=5)
                return drafts.prepare(store,saved['id'],saved['digest'],'composio',self.inspection['connection_digest'],'ca_test',self.inspection['schema_digest'],EVENT,actor,self.cfg,kind='calendar')['id']
        with ThreadPoolExecutor(max_workers=2) as pool:
            a=pool.submit(prepare,'editor-user');b=pool.submit(prepare,'local-console')
            self.assertEqual(a.result(timeout=10),b.result(timeout=10))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],1)
        self.assertEqual(self.manager.calls,[])
    def test_failure_linking_draft_rolls_back_action(self):
        d=self.save();self.store.db.execute("CREATE TRIGGER fail_calendar_prepare BEFORE UPDATE ON pip_calendar_drafts BEGIN SELECT RAISE(ABORT,'fixture failure');END")
        with self.assertRaises(sqlite3.IntegrityError):self.prepare(d)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
        self.assertEqual(drafts.get(self.store,d['id'],kind='calendar')['status'],'pending')
    def test_immutable_idempotent_and_scoped_history(self):
        d=self.save();self.assertEqual(d,self.save())
        with self.assertRaises(RegistryError):self.save(message={**EVENT,'summary':'Changed'})
        with self.assertRaises(sqlite3.IntegrityError):self.store.db.execute("UPDATE pip_calendar_drafts SET payload='{}' WHERE id=?",(d['id'],))
        with self.assertRaises(sqlite3.IntegrityError):self.store.db.execute('DELETE FROM pip_calendar_drafts WHERE id=?',(d['id'],))
        page=drafts.history(self.store,self.source['id'],kind='calendar');self.assertEqual(page['drafts'][0]['subject'],EVENT['summary'])
        self.assertNotIn('description',json.dumps(page))
        with self.assertRaises(RegistryError):drafts.history(self.store,self.target['id'],before_id=d['id'],kind='calendar')
    def reply(self,key='calendar'):
        run=pip_chat.send(self.store,self.source['id'],'Draft one reading event with the exact date and timezone I provide.',key,'user',self.cfg)['run'];self.store.claim_next();return run
    def test_native_reply_drafts_once_and_saves_only_after_success(self):
        from dgc.llm import LLMClient,ChatResult,ToolCall
        run=self.reply();calls=[]
        def chat(client,messages,tools=None,**kwargs):
            calls.append(1);self.assertEqual({t['function']['name'] for t in tools},{'draft_pip_change','draft_email','draft_calendar_event','list_connector_tools','draft_connector_action'})
            self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_calendar_drafts').fetchone()[0],0)
            if len(calls)==1:return ChatResult(content='',tool_calls=[ToolCall('calendar1','draft_calendar_event',EVENT)])
            return ChatResult(content='Review the calendar draft. No event was created.')
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(personal=True))}),patch.object(LLMClient,'chat',chat),patch('dgc.agent.discover_skills',return_value={}),patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
            result=pips.execute_native(self.cfg,self.root,run['manifest'],lambda event:None)
        self.assertEqual(result['calendar_draft'],EVENT);self.store.finish(run['id'],result=result)
        saved=drafts.history(self.store,self.source['id'],kind='calendar')['drafts'][0]
        self.assertEqual(saved['status'],'pending');self.assertEqual(saved['source_run_id'],run['id'])
        self.store.finish(run['id'],result=result)
        self.assertEqual(len(drafts.history(self.store,self.source['id'],kind='calendar')['drafts']),1)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
    def test_cancel_bad_reply_stale_and_absent_pin_never_commit(self):
        run=self.reply();self.store.cancel(run['id'],'user');self.store.finish(run['id'],result={'text':'Draft','calendar_draft':EVENT})
        self.assertEqual(drafts.history(self.store,self.source['id'],kind='calendar')['drafts'],[])
        run=self.reply('invalid')
        with self.assertRaises(RegistryError):self.store.finish(run['id'],result={'text':'','calendar_draft':EVENT})
        self.store.set_paused(self.source['id'],True,'local-console');self.store.finish(run['id'],result={'text':'Draft','calendar_draft':EVENT})
        self.assertEqual(drafts.history(self.store,self.source['id'],kind='calendar')['drafts'],[])
        self.assertFalse(drafts.validate_pin({'run_kind':'conversation'},kind='calendar'))
        with self.assertRaises(RegistryError):drafts.validate_pin({'run_kind':'personal_task','source_policy':{'mode':'personal'},'calendar_draft':{'schema_version':1}},kind='calendar')
    def test_hidden_fields_secret_and_timezone_errors_refused(self):
        for update in ({'account':'ca_other'},{'attendees':['x@example.invalid']},{'timezone':'Europe/London'},{'start_datetime':'tomorrow'},{'summary':'x\u202ey'}):
            with self.assertRaises(RegistryError):self.save(message={**EVENT,**update})
        with self.assertRaises(RegistryError):drafts.validate_message({**EVENT,'description':'private-test-credential'},['private-test-credential'],kind='calendar')
        self.assertEqual(self.manager.calls,[])
    def test_local_controller_only_and_dismissal(self):
        d=self.save()
        request={'type':'prepare_pip_calendar_draft','request_id':'control','draft_id':d['id'],'expected_digest':d['digest'],**{k:self.inspection[k] for k in ('server','connection_digest','schema_digest')},'account':'ca_test','event':EVENT}
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=self.registry.clock)):
            for actor in ('model','remote-device'):
                response=pips.handle_control(self.cfg,request,actor,start_worker=False);self.assertFalse(response['ok']);self.assertEqual(response['error']['code'],'local_only')
            response=pips.handle_control(self.cfg,{**request,'type':'get_pip_calendar_draft'},'editor-user',start_worker=False)
            self.assertFalse(response['ok'])  # Closed command shape.
        dismissed=drafts.dismiss(self.store,d['id'],d['digest'],'editor-user',kind='calendar');self.assertEqual(dismissed['status'],'dismissed')
        with self.assertRaises(RegistryError):self.prepare(d)
    def test_schema28_upgrade_preserves_email_and_action_rows_and_rolls_back(self):
        from dgc import workspace_registry as schema
        mail=drafts.save(self.store,self.run['id'],self.message,'main-email:'+'a'*32,'b'*64)
        self.store.db.execute('DROP TABLE pip_calendar_drafts');self.store.db.execute('DROP TABLE pip_connector_drafts');self.store.db.execute('PRAGMA user_version=28')
        before=[tuple(r) for r in self.store.db.execute('SELECT * FROM pip_message_drafts')]
        original=schema._execute_schema
        def fail_after(db,sql):
            original(db,sql)
            if sql==drafts.CALENDAR_SCHEMA:raise RuntimeError('injected migration failure')
        with patch.object(schema,'_execute_schema',side_effect=fail_after),self.assertRaisesRegex(RuntimeError,'injected'):WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.store.db.execute('PRAGMA user_version').fetchone()[0],28)
        self.assertIsNone(self.store.db.execute("SELECT name FROM sqlite_master WHERE name='pip_calendar_drafts'").fetchone())
        with WorkspaceRegistry(self.registry.directory) as registry:
            self.assertEqual(registry.db.execute('PRAGMA user_version').fetchone()[0],workspace_registry.SCHEMA_VERSION)
            self.assertEqual([tuple(r) for r in registry.db.execute('SELECT * FROM pip_message_drafts')],before)
        with patch.object(schema,'SCHEMA_VERSION',28),self.assertRaisesRegex(RegistryError,'compatible DGC version'):WorkspaceRegistry(self.registry.directory)

class MainCalendarDraftTests(unittest.TestCase):
    setUp=tool_fixtures.PersonalHandoffToolTests.setUp
    prepare=tool_fixtures.PersonalHandoffToolTests.prepare
    context=tool_fixtures.PersonalHandoffToolTests.context
    def propose(self,ctx=None,**changes):
        args={'scope':'personal','source_run_id':self.run['id'],'event':EVENT,'request_key':'once',**changes}
        with patch.object(tool,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=self.registry.clock)):
            return json.loads(tool.propose(args,ctx or self.context(),kind='calendar'))
    def test_main_saves_inert_draft_and_replays_same_identity(self):
        value=self.propose();self.assertFalse(value['create_authorized']);self.assertFalse(value['account_selected']);self.assertEqual(value,self.propose())
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
        with self.assertRaises(RegistryError):self.propose(account='ca_other')
        with self.assertRaises(RegistryError):self.propose(scope='project')
    def test_stale_main_binding_refused_before_reading_result(self):
        ctx=self.context()
        other=self.base/'other';other.mkdir();foreign=self.registry.resolve(other)
        self.registry.db.execute("UPDATE session_workspaces SET binding_id=? WHERE session_id='chat-one'",(foreign['binding_id'],))
        with patch.object(pips.PipStore,'run',side_effect=AssertionError('No private read')),self.assertRaises(RegistryError):self.propose(ctx=ctx)
