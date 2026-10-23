"""Pips API 62 in the Python SDK: approvals in your app. pips.pending and pips.decide (list_app_approvals and
decide_app_approval, refused before API 62 and checked before anything is sent), and AppToolHandler's
on_approval_requested and on_approval_resolved (the same signature checks; 204 with no callback). Offline."""
from __future__ import annotations

import asyncio
import io
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))

from tests.test_dgc_sdk_pips import CAPS, Wire, session  # noqa: E402
from tests.test_dgc_sdk_pip_apps import DISPATCH, SECRET, UNPAID, call, signed  # noqa: E402
from dgc_sdk import (AppToolHandler, DGCConfigError, DGCUnsupportedError, PipApprovalRequested,  # noqa: E402
                     PipApprovalResolved)
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS  # noqa: E402

ACTION = "appaction_" + "d" * 32
DIGEST = "e" * 64


def requested(**extra):
    return {"type": "approval_requested", "app": "shop", "action_id": ACTION, "action_digest": DIGEST,
            "tool": "create_dispatch", "arguments": {"order_id": "ord_17"}, "pip_id": "pip_" + "a" * 32,
            "pip_name": "Asha", "run_id": "run_" + "b" * 32, "summary": "Asha asks to run create_dispatch (order_id ord_17) in Shop app.",
            "expires_at": "2026-10-25T09:00:00.000Z", "moves_money": False, **extra}


def resolved(**extra):
    return {"type": "approval_resolved", "app": "shop", "action_id": ACTION, "tool": "create_dispatch",
            "decision": "accepted", "by": "app", "at": "2026-10-24T09:01:00.000Z", **extra}


class ApprovalCommandTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import CONTROL_COMMANDS, _COMMAND_ARGS
        for command in ("list_app_approvals", "decide_app_approval"):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
            self.assertIn(command, CONTROL_COMMANDS)
        self.assertIn("list_app_approvals", READ_COMMANDS)
        self.assertIn("decide_app_approval", MUTATION_COMMANDS)
        from dgc.headless import PIPS_API_VERSION
        self.assertEqual(PIPS_API_VERSION, 62)

    def test_pending_and_decide_are_refused_before_api62_checked_then_sent(self):
        wire = Wire()
        old = session(wire, caps={**CAPS, "pips_api_version": 61})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 62"):
            old.pips.pending()
        with self.assertRaisesRegex(DGCUnsupportedError, "API 62"):
            old.pips.decide(ACTION, "accept", expected_digest=DIGEST, approved=True)
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, "pips_api_version": 62})
        with self.assertRaises(DGCConfigError):
            current.pips.decide(ACTION, "accept", expected_digest=DIGEST)          # not approved
        for action_id, decision, digest in ((ACTION, "allow", DIGEST), ("appaction_x", "accept", DIGEST),
                                            ("conndraft_" + "d" * 32, "accept", DIGEST), (ACTION, "reject", "nope")):
            with self.subTest(action_id=action_id, decision=decision):
                with self.assertRaises(DGCConfigError):
                    current.pips.decide(action_id, decision, expected_digest=digest, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.pending("Shop")
        self.assertFalse(wire.calls, "nothing left the process")
        everything = current.pips.pending()["request"]
        self.assertEqual((everything["type"], "app" in everything), ("list_app_approvals", False))
        self.assertEqual(current.pips.pending("shop")["request"]["app"], "shop")
        sent = current.pips.decide(ACTION, "reject", expected_digest=DIGEST, approved=True)["request"]
        self.assertEqual({k: sent[k] for k in ("type", "action_id", "decision", "expected_digest")},
                         {"type": "decide_app_approval", "action_id": ACTION, "decision": "reject", "expected_digest": DIGEST})

    def test_the_async_pips_has_them_too(self):
        from dgc_sdk import AsyncPips
        wire = Wire()
        current = session(wire, caps={**CAPS, "pips_api_version": 62})
        pips = AsyncPips(current.pips)
        self.assertEqual(asyncio.run(pips.pending("shop"))["request"]["type"], "list_app_approvals")
        out = asyncio.run(pips.decide(ACTION, "accept", expected_digest=DIGEST, approved=True))
        self.assertEqual(out["request"]["decision"], "accept")


class ApprovalHandlerTests(unittest.TestCase):
    def setUp(self):
        self.seen = []
        self.handler = AppToolHandler(SECRET, tools={UNPAID: lambda a, c: [], DISPATCH: lambda a, c: {}},
                                      on_approval_requested=self.seen.append, on_approval_resolved=self.seen.append)

    def answer(self, handler, body, **kwargs):
        headers, raw = signed(body, **kwargs)
        return handler.handle(headers, raw)

    def test_without_a_callback_it_answers_204_after_the_same_checks(self):
        quiet = AppToolHandler(SECRET, tools={UNPAID: lambda a, c: []})
        for body in (requested(), resolved()):
            status, headers, out = self.answer(quiet, body)
            self.assertEqual((status, out), (204, b""), body["type"])
        status, _, out = self.answer(quiet, requested(), secret="dgcapp_" + "2" * 64)
        self.assertEqual((status, json.loads(out)["error"]["code"]), (401, "bad_signature"), "still signed")
        headers, raw = signed(requested())
        self.assertEqual(quiet.handle(headers, raw)[0], 204)
        self.assertEqual(json.loads(quiet.handle(headers, raw)[2])["error"]["code"], "replayed", "and still once a nonce")
        status, _, _ = self.answer(quiet, requested(), timestamp="1")
        self.assertEqual(status, 401, "and still on time")

    def test_a_callback_gets_the_event_once_its_signature_checks_out(self):
        status, _, out = self.answer(self.handler, requested())
        self.assertEqual((status, json.loads(out)), (200, {"ok": True}))
        [event] = self.seen
        self.assertIsInstance(event, PipApprovalRequested)
        self.assertEqual((event.action_id, event.action_digest, event.tool, event.arguments, event.pip_name, event.moves_money),
                         (ACTION, DIGEST, "create_dispatch", {"order_id": "ord_17"}, "Asha", False))
        status, _, _ = self.answer(self.handler, resolved(decision="expired", by="dgc"))
        self.assertEqual(status, 200)
        self.assertIsInstance(self.seen[-1], PipApprovalResolved)
        self.assertEqual((self.seen[-1].decision, self.seen[-1].by), ("expired", "dgc"))
        headers, raw = signed(requested())
        self.assertEqual(self.handler.handle(headers, raw.replace(b"ord_17", b"ord_99"))[0], 401, "a tampered event")
        self.assertEqual(self.handler.handle({}, raw)[0], 401, "an unsigned one")
        self.assertEqual(len(self.seen), 2, "neither reached the callback")
        for bad in (requested(action_id="x"), requested(action_digest="y"), requested(moves_money="no"),
                    resolved(decision="maybe"), {"type": "approval_resolved", "app": "shop"}):
            with self.subTest(bad=bad):
                status, _, out = self.answer(self.handler, bad)
                self.assertEqual((status, json.loads(out)["error"]["code"]), (400, "invalid_request"))
        self.assertEqual(len(self.seen), 2)

    def test_a_failing_callback_answers_500_so_dgc_tries_again_and_its_details_stay(self):
        def broken(event):
            raise RuntimeError("database password is hunter2")
        handler = AppToolHandler(SECRET, tools={UNPAID: lambda a, c: []}, on_approval_requested=broken)
        with self.assertLogs("dgc_sdk.pips_app", "ERROR"):
            status, _, out = self.answer(handler, requested())
        self.assertEqual((status, json.loads(out)["error"]["code"]), (500, "callback_failed"))
        self.assertNotIn(b"hunter2", out)
        self.assertEqual(self.answer(handler, resolved())[0], 204, "the other kind has no callback")
        with self.assertRaises(DGCConfigError):
            AppToolHandler(SECRET, tools={UNPAID: lambda a, c: []}, on_approval_resolved="nope")

    def test_wsgi_and_asgi_serve_events_and_asgi_awaits_an_async_callback(self):
        headers, raw = signed(requested())
        environ = {"REQUEST_METHOD": "POST", "CONTENT_LENGTH": str(len(raw)), "wsgi.input": io.BytesIO(raw),
                   **{"HTTP_" + k.upper().replace("-", "_"): v for k, v in headers.items()}}
        started = []
        body = b"".join(AppToolHandler(SECRET, tools={UNPAID: lambda a, c: []}).wsgi(environ, lambda s, h: started.append(s)))
        self.assertEqual((started[0], body), ("204 No Content", b""))
        got = []

        async def later(event):
            got.append(event)
        handler = AppToolHandler(SECRET, tools={UNPAID: lambda a, c: []}, on_approval_resolved=later)
        headers, raw = signed(resolved())
        self.assertEqual(json.loads(handler.handle(headers, raw)[2])["error"]["code"], "async_callback")
        headers, raw = signed(resolved())
        sent = []

        async def receive():
            return {"type": "http.request", "body": raw, "more_body": False}

        async def send(message):
            sent.append(message)
        asyncio.run(handler.asgi({"type": "http", "method": "POST",
                                  "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()]}, receive, send))
        self.assertEqual(sent[0]["status"], 200)
        self.assertEqual([e.action_id for e in got], [ACTION])

    def test_a_tool_call_is_still_a_tool_call(self):
        status, _, out = self.answer(self.handler, call())
        self.assertEqual((status, json.loads(out)), (200, {"ok": True, "result": []}))
        self.assertEqual(self.seen, [])


if __name__ == "__main__":
    unittest.main()
