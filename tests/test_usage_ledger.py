"""Token usage: the /v1 zero-token fix and the local usage ledger.

Every OpenAI-compatible stream now asks for its usage chunk (``stream_options.include_usage``),
an endpoint that refuses the field is retried once without it and never asked again, and every
request DGC finishes is written once to ``~/.dgc/usage.sqlite`` where it finished. These tests use
local mock endpoints, one real ``dgc serve`` over stdio with HOME under a temporary directory, and
at most one tiny request to a local Ollama when one is reachable.
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import os
import queue
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import config as config_mod  # noqa: E402
from dgc import usage_ledger  # noqa: E402
from dgc.agent import Agent  # noqa: E402
from dgc.config import Config, DEFAULTS  # noqa: E402
from dgc.editor_protocol import command_error, event_error  # noqa: E402
from dgc.llm import LLMClient  # noqa: E402

USAGE = {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70,
         "prompt_tokens_details": {"cached_tokens": 12}}


def _chunk(delta: dict | None = None, finish: str | None = None, usage=None,
           choices: bool = True) -> str:
    body: dict = {"id": "mock", "object": "chat.completion.chunk"}
    if choices:
        body["choices"] = [{"index": 0, "delta": delta or {}, "finish_reason": finish}]
    else:
        body["choices"] = []
    if usage is not None:
        body["usage"] = usage
    return "data: " + json.dumps(body) + "\n\n"


class _Endpoint(BaseHTTPRequestHandler):
    """An OpenAI-compatible /v1 that behaves like Ollama: usage only when the client asks.

    ``mode`` selects the behaviour for the whole server; requests are recorded for assertions.
    """

    mode = "ollama"   # ollama | reject400 | reject422 | other422 | echo422_once | refuse_then_other
                      # | no_usage | slow | overthink_once | error_frame
    requests: list[dict] = []
    task_prompt = "CHILD-TASK"

    def log_message(self, *args):
        pass

    def _reply(self, status: int, body: bytes, kind: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.endswith("/models"):
            self._reply(200, json.dumps({"data": [{"id": "mock-model"}]}).encode(), "application/json")
        else:
            self._reply(404, b"{}", "application/json")

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        type(self).requests.append(request)
        wants_usage = bool((request.get("stream_options") or {}).get("include_usage"))
        mode = type(self).mode
        if mode == "overthink_once":
            type(self).mode = "ollama"          # only the first attempt runs away
            body = "".join(_chunk({"reasoning_content": "thinking " * 8}) for _ in range(20))
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                self.wfile.write(body.encode())
                self.wfile.flush()
            except OSError:
                pass
            return
        if mode == "other422":
            self._reply(422, json.dumps({"detail": "model field is invalid"}).encode(),
                        "application/json")
            return
        if mode == "echo422_once":
            # FastAPI-style validation error about the messages that echoes the whole request,
            # stream_options included. It is not a refusal of stream_options.
            type(self).mode = "ollama"
            self._reply(422, json.dumps({"detail": [{
                "type": "value_error", "loc": ["body", "messages", 0], "msg": "bad message",
                "input": request}]}).encode(), "application/json")
            return
        if mode == "refuse_then_other":
            if "stream_options" in request:
                self._reply(400, json.dumps({"error": {
                    "message": "Unrecognized request argument supplied: stream_options"}}).encode(),
                    "application/json")
            else:
                self._reply(422, json.dumps({"detail": "model field is invalid"}).encode(),
                            "application/json")
            return
        if mode == "error_frame":
            body = (_chunk({"role": "assistant", "content": "partial"})
                    + "data: " + json.dumps({"error": {"message": "upstream fell over"}}) + "\n\n")
            self._reply(200, body.encode(), "text/event-stream")
            return
        if mode in ("reject400", "reject422") and "stream_options" in request:
            status = 400 if mode == "reject400" else 422
            self._reply(status, json.dumps({"error": {
                "message": "Unrecognized request argument supplied: stream_options"}}).encode(),
                "application/json")
            return
        text = "Done."
        messages = request.get("messages") or []
        if any(self.task_prompt in str(m.get("content", "")) for m in messages
               if m.get("role") == "user"):
            text = "Child finished."
        if mode == "slow":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                for _ in range(40):
                    self.wfile.write(_chunk({"content": "tick "}).encode())
                    self.wfile.flush()
                    time.sleep(0.05)
            except OSError:
                pass
            return
        body = _chunk({"role": "assistant", "content": text}) + _chunk({}, "stop")
        if wants_usage and mode != "no_usage":
            body += _chunk(usage=USAGE, choices=False)
        body += "data: [DONE]\n\n"
        self._reply(200, body.encode(), "text/event-stream")


def _server() -> tuple[ThreadingHTTPServer, int]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Endpoint)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def _config(root: Path, **values) -> Config:
    config = object.__new__(Config)
    config.project_root = root
    config.project_dir = root / ".dgc"
    config._persist = False
    config.data = copy.deepcopy(DEFAULTS)
    config.data.update(api_key="fixture-placeholder", model="mock-model", mode="auto", hooks={},
                       mcp_servers={}, suggest=False, artifact_autostart=False, notes=False,
                       ollama_keep_alive="")
    config.data.update(values)
    config._stored_secrets, config._env_secret_keys = {}, set()
    config._stored_provider_identity, config._provider_secret_identity = {}, {}
    config._stored_mcp_env, config._stored_mcp_identity = {}, {}
    config.credential_warnings = ()
    config.permissions = {"allow": [], "ask": [], "deny": []}
    return config


class QuietUI:
    def __getattr__(self, name):
        return lambda *args, **kwargs: None


class _LedgerCase(unittest.TestCase):
    """Every case gets its own ~/.dgc for the ledger and a fresh endpoint rejection memory."""

    def setUp(self):
        home = tempfile.TemporaryDirectory(prefix="dgc-usage-home-")
        self.addCleanup(home.cleanup)
        self.home = Path(home.name)
        patcher = patch.object(config_mod, "USER_HOME", self.home / ".dgc")
        patcher.start()
        self.addCleanup(patcher.stop)
        usage_ledger._reset_for_tests()
        self.addCleanup(usage_ledger._reset_for_tests)
        LLMClient._stream_usage_rejections.clear()
        self.addCleanup(LLMClient._stream_usage_rejections.clear)
        _Endpoint.mode = "ollama"
        _Endpoint.requests = []

    def rows(self) -> list[tuple]:
        path = usage_ledger.ledger_path()
        if not path.exists():
            return []
        with sqlite3.connect(str(path)) as db:
            return db.execute("SELECT provider, host, model, source, input_tokens, output_tokens, "
                              "cached_input_tokens, metered FROM requests ORDER BY id").fetchall()


class StreamUsageRequestTests(_LedgerCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.port = _server()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def client(self, **kwargs) -> LLMClient:
        return LLMClient(f"http://127.0.0.1:{self.port}/v1", "k", "mock-model",
                         api_mode="chat_completions", **kwargs)

    def test_request_body_asks_for_the_usage_chunk_and_parses_it(self):
        result = self.client().chat([{"role": "user", "content": "hi"}])
        self.assertEqual(_Endpoint.requests[-1].get("stream_options"), {"include_usage": True})
        self.assertEqual(result.content, "Done.")
        self.assertEqual(result.usage["input_tokens"], 50)
        self.assertEqual(result.usage["output_tokens"], 20)
        self.assertEqual(result.usage["cached_input_tokens"], 12)

    def test_a_usage_opt_out_sends_no_stream_options(self):
        result = self.client(provider_capabilities={"usage": False}).chat(
            [{"role": "user", "content": "hi"}])
        self.assertNotIn("stream_options", _Endpoint.requests[-1])
        self.assertEqual(result.usage, {})

    def test_rejected_stream_options_retry_once_and_are_remembered_per_endpoint(self):
        for mode in ("reject400", "reject422"):
            with self.subTest(mode=mode):
                LLMClient._stream_usage_rejections.clear()
                _Endpoint.mode, _Endpoint.requests = mode, []
                result = self.client().chat([{"role": "user", "content": "hi"}])
                self.assertEqual(result.content, "Done.")
                self.assertEqual(len(_Endpoint.requests), 2, "exactly one retry")
                self.assertIn("stream_options", _Endpoint.requests[0])
                self.assertNotIn("stream_options", _Endpoint.requests[1])
                # A new client for the same endpoint (another model, even) does not ask again.
                other = LLMClient(f"http://127.0.0.1:{self.port}/v1", "k", "another-model",
                                  api_mode="chat_completions")
                other.chat([{"role": "user", "content": "again"}])
                self.assertEqual(len(_Endpoint.requests), 3)
                self.assertNotIn("stream_options", _Endpoint.requests[2])

    def test_a_422_about_something_else_is_still_an_error(self):
        from dgc.llm import LLMError
        _Endpoint.mode = "other422"
        with self.assertRaises(LLMError) as raised:
            self.client().chat([{"role": "user", "content": "hi"}])
        self.assertIn("422", str(raised.exception))
        self.assertEqual(len(_Endpoint.requests), 1, "no blind retry")
        self.assertEqual(LLMClient._stream_usage_rejections, set())

    def test_an_error_that_merely_echoes_the_request_does_not_switch_usage_off(self):
        from dgc.llm import LLMError
        _Endpoint.mode = "echo422_once"
        with self.assertRaises(LLMError):
            self.client().chat([{"role": "user", "content": "hi"}])
        self.assertEqual(len(_Endpoint.requests), 1, "an unrelated 422 is not retried")
        self.assertEqual(LLMClient._stream_usage_rejections, set())
        result = self.client().chat([{"role": "user", "content": "hi again"}])
        self.assertEqual(_Endpoint.requests[-1].get("stream_options"), {"include_usage": True})
        self.assertEqual(result.usage["input_tokens"], 50, "usage still counted after the error")

    def test_a_refusal_is_remembered_only_when_the_retry_without_the_field_succeeds(self):
        from dgc.llm import LLMError
        _Endpoint.mode = "refuse_then_other"
        with self.assertRaises(LLMError):
            self.client().chat([{"role": "user", "content": "hi"}])
        self.assertEqual(len(_Endpoint.requests), 2)
        self.assertEqual(LLMClient._stream_usage_rejections, set(),
                         "a retry that failed for another reason proves nothing about the field")
        _Endpoint.mode = "ollama"
        self.client().chat([{"role": "user", "content": "hi"}])
        self.assertIn("stream_options", _Endpoint.requests[-1])

    def test_refusal_bodies_are_told_apart_from_echoes(self):
        from dgc.llm import _STREAM_USAGE_REFUSAL_RE as refusal
        request = {"model": "m", "stream": True, "stream_options": {"include_usage": True},
                   "messages": [{"role": "user", "content": "an invalid unknown extra word"}]}
        refusals = [
            '{"error":{"message":"Unrecognized request argument supplied: stream_options"}}',
            "{'type': 'extra_forbidden', 'loc': ('body', 'stream_options'), 'msg': 'Extra inputs "
            "are not permitted', 'input': {'include_usage': True}}",
            json.dumps({"detail": [{"type": "extra_forbidden", "loc": ["body", "stream_options"],
                                    "msg": "Extra inputs are not permitted"}]}),
            '{"error":"\\"stream_options\\" is not allowed"}',
        ]
        echoes = [
            json.dumps({"detail": [{"loc": ["body", "messages", 0], "msg": "bad", "input": request}]}),
            json.dumps({"error": {"message": "invalid tools", "request": request}}),
        ]
        for body in refusals:
            self.assertTrue(refusal.search(body), body)
        for body in echoes:
            self.assertIsNone(refusal.search(body), body)


class UsageChunkParsingTests(unittest.TestCase):
    """The stream consumer, fed recorded frames without a network."""

    class _Response:
        def __init__(self, text: str, kind: str = "text/event-stream"):
            self.headers = {"Content-Type": kind}
            self._lines = text.splitlines()
            self.encoding = None
            self.status_code = 200

        def iter_lines(self, decode_unicode=False, chunk_size=1):
            for line in self._lines:
                yield line if decode_unicode else line.encode()

        def iter_content(self, chunk_size=1, decode_unicode=False):
            data = ("\n".join(self._lines) + "\n")
            yield data if decode_unicode else data.encode()

        def close(self):
            pass

    def consume(self, text: str):
        client = LLMClient("http://127.0.0.1:9/v1", "k", "m", api_mode="chat_completions")
        return client._consume(self._Response(text), None, None)

    def test_final_usage_chunk_with_empty_choices_after_finish(self):
        text = (_chunk({"content": "Hello"}) + _chunk({}, "stop")
                + _chunk(usage=USAGE, choices=False) + "data: [DONE]\n\n")
        result = self.consume(text)
        self.assertEqual((result.content, result.finish_reason), ("Hello", "stop"))
        self.assertEqual(result.usage, {"input_tokens": 50, "output_tokens": 20,
                                        "cached_input_tokens": 12, "reasoning_tokens": 0})

    def test_usage_chunk_that_omits_the_choices_array(self):
        text = (_chunk({"content": "Hi"}) + _chunk({}, "stop")
                + "data: " + json.dumps({"usage": {"prompt_tokens": 7, "completion_tokens": 3}})
                + "\n\ndata: [DONE]\n\n")
        result = self.consume(text)
        self.assertEqual((result.usage["input_tokens"], result.usage["output_tokens"]), (7, 3))

    def test_null_usage_on_ordinary_chunks_is_ignored(self):
        text = (_chunk({"content": "A"}, usage=None) + _chunk({}, "stop")
                + "data: [DONE]\n\n")
        self.assertEqual(self.consume(text).usage, {})

    def test_cached_input_fields_from_every_provider_shape(self):
        from dgc.llm import normalize_usage
        for raw in ({"prompt_tokens": 10, "prompt_tokens_details": {"cached_tokens": 4}},
                    {"input_tokens": 10, "input_tokens_details": {"cached_tokens": 4}},
                    {"prompt_tokens": 10, "prompt_cache_hit_tokens": 4, "prompt_cache_miss_tokens": 6},
                    {"input_tokens": 10, "cache_read_input_tokens": 4},
                    {"prompt_tokens": 10, "cached_input_tokens": 4}):
            with self.subTest(raw=raw):
                self.assertEqual(normalize_usage(raw)["cached_input_tokens"], 4)
                self.assertEqual(normalize_usage(raw)["input_tokens"], 10)

    def test_native_ollama_reads_the_cached_prompt_count(self):
        frames = [{"message": {"role": "assistant", "content": "ok"}, "done": False},
                  {"message": {"role": "assistant", "content": ""}, "done": True,
                   "done_reason": "stop", "prompt_eval_count": 40, "eval_count": 5,
                   "prompt_eval_cached_count": 32}]
        client = LLMClient("http://127.0.0.1:11434/v1", "k", "m")
        response = self._Response("\n".join(json.dumps(frame) for frame in frames),
                                  "application/x-ndjson")
        result = client._consume_ollama(response, None, None)
        self.assertEqual(result.usage, {"input_tokens": 40, "output_tokens": 5,
                                        "cached_input_tokens": 32, "reasoning_tokens": 0})
        frames[-1].pop("prompt_eval_cached_count")
        response = self._Response("\n".join(json.dumps(frame) for frame in frames),
                                  "application/x-ndjson")
        self.assertEqual(client._consume_ollama(response, None, None).usage["cached_input_tokens"], 0)


class LedgerRecordingTests(_LedgerCase):
    @classmethod
    def setUpClass(cls):
        cls.server, cls.port = _server()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def agent(self, **values) -> Agent:
        work = tempfile.TemporaryDirectory(prefix="dgc-usage-work-")
        self.addCleanup(work.cleanup)
        values.setdefault("base_url", f"http://127.0.0.1:{self.port}/v1")
        values.setdefault("api_mode", "chat_completions")
        agent = Agent(_config(Path(work.name), **values), QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        return agent

    def test_goal_token_budget_advances_on_the_v1_route(self):
        agent = self.agent()
        agent.set_goal("finish the fixture task", token_budget=10)
        agent.run_turn("start")
        snapshot = agent.goal_snapshot()
        requests = len(_Endpoint.requests)
        self.assertGreaterEqual(requests, 1)
        self.assertTrue(snapshot["usage_known"], snapshot)
        self.assertEqual(snapshot["tokens_used"], 70 * requests, snapshot)
        self.assertEqual(agent.goal_status, "paused")
        self.assertIn("budget was reached", snapshot["reason"])
        # The control: the same route with the usage request switched off cannot be budgeted,
        # which is exactly what every /v1 session did before include_usage was sent.
        _Endpoint.requests = []
        blind = self.agent(provider_capabilities={"usage": False})
        blind.set_goal("finish the fixture task", token_budget=10)
        blind.run_turn("start")
        self.assertFalse(blind.goal_snapshot()["usage_known"])
        self.assertIn("did not report usage", blind.goal_snapshot()["reason"])

    def test_every_finished_request_is_one_row_with_host_only(self):
        agent = self.agent(base_url=f"http://user:secret@127.0.0.1:{self.port}/v1?token=abc")
        agent.client.chat([{"role": "user", "content": "hi"}])
        rows = self.rows()
        self.assertEqual(rows, [("compat", f"127.0.0.1:{self.port}", "mock-model", "main",
                                 50, 20, 12, 1)])
        blob = usage_ledger.ledger_path().read_bytes()
        for leaked in (b"secret", b"token=abc", b"/v1", b"hi"):
            self.assertNotIn(leaked, blob)

    def test_subagent_request_is_counted_exactly_once(self):
        agent = self.agent()
        agent.client.chat([{"role": "user", "content": "parent request"}])
        parent_requests = len(_Endpoint.requests)
        summary = agent._run_subagent("fixture child", f"{_Endpoint.task_prompt}: reply briefly")
        self.assertIn("Child finished", summary)
        rows = self.rows()
        served = len(_Endpoint.requests)
        child_requests = served - parent_requests
        self.assertGreaterEqual(child_requests, 1)
        self.assertEqual(len(rows), served, "one ledger row per HTTP request, never two")
        self.assertEqual([row[3] for row in rows].count("subagent"), child_requests)
        self.assertEqual([row[3] for row in rows].count("main"), parent_requests)
        report = usage_ledger.report("today")
        self.assertEqual(report["totals"]["requests"], served)
        self.assertEqual(report["totals"]["input_tokens"], 50 * served)
        # The parent's session totals still include the child (that is what goals budget on).
        self.assertEqual(agent.usage_totals["input_tokens"], 50 * child_requests)

    def test_fallback_and_compaction_clients_are_labelled(self):
        agent = self.agent(fallback_model="mock-fallback")
        agent._fallback_client("mock-fallback").chat([{"role": "user", "content": "x"}])
        agent._aux_client(max_tokens=64, source="compaction").chat([{"role": "user", "content": "y"}])
        agent._aux_client(max_tokens=64).chat([{"role": "user", "content": "z"}])
        self.assertEqual([(row[2], row[3]) for row in self.rows()],
                         [("mock-fallback", "fallback"), ("mock-model", "compaction"),
                          ("mock-model", "other")])

    def test_requests_without_a_usage_report_are_counted_as_unmetered(self):
        agent = self.agent()
        _Endpoint.mode = "no_usage"
        agent.client.chat([{"role": "user", "content": "no usage please"}])
        _Endpoint.mode = "slow"
        cancel = threading.Event()
        threading.Timer(0.3, cancel.set).start()
        result = agent.client.chat([{"role": "user", "content": "stop me"}], cancel=cancel)
        self.assertEqual(result.finish_reason, "cancelled")
        # A request cancelled before it was sent is not a request at all.
        agent.client.chat([{"role": "user", "content": "never sent"}], cancel=cancel)
        rows = self.rows()
        self.assertEqual(len(rows), 2, rows)
        self.assertTrue(all(row[7] == 0 and row[4] == row[5] == 0 for row in rows))
        totals = usage_ledger.report("today")["totals"]
        self.assertEqual((totals["requests"], totals["unmetered_requests"]), (2, 2))

    def test_a_stream_that_breaks_after_the_provider_answered_is_one_unmetered_row(self):
        from dgc.llm import LLMError
        agent = self.agent()
        _Endpoint.mode = "error_frame"
        with self.assertRaises(LLMError):
            agent.client.chat([{"role": "user", "content": "break mid-stream"}])
        _Endpoint.mode = "other422"         # refused before any answer: not a request that ran
        with self.assertRaises(LLMError):
            agent.client.chat([{"role": "user", "content": "refused"}])
        rows = self.rows()
        self.assertEqual([(row[3], row[4], row[5], row[7]) for row in rows], [("main", 0, 0, 0)])
        self.assertEqual(usage_ledger.report("today")["totals"]["unmetered_requests"], 1)

    def test_an_overthink_retry_counts_the_abandoned_attempt_once(self):
        agent = self.agent(think_budget_tokens=20)
        _Endpoint.mode = "overthink_once"
        result = agent.client.chat([{"role": "user", "content": "think less"}],
                                   reasoning_effort="high")
        self.assertEqual(result.content, "Done.")
        self.assertEqual(len(_Endpoint.requests), 2)
        rows = self.rows()
        self.assertEqual([(row[4], row[7]) for row in rows], [(0, 0), (50, 1)],
                         "the watchdog's abandoned request is an unmetered row, the retry a metered one")

    def test_a_broken_ledger_never_breaks_the_request(self):
        agent = self.agent()
        (self.home / ".dgc").mkdir(parents=True, exist_ok=True)
        (self.home / ".dgc" / usage_ledger.LEDGER_NAME).mkdir()     # a directory, not a file
        with patch.object(sys, "stderr", new=open(os.devnull, "w")) as quiet:
            self.addCleanup(quiet.close)
            result = agent.client.chat([{"role": "user", "content": "hi"}])
            self.assertEqual(result.content, "Done.")
            self.assertTrue(usage_ledger.last_error())
            report = usage_ledger.report("7d")
        self.assertIn("error", report)
        self.assertEqual(report["totals"]["requests"], 0)


class LedgerAggregationTests(_LedgerCase):
    def local(self, day: dt.date, hour: int, minute: int = 0) -> float:
        return time.mktime(dt.datetime(day.year, day.month, day.day, hour, minute).timetuple())

    def test_ranges_follow_local_midnights_and_list_every_day(self):
        now_day = dt.date(2026, 9, 14)
        now = self.local(now_day, 15)
        add = lambda when, model="m1", inp=100, out=10, cached=0: usage_ledger.record(
            provider="ollama", base_url="http://localhost:11434/v1", model=model,
            input_tokens=inp, output_tokens=out, cached_input_tokens=cached, now=when)
        add(self.local(now_day, 0, 1))                                   # today
        add(self.local(now_day - dt.timedelta(days=1), 23, 59))          # yesterday
        add(self.local(now_day - dt.timedelta(days=6), 12), model="m2", inp=1000, out=300)
        add(self.local(now_day - dt.timedelta(days=7), 12))              # outside 7d
        add(self.local(dt.date(2026, 9, 1), 8), cached=40)               # this month, 13 days ago
        add(self.local(dt.date(2026, 8, 31), 23))                        # last month
        usage_ledger.record(provider="ollama", base_url="http://localhost:11434/v1", model="m1",
                            now=self.local(now_day, 9))                  # unmetered, today

        today = usage_ledger.report("today", now=now)
        self.assertEqual(today["totals"], {"input_tokens": 100, "output_tokens": 10,
                                           "cached_input_tokens": 0, "requests": 2,
                                           "unmetered_requests": 1})
        self.assertEqual([d["date"] for d in today["by_day"]], ["2026-09-14"])

        week = usage_ledger.report("7d", now=now)
        self.assertEqual(week["totals"]["requests"], 4)
        self.assertEqual(len(week["by_day"]), 7)
        self.assertEqual(week["by_day"][0]["date"], "2026-09-08")
        self.assertEqual(week["by_day"][0]["input_tokens"], 1000)
        self.assertEqual([d["requests"] for d in week["by_day"]], [1, 0, 0, 0, 0, 1, 2])
        self.assertEqual(week["by_model"][0]["model"], "m2", "sorted by total tokens")
        self.assertEqual(week["by_model"][1]["unmetered_requests"], 1)

        month = usage_ledger.report("month", now=now)
        self.assertEqual(month["totals"]["requests"], 6)
        self.assertEqual(month["totals"]["cached_input_tokens"], 40)
        self.assertEqual(len(month["by_day"]), 14)

        thirty = usage_ledger.report("30d", now=now)
        self.assertEqual((thirty["totals"]["requests"], len(thirty["by_day"])), (7, 30))

        everything = usage_ledger.report("all", now=now)
        self.assertEqual(everything["totals"]["requests"], 7)
        self.assertEqual(everything["by_day"][0]["date"], "2026-08-31")
        self.assertEqual(everything["by_day"][-1]["date"], "2026-09-14")
        for report in (today, week, month, thirty, everything):
            event = {"type": "usage_report", "seq": 1, "request_id": "r", **report}
            self.assertIsNone(event_error(event), event_error(event))
        self.assertRegex(week["generated_at"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")

    def test_a_future_stamp_neither_prunes_history_nor_counts_as_today(self):
        now = time.time()
        usage_ledger.record(provider="p", base_url="", model="real", input_tokens=7,
                            now=now - 20 * 86_400)
        usage_ledger._reset_for_tests()
        usage_ledger.record(provider="p", base_url="", model="future", input_tokens=9,
                            now=now + 3 * 365 * 86_400)
        self.assertEqual(sorted(row[2] for row in self.rows()), ["future", "real"])
        self.assertEqual(usage_ledger.report("today", now=now)["totals"]["requests"], 0)
        self.assertEqual(usage_ledger.report("30d", now=now)["totals"]["input_tokens"], 7)

    def test_a_locked_ledger_costs_later_requests_only_a_short_wait(self):
        usage_ledger.record(provider="p", base_url="", model="m", input_tokens=1)
        path = usage_ledger.ledger_path()
        holder = sqlite3.connect(str(path), timeout=0, isolation_level=None)
        self.addCleanup(holder.close)
        holder.execute("BEGIN EXCLUSIVE")
        with patch.object(sys, "stderr", new=open(os.devnull, "w")) as quiet:
            self.addCleanup(quiet.close)
            started = time.monotonic()
            self.assertFalse(usage_ledger.record(provider="p", base_url="", model="m"))
            first = time.monotonic() - started
            started = time.monotonic()
            for _ in range(5):
                self.assertFalse(usage_ledger.record(provider="p", base_url="", model="m"))
            later = (time.monotonic() - started) / 5
        self.assertGreater(first, 1.0, "the first write waits the normal busy timeout")
        self.assertLess(later, 0.5, f"later writes back off quickly, not {later:.2f}s each")
        holder.execute("ROLLBACK")
        self.assertTrue(usage_ledger.record(provider="p", base_url="", model="m", input_tokens=2))
        self.assertEqual(len(self.rows()), 2)

    def test_a_corrupt_ledger_is_set_aside_and_counting_starts_again(self):
        path = usage_ledger.ledger_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"this is not a sqlite database at all" * 64)
        with patch.object(sys, "stderr", new=open(os.devnull, "w")) as quiet:
            self.addCleanup(quiet.close)
            self.assertIn("error", usage_ledger.report("7d"))      # a read reports, never repairs
            self.assertTrue(usage_ledger.record(provider="p", base_url="", model="m", input_tokens=3))
        kept = list(path.parent.glob(usage_ledger.LEDGER_NAME + ".corrupt-*"))
        self.assertEqual(len(kept), 1, "the damaged file is kept, never deleted")
        self.assertTrue(kept[0].read_bytes().startswith(b"this is not"))
        self.assertEqual(usage_ledger.report("7d")["totals"]["input_tokens"], 3)

    def test_retention_prunes_rows_older_than_400_days(self):
        now = time.time()
        usage_ledger.record(provider="p", base_url="", model="old", input_tokens=1,
                            now=now - 401 * 86_400)
        usage_ledger.record(provider="p", base_url="", model="kept", input_tokens=1,
                            now=now - 399 * 86_400)
        usage_ledger._reset_for_tests()          # a new process opens the ledger and prunes once
        usage_ledger.record(provider="p", base_url="", model="new", input_tokens=1, now=now)
        self.assertEqual([row[2] for row in self.rows()], ["kept", "new"])

    def test_schema_has_no_place_for_content(self):
        usage_ledger.record(provider="p", base_url="https://h.example/v1", model="m", now=time.time())
        with sqlite3.connect(str(usage_ledger.ledger_path())) as db:
            columns = [row[1] for row in db.execute("PRAGMA table_info(requests)")]
        self.assertEqual(columns, ["id", "ts", "provider", "host", "model", "source",
                                   "input_tokens", "output_tokens", "cached_input_tokens", "metered"])
        self.assertEqual(usage_ledger.endpoint_host("https://u:p@[::1]:8443/v1/x?k=v#f"), "[::1]:8443")
        self.assertEqual(usage_ledger.endpoint_host("not a url"), "")
        self.assertEqual(oct(usage_ledger.ledger_path().stat().st_mode & 0o777), "0o600")

    def test_two_processes_writing_at_once_lose_nothing(self):
        path = self.home / ".dgc" / usage_ledger.LEDGER_NAME
        start = time.time() + 1.5
        program = (
            "import sys, time\n"
            "from pathlib import Path\n"
            "from dgc import usage_ledger\n"
            f"time.sleep(max(0, {start} - time.time()))\n"
            "ok = sum(usage_ledger.record(provider='p', base_url='http://h:1', model=sys.argv[1],"
            " input_tokens=3, output_tokens=2, path=Path(sys.argv[2])) for _ in range(300))\n"
            "print(ok, usage_ledger.last_error())\n")
        env = dict(os.environ, PYTHONPATH=str(PROJECT), HOME=str(self.home))
        procs = [subprocess.Popen([sys.executable, "-c", program, f"writer{i}", str(path)],
                                  env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                 for i in range(3)]
        outputs = [proc.communicate(timeout=120) for proc in procs]
        for proc, (out, err) in zip(procs, outputs):
            self.assertEqual(proc.returncode, 0, err)
            self.assertEqual(out.split()[0], "300", out + err)
        report = usage_ledger.report("today", path=path)
        self.assertEqual(report["totals"]["requests"], 900)
        self.assertEqual(report["totals"]["input_tokens"], 2700)
        self.assertEqual(sorted(row["model"] for row in report["by_model"]),
                         ["writer0", "writer1", "writer2"])

    def test_terminal_report_and_dgc_usage_print_the_same_aggregates(self):
        now = time.time()
        usage_ledger.record(provider="ollama", base_url="http://localhost:11434/v1",
                            model="qwen3.8:27b", input_tokens=12_345, output_tokens=678,
                            cached_input_tokens=90, now=now)
        text = usage_ledger.format_report(usage_ledger.report("7d", now=now))
        for needle in ("Token usage · Last 7 days", "12,345", "678", "qwen3.8:27b",
                       "ollama · localhost:11434", "Nothing here is sent anywhere"):
            self.assertIn(needle, text)
        self.assertIn("No model requests counted", usage_ledger.format_report(
            usage_ledger.empty_report("today")))
        self.assertIn("Try `/usage all`", usage_ledger.format_report(usage_ledger.empty_report("7d")))
        one = usage_ledger.empty_report("7d")
        one["totals"].update(requests=2, input_tokens=5, unmetered_requests=1)
        self.assertIn("1 request ended without a usage report", usage_ledger.format_report(one))
        self.assertIn("so its tokens are not", usage_ledger.format_report(one))
        env = dict(os.environ, PYTHONPATH=str(PROJECT), HOME=str(self.home),
                   PYTHONDONTWRITEBYTECODE="1")
        done = subprocess.run([sys.executable, "-m", "dgc", "usage", "--range", "week", "--json"],
                              env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["totals"]["input_tokens"], 12_345)
        bad = subprocess.run([sys.executable, "-m", "dgc", "usage", "--range", "fortnight"],
                             env=env, capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 2)
        self.assertIn("range must be one of", bad.stderr)

    def test_tui_usage_opens_the_same_report(self):
        from dgc.tui import TUI
        usage_ledger.record(provider="ollama", base_url="http://localhost:11434/v1", model="m",
                            input_tokens=5, output_tokens=6)
        opened = []
        fake = type("T", (), {"_open_reader": lambda self, md, **kw: opened.append((md, kw)),
                              "_flash": lambda self, message: opened.append(("flash", message))})()
        TUI._show_usage(fake, "today")
        self.assertIn("Token usage · Today", opened[-1][0])
        TUI._show_usage(fake, "sometime")
        self.assertEqual(opened[-1][0], "flash")


class ProtocolShapeTests(unittest.TestCase):
    def test_get_usage_and_usage_report_are_declared(self):
        self.assertIsNone(command_error({"type": "get_usage", "request_id": "u1", "range": "30d"}))
        self.assertIsNotNone(command_error({"type": "get_usage", "request_id": "u1", "range": "year"}))
        self.assertIsNotNone(command_error({"type": "get_usage", "range": "7d"}))
        report = usage_ledger.empty_report("month")
        self.assertIsNone(event_error({"type": "usage_report", "seq": 3, "request_id": "u1", **report}))
        self.assertIsNotNone(event_error({"type": "usage_report", "seq": 3, "request_id": "u1",
                                          **report, "prompt": "nope"}))
        from dgc import editor_protocol
        for spec in (editor_protocol.EVENT_FIELDS["usage_report"],
                     editor_protocol.COMMAND_FIELDS["get_usage"]):
            self.assertNotIn("seq", spec)
            self.assertNotIn("type", spec)


class ServeUsageRoundTripTests(unittest.TestCase):
    """A real `dgc serve`: a turn against a /v1 mock lands in the ledger and get_usage reads it."""

    @classmethod
    def setUpClass(cls):
        cls.server, cls.port = _server()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def test_get_usage_round_trip_over_stdio(self):
        _Endpoint.mode, _Endpoint.requests = "ollama", []
        home = tempfile.TemporaryDirectory(prefix="dgc-usage-serve-home-")
        work = tempfile.TemporaryDirectory(prefix="dgc-usage-serve-work-")
        self.addCleanup(home.cleanup)
        self.addCleanup(work.cleanup)
        home_path = Path(home.name)
        (home_path / ".dgc").mkdir()
        (home_path / ".dgc" / "config.json").write_text(json.dumps({
            "base_url": f"http://127.0.0.1:{self.port}/v1", "model": "mock-model",
            "api_mode": "chat_completions", "suggest": False, "notes": False}))
        earlier = time.time() - 3 * 86_400
        usage_ledger.record(provider="anthropic", base_url="https://api.anthropic.com/v1",
                            model="seeded-model", input_tokens=1000, output_tokens=100,
                            now=earlier, path=home_path / ".dgc" / usage_ledger.LEDGER_NAME)
        usage_ledger._reset_for_tests()
        env = dict(os.environ, HOME=str(home_path), PYTHONPATH=str(PROJECT),
                   PYTHONDONTWRITEBYTECODE="1")
        for var in ("XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"):
            env[var] = str(home_path)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=work.name, env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
        events: "queue.Queue[dict]" = queue.Queue()
        seen: list[dict] = []

        def read():
            for line in proc.stdout:
                try:
                    events.put(json.loads(line))
                except ValueError:
                    pass
        threading.Thread(target=read, daemon=True).start()
        stderr: list[str] = []
        threading.Thread(target=lambda: stderr.extend(proc.stderr), daemon=True).start()

        def cleanup():
            if proc.poll() is None:
                try:
                    proc.stdin.close()
                    proc.wait(timeout=30)
                except (OSError, subprocess.TimeoutExpired):
                    proc.kill()
                    proc.wait(timeout=10)
            for pipe in (proc.stdin, proc.stdout, proc.stderr):
                try:
                    pipe.close()
                except (OSError, ValueError):
                    pass
        self.addCleanup(cleanup)

        def send(command):
            self.assertIsNone(command_error(command))
            proc.stdin.write(json.dumps(command) + "\n")
            proc.stdin.flush()

        def wait(predicate, timeout=90):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    event = events.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                seen.append(event)
                self.assertIsNone(event_error(event), event)
                if predicate(event):
                    return event
            self.fail(f"no matching event; saw {[e.get('type') for e in seen][-30:]} {''.join(stderr)[-2000:]}")

        ready = wait(lambda e: e["type"] == "ready")
        self.assertTrue(ready["capabilities"].get("usage_ledger"))
        send({"type": "set_mode", "mode": "auto", "acknowledge_workspace_trust": True,
              "request_id": "mode"})
        wait(lambda e: e["type"] == "mode_changed")
        send({"type": "prompt", "text": "say done", "request_id": "p1"})
        wait(lambda e: e["type"] == "turn_end")
        served = len(_Endpoint.requests)
        self.assertGreaterEqual(served, 1)
        self.assertTrue(all(r.get("stream_options") == {"include_usage": True}
                            for r in _Endpoint.requests))

        send({"type": "get_usage", "request_id": "u-today", "range": "today"})
        today = wait(lambda e: e["type"] == "usage_report" and e.get("request_id") == "u-today")
        self.assertEqual(today["range"], "today")
        self.assertEqual(today["totals"]["requests"], served)
        self.assertEqual(today["totals"]["input_tokens"], 50 * served)
        self.assertEqual(today["totals"]["output_tokens"], 20 * served)
        self.assertEqual(today["totals"]["cached_input_tokens"], 12 * served)
        self.assertEqual(today["by_model"][0]["model"], "mock-model")
        self.assertEqual(today["by_model"][0]["host"], f"127.0.0.1:{self.port}")

        send({"type": "get_usage", "request_id": "u-week", "range": "7d"})
        week = wait(lambda e: e["type"] == "usage_report" and e.get("request_id") == "u-week")
        self.assertEqual(week["totals"]["requests"], served + 1)
        self.assertEqual({row["model"] for row in week["by_model"]}, {"mock-model", "seeded-model"})
        self.assertEqual(len(week["by_day"]), 7)

        proc.stdin.write(json.dumps({"type": "get_usage", "request_id": "u-bad", "range": "decade"}) + "\n")
        proc.stdin.flush()
        rejected = wait(lambda e: e["type"] == "command_rejected")
        self.assertEqual(rejected["reason"], "invalid_command")
        self.assertIsNone(proc.poll())


def _ollama_ps() -> dict | None:
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/ps", timeout=3) as response:
            return json.loads(response.read())
    except Exception:
        return None


class RealOllamaV1Tests(_LedgerCase):
    """One tiny request to the local Ollama's /v1 route; skipped when it is not reachable.

    It uses a model that is already loaded when there is one (keeping its remaining residency),
    otherwise qwen2.5:14b with a 60 s keep-alive, and it never stops or unloads anything. Ollama's /v1 route applies the server's default keep-alive to the
    model it serves (a keep_alive field is sent with the model's remaining time, but that route may
    ignore it), so a model that looks pinned -- more than two days of residency left -- is not
    touched at all: the test skips rather than risk shortening someone else's pin.
    """

    def test_local_ollama_v1_request_records_nonzero_tokens(self):
        if os.environ.get("DGC_SKIP_REAL_OLLAMA"):
            self.skipTest("DGC_SKIP_REAL_OLLAMA is set")
        status = _ollama_ps()
        if status is None:
            self.skipTest("no Ollama at 127.0.0.1:11434")
        loaded = [m for m in status.get("models") or []
                  if ":cloud" not in str(m.get("name")) and "embed" not in str(m.get("name"))]
        keep_alive = ""
        if loaded:
            model = str(loaded[0].get("name") or loaded[0].get("model"))
            expires = str(loaded[0].get("expires_at") or "")
            try:
                remaining = (dt.datetime.fromisoformat(expires.replace("Z", "+00:00"))
                             - dt.datetime.now(dt.timezone.utc)).total_seconds()
                keep_alive = f"{max(60, int(remaining))}s"
            except ValueError:
                remaining, keep_alive = 0.0, ""
            if remaining > 2 * 86_400:
                self.skipTest(f"{model} looks pinned in Ollama; a /v1 request could reset its keep-alive")
        else:
            model = "qwen2.5:14b"
            # Nothing was loaded, so this test is what loads it: ask for a short residency instead
            # of the server default, which can be a day, on a machine other services share.
            keep_alive = "60s"
            try:
                with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=3) as response:
                    names = {str(m.get("name")) for m in json.loads(response.read()).get("models") or []}
            except Exception:
                names = set()
            if model not in names:
                self.skipTest("no model is loaded and qwen2.5:14b is not installed; nothing is pulled")
        work = tempfile.TemporaryDirectory(prefix="dgc-usage-ollama-")
        self.addCleanup(work.cleanup)
        agent = Agent(_config(Path(work.name), base_url="http://127.0.0.1:11434/v1", model=model,
                              api_mode="chat_completions", api_key="ollama", max_tokens=8,
                              ollama_keep_alive=keep_alive, request_timeout=600), QuietUI())
        self.addCleanup(agent.mcp.stop_all)
        self.assertEqual(agent.client.family, "ollama")
        result = agent.client.chat([{"role": "user", "content": "Reply with the word ok."}],
                                   reasoning_effort="off")
        self.assertGreater(result.usage.get("input_tokens", 0), 0, result)
        self.assertGreater(result.usage.get("output_tokens", 0), 0, result)
        rows = self.rows()
        self.assertEqual(len(rows), 1)
        provider, host, row_model, source, inp, out, _cached, metered = rows[0]
        self.assertEqual((provider, host, row_model, source, metered),
                         ("ollama", "127.0.0.1:11434", model, "main", 1))
        self.assertEqual((inp, out), (result.usage["input_tokens"], result.usage["output_tokens"]))
        print(f"\n    real Ollama /v1 {model}: {inp} input + {out} output tokens recorded",
              file=sys.stderr)


if __name__ == "__main__":
    unittest.main()
