"""The Pip prompt box's context meter: how much of the window its chat takes in the next reply."""
import unittest
from unittest.mock import patch

from dgc import pip_chat, pips
from dgc.pip_chat_options import context_estimate
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class ChatContextTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def chat(self, pip, words, key):
        run = pip_chat.send(self.store, pip["id"], words, key, "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Noted: " + words})

    def test_the_meter_counts_what_the_next_reply_carries(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        empty = context_estimate(self.store, pip["id"], self.cfg)
        self.assertEqual((empty["used_tokens"], empty["recent_messages"]), (0, 0))
        self.chat(pip, "Plan a 5k run every Tuesday. " * 40, "first")
        one = context_estimate(self.store, pip["id"], self.cfg)
        self.assertEqual(one["recent_messages"], 2)
        self.assertGreater(one["used_tokens"], 500, "about four bytes a token of what it sends")
        self.assertEqual(one["context_size"], empty["context_size"])
        small = context_estimate(self.store, pip["id"], self.cfg, 2048)
        self.assertEqual(small["context_size"], 2048)
        for bad in (100, 2_000_000, "32768", True):
            with self.subTest(size=bad), self.assertRaises(RegistryError):
                context_estimate(self.store, pip["id"], self.cfg, bad)

    def test_only_on_this_computer_and_only_for_personal_pips(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")
        def control(actor="editor-user", **fields):
            with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
                return pips.handle_control(self.cfg, {"type": "get_pip_chat_context", "request_id": "r", **fields},
                                           actor, start_worker=False)
        ok = control(pip_id=pip["id"])
        self.assertTrue(ok["ok"], ok)
        self.assertEqual(ok["result"]["used_tokens"], 0)
        self.assertFalse(control(actor="device_1", pip_id=pip["id"])["ok"])


if __name__ == "__main__":
    unittest.main()
