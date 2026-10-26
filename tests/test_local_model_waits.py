"""A slow local model is never timed out while its server is still working on the request.

A model on this computer or network can take tens of minutes before its first token (a load from a
slow disk, then a long prefill). Each re-send makes the server start the prompt again, so the old
900 s first-token window, the 900 s load window and the 1800 s socket ceiling made the founder's
case fail after about 45 minutes. Now a local request asks its server (dgc/server_check.py) and is
closed only when the server is gone or no longer working on it; a cloud request keeps its limits.

The servers here are real local HTTP servers shaped like Ollama, llama.cpp, LM Studio and vLLM.
Time inside the watcher is a fake clock (injected into every RequestWatch the client starts), so
"20 minutes" passes in a second; a few tests use real time where the socket itself is the subject.
"""
from __future__ import annotations

import functools
import json
import os
import pwd
import select
import socket
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:                    # imported by another module first: verify, never assume
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_local_model_waits.py needs HOME redirected before dgc is "
                           "imported — run it through tests/run_tests.py or with HOME=<tmp>")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-local-waits-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

from dgc import llm as llm_module                           # noqa: E402  (after the redirect above)
from dgc import model_watch                                 # noqa: E402
from dgc.llm import LLMClient, LLMError, ModelStallError    # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
from waiting import wait_until                              # noqa: E402

MESSAGES = [{"role": "user", "content": "read this whole repository"}]


class FakeClock:
    """The watcher's monotonic clock, moved by the test."""

    def __init__(self):
        self._t = 10_000.0
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self._t

    def advance(self, seconds: float, *, step: float = 10.0, pause: float = 0.01, until=None) -> None:
        """Move forward in steps, letting the watcher and the server checks run in between."""
        moved = 0.0
        while moved < seconds:
            if until is not None and until():
                return
            delta = min(step, seconds - moved)
            with self._lock:
                self._t += delta
            moved += delta
            time.sleep(pause)


def _client_closed(conn) -> bool:
    try:
        readable, _, _ = select.select([conn], [], [], 0)
        if not readable:
            return False
        return not conn.recv(1, socket.MSG_PEEK)
    except (OSError, ValueError):
        return True


