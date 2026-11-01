"""Unread Pip replies and scheduled results use independent, observed cursors."""
import unittest

from dgc import pip_unread, pips
from dgc.workspace_registry import RegistryError
from dgc.workspace_registry import WorkspaceRegistry
from tests.test_pip_run_posts import PostScene


class PipUnreadTests(PostScene):
    def test_upgrade_starts_existing_posts_read_then_counts_new_arrivals(self):
        self.ran(findings=[])
        db = self.registry.db
        db.execute('DROP TABLE pip_read_state')
        db.execute('PRAGMA user_version=47')
        db.commit()
        self.registry.close()
        self.registry = WorkspaceRegistry(clock=lambda: self.now)
        self.addCleanup(self.registry.close)
        self.store = pips.PipStore(self.registry)
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 0)
        self.ran(findings=[])
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 1)

    def test_clean_routine_post_is_unread_until_its_chat_is_opened(self):
        run = self.ran(findings=[])
        page = pip_unread.list_unread(self.store, self.pip['workspace_id'])
        self.assertEqual((page['total'], page['pips'][0]['posts']), (1, 1))
        self.assertEqual(page['pips'][0]['latest_post_id'], run)
        self.assertIn('finished', page['pips'][0]['latest'])
        self.assertEqual(pip_unread.mark_read(self.store, self.pip['id'], post_id=run)['count'], 0)
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 0)

    def test_marking_an_observed_post_does_not_swallow_a_new_arrival(self):
        first = self.ran(findings=[])
        second = self.ran(findings=[])
        self.assertEqual({p['run_id'] for p in self.page()['posts']}, {first, second})
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['pips'][0]['latest_post_id'], second)
        pip_unread.mark_read(self.store, self.pip['id'], post_id=first)
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 1)
        pip_unread.mark_read(self.store, self.pip['id'], post_id=second)
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 0)

    def test_foreign_cursor_is_refused_and_does_not_advance(self):
        self.ran(findings=[])
        with self.assertRaises(RegistryError):
            pip_unread.mark_read(self.store, self.pip['id'], post_id='run_'+'f'*32)
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 1)


if __name__ == '__main__':
    unittest.main()
