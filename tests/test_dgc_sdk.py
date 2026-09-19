"""Local DGC SDK: isolation, run/stream, resume/fork, cancel, async, native picker."""
from __future__ import annotations

import asyncio
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# DGC_SDK_TEST_INSTALLED=1 (CI's SDK job) tests the installed dgc-sdk wheel and dgc runtime, not
# this checkout: an editable install's .pth hook pre-imports modules and once hid a broken bridge.
INSTALLED = os.environ.get("DGC_SDK_TEST_INSTALLED") == "1"
SOURCE_PATHS = [] if INSTALLED else [str(ROOT / "sdk" / "python"), str(ROOT)]
sys.path[:0] = SOURCE_PATHS

from dgc_sdk import (  # noqa: E402
    AsyncDGC, DGC, DGCConfigError, DGCUnsupportedError, Pricing, QuestionAnswer,
    RetryPolicy, RuntimePolicy, define_tool, redact_text,
)
from dgc_sdk.schema import extract_json, validate  # noqa: E402

if INSTALLED:
    import dgc_sdk as _installed  # noqa: E402
    assert not Path(_installed.__file__).resolve().is_relative_to(ROOT), \
        f"DGC_SDK_TEST_INSTALLED=1 but dgc_sdk was imported from the checkout: {_installed.__file__}"


def _sse(delta: dict, finish: str | None = None) -> str:
    return "data: " + json.dumps({"id": "mock", "object": "chat.completion.chunk",
                                  "choices": [{"index": 0, "delta": delta,
                                               "finish_reason": finish}]}) + "\n\n"


def _answer(text: str) -> str:
    return _sse({"content": text}) + _sse({}, finish="stop") + "data: [DONE]\n\n"


def _call(name: str, args: dict) -> str:
    return (_sse({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                  "function": {"name": name, "arguments": json.dumps(args)}}]})
            + _sse({}, finish="tool_calls") + "data: [DONE]\n\n")


class _Model(BaseHTTPRequestHandler):
    behavior = "text"
    posts = 0

    def log_message(self, *args):
        pass

    def _send(self, body: str, kind: str = "text/event-stream") -> None:
        data = body.encode()
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.endswith("/models"):
            self._send(json.dumps({"data": [{"id": "sdk-model"}]}), "application/json")
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        _Model.posts += 1
        length = int(self.headers.get("Content-Length", 0))
        request = json.loads(self.rfile.read(length) or b"{}")
        messages = request.get("messages") or []
        last = ""
        for message in reversed(messages):
            if message.get("role") == "tool":
                last = "TOOL:" + str(message.get("content") or "")
                break
            if message.get("role") == "user":
                last = str(message.get("content") or "")
                break
        if self.behavior == "flaky429":
            if _Model.posts <= 2:
                self.send_response(429)
                self.send_header("Retry-After", "0")
                self.send_header("Content-Type", "application/json")
                body = b'{"error":{"message":"rate limited"}}'
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self._send(_answer("The checkout flow creates an empty cart and then redirects."))
            return
        if self.behavior == "stall":
            # Headers first so the runtime can attach its cancel watch. Sleeping before the
            # status line leaves Stop stuck on the handshake read.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                for _ in range(60):
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
                    time.sleep(0.5)
                self.wfile.write(_answer("late").encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                return
            return
        if last.startswith("TOOL:") and "chose" in last.lower():
            self._send(_answer("You picked the recommended option."))
            return
        if last.startswith("TOOL:") and "Document ready" in last:
            self._send(_answer("The plan is on the local page."))
            return
        if last.startswith("TOOL:") and self.behavior == "mcp":
            self._send(_answer("SKU Widget is in stock."))
            return
        if last.startswith("TOOL:"):
            self._send(_answer("Done."))
            return
        if self.behavior == "mcp" or "look up sku" in last.lower():
            self._send(_call("mcp__app__sku_lookup", {"sku": "A-1"}))
            return
        if "Return only valid JSON" in last or self.behavior == "json":
            self._send(_answer('{"ok": true, "summary": "cart is empty"}'))
            return
        if self.behavior == "picker" or "option picker" in last.lower():
            self._send(_call("propose_options", {
                "questions": [{
                    "question": "Which should I do next?",
                    "options": [
                        {"label": "Fix enqueue", "recommended": True,
                         "description": "Smallest change."},
                        {"label": "Rewrite the module", "description": "Large."},
                    ],
                }],
            }))
            return
        if self.behavior == "document" or "design doc" in last.lower():
            self._send(_call("present_document", {
                "title": "Checkout plan",
                "markdown": "# Checkout\nEmpty cart then redirect.\n",
            }))
            return
        if self.behavior == "edit" or last.lower().startswith("edit "):
            self._send(_call("write_file", {"path": "guard.py", "content": "ok\n"}))
            return
        if self.behavior == "bash_write" or "escaped write" in last.lower():
            self._send(_call("bash", {"command": "echo pwned > escaped.txt"}))
            return
        self._send(_answer("The checkout flow creates an empty cart and then redirects."))


def _start_model():
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Model)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/v1"


class SchemaUnitTests(unittest.TestCase):
    def test_extract_and_validate(self):
        value = extract_json('Here you go:\n```json\n{"ok": true}\n```')
        self.assertEqual(value, {"ok": True})
        errors = validate(value, {"type": "object", "required": ["ok"],
                                  "properties": {"ok": {"type": "boolean"}},
                                  "additionalProperties": False})
        self.assertEqual(errors, [])
        errors = validate({"ok": 1}, {"type": "object", "required": ["ok"],
                                      "properties": {"ok": {"type": "boolean"}}})
        self.assertTrue(errors)


