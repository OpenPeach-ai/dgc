"""The usage meter's numbers (dgc/usage_limits.py, 0.52): how much of a plan's usage limits is used, as each connection
reports it, kept where every DGC process reads it.

- ChatGPT · your plan: the x-codex-* usage headers or a codex.rate_limits stream event when the API sends them, and
  the plan's own "limit used up" refusal (which says so, with Manage usage as its action).
- Codex: its session record's token_count events carry rate_limits; read after a delegated turn, never written.
- Claude Code: its rate_limit_event in stream-json.
- One file in DGC's home, so Work, ChatDGC and a Pip's runner (another process) see the same; `get_usage_limits`
  answers with `usage_limits`, a new event (never a field added to a released one).
"""
from __future__ import annotations

import contextlib
import json
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

PROJECT = Path(__file__).resolve().parents[1]
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))

from dgc import chatgpt_plan as plan  # noqa: E402
from dgc import usage_limits  # noqa: E402
from dgc.editor_protocol import COMMAND_FIELDS, EVENT_FIELDS, command_error, event_error  # noqa: E402

NOW = 1_795_000_000


class _Home(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.TemporaryDirectory(prefix="dgc-usage-limits-")
        self.addCleanup(self.home.cleanup)
        patch = mock.patch.dict(os.environ, {"DGC_HOME": self.home.name})
        patch.start()
        self.addCleanup(patch.stop)
        usage_limits._reset_for_tests()
        self.addCleanup(usage_limits._reset_for_tests)


class ParseTests(unittest.TestCase):
    def test_codex_headers_give_both_windows(self):
        headers = {"X-Codex-Primary-Used-Percent": "12.5", "x-codex-primary-window-minutes": "300",
                   "x-codex-primary-reset-at": str(NOW + 3600), "x-codex-secondary-used-percent": "81",
                   "x-codex-secondary-window-minutes": "10080", "x-codex-secondary-reset-at": str(NOW + 86400)}
        self.assertEqual(usage_limits.from_headers(headers), [
            {"id": "primary", "used_percent": 12.5, "window_minutes": 300, "resets_at": NOW + 3600},
            {"id": "secondary", "used_percent": 81.0, "window_minutes": 10080, "resets_at": NOW + 86400}])

    def test_no_headers_or_empty_ones_give_nothing(self):
        self.assertEqual(usage_limits.from_headers({}), [])
        self.assertEqual(usage_limits.from_headers({"x-codex-primary-used-percent": "0"}), [],
                         "Codex's own rule: a zero with no window and no reset is no data")
        self.assertEqual(usage_limits.from_headers({"x-codex-primary-used-percent": "nan"}), [])
        self.assertEqual(usage_limits.from_headers(None), [])

    def test_codex_rate_limits_from_its_session_record_and_its_stream_event(self):
        record = {"limit_id": "codex", "primary": {"used_percent": 40.0, "window_minutes": 300, "resets_at": NOW + 60},
                  "secondary": None, "plan_type": "plus"}
        self.assertEqual(usage_limits.from_rate_limits(record),
                         [{"id": "primary", "used_percent": 40.0, "window_minutes": 300, "resets_at": NOW + 60}])
        event = {"type": "codex.rate_limits", "rate_limits": {"primary": {"used_percent": 5, "window_minutes": 300, "reset_at": NOW + 5},
                                                              "secondary": {"used_percent": 99.5, "window_minutes": 10080, "reset_at": NOW + 9}}}
        self.assertEqual([w["resets_at"] for w in usage_limits.from_rate_limits(event["rate_limits"])], [NOW + 5, NOW + 9])
        self.assertEqual(usage_limits.from_rate_limits({"primary": {"used_percent": "x"}}), [])
        self.assertEqual(usage_limits.from_rate_limits("nope"), [])

    def test_used_percent_is_kept_between_0_and_100(self):
        self.assertEqual(usage_limits.window("primary", 140, 300, None)["used_percent"], 100.0)
        self.assertEqual(usage_limits.window("primary", -3, 300, None)["used_percent"], 0.0)
        self.assertIsNone(usage_limits.window("primary", True, 300, None))

    def test_claude_codes_rate_limit_event(self):
        info = {"status": "allowed_warning", "resetsAt": NOW + 100, "rateLimitType": "seven_day", "utilization": 0.98,
                "unifiedWindows": {"five_hour": {"utilization": 0.25, "resetsAt": NOW + 50},
                                   "seven_day": {"utilization": 0.98, "resetsAt": NOW + 100, "status": "allowed_warning"}}}
        self.assertEqual(usage_limits.from_claude(info), [
            {"id": "five_hour", "used_percent": 25.0, "window_minutes": 300, "resets_at": NOW + 50},
            {"id": "seven_day", "used_percent": 98.0, "window_minutes": 10080, "resets_at": NOW + 100}])
        # An older Claude Code: one window, by its type.
        self.assertEqual(usage_limits.from_claude({"status": "allowed", "rateLimitType": "five_hour", "utilization": 0.4, "resetsAt": NOW}),
                         [{"id": "five_hour", "used_percent": 40.0, "window_minutes": 300, "resets_at": NOW}])
        # Refused with no number: that window is used up.
        self.assertEqual(usage_limits.from_claude({"status": "rejected", "rateLimitType": "five_hour", "resetsAt": NOW})[0]["used_percent"], 100.0)
        self.assertEqual(usage_limits.from_claude({"status": "allowed"}), [])

    def test_reset_words(self):
        here = time.localtime(NOW)
        same_day = NOW + 60 if here.tm_hour < 23 else NOW + 10
        self.assertTrue(usage_limits.resets_words(same_day, now=NOW).startswith("at "))
        self.assertTrue(usage_limits.resets_words(NOW + 3 * 86400, now=NOW).startswith("on "))
        self.assertEqual(usage_limits.resets_words(None, now=NOW), "")
        self.assertEqual(usage_limits.resets_words(NOW - 5, now=NOW), "")


class StoreTests(_Home):
    def test_a_record_is_read_back_by_another_reader_and_sources_are_kept_apart(self):
        usage_limits.record("codex", [usage_limits.window("primary", 40, 300, NOW + 60)], now=NOW)
        usage_limits.record("claude", [usage_limits.window("seven_day", 98, 10080, NOW + 600)], now=NOW + 1)
        usage_limits._reset_for_tests()          # (what another process sees: the file only)
        shown = {row["source"]: row for row in usage_limits.snapshot(now=NOW + 2)}
        self.assertEqual(set(shown), {"codex", "claude"})
        self.assertEqual(shown["codex"]["windows"][0]["used_percent"], 40.0)
        self.assertFalse(shown["codex"]["limited"])
        self.assertEqual(shown["claude"]["at"], (NOW + 1) * 1000)
        self.assertTrue((Path(self.home.name) / ".dgc" / usage_limits.FILE_NAME).is_file())

    def test_a_reached_limit_is_kept_until_a_request_goes_through(self):
        usage_limits.record("chatgpt_plan", None, limited=True, now=NOW)
        row = usage_limits.snapshot(now=NOW)[0]
        self.assertEqual((row["source"], row["limited"], row["windows"]), ("chatgpt_plan", True, []))
        usage_limits.record("chatgpt_plan", None, limited=False, now=NOW + 5)
        self.assertEqual(usage_limits.snapshot(now=NOW + 5), [], "nothing left to show: no windows and no limit")

    def test_a_used_up_window_that_comes_back_under_its_limit_is_no_longer_reached(self):
        usage_limits.record("codex", [usage_limits.window("primary", 100, 300, NOW + 99)], now=NOW)
        self.assertTrue(usage_limits.snapshot(now=NOW)[0]["limited"])
        usage_limits.record("codex", [usage_limits.window("primary", 40, 300, NOW + 99)], now=NOW + 1)
        self.assertFalse(usage_limits.snapshot(now=NOW + 1)[0]["limited"])

    def test_a_window_past_its_reset_reads_as_reset(self):
        usage_limits.record("codex", [usage_limits.window("primary", 100, 300, NOW + 10)], now=NOW)
        later = usage_limits.snapshot(now=NOW + 11)[0]["windows"][0]
        self.assertEqual((later["used_percent"], later["resets_at"]), (0.0, None))

    def test_unknown_sources_and_bad_windows_are_refused(self):
        self.assertIsNone(usage_limits.record("openrouter", [usage_limits.window("primary", 1, 300, None)]))
        self.assertIsNone(usage_limits.record("codex", ["not a window"]))
        self.assertEqual(usage_limits.snapshot(), [])

    def test_a_damaged_file_reads_as_nothing(self):
        path = Path(self.home.name) / ".dgc" / usage_limits.FILE_NAME
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json")
        self.assertEqual(usage_limits.snapshot(), [])
        usage_limits.record("codex", [usage_limits.window("primary", 3, 300, None)], now=NOW)
        self.assertEqual(len(usage_limits.snapshot(now=NOW)), 1)

    def test_listeners_hear_each_change_once(self):
        heard = []
        stop = usage_limits.listen(lambda rows: heard.append(rows))
        self.addCleanup(stop)
        usage_limits.record("codex", [usage_limits.window("primary", 3, 300, NOW + 99)], now=NOW)
        usage_limits.record("codex", [usage_limits.window("primary", 3, 300, NOW + 99)], now=NOW + 1)   # (the same)
        usage_limits.record("codex", [usage_limits.window("primary", 4, 300, NOW + 99)], now=NOW + 2)
        self.assertEqual([rows[0]["windows"][0]["used_percent"] for rows in heard], [3.0, 4.0])
        stop()
        usage_limits.record("codex", [usage_limits.window("primary", 5, 300, NOW + 99)], now=NOW + 3)
        self.assertEqual(len(heard), 2)

    def test_codex_session_record_is_read_by_its_thread_id(self):
        codex_home = Path(self.home.name) / "codex"
        day = codex_home / "sessions" / "2026" / "11" / "19"
        day.mkdir(parents=True)
        thread = "01a1ce80-543a-7ae3-aa4e-e308ff167609"
        rollout = day / f"rollout-2026-11-19T12-14-39-{thread}.jsonl"
        lines = [{"type": "session_meta", "payload": {"id": thread}},
                 {"type": "event_msg", "payload": {"type": "token_count", "info": None, "rate_limits": {
                     "primary": {"used_percent": 10.0, "window_minutes": 300, "resets_at": NOW + 10}}}},
                 {"type": "event_msg", "payload": {"type": "token_count", "info": {}, "rate_limits": {
                     "primary": {"used_percent": 22.0, "window_minutes": 300, "resets_at": NOW + 20},
                     "secondary": {"used_percent": 7.0, "window_minutes": 10080, "resets_at": NOW + 30}}}},
                 {"type": "event_msg", "payload": {"type": "agent_message", "message": "done"}}]
        rollout.write_text("\n".join(json.dumps(line) for line in lines) + "\n")
        before = rollout.stat().st_mtime_ns
        found = usage_limits.codex_session_limits(thread, codex_home=codex_home)
        self.assertEqual([w["used_percent"] for w in found], [22.0, 7.0])
        self.assertEqual(rollout.stat().st_mtime_ns, before, "Codex's own record is only read")
        self.assertEqual(usage_limits.codex_session_limits("not-a-thread", codex_home=codex_home), [])
        self.assertEqual(usage_limits.codex_session_limits("../../etc", codex_home=codex_home), [])
        self.assertEqual(usage_limits.codex_session_limits(thread, codex_home=Path(self.home.name) / "none"), [])


class EnginesTests(_Home):
    def test_claude_codes_rate_limit_event_becomes_a_limits_event(self):
        from dgc.subscriptions import _events_claude
        out = _events_claude({"type": "rate_limit_event", "rate_limit_info": {
            "status": "allowed", "rateLimitType": "five_hour", "utilization": 0.5, "resetsAt": NOW}})
        self.assertEqual(out, [{"kind": "limits", "source": "claude", "limited": False,
                                "windows": [{"id": "five_hour", "used_percent": 50.0, "window_minutes": 300, "resets_at": NOW}]}])
        self.assertTrue(_events_claude({"type": "rate_limit_event", "rate_limit_info": {
            "status": "rejected", "rateLimitType": "five_hour", "resetsAt": NOW}})[0]["limited"])
        self.assertEqual(_events_claude({"type": "rate_limit_event", "rate_limit_info": "bad"}), [])

    def test_a_delegated_turn_keeps_what_its_engine_reported(self):
        from dgc import subscriptions
        reported = {"kind": "limits", "source": "claude", "limited": False,
                    "windows": [{"id": "five_hour", "used_percent": 50.0, "window_minutes": 300, "resets_at": NOW + 99}]}
        subscriptions._keep_limits(reported)
        self.assertEqual(usage_limits.snapshot(now=NOW)[0]["windows"][0]["used_percent"], 50.0)
        # (The limits event is DGC's own: it is kept, not shown.)
        self.assertFalse(subscriptions._shown_kind("limits"))
        self.assertTrue(subscriptions._shown_kind("text"))
        # A Codex turn's numbers come from its session record, found by the thread it named.
        with mock.patch.object(usage_limits, "codex_session_limits", return_value=[
                {"id": "primary", "used_percent": 9.0, "window_minutes": 300, "resets_at": NOW + 99}]) as read:
            subscriptions._keep_codex_limits("thread-1", {"CODEX_HOME": "/somewhere"})
        read.assert_called_once()
        self.assertEqual(read.call_args.kwargs["codex_home"], Path("/somewhere"))
        self.assertEqual({r["source"] for r in usage_limits.snapshot(now=NOW)}, {"claude", "codex"})


def sse(obj) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode()


class PlanRouteTests(_Home):
    """The plan's requests keep what they say about its usage: windows when the API sends them, and its used-up limit."""

    def setUp(self):
        super().setUp()
        import http.server
        self.answer = "ok"
        self.headers = {}
        stand = self

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *args):
                pass

            def do_POST(self):
                try:
                    self.answer()
                except (BrokenPipeError, ConnectionResetError):
                    pass                        # (the client stops reading at the plan's refusal)

            def answer(self):
                self.rfile.read(int(self.headers.get("Content-Length") or 0))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                for name, value in stand.headers.items():
                    self.send_header(name, value)
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()

                def chunk(data: bytes):
                    self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                    self.wfile.flush()
                chunk(sse({"type": "response.created", "response": {"id": "r1", "status": "in_progress"}}))
                if stand.answer == "limit":
                    # As the plan answered on 19 Nov: HTTP 200, then an error event, then response.failed.
                    error = {"type": "invalid_request_error", "code": "subscription_sharing_usage_limit_exceeded",
                             "message": "The ChatGPT user has reached their Subscription Sharing usage limit."}
                    chunk(sse({"type": "error", "sequence_number": 3, "error": error}))
                    chunk(sse({"type": "response.failed", "response": {"id": "r1", "status": "failed", "error": error}}))
                else:
                    if stand.answer == "event":
                        chunk(sse({"type": "codex.rate_limits", "rate_limits": {
                            "primary": {"used_percent": 33, "window_minutes": 300, "reset_at": int(time.time()) + 600}}}))
                    chunk(sse({"type": "response.output_text.delta", "item_id": "i", "output_index": 0, "content_index": 0, "delta": "Hi"}))
                    chunk(sse({"type": "response.completed", "response": {"id": "r1", "status": "completed", "usage": {},
                               "output": [{"type": "message", "id": "i", "role": "assistant",
                                           "content": [{"type": "output_text", "text": "Hi"}]}]}}))
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        token = mock.patch.object(plan, "access_token", return_value="live-access-token")
        token.start()
        self.addCleanup(token.stop)

    def client(self, key=plan.PLAN_KEY):
        from dgc.llm import LLMClient
        base = f"http://127.0.0.1:{self.server.server_address[1]}/v1"
        return LLMClient(base, key, "gpt-6-luna", api_mode="responses")

    def test_usage_headers_on_the_plan_route_are_kept(self):
        self.headers = {"x-codex-primary-used-percent": "61", "x-codex-primary-window-minutes": "300",
                        "x-codex-primary-reset-at": str(int(time.time()) + 3600)}
        self.client().chat([{"role": "user", "content": "hi"}])
        row = usage_limits.snapshot()[0]
        self.assertEqual((row["source"], row["windows"][0]["used_percent"], row["limited"]), ("chatgpt_plan", 61.0, False))

    def test_a_rate_limits_event_in_the_stream_is_kept(self):
        self.answer = "event"
        self.client().chat([{"role": "user", "content": "hi"}])
        self.assertEqual(usage_limits.snapshot()[0]["windows"][0]["used_percent"], 33.0)

    def test_the_used_up_limit_is_kept_and_its_error_offers_manage_usage(self):
        from dgc.llm import LLMError
        self.answer = "limit"
        with self.assertRaises(LLMError) as caught:
            self.client().chat([{"role": "user", "content": "hi"}])
        self.assertIn("chatgpt.com/settings/usage", str(caught.exception))
        cause = caught.exception.cause.as_dict()
        self.assertEqual((cause["kind"], cause["action"]), ("rate_limited", "manage_usage"))
        self.assertTrue(usage_limits.snapshot()[0]["limited"])
        # The next request that goes through clears it.
        self.answer = "ok"
        self.client().chat([{"role": "user", "content": "hi"}])
        self.assertEqual(usage_limits.snapshot(), [])

    def test_the_error_says_when_it_resets_when_that_is_known(self):
        from dgc.llm import LLMError
        reset = int(time.time()) + 2 * 3600
        self.headers = {"x-codex-primary-used-percent": "100", "x-codex-primary-window-minutes": "300",
                        "x-codex-primary-reset-at": str(reset)}
        self.answer = "limit"
        with self.assertRaises(LLMError) as caught:
            self.client().chat([{"role": "user", "content": "hi"}])
        self.assertIn("It resets " + usage_limits.resets_words(reset), str(caught.exception))
        self.assertEqual(caught.exception.cause.as_dict()["resets_at"], reset)

    def test_an_ordinary_key_keeps_nothing(self):
        self.headers = {"x-codex-primary-used-percent": "61", "x-codex-primary-window-minutes": "300"}
        self.client(key="sk-ordinary").chat([{"role": "user", "content": "hi"}])
        self.assertEqual(usage_limits.snapshot(), [])


