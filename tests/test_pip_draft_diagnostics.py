"""Quill parse failures expose bounded diagnostics without retaining raw output."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path
import sys
import tempfile
import traceback
import unittest
from unittest.mock import patch

from dgc import pip_drafts as drafts, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='quill-diagnostic-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.source = self.root / 'source.py'
        self.source.write_text('def answer():\n    return 42\n', encoding='utf-8')
        deny_network = patch('requests.sessions.Session.request', side_effect=AssertionError('No network'))
        deny_network.start(); self.addCleanup(deny_network.stop)

    def body(self):
        return {'title': 'Answer helper', 'summary': 'Source draft.',
                'markdown': '# Answer helper\n\nLiteral `<think>` remains source documentation.',
                'citations': [{'path': 'source.py', 'line': 1, 'excerpt': 'def answer():\n    return 42'}]}

    def parse(self, text, *, read_calls=1):
        return drafts.parse_reply(text, self.root, read_calls=read_calls)

    def invalid(self, text, *, code='invalid_draft'):
        with self.assertRaises(RegistryError) as caught:
            self.parse(text)
        self.assertEqual(caught.exception.code, code)
        self.assertLessEqual(len(str(caught.exception).encode()), 512)
        return caught.exception

    def test_valid_draft_preserves_literal_tags_source_and_no_artifact(self):
        body = self.body()
        before = self.source.read_bytes()
        result = self.parse(json.dumps(body))
        self.assertEqual(result, {
            'title': body['title'], 'summary': body['summary'],
            'draft': {'markdown': body['markdown'], 'citations': [
                {**body['citations'][0], 'verification': 'source_excerpt_only'}]},
            'verification': drafts.VERIFICATION, 'tests_executed': False})
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(list(self.root.iterdir()), [self.source])
        self.assertNotIn('artifact', result['draft'])

    def test_exact_reply_byte_limit_is_accepted(self):
        raw = json.dumps(self.body(), ensure_ascii=False)
        raw += ' ' * (drafts.MAX_REPLY_BYTES - len(raw.encode()))
        self.assertEqual(len(raw.encode()), drafts.MAX_REPLY_BYTES)
        self.assertEqual(self.parse(raw)['title'], self.body()['title'])
        with patch.object(drafts.json, 'loads', side_effect=AssertionError('Oversized reply parsed')):
            self.invalid(raw + ' ')

    def test_source_read_gate_precedes_every_parser_diagnostic(self):
        for reads in (0, -1, True, None, '1'):
            with self.subTest(read_calls=reads), patch.object(drafts.json, 'loads', side_effect=AssertionError('No source read')):
                with self.assertRaises(RegistryError) as caught:
                    self.parse('PRIVATE_REPLY\ud800' * 10000, read_calls=reads)
                self.assertEqual(caught.exception.code, 'unverified_draft')

    def test_oversize_characters_are_not_copied_encoded_or_decoded(self):
        class MustNotCopy(str):
            def encode(self, *_args, **_kwargs): raise AssertionError('Oversized response encoded')
            def strip(self, *_args, **_kwargs): raise AssertionError('Oversized response copied')
        with patch.object(drafts.json, 'loads', side_effect=AssertionError('Oversized response parsed')):
            self.invalid(MustNotCopy('x' * (drafts.MAX_REPLY_BYTES + 1)))

    def test_type_empty_bytes_unicode_and_control_preflight_stay_first(self):
        values = (None, False, [], {}, b'{}', '', ' \n\t', '\ud800', 'é' * drafts.MAX_REPLY_BYTES,
                  'PRIVATE_INPUT\x01', 'PRIVATE_INPUT\x7f')
        with patch.object(drafts.json, 'loads', side_effect=AssertionError('Preflight must reject')):
            for value in values:
                with self.subTest(kind=type(value).__name__):
                    self.assertNotIn('PRIVATE_INPUT', str(self.invalid(value)))

    def test_json_category_line_column_and_utf8_bytes_are_exact(self):
        raw = '{"title":"Private é title",\nmarkdown: "never reflected"}'
        error = self.invalid(raw)
        self.assertIn('expected a double-quoted property name at JSON line 2, column 1', str(error))
        self.assertIn(f'({len(raw.encode())} UTF-8 bytes)', str(error))
        self.assertNotIn('Private', str(error)); self.assertNotIn('never reflected', str(error))

    def test_closed_decoder_categories_do_not_echo_response_tokens(self):
        cases = (
            ('PRIVATE_PROSE', 'expected a JSON value'),
            ('{"title" "PRIVATE"}', 'expected a colon'),
            ('{"title":"PRIVATE" "summary":"missing comma"}', 'expected a comma or closing delimiter'),
            ('{"title":"PRIVATE', 'a JSON string is not closed'),
            (r'{"title":"PRIVATE\q"}', 'a JSON string contains an invalid escape'),
            (r'{"title":"PRIVATE\uZZZZ"}', 'a JSON string contains an invalid Unicode escape'),
            ('{"title":"PRIVATE\nLINE"}', 'a JSON string contains an unescaped control character'),
            ('{} PRIVATE_SUFFIX', 'content appears after the JSON value'),
        )
        for raw, category in cases:
            with self.subTest(category=category):
                error = self.invalid(raw)
                self.assertIn(category, str(error)); self.assertNotIn('PRIVATE', str(error))
                self.assertTrue(error.__suppress_context__)

    def test_fences_prose_and_multiple_objects_get_one_parse_without_repair(self):
        good = json.dumps(self.body())
        for raw in ('```json\n' + good + '\n```', '```\n' + good + '\n```',
                    'PRIVATE_PREFACE\n' + good, good + good, good + ' PRIVATE_SUFFIX'):
            original = drafts.json.loads
            with self.subTest(start=raw[:3]), patch.object(drafts.json, 'loads', wraps=original) as decode:
                error = self.invalid(raw)
                self.assertEqual(decode.call_count, 1)
                self.assertNotIn('PRIVATE', str(error))

    def test_duplicate_fields_keep_specific_fixed_refusal(self):
        for raw in ('{"PRIVATE_FIELD":1,"PRIVATE_FIELD":2}',
                    '{"title":"first","title":"PRIVATE_VALUE"}'):
            error = self.invalid(raw)
            self.assertEqual(str(error), 'The draft JSON contains duplicate fields.')
            self.assertTrue(error.__suppress_context__)

    def test_nonfinite_constants_keep_specific_fixed_refusal(self):
        for constant in ('NaN', 'Infinity', '-Infinity'):
            error = self.invalid('{"title":' + constant + '}')
            self.assertEqual(str(error), 'The draft JSON contains a non-finite value.')
            self.assertTrue(error.__suppress_context__)

    def test_unknown_decoder_message_and_document_never_appear_in_traceback(self):
        private = 'PRIVATE_DECODER_SENTINEL'
        decoder = json.JSONDecodeError('Unknown parser error: ' + private, private, 3)
        with patch.object(drafts.json, 'loads', side_effect=decoder):
            try:
                self.parse(json.dumps(self.body()))
            except RegistryError as error:
                rendered = ''.join(traceback.format_exception(type(error), error, error.__traceback__))
                self.assertIn('malformed JSON', str(error))
                self.assertNotIn(private, rendered)
                self.assertTrue(error.__suppress_context__)
            else:
                self.fail('Unknown JSON errors must still refuse.')

    def test_decoder_positions_are_numeric_and_bounded_or_omitted(self):
        for line, column in (('PRIVATE_POSITION', 1), (True, 1), (0, 1), (1, 10 ** 100), (1, [])):
            error = json.JSONDecodeError('unknown', 'x', 0)
            error.lineno, error.colno = line, column
            with patch.object(drafts.json, 'loads', side_effect=error):
                failure = self.invalid('{}')
                self.assertNotIn(' at JSON line ', str(failure))
                self.assertNotIn('PRIVATE_POSITION', str(failure))

    def test_recursion_and_numeric_errors_have_distinct_fixed_messages(self):
        # The native decoder's recursion/digit thresholds differ by Python
        # build. Real hostile documents must refuse; deterministic injected
        # native exception types establish the exact diagnostic branch below.
        self.invalid('[' * 1200 + ']' * 1200)
        for injected, category in ((RecursionError('PRIVATE_DEPTH'), 'JSON nesting limit'),
                                   (ValueError('PRIVATE_VALUE'), 'unsupported JSON value')):
            with patch.object(drafts.json, 'loads', side_effect=injected):
                error = self.invalid('{}')
                self.assertIn(category, str(error)); self.assertNotIn('PRIVATE', str(error))
                self.assertTrue(error.__suppress_context__)
        self.invalid('{"n":' + '9' * 5000 + '}')

    def test_unrelated_exceptions_are_not_mislabeled_as_parser_failures(self):
        for injected in (MemoryError('fixture'), RuntimeError('fixture'), KeyboardInterrupt()):
            with patch.object(drafts.json, 'loads', side_effect=injected):
                with self.assertRaises(type(injected)):
                    self.parse('{}')

    def test_wrong_top_level_and_field_schema_stay_strict(self):
        for raw in ('null', '[]', '42', '"PRIVATE_STRING"', '{}',
                    json.dumps({**self.body(), 'PRIVATE_EXTRA': 'PRIVATE_VALUE'})):
            error = self.invalid(raw)
            self.assertEqual(str(error), 'The draft response needs exactly title, summary, markdown and citations.')

    def test_citation_validation_remains_unchanged(self):
        body = self.body(); body['citations'][0]['excerpt'] = 'PRIVATE_WRONG_SOURCE'
        error = self.invalid(json.dumps(body), code='unverified_draft')
        self.assertIn('does not match its source line', str(error))
        self.assertNotIn('PRIVATE_WRONG_SOURCE', str(error))


class WorkerDiagnosticTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def test_existing_cancellation_precedence_discards_parse_failure(self):
        self.commit()
        job = self.store.create(self.workspace['id'], 'Docs', 'Explain the source helper.', 'user', pip_type='quill')
        run = self.store.enqueue(job['id'], 'cancelled-diagnostic', 'user', self.cfg)
        self.store.claim_next()
        self.store.cancel(run['id'], 'user')
        try:
            drafts.parse_reply('{"title":"PRIVATE_INCOMPLETE"', self.root, read_calls=1)
        except RegistryError as failure:
            result = self.store.finish(run['id'], error={'code': failure.code, 'message': str(failure)})
        else:
            self.fail('Malformed output must fail before completion.')
        self.assertEqual(result['status'], 'cancelled')
        self.assertIsNone(result['result'])
        self.assertIsNone(result['error'])

    def test_fake_provider_worker_transports_refusal_without_result_artifact_or_retry(self):
        self.commit()
        job = self.store.create(self.workspace['id'], 'Docs', 'Explain the source helper.', 'user', pip_type='quill')
        run = self.store.enqueue(job['id'], 'diagnostic-fixture', 'user', self.cfg)
        manifest = json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run['id'],)).fetchone()[0])
        self.store.claim_next()
        malformed = '{"title":"PRIVATE_DRAFT_SENTINEL"\n"summary":"missing comma"}'
        answers = iter([ChatResult(tool_calls=[ToolCall('read', 'read_file', {'path': 'source.py'})]),
                        ChatResult(content=malformed)])
        calls = []
        def chat(_client, _messages, tools=None, on_text=None, **_kwargs):
            calls.append(1)
            answer = next(answers)
            if answer.content and on_text: on_text(answer.content)
            return answer
        payload = {'snapshot': str(self.root), 'manifest': manifest, 'api_key': ''}
        stdin = io.TextIOWrapper(io.BytesIO(pips._json(payload).encode()))
        stdout = io.StringIO()
        self.addCleanup(stdin.close)
        with patch.dict(os.environ, {'DGC_SESSION_POLICY': pips._json(pips.native_policy()),
                                    'DGC_PIP_CONTROLLER_PID': str(os.getppid())}), \
             patch('dgc.config.Config', return_value=self.cfg), \
             patch.object(LLMClient, 'chat', chat), \
             patch('dgc.agent.discover_skills', return_value={}), \
             patch('dgc.agent.load_memories', return_value=('', '')), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')), \
             patch.object(sys, 'stdin', stdin), patch.object(sys, 'stdout', stdout):
            code = pips._worker_main()
        emitted = stdout.getvalue()
        events = [json.loads(line) for line in emitted.splitlines()]
        failures = [item['error'] for item in events if item.get('kind') == 'failure']
        self.assertEqual(code, 1); self.assertEqual(len(calls), 2)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]['code'], 'invalid_draft')
        self.assertIn('expected a comma or closing delimiter', failures[0]['message'])
        self.assertNotIn('PRIVATE_DRAFT_SENTINEL', emitted)
        self.assertFalse(any(item.get('kind') == 'result' for item in events))
        finished = self.store.finish(run['id'], error=failures[0])
        self.assertEqual(finished['status'], 'failed')
        self.assertEqual(finished['error'], failures[0])
        self.assertIsNone(finished['result'])
        self.assertFalse((self.registry.directory / 'runs' / run['id'] / 'artifacts').exists())
