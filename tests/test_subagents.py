"""The agents indicator: this chat's task sub-agents.

Covers the registry (dgc/subagents.py), every Agent path that starts, updates and ends a record,
the `dgc serve` frames and snapshots (including a real `dgc serve` process), rebuilding a resumed
chat from its transcript, and the TUI segment, `/agents` list and fleet dashboard.
"""
from __future__ import annotations

import copy
import io
import json
import os
import queue
import random
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from waiting import RUNNER_SLACK, wait_for_value         # noqa: E402

from dgc import agent as agent_mod
from dgc import editor_protocol as ep
from dgc import glyphs, subagents
from dgc.agent import Agent, _SubUI, _wire_call_id
from dgc.config import Config, DEFAULTS
from dgc.headless import Backend, HeadlessUI
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.protocol import Emitter, PendingRequests
from dgc.redaction import redact_text
from dgc.subagents import SubagentRegistry

ROOT = Path(__file__).resolve().parents[1]
AGENT_FRAMES = ("agent_started", "agent_updated", "agent_ended")


def fixture_config(root: Path, **data) -> Config:
    config = object.__new__(Config)
    config.project_root, config.project_dir, config._persist = root, root / ".dgc", False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(base_url="http://localhost.invalid/v1", model="fixture", mode="auto",
                       hooks={}, mcp_servers={}, suggest=False, artifact_autostart=False,
                       plan_artifact=False, notes=False)
    config.data.update(data)
    config._stored_secrets, config._env_secret_keys, config._explicit_keys = {}, set(), set()
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


def clone_fixture(self, root):
    config = fixture_config(Path(root))
    config.data = copy.deepcopy(self.data)
    config.permissions = copy.deepcopy(self.permissions)
    return config


def git_repo(root: Path) -> Path:
    def git(*args):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)
    git("init", "-q")
    git("config", "user.email", "tests@dgc.invalid")
    git("config", "user.name", "DGC Tests")
    (root / "README.md").write_text("fixture\n")
    git("add", ".")
    git("commit", "-qm", "baseline")
    return root


class _Stream(io.TextIOBase):
    """An emitter target that timestamps every frame."""
    def __init__(self):
        self.lines: list[tuple[float, dict]] = []
        self._lock = threading.Lock()

    def write(self, text):
        for line in str(text).splitlines():
            if line.strip():
                with self._lock:
                    self.lines.append((time.monotonic(), json.loads(line)))
        return len(text)

    def flush(self):
        pass

    def frames(self):
        with self._lock:
            return [frame for _t, frame in self.lines]

    def timed(self):
        with self._lock:
            return list(self.lines)


class Script:
    """A class-level LLMClient.chat: the parent and every child answer from one script keyed by the
    first user message (a child's is its task prompt)."""

    def __init__(self, routes):
        self.routes = routes           # [(needle, callable(messages, tool_results, cancel) -> ChatResult)]

    def __get__(self, client, owner=None):            # patched onto LLMClient as a method
        if client is None:
            return self
        return lambda *args, **kwargs: self(client, *args, **kwargs)

    def __call__(self, client, messages, tools=None, reasoning_effort=None, on_text=None,
                 on_thinking=None, cancel=None):
        users = [m for m in messages if m.get("role") == "user"]
        first = str(users[0].get("content", "")) if users else ""
        results = [m for m in messages if m.get("role") == "tool"]
        for needle, route in self.routes:
            if needle in first:
                result = route(messages, results, cancel)
                if result.content and on_text:
                    on_text(result.content)
                return result
        raise AssertionError(f"no scripted route for {first[:80]!r}")


def calls_then(calls, final="done", usage=None):
    def route(messages, results, cancel):
        if not results:
            return ChatResult(tool_calls=list(calls), usage=usage or {})
        return ChatResult(content=final, usage=usage or {})
    return route


def child(summary="child done", sleep=0.0, tool=True, usage=None):
    usage = usage if usage is not None else {"prompt_tokens": 10, "completion_tokens": 5}

    def route(messages, results, cancel):
        if tool and not results:
            if sleep:
                time.sleep(sleep)
            return ChatResult(tool_calls=[ToolCall("c1", "ls", {"path": "."})], usage=usage)
        return ChatResult(content=summary, usage=usage)
    return route


class Harness:
    """A HeadlessUI + Agent wired like `dgc serve` (the Backend's listener), on a timed stream."""

    def __init__(self, root: Path, *, ui=None, approval_timeout_s=10, **config):
        self.root = root
        self.config = fixture_config(root, **config)
        self.stream = _Stream()
        self.em = Emitter(self.stream, validator=ep.event_error)
        self.pending = PendingRequests()
        self.ui = ui or HeadlessUI(self.em, self.pending, approval_timeout_s=approval_timeout_s)
        backend = object.__new__(Backend)
        backend.config, backend.em, backend.pending, backend.ui = self.config, self.em, self.pending, self.ui
        backend.agent = self.agent = Agent(self.config, self.ui)
        backend._agents_timer, backend._agents_timer_lock = None, threading.Lock()
        self.backend = backend
        self.agent.subagents.listener = backend._on_subagent
        if isinstance(self.ui, HeadlessUI):
            self.ui.cancelled = self.agent.cancelled
        self.replies: dict[str, dict] = {}
        self._done = threading.Event()
        self._responder = None

    def answer(self, kind, reply):
        self.replies[kind] = reply
        if self._responder is None:
            self._responder = threading.Thread(target=self._respond, daemon=True)
            self._responder.start()

    def _respond(self):
        answered = set()
        while not self._done.wait(0.01):
            for frame in self.stream.frames():
                reply = self.replies.get(frame["type"])
                if reply is not None and frame.get("id") not in answered:
                    answered.add(frame["id"])
                    if reply == "cancel":             # Stop pressed while the card is open
                        self.agent.cancelled.set()
                    else:
                        self.pending.resolve(frame["id"], reply)

    def run(self, prompt, routes, **patches):
        with patch.object(LLMClient, "chat", Script(routes)), \
                patch.object(Config, "clone_for_root", clone_fixture):
            if isinstance(self.ui, HeadlessUI):
                self.ui.turn_id = "t1"
                self.ui.reset_turn_messages()
            return self.agent.run_turn(prompt)

    def close(self):
        self._done.set()
        try:
            self.agent.mcp.stop_all()
        except Exception:
            pass

    def of(self, *types):
        return [f for f in self.stream.frames() if f["type"] in types]

    def index(self, predicate):
        for i, frame in enumerate(self.stream.frames()):
            if predicate(frame):
                return i
        return -1


class HarnessCase(unittest.TestCase):
    def make(self, git=False, **config):
        directory = tempfile.TemporaryDirectory(prefix="dgc-subagents-")
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        if git:
            git_repo(root)
            config.setdefault("subagent_worktree_root", str(root.parent / (root.name + "-worktrees")))
        harness = Harness(root, **config)
        self.addCleanup(harness.close)
        return harness

    def assertFramesValid(self, harness):
        for frame in harness.stream.frames():
            self.assertIsNone(ep.event_error(frame), frame)
            if frame["type"] in AGENT_FRAMES + ("agents",):
                for key in ("depth", "duration_ms", "tool_calls", "tokens", "total", "active"):
                    if key in frame:
                        self.assertIs(type(frame[key]), int, (key, frame))


# ---------------------------------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------------------------------
class Recorder:
    def __init__(self, sleep=0.0):
        self.events = []
        self.sleep = sleep
        self.lock = threading.Lock()

    def __call__(self, kind, payload):
        if self.sleep:
            time.sleep(self.sleep)
        with self.lock:
            self.events.append((kind, dict(payload)))

    def kinds(self):
        return [kind for kind, _ in self.events]

    def states(self, agent_id=None):
        return [p.get("state") for kind, p in self.events
                if kind != "resync" and (agent_id is None or p.get("id") == agent_id)]


def sid(n: int) -> str:
    return f"sub-{n:012x}"


