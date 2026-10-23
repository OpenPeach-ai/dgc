"""Pips for SDK apps, part 2 (Pips API 62): approvals in your app.

A Pip's change on your own app that waits for a person is told to the app at its own address (signed, once, retried
on its schedule, recorded on the action); the app decides it through the SDK's decide_app_approval, or DGC's own card
does, and whichever answers first wins, once. Every event reaches a real HTTP server on 127.0.0.1 serving the SDK's own
AppToolHandler with its approval callbacks. No model, no provider, no network beyond 127.0.0.1.
"""
from __future__ import annotations

import json
import time
import unittest

from tests.test_pip_sdk_apps import AppWorld, DISPATCH, ORDER, REFUND, UNPAID  # noqa: E402
from dgc import pip_action_grants as grants, pip_levels, pip_plugins, pip_sdk_app_approvals as approvals, pips  # noqa: E402
from dgc.workspace_registry import RegistryError  # noqa: E402
from dgc_sdk.pips_app import AppToolHandler, PipApprovalRequested, PipApprovalResolved, define_pip_tool, sign  # noqa: E402

NOTE = define_pip_tool("add_note", "Add a line to the shop's day log",
                       {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}, kind="change")


class ApprovalWorld(AppWorld):
    def setUp(self):
        super().setUp()
        self.events = []

    def register(self, tools=(UNPAID, ORDER, DISPATCH), name="shop", serve=True, callbacks=True):
        result = super().register(tools=tools, name=name, serve=False)
        shop = self.shop

        def dispatch(args, ctx):
            shop.dispatches.append({"order_id": args["order_id"], "action_id": ctx.action_id})
            return {"dispatch": "dsp_1", "order_id": args["order_id"], "receipt": ctx.approval_id}

        def refund(args, ctx):
            shop.dispatches.append({"refund": args["order_id"], "action_id": ctx.action_id})
            return {"refund": "rf_1"}
        if serve:
            seen = self.events.append if callbacks else None
            shop.handler = AppToolHandler(result["secret"], tools={UNPAID: lambda a, c: [], ORDER: lambda a, c: None,
                                                                   DISPATCH: dispatch, REFUND: refund,
                                                                   NOTE: lambda a, c: {"noted": a["text"]}},
                                          on_approval_requested=seen, on_approval_resolved=seen)
        self.secret = result["secret"]
        return result

    def posted(self, kind=None):
        return [b for b in self.shop.posted() if kind is None or b["type"] == kind]

    def proposed_by_a_run(self, tool="create_dispatch", arguments=None, key="task-two"):
        """A Personal Pip's run proposes one change in the shop app, then the runner does what it does after a run."""
        run = self.store.enqueue(self.source["id"], key, "local-console", self.cfg)
        self.store.claim_next()
        inspected = self.control("inspect_pip_connector_actions", server="app:shop")
        value = {"server": "app:shop", "connection_digest": inspected["connection_digest"],
                 "schema_digest": next(t for t in inspected["tools"] if t["tool"] == tool)["schema_digest"],
                 "call": {"tool": tool, "arguments": arguments or {"order_id": "ord_17"}}}
        pip_plugins.offer(self.registry, run["id"], value)
        self.store.finish(run["id"], result={"text": "Drafted.", "external_actions": False, "tools_called": 0, "usage": {},
                                             "connector_action_draft": value})
        pips._run_granted_actions(self.registry, self.cfg, run["id"])
        [draft] = [d for d in self.control("list_pip_connector_drafts", pip_id=self.source["id"])["drafts"]
                   if d["source_run_id"] == run["id"]]
        return run, draft

    def review(self, run):
        row = self.registry.db.execute("SELECT id FROM pip_app_actions WHERE source_run_id=? AND requested_by=?",
                                       (run["id"], approvals.REVIEWER)).fetchone()
        return self.control("get_pip_app_action", action_id=row[0])["action"] if row else None

    def deliver(self, **kwargs):
        return approvals.deliver_due(self.registry, self.cfg, **kwargs)

    def draft(self, draft_id):
        return self.control("get_pip_connector_draft", draft_id=draft_id)["draft"]


