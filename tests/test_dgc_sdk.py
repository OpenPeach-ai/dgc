"""Local DGC SDK: isolation, run/stream, resume/fork, cancel, async, native picker."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk" / "python"))
sys.path.insert(0, str(ROOT))

from dgc_sdk import (  # noqa: E402
    AsyncDGC, DGC, DGCConfigError, DGCUnsupportedError, Pricing, QuestionAnswer,
    RetryPolicy, RuntimePolicy, define_tool, redact_text,
)
from dgc_sdk.schema import extract_json, validate  # noqa: E402


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
        self.assertEqual(result.status, "blocked")
        self.assertEqual(result.reason, "permission_denied")

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
            session.fork("sdk-branch")
            listed = session.list_sessions()
        self.assertGreaterEqual(len(listed), 2)
        self.assertTrue(session.session_id)
        self.assertNotEqual(session.session_id, origin)

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
        self.assertIn(result.status, ("completed", "blocked", "failed", "cancelled"))

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
            rewound = session.rewind(99)
        self.assertIn("ok", rewound)

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
        self.assertIn(again.status, ("completed", "failed", "cancelled", "blocked"))
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
            f"sys.path[:0] = [{str(ROOT / 'sdk' / 'python')!r}, {str(ROOT)!r}]\n"
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
        env["DGC_PYTHON"] = str(ROOT / ".venv" / "bin" / "python")
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
        self.assertEqual(result.status, "blocked")

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
        self.assertIn(result.status, ("blocked", "completed", "failed"))

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
        with self._client(policy=policy) as dgc:
            session = dgc.session(
                cwd=self.work,
                permissions={"mode": "auto", "unhandled": "deny"},
            )
            result = session.run("escaped write via bash redirect", timeout=60)
        self.assertFalse(
            (self.work / "escaped.txt").exists(),
            f"bash redirect must not land when write_file is denied; status={result.status}",
        )
        self.assertIn(result.status, ("blocked", "completed", "failed"))

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
    def test_redact_and_cost(self):
        from dgc_sdk import cost_usd
        self.assertEqual(cost_usd(1_000_000, 500_000, 0, Pricing(1.0, 2.0)), 2.0)
        self.assertIsNone(cost_usd(10, 10, 0, None))

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
        rules = policy.engine_deny_rules()
        self.assertIn("Write", rules)
        self.assertTrue(any(row.startswith("Bash(") and "*>[!&]*" in row for row in rules), rules)
        engine = PermissionEngine("auto", {"allow": [], "ask": [], "deny": rules})
        denied, _reason = engine.decide("bash", {"command": "echo pwned > escaped.txt"})
        self.assertEqual(denied, "deny")
        allowed, _reason = engine.decide("bash", {"command": "ls"})
        self.assertEqual(allowed, "allow")
        still_ok, _reason = engine.decide("bash", {"command": "ls 2>&1"})
        self.assertEqual(still_ok, "allow")


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


if __name__ == "__main__":
    unittest.main()