class RegistryTests(unittest.TestCase):
    def test_lifecycle_and_first_terminal_wins(self):
        rec = Recorder()
        reg = SubagentRegistry(rec)
        reg.start(id=sid(1), call_id="c1", description="d", queued=True, parallel=True, isolated=True)
        reg.waiting(sid(1), "permission")                      # a queued record cannot wait
        reg.running(sid(1))
        reg.waiting(sid(1), "permission")
        reg.waiting(sid(1), None)
        reg.end(sid(1), "finished", tool_calls=2)
        reg.end(sid(1), "failed", "late")                      # the first terminal state wins
        reg.running(sid(1))                                    # ended records never move again
        reg.waiting(sid(1), "answer")
        self.assertEqual(rec.kinds(), ["started", "updated", "updated", "updated", "ended"])
        self.assertEqual(rec.states(), ["queued", "running", "waiting", "running", "finished"])
        started, ended = rec.events[0][1], rec.events[-1][1]
        self.assertEqual((started["call_id"], started["depth"], started["parallel"]), ("c1", 1, True))
        self.assertEqual(ended["tool_calls"], 2)
        self.assertIs(type(ended["duration_ms"]), int)
        self.assertEqual(rec.events[2][1]["waiting_for"], "permission")
        self.assertNotIn("waiting_for", rec.events[3][1], "absent, not null, outside waiting")
        for kind, payload in rec.events:
            name = {"started": "agent_started", "updated": "agent_updated", "ended": "agent_ended"}[kind]
            self.assertIsNone(ep.event_error({"type": name, "seq": 0, **payload}), payload)
        reg.start(id=sid(1), description="duplicate")          # a duplicate id is ignored
        self.assertEqual(len(rec.events), 5)
        counts = reg.counts()
        self.assertEqual((counts["total"], counts["active"], counts["finished"]), (1, 0, 1))

    def test_counts_snapshot_and_record_caps(self):
        reg = SubagentRegistry()
        for n in range(70):
            reg.start(id=sid(n), description=f"a{n}")
        for n in range(0, 70, 2):
            reg.end(sid(n), "finished")
        snap = reg.snapshot()
        self.assertEqual((snap["total"], snap["active"], len(snap["items"])), (70, 35, 64))
        self.assertEqual([i["state"] for i in snap["items"][:35]], ["running"] * 35, "active first")
        self.assertEqual([i["id"] for i in snap["items"][:3]], [sid(1), sid(3), sid(5)], "oldest first")
        self.assertEqual({i["id"] for i in snap["items"][35:]}, {sid(n) for n in range(12, 70, 2)},
                         "then the most recent ended")
        for item in snap["items"]:
            self.assertIsNone(ep.event_error({"type": "agents", "seq": 0, "items": [item], "total": 1,
                                              "active": 0}))
            self.assertIn("elapsed_ms" if item["state"] == "running" else "duration_ms", item)

        reg = SubagentRegistry()
        for n in range(512):
            reg.start(id=sid(n), description="x")
            reg.end(sid(n), "finished")
        reg.start(id=sid(600), description="513th")
        self.assertNotIn(sid(0), reg._records, "the oldest ended record goes first")
        self.assertIn(sid(1), reg._records)
        self.assertEqual(reg.counts()["total"], 513)
        self.assertEqual(reg.counts()["finished"], 512, "ended counts stay exact after eviction")

        reg = SubagentRegistry()
        for n in range(520):
            reg.start(id=sid(n), description="x")
        snap = reg.snapshot()
        self.assertEqual((snap["total"], snap["active"], len(snap["items"])), (520, 520, 64))
        self.assertEqual(len(reg._records), 520, "active records are never dropped")
        rec = Recorder()
        reg.listener = rec
        reg.end(sid(519), "failed", "unlisted but still published")
        self.assertEqual(rec.kinds(), ["ended"])

    def test_bounds_and_a_failing_listener(self):
        rec = Recorder()
        reg = SubagentRegistry(rec)
        reg.start(id=sid(1), call_id="c" * 400, description="d" * 300, agent_type="t" * 90, model="m" * 250)
        started = rec.events[0][1]
        self.assertEqual((len(started["call_id"]), len(started["description"]), len(started["agent_type"]),
                          len(started["model"])), (256, 200, 64, 200))
        with patch.object(subagents, "COALESCE_S", 0.01):
            reg.activity(sid(1), "a" * 120)
            wait_for_value(lambda: len(rec.events[-1][1].get("activity") or "") if rec.events else None,
                           80, what="the coalesced activity to arrive clipped to 80 characters")
        reg.end(sid(1), "failed", "m" * 900)
        self.assertEqual(len(rec.events[-1][1]["message"]), 500)

        calls = []

        def broken(kind, payload):
            calls.append(kind)
            raise ValueError("invalid protocol event")
        reg = SubagentRegistry(broken)
        reg.start(id=sid(2), description="x")                  # never raises into the worker
        reg.end(sid(2), "finished")
        self.assertEqual(calls, ["started", "resync", "ended", "resync"])

    def test_clip_never_splits_the_redaction_marker(self):
        text = "x" * 494 + "[REDACTED] and more"
        clipped = subagents.clip(text, 500)
        self.assertTrue(clipped.endswith("…"))
        self.assertNotIn("[RED", clipped)
        self.assertLessEqual(len(clipped), 500)
        self.assertEqual(subagents.clip("short", 500), "short")

    def test_urls_lose_userinfo_query_and_fragment_before_the_clip(self):
        raw = ('HTTP 401 from http://127.0.0.1:5101/v1/chat/completions: {"error": {"message": '
               '"denied for Bearer [REDACTED] at https://[REDACTED]@internal.example/v1?token=abcdef0123456789abcdef"}}'
               "\n  → the endpoint rejected the key")
        self.assertEqual(subagents.scrub_urls(raw).splitlines()[0],
                         'HTTP 401 from http://127.0.0.1:5101/v1/chat/completions: {"error": {"message": '
                         '"denied for Bearer [REDACTED] at https://internal.example/v1"}}')
        self.assertEqual(subagents.scrub_urls("at https://[::1]:8080/a/b?x=1#y and http://u:p@h.example?k=v"),
                         "at https://[::1]:8080/a/b and http://h.example")
        self.assertEqual(subagents.scrub_urls("plain http://host:1/path and file:///tmp/x"),
                         "plain http://host:1/path and file:///tmp/x")
        rec = Recorder()
        reg = SubagentRegistry(rec)
        reg.start(id=sid(1), description="d")
        reg.end(sid(1), "failed", "x" * 490 + " https://h.example/v1?token=abcdef0123456789abcdef")
        ended = [p for kind, p in rec.events if kind == "ended"][0]
        self.assertNotIn("abcdef", json.dumps(ended))
        self.assertNotIn("abcdef", json.dumps(reg.snapshot()))
        self.assertLessEqual(len(ended["message"]), subagents.MAX_MESSAGE)
        restored = subagents.restore_records(task_turn(
            "c", "a", "Sub-task 'a' did not complete: HTTP 500 from https://h.example/v1?key=abcdef0123456789"), "s")
        self.assertEqual(restored[0]["message"], "HTTP 500 from https://h.example/v1")

    def test_terminal_meta_shows_one_line_of_a_long_message(self):
        item = {"state": "failed", "message": "first line " + "y" * 300 + "\n  → second line", "duration_ms": 2000}
        meta = subagents.meta_text(item)
        self.assertNotIn("second line", meta)
        self.assertNotIn("\n", meta)
        self.assertTrue(meta.startswith("failed · first line y"))
        self.assertTrue(meta.endswith("… · 2s"), meta)
        self.assertLessEqual(len(subagents.first_line(item["message"])), subagents.MAX_MESSAGE_LINE)

    def test_redaction_happens_before_the_clip(self):
        secret = "known-secret-value-abcdefghijklmnop"
        config = fixture_config(Path(tempfile.gettempdir()), api_key=secret)
        from dgc.redaction import secret_values
        secrets = secret_values(config)
        rec = Recorder()
        reg = SubagentRegistry(rec)
        cases = [("x" * 470) + " https://u:SECRET-TOKEN-1234567890@host/x tail",
                 ("x" * 490) + " sk-SECRETabcdefghijklmnopqrstuvwxyz tail",
                 ("x" * 485) + f" {secret} tail"]
        for n, message in enumerate(cases):
            reg.start(id=sid(n), description=redact_text(message, secrets))
            reg.end(sid(n), "failed", redact_text(message, secrets))
        for _kind, payload in rec.events:
            blob = json.dumps(payload)
            for fragment in ("SECRET", "u:S", "known-secret", "sk-S"):
                self.assertNotIn(fragment, blob, payload)

    def test_updates_after_reset_publish_nothing(self):
        rec = Recorder()
        reg = SubagentRegistry(rec)
        reg.start(id=sid(1), description="old chat")
        reg.reset()
        reg.running(sid(1), model="m")
        reg.waiting(sid(1), "permission")
        reg.progress(sid(1), tool_calls=3, tokens=9)
        reg.end(sid(1), "finished")
        self.assertEqual(rec.kinds(), ["started"])
        self.assertEqual(reg.snapshot(), {"items": [], "total": 0, "active": 0})

    def test_activity_and_progress_are_coalesced_state_is_not(self):
        rec = Recorder()
        reg = SubagentRegistry(rec)
        reg.start(id=sid(1), description="x")
        t0 = time.monotonic()
        for n in range(50):
            reg.progress(sid(1), tool_calls=n + 1, tokens=(n + 1) * 10)
            reg.activity(sid(1), "No response from the model" if n % 2 else "")
        reg.waiting(sid(1), "permission")                       # a state change is immediate
        self.assertEqual(rec.states()[-1], "waiting")
        self.assertLess(time.monotonic() - t0, 0.5 + RUNNER_SLACK)
        time.sleep(1.2)
        updates = [p for kind, p in rec.events if kind == "updated"]
        self.assertLessEqual(len(updates), 2, updates)
        self.assertEqual(updates[0]["tool_calls"], 50, "the state change carries the latest totals")

    def test_listener_order_equals_transition_order(self):
        """200 randomized interleavings with a listener that sleeps 50 ms: the wire order is the
        order the states actually changed, and a coalesced flush carries the current state."""
        failures = []

        def one(seed):
            rng = random.Random(seed)
            rec = Recorder()
            reg = SubagentRegistry()
            reg._trace = []
            slow = {"left": 1}

            def listener(kind, payload):
                if slow["left"] and kind == "updated":
                    slow["left"] -= 1
                    time.sleep(0.05)
                rec(kind, payload)
            reg.listener = listener
            reg.start(id=sid(1), description="x", queued=bool(rng.getrandbits(1)))
            reg.running(sid(1))
            ops = [lambda: reg.waiting(sid(1), "permission"), lambda: reg.waiting(sid(1), None),
                   lambda: reg.waiting(sid(1), "answer"), lambda: reg.waiting(sid(1), None)]
            threads = []
            for op in ops:
                thread = threading.Thread(target=lambda op=op: (time.sleep(rng.random() * 0.01), op()))
                threads.append(thread)
                thread.start()
            for thread in threads:
                thread.join()
            reg.end(sid(1), "finished")
            wire = [(p["id"], p["state"]) for kind, p in rec.events if kind != "resync"]
            # The trace records only transitions; a payload for an unchanged state never goes out.
            if wire != reg._trace:
                failures.append((seed, wire, reg._trace))

        with ThreadPoolExecutor(max_workers=50) as pool:
            list(pool.map(one, range(200)))
        self.assertEqual(failures, [])

        rec = Recorder()
        reg = SubagentRegistry(rec)
        def settled():
            updates = [p for kind, p in rec.events if kind == "updated"]
            if not updates:
                return None
            last = updates[-1]
            return (last["state"], last["waiting_for"], last["tool_calls"])

        with patch.object(subagents, "COALESCE_S", 0.05):
            reg.start(id=sid(1), description="x")
            reg.progress(sid(1), tool_calls=1, tokens=None)
            reg.waiting(sid(1), "permission")
            reg.progress(sid(1), tool_calls=2, tokens=None)
            wait_for_value(settled, ("waiting", "permission", 2),
                           what="the coalescer to emit one update carrying the final state")


