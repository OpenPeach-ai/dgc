"""Human statement commands preserve review pins and existing controller policy."""
import copy
import contextlib
import io
import json
import unittest
from unittest.mock import patch

from dgc import pips, pip_cli
from tests import test_pip_memory_controls as fixtures


class StatementControls(unittest.TestCase):
    setUp = fixtures.MemoryControlTests.setUp
    git = fixtures.MemoryControlTests.git
    commit = fixtures.MemoryControlTests.commit
    create = fixtures.MemoryControlTests.create
    completed = fixtures.MemoryControlTests.completed
    control = fixtures.MemoryControlTests.control

    def ready(self):
        job = self.create()
        candidate = self.control({'type': 'get_pip_statement_anchor', 'pip_id': job['id']})
        self.assertTrue(candidate['ok'], candidate)
        request = {'type': 'record_pip_statement', 'pip_id': job['id'], 'kind': 'fact', 'title': 'Ownership',
                   'statement': 'This package owns invoicing.', 'reason': 'Maintainer records this claim.',
                   'expires_at': None, 'expected_anchor_digest': candidate['result']['digest'], 'request_key': 'human-review'}
        return job, request

    def test_full_controller_record_history_revoke_retry_keeps_config_and_context(self):
        before = copy.deepcopy(self.cfg.data), copy.deepcopy(self.cfg.permissions)
        job, request = self.ready(); result = self.control(request)
        self.assertTrue(result['ok'], result)
        saved = result['result']['memory']
        self.assertEqual(saved['created_by'], 'review-device')
        self.assertEqual(saved['classification'], 'user_recorded_claim')
        self.assertIsNone(saved['anchor']['source_reference'])
        self.assertTrue(self.control(request)['result']['replayed'])
        page = self.control({'type': 'list_pip_statements', 'pip_id': job['id']})['result']
        self.assertEqual(page['entries'], [{'memory': saved, 'effective_status': 'active'}])
        revoke = {'type': 'revoke_pip_statement', 'pip_id': job['id'], 'memory_id': saved['id'],
                  'expected_revision': 0, 'reason': 'Review again'}
        self.assertEqual(self.control(revoke)['result']['memory']['status'], 'revoked')
        self.assertTrue(self.control(revoke)['result']['replayed'])
        self.assertEqual(self.control(request)['result']['memory']['status'], 'revoked')
        self.assertEqual((self.cfg.data, self.cfg.permissions), before)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM workspace_context_entries').fetchone()[0], 0)
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_runs').fetchone()[0], 0)

    def test_all_operations_refuse_foreground_policy_and_sandbox_before_registry(self):
        job, request = self.ready()
        requests = [request, {'type': 'get_pip_statement_anchor', 'pip_id': job['id']},
                    {'type': 'list_pip_statements', 'pip_id': job['id']},
                    {'type': 'revoke_pip_statement', 'pip_id': job['id'], 'memory_id': 'memory_' + 'f' * 32,
                     'expected_revision': 0, 'reason': 'Review'}]
        for restriction in ('dgc.permissions.session_policy', 'dgc.sandbox.requested'):
            for value in requests:
                with patch(restriction, return_value=object()), patch.object(pips, 'WorkspaceRegistry', side_effect=AssertionError('No independent registry')):
                    result = self.control(value)
                self.assertFalse(result['ok']); self.assertEqual(result['error']['code'], 'session_policy')
        self.cfg.data['pips_enabled'] = False
        for value in requests:
            with patch.object(pips, 'WorkspaceRegistry', side_effect=AssertionError('Disabled')):
                self.assertEqual(self.control(value)['error']['code'], 'disabled')

    def test_explicit_expiry_null_fields_reserved_authority_and_stale_anchor(self):
        job, request = self.ready()
        missing = dict(request); missing.pop('expires_at')
        variants = [missing, {**request, 'source_run_id': None}, {**request, 'actor': 'forged'},
                    {**request, 'permissions': {'allow': ['Bash']}}, {**request, 'expected_anchor_digest': '0' * 64},
                    {'type': 'list_pip_statements', 'pip_id': job['id'], 'before_id': None},
                    {'type': 'list_pip_statements', 'pip_id': job['id'], 'limit': True}]
        for value in variants:
            with self.subTest(command=value): self.assertFalse(self.control(value)['ok'])
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_memory_statements').fetchone()[0], 0)

    def test_secret_is_refused_before_generic_controller_redaction(self):
        job, request = self.ready(); secret = 'fixture-only-api19-secret-value'
        self.cfg.set('api_key', secret, persist=False)
        for field in ('title', 'statement', 'reason', 'request_key'):
            response = self.control({**request, field: secret})
            self.assertEqual(response['error']['code'], 'secret_detected')
            self.assertNotIn(secret, json.dumps(response))
        self.assertEqual(self.registry.db.execute('SELECT count(*) FROM pip_memory_statements').fetchone()[0], 0)

    def test_no_implicit_workspace_resolution_and_same_pip_source_required(self):
        job, request = self.ready(); other = self.create(); run = self.completed(other, 'other-audit')
        with patch('dgc.workspace_registry.WorkspaceRegistry.resolve', side_effect=AssertionError('Do not register controller cwd')):
            self.assertTrue(self.control(request)['ok'])
            self.assertTrue(self.control({'type': 'list_pip_statements', 'pip_id': job['id']})['ok'])
            refused = self.control({'type': 'get_pip_statement_anchor', 'pip_id': job['id'], 'source_run_id': run['id']})
        self.assertFalse(refused['ok']); self.assertEqual(refused['error']['code'], 'not_found')


class StatementCLI(unittest.TestCase):
    def request(self, *args):
        return pip_cli._request(pip_cli.parser().parse_args(['memory', 'statements', *args]))

    def test_anchor_record_require_exact_review_and_explicit_expiry(self):
        self.assertEqual(self.request('anchor', 'pip_subject')['type'], 'get_pip_statement_anchor')
        args = ['record', 'pip_subject', '--kind', 'preference', '--title', 'Tone', '--statement', 'Be concise',
                '--reason', 'Review choice', '--request-key', 'retry', '--anchor-digest', 'a' * 64]
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): self.request(*args)
        request = self.request(*args, '--no-expiry')
        self.assertEqual(request['type'], 'record_pip_statement'); self.assertIsNone(request['expires_at'])
        self.assertNotIn('source_run_id', request); self.assertNotIn('no_expiry', request)
        self.assertEqual(self.request(*args, '--expires-at', '2026-10-03T00:00:00Z')['expires_at'], '2026-10-03T00:00:00Z')

    def test_revoke_and_history_use_statement_commands(self):
        request = self.request('revoke', 'pip_subject', 'memory_subject', '--expected-revision', '0', '--reason', 'Review')
        self.assertEqual(request['type'], 'revoke_pip_statement'); self.assertEqual(request['expected_revision'], 0)
        request = self.request('list', 'pip_subject', '--before-id', '7', '--limit', '2')
        self.assertEqual((request['type'], request['before_id'], request['limit']), ('list_pip_statements', 7, 2))


if __name__ == '__main__': unittest.main()
