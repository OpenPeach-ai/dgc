"""A Personal Pip has the user's DGC skills that fit everyday work: their own, plugin skills, and
deep-research, dataviz and plan among the built-ins. It loads one with the skill tool. Skills the
user turned off stay off, project Pips get none, and a skill never grants a tool."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat, pips
from tests import test_pips_local as fixtures

TRIP = "---\nname: trip-planner\ndescription: Plan a trip day by day with travel times and costs.\n---\nList each day's plan with times.\n"


class PipSkillTests(unittest.TestCase):
    setUp_base = fixtures.LocalPipsTests.setUp

    def setUp(self):
        self.setUp_base()
        mine = Path(tempfile.mkdtemp(dir=self.base))
        (mine / "trip-planner").mkdir()
        (mine / "trip-planner" / "SKILL.md").write_text(TRIP)
        p = patch("dgc.skills.USER_SKILLS", mine)
        p.start(); self.addCleanup(p.stop)

    def test_the_skills_that_fit_everyday_work_and_none_the_user_turned_off(self):
        names = set(pips.personal_skills(self.cfg))
        self.assertTrue({"deep-research", "dataviz", "plan", "trip-planner"} <= names)
        self.assertFalse({"code-review", "fix-ci", "ship", "write-tests", "refactor"} & names, "code work stays with projects")
        self.cfg.data["disabled_skills"] = ["trip-planner", "dataviz"]
        self.assertFalse({"trip-planner", "dataviz"} & set(pips.personal_skills(self.cfg)))

    def run_chat(self, pip, answers, personal=True):
        from dgc.llm import LLMClient, ChatResult, ToolCall
        run = pip_chat.send(self.store, pip["id"], "Plan my Goa weekend", "k-" + pip["id"][-6:], "user", self.cfg)["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append((json.dumps(messages), [t["function"]["name"] for t in tools or []]))
            step = answers[min(len(seen) - 1, len(answers) - 1)]
            return ChatResult(tool_calls=[ToolCall("s1", "skill", step)]) if isinstance(step, dict) else ChatResult(content=step)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=personal))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        return seen

    def test_a_personal_pip_lists_its_skills_and_loads_one_with_the_skill_tool(self):
        pip = self.store.create(self.registry.personal()["id"], "Travel", None, "editor-user", pip_type="scout")
        seen = self.run_chat(pip, [{"name": "trip-planner", "args": "Goa"}, "Day 1: beach."])
        first, tools = seen[0]
        self.assertIn("skill", tools)
        self.assertIn("trip-planner: Plan a trip day by day", first)
        self.assertIn("deep-research:", first)
        self.assertNotIn("code-review:", first)
        self.assertIn("never gives you new tools", first)
        self.assertIn("List each day's plan with times.", seen[1][0], "the skill's instructions came back to the model")

    def test_a_turned_off_skill_cannot_be_loaded_and_a_project_pip_has_none(self):
        self.cfg.data["disabled_skills"] = ["trip-planner"]
        pip = self.store.create(self.registry.personal()["id"], "Travel", None, "editor-user", pip_type="scout")
        seen = self.run_chat(pip, [{"name": "trip-planner"}, "Fine."])
        self.assertNotIn("trip-planner", seen[0][0])
        self.assertIn("unknown skill", seen[1][0])
        self.assertNotIn("List each day's plan", seen[1][0])
        reviewer = self.store.create(self.workspace["id"], "Reviewer", "Review the code", "editor-user", pip_type="rook")
        with patch.object(pips, "source_revision", return_value="a" * 40):
            project = self.run_chat(reviewer, ["Fine."], personal=False)
        self.assertNotIn("skill", project[0][1], "project Pips keep no skills")
        self.assertNotIn("Your skills", project[0][0])


if __name__ == "__main__":
    unittest.main()
