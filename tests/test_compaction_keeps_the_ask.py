"""A long run on a Pip's computer forgot what it was asked.

Measured twice with deepseek-v4.1-flash:cloud on the T-shirt designer (785 s / 183 steps, then 917 s /
188 steps): the run compacted on the way and ended "I don't have a stated request for this design yet.
Tell me what you want it to look like." The ask had not gone anywhere the model could not have kept it;
DGC itself let it go, in two steps.

1. Every step on the computer ends with the screen it left, sent as a user-role message (that is how
   an image reaches a model). Compaction counted each of those as the user speaking: the summariser saw
   a column of `user: <tool_results> ... your computer's screen after drag` lines and was told the goal
   comes ONLY from `user:` lines, and the "user's own messages, verbatim" block filled up with screen
   captions, newest first, until the real ask no longer fit.
2. A later compaction quotes only the user's words from the stretch it folds. The ask was folded by the
   first one, so from the second on it lived only in whatever the summariser chose to write.

The fixes: a round's screen, a text-protocol `<tool_results>` and a `<system-reminder>` are DGC's own
messages, never the user's; and each brief keeps the words it quoted, so the next one quotes them again.
"""
from __future__ import annotations

import copy
import os
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import sessions                                          # noqa: E402
from dgc.agent import (Agent, _COMPACT_CHARS_PER_TOKEN, _RETAINED_USER_TOKENS,   # noqa: E402
                       _retain_user_turns, summariser_role)
from dgc.config import Config, DEFAULTS                           # noqa: E402
from dgc.llm import LLMClient                                     # noqa: E402

ASK = "Put Hello Pips on the tee: upper chest, centred, about twice its size. Don't order anything."
HEADER = "## The user's own messages, verbatim"
WINDOW = 65_536


def screen(call_id: str) -> dict:
    """The message a step on the computer ends with, exactly as the agent builds it."""
    return {"role": "user", "content": Agent._screenshot_parts([{
        "uri": "data:image/jpeg;base64,AAAA", "source": "browser", "call_id": call_id,
        "label": "your computer's screen after drag (points are pixels of this 1280x800 screenshot, "
                 "from its top-left corner)"}])}


def steps(start: int, count: int) -> list[dict]:
    out = []
    for i in range(start, start + count):
        out += [{"role": "assistant", "content": "",
                 "tool_calls": [{"id": f"c{i}", "type": "function",
                                 "function": {"name": "computer", "arguments": '{"op":"drag"}'}}]},
                {"role": "tool", "tool_call_id": f"c{i}", "content": f"Dragged (step {i})."},
                screen(f"c{i}")]
    return out


def fixture_config(root: Path, **data) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="default",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False)
    config.data.update(data)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class QuietUI:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


class AScreenIsNotTheUserTest(unittest.TestCase):
    def test_the_summariser_never_reads_a_round_of_dgc_s_own_as_the_user(self) -> None:
        self.assertEqual(summariser_role({"role": "user", "content": ASK}), "user")
        for message in (screen("c1"),
                        {"role": "user", "content": "<tool_results>\n<result tool=\"read\">ok</result>\n</tool_results>"},
                        {"role": "user", "content": "<system-reminder>\nTime is running short.\n</system-reminder>"}):
            self.assertNotEqual(summariser_role(message), "user", message["content"])

    def test_a_long_run_on_its_computer_still_quotes_the_ask(self) -> None:
        messages = [{"role": "user", "content": "Approved job reference: " + "x" * 9_000
                     + "\n\nCurrent user message:\n" + ASK}] + steps(0, 200)
        budget = min(_RETAINED_USER_TOKENS, WINDOW // 8) * _COMPACT_CHARS_PER_TOKEN
        kept = _retain_user_turns(messages, budget)
        self.assertEqual(len(kept), 1, [m["content"][:80] for m in kept[-3:]])
        self.assertIn(ASK, kept[0]["content"])


class TheAskSurvivesEveryCompactionTest(unittest.TestCase):
    """Two real compactions over a long computer run, with a summariser that never mentions the ask."""

    def setUp(self) -> None:
        self.home = tempfile.TemporaryDirectory(prefix="dgc-ask-home-")
        self.root = tempfile.TemporaryDirectory(prefix="dgc-ask-root-")
        self.env = patch.dict(os.environ, {"HOME": self.home.name})
        self.env.start()

    def tearDown(self) -> None:
        self.env.stop()
        self.root.cleanup()
        self.home.cleanup()

    def agent(self) -> Agent:
        class _Client(LLMClient):
            vision_supported = True

            def compact_responses(self, *args, **kwargs):
                return None
        with patch.object(Agent, "_new_client", lambda self, *a, **k: _Client("http://localhost.invalid/v1", "", "fixture")):
            agent = Agent(fixture_config(Path(self.root.name), compact_threshold=0.0, context_size=WINDOW), QuietUI())
        agent.session_file = sessions.new_path(Path(self.root.name))
        brief = types.SimpleNamespace(content="## Goal\n- Not stated in the steps shown.\n## Progress\n"
                                      "- Dragged the text box a few times.\n## Next\n- Keep going.",
                                      tool_calls=None, usage=None)
        summariser = types.SimpleNamespace(chat=lambda *a, **k: brief)
        agent._aux_client = lambda *a, **k: summariser
        return agent

    def quoted(self, agent: Agent) -> str:
        content = agent.messages[1]["content"]
        self.assertTrue(content.startswith("[Earlier conversation compacted"), content[:120])
        return content.rsplit(HEADER, 1)[1] if HEADER in content else ""

    def test_the_ask_is_quoted_after_the_first_and_the_second_compaction(self) -> None:
        agent = self.agent()
        agent.messages.append({"role": "user", "content": ASK})
        agent.messages += steps(0, 40)
        self.assertTrue(agent.maybe_compact(deadline=time.monotonic() + 30, notify=False))
        first = self.quoted(agent)
        self.assertIn(ASK, first)
        self.assertFalse("your computer's screen" in first, "a screen caption quoted as the user's words")
        agent.messages += steps(40, 40)
        self.assertTrue(agent.maybe_compact(deadline=time.monotonic() + 30, notify=False))
        second = self.quoted(agent)
        self.assertIn(ASK, second, "the second compaction let the ask go")
        self.assertFalse("your computer's screen" in second, "a screen caption quoted as the user's words")
        self.assertEqual(second.count(ASK), 1, "quoted once, not once per compaction")

    def test_a_newer_word_from_the_user_is_quoted_with_the_ask(self) -> None:
        agent = self.agent()
        agent.messages.append({"role": "user", "content": ASK})
        agent.messages += steps(0, 30)
        self.assertTrue(agent.maybe_compact(deadline=time.monotonic() + 30, notify=False))
        agent.messages.append({"role": "user", "content": "Make it red too."})
        agent.messages += steps(30, 30)
        self.assertTrue(agent.maybe_compact(deadline=time.monotonic() + 30, notify=False))
        second = self.quoted(agent)
        self.assertTrue(ASK in second and "Make it red too." in second, "both are the user's words")
        self.assertLess(second.index(ASK), second.index("Make it red too."), "it reads forwards")

    def test_the_quoted_words_never_reach_the_model_as_a_field(self) -> None:
        agent = self.agent()
        agent.messages.append({"role": "user", "content": ASK})
        agent.messages += steps(0, 30)
        self.assertTrue(agent.maybe_compact(deadline=time.monotonic() + 30, notify=False))
        self.assertTrue(all(str(key).startswith("_") or key in ("role", "content")
                            for key in agent.messages[1]), agent.messages[1].keys())


if __name__ == "__main__":
    unittest.main()
