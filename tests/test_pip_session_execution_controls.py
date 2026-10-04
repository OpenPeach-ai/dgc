"""Selected-workspace receipt controls retain exact human pins without source reads."""
import contextlib
import copy
import io
import json
import unittest
from unittest.mock import patch

from dgc import pip_cli, pips
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_workspace_session_execution as fixtures
from tests.test_pips_local import config


class SessionExecutionControlTests(unittest.TestCase):
    setUp = fixtures.SessionExecutionReadTests.setUp
    begin = fixtures.SessionExecutionReadTests.begin
    facts = fixtures.SessionExecutionReadTests.facts
    rows = fixtures.SessionExecutionReadTests.rows
    ready = fixtures.SessionExecutionReadTests.ready

    def control(self, kind, *, foreground=None, **fields):
        with patch.object(pips, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            return pips.handle_control(foreground or self.cfg, {'type': kind, 'request_id': 'review-one',
                'workspace_id': self.origin['workspace_id'], **fields}, 'human-controller', start_worker=False)

    def test_selected_offline_workspace_read_and_record_do_not_change_foreground_or_launch_work(self):
        attempt = self.ready(text='tests passed\n', code=7)
        other = self.base / 'foreground'
        foreground = config(other)
        original = copy.deepcopy(foreground.__dict__)
        self.root.rename(self.base / 'moved-away')
        with patch.object(WorkspaceRegistry, 'resolve', side_effect=AssertionError('No workspace registration')), \
             patch.object(type(foreground), 'clone_for_root', side_effect=AssertionError('No path resolution')), \
             patch('subprocess.Popen', side_effect=AssertionError('No command execution')):
            page = self.control('list_workspace_execution_receipts', foreground=foreground, session_id='chat-one')
            self.assertTrue(page['ok'], page)
            self.assertEqual(page['result']['receipts'][0]['id'], attempt)
            detail = self.control('get_workspace_execution_receipt', foreground=foreground, attempt_id=attempt)
            self.assertTrue(detail['ok'], detail)
            receipt = detail['result']['receipt']
            context = self.control('get_workspace_context', foreground=foreground)
            self.assertTrue(context['ok'], context)
            self.assertEqual(context['result']['context']['revision'], 0)
            pins = {f'expected_{key}': receipt[key] for key in ('attempt_digest', 'final_digest', 'view_digest')}
            saved = self.control('record_workspace_execution_context', foreground=foreground,
                attempt_id=attempt, expected_context_revision=0, **pins)
            self.assertTrue(saved['ok'], saved)
            entry = saved['result']['context']['entries'][0]
            self.assertEqual(entry['provenance']['facts']['exit_code'], 7)
            self.assertNotIn('tests passed', entry['content'])
            self.assertEqual(entry['created_by'], 'human-controller')
            replay = self.control('record_workspace_execution_context', foreground=foreground,
                attempt_id=attempt, expected_context_revision=0, **pins)
            self.assertTrue(replay['ok'], replay)
            self.assertTrue(replay['result']['replayed'])
        self.assertEqual(foreground.__dict__, original)
        self.assertFalse(other.exists())

    def test_missing_workspace_foreign_receipt_and_injected_authority_are_refused(self):
        attempt = self.ready()
        other = self.base / 'other'; other.mkdir()
        foreign = self.registry.resolve(other)['id']
        wrong = self.control('get_workspace_execution_receipt', workspace_id=foreign, attempt_id=attempt)
        self.assertFalse(wrong['ok'], wrong)
        for fields in ({'actor': 'forged'}, {'project_root': '/tmp'}, {'command': 'echo forged'},
                       {'source_before': {}}, {'permissions': {'allow': ['Bash']}}):
            rejected = self.control('get_workspace_execution_receipt', attempt_id=attempt, **fields)
            self.assertFalse(rejected['ok'], rejected)
            self.assertEqual(rejected['error']['code'], 'invalid_request')
        with patch.object(pips, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(WorkspaceRegistry, 'resolve', side_effect=AssertionError('Explicit selection required')):
            missing = pips.handle_control(self.cfg, {'type': 'list_workspace_execution_receipts',
                'request_id': 'missing'}, 'human-controller', start_worker=False)
        self.assertFalse(missing['ok'])

    def test_null_filters_restricted_sessions_and_disabled_flag_fail_closed(self):
        self.ready()
        for field in ('session_id', 'before_id', 'limit'):
            response = self.control('list_workspace_execution_receipts', **{field: None})
            self.assertFalse(response['ok'], response)
        for restriction in ('dgc.permissions.session_policy', 'dgc.sandbox.requested'):
            with patch(restriction, return_value=object()), \
                 patch.object(pips, 'WorkspaceRegistry', side_effect=AssertionError('No restricted storage')):
                response = pips.handle_control(self.cfg, {'type': 'list_workspace_execution_receipts',
                    'request_id': 'restricted'}, 'human-controller', start_worker=False)
            self.assertFalse(response['ok']); self.assertEqual(response['error']['code'], 'session_policy')
        self.cfg.data['pips_enabled'] = False
        self.assertEqual(self.control('list_workspace_execution_receipts')['error']['code'], 'disabled')


class SessionExecutionCLITests(unittest.TestCase):
    def request(self, *flags):
        return pip_cli._request(pip_cli.parser().parse_args(['session-execution', *flags]))

    def test_pagination_detail_and_recording_carry_closed_arguments(self):
        page = self.request('list', '--workspace', 'ws_one', '--session', 'chat-one', '--before-id', 'exec_one', '--limit', '10')
        self.assertEqual(page['type'], 'list_workspace_execution_receipts')
        self.assertEqual((page['session_id'], page['before_id'], page['limit']), ('chat-one', 'exec_one', 10))
        self.assertEqual(self.request('show', 'exec_one', '--workspace', 'ws_one')['type'], 'get_workspace_execution_receipt')
        pins = ['--attempt-digest', 'a'*64, '--final-digest', 'b'*64, '--view-digest', 'c'*64,
                '--expected-context-revision', '4', '--workspace', 'ws_one']
        value = self.request('record', 'exec_one', *pins)
        self.assertEqual(value['type'], 'record_workspace_execution_context')
        self.assertEqual(value['expected_context_revision'], 4)
        self.assertEqual(value['expected_view_digest'], 'c'*64)
        for n in range(0, len(pins), 2):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.request('record', 'exec_one', *(pins[:n] + pins[n+2:]))

    def test_receipt_format_keeps_output_inert_and_unknown_launch_honest(self):
        value = {'receipt': {'id': 'exec_one', 'workspace_id': 'ws_one', 'session_id': 'chat-one',
            'state': 'unfinalized', 'facts': None, 'output_preview': None,
            'command': {'text': '\x1b[31mrun', 'redacted': False}, 'source_before': {'status': 'unavailable'},
            'source_after': None, 'source_comparison': None, 'attempt_digest': 'a'*64,
            'final_digest': None, 'view_digest': 'b'*64, 'recording': None,
            'can_record': False, 'record_blocked_reason': 'unfinalized',
            'projection': {'notice': 'Historical facts, not test proof.'}}}
        result = pip_cli._format(value)
        self.assertIn('unfinalized', result)
        self.assertNotIn('\x1b', result)
        self.assertNotIn('session-execution record', result)


if __name__ == '__main__': unittest.main()