class Stub:
    """A local model server. Each GET path answers from a function the test sets; a chat request
    holds its first token until ``release`` is set (or the client hangs up, which is recorded)."""

    def __init__(self):
        self.posts: list[dict] = []
        self.gets: list[str] = []
        self.lock = threading.Lock()
        self.release = threading.Event()
        self.get_routes: dict[str, object] = {}
        self.answer_text = "done after the long prefill"
        self.first_words = ""           # set: the chat sends these at once, then goes quiet mid-answer
        outer = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_GET(self):
                with outer.lock:
                    outer.gets.append(self.path)
                route = outer.get_routes.get(self.path)
                if route is None:
                    self._send(404, b"")
                    return
                status, body, ctype = route()
                self._send(status, body if isinstance(body, bytes) else json.dumps(body).encode(), ctype)

            def _send(self, status, body, ctype="application/json"):
                self.send_response(status)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                if body:
                    self.wfile.write(body)

            def do_POST(self):
                length = int(self.headers.get("Content-Length", 0) or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                if not self.path.endswith(("/api/chat", "/chat/completions")):
                    self._send(404, b"")        # /api/show and other metadata: nothing to say
                    return
                record = {"path": self.path, "body": body, "gone": None}
                with outer.lock:
                    outer.posts.append(record)
                if outer.first_words and self.path.endswith("/api/chat"):
                    # A few words at once, then silence mid-answer until released, then the rest.
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-ndjson")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()

                    def chunk(obj):
                        data = json.dumps(obj).encode() + b"\n"
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(data), data))
                        self.wfile.flush()
                    try:
                        chunk({"message": {"role": "assistant", "content": outer.first_words}, "done": False})
                        while not outer.release.wait(0.01):
                            if _client_closed(self.connection):
                                record["gone"] = time.monotonic()
                                return
                        chunk({"message": {"role": "assistant", "content": " and the rest."}, "done": False})
                        chunk({"message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop"})
                        self.wfile.write(b"0\r\n\r\n")
                        self.wfile.flush()
                    except OSError:
                        record["gone"] = time.monotonic()
                    return
                # No headers until the first token: a long prefill, as llama.cpp and Ollama do it.
                while not outer.release.wait(0.01):
                    if _client_closed(self.connection):
                        record["gone"] = time.monotonic()
                        return
                if self.path.endswith("/api/chat"):
                    lines = [{"message": {"role": "assistant", "content": outer.answer_text}, "done": False},
                             {"message": {"role": "assistant", "content": ""}, "done": True,
                              "done_reason": "stop"}]
                    payload = b"".join(json.dumps(line).encode() + b"\n" for line in lines)
                    ctype = "application/x-ndjson"
                else:
                    chunks = [{"choices": [{"index": 0, "delta": {"content": outer.answer_text},
                                            "finish_reason": None}]},
                              {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]}]
                    payload = b"".join(b"data: " + json.dumps(c).encode() + b"\n\n" for c in chunks)
                    payload += b"data: [DONE]\n\n"
                    ctype = "text/event-stream"
                try:
                    self._send(200, payload, ctype)
                except OSError:
                    record["gone"] = time.monotonic()

        class Server(ThreadingHTTPServer):
            daemon_threads = True

            def handle_error(self, request, client_address):
                pass

        self.httpd = Server(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.closed = False

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop_listening(self):
        """The server goes away: new connections are refused; a request already open stays open."""
        if not self.closed:
            self.closed = True
            self.httpd.shutdown()
            self.httpd.server_close()

    def close(self):
        self.release.set()
        self.stop_listening()

    def chat_posts(self) -> list[dict]:
        with self.lock:
            return list(self.posts)

    def checks(self, path: str) -> int:
        with self.lock:
            return sum(1 for p in self.gets if p == path)


def ollama_ps(*names, context_length=0):
    models = [{"name": n, "model": n, "expires_at": "2026-10-25T13:33:51.9+05:30",
               **({"context_length": context_length} if context_length else {})} for n in names]
    return lambda: (200, {"models": models}, "application/json")


class Events:
    def __init__(self):
        self.items = []
        self.lock = threading.Lock()

    def __call__(self, event):
        with self.lock:
            self.items.append(event)

    def of(self, kind):
        with self.lock:
            return [e for e in self.items if e.kind == kind]


class LocalWaitCase(unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)
        self.clock = FakeClock()
        # Every watch the client starts runs on the fake clock and polls quickly. RequestWatch is
        # looked up in dgc.llm at each attempt, on this branch and on the release before it alike.
        patcher = mock.patch.object(llm_module, "RequestWatch",
                                    functools.partial(model_watch.RequestWatch, clock=self.clock,
                                                      poll_s=0.02))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.results: list = []

    def client(self, path="", model="big-local:latest", **kwargs):
        kwargs.setdefault("api_mode", "ollama")
        client = LLMClient(self.stub.url + path, "key", model, **kwargs)
        client._server_check_interval_s = 30.0       # the shipped cadence, on the fake clock
        client._server_recheck_s = 10.0
        client._load_probe_interval_s = 5.0
        events = Events()
        client.stall_listener = events
        return client, events

    def record_watches(self) -> list:
        """The watches this test's requests start, to wait (in real time) for what their server first said."""
        watches: list = []
        start = llm_module.RequestWatch

        def recording(*args, **kwargs):
            watch = start(*args, **kwargs)
            watches.append(watch)
            return watch
        patcher = mock.patch.object(llm_module, "RequestWatch", recording)
        patcher.start()
        self.addCleanup(patcher.stop)
        return watches

    @staticmethod
    def first_answer(watches) -> None:
        """An Ollama server is asked at once, and in real time answers long before any notice or deadline. The
        fake clock runs 1,000 times faster: wait for that answer before moving it (a slow runner answered late)."""
        wait_until(lambda: watches and watches[-1].verdict, what="the server's first answer")

    def chat_in_background(self, client, cancel=None):
        def run():
            try:
                self.results.append(client.chat(MESSAGES, cancel=cancel))
            except BaseException as exc:            # noqa: BLE001 -- the test reads it
                self.results.append(exc)
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 10)
        self.addCleanup(self.stub.release.set)
        return thread

    def assertNotResent(self, message="the request was sent again"):
        """Nothing re-sent, and the first request still open, after a stall retry's backoff (1 s)."""
        time.sleep(1.5)
        self.assertEqual(len(self.stub.chat_posts()), 1, message)
        self.assertIsNone(self.stub.chat_posts()[0]["gone"], "the working request was closed")

    def finish(self, thread, timeout=10.0):
        self.stub.release.set()
        thread.join(timeout)
        self.assertFalse(thread.is_alive(), "the request never finished")
        self.assertEqual(len(self.results), 1)
        return self.results[0]