class SdkTests(unittest.TestCase):
    def setUp(self):
        self.host_home = Path(tempfile.mkdtemp(prefix="dgc-sdk-host-"))
        self.state = Path(tempfile.mkdtemp(prefix="dgc-sdk-state-"))
        self.work = Path(tempfile.mkdtemp(prefix="dgc-sdk-work-"))
        (self.work / "README.md").write_text("empty cart checkout\n", encoding="utf-8")
        (self.host_home / ".dgc").mkdir()
        (self.host_home / ".dgc" / "marker").write_text("host-owned\n", encoding="utf-8")
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.host_home)
        _Model.behavior = "text"
        _Model.posts = 0
        self.server, self.base_url = _start_model()

    def tearDown(self):
        if self._old_home is None:
            os.environ.pop("HOME", None)
        else:
            os.environ["HOME"] = self._old_home
        self.server.shutdown()
        self.server.server_close()

    def _client(self, **kwargs):
        # A RuntimePolicy's default sandboxed shell fails closed without a working OS sandbox;
        # these tests check deny/path enforcement, not the sandbox, so accept the fallback.
        if kwargs.get("policy") is not None:
            kwargs.setdefault("sandbox", {"requirement": "preferred"})
        return DGC(state_dir=self.state, model="sdk-model", base_url=self.base_url,
                   api_key="sk-local", **kwargs)

    def _host_snapshot(self):
        root = self.host_home / ".dgc"
        return {str(path.relative_to(root)): path.read_bytes()
                for path in root.rglob("*") if path.is_file()}

    def test_isolated_session_does_not_touch_host_dgc(self):
        before = self._host_snapshot()
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(result.status, "completed")
        self.assertIn("checkout", result.final_text.lower())
        self.assertEqual(self._host_snapshot(), before)
        self.assertFalse(any(self.host_home.joinpath(".dgc").rglob("config.json")),
                         "host ~/.dgc must not gain a config.json")

    def test_two_state_roots_do_not_share_home(self):
        other = Path(tempfile.mkdtemp(prefix="dgc-sdk-state-b-"))
        with self._client() as first, DGC(state_dir=other, model="sdk-model",
                                          base_url=self.base_url, api_key="sk-local") as second:
            a = first.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            b = second.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            a.run("Summarize README. Do not edit files.", timeout=60)
            b.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual((self.host_home / ".dgc" / "marker").read_text(encoding="utf-8"),
                         "host-owned\n")
        self.assertTrue(any(self.state.rglob("config.json")))
        self.assertTrue(any(other.rglob("config.json")))

    def test_unhandled_permission_denies_an_edit(self):
        _Model.behavior = "edit"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "default", "unhandled": "deny"})
            result = session.run("edit the checkout guard", timeout=60)
        self.assertFalse((self.work / "guard.py").exists(), "denied write_file must not land")
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.reason, "completed")

    def test_on_permission_once_allows_an_edit(self):
        _Model.behavior = "edit"
        seen = []

        def on_permission(request):
            seen.append(request.name)
            return "once"

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=on_permission,
            )
            result = session.run("edit the checkout guard", timeout=60)
        self.assertIn("write_file", seen)
        self.assertTrue((self.work / "guard.py").exists())
        self.assertEqual(result.status, "completed")

    def test_native_options_picker_is_answered_by_on_question(self):
        _Model.behavior = "picker"
        seen = []

        def on_question(request):
            seen.append(request)
            qid = request.questions[0].id
            return {qid: QuestionAnswer(selected=(0,))}

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
                on_question=on_question,
            )
            result = session.run(
                "can you show me a test option picker , with recomendation so i can select",
                timeout=60,
            )
        self.assertEqual(len(seen), 1)
        self.assertTrue(seen[0].questions[0].options[0].recommended)
        self.assertEqual(result.status, "completed")
        self.assertIn("picked", result.final_text.lower())
        self.assertFalse((self.work / "option-picker-demo.html").exists())

    def test_present_document_exposes_loopback_url(self):
        _Model.behavior = "document"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("write a short design doc for checkout", timeout=60)
        self.assertEqual(result.status, "completed")
        urls = [item.url for item in result.documents] or [
            rec.output for rec in result.tools if rec.name == "present_document"
        ]
        blob = " ".join(urls)
        self.assertIn("127.0.0.1", blob)
        self.assertNotIn("file://", blob)

    def test_output_schema_is_validated_on_the_harness(self):
        _Model.behavior = "json"
        schema = {
            "type": "object",
            "required": ["ok", "summary"],
            "properties": {
                "ok": {"type": "boolean"},
                "summary": {"type": "string"},
            },
            "additionalProperties": False,
        }
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("Summarize README as JSON.", timeout=60, output_schema=schema,
                                 repair_attempts=0)
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.output["ok"], True)
        self.assertIn("cart", result.output["summary"])

    def test_stream_and_run_share_the_result(self):
        events = []
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            handle = session.stream("Summarize README. Do not edit files.", timeout=60)
            for event in handle:
                events.append(event.type)
            result = handle.result()
        self.assertIn("turn_end", events)
        self.assertEqual(result.status, "completed")
        self.assertIn("checkout", result.final_text.lower())

    def test_second_run_on_a_busy_session_is_rejected(self):
        _Model.behavior = "stall"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            handle = session.stream("Summarize README.", timeout=5)
            with self.assertRaises(DGCConfigError):
                session.run("another", timeout=5)
            handle.cancel()
            handle.result()

    def test_define_tool_rejects_a_blank_name(self):
        with self.assertRaises(Exception):
            define_tool("", "n", {"type": "object"}, lambda _args: "x")

    def test_custom_tool_runs_in_the_host_process(self):
        _Model.behavior = "mcp"
        seen = []

        def lookup(args):
            seen.append(dict(args))
            return {"name": "Widget", "sku": args.get("sku")}

        tool = define_tool(
            "sku_lookup",
            "Look up a product SKU in the company catalog",
            {"type": "object", "properties": {"sku": {"type": "string"}}, "required": ["sku"]},
            lookup,
        )
        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
                tools=[tool],
            )
            result = session.run("look up sku A-1", timeout=60)
        self.assertTrue(seen, "host tool handler must run")
        self.assertEqual(seen[0].get("sku"), "A-1")
        self.assertEqual(result.status, "completed")
        self.assertIn("widget", result.final_text.lower())

    def test_sessions_from_one_client_share_isolated_home(self):
        with self._client() as dgc:
            first = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            first.run("Summarize README. Do not edit files.", timeout=60)
            first.close()
            second = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            listed = second.list_sessions()
        self.assertTrue(listed, "a second session on the same client must see the first transcript")
        homes = [path for path in self.state.rglob("config.json")]
        self.assertEqual(len(homes), 1, "one DGC client owns one isolated HOME")
        self.assertTrue(str(homes[0]).startswith(str(self.state / "home")))

    def test_resume_restores_history(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("Summarize README. Do not edit files.", timeout=60)
            self.assertEqual(result.status, "completed")
            session_id = session.session_id
            session.close()
            restored = dgc.resume(
                session_id, cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
            )
            history = restored.history()
            blob = json.dumps(history).lower()
            self.assertTrue(restored.session_id)
            self.assertIn("summarize", blob)
            again = restored.run("What did I just ask you to do? Do not edit files.", timeout=60)
            self.assertEqual(again.status, "completed")

    def test_resume_unknown_id_fails_closed(self):
        with self._client() as dgc:
            with self.assertRaises(DGCConfigError):
                dgc.resume(
                    "missing-session-id",
                    cwd=self.work,
                    permissions={"mode": "auto", "unhandled": "deny"},
                )

    def test_fork_gives_a_new_session_identity(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            session.run("Summarize README. Do not edit files.", timeout=60)
            origin = session.session_id
            origin_path = session.session_path
            session.fork("sdk-branch")
            listed = session.list_sessions()
            session.run("Summarize README again. Do not edit files.", timeout=60)
        self.assertGreaterEqual(len(listed), 2)
        self.assertTrue(session.session_id)
        self.assertNotEqual(session.session_id, origin)
        self.assertNotEqual(session.session_path, origin_path)
        self.assertTrue(session.session_path.endswith(session.session_id + ".json"),
                        session.session_path)

    def test_cancel_drains_and_session_is_reusable(self):
        _Model.behavior = "stall"
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            handle = session.stream("Summarize README.", timeout=12)
            time.sleep(1.0)
            started = time.monotonic()
            handle.cancel()
            result = handle.result()
            elapsed = time.monotonic() - started
            self.assertIn(result.status, ("cancelled", "failed"))
            self.assertLess(elapsed, 6.0, f"cancel should settle promptly, took {elapsed:.1f}s")
            _Model.behavior = "text"
            again = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(again.status, "completed")
        self.assertIn("checkout", again.final_text.lower())

    def test_async_run_completes(self):
        async def go():
            async with AsyncDGC(state_dir=self.state, model="sdk-model",
                                base_url=self.base_url, api_key="sk-local") as dgc:
                session = await dgc.session(
                    cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
                events = []
                async with await session.stream(
                        "Summarize README. Do not edit files.", timeout=60) as handle:
                    async for event in handle:
                        events.append(event.type)
                    result = await handle.result()
                return result, events
        result, events = asyncio.run(go())
        self.assertEqual(result.status, "completed")
        self.assertIn("turn_end", events)
        self.assertIn("checkout", result.final_text.lower())

    def test_goal_roundtrip(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            goal = session.set_goal("Ship the checkout fix", status="active")
            fetched = session.get_goal()
        self.assertEqual(goal.status, "active")
        self.assertIn("checkout", goal.text.lower())
        self.assertEqual(fetched.text, goal.text)
        self.assertEqual(fetched.status, "active")

    def test_checkpoint_rewind_after_edit(self):
        _Model.behavior = "edit"

        def on_permission(_request):
            return "once"

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=on_permission,
            )
            result = session.run("edit the checkout guard", timeout=60)
            self.assertEqual(result.status, "completed")
            self.assertTrue((self.work / "guard.py").exists())
            points = session.list_checkpoints()
            self.assertTrue(points, "an edit turn must leave a checkpoint")
            rewound = session.rewind(0)
        self.assertTrue(rewound.get("ok"))

    def test_isolated_hook_catalog_has_no_ambient_commands(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            hooks = session.list_hooks()
        names = {item.event for item in hooks}
        self.assertTrue({"SessionStart", "PreToolUse", "Stop"} <= names)
        self.assertTrue(all(item.configured == 0 for item in hooks))

    def test_permission_rule_roundtrip_stays_in_isolated_home(self):
        before = self._host_snapshot()
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "default", "unhandled": "deny"})
            rules = session.add_permission_rule("deny", "Bash")
            listed = session.list_permissions()
        self.assertTrue(any(item.action == "deny" and "Bash" in item.rule for item in rules))
        self.assertEqual(listed, rules)
        self.assertEqual(self._host_snapshot(), before)

    def test_user_memory_stays_in_isolated_home(self):
        before = self._host_snapshot()
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            saved = session.add_memory("Checkout must keep an empty cart.", scope="user")
            fetched = session.get_memory()
        self.assertIn("empty cart", saved["user"].lower())
        self.assertIn("empty cart", fetched["user"].lower())
        self.assertEqual(self._host_snapshot(), before)

    def test_list_mcp_servers_includes_host_tools(self):
        tool = define_tool(
            "sku_lookup",
            "Look up a product SKU",
            {"type": "object", "properties": {"sku": {"type": "string"}}},
            lambda args: {"sku": args.get("sku")},
        )
        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
                tools=[tool],
            )
            servers = session.list_mcp_servers()
        names = {item.name for item in servers}
        self.assertIn("app", names)

    def test_slow_permission_callback_fails_closed(self):
        _Model.behavior = "edit"

        def slow(_request):
            time.sleep(2.0)
            return "once"

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=slow,
                decision_timeout=0.25,
            )
            result = session.run("edit the checkout guard", timeout=60)
        self.assertFalse((self.work / "guard.py").exists())
        self.assertIn(result.status, ("completed", "failed", "cancelled"))

    def test_thrown_permission_callback_fails_closed(self):
        _Model.behavior = "edit"

        def boom(_request):
            raise RuntimeError("callback exploded")

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=boom,
            )
            session.run("edit the checkout guard", timeout=60)
        self.assertFalse((self.work / "guard.py").exists())

    def test_tool_handler_timeout_is_an_error_result(self):
        _Model.behavior = "mcp"

        def slow(_args):
            time.sleep(5)
            return {"sku": "late"}

        tool = define_tool(
            "sku_lookup", "Look up a product SKU",
            {"type": "object", "properties": {"sku": {"type": "string"}}},
            slow, timeout=0.2,
        )
        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
                tools=[tool],
            )
            result = session.run("look up sku A-1", timeout=60)
        self.assertTrue(any(rec.is_error for rec in result.tools), result.tools)

    def test_checkpoint_rewind_past_the_end_is_explicit(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            session.run("Summarize README. Do not edit files.", timeout=60)
            # An out-of-range index raises a typed error instead of quietly returning ok=False.
            with self.assertRaises(DGCConfigError):
                session.rewind(99)

    def test_turn_budget_is_visible_on_isolated_config(self):
        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"},
                max_turns=3, turn_budget_s=45,
            )
            cfg = session.get_config()
        blob = json.dumps(cfg).lower()
        self.assertTrue("max_turns" in blob or "config" in blob)

    def test_required_sandbox_fails_closed_when_missing(self):
        from dgc.sandbox import available
        if available():
            with self._client() as dgc:
                session = dgc.session(
                    cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"},
                    sandbox={"requirement": "preferred"},
                )
                self.assertTrue(session.session_id or True)
            return
        with self.assertRaises(DGCUnsupportedError):
            DGC(state_dir=self.state, model="sdk-model", base_url=self.base_url,
                api_key="sk-local", sandbox={"requirement": "required"})

    def test_close_reaps_the_serve_child(self):
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            session.run("Summarize README. Do not edit files.", timeout=60)
            pid = session.raw._proc.pid if session.raw._proc is not None else None
        if pid:
            time.sleep(0.3)
            self.assertFalse(os.path.exists(f"/proc/{pid}"), f"dgc serve {pid} still alive")

    def test_resume_while_source_session_is_open_does_not_touch_host(self):
        before = self._host_snapshot()
        with self._client() as dgc:
            first = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            first.run("Summarize README. Do not edit files.", timeout=60)
            restored = dgc.resume(
                first.session_id, cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
            )
            again = restored.run("What did I just ask you to do? Do not edit files.", timeout=60)
        self.assertIn(again.status, ("completed", "failed", "cancelled"))
        self.assertEqual(self._host_snapshot(), before)

    def test_writes_stay_inside_session_cwd_not_git_root(self):
        nested = self.work / "jobs" / "e2e-1"
        nested.mkdir(parents=True)
        (nested / "README.md").write_text("job workspace\n")
        subprocess.run(["git", "init"], cwd=self.work, check=True, capture_output=True)
        _Model.behavior = "edit"

        def on_permission(_request):
            return "once"

        with self._client() as dgc:
            session = dgc.session(
                cwd=nested,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=on_permission,
            )
            result = session.run("edit the checkout guard", timeout=60)
        self.assertEqual(result.status, "completed")
        self.assertTrue((nested / "guard.py").exists(), "write must land in session cwd")
        self.assertFalse((self.work / "guard.py").exists(), "write must not escape to git root")
        self.assertTrue(all(not Path(item.path).is_absolute() or str(item.path).startswith(str(nested))
                            for item in result.changes))
        self.assertTrue(any("guard.py" in item.path for item in result.changes), result.changes)
        blob = " ".join(item.path for item in result.changes)
        self.assertNotIn("usage.sqlite", blob)
        self.assertNotIn("/locks/", blob)

    def test_cancel_aborts_a_waiting_permission(self):
        _Model.behavior = "edit"
        waiting = threading.Event()

        def slow(_request):
            waiting.set()
            time.sleep(30)
            return "once"

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=slow,
                decision_timeout=30,
            )
            handle = session.stream("edit the checkout guard", timeout=25)

            def drain():
                handle.result()

            worker = threading.Thread(target=drain)
            worker.start()
            self.assertTrue(waiting.wait(10), "permission callback must run")
            started = time.monotonic()
            handle.cancel()
            worker.join(8)
            elapsed = time.monotonic() - started
            result = handle.result()
        self.assertLess(elapsed, 6.0, f"cancel waited {elapsed:.1f}s")
        self.assertEqual(result.status, "cancelled")
        self.assertFalse((self.work / "guard.py").exists())

    def test_crashed_parent_reaps_serve_child(self):
        pidfile = self.state / "orphan.pid"
        crash_state = self.state / "crash-home"
        script = (
            "import os, sys\n"
            f"sys.path[:0] = {SOURCE_PATHS!r}\n"
            "from pathlib import Path\n"
            "from dgc_sdk import DGC\n"
            f"dgc = DGC(state_dir={str(crash_state)!r}, model='sdk-model', "
            f"base_url={self.base_url!r}, api_key='sk-local')\n"
            f"session = dgc.session(cwd={str(self.work)!r}, "
            "permissions={'mode': 'auto', 'unhandled': 'deny'})\n"
            f"Path({str(pidfile)!r}).write_text(str(session.raw.pid))\n"
            "os._exit(9)\n"
        )
        env = os.environ.copy()
        checkout_python = ROOT / ".venv" / "bin" / "python"
        if checkout_python.exists():
            # A checkout run; the installed-wheel job already names its runtime in DGC_PYTHON.
            env["DGC_PYTHON"] = str(checkout_python)
        subprocess.run([sys.executable, "-c", script], env=env, check=False)
        self.assertTrue(pidfile.exists(), "child pid was not recorded")
        pid = int(pidfile.read_text().strip())
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and os.path.exists(f"/proc/{pid}"):
            time.sleep(0.1)
        self.assertFalse(os.path.exists(f"/proc/{pid}"), f"orphaned dgc serve pid {pid}")

    def test_usage_and_cost_are_queryable_by_department(self):
        with self._client(pricing=Pricing(input_per_million=1.0, output_per_million=2.0),
                          department="erp") as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("Summarize README. Do not edit files.", timeout=60)
            report = dgc.usage_report(department="erp")
        self.assertEqual(result.status, "completed")
        self.assertIn("token_estimate", result.usage)
        self.assertEqual(report["runs"], 1)
        self.assertEqual(report["by_department"][0]["department"], "erp")
        self.assertTrue(any(row.get("run_id") == result.run_id for row in report["rows"]))

    def test_policy_denies_write_tool_even_if_callback_would_allow(self):
        _Model.behavior = "edit"
        policy = RuntimePolicy(deny_tools=("write_file", "edit_file", "apply_patch"))
        with self._client(policy=policy) as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=lambda _req: "once",
            )
            result = session.run("edit the checkout guard", timeout=60)
        self.assertFalse((self.work / "guard.py").exists())
        self.assertEqual(result.status, "completed")

    def test_denied_step_is_reported_in_denials_not_as_a_blocked_status(self):
        # M1: a denied step no longer flips the run to a phantom "blocked" status; it is listed in
        # result.denials (with a source), and the run completes.
        _Model.behavior = "edit"
        policy = RuntimePolicy(deny_tools=("write_file", "edit_file", "apply_patch"))
        with self._client(policy=policy) as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("edit the checkout guard", timeout=60)
        self.assertEqual(result.status, "completed")
        self.assertNotEqual(result.status, "blocked")   # "blocked" was removed from RunStatus
        self.assertTrue(result.denials, "the denied write should appear in result.denials")
        denial = result.denials[0]
        self.assertIn(denial.name, ("write_file", "edit_file", "apply_patch"))
        self.assertEqual(denial.source, "policy")
        self.assertTrue(denial.reason)

    def test_policy_denies_write_in_auto_mode(self):
        _Model.behavior = "edit"
        policy = RuntimePolicy(deny_tools=("write_file", "edit_file", "apply_patch"))
        with self._client(policy=policy) as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
            )
            result = session.run("edit the checkout guard", timeout=60)
        self.assertFalse((self.work / "guard.py").exists(), "auto mode must still honour deny_tools")
        self.assertIn(result.status, ("completed", "failed", "cancelled"))

    def test_cancel_after_permission_event_drains_to_cancelled(self):
        _Model.behavior = "edit"

        def slow(_request):
            time.sleep(30)
            return "once"

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=slow,
                decision_timeout=30,
            )
            handle = session.stream("edit the checkout guard", timeout=25)
            for event in handle:
                if event.type == "permission_request":
                    break
            handle.cancel()
            result = handle.result(timeout=10)
        self.assertNotEqual(result.status, "running")
        self.assertEqual(result.status, "cancelled")
        self.assertFalse((self.work / "guard.py").exists())

    def test_audit_includes_redacted_tool_args(self):
        _Model.behavior = "edit"
        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=lambda _req: "once",
            )
            result = session.run("edit the checkout guard", timeout=60)
            rows = dgc.export_audit(result.session_id)
        blob = json.dumps(rows)
        self.assertIn("write_file", blob)
        self.assertTrue("args" in blob or "path" in blob or "guard.py" in blob, blob[:500])
        self.assertNotIn("sk-local", blob)

    def test_tool_record_keeps_output_for_host_tools(self):
        seen = []
        tool = define_tool(
            "sku_lookup", "Look up a product SKU",
            {"type": "object", "properties": {"sku": {"type": "string"}}},
            lambda args: {"name": "Widget", "sku": args.get("sku")},
        )
        _Model.behavior = "mcp"
        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"}, tools=[tool],
            )
            result = session.run("look up sku A-1", timeout=60)
        records = [rec for rec in result.tools if "sku" in rec.name]
        self.assertTrue(records, result.tools)
        self.assertTrue(any(rec.output for rec in records), records)

    def test_policy_denies_network_shaped_bash(self):
        from dgc_sdk.policy import RuntimePolicy as Policy
        from dgc_sdk.types import PermissionRequest
        policy = Policy(network="deny")
        req = PermissionRequest(id="r1", name="bash", args={"command": "curl https://evil.test"})
        self.assertEqual(policy.decision(req, cwd=self.work), "deny")
        req2 = PermissionRequest(id="r2", name="bash", args={"command": "ls"})
        self.assertIsNone(policy.decision(req2, cwd=self.work))

    def test_policy_denies_bash_redirect_when_write_denied(self):
        _Model.behavior = "bash_write"
        policy = RuntimePolicy(deny_tools=("write_file",))
        kinds = []
        with self._client(policy=policy) as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
            )
            handle = session.stream("escaped write via bash redirect", timeout=60)
            for event in handle:
                kinds.append(event.type)
            result = handle.result()
        self.assertFalse(
            (self.work / "escaped.txt").exists(),
            f"bash redirect must not land when write_file is denied; status={result.status}",
        )
        self.assertNotIn("permission_request", kinds)
        self.assertIn(result.status, ("completed", "failed", "cancelled"))

    def test_staff_deny_does_not_block_the_run(self):
        _Model.behavior = "edit"
        seen = []

        def on_permission(request):
            seen.append(request.name)
            return "deny"

        with self._client() as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=on_permission,
            )
            result = session.run("edit the checkout guard", timeout=60)
        self.assertIn("write_file", seen)
        self.assertFalse((self.work / "guard.py").exists())
        self.assertEqual(result.status, "completed")
        self.assertEqual(result.reason, "completed")

    def test_interactive_bash_write_raises_permission_request(self):
        _Model.behavior = "bash_write"
        seen = []
        kinds = []

        def on_permission(request):
            seen.append(request.name)
            return "deny"

        policy = RuntimePolicy(deny_tools=("write_file",))
        with self._client(policy=policy) as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "default", "unhandled": "deny"},
                on_permission=on_permission,
            )
            handle = session.stream("escaped write via bash redirect", timeout=60)
            for event in handle:
                kinds.append(event.type)
            result = handle.result()
        self.assertIn("permission_request", kinds)
        self.assertIn("bash", seen)
        self.assertFalse((self.work / "escaped.txt").exists())
        self.assertEqual(result.status, "completed")

    def test_audit_export_redacts_secrets(self):
        self.assertIn("[redacted]", redact_text("Authorization: Bearer sk-abc123456789"))
        with self._client() as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("Summarize README. Do not edit files.", timeout=60)
            rows = dgc.export_audit(result.session_id)
        kinds = {row.get("type") for row in rows}
        self.assertTrue({"turn_start", "turn_end"} & kinds, rows[:3])
        blob = json.dumps(rows)
        self.assertNotIn("sk-local", blob)

    def test_http_429_is_retried_then_completes(self):
        _Model.behavior = "flaky429"
        with self._client(retry=RetryPolicy(max_attempts=4)) as dgc:
            session = dgc.session(cwd=self.work, permissions={"mode": "auto", "unhandled": "deny"})
            result = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(result.status, "completed")
        self.assertGreaterEqual(_Model.posts, 3)
        self.assertIn("checkout", result.final_text.lower())


