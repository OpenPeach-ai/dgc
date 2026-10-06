"""Pips start like people you meet: pick a character, name it, and it says hello.

A Personal Pip can be created with just a name (its chat sets it up), Core can be your Primary
Pip, and a new Pip's first message comes from a hidden turn DGC sends once, which the editor
does not show as yours.
"""
import unittest
from unittest.mock import patch

from dgc import pip_chat, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class SimpleStartTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def personal_id(self):
        return self.registry.personal()["id"]

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_a_personal_pip_needs_only_a_name(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        self.assertEqual(pip["name"], "Gmail")
        self.assertEqual(pip["goal"], pips.NAMED_GOAL)
        blank = self.store.create(self.personal_id(), "Travel", "   ", "editor-user", pip_type="scout")
        self.assertEqual(blank["goal"], pips.NAMED_GOAL)

    def test_a_project_pip_still_says_what_it_reviews(self):
        with self.assertRaises(RegistryError):
            self.store.create(self.workspace["id"], "Reviewer", None, "editor-user", pip_type="rook")

    def test_core_is_your_primary_pip_and_only_a_personal_one(self):
        core = self.store.create(self.personal_id(), "Core", None, "editor-user", pip_type="core")
        self.assertEqual((core["pip_type"], core["goal"]), ("core", pips.PRIMARY_GOAL))
        with self.assertRaises(RegistryError) as refused:
            self.store.create(self.workspace["id"], "Core", "Review the code", "editor-user", pip_type="core")
        self.assertIn("Primary Pip", str(refused.exception))
        catalog = {t["id"]: t for t in __import__("dgc.pip_types", fromlist=["catalog"]).catalog()}
        self.assertFalse(catalog["core"]["available"], "project pickers still never offer Core")

    def test_a_new_pip_says_hello_first_from_one_hidden_turn(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        first = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertTrue(first["ok"], first.get("error"))
        again = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertEqual(again["result"]["run"]["id"], first["result"]["run"]["id"], "once per Pip")
        text = first["result"]["message"]["text"]
        self.assertIn('named you "Gmail"', text)
        self.assertIn("not the user", text)
        page = pip_chat.list_messages(self.store, pip["id"])
        [shown] = page["messages"]
        self.assertTrue(shown["intro"], "the editor shows no bubble for it")
        self.assertEqual(first["result"]["run"]["manifest"]["kind"] if "kind" in first["result"]["run"]["manifest"]
                         else first["result"]["run"]["manifest"]["run_kind"], "conversation")

    def test_core_introduces_itself_as_the_primary_pip(self):
        core = self.store.create(self.personal_id(), "Core", None, "editor-user", pip_type="core")
        result = self.control({"type": "introduce_pip", "pip_id": core["id"]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertIn("Primary Pip", result["result"]["message"]["text"])

    def test_your_own_message_can_never_pass_as_an_introduction(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        refused = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "hi",
                                "idempotency_key": "intro_" + pip["id"][4:]})
        self.assertFalse(refused["ok"])
        self.assertIn("reserved", refused["error"]["message"])
        ordinary = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "hi", "idempotency_key": "k1"})
        self.assertTrue(ordinary["ok"], ordinary.get("error"))
        self.assertNotIn("intro", pip_chat.list_messages(self.store, pip["id"])["messages"][-1])

    def test_a_project_pip_does_not_introduce_itself(self):
        pip = self.store.create(self.workspace["id"], "Reviewer", "Review the code", "editor-user", pip_type="rook")
        result = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertFalse(result["ok"])

    def test_only_the_local_user_asks(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        result = self.control({"type": "introduce_pip", "pip_id": pip["id"]}, actor="device_" + "1" * 32)
        self.assertFalse(result["ok"])


if __name__ == "__main__":
    unittest.main()
