"""Offline ordinary-Agent recovery from invalid action-specific Pip read keys."""
import copy
import json
import unittest
from unittest.mock import Mock, patch

from dgc import pip_context_tool, tools
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_pips_context_bridge as fixtures


class PipsContextGuidanceTests(unittest.TestCase):
    setUp = fixtures.PipsContextBridgeTests.setUp
    git = fixtures.PipsContextBridgeTests.git
    commit = fixtures.PipsContextBridgeTests.commit
    create = fixtures.PipsContextBridgeTests.create
    enqueue = fixtures.PipsContextBridgeTests.enqueue
    agent = fixtures.PipsContextBridgeTests.agent

    def test_ordinary_agent_receives_validation_error_then_corrects_report_read(self):
        self.commit()
        run = self.enqueue()
        self.store.claim_next()
        self.store.finish(run['id'], result={
            'summary': 'Historical source assessment',
            'findings': [{'title': 'Inspect greeting contract', 'severity': 'low',
                          'path': 'source.py', 'line': 2, 'evidence': "    return 'hello'",
                          'verification': 'source_excerpt_only'}],
            'limitations': ['Tests were not executed.'], 'tests_executed': False,
            'verification': 'Source excerpts checked against the pinned snapshot; findings are model assessments.'})
        before = list(self.registry.db.iterdump())
        source_before = (self.root / 'source.py').read_bytes()
        self.cfg.data['max_turns'] = 3
        agent = self.agent()
        agent.ui.approve = Mock(side_effect=AssertionError('No approval is needed for these reads'))
        incorrect = {'action': 'report', 'pip_id': run['pip_id'], 'run_id': run['id'], 'offset': 0, 'limit': 3}
        corrected = {'action': 'report', 'run_id': run['id']}
        final = ('This historical model assessment cites source.py:2. '
                 'The excerpt was checked; the finding is not a verified defect, and tests were not executed.')
        seen = []

        def chat(client, messages, **kwargs):
            seen.append(copy.deepcopy(messages))
            if len(seen) == 1:
                return ChatResult(tool_calls=[ToolCall('invalid-report', 'pips_context', incorrect)])
            if len(seen) == 2:
                feedback = next(message for message in messages
                                if message.get('tool_call_id') == 'invalid-report' and message['role'] == 'tool')
                self.assertEqual(feedback['content'], 'error: RegistryError: Unsupported Pips read action or arguments.')
                return ChatResult(tool_calls=[ToolCall('corrected-report', 'pips_context', corrected)])
            if len(seen) == 3:
                feedback = next(message for message in messages
                                if message.get('tool_call_id') == 'corrected-report' and message['role'] == 'tool')
                report = json.loads(feedback['content'])
                self.assertEqual(report['workspace_id'], self.workspace['id'])
                self.assertEqual(report['run']['id'], run['id'])
                self.assertEqual(report['run']['status'], 'succeeded')
                self.assertEqual(report['findings'][0]['evidence'], "    return 'hello'")
                self.assertEqual(report['findings'][0]['verification'], 'source_excerpt_only')
                self.assertIn('Findings are model assessments', report['notice'])
                self.assertEqual(report['limitations'], ['Tests were not executed.'])
                self.assertIsNone(report['next_offset'])
                return ChatResult(content=final)
            self.fail('The bounded ordinary loop must not retry indefinitely')

        with patch.object(pip_context_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(LLMClient, 'chat', chat), \
             patch('dgc.agent.execute', wraps=tools.execute) as execute, \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            self.assertTrue(agent.run_turn('Read this saved audit report; distinguish assessment from test evidence.'))
        self.assertEqual(len(seen), 3)
        self.assertEqual(execute.call_count, 2)
        self.assertEqual([(call.args[0], call.args[1]) for call in execute.call_args_list],
                         [('pips_context', incorrect), ('pips_context', corrected)])
        self.assertEqual(agent.messages[-1]['content'], final)
        agent.ui.approve.assert_not_called()
        self.assertEqual(list(self.registry.db.iterdump()), before)
        self.assertEqual((self.root / 'source.py').read_bytes(), source_before)

    def test_other_action_keys_remain_refused_before_workspace_access(self):
        cases = [
            {'action': 'list', 'pip_id': 'pip_other'},
            {'action': 'definition', 'pip_id': 'pip_other', 'run_id': 'run_other'},
            {'action': 'report', 'run_id': 'run_other', 'pip_id': 'pip_other'},
            {'action': 'execution', 'run_id': 'run_other', 'pip_id': 'pip_other'},
            {'action': 'draft', 'run_id': 'run_other', 'limit': 3},
            {'action': 'context', 'workspace_id': self.workspace['id']},
            {'action': 'context', 'limit': 3},
            {'action': 'attachments', 'session_id': 'another-session'},
            {'action': 'attachments', 'limit': 3},
            {'action': 'memory', 'pip_id': 'pip_other', 'offset': 0},
            {'action': 'statements', 'pip_id': 'pip_other', 'after': 0},
            {'action': 'activity', 'offset': 0},
        ]
        agent = self.agent()
        with patch.object(pip_context_tool, 'WorkspaceRegistry', side_effect=AssertionError('Must reject before scope lookup')):
            for arguments in cases:
                with self.subTest(arguments=arguments):
                    self.assertEqual(tools.execute('pips_context', arguments, agent.ctx),
                                     'error: RegistryError: Unsupported Pips read action or arguments.')


if __name__ == '__main__':
    unittest.main()
