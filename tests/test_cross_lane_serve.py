"""The five 0.40 features in one real `dgc serve` against a scripted OpenAI-compatible model on
127.0.0.1 (port 0), in a throwaway HOME and Git project.

Turn 1 (auto mode, Git project): a refused request (503) that is retried, reasoning deltas, two
parallel `task` sub-agents, a `view_image` of a workspace PNG, and a final answer whose stream is cut
once and continued. Turn 2: a `propose_options` question the client dismisses.

Every live frame must pass editor_protocol.event_error; get_history must replay thinking_end,
model_retry (the stream cut), tool_images and options_resolved in spec §1.6 order, and every item
must pass event_error({**item, "seq": 0}). No private `_dgc_*` transcript key reaches a request body.
"""
import base64
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
from dgc.workflows import STREAM_RECOVERY_TEXT

ROOT = Path(__file__).resolve().parents[1]

PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==")
LOCK = threading.Lock()
STATE = {"refused": 0, "cut": 0}
REQUESTS = []
FAILS = []


def check(name, ok, detail=None):
    if not ok:
        FAILS.append(name + ("" if detail is None else " :: " + json.dumps(detail, default=str)[:1200]))


def sse(delta, finish=None):
    return "data: " + json.dumps({"id": "m", "object": "chat.completion.chunk", "model": "mock-model",
                                  "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}) + "\n\n"


def calls(items, thinking=""):
    out = [sse({"reasoning_content": thinking})] if thinking else []
    out.append(sse({"tool_calls": [{"index": n, "id": f"call_{name}_{n}", "type": "function",
                                    "function": {"name": name, "arguments": json.dumps(args)}}
                                   for n, (name, args) in enumerate(items)]}))
    return "".join(out) + sse({}, "tool_calls") + "data: [DONE]\n\n"


def text(value, thinking="", done=True):
    out = [sse({"reasoning_content": thinking})] if thinking else []
    out.append(sse({"content": value}))
    if done:
        out.append(sse({}, "stop") + "data: [DONE]\n\n")
    return "".join(out)


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
        raw = self.rfile.read(int(self.headers.get("Content-Length", 0)) or 0)
        body = json.loads(raw or b"{}")
        msgs = body.get("messages") or []
        REQUESTS.append({"path": self.path, "messages": len(msgs), "tools": bool(body.get("tools")),
                         "private_keys": [k for m in msgs for k in m if str(k).startswith("_")]})
        prompts = [m for m in msgs if m.get("role") == "user" and isinstance(m.get("content"), str)
                   and m["content"].lstrip().startswith(("TURN_", "CHILD"))]
        first = prompts[0]["content"].lstrip() if prompts else ""
        if not body.get("tools") and not first:
            return self._send(text("Title"))                      # an auxiliary request
        if first.startswith("CHILD"):
            time.sleep(0.6)
            return self._send(text("child summary", thinking="Child thinking."))
        last_prompt = prompts[-1]["content"].lstrip() if prompts else ""
        tail = msgs[msgs.index(prompts[-1]) + 1:] if prompts else []
        names = [c.get("function", {}).get("name") for m in tail if m.get("role") == "assistant"
                 for c in (m.get("tool_calls") or [])]
        if last_prompt.startswith("TURN_TWO"):
            return self._send(calls([("propose_options", {"questions": [{"header": "Database", "question": "Which database?",
                "options": [{"label": "SQLite (Recommended)", "description": "One file, nothing to run."},
                            {"label": "Postgres", "description": "A server to operate."}]}]})], thinking="A choice for the user."))
        if msgs and msgs[-1].get("role") == "user" and msgs[-1].get("content") == STREAM_RECOVERY_TEXT:
            return self._send(text("ne."))
        if "view_image" in names:
            with LOCK:
                STATE["cut"] += 1
                first_cut = STATE["cut"] == 1
            if first_cut:
                return self._send(text("All do", done=False))    # no finish, no [DONE]: a cut stream
            return self._send(text("All done."))
        if "task" in names:
            return self._send(calls([("view_image", {"path": "shot.png"})], thinking="Now the screenshot."))
        with LOCK:
            STATE["refused"] += 1
            refuse = STATE["refused"] == 1
        if refuse:
            return self._send(json.dumps({"error": {"message": "server busy, try again later"}}), "application/json", 503)
        return self._send(calls([("task", {"description": "survey the README", "prompt": "CHILD_A read README"}),
                                 ("task", {"description": "survey the tests", "prompt": "CHILD_B list tests"})],
                                thinking="Planning: two surveys in parallel."))


def run_scenario():
    STATE.update(refused=0, cut=0)
    REQUESTS.clear()
    FAILS.clear()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    base = Path(tempfile.mkdtemp(prefix="dgc-cross-lane-"))
    home, work = base / "home", base / "work"
    home.mkdir(); work.mkdir()
    git = ["git", "-c", "user.name=r", "-c", "user.email=r@l"]
    subprocess.run(["git", "init", "-q"], cwd=work, check=True)
    (work / "README.md").write_text("fixture\n")
    (work / "shot.png").write_bytes(PNG)
    subprocess.run(git + ["add", "."], cwd=work, check=True)
    subprocess.run(git + ["commit", "-qm", "init"], cwd=work, check=True)
    (home / ".dgc").mkdir()
    (home / ".dgc" / "config.json").write_text(json.dumps({
        "base_url": f"http://127.0.0.1:{port}/v1", "model": "mock-model", "api_key": "sk-fixture-0123456789abcdef",
        "api_mode": "chat_completions", "suggest": False, "notes": False, "mode": "auto", "max_parallel_tasks": 2,
        "artifact_autostart": False, "eta": False}))
    env = dict(os.environ, HOME=str(home), PYTHONPATH=str(ROOT), PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1")
    for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
        env[var] = str(home)
    for var in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY"):
        env.pop(var, None)
    stderr = open(base / "stderr.log", "w")
    proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(work), env=env,
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True)
    events, q = [], queue.Queue()

    def read():
        for line in proc.stdout:
            try:
                ev = json.loads(line)
            except ValueError:
                ev = {"type": "__bad__", "line": line}
            events.append(ev); q.put(ev)
    threading.Thread(target=read, daemon=True).start()

    def send(cmd):
        problem = ep.command_error(cmd)
        check(f"command {cmd['type']} is valid", problem is None, problem)
        proc.stdin.write(json.dumps(cmd) + "\n"); proc.stdin.flush()

    def wait(pred, timeout=120):
        end = time.time() + timeout
        while time.time() < end:
            try:
                ev = q.get(timeout=max(0.05, end - time.time()))
            except queue.Empty:
                break
            if pred(ev):
                return ev
        raise TimeoutError("timed out")

    try:
        ready = wait(lambda e: e.get("type") == "ready", 60)
        caps = ready.get("capabilities") or {}
        check("ready is v14 with agents, image_views, model_retry", ready.get("protocol_version") == 14
              and all(caps.get(k) is True for k in ("agents", "image_views", "model_retry")), ready)
        send({"type": "set_mode", "mode": "auto", "acknowledge_workspace_trust": True})
        wait(lambda e: e.get("type") == "mode_changed" and e.get("mode") == "auto", 30)
        send({"type": "prompt", "text": "TURN_ONE survey this repo with two sub-agents, then look at shot.png"})
        wait(lambda e: e.get("type") == "turn_end", 60)
        n1 = len(events)
        send({"type": "prompt", "text": "TURN_TWO pick a database"})
        req = wait(lambda e: e.get("type") == "options_request", 120)
        asked_at = len(REQUESTS)
        send({"type": "options_response", "id": req["id"], "dismissed": True})
        wait(lambda e: e.get("type") == "turn_end", 120)
        after_dismissal = len(REQUESTS) - asked_at
        send({"type": "get_history", "request_id": "h1"})
        history = wait(lambda e: e.get("type") == "history" and e.get("request_id") == "h1", 60)
        send({"type": "list_agents", "request_id": "a1"})
        agents = wait(lambda e: e.get("type") == "agents" and e.get("request_id") == "a1", 30)
    finally:
        try:
            proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n"); proc.stdin.flush()
            proc.wait(timeout=30)
        except Exception:
            proc.kill()
        server.shutdown()
        stderr.close()
        shutil.rmtree(base, ignore_errors=True)

    bad = [(e.get("type"), ep.event_error(e)) for e in events if e.get("type") == "__bad__" or ep.event_error(e)]
    check("every live frame passes event_error", not bad, bad[:5])
    live1, live2 = events[:n1], events[n1:]
    retries = [e for e in live1 if e["type"] == "model_retry"]
    check("turn 1: a refused request retried then recovered (request layer)",
          any(r["state"] == "retrying" and r["layer"] == "request" for r in retries)
          and any(r["state"] == "recovered" and r["layer"] == "request" for r in retries), retries)
    check("turn 1: the cut stream is continued (continuation layer recovered)",
          any(r["state"] == "recovered" and r["layer"] == "continuation" for r in retries), retries)
    check("turn 1: retry ids are {turn_id}:retry{n}", all(":retry" in r["retry_id"] for r in retries), retries)
    thinking = [e for e in live1 if e["type"] in ("thinking_delta", "thinking_end")]
    check("turn 1: thinking deltas and ends carry a block, and a loopback host is never a provider source",
          thinking and all(e.get("block") and e.get("source") in ("raw", "unknown") for e in thinking)
          and any(e["type"] == "thinking_end" for e in thinking), thinking[:4])
    child_thinking = [e for e in thinking if e.get("agent")]
    started = [e for e in live1 if e["type"] == "agent_started"]
    ended = [e for e in live1 if e["type"] == "agent_ended"]
    check("turn 1: two sub-agents started and finished", len(started) == 2 and len(ended) == 2
          and all(e["state"] == "finished" for e in ended), [started, ended])
    check("turn 1: parallel sub-agents are marked parallel", all(e.get("parallel") for e in started), started)
    ids = {e["id"] for e in started}
    check("sub-agent thinking names the innermost agent id", not child_thinking or {e["agent"] for e in child_thinking} <= ids,
          child_thinking[:2])
    shots = [e for e in live1 if e["type"] == "tool_images"]
    check("turn 1: view_image produced one tool_images frame with an item",
          len(shots) == 1 and shots[0].get("items") and shots[0]["items"][0]["source"] == "view_image", shots)
    check("turn 1 ends completed", any(e["type"] == "turn_end" and e.get("reason") == "completed" for e in live1),
          [e for e in live1 if e["type"] == "turn_end"])
    resolved = [e for e in live2 if e["type"] == "options_resolved"]
    check("turn 2: the dismissed question resolves dismissed", len(resolved) == 1 and resolved[0]["outcome"] == "dismissed", resolved)
    check("turn 2: no model request after the dismissal", after_dismissal == 0, after_dismissal)
    check("agents snapshot counts both agents", agents.get("total") == 2 and agents.get("active") == 0, agents)
    leaked = sorted({k for r in REQUESTS for k in r["private_keys"]})
    check("no private _dgc_* key reaches a request body", not leaked, leaked)

    items = history.get("items") or []
    typed = [i for i in items if isinstance(i.get("type"), str)]
    bad_items = [(i.get("type"), ep.event_error({**i, "seq": 0})) for i in typed if ep.event_error({**i, "seq": 0})]
    check("every history item passes event_error", typed and not bad_items, bad_items[:5])
    order = [i["type"] for i in typed]
    for kind in ("thinking_end", "model_retry", "tool_images", "options_resolved"):
        check(f"history replays {kind}", kind in order, order)

    def turns(seq):
        out, cur = [], None
        for i in seq:
            if i["type"] == "turn_start":
                cur = []; out.append(cur)
            if cur is not None:
                cur.append(i)
        return out
    t = turns(typed)
    check("history has two turns", len(t) == 2, [len(x) for x in t])
    if len(t) == 2:
        t1 = [i["type"] for i in t[0]]
        first_task = next((n for n, i in enumerate(t[0]) if i["type"] == "tool_call" and i.get("name") == "task"), -1)
        first_end = t1.index("thinking_end") if "thinking_end" in t1 else 99999
        check("replay: the first reasoning block ends before the task calls", 0 <= first_end < first_task, t1)
        vi_result = next((n for n, i in enumerate(t[0]) if i["type"] == "tool_result"
                          and str(i.get("call_id", "")).startswith("call_view_image")), -1)
        img = t1.index("tool_images") if "tool_images" in t1 else -1
        check("replay: tool_images follows the view_image tool_result", vi_result >= 0 and img == vi_result + 1, t1)
        mr = [n for n, i in enumerate(t[0]) if i["type"] == "model_retry"]
        texts = [n for n, i in enumerate(t[0]) if i["type"] == "text_delta"]
        # The partial answer and its continuation are one saved answer ("All do" + "ne."), and the
        # reconnect that joined them is drawn above it, where the live panel settles it.
        joined = [i.get("text") for i in t[0] if i["type"] == "text_delta"]
        check("replay: the stream-cut model_retry sits above the joined answer",
              len(mr) == 1 and texts and mr[0] < texts[0] and joined[-1:] == ["All done."]
              and t[0][mr[0]]["layer"] == "continuation" and t[0][mr[0]]["state"] == "recovered"
              and t[0][mr[0]]["retry_id"].startswith("h"), [t1, joined, t[0][mr[0]] if mr else None])
        t2 = [i["type"] for i in t[1]]
        opt = t2.index("options_resolved") if "options_resolved" in t2 else -1
        res = next((n for n, i in enumerate(t[1]) if i["type"] == "tool_result"), -1)
        check("replay: options_resolved comes right before its tool_result", 0 <= opt and res == opt + 1, t2)
    return list(FAILS)


class CrossLaneServeTests(unittest.TestCase):
    def test_one_session_with_retries_thinking_agents_images_and_a_dismissed_question(self):
        if shutil.which("git") is None:
            self.skipTest("git is not installed")
        failures = run_scenario()
        self.assertEqual(failures, [], "\n".join(failures))


if __name__ == "__main__":
    unittest.main()
