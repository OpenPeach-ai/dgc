"""Selected statement sources retain new-mode lineage, never test authority."""
from unittest import TestCase
from unittest.mock import patch

from dgc import pips, pip_commit_paths as paths, workspace_session_outcomes as outcomes
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests import test_pip_commit_paths_parent as parent_fixtures


class StatementSourceTests(TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    saved = parent_fixtures.ParentTests.saved
    save_manifest = parent_fixtures.ParentTests.save_manifest

    def completed(self):
        run_id, manifest, definition = self.saved()
        # Historical storage fixture only; no process or model is invoked.
        result = {'summary': 'Fixture source assessment.', 'findings': [], 'limitations': [],
                  'tests_executed': False,
                  'verification': 'Source excerpts checked against the pinned snapshot; findings are model assessments.'}
        self.registry.db.execute("UPDATE pip_runs SET status='succeeded',result=? WHERE id=?",
                                 (pips._json(result), run_id))
        return run_id, manifest, definition

    def source(self, run_id, workspace_id=None):
        return outcomes._source(self.registry, workspace_id or self.workspace['id'],
                                self.registry.binding(self.workspace['id']),
                                {'kind': 'pip_run', 'run_id': run_id})

    def test_valid_path_run_is_only_selected_historical_source_without_io(self):
        run_id, manifest, _ = self.completed()
        with patch('pathlib.Path.stat', side_effect=AssertionError('No source scan')):
            source, token = self.source(run_id)
        self.assertEqual(source['relation'], 'selected_for_statement')
        self.assertEqual(source['source_revision'], manifest['source_revision'])
        self.assertEqual(token[0], run_id)
        self.assertNotIn('tests_executed', source)

    def test_legacy_reference_keeps_previous_contract_and_unicode_actor(self):
        run_id, manifest, _ = self.completed()
        manifest.pop('event_trigger')
        manifest['trigger'] = 'manual'
        manifest['requested_by'] = 'é' * 128
        manifest['historical_extension'] = 'x' * 20000
        self.save_manifest(run_id, manifest)
        self.registry.db.execute('UPDATE pip_runs SET requested_by=?,idempotency_key=? WHERE id=?',
                                 ('é' * 128, '界' * 128, run_id))
        with patch.object(paths, '_encode', side_effect=AssertionError('No new-mode limit on legacy')):
            source, _ = self.source(run_id)
        self.assertEqual(source['relation'], 'selected_for_statement')
        self.assertEqual(source['source_revision'], manifest['source_revision'])

    def test_changed_compact_job_or_missing_match_cannot_supply_source(self):
        for change in ('job', 'match'):
            run_id, manifest, _ = self.completed()
            if change == 'job':
                manifest['job']['goal'] = 'Substituted unapproved goal.'
            else:
                del manifest['event_trigger']['commit_path_match']
            self.save_manifest(run_id, manifest)
            with self.subTest(change=change), self.assertRaises(RegistryError):
                self.source(run_id)

    def test_foreign_workspace_refuses_before_private_parent_decode(self):
        run_id, _, _ = self.completed()
        with patch.object(paths, '_load', side_effect=AssertionError('Foreign private decode')):
            with self.assertRaises(RegistryError):
                self.source(run_id, 'ws_' + 'f' * 32)

    def test_new_run_refuses_changed_or_oversized_actor_and_key(self):
        for field, value in (('requested_by', 'other'), ('requested_by', 'x' * 1000000),
                             ('idempotency_key', 'x' * 1000000)):
            run_id, _, _ = self.completed()
            self.registry.db.execute('DROP TRIGGER IF EXISTS immutable_run_manifest')
            self.registry.db.execute('UPDATE pip_runs SET ' + field + '=? WHERE id=?', (value, run_id))
            with self.subTest(field=field, size=len(value)), self.assertRaises(RegistryError):
                self.source(run_id)