class RequestedTests(ApprovalWorld, unittest.TestCase):
    def test_a_change_that_waits_is_told_to_the_app_once_signed_and_its_card_stays(self):
        self.register()
        run, draft = self.proposed_by_a_run()
        review = self.review(run)
        self.assertEqual((review["status"], review["payload"]["call"]["arguments"]), ("pending", {"order_id": "ord_17"}))
        self.assertEqual(draft["status"], "pending", "DGC's Allow card still shows it")
        self.assertEqual(self.shop.requests, [], "nothing is sent while the run finishes")
        self.assertEqual(grants.pending_count(self.registry, self.now), 1, "one change waits, not two")
        from dgc.pip_attention import collect
        items = [i for i in collect(self.registry, self.now)["items"] if i["pip_id"] == self.source["id"]]
        self.assertEqual([i["title"] for i in items], ["Run create_dispatch in Shop app?"], "one card, not two")
        [sent] = self.deliver()
        self.assertEqual((sent["type"], sent["status"], sent["tries"]), ("approval_requested", "delivered", 1))
        [(headers, raw)] = self.shop.requests
        headers = {k.lower(): v for k, v in headers.items()}
        stamp, nonce = headers["x-dgc-timestamp"], headers["x-dgc-nonce"]
        self.assertEqual(headers["x-dgc-signature"], sign(self.secret, stamp, nonce, raw), "signed as its tool calls are")
        body = json.loads(raw)
        self.assertEqual(body, {"type": "approval_requested", "app": "shop", "action_id": review["id"],
                                "action_digest": review["digest"], "tool": "create_dispatch", "arguments": {"order_id": "ord_17"},
                                "pip_id": self.source["id"], "pip_name": "Morning planner", "run_id": run["id"],
                                "summary": "Morning planner asks to run create_dispatch (order_id ord_17) in Shop app.",
                                "expires_at": review["expires_at"], "moves_money": False})
        [event] = self.events
        self.assertIsInstance(event, PipApprovalRequested)
        self.assertEqual((event.action_id, event.action_digest, event.moves_money), (review["id"], review["digest"], False))
        self.assertEqual(self.deliver(), [], "exactly once")
        self.assertEqual(len(self.shop.requests), 1)
        [record] = self.control("get_pip_app_action", action_id=review["id"])["action"]["app_deliveries"]
        self.assertEqual((record["type"], record["status"], [t["outcome"] for t in record["tries"]]),
                         ("approval_requested", "delivered", ["delivered"]), "recorded on the action")
        self.assertEqual(self.draft(draft["id"])["status"], "pending", "telling the app settles nothing")

    def test_a_dead_app_is_retried_5s_30s_and_2min_recorded_and_dgcs_card_still_shows_it(self):
        self.register()
        self.shop.close()
        run, draft = self.proposed_by_a_run()
        review = self.review(run)
        t0 = time.time()
        self.assertEqual([s["status"] for s in self.deliver(now=t0)], ["waiting"])
        self.assertEqual(self.deliver(now=t0 + 4), [], "the second try waits 5 s")
        self.assertEqual([s["tries"] for s in self.deliver(now=t0 + 5)], [2])
        self.assertEqual(self.deliver(now=t0 + 34), [], "the third 30 s more")
        self.assertEqual([s["tries"] for s in self.deliver(now=t0 + 35)], [3])
        self.assertEqual(self.deliver(now=t0 + 154), [], "the last 2 min more")
        [last] = self.deliver(now=t0 + 155)
        self.assertEqual((last["status"], last["tries"]), ("failed", 4))
        self.assertEqual(self.deliver(now=t0 + 10_000), [], "and never again")
        [record] = self.control("get_pip_app_action", action_id=review["id"])["action"]["app_deliveries"]
        self.assertEqual([t["outcome"] for t in record["tries"]], ["the shop app didn't answer"] * 4)
        self.assertEqual(record["error"], "the shop app didn't answer (4 tries)")
        self.assertEqual(self.draft(draft["id"])["status"], "pending", "a failed delivery never blocks or rejects it")
        self.assertEqual(self.review(run)["status"], "pending")
        action = self.control("prepare_pip_connector_draft", draft_id=draft["id"], expected_digest=draft["digest"])["action"]
        self.assertEqual(action["id"], review["id"], "DGC's Allow takes the same review")

    def test_a_failure_that_clears_is_delivered_and_an_old_handler_is_not_asked_again(self):
        self.register()
        real = self.shop.handler
        failing = [True]

        class Flaky:
            def handle(self, headers, body):
                if failing[0]:
                    failing[0] = False
                    return 503, {"Content-Type": "application/json"}, b'{"ok": false}'
                return real.handle(headers, body)
        self.shop.handler = Flaky()
        run, _ = self.proposed_by_a_run()
        t0 = time.time()
        self.assertEqual([s["status"] for s in self.deliver(now=t0)], ["waiting"])
        self.assertEqual([(s["status"], s["tries"]) for s in self.deliver(now=t0 + 5)], [("delivered", 2)])
        [record] = self.review(run)["app_deliveries"]
        self.assertEqual([t["outcome"] for t in record["tries"]],
                         ["the shop app answered with an error (HTTP 503)", "delivered"])
        # An app on part 1's handler (no approvals) refuses the event as not a tool call: told once, never retried.
        class Older:
            def handle(self, headers, body):
                if json.loads(body)["type"] != "tool_call":
                    return 400, {"Content-Type": "application/json"}, json.dumps({"ok": False, "error": {
                        "code": "invalid_request", "message": "The call isn't a DGC tool call."}}).encode()
                return real.handle(headers, body)
        self.shop.handler = Older()
        run2, _ = self.proposed_by_a_run(key="task-three")
        [old] = self.deliver(now=t0 + 6)
        self.assertEqual((old["status"], old["tries"]), ("failed", 1))
        self.assertEqual(self.review(run2)["app_deliveries"][0]["error"], "the shop app refused it (HTTP 400)")

    def test_the_runner_sends_what_is_due_on_its_own_thread(self):
        from dgc.workspace_registry import utc_now
        self.now = utc_now()                   # the runner's own registry reads the real clock
        self.register()
        run, _ = self.proposed_by_a_run()
        approvals.tick(self.registry, self.cfg)
        sender = approvals._SENDER[str(self.registry.directory)]
        sender.join(10)
        self.assertFalse(sender.is_alive())
        self.assertEqual([b["type"] for b in self.posted()], ["approval_requested"])
        self.assertEqual(self.review(run)["app_deliveries"][0]["status"], "delivered")


