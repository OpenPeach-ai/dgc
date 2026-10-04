"""Deterministic offline message reviews; never contacts an email provider."""
import copy
import json
import sqlite3
import threading
import unittest
from contextlib import contextmanager
from unittest.mock import patch

from dgc import pip_app_actions as actions, pip_app_sends as sends, pip_app_access as apps, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_personal_handoffs as fixtures
from tests.pip_test_migrations import drop_digest_schema


def schema(properties):
    return {'type':'object','properties':{k:{'type':v} for k,v in properties.items()},'required':list(properties)}


class Manager:
    def __init__(self):
        self._routes={'execute':('composio','COMPOSIO_MULTI_EXECUTE_TOOL'),'schema':('composio','COMPOSIO_GET_TOOL_SCHEMAS')}
        self.executor=schema({'tools':'array','sync_response_to_workbench':'boolean','current_step':'string'})
        self.executor['properties']['tools']['items']=schema({'tool_slug':'string','account':'string','arguments':'object'})
        self.lookup=schema({'tool_slugs':'array','include':'array'})
        self.input=schema({k:('boolean' if k=='is_html' else 'array' if k in ('cc','bcc','extra_recipients') else 'string') for k in sends.ARGS})
        self.calls=[];self.closed=False;self.send_error=None;self.send_result=None
    def tool_schemas(self):
        return [{'function':{'name':'execute','parameters':self.executor}},{'function':{'name':'schema','parameters':self.lookup}}]
    def call(self,name,args,**kwargs):
        self.calls.append((name,copy.deepcopy(args)))
        if name=='schema':
            return json.dumps({'successful':True,'error':None,'data':{'tool_schemas':{sends.TOOL:{'tool_slug':sends.TOOL,'input_schema':self.input}}}})
        if self.send_error:raise self.send_error
        if self.send_result is not None:return self.send_result
        return json.dumps({'successful':True,'error':None,'data':{'success':True,'results':[{'tool_slug':sends.TOOL,'response':{'successful':True,'error':None,'data':{'id':'gmail_123'}}}]}})
    def stop_all(self):self.closed=True


