"""Explicit source-exception CLI review; no model, network or clock sleeps."""
import unittest
from dgc import pip_cli


class MemoryCLITests(unittest.TestCase):
    def request(self, *args):
        return pip_cli._request(pip_cli.parser().parse_args(['memory', *args]))

    def test_source_read_has_no_write_authority_or_caller_source_body(self):
        value = self.request('source', 'pip_a', 'run_a', '0')
        self.assertEqual(value['type'], 'get_pip_exception_source')
        self.assertEqual(value['finding_index'], 0)
        self.assertNotIn('reason', value)
        self.assertNotIn('source', value)

    def test_record_requires_source_digest_and_retry_key(self):
        value = self.request('record', 'pip_a', 'run_a', '2', '--source-digest', 'a' * 64,
                             '--reason', 'Reviewed exception', '--request-key', 'same-exception')
        self.assertEqual(value['type'], 'record_pip_exception')
        self.assertEqual(value['expected_source_digest'], 'a' * 64)
        self.assertEqual(value['request_key'], 'same-exception')
        self.assertNotIn('expires_at', value)
        dated = self.request('record', 'pip_a', 'run_a', '2', '--source-digest', 'a' * 64,
                             '--reason', 'Reviewed exception', '--request-key', 'same-exception',
                             '--expires-at', '2026-10-03T00:00:00Z')
        self.assertEqual(dated['expires_at'], '2026-10-03T00:00:00Z')

    def test_revoke_and_history_do_not_masquerade_as_run_or_approval(self):
        value = self.request('revoke', 'pip_a', 'memory_a', '--expected-revision', '0', '--reason', 'Revisit')
        self.assertEqual((value['type'], value['memory_id'], value['expected_revision']), ('revoke_pip_exception', 'memory_a', 0))
        page = self.request('list', 'pip_a', '--before-id', '9', '--limit', '4')
        self.assertEqual((page['type'], page['before_id'], page['limit']), ('list_pip_memories', 9, 4))

    def test_rendered_receipts_explain_reference_and_queued_snapshot_limits(self):
        text = pip_cli._format({'memory': {'id': 'memory_a', 'status': 'active', 'revision': 0}, 'replayed': True})
        self.assertIn('reference only', text)
        self.assertIn('no second exception', text)
        self.assertIn('queued snapshots retain', text)
        source = pip_cli._format({'pip_id': 'pip_a', 'source': {'finding_index': 0}, 'digest': 'a' * 64})
        self.assertIn('does not hide findings', source)


if __name__ == '__main__':
    unittest.main()
