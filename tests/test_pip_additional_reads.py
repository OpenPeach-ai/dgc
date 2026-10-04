"""Offline contracts from public metadata; not live connected-account verification."""
import copy
import json
import unittest
from pathlib import Path
from dgc import pip_app_access as apps, pip_app_read_adapters as reads
from dgc.workspace_registry import RegistryError
from tests.test_pip_app_access import MetaManager
from tests.test_pips_local import config

CONTRACTS=json.loads((Path(__file__).parent/'fixtures/composio-additional-reads-20261004.json').read_text())
DATA={
 reads.DRIVE:{'files':[{'id':'file1','name':'Budget','mimeType':'text/plain','webViewLink':'https://example.invalid/file','owners':['private'],'description':'do not forward'}],'nextPageToken':'unfollowed'},
 reads.NOTION:{'results':[{'id':'page1','object':'page','url':'https://example.invalid/page','properties':{'Name':{'type':'title','title':[{'plain_text':'Reading'}]},'Secret':{'type':'rich_text','rich_text':'private'}}}],'has_more':True,'next_cursor':'unfollowed'},
 reads.CONTACTS:{'results':[{'person':{'resourceName':'people/c1','names':[{'displayName':'Alex'}],'emailAddresses':[{'value':'alex@example.invalid'}],'phoneNumbers':[{'value':'private'}]}}]}}

class Manager(MetaManager):
    def __init__(self):
        super().__init__();self.contracts=copy.deepcopy(CONTRACTS);self.data=copy.deepcopy(DATA)
        self.after=lambda:None;self.result_mutator=lambda result:None
    def call(self,name,args,**kw):
        self.calls.append((name,copy.deepcopy(args)))
        if name=='schema':return json.dumps({'successful':True,'data':{'tool_schemas':self.contracts}})
        tool=args['tools'][0]['tool_slug']
        value={'successful':True,'data':{'success':True,'results':[{'tool_slug':tool,'response':{'successful':True,'data':self.data[tool]}}]}}
        self.result_mutator(value);self.after();return json.dumps(value)