class AppActionTests(unittest.TestCase):
    prepare_source=fixtures.PersonalHandoffTests.prepare
    def setUp(self):
        fixtures.PersonalHandoffTests.setUp(self);self.prepare_source()
        self.cfg.data['mcp_servers']={'composio':{'transport':'remote','url':'https://connect.composio.dev/test'}}
        self.manager=Manager();self.factory=lambda *a:self.manager
        self.inspection=sends.inspect(self.cfg,'composio',manager_factory=self.factory,clock=lambda:0)
        self.manager.calls.clear();self.manager.closed=False
        self.message={'recipient_email':'review@example.invalid','subject':'Weekend plan','body':'Walk for 30 minutes. Read for 45 minutes.'}
    def propose(self,**changes):
        args=dict(source_run_id=self.run['id'],server='composio',connection_digest=self.inspection['connection_digest'],
                  account='ca_test',schema_digest=self.inspection['schema_digest'],message=self.message,request_key='one',actor='local-console',config=self.cfg)
        args.update(changes);return actions.propose(self.store,**args)
    def prepare(self,config,payload,authorize):
        return sends.prepared(config,payload,authorize,manager_factory=self.factory,servers_reader=lambda c:c.get('mcp_servers'),clock=lambda:0)
    def accept(self,action,**kw):
        return actions.accept(self.store,action['id'],action['digest'],'local-console',self.cfg,prepare=kw.get('prepare',self.prepare))
    def sends(self):return [args for name,args in self.manager.calls if name=='execute']


    def test_schema25_upgrade_preserves_history_and_rolls_back_failed_ddl(self):
        from dgc import workspace_registry as schema
        from dgc.pips import PipStore
        db=self.registry.db
        db.execute('DROP TABLE pip_connector_drafts');db.execute('DROP TABLE pip_calendar_drafts');db.execute('DROP TABLE pip_message_drafts');db.execute('DROP TABLE pip_app_actions');drop_digest_schema(db);db.execute('PRAGMA user_version=25')
        before=[tuple(r) for r in db.execute('SELECT * FROM pip_runs ORDER BY id')]
        original=schema._execute_schema
        def fail_after(db,sql):
            original(db,sql)
            if sql==actions.SCHEMA:raise RuntimeError('injected migration failure')
        with patch.object(schema,'_execute_schema',side_effect=fail_after):
            with self.assertRaisesRegex(RuntimeError,'injected'):WorkspaceRegistry(self.registry.directory)
        self.assertEqual(db.execute('PRAGMA user_version').fetchone()[0],25)
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='pip_app_actions'").fetchone())
        self.assertEqual([tuple(r) for r in db.execute('SELECT * FROM pip_runs ORDER BY id')],before)
        with WorkspaceRegistry(self.registry.directory) as upgraded:
            self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0],schema.SCHEMA_VERSION)
            self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_app_actions').fetchone()[0],0)
            self.assertEqual([tuple(r) for r in upgraded.db.execute('SELECT * FROM pip_runs ORDER BY id')],before)
        with patch.object(schema,'SCHEMA_VERSION',25),patch.object(PipStore,'_job',side_effect=AssertionError('old reader')):
            with self.assertRaisesRegex(RegistryError,'compatible DGC version'):WorkspaceRegistry(self.registry.directory)

    def test_proposal_is_local_only_and_does_not_send_or_modify_job(self):
        saved=self.propose()
        self.assertEqual(saved['status'],'pending');self.assertEqual(self.manager.calls,[])
        self.assertEqual(saved['payload']['message'],self.message)
        self.assertEqual(self.store.get(self.source['id'])['current_version'],1)
        self.assertEqual(self.store.runs(self.target['id']),[])
        self.assertEqual(saved,self.propose())
        with self.assertRaises(RegistryError):self.propose(message={**self.message,'body':'Changed'})

    def test_approval_sends_exact_message_once_and_persists_receipt(self):
        saved=self.propose();result=self.accept(saved)
        self.assertEqual(result['status'],'succeeded');self.assertEqual(result['receipt']['message_id'],'gmail_123')
        self.assertEqual(len(self.sends()),1)
        sent=self.sends()[0];self.assertEqual(sent['tools'],[{'tool_slug':sends.TOOL,'account':'ca_test','arguments':sends.arguments(self.message)}])
        self.assertFalse(sent['sync_response_to_workbench']);self.assertTrue(self.manager.closed)
        with patch.object(sends,'route',side_effect=AssertionError('Retry cannot reconnect')):
            self.assertEqual(self.accept(saved),result)

    def test_timeout_and_malformed_success_are_unknown_never_retried(self):
        for i,response in enumerate([TimeoutError('private body leaked by server'),'garbage',json.dumps({'successful':True,'data':{}})]):
            self.manager=Manager();self.factory=lambda *a:self.manager
            saved=self.propose(request_key='unknown'+str(i))
            if isinstance(response,Exception):self.manager.send_error=response
            else:self.manager.send_result=response
            result=self.accept(saved)
            self.assertEqual(result['status'],'unknown');self.assertTrue(result['delivery_unconfirmed'])
            self.assertNotIn('private body leaked',json.dumps(result))
            self.assertEqual(self.accept(saved),result);self.assertEqual(len(self.sends()),1)

    def test_controller_crash_after_claim_consumes_attempt(self):
        saved=self.propose();self.manager.send_error=SystemExit('simulated crash')
        with self.assertRaises(SystemExit):self.accept(saved)
        result=actions.get(self.store,saved['id'])
        self.assertEqual(result['status'],'dispatching');self.assertTrue(result['delivery_unconfirmed'])
        self.assertEqual(self.accept(saved),result);self.assertEqual(len(self.sends()),1)

    def test_wrong_digest_rejection_and_expiry_never_send(self):
        saved=self.propose()
        with self.assertRaises(RegistryError):actions.accept(self.store,saved['id'],'f'*64,'local-console',self.cfg,prepare=self.prepare)
        actions.reject(self.store,saved['id'],saved['digest'],'local-console')
        with self.assertRaises(RegistryError):self.accept(saved)
        saved=self.propose(request_key='expired');self.now='2026-10-06T06:00:00.000Z'
        with self.assertRaises(RegistryError):self.accept(saved)
        self.assertEqual(actions.get(self.store,saved['id'])['status'],'expired');self.assertEqual(self.sends(),[])

    def test_job_lifecycle_and_emergency_stop_invalidate_authority(self):
        saved=self.propose();self.store.set_paused(self.source['id'],True,'local-console')
        with self.assertRaises(RegistryError):self.accept(saved)
        self.store.set_paused(self.source['id'],False,'local-console')
        with self.assertRaises(RegistryError):self.accept(saved)
        self.assertEqual(self.sends(),[])
        fresh=self.propose(request_key='fresh')
        from dgc.pip_daemon import _set_paused
        _set_paused(self.registry,True,'local-console')
        with self.assertRaises(RegistryError):self.accept(fresh)
        _set_paused(self.registry,False,'local-console')
        change=self.store.propose(self.source['id'],1,{'goal':'New job'},'local-console')
        self.store.accept(self.source['id'],change['id'],1,'local-console')
        with self.assertRaises(RegistryError):self.accept(fresh)
        self.assertEqual(self.sends(),[])

    def test_changed_connection_saved_revocation_or_schema_refuse_before_attempt(self):
        saved=self.propose();spec=copy.deepcopy(self.cfg.data['mcp_servers']['composio'])
        self.cfg.data['mcp_servers']['composio']['url']='https://connect.composio.dev/replaced'
        with self.assertRaises(RegistryError):self.accept(saved)
        self.cfg.data['mcp_servers']['composio']=spec
        def revoked(c,p,a):return sends.prepared(c,p,a,manager_factory=self.factory,servers_reader=lambda c:{},clock=lambda:0)
        with self.assertRaises(RegistryError):self.accept(saved,prepare=revoked)
        self.manager.input['description']='Changed provider contract'
        with self.assertRaises(RegistryError):self.accept(saved)
        self.assertEqual(actions.get(self.store,saved['id'])['status'],'pending');self.assertEqual(self.sends(),[])

    def test_reject_while_discovering_blocks_send(self):
        saved=self.propose();original=self.manager.call
        def call(name,args,**kw):
            answer=original(name,args,**kw)
            if name=='schema':actions.reject(self.store,saved['id'],saved['digest'],'local-console')
            return answer
        with patch.object(self.manager,'call',call),self.assertRaises(RegistryError):self.accept(saved)
        self.assertEqual(self.sends(),[])

    def test_two_approvers_only_one_provider_call(self):
        saved=self.propose();barrier=threading.Barrier(2);calls=[];errors=[];outcomes=[];lock=threading.Lock()
        @contextmanager
        def prepare(c,p,a):
            barrier.wait(timeout=5)
            def send():
                with lock:calls.append('sent')
                return {'provider':'Gmail','message_id':'once','meaning':sends.ACCEPTED}
            yield send
        def approve():
            try:
                with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as registry:
                    outcomes.append(actions.accept(pips.PipStore(registry),saved['id'],saved['digest'],'editor-user',self.cfg,prepare=prepare)['status'])
            except BaseException as e:errors.append(e)
        threads=[threading.Thread(target=approve) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join(timeout=10)
        self.assertFalse(any(t.is_alive() for t in threads));self.assertEqual(errors,[])
        self.assertEqual(calls,['sent']);self.assertEqual(len(outcomes),2)

    def test_ledger_immutable_and_retained(self):
        saved=self.propose()
        for sql in ['UPDATE pip_app_actions SET payload=\'{}\' WHERE id=?','DELETE FROM pip_app_actions WHERE id=?',
                    "UPDATE pip_app_actions SET status='succeeded' WHERE id=?"]:
            with self.assertRaises(sqlite3.IntegrityError):self.store.db.execute(sql,(saved['id'],))
        self.assertEqual(actions.get(self.store,saved['id'])['digest'],saved['digest'])

    def test_unknown_fields_headers_hidden_recipients_and_budgets_refused(self):
        cases=[{**self.message,'bcc':['hidden@example.invalid']},{**self.message,'attachment':{}},
               {**self.message,'recipient_email':'a@example.invalid\r\nBcc: hidden@example.invalid'},
               {**self.message,'subject':'Hello\u202einvalid'},{**self.message,'body':'界'*4001},
               {**self.message,'body':'x'*12001},{**self.message,'body':'\ud800'}]
        for message in cases:
            with self.subTest(keys=list(message)),self.assertRaises(RegistryError):self.propose(message=message)
        for changes in [{'account':'default'},{'schema_digest':'bad'},{'actor':'remote-device'},{'actor':'model'},
                        {'source_run_id':'run_'+'0'*32}]:
            with self.assertRaises(RegistryError):self.propose(**changes)
        self.assertEqual(self.manager.calls,[])

    def test_pending_review_blocks_archive_but_rejected_does_not(self):
        from dgc.pip_archive import _require_idle
        saved=self.propose()
        with self.assertRaisesRegex(RegistryError,'message reviews'):_require_idle(self.store,self.source['id'],self.now)
        actions.reject(self.store,saved['id'],saved['digest'],'local-console')
        _require_idle(self.store,self.source['id'],self.now)

    def test_history_is_bounded_summary_and_cross_pip_cursor_refused(self):
        saved=self.propose();self.propose(request_key='two')
        first=actions.history(self.store,self.source['id'],limit=1)
        self.assertIsNotNone(first['next_cursor']);self.assertNotIn('payload',first['actions'][0])
        second=actions.history(self.store,self.source['id'],before_id=first['next_cursor'],limit=1)
        self.assertEqual(len(second['actions']),1);self.assertNotEqual(first['actions'][0]['id'],second['actions'][0]['id'])
        with self.assertRaises(RegistryError):actions.history(self.store,self.target['id'],before_id=saved['id'])

    def test_controller_remote_denied_before_connection_and_preserves_exact_payload(self):
        fields={k:self.inspection[k] for k in ('server','connection_digest','schema_digest')}
        request={'type':'propose_pip_app_action','request_id':'test',**fields,'source_run_id':self.run['id'],'account':'ca_test','message':self.message,'request_key':'controller'}
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)):
            for actor in ('model','remote-device'):
                result=pips.handle_control(self.cfg,request,actor,start_worker=False)
                self.assertFalse(result['ok']);self.assertEqual(result['error']['code'],'local_only')
            result=pips.handle_control(self.cfg,request,'editor-user',start_worker=False)
            self.assertTrue(result['ok'],result);self.assertEqual(result['result']['action']['payload']['message'],self.message)

    def test_discovery_is_metadata_only_and_unsupported_contracts_fail_closed(self):
        found=sends.inspect(self.cfg,'composio',manager_factory=self.factory,clock=lambda:0)
        self.assertEqual(found['tool'],sends.TOOL);self.assertEqual(self.sends(),[])
        self.manager.executor['properties']['tools']['items']['properties'].pop('account')
        with self.assertRaises(RegistryError):sends.inspect(self.cfg,'composio',manager_factory=self.factory,clock=lambda:0)
        self.assertTrue(self.manager.closed)


if __name__=='__main__':unittest.main()
