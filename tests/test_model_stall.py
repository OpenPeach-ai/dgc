"""The stall watcher: a model request that hangs without an error is noticed, closed and reported.

Every hang shape here is a real local HTTP server doing exactly that shape, with windows of a few
hundred milliseconds so the whole module runs in seconds:

* no response headers at all (llama.cpp sends none until its first result)
* headers, then a silent open stream
* keep-alive comments / empty deltas / pings that carry no tokens
* a close-delimited body whose tokens must not be buffered into "silence"
* legitimate long reasoning that streams, and hidden reasoning inside the window, which must live
* an Ollama model still loading, which pauses the clock
* Esc / Stop in every one of those phases, including during a retry backoff

The server records when each request arrived and when the client hung up, so a test can prove the
socket was really closed rather than abandoned.
"""
from __future__ import annotations

import json
import os
import pwd
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
from types import SimpleNamespace

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_model_stall.py needs HOME redirected before dgc is "
                           "imported — run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-stall-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc import sessions                                    # noqa: E402  (after the redirect above)
from dgc.agent import Agent                                 # noqa: E402
from dgc.config import Config                               # noqa: E402
from dgc.editor_protocol import event_error                 # noqa: E402
from dgc.llm import LLMClient, ModelStallError, explain_llm_error  # noqa: E402
from dgc.model_watch import is_local_endpoint, resolve_first_token_timeout  # noqa: E402

PROJECT = Path(__file__).resolve().parents[1]


# ---- a server that can hang in every shape ---------------------------------------------------------
def _client_gone(handler, cap: float = 5.0) -> float | None:
    """Block until the client closes its end; return when that happened (None if it never did)."""
    end = time.monotonic() + cap
    conn = handler.connection
    while time.monotonic() < end:
        try:
            readable, _, _ = select.select([conn], [], [], 0.02)
        except (OSError, ValueError):
            return time.monotonic()
        if not readable:
            continue
        try:
            if not conn.recv(1, socket.MSG_PEEK):
                return time.monotonic()
        except OSError:
            return time.monotonic()
        time.sleep(0.02)
    return None


