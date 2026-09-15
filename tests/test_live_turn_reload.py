"""A panel reloaded while a turn waits on the user: one real `dgc serve` against a scripted
OpenAI-compatible model on 127.0.0.1 (port 0), in a throwaway HOME and project.

A webview that reloads mid-turn asks for `get_history`. The running turn must replay open (no
`turn_end`, the live turn id), and every decision the turn is still blocked on (a question, a
permission) must be announced again, with its original id, right after the snapshot, followed by
the turn's activity. Answering the re-announced request finishes the turn. A snapshot taken while
nothing runs closes every turn and announces nothing. Every frame and history item passes
editor_protocol.event_error.
"""
import json
import os
import queue
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from dgc import editor_protocol as ep

ROOT = Path(__file__).resolve().parents[1]
QUESTION = {"questions": [{"header": "Database", "question": "Which database?", "options": [
    {"label": "SQLite (Recommended)", "description": "One file, nothing to run."},
    {"label": "Postgres", "description": "A server to operate."}]}]}


def sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "model": "mock-model",
                                  "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


def call(name, args, call_id):
    return (sse({"tool_calls": [{"index": 0, "id": call_id, "type": "function",
                                 "function": {"name": name, "arguments": json.dumps(args)}}]})
            + sse({}, "tool_calls") + "data: [DONE]\n\n")


def text(value):
    return sse({"content": value}) + sse({}, "stop") + "data: [DONE]\n\n"


class Model(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, body, kind="text/event-stream", status=200):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            pass

    def do_GET(self):
        if self.path.endswith("/models"):
            return self._send(json.dumps({"data": [{"id": "mock-model"}]}), "application/json")
        return self._send(json.dumps({"error": {"message": "no route"}}), "application/json", 404)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0) or b"{}")
        msgs = body.get("messages") or []
        prompts = [m for m in msgs if m.get("role") == "user" and isinstance(m.get("content"), str)
                   and m["content"].lstrip().startswith("TURN_")]
        if not body.get("tools") or not prompts:
            return self._send(text("Title"))
        last = prompts[-1]["content"].lstrip()
        answered = any(m.get("role") == "tool" for m in msgs[msgs.index(prompts[-1]) + 1:])
        if answered:
            return self._send(text("Done."))
        if last.startswith("TURN_ASK"):
            return self._send(call("propose_options", QUESTION, "call_ask_1"))
        if last.startswith("TURN_RUN"):
            return self._send(call("bash", {"command": "echo reload-probe"}, "call_bash_1"))
        if last.startswith("TURN_BATCH"):
            batch = [("read_file", {"path": "README.md"}, "call_read_1"),
                     ("bash", {"command": "echo batch-probe"}, "call_bash_2"),
                     ("glob", {"pattern": "*.md"}, "call_glob_3")]
            return self._send(sse({"tool_calls": [
                {"index": n, "id": cid, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}
                for n, (name, args, cid) in enumerate(batch)]}) + sse({}, "tool_calls") + "data: [DONE]\n\n")
        if last.startswith("TURN_PLAN"):
            return self._send(call("present_plan", {"plan": "1. Add the cache\n2. Test it"}, "call_plan_1"))
        return self._send(text("Hello."))


