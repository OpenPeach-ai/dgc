"""Several conversations per Pip (0.52, D11; decided 10 Nov).

One Pip keeps one identity, memory, computer and routines, with as many chats as you like. Today's chat becomes each
Pip's first conversation, nothing lost. Each conversation keeps its own history, checkpoints, steering and unread
count. A Pip answers in its conversations in parallel (the user's call): a message in another conversation starts its
own reply while one runs; two replies of one conversation never run together. A client that names no conversation
(an older editor or SDK) talks to the first one.
"""
from __future__ import annotations

import json
import threading
import time
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_conversations as conversations
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class Conversations(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def job(self, name="Planner"):
        return self.store.create(self.registry.personal()["id"], name, "Help plan my day", "user")

    def say(self, job, text, key, conversation_id=None, finish="Okay."):
        sent = pip_chat.send(self.store, job["id"], text, key, "user", self.cfg, conversation_id=conversation_id)
        run = sent["run"]
        if finish is not None:
            claimed = self.store.claim_next()
            self.assertEqual(claimed["id"], run["id"])
            self.store.finish(run["id"], result={"text": finish})
        return sent

    def history(self, run_id):
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()[0])
        return [m["content"] for m in manifest["conversation"]["history"]]

    def test_a_pip_starts_with_one_first_conversation_and_an_older_client_talks_to_it(self):
        job = self.job()
        sent = self.say(job, "Hello", "k1")                     # names no conversation: the first one
        [first] = conversations.listed(self.registry.db, job["id"])
        self.assertTrue(first["first"])
        self.assertEqual(sent["message"]["conversation_id"], first["id"])
        self.assertEqual([m["text"] for m in pip_chat.list_messages(self.store, job["id"])["messages"]], ["Hello", "Okay."])

    def test_each_conversation_keeps_its_own_history(self):
        job = self.job()
        self.say(job, "Plan my Monday", "k1", finish="Monday is planned.")
        other = conversations.create(self.registry, job["id"], "Groceries")
        sent = self.say(job, "Milk and eggs", "k2", conversation_id=other["id"], finish=None)
        self.assertEqual(self.history(sent["run"]["id"]), [], "a new conversation starts empty")
        first = conversations.first(self.registry.db, job["id"])
        later = self.say(job, "And Tuesday?", "k3", conversation_id=first, finish=None)
        self.assertEqual(self.history(later["run"]["id"]), ["Plan my Monday", "Monday is planned."],
                         "the first conversation's history only")
        texts = lambda cid: [m["text"] for m in pip_chat.list_messages(self.store, job["id"], conversation_id=cid)["messages"]]
        self.assertEqual(texts(other["id"]), ["Milk and eggs"])
        self.assertEqual(texts(first), ["Plan my Monday", "Monday is planned.", "And Tuesday?"])

    def test_a_pip_answers_in_two_conversations_at_once_but_never_twice_in_one(self):
        job = self.job()
        a = self.say(job, "Start a long plan", "k1", finish=None)
        self.assertEqual(self.store.claim_next()["id"], a["run"]["id"])          # A's reply is running
        b_conv = conversations.create(self.registry, job["id"], "Another")
        b = self.say(job, "Quick question", "k2", conversation_id=b_conv["id"], finish=None)
        self.assertNotEqual(b["run"]["id"], a["run"]["id"], "its own reply, not a steer into A's")
        self.assertEqual(self.store.claim_next()["id"], b["run"]["id"], "B's reply starts while A's runs")
        again = pip_chat.send(self.store, job["id"], "Also add lunch", "k3", "user", self.cfg)
        self.assertEqual(again["run"]["id"], a["run"]["id"], "a second message in A joins A's running reply")

    def test_a_conversation_belongs_to_its_pip(self):
        mine, theirs = self.job("Mine"), self.job("Theirs")
        other = conversations.create(self.registry, theirs["id"], "Not yours")
        with self.assertRaises(RegistryError) as caught:
            pip_chat.send(self.store, mine["id"], "Hi", "k1", "user", self.cfg, conversation_id=other["id"])
        self.assertEqual(caught.exception.code, "not_found")
        with self.assertRaises(RegistryError):
            pip_chat.send(self.store, mine["id"], "Hi", "k2", "user", self.cfg, conversation_id="conv_../../etc")

    def test_existing_chats_become_each_pips_first_conversation_nothing_lost(self):
        job = self.job()
        self.say(job, "Before conversations", "k1", finish="An old reply.")
        db = self.registry.db
        # The registry as 0.51 left it: no conversations, no conversation on a message.
        db.execute("UPDATE pip_chat_messages SET conversation_id=NULL")
        db.execute("DELETE FROM pip_conversations")
        conversations.migrate(db)
        [first] = conversations.listed(db, job["id"])
        self.assertTrue(first["first"])
        rows = db.execute("SELECT conversation_id FROM pip_chat_messages WHERE pip_id=?", (job["id"],)).fetchall()
        self.assertEqual({r[0] for r in rows}, {first["id"]}, "every old message is in it")
        self.assertEqual([m["text"] for m in pip_chat.list_messages(self.store, job["id"])["messages"]],
                         ["Before conversations", "An old reply."])
        conversations.migrate(db)
        self.assertEqual(len(conversations.listed(db, job["id"])), 1, "migrating twice makes nothing twice")

    def test_a_saved_checkpoint_stays_untouched_and_belongs_to_the_first_conversation(self):
        # Checkpoints are immutable (a trigger refuses any UPDATE), so the migration must not fill their conversation;
        # one saved before conversations (no conversation) is the first conversation's. Found live on 10 Nov: the QA
        # profile's registry, with saved checkpoints, refused to migrate ("conversation checkpoints are immutable").
        from dgc import pip_chat_continuity as continuity
        job = self.job()
        sent = self.say(job, "Before conversations", "k1", finish="An old reply.")
        db = self.registry.db
        saved = db.execute("SELECT count(*) FROM pip_chat_checkpoints WHERE run_id=?", (sent["run"]["id"],)).fetchone()[0]
        self.assertEqual(saved, 1, "the reply saved its checkpoint")
        first_brief = continuity.latest(self.store, job["id"], verify_archive=False)
        # The registry as 0.51 left it: that checkpoint has no conversation. The immutability trigger is lifted only to
        # write that state, then put back exactly as it was.
        trigger = db.execute("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='immutable_pip_chat_checkpoint'").fetchone()[0]
        with self.registry.transaction():
            db.execute("DROP TRIGGER immutable_pip_chat_checkpoint")
            db.execute("UPDATE pip_chat_checkpoints SET conversation_id=NULL")
            db.execute(trigger)
            db.execute("UPDATE pip_chat_messages SET conversation_id=NULL")
            db.execute("DELETE FROM pip_conversations")
        with self.registry.transaction():
            conversations.migrate(db)                                    # must not raise
        self.assertEqual(db.execute("SELECT count(*) FROM pip_chat_checkpoints WHERE conversation_id IS NULL").fetchone()[0], 1,
                         "the checkpoint is left as it was")
        self.assertEqual(continuity.latest(self.store, job["id"], verify_archive=False), first_brief,
                         "and it is the first conversation's")
        other = conversations.create(self.registry, job["id"], "New")
        self.assertIsNone(continuity.latest(self.store, job["id"], verify_archive=False, conversation_id=other["id"]),
                          "a new conversation has none")


