"""One request registry per process, one owner-scoped view per chat.

The editor answers a card by its bare id, so ids must be unique across every chat in the process --
which is why the registry is shared. What a chat cancels, reads or answers must be only its own:
unscoped, a Stop in one chat expired every other chat's open approval cards, and their turns carried
on as if the user had said no.
"""
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dgc.protocol import PendingRequests  # noqa: E402

_CANCEL = {"decision": "no", "choice": None, "action": "cancel"}


class PendingOwnersTest(unittest.TestCase):
    def setUp(self):
        self.registry = PendingRequests()
        self.a, self.b = self.registry.view("chat-a"), self.registry.view("chat-b")

    def test_ids_are_unique_across_chats(self):
        ids = [view.register()[0] for view in (self.a, self.b, self.a, self.b)]
        self.assertEqual(len(set(ids)), 4)

    def test_stop_in_one_chat_leaves_the_others_cards_open(self):
        a_id, a_event = self.a.register()
        b_id, b_event = self.b.register()
        self.assertEqual(self.a.cancel_all(_CANCEL), [a_id])
        self.assertTrue(a_event.is_set())
        self.assertFalse(b_event.is_set(), "a Stop in chat A denied chat B's approval")
        self.assertTrue(self.b.is_open(b_id))

    def test_a_chat_cannot_answer_or_read_another_chats_card(self):
        a_id, a_event = self.a.register()
        self.assertFalse(self.b.resolve(a_id, {"decision": "once"}))
        self.assertFalse(a_event.is_set())
        self.assertFalse(self.b.is_open(a_id))
        self.assertIsNone(self.b.value(a_id))
        self.assertTrue(self.a.resolve(a_id, {"decision": "once"}))
        self.assertEqual(self.a.value(a_id), {"decision": "once"})

    def test_the_process_can_still_cancel_everything_at_shutdown(self):
        events = [view.register()[1] for view in (self.a, self.b)]
        self.assertEqual(len(self.registry.cancel_all(_CANCEL)), 2)
        self.assertTrue(all(event.is_set() for event in events))

    def test_an_unscoped_registry_behaves_as_before(self):
        rid, event = self.registry.register()
        threading.Thread(target=lambda: self.registry.resolve(rid, {"decision": "once"})).start()
        self.assertTrue(event.wait(2))
        self.assertEqual(self.registry.value(rid), {"decision": "once"})


if __name__ == "__main__":
    unittest.main()
