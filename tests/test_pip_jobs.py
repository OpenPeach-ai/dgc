"""@ a Pip hands it a job, from Work, ChatDGC and a Pip's chat (0.52).

"@Scout check this session and design its front end": Scout takes the job in its own chat (linked back to where it was
asked), works on a copy of that session's folder in its computer at its own level, and the answer comes back to the
asking chat as a card (its answer, and its change with Apply) and to the Pip's chat as the job with its result. One piece
of work, two views: the card reads the SAME change id the Pip's chat shows, so applying in one place is applied in the
other. The job record carries where it was asked from. A Pip writes into a session only as the answer to a job that
session gave it; a message from a Pip is never consent and never changes a setting.

A real registry, a real Git project, a folder Pip with its own box and a Pip for anything with a computer; runs are
claimed and finished through the store as the Pips runner does, and the worker's model never runs.
"""
from __future__ import annotations

import json
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_jobs as jobs, pip_levels, pip_project_copies as copies
from dgc.workspace_registry import RegistryError
from tests.test_pip_give_folder import GiveWorld

WORK = {"kind": "work", "id": "sess-tidy-1", "title": "Tidy the October invoices"}
CHAT = {"kind": "chatdgc", "id": "chat-gst-1", "title": "GST questions"}
FIXED_UTIL = "X = 2\n"


class JobWorld(GiveWorld):
    """self.helper: a folder Pip of "shop" with its own box; self.pip: "Coder", a Pip for anything with a computer."""

    def setUp(self):
        super().setUp()
        # (Start on a job starts the Pips runner when none runs: never a real runner from a test.)
        runner = patch.object(jobs, "ensure_runner", return_value=None)
        runner.start()
        self.addCleanup(runner.stop)

    def ask(self, pip=None, words="check util.py and fix it if it's wrong", about="util.py's X", asked=WORK,
            folder="shop", key="call-1"):
        return jobs.ask(self.registry, self.cfg, pip=(pip or self.helper)["name"] if not isinstance(pip, str) else pip,
                        words=words, about=about, asked=asked, folder=self.root if folder == "shop" else folder,
                        request_key=key)

    def level(self, pip, value):
        pip_levels.set_level(self.registry, pip["id"], value, "editor-user")

    def turn_message(self, pip, job):
        """The job's message in the Pip's chat, as the chat lists it."""
        page = self.control("list_pip_messages", pip_id=pip["id"])
        return next(m for m in page["messages"] if m["role"] == "user" and (m.get("job") or {}).get("id") == job["id"])

    def answer(self, job, text="X was 1; it should be 2. I fixed it in my copy.", edit=True, pip=None):
        """The Pip's turn as the runner runs it: its copy changed (when `edit`), then its reply kept."""
        pip = pip or self.helper
        run = self.store.claim_next()
        self.assertIsNotNone(run, "the job's turn is queued")
        if edit:
            if (pip["id"] == self.helper["id"]):
                copies.own_folder(self.store, pip["id"])          # (the runner makes a folder Pip's own copy at run start)
            (self.own_copy(pip) / "util.py").write_text(FIXED_UTIL)
        self.store.finish(run["id"], result={"text": text})
        return run

    def view(self, job, actor="editor-user"):
        return self.control("get_pip_job", actor=actor, job_id=job["id"])["job"]


