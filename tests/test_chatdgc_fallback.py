"""A chat's fallback model (D14, 9 Nov; fallback on every surface, part B): when its model fails before the reply wrote
or did anything (a usage limit, unreachable, a Claude Code or Codex that is signed out), the whole reply runs once more
on the fallback, with the whole chat; the first reply of an outage says so in one line, the chat says its fallback
answers until its own model writes again, and the screen's waiting line names the model now answering."""
import threading
import time
import unittest

from dgc.chatdgc.engine import ChatEngine, ChatEngineError
from dgc.editor_protocol import event_error, command_error
from tests import test_chatdgc as base
FakeClient, FakeConfig = base.FakeClient, base.FakeConfig

OWN, SPARE = "deepseek-v4.1-flash:cloud", "glm-5.3:cloud"


class ChatFallbackTests(unittest.TestCase):
    setUp = base.ChatDGCTests.setUp

    def asked_users(self, client, words):
        return sum(1 for m in client.calls[-1]["messages"] if m["role"] == "user" and words in str(m["content"]))

    def test_its_model_out_before_it_wrote_anything_the_fallback_writes_the_whole_reply_once_an_outage(self):
        chat = self.engine.open()
        switched = []
        self.script.extend([{"raise": "HTTP 429: You've hit your usage limit"}, {"parts": ["Paris."]}])
        with self.engine.fallback_turn(SPARE, None, on_switch=switched.append):
            reply = self.engine.send(chat["id"], "Capital of France?", model=OWN)
        self.assertEqual(reply["text"], "Paris.")
        self.assertEqual([c.model for c in self.clients][-2:], [OWN, SPARE])
        self.assertEqual(reply["fallback"], {"for": OWN, "line": f"{OWN} didn't answer; {SPARE} did"})
        self.assertEqual(switched, [SPARE], "the screen is told which model answers now")
        self.assertEqual(self.asked_users(self.clients[-1], "Capital of France?"), 1, "the whole chat, its message once")
        saved = self.store.get(chat["id"])
        self.assertEqual((saved["model"], saved["fallback"]), (OWN, SPARE), "its own model stays its model")
        self.assertEqual(saved["fallback_on"]["model"], SPARE)
        # Still out: the reply says nothing more. Its own model back: the outage is over.
        self.script.extend([{"raise": "HTTP 429"}, {"parts": ["Berlin."]}])
        with self.engine.fallback_turn(SPARE):
            second = self.engine.send(chat["id"], "And Germany?")
        self.assertEqual(second["fallback"], {"for": OWN}, "said once an outage")
        self.assertEqual(self.asked_users(self.clients[-1], "Capital of France?"), 1, "it knows the chat so far")
        self.script.append({"parts": ["Rome."]})
        with self.engine.fallback_turn(SPARE):
            back = self.engine.send(chat["id"], "And Italy?")
        self.assertEqual(self.clients[-1].model, OWN, "every reply tries its own model first")
        self.assertNotIn("fallback", back)
        self.assertNotIn("fallback_on", self.store.get(chat["id"]))

    def test_a_reply_that_already_wrote_is_never_redone_and_no_fallback_fails_as_before(self):
        chat = self.engine.open()
        self.script.append({"parts": ["Par"], "raise": "stream cut"})
        with self.engine.fallback_turn(SPARE):
            reply = self.engine.send(chat["id"], "Capital of France?", model=OWN)
        self.assertEqual((reply["text"], reply["finish"]), ("Par", "error"), "what it wrote stands; a second go could repeat it")
        self.assertEqual({c.model for c in self.clients}, {OWN})
        self.script.append({"raise": "HTTP 429"})
        with self.engine.fallback_turn(""), self.assertRaises(ChatEngineError):
            self.engine.send(chat["id"], "Again?")
        self.script.append({"parts": ["Paris."]})
        with self.engine.fallback_turn(""):
            self.engine.send(chat["id"], "Once more?")
        self.assertNotIn("fallback", self.store.get(chat["id"]), "none chosen: none kept")

    def test_a_subscription_that_cant_start_hands_over_before_anything_runs(self):
        def factory(model):
            if str(model).startswith("subscription:"):
                raise RuntimeError("Claude Code isn't signed in. Sign in, then try again.")
            client = FakeClient(model or FakeConfig.model, self.script)
            self.clients.append(client)
            return client
        self.engine._client_factory = factory
        chat = self.engine.open()
        self.script.append({"parts": ["Done."]})
        with self.engine.fallback_turn(SPARE):
            reply = self.engine.send(chat["id"], "Plan my week.", model="subscription:claude")
        self.assertEqual((reply["text"], self.clients[-1].model), ("Done.", SPARE))
        self.assertEqual(reply["fallback"]["line"], f"Claude Code didn't answer; {SPARE} did")

    def test_a_new_chat_starts_with_the_last_fallback_you_chose(self):
        first = self.engine.open()
        self.assertNotIn("fallback", first, "none until you choose one")
        self.script.append({"parts": ["Paris."]})
        with self.engine.fallback_turn(SPARE):
            self.engine.send(first["id"], "Capital of France?", model=OWN)
        self.assertEqual(self.engine.open().get("fallback"), SPARE)
        self.assertEqual(self.engine.open(first["id"]).get("fallback"), SPARE, "and the chat keeps its own")
        self.script.append({"parts": ["Ok."]})
        with self.engine.fallback_turn(""):
            self.engine.send(first["id"], "Thanks.")
        self.assertNotIn("fallback", self.engine.open(), "none chosen last: a new chat has none")

    def test_a_fallback_on_another_saved_provider_is_found_for_its_turn(self):
        own = {"id": "p" * 8, "base_url": "https://own.example/v1", "api_key": "k1", "api_mode": "chat"}
        spare = {"id": "s" * 8, "base_url": "https://spare.example/v1", "api_key": "k2", "api_mode": "chat"}
        with self.engine.provider_turn(own), self.engine.fallback_turn(f"provider:{spare['id']}:gpt-oss:120b", spare):
            client = self.engine.client(f"provider:{spare['id']}:gpt-oss:120b")
        self.assertEqual(client.model, "gpt-oss:120b")


