"""Session statement CLI preserves source selection and exact human review pins."""
import contextlib
import io
import unittest

from dgc import pip_cli


class SessionOutcomeCliTests(unittest.TestCase):
    def request(self, *args):
        return pip_cli._request(pip_cli.parser().parse_args(['session-outcome', *args]))

    def test_commit_and_pip_source_selections_are_closed_and_distinct(self):
        base = ['propose', 'session_1', '--title', 'Decision', '--statement', 'Keep the interface stable.',
                '--expected-session-revision', '7', '--request-key', 'review-1', '--workspace', 'ws_1']
        for flags, expected in ((['--source-commit', 'a' * 40], {'kind': 'commit', 'revision': 'a' * 40}),
                                (['--source-run', 'run_1'], {'kind': 'pip_run', 'run_id': 'run_1'})):
            request = self.request(*base, *flags)
            self.assertEqual(request['type'], 'propose_workspace_session_outcome')
            self.assertEqual(request['source'], expected)
            self.assertEqual(request['expected_session_revision'], 7)
            self.assertEqual(request['request_key'], 'review-1')
            self.assertFalse({'session_path', 'transcript', 'verified', 'source_commit', 'source_run'} & request.keys())
        for flags in ([], ['--source-commit', 'a' * 40, '--source-run', 'run_1'], ['--session-path', '/outside']):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                self.request(*base, *flags)

    def test_accept_requires_exact_digest_and_context_revision(self):
        args = ['accept', 'outcome_1', '--digest', 'a' * 64, '--expected-context-revision', '4']
        request = self.request(*args)
        self.assertEqual(request['type'], 'accept_workspace_session_outcome')
        self.assertEqual(request['expected_digest'], 'a' * 64)
        self.assertEqual(request['expected_context_revision'], 4)
        for bad in (['accept', 'outcome_1'], ['accept', 'outcome_1', '--digest', 'a' * 64]):
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit): self.request(*bad)

    def test_reads_and_rejection_never_turn_into_acceptance(self):
        inspected = self.request('inspect', 'session_1')
        self.assertEqual((inspected['type'], inspected['session_id']), ('inspect_workspace_session_outcome', 'session_1'))
        self.assertEqual(self.request('review', 'outcome_1')['type'], 'get_workspace_session_outcome')
        page = self.request('list', '--before-id', '9', '--limit', '10')
        self.assertEqual((page['type'], page['before_id'], page['limit']), ('list_workspace_session_outcomes', 9, 10))
        rejected = self.request('reject', 'outcome_1', '--digest', 'b' * 64)
        self.assertEqual(rejected['type'], 'reject_workspace_session_outcome')
        self.assertNotIn('expected_context_revision', rejected)

    def test_rendered_statement_never_looks_like_an_execution_receipt(self):
        proposal = {'id': 'outcome_1', 'workspace_id': 'ws_1', 'classification': 'user_reviewed_statement',
            'title': 'Decision', 'statement': 'Keep the interface stable.', 'status': 'proposed',
            'source_reference': {'relation': 'selected_for_statement'}, 'digest': 'c' * 64,
            'session': {'id': 'session_1', 'revision': 7}}
        text = pip_cli._format({'proposal': proposal})
        self.assertIn('not a verified execution result', text)
        self.assertIn('does not attest where a command ran', text)
        self.assertIn('--digest ' + 'c' * 64, text)
        self.assertIn('session-outcome reject', text)
        accepted = pip_cli._format({'proposal': {**proposal, 'status': 'accepted'}, 'replayed': True})
        self.assertNotIn('Accept:', accepted)
        self.assertIn('without adding another context record', accepted)


if __name__ == '__main__':
    unittest.main()
