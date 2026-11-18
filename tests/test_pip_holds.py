"""A Pip at Do it all never shows an approval card: what still needs the user is held and asked in its chat
(dgc/pip_holds.py; his rule, 17 Nov: "it never shows any approval card or anything, but it could still ask user things
in chat"; "DGC itself should still hold the action until you answer — yes, so it asks, rather than an allow card").

- A held step runs nothing and draws no card; the Pip is told to ask in one plain sentence and carry on.
- It runs once when the Pip makes the same step again with "confirm": true, in a later chat turn the user's own message
  started. The run that asked, a routine's run and a turn DGC started never answer it.
- It is kept in the registry, so it outlives the run; the Pip's next turn the user starts names what still waits.
- Below Do it all nothing changes: the Allow card stays.
"""
from __future__ import annotations

import unittest
from unittest.mock import patch

from dgc import pip_holds, pip_plugins, plugins
from tests import test_pips_local as local
from tests.test_pip_borrow import Borrow
from tests.test_pip_plugins import PluginWorld, Vendor
from tests.test_pip_project_copies import ProjectWorld

WAITING = "WAITING FOR THE USER"


class Holds(PluginWorld, unittest.TestCase):
    RUN = "run_" + "a" * 32
    NEXT = "run_" + "b" * 32

    def setUp(self):
        local.LocalPipsTests.setUp(self)
        self.world()
        Vendor.made.clear()
        self.pip = self.store.create(self.registry.personal()["id"], "Ava", "Keep my plans", "local-console")

    def session_for(self, run=None, *, unattended=False, user_turn=True, level="full"):
        session = pip_plugins.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"],
                                      run or self.RUN, unattended=unattended)
        session.level_now = lambda: level
        session.user_turn = user_turn
        self.addCleanup(session.close)
        return session

    def call(self, session, confirm=None, tool="create_record", plugin="airtable", **arguments):
        args = {"plugin": plugin, "tool": tool, "arguments": arguments or {"table": "Plans", "fields": {"Name": "Run"}}}
        if confirm is not None:
            args["confirm"] = confirm
        return session.call(self.registry, "call_plugin", args)

    def sent(self):
        return [call for vendor in Vendor.made for call in vendor.calls if call[0] and "create_record" in str(call)]


class PluginSetToAlwaysAsk(Holds):
    def setUp(self):
        super().setUp()
        plugins.set_permission("airtable", "always_ask", money=False)

    def test_held_in_the_chat_with_no_card(self):
        said = self.call(self.session_for())
        self.assertIsInstance(said, str, "no draft: no card")
        self.assertIn(WAITING, said)
        self.assertIn("create_record in Airtable", said)
        self.assertIn('"confirm": true', said)
        self.assertIn("don't do the same thing another way", said, "live check, 18 Nov: a model emptied the folder file by file")
        self.assertEqual(self.sent(), [], "nothing ran")
        held = pip_holds.waiting(self.registry, self.pip["id"])
        self.assertEqual([h["kind"] for h in held], ["plugin"])

    def test_the_users_next_own_message_runs_it_once(self):
        self.call(self.session_for())
        later = self.session_for(self.NEXT)
        said = self.call(later, confirm=True)
        self.assertIsInstance(said, str)
        self.assertNotIn(WAITING, said)
        self.assertIn("create_record ran in the user's Airtable", said)
        self.assertEqual(len(self.sent()), 1)
        self.assertNotIn("confirm", str(self.sent()[0][1]), "DGC's own word never reaches the plugin")
        self.assertEqual(pip_holds.waiting(self.registry, self.pip["id"]), [], "the hold is used")
        self.assertIn(WAITING, self.call(self.session_for("run_" + "c" * 32), confirm=True), "once: the next time it asks again")

    def test_the_same_call_in_the_users_next_turn_is_their_yes_without_confirm(self):
        # As Work's holds: the same step made again in a later turn the user's own message started runs. A model that
        # leaves out "confirm" (live check, 18 Nov) still gets the user's yes.
        self.call(self.session_for())
        said = self.call(self.session_for(self.NEXT))
        self.assertIn("create_record ran in the user's Airtable", said)
        self.assertEqual(len(self.sent()), 1)

    def test_the_run_that_asked_cannot_answer_it(self):
        session = self.session_for()
        self.call(session)
        said = self.call(session, confirm=True)
        self.assertIn("hasn't answered", said)
        self.assertEqual(self.sent(), [])

    def test_a_routine_or_a_turn_dgc_started_cannot_answer_it(self):
        self.call(self.session_for())
        for session in (self.session_for(self.NEXT, unattended=True), self.session_for(self.NEXT, user_turn=False)):
            with self.subTest(unattended=session.unattended, user_turn=session.user_turn):
                self.assertNotIn("ran in the user's", self.call(session, confirm=True))
        self.assertEqual(self.sent(), [])
        self.assertEqual(len(pip_holds.waiting(self.registry, self.pip["id"])), 1, "still held")

    def test_a_different_step_is_not_the_one_the_user_said_yes_to(self):
        self.call(self.session_for())
        said = self.call(self.session_for(self.NEXT), confirm=True, table="Other")
        self.assertIn(WAITING, said)
        self.assertEqual(self.sent(), [])

    def test_confirm_with_nothing_asked_holds_it(self):
        said = self.call(self.session_for(self.NEXT), confirm=True)
        self.assertIn(WAITING, said)
        self.assertEqual(self.sent(), [])

    def test_the_next_turn_names_what_still_waits(self):
        self.call(self.session_for())
        note = pip_holds.still_waiting(self.registry, self.pip["id"])
        self.assertIn("create_record in Airtable", note)
        self.assertEqual(pip_holds.still_waiting(self.registry, "pip_other"), "")

    def test_it_outlives_the_run_and_a_day_ends_it(self):
        self.call(self.session_for())
        with patch("dgc.pip_holds.time.time", return_value=pip_holds.time.time() + pip_holds.KEEP_SECONDS + 5):
            self.assertEqual(pip_holds.waiting(self.registry, self.pip["id"]), [])
            self.assertIn(WAITING, self.call(self.session_for(self.NEXT), confirm=True))

    def test_below_do_it_all_the_card_stays(self):
        said = self.call(self.session_for(level="approve"))
        self.assertIsInstance(said, dict, "a draft: the Allow card")
        self.assertIn("draft", said)
        self.assertEqual(pip_holds.waiting(self.registry, self.pip["id"]), [])


