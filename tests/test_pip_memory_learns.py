"""Memory that learns, for Pips: each Personal Pip's own working notes (pip_working_notes), loaded into every run of
it and edited on its page; a daily log of what it did (pip_daily_log), for the user only; and its chat looked back
over for the user's one memory (pip_memory_review), by the rules every memory keeps."""
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from dgc import memory_review, pip_chat, pip_daily_log, pip_memory_review, pip_notes, pip_working_notes, pips
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class Base(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)
        from dgc import shared_memory
        folder = tempfile.TemporaryDirectory(prefix="dgc-pip-learns-")
        self.addCleanup(folder.cleanup)
        self.memory_root = Path(folder.name) / "memory"
        patcher = patch.object(shared_memory, "default_root", lambda: self.memory_root)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.memory_on = True
        on = patch.object(pip_notes, "_shared_memory_on", lambda config=None: self.memory_on)
        on.start()
        self.addCleanup(on.stop)

    def make(self, name="Ava"):
        return self.store.create(self.registry.personal()["id"], name, "Pay my hospital bills", "editor-user",
                                 pip_type="rook")

    def control(self, command, actor="editor-user", **fields):
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor,
                                           start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def manifest(self, run):
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        raw = pip_notes.runtime(self.registry, run, raw)
        return pip_working_notes.runtime(self.registry, run, raw)

    def execute(self, raw, turns, seen):
        def chat(client, messages, tools=None, **kwargs):
            seen.append(([t["function"]["name"] for t in (tools or [])], json.dumps(messages)))
            return next(turns)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
             patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
             patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")), \
             patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
            return pips.execute_native(self.cfg, self.root, raw, lambda e: None)


