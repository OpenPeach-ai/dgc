"""Real installed skills and stdio MCP tools through both model tool protocols."""
import copy
import json
import sys
import io
import requests
from types import SimpleNamespace
from unittest import TestCase
from unittest.mock import patch, PropertyMock

from dgc import plugins, skills
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.llm import ChatResult, ToolCall
from dgc.mcp import MCPManager
from tests import test_plugin_lifecycle as lifecycle

SERVER = '''import json,sys
for line in sys.stdin:
 r=json.loads(line)
 if 'id' not in r: continue
 m=r.get('method'); result={}
 if m=='server/discover':
  print(json.dumps({'jsonrpc':'2.0','id':r['id'],'error':{'code':-32601,'message':'legacy fixture'}}),flush=True);continue
 if m=='initialize': result={'protocolVersion':'2025-11-25','capabilities':{'tools':{}},'serverInfo':{'name':'fixture','version':'1'}}
 elif m=='tools/list': result={'tools':[{'name':'read_value','description':'Read the fixture value','inputSchema':{'type':'object','properties':{}},'annotations':{'readOnlyHint':True}}]}
 elif m=='tools/call': result={'content':[{'type':'text','text':'PLUGIN_FIXTURE_VALUE_42'}]}
 print(json.dumps({'jsonrpc':'2.0','id':r['id'],'result':result}),flush=True)
'''


