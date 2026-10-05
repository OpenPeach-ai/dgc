"""Offline conversational setup through real tool dispatch and human CLI controls."""
import contextlib
import copy
import io
import json
import sqlite3
import unittest
from unittest.mock import patch

from dgc import pip_cli, pip_context_tool, pip_setup, pip_setup_tool, pips, workspace_sessions
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_pips_local as local_fixtures
from tests import test_pip_proposal_tool as proposal_fixtures


class PipSetupControlsTests(unittest.TestCase):
    setUp = proposal_fixtures.PipProposalToolTests.setUp
    context = proposal_fixtures.PipProposalToolTests.context
    agent = proposal_fixtures.PipProposalToolTests.agent
    git = local_fixtures.LocalPipsTests.git
    commit = local_fixtures.LocalPipsTests.commit
    create = local_fixtures.LocalPipsTests.create

    def request(self, **changes):
        return dict(target_root=str(self.root), name='Daily source review', goal='Review committed source for regressions.',
                    pip_type='rook', work_kind='source_review', schedule={'type':'daily','time':'11:00','timezone':'Asia/Kolkata'},
                    run_now=False, reason='User requested a daily source review.', request_key='setup-one', **changes)

    def draft(self):
        self.context()
        return pip_setup.propose(self.registry, self.request(), self.root, 'chat-one')

    def reopen(self):
        return WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)

    def invoke(self, *args, expected=0):
        with patch.object(pips, 'WorkspaceRegistry', self.reopen), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')), \
             contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
            code = pip_cli.handle_command(self.cfg, list(args))
        self.assertEqual(code, expected, out.getvalue() + err.getvalue())
        return out.getvalue(), err.getvalue()

    def test_cli_lists_reviews_and_accepts_exact_setup_once(self):
        self.commit()
        draft = self.draft()
        output, _ = self.invoke('setup', 'list')
        self.assertIn(str(self.root), output)
        self.assertIn('Asia/Kolkata', output)
        self.assertIn('Nothing has been saved or run', output)
        output, _ = self.invoke('setup', 'show', draft['id'], '--json')
        self.assertEqual(json.loads(output)['setup']['digest'], draft['digest'])
        args = ('setup', 'accept', draft['id'], '--expected-digest', draft['digest'], '--yes', '--json')
        first, _ = self.invoke(*args)
        second, _ = self.invoke(*args)
        self.assertEqual(json.loads(first)['setup']['receipt'], json.loads(second)['setup']['receipt'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 1)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)

    def test_cli_does_not_accept_without_explicit_confirmation(self):
        draft = self.draft()
        with patch('sys.stdin.isatty', return_value=False):
            _, err = self.invoke('setup', 'accept', draft['id'], '--expected-digest', draft['digest'], expected=1)
        self.assertIn('repeat with --yes', err)
        self.assertEqual(pip_setup.get(self.registry, draft['id'], self.workspace['id'])['status'], 'pending')
        with patch('sys.stdin.isatty', return_value=True), patch('builtins.input', return_value='n'):
            out, _ = self.invoke('setup', 'accept', draft['id'], '--expected-digest', draft['digest'])
        self.assertIn('Cancelled', out)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)

    def test_cli_bad_digest_and_rejection_never_create_job(self):
        draft = self.draft()
        _, err = self.invoke('setup', 'accept', draft['id'], '--expected-digest', '0' * 64, '--yes', expected=1)
        self.assertIn('digest changed', err)
        output, _ = self.invoke('setup', 'reject', draft['id'], '--expected-digest', draft['digest'], '--json')
        self.assertEqual(json.loads(output)['setup']['status'], 'rejected')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)

    def test_control_local_only_and_current_workspace(self):
        draft = self.draft()
        with patch.object(pips, 'WorkspaceRegistry', self.reopen):
            for actor in ('remote-phone', 'model', 'core_setup'):
                result = pips.handle_control(self.cfg, {'request_id':'test', 'type':'accept_pip_setup', 'setup_id':draft['id'], 'expected_digest':draft['digest']}, actor, start_worker=False)
                self.assertFalse(result['ok'])
                self.assertEqual(result['error']['code'], 'local_only')
            result = pips.handle_control(self.cfg, {'request_id':'test', 'type':'list_pip_setups'}, 'editor-user', start_worker=False)
            self.assertTrue(result['ok'])
            self.assertEqual(result['result']['setups'][0]['id'], draft['id'])
            other = self.base / 'other'; other.mkdir()
            other_id = self.registry.resolve(other)['id']
            result = pips.handle_control(self.cfg, {'request_id':'test', 'type':'list_pip_setups','workspace_id':other_id}, 'editor-user', start_worker=False)
            self.assertFalse(result['ok'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)

    def test_card_model_revision_is_human_only_and_does_not_start_a_worker(self):
        draft = self.draft()
        request = {'request_id': 'revise-model', 'type': 'revise_pip_setup', 'setup_id': draft['id'],
                   'expected_digest': draft['digest'], 'model_choice': {'mode': 'model', 'model': 'review-model'}}
        with patch.object(pips, 'WorkspaceRegistry', self.reopen), \
             patch.object(pips, 'start_queued', side_effect=AssertionError('A draft is not a run')):
            for actor in ('remote-phone', 'model', 'core_setup'):
                result = pips.handle_control(self.cfg, request, actor)
                self.assertFalse(result['ok'])
                self.assertEqual(result['error']['code'], 'local_only')
            with patch.object(LLMClient, 'list_models', return_value=['review-model']):
                first = pips.handle_control(self.cfg, request, 'editor-user')
                retry = pips.handle_control(self.cfg, request, 'editor-user')
        self.assertTrue(first['ok'], first)
        self.assertEqual(first, retry)
        self.assertEqual(first['result']['setup']['model_choice'], request['model_choice'])
        self.assertEqual(first['result']['setup']['status'], 'pending')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)


    def test_model_tool_roundtrip_only_drafts_then_human_reviews(self):
        agent, _ = self.agent()
        self.cfg.data.update(mode='auto', api_mode='ollama')
        request = self.request()
        responses = iter([ChatResult(tool_calls=[ToolCall('setup-card', 'pips_setup', request)]),
                          ChatResult(content='Review the setup card in Pips before it starts.')])
        sent = []
        def chat(client, messages, **kwargs):
            sent.append(copy.deepcopy(messages))
            return next(responses)
        with patch.object(pip_setup_tool, 'WorkspaceRegistry', self.reopen), \
             patch.object(workspace_sessions, 'WorkspaceRegistry', self.reopen), \
             patch.object(LLMClient, 'chat', chat), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            self.assertTrue(agent.run_turn('Set up a daily committed-source review at 11 AM Asia/Kolkata.'))
        feedback = next(x for x in sent[-1] if x.get('tool_call_id') == 'setup-card' and x['role'] == 'tool')
        receipt = json.loads(feedback['content'])
        self.assertTrue(receipt['review_required'])
        self.assertFalse(receipt['job_changed_by_this_call'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)

    def test_permission_rules_keep_deny_ask_allow_order(self):
        # Asked like any change; a setup that keeps its own card is not asked twice.
        for mode, expected, card in [('plan', DENY, DENY), ('default', ASK, ALLOW), ('acceptEdits', ASK, ALLOW), ('auto', ALLOW, ALLOW)]:
            self.cfg.data['mode'] = mode
            engine = PermissionEngine(self.cfg.data['mode'], self.cfg.permissions, self.root)
            self.assertEqual(engine.decide('pips_setup', self.request())[0], expected, mode)
            with patch('dgc.pip_setup.needs_card', return_value=True):
                self.assertEqual(engine.decide('pips_setup', self.request())[0], card, mode)
        self.assertEqual(PermissionEngine('default', {'deny': [], 'ask': [], 'allow': ['PipsSetup']}, self.root)
                         .decide('pips_setup', self.request())[0], ALLOW, 'Always allow is an ordinary rule')
        for mode in ('default','acceptEdits','auto'):
            self.assertEqual(PermissionEngine(mode, {'deny':[], 'ask':['PipsSetup'], 'allow':['PipsSetup']}, self.root).decide('pips_setup', self.request())[0], ASK)
        self.cfg.permissions = {'deny':['PipsSetup'], 'ask':[], 'allow':['PipsSetup']}
        self.assertEqual(PermissionEngine(self.cfg.data['mode'], self.cfg.permissions, self.root).decide('pips_setup', self.request())[0], DENY)

    def test_definition_read_discloses_saved_project_calendar_and_pause(self):
        job = self.create()
        proposal = self.store.propose(job['id'], 1, {'schedule':self.request()['schedule']}, 'editor-user')
        self.store.accept(job['id'], proposal['id'], 1, 'editor-user')
        self.store.set_paused(job['id'], True, 'editor-user')
        self.context()
        before = list(self.registry.db.iterdump())
        with patch.object(pip_context_tool, 'WorkspaceRegistry', self.reopen):
            value = json.loads(pip_context_tool.read({'action':'definition','pip_id':job['id']}, self.context()))
        self.assertEqual(value['project_root'], str(self.root))
        from dgc.pip_schedules import validate_schedule
        self.assertEqual(value['pip']['schedule'], validate_schedule(self.request()['schedule']))
        self.assertEqual(value['pip']['status'], 'paused')
        self.assertTrue(value['pip']['next_run_at'])
        self.assertIn('not proof of execution', value['pip']['schedule_notice'])
        self.assertEqual(list(self.registry.db.iterdump()), before)

    def test_setup_tool_never_runs_in_children_monitors_or_disabled_chat(self):
        agent, _ = self.agent()
        self.cfg.data['mode'] = 'auto'
        self.assertIn('pips_setup', {s['function']['name'] for s in agent._tool_schemas()})
        for depth, monitor, enabled in ((1, False, True), (0, True, True), (0, False, False)):
            agent.depth = depth; agent._monitor_turn = monitor; self.cfg.data['pips_enabled'] = enabled
            self.assertNotIn('pips_setup', {s['function']['name'] for s in agent._tool_schemas()})
            with patch.object(pip_setup_tool, 'WorkspaceRegistry', side_effect=AssertionError('Must refuse before opening storage')):
                self.assertIn('main user chat' if enabled else 'disabled',
                              agent._handle_call(ToolCall('forbidden', 'pips_setup', self.request())))

    def test_schema23_adds_empty_drafts_without_changing_job_history(self):
        from tests.pip_test_migrations import drop_setup_schema
        from dgc import workspace_registry
        job = self.create()
        before = self.store.get(job['id'])
        drop_setup_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=22')
        with patch.object(pips.PipStore, 'enqueue', side_effect=AssertionError('No work during migration')), \
             patch.object(pips, 'source_revision', side_effect=AssertionError('No Git during migration')):
            with self.reopen() as upgraded:
                self.assertEqual(upgraded.db.execute('PRAGMA user_version').fetchone()[0], workspace_registry.SCHEMA_VERSION)
                self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_setup_proposals').fetchone()[0], 0)
                self.assertEqual(pips.PipStore(upgraded).get(job['id']), before)
                self.assertEqual(upgraded.db.execute('PRAGMA foreign_key_check').fetchall(), [])

    def test_failed_schema23_migration_rolls_back_ddl_and_version(self):
        from tests.pip_test_migrations import drop_setup_schema
        self.create()
        drop_setup_schema(self.registry.db)
        self.registry.db.execute('PRAGMA user_version=22')
        before = list(self.registry.db.iterdump())
        with patch.object(pip_setup, 'SCHEMA', pip_setup.SCHEMA + '\nINVALID MIGRATION;'), self.assertRaises(sqlite3.OperationalError):
            self.reopen()
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 22)
        self.assertEqual(list(self.registry.db.iterdump()), before)
        with self.reopen() as upgraded:
            self.assertEqual(upgraded.db.execute('SELECT count(*) FROM pip_setup_proposals').fetchone()[0], 0)


if __name__ == '__main__':
    unittest.main()
