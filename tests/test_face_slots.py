"""Sub-agents working at the same time never wear the same face.

The panel picked a face by hashing the agent's id, so two agents running at once matched one time in
eight, and three at once a third of the time. The registry now hands each starting agent the lowest
face slot no working agent of the chat holds, keeps it for the agent's life and saves it with the
chat; the panel draws that slot. `dgc serve` sends it only to a client that asked
(set_workspace_roots.agent_faces): an undeclared field fails an older client's whole session.
"""
from __future__ import annotations

import copy
import json
import sys
import threading
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from dgc import editor_protocol as ep  # noqa: E402
from dgc.llm import ToolCall  # noqa: E402
from dgc.subagents import SubagentRegistry, model_view  # noqa: E402
from test_subagents import HarnessCase, calls_then, child  # noqa: E402


def sid(n: int) -> str:
    return f"sub-{n:012x}"


class Registry:
    """A registry that remembers the face slot each `started` frame carried."""

    def __init__(self):
        self.slots: dict[str, int] = {}
        self.registry = SubagentRegistry(self._listen)

    def _listen(self, kind, payload):
        if kind == "started":
            self.slots[payload["id"]] = payload.get("face_slot")

    def start(self, n, turn="t1", **fields):
        self.registry.start(id=sid(n), description=f"agent {n}", turn_hint=turn, **fields)
        return self.slots[sid(n)]

    def end(self, n, state="finished"):
        self.registry.end(sid(n), state)