# ---- a working local server is waited for ----------------------------------------------------------
class WorkingLocalServerTests(LocalWaitCase):
    def test_a_first_token_after_the_old_900s_limit_is_waited_for_and_never_re_sent(self):
        self.stub.get_routes["/api/ps"] = ollama_ps("big-local:latest")
        watches = self.record_watches()
        client, events = self.client()
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.first_answer(watches)
        self.clock.advance(1500)            # 25 minutes of prefill, past 900 s (and 1200 s)
        self.assertNotResent()
        result = self.finish(thread)
        self.assertNotIsInstance(result, BaseException, result)
        self.assertEqual((result.finish_reason, result.content), ("stop", "done after the long prefill"))
        self.assertEqual(len(self.stub.chat_posts()), 1)
        self.assertGreater(self.stub.checks("/api/ps"), 10, "the server was asked as it went")
        notice = events.of("notice")
        self.assertTrue(notice, "the waiting notice is still shown")
        self.assertEqual(getattr(notice[0], "server", ""), "working")
        self.assertFalse(events.of("retry"))

    def test_an_explicit_first_word_limit_still_waits_while_the_server_works(self):
        self.stub.get_routes["/api/ps"] = ollama_ps("big-local:latest")
        client, events = self.client(first_token_timeout=60)
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.clock.advance(600)             # ten times the limit
        self.assertNotResent("re-sent although the server was working")
        result = self.finish(thread)
        self.assertEqual(result.content, "done after the long prefill")
        self.assertFalse(events.of("retry"))

    def test_a_load_longer_than_the_old_900s_window_is_waited_for(self):
        loaded = threading.Event()
        self.stub.get_routes["/api/ps"] = lambda: (
            200, {"models": [{"name": "big-local:latest"}] if loaded.is_set() else []}, "application/json")
        watches = self.record_watches()
        client, events = self.client()
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.first_answer(watches)
        self.clock.advance(2400)            # 40 minutes loading from a slow disk
        self.assertTrue(events.of("notice"), "no loading notice")
        self.assertEqual(events.of("notice")[0].phase, "loading")
        loaded.set()
        self.clock.advance(1200)            # then 20 minutes of prefill
        self.assertNotResent("the load was started over")
        result = self.finish(thread)
        self.assertEqual(result.content, "done after the long prefill")

    def test_when_the_load_ends_the_loading_notice_gives_way_at_once(self):
        loaded = threading.Event()
        self.stub.get_routes["/api/ps"] = lambda: (
            200, {"models": [{"name": "big-local:latest"}] if loaded.is_set() else []}, "application/json")
        watches = self.record_watches()
        client, events = self.client()                      # the notice threshold stays 45 s
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.first_answer(watches)
        self.clock.advance(20, step=1.0)
        wait_until(lambda: events.of("notice"), timeout=5, what="the loading notice")
        self.assertEqual([e.phase for e in events.of("notice")], ["loading"])
        loaded.set()                                        # loaded at 20 s, well before 45 s
        self.clock.advance(10, step=1.0)
        wait_until(lambda: len(events.of("notice")) == 2, timeout=5, what="the notice after the load")
        after = events.of("notice")[1]
        self.assertNotEqual(after.phase, "loading")
        self.assertEqual(after.server, "working")
        self.assertLess(after.silent_s, 45)
        self.assertEqual(self.finish(thread).content, "done after the long prefill")

    def test_silence_between_words_is_waited_for_while_the_server_works(self):
        self.stub.get_routes["/api/ps"] = ollama_ps("big-local:latest")
        self.stub.first_words = "Reading"
        client, events = self.client(idle_timeout=300)              # Wait between words: 5 minutes
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        time.sleep(0.2)                                             # the first words land
        self.clock.advance(1200)                                    # 20 minutes of quiet mid-answer
        self.assertNotResent("cut off mid-answer while the server worked")
        result = self.finish(thread)
        self.assertEqual((result.finish_reason, result.content), ("stop", "Reading and the rest."))
        self.assertFalse(getattr(result, "stall", None), "not a stall, not a continuation")

    def test_a_busy_llama_cpp_slot_is_waited_for_then_an_idle_one_is_re_sent(self):
        busy = threading.Event()
        busy.set()
        self.stub.get_routes["/slots"] = lambda: (
            200, [{"id": 0, "is_processing": busy.is_set()}, {"id": 1, "is_processing": False}],
            "application/json")
        client, events = self.client(path="/v1", model="qwen-big", api_mode="chat_completions")
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.clock.advance(1500)
        self.assertNotResent("re-sent while a slot was processing")
        busy.clear()                        # the server dropped the request: no slot works on it
        self.clock.advance(300, until=lambda: len(self.stub.chat_posts()) > 1)
        wait_until(lambda: len(self.stub.chat_posts()) == 2, what="the re-send")
        wait_until(lambda: self.stub.chat_posts()[0]["gone"] is not None, what="the old request to close")
        retry = events.of("retry")
        self.assertTrue(retry)
        self.assertIn("stopped working on the request", retry[0].summary)
        result = self.finish(thread)
        self.assertEqual(result.content, "done after the long prefill")


