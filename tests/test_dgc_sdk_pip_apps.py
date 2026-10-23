"""Pips API 61 in the Python SDK: your app's tools (define_pip_tool, register_app and the rest) and the handler that
serves DGC's signed calls (AppToolHandler: handle, wsgi, asgi, flask). Offline: no runtime, no network."""
from __future__ import annotations

import asyncio
import io
import json
import time
import unittest
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))

from tests.test_dgc_sdk_pips import CAPS, Wire, session  # noqa: E402
from dgc_sdk import (AppToolHandler, DGCConfigError, DGCUnsupportedError, PipToolError, define_pip_tool)  # noqa: E402
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS  # noqa: E402
from dgc_sdk.pips_app import sign  # noqa: E402

SECRET = "dgcapp_" + "1" * 64
VECTOR = "v1=1d8630eb99e1c2fa2d489e08c583f9bae3a4407eaf3d21797c9a1d8a597c542f"   # tests/test_dgc_sdk_pip_apps.mjs too
UNPAID = define_pip_tool("find_unpaid_orders", "Orders unpaid after N days",
                         {"type": "object", "properties": {"days": {"type": "integer"}}, "required": ["days"]}, kind="read")
DISPATCH = define_pip_tool("create_dispatch", "Create a dispatch for one order",
                           {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
                           kind="change")
COMMANDS = ("register_app", "update_app", "accept_app_update", "list_apps", "remove_app", "rotate_app_secret")


def signed(body: dict, *, secret=SECRET, timestamp=None, nonce=None):
    raw = json.dumps(body).encode()
    timestamp = str(int(time.time())) if timestamp is None else timestamp
    nonce = nonce or __import__("os").urandom(16).hex()
    return {"X-DGC-Timestamp": timestamp, "X-DGC-Nonce": nonce, "X-DGC-Signature": sign(secret, timestamp, nonce, raw)}, raw


def call(tool="find_unpaid_orders", arguments=None, **extra):
    return {"type": "tool_call", "app": "shop", "tool": tool, "arguments": {"days": 7} if arguments is None else arguments,
            "pip_id": "pip_" + "a" * 32, "run_id": "run_" + "b" * 32, "call_id": "call_" + "c" * 32, **extra}


class PipAppCommandTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import _COMMAND_ARGS
        for command in COMMANDS:
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
        self.assertIn("list_apps", READ_COMMANDS)
        for command in set(COMMANDS) - {"list_apps"}:
            self.assertIn(command, MUTATION_COMMANDS)

    def test_refused_before_api61_checked_then_sent_with_the_tools_as_the_wire_has_them(self):
        wire = Wire()
        old = session(wire, caps={**CAPS, "pips_api_version": 60})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 61"):
            old.pips.read("list_apps", {})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 61"):
            old.pips.register_app("shop", url="https://shop.example.com/dgc/pips", tools=[UNPAID], approved=True)
        with self.assertRaisesRegex(DGCUnsupportedError, "API 61"):
            old.pips.mutate("propose_pip_update", {"pip_id": "pip_x", "expected_version": 1, "changes": {"app_plan": {
                "schema_version": 1, "server": "app:shop", "connection_digest": "0" * 64, "calls": []}}}, approved=True)
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, "pips_api_version": 61})
        with self.assertRaises(DGCConfigError):
            current.pips.register_app("shop", url="https://shop.example.com/dgc/pips", tools=[UNPAID])   # not approved
        for name, url, tools in (("Shop", "https://shop.example.com/", [UNPAID]), ("shop", "http://shop.example.com/", [UNPAID]),
                                 ("shop", "https://shop.example.com/", []), ("shop", "https://shop.example.com/", ["find"]),
                                 ("shop", "https://shop.example.com/", [{**UNPAID.to_wire(), "extra": 1}])):
            with self.subTest(name=name, url=url):
                with self.assertRaises(DGCConfigError):
                    current.pips.register_app(name, url=url, tools=tools, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.accept_app_update("shop", "nope", approved=True)
        self.assertFalse(wire.calls, "nothing left the process")
        sent = current.pips.register_app("shop", url="http://127.0.0.1:5005/dgc/pips", tools=[UNPAID, DISPATCH], approved=True)
        self.assertEqual(sent["request"]["tools"], [UNPAID.to_wire(), DISPATCH.to_wire()])
        self.assertEqual(sent["request"]["tools"][1]["kind"], "change")
        self.assertEqual(current.pips.update_app("shop", tools=[UNPAID], approved=True)["request"]["tools"], [UNPAID.to_wire()])
        self.assertEqual(current.pips.list_apps()["request"]["type"], "list_apps")
        digest = "f" * 64
        self.assertEqual(current.pips.accept_app_update("shop", digest, approved=True)["request"]["expected_digest"], digest)
        for command in ("remove_app", "rotate_app_secret"):
            self.assertEqual(current.pips.mutate(command, {"name": "shop"}, approved=True)["request"]["name"], "shop")

    def test_define_pip_tool_checks_what_it_describes(self):
        self.assertEqual(DISPATCH.to_wire(), {"name": "create_dispatch", "description": "Create a dispatch for one order",
                                              "input_schema": dict(DISPATCH.input_schema), "kind": "change"})
        money = define_pip_tool("refund", "Refund an order", {"type": "object"}, "change", moves_money=True)
        self.assertTrue(money.to_wire()["moves_money"])
        for args in (("1bad", "x", {"type": "object"}, "read"), ("ok", "", {"type": "object"}, "read"),
                     ("ok", "x", {"type": "object"}, "write"), ("ok", "x", {"type": "string"}, "read"),
                     ("ok", "x", {"type": "object", "properties": {"a": {"$ref": "#"}}}, "read"),
                     ("ok", "x", {"type": "object", "anyOf": []}, "read")):
            with self.subTest(args=args):
                with self.assertRaises(DGCConfigError):
                    define_pip_tool(*args)
        with self.assertRaises(DGCConfigError):
            define_pip_tool("ok", "x", {"type": "object"}, "read", moves_money=True)


class AppToolHandlerTests(unittest.TestCase):
    def setUp(self):
        self.ran = []

        def unpaid(args, ctx):
            self.ran.append(("unpaid", ctx))
            return [{"id": "ord_17", "days": args["days"]}]

        def dispatch(args, ctx):
            if args["order_id"] == "ord_99":
                raise PipToolError("order ord_99 isn't unpaid")
            self.ran.append(("dispatch", ctx))
            return {"dispatch": "dsp_1", "receipt": ctx.approval_id}
        self.handler = AppToolHandler(SECRET, tools={UNPAID: unpaid, "create_dispatch": dispatch}, definitions=[DISPATCH])

    def answer(self, headers, raw, handler=None):
        status, out_headers, body = (handler or self.handler).handle(headers, raw)
        self.assertEqual(out_headers["Content-Type"], "application/json")
        return status, json.loads(body)

    def test_the_signature_matches_dgcs(self):
        self.assertEqual(sign(SECRET, "1767225600", "0123456789abcdef0123456789abcdef", b'{"type":"tool_call"}'), VECTOR)

    def test_a_signed_call_runs_and_anything_else_is_refused(self):
        headers, raw = signed(call())
        status, said = self.answer(headers, raw)
        self.assertEqual((status, said), (200, {"ok": True, "result": [{"id": "ord_17", "days": 7}]}))
        ctx = self.ran[0][1]
        self.assertEqual((ctx.app, ctx.tool, ctx.kind, ctx.pip_id, ctx.action_id), ("shop", "find_unpaid_orders", "read", "pip_" + "a" * 32, None))
        self.assertEqual(self.answer(headers, raw)[1]["error"]["code"], "replayed", "a nonce is used once")
        headers, raw = signed(call())
        self.assertEqual(self.answer(headers, raw.replace(b"7", b"1"))[1]["error"]["code"], "bad_signature", "a tampered body")
        headers, raw = signed(call(), timestamp=str(int(time.time()) - 301))
        self.assertEqual(self.answer(headers, raw)[1]["error"]["code"], "stale")
        headers, raw = signed(call(), secret="dgcapp_" + "2" * 64)
        self.assertEqual(self.answer(headers, raw)[1]["error"]["code"], "bad_signature", "the wrong secret")
        self.assertEqual(self.answer({}, raw)[1]["error"]["code"], "unsigned")
        headers, raw = signed(call())
        self.assertEqual(self.answer({k.lower(): v for k, v in headers.items()}, raw)[0], 200, "header names in any case")
        headers, raw = signed(call(arguments={"days": "seven"}))
        status, said = self.answer(headers, raw)
        self.assertEqual((status, said["error"]["code"]), (400, "invalid_arguments"))
        self.assertIn("$.days should be integer", said["error"]["message"])
        headers, raw = signed(call("nope", {}))
        self.assertEqual(self.answer(headers, raw)[0], 404)
        self.assertEqual(len(self.ran), 2)

    def test_a_change_needs_its_accepted_action_and_refuses_in_its_own_words(self):
        headers, raw = signed(call("create_dispatch", {"order_id": "ord_17"}))
        self.assertEqual(self.answer(headers, raw)[1]["error"]["code"], "not_accepted")
        accepted = {"action_id": "appaction_" + "d" * 32, "action_digest": "e" * 64}
        headers, raw = signed(call("create_dispatch", {"order_id": "ord_17"}, **accepted))
        self.assertEqual(self.answer(headers, raw)[1], {"ok": True, "result": {"dispatch": "dsp_1", "receipt": "appaction_" + "d" * 32}})
        headers, raw = signed(call("create_dispatch", {"order_id": "ord_99"}, **accepted))
        self.assertEqual(self.answer(headers, raw), (422, {"ok": False, "error": {"code": "tool_refused", "message": "order ord_99 isn't unpaid"}}))

    def test_a_failing_tool_answers_in_words_and_a_tool_needs_its_definition(self):
        def broken(args, ctx):
            raise RuntimeError("database password is hunter2")
        handler = AppToolHandler(SECRET, tools={UNPAID: broken})
        headers, raw = signed(call())
        with self.assertLogs("dgc_sdk.pips_app", "ERROR"):
            status, said = self.answer(headers, raw, handler)
        self.assertEqual((status, said["error"]["message"]), (500, "The tool failed."), "its details stay in the app")
        with self.assertRaises(DGCConfigError):
            AppToolHandler(SECRET, tools={"find_unpaid_orders": broken})
        with self.assertRaises(DGCConfigError):
            AppToolHandler("", tools={UNPAID: broken})

    def test_nonces_are_bounded(self):
        handler = AppToolHandler(SECRET, tools={UNPAID: lambda a, c: 1}, max_nonces=3)
        for _ in range(10):
            headers, raw = signed(call())
            self.assertEqual(handler.handle(headers, raw)[0], 200)
        self.assertLessEqual(len(handler._nonces), 3)

    def test_wsgi_and_asgi_serve_it_and_async_tools_need_asgi(self):
        headers, raw = signed(call())
        environ = {"REQUEST_METHOD": "POST", "CONTENT_LENGTH": str(len(raw)), "wsgi.input": io.BytesIO(raw),
                   **{"HTTP_" + k.upper().replace("-", "_"): v for k, v in headers.items()}}
        started = []
        body = b"".join(self.handler.wsgi(environ, lambda status, hs: started.append((status, hs))))
        self.assertEqual(started[0][0], "200 OK")
        self.assertTrue(json.loads(body)["ok"])
        self.assertEqual(self.handler.wsgi({"REQUEST_METHOD": "GET"}, lambda s, h: started.append((s, h))) and started[-1][0],
                         "405 Method Not Allowed")

        async def unpaid(args, ctx):
            return {"async": True}
        handler = AppToolHandler(SECRET, tools={UNPAID: unpaid})
        headers, raw = signed(call())
        self.assertEqual(json.loads(handler.handle(headers, raw)[2])["error"]["code"], "async_tool")
        headers, raw = signed(call())
        sent, chunks = [], [{"type": "http.request", "body": raw[:10], "more_body": True},
                            {"type": "http.request", "body": raw[10:], "more_body": False}]

        async def receive():
            return chunks.pop(0)

        async def send(message):
            sent.append(message)
        scope = {"type": "http", "method": "POST",
                 "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}
        asyncio.run(handler.asgi(scope, receive, send))
        self.assertEqual(sent[0]["status"], 200)
        self.assertEqual(json.loads(sent[1]["body"]), {"ok": True, "result": {"async": True}})

    def test_flask_is_imported_only_by_its_adapter(self):
        import subprocess
        code = ("import sys; sys.path.insert(0, %r); import dgc_sdk, dgc_sdk.pips_app; "
                "print(any(m in sys.modules for m in ('flask', 'starlette', 'fastapi', 'werkzeug')))") % str(ROOT / "sdk/python")
        out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.strip()
        self.assertEqual(out, "False")
        try:
            import flask  # noqa: F401
        except ImportError:
            self.skipTest("Flask is not installed here")
        app = flask.Flask("shop")
        app.add_url_rule("/dgc/pips", "pips", lambda: self.handler.flask(flask.request), methods=["POST"])
        headers, raw = signed(call())
        response = app.test_client().post("/dgc/pips", data=raw, headers=headers, content_type="application/json")
        self.assertEqual((response.status_code, response.get_json()["ok"]), (200, True))


if __name__ == "__main__":
    unittest.main()
