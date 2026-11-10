"""Every chat tells its model how big its context window is (0.52, context-window-told).

Asked "how much context do you have?", a model guessed: nothing in its instructions said. Now Work, ChatDGC and a
Pip's chat each say the window size, the one the chat really sends, in one line ("Context window: 1,048,576 tokens,
set in your prompt box"). Only the size, never live usage: usage changes every turn and would break the provider's
prompt cache, while the size changes only when the user changes it (test_stable_prefix holds the cache side for Work).
"""
from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from test_monitors import FrontendUI, make_config     # first: it redirects HOME before dgc is imported
from dgc.agent import Agent
from dgc.chatdgc.prompt import system_prompt as chatdgc_prompt


class WorkTellsItsWindow(unittest.TestCase):
    def agent(self, **settings):
        root = Path(tempfile.mkdtemp(prefix="dgc-ctx-told-"))
        return Agent(make_config(root, **settings), FrontendUI())

    def test_work_names_the_window_it_sends_and_follows_a_change(self):
        agent = self.agent(context_size=131072)
        prompt = agent.system_prompt()
        self.assertIn("- Context window: 131,072 tokens, set in your prompt box", prompt)
        self.assertEqual(agent.context_size(), 131072, "the size it names is the one it sends")
        agent.config.data["context_size"] = 65536
        self.assertIn("- Context window: 65,536 tokens, set in your prompt box", agent.system_prompt(),
                      "a new window is what the model is told next")
        self.assertNotIn("131,072", agent.system_prompt())

    def test_only_the_size_never_how_full_it_is(self):
        agent = self.agent(context_size=32768)
        prompt = agent.system_prompt()
        line = next(l for l in prompt.splitlines() if l.startswith("- Context window:"))
        self.assertNotRegex(line, r"\d+ ?%|used|left|full", "live usage would break the prompt cache every turn")
        self.assertEqual(prompt, agent.system_prompt(), "the same window, the same words, turn after turn")


class ChatDGCTellsItsWindow(unittest.TestCase):
    def test_chatdgc_names_the_window_its_chat_uses(self):
        prompt = chatdgc_prompt(window=262144)
        self.assertIn("Your context window is 262,144 tokens (set in the chat's context meter).", prompt)
        self.assertNotIn("context window is", chatdgc_prompt(), "no window known, nothing said")


class PipTellsItsWindow(unittest.TestCase):
    setUp = __import__("tests.test_pips_local", fromlist=["LocalPipsTests"]).LocalPipsTests.setUp

    def system_prompt(self, pip, chat_options):
        from dgc import pip_chat, pips
        from dgc.llm import LLMClient, ChatResult
        run = pip_chat.send(self.store, pip["id"], "How much context do you have?", "k-ctx-" + str(chat_options["context_size"]),
                            "user", self.cfg, chat_options=chat_options)["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(messages[0]["content"])
            return ChatResult(content="A lot.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "A lot."})
        return seen[0] if isinstance(seen[0], str) else json.dumps(seen[0])

    def test_a_pips_chat_names_the_window_set_in_its_box(self):
        pip = self.store.create(self.registry.personal()["id"], "Planner", "Help plan my day", "user")
        prompt = self.system_prompt(pip, {"context_size": 16384, "thinking": "off"})
        self.assertIn("Context window: 16,384 tokens, set in your prompt box.", prompt)
        again = self.system_prompt(pip, {"context_size": 8192, "thinking": "off"})
        self.assertIn("Context window: 8,192 tokens, set in your prompt box.", again, "changed in its box, told next turn")


if __name__ == "__main__":
    unittest.main()