class TheFuseAtDoItAll(Holds):
    """25 things done on its own in an hour (pip_levels.fuse): a Pip at Do it all asks again, in the chat, not on cards."""

    def test_a_change_waits_in_the_chat_while_the_fuse_holds(self):
        from dgc import pip_levels
        pip_levels.set_level(self.registry, self.pip["id"], "full", "editor-user")
        session = self.session_for()
        session.level_now = pip_levels.follow(self.registry.directory, self.pip["id"])
        with patch.object(pip_levels, "fuse", return_value="2026-11-18T03:00:00Z"):
            said = self.call(session)
        self.assertIsInstance(said, str, "no card")
        self.assertIn(WAITING, said)
        self.assertIn("25 things on its own", said)
        self.assertEqual(self.sent(), [])


class PluginThatMovesMoney(Holds):
    def test_held_in_the_chat_when_it_may_not_pay(self):
        said = self.call(self.session_for(), plugin="aave", tool="create_record")
        self.assertIsInstance(said, str)
        self.assertIn(WAITING, said)

    def test_careful_mode_is_left_as_it_was(self):
        session = self.session_for()
        session.carries = lambda text: "4829137755" in text
        said = self.call(session, table="T", fields={"Ref": "4829137755"})
        self.assertIsInstance(said, str, "at Do it all careful mode lets it go to the user's own plugin, as before")


class TheNextTurnSaysWhatWaits(unittest.TestCase):
    """The Pip's next chat turn the user starts names what it still holds; a routine's turn doesn't."""

    def setUp(self):
        from tests.test_pip_notes import NotesTests
        NotesTests.setUp(self)
        self.pip = NotesTests.make(self)

    def test_the_users_turn_carries_the_line_and_its_prompt_shows_it(self):
        import json
        import os
        from dgc import pip_chat, pip_notes, pips
        from dgc.llm import ChatResult, LLMClient
        pip_holds.hold(self.registry, self.pip["id"], "plugin", {"tool": "send"}, what="send_email in Gmail",
                       why="it is set to Always ask", run_id="run_" + "0" * 32)
        for actor, carried in (("editor-user", True), ("local-routine", False)):
            run = pip_chat.send(self.store, self.pip["id"], "hello", "k-" + actor, actor, self.cfg)["run"]
            manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
            raw = pip_holds.runtime(self.registry, run, pip_notes.runtime(self.registry, run, manifest))
            with self.subTest(actor=actor):
                self.assertEqual("pip_holds_note" in raw, carried)
            if carried:
                seen = []

                def chat(client, messages, tools=None, **kwargs):
                    seen.append(json.dumps(messages))
                    return ChatResult(content="Still waiting on your yes for that email.")
                with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                        patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                        patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
                    result = pips.execute_native(self.cfg, self.root, raw, lambda e: None)
                self.assertIn("Still waiting on the user", seen[0])
                self.assertIn("send_email in Gmail", seen[0])
                self.store.claim_next()
                self.store.finish(run["id"], result=result)

    def test_a_reply_that_held_a_step_says_so_even_if_the_model_didnt(self):
        # Live check, 18 Nov (deepseek-v4.1-flash:cloud): a Pip's reply after its Terminal command was held said only
        # "I'll clear my working folder", and nothing asked the user. DGC adds the line itself.
        from dgc import pip_chat
        run = pip_chat.send(self.store, self.pip["id"], "empty your folder", "k-held", "editor-user", self.cfg)["run"]
        pip_holds.hold(self.registry, self.pip["id"], "floor", {"command": "x"}, run_id=run["id"],
                       what="the Terminal command `rm -rf ~/*`", why="it could delete everything in its Files")
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "I'll clear my working folder."})
        kept = self.registry.db.execute("SELECT text FROM pip_chat_messages WHERE run_id=? AND role='assistant'",
                                        (run["id"],)).fetchone()[0]
        self.assertTrue(kept.startswith("I'll clear my working folder."), kept)
        self.assertIn("Waiting for your yes: the Terminal command `rm -rf ~/*`", kept)
        self.assertIn("could delete everything in its Files", kept)


