"""Deterministic offline setup drafts, exact human reviews and queue atomicity."""
from __future__ import annotations

import copy
import json
import sqlite3
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_setup, pip_setup_tool, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class PipSetupTests(unittest.TestCase):
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        self.now = '2026-10-02T05:29:00.000Z'  # 10:59 in Kolkata.
        self.registry.clock = lambda: self.now
        self.registry.associate_session('main-chat', self.root)
        self.commit()

    def request(self, **changes):
        return {'target_root': str(self.root), 'name': 'Morning source review',
                'goal': 'Review committed source for source-backed correctness concerns.',
                'pip_type': 'rook', 'work_kind': 'source_review',
                'schedule': {'type': 'daily', 'time': '11:00', 'timezone': 'Asia/Kolkata'},
                'run_now': True, 'request_key': 'morning-1', 'reason': 'The user requested a daily source review.', **changes}

    def draft(self, request=None):
        return pip_setup.propose(self.registry, request or self.request(), self.root, 'main-chat')

    def review(self, setup, accept=True, **changes):
        args = {'setup_id': setup['id'], 'workspace_id': self.workspace['id'], 'expected_digest': setup['digest'],
                'actor': 'local-user', 'config': self.cfg, 'accept': accept, **changes}
        with patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}):
            return pip_setup.review(self.registry, **args)

    def state(self):
        tables = ['pips', 'pip_versions', 'pip_runs', 'pip_schedule_state', 'pip_lifecycle_state', 'workspace_events', 'pip_setup_proposals']
        return {table: [tuple(row) for row in self.registry.db.execute('SELECT * FROM ' + table)] for table in tables}

    def existing_request(self, pip=None, **changes):
        pip = pip or self.create()
        return self.request(pip_id=pip['id'], expected_version=pip['current_version'], expected_lifecycle_revision=pip['lifecycle_revision'], **changes)

    def tool(self, request, context=None):
        context = context or SimpleNamespace(config=self.cfg, project_root=self.root,
            pip_proposal_origin=lambda: {'session_id': 'main-chat', 'workspace_id': self.workspace['id']})
        with patch.object(pip_setup_tool, 'WorkspaceRegistry', lambda: WorkspaceRegistry(self.registry.directory, clock=lambda: self.now)):
            return json.loads(pip_setup_tool.propose(request, context))

    def test_draft_is_only_one_immutable_card(self):
        before = self.state()
        draft = self.draft()
        after = self.state()
        for table in ('pips', 'pip_versions', 'pip_runs', 'pip_schedule_state', 'pip_lifecycle_state'):
            self.assertEqual(before[table], after[table])
        self.assertEqual(draft['status'], 'pending')
        self.assertEqual(draft['next_run_at'], '2026-10-03T05:30:00.000Z')
        self.assertIsNone(draft['pip_id'])
        self.assertEqual(draft['permissions'], 'read_only')
        self.assertIn('Does not run tests', draft['scope_notice'])
        self.assertEqual(pip_setup.list_pending(self.registry, self.workspace['id']), [draft])

    def test_retry_is_session_scoped_and_accept_receipt_is_stable(self):
        request = self.request()
        draft = self.draft(request)
        self.assertEqual(draft, self.draft(request))
        accepted = self.review(draft)
        self.assertEqual(self.draft(request), accepted)
        before = self.state()
        with patch('dgc.pip_runtime.require_supervisor', side_effect=AssertionError('retry needs no supervisor')):
            retry = pip_setup.review(self.registry, draft['id'], self.workspace['id'], draft['digest'], 'local-user', self.cfg, True)
        self.assertEqual(retry, accepted)
        self.assertEqual(before, self.state())
        self.registry.associate_session('other-main', self.root)
        other = pip_setup.propose(self.registry, request, self.root, 'other-main')
        self.assertNotEqual(other['id'], draft['id'])

    def test_different_retry_content_conflicts(self):
        self.draft()
        with self.assertRaisesRegex(RegistryError, 'retry key'):
            self.draft(self.request(goal='Different scope.'))

    def test_new_accept_creates_approved_job_and_one_native_queued_run(self):
        draft = self.draft()
        accepted = self.review(draft)
        receipt = accepted['receipt']
        self.assertEqual(accepted['status'], 'accepted')
        pip = self.store.get(receipt['pip_id'])
        self.assertEqual(pip['current_version'], 1)
        self.assertEqual(pip['status'], 'active')
        self.assertEqual(pip['schedule_state']['next_due_at'], '2026-10-03T05:30:00.000Z')
        runs = self.store.runs(pip['id'])
        self.assertEqual(len(runs), 1)
        run = self.store.run(receipt['run_id'])
        self.assertEqual(run['status'], 'queued')
        self.assertEqual(run['manifest']['policy'], 'read_only')
        self.assertEqual(run['manifest']['run_kind'], 'audit')
        self.assertNotIn('bash', run['manifest']['tools'])
        self.assertEqual(pip_setup.list_pending(self.registry, self.workspace['id']), [])

    def test_daily_run_now_deduplicates_before_at_and_after_time(self):
        for index, stamp in enumerate(('2026-10-02T05:29:00.000Z', '2026-10-02T05:30:00.000Z', '2026-10-02T05:31:00.000Z')):
            with self.subTest(stamp=stamp):
                self.now = stamp
                setup = self.draft(self.request(request_key=f'boundary-{index}'))
                self.assertEqual(setup['next_run_at'], '2026-10-03T05:30:00.000Z')
                result = self.review(setup)
                from dgc.pip_schedules import tick
                self.assertEqual(tick(self.registry, self.cfg, now='2026-10-02T06:00:00.000Z')['enqueued'], 0)
                self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs WHERE pip_id=?', (result['receipt']['pip_id'],)).fetchone()[0], 1)

    def test_before_time_run_now_accept_across_time_same_day(self):
        draft = self.draft()
        self.now = '2026-10-02T05:31:00.000Z'
        self.assertEqual(self.review(draft)['status'], 'accepted')

    def test_no_run_now_previews_today_and_rejects_cross_occurrence_accept(self):
        draft = self.draft(self.request(run_now=False))
        self.assertEqual(draft['next_run_at'], '2026-10-02T05:30:00.000Z')
        self.now = '2026-10-02T05:30:00.000Z'
        before = self.state()
        with self.assertRaisesRegex(RegistryError, 'occurrence has passed'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_daily_run_now_date_change_is_stale_even_before_next_occurrence(self):
        draft = self.draft()
        self.now = '2026-10-02T18:30:00.000Z'  # Kolkata midnight, before next11.
        with self.assertRaisesRegex(RegistryError, 'local date changed'):
            self.review(draft)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)

    def test_manual_only_accept_needs_no_supervisor(self):
        draft = self.draft(self.request(schedule=None, run_now=False))
        with patch('dgc.pip_runtime.require_supervisor', side_effect=AssertionError('manual setup must not start/check runner')):
            result = pip_setup.review(self.registry, draft['id'], self.workspace['id'], draft['digest'], 'local-user', self.cfg, True)
        self.assertIsNone(result['receipt']['run_id'])
        self.assertIsNone(result['receipt']['next_run_at'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_schedule_state').fetchone()[0], 0)

    def test_no_supervisor_fails_before_job_mutation(self):
        draft = self.draft()
        before = self.state()
        def guard(config):
            self.assertFalse(self.registry.db.in_transaction)
            raise RegistryError('runner_required', 'Start runner first.')
        with patch('dgc.pip_runtime.require_supervisor', side_effect=guard), self.assertRaisesRegex(RegistryError, 'Start runner'):
            pip_setup.review(self.registry, draft['id'], self.workspace['id'], draft['digest'], 'local-user', self.cfg, True)
        self.assertEqual(before, self.state())

    def test_queue_failure_rolls_back_new_job_and_all_review_state(self):
        draft = self.draft()
        before = self.state()
        with patch.object(pips.PipStore, 'enqueue', side_effect=RegistryError('limit', 'Queue full.')), self.assertRaisesRegex(RegistryError, 'Queue full'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_queue_failure_rolls_back_existing_version_resume_and_schedule(self):
        pip = self.create()
        pip = self.store.set_paused(pip['id'], True, 'user')
        draft = self.draft(self.existing_request(pip))
        before = self.state()
        with patch.object(pips.PipStore, 'enqueue', side_effect=RegistryError('limit', 'Queue full.')), self.assertRaises(RegistryError):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_failure_after_real_enqueue_rolls_back_every_saved_row(self):
        draft = self.draft()
        before = self.state()
        enqueue = pips.PipStore.enqueue
        def save_then_fail(store, *args, **kwargs):
            result = enqueue(store, *args, **kwargs)
            self.assertEqual(result['status'], 'queued')
            raise RegistryError('fixture_failure', 'Failure after native queue insert.')
        with patch.object(pips.PipStore, 'enqueue', save_then_fail), self.assertRaisesRegex(RegistryError, 'after native queue'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_existing_paused_immediate_run_uses_new_definition_lifecycle(self):
        pip = self.store.set_paused(self.create()['id'], True, 'user')
        draft = self.draft(self.existing_request(pip))
        result = self.review(draft)
        run = self.store.run(result['receipt']['run_id'])
        self.assertEqual(run['manifest']['job_version'], 2)
        self.assertEqual(self.store._job(pip['id'])['lifecycle_revision'], 2)
        self.assertEqual(run['manifest']['job']['name'], draft['name'])

    def test_source_change_after_preparation_fails_without_partial_setup(self):
        draft = self.draft()
        prepare = pip_setup._prepare_immediate_audit
        before = self.state()
        def advance_source(*args):
            result = prepare(*args)
            (self.root / 'source.py').write_text('def hello():\n    return "changed"\n')
            self.git('add', 'source.py')
            self.git('commit', '-qm', 'source advances during review')
            return result
        with patch.object(pip_setup, '_prepare_immediate_audit', side_effect=advance_source), self.assertRaisesRegex(RegistryError, 'source changed'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_existing_paused_job_updates_and_explicitly_activates_only_it(self):
        pip = self.create()
        pip = self.store.set_paused(pip['id'], True, 'user')
        other = self.create()
        self.store.set_paused(other['id'], True, 'user')
        draft = self.draft(self.existing_request(pip, run_now=False))
        self.assertEqual(self.store._job(pip['id'])['status'], 'paused')
        accepted = self.review(draft)
        fresh = self.store.get(pip['id'])
        self.assertEqual(fresh['current_version'], 2)
        self.assertEqual(fresh['lifecycle_revision'], 2)
        self.assertEqual(fresh['status'], 'active')
        self.assertEqual(self.store._job(other['id'])['status'], 'paused')
        self.assertEqual(accepted['receipt']['pip_id'], pip['id'])

    def test_reject_is_idempotent_and_never_mutates_jobs(self):
        pip = self.create()
        draft = self.draft(self.existing_request(pip))
        before = self.state()
        rejected = self.review(draft, False)
        self.assertEqual(rejected['status'], 'rejected')
        self.assertFalse(rejected['receipt']['accepted'])
        self.assertEqual(rejected['receipt']['job_version'], 1)
        self.assertIsNone(rejected['receipt']['run_id'])
        self.assertEqual(rejected, self.review(draft, False))
        after = self.state()
        for table in ('pips', 'pip_versions', 'pip_runs', 'pip_schedule_state', 'pip_lifecycle_state'):
            self.assertEqual(before[table], after[table])
        with self.assertRaisesRegex(RegistryError, 'different decision'):
            self.review(draft, True)

    def test_expiry_is_exact_and_read_only(self):
        draft = self.draft(self.request(run_now=False))
        self.now = draft['expires_at']
        before = self.state()
        self.assertEqual(pip_setup.get(self.registry, draft['id'], self.workspace['id'])['status'], 'expired')
        self.assertEqual(pip_setup.list_pending(self.registry, self.workspace['id']), [])
        with self.assertRaisesRegex(RegistryError, 'expired'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_stale_version_is_refused(self):
        pip = self.create()
        draft = self.draft(self.existing_request(pip, run_now=False))
        proposal = self.store.propose(pip['id'], 1, {'goal': 'Other goal'}, 'user')
        self.store.accept(pip['id'], proposal['id'], 1, 'user')
        before = self.state()
        with self.assertRaisesRegex(RegistryError, 'job or lifecycle changed'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_pause_resume_aba_invalidates_setup(self):
        pip = self.create()
        draft = self.draft(self.existing_request(pip, run_now=False))
        self.store.set_paused(pip['id'], True, 'user')
        self.store.set_paused(pip['id'], False, 'user')
        with self.assertRaisesRegex(RegistryError, 'lifecycle changed'):
            self.review(draft)

    def test_busy_existing_target_is_refused(self):
        pip = self.create()
        draft = self.draft(self.existing_request(pip))
        self.store.enqueue(pip['id'], 'busy-run', 'user', self.cfg)
        before = self.state()
        with self.assertRaisesRegex(RegistryError, 'queued or active'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_pending_existing_job_review_is_refused(self):
        pip = self.create()
        draft = self.draft(self.existing_request(pip))
        self.store.propose(pip['id'], 1, {'goal': 'Other goal'}, 'user')
        with self.assertRaisesRegex(RegistryError, 'existing job reviews'):
            self.review(draft)

    def test_moved_binding_and_replaced_root_are_refused(self):
        draft = self.draft(self.request(run_now=False))
        old = self.base / 'old-repo'
        self.root.rename(old)
        self.root.mkdir()
        with self.assertRaisesRegex(RegistryError, 'directory changed'):
            self.review(draft)

    def test_rebinding_retains_setup_history_but_cannot_retarget_it(self):
        draft = self.draft(self.request(run_now=False))
        moved = self.base / 'moved'
        self.root.rename(moved)
        self.registry.rebind(self.workspace['id'], moved, expected_root=self.root)
        cfg = fixtures.config(moved)
        with self.assertRaisesRegex(RegistryError, 'original project'):
            self.review(draft, config=cfg)
        self.assertEqual(pip_setup.get(self.registry, draft['id'], self.workspace['id'])['project_root'], str(self.root))

    def test_cross_workspace_setup_and_target_are_refused(self):
        other = self.base / 'other'
        other.mkdir()
        workspace = self.registry.resolve(other)
        with self.assertRaisesRegex(RegistryError, 'differs from this chat'):
            self.draft(self.request(target_root=str(other)))
        draft = self.draft()
        with self.assertRaisesRegex(RegistryError, 'not found'):
            pip_setup.get(self.registry, draft['id'], workspace['id'])
        with self.assertRaisesRegex(RegistryError, 'not found'):
            self.review(draft, workspace_id=workspace['id'])

    def test_model_workspace_mismatch_precedes_registry_open(self):
        other = self.base / 'other'
        other.mkdir()
        ctx = SimpleNamespace(config=self.cfg, project_root=self.root)
        with patch.object(pip_setup_tool, 'WorkspaceRegistry', side_effect=AssertionError('no open')):
            with self.assertRaisesRegex(RegistryError, 'differs from this chat'):
                pip_setup_tool.propose(self.request(target_root=str(other)), ctx)

    def test_missing_or_cross_workspace_session_is_refused(self):
        with self.assertRaisesRegex(RegistryError, 'authoritatively associated'):
            pip_setup.propose(self.registry, self.request(), self.root, 'missing')
        other = self.base / 'other'
        other.mkdir()
        self.registry.associate_session('foreign-chat', other)
        with self.assertRaisesRegex(RegistryError, 'authoritatively associated'):
            pip_setup.propose(self.registry, self.request(), self.root, 'foreign-chat')

    def test_existing_pip_must_belong_to_current_workspace(self):
        other = self.base / 'other'
        other.mkdir()
        workspace = self.registry.resolve(other)
        pip = self.store.create(workspace['id'], 'Other', 'Other scope', 'user')
        with self.assertRaisesRegex(RegistryError, 'not found'):
            self.draft(self.existing_request(pip))

    def test_live_smoke_test_is_never_substituted(self):
        with self.assertRaisesRegex(RegistryError, 'confirmed local URL'):
            self.draft(self.request(work_kind='app_smoke_test'))
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_setup_proposals').fetchone()[0], 0)

    def test_quill_draft_supports_native_manual_and_scheduled_runs(self):
        setup = self.draft(self.request(pip_type='quill', work_kind='documentation_draft'))
        result = self.review(setup)
        run = self.store.run(result['receipt']['run_id'])
        self.assertEqual(run['manifest']['run_kind'], 'draft')
        self.registry.db.execute("UPDATE pip_runs SET status='cancelled' WHERE id=?", (run['id'],))
        self.now = '2026-10-03T05:30:00.000Z'
        from dgc.pip_schedules import tick
        outcome = tick(self.registry, self.cfg)
        self.assertEqual(outcome['enqueued'], 1)
        scheduled = self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id!=?", (run['id'],)).fetchone()
        self.assertEqual(json.loads(scheduled['manifest'])['draft_automation']['trigger'], 'schedule')

    def test_preserves_model_and_adaptation_but_no_extra_authority(self):
        pip = self.store.create(self.workspace['id'], 'Special', 'Review', 'user', model_choice={'mode': 'model', 'model': 'other-model'})
        draft = self.draft(self.existing_request(pip, run_now=False))
        result = self.review(draft)
        actual = self.store._job(result['receipt']['pip_id'])
        self.assertEqual(actual['model_choice'], pip['model_choice'])
        self.assertEqual(actual['adaptation_policy'], pip['adaptation_policy'])
        self.assertEqual(actual['policy'], 'read_only')

    def test_locked_adaptation_cannot_be_bypassed_by_setup(self):
        pip = self.create()
        proposal = self.store.propose(pip['id'], 1, {'adaptation_policy': 'locked'}, 'user')
        pip = self.store.accept(pip['id'], proposal['id'], 1, 'user')
        with self.assertRaisesRegex(RegistryError, 'does not allow model'):
            self.draft(self.existing_request(pip))

    def test_job_type_and_non_source_roles_cannot_change(self):
        pip = self.create()
        with self.assertRaisesRegex(RegistryError, 'cannot change'):
            self.draft(self.existing_request(pip, pip_type='scout'))
        for role in ('core', 'patch', 'pulse'):
            with self.subTest(role=role), self.assertRaises(RegistryError):
                self.draft(self.request(pip_type=role))
        with self.assertRaises(RegistryError):
            self.draft(self.request(pip_type='quill'))

    def test_display_digest_and_saved_body_tampering_refused(self):
        draft = self.draft(self.request(run_now=False))
        with self.assertRaisesRegex(RegistryError, 'displayed setup changed'):
            self.review(draft, expected_digest='0' * 64)
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute('UPDATE pip_setup_proposals SET body=? WHERE id=?', ('{}', draft['id']))
        self.registry.db.execute('DROP TRIGGER immutable_pip_setup')
        self.registry.db.execute('UPDATE pip_setup_proposals SET body=? WHERE id=?', ('{}', draft['id']))
        with self.assertRaisesRegex(RegistryError, 'no longer matches'):
            self.review(draft)

    def test_saved_receipt_cannot_change_or_be_deleted(self):
        draft = self.draft(self.request(run_now=False))
        self.review(draft)
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute('UPDATE pip_setup_proposals SET receipt=? WHERE id=?', ('{}', draft['id']))
        with self.assertRaises(sqlite3.IntegrityError):
            self.registry.db.execute('DELETE FROM pip_setup_proposals WHERE id=?', (draft['id'],))

    def test_pending_limit_and_expired_drafts_do_not_block_new_drafts(self):
        for index in range(20):
            self.draft(self.request(request_key=f'key-{index}', run_now=False))
        with self.assertRaisesRegex(RegistryError, '20 pending'):
            self.draft(self.request(request_key='last', run_now=False))
        self.now = '2026-10-09T05:29:00.000Z'
        new = self.draft(self.request(request_key='after-expiry', run_now=False))
        self.assertEqual(pip_setup.list_pending(self.registry, self.workspace['id']), [new])

    def test_pending_listing_is_bounded_and_resolution_reveals_next_card(self):
        for index in range(7):
            self.draft(self.request(request_key=f'key-{index}', run_now=False))
        first = pip_setup.list_pending(self.registry, self.workspace['id'])
        self.assertEqual(len(first), 5)
        self.assertLess(len(json.dumps({'setups': first}, ensure_ascii=False).encode()), 128 * 1024)
        self.review(first[0], False)
        following = pip_setup.list_pending(self.registry, self.workspace['id'])
        self.assertEqual(len(following), 5)
        self.assertNotIn(first[0]['id'], {item['id'] for item in following})
        self.assertEqual(len({item['id'] for item in first + following}), 6)

    def test_retained_limit_refuses_before_new_draft(self):
        # Exercise the archive boundary without generating 1,000 UI-visible cards.
        draft = self.draft(self.request(run_now=False))
        row = self.registry.db.execute('SELECT * FROM pip_setup_proposals').fetchone()
        for i in range(999):
            self.registry.db.execute('INSERT INTO pip_setup_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?)',
                (f'setup_{i:032x}', row['workspace_id'], row['session_id'], f'old-{i}', row['request_digest'], row['body'], row['digest'], 'rejected', '{}', row['created_at'], row['expires_at']))
        with self.assertRaisesRegex(RegistryError, '1,000'):
            self.draft(self.request(request_key='beyond', run_now=False))

    def test_strict_request_rejects_controls_extra_authority_and_unbounded_graph(self):
        malformed = [None, {}, self.request(run_now=1), self.request(name='x\x00y'), self.request(goal='x' * 4001),
                     self.request(target_root='relative'), self.request(request_key='../key'), self.request(source_ref='HEAD;uname'),
                     self.request(expected_version=1), self.request(model='override'), self.request(permissions=['bash']),
                     self.request(schedule={'type': 'daily', 'time': '11:00'}), self.request(goal='\ud800')]
        cycle = {}; cycle['recursive'] = cycle
        malformed.append(cycle)
        for value in malformed:
            with self.subTest(value=type(value).__name__), self.assertRaises(RegistryError):
                pip_setup.validate_request(value)

    def test_disabled_restricted_and_model_acceptance_are_refused(self):
        self.cfg.data['pips_enabled'] = False
        with patch.object(pip_setup_tool, 'WorkspaceRegistry', side_effect=AssertionError('must not open')), self.assertRaisesRegex(RegistryError, 'disabled'):
            pip_setup_tool.propose(self.request(), SimpleNamespace(config=self.cfg, project_root=self.root))
        self.cfg.data['pips_enabled'] = True
        with patch('dgc.pip_access.require_unrestricted', side_effect=RegistryError('session_policy', 'restricted')), self.assertRaisesRegex(RegistryError, 'restricted'):
            self.tool(self.request())
        draft = self.draft()
        for actor in ('core_setup', 'core_proposal', 'model-agent', 'local-scheduler'):
            with self.subTest(actor=actor), self.assertRaisesRegex(RegistryError, 'human control'):
                self.review(draft, actor=actor)

    def test_known_secrets_refused_before_store_and_again_at_review(self):
        request = self.request(goal='Review fixture-secret-token-value source.')
        with patch.object(pip_setup_tool, 'secret_values', return_value=('fixture-secret-token-value',)), patch.object(pip_setup_tool, 'WorkspaceRegistry', side_effect=AssertionError('must not open')), self.assertRaisesRegex(RegistryError, 'credentials'):
            pip_setup_tool.propose(request, SimpleNamespace(config=self.cfg, project_root=self.root))
        draft = self.draft(self.request(run_now=False))
        before = self.state()
        with patch('dgc.redaction.secret_values', return_value=('Morning source review',)), self.assertRaisesRegex(RegistryError, 'credentials'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_an_allowed_setup_creates_the_pip_with_a_default_daily_limit(self):
        # Auto mode, an allow rule or the user's Allow on an ask rule: the agent marks the call, and
        # that permission is the approval.
        from dgc import pip_spend
        with patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}):
            result = self.tool({**self.request(), '_dgc_create_now': True})
        self.assertTrue(result['created'])
        self.assertFalse(result['review_required'])
        self.assertTrue(result['job_changed_by_this_call'])
        self.assertTrue(result['execution_started'], 'run_now queued its first run')
        self.assertEqual(result['setup']['status'], 'accepted')
        pip_id = result['setup']['receipt']['pip_id']
        self.assertEqual(self.store.get(pip_id)['status'], 'active')
        self.assertEqual(result['setup']['receipt']['actor'], 'chat-permission:default')
        self.assertEqual(result['daily_token_limit'], pip_spend.DEFAULT_CHAT_CAP)
        self.assertEqual(pip_spend.cap(self.registry, pip_id), pip_spend.DEFAULT_CHAT_CAP)
        self.assertIn('daily limit of 200,000 tokens', result['message'])

    def test_outside_auto_mode_a_setup_is_a_card_whose_create_is_the_approval(self):
        # The founder: the setup "can come in the chat and user can click it to approve". Without the
        # agent's mark the call saves the card the editor docks above the chat box; nothing exists yet.
        with patch('dgc.pip_runtime.require_supervisor', side_effect=AssertionError('no runner needed for a card')):
            result = self.tool(self.request())
        self.assertTrue(result['review_required'])
        self.assertFalse(result['job_changed_by_this_call'])
        self.assertEqual(result['setup']['status'], 'pending')
        self.assertIn('card above the chat box', result['message'])
        self.assertIn('never claim it is on', result['message'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)
        with patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}):
            accepted = self.review(result['setup'])
        self.assertEqual(accepted['status'], 'accepted')
        self.assertEqual(accepted['receipt']['actor'], 'local-user', 'the click, not the chat, approved it')
        loose = self.tool({**self.request(request_key='loose', name='Loose review'), '_dgc_create_now': 'yes'})
        self.assertEqual(loose['setup']['status'], 'pending', "only the agent's True creates")

    def test_a_setup_that_needs_its_own_review_stays_a_card(self):
        # Reading connected accounts or a Pulse with commands keeps a card in every mode.
        self.assertTrue(pip_setup.needs_card({'app_plan': {'schema_version': 1}}))
        self.assertTrue(pip_setup.needs_card({'pip_type': 'pulse'}))
        self.assertFalse(pip_setup.needs_card({'pip_type': 'lens', 'scope': 'personal', 'web_plan': {'reads': []}}))
        with patch.object(pip_setup, 'needs_card', return_value=True):
            result = self.tool({**self.request(), '_dgc_create_now': True})
        self.assertTrue(result['review_required'])
        self.assertFalse(result['job_changed_by_this_call'])
        self.assertEqual(result['setup']['status'], 'pending')
        self.assertIn('connected accounts or runs commands', result['message'])
        self.assertIn('card above the chat box', result['message'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 0)

    def test_run_now_starts_the_runner_and_a_stopped_runner_leaves_a_card(self):
        from dgc.workspace_registry import RegistryError as Refused
        started = []
        with patch('dgc.pip_runtime.require_supervisor', side_effect=[Refused('runner_required', 'Start the runner.'), {'online': True}]), \
                patch('dgc.pip_runtime.start_runtime', side_effect=lambda config, resume: started.append(resume)):
            result = self.tool({**self.request(), '_dgc_create_now': True})
        self.assertEqual(started, [False], 'started, never resuming an emergency stop')
        self.assertTrue(result['created'])
        with patch('dgc.pip_runtime.require_supervisor', side_effect=Refused('runner_required', 'Start the runner.')), \
                patch('dgc.pip_runtime.start_runtime', side_effect=Refused('runner_stopped', 'Pips are stopped on this runner.')):
            result = self.tool({**self.request(request_key='morning-2', name='Evening review'), '_dgc_create_now': True})
        self.assertTrue(result['review_required'])
        self.assertIn('Pips are stopped on this runner.', result['message'])
        self.assertEqual(result['setup']['status'], 'pending')

    def test_the_permission_prompt_says_what_allowing_does(self):
        # The terminal's prompt and the editor's card heading: the Pip in words, not its arguments.
        from dgc.ui import arg_summary
        line = arg_summary('pips_setup', self.request(schedule={'type': 'cron', 'cron': '30 8 * * 1-5', 'timezone': 'Asia/Kolkata'}))
        self.assertEqual(line, 'Create Pip “Morning source review” · rook, this project · weekdays at 08:30 (Asia/Kolkata) · runs now')
        self.assertIn('Change Pip', arg_summary('pips_setup', self.existing_request()))
        self.assertEqual(arg_summary('pips_propose', {'pip_id': 'p', 'changes': {'goal': 'Inspect auth.'}}), 'Change a Pip: goal → Inspect auth.')

    def test_changing_an_existing_pip_keeps_its_own_limit(self):
        from dgc import pip_spend
        pip = self.create()
        with patch('dgc.pip_runtime.require_supervisor', return_value={'online': True}):
            result = self.tool({**self.existing_request(pip, run_now=False), '_dgc_create_now': True})
        self.assertTrue(result['created'])
        self.assertIsNone(result['daily_token_limit'])
        self.assertIsNone(pip_spend.cap(self.registry, pip['id']))

    def test_invalid_source_ref_acceptance_leaves_no_job(self):
        draft = self.draft(self.request(source_ref='missing-branch', run_now=False))
        before = self.state()
        with self.assertRaises(RegistryError):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_interval_preview_anchor_is_fixed_at_draft(self):
        draft = self.draft(self.request(schedule={'type': 'interval', 'minutes': 10}, run_now=False))
        self.assertEqual(draft['next_run_at'], '2026-10-02T05:39:00.000Z')
        self.now = '2026-10-02T05:31:00.000Z'
        result = self.review(draft)
        state = self.store.get(result['receipt']['pip_id'])['schedule_state']
        self.assertEqual(state['anchor_at'], draft['created_at'])
        self.assertEqual(state['next_due_at'], draft['next_run_at'])

    def test_once_requires_future_occurrence(self):
        with self.assertRaisesRegex(RegistryError, 'one-time occurrence has passed'):
            self.draft(self.request(schedule={'type': 'once', 'at': self.now}))

    def revise(self, draft, choice=None, **changes):
        args = {'setup_id': draft['id'], 'workspace_id': self.workspace['id'],
                'expected_digest': draft['digest'], 'model_choice': choice or {'mode': 'model', 'model': 'review-model'},
                'actor': 'editor-user', 'config': self.cfg, **changes}
        with patch('dgc.llm.LLMClient.list_models', return_value=['fixture', 'review-model']):
            return pip_setup.revise(self.registry, **args)

    def test_optional_model_is_saved_reviewed_and_pinned_without_changing_legacy_body(self):
        legacy = self.draft()
        raw = self.registry.db.execute('SELECT body,digest FROM pip_setup_proposals WHERE id=?', (legacy['id'],)).fetchone()
        self.assertNotIn('model_choice', json.loads(raw['body'])['request'])
        self.assertEqual(legacy['model_choice'], {'mode': 'default'})
        explicit = self.draft(self.request(request_key='model-selected', model_choice={'mode': 'model', 'model': 'review-model'}, run_now=False))
        self.assertEqual(explicit['model_choice'], {'mode': 'model', 'model': 'review-model'})
        with patch('dgc.llm.LLMClient.list_models', return_value=['review-model']):
            accepted = self.review(explicit)
        self.assertEqual(self.store.get(accepted['receipt']['pip_id'])['model_choice'], explicit['model_choice'])
        self.assertEqual(tuple(raw), tuple(self.registry.db.execute('SELECT body,digest FROM pip_setup_proposals WHERE id=?', (legacy['id'],)).fetchone()))

    def test_model_revision_replaces_card_atomically_without_creating_job_or_run(self):
        draft = self.draft(self.request(schedule={'type': 'interval', 'minutes': 10}, run_now=False))
        raw = tuple(self.registry.db.execute('SELECT body,digest FROM pip_setup_proposals WHERE id=?', (draft['id'],)).fetchone())
        before = self.state()
        self.now = '2026-10-02T05:31:00.000Z'
        revised = self.revise(draft)
        self.assertEqual(revised['status'], 'pending')
        self.assertNotEqual(revised['id'], draft['id'])
        self.assertNotEqual(revised['digest'], draft['digest'])
        self.assertEqual(revised['next_run_at'], '2026-10-02T05:41:00.000Z')
        old = pip_setup.get(self.registry, draft['id'], self.workspace['id'])
        self.assertEqual(old['status'], 'rejected')
        self.assertEqual(old['receipt']['replacement_setup_id'], revised['id'])
        self.assertFalse(old['receipt']['accepted'])
        self.assertEqual(raw, tuple(self.registry.db.execute('SELECT body,digest FROM pip_setup_proposals WHERE id=?', (draft['id'],)).fetchone()))
        self.assertEqual(pip_setup.list_pending(self.registry, self.workspace['id']), [revised])
        for table in ('pips', 'pip_versions', 'pip_runs', 'pip_schedule_state', 'pip_lifecycle_state'):
            self.assertEqual(before[table], self.state()[table])

    def test_model_revision_retry_is_durable_and_original_cannot_accept(self):
        draft = self.draft(self.request(run_now=False))
        revised = self.revise(draft)
        before = self.state()
        with patch('dgc.pip_models.resolve_model_choice', side_effect=AssertionError('retry must not contact provider')):
            self.assertEqual(self.revise(draft), revised)
        self.assertEqual(before, self.state())
        with self.assertRaisesRegex(RegistryError, 'different decision'):
            self.review(draft)
        with self.assertRaisesRegex(RegistryError, 'different model'):
            self.revise(draft, {'mode': 'default'})
        with patch('dgc.llm.LLMClient.list_models', return_value=['review-model']):
            accepted = self.review(revised)
        self.assertEqual(self.revise(draft), accepted)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pips').fetchone()[0], 1)

    def test_model_revision_never_reopens_unrelated_rejection(self):
        draft = self.draft()
        self.review(draft, accept=False)
        before = self.state()
        with self.assertRaisesRegex(RegistryError, 'already resolved'):
            self.revise(draft)
        self.assertEqual(before, self.state())

    def test_model_revision_failure_rolls_back_original_resolution(self):
        draft = self.draft()
        before = self.state()
        with patch.object(pip_setup, 'MAX_RETAINED', 1), self.assertRaisesRegex(RegistryError, 'archive is full'):
            self.revise(draft)
        self.assertEqual(before, self.state())
        self.assertEqual(pip_setup.get(self.registry, draft['id'], self.workspace['id'])['status'], 'pending')

    def test_model_revision_exact_pins_human_scope_and_expiry_are_required(self):
        draft = self.draft()
        before = self.state()
        for changes in ({'expected_digest': 'f' * 64}, {'actor': 'core_setup'}, {'actor': 'model'},
                        {'model_choice': {'mode': 'model', 'model': 'unknown'}},
                        {'model_choice': {'mode': 'model', 'model': 'review-model', 'base_url': 'http://forged.invalid'}},
                        {'workspace_id': 'ws_' + 'f' * 32}):
            with self.subTest(changes=changes), self.assertRaises(RegistryError):
                self.revise(draft, **changes)
            self.assertEqual(before, self.state())
        self.now = '2026-10-10T05:29:00.000Z'
        with self.assertRaisesRegex(RegistryError, 'expired'):
            self.revise(draft)
        self.assertEqual(before, self.state())

    def test_unchanged_model_revision_does_not_create_another_card(self):
        draft = self.draft()
        before = self.state()
        self.assertEqual(self.revise(draft, {'mode': 'default'}), draft)
        self.assertEqual(before, self.state())

    def test_unknown_explicit_model_cannot_be_accepted_without_immediate_run(self):
        draft = self.draft(self.request(run_now=False, model_choice={'mode': 'model', 'model': 'missing'}))
        before = self.state()
        with patch('dgc.llm.LLMClient.list_models', return_value=['fixture']), self.assertRaisesRegex(RegistryError, 'not offered'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_immediate_setup_discovers_model_once_outside_sqlite_write_transaction(self):
        draft = self.draft(self.request(model_choice={'mode': 'model', 'model': 'review-model'}))
        def models():
            self.assertFalse(self.registry.db.in_transaction)
            # A separate writer must be able to commit during provider discovery.
            with self.reopen_registry() as other:
                other.db.execute("PRAGMA busy_timeout=0")
                other.db.execute("INSERT OR REPLACE INTO metadata VALUES('discovery-writer','unblocked')")
            return ['review-model']
        with patch('dgc.llm.LLMClient.list_models', side_effect=models) as discovery:
            result = self.review(draft)
        self.assertEqual(discovery.call_count, 1)
        row = self.registry.db.execute('SELECT manifest FROM pip_runs WHERE id=?', (result['receipt']['run_id'],)).fetchone()
        self.assertEqual(json.loads(row['manifest'])['model'], 'review-model')

    def reopen_registry(self):
        return WorkspaceRegistry(self.registry.directory, clock=lambda: self.now)

    def test_model_connection_change_after_preflight_rolls_back_setup_and_queue(self):
        draft = self.draft(self.request(model_choice={'mode': 'model', 'model': 'review-model'}))
        before = self.state()
        def models():
            self.cfg.set('base_url', 'http://changed.invalid/v1', persist=False)
            return ['review-model']
        with patch('dgc.llm.LLMClient.list_models', side_effect=models), self.assertRaisesRegex(RegistryError, 'endpoint or API mode changed'):
            self.review(draft)
        self.assertEqual(before, self.state())

    def test_private_prepared_model_cannot_change_request_limits(self):
        choice = {'mode': 'default'}
        settings = pips._model_settings(self.cfg, choice)
        self.assertEqual(pips._model_settings(self.cfg, choice, _prepared={'choice': choice, 'settings': settings}), settings)
        for key, value in (('max_tokens', 99999), ('max_turns', 99), ('thinking', 'xhigh')):
            with self.subTest(key=key), self.assertRaises(RegistryError):
                pips._model_settings(self.cfg, choice, _prepared={'choice': choice, 'settings': {**settings, key: value}})


if __name__ == '__main__':
    unittest.main()
