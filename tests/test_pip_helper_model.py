"""His call, 18 Nov: a Pip's helpers' model by the user's words, as Work's helpers have (ad5ea1a7).

"Fix it with GLM 5 flash on my Ollama Cloud" in a Pip's chat sets what its helpers run on: the same setting as its
Sub-agents tab (its fixes, and the helpers inside its runs). Only from the user's own message, and only on one of their
saved connections, never a subscription CLI or DGC Router. "Back to your own model" undoes it.
"""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_agents, pip_chat
from tests import test_pips_local as local

CONNECTIONS = [{"id": "provider_" + "a" * 32, "name": "Ollama Cloud", "host": "ollama.com"},
               {"id": "provider_" + "b" * 32, "name": "Work OpenRouter", "host": "openrouter.ai"}]


class TheTool(unittest.TestCase):
    def test_a_saved_connection_by_its_name_and_a_model(self):
        choice, told = pip_agents.model_tool_result(CONNECTIONS, {"connection": "my ollama cloud", "model": "glm-5-flash"})
        self.assertEqual(choice, {"mode": "provider", "provider": CONNECTIONS[0]["id"], "model": "glm-5-flash"})
        self.assertIn("glm-5-flash on Ollama Cloud", told)
        choice, _ = pip_agents.model_tool_result(CONNECTIONS, {"connection": "openrouter", "model": "z-ai/glm-5"})
        self.assertEqual(choice["provider"], CONNECTIONS[1]["id"])

    def test_back_to_its_own_model(self):
        choice, told = pip_agents.model_tool_result(CONNECTIONS, {"connection": "", "model": ""})
        self.assertEqual(choice, {"mode": "default"})
        self.assertIn("own model", told)

    def test_an_unknown_connection_or_no_model_sets_nothing(self):
        choice, told = pip_agents.model_tool_result(CONNECTIONS, {"connection": "my claude code", "model": "opus"})
        self.assertIsNone(choice)
        self.assertIn("Ollama Cloud, Work OpenRouter", told)
        choice, told = pip_agents.model_tool_result(CONNECTIONS, {"connection": "Ollama Cloud", "model": ""})
        self.assertIsNone(choice)
        self.assertIn("which model", told)


class InItsChat(unittest.TestCase):
    setUp = local.LocalPipsTests.setUp

    def pip(self):
        return self.store.create(self.registry.personal()["id"], "Planner", "Help plan my day", "editor-user")

    def keep(self, pip, key, choice):
        dgc = key.startswith(pip_chat.DGC_KEYS)
        run = pip_chat.send(self.store, pip["id"], "From DGC." if dgc else "Fix it with GLM 5 flash on my Ollama Cloud",
                            key, "local-routine" if dgc else "editor-user", self.cfg, _intro=dgc)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Done.", "helper_model": choice})
        return pip_agents.agents_model(self.registry, pip["id"])["model_choice"]

    def test_your_own_message_sets_it_and_a_routine_never_does(self):
        pip = self.pip()
        choice = {"mode": "provider", "provider": CONNECTIONS[0]["id"], "model": "glm-5-flash"}
        self.assertEqual(self.keep(pip, "routine_due", choice), {"mode": "default"}, "a routine's turn sets nothing")
        self.assertEqual(self.keep(pip, "mine-1", choice), choice, "the same setting as its Sub-agents tab")
        self.assertEqual(self.keep(pip, "mine-2", {"mode": "default"}), {"mode": "default"})

    def test_never_a_cli_or_the_router(self):
        from dgc.workspace_registry import RegistryError
        pip = self.pip()
        for bad in ({"mode": "subscription", "engine": "claude"}, {"mode": "router"}):
            with self.subTest(choice=bad), self.assertRaises(RegistryError):
                self.keep(pip, "bad-" + bad["mode"], bad)
        self.assertEqual(pip_agents.agents_model(self.registry, pip["id"])["model_choice"], {"mode": "default"})

    def test_the_worker_offers_it_only_in_your_turn_with_saved_connections(self):
        from dgc import pip_holds, pip_notes, pips
        from dgc.llm import ChatResult, LLMClient, ToolCall
        pip = self.pip()
        for key, carried in (("ask-model", True), ("routine_x", False)):
            dgc = key.startswith(pip_chat.DGC_KEYS)
            sent = pip_chat.send(self.store, pip["id"], "From DGC." if dgc else "Use GLM 5 flash on my Ollama Cloud for fixes",
                                 key, "local-routine" if dgc else "editor-user", self.cfg, _intro=dgc)["run"]
            manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (sent["id"],)).fetchone()[0])
            with patch.object(type(self.cfg), "saved_provider_names", return_value=CONNECTIONS, create=True):
                raw = pip_agents.runtime(self.cfg, sent, pip_holds.runtime(
                    self.registry, sent, pip_notes.runtime(self.registry, sent, manifest)))
            seen = {}
            turns = iter([ChatResult(content="", tool_calls=[ToolCall("m1", pip_agents.MODEL_TOOL,
                                                                     {"connection": "Ollama Cloud", "model": "glm-5-flash"})]),
                          ChatResult(content="Set.")])

            def chat(client, messages, tools=None, **kwargs):
                seen.setdefault("tools", {t["function"]["name"] for t in tools})
                return next(turns) if pip_agents.MODEL_TOOL in seen["tools"] else ChatResult(content="Hello.")
            with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                    patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                    patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
                result = pips.execute_native(self.cfg, self.root, raw, lambda e: None)
            with self.subTest(key=key):
                self.assertEqual(pip_agents.MODEL_TOOL in seen["tools"], carried)
                self.assertEqual("helper_model" in result, carried)
                self.assertNotIn("api_key", json.dumps(raw.get("helper_connections", [])), "names only, never a key")
            self.store.claim_next()
            self.store.finish(sent["id"], result=result)
        self.assertEqual(pip_agents.agents_model(self.registry, pip["id"])["model_choice"],
                         {"mode": "provider", "provider": CONNECTIONS[0]["id"], "model": "glm-5-flash"})


if __name__ == "__main__":
    unittest.main()
