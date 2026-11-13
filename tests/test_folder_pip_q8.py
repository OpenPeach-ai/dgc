"""Q8 (pips-flow-design, 14 Nov): a Pip with a folder gets what a Personal Pip has.

"Routines, goals, skills, its own working notes, and what you told this Pip: every Pip, no setting. What DGC remembers
about you: every Pip, on by default, with one switch on the Pip's page: Knows about you. Settings → Memory's main
switch still turns it off for everything." A folder line must not take something away.

The real runner handing the manifest, the real worker with its model stood in, the real control seam.
"""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from tests.test_folder_pip_wall import WithABox  # noqa: E402
from dgc import pip_chat, pip_notes, pip_routines, pip_working_notes, pips  # noqa: E402
from dgc.llm import ChatResult, LLMClient  # noqa: E402


class FolderPipChat(WithABox):
    def remembered(self, text="I like small diffs."):
        from dgc.shared_memory import SharedMemory
        SharedMemory().add(text)

    def handed(self):
        from tests.test_folder_pip_box import TheRunnerOpensIt
        return TheRunnerOpensIt.handed(self)


class ItsChatGetsWhatAPersonalPipHas(FolderPipChat, unittest.TestCase):
    def test_its_chat_turn_carries_its_notes_what_you_are_like_and_its_working_notes(self):
        pip_notes.add(self.registry, self.cfg, self.helper["id"], "The shop's owner is Sam.", "editor-user")
        self.remembered()
        manifest = self.handed()
        self.assertIn("The shop's owner is Sam.", json.dumps(manifest["pip_notes"]))
        self.assertIn("I like small diffs.", json.dumps(manifest["about_you"]))
        self.assertIn("working_notes", manifest)
        self.assertIn("user_turn", manifest, "whether this is the user's own turn (only then may it keep a note)")

    def test_knows_about_you_is_on_by_default_and_its_switch_turns_it_off(self):
        self.remembered()
        pip = self.control("get_pip", pip_id=self.helper["id"])["pip"]
        self.assertIs(pip["knows_you"], True)
        answer = self.control("set_pip_knows_you", pip_id=self.helper["id"], on=False)
        self.assertIs(answer["knows_you"], False)
        self.assertNotIn("about_you", self.handed())

    def test_the_main_memory_switch_still_turns_it_off_for_everything(self):
        self.remembered()
        self.cfg.data["memory"] = False
        self.assertNotIn("about_you", self.handed())

    def test_only_you_set_the_switch(self):
        from dgc.workspace_registry import RegistryError
        with self.assertRaises(RegistryError):
            self.control("set_pip_knows_you", actor="device_1", pip_id=self.helper["id"], on=False)


class ItsWorkerHasTheTools(FolderPipChat, unittest.TestCase):
    def turn(self):
        sent = pip_chat.send(self.store, self.helper["id"], "Remember that I deploy on Fridays", "q-1", "device_1", self.cfg)
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                       (sent["run"]["id"],)).fetchone()[0])
        manifest["computer_socket"] = {"socket": str(self.base / "absent.sock"), "token": "t" * 32}
        manifest["own_folder"] = {"name": "shop", "folder": "projects/shop", "files": 5, "kept": False, "updated": 5}
        manifest["user_turn"] = True
        manifest["pip_notes"] = []
        manifest["working_notes"] = []
        seen = {}

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen["tools"] = {t["function"]["name"] for t in tools}
            seen["system"] = messages[0]["content"]
            return ChatResult(content="Noted.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
        return seen

    def test_it_can_remember_keep_working_notes_and_set_up_routines(self):
        seen = self.turn()
        self.assertIn(pip_notes.TOOL, seen["tools"])
        self.assertIn(pip_working_notes.TOOL, seen["tools"])
        self.assertTrue(any(name.startswith(("add_routine", "routine", "suggest_routine")) or "routine" in name
                            for name in seen["tools"]), seen["tools"])
        self.assertIn("keep it with remember", seen["system"])


class RoutinesAndGoalsForEveryPip(FolderPipChat, unittest.TestCase):
    def test_a_folder_pip_can_have_a_routine(self):
        routine = self.control("add_pip_routine", pip_id=self.helper["id"], title="Morning check",
                               prompt="Check the shop's orders", trigger={"kind": "schedule", "schedule": {"type": "daily", "time": "08:00",
                                                                                  "timezone": "Asia/Kolkata"}})
        self.assertEqual(routine["routine"]["title"], "Morning check")


if __name__ == "__main__":
    unittest.main()
