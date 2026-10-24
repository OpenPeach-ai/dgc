import copy
import json
import threading
import unittest
from unittest.mock import patch
from pathlib import Path
from dgc import pip_app_access as apps
from dgc.workspace_registry import RegistryError
from test_pips_local import config

class Manager:
    def __init__(self):
        self._routes={'mcp__composio__GMAIL_FETCH_EMAILS':('composio','GMAIL_FETCH_EMAILS')}
        self.servers={'composio':object()};self.calls=[];self.closed=False
    def tool_schemas(self):
        return [{'function':{'name':'mcp__composio__GMAIL_FETCH_EMAILS','parameters':{'type':'object'}}}]
    def call(self,*args,**kwargs):self.calls.append(args);return '{"messages":[]}'
    def stop_all(self):self.closed=True

class AppAccessTests(unittest.TestCase):
    def setUp(self):
        self.cfg=config(Path('/tmp'),mcp_servers={'composio':{'transport':'remote','url':'https://connect.composio.dev/example'}})
        self.manager=Manager()
        self.plan={'schema_version':1,'server':'composio','connection_digest':apps.digest(self.cfg.get('mcp_servers')['composio']),
                   'calls':[{'tool':'GMAIL_FETCH_EMAILS','schema_digest':apps.digest({'type':'object'}),'arguments':{'query':'is:unread','max_results':5}}]}
        self.factory=lambda *a:self.manager
    def run_plan(self,**kwargs):
        return apps.execute(self.cfg,self.plan,authorize=lambda:None,manager_factory=self.factory,**kwargs)
    def test_reuses_connection_without_credentials_in_plan(self):
        result=self.run_plan()
        self.assertEqual(len(self.manager.calls),1)
        self.assertTrue(result[0]['untrusted'])
        self.assertTrue(self.manager.closed)
    def test_revoked_connection_denied_before_call(self):
        self.cfg.data['mcp_servers']={}
        with self.assertRaises(RegistryError):self.run_plan()
        self.assertEqual(self.manager.calls,[])
    def test_changed_endpoint_and_schema_denied(self):
        self.cfg.data['mcp_servers']['composio']['url']='https://connect.composio.dev/replaced'
        with self.assertRaises(RegistryError):self.run_plan()
        self.assertEqual(self.manager.calls,[])
        self.plan['connection_digest']=apps.digest(self.cfg.get('mcp_servers')['composio'])
        self.plan['calls'][0]['schema_digest']='a'*64
        with self.assertRaises(RegistryError):self.run_plan()
        self.assertTrue(self.manager.closed)
        self.assertEqual(self.manager.calls,[])
    def test_no_nested_execute_send_or_tool_management(self):
        for tool in ['COMPOSIO_MULTI_EXECUTE_TOOL','COMPOSIO_MANAGE_CONNECTIONS','GMAIL_SEND_EMAIL','execute','run_workflow']:
            bad=copy.deepcopy(self.plan);bad['calls'][0]['tool']=tool
            with self.assertRaises(RegistryError):apps.validate(bad)
    def test_unknown_plan_fields_and_oversize_refused(self):
        for bad in [{**self.plan,'allow_all':True},{**self.plan,'calls':self.plan['calls']*5},
                    {**self.plan,'calls':[dict(self.plan['calls'][0],arguments={'body':'x'*9000})]}]:
            with self.assertRaises(RegistryError):apps.validate(bad)
    def test_cancelled_and_revoked_grant_make_no_call(self):
        stop=threading.Event();stop.set()
        with self.assertRaises(RegistryError):self.run_plan(cancel=stop)
        def revoke():raise RegistryError('revoked','User withdrew approval')
        with self.assertRaises(RegistryError):apps.execute(self.cfg,self.plan,authorize=revoke,manager_factory=self.factory)
        self.assertEqual(self.manager.calls,[])
    def test_recheck_grant_between_calls(self):
        self.plan['calls']*=2;count=0
        def authorize():
            nonlocal count
            count+=1
            if count==3:raise RegistryError('revoked','Revoked between reads')
        with self.assertRaises(RegistryError):apps.execute(self.cfg,self.plan,authorize=authorize,manager_factory=self.factory)
        self.assertEqual(len(self.manager.calls),1)
    def test_provider_errors_and_oversize_are_not_success(self):
        for value in ['ERROR: token expired','x'*(apps.MAX_RESULT+1)]:
            with patch.object(self.manager,'call',return_value=value):
                with self.assertRaises(RegistryError):self.run_plan()
    def test_tool_inspection_never_reads_mail(self):
        found=apps.inspect(self.cfg,'composio',manager_factory=self.factory)
        self.assertEqual([v['tool'] for v in found['tools']],['GMAIL_FETCH_EMAILS'])
        self.assertEqual(self.manager.calls,[])
    def test_unknown_connector_is_explicitly_unsupported(self):
        self.cfg.data['mcp_servers']['composio']['url']='https://example.com/mcp'
        self.assertFalse(apps.connections(self.cfg)[0]['pip_read_adapter'])
        self.plan['connection_digest']=apps.digest(self.cfg.get('mcp_servers')['composio'])
        with self.assertRaises(RegistryError):self.run_plan()


