"""A question card in a Pip's chat, as Work has it (Pips API 106, 18 Nov).

The request: "pip asks in chat, but if user says propose me options with your suggestion, then pip can also send the
question or multiple question propose tool, like the work chat does ... so it can instead propose questions which user
can just select and submit".

- The tool is Work's own propose_options: the same schema and the same validator (dgc/questions.py).
- It is offered only in a conversation whose client says it draws the card (send_pip_message `questions: true`); an
  older client keeps offer_choices alone, and DGC's own turns there follow the client that wrote last.
- The worker keeps the card with the reply (`questions`); insert_reply checks it again; the chat lists it with its state.
- answer_pip_questions sends the answers as the user's own next message (a normal turn of theirs), and the card then
  says what was chosen and can't be answered again; Dismiss closes it with nothing sent; a chat that moved on closes it.
"""
import copy
import json
import subprocess
import sys
import unittest
from unittest.mock import patch

from dgc import pip_chat, pip_notes, pip_questions, pips, questions
from dgc.workspace_registry import RegistryError, WorkspaceRegistry
from tests import test_pips_local as fixtures

CARD = [{"header": "Storage", "question": "Which storage backend should settings sync use?", "options": [
            {"label": "SQLite file (Recommended)", "description": "One local file with transactions."},
            {"label": "JSON on disk", "description": "Easy to read by hand."}]},
        {"header": "Extras", "question": "Which extras ship first?", "multi_select": True, "options": [
            {"label": "Conflict prompt", "recommended": True}, {"label": "Sync history"}, {"label": "Export button"}]}]
ASKED = questions.normalize_questions({"questions": CARD})


class TheToolIsWorks(unittest.TestCase):
    def test_the_pips_tool_is_works_propose_options_schema(self):
        from dgc.tools import TOOL_SCHEMAS
        work = next(t for t in TOOL_SCHEMAS if t["function"]["name"] == "propose_options")
        self.assertEqual(pip_questions.schema(), work)
        self.assertIsNot(pip_questions.schema(), work, "a copy: the Pip's list never edits Work's")
        self.assertIn("propose_options", pips.CHAT_UI_TOOLS, "a folder Pip's chat may hold it")

    def test_the_tool_answers_with_works_validator(self):
        kept, said = pip_questions.tool_result({"questions": CARD})
        self.assertEqual(kept, ASKED)
        self.assertIn("card", said)
        kept, said = pip_questions.tool_result({"questions": [{"question": "Pick", "options": ["Only"]}]})
        self.assertIsNone(kept)
        self.assertTrue(said.startswith("error: "))
        self.assertIn(questions.ERR_FEW, said)

    def test_a_kept_list_is_read_back_exactly_or_refused(self):
        self.assertEqual(questions.validate_kept(ASKED), ASKED)
        for shape in ({"question": "Pick a colour", "options": ["Red", "Blue"]},
                      {"questions": [{"id": "one", "header": "Long " * 10, "question": "Q?", "options": ["a", "b", "c (Recommended)"]}]}):
            normalized = questions.normalize_questions(shape)
            self.assertEqual(questions.validate_kept(normalized), normalized)
        bad = []
        for change in (lambda q: q[0].pop("header"), lambda q: q[0].update(id="bad id"), lambda q: q[1].update(id=q[0]["id"]),
                       lambda q: q[0].update(multi_select="yes"), lambda q: q[0]["options"].pop(),
                       lambda q: q[0]["options"][1].update(label=q[0]["options"][0]["label"].upper()),
                       lambda q: q[0]["options"][1].update(recommended=True), lambda q: q[0]["options"][0].update(extra=1),
                       lambda q: q[0].update(question=""), lambda q: q[0]["options"][0].update(description="x" * 401),
                       lambda q: q.extend(copy.deepcopy(q) * 2)):
            value = copy.deepcopy(ASKED)
            change(value)
            bad.append(value)
        bad += [[], "questions", None, [ASKED[0]] * 5]
        for value in bad:
            with self.subTest(value=value):
                self.assertIsNone(questions.validate_kept(value))

    def test_the_answers_read_as_the_users_own_words_one_a_line(self):
        decision = questions.validate_response(ASKED, {"answers": {"q1": {"selected": [0], "other": ""},
                                                                    "q2": {"selected": [0, 2], "other": " and  a\nnote "}}})
        self.assertEqual(questions.answer_words(ASKED, decision),
                         "Which storage backend should settings sync use? SQLite file\n"
                         "Which extras ship first? Conflict prompt, Export button. and a note")
        written = questions.validate_response(ASKED, {"answers": {"q1": {"selected": [], "other": "Postgres, please"}}})
        self.assertEqual(questions.answer_words(ASKED, written),
                         "Which storage backend should settings sync use? Postgres, please\n"
                         'Which extras ship first? Go with your recommendation, "Conflict prompt".')
        plain = questions.normalize_questions({"question": "Pick a colour", "options": ["Red", "Blue"]})
        skipped = questions.validate_response(plain, {"answers": {"q1": {"selected": []}}})
        self.assertEqual(questions.answer_words(plain, skipped), "Pick a colour: Your call: decide and say what you chose.")