# ---- a re-send happens when the server is gone or no longer on it -----------------------------------
class ResendTests(LocalWaitCase):
    def test_a_server_that_stops_answering_is_given_up_on_well_before_the_old_limit(self):
        self.stub.get_routes["/api/ps"] = ollama_ps("big-local:latest")
        client, events = self.client(stall_retries=0)
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.clock.advance(120)
        self.assertTrue(thread.is_alive(), "gave up on a server that answered")
        self.stub.stop_listening()          # the server goes; the open request hangs, no FIN
        self.clock.advance(200, until=lambda: not thread.is_alive())
        thread.join(5)
        self.assertFalse(thread.is_alive(), "still waiting on a server that is gone")
        wait_until(lambda: self.stub.chat_posts()[0]["gone"] is not None, what="the request to close")
        error = self.results[0]
        self.assertIsInstance(error, ModelStallError)
        self.assertEqual(error.info.reason, "server_gone")
        self.assertIn("unreachable", str(error))
        self.assertEqual(llm_module.explain_llm_error(str(error)).count("→"), 1)

    def test_a_model_the_server_no_longer_lists_is_re_sent(self):
        listed = threading.Event()
        listed.set()
        self.stub.get_routes["/api/ps"] = lambda: (
            200, {"models": [{"name": "big-local:latest"}] if listed.is_set() else []}, "application/json")
        watches = self.record_watches()
        client, events = self.client()
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.first_answer(watches)
        self.clock.advance(300)
        self.assertEqual(len(self.stub.chat_posts()), 1)
        listed.clear()                      # the model went away (crashed, or unloaded)
        self.clock.advance(300, until=lambda: len(self.stub.chat_posts()) > 1)
        wait_until(lambda: len(self.stub.chat_posts()) == 2, what="the re-send")
        retry = events.of("retry")
        self.assertTrue(retry)
        self.assertIn("stopped working on the request", retry[0].summary)
        listed.set()
        result = self.finish(thread)
        self.assertEqual(result.content, "done after the long prefill")

    def test_another_context_s_copy_going_away_is_not_this_request_s_model_going_away(self):
        # Pips and the main chat can load one model with two windows: Ollama keeps a copy per
        # window, and the request waits for the other copy to make room. That copy leaving is not
        # this request's model leaving.
        other = threading.Event()
        other.set()
        self.stub.get_routes["/api/ps"] = lambda: (
            200, {"models": [{"name": "big-local:latest", "context_length": 32768}] if other.is_set() else []},
            "application/json")
        client, events = self.client(context_size=65536)
        client.window_limit = lambda: 0
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.assertEqual(self.stub.chat_posts()[0]["body"]["options"]["num_ctx"], 65536)
        self.clock.advance(300)
        other.clear()
        self.clock.advance(1200)
        self.assertNotResent("re-sent when another request's copy unloaded")
        self.assertEqual(self.finish(thread).content, "done after the long prefill")


