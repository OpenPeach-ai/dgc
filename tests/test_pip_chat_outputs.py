"""@ outputs in a Pip's chat, as in Work (asked 14 Nov: "does @plugin and @ page come the same way as in work chat?";
"I meant the same way in Pip chat"; finding 56).

Work's prompt box offers Document, Slides, Spreadsheet, Page and Dashboard: the reply is asked for that kind with one
plain line (artifact_tools.output_line), and when the reply didn't make one the chat says so under it
(artifact_tools.missing_note). A Pip's chat now does the same through its own way in: send_pip_message takes `output`
(Pips API 100), the run's conversation carries it, the turn gets Work's line, a message sent while the Pip works keeps
its own choice (read on the way, or as its own turn), and the reply says when it didn't make what was asked."""
import json
import os
from unittest.mock import patch

from dgc import artifact_tools, pip_chat, pip_library, pip_steering, pips
from dgc.llm import ChatResult, LLMClient
from dgc.workspace_registry import RegistryError
from tests.test_pip_missed_steer import Base

APPS = {"socket": "/nonexistent/pip-apps.sock", "token": "t" * 32, "apps": [], "plugins": [], "composio": False,
        "microsoft": False}


class TheRequest(Base):
    def test_a_chosen_output_is_part_of_the_request_and_its_retry_key(self):
        plain = pip_chat.request("Tide times for Sunday", "k1")
        page = pip_chat.request("Tide times for Sunday", "k1", output="page")
        self.assertEqual(page["output"], "page")
        self.assertNotEqual(page["digest"], plain["digest"], "the same key with another output is another request")
        for none in (None, "auto", ""):
            with self.subTest(output=none):
                same = pip_chat.request("Tide times for Sunday", "k1", output=none)
                self.assertNotIn("output", same, "Auto asks for nothing")
                self.assertEqual(same["digest"], plain["digest"], "an older message's key is unchanged")

    def test_only_works_outputs_are_taken(self):
        for bad in ("video", "Page", 3, ["page"]):
            with self.subTest(output=bad), self.assertRaises(RegistryError) as caught:
                pip_chat.request("x", "k1", output=bad)
            self.assertEqual(caught.exception.code, "invalid_output")
        self.assertEqual(set(pip_chat.OUTPUTS), set(artifact_tools.OUTPUT_LINES), "one list: Work's")

    def control(self, request, actor="editor-user"):
        with patch("dgc.pips.WorkspaceRegistry", return_value=self.registry), patch.object(self.registry, "close"):
            return pips.handle_control(self.cfg, {"request_id": "r", **request}, actor, start_worker=False)

    def test_send_pip_message_puts_it_in_the_runs_conversation(self):
        self.job_ready()
        out = self.control({"type": "send_pip_message", "pip_id": self.job["id"], "text": "A page of tide times",
                            "idempotency_key": "tides", "output": "page"})
        self.assertTrue(out["ok"], out)
        run = self.store.run(out["result"]["run"]["id"])
        self.assertEqual(run["manifest"]["conversation"]["output"], "page")
        again = self.control({"type": "send_pip_message", "pip_id": self.job["id"], "text": "A page of tide times",
                              "idempotency_key": "tides", "output": "page"})
        self.assertEqual(again["result"]["run"]["id"], run["id"], "a retry finds what it became")

    def test_it_is_in_pips_api_100_and_the_sdk_sends_it(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 100)
        from dgc_sdk import pips as sdk
        self.assertIn("output", sdk.COMMAND_FIELDS["send_pip_message"])
        self.assertEqual(sdk.API100_FIELDS["send_pip_message"], frozenset({"output"}))