class Chat(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit
    create = fixtures.LocalPipsTests.create

    def setup_job(self):
        self.commit()
        self.job = self.create()

    def send(self, text="Propose me options with your suggestion", key="message-1", actor="editor-user", **more):
        return pip_chat.send(self.store, self.job["id"], text, key, actor, self.cfg, **more)

    def raw(self, sent):
        return json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (sent["run"]["id"],)).fetchone()[0])

    def reply(self, sent, result):
        self.store.claim_next()
        return self.store.finish(sent["run"]["id"], result=result)

    def messages(self):
        return pip_chat.list_messages(self.store, self.job["id"])["messages"]

    def control(self, command, actor="editor-user", **fields):
        clock = self.registry.clock
        with patch.object(pips, "WorkspaceRegistry", lambda *a, **k: WorkspaceRegistry(self.registry.directory, clock=clock)):
            response = pips.handle_control(self.cfg, {"type": command, "request_id": "r1", **fields}, actor, start_worker=False)
        if not response.get("ok"):
            raise RegistryError(response["error"]["code"], response["error"]["message"])
        return response["result"]

    def asked(self):
        """A reply that asked with the card, and that reply as the chat lists it."""
        self.setup_job()
        sent = self.send(questions=True)
        self.reply(sent, {"text": "Two things decide this.", "questions": ASKED})
        return sent, self.messages()[-1]


