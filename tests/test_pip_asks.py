"""His call, 18 Nov: at Do it all, the cards a Pip made from outside a step it makes again are asked in its chat too.

- A job another Pip handed a Project Pip, that its level doesn't take by itself (a check nobody approved).
- A change to the Pip's own setup, which only the user's own next message can say yes to (never a routine's turn).
- A routine it suggested in a turn DGC started.
- Which of several accounts sends an email or adds an event.

The record stays (the handoff, the approval, the routine, the draft), but no list shows it as a card while it is asked:
Needs you, a project's reviews, notifications and the chat's own cards. The user's own next message answers it, through
answer_waiting; DGC does it after that reply is kept. Lowering the Pip below Do it all turns them back into cards.
"""
from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_attention, pip_chat, pip_holds, pip_levels as levels, pip_routines
from dgc.pip_chat_setup import validate as validate_setup
from tests import test_pips_local as local
from tests import test_pip_project_levels as project_levels

DAILY = {"kind": "schedule", "schedule": {"type": "daily", "time": "08:00", "timezone": "Asia/Kolkata"}}


def _kept(registry, run_id):
    row = registry.db.execute("SELECT text FROM pip_chat_messages WHERE run_id=? AND role='assistant'", (run_id,)).fetchone()
    return row[0] if row else None


class Answers(unittest.TestCase):
    """What an answer means: yes, no, one of its accounts, or nothing DGC can use."""

    def test_yes_no_and_accounts(self):
        plain = {"id": "ask_" + "0" * 16}
        self.assertEqual(pip_holds.meaning(plain, "Yes"), "yes")
        self.assertEqual(pip_holds.meaning(plain, "yes please, go ahead"), "yes")
        self.assertEqual(pip_holds.meaning(plain, "No."), "no")
        self.assertEqual(pip_holds.meaning(plain, "not now"), "no")
        self.assertIsNone(pip_holds.meaning(plain, "maybe later"))
        accounts = {"id": "ask_" + "1" * 16, "choices": ["me@work.example", "me@home.example"]}
        self.assertEqual(pip_holds.meaning(accounts, "ME@work.example"), "me@work.example")
        self.assertIsNone(pip_holds.meaning(accounts, "yes"), "an email needs the account named")
        self.assertEqual(pip_holds.meaning(accounts, "no"), "no")
        kept, told = pip_holds.answer_result([accounts], {"id": accounts["id"], "answer": "yes"})
        self.assertIsNone(kept)
        self.assertIn("me@work.example", told)
        kept, told = pip_holds.answer_result([accounts], {"id": "ask_" + "9" * 16, "answer": "yes"})
        self.assertIsNone(kept)

    def test_card_lists_leave_out_only_what_is_asked(self):
        self.assertEqual(pip_holds.not_asked("handoff", "h.id"),
                         "NOT EXISTS (SELECT 1 FROM metadata WHERE key='pip_asked:handoff:'||h.id)")
        with self.assertRaises(AssertionError):
            pip_holds.not_asked("handoff", "h.id; DROP TABLE x")