class _Server:
    """ThreadingHTTPServer whose per-path behaviour is a plain function set by each test."""

    def __init__(self):
        self.posts: list[dict] = []
        self.lock = threading.Lock()
        self.behaviours: dict[str, object] = {}
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def _dispatch(self, method):
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    body = json.loads(raw or b"{}")
                except ValueError:
                    body = {}
                record = {"path": self.path, "body": body, "at": time.monotonic(), "gone": None}
                if method == "POST":
                    with outer.lock:
                        outer.posts.append(record)
                behaviour = None
                for suffix, fn in outer.behaviours.items():
                    if self.path.endswith(suffix):
                        behaviour = fn
                        break
                if behaviour is None:
                    self.send_response(404)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                behaviour(self, record)

            def do_POST(self):
                self._dispatch("POST")

            def do_GET(self):
                self._dispatch("GET")

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, request, client_address):
                pass                    # a client that hung up mid-response is the point here

        self.httpd = Server(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def chat_posts(self, suffix: str) -> list[dict]:
        with self.lock:
            return [p for p in self.posts if p["path"].endswith(suffix)]


def _start_stream(handler, ctype="text/event-stream"):
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Transfer-Encoding", "chunked")
    handler.end_headers()


def _chunk(handler, text: str) -> bool:
    data = text.encode()
    try:
        handler.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
        handler.wfile.flush()
        return True
    except OSError:
        return False


def _end_stream(handler):
    try:
        handler.wfile.write(b"0\r\n\r\n")
        handler.wfile.flush()
    except OSError:
        pass


def _sse(obj) -> str:
    return f"data: {json.dumps(obj)}\n\n"


def _chat_delta(delta=None, finish=None) -> str:
    return _sse({"choices": [{"index": 0, "delta": delta or {}, "finish_reason": finish}]})


def no_headers(handler, record):
    record["gone"] = _client_gone(handler)


def silent_stream(handler, record):
    _start_stream(handler)
    record["gone"] = _client_gone(handler)


def noise_until_gone(frame: str, prelude: str = "", interval: float = 0.05):
    def behaviour(handler, record):
        _start_stream(handler)
        if prelude and not _chunk(handler, prelude):
            record["gone"] = time.monotonic()
            return
        end = time.monotonic() + 5
        while time.monotonic() < end:
            if not _chunk(handler, frame):
                record["gone"] = time.monotonic()
                return
            readable, _, _ = select.select([handler.connection], [], [], interval)
            if readable:
                try:
                    if not handler.connection.recv(1, socket.MSG_PEEK):
                        record["gone"] = time.monotonic()
                        return
                except OSError:
                    record["gone"] = time.monotonic()
                    return
    return behaviour


def chat_answer(text="done", reasoning_steps=0, step=0.2, field="reasoning_content", delay=0.0):
    def behaviour(handler, record):
        if delay:
            time.sleep(delay)
        _start_stream(handler)
        for index in range(reasoning_steps):
            _chunk(handler, _chat_delta({field: f"thought {index} "}))
            time.sleep(step)
        _chunk(handler, _chat_delta({"content": text}))
        _chunk(handler, _chat_delta({}, finish="stop"))
        _chunk(handler, "data: [DONE]\n\n")
        _end_stream(handler)
    return behaviour


def partial_then_silent(parts=("Hello ", "world")):
    def behaviour(handler, record):
        _start_stream(handler)
        for part in parts:
            _chunk(handler, _chat_delta({"content": part}))
        record["gone"] = _client_gone(handler)
    return behaviour


def sequence(*behaviours):
    """Answer the Nth request with the Nth behaviour (the last one repeats)."""
    counter = {"n": 0}
    lock = threading.Lock()

    def behaviour(handler, record):
        with lock:
            index = min(counter["n"], len(behaviours) - 1)
            counter["n"] += 1
        behaviours[index](handler, record)
    return behaviour


class _Events:
    def __init__(self):
        self.items = []
        self.lock = threading.Lock()

    def __call__(self, event):
        with self.lock:
            self.items.append(event)

    def kinds(self):
        with self.lock:
            return [event.kind for event in self.items]


def _cancel_after(seconds: float) -> threading.Event:
    event = threading.Event()
    timer = threading.Timer(seconds, event.set)
    timer.daemon = True
    timer.start()
    return event


MESSAGES = [{"role": "user", "content": "hi"}]


class StallTestCase(unittest.TestCase):
    def setUp(self):
        self.server = _Server()
        self.addCleanup(self.server.close)

    def client(self, path="/v1", **kwargs) -> tuple[LLMClient, _Events]:
        kwargs.setdefault("read_timeout", 10)
        kwargs.setdefault("stall_notice", 0)
        client = LLMClient(self.server.url + path, "key", kwargs.pop("model", "stall-model"),
                           **kwargs)
        events = _Events()
        client.stall_listener = events
        return client, events

    def assertDisconnected(self, record, deadline_s: float, slack: float = 0.45):
        settle = time.monotonic() + 2       # the handler notices the hang-up on its own thread
        while record["gone"] is None and time.monotonic() < settle:
            time.sleep(0.02)
        self.assertIsNotNone(record["gone"], "the client never closed the stalled socket")
        waited = record["gone"] - record["at"]
        self.assertLess(waited, deadline_s + slack, f"closed {waited:.2f}s after the request")


# ---- shapes before any real output ---------------------------------------------------------------
class PreProgressStallTests(StallTestCase):
    def test_no_headers_stalls_retries_and_names_endpoint(self):
        self.server.behaviours["/chat/completions"] = no_headers
        client, events = self.client(first_token_timeout=0.4, stall_retries=1, stall_notice=0.15)
        started = time.monotonic()
        with self.assertRaises(ModelStallError) as caught:
            client.chat(MESSAGES)
        elapsed = time.monotonic() - started
        self.assertLess(elapsed, 2.5)
        error = caught.exception
        self.assertEqual(error.phase, "headers")
        self.assertEqual(error.attempts, 2)
        posts = self.server.chat_posts("/chat/completions")
        self.assertEqual(len(posts), 2)
        for record in posts:
            self.assertDisconnected(record, 0.4)
        text = explain_llm_error(str(error))
        self.assertIn("stall-model", text)
        self.assertIn(f"http://127.0.0.1:{self.server.port}/v1/chat/completions", text)
        self.assertNotIn("start your server", text)
        self.assertNotIn("key", str(error).replace("stall-model", ""))
        self.assertEqual(events.kinds()[:2], ["notice", "retry"])

    def test_headers_then_silence_is_a_first_token_stall(self):
        self.server.behaviours["/chat/completions"] = silent_stream
        client, _ = self.client(first_token_timeout=0.4, stall_retries=1)
        with self.assertRaises(ModelStallError) as caught:
            client.chat(MESSAGES)
        self.assertEqual(caught.exception.phase, "first_token")
        self.assertIn("opened a stream but sent no tokens", str(caught.exception))
        posts = self.server.chat_posts("/chat/completions")
        self.assertEqual(len(posts), 2, "retried inside the client, never handed up as 'incomplete'")
        for record in posts:
            self.assertDisconnected(record, 0.4)

    def test_keepalive_comments_do_not_count_as_progress(self):
        self.server.behaviours["/chat/completions"] = noise_until_gone(": keep-alive\n\n")
        client, _ = self.client(first_token_timeout=0.4, stall_retries=0)
        started = time.monotonic()
        with self.assertRaises(ModelStallError) as caught:
            client.chat(MESSAGES)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertGreater(caught.exception.noise_frames, 0)
        self.assertIn("keep-alive frames only", str(caught.exception))
        self.assertDisconnected(self.server.chat_posts("/chat/completions")[0], 0.4)

    def test_empty_and_role_only_deltas_do_not_count(self):
        self.server.behaviours["/chat/completions"] = noise_until_gone(
            _chat_delta({}), prelude=_chat_delta({"role": "assistant"}))
        client, _ = self.client(first_token_timeout=0.4, stall_retries=0)
        started = time.monotonic()
        with self.assertRaises(ModelStallError) as caught:
            client.chat(MESSAGES)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(caught.exception.phase, "first_token")
        self.assertDisconnected(self.server.chat_posts("/chat/completions")[0], 0.4)

    def test_anthropic_pings_do_not_count(self):
        start = "event: message_start\n" + _sse({"type": "message_start", "message": {
            "id": "msg_1", "usage": {"input_tokens": 3}}})
        ping = "event: ping\n" + _sse({"type": "ping"})
        self.server.behaviours["/messages"] = noise_until_gone(ping, prelude=start)
        client, _ = self.client(api_mode="anthropic", first_token_timeout=0.4, stall_retries=0)
        with self.assertRaises(ModelStallError) as caught:
            client.chat(MESSAGES)
        self.assertEqual(caught.exception.phase, "first_token")
        self.assertIn(f"127.0.0.1:{self.server.port}/v1/messages", str(caught.exception))
        self.assertDisconnected(self.server.chat_posts("/messages")[0], 0.4)

    def test_responses_lifecycle_events_do_not_count(self):
        prelude = (_sse({"type": "response.created", "response": {"id": "r1"}})
                   + _sse({"type": "response.in_progress", "response": {"id": "r1"}}))
        self.server.behaviours["/responses"] = noise_until_gone(": keepalive\n\n", prelude=prelude)
        client, _ = self.client(api_mode="responses", first_token_timeout=0.4, stall_retries=0)
        with self.assertRaises(ModelStallError) as caught:
            client.chat(MESSAGES)
        self.assertEqual(caught.exception.phase, "first_token")
        self.assertIn(f"127.0.0.1:{self.server.port}/v1/responses", str(caught.exception))
        self.assertDisconnected(self.server.chat_posts("/responses")[0], 0.4)

    def test_socket_read_timeout_is_classified_as_stall(self):
        self.server.behaviours["/chat/completions"] = no_headers
        for first_token in (0, 5):          # watcher off (the socket fires) and watcher clamped
            with self.subTest(first_token=first_token):
                client, _ = self.client(first_token_timeout=first_token, read_timeout=0.3,
                                        stall_retries=0)
                with self.assertRaises(ModelStallError) as caught:
                    client.chat(MESSAGES)
                self.assertEqual(caught.exception.phase, "headers")
                explained = explain_llm_error(str(caught.exception))
                self.assertIn("the server is reachable but the model produced nothing", explained)
                self.assertNotIn("start your server", explained)

    def test_an_endpoint_that_ignored_stream_true_is_not_held_to_the_first_token_window(self):
        # A gateway that answers stream:true with one JSON body sends no headers until it has
        # generated everything. Once seen, the header wait falls back to the read timeout.
        def json_then_slow(handler, record):
            if len(self.server.chat_posts("/chat/completions")) == 1:
                body = json.dumps({"choices": [{"message": {"content": "whole"},
                                                "finish_reason": "stop"}]}).encode()
            else:
                time.sleep(0.8)
                body = json.dumps({"choices": [{"message": {"content": "slow but whole"},
                                                "finish_reason": "stop"}]}).encode()
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        self.server.behaviours["/chat/completions"] = json_then_slow
        client, _ = self.client(model="json-gateway-model", first_token_timeout=0.3,
                                stall_retries=0, read_timeout=5, capability_cache_ttl_s=1)
        self.addCleanup(client.invalidate_capabilities)     # the rejection cache is process-wide
        self.assertEqual(client.chat(MESSAGES).content, "whole")
        self.assertTrue(client._streaming_rejected())
        # Ordinary negotiated rejections age out after capability_cache_ttl_s (1 s here). This one
        # must not: the endpoint still sends nothing until it has generated everything, and its
        # next long generation would otherwise be killed at the first-token deadline.
        client._mark_rejected("tools")
        time.sleep(1.1)
        self.assertTrue(client.tools_supported, "an ordinary rejection still expires")
        self.assertTrue(client._streaming_rejected(), "the non-streaming verdict outlives the TTL")
        self.assertEqual(client.chat(MESSAGES).content, "slow but whole")
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 2)
        client.invalidate_capabilities()
        self.assertFalse(client._streaming_rejected(), "invalidate_capabilities() forgets it")

    def test_recovers_on_retry_and_emits_ordered_events(self):
        self.server.behaviours["/chat/completions"] = sequence(no_headers, chat_answer("recovered"))
        client, events = self.client(first_token_timeout=0.4, stall_retries=1, stall_notice=0.15)
        result = client.chat(MESSAGES)
        self.assertEqual((result.finish_reason, result.content), ("stop", "recovered"))
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 2)
        self.assertEqual(events.kinds(), ["notice", "retry", "cleared"])
        retry = events.items[1]
        self.assertEqual((retry.attempt, retry.retries, retry.model), (1, 1, "stall-model"))
        time.sleep(0.5)
        self.assertEqual(events.kinds(), ["notice", "retry", "cleared"],
                         "nothing about a finished call may reach the UI afterwards")


