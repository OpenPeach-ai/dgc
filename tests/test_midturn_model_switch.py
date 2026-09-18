"""Changing the model or the thinking level while a turn runs.

The founder's report: in the editor, on Ollama cloud models, he switched the main model while a
turn was running. The chat said the model had changed, then showed "working" for about fifteen
minutes and did nothing until he pressed Stop and sent "continue".

Two things combined. The switch left the request already on the wire with the model he had just
left, and a request that never answers was only given up after its stall window. For a cloud model
behind a local Ollama that window was the local one, and worse, the local /api/ps never lists a
cloud model, so the silence counted as "Loading the model" for the 900 s load window.

These tests pin the repaired behaviour:

* a real ``dgc serve`` over stdio (the extension's transport) with a fake native Ollama whose old
  model never answers: after ``set_model`` the same request goes to the new model within seconds,
  and the turn completes without Stop;
* the agent-level rule behind it: only a request that has produced nothing is re-sent; one that is
  already answering finishes on its model and the NEXT request uses the new one;
* a thinking level changed mid-turn applies from the next request, with its guidance;
* what reaches Ollama for each level, and what the editor's reasoning note is told.
"""
from __future__ import annotations

import json
import os
import pwd
import queue
import select
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_midturn_model_switch.py needs HOME redirected before dgc is "
                           "imported — run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-midturn-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc.agent import Agent                                        # noqa: E402
from dgc.config import Config                                      # noqa: E402
from dgc.llm import ChatResult, LLMClient, ToolCall, _reasoning_payload  # noqa: E402
from dgc.model_watch import is_ollama_cloud_model, resolve_first_token_timeout  # noqa: E402

PROJECT = Path(__file__).resolve().parents[1]


def _client_gone(handler, cap: float) -> None:
    """Hold a request open, sending nothing, until the client closes its end (or ``cap``)."""
    end = time.monotonic() + cap
    conn = handler.connection
    while time.monotonic() < end:
        readable, _, _ = select.select([conn], [], [], 0.2)
        if readable:
            try:
                if not conn.recv(1, socket.MSG_PEEK):
                    return
            except OSError:
                return