# ---- remote and cloud work keeps today's limits ---------------------------------------------------
class CloudKeepsItsLimitsTests(LocalWaitCase):
    def test_an_ollama_cloud_model_still_times_out_and_is_retried(self):
        self.stub.get_routes["/api/ps"] = ollama_ps("glm-5.3:cloud")
        client, events = self.client(model="glm-5.3:cloud")
        self.assertEqual(client.first_token_timeout, 300)
        thread = self.chat_in_background(client)
        wait_until(lambda: self.stub.chat_posts(), what="the request to arrive")
        self.clock.advance(330, until=lambda: len(self.stub.chat_posts()) > 1)
        wait_until(lambda: len(self.stub.chat_posts()) == 2, what="the retry after 300 s")
        self.assertIsNotNone(self.stub.chat_posts()[0]["gone"])
        self.assertTrue(events.of("retry"))
        self.assertEqual(self.stub.checks("/api/ps"), 0, "a cloud model's local Ollama is never asked")
        self.assertEqual(self.finish(thread).content, "done after the long prefill")

    def test_a_remote_endpoint_keeps_its_windows_and_socket_ceiling(self):
        client = LLMClient("https://api.example.com/v1", "k", "m", read_timeout=1800)
        self.assertIsNone(client._local_server_check())
        self.assertEqual(client._stall_windows(), (300, 300))
        watch = client._begin_attempt(None, client._url)
        try:
            self.assertFalse(watch.local)
            self.assertEqual(client._post_timeout(watch), (15, 1800))
        finally:
            watch.stop()


# ---- the socket's own ceiling ---------------------------------------------------------------------
class SocketCeilingTests(unittest.TestCase):
    """Real time: the subject is the socket's read timeout, which no fake clock moves."""

    def test_request_timeout_does_not_cut_a_working_local_prefill(self):
        stub = Stub()
        self.addCleanup(stub.close)
        stub.get_routes["/api/ps"] = ollama_ps("big-local:latest")
        client = LLMClient(stub.url, "key", "big-local:latest", api_mode="ollama", read_timeout=1,
                           first_token_timeout=0, stall_retries=0)
        threading.Timer(2.5, stub.release.set).start()      # silent for 2.5 x request_timeout
        result = client.chat(MESSAGES)
        self.assertEqual(result.content, "done after the long prefill")
        self.assertEqual(len(stub.chat_posts()), 1)
        watch = client._begin_attempt(None, client._ollama_url)
        try:
            self.assertTrue(watch.local)
            self.assertEqual(client._post_timeout(watch), (15, model_watch.LOCAL_SOCKET_CEILING_S))
        finally:
            watch.stop()

    def test_a_caller_that_lowers_read_timeout_keeps_its_bound_on_a_local_model(self):
        # A title, a suggestion or a turn budget's remainder lowers read_timeout to bound that call.
        client = LLMClient("http://127.0.0.1:9/v1", "k", "m", read_timeout=1800)
        client.read_timeout = 60
        watch = client._begin_attempt(None, client._url)
        try:
            self.assertFalse(watch.local)
            self.assertEqual((watch.first_token_s, watch.idle_s), (60, 60))
            self.assertEqual(client._post_timeout(watch), (15, 65))
        finally:
            watch.stop()
        client.read_timeout = 1800
        watch = client._begin_attempt(None, client._url)
        try:
            self.assertTrue(watch.local, "back at its own value, the call is checked again")
        finally:
            watch.stop()

    def test_a_client_built_bounded_keeps_its_bound_on_a_local_model(self):
        # The memory look back runs in the background with 90 s; a slow local model must not hold it open.
        from dgc import memory_review
        from dgc.config import Config
        cfg = Config(Path(tempfile.mkdtemp(prefix="dgc-local-waits-review-")))
        cfg.data.update({"base_url": "http://127.0.0.1:9/v1", "model": "big-local:latest"})
        client = memory_review.client_for(cfg)
        watch = client._begin_attempt(None, client._url)
        try:
            self.assertFalse(watch.local)
            self.assertEqual((watch.first_token_s, watch.idle_s), (90, 90))
            self.assertEqual(client._post_timeout(watch), (15, 95))
        finally:
            watch.stop()

    def test_a_local_request_with_no_server_check_keeps_the_bounded_windows(self):
        client = LLMClient("http://127.0.0.1:9/v1", "k", "m", read_timeout=1800)
        client._local_server_check = lambda *a, **k: None       # as a reviewed Pips specialist run
        watch = client._begin_attempt(None, client._url)
        try:
            self.assertFalse(watch.local)
            self.assertEqual((watch.first_token_s, watch.idle_s), (900, 300))
            self.assertEqual(client._post_timeout(watch), (15, 1800))
        finally:
            watch.stop()


