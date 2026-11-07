"""Pips start like people you meet: pick a character, name it, and it says hello.

A Personal Pip can be created with just a name (its chat sets it up), Core can be your Primary
Pip, and a new Pip's first message comes from a hidden turn DGC sends once, which the editor
does not show as yours.
"""
import json
import os
import unittest
from unittest.mock import patch

from dgc import pip_chat, pips
from dgc.workspace_registry import RegistryError
from tests import test_pips_local as fixtures


class SimpleStartTests(unittest.TestCase):
    setUp = fixtures.LocalPipsTests.setUp
    git = fixtures.LocalPipsTests.git
    commit = fixtures.LocalPipsTests.commit

    def personal_id(self):
        return self.registry.personal()["id"]

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_a_personal_pip_needs_only_a_name(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        self.assertEqual(pip["name"], "Gmail")
        self.assertEqual(pip["goal"], pips.NAMED_GOAL)
        blank = self.store.create(self.personal_id(), "Travel", "   ", "editor-user", pip_type="scout")
        self.assertEqual(blank["goal"], pips.NAMED_GOAL)

    def test_a_project_pip_still_says_what_it_reviews(self):
        with self.assertRaises(RegistryError):
            self.store.create(self.workspace["id"], "Reviewer", None, "editor-user", pip_type="rook")

    def test_core_is_your_primary_pip_and_only_a_personal_one(self):
        core = self.store.create(self.personal_id(), "Core", None, "editor-user", pip_type="core")
        self.assertEqual((core["pip_type"], core["goal"]), ("core", pips.PRIMARY_GOAL))
        with self.assertRaises(RegistryError) as refused:
            self.store.create(self.workspace["id"], "Core", "Review the code", "editor-user", pip_type="core")
        self.assertIn("Primary Pip", str(refused.exception))
        catalog = {t["id"]: t for t in __import__("dgc.pip_types", fromlist=["catalog"]).catalog()}
        self.assertFalse(catalog["core"]["available"], "project pickers still never offer Core")

    def test_a_hello_that_failed_can_be_asked_again_and_only_then(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        first = pip_chat.introduce(self.store, pip["id"], "editor-user", self.cfg)
        self.store.claim_next()
        self.store.finish(first["run"]["id"], error={"code": "worker_failed", "message": "HTTP 401 from the provider " + "x" * 400})
        page = pip_chat.list_messages(self.store, pip["id"])
        [hello] = page["messages"]
        self.assertTrue(hello["intro"])
        self.assertEqual(hello["status"], "failed")
        self.assertTrue(hello["error"].startswith("HTTP 401"), "what the chat says instead of nothing")
        self.assertEqual(len(hello["error"]), 300)
        self.assertEqual(len(hello["error_detail"]), len("HTTP 401 from the provider ") + 400, "Details has it all")
        again = pip_chat.introduce(self.store, pip["id"], "editor-user", self.cfg)
        self.assertNotEqual(again["run"]["id"], first["run"]["id"], "Try again is a new turn: the same key only finds the failed one")
        same = pip_chat.introduce(self.store, pip["id"], "editor-user", self.cfg)
        self.assertEqual(same["run"]["id"], again["run"]["id"], "once per try: it is waiting")
        self.store.claim_next()
        self.store.finish(again["run"]["id"], result={"text": "Hi, I'm Gmail."})
        replied = pip_chat.introduce(self.store, pip["id"], "editor-user", self.cfg)
        self.assertEqual(replied["run"]["id"], again["run"]["id"], "it has said hello: nothing more")
        shown = pip_chat.list_messages(self.store, pip["id"])["messages"]
        self.assertTrue(all(m["intro"] for m in shown if m["role"] == "user"), "neither try shows a bubble")

    def test_a_new_pip_says_hello_first_from_one_hidden_turn(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        first = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertTrue(first["ok"], first.get("error"))
        again = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertEqual(again["result"]["run"]["id"], first["result"]["run"]["id"], "once per Pip")
        text = first["result"]["message"]["text"]
        self.assertIn('named you "Gmail"', text)
        self.assertIn("not the user", text)
        page = pip_chat.list_messages(self.store, pip["id"])
        [shown] = page["messages"]
        self.assertTrue(shown["intro"], "the editor shows no bubble for it")
        self.assertEqual(first["result"]["run"]["manifest"]["kind"] if "kind" in first["result"]["run"]["manifest"]
                         else first["result"]["run"]["manifest"]["run_kind"], "conversation")

    def test_core_introduces_itself_as_the_primary_pip(self):
        core = self.store.create(self.personal_id(), "Core", None, "editor-user", pip_type="core")
        result = self.control({"type": "introduce_pip", "pip_id": core["id"]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertIn("Primary Pip", result["result"]["message"]["text"])

    def test_your_own_message_can_never_pass_as_an_introduction(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        refused = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "hi",
                                "idempotency_key": "intro_" + pip["id"][4:]})
        self.assertFalse(refused["ok"])
        self.assertIn("reserved", refused["error"]["message"])
        ordinary = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "hi", "idempotency_key": "k1"})
        self.assertTrue(ordinary["ok"], ordinary.get("error"))
        self.assertNotIn("intro", pip_chat.list_messages(self.store, pip["id"])["messages"][-1])

    def test_a_project_pip_introduces_itself_without_claiming_a_run(self):
        self.commit()
        pip = self.store.create(self.workspace["id"], "Reviewer", "Review the code", "editor-user", pip_type="rook")
        result = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertTrue(result["ok"], result.get("error"))
        self.assertIn("Review the code", result["result"]["message"]["text"])
        self.assertIn("without claiming that you have checked", result["result"]["message"]["text"])
        again = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertEqual(again["result"]["run"]["id"], result["result"]["run"]["id"])

    def test_opening_an_existing_chat_does_not_insert_a_late_hello(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        sent = self.control({"type": "send_pip_message", "pip_id": pip["id"], "text": "Check my inbox",
                             "idempotency_key": "first-user-message"})
        self.assertTrue(sent["ok"], sent.get("error"))
        intro = self.control({"type": "introduce_pip", "pip_id": pip["id"]})
        self.assertTrue(intro["ok"], intro.get("error"))
        self.assertEqual(intro["result"], {"already_started": True})
        self.assertEqual(len(pip_chat.list_messages(self.store, pip["id"])["messages"]), 1)

    def test_only_the_local_user_asks(self):
        pip = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        result = self.control({"type": "introduce_pip", "pip_id": pip["id"]}, actor="device_" + "1" * 32)
        self.assertFalse(result["ok"])


    def system_prompt(self, pip, chatting):
        from dgc.llm import LLMClient, ChatResult
        run = (pip_chat.send(self.store, pip["id"], "Hi", "k-" + str(chatting), "user", self.cfg)["run"]
               if chatting else self.store.enqueue(pip["id"], "task", "user", self.cfg))
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append(messages[0]["content"])
            return ChatResult(content="Hello.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        return seen[0] if isinstance(seen[0], str) else json.dumps(seen[0])

    def test_a_pip_chats_in_short_bubbles_and_core_knows_it_is_primary(self):
        gmail = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        chat = self.system_prompt(gmail, True)
        self.assertIn("Write the way you'd text", chat)
        self.assertRegex(chat, r"It is \w+day \d\d \w+ \d{4}, \d\d:\d\d for the user \(time zone ",
                         "it can say when, for a routine or a reminder")
        self.assertNotIn("Primary Pip", chat)
        self.assertNotIn("Write the way you'd text", self.system_prompt(gmail, False), "a scheduled task writes a result, not chat")
        core = self.store.create(self.personal_id(), "Core", None, "editor-user", pip_type="core")
        self.assertIn("Primary Pip", self.system_prompt(core, True))

    def test_the_pip_decides_where_its_reply_parts_into_short_messages(self):
        # Asked 2026-11-03: "leave this to the llm model to decide" where a reply is several short bubbles and where
        # one. The chat shows a reply as one bubble and parts it only at a line of just --- (pipsTranscript.replyParts).
        gmail = self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        chat = self.system_prompt(gmail, True)
        self.assertIn(pip_chat.BUBBLES, chat)
        self.assertIn("when separate short messages read better, put a line with only --- between them", chat)
        self.assertIn("(a poem, a draft, an explanation, a list, steps) goes in one message with no --- inside it", chat)
        self.assertIn("never a piece the user asked for", chat, "the short-message asks are about its own words")
        self.assertNotIn("Each paragraph appears as its own chat bubble", chat, "no longer true, and it cut pieces up")
        self.assertEqual(pip_chat.without_breaks("Hi!\n---\nYour poem:\n\n  ---  \nEnd"), "Hi!\n\nYour poem:\n\n\nEnd")
        self.assertEqual(pip_chat.without_breaks("Not a break: ---\n----"), "Not a break: ---\n----")

    def test_core_knows_the_other_pips_by_name_and_purpose(self):
        core = self.store.create(self.personal_id(), "Core", None, "editor-user", pip_type="core")
        self.store.create(self.personal_id(), "Gmail", None, "editor-user", pip_type="lens")
        prompt = self.system_prompt_and_input(core)
        self.assertIn('"name":"Gmail"', prompt)
        gmail = [p for p in self.store.list(self.personal_id()) if p["name"] == "Gmail"][0]
        self.assertNotIn("The user's other Pips, for reference", self.system_prompt_and_input(gmail), "only Core is told")

    def system_prompt_and_input(self, pip):
        from dgc.llm import LLMClient, ChatResult
        run = pip_chat.send(self.store, pip["id"], "Hi", "roster-" + pip["id"][-6:], "user", self.cfg)["run"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run["id"],)).fetchone()[0])
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append("\n".join(m["content"] if isinstance(m["content"], str) else json.dumps(m["content"]) for m in messages))
            return ChatResult(content="Hello.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        return seen[0]

    def core_intro_input(self, microsoft):
        """Everything Core's model gets for its first hello (instructions, the hidden turn, its tools), with its app
        socket as a run has it, in a home where DGC's Microsoft Mail plugin is or isn't set up."""
        from dgc import pip_app_links
        from dgc.llm import LLMClient, ChatResult
        core = self.store.create(self.personal_id(), "Core", None, "editor-user", pip_type="core")
        result = self.control({"type": "introduce_pip", "pip_id": core["id"]})
        run_id = result["result"]["run"]["id"]
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?", (run_id,)).fetchone()[0])
        ready = (lambda config: {"command": "python3"}) if microsoft else pip_app_links.microsoft_mail.spec
        with patch.object(pip_app_links.microsoft_mail, "spec", ready):
            socket = pip_app_links.RunSocket(self.registry.directory, self.cfg, core["id"], core["workspace_id"], run_id)
            self.addCleanup(socket.close)
            raw["app_socket"] = socket.pin()
        self.assertIs(raw["app_socket"]["microsoft"], microsoft)
        seen = []

        def chat(client, messages, tools=None, **kwargs):
            seen.append("\n".join(m["content"] if isinstance(m["content"], str) else json.dumps(m["content"])
                                   for m in messages) + "\n" + json.dumps(tools or []))
            return ChatResult(content="Hello.")
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=True))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            pips.execute_native(self.cfg, self.root, raw, lambda e: None)
        return seen[0]

    def test_cores_first_hello_is_told_only_what_is_really_connected(self):
        """Seen in testing: in a home with no Microsoft plugin, Core's first hello said "the only app connected is
        Outlook Mail through a Microsoft plugin". It had been told, unconditionally, that Outlook Mail "uses the user's
        existing Microsoft plugin"."""
        told = self.core_intro_input(microsoft=False)
        self.assertIn("Primary Pip", told)
        self.assertNotIn("existing Microsoft plugin", told)
        self.assertNotIn("existing DGC Microsoft", told)
        self.assertIn("which the user hasn't set up", told)
        self.assertIn("No DGC plugins are turned on for you", told)
        self.assertIn("is not a connection", told)
        self.assertIn("say nothing is connected yet", told)
        set_up = self.core_intro_input(microsoft=True)
        self.assertIn("Outlook Mail uses the user's DGC Microsoft plugin, which is set up", set_up)
        self.assertNotIn("which the user hasn't set up", set_up)


if __name__ == "__main__":
    unittest.main()