# ---------------------------------------------------------------------------------------------------
# Agent paths
# ---------------------------------------------------------------------------------------------------
class SerialAndParallelTests(HarnessCase):
    def test_serial_task(self):
        h = self.make()
        ok = h.run("go", [("CHILD", child()),
                          ("go", calls_then([ToolCall("t1", "task", {"description": "look around",
                                                                     "prompt": "CHILD look"})]))])
        self.assertTrue(ok)
        self.assertFramesValid(h)
        started = h.of("agent_started")
        self.assertEqual(len(started), 1)
        s = started[0]
        self.assertEqual((s["state"], s["call_id"], s["depth"], s["parallel"], s["parent_id"], s["turn_id"]),
                         ("running", "t1", 1, False, None, "t1"))
        self.assertRegex(s["id"], r"^sub-[0-9a-f]{12}$")
        i_call = h.index(lambda f: f["type"] == "tool_call" and f["call_id"] == "t1")
        i_start = h.index(lambda f: f["type"] == "agent_started")
        i_child = h.index(lambda f: f["type"] == "tool_call" and f["call_id"] == f"{s['id']}:c1")
        i_end = h.index(lambda f: f["type"] == "agent_ended")
        i_result = h.index(lambda f: f["type"] == "tool_result" and f["call_id"] == "t1")
        self.assertTrue(0 <= i_call < i_start < i_child < i_end < i_result, (i_call, i_start, i_child, i_end, i_result))
        ended = h.of("agent_ended")[0]
        self.assertEqual(ended["state"], "finished")
        self.assertGreaterEqual(ended["tool_calls"], 1)
        self.assertEqual(ended["tokens"], 30)
        self.assertEqual(h.agent.subagents.counts()["total"], 1)

    def test_turn_without_task_emits_no_agent_frames(self):
        h = self.make()
        h.run("hello", [("hello", lambda messages, results, cancel: ChatResult(content="hi"))])
        self.assertEqual(h.of(*AGENT_FRAMES), [])

    def test_parallel_batch_queues_limits_and_ends_live(self):
        h = self.make(git=True, max_parallel_tasks=2)
        calls = [ToolCall(f"p{n}", "task", {"description": f"part {n}", "prompt": f"CHILD{n} work"})
                 for n in range(3)]
        h.run("split", [("CHILD0", child(sleep=0.3)), ("CHILD1", child(sleep=0.6)),
                        ("CHILD2", child(sleep=0.6)), ("split", calls_then(calls))])
        self.assertFramesValid(h)
        started = h.of("agent_started")
        self.assertEqual([f["state"] for f in started], ["queued"] * 3)
        self.assertEqual([f["call_id"] for f in started], ["p0", "p1", "p2"])
        self.assertTrue(all(f["parallel"] and f["isolated"] for f in started))
        running, peak = set(), 0
        for frame in h.stream.frames():
            if frame["type"] == "agent_updated" and frame["state"] in ("running", "waiting"):
                running.add(frame["id"])
            elif frame["type"] == "agent_ended":
                running.discard(frame["id"])
            peak = max(peak, len(running))
        self.assertEqual(peak, 2)
        timed = h.stream.timed()
        first_result = min(t for t, f in timed if f["type"] == "tool_result" and f["name"] == "task")
        ends = {f["id"]: t for t, f in timed if f["type"] == "agent_ended"}
        self.assertEqual(len(ends), 3)
        self.assertGreaterEqual(first_result - ends[started[0]["id"]], 0.2)
        self.assertTrue(all(t < first_result for t in ends.values()))
        self.assertEqual({f["state"] for f in h.of("agent_ended")}, {"finished"})

    def test_parallel_child_prose_is_not_replayed_into_the_parent_transcript(self):
        h = self.make(git=True, max_parallel_tasks=2)
        calls = [ToolCall(f"p{n}", "task", {"description": f"part {n}", "prompt": f"CHILD{n} work"})
                 for n in range(2)]
        h.run("split", [("CHILD0", child(summary="summary from part zero")),
                        ("CHILD1", child(summary="summary from part one")),
                        ("split", calls_then(calls, final="Both parts are done."))])
        self.assertFramesValid(h)
        live = "".join(f["text"] for f in h.of("text_delta"))
        self.assertNotIn("summary from part", live, "a parallel child's prose is not main-transcript text")
        self.assertIn("Both parts are done.", live)
        results = [f["output"] for f in h.of("tool_result") if f["name"] == "task"]
        self.assertTrue(any("summary from part zero" in out for out in results), results)
        self.assertTrue(any("summary from part one" in out for out in results), results)
        replayed = "".join(i.get("text", "") for i in h.backend._history() if i.get("type") == "text_delta")
        self.assertEqual(replayed, live, "live and replay show the same prose")
        # The child's other trace (its tool rows) still replays into the parent.
        self.assertTrue(any(f["type"] == "tool_call" and str(f.get("call_id", "")).startswith("sub-")
                            for f in h.stream.frames()))

    def test_serial_child_prose_stays_in_its_labelled_task_result_after_reload(self):
        h = self.make(mode="acceptEdits")
        h.answer("permission_request", {"decision": "once"})
        call = ToolCall("p0", "task", {"description": "Read the file", "prompt": "CHILD0 work"})
        h.run("delegate", [("CHILD0", child(summary="child's distinct answer")),
                           ("delegate", calls_then([call], final="Parent answer."))])
        self.assertFramesValid(h)
        live = "".join(f["text"] for f in h.of("text_delta"))
        self.assertNotIn("child's distinct answer", live)
        self.assertIn("Parent answer.", live)
        self.assertTrue(any("child's distinct answer" in f["output"] for f in h.of("tool_result")
                            if f["name"] == "task"))
        replayed = "".join(i.get("text", "") for i in h.backend._history() if i.get("type") == "text_delta")
        self.assertEqual(replayed, live)

    def test_accept_edits_runs_tasks_serially(self):
        h = self.make(mode="acceptEdits")
        h.answer("permission_request", {"decision": "once"})
        calls = [ToolCall(f"s{n}", "task", {"description": f"s{n}", "prompt": f"CHILD{n}"}) for n in range(2)]
        h.run("two", [("CHILD", child(tool=False)), ("two", calls_then(calls))])
        started = h.of("agent_started")
        self.assertEqual([f["state"] for f in started], ["running", "running"])
        self.assertFalse(any(f["parallel"] for f in started))


