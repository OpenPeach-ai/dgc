"""The Agent map's backend: background shells and task output on the wire, and Stop on ONE foreground
sub-agent without ending the turn.

The fixed interface is AGENT_MAP_CONTRACT.md: ready.capabilities.background_tasks and
agent_control_foreground; the events background_shells and background_output; the commands
list_background_shells, stop_background_shell and get_background_output. Shells and monitors here
are real processes, and the sub-agents are real Agent runs on a scripted model, driven through a
real `Backend` whose every frame goes through the protocol validator on its way to the wire.
"""
from __future__ import annotations

import io
import json
import os
import re
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from test_subagents import Script, clone_fixture, fixture_config, git_repo  # noqa: E402

from dgc import editor_protocol as ep
from dgc import headless, tools
from dgc.agent import Agent, _ChatToolResources, _ChildStop
from dgc.config import Config
from dgc.headless import Backend
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.monitors import MonitorHub

SECRET = "agent-map-secret-value-0123456789abcdef"


class Wire(io.TextIOBase):
    """What `dgc serve` writes to stdout, one parsed frame per line."""

    def __init__(self):
        self.frames: list[dict] = []
        self.condition = threading.Condition()

    def write(self, text):
        for line in str(text).splitlines():
            if line.strip():
                with self.condition:
                    self.frames.append(json.loads(line))
                    self.condition.notify_all()
        return len(text)

    def flush(self):
        pass

    def of(self, kind: str) -> list[dict]:
        with self.condition:
            return [frame for frame in self.frames if frame["type"] == kind]

    def wait(self, predicate, timeout: float = 10.0):
        with self.condition:
            self.condition.wait_for(lambda: any(predicate(f) for f in self.frames), timeout)
            return next((f for f in self.frames if predicate(f)), None)


def started_id(out: str) -> str:
    match = re.search(r"started background task (bg\d+)", out)
    assert match, out
    return match.group(1)


