"""One "Needs attention" list across every Personal Pip (pip_attention): each card waiting for you, newest
first, naming its Pip and the card it opens. Reading it never changes anything."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_app_links as links, pip_attention, pip_message_drafts as drafts, pip_plugins, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_app_actions as fixtures


class AttentionTests(unittest.TestCase):
    setUp = fixtures.AppActionTests.setUp
    prepare_source = fixtures.AppActionTests.prepare_source

    def control(self, command, actor="editor-user", **fields):
        clock = self.registry.clock
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory, clock=clock)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def save(self, actor, key):
        return drafts.save(self.store, run_id=self.run["id"], message=self.message, actor=actor, key=key)

    def test_every_kind_of_card_in_one_list_newest_first_and_reading_changes_nothing(self):
        pip, workspace = self.source["id"], self.source["workspace_id"]
        self.assertEqual(self.control("list_pip_attention")["total"], 0)
        email = self.save("pip-email:" + self.run["id"], "a" * 64)
        self.save("main-email:" + "a" * 32, "c" * 64)          # DGC's own chat: not a Pip's card
        self.now = "2026-10-04T06:01:00.000Z"
        link = links.request(self.registry, pip, workspace, "gmail", "To read your new mail.", self.run["id"])
        self.now = "2026-10-04T06:02:00.000Z"
        # A "use this plugin?" card from before 2026-10-09: every enabled plugin is every Pip's now, so it waits on no one.
        pip_plugins.request(self.registry, self.target["id"], workspace, "airtable", "To keep your plan in a table.")
        self.now = "2026-10-04T06:03:00.000Z"
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO metadata VALUES(?,?)", ("computer_needs_you:" + pip,
                                     json.dumps({"host": "www.google.com", "at": self.now, "run_id": self.run["id"]})))
        before = self.registry.db.total_changes
        pip_attention.collect(self.registry, self.now)
        self.assertEqual(self.registry.db.total_changes, before, "reading the list writes nothing")
        found = self.control("list_pip_attention")
        self.assertEqual(sorted(i["kind"] for i in found["items"]), ["app_link", "computer_check", "email"], "no plugin card")
        stamps = [i["created_at"] for i in found["items"]]
        self.assertEqual(stamps, sorted(stamps, reverse=True), "newest first")
        self.assertEqual(found["total"], 3)
        self.assertEqual({k: v for k, v in found["counts"].items() if v}, {"email": 1, "app_link": 1, "computer_check": 1})
        self.assertEqual(found["by_pip"], {pip: 3})
        item = {i["kind"]: i for i in found["items"]}
        self.assertEqual((item["email"]["card"], item["email"]["pip_name"], item["email"]["title"], item["email"]["detail"]),
                         (email["id"], "Morning planner", "Send this email to review@example.invalid?", "Weekend plan"))
        self.assertEqual((item["app_link"]["card"], item["app_link"]["title"]), (link["id"], "Connect Gmail?"))
        self.assertEqual(item["computer_check"]["title"], "Prove you’re human on www.google.com")
        self.assertTrue(all(i["workspace_id"] == workspace for i in found["items"]))

    def test_settled_expired_and_archived_ones_are_gone_and_the_limit_keeps_the_count(self):
        pip, workspace = self.source["id"], self.source["workspace_id"]
        for n in range(5):
            self.save("pip-email:" + self.run["id"], str(n) * 64)
        found = self.control("list_pip_attention", limit=2)
        self.assertEqual((len(found["items"]), found["total"], found["truncated"]), (2, 5, True))
        self.now = "2026-10-06T06:00:00.000Z"                    # past the drafts' 24 hours
        self.assertEqual(self.control("list_pip_attention")["total"], 0)
        links.request(self.registry, pip, workspace, "gmail", "To read your new mail.", self.run["id"])
        self.assertEqual(self.control("list_pip_attention")["counts"]["app_link"], 1)
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (pip,))
        self.assertEqual(self.control("list_pip_attention")["total"], 0, "an archived Pip waits for nothing")

    def test_it_is_this_computers_alone_and_its_limit_is_checked(self):
        with self.assertRaises(RegistryError) as raised:
            self.control("list_pip_attention", actor="device_1")
        self.assertEqual(raised.exception.code, "local_only")
        for bad in (0, 101, True, "5"):
            with self.subTest(limit=bad), self.assertRaises(RegistryError):
                self.control("list_pip_attention", limit=bad)
        self.assertEqual(pip_attention.collect(self.registry, self.now)["items"], [])

    def test_a_careful_hold_says_what_it_is(self):
        pip = self.source["id"]
        for kind, summary, title in (("site", {"kind": "site", "site": "amazon.in", "host": "www.amazon.in"}, "Visit amazon.in?"),
                                     ("text", {"kind": "text", "host": "shop.example"}, "Put what it read from your apps on shop.example?"),
                                     ("form", {"method": "POST", "host": "shop.example"}, "Send this on shop.example?"),
                                     ("pay", {"method": "POST", "host": "pay.hospital.example", "payment": True,
                                              "fields": [{"name": "billno", "value": "SMH/OP/26/118734"}, {"name": "amount", "value": "5350.00"},
                                                         {"name": "card_number", "value": "•••"}]}, "Pay on pay.hospital.example?")):
            with self.registry.transaction():
                self.registry.db.execute("INSERT INTO pip_computer_actions VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,NULL,NULL,NULL)",
                                         ("compact_" + kind[0] * 32, pip, self.source["workspace_id"], self.run["id"], "host_x", "r-" + kind,
                                          json.dumps(summary), "d" * 64, None, self.now, "2099-01-01T00:00:00.000Z"))
            with self.subTest(kind=kind):
                items = {i["card"]: i for i in self.control("list_pip_attention")["items"]}
                self.assertEqual(items["compact_" + kind[0] * 32]["title"], title)
                if kind == "pay":
                    # It says what it pays, never a hidden card field (three-asks test, 2026-10-20).
                    self.assertEqual(items["compact_" + kind[0] * 32]["detail"], "billno SMH/OP/26/118734 · amount 5350.00")