# ---- what must NOT be killed ---------------------------------------------------------------------
class LegitimateSilenceTests(StallTestCase):
    def test_streamed_reasoning_is_progress_on_chat_completions(self):
        self.server.behaviours["/chat/completions"] = chat_answer("answer", reasoning_steps=6)
        client, events = self.client(first_token_timeout=0.4, idle_timeout=0.4)
        result = client.chat(MESSAGES)
        self.assertEqual((result.finish_reason, result.content), ("stop", "answer"))
        self.assertIn("thought 5", result.thinking)
        self.assertNotIn("retry", events.kinds())
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 1)

    def test_streamed_reasoning_is_progress_on_native_ollama(self):
        def ollama(handler, record):
            _start_stream(handler, "application/x-ndjson")
            for index in range(6):
                _chunk(handler, json.dumps({"message": {"role": "assistant", "content": "",
                                                        "thinking": f"step {index} "},
                                            "done": False}) + "\n")
                time.sleep(0.2)
            _chunk(handler, json.dumps({"message": {"role": "assistant", "content": "answer"},
                                        "done": False}) + "\n")
            _chunk(handler, json.dumps({"message": {"role": "assistant", "content": ""},
                                        "done": True, "done_reason": "stop"}) + "\n")
            _end_stream(handler)
        self.server.behaviours["/api/chat"] = ollama
        self.server.behaviours["/api/ps"] = lambda h, r: self._json(h, {"models": [
            {"name": "stall-model"}]})
        client, events = self.client(path="", api_mode="ollama", first_token_timeout=0.4,
                                     idle_timeout=0.4)
        result = client.chat(MESSAGES)
        self.assertEqual((result.finish_reason, result.content), ("stop", "answer"))
        self.assertIn("step 5", result.thinking)
        self.assertNotIn("retry", events.kinds())

    def test_streamed_reasoning_is_progress_on_anthropic(self):
        def anthropic(handler, record):
            _start_stream(handler)
            _chunk(handler, _sse({"type": "message_start", "message": {"id": "m", "usage": {}}}))
            _chunk(handler, _sse({"type": "content_block_start", "index": 0,
                                  "content_block": {"type": "thinking", "thinking": ""}}))
            for index in range(6):
                time.sleep(0.2)
                _chunk(handler, _sse({"type": "content_block_delta", "index": 0,
                                      "delta": {"type": "thinking_delta", "thinking": f"t{index} "}}))
            _chunk(handler, _sse({"type": "content_block_delta", "index": 0,
                                  "delta": {"type": "signature_delta", "signature": "sig"}}))
            _chunk(handler, _sse({"type": "content_block_stop", "index": 0}))
            _chunk(handler, _sse({"type": "content_block_start", "index": 1,
                                  "content_block": {"type": "text", "text": "answer"}}))
            _chunk(handler, _sse({"type": "content_block_stop", "index": 1}))
            _chunk(handler, _sse({"type": "message_delta", "delta": {"stop_reason": "end_turn"},
                                  "usage": {"output_tokens": 3}}))
            _chunk(handler, _sse({"type": "message_stop"}))
            _end_stream(handler)
        self.server.behaviours["/messages"] = anthropic
        client, events = self.client(api_mode="anthropic", first_token_timeout=0.4,
                                     idle_timeout=0.4)
        result = client.chat(MESSAGES)
        self.assertEqual((result.finish_reason, result.content), ("stop", "answer"))
        self.assertIn("t5", result.thinking)
        self.assertNotIn("retry", events.kinds())

    def test_hidden_reasoning_inside_the_window_gets_a_notice_not_a_kill(self):
        # A Responses-style model thinking silently: nothing for 0.8 s, then the answer.
        self.server.behaviours["/chat/completions"] = chat_answer("late answer", delay=0.8)
        client, events = self.client(first_token_timeout=2.0, stall_notice=0.2, stall_retries=0)
        result = client.chat(MESSAGES)
        self.assertEqual((result.finish_reason, result.content), ("stop", "late answer"))
        self.assertEqual(events.kinds(), ["notice", "cleared"])
        self.assertEqual(events.items[0].phase, "headers")
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 1)

    def test_close_delimited_stream_is_not_misread_as_silent(self):
        def http10(handler, record):
            handler.protocol_version = "HTTP/1.0"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Connection", "close")
            handler.end_headers()
            for index in range(6):
                handler.wfile.write(_chat_delta({"content": f"t{index} "}).encode())
                handler.wfile.flush()
                time.sleep(0.2)
            handler.wfile.write((_chat_delta({}, finish="stop") + "data: [DONE]\n\n").encode())
            handler.wfile.flush()
            handler.close_connection = True
        self.server.behaviours["/chat/completions"] = http10
        client, events = self.client(first_token_timeout=0.4, idle_timeout=0.4, stall_retries=0)
        result = client.chat(MESSAGES)
        self.assertEqual(result.finish_reason, "stop")
        self.assertEqual(result.content, "t0 t1 t2 t3 t4 t5 ")
        self.assertNotIn("retry", events.kinds())

    def test_a_compressed_close_delimited_body_keeps_every_byte(self):
        # The read1 path decodes Content-Encoding itself and hands out at most 64 KiB per call, so
        # a large compressed body spans many calls; every decoded byte must still arrive.
        import gzip
        words = [f"w{index:05d} " for index in range(40_000)]           # ~280 KiB decoded
        body = "".join(_chat_delta({"content": word}) for word in words)
        body += _chat_delta({}, finish="stop") + "data: [DONE]\n\n"
        packed = gzip.compress(body.encode(), compresslevel=9)

        def http10(handler, record):
            handler.protocol_version = "HTTP/1.0"
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Content-Encoding", "gzip")
            handler.end_headers()
            handler.wfile.write(packed)
            handler.wfile.flush()
            handler.close_connection = True
        self.server.behaviours["/chat/completions"] = http10
        client, _ = self.client(first_token_timeout=2, idle_timeout=2, stall_retries=0)
        result = client.chat(MESSAGES)
        self.assertEqual(result.finish_reason, "stop")
        self.assertEqual(result.content, "".join(words))

    @staticmethod
    def _json(handler, value):
        body = json.dumps(value).encode()
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)


