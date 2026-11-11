"""A card's follow-up goes to the conversation the card came from (0.52, found in the live check of 11 Nov).

Several conversations per Pip (pips-17) came after the cards: a key saved, a plugin allowed, a borrow answered, a
held computer step decided. Each starts the Pip's next turn, and every one of them went to the Pip's FIRST
conversation, wherever the card was. Now each goes to the conversation of the run that raised it (the first when that
one is archived), a turn kept for later (the chat was busy) remembers it, and a card asked a second time (a key the
site turned away, then saved again) starts a turn again instead of being taken for the first answer."""
from __future__ import annotations

import json
import unittest
from unittest import mock

from dgc import pip_chat, pip_conversations, pip_keys, pips, plugin_credentials
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests.test_pip_levels import Store

HOST = "api.invoicely.example"


class CardFollowUps(Store):
    def setUp(self):
        super().setUp()
        plugin_credentials.configure("file")
        self.addCleanup(plugin_credentials.configure, "auto")
        self.pip = self.personal()
        self.second = pip_conversations.create(self.registry, self.pip["id"], "Invoices")["id"]

    def finished(self, run_id):
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pip_runs SET status='failed' WHERE id=?", (run_id,))

    def ask_in_second(self):
        sent = pip_chat.send(self.store, self.pip["id"], "Read my unpaid invoices", "m1", "editor-user", self.cfg,
                             conversation_id=self.second)
        run = sent["run"]["id"]
        pip_keys.request(self.registry, self.cfg, self.pip["id"], self.pip["workspace_id"], run,
                         {"name": "Invoicely API key", "why": "Read invoices", "host": HOST})
        self.finished(run)
        return [k for k in pip_keys.listing(self.registry, self.pip["id"])["keys"] if k["host"] == HOST][0]

    def follow_ups(self):
        rows = self.registry.db.execute("SELECT request_key, conversation_id FROM pip_chat_messages WHERE role='user' "
                                        "AND request_key LIKE 'keys_%' ORDER BY seq").fetchall()
        return [(r[0], r[1]) for r in rows]

    def test_a_saved_key_carries_on_in_the_conversation_its_card_came_from(self):
        card = self.ask_in_second()
        self.control("save_pip_key", pip_id=self.pip["id"], key_id=card["id"], value="inv_live_0123456789abcdef")
        follow = self.follow_ups()
        self.assertEqual(len(follow), 1)
        self.assertEqual(follow[0][1], self.second, "not the Pip's first conversation")

    def test_a_card_asked_again_carries_on_again(self):
        card = self.ask_in_second()
        self.control("save_pip_key", pip_id=self.pip["id"], key_id=card["id"], value="inv_live_0123456789abcdef")
        run = self.follow_ups()[0]
        # The site turned the key away: the card is back, the user saves a new one.
        for row in self.registry.db.execute("SELECT id FROM pip_runs WHERE status IN ('queued','running')").fetchall():
            self.finished(row[0])
        pip_keys._refused(self.registry, pip_keys._get(self.registry, card["id"], self.pip["id"]), 401)
        self.control("save_pip_key", pip_id=self.pip["id"], key_id=card["id"], value="inv_live_fedcba9876543210")
        follow = self.follow_ups()
        self.assertEqual(len(follow), 2, "the second answer starts a turn too, not taken for the first")
        self.assertNotEqual(follow[0][0], follow[1][0])
        self.assertEqual(follow[1][1], self.second)

    def test_a_turn_kept_for_later_remembers_its_conversation(self):
        card = self.ask_in_second()
        busy = pip_chat.send(self.store, self.pip["id"], "Something else", "m2", "editor-user", self.cfg,
                             conversation_id=self.second)            # the conversation is busy now
        self.control("save_pip_key", pip_id=self.pip["id"], key_id=card["id"], value="inv_live_0123456789abcdef")
        self.assertEqual(self.follow_ups(), [], "kept for later")
        self.finished(busy["run"]["id"])
        self.assertEqual(pip_chat.send_owed_turns(self.registry, self.cfg), 1)
        self.assertEqual(self.follow_ups()[0][1], self.second)

    def test_an_archived_conversation_falls_back_to_the_first(self):
        card = self.ask_in_second()
        pip_conversations.archive(self.registry, self.pip["id"], self.second, True)
        self.control("save_pip_key", pip_id=self.pip["id"], key_id=card["id"], value="inv_live_0123456789abcdef")
        follow = self.follow_ups()
        self.assertEqual(len(follow), 1)
        self.assertNotEqual(follow[0][1], self.second)


if __name__ == "__main__":
    unittest.main()