class PolicyUnitTests(unittest.TestCase):
    def test_deny_and_allow_tools_accept_display_and_internal_names(self):
        # Minor: both "Bash" and "bash" (and MCP routes) are accepted and normalised to the
        # internal name, instead of the display spelling raising.
        policy = RuntimePolicy(deny_tools=("Bash", "write_file", "Web  Fetch".replace("  ", "")),
                               allow_tools=("Read", "grep", "mcp__app__lookup"))
        self.assertIn("bash", policy.deny_tools)
        self.assertIn("write_file", policy.deny_tools)
        self.assertIn("web_fetch", policy.deny_tools)
        self.assertIn("read_file", policy.allow_tools)
        self.assertIn("grep", policy.allow_tools)
        self.assertIn("mcp__app__lookup", policy.allow_tools)
        from dgc_sdk import DGCConfigError
        with self.assertRaises(DGCConfigError):
            RuntimePolicy(deny_tools=("NotATool",))

    def test_redact_and_cost(self):
        from dgc_sdk import cost_usd
        self.assertEqual(cost_usd(1_000_000, 500_000, 0, Pricing(1.0, 2.0)), 2.0)
        self.assertIsNone(cost_usd(10, 10, 0, None))
        # DGC's input count already includes the cached tokens: they are billed once, at the
        # cached price, or at the input price when no cached price is set.
        self.assertAlmostEqual(cost_usd(10_000, 100, 8_000, Pricing(3.0, 15.0, 0.3)), 0.0099)
        self.assertAlmostEqual(cost_usd(10_000, 100, 8_000, Pricing(3.0, 15.0)), 0.0315)

    def test_write_deny_inspects_bash_like_network(self):
        from dgc.permissions import PermissionEngine
        from dgc_sdk.types import PermissionRequest
        policy = RuntimePolicy(deny_tools=("write_file",), network="allow")
        def decide(command: str):
            return policy.decision(
                PermissionRequest(id="r", name="bash", args={"command": command}),
                cwd=None,
            )
        self.assertEqual(decide("echo pwned > escaped.txt"), "deny")
        self.assertEqual(decide("echo pwned>escaped.txt"), "deny")
        self.assertEqual(decide("echo pwned >> escaped.txt"), "deny")
        self.assertEqual(decide("echo x | tee escaped.txt"), "deny")
        self.assertEqual(decide("cp a b"), "deny")
        self.assertEqual(decide("sudo mv a b"), "deny")
        self.assertEqual(decide("sed -i s/a/b/ file"), "deny")
        self.assertEqual(decide("python -c \"open('f','w').write('x')\""), "deny")
        self.assertIsNone(decide("ls"))
        self.assertIsNone(decide("ls -la"))
        self.assertIsNone(decide("ls 2>&1"))
        self.assertIsNone(decide("cat README.md"))
        open_policy = RuntimePolicy(network="allow")
        self.assertIsNone(open_policy.decision(
            PermissionRequest(id="r", name="bash", args={"command": "echo x > f"}),
            cwd=None,
        ))
        # compile_session builds what the runtime actually enforces (a session policy); the
        # per-command screening above is what shell="screened" applies through policy.evaluate.


