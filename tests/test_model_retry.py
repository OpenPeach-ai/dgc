"""Model connection retries: what DGC retries is visible, named, closed, redacted and replayed.

Every failure shape is real: a closed port for a refused connection, a `.invalid` host for DNS, a
server that RSTs, bodies cut after one delta on all four transports. The shared local server and its
stream helpers come from tests/test_model_stall.py.
"""
from __future__ import annotations

import io
import json
import os
import pwd
import socket
import struct
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest import mock

_REAL_HOME = pwd.getpwuid(os.getuid()).pw_dir
if "dgc.config" in sys.modules:
    import dgc.config as _config
    if Path(_config.USER_HOME) == Path(_REAL_HOME) or Path(_REAL_HOME) in Path(_config.USER_HOME).parents:
        raise RuntimeError("tests/test_model_retry.py needs HOME redirected before dgc is imported")
else:
    _HOME = tempfile.TemporaryDirectory(prefix="dgc-retry-home-")
    for _var in ("HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME"):
        os.environ[_var] = _HOME.name

sys.path.insert(0, str(Path(__file__).resolve().parent))
import test_model_stall as stall                           # noqa: E402  (same module name discovery uses)

import requests                                             # noqa: E402

from dgc import sessions, workflows                         # noqa: E402
import dgc.llm as llm                                       # noqa: E402
from dgc import model_errors                                # noqa: E402
from dgc.agent import Agent, _MAX_CONTINUE                  # noqa: E402
from dgc.config import Config                               # noqa: E402
from dgc.editor_protocol import MODEL_FAILURE_KINDS, event_error  # noqa: E402
from dgc.headless import Backend, HeadlessUI                # noqa: E402
from dgc.llm import LLMClient, LLMError, ToolsUnsupportedError  # noqa: E402
from dgc.model_errors import (classify_exception, classify_status, eof_cause, hint_for,  # noqa: E402
                              scrub_urls, stall_cause)
from dgc.protocol import Emitter                            # noqa: E402
from dgc.workflows import STREAM_RECOVERY_TEXT              # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures"
MESSAGES = [{"role": "user", "content": "hi"}]
LENGTH_TEXT = ("Your previous response was cut off at the length limit. Continue exactly "
               "where you left off — do not repeat what you already wrote.")


def closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def status(code: int, body: str = "", headers: dict | None = None):
    def behaviour(handler, record):
        data = (body or json.dumps({"error": {"message": f"status {code}"}})).encode()
        handler.send_response(code)
        handler.send_header("Content-Type", "application/json")
        for key, value in (headers or {}).items():
            handler.send_header(key, value)
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        handler.wfile.write(data)
    return behaviour


# ---- per-transport answers and cuts ------------------------------------------------------------
def answer(transport: str, text: str = "done"):
    sse = stall._sse

    def behaviour(handler, record):
        if transport == "chat_completions":
            return stall.chat_answer(text)(handler, record)
        if transport == "ollama":
            stall._start_stream(handler, "application/x-ndjson")
            stall._chunk(handler, json.dumps({"message": {"role": "assistant", "content": text}, "done": False}) + "\n")
            stall._chunk(handler, json.dumps({"message": {"role": "assistant", "content": ""},
                                              "done": True, "done_reason": "stop"}) + "\n")
            return stall._end_stream(handler)
        stall._start_stream(handler)
        if transport == "responses":
            stall._chunk(handler, sse({"type": "response.output_text.delta", "item_id": "i", "output_index": 0,
                                       "content_index": 0, "delta": text}))
            stall._chunk(handler, sse({"type": "response.completed", "response": {
                "id": "r1", "status": "completed", "usage": {},
                "output": [{"type": "message", "id": "i", "role": "assistant",
                            "content": [{"type": "output_text", "text": text}]}]}}))
        else:
            stall._chunk(handler, sse({"type": "message_start", "message": {"id": "m", "usage": {}}}))
            stall._chunk(handler, sse({"type": "content_block_start", "index": 0,
                                       "content_block": {"type": "text", "text": ""}}))
            stall._chunk(handler, sse({"type": "content_block_delta", "index": 0,
                                       "delta": {"type": "text_delta", "text": text}}))
            stall._chunk(handler, sse({"type": "content_block_stop", "index": 0}))
            stall._chunk(handler, sse({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {}}))
            stall._chunk(handler, sse({"type": "message_stop"}))
        stall._end_stream(handler)
    return behaviour