class AskingAPip(JobWorld, unittest.TestCase):
    def test_a_work_session_hands_a_folder_pip_a_job_and_it_lands_in_the_pips_chat_linked_back(self):
        self.level(self.helper, pip_levels.APPROVE)
        job = self.ask()
        self.assertRegex(job["id"], r"^pipjob_[0-9a-f]{32}$")
        self.assertEqual(job["state"], "working")
        self.assertEqual(job["asked_from"], {"kind": "work", "id": "sess-tidy-1", "title": "Tidy the October invoices"})
        self.assertEqual((job["pip"]["id"], job["pip"]["name"]), (self.helper["id"], "Shop helper"))
        message = self.turn_message(self.helper, job)
        self.assertTrue(message["intro"], "DGC wrote this turn: never a bubble of the user's")
        self.assertEqual(message["job"]["asked_from"]["title"], "Tidy the October invoices")
        self.assertEqual(message["job"]["words"], "check util.py and fix it if it's wrong")
        # What the Pip is told: DGC's words, the job as it was asked there, what "this" is, and its own folder's copy.
        self.assertIn("This message is from DGC, not the user.", message["text"])
        self.assertIn("Tidy the October invoices", message["text"])
        self.assertIn("check util.py and fix it if it's wrong", message["text"])
        self.assertIn("util.py's X", message["text"])
        self.assertIn("your own folder", message["text"])

    def test_a_pip_of_another_folder_works_on_the_at_project_copy_of_the_asking_folder(self):
        self.level(self.pip, pip_levels.APPROVE)
        job = self.ask(self.pip)
        self.assertTrue((self.own_copy(self.pip) / "util.py").is_file(), "a copy of shop in its computer's Files")
        self.assertFalse((self.own_copy(self.pip) / ".env").exists(), "never what Git ignores")
        message = self.turn_message(self.pip, job)
        self.assertIn("projects/shop", message["text"])
        self.assertEqual(job["folder"], {"name": "shop", "own": False, "copy": "projects/shop"})

    def test_a_pip_without_a_computer_still_answers_and_everyone_is_told_why_it_has_no_copy(self):
        plain = self.store.create(self.registry.personal()["id"], "Plain", None, "editor-user", pip_type="quill")
        self.level(plain, pip_levels.APPROVE)
        job = self.ask(plain)
        self.assertEqual(job["state"], "working")
        self.assertIn("computer", job["folder"]["note"])
        self.assertIn("computer", self.turn_message(plain, job)["text"])

    def test_chatdgc_asks_a_question_with_no_folder(self):
        self.level(self.pip, pip_levels.APPROVE)
        job = self.ask(self.pip, words="what does the shop sell?", about="", asked=CHAT, folder=None)
        self.assertIsNone(job["folder"])
        text = self.turn_message(self.pip, job)["text"]
        self.assertNotIn("projects/", text)
        self.assertIn("GST questions", text)

    def test_the_same_ask_twice_is_one_job(self):
        self.level(self.helper, pip_levels.APPROVE)
        first, again = self.ask(key="call-7"), self.ask(key="call-7")
        self.assertEqual(first["id"], again["id"])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_jobs").fetchone()[0], 1)

    def test_a_pip_is_found_by_its_name_any_case_or_its_id_in_any_workspace(self):
        self.level(self.helper, pip_levels.APPROVE)
        self.assertEqual(self.ask("shop HELPER", key="a")["pip"]["id"], self.helper["id"])
        self.assertEqual(self.ask(self.helper["id"], key="b")["pip"]["id"], self.helper["id"])

    def test_refused_in_plain_words(self):
        with self.assertRaises(RegistryError) as raised:
            self.ask("Nobody")
        self.assertIn("No Pip is named “Nobody”", str(raised.exception))
        self.assertIn("Shop helper", str(raised.exception), "the Pips there are, by name")
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pips SET status='paused' WHERE id=?", (self.helper["id"],))
        with self.assertRaises(RegistryError) as raised:
            self.ask()
        self.assertEqual(raised.exception.code, "paused")
        self.assertIn("Shop helper is paused", str(raised.exception))
        with self.registry.transaction():
            self.registry.db.execute("UPDATE pips SET status='archived' WHERE id=?", (self.helper["id"],))
        with self.assertRaises(RegistryError) as raised:
            self.ask(self.helper["id"])
        self.assertEqual(raised.exception.code, "archived")
        with self.assertRaises(RegistryError) as raised:
            self.ask(self.pip, asked={"kind": "pip", "id": self.pip["id"], "title": "Coder"})
        self.assertIn("itself", str(raised.exception))
        kept = self.registry.db.execute("SELECT name FROM sqlite_master WHERE name='pip_jobs'").fetchone()
        self.assertTrue(kept is None or not self.registry.db.execute("SELECT count(*) FROM pip_jobs").fetchone()[0],
                        "nothing kept")

    def test_a_busy_pip_queues_the_job_and_starts_it_after_the_current_reply(self):
        self.level(self.helper, pip_levels.APPROVE)
        pip_chat.send(self.store, self.helper["id"], "Hello", "m-busy", "editor-user", self.cfg)
        job = self.ask()
        self.assertEqual(job["state"], "queued")
        self.assertIn("after its current reply", job["state_words"])
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": "Hi."})
        pip_chat.send_owed_turns(self.registry, self.cfg)
        jobs.settle(self.registry, self.cfg)
        self.assertEqual(self.view(job)["state"], "working")


