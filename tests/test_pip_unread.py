"""Unread Pip replies and scheduled results use independent, observed cursors."""
import json
import unittest
from datetime import timedelta

from dgc import pip_chat, pip_routines, pip_unread, pips
from dgc.workspace_registry import RegistryError
from dgc.workspace_registry import WorkspaceRegistry
from tests import test_pip_chat as chat_fixtures
from tests import test_pips_local as fixtures
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

    def later(self, minutes):
        self.now = pip_routines.stamp(pip_routines._instant(self.now) + timedelta(minutes=minutes))

    def test_all_clear_runs_in_a_row_are_one_unread_message_as_the_chat_folds_them(self):
        # The chat folds runs that found nothing, one after another, into one message ("Nothing found 3 times since
        # 10:00", pipRunPosts.timeline); the next run that finds something says so in its own message.
        clear = []
        for _ in range(3):
            clear.append(self.ran(findings=[]))
            self.later(60)
        item = pip_unread.list_unread(self.store, self.pip['workspace_id'])['pips'][0]
        self.assertEqual((item['count'], item['posts'], item['messages']), (1, 1, 0))
        self.assertEqual(item['latest_post_id'], clear[-1])
        found = self.ran(findings=[{'title': 'Rounding drops paise', 'severity': 'high', 'path': 'app/billing.py',
                                    'line': 12, 'evidence': 'return total', 'verification': 'source_excerpt_only'}])
        self.later(60)
        after = self.ran(findings=[])
        item = pip_unread.list_unread(self.store, self.pip['workspace_id'])['pips'][0]
        self.assertEqual((item['count'], item['posts']), (3, 3), 'the fold, the finding, then a new fold')
        self.assertEqual(item['latest_post_id'], after)
        self.assertEqual(pip_unread.mark_read(self.store, self.pip['id'], post_id=clear[1])['posts'], 3,
                         'the fold still has a run after the cursor')
        self.assertEqual(pip_unread.mark_read(self.store, self.pip['id'], post_id=found)['posts'], 1)
        self.assertEqual(pip_unread.mark_read(self.store, self.pip['id'], post_id=after)['count'], 0)
        self.later(60)
        self.ran(findings=[])
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 1,
                         'a pass after the fold was read brings it back once')


