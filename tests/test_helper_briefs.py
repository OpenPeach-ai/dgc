"""work-helper-briefs (0.52, agreed 9 Nov): "Helpers get real jobs: a full brief, and work until done."

The task tool's brief has fields (goal, known, files, done_when, returns; goal, done_when and returns needed when any is
used), which become the helper's prompt as the call arrives, so the transcript, the replay and the run read one prompt.
A free-text prompt still works. The built-in helpers keep going until done_when holds and say what they checked. The
main model is told to hand a big independent job to a helper even alone.
"""
import json
import unittest
from types import SimpleNamespace

from dgc import agent as agent_mod, agents, subagents
from dgc.tools import TOOL_SCHEMAS


class Briefs(unittest.TestCase):
    def test_fields_become_the_helpers_prompt(self):
        item = {"description": "Audit the router", "goal": "Find every place a key could reach a log",
                "known": "redact_text already masks saved keys", "files": ["dgc/router.py", "dgc/router_probe.py"],
                "done_when": "every call site is checked", "returns": "a list of path:line with a verdict each"}
        subagents.compose_brief(item)
        self.assertEqual(item["prompt"].splitlines(), [
            "Goal: Find every place a key could reach a log",
            "Known or ruled out: redact_text already masks saved keys",
            "Files: dgc/router.py, dgc/router_probe.py",
            "Done when: every call site is checked",
            "Return: a list of path:line with a verdict each"])
        self.assertEqual(agent_mod._task_call_error(item), "")
        again = dict(item)
        subagents.compose_brief(again)
        self.assertEqual(again["prompt"], item["prompt"], "composing twice changes nothing")

    def test_a_free_text_prompt_still_works_and_rides_along_as_notes(self):
        plain = {"description": "x", "prompt": "Read README.md and summarize it."}
        subagents.compose_brief(plain)
        self.assertEqual(plain["prompt"], "Read README.md and summarize it.")
        both = {"description": "x", "prompt": "Use the cached copy.", "goal": "g", "done_when": "d", "returns": "r"}
        subagents.compose_brief(both)
        self.assertTrue(both["prompt"].endswith("Notes: Use the cached copy."))

    def test_a_half_brief_is_refused_in_words(self):
        half = {"description": "x", "goal": "find the bug"}
        subagents.compose_brief(half)
        self.assertNotIn("prompt", half)
        self.assertIn("done_when, returns", agent_mod._task_call_error(half))
        batch = {"tasks": [{"description": "a", "prompt": "p"}, {"description": "b", "goal": "g", "returns": "r"}]}
        self.assertIn("tasks[2]: a brief needs done_when", agent_mod._task_call_error(batch))
        bad_files = {"description": "x", "goal": "g", "done_when": "d", "returns": "r", "files": [3]}
        self.assertIn("files is a list", agent_mod._task_call_error(bad_files))

    def test_the_calls_are_composed_as_they_arrive(self):
        single = SimpleNamespace(name="task", arguments={"description": "a", "goal": "g", "done_when": "d", "returns": "r"})
        batch = SimpleNamespace(name="task", arguments={"tasks": [
            {"description": "b", "goal": "g2", "done_when": "d2", "returns": "r2"}, {"description": "c", "prompt": "plain"}]})
        other = SimpleNamespace(name="bash", arguments={"command": "ls", "goal": "x"})
        agent_mod._compose_task_briefs([single, batch, other])
        self.assertTrue(single.arguments["prompt"].startswith("Goal: g"))
        self.assertTrue(batch.arguments["tasks"][0]["prompt"].startswith("Goal: g2"))
        self.assertEqual(batch.arguments["tasks"][1]["prompt"], "plain")
        self.assertNotIn("prompt", other.arguments)


class ToolAndHelpers(unittest.TestCase):
    def test_the_tool_offers_the_brief_and_says_to_hand_off_big_jobs(self):
        task = next(t for t in TOOL_SCHEMAS if t["function"]["name"] == "task")["function"]
        props = task["parameters"]["properties"]
        for key in ("goal", "known", "files", "done_when", "returns"):
            self.assertIn(key, props)
            self.assertIn(key, props["tasks"]["items"]["properties"])
        self.assertEqual(props["tasks"]["items"]["required"], ["description"])
        text = json.dumps(task)
        self.assertNotIn("saves time only beside other helpers", text)
        self.assertIn("even alone", text)
        self.assertIn("keeps going until done_when holds", text)

    def test_the_built_in_helpers_work_until_done_and_say_what_they_checked(self):
        built = agents.builtin_agents()
        for name, helper in built.items():
            with self.subTest(helper=name):
                self.assertIn("Keep going until the task's done-when holds", helper.body)
                self.assertIn("what you could not check", helper.body)
        self.assertNotIn("Keep the diff small", built["worker"].body)
        self.assertNotIn("then stop", built["researcher"].description)
        self.assertIn("run its checks yourself", built["worker"].body)


if __name__ == "__main__":
    unittest.main()
