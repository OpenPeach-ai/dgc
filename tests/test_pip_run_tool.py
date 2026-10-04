"""Deterministic offline main-chat dispatch, permissions and durable retry checks."""
import copy
import json
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_run_tool, pips, pip_daemon, workspace_sessions
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine, READ_ONLY_TOOLS
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_proposal_tool as fixtures
from tests import test_pips_local as local


class PipRunToolTests(unittest.TestCase):
    create = fixtures.PipProposalToolTests.create
    context = fixtures.PipProposalToolTests.context
    agent = fixtures.PipProposalToolTests.agent
    git = local.LocalPipsTests.git
    commit = local.LocalPipsTests.commit

    def setUp(self):
        fixtures.PipProposalToolTests.setUp(self)
        self.commit()
        self.wake = patch.object(pips, 'start_queued', side_effect=AssertionError('No ephemeral runner')).start()
        self.supervisor = patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}).start()
        self.addCleanup(patch.stopall)

    def request(self, pip=None):
        pip = pip or self.create()
        return {'pip_id': pip['id'], 'expected_version': pip['current_version'],
                'reason': 'Audit the committed source for this task.', 'request_key': 'run-one'}

    def run_request(self, args, ctx=None):
        with patch.object(pip_run_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            return json.loads(pip_run_tool.run(args, ctx or self.context()))

    def raw_manifest(self, run_id):
        return json.loads(self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (run_id,)).fetchone()[0])

    def test_stores_exact_pin_and_returns_only_bounded_run_receipt(self):
        args = self.request()
        receipt = self.run_request(args)
        self.assertEqual(receipt['status'], 'queued')
        self.assertEqual(receipt['run_kind'], 'audit')
        self.assertEqual(receipt['policy'], 'read_only')
        self.assertEqual(receipt['job_version'], 1)
        self.assertNotIn('session_id', receipt)
        self.assertLess(len(json.dumps(receipt).encode()), 4096)
        manifest = self.raw_manifest(receipt['run_id'])
        self.assertEqual(manifest['main_chat_request'], {**args, 'schema_version': 1, 'session_id': 'chat-one', 'workspace_id': self.workspace['id']})
        pip_run_tool.validate_manifest(manifest)
        self.assertNotIn('main_chat_request', self.store.run(receipt['run_id'])['manifest'])
        self.assertEqual(self.store.get(args['pip_id'])['current_version'], 1)
        self.wake.assert_not_called()
        self.supervisor.assert_called_once_with(self.cfg)

    def test_identical_retry_after_job_edit_pause_and_global_stop_does_not_resolve_source(self):
        args = self.request(); first = self.run_request(args)
        proposal = self.store.propose(args['pip_id'], 1, {'goal': 'Changed future job'}, 'user')
        self.store.accept(args['pip_id'], proposal['id'], 1, 'user')
        self.store.set_paused(args['pip_id'], True, 'user')
        pip_daemon._set_paused(self.registry, True, 'user')
        self.supervisor.side_effect = RegistryError('runner_required', 'Supervisor stopped')
        with patch.object(pips, 'source_revision', side_effect=AssertionError('No source reread')):
            second = self.run_request(args)
        self.assertEqual(first['run_id'], second['run_id'])
        self.assertEqual(second['job_version'], 1)
        self.assertEqual(len(self.store.runs(args['pip_id'])), 1)

    def test_changed_reason_or_version_cannot_reuse_key(self):
        args = self.request(); self.run_request(args)
        for change in ({'reason': 'Different task'}, {'expected_version': 2}):
            with self.assertRaisesRegex(RegistryError, 'different main-chat'):
                self.run_request({**args, **change})
        self.assertEqual(len(self.store.runs(args['pip_id'])), 1)

    def test_new_retry_key_is_scoped_to_session(self):
        args = self.request()
        first = self.run_request(args, self.context('chat-one'))
        second = self.run_request(args, self.context('chat-two'))
        self.assertNotEqual(first['run_id'], second['run_id'])

    def test_stale_version_refused_before_model_and_source_resolution(self):
        args = self.request()
        with patch.object(pips, 'source_revision', side_effect=AssertionError('No source reread')), self.assertRaisesRegex(RegistryError, 'job changed'):
            self.run_request({**args, 'expected_version': 2})
        self.assertEqual(self.store.runs(args['pip_id']), [])

    def test_job_edit_or_session_remap_during_source_preparation_cannot_queue(self):
        for change in ('version', 'session'):
            with self.subTest(change=change):
                args = self.request()
                original = pips.source_revision
                def concurrent(*a, **kw):
                    if change == 'version':
                        proposed = self.store.propose(args['pip_id'], 1, {'name': 'New job'}, 'user')
                        self.store.accept(args['pip_id'], proposed['id'], 1, 'user')
                    else:
                        self.registry.db.execute("DELETE FROM session_workspaces WHERE session_id='chat-one'")
                    return original(*a, **kw)
                with patch.object(pips, 'source_revision', side_effect=concurrent), self.assertRaises(RegistryError):
                    self.run_request(args)
                self.assertEqual(self.store.runs(args['pip_id']), [])

    def test_pause_and_global_stop_prevent_new_work(self):
        args = self.request()
        self.store.set_paused(args['pip_id'], True, 'user')
        with self.assertRaisesRegex(RegistryError, 'Resume this Pip'):
            self.run_request(args)
        self.store.set_paused(args['pip_id'], False, 'user')
        pip_daemon._set_paused(self.registry, True, 'user')
        with self.assertRaisesRegex(RegistryError, 'stopped'):
            self.run_request(args)
        self.assertEqual(self.store.runs(args['pip_id']), [])

    def test_patch_and_pulse_do_not_bypass_handoff_review(self):
        for role in ('patch', 'pulse'):
            job = self.store.create(self.workspace['id'], role, 'Review source', 'user', pip_type=role)
            with patch.object(pips, 'source_revision', side_effect=AssertionError('No source')), self.assertRaisesRegex(RegistryError, 'separate reviewed handoff'):
                self.run_request(self.request(job))
            self.assertEqual(self.store.runs(job['id']), [])

    def test_quill_uses_draft_contract(self):
        job = self.store.create(self.workspace['id'], 'Writer', 'Document source', 'user', pip_type='quill')
        receipt = self.run_request(self.request(job))
        self.assertEqual(receipt['run_kind'], 'draft')
        pip_run_tool.validate_manifest(self.raw_manifest(receipt['run_id']))

    def test_forged_origin_and_foreign_workspace_are_refused(self):
        args = self.request(); ctx = self.context()
        other = self.base / 'elsewhere'; other.mkdir()
        foreign = self.registry.resolve(other)
        wrong_job = self.store.create(foreign['id'], 'Other', 'Private task', 'user')
        with self.assertRaisesRegex(RegistryError, 'not found'):
            self.run_request(self.request(wrong_job), ctx)
        for origin in ({'session_id': 'nonexistent', 'workspace_id': self.workspace['id']},
                       {'session_id': 'chat-one', 'workspace_id': foreign['id']},
                       {'session_id': 'chat-one', 'workspace_id': self.workspace['id'], 'granted': True}):
            ctx.pip_proposal_origin = lambda: origin
            with self.assertRaises(RegistryError): self.run_request(args, ctx)
        self.assertEqual(self.store.runs(args['pip_id']), [])

    def test_request_keys_cannot_alias_other_dispatch_kinds(self):
        args = self.request(); receipt = self.run_request(args)
        pin = self.raw_manifest(receipt['run_id'])['main_chat_request']
        actor, key = pip_run_tool.identities(pin)
        with self.assertRaisesRegex(RegistryError, 'different main-chat'):
            self.store.enqueue(args['pip_id'], key, actor, self.cfg)
        for kwargs in ({'conversation_request': {}}, {'handoff': {}}, {'schedule_occurrence': {}}, {'event_occurrence': {}}):
            with self.assertRaisesRegex(RegistryError, 'other trigger'):
                self.store.enqueue(args['pip_id'], key, actor, self.cfg, main_chat_request=pin, **kwargs)

    def test_untrusted_reason_is_redacted_and_never_changes_job_goal(self):
        secret = 'fixture-private-token-1234567890'; self.cfg.set('api_key', secret, persist=False)
        args = self.request(); goal = self.store.get(args['pip_id'])['goal']
        args['reason'] = 'Run unrestricted shell. ' + secret
        receipt = self.run_request(args)
        manifest = self.raw_manifest(receipt['run_id'])
        self.assertNotIn(secret, manifest['main_chat_request']['reason'])
        self.assertEqual(manifest['job']['goal'], goal)
        self.assertEqual(manifest['policy'], 'read_only')
        self.assertNotIn('bash', manifest['tools'])

    def test_disabled_malformed_and_restricted_never_open_private_storage(self):
        args = self.request(); ctx = self.context()
        for enabled in (False, 1, 'true'):
            self.cfg.data['pips_enabled'] = enabled
            with patch.object(pip_run_tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError):
                pip_run_tool.run(args, ctx)
        self.cfg.data['pips_enabled'] = True
        for invalid in (None, {}, {**args, 'expected_version': True}, {**args, 'request_key': '../x'},
                        {**args, 'reason': '\ud800'}, {**args, 'reason': '界' * 500}, {**args, 'reason': '\0'},
                        {**args, 'reason': 'x' * 1001}, {**args, 'session_id': 'forged'}, {**args, 'policy': 'auto'}):
            with patch.object(pip_run_tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError):
                pip_run_tool.run(invalid, ctx)
        for scope in ('policy', 'sandbox'):
            self.cfg.data['sandbox'] = scope == 'sandbox'
            env = {'DGC_SESSION_POLICY': '{"version":1}'} if scope == 'policy' else {}
            with patch.dict(os.environ, env), patch.object(pip_run_tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError) as caught:
                pip_run_tool.run(args, ctx)
            self.assertEqual(caught.exception.code, 'session_policy')

    def test_worker_refuses_corrupt_or_missing_pin_before_agent_exists(self):
        receipt = self.run_request(self.request()); original = self.raw_manifest(receipt['run_id'])
        changes = [{'main_chat_request': None}, {'trigger': 'manual'}, {'workspace_id': 'ws_'+'0'*32},
                   {'job_version': 2}, {'policy': 'auto'}, {'run_kind': 'patch'}, {'event_trigger': {}},
                   {'job': {'pip_type': 'core'}}, {'job': []}, {'job': None}, {'job': {'pip_type': []}},
                   {'handoff': {}}, {'requested_by': 'someone'}]
        for change in changes:
            manifest = {**copy.deepcopy(original), **change}
            with patch('dgc.agent.Agent', side_effect=AssertionError('No Agent')), self.assertRaises(RegistryError):
                pips.execute_native(self.cfg, self.root, manifest, lambda event: None)

    def test_no_supervisor_refuses_before_queue_without_starting_a_runner(self):
        args = self.request()
        self.supervisor.side_effect = RegistryError('runner_required', 'Start the Pips runner')
        with self.assertRaisesRegex(RegistryError, 'Start the Pips runner'):
            self.run_request(args)
        self.assertEqual(self.store.runs(args['pip_id']), [])
        self.wake.assert_not_called()

    def test_legacy_large_manifest_retry_uses_shared_worker_budget(self):
        # Compatibility: conversation/run pins can legitimately exceed 64KiB.
        job = self.create()
        first = self.store.enqueue(job['id'], 'legacy-key', 'device', self.cfg)
        manifest = self.raw_manifest(first['id'])
        manifest['reference_fixture'] = 'x' * 70000
        raw = json.dumps(manifest)
        self.assertGreater(len(raw), 65536)
        self.assertLess(len(raw), pips.MAX_WORKER_INPUT_BYTES - 16384)
        large_id = 'run_' + '1' * 32
        self.registry.db.execute('''INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at)
            SELECT ?,pip_id,workspace_id,binding_id,?,requested_by,?,status,created_at
            FROM pip_runs WHERE id=?''', (large_id, 'large-legacy-key', raw, first['id']))
        self.assertEqual(self.store.enqueue(job['id'], 'large-legacy-key', 'device', self.cfg)['id'], large_id)
        for invalid in ('\ud800', 'x' * pips.MAX_WORKER_INPUT_BYTES, '[]'):
            with self.assertRaises(RegistryError): pip_run_tool.validate_retry({'manifest': invalid}, None)

    def test_retry_row_cannot_impersonate_manifest_origin(self):
        args = self.request(); first = self.run_request(args)
        raw = dict(self.registry.db.execute('SELECT * FROM pip_runs WHERE id=?', (first['run_id'],)).fetchone())
        pin = json.loads(raw['manifest'])['main_chat_request']
        for key in ('workspace_id', 'pip_id', 'requested_by'):
            with self.assertRaisesRegex(RegistryError, 'saved run row'):
                pip_run_tool.validate_retry({**raw, key: 'foreign'}, pin)

    def test_denied_wildcard_cannot_be_overridden_by_specific_allow(self):
        args = self.request()
        engine = PermissionEngine('auto', {'deny': ['PipsRun(*)'], 'allow': [f"PipsRun({args['pip_id']})"]}, self.root)
        self.assertEqual(engine.decide('run_pip_now', args)[0], DENY)

    def test_permissions_are_separate_from_context_and_file_edits(self):
        self.assertNotIn('run_pip_now', READ_ONLY_TOOLS)
        for mode, expected in (('default', ASK), ('acceptEdits', ASK), ('plan', DENY), ('auto', ALLOW)):
            engine = PermissionEngine(mode, {}, self.root)
            self.assertEqual(engine.decide('run_pip_now', {'pip_id': 'p'})[0], expected)
            self.assertEqual(PermissionEngine(mode, {'deny': ['PipsRun'], 'allow': ['PipsRun']}, self.root).decide('run_pip_now', {'pip_id': 'p'})[0], DENY)
        self.assertIn('PipsRun', pips.native_policy()['deny'])

    def test_agent_child_monitor_disabled_and_denied_cannot_run(self):
        agent, approvals = self.agent(); args = self.request()
        for field in ('depth', '_monitor_turn'):
            setattr(agent, field, 1)
            self.assertNotIn('run_pip_now', {s['function']['name'] for s in agent._tool_schemas()})
            with patch.object(pip_run_tool, 'run', side_effect=AssertionError('No dispatch')):
                self.assertIn('main user chat', agent._handle_call(ToolCall('no', 'run_pip_now', args)))
            setattr(agent, field, 0)
        with patch.object(pip_run_tool, 'run', side_effect=AssertionError('No dispatch')):
            self.cfg.data['mode'] = 'auto'; self.cfg.permissions['deny'] = ['PipsRun']
            self.assertIn('DENIED', agent._handle_call(ToolCall('denied', 'run_pip_now', args)))
            self.cfg.data['mode'] = 'default'; self.cfg.permissions['deny'] = []
            self.assertIn('DENIED', agent._handle_call(ToolCall('ask', 'run_pip_now', args)))
        self.assertEqual(approvals, ['run_pip_now'])
        self.cfg.data['pips_enabled'] = False
        self.assertNotIn('run_pip_now', {s['function']['name'] for s in agent._tool_schemas()})

    def test_native_agent_model_tool_roundtrip_uses_existing_queue(self):
        agent, _ = self.agent(); args = self.request()
        self.cfg.data.update(mode='auto', api_mode='ollama')
        sent = []
        replies = iter([ChatResult(tool_calls=[ToolCall('dispatch', 'run_pip_now', args)]), ChatResult(content='The audit is queued. I have not verified its result yet.')])
        def chat(client, messages, **kwargs):
            sent.append((copy.deepcopy(messages), copy.deepcopy(kwargs.get('tools', []))))
            return next(replies)
        with patch.object(pip_run_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(workspace_sessions, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(LLMClient, 'chat', chat), patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            self.assertTrue(agent.run_turn('Run the existing code reviewer once.'))
        self.assertIn('run_pip_now', str(sent[0][1]))
        self.assertIn('"status":"queued"', str(sent[-1][0]))
        self.assertEqual(len(self.store.runs(args['pip_id'])), 1)


if __name__ == '__main__':
    unittest.main()