def first_delta(transport: str, text: str = "part") -> bytes:
    sse = stall._sse
    if transport == "chat_completions":
        return stall._chat_delta({"content": text}).encode()
    if transport == "ollama":
        return (json.dumps({"message": {"role": "assistant", "content": text}, "done": False}) + "\n").encode()
    if transport == "responses":
        return sse({"type": "response.output_text.delta", "item_id": "i", "output_index": 0,
                    "content_index": 0, "delta": text}).encode()
    return (sse({"type": "message_start", "message": {"id": "m", "usage": {}}})
            + sse({"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}})
            + sse({"type": "content_block_delta", "index": 0,
                   "delta": {"type": "text_delta", "text": text}})).encode()


def cut(transport: str, how: str = "fin", text: str = "part"):
    """One delta, then the stream ends without its terminator: FIN, RST, a short Content-Length, or
    a chunked SSE body that simply ends."""
    ctype = "application/x-ndjson" if transport == "ollama" else "text/event-stream"

    def behaviour(handler, record):
        data = first_delta(transport, text)
        if how == "short":
            handler.send_response(200)
            handler.send_header("Content-Type", ctype)
            handler.send_header("Content-Length", str(len(data) + 500))
            handler.end_headers()
            handler.wfile.write(data)
            handler.wfile.flush()
            handler.close_connection = True
            return
        stall._start_stream(handler, ctype)
        stall._chunk(handler, data.decode())
        if how == "rst":
            time.sleep(0.05)
            handler.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            handler.close_connection = True
            handler.connection.close()
            return
        if how == "fin":
            handler.close_connection = True
            try:
                handler.connection.shutdown(socket.SHUT_WR)
            except OSError:
                pass
            return
        stall._end_stream(handler)          # "eof": a complete chunked body with no terminator
    return behaviour


PATHS = {"chat_completions": ("/v1", "/chat/completions", {}),
         "ollama": ("", "/api/chat", {"api_mode": "ollama"}),
         "responses": ("/v1", "/responses", {"api_mode": "responses"}),
         "anthropic": ("/v1", "/messages", {"api_mode": "anthropic"})}


class _Recorder:
    """A front end with the retry hook and an error that takes its cause."""

    def __init__(self):
        self.frames, self.infos, self.errors, self.text, self.waits, self.order = [], [], [], [], [], []
        self.lock = threading.Lock()

    def model_retry(self, state, **fields):
        with self.lock:
            self.frames.append((state, dict(fields)))
            self.order.append(("model_retry", state))

    def info(self, message):
        self.infos.append(message)
        self.order.append(("info", message))

    def error(self, message, cause=None):
        self.errors.append((message, cause))
        self.order.append(("error", message))

    def on_text(self, chunk):
        self.text.append(chunk)
        self.order.append(("text", chunk))

    def model_wait(self, label, detail="", *, since=None, restore=True, origin=None):
        self.waits.append((label, detail))

    def __getattr__(self, name):
        return lambda *a, **k: None

    def runs(self):
        grouped: dict = {}
        for state, fields in self.frames:
            grouped.setdefault(fields["run_n"], []).append((state, fields))
        return grouped


class _Plain:
    """A front end without the hook (the classic REPL / `dgc -p` text)."""

    def __init__(self):
        self.infos, self.errors, self.text = [], [], []

    def info(self, message):
        self.infos.append(message)

    def error(self, message):
        self.errors.append(message)

    def on_text(self, chunk):
        self.text.append(chunk)

    def __getattr__(self, name):
        return lambda *a, **k: None


class _FastRetries:
    """Patch the transport backoff to ~0 while recording the delays asked for."""

    def __init__(self):
        self.delays = []
        self._real = llm._wait_for_retry

    def __call__(self, delay, cancel=None):
        self.delays.append(delay)
        return self._real(min(float(delay), 0.01), cancel)


class RetryTestCase(unittest.TestCase):
    def setUp(self):
        self.server = stall._Server()
        self.addCleanup(self.server.close)
        self.fast = _FastRetries()
        self.fast_patch = mock.patch.object(llm, "_wait_for_retry", self.fast)
        self.fast_patch.start()
        self.addCleanup(self.real_backoff)

    def real_backoff(self):
        if self.fast_patch is not None:
            self.fast_patch.stop()
            self.fast_patch = None

    def refuse_first(self, n: int, only: str = ""):
        """The first ``n`` model requests (URLs containing ``only``) go to a closed port: a real
        ConnectionRefusedError chain. The cause still names the configured endpoint."""
        real = requests.post
        dead = closed_port()
        count = {"n": 0}

        def post(url, *args, **kwargs):
            if only and only not in url:
                return real(url, *args, **kwargs)
            count["n"] += 1
            if count["n"] <= n:
                return real(url.replace(f":{self.server.port}", f":{dead}"), *args, **kwargs)
            return real(url, *args, **kwargs)
        patcher = mock.patch.object(llm.requests, "post", post)
        patcher.start()
        self.addCleanup(patcher.stop)
        return dead

    def client(self, transport="chat_completions", **kwargs):
        path, _suffix, extra = PATHS[transport]
        kwargs.setdefault("read_timeout", 10)
        kwargs.setdefault("stall_notice", 0)
        client = LLMClient(self.server.url + path, "", kwargs.pop("model", "retry-model"), **{**extra, **kwargs})
        events = stall._Events()
        client.stall_listener = events
        return client, events

    def agent(self, ui=None, **settings):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-retry-agent-")
        self.addCleanup(tmp.cleanup)
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg.data.update({"model": "retry-model", "base_url": self.server.url + "/v1", "mode": "default",
                         "suggest": False, "model_stall_retries": 1})
        cfg.data.update(settings)
        ui = ui if ui is not None else _Recorder()
        agent = Agent(cfg, ui)
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(Path(tmp.name))
        return agent, ui


# ---- 1. classification -------------------------------------------------------------------------
class ClassifyTests(unittest.TestCase):
    def test_real_exceptions_map_to_the_table(self):
        dead = closed_port()
        endpoint = f"http://u:p@127.0.0.1:{dead}/v1/chat/completions?key=SECRETKEY123"
        with self.assertRaises(requests.ConnectionError) as refused:
            requests.post(endpoint, timeout=2)
        cause = classify_exception(refused.exception, endpoint=endpoint)
        self.assertEqual((cause.kind, cause.summary), ("connect", f"connection refused by 127.0.0.1:{dead}"))
        for text in (cause.detail, cause.summary, cause.endpoint):
            self.assertNotIn("u:p@", text)
            self.assertNotIn("SECRETKEY123", text)
            self.assertNotIn("?key=", text)
        self.assertIn("with url: /v1/chat/completions?…", cause.detail)

        with self.assertRaises(requests.ConnectionError) as dns:
            requests.post("http://dgc-retry-test.invalid/v1", timeout=5)
        cause = classify_exception(dns.exception, endpoint="http://dgc-retry-test.invalid/v1")
        self.assertEqual((cause.kind, cause.summary), ("dns", "could not resolve host dgc-retry-test.invalid"))

        cause = classify_exception(requests.exceptions.SSLError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: self-signed certificate"),
                                   endpoint="https://api.example.com/v1")
        self.assertEqual(cause.kind, "tls")
        self.assertEqual(cause.summary, "TLS handshake with api.example.com failed: certificate verify failed: self-signed certificate")

        from urllib3.exceptions import ProtocolError
        broken = requests.exceptions.ChunkedEncodingError(ProtocolError("Connection broken: IncompleteRead(0 bytes read, 5 more expected)"))
        cause = classify_exception(broken, endpoint="http://127.0.0.1:1/v1", streaming=True)
        self.assertEqual(cause.kind, "stream_cut")
        self.assertTrue(cause.summary.startswith("connection broken while streaming: "))

        self.assertEqual(classify_exception(requests.exceptions.ProxyError("proxy"), endpoint="http://h:1").kind, "proxy")
        self.assertEqual(classify_exception(requests.exceptions.ConnectTimeout("t"), endpoint="http://h:1").summary,
                         "no TCP connection to h:1 within 15s")
        self.assertEqual(classify_exception(OSError(113, "No route to host"), endpoint="http://h:1").summary,
                         "network unreachable — no route to h:1")
        self.assertEqual(classify_exception(ValueError("odd\nsecond line"), endpoint="http://h:1").summary,
                         "ValueError: odd")

    def test_an_rst_server_is_a_reset(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]

        def reset():
            conn, _ = listener.accept()
            conn.recv(65536)
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            conn.close()
        thread = threading.Thread(target=reset, daemon=True)
        thread.start()
        self.addCleanup(listener.close)
        with self.assertRaises(requests.ConnectionError) as caught:
            requests.post(f"http://127.0.0.1:{port}/v1/chat/completions", json={}, timeout=3)
        cause = classify_exception(caught.exception, endpoint=f"http://127.0.0.1:{port}/v1")
        self.assertEqual(cause.kind, "reset")
        self.assertEqual(cause.summary, f"connection reset by 127.0.0.1:{port} before a response")

    def test_status_rows(self):
        ep = "http://127.0.0.1:11434/v1/chat/completions?key=SECRET"
        busy = classify_status(429, "slow down", {}, endpoint=ep)
        self.assertEqual((busy.kind, busy.summary, busy.retryable), ("rate_limited", "HTTP 429 from 127.0.0.1:11434", True))
        waited = classify_status(429, "", {"Retry-After": "2"}, endpoint=ep, delay_s=2.0)
        self.assertEqual(waited.summary, "HTTP 429 from 127.0.0.1:11434 · waited 2s")
        self.assertEqual(classify_status(503, "server busy, try again later", endpoint=ep).kind, "overloaded")
        self.assertEqual(classify_status(503, "upstream failed", endpoint=ep).kind, "http")
        for code in (500, 502, 504, 408):
            self.assertEqual(classify_status(code, "x", endpoint=ep).kind, "http")
            self.assertTrue(classify_status(code, "x", endpoint=ep).retryable)
        for code in (401, 403):
            self.assertEqual((classify_status(code, "no", endpoint=ep).kind, classify_status(code, "no", endpoint=ep).retryable),
                             ("auth", False))
        missing = classify_status(404, "model 'q' not found", endpoint=ep)
        self.assertEqual((missing.kind, missing.retryable), ("model_not_found", False))
        leaky = classify_status(500, "see http://user:pw@internal/x?token=abc", endpoint=ep)
        self.assertNotIn("user:pw", leaky.detail)
        self.assertNotIn("token=abc", leaky.detail)
        self.assertEqual(leaky.endpoint, "http://127.0.0.1:11434/v1/chat/completions")

    def test_eof_names_each_transport_terminator_and_stalls_describe_themselves(self):
        ep = "http://127.0.0.1:1/v1"
        self.assertEqual(eof_cause("chat_completions", endpoint=ep).summary, "stream from 127.0.0.1:1 ended before [DONE]")
        self.assertIn("response.completed", eof_cause("responses", endpoint=ep).summary)
        self.assertIn("message_stop", eof_cause("anthropic", endpoint=ep).summary)
        self.assertIn('"done": true', eof_cause("ollama", endpoint=ep).summary)
        self.assertEqual(stall_cause({"phase": "loading", "model": "m", "endpoint": ep, "window_s": 60}).kind, "loading")
        self.assertEqual(stall_cause({"phase": "first_token", "model": "m", "endpoint": ep, "window_s": 300}).summary,
                         "no tokens from m at 127.0.0.1:1 for 300s")

    def test_scrub_urls(self):
        self.assertEqual(scrub_urls("GET https://u:p@api.example.com/v1/x?key=S#frag done"),
                         "GET https://api.example.com/v1/x?… done")
        self.assertEqual(scrub_urls("Max retries exceeded with url: /v1/chat/completions?api-key=S (Caused by X)"),
                         "Max retries exceeded with url: /v1/chat/completions?… (Caused by X)")
        self.assertEqual(scrub_urls("url: http://127.0.0.1:4899/503always/v1/responses)"),
                         "url: http://127.0.0.1:4899/503always/v1/responses)")
        self.assertEqual(scrub_urls("plain words"), "plain words")

    def test_hints_split_dns_tls_proxy_local_and_remote(self):
        local = hint_for("connect", base_url="http://127.0.0.1:11434/v1")
        remote = hint_for("connect", base_url="https://api.example.com/v1")
        self.assertIn("start your server", local)
        self.assertNotIn("ollama serve", remote)
        self.assertIn("does not resolve", hint_for("dns", base_url="https://api.exmaple.com/v1"))
        self.assertIn("REQUESTS_CA_BUNDLE", hint_for("tls", base_url="https://h/v1"))
        self.assertIn("HTTPS_PROXY", hint_for("proxy", base_url="https://h/v1"))
        self.assertEqual(llm.explain_llm_error("x (Caused by NameResolutionError)", base_url="https://h.example/v1")
                         .split("\n  → ")[1], hint_for("dns", base_url="https://h.example/v1"))
        self.assertNotIn("SECRET", llm.explain_llm_error("Connection refused", base_url="http://u:SECRET@127.0.0.1:1/v1?key=SECRET"))

    def test_protocol_module_imports_no_transport_library(self):
        import dgc.editor_protocol as proto
        source = Path(proto.__file__).read_text()
        for name in ("requests", "urllib3", "model_errors"):
            self.assertNotRegex(source, rf"^\s*(?:import|from)\s+[.\w]*{name}", name)
        self.assertIs(model_errors.MODEL_FAILURE_KINDS, MODEL_FAILURE_KINDS)


# ---- 2-3. transports ---------------------------------------------------------------------------
class TransportRetryTests(RetryTestCase):
    def assertRecovered(self, transport, events, kind):
        retries = [e for e in events.items if e.kind == "retry"]
        self.assertEqual([e.kind for e in events.items], ["retry", "cleared"], transport)
        self.assertEqual((retries[0].cause, retries[0].attempt, retries[0].retries), (kind, 1, 3))
        self.assertTrue(retries[0].summary)
        self.assertEqual(retries[0].api_mode, PATHS[transport][2].get("api_mode", "chat_completions"))

    def test_refused_then_ok_on_every_transport(self):
        for transport in PATHS:
            with self.subTest(transport=transport):
                self.server.behaviours = {PATHS[transport][1]: answer(transport)}
                self.refuse_first(1, only=PATHS[transport][1])
                client, events = self.client(transport)
                result = client.chat(MESSAGES)
                self.assertEqual(result.content, "done")
                self.assertRecovered(transport, events, "connect")
                self.assertEqual(events.items[0].summary, f"connection refused by 127.0.0.1:{self.server.port}")

    def test_503_and_429_then_ok_on_every_transport(self):
        for transport in PATHS:
            for code, kind in ((503, "http"), (429, "rate_limited")):
                with self.subTest(transport=transport, code=code):
                    self.server.behaviours = {PATHS[transport][1]: stall.sequence(status(code), answer(transport))}
                    client, events = self.client(transport)
                    self.assertEqual(client.chat(MESSAGES).content, "done")
                    self.assertRecovered(transport, events, kind)
                    self.assertEqual([e for e in events.items if e.kind == "retry"][0].http_status, code)

    def test_503_forever_raises_with_the_cause_and_todays_message(self):
        expected = {
            "chat_completions": lambda s: f"HTTP 503 from http://127.0.0.1:{s.port}/v1/chat/completions after 4 tries: ",
            "ollama": lambda s: f"HTTP 503 from http://127.0.0.1:{s.port}/api/chat after 4 tries: ",
            "responses": lambda s: "HTTP 503 from Responses API after 4 tries: ",
            "anthropic": lambda s: "HTTP 503 from Anthropic Messages after 4 tries: ",
        }
        for transport in PATHS:
            with self.subTest(transport=transport):
                self.server.behaviours = {PATHS[transport][1]: status(503, "upstream down")}
                client, events = self.client(transport)
                with self.assertRaises(LLMError) as caught:
                    client.chat(MESSAGES)
                error = caught.exception
                self.assertEqual((error.cause.kind, error.attempts), ("http", 4))
                self.assertTrue(str(error).startswith(expected[transport](self.server)), str(error))
                self.assertIn("upstream down", str(error))
                retries = [e for e in events.items if e.kind == "retry"]
                self.assertEqual([e.attempt for e in retries], [1, 2, 3])
                self.assertNotIn("cleared", events.kinds())

    def test_refused_forever_keeps_the_cannot_connect_wording(self):
        dead = closed_port()
        client = LLMClient(f"http://127.0.0.1:{dead}/v1", "", "m", read_timeout=5)
        with self.assertRaises(LLMError) as caught:
            client.chat(MESSAGES)
        self.assertTrue(str(caught.exception).startswith(
            f"cannot connect to http://127.0.0.1:{dead}/v1 — is your local LLM server running? (/connect <url> to change it)\n"))
        self.assertEqual((caught.exception.cause.kind, caught.exception.attempts), ("connect", 4))
        self.assertEqual(self.fast.delays, [0.5, 1.0, 1.5], "the backoff delays are unchanged")

    def test_stream_cuts_after_one_delta_name_the_terminator(self):
        terminators = {"chat_completions": "[DONE]", "ollama": '"done": true',
                       "responses": "response.completed", "anthropic": "message_stop"}
        for transport in PATHS:
            for how in ("fin", "rst", "short", "eof"):
                if how == "eof" and transport == "ollama":
                    continue
                with self.subTest(transport=transport, how=how):
                    self.server.behaviours = {PATHS[transport][1]: cut(transport, how)}
                    client, _ = self.client(transport)
                    result = client.chat(MESSAGES)
                    self.assertEqual(result.finish_reason, "incomplete")
                    self.assertIsNone(result.stall)
                    self.assertIn(result.interruption["kind"], ("stream_cut", "reset"))
                    if result.interruption["kind"] == "stream_cut" and "broken" not in result.interruption["summary"]:
                        self.assertIn(terminators[transport], result.interruption["summary"])

    def test_stop_during_a_transport_backoff_is_immediate_and_never_cleared(self):
        self.real_backoff()
        self.server.behaviours = {"/chat/completions": status(503)}
        client, events = self.client()
        cancel = threading.Event()
        timer = threading.Timer(0.15, cancel.set)
        timer.start()
        started = time.monotonic()
        result = client.chat(MESSAGES, cancel=cancel)
        self.assertEqual(result.finish_reason, "cancelled")
        self.assertLess(time.monotonic() - started, 0.15 + 0.3)
        self.assertNotIn("cleared", events.kinds())


# ---- 4-6. the agent ----------------------------------------------------------------------------
class AgentRetryRunTests(RetryTestCase):
    def test_refused_twice_then_ok_is_one_run_closed_recovered(self):
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        self.refuse_first(2)
        agent, ui = self.agent()
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        states = [(s, f["attempt"], f["max_attempts"]) for s, f in ui.frames]
        self.assertEqual(states, [("retrying", 1, 3), ("retrying", 2, 3), ("recovered", 2, 3)])
        self.assertEqual(len(ui.runs()), 1)
        self.assertFalse([line for line in ui.infos if "↻" in line])
        self.assertEqual(ui.frames[0][1]["kind"], "connect")
        self.assertEqual(ui.waits[0][0], "Waiting to reconnect")
        self.assertRegex(ui.waits[0][1], r"^connection refused · 127\.0\.0\.1:\d+ · backoff 0\.5s · retry 1/3$")
        for _state, fields in ui.frames:
            self.assertNotIn("seq", fields)
            self.assertNotIn("type", fields)

    def test_refused_forever_gives_up_and_the_error_links_the_run(self):
        agent, ui = self.agent(base_url=f"http://127.0.0.1:{closed_port()}/v1")
        self.assertFalse(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual([(s, f["attempt"]) for s, f in ui.frames],
                         [("retrying", 1), ("retrying", 2), ("retrying", 3), ("gave_up", 3)])
        message, cause = ui.errors[-1]
        self.assertTrue(message.startswith("cannot connect to"))
        self.assertEqual(cause["kind"], "connect")
        self.assertEqual(cause["run_n"], ui.frames[0][1]["run_n"])
        self.assertEqual(cause["attempts"], 4)
        self.assertIn("start your server", cause["hint"])

    def test_cut_twice_then_ok_makes_two_continuation_runs(self):
        self.server.behaviours["/chat/completions"] = stall.sequence(
            cut("chat_completions", text="one "), cut("chat_completions", text="two "), stall.chat_answer("three"))
        agent, ui = self.agent()
        delays = []
        agent._stream_recovery_delay = lambda n: (delays.append(n), 0.0)[1]
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        runs = ui.runs()
        self.assertEqual(len(runs), 2)
        for index, frames in enumerate(runs.values(), start=1):
            self.assertEqual([(s, f["attempt"], f["max_attempts"], f["layer"]) for s, f in frames],
                             [("retrying", index, _MAX_CONTINUE, "continuation"),
                              ("recovered", index, _MAX_CONTINUE, "continuation")])
        self.assertEqual(delays, [1, 2])
        notices = [m for m in agent.messages if workflows.stream_recovery_notice(m)]
        self.assertEqual([m["_dgc_notice"]["kind"] for m in notices], ["stream_recovery"] * 2)
        self.assertEqual("".join(ui.text), "one two three")

    def test_a_length_continuation_then_a_cut_says_attempt_one(self):
        class Client:
            tools_supported = True

            def __init__(self):
                self.calls = 0

            def chat(self, *a, **k):
                self.calls += 1
                if self.calls == 1:
                    return llm.ChatResult(content="long ", finish_reason="length")
                if self.calls == 2:
                    return llm.ChatResult(content="cut ", finish_reason="incomplete")
                return llm.ChatResult(content="end")
        agent, ui = self.agent()
        agent.client = Client()
        agent._stream_recovery_delay = lambda n: 0.0
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual([(s, f["attempt"]) for s, f in ui.frames], [("retrying", 1), ("recovered", 1)])

    def test_a_cut_then_a_refused_continuation_keeps_two_runs_with_their_own_counters(self):
        self.server.behaviours["/chat/completions"] = stall.sequence(
            cut("chat_completions", text="one "), stall.chat_answer("two"))
        real = requests.post
        dead = closed_port()
        count = {"n": 0}

        def post(url, *args, **kwargs):
            count["n"] += 1
            if count["n"] in (2, 3):
                return real(url.replace(f":{self.server.port}", f":{dead}"), *args, **kwargs)
            return real(url, *args, **kwargs)
        with mock.patch.object(llm.requests, "post", post):
            agent, ui = self.agent()
            agent._stream_recovery_delay = lambda n: 0.0
            self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        runs = list(ui.runs().values())
        self.assertEqual(len(runs), 2)
        continuation, request = runs
        self.assertEqual([(s, f["attempt"], f["max_attempts"]) for s, f in continuation],
                         [("retrying", 1, _MAX_CONTINUE), ("recovered", 1, _MAX_CONTINUE)])
        self.assertEqual([(s, f["attempt"], f["max_attempts"]) for s, f in request],
                         [("retrying", 1, 3), ("retrying", 2, 3), ("recovered", 2, 3)])
        order = [(s, f["run_n"]) for s, f in ui.frames]
        self.assertEqual(order[-2:], [("recovered", continuation[0][1]["run_n"]), ("recovered", request[0][1]["run_n"])]
                         if order[-2][1] == continuation[0][1]["run_n"] else
                         [("recovered", request[0][1]["run_n"]), ("recovered", continuation[0][1]["run_n"])])
        text_at = ui.order.index(("text", "two"))
        self.assertTrue(all(ui.order.index(("model_retry", "recovered")) < text_at for _ in (0,)))

    def test_cut_forever_spends_the_budget_then_gives_up_naming_the_host(self):
        self.server.behaviours["/chat/completions"] = cut("chat_completions", text="x")
        agent, ui = self.agent()
        agent._stream_recovery_delay = lambda n: 0.0
        self.assertFalse(agent.run_turn("hi", reset_cancel=False))
        runs = list(ui.runs().values())
        self.assertEqual(len(runs), _MAX_CONTINUE + 1)
        for frames in runs[:-1]:
            self.assertEqual([s for s, _ in frames], ["retrying", "recovered"])
        last = runs[-1]
        self.assertEqual([(s, f["attempt"], f["max_attempts"]) for s, f in last],
                         [("retrying", _MAX_CONTINUE, _MAX_CONTINUE), ("gave_up", _MAX_CONTINUE, _MAX_CONTINUE)])
        message, cause = ui.errors[-1]
        self.assertIn(f"from 127.0.0.1:{self.server.port}", message)
        self.assertIn("terminal event", message)
        self.assertEqual(cause["run_n"], last[0][1]["run_n"])
        self.assertEqual(cause["kind"], "stream_cut")

    def test_a_stall_retry_draws_a_run_and_a_plain_ui_keeps_its_line(self):
        self.server.behaviours["/chat/completions"] = stall.sequence(stall.no_headers, stall.chat_answer("ok"))
        settings = {"model_first_token_timeout_s": 0.4, "model_stall_notice_s": 0}
        agent, ui = self.agent(**settings)
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual([(s, f["kind"], f["attempt"], f["max_attempts"]) for s, f in ui.frames],
                         [("retrying", "headers" and "stall", 1, 1), ("recovered", "stall", 1, 1)])
        self.assertFalse([line for line in ui.infos if "retrying (1/1)" in line])
        plain_agent, plain = self.agent(_Plain(), **settings)
        self.server.behaviours["/chat/completions"] = stall.sequence(stall.no_headers, stall.chat_answer("ok"))
        self.assertTrue(plain_agent.run_turn("hi", reset_cancel=False))
        self.assertTrue(any("retrying (1/1)" in line for line in plain.infos), plain.infos)

    def test_stop_during_an_in_request_backoff_cancels_the_run(self):
        self.real_backoff()
        self.server.behaviours["/chat/completions"] = status(503)
        agent, ui = self.agent()
        timer = threading.Timer(0.2, agent.cancelled.set)
        timer.start()
        self.assertFalse(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual([s for s, _ in ui.frames], ["retrying", "cancelled"])

    def test_stop_during_a_continuation_backoff_appends_nothing(self):
        self.server.behaviours["/chat/completions"] = cut("chat_completions", text="x")
        agent, ui = self.agent()
        agent._stream_recovery_delay = lambda n: (agent.cancelled.set(), 5.0)[1]
        started = time.monotonic()
        self.assertFalse(agent.run_turn("hi", reset_cancel=False))
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual([s for s, _ in ui.frames], ["retrying", "cancelled"])
        self.assertFalse([m for m in agent.messages if workflows.stream_recovery_notice(m)])

    def test_fallback_closes_the_primary_run_and_a_failing_fallback_gets_a_new_one(self):
        agent, ui = self.agent(base_url=f"http://127.0.0.1:{closed_port()}/v1", fallback_model="backup")
        self.assertFalse(agent.run_turn("hi", reset_cancel=False))
        runs = list(ui.runs().values())
        self.assertEqual(len(runs), 2)
        self.assertEqual(runs[0][-1][0], "gave_up")
        fallback_line = ui.order.index(next(item for item in ui.order if item[0] == "info" and "⤳" in item[1]))
        first_gave_up = ui.order.index(("model_retry", "gave_up"))
        self.assertLess(first_gave_up, fallback_line)
        self.assertEqual(runs[1][-1][0], "gave_up")
        self.assertEqual(ui.errors[-1][1]["run_n"], runs[1][0][1]["run_n"])

    def test_a_404_after_a_refusal_closes_recovered_and_names_the_model(self):
        self.server.behaviours["/chat/completions"] = status(404, json.dumps({"error": "model 'retry-model' not found"}))
        self.refuse_first(1)
        agent, ui = self.agent()
        self.assertFalse(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual([s for s, _ in ui.frames], ["retrying", "recovered"])
        message, cause = ui.errors[-1]
        self.assertEqual(cause["kind"], "model_not_found")
        self.assertNotIn("run_n", cause, "a recovered run is not the error's line")

    def test_tools_unsupported_after_a_refusal_closes_recovered_first(self):
        class Client:
            tools_supported = True
            model = "m"
            base_url = "http://127.0.0.1:1/v1"

            def __init__(self, agent):
                self.agent, self.calls = agent, 0

            def chat(self, *a, **k):
                self.calls += 1
                if self.calls == 1:
                    self.agent._on_model_wait(stall_wait_event())
                    raise ToolsUnsupportedError("endpoint rejected native tool calling")
                return llm.ChatResult(content="text protocol answer")
        agent, ui = self.agent()
        agent.client = Client(agent)
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual([s for s, _ in ui.frames], ["retrying", "recovered"])
        recovered = ui.order.index(("model_retry", "recovered"))
        reissue = next(i for i, item in enumerate(ui.order) if item[0] == "info" and "text tool protocol" in item[1])
        self.assertLess(recovered, reissue)

    def test_anthropic_auto_fallback_numbers_attempts_by_run(self):
        self.server.behaviours = {"/messages": status(404), "/chat/completions": stall.chat_answer("ok")}
        real = requests.post
        dead = closed_port()
        count = {"n": 0}

        def post(url, *args, **kwargs):
            count["n"] += 1
            if count["n"] in (1, 2, 4):
                return real(url.replace(f":{self.server.port}", f":{dead}"), *args, **kwargs)
            return real(url, *args, **kwargs)
        with mock.patch.object(llm.requests, "post", post):
            agent, ui = self.agent(api_mode="auto")
            agent.client = LLMClient(self.server.url + "/v1", "", "retry-model", api_mode="auto", read_timeout=5)
            agent.client.api_mode = "anthropic"
            self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        self.assertEqual([(s, f["attempt"]) for s, f in ui.frames],
                         [("retrying", 1), ("retrying", 2), ("retrying", 3), ("recovered", 3)])
        self.assertEqual(len(ui.runs()), 1, "attempt numbering belongs to the run, not the transport")

    def test_every_turn_exit_closes_open_runs(self):
        agent, ui = self.agent()

        def boom(*a, **k):
            agent._retry_step("request", kind="connect", summary="connection refused by h:1", max=3)
            raise RuntimeError("boom")
        agent._run_turn = boom
        with self.assertRaises(RuntimeError):
            agent.run_turn("hi", reset_cancel=False)
        self.assertEqual([s for s, _ in ui.frames], ["retrying", "gave_up"])

        agent2, ui2 = self.agent()

        def done(*a, **k):
            agent2._retry_step("request", kind="connect", summary="x", max=3)
            return True
        agent2._run_turn = done
        agent2.run_turn("hi", reset_cancel=False)
        self.assertEqual([s for s, _ in ui2.frames], ["retrying", "recovered"])

        agent3, ui3 = self.agent()

        def runner(prompt):
            agent3._engine_retry({"kind": "retry", "failure": "connect", "attempt": 1, "max": 2,
                                  "summary": "waiting"}, types.SimpleNamespace(short_label="Codex"))
            return {"ok": False, "cancelled": False, "text": "", "error": "boom"}
        agent3.run_external_turn("hi", runner, reset_cancel=False)
        self.assertEqual([s for s, _ in ui3.frames], ["retrying", "gave_up"])
        self.assertEqual(ui3.frames[0][1]["origin"], "engine")
        self.assertEqual(ui3.frames[0][1]["endpoint"], "")

    def test_headless_frames_keep_the_envelope_seq_increasing(self):
        buffer = io.StringIO()
        emitter = Emitter(buffer)
        ui = HeadlessUI(emitter, None)
        ui.turn_id = "t1"
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        self.refuse_first(3)
        agent, _ = self.agent(ui)
        agent.run_turn("hi", reset_cancel=False)
        events = [json.loads(line) for line in buffer.getvalue().splitlines()]
        seqs = [event["seq"] for event in events]
        self.assertEqual(seqs, sorted(set(seqs)))
        frames = [event for event in events if event["type"] == "model_retry"]
        self.assertEqual([f["state"] for f in frames], ["retrying"] * 3 + ["recovered"])
        self.assertEqual({f["retry_id"] for f in frames}, {"t1:retry1"})
        for event in events:
            self.assertIsNone(event_error(event), event)
        # A payload `seq` has no way in: the hook declares no such keyword, and the agent never sends one.
        with self.assertRaises(TypeError):
            ui.model_retry("retrying", run_n=1, kind="connect", layer="request", attempt=1, summary="x", seq=999)
        ui.model_retry("retrying", run_n=5, kind="connect", layer="request", attempt=1, summary="x")
        last = json.loads(buffer.getvalue().splitlines()[-1])
        self.assertEqual(last["seq"], seqs[-1] + 1)


def stall_wait_event():
    from dgc.model_watch import WaitEvent
    return WaitEvent(kind="retry", since=time.monotonic(), model="m", endpoint="http://127.0.0.1:1/v1",
                     attempt=1, retries=3, cause="connect", summary="connection refused by 127.0.0.1:1",
                     delay_s=0.5, api_mode="chat_completions")


class FallbackAndSubagentTests(RetryTestCase):
    def test_a_ui_without_the_hook_gets_plain_lines(self):
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        self.refuse_first(1)
        agent, ui = self.agent(_Plain())
        self.assertTrue(agent.run_turn("hi", reset_cancel=False))
        port = self.server.port
        self.assertIn(f"↻ connection refused by 127.0.0.1:{port} — reconnecting (1/3) in 0.5s", ui.infos)
        self.assertIn(f"↻ reconnected to 127.0.0.1:{port} after 1 retry", ui.infos)

    def test_parallel_children_refused_together_get_distinct_ids_before_they_finish(self):
        from dgc.agent import _SubUI
        parent = _Recorder()
        seen_before_finish = threading.Event()
        children = [_SubUI(parent, f"child {i}", buffered=True) for i in range(2)]

        def run(child):
            agent, _ = self.agent(child)
            agent._on_model_wait(stall_wait_event())
            if len(parent.frames) >= 1:
                seen_before_finish.set()
        threads = [threading.Thread(target=run, args=(child,)) for child in children]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertTrue(seen_before_finish.is_set())
        self.assertEqual(len(parent.frames), 2)
        agents = {fields["agent"] for _, fields in parent.frames}
        self.assertEqual(agents, {child._call_prefix for child in children})
        self.assertEqual({fields["origin"] for _, fields in parent.frames}, {"subagent"})
        self.assertEqual([child._events for child in children], [[], []], "retry lines bypass the buffer")
        buffer = io.StringIO()
        ui = HeadlessUI(Emitter(buffer), None)
        ui.turn_id = "t1"
        for state, fields in parent.frames:
            ui.model_retry(state, **fields)
        ids = [json.loads(line)["retry_id"] for line in buffer.getvalue().splitlines()]
        self.assertEqual(len(set(ids)), 2)
        self.assertTrue(all(":sub-" in rid for rid in ids))


class WireTests(RetryTestCase):
    def test_no_notice_key_reaches_any_transport_after_a_cut(self):
        for transport in PATHS:
            with self.subTest(transport=transport):
                path, suffix, extra = PATHS[transport]
                self.server.posts.clear()
                self.server.behaviours = {suffix: stall.sequence(cut(transport, "fin", "a"), answer(transport, "b"))}
                agent, _ = self.agent(base_url=self.server.url + path, **extra)
                agent._stream_recovery_delay = lambda n: 0.0
                self.assertTrue(agent.run_turn("hi", reset_cancel=False))
                bodies = [json.dumps(post["body"]) for post in self.server.chat_posts(suffix)]
                self.assertGreaterEqual(len(bodies), 2)
                self.assertIn("Continue exactly where you left off", bodies[-1])
                self.assertFalse(any("_dgc_notice" in body or "stream_recovery" in body for body in bodies))

    def test_credentials_and_query_never_leave_redacted(self):
        base = "http://u:p@127.0.0.1:{port}/v1?key=SECRETKEY123"

        def scan(ui, where):
            blob = json.dumps([ui.frames, ui.errors, ui.infos, ui.waits], default=str)
            for secret in ("SECRETKEY123", "u:p@", "?key="):
                self.assertNotIn(secret, blob, where)
        agent, ui = self.agent(base_url=base.format(port=closed_port()), api_key="")
        agent.run_turn("hi", reset_cancel=False)
        scan(ui, "refused")
        self.assertTrue(ui.frames and ui.errors[-1][1])
        self.server.behaviours["/chat/completions"] = status(503, "down")
        agent, ui = self.agent(base_url=base.format(port=self.server.port), api_key="")
        agent.run_turn("hi", reset_cancel=False)
        scan(ui, "503 forever")
        self.server.behaviours["/chat/completions"] = cut("chat_completions")
        agent, ui = self.agent(base_url=base.format(port=self.server.port), api_key="")
        agent._stream_recovery_delay = lambda n: 0.0
        agent.run_turn("hi", reset_cancel=False)
        scan(ui, "stream cut")
        hint = llm.explain_llm_error("Connection refused", base_url=base.format(port=1))
        self.assertNotIn("SECRETKEY123", hint)
        self.assertNotIn("u:p@", hint)

    def test_acp_puts_no_retry_text_in_the_answer(self):
        from dgc.acp import _ACPUi
        server = mock.MagicMock()
        ui = _ACPUi(server, "sess-1", Path(tempfile.gettempdir()))
        self.server.behaviours["/chat/completions"] = stall.chat_answer("hello")
        self.refuse_first(1)
        agent, _ = self.agent(ui)
        agent.run_turn("hi", reset_cancel=False)
        chunks = [call.args[1]["update"] for call in server.notify.call_args_list
                  if call.args and call.args[0] == "session/update"]
        text = "".join(update.get("content", {}).get("text", "") for update in chunks
                       if update.get("sessionUpdate") == "agent_message_chunk")
        self.assertIn("hello", text)
        self.assertNotIn("↻", text)


# ---- 7-8. history and every notice consumer ----------------------------------------------------
def tagged(attempt=1, cause="stream_cut"):
    return {"role": "user", "content": STREAM_RECOVERY_TEXT,
            "_dgc_notice": {"kind": "stream_recovery", "layer": "continuation", "attempt": attempt,
                            "max": 8, "cause": cause, "summary": "stream from h:1 ended before [DONE]",
                            "endpoint": "h:1"}}


def legacy():
    return {"role": "user", "content": STREAM_RECOVERY_TEXT}


def history_of(messages):
    backend = object.__new__(Backend)
    backend.agent = types.SimpleNamespace(messages=messages)
    return backend._history()


class HistoryTests(unittest.TestCase):
    def check(self, items):
        for item in items:
            if item.get("type"):
                self.assertIsNone(event_error({**item, "seq": 0}), item)

    def test_a_notice_followed_by_an_answer_is_a_recovered_item_inside_one_turn(self):
        for notice in (tagged(), legacy()):
            items = history_of([{"role": "user", "content": "Write it"},
                                {"role": "assistant", "content": "The first half"}, notice,
                                {"role": "assistant", "content": " and the rest"}])
            self.check(items)
            self.assertEqual([i["type"] for i in items if i.get("type") == "turn_start"], ["turn_start"])
            retry = [i for i in items if i.get("type") == "model_retry"]
            self.assertEqual(len(retry), 1)
            self.assertEqual((retry[0]["state"], retry[0]["retry_id"], retry[0]["turn_id"], retry[0]["kind"]),
                             ("recovered", "h1:retry1", "h1", "stream_cut"))
            if "_dgc_notice" not in notice:
                self.assertEqual(retry[0]["summary"], "the stream ended before its terminal event")
                self.assertNotIn("endpoint", retry[0])

    def test_last_in_its_turn_is_retrying_and_two_notices_are_two_items(self):
        items = history_of([{"role": "user", "content": "Go"}, {"role": "assistant", "content": "a"},
                            tagged(1), {"role": "assistant", "content": ""}, tagged(2),
                            {"role": "user", "content": "Next prompt"}, {"role": "assistant", "content": "ok"}])
        self.check(items)
        retry = [i for i in items if i.get("type") == "model_retry"]
        self.assertEqual([(i["retry_id"], i["state"], i["attempt"]) for i in retry],
                         [("h1:retry1", "retrying", 1), ("h1:retry2", "retrying", 2)])
        self.assertEqual(len([i for i in items if i.get("type") == "turn_start"]), 2)

    def test_the_sentence_with_other_words_and_the_length_variant_stay_prompts(self):
        items = history_of([{"role": "user", "content": STREAM_RECOVERY_TEXT + " please"},
                            {"role": "assistant", "content": "x"},
                            {"role": "user", "content": LENGTH_TEXT}])
        prompts = [i["prompt"] for i in items if i.get("type") == "turn_start"]
        self.assertEqual(prompts, [STREAM_RECOVERY_TEXT + " please", LENGTH_TEXT])
        self.assertFalse([i for i in items if i.get("type") == "model_retry"])

    def test_every_notice_consumer_skips_or_relabels_both_forms(self):
        from dgc.tui import TUI
        for notice in (tagged(), legacy()):
            messages = [{"role": "system", "content": "sys"}, {"role": "user", "content": "Build it"},
                        {"role": "assistant", "content": "part"}, notice, {"role": "assistant", "content": "rest"}]
            with self.subTest(form="tagged" if "_dgc_notice" in notice else "legacy"):
                self.assertEqual(workflows.notice_kind(notice), "stream_recovery")
                rows = sessions.display_rows(messages)
                self.assertFalse([r for r in rows if "interrupted" in json.dumps(r)], rows)
                agent = object.__new__(Agent)
                agent.config = Config()
                recall = agent._recall_rows(messages)
                self.assertEqual([r["who"] for r in recall], ["user", "assistant", "assistant"])
                from dgc import training_export
                self.assertEqual(training_export._clean_messages(messages)[1], 1, "not a user turn")
                from dgc.acp import _ACPUi
                acp_server = mock.MagicMock()
                _ACPUi(acp_server, "s", Path(tempfile.gettempdir())).replay(messages)
                replayed = json.dumps([call.args for call in acp_server.notify.call_args_list])
                self.assertIn("Build it", replayed)
                self.assertNotIn("interrupted before its terminal", replayed)

                tui = object.__new__(TUI)
                segments = tui._message_rows(messages)
                who = [row["who"] for rows_, _ in segments for row in rows_]
                self.assertEqual(who, ["user", "assistant", "retry", "assistant"])
                self.assertNotIn("monitor", who)
                tui._width = 100
                blocks, _ = TUI._history_blocks(tui, segments[0][0])
                retry_blocks = [b for b in blocks if isinstance(b, dict) and b.get("kind") == "retry"]
                self.assertEqual(len(retry_blocks), 1)
                self.assertEqual(retry_blocks[0]["state"], "recovered")
                self.assertEqual(len([b for b in blocks if isinstance(b, dict) and b.get("kind") == "user"]), 1)

    def test_handoff_and_compaction_label_it_a_dgc_note_and_prune_never_fences_it(self):
        from dgc.monitors import NOTICE_OPEN
        for notice in (tagged(), legacy()):
            with self.subTest(form="tagged" if "_dgc_notice" in notice else "legacy"):
                long_notice = dict(notice)
                if "_dgc_notice" in notice:     # a future, longer notice must still never be fenced
                    long_notice["content"] = STREAM_RECOVERY_TEXT + " " + "x" * 4000
                tmp = tempfile.TemporaryDirectory(prefix="dgc-retry-notes-")
                self.addCleanup(tmp.cleanup)
                cfg = Config()
                cfg.project_root = Path(tmp.name)
                agent = Agent(cfg, _Plain())
                self.addCleanup(agent.mcp.stop_all)
                transcript = [{"role": "system", "content": "s"}, {"role": "user", "content": "go"},
                              {"role": "assistant", "content": "part"}, long_notice,
                              {"role": "assistant", "content": "rest"}, {"role": "user", "content": "more"},
                              {"role": "assistant", "content": "done"}]
                agent.messages = [dict(m) for m in transcript]
                agent._mechanical_prune(aggressive=True)
                self.assertFalse(str(agent.messages[3]["content"]).startswith(NOTICE_OPEN))
                self.assertNotIn("monitor output pruned", str(agent.messages[3]["content"]))

                captured = {}

                class Aux:
                    def chat(self, messages, *a, **k):
                        captured["handoff"] = messages[-1]["content"]
                        return llm.ChatResult(content="# Handoff\n## Objective\n- x")
                agent.messages = [dict(m) for m in transcript]
                agent._aux_client = lambda **k: Aux()
                agent.generate_handoff()
                self.assertIn("dgc-note: (the stream was cut; DGC asked the model to continue)", captured["handoff"])
                self.assertNotIn("Continue exactly where you left off", captured["handoff"])

                agent.messages = [dict(m) for m in transcript] + [
                    {"role": "user", "content": "q" * 50}, {"role": "assistant", "content": "a" * 50}] * 6
                agent._compact(force=True, deadline=time.monotonic(), tools=None)
                brief = next(m["content"] for m in agent.messages if m.get("role") == "user"
                             and str(m.get("content", "")).startswith(__import__("dgc.agent", fromlist=["x"])._COMPACT_PREFIX))
                self.assertIn("dgc-note: (the stream was cut; DGC asked the model to continue)", brief)
                self.assertNotIn("user: " + STREAM_RECOVERY_TEXT, brief)
                self.assertNotIn("monitor-output (untrusted): " + STREAM_RECOVERY_TEXT, brief)


# ---- 9. subscription engines -------------------------------------------------------------------
class EngineRetryTests(unittest.TestCase):
    def events(self, name):
        from dgc.subscriptions import parse_stream_events
        out = []
        for line in (FIXTURES / f"codex-reconnect-{name}.jsonl").read_text().splitlines():
            out.extend(parse_stream_events("codex", line))
        return out

    def test_codex_reconnect_lines_are_retries_and_turn_failed_still_errors(self):
        cut_once = self.events("cutonce")
        self.assertEqual([e["kind"] for e in cut_once], ["session", "retry", "text", "usage"])
        self.assertEqual((cut_once[1]["attempt"], cut_once[1]["max"], cut_once[1]["failure"]), (1, 2, "stream_cut"))
        refused = [e for e in self.events("refused") if e["kind"] == "retry"]
        self.assertEqual(len(refused), 4)
        self.assertEqual((refused[0]["attempt"], refused[0]["failure"]), (None, "connect"))
        always = self.events("503always")
        self.assertEqual([e["kind"] for e in always], ["session", "retry", "retry", "error", "error"])
        from dgc.subscriptions import parse_stream_events
        multi = parse_stream_events("codex", json.dumps({"type": "error", "message":
                                    "Reconnecting... 1/5 (unexpected status 502 Bad Gateway: <html>\nline two\n</html>)"}))
        self.assertEqual(multi[0]["kind"], "retry")
        self.assertIn("line two", multi[0]["detail"])

    def test_claude_api_retry_categories(self):
        from dgc.subscriptions import parse_stream_events

        def parse(**fields):
            return parse_stream_events("claude", json.dumps({"type": "system", "subtype": "api_retry", **fields}))[0]
        self.assertEqual(parse(attempt=2, max_retries=10, retry_delay_ms=4000, error_status=529, error="overloaded")["failure"], "overloaded")
        self.assertEqual(parse(error="rate_limit", error_status=429)["failure"], "rate_limited")
        self.assertEqual(parse(error="authentication_failed", error_status=401)["failure"], "auth")
        self.assertEqual(parse(error="server_error", error_status=500)["failure"], "http")
        self.assertEqual(parse(error="unknown", error_status=None)["failure"], "connect")
        self.assertEqual(parse(error="unknown", error_status=418)["failure"], "engine")
        no_response = parse(error="unknown", error_status=None, no_response=True)
        self.assertEqual(no_response["failure"], "stall")
        self.assertTrue(parse(error="overloaded", error_status=529, retry_delay_ms=4000)["detail"]
                        .startswith("Claude Code reported overloaded, HTTP 529"))

    def fake_engine(self, script: str):
        return types.SimpleNamespace(key="codex", label="Codex (fixture)", short_label="Codex", stream="codex",
                                     supports_effort=lambda: False,
                                     build_argv=lambda *a, **k: [sys.executable, "-c", script])

    def agent(self):
        tmp = tempfile.TemporaryDirectory(prefix="dgc-retry-engine-")
        self.addCleanup(tmp.cleanup)
        cfg = Config()
        cfg.project_root = Path(tmp.name)
        cfg.data.update({"model": "m", "base_url": "http://127.0.0.1:1/v1", "mode": "default", "suggest": False})
        ui = _Recorder()
        agent = Agent(cfg, ui)
        self.addCleanup(agent.mcp.stop_all)
        agent.session_file = sessions.new_path(Path(tmp.name))
        return agent, ui, cfg

    def test_delegate_turn_over_the_cutonce_stream_is_ok_and_recovered(self):
        from dgc import subscriptions
        fixture = (FIXTURES / "codex-reconnect-cutonce.jsonl").read_text()
        script = f"import sys\nsys.stdout.write({fixture!r})\nsys.stdout.flush()\n"
        agent, ui, cfg = self.agent()
        with mock.patch.object(subscriptions, "preflight", return_value=sys.executable):
            result = subscriptions.delegate_turn(cfg, agent, ui, self.fake_engine(script), "hi")
        self.assertTrue(result["ok"], result)
        self.assertEqual([s for s, _ in ui.frames], ["retrying", "recovered"])
        self.assertEqual(ui.frames[0][1]["endpoint"], "")
        self.assertEqual(ui.frames[0][1]["engine"], "Codex")
        self.assertEqual(ui.frames[0][1]["origin"], "engine")

    def test_a_cancelled_engine_turn_closes_its_run_cancelled(self):
        from dgc import subscriptions
        retry_line = json.dumps({"type": "error", "message": "Reconnecting... 1/5 (stream disconnected before completion)"})
        script = f"import sys, time\nprint({retry_line!r}, flush=True)\ntime.sleep(20)\n"
        agent, ui, cfg = self.agent()

        def stop_when_retrying():
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not ui.frames:
                time.sleep(0.02)
            agent.cancelled.set()
        watcher = threading.Thread(target=stop_when_retrying, daemon=True)
        watcher.start()
        with mock.patch.object(subscriptions, "preflight", return_value=sys.executable):
            result = subscriptions.delegate_turn(cfg, agent, ui, self.fake_engine(script), "hi")
        self.assertTrue(result.get("cancelled"), result)
        self.assertEqual([s for s, _ in ui.frames], ["retrying", "cancelled"])


# ---- 10. headless bounds -----------------------------------------------------------------------
class HeadlessBoundsTests(unittest.TestCase):
    def capture(self, turn_id=""):
        buffer = io.StringIO()
        ui = HeadlessUI(Emitter(buffer), None)
        ui.turn_id = turn_id
        return ui, lambda: [json.loads(line) for line in buffer.getvalue().splitlines()]

    def test_bounds_are_clamped_without_cutting_a_redaction_marker(self):
        ui, frames = self.capture("t1")
        summary = "x" * 190 + "[REDACTED]" + "y" * 50
        ui.model_retry("retrying", run_n=3, kind="nonsense", layer="sideways", attempt=500, summary=summary,
                       endpoint="http://u:p@h:1/v1?key=S", max_attempts=0, model="m" * 500, api_mode="a" * 99,
                       detail="d" * 9000, hint="h" * 999, http_status=42, delay_ms=10**9, origin="alien",
                       agent="sub-0123456789ab", engine="e" * 90)
        frame = frames()[-1]
        self.assertIsNone(event_error(frame))
        self.assertEqual(frame["retry_id"], "t1:sub-0123456789ab:retry3")
        self.assertEqual((frame["kind"], frame["layer"], frame["attempt"], frame["origin"]), ("other", "request", 100, "agent"))
        self.assertNotIn("max_attempts", frame)
        self.assertNotIn("http_status", frame)
        self.assertEqual(frame["delay_ms"], 600000)
        self.assertLessEqual(len(frame["summary"]), 200)
        self.assertNotRegex(frame["summary"], r"\[REDACT(?!ED\])")
        self.assertEqual(frame["endpoint"], "http://h:1/v1")
        self.assertLessEqual(len(frame["detail"]), 4000)
        self.assertLessEqual(len(frame["hint"]), 300)
        self.assertEqual(len(frame["api_mode"]), 40)
        self.assertEqual(len(frame["engine"]), 40)

    def test_no_turn_id_outside_a_turn_and_error_cause_is_clamped(self):
        ui, frames = self.capture("")
        ui.model_retry("gave_up", run_n=1, kind="connect", layer="request", attempt=3, summary="refused")
        frame = frames()[-1]
        self.assertNotIn("turn_id", frame)
        self.assertTrue(frame["retry_id"].startswith(ui.backend_epoch + ":retry"))
        self.assertIsNone(event_error(frame))
        ui.error("cannot connect", cause={"kind": "connect", "summary": "s" * 900, "endpoint": "http://u:p@h/v1?k=1",
                                          "attempts": 4, "run_n": 1, "detail": "d" * 5000, "http_status": 9999})
        error = frames()[-1]
        self.assertIsNone(event_error(error))
        self.assertEqual(error["cause"]["retry_id"], frame["retry_id"])
        self.assertLessEqual(len(error["cause"]["summary"]), 200)
        self.assertEqual(error["cause"]["endpoint"], "http://h/v1")
        self.assertNotIn("http_status", error["cause"])
        ui.error("plain")
        self.assertNotIn("cause", frames()[-1])


# ---- 17. TUI -----------------------------------------------------------------------------------
class TuiRetryBlockTests(unittest.TestCase):
    def tui(self):
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        tui.app = None
        tui._width = 100
        tui.blocks = []
        return tui

    def frame(self, tui, state, **fields):
        base = {"run_n": 1, "kind": "connect", "layer": "request", "attempt": 1, "max_attempts": 3,
                "summary": "connection refused by 127.0.0.1:11434", "endpoint": "http://127.0.0.1:11434/v1",
                "detail": "Max retries exceeded", "hint": "start your server", "delay_ms": 500}
        tui.model_retry(state, **{**base, **fields})

    def text(self, tui, blk):
        return "".join(f[1] for f in tui._retry_frags(blk))

    def test_one_block_per_run_updated_in_place_and_clicked_open(self):
        from prompt_toolkit.mouse_events import MouseEvent, MouseEventType
        from prompt_toolkit.data_structures import Point
        tui = self.tui()
        self.frame(tui, "retrying")
        self.frame(tui, "retrying", attempt=2, delay_ms=1000)
        self.frame(tui, "recovered", attempt=2)
        blocks = [b for b in tui.blocks if b.get("kind") == "retry"]
        self.assertEqual(len(blocks), 1)
        blk = blocks[0]
        self.assertIn("Reconnected after 2 retries · 127.0.0.1:11434", self.text(tui, blk))
        key = tui._block_key(blk, ("t",))
        head = tui._retry_frags(blk)[0]
        head[2](MouseEvent(Point(0, 0), MouseEventType.MOUSE_UP, frozenset(), frozenset()))
        self.assertTrue(blk["exp"])
        self.assertNotEqual(tui._block_key(blk, ("t",)), key)
        opened = self.text(tui, blk)
        self.assertIn("attempt 1", opened)
        self.assertIn("connection refused by 127.0.0.1:11434 · retried after 0.5s", opened)
        self.assertIn("start your server", opened)
        rev = blk["rev"]
        self.frame(tui, "recovered", attempt=2)
        self.assertNotEqual(tui._block_key(blk, ("t",))[2], rev)

    def test_a_terminal_frame_for_an_unknown_run_creates_nothing(self):
        tui = self.tui()
        self.frame(tui, "gave_up", run_n=9)
        self.assertEqual(tui.blocks, [])

    def test_expand_opens_the_last_retry_block(self):
        tui = self.tui()
        tui._flash = lambda message: setattr(tui, "_flashed", message)
        tui._invalidate = lambda: None
        self.frame(tui, "retrying")
        self.frame(tui, "retrying", run_n=2, origin="subagent", agent="sub-0123456789ab")
        tui._handle_slash("/expand")
        self.assertTrue(tui.blocks[-1]["exp"])
        self.assertFalse(tui.blocks[0]["exp"])
        self.assertEqual(tui._flashed, "expanded the reconnect details")
        self.assertIn("Sub-agent · Reconnecting 1/3", self.text(tui, tui.blocks[-1]))

    def test_fleet_route_lands_on_the_originating_session(self):
        from dgc.tui import TUI
        tui = object.__new__(TUI)
        tui.app = None
        session_a = types.SimpleNamespace(blocks=[], _follow=False, _scroll_off=0)
        session_b = types.SimpleNamespace(blocks=[], _follow=False, _scroll_off=0)
        tui._sessions = [session_a, session_b]
        tui._active_idx = 1
        tui._tls = threading.local()
        routed = {}

        def worker():
            tui._tls.session = session_a
            routed["run"] = tui.callback_route()
        thread = threading.Thread(target=worker)
        thread.start()
        thread.join()
        thread = threading.Thread(target=lambda: routed["run"](lambda: self.frame(tui, "retrying")))
        thread.start()
        thread.join()
        self.assertEqual(len(session_a.blocks), 1)
        self.assertEqual(session_b.blocks, [])

    def test_resume_renders_retry_blocks_for_both_forms(self):
        from dgc.tui import TUI
        tui = self.tui()
        for notice in (tagged(), legacy()):
            segments = tui._message_rows([{"role": "user", "content": "go"}, {"role": "assistant", "content": "a"},
                                          notice])
            blocks, _ = tui._history_blocks(segments[0][0])
            kinds = [b.get("kind") if isinstance(b, dict) else "ansi" for b in blocks]
            self.assertEqual(kinds, ["user", "md", "retry"])
            self.assertIn("Reconnect did not finish", self.text(tui, blocks[-1]))
            self.assertNotIn("monitor events", json.dumps([b for b in blocks if isinstance(b, str)]))


if __name__ == "__main__":
    unittest.main()