class LiveTurnReloadTests(unittest.TestCase):
    def setUp(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base = Path(tempfile.mkdtemp(prefix="dgc-live-reload-"))
        home, work = self.base / "home", self.base / "work"
        home.mkdir()
        work.mkdir()
        (work / "README.md").write_text("fixture\n")
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{self.server.server_address[1]}/v1", "model": "mock-model",
            "api_key": "sk-fixture-0123456789abcdef", "api_mode": "chat_completions", "suggest": False,
            "notes": False, "mode": "default", "artifact_autostart": False, "eta": False}))
        env = dict(os.environ, HOME=str(home), PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(home)
        for var in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
            env.pop(var, None)
        self.stderr = open(self.base / "stderr.log", "w")
        self.proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(work), env=env,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.stderr, text=True)
        self.events, self.q = [], queue.Queue()

        def read():
            for line in self.proc.stdout:
                try:
                    ev = json.loads(line)
                except ValueError:
                    ev = {"type": "__bad__", "line": line}
                self.events.append(ev)
                self.q.put(ev)
        threading.Thread(target=read, daemon=True).start()
        self.wait(lambda e: e.get("type") == "ready", 60)

    def tearDown(self):
        try:
            self.proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=30)
        except Exception:
            self.proc.kill()
        self.server.shutdown()
        self.stderr.close()
        shutil.rmtree(self.base, ignore_errors=True)

    def send(self, cmd):
        self.assertIsNone(ep.command_error(cmd), cmd)
        self.proc.stdin.write(json.dumps(cmd) + "\n")
        self.proc.stdin.flush()

    def wait(self, pred, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            try:
                ev = self.q.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                break
            if pred(ev):
                return ev
        raise TimeoutError("timed out waiting for an event")

    def snapshot(self, request_id):
        """get_history, then every frame up to and including the next `turn_activity` (or 1 s)."""
        start = len(self.events)
        self.send({"type": "get_history", "request_id": request_id})
        history = self.wait(lambda e: e.get("type") == "history" and e.get("request_id") == request_id)
        after = self.events.index(history) + 1
        try:
            self.wait(lambda e: e.get("type") == "turn_activity", 1.0)
        except TimeoutError:
            pass
        return history, self.events[after:], self.events[start:after]

    def assert_frames_valid(self, history):
        bad = [(e.get("type"), ep.event_error(e)) for e in self.events if e.get("type") == "__bad__" or ep.event_error(e)]
        self.assertEqual(bad, [])
        items = [i for i in history["items"] if isinstance(i.get("type"), str)]
        self.assertEqual([(i["type"], ep.event_error({**i, "seq": 0})) for i in items
                          if ep.event_error({**i, "seq": 0})], [])
        return items

    @staticmethod
    def turns(items):
        out = []
        for item in items:
            if item["type"] == "turn_start":
                out.append([])
            if out:
                out[-1].append(item)
        return out

    def test_a_question_and_a_permission_survive_a_reload(self):
        self.send({"type": "prompt", "text": "TURN_HELLO say hello"})
        self.wait(lambda e: e.get("type") == "turn_end")

        # A question the turn is blocked on.
        self.send({"type": "prompt", "text": "TURN_ASK pick a database"})
        live_start = self.wait(lambda e: e.get("type") == "turn_start" and e.get("prompt", "").startswith("TURN_ASK"))
        asked = self.wait(lambda e: e.get("type") == "options_request")
        history, after, _ = self.snapshot("reload-1")
        items = self.assert_frames_valid(history)
        turns = self.turns(items)
        self.assertEqual(len(turns), 2, [[i["type"] for i in t] for t in turns])
        self.assertEqual(turns[0][-1]["type"], "turn_end", "the finished turn replays closed")
        self.assertEqual(turns[0][-1]["reason"], "completed")
        running = turns[1]
        self.assertNotIn("turn_end", [i["type"] for i in running], "the running turn has no turn_end")
        self.assertEqual({i["turn_id"] for i in running if "turn_id" in i}, {live_start["turn_id"]},
                         "the running turn replays under the live turn id")
        self.assertTrue(any(i["type"] == "tool_call" and i["name"] == "propose_options" for i in running))
        self.assertFalse(any(i["type"] in ("tool_result", "options_resolved") for i in running))
        again = [e for e in after if e.get("type") == "options_request"]
        self.assertEqual(len(again), 1, [e.get("type") for e in after])
        self.assertEqual({k: v for k, v in again[0].items() if k != "seq"},
                         {k: v for k, v in asked.items() if k != "seq"}, "the same request, announced again")
        activity = [e for e in after if e.get("type") == "turn_activity"]
        self.assertTrue(activity and activity[0]["turn_id"] == live_start["turn_id"]
                        and activity[0]["label"] == "Waiting for your answer", activity)
        self.assertLess(after.index(again[0]), after.index(activity[0]))
        self.assertFalse(any(e.get("type") == "turn_end" for e in self.events[self.events.index(live_start):]),
                         "the snapshot did not end the turn")

        self.send({"type": "options_response", "id": again[0]["id"], "answers": {asked["questions"][0]["id"]: {"selected": [0]}}})
        ended = self.wait(lambda e: e.get("type") == "turn_end")
        self.assertEqual((ended["turn_id"], ended["reason"]), (live_start["turn_id"], "completed"))

        # Nothing runs now: every turn closes and nothing is announced again.
        history, after, _ = self.snapshot("idle-1")
        items = self.assert_frames_valid(history)
        self.assertTrue(all(t[-1]["type"] == "turn_end" for t in self.turns(items)))
        self.assertTrue(any(i["type"] == "options_resolved" and i["outcome"] == "answered" for i in items))
        self.assertFalse([e for e in after if e.get("type") in ("options_request", "permission_request", "turn_activity")])

        # A permission the turn is blocked on.
        self.send({"type": "prompt", "text": "TURN_RUN run the probe"})
        live_start = self.wait(lambda e: e.get("type") == "turn_start" and e.get("prompt", "").startswith("TURN_RUN"))
        requested = self.wait(lambda e: e.get("type") == "permission_request")
        history, after, _ = self.snapshot("reload-2")
        items = self.assert_frames_valid(history)
        running = self.turns(items)[-1]
        self.assertEqual(running[0]["turn_id"], live_start["turn_id"])
        self.assertNotIn("turn_end", [i["type"] for i in running])
        again = [e for e in after if e.get("type") == "permission_request"]
        self.assertEqual(len(again), 1, [e.get("type") for e in after])
        self.assertEqual(again[0]["id"], requested["id"])
        self.assertEqual(again[0]["command"], "echo reload-probe")
        self.send({"type": "permission_response", "id": requested["id"], "decision": "once"})
        ended = self.wait(lambda e: e.get("type") == "turn_end")
        self.assertEqual((ended["turn_id"], ended["reason"]), (live_start["turn_id"], "completed"))
        results = [e for e in self.events if e.get("type") == "tool_result" and e.get("name") == "bash"]
        self.assertTrue(results and "reload-probe" in results[-1]["output"], results)
        self.assert_frames_valid(history)

    def test_a_step_still_waiting_on_its_card_gets_no_row_on_reload(self):
        # The model's message names every call of its batch up front, but live a step appears only
        # when it starts. A snapshot of the running turn replays the calls that have shown a row
        # (with or without a result) and leaves out the one waiting on its permission card and the
        # one after it, so the live tool_call that follows approval is the only row for that step.
        self.send({"type": "prompt", "text": "TURN_BATCH read then run"})
        live_start = self.wait(lambda e: e.get("type") == "turn_start")
        requested = self.wait(lambda e: e.get("type") == "permission_request")
        self.assertEqual(requested["call_id"], "call_bash_2")
        shown_before = [e["call_id"] for e in self.events if e.get("type") == "tool_call"]
        self.assertEqual(shown_before, ["call_read_1"], "live: only the read has a row while bash waits")
        history, after, _ = self.snapshot("reload-batch")
        running = self.turns(self.assert_frames_valid(history))[-1]
        self.assertEqual(running[0]["turn_id"], live_start["turn_id"])
        self.assertEqual([i["call_id"] for i in running if i["type"] == "tool_call"], ["call_read_1"])
        self.assertEqual([i["call_id"] for i in running if i["type"] == "tool_result"], ["call_read_1"])
        self.assertEqual([e["id"] for e in after if e.get("type") == "permission_request"], [requested["id"]])
        self.send({"type": "permission_response", "id": requested["id"], "decision": "once"})
        ended = self.wait(lambda e: e.get("type") == "turn_end")
        self.assertEqual((ended["turn_id"], ended["reason"]), (live_start["turn_id"], "completed"))
        live_calls = [e["call_id"] for e in self.events[self.events.index(live_start):] if e.get("type") == "tool_call"]
        self.assertEqual(live_calls, ["call_read_1", "call_bash_2", "call_glob_3"], "one live row per step")
        # Once the turn is over, replay and live agree on the rows.
        history, _, _ = self.snapshot("idle-batch")
        finished = self.turns(self.assert_frames_valid(history))[-1]
        self.assertEqual([i["call_id"] for i in finished if i["type"] == "tool_call"], live_calls)
        self.assertEqual(finished[-1]["type"], "turn_end")

        # A plan waiting on review: live shows no step row for present_plan, and neither does the reload.
        self.send({"type": "set_mode", "mode": "plan"})
        self.send({"type": "prompt", "text": "TURN_PLAN make a plan"})
        live_start = self.wait(lambda e: e.get("type") == "turn_start" and e.get("prompt", "").startswith("TURN_PLAN"))
        proposal = self.wait(lambda e: e.get("type") == "plan_proposal")
        history, after, _ = self.snapshot("reload-plan")
        running = self.turns(self.assert_frames_valid(history))[-1]
        self.assertEqual(running[0]["turn_id"], live_start["turn_id"])
        self.assertNotIn("turn_end", [i["type"] for i in running])
        self.assertEqual([i for i in running if i["type"] in ("tool_call", "tool_result")], [])
        self.assertEqual([e["id"] for e in after if e.get("type") == "plan_proposal"], [proposal["id"]])
        self.send({"type": "plan_response", "id": proposal["id"], "decision": "default"})
        ended = self.wait(lambda e: e.get("type") == "turn_end")
        self.assertEqual((ended["turn_id"], ended["reason"]), (live_start["turn_id"], "completed"))


if __name__ == "__main__":
    unittest.main()
