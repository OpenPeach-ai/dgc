"""Offline model email drafts, human review boundaries and atomic persistence."""
import copy
import hashlib
import json
import os
import sqlite3
import unittest
from unittest.mock import patch
from dgc import pip_message_drafts as drafts,pip_chat,pips,pip_email_tool as tool
from dgc import workspace_registry
from dgc.workspace_registry import WorkspaceRegistry,RegistryError
from tests import test_pip_app_actions as fixtures
from tests import test_pip_personal_handoff_tool as tool_fixtures
from tests.pip_test_migrations import drop_digest_schema

class MessageDraftTests(unittest.TestCase):
    setUp=fixtures.AppActionTests.setUp
    prepare_source=fixtures.AppActionTests.prepare_source
    def save(self,**changes):
        args=dict(run_id=self.run['id'],message=self.message,actor='main-email:'+'a'*32,key='b'*64);args.update(changes)
        return drafts.save(self.store,**args)
    def prepare(self,draft,**changes):
        args=dict(draft_id=draft['id'],expected_digest=draft['digest'],server='composio',connection_digest=self.inspection['connection_digest'],account='ca_test',schema_digest=self.inspection['schema_digest'],message=self.message,actor='editor-user',config=self.cfg);args.update(changes)
        return drafts.prepare(self.store,**args)
    def test_draft_has_no_account_or_action_until_human_preparation(self):
        d=self.save();self.assertEqual(d['status'],'pending');self.assertNotIn('account',d['payload']);self.assertEqual(self.manager.calls,[])
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
        a=self.prepare(d);self.assertEqual(a['status'],'pending');self.assertEqual(self.manager.calls,[])
        self.assertEqual(self.prepare(d,actor='local-console')['id'],a['id'])
        self.assertEqual(drafts.get(self.store,d['id'])['action_id'],a['id'])
        with self.assertRaises(RegistryError):self.prepare(d,message={**self.message,'body':'Changed'})
    def test_two_human_controllers_prepare_one_action(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        saved=self.save();barrier=threading.Barrier(2)
        def prepare(actor):
            with WorkspaceRegistry(self.registry.directory,clock=self.registry.clock) as registry:
                store=pips.PipStore(registry);barrier.wait(timeout=5)
                return drafts.prepare(store,saved['id'],saved['digest'],'composio',self.inspection['connection_digest'],
                    'ca_test',self.inspection['schema_digest'],self.message,actor,self.cfg)['id']
        with ThreadPoolExecutor(max_workers=2) as pool:
            first=pool.submit(prepare,'editor-user');second=pool.submit(prepare,'local-console')
            self.assertEqual(first.result(timeout=10),second.result(timeout=10))
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],1)
        self.assertEqual(self.manager.calls,[])

    def test_schema26_upgrade_rollback_and_old_reader_refusal(self):
        from dgc import workspace_registry as schema
        self.store.db.execute('DROP TABLE pip_calendar_drafts');self.store.db.execute('DROP TABLE pip_message_drafts');self.store.db.execute('DROP TABLE pip_connector_drafts');drop_digest_schema(self.store.db);self.store.db.execute('PRAGMA user_version=26')
        before=[tuple(r) for r in self.store.db.execute('SELECT * FROM pip_runs ORDER BY id')]
        original=schema._execute_schema
        def fail_after(db,sql):
            original(db,sql)
            if sql==drafts.SCHEMA:raise RuntimeError('injected draft migration')
        with patch.object(schema,'_execute_schema',side_effect=fail_after):
            with self.assertRaisesRegex(RuntimeError,'injected'):WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.store.db.execute('PRAGMA user_version').fetchone()[0],26)
        self.assertIsNone(self.store.db.execute("SELECT name FROM sqlite_master WHERE name='pip_message_drafts'").fetchone())
        with WorkspaceRegistry(self.registry.directory) as registry:
            self.assertEqual(registry.db.execute('PRAGMA user_version').fetchone()[0],workspace_registry.SCHEMA_VERSION)
            self.assertEqual([tuple(r) for r in registry.db.execute('SELECT * FROM pip_runs ORDER BY id')],before)
        with patch.object(schema,'SCHEMA_VERSION',26):
            with self.assertRaisesRegex(RegistryError,'compatible DGC version'):WorkspaceRegistry(self.registry.directory)

    def test_prepare_rolls_back_action_if_draft_update_fails(self):
        d=self.save();self.store.db.execute("CREATE TRIGGER fail_draft_prepare BEFORE UPDATE ON pip_message_drafts BEGIN SELECT RAISE(ABORT,'fixture failure');END")
        with self.assertRaises(sqlite3.IntegrityError):self.prepare(d)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
        self.assertEqual(drafts.get(self.store,d['id'])['status'],'pending')
    def test_reject_expiry_stale_and_untrusted_actor_cannot_prepare(self):
        d=self.save()
        for changes in [{'expected_digest':'f'*64},{'actor':'model-worker'}]:
            with self.assertRaises(RegistryError):self.prepare(d,**changes)
        dismissed=drafts.dismiss(self.store,d['id'],d['digest'],'editor-user');self.assertEqual(dismissed['status'],'dismissed')
        with self.assertRaises(RegistryError):self.prepare(d)
        fresh=self.save(key='c'*64);self.store.set_paused(self.source['id'],True,'local-console')
        with self.assertRaises(RegistryError):self.prepare(fresh)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
    def test_immutable_text_idempotency_and_history_scope(self):
        d=self.save();self.assertEqual(self.save(),d)
        with self.assertRaises(RegistryError):self.save(message={**self.message,'subject':'Changed'})
        with self.assertRaises(sqlite3.IntegrityError):self.store.db.execute("UPDATE pip_message_drafts SET payload='{}' WHERE id=?",(d['id'],))
        with self.assertRaises(sqlite3.IntegrityError):self.store.db.execute('DELETE FROM pip_message_drafts WHERE id=?',(d['id'],))
        page=drafts.history(self.store,self.source['id']);self.assertEqual(page['drafts'][0]['id'],d['id']);self.assertNotIn('body',json.dumps(page))
        with self.assertRaises(RegistryError):drafts.history(self.store,self.target['id'],before_id=d['id'])
    def reply(self,key='draft'):
        run=pip_chat.send(self.store,self.source['id'],'Draft an email to review@example.invalid with my walking plan.',key,'user',self.cfg)['run'];self.store.claim_next();return run
    def test_native_personal_chat_tool_is_inert_and_saved_after_success(self):
        from dgc.llm import LLMClient,ChatResult,ToolCall
        run=self.reply();calls=[]
        def chat(client,messages,tools=None,**kwargs):
            calls.append(1);self.assertEqual({t['function']['name'] for t in tools},{'draft_pip_change','draft_email','draft_calendar_event','list_connector_tools','draft_connector_action','offer_choices','skill'})
            self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_message_drafts').fetchone()[0],0)
            if len(calls)==1:return ChatResult(content='',tool_calls=[ToolCall('draft1','draft_email',self.message)])
            return ChatResult(content='Review the email draft below. Nothing has been sent.')
        with patch.dict(os.environ,{'DGC_SESSION_POLICY':pips._json(pips.native_policy(personal=True))}),patch.object(LLMClient,'chat',chat),patch('dgc.agent.discover_skills',return_value={}),patch('requests.sessions.Session.request',side_effect=AssertionError('No network')):
            result=pips.execute_native(self.cfg,self.root,run['manifest'],lambda event:None)
        self.assertEqual(result['message_draft'],self.message)
        self.store.finish(run['id'],result=result)
        saved=drafts.history(self.store,self.source['id'])['drafts'][0];self.assertEqual(saved['source_run_id'],run['id']);self.assertEqual(saved['status'],'pending')
        self.store.finish(run['id'],result=result);self.assertEqual(len(drafts.history(self.store,self.source['id'])['drafts']),1)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
        self.assertEqual(self.prepare(drafts.get(self.store,saved['id']))['status'],'pending')
    def test_cancellation_invalid_reply_and_late_job_change_never_save_a_draft(self):
        run=self.reply();self.store.cancel(run['id'],'user');self.store.finish(run['id'],result={'text':'Draft','message_draft':self.message})
        self.assertEqual(drafts.history(self.store,self.source['id'])['drafts'],[])
        run=self.reply('invalid')
        with self.assertRaises(RegistryError):self.store.finish(run['id'],result={'text':'','message_draft':self.message})
        self.assertEqual(self.store.run(run['id'])['status'],'running')
        self.store.set_paused(self.source['id'],True,'local-console');self.store.finish(run['id'],result={'text':'Draft','message_draft':self.message})
        self.assertEqual(drafts.history(self.store,self.source['id'])['drafts'],[])
    def test_legacy_and_project_manifest_cannot_inject_draft(self):
        # A Personal task drafts too now (an Always-allow grant may run it); an audit never does.
        for manifest in [{'run_kind':'conversation','source_policy':{'mode':'committed_only'},'email_draft':{'schema_version':1}},{'run_kind':'audit','source_policy':{'mode':'personal'},'email_draft':{'schema_version':1}}]:
            with self.assertRaises(RegistryError):drafts.validate_pin(manifest)
        self.assertFalse(drafts.validate_pin({'run_kind':'conversation'}))
        for message in [{**self.message,'account':'ca_other'},{**self.message,'bcc':['spy@example.test']},{**self.message,'subject':'Injected\r\nBcc: x@example.test'}]:
            with self.assertRaises(RegistryError):drafts.validate_message(message)