# ---- the watcher on its own -------------------------------------------------------------------------
class WatchTests(unittest.TestCase):
    def test_a_later_deadline_asks_the_server_again(self):
        # A deadline shorter than the check interval (Wait between words: 20 s, checks every 30 s) asks the server;
        # new words arrive before it answers. Much later the model goes quiet again: that deadline must ask the
        # server afresh, not fall back on the old question and close a request the server is still working on.
        clock = FakeClock()
        gate = threading.Event()
        asked = []

        def check():
            asked.append(clock())
            gate.wait(5)
            return "working"
        watch = model_watch.RequestWatch(None, first_token_s=0, idle_s=20, clock=clock, poll_s=0.01,
                                         server_check=check, check_every_s=30, recheck_s=10)
        with mock.patch.object(model_watch, "CHECK_ANSWER_S", 0.3):
            watch.start()
            self.addCleanup(watch.stop)
            watch.attach_response(None)
            watch.progress()
            clock.advance(21, step=1.0)                     # the first deadline: the server is asked
            wait_until(lambda: asked, timeout=5, what="the first check")
            watch.progress()                                # words arrive before it answers
            gate.set()
            wait_until(lambda: watch.verdict == "working", timeout=5, what="its answer")
            for _ in range(5):                              # 50 s of steady words: no deadline, no check
                clock.advance(10, step=1.0)
                watch.progress()
            time.sleep(0.4)                                 # longer than a check may take to answer
            n = len(asked)
            clock.advance(25, step=1.0)                     # quiet past the deadline, the old answer stale
            wait_until(lambda: len(asked) > n, timeout=5, what="a fresh check at the later deadline")
            time.sleep(0.3)
            self.assertEqual(watch.aborted, "", "closed a request the server was still working on")


# ---- what each kind of server says -----------------------------------------------------------------
class ServerCheckTests(unittest.TestCase):
    def setUp(self):
        self.stub = Stub()
        self.addCleanup(self.stub.close)
        from dgc import server_check
        self.sc = server_check
        server_check.forget_detected()

    def check(self, model="m", kind="", num_ctx=0, path=""):
        return self.sc.ServerCheck(self.stub.url + path, model, kind=kind, num_ctx=num_ctx)

    def test_ollama_lists_loads_and_identifies_the_request_s_copy(self):
        state = {"models": []}
        self.stub.get_routes["/api/ps"] = lambda: (200, state, "application/json")
        check = self.check("qwen:122b", kind="ollama", num_ctx=8192)
        self.assertEqual(check(), "loading")
        state["models"] = [{"name": "qwen:122b", "context_length": 4096}]
        self.assertEqual(check(), "loading", "another context's copy is not this request's")
        state["models"] = [{"name": "qwen:122b", "context_length": 8192}]
        self.assertEqual(check(), "working")
        state["models"] = []
        self.assertEqual(check(), "idle", "seen loaded, then gone")
        first = self.check("qwen:122b", kind="ollama")
        state["models"] = [{"name": "qwen:122b:latest"}]
        self.assertEqual(first(), "working")
        state["models"] = []
        self.assertEqual(first(), "loading", "a copy seen only at the start may be making room")

    def test_llama_cpp_slots_health_and_a_busy_worker(self):
        self.stub.get_routes["/slots"] = lambda: (200, [{"id": 0, "is_processing": True}], "application/json")
        self.assertEqual(self.check(kind="llamacpp", path="/v1")(), "working")
        self.stub.get_routes["/slots"] = lambda: (200, [{"id": 0, "is_processing": False}], "application/json")
        self.assertEqual(self.check(kind="llamacpp", path="/v1")(), "idle")
        self.stub.get_routes["/slots"] = lambda: (200, [{"id": 0, "state": 1}], "application/json")
        self.assertEqual(self.check(kind="llamacpp")(), "working", "older servers say state 1")
        self.stub.get_routes["/slots"] = lambda: (503, {"error": {"message": "Loading model"}}, "application/json")
        self.assertEqual(self.check(kind="llamacpp")(), "loading")
        self.stub.get_routes.pop("/slots")
        self.stub.get_routes["/health"] = lambda: (200, {"status": "ok"}, "application/json")
        self.assertEqual(self.check(kind="llamacpp")(), "unknown", "/slots off: up, nothing more")

        def slow():
            time.sleep(1.0)
            return 200, [], "application/json"
        self.stub.get_routes["/slots"] = slow
        with mock.patch.object(self.sc, "_TIMEOUT", (1.0, 0.4)):
            self.assertEqual(self.check(kind="llamacpp")(), "working",
                             "a /slots that waits for the worker while /health answers: the worker is busy")

    def test_lm_studio_and_vllm(self):
        self.stub.get_routes["/api/v0/models"] = lambda: (
            200, {"data": [{"id": "qwen", "state": "loaded"}, {"id": "other", "state": "not-loaded"}]},
            "application/json")
        self.assertEqual(self.check("qwen", kind="lmstudio")(), "working")
        self.assertEqual(self.check("other", kind="lmstudio")(), "loading")
        metrics = ['# HELP vllm:num_requests_running running', 'vllm:num_requests_running{model_name="q"} 1.0',
                   'vllm:num_requests_waiting{model_name="q"} 0.0']
        self.stub.get_routes["/metrics"] = lambda: (200, "\n".join(metrics).encode(), "text/plain")
        self.assertEqual(self.check(kind="vllm")(), "working")
        metrics[1] = 'vllm:num_requests_running{model_name="q"} 0.0'
        self.assertEqual(self.check(kind="vllm")(), "idle")

    def test_an_unknown_local_server_is_recognised_or_only_known_to_be_up(self):
        self.stub.get_routes["/slots"] = lambda: (200, [{"id": 0, "is_processing": True}], "application/json")
        self.assertEqual(self.check(path="/v1")(), "working", "llama.cpp on a port of its own")
        self.sc.forget_detected()
        self.stub.get_routes.pop("/slots")
        self.assertEqual(self.check(path="/v1")(), "unknown")
        self.stub.stop_listening()
        self.sc.forget_detected()
        self.assertEqual(self.check(path="/v1")(), "gone")