class AskMeFirst(JobWorld, unittest.TestCase):
    def test_at_ask_me_first_it_waits_for_you_in_its_own_chat(self):
        self.level(self.helper, pip_levels.ASK)
        job = self.ask()
        self.assertEqual(job["state"], "asking")
        self.assertEqual(job["state_words"], "Waiting for you in Shop helper's chat")
        self.assertIsNone(self.store.claim_next(), "nothing runs before you say so")
        page = self.control("list_pip_messages", pip_id=self.helper["id"])
        self.assertEqual([j["id"] for j in page["asking_jobs"]], [job["id"]])
        with self.assertRaises(RegistryError) as raised:
            self.control("start_pip_job", actor="paired-phone", pip_id=self.helper["id"], job_id=job["id"])
        self.assertEqual(raised.exception.code, "local_only")
        started = self.control("start_pip_job", pip_id=self.helper["id"], job_id=job["id"])["job"]
        self.assertEqual(started["state"], "working")
        self.assertNotIn("asking_jobs", self.control("list_pip_messages", pip_id=self.helper["id"]))

    def test_not_now_declines_it_and_the_asking_card_says_so(self):
        job = self.ask()
        declined = self.control("decline_pip_job", pip_id=self.helper["id"], job_id=job["id"])["job"]
        self.assertEqual(declined["state"], "declined")
        self.assertIn("not now", declined["state_words"])
        with self.assertRaises(RegistryError):
            self.control("start_pip_job", pip_id=self.helper["id"], job_id=job["id"])


