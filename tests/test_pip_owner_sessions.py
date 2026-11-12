"""Project Pips: one owner session (asked 12 Nov).

"For project Pips, there has to be a session owner; by default the session owner becomes the session who creates
those Pips, and their cards only appear on their owner sessions. User should be able to change the owner session on
Project Pips settings." Answers the same day: strictly one owner (attaching a Pip to a chat makes that chat its owner);
archiving or deleting an owning session asks first (the editor reads list_session_pips); the Pips view and Home keep
every card. A run a chat started still comes back to that chat.
"""
import json

from dgc import pip_owners, pip_report_delivery as delivery, pips
from dgc.workspace_registry import RegistryError, identifier
from tests.test_pip_report_delivery import Scene, finding


class OwnerSessions(Scene):
    def created_in(self, session_id, pip=None):
        pip = pip or self.pip
        receipt = {"setup_id": identifier("setup"), "pip_id": pip["id"], "job_version": 1, "run_id": None,
                   "next_run_at": None, "accepted": True, "actor": "editor-user", "resolved_at": self.now}
        self.registry.db.execute("INSERT INTO pip_setup_proposals VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            (receipt["setup_id"], self.workspace["id"], session_id, identifier("key")[:40], "digest", "{}", "digest",
             "accepted", json.dumps(receipt), self.now, self.now))

    def test_the_session_that_created_it_owns_it_and_alone_hears_from_it(self):
        mine, other = self.chat("chat-mine"), self.chat("chat-other")
        self.created_in(mine)
        self.attach(other)                                   # an older attachment, from before owners
        self.later(1)
        self.assertEqual(pip_owners.owner(self.registry.db, self.pip["id"])["session_id"], other,
                         "of the chats it reported to, the newest link stands as its owner until one is chosen")
        pip_owners.set_owner(self.registry, self.pip["id"], mine, "editor-user")
        self.later(1)
        run = self.finished(findings=[finding("Unchecked total")])
        self.assertEqual([c["run_id"] for c in self.shown(mine)], [run])
        self.assertEqual(self.shown(other), [], "only the owner session hears from it")
        self.assertEqual(delivery.report_chats(self.registry, self.pip["id"]), 1)
        self.assertEqual(delivery.report_session(self.registry, self.pip["id"]), mine)

    def test_by_default_the_creator(self):
        mine = self.chat("chat-mine")
        self.created_in(mine)
        found = pip_owners.owner(self.registry.db, self.pip["id"])
        self.assertEqual((found["session_id"], found["chosen"]), (mine, False))

    def test_change_the_owner_and_the_cards_move(self):
        a, b = self.chat("chat-a"), self.chat("chat-b")
        self.created_in(a)
        result = pip_owners.set_owner(self.registry, self.pip["id"], b, "editor-user")
        self.assertEqual(result, {"pip_id": self.pip["id"], "session_id": b})
        self.later(1)
        run = self.finished(findings=[finding("Late invoices")])
        self.assertEqual(self.shown(a), [])
        self.assertEqual([c["run_id"] for c in self.shown(b)], [run])

    def test_no_session_its_reports_wait_in_the_pips_view(self):
        a = self.chat("chat-a")
        self.created_in(a)
        pip_owners.set_owner(self.registry, self.pip["id"], None, "editor-user")
        self.assertEqual(pip_owners.owner(self.registry.db, self.pip["id"]), {"session_id": None, "chosen": True,
                                                                              "since": self.now})
        self.later(1)
        self.finished(findings=[finding("Late invoices")])
        self.assertEqual(self.shown(a), [])
        self.assertIsNone(delivery.report_session(self.registry, self.pip["id"]))

    def test_a_run_a_chat_started_still_comes_back_to_it(self):
        a, b = self.chat("chat-a"), self.chat("chat-b")
        self.created_in(a)
        asked = self.finished(findings=[], requested_by=delivery.chat_identity(b))
        self.assertEqual([c["run_id"] for c in self.shown(b)], [asked])

    def test_what_a_session_owns_for_the_archive_and_delete_question(self):
        a, b = self.chat("chat-a"), self.chat("chat-b")
        second = self.store.create(self.workspace["id"], "Stock watch", "Watch stock.", "fixture", pip_type="lens")
        self.created_in(a)
        self.created_in(a, second)
        pip_owners.set_owner(self.registry, second["id"], b, "editor-user")
        owned = pip_owners.owned(self.registry, a)
        self.assertEqual(owned["session_id"], a)
        self.assertEqual([(p["id"], p["name"]) for p in owned["pips"]], [(self.pip["id"], "ERP daily audit")])
        self.assertEqual([p["id"] for p in pip_owners.owned(self.registry, b)["pips"]], [second["id"]])

    def test_refusals(self):
        a = self.chat("chat-a")
        self.created_in(a)
        with self.assertRaises(RegistryError) as caught:
            pip_owners.set_owner(self.registry, self.pip["id"], a, "main-chat:abc")
        self.assertEqual(caught.exception.code, "local_only")
        with self.assertRaises(RegistryError):
            pip_owners.set_owner(self.registry, self.pip["id"], "../etc", "editor-user")
        with self.assertRaises(RegistryError) as caught:
            pip_owners.set_owner(self.registry, self.pip["id"], "chat-not-here", "editor-user")
        self.assertIn("this project", str(caught.exception))
        elsewhere = self.base / "other"
        elsewhere.mkdir()
        self.registry.associate_session("chat-elsewhere", elsewhere)
        with self.assertRaises(RegistryError) as caught:
            pip_owners.set_owner(self.registry, self.pip["id"], "chat-elsewhere", "editor-user")
        self.assertIn("this project", str(caught.exception))

    def test_a_personal_pip_has_no_owner_session(self):
        personal = self.registry.personal()
        pip = self.store.create(personal["id"], "Errands", "Help.", "fixture", pip_type="quill")
        with self.assertRaises(RegistryError) as caught:
            pip_owners.set_owner(self.registry, pip["id"], None, "editor-user")
        self.assertEqual(caught.exception.code, "personal")


class TheCommands(Scene):
    def test_api_89_commands_are_known_and_local_only(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 89)
        for name, args in (("get_pip_owner", {"pip_id"}), ("set_pip_owner", {"pip_id", "session_id"}),
                           ("list_session_pips", {"session_id"})):
            with self.subTest(name=name):
                self.assertIn(name, pips.CONTROL_COMMANDS)
                self.assertEqual(pips._COMMAND_ARGS[name], args)

    def test_both_sdks_know_them_at_89(self):
        import sys
        sys.path.insert(0, "sdk/python")
        from dgc_sdk import pips as sdk
        self.assertIn("get_pip_owner", sdk.READ_COMMANDS)
        self.assertIn("list_session_pips", sdk.READ_COMMANDS)
        self.assertIn("set_pip_owner", sdk.MUTATION_COMMANDS)
        ts = open("sdk/typescript/src/pips.ts", encoding="utf-8").read()
        self.assertIn('const API89_READS = new Set(["get_pip_owner", "list_session_pips"]);', ts)
        self.assertIn('const API89_MUTATIONS = new Set(["set_pip_owner"]);', ts)
