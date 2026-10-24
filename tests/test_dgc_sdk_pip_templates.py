"""Pips API 64 in the Python SDK: Pip templates in code. PipTemplate (checked before anything is sent), pips.ensure,
pips.ensure_all (every template checked first, then each ensured, then prune), pips.templates and
pips.decide_template_change, all refused before API 64. Offline wire, then the SDK's own requests through a real
runtime (handle_control, with the shop app registered for real)."""
from __future__ import annotations

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "sdk/python"))

from test_dgc_sdk_pips import CAPS, Wire, session  # noqa: E402
from dgc_sdk import AsyncPips, DGCCommandRejectedError, DGCConfigError, DGCUnsupportedError, PipTemplate  # noqa: E402
from dgc_sdk.pips import COMMAND_FIELDS, MUTATION_COMMANDS, READ_COMMANDS  # noqa: E402

WEEKDAYS = {"kind": "schedule", "schedule": {"type": "cron", "cron": "30 9 * * 1-5", "timezone": "Asia/Kolkata"}}
DUNNING = PipTemplate(key="dunning", name="Dunning", instructions="Chase unpaid orders politely.",
                      tools=["app:shop/find_unpaid_orders"],
                      routines=[{"title": "Unpaid orders", "prompt": "List orders unpaid after 7 days.", "when": WEEKDAYS}])
DISPATCH = PipTemplate(key="dispatch", name="Dispatch", instructions="Get paid orders dispatched.",
                       tools=["app:shop/get_order", "app:shop/create_dispatch"],
                       routines=[{"title": "New orders", "prompt": "Check the order; propose a dispatch.",
                                  "when": {"app": "shop", "event": "order.created"}}])
CHANGE = "tmplchange_" + "a" * 32


class TemplateShapeTests(unittest.TestCase):
    def test_a_template_is_checked_and_normalized_where_it_is_made(self):
        self.assertEqual(DISPATCH.routines[0]["when"], {"kind": "app", "app": "shop", "event": "order.created"},
                         "the short form of an app event")
        self.assertEqual(PipTemplate(key="x", name=" Spaced ", instructions=" Do it. ").name, "Spaced")
        wire = DUNNING.to_wire()
        self.assertEqual(sorted(wire), ["always_allow", "instructions", "key", "level", "name", "routines", "tools"],
                         "no model: DGC's own default")
        self.assertEqual((wire["level"], wire["always_allow"]), ("ask", []))
        bad = [dict(key="Dunning"), dict(key="x" * 41), dict(name=""), dict(name="two\nlines"), dict(instructions=" "),
               dict(level="always"), dict(tools=["gmail"]), dict(tools="app:shop/x"), dict(tools=["app:Shop/x"]),
               dict(tools=["app:shop/x", "app:shop/x"]), dict(always_allow=["app:shop/x"]), dict(model="has space"),
               dict(routines=[{"title": "A", "prompt": "x"}]),
               dict(routines=[{"title": "A", "prompt": "x", "when": {"kind": "email", "query": "from:x"}}]),
               dict(routines=[{"title": "A", "prompt": "x", "when": WEEKDAYS}, {"title": "A", "prompt": "y", "when": WEEKDAYS}]),
               dict(routines=[{"title": "A", "prompt": "x", "when": {"app": "shop", "event": "Order Created"}}]),
               dict(routines=[{"title": "R", "prompt": "x", "when": WEEKDAYS}] * 11)]
        for changes in bad:
            fields = {"key": "dunning", "name": "Dunning", "instructions": "Chase.", **changes}
            with self.subTest(changes=str(changes)[:80]), self.assertRaises(DGCConfigError):
                PipTemplate(**fields)
        from dgc_sdk.pips_templates import template_wire, templates_wire
        self.assertEqual(template_wire(wire), wire, "the dict form is read the same way")
        with self.assertRaisesRegex(DGCConfigError, "no field"):
            template_wire({**wire, "computer": True})
        with self.assertRaisesRegex(DGCConfigError, "share the key dunning"):
            templates_wire([DUNNING, DUNNING])

    def test_the_sdk_knows_the_runtimes_fields(self):
        from dgc.pips import CONTROL_COMMANDS, _COMMAND_ARGS
        for command in ("ensure_pip_template", "prune_pip_templates", "list_pip_templates", "decide_pip_template_change"):
            self.assertEqual(COMMAND_FIELDS[command], _COMMAND_ARGS[command], command)
            self.assertIn(command, CONTROL_COMMANDS)
        self.assertIn("list_pip_templates", READ_COMMANDS)
        self.assertTrue({"ensure_pip_template", "prune_pip_templates", "decide_pip_template_change"} <= MUTATION_COMMANDS)