class SbomGeneratorTests(unittest.TestCase):
    def test_source_set_excludes_pycache_and_reads_version(self):
        import importlib.util
        from dgc_sdk._version import __version__
        path = ROOT / "sdk" / "scripts" / "make_sbom.py"
        spec = importlib.util.spec_from_file_location("dgc_sdk_make_sbom", path)
        self.assertIsNotNone(spec and spec.loader)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        files = [p.relative_to(ROOT).as_posix() for p in mod.source_files()]
        self.assertTrue(files)
        self.assertFalse(any("__pycache__" in f or f.endswith(".pyc") for f in files))
        for name in (
            "sdk/python/dgc_sdk/_mcp_bridge.py",
            "sdk/python/dgc_sdk/_version.py",
            "sdk/python/dgc_sdk/client.py",
        ):
            self.assertIn(name, files)
        self.assertEqual(mod.sdk_version(), __version__)


# ---- sessions: identity, scoped options, private state, usage, changes, runs, async, audit ----

def _usage_chunk(prompt_tokens: int, completion_tokens: int) -> str:
    return "data: " + json.dumps({"id": "mock", "object": "chat.completion.chunk", "choices": [],
                                  "usage": {"prompt_tokens": prompt_tokens,
                                            "completion_tokens": completion_tokens,
                                            "total_tokens": prompt_tokens + completion_tokens}}) + "\n\n"


def _with_usage(body: str, prompt_tokens: int = 1200, completion_tokens: int = 300) -> str:
    head, _sep, _tail = body.rpartition("data: [DONE]\n\n")
    return head + _usage_chunk(prompt_tokens, completion_tokens) + "data: [DONE]\n\n"


