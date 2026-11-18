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


class ItsScheduledRunsHaveWhatItsChatHas(FolderPipChat, unittest.TestCase):
    """His call, 18 Nov: a folder Pip's scheduled runs (its audit, its draft) get everything its chat has: its box, its
    apps and plugins, the Library, images and videos. A handoff's run and a reviewed execution keep their own tools."""

    def handed_run(self):
        self.reviewer = self.store.create(self.workspace["id"], "Shop reviewer", "Review the shop", "editor-user",
                                          pip_type="scout")
        with patch.object(pips, "folder_boxes", return_value=True):
            run = self.control("run_pip", pip_id=self.reviewer["id"], idempotency_key="sched-1")["run"]
        row = self.store.claim_next()
        self.assertEqual(row["id"], run["id"])
        self.assertEqual(json.loads(row["manifest"])["run_kind"] if isinstance(row["manifest"], str)
                         else row["manifest"]["run_kind"], "audit")
        given = {}

        class Handed(Exception):
            pass

        def payload(value):
            given.update(value)
            raise Handed()
        with patch.object(pips, "folder_boxes", return_value=True), patch.object(pips, "_worker_payload", side_effect=payload):
            try:
                pips._execute_run(self.registry, row, self.cfg)
            except Handed:
                pass
        return given.get("manifest") or {}

    def test_its_audit_gets_its_box_and_its_apps(self):
        manifest = self.handed_run()
        self.assertEqual(set(manifest["computer_socket"]) - {"desktop"}, {"socket", "token"})
        self.assertIn("app_socket", manifest)

    def test_its_worker_offers_images_videos_and_the_library_in_an_audit(self):
        manifest = self.handed_run()
        manifest["computer_socket"] = {"socket": str(self.base / "absent.sock"), "token": "t" * 32}
        manifest["app_socket"] = {**manifest["app_socket"], "socket": str(self.base / "absent-apps.sock")}
        seen = {}

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen["tools"] = {t["function"]["name"] for t in tools}
            return ChatResult(content='{"findings": [], "summary": "Nothing to report."}')
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            try:
                pips.execute_native(self.cfg, self.root, manifest, lambda event: None)
            except Exception:                   # noqa: BLE001 - the tools it was offered are what this checks
                pass
        for tool in ("generate_image", "generate_video", "computer", "read_file"):
            self.assertIn(tool, seen.get("tools", set()))


if __name__ == "__main__":
    unittest.main()