class PersonalPipAsks(unittest.TestCase):
    setUp = local.LocalPipsTests.setUp

    def pip(self, level=levels.FULL):
        pip = self.store.create(self.registry.personal()["id"], "Planner", "Help plan my day", "editor-user")
        levels.set_level(self.registry, pip["id"], level, "editor-user")
        return pip

    def turn(self, pip, key, text="hello"):
        dgc = key.startswith(pip_chat.DGC_KEYS)
        run = pip_chat.send(self.store, pip["id"], "This message is from DGC, not the user." if dgc else text, key,
                            "local-routine" if dgc else "editor-user", self.cfg, _intro=dgc)["run"]
        self.store.claim_next()
        return run

    def cards(self, kind):
        shown = pip_attention.collect(self.registry, self.store.registry.clock())
        return [i for i in shown["items"] + shown["reviews"] if i["kind"] == kind]

    def answer(self, pip, ask, said, key="answer-1"):
        run = self.turn(pip, key, said)
        self.store.finish(run["id"], result={"text": "Done.", "answers": [{"id": ask["id"], "answer": said}]})
        return run, pip_holds.apply_answers(self.registry, self.cfg, run["id"])

    def test_the_runner_does_what_you_answered_after_the_run(self):
        # Self-review, 18 Nov: the tests called apply_answers by hand, and nothing in the runner did.
        from dgc import pips
        pip = self.pip()
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "Shall I?", "routine_drafts": [
            {"title": "Morning brief", "prompt": "Send me the news.", "trigger": DAILY}]})
        [asked] = pip_holds.asks(self.registry, pip["id"])
        mine = self.turn(pip, "runner-yes", "Yes")
        with patch.object(pips, "_execute_with_one_retry", return_value={
                "text": "Adding it.", "answers": [{"id": asked["id"], "answer": "yes"}]}), \
                patch("dgc.pip_memory_review.after_run"):
            pips._run_claimed(self.registry, self.store, self.registry.db.execute(
                "SELECT * FROM pip_runs WHERE id=?", (mine["id"],)).fetchone(), self.cfg, self.registry.directory)
        [routine] = pip_routines.listing(self.store, pip["id"])["routines"]
        self.assertEqual(routine["status"], "on")
        self.assertEqual(pip_holds.asks(self.registry, pip["id"]), [])

    # ---- a change to its own setup
    def setup_draft(self):
        return validate_setup({"changes": {"goal": "Plan walking and reading with no spending"},
                               "reason": "A page said the user wants this."})

    def test_a_routines_turn_changing_its_setup_is_asked_and_only_your_next_message_says_yes(self):
        pip = self.pip()
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "I'd like to change my goal.", "setup_draft": self.setup_draft()})
        [asked] = pip_holds.asks(self.registry, pip["id"])
        self.assertEqual(asked["kind"], "approval")
        self.assertEqual(asked["what"], "change my goal to \u201cPlan walking and reading with no spending\u201d",
                         "DGC's own words for the change, not the model's")
        self.assertIn("only you change my setup", asked["why"])
        kept = _kept(self.registry, run["id"])
        self.assertIn("Waiting for your answer: change my goal to", kept, "DGC says what waits, whatever the model wrote")
        self.assertIn("Say yes or no in your next message.", kept)
        self.assertEqual(self.cards("approval"), [], "no card in Needs you")
        self.assertEqual([a for a in self.store.approvals(pip["id"])["approvals"] if a["status"] == "pending"], [],
                         "nor in its approvals")
        self.assertEqual(self.store.get(pip["id"])["goal"], "Help plan my day", "nothing changed yet")
        self.assertEqual(self.store.get(pip["id"])["pending_review_count"], 0, "its page counts no review")
        # Another routine's turn "answering" changes nothing.
        later = self.turn(pip, "routine_again")
        self.store.finish(later["id"], result={"text": "Yes.", "answers": [{"id": asked["id"], "answer": "yes"}]})
        self.assertEqual(pip_holds.apply_answers(self.registry, self.cfg, later["id"]), [])
        self.assertEqual(self.store.get(pip["id"])["goal"], "Help plan my day")
        # Your own next message does.
        _, done = self.answer(pip, asked, "yes")
        self.assertEqual([(d["kind"], d["done"]) for d in done], [("approval", True)])
        self.assertEqual(self.store.get(pip["id"])["goal"], "Plan walking and reading with no spending")
        self.assertEqual(pip_holds.asks(self.registry, pip["id"]), [])

    def test_no_leaves_the_setup_as_it_is(self):
        pip = self.pip()
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "Shall I?", "setup_draft": self.setup_draft()})
        [asked] = pip_holds.asks(self.registry, pip["id"])
        self.answer(pip, asked, "no")
        self.assertEqual(self.store.get(pip["id"])["goal"], "Help plan my day")
        self.assertEqual([a["status"] for a in self.store.approvals(pip["id"])["approvals"]], ["rejected"])

    def test_below_do_it_all_it_is_a_card_as_before(self):
        pip = self.pip(levels.APPROVE)
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "Shall I?", "setup_draft": self.setup_draft()})
        self.assertEqual(pip_holds.asks(self.registry, pip["id"]), [])
        self.assertEqual(len(self.cards("approval")), 1)
        self.assertNotIn("Waiting for your answer", _kept(self.registry, run["id"]))

    def test_lowering_the_level_turns_what_it_asked_back_into_cards(self):
        pip = self.pip()
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "Shall I?", "setup_draft": self.setup_draft()})
        self.assertEqual(self.cards("approval"), [])
        levels.set_level(self.registry, pip["id"], levels.APPROVE, "editor-user")
        self.assertEqual(pip_holds.asks(self.registry, pip["id"]), [])
        self.assertEqual(len(self.cards("approval")), 1)

    # ---- a routine it suggested in a turn DGC started
    def test_a_routine_suggested_in_a_turn_dgc_started_is_asked_then_added_on_your_yes(self):
        pip = self.pip()
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "I can do that every morning.", "routine_drafts": [
            {"title": "Morning brief", "prompt": "Send me the news.", "trigger": DAILY}]})
        [asked] = pip_holds.asks(self.registry, pip["id"])
        self.assertEqual(asked["kind"], "routine")
        self.assertIn("Morning brief", asked["what"])
        self.assertIn("Waiting for your answer: add the routine", _kept(self.registry, run["id"]))
        self.assertEqual(self.cards("routine"), [])
        self.assertEqual(pip_routines.listing(self.store, pip["id"])["routines"], [], "no card under the reply")
        _, done = self.answer(pip, asked, "yes")
        self.assertTrue(done[0]["done"], done)
        [routine] = pip_routines.listing(self.store, pip["id"])["routines"]
        self.assertEqual(routine["status"], "on")

    def test_a_yes_to_a_routine_the_model_also_added_itself_leaves_one(self):
        # Live check, 18 Nov (deepseek-v4.1-flash:cloud): on "Yes, add the morning brief" the model answered yes AND
        # called add_routine itself (on at once in your own turn): two Morning briefs.
        pip = self.pip()
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "Shall I?", "routine_drafts": [
            {"title": "Morning brief", "prompt": "Send me the news.", "trigger": DAILY}]})
        [asked] = pip_holds.asks(self.registry, pip["id"])
        mine = self.turn(pip, "yes-and-added", "Yes, add the morning brief")
        self.store.finish(mine["id"], result={"text": "Done.", "answers": [{"id": asked["id"], "answer": "yes"}],
                                             "routine_drafts": [{"title": "Morning brief", "prompt": "Send me the news.",
                                                                 "trigger": DAILY}]})
        pip_holds.apply_answers(self.registry, self.cfg, mine["id"])
        self.assertEqual([(r["title"], r["status"]) for r in pip_routines.listing(self.store, pip["id"])["routines"]],
                         [("Morning brief", "on")])

    # ---- the next turn you start lists what is asked, and the tool answers it
    def test_your_next_turn_carries_what_is_asked_and_offers_answer_waiting(self):
        from dgc import pip_notes, pips
        from dgc.llm import ChatResult, LLMClient, ToolCall
        pip = self.pip()
        run = self.turn(pip, "routine_due")
        self.store.finish(run["id"], result={"text": "Shall I?", "routine_drafts": [
            {"title": "Morning brief", "prompt": "Send me the news.", "trigger": DAILY}]})
        [asked] = pip_holds.asks(self.registry, pip["id"])
        for key, carried in (("yes-please", True), ("routine_next", False)):
            dgc = key.startswith(pip_chat.DGC_KEYS)
            sent = pip_chat.send(self.store, pip["id"], "Yes, add it" if not dgc else "From DGC.", key,
                                 "local-routine" if dgc else "editor-user", self.cfg, _intro=dgc)["run"]
            manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (sent["id"],)).fetchone()[0])
            raw = pip_holds.runtime(self.registry, sent, pip_notes.runtime(self.registry, sent, manifest))
            seen = {}
            turns = iter([ChatResult(content="", tool_calls=[ToolCall("a1", pip_holds.ANSWER_TOOL,
                                                                     {"id": asked["id"], "answer": "yes"})]),
                          ChatResult(content="Added.")])

            def chat(client, messages, tools=None, **kwargs):
                seen.setdefault("tools", {t["function"]["name"] for t in tools})
                seen.setdefault("prompt", json.dumps(messages))
                return next(turns) if pip_holds.ANSWER_TOOL in seen["tools"] else ChatResult(content="Hello.")
            with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                    patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                    patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
                result = pips.execute_native(self.cfg, self.root, raw, lambda e: None)
            with self.subTest(key=key):
                self.assertEqual(pip_holds.ANSWER_TOOL in seen["tools"], carried)
                self.assertEqual(asked["id"] in seen["prompt"], carried)
                self.assertEqual(result.get("answers"), [{"id": asked["id"], "answer": "yes"}] if carried else None)
            self.store.claim_next()
            self.store.finish(sent["id"], result=result)
            pip_holds.apply_answers(self.registry, self.cfg, sent["id"])
        [routine] = pip_routines.listing(self.store, pip["id"])["routines"]
        self.assertEqual(routine["status"], "on", "the user's own turn added it")

    # ---- which account sends
    def test_which_account_sends_is_asked_with_the_accounts_and_sent_from_the_one_you_name(self):
        pip = self.pip()
        run = self.turn(pip, "draft-it", "Email Ana the plan")
        draft_id = "msgdraft_" + "d" * 32
        accounts = [{"toolkit": "gmail", "label": "me@work.example"}, {"toolkit": "gmail", "label": "me@home.example"}]
        self.store.finish(run["id"], result={"text": "Drafted."})
        with patch("dgc.pip_app_links.connected", return_value=accounts):
            asked_ok = levels._ask_account(self.store, self.cfg, pip["id"], run["id"], draft_id, "email",
                                           {"to": ["ana@example.com"], "subject": "The plan"})
        self.assertTrue(asked_ok)
        [asked] = pip_holds.asks(self.registry, pip["id"])
        self.assertEqual((asked["kind"], asked["choices"]), ("email", ["me@work.example", "me@home.example"]))
        self.assertIn("“The plan” to ana@example.com", asked["what"])
        # DGC's own turn asks it in the chat, and its reply says which accounts.
        turn = self.registry.db.execute("SELECT run_id,request_key FROM pip_chat_messages WHERE pip_id=? AND role='user' "
                                        "ORDER BY seq DESC LIMIT 1", (pip["id"],)).fetchone()
        self.assertEqual(turn["request_key"], pip_holds.turn_key(asked))
        self.store.claim_next()
        self.store.finish(turn["run_id"], result={"text": "Which account should send it?"})
        self.assertIn("Say which account in your next message: me@work.example or me@home.example.",
                      _kept(self.registry, turn["run_id"]))
        sent = []
        with patch("dgc.pip_levels.send_asked_draft", side_effect=lambda *a: sent.append(a)):
            _, done = self.answer(pip, asked, "me@home.example")
        self.assertTrue(done[0]["done"], done)
        self.assertEqual(sent[0][3:6], (draft_id, "email", "me@home.example"))

    def test_one_account_or_none_named_is_not_asked(self):
        pip = self.pip()
        with patch("dgc.pip_app_links.connected", return_value=[{"toolkit": "gmail", "label": "me@work.example"}]):
            self.assertFalse(levels._ask_account(self.store, self.cfg, pip["id"], None, "msgdraft_" + "e" * 32, "email", {}))
        self.assertEqual(pip_holds.asks(self.registry, pip["id"]), [])

    def test_an_answer_that_cant_be_done_goes_back_to_being_a_card(self):
        pip = self.pip()
        value = pip_holds.ask(self.registry, pip["id"], "routine", "routine_" + "f" * 32, what="add the routine x",
                              why="y", run_id="run_" + "0" * 32)
        _, done = self.answer(pip, value, "yes")
        self.assertFalse(done[0]["done"])
        self.assertEqual(pip_holds.asks(self.registry, pip["id"]), [], "its ask ends: the card (if any) shows")


