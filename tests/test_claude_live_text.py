"""Claude Code's words as they come (his live test, 15 Nov: a Pip on Claude Code said "Waiting for Claude Code (355s ·
0 tok)" for 13 minutes while the model streamed the whole time).

DGC ran Claude Code with stream-json but without --include-partial-messages, so each message came only once it was
whole: minutes of nothing with Opus thinking. Now every surface that runs it (Work, ChatDGC, a Pip's brain) asks for
the pieces, shows text and thinking as they come, and never shows a message twice when the whole of it arrives after its
pieces. The lines below are Claude Code 2.1.322's own (a probe, 15 Nov), trimmed."""
import json
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_brain, subscriptions
from dgc.subscriptions import parse_stream_events

M1, M2 = "msg_011Ch4jby8auNsftF9mrDv2x", "msg_02secondmessage00000000"


def delta(mid, kind, text):
    field = "text" if kind == "text_delta" else "thinking"
    return json.dumps({"type": "stream_event", "api_message_id": mid, "session_id": "s",
                       "event": {"type": "content_block_delta", "index": 0, "delta": {"type": kind, field: text}}})


def whole(mid, blocks):
    return json.dumps({"type": "assistant", "session_id": "s", "message": {"id": mid, "role": "assistant", "content": blocks}})


LINES = [
    json.dumps({"type": "system", "subtype": "init", "session_id": "s"}),
    json.dumps({"type": "stream_event", "api_message_id": M1, "event": {"type": "message_start"}}),
    delta(M1, "thinking_delta", "Looking at "), delta(M1, "thinking_delta", "the picture."),
    delta(M1, "text_delta", "Here is"), delta(M1, "text_delta", " the first part."),
    whole(M1, [{"type": "thinking", "thinking": "Looking at the picture."}, {"type": "text", "text": "Here is the first part."},
               {"type": "tool_use", "id": "t1", "name": "mcp__dgc__computer", "input": {"action": "screenshot"}}]),
    json.dumps({"type": "stream_event", "api_message_id": M1, "event": {"type": "message_stop"}}),
    delta(M2, "text_delta", "And"), delta(M2, "text_delta", " the rest."),
    whole(M2, [{"type": "text", "text": "And the rest."}]),
    json.dumps({"type": "result", "subtype": "success", "result": "And the rest.", "session_id": "s"}),
]


class Pieces(unittest.TestCase):
    def events(self, state):
        out = []
        for line in LINES:
            out += parse_stream_events("claude", line, state)
        return out

    def test_text_and_thinking_come_as_they_are_written_and_never_twice(self):
        out = self.events({})
        text = [e for e in out if e["kind"] == "text"]
        self.assertEqual("".join(e["text"] for e in text), "Here is the first part.And the rest.",
                         "the pieces, once each; the whole message after them adds nothing")
        self.assertNotIn("delta", text[0], "a message's first piece: the reader may set it apart from the last message")
        self.assertTrue(all(e.get("delta") for e in text[1:2]), "the rest of that message joins it as written")
        self.assertNotIn("delta", text[2], "the second message's first piece starts a new message")
        self.assertEqual("".join(e["text"] for e in out if e["kind"] == "thinking"), "Looking at the picture.")
        self.assertEqual([e["name"] for e in out if e["kind"] == "tool_call"], ["mcp__dgc__computer"],
                         "a tool call still comes from the whole message")

    def test_a_reader_with_no_memory_still_gets_every_word(self):
        out = []
        for line in LINES:
            out += parse_stream_events("claude", line)
        self.assertIn("Here is the first part.", [e["text"] for e in out if e["kind"] == "text"],
                      "without the pieces' memory the whole message still says it")

    def test_a_cli_without_pieces_is_as_before(self):
        state = {}
        out = parse_stream_events("claude", LINES[6], state)          # only whole messages, as before
        self.assertEqual([e["text"] for e in out if e["kind"] == "text"], ["Here is the first part."])


class EverySurfaceAsksForThem(unittest.TestCase):
    def test_a_pips_brain_asks_for_the_pieces_when_its_claude_code_has_them(self):
        with patch.object(pip_brain, "_claude_takes", side_effect=lambda binary, flag: True):
            argv = pip_brain.claude_argv("/bin/claude", mcp_config=Path("/x/mcp.json"), system_file=Path("/x/s.md"))
        self.assertIn("--include-partial-messages", argv)
        with patch.object(pip_brain, "_claude_takes", side_effect=lambda binary, flag: flag != "--include-partial-messages"):
            argv = pip_brain.claude_argv("/bin/claude", mcp_config=Path("/x/mcp.json"), system_file=Path("/x/s.md"))
        self.assertNotIn("--include-partial-messages", argv, "an older one that lacks it still runs")

    def test_work_asks_for_them_too_without_running_the_binary_first(self):
        # The suite's hung-CLI check (15 Nov): asking `--help` first ran a broken binary on the turn's path and hung it.
        engine = subscriptions.get_engine("claude")
        with patch.object(subscriptions.subprocess, "run", side_effect=AssertionError("never run before the turn")):
            self.assertIn("--include-partial-messages", engine.build_argv("/bin/claude", "hi", cont=False))

    def test_the_pips_brain_joins_pieces_as_written_and_sets_messages_apart(self):
        said = []
        ui = type("UI", (), {"on_text": lambda self, t: said.append(t), "on_thinking": lambda self, t: None,
                             "info": lambda self, t: None})()
        agent = type("A", (), {"ui": ui})()
        brain = pip_brain.Turn(agent, {"binary": "/bin/claude"}, {"engine": "claude", "model": "", "effort": ""})
        state = {}
        for line in LINES:
            for event in parse_stream_events("claude", line, state):
                brain.on_event(event)
        self.assertEqual("".join(brain.said), "Here is the first part.\n\nAnd the rest.")


class APipSaysWhatItWillDo(unittest.TestCase):
    def test_a_long_job_opens_with_what_it_will_do_and_a_message_on_the_way_never_drops_the_first_ask(self):
        from dgc import pip_chat
        self.assertIn("start with one short line saying what you'll do", pip_chat.SYSTEM)
        self.assertIn("still finish and answer what they first asked", pip_chat.SYSTEM)


if __name__ == "__main__":
    unittest.main()
