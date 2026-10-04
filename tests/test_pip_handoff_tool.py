"""Main-chat handoffs save durable reviews only, with no network or worker execution."""
import copy
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_handoff_tool as tool, pip_handoffs, pip_execution, pips, pip_daemon, workspace_sessions, config as config_module
from dgc.llm import ToolCall, ChatResult, LLMClient
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine, READ_ONLY_TOOLS, DISPLAY
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_handoffs as handoff_fixtures
from tests import test_pip_artifact_handoffs as artifact_fixtures
from tests import test_pip_proposal_tool as agent_fixtures


class HandoffToolTests(unittest.TestCase):
    git = handoff_fixtures.PipHandoffTests.git
    commit = handoff_fixtures.PipHandoffTests.commit
    setup_source = handoff_fixtures.PipHandoffTests.setup_source
    context = agent_fixtures.PipProposalToolTests.context
    agent = agent_fixtures.PipProposalToolTests.agent

    def setUp(self):
        handoff_fixtures.PipHandoffTests.setUp(self)
        scoped = patch.object(config_module, 'USER_HOME', self.base / 'home' / '.dgc')
        scoped.start(); self.addCleanup(scoped.stop)
        self.setup_source()

    def request(self, **changes):
        return {'source_kind': 'finding', 'source_run_id': self.source_run['id'], 'finding_index': 0,
                'target_pip_id': self.target['id'], 'task': 'Investigate the source evidence.',
                'action': {'kind': 'read_only'}, 'request_key': 'handoff-one', **changes}

    def propose_tool(self, args=None, ctx=None):
        ctx = ctx or self.context()
        with patch.object(tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)):
            return json.loads(tool.propose(args or self.request(), ctx))

    def test_proposes_pending_review_without_dispatch_or_definition_changes(self):
        version = self.store.get(self.target['id'])['current_version']
        with patch.object(pips, 'start_queued', side_effect=AssertionError('No runner wake')), \
             patch.object(pips.PipStore, 'enqueue', side_effect=AssertionError('No dispatch')), \
             patch.object(pip_handoffs, 'accept', side_effect=AssertionError('No acceptance')):
            receipt = self.propose_tool()
        self.assertEqual(receipt['status'], 'pending')
        self.assertTrue(receipt['review_required'])
        self.assertFalse(receipt['execution_started'])
        self.assertIsNone(receipt['run_id'])
        self.assertEqual(self.store.runs(self.target['id']), [])
        self.assertEqual(self.store.get(self.target['id'])['current_version'], version)
        saved = pip_handoffs.get(self.store, receipt['handoff_id'])
        self.assertEqual(saved['payload']['action'], {'kind': 'read_only'})
        self.assertEqual(saved['payload']['source']['run_id'], self.source_run['id'])
        self.assertEqual(saved['payload']['target']['job_version'], version)
        self.assertNotIn('chat-one', json.dumps(saved))
        self.assertNotIn('request_key', json.dumps(saved))
        self.assertLess(len(json.dumps(receipt).encode()), tool.MAX_RECEIPT_BYTES)

    def test_exact_retry_and_changed_payload_conflict(self):
        first = self.propose_tool()
        self.assertEqual(self.propose_tool(), first)
        for change in ({'task': 'Different task'}, {'finding_index': 1}, {'action': {'kind': 'patch', 'write_paths': ['source.py'], 'tests': []}}):
            with self.assertRaises(RegistryError): self.propose_tool(self.request(**change))
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0], 1)

    def test_retry_scope_is_private_session_source_run_and_target(self):
        first = self.propose_tool(ctx=self.context('chat-one'))
        other_session = self.propose_tool(ctx=self.context('chat-two'))
        self.assertNotEqual(first['handoff_id'], other_session['handoff_id'])
        target = self.store.create(self.workspace['id'], 'Another', 'Read source', 'user', pip_type='lens')
        other_target = self.propose_tool(self.request(target_pip_id=target['id']))
        self.assertNotEqual(first['handoff_id'], other_target['handoff_id'])
        checked = tool.request(self.request())
        self.assertNotEqual(tool.identities('chat-one', checked), tool.identities('chat-one', {**checked, 'source_run_id': 'run_'+'1'*32}))

    def test_saved_retry_survives_job_and_model_changes_without_native_resolution(self):
        first = self.propose_tool()
        proposal = self.store.propose(self.target['id'], 1, {'goal': 'Changed future job'}, 'user')
        self.store.accept(self.target['id'], proposal['id'], 1, 'user')
        self.cfg.data['model'] = 'new-model'
        with patch.object(pips, 'source_revision', side_effect=AssertionError('No new source')), \
             patch.object(pips, '_model_settings', side_effect=AssertionError('No new model')):
            second = self.propose_tool()
        self.assertEqual(first, second)

    def test_retry_after_separate_human_approval_reports_old_run_without_dispatch(self):
        first = self.propose_tool()
        approved = pip_handoffs.accept(self.store, first['handoff_id'], 0, 'user', self.cfg)
        with patch.object(pips.PipStore, 'enqueue', side_effect=AssertionError('No additional dispatch')):
            second = self.propose_tool()
        self.assertEqual(second['handoff_id'], first['handoff_id'])
        self.assertEqual(second['run_id'], approved['run']['id'])
        self.assertEqual(second['status'], 'accepted')
        self.assertFalse(second['review_required'])
        self.assertFalse(second['execution_started'])
        self.assertEqual(len(self.store.runs(self.target['id'])), 1)

    def test_expired_retry_does_not_claim_pending_or_dispatch(self):
        first = self.propose_tool()
        self.now = '2026-10-09T10:00:00.000Z'
        second = self.propose_tool()
        self.assertEqual(first['handoff_id'], second['handoff_id'])
        self.assertEqual(second['status'], 'expired')
        self.assertFalse(second['review_required'])
        self.assertFalse(second['execution_started'])
        self.assertEqual(self.store.runs(self.target['id']), [])

    def test_paused_and_stopped_proposal_does_not_resume_or_advance_schedules(self):
        self.store.set_paused(self.target['id'], True, 'user')
        pip_daemon._set_paused(self.registry, True, 'user')
        with patch.object(pips, 'start_queued', side_effect=AssertionError('No wake')):
            receipt = self.propose_tool()
        self.assertEqual(receipt['status'], 'pending')
        self.assertTrue(pip_daemon.is_runtime_paused(self.registry))
        self.assertEqual(self.store.get(self.target['id'])['status'], 'paused')
        with self.assertRaises(RegistryError): pip_handoffs.accept(self.store, receipt['handoff_id'], 0, 'user', self.cfg)
        self.assertEqual(self.store.runs(self.target['id']), [])

    def test_patch_action_is_pinned_but_never_granted_or_run(self):
        target = self.store.create(self.workspace['id'], 'Fixer', 'Fix only reviewed files', 'user', pip_type='patch')
        action = {'kind': 'patch', 'write_paths': ['source.py'], 'tests': []}
        with patch.object(pips.PipStore, 'enqueue', side_effect=AssertionError('No execution')):
            receipt = self.propose_tool(self.request(target_pip_id=target['id'], action=action))
        saved = pip_handoffs.get(self.store, receipt['handoff_id'])
        self.assertEqual(saved['payload']['action'], pip_execution.validate_action('patch', action))
        self.assertFalse(saved['payload']['action']['network'])
        self.assertIsNone(saved['run_id'])
        self.assertEqual(self.cfg.permissions, {'allow': [], 'ask': [], 'deny': []})

    def test_foreign_source_target_and_forged_origin_refused_before_private_parse(self):
        other = self.base / 'foreign'; other.mkdir()
        workspace = self.registry.resolve(other)
        job = self.store.create(workspace['id'], 'Private', 'PRIVATE_OTHER_GOAL', 'user')
        ctx = self.context()
        foreign_source = 'run_' + 'f'*32
        self.registry.db.execute('''INSERT INTO pip_runs
            (id,pip_id,workspace_id,binding_id,idempotency_key,requested_by,manifest,status,created_at)
            SELECT ?,?,?,?,'foreign-source','user',manifest,status,created_at FROM pip_runs WHERE id=?''',
            (foreign_source, job['id'], workspace['id'], workspace['binding_id'], self.source_run['id']))
        with patch.object(pips.PipStore, '_job', side_effect=AssertionError('No definition parsing')), \
             patch.object(pip_handoffs, '_source', side_effect=AssertionError('No source parsing')):
            with self.assertRaises(RegistryError): self.propose_tool(self.request(source_run_id=foreign_source), ctx)
            with self.assertRaises(RegistryError): self.propose_tool(self.request(target_pip_id=job['id']), ctx)
        with patch.object(pips.PipStore, '_job', side_effect=AssertionError('No private parsing')):
            with self.assertRaises(RegistryError): self.propose_tool(self.request(target_pip_id=job['id']), ctx)
            for origin in ({'session_id': 'absent', 'workspace_id': self.workspace['id']},
                           {'session_id': 'chat-one', 'workspace_id': workspace['id']},
                           {'session_id': 'chat-one', 'workspace_id': self.workspace['id'], 'approved': True}):
                ctx.pip_proposal_origin = lambda: origin
                with self.assertRaises(RegistryError): self.propose_tool(ctx=ctx)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0], 0)

    def test_origin_revoked_during_preparation_refuses_atomic_insert(self):
        original = pip_handoffs._current
        def prepare(*args, **kw):
            result = original(*args, **kw)
            self.registry.db.execute("DELETE FROM session_workspaces WHERE session_id='chat-one'")
            return result
        with patch.object(pip_handoffs, '_current', prepare), self.assertRaises(RegistryError): self.propose_tool()
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0], 0)

    def test_current_tree_sources_and_targets_are_not_handoff_authority(self):
        policy = {'mode': 'current_tree', 'exclusions': 'safe_source_v1'}
        checkpoint = pip_handoffs.pip_checkpoints.for_run(self.store, self.source_run['id'])
        current = {**checkpoint, 'source_policy': policy, 'source_revision': None,
                   'source_snapshot': {'schema_version': 1, 'kind': 'current_tree', 'sha256': 'a'*64,
                       'files': 1, 'bytes': 20, 'exclusions': 'safe_source_v1', 'excluded_entries': 0,
                       'excluded_directories': 0, 'consistency': 'checked_non_atomic'}}
        with patch.object(pip_handoffs.pip_checkpoints, 'for_run', return_value=current), self.assertRaisesRegex(RegistryError, 'current-tree'):
            self.propose_tool()
        original = pips.PipStore._job
        for selected in (self.source['id'], self.target['id']):
            def job(store, pip_id):
                saved = original(store, pip_id)
                return {**saved, 'source_policy': policy} if pip_id == selected else saved
            with patch.object(pips.PipStore, '_job', job), \
                 patch.object(pips, 'source_revision', side_effect=AssertionError('No Git for current-tree handoff')), \
                 self.assertRaisesRegex(RegistryError, 'committed source'):
                self.propose_tool()
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0], 0)

    def test_secrets_redacted_from_task_and_refused_in_exact_action(self):
        secret = 'private-handoff-token-123456789'; self.cfg.set('api_key', secret, persist=False)
        receipt = self.propose_tool(self.request(task='Investigate ' + secret))
        raw = self.registry.db.execute('SELECT payload FROM pip_handoffs WHERE id=?', (receipt['handoff_id'],)).fetchone()[0]
        self.assertNotIn(secret, raw)
        target = self.store.create(self.workspace['id'], 'Verifier', 'Test reviewed input', 'user', pip_type='pulse')
        action = {'kind': 'test', 'tests': [{'argv': ['python3', '-c', secret], 'cwd': '.'}]}
        with patch.object(tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError):
            tool.propose(self.request(target_pip_id=target['id'], action=action), self.context())

    def test_malformed_closed_request_and_actions_fail_before_storage(self):
        args = self.request(); ctx = self.context()
        bad = [None, {}, {**args, 'source_kind': []}, {**args, 'finding_index': True}, {**args, 'finding_index': 16},
               {**args, 'source_kind': 'artifact'}, {**args, 'task': '\ud800'}, {**args, 'task': '界'*1500},
               {**args, 'request_key': '../escape'}, {**args, 'action': {'kind': []}},
               {**args, 'action': {'kind': 'read_only', 'network': True}},
               {**args, 'action': {'kind': 'patch', 'write_paths': ['../outside'], 'tests': []}},
               {**args, 'action': {'kind': 'test', 'tests': [{'argv': ['x']*33, 'cwd': '.'}]}},
               {**args, 'action': {'kind': 'test', 'tests': [{'argv': ['x'], 'cwd': '.', 'env': {'TOKEN': 'x'}}]}}]
        bad.extend({**args, field: True} for field in ('approved', 'accept', 'workspace_id', 'session_id', 'model', 'permissions', 'source_snapshot'))
        for item in bad:
            with self.subTest(item=type(item)), patch.object(tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError):
                tool.propose(item, ctx)

    def test_disabled_restricted_and_missing_origin_fail_before_storage(self):
        args = self.request(); ctx = self.context()
        for enabled in (False, 1, 'true'):
            self.cfg.data['pips_enabled'] = enabled
            with patch.object(tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError): tool.propose(args, ctx)
        self.cfg.data['pips_enabled'] = True
        for restricted in ('policy', 'sandbox'):
            self.cfg.data['sandbox'] = restricted == 'sandbox'
            with patch.dict(os.environ, {'DGC_SESSION_POLICY': '{malformed'} if restricted == 'policy' else {}), \
                 patch.object(tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError): tool.propose(args, ctx)
        self.cfg.data['sandbox'] = False; ctx.pip_proposal_origin = None
        with patch.object(tool, 'WorkspaceRegistry', side_effect=AssertionError('No storage')), self.assertRaises(RegistryError): tool.propose(args, ctx)

    def test_permission_labels_are_mutations_and_deny_beats_auto_allow(self):
        for name, label in (('handoff_to_pip', 'PipsHandoff'), ('run_pip_now', 'PipsRun')):
            self.assertEqual(DISPLAY[name], label)
            self.assertNotIn(name, READ_ONLY_TOOLS)
            for mode, wanted in (('default', ASK), ('acceptEdits', ASK), ('plan', DENY), ('auto', ALLOW)):
                self.assertEqual(PermissionEngine(mode, {}, self.root).decide(name, self.request())[0], wanted)
            rules = {'allow': ['*'], 'deny': [label]}
            self.assertEqual(PermissionEngine('auto', rules, self.root).decide(name, self.request())[0], DENY)
            self.assertIn(label, pips.native_policy()['deny'])

    def test_agent_hides_and_denies_child_monitor_disabled_and_plan_calls(self):
        agent, approvals = self.agent()
        for kind in ('disabled', 'child', 'monitor', 'plan', 'restricted'):
            self.cfg.data['pips_enabled'] = kind != 'disabled'
            agent.depth = 1 if kind == 'child' else 0
            agent._monitor_turn = kind == 'monitor'
            self.cfg.data['mode'] = 'plan' if kind == 'plan' else 'auto'
            self.cfg.data['sandbox'] = kind == 'restricted'
            offered = {entry['function']['name'] for entry in agent._tool_schemas()}
            self.assertNotIn('handoff_to_pip', offered)
            with patch.object(tool, 'propose', side_effect=AssertionError('Must not execute')):
                result = agent._handle_call(ToolCall('h-'+kind, 'handoff_to_pip', self.request()))
            self.assertTrue(result)
        self.assertEqual(approvals, [])

    def test_agent_tool_permission_denial_prevents_saving_review(self):
        agent, approvals = self.agent()
        self.cfg.data['mode'] = 'auto'
        self.cfg.permissions = {'allow': ['*'], 'ask': [], 'deny': ['PipsHandoff']}
        with patch.object(tool, 'propose', side_effect=AssertionError('Denied tool cannot save')):
            self.assertIn('DENIED', agent._handle_call(ToolCall('denied', 'handoff_to_pip', self.request())))
        self.cfg.data['mode'] = 'acceptEdits'; self.cfg.permissions['deny'] = []; self.cfg.permissions['allow'] = []
        with patch.object(tool, 'propose', side_effect=AssertionError('Unapproved tool cannot save')):
            self.assertIn('DENIED', agent._handle_call(ToolCall('asks', 'handoff_to_pip', self.request())))
        self.assertEqual(approvals, ['handoff_to_pip'])

    def test_native_agent_proposes_through_existing_tool_loop_without_dispatch(self):
        agent, _ = self.agent(); args = self.request()
        self.cfg.data.update(mode='auto', api_mode='ollama')
        calls = []
        replies = iter([ChatResult(tool_calls=[ToolCall('propose-handoff', 'handoff_to_pip', args)]),
                        ChatResult(content='The handoff is pending review; no target work started.')])
        def chat(client, messages, **kwargs):
            calls.append(copy.deepcopy(messages))
            return next(replies)
        with patch.object(tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)), \
             patch.object(workspace_sessions, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory, clock=self.registry.clock)), \
             patch.object(LLMClient, 'chat', chat), patch('requests.sessions.Session.request', side_effect=AssertionError('No network')), \
             patch.object(pips, 'start_queued', side_effect=AssertionError('No runner wake')):
            self.assertTrue(agent.run_turn('Propose a review-only handoff for the recorded finding.'))
        self.assertIn('"review_required":true', str(calls[-1]))
        self.assertIn('"execution_started":false', str(calls[-1]))
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_handoffs').fetchone()[0], 1)
        self.assertEqual(self.store.runs(self.target['id']), [])


