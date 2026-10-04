"""Offline connector reviews; fixtures describe contracts, not live provider tests."""
import copy
import json
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_connector_actions as adapter, pip_app_actions as actions, pip_app_access as apps, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from dgc import workspace_registry
from tests import test_pip_personal_handoffs as fixtures
from tests.test_app_connectors import spec


class Manager:
    def __init__(self, name):
        self.name = name
        self.servers = {name: SimpleNamespace(tools=[{'name': 'run_selected_workflow', 'description': 'Run the selected workflow.',
            'inputSchema': {'type': 'object', 'properties': {'workflow_id': {'type': 'string'}}, 'required': ['workflow_id']},
            'annotations': {'readOnlyHint': True}}])}
        self._routes = {'call': (name, 'run_selected_workflow')}
        self._context_routes = {}
        self.calls = []; self.closed = False; self.response = '{"execution_id":"demo-123","status":"running"}'
    def call(self, name, arguments, **kw):
        self.calls.append((name, copy.deepcopy(arguments)))
        if isinstance(self.response, BaseException): raise self.response
        return self.response
    def stop_all(self): self.closed = True


class ConnectorActionTests(unittest.TestCase):
    def setUp(self):
        fixtures.PersonalHandoffTests.setUp(self)
        fixtures.PersonalHandoffTests.prepare(self)
        self.cfg.data['mcp_servers'] = {name: spec(name) for name in adapter.PROVIDERS}
        self.manager = Manager('make'); self.factory = lambda *a: self.manager
        self.inspection = adapter.inspect(self.cfg, 'make', manager_factory=self.factory, clock=lambda: 0)
        self.call = {'tool': 'run_selected_workflow', 'arguments': {'workflow_id': 'reviewed-workflow'}}
    def propose(self, **changes):
        args = dict(source_run_id=self.run['id'], server='make', connection_digest=self.inspection['connection_digest'],
            account='connection_managed', schema_digest=self.inspection['tools'][0]['schema_digest'], message=self.call,
            request_key='one', actor='local-console', config=self.cfg, kind='connector_call')
        args.update(changes)
        return actions.propose(self.store, **args)
    def prepare(self, config, payload, authorize):
        return adapter.prepared(config, payload, authorize, manager_factory=self.factory,
            servers_reader=lambda c: c.get('mcp_servers'), clock=lambda: 0)
    def accept(self, saved):
        return actions.accept(self.store, saved['id'], saved['digest'], 'local-console', self.cfg, prepare=self.prepare)
    def test_all_four_reuse_saved_specs_and_metadata_inspection_never_calls_tools(self):
        for name in adapter.PROVIDERS:
            manager = Manager(name)
            answer = adapter.inspect(self.cfg, name, manager_factory=lambda *a: manager, clock=lambda: 0)
            self.assertEqual(answer['provider'], adapter.PROVIDERS[name])
            self.assertEqual(answer['account_binding'], 'connection_managed')
            self.assertEqual(manager.calls, []); self.assertTrue(manager.closed)
            self.assertNotIn('_route', answer['tools'][0])
        self.assertTrue(all(c['pip_action_adapter'] for c in apps.connections(self.cfg)))
        self.assertTrue(all(not c['pip_read_adapter'] for c in apps.connections(self.cfg)))
    def test_each_provider_dispatches_its_pinned_direct_route_only(self):
        for name in adapter.PROVIDERS:
            self.manager = Manager(name)
            inspection = adapter.inspect(self.cfg, name, manager_factory=self.factory, clock=lambda:0)
            saved = self.propose(server=name,connection_digest=inspection['connection_digest'],schema_digest=inspection['tools'][0]['schema_digest'],request_key=name)
            reply = self.accept(saved)
            self.assertEqual(reply['receipt']['provider'],adapter.PROVIDERS[name])
            self.assertEqual(self.manager.calls,[('call',self.call['arguments'])])
            self.assertEqual(self.accept(saved),reply)

    def test_credential_in_metadata_or_response_is_not_persisted(self):
        secret='fixture-token-that-is-never-a-real-secret'
        with patch('dgc.redaction.secret_values',return_value=[secret]):
            self.manager.servers['make'].tools[0]['description']=secret
            with self.assertRaises(RegistryError):adapter.inspect(self.cfg,'make',manager_factory=self.factory,clock=lambda:0)
            self.manager=Manager('make');saved=self.propose();self.manager.response=secret
            result=self.accept(saved)
            self.assertEqual(result['status'],'unknown');self.assertNotIn(secret,json.dumps(result))

    def test_save_is_inert_idempotent_and_read_hint_does_not_grant_recurring_access(self):
        saved = self.propose()
        self.assertEqual(saved['status'], 'pending'); self.assertEqual(saved, self.propose())
        self.assertEqual(self.manager.calls, [])
        self.assertIsNone(self.store.get(self.source['id']).get('app_plan'))
        with self.assertRaises(RegistryError):
            apps.validate({'schema_version': 1, 'server': 'make', 'connection_digest': saved['payload']['connection_digest'],
                'calls': [{'tool': self.call['tool'], 'arguments': self.call['arguments'], 'schema_digest': saved['payload']['schema_digest']}]})
    def test_exact_single_attempt_and_receipt_does_not_claim_workflow_finished(self):
        saved = self.propose(); result = self.accept(saved)
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['receipt']['meaning'], adapter.MEANING)
        self.assertIn('running', result['receipt']['response_preview'])
        self.assertEqual(self.accept(saved), result)
        self.assertEqual(self.manager.calls, [('call', self.call['arguments'])])
        self.assertTrue(self.manager.closed)
        history = actions.history(self.store, self.source['id'])['actions'][0]
        self.assertEqual(history['subject'], self.call['tool'])
        self.assertEqual(history['recipient'], 'Connection-managed account')
    def test_timeout_error_oversize_empty_or_crash_never_retried(self):
        for i, response in enumerate([TimeoutError('private'), 'ERROR: private', '{"isError":true}', '', 'x'*32769, SystemExit('crash')]):
            self.manager = Manager('make'); self.manager.response = response
            saved = self.propose(request_key='attempt'+str(i))
            if isinstance(response, SystemExit):
                with self.assertRaises(SystemExit): self.accept(saved)
                expected = 'dispatching'
            else:
                self.assertEqual(self.accept(saved)['status'], 'unknown'); expected = 'unknown'
            self.assertEqual(self.accept(saved)['status'], expected)
            self.assertEqual(len(self.manager.calls), 1); self.assertTrue(self.manager.closed)
            self.assertNotIn('private', json.dumps(actions.get(self.store, saved['id'])))
    def test_changes_to_description_schema_annotations_or_connection_fail_before_claim(self):
        for field, value in [('description','Different behavior'), ('inputSchema',{'type':'object'}), ('annotations',{'readOnlyHint':False})]:
            self.manager = Manager('make')
            saved = self.propose(request_key=field)
            self.manager.servers['make'].tools[0][field] = value
            with self.assertRaises(RegistryError): self.accept(saved)
            self.assertEqual(actions.get(self.store,saved['id'])['status'],'pending'); self.assertEqual(self.manager.calls,[])
        self.manager = Manager('make'); saved = self.propose(request_key='removed')
        self.cfg.data['mcp_servers']['make']['enabled'] = False
        with self.assertRaises(RegistryError): self.accept(saved)
        self.assertEqual(self.manager.calls, [])
    def test_saved_revocation_deadline_and_pause_fail_closed(self):
        saved = self.propose()
        with self.assertRaises(RegistryError):
            with adapter.prepared(self.cfg,saved['payload'],lambda:None,manager_factory=self.factory,servers_reader=lambda c:{},clock=lambda:0): pass
        ticks=iter([0,31])
        with self.assertRaises(RegistryError):
            with adapter.prepared(self.cfg,saved['payload'],lambda:None,manager_factory=self.factory,servers_reader=lambda c:c.get('mcp_servers'),clock=lambda:next(ticks)): pass
        self.store.set_paused(self.source['id'],True,'local-console')
        with self.assertRaises(RegistryError): self.accept(saved)
        self.assertEqual(self.manager.calls, [])
    def test_wrong_identity_actor_digest_or_modified_retry_key_refused(self):
        saved=self.propose()
        for actor in ('model','remote-device'):
            with self.assertRaises(RegistryError): self.propose(actor=actor)
            with self.assertRaises(RegistryError): actions.accept(self.store,saved['id'],saved['digest'],actor,self.cfg,prepare=self.prepare)
        with self.assertRaises(RegistryError): actions.accept(self.store,saved['id'],'0'*64,'local-console',self.cfg,prepare=self.prepare)
        with self.assertRaises(RegistryError): self.propose(message={**self.call,'arguments':{'workflow_id':'other'}})
        with self.assertRaises(RegistryError): self.propose(account='ca_fabricated')
        self.assertEqual(self.manager.calls, [])
    def test_catalog_limits_duplicates_and_synthetic_routes_refused(self):
        for mode in ('duplicate','oversize','name','schema','synthetic'):
            self.manager=Manager('make'); row=self.manager.servers['make'].tools[0]
            if mode=='duplicate':self.manager.servers['make'].tools.append(copy.deepcopy(row))
            if mode=='oversize':row['description']='x'*8001
            if mode=='name':row['name']='bad\nname'
            if mode=='schema':row['inputSchema']={}
            if mode=='synthetic':self.manager._context_routes={'call':('make',row['name'])}
            with self.subTest(mode=mode), self.assertRaises(RegistryError):
                adapter.inspect(self.cfg,'make',manager_factory=self.factory,clock=lambda:0)
            self.assertTrue(self.manager.closed);self.assertEqual(self.manager.calls,[])
    def test_controller_routing_local_only_and_no_execution_on_prepare(self):
        request={'type':'propose_pip_connector_action','request_id':'test','source_run_id':self.run['id'],
            'server':'make','connection_digest':self.inspection['connection_digest'],
            'schema_digest':self.inspection['tools'][0]['schema_digest'],'call':self.call,'request_key':'control'}
        with patch.object(pips,'WorkspaceRegistry',lambda:WorkspaceRegistry(self.registry.directory,clock=lambda:self.now)):
            for actor in ('model','remote-device'):
                reply=pips.handle_control(self.cfg,request,actor,start_worker=False)
                self.assertFalse(reply['ok']);self.assertEqual(reply['error']['code'],'local_only')
            reply=pips.handle_control(self.cfg,request,'editor-user',start_worker=False)
            self.assertTrue(reply['ok'],reply);self.assertEqual(reply['result']['action']['payload']['call'],self.call)
        self.assertEqual(self.manager.calls,[])
    def test_schema29_upgrade_preserves_ledger_and_older_reader_refuses(self):
        saved=self.propose();self.store.db.execute('DROP TABLE pip_connector_drafts');self.store.db.execute('PRAGMA user_version=29')
        before=[tuple(r) for r in self.store.db.execute('SELECT * FROM pip_app_actions')]
        with WorkspaceRegistry(self.registry.directory) as reg:
            self.assertEqual(reg.db.execute('PRAGMA user_version').fetchone()[0],workspace_registry.SCHEMA_VERSION)
            self.assertEqual([tuple(r) for r in reg.db.execute('SELECT * FROM pip_app_actions')],before)
        with patch('dgc.workspace_registry.SCHEMA_VERSION',29),self.assertRaises(RegistryError):WorkspaceRegistry(self.registry.directory)
    def test_concurrent_reviews_share_one_claim(self):
        saved=self.propose();entered=threading.Event();release=threading.Event();failures=[]
        from contextlib import contextmanager
        @contextmanager
        def prepare(config,payload,authorize):
            def run():
                entered.set()
                if not release.wait(5):raise RuntimeError('test barrier')
                return adapter.result('{"status":"started"}',config,'make',self.call['tool'])
            yield run
        def first():
            try:
                with WorkspaceRegistry(self.registry.directory,clock=lambda:self.now) as reg:
                    actions.accept(pips.PipStore(reg),saved['id'],saved['digest'],'local-console',self.cfg,prepare=prepare)
            except BaseException as exc:failures.append(exc)
        thread=threading.Thread(target=first);thread.start()
        try:
            self.assertTrue(entered.wait(5))
            self.assertEqual(self.accept(saved)['status'],'dispatching')
            self.assertEqual(self.manager.calls,[])
        finally:release.set();thread.join(5)
        self.assertFalse(thread.is_alive());self.assertEqual(failures,[])
