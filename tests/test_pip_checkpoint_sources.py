"""Checkpoint source domains, immutable legacy pins and explicit missing comparisons."""
import copy
import json
import unittest
from unittest.mock import patch

from dgc import pip_checkpoints as checkpoints
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from dgc.pips import PipStore
from tests import test_pip_checkpoints as fixtures
from tests import test_pip_sources as source_fixtures


class CheckpointSourcesTests(unittest.TestCase):
    setUp = fixtures.PipCheckpointTests.setUp
    new_pip = fixtures.PipCheckpointTests.new_pip
    finding = fixtures.PipCheckpointTests.finding
    report = fixtures.PipCheckpointTests.report
    complete = fixtures.PipCheckpointTests.complete
    policy = source_fixtures.PipSourcesTests.policy
    receipt = source_fixtures.PipSourcesTests.receipt

    def source_run(self, findings=None, **kwargs):
        run_id, result = fixtures.PipCheckpointTests.source_run(self, findings, **kwargs)
        receipt = (kwargs.get('manifest_changes') or {}).get('source_snapshot')
        if receipt is not None and kwargs.get('result') is None:
            # Model-result fixtures must report the same bounded source copy
            # the queue pinned. Explicit hostile result overrides stay intact.
            result['snapshot'] = {key: receipt[key] for key in ('sha256', 'files', 'bytes')}
        return run_id, result

    def tree_changes(self):
        pin = checkpoints.snapshot(self.store, self.job['id'])
        pin = checkpoints._pin({**{k: v for k, v in pin.items() if k != 'digest'}, 'schema_version': 2})
        return {'source_revision': None, 'source_policy': self.policy(), 'source_snapshot': self.receipt(), 'audit_checkpoint': pin}

    def test_empty_current_tree_policy_emits_v2_without_rewriting_v1(self):
        old = checkpoints.snapshot(self.store, self.job['id'])
        self.assertEqual(old['schema_version'], 1)
        job = self.store._job(self.job['id'])
        with patch.object(self.store, '_job', return_value={**job, 'source_policy': self.policy()}):
            current = checkpoints.snapshot(self.store, self.job['id'])
        self.assertEqual(current['schema_version'], 2)
        self.assertIsNone(current['checkpoint'])
        self.assertEqual(checkpoints.validate_snapshot(current), current)
        self.assertEqual(checkpoints.validate_snapshot(old), old)

    def test_first_tree_checkpoint_is_uncompared_not_implicitly_new(self):
        run, result = self.complete(manifest_changes=self.tree_changes())
        self.assertEqual(result['schema_version'], 2)
        self.assertIsNone(result['source_revision'])
        self.assertEqual(result['source_snapshot'], self.receipt())
        self.assertEqual(result['comparison'], {'status': 'unavailable', 'reason': 'no_checkpoint', 'previous_checkpoint_id': None})
        self.assertEqual(result['counts'], {'total': 1, 'new': None, 'repeated': None, 'not_observed': None})
        self.assertEqual(result['findings'][0]['comparison'], 'uncompared')
        pin = checkpoints.snapshot(self.store, self.job['id'])
        self.assertEqual(pin['schema_version'], 2)
        self.assertEqual(checkpoints.validate_snapshot(pin), pin)
        with WorkspaceRegistry(self.registry.directory) as reopened:
            self.assertEqual(checkpoints.for_run(PipStore(reopened), run), result)

    def test_same_tree_policy_compares_exact_occurrences_across_snapshots(self):
        _, first = self.complete([self.finding(), self.finding('Missing next time')], manifest_changes=self.tree_changes())
        changes = self.tree_changes(); changes['source_snapshot']['sha256'] = 'c' * 64
        _, second = self.complete([self.finding(line=12), self.finding('Another')], manifest_changes=changes)
        self.assertEqual(second['comparison'], {'status': 'compared', 'reason': None, 'previous_checkpoint_id': first['id']})
        self.assertEqual(second['baseline_checkpoint_id'], first['id'])
        self.assertEqual(second['counts'], {'total': 2, 'new': 1, 'repeated': 1, 'not_observed': 1})
        self.assertEqual([f['comparison'] for f in second['findings']], ['repeated', 'new'])

    def test_commit_to_tree_to_commit_never_infers_resolution_or_new_occurrences(self):
        old_run, old = self.complete()
        old_pin = checkpoints.snapshot(self.store, self.job['id'])
        old_payload = self.registry.db.execute('SELECT payload FROM pip_checkpoints WHERE run_id=?', (old_run,)).fetchone()[0]
        _, current = self.complete(manifest_changes=self.tree_changes())
        _, back = self.complete()
        for item, prior in ((current, old), (back, current)):
            self.assertEqual(item['comparison'], {'status': 'unavailable', 'reason': 'source_policy_changed', 'previous_checkpoint_id': prior['id']})
            self.assertIsNone(item['baseline_checkpoint_id'])
            self.assertIsNone(item['counts']['not_observed'])
            self.assertEqual(item['findings'][0]['comparison'], 'uncompared')
        self.assertEqual(back['source_policy'], {'mode': 'committed_only'})
        self.assertIsNone(back['source_snapshot'])
        self.assertEqual(back['source_revision'], 'a' * 40)
        self.assertEqual(checkpoints.validate_snapshot(old_pin), old_pin)
        self.assertEqual(checkpoints.for_run(self.store, old_run), old)
        self.assertEqual(self.registry.db.execute('SELECT payload FROM pip_checkpoints WHERE run_id=?', (old_run,)).fetchone()[0], old_payload)
        _, later = self.complete()
        self.assertEqual(later['counts']['repeated'], 1)
        self.assertEqual(later['baseline_checkpoint_id'], back['id'])
        history = checkpoints.history(self.store, self.job['id'])['checkpoints']
        by_id = {item['id']: item for item in history}
        self.assertNotIn('schema_version', by_id[old['id']])
        for checkpoint in (current, back, later):
            item = by_id[checkpoint['id']]
            for key in ('schema_version', 'source_policy', 'source_snapshot', 'comparison'):
                self.assertEqual(item[key], checkpoint[key])

    def test_tree_worker_cannot_relabel_legacy_pin_as_new_source_without_v2(self):
        changes = self.tree_changes()
        changes['audit_checkpoint'] = checkpoints.snapshot(self.store, self.job['id'])
        run, result = self.source_run(manifest_changes=changes)
        with self.assertRaisesRegex(RegistryError, 'version 2'):
            self.store.finish(run, result=result)
        self.assertEqual(self.store.run(run)['status'], 'running')
        self.assertIsNone(checkpoints.for_run(self.store, run))

    def test_queued_v2_baseline_does_not_follow_later_source_change(self):
        _, first = self.complete(manifest_changes=self.tree_changes())
        pending, result = self.source_run(manifest_changes=self.tree_changes())
        _, switched = self.complete([])
        self.store.finish(pending, result=result)
        finished = checkpoints.for_run(self.store, pending)
        self.assertNotEqual(first['id'], switched['id'])
        self.assertEqual(finished['baseline_checkpoint_id'], first['id'])
        self.assertEqual(finished['counts']['repeated'], 1)

    def test_review_and_omission_contract_survives_uncompared_source(self):
        findings = [self.finding(f'Finding {i}', evidence=str(i) + 'x' * 998) for i in range(16)]
        run, _ = self.complete(findings, manifest_changes=self.tree_changes())
        reviewed = checkpoints.review_finding(self.store, run, 0, 'accepted', 0, 'human', 'Review selected this source assessment.')
        self.assertEqual(reviewed['findings'][0]['review']['status'], 'accepted')
        pin = checkpoints.snapshot(self.store, self.job['id'])
        self.assertGreater(pin['checkpoint']['omitted_findings'], 0)
        self.assertEqual(pin['checkpoint']['total_findings'], 16)
        self.assertEqual(len(pin['checkpoint']['finding_identities']), 16)
        self.assertEqual(checkpoints.validate_snapshot(pin), pin)
        self.assertLessEqual(len(checkpoints._encoded(pin, checkpoints.MAX_SNAPSHOT_BYTES)), 8192)

    def test_v2_envelope_can_wrap_unchanged_legacy_checkpoint(self):
        _, old = self.complete()
        pin = checkpoints.snapshot(self.store, self.job['id'])
        wrapped = checkpoints._pin({**{k: v for k, v in pin.items() if k != 'digest'}, 'schema_version': 2})
        self.assertEqual(checkpoints.validate_snapshot(wrapped), wrapped)
        self.assertEqual(wrapped['checkpoint'], pin['checkpoint'])
        self.assertNotIn('schema_version', old)

    def test_hostile_source_metadata_and_fabricated_comparison_are_refused(self):
        _, current = self.complete(manifest_changes=self.tree_changes())
        original = checkpoints.snapshot(self.store, self.job['id'])
        mutations = [lambda p: p.update(schema_version=1),
                     lambda p: p['checkpoint'].update(schema_version=True),
                     lambda p: p['checkpoint'].update(source_revision='b' * 64),
                     lambda p: p['checkpoint'].update(source_policy='committed_only'),
                     lambda p: p['checkpoint']['source_snapshot'].update(consistency='atomic'),
                     lambda p: p['checkpoint']['counts'].update(new=1),
                     lambda p: p['checkpoint']['counts'].update(total=True),
                     lambda p: p['checkpoint']['comparison'].update(previous_checkpoint_id=current['id']),
                     lambda p: p['checkpoint']['comparison'].update(status='compared'),
                     lambda p: p['checkpoint']['comparison'].update(reason='source_policy_changed'),
                     lambda p: p['checkpoint']['findings'][0].update(comparison='new'),
                     lambda p: p['checkpoint'].update(extra='invented')]
        for mutate in mutations:
            bad = copy.deepcopy(original); mutate(bad)
            bad = checkpoints._pin({k: v for k, v in bad.items() if k != 'digest'})
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                checkpoints.validate_snapshot(bad)

    def test_forged_compared_counts_and_uncompared_occurrences_refused(self):
        self.complete(manifest_changes=self.tree_changes())
        self.complete(manifest_changes=self.tree_changes())
        original = checkpoints.snapshot(self.store, self.job['id'])
        for mutate in (lambda p: p['checkpoint']['counts'].update(new=None),
                       lambda p: p['checkpoint']['comparison'].update(reason='no_checkpoint'),
                       lambda p: p['checkpoint'].update(baseline_checkpoint_id=None),
                       lambda p: p['checkpoint']['findings'][0].update(comparison='uncompared')):
            bad = copy.deepcopy(original); mutate(bad)
            bad = checkpoints._pin({k: v for k, v in bad.items() if k != 'digest'})
            with self.assertRaises(RegistryError): checkpoints.validate_snapshot(bad)

    def test_full_and_partial_occurrence_counts_must_agree_in_both_versions(self):
        for tree in (False, True):
            self.job = self.new_pip()
            changes = self.tree_changes() if tree else None
            self.complete(manifest_changes=changes)
            changes = self.tree_changes() if tree else None
            self.complete(manifest_changes=changes)
            pin = checkpoints.snapshot(self.store, self.job['id'])
            self.assertEqual(pin['checkpoint']['findings'][0]['comparison'], 'repeated')
            pin['checkpoint']['counts'].update(new=1, repeated=0)
            pin = checkpoints._pin({k: v for k, v in pin.items() if k != 'digest'})
            with self.assertRaisesRegex(RegistryError, 'declared counts'):
                checkpoints.validate_snapshot(pin)
            # A byte-limited prefix cannot contain more repeated entries than
            # the declared total, even when omitted suffix labels are unknown.
            pin['checkpoint']['total_findings'] = 2
            pin['checkpoint']['omitted_findings'] = 1
            pin['checkpoint']['finding_identities'].append('a' * 64)
            pin['checkpoint']['counts'].update(total=2, new=2, repeated=0)
            pin = checkpoints._pin({k: v for k, v in pin.items() if k != 'digest'})
            with self.assertRaisesRegex(RegistryError, 'declared counts'):
                checkpoints.validate_snapshot(pin)

    def test_stored_source_identity_must_match_immutable_run(self):
        for tree in (False, True):
            self.job = self.new_pip()
            run, checkpoint = self.complete(manifest_changes=self.tree_changes() if tree else None)
            forged = {k: v for k, v in checkpoint.items() if k != 'id'}
            for finding in forged['findings']: finding.pop('review')
            if tree: forged['source_snapshot']['sha256'] = 'd' * 64
            else: forged['source_revision'] = 'd' * 40
            # Simulate external database corruption; the production immutable
            # trigger is removed only in this disposable private fixture.
            self.registry.db.execute('DROP TRIGGER IF EXISTS immutable_pip_checkpoint')
            self.registry.db.execute('UPDATE pip_checkpoints SET payload=? WHERE run_id=?', (json.dumps(forged), run))
            for read in (lambda: checkpoints.for_run(self.store, run),
                         lambda: checkpoints.history(self.store, self.job['id']),
                         lambda: checkpoints.snapshot(self.store, self.job['id'])):
                with self.assertRaisesRegex(RegistryError, 'source identity'):
                    read()


if __name__ == '__main__':
    unittest.main()
