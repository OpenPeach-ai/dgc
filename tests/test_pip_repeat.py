"""A chat that begins with work the user asked for before is offered a Pip, once."""
import json
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_repeat


class RepeatTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="dgc-repeat-")
        self.addCleanup(temp.cleanup)
        self.dir = Path(temp.name)
        p = patch("dgc.sessions.project_dir", return_value=self.dir)
        p.start(); self.addCleanup(p.stop)
        self.now = time.time()

    def session(self, name, prompt, *, days_ago=1, size=0):
        path = self.dir / f"{name}.json"
        messages = [{"role": "system", "content": "s"}, {"role": "user", "content": prompt},
                    {"role": "assistant", "content": "ok " + "x" * size}]
        path.write_text(json.dumps({"messages": messages}))
        stamp = self.now - days_ago * 86400
        os.utime(path, (stamp, stamp))
        return path

    def test_two_earlier_chats_like_this_one_give_one_line_of_guidance(self):
        self.session("a", "Summarise the overnight sales numbers and email the team a short report", days_ago=2)
        self.session("b", "summarise overnight sales numbers, then email a short report to the team", days_ago=1)
        self.session("c", "Fix the login redirect bug in the auth module", days_ago=1)
        text = "Summarise the overnight sales numbers and email the team a short report please"
        line = pip_repeat.hint("/p", text)
        self.assertIn("started 2 earlier chats", line)
        self.assertIn("offer to make it a Pip", line)
        self.assertIn("only if they agree", line)
        self.assertIn("do not ask again if they decline", line)

    def test_one_earlier_chat_old_or_huge_chats_and_short_prompts_say_nothing(self):
        text = "Summarise the overnight sales numbers and email the team a short report"
        self.session("a", text, days_ago=1)
        self.assertEqual(pip_repeat.hint("/p", text), "", "once is not a habit")
        self.session("old", text, days_ago=45)
        self.assertEqual(pip_repeat.hint("/p", text), "", "older than 30 days")
        self.session("big", text, days_ago=1, size=pip_repeat.MAX_BYTES)
        self.assertEqual(pip_repeat.hint("/p", text), "", "a huge session is not read")
        current = self.session("now", text, days_ago=0)
        self.assertEqual(pip_repeat.hint("/p", text, current=current), "", "this chat is not its own precedent")
        self.assertEqual(pip_repeat.similar_chats("/p", "fix it"), [], "too few words to compare")

    def test_the_guidance_reaches_the_system_prompt_once_per_chat(self):
        from dgc.agent import Agent
        agent = Agent.__new__(Agent)
        agent.depth = 0
        agent.config = type("C", (), {"project_root": "/p", "get": lambda self, k, d=None: d})()
        calls = []
        with patch("dgc.pip_access.tools_available", return_value=True), \
                patch.object(pip_repeat, "hint", side_effect=lambda *a, **k: calls.append(a) or "- REPEAT_LINE"):
            agent._check_pips_repeat("first prompt of the chat")
            agent._check_pips_repeat("a later prompt")
        self.assertEqual(len(calls), 1, "checked once, on the chat's first prompt")
        self.assertEqual(agent._pips_repeat_line, "- REPEAT_LINE")
        with patch.object(pip_repeat, "hint", side_effect=RuntimeError("disk")), \
                patch("dgc.pip_access.tools_available", return_value=True):
            other = Agent.__new__(Agent); other.depth = 0; other.config = agent.config
            other._check_pips_repeat("x")
            self.assertEqual(other._pips_repeat_line, "", "a failure never costs the turn")


if __name__ == "__main__":
    unittest.main()
