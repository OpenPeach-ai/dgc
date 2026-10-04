"""Pips remains a scoped additive contract after the 0.47 multi-chat migration."""
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch

from dgc import editor_protocol as runtime
from dgc.protocol import Emitter
from tests.test_dgc_sdk_pips import CAPS, Wire, session
from dgc_sdk import DGCUnsupportedError
from dgc_sdk.wire import editor_protocol as sdk

ROOT = Path(__file__).resolve().parents[1]


class PipProtocolMigrationTests(unittest.TestCase):
    def test_scoped_pip_commands_keep_nested_correlation(self):
        request = {'type': 'send_pip_message', 'request_id': 'reply-one', 'pip_id': 'pip_rook',
                   'idempotency_key': 'review-one', 'text': 'Explain the source.',
                   'chat_options': {'context_size': 8192, 'thinking': 'off'}}
        commands = [
            {'type': 'pips_control', 'request': request},
            {'type': 'pips_enable', 'enabled': True, 'request_id': 'enable-one'},
            {'type': 'pips_runtime', 'action': 'start', 'request_id': 'start-one'},
            {'type': 'list_prompt_pips', 'request_id': 'picker-one'},
        ]
        for module in (runtime, sdk):
            for command in commands:
                for extra in ({}, {'chat_id': 'c1'}, {'chat_id': 'c2'}):
                    self.assertIsNone(module.command_error({**command, **extra}))
                for bad in ('', 'c' * 65, None, [], True):
                    self.assertIsNotNone(module.command_error({**command, 'chat_id': bad}))
            # A chat envelope does not relax the closed Pips control fields.
            self.assertIsNotNone(module.command_error(
                {'type': 'pips_control', 'chat_id': 'c1', 'request': request, 'request_id': 'outer'}))

    def test_pip_replies_keep_chat_ownership_and_strict_event_validation(self):
        stream = io.StringIO()
        emitter = Emitter(stream, validator=runtime.event_error)
        for chat in ('c1', 'c2'):
            emitter.emit('pips_result', chat_id=chat, request_id='same-correlation',
                         command='get_pip', ok=True, result={'workspace_id': 'ws_' + chat})
        events = [json.loads(line) for line in stream.getvalue().splitlines()]
        self.assertEqual([event['chat_id'] for event in events], ['c1', 'c2'])
        self.assertEqual([event['result']['workspace_id'] for event in events], ['ws_c1', 'ws_c2'])
        for event in events:
            self.assertIsNone(sdk.event_error(event))
            self.assertIsNotNone(sdk.event_error({**event, 'unexpected_privilege': True}))

    def test_generated_artifacts_combine_chat_envelopes_and_pip_contracts(self):
        for path, expected in runtime.generated_artifacts(ROOT).items():
            self.assertEqual(path.read_text(), expected, str(path))
        schema = json.loads((ROOT / 'schemas/editor-protocol-v14.schema.json').read_text())
        for kind, names in (
            ('command', {'pips_control', 'pips_enable', 'pips_runtime', 'open_chat', 'close_chat'}),
            ('event', {'pips_result', 'pips_status', 'prompt_pips', 'chat_opened', 'chat_closed'}),
        ):
            shapes = {item['properties']['type']['const']: item for item in schema['$defs'][kind]['oneOf']}
            for name in names:
                self.assertFalse(shapes[name]['additionalProperties'])
                self.assertEqual(shapes[name]['properties']['chat_id'],
                                 {'type': 'string', 'minLength': 1, 'maxLength': 64})
        self.assertEqual((ROOT / 'dgc/editor_protocol.py').read_bytes(),
                         (ROOT / 'sdk/python/dgc_sdk/wire/editor_protocol.py').read_bytes())

    def test_inherited_sdk_resume_does_not_save_over_mode_or_break_pips(self):
        wire = Wire()
        controller = session(wire, caps={**CAPS, 'pips_api_version': 24})
        controller._keep_requested_mode(1)
        self.assertFalse(wire.calls)
        result = controller.pips.mutate('send_pip_message', {
            'pip_id': 'pip_rook', 'text': 'Explain.', 'idempotency_key': 'one',
            'chat_options': {'context_size': 8192, 'thinking': 'off'},
        }, approved=True)
        self.assertEqual(result['request']['chat_options']['context_size'], 8192)
        self.assertEqual(len(wire.calls), 1)

    def test_isolated_sdk_mode_restore_does_not_grant_pips_access(self):
        wire = Wire()
        controller = session(wire, isolated=True, permission_mode='auto',
                             caps={**CAPS, 'pips_api_version': 24})
        controller._keep_requested_mode(1)
        self.assertEqual(wire.calls[0][0]['type'], 'set_mode')
        self.assertEqual(wire.calls[0][0]['mode'], 'auto')
        self.assertIs(wire.calls[0][0]['acknowledge_workspace_trust'], True)
        with self.assertRaises(DGCUnsupportedError):
            controller.pips.read('list_workspaces')
        self.assertEqual(len(wire.calls), 1)

    def test_resume_discards_idle_events_before_replay_but_keeps_pip_reply(self):
        controller = session()
        reply = ({'type': 'pips_result', 'request_id': 'one', 'command': 'get_pip',
                  'ok': True, 'result': {}}, None)
        items = [({'type': kind}, None) for kind in ('session_named', 'history', 'agents', 'mode_changed')]
        with patch.object(controller, '_read', side_effect=[*items, reply]) as read, \
                patch('dgc_sdk.session.time.monotonic', return_value=10):
            controller._discard_idle_events()
        self.assertEqual(read.call_count, 5)
        self.assertEqual(list(controller._pending), [reply])


if __name__ == '__main__':
    unittest.main()