class PluginModelRuntimeTests(TestCase):
    setUp=lifecycle.PluginLifecycleTests.setUp
    write=lifecycle.PluginLifecycleTests.write
    install=lifecycle.PluginLifecycleTests.install

    def agent(self, server_source=SERVER, plugin_name='fixture'):
        guard=patch.object(requests.sessions.Session,'request',side_effect=AssertionError('Unexpected real network request'))
        guard.start();self.addCleanup(guard.stop)
        self.entry['name']=plugin_name
        self.write('server.py',server_source)
        self.write('.mcp.json',{'mcpServers':{'local':{'command':sys.executable,'args':['${DGC_PLUGIN_ROOT}/server.py']}}})
        record=self.install()
        config=object.__new__(Config)
        config.project_root=self.root;config.project_dir=self.root/'.dgc';config._persist=False
        config.data=copy.deepcopy(DEFAULTS)
        config.data.update(base_url='http://localhost.invalid/v1',model='fixture-local',mode='auto',hooks={},mcp_servers={},suggest=False,artifact_autostart=False,plan_artifact=False,tool_profile='full')
        config._stored_secrets={};config._env_secret_keys=set();config._stored_mcp_env={};config._stored_mcp_identity={};config._explicit_keys=set()
        config.permissions={'allow':[],'ask':[],'deny':[]}
        manager=MCPManager(self.root);self.addCleanup(manager.stop_all)
        plugins.connect(config,manager,record,input_handler=None)
        self.assertIn(plugin_name,manager.servers,manager.failures)
        class UI:
            def __getattr__(self,name):return lambda *a,**kw:None
        with patch.object(skills,'USER_HOME',self.home.parent), patch.object(skills,'USER_SKILLS',self.root/'user-skills'), patch.object(skills,'PORTABLE_USER_SKILLS',self.root/'portable-skills'), patch('dgc.agent.discover_skills',return_value=skills.discover_skills(self.root)):
            agent=Agent(config,UI(),mcp=manager)
        self.assertIn('example',agent.skills)
        self.assertEqual(agent.skills['example'].source,'plugin')
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def test_installed_skill_and_tool_reach_native_and_text_models(self):
        for native in (True,False):
            with self.subTest(native=native):
                agent=self.agent()
                calls=[]
                def post(url, **kwargs):
                    payload=kwargs['json']; messages=payload['messages']; calls.append(copy.deepcopy(messages))
                    if len(calls)==1:
                        self.assertIn('example',str(messages))
                        if native:
                            self.assertIn('mcp__fixture__read_value',str(payload.get('tools')))
                            delta={'tool_calls':[{'index':0,'id':'call1','type':'function','function':{'name':'mcp__fixture__read_value','arguments':'{}'}}]}
                        else:
                            self.assertIn('mcp__fixture__read_value',str(messages))
                            self.assertNotIn('tools',payload)
                            delta={'content':'```tool_call\n{"name":"mcp__fixture__read_value","arguments":{}}\n```'}
                    else:
                        self.assertIn('PLUGIN_FIXTURE_VALUE_42',str(messages))
                        delta={'content':'The fixture value is 42.'}
                    response=requests.Response();response.status_code=200;response.encoding='utf-8';response.url=url
                    response.headers['Content-Type']='text/event-stream'
                    response.raw=io.BytesIO(('data: '+json.dumps({'choices':[{'index':0,'delta':delta,'finish_reason':'tool_calls' if native and len(calls)==1 else 'stop'}]})+'\n\ndata: [DONE]\n\n').encode())
                    return response
                with patch.object(type(agent.client),'tools_supported',new_callable=PropertyMock,return_value=native), patch('dgc.llm.requests.post',side_effect=post):
                    result=agent.run_turn('Use the example plugin to read its fixture value. Do not change files.')
                self.assertTrue(result);self.assertEqual(len(calls),2)
                self.assertIn('MCP connected',agent._installed_plugin_note('fixture'))
                agent.mcp.stop_all()

    def test_a_connected_broker_is_named_as_a_route_to_unconnected_services(self):
        # The roster reported per-plugin connectivity only, so a model read "Figma: MCP not
        # connected (OAuth error)" as "Figma is unreachable" while Composio sat connected one line
        # below with the user's Figma account behind it -- and wrote that premise into its own
        # sub-agent's brief rather than searching the broker. Assert the PROMPT, not the helper:
        # the defect was in what the model was told.
        self.entry['category'] = 'App connector'
        agent = self.agent()
        try:
            note = agent._installed_plugin_note('fixture')
            self.assertIn('MCP connected', note)
            self.assertIn('search it with mcp_search', note)
            self.assertIn('search it with mcp_search', agent.system_prompt(),
                          'the sentence has to reach the model, not just the helper')
            # Conditional, not boilerplate: an ordinary plugin claims no reach beyond itself.
            rows = plugins._installed(); rows[0]['category'] = 'Creativity'; plugins._save(rows)
            self.assertNotIn('search it with mcp_search', agent._installed_plugin_note('fixture'))
        finally:
            agent.mcp.stop_all()

    def test_an_upstream_rate_limit_reads_as_retryable_not_as_missing_access(self):
        # A 429 reached the model as the same opaque payload as a missing credential, so it read as
        # "no access" and the model surrendered -- offering to use screenshots the user would send
        # by hand rather than waiting and calling the tool again.
        from dgc.mcp_context import request_complete
        agent = self.agent()
        try:
            payload = {"isError": True, "content": [{"type": "text", "text":
                       '{"status":429,"err":"Rate limit exceeded"}'}]}
            with patch('dgc.mcp_context.request_complete', return_value=payload):
                out = agent.mcp.servers['fixture'].call_tool('read_value', {})
            self.assertTrue(out.startswith('ERROR: '), 'it is still an error')
            self.assertIn('upstream rate limit', out)
            self.assertIn('growing backoff', out)
            # A real access failure must NOT be dressed up as retryable.
            denied = {"isError": True, "content": [{"type": "text", "text":
                      '{"status":403,"err":"Missing scope files:read"}'}]}
            with patch('dgc.mcp_context.request_complete', return_value=denied):
                out = agent.mcp.servers['fixture'].call_tool('read_value', {})
            self.assertNotIn('upstream rate limit', out)
            # Three digits are not evidence: a request id carrying 429 is not a rate limit.
            noisy = {"isError": True, "content": [{"type": "text", "text":
                     '{"status":403,"request_id":"req-429-aa","err":"Missing scope"}'}]}
            with patch('dgc.mcp_context.request_complete', return_value=noisy):
                out = agent.mcp.servers['fixture'].call_tool('read_value', {})
            self.assertNotIn('upstream rate limit', out)
        finally:
            agent.mcp.stop_all()

    def test_a_broker_that_is_down_does_not_advertise_reach(self):
        # A disconnected broker can reach nothing. Saying otherwise would send the model looking
        # for tools that are not there.
        self.entry['category'] = 'App connector'
        agent = self.agent()
        try:
            self.assertIn('search it with mcp_search', agent._installed_plugin_note('fixture'))
            agent.mcp.stop_all()
            note = agent._installed_plugin_note('fixture')
            self.assertNotIn('search it with mcp_search', note)
            self.assertNotIn('MCP connected.', note)
        finally:
            agent.mcp.stop_all()

    def test_uninstalled_tools_are_removed_and_denied_tools_do_not_execute(self):
        agent=self.agent()
        from dgc.permissions import rule_for
        agent.config.permissions['deny']=[rule_for('mcp__fixture__read_value',{})]
        with patch.object(agent.mcp,'call',side_effect=AssertionError('denied MCP executed')):
            out=agent._handle_call(ToolCall('deny','mcp__fixture__read_value',{}))
        self.assertIn('den',str(out).lower())
        plugins.uninstall('fixture',config=agent.config,manager=agent.mcp)
        names={t['function']['name'] for t in agent.mcp.tool_schemas()}
        self.assertNotIn('mcp__fixture__read_value',names)
        self.assertEqual(agent._installed_plugin_note('fixture'),'')

    def test_composio_meta_tools_work_through_native_and_text_model_protocols(self):
        # A real local stdio process provides the Composio-shaped schema/result.
        # Model HTTP is intercepted: this proves DGC routing, not a vendor account.
        source = SERVER.replace("'read_value'", "'COMPOSIO_MULTI_EXECUTE_TOOL'").replace(
            "'properties':{}", "'properties':{'tools':{'type':'array','items':{'type':'object'}}}")
        arguments = {'tools':[{'tool_slug':'GMAIL_FETCH_EMAILS','arguments':{'max_results':1}}]}
        for native in (True, False):
            with self.subTest(native=native):
                agent=self.agent(source,'composio')
                calls=[]
                route='mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL'
                def post(url, **kwargs):
                    payload=kwargs['json'];calls.append(copy.deepcopy(payload))
                    if len(calls)==1:
                        self.assertIn(route,str(payload))
                        if native:
                            delta={'tool_calls':[{'index':0,'id':'apps1','type':'function','function':{'name':route,'arguments':json.dumps(arguments)}}]}
                        else:
                            self.assertNotIn('tools',payload)
                            delta={'content':'```tool_call\n'+json.dumps({'name':route,'arguments':arguments})+'\n```'}
                    else:
                        self.assertIn('PLUGIN_FIXTURE_VALUE_42',str(payload['messages']))
                        delta={'content':'The connected fixture returned 42.'}
                    response=requests.Response();response.status_code=200;response.encoding='utf-8';response.url=url
                    response.headers['Content-Type']='text/event-stream'
                    response.raw=io.BytesIO(('data: '+json.dumps({'choices':[{'index':0,'delta':delta,'finish_reason':'tool_calls' if native and len(calls)==1 else 'stop'}]})+'\n\ndata: [DONE]\n\n').encode())
                    return response
                with patch.object(type(agent.client),'tools_supported',new_callable=PropertyMock,return_value=native), patch('dgc.llm.requests.post',side_effect=post):
                    self.assertTrue(agent.run_turn('Use the Composio fixture to read its value.'))
                self.assertEqual(len(calls),2)
                from dgc.permissions import rule_for
                agent.config.permissions['deny']=[rule_for(route,{})]
                with patch.object(agent.mcp,'call',side_effect=AssertionError('denied meta tool executed')):
                    self.assertIn('DENIED',agent._handle_call(ToolCall('deny-app',route,arguments)))
                agent.config.permissions['deny']=[]
                agent.set_mode('default')
                agent.ui.approve=lambda *a,**kw:'no'
                with patch.object(agent.mcp,'call',side_effect=AssertionError('unapproved meta tool executed')):
                    self.assertIn('DENIED',agent._handle_call(ToolCall('decline-app',route,arguments)))
                plugins.uninstall('composio',config=agent.config,manager=agent.mcp)
                self.assertNotIn(route,str(agent.mcp.tool_schemas()))
                agent.mcp.stop_all()