class EnsureWireTests(unittest.TestCase):
    def test_refused_before_api64_and_checked_before_anything_is_sent(self):
        wire = Wire()
        old = session(wire, caps={**CAPS, "pips_api_version": 63})
        for call in (lambda: old.pips.ensure(DUNNING, approved=True), lambda: old.pips.templates(),
                     lambda: old.pips.ensure_all([DUNNING], prune=True, approved=True),
                     lambda: old.pips.decide_template_change(CHANGE, "accept", expected_digest="0" * 64, approved=True)):
            with self.assertRaisesRegex(DGCUnsupportedError, "API 64"):
                call()
        self.assertFalse(wire.calls)
        current = session(wire, caps={**CAPS, "pips_api_version": 64})
        with self.assertRaisesRegex(DGCConfigError, "approved=True"):
            current.pips.ensure(DUNNING)
        with self.assertRaises(DGCConfigError):
            current.pips.ensure({"key": "dunning"}, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.ensure_all([DUNNING, {"key": "bad key", "name": "x", "instructions": "y"}], approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.ensure_all([DUNNING], prune="yes", approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.decide_template_change("tmplchange_x", "accept", expected_digest="0" * 64, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.decide_template_change(CHANGE, "maybe", expected_digest="0" * 64, approved=True)
        with self.assertRaises(DGCConfigError):
            current.pips.templates("not-a-pip")
        with self.assertRaises(DGCConfigError):
            current.pips.mutate("prune_pip_templates", {"keep": ["Bad Key"]}, approved=True)
        self.assertFalse(wire.calls, "nothing left the process")
        sent = current.pips.ensure(DUNNING, approved=True, accept_widening=True)["request"]
        self.assertEqual((sent["type"], sent["template"], sent["accept_widening"], sent["overwrite_user_changes"]),
                         ("ensure_pip_template", DUNNING.to_wire(), True, False))
        listed = current.pips.templates("pip_" + "b" * 32)["request"]
        self.assertEqual((listed["type"], listed["pip_id"]), ("list_pip_templates", "pip_" + "b" * 32))
        decided = current.pips.decide_template_change(CHANGE, "reject", expected_digest="c" * 64, approved=True)["request"]
        self.assertEqual((decided["type"], decided["decision"]), ("decide_pip_template_change", "reject"))

    def test_ensure_all_ensures_each_then_prunes_with_their_keys(self):
        wire = Wire()
        answers = {"dunning": {"unchanged": True, "waiting": []}, "dispatch": {"unchanged": False, "waiting": [CHANGE]}}

        def answer(event):
            request = event["result"]["request"]
            if request["type"] == "ensure_pip_template":
                event["result"] = {**answers[request["template"]["key"]], "key": request["template"]["key"]}
            elif request["type"] == "prune_pip_templates":
                event["result"] = {"pruned": [{"key": "old", "keep": request["keep"]}], "already": [], "kept": 2}
            return event
        wire.transform = answer
        current = session(wire, caps={**CAPS, "pips_api_version": 64})
        done = current.pips.ensure_all([DUNNING, DISPATCH], prune=True, approved=True)
        self.assertEqual([c[0]["request"]["type"] for c in wire.calls],
                         ["ensure_pip_template", "ensure_pip_template", "prune_pip_templates"])
        self.assertEqual(done["pruned"], [{"key": "old", "keep": ["dunning", "dispatch"]}])
        self.assertEqual((done["waiting"], done["unchanged"]), ([CHANGE], False))
        self.assertEqual([p["key"] for p in done["pips"]], ["dunning", "dispatch"])
        wire.calls.clear()
        self.assertEqual(current.pips.ensure_all([DUNNING], approved=True)["unchanged"], True)
        self.assertEqual([c[0]["request"]["type"] for c in wire.calls], ["ensure_pip_template"], "no prune unless asked")

    def test_plan_mode_refuses_it_and_the_async_pips_has_it(self):
        planning = session(Wire(), caps={**CAPS, "pips_api_version": 64}, permission_mode="plan")
        with self.assertRaisesRegex(DGCUnsupportedError, "plan mode"):
            planning.pips.ensure(DUNNING, approved=True)
        current = session(Wire(), caps={**CAPS, "pips_api_version": 64})
        pips = AsyncPips(current.pips)
        self.assertEqual(asyncio.run(pips.ensure(DUNNING, approved=True))["request"]["type"], "ensure_pip_template")
        self.assertEqual(asyncio.run(pips.templates())["request"]["type"], "list_pip_templates")
        self.assertEqual(asyncio.run(pips.decide_template_change(CHANGE, "accept", expected_digest="d" * 64,
                                                                approved=True))["request"]["type"],
                         "decide_pip_template_change")
        self.assertEqual(len(asyncio.run(pips.ensure_all([DUNNING], approved=True))["pips"]), 1)


from test_pip_templates import TemplateWorld  # noqa: E402


class RuntimeWire:
    """The SDK's requests, as the runtime takes them: the editor bridge's bounds, then handle_control."""

    def __init__(self, world):
        self.world, self.calls = world, []

    def request(self, payload, response, **kwargs):
        from dgc import pips
        from dgc.headless import _bounded_pips_command
        self.calls.append(payload)
        request = _bounded_pips_command(payload)["request"]
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.world.registry), patch.object(self.world.registry, "close"):
            return pips.handle_control(self.world.cfg, request, "editor-user", start_worker=False)


class ThroughTheRuntimeTests(TemplateWorld, unittest.TestCase):
    def setUp(self):
        super().setUp()
        self.s = session(RuntimeWire(self), caps={**CAPS, "pips_api_version": 64})

    def test_the_deploy_step_creates_then_is_unchanged_applies_a_new_time_and_waits_for_a_new_change_tool(self):
        first = self.s.pips.ensure_all([DUNNING, DISPATCH], prune=True, approved=True)
        self.assertEqual([p["created"] for p in first["pips"]], [True, True])
        self.assertEqual((first["pruned"], first["waiting"]), ([], []))
        second = self.s.pips.ensure_all([DUNNING, DISPATCH], prune=True, approved=True)
        self.assertTrue(second["unchanged"])
        later = PipTemplate(key="dunning", name="Dunning", instructions="Chase unpaid orders politely.",
                            tools=["app:shop/find_unpaid_orders"],
                            routines=[{"title": "Unpaid orders", "prompt": "List orders unpaid after 7 days.",
                                       "when": {"schedule": {"type": "cron", "cron": "0 10 * * 1-5",
                                                             "timezone": "Asia/Kolkata"}}}])
        third = self.s.pips.ensure_all([later, DISPATCH], prune=True, approved=True)
        self.assertEqual([a["field"] for a in third["pips"][0]["applied"]], ["routines"])
        self.assertTrue(third["pips"][1]["unchanged"])
        more = PipTemplate(key="dunning", name="Dunning", instructions="Chase unpaid orders politely.",
                           tools=["app:shop/find_unpaid_orders", "app:shop/create_dispatch"], routines=later.routines)
        fourth = self.s.pips.ensure_all([more, DISPATCH], prune=True, approved=True)
        [change_id] = fourth["waiting"]
        [listed] = self.s.pips.templates(fourth["pips"][0]["pip_id"])["templates"]
        self.assertEqual(listed["waiting"]["id"], change_id)
        self.assertEqual(listed["waiting"]["items"][0]["words"], "Use create_dispatch in Shop app, a change")
        decided = self.s.pips.decide_template_change(change_id, "accept", expected_digest=listed["waiting"]["digest"],
                                                     approved=True)
        self.assertEqual(decided["change"]["status"], "accepted")
        self.assertTrue(self.s.pips.ensure_all([more, DISPATCH], prune=True, approved=True)["unchanged"])
        gone = self.s.pips.ensure_all([more], prune=True, approved=True)
        self.assertEqual([p["key"] for p in gone["pruned"]], ["dispatch"])
        with self.assertRaises(DGCCommandRejectedError) as raised:
            self.s.pips.ensure(PipTemplate(key="refunds", name="Refunds", instructions="Refund.",
                                           tools=["app:shop/refund_order"], always_allow=["app:shop/refund_order"]),
                               approved=True, accept_widening=True)
        self.assertEqual(raised.exception.reason, "asks_every_time")


if __name__ == "__main__":
    unittest.main()