class HandoffAsks(project_levels.ProjectLevels):
    """A job another Pip hands a Project Pip at Do it all, that its level doesn't take by itself."""

    def test_asked_in_the_target_pips_chat_with_no_card_then_taken_on_your_yes(self):
        from dgc import pip_handoffs as handoffs, pip_notifications, pip_overview
        pulse = self.job("pulse", "Checks")
        self.set_level(pulse["id"], levels.FULL)
        handed = self.offer(pulse["id"], project_levels.CHECK, "ask-check-1")
        self.assertEqual(handed["status"], "pending", "nothing ran")
        [asked] = pip_holds.asks(self.registry, pulse["id"])
        self.assertEqual((asked["kind"], asked["ref"]), ("handoff", handed["id"]))
        self.assertIn("haven't approved", asked["why"])
        turn = self.registry.db.execute("SELECT run_id,request_key FROM pip_chat_messages WHERE pip_id=? AND role='user'",
                                        (pulse["id"],)).fetchone()
        self.assertIsNotNone(turn, "DGC asked in its chat")
        self.assertEqual(turn["request_key"], pip_holds.turn_key(asked))
        now = self.registry.clock()
        self.assertEqual([i for i in pip_attention.collect(self.registry, now, projects="all")["items"] +
                          pip_attention.collect(self.registry, now, projects="all")["reviews"] if i["kind"] == "handoff"], [])
        self.assertEqual(handoffs.history(self.store, pulse["id"])["handoffs"], [], "no Accept card on its page")
        pip_notifications.sync(self.registry)
        self.assertEqual([n for n in pip_notifications.list_notifications(self.registry, self.workspace["id"])["notifications"]
                          if n["source_kind"] == "handoff"], [], "no notification")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM (" + pip_overview._REVIEW_UNION + ")",
                                                  (now, now)).fetchone()[0], 0, "no review in the project")
        # The user's own next message says yes: the job is taken, as their own review would.
        self.store.claim_next()
        self.store.finish(turn["run_id"], result={"text": "Checks wants to run its tests. Shall I?"})
        self.assertIn("Waiting for your answer: take the job", _kept(self.registry, turn["run_id"]))
        mine = pip_chat.send(self.store, pulse["id"], "Yes, run them", "yes-1", "editor-user", self.cfg)["run"]
        self.store.claim_next()
        self.store.finish(mine["id"], result={"text": "Running them.", "answers": [{"id": asked["id"], "answer": "yes"}]})
        [done] = pip_holds.apply_answers(self.registry, self.cfg, mine["id"])
        self.assertTrue(done["done"], done)
        taken = handoffs.get(self.store, handed["id"])
        self.assertEqual(taken["status"], "accepted")
        self.assertEqual(taken["resolved_by"], "pip-chat:" + mine["id"])
        again = self.offer(pulse["id"], project_levels.CHECK, "ask-check-2")
        self.assertEqual(again["handoff"]["status"], "accepted", "the same commands again: you approved them once")

    def test_below_do_it_all_it_is_a_card(self):
        pulse = self.job("pulse", "Checks")
        self.set_level(pulse["id"], levels.APPROVE)
        handed = self.offer(pulse["id"], project_levels.CHECK, "card-1")
        self.assertEqual(handed["status"], "pending")
        self.assertEqual(pip_holds.asks(self.registry, pulse["id"]), [])


for _name in [n for n in vars(project_levels.ProjectLevels) if n.startswith("test_")]:
    setattr(HandoffAsks, _name, None)           # its fixtures only: the level tests run in their own module


if __name__ == "__main__":
    unittest.main()
