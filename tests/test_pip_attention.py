"""One "Needs attention" list across every Personal Pip (pip_attention): each card waiting for you, newest
first, naming its Pip and the card it opens. Reading it never changes anything."""
import json
import unittest
from unittest.mock import patch

from dgc import pip_app_links as links, pip_attention, pip_message_drafts as drafts, pip_plugins, pips
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pip_app_actions as fixtures


class AttentionTests(unittest.TestCase):
    def test_malformed_saved_card_payload_does_not_break_attention(self):
        for kind, value in (("email", {"message": []}), ("event", {"event": []}),
                            ("action", {"action": [], "call": []})):
            with self.subTest(kind=kind):
                title, detail = pip_attention._what(kind, value)
                self.assertIsInstance(title, str)
                self.assertIsInstance(detail, str)

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

    def test_a_personal_pips_waiting_review_is_on_the_list_and_a_projects_is_named_apart(self):
        """The one number: home, Pips page and the editor's notice all read `total`. A reviewed workflow's handoff waited
        for you unlisted, so the notice said 2 beside a home that said 1 (final check, 2026-11-07)."""
        from dgc import pip_handoffs, pip_flows
        now = self.now
        personal = self.registry.personal()
        made = [self.store.create(personal["id"], name, goal, "local-console", pip_type="rook")
                for name, goal in (("Research", "Research a topic"), ("Writer", "Write a draft"))]
        flow = pip_flows.create(self.store, "Daily post", [p["id"] for p in made], ["Write using these notes."], "reviewed", "local-console", self.cfg)
        queued = self.store.enqueue(made[0]["id"], "research", "local-console", self.cfg)
        self.assertEqual(self.store.claim_next()["id"], queued["id"])
        self.store.finish(queued["id"], result={"text": "Research result.", "external_actions": False, "tools_called": 0, "usage": {}})
        pip_flows.after_run(self.store, self.cfg, queued["id"])
        before = self.control("list_pip_attention")
        handoff = pip_flows.get(self.store, flow["id"])["steps"][0]["handoff_id"]
        self.assertEqual(before["counts"]["handoff"], 1)
        self.assertEqual(before["total"], 1)
        self.assertEqual(before["by_pip"], {made[1]["id"]: 1})
        self.assertEqual(before["items"], [], "a client from before refuses a kind it doesn't know")
        [row] = before["reviews"]
        self.assertEqual((row["kind"], row["card"], row["pip_id"], row["pip_name"]), ("handoff", handoff, made[1]["id"], "Writer"))
        self.assertEqual(row["title"], "Hand this to Writer?")
        self.assertEqual(row["detail"], "Write using these notes.")
        self.assertEqual(before["in_projects"], 0)
        # A change waiting on a Personal Pip's Changes page.
        proposal = self.store.propose(made[0]["id"], made[0]["current_version"], {"goal": "Research harder"}, "local-console")
        listed = self.control("list_pip_attention")
        self.assertEqual(listed["total"], 2)
        change = next(r for r in listed["reviews"] if r["kind"] == "approval")
        self.assertEqual((change["card"], change["review"]), (proposal["id"], "job_update"))
        # A project Pip's review waits in that project: named apart, never in the number the Pips home says.
        project = self.store.create(self.workspace["id"], "Project", "Review", "local-console")
        self.store.propose(project["id"], project["current_version"], {"goal": "Review harder"}, "local-console")
        apart = self.control("list_pip_attention")
        self.assertEqual(apart["total"], 2)
        self.assertEqual(apart["in_projects"], 1)
        self.assertNotIn(project["id"], apart["by_pip"])
        # What a project's tab and its row say: its number, and the Pip it waits on. A Personal folder is never in it.
        self.assertEqual(apart["projects"], {self.workspace["id"]: {"total": 1, "by_pip": {project["id"]: 1}}})
        self.assertEqual(sum(place["total"] for place in apart["projects"].values()), apart["in_projects"])
        self.assertEqual(self.now, now)

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