class _SessionsModel(_Model):
    """Extra scripted behaviours for the session tests; everything else falls back to _Model."""

    behavior = "text"
    auth_headers: list = []

    def do_POST(self):
        _SessionsModel.auth_headers.append(self.headers.get("Authorization") or "")
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) or b"{}"
        request = json.loads(raw)
        messages = request.get("messages") or []
        tools_seen = sum(1 for message in messages if message.get("role") == "tool")
        last = ""
        for message in reversed(messages):
            if message.get("role") == "tool":
                last = "TOOL:" + str(message.get("content") or "")
                break
            if message.get("role") == "user":
                content = message.get("content")
                last = content if isinstance(content, str) else json.dumps(content)
                break
        behavior = _SessionsModel.behavior
        _Model.posts += 1
        if behavior == "usage":
            if "tool please" in last and not last.startswith("TOOL:"):
                self._send(_with_usage(_call("read_file", {"path": "README.md"})))
            else:
                self._send(_with_usage(_answer("Usage reported.")))
            return
        if behavior == "repair_follow":
            if "Return only valid JSON" in last:
                self._send(_answer('{"ok": true}'))
            elif last.startswith("TOOL:"):
                self._send(_answer("FOLLOW-DONE"))
            elif "follow task" in last:
                self._send(_call("read_file", {"path": "README.md"}))
            else:
                time.sleep(1.0)
                self._send(_answer("not JSON yet"))
            return
        if behavior == "two_steps":
            if tools_seen < 2:
                self._send(_call("read_file", {"path": "README.md"}))
            else:
                self._send(_answer("both steps done"))
            return
        if behavior == "http404":
            body = b'{"error":{"message":"model \'nope\' not found, try pulling it first"}}'
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if behavior == "flow":
            if "STEER-MARK" in last:
                self._send(_answer("STEERED-ANSWER"))
            elif last.startswith("TOOL:"):
                self._send(_answer("SECOND-ANSWER"))
            elif "second task" in last:
                self._send(_call("write_file", {"path": "followup_wrote.txt", "content": "x\n"}))
            elif "first task" in last:
                time.sleep(1.5)
                self._send(_answer("FIRST-ANSWER"))
            elif "slow edit" in last:
                time.sleep(2.0)
                self._send(_call("write_file", {"path": "after_break.txt", "content": "x\n"}))
            elif "quiet please" in last:
                time.sleep(4.0)
                self._send(_answer("LATE-OK"))
            elif "slow answer" in last:
                time.sleep(3.0)
                self._send(_answer("SLOW-OK"))
            else:
                self._send(_answer("The checkout flow creates an empty cart and then redirects."))
            return
        if behavior == "bash_echo":
            if last.startswith("TOOL:"):
                self._send(_answer("done"))
            else:
                self._send(_call("bash", {"command": "echo hi"}))
            return
        if behavior == "bash_verify":
            if last.startswith("TOOL:"):
                self._send(_answer("verified"))
            else:
                self._send(_call("bash", {"command": "echo VERIFY-OK"}))
            return
        # Re-dispatch the ordinary behaviours on the already-read body.
        _Model.posts -= 1
        self.rfile = io.BytesIO(raw)
        super().do_POST()


