"""Raw controller policy cannot be bypassed by using the wire below the SDK."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from tests import test_headless_pips_controls as fixtures
from tests import test_pips_context_bridge as context_fixtures


class PipControllerPolicyTests(unittest.TestCase):
    setUp = fixtures.LocalPipsBridgeTests.setUp
    send = fixtures.LocalPipsBridgeTests.send
    control = fixtures.LocalPipsBridgeTests.control

    def commands(self):
        return [
            {'type': 'pips_enable', 'enabled': True, 'request_id': 'enable'},
            {'type': 'pips_enable', 'enabled': False, 'request_id': 'disable'},
            {'type': 'pips_runtime', 'action': 'start', 'request_id': 'start'},
            {'type': 'pips_runtime', 'action': 'resume', 'request_id': 'resume'},
            {'type': 'pips_control', 'request': {'type': 'list_workspaces', 'request_id': 'read'}},
            {'type': 'pips_control', 'request': {'type': 'stop_pips', 'request_id': 'stop'}},
        ]

    def assert_refused(self, command):
        event = self.send(command)
        if command['type'] == 'pips_enable':
            self.assertEqual((event['type'], event['reason']), ('command_rejected', 'session_policy'))
        else:
            self.assertEqual((event['type'], event['ok'], event['error']['code']), ('pips_result', False, 'session_policy'))
        self.assertEqual(event['request_id'], command.get('request', command)['request_id'])

    def test_any_runtime_policy_refuses_reads_and_mutations_before_state_or_threads(self):
        for policy in ('{"version":1}', '{malformed', ''):
            with patch.dict(os.environ, {'DGC_SESSION_POLICY': policy}), \
                 patch('dgc.workspace_registry.WorkspaceRegistry', side_effect=AssertionError('No state access')):
                for command in self.commands():
                    with self.subTest(policy=policy, command=command): self.assert_refused(command)
        self.assertIsNone(getattr(self.backend, '_pips_control_thread', None))
        self.assertFalse(self.config.get('pips_enabled'))

    def test_configured_sandbox_refuses_even_if_backend_unavailable(self):
        self.config.data['sandbox'] = True
        with patch('dgc.sandbox.available', return_value=None), \
             patch('dgc.workspace_registry.WorkspaceRegistry', side_effect=AssertionError('No state access')):
            for command in self.commands():
                with self.subTest(command=command): self.assert_refused(command)

    def test_policy_change_after_queue_still_refuses_without_saved_state(self):
        command = self.commands()[0]
        self.send(command, drain=False)
        self.assertEqual(len(self.backend._pips_commands), 1)
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': '{"version":1}'}), \
             patch('dgc.workspace_registry.WorkspaceRegistry', side_effect=AssertionError('No state access')):
            self.backend._drain_pips_commands()
        self.assertEqual(self.events[-1]['reason'], 'session_policy')
        self.assertFalse(self.config.get('pips_enabled'))


class MainChatPipPolicyTests(unittest.TestCase):
    setUp = context_fixtures.PipsContextBridgeTests.setUp
    agent = context_fixtures.PipsContextBridgeTests.agent

    def test_context_and_proposals_refuse_independent_data_scope_before_storage(self):
        from dgc import pip_context_tool, pip_proposal_tool
        from dgc.workspace_registry import RegistryError
        ctx = SimpleNamespace(config=self.cfg, project_root=self.root)
        for scope in ('policy', 'sandbox'):
            self.cfg.data['sandbox'] = scope == 'sandbox'
            environment = {'DGC_SESSION_POLICY': '{"version":1}'} if scope == 'policy' else {}
            with patch.dict(os.environ, environment), \
                 patch.object(pip_context_tool, 'WorkspaceRegistry', side_effect=AssertionError('No independent state')), \
                 patch.object(pip_proposal_tool, 'WorkspaceRegistry', side_effect=AssertionError('No independent state')):
                for callback, args in ((pip_context_tool.read, {'action': 'context'}),
                                       (pip_proposal_tool.propose, {})):
                    with self.subTest(scope=scope, callback=callback), self.assertRaises(RegistryError) as caught:
                        callback(args, ctx)
                    self.assertEqual(caught.exception.code, 'session_policy')

    def test_agent_does_not_advertise_or_prompt_restricted_pip_tools(self):
        agent = self.agent()
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': '{"version":1}'}):
            names = {tool['function']['name'] for tool in agent._tool_schemas()}
            self.assertFalse({'pips_context', 'pips_propose'} & names)
            self.assertNotIn('Use pips_context', agent.system_prompt())
        names = {tool['function']['name'] for tool in agent._tool_schemas()}
        self.assertIn('pips_context', names)


if __name__ == '__main__': unittest.main()
