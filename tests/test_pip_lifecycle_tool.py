"""Deterministic main-chat lifecycle authority, retry and attachment tests."""
import json
import sqlite3
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch

from dgc import pip_lifecycle_tool as lifecycle, pips, pip_daemon, pip_context_tool, workspace_sessions
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.permissions import ALLOW, ASK, DENY, PermissionEngine, READ_ONLY_TOOLS
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_proposal_tool as fixtures
from tests import test_pips_local as local


class PipLifecycleToolTests(unittest.TestCase):
    create = fixtures.PipProposalToolTests.create
    context = fixtures.PipProposalToolTests.context
    agent = fixtures.PipProposalToolTests.agent
    git = local.LocalPipsTests.git
    commit = local.LocalPipsTests.commit

    def setUp(self):
        fixtures.PipProposalToolTests.setUp(self)
        self.wake = patch.object(pips, 'start_queued', side_effect=AssertionError('Never start a drainer')).start()
        self.supervisor = patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}).start()
        self.addCleanup(patch.stopall)

    def args(self, pip=None, **changes):
        pip = pip or self.create()
        return {'pip_id': pip['id'], 'expected_version': pip['current_version'],
                'expected_lifecycle_revision': self.store.get(pip['id'])['lifecycle_revision'],
                'reason': 'Keep this Pip aligned with the current task.', 'request_key': 'lifecycle-one', **changes}

    def call(self, op, args, ctx=None):
        ctx = ctx or self.context()
        with patch.object(lifecycle, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            return json.loads(lifecycle.apply(op, args, ctx))

    def test_pause_and_resume_use_existing_status_without_starting_runtime(self):
        args = self.args()
        paused = self.call('pause_pip', args)
        self.assertTrue(paused['state_changed_by_this_call'])
        self.assertEqual(paused['current']['status'], 'paused')
        self.supervisor.assert_not_called()
        resumed = self.call('resume_pip', {**args, 'request_key': 'resume-one', 'expected_lifecycle_revision': paused['current']['lifecycle_revision']})
        self.assertEqual(resumed['current']['status'], 'active')
        self.assertFalse(resumed['run_queued_by_this_call'])
        self.assertFalse(resumed['runtime_started_by_this_call'])
        self.assertEqual(len(self.store.runs(args['pip_id'])), 0)
        self.wake.assert_not_called()
        self.supervisor.assert_called_once_with(self.cfg)

    def test_exact_retry_never_reapplies_a_human_overridden_status(self):
        args = self.args(); original = self.call('pause_pip', args)
        self.store.set_paused(args['pip_id'], False, 'user')
        change = self.store.propose(args['pip_id'], 1, {'name': 'Changed later'}, 'user')
        self.store.accept(args['pip_id'], change['id'], 1, 'user')
        retry = self.call('pause_pip', args)
        self.assertEqual(retry['receipt'], original['receipt'])
        self.assertTrue(retry['replayed'])
        self.assertFalse(retry['state_changed_by_this_call'])
        self.assertEqual(retry['current']['status'], 'active')
        self.assertEqual(retry['current']['job_version'], 2)

    def test_resume_retry_survives_global_stop_and_offline_supervisor(self):
        args = self.args(); self.store.set_paused(args['pip_id'], True, 'user')
        args['expected_lifecycle_revision'] = self.store.get(args['pip_id'])['lifecycle_revision']
        first = self.call('resume_pip', args)
        self.store.set_paused(args['pip_id'], True, 'user')
        pip_daemon._set_paused(self.registry, True, 'user')
        self.supervisor.side_effect = AssertionError('Saved retries need no live runtime')
        retry = self.call('resume_pip', args)
        self.assertEqual(retry['receipt'], first['receipt'])
        self.assertEqual(retry['current']['status'], 'paused')

    def test_one_session_key_cannot_alias_operation_pip_payload_or_version(self):
        args = self.args(); self.call('pause_pip', args)
        other = self.create()
        for op, change in [('resume_pip', {}), ('attach_pip_to_session', {}),
                           ('pause_pip', {'reason': 'Different'}), ('pause_pip', {'expected_version': 2}),
                           ('pause_pip', {'pip_id': other['id']})]:
            with self.subTest(op=op, change=change), self.assertRaisesRegex(RegistryError, 'different lifecycle'):
                self.call(op, {**args, **change})
        independent = self.call('pause_pip', {**args, 'expected_lifecycle_revision': self.store.get(args['pip_id'])['lifecycle_revision']}, self.context('second-chat'))
        self.assertFalse(independent['replayed'])
        self.assertFalse(independent['receipt']['changed'])

    def test_resume_refuses_global_stop_or_missing_supervisor(self):
        args = self.args(); self.store.set_paused(args['pip_id'], True, 'user')
        args['expected_lifecycle_revision'] = self.store.get(args['pip_id'])['lifecycle_revision']
        pip_daemon._set_paused(self.registry, True, 'user')
        with self.assertRaisesRegex(RegistryError, 'stopped on this runner'):
            self.call('resume_pip', args)
        self.assertEqual(self.store.get(args['pip_id'])['status'], 'paused')
        pip_daemon._set_paused(self.registry, False, 'user')
        self.supervisor.side_effect = RegistryError('runner_required', 'Start the runner')
        with self.assertRaisesRegex(RegistryError, 'Start the runner'):
            self.call('resume_pip', args)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_lifecycle_requests').fetchone()[0], 0)

    def test_pause_keeps_running_turn_and_prevents_claiming_queued_audit(self):
        self.commit(); args = self.args()
        one = self.store.enqueue(args['pip_id'], 'running-one', 'user', self.cfg)
        self.store.claim_next()
        two = self.store.enqueue(args['pip_id'], 'queued-two', 'user', self.cfg)
        self.call('pause_pip', args)
        self.assertEqual(self.store.run(one['id'])['status'], 'running')
        self.assertEqual(self.store.run(two['id'])['status'], 'queued')
        self.assertIsNone(self.store.claim_next())

    def test_atomic_failure_rolls_back_status_and_event(self):
        args = self.args(); before = self.registry.db.execute('SELECT count(*) FROM workspace_events').fetchone()[0]
        self.context()  # Association is separate from the lifecycle mutation.
        before = self.registry.db.execute('SELECT count(*) FROM workspace_events').fetchone()[0]
        self.registry.db.execute("CREATE TRIGGER refuse_lifecycle BEFORE INSERT ON pip_lifecycle_requests BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with self.assertRaisesRegex(RegistryError, 'Lifecycle storage'):
            self.call('pause_pip', args)
        self.assertEqual(self.store.get(args['pip_id'])['status'], 'active')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM workspace_events').fetchone()[0], before)

    def test_attach_is_durable_reference_and_does_not_change_job_or_read_transcript(self):
        args = self.args(); ctx = self.context()
        first = self.call('attach_pip_to_session', args, ctx)
        self.assertTrue(first['current']['attached'])
        self.assertEqual(first['current']['attached_version'], 1)
        self.assertEqual(self.store.get(args['pip_id'])['current_version'], 1)
        self.assertEqual(len(self.store.runs(args['pip_id'])), 0)
        self.assertEqual(self.call('attach_pip_to_session', args, ctx)['receipt'], first['receipt'])
        with WorkspaceRegistry(self.registry.directory) as fresh:
            refs = lifecycle.attachments(fresh, self.root, 'chat-one')
            self.assertEqual(refs['attachments'][0]['pip_id'], args['pip_id'])
            self.assertFalse(refs['attachments'][0]['job_changed_since_attachment'])
            self.assertEqual(lifecycle.attachments(fresh, self.root, self.context('other-chat').pip_proposal_origin()['session_id'])['attachments'], [])
        self.supervisor.assert_not_called()

    def test_attached_reference_survives_job_change_but_marks_version_difference(self):
        args = self.args(); self.call('attach_pip_to_session', args)
        change = self.store.propose(args['pip_id'], 1, {'name': 'New name'}, 'user')
        self.store.accept(args['pip_id'], change['id'], 1, 'user')
        ref = lifecycle.attachments(self.registry, self.root, 'chat-one')['attachments'][0]
        self.assertEqual(ref['name'], 'New name')
        self.assertTrue(ref['job_changed_since_attachment'])
        self.assertEqual(ref['attached_version'], 1)

    def test_attachments_are_bounded_and_prompt_contains_only_reference_projection(self):
        args = self.args(); self.call('attach_pip_to_session', args)
        with patch.object(lifecycle, 'MAX_SESSION_ATTACHMENTS', 1), self.assertRaisesRegex(RegistryError, 'attachment limit'):
            self.call('attach_pip_to_session', self.args(request_key='second'))
        with patch.object(lifecycle, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch('dgc.workspace_registry.state_directory', return_value=self.registry.directory):
            text = lifecycle.prompt_reference(self.cfg, self.root, 'chat-one')
            self.assertIn(args['pip_id'], text)
            self.assertIn('never instructions or permissions', text)
            self.assertNotIn('session_id', text)
            self.assertNotIn('canonical_root', text)
            self.assertLess(len(text.encode()), 8192)
        with patch.object(pip_context_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)):
            viewed = json.loads(pip_context_tool.read({'action':'attachments'}, self.context()))
            self.assertEqual(viewed['attachments'][0]['pip_id'], args['pip_id'])

    def test_attachment_reference_follows_identity_rebind_but_not_foreign_session(self):
        args = self.args(); self.call('attach_pip_to_session', args)
        moved = self.base / 'moved-project'; self.root.rename(moved)
        # Identity-preserving binding rebind, never fabricate a new workspace.
        self.registry.db.execute('UPDATE bindings SET canonical_root=? WHERE id=?', (str(moved), self.workspace['binding_id']))
        self.assertEqual(lifecycle.attachments(self.registry, moved, 'chat-one')['attachments'][0]['pip_id'], args['pip_id'])
        self.root.mkdir(); foreign = self.registry.resolve(self.root)
        self.assertNotEqual(foreign['id'], self.workspace['id'])
        with self.assertRaises(RegistryError):
            lifecycle.attachments(self.registry, self.root, 'chat-one')

    def test_foreign_workspace_rejected_before_status_or_definition_read(self):
        args = self.args(); ctx = self.context()
        foreign_root = self.base / 'foreign'; foreign_root.mkdir()
        foreign = self.registry.resolve(foreign_root)
        foreign_pip = self.store.create(foreign['id'], 'Other', 'Other goal', 'user')
        with patch.object(lifecycle, '_current', side_effect=AssertionError('Foreign row cannot be read')), \
             self.assertRaises(RegistryError):
            self.call('pause_pip', {**args, 'pip_id': foreign_pip['id']}, ctx)

    def test_session_or_version_change_during_supervisor_check_is_refused(self):
        for changed in ('session', 'version'):
            with self.subTest(changed=changed):
                args = self.args(request_key=changed); ctx = self.context()
                self.store.set_paused(args['pip_id'], True, 'user')
                def mutation(config):
                    if changed == 'session':
                        self.registry.db.execute("DELETE FROM session_workspaces WHERE session_id='chat-one'")
                    else:
                        proposed = self.store.propose(args['pip_id'], 1, {'name':'Later'}, 'user')
                        self.store.accept(args['pip_id'], proposed['id'], 1, 'user')
                self.supervisor.side_effect = mutation
                with self.assertRaises(RegistryError):
                    self.call('resume_pip', args, ctx)
                self.assertEqual(self.store.get(args['pip_id'])['status'], 'paused')

    def test_invalid_extra_fields_and_restricted_context_fail_closed(self):
        args = self.args()
        for change in ({'workspace_id': self.workspace['id']}, {'expected_version': True},
                       {'reason':'\ud800'}, {'request_key':'unsafe/value'}):
            with self.subTest(change=change), self.assertRaises(RegistryError):
                self.call('pause_pip', {**args, **change})
        with patch('dgc.pip_access.restricted', return_value=True), self.assertRaisesRegex(RegistryError, 'independent runner'):
            self.call('pause_pip', args)
        self.cfg.set('pips_enabled', False)
        with self.assertRaisesRegex(RegistryError, 'disabled'):
            self.call('pause_pip', args)

    def test_operation_archive_bound_preserves_saved_retry(self):
        args = self.args(); first = self.call('pause_pip', args)
        with patch.object(lifecycle, 'MAX_OPERATIONS', 1):
            self.assertEqual(self.call('pause_pip', args)['receipt'], first['receipt'])
            with self.assertRaisesRegex(RegistryError, 'archive is full'):
                self.call('pause_pip', {**args, 'request_key':'another', 'expected_lifecycle_revision': self.store.get(args['pip_id'])['lifecycle_revision']})

    def test_two_connections_exact_retry_mutate_once(self):
        args = self.args(); ctx = self.context(); ready = Barrier(2)
        def invoke(_):
            ready.wait(timeout=10)
            return json.loads(lifecycle.apply('pause_pip', args, ctx))
        with patch.object(lifecycle, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(invoke, range(2)))
        self.assertEqual(sum(reply['state_changed_by_this_call'] for reply in replies), 1)
        self.assertEqual(sum(reply['replayed'] for reply in replies), 1)
        self.assertEqual(replies[0]['receipt'], replies[1]['receipt'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_lifecycle_requests').fetchone()[0], 1)

    def test_malformed_stored_receipts_are_not_repeated_as_facts(self):
        args = self.args(); receipt = self.call('pause_pip', args)['receipt']
        self.registry.db.execute('DROP TRIGGER immutable_pip_lifecycle_request')
        for changes in ({'job_version':True}, {'status_after':'active'}, {'changed':False},
                        {'attached':True, 'attached_version':999999}, {'created_at':'unsafe\ntext'}):
            with self.subTest(changes=changes):
                self.registry.db.execute('UPDATE pip_lifecycle_requests SET receipt=?', (json.dumps({**receipt, **changes}),))
                with self.assertRaises(RegistryError): self.call('pause_pip', args)
        self.registry.db.execute('UPDATE pip_lifecycle_requests SET receipt=?', ('x' * 5000,))
        with self.assertRaisesRegex(RegistryError, 'invalid or oversized'): self.call('pause_pip', args)

    def test_malformed_attachment_metadata_does_not_reach_prompt(self):
        args = self.args(); self.call('attach_pip_to_session', args)
        for value in ('not-a-version', 0, 2):
            with self.subTest(value=value):
                self.registry.db.execute('UPDATE session_pip_attachments SET attached_version=?', (value,))
                with self.assertRaises(RegistryError): lifecycle.attachments(self.registry, self.root, 'chat-one')
                with self.assertRaises(RegistryError): self.call('attach_pip_to_session', args)

    def test_secret_reason_redacted_before_storage_and_identity_refused(self):
        secret = 'fixture-lifecycle-token-1234567890'
        self.cfg.set('api_key', secret, persist=False)
        args = self.args(reason='Pause while checking ' + secret)
        receipt = self.call('pause_pip', args)
        self.assertNotIn(secret, json.dumps(receipt))
        self.assertNotIn(secret, self.registry.db.execute('SELECT receipt FROM pip_lifecycle_requests').fetchone()[0])
        with self.assertRaisesRegex(RegistryError, 'credentials'):
            self.call('pause_pip', {**args, 'request_key': secret})

    def test_actual_agent_denial_and_approved_attachment_survive_prompt_rebuild(self):
        agent, approvals = self.agent(); args = self.args()
        self.cfg.data['mode'] = 'auto'
        self.cfg.permissions = {'allow':['*'], 'ask':[], 'deny':['PipsAttach']}
        with patch.object(lifecycle, 'apply', side_effect=AssertionError('Denied executor')):
            self.assertIn('DENIED', agent._handle_call(ToolCall('deny-link', 'attach_pip_to_session', args)))
        self.cfg.permissions['deny'] = []; self.cfg.data['api_mode'] = 'ollama'
        replies = iter([ChatResult(tool_calls=[ToolCall('link', 'attach_pip_to_session', args)]),
                        ChatResult(content='The Pip is attached as a reference. No work was started.')])
        with patch.object(lifecycle, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch.object(workspace_sessions, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch('dgc.workspace_registry.state_directory', return_value=self.registry.directory), \
             patch.object(LLMClient, 'chat', side_effect=lambda *a, **kw: next(replies)), \
             patch('requests.sessions.Session.request', side_effect=AssertionError('No network')):
            self.assertTrue(agent.run_turn('Attach this Pip to our chat as a reference.'))
            rebuilt = agent.system_prompt()
        self.assertIn('# Attached Pip references', rebuilt)
        self.assertIn(args['pip_id'], rebuilt)
        self.assertEqual(self.store.runs(args['pip_id']), [])

    def test_schema_ten_upgrade_and_failure_are_atomic(self):
        from dgc import workspace_registry
        job = self.create()
        from tests.pip_test_migrations import drop_archive_schema
        drop_archive_schema(self.registry.db)
        for table in ('pip_memories', 'pip_notifications', 'pip_notification_seen', 'pip_notification_state'):
            self.registry.db.execute('DROP TABLE '+table)
        self.registry.db.execute('DROP TABLE pip_lifecycle_requests')
        self.registry.db.execute('DROP TABLE workspace_session_outcomes')
        self.registry.db.execute('DROP TABLE session_pip_attachments')
        self.registry.db.execute('PRAGMA user_version=10')
        original = workspace_registry._execute_schema
        def fail(db, sql):
            original(db, sql)
            if sql == lifecycle.SCHEMA:
                raise RuntimeError('Injected lifecycle migration failure')
        with patch.object(workspace_registry, '_execute_schema', fail), self.assertRaisesRegex(RuntimeError, 'Injected'):
            WorkspaceRegistry(self.registry.directory)
        self.assertEqual(self.registry.db.execute('PRAGMA user_version').fetchone()[0], 10)
        self.assertIsNone(self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='pip_lifecycle_requests'").fetchone())
        self.assertEqual(self.registry.db.execute('SELECT current_version FROM pips WHERE id=?',(job['id'],)).fetchone()[0], 1)
        with WorkspaceRegistry(self.registry.directory) as migrated:
            self.assertEqual(migrated.db.execute('PRAGMA user_version').fetchone()[0], workspace_registry.SCHEMA_VERSION)
            self.assertEqual(pips.PipStore(migrated).get(job['id'])['name'], job['name'])

    def test_sdk_labels_native_permissions_and_child_gates(self):
        from dgc import permissions
        for tool, label in [('pause_pip','PipsPause'), ('resume_pip','PipsResume'), ('attach_pip_to_session','PipsAttach')]:
            self.assertEqual(permissions.DISPLAY[tool], label)
            self.assertNotIn(tool, READ_ONLY_TOOLS)
            self.assertIn(label, pips.native_policy()['deny'])
            for mode, expected in [('default', ASK), ('acceptEdits', ASK), ('plan', DENY), ('auto', ALLOW)]:
                engine = PermissionEngine(mode=mode, rules={})
                self.assertEqual(engine.decide(tool, {'pip_id':'pip_test'})[0], expected)
            engine = PermissionEngine(mode='auto', rules={'allow':['*'], 'deny':[label]})
            self.assertEqual(engine.decide(tool, {'pip_id':'pip_test'})[0], DENY)
        agent, _ = self.agent()
        for attr in ('depth', '_monitor_turn'):
            setattr(agent, attr, 1)
            names = {item['function']['name'] for item in agent._tool_schemas()}
            self.assertTrue(lifecycle.OPERATIONS.isdisjoint(names))
            setattr(agent, attr, 0)

    def test_injected_child_monitor_plan_and_disabled_calls_never_reach_executor(self):
        agent, approvals = self.agent(); args = self.args()
        for state in ('child', 'monitor', 'plan', 'disabled', 'sandbox'):
            self.cfg.data.update(mode='plan' if state == 'plan' else 'auto',
                                 pips_enabled=state != 'disabled', sandbox=state == 'sandbox')
            agent.depth = 1 if state == 'child' else 0
            agent._monitor_turn = state == 'monitor'
            for tool in lifecycle.OPERATIONS:
                with self.subTest(state=state, tool=tool), \
                     patch.object(lifecycle, 'apply', side_effect=AssertionError('Not authorized')):
                    self.assertTrue(agent._handle_call(ToolCall(state+tool, tool, args)))
        self.assertEqual(approvals, [])

    def test_prompt_budget_omits_whole_long_references_with_count(self):
        self.context()
        for index in range(16):
            pip = self.store.create(self.workspace['id'], '界' * 120, 'Inspect source', 'user')
            self.call('attach_pip_to_session', self.args(pip, request_key='ref-'+str(index)))
        with patch.object(lifecycle, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory)), \
             patch('dgc.workspace_registry.state_directory', return_value=self.registry.directory):
            prompt = lifecycle.prompt_reference(self.cfg, self.root, 'chat-one')
        references = json.loads(prompt.split('\n')[-1])
        self.assertGreater(references['omitted_attachments'], 0)
        self.assertEqual(len(references['attachments']) + references['omitted_attachments'], 16)
        self.assertTrue(all(ref['name'] == '界' * 120 for ref in references['attachments']))
        self.assertLessEqual(len(prompt.split('\n')[-1].encode()), 8192)


if __name__ == '__main__':
    unittest.main()