class DecideTests(ApprovalWorld, unittest.TestCase):
    def test_deciding_in_the_app_runs_it_once_and_dgcs_card_observes_it(self):
        self.register()
        run, draft = self.proposed_by_a_run()
        self.deliver()
        [waiting] = self.control("list_app_approvals")["approvals"]
        self.assertEqual(self.control("list_app_approvals", app="shop")["approvals"], [waiting])
        self.assertEqual(self.control("list_app_approvals", app="other")["approvals"], [])
        self.assertEqual((waiting["tool"], waiting["arguments"], waiting["pip_name"], waiting["status"], waiting["moves_money"]),
                         ("create_dispatch", {"order_id": "ord_17"}, "Morning planner", "pending", False))
        with self.assertRaises(RegistryError) as raised:
            self.control("decide_app_approval", action_id=waiting["action_id"], decision="accept", expected_digest="0" * 64)
        self.assertEqual(raised.exception.code, "action_conflict", "the exact action it was shown")
        with self.assertRaises(RegistryError) as raised:
            self.control("decide_app_approval", actor="phone-1", action_id=waiting["action_id"], decision="accept",
                         expected_digest=waiting["action_digest"])
        self.assertEqual(raised.exception.code, "local_only")
        said = self.control("decide_app_approval", action_id=waiting["action_id"], decision="accept",
                            expected_digest=waiting["action_digest"])
        self.assertTrue(said["decided"])
        self.assertEqual((said["approval"]["status"], said["approval"]["decision"], said["approval"]["by"]),
                         ("succeeded", "accepted", "app"))
        self.assertIn("dsp_1", said["approval"]["receipt"]["response_preview"])
        calls = self.posted("tool_call")
        self.assertEqual([(c["tool"], c["action_id"]) for c in calls], [("create_dispatch", waiting["action_id"])])
        self.assertEqual(self.shop.dispatches, [{"order_id": "ord_17", "action_id": waiting["action_id"]}])
        settled = self.draft(draft["id"])
        self.assertEqual((settled["status"], settled["action_id"]), ("prepared", waiting["action_id"]), "DGC's card settles with it")
        # DGC's card, a moment late: its Allow takes the same review and observes it; nothing is posted again.
        action = self.control("prepare_pip_connector_draft", draft_id=draft["id"], expected_digest=draft["digest"])["action"]
        self.assertEqual((action["id"], action["status"], action["resolved_by"]), (waiting["action_id"], "succeeded", "app:shop"))
        again = self.control("accept_pip_app_action", action_id=action["id"], expected_digest=action["digest"])["action"]
        self.assertEqual(again["status"], "succeeded")
        for decision in ("accept", "reject"):
            repeat = self.control("decide_app_approval", action_id=waiting["action_id"], decision=decision,
                                  expected_digest=waiting["action_digest"])
            self.assertEqual((repeat["decided"], repeat["approval"]["decision"], repeat["approval"]["by"]),
                             (False, "accepted", "app"), "a second decide observes the first")
        with self.assertRaises(RegistryError) as raised:
            self.control("reject_pip_app_action", action_id=action["id"], expected_digest=action["digest"])
        self.assertEqual(str(raised.exception), "Shop app already accepted this: it ran once.")
        self.assertEqual(len(self.posted("tool_call")), 1, "the change was called once")
        [resolved] = self.deliver()
        self.assertEqual(resolved["type"], "approval_resolved")
        body = self.posted("approval_resolved")[0]
        self.assertEqual({k: body[k] for k in ("app", "action_id", "tool", "decision", "by")},
                         {"app": "shop", "action_id": waiting["action_id"], "tool": "create_dispatch",
                          "decision": "accepted", "by": "app"})
        self.assertIsInstance(self.events[-1], PipApprovalResolved)
        self.assertEqual(self.control("list_app_approvals")["approvals"], [])

    def test_deciding_in_dgc_tells_the_app_by_dgc_and_a_later_decide_observes_it(self):
        self.register()
        run, draft = self.proposed_by_a_run()
        review = self.review(run)
        self.deliver()
        action = self.control("prepare_pip_connector_draft", draft_id=draft["id"], expected_digest=draft["digest"])["action"]
        self.assertEqual(action["id"], review["id"], "Allow takes the review the app was told about")
        done = self.control("accept_pip_app_action", action_id=action["id"], expected_digest=action["digest"])["action"]
        self.assertEqual((done["status"], done["resolved_by"]), ("succeeded", "editor-user"))
        self.deliver()
        self.assertEqual([(b["type"], b.get("decision"), b.get("by")) for b in self.posted() if b["type"] != "tool_call"],
                         [("approval_requested", None, None), ("approval_resolved", "accepted", "dgc")])
        later = self.control("decide_app_approval", action_id=review["id"], decision="reject", expected_digest=review["digest"])
        self.assertEqual((later["decided"], later["approval"]["decision"], later["approval"]["by"]), (False, "accepted", "dgc"))
        self.assertEqual(len(self.posted("tool_call")), 1)

    def test_dont_in_dgc_rejects_it_for_the_app_too_and_the_app_cannot_run_it(self):
        self.register()
        run, draft = self.proposed_by_a_run()
        review = self.review(run)
        dismissed = self.control("dismiss_pip_connector_draft", draft_id=draft["id"], expected_digest=draft["digest"])["draft"]
        self.assertEqual(dismissed["status"], "dismissed")
        self.assertEqual((self.review(run)["status"], self.review(run)["resolved_by"]), ("rejected", "editor-user"))
        later = self.control("decide_app_approval", action_id=review["id"], decision="accept", expected_digest=review["digest"])
        self.assertEqual((later["decided"], later["approval"]["decision"], later["approval"]["by"]), (False, "rejected", "dgc"))
        self.deliver()
        self.assertEqual([(b["type"], b.get("decision"), b.get("by")) for b in self.posted()],
                         [("approval_resolved", "rejected", "dgc")], "decided before it was sent: only how it closed")
        self.assertEqual(self.review(run)["app_deliveries"][0]["status"], "skipped")

    def test_rejecting_in_the_app_settles_dgcs_card_and_its_allow_says_so(self):
        self.register()
        run, draft = self.proposed_by_a_run()
        review = self.review(run)
        said = self.control("decide_app_approval", action_id=review["id"], decision="reject", expected_digest=review["digest"])
        self.assertEqual((said["decided"], said["approval"]["status"], said["approval"]["by"]), (True, "rejected", "app"))
        self.assertEqual(self.draft(draft["id"])["status"], "prepared")
        action = self.control("prepare_pip_connector_draft", draft_id=draft["id"], expected_digest=draft["digest"])["action"]
        with self.assertRaises(RegistryError) as raised:
            self.control("accept_pip_app_action", action_id=action["id"], expected_digest=action["digest"])
        self.assertEqual(str(raised.exception), "Shop app declined this.")
        with self.assertRaises(RegistryError) as raised:
            self.control("dismiss_pip_connector_draft", draft_id=draft["id"], expected_digest=draft["digest"])
        self.assertEqual(str(raised.exception), "Shop app declined this.")
        self.assertEqual(self.posted("tool_call"), [])

    def test_an_edit_in_dgc_withdraws_the_apps_copy_and_runs_the_edited_one(self):
        self.register()
        run, draft = self.proposed_by_a_run()
        review = self.review(run)
        edited = {"tool": "create_dispatch", "arguments": {"order_id": "ord_18"}}
        action = self.control("prepare_pip_connector_draft", draft_id=draft["id"], expected_digest=draft["digest"], call=edited)["action"]
        self.assertNotEqual(action["id"], review["id"])
        self.assertEqual(self.review(run)["status"], "rejected", "the app's copy is withdrawn")
        self.control("accept_pip_app_action", action_id=action["id"], expected_digest=action["digest"])
        self.assertEqual([(c["arguments"], c["action_id"]) for c in self.posted("tool_call")], [({"order_id": "ord_18"}, action["id"])])
        self.deliver()
        events = [(b["type"], b["action_id"], b.get("decision"), b.get("by")) for b in self.posted() if b["type"] != "tool_call"]
        self.assertEqual(sorted(events), sorted([("approval_resolved", review["id"], "rejected", "dgc"),
                                                 ("approval_resolved", action["id"], "accepted", "dgc")]))
        later = self.control("decide_app_approval", action_id=review["id"], decision="accept", expected_digest=review["digest"])
        self.assertFalse(later["decided"])
        self.assertEqual(len(self.posted("tool_call")), 1)

    def test_expiry_tells_the_app_expired(self):
        self.register()
        run, draft = self.proposed_by_a_run()
        review = self.review(run)
        self.deliver()
        self.now = "2026-10-06T06:00:00.000Z"
        self.assertEqual(approvals.expire_due(self.registry), 1)
        self.assertEqual(approvals.expire_due(self.registry), 0)
        self.deliver()
        last = self.posted()[-1]
        self.assertEqual((last["type"], last["decision"], last["by"], last["at"]), ("approval_resolved", "expired", "dgc", self.now))
        later = self.control("decide_app_approval", action_id=review["id"], decision="accept", expected_digest=review["digest"])
        self.assertEqual((later["decided"], later["approval"]["decision"]), (False, "expired"))
        self.assertEqual(self.posted("tool_call"), [])
        self.assertEqual(self.control("list_app_approvals")["approvals"], [])


