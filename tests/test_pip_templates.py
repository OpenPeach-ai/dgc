"""Pips for SDK apps, part 5 (Pips API 64): Pip templates in code.

ensure_pip_template makes a Personal Pip from a template, or brings the one with that key to it: narrowing and neutral
changes apply, widening waits as one change for a person (or applies with accept_widening), a person's own changes in
DGC are kept and reported, and a Pip made from a template uses only the app tools its template lists. The shop app is
registered for real (part 1's fixture: a real HTTP server on 127.0.0.1 serving the SDK's AppToolHandler). No model, no
provider.
"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from tests.test_pip_sdk_apps import AppWorld, DISPATCH, ORDER, REFUND, UNPAID  # noqa: E402
from dgc import pip_action_grants, pip_levels, pip_routines, pip_sdk_apps, pip_templates  # noqa: E402
from dgc.workspace_registry import RegistryError  # noqa: E402
from dgc_sdk.pips_app import define_pip_tool  # noqa: E402

WEEKDAYS = {"kind": "schedule", "schedule": {"type": "cron", "cron": "30 9 * * 1-5", "timezone": "Asia/Kolkata"}}
LATER = {"kind": "schedule", "schedule": {"type": "cron", "cron": "0 10 * * 1-5", "timezone": "Asia/Kolkata"}}
ON_ORDER = {"kind": "app", "app": "shop", "event": "order.created"}
CANCEL = define_pip_tool("cancel_order", "Cancel one order that hasn't shipped",
                         {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]},
                         kind="change")


def dunning(**changes):
    value = {"key": "dunning", "name": "Dunning", "instructions": "Chase unpaid orders politely.",
             "tools": ["app:shop/find_unpaid_orders"],
             "routines": [{"title": "Unpaid orders", "prompt": "Find orders unpaid after 7 days and list them.",
                           "when": WEEKDAYS}]}
    value.update(changes)
    return value


def dispatch(**changes):
    value = {"key": "dispatch", "name": "Dispatch", "instructions": "Get paid orders dispatched.",
             "tools": ["app:shop/get_order", "app:shop/create_dispatch"],
             "routines": [{"title": "New orders", "prompt": "Read the order; if it is paid, propose a dispatch.",
                           "when": ON_ORDER}]}
    value.update(changes)
    return value


class TemplateWorld(AppWorld):
    def setUp(self):
        super().setUp()
        self.register(tools=(UNPAID, ORDER, DISPATCH, REFUND))

    def ensure(self, template, actor="editor-user", **flags):
        return self.control("ensure_pip_template", actor=actor, template=template, **flags)

    def pip(self, answer):
        return self.store._job(answer["pip_id"])

    def level(self, answer):
        return pip_levels.level(self.registry, answer["pip_id"])

    def routines(self, answer):
        return {r["title"]: r for r in pip_routines.listing(self.store, answer["pip_id"], app_events=True)["routines"]}

    def tools(self, pip_id):
        """The app tools a run of this Pip is given, as app:<name>/<tool>."""
        session = pip_sdk_apps.Session(self.cfg, pip_id, "ws", "run_x")
        return sorted(f"app:{a['app']}/{t['tool']}" for a in session.pin(self.registry) for t in a["tools"])

    def grants(self, answer):
        return {g["tool"]: g for g in pip_action_grants.list_grants(self.registry, answer["pip_id"])}

    def waiting(self, answer):
        [template] = self.control("list_pip_templates", pip_id=answer["pip_id"])["templates"]
        return template["waiting"]

    def decide(self, change, decision="accept", digest=None):
        return self.control("decide_pip_template_change", change_id=change["id"], decision=decision,
                            expected_digest=digest or change["digest"])


class CreateTests(TemplateWorld, unittest.TestCase):
    def test_a_template_makes_its_pip_and_the_same_template_again_is_unchanged(self):
        made = self.ensure(dunning())
        self.assertTrue(made["created"])
        self.assertFalse(made["unchanged"])
        self.assertEqual((made["key"], made["name"], made["waiting"], made["conflicts"]), ("dunning", "Dunning", [], []))
        self.assertEqual(made["notice"], "Made Dunning from its template.")
        pip = self.pip(made)
        self.assertEqual((pip["name"], pip["goal"], pip["source_policy"], pip["model_choice"], pip["computer_plan"]),
                         ("Dunning", "Chase unpaid orders politely.", {"mode": "personal"}, {"mode": "default"}, None),
                         "a Personal Pip, no computer unless the template asks for one")
        self.assertEqual(self.registry.get(pip["workspace_id"])["kind"], "personal")
        self.assertEqual(self.level(made), "ask", "a template's Pip asks unless the template says otherwise")
        routine = self.routines(made)["Unpaid orders"]
        self.assertEqual((routine["status"], routine["label"]), ("on", "on weekdays at 09:30"))
        again = self.ensure(dunning())
        self.assertEqual((again["pip_id"], again["created"], again["unchanged"], again["applied"], again["waiting"]),
                         (made["pip_id"], False, True, [], []))
        self.assertEqual(again["notice"], "Dunning already matches its template.")
        self.assertEqual(len(self.routines(made)), 1, "nothing doubled")
        [listed] = self.control("list_pip_templates")["templates"]
        self.assertEqual((listed["key"], listed["pip_id"], listed["tools"], listed["routines"], listed["waiting"]),
                         ("dunning", made["pip_id"], ["app:shop/find_unpaid_orders"], ["Unpaid orders"], None))
        # The key is the Pip's: renaming the template keeps the same Pip.
        renamed = self.ensure(dunning(name="Payment chaser"))
        self.assertEqual((renamed["pip_id"], renamed["created"]), (made["pip_id"], False))
        self.assertEqual(self.pip(made)["name"], "Payment chaser")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pips").fetchone()[0], 3, "two fixture Pips and one")

    def test_a_template_pip_uses_only_its_listed_app_tools_and_every_other_pip_keeps_every_app(self):
        made = self.ensure(dunning())
        self.assertEqual(self.tools(made["pip_id"]), ["app:shop/find_unpaid_orders"])
        self.assertEqual(self.tools(self.source["id"]), ["app:shop/create_dispatch", "app:shop/find_unpaid_orders",
                                                         "app:shop/get_order", "app:shop/refund_order"],
                         "a Pip made by hand keeps every registered app, as before")
        session = pip_sdk_apps.Session(self.cfg, made["pip_id"], self.registry.personal()["id"], "run_x")
        said = session.call(self.registry, "app_tool", {"app": "shop", "tool": "get_order",
                                                        "arguments": {"order_id": "ord_17"}})
        self.assertIn("get_order in Shop app isn't one of your tools", said)
        self.assertEqual(self.shop.requests, [], "refused before the app is called")
        said = session.call(self.registry, "app_tool", {"app": "shop", "tool": "find_unpaid_orders",
                                                        "arguments": {"days": 7}})
        self.assertIn("Untrusted data from the user's Shop app", said)
        self.assertEqual(len(self.shop.requests), 1)
        # Before any template, no table was made, and nothing changed for anyone (an older DGC still opens the state).
        self.assertIsNone(pip_templates.allowed_tools(self.registry.db, self.source["id"]))

    def test_a_tool_the_app_doesnt_have_is_left_out_and_said_and_added_once_it_exists(self):
        made = self.ensure(dispatch(tools=["app:shop/get_order", "app:shop/cancel_order"], routines=[]))
        [missing] = made["unavailable"]
        self.assertEqual(missing["tool"], "app:shop/cancel_order")
        self.assertIn("Shop app has no tool named cancel_order", missing["words"])
        self.assertEqual(self.tools(made["pip_id"]), ["app:shop/get_order"])
        pending = self.control("update_app", name="shop", tools=[t.to_wire() for t in (UNPAID, ORDER, DISPATCH, REFUND, CANCEL)])
        self.assertFalse(pending["applied"])
        waits = self.ensure(dispatch(tools=["app:shop/get_order", "app:shop/cancel_order"], routines=[]))
        self.assertIn("update that adds cancel_order waits for a person in DGC", waits["unavailable"][0]["words"])
        self.control("accept_app_update", name="shop", expected_digest=pending["app"]["pending"]["digest"])
        now = self.ensure(dispatch(tools=["app:shop/get_order", "app:shop/cancel_order"], routines=[]))
        self.assertEqual(now["unavailable"], [])
        [change] = now["waiting"]
        self.assertEqual([i["kind"] for i in self.waiting(now)["items"]], ["tool"], "a new change tool waits")
        self.assertEqual(self.tools(made["pip_id"]), ["app:shop/get_order"])

    def test_the_template_is_checked_and_only_this_computer_ensures(self):
        for bad in (dunning(key="Dunning"), dunning(key="x" * 41), dunning(name=""), dunning(instructions=" "),
                    dunning(name="two\nlines"), dunning(level="always"), dunning(tools=["gmail"]),
                    dunning(tools=["app:shop/find_unpaid_orders", "app:shop/find_unpaid_orders"]),
                    dunning(always_allow=["app:shop/create_dispatch"]), dunning(model="has space"),
                    dunning(routines=[{"title": "Mail", "prompt": "Read it", "when": {"kind": "email", "query": "from:x"}}]),
                    dunning(routines=[{"title": "A", "prompt": "x", "when": WEEKDAYS}, {"title": "A", "prompt": "y", "when": LATER}]),
                    dunning(routines=[{"title": "A", "prompt": "x"}]), {**dunning(), "extra": 1}):
            with self.subTest(bad=json.dumps(bad)[:90]), self.assertRaises(RegistryError) as raised:
                self.ensure(bad)
            self.assertEqual(raised.exception.code, "invalid_template")
        with self.assertRaises(RegistryError) as raised:
            self.ensure(dunning(), actor="device_1")
        self.assertEqual(raised.exception.code, "local_only")
        with self.assertRaises(RegistryError) as raised:
            self.ensure(dunning(), accept_widening="yes")
        self.assertEqual(raised.exception.code, "invalid_request")
        self.assertEqual(self.control("list_pip_templates"), {"templates": []}, "nothing was made")


class NarrowingTests(TemplateWorld, unittest.TestCase):
    def test_each_narrowing_or_neutral_change_is_applied(self):
        full = dispatch(level="approve", tools=["app:shop/find_unpaid_orders", "app:shop/get_order", "app:shop/create_dispatch"],
                        always_allow=["app:shop/create_dispatch"],
                        routines=[{"title": "Unpaid orders", "prompt": "List unpaid orders.", "when": WEEKDAYS},
                                  {"title": "New orders", "prompt": "Check it.", "when": ON_ORDER}])
        made = self.ensure(full, accept_widening=True)
        self.assertIn("create_dispatch", self.grants(made))
        self.assertEqual(self.level(made), "approve")
        narrow = dispatch(name="Dispatcher", instructions="Only check orders now.", level="ask",
                          tools=["app:shop/find_unpaid_orders"],
                          routines=[{"title": "Unpaid orders", "prompt": "List unpaid orders older than 7 days.",
                                     "when": LATER}])
        done = self.ensure(narrow)
        self.assertEqual((done["created"], done["unchanged"], done["waiting"], done["conflicts"]), (False, False, [], []))
        fields = sorted((a["field"], a.get("item")) for a in done["applied"])
        self.assertEqual(fields, [("always_allow", "app:shop/create_dispatch"), ("instructions", None), ("level", None),
                                  ("name", None), ("routines", "New orders"), ("routines", "Unpaid orders"),
                                  ("tools", "app:shop/create_dispatch"), ("tools", "app:shop/get_order")])
        pip = self.pip(made)
        self.assertEqual((pip["name"], pip["goal"]), ("Dispatcher", "Only check orders now."))
        self.assertEqual(self.level(made), "ask", "a lower level applies at once")
        self.assertEqual(self.grants(made), {}, "the Always allow the template gave is taken back")
        self.assertEqual(self.tools(made["pip_id"]), ["app:shop/find_unpaid_orders"])
        routines = self.routines(made)
        self.assertEqual(sorted(routines), ["Unpaid orders"], "a removed routine is removed")
        self.assertEqual((routines["Unpaid orders"]["label"], routines["Unpaid orders"]["prompt"]),
                         ("on weekdays at 10:00", "List unpaid orders older than 7 days."), "a schedule time applies")
        self.assertEqual(self.ensure(narrow)["unchanged"], True)
        versions = self.store.versions(made["pip_id"])["versions"]
        self.assertEqual(versions[0]["reason"], "From your code (template dispatch)")

    def test_a_new_read_tool_and_a_new_schedule_routine_apply_and_a_new_model_too(self):
        made = self.ensure(dunning())
        with patch("dgc.pip_models._catalog", return_value={"fixture", "other-model"}):
            done = self.ensure(dunning(model="other-model", tools=["app:shop/find_unpaid_orders", "app:shop/get_order"],
                                       routines=[*dunning()["routines"],
                                                 {"title": "Weekly", "prompt": "Sum up the week.", "when": LATER}]))
        self.assertEqual(done["waiting"], [])
        self.assertEqual(self.tools(made["pip_id"]), ["app:shop/find_unpaid_orders", "app:shop/get_order"])
        self.assertEqual(sorted(self.routines(made)), ["Unpaid orders", "Weekly"])
        self.assertEqual(self.pip(made)["model_choice"], {"mode": "model", "model": "other-model"})
        with patch("dgc.pip_models._catalog", return_value={"fixture"}), self.assertRaises(RegistryError) as raised:
            self.ensure(dunning(model="gone-model"))
        self.assertEqual(raised.exception.code, "model_not_available")


class WideningTests(TemplateWorld, unittest.TestCase):
    WIDE = dict(level="approve", tools=["app:shop/find_unpaid_orders", "app:shop/create_dispatch", "computer"],
                always_allow=["app:shop/create_dispatch"],
                routines=[*dunning()["routines"], {"title": "New orders", "prompt": "Check it.", "when": ON_ORDER}])

    def test_each_widening_waits_as_one_change_and_a_person_accepts_it(self):
        made = self.ensure(dunning())
        asked = self.ensure(dunning(**self.WIDE))
        self.assertEqual((asked["applied"], asked["unchanged"], asked["conflicts"]), ([], False, []))
        [change_id] = asked["waiting"]
        self.assertRegex(change_id, r"^tmplchange_[0-9a-f]{32}$")
        change = self.waiting(made)
        self.assertEqual([i["kind"] for i in change["items"]], ["tool", "computer", "always_allow", "level", "routine"])
        self.assertEqual([i["words"] for i in change["items"]], [
            "Use create_dispatch in Shop app, a change", "Have its own computer: a browser, a Terminal and files",
            "Run create_dispatch in Shop app without asking", "Ask less: Approve for me (now Ask)",
            "A routine, New orders: when the shop app sends order.created"])
        self.assertTrue(asked["notice"].startswith("A change waits for a person on Dunning's page in DGC: Use "
                                                   "create_dispatch in Shop app, a change;"), asked["notice"])
        self.assertNotIn("already matches", asked["notice"], "not while something waits")
        # Nothing of it is the Pip's yet.
        self.assertEqual(self.level(made), "ask")
        self.assertEqual(self.tools(made["pip_id"]), ["app:shop/find_unpaid_orders"])
        self.assertEqual((self.grants(made), self.pip(made)["computer_plan"]), ({}, None))
        self.assertEqual(sorted(self.routines(made)), ["Unpaid orders"])
        # The same template again: the same change still waits, nothing new.
        again = self.ensure(dunning(**self.WIDE))
        self.assertEqual((again["unchanged"], again["waiting"]), (True, [change_id]))
        with self.assertRaises(RegistryError) as raised:
            self.decide(change, digest="0" * 64)
        self.assertEqual(raised.exception.code, "template_conflict")
        decided = self.decide(change)
        self.assertTrue(decided["decided"])
        self.assertEqual(decided["change"]["status"], "accepted")
        self.assertEqual(self.level(made), "approve")
        self.assertEqual(self.tools(made["pip_id"]), ["app:shop/create_dispatch", "app:shop/find_unpaid_orders"])
        grant = self.grants(made)["create_dispatch"]
        self.assertEqual((grant["server"], grant["account"]), ("app:shop", "connection_managed"))
        self.assertEqual(self.pip(made)["computer_plan"], {"schema_version": 1})
        self.assertEqual(self.routines(made)["New orders"]["label"], "when the shop app sends order.created")
        self.assertEqual(self.decide(change)["decided"], False, "exactly once")
        self.assertEqual(self.ensure(dunning(**self.WIDE))["unchanged"], True, "accepted means applied")
        # The Always allow it got is a real one: the Pip's next run sends that change without asking.
        payload = {"kind": "connector_call", "server": "app:shop", "connection_digest": grant["connection_digest"],
                   "account": "connection_managed", "schema_digest": grant["schema_digest"],
                   "call": {"tool": "create_dispatch", "arguments": {"order_id": "ord_17"}},
                   "source": {"pip_id": made["pip_id"]}}
        pip_action_grants.check(self.store, "pip-grant:" + grant["id"], payload)

    def test_a_routine_moved_onto_an_app_event_waits_and_a_deleted_one_is_yours_unless_overwrite(self):
        made = self.ensure(dunning())
        routine = self.routines(made)["Unpaid orders"]
        moved = dunning(routines=[{"title": "Unpaid orders", "prompt": "Check the new order.", "when": ON_ORDER}])
        asked = self.ensure(moved)
        self.assertEqual([a["field"] for a in asked["applied"]], ["routines"], "its prompt applies")
        [item] = self.waiting(made)["items"]
        self.assertEqual((item["kind"], item["routine_id"], item["when"]), ("routine", routine["id"], ON_ORDER))
        now = self.routines(made)["Unpaid orders"]
        self.assertEqual((now["prompt"], now["label"]), ("Check the new order.", "on weekdays at 09:30"),
                         "it runs on its schedule until a person accepts the app event")
        self.assertTrue(self.ensure(moved)["unchanged"])
        self.decide(self.waiting(made))
        self.assertEqual(self.routines(made)["Unpaid orders"]["label"], "when the shop app sends order.created")
        self.assertEqual(self.routines(made)["Unpaid orders"]["id"], routine["id"], "the same routine")
        self.control("delete_pip_routine", pip_id=made["pip_id"], routine_id=routine["id"])
        kept = self.ensure(moved)
        self.assertEqual([(c["field"], c["item"]) for c in kept["conflicts"]], [("routines", "Unpaid orders")])
        self.assertIn("You removed the routine Unpaid orders in DGC, so it stays removed", kept["notice"])
        self.assertEqual(self.routines(made), {})
        back = self.ensure(moved, overwrite_user_changes=True)
        self.assertEqual([i["kind"] for i in self.waiting(made)["items"]], ["routine"],
                         "putting back an app event routine still waits for a person")
        self.assertEqual(back["conflicts"], [])

    def test_accept_widening_applies_it_in_the_same_call(self):
        made = self.ensure(dunning())
        done = self.ensure(dunning(**self.WIDE), accept_widening=True)
        self.assertEqual(done["waiting"], [])
        self.assertEqual(sorted({a["field"] for a in done["applied"]}), ["always_allow", "level", "routines", "tools"])
        self.assertEqual(self.level(made), "approve")
        self.assertIn("create_dispatch", self.grants(made))
        self.assertEqual(self.ensure(dunning(**self.WIDE))["unchanged"], True)

    def test_a_new_pips_always_allow_waits_unless_accept_widening(self):
        made = self.ensure(dispatch(always_allow=["app:shop/create_dispatch"], level="full"))
        self.assertTrue(made["created"])
        self.assertEqual(self.level(made), "full", "a new Pip is made as its template says")
        self.assertEqual(self.routines(made)["New orders"]["status"], "on")
        self.assertEqual(self.grants(made), {}, "but Always allow, which only a person gave so far, waits")
        self.assertEqual([i["kind"] for i in self.waiting(made)["items"]], ["always_allow"])
        again = self.ensure(dispatch(always_allow=["app:shop/create_dispatch"], level="full"))
        self.assertEqual((again["unchanged"], again["waiting"]), (True, made["waiting"]))
        other = self.ensure(dispatch(key="dispatch-2", always_allow=["app:shop/create_dispatch"]), accept_widening=True)
        self.assertEqual(other["waiting"], [])
        self.assertIn("create_dispatch", self.grants(other))

    def test_a_widening_the_template_drops_is_withdrawn_and_one_turned_down_is_not_asked_again(self):
        made = self.ensure(dunning())
        asked = self.ensure(dunning(level="full"))
        change = self.waiting(made)
        dropped = self.ensure(dunning())
        self.assertEqual((dropped["waiting"], dropped["unchanged"]), ([], False))
        self.assertEqual(dropped["applied"][-1]["field"], "waiting")
        self.assertIsNone(self.waiting(made))
        late = self.decide(change)                                 # withdrawn: nothing to accept any more
        self.assertEqual((late["decided"], late["change"]["status"], self.level(made)), (False, "withdrawn", "ask"))
        self.ensure(dunning(level="full"))
        change = self.waiting(made)
        self.assertNotEqual(change["id"], asked["waiting"][0])
        turned_down = self.decide(change, "reject")
        self.assertEqual(turned_down["change"]["status"], "declined")
        self.assertEqual(self.level(made), "ask")
        later = self.ensure(dunning(level="full"))
        self.assertEqual((later["waiting"], later["declined"], later["unchanged"]), ([], [change["id"]], True))
        self.assertIn("turned down", later["notice"])
        more = self.ensure(dunning(level="approve"))
        self.assertEqual(len(more["waiting"]), 1, "asking for something else asks again")


class MoneyTests(TemplateWorld, unittest.TestCase):
    def test_a_tool_that_moves_money_is_never_always_allowed(self):
        for accept in (False, True):
            with self.subTest(accept_widening=accept), self.assertRaises(RegistryError) as raised:
                self.ensure(dispatch(key=f"refunds-{int(accept)}", tools=["app:shop/refund_order"],
                                     always_allow=["app:shop/refund_order"], routines=[]), accept_widening=accept)
            self.assertEqual(raised.exception.code, "asks_every_time")
            self.assertIn("refund_order can move money", str(raised.exception))
        self.assertEqual(self.control("list_pip_templates"), {"templates": []}, "refused before anything was kept")
        made = self.ensure(dispatch(tools=["app:shop/refund_order"], routines=[]))
        with self.assertRaises(RegistryError) as raised:
            self.ensure(dispatch(tools=["app:shop/refund_order"], always_allow=["app:shop/refund_order"], routines=[]),
                        accept_widening=True)
        self.assertEqual(raised.exception.code, "asks_every_time")
        self.assertEqual(self.grants(made), {})
        with self.assertRaises(RegistryError) as raised:
            self.ensure(dunning(always_allow=["app:shop/find_unpaid_orders"]))
        self.assertEqual(raised.exception.code, "invalid_template", "a read needs no Always allow")
        app = pip_sdk_apps.get("shop")
        refund = pip_sdk_apps.tool_of(app, "refund_order")
        with self.registry.transaction(), self.assertRaises(RegistryError):
            pip_action_grants.grant_app_tool(self.registry, made["pip_id"], self.registry.personal()["id"], "app:shop",
                                             refund, pip_sdk_apps.connection_digest(app),
                                             pip_sdk_apps.schema_digest(refund), "editor-user", template="dispatch")


class ConflictTests(TemplateWorld, unittest.TestCase):
    def test_a_change_made_in_dgc_is_reported_and_kept_unless_overwrite(self):
        made = self.ensure(dunning(level="approve"))
        pip_id = made["pip_id"]
        # A person changes it in DGC: its name (a reviewed change), its level, its routine, and pauses nothing.
        pip = self.pip(made)
        proposal = self.control("propose_pip_update", pip_id=pip_id, expected_version=pip["current_version"],
                                changes={"name": "My chaser"})["proposal"]
        self.control("accept_pip_update", pip_id=pip_id, proposal_id=proposal["id"], expected_version=pip["current_version"])
        self.control("set_pip_level", pip_id=pip_id, level="full")
        routine = self.routines(made)["Unpaid orders"]
        self.control("update_pip_routine", pip_id=pip_id, routine_id=routine["id"], changes={"prompt": "Only list them."})
        kept = self.ensure(dunning(level="approve"))
        self.assertEqual((kept["unchanged"], kept["applied"], kept["waiting"]), (True, [], []))
        self.assertEqual(sorted((c["field"], c.get("item")) for c in kept["conflicts"]),
                         [("level", None), ("name", None), ("routines", "Unpaid orders")])
        level = next(c for c in kept["conflicts"] if c["field"] == "level")
        self.assertEqual((level["pip"], level["template"]), ("full", "approve"))
        self.assertIn("You set How much it asks to Full access in DGC, so it stays", level["words"])
        self.assertEqual((self.pip(made)["name"], self.level(made)), ("My chaser", "full"), "not stomped")
        self.assertEqual(self.routines(made)["Unpaid orders"]["prompt"], "Only list them.")
        self.assertEqual(len(self.ensure(dunning(level="approve"))["conflicts"]), 3, "said every time, still kept")
        back = self.ensure(dunning(level="approve"), overwrite_user_changes=True)
        self.assertEqual(back["conflicts"], [])
        self.assertEqual((self.pip(made)["name"], self.level(made)), ("Dunning", "approve"), "full to approve is lower")
        self.assertEqual(self.routines(made)["Unpaid orders"]["prompt"], "Find orders unpaid after 7 days and list them.")
        self.assertTrue(self.ensure(dunning(level="approve"))["unchanged"])

    def test_overwrite_still_waits_for_a_widening_and_a_revoked_always_allow_is_kept(self):
        made = self.ensure(dispatch(level="approve", always_allow=["app:shop/create_dispatch"]), accept_widening=True)
        self.control("set_pip_level", pip_id=made["pip_id"], level="ask")
        [grant] = self.grants(made).values()
        self.control("revoke_pip_action_grant", pip_id=made["pip_id"], grant_id=grant["id"])
        kept = self.ensure(dispatch(level="approve", always_allow=["app:shop/create_dispatch"]))
        self.assertEqual(sorted(c["field"] for c in kept["conflicts"]), ["always_allow", "level"])
        self.assertEqual((self.level(made), self.grants(made)), ("ask", {}))
        back = self.ensure(dispatch(level="approve", always_allow=["app:shop/create_dispatch"]), overwrite_user_changes=True)
        self.assertEqual(back["conflicts"], [])
        self.assertEqual([i["kind"] for i in self.waiting(made)["items"]], ["always_allow", "level"],
                         "giving back more than the person left still waits for them")
        self.assertEqual(self.level(made), "ask")

    def test_a_paused_or_archived_pip_stays_so(self):
        made = self.ensure(dunning())
        self.control("pause_pip", pip_id=made["pip_id"])
        kept = self.ensure(dunning(name="Renamed"))
        self.assertIn("status", [c["field"] for c in kept["conflicts"]])
        self.assertEqual(self.pip(made)["status"], "paused")
        self.assertEqual(self.ensure(dunning(name="Renamed"), overwrite_user_changes=True)["conflicts"][0]["field"],
                         "status", "a Pip a person paused is never resumed by its template")
        from dgc.pip_archive import transition
        pip = self.store.get(made["pip_id"])
        transition(self.store, made["pip_id"], archived=True, expected_version=pip["current_version"],
                   expected_lifecycle_revision=pip["lifecycle_revision"], request_key="archive-1", reason="Done with it",
                   actor="editor-user")
        archived = self.ensure(dunning(name="Again"))
        self.assertEqual((archived["applied"], archived["conflicts"][0]["pip"]), ([], "archived"))
        self.assertEqual(self.pip(made)["name"], "Renamed")


class PruneTests(TemplateWorld, unittest.TestCase):
    def test_prune_pauses_what_no_template_lists_never_deletes_and_a_returning_key_resumes(self):
        one, two = self.ensure(dunning()), self.ensure(dispatch())
        pruned = self.control("prune_pip_templates", keep=["dunning"])
        [entry] = pruned["pruned"]
        self.assertEqual((entry["key"], entry["pip_id"], entry["status"], pruned["kept"]), ("dispatch", two["pip_id"], "paused", 1))
        self.assertIn("Nothing was deleted", entry["words"])
        self.assertEqual((self.pip(one)["status"], self.pip(two)["status"]), ("active", "paused"))
        self.assertEqual(self.store.get(two["pip_id"])["name"], "Dispatch", "still there")
        again = self.control("prune_pip_templates", keep=["dunning"])
        self.assertEqual((again["pruned"], [a["key"] for a in again["already"]]), ([], ["dispatch"]))
        back = self.ensure(dispatch())
        self.assertEqual(self.pip(two)["status"], "active", "its template is back")
        self.assertIn("Resumed Dispatch", " ".join(a["words"] for a in back["applied"]))
        self.assertEqual(self.ensure(dispatch())["unchanged"], True)
        with self.assertRaises(RegistryError):
            self.control("prune_pip_templates", keep=["Not A Key"])
        self.assertEqual(self.control("prune_pip_templates", keep=[])["pruned"][0]["key"], "dispatch")


class ServerTests(TemplateWorld, unittest.TestCase):
    def test_on_a_server_a_template_never_runs_on_a_personal_plan(self):
        self.cfg.data["subscription_engine"] = "claude"
        with patch("dgc.pip_server.is_server_runner", return_value=True), self.assertRaises(RegistryError) as raised:
            self.ensure(dunning())
        self.assertEqual(raised.exception.code, "server_subscription")
        self.assertIn("Give the template a model", str(raised.exception))
        self.assertEqual(self.control("list_pip_templates"), {"templates": []})
        with patch("dgc.pip_server.is_server_runner", return_value=True), \
                patch("dgc.pip_models._catalog", return_value={"fixture"}):
            made = self.ensure(dunning(model="fixture"))
        self.assertEqual(self.pip(made)["model_choice"], {"mode": "model", "model": "fixture"})


class WireTests(TemplateWorld, unittest.TestCase):
    def test_the_api_is_64_and_the_commands_are_the_runtimes(self):
        from dgc.headless import PIPS_API_VERSION, _bounded_pips_command
        from dgc.pips import CONTROL_COMMANDS, _COMMAND_ARGS
        self.assertEqual(PIPS_API_VERSION, 64)
        self.assertEqual(_COMMAND_ARGS["ensure_pip_template"], {"template", "accept_widening", "overwrite_user_changes"})
        self.assertEqual(_COMMAND_ARGS["prune_pip_templates"], {"keep"})
        self.assertEqual(_COMMAND_ARGS["list_pip_templates"], {"pip_id"})
        self.assertEqual(_COMMAND_ARGS["decide_pip_template_change"], {"change_id", "decision", "expected_digest"})
        self.assertTrue({"ensure_pip_template", "prune_pip_templates", "list_pip_templates",
                         "decide_pip_template_change"} <= CONTROL_COMMANDS)
        # A full template (ten routines, many tools) passes the editor bridge's bounds, as an app's tools do.
        big = dunning(tools=[f"app:shop/tool_{n}" for n in range(64)],
                      routines=[{"title": f"Routine {n}", "prompt": "x" * 300, "when": WEEKDAYS} for n in range(10)])
        request = {"type": "ensure_pip_template", "request_id": "r1", "template": big, "accept_widening": False}
        self.assertEqual(_bounded_pips_command({"type": "pips_control", "request": request})["request"], request)

    def test_a_template_holding_a_saved_secret_is_refused(self):
        self.cfg.data["api_key"] = "sk-proj-abcdefghijklmnop1234"
        with self.assertRaises(RegistryError) as raised:
            self.ensure(dunning(instructions="Log in with sk-proj-abcdefghijklmnop1234 first."))
        self.assertEqual(raised.exception.code, "secret_detected")
        self.assertEqual(self.control("list_pip_templates"), {"templates": []}, "refused, not kept with a hole in it")


if __name__ == "__main__":
    unittest.main()