class MetaManager(Manager):
    def __init__(self):
        super().__init__()
        self._routes={'execute':('composio','COMPOSIO_MULTI_EXECUTE_TOOL'),'schema':('composio','COMPOSIO_GET_TOOL_SCHEMAS')}
        self.executor={'properties':{'tools':{'items':{'properties':{'account':{'type':'string'}}}}}}
        self.input={'type':'object'}
    def tool_schemas(self):
        return [{'function':{'name':'execute','parameters':self.executor}},{'function':{'name':'schema','parameters':{'type':'object'}}}]
    def call(self,name,args,**kwargs):
        import json
        self.calls.append((name,args))
        if name=='schema':
            return json.dumps({'successful':True,'error':None,'data':{'tool_schemas':{tool:{'tool_slug':tool,'input_schema':self.input} for tool in apps.READ_ACTIONS}}})
        return json.dumps({'successful':True,'error':None,'data':{'success':True,'results':[{'successful':True,'response':{'messages':[]}}]}})

class MetaAppTests(unittest.TestCase):
    run_plan=AppAccessTests.run_plan
    def setUp(self):
        AppAccessTests.setUp(self);self.manager=MetaManager()
        self.plan['calls'][0].update(account='ca_test',schema_digest=apps.digest({'executor':self.manager.executor,'input':self.manager.input}))
    # Inherited direct-routing expectations belong to their own fixture.
    def test_meta_inspection_is_only_schema_discovery(self):
        result=apps.inspect(self.cfg,'composio',manager_factory=self.factory)
        self.assertEqual({v['tool'] for v in result['tools']},{'GMAIL_FETCH_EMAILS','GOOGLECALENDAR_FIND_EVENT'}) # other tools require their specific schema
        self.assertTrue(all(v['account_required'] for v in result['tools']))
        self.assertEqual([n for n,_ in self.manager.calls],['schema'])
    def test_explicit_account_exact_nested_tool_no_remote_workbench(self):
        result=self.run_plan()
        name,args=self.manager.calls[-1]
        self.assertEqual(name,'execute')
        self.assertEqual(args['tools'],[{'tool_slug':'GMAIL_FETCH_EMAILS','account':'ca_test','arguments':self.plan['calls'][0]['arguments']}])
        self.assertIs(args['sync_response_to_workbench'],False)
        self.assertTrue(result[0]['untrusted'])
    def test_second_missing_account_stops_all_reads(self):
        self.plan['calls'].append({k:v for k,v in self.plan['calls'][0].items() if k!='account'})
        with self.assertRaises(RegistryError):self.run_plan()
        self.assertEqual([n for n,_ in self.manager.calls],['schema'])
    def test_deadline_cancels_without_sleep(self):
        now=[0]
        def authorize():now[0]+=11
        with self.assertRaises(RegistryError):
            apps.execute(self.cfg,self.plan,authorize=authorize,manager_factory=self.factory,clock=lambda:now[0])
        self.assertTrue(self.manager.closed)
    def test_disk_revocation_after_discovery_stops_first_read(self):
        values=[self.cfg.get('mcp_servers'),{}]
        with self.assertRaises(RegistryError):
            apps.execute(self.cfg,self.plan,authorize=lambda:None,manager_factory=self.factory,servers_reader=lambda _:values.pop(0))
        self.assertEqual([n for n,_ in self.manager.calls],['schema'])
    def test_read_item_and_argument_limits(self):
        for args in ({'max_results':500},{'max_results':True},{'max_results':2,'tools':[]},{'max_results':2,'user_id':'other'}):
            bad=copy.deepcopy(self.plan);bad['calls'][0]['arguments']=args
            with self.assertRaises(RegistryError):apps.validate(bad)
    def test_provider_nested_failure_is_not_success(self):
        original=self.manager.call
        for response in ('{"successful":true,"error":null,"data":{}}',
                         '{"successful":true,"error":null,"data":{"success":true,"results":[{"successful":false}]}}'):
            with patch.object(self.manager,'call',side_effect=lambda n,a,**kw:original(n,a,**kw) if n=='schema' else response):
                with self.assertRaises(RegistryError):self.run_plan()


if __name__=='__main__':unittest.main()


class SavedServersTests(unittest.TestCase):
    """The controller rereads the user config before each app read or send."""

    def write(self, value):
        import tempfile
        from pathlib import Path
        directory = tempfile.TemporaryDirectory(prefix="dgc-saved-servers-")
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "config.json"
        path.write_text(json.dumps(value))
        patcher = patch("dgc.config.USER_CONFIG", path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_a_config_from_before_pips_existed_is_on_by_default(self):
        servers = {"composio": {"transport": "remote", "url": "https://connect.composio.dev/x"}}
        self.write({"model": "fixture", "mcp_servers": servers})
        self.assertEqual(apps.saved_servers(None), servers)

    def test_an_explicit_off_still_refuses(self):
        self.write({"pips_enabled": False, "mcp_servers": {}})
        with self.assertRaises(RegistryError) as raised:
            apps.saved_servers(None)
        self.assertEqual(raised.exception.code, "connection_unavailable")
