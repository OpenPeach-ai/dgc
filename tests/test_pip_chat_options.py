"""Deterministic per-message inference settings: real queue and Agent, offline provider."""
import copy
import contextlib
import hashlib
import io
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_chat_options as options, pip_cli, pips
from dgc.llm import ChatResult, LLMClient, LLMError
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class PipChatOptionsTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def setup_job(self):
        self.commit()
        self.job = self.create()

    def send(self, settings=None, key='message-1'):
        return pip_chat.send(self.store, self.job['id'], 'Explain the source', key, 'device_1', self.cfg,
                             chat_options=settings)

    def raw(self, sent):
        return json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?',
                          (sent['run']['id'],)).fetchone()[0])

    def finish(self, sent):
        self.store.claim_next()
        self.store.finish(sent['run']['id'], result={'text': 'A source-based response'})

    def test_options_are_exact_bounded_inference_values(self):
        for context in (2048, 8192, 32768, 65536, 131072, 262144, 524288, 1048576):
            for thinking in options.THINKING_LEVELS:
                selected = {'context_size': context, 'thinking': thinking}
                self.assertEqual(options.validate(selected), selected)
                self.assertIsNot(options.validate(selected), selected)
        invalid = [None, {}, [], {'context_size': 8192}, {'thinking': 'off'}]
        invalid += [{'context_size': v, 'thinking': 'off'} for v in (True, 2047, 1048577, 8192.0, '8192')]
        invalid += [{'context_size': 8192, 'thinking': v} for v in (None, True, 'auto', 'max', 'High', [])]
        invalid += [{'context_size': 8192, 'thinking': 'high', key: value}
                    for key, value in (('mode', 'auto'), ('base_url', 'https://bad.invalid'),
                                       ('model', 'other'), ('tools', ['bash']), ('max_tokens', 99999))]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(RegistryError):
                options.validate(value)

    def test_legacy_retry_digest_is_unchanged(self):
        self.assertEqual(pip_chat.request('hello', 'one')['digest'], hashlib.sha256(b'hello').hexdigest())
        first = pip_chat.request('hello', 'one', {'context_size': 8192, 'thinking': 'high'})
        reordered = pip_chat.request('hello', 'one', {'thinking': 'high', 'context_size': 8192})
        self.assertEqual(first, reordered)

    def test_saved_controls_pin_settings_and_preserve_job_and_main_config(self):
        self.setup_job()
        original = copy.deepcopy(self.cfg.data)
        job = self.store.get(self.job['id'])
        selected = {'context_size': 8192, 'thinking': 'high'}
        sent = self.send(selected)
        selected['thinking'] = 'off'
        manifest = self.raw(sent)
        self.assertEqual(manifest['chat_options'], {'context_size': 8192, 'thinking': 'high'})
        self.assertEqual(manifest['model_settings']['context_size'], 8192)
        self.assertEqual(manifest['model_settings']['thinking'], 'high')
        self.assertEqual(manifest['model_settings']['max_tokens'], pips._output_budget(self.cfg), "main DGC's budget")
        self.assertEqual(manifest['model_settings']['max_turns'], 0, 'a Pip run keeps going')
        self.assertEqual(manifest['model_settings']['turn_budget_s'], 0)
        self.assertEqual(manifest['tools'], sorted(pips.READ_TOOLS))
        self.assertEqual(manifest['policy'], 'read_only')
        self.assertEqual(self.store.get(self.job['id'])['model_choice'], job['model_choice'])
        self.assertEqual(self.store.get(self.job['id'])['current_version'], job['current_version'])
        self.assertEqual(self.cfg.data, original)

    def test_changed_settings_retry_refused_before_new_work(self):
        self.setup_job()
        settings = {'context_size': 8192, 'thinking': 'high'}
        sent = self.send(settings)
        self.cfg.set('context_size', 1048576, persist=False)
        self.cfg.set('thinking', 'xhigh', persist=False)
        self.assertEqual(self.send(dict(settings))['run']['id'], sent['run']['id'])
        for changed in (None, {'context_size': 4096, 'thinking': 'high'},
                        {'context_size': 8192, 'thinking': 'off'}):
            with self.assertRaises(RegistryError):
                self.send(changed)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 1)

    def test_a_send_without_options_uses_main_dgcs_window_until_the_pip_has_its_own(self):
        self.setup_job()
        self.cfg.data.update(context_size=1048576, thinking='xhigh')
        manifest = self.raw(self.send())
        self.assertNotIn('chat_options', manifest)
        self.assertEqual(manifest['model_settings']['context_size'], 1048576, 'no 32K cap: main DGC\'s window')
        self.assertEqual(manifest['model_settings']['thinking'], 'off')

    def test_everything_the_pip_does_uses_its_prompt_box_choices(self):
        """Founder, 2026-10-14: the prompt box sets the Pip's context window and thinking, for its replies and for the
        work it does on its own."""
        self.setup_job()
        self.finish(self.send({'context_size': 8192, 'thinking': 'high'}))
        self.assertEqual(options.saved(self.registry.db, self.job['id']), {'context_size': 8192, 'thinking': 'high'})
        run = self.store.enqueue(self.job['id'], 'audit', 'device_1', self.cfg)
        manifest = self.raw({'run': run})
        self.assertNotIn('chat_options', manifest)
        self.assertEqual(manifest['run_kind'], 'audit')
        self.assertEqual(manifest['model_settings']['context_size'], 8192)
        self.assertEqual(manifest['model_settings']['thinking'], 'high')
        self.assertEqual(manifest['limits']['wall_seconds'], 0)

    def test_the_prompt_box_saves_the_pips_choices_without_a_reply(self):
        self.setup_job()
        here = lambda *a, **k: WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)  # noqa: E731
        patcher = patch.object(pips, 'WorkspaceRegistry', here)
        patcher.start()
        self.addCleanup(patcher.stop)
        result = pips.handle_control(self.cfg, {'type': 'set_pip_chat_options', 'request_id': 'r1', 'pip_id': self.job['id'],
                                                'chat_options': {'context_size': 131072, 'thinking': 'medium'}},
                                     'editor-user')
        self.assertTrue(result['ok'], result)
        controls = result['result']['chat_controls']
        self.assertEqual(controls['options'], {'context_size': 131072, 'thinking': 'medium'})
        self.assertEqual(controls['options_source'], 'last_message', 'the remembered choice editors since API 24 know')
        audit = self.raw({'run': self.store.enqueue(self.job['id'], 'audit-saved', 'device_1', self.cfg)})
        self.assertEqual((audit['model_settings']['context_size'], audit['model_settings']['thinking']), (131072, 'medium'))
        for bad in ({'context_size': 1024, 'thinking': 'off'}, {'context_size': 8192}, None):
            refused = pips.handle_control(self.cfg, {'type': 'set_pip_chat_options', 'request_id': 'r1', 'pip_id': self.job['id'],
                                                     'chat_options': bad}, 'editor-user')
            self.assertFalse(refused['ok'], bad)
        other = pips.handle_control(self.cfg, {'type': 'set_pip_chat_options', 'request_id': 'r1', 'pip_id': self.job['id'],
                                               'chat_options': {'context_size': 8192, 'thinking': 'off'}}, 'main-chat')
        self.assertFalse(other['ok'], 'only the user, on this computer')

    def test_default_controls_inherit_main_context_without_network(self):
        self.setup_job()
        self.cfg.data.update(context_size=1048576, thinking='xhigh')
        with patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pip_chat.list_messages(self.store, self.job['id'], config=self.cfg)['chat_controls']
        self.assertEqual(result['inherited_context_size'], 1048576)
        self.assertEqual(result['effective_context_size'], 1048576)
        self.assertEqual(result['options'], {'context_size': 1048576, 'thinking': 'off'})
        self.assertEqual(result['options_source'], 'default')
        self.assertEqual(result['mode'], 'read_only')
        self.assertIn('provider', result['context_note'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)

    def test_last_message_controls_survive_reopen_and_are_per_pip(self):
        self.setup_job()
        selected = {'context_size': 16384, 'thinking': 'medium'}
        self.send(selected)
        other = self.create()
        with WorkspaceRegistry(self.registry.directory) as registry:
            store = pips.PipStore(registry)
            saved = pip_chat.list_messages(store, self.job['id'], config=self.cfg)['chat_controls']
            fresh = pip_chat.list_messages(store, other['id'], config=self.cfg)['chat_controls']
        self.assertEqual(saved['options'], selected)
        self.assertEqual(saved['options_source'], 'last_message')
        self.assertEqual(fresh['options_source'], 'default')
        self.assertEqual(fresh['options']['thinking'], 'off')

    def test_known_reasoning_unsupported_explains_instruction_guidance(self):
        self.setup_job()
        self.cfg.set('provider_capabilities', {'reasoning': False}, persist=False)
        with patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            controls = options.controls(self.store, self.job['id'], self.cfg)
        self.assertEqual(controls['reasoning_control'], 'instructions')
        self.assertIn('instruction guidance only', controls['reasoning_note'])
        manifest = self.raw(self.send({'context_size': 8192, 'thinking': 'high'}))
        self.assertEqual(manifest['model_settings']['provider_capabilities'], {'reasoning': False})

    def test_provider_payloads_keep_reasoning_within_original_request_cap(self):
        with patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            client = LLMClient('https://api.anthropic.com', '', 'claude-sonnet-4-5', api_mode='anthropic',
                               max_tokens=4096, context_size=32768, think_budget_tokens=2048)
            options.bind_client(client)
            for level in options.THINKING_LEVELS:
                payload = client._anthropic_payload([{'role': 'user', 'content': 'Inspect source'}], None, level, set())
                self.assertLessEqual(payload['max_tokens'], 4096)
                if payload.get('thinking', {}).get('type') == 'enabled':
                    self.assertLess(payload['thinking']['budget_tokens'], payload['max_tokens'])
            ollama = LLMClient('http://localhost:11434', '', 'qwen3', api_mode='ollama',
                               max_tokens=4096, context_size=32768, think_budget_tokens=2048)
            options.bind_client(ollama)
            self.assertEqual(ollama._ollama_think('high'), 'high')
            self.assertLessEqual(ollama._request_max_tokens('xhigh'), 4096)

    def test_invalid_options_never_enqueue_or_change_jobs(self):
        self.setup_job()
        before = self.store.get(self.job['id'])
        for bad in ({}, {'context_size': 1048577, 'thinking': 'off'},
                    {'context_size': 8192, 'thinking': 'high', 'mode': 'auto'}):
            with self.assertRaises(RegistryError):
                self.send(bad)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_chat_messages').fetchone()[0], 0)
        self.assertEqual(self.store.get(self.job['id']), before)

    def test_provider_cap_rejection_never_retries_without_cap(self):
        import requests
        cases = [('ollama', 'http://cap-ollama.invalid:11434', 'qwen3', 'num_predict'),
                 ('chat_completions', 'http://cap-chat.invalid/v1', 'fixture', 'max_tokens'),
                 ('responses', 'https://cap-responses.invalid/v1', 'gpt-5', 'max_output_tokens')]
        for mode, base, model, field in cases:
            with self.subTest(mode=mode):
                client = LLMClient(base, '', model, api_mode=mode, max_tokens=4096,
                                   context_size=8192, think_budget_tokens=1024)
                options.bind_client(client)
                sent = []
                def post(url, **kwargs):
                    sent.append(copy.deepcopy(kwargs['json']))
                    response = requests.Response()
                    response.status_code = 400
                    response._content = json.dumps({'error': 'unsupported parameter ' + field}).encode()
                    response._content_consumed = True
                    return response
                with patch('requests.post', side_effect=post), \
                     patch.object(client, 'prepare_model', return_value={}), \
                     patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
                    with self.assertRaisesRegex(LLMError, 'No uncapped request'):
                        client.chat([{'role': 'user', 'content': 'Read source'}], reasoning_effort='medium')
                self.assertEqual(len(sent), 1)
                payload = sent[0]['options'] if mode == 'ollama' else sent[0]
                self.assertGreater(payload[field], 0)
                self.assertLessEqual(payload[field], 4096)

    def test_cached_or_explicit_unsupported_output_cap_fails_before_network(self):
        for cached in (False, True):
            client = LLMClient('http://cap-disabled.invalid/v1', '', f'fixture-{cached}',
                               api_mode='chat_completions', max_tokens=4096,
                               provider_capabilities={} if cached else {'max_output_tokens': False})
            if cached:
                client._mark_rejected('max_output_tokens')
            with patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
                with self.assertRaisesRegex(LLMError, 'required for a bounded Pip reply'):
                    options.bind_client(client)

    def test_manifest_options_refuse_wrong_kind_or_changed_pins(self):
        self.setup_job()
        manifest = self.raw(self.send({'context_size': 8192, 'thinking': 'high'}))
        self.assertEqual(options.validate_manifest(manifest), manifest['chat_options'])
        changes = [('run_kind', 'audit'), ('chat_options', {'context_size': 8192, 'thinking': 'off'})]
        for key, value in changes:
            broken = copy.deepcopy(manifest); broken[key] = value
            with self.assertRaises(RegistryError):
                options.validate_manifest(broken)
        for key, value in (('context_size', 32768), ('thinking', 'off'), ('think_budget_tokens', 99999),
                           ('max_tokens', 0), ('max_tokens', '4096'), ('max_turns', -1), ('max_turns', None)):
            broken = copy.deepcopy(manifest); broken['model_settings'][key] = value
            with self.assertRaises(RegistryError):
                options.validate_manifest(broken)

    def test_effort_uses_real_agent_provider_mapping_inside_fixed_output_budget(self):
        self.setup_job()
        self.cfg.data.update(api_mode='ollama', provider_capabilities={'reasoning': True})
        manifest = self.raw(self.send({'context_size': 8192, 'thinking': 'high'}))
        before = copy.deepcopy(self.cfg.data)
        calls = []
        def chat(client, messages, tools=None, **kwargs):
            calls.append(kwargs['reasoning_effort'])
            self.assertEqual(client.context_size, 8192)
            self.assertLessEqual(client._request_max_tokens('xhigh'), 4096)
            self.assertTrue({t['function']['name'] for t in tools} <= pips.READ_TOOLS)
            self.assertIn('Reason deeply', messages[0]['content'])
            return ChatResult(content='Source-only reply')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy())}), \
             patch.object(LLMClient, 'chat', chat), patch('dgc.agent.discover_skills', return_value={}), \
             patch.object(LLMClient, 'prepare_model', return_value={}), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        self.assertEqual(result['text'], 'Source-only reply')
        self.assertEqual(calls, ['high'])
        self.assertEqual(self.cfg.data, before)

    def test_explicit_off_cannot_be_overridden_by_prompt_keywords(self):
        self.setup_job()
        sent = pip_chat.send(self.store, self.job['id'], 'ultrathink about this source', 'off', 'device_1',
                             self.cfg, chat_options={'context_size': 8192, 'thinking': 'off'})
        levels = []
        def chat(client, messages, **kwargs):
            levels.append(kwargs['reasoning_effort'])
            return ChatResult(content='Source-only reply')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy())}), \
             patch.object(LLMClient, 'chat', chat), patch('dgc.agent.discover_skills', return_value={}), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            pips.execute_native(self.cfg, self.root, self.raw(sent), lambda event: None)
        self.assertEqual(levels, ['off'])

    def test_control_rejects_null_and_exposes_metadata(self):
        self.setup_job()
        def reopen(*args, **kwargs):
            return WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)
        with patch.object(pips, 'WorkspaceRegistry', reopen):
            request = {'type': 'send_pip_message', 'request_id': 'one', 'pip_id': self.job['id'],
                       'text': 'Explain', 'idempotency_key': 'one', 'chat_options': None}
            rejected = pips.handle_control(self.cfg, request, 'editor-user', start_worker=False)
            self.assertFalse(rejected['ok'])
            self.assertEqual(rejected['error']['code'], 'invalid_chat_options')
            result = pips.handle_control(self.cfg, {'type': 'list_pip_messages', 'request_id': 'two',
                                        'pip_id': self.job['id']}, 'editor-user', start_worker=False)
            self.assertTrue(result['ok'], result)
            self.assertEqual(result['result']['chat_controls']['version'], 1)

    def test_cli_flags_use_same_request_contract(self):
        self.setup_job()
        arguments = ['send', self.job['id'], 'Explain the source', '--context-size', '8192',
                     '--thinking', 'medium', '--idempotency-key', 'cli-message', '--json']
        def reopen(*args, **kwargs):
            return WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)
        with patch.object(pips, 'WorkspaceRegistry', reopen), patch.object(pip_cli, '_require_supervisor'), \
             contextlib.redirect_stdout(io.StringIO()) as output, \
             contextlib.redirect_stderr(io.StringIO()) as error:
            code = pip_cli.handle_command(self.cfg, arguments)
        self.assertEqual(code, 0, error.getvalue())
        result = json.loads(output.getvalue())
        self.assertEqual(self.raw(result)['chat_options'], {'context_size': 8192, 'thinking': 'medium'})

    def test_cli_partial_options_fail_before_supervisor_and_no_side_effects(self):
        self.setup_job()
        for flags in (['--context-size', '8192'], ['--thinking', 'high'],
                      ['--context-size', '1048577', '--thinking', 'low']):
            with patch.object(pip_cli, '_require_supervisor', side_effect=AssertionError('Must reject first')), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()) as error:
                code = pip_cli.handle_command(self.cfg, ['send', self.job['id'], 'Explain', *flags])
            self.assertEqual(code, 1)
            self.assertIn('context', error.getvalue())
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)

    def test_large_reply_budget_is_pinned_without_broadening_scheduled_work(self):
        self.setup_job()
        sent = self.send({'context_size': 262144, 'thinking': 'medium'})
        manifest = self.raw(sent)
        self.assertEqual(manifest['model_settings']['context_size'], 262144)
        self.assertEqual(manifest['model_settings']['max_tokens'], pips._output_budget(self.cfg))
        self.assertEqual(manifest['tools'], sorted(pips.READ_TOOLS))
        self.assertEqual(options.validate_manifest(manifest)['context_size'], 262144)
        self.finish(sent)
        audit = self.raw({'run': self.store.enqueue(self.job['id'], 'audit-large-context', 'device_1', self.cfg)})
        self.assertEqual(audit['model_settings']['context_size'], 262144, "the Pip's window, for its own work too")

    def test_small_and_large_history_budgets_select_whole_pairs_without_six_pair_cutoff(self):
        self.setup_job()
        for index in range(12):
            sent = pip_chat.send(self.store, self.job['id'], f'Question {index}', str(index),
                                 'device_1', self.cfg)
            self.store.claim_next()
            self.store.finish(sent['run']['id'], result={'text': 'Answer ' + str(index) + ' x' * 500})
        small_sent = self.send({'context_size': 2048, 'thinking': 'off'}, 'small')
        small = self.raw(small_sent)
        self.assertLess(len(small['conversation']['history']), 24)
        self.assertEqual(len(small['conversation']['history']) % 2, 0)
        self.assertLessEqual(len(pip_chat._json(small['conversation']['history']).encode()), 4096)
        self.assertEqual(small['conversation']['history_omitted_count'], 0)
        self.assertGreater(small['conversation']['continuity']['state']['messages'], 0)
        self.finish(small_sent)
        large = self.raw(self.send({'context_size': 131072, 'thinking': 'off'}, 'large'))
        self.assertEqual(len(large['conversation']['history']), 26)
        self.assertEqual(large['conversation']['history_omitted_count'], 0)
        self.assertLessEqual(len(pip_chat._json(large['conversation']['history']).encode()), pip_chat.MAX_CONTEXT_BYTES)
        controls = pip_chat.list_messages(self.store, self.job['id'], config=self.cfg)
        self.assertEqual(controls['chat_controls']['context_max'], 1048576)
        self.assertEqual(controls['history_context_omitted_count'], 0)
        self.assertIn('saved continuation brief', controls['chat_controls']['context_note'])

    def test_history_budget_refuses_oversize_pair_before_fetching_body(self):
        self.setup_job()
        first = self.send(key='first')
        self.store.claim_next()
        self.store.finish(first['run']['id'], result={'text': 'x' * 20000})
        seen = []
        self.registry.db.set_trace_callback(seen.append)
        try:
            self.assertEqual(pip_chat.snapshot(self.store, self.job['id'], context_size=2048), ([], 2))
        finally:
            self.registry.db.set_trace_callback(None)
        self.assertFalse(any(statement.startswith('SELECT text FROM pip_chat_messages') for statement in seen))

    def test_large_context_reaches_real_provider_adapter_and_keeps_compaction_loop(self):
        from dgc.agent import Agent
        self.setup_job()
        manifest = self.raw(self.send({'context_size': 262144, 'thinking': 'medium'}))
        observed = []
        original_compact = Agent.maybe_compact
        def compact(agent, *args, **kwargs):
            observed.append(agent.context_size())
            return original_compact(agent, *args, **kwargs)
        def chat(client, messages, tools=None, **kwargs):
            self.assertEqual(client.context_size, 262144)
            self.assertLessEqual(client._request_max_tokens('medium'), max(pips._output_budget(self.cfg), 4096) + 2048)
            return ChatResult(content='The selected large window uses the normal DGC loop.')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy())}), \
             patch.object(Agent, 'maybe_compact', compact), patch.object(LLMClient, 'chat', chat), \
             patch('dgc.agent.discover_skills', return_value={}), \
             patch.object(LLMClient, 'prepare_model', return_value={}), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        self.assertIn('large window', result['text'])
        self.assertTrue(observed)
        self.assertTrue(all(size == 262144 for size in observed))

    def test_provider_smaller_window_triggers_real_in_reply_compaction(self):
        self.setup_job()
        for index in range(10):
            sent = pip_chat.send(self.store, self.job['id'], f'Question {index}', str(index),
                                 'device_1', self.cfg)
            self.store.claim_next()
            self.store.finish(sent['run']['id'], result={'text': f'Reply {index} ' + 'source detail ' * 80})
        manifest = self.raw(self.send({'context_size': 8192, 'thinking': 'off'}, 'compact'))
        calls = []
        def chat(client, messages, tools=None, **kwargs):
            calls.append((client.usage_source, copy.deepcopy(messages)))
            if client.usage_source == 'compaction':
                return ChatResult(content='## Goal\nAnswer the user.\n## Progress\nInspected earlier source.\n## Next\nExplain the source.')
            return ChatResult(content='Continued after automatic context compaction.')
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy())}), \
             patch.object(LLMClient, 'chat', chat), \
             patch.object(LLMClient, 'effective_context_size', return_value=2048), \
             patch.object(LLMClient, 'compact_responses', return_value=None), \
             patch('dgc.agent.discover_skills', return_value={}), \
             patch.object(LLMClient, 'prepare_model', return_value={}), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        self.assertTrue(any(source == 'compaction' for source, _ in calls))
        final_messages = next(messages for source, messages in reversed(calls) if source != 'compaction')
        self.assertTrue(any('[Earlier conversation compacted to this summary]' in str(m.get('content')) for m in final_messages))
        self.assertEqual(result['text'], 'Continued after automatic context compaction.')
        self.assertNotIn('continuation', result)  # This test does not claim cross-reply persistence.

    def test_cli_no_flags_keeps_legacy_request_shape(self):
        request = pip_cli._request(pip_cli.parser().parse_args(['send', 'pip-placeholder', 'Explain']))
        self.assertNotIn('chat_options', request)


if __name__ == '__main__':
    unittest.main()