class ProtocolTests(unittest.TestCase):
    def test_a_new_event_and_command_never_a_new_field_on_a_released_event(self):
        self.assertEqual(set(EVENT_FIELDS["usage_limits"]), {"request_id", "limits", "route"})
        self.assertIsNone(command_error({"type": "get_usage_limits", "request_id": "u1"}))
        self.assertIsNotNone(command_error({"type": "get_usage_limits"}))
        self.assertIsNone(event_error({"type": "usage_limits", "seq": 1, "request_id": "u1", "route": "chatgpt_plan",
                                       "limits": [{"source": "codex", "windows": [], "at": 1, "limited": False}]}))
        self.assertIn("get_usage_limits", COMMAND_FIELDS)

    def test_a_cause_carries_the_action_and_the_reset(self):
        from dgc.headless import HeadlessUI
        from dgc.model_errors import FailureCause
        cause = FailureCause(kind="rate_limited", summary="limit", action="manage_usage", resets_at=NOW, retryable=False).as_dict()
        self.assertEqual((cause["action"], cause["resets_at"]), ("manage_usage", NOW))
        self.assertNotIn("action", FailureCause(kind="http", summary="x").as_dict())
        clamped = HeadlessUI._clamped_cause({**cause, "action": "manage_usage"})
        self.assertEqual((clamped["action"], clamped["resets_at"]), ("manage_usage", NOW))
        self.assertNotIn("action", HeadlessUI._clamped_cause({**cause, "action": "rm -rf"}))