# ---- settings and config ---------------------------------------------------------------------------
class ConfigTests(unittest.TestCase):
    def test_the_old_stored_load_default_becomes_auto(self):
        from dgc import config as config_module
        self.assertEqual(config_module.DEFAULTS["model_load_timeout_s"], "auto")
        path = Path(config_module.USER_CONFIG)
        self.assertNotEqual(Path(config_module.USER_HOME).parent, Path(_REAL_HOME), "never the real ~/.dgc")
        path.parent.mkdir(parents=True, exist_ok=True)
        before = path.read_text() if path.exists() else None
        self.addCleanup(lambda: path.write_text(before) if before is not None else path.unlink(missing_ok=True))
        project = tempfile.TemporaryDirectory(prefix="dgc-local-waits-project-")
        self.addCleanup(project.cleanup)
        for stored, expected in ((900, "auto"), (1200, 1200), ("auto", "auto")):
            with self.subTest(stored=stored):
                path.write_text(json.dumps({"model_load_timeout_s": stored}))
                cfg = config_module.Config(Path(project.name))
                self.assertEqual(cfg.get("model_load_timeout_s"), expected)

    def test_the_notice_says_a_working_server_is_working(self):
        from dgc.agent import Agent
        ev = model_watch.WaitEvent(kind="notice", phase="first_token", model="qwen3.5:122b",
                                   endpoint="http://127.0.0.1:11434/api/chat", threshold_s=45,
                                   server="working")
        self.assertEqual(Agent._model_wait_text(ev),
                         ("Waiting for the model", "qwen3.5:122b at 127.0.0.1:11434 · the server is working on it"))
        quiet = SimpleNamespace(**{**ev.__dict__, "server": "unknown"})
        self.assertEqual(Agent._model_wait_text(quiet)[0], "No response from the model")