class TheAnswerComesBackToBoth(JobWorld, unittest.TestCase):
    def test_the_answer_and_the_same_change_id_in_the_card_and_the_pips_chat(self):
        self.level(self.helper, pip_levels.APPROVE)
        job = self.ask()
        self.answer(job)
        done = self.view(job)
        self.assertEqual(done["state"], "done")
        self.assertEqual(done["answer"], "X was 1; it should be 2. I fixed it in my copy.")
        [change] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        self.assertEqual(done["change"]["id"], change["id"], "the card reads the change the Pip's chat shows")
        self.assertEqual(done["change"]["status"], "pending")
        self.assertEqual(done["change"]["digest"], change["digest"])
        self.assertEqual([(f["path"], f["plus"], f["minus"]) for f in done["change"]["files"]], [("util.py", 1, 1)])
        self.assertEqual((self.root / "util.py").read_text(), "X = 1\n", "nothing in your folder before Apply")
        # Apply from the asking card (the same command the Pip's chat sends): applied in both places.
        self.control("apply_pip_project_change", pip_id=self.helper["id"], change_id=done["change"]["id"],
                     expected_digest=done["change"]["digest"])
        self.assertEqual((self.root / "util.py").read_text(), FIXED_UTIL)
        self.assertEqual(self.view(job)["change"]["status"], "applied")
        [shown] = self.control("list_pip_project_changes", pip_id=self.helper["id"])["changes"]
        self.assertEqual(shown["status"], "applied")
        # Undo from the Pip's chat: the card says so too.
        self.control("undo_pip_project_change", pip_id=self.helper["id"], change_id=shown["id"])
        self.assertEqual(self.view(job)["change"]["status"], "undone")

    def test_the_job_and_its_answer_stay_in_the_pips_chat_as_from_the_session(self):
        self.level(self.helper, pip_levels.APPROVE)
        job = self.ask()
        self.answer(job, edit=False, text="Rounding is right: nothing to change.")
        page = self.control("list_pip_messages", pip_id=self.helper["id"])
        [asked] = [m for m in page["messages"] if m.get("job")]
        reply = next(m for m in page["messages"] if m["role"] == "assistant" and m["run_id"] == asked["run_id"])
        self.assertEqual(reply["text"], "Rounding is right: nothing to change.")
        self.assertEqual(asked["job"]["state"], "done")
        self.assertIsNone(self.view(job)["change"], "an answer only")

    def test_it_lands_in_the_chat_used_last_not_its_first(self):
        # (The 20 Nov test: the answer went to the Pip's first chat, untouched for a week, while the chat he opens is the
        # one he used last: its list said unread and the chat he opened didn't have it.)
        self.level(self.helper, pip_levels.APPROVE)
        later = self.control("create_pip_conversation", pip_id=self.helper["id"], title="Visit the shop's site")
        later_id = (later.get("conversation") or later)["id"]
        self.control("send_pip_message", pip_id=self.helper["id"], text="hello there", idempotency_key="hello-1",
                     conversation_id=later_id)
        self.store.finish(self.store.claim_next()["id"], result={"text": "Hi."})
        job = self.ask()
        self.answer(job, edit=False, text="Rounding is right: nothing to change.")
        page = self.control("list_pip_messages", pip_id=self.helper["id"], conversation_id=later_id)
        self.assertTrue([m for m in page["messages"] if m.get("job")], "the job is in the chat used last")
        self.assertIn("Rounding is right: nothing to change.", [m["text"] for m in page["messages"]])
        first = self.control("list_pip_messages", pip_id=self.helper["id"])
        self.assertFalse([m for m in first["messages"] if m.get("job")], "not in its first chat")
        self.assertEqual(self.view(job)["state"], "done")

    def test_an_archived_last_chat_is_skipped(self):
        self.level(self.helper, pip_levels.APPROVE)
        later = self.control("create_pip_conversation", pip_id=self.helper["id"], title="Old")
        later_id = (later.get("conversation") or later)["id"]
        self.control("archive_pip_conversation", pip_id=self.helper["id"], conversation_id=later_id)
        job = self.ask()
        self.answer(job, edit=False, text="Fine.")
        first = self.control("list_pip_messages", pip_id=self.helper["id"])
        self.assertTrue([m for m in first["messages"] if m.get("job")])

    def test_at_do_it_all_the_change_is_in_your_folder_with_undo_and_the_card_says_applied(self):
        self.level(self.helper, pip_levels.FULL)
        job = self.ask()
        run = self.store.claim_next()
        copies.own_folder(self.store, self.helper["id"])
        (self.own_copy(self.helper) / "util.py").write_text(FIXED_UTIL)
        copies.auto_apply(self.store, self.helper["id"])         # (the runner does this as a Do it all turn ends)
        self.store.finish(run["id"], result={"text": "Fixed and applied."})
        done = self.view(job)
        self.assertEqual(done["change"]["status"], "applied")
        self.assertEqual((self.root / "util.py").read_text(), FIXED_UTIL)

    def test_a_failed_turn_and_a_stopped_one_say_so(self):
        self.level(self.helper, pip_levels.APPROVE)
        job = self.ask()
        run = self.store.claim_next()
        self.store.finish(run["id"], error={"code": "model_error", "message": "The model didn't answer."})
        failed = self.view(job)
        self.assertEqual(failed["state"], "failed")
        self.assertIn("didn't answer", failed["error"])
        other = self.ask(key="call-2")
        run = self.store.claim_next()
        self.store.cancel(run["id"], "editor-user")
        self.store.finish(run["id"], error={"code": "cancelled", "message": "stopped"})
        self.assertEqual(self.view(other)["state"], "stopped")

    def test_the_asking_chat_is_told_once_with_dgcs_own_words(self):
        self.level(self.helper, pip_levels.APPROVE)
        job = self.ask()
        self.assertEqual(jobs.deliverable(self.registry, "work", "sess-tidy-1"), [], "nothing to tell while it works")
        self.answer(job)
        [due] = jobs.deliverable(self.registry, "work", "sess-tidy-1")
        self.assertEqual(due["id"], job["id"])
        notice = jobs.notice(due)
        self.assertTrue(notice.startswith(jobs.NOTICE_HEAD))
        self.assertIn("not the user", notice)
        self.assertIn("X was 1; it should be 2.", notice)
        self.assertIn("Apply", notice)
        parsed = jobs.parse_notice(notice)
        self.assertEqual((parsed["job_id"], parsed["pip"], parsed["state"]), (job["id"], "Shop helper", "done"))
        self.assertIsNone(jobs.parse_notice("check util.py"), "a person's words are never a notice")
        jobs.mark_delivered(self.registry, job["id"])
        self.assertEqual(jobs.deliverable(self.registry, "work", "sess-tidy-1"), [])
        self.assertEqual(jobs.deliverable(self.registry, "chatdgc", "sess-tidy-1"), [], "only to the chat that asked")


