"""Pips API 63 in the Python SDK: events from your app. pips.trigger (trigger_app_event: no approved=True, its payload
outside the 32 KiB budget and bounded to 32 KB of JSON, refused before API 63 and checked before anything is sent),
pips.events (list_app_events) and list_pip_routines' app_events. Offline wire, then once through a real runtime."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))

from tests.test_dgc_sdk_pips import CAPS, Wire, session  # noqa: E402
from dgc_sdk import AsyncPips, DGCConfigError, DGCUnsupportedError  # noqa: E402
from dgc_sdk.pips import COMMAND_FIELDS, EVENT_COMMANDS, MUTATION_COMMANDS, READ_COMMANDS  # noqa: E402

ORDER = {"order_id": "ORD-1041", "total": 1200}


class TriggerTests(unittest.TestCase):
    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import CONTROL_COMMANDS, _COMMAND_ARGS
        for command in ("trigger_app_event", "list_app_events", "list_pip_routines"):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
            self.assertIn(command, CONTROL_COMMANDS)
        self.assertIn("list_app_events", READ_COMMANDS)
        self.assertEqual(EVENT_COMMANDS, {"trigger_app_event"})
        self.assertNotIn("trigger_app_event", MUTATION_COMMANDS | READ_COMMANDS, "neither a read nor an approved mutation")

    def test_trigger_needs_no_approval_is_refused_before_api63_and_checked_before_anything_is_sent(self):
        wire = Wire()
        old = session(wire, caps={**CAPS, "pips_api_version": 62})
        with self.assertRaisesRegex(DGCUnsupportedError, "API 63"):
            old.pips.trigger("shop", "order.created", ORDER, idempotency_key="ORD-1041")
        with self.assertRaisesRegex(DGCUnsupportedError, "API 63"):
            old.pips.events("shop")
        with self.assertRaisesRegex(DGCUnsupportedError, "API 63"):
            old.pips.read("list_pip_routines", {"pip_id": "pip_x", "app_events": True})
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, "pips_api_version": 63})
        bad = [(("Shop", "order.created", ORDER), "ORD-1"), (("shop", "Order Created", ORDER), "ORD-1"),
               (("shop", "order.created", ORDER), ""), (("shop", "order.created", ORDER), "a\nb"),
               (("shop", "order.created", ORDER), "x" * 201), (("shop", "order.created", {"blob": "x" * 33000}), "ORD-1"),
               (("shop", "order.created", {"n": float("inf")}), "ORD-1"), (("shop", "order.created", {1: "x"}), "ORD-1"),
               (("shop", "order.created", {"when": object()}), "ORD-1")]
        for args, key in bad:
            with self.subTest(args=str(args)[:60], key=key[:10]), self.assertRaises(DGCConfigError):
                current.pips.trigger(*args, idempotency_key=key)
        with self.assertRaisesRegex(DGCConfigError, "this one is 33 KB"):
            current.pips.trigger("shop", "order.created", {"blob": "x" * 33000}, idempotency_key="k")
        with self.assertRaises(DGCConfigError):
            current.pips.events("shop", limit=0)
        with self.assertRaises(DGCConfigError):
            current.pips.read("list_pip_routines", {"pip_id": "pip_x", "app_events": "yes"})
        self.assertFalse(wire.calls, "nothing left the process")
        sent = current.pips.trigger("shop", "order.created", ORDER, idempotency_key="ORD-1041")["request"]
        self.assertEqual({k: sent[k] for k in ("type", "app", "event", "payload", "idempotency_key")},
                         {"type": "trigger_app_event", "app": "shop", "event": "order.created", "payload": ORDER,
                          "idempotency_key": "ORD-1041"})
        bare = current.pips.trigger("shop", "order.paid", idempotency_key="k2")["request"]
        self.assertNotIn("payload", bare, "no payload: none sent")
        big = {"lines": ["x" * 1000 for _ in range(30)]}           # 30 KB: outside the 32 KiB request budget
        self.assertEqual(current.pips.trigger("shop", "order.created", big, idempotency_key="k3")["request"]["payload"], big)
        listed = current.pips.events("shop", limit=5)["request"]
        self.assertEqual((listed["type"], listed["app"], listed["limit"]), ("list_app_events", "shop", 5))
        self.assertIs(current.pips.read("list_pip_routines", {"pip_id": "pip_x", "app_events": True})["request"]["app_events"], True)

    def test_plan_mode_refuses_it_and_the_async_pips_has_it(self):
        planning = session(Wire(), caps={**CAPS, "pips_api_version": 63}, permission_mode="plan")
        with self.assertRaisesRegex(DGCUnsupportedError, "plan mode"):
            planning.pips.trigger("shop", "order.created", ORDER, idempotency_key="k")
        current = session(Wire(), caps={**CAPS, "pips_api_version": 63})
        pips = AsyncPips(current.pips)
        sent = asyncio.run(pips.trigger("shop", "order.created", ORDER, idempotency_key="k"))["request"]
        self.assertEqual(sent["type"], "trigger_app_event")
        self.assertEqual(asyncio.run(pips.events("shop"))["request"]["type"], "list_app_events")


class ThroughTheRuntimeTests(unittest.TestCase):
    """The SDK's request, as the runtime takes it: the editor bridge's bounds, then handle_control."""

    def test_the_request_the_sdk_sends_is_one_the_runtime_takes_payload_and_all(self):
        from dgc.headless import _bounded_pips_command
        current = session(Wire(), caps={**CAPS, "pips_api_version": 63})
        big = {"lines": ["x" * 1000 for _ in range(30)]}
        request = current.pips.trigger("shop", "order.created", big, idempotency_key="ORD-7")["request"]
        bounded = _bounded_pips_command({"type": "pips_control", "request": request})["request"]
        self.assertEqual(bounded, request)


if __name__ == "__main__":
    unittest.main()