class ServeRoundTripTests(unittest.TestCase):
    """A real `dgc serve`: get_usage_limits reads the shared file (a Pip's runner may have written it), the route says
    which source this backend's own model draws on, and a record in this process is said at once."""

    def test_get_usage_limits_over_stdio(self):
        home = tempfile.TemporaryDirectory(prefix="dgc-usage-limits-serve-")
        work = tempfile.TemporaryDirectory(prefix="dgc-usage-limits-work-")
        self.addCleanup(home.cleanup)
        self.addCleanup(work.cleanup)
        dot = Path(home.name) / ".dgc"
        dot.mkdir()
        # (A key written into config.json by hand moves to secrets.json, bound to its address, on the first load.)
        (dot / "config.json").write_text(json.dumps({"base_url": "https://api.openai.com/v1", "model": "gpt-6-luna",
                                                      "api_mode": "responses", "api_key": plan.PLAN_KEY,
                                                      "suggest": False, "notes": False}))
        future = int(time.time()) + 3600
        (dot / usage_limits.FILE_NAME).write_text(json.dumps({"version": 1, "sources": {"codex": {
            "windows": [{"id": "primary", "used_percent": 12.0, "window_minutes": 300, "resets_at": future}],
            "at": int(time.time() * 1000), "limited": False}}}))
        env = dict(os.environ, HOME=home.name, PYTHONPATH=str(PROJECT), PYTHONDONTWRITEBYTECODE="1")
        env.pop("DGC_HOME", None)
        proc = subprocess.Popen([sys.executable, "-m", "dgc", "serve"], cwd=work.name, env=env,
                                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        events: "queue.Queue[dict]" = queue.Queue()
        threading.Thread(target=lambda: [events.put(json.loads(line)) for line in proc.stdout if line.strip()],
                         daemon=True).start()

        def cleanup():
            if proc.poll() is None:
                with contextlib.suppress(OSError):
                    proc.stdin.close()
                try:
                    proc.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)
            for pipe in (proc.stdin, proc.stdout):
                with contextlib.suppress(OSError, ValueError):
                    pipe.close()
        self.addCleanup(cleanup)

        def wait(predicate, timeout=90):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                try:
                    event = events.get(timeout=max(0.01, deadline - time.monotonic()))
                except queue.Empty:
                    break
                self.assertIsNone(event_error(event), event)
                if predicate(event):
                    return event
            self.fail("no matching event")

        ready = wait(lambda e: e["type"] == "ready")
        self.assertEqual(ready["capabilities"].get("usage_limits"), 1)
        proc.stdin.write(json.dumps({"type": "get_usage_limits", "request_id": "u1"}) + "\n")
        proc.stdin.flush()
        said = wait(lambda e: e["type"] == "usage_limits" and e.get("request_id") == "u1")
        self.assertEqual(said["route"], "chatgpt_plan")
        self.assertEqual([(row["source"], row["windows"][0]["used_percent"]) for row in said["limits"]], [("codex", 12.0)])
        self.assertIsNone(proc.poll())


