"""Actual Agent final-save boundary for native saved-turn events; no network."""
from contextlib import nullcontext
import json
import unittest
from unittest.mock import patch

from dgc import sessions, workspace_sessions, session_turn_events as events
from dgc.llm import ChatResult
from dgc.workspace_registry import WorkspaceRegistry, _execute_schema
from tests import test_pip_proposal_tool as fixture
from tests.pip_test_profile import pips_in_use


class SessionTurnAgentTests(unittest.TestCase):
    agent = fixture.PipProposalToolTests.agent

    def setUp(self):
        pips_in_use(self)
        fixture.PipProposalToolTests.setUp(self)
        self.cfg.data.update(auto_compact=False, verify_before_done=False, verify_command='',
                             auto_title=False, max_turns=3)
        if not self.registry.db.execute("SELECT 1 FROM sqlite_master WHERE name='session_turn_completions'").fetchone():
            with self.registry.transaction():
                _execute_schema(self.registry.db, events.SCHEMA)
        def registry(directory=None):
            return WorkspaceRegistry(directory or self.registry.directory)
        for module in (events, workspace_sessions):
            patched = patch.object(module, 'WorkspaceRegistry', registry)
            patched.start(); self.addCleanup(patched.stop)
        no_network = patch('requests.sessions.Session.request', side_effect=AssertionError('No network'))
        no_network.start(); self.addCleanup(no_network.stop)

    def rows(self):
        return [json.loads(row['body']) for row in self.registry.db.execute('SELECT body FROM session_turn_completions')]

    def turn(self, agent, origin='foreground_prompt', response=None):
        scope = events.foreground_turn(origin) if origin is not None else nullcontext()
        with scope, patch.object(agent.client, 'chat', return_value=response or ChatResult(content='Done.')):
            return agent.run_turn('Inspect this request and respond briefly.')

    def test_successful_native_turn_saves_then_records_one_completion(self):
        agent, _ = self.agent()
        self.assertTrue(self.turn(agent))
        row, = self.rows()
        self.assertEqual(row['session_id'], agent.session_file.stem)
        self.assertEqual(row['final_revision'], agent._session_revision)
        saved = sessions.load_record(agent.session_file, agent.session_root)
        self.assertEqual(saved['revision'], row['final_revision'])
        self.assertEqual(row['outcome'], 'foreground_turn_saved')
        self.assertEqual(row['verification'], 'no_execution_or_test_claim')
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM workspace_events WHERE event_type=?',
                                                  (events.EVENT_TYPE,)).fetchone()[0], 1)
        self.assertIsNone(events.current_origin())

    def test_first_turn_associates_before_reservation_and_final_save(self):
        agent, _ = self.agent()
        self.assertFalse(agent._session_exists)
        self.assertIsNone(self.registry.session_identity(agent.session_file.stem))
        captured = []; original = events.begin_for_agent
        def begin(current, **kwargs):
            self.assertIsNotNone(self.registry.session_identity(current.session_file.stem))
            reservation = original(current, **kwargs)
            captured.append(reservation)
            return reservation
        with patch.object(events, 'begin_for_agent', side_effect=begin):
            self.assertTrue(self.turn(agent))
        self.assertEqual(len(captured), 1)
        self.assertIsNotNone(captured[0])
        self.assertFalse(captured[0].initial_exists)
        self.assertEqual(captured[0].initial_revision, 0)
        self.assertTrue(agent._session_exists)
        self.assertEqual(len(self.rows()), 1)

    def test_no_origin_and_excluded_automatic_origins_never_reserve(self):
        for origin in (None, *sorted(events.EXCLUDED_ORIGINS)):
            with self.subTest(origin=origin):
                agent, _ = self.agent()
                with patch.object(events, 'begin_for_agent', side_effect=AssertionError('No foreground reservation')):
                    self.assertTrue(self.turn(agent, origin=origin))
        self.assertEqual(self.rows(), [])

    def test_explicit_continue_records_distinct_successful_saved_turn(self):
        agent, _ = self.agent()
        self.assertTrue(self.turn(agent))
        self.assertTrue(self.turn(agent, origin='foreground_continue'))
        first, second = self.rows()
        self.assertNotEqual(first['turn_id'], second['turn_id'])
        self.assertGreater(second['final_revision'], first['final_revision'])
        self.assertEqual(second['origin'], 'foreground_continue')

    def test_failed_final_persist_emits_no_completion(self):
        agent, _ = self.agent(); state = {'finished': False}
        original_turn, original_persist = agent._run_turn, agent._persist
        def inner(*args, **kwargs):
            result = original_turn(*args, **kwargs)
            state['finished'] = True
            return result
        def persist(*args, **kwargs):
            if state['finished']:
                with patch.object(sessions, 'save', return_value=False):
                    return original_persist(*args, **kwargs)
            return original_persist(*args, **kwargs)
        with patch.object(agent, '_run_turn', side_effect=inner), patch.object(agent, '_persist', side_effect=persist):
            self.assertFalse(self.turn(agent))
        self.assertTrue(state['finished'])
        self.assertTrue(agent._last_persist_error)
        self.assertEqual(self.rows(), [])

    def test_session_deleted_before_final_persist_is_not_recreated_or_completed(self):
        agent, _ = self.agent()
        self.assertTrue(agent._persist())
        original = agent._run_turn
        def delete_after_response(*args, **kwargs):
            result = original(*args, **kwargs)
            self.assertTrue(agent.session_file.exists())
            agent.session_file.unlink()
            return result
        with patch.object(agent, '_run_turn', side_effect=delete_after_response):
            self.assertFalse(self.turn(agent))
        self.assertFalse(agent.session_file.exists())
        self.assertEqual(self.rows(), [])

    def test_native_cancellation_before_final_save_never_records(self):
        agent, _ = self.agent(); original = agent._run_turn
        def cancel_after_response(*args, **kwargs):
            result = original(*args, **kwargs)
            agent.cancelled.set()
            return result
        with patch.object(agent, '_run_turn', side_effect=cancel_after_response):
            self.turn(agent)
        self.assertTrue(agent.cancelled.is_set())
        self.assertEqual(self.rows(), [])

    def test_stop_hook_cancellation_after_successful_save_never_records(self):
        agent, _ = self.agent(); original = agent._run_lifecycle_hooks
        stopped = []
        def hook(name, *args, **kwargs):
            if name == 'Stop':
                stopped.append(agent._session_revision)
                self.assertTrue(agent._session_exists)
                agent.cancelled.set()
            return original(name, *args, **kwargs)
        with patch.object(agent, '_run_lifecycle_hooks', side_effect=hook):
            self.turn(agent)
        self.assertTrue(stopped)
        self.assertEqual(self.rows(), [])

    def test_partial_progress_saves_do_not_create_events(self):
        agent, _ = self.agent(); original = agent._persist
        counts = []
        def persist(*args, **kwargs):
            self.assertEqual(self.rows(), [])
            result = original(*args, **kwargs)
            counts.append(agent._session_revision)
            return result
        with patch.object(agent, '_persist', side_effect=persist):
            self.assertTrue(self.turn(agent))
        self.assertTrue(counts)
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.rows()[0]['final_revision'], counts[-1])

    def test_terminal_model_failure_does_not_become_saved_completion(self):
        agent, _ = self.agent()
        with events.foreground_turn('foreground_prompt'), patch.object(agent.client, 'chat', side_effect=ValueError('fixture failed')):
            try:
                result = agent.run_turn('Finish this request.')
            except ValueError:
                result = False
        self.assertFalse(result)
        self.assertEqual(self.rows(), [])

    def test_completion_record_failure_does_not_change_successful_chat_outcome(self):
        agent, _ = self.agent()
        with patch.object(events, 'record', side_effect=RuntimeError('fixture storage failure')):
            self.assertTrue(self.turn(agent))
        self.assertTrue(agent.session_file.exists())
        self.assertEqual(self.rows(), [])