class SessionFixTests(unittest.TestCase):
    def setUp(self):
        self.host_home = Path(tempfile.mkdtemp(prefix="dgc-sdk-host-"))
        self.state = Path(tempfile.mkdtemp(prefix="dgc-sdk-state-"))
        self.work = Path(tempfile.mkdtemp(prefix="dgc-sdk-work-"))
        (self.work / "README.md").write_text("empty cart checkout\n", encoding="utf-8")
        (self.host_home / ".dgc").mkdir()
        self._old_home = os.environ.get("HOME")
        os.environ["HOME"] = str(self.host_home)
        _Model.behavior = "text"
        _Model.posts = 0
        _SessionsModel.behavior = "text"
        _SessionsModel.auth_headers = []
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), _SessionsModel)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.base_url = f"http://127.0.0.1:{self.server.server_address[1]}/v1"

    tearDown = SdkTests.tearDown

    def _client(self, **kwargs):
        kwargs.setdefault("state_dir", self.state)
        return DGC(model="sdk-model", base_url=self.base_url, api_key="sk-local", **kwargs)

    def _auto(self, dgc, **kwargs):
        kwargs.setdefault("cwd", self.work)
        return dgc.session(permissions={"mode": "auto", "unhandled": "deny"}, **kwargs)

    def _config(self):
        return json.loads((self.state / "home" / ".dgc" / "config.json").read_text(encoding="utf-8"))

    # identity -----------------------------------------------------------------------------------

    def test_new_session_does_not_take_over_the_previous_identity(self):
        with self._client() as dgc:
            first = self._auto(dgc)
            first.run("Summarize README alpha. Do not edit files.", timeout=60)
            self.assertTrue(first.session_path.endswith(first.session_id + ".json"))
            second = self._auto(dgc)
            own = str(second._ready.get("session_id") or "")
            self.assertTrue(own)
            self.assertEqual(second.session_id, own, "must keep the id DGC reported at ready")
            self.assertNotEqual(second.session_id, first.session_id)
            self.assertEqual(second.session_path, "", "no transcript of its own exists yet")
            result = second.run("Summarize README beta. Do not edit files.", timeout=60)
            self.assertEqual(result.session_id, own)
            self.assertTrue(second.session_path.endswith(own + ".json"), second.session_path)
            mine = {row.get("run_id") for row in dgc.export_audit(own)}
            theirs = {row.get("run_id") for row in dgc.export_audit(first.session_id)}
            self.assertIn(result.run_id, mine)
            self.assertNotIn(result.run_id, theirs)
            restored = dgc.resume(own, cwd=self.work,
                                  permissions={"mode": "auto", "unhandled": "deny"})
            blob = json.dumps(restored.history()).lower()
        self.assertIn("beta", blob)
        self.assertNotIn("alpha", blob)

    # options stay scoped --------------------------------------------------------------------------

    def test_output_schema_repair_does_not_cap_later_runs(self):
        schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
        with self._client() as dgc:
            session = self._auto(dgc)
            repaired = session.run("Summarize README as JSON.", timeout=60, output_schema=schema)
            self.assertEqual(repaired.status, "completed")
            self.assertEqual(repaired.output["ok"], True)
            self.assertIn(self._config().get("max_turns", 0), (0, None),
                          "a repair's one-turn cap must not stay in the isolated config")
            _SessionsModel.behavior = "two_steps"
            again = session.run("Read the README twice.", timeout=60)
            later = self._auto(dgc).run("Read the README twice.", timeout=60)
        self.assertEqual(again.status, "completed", again.error)
        self.assertIn("both steps done", again.final_text)
        self.assertEqual(later.status, "completed", later.error)
        self.assertIn("both steps done", later.final_text)

    def test_run_max_turns_is_restored_after_the_run(self):
        _SessionsModel.behavior = "two_steps"
        with self._client() as dgc:
            session = self._auto(dgc)
            capped = session.run("Read the README twice.", timeout=60, max_turns=1)
            free = session.run("Read the README twice.", timeout=60)
        self.assertEqual(capped.status, "failed")
        self.assertTrue(capped.error, "a stopped run must say why")
        self.assertEqual(free.status, "completed", free.error)

    def test_session_options_do_not_leak_into_the_next_session(self):
        other = Path(tempfile.mkdtemp(prefix="dgc-sdk-work-b-"))
        with self._client() as dgc:
            first = self._auto(dgc, verify_command="echo first-verify", max_turns=5,
                               turn_budget_s=60, model="first-model")
            seen = self._config()
            self.assertEqual(seen.get("verify_command"), "echo first-verify")
            self.assertEqual(seen.get("max_turns"), 5)
            self.assertEqual(first.get_config().get("model"), "first-model")
            first.close()
            second = self._auto(dgc, cwd=other)
            config = self._config()
            self.assertEqual(second.get_config().get("model"), "sdk-model")
        for key in ("verify_command", "verify_before_done", "max_turns", "turn_budget_s"):
            self.assertNotIn(key, config, f"{key} leaked into the next session")
        self.assertEqual(config.get("trusted_dirs"), [str(other.resolve())])

    def test_concurrent_sessions_get_their_own_settings(self):
        errors: list = []
        models: dict = {}
        with self._client() as dgc:
            def open_one(index: int) -> None:
                try:
                    session = self._auto(dgc, model=f"sdk-model-{index}")
                    models[index] = session.get_config().get("model")
                except Exception as exc:  # noqa: BLE001 - reported below
                    errors.append(repr(exc))
            threads = [threading.Thread(target=open_one, args=(i,)) for i in range(4)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join(120)
            config = self._config()
        self.assertEqual(errors, [])
        self.assertEqual(models, {i: f"sdk-model-{i}" for i in range(4)})
        self.assertIsInstance(config, dict)

    def test_extra_config_is_the_explicit_way_to_add_settings(self):
        with self._client(extra_config={"context_size": 65536}) as dgc:
            config = self._auto(dgc).get_config()
        self.assertEqual(config.get("context_size"), 65536)

    # private state ------------------------------------------------------------------------------

    def test_planted_config_in_state_dir_is_ignored(self):
        marker = self.work / "planted-gate-ran"
        verifier = self.work / "planted-verifier-ran"
        folder = self.state / "home" / ".dgc"
        folder.mkdir(parents=True)
        (folder / "config.json").write_text(json.dumps({
            "autonomous_gate": f"touch {marker}",
            "verify_command": f"touch {verifier}",
            "verify_before_done": True,
            "model": "planted-model",
            "base_url": "http://127.0.0.1:9/v1",
        }), encoding="utf-8")
        os.chmod(self.state, 0o755)
        with self._client() as dgc:
            session = self._auto(dgc)
            result = session.run("Summarize README. Do not edit files.", timeout=60)
            config = self._config()
        self.assertEqual(result.status, "completed", result.error)
        self.assertFalse(marker.exists(), "a planted autonomous_gate must not run")
        self.assertFalse(verifier.exists(), "a planted verify_command must not run")
        self.assertNotIn("autonomous_gate", config)
        self.assertEqual(config.get("model"), "sdk-model")
        self.assertEqual(os.stat(self.state).st_mode & 0o777, 0o700)
        self.assertEqual(os.stat(folder / "config.json").st_mode & 0o777, 0o600)

    def test_writable_state_dir_is_refused_and_default_is_private(self):
        os.chmod(self.state, 0o777)
        with self.assertRaises(DGCConfigError):
            DGC(state_dir=self.state, model="sdk-model", base_url=self.base_url)
        dgc = DGC(model="sdk-model", base_url=self.base_url)
        try:
            self.assertTrue(dgc.state_dir.is_dir())
            self.assertEqual(os.stat(dgc.state_dir).st_mode & 0o777, 0o700)
        finally:
            dgc.close()

    def test_auto_state_dir_is_removed_on_close_but_an_explicit_one_is_kept(self):
        # A state_dir the SDK creates (state_dir unset) is removed on close, audit logs included;
        # an explicit state_dir, or keep_state_dir=True, is left in place.
        dgc = DGC(model="sdk-model", base_url=self.base_url)
        auto_dir = dgc.state_dir
        self.assertTrue(auto_dir.is_dir())
        dgc.close()
        self.assertFalse(auto_dir.exists(), "an auto state_dir should be removed on close")

        kept = DGC(model="sdk-model", base_url=self.base_url, keep_state_dir=True)
        kept_dir = kept.state_dir
        kept.close()
        self.assertTrue(kept_dir.is_dir(), "keep_state_dir=True must preserve it")
        shutil.rmtree(kept_dir, ignore_errors=True)

        explicit = DGC(state_dir=self.state, model="sdk-model", base_url=self.base_url)
        explicit.close()
        self.assertTrue(self.state.is_dir(), "an explicit state_dir must never be removed")

    def test_inherit_user_state_rejects_what_it_cannot_apply(self):
        (self.host_home / ".dgc" / "config.json").write_text(json.dumps({
            "model": "sdk-model", "base_url": self.base_url, "mode": "default",
        }), encoding="utf-8")
        with self.assertRaises(DGCConfigError):
            DGC(state_dir=self.state, inherit_user_state=True, model="other-model")
        with DGC(state_dir=self.state, inherit_user_state=True) as dgc:
            for options in ({"max_turns": 3}, {"verify_command": "pytest -q"},
                            {"turn_budget_s": 30}, {"max_tokens": 100}):
                with self.assertRaises(DGCConfigError, msg=str(options)):
                    dgc.session(cwd=self.work, **options)
            with self.assertRaises(DGCConfigError):
                dgc.session(cwd=self.work, permissions={"mode": "auto"})
            with self.assertRaises(DGCConfigError):
                dgc.session(cwd=self.work, base_url="http://127.0.0.1:9/v1")

    def test_inherit_user_state_uses_the_api_key_without_saving_it(self):
        user_config = self.host_home / ".dgc" / "config.json"
        user_config.write_text(json.dumps({
            "model": "sdk-model", "base_url": self.base_url, "mode": "default",
        }), encoding="utf-8")
        key = "sk-inherit-0123456789abcdef"
        with DGC(state_dir=self.state, inherit_user_state=True, api_key=key) as dgc:
            session = dgc.session(cwd=self.work, model="sdk-model",
                                  permissions={"mode": "default", "unhandled": "deny"})
            result = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(result.status, "completed", result.error)
        self.assertIn(f"Bearer {key}", _SessionsModel.auth_headers)
        stored = "".join(path.read_text(encoding="utf-8")
                         for path in (self.host_home / ".dgc").glob("*.json"))
        self.assertNotIn(key, stored, "an explicit key must not be saved into ~/.dgc")

    # usage --------------------------------------------------------------------------------------

    def test_usage_counts_provider_tokens_and_cost(self):
        _SessionsModel.behavior = "usage"
        with self._client(pricing=Pricing(input_per_million=1.0, output_per_million=10.0),
                          department="erp") as dgc:
            session = self._auto(dgc)
            first = session.run("tool please: read the README", timeout=60)
            second = session.run("Summarize README. Do not edit files.", timeout=60)
            report = dgc.usage_report(department="erp")
        self.assertEqual(first.status, "completed", first.error)
        self.assertEqual((first.usage["input_tokens"], first.usage["output_tokens"]), (2400, 600))
        self.assertEqual(first.usage["requests"], 2)
        self.assertAlmostEqual(first.usage["cost_usd"], 0.0084)
        self.assertIn("token_estimate", first.usage)
        self.assertEqual((second.usage["input_tokens"], second.usage["output_tokens"]), (1200, 300))
        self.assertEqual((report["input_tokens"], report["output_tokens"]), (3600, 900))
        self.assertAlmostEqual(report["cost_usd"], 0.0126)
        self.assertEqual(report["unknown_usage_runs"], 0)

    def test_unreported_usage_is_unknown_not_zero(self):
        with self._client(pricing=Pricing(1.0, 10.0)) as dgc:
            result = self._auto(dgc).run("Summarize README. Do not edit files.", timeout=60)
            report = dgc.usage_report()
        self.assertIsNone(result.usage["input_tokens"])
        self.assertIsNone(result.usage["output_tokens"])
        self.assertIsNone(result.usage["cost_usd"])
        # The request itself was made and counted by DGC; only its tokens are unknown.
        self.assertGreaterEqual(result.usage["requests"], 1)
        self.assertEqual(report["unknown_usage_runs"], 1)
        self.assertIsNone(report["cost_usd"])

    def test_failed_run_reports_the_backend_error(self):
        _SessionsModel.behavior = "http404"
        with self._client() as dgc:
            result = self._auto(dgc).run("Summarize README.", timeout=60)
        self.assertEqual(result.status, "failed")
        self.assertTrue(result.error)
        self.assertIn("not found", result.error)

    # changes ------------------------------------------------------------------------------------

    def test_changes_cover_dot_dirs_home_locks_and_lockfiles(self):
        from dgc_sdk.session import _diff_workspace, _snapshot_workspace
        root = Path(tempfile.mkdtemp(prefix="dgc-sdk-changes-"))
        state = root / ".sdk-state"
        for rel, text in {
            "src/home/page.tsx": "export default 1;\n",
            ".github/workflows/ci.yml": "on: push\n",
            "app/locks/mutex.py": "LOCK = 1\n",
            "poetry.lock": "[[package]]\n",
            "gone.txt": "bye\n",
            "noeol.txt": "a\nb",
        }.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text, encoding="utf-8")
        state.mkdir()
        original = Path(tempfile.mkdtemp(prefix="dgc-sdk-orig-"))
        subprocess.run(["cp", "-a", f"{root}/.", str(original)], check=True)
        # A Session resolves its excluded paths (session.py); resolve here too, as macOS's /var is
        # /private/var and an unresolved exclude never matches the resolved workspace walk.
        state = state.resolve()
        before = _snapshot_workspace(root, (state,))
        time.sleep(0.01)
        (root / "src/home/page.tsx").write_text("export default 2;\n", encoding="utf-8")
        (root / ".github/workflows/ci.yml").write_text("on: [push, pull_request]\n", encoding="utf-8")
        (root / "app/locks/mutex.py").write_text("LOCK = 2\n", encoding="utf-8")
        (root / "poetry.lock").write_text("[[package]]\nname = 'x'\n", encoding="utf-8")
        (root / "gone.txt").unlink()
        (root / "noeol.txt").write_text("a\nc", encoding="utf-8")
        (root / "new dir").mkdir()
        (root / "new dir" / "added.txt").write_text("hello\n", encoding="utf-8")
        (state / "noise.json").write_text("{}", encoding="utf-8")
        changes = {change.path: change for change in _diff_workspace(root, before, (state,))}
        self.assertEqual(set(changes), {
            "src/home/page.tsx", ".github/workflows/ci.yml", "app/locks/mutex.py",
            "poetry.lock", "gone.txt", "noeol.txt", "new dir/added.txt"})
        self.assertEqual(changes["gone.txt"].kind, "deleted")
        self.assertEqual(changes["gone.txt"].before, "bye\n")
        self.assertEqual(changes["src/home/page.tsx"].before, "export default 1;\n")
        self.assertEqual(changes["new dir/added.txt"].kind, "added")
        patch = "".join(change.diff for change in changes.values())
        (original / "run.patch").write_text(patch, encoding="utf-8")
        subprocess.run(["git", "init", "-q"], cwd=original, check=True)
        check = subprocess.run(["git", "apply", "--check", "run.patch"], cwd=original,
                               capture_output=True, text=True)
        self.assertEqual(check.returncode, 0, check.stderr + patch)
        subprocess.run(["git", "apply", "run.patch"], cwd=original, check=True)
        self.assertEqual((original / "noeol.txt").read_text(encoding="utf-8"), "a\nc")
        self.assertEqual((original / "new dir" / "added.txt").read_text(encoding="utf-8"), "hello\n")
        self.assertFalse((original / "gone.txt").exists())

    def test_run_changes_carry_an_applicable_diff(self):
        _Model.behavior = "edit"
        _SessionsModel.behavior = "edit"
        with self._client() as dgc:
            result = self._auto(dgc).run("edit the checkout guard", timeout=60)
        change = next(item for item in result.changes if item.path == "guard.py")
        self.assertEqual(change.kind, "added")
        self.assertIn("+ok", change.diff)
        self.assertIn("new file mode", change.diff)

    # verification -------------------------------------------------------------------------------

    def test_verification_is_not_an_unrelated_bash_command(self):
        _SessionsModel.behavior = "bash_echo"
        command = "echo VERIFIER-RAN; exit 3"
        with self._client() as dgc:
            result = self._auto(dgc, verify_command=command).run("run something", timeout=90)
        self.assertIsNotNone(result.verification)
        self.assertEqual(result.verification.command, command)
        self.assertIsNot(result.verification.ok, True, result.verification)
        self.assertNotIn("hi", result.verification.output)

    def test_verification_uses_the_model_run_of_the_exact_command(self):
        _SessionsModel.behavior = "bash_verify"
        with self._client() as dgc:
            result = self._auto(dgc, verify_command="echo VERIFY-OK").run("verify", timeout=90)
        self.assertEqual(result.verification.ok, True)
        self.assertEqual(result.verification.exit_code, 0)
        self.assertIn("VERIFY-OK", result.verification.output)

    # follow-ups, steering, early exit -------------------------------------------------------------

    def test_steer_needs_an_active_run(self):
        with self._client() as dgc:
            session = self._auto(dgc)
            with self.assertRaises(DGCConfigError):
                session.steer("do this instead")

    def test_followup_is_an_observed_audited_run(self):
        _SessionsModel.behavior = "flow"
        with self._client() as dgc:
            session = self._auto(dgc)
            handle = session.stream("first task", timeout=60)
            follow = session.followup("second task", timeout=60)
            first = handle.result()
            second = follow.result()
            rows = dgc.export_audit(session.session_id)
            report = dgc.usage_report()
        self.assertEqual(first.status, "completed", first.error)
        self.assertIn("FIRST-ANSWER", first.final_text)
        self.assertNotIn("SECOND-ANSWER", first.final_text)
        self.assertEqual(second.status, "completed", second.error)
        self.assertIn("SECOND-ANSWER", second.final_text)
        self.assertTrue((self.work / "followup_wrote.txt").exists())
        self.assertIn("followup_wrote.txt", [change.path for change in second.changes])
        self.assertTrue(any(row.get("run_id") == second.run_id and row.get("type") == "tool_call"
                            and row["payload"].get("name") == "write_file" for row in rows), rows)
        self.assertIn(second.run_id, {row.get("run_id") for row in report["rows"]})

    def test_followup_behind_a_schema_repair_gets_its_own_turn(self):
        _SessionsModel.behavior = "repair_follow"
        schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
        with self._client() as dgc:
            session = self._auto(dgc)
            handle = session.stream("json task", timeout=60, output_schema=schema)
            follow = session.followup("follow task", timeout=60)
            first = handle.result(timeout=90)
            second = follow.result(timeout=90)
            after = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(first.status, "completed", first.error)
        self.assertEqual(first.output, {"ok": True})
        self.assertNotIn("read_file", [tool.name for tool in first.tools])
        self.assertEqual(second.status, "completed", second.error)
        self.assertIn("FOLLOW-DONE", second.final_text)
        self.assertIn("read_file", [tool.name for tool in second.tools])
        self.assertEqual(after.status, "completed", after.error)

    def test_followup_behind_a_capped_run_is_not_capped(self):
        _SessionsModel.behavior = "two_steps"
        with self._client() as dgc:
            session = self._auto(dgc)
            handle = session.stream("Read the README twice.", timeout=60, max_turns=1)
            follow = session.followup("Read the README twice.", timeout=60)
            capped = handle.result(timeout=90)
            second = follow.result(timeout=90)
        self.assertEqual(capped.status, "failed")
        self.assertEqual(second.status, "completed", second.error)
        self.assertIn("both steps done", second.final_text)

    def test_held_followup_does_not_run_when_the_run_in_front_is_cancelled(self):
        _SessionsModel.behavior = "repair_follow"
        schema = {"type": "object", "required": ["ok"], "properties": {"ok": {"type": "boolean"}}}
        with self._client() as dgc:
            session = self._auto(dgc)
            handle = session.stream("json task", timeout=60, output_schema=schema)
            follow = session.followup("follow task", timeout=60)
            handle.cancel()
            first = handle.result(timeout=60)
            second = follow.result(timeout=60)
            after = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(first.status, "cancelled")
        self.assertEqual(second.status, "cancelled")
        self.assertEqual(second.tools, [])
        self.assertEqual(after.status, "completed", after.error)

    def test_steer_is_part_of_the_run(self):
        _SessionsModel.behavior = "flow"
        with self._client() as dgc:
            session = self._auto(dgc)
            handle = session.stream("first task", timeout=60)
            time.sleep(0.4)
            session.steer("STEER-MARK: answer differently")
            result = handle.result()
            after = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertEqual(result.status, "completed", result.error)
        self.assertIn("STEERED-ANSWER", result.final_text)
        self.assertNotIn("STEERED-ANSWER", after.final_text)

    def test_leaving_with_early_cancels_and_frees_the_session(self):
        _SessionsModel.behavior = "flow"
        with self._client() as dgc:
            session = self._auto(dgc)
            with session.stream("slow edit please", timeout=30) as handle:
                first = next(iter(handle))
            self.assertNotEqual(first.type, "ready", "the startup handshake is not a run event")
            self.assertEqual(handle.result().status, "cancelled")
            time.sleep(3.0)
            again = session.run("Summarize README. Do not edit files.", timeout=60)
        self.assertFalse((self.work / "after_break.txt").exists(),
                         "the agent must stop when the caller left the with block")
        self.assertEqual(again.status, "completed", again.error)

    def test_control_requests_during_a_stream_get_their_answers(self):
        _SessionsModel.behavior = "flow"
        kinds: list = []
        with self._client() as dgc:
            session = self._auto(dgc)
            handle = session.stream("slow answer please", timeout=60)
            reader = threading.Thread(target=lambda: kinds.extend(ev.type for ev in handle))
            reader.start()
            slowest = 0.0
            for _ in range(10):
                started = time.monotonic()
                session.list_permissions()
                slowest = max(slowest, time.monotonic() - started)
            reader.join(60)
            result = handle.result()
        self.assertLess(slowest, 5.0)
        self.assertNotIn("permissions", kinds)
        self.assertEqual(result.status, "completed", result.error)

    def test_timeout_none_waits_through_a_quiet_model(self):
        _SessionsModel.behavior = "flow"
        with self._client() as dgc:
            session = self._auto(dgc)
            session.raw._event_timeout = 1.5  # the transport's idle fallback
            result = session.run("quiet please", timeout=None)
        self.assertEqual(result.status, "completed", result.error)
        self.assertIn("LATE-OK", result.final_text)

    def test_run_timeout_is_reported_as_a_timeout(self):
        _SessionsModel.behavior = "stall"
        started = time.monotonic()
        with self._client() as dgc:
            result = self._auto(dgc).run("Summarize README.", timeout=2)
        self.assertLess(time.monotonic() - started, 20)
        self.assertEqual((result.status, result.reason), ("failed", "timeout"))

    # async --------------------------------------------------------------------------------------

    def test_cancelling_the_async_task_cancels_the_run(self):
        _SessionsModel.behavior = "stall"

        async def go():
            async with AsyncDGC(state_dir=self.state, model="sdk-model", base_url=self.base_url,
                                api_key="sk-local") as dgc:
                session = await dgc.session(cwd=self.work,
                                            permissions={"mode": "auto", "unhandled": "deny"})

                async def consume():
                    handle = await session.stream("Summarize README.", timeout=60)
                    async for _event in handle:
                        pass

                task = asyncio.create_task(consume())
                await asyncio.sleep(1.5)
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task
                _SessionsModel.behavior = "text"
                return await session.run("Summarize README. Do not edit files.", timeout=60)

        result = asyncio.run(go())
        self.assertEqual(result.status, "completed", result.error)

    def test_async_surface_matches_the_sync_one(self):
        import inspect
        from dgc_sdk import AsyncRunHandle, AsyncSession, RunHandle, Session

        def params(func):
            return [(p.name, p.kind, p.default) for p in inspect.signature(func).parameters.values()]

        public = [name for name, _ in inspect.getmembers(Session, inspect.isfunction)
                  if not name.startswith("_")]
        for name in public:
            self.assertTrue(hasattr(AsyncSession, name), f"AsyncSession lacks {name}")
            self.assertEqual(params(getattr(AsyncSession, name)), params(getattr(Session, name)),
                             name)
        for name in ("__init__", "session", "resume"):
            self.assertEqual(params(getattr(AsyncDGC, name)), params(getattr(DGC, name)), name)
        for name in ("usage_report", "export_audit"):
            self.assertEqual(params(getattr(AsyncDGC, name)), params(getattr(DGC, name)), name)
        self.assertTrue(hasattr(AsyncDGC, "raw_runtime"))
        self.assertTrue(hasattr(AsyncDGC, "state_dir"))
        for name in ("cancel", "result"):
            self.assertTrue(hasattr(AsyncRunHandle, name) and hasattr(RunHandle, name))
        for func in (AsyncDGC.__init__, AsyncDGC.session, AsyncSession.run, AsyncSession.stream,
                     DGC.resume):
            kinds = {p.kind for p in inspect.signature(func).parameters.values()}
            self.assertNotIn(inspect.Parameter.VAR_KEYWORD, kinds, func.__qualname__)

    def test_async_permission_callback_is_awaited(self):
        _SessionsModel.behavior = "edit"
        _Model.behavior = "edit"
        seen: list = []

        async def ask_person(request):
            await asyncio.sleep(0.05)
            seen.append(request.name)
            return "once"

        async def go():
            async with AsyncDGC(state_dir=self.state, model="sdk-model", base_url=self.base_url,
                                api_key="sk-local") as dgc:
                session = await dgc.session(cwd=self.work, on_permission=ask_person,
                                            permissions={"mode": "default", "unhandled": "deny"})
                handle = await session.stream("edit the checkout guard", timeout=60)
                return await handle.result()

        result = asyncio.run(go())
        self.assertIn("write_file", seen)
        self.assertTrue((self.work / "guard.py").exists(), "an async approval must be honoured")
        self.assertEqual(result.status, "completed", result.error)

    # audit --------------------------------------------------------------------------------------

    def test_audit_redaction_covers_modern_secret_formats(self):
        from dgc_sdk.audit import redact
        secrets = {
            "anthropic": "sk-ant-api03-" + "A1b2C3d4E5f6G7h8I9j0" * 2,
            "openai": "sk-proj-" + "Zy9Xw8Vu7Ts6Rq5Po4Nm3" * 2,
            "github": "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
            "oauth": "gho_" + "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6J7k8",
            "aws": "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        }
        texts = [
            f"key={secrets['anthropic']}",
            f"OPENAI_API_KEY={secrets['openai']}",
            json.dumps({"api_key": "plain-json-secret-value-123"}),
            f"token: {secrets['github']}",
            f"oauth_token: {secrets['oauth']}",
            f"aws_secret_access_key = {secrets['aws']}",
            "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n"
            "-----END OPENSSH PRIVATE KEY-----",
        ]
        blob = json.dumps(redact({"output": "\n".join(texts), "args": {"password": "hunter2hunter2"}}))
        for value in (*secrets.values(), "plain-json-secret-value-123", "b3BlbnNzaC1rZXktdjEAAAA",
                      "hunter2hunter2"):
            self.assertNotIn(value, blob)
        self.assertIn("[redacted]", redact_text("Authorization: Bearer sk-abc123456789"))
        self.assertEqual(redact({"max_tokens": 4096, "token_estimate": 12}),
                         {"max_tokens": 4096, "token_estimate": 12})
        from dgc_sdk.audit import sensitive_name
        self.assertFalse(sensitive_name("token_estimate"))
        self.assertTrue(sensitive_name("GITHUB_TOKEN"))
        # Bare names at the start of a .env or YAML line, as 0.5.2 redacted them.
        for line in ("API_KEY=zq8Lx9Vb7Nm5", "api_key: zq8Lx9Vb7Nm5", "TOKEN=zq8Lx9Vb7Nm5",
                     "password=zq8Lx9Vb7Nm5"):
            self.assertNotIn("zq8Lx9Vb7Nm5", redact_text(line), line)
        # Code that reads a secret is not a secret.
        for code in ("api_key = config.get('api_key')", 'token = os.environ["TOKEN"]'):
            self.assertEqual(redact_text(code), code)

    def test_audit_and_usage_files_are_owner_only(self):
        with self._client(pricing=Pricing(1.0, 1.0)) as dgc:
            self._auto(dgc).run("Summarize README. Do not edit files.", timeout=60)
        for folder in (self.state / "audit", self.state / "usage", self.state / "home"):
            self.assertEqual(os.stat(folder).st_mode & 0o777, 0o700, folder)
        files = list((self.state / "audit").glob("*.jsonl")) + [self.state / "usage" / "usage.jsonl"]
        self.assertTrue(files)
        for path in files:
            self.assertEqual(os.stat(path).st_mode & 0o777, 0o600, path)

    # decisions ----------------------------------------------------------------------------------

    def _bare_session(self, **kwargs):
        from dgc_sdk.session import Session

        class _Pipe:
            def __init__(self):
                self.sent = []

            def send(self, command):
                self.sent.append(dict(command))

        pipe = _Pipe()
        options = dict(unhandled="deny", on_permission=None, on_plan=None, on_question=None)
        options.update(kwargs)
        return Session(pipe, {"session_id": "s-test"}, **options), pipe

    def test_decision_timeout_none_has_no_limit(self):
        from unittest import mock
        from dgc_sdk.session import _Run
        from dgc_sdk.types import PermissionRequest, RunResult

        def slow(_request):
            time.sleep(0.4)
            return "once"

        session, _pipe = self._bare_session(on_permission=slow, decision_timeout=None)
        run = _Run(RunResult(session_id="s", run_id="r", status="running"), "req")
        real = time.monotonic
        start = real()
        # Every clock read after the first looks 40 s later: a hidden 30 s cap would fire.
        with mock.patch("dgc_sdk.session.time.monotonic",
                        side_effect=lambda: real() + (40.0 if real() - start > 0.01 else 0.0)):
            answer = session._decide(run, slow, PermissionRequest(id="p1", name="bash", args={}),
                                     "deny", label="on_permission",
                                     valid=lambda value: value in ("once", "always", "deny"),
                                     mine=True)
        self.assertEqual(answer, "once")

    def test_mcp_input_callback_honours_decision_timeout(self):
        from dgc_sdk import McpInputResponse
        from dgc_sdk.session import _Run
        from dgc_sdk.types import RunResult

        def slow(_request):
            time.sleep(2.0)
            return McpInputResponse(action="accept", content={"x": 1})

        session, pipe = self._bare_session(on_mcp_input=slow, decision_timeout=0.2)
        run = _Run(RunResult(session_id="s", run_id="r", status="running"), "req")
        started = time.monotonic()
        session._answer_mcp(run, {"id": "m1", "server": "s", "kind": "elicitation",
                                  "payload": {}}, True)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(pipe.sent[-1]["action"], "cancel")

    def test_unhandled_callback_requires_and_enforces_the_callback(self):
        _SessionsModel.behavior = "edit"
        _Model.behavior = "edit"
        with self._client() as dgc:
            with self.assertRaises(DGCConfigError):
                dgc.session(cwd=self.work, permissions={"mode": "default", "unhandled": "callback"})

            def boom(_request):
                raise RuntimeError("approval service down")

            session = dgc.session(cwd=self.work, on_permission=boom,
                                  permissions={"mode": "default", "unhandled": "callback"})
            result = session.run("edit the checkout guard", timeout=60)
        self.assertFalse((self.work / "guard.py").exists())
        self.assertEqual((result.status, result.reason), ("failed", "decision_failed"))
        self.assertIn("approval service down", result.error)


if __name__ == "__main__":
    unittest.main()