class YourOwnChromeAtDoItAll(Borrow):
    """His call (17 Nov): at Do it all the user's own signed-in Chrome is asked about ONCE, in the chat, for the session
    ("use my browser for things"); then it is lent in the same reply, with no card. Below Do it all the card stays."""

    def setUp(self):
        super().setUp()
        self.n = 0

    def running(self):
        from dgc import pip_chat
        self.n += 1
        self.registry.db.execute("UPDATE pip_runs SET status='failed' WHERE pip_id=? AND status IN ('queued','running')",
                                 (self.pip["id"],))
        run = self.store.enqueue(self.pip["id"], f"chat_{self.n}", "editor-user", self.cfg,
                                 conversation_request=pip_chat.request("use it", f"k-{self.n}"))
        self.registry.db.execute("UPDATE pip_runs SET status='running' WHERE id=?", (run["id"],))
        return run

    def session(self, *, level="full", user_turn=True, unattended=False):
        from dgc import pip_borrow
        from tests.fake_chrome import FakeChrome
        from tests.test_pip_borrow import shop_pages
        fake = FakeChrome(shop_pages())
        self.addCleanup(fake.close)
        run = self.running()
        session = pip_borrow.Session(self.registry.directory, self.cfg, self.pip["id"], self.pip["workspace_id"], run["id"],
                                     folders=fake.folders(), level=level, unattended=unattended, user_turn=user_turn)
        self.addCleanup(session.close)
        return session

    def cards(self):
        return [b for b in self.control("list_pip_borrows", pip_id=self.pip["id"])["borrows"] if b["status"] == "requested"]

    def ask(self, session, **more):
        return session.ask({"sites": ["shop.example"], "why": "read your order history", **more})

    def test_asked_once_in_the_chat_then_lent_with_no_card(self):
        said = self.ask(self.session())
        self.assertTrue(said.startswith(WAITING), said)
        self.assertIn("your own signed-in Chrome", said)
        self.assertEqual(self.cards(), [], "no card")
        later = self.session()
        said = self.ask(later, confirm=True)
        self.assertIn("You have the user's own Chrome for shop.example now", said)
        self.assertIsNotNone(later.grant)
        self.assertEqual(self.cards(), [])
        [lent] = self.control("list_pip_borrows", pip_id=self.pip["id"])["borrows"]
        self.assertEqual(lent["status"], "in_use")
        page = later.use({"op": "open", "url": "https://shop.example/orders"})
        self.assertNotIn("hasn't lent you", page)
        self.assertIn("shop.example", page, "the lent tab opens the site in this same reply")
        # Asked once for the session: the next reply that needs it is lent it at once.
        again = self.session()
        self.assertIn("You have the user's own Chrome", self.ask(again))
        self.assertEqual(pip_holds.waiting(self.registry, self.pip["id"]), [])

    def test_the_session_ends_after_twelve_hours(self):
        from dgc import pip_borrow
        self.ask(self.session())
        self.ask(self.session(), confirm=True)
        with patch("dgc.pip_borrow.time.time", return_value=pip_borrow.time.time() + pip_borrow.CONSENT_SECONDS + 5):
            self.assertTrue(self.ask(self.session()).startswith(WAITING))

    def test_the_run_that_asked_a_routine_or_a_turn_dgc_started_cannot_say_yes(self):
        session = self.session()
        self.ask(session)
        self.assertIn(WAITING, self.ask(session, confirm=True))
        self.assertIn(WAITING, self.ask(self.session(unattended=True), confirm=True))
        self.assertIn(WAITING, self.ask(self.session(user_turn=False), confirm=True))
        self.assertEqual(self.cards(), [])

    def test_a_routine_is_never_lent_it_even_after_a_yes(self):
        self.ask(self.session())
        self.ask(self.session(), confirm=True)
        routine = self.session(unattended=True)
        said = self.ask(routine)
        self.assertNotIn("You have the user's own Chrome", said)
        self.assertIsNone(routine.grant)
        self.assertEqual(self.cards(), [])

    def test_below_do_it_all_the_card_stays(self):
        said = self.ask(self.session(level="approve"))
        self.assertNotIn(WAITING, said)
        self.assertEqual(len(self.cards()), 1)