class WorkingNotesTests(Base):
    def test_day_one_writes_a_note_and_day_two_starts_with_it(self):
        pip = self.make()
        # Day 1: the Pip learns how the portal works and keeps it.
        run = pip_chat.send(self.store, pip["id"], "Pay the hospital bill on the portal", "d1", "editor-user", self.cfg)["run"]
        raw = self.manifest(run)
        self.assertEqual(raw["working_notes"], [], "every run gets its notes, none yet")
        seen = []
        turns = iter([ChatResult(content="", tool_calls=[
            ToolCall("n1", "working_notes", {"op": "add", "line": "The hospital portal asks for the UHID first"}),
            ToolCall("n2", "working_notes", {"op": "add", "line": "Bills go to Arjun Mehta"}),
            ToolCall("n3", "working_notes", {"op": "add", "line": "Portal password is hunter2hunter2"})]),
            ChatResult(content="Paid. The portal wanted the UHID first.")])
        result = self.execute(raw, turns, seen)
        self.assertIn("working_notes", seen[0][0], "offered the tool")
        self.assertIn("working_notes: Your own working notes", seen[0][1])
        self.assertEqual([op["line"] for op in result["working_notes"]],
                         ["The hospital portal asks for the UHID first", "Bills go to Arjun Mehta"],
                         "a password is refused as it writes it")
        self.assertIn("never holds a password", json.dumps(seen[-1][1]))
        self.store.claim_next()
        self.store.finish(run["id"], result=result)
        self.assertEqual(pip_working_notes.read(self.registry.directory, pip["id"]),
                         ["The hospital portal asks for the UHID first", "Bills go to Arjun Mehta"])
        stored = json.loads(self.registry.db.execute("SELECT result FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        self.assertNotIn("working_notes", stored, "the notes live in their file, not in the run")
        # Day 2: a routine's run of the same Pip starts with them, and changes one.
        task = self.store.enqueue(pip["id"], "task", "editor-user", self.cfg)
        raw = pip_working_notes.runtime(self.registry, task, task["manifest"])
        seen = []
        turns = iter([ChatResult(content="", tool_calls=[
            ToolCall("n1", "working_notes", {"op": "replace", "match": "Arjun", "line": "Bills go to Arjun Mehta (accounts)"}),
            ToolCall("n2", "working_notes", {"op": "strike", "match": "nothing like this"})]),
            ChatResult(content="Entered the UHID first, then paid.")])
        result = self.execute(raw, turns, seen)
        self.assertIn("The hospital portal asks for the UHID first", seen[0][1], "day 2 starts with day 1's note")
        self.assertIn("working_notes", seen[0][0])
        self.assertIn("No line of your notes has those words", seen[-1][1])
        self.assertEqual(len(result["working_notes"]), 1)
        self.store.claim_next()
        self.store.finish(task["id"], result=result)
        self.assertEqual(pip_working_notes.read(self.registry.directory, pip["id"])[1], "Bills go to Arjun Mehta (accounts)")

    def test_the_supervisor_checks_again_what_the_worker_says_it_wrote(self):
        pip = self.make()
        from dgc import pip_careful
        taint = pip_careful.taint_for(self.registry.directory, pip["id"])
        taint.add("Your appointment with Dr Rao is moved to Thursday at the Andheri clinic, room four")
        run = pip_chat.send(self.store, pip["id"], "What did the clinic email say?", "m1", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "It moved.", "working_notes": [
            {"op": "add", "line": "Dr Rao is moved to Thursday at the Andheri clinic, room four"},
            {"op": "add", "line": "Card 4111 1111 1111 1111 pays the bills"},
            {"op": "add", "line": "The clinic emails from the appointments desk"}]})
        self.assertEqual(pip_working_notes.read(self.registry.directory, pip["id"]),
                         ["The clinic emails from the appointments desk"],
                         "never what an email said, never a card number: only how the job goes")

    def test_the_budget_holds(self):
        lines = [f"Step {n} of the job goes like this" for n in range(pip_working_notes.MAX_LINES)]
        with self.assertRaisesRegex(RegistryError, "full"):
            pip_working_notes.apply(lines, {"op": "add", "line": "One more step"})
        with self.assertRaisesRegex(RegistryError, "full"):
            pip_working_notes.apply(["x" * 290] * 20, {"op": "add", "line": "y" * 290})
        with self.assertRaisesRegex(RegistryError, "More than one line"):
            pip_working_notes.apply(["Bills go to A", "Bills go to B"], {"op": "strike", "match": "bills"})

    def test_seen_and_edited_on_its_page_never_with_a_secret(self):
        pip = self.make()
        view = self.control("get_pip_working_notes", pip_id=pip["id"])
        self.assertEqual((view["lines"], view["max_lines"], view["max_bytes"]), ([], 60, 6000))
        view = self.control("set_pip_working_notes", pip_id=pip["id"], text="- Portal wants the UHID first\n\nBills: Arjun",
                            expected_revision=view["revision"])
        self.assertEqual(view["lines"], ["Portal wants the UHID first", "Bills: Arjun"])
        with self.assertRaisesRegex(RegistryError, "changed its notes"):
            self.control("set_pip_working_notes", pip_id=pip["id"], text="Anything", expected_revision="0" * 16)
        with self.assertRaisesRegex(RegistryError, "password"):
            self.control("set_pip_working_notes", pip_id=pip["id"], text="api key sk-ant-api03-" + "A" * 60,
                         expected_revision=view["revision"])
        with self.assertRaises(RegistryError) as raised:
            self.control("get_pip_working_notes", "remote-device", pip_id=pip["id"])
        self.assertEqual(raised.exception.code, "local_only")
        path = self.registry.directory / "working-notes" / f"{pip['id']}.md"
        self.assertEqual(oct(path.stat().st_mode & 0o777), "0o600")
        project = self.store.create(self.workspace["id"], "Project", "Review", "editor-user")
        with self.assertRaises(RegistryError):
            self.control("get_pip_working_notes", pip_id=project["id"])


class DailyLogTests(Base):
    def test_each_run_is_a_line_on_its_day_and_no_run_is_ever_given_the_log(self):
        pip = self.make()
        run = pip_chat.send(self.store, pip["id"], "Pay the electricity bill", "m1", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Paid ₹1,240 to the electricity board. Receipt saved."})
        task = self.store.enqueue(pip["id"], "task", "editor-user", self.cfg)
        self.store.claim_next()
        self.store.finish(task["id"], error={"code": "run_failed", "message": "The portal was down."})
        log = self.control("list_pip_daily_log", pip_id=pip["id"])
        self.assertEqual(len(log["days"]), 1)
        lines = log["days"][0]["lines"]
        self.assertEqual(len(lines), 2)
        self.assertIn("Chat: you asked “Pay the electricity bill” · “Paid ₹1,240 to the electricity board.", lines[0])
        self.assertTrue(lines[1].endswith("Task · Failed: The portal was down."), lines[1])
        later = pip_chat.send(self.store, pip["id"], "Anything due?", "m2", "editor-user", self.cfg)["run"]
        raw = self.manifest(later)
        self.assertNotIn("you asked", json.dumps(raw), "the log is the user's to read: no run is handed it")
        self.assertNotIn("Failed: The portal", json.dumps(raw))

    def test_a_day_is_bounded_and_old_days_go(self):
        from datetime import datetime, timedelta
        pip = self.make()
        now = datetime(2026, 10, 21, 9, 0).astimezone()
        for n in range(pip_daily_log.MAX_DAY_LINES + 4):
            pip_daily_log.record(self.registry.directory, pip["id"], f"- 09:{n:02d} · Task · Done", now=now)
        day = pip_daily_log.days(self.registry.directory, pip["id"])["days"][0]
        self.assertEqual((len(day["lines"]), day["more"]), (pip_daily_log.MAX_DAY_LINES, 4))
        pip_daily_log.record(self.registry.directory, pip["id"], "- 09:00 · Task · Done",
                             now=now + timedelta(days=pip_daily_log.KEEP_DAYS + 1))
        self.assertEqual([d["day"] for d in pip_daily_log.days(self.registry.directory, pip["id"])["days"]],
                         [(now + timedelta(days=pip_daily_log.KEEP_DAYS + 1)).date().isoformat()])


class PipReviewTests(Base):
    def reply(self, pip, text, key, answer="Noted.", actor="editor-user"):
        run = pip_chat.send(self.store, pip["id"], text, key, actor, self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(run["id"], result={"text": answer})
        return run

    def model(self, items, seen):
        def chat(messages, tools=None, **kwargs):
            seen.append(messages[-1]["content"])
            return SimpleNamespace(content="", tool_calls=[ToolCall("r", "remember", {"items": items})],
                                   finish_reason="stop", thinking="", usage={})
        return SimpleNamespace(chat=chat, model="fixture")

    def test_the_users_words_to_a_pip_are_looked_back_over_and_shown_under_its_reply(self):
        from dgc.shared_memory import SharedMemory
        pip = self.make()
        self.reply(pip, "I always pay hospital bills by UPI, never by card.", "m1")
        hello = pip_chat.introduce(self.store, pip["id"], "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(hello["id"], result={"text": "Hi! I keep your bills paid."})
        last = self.reply(pip, "Arjun Mehta at accounts gets every receipt.", "m2")
        seen = []
        items = [{"fact": "Pays hospital bills by UPI", "kind": "preference", "from": "told"},
                 {"fact": "Arjun Mehta at accounts gets every receipt", "kind": "fact", "from": "told"},
                 {"fact": "Keeps the bills paid", "kind": "fact", "from": "assistant"}]
        saved = pip_memory_review.review(self.registry.directory, self.cfg, pip["id"], client=self.model(items, seen))
        self.assertEqual([f["text"] for f in saved], ["Pays hospital bills by UPI", "Arjun Mehta at accounts gets every receipt"])
        self.assertNotIn("User: Hi", seen[0], "DGC's hello is never the user's words")
        fact = SharedMemory().facts()[0]
        self.assertEqual((fact["source"]["pip"], fact["source"]["run"], fact["source"]["by"]), (pip["id"], last["id"], "review"))
        shown = pip_notes.listing(self.registry, pip["id"], shared=True)["notes"]
        self.assertEqual({n["run_id"] for n in shown}, {last["id"]}, "under its latest reply: Remembered, with Forget")
        self.assertEqual(pip_memory_review.review(self.registry.directory, self.cfg, pip["id"],
                                                  client=self.model(items, seen)), [], "looked back over once")
        self.assertEqual(len(seen), 1)

    def test_memory_off_means_no_look_back_and_never_later(self):
        pip = self.make()
        self.memory_on = False
        self.reply(pip, "I always pay hospital bills by UPI, never by card.", "m1")
        seen = []
        model = self.model([{"fact": "Pays hospital bills by UPI", "kind": "preference", "from": "told"}], seen)
        self.assertEqual(pip_memory_review.pending(self.registry.directory, self.cfg, pip["id"]), 0)
        self.assertEqual(pip_memory_review.review(self.registry.directory, self.cfg, pip["id"], client=model), [])
        self.memory_on = True
        self.assertEqual(pip_memory_review.pending(self.registry.directory, self.cfg, pip["id"]), 0,
                         "what was said while it was off is never looked back over")
        self.assertEqual(seen, [])

    def test_a_reply_to_the_users_turn_starts_the_wait_and_dgcs_own_turn_doesnt(self):
        pip = self.make()
        started = []
        with patch.object(pip_memory_review, "_reviews",
                          lambda directory, config: SimpleNamespace(ended=lambda key: started.append(key))):
            run = self.reply(pip, "I always pay hospital bills by UPI, never by card.", "m1")
            pip_memory_review.after_run(self.registry, self.cfg, run["id"])
            hello = pip_chat.introduce(self.store, pip["id"], "editor-user", self.cfg)["run"]
            self.store.claim_next()
            self.store.finish(hello["id"], result={"text": "Hi! I always pay hospital bills by UPI for you."})
            pip_memory_review.after_run(self.registry, self.cfg, hello["id"])
        self.assertEqual(started, [pip["id"]])


if __name__ == "__main__":
    unittest.main()