class FloorTests(ApprovalWorld, unittest.TestCase):
    def test_a_change_that_moves_money_always_asks_and_both_sides_see_it(self):
        self.register(tools=(UNPAID, DISPATCH, REFUND))
        pip_levels.set_level(self.registry, self.source["id"], "full", "editor-user")
        run, draft = self.proposed_by_a_run("refund_order", key="refund")
        review = self.review(run)
        self.assertEqual(review["status"], "pending", "not even Full access runs it")
        self.assertEqual(draft["status"], "pending", "DGC's card asks")
        self.assertEqual(grants._asks_every_time(review["payload"]), "Shop app's refund_order", "with no Always allow")
        self.deliver()
        [asked] = self.posted("approval_requested")
        self.assertTrue(asked["moves_money"])
        self.assertTrue(self.events[0].moves_money)
        [waiting] = self.control("list_app_approvals")["approvals"]
        self.assertTrue(waiting["moves_money"])
        with self.assertRaises(RegistryError) as raised:
            self.control("always_allow_pip_app_action", action_id=review["id"], expected_digest=review["digest"])
        self.assertEqual(raised.exception.code, "asks_every_time")
        said = self.control("decide_app_approval", action_id=review["id"], decision="accept", expected_digest=review["digest"])
        self.assertEqual((said["approval"]["status"], said["approval"]["by"]), ("succeeded", "app"), "a person in the app")
        self.assertEqual(len(self.posted("tool_call")), 1)

    def test_always_allow_and_a_level_are_heard_as_such_with_no_request(self):
        self.register(tools=(UNPAID, DISPATCH, NOTE))
        first = self.control("propose_pip_connector_action", source_run_id=self.run["id"], server="app:shop",
                             **{k: v for k, v in self._digests("create_dispatch").items()},
                             call={"tool": "create_dispatch", "arguments": {"order_id": "ord_17"}}, request_key="one")["action"]
        self.control("always_allow_pip_app_action", action_id=first["id"], expected_digest=first["digest"])
        run, draft = self.proposed_by_a_run(arguments={"order_id": "ord_18"})
        self.assertEqual(draft["status"], "prepared", "ran on the grant after the run")
        self.assertIsNone(self.review(run), "nothing waited, so DGC opened no review for the app")
        self.deliver()
        heard = [(b["type"], b.get("decision"), b.get("by")) for b in self.posted() if b["type"] != "tool_call"]
        self.assertEqual(heard, [("approval_resolved", "accepted", "dgc"), ("approval_resolved", "accepted", "always_allow")],
                         "the first was proposed and accepted at once in DGC; the second ran as always allowed")
        self.control("revoke_pip_action_grant", pip_id=self.source["id"],
                     grant_id=grants.list_grants(self.registry, self.source["id"])[0]["id"])
        pip_levels.set_level(self.registry, self.source["id"], "full", "editor-user")
        run, draft = self.proposed_by_a_run("add_note", {"text": "Asha called"}, key="task-four")
        self.assertEqual(draft["status"], "prepared", "its level let it through (an order, by its name, would still ask)")
        self.deliver()
        self.assertEqual(self.posted()[-1]["by"], "level")
        self.assertEqual(self.posted("approval_requested"), [], "nothing ever waited for the app: it was never asked")

    def _digests(self, tool):
        inspected = self.control("inspect_pip_connector_actions", server="app:shop")
        return {"connection_digest": inspected["connection_digest"],
                "schema_digest": next(t for t in inspected["tools"] if t["tool"] == tool)["schema_digest"]}


if __name__ == "__main__":
    unittest.main()