def wait_for(predicate, timeout: float = 10.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = predicate()
        if value:
            return value
        time.sleep(0.02)
    return predicate()


def group_gone(pgid: int) -> bool:
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return True
    except PermissionError:
        return False
    return False


def shells(frame: dict) -> dict:
    return {item["id"]: item for item in frame["items"]}


class BackendCase(unittest.TestCase):
    def make(self, *, trusted=True, git=False, **data):
        directory = tempfile.TemporaryDirectory(prefix="dgc-agent-map-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        if git:
            git_repo(root)
            data.setdefault("subagent_worktree_root", str(root.parent / (root.name + "-worktrees")))
        # The fixture's own default is auto, which an untrusted chat holds back to default.
        data.setdefault("mode", "default")
        config = fixture_config(root, **data)
        wire = Wire()
        with patch("dgc.trust.is_trusted", return_value=trusted), patch.object(sys, "stdout", wire):
            backend = Backend(config)
        self.addCleanup(self.teardown_backend, backend)
        return backend, wire

    @staticmethod
    def teardown_backend(backend):
        backend._background_shells_on = False
        timer = getattr(backend, "_background_timer", None)
        if timer is not None:
            timer.cancel()
        for owner in backend._chat_tool_owners():
            tools.shutdown_background(owner)
        for hub in backend._chat_monitor_hubs():
            hub.shutdown(wait=3.0)
        try:
            backend.agent.stop_detached()
        finally:
            backend.agent.mcp.stop_all()

    def shell(self, backend, command: str, ctx=None) -> str:
        bid = started_id(tools.bash({"command": command, "background": True},
                                    ctx if ctx is not None else backend.agent.ctx))
        return bid

    def finished(self, bid: str, timeout: float = 10.0) -> bool:
        return bool(wait_for(lambda: tools._BG.get(bid, {}).get("finished") is not None, timeout))

    def answer(self, wire, kind: str, request_id: str, timeout: float = 10.0) -> dict:
        frame = wire.wait(lambda f: f["type"] in (kind, "command_rejected")
                          and f.get("request_id") == request_id, timeout)
        self.assertIsNotNone(frame, (kind, request_id, wire.frames[-5:]))
        return frame


# ---------------------------------------------------------------------------------------------------
# The contract itself
# ---------------------------------------------------------------------------------------------------
class ContractTests(BackendCase):
    def test_ready_advertises_both_capabilities(self):
        backend, _wire = self.make()
        ready = backend._ready_payload()
        self.assertIsNone(ep.event_error({"type": "ready", "seq": 0, **ready}))
        self.assertEqual(ready["capabilities"]["background_tasks"], {"version": 1})
        self.assertIs(ready["capabilities"]["agent_control_foreground"], True)

    def test_the_two_events_and_three_commands_are_declared_exactly(self):
        self.assertEqual(ep.EVENT_FIELDS["background_shells"].keys(), {"items", "request_id"})
        self.assertEqual(ep.EVENT_FIELDS["background_output"].keys(),
                         {"request_id", "id", "output", "total_bytes", "truncated"})
        self.assertFalse(ep.EVENT_FIELDS["background_shells"]["request_id"]["required"])
        self.assertTrue(ep.EVENT_FIELDS["background_output"]["request_id"]["required"])
        self.assertIsNone(ep.command_error({"type": "list_background_shells"}))
        self.assertIsNone(ep.command_error({"type": "stop_background_shell", "id": "bg1"}))
        self.assertIsNone(ep.command_error({"type": "get_background_output", "id": "bg1",
                                            "request_id": "r", "max_bytes": 10}))
        self.assertIsNotNone(ep.command_error({"type": "stop_background_shell"}))
        self.assertIsNotNone(ep.command_error({"type": "get_background_output", "id": "bg1"}))
        self.assertIsNotNone(ep.command_error({"type": "get_background_output", "id": "bg1",
                                               "request_id": "r", "max_bytes": "10"}))
        self.assertIsNotNone(ep.event_error({"type": "background_shells", "seq": 0, "items": [],
                                             "extra": 1}))

    def test_the_commands_are_gated_exactly_like_stop_monitor(self):
        for name in ("list_background_shells", "stop_background_shell", "get_background_output"):
            for table in ("_WAKE_NEUTRAL_COMMANDS", "_OPTIONALLY_CORRELATED_COMMANDS", "_BUSY_MUTATIONS"):
                with self.subTest(command=name, table=table):
                    members = getattr(headless, table)
                    self.assertEqual(name in members, "stop_monitor" in members)


# ---------------------------------------------------------------------------------------------------
# Background shells
# ---------------------------------------------------------------------------------------------------
class BackgroundShellTests(BackendCase):
    def test_a_client_that_never_asked_is_never_sent_the_event(self):
        backend, wire = self.make()
        bid = self.shell(backend, "sleep 30")
        quick = self.shell(backend, "true")
        self.assertTrue(self.finished(quick))
        time.sleep(0.6)                                    # past the 0.25 s coalescing window
        self.assertEqual(wire.of("background_shells"), [],
                         "an older extension would show 'skipped a backend event' for it")
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        listed = shells(self.answer(wire, "background_shells", "l1"))
        self.assertEqual(listed[bid]["state"], "running")
        self.assertEqual(listed[quick]["state"], "exited")

    def test_the_list_carries_every_field_with_a_redacted_label(self):
        backend, wire = self.make(api_key=SECRET)
        bid = self.shell(backend, f"echo {SECRET}; sleep 30")
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        frame = self.answer(wire, "background_shells", "l1")
        self.assertIsNone(ep.event_error({"seq": 0, **frame}))
        item = shells(frame)[bid]
        self.assertEqual(set(item), {"id", "command", "state", "started_at", "ended_at", "exit_code",
                                     "agent_id"})
        self.assertNotIn(SECRET, item["command"])
        self.assertIn("[REDACTED]", item["command"])
        self.assertTrue(item["command"].endswith("sleep 30"), item["command"])
        self.assertEqual((item["state"], item["ended_at"], item["exit_code"], item["agent_id"]),
                         ("running", None, None, None))
        self.assertAlmostEqual(item["started_at"], time.time(), delta=30)
        self.assertNotIn(SECRET, json.dumps(wire.frames))

    def test_the_list_is_pushed_when_a_shell_starts_ends_or_is_killed(self):
        backend, wire = self.make()
        ctx = backend.agent.ctx
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        self.answer(wire, "background_shells", "l1")

        def pushed(bid, **want):
            return wire.wait(lambda f: f["type"] == "background_shells" and "request_id" not in f
                             and bid in shells(f)
                             and all(shells(f)[bid][k] == v for k, v in want.items()))

        long_running = self.shell(backend, "sleep 30")
        self.assertIsNotNone(pushed(long_running, state="running"), "start")
        exits = self.shell(backend, "sleep 0.4; exit 3")
        ended = pushed(exits, state="exited", exit_code=3)
        self.assertIsNotNone(ended, "exit")
        self.assertIsInstance(shells(ended)[exits]["ended_at"], float)
        self.assertIn("killed", tools.bash_kill({"id": long_running}, ctx))     # the model's kill
        killed = wire.wait(lambda f: f["type"] == "background_shells" and "request_id" not in f
                           and shells(f).get(long_running, {}).get("state") == "killed"
                           and shells(f)[long_running]["ended_at"] is not None)
        self.assertIsNotNone(killed, "kill")
        self.assertIsInstance(shells(killed)[long_running]["exit_code"], int)
        for frame in wire.of("background_shells"):
            self.assertIsNone(ep.event_error({"seq": 0, **frame}), frame)

    def test_stop_kills_the_whole_group_and_never_blocks_the_command_loop(self):
        backend, wire = self.make()
        # Ignores SIGTERM, so a stop that waited for the reap would hold the loop for 2 s or more.
        bid = self.shell(backend, "trap '' TERM; sleep 300 & echo armed; wait")
        pgid = tools._BG[bid]["proc"].pid
        self.assertTrue(wait_for(lambda: "armed" in "".join(tools._BG[bid]["buf"]), 5),
                        "premise: the shell ignores SIGTERM before it is stopped")
        started = time.monotonic()
        backend.dispatch({"type": "stop_background_shell", "id": bid, "request_id": "s1"})
        reply = self.answer(wire, "background_shells", "s1")
        self.assertLess(time.monotonic() - started, 1.0,
                        "dgc serve dispatches on the thread that reads stdin: a stop that waits "
                        "stalls every later command, cancel included")
        self.assertEqual(reply["type"], "background_shells")
        self.assertEqual(shells(reply)[bid]["state"], "killed")
        self.assertTrue(wait_for(lambda: group_gone(pgid), 8), "the process group is still alive")
        reaped = wire.wait(lambda f: f["type"] == "background_shells" and "request_id" not in f
                           and shells(f).get(bid, {}).get("ended_at") is not None, 8)
        self.assertIsNotNone(reaped)
        self.assertEqual(shells(reaped)[bid]["state"], "killed")
        # A second Stop on an ended shell is not an error: it gets the list back.
        backend.dispatch({"type": "stop_background_shell", "id": bid, "request_id": "s2"})
        self.assertEqual(self.answer(wire, "background_shells", "s2")["type"], "background_shells")
        self.assertFalse(wire.of("command_rejected"))

    def test_unknown_ids_and_another_chats_shell_are_rejected(self):
        backend, wire = self.make()
        foreign = types.SimpleNamespace(project_root=backend.config.project_root,
                                        config=backend.config, tool_owner="another-chat",
                                        cancelled=None, monitors=None)
        self.addCleanup(tools.shutdown_background, "another-chat")
        theirs = self.shell(backend, "echo theirs; sleep 30", ctx=foreign)
        for command, extra in (("stop_background_shell", {}), ("get_background_output", {})):
            for target in ("bg999999", theirs):
                with self.subTest(command=command, target=target):
                    rid = f"{command}-{target}"
                    backend.dispatch({"type": command, "id": target, "request_id": rid, **extra})
                    frame = wire.wait(lambda f: f.get("request_id") == rid)
                    self.assertEqual(frame["type"], "command_rejected", frame)
                    self.assertEqual(frame["reason"], "unknown_task")
        self.assertIsNone(tools._BG[theirs]["finished"], "another chat's shell was stopped")
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        self.assertNotIn(theirs, shells(self.answer(wire, "background_shells", "l1")))

    def test_a_sub_agents_shell_carries_its_agent_id(self):
        backend, wire = self.make()
        resources = backend.agent.__dict__.setdefault("_chat_tool_resources", _ChatToolResources())
        hub = MonitorHub("child-owner", backend.config, backend.config.project_root)
        child = types.SimpleNamespace(ctx=types.SimpleNamespace(tool_owner="child-owner"),
                                      monitors=hub, _subagent_id="sub-0123456789ab")
        self.assertTrue(resources.add(child))
        child_ctx = types.SimpleNamespace(project_root=backend.config.project_root,
                                          config=backend.config, tool_owner="child-owner",
                                          cancelled=None, monitors=hub)
        bid = self.shell(backend, "sleep 30", ctx=child_ctx)
        mine = self.shell(backend, "sleep 30")
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        listed = shells(self.answer(wire, "background_shells", "l1"))
        self.assertEqual(listed[bid]["agent_id"], "sub-0123456789ab")
        self.assertIsNone(listed[mine]["agent_id"])
        # ...and its monitors' output is served too.
        out = hub.start({"command": "echo child-monitor-line; sleep 30", "description": "child"},
                        child_ctx)
        mid = out.split()[2]
        self.assertTrue(wait_for(lambda: hub.get(mid).lines_total >= 1))
        backend.dispatch({"type": "get_background_output", "id": mid, "request_id": "o1"})
        self.assertIn("child-monitor-line", self.answer(wire, "background_output", "o1")["output"])

    def test_a_real_sub_agent_run_reports_the_shell_it_started(self):
        backend, wire = self.make(mode="auto")
        backend.dispatch({"type": "list_background_shells", "request_id": "l0"})
        self.answer(wire, "background_shells", "l0")

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {
                    "description": "start the server", "prompt": "CHILD start it"})])
            return ChatResult(content="The child started it.")

        def child(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("c1", "bash", {
                    "command": "sleep 30", "background": True})])
            return ChatResult(content="Started the server in the background.")

        with patch.object(LLMClient, "chat", Script([("CHILD", child), ("PARENT", parent)])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            backend.dispatch({"type": "prompt", "text": "PARENT go", "request_id": "p1"})
            end = wire.wait(lambda f: f["type"] == "turn_end", 30)
        self.assertEqual(end["reason"], "completed", wire.of("error"))
        agent_id = wire.wait(lambda f: f["type"] == "agent_started")["id"]
        pushed = wire.wait(lambda f: f["type"] == "background_shells" and "request_id" not in f
                           and any(i["agent_id"] == agent_id for i in f["items"]))
        self.assertIsNotNone(pushed, "the child's shell was not pushed while the turn ran")
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        mine = [i for i in self.answer(wire, "background_shells", "l1")["items"]
                if i["agent_id"] == agent_id]
        self.assertEqual([(i["command"], i["state"]) for i in mine], [("sleep 30", "running")],
                         "the shell outlives the child that started it")

    def test_a_reset_chat_drops_ended_shells_and_keeps_running_ones(self):
        backend, wire = self.make()
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        self.answer(wire, "background_shells", "l1")
        done = self.shell(backend, "true")
        running = self.shell(backend, "sleep 30")
        self.assertTrue(self.finished(done))
        backend.dispatch({"type": "list_background_shells", "request_id": "l2"})
        self.assertIn(done, shells(self.answer(wire, "background_shells", "l2")))
        count = len(wire.frames)
        backend.dispatch({"type": "clear_session", "request_id": "c1"})
        after = wire.wait(lambda f: f["type"] == "background_shells"
                          and wire.frames.index(f) >= count)
        self.assertIsNotNone(after)
        self.assertEqual(list(shells(after)), [running])

    def test_an_ended_shell_stays_listed_after_its_output_is_reaped(self):
        backend, wire = self.make()
        bid = self.shell(backend, "exit 4")
        self.assertTrue(self.finished(bid))
        tools._reap_background(now=time.time() + tools._BG_RETAIN_S + 60)   # 30 minutes on
        self.assertNotIn(bid, tools._BG)
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        item = shells(self.answer(wire, "background_shells", "l1"))[bid]
        self.assertEqual((item["state"], item["exit_code"]), ("exited", 4))
        backend.dispatch({"type": "get_background_output", "id": bid, "request_id": "o1"})
        frame = self.answer(wire, "background_output", "o1")
        self.assertEqual((frame["type"], frame["reason"]), ("command_rejected", "unknown_task"))
        self.assertIn("no longer kept", frame["message"])


# ---------------------------------------------------------------------------------------------------
# Task output
# ---------------------------------------------------------------------------------------------------
class BackgroundOutputTests(BackendCase):
    def test_a_shells_output_whole_and_capped(self):
        backend, wire = self.make()
        bid = self.shell(backend, "seq -f 'line-%g' 1 3000")
        self.assertTrue(self.finished(bid))
        full = "".join(f"line-{n}\n" for n in range(1, 3001))
        backend.dispatch({"type": "get_background_output", "id": bid, "request_id": "o1"})
        whole = self.answer(wire, "background_output", "o1")
        self.assertIsNone(ep.event_error({"seq": 0, **whole}))
        self.assertEqual((whole["id"], whole["output"], whole["total_bytes"], whole["truncated"]),
                         (bid, full, len(full.encode()), False))
        backend.dispatch({"type": "get_background_output", "id": bid, "request_id": "o2",
                          "max_bytes": 100})
        tail = self.answer(wire, "background_output", "o2")
        self.assertLessEqual(len(tail["output"].encode()), 100)
        self.assertTrue(full.endswith(tail["output"]) and tail["output"].endswith("line-3000\n"))
        self.assertEqual((tail["total_bytes"], tail["truncated"]), (len(full.encode()), True))

    def test_total_bytes_counts_what_the_buffer_has_dropped(self):
        backend, wire = self.make()
        bid = self.shell(backend, "seq -f 'line-%g' 1 20000")
        self.assertTrue(self.finished(bid))
        full = "".join(f"line-{n}\n" for n in range(1, 20001))
        self.assertGreater(len(full), tools._BG_BUFFER_CHARS)
        backend.dispatch({"type": "get_background_output", "id": bid, "request_id": "o1",
                          "max_bytes": 5 * 1024 * 1024})            # past the cap: capped, not refused
        frame = self.answer(wire, "background_output", "o1")
        self.assertEqual(frame["type"], "background_output")
        self.assertEqual(frame["output"], full[-tools._BG_BUFFER_CHARS:])
        self.assertEqual((frame["total_bytes"], frame["truncated"]), (len(full.encode()), True))

    def test_a_monitors_output_stdout_then_stderr(self):
        backend, wire = self.make()
        hub = backend.agent.monitors
        out = hub.start({"command": "echo mon-a; echo mon-b; echo oops >&2; sleep 30",
                         "description": "watch", "persistent": True}, backend.agent.ctx)
        mid = out.split()[2]
        self.assertTrue(wait_for(lambda: hub.get(mid).lines_total >= 2
                                 and "oops" in hub.get(mid).ring_err.text()))
        backend.dispatch({"type": "get_background_output", "id": mid, "request_id": "o1"})
        frame = self.answer(wire, "background_output", "o1")
        self.assertEqual(frame["type"], "background_output", frame)
        self.assertEqual(frame["output"], "mon-a\nmon-b\n[stderr]\noops\n")
        self.assertFalse(frame["truncated"])
        self.assertGreaterEqual(frame["total_bytes"], len("mon-a\nmon-b\noops\n"))

    def test_output_is_redacted_on_the_wire(self):
        backend, wire = self.make(api_key=SECRET)
        bid = self.shell(backend, f"echo before {SECRET} after")
        self.assertTrue(self.finished(bid))
        backend.dispatch({"type": "get_background_output", "id": bid, "request_id": "o1"})
        frame = self.answer(wire, "background_output", "o1")
        self.assertEqual(frame["output"], "before [REDACTED] after\n")
        self.assertNotIn(SECRET, json.dumps(wire.frames))

    def test_the_handler_itself_redacts_a_secret_learned_after_the_shell_printed_it(self):
        """The wire's sanitizer is a second line; this proves the first. A key the user adds after a
        shell printed it is masked in both the output and the list's label."""
        backend, _wire = self.make()
        events = []

        def emit(kind, /, **fields):
            self.assertIsNone(ep.event_error({"type": kind, "seq": 0, **fields}), fields)
            events.append({"type": kind, **fields})
        backend.em = types.SimpleNamespace(emit=emit)            # no sanitizer behind it
        late = "late-token-abcdefghijklmnopqrstuvwxyz0123"
        bid = self.shell(backend, f"echo got {late}; sleep 30")
        self.assertTrue(wait_for(lambda: late in "".join(tools._BG[bid]["buf"])), "premise")
        backend.config.data["api_key"] = late
        backend.dispatch({"type": "get_background_output", "id": bid, "request_id": "o1"})
        backend.dispatch({"type": "list_background_shells", "request_id": "l1"})
        output = next(e for e in events if e["type"] == "background_output")
        listed = next(e for e in events if e["type"] == "background_shells")
        self.assertEqual(output["output"], "got [REDACTED]\n")
        self.assertNotIn(late, json.dumps(events))
        self.assertIn("[REDACTED]", shells(listed)[bid]["command"])

    def test_max_bytes_below_one_is_rejected(self):
        backend, wire = self.make()
        bid = self.shell(backend, "echo hi")
        for value in (0, -5):
            backend.dispatch({"type": "get_background_output", "id": bid, "request_id": f"m{value}",
                              "max_bytes": value})
            frame = self.answer(wire, "background_output", f"m{value}")
            self.assertEqual((frame["type"], frame["reason"]), ("command_rejected", "invalid_max_bytes"))

    def test_the_tail_fits_the_cap_a_frame_and_whole_characters(self):
        tail, cut = headless._output_tail("x" * 2_000_000, headless._BACKGROUND_OUTPUT_MAX_BYTES)
        self.assertEqual((len(tail), cut), (1 << 20, True))
        # JSON writes a control character as six bytes: a megabyte of them is ~6 MB on the wire.
        tail, cut = headless._output_tail("\x1b" * (1 << 20), 1 << 20)
        self.assertTrue(cut)
        self.assertLessEqual(len(json.dumps({"output": tail}, ensure_ascii=False).encode()),
                             ep.MAX_EVENT_BYTES * 0.9)
        tail, cut = headless._output_tail("é" * 100, 51)
        self.assertEqual((tail, cut), ("é" * 25, True))
        tail, cut = headless._output_tail("aaaa[REDACTED]tail", 12)
        self.assertEqual((tail, cut), ("tail", True), "never half a redaction marker")
        self.assertEqual(headless._output_tail("short", 100), ("short", False))


# ---------------------------------------------------------------------------------------------------
# Untrusted and busy chats: exactly what stop_monitor gets
# ---------------------------------------------------------------------------------------------------
class GatingTests(BackendCase):
    def test_untrusted_and_mid_turn_chats_are_answered_like_stop_monitor(self):
        backend, wire = self.make(trusted=False)
        self.assertFalse(backend.workspace_trusted, "premise: the fixture project is not trusted")
        bid = self.shell(backend, "sleep 30")
        backend._worker = threading.Thread(target=lambda: None)     # a turn is running
        self.addCleanup(setattr, backend, "_worker", None)
        self.assertTrue(backend._busy())
        backend.dispatch({"type": "stop_monitor", "id": "mon-none", "request_id": "m1"})
        self.assertEqual(self.answer(wire, "monitors", "m1")["type"], "monitors")
        for command, kind, extra in (
                ("list_background_shells", "background_shells", {}),
                ("get_background_output", "background_output", {"id": bid}),
                ("stop_background_shell", "background_shells", {"id": bid})):
            with self.subTest(command=command):
                backend.dispatch({"type": command, "request_id": command, **extra})
                self.assertEqual(self.answer(wire, kind, command)["type"], kind)
        self.assertFalse(wire.of("command_rejected"))

    def test_a_bad_request_id_is_refused_like_stop_monitors(self):
        backend, wire = self.make()
        for command, extra in (("stop_monitor", {"id": "x"}), ("stop_background_shell", {"id": "x"}),
                               ("list_background_shells", {}), ("get_background_output", {"id": "x"})):
            with self.subTest(command=command):
                before = len(wire.of("command_rejected"))
                backend.dispatch({"type": command, "request_id": "", **extra})
                rejected = wire.of("command_rejected")[before:]
                self.assertEqual([(f["command"], f["reason"]) for f in rejected],
                                 [(command, "invalid_request_id")])


# ---------------------------------------------------------------------------------------------------
# Stop ONE foreground sub-agent (step 7)
# ---------------------------------------------------------------------------------------------------
def blocks_until_stopped(entered: threading.Event, summary: str, first_tool=("ls", {"path": "."})):
    """A child that reports some progress, then works until it is stopped."""
    def route(messages, results, cancel):
        if not results:
            return ChatResult(content=summary, tool_calls=[ToolCall("c1", *first_tool)])
        entered.set()
        deadline = time.monotonic() + 20
        while not cancel.is_set() and time.monotonic() < deadline:
            time.sleep(0.01)
        return ChatResult(content="", finish_reason="stop")
    return route


class ForegroundStopTests(BackendCase):
    def run_prompt(self, backend, wire, routes, *, after_start=None, timeout=40):
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            backend.dispatch({"type": "prompt", "text": "PARENT go", "request_id": "p1"})
            if after_start is not None:
                after_start()
            end = wire.wait(lambda f: f["type"] == "turn_end", timeout)
            self.assertIsNotNone(end, "the turn never ended")
            self.assertTrue(wait_for(lambda: backend._worker is None, 10))
        return end

    def close(self, backend, wire, agent_id, request_id="stop1"):
        started = time.monotonic()
        backend.dispatch({"type": "agent_control", "action": "close", "id": agent_id,
                          "request_id": request_id})
        self.assertLess(time.monotonic() - started, 1.0, "agent_control must not wait")
        return self.answer(wire, "agents", request_id)

    def started(self, wire, description):
        return wire.wait(lambda f: f["type"] == "agent_started" and f["description"] == description)

    def ended(self, wire, agent_id):
        return wire.wait(lambda f: f["type"] == "agent_ended" and f["id"] == agent_id)

    def task_result(self, wire, call_id):
        return wire.wait(lambda f: f["type"] == "tool_result" and f.get("call_id") == call_id
                         and f["name"] == "task")

    def test_stopping_a_running_child_lets_the_parent_turn_carry_on(self):
        backend, wire = self.make(mode="auto")
        entered, rounds = threading.Event(), []

        def parent(messages, results, cancel):
            rounds.append(len(results))
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {
                    "description": "survey the code", "prompt": "CHILD survey"})])
            return ChatResult(content="Parent carried on after the stop.")

        def stop_it():
            self.assertTrue(entered.wait(15), "the child never got going")
            child = self.started(wire, "survey the code")
            ack = self.close(backend, wire, child["id"])
            self.assertEqual(ack["type"], "agents")

        end = self.run_prompt(backend, wire, [
            ("CHILD", blocks_until_stopped(entered, "Checked 3 of 5 modules so far.")),
            ("PARENT", parent)], after_start=stop_it)
        self.assertEqual(end["reason"], "completed")
        child = self.started(wire, "survey the code")
        ended = self.ended(wire, child["id"])
        self.assertEqual((ended["state"], ended.get("message")), ("stopped", "stopped by the user"))
        result = self.task_result(wire, "t1")
        self.assertTrue(result["output"].startswith("The user stopped sub-task 'survey the code'"),
                        result["output"])
        self.assertIn("Checked 3 of 5 modules so far.", result["output"])
        self.assertFalse(result["is_error"], "a Stop the user pressed is not a failed tool")
        self.assertEqual(rounds, [0, 1], "the parent's next model round saw the task result")
        self.assertEqual(backend.agent.messages[-1].get("content"), "Parent carried on after the stop.")
        self.assertFalse(backend.agent.cancelled.is_set(), "the turn itself was never stopped")
        self.assertFalse(wire.of("command_rejected"))
        # Stopping it again, now that it has ended, says so.
        backend.dispatch({"type": "agent_control", "action": "close", "id": child["id"],
                          "request_id": "stop2"})
        again = wire.wait(lambda f: f.get("request_id") == "stop2")
        self.assertEqual((again["type"], again["reason"]), ("command_rejected", "already_ended"))

    def test_a_sibling_in_the_same_parallel_batch_runs_on(self):
        backend, wire = self.make(mode="auto", git=True, max_parallel_tasks=2)
        entered, release = threading.Event(), threading.Event()

        def sibling(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("c1", "ls", {"path": "."})])
            self.assertTrue(release.wait(20))
            return ChatResult(content="Sibling finished its half.")

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[
                    ToolCall("p0", "task", {"description": "first half", "prompt": "CHILD-A work"}),
                    ToolCall("p1", "task", {"description": "second half", "prompt": "CHILD-B work"})])
            return ChatResult(content="Both halves are accounted for.")

        def stop_it():
            self.assertTrue(entered.wait(15))
            stopped = self.started(wire, "first half")
            self.close(backend, wire, stopped["id"])
            self.assertIsNotNone(self.ended(wire, stopped["id"]))
            release.set()

        end = self.run_prompt(backend, wire, [
            ("CHILD-A", blocks_until_stopped(entered, "Half of the first half.")),
            ("CHILD-B", sibling), ("PARENT", parent)], after_start=stop_it)
        self.assertEqual(end["reason"], "completed")
        first, second = self.started(wire, "first half"), self.started(wire, "second half")
        self.assertEqual(self.ended(wire, first["id"])["state"], "stopped")
        self.assertEqual(self.ended(wire, second["id"])["state"], "finished")
        self.assertTrue(self.task_result(wire, "p0")["output"].startswith("The user stopped sub-task"))
        sibling_result = self.task_result(wire, "p1")["output"]
        self.assertIn("completed", sibling_result)
        self.assertIn("Sibling finished its half.", sibling_result)
        self.assertEqual(backend.agent.messages[-1].get("content"), "Both halves are accounted for.")

    def test_a_child_waiting_on_a_permission_card_is_released_by_its_stop(self):
        backend, wire = self.make(mode="default")
        backend.config.permissions["allow"].append("Task")

        def child(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("c1", "bash", {"command": "echo needs-approval"})])
            return ChatResult(content="unreachable")

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {
                    "description": "ask first", "prompt": "CHILD ask"})])
            return ChatResult(content="Carried on without it.")

        def stop_it():
            card = wire.wait(lambda f: f["type"] == "permission_request", 15)
            self.assertIsNotNone(card, "the child never asked")
            self.close(backend, wire, self.started(wire, "ask first")["id"])
            self.assertIsNotNone(wire.wait(lambda f: f["type"] == "request_expired"
                                           and f["id"] == card["id"], 5),
                                 "the card still waits for an answer nobody needs now")

        end = self.run_prompt(backend, wire, [("CHILD", child), ("PARENT", parent)],
                              after_start=stop_it)
        self.assertEqual(end["reason"], "completed")
        self.assertEqual(self.ended(wire, self.started(wire, "ask first")["id"])["state"], "stopped")
        self.assertTrue(self.task_result(wire, "t1")["output"].startswith("The user stopped sub-task"))
        self.assertEqual(backend.agent.messages[-1].get("content"), "Carried on without it.")

    def test_stopping_a_grandchild_leaves_its_parent_child_working(self):
        backend, wire = self.make(mode="auto", max_subagent_depth=2)
        entered = threading.Event()

        def middle(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("m1", "task", {
                    "description": "dig deeper", "prompt": "GRANDCHILD dig"})])
            told = [m for m in results if "The user stopped sub-task 'dig deeper'" in str(m.get("content"))]
            return ChatResult(content="Middle finished: " + ("told" if told else "not told"))

        def parent(messages, results, cancel):
            if not results:
                return ChatResult(tool_calls=[ToolCall("t1", "task", {
                    "description": "the middle", "prompt": "MIDDLE work"})])
            return ChatResult(content="Parent done.")

        def stop_it():
            self.assertTrue(entered.wait(15))
            self.close(backend, wire, self.started(wire, "dig deeper")["id"])

        end = self.run_prompt(backend, wire, [
            ("GRANDCHILD", blocks_until_stopped(entered, "Dug a little.")),
            ("MIDDLE", middle), ("PARENT", parent)], after_start=stop_it)
        self.assertEqual(end["reason"], "completed")
        grandchild, middle_agent = self.started(wire, "dig deeper"), self.started(wire, "the middle")
        self.assertEqual(grandchild["parent_id"], middle_agent["id"])
        self.assertEqual(self.ended(wire, grandchild["id"])["state"], "stopped")
        self.assertEqual(self.ended(wire, middle_agent["id"])["state"], "finished")
        self.assertIn("Middle finished: told", self.task_result(wire, "t1")["output"])

    def test_an_id_that_is_not_a_sub_agent_is_rejected(self):
        backend, wire = self.make()
        backend.dispatch({"type": "agent_control", "action": "close", "id": "sub-0123456789ab",
                          "request_id": "x1"})
        frame = wire.wait(lambda f: f.get("request_id") == "x1")
        self.assertEqual((frame["type"], frame["reason"]), ("command_rejected", "unknown_agent"))


class ChildStopTests(unittest.TestCase):
    def test_the_turns_stop_reaches_every_depth_and_a_childs_stop_reaches_only_down(self):
        turn = threading.Event()
        child = _ChildStop(turn)
        grandchild = _ChildStop(child)
        self.assertFalse(grandchild.is_set())
        child.set()
        self.assertTrue(child.is_set() and child.closed and grandchild.is_set())
        self.assertFalse(grandchild.closed, "only the child was stopped by name")
        self.assertFalse(turn.is_set(), "a child's stop never stops its parent")
        other = _ChildStop(turn)
        self.assertFalse(other.is_set(), "nor a sibling")
        turn.set()
        self.assertTrue(other.is_set() and not other.closed)

    def test_a_wait_wakes_on_the_parents_stop(self):
        turn = threading.Event()
        child = _ChildStop(turn)
        threading.Timer(0.1, turn.set).start()
        started = time.monotonic()
        self.assertTrue(child.wait(5))
        self.assertLess(time.monotonic() - started, 1.0)
        self.assertFalse(_ChildStop(threading.Event()).wait(0.05))


if __name__ == "__main__":
    unittest.main()