class OnePipAsksAnother(JobWorld, unittest.TestCase):
    def converse(self, pip, text, candidates, reply="I've asked Shop helper to look."):
        sent = pip_chat.send(self.store, pip["id"], text, "m-" + str(len(text)), "editor-user", self.cfg)
        run = self.store.claim_next()
        self.store.finish(run["id"], result={"text": reply, "pip_jobs": candidates})
        return sent

    def test_a_pip_hands_another_a_job_and_the_answer_comes_back_to_its_chat(self):
        self.level(self.helper, pip_levels.APPROVE)
        pin = jobs.pin(self.registry, self.pip["id"])
        self.assertIn(self.helper["id"], [p["id"] for p in pin])
        self.assertNotIn(self.pip["id"], [p["id"] for p in pin], "never itself")
        candidate, told = jobs.tool_result(pin, {"pip": "Shop helper", "job": "look at util.py", "about": "X"}, 0)
        self.assertEqual(candidate, {"pip_id": self.helper["id"], "words": "look at util.py", "about": "X"})
        self.assertIn("Shop helper", told)
        self.converse(self.pip, "@Shop helper look at util.py", [candidate])
        [row] = self.registry.db.execute("SELECT * FROM pip_jobs").fetchall()
        self.assertEqual((row["asked_kind"], row["asked_id"], row["asked_title"]), ("pip", self.pip["id"], "Coder"))
        jobs.settle(self.registry, self.cfg)                 # (the runner's next pass sends the turn)
        job = self.view({"id": row["id"]})
        self.assertEqual(job["state"], "working")
        self.answer(job, text="util.py is fine.", edit=False)
        jobs.settle(self.registry, self.cfg)
        page = self.control("list_pip_messages", pip_id=self.pip["id"])
        reply = next(m for m in page["messages"] if m["role"] == "assistant" and m.get("pip_jobs"))
        self.assertEqual([j["id"] for j in reply["pip_jobs"]], [row["id"]], "the card under the reply that asked")
        told = [m for m in page["messages"] if m["role"] == "user" and m.get("intro")
                and "util.py is fine." in m["text"]]
        self.assertEqual(len(told), 1, "the answer, as DGC's own turn in the asking Pip's chat")
        self.assertIn("not the user", told[0]["text"])
        jobs.settle(self.registry, self.cfg)
        page = self.control("list_pip_messages", pip_id=self.pip["id"])
        self.assertEqual(len([m for m in page["messages"] if "util.py is fine." in m["text"] and m["role"] == "user"]), 1,
                         "told once")

    def test_a_pip_cant_be_talked_into_a_pip_it_wasnt_offered(self):
        pin = jobs.pin(self.registry, self.pip["id"])
        candidate, told = jobs.tool_result(pin, {"pip": "Nobody", "job": "x"}, 0)
        self.assertIsNone(candidate)
        self.assertIn("No Pip is named", told)
        with self.assertRaises(RegistryError):
            self.converse(self.pip, "hi", [{"pip_id": "pip_" + "0" * 32, "words": "x", "about": ""}])

    def test_a_jobs_own_turn_hands_no_further_jobs(self):
        self.level(self.helper, pip_levels.APPROVE)
        job = self.ask()
        run = self.store.run(self.view(job)["run_id"])
        self.assertIsNone(jobs.runtime(self.registry, run, run["manifest"]).get(jobs.PIN))


class WhereAPipShows(JobWorld, unittest.TestCase):
    def test_every_pip_is_a_target_for_every_session(self):
        names = {p["name"] for p in jobs.targets(self.registry)}
        self.assertTrue({"Coder", "Shop helper"} <= names)

    def test_a_named_pip_is_made_known_to_the_asking_model(self):
        marks = [{"start": 0, "kind": "pip", "label": "Shop helper", "identity": self.helper["id"], "pip_type": "patch"}]
        line = jobs.named_line(self.registry, marks)
        self.assertIn("Shop helper", line)
        self.assertIn("ask_pip", line)
        self.assertIn("shop", line, "the folder it works in")
        self.assertIn("rather than doing it yourself", line, "an @ is the user asking that Pip, not the model")
        self.assertEqual(jobs.named_line(self.registry, []), "")

    def test_a_job_is_kept_with_where_it_was_asked_from(self):
        self.level(self.helper, pip_levels.APPROVE)
        job = self.ask()
        listed = self.control("list_pip_jobs", pip_id=self.helper["id"])["jobs"]
        self.assertEqual([j["id"] for j in listed], [job["id"]])
        self.assertEqual(listed[0]["asked_from"]["kind"], "work")


if __name__ == "__main__":
    unittest.main()