class WhoGetsTheTool(Chat):
    def test_a_client_that_draws_the_card_says_so_and_an_older_one_does_not(self):
        self.setup_job()
        sent = self.send(questions=True)
        self.assertIs(self.raw(sent)["conversation"].get("questions"), True)
        pip_chat.validate_context(self.raw(sent)["conversation"])
        self.reply(sent, {"text": "Fine."})
        # The same message again is the same message: the flag is never part of its retry key.
        self.assertEqual(self.send(questions=True)["message"]["id"], sent["message"]["id"])
        older = self.send(text="And now?", key="message-2")
        self.assertNotIn("questions", self.raw(older)["conversation"], "an older client keeps offer_choices alone")
        self.reply(older, {"text": "Fine."})

    def test_dgcs_own_turns_follow_the_client_that_wrote_last_in_that_conversation(self):
        self.setup_job()
        self.reply(self.send(questions=True), {"text": "Fine."})
        own = pip_chat.send(self.store, self.job["id"], "Carry on.", pip_chat.COMPUTER_KEY + "x1", "editor-user", self.cfg, _intro=True)
        self.assertIs(self.raw(own)["conversation"].get("questions"), True)
        self.reply(own, {"text": "Done."})
        self.reply(self.send(text="Plain", key="message-2"), {"text": "Ok."})
        own = pip_chat.send(self.store, self.job["id"], "Carry on.", pip_chat.COMPUTER_KEY + "x2", "editor-user", self.cfg, _intro=True)
        self.assertNotIn("questions", self.raw(own)["conversation"])

    def test_the_worker_offers_it_only_then_and_keeps_the_card_with_the_reply(self):
        self.commit()
        for key, flagged in (("with", True), ("without", False)):
            with self.subTest(flagged=flagged):
                self.job = self.create()
                sent = self.send(key=key, **({"questions": True} if flagged else {}))
                row = self.store.claim_next()
                fixture = r'''import json
from unittest.mock import patch
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.pips import _worker_main
CARD = CARD_JSON
calls = []
def chat(self, messages, tools=None, on_text=None, **kwargs):
    names = {t["function"]["name"] for t in tools}
    assert "offer_choices" in names, names
    assert ("propose_options" in names) is FLAGGED, names
    heard = "\n".join(str(m.get("content")) for m in messages)
    assert ("you have propose_options, a question card" in heard) is FLAGGED, "the turn hears which way of asking fits"
    calls.append(1)
    if not FLAGGED:
        return ChatResult(content="Shall I go on?", tool_calls=[ToolCall("c1", "offer_choices", {"choices": ["Yes", "No"]})])
    assert len(calls) == 1, "the card ends the reply: no further request"
    return ChatResult(content="Two things decide this.", tool_calls=[ToolCall("c1", "propose_options", {"questions": CARD})])
with patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''.replace("CARD_JSON", repr(CARD)).replace("FLAGGED", str(flagged))
                original = subprocess.Popen

                def launch(argv, *args, **kwargs):
                    if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                        argv = [sys.executable, "-c", fixture]
                    return original(argv, *args, **kwargs)
                with patch.object(pips.subprocess, "Popen", side_effect=launch):
                    result = pips._execute_run(self.registry, row, self.cfg)
                final = self.store.finish(sent["run"]["id"], result=result)
                self.assertEqual(final["status"], "succeeded", final.get("error"))
                last = self.messages()[-1]
                if flagged:
                    self.assertEqual(result["questions"], ASKED)
                    self.assertNotIn("choices", result)
                    self.assertEqual(last["text"], "Two things decide this.")
                    self.assertEqual(last["questions"], {"questions": ASKED, "state": "open", "answers": {}})
                    self.assertNotIn("choices", last)
                else:
                    self.assertNotIn("questions", result)
                    self.assertEqual(last["choices"], ["Yes", "No"])
                    self.assertNotIn("questions", last)

    def test_a_card_with_no_words_before_it_still_saves_the_reply(self):
        self.setup_job()
        sent = self.send(questions=True)
        row = self.store.claim_next()
        fixture = r'''from unittest.mock import patch
from dgc.llm import ChatResult, LLMClient, ToolCall
from dgc.pips import _worker_main
def chat(self, messages, tools=None, on_text=None, **kwargs):
    return ChatResult(content="", tool_calls=[ToolCall("c1", "propose_options", {"question": "Pick a colour", "options": ["Red", "Blue"]})])
with patch.object(LLMClient, "chat", chat), patch("requests.sessions.Session.request", side_effect=AssertionError("No network")):
    raise SystemExit(_worker_main())