class UnreadAndApi(unittest.TestCase):
    """Unread is per conversation; a Pip's count is their sum (plus its run posts, which are in its first one). The
    Pips API (79) lists, starts, renames and archives conversations; send, list, mark read and the context meter take
    an optional conversation_id; a request that names none is about the first one, as an older editor or SDK means."""
    setUp = fixtures.LocalPipsTests.setUp
    say = Conversations.say

    def control(self, command, actor="editor-user", **fields):
        self.cfg.data["pips_enabled"] = True
        from dgc import pips
        from dgc.workspace_registry import WorkspaceRegistry
        clock = self.registry.clock
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory, clock=clock)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)
        if not response["ok"]:
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def test_unread_is_per_conversation_and_the_pip_counts_their_sum(self):
        from dgc import pip_unread
        job = Conversations.job(self)
        self.say(job, "Plan Monday", "k1", finish="Monday planned.")
        other = conversations.create(self.registry, job["id"], "Groceries")
        sent = self.say(job, "Milk", "k2", conversation_id=other["id"], finish="Added milk.")
        self.assertEqual(pip_unread._summary(self.registry.db, job["id"])["messages"], 2)
        listed = {c["title"] or "first": c["unread"] for c in self.control("list_pip_conversations", pip_id=job["id"])["conversations"]}
        self.assertEqual(listed, {"first": 1, "Groceries": 1})
        reply = [m for m in pip_chat.list_messages(self.store, job["id"], conversation_id=other["id"])["messages"] if m["role"] == "assistant"][0]
        after = self.control("mark_pip_read", pip_id=job["id"], message_id=reply["id"])
        self.assertEqual(after["messages"], 1, "reading Groceries leaves the first conversation unread")
        listed = {c["title"] or "first": c["unread"] for c in self.control("list_pip_conversations", pip_id=job["id"])["conversations"]}
        self.assertEqual(listed, {"first": 1, "Groceries": 0})
        first_reply = [m for m in pip_chat.list_messages(self.store, job["id"])["messages"] if m["role"] == "assistant"][0]
        self.assertEqual(self.control("mark_pip_read", pip_id=job["id"], message_id=first_reply["id"])["messages"], 0,
                         "an older client marks the first conversation read as before")

    def test_api_79_starts_renames_archives_and_restores_conversations(self):
        job = Conversations.job(self)
        made = self.control("create_pip_conversation", pip_id=job["id"], title="Trip to Goa")["conversation"]
        self.assertEqual((made["title"], made["first"]), ("Trip to Goa", False))
        self.control("rename_pip_conversation", pip_id=job["id"], conversation_id=made["id"], title="Goa, March")
        self.control("send_pip_message", pip_id=job["id"], text="Flights?", idempotency_key="k1", conversation_id=made["id"])
        page = self.control("list_pip_messages", pip_id=job["id"], conversation_id=made["id"])
        self.assertEqual((page["conversation_id"], [m["text"] for m in page["messages"]]), (made["id"], ["Flights?"]))
        self.assertEqual(self.control("list_pip_messages", pip_id=job["id"])["messages"], [], "the first one is apart")
        self.control("archive_pip_conversation", pip_id=job["id"], conversation_id=made["id"])
        titles = [c["title"] for c in self.control("list_pip_conversations", pip_id=job["id"])["conversations"]]
        self.assertNotIn("Goa, March", titles, "archived ones leave the list")
        shown = self.control("list_pip_conversations", pip_id=job["id"], archived=True)["conversations"]
        self.assertIn(("Goa, March", True), [(c["title"], c["archived"]) for c in shown])
        self.assertEqual([m["text"] for m in self.control("list_pip_messages", pip_id=job["id"], conversation_id=made["id"])["messages"]],
                         ["Flights?"], "and stay readable")
        with self.assertRaises(RegistryError) as caught:
            self.control("send_pip_message", pip_id=job["id"], text="More?", idempotency_key="k2", conversation_id=made["id"])
        self.assertEqual(caught.exception.code, "archived")
        self.control("archive_pip_conversation", pip_id=job["id"], conversation_id=made["id"], archived=False)
        self.assertIn("Goa, March", [c["title"] for c in self.control("list_pip_conversations", pip_id=job["id"])["conversations"]])
        first = conversations.first(self.registry.db, job["id"])
        with self.assertRaises(RegistryError):
            self.control("archive_pip_conversation", pip_id=job["id"], conversation_id=first)
        with self.assertRaises(RegistryError) as caught:
            self.control("create_pip_conversation", actor="device_1", pip_id=job["id"], title="From afar")
        self.assertEqual(caught.exception.code, "local_only")

    def test_the_context_meter_measures_one_conversation(self):
        job = Conversations.job(self)
        self.say(job, "A long plan " * 40, "k1", finish="Done " * 40)
        other = conversations.create(self.registry, job["id"], "Fresh")
        busy = self.control("get_pip_chat_context", pip_id=job["id"])
        fresh = self.control("get_pip_chat_context", pip_id=job["id"], conversation_id=other["id"])
        self.assertGreater(busy["recent_messages"], 0)
        self.assertEqual(fresh["recent_messages"], 0, "a new conversation's meter starts empty")


