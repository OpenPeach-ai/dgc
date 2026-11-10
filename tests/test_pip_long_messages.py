"""Messages and replies up to 256 KB (Limits for everyone, agreed 10 Nov).

You can send a Pip up to 256 KB in one message (it was 4,000 characters), while it replies too, and it can answer with
up to 256 KB (it was 24 KB, and a longer answer failed the whole turn). A longer answer is kept whole as the Pip's
document: the chat shows its start, then "The rest is in its document.", with the document's card.
"""
from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dgc import pip_chat
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures
from tests import test_pip_conversations as conv

KB = 1024
LONG = ("A long note about the plan, with every detail kept. " * 4200)[:200 * KB]     # 200 KB, one paragraph


def _paragraphs(total):
    out, n = [], 0
    while sum(len(p) + 2 for p in out) < total:
        out.append(f"Part {n}. " + "Every line of this answer matters to the reader. " * 40)
        n += 1
    return "\n\n".join(out)


class LongMessages(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    control = conv.UnreadAndApi.control

    def test_a_200_kb_message_goes_through_and_reaches_the_worker_whole(self):
        from dgc import pip_run_inputs
        job = conv.Conversations.job(self)
        sent = self.control("send_pip_message", pip_id=job["id"], text=LONG, idempotency_key="k-long")
        run_id = sent["run"]["id"]
        stored = self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()[0]
        self.assertLess(len(stored.encode()), 128 * KB, "the stored manifest stays small: the long text is kept beside the run")
        manifest = pip_run_inputs.attach(self.registry.db, run_id, json.loads(stored))
        self.assertEqual(manifest["conversation"]["text"], LONG, "the worker gets every word")
        listed = self.control("list_pip_messages", pip_id=job["id"])["messages"]
        self.assertEqual([m["text"] for m in listed if m["role"] == "user"], [LONG])

    def test_a_message_past_256_kb_is_refused_plainly(self):
        job = conv.Conversations.job(self)
        with self.assertRaises(RegistryError) as caught:
            self.control("send_pip_message", pip_id=job["id"], text="x" * (256 * KB + 1), idempotency_key="k-big")
        self.assertIn("256 KB", str(caught.exception))

    def test_a_200_kb_reply_is_kept_and_listed(self):
        job = conv.Conversations.job(self)
        sent = pip_chat.send(self.store, job["id"], "Write it all out", "k1", "user", self.cfg)
        self.assertEqual(self.store.claim_next()["id"], sent["run"]["id"])
        reply = _paragraphs(200 * KB)
        final = self.store.finish(sent["run"]["id"], result={"text": reply})
        self.assertEqual(final["status"], "succeeded", final.get("error"))
        listed = self.control("list_pip_messages", pip_id=job["id"])["messages"]
        self.assertEqual(listed[-1]["text"], reply)

    def test_a_page_always_has_the_newest_message_however_long(self):
        job = conv.Conversations.job(self)
        for n in range(3):
            sent = pip_chat.send(self.store, job["id"], f"Part {n}", f"k{n}", "user", self.cfg)
            self.store.claim_next()
            self.store.finish(sent["run"]["id"], result={"text": f"{n} " + _paragraphs(100 * KB)})
        with patch.object(pip_chat, "LIST_PAGE_BYTES", 1000):
            page = pip_chat.list_messages(self.store, job["id"])
        self.assertEqual(len(page["messages"]), 1, "one message past the page's size still comes")
        self.assertTrue(page["messages"][0]["text"].startswith("2 "))
        self.assertIsNotNone(page["next_before_id"], "and the rest page in")

    def test_a_long_message_while_it_replies_joins_that_reply(self):
        from dgc import pip_steering
        job = conv.Conversations.job(self)
        sent = pip_chat.send(self.store, job["id"], "Start the plan", "k1", "user", self.cfg)
        self.store.claim_next()
        middle = LONG[:20 * KB]
        steer = pip_chat.send(self.store, job["id"], middle, "k2", "user", self.cfg)
        self.assertEqual(steer["run"]["id"], sent["run"]["id"], "it joins the reply that is running")
        folder = Path(tempfile.mkdtemp())
        pip_steering.stage(self.registry.db, sent["run"]["id"], folder)
        self.assertEqual([item["text"] for item in pip_steering.read_worker(folder, set())], [middle])


class LongReplies(unittest.TestCase):
    """A reply past 256 KB, from the real worker: its start in the chat, all of it in the Pip's document."""
    setUp = fixtures.LocalPipsTests.setUp

    def run_worker(self, row, reply):
        from dgc import pips
        fixture = f'''from unittest.mock import patch
from dgc.llm import ChatResult, LLMClient
from dgc.pips import _worker_main
REPLY = open({str(self.reply_file)!r}, encoding="utf-8").read()
def chat(self, messages, tools=None, on_text=None, **kwargs):
    return ChatResult(content=REPLY)
with patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''
        self.reply_file.write_text(reply, encoding="utf-8")
        original = subprocess.Popen

        def launch(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return original(argv, *args, **kwargs)
        with patch.object(pips.subprocess, "Popen", side_effect=launch):
            return pips._execute_run(self.registry, row, self.cfg)

    def test_a_reply_past_256_kb_keeps_the_rest_in_its_document(self):
        from dgc.artifact_store import store as artifacts
        self.reply_file = Path(tempfile.mkdtemp()) / "reply.md"
        job = conv.Conversations.job(self)
        sent = pip_chat.send(self.store, job["id"], "Write the whole manual", "k1", "user", self.cfg)
        row = self.store.claim_next()
        reply = _paragraphs(300 * KB)
        result = self.run_worker(row, reply)
        final = self.store.finish(sent["run"]["id"], result=result)
        self.assertEqual(final["status"], "succeeded", final.get("error"))
        said = pip_chat.list_messages(self.store, job["id"])["messages"][-1]
        self.assertTrue(said["text"].endswith("The rest is in its document."), said["text"][-200:])
        self.assertLessEqual(len(said["text"].encode()), 256 * KB)
        start = said["text"][: -len("The rest is in its document.")].rstrip()
        self.assertTrue(reply.startswith(start), "the chat keeps the start, cut at a paragraph")
        self.assertTrue(start.endswith(".") and len(start) > 200 * KB)
        self.assertEqual(said["artifact"]["type"], "doc", "with the document's card")
        kept = artifacts().get(said["artifact"]["id"])
        self.assertEqual(kept.legacy.get("pip"), job["id"])
        from dgc import artifact_service
        self.assertEqual(artifact_service._doc_snapshot(kept)[0].decode("utf-8").strip(), reply.strip(), "the document holds all of it")

    def test_a_reply_within_256_kb_is_the_whole_reply(self):
        self.reply_file = Path(tempfile.mkdtemp()) / "reply.md"
        job = conv.Conversations.job(self)
        sent = pip_chat.send(self.store, job["id"], "Write a long answer", "k1", "user", self.cfg)
        row = self.store.claim_next()
        reply = _paragraphs(120 * KB)
        final = self.store.finish(sent["run"]["id"], result=self.run_worker(row, reply))
        self.assertEqual(final["status"], "succeeded", final.get("error"))
        said = pip_chat.list_messages(self.store, job["id"])["messages"][-1]
        self.assertEqual(said["text"], reply.strip(), "the whole reply (a reply's ends are trimmed, as always)")
        self.assertNotIn("artifact", said)


class SteersTableWidens(unittest.TestCase):
    """The one migration: a message that joins a running reply is stored with the same 256 KB bound. The table is
    rebuilt with every row, its conversation and its order kept."""
    setUp = fixtures.LocalPipsTests.setUp

    def test_an_older_registry_keeps_every_steer_and_takes_long_ones(self):
        from dgc import pip_steering
        from dgc.workspace_registry import WorkspaceRegistry
        job = conv.Conversations.job(self)
        sent = pip_chat.send(self.store, job["id"], "Start", "k1", "user", self.cfg)
        self.store.claim_next()
        kept = pip_chat.send(self.store, job["id"], "And one more thing", "k2", "user", self.cfg)
        db = self.registry.db
        before = [tuple(r) for r in db.execute("SELECT * FROM pip_chat_steers ORDER BY seq").fetchall()]
        self.assertEqual(len(before), 1)
        columns = [r[1] for r in db.execute("PRAGMA table_info(pip_chat_steers)").fetchall()]
        # Put the table back as a registry at schema 54 had it: the 8 KiB CHECK.
        with self.registry.transaction():
            db.execute("ALTER TABLE pip_chat_steers RENAME TO steers_now")
            db.execute(pip_steering.SCHEMA.split(";")[0].replace(f"<={pip_steering.MAX_TEXT_BYTES}", "<=8192"))
            db.execute("ALTER TABLE pip_chat_steers ADD COLUMN conversation_id TEXT")
            db.execute(f"INSERT INTO pip_chat_steers({','.join(columns)}) SELECT {','.join(columns)} FROM steers_now")
            db.execute("DROP TABLE steers_now")
            db.execute("CREATE INDEX pip_chat_steers_run ON pip_chat_steers(run_id,seq)")
            db.execute("CREATE INDEX pip_chat_steers_conversation ON pip_chat_steers(conversation_id)")
            db.execute("PRAGMA user_version=54")
        self.assertIn("<=8192", db.execute("SELECT sql FROM sqlite_master WHERE name='pip_chat_steers'").fetchone()[0])
        clock = self.registry.clock
        self.registry.close()
        self.registry = WorkspaceRegistry(self.registry.directory, clock=clock)
        db = self.registry.db
        self.assertEqual([tuple(r) for r in db.execute("SELECT * FROM pip_chat_steers ORDER BY seq").fetchall()], before)
        indexes = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pip_chat_steers'")}
        self.assertTrue({"pip_chat_steers_run", "pip_chat_steers_conversation"} <= indexes, indexes)
        self.assertEqual(db.execute("PRAGMA foreign_key_check(pip_chat_steers)").fetchall(), [])
        with self.registry.transaction():
            db.execute("INSERT INTO pip_chat_steers(id,pip_id,workspace_id,run_id,text,request_key,request_digest,requested_by,"
                       "created_at,status,conversation_id) SELECT 'message_' || lower(hex(randomblob(16))),pip_id,workspace_id,"
                       "run_id,?,'k3',request_digest,requested_by,created_at,'pending',conversation_id FROM pip_chat_steers "
                       "WHERE id=?", ("y" * (200 * KB), kept["message"]["id"]))
        self.assertGreater(db.execute("SELECT max(seq) FROM pip_chat_steers").fetchone()[0], before[0][0], "its order carries on")
        self.assertIsNotNone(sent)


if __name__ == "__main__":
    unittest.main()