class ArtifactHandoffToolTests(unittest.TestCase):
    git = HandoffToolTests.git
    commit = HandoffToolTests.commit
    setup_source = HandoffToolTests.setup_source
    context = HandoffToolTests.context
    propose_tool = HandoffToolTests.propose_tool
    completed_patch = artifact_fixtures.ArtifactHandoffTests.completed_patch
    propose = handoff_fixtures.PipHandoffTests.propose
    accept = handoff_fixtures.PipHandoffTests.accept
    raw_manifest = handoff_fixtures.PipHandoffTests.raw_manifest

    def setUp(self):
        handoff_fixtures.PipHandoffTests.setUp(self)
        self.completed_patch()

    def request(self):
        return {'source_kind': 'artifact', 'source_run_id': self.patch_run['id'], 'target_pip_id': self.pulse['id'],
                'task': 'Verify this accepted Patch with exactly the reviewed command.', 'action': self.test_action, 'request_key': 'artifact-one'}

    def test_accepted_patch_artifact_proposal_pins_evidence_and_does_not_start_pulse(self):
        with patch.object(pips.PipStore, 'enqueue', side_effect=AssertionError('No dispatch')):
            receipt = self.propose_tool()
        saved = pip_handoffs.get(self.store, receipt['handoff_id'])
        self.assertEqual(saved['payload']['type'], 'patch_artifact.v1')
        self.assertEqual(saved['payload']['source']['run_id'], self.patch_run['id'])
        self.assertEqual(saved['payload']['source']['artifact'], self.patch_run['result']['execution']['changes']['artifact'])
        self.assertEqual(saved['payload']['action'], pip_execution.validate_action('pulse', self.test_action))
        self.assertEqual(self.store.runs(self.pulse['id']), [])
        self.assertEqual(self.propose_tool(), receipt)

    def test_unaccepted_patch_and_artifact_finding_index_refused(self):
        from dgc import pip_execution_reviews
        pip_execution_reviews.review(self.store, self.patch_run['id'], 'open', 1, 'user', 'Recheck')
        with self.assertRaisesRegex(RegistryError, 'accepted'): self.propose_tool()
        with self.assertRaises(RegistryError): self.propose_tool({**self.request(), 'finding_index': 0})
        self.assertEqual(self.store.runs(self.pulse['id']), [])


if __name__ == '__main__':
    unittest.main()