class AdditionalReadsTests(unittest.TestCase):
    def setUp(self):
        self.manager=Manager();self.cfg=config(Path('/tmp'),mcp_servers={'composio':{'transport':'remote','url':'https://connect.composio.dev/test'}})
        self.factory=lambda *a:self.manager
    def plan(self,tools=(reads.DRIVE,)):
        return {'schema_version':3,'server':'composio','connection_digest':apps.digest(self.cfg.get('mcp_servers')['composio']),
          'calls':[{'tool':tool,'schema_digest':apps.digest({'executor':self.manager.executor,'input':self.manager.contracts[tool]['input_schema']}),
              'account':'ca_reviewed','arguments':copy.deepcopy(reads.DESCRIPTORS[tool]['example'])} for tool in tools]}
    def run_plan(self,plan=None,**kw):return apps.execute(self.cfg,plan or self.plan(),authorize=lambda:None,manager_factory=self.factory,**kw)
    def test_inspection_only_metadata_with_actual_schema_contracts(self):
        result=apps.inspect(self.cfg,'composio',manager_factory=self.factory)
        self.assertEqual({t['tool'] for t in result['tools']},reads.TOOLS)
        self.assertTrue(all(t['account_required'] and t['minimum_api']==39 and t['plan_version']==3 for t in result['tools']))
        self.assertEqual([c[0] for c in self.manager.calls],['schema']);self.assertTrue(self.manager.closed)
    def test_three_reads_project_only_reviewed_fields(self):
        rows=self.run_plan(self.plan(sorted(reads.TOOLS)))
        self.assertEqual(len(rows),3);self.assertTrue(all(r['untrusted'] for r in rows))
        blob=json.dumps(rows)
        for forbidden in ['private','owners','phoneNumbers','unfollowed','do not forward']:self.assertNotIn(forbidden,blob)
        self.assertIn('Budget',blob);self.assertIn('Reading',blob);self.assertIn('alex@example.invalid',blob)
        for name,args in self.manager.calls[1:]:
            self.assertEqual(name,'execute');self.assertEqual(args['tools'][0]['account'],'ca_reviewed')
            self.assertFalse(args['sync_response_to_workbench'])
        self.assertEqual(len(self.manager.calls),4) # no pagination or linked content
    def test_old_version_missing_account_or_window_rejected_before_discovery(self):
        for mutate in [lambda p:p.update(schema_version=2),lambda p:p['calls'][0].pop('account'),lambda p:p['calls'][0].update(window={})]:
            p=self.plan();mutate(p)
            with self.assertRaises(RegistryError):self.run_plan(p)
        self.assertEqual(self.manager.calls,[])
    def test_queries_limits_and_expansion_flags_fail_closed(self):
        for tool in reads.TOOLS:
            spec=reads.DESCRIPTORS[tool]
            for key,value in [(spec['query'],''),(spec['query'],'x\u202ey'),(spec['query'],'é'*513),(spec['limit'],True),(spec['limit'],21),('pageToken','next'),('download',True)]:
                args=copy.deepcopy(spec['example']);args[key]=value
                with self.subTest(tool=tool,key=key),self.assertRaises(RegistryError):reads.validate(tool,args)
            args=copy.deepcopy(spec['example']);key=next(k for k in args if k not in (spec['query'],spec['limit']));args[key]='broader'
            with self.assertRaises(RegistryError):reads.validate(tool,args)
    def test_malformed_input_schema_is_unavailable_not_crash(self):
        for schema in [None,[],{'type':'object','required':[{}]}, {'type':'object','properties':None}]:
            for tool in reads.TOOLS:self.assertFalse(reads.schema_supported(tool,schema))
        schema=copy.deepcopy(CONTRACTS[reads.CONTACTS]['input_schema']);schema['properties']['sources']['items']=None
        self.assertFalse(reads.schema_supported(reads.CONTACTS,schema))
    def test_all_routes_checked_before_first_read(self):
        plan=self.plan([reads.DRIVE,reads.NOTION]);plan['calls'][1]['schema_digest']='0'*64
        with self.assertRaises(RegistryError):self.run_plan(plan)
        self.assertEqual([c[0] for c in self.manager.calls],['schema'])
    def test_direct_routes_cannot_bypass_account_enforcement(self):
        self.manager._routes={'execute':('composio',reads.DRIVE)}
        with self.assertRaises(RegistryError):self.run_plan()
        self.assertEqual(self.manager.calls,[])
    def test_result_identity_success_and_shape_must_match(self):
        changes=[lambda r:r['data']['results'][0].update(tool_slug=reads.NOTION),
                 lambda r:r['data']['results'][0]['response'].update(successful=False),
                 lambda r:r['data']['results'][0]['response'].update(data={}),
                 lambda r:r['data']['results'][0]['response'].update(data={'files':[{'id':'file1'}]}),
                 lambda r:r['data']['results'].append(r['data']['results'][0])]
        for change in changes:
            self.manager.result_mutator=change
            with self.assertRaises(RegistryError):self.run_plan()
        self.assertTrue(self.manager.closed)
    def test_projection_types_counts_and_bounded_text(self):
        for tool in reads.TOOLS:
            args=reads.DESCRIPTORS[tool]['example'];key='files' if tool==reads.DRIVE else 'results'
            for value in [None,{}, {key:None},{key:[None]}, {key:DATA[tool][key]*21}]:
                with self.subTest(tool=tool,value=value),self.assertRaises(RegistryError):reads.project(tool,value,args)
        for data in [{'files':[],'nextPageToken':{}},{'files':[],'incompleteSearch':'false'},{'files':[{'id':'id','name':'x'*2049}]}]:
            with self.assertRaises(RegistryError):reads.project(reads.DRIVE,data,reads.DESCRIPTORS[reads.DRIVE]['example'])
        with self.assertRaises(RegistryError):reads.project(reads.NOTION,{'results':[],'has_more':'false'},reads.DESCRIPTORS[reads.NOTION]['example'])
    def test_raw_discarded_fields_still_count_against_aggregate_budget(self):
        self.manager.data[reads.DRIVE]['discarded']='x'*17000
        self.manager.data[reads.NOTION]['discarded']='y'*17000
        with self.assertRaises(RegistryError) as error:self.run_plan(self.plan([reads.DRIVE,reads.NOTION]))
        self.assertEqual(error.exception.code,'app_limit');self.assertTrue(self.manager.closed)
    def test_revocation_after_read_discards_data_and_skips_later_reads(self):
        self.manager.after=lambda:self.cfg.data.update(mcp_servers={})
        with self.assertRaises(RegistryError):self.run_plan(self.plan([reads.DRIVE,reads.NOTION]))
        self.assertEqual([n for n,_ in self.manager.calls],['schema','execute']);self.assertTrue(self.manager.closed)
    def test_empty_confirmed_search_is_not_failure(self):
        for tool in reads.TOOLS:
            data={'files':[]} if tool==reads.DRIVE else {'results':[],'has_more':False} if tool==reads.NOTION else {'results':[]}
            self.assertEqual(reads.project(tool,data,reads.DESCRIPTORS[tool]['example'])['items'],[])

if __name__=='__main__':unittest.main()