class ChatItemTests(unittest.TestCase):
    """Reported 3 Nov: a Gmail Pip's home row said "51 unread", every Pip reply after the cursor, for a chat that
    shows far fewer items. The chat hides the turns DGC writes (a routine's turn, the one after an Allow) and draws a
    routine's run as one item: the count is the items with a reply after the cursor. Real registry, real routine
    ticks, the real continuation after an Allow (pip_chat.continue_after_plugin_action)."""
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        self.cfg.data['pips_enabled'] = True
        self.pip = self.store.create(self.registry.personal()['id'], 'Gmail', None, 'editor-user', pip_type='quill')
        self.routine = None

    def later(self, minutes):
        moved = pip_routines._instant(self.registry.clock()) + timedelta(minutes=minutes)
        self.registry.clock = lambda: pip_routines.stamp(moved)

    def reply(self, text):
        run = self.store.claim_next()
        self.store.finish(run['id'], result={'text': text})

    def ask(self, text, key, answer):
        pip_chat.send(self.store, self.pip['id'], text, key, 'editor-user', self.cfg)
        self.reply(answer)

    def routine_runs(self, answer):
        if self.routine is None:
            self.routine = pip_routines.add(self.store, self.pip['id'], 'Inbox sweep', 'File my bills.',
                                            {'kind': 'schedule', 'schedule': {'type': 'interval', 'minutes': 60}})
        self.later(61)
        self.assertEqual(pip_routines.tick(self.registry, self.cfg), {self.routine['id']: 'ran'})
        self.reply(answer)

    def allowed(self, action, answer):
        """The user pressed Allow on the card under the last reply: DGC's turn, then the Pip's reply."""
        pip_chat.continue_after_plugin_action(self.store, self.pip['id'], action, 'Gmail', 'GMAIL_ADD_LABEL', self.cfg,
                                              confirmed=True, answered=True)
        self.reply(answer)

    def chat(self):
        return pip_chat.list_messages(self.store, self.pip['id'], limit=50)['messages']

    def unread(self):
        page = pip_unread.list_unread(self.store, self.pip['workspace_id'])
        return page['pips'][0] if page['pips'] else {'count': 0, 'total': page['total']}

    def test_a_routine_run_and_the_reply_after_its_allow_are_one_unread_item(self):
        self.ask('What came in today?', 'chat-1', 'Two emails from your bank.')
        self.routine_runs('A bill from the power company is due Friday. Shall I file it?')
        self.allowed('act1', 'Filed it under Bills.')
        self.routine_runs('Another bill came in. Shall I file it too?')
        self.allowed('act2', 'Filed that one too.')
        self.routine_runs('Nothing new in your inbox.')
        chat = self.chat()
        replies = [m for m in chat if m['role'] == 'assistant']
        self.assertEqual(len(replies), 6, 'six replies are kept')
        self.assertEqual(sum(1 for m in chat if m.get('intro')), 5, "DGC's own turns, which the chat hides")
        self.assertEqual(sum(1 for m in chat if m['role'] == 'user' and not m.get('intro')), 1)
        item = self.unread()
        self.assertEqual((item['count'], item['messages'], item['posts']), (4, 4, 0),
                         'your question, then three routine runs, each once')
        self.assertEqual((item['latest_message_id'], item['latest']), (replies[-1]['id'], 'Nothing new in your inbox.'))
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id'])['total'], 4)
        read = pip_unread.mark_read(self.store, self.pip['id'], message_id=item['latest_message_id'])
        self.assertEqual((read['count'], read['messages'], read['latest']), (0, 0, ''))
        self.assertEqual(pip_unread.list_unread(self.store, self.pip['workspace_id']), {
            'workspace_id': self.pip['workspace_id'], 'pips': [], 'total': 0})

    def test_the_preview_is_the_newest_reply_and_reading_part_of_an_item_leaves_it_unread(self):
        self.ask('What came in today?', 'chat-1', 'Two emails from your bank.')
        self.routine_runs('A bill is due Friday. Shall I file it?')
        self.allowed('act1', 'Filed it under Bills.')
        replies = [m for m in self.chat() if m['role'] == 'assistant']
        item = self.unread()
        self.assertEqual(item['count'], 2)
        self.assertEqual((item['latest_message_id'], item['latest']), (replies[-1]['id'], 'Filed it under Bills.'),
                         "the newest item's newest words, and an id the chat has")
        # Read up to the routine's own reply: the reply after its Allow is still new, in the same item.
        self.assertEqual(pip_unread.mark_read(self.store, self.pip['id'], message_id=replies[1]['id'])['count'], 1)
        self.assertEqual(pip_unread.mark_read(self.store, self.pip['id'], message_id=replies[2]['id'])['count'], 0)
        self.routine_runs('Nothing new in your inbox.')
        item = self.unread()
        self.assertEqual((item['count'], item['latest']), (1, 'Nothing new in your inbox.'))
        self.assertEqual(pip_unread.mark_read(self.store, self.pip['id'], message_id=item['latest_message_id'])['count'], 0)

    def test_the_preview_leaves_out_the_line_between_short_messages(self):
        self.ask('Hi', 'chat-1', 'Hi there!\n---\nYour inbox has 3 new emails.')
        self.assertEqual(self.unread()['latest'], 'Hi there! Your inbox has 3 new emails.')

    def test_the_reply_after_an_allow_on_your_own_request_is_part_of_that_request(self):
        self.ask('Send Priya the invoice', 'chat-1', 'I drafted it. Allow me to send it?')
        self.allowed('act1', 'Sent it to Priya.')
        item = self.unread()
        self.assertEqual((item['count'], item['latest']), (1, 'Sent it to Priya.'))
        self.ask('Thanks. Anything else?', 'chat-2', 'Nothing else today.')
        self.assertEqual(self.unread()['count'], 2)
        # An Allow after you read it all: the reply comes back as one new item, never more.
        pip_unread.mark_read(self.store, self.pip['id'], message_id=self.unread()['latest_message_id'])
        self.allowed('act2', 'Filed the receipt as well.')
        self.assertEqual((self.unread()['count'], self.unread()['latest']), (1, 'Filed the receipt as well.'))


class FoldBrokenByAMessageTests(unittest.TestCase):
    """A message between two all-clear runs keeps them two messages in the chat, so they count twice."""
    setUp = chat_fixtures.PipChatTests.setUp
    git = chat_fixtures.PipChatTests.git
    commit = chat_fixtures.PipChatTests.commit
    create = chat_fixtures.PipChatTests.create
    setup_job = chat_fixtures.PipChatTests.setup_job
    later = ChatItemTests.later

    def audit(self, key):
        run = self.store.enqueue(self.job['id'], key, 'pip-schedule', self.cfg)
        self.assertEqual(self.store.claim_next()['id'], run['id'])
        report = pips.validate_report(json.dumps({'summary': 'Source inspection', 'limitations': ['Tests were not run.'],
                                                  'findings': []}), self.root, read_calls=1)
        self.store.finish(run['id'], result=report)
        return run['id']

    def unread(self):
        return pip_unread.list_unread(self.store, self.job['workspace_id'])['pips'][0]

    def test_a_message_between_two_all_clear_runs_keeps_them_apart(self):
        self.setup_job()
        self.audit('audit-1')
        self.later(10)
        self.audit('audit-2')
        self.assertEqual((self.unread()['posts'], self.unread()['messages']), (1, 0), 'two passes in a row: one message')
        self.later(10)
        sent = pip_chat.send(self.store, self.job['id'], 'Is source.py safe?', 'chat-1', 'device_1', self.cfg)
        self.assertEqual(self.store.claim_next()['id'], sent['run']['id'])
        self.store.finish(sent['run']['id'], result={'text': 'It looks fine.'})
        self.later(10)
        last = self.audit('audit-3')
        item = self.unread()
        self.assertEqual((item['count'], item['posts'], item['messages']), (3, 2, 1))
        self.assertEqual(item['latest_post_id'], last)
        read = pip_unread.mark_read(self.store, self.job['id'], message_id=item['latest_message_id'], post_id=last)
        self.assertEqual(read['count'], 0)


if __name__ == '__main__':
    unittest.main()
