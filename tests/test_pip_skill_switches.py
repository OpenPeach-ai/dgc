"""pips-12: a switch per skill on each Pip. Every skill a Personal Pip may use (the user's own, plugin skills and the
everyday built-ins) is on until switched off on that Pip's page; a skill switched off is never offered to that Pip's
model, and other Pips keep it. Only the user, on this computer."""
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from dgc import pip_skill_switches as switches, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures

SKILLS = {"deep-research": SimpleNamespace(name="deep-research", description="Research a question deeply.", source="builtin", enabled=True),
          "budget": SimpleNamespace(name="budget", description="Keep my budget.", source="user", enabled=True)}


class SkillSwitchTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def control(self, command, actor="editor-user", **fields):
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)), \
                patch.object(pips, "personal_skills", return_value=SKILLS):
            return pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)

    def test_every_skill_on_until_switched_off_on_one_pip(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Plans", "local-console")
        other = self.store.create(self.registry.personal()["id"], "Bo", "Plans", "local-console")
        listed = self.control("get_pip_skills", pip_id=pip["id"])
        self.assertTrue(listed["ok"], listed)
        self.assertEqual({s["name"]: s["on"] for s in listed["result"]["skills"]}, {"deep-research": True, "budget": True})
        self.assertTrue(self.control("set_pip_skill", pip_id=pip["id"], skill="budget", on=False)["ok"])
        self.assertEqual(switches.off(self.registry, pip["id"]), {"budget"})
        self.assertEqual(switches.off(self.registry, other["id"]), set(), "only that Pip")
        self.assertEqual(sorted(switches.offered(SKILLS, {"skills_off": ["budget"]})), ["deep-research"],
                         "a skill switched off is never offered to its model")
        self.assertEqual(sorted(switches.offered(SKILLS, {})), ["budget", "deep-research"])
        self.assertTrue(self.control("set_pip_skill", pip_id=pip["id"], skill="budget", on=True)["ok"])
        self.assertEqual(switches.off(self.registry, pip["id"]), set())

    def test_the_run_carries_its_switched_off_skills(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Plans", "local-console")
        switches.set_skill(self.registry, pip["id"], "budget", False, "editor-user")
        manifest = switches.runtime(self.registry, {"pip_id": pip["id"]}, {"run_kind": "conversation"})
        self.assertEqual(manifest["skills_off"], ["budget"])
        self.assertNotIn("skills_off", switches.runtime(self.registry, {"pip_id": pip["id"]}, {"run_kind": "conversation", "handoff": {}}))
        with self.assertRaises(RegistryError):
            switches.offered(SKILLS, {"skills_off": "budget"})

    def test_only_the_user_on_this_computer(self):
        pip = self.store.create(self.registry.personal()["id"], "Ava", "Plans", "local-console")
        self.assertFalse(self.control("set_pip_skill", actor="device_1", pip_id=pip["id"], skill="budget", on=False)["ok"])
        for bad in ("", "Bad Skill!", None, "x" * 100):
            with self.subTest(skill=bad):
                self.assertFalse(self.control("set_pip_skill", pip_id=pip["id"], skill=bad, on=False)["ok"])


if __name__ == "__main__":
    unittest.main()
