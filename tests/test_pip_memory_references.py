"""Typed queue references preserve whole records, provenance and v1 compatibility."""
import copy
import json
import unittest
from unittest.mock import patch

from dgc import pip_memory as memory, pip_memory_references as refs, pip_memory_statements as statements
from dgc.pip_sources import pin
from dgc.workspace_context import ContextStore
from dgc.workspace_registry import RegistryError
from tests import test_pip_memory_statements as fixtures


class TypedMemoryTests(unittest.TestCase):
    setUp = fixtures.StatementTests.setUp
    new_pip = fixtures.StatementTests.new_pip
    finding = fixtures.StatementTests.finding
    report = fixtures.StatementTests.report
    source_run = fixtures.StatementTests.source_run
    complete = fixtures.StatementTests.complete
    candidate = fixtures.StatementTests.candidate
    save = fixtures.StatementTests.save
    exception = fixtures.StatementTests.exception

    def snap(self, *, source=None, version=1, now=None, context=None):
        current = ContextStore(self.registry).snapshot(self.workspace['id'])
        return memory.snapshot(self.store, self.job['id'], source or pin('committed_only', source_revision='a' * 40),
            version, now or self.registry.clock(), context_reference=context or {k: current[k] for k in ('revision', 'digest')})

    @staticmethod
    def resign(value):
        value['digest'] = memory._digest({k: v for k, v in value.items() if k != 'digest'}, memory.MAX_SNAPSHOT_BYTES)
        return value

    def test_no_statement_history_keeps_exact_v1_contract(self):
        before = self.snap()
        self.assertEqual(before['schema_version'], 1)
        self.assertEqual(set(before), {'schema_version', 'pip_id', 'workspace_id', 'source', 'job_version', 'as_of',
            'total_records', 'revoked_records', 'expired_records', 'eligible_records', 'omitted_records', 'entries', 'digest'})
        statements.history(self.store, self.job['id'])
        statements.anchor(self.store, self.job['id'])
        self.assertEqual(memory._encoded(before, 8192), memory._encoded(self.snap(), 8192))
        self.exception()
        original = self.snap()
        with patch.object(refs, 'snapshot', side_effect=AssertionError('No typed dispatch without statement history')):
            self.assertEqual(memory._encoded(self.snap(), 8192), memory._encoded(original, 8192))
            self.assertEqual(memory.validate_snapshot(original), original)

    def test_round_robin_and_whole_original_records_have_exact_kind_counts(self):
        exception = self.exception()['memory']
        fact = self.save()['memory']
        preference = self.save(key='preference', kind='preference')['memory']
        value = self.snap()
        self.assertEqual(value['schema_version'], 2)
        self.assertEqual([e['memory']['kind'] for e in value['entries']], ['finding_exception', 'fact', 'preference'])
        self.assertEqual([e['memory'] for e in value['entries']], [exception, fact, preference])
        self.assertEqual(value['eligible_records'], 3)
        self.assertEqual(value['omitted_records'], 0)
        self.assertTrue(all(group['eligible_records'] == 1 for group in value['counts_by_kind'].values()))
        self.assertEqual(memory.validate_snapshot(value), value)
        self.assertLessEqual(len(memory._encoded(value, 8192)), 8192)

    def test_unobserved_source_never_inherits_source_equality(self):
        self.save()
        value = self.snap()
        self.assertEqual(value['entries'][0]['applicability'], {'source': 'not_observed', 'job': 'same_pinned_job', 'context': 'same_pinned_context'})
        bad = copy.deepcopy(value)
        bad['entries'][0]['applicability']['source'] = 'same_pinned_source'
        with self.assertRaises(RegistryError): memory.validate_snapshot(self.resign(bad))

    def test_selected_source_job_and_context_are_independent_comparisons(self):
        run, _ = self.complete()
        self.save(run=run)
        self.assertEqual(self.snap()['entries'][0]['applicability']['source'], 'same_pinned_source')
        ContextStore(self.registry).record(self.workspace['id'], 'decision', 'New decision', 'Current reference', 0, 'human')
        value = self.snap(source=pin('committed_only', source_revision='b' * 40), version=2)
        self.assertEqual(value['entries'][0]['applicability'], {'source': 'historical_source', 'job': 'historical_job', 'context': 'historical_context'})

    def test_revoked_or_expired_history_still_selects_v2_without_rewriting_old_pin(self):
        saved = self.save(expires_at='2026-10-01T11:00:00.000Z')['memory']
        old = self.snap(); raw = memory._encoded(old, 8192)
        later = self.snap(now='2026-10-01T11:00:00.000Z')
        self.assertEqual((later['schema_version'], later['expired_records'], later['entries']), (2, 1, []))
        statements.revoke(self.store, self.job['id'], saved['id'], 0, 'Reconsider', 'human')
        revoked = self.snap(now='2026-10-01T11:00:00.000Z')
        self.assertEqual((revoked['revoked_records'], revoked['expired_records']), (1, 0))
        self.assertEqual(memory._encoded(memory.validate_snapshot(old), 8192), raw)

    def test_large_record_skipped_whole_and_smaller_kind_can_fit(self):
        self.save(statement='x' * 2000, reason='y' * 1000)
        small = self.save(key='small', kind='preference', statement='Short note')['memory']
        with patch.object(memory, 'MAX_SNAPSHOT_BYTES', 3200):
            value = self.snap()
        self.assertEqual([e['memory'] for e in value['entries']], [small])
        self.assertEqual(value['counts_by_kind']['fact']['omitted_records'], 1)
        self.assertEqual(value['omitted_records'], 1)

    def test_duplicate_ids_forged_counts_and_unknown_fields_refuse_even_when_resigned(self):
        self.save(); good = self.snap()
        variants = []
        bad = copy.deepcopy(good); bad['entries'].append(copy.deepcopy(bad['entries'][0])); variants.append(bad)
        bad = copy.deepcopy(good); bad['counts_by_kind']['fact']['eligible_records'] = True; variants.append(bad)
        bad = copy.deepcopy(good); bad['counts_by_kind']['fact']['omitted_records'] = 1; variants.append(bad)
        bad = copy.deepcopy(good); bad['entries'][0]['applicability']['authority'] = 'execute'; variants.append(bad)
        bad = copy.deepcopy(good); bad['extra'] = 'unsupported'; variants.append(bad)
        for value in variants:
            with self.subTest(value=str(value)[:60]), self.assertRaises(RegistryError):
                memory.validate_snapshot(self.resign(value))

    def test_wrong_run_scope_or_context_refuses(self):
        self.save(); value = self.snap()
        for overrides in ({'pip_id': 'pip_' + 'f' * 32}, {'workspace_id': 'ws_' + 'f' * 32},
                          {'job_version': 2}, {'context_reference': {'revision': 999, 'digest': '0' * 64}},
                          {'source': pin('committed_only', source_revision='b' * 40)}):
            with self.subTest(overrides=overrides), self.assertRaises(RegistryError):
                memory.validate_snapshot(value, **overrides)

    def test_record_or_byte_limit_is_checked_before_any_agent(self):
        self.save(); value = self.snap()
        many = copy.deepcopy(value); many['entries'] *= 17
        with self.assertRaises(RegistryError): memory.validate_snapshot(many)
        large = copy.deepcopy(value); large['entries'][0]['memory']['statement'] = 'x' * 8193
        with self.assertRaises(RegistryError): memory.validate_snapshot(large)


if __name__ == '__main__': unittest.main()