class TerminalStateTests(HarnessCase):
    def test_nested_agents_and_metrics_survive_save_and_resume(self):
        h = self.make()
        # Use the normal session location, so the same path validation as production applies.
        from dgc import sessions
        h.agent.session_file = sessions.new_path(h.config.project_root)
        h.run("delegate", [
            ("GRANDCHILD", child(summary="nested answer")),
            ("CHILD", calls_then([ToolCall("n1", "task", {"description": "nested helper", "prompt": "GRANDCHILD"})])),
            ("delegate", calls_then([ToolCall("p1", "task", {"description": "parent helper", "prompt": "CHILD"})])),
        ])
        before = h.agent.subagents.snapshot()
        self.assertEqual(before["total"], 2)
        other = Agent(h.config, HeadlessUI(Emitter(_Stream(), validator=ep.event_error), PendingRequests()))
        self.addCleanup(other.mcp.stop_all)
        other.load_session(h.agent.session_file)
        after = other.subagents.snapshot()
        self.assertEqual(after["total"], before["total"])
        keys = ("id", "parent_id", "description", "state", "tool_calls", "tokens", "duration_ms")
        self.assertEqual([{k: i.get(k) for k in keys} for i in after["items"]],
                         [{k: i.get(k) for k in keys} for i in before["items"]])
        self.assertIsNone(ep.event_error({"type": "agents", "seq": 0, **after}))

    def test_saved_running_agents_restore_stopped_without_losing_their_parent(self):
        reg = SubagentRegistry()
        reg.start(id="sub-111111111111", description="parent", depth=1, call_id="p")
        reg.start(id="sub-222222222222", description="child", depth=2, parent_id="sub-111111111111", call_id="c")
        reg.progress("sub-222222222222", tool_calls=2, tokens=99)
        other = SubagentRegistry()
        self.assertTrue(other.restore_state(reg.saved_state()))
        snap = other.snapshot()
        self.assertEqual((snap["total"], snap["active"]), (2, 0))
        self.assertTrue(all(i["state"] == "stopped" for i in snap["items"]))
        self.assertEqual(snap["items"][1]["parent_id"], snap["items"][0]["id"])
        self.assertEqual(snap["items"][1]["tokens"], 99)

    def ended(self, h):
        return {f["id"]: f for f in h.of("agent_ended")}

    def test_cancel_mid_batch_is_stopped(self):
        h = self.make(git=True, max_parallel_tasks=2)
        both = threading.Barrier(2)

        def waits(messages, results, cancel):
            both.wait(5)
            h.agent.cancelled.set()
            deadline = time.monotonic() + 5
            while not h.agent.cancelled.is_set() and time.monotonic() < deadline:
                time.sleep(0.01)
            return ChatResult(content="", finish_reason="stop")
        calls = [ToolCall(f"k{n}", "task", {"description": f"k{n}", "prompt": f"CHILD{n}"}) for n in range(2)]
        h.run("cancel", [("CHILD", waits), ("cancel", calls_then(calls))])
        self.assertFramesValid(h)
        self.assertEqual({f["state"] for f in h.of("agent_ended")}, {"stopped"})
        self.assertEqual(h.agent.subagents.counts()["active"], 0)

    def test_child_turn_false_is_failed(self):
        h = self.make()
        original = Agent.run_turn

        def failing(agent, prompt, **kwargs):
            if agent.depth == 0:
                return original(agent, prompt, **kwargs)
            agent._last_turn_error = "the child could not reach its model"
            return False
        with patch.object(Agent, "run_turn", failing):
            h.run("go", [("go", calls_then([ToolCall("t1", "task", {"description": "d", "prompt": "p"})]))])
        ended = h.of("agent_ended")
        self.assertEqual([(f["state"], f["message"]) for f in ended],
                         [("failed", "the child could not reach its model")])

    def test_clone_for_root_raising_fails_immediately(self):
        h = self.make()

        def broken_clone(config, root):
            raise OSError("config unavailable")
        with patch.object(LLMClient, "chat", Script([("go", calls_then([
                ToolCall("t1", "task", {"description": "d", "prompt": "p"})]))])), \
                patch.object(Config, "clone_for_root", broken_clone):
            h.ui.turn_id = "t1"
            h.agent.run_turn("go")
        self.assertEqual([(f["state"], f["message"]) for f in h.of("agent_ended")],
                         [("failed", "OSError: config unavailable")])
        # Parallel: one child's configuration fails while its sibling is still working.
        h = self.make(git=True, max_parallel_tasks=2)
        calls = [ToolCall("a", "task", {"description": "bad", "prompt": "CHILDA"}),
                 ToolCall("b", "task", {"description": "slow", "prompt": "CHILDB"})]
        worktrees = []

        def clone(config, root):
            worktrees.append(root)
            if len(worktrees) == 1:
                raise OSError("no config for this worktree")
            return clone_fixture(config, root)
        with patch.object(LLMClient, "chat", Script([("CHILDB", child(sleep=0.6)), ("go", calls_then(calls))])), \
                patch.object(Config, "clone_for_root", clone):
            h.ui.turn_id = "t1"
            h.agent.run_turn("go")
        timed = h.stream.timed()
        ends = [(t, f) for t, f in timed if f["type"] == "agent_ended"]
        self.assertEqual([f["state"] for _t, f in ends], ["failed", "finished"])
        self.assertGreaterEqual(ends[1][0] - ends[0][0], 0.4, "failed at once, not at batch end")

    def test_mcp_connect_raising_in_a_parallel_child_is_failed(self):
        h = self.make(git=True, max_parallel_tasks=2)
        calls = [ToolCall(f"m{n}", "task", {"description": f"m{n}", "prompt": f"CHILD{n}"}) for n in range(2)]
        with patch.object(agent_mod.MCPManager, "connect_all", side_effect=RuntimeError("mcp down")):
            h.run("go", [("go", calls_then(calls))])
        ended = h.of("agent_ended")
        self.assertEqual([f["state"] for f in ended], ["failed", "failed"])
        for frame in ended:
            self.assertIn("mcp down", frame["message"])
            self.assertNotIn("NameError", frame["message"])

    def test_agent_constructor_raising_is_failed(self):
        h = self.make()
        real = Agent

        def factory(*args, **kwargs):
            raise RuntimeError("agent could not start")
        calls = [ToolCall("t1", "task", {"description": "d", "prompt": "p"})]
        with patch.object(LLMClient, "chat", Script([("go", calls_then(calls))])), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.ui.turn_id = "t1"
            agent_mod.Agent = factory
            try:
                real.run_turn(h.agent, "go")
            finally:
                agent_mod.Agent = real
        self.assertEqual([(f["state"], f["message"]) for f in h.of("agent_ended")],
                         [("failed", "RuntimeError: agent could not start")])

    def test_tasks_that_never_start_create_no_record(self):
        # depth limit
        h = self.make()
        h.agent.depth = 3
        out = h.agent._handle_call(ToolCall("t1", "task", {"description": "d", "prompt": "p"}))
        self.assertIn("Max sub-agent depth", out)
        # the workspace write lease
        h2 = self.make()
        with patch.object(agent_mod, "acquire_cancellable", return_value=False):
            out = h2.agent._run_subagent("d", "p", "", "t1")
        self.assertIn("was not started", out)
        # the isolated worktree (serial and parallel)
        h3 = self.make(git=True, max_parallel_tasks=2)
        from dgc.worktree import TaskWorkspace
        with patch.object(TaskWorkspace, "prepare", return_value=(None, "disk full")):
            out = h3.agent._run_subagent("d", "p", "", "t1")
            calls = [ToolCall(f"w{n}", "task", {"description": f"w{n}", "prompt": "p"}) for n in range(2)]
            outcomes = h3.agent._parallel_task_outputs(calls)
        self.assertIn("could not be created", out)
        self.assertTrue(all("was not started" in o.output for o in outcomes.values()))
        # a sibling baseline that changed while the batch was prepared
        h4 = self.make(git=True, max_parallel_tasks=2)
        made = iter([SimpleNamespace(base_commit="a", initial_dirty=(), baseline={}, project_root=h4.root,
                                     cleanup=lambda: None),
                     SimpleNamespace(base_commit="b", initial_dirty=(), baseline={}, project_root=h4.root,
                                     cleanup=lambda: None)])
        with patch.object(TaskWorkspace, "prepare", side_effect=lambda *a, **k: (next(made), "")):
            outcomes = h4.agent._parallel_task_outputs(calls)
        self.assertTrue(all("shared parallel baseline" in o.output for o in outcomes.values()))
        for harness in (h, h2, h3, h4):
            self.assertEqual(harness.of(*AGENT_FRAMES), [])
            self.assertEqual(harness.agent.subagents.counts()["total"], 0)

    def test_scheduler_failure_ends_every_prepared_child(self):
        h = self.make(git=True, max_parallel_tasks=2)
        calls = [ToolCall(f"x{n}", "task", {"description": f"x{n}", "prompt": "p"}) for n in range(2)]
        import concurrent.futures as futures
        with patch.object(futures, "as_completed", side_effect=RuntimeError("pool broke")), \
                patch.object(Agent, "_execute_prepared_subagent", lambda *args: time.sleep(0.05) or ("", "ok", "")), \
                patch.object(Config, "clone_for_root", clone_fixture):
            h.agent._parallel_task_outputs(calls)
        self.assertEqual([f["state"] for f in h.of("agent_ended")], ["failed", "failed"])
        self.assertIn("parallel task scheduler failed", h.of("agent_ended")[0]["message"])

    def test_root_turn_that_raises_ends_open_records_stopped(self):
        h = self.make()

        def explode(*args, **kwargs):
            h.agent.subagents.start(id=sid(7), description="orphan")
            raise RuntimeError("boom")
        with patch.object(Agent, "_run_goal_steps", explode), self.assertRaises(RuntimeError):
            h.agent.run_turn("go")
        ended = h.of("agent_ended")
        self.assertEqual([(f["state"], f["message"]) for f in ended],
                         [("stopped", "the turn ended before this agent reported")])

    def test_redacted_failure_reaches_the_frames_without_a_fragment(self):
        secret = "known-secret-value-abcdefghijklmnop"
        h = self.make(api_key=secret)
        original = Agent.run_turn

        def failing(agent, prompt, **kwargs):
            if agent.depth == 0:
                return original(agent, prompt, **kwargs)
            agent._last_turn_error = ("x" * 470 + " https://u:SECRET-TOKEN-1234567890@host/x "
                                      + "y" * 10 + " sk-SECRETabcdefghijklmnopqrstuvwxyz " + secret)
            return False
        with patch.object(Agent, "run_turn", failing):
            h.run("go", [("go", calls_then([ToolCall("t1", "task", {"description": "d " + secret,
                                                                    "prompt": "p"})]))])
        blob = json.dumps(h.of(*AGENT_FRAMES))
        for fragment in ("SECRET", "u:S", "known-secret", "sk-S"):
            self.assertNotIn(fragment, blob)
        self.assertEqual(h.agent.subagents.counts()["failed"], 1)
        tui = bare_tui()
        tui.agent = h.agent
        listing = tui._agents_listing()
        for fragment in ("SECRET", "u:S", "known-secret", "sk-S"):
            self.assertNotIn(fragment, listing)