class RoutinesPost(unittest.TestCase):
    """A Pip's routines post in its first conversation (the user's call), and each can be moved to another; one whose
    conversation was archived posts in the first again rather than fail."""
    from tests.test_pip_routines import DAILY, RoutineTests as _R
    setUp_base = fixtures.LocalPipsTests.setUp
    setUp, at = _R.setUp, _R.at

    def ran_in(self, conversation_id):
        return [m["text"] for m in pip_chat.list_messages(self.store, self.pip["id"], conversation_id=conversation_id, limit=50)["messages"]
                if m["role"] == "user"]

    def test_a_routine_posts_in_the_first_conversation_or_the_one_it_was_moved_to(self):
        from dgc import pip_routines
        routine = pip_routines.add(self.store, self.pip["id"], "Morning brief", "Three tech stories.", self.DAILY)
        other = conversations.create(self.registry, self.pip["id"], "News")
        first = conversations.first(self.registry.db, self.pip["id"])
        self.at(24 * 60 + 1)
        self.assertEqual(pip_routines.tick(self.registry, self.cfg), {routine["id"]: "ran"})
        self.assertEqual(len(self.ran_in(first)), 1, "the first conversation, by default")
        self.store.finish(self.store.claim_next()["id"], result={"text": "Here they are."})
        moved = pip_routines.update(self.store, self.pip["id"], routine["id"], {"conversation_id": other["id"]})
        self.assertEqual(moved["conversation_id"], other["id"])
        self.at(2 * 24 * 60 + 2)
        self.assertEqual(pip_routines.tick(self.registry, self.cfg), {routine["id"]: "ran"})
        self.assertEqual(len(self.ran_in(other["id"])), 1, "then the one it was moved to")
        self.store.finish(self.store.claim_next()["id"], result={"text": "And today's."})
        conversations.archive(self.registry, self.pip["id"], other["id"])
        self.at(3 * 24 * 60 + 3)
        self.assertEqual(pip_routines.tick(self.registry, self.cfg), {routine["id"]: "ran"})
        self.assertEqual(len(self.ran_in(first)), 2, "its conversation archived: back in the first, never lost")
        back = pip_routines.update(self.store, self.pip["id"], routine["id"], {"conversation_id": None})
        self.assertNotIn("conversation_id", back, "None moves it back to the first")
        with self.assertRaises(RegistryError):
            pip_routines.update(self.store, self.pip["id"], routine["id"], {"conversation_id": "conv_" + "0" * 32})


