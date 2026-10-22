"""The prompt outline (`get_outline` -> `outline`): every prompt of a Work session, for the editor's prompt rail.

A long session opens on its latest pages, and its history snapshot keeps only what one payload carries, so the
rail cannot read every prompt from the screen. The outline lists them all: the ones compaction archived, then each
one the transcript opens a turn with, under the turn ids the history snapshot gives them, so the editor can tell
which it already shows.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from dgc import sessions
from dgc.agent import Agent
from dgc.config import Config, DEFAULTS
from dgc.editor_protocol import MAX_EVENT_BYTES, command_error, event_error
from dgc import headless
from dgc.headless import Backend, TURN_CONTINUE_MARKER
from dgc.workflows import STEERING_PREFIX, STEERING_SUFFIX


def _call(call_id, name, arguments):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


class PromptOutlineTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="dgc-prompt-outline-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        session_directory = patch.object(sessions, "SESSIONS_DIR", self.root / "sessions")
        session_directory.start()
        self.addCleanup(session_directory.stop)
        config = object.__new__(Config)
        config.project_root, config.project_dir = self.root, self.root / ".dgc"
        config._persist = False
        config.data = copy.deepcopy(DEFAULTS)
        config.data.update(base_url="http://localhost.invalid/v1", model="fixture", hooks={},
                           mcp_servers={}, suggest=False, artifact_autostart=False)
        config._stored_secrets, config._env_secret_keys = {}, set()
        config.permissions = {"allow": [], "ask": [], "deny": []}

        class UI:
            def __getattr__(self, _name):
                return lambda *args, **kwargs: None
        self.config = config
        self.agent = Agent(config, UI())
        self.agent.session_file = sessions.new_path(self.root)
        self.addCleanup(self.agent.mcp.stop_all)
        self.events = []
        self.backend = object.__new__(Backend)
        self.backend.agent, self.backend.config = self.agent, config
        self.backend.em = types.SimpleNamespace(emit=lambda event_type, **kw: self.events.append({"type": event_type, **kw}))
        self.backend._busy = lambda: False
        self.agent.run_turn = lambda *args, **kwargs: self.fail("an outline must not invoke a model")

    def outline(self, request_id="ol-1"):
        command = {"type": "get_outline", "request_id": request_id}
        self.assertIsNone(command_error(command))
        self.backend.dispatch(command)
        got = [e for e in self.events if e["type"] == "outline"]
        self.assertEqual(len(got), 1, self.events)
        event = got[0]
        self.assertIsNone(event_error({"seq": 1, **event}), "a valid protocol event")
        self.events.clear()
        return event

    def test_every_prompt_with_its_turn_id_first_words_and_time(self):
        self.agent.messages = [
            {"role": "system", "content": "prompt"},
            {"role": "assistant", "content": "orphan work, no prompt above it"},
            {"role": "user", "content": "Fix   the\n failing test", "_dgc_at": 1_760_000_000},
            {"role": "assistant", "content": "Looking.", "tool_calls": [_call("c1", "bash", {"command": "npm test"})]},
            {"role": "tool", "tool_call_id": "c1", "content": "exit code: 1"},
            {"role": "user", "content": "<system-reminder>\nOpen todos remain.\n</system-reminder>"},
            {"role": "assistant", "content": "Fixed."},
            # Steering is part of the turn it was sent into: not a prompt of its own.
            {"role": "user", "content": STEERING_PREFIX + "and the docs" + STEERING_SUFFIX},
            {"role": "assistant", "content": "Docs too."},
            # Nobody typed these: a continued turn and a goal DGC resumed.
            {"role": "user", "content": TURN_CONTINUE_MARKER + " Continue that turn."},
            {"role": "assistant", "content": "Continued."},
            # A prompt that is only an image, and one with words and an image.
            {"role": "user", "content": [{"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}],
             "_dgc_at": 1_760_000_600},
            {"role": "assistant", "content": "A login form."},
            {"role": "user", "content": [{"type": "text", "text": "What is on this screen?"},
                                         {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}]},
            {"role": "assistant", "content": "A chart."},
            {"role": "user", "content": "Ship it " + "word " * 100},
            {"role": "assistant", "content": "Shipped."},
        ]
        snapshot = self.backend._history()
        prompt_turns = [i["turn_id"] for i in snapshot if i.get("type") == "turn_start" and i["kind"] == "prompt" and i["prompt"]]
        event = self.outline()
        self.assertEqual(event["request_id"], "ol-1")
        self.assertEqual(event["session_id"], self.agent.session_file.stem)
        prompts = event["prompts"]
        self.assertEqual([p["id"] for p in prompts], prompt_turns, "each prompt under its turn's id in the history snapshot")
        self.assertEqual([p["text"] for p in prompts[:4]], ["Fix the failing test", "Image", "What is on this screen?",
                                                            ("Ship it " + "word " * 100).strip()[:headless.OUTLINE_CHARS]])
        self.assertEqual(len(prompts), 4, "no steering, continue marker, reminder or work with no prompt")
        self.assertEqual(prompts[0]["at"], 1_760_000_000)
        self.assertEqual(prompts[1]["at"], 1_760_000_600)
        self.assertNotIn("at", prompts[2], "a prompt the session saved no time for")
        self.assertFalse(any(p.get("archived") for p in prompts))

    def test_the_prompts_compaction_archived_come_first(self):
        self.agent.messages = [{"role": "system", "content": "s"},
                               {"role": "user", "content": "Now the tests"}, {"role": "assistant", "content": "Done."}]
        self.agent._persist()
        sessions.save_recall(self.agent.session_file, self.root, [
            {"gen": 1, "cp": 1, "who": "user", "body": "First   ask"},
            {"gen": 1, "cp": 1, "who": "assistant", "body": "An answer", "tools": "bash"},
            {"gen": 1, "cp": 1, "who": "assistant", "body": "", "tools": "read_file"},
            {"gen": 1, "cp": 1, "who": "user", "body": "Second ask"}])
        prompts = self.outline()["prompts"]
        self.assertEqual(prompts, [{"id": "a0", "text": "First ask", "archived": True},
                                   {"id": "a1", "text": "Second ask", "archived": True},
                                   {"id": "h1", "text": "Now the tests"}])

    def test_every_prompt_even_past_what_one_history_payload_carries(self):
        # Big enough that the history snapshot keeps only its latest turns (1 MB of display items).
        self.agent.messages = [{"role": "system", "content": "s"}]
        for i in range(30):
            self.agent.messages += [{"role": "user", "content": f"prompt {i} " + "p" * 30_000},
                                    {"role": "assistant", "content": f"answer {i} " + "a" * 60_000}]
        shown = [i["turn_id"] for i in self.backend._history() if i.get("type") == "turn_start"]
        self.assertLess(len(shown), 30, "the snapshot is cut")
        prompts = self.outline()["prompts"]
        self.assertEqual([p["id"] for p in prompts], [f"h{n}" for n in range(1, 31)])
        self.assertEqual(prompts[0]["text"], ("prompt 0 " + "p" * 30_000)[:headless.OUTLINE_CHARS])
        self.assertEqual([p["id"] for p in prompts][-len(shown):], shown, "the same ids the snapshot gives them")

    def test_a_running_turns_prompt_has_the_running_turns_id(self):
        self.agent.messages = [{"role": "system", "content": "s"},
                               {"role": "user", "content": "First"}, {"role": "assistant", "content": "One."}]
        anchor = self.agent.messages[-1]
        self.agent.messages.append({"role": "user", "content": "Second, still running"})
        self.backend._running_turn_kind = "prompt"
        self.backend._live_turn = {"id": "turn-live-7", "anchor": anchor}
        self.assertEqual([(p["id"], p["text"]) for p in self.outline()["prompts"]],
                         [("h1", "First"), ("turn-live-7", "Second, still running")])

    def test_an_outline_stays_inside_one_frame(self):
        items = []
        for n in range(headless.OUTLINE_PROMPTS + 50):
            items += [{"type": "turn_start", "turn_id": f"h{n + 1}", "prompt": "w" * 50_000, "kind": "prompt"},
                      {"role": "time", "of": "prompt", "at": 1_760_000_000 + n}]
        listed = headless.outline_prompts(items, [{"who": "user", "body": "old"}] * 10)
        self.assertEqual(len(listed), headless.OUTLINE_PROMPTS, "the latest prompts")
        self.assertEqual(listed[-1]["id"], f"h{headless.OUTLINE_PROMPTS + 50}")
        self.assertLess(len(json.dumps({"type": "outline", "prompts": listed}).encode()), MAX_EVENT_BYTES // 2)

    def test_an_empty_session_and_the_command_shape(self):
        self.agent.messages = [{"role": "system", "content": "s"}]
        self.assertEqual(self.outline()["prompts"], [])
        self.assertIsNotNone(command_error({"type": "get_outline"}), "correlated: a request_id is required")
        self.assertIsNotNone(command_error({"type": "get_outline", "request_id": "r", "session_id": "x"}))
        self.assertIn("get_outline", headless._WAKE_NEUTRAL_COMMANDS, "a read: no monitor wake waits on it")

    def test_offered_in_ready_capabilities(self):
        self.backend.agent = types.SimpleNamespace(mode="default", session_file=None, session_name="", skills={},
            client=types.SimpleNamespace(tools_supported=True, family="fixture", capability_snapshot=lambda: {}))
        self.backend.workspace_trusted = True
        self.backend._image_spool = lambda: self.root / "spool"
        self.backend._session_policy_capability = lambda: {}
        self.backend._goal_snapshot = lambda: {}
        self.backend._context_window_size = lambda: 4096
        value = self.backend._ready_payload()
        self.assertIsNone(event_error({"type": "ready", "seq": 0, **value}))
        self.assertEqual(value["capabilities"]["outline"], 1)


if __name__ == "__main__":
    unittest.main()
