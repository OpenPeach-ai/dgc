"""A message sent while a Pip works sits where it was read, as in Work (asked 15 Nov: "user message, pips mid turn
response, and model still working, the user sends a mid turn prompt, it should come below the current response, and
then below it the model responses continue").

A reply joined everything the Pip wrote in its turn into one text, skipping the messages read on the way, and each of
those showed by when it was sent: above the whole reply, before words the Pip wrote first. The reply now says where
each one was read: `steers`, [{id, at}], `at` a place in the reply's own text (after masking), a message there being
one this reply read. The chat draws the reply in pieces with each message between them (Pips API 99)."""
import json
import os
from unittest.mock import patch

from dgc import pip_chat, pip_steering, pips
from dgc.llm import ChatResult, LLMClient
from dgc.workspace_registry import RegistryError
from tests.test_pip_missed_steer import Base

NOW = "2026-11-15T12:00:00Z"


class WhereItWasRead(Base):
    def working(self):
        self.job_ready()
        self.first = self.send("Write the summary", "first", actor="editor-user")
        self.store.claim_next()
        return self.first

    def late(self, text="Use the shorter title", key="late"):
        return pip_chat.send(self.store, self.job["id"], text, key, "editor-user", self.cfg)

    def folder(self):
        folder = self.registry.directory / "runs" / self.first["run"]["id"]
        folder.mkdir(parents=True, exist_ok=True)
        return folder

    def worker(self, said=("First part.", "Second part.")):
        """The real Agent loop on a mocked model; the message arrives during its first round."""
        raw = json.loads(self.registry.db.execute("SELECT manifest FROM pip_runs WHERE id=?",
                                                  (self.first["run"]["id"],)).fetchone()[0])
        folder, rounds, events = self.folder(), [], []

        def chat(client, messages, tools=None, **kwargs):
            rounds.append(messages)
            if len(rounds) == 1:
                pip_steering.stage(self.registry.db, self.first["run"]["id"], folder, self.registry.directory)
            return ChatResult(content=said[min(len(rounds), len(said)) - 1])
        with patch.dict(os.environ, {"DGC_SESSION_POLICY": pips._json(pips.native_policy(personal=False))}), \
                patch.object(LLMClient, "chat", chat), patch("dgc.agent.discover_skills", return_value={}), \
                patch("dgc.agent.load_memories", side_effect=AssertionError("No ambient memory")):
            result = pips.execute_native(self.cfg, folder / "snapshot.tar", raw, events.append)
        return result, rounds, events

    def test_the_reply_says_where_the_message_was_read(self):
        self.working()
        sent = self.late()
        result, rounds, events = self.worker()
        self.assertEqual(len(rounds), 2, "the reply carried on to read it")
        self.assertEqual(result["text"], "First part.\n\nSecond part.")
        self.assertEqual(result["steers"], [{"id": sent["message"]["id"], "at": len("First part.")}],
                         "read after its first part: the message sits between the two")

    def test_where_it_sits_is_counted_in_the_text_as_masked(self):
        self.working()
        secret = "sk-live-" + "7" * 24
        self.cfg.set_runtime_secret("api_key", secret)
        sent = self.late()
        result, _, _ = self.worker(said=(f"The key was {secret} here.", "Second part."))
        self.assertNotIn(secret, result["text"])
        at = result["steers"][0]["at"]
        self.assertEqual(result["text"][at:], "\n\nSecond part.", "the place is in the text the user reads")
        self.assertEqual(result["steers"][0]["id"], sent["message"]["id"])

    def test_a_reply_that_read_nothing_on_the_way_says_nothing(self):
        self.working()
        result, rounds, _ = self.worker(said=("All in one go.",))
        self.assertEqual(len(rounds), 1)
        self.assertEqual(result["text"], "All in one go.")
        self.assertNotIn("steers", result)

    def test_kept_with_the_reply_and_listed_with_it(self):
        self.working()
        sent = self.late()
        result, _, _ = self.worker()
        run = self.first["run"]
        pip_steering.applied(self.store, run["id"], [sent["message"]["id"]])
        self.store.finish(run["id"], result=result)
        page = pip_chat.list_messages(self.store, self.job["id"])["messages"]
        [reply] = [m for m in page if m["role"] == "assistant"]
        self.assertEqual(reply["steers"], [{"id": sent["message"]["id"], "at": len("First part.")}])
        [mine] = [m for m in page if m["id"] == sent["message"]["id"]]
        self.assertTrue(mine["steered"], "the message is still its own bubble; the reply says where it goes")

    def test_a_bad_list_is_refused_and_another_runs_message_never_placed(self):
        self.working()
        sent = self.late()
        result, _, _ = self.worker()
        for bad in ([{"id": sent["message"]["id"], "at": 999}], [{"id": sent["message"]["id"], "at": -1}],
                    [{"id": 5, "at": 0}], "x", [{"id": sent["message"]["id"]}], [{"id": "s", "at": 0}] * 65):
            with self.subTest(bad=bad), self.assertRaises(RegistryError):
                pip_chat.validate_steers({**result, "steers": bad}["steers"], result["text"])
        other = {**result, "steers": [{"id": "message_" + "f" * 32, "at": 3}]}
        self.store.finish(self.first["run"]["id"], result=other)
        [reply] = [m for m in pip_chat.list_messages(self.store, self.job["id"])["messages"] if m["role"] == "assistant"]
        self.assertNotIn("steers", reply, "a message that isn't this reply's is never placed in it")

    def test_it_is_in_pips_api_99(self):
        from dgc.headless import PIPS_API_VERSION
        self.assertGreaterEqual(PIPS_API_VERSION, 99)
