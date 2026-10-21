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
        self.assertIn("all of it in one short message that names each thing", said)
        # Cards follow the password rule (2026-10-20): the user types the card on its screen and presses Pay.
        self.assertIn("Card numbers, expiry dates and security codes are like passwords: never ask for them, never type "
                      "them, and never press Pay on an empty card form.", said)
        self.assertIn(pip_computer.CARD_ON_SCREEN, said)
        self.assertEqual(pip_computer.CARD_ON_SCREEN, "Everything's filled in on my screen. Open my computer (the screen "
                         "button at the top of this chat), type your card into the payment form, and press Pay.")
        # Saved logins (API 56): a code is a secret like a password; a sign-in is DGC's to type (sign_in).
        self.assertIn("You never see or type passwords, one-time codes or payment card details", said)
        self.assertIn("use sign_in on its sign-in page", said)
        self.assertIn("the user types those on your screen", said)
        for old in ("You can type card details into a payment form", "ask for it before you press Pay",
                    "you can still type into them by their ref"):
            self.assertNotIn(old, said, "the old flow asked for the card in chat")
        # "I can't tell you a card is waiting below. Should I press Pay again?" -- above the held payment's card.
        self.assertIn("DGC shows it as a card below your reply, so never say there is no card or offer to press it again", said)
        # "I can't put an Allow card here myself -- that permission has to come from DGC's side" (2026-10-20).
        self.assertIn("DGC also shows its own cards there, without you making them: a new site to allow, and anything your "
                      "computer holds.", said)
        self.assertNotIn("Never say a card is there unless", said)
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


class CardsStayOutOfTheChat(unittest.TestCase):
    """A card number typed in a Pip's chat was kept in its history and sent to a cloud model. DGC refuses it before
    anything of the message is stored; bill, UHID, phone and account numbers still go through."""
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)

    def test_an_address_pin_code_is_not_a_secret(self):
        from dgc.pip_computer_box import SECRET_FIELD
        for name in ("pin code", "pin-code", "pincode", "pin_code", "postal_code"):
            self.assertIsNone(SECRET_FIELD.search(name), name)
        for name in ("pin", "card_pin", "atm-pin", "password", "card_number", "cvv"):
            self.assertIsNotNone(SECRET_FIELD.search(name), name)
        from dgc import pip_computer_box
        js = pip_computer_box._SECRET_BOXES_JS
        self.assertIn("if (auto.includes('postal-code') || /pin.?code|postal|zip/i.test(words)) return false;", js)

    def test_card_numbers_and_the_numbers_on_a_bill(self):
        from dgc.cards import card_number
        for text, digits in (("Use my card 4242 4242 4242 4242, expiry 12/34, CVV 123", "4242424242424242"),
                             ("5555-5555-5555-4444", "5555555555554444"), ("amex 378282246310005", "378282246310005"),
                             ("card 5555-5555-5555-4444 12/34", "5555555555554444"),
                             ("card 6011111111111117", "6011111111111117"), ("jcb 3530111333300000", "3530111333300000")):
            self.assertEqual(card_number(text), digits, text)
        for text in ("Bill No. SMH/OP/26/118734, UHID SMH0048213, ₹5,350.00", "Invoice CSD-INV-77391, patient ID CS-220914",
                     "GSTIN 27AAKCS1234F1Z9", "call me on +91 98000 00000 or 020-4100 2200", "Aadhaar 2345 6789 0123",
                     "HDFC account 50100123456789", "4242 4242 4242 4241", "order 1234567890123456",
                     "PNR 4521 8833 90, ticket 0987654321098", "DL No. MH-PZ3-118204"):
            self.assertIsNone(card_number(text), text)

    def test_a_message_with_a_card_is_refused_and_nothing_is_kept(self):
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "default"}, computer_plan={"schema_version": 1})
        from dgc.workspace_registry import RegistryError
        with self.assertRaises(RegistryError) as refused:
            pip_chat.send(self.store, pip["id"], "Use my card 4242 4242 4242 4242, expiry 12/34, CVV 123", "k1",
                          "editor-user", self.cfg)
        self.assertEqual(refused.exception.code, "card_in_chat")
        self.assertEqual(str(refused.exception), "Card numbers stay out of the chat. Type it on Bill Payer's screen instead: "
                                                 "open its computer.")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_chat_messages").fetchone()[0], 0, "not kept")
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_runs").fetchone()[0], 0, "never reaches a model")
        # The SDKs' and editors' request goes through the same send: refused there too.
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            answer = pips.handle_control(self.cfg, {"type": "send_pip_message", "request_id": "r", "pip_id": pip["id"],
                                                    "text": "card 5555-5555-5555-4444 12/34", "idempotency_key": "k2"},
                                         "editor-user", start_worker=False)
        self.assertFalse(answer["ok"])
        self.assertEqual(answer["error"]["code"], "card_in_chat")
        ok = pip_chat.send(self.store, pip["id"], "Bill SMH/OP/26/118734, UHID SMH0048213, call 98000 00000", "k3",
                           "editor-user", self.cfg)
        self.assertEqual(ok["message"]["text"], "Bill SMH/OP/26/118734, UHID SMH0048213, call 98000 00000")


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
        # "A Pip that looks after my office email" brought two raw Composio tool permissions and a failed app plan.
        self.assertIn("it asks to connect the app itself, with a Connect card in its own chat", said)
        self.assertIn("Never call the user's Composio or other connector tools yourself to set a Pip up", said)


