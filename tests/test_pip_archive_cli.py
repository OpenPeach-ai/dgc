"""Archive CLI decisions carry exact lifecycle pins, never imply deletion/resume."""
import contextlib
import io
import unittest

from dgc import pip_cli


class ArchiveCLITests(unittest.TestCase):
    def request(self, action, *flags):
        return pip_cli._request(pip_cli.parser().parse_args([action, 'pip_a', *flags]))

    def test_archive_and_restore_have_distinct_commands_and_exact_pins(self):
        for action in ('archive', 'restore'):
            result = self.request(action, '--expected-version', '3',
                '--expected-lifecycle-revision', '7', '--request-key', 'review-once',
                '--reason', 'Finished this responsibility')
            result.pop('request_id')
            self.assertEqual(result, {'type': action + '_pip', 'pip_id': 'pip_a',
                'expected_version': 3, 'expected_lifecycle_revision': 7,
                'request_key': 'review-once', 'reason': 'Finished this responsibility'})

    def test_missing_review_fields_refuse_instead_of_choosing_current_values(self):
        flags = ['--expected-version', '3', '--expected-lifecycle-revision', '7',
                 '--request-key', 'review-once', '--reason', 'Reviewed']
        for action in ('archive', 'restore'):
            for index in range(0, len(flags), 2):
                with self.subTest(action=action, missing=flags[index]), \
                        contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                    self.request(action, *(flags[:index] + flags[index + 2:]))

    def test_receipt_labels_historical_retry_and_current_state(self):
        result = {'pip': {'id': 'pip_a', 'status': 'paused', 'current_version': 3,
                          'lifecycle_revision': 9},
                  'receipt': {'operation': 'archive', 'status_after': 'archived',
                              'lifecycle_revision_after': 8}, 'replayed': True}
        text = pip_cli._format(result)
        self.assertIn('Original decision', text)
        self.assertIn('Current state: paused', text)
        self.assertIn('History is retained', text)
        self.assertIn('separate resume', text)

    def test_pause_resume_accept_explicit_lifecycle_pin(self):
        for action in ('pause', 'resume-job'):
            value = self.request(action, '--expected-lifecycle-revision', '9')
            self.assertEqual(value['expected_lifecycle_revision'], 9)
            self.assertNotIn('expected_version', value)


if __name__ == '__main__': unittest.main()