class TheTurn(Base):
    def working(self, output=None, apps=True):
        self.job_ready()
        self.first = pip_chat.send(self.store, self.job["id"], "Tide times for Sunday", "first", "editor-user", self.cfg,
                                   output=output)
        self.store.claim_next()
        self.apps = apps
        return self.first

    def worker(self, said=("First part.", "Second part.")):
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                  (self.first["run"]["id"],)).fetchone()[0])
        if self.apps:
            raw["app_socket"] = APPS          # what the controller adds to a chat with its box: the artifact tools
        folder = self.registry.directory / "runs" / self.first["run"]["id"]
        folder.mkdir(parents=True, exist_ok=True)
        rounds = []

        def chat(client, messages, tools=None, **kwargs):
            rounds.append((messages, [t["function"]["name"] for t in tools or []]))
            if len(rounds) == 1:
                pip_steering.stage(self.registry.db, self.first["run"]["id"], folder, self.registry.directory)
            return ChatResult(content=said[min(len(rounds), len(said)) - 1])
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=False))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, folder / "snapshot.tar", raw, [].append)
        return result, rounds

    @staticmethod
    def said(messages):
        return "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "user")

    def test_the_turn_is_given_works_line_for_the_chosen_output(self):
        self.working(output="page")
        _, rounds = self.worker(said=("Here it is.",))
        messages, tools = rounds[0]
        self.assertIn("make_artifact", tools)
        self.assertIn(artifact_tools.output_line("page"), self.said(messages))

    def test_auto_asks_for_nothing(self):
        self.working()
        _, rounds = self.worker(said=("Here it is.",))
        for line in artifact_tools.OUTPUT_LINES.values():
            self.assertNotIn(line, self.said(rounds[0][0]))

    def test_no_line_without_the_tools_to_make_it(self):
        # A chat with no box has no artifact tools: the line would ask for what it can't do (the note says so after).
        self.working(output="slides", apps=False)
        _, rounds = self.worker(said=("Here it is.",))
        self.assertNotIn("make_artifact", rounds[0][1])
        self.assertNotIn(artifact_tools.output_line("slides"), self.said(rounds[0][0]))

    def test_a_message_sent_while_it_works_brings_its_own_choice(self):
        self.working()
        sent = pip_chat.send(self.store, self.job["id"], "Make it a deck", "late", "editor-user", self.cfg,
                             output="slides")
        self.assertTrue(sent["message"]["steered"])
        result, rounds = self.worker()
        self.assertEqual(len(rounds), 2, "it read the message on the way")
        later = self.said(rounds[1][0])
        self.assertIn("Make it a deck", later)
        self.assertIn(artifact_tools.output_line("slides"), later)
        self.assertNotIn(artifact_tools.output_line("slides"), self.said(rounds[0][0]))

    def test_an_unknown_output_in_the_inbox_is_never_read(self):
        folder = self.registry.directory / "inbox"
        folder.mkdir(parents=True)
        good = {"id": "message_" + "a" * 32, "text": "Make it a deck", "output": "slides"}
        bad = {"id": "message_" + "b" * 32, "text": "x", "output": "rm -rf"}
        (folder / "steering.json").write_text(json.dumps([good, bad]))
        self.assertEqual(pip_steering.read_worker(folder, set()), [good])


class WhenItWasNotRead(Base):
    def test_a_message_it_never_read_keeps_its_choice_in_its_own_turn(self):
        self.job_ready()
        self.send("Write the summary", "first")
        pip_chat.send(self.store, self.job["id"], "Now as a sheet", "late", "editor-user", self.cfg,
                      output="spreadsheet")
        self.run_to_end("Here is the summary.")
        turn = self.queued_run_of("Now as a sheet")
        self.assertIsNotNone(turn, "the message has a turn of its own")
        self.assertEqual(json.loads(turn["manifest"])["conversation"]["output"], "spreadsheet")


class TheNote(Base):
    def reply(self, result):
        self.job_ready()
        first = self.send("Tide times for Sunday", "first")
        self.store.claim_next()
        self.store.finish(first["run"]["id"], result=result)
        [reply] = [m for m in self.page()["messages"] if m["role"] == "assistant"]
        return reply

    def test_a_reply_that_didnt_make_what_was_asked_says_so_as_work_does(self):
        reply = self.reply({"text": "Here are the tides.", "output_missing": "page"})
        self.assertEqual(reply["output_missing"], artifact_tools.missing_note("page", []))

    def test_a_reply_that_made_it_says_nothing(self):
        reply = self.reply({"text": "Here are the tides."})
        self.assertNotIn("output_missing", reply)

    def test_a_bad_value_is_refused(self):
        self.job_ready()
        first = self.send("Tide times", "first")
        self.store.claim_next()
        with self.assertRaises(RegistryError):
            pip_chat.insert_reply(self.store, self.store.run(first["run"]["id"]),
                                  {"text": "x", "output_missing": "video"}, "2026-11-16T00:00:00Z")

    def test_what_it_made_is_counted_by_the_controller_never_the_worker(self):
        session = pip_library.Session.__new__(pip_library.Session)
        session.directory, session.config, session.pip_id, session.run_id, session.name = None, None, "pip_x", "run_x", "Tide"
        session.made = []
        def make(type_, *args, **kwargs):
            if type_ != "page":
                raise ValueError("no")
            return {"type": type_, "label": "Page", "title": "Tides", "id": "ar_1", "version": 1}
        with patch.object(artifact_tools.service, "make", side_effect=make):
            session.call("make_artifact", {"type": "page", "title": "Tides", "content": "<p>x</p>"})
            said = session.call("make_artifact", {"type": "sheet", "title": "Bad", "data": {}})
        self.assertTrue(said.startswith("error"), said)
        self.assertEqual(session.made, ["page"], "only what was made")
        self.assertEqual(pip_library.unmet(["page"], session.made), "")
        self.assertEqual(pip_library.unmet(["page", "slides"], session.made), "slides",
                         "a message read on the way asked for a deck")
        self.assertEqual(pip_library.unmet([], []), "")

    def test_the_outputs_its_messages_asked_for_are_the_ones_it_read(self):
        self.job_ready()
        first = self.send("Write the summary", "first")
        a = pip_chat.send(self.store, self.job["id"], "As a deck", "a", "editor-user", self.cfg, output="slides")
        pip_chat.send(self.store, self.job["id"], "And a sheet", "b", "editor-user", self.cfg, output="spreadsheet")
        pip_steering.applied(self.store, first["run"]["id"], [a["message"]["id"]])
        self.assertEqual(pip_steering.outputs_read(self.registry.db, first["run"]["id"]), ["slides"],
                         "the one it didn't read is its own turn, with its own note")


if __name__ == "__main__":
    import unittest
    unittest.main()