class ChatFallbackServiceTests(unittest.TestCase):
    setUp = base.ChatDGCTests.setUp

    def test_the_editor_sends_it_only_when_offered_and_the_waiting_line_names_the_model_answering(self):
        from dgc.chatdgc.service import ChatService
        self.assertIsNone(command_error({"type": "chatdgc_send", "request_id": "r", "conversation_id": "c", "text": "x",
                                         "fallback": "provider:x:y", "fallback_provider": {"id": "x"}}))
        frames, lock = [], threading.Lock()

        def emit(type, **fields):
            frame = {"type": type, **fields}
            problem = event_error({**frame, "seq": 0})
            if problem:
                raise AssertionError(f"invalid event: {problem}")
            with lock:
                frames.append(frame)
        self.engine.config["chatdgc_followups"] = False
        service = ChatService(emit, self.engine.config, engine=self.engine)
        self.addCleanup(service.close, 2.0)
        chat = self.engine.open()
        self.script.extend([{"raise": "HTTP 503: unreachable"}, {"parts": ["Paris."]}])
        service.dispatch({"type": "chatdgc_send", "request_id": "r1", "conversation_id": chat["id"],
                          "text": "Capital of France?", "model": OWN, "fallback": SPARE})
        for _ in range(600):
            with lock:
                ended = [f for f in frames if f["type"] == "chatdgc_turn" and f.get("state") == "ended"]
            if ended:
                break
            time.sleep(0.01)
        waits = [f["model"] for f in frames if f["type"] == "chatdgc_waiting"]
        self.assertEqual(waits, [OWN, SPARE])
        final = [f for f in frames if f["type"] == "chatdgc_message" and f["message"].get("role") == "assistant"][-1]
        self.assertEqual(final["message"]["fallback"]["for"], OWN)


if __name__ == "__main__":
    unittest.main()
