"""User-requested UI tools and provider controls through their actual execution boundaries."""
import json
import re
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

from dgc import artifacts, usage_ledger
from dgc.agent import Agent, _tool_intents
from dgc.llm import ChatResult, LLMClient, ToolCall, _reasoning_payload
from dgc.permissions import PermissionEngine
from dgc.tools import execute
from test_options_agent import fixture_config, StubUI, ASK, ANSWER


SELECT_PROMPT = ("ok, i am trying to test this DGC harness, can you propose me a test options , "
                 "for me to select , with your recomendation ? this is just for test , i want to "
                 "see how that feature works , so propose me test options in this dgc so i can select from it.")
PLAN_PROMPT = "can you propose me a test plan whihc you can show me on web browser, thats a new feature dgc has , i want to test it."


class RequestedFeatures(unittest.TestCase):
    def test_labelled_choices_and_recommendation_rationale_are_preserved(self):
        from dgc.questions import normalize_questions
        items = normalize_questions({"questions": [
            {"header": "Test scenario", "label": "Read files", "description": "Small test (Recommended: quick and safe)"},
            {"header": "Test scenario", "label": "Run a command", "recommended": "false"},
        ]})
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0]['question'], 'Test scenario')
        self.assertTrue(items[0]['options'][0]['recommended'])
        self.assertEqual(items[0]['options'][0]['description'], 'Small test (quick and safe)')
        self.assertFalse(items[0]['options'][1]['recommended'])
        items = normalize_questions({'questions': [{'question': 'Which test?',
            'label': 'Read files', 'recommended': True,
            'options': [{'label': 'Read files'}, {'label': 'Run a command'}]}]})
        self.assertTrue(items[0]['options'][0]['recommended'])

    def setUp(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-requested-")
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.ui = StubUI({"outcome": "answered", "answers": ANSWER["answers"]})
        self.agent = Agent(fixture_config(self.root, mode="auto"), self.ui)
        self.addCleanup(self.agent.mcp.stop_all)

    def test_explicit_selector_request_recovers_from_a_prose_menu(self):
        answers = [ChatResult(content="Option 1: Simple. Option 2: Parallel. Which one do you pick?"),
                   ChatResult(tool_calls=[ToolCall("choice", "propose_options", ASK)]),
                   ChatResult(content="You chose Local.")]
        with patch.object(self.agent.client, "chat", side_effect=answers) as call:
            self.agent.run_turn(SELECT_PROMPT)
        self.assertEqual(call.call_count, 3)
        self.assertEqual(len(self.ui.asked), 1)
        self.assertTrue(self.ui.asked[0][0][0]["options"][0]["recommended"])

    def test_requested_recommendation_is_obtained_before_showing_the_card(self):
        missing = {'questions': [{'question': 'Which test?', 'options': ['Read', 'Write']}]}
        answers = [ChatResult(tool_calls=[ToolCall('missing', 'propose_options', missing)]),
                   ChatResult(content='You chose Local.')]
        with patch.object(self.agent.client, 'chat', side_effect=answers):
            self.agent.run_turn(SELECT_PROMPT)
        self.assertEqual(len(self.ui.asked), 1)
        self.assertTrue(self.ui.asked[0][0][0]['options'][0]['recommended'])

    def test_document_available_in_auto_and_plan_without_a_mode_transition(self):
        self.assertIn("document", _tool_intents(PLAN_PROMPT))
        for mode in ("auto", "plan", "default", "acceptEdits"):
            self.agent.set_mode(mode)
            self.agent._active_tool_intents = _tool_intents(PLAN_PROMPT)
            names = {t["function"]["name"] for t in self.agent._tool_schemas()}
            self.assertIn("present_document", names)
            self.assertEqual("present_plan" in names, mode == "plan")
            self.assertEqual(PermissionEngine(mode, {}, self.root).decide("present_document", {})[0], "allow")
        self.assertEqual(PermissionEngine("auto", {"deny": ["PresentDocument"]}, self.root)
                         .decide("present_document", {})[0], "deny")

    def test_plan_or_design_doc_lifts_document_in_auto_without_asking_for_a_browser(self):
        asks = (
            "write a design doc for the agent toni workflow",
            "propose an implementation plan for the FSM",
            "create a technical spec in docs/AGENT_TONI_WORKFLOW_PLAN.md",
            "draft a report on the rollout",
            "give me a plan for the invoice sketch",
            "docs/AGENT_TONI_WORKFLOW_PLAN.md",
        )
        for text in asks:
            self.assertIn("document", _tool_intents(text), text)
            self.agent.set_mode("auto")
            self.agent._active_tool_intents = _tool_intents(text)
            names = {t["function"]["name"] for t in self.agent._tool_schemas()}
            self.assertIn("present_document", names, text)
            self.assertNotIn("present_plan", names, text)
        prompt = self.agent.system_prompt()
        self.assertIn("present_document", prompt)
        self.assertIn("do not skip the URL", prompt)

    def test_ordinary_coding_does_not_lift_document(self):
        for text in (
            "fix the parser",
            "research the auth code",
            "switch to plan mode",
            "implement the queued plan in planning.py",
            "write tests for the report helper",
        ):
            self.assertNotIn("document", _tool_intents(text), text)

    def test_document_serves_exact_markdown_and_inert_light_html(self):
        md = '# A test plan\n\n## Verify\n\n- Test one\n- Test two\n\n<script>alert(1)</script>'
        before = {a.id for a in artifacts._PLAN_SRV.list()}
        result = execute("present_document", {"title": 'Test <plan>', "markdown": md}, self.agent.ctx)
        created = [a.id for a in artifacts._PLAN_SRV.list() if a.id not in before]
        for aid in created:
            self.addCleanup(artifacts._PLAN_SRV.remove, aid)
        urls = re.findall(r'\]\((http://127\.0\.0\.1:[0-9]+/[^)]+)\)', result)
        self.assertEqual(len(urls), 2, result)
        with urllib.request.urlopen(urls[0]) as r:
            html = r.read().decode()
            self.assertIn("default-src 'none'", r.headers['Content-Security-Policy'])
        self.assertIn('color-scheme:light', html)
        self.assertNotIn('<script>alert', html)
        self.assertIn('Test &lt;plan&gt;', html)
        with urllib.request.urlopen(urls[1]) as r:
            self.assertEqual(r.read().decode(), md)
        self.assertEqual(self.agent.mode, 'auto')
        self.assertEqual(list(self.root.iterdir()), [])

    def test_document_rejects_oversized_input(self):
        self.assertTrue(execute('present_document', {'title': 'x', 'markdown': 'x'*200001}, self.agent.ctx).startswith('error:'))

    def test_failed_subagent_result_is_failed_in_live_and_replayed_tool_steps(self):
        from dgc.ui import tool_output_is_error
        from dgc.subagents import classify_result
        result = self.agent._finalize_subagent('Failure probe', None, 'model not found', '')
        self.assertTrue(tool_output_is_error(result.output))
        self.assertEqual(classify_result('Failure probe', result.output)[0], 'failed')
        self.assertTrue(tool_output_is_error(result.output.removeprefix('error: ')))
        self.assertFalse(tool_output_is_error("Sub-task 'ok' completed in the shared checkout. Summary:\nfine"))

    def test_installer_finds_supported_python_after_an_old_system_python(self):
        root = Path(__file__).resolve().parent.parent
        # Execute the installer's actual interpreter selection, stopping before download/install.
        prefix = (root / 'install.sh').read_text().split('realpath_of()', 1)[0]
        old = self.root / 'python3'
        old.write_text('#!/bin/sh\nexit 1\n'); old.chmod(0o700)
        current = self.root / 'python3.13'
        current.symlink_to(sys.executable)
        env = {'PATH': str(self.root), 'DGC_PYTHON': ''}
        result = subprocess.run(['/bin/bash', '-c', prefix + '\nprintf "selected:%s" "$PYTHON"'],
                                env=env, text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('selected:' + str(current), result.stdout)
        env['DGC_PYTHON'] = str(old)
        result = subprocess.run(['/bin/bash', '-c', prefix], env=env,
                                text=True, capture_output=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('DGC_PYTHON must name a working Python', result.stderr)

    def test_public_source_guard_rejects_private_records_but_keeps_provider_docs(self):
        import importlib.util
        script = Path(__file__).resolve().parent.parent / 'scripts/check-public-content.py'
        spec = importlib.util.spec_from_file_location('public_content', script)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        subprocess.run(['git', 'init', '-q', str(self.root)], check=True)
        (self.root / 'providers.md').write_text('Claude and Codex subscription provider setup.\n')
        (self.root / 'WORK-LOG.md').write_text('Private release notes.\n')
        (self.root / 'export.txt').write_text('<send_user_message_' + 'question_reply>')
        subprocess.run(['git', '-C', str(self.root), 'add', '.'], check=True)
        errors = module.check(self.root)
        self.assertEqual(len(errors), 2)
        self.assertTrue(any('WORK-LOG.md' in error for error in errors))
        self.assertTrue(any('export.txt' in error for error in errors))

    def test_native_ollama_levels_are_model_specific(self):
        profiles = ['off', 'low', 'medium', 'high', 'xhigh']
        for model, expected in [
            ('qwen3:8b', [False, True, True, True, True]),
            ('gpt-oss:20b', ['low', 'low', 'medium', 'high', 'high']),
            ('glm-5.3-flash:cloud', ['low', 'low', 'high', 'high', 'max']),
        ]:
            client = LLMClient('http://localhost:11434/v1', 'ollama', model)
            self.assertEqual([client._ollama_think(level) for level in profiles], expected)
        self.assertEqual([_reasoning_payload('ollama', 'glm-5.3-flash:cloud', level)['reasoning_effort']
                          for level in profiles], ['low', 'low', 'high', 'high', 'max'])

    def test_reported_zero_usage_is_not_missing_usage(self):
        from dgc import config
        with patch.object(config, 'USER_HOME', self.root):
            usage_ledger._reset_for_tests()
            self.addCleanup(usage_ledger._reset_for_tests)
            self.agent._ledger_usage(self.agent.client, ChatResult(usage={'prompt_tokens': 0, 'completion_tokens': 0}))
            self.agent._ledger_usage(self.agent.client, ChatResult())
            report = usage_ledger.report('today')
            self.assertEqual(report['totals']['requests'], 2)
            self.assertEqual(report['totals']['unmetered_requests'], 1)

    def test_usage_views_share_one_snapshot_during_a_concurrent_write(self):
        path = self.root / 'usage.sqlite'
        usage_ledger._reset_for_tests()
        self.addCleanup(usage_ledger._reset_for_tests)
        usage_ledger.record(provider='test', base_url='http://localhost', model='model',
                            input_tokens=100, output_tokens=10, path=path)
        original = usage_ledger._open
        inserted = False

        class Connection:
            def __init__(self, db):
                self.db = db

            def execute(self, query, *args):
                nonlocal inserted
                cursor = self.db.execute(query, *args)
                if query.startswith('SELECT COALESCE(SUM(input_tokens)') and not inserted:
                    inserted = True
                    # The read snapshot is established; another process can now commit a row.
                    other = sqlite3.connect(path)
                    try:
                        other.execute('INSERT INTO requests(ts,provider,host,model,source,input_tokens,output_tokens,cached_input_tokens,metered) '
                                      'SELECT ts,provider,host,model,source,input_tokens,output_tokens,cached_input_tokens,metered FROM requests LIMIT 1')
                        other.commit()
                    finally:
                        other.close()
                return cursor

        with patch.object(usage_ledger, '_open', side_effect=lambda *a, **kw: Connection(original(*a, **kw))):
            report = usage_ledger.report('today', path=path)
        self.assertTrue(inserted)
        self.assertEqual(report['totals']['requests'], 1)
        self.assertEqual(sum(row['requests'] for row in report['by_model']), 1)
        self.assertEqual(sum(row['requests'] for row in report['by_day']), 1)
        self.assertEqual(usage_ledger.report('today', path=path)['totals']['requests'], 2)
