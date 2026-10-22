"""Every request of a chat starts exactly where the previous one did.

A provider's prompt cache (OpenAI, DeepSeek, Anthropic) and a local runtime's reused prompt (Ollama,
llama.cpp) only help while the start of the request is byte-identical to the last one. Before 0.48
the start changed with the user's wording: asking to see a page added the artifact instructions to
the system prompt and the next turn took them out again; "edit only this file" removed the
navigation lines; a cleared checklist or an approved plan switched a section on and off; and a large
MCP catalog was cut afresh to each turn's words, so the tool list itself changed. Each change made
the whole conversation un-cached again.

These tests drive a real Agent with the real model client against a local server that answers like
each provider, through turns that used to change the start, and hold the invariant directly: the
previous request (system prompt, tool list, every message) is a byte-for-byte prefix of the next.
Only the cache markers move (they mark where this request ends, by design), so they are left out of
the comparison. No model is contacted.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from dgc import clock
from dgc.agent import Agent
from dgc.workflows import display_prompt
from fake_providers import FakeProviders, Reply, say
from test_monitors import FrontendUI, make_config

WIRES = {
    "ollama": ("qwen3.8:27b", "", "ollama"),
    "chat_completions": ("deepseek-chat", "/v1", "chat_completions"),
    "anthropic": ("claude-sonnet-5-5", "/v1", "anthropic"),
}

# Turns whose words used to switch parts of the request start on and off. None of them asks to
# choose between options: in auto mode the options picker is offered only on a turn that does (a
# product rule about unattended runs), which this file leaves alone.
PROMPTS = [
    "fix the failing test in src/app.py",
    "make a dashboard preview of the results",          # wants a page: the artifact instructions
    "thanks",
    "edit only this file: src/app.py",                  # narrow scope: used to drop navigation lines
    "carry on",                                         # after a cleared checklist
    "check the calendar for tomorrow",                  # a large MCP catalog, cut to the words
    "and the github issues",
]


def big_catalog() -> list[dict]:
    topics = ["calendar", "email", "drive", "sheets", "slack", "github", "jira", "notion"]
    return [{"type": "function", "function": {
        "name": f"mcp__apps__{topic}_{verb}_{n}",
        "description": f"{verb.title()} {topic} entries, variant {n}. " + "Parameter notes. " * 8,
        "parameters": {"type": "object", "properties": {"id": {"type": "string"}}}}}
        for topic in topics for verb in ("list", "create", "update", "delete") for n in range(4)]


def without_markers(value):
    if isinstance(value, dict):
        return {key: without_markers(item) for key, item in value.items() if key != "cache_control"}
    if isinstance(value, list):
        return [without_markers(item) for item in value]
    return value


def request_start(body: dict) -> tuple[str, str, list[str]]:
    """(system, tools, [each message]) as the bytes the provider sees, markers left out."""
    body = without_markers(body)
    return (json.dumps(body.get("system"), ensure_ascii=False),
            json.dumps(body.get("tools"), ensure_ascii=False),
            [json.dumps(message, ensure_ascii=False) for message in body.get("messages") or []])


class StableStart(unittest.TestCase):
    def session(self, wire: str):
        model, suffix, mode = WIRES[wire]
        replies = iter([
            Reply(tool_calls=[("todo", {"todos": [{"content": "Find the bug", "status": "in_progress"},
                                                  {"content": "Fix it", "status": "pending"}]})]),
            Reply(tool_calls=[("read_file", {"path": "src/app.py"})]),
            say("Fixed: the test now passes."),
        ])
        server = FakeProviders(lambda kind, body, index: next(replies, say("ok")))
        self.addCleanup(server.close)
        server.show_context = 65536
        root = Path(tempfile.mkdtemp(prefix="dgc-stable-prefix-"))
        (root / ".git").mkdir()
        (root / "src").mkdir()
        (root / "src" / "app.py").write_text("print('hi')\n")
        config = make_config(root, model=model, base_url=server.url + suffix, api_mode=mode, mode="auto",
                             context_size=65536, artifact_autostart=True, suggest=False, notes=False)
        agent = Agent(config, FrontendUI())
        self.addCleanup(agent.mcp.stop_all)
        self.addCleanup(lambda: agent.monitors.shutdown(wait=3.0))
        catalog = big_catalog()
        agent.mcp.tool_schemas = lambda: catalog
        for prompt in PROMPTS:
            if prompt == "carry on":
                self.assertTrue(agent.clear_todos())
            self.assertTrue(agent.run_turn(prompt), agent._last_turn_error)
        return agent, server.bodies()

    def check_wire(self, wire: str):
        agent, bodies = self.session(wire)
        self.assertGreaterEqual(len(bodies), len(PROMPTS) + 2, "every turn, and a tool round in the first")
        for index in range(1, len(bodies)):
            system0, tools0, messages0 = request_start(bodies[index - 1])
            system1, tools1, messages1 = request_start(bodies[index])
            where = f"{wire}: request {index} -> {index + 1}"
            self.assertEqual(tools1, tools0, f"{where}: the tool list changed")
            self.assertEqual(system1, system0, f"{where}: the system prompt changed")
            self.assertGreater(len(messages1), len(messages0) - 1, where)
            self.assertEqual(messages1[:len(messages0)], messages0,
                             f"{where}: the conversation so far was not sent again byte for byte")
        return agent, bodies

    def test_ollama(self):
        self.check_wire("ollama")

    def test_chat_completions(self):
        self.check_wire("chat_completions")

    def test_anthropic(self):
        agent, bodies = self.check_wire("anthropic")
        self.assertTrue(any("cache_control" in json.dumps(body) for body in bodies),
                        "and the Anthropic requests mark where the cached prefix ends")

    def test_what_a_turn_asked_for_still_reaches_the_model_on_its_own_prompt(self):
        agent, bodies = self.session("chat_completions")
        prompts = [m for m in agent.messages if m.get("role") == "user"
                   and clock.CLOCK_OPEN in str(m.get("content", ""))]
        by_words = {display_prompt(str(m["content"])): str(m["content"]) for m in prompts}
        self.assertEqual(set(by_words), set(PROMPTS), "the person sees only what they typed")
        self.assertIn("# Artifacts", by_words["make a dashboard preview of the results"])
        self.assertIn(clock.NOTES_OPEN, by_words["make a dashboard preview of the results"])
        self.assertIn("# Checklist cleared", by_words["carry on"])
        self.assertNotIn(clock.NOTES_OPEN, by_words["thanks"], "a turn that asked for nothing carries nothing")
        system = agent.messages[0]["content"]
        for absent in ("# Artifacts", "# Checklist cleared", "# Approved plan"):
            self.assertNotIn(absent, system)
        self.assertIn("use repo_map to locate", system, "navigation guidance no longer depends on wording")
        self.assertIn("<dgc-turn-notes>", system, "the model is told what the notes are")


class Suffix(unittest.TestCase):
    def test_the_notes_sit_before_the_clock_and_leave_with_it(self):
        notes = "<dgc-turn-notes>\n# Artifacts\nhow to\n</dgc-turn-notes>"
        sent = clock.attach_turn_suffix("show me a page", notes)
        self.assertTrue(sent.startswith("show me a page\n\n<dgc-turn-notes>\n"))
        self.assertTrue(sent.endswith(clock.CLOCK_CLOSE))
        self.assertEqual(clock.strip_turn_clock(sent), "show me a page")
        self.assertEqual(clock.strip_turn_clock(clock.attach_turn_suffix(sent, notes)).count("dgc-turn-notes"), 0,
                         "sent again, the suffix is replaced, never stacked")
        typed = "my notes <dgc-turn-notes> stay"
        self.assertEqual(clock.strip_turn_clock(clock.attach_turn_suffix(typed)), typed,
                         "a frame the user typed mid-message is theirs")
        self.assertEqual(clock.strip_turn_clock(clock.attach_turn_suffix("", notes)), "")


if __name__ == "__main__":
    unittest.main()