class FaceSlotRegistryTests(unittest.TestCase):
    def test_working_agents_take_the_lowest_free_slot(self):
        reg = Registry()
        self.assertEqual([reg.start(n) for n in range(4)], [0, 1, 2, 3])
        reg.end(1)
        self.assertEqual(reg.start(4, turn="t2"), 1, "a finished agent's face is free again")

    def test_a_turns_agents_differ_even_one_after_another(self):
        reg = Registry()
        slots = []
        for n in range(3):
            slots.append(reg.start(n))
            reg.end(n)
        self.assertEqual(slots, [0, 1, 2], "every serial agent of a turn wore the same face")
        self.assertEqual(reg.start(3, turn="t2"), 0, "a new turn starts again from the first face")

    def test_more_than_eight_working_repeat_the_least_held(self):
        reg = Registry()
        self.assertEqual([reg.start(n) for n in range(10)], [0, 1, 2, 3, 4, 5, 6, 7, 0, 1])
        for n in range(8):
            reg.end(n)
        self.assertEqual(reg.start(10), 2)

    def test_two_starting_at_once_never_share(self):
        for _ in range(100):
            reg = Registry()
            barrier = threading.Barrier(8)

            def go(n):
                barrier.wait()
                reg.start(n)
            threads = [threading.Thread(target=go, args=(n,)) for n in range(8)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(5)
            self.assertEqual(sorted(reg.slots.values()), list(range(8)))

    def test_a_background_agent_keeps_its_slot_past_the_turn(self):
        reg = Registry()
        self.assertEqual(reg.start(0, background=True), 0)
        self.assertEqual(reg.start(1), 1)
        reg.registry.end_open("stopped", "turn ended")      # the turn's own children end with it
        self.assertEqual(reg.start(2, turn="t2"), 1, "the background agent still wears its face")

    def test_nested_agents_differ(self):
        reg = Registry()
        self.assertEqual(reg.start(0), 0)
        self.assertEqual(reg.start(1, parent_id=sid(0), depth=2), 1)
        self.assertEqual(reg.start(2, parent_id=sid(1), depth=3), 2)

    def test_slots_survive_save_and_restore(self):
        reg = Registry()
        reg.start(0)
        reg.start(1)
        saved = json.loads(json.dumps(reg.registry.saved_state()))
        self.assertEqual([item["face_slot"] for item in saved["items"]], [0, 1])
        again = Registry()
        self.assertTrue(again.registry.restore_state(saved))
        items = again.registry.snapshot()["items"]
        self.assertEqual([(item["face_slot"], item["state"]) for item in items],
                         [(0, "stopped"), (1, "stopped")])
        self.assertEqual(again.start(5), 0, "a restored agent is not working and holds nothing")

    def test_a_saved_slot_that_is_not_a_slot_is_dropped(self):
        for bad in (True, -1, 8, "1", 1.0):
            with self.subTest(bad=bad):
                reg = SubagentRegistry()
                reg.restore_state({"version": 1, "items": [
                    {"id": sid(1), "state": "finished", "description": "x", "face_slot": bad}]})
                self.assertNotIn("face_slot", reg.snapshot()["items"][0])

    def test_a_reset_frees_every_slot(self):
        reg = Registry()
        reg.start(0)
        reg.registry.reset()
        self.assertEqual(reg.start(1), 0)

    def test_the_model_never_sees_a_face(self):
        reg = Registry()
        reg.start(0)
        self.assertNotIn("face", model_view(reg.registry.snapshot()))


class FaceSlotWireTests(HarnessCase):
    """`dgc serve`: the slot reaches only a client that asked for it."""

    def batch(self, h, n=4):
        calls = [ToolCall(f"p{i}", "task", {"description": f"part {i}", "prompt": f"CHILD{i} work"})
                 for i in range(n)]
        h.run("split", [*[(f"CHILD{i}", child()) for i in range(n)], ("split", calls_then(calls))])

    def test_a_client_that_did_not_ask_never_sees_a_slot(self):
        h = self.make(git=True, max_parallel_tasks=4)
        self.batch(h)
        h.backend._emit_agents()
        frames = h.of("agent_started", "agents")
        self.assertTrue(frames)
        self.assertFalse([f for f in h.of("agent_started") if "face_slot" in f])
        self.assertFalse([i for f in h.of("agents") for i in f["items"] if "face_slot" in i])
        # The 0.46-era table: what SDK 0.6.9 and extension 0.31 validate against.
        old = copy.deepcopy(ep.EVENT_FIELDS)
        old["agent_started"].pop("face_slot")
        for frame in h.stream.frames():
            if frame["type"] in ("agent_started", "agent_updated", "agent_ended"):
                self.assertIsNone(ep._message_error(frame, old, sequence=True), frame)

    def test_a_client_that_asked_gets_a_different_face_for_each_agent_at_work(self):
        h = self.make(git=True, max_parallel_tasks=4)
        h.ui._agent_faces_enabled = True
        self.batch(h)
        self.assertEqual(sorted(f["face_slot"] for f in h.of("agent_started")), [0, 1, 2, 3])
        h.backend._emit_agents()
        snapshot = h.of("agents")[-1]
        self.assertEqual(sorted(item["face_slot"] for item in snapshot["items"]), [0, 1, 2, 3])
        self.assertFramesValid(h)

    def test_the_handshake_command_opts_a_chat_in(self):
        h = self.make(git=True)
        h.backend.dispatch({"type": "set_workspace_roots", "roots": [str(h.root)], "request_id": "a"})
        self.assertFalse(h.backend._agent_faces_on())
        h.backend.dispatch({"type": "set_workspace_roots", "roots": [str(h.root)], "agent_faces": True,
                            "request_id": "b"})
        self.assertTrue(h.backend._agent_faces_on(), "the opt-in never reached the chat")
        self.assertIsNone(ep.command_error({"type": "set_workspace_roots", "roots": [str(h.root)],
                                            "agent_faces": True, "request_id": "r"}))
        self.assertIsNotNone(ep.event_error({"type": "agent_started", "seq": 0, "id": sid(1),
                                             "parent_id": None, "call_id": None, "description": "x",
                                             "depth": 1, "state": "running", "started_at": 1.0,
                                             "isolated": False, "parallel": False,
                                             "face_slot": "1"}),
                             "a slot is an integer")


if __name__ == "__main__":
    unittest.main()