class NestingWaitingStallTests(HarnessCase):
    def test_grandchild_links_to_its_parent_and_spawning_call(self):
        h = self.make()
        routes = [("GRANDCHILD", child(tool=False, summary="grandchild done")),
                  ("CHILD", calls_then([ToolCall("c1", "task", {"description": "nested",
                                                               "prompt": "GRANDCHILD dig"})],
                                       final="child done")),
                  ("go", calls_then([ToolCall("t1", "task", {"description": "outer", "prompt": "CHILD plan"})]))]
        h.run("go", routes)
        self.assertFramesValid(h)
        outer, inner = h.of("agent_started")
        self.assertEqual((outer["parent_id"], outer["depth"]), (None, 1))
        self.assertEqual((inner["parent_id"], inner["depth"]), (outer["id"], 2))
        self.assertEqual(inner["call_id"], f"{outer['id']}:c1")
        spawning = [f for f in h.of("tool_call") if f["name"] == "task" and f["call_id"] != "t1"]
        self.assertEqual([f["call_id"] for f in spawning], [inner["call_id"]])
        self.assertEqual([f["state"] for f in h.of("agent_ended")], ["finished", "finished"])

    def test_nesting_with_a_permissive_fixture_ui(self):
        seen = []

        class PermissiveUI:
            def tool_call(self, name, args, call_id=None):
                seen.append((name, call_id))

            def __getattr__(self, name):
                return lambda *args, **kwargs: None
        h = self.make(ui=PermissiveUI())
        rec = Recorder()
        h.agent.subagents.listener = rec
        routes = [("GRANDCHILD", child(tool=False)),
                  ("CHILD", calls_then([ToolCall("c1", "task", {"description": "nested", "prompt": "GRANDCHILD"})])),
                  ("go", calls_then([ToolCall("t1", "task", {"description": "outer", "prompt": "CHILD"})]))]
        with patch.object(LLMClient, "chat", Script(routes)), patch.object(Config, "clone_for_root", clone_fixture):
            h.agent.run_turn("go")
        started = [p for kind, p in rec.events if kind == "started"]
        self.assertEqual(len(started), 2)
        self.assertEqual(started[1]["call_id"], f"{started[0]['id']}:c1")
        self.assertIn(("task", started[1]["call_id"]), seen)
        self.assertNotIn("turn_id", started[0], "a permissive UI's attribute is not a turn id")
        self.assertEqual(_wire_call_id(PermissiveUI(), "c9"), "c9")
        wrapped = _SubUI(_SubUI(PermissiveUI(), "a"), "b")
        self.assertEqual(_wire_call_id(wrapped, "c9"), f"{wrapped._parent.agent_id}:{wrapped.agent_id}:c9")

    def test_waiting_for_permission_precedes_the_card_and_clears(self):
        for decision in ("once", "no", "cancel"):
            with self.subTest(decision=decision):
                h = self.make(mode="default")
                h.config.permissions = {"allow": ["task"], "ask": [], "deny": []}
                h.answer("permission_request", decision if decision == "cancel" else {"decision": decision})

                def child_bash(messages, results, cancel):
                    if not results:
                        return ChatResult(tool_calls=[ToolCall("b1", "bash", {"command": "echo hi"})])
                    return ChatResult(content="child done")
                h.run("go", [("CHILD", child_bash),
                             ("go", calls_then([ToolCall("t1", "task", {"description": "d", "prompt": "CHILD"})]))])
                self.assertFramesValid(h)
                i_wait = h.index(lambda f: f["type"] == "agent_updated" and f["state"] == "waiting")
                i_card = h.index(lambda f: f["type"] == "permission_request")
                self.assertGreaterEqual(i_wait, 0)
                self.assertLess(i_wait, i_card)
                waiting = h.stream.frames()[i_wait]
                self.assertEqual(waiting["waiting_for"], "permission")
                self.assertTrue(re.match(r"^sub-[0-9a-f]{12}:b1$", h.stream.frames()[i_card]["call_id"]))
                after = [f for f in h.stream.frames()[i_wait + 1:] if f["type"] == "agent_updated"]
                self.assertEqual(after[0]["state"], "running")
                self.assertNotIn("waiting_for", after[0])
                self.assertEqual(h.of("agent_ended")[0]["state"], "stopped" if decision == "cancel" else "finished")
                if decision == "cancel":
                    self.assertLess(i_card, h.index(lambda f: f["type"] == "request_expired"))

    def test_present_plan_in_a_child_waits_for_an_answer(self):
        h = self.make(mode="plan")
        rec = Recorder()
        reg = h.agent.subagents
        reg.listener = rec
        reg.start(id=sid(3), description="planner")
        h.agent._subagent_id = sid(3)
        states = []

        class PlanUI:
            plan_feedback = ""

            def present_plan(self, plan):
                states.append(reg.counts()["waiting_answer"])
                return None

            def __getattr__(self, name):
                return lambda *args, **kwargs: None
        h.agent.ui = PlanUI()
        out = h.agent._handle_call(ToolCall("pp", "present_plan", {"plan": "# Plan\n1. read"}))
        self.assertIn("NOT approved", out)
        self.assertEqual(states, [1])
        self.assertEqual([(p["state"], p.get("waiting_for")) for kind, p in rec.events if kind == "updated"],
                         [("waiting", "answer"), ("running", None)])

    def test_a_child_stall_notice_becomes_its_activity(self):
        h = self.make()
        rec = Recorder()
        reg = h.agent.subagents
        reg.listener = rec
        reg.start(id=sid(4), description="slow model")
        kid = Agent(h.config, _SubUI(h.ui, "slow model"))
        self.addCleanup(kid.mcp.stop_all)
        kid.subagents, kid._subagent_id = reg, sid(4)
        latest = lambda key: (rec.events[-1][1].get(key) if rec.events else None)  # noqa: E731
        with patch.object(subagents, "COALESCE_S", 0.02):
            kid._show_model_wait("No response from the model", "fixture at h · no reply for 45s+")
            wait_for_value(lambda: latest("activity"), "No response from the model",
                           what="the child's stall notice to become its activity")
            kid._show_model_wait(None)
            # Still inside the patch: the coalescer must flush at the test's interval, not the
            # real one, and leaving the block first would race the clear against it.
            wait_for_value(lambda: latest("activity"), "",
                           what="the child's activity to clear")
            self.assertEqual(latest("state"), "running")


# ---------------------------------------------------------------------------------------------------
# Headless snapshots and chat boundaries
# ---------------------------------------------------------------------------------------------------
class HeadlessSnapshotTests(HarnessCase):
    def test_list_agents_snapshot_and_chat_boundaries(self):
        h = self.make()
        h.run("go", [("CHILD", child()),
                     ("go", calls_then([ToolCall("t1", "task", {"description": "one", "prompt": "CHILD"})]))])
        h.backend._emit_agents("agents-restore-1")
        snap = h.of("agents")[-1]
        self.assertEqual((snap["total"], snap["active"], snap["request_id"]), (1, 0, "agents-restore-1"))
        self.assertEqual(snap["items"][0]["state"], "finished")
        self.assertIn("duration_ms", snap["items"][0])
        h.agent.reset()
        h.backend._emit_agents()
        self.assertEqual({k: v for k, v in h.of("agents")[-1].items() if k != "seq"},
                         {"type": "agents", "items": [], "total": 0, "active": 0})
        self.assertFramesValid(h)

    def test_resync_after_a_lost_frame_emits_a_snapshot(self):
        h = self.make()
        with patch.object(h.backend.em, "emit", wraps=h.backend.em.emit) as emit:
            def flaky(name, **fields):
                if name == "agent_started":
                    raise ValueError("invalid protocol event")
                return Emitter.emit(h.em, name, **fields)
            emit.side_effect = flaky
            h.agent.subagents.start(id=sid(9), description="lost")
            time.sleep(0.5)
        self.assertEqual([(f["total"], f["active"]) for f in h.of("agents")], [(1, 1)])

    def test_backend_source_wires_every_boundary(self):
        source = (ROOT / "dgc" / "headless.py").read_text()
        for command, after in (("new_session", "self._emit_monitors()\n            self._emit_agents()"),
                               ("clear_session", "self._emit_monitors()\n            self._emit_agents()"),
                               ("resume_session", "self._emit_history()\n                self._emit_agents()"),
                               ("rewind", "self._emit_history()\n                if agents_before or self._agents_total():"
                                          "   # an empty list has nothing to drop\n                    self._emit_agents()")):
            block = source[source.index(f'elif t == "{command}":'):]
            block = block[:block.index("\n        elif t ==")]
            self.assertIn(after, block, command)
        self.assertIn('elif t == "list_agents":\n            self._emit_agents(request_id)', source)
        self.assertIn("self.agent.subagents.listener = self._on_subagent", source)
        self.assertNotIn('"agents": _B(', (ROOT / "dgc" / "editor_protocol.py").read_text(),
                         "no client opt-in field in v14")


