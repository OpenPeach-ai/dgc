"""Main-chat automatic metadata edits retain normal permission and workspace checks."""
import copy
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_adapt_tool, pips, workspace_sessions
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine, READ_ONLY_TOOLS
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_adaptation as adaptation_fixtures
from tests import test_pip_proposal_tool as tool_fixtures


class AdaptToolTests(unittest.TestCase):
    setUp = tool_fixtures.PipProposalToolTests.setUp
    create = tool_fixtures.PipProposalToolTests.create
    context = tool_fixtures.PipProposalToolTests.context
    agent = tool_fixtures.PipProposalToolTests.agent
    reviewed = adaptation_fixtures.AdaptationTests.reviewed

    def request(self, pip=None):
        pip = pip or self.reviewed()
        return {'pip_id': pip['id'], 'expected_version': pip['current_version'], 'changes': {'name': 'Focused reviewer'},
                'reason': 'Clarify the existing role.', 'request_key': 'adapt-one'}

    def adapt(self, args, ctx=None):
        with patch.object(pip_adapt_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            return json.loads(pip_adapt_tool.adapt(args, ctx or self.context()))

    def test_receipt_is_small_and_states_what_actually_changed(self):
        args = self.request()
        result = self.adapt(args)
        self.assertEqual(result['changes'], args['changes'])
        self.assertEqual(result['to_version'], 3)
        self.assertFalse(result['execution_started'])
        self.assertIn('policy_approval_id', result)
        self.assertNotIn('session_id', result)
        self.assertLess(len(json.dumps(result).encode()), 4096)
        replay = self.adapt(args)
        self.assertTrue(replay['replayed'])
        self.assertFalse(replay['job_changed_by_this_call'])

    def test_disabled_malformed_and_protected_fields_fail_before_registry(self):
        args = self.request()
        ctx = self.context()
        for enabled in (False, 'true', 1):
            self.cfg.data['pips_enabled'] = enabled
            with patch.object(pip_adapt_tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError):
                pip_adapt_tool.adapt(args, ctx)
        self.cfg.data['pips_enabled'] = True
        for value in (None, {}, {**args, 'expected_version': True}, {**args, 'request_key': '../outside'},
                      {**args, 'changes': {'name': '\ud800'}}, {**args, 'changes': {'source_ref': 'HEAD;bad'}},
                      {**args, 'reason': '\x00'}, {**args, 'changes': {'goal': 'new task'}},
                      {**args, 'changes': {'event_trigger': None}}, {**args, 'session_id': 'forged'}):
            with patch.object(pip_adapt_tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError):
                pip_adapt_tool.adapt(value, ctx)

    def test_cross_workspace_and_forged_private_origin_refused(self):
        own = self.reviewed()
        other = self.base / 'other'; other.mkdir()
        other_job = self.store.create(self.registry.resolve(other)['id'], 'Other', 'Private task', 'human')
        with self.assertRaisesRegex(RegistryError, 'not found'):
            self.adapt(self.request(other_job))
        self.registry.associate_session('elsewhere', other)
        ctx = SimpleNamespace(config=self.cfg, project_root=self.root,
            pip_proposal_origin=lambda: {'session_id': 'elsewhere', 'workspace_id': own['workspace_id']})
        with self.assertRaisesRegex(RegistryError, 'belong to this workspace'):
            self.adapt(self.request(own), ctx)
        for origin in ({'session_id': 'x', 'workspace_id': own['workspace_id'], 'extra': True},
                       {'session_id': '\ud800', 'workspace_id': own['workspace_id']}):
            ctx.pip_proposal_origin = lambda: origin
            with self.assertRaises(RegistryError):
                self.adapt(self.request(own), ctx)

    def test_secret_redaction_before_durable_version(self):
        secret = 'private-secret-abcdef012345'
        self.cfg.set('api_key', secret, persist=False)
        args = self.request()
        args['changes']['name'] = secret
        args['reason'] += secret
        result = self.adapt(args)
        self.assertNotIn(secret, json.dumps(result))
        rows = self.registry.db.execute('SELECT definition FROM pip_versions WHERE pip_id=?', (args['pip_id'],)).fetchall()
        self.assertNotIn(secret, str([r[0] for r in rows]))
        self.assertNotIn(secret, str(self.store.adaptations(args['pip_id'])))

    def test_permissions_keep_adaptation_separate_from_read_or_file_edits(self):
        self.assertNotIn('pips_adapt', READ_ONLY_TOOLS)
        for mode, expected in (('default',ASK),('acceptEdits',ASK),('plan',DENY),('auto',ALLOW)):
            with self.subTest(mode=mode):
                self.assertEqual(PermissionEngine(mode, {}, self.root).decide('pips_adapt', {'pip_id':'p'})[0], expected)
                self.assertEqual(PermissionEngine(mode, {'deny':['PipsAdapt'], 'allow':['PipsAdapt']}, self.root).decide('pips_adapt', {'pip_id':'p'})[0], DENY)
        self.assertIn('PipsAdapt', pips.native_policy()['deny'])

    def test_agent_child_monitor_and_disabled_catalog_never_execute(self):
        agent, _ = self.agent()
        args = self.request()
        for field in ('depth', '_monitor_turn'):
            setattr(agent, field, 1)
            self.assertNotIn('pips_adapt', {s['function']['name'] for s in agent._tool_schemas()})
            with patch.object(pip_adapt_tool, 'adapt', side_effect=AssertionError('No mutation')):
                self.assertIn('main user chat', agent._handle_call(ToolCall('no', 'pips_adapt', args)))
            setattr(agent, field, 0)
        self.cfg.data['pips_enabled'] = False
        self.assertNotIn('pips_adapt', {s['function']['name'] for s in agent._tool_schemas()})

    def test_restricted_runtime_scope_never_reads_independent_storage(self):
        args, ctx = self.request(), self.context()
        for scope in ('policy', 'sandbox'):
            self.cfg.data['sandbox'] = scope == 'sandbox'
            env = {'DGC_SESSION_POLICY': '{"version":1}'} if scope == 'policy' else {}
            with patch.dict(os.environ, env), patch.object(pip_adapt_tool, 'WorkspaceRegistry', side_effect=AssertionError('No private storage')):
                with self.assertRaises(RegistryError) as caught:
                    pip_adapt_tool.adapt(args, ctx)
                self.assertEqual(caught.exception.code, 'session_policy')

    def test_agent_explicit_denial_and_declined_prompt_do_not_mutate(self):
        agent, approvals = self.agent()
        args = self.request()
        with patch.object(pip_adapt_tool, 'adapt', side_effect=AssertionError('No mutation')):
            self.cfg.permissions['deny'] = ['PipsAdapt']
            self.cfg.data['mode'] = 'auto'
            self.assertIn('DENIED', agent._handle_call(ToolCall('denied', 'pips_adapt', args)))
            self.cfg.permissions['deny'] = []
            self.cfg.data['mode'] = 'default'
            self.assertIn('DENIED', agent._handle_call(ToolCall('ask', 'pips_adapt', args)))
            self.assertEqual(approvals, ['pips_adapt'])

    def test_local_model_tool_roundtrip_uses_existing_agent_and_no_new_permissions(self):
        agent, _ = self.agent()
        self.cfg.data.update(mode='auto', api_mode='ollama')
        args = self.request()
        sent = []
        replies = iter([ChatResult(tool_calls=[ToolCall('adapt', 'pips_adapt', args)]), ChatResult(content='I updated only the authorized display name.')])
        def chat(client, messages, **kwargs):
            sent.append((copy.deepcopy(messages), copy.deepcopy(kwargs.get('tools', []))))
            return next(replies)
        with patch.object(pip_adapt_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(workspace_sessions, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(LLMClient, 'chat', chat), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            self.assertTrue(agent.run_turn('Rename my Pip to make its existing purpose clearer.'))
        self.assertIn('pips_adapt', str(sent[0][1]))
        self.assertIn('"execution_started":false', str(sent[-1][0]))
        self.assertEqual(self.store.get(args['pip_id'])['current_version'], 3)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