# ---- Settings -> Models -> Advanced through the editor protocol -------------------------------------
class SettingsRoundTripTests(unittest.TestCase):
    """The two waits travel in a NEW event, model_wait_settings, to an editor whose get_config `fields` named it
    (never as new fields on `config`), and set_config takes and validates both keys."""

    def setUp(self):
        import io
        from dgc import config as config_module
        from dgc import headless, sessions
        from dgc.config import Config
        self.headless = headless
        tmp = Path(tempfile.mkdtemp(prefix="dgc-wait-settings-")).resolve()
        self.user = tmp / "user-dgc"
        self.user.mkdir()
        for name, value in (("USER_HOME", self.user), ("USER_CONFIG", self.user / "config.json"),
                            ("USER_SECRETS", self.user / "secrets.json")):
            patcher = mock.patch.object(config_module, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.user / "config.json").write_text(json.dumps({
            "model": "qwen3.5:122b", "base_url": "http://localhost.invalid:11434/v1", "suggest": False,
            "artifact_autostart": False, "mcp_servers": {}}))
        scoped = mock.patch.object(sessions, "SESSIONS_DIR", tmp / "sessions")
        scoped.start()
        self.addCleanup(scoped.stop)
        (tmp / "a" / ".git").mkdir(parents=True)
        self.wire = io.StringIO()
        self.host = headless.Host(Config(project_root=tmp / "a"))
        self.host.core.fp = self.wire
        self.addCleanup(lambda: [chat.agent.mcp.stop_all() for chat in list(self.host.chats.values())])

    def frames(self):
        return [json.loads(line) for line in self.wire.getvalue().splitlines()]

    def last(self, kind):
        found = [f for f in self.frames() if f["type"] == kind]
        self.assertTrue(found, f"no {kind} frame: {self.frames()[-3:]}")
        return found[-1]

    def test_settings_reads_and_saves_both_waits_and_the_next_request_uses_them(self):
        from dgc import editor_protocol as ep
        self.host.dispatch({"type": "get_config", "request_id": "c0"})
        self.last("config")
        self.assertEqual([f for f in self.frames() if f["type"] == "model_wait_settings"], [],
                         "an editor that did not ask never sees the new event")
        self.host.dispatch({"type": "get_config", "request_id": "c1", "fields": ["model_wait_settings"]})
        frames = self.frames()
        asked = [f for f in frames if f["type"] == "model_wait_settings"]
        self.assertEqual(len(asked), 1)
        self.assertEqual((asked[0]["first_token"], asked[0]["between_words_s"]), ("auto", 300))
        self.assertIsNone(ep.event_error(asked[0]))
        self.assertLess(frames.index(asked[0]), max(i for i, f in enumerate(frames) if f["type"] == "config"))
        self.assertNotIn("model_first_token_timeout_s", self.last("config"), "never a new field on config")

        self.host.dispatch({"type": "set_config", "request_id": "s1",
                            "values": {"model_first_token_timeout_s": 1200, "model_idle_timeout_s": 600}})
        self.assertEqual([f for f in self.frames() if f["type"] == "command_rejected"], [])
        saved = json.loads((self.user / "config.json").read_text())
        self.assertEqual((saved["model_first_token_timeout_s"], saved["model_idle_timeout_s"]), (1200, 600))
        client = self.host.default.agent.client
        self.assertEqual((client.first_token_timeout, client.idle_timeout), (1200, 600),
                         "the client this chat sends its next request with")
        self.assertEqual((self.last("model_wait_settings")["first_token"],
                          self.last("model_wait_settings")["between_words_s"]), ("1200", 600))
        self.host.dispatch({"type": "set_config", "request_id": "s2",
                            "values": {"model_first_token_timeout_s": "auto"}})
        self.assertEqual(self.host.default.agent.client.first_token_timeout, 0, "auto: no limit for a local model")
        self.assertEqual(self.last("model_wait_settings")["first_token"], "auto")
        self.host.dispatch({"type": "set_config", "request_id": "s3",
                            "values": {"model_first_token_timeout_s": "forever"}})
        self.assertEqual(self.last("command_rejected")["command"], "set_config")

    def test_validation_and_live_safety(self):
        check = self.headless._validated_config_values
        for good in ("auto", 0, 60, 86_400):
            self.assertEqual(check({"model_first_token_timeout_s": good}, set()),
                             ({"model_first_token_timeout_s": good}, None))
        for bad in ("never", "", "300", -1, 86_401, 1.5, True, None):
            with self.subTest(bad=bad):
                values, problem = check({"model_first_token_timeout_s": bad}, set())
                self.assertIsNone(values)
                self.assertIn("model_first_token_timeout_s", problem)
        for good in (0, 300, 86_400):
            self.assertEqual(check({"model_idle_timeout_s": good}, set()), ({"model_idle_timeout_s": good}, None))
        for bad in (-1, 86_401, "300", 2.5):
            values, problem = check({"model_idle_timeout_s": bad}, set())
            self.assertIsNone(values)
        for key in ("model_first_token_timeout_s", "model_idle_timeout_s"):
            self.assertIn(key, self.headless._LIVE_SAFE_CONFIG_KEYS)


if __name__ == "__main__":
    unittest.main()
