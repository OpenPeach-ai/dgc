"""Pips retain their owner across the 0.47 multi-chat migration.

Real Host routing, private SQLite registry and protocol emitters; no network or sleeps.
Threads are held and their queues drained explicitly so interleaving is deterministic.
"""
import os
import unittest
from unittest.mock import patch

from tests import test_host as host_fixture
from dgc import headless
from dgc.workspace_registry import WorkspaceRegistry
from tests.pip_test_profile import pips_in_use


class PipHostMigrationTests(unittest.TestCase):
    frames = host_fixture.HostTest.frames
    second_chat = host_fixture.HostTest.second_chat

    def setUp(self):
        pips_in_use(self)
        host_fixture.HostTest.setUp(self)
        env = patch.dict(os.environ, {"DGC_HOME": str(self.tmp / 'pip-private')})
        env.start()
        self.addCleanup(env.stop)
        network = patch('requests.sessions.Session.request', side_effect=AssertionError('No network'))
        network.start()
        self.addCleanup(network.stop)
        self.a = self.host.default
        self.b = self.second_chat()
        for chat in (self.a, self.b):
            chat.config.data['pips_enabled'] = True
        self.host.core.tag_chats = True

    def send(self, chat, request):
        command = {'type': 'pips_control', 'chat_id': chat.chat_id, 'request': request}
        with patch.object(headless.threading, 'Thread'):
            self.host.dispatch(command)
            queued = self.host._queues[chat.chat_id].get_nowait()
            self.assertNotIn('chat_id', queued, 'Host must remove only the routing envelope')
            chat.dispatch(queued)
        chat._drain_pips_commands()
        return self.frames()[-1]

    def test_pips_request_and_response_keep_the_selected_chat_workspace(self):
        # Same request id in two chats must never select the default chat's config.
        a = self.send(self.a, {'type': 'list_workspaces', 'request_id': 'same-id'})
        b = self.send(self.b, {'type': 'list_workspaces', 'request_id': 'same-id'})
        self.assertTrue(a['ok'], a)
        self.assertTrue(b['ok'], b)
        self.assertEqual((a['chat_id'], b['chat_id']), (self.a.chat_id, self.b.chat_id))
        a_id, b_id = (r['result']['current_workspace_id'] for r in (a, b))
        self.assertNotEqual(a_id, b_id)
        with WorkspaceRegistry() as registry:
            self.assertEqual(registry.binding(a_id)['canonical_root'], str(self.a.config.project_root))
            self.assertEqual(registry.binding(b_id)['canonical_root'], str(self.b.config.project_root))
        refused = self.send(self.b, {'type': 'list_pip_setups', 'request_id': 'wrong-project', 'workspace_id': a_id})
        self.assertEqual(refused['chat_id'], self.b.chat_id)
        self.assertFalse(refused['ok'])
        self.assertEqual(refused['error']['code'], 'workspace_mismatch')

    def test_closed_or_unknown_chat_cannot_fall_back_to_default_pips(self):
        with patch.object(self.a, '_queue_pips_command', side_effect=AssertionError('Wrong owner')):
            self.host._closing.add(self.b.chat_id)
            self.host.dispatch({'type': 'pips_control', 'chat_id': self.b.chat_id,
                                'request': {'type': 'list_workspaces', 'request_id': 'closed'}})
            self.host.dispatch({'type': 'pips_control', 'chat_id': 'missing',
                                'request': {'type': 'list_workspaces', 'request_id': 'missing'}})
        for result, request_id in zip(self.frames(), ('closed', 'missing')):
            self.assertEqual(result['reason'], 'unknown_chat')
            self.assertEqual(result['request_id'], request_id)
            self.assertEqual(result['command'], 'pips_control')
        with WorkspaceRegistry() as registry:
            self.assertEqual(registry.list(), [])

    def test_closing_chat_cancels_queued_pip_controls_without_closing_sibling(self):
        with patch.object(headless.threading, 'Thread'):
            self.b._queue_pips_command({'type': 'pips_control', 'request': {
                'type': 'list_workspaces', 'request_id': 'queued'}})
        self.assertEqual(len(self.b._pips_commands), 1)
        self.b._pips_control_thread = None  # held fixture worker never started
        self.b.close(process=False)
        self.assertEqual(self.b._pips_commands, [])
        result = self.frames()[-1]
        self.assertEqual(result['chat_id'], self.b.chat_id)
        self.assertEqual(result['error']['code'], 'chat_closed')
        self.assertEqual(result['request_id'], 'queued')
        with patch('dgc.pips.handle_control', side_effect=AssertionError('Closed chat must refuse')):
            self.b._perform_pips_command({'type': 'pips_control', 'request': {
                'type': 'list_workspaces', 'request_id': 'late'}})
        self.assertEqual(self.frames()[-1]['error']['code'], 'chat_closed')
        self.assertTrue(self.send(self.a, {'type': 'list_workspaces', 'request_id': 'still-open'})['ok'])

    def test_start_emits_pips_and_chat_capabilities_and_runs_startup_once(self):
        calls = []
        with patch.object(self.a, '_after_open', side_effect=lambda: calls.append('open')), \
             patch.object(self.a, '_announce_peer', side_effect=lambda _: calls.append('peer')), \
             patch.object(self.a, '_start_peer_heartbeat', side_effect=lambda: calls.append('heartbeat')), \
             patch.object(self.a, '_emit_config', side_effect=lambda: calls.append('config')), \
             patch.object(self.a, '_publish_model_capabilities', side_effect=lambda: calls.append('model')):
            self.a.start()
        self.assertEqual(calls, ['open', 'peer', 'heartbeat', 'config', 'model'])
        ready = self.frames()[0]
        caps = ready['capabilities']
        self.assertEqual(caps['pips_api_version'], 58)
        self.assertTrue(caps['agent_control'] and caps['editor_state'])
        self.assertEqual(caps['chats']['default'], self.a.chat_id)


if __name__ == '__main__':
    unittest.main()