if __name__ == "__main__":
    unittest.main()


class PipRunTokenTests(_Home):
    """A Pip run's worker has a home of its own with no sign-in in it: the runner (DGC's own home) hands it a live token
    for the run, valid long enough, in its private input; the worker holds it in memory and redacts it."""

    def setUp(self):
        super().setUp()
        plan._HELD.clear()
        self.addCleanup(plan._HELD.clear)

    def test_the_runner_hands_a_token_valid_for_the_run_and_refreshes_first_when_less_is_left(self):
        from dgc import plugin_credentials as store
        store.configure("file")
        self.addCleanup(store.configure, "auto")
        store.save(plan.TOKENS, {"access_token": "old-token", "refresh_token": "r1", "scopes": [plan.PLAN_SCOPE],
                                 "expires_at": time.time() + 600, "sub": "u", "client_id": "c", "issuer": plan.ISSUER})
        with mock.patch.object(plan, "discover", return_value={"token_endpoint": "https://auth.example/token"}), \
             mock.patch.object(plan, "_form", return_value=(200, {"access_token": "new-token", "refresh_token": "r2", "expires_in": 3600})) as form:
            held = plan.for_run(1800)
        self.assertEqual(held["token"], "new-token", "ten minutes left is too little for a run: refreshed first")
        self.assertGreater(held["expires_at"], time.time() + 1800)
        form.assert_called_once()
        with mock.patch.object(plan, "_form") as again:
            self.assertEqual(plan.for_run(1800)["token"], "new-token")
        again.assert_not_called()

    def test_the_worker_holds_the_token_it_was_handed(self):
        with self.assertRaises(plan.PlanError):
            plan.access_token()
        plan.hold("run-token", time.time() + 3600)
        self.assertEqual(plan.access_token(), "run-token")
        plan.hold("run-token", time.time() - 1)
        with self.assertRaises(plan.PlanError) as caught:
            plan.access_token()
        self.assertEqual(caught.exception.code, "signed_out")

    def test_a_plan_run_payload_carries_the_token_and_another_carries_none(self):
        from dgc import pips
        with mock.patch.object(plan, "for_run", return_value={"token": "run-token", "expires_at": 9e9}):
            self.assertEqual(pips._plan_token_for({"api_key": plan.PLAN_KEY}), {"token": "run-token", "expires_at": 9e9})
            self.assertEqual(pips._plan_token_for({"api_key": "sk-x", "backup": {"api_key": plan.PLAN_KEY}})["token"], "run-token")
            self.assertIsNone(pips._plan_token_for({"api_key": "sk-x"}))
        with mock.patch.object(plan, "for_run", side_effect=plan.PlanError("not_connected", "no")):
            self.assertIsNone(pips._plan_token_for({"api_key": plan.PLAN_KEY}), "signed out: the worker says so itself")


class PipRunLimitsTests(_Home):
    def test_what_a_runs_worker_reported_is_kept_in_dgcs_home(self):
        from dgc import pips
        pips._keep_run_limits([{"source": "chatgpt_plan", "windows": [], "limited": True, "at": 1},
                               {"source": "nope", "windows": [], "limited": True}, "junk"])
        rows = usage_limits.snapshot()
        self.assertEqual([(r["source"], r["limited"]) for r in rows], [("chatgpt_plan", True)])
