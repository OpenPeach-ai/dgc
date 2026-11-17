"""A model per helper, by the user's own words (his call, 17 Nov: "For the UI work, use the GLM 5 flash model on my
ollama cloud"). The helper the main agent starts for it runs on that saved connection and model, whatever the Sub-agents
setting is.

- The editor tells DGC the names of the user's saved connections (never their keys): set_helper_connections. Only then
  does the task tool offer `connection`, listing them.
- When a helper starts on one, DGC asks the editor for that one connection's address, API and key
  (connection_route_request); the key goes only to that address and is never written anywhere.
- An unknown name, or a connection that runs its own tools (Claude Code, Codex), is refused in words, and nothing starts.
- With no answer from the editor the helper doesn't start on a guess: it says why.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_subagents import Harness, Script, calls_then, child  # noqa: E402

from dgc.llm import LLMClient, ToolCall  # noqa: E402

CONNECTIONS = [{"id": "provider_ollamacloud", "name": "Ollama Cloud", "host": "ollama.com", "kind": "api"},
               {"id": "provider_openrouter", "name": "OpenRouter", "host": "openrouter.ai", "kind": "api"},
               {"id": "claude", "name": "Claude Code", "host": "", "kind": "cli"}]
KEY = "sk-helper-only-0123456789"


class Seen(Script):
    """The script, also noting where each request went: (first user message, base_url, model, key)."""

    def __init__(self, routes):
        super().__init__(routes)
        self.where = []

    def __call__(self, client, messages, *a, **k):
        users = [m for m in messages if m.get("role") == "user"]
        first = str(users[0].get("content", "")) if users else ""
        self.where.append((first, str(client.base_url), str(client.model), str(client.api_key)))
        return super().__call__(client, messages, *a, **k)


class Case(unittest.TestCase):
    def setUp(self):
        self.state = Path(tempfile.mkdtemp(prefix="dgc-helper-conn-"))
        env = patch.dict(os.environ, {"DGC_HOME": str(self.state)})
        env.start()
        self.addCleanup(env.stop)

    def harness(self, connections=CONNECTIONS):
        directory = tempfile.TemporaryDirectory(prefix="dgc-helper-conn-project-")
        self.addCleanup(directory.cleanup)
        harness = Harness(Path(directory.name), mode="auto")
        self.addCleanup(harness.close)
        if connections is not None:
            harness.backend._dispatch({"type": "set_helper_connections", "connections": connections})
        return harness

    def task_schema(self, harness):
        schemas = harness.agent._tool_schemas()
        return next(s for s in schemas if s["function"]["name"] == "task")["function"]["parameters"]["properties"]

    def run_with(self, harness, task_args, answer):
        if answer is not None:
            harness.answer("connection_route_request", answer)
        seen = Seen([("Make the UI", calls_then([ToolCall("t1", "task", {"description": "UI work",
                                                                          "prompt": "Build the header", **task_args})])),
                     ("Build the header", child("header built"))])
        import test_subagents as base
        with patch.object(LLMClient, "chat", seen), patch.object(base.Config, "clone_for_root", base.clone_fixture):
            harness.ui.turn_id = "t1"
            harness.ui.reset_turn_messages()
            harness.agent.run_turn("Make the UI. For the UI work, use the GLM 5 flash model on my ollama cloud")
        return seen


class TheField(Case):
    def test_no_connections_no_field(self):
        harness = self.harness(connections=None)
        self.assertNotIn("connection", self.task_schema(harness))

    def test_the_users_connections_are_named_in_it(self):
        harness = self.harness()
        field = self.task_schema(harness)["connection"]
        self.assertIn("Ollama Cloud", field["description"])
        self.assertIn("OpenRouter", field["description"])
        self.assertNotIn("Claude Code", field["description"], "a CLI runs its own tools: never a helper's connection")
        self.assertNotIn(KEY, json.dumps(field))


class AHelperOnItsConnection(Case):
    def test_it_runs_on_that_address_model_and_key(self):
        harness = self.harness()
        seen = self.run_with(harness, {"connection": "my ollama cloud", "model": "glm-5-flash"},
                             {"base_url": "https://ollama.com/v1", "api_mode": "chat", "api_key": KEY})
        child_calls = [w for w in seen.where if w[0].startswith("Build the header")]
        self.assertTrue(child_calls, seen.where)
        self.assertEqual({(w[1], w[2], w[3]) for w in child_calls}, {("https://ollama.com/v1", "glm-5-flash", KEY)})
        main_calls = [w for w in seen.where if w[0].startswith("Make the UI")]
        self.assertTrue(all(w[3] != KEY for w in main_calls), "the key goes only to that helper")
        asked = [f for f in harness.stream.frames() if f["type"] == "connection_route_request"]
        self.assertEqual([a["connection"] for a in asked], ["provider_ollamacloud"])

    def test_the_key_is_never_written_anywhere(self):
        harness = self.harness()
        self.run_with(harness, {"connection": "Ollama Cloud", "model": "glm-5-flash"},
                      {"base_url": "https://ollama.com/v1", "api_mode": "chat", "api_key": KEY})
        self.assertNotIn(KEY, json.dumps(harness.stream.frames()))
        self.assertNotIn(KEY, json.dumps(harness.agent.messages, default=str))
        for path in self.state.rglob("*"):
            if path.is_file():
                self.assertNotIn(KEY, path.read_text(errors="ignore"), path)

    def test_an_unknown_name_is_refused_and_nothing_starts(self):
        harness = self.harness()
        seen = self.run_with(harness, {"connection": "Groq", "model": "llama"}, None)
        self.assertFalse([w for w in seen.where if w[0].startswith("Build the header")], "no helper started")
        said = json.dumps(harness.agent.messages, default=str)
        self.assertIn("no saved connection called Groq", said)
        self.assertIn("Ollama Cloud", said)

    def test_a_cli_is_refused(self):
        harness = self.harness()
        seen = self.run_with(harness, {"connection": "Claude Code", "model": "opus"}, None)
        self.assertFalse([w for w in seen.where if w[0].startswith("Build the header")])
        self.assertIn("runs its own tools", json.dumps(harness.agent.messages, default=str))

    def test_no_answer_from_the_editor_never_falls_back_to_a_guess(self):
        harness = self.harness()
        seen = self.run_with(harness, {"connection": "Ollama Cloud", "model": "glm-5-flash"}, {"error": "not saved"})
        self.assertFalse([w for w in seen.where if w[0].startswith("Build the header")], "no helper on a guess")
        self.assertIn("couldn't get Ollama Cloud", json.dumps(harness.agent.messages, default=str))

    def test_without_connection_a_helper_runs_as_before(self):
        harness = self.harness()
        seen = self.run_with(harness, {}, None)
        child_calls = [w for w in seen.where if w[0].startswith("Build the header")]
        self.assertTrue(child_calls)
        self.assertTrue(all(w[3] != KEY for w in child_calls))
        self.assertEqual([f for f in harness.stream.frames() if f["type"] == "connection_route_request"], [])


class TheProtocol(unittest.TestCase):
    def test_declared_with_a_capability(self):
        from dgc import editor_protocol as ep
        self.assertIn("connection_route_request", ep.EVENT_FIELDS)
        self.assertEqual(set(ep.EVENT_FIELDS["connection_route_request"]), {"id", "connection"})
        for name in ("set_helper_connections", "connection_route_response"):
            self.assertIn(name, ep.COMMAND_FIELDS)
        from test_model_window_at import ModelWindowAt
        world = ModelWindowAt("test_it_is_offered")
        world.setUp()
        self.addCleanup(world.doCleanups)
        self.assertEqual(world.host().default._ready_payload()["capabilities"].get("helper_connections"), 1)

    def test_a_bad_list_is_refused(self):
        from dgc import editor_protocol as ep
        self.assertIsNotNone(ep.command_error({"type": "set_helper_connections", "connections": "nope"}))
        self.assertIsNone(ep.command_error({"type": "set_helper_connections", "connections": CONNECTIONS}))


if __name__ == "__main__":
    unittest.main()