class MainEmailToolTests(unittest.TestCase):
    setUp=tool_fixtures.PersonalHandoffToolTests.setUp
    prepare=tool_fixtures.PersonalHandoffToolTests.prepare
    context=tool_fixtures.PersonalHandoffToolTests.context
    def propose(self,**changes):
        args={'scope':'personal','source_run_id':self.run['id'],'message':{'recipient_email':'review@example.invalid','subject':'Plan','body':'Walk for 30 minutes.'},'request_key':'once',**changes}
        with patch.object(tool,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=self.registry.clock)):
            return json.loads(tool.propose(args,self.context()))
    def test_main_tool_saves_draft_only_and_replays_exact_request(self):
        result=self.propose();self.assertFalse(result['send_authorized']);self.assertFalse(result['account_selected']);self.assertEqual(self.propose(),result)
        self.assertEqual(self.store.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
        with self.assertRaises(RegistryError):self.propose(account='ca_other')
    def test_scope_and_binding_are_checked_before_private_source(self):
        with self.assertRaises(RegistryError):self.propose(scope='project')
        other=self.base/'other';other.mkdir();foreign=self.registry.resolve(other)
        self.registry.db.execute("UPDATE session_workspaces SET binding_id=? WHERE session_id='chat-one'",(foreign['binding_id'],))
        with patch.object(pips.PipStore,'run',side_effect=AssertionError('No private read')):
            with self.assertRaises(RegistryError):self.propose()

class MainEmailAuthorityTests(unittest.TestCase):
    from tests.test_pip_handoff_tool import HandoffToolTests as _fixtures
    setUp=_fixtures.setUp
    git=_fixtures.git
    commit=_fixtures.commit
    setup_source=_fixtures.setup_source
    agent=_fixtures.agent
    def test_tool_is_hidden_and_refused_in_restricted_execution_contexts(self):
        from dgc.llm import ToolCall
        agent,approvals=self.agent()
        for kind in ('disabled','child','monitor','plan','restricted'):
            with self.subTest(kind=kind):
                self.cfg.data['pips_enabled']=kind!='disabled'
                agent.depth=1 if kind=='child' else 0
                agent._monitor_turn=kind=='monitor'
                self.cfg.data['mode']='plan' if kind=='plan' else 'auto'
                self.cfg.data['sandbox']=kind=='restricted'
                self.assertNotIn('draft_pip_email',{t['function']['name'] for t in agent._tool_schemas()})
                self.assertNotIn('draft_pip_calendar_event',{t['function']['name'] for t in agent._tool_schemas()})
                self.assertNotIn('draft_pip_connector_action',{t['function']['name'] for t in agent._tool_schemas()})
                with patch.object(tool,'propose',side_effect=AssertionError('No draft writes')):
                    self.assertTrue(agent._handle_call(ToolCall('draft-'+kind,'draft_pip_email',{})))
                    self.assertTrue(agent._handle_call(ToolCall('calendar-'+kind,'draft_pip_calendar_event',{})))
                    self.assertTrue(agent._handle_call(ToolCall('connector-'+kind,'draft_pip_connector_action',{})))
        self.assertEqual(approvals,[])
    def test_default_permission_asks_and_explicit_deny_wins(self):
        from dgc.permissions import PermissionEngine,ASK,DENY,DISPLAY
        self.assertEqual(DISPLAY['draft_pip_email'],'PipsEmailDraft')
        self.assertEqual(PermissionEngine('default',{},self.root).decide('draft_pip_email',{})[0],ASK)
        self.assertEqual(PermissionEngine('auto',{'allow':['*'],'deny':['PipsEmailDraft']},self.root).decide('draft_pip_email',{})[0],DENY)

    def test_calendar_permission_asks_and_deny_wins(self):
        from dgc.permissions import PermissionEngine,ASK,DENY,DISPLAY
        self.assertEqual(DISPLAY['draft_pip_calendar_event'],'PipsCalendarDraft')
        self.assertEqual(PermissionEngine('default',{},self.root).decide('draft_pip_calendar_event',{})[0],ASK)
        self.assertEqual(PermissionEngine('auto',{'allow':['*'],'deny':['PipsCalendarDraft']},self.root).decide('draft_pip_calendar_event',{})[0],DENY)
