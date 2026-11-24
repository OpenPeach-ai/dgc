"""A reopened chat gets the most recent 1 MB of its history (Backend._history). When that cut falls inside a turn, the
payload starts with that turn's own start, so the editor draws it as the turn it is: its prompt, what is left of its
work folded under one row, its answer.

Found 24 Nov on a goal session: the cut stopped at a saved time marker in the middle of a 316-step turn, so the editor
got the turn's last steps with no turn above them, drew them a page at a time, and each page ended "Worked" with its
steps left open and no answer.
"""
import copy
import json
import types
import unittest

from dgc.headless import Backend, _MID_TURN_ITEMS

AT = 1_763_000_000.0


def _call(call_id, name, arguments):
    return {"id": call_id, "type": "function", "function": {"name": name, "arguments": json.dumps(arguments)}}


def replay(messages):
    backend = object.__new__(Backend)
    backend.agent = types.SimpleNamespace(messages=copy.deepcopy(messages))
    return backend._history()


def full(messages):
    backend = object.__new__(Backend)
    backend.agent = types.SimpleNamespace(messages=copy.deepcopy(messages))
    return backend._history(bounded=False)


def session(big_turn_steps=200, after=3):
    """Three small turns, one long goal turn (every message saved with its time), then `after` small turns."""
    messages = [{"role": "system", "content": "s"}]
    for i in range(3):
        messages += [{"role": "user", "content": f"early prompt {i}", "_dgc_at": AT + i},
                     {"role": "assistant", "content": f"early answer {i}", "_dgc_at": AT + i + 0.5}]
    messages.append({"role": "user", "content": "Rebuild the dashboard", "_dgc_at": AT + 10})
    for i in range(big_turn_steps):
        messages.append({"role": "assistant", "content": f"Checking part {i}. " + "w" * 2000, "_dgc_at": AT + 11 + i,
                         "tool_calls": [_call(f"call_{i}", "bash", {"command": "x" * 6000})]})
        messages.append({"role": "tool", "tool_call_id": f"call_{i}", "content": "o" * 8000})
    messages.append({"role": "assistant", "content": "The dashboard is rebuilt.", "_dgc_at": AT + 200})
    for i in range(after):
        messages += [{"role": "user", "content": f"later prompt {i}", "_dgc_at": AT + 300 + i},
                     {"role": "assistant", "content": f"later answer {i}", "_dgc_at": AT + 300 + i + 0.5}]
    return messages


class CutTurnTests(unittest.TestCase):
    def test_a_cut_inside_a_turn_keeps_that_turns_start(self):
        messages = session()
        everything = full(messages)
        items = replay(messages)
        self.assertLess(len(items), len(everything), "the session is over the payload's size: it was cut")
        self.assertEqual(items[0].get("role"), "notice")
        start = items[1]
        self.assertEqual(start.get("type"), "turn_start", "the cut turn opens with its own start")
        self.assertEqual(start["prompt"], "Rebuild the dashboard")
        original = next(i for i in everything if i.get("type") == "turn_start" and i.get("prompt") == "Rebuild the dashboard")
        self.assertEqual(start, original, "the same start the whole history has: its id, its kind")
        end = next(i for i in items if i.get("type") == "turn_end" and i.get("turn_id") == start["turn_id"])
        self.assertEqual(end["reason"], "completed")
        self.assertTrue(end["final_message_id"], "its answer is still its answer")
        answer_at = next(n for n, i in enumerate(items) if i.get("type") == "stream_end"
                         and i.get("message_id") == end["final_message_id"])
        said = next(i for i in reversed(items[:answer_at]) if i.get("type") == "text_delta")
        self.assertEqual(said["text"], "The dashboard is rebuilt.")
        self.assertLessEqual(len(json.dumps(items, ensure_ascii=True)), 1_000_000 + 4096, "still one bounded payload")

    def test_nothing_before_the_first_start_belongs_to_a_turn(self):
        items = replay(session())
        first = next(n for n, i in enumerate(items) if i.get("type") == "turn_start")
        for item in items[:first]:
            self.assertNotIn(item.get("type"), _MID_TURN_ITEMS)
            self.assertNotIn(item.get("role"), ("time", "steering"))

    def test_a_cut_between_turns_copies_no_start(self):
        items = full(session(big_turn_steps=3, after=2))
        starts = [n for n, i in enumerate(items) if i.get("type") == "turn_start"]
        cut = Backend._history_cut_turn_start
        self.assertIsNone(cut(items, starts[2]), "the cut falls on a turn's start: nothing to copy")
        self.assertEqual(items[starts[2] - 1].get("type"), "turn_end")
        self.assertEqual(cut(items, starts[2] - 1), items[starts[1]], "a cut that keeps only a turn's end is inside it")
        self.assertEqual(cut(items, starts[2] + 2), items[starts[2]], "inside the turn: its start")
        self.assertIsNone(cut(items, 0))
        self.assertIsNone(cut(items, len(items)))
        small = session(big_turn_steps=5, after=0)
        self.assertEqual(replay(small), full(small), "a session under the payload's size is sent whole, as before")

    def test_the_turn_still_running_keeps_its_live_id(self):
        messages = session(after=0)
        messages.pop()                                  # its answer isn't written yet: the turn is running
        anchor_index = next(n for n, m in enumerate(messages) if m.get("content") == "Rebuild the dashboard") - 1
        backend = object.__new__(Backend)
        backend.agent = types.SimpleNamespace(messages=messages)
        items = backend._history({"id": "t42", "anchor": messages[anchor_index]})
        start = next(i for i in items if i.get("type") == "turn_start")
        self.assertEqual(start["turn_id"], "t42")
        self.assertEqual(start["prompt"], "Rebuild the dashboard")
        self.assertFalse([i for i in items if i.get("type") == "turn_end" and i.get("turn_id") == "t42"],
                         "the live turn ends when it ends, not in the replay")


if __name__ == "__main__":
    unittest.main()