# ---- Ollama model load ---------------------------------------------------------------------------
class OllamaLoadTests(StallTestCase):
    def ps_after(self, loaded_at: list[float], delay: float):
        def behaviour(handler, record):
            if not loaded_at:
                loaded_at.append(time.monotonic() + delay)
            models = [{"name": "stall-model:latest"}] if time.monotonic() >= loaded_at[0] else []
            LegitimateSilenceTests._json(handler, {"models": models})
        return behaviour

    def test_ollama_load_pauses_first_token_clock(self):
        loaded_at: list[float] = []
        self.server.behaviours["/api/ps"] = self.ps_after(loaded_at, 1.0)

        def chat(handler, record):
            time.sleep(1.2)             # no headers until the model has loaded and prefilled
            _start_stream(handler, "application/x-ndjson")
            _chunk(handler, json.dumps({"message": {"role": "assistant", "content": "loaded"},
                                        "done": False}) + "\n")
            _chunk(handler, json.dumps({"message": {"role": "assistant", "content": ""},
                                        "done": True, "done_reason": "stop"}) + "\n")
            _end_stream(handler)
        self.server.behaviours["/api/chat"] = chat
        client, events = self.client(path="", api_mode="ollama", first_token_timeout=0.8,
                                     load_timeout=3, stall_notice=0.2, stall_retries=0)
        client._load_probe_interval_s = 0.1
        result = client.chat(MESSAGES)
        self.assertEqual((result.finish_reason, result.content), ("stop", "loaded"))
        notices = [event for event in events.items if event.kind == "notice"]
        self.assertTrue(notices)
        self.assertEqual(notices[0].phase, "loading")
        self.assertEqual(Agent._model_wait_text(notices[0])[0], "Loading the model")
        self.assertEqual(len(self.server.chat_posts("/api/chat")), 1)

    def test_a_model_that_never_loads_is_a_loading_stall(self):
        self.server.behaviours["/api/ps"] = lambda h, r: LegitimateSilenceTests._json(
            h, {"models": [{"name": "some-other-model"}]})
        self.server.behaviours["/api/chat"] = no_headers
        client, _ = self.client(path="", api_mode="ollama", first_token_timeout=0.3,
                                load_timeout=1.0, stall_retries=0)
        client._load_probe_interval_s = 0.1
        started = time.monotonic()
        with self.assertRaises(ModelStallError) as caught:
            client.chat(MESSAGES)
        elapsed = time.monotonic() - started
        self.assertEqual(caught.exception.phase, "loading")
        self.assertIn("did not finish loading", str(caught.exception))
        self.assertGreater(elapsed, 0.9, "the first-token window must not apply while loading")
        self.assertLess(elapsed, 2.5)
        self.assertDisconnected(self.server.chat_posts("/api/chat")[0], 1.0)


# ---- partial output, then silence ----------------------------------------------------------------
class MidStreamStallTests(StallTestCase):
    def test_stall_after_partial_content_returns_incomplete_with_stall_info(self):
        self.server.behaviours["/chat/completions"] = partial_then_silent()
        client, events = self.client(idle_timeout=0.4, stall_retries=2, stall_notice=0.15)
        started = time.monotonic()
        result = client.chat(MESSAGES)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(result.finish_reason, "incomplete")
        self.assertEqual(result.content, "Hello world")
        self.assertEqual(result.stall["phase"], "streaming")
        self.assertTrue(result.stall["progressed"])
        posts = self.server.chat_posts("/chat/completions")
        self.assertEqual(len(posts), 1, "the client never re-issues after text reached the UI")
        self.assertDisconnected(posts[0], 0.4)
        self.assertEqual(events.kinds(), ["notice"])
        self.assertEqual(events.items[0].phase, "streaming")

    def assertMidStreamStall(self, result, posts, content):
        self.assertEqual(result.finish_reason, "incomplete")
        self.assertEqual(result.content, content)
        self.assertIsNotNone(result.stall)
        self.assertEqual((result.stall["phase"], result.stall["progressed"]), ("streaming", True))
        self.assertEqual(len(posts), 1, "the client never re-issues after text reached the UI")
        self.assertDisconnected(posts[0], 0.4)

    def test_anthropic_stall_after_partial_text(self):
        def behaviour(handler, record):
            _start_stream(handler)
            _chunk(handler, "event: message_start\n" + _sse({"type": "message_start", "message": {
                "id": "m", "role": "assistant", "content": [], "usage": {"input_tokens": 1}}}))
            _chunk(handler, _sse({"type": "content_block_start", "index": 0,
                                  "content_block": {"type": "text", "text": ""}}))
            _chunk(handler, _sse({"type": "content_block_delta", "index": 0,
                                  "delta": {"type": "text_delta", "text": "Hello"}}))
            record["gone"] = _client_gone(handler)
        self.server.behaviours["/messages"] = behaviour
        client, _ = self.client(api_mode="anthropic", idle_timeout=0.4, first_token_timeout=5)
        started = time.monotonic()
        result = client.chat(MESSAGES)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertMidStreamStall(result, self.server.chat_posts("/messages"), "Hello")

    def test_native_ollama_stall_after_partial_text(self):
        def behaviour(handler, record):
            _start_stream(handler, "application/x-ndjson")
            _chunk(handler, json.dumps({"model": "stall-model", "done": False,
                                        "message": {"role": "assistant", "content": "Hel"}}) + "\n")
            record["gone"] = _client_gone(handler)
        self.server.behaviours["/api/chat"] = behaviour
        client, _ = self.client(path="", api_mode="ollama", idle_timeout=0.4, first_token_timeout=5)
        started = time.monotonic()
        result = client.chat(MESSAGES)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertMidStreamStall(result, self.server.chat_posts("/api/chat"), "Hel")

    def test_responses_stall_after_partial_text(self):
        def behaviour(handler, record):
            _start_stream(handler)
            _chunk(handler, _sse({"type": "response.created", "response": {"id": "r1"}}))
            _chunk(handler, _sse({"type": "response.output_text.delta", "item_id": "i",
                                  "output_index": 0, "content_index": 0, "delta": "Hi"}))
            record["gone"] = _client_gone(handler)
        self.server.behaviours["/responses"] = behaviour
        client, _ = self.client(api_mode="responses", idle_timeout=0.4, first_token_timeout=5)
        started = time.monotonic()
        result = client.chat(MESSAGES)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertMidStreamStall(result, self.server.chat_posts("/responses"), "Hi")