class _FakeOllama:
    """A native Ollama: ``stuck`` models answer their first request with a tool call and then
    never answer again (no headers, nothing); every other model answers at once."""

    def __init__(self, stuck: set[str]):
        self.stuck = set(stuck)
        self.chats: list[tuple[float, str, dict]] = []
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _json(self, value, status=200, kind="application/json"):
                data = (value if isinstance(value, str) else json.dumps(value)).encode()
                self.send_response(status)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                if self.path.endswith("/api/ps"):
                    self._json({"models": []})          # nothing is ever "loaded" (a cloud model)
                elif self.path.endswith("/api/tags"):
                    self._json({"models": [{"name": "model-a"}, {"name": "model-b"}]})
                else:
                    self._json({"error": "not found"}, 404)

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                if self.path.endswith("/api/show"):
                    self._json({"capabilities": ["completion", "tools", "thinking"],
                                "model_info": {"general.architecture": "fake",
                                               "fake.context_length": 32768},
                                "details": {"family": "fake"}})
                    return
                if not self.path.endswith("/api/chat"):
                    self._json({"error": "not found"}, 404)
                    return
                model = str(body.get("model") or "")
                with fake.lock:
                    fake.chats.append((time.monotonic(), model, body))
                answered = any(m.get("role") == "tool" for m in body.get("messages") or [])
                if model in fake.stuck and answered:
                    _client_gone(self, 120)
                    return
                if not answered:
                    message = {"role": "assistant", "content": "", "tool_calls": [
                        {"function": {"name": "read_file", "arguments": {"path": "notes.txt"}}}]}
                else:
                    message = {"role": "assistant", "content": f"Finished on {model}."}
                frames = [{"model": model, "message": message, "done": False},
                          {"model": model, "message": {"role": "assistant", "content": ""},
                           "done": True, "done_reason": "stop",
                           "prompt_eval_count": 10, "eval_count": 5}]
                self._json("".join(json.dumps(f) + "\n" for f in frames),
                           kind="application/x-ndjson")

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def models(self) -> list[str]:
        with self.lock:
            return [model for _, model, _ in self.chats]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class MidTurnModelSwitchOverStdio(unittest.TestCase):
    """The regression, end to end: `dgc serve` driven the way the editor drives it."""

    def test_switching_the_main_model_moves_a_stuck_request_to_the_new_model(self):
        fake = _FakeOllama(stuck={"model-a"})
        self.addCleanup(fake.close)
        home = Path(tempfile.mkdtemp(prefix="dgc-switch-home-"))
        work = Path(tempfile.mkdtemp(prefix="dgc-switch-work-"))
        (work / "notes.txt").write_text("The warehouse opens at 9am.\n")
        (home / ".dgc").mkdir()
        (home / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{fake.port}/v1", "api_mode": "ollama",
            "model": "model-a", "thinking": "off", "suggest": False, "notes": False,
            "artifact_autostart": False}))
        env = dict(os.environ, HOME=str(home), USERPROFILE=str(home), PYTHONPATH=str(PROJECT),
                   PYTHONDONTWRITEBYTECODE="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(home)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=str(work), env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True)
        events: list[dict] = []
        arrived: queue.Queue = queue.Queue()

        def read():
            for line in proc.stdout:
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                event["_t"] = time.monotonic()
                events.append(event)
                arrived.put(event)
        threading.Thread(target=read, daemon=True).start()

        def send(command):
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def wait(predicate, timeout):
            for event in list(events):
                if predicate(event):
                    return event
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    event = arrived.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                if predicate(event):
                    return event
            return None

        def cleanup():
            try:
                send({"type": "cancel"})
                proc.stdin.close()
                proc.wait(timeout=30)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                proc.kill()
                proc.wait(timeout=10)
            try:
                proc.stdout.close()
            except OSError:
                pass
            import shutil
            shutil.rmtree(home, ignore_errors=True)
            shutil.rmtree(work, ignore_errors=True)
        self.addCleanup(cleanup)

        self.assertIsNotNone(wait(lambda e: e["type"] == "ready", 60), "serve never became ready")
        send({"type": "set_workspace_roots", "roots": [str(work)], "request_id": "roots"})
        wait(lambda e: e["type"] == "workspace_roots", 20)
        send({"type": "prompt", "text": "Read notes.txt and tell me when the warehouse opens.",
              "request_id": "p1"})
        self.assertIsNotNone(wait(lambda e: e["type"] == "tool_result", 60), "no tool round ran")
        # The model's next request is now on the wire to model-a, which will never answer it.
        deadline = time.monotonic() + 30
        while fake.models().count("model-a") < 2 and time.monotonic() < deadline:
            time.sleep(0.05)
        self.assertEqual(fake.models().count("model-a"), 2, fake.models())
        time.sleep(0.5)                               # well inside every stall window
        switched = time.monotonic()
        # Exactly what the editor's model menu sends (panel.ts modelCommand).
        send({"type": "set_model", "route": "native", "model": "model-b",
              "request_id": "model-select"})
        self.assertIsNotNone(wait(lambda e: e["type"] == "model_changed"
                                  and e.get("request_id") == "model-select", 20))
        end = wait(lambda e: e["type"] == "turn_end", 30)
        self.assertIsNotNone(end, "the turn kept waiting on the old model after the switch: "
                                  + str([e["type"] for e in events][-15:]))
        self.assertEqual(end.get("reason"), "completed", end)
        self.assertLess(end["_t"] - switched, 20, "the switch did not take effect promptly")
        self.assertEqual(fake.models()[-1], "model-b", fake.models())
        resent = [e for e in events if e["type"] == "info"
                  and "had not started answering" in str(e.get("message"))]
        self.assertEqual(len(resent), 1, [e.get("message") for e in events if e["type"] == "info"])
        self.assertIn("model-a", resent[0]["message"])
        self.assertIn("model-b", resent[0]["message"])
        answer = "".join(str(e.get("text") or e.get("delta") or "") for e in events
                         if e["type"] == "text_delta")
        self.assertIn("Finished on model-b.", answer)
        self.assertFalse([e for e in events if e["type"] in ("error", "command_rejected")],
                         [e for e in events if e["type"] in ("error", "command_rejected")])
        # The editor is told the new model's capabilities (its reasoning note reads them).
        refreshed = wait(lambda e: e["type"] == "config" and e.get("model") == "model-b"
                         and e.get("_t", 0) >= switched, 20)
        self.assertIsNotNone(refreshed, "no config followed the model switch")
        self.assertEqual(refreshed["provider_capabilities"].get("reasoning_control"),
                         "ollama-levels")


class _Quiet:
    def __init__(self):
        self.infos, self.text = [], []

    def info(self, message):
        self.infos.append(str(message))

    def on_text(self, chunk):
        self.text.append(chunk)

    def __getattr__(self, name):
        return lambda *a, **k: None


class _FakeClient:
    """Enough of LLMClient for Agent: a route identity, native tools, and a scripted ``chat``."""

    def __init__(self, model, script):
        self.base_url, self.api_key, self.model = "http://127.0.0.1:9/v1", "k", model
        self.requested_api_mode = self.api_mode = "ollama"
        self.family = "ollama"
        self.tools_supported = True
        self.vision_supported = False
        self.reasoning_supported = True
        self.read_timeout = 60
        self.script = script
        self.calls = []

    def chat(self, messages, tools=None, reasoning_effort=None, on_text=None, on_thinking=None,
             cancel=None):
        self.calls.append({"effort": reasoning_effort,
                           "system": str((messages[0] or {}).get("content") or "")})
        return self.script(self, len(self.calls), on_text, cancel)

    def estimate_input_tokens(self, messages, tools=None):
        return sum(len(json.dumps(m, default=str)) for m in messages) // 4

    def __getattr__(self, name):
        if name.startswith("__"):
            raise AttributeError(name)
        return lambda *a, **k: None


def _answer(text):
    def script(client, n, on_text, cancel):
        if on_text:
            on_text(text)
        return ChatResult(content=text, finish_reason="stop")
    return script


def _read_call(call_id="c1"):
    return ChatResult(tool_calls=[ToolCall(id=call_id, name="read_file",
                                           arguments={"path": "notes.txt"})],
                      finish_reason="tool_calls")


class AgentRouteSwitchTests(unittest.TestCase):
    def agent(self, thinking="off"):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-route-switch-")
        self.addCleanup(tmp.cleanup)
        (Path(tmp.name) / "notes.txt").write_text("Deliveries arrive on Tuesdays.\n")
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg._persist = False
        cfg.data.update({"model": "model-a", "base_url": "http://127.0.0.1:9/v1",
                         "mode": "default", "thinking": thinking, "suggest": False,
                         "notes": False, "ultra_mode": False})
        ui = _Quiet()
        agent = Agent(cfg, ui)
        self.addCleanup(agent.mcp.stop_all)
        return agent, ui

    def run_turn_async(self, agent, text):
        box = {}
        worker = threading.Thread(target=lambda: box.setdefault("ok", agent.run_turn(text)),
                                  daemon=True)
        worker.start()
        return worker, box

    def switch_to(self, agent, client):
        agent.config.data["model"] = client.model
        original = agent._new_client
        agent._new_client = lambda *a, **k: client
        try:
            agent.refresh_client()
        finally:
            agent._new_client = original

    def test_a_request_that_produced_nothing_is_sent_again_on_the_new_model(self):
        agent, ui = self.agent()
        entered = threading.Event()

        def stuck(client, n, on_text, cancel):
            if n == 1:
                return _read_call()
            entered.set()
            deadline = time.monotonic() + 30          # a request that never answers
            while not cancel.is_set() and time.monotonic() < deadline:
                time.sleep(0.02)
            return ChatResult(finish_reason="cancelled")

        old = _FakeClient("model-a", stuck)
        new = _FakeClient("model-b", _answer("done on b"))
        agent.client = old
        worker, box = self.run_turn_async(agent, "Read notes.txt please.")
        self.assertTrue(entered.wait(10))
        started = time.monotonic()
        self.switch_to(agent, new)
        worker.join(10)
        self.assertFalse(worker.is_alive(), "the turn is still waiting on the old model")
        self.assertLess(time.monotonic() - started, 5)
        self.assertIsNot(box.get("ok"), False)
        self.assertEqual(len(old.calls), 2)
        self.assertEqual(len(new.calls), 1, "the stuck request was not re-sent on the new model")
        self.assertIn("done on b", "".join(ui.text))
        self.assertTrue(any("had not started answering" in line for line in ui.infos), ui.infos)
        self.assertFalse(agent.cancelled.is_set(), "a switch is not a Stop")

    def test_a_request_already_answering_finishes_on_its_model(self):
        agent, ui = self.agent()
        streaming, release = threading.Event(), threading.Event()
        seen_cancel = []

        def answering(client, n, on_text, cancel):
            if n == 1:
                return _read_call()
            on_text("Reading the notes")          # this request has started answering
            streaming.set()
            release.wait(10)
            seen_cancel.append(cancel.is_set())
            return _read_call("c2")

        old = _FakeClient("model-a", answering)
        new = _FakeClient("model-b", _answer("done on b"))
        agent.client = old
        worker, box = self.run_turn_async(agent, "Read notes.txt please.")
        self.assertTrue(streaming.wait(10))
        self.switch_to(agent, new)
        time.sleep(0.3)
        release.set()
        worker.join(10)
        self.assertFalse(worker.is_alive())
        self.assertEqual(seen_cancel, [False], "an answering request must not be cut off")
        self.assertEqual(len(old.calls), 2)
        self.assertEqual(len(new.calls), 1, "the next request did not use the new model")
        self.assertFalse(any("had not started answering" in line for line in ui.infos), ui.infos)

    def test_the_same_route_rebuilt_does_not_resend(self):
        agent, _ = self.agent()
        entered, release = threading.Event(), threading.Event()
        cancelled = []

        def waiting(client, n, on_text, cancel):
            if n == 1:
                return _read_call()
            entered.set()
            release.wait(10)
            cancelled.append(cancel.is_set())
            return ChatResult(content="done")

        old = _FakeClient("model-a", waiting)
        same = _FakeClient("model-a", lambda c, n, on_text, cancel: ChatResult(content="other"))
        agent.client = old
        worker, _ = self.run_turn_async(agent, "Read notes.txt please.")
        self.assertTrue(entered.wait(10))
        self.switch_to(agent, same)          # e.g. a sampling setting changed: same model route
        time.sleep(0.3)
        release.set()
        worker.join(10)
        self.assertEqual(cancelled, [False])
        self.assertEqual(len(same.calls), 0)

    def test_a_thinking_level_changed_mid_turn_applies_from_the_next_request(self):
        agent, _ = self.agent(thinking="low")

        def script(client, n, on_text, cancel):
            if n == 1:
                agent.config.data["thinking"] = "high"      # the dial moved during this request
                return _read_call()
            return ChatResult(content="done")

        client = _FakeClient("model-a", script)
        agent.client = client
        self.assertIsNot(agent.run_turn("Read notes.txt please."), False)
        self.assertEqual([c["effort"] for c in client.calls], ["low", "high"])
        self.assertIn("Think briefly", client.calls[0]["system"])
        self.assertIn("Reason deeply", client.calls[1]["system"],
                      "the new level's guidance must reach the next request too")
        self.assertNotIn("Think briefly", client.calls[1]["system"])


class _Response:
    def __init__(self, status, body, kind="application/json"):
        self.status_code = status
        self._body = body if isinstance(body, bytes) else body.encode()
        self.headers = {"Content-Type": kind}
        self.text = self._body.decode()
        self.raw = None

    def iter_content(self, chunk_size=1, decode_unicode=False):
        yield self._body

    def iter_lines(self, *a, **k):
        for line in self._body.splitlines():
            yield line

    def json(self):
        return json.loads(self._body)

    def close(self):
        pass


class OllamaThinkingLevelTests(unittest.TestCase):
    def client(self, model, url="http://localhost:11434/v1"):
        client = LLMClient(url, "ollama", model)
        client.invalidate_capabilities()
        for feature in ("think_levels", "think_max"):
            client._capability_rejections.pop(client._capability_key(feature), None)
        return client

    def test_levels_reach_ollama_on_both_transports(self):
        levels = ["off", "low", "medium", "high", "xhigh"]
        native = self.client("deepseek-v4.1-flash:cloud")
        self.assertEqual([native._ollama_think(level) for level in levels],
                         [False, "low", "medium", "high", "max"])
        self.assertEqual([_reasoning_payload("ollama", "deepseek-v4.1-flash:cloud", level)
                          ["reasoning_effort"] for level in levels],
                         ["none", "low", "medium", "high", "max"])
        # GLM-5 answers thinking-off by writing its reasoning into the answer (ending in a stray
        # </think>), so its Off is its lowest level.
        glm = self.client("glm-5.3:cloud")
        self.assertEqual([glm._ollama_think(level) for level in levels],
                         ["low", "low", "medium", "high", "max"])
        self.assertEqual([_reasoning_payload("ollama", "glm-5.3:cloud", level)["reasoning_effort"]
                          for level in levels], ["low", "low", "medium", "high", "max"])
        gpt = self.client("gpt-oss:120b-cloud")
        self.assertEqual([gpt._ollama_think(level) for level in levels],
                         ["low", "low", "medium", "high", "high"])
        self.assertEqual([_reasoning_payload("ollama", "gpt-oss:120b-cloud", level)["reasoning_effort"]
                          for level in levels], ["low", "low", "medium", "high", "high"])

    def _chat(self, client, replies, effort):
        import dgc.llm as llm
        posts = []

        def post(url, **kwargs):
            if url.endswith("/api/show"):
                return _Response(200, json.dumps({"capabilities": ["completion", "thinking"],
                                                  "model_info": {}, "details": {}}))
            posts.append(json.loads(json.dumps(kwargs["json"])))
            return replies[min(len(posts) - 1, len(replies) - 1)]()

        original_post, original_get = llm.requests.post, llm.requests.get
        llm.requests.post = post
        llm.requests.get = lambda url, **kwargs: _Response(200, json.dumps({"models": []}))
        try:
            result = client.chat([{"role": "user", "content": "hi"}], reasoning_effort=effort)
        finally:
            llm.requests.post, llm.requests.get = original_post, original_get
        return posts, result

    @staticmethod
    def _ok():
        frames = [{"message": {"role": "assistant", "content": "ok"}, "done": False},
                  {"message": {"role": "assistant", "content": ""}, "done": True,
                   "done_reason": "stop"}]
        return _Response(200, "".join(json.dumps(f) + "\n" for f in frames),
                         "application/x-ndjson")

    def test_an_older_ollama_that_refuses_levels_keeps_the_off_switch(self):
        client = self.client("qwen3:8b-refuses-levels")
        refused = lambda: _Response(400, json.dumps(
            {"error": 'think value "high" is not supported for this model'}))
        posts, result = self._chat(client, [refused, self._ok], "high")
        self.assertEqual([p.get("think") for p in posts], ["high", True])
        self.assertEqual(result.content, "ok")
        self.assertTrue(client.reasoning_supported, "a refused level is not a refused control")
        self.assertEqual(client._ollama_think("low"), True)
        self.assertIs(client._ollama_think("off"), False, "Off must still switch thinking off")
        self.assertEqual(client.capability_snapshot()["reasoning_control"], "toggle")

    def test_an_ollama_without_the_max_tier_gets_high(self):
        client = self.client("deepseek-v4:cloud-no-max")
        refused = lambda: _Response(400, json.dumps(
            {"error": 'invalid think value: "max" (must be "high", "medium", "low", true, or false)'}))
        posts, result = self._chat(client, [refused, self._ok], "xhigh")
        self.assertEqual([p.get("think") for p in posts], ["max", "high"])
        self.assertEqual(client._ollama_think("xhigh"), "high")
        self.assertEqual(client._ollama_think("low"), "low")

    def test_reasoning_control_describes_what_is_sent(self):
        self.assertEqual(self.client("deepseek-v4.1-flash:cloud").capability_snapshot()
                         ["reasoning_control"], "ollama-levels")
        self.assertEqual(self.client("glm-5.3:cloud").capability_snapshot()["reasoning_control"],
                         "glm-levels")
        self.assertEqual(self.client("gpt-oss:20b").capability_snapshot()["reasoning_control"],
                         "levels")
        self.assertEqual(self.client("glm-5.3-flash:cloud").capability_snapshot()["reasoning_control"],
                         "glm-flash-levels")
        v1 = LLMClient("http://localhost:11434/v1", "ollama", "deepseek-v4.1-flash:cloud",
                       api_mode="chat_completions")
        self.assertEqual(v1.capability_snapshot()["reasoning_control"], "ollama-levels")
        plain = self.client("plain-model")
        plain._cache_model_metadata({"source": "ollama_show", "capabilities_authoritative": True,
                                     "capabilities": ["completion", "tools"]})
        self.assertEqual(plain.capability_snapshot()["reasoning_control"], "instructions")

    def test_cloud_models_behind_a_local_ollama_are_not_loading_and_use_the_remote_window(self):
        for name in ("glm-5.3:cloud", "gpt-oss:120b-cloud", "deepseek-v4-pro:cloud"):
            self.assertTrue(is_ollama_cloud_model(name), name)
        for name in ("qwen3.8:27b-q4km", "gpt-oss:120b-32k", "cloudy:7b", "model-a"):
            self.assertFalse(is_ollama_cloud_model(name), name)
        cloud = self.client("glm-5.3:cloud")
        local = self.client("qwen3.8:27b-q4km")
        self.assertIsNone(cloud._ollama_load_probe(), "a cloud model never loads locally")
        self.assertIsNotNone(local._ollama_load_probe())
        self.assertEqual(cloud.first_token_timeout, 300)
        self.assertEqual(local.first_token_timeout, 900)
        self.assertEqual(resolve_first_token_timeout("auto", "http://127.0.0.1:11434", "ollama",
                                                     model="kimi-k2:1t-cloud"), 300)
        self.assertEqual(resolve_first_token_timeout("120", "http://127.0.0.1:11434", "ollama",
                                                     model="glm-5.3:cloud"), 120)


if __name__ == "__main__":
    unittest.main()