# ---------------------------------------------------------------------------------------------------
# Rebuild from a saved transcript
# ---------------------------------------------------------------------------------------------------
def task_turn(call_id, description, result, *, agent=""):
    args = {"description": description, "prompt": "p"}
    if agent:
        args["agent"] = agent
    messages = [{"role": "user", "content": "do it"},
                {"role": "assistant", "content": "", "tool_calls": [
                    {"id": call_id, "type": "function",
                     "function": {"name": "task", "arguments": json.dumps(args)}}]}]
    if result is not None:
        messages.append({"role": "tool", "tool_call_id": call_id, "content": result})
    messages.append({"role": "assistant", "content": "ok"})
    return messages


class RebuildTests(unittest.TestCase):
    ROWS = [
        ("Sub-task 'a' completed in the shared checkout. Summary:\nfine", ("finished", "")),
        ("Sub-task 'a' completed and integrated 1 path(s): x.py.\nSummary:\nok", ("finished", "")),
        ("Sub-task 'a' completed but was not integrated: cancelled while waiting to integrate.", ("finished", "")),
        ("Sub-task 'a' completed but its changes were NOT integrated: conflict. Conflicts: x.", ("finished", "")),
        ("Sub-task 'a' did not complete: turn cancelled.", ("stopped", "")),
        ("Sub-task 'a' did not complete: cancelled before the isolated run started.", ("stopped", "")),
        ("Sub-task 'a' did not complete: the sub-agent stopped without a final summary.",
         ("failed", "the sub-agent stopped without a final summary.")),
        ("Sub-task 'a' was not started because its isolated configuration could not be created: OSError: x.",
         ("failed", None)),
        ("Sub-task 'a' was not started: another agent holds the lease.", None),
        ("Sub-task 'a' cancelled before it started.", None),
        ("Sub-task 'a' cancelled before its worktree was prepared.", None),
        ("Sub-task 'a' was not started because its isolated Git worktree could not be created: x.", None),
        ("Max sub-agent depth reached — handle this sub-task directly instead.", None),
        ("Something a future DGC wrote.", ("finished", "")),
        (None, ("stopped", "")),
    ]

    def test_every_saved_result_row(self):
        for result, expected in self.ROWS:
            with self.subTest(result=result):
                records = subagents.restore_records([{"role": "system", "content": "s"},
                                                     *task_turn("call_0", "a", result)], "sess")
                if expected is None:
                    self.assertEqual(records, [])
                    continue
                self.assertEqual(len(records), 1)
                record = records[0]
                self.assertEqual(record["state"], expected[0])
                if expected[1] is not None:
                    self.assertEqual(record["message"], expected[1])
                self.assertTrue(record["restored"])
                self.assertEqual((record["depth"], record["parent_id"], record["call_id"]), (1, None, "call_0"))

    def test_repeated_call_ids_pair_positionally_and_ids_are_stable(self):
        messages = [{"role": "system", "content": "s"},
                    *task_turn("call_0", "first", "Sub-task 'first' completed in the shared checkout."),
                    *task_turn("call_0", "second", "Sub-task 'second' did not complete: boom.", agent="reviewer")]
        reg = SubagentRegistry()
        reg.rebuild(messages, "session-1")
        first = reg.snapshot()
        self.assertEqual([(i["description"], i["state"]) for i in first["items"]],
                         [("first", "finished"), ("second", "failed")])
        self.assertEqual(first["items"][1]["agent_type"], "reviewer")
        reg.rebuild(messages, "session-1")
        self.assertEqual([i["id"] for i in reg.snapshot()["items"]], [i["id"] for i in first["items"]])
        for item in first["items"]:
            self.assertRegex(item["id"], r"^sub-[0-9a-f]{12}$")
            self.assertNotIn("elapsed_ms", item)
            self.assertIsNone(ep.event_error({"type": "agents", "seq": 0, **first}))
        self.assertEqual((first["total"], first["active"]), (2, 0))

    def test_rebuild_redacts_and_clips(self):
        secret = "known-secret-value-abcdefghijklmnop"
        messages = task_turn("c", "d " + secret, f"Sub-task 'd {secret}' did not complete: " + "z" * 900)
        reg = SubagentRegistry()
        reg.rebuild(messages, "s", redact=lambda text: text.replace(secret, "[REDACTED]"))
        item = reg.snapshot()["items"][0]
        self.assertEqual(item["description"], "d [REDACTED]")
        self.assertEqual(item["state"], "failed")
        self.assertLessEqual(len(item["message"]), 500)

    def test_rewind_prune_keeps_surviving_live_records(self):
        reg = SubagentRegistry()
        reg.start(id=sid(1), call_id="call_0", description="turn 1")
        reg.end(sid(1), "finished")
        reg.start(id=sid(2), parent_id=sid(1), call_id=f"{sid(1)}:c1", description="nested", depth=2)
        reg.end(sid(2), "finished")
        reg.start(id=sid(3), call_id="call_0", description="turn 2")
        reg.end(sid(3), "failed", "x")
        survivors = task_turn("call_0", "turn 1", "Sub-task 'turn 1' completed.")
        reg.prune_to(survivors)
        snap = reg.snapshot()
        self.assertEqual([i["id"] for i in snap["items"]], [sid(1), sid(2)])
        self.assertTrue(all("duration_ms" in i for i in snap["items"]))
        self.assertEqual(snap["total"], 2)
        reg.prune_to([])
        self.assertEqual(reg.snapshot()["total"], 0)

    def test_rewind_prune_skips_a_surviving_call_that_never_started_an_agent(self):
        # Turn 1's call_0 was denied (no record); turn 2's call_0 started one. Rewinding to the
        # end of turn 1 must drop turn 2's record, not keep it on turn 1's call.
        for result in ("The user DENIED this action. Do not retry it.",
                       "Max sub-agent depth reached — handle this sub-task directly instead.",
                       "BLOCKED by a PreToolUse hook: no"):
            with self.subTest(result=result):
                reg = SubagentRegistry()
                reg.start(id=sid(2), call_id="call_0", description="real one")
                reg.end(sid(2), "finished")
                survivors = [{"role": "system", "content": "s"}, *task_turn("call_0", "denied", result)]
                reg.prune_to(survivors)
                snap = reg.snapshot()
                self.assertEqual((snap["total"], snap["items"]), (0, []))
        # A surviving call with no result yet (the turn was cut) still keeps its record.
        reg = SubagentRegistry()
        reg.start(id=sid(3), call_id="call_0", description="cut")
        reg.end(sid(3), "stopped")
        reg.prune_to(task_turn("call_0", "cut", None))
        self.assertEqual([i["id"] for i in reg.snapshot()["items"]], [sid(3)])
        # Denied in turn 1, started in turn 2, both surviving: the started one stays.
        reg = SubagentRegistry()
        reg.start(id=sid(4), call_id="call_0", description="second")
        reg.end(sid(4), "finished")
        reg.prune_to([*task_turn("call_0", "first", "PERMISSION DENIED: task"),
                      *task_turn("call_0", "second", "Sub-task 'second' completed.")])
        self.assertEqual([i["id"] for i in reg.snapshot()["items"]], [sid(4)])

    def test_saved_child_log_round_trips_for_the_inner_page(self):
        reg = SubagentRegistry()
        rid = sid(1)
        reg.start(id=rid, call_id="call_0", description="map auth")
        reg.append_log(rid, {"type": "tool_call", "call_id": f"{rid}:g1", "name": "grep",
                             "summary": "login"})
        reg.append_log(rid, {"type": "tool_result", "call_id": f"{rid}:g1", "name": "grep",
                             "output": "app.ts:4", "is_error": False})
        reg.end(rid, "finished", "Mapped auth.\nFILES: app.ts")
        saved = reg.saved_state()
        self.assertEqual(saved["items"][0]["log"][0]["name"], "grep")
        other = SubagentRegistry()
        self.assertTrue(other.restore_state(saved))
        item = other.snapshot()["items"][0]
        self.assertEqual(item["restored"], True)
        self.assertEqual(item["log"][1]["output"], "app.ts:4")
        self.assertIsNone(ep.event_error({"type": "agents", "seq": 0, **other.snapshot()}))


class AgentBoundaryTests(HarnessCase):
    def test_resume_rebuilds_rewind_prunes_reset_clears(self):
        h = self.make()
        from dgc import sessions
        session = sessions.new_path(h.root)
        h.agent.session_file = session
        h.run("go", [("CHILD", child()),
                     ("go", calls_then([ToolCall("t1", "task", {"description": "one", "prompt": "CHILD"})]))])
        self.assertTrue(session.exists())
        other = Agent(h.config, HeadlessUI(Emitter(_Stream(), validator=ep.event_error), PendingRequests()))
        self.addCleanup(other.mcp.stop_all)
        other.load_session(session)
        snap = other.subagents.snapshot()
        self.assertEqual([(i["description"], i["state"], i["restored"]) for i in snap["items"]],
                         [("one", "finished", True)])
        h.agent.reset()
        self.assertEqual(h.agent.subagents.snapshot()["total"], 0)


