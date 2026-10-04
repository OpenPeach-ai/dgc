"""Offline CLI notification request routing and honest acknowledgement copy."""
import unittest
from dgc import pip_cli


class NotificationCLITests(unittest.TestCase):
    def request(self, *args):
        return pip_cli._request(pip_cli.parser().parse_args(['notifications', *args]))

    def test_listing_is_global_unless_explicitly_scoped_and_cursor_is_numeric(self):
        global_page = self.request('list')
        self.assertEqual(global_page['type'], 'list_pip_notifications')
        self.assertNotIn('workspace_id', global_page)
        scoped = self.request('list', '--workspace', 'ws_one', '--before-seq', '12', '--limit', '4')
        self.assertEqual((scoped['workspace_id'], scoped['before_seq'], scoped['limit']), ('ws_one', 12, 4))

    def test_read_is_not_accept_and_requires_saved_revision(self):
        request = self.request('read', 'notification_one', '--expected-revision', '0')
        self.assertEqual(request['type'], 'mark_pip_notification_read')
        self.assertEqual(request['expected_revision'], 0)
        self.assertNotIn('approval_id', request)
        self.assertNotIn('actor', request)

    def test_empty_scan_and_retention_limits_are_visible(self):
        text = pip_cli._format({'notifications': [], 'unread_count': 0, 'retained_count': 0,
            'next_before_seq': None, 'sync_pending': True, 'history_may_be_incomplete': True,
            'evicted_total': 2, 'unavailable_sources_total': 1})
        self.assertIn('More local events remain to scan', text)
        self.assertIn('2 evicted', text)
        self.assertIn('does not accept a review or start work', text)

    def test_repeated_read_reports_original_acknowledgement(self):
        text = pip_cli._format({'notification': {'title': 'Pip run failed',
            'read_by': 'editor-user', 'read_at': '2026-10-02T00:00:00.000Z'}, 'replayed': True})
        self.assertIn('original read receipt', text)
        self.assertIn('No review was accepted', text)


if __name__ == '__main__':
    unittest.main()