class RejectFollowUp(unittest.TestCase):
    def setUp(self):
        fixtures.LocalPipsTests.setUp(self)

    def held(self, *, kind=None, payment=False, text="pay these medical bills"):
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "default"}, computer_plan={"schema_version": 1})
        run = pip_chat.send(self.store, pip["id"], text, "k-" + os.urandom(3).hex(), "editor-user", self.cfg)["run"]
        self.assertEqual(self.store.claim_next()["id"], run["id"])
        self.store.finish(run["id"], result={"text": "Bill 1 of 3 is ready to pay: ₹5,350.00. It waits for your Allow below."})
        summary = ({"method": "GET", "host": "pay.cityscanlabs.example", "path": "/invoice", "fields": [], "site": "cityscanlabs.example",
                    "shown": "pay.cityscanlabs.example", "kind": kind, "page": "https://pay.cityscanlabs.example/invoice"} if kind else
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
        answer = pip_chat.send(self.store, pip["id"], "The mobile on the bills is 98000 00000", "k2", "editor-user", self.cfg)["run"]
        answered = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (answer["id"],)).fetchone()[0])
        self.assertEqual(answered["conversation"].get("images"), sent["conversation"]["images"],
                         "the user's next message (an answer to what it asked) comes with the bills again")
        self.store.claim_next(); self.store.finish(answer["id"], result={"text": "Paying bill 1."})
        self.assertEqual(carry_on(3), sent["conversation"]["images"], "after the card, the turn after a Reject still sees them")
        later = pip_chat.send(self.store, pip["id"], "thanks, now just tell me the total", "k3", "editor-user", self.cfg)["run"]
        later_manifest = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (later["id"],)).fetchone()[0])
        self.assertIsNone(later_manifest["conversation"].get("images"), "only the message right after the photos")
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

    def test_pay_on_an_empty_card_form_is_dropped_and_the_pip_is_told_to_hand_over(self):
        from dgc.pip_computer_box import card_missing
        form = "application/x-www-form-urlencoded"
        self.assertTrue(card_missing("billno=SMH%2FOP%2F26%2F118734&amount=5350.00&card_number=&card_expiry=&card_cvv=", form))
        self.assertTrue(card_missing("order=%7B%7D&email=a%40b.c&cardnumber=&exp=&cvc=", form))
        self.assertFalse(card_missing("billno=1&card_number=4242+4242+4242+4242&card_cvv=123", form), "a card is in it")
        self.assertFalse(card_missing("name=Ada&password=hunter2", form), "not a payment form")
        pip = self.store.create(self.registry.personal()["id"], "Bill Payer", None, "editor-user", pip_type="lens",
                                model_choice={"mode": "default"}, computer_plan={"schema_version": 1})
        dropped, went_back = [], []
        browser = types.SimpleNamespace(current_url="https://pay.example/pay", held={"req-1": object()},
                                        drop=lambda ref: dropped.append(ref))
        host = types.SimpleNamespace(state_directory=self.registry.directory, pip_id=pip["id"], workspace_id=pip["workspace_id"],
                                     run_id="run_" + "e" * 32, id="host_1", waiting=[], frames_dir=None, frames=0, browser=browser,
                                     _back_from_drop=lambda: went_back.append(True), _frame=lambda label: None)
        host._queued = [types.SimpleNamespace(request_id="req-1", card_missing=True, summary=lambda: {})]
        self.assertEqual(pip_computer.Host._record_held(host), [], "nothing to approve")
        self.assertEqual((dropped, went_back), (["req-1"], [True]))
        self.assertEqual(self.registry.db.execute("SELECT count(*) FROM pip_computer_actions").fetchone()[0], 0)
        told = pip_computer._take_card_note(host)
        self.assertIn("card number is empty, so DGC dropped it", told)
        self.assertIn(pip_computer.CARD_ON_SCREEN, told)
        self.assertIsNone(pip_computer._take_card_note(host), "told once")

    def test_the_users_own_payment_on_its_screen_is_sent_and_the_pip_carries_on(self):
        pip, run, _, _ = self.held(payment=True)
        released = []
        browser = types.SimpleNamespace(current_url="https://pay.example/pay", held={"req-9": object()},
                                        release=lambda ref: released.append(ref))
        summary = {"method": "POST", "host": "pay.sunrisehospital.example", "path": "/api/pay",
                   "fields": [{"name": "amount", "value": "2045.00"}, {"name": "card_number", "value": "•••"}],
                   "more_fields": 0, "body_bytes": 90, "payment": True}
        host = types.SimpleNamespace(state_directory=self.registry.directory, pip_id=pip["id"], workspace_id=pip["workspace_id"],
                                     run_id=None, last_run_id=run["id"], id="host_1", browser=browser,
                                     user_input_at=__import__("time").monotonic(),
                                     _record_held=lambda: self.fail("the user's own Pay is not held"))
        host._queued = [types.SimpleNamespace(request_id="req-9", payment=True, summary=lambda: dict(summary))]
        pip_computer._settle_writes(host)
        self.assertEqual(released, ["req-9"], "typed and pressed by the user: sent, no second Allow")
        [row] = self.registry.db.execute("SELECT * FROM pip_computer_actions WHERE status='sent'").fetchall()
        self.assertEqual((json.loads(row["summary"])["kind"], row["resolved_by"]), ("yours", "editor-user"))
        with self.registry.transaction():         # the earlier pending hold of this fixture is not part of this
            self.registry.db.execute("UPDATE pip_computer_actions SET status='rejected',resolved_at=?,resolved_by='x' "
                                     "WHERE status='pending'", (pip_computer._now(),))
        pip_computer.tick(self.registry, self.cfg)
        [told] = self.follow_ups(pip)
        self.assertIn("The user typed their card on your screen and pressed Pay themselves, and DGC sent it: "
                      "POST to pay.sunrisehospital.example/api/pay (amount 2045.00). That one is paid: never get it ready "
                      "or pay it again.", told["text"], "which one it paid, never a card field")
        self.store.cancel(told["run_id"], "local-console")
        pip_computer.tick(self.registry, self.cfg)
        self.assertEqual(len(self.follow_ups(pip)), 1, "told once")

    def test_an_allowed_site_sends_the_pip_back_to_the_page_it_wanted(self):
        pip, run, action_id, digest = self.held(kind="site")
        pip_computer.decide(self.registry, action_id, digest, True, "editor-user")
        pip_computer.tick(self.registry, self.cfg)
        [told] = self.follow_ups(pip)
        self.assertIn("The user allowed you to visit cityscanlabs.example (open https://pay.cityscanlabs.example/invoice "
                      "again, the page you wanted)", told["text"])


if __name__ == "__main__":
    unittest.main()
