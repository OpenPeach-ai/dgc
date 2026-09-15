"""The 0.40 history hooks: `Backend._history` replays exactly what it did before them, and each
hook sits where the replay order contract (spec §1.6) says it does.

The golden file was produced by the pre-hook `_history` (main 65cd0251) from `rich_transcript()` and
`long_transcript()` below; the no-op hooks must leave both projections byte-identical.
"""
import copy
import hashlib
import json
from pathlib import Path
import types
import unittest

from dgc.agent import _COMPACT_ACK, _COMPACT_PREFIX
from dgc.goals import CYCLE_MARKER
from dgc.headless import Backend, TURN_CONTINUE_MARKER, _MID_TURN_ITEMS
from dgc.workflows import STEERING_PREFIX, STEERING_SUFFIX

GOLDEN = Path(__file__).resolve().parent / "fixtures" / "history_hooks_golden.json"


def _call(call_id, name, arguments):
    return {"id": call_id, "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}


def rich_transcript() -> list:
    """Every branch `_history` has: prompts, native and text tool protocols, notices, markers."""
    return [
        {"role": "system", "content": "system prompt"},
        # Saved work with no prompt above it still belongs to a turn.
        {"role": "assistant", "content": "orphan preface"},
        {"role": "user", "content": "Fix the failing test"},
        {"role": "assistant", "content": "Looking at the test first.",
         "tool_calls": [_call("call_0", "read_file", {"path": "tests/test_x.py"}),
                        _call("call_1", "bash", {"command": "pytest -q"})]},
        {"role": "tool", "tool_call_id": "call_0", "content": "def test_x():\n    assert add(1, 2) == 3\n"},
        {"role": "tool", "tool_call_id": "call_1", "content": "exit code: 1\nFAILED tests/test_x.py::test_x"},
        # A result whose call is not in the transcript any more.
        {"role": "tool", "tool_call_id": "gone", "content": "stale"},
        # The text tool protocol: results come back as a user message the user never typed.
        {"role": "assistant", "content": "<tool name=\"edit_file\">…</tool>"},
        {"role": "user", "content": "<tool_results>\n<result tool=\"edit_file\">ok</result>\n</tool_results>",
         "_dgc_decision": [{"outcome": "answered"}]},
        {"role": "user", "content": [
            {"type": "text", "text": "<tool_results>\nThe screenshot(s) requested above follow.\n</tool_results>"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]},
        {"role": "user", "content": "<system-reminder>\nOpen todos remain.\n</system-reminder>"},
        {"role": "assistant", "content": "Fixed: `add` returned a - b.",
         "tool_calls": []},
        # A monitor event delivered inline, then one that woke an idle session.
        {"role": "user", "content": "<monitor-events>READY</monitor-events>",
         "_dgc_notice": {"kind": "monitor", "delivery": "inline", "items": [
             {"id": "mon1", "description": "deploy log", "event_index": 1,
              "lines": ["READY 1"], "omitted_lines": 0, "kind": "output"},
             "not a row",
             {"id": "mon1", "description": "deploy log", "event_index": "x",
              "lines": ["gone"], "omitted_lines": -2, "kind": "bogus"}]}},
        {"role": "user", "content": "<monitor-events>DEPLOYED</monitor-events>",
         "_dgc_notice": {"kind": "monitor", "delivery": "wake", "label": "deploy log · 1 event",
                         "items": [{"id": "mon1", "description": "deploy log", "event_index": 2,
                                    "lines": ["DEPLOYED"], "kind": "ended"}]}},
        {"role": "assistant", "content": "The deploy finished."},
        # A prompt with an image, then steering the user sent mid-turn.
        {"role": "user", "content": [{"type": "text", "text": "What is on this screen?"},
                                     {"type": "image_url", "image_url": {"url": "data:image/png;base64,BBBB"}}]},
        {"role": "assistant", "content": "", "tool_calls": [_call("call_2", "bash", {"command": "sleep 100"})]},
        {"role": "user", "content": STEERING_PREFIX + "stop that and summarise" + STEERING_SUFFIX},
        {"role": "assistant", "content": "Summary so far.", "tool_calls": [
            _call("call_3", "grep", {"pattern": "TODO", "path": "."})]},
        # Compaction: the summary pair collapses into one marker.
        {"role": "user", "content": _COMPACT_PREFIX + "\nEarlier we fixed add()."},
        {"role": "assistant", "content": _COMPACT_ACK},
        # The backend died mid-turn and the user continued it.
        {"role": "user", "content": TURN_CONTINUE_MARKER + " Continue that turn."},
        {"role": "assistant", "content": "", "tool_calls": [_call("call_4", "bash", {"command": "make"})]},
        {"role": "tool", "tool_call_id": "call_4",
         "content": "error: tool result unavailable after session interruption"},
        # A standing goal continued by DGC.
        {"role": "user", "content": CYCLE_MARKER + " Objective: ship it."},
        {"role": "assistant", "content": "", "tool_calls": [
            _call("call_5", "edit_file", {"path": "app.py", "old_string": "a", "new_string": "b"})]},
        {"role": "tool", "tool_call_id": "call_5",
         "content": "--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-a\n+b\n"},
        {"role": "assistant", "content": "Goal step done.",
         "tool_calls": [_call(f"many_{i}", "ls", {"path": str(i)}) for i in range(20)]},
        {"role": "assistant", "content": "All done."},
        # A compaction marker the model did not acknowledge verbatim keeps its reply.
        {"role": "user", "content": _COMPACT_PREFIX + " second summary"},
        {"role": "assistant", "content": "A different reply."},
    ]


def long_transcript() -> list:
    """Big enough to hit both the per-item 50,000-character cut and the 1 MB payload trim."""
    messages = [{"role": "system", "content": "s"}]
    for i in range(30):
        messages.append({"role": "user", "content": f"prompt {i} " + "p" * 30_000})
        messages.append({"role": "assistant", "content": f"answer {i} " + "a" * 60_000,
                         "tool_calls": [_call(f"call_{i}", "bash", {"command": "x" * 3000})]})
        messages.append({"role": "tool", "tool_call_id": f"call_{i}", "content": "o" * 9000})
    return messages


def replay(messages, backend_class=Backend):
    backend = object.__new__(backend_class)
    backend.agent = types.SimpleNamespace(messages=copy.deepcopy(messages))
    return backend._history()


def dumps(items) -> str:
    return json.dumps(items, ensure_ascii=False)


class HistoryParityTests(unittest.TestCase):
    def test_rich_transcript_replays_byte_identically(self):
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        self.assertEqual(dumps(replay(rich_transcript())), dumps(golden["rich"]))

    def test_long_transcript_trims_byte_identically(self):
        golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
        text = dumps(replay(long_transcript()))
        self.assertEqual(hashlib.sha256(text.encode("utf-8")).hexdigest(), golden["long_sha256"])
        self.assertEqual(len(text), golden["long_chars"])


class _Recorder(Backend):
    """Each hook leaves a marker item, so the test can read where the hook ran."""

    def _history_begin_images(self):
        self.calls = getattr(self, "calls", [])
        self.calls.append("begin_images")

    def _history_begin_reasoning(self):
        self.calls.append("begin_reasoning")

    def _history_before_message(self, index, turn):
        self.indices = getattr(self, "indices", []) + [index]
        if self.agent.messages[index].get("_image_here") and turn is not None:
            return [{"type": "tool_images", "call_id": None, "images": [], "marker": f"orphan{index}"}]
        return []

    def _history_notice_items(self, message, turn):
        if message.get("_retry_notice"):
            self.notice_turns = getattr(self, "notice_turns", []) + [turn["id"] if turn else None]
            return [{"type": "model_retry", "marker": "retry"}]
        return None

    def _history_decisions_for_text_results(self, message, turn):
        return [{"type": "options_resolved", "call_id": None, "marker": f"decision:{turn['id']}"}]

    def _history_display_text(self, message, text):
        return text.replace("[splice]", "")

    def _history_reasoning_items(self, message, turn, *, after_text):
        if not message.get("_think"):
            return []
        turn["r"] += 1
        return [{"type": "thinking_end", "marker": f"{turn['id']}:think{turn['r']}:after={after_text}"}]

    def _history_before_tool_result(self, message, call_id, turn):
        return [{"type": "options_resolved", "call_id": call_id, "marker": "before_result"}]

    def _history_after_tool_result(self, message, call_id, turn):
        return [{"type": "tool_images", "call_id": call_id, "marker": "after_result"}]

    def _history_turn_finished(self, turn, finished):
        return True if turn.get("force_finished") else finished

    def _history_finish_reasoning(self, items):
        self.calls.append(("finish_reasoning", items[-1]["type"] if items else None))
        items.append({"role": "notice", "text": "reasoning pass"})

    def _history_finish_images(self, items):
        self.calls.append(("finish_images", items[-1].get("text")))


class HookPlacementTests(unittest.TestCase):
    def test_default_hooks_are_inert(self):
        backend = object.__new__(Backend)
        turn = {"id": "h1", "n": 0, "r": 0, "final": None, "interrupted": False}
        before = copy.deepcopy(turn)
        message = {"role": "assistant", "content": "x"}
        self.assertEqual(backend._history_before_message(0, turn), [])
        self.assertIsNone(backend._history_notice_items(message, turn))
        self.assertEqual(backend._history_decisions_for_text_results(message, turn), [])
        self.assertEqual(backend._history_display_text(message, "x[splice]"), "x[splice]")
        self.assertEqual(backend._history_reasoning_items(message, turn, after_text=True), [])
        self.assertEqual(backend._history_before_tool_result(message, "c", turn), [])
        self.assertEqual(backend._history_after_tool_result(message, "c", turn), [])
        self.assertIs(backend._history_turn_finished(turn, False), False)
        items = [{"type": "turn_end"}]
        self.assertIsNone(backend._history_finish_reasoning(items))
        self.assertIsNone(backend._history_finish_images(items))
        self.assertEqual(items, [{"type": "turn_end"}])
        self.assertEqual(turn, before)

    def test_replay_order_contract(self):
        messages = [
            {"role": "system", "content": "s"},
            {"role": "user", "content": "go"},
            {"role": "assistant", "content": "Let me look.[splice]", "_think": True,
             "tool_calls": [_call("call_0", "read_file", {"path": "a.py"})]},
            {"role": "tool", "tool_call_id": "call_0", "content": "print(1)"},
            {"role": "user", "content": "<tool_results>\nok\n</tool_results>", "_dgc_decision": [{}],
             "_image_here": True},
            {"role": "user", "content": "continue after a stream cut", "_retry_notice": True},
            {"role": "assistant", "content": "Done."},
        ]
        backend = object.__new__(_Recorder)
        backend.agent = types.SimpleNamespace(messages=messages)
        items = backend._history()
        shape = [item.get("marker") or item.get("type") or item.get("role") for item in items]
        self.assertEqual(shape, [
            "turn_start",
            "h1:think1:after=False", "text_delta", "stream_end", "h1:think2:after=True", "tool_call",
            "before_result", "tool_result", "after_result",
            "orphan4", "decision:h1",
            "retry",
            "text_delta", "stream_end",
            "turn_end",
            "notice",
        ])
        self.assertEqual(items[2]["text"], "Let me look.", "display text passes through the hook")
        self.assertEqual(backend.indices, list(range(len(messages))))
        self.assertEqual(backend.notice_turns, ["h1"], "a stream-recovery notice opens no turn")
        self.assertEqual(backend.calls, ["begin_images", "begin_reasoning",
                                         ("finish_reasoning", "turn_end"),
                                         ("finish_images", "reasoning pass")])

    def test_a_notice_or_decision_with_no_open_turn_opens_exactly_one(self):
        messages = [{"role": "user", "content": "retry", "_retry_notice": True},
                    {"role": "user", "content": "<tool_results>\nok\n</tool_results>", "_dgc_decision": [{}]},
                    {"role": "assistant", "content": "answer"}]
        items = replay(messages, _Recorder)
        shape = [item.get("marker") or item.get("type") or item.get("role") for item in items]
        self.assertEqual(shape, ["turn_start", "retry", "decision:h1", "text_delta", "stream_end",
                                 "turn_end", "notice"])
        # Without a recorded decision a <tool_results> message stays a silent turn fragment.
        plain = [{"role": "user", "content": "<tool_results>\nok\n</tool_results>"}]
        self.assertEqual(replay(plain, _Recorder), [{"role": "notice", "text": "reasoning pass"}])

    def test_turn_finished_hook_decides_the_reason(self):
        class Finisher(_Recorder):
            def _history_reasoning_items(self, message, turn, *, after_text):
                turn["force_finished"] = True
                return []
        messages = [{"role": "user", "content": "ask me"},
                    {"role": "assistant", "content": "", "tool_calls": [_call("q", "propose_options", {})]}]
        items = replay(messages, Finisher)
        end = next(item for item in items if item.get("type") == "turn_end")
        self.assertEqual(end["reason"], "completed")
        self.assertEqual(replay(messages)[-1]["reason"], "cancelled")

    def test_mid_turn_items_name_every_replayable_fragment(self):
        self.assertEqual(_MID_TURN_ITEMS, (
            "text_delta", "thinking_delta", "thinking_end", "stream_end", "tool_call", "tool_result",
            "tool_denied", "tool_images", "options_resolved", "model_retry", "monitor_event",
            "turn_end"))
        webview = (Path(__file__).resolve().parents[1] / "editors" / "vscode" / "media" / "main.js").read_text()
        replayable = webview.split("const REPLAYABLE = new Set([", 1)[1].split("]);", 1)[0]
        self.assertEqual([part.strip().strip('"') for part in replayable.split(",")],
                         ["turn_start", *_MID_TURN_ITEMS])


if __name__ == "__main__":
    unittest.main()


class LiveAndReplayArgsTests(unittest.TestCase):
    """A replayed tool card gets the arguments a live one got: the JSON type of every argument (an
    array stays an array, a JSON-encoded array stays that string) and the summary live computed."""

    def test_tool_call_args_and_summary_match_live(self):
        import tempfile
        from test_subagents import Harness
        from dgc.llm import ChatResult, ToolCall
        questions = [{"header": f"Q{n}", "question": f"Which option for part {n}?" + " Context." * 20,
                      "options": [{"label": "Alpha", "description": "The first choice, explained at length."},
                                  {"label": "Beta", "description": "The second choice, explained at length."}]}
                     for n in range(4)]
        encoded = json.dumps(questions)
        self.assertGreater(len(encoded), 1000, "long enough to be bounded on replay")
        calls = [ToolCall("c1", "propose_options", {"questions": encoded}),
                 ToolCall("c2", "todo", {"todos": [{"content": "Pick storage", "status": "in_progress"},
                                                   {"content": "Write sync", "status": "pending"}]}),
                 ToolCall("c3", "multi_edit", {"path": "a.py", "edits": [{"old_string": "a", "new_string": "b"}],
                                               "nested": {"deep": [1, 2, {"x": True, "y": None}]}})]

        def route(messages, results, cancel):
            return ChatResult(content="done") if results else ChatResult(tool_calls=calls)

        with tempfile.TemporaryDirectory(prefix="dgc-history-args-") as directory:
            harness = Harness(Path(directory))
            try:
                harness.answer("options_request", {"answers": {"q1": {"selected": [0], "other": ""}}})
                harness.run("go", [("go", route)])
                live = {f["call_id"]: f for f in harness.of("tool_call")}
                replay = {i["call_id"]: i for i in harness.backend._history() if i.get("type") == "tool_call"}
            finally:
                harness.close()
        self.assertEqual(set(live), {"c1", "c2", "c3"})
        for call_id in ("c2", "c3"):
            self.assertEqual(replay[call_id]["args"], live[call_id]["args"], call_id)
            self.assertEqual(replay[call_id]["summary"], live[call_id]["summary"], call_id)
        self.assertIsInstance(replay["c2"]["args"]["todos"], list, "an array argument replays as an array")
        self.assertEqual(replay["c1"]["summary"], live["c1"]["summary"])
        self.assertTrue(live["c1"]["summary"].startswith("4 questions · Q0"), live["c1"]["summary"])
        self.assertIsInstance(replay["c1"]["args"]["questions"], str, "a JSON-encoded array stays a string")
        self.assertTrue(encoded.startswith(replay["c1"]["args"]["questions"].rstrip("…")))