'''
        original = subprocess.Popen

        def launch(argv, *args, **kwargs):
            if argv[1:] == ["-m", "dgc.pips", "--worker"]:
                argv = [sys.executable, "-c", fixture]
            return original(argv, *args, **kwargs)
        with patch.object(pips.subprocess, "Popen", side_effect=launch):
            result = pips._execute_run(self.registry, row, self.cfg)
        self.assertEqual(self.store.finish(sent["run"]["id"], result=result)["status"], "succeeded")
        last = self.messages()[-1]
        self.assertEqual(last["text"], "Choose below.")
        self.assertEqual([o["label"] for o in last["questions"]["questions"][0]["options"]], ["Red", "Blue"])


class TheCardIsKept(Chat):
    def test_the_chat_lists_the_card_under_its_reply(self):
        _, last = self.asked()
        self.assertEqual(last["questions"], {"questions": ASKED, "state": "open", "answers": {}})
        user = [m for m in self.messages() if m["role"] == "user"][0]
        self.assertNotIn("questions", user)

    def test_a_reply_with_a_card_that_isnt_works_shape_is_not_saved(self):
        self.commit()
        for key, bad in enumerate(([], [{"question": "Pick", "options": ["a", "b"]}], "Pick one",
                                   [dict(ASKED[0], options=ASKED[0]["options"][:1])])):
            with self.subTest(bad=bad):
                self.job = self.create()         # (a refused reply leaves its run open: each try has its own Pip)
                sent = self.send(key=f"bad-{key}", questions=True)
                self.store.claim_next()
                with self.assertRaises(RegistryError):
                    self.store.finish(sent["run"]["id"], result={"text": "Q.", "questions": bad})

    def test_a_reply_asks_with_buttons_or_a_card_never_both(self):
        self.setup_job()
        sent = self.send(questions=True)
        self.store.claim_next()
        with self.assertRaises(RegistryError):
            self.store.finish(sent["run"]["id"], result={"text": "Q.", "questions": ASKED, "choices": ["Yes", "No"]})


class Answering(Chat):
    def test_submit_sends_the_answers_as_the_users_own_next_message(self):
        sent, reply = self.asked()
        answers = {"q1": {"selected": [1], "other": ""}, "q2": {"selected": [0, 1], "other": ""}}
        done = self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"],
                            idempotency_key="answer-1", answers=answers)
        words = ("Which storage backend should settings sync use? JSON on disk\n"
                 "Which extras ship first? Conflict prompt, Sync history")
        self.assertEqual(done["message"]["text"], words)
        self.assertEqual(done["message"]["role"], "user")
        self.assertEqual(done["questions"]["state"], "answered")
        self.assertEqual(done["questions"]["answers"], answers)
        listed = self.messages()
        self.assertEqual(listed[-1]["id"], done["message"]["id"], "the answer is the chat's next message")
        card = next(m for m in listed if m["id"] == reply["id"])["questions"]
        self.assertEqual((card["state"], card["answers"]), ("answered", answers), "the card says what was chosen")
        # A normal turn of the user's: their own words (what a held step's yes is read from, pip_holds).
        run = self.store.run(done["run"]["id"])
        self.assertEqual(pip_notes.user_turn(self.registry, run), words)
        self.assertIs(self.raw(done)["conversation"].get("questions"), True)
        # The same answer again (a retry) is the same message; another can't answer it twice.
        again = self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"],
                             idempotency_key="answer-1", answers=answers)
        self.assertEqual(again["message"]["id"], done["message"]["id"])
        with self.assertRaises(RegistryError) as twice:
            self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"],
                         idempotency_key="answer-2", answers={"q1": {"selected": [0]}})
        self.assertEqual(twice.exception.code, "questions_closed")
        with self.assertRaises(RegistryError):
            self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"], dismissed=True)

    def test_dismiss_closes_it_with_nothing_sent(self):
        _, reply = self.asked()
        before = len(self.messages())
        done = self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"], dismissed=True)
        self.assertEqual(done, {"questions": {"questions": ASKED, "state": "dismissed", "answers": {}}})
        self.assertEqual(len(self.messages()), before, "nothing was sent")
        self.assertEqual(self.messages()[-1]["questions"]["state"], "dismissed")
        self.assertEqual(self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"], dismissed=True),
                         done, "closing it again changes nothing")
        with self.assertRaises(RegistryError) as late:
            self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"],
                         idempotency_key="answer-1", answers={"q1": {"selected": [0]}})
        self.assertEqual(late.exception.code, "questions_closed")

    def test_a_chat_that_moved_on_closes_the_card(self):
        sent, reply = self.asked()
        self.reply(self.send(text="Actually, use Postgres.", key="message-2"), {"text": "Postgres it is."})
        card = next(m for m in self.messages() if m["id"] == reply["id"])["questions"]
        self.assertEqual(card["state"], "closed")
        with self.assertRaises(RegistryError) as closed:
            self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"],
                         idempotency_key="answer-1", answers={"q1": {"selected": [0]}})
        self.assertEqual(closed.exception.code, "questions_closed")
        self.assertIn("moved on", str(closed.exception))

    def test_bad_answers_are_refused_and_the_card_stays_open(self):
        _, reply = self.asked()
        for bad in ({}, {"q9": {"selected": [0]}}, {"q1": {"selected": [0, 1]}}, {"q1": {"selected": [7]}},
                    {"q1": {"selected": [0], "other": "and words"}}, "q1", {"q1": {"other": "x" * 4097}}):
            with self.subTest(bad=bad), self.assertRaises(RegistryError) as refused:
                self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"],
                             idempotency_key="answer-1", answers=bad)
            self.assertEqual(refused.exception.code, "invalid_answers")
        for fields in ({}, {"answers": {"q1": {"selected": [0]}}, "dismissed": True}, {"dismissed": False},
                       {"answers": {"q1": {"selected": [0]}}}):
            with self.subTest(fields=fields), self.assertRaises(RegistryError):
                self.control("answer_pip_questions", pip_id=self.job["id"], message_id=reply["id"], **fields)
        self.assertEqual(self.messages()[-1]["questions"]["state"], "open")

    def test_only_a_reply_of_this_pip_that_asked_can_be_answered(self):
        sent, reply = self.asked()
        user = [m for m in self.messages() if m["role"] == "user"][0]
        other = self.store.create(self.workspace["id"], "Other", "Inspect correctness.", "device_1")
        for pip_id, message_id in ((self.job["id"], user["id"]), (other["id"], reply["id"]),
                                   (self.job["id"], "message_" + "0" * 32)):
            with self.subTest(message_id=message_id), self.assertRaises(RegistryError) as refused:
                self.control("answer_pip_questions", pip_id=pip_id, message_id=message_id, dismissed=True)
            self.assertEqual(refused.exception.code, "not_found")

    def test_send_pip_message_takes_the_flag_through_the_control_seam(self):
        self.setup_job()
        sent = self.control("send_pip_message", pip_id=self.job["id"], text="Hi", idempotency_key="k-1", questions=True)
        self.assertIs(self.raw(sent)["conversation"].get("questions"), True)
        with self.assertRaises(RegistryError):
            self.control("send_pip_message", pip_id=self.job["id"], text="Hi", idempotency_key="k-2", questions="yes")


class TheVersion(unittest.TestCase):
    def test_pips_api_106_says_so_in_the_reference(self):
        from pathlib import Path
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 106)      # (107: Your Browser's window, merged after it)
        doc = (Path(__file__).resolve().parents[1] / "sdk" / "PIPS.md").read_text(encoding="utf-8")
        row = next(line for line in doc.splitlines() if line.startswith("| 106 |"))
        for word in ("answer_pip_questions", "propose_options", "`questions`", "offer_choices"):
            self.assertIn(word, row)
        self.assertIn("answer_pip_questions", pips._COMMAND_ARGS)
        self.assertEqual(pips._COMMAND_ARGS["answer_pip_questions"],
                         {"pip_id", "message_id", "idempotency_key", "answers", "dismissed", "chat_options"})
        self.assertIn("questions", pips._COMMAND_ARGS["send_pip_message"])


if __name__ == "__main__":
    unittest.main()
