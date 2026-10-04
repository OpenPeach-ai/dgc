"""Native receipt reads/builders against actual schema16 rows, without transport."""
import copy
import hashlib
import json
import sqlite3
import unittest
from unittest.mock import patch

from dgc import session_execution_receipts as native
from dgc import workspace_session_execution as review
from dgc.workspace_registry import RegistryError
from tests import test_session_execution_receipts as fixtures
from tests.test_pips_local import config


class SessionExecutionReadTests(unittest.TestCase):
    setUp = fixtures.ExecutionReceiptTests.setUp
    begin = fixtures.ExecutionReceiptTests.begin
    facts = fixtures.ExecutionReceiptTests.facts
    rows = fixtures.ExecutionReceiptTests.rows

    @property
    def hub(self):
        return review.SessionExecutionStore(self.registry)

    @property
    def workspace(self):
        return self.origin['workspace_id']

    def ready(self, *, text='checked\n', code=0):
        self.receipt = self.begin()
        self.final = self.facts(self.receipt, text=text, code=code)
        return self.receipt.attempt['id']

    def get(self, attempt_id=None):
        return self.hub.get(self.workspace, attempt_id or self.receipt.attempt['id'], config=self.cfg)

    def candidate(self, receipt):
        provenance = review.context_provenance(receipt)
        return {'id': 'ctx_' + 'c' * 32, 'kind': 'command', 'title': review.title_for(provenance),
                'content': review.content_for(provenance), 'created_at': '2026-10-01T10:00:00Z',
                'created_by': 'human', 'created_revision': 1, 'status': 'active', 'provenance': provenance}

    def rewrite(self, table, change, *, raw=None, digest=True):
        trigger = 'immutable_session_execution_' + ('attempt_update' if table.endswith('attempts') else 'final_update')
        self.registry.db.execute('DROP TRIGGER IF EXISTS ' + trigger)
        row = self.registry.db.execute('SELECT rowid,body,digest FROM ' + table + ' LIMIT 1').fetchone()
        value = json.loads(row['body'])
        if change:
            change(value)
        encoded = raw if raw is not None else json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        hashed = hashlib.sha256(encoded.encode()).hexdigest() if digest else row['digest']
        self.registry.db.execute('UPDATE ' + table + ' SET body=?,digest=? WHERE rowid=?', (encoded, hashed, row['rowid']))

    def test_unfinalized_is_not_launch_or_success_and_cannot_build_context(self):
        self.receipt = self.begin()
        receipt = self.get()['receipt']
        self.assertEqual(receipt['state'], 'unfinalized')
        for key in ('final_digest', 'finalized_at', 'facts', 'output_preview', 'source_after', 'source_comparison'):
            self.assertIsNone(receipt[key])
        self.assertFalse(receipt['can_record'])
        self.assertEqual(receipt['record_blocked_reason'], 'unfinalized')
        with self.assertRaisesRegex(RegistryError, 'Only a recorded native final'):
            review.context_provenance(receipt)

    def test_native_nonzero_status_beats_success_prose_and_original_hashes_survive(self):
        self.ready(text='tests passed; exit code: 0\n', code=9)
        receipt = self.get()['receipt']
        self.assertEqual(receipt['state'], 'exited')
        self.assertEqual(receipt['facts']['exit_code'], 9)
        self.assertNotIn('preview', receipt['facts'])
        self.assertEqual(receipt['output_preview']['text'], 'tests passed; exit code: 0\n')
        self.assertEqual(receipt['attempt_digest'], self.receipt.digest)
        self.assertEqual(receipt['final_digest'], review._hash(self.final))
        self.assertTrue(receipt['can_record'])
        self.assertIsNone(receipt['record_blocked_reason'])

    def test_display_digest_exactly_hashes_the_safe_review_payload_not_mutable_links(self):
        self.ready()
        receipt = self.get()['receipt']
        payload = {k: v for k, v in receipt.items() if k not in ('view_digest', 'recording', 'can_record', 'record_blocked_reason')}
        self.assertEqual(review._hash(payload, review.MAX_DETAIL_BYTES), receipt['view_digest'])
        self.assertEqual(self.get()['receipt'], receipt)

    def test_read_has_no_source_transcript_process_or_registry_writes(self):
        self.ready()
        changed = self.registry.db.total_changes
        with patch.object(native, 'observe', side_effect=AssertionError('No source observation')), \
             patch('subprocess.Popen', side_effect=AssertionError('No process')), \
             patch('builtins.open', side_effect=AssertionError('No transcript/source file')):
            self.get()
            self.hub.list(self.workspace, config=self.cfg)
        self.assertEqual(self.registry.db.total_changes, changed)

    def test_foreign_workspace_and_foreign_record_refused_before_json_decode(self):
        self.ready()
        other = self.base / 'other'; other.mkdir()
        other_workspace = self.registry.resolve(other)['id']
        with patch.object(review, '_object', side_effect=AssertionError('No foreign decode')):
            with self.assertRaises(RegistryError):
                self.hub.get(other_workspace, self.receipt.attempt['id'], config=self.cfg)
            with self.assertRaisesRegex(RegistryError, 'not found'):
                self.hub.get(other_workspace, self.receipt.attempt['id'], config=config(other))

    def test_disabled_and_restricted_refuse_before_any_receipt_read(self):
        self.ready()
        for settings in ({'pips_enabled': False}, {'sandbox': True}):
            cfg = config(self.root, **settings)
            with patch.object(review.SessionExecutionStore, '_load', side_effect=AssertionError('No restricted read')):
                with self.assertRaises(RegistryError):
                    self.hub.get(self.workspace, self.receipt.attempt['id'], config=cfg)

    def test_oversized_and_nontext_cells_fail_before_decode(self):
        self.ready()
        self.registry.db.execute('PRAGMA ignore_check_constraints=ON')
        for payload in ('x' * 16385, b'{}'):
            self.rewrite('session_execution_attempts', None)
            self.registry.db.execute('UPDATE session_execution_attempts SET body=?', (payload,))
            with patch.object(review.json, 'loads', side_effect=AssertionError('No excessive decode')), self.assertRaises(RegistryError):
                self.get()
            # Restore only the fixture's immutable producer record.
            encoded, digest = native._encoded(self.receipt.attempt)
            self.registry.db.execute('UPDATE session_execution_attempts SET body=?,digest=?', (encoded, digest))

    def test_original_digest_and_attempt_final_link_are_checked(self):
        self.ready()
        self.rewrite('session_execution_finals', lambda v: v.update(attempt_digest='0' * 64))
        with self.assertRaisesRegex(RegistryError, 'not linked'):
            self.get()
        self.rewrite('session_execution_finals', lambda v: v.update(attempt_digest=self.receipt.digest), digest=False)
        with self.assertRaisesRegex(RegistryError, 'digest check'):
            self.get()

    def test_closed_native_fields_refuse_forged_states_and_source_claims(self):
        self.ready()
        encoded, digest = native._encoded(self.final)
        cases = [lambda v: v['facts'].update(state='passed'),
                 lambda v: v['facts'].update(tests_passed=True),
                 lambda v: v['source_after'].update(consistency='atomic'),
                 lambda v: v.update(source_comparison='changed_observation'),
                 lambda v: v.update(schema_version=True)]
        for change in cases:
            with self.subTest(change=change):
                self.rewrite('session_execution_finals', change)
                with self.assertRaises(RegistryError):
                    self.get()
                self.registry.db.execute('UPDATE session_execution_finals SET body=?,digest=?', (encoded, digest))

    def test_duplicate_nonfinite_deep_and_bad_unicode_json_are_refused(self):
        self.ready()
        encoded, digest = native._encoded(self.receipt.attempt)
        cases = ('{"schema_version":1,"schema_version":1}', '{"x":NaN}', '{"x":"\\ud800"}',
                 '{"x":' + '[' * 20 + '0' + ']' * 20 + '}')
        for raw in cases:
            self.rewrite('session_execution_attempts', None, raw=raw)
            with self.assertRaises(RegistryError):
                self.get()
            self.registry.db.execute('UPDATE session_execution_attempts SET body=?,digest=?', (encoded, digest))

    def test_new_secret_redaction_changes_view_digest_but_not_stored_hashes(self):
        secret = 'credential-for-later-redaction-123456'
        self.cfg.data['verify_command'] = 'printf ' + secret
        self.ready(text=secret + '\n')
        before = self.get()['receipt']
        with patch.object(review, 'secret_values', return_value=(secret,)):
            after = self.get()['receipt']
        self.assertNotIn(secret, json.dumps(after))
        self.assertTrue(after['command']['redacted']); self.assertTrue(after['output_preview']['redacted'])
        self.assertTrue(after['projection']['redacted'])
        self.assertNotEqual(before['view_digest'], after['view_digest'])
        self.assertEqual(before['attempt_digest'], after['attempt_digest'])
        self.assertEqual(before['final_digest'], after['final_digest'])
        self.assertEqual(before['facts'], after['facts'])

    def test_context_builder_is_small_canonical_and_contains_no_output_or_full_long_command(self):
        self.cfg.data['verify_command'] = 'printf ' + '字' * 2500
        self.ready(text='OUTPUT_BODY_NEVER_PROMOTED\n')
        receipt = self.get()['receipt']
        entry = self.candidate(receipt)
        review.validate_entry(entry)
        encoded = review._json_bytes(entry, 6144)
        self.assertNotIn(b'OUTPUT_BODY_NEVER_PROMOTED', encoded)
        self.assertNotIn(self.cfg.get('verify_command').encode(), encoded)
        self.assertTrue(entry['provenance']['command']['truncated'])
        self.assertLessEqual(len(entry['provenance']['command']['preview'].encode()), 256)
        self.assertIn('does not establish that tests ran or passed', entry['content'])
        self.assertNotIn('root_identity', encoded.decode()); self.assertNotIn('binding_id', encoded.decode())

    def test_context_validator_refuses_invented_qualification_and_unknown_fields(self):
        self.ready()
        for change in (lambda e: e.update(content='Tests passed and project is correct'),
                       lambda e: e['provenance'].update(raw_transcript='secret'),
                       lambda e: e['provenance']['facts'].update(state='passed'),
                       lambda e: e['provenance']['command'].update(preview='x' * 257)):
            entry = self.candidate(self.get()['receipt']); change(entry)
            with self.assertRaises(RegistryError):
                review.validate_entry(entry)

    def test_native_incomplete_output_and_failed_start_keep_exact_meaning(self):
        self.receipt = self.begin()
        facts = native.NativeFacts(self.receipt)
        facts.complete('failed_to_start', None, output_complete=True)
        receipt = self.get()['receipt']
        self.assertEqual(receipt['state'], 'failed_to_start')
        self.assertIsNone(receipt['facts']['started_at'])
        review.validate_entry(self.candidate(receipt))
        other = self.begin(); facts = native.NativeFacts(other); facts.started(); facts.feed_safe('partial')
        facts.complete('interrupted', -9, output_complete=False)
        receipt = self.get(other.attempt['id'])['receipt']
        self.assertFalse(receipt['facts']['output_complete'])
        self.assertEqual(receipt['facts']['output_bytes'], 7)
        self.assertIn('unknown missing size', receipt['projection']['notice'])

    def test_list_has_stable_scoped_pages_without_full_output(self):
        ids = []
        for i in range(5):
            ids.append(self.ready(text='OUTPUT_BODY_' + str(i)))
        expected = [r[0] for r in self.registry.db.execute('SELECT id FROM session_execution_attempts ORDER BY created_at DESC,id DESC')]
        page = self.hub.list(self.workspace, limit=2, config=self.cfg)
        self.assertEqual([r['id'] for r in page['receipts']], expected[:2])
        self.assertTrue(page['has_more']); self.assertEqual(page['total_in_scope'], 5)
        self.assertNotIn('OUTPUT_BODY_', json.dumps(page))
        second = self.hub.list(self.workspace, before_id=page['next_before_id'], limit=2, config=self.cfg)
        third = self.hub.list(self.workspace, before_id=second['next_before_id'], limit=2, config=self.cfg)
        self.assertEqual([r['id'] for r in second['receipts']], expected[2:4])
        self.assertFalse(third['has_more']); self.assertIsNone(third['next_before_id'])

    def test_list_rejects_foreign_session_cursor_and_invalid_page_limits(self):
        self.ready()
        self.registry.associate_session('second-chat', self.root)
        with self.assertRaises(RegistryError):
            self.hub.list(self.workspace, session_id='second-chat', before_id=self.receipt.attempt['id'], config=self.cfg)
        for limit in (True, 0, 21, 1.0, '2'):
            with self.assertRaises(RegistryError):
                self.hub.list(self.workspace, limit=limit, config=self.cfg)

    def test_source_unavailable_remains_unavailable_and_cannot_claim_unchanged(self):
        self.cfg.permissions = {'deny': ['Read(**)']}
        self.ready()
        receipt = self.get()['receipt']
        self.assertEqual(receipt['source_before'], {'status': 'unavailable', 'reason': 'source_permissions'})
        self.assertEqual(receipt['source_comparison'], 'unavailable')
        review.validate_entry(self.candidate(receipt))

    def test_wrong_stored_session_and_boolean_source_counts_refuse(self):
        self.receipt = self.begin()
        encoded, digest = native._encoded(self.receipt.attempt)
        for change in (lambda v: v.update(session_id='another-chat'), lambda v: v['source_before'].update(files=True)):
            self.rewrite('session_execution_attempts', change)
            with self.assertRaises(RegistryError):
                self.get()
            self.registry.db.execute('UPDATE session_execution_attempts SET body=?,digest=?', (encoded, digest))

    def test_historical_read_survives_missing_source_folder_without_filesystem_access(self):
        self.ready()
        (self.root / 'source.py').unlink(); self.root.rmdir()
        with patch('pathlib.Path.resolve', side_effect=AssertionError('No historical source resolution')), \
             patch('pathlib.Path.stat', side_effect=AssertionError('No historical source stat')):
            self.assertEqual(self.get()['receipt']['state'], 'exited')
            self.assertEqual(len(self.hub.list(self.workspace, config=self.cfg)['receipts']), 1)

    def test_fixed_notice_metadata_and_response_field_secret_collisions_fail_closed(self):
        self.ready()
        for secret in ('Historical', 'original_utf8', 'recording', 'total_in_scope'):
            with self.subTest(secret=secret), patch.object(review, 'secret_values', return_value=(secret,)):
                method = self.hub.list if secret == 'total_in_scope' else self.hub.get
                args = (self.workspace,) if secret == 'total_in_scope' else (self.workspace, self.receipt.attempt['id'])
                with self.assertRaisesRegex(RegistryError, 'displayed safely'):
                    method(*args, config=self.cfg)

    def test_projection_remains_byte_identical_through_outer_redaction(self):
        from dgc.redaction import redact_value
        secret = 'credential-hidden-later-123456789'
        self.ready(text=secret + '\n')
        with patch.object(review, 'secret_values', return_value=(secret,)):
            result = self.get()
        self.assertEqual(redact_value(result, (secret,)), result)

    def test_saved_recording_must_match_native_facts_and_have_only_one_active_entry(self):
        self.ready(code=7)
        receipt = self.get()['receipt']
        entry = self.candidate(receipt)
        review._match_recordings([entry], receipt)
        changed = copy.deepcopy(entry)
        changed['provenance']['facts']['exit_code'] = 0
        with self.assertRaisesRegex(RegistryError, 'immutable native evidence'):
            review._match_recordings([changed], receipt)
        with self.assertRaisesRegex(RegistryError, 'multiple active'):
            review._match_recordings([entry, copy.deepcopy(entry)], receipt)

    def test_pure_context_validation_rejects_surrogate_preview_as_registry_error(self):
        self.ready()
        entry = self.candidate(self.get()['receipt'])
        entry['provenance']['command']['preview'] = '\ud800'
        with self.assertRaises(RegistryError):
            review.validate_entry(entry)


if __name__ == '__main__':
    unittest.main()
