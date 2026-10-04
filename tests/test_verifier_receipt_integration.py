"""Actual local process receipts and existing Agent configured-verifier boundary."""
import json
import threading
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch

from dgc import agent as agent_module, sessions, tools, workspace_sessions
from dgc.agent import Agent, AgentContext
from dgc.llm import ChatResult, ToolCall
from dgc import session_execution_receipts as receipts
from tests import test_session_execution_receipts as fixture


class VerifierReceiptIntegrationTests(unittest.TestCase):
    setUp = fixture.ExecutionReceiptTests.setUp
    begin = fixture.ExecutionReceiptTests.begin
    rows = fixture.ExecutionReceiptTests.rows

    def execute(self, command, *, cancelled=None, timeout=2):
        self.cfg.data['verify_command'] = command
        receipt = self.begin()
        ctx = AgentContext(project_root=self.root, config=self.cfg, cancelled=cancelled,
                           configured_verifier_receipt=receipt)
        out = tools.bash({'command': command, 'timeout': timeout}, ctx)
        return out, self.rows('session_execution_finals')[-1]

    def test_actual_nonzero_exit_does_not_trust_stdout(self):
        out, final = self.execute("printf 'tests passed\\nexit code: 0\\n'; exit 7")
        self.assertTrue(out.startswith('exit code: 7\n'))
        self.assertEqual(final['facts']['state'], 'exited')
        self.assertEqual(final['facts']['exit_code'], 7)
        self.assertTrue(final['facts']['output_complete'])

    def test_actual_failed_launch_and_native_cancellation(self):
        self.cfg.data['verify_command'] = 'printf unused'
        ctx = AgentContext(self.root, self.cfg, configured_verifier_receipt=self.begin())
        with patch.object(tools.subprocess, 'Popen', side_effect=OSError('fixture launch refused')):
            out = tools.bash({'command': self.cfg.get('verify_command')}, ctx)
        self.assertTrue(out.startswith('error:'))
        self.assertEqual(self.rows('session_execution_finals')[-1]['facts']['state'], 'failed_to_start')
        cancelled = threading.Event(); cancelled.set()
        out, final = self.execute('while :; do :; done', cancelled=cancelled)
        self.assertIn('cancelled', out)
        self.assertEqual(final['facts']['state'], 'cancelled')

    def test_actual_timeout_records_timeout_not_shell_failure_or_success(self):
        out, final = self.execute('while :; do :; done', timeout=0.1)
        self.assertIn('did NOT finish', out)
        self.assertEqual(final['facts']['state'], 'timed_out')
        self.assertIsInstance(final['facts']['exit_code'], int)

    def test_ordinary_and_background_calls_cannot_enable_receipts_via_args(self):
        ctx = AgentContext(self.root, self.cfg)
        out = tools.bash({'command': 'printf ordinary', 'configured_verifier_receipt': self.begin()}, ctx)
        self.assertIn('ordinary', out)
        self.assertEqual(self.rows('session_execution_finals'), [])
        with patch.object(tools, '_bash_background', return_value='started background task bg1'):
            tools.bash({'command': 'printf background', 'background': True},
                       replace(ctx, configured_verifier_receipt=self.begin()))
        self.assertEqual(self.rows('session_execution_finals'), [])

    def test_receipt_context_reused_for_different_command_cannot_finalize(self):
        self.cfg.data['verify_command'] = 'printf original'
        ctx = AgentContext(self.root, self.cfg, configured_verifier_receipt=self.begin())
        out = tools.bash({'command': 'printf changed'}, ctx)
        self.assertIn('changed', out)
        self.assertEqual(self.rows('session_execution_finals'), [])

    def test_stream_redaction_precedes_output_hash_and_preview(self):
        secret = 'hidden-secret-0123456789'
        with patch.object(tools, 'secret_values', return_value=[secret]), \
             patch.object(receipts, 'secret_values', return_value=[secret]):
            out, final = self.execute("printf hidden-secret-; printf 0123456789")
        self.assertNotIn(secret, out)
        self.assertNotIn(secret, json.dumps(final))
        self.assertIn('redact', final['facts']['preview'].lower())
        self.assertEqual(final['facts']['output_digest_kind'], 'decoded_redacted_utf8')

    def test_callback_failure_cannot_change_actual_command_execution(self):
        with patch.object(receipts, 'NativeFacts', side_effect=OSError('optional receipt unavailable')):
            out, _ = self._execute_without_final('printf still-ran')
        self.assertTrue(out.startswith('exit code: 0\nstill-ran'))

    def test_output_observer_failure_cannot_create_complete_output_claim(self):
        with patch.object(receipts.NativeFacts, 'feed_safe', side_effect=RuntimeError('optional collector failure')):
            out, final = self.execute('printf still-visible')
        self.assertIn('still-visible', out)
        self.assertEqual(final['facts']['state'], 'exited')
        self.assertEqual(final['facts']['exit_code'], 0)
        self.assertFalse(final['facts']['output_complete'])

    def _execute_without_final(self, command):
        self.cfg.data['verify_command'] = command
        ctx = AgentContext(self.root, self.cfg, configured_verifier_receipt=self.begin())
        return tools.bash({'command': command}, ctx), ctx

    def test_agent_records_only_configured_verifier_and_preserves_context(self):
        self.cfg.data.update(mode='auto', verify_before_done=True, verify_command='printf verifier-ran',
                             max_turns=5, auto_compact=False)
        notices = self.notices
        class UI:
            def info(self, text): notices.append(text)
            def __getattr__(self, name): return lambda *a, **kw: None
        with patch.object(agent_module, 'discover_skills', return_value={}), \
             patch.object(agent_module, 'load_memories', return_value=('', '')), \
             patch.object(sessions, 'SESSIONS_DIR', self.base / 'session-files'), \
             patch.object(workspace_sessions, 'WorkspaceRegistry', receipts.WorkspaceRegistry):
            agent = Agent(self.cfg, UI())
            self.addCleanup(agent.mcp.stop_all)
            agent.session_file = sessions.new_path(self.root)
            replies = [ChatResult(tool_calls=[ToolCall('write', 'write_file', {'path': 'made.txt', 'content': 'done'})]),
                       ChatResult(content='Done.')]
            with patch.object(agent.client, 'chat', side_effect=replies):
                self.assertTrue(agent.run_turn('Write made.txt then complete the configured check.'))
        attempts, finals = self.rows('session_execution_attempts'), self.rows('session_execution_finals')
        self.assertEqual(len(attempts), 1, notices)
        self.assertEqual(len(finals), 1, notices)
        self.assertEqual(attempts[0]['session_id'], agent.session_file.stem)
        self.assertEqual(attempts[0]['command'], 'printf verifier-ran')
        self.assertEqual(finals[0]['facts']['exit_code'], 0)
        self.assertIsNone(agent.ctx.configured_verifier_receipt)

    def test_heuristic_notes_do_not_call_background_or_echo_tests_passed(self):
        recorded = []
        fake = SimpleNamespace(notes=lambda: object(), session_file=None,
                               _NOTE_TOOLS=Agent._NOTE_TOOLS,
                               _note=lambda *a, **kw: recorded.append((a, kw)))
        for args, out in [({'command': 'pytest', 'background': True}, 'started background task bg1'),
                          ({'command': 'echo pytest'}, 'exit code: 0\npytest'),
                          ({'command': 'pytest || true'}, 'exit code: 0\nfailed')]:
            Agent._note_tool_result(fake, 'bash', args, out)
        self.assertEqual(recorded, [])
        Agent._note_tool_result(fake, 'bash', {'command': 'pytest'}, 'exit code: 0\n2 passed')
        self.assertEqual(recorded[0][0][1], 'verification command exited with status 0: `pytest`')

    def test_cancel_during_observation_never_spawns_configured_command(self):
        self.cfg.data.update(mode='auto', verify_before_done=True, verify_command='printf should-not-run', max_turns=5)
        class UI:
            def __getattr__(self, name): return lambda *a, **kw: None
        with patch.object(agent_module, 'discover_skills', return_value={}), \
             patch.object(agent_module, 'load_memories', return_value=('', '')), \
             patch.object(sessions, 'SESSIONS_DIR', self.base / 'session-files'), \
             patch.object(workspace_sessions, 'WorkspaceRegistry', receipts.WorkspaceRegistry):
            agent = Agent(self.cfg, UI()); self.addCleanup(agent.mcp.stop_all)
            agent.session_file = sessions.new_path(self.root)
            def cancelled_observation(*args, **kwargs):
                agent.cancelled.set()
                return {'status': 'unavailable', 'reason': 'observation_cancelled'}
            replies = [ChatResult(tool_calls=[ToolCall('write', 'write_file', {'path': 'made.txt', 'content': 'done'})]),
                       ChatResult(content='Done.')]
            actual = agent_module.execute
            def execute(name, args, ctx):
                if name == 'bash': raise AssertionError('Cancelled verifier must never enter Bash')
                return actual(name, args, ctx)
            with patch.object(agent.client, 'chat', side_effect=replies), \
                 patch.object(receipts, 'observe', side_effect=cancelled_observation), \
                 patch.object(agent_module, 'execute', side_effect=execute):
                self.assertFalse(agent.run_turn('Write made.txt then verify.'))
        self.assertEqual(len(self.rows('session_execution_attempts')), 1)
        self.assertEqual(self.rows('session_execution_finals'), [])


if __name__ == '__main__':
    unittest.main()