# ---------------------------------------------------------------------------------------------------
# A real `dgc serve`
# ---------------------------------------------------------------------------------------------------
def _sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "choices": [
        {"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


class ServeTests(unittest.TestCase):
    """`dgc serve` over stdio with a local OpenAI-compatible mock: two parallel tasks in auto mode."""

    def test_serve_emits_agent_frames_and_snapshots(self):
        hold = threading.Event()

        class Model(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, body, kind):
                data = body.encode()
                self.send_response(200)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                self._send(json.dumps({"data": [{"id": "mock-model"}]}), "application/json")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
                messages = body.get("messages") or []
                users = [m for m in messages if m.get("role") == "user"
                         and "<system-reminder>" not in str(m.get("content", ""))]
                first = str(users[0].get("content", "")) if users else ""
                last = str(users[-1].get("content", "")) if users else ""
                answered = any(m.get("role") == "tool" for m in messages[messages.index(users[-1]) + 1:]) \
                    if users else False
                if "CHILD" in first:
                    hold.wait(20)
                    payload = _sse({"content": "child summary"}) + _sse({}, "stop") + "data: [DONE]\n\n"
                elif "delegate" in last and not answered:
                    calls = [{"index": n, "id": f"call_{n}", "type": "function", "function": {
                        "name": "task", "arguments": json.dumps({"description": f"part {n}",
                                                                 "prompt": f"CHILD {n}"})}}
                             for n in range(2)]
                    payload = _sse({"tool_calls": calls}) + _sse({}, "tool_calls") + "data: [DONE]\n\n"
                else:
                    payload = _sse({"content": "Done."}) + _sse({}, "stop") + "data: [DONE]\n\n"
                self._send(payload, "text/event-stream")

        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(hold.set)
        base = Path(tempfile.mkdtemp(prefix="dgc-agents-serve-"))
        home, work = base / "home", base / "work"
        home.mkdir()
        work.mkdir()
        git_repo(work)
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{server.server_address[1]}/v1", "model": "mock-model",
            "api_mode": "chat_completions", "suggest": False, "notes": False, "max_parallel_tasks": 2}))
        env = dict(os.environ, HOME=str(home), PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(home)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(work), env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                text=True)
        events, arrived = [], queue.Queue()

        def read():
            for line in proc.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                events.append(event)
                arrived.put(event)
        threading.Thread(target=read, daemon=True).start()

        def send(command):
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def wait(predicate, timeout=60):
            deadline = time.monotonic() + timeout
            seen = 0
            while time.monotonic() < deadline:
                for event in events[seen:]:
                    seen += 1
                    if predicate(event):
                        return event
                try:
                    arrived.get(timeout=0.05)
                except queue.Empty:
                    pass
            return None

        def after(marker):
            return events[events.index(marker) + 1:] if marker in events else []

        def cleanup():
            hold.set()
            try:
                proc.stdin.close()
                proc.wait(timeout=40)
            except (OSError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait(timeout=10)
            proc.stdout.close()
            import shutil
            shutil.rmtree(base, ignore_errors=True)
        self.addCleanup(cleanup)

        ready = wait(lambda e: e["type"] == "ready")
        self.assertTrue(ready and ready["capabilities"]["agents"])
        send({"type": "set_mode", "mode": "auto", "acknowledge_workspace_trust": True, "request_id": "m"})
        self.assertTrue(wait(lambda e: e["type"] == "mode_changed"))
        send({"type": "prompt", "text": "say hello", "request_id": "p0"})
        first_end = wait(lambda e: e["type"] == "turn_end")
        self.assertTrue(first_end)
        self.assertFalse([e for e in events if e["type"] in AGENT_FRAMES], "no task, no agent frames")

        send({"type": "prompt", "text": "delegate two parts", "request_id": "p1"})
        running_ids = set()

        def both_running(event):
            if event["type"] == "agent_updated" and event["state"] == "running":
                running_ids.add(event["id"])
            return len(running_ids) == 2
        self.assertTrue(wait(both_running))
        send({"type": "list_agents", "request_id": "busy-1"})
        busy = wait(lambda e: e["type"] == "agents" and e.get("request_id") == "busy-1", 20)
        self.assertTrue(busy and busy["total"] == 2 and busy["active"] == 2, busy)
        hold.set()
        end = wait(lambda e: e["type"] == "turn_end" and e is not first_end)
        self.assertTrue(end)
        turn = events[events.index(first_end) + 1:events.index(end)]
        started = [e for e in turn if e["type"] == "agent_started"]
        ended = [e for e in turn if e["type"] == "agent_ended"]
        results = [i for i, e in enumerate(turn) if e["type"] == "tool_result" and e["name"] == "task"]
        self.assertEqual(len(started), 2)
        self.assertEqual([e["state"] for e in ended], ["finished", "finished"])
        self.assertTrue(results and all(turn.index(e) < results[0] for e in ended))
        self.assertNotIn(None, [e.get("turn_id") for e in started])
        for event in events:
            self.assertIsNone(ep.event_error(event), event)

        send({"type": "list_agents", "request_id": "after-1"})
        listed = wait(lambda e: e["type"] == "agents" and e.get("request_id") == "after-1")
        self.assertEqual((listed["total"], listed["active"]), (2, 0))

        send({"type": "prompt", "text": "one more thing", "request_id": "p2"})
        third_end = wait(lambda e: e["type"] == "turn_end" and e not in (first_end, end))
        self.assertTrue(third_end)
        send({"type": "list_checkpoints", "request_id": "cps"})
        checkpoints = wait(lambda e: e["type"] == "checkpoints" and e.get("request_id") == "cps")
        self.assertTrue(checkpoints and checkpoints["items"], checkpoints)
        marker = events[-1]
        send({"type": "rewind", "index": checkpoints["items"][-1]["index"], "request_id": "rw"})
        rewound = wait(lambda e: e["type"] == "rewound" and e.get("request_id") == "rw")
        self.assertTrue(rewound and rewound["ok"], rewound)
        snapshot = wait(lambda e: e["type"] == "agents" and e is not listed and e is not busy
                        and e in after(marker))
        kinds = [e["type"] for e in after(rewound)]
        self.assertLess(kinds.index("history"), kinds.index("agents"))
        self.assertEqual(snapshot["total"], 2)
        self.assertTrue(all("duration_ms" in item and not item["restored"] for item in snapshot["items"]))

        session_id = rewound and next(e for e in reversed(events) if e["type"] in ("ready", "session")
                                      and e.get("session_id"))["session_id"]
        marker = events[-1]
        send({"type": "new_session", "request_id": "new"})
        empty = wait(lambda e: e["type"] == "agents" and e in after(marker))
        self.assertEqual((empty["items"], empty["total"], empty["active"]), ([], 0, 0))
        marker = events[-1]
        send({"type": "resume_session", "latest": True, "request_id": "resume"})
        resumed = wait(lambda e: e["type"] == "session" and e.get("kind") == "resumed")
        self.assertTrue(resumed, [e["type"] for e in events[-10:]])
        restored = wait(lambda e: e["type"] == "agents" and e in after(resumed))
        kinds = [e["type"] for e in after(resumed)]
        self.assertLess(kinds.index("history"), kinds.index("agents"))
        self.assertEqual(resumed["session_id"], session_id)
        self.assertEqual([(i["state"], i["restored"]) for i in restored["items"]],
                         [("finished", True), ("finished", True)])
        marker = events[-1]
        send({"type": "clear_session", "request_id": "clear"})
        cleared = wait(lambda e: e["type"] == "agents" and e in after(marker))
        self.assertEqual((cleared["items"], cleared["total"], cleared["active"]), ([], 0, 0))
        for event in events:
            self.assertIsNone(ep.event_error(event), event)


# ---------------------------------------------------------------------------------------------------
# TUI and the classic REPL
# ---------------------------------------------------------------------------------------------------
def bare_tui():
    from tests.test_model_stall import FrontEndTests
    return FrontEndTests.bare_tui(None)


def plain(markup: str) -> str:
    from rich.text import Text
    return Text.from_markup(markup).plain


def registry_with(running=0, waiting=0, finished=0, failed=0):
    reg = SubagentRegistry()
    n = 0
    for _ in range(running + waiting):
        reg.start(id=sid(n), description=f"a{n}")
        n += 1
    for k in range(waiting):
        reg.waiting(sid(running + k), "permission")
    for state, count in (("finished", finished), ("failed", failed)):
        for _ in range(count):
            reg.start(id=sid(n), description=f"e{n}")
            reg.end(sid(n), state)
            n += 1
    return reg


class TuiTests(unittest.TestCase):
    def segment(self, reg, width=120):
        tui = bare_tui()
        tui._width = width
        tui.agent = SimpleNamespace(subagents=reg)
        return tui._agents_segment()

    def test_shortcut_segment_forms(self):
        from dgc import style as style_mod
        th = style_mod.theme()
        self.assertEqual(self.segment(SubagentRegistry()), "")
        two = self.segment(registry_with(running=2))
        self.assertEqual(plain(two), f"{glyphs.AGENT_RUN} 2 agents")
        self.assertIn(f"[{th.ok}]{glyphs.AGENT_RUN}[/]", two)
        self.assertEqual(plain(self.segment(registry_with(running=2, finished=3))),
                         f"{glyphs.AGENT_RUN} 2 agents")
        waiting = self.segment(registry_with(running=1, waiting=1, finished=3))
        self.assertEqual(plain(waiting), f"{glyphs.AGENT_WAIT} 2 agents · 1 needs you")
        self.assertIn(f"[bold {th.err}]", waiting)
        idle = self.segment(registry_with(finished=4, failed=1))
        self.assertEqual(plain(idle), "")
        self.assertEqual(plain(self.segment(registry_with(running=2), width=60)), f"{glyphs.AGENT_RUN}2")
        self.assertEqual(plain(self.segment(registry_with(running=2, finished=3), width=60)),
                         f"{glyphs.AGENT_RUN}2")
        self.assertEqual(plain(self.segment(registry_with(running=1, waiting=1, finished=3), width=60)),
                         f"{glyphs.AGENT_WAIT}2")
        with patch.multiple(glyphs, AGENT_RUN="*", AGENT_WAIT="!", AGENT_IDLE="o"):
            self.assertEqual(plain(self.segment(registry_with(running=2), width=60)), "*2")
            self.assertEqual(plain(self.segment(registry_with(running=2))), "* 2 agents")

    def test_shortcut_bar_carries_the_segment_before_the_fleet(self):
        from prompt_toolkit.formatted_text import to_formatted_text
        tui = bare_tui()
        tui._quit_armed = 0.0
        tui._mouse_on = True
        tui._overlay = None
        tui._pane = None
        tui._pane_visible = lambda: False
        fields = dict(_req=None, _turn=threading.Event(), state="running")
        active = SimpleNamespace(agent=SimpleNamespace(subagents=registry_with(running=2)), **fields)
        background = SimpleNamespace(agent=SimpleNamespace(subagents=registry_with(running=1, waiting=2)),
                                     **{**fields, "_turn": threading.Event()})
        tui._sessions = [active, background]
        tui._active_idx = 0
        tui._tls = threading.local()
        text = "".join(part[1] for part in to_formatted_text(tui._shortcut_bar()))
        self.assertIn(f"{glyphs.AGENT_RUN} 2 agents", text)
        self.assertNotIn("3 agents", text, "a background session's agents stay off the active bar")
        self.assertLess(text.index("2 agents"), text.index("⧉"))
        self.assertGreater(text.index("2 agents"), text.index("Enter"), "wide: the count follows the chips")
        self.assertEqual(TUI_cls()._agents_working_desc(background.agent), " · 3 agents working")
        self.assertEqual(TUI_cls()._agents_working_desc(SimpleNamespace(subagents=registry_with(running=1))),
                         " · 1 agent working")
        self.assertEqual(TUI_cls()._agents_working_desc(SimpleNamespace(subagents=registry_with(finished=1))), "")

    def test_narrow_bar_leads_with_the_compact_count(self):
        # The bar is cut at the terminal's edge; at 60 columns the idle chips alone fill it.
        from prompt_toolkit.formatted_text import to_formatted_text
        from rich.cells import cell_len
        tui = bare_tui()
        tui._quit_armed = 0.0
        tui._mouse_on = True
        tui._overlay = None
        tui._pane = None
        tui._pane_visible = lambda: False
        tui._req = None
        tui._turn = threading.Event()
        tui._sessions = []
        tui._active_idx = 0
        tui._tls = threading.local()
        tui._width = 60
        for reg, segment in ((registry_with(finished=3), ""),
                             (registry_with(running=2, finished=1), f"{glyphs.AGENT_RUN}2"),
                             (registry_with(running=1, waiting=1), f"{glyphs.AGENT_WAIT}2")):
            with self.subTest(segment=segment):
                tui.agent = SimpleNamespace(subagents=reg)
                text = "".join(part[1] for part in to_formatted_text(tui._shortcut_bar()))
                self.assertIn(segment, text)
                self.assertLessEqual(cell_len(text[:text.index(segment) + len(segment)]), 60,
                                     "the count is inside a 60-column bar")
                self.assertLess(text.index(segment), text.index("send"))
        tui.agent = SimpleNamespace(subagents=SubagentRegistry())
        self.assertTrue("".join(p[1] for p in to_formatted_text(tui._shortcut_bar())).startswith("  Enter"),
                        "no agents: the bar is unchanged")

    def test_dashboard_row_says_how_many_agents_work(self):
        from dgc import artifacts, sessions
        tui = bare_tui()
        captured = {}
        tui._open_overlay = lambda rows, **kwargs: captured.setdefault("rows", rows)
        tui._context_window_size = lambda: 10000
        tui._ctx_color = lambda pct, th: th.ok
        tui._model_label = lambda: "fixture"
        tui.config = fixture_config(Path(tempfile.gettempdir()))
        tui._fleet_root = Path(tempfile.gettempdir())
        busy = SimpleNamespace(agent=SimpleNamespace(subagents=registry_with(running=1), messages=[],
                                                     session_file=None, estimate_tokens=lambda: 10,
                                                     mode="auto"),
                               config=fixture_config(Path(tempfile.gettempdir())),
                               state="running", pinned=False, last_activity=1.0, name="busy",
                               _tool_count=0, workspace_branch="")
        tui._sessions = [busy]
        tui._active_idx = 0
        tui._tls = threading.local()
        with patch.object(artifacts, "registry", return_value=[]), \
                patch.object(sessions, "listing", return_value=[]):
            tui._open_dashboard()
        descs = [row.get("desc", "") for row in captured["rows"]]
        self.assertTrue(any("· 1 agent working" in desc for desc in descs), descs)

    def test_agents_command_lists_the_chat_first_and_runs_mid_turn(self):
        from dgc.commands import resolve_command
        spec = resolve_command("agents", "tui")
        self.assertTrue(spec.available_while_running)
        reg = SubagentRegistry()
        reg.start(id=sid(1), description="review \x1b[31mauth\x1b[0m [bold]module[/]", agent_type="reviewer")
        reg.progress(sid(1), tool_calls=14, tokens=18200)
        reg.start(id=sid(2), parent_id=sid(1), description="check the tests", depth=2)
        reg.waiting(sid(2), "permission")
        reg.start(id=sid(3), description="write migration")
        reg.end(sid(3), "finished", tool_calls=9)
        reg.start(id=sid(4), description="port docs")
        reg.end(sid(4), "failed", "the sub-agent stopped without a final summary")
        tui = bare_tui()
        tui.agent = SimpleNamespace(subagents=reg, agent_defs={})
        tui.config = fixture_config(Path(tempfile.gettempdir()))
        listing = plain(tui._agents_listing())
        lines = listing.splitlines()
        self.assertEqual(lines[0], "agents in this chat · 4 agents · 1 working · "
                                   "1 waiting for your permission · 1 finished · 1 failed")
        self.assertNotIn("\x1b", listing)
        self.assertIn("[bold]module[/]", listing, "markup in a description is text")
        self.assertIn(f"  {glyphs.AGENT_RUN} review", lines[1])
        self.assertIn("reviewer", lines[1])
        self.assertIn("14 tools", lines[1])
        self.assertIn(f"    {glyphs.AGENT_WAIT} check the tests", lines[2])
        self.assertIn("waiting for your permission", lines[2])
        self.assertIn(f"  {glyphs.CHECK} write migration", lines[3])
        self.assertIn(f"  {glyphs.CROSS} port docs", lines[4])
        self.assertIn("failed · the sub-agent stopped without a final summary", lines[4])

        # typed while a turn runs: it runs instead of "waits for this turn to finish"
        appended, flashed = [], []
        tui._append = appended.append
        tui._flash = flashed.append
        tui._turn.set()
        tui._sessions = []
        handled = tui._handle_running_local_command("/agents")
        self.assertTrue(handled)
        self.assertFalse([f for f in flashed if "waits for this turn" in f], flashed)
        self.assertTrue(appended and "agents in this chat" in re.sub(r"\x1b\[[0-9;]*m", "", appended[0]),
                        appended)

    def test_classic_repl_lists_the_chat_agents(self):
        from dgc import cli
        from rich.console import Console
        repl = object.__new__(cli.CLI)
        buf = io.StringIO()
        repl.console = Console(file=buf, force_terminal=False, width=120)
        repl.config = fixture_config(Path(tempfile.gettempdir()))
        repl.agent = SimpleNamespace(subagents=registry_with(running=1, finished=1), agent_defs={})
        repl.ui = SimpleNamespace(info=lambda *a, **k: None)
        repl.handle_slash("/agents")
        out = buf.getvalue()
        self.assertIn("agents in this chat · 2 agents · 1 working · 1 finished", out)
        self.assertLess(out.index("agents in this chat"), out.index("Sub-agent defaults"))


def TUI_cls():
    from dgc.tui import TUI
    return TUI


if __name__ == "__main__":
    unittest.main()
