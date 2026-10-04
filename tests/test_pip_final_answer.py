"""Native Pip result selection must use the answer, not saved reasoning splices."""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from dgc import pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class PipFinalAnswerTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create
    enqueue = fixtures.LocalPipsTests.enqueue

    def run_answer(self, content, *, thinking='', native=False, kind='audit'):
        self.commit()
        self.cfg.set('preserve_thinking', True, persist=False)
        if kind == 'conversation':
            from dgc import pip_chat
            run = pip_chat.send(self.store,self.create()['id'],'Explain the source','chat-1','device_1',self.cfg)['run']
        elif kind == 'draft':
            job = self.store.create(self.workspace['id'],'Docs','Explain the source','device_1',pip_type='quill')
            run = self.enqueue(job)
        else:
            run = self.enqueue()
        manifest = self.store.run(run['id'])['manifest']
        final = ChatResult(content=content, thinking=thinking)
        if native:
            final.provider_message = {'provider':'ollama','content':content,'thinking':thinking}
        results = iter([ChatResult(tool_calls=[ToolCall('read','read_file',{'path':'source.py'})]), final])
        def chat(_client, _messages, tools=None, on_text=None, **_kwargs):
            result = next(results)
            if result.content and on_text:
                on_text(result.content)
            return result
        with patch.dict(os.environ, {'DGC_SESSION_POLICY':pips._json(pips.native_policy())}), \
             patch.object(LLMClient, 'chat', chat), \
             patch('dgc.agent.discover_skills', return_value={}), \
             patch('dgc.agent.load_memories', return_value=('', '')), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            return pips.execute_native(self.cfg, self.root, manifest, lambda event:None)

    def test_harness_added_reasoning_is_not_part_of_report(self):
        report = {'summary':'Inspected source','findings':[],'limitations':['No tests run']}
        result = self.run_answer(json.dumps(report), thinking='PRIVATE_REASONING_SENTINEL')
        self.assertEqual(result['summary'],report['summary'])
        self.assertNotIn('PRIVATE_REASONING_SENTINEL',json.dumps(result))

    def test_literal_reasoning_tag_inside_valid_json_is_preserved(self):
        summary = 'The literal marker <think> belongs to source text </think>.'
        result = self.run_answer(json.dumps({'summary':summary,'findings':[]}), thinking='Separate private reasoning')
        self.assertEqual(result['summary'],summary)

    def test_native_provider_answer_is_unchanged(self):
        report = {'summary':'Native answer','findings':[]}
        self.assertEqual(self.run_answer(json.dumps(report),thinking='Private native reasoning',native=True)['summary'],report['summary'])

    def test_conversation_does_not_return_saved_private_reasoning(self):
        answer = 'The source defines a greeting helper.'
        self.assertEqual(self.run_answer(answer,thinking='PRIVATE_REASONING_SENTINEL',kind='conversation')['text'],answer)

    def test_draft_uses_the_answer_without_changing_literal_markdown(self):
        draft = {'title':'Greeting helper','summary':'Source draft',
                 'markdown':'# Greeting helper\n\nLiteral `<think>` is documentation text.',
                 'citations':[{'path':'source.py','line':1,'excerpt':"def hello():\n    return 'hello'"}]}
        result = self.run_answer(json.dumps(draft),thinking='PRIVATE_REASONING_SENTINEL',kind='draft')
        self.assertEqual(result['draft']['markdown'],draft['markdown'])

    def test_unmarked_model_prose_remains_invalid(self):
        with self.assertRaisesRegex(RegistryError,'not valid JSON'):
            self.run_answer('<think>model-supplied prose</think>\n{"summary":"Not accepted","findings":[]}')

    def test_malformed_model_json_remains_invalid_after_known_splice(self):
        with self.assertRaisesRegex(RegistryError,'not valid JSON'):
            self.run_answer('{"summary":"Missing comma"\n"findings":[]}',thinking='Private reasoning')
