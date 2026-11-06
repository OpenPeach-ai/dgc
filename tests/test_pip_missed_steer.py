"""A mid-turn message to a Pip is always answered or plainly given back; it never goes unanswered in silence.

A message sent in a reply's last seconds used to be marked missed and never answered. What Work does with steering a
turn did not take is the rule here (headless._finish_steering, _stop_turn)."""
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_steering, pips
from dgc.llm import ChatResult, LLMClient
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures


class Base(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def job_ready(self):
        self.commit()
        self.job = self.create()

    def send(self, text, key, actor="device_1"):
        return pip_chat.send(self.store, self.job["id"], text, key, actor, self.cfg)

    def page(self):
        return pip_chat.list_messages(self.store, self.job["id"])

    def said(self):
        """The transcript, as the chat draws it after a reload."""
        with WorkspaceRegistry(self.registry.directory) as reopened:
            page = pip_chat.list_messages(pips.PipStore(reopened), self.job["id"])
        return [(m["role"], m["text"]) for m in page["messages"]]

    def run_to_end(self, reply="Done.", during=None, error=None):
        """One real runner pass over the oldest queued run: claim it, 'execute' it, close it and settle what's left.
        `during` happens while the run is still running: after the last model round, before it closes."""
        row = self.store.claim_next()
        self.assertIsNotNone(row, "a run should be queued")

        def execute(*_):
            if during:
                during()
            if error:
                raise RegistryError(*error)
            return {"text": reply}
        with patch.object(pips, "_execute_run", side_effect=execute), patch.object(pips, "_run_granted_actions"), \
                patch("dgc.pip_memory_review.after_run"), patch("dgc.pip_memory_review.run_started"), \
                patch("dgc.pip_flows.after_run"), patch("dgc.pip_run_cleanup.prune_run"):
            pips._run_claimed(self.registry, self.store, row, self.cfg, self.registry.directory)
        return row["id"]

    def queued_run_of(self, text):
        return self.registry.db.execute(
            "SELECT r.id,r.status,r.manifest FROM pip_chat_messages m JOIN pip_runs r ON r.id=m.run_id "
            "WHERE m.pip_id=? AND m.role='user' AND m.text=?", (self.job["id"], text)).fetchone()


class AFinishedReply(Base):
    def test_a_message_it_never_read_is_the_next_turn_straight_away(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        update = self.send("How much traffic did we get?", "late")
        self.assertTrue(update["message"]["steered"])
        self.assertEqual(update["run"]["id"], first["run"]["id"])
        self.run_to_end("Here is the summary.")
        turn = self.queued_run_of("How much traffic did we get?")
        self.assertIsNotNone(turn, "the message has a turn of its own")
        self.assertEqual(turn["status"], "queued")
        self.assertNotEqual(turn["id"], first["run"]["id"])
        page = self.page()
        self.assertEqual([(m["role"], m["text"]) for m in page["messages"]],
                         [("user", "Write the summary"), ("assistant", "Here is the summary."),
                          ("user", "How much traffic did we get?")])
        message = page["messages"][-1]
        self.assertEqual(message["id"], update["message"]["id"], "the same message, not a copy of it")
        self.assertEqual(message["status"], "queued")
        self.assertNotIn("error", message)
        self.assertFalse(message.get("steered"), "it was never steered in: no Steered mark, no failed mark")
        self.assertEqual(page["active_run"]["id"], turn["id"])
        self.assertEqual(page["waiting"], [])
        # It knows what was said before it.
        history = json.loads(turn["manifest"])["conversation"]["history"]
        self.assertEqual([m["content"] for m in history], ["Write the summary", "Here is the summary."])
        self.run_to_end("About 400 visits.")
        self.assertEqual(self.said()[-2:], [("user", "How much traffic did we get?"), ("assistant", "About 400 visits.")])
        self.assertEqual(pip_chat.snapshot(self.store, self.job["id"])[1], 0, "complete pairs, none lost")

    def test_the_race_a_message_after_the_last_model_round_before_the_run_closes(self):
        self.job_ready()
        self.send("Write the summary", "first")
        sent = {}

        def as_the_turn_ends():
            # From the editor's own connection, as a real send is.
            with WorkspaceRegistry(self.registry.directory) as other:
                sent["reply"] = pip_chat.send(pips.PipStore(other), self.job["id"], "One more thing", "late", "device_1", self.cfg)
        finished = self.run_to_end("Summary.", during=as_the_turn_ends)
        self.assertEqual(sent["reply"]["run"]["id"], finished, "it joined the reply still open")
        self.assertEqual(sent["reply"]["message"]["steer_status"], "pending")
        steering = self.registry.db.execute("SELECT status FROM pip_chat_steers WHERE request_key='late'").fetchone()
        self.assertIsNone(steering, "not left behind as a missed message")
        self.assertEqual(self.queued_run_of("One more thing")["status"], "queued")
        self.run_to_end("And the other thing.")
        self.assertEqual(self.said(), [("user", "Write the summary"), ("assistant", "Summary."),
                                       ("user", "One more thing"), ("assistant", "And the other thing.")])

    def test_a_send_that_sees_the_reply_close_under_it_becomes_a_turn_not_an_error(self):
        # The editor read "there is a live reply"; by the time it holds the write lock the reply has closed.
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.store.claim_next()
        real = pip_steering.send
        calls = []

        def closes_first(store, pip, run, req, actor):
            if not calls:
                calls.append(run["id"])
                store.finish(run["id"], result={"text": "Summary."})
            return real(store, pip, run, req, actor)
        with patch.object(pip_steering, "send", side_effect=closes_first):
            late = self.send("One more thing", "late")
        self.assertEqual(calls, [first["run"]["id"]])
        self.assertNotEqual(late["run"]["id"], first["run"]["id"])
        self.assertEqual(late["run"]["status"], "queued")
        self.assertFalse(late["message"].get("steered"))

    def test_a_retry_of_the_send_finds_the_same_message_in_its_new_turn(self):
        self.job_ready()
        self.send("Write the summary", "first")
        update = self.send("One more thing", "late")
        self.run_to_end()
        again = self.send("One more thing", "late")
        self.assertEqual(again["message"]["id"], update["message"]["id"])
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 2)
        with self.assertRaises(RegistryError):
            self.send("Different words", "late")
        with self.assertRaises(RegistryError):
            self.send("One more thing", "late", actor="device_2")

    def test_several_are_answered_in_order_one_turn_each_as_in_work(self):
        self.job_ready()
        self.send("Write the summary", "first")
        words = ["First thing", "Second thing", "Third thing"]
        for index, text in enumerate(words):
            self.send(text, f"late-{index}")
        self.run_to_end("Summary.")
        page = self.page()
        self.assertEqual([m["text"] for m in page["messages"]], ["Write the summary", "Summary.", "First thing"])
        self.assertEqual([m["text"] for m in page["waiting"]], ["Second thing", "Third thing"],
                         "waiting above the box in order, not in the transcript")
        self.run_to_end("One.")
        self.assertEqual([m["text"] for m in self.page()["waiting"]], ["Third thing"])
        self.run_to_end("Two.")
        self.assertEqual(self.page()["waiting"], [])
        self.run_to_end("Three.")
        self.assertEqual(self.said(), [("user", "Write the summary"), ("assistant", "Summary."),
                                       ("user", "First thing"), ("assistant", "One."),
                                       ("user", "Second thing"), ("assistant", "Two."),
                                       ("user", "Third thing"), ("assistant", "Three.")])
        self.assertIsNone(self.store.claim_next(), "nothing runs twice")

    def test_one_sent_in_the_moment_after_the_close_goes_behind_those_waiting(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("Earlier", "earlier")
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result={"text": "Summary."})      # closed; its turn not started yet
        late = self.send("Later", "later")
        self.assertEqual(late["message"]["status"], "queued")
        self.assertEqual([m["text"] for m in self.page()["waiting"]], ["Earlier", "Later"])
        pip_steering.settle(self.store, first["run"]["id"], self.cfg)
        self.assertEqual(self.queued_run_of("Earlier")["status"], "queued")
        self.assertEqual([m["text"] for m in self.page()["waiting"]], ["Later"])

    def test_a_message_that_cannot_start_says_it_was_not_sent_and_keeps_its_words(self):
        self.job_ready()
        self.send("Write the summary", "first")
        self.send("One more thing", "late")
        with patch.object(self.store, "enqueue", side_effect=RegistryError("limit", "The local run queue is full.")):
            self.run_to_end("Summary.")
        page = self.page()
        self.assertEqual([m["text"] for m in page["messages"]], ["Write the summary", "Summary.", "One more thing"], "under the reply")
        message = page["messages"][-1]
        self.assertEqual((message["steer_status"], message["status"]), ("missed", "failed"))
        self.assertEqual(message["error"], "The Pip couldn't start a reply to this.")
        self.assertEqual(page["waiting"], [])

    def test_stopped_pips_keep_it_for_when_they_run_again(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("One more thing", "late")
        with patch.object(self.store, "enqueue", side_effect=RegistryError("runner_stopped", "Pips are stopped.")):
            self.run_to_end("Summary.")
        self.assertEqual([m["text"] for m in self.page()["waiting"]], ["One more thing"])
        pip_steering.recover(self.store, self.cfg)      # the runner's next start
        self.assertEqual(self.queued_run_of("One more thing")["status"], "queued")
        self.assertEqual(self.page()["active_run"]["status"], "queued")
        self.assertNotEqual(self.queued_run_of("One more thing")["id"], first["run"]["id"])

    def test_a_message_the_reply_did_read_is_not_answered_twice(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        update = self.send("Make it short", "read")
        self.store.claim_next()
        pip_steering.applied(self.store, first["run"]["id"], [update["message"]["id"]])
        self.store.finish(first["run"]["id"], result={"text": "Short summary."})
        pip_steering.settle(self.store, first["run"]["id"], self.cfg)
        self.assertIsNone(self.store.claim_next())
        page = self.page()
        self.assertEqual([m["text"] for m in page["messages"]], ["Write the summary", "Make it short", "Short summary."])
        self.assertEqual(page["messages"][1]["steer_status"], "applied")
        self.assertIsNone(page["active_run"])


class StoppedOrFailed(Base):
    def unsent(self, text):
        message = next(m for m in self.page()["messages"] if m["text"] == text)
        self.assertEqual((message["status"], message["steer_status"]), ("failed", "missed"), message)
        return message

    def test_stop_gives_it_back_unsent_as_in_work_and_starts_nothing(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("One more thing", "late")

        def pressed_stop():
            self.store.cancel(first["run"]["id"], "device_1")
        self.run_to_end("Partial", during=pressed_stop)
        self.assertEqual(self.store.run(first["run"]["id"])["status"], "cancelled")
        self.assertIn("Stopped before the Pip read this", self.unsent("One more thing")["error"])
        self.assertIsNone(self.store.claim_next(), "Stop means stop: no new turn")
        self.assertIsNone(self.page()["active_run"])

    def test_stop_stops_the_queue_too(self):
        self.job_ready()
        self.send("Write the summary", "first")
        self.send("First thing", "a")
        self.send("Second thing", "b")
        self.run_to_end("Summary.")
        turn = self.queued_run_of("First thing")
        self.assertEqual([m["text"] for m in self.page()["waiting"]], ["Second thing"])
        self.store.cancel(turn["id"], "device_1")           # stopped before it even started
        self.assertEqual(self.page()["waiting"], [])
        self.assertIn("Stopped before the Pip read this", self.unsent("Second thing")["error"])
        self.assertEqual([m["text"] for m in self.page()["messages"]],
                         ["Write the summary", "Summary.", "First thing", "Second thing"], "beside the reply that was stopped")
        self.assertIsNone(self.store.claim_next())

    def test_stopping_a_queued_reply_gives_back_what_joined_it(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("One more thing", "late")
        self.store.cancel(first["run"]["id"], "device_1")
        self.assertEqual(self.registry.db.execute("SELECT status FROM pip_chat_steers").fetchone()[0], "missed")
        self.assertIn("Stopped before the Pip read this", self.unsent("One more thing")["error"])

    def test_a_failed_reply_gives_it_back_and_what_waited_before_still_runs(self):
        self.job_ready()
        self.send("Write the summary", "first")
        self.send("First thing", "a")
        self.send("Second thing", "b")
        self.run_to_end("Summary.")                         # First thing is a turn, Second thing waits
        self.send("While it runs", "c")                     # joins First thing's turn
        self.run_to_end(error=("model_failed", "The model didn't answer."))
        self.assertIn("reply ended before the Pip read this", self.unsent("While it runs")["error"])
        self.assertEqual(self.queued_run_of("Second thing")["status"], "queued",
                         "Work's queue carries on after a failed turn")
        self.run_to_end("Two.")
        self.assertEqual(self.said()[-2:], [("user", "Second thing"), ("assistant", "Two.")])

    def test_a_runner_restart_loses_the_reply_not_the_message(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("One more thing", "late")
        self.store.claim_next()
        self.assertEqual(self.store.recover(), 1)
        pip_steering.recover(self.store, self.cfg)
        self.assertEqual(self.store.run(first["run"]["id"])["status"], "failed")
        self.assertIn("before the Pip read this", self.unsent("One more thing")["error"])
        self.assertEqual(self.registry.db.execute("SELECT status FROM pip_chat_steers").fetchone()[0], "missed")
        with WorkspaceRegistry(self.registry.directory) as reopened:
            kept = pip_chat.list_messages(pips.PipStore(reopened), self.job["id"])["messages"]
        self.assertIn("One more thing", [m["text"] for m in kept])

    def test_the_message_of_a_reply_that_was_lost_says_so_in_plain_words(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.store.claim_next()
        self.store.recover()
        said = self.page()["messages"][0]
        self.assertEqual(said["error"], "Pips stopped before this reply finished. Send your message again.")
        second = self.send("Try again", "second")
        self.run_to_end(error=("worker_failed", "The audit worker stopped without a verified structured result."))
        said = next(m for m in self.page()["messages"] if m["id"] == second["message"]["id"])
        self.assertEqual(said["error"], "Its worker stopped unexpectedly. Send your message again.")
        self.assertNotEqual(first["run"]["id"], second["run"]["id"])

    def test_a_restart_right_after_the_reply_finished_still_answers_it(self):
        # The runner died between closing the reply and starting the message's turn.
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("One more thing", "late")
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result={"text": "Summary."})
        self.assertEqual([m["text"] for m in self.page()["waiting"]], ["One more thing"])
        self.store.recover()
        pip_steering.recover(self.store, self.cfg)
        self.assertEqual(self.queued_run_of("One more thing")["status"], "queued")

    def test_the_runner_recovers_them_when_it_starts(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("One more thing", "late")
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result={"text": "Summary."})
        cfg = self.cfg
        with patch.object(cfg, "get", side_effect=lambda key, default=None: False if key == "pips_enabled" else default):
            pips._drain(cfg, self.registry.directory)           # disabled: recovers, runs nothing
        self.assertEqual(self.queued_run_of("One more thing")["status"], "queued")

    def test_sending_it_again_replaces_the_not_sent_message(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        self.send("One more thing", "late")
        self.store.claim_next()
        self.store.cancel(first["run"]["id"], "device_1")
        self.store.finish(first["run"]["id"], result={"text": "Partial"})
        pip_steering.settle(self.store, first["run"]["id"], self.cfg)
        self.assertEqual(len([m for m in self.page()["messages"] if m["text"] == "One more thing"]), 1)
        self.send("Other words", "other")
        self.assertIsNotNone(next(m for m in self.page()["messages"] if m["text"] == "One more thing" and m.get("steered")),
                             "other words leave it where it is")
        again = self.send("One more thing", "again")
        rows = [m for m in self.page()["messages"] if m["text"] == "One more thing"]
        self.assertEqual([m["id"] for m in rows], [again["message"]["id"]], "one message, not a sent one beside a not-sent one")
        self.assertEqual(rows[0]["steer_status"], "pending", "it joined the reply running now")

    def test_a_read_message_of_a_failed_reply_can_be_sent_again_but_stays_in_its_history(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        update = self.send("Make it short", "read")
        self.store.claim_next()
        pip_steering.applied(self.store, first["run"]["id"], [update["message"]["id"]])
        self.store.finish(first["run"]["id"], error={"code": "model_failed", "message": "No answer."})
        pip_steering.settle(self.store, first["run"]["id"], self.cfg)
        message = next(m for m in self.page()["messages"] if m["id"] == update["message"]["id"])
        self.assertEqual((message["status"], message["steer_status"]), ("failed", "applied"))
        self.assertIsNone(self.store.claim_next())


class ARoutine(Base):
    def personal(self):
        self.pip = self.store.create(self.registry.personal()["id"], "Morning", None, "editor-user", pip_type="quill")
        self.job = self.pip

    def test_a_message_never_read_by_a_routines_turn_is_answered_after_it(self):
        self.personal()
        turn = pip_chat.send(self.store, self.pip["id"], "Routine: send me the news.", pip_chat.ROUTINE_KEY + "x" * 12, "local-routine",
                             self.cfg, _intro=True)
        update = self.send("Are you there?", "late", actor="editor-user")
        self.assertEqual(update["run"]["id"], turn["run"]["id"], "it joins the turn the Pip is on")
        self.run_to_end("The news.")
        follow = self.queued_run_of("Are you there?")
        self.assertEqual(follow["status"], "queued")
        self.assertEqual(json.loads(follow["manifest"])["requested_by"], "editor-user")
        self.run_to_end("I am.")
        self.assertEqual(self.said()[-2:], [("user", "Are you there?"), ("assistant", "I am.")])

    def test_a_routine_stays_a_separate_turn_while_a_message_waits(self):
        self.personal()
        self.send("Hello", "first", actor="editor-user")
        self.send("Again", "late", actor="editor-user")
        self.run_to_end("Hi.")
        with self.assertRaises(RegistryError) as busy:
            pip_chat.send(self.store, self.pip["id"], "Routine: news.", pip_chat.ROUTINE_KEY + "y" * 12, "local-routine", self.cfg, _intro=True)
        self.assertEqual(busy.exception.code, "conversation_busy")
        self.assertEqual(self.queued_run_of("Again")["status"], "queued")

    def test_a_message_during_a_run_that_is_not_a_chat_gets_its_own_reply_after_it(self):
        # A scheduled task isn't a reply: nothing joins it, and the message's reply waits its turn in the queue.
        self.personal()
        task = self.store.enqueue(self.pip["id"], "task-1", "device_1", self.cfg)
        self.assertEqual(task["manifest"]["run_kind"], "personal_task")
        self.store.claim_next()
        sent = self.send("Are you there?", "during", actor="editor-user")
        self.assertNotEqual(sent["run"]["id"], task["id"])
        self.assertFalse(sent["message"].get("steered"))
        self.assertEqual(sent["run"]["status"], "queued")
        self.assertIsNone(self.store.claim_next(), "one run at a time for a Pip")
        self.store.finish(task["id"], error={"code": "model_failed", "message": "No answer."})
        self.assertEqual(self.store.claim_next()["id"], sent["run"]["id"])


class TheMarks(Base):
    """The @ marks of a message (dgc/prompt_display.py) stay with it, whatever becomes of it."""

    def setUp(self):
        Base.setUp(self)
        self.job_ready()
        self.other = self.store.create(self.workspace["id"], "Scout", "Look around.", "device_1")
        self.words = "Ask Scout about it"
        self.marks = [{"start": 4, "kind": "pip", "label": "Scout", "identity": self.other["id"], "pip_type": "rook", "wired": True}]

    def marked(self, key, text=None):
        return pip_chat.send(self.store, self.job["id"], text or self.words, key, "device_1", self.cfg, display_mentions=self.marks)

    def message_of(self, text):
        return next(m for m in self.page()["messages"] if m["text"] == text)

    def test_a_message_that_becomes_a_turn_keeps_its_marks_and_its_turn_knows_the_pip_it_names(self):
        self.send("Write the summary", "first")
        joined = self.marked("late")
        self.assertEqual(joined["message"]["display_mentions"], self.marks)
        self.assertEqual(self.message_of(self.words)["display_mentions"], self.marks, "while it waits to be read")
        self.run_to_end("Summary.")
        turn = self.message_of(self.words)
        self.assertEqual(turn["id"], joined["message"]["id"])
        self.assertEqual(turn["display_mentions"], self.marks, "in its bubble as its own turn")
        self.assertFalse(turn.get("steered"))
        manifest = json.loads(self.queued_run_of(self.words)["manifest"])
        self.assertEqual([p["name"] for p in manifest["conversation"]["named_pips"]], ["Scout"])
        self.run_to_end("Scout says hello.")
        with WorkspaceRegistry(self.registry.directory) as reopened:
            kept = pip_chat.list_messages(pips.PipStore(reopened), self.job["id"])["messages"]
        self.assertEqual(next(m for m in kept if m["text"] == self.words)["display_mentions"], self.marks, "after a reload")

    def test_one_waiting_behind_another_keeps_its_marks_until_its_own_turn(self):
        self.send("Write the summary", "first")
        self.send("First thing", "a")
        self.marked("b")
        self.run_to_end("Summary.")
        self.assertEqual([m["text"] for m in self.page()["waiting"]], [self.words])
        self.run_to_end("One.")
        self.assertEqual(self.message_of(self.words)["display_mentions"], self.marks)
        self.assertEqual(json.loads(self.queued_run_of(self.words)["manifest"])["conversation"]["named_pips"][0]["name"], "Scout")

    def test_one_sent_in_the_moment_after_the_close_keeps_its_marks(self):
        first = self.send("Write the summary", "first")
        self.send("Earlier", "earlier")
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result={"text": "Summary."})
        behind = self.marked("later")
        self.assertEqual(behind["message"]["display_mentions"], self.marks)
        pip_steering.settle(self.store, first["run"]["id"], self.cfg)
        self.run_to_end("Done.")
        self.assertEqual(self.message_of(self.words)["display_mentions"], self.marks)

    def test_a_message_not_sent_keeps_its_marks_and_sending_it_again_leaves_one_set(self):
        first = self.send("Write the summary", "first")
        late = self.marked("late")
        self.store.claim_next()
        self.store.cancel(first["run"]["id"], "device_1")
        self.store.finish(first["run"]["id"], result={"text": "Partial"})
        pip_steering.settle(self.store, first["run"]["id"], self.cfg)
        unsent = self.message_of(self.words)
        self.assertEqual((unsent["steer_status"], unsent["display_mentions"]), ("missed", self.marks))
        again = self.marked("again")
        self.assertNotEqual(again["message"]["id"], late["message"]["id"])
        self.assertEqual(self.message_of(self.words)["id"], again["message"]["id"])
        self.assertEqual(self.message_of(self.words)["display_mentions"], self.marks)
        self.assertEqual(pip_chat.message_mentions(self.registry.db, late["message"]["id"]), [], "nothing left of the old one")

    def test_the_retry_of_a_message_with_marks_still_matches_after_it_became_a_turn(self):
        self.send("Write the summary", "first")
        late = self.marked("late")
        self.run_to_end("Summary.")
        again = self.marked("late")
        self.assertEqual(again["message"]["id"], late["message"]["id"])
        self.assertEqual(again["message"]["display_mentions"], self.marks)


class TheWorker(Base):
    """The real Agent loop on a mocked model: what it reads, and what it leaves for the controller."""

    def test_a_message_during_the_last_round_is_read_by_that_reply_and_after_it_is_left_alone(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        update = self.send("Make it short", "read")
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (first["run"]["id"],)).fetchone()[0])
        folder = self.registry.directory / "runs" / first["run"]["id"]
        folder.mkdir(parents=True, exist_ok=True)
        rounds, events = [], []

        def chat(client, messages, tools=None, **kwargs):
            rounds.append(messages)
            if len(rounds) == 1:
                pip_steering.stage(self.registry.db, first["run"]["id"], folder)
            return ChatResult(content=f"Round {len(rounds)}.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=False))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            pips.execute_native(self.cfg, folder / "snapshot.tar", raw, events.append)
        self.assertEqual(len(rounds), 2, "the reply carried on to read it")
        self.assertIn("Make it short", json.dumps(rounds[1]))
        self.assertIn({"kind": "steer_applied", "ids": [update["message"]["id"]]}, events)


if __name__ == "__main__":
    unittest.main()