# ---- Esc / Stop in every phase -------------------------------------------------------------------
class CancelInEveryPhaseTests(StallTestCase):
    def assertCancelledQuickly(self, client, cancel, limit=0.6, **chat_kwargs):
        started = time.monotonic()
        result = client.chat(MESSAGES, cancel=cancel, **chat_kwargs)
        self.assertEqual(result.finish_reason, "cancelled")
        self.assertLess(time.monotonic() - started, limit)
        return result

    def test_cancel_during_header_wait_is_immediate(self):
        self.server.behaviours["/chat/completions"] = no_headers
        client, _ = self.client(first_token_timeout=5)
        self.assertCancelledQuickly(client, _cancel_after(0.1), limit=0.5)
        posts = self.server.chat_posts("/chat/completions")
        self.assertEqual(len(posts), 1)
        self.assertDisconnected(posts[0], 0.1, slack=0.4)

    def test_cancel_during_a_silent_open_stream(self):
        self.server.behaviours["/chat/completions"] = silent_stream
        client, _ = self.client(first_token_timeout=5)
        self.assertCancelledQuickly(client, _cancel_after(0.2))
        self.assertDisconnected(self.server.chat_posts("/chat/completions")[0], 0.2, slack=0.4)

    def test_cancel_during_keepalive_noise(self):
        self.server.behaviours["/chat/completions"] = noise_until_gone(": ping\n\n")
        client, _ = self.client(first_token_timeout=5)
        self.assertCancelledQuickly(client, _cancel_after(0.2))

    def test_cancel_while_the_model_loads(self):
        self.server.behaviours["/api/ps"] = lambda h, r: LegitimateSilenceTests._json(h, {"models": []})
        self.server.behaviours["/api/chat"] = no_headers
        client, _ = self.client(path="", api_mode="ollama", first_token_timeout=5, load_timeout=5)
        client._load_probe_interval_s = 0.05
        self.assertCancelledQuickly(client, _cancel_after(0.3), limit=0.8)
        self.assertDisconnected(self.server.chat_posts("/api/chat")[0], 0.3, slack=0.5)

    def test_cancel_after_partial_output(self):
        self.server.behaviours["/chat/completions"] = partial_then_silent()
        client, _ = self.client(idle_timeout=5)
        result = self.assertCancelledQuickly(client, _cancel_after(0.3), limit=0.8)
        self.assertEqual(result.tool_calls, [])

    def test_cancel_during_a_stall_retry_backoff(self):
        self.server.behaviours["/chat/completions"] = no_headers
        client, _ = self.client(first_token_timeout=0.3, stall_retries=2)
        cancel = threading.Event()
        client.stall_listener = lambda event: cancel.set() if event.kind == "retry" else None
        result = client.chat(MESSAGES, cancel=cancel)
        self.assertEqual(result.finish_reason, "cancelled")
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 1,
                         "a cancel during the backoff never issues the retry")


# ---- one watch per attempt, stopped with it ------------------------------------------------------
def _watch_threads() -> list[str]:
    return [thread.name for thread in threading.enumerate()
            if thread.name in ("dgc-request-watch", "dgc-load-probe") and thread.is_alive()]


class AttemptLifecycleTests(StallTestCase):
    def assertNoWatchThreads(self):
        settle = time.monotonic() + 1.5
        while _watch_threads() and time.monotonic() < settle:
            time.sleep(0.02)
        self.assertEqual(_watch_threads(), [], "every attempt's watch stops with its attempt")

    def test_watches_stop_after_success_errors_and_stalls(self):
        def http_400(handler, record):
            body = b'{"error": {"message": "bad request"}}'
            handler.send_response(400)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
        self.assertNoWatchThreads()
        self.server.behaviours["/chat/completions"] = chat_answer("fine")
        client, _ = self.client(first_token_timeout=0.4, stall_retries=0)
        for _ in range(5):
            self.assertEqual(client.chat(MESSAGES).content, "fine")
        self.assertNoWatchThreads()
        self.server.behaviours["/chat/completions"] = http_400
        for _ in range(3):
            with self.assertRaises(Exception):
                client.chat(MESSAGES)
        self.assertNoWatchThreads()
        self.server.behaviours["/chat/completions"] = silent_stream
        with self.assertRaises(ModelStallError):
            client.chat(MESSAGES)
        self.assertNoWatchThreads()

    def test_a_failed_attempt_raises_no_notice_while_it_backs_off(self):
        # The server hangs up without answering at 0.35 s; the transient retry then backs off for
        # 0.5 s. The ended attempt's watch must not cross its 0.5 s notice threshold during that
        # backoff and narrate "no response" about a request that is already over.
        def hang_up(handler, record):
            time.sleep(0.35)
            handler.close_connection = True
            try:
                handler.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
        self.server.behaviours["/chat/completions"] = sequence(hang_up, chat_answer("second"))
        client, events = self.client(first_token_timeout=5, stall_notice=0.5, stall_retries=0)
        result = client.chat(MESSAGES)
        self.assertEqual(result.content, "second")
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 2)
        self.assertEqual(events.kinds(), [], [(e.kind, e.phase, e.silent_s) for e in events.items])
        self.assertNoWatchThreads()

    def test_the_ollama_load_probe_covers_every_self_hosted_ollama(self):
        for url in ("http://127.0.0.1:11434", "http://192.168.1.60:11434",
                    "http://203.0.113.5:11434", "https://ollama.example.org"):
            with self.subTest(url=url):
                client = LLMClient(url, "k", "some-model", api_mode="ollama")
                self.assertTrue(callable(client._ollama_load_probe()))
        hosted = LLMClient("https://ollama.com", "k", "some-model", api_mode="ollama")
        self.assertIsNone(hosted._ollama_load_probe(), "Ollama's cloud loads models out of sight")
        plain = LLMClient("https://api.example.com/v1", "k", "some-model")
        self.assertIsNone(plain._ollama_load_probe())