class UndoInTheChat(ProjectWorld, unittest.TestCase):
    """At Do it all a project Pip applies its change by itself; the user asks it in the chat to put it back (his call,
    17 Nov, (a)). Only their own turn undoes; a routine's never does."""

    def applied(self):
        from dgc import pip_project_copies as copies
        copies.prepare(self.store, self.pip["id"], [self.mark()], "key-1")
        box = self.box()
        (box / "app.py").write_text("def total(items):\n    return round(sum(items), 2)\n")
        [change] = self.changes()
        self.control("apply_pip_project_change", pip_id=self.pip["id"], change_id=change["id"], expected_digest=change["digest"])
        self.assertIn("round(", (self.root / "app.py").read_text())
        return change

    def keep(self, user_turn, asked):
        from dgc import pip_project_copies as copies
        run = {"pip_id": self.pip["id"], "manifest": {"user_turn": user_turn, "conversation": {"text": "undo that"}}}
        with self.registry.transaction():                      # as the reply is kept: inside its transaction
            return copies.undo_asked(self.store, run, {"undo_changes": asked})

    def test_the_users_own_turn_puts_back_the_last_change(self):
        change = self.applied()
        [done] = self.keep(True, ["last"])
        self.assertEqual((done["change"], done["undone"]), (change["id"], True))
        self.assertEqual((self.root / "app.py").read_text(), "def total(items):\n    return sum(items)\n")
        self.assertEqual(self.changes()[0]["status"], "undone")

    def test_a_routine_or_a_turn_dgc_started_undoes_nothing(self):
        self.applied()
        [said] = self.keep(False, ["last"])
        self.assertFalse(said["undone"])
        self.assertIn("round(", (self.root / "app.py").read_text())

    def test_only_this_pips_changes(self):
        self.applied()
        [said] = self.keep(True, ["pchange_" + "0" * 32])
        self.assertFalse(said["undone"])
        self.assertIn("round(", (self.root / "app.py").read_text())


class AFolderPipsChatCanAskToUndo(unittest.TestCase):
    """The real worker, its model stood in: undo_pip_change is offered in a folder Pip's chat turn the user started, and
    the reply carries the ask for DGC to keep (pip_project_copies.undo_asked)."""

    def setUp(self):
        from tests.test_folder_pip_q8 import FolderPipChat
        self.world = type("W", (FolderPipChat, unittest.TestCase), {"runTest": lambda self: None})()
        self.world.setUp()
        self.addCleanup(self.world.doCleanups)

    def turn(self, user_turn):
        import json
        import os
        from dgc import pip_chat, pips
        from dgc.llm import ChatResult, LLMClient, ToolCall
        w = self.world
        sent = pip_chat.send(w.store, w.helper["id"], "Undo what you changed", f"u-{user_turn}", "device_1", w.cfg)
        manifest = json.loads(w.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (sent["run"]["id"],)).fetchone()[0])
        manifest["computer_socket"] = {"socket": str(w.base / "absent.sock"), "token": "t" * 32}
        manifest["own_folder"] = {"name": "shop", "folder": "projects/shop", "files": 5, "kept": False, "updated": 5}
        manifest["user_turn"] = user_turn
        manifest["pip_notes"], manifest["working_notes"] = [], []
        seen = {}
        turns = iter([ChatResult(content="", tool_calls=[ToolCall("u1", "undo_pip_change", {})]),
                      ChatResult(content="Putting it back.")])

        def chat(client, messages, tools=None, on_text=None, **kwargs):
            seen.setdefault("tools", {t["function"]["name"] for t in tools})
            return next(turns) if "undo_pip_change" in seen["tools"] else ChatResult(content="Done.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy())}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            result = pips.execute_native(w.cfg, w.root, manifest, lambda event: None)
        return seen, result

    def test_offered_in_the_users_turn_and_carried_in_the_reply(self):
        seen, result = self.turn(True)
        self.assertIn("undo_pip_change", seen["tools"])
        self.assertEqual(result.get("undo_changes"), ["last"])

    def test_not_offered_in_a_turn_dgc_started(self):
        seen, result = self.turn(False)
        self.assertNotIn("undo_pip_change", seen["tools"])
        self.assertNotIn("undo_changes", result)


if __name__ == "__main__":
    unittest.main()
