"""Native save facts, scope and durable dedupe without workers/network/sleeps."""
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import json
import os
from pathlib import Path
import sqlite3
import tempfile
from threading import Barrier, Event
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from dgc import sessions, session_turn_events as events
from dgc.workspace_registry import RegistryError, WorkspaceRegistry, _execute_schema
from tests.test_pips_local import config


class SessionTurnEventTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'source'; self.root.mkdir()
        self.env = patch.dict(os.environ, {'DGC_HOME': str(self.base / 'home')})
        self.env.start(); self.addCleanup(self.env.stop)
        self.cfg = config(self.root)
        self.registry = WorkspaceRegistry(self.base / 'registry', clock=lambda: '2026-10-02T10:00:00.000Z')
        self.addCleanup(self.registry.close)
        if not self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='session_turn_completions'").fetchone():
            with self.registry.transaction():
                _execute_schema(self.registry.db, events.SCHEMA)
        self.path = sessions.new_path(self.root)
        self.identity = self.registry.associate_session(self.path.stem, self.root)
        self.assertTrue(sessions.save(self.path, [{'role': 'user', 'content': 'private transcript'}],
                                      self.root, expected_revision=0, expected_exists=False))
        self.agent = SimpleNamespace(config=self.cfg, depth=0, cancelled=Event(),
                                     ctx=SimpleNamespace(project_root=self.root),
                                     session_file=self.path, session_root=self.root,
                                     _session_exists=True, _session_revision=1,
                                     _last_turn_error='', _last_persist_error='',
                                     ui=SimpleNamespace(info=lambda message: self.notices.append(message)))
        self.notices = []
        self.opener = patch.object(events, 'WorkspaceRegistry', lambda directory=None:
                                  WorkspaceRegistry(directory or self.registry.directory,
                                                    clock=lambda: '2026-10-02T10:00:00.000Z'))
        self.opener.start(); self.addCleanup(self.opener.stop)

    def reserve(self, **changes):
        return events.reserve(self.registry, self.cfg, session_file=self.path, session_root=self.root,
                              session_revision=1, session_exists=True,
                              **{'origin': 'foreground_prompt', **changes})

    def persist(self):
        before = self.agent._session_revision
        saved = sessions.save(self.path, [{'role': 'assistant', 'content': 'private response'}], self.root,
                              expected_revision=before, expected_exists=self.agent._session_exists)
        self.assertTrue(saved)
        self.agent._session_revision += 1; self.agent._session_exists = True
        return before

    def complete(self, reservation, **changes):
        return events.complete_for_agent(self.agent, reservation,
                **{'completed': True, 'saved': True, 'revision_before_save': 1, **changes})

    def record(self, reservation, **changes):
        return events.record(self.registry, self.cfg, reservation,
                             **{'completed': True, 'saved': True, 'revision_before_save': 1,
                                'final_revision': 2, **changes})

    def rows(self):
        return self.registry.db.execute('SELECT * FROM session_turn_completions').fetchall()

    def event_rows(self):
        return self.registry.db.execute('SELECT * FROM workspace_events WHERE event_type=?', (events.EVENT_TYPE,)).fetchall()

    def test_actual_saved_turn_records_only_metadata_once(self):
        reservation = events.begin_for_agent(self.agent, origin='foreground_prompt')
        self.assertIsNotNone(reservation); self.persist()
        first = self.complete(reservation); second = self.complete(reservation)
        self.assertFalse(first['replayed']); self.assertTrue(second['replayed'])
        self.assertEqual(first['completion'], second['completion'])
        self.assertEqual(len(self.rows()), 1); self.assertEqual(len(self.event_rows()), 1)
        body = json.dumps(dict(self.rows()[0]))
        self.assertNotIn('private transcript', body); self.assertNotIn('private response', body)
        self.assertNotIn(str(self.root), body); self.assertNotIn(str(self.path), body)
        self.assertEqual(first['completion']['outcome'], 'foreground_turn_saved')
        self.assertEqual(first['completion']['verification'], 'no_execution_or_test_claim')
        self.assertEqual(json.loads(self.event_rows()[0]['payload'])['completion_id'], first['completion']['id'])

    def test_reservation_is_read_only_and_never_reads_transcript_or_source(self):
        before = self.registry.db.total_changes
        with (patch.object(sessions, 'load_record', side_effect=AssertionError('no transcript read')),
              patch.object(Path, 'read_text', side_effect=AssertionError('no file read'))):
            reservation = self.reserve()
        self.assertEqual(self.registry.db.total_changes, before)
        self.persist()
        with (patch.object(sessions, 'load_record', side_effect=AssertionError('no transcript read')),
              patch.object(Path, 'read_text', side_effect=AssertionError('no file read'))):
            self.assertIsNotNone(self.complete(reservation))

    def test_unassociated_turn_is_not_silently_associated(self):
        self.agent.session_file = self.path.with_name('unassociated.json')
        before = self.registry.db.execute('SELECT count(*) FROM session_workspaces').fetchone()[0]
        self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM session_workspaces').fetchone()[0], before)
        self.assertTrue(self.notices)

    def test_closed_origins_and_excluded_agent_kinds_never_open_registry(self):
        with patch.object(events, 'WorkspaceRegistry', side_effect=AssertionError('No storage')):
            for origin in [*events.EXCLUDED_ORIGINS, 'unknown', None, {}, True]:
                self.assertIsNone(events.begin_for_agent(self.agent, origin=origin))
            for name, value in [('depth', 1), ('depth', False), ('_monitor_turn', True),
                                ('_parent_agent', object()), ('_subagent_id', 'child'),
                                ('_agent_tool_allowlist', set()), ('stopping', True)]:
                old = getattr(self.agent, name, None); setattr(self.agent, name, value)
                try: self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))
                finally: setattr(self.agent, name, old)
            self.cfg.data['subscription_engine'] = 'vendor'
            self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))

    def test_disabled_restricted_and_cancelled_do_not_open_registry(self):
        with patch.object(events, 'WorkspaceRegistry', side_effect=AssertionError('No storage')):
            self.cfg.data['pips_enabled'] = False
            self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))
            self.cfg.data['pips_enabled'] = True
            with patch.object(events, 'restricted', return_value=True):
                self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))
            self.agent.cancelled.set()
            self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))

    def test_failure_partial_save_and_nonboolean_outcomes_do_not_emit(self):
        reservation = self.reserve(); self.persist()
        for changes in ({'completed': False}, {'completed': None}, {'completed': 1},
                        {'saved': False}, {'saved': None}, {'saved': 1}):
            self.assertIsNone(self.complete(reservation, **changes))
        # Merely persisting progress does not call finalization or produce an event.
        self.persist()
        self.assertEqual(self.rows(), []); self.assertEqual(self.event_rows(), [])

    def test_final_save_generation_must_advance_exactly_once(self):
        reservation = self.reserve()
        for before, final in [(1, 1), (0, 1), (1, 3), (True, 2), (1, True), (1, 2**53)]:
            with self.subTest(before=before, final=final), self.assertRaises(RegistryError):
                self.record(reservation, revision_before_save=before, final_revision=final)
        self.persist(); self.persist()  # progress save plus final save
        self.assertIsNotNone(self.complete(reservation, revision_before_save=2))

    def test_preassociated_first_saved_turn_is_supported(self):
        path = sessions.new_path(self.root)
        self.registry.associate_session(path.stem, self.root)
        reservation = events.reserve(self.registry, self.cfg, session_file=path, session_root=self.root,
                                     session_revision=0, session_exists=False, origin='foreground_continue')
        self.assertTrue(sessions.save(path, [], self.root, expected_revision=0, expected_exists=False))
        self.agent.session_file = path; self.agent._session_revision = 1
        self.assertIsNotNone(self.complete(reservation, revision_before_save=0))

    def test_cancel_error_missing_saved_state_and_session_switch_refuse(self):
        reservation = self.reserve(); self.persist()
        self.agent.cancelled.set(); self.assertIsNone(self.complete(reservation)); self.agent.cancelled.clear()
        for name, value in [('_last_turn_error', 'failed'), ('_last_persist_error', 'failed'),
                            ('_session_exists', False), ('session_file', self.path.with_name('other.json')),
                            ('session_root', self.base)]:
            old = getattr(self.agent, name); setattr(self.agent, name, value)
            try: self.assertIsNone(self.complete(reservation))
            finally: setattr(self.agent, name, old)
        self.assertEqual(self.rows(), [])

    def test_binding_change_and_association_change_refuse_atomically(self):
        reservation = self.reserve(); self.persist()
        self.registry.db.execute('UPDATE bindings SET updated_at=? WHERE id=?',
                                 ('2026-10-02T11:00:00.000Z', reservation.binding_id))
        self.assertIsNone(self.complete(reservation))
        self.registry.db.execute('UPDATE bindings SET updated_at=? WHERE id=?',
                                 (reservation.binding_updated_at, reservation.binding_id))
        self.registry.db.execute('UPDATE session_workspaces SET updated_at=? WHERE session_id=?',
                                 ('2026-10-02T11:00:00.000Z', reservation.session_id))
        self.assertIsNone(self.complete(reservation)); self.assertEqual(self.rows(), [])

    def test_foreign_scope_refused_before_saved_body_decode(self):
        reservation = self.reserve(); self.persist(); self.complete(reservation)
        other = self.base / 'other'; other.mkdir()
        foreign = self.registry.resolve(other)
        self.registry.db.execute('UPDATE session_workspaces SET workspace_id=?,binding_id=? WHERE session_id=?',
                                 (foreign['id'], foreign['binding_id'], reservation.session_id))
        with patch.object(events, '_saved', side_effect=AssertionError('foreign body read')):
            with self.assertRaises(RegistryError): self.record(reservation)

    def test_replay_after_restart_and_event_retention_never_reemits(self):
        reservation = self.reserve(); self.persist(); first = self.complete(reservation)
        self.registry.db.execute('DELETE FROM workspace_events WHERE event_type=?', (events.EVENT_TYPE,))
        with WorkspaceRegistry(self.registry.directory) as reopened:
            replay = events.record(reopened, self.cfg, reservation, completed=True, saved=True,
                                   revision_before_save=1, final_revision=2)
        self.assertTrue(replay['replayed']); self.assertEqual(replay['event_id'], first['event_id'])
        self.assertEqual(self.event_rows(), []); self.assertEqual(len(self.rows()), 1)

    def test_conflicting_retry_and_duplicate_save_identity_refuse(self):
        reservation = self.reserve(); self.persist(); self.complete(reservation)
        with self.assertRaises(RegistryError): self.record(reservation, revision_before_save=2, final_revision=3)
        with self.assertRaises(RegistryError): self.record(replace(reservation, turn_id='turn_' + 'b' * 32))
        self.assertEqual(len(self.event_rows()), 1)

    def test_two_connection_duplicate_completion_emits_once(self):
        reservation = self.reserve(); self.persist(); barrier = Barrier(2)
        def complete():
            with WorkspaceRegistry(self.registry.directory) as registry:
                barrier.wait()
                return events.record(registry, self.cfg, reservation, completed=True, saved=True,
                                     revision_before_save=1, final_revision=2)
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(lambda _: complete(), range(2)))
        self.assertEqual(sorted(reply['replayed'] for reply in replies), [False, True])
        self.assertEqual(len(self.rows()), 1); self.assertEqual(len(self.event_rows()), 1)

    def test_event_failure_rolls_back_ledger_and_event(self):
        reservation = self.reserve(); self.persist(); original = self.registry.event
        def fail(*args, **kwargs):
            original(*args, **kwargs)
            raise RuntimeError('injected event failure')
        with patch.object(self.registry, 'event', side_effect=fail), self.assertRaises(RuntimeError):
            self.record(reservation)
        self.assertEqual(self.rows(), []); self.assertEqual(self.event_rows(), [])

    def test_ledger_failure_rolls_back_event_and_retention(self):
        reservation = self.reserve(); self.persist()
        before = [tuple(row) for row in self.registry.db.execute('SELECT * FROM workspace_events')]
        self.registry.db.execute("CREATE TRIGGER test_fail_completion BEFORE INSERT ON session_turn_completions BEGIN SELECT RAISE(ABORT,'fixture'); END")
        with patch('dgc.workspace_registry.MAX_EVENTS', 1), self.assertRaises(sqlite3.IntegrityError):
            self.record(reservation)
        self.assertEqual(self.rows(), [])
        self.assertEqual([tuple(row) for row in self.registry.db.execute('SELECT * FROM workspace_events')], before)

    def test_capacity_refuses_new_events_but_keeps_exact_retries(self):
        reservation = self.reserve(); self.persist(); self.complete(reservation)
        with patch.object(events, 'MAX_COMPLETIONS', 1):
            self.assertTrue(self.record(reservation)['replayed'])
            with self.assertRaises(RegistryError):
                self.record(self.reserve(), revision_before_save=2, final_revision=3)
        self.assertEqual(len(self.rows()), 1)

    def test_immutable_rows_and_oversize_source_cell_fail_closed(self):
        reservation = self.reserve(); self.persist(); self.complete(reservation)
        for sql in ('UPDATE session_turn_completions SET body=body', 'DELETE FROM session_turn_completions'):
            with self.assertRaises(sqlite3.IntegrityError): self.registry.db.execute(sql)
        self.registry.db.execute('DROP TRIGGER immutable_session_turn_completion_update')
        self.registry.db.execute('PRAGMA ignore_check_constraints=ON')
        self.registry.db.execute('UPDATE session_turn_completions SET body=?', ('x' * (events.MAX_RECORD_BYTES + 1),))
        with patch.object(events.json, 'loads', side_effect=AssertionError('oversized decode')):
            # SQL guards must reject before attempting any JSON decoding.
            with self.assertRaises(RegistryError): self.record(reservation)

    def test_malformed_native_metadata_is_bounded_and_never_saved(self):
        for path in (None, '/tmp/\ud800.json', '/tmp/' + 'x' * 4097, '/tmp/a/../b.json'):
            self.agent.session_file = path
            self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))
        self.agent.session_file = self.path
        for revision in (True, -1, 2**53, '1'):
            self.agent._session_revision = revision
            self.assertIsNone(events.begin_for_agent(self.agent, origin='foreground_prompt'))
        self.assertEqual(self.rows(), [])

    def test_metadata_secret_collision_refuses_instead_of_changing_pins(self):
        reservation = self.reserve(); self.persist()
        with patch.object(events, 'secret_values', return_value=[reservation.session_id]), self.assertRaises(RegistryError):
            self.record(reservation)
        self.assertEqual(self.rows(), []); self.assertEqual(self.event_rows(), [])

    def test_cancellation_after_scope_recheck_prevents_event(self):
        reservation = self.reserve(); self.persist(); original = events._scope
        def cancel(*args):
            value = original(*args)
            self.agent.cancelled.set()
            return value
        with patch.object(events, '_scope', side_effect=cancel):
            self.assertIsNone(self.complete(reservation))
        self.assertEqual(self.rows(), []); self.assertEqual(self.event_rows(), [])

    def test_corrupt_stored_scalar_types_and_columns_do_not_replay(self):
        reservation = self.reserve(); self.persist(); self.complete(reservation)
        original = dict(self.rows()[0]); body = json.loads(original['body'])
        self.registry.db.execute('DROP TRIGGER immutable_session_turn_completion_update')
        malformed = {**body, 'initial_revision': True}
        encoded, digest = events._encoded(malformed)
        self.registry.db.execute('UPDATE session_turn_completions SET body=?,digest=?', (encoded, digest))
        with self.assertRaises(RegistryError): self.record(reservation)
        self.registry.db.execute('UPDATE session_turn_completions SET body=?,digest=?,final_revision=3',
                                 (original['body'], original['digest']))
        with self.assertRaises(RegistryError): self.record(reservation)
        self.assertEqual(len(self.event_rows()), 1)

    def test_saved_but_unrecorded_crash_gap_is_never_backfilled(self):
        self.reserve(); self.persist()
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(reopened.db.execute('SELECT count(*) FROM session_turn_completions').fetchone()[0], 0)
        self.assertEqual(self.event_rows(), [])

    def test_private_origin_scope_restores_after_nested_errors(self):
        self.assertIsNone(events.current_origin())
        self.assertIsNone(events.begin_for_agent(self.agent))
        with events.foreground_turn('foreground_prompt'):
            self.assertEqual(events.current_origin(), 'foreground_prompt')
            self.assertIsNotNone(events.begin_for_agent(self.agent))
            with self.assertRaisesRegex(ValueError, 'fixture'):
                with events.foreground_turn('monitor'):
                    self.assertIsNone(events.current_origin())
                    self.assertIsNone(events.begin_for_agent(self.agent))
                    raise ValueError('fixture')
            self.assertEqual(events.current_origin(), 'foreground_prompt')
            with events.foreground_turn('foreground_continue'):
                self.assertEqual(events.current_origin(), 'foreground_continue')
        self.assertIsNone(events.current_origin())
        for invalid in (None, {}, True, 'automatic'):
            with self.assertRaises(RegistryError), events.foreground_turn(invalid):
                self.fail('Unsupported origin entered')

    def test_origin_does_not_leak_to_other_worker_threads(self):
        with ThreadPoolExecutor(max_workers=1) as pool:
            with events.foreground_turn('foreground_prompt'):
                self.assertIsNone(pool.submit(events.current_origin).result())
            def worker():
                with events.foreground_turn('foreground_continue'):
                    return events.current_origin()
            self.assertEqual(pool.submit(worker).result(), 'foreground_continue')
            self.assertIsNone(pool.submit(events.current_origin).result())