# ---- configuration --------------------------------------------------------------------------------
class WindowResolutionTests(unittest.TestCase):
    def test_auto_is_generous_for_local_endpoints_and_shorter_for_remote(self):
        self.assertEqual(resolve_first_token_timeout("auto", "http://127.0.0.1:8080/v1"), 900)
        self.assertEqual(resolve_first_token_timeout("auto", "http://192.168.1.60:11434"), 900)
        self.assertEqual(resolve_first_token_timeout("auto", "http://100.89.32.80:1234/v1"), 900)
        self.assertEqual(resolve_first_token_timeout("auto", "http://gpu-box.local:8000/v1"), 900)
        self.assertEqual(resolve_first_token_timeout("auto", "https://api.openai.com/v1"), 300)
        self.assertEqual(resolve_first_token_timeout("auto", "https://ollama.com", "ollama"), 300)
        self.assertEqual(resolve_first_token_timeout("120", "https://api.openai.com/v1"), 120)
        self.assertEqual(resolve_first_token_timeout(0, "http://127.0.0.1/v1"), 0)
        self.assertFalse(is_local_endpoint("https://openrouter.ai/api/v1", "openrouter"))

    def test_windows_are_clamped_by_a_shorter_read_timeout(self):
        client = LLMClient("https://api.example.com/v1", "k", "m", read_timeout=60,
                           first_token_timeout="auto", idle_timeout=300)
        self.assertEqual(client._stall_windows(), (60, 60))
        watch = client._begin_attempt(None, client._url)
        try:
            self.assertEqual(client._post_timeout(watch), (15, 65))
        finally:
            watch.stop()
        off = LLMClient("https://api.example.com/v1", "k", "m", read_timeout=60,
                        first_token_timeout=0, idle_timeout=0)
        self.assertEqual(off._stall_windows(), (0.0, 0.0))

    def test_agent_clients_read_the_config_keys(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-stall-config-")
        self.addCleanup(tmp.cleanup)
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg.data.update({"model": "m", "base_url": "http://127.0.0.1:9/v1",
                         "model_first_token_timeout_s": "12", "model_idle_timeout_s": 7,
                         "model_stall_notice_s": 3, "model_stall_retries": 4,
                         "model_load_timeout_s": 30})
        agent = Agent(cfg, _QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        client = agent.client
        self.assertEqual((client.first_token_timeout, client.idle_timeout, client.stall_notice,
                          client.stall_retries, client.load_timeout), (12, 7, 3, 4, 30))
        from dgc.config import DEFAULTS
        self.assertEqual((DEFAULTS["model_first_token_timeout_s"], DEFAULTS["model_idle_timeout_s"],
                          DEFAULTS["model_stall_notice_s"], DEFAULTS["model_stall_retries"]),
                         ("auto", 300, 45, 2))


# ---- the Agent: fallback, continuation, notices --------------------------------------------------
class _QuietUI:
    def __init__(self):
        self.infos, self.errors, self.waits, self.activity = [], [], [], []
        self.text = []

    def info(self, message):
        self.infos.append(message)

    def error(self, message):
        self.errors.append(message)

    def on_text(self, chunk):
        self.text.append(chunk)

    def model_wait(self, label, detail="", *, since=None):
        self.waits.append((label, detail))

    def turn_activity(self, state, label, detail=""):
        self.activity.append((state, label, detail))

    def __getattr__(self, name):
        return lambda *a, **k: None


class AgentStallTests(StallTestCase):
    def agent(self, **settings):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-stall-agent-")
        self.addCleanup(tmp.cleanup)
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg.data.update({"model": "stall-model", "base_url": self.server.url + "/v1",
                         "mode": "default", "model_stall_notice_s": 0.15,
                         "model_first_token_timeout_s": 0.4, "model_idle_timeout_s": 0.4,
                         "model_stall_retries": 1, "suggest": False})
        cfg.data.update(settings)
        ui = _QuietUI()
        agent = Agent(cfg, ui)
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(Path(tmp.name))
        return agent, ui

    def test_exhausted_stall_retries_switch_to_the_fallback_model(self):
        def by_model(handler, record):
            if record["body"].get("model") == "backup-model":
                return chat_answer("from the fallback")(handler, record)
            return no_headers(handler, record)
        self.server.behaviours["/chat/completions"] = by_model
        agent, ui = self.agent(fallback_model="backup-model")
        self.assertIs(agent.run_turn("hello", reset_cancel=False) is not False, True)
        stalled = [p for p in self.server.chat_posts("/chat/completions")
                   if p["body"].get("model") == "stall-model"]
        self.assertEqual(len(stalled), 2)
        self.assertTrue(any("retrying (1/1)" in line and "stall-model" in line for line in ui.infos))
        self.assertTrue(any("falling back to backup-model" in line for line in ui.infos))
        self.assertIn("from the fallback", "".join(ui.text))
        self.assertIn(("No response from the model",
                       f"stall-model at 127.0.0.1:{self.server.port} · no reply for 0.1s+"),
                      [(label, detail) for label, detail in ui.waits if label])
        self.assertEqual(ui.waits[-1][0], None, "no stale notice is left on screen")

    def test_exhausted_stall_retries_without_fallback_fail_with_model_and_endpoint(self):
        self.server.behaviours["/chat/completions"] = silent_stream
        agent, ui = self.agent()
        self.assertFalse(agent.run_turn("hello", reset_cancel=False))
        message = ui.errors[-1]
        self.assertIn("stall-model", message)
        self.assertIn(f"127.0.0.1:{self.server.port}/v1/chat/completions", message)
        self.assertIn("no tokens", message)
        self.assertNotIn("start your server", message)
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 2)

    def test_a_mid_stream_stall_continues_from_the_partial_answer(self):
        def second(handler, record):
            return chat_answer("and the rest.")(handler, record)
        self.server.behaviours["/chat/completions"] = sequence(
            partial_then_silent(("The first half ",)), second)
        agent, ui = self.agent()
        self.assertIsNot(agent.run_turn("hello", reset_cancel=False), False)
        posts = self.server.chat_posts("/chat/completions")
        self.assertEqual(len(posts), 2)
        continuation = posts[1]["body"]["messages"]
        self.assertEqual(continuation[-2], {"role": "assistant", "content": "The first half "})
        self.assertIn("Continue exactly where you left off", continuation[-1]["content"])
        self.assertTrue(any("stopped streaming" in line and "(1/1)" in line for line in ui.infos))
        self.assertEqual("".join(ui.text), "The first half and the rest.")

    def test_the_answer_is_the_partial_text_and_its_continuation_in_one_block(self):
        # The cut-off prose and its continuation used to be two blocks (the first shown as
        # commentary) and two messages, so the answer card, Copy and `dgc -p` result.text all held
        # only "and the rest.".
        from dgc.cli import _last_assistant_text
        self.server.behaviours["/chat/completions"] = sequence(
            partial_then_silent(("The first half ",)), chat_answer("and the rest."))
        agent, ui = self.agent()
        timeline = []
        ui.on_text = lambda chunk: (ui.text.append(chunk), timeline.append(("text", chunk)))
        ui.end_stream = lambda phase="": timeline.append(("end", phase))
        self.assertIsNot(agent.run_turn("hello", reset_cancel=False), False)
        ends = [entry for entry in timeline if entry[0] == "end"]
        self.assertEqual(ends, [("end", "answer")], timeline)
        self.assertEqual(timeline[-1], ("end", "answer"), "one block, closed after the continuation")
        assistants = [m for m in agent.messages if m.get("role") == "assistant"]
        self.assertEqual([m["content"] for m in assistants], ["The first half and the rest."])
        self.assertFalse(any("Continue exactly where you left off" in str(m.get("content"))
                             for m in agent.messages), "the stitched reply needs no synthetic prompt")
        self.assertEqual(_last_assistant_text(agent), "The first half and the rest.")

    def test_a_mid_stream_stall_that_repeats_fails_precisely(self):
        self.server.behaviours["/chat/completions"] = partial_then_silent(("partial ",))
        agent, ui = self.agent()
        self.assertFalse(agent.run_turn("hello", reset_cancel=False))
        self.assertEqual(len(self.server.chat_posts("/chat/completions")), 2)
        message = ui.errors[-1]
        self.assertIn("stopped streaming", message)
        self.assertIn("stall-model", message)
        self.assertIn(f"127.0.0.1:{self.server.port}", message)
        self.assertNotIn("provider stream repeatedly ended", message)

    def test_a_mid_stream_stall_inside_a_tool_call_never_runs_the_partial_call(self):
        def partial_call(handler, record):
            _start_stream(handler)
            _chunk(handler, _chat_delta({"tool_calls": [{
                "index": 0, "id": "call_1", "type": "function",
                "function": {"name": "write_file", "arguments": '{"path": "hello.txt", "con'}}]}))
            record["gone"] = _client_gone(handler)
        self.server.behaviours["/chat/completions"] = sequence(partial_call, chat_answer("ok done"))
        agent, ui = self.agent(mode="auto")
        self.assertIsNot(agent.run_turn("write hello.txt", reset_cancel=False), False)
        posts = self.server.chat_posts("/chat/completions")
        self.assertEqual(len(posts), 2, "one stall recovery, then the model answers")
        self.assertDisconnected(posts[0], 0.4)
        self.assertFalse((agent.config.project_root / "hello.txt").exists(),
                         "a tool call cut off mid-arguments is never run")
        replay = json.dumps(posts[1]["body"]["messages"])
        self.assertIn("was NOT run", replay)
        self.assertTrue(any("stopped streaming" in line and "(1/1)" in line for line in ui.infos),
                        ui.infos)
        self.assertIn("ok done", "".join(ui.text))

    def test_a_stall_that_ends_the_turn_does_not_bring_back_the_old_activity(self):
        from dgc.headless import HeadlessUI
        self.server.behaviours["/chat/completions"] = silent_stream
        agent, _ = self.agent()
        capture = _Capture()
        ui = HeadlessUI(capture, None)
        ui.turn_id = "t1"
        agent.ui = ui
        self.assertFalse(agent.run_turn("hello", reset_cancel=False))
        frames = [(event.get("state"), event.get("label")) for event in capture.events
                  if event["type"] in ("turn_activity", "error")]
        notices = [index for index, (state, label) in enumerate(frames)
                   if label in ("No response from the model", "Retrying the model request")]
        self.assertTrue(notices, frames)
        errors = [index for index, event in enumerate(capture.events) if event["type"] == "error"]
        self.assertTrue(errors, [event["type"] for event in capture.events])
        after_first_notice = frames[notices[0]:]
        self.assertTrue(all(state == "waiting" and label != "Waiting for the model"
                            for state, label in after_first_notice if state is not None),
                        f"a stale activity came back before the error: {after_first_notice}")


# ---- front ends ----------------------------------------------------------------------------------
class _Capture:
    def __init__(self):
        self.events = []

    def emit(self, type, **fields):
        self.events.append({"type": type, **fields})


class FrontEndTests(unittest.TestCase):
    def test_headless_model_wait_uses_v12_turn_activity(self):
        from dgc.headless import HeadlessUI
        ui = object.__new__(HeadlessUI)
        ui.em = _Capture()
        ui.turn_id = "t1"
        ui._activity_key = None
        ui._model_wait_saved = ui._model_wait_key = None
        ui._model_waits = {}
        ui.turn_activity("responding", "Responding")
        ui.model_wait("No response from the model", "m at h · no reply for 45s+", since=1.0)
        ui.model_wait("Retrying the model request", "attempt 2 of 3 · m at h")
        ui.model_wait(None)
        frames = [event for event in ui.em.events if event["type"] == "turn_activity"]
        for frame in frames:
            self.assertIsNone(event_error({"seq": 0, **frame}), frame)
        self.assertEqual([(f["state"], f["label"]) for f in frames], [
            ("responding", "Responding"), ("waiting", "No response from the model"),
            ("waiting", "Retrying the model request"), ("responding", "Responding")])
        self.assertEqual(frames[1]["detail"], "m at h · no reply for 45s+")
        # Something newer already said what the turn is doing: clearing must not overwrite it.
        ui.model_wait("The model stopped streaming", "m at h · no tokens for 45s+")
        ui.turn_activity("tool", "Running a command", "npm test")
        ui.model_wait(None)
        self.assertEqual(ui.em.events[-1]["label"], "Running a command")

    def bare_headless(self):
        from dgc.headless import HeadlessUI
        ui = HeadlessUI(_Capture(), None)
        ui.turn_id = "t1"
        return ui

    @staticmethod
    def activity(ui):
        return [(event["state"], event["label"], event.get("detail", ""))
                for event in ui.em.events if event["type"] == "turn_activity"]

    def test_headless_parallel_children_keep_separate_notices(self):
        from dgc.agent import _SubUI
        ui = self.bare_headless()
        ui.turn_activity("tool", "Run sub-agents")
        child_a = _SubUI(ui, "a", buffered=True)
        child_b = _SubUI(ui, "b", buffered=True)
        child_a.model_wait("No response from the model", "A at h · no reply for 45s+")
        child_b.model_wait("No response from the model", "B at h · no reply for 45s+")
        child_a.model_wait(None)            # A resumes; B is still silent
        self.assertEqual(self.activity(ui)[-1],
                         ("waiting", "No response from the model", "B at h · no reply for 45s+"))
        child_b.model_wait(None)            # nobody is waiting any more
        self.assertEqual(self.activity(ui)[-1], ("tool", "Run sub-agents", ""))
        for event in ui.em.events:
            self.assertIsNone(event_error({"seq": 0, **event}), event)

    def test_headless_clear_after_a_failed_call_restores_nothing(self):
        ui = self.bare_headless()
        ui.turn_activity("waiting", "Waiting for the model")
        ui.model_wait("No response from the model", "m at h · no reply for 45s+")
        before = len(ui.em.events)
        ui.model_wait(None, restore=False)
        self.assertEqual(len(ui.em.events), before, "no stale 'Waiting for the model' frame")
        ui.turn_activity("waiting", "Waiting for the model")               # the next request
        ui.model_wait("No response from the model", "m at h · no reply for 45s+")
        ui.model_wait(None)                 # a normal clear still restores
        self.assertEqual(self.activity(ui)[-1], ("waiting", "Waiting for the model", ""))

    def test_tui_parallel_children_keep_separate_notices(self):
        from dgc.agent import _SubUI
        tui = self.bare_tui()
        child_a = _SubUI(tui, "a", buffered=True)
        child_b = _SubUI(tui, "b", buffered=True)
        now = time.monotonic()
        child_a.model_wait("No response from the model", "child-a at 127.0.0.1:1 · no reply", since=now)
        child_b.model_wait("No response from the model", "child-b at 127.0.0.1:2 · no reply", since=now)
        child_a.model_wait(None)
        status = self.plain(tui)
        self.assertIn("child-b at 127.0.0.1:2", status)
        self.assertNotIn("Responding", status)
        child_b.model_wait(None)
        self.assertIn("Responding", self.plain(tui))
        # Streamed text is the newer truth: it hides a notice, and a later clear does not revive it.
        child_a.model_wait("No response from the model", "child-a at 127.0.0.1:1 · no reply", since=now)
        child_b.model_wait("No response from the model", "child-b at 127.0.0.1:2 · no reply", since=now)
        tui._model_wait = None              # what on_text does
        child_b.model_wait(None)
        self.assertIsNone(tui._model_wait)

    def test_a_ui_with_the_original_hook_signature_still_works(self):
        from dgc.agent import _SubUI, _call_model_wait
        seen = []

        class OldUI:
            def model_wait(self, label, detail="", *, since=None):
                seen.append((label, detail, since))
        _call_model_wait(OldUI().model_wait, "No response from the model", "d", since=1.0,
                         restore=False, origin="x")
        _SubUI(OldUI(), "child").model_wait("Loading the model", "m at h", since=2.0)
        self.assertEqual(seen, [("No response from the model", "d", 1.0),
                                ("Loading the model", "m at h", 2.0)])

    def test_classic_repl_renames_a_live_spinner_only(self):
        from unittest import mock
        from dgc.cli import UI

        class FakeTTY:
            def isatty(self):
                return True

            def write(self, text):
                return len(text)

            def flush(self):
                pass
        ui = UI()
        started = []
        ui.start_working = started.append
        with mock.patch.object(sys, "stdout", FakeTTY()):
            ui.model_wait("No response from the model", "m at h")     # no spinner running
            self.assertEqual(started, [])
            ui._work_stop = threading.Event()
            ui.model_wait("No response from the model", "m at h", since=1.0, origin=None)
            ui.model_wait(None, restore=False)                          # clearing is a no-op
        self.assertEqual(started, ["No response from the model"])

    def test_acp_model_wait_sends_nothing(self):
        from unittest import mock
        from dgc.acp import _ACPUi
        server = mock.MagicMock()
        ui = _ACPUi(server, "sess-1", Path(tempfile.gettempdir()))
        self.assertIsNone(ui.model_wait("No response from the model", "m at h", since=1.0,
                                        origin="child"))
        self.assertIsNone(ui.model_wait(None, restore=False))
        self.assertEqual(server.mock_calls, [])

    def bare_tui(self):
        from rich.console import Console
        import io
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        tui._width = 120
        tui.app = None
        tui._naming = False
        tui._flash_msg = ""
        tui._flash_until = 0
        tui._input = None
        tui._req = None
        tui._turn = threading.Event()
        tui._turn.set()
        tui._turn_t0 = time.monotonic() - 70
        tui._streaming = True
        tui._thinking = False
        tui._cur_tool = None
        tui._backend_activity = None
        tui._model_wait = None
        tui.config = {"eta": False}
        tui.agent = SimpleNamespace(estimate_tokens=lambda: 1200)
        tui._rich = lambda value: (lambda buf: (Console(file=buf, force_terminal=True, width=120)
                                                 .print(value, end=""), buf.getvalue())[1])(io.StringIO())
        return tui

    def plain(self, tui) -> str:
        import re
        from prompt_toolkit.formatted_text import to_formatted_text
        text = "".join(part[1] for part in to_formatted_text(tui._status()))
        return re.sub(r"\s+", " ", text)

    def test_tui_status_shows_stall_over_streaming(self):
        tui = self.bare_tui()
        self.assertIn("Responding", self.plain(tui))
        tui.model_wait("The model stopped streaming", "stall-model at 127.0.0.1:8080 · no tokens for 45s+",
                       since=time.monotonic() - 50)
        status = self.plain(tui)
        self.assertIn("The model stopped streaming", status)
        self.assertNotIn("Responding", status)
        self.assertIn("stall-model at 127.0.0.1:8080", status)
        self.assertRegex(status, r"(50|51)\.\ds", "the phase clock counts the real silence")
        tui.model_wait(None)
        self.assertIn("Responding", self.plain(tui))

    def test_tui_callback_route_targets_origin_session(self):
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        tui.app = None
        session_a = SimpleNamespace(_model_wait=None, _model_waits={})
        session_b = SimpleNamespace(_model_wait=None, _model_waits={})
        tui._sessions = [session_a, session_b]
        tui._active_idx = 1                     # B is on screen
        tui._tls = threading.local()
        routed = {}

        def worker():                           # A's turn runs here and captures its route
            tui._tls.session = session_a
            routed["run"] = tui.callback_route()
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()

        def watcher():                          # the stall watcher's own thread
            routed["run"](lambda: tui.model_wait("No response from the model", "m at h"))
            routed["after"] = getattr(tui._tls, "session", None)
        thread = threading.Thread(target=watcher)
        thread.start()
        thread.join()
        self.assertEqual(session_a._model_wait[0], "No response from the model")
        self.assertIsNone(session_b._model_wait)
        self.assertIsNone(routed["after"], "the route restores the watcher thread's own state")


class ServeEmitsTheWaitingNotice(unittest.TestCase):
    """The editor renders ``turn_activity`` label · detail; prove the real backend sends it."""

    def test_dgc_serve_announces_a_silent_model_and_fails_precisely(self):
        server = _Server()
        self.addCleanup(server.close)
        server.behaviours["/chat/completions"] = no_headers
        home = tempfile.TemporaryDirectory(prefix="dgc-stall-serve-home-")
        self.addCleanup(home.cleanup)
        work = tempfile.TemporaryDirectory(prefix="dgc-stall-serve-proj-")
        self.addCleanup(work.cleanup)
        (Path(home.name) / ".dgc").mkdir()
        (Path(home.name) / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": server.url + "/v1", "model": "stall-model", "suggest": False,
            "model_first_token_timeout_s": 1.0, "model_stall_notice_s": 0.3,
            "model_stall_retries": 0, "artifact_autostart": False}))
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT))
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
            env[var] = home.name
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                cwd=work.name, env=env)
        self.addCleanup(lambda: proc.poll() is None and proc.kill())
        for pipe in (proc.stdin, proc.stdout, proc.stderr):
            self.addCleanup(pipe.close)
        events: list[dict] = []
        deadline = time.monotonic() + 60
        sent = False
        while time.monotonic() < deadline:
            line = proc.stdout.readline()
            if not line:
                self.fail("the backend exited early: " + proc.stderr.read()[-2000:])
            event = json.loads(line)
            events.append(event)
            if event.get("type") == "ready" and not sent:
                proc.stdin.write(json.dumps({"type": "prompt", "text": "hello"}) + "\n")
                proc.stdin.flush()
                sent = True
            if event.get("type") == "turn_end":
                break
        proc.stdin.write(json.dumps({"type": "shutdown"}) + "\n")
        proc.stdin.flush()
        proc.wait(timeout=60)
        for event in events:
            self.assertIsNone(event_error(event), event)
        waiting = [e for e in events if e.get("type") == "turn_activity"
                   and e.get("label") == "No response from the model"]
        self.assertTrue(waiting, [e for e in events if e.get("type") == "turn_activity"])
        self.assertEqual(waiting[0]["state"], "waiting")
        self.assertEqual(waiting[0]["detail"],
                         f"stall-model at 127.0.0.1:{server.port} · no reply for 0.3s+")
        errors = [e for e in events if e.get("type") == "error"]
        self.assertTrue(errors, [e["type"] for e in events])
        self.assertIn(f"model 'stall-model' at http://127.0.0.1:{server.port}/v1/chat/completions",
                      errors[-1]["message"])
        self.assertNotIn("start your server", errors[-1]["message"])
        # Between the notice and the error nothing may bring back the activity the notice replaced.
        first_notice = events.index(waiting[0])
        last_error = events.index(errors[-1])
        between = [(e.get("state"), e.get("label")) for e in events[first_notice:last_error]
                   if e.get("type") == "turn_activity"]
        self.assertTrue(all(label in ("No response from the model", "Retrying the model request")
                            for _, label in between), between)


if __name__ == "__main__":
    unittest.main()
