"""The founder's three real asks (2026-10-20): "pay these medical bills", "design me my birthday shirts and order 20 of
them in large size", "help me stay on top of my office email". What the end-to-end test found, kept fixed:

- A Pip with a computer is told it may pay and order (each held for the user's Allow) and can type card details; only
  a Pip without one is told it cannot buy or pay. Told both, it read three bills right, then said "I can't make
  payments", and on the pay pages "card fields are yours to fill".
- A Reject tells the Pip, once, so it says what wasn't done and goes on with the rest (the next bill). Told nothing,
  it sat silent after the first Reject.
- An email draft never leaves a blank such as "[SIGN OFF / HOLD - your call]" for Send to mail as written.
- "Catch my mails" is a routine on new mail, not a daily schedule.
"""
import json
import os
import types
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_computer, pip_message_drafts, pip_routines, pips
from tests import test_pips_local as fixtures
from tests.test_pip_eyes import catalog_setup


class Instructions(unittest.TestCase):
    setUp = catalog_setup

    def turn(self, replies, *, computer=True, text="pay these medical bills"):
        from dgc.llm import ChatResult, LLMClient, ToolCall
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "model", "model": "deepseek-v4.1-flash:cloud"},
                                computer_plan={"schema_version": 1} if computer else None)
        run = pip_chat.send(self.store, pip["id"], text, "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        if computer:
            socket = pip_computer.RunSocket(types.SimpleNamespace(act=lambda op, args: {"text": "page text"}), "run_" + "d" * 32)
            self.addCleanup(socket.close)
            manifest = {**manifest, "computer_socket": socket.pin(), "computer_eyes": {"choice": "ask", "vision_model": None,
                                                                                       "convention": "pixels"}}
        seen, queue = [], list(replies)

        def chat(client, messages, tools=None, **kwargs):
            seen.append({"messages": json.loads(json.dumps(messages, default=str)), "tools": tools})
            step = queue.pop(0)
            if isinstance(step, tuple):
                return ChatResult(content="", tool_calls=[ToolCall(id=f"call_{len(seen)}", name=step[0], arguments=step[1])])
            return ChatResult(content=step)
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.vision.has_vision", return_value=True), \
                patch.object(LLMClient, "vision_supported", new=property(lambda self: True)), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, self.root, manifest, lambda e: None)
        return result, seen

    def system(self, seen):
        return "\n".join(m["content"] for m in seen[0]["messages"] if m["role"] == "system" and isinstance(m["content"], str))

    def test_a_pip_with_a_computer_may_pay_and_order_and_one_without_still_cannot(self):
        _, seen = self.turn(["On it."])
        said = self.system(seen)
        self.assertNotIn("You cannot book, buy, pay", said, "a Pip with a computer pays and orders, each held for the Allow")
        self.assertIn("never answer with what you can't do", said)
        self.assertIn("choose a good site yourself", said)
        self.assertIn("You can type card details into a payment form", said)
        self.assertIn("with no card yet, ask for it before you press Pay, never after", said)
        self.assertIn("all of it in one short message that names each thing", said)
        self.assertIn("you can still type into them by their ref", said, "its eyes don't see card fields; its hands can type them")
        _, seen = self.turn(["I can't pay it for you."], computer=False)
        said = self.system(seen)
        self.assertIn("You cannot book, buy, pay, reserve or sign up for anything.", said, "without a computer it really can't")
        self.assertNotIn("never answer with what you can't do", said)

    def test_an_email_draft_that_leaves_a_blank_for_the_user_is_not_made(self):
        blank = {"recipient_email": "priya.sharma@northwind.example", "subject": "Re: Q3 vendor invoice reconciliation",
                 "body": "Hi Priya,\n\nOn the three Bluedart invoices, here's my call: [SIGN OFF / HOLD - your call].\n\nThanks,\nArjun"}
        result, seen = self.turn([("draft_email", blank), "Sign off or hold the three invoices?"], text=(
            "help me with my office email. Reply to priya.sharma@northwind.example about the invoices"))
        answer = next(m["content"] for m in seen[1]["messages"] if m["role"] == "tool")
        self.assertIn("Not drafted", answer)
        self.assertIn("[SIGN OFF / HOLD - your call]", answer)
        self.assertNotIn("message_draft", result, "nothing waits under Send with a blank in it")
        self.assertIn("never leave a placeholder", pip_message_drafts.NOTICE)
        whole = {**blank, "body": "Hi Priya,\n\nPlease hold those three Bluedart invoices until I've checked them.\n\nThanks,\nArjun"}
        result, _ = self.turn([("draft_email", whole), "Drafted."], text=(
            "help me with my office email. Reply to priya.sharma@northwind.example about the invoices"))
        self.assertEqual(result["message_draft"]["body"], whole["body"])

    def test_a_blank_is_a_blank_and_a_mail_systems_tag_is_not(self):
        for body in ("my call: [SIGN OFF / HOLD - your call].", "See you at [time].", "Dear [Your name],", "Use <insert date>.",
                     "Total: [AMOUNT]", "{decision}"):
            self.assertIsNotNone(pip_message_drafts.placeholder({"subject": "Re: hi", "body": body}), body)
        for body in ("See ref [1].", "Totals for [Q3] look fine.", "Moved to 3pm [as discussed].", "Link [here].", "OK [FY]"):
            self.assertIsNone(pip_message_drafts.placeholder({"subject": "Re: hi", "body": body}), body)
        self.assertIsNone(pip_message_drafts.placeholder({"subject": "Re: [EXTERNAL] Q3 invoices", "body": "Done."}))
        self.assertIsNotNone(pip_message_drafts.placeholder({"subject": "Call on [date]", "body": "Done."}))

    def test_catching_mail_is_a_routine_on_new_mail(self):
        said = pip_routines.schema()["function"]["description"]
        self.assertIn("use kind 'email' with a search for those mails, not a daily schedule", said)


class MainChat(unittest.TestCase):
    """"Make me a Pip that pays my bills for me" got a card recommending a read-only Gmail bill tracker ("No payments
    are ever made"): the main chat didn't know a Personal Pip's computer pays and orders on the user's Allow."""
    def setUp(self):
        from tests.test_pips_tool_loading import PipsToolLoadingTests
        PipsToolLoadingTests.setUp(self)

    def test_the_main_chat_knows_a_personal_pip_can_pay_and_order_on_the_users_allow(self):
        from dgc.llm import ToolCall
        self.agent._handle_call(ToolCall(id="c1", name="use_pips", arguments={}))
        said = self.agent.system_prompt()
        self.assertIn("so it can pay a bill, buy, order or book on a website for the user", said)
        self.assertIn("every payment, order or form it submits waits for the user's Allow", said)
        self.assertIn("never steer the user to a read-only tracker, a payment connector or Composio for that", said)


class RejectFollowUp(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)

    def held(self, *, kind=None, payment=False, text="pay these medical bills"):
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "default"}, computer_plan={"schema_version": 1})
        run = pip_chat.send(self.store, pip["id"], text, "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        self.assertEqual(self.store.claim_next()["id"], run["id"])
        self.store.finish(run["id"], result={"text": "Bill 1 of 3 is ready to pay: ₹5,350.00. It waits for your Allow below."})
        summary = ({"method": "GET", "host": "pay.cityscanlabs.example", "path": "/", "fields": [], "site": "cityscanlabs.example",
                    "shown": "pay.cityscanlabs.example", "kind": kind} if kind else
                   {"method": "POST", "host": "pay.sunrisehospital.example", "path": "/api/pay",
                    "fields": [{"name": "amount", "value": "5350.00"}], **({"payment": True} if payment else {})})
        action_id = "compact_" + os.urandom(16).hex()
        now = pip_computer._now()
        with self.registry.transaction():
            self.registry.db.execute("INSERT INTO pip_computer_actions VALUES(?,?,?,?,?,?,?,?,?,'pending',?,?,NULL,NULL,NULL)",
                                     (action_id, pip["id"], pip["workspace_id"], run["id"], "host_x",
                                      (pip_computer.CAREFUL_REF + action_id) if kind else "req_1", json.dumps(summary),
                                      pip_computer._digest(summary), None, now, "2999-01-01T00:00:00.000Z"))
        return pip, run, action_id, pip_computer._digest(summary)

    def follow_ups(self, pip):
        return [m for m in pip_chat.list_messages(self.store, pip["id"])["messages"] if m["role"] == "user" and m.get("intro")]

    def test_a_rejected_payment_tells_the_pip_once_and_it_carries_on_with_the_rest(self):
        pip, run, action_id, digest = self.held(payment=True)
        pip_computer.decide(self.registry, action_id, digest, False, "editor-user")
        pip_computer.tick(self.registry, self.cfg)
        [told] = self.follow_ups(pip)
        self.assertIn("The user chose Reject, so DGC dropped what your computer was holding, unsent: a payment: "
                      "POST to pay.sunrisehospital.example/api/pay", told["text"])
        self.assertIn("A Reject is about that one thing only", told["text"])
        self.assertIn("go on with the next one now, without asking whether to", told["text"])
        [row] = [a for a in pip_computer.list_actions(self.registry, pip["id"]) if a["id"] == action_id]
        self.assertEqual((row["status"], row["continuation_run_id"]), ("rejected", told["run_id"]))
        self.store.cancel(told["run_id"], "local-console")
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(len(self.follow_ups(pip)), 1, "told once")

    def test_a_site_the_user_did_not_allow_is_said_so(self):
        pip, run, action_id, digest = self.held(kind="site")
        pip_computer.decide(self.registry, action_id, digest, False, "editor-user")
        pip_computer.tick(self.registry, self.cfg)
        [told] = self.follow_ups(pip)
        self.assertIn("The user didn't allow you to visit cityscanlabs.example, so you must not.", told["text"])

    def test_no_follow_up_once_the_user_has_written_or_for_a_stale_reject(self):
        pip, run, action_id, digest = self.held(payment=True)
        pip_computer.decide(self.registry, action_id, digest, False, "editor-user")
        later = pip_chat.send(self.store, pip["id"], "skip that one", "k-later", "editor-user", self.cfg)["run"]
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(self.follow_ups(pip), [], "the user's own message answers it")
        self.store.cancel(later["id"], "local-console")
        pip2, _, action2, digest2 = self.held(payment=True)
        pip_computer.decide(self.registry, action2, digest2, False, "editor-user")
        with patch.object(pip_computer, "REJECT_FOLLOW_SECONDS", -1):
            pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(self.follow_ups(pip2), [], "a Reject from long ago wakes nothing")

    def test_the_turn_after_an_allow_sees_the_photos_of_the_ask(self):
        from tests.test_pip_eyes import JPEG
        import base64
        photo = "data:image/jpeg;base64," + base64.b64encode(JPEG).decode()
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "default"}, computer_plan={"schema_version": 1})
        first = pip_chat.send(self.store, pip["id"], "pay these medical bills", "k1", "editor-user", self.cfg, images=[photo])["run"]
        sent = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (first["id"],)).fetchone()[0])
        self.store.claim_next(); self.store.finish(first["id"], result={"text": "Opening the hospital's site."})

        def carry_on(n):
            run = pip_chat.continue_after_computer(self.store, pip["id"], f"compact_{n:032x}", {"kind": "site", "site": "x.example"},
                                                   self.cfg)["run"]
            manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
            self.store.claim_next(); self.store.finish(run["id"], result={"text": "Done."})
            return manifest["conversation"].get("images")
        self.assertEqual(carry_on(1), sent["conversation"]["images"], "the bills it was paying come with the turn after Allow")
        self.assertEqual(len(self.store.db.execute("SELECT * FROM pip_chat_images").fetchall()), 1, "kept once, not again")
        later = pip_chat.send(self.store, pip["id"], "thanks, now just tell me the total", "k2", "editor-user", self.cfg)["run"]
        self.store.claim_next(); self.store.finish(later["id"], result={"text": "₹12,895."})
        self.assertIsNone(carry_on(2), "a newer ask of the user's without photos brings none")

    def test_a_reply_that_left_a_hold_has_no_choices_of_its_own(self):
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "default"}, computer_plan={"schema_version": 1})

        def reply(held_status):
            run = pip_chat.send(self.store, pip["id"], "pay these medical bills", "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
            self.store.claim_next()
            action_id = "compact_" + os.urandom(16).hex()
            summary = {"method": "GET", "host": "pay.sunrisehospital.example", "path": "/", "fields": [], "kind": "site",
                       "site": "sunrisehospital.example", "shown": "pay.sunrisehospital.example"}
            with self.registry.transaction():
                self.registry.db.execute("INSERT INTO pip_computer_actions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL,NULL)",
                                         (action_id, pip["id"], pip["workspace_id"], run["id"], "host_x", pip_computer.CAREFUL_REF + action_id,
                                          json.dumps(summary), pip_computer._digest(summary), None, held_status, pip_computer._now(),
                                          "2999-01-01T00:00:00.000Z"))
            self.store.finish(run["id"], result={"text": "I need your OK to open the hospital's site.",
                                                 "choices": ["Allow the site, go ahead", "Hold off for now"],
                                                 "computer": {"calls": 2, "held": [action_id]}})
            return pip_chat.list_messages(self.store, pip["id"])["messages"][-1]
        self.assertNotIn("choices", reply("pending"), "the hold's own card is the one decision")
        self.assertEqual(reply("approved")["choices"], ["Allow the site, go ahead", "Hold off for now"],
                         "nothing waits (an Always allow sent it): its choices stay")

    def test_a_held_submit_tells_the_pip_its_card_is_below(self):
        host = types.SimpleNamespace(_kind=lambda action_id: "")
        said = pip_computer.Host._held_text(host, ["compact_" + "a" * 32])
        self.assertIn("DGC shows it to them as a card below your reply, with what it sends, Review… and Reject. It is there.", said)

    def test_a_held_site_is_named_to_the_pip(self):
        made = []
        host = types.SimpleNamespace(browser=types.SimpleNamespace(current_url="about:blank"), sites=set(),
                                     taint=types.SimpleNamespace(carried=lambda *a: []), said="",
                                     _careful_hold=lambda kind, summary, *a: made.append(summary))
        said = pip_computer.Host._careful(host, "open", {"url": "https://www.printful.com/custom/mens/t-shirts"})
        self.assertEqual(made[0]["site"], "printful.com")
        self.assertIn("Held: printful.com is new for this user", said)
        self.assertIn("tell the user in one sentence that you want to open printful.com", said)
        self.assertIn("DGC shows them an Allow card for printful.com below your reply: it is there", said)

    def test_an_approved_submit_still_continues_as_before(self):
        pip, run, action_id, digest = self.held(kind="site")
        pip_computer.decide(self.registry, action_id, digest, True, "editor-user")
        pip_computer.tick(self.registry, self.cfg)
        [told] = self.follow_ups(pip)
        self.assertIn("The user allowed you to visit cityscanlabs.example", told["text"])


if __name__ == "__main__":
    unittest.main()