class ComputerTakesTurns(unittest.TestCase):
    """Two replies of one Pip can run together; its computer is one screen, so they take turns on it. The reply that
    has it keeps it until it ends; the other's first computer step waits for it, and says so plainly if it waits too
    long. Nothing of one run's settings (careful mode, level, frames) ever leaks into the other's steps."""
    setUp = fixtures.LocalPipsTests.setUp

    def host(self):
        from dgc import pip_computer
        self.addCleanup(pip_computer.stop_all)
        pip = self.store.create(self.registry.personal()["id"], "Shopper", "Shop for me", "local-console")
        host = pip_computer.host_for(self.registry.directory, pip["id"], pip["workspace_id"])
        stepped = patch.object(type(host), "_act", lambda self, op, args: {"text": f"{op} by {self.run_id} careful={self.careful}"})
        stepped.start(); self.addCleanup(stepped.stop)
        return host

    def test_a_second_reply_waits_for_the_computer_and_gets_it_when_the_first_ends(self):
        host = self.host()
        a, b = "run_" + "a" * 32, "run_" + "b" * 32
        host.begin(a, self.registry.directory / "fa", careful=False)
        host.begin(b, self.registry.directory / "fb", careful=True)
        self.assertEqual(host.run_id, a, "the first reply keeps it; the second's settings wait")
        self.assertEqual(host.act_for(a, "read", {})["text"], f"read by {a} careful=False")
        done = []
        waiter = threading.Thread(target=lambda: done.append(host.act_for(b, "read", {})))
        waiter.start()
        time.sleep(0.3)
        self.assertEqual(done, [], "B's step waits while A has the computer")
        host.end(a)
        waiter.join(5)
        self.assertEqual(done[0]["text"], f"read by {b} careful=True", "then B has it, with its own settings")
        host.end(b)
        self.assertIsNone(host.run_id)

    def test_a_reply_that_never_got_the_computer_ending_leaves_the_other_alone(self):
        host = self.host()
        a, b = "run_" + "a" * 32, "run_" + "b" * 32
        host.begin(a, self.registry.directory / "fa")
        host.begin(b, self.registry.directory / "fb")
        host.end(b)
        self.assertEqual(host.run_id, a)
        self.assertEqual(host.act_for(a, "read", {})["text"], f"read by {a} careful=False")

    def test_a_long_wait_says_so_plainly(self):
        from dgc import pip_computer
        host = self.host()
        a, b = "run_" + "a" * 32, "run_" + "b" * 32
        host.begin(a, self.registry.directory / "fa")
        host.begin(b, self.registry.directory / "fb")
        with patch.object(pip_computer, "LEASE_WAIT", 0.2):
            said = host.act_for(b, "read", {})["text"]
        self.assertIn("your reply in another conversation is using it", said)
        self.assertEqual(host.run_id, a, "and A still has it")

    def test_a_run_s_socket_steps_as_that_run(self):
        from dgc import pip_computer
        host = self.host()
        a, b = "run_" + "a" * 32, "run_" + "b" * 32
        host.begin(a, self.registry.directory / "fa")
        host.begin(b, self.registry.directory / "fb")
        sock = pip_computer.RunSocket(host, b)
        self.addCleanup(sock.close)
        with patch.object(pip_computer, "LEASE_WAIT", 0.2):
            said = pip_computer.worker_reply(sock.pin(), "read", {}, timeout=10)["text"]
        self.assertIn("another conversation", said, "B's socket never steps as A")


if __name__ == "__main__":
    unittest.main()
