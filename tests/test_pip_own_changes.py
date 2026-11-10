"""A Personal Pip changes its own job at once, with Undo, in a turn the user started (0.52, the user's call D6).

Before, every change a Pip drafted in its chat waited on a review card ("The draft is NOT applied"). Now, in a turn the
user started, its name, instructions, schedule and model change when its reply is saved, and a routine it adds is on;
the chat shows one line per change with Undo. A turn DGC started (a routine, a follow-up after a page or an app) still
only proposes: a routine reading a page can't change its own job. Web reads, a computer, apps and its level still ask.
"""
import json
import os
import unittest
from unittest.mock import patch

from dgc import pips, pip_chat, pip_chat_setup as setup, pip_own_changes as own, pip_routines
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures

DAILY = {"kind": "schedule", "schedule": {"type": "daily", "time": "08:00", "timezone": "Asia/Kolkata"}}


class AtOnceWithUndo(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp

    def job(self):
        return self.store.create(self.registry.personal()["id"], "Planner", "Help plan my day", "user")

    def turn(self, job, key="reply", text="Call yourself Pitch and write one-page sales sheets"):
        dgc_turn = key.startswith(pip_chat.DGC_KEYS)
        run = pip_chat.send(self.store, job["id"], text, key, "local-routine" if dgc_turn else "user", self.cfg,
                            _intro=dgc_turn)["run"]
        self.store.claim_next()
        return run

    def draft(self, **changes):
        return {"changes": changes, "reason": "The user asked for it."}

    def changes_of(self, run):
        return own.for_runs(self.registry.db, [run["id"]]).get(run["id"], [])

    # ------------------------------------------------------------------ which turns

    def test_only_a_turn_you_started_changes_at_once(self):
        job = self.job()
        mine = self.turn(job)
        self.assertTrue(mine["manifest"]["chat_setup"]["direct"], "you typed it")
        self.store.finish(mine["id"], result={"text": "Hello."})
        for key in ("routine_morning", "computer_abc", "apps_abc", "intro_hello"):
            with self.subTest(key=key):
                run = self.turn(job, key=key, text="This message is from DGC, not the user.")
                self.assertFalse(run["manifest"]["chat_setup"]["direct"], "DGC started it")
                self.store.finish(run["id"], result={"text": "Done."})

    def test_an_older_pin_still_reads_as_a_review(self):
        manifest = {"run_kind": "conversation", "source_policy": {"mode": "personal"}, "job_version": 1,
                    "chat_setup": {"schema_version": 1, "job_version": 1, "lifecycle_revision": 0, "allowed": True,
                                   "schedule": None}}
        self.assertFalse(setup.validate_pin(manifest).get("direct", False))

    # ------------------------------------------------------------------ its job

    def test_a_change_in_your_turn_applies_when_its_reply_is_saved(self):
        job = self.job(); run = self.turn(job)
        self.store.finish(run["id"], result={"text": "I'm Pitch now.", "setup_draft": self.draft(
            name="Pitch", goal="Write one-page sales sheets for Acme Notes")})
        saved = self.store.get(job["id"])
        self.assertEqual((saved["name"], saved["goal"]), ("Pitch", "Write one-page sales sheets for Acme Notes"))
        self.assertEqual(saved["current_version"], 2)
        self.assertEqual(saved["proposals"], [], "no review card")
        [change] = self.changes_of(run)
        self.assertEqual((change["kind"], change["fields"], change["status"]), ("job", ["name", "goal"], "applied"))
        self.assertEqual(change["after"]["name"], "Pitch")

    def test_weekdays_weekends_or_named_days_become_its_own_schedule(self):
        # pips-07b (asked 10 Nov): the tool knew only daily, every so often and once, so "every weekday at 9" came out
        # as an extra routine. Now it is the Pip's own schedule, in the cron shape its routines already run on.
        job = self.job()
        for i, cron in enumerate(("0 9 * * 1-5", "0 10 * * 0,6", "0 8 * * 1,4")):
            with self.subTest(cron=cron):
                run = self.turn(job, key=f"reply{i}", text=f"Do your job on {cron}")
                self.store.finish(run["id"], result={"text": "Done.", "setup_draft": self.draft(
                    schedule={"type": "cron", "cron": cron, "timezone": "Asia/Kolkata"})})
                saved = self.store.get(job["id"])
                self.assertEqual((saved["schedule"]["type"], saved["schedule"]["cron"]), ("cron", cron))
                self.assertEqual(saved["proposals"], [], "no review card")
                [change] = self.changes_of(run)
                self.assertEqual(change["fields"], ["schedule"])
        self.assertEqual(self.registry.db.execute("SELECT COUNT(*) FROM pip_routines WHERE pip_id=?",
                                                  (job["id"],)).fetchone()[0], 0, "no routine as well")

    def prompt_of(self, job, text, key):
        """The system prompt of the reply to ``text``, as the worker builds it (no network, no model)."""
        from dgc.llm import LLMClient, ChatResult
        run = pip_chat.send(self.store, job["id"], text, key, "user", self.cfg)["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(messages[0]["content"])
            return ChatResult(content="Done.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        return run, seen[0] if isinstance(seen[0], str) else json.dumps(seen[0])

    def test_the_answers_to_its_setup_questions_set_its_own_schedule_too(self):
        # Live 10 Nov: the /setup words reached only the /setup turn, so the turn with the answers ("every weekday at
        # 9") followed the standing rule for something regular and added a weekday routine instead of its schedule.
        job = self.job()
        first, words = self.prompt_of(job, "/setup Send me a short morning news brief", "reply-setup")
        self.assertIn("three short numbered questions", words)
        self.store.claim_next()
        self.store.finish(first["id"], result={"text": "Three quick questions: 1. What for? 2. How long? 3. When?"})
        answers, words = self.prompt_of(job, "1. To start my day. 2. Five bullets. 3. Every weekday at 9:00.", "reply-answers")
        self.assertIn(own.SETUP_ANSWER, words)
        self.assertIn("weekends", words)
        self.store.claim_next()
        self.store.finish(answers["id"], result={"text": "Set."})
        _, words = self.prompt_of(job, "Thanks! What's the weather like?", "reply-later")
        self.assertNotIn(own.SETUP_ANSWER, words, "only the turn right after /setup")
        self.assertNotIn("three short numbered questions", words)

    def test_undo_puts_every_changed_field_back(self):
        job = self.job(); run = self.turn(job)
        schedule = {"type": "daily", "time": "09:00", "timezone": "Asia/Kolkata"}
        self.store.finish(run["id"], result={"text": "Done.", "setup_draft": self.draft(
            name="Pitch", goal="Sales sheets", schedule=schedule, model_choice={"mode": "model", "model": "other-model"})})
        changed = self.store.get(job["id"])
        self.assertEqual(changed["schedule"]["time"], "09:00")
        [change] = self.changes_of(run)
        undone = own.undo(self.store, job["id"], change["id"], "editor-user")
        self.assertEqual(undone["status"], "undone")
        back = self.store.get(job["id"])
        self.assertEqual((back["name"], back["goal"], back["schedule"], back["model_choice"]),
                         ("Planner", "Help plan my day", None, {"mode": "default"}))
        self.assertEqual(back["current_version"], 3, "Undo is a new version: the history keeps both")
        with self.assertRaises(RegistryError):
            own.undo(self.store, job["id"], change["id"], "editor-user")

    def test_undo_after_a_later_change_is_refused_and_changes_nothing(self):
        job = self.job(); run = self.turn(job)
        self.store.finish(run["id"], result={"text": "Done.", "setup_draft": self.draft(name="Pitch")})
        [change] = self.changes_of(run)
        later = self.store.propose(job["id"], 2, {"goal": "Something else"}, "user")
        self.store.accept(job["id"], later["id"], 2, "user")
        with self.assertRaises(RegistryError) as raised:
            own.undo(self.store, job["id"], change["id"], "editor-user")
        self.assertEqual(raised.exception.code, "conflict")
        self.assertIn("changed since", str(raised.exception))
        after = self.store.get(job["id"])
        self.assertEqual((after["name"], after["goal"], after["current_version"]), ("Pitch", "Something else", 3))

    def test_a_turn_dgc_started_cannot_change_its_own_job(self):
        """A routine reading a page, or a follow-up after the Pip's computer read one: a review, never at once."""
        job = self.job()
        for key in ("routine_daily", "computer_after"):
            with self.subTest(key=key):
                run = self.turn(job, key=key, text="This message is from DGC, not the user.")
                self.store.finish(run["id"], result={"text": "Done.", "setup_draft": self.draft(name="Hijacked")})
                saved = self.store.get(job["id"])
                self.assertEqual((saved["name"], saved["current_version"]), ("Planner", 1))
                self.assertEqual(self.changes_of(run), [])
                self.assertTrue(saved["proposals"], "it still waits for you, as before")
                self.store.reject(job["id"], saved["proposals"][0]["id"], 1, "user")

    def test_web_reads_and_a_computer_still_ask(self):
        job = self.job(); run = self.turn(job)
        self.store.finish(run["id"], result={"text": "Done.", "setup_draft": self.draft(
            name="Pitch", computer_plan={"schema_version": 1})})
        saved = self.store.get(job["id"])
        self.assertEqual((saved["name"], saved["current_version"]), ("Pitch", 2), "its name at once")
        self.assertIsNone(saved.get("computer_plan"))
        [waiting] = saved["proposals"]
        self.assertEqual(waiting["expected_version"], 2, "its computer waits for you, on the version it now has")
        [change] = self.changes_of(run)
        self.assertEqual(change["fields"], ["name"])

    def test_a_review_waiting_for_you_carries_over_a_later_change(self):
        """Live, 10 Nov: the Pip asked for its computer (a review card), then changed its instructions at once in the next
        turn, and the card was gone (an accepted change supersedes reviews written against the older version) while the
        Pip said it was still waiting. It now waits on the new version, with the same request."""
        job = self.job(); run = self.turn(job)
        self.store.finish(run["id"], result={"text": "I'm Pitch; my computer waits for you.", "setup_draft": self.draft(
            name="Pitch", computer_plan={"schema_version": 1})})
        [waiting] = self.store.get(job["id"])["proposals"]
        self.assertEqual(waiting["expected_version"], 2)
        run = self.turn(job, key="later", text="Also use Acme blue in the headings")
        self.store.finish(run["id"], result={"text": "Added.", "setup_draft": self.draft(goal="Sales sheets in Acme blue")})
        saved = self.store.get(job["id"])
        self.assertEqual((saved["current_version"], saved["goal"]), (3, "Sales sheets in Acme blue"))
        [carried] = saved["proposals"]
        self.assertEqual(carried["expected_version"], 3, "it waits on the version the Pip has now")
        self.store.accept(job["id"], carried["id"], 3, "user")
        accepted = self.store.get(job["id"])
        self.assertEqual(accepted["computer_plan"], {"schema_version": 1})
        self.assertEqual((accepted["name"], accepted["goal"]), ("Pitch", "Sales sheets in Acme blue"),
                         "accepting it keeps the later change")

    def test_asking_for_what_it_already_has_makes_no_review_card(self):
        """Live, 10 Nov: a Pip that already had its computer asked for it again; the card waited for a change that changed
        nothing, and the Pip told the user to review it."""
        job = self.job()
        given = self.store.propose(job["id"], 1, {"computer_plan": {"schema_version": 1}}, "user")
        self.store.accept(job["id"], given["id"], 1, "user")
        run = self.turn(job)
        self.store.finish(run["id"], result={"text": "I'm Pitch.", "setup_draft": self.draft(
            name="Pitch", computer_plan={"schema_version": 1})})
        saved = self.store.get(job["id"])
        self.assertEqual((saved["name"], saved["proposals"]), ("Pitch", []))

    def test_a_stale_or_paused_reply_changes_nothing(self):
        job = self.job(); run = self.turn(job)
        human = self.store.propose(job["id"], 1, {"goal": "New goal"}, "user")
        self.store.accept(job["id"], human["id"], 1, "user")
        done = self.store.finish(run["id"], result={"text": "Done.", "setup_draft": self.draft(name="Pitch")})
        self.assertEqual(self.store.get(job["id"])["name"], "Planner")
        self.assertIn("job changed while I was replying", done["result"]["text"])
        self.assertEqual(self.changes_of(run), [])

    def test_an_email_drafted_in_the_same_reply_is_kept(self):
        """The draft's own check compared the job's version with the one pinned for the turn: renaming itself in the
        same reply made the email look stale, and it was dropped without a word."""
        job = self.job(); run = self.turn(job, text="Call yourself Pitch and draft Sam a note")
        self.store.finish(run["id"], result={"text": "I'm Pitch; the note is below.", "setup_draft": self.draft(name="Pitch"),
                                             "message_draft": {"recipient_email": "sam@example.invalid", "subject": "Plan",
                                                               "body": "Walk for 30 minutes."}})
        self.assertEqual(self.store.get(job["id"])["name"], "Pitch")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_message_drafts").fetchone()[0], 1)
        self.assertEqual(self.registry.db.execute(
            "SELECT count(*) FROM workspace_events WHERE event_type='pip_message_draft_stale'").fetchone()[0], 0)

    # ------------------------------------------------------------------ routines

    def test_a_routine_it_adds_in_your_turn_is_on_at_once_and_undo_removes_it(self):
        job = self.job(); run = self.turn(job, text="Brief me every morning")
        self.store.finish(run["id"], result={"text": "Added.", "routine_drafts": [
            {"title": "Morning brief", "prompt": "Tell me the news.", "trigger": DAILY}]})
        [routine] = pip_routines.listing(self.store, job["id"])["routines"]
        self.assertEqual(routine["status"], "on")
        [change] = self.changes_of(run)
        self.assertEqual((change["kind"], change["after"]["title"]), ("routine", "Morning brief"))
        own.undo(self.store, job["id"], change["id"], "editor-user")
        self.assertEqual(pip_routines.listing(self.store, job["id"])["routines"], [])

    def test_the_same_routine_added_again_is_not_a_second_one(self):
        """Live, 10 Nov: asked for one more change, the model added its weekday routine again. A card could be put away;
        on at once, a second copy would run twice."""
        job = self.job()
        for key in ("one", "two"):
            run = self.turn(job, key=key, text="Brief me every morning")
            self.store.finish(run["id"], result={"text": "On.", "routine_drafts": [
                {"title": "Morning brief", "prompt": "Tell me the news.", "trigger": DAILY}]})
        self.assertEqual(len(pip_routines.listing(self.store, job["id"])["routines"]), 1)
        self.assertEqual(len(self.changes_of(run)), 0, "nothing changed the second time, so no line to undo")
        run = self.turn(job, key="three", text="And one in the evening")
        evening = {"kind": "schedule", "schedule": {"type": "daily", "time": "19:00", "timezone": "Asia/Kolkata"}}
        self.store.finish(run["id"], result={"text": "On.", "routine_drafts": [
            {"title": "Morning brief", "prompt": "Tell me the news.", "trigger": evening}]})
        self.assertEqual(len(pip_routines.listing(self.store, job["id"])["routines"]), 2, "another time is another routine")

    def test_a_routine_turn_still_only_suggests_a_routine(self):
        job = self.job(); run = self.turn(job, key="routine_due", text="This message is from DGC, not the user.")
        self.store.finish(run["id"], result={"text": "Suggested.", "routine_drafts": [
            {"title": "Another", "prompt": "Do more.", "trigger": DAILY}]})
        [routine] = pip_routines.listing(self.store, job["id"])["routines"]
        self.assertEqual(routine["status"], "suggested")
        self.assertEqual(self.changes_of(run), [])

    # ------------------------------------------------------------------ the chat and the command

    def test_the_chat_shows_each_change_after_the_reply_that_made_it(self):
        job = self.job(); run = self.turn(job)
        self.store.finish(run["id"], result={"text": "I'm Pitch now.", "setup_draft": self.draft(name="Pitch"),
                                             "routine_drafts": [{"title": "Morning brief", "prompt": "News.", "trigger": DAILY}]})
        messages = pip_chat.list_messages(self.store, job["id"])["messages"]
        reply = [m for m in messages if m["role"] == "assistant"][-1]
        self.assertEqual([c["kind"] for c in reply["changes"]], ["job", "routine"])
        self.assertEqual([c["after"]["by"] for c in reply["changes"]], ["Pitch", "Pitch"],
                         "who made it, then: a later rename doesn't change what an older line says")
        self.assertTrue(all(c["status"] == "applied" for c in reply["changes"]))
        self.assertNotIn("changes", [m for m in messages if m["role"] == "user"][-1])

    def test_only_you_undo_on_this_computer(self):
        job = self.job(); run = self.turn(job)
        self.store.finish(run["id"], result={"text": "Done.", "setup_draft": self.draft(name="Pitch")})
        [change] = self.changes_of(run)
        from dgc.workspace_registry import WorkspaceRegistry
        here = patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory))
        here.start(); self.addCleanup(here.stop)
        refused = pips.handle_control(self.cfg, {"type": "undo_pip_change", "request_id": "u1", "pip_id": job["id"],
                                                 "change_id": change["id"]}, "main-chat")
        self.assertFalse(refused["ok"])
        self.assertEqual(refused["error"]["code"], "local_only")
        done = pips.handle_control(self.cfg, {"type": "undo_pip_change", "request_id": "u2", "pip_id": job["id"],
                                              "change_id": change["id"]}, "editor-user")
        self.assertTrue(done["ok"], done)
        self.assertEqual(done["result"]["change"]["status"], "undone")
        self.assertEqual(self.store.get(job["id"])["name"], "Planner")

    def test_the_model_is_told_what_happens_in_each_kind_of_turn(self):
        self.assertIn("Undo", setup.notice(direct=True))
        self.assertIn("at once", setup.notice(direct=True))
        self.assertIn("NOT applied", setup.notice(direct=False))
        self.assertIn("Undo", pip_routines.schema(direct=True)["function"]["description"])
        self.assertIn("Add routine", pip_routines.schema()["function"]["description"])


class SetupCommand(unittest.TestCase):
    def test_slash_setup_asks_a_few_questions_then_sets_the_job(self):
        words = own.setup_instructions("/setup Write one-page sales sheets for Acme Notes")
        self.assertIn("Write one-page sales sheets for Acme Notes", words)
        self.assertIn("three", words)
        self.assertIn("draft_pip_change", words)
        self.assertIn("what job", own.setup_instructions("/setup").lower())
        for text in ("hello /setup", "/setupx", "/settings", ""):
            with self.subTest(text=text):
                self.assertIsNone(own.setup_instructions(text))


    def test_setup_and_its_tool_know_any_days(self):
        described = setup.schema()["function"]["description"]
        self.assertIn('type:"cron"', described)
        for days in ("1-5", "0,6", "1,4"):
            self.assertIn(days, described)
        words = own.setup_instructions("/setup Send me a morning news brief")
        for want in ("weekdays", "weekends", "schedule", "not a routine for the same"):
            self.assertIn(want, words)
        after = [{"role": "user", "content": "/setup Send me a morning news brief"}, {"role": "assistant", "content": "Three questions…"}]
        self.assertEqual(own.setup_instructions("3. Every weekday at 9", after), own.SETUP_ANSWER)
        self.assertIn("not a routine for the same", own.SETUP_ANSWER)
        self.assertIsNone(own.setup_instructions("Thanks", after[:0]))
        self.assertIsNone(own.setup_instructions("Thanks", [{"role": "user", "content": "hello /setup"}, after[1]]))

if __name__ == "__main__":
    unittest.main()
