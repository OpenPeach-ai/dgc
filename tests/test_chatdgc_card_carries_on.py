"""After Send it now on a plugin's card in ChatDGC, the reply carries on in the same message: the model reads what the
action answered (untrusted data, capped as any answer) and finishes what it said it would do. Don't and Hand it to a
Pip don't carry on, a card raised as it carries on is a new card, and nothing carries on by itself after that.

Reported 2026-11-02: the model said "send it and I'll summarise each one"; Send it now said "Done." and the
reply ended, the model never having seen the answer."""
import json
import threading
import time

from dgc.chatdgc import plugins as chat_plugins
from dgc.editor_protocol import event_error
from tests import test_chatdgc_plugins as fixtures


class CarriesOn(fixtures.PluginChat):
    """0.51 merged with 0.50.1: one continuation, the engine's continue_action (run by the service inside the turn it
    already holds for the card), reading the sent card's answer from the chat's own history."""

    def card(self):
        chat, reply = self.say("Put lunch on Friday in my calendar.",
                               {"calls": [("call_plugin", {"plugin": "gcal", "tool": "create_event",
                                                           "arguments": {"title": "Lunch", "when": "Fri 13:00"}})]},
                               {"parts": ["Send it and I'll confirm."]})
        return chat, reply, reply["actions"][0]

    def told(self):
        return "\n".join(str(m.get("content")) for m in self.world["read"][-1]["messages"])

    def test_the_model_reads_the_answer_and_the_same_reply_goes_on(self):
        chat, reply, card = self.card()
        self.world["answers"]["create_event"] = json.dumps({"id": "evt_9", "status": "confirmed"})
        done = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.assertEqual(done["status"], "done")
        self.world["script"].append({"parts": ["Added: lunch on Friday at 1."]})
        shown = []
        carried = self.engine.continue_action(chat["id"], reply["id"], card["id"], on_text=shown.append)
        self.assertEqual(carried["id"], reply["id"], "the same message")
        self.assertEqual(carried["text"], "Send it and I'll confirm.\n\nAdded: lunch on Friday at 1.")
        self.assertIn("evt_9", self.told(), "the model read what the action answered")
        self.assertIn("untrusted data", self.told())
        kept = self.store.get(chat["id"])["messages"]
        self.assertEqual(len(kept), 2, "no new message")
        self.assertEqual(kept[-1]["actions"][0]["status"], "done", "the card keeps what happened")

    def test_the_answer_it_reads_is_capped_as_any_answer(self):
        chat, reply, card = self.card()
        self.world["answers"]["create_event"] = json.dumps({"rows": ["x" * 50 for _ in range(1000)]})
        done = self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.assertLessEqual(len(done["answer"]), chat_plugins.MAX_ANSWER)
        self.world["script"].append({"parts": ["Done."]})
        self.engine.continue_action(chat["id"], reply["id"], card["id"])
        self.assertLess(len(self.told()), chat_plugins.MAX_ANSWER + 20_000)

    def test_a_card_that_didnt_go_is_said_too(self):
        chat, reply, card = self.card()
        self.world["answers"]["create_event"] = json.dumps({"isError": True, "content": "calendar is read-only"})
        self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.world["script"].append({"parts": ["It didn't go: your calendar is read-only."]})
        carried = self.engine.continue_action(chat["id"], reply["id"], card["id"])
        self.assertIn("didn't go", self.told())
        self.assertIn("calendar is read-only", self.told())
        self.assertTrue(carried["text"].endswith("your calendar is read-only."))

    def test_only_a_sent_card_of_the_latest_reply_carries_on(self):
        from dgc.chatdgc.engine import ChatEngineError
        chat, reply, card = self.card()
        self.engine.act(chat["id"], reply["id"], card["id"], "dismiss")
        with self.assertRaises(ChatEngineError):
            self.engine.continue_action(chat["id"], reply["id"], card["id"])
        chat, reply, card = self.card()
        self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.say("Something else.", {"parts": ["Sure."]}, chat=chat)
        with self.assertRaises(ChatEngineError, msg="the chat moved on"):
            self.engine.continue_action(chat["id"], reply["id"], card["id"])

    def test_a_card_raised_as_it_carries_on_is_a_new_card_and_waits(self):
        chat, reply, card = self.card()
        self.engine.act(chat["id"], reply["id"], card["id"], "run")
        self.world["script"] += [{"parts": ["Added. "], "calls": [("call_plugin", {"plugin": "gcal", "tool": "create_event",
                                                                                   "arguments": {"title": "Reminder"}})]},
                                 {"parts": ["The reminder waits for you."]}]
        cards = []
        carried = self.engine.continue_action(chat["id"], reply["id"], card["id"], on_action=cards.append)
        self.assertEqual([c["status"] for c in carried["actions"]], ["done", "waiting"])
        self.assertEqual([c["arguments"]["title"] for c in cards], ["Reminder"])
        self.assertEqual(len(self.world["calls"]), 1, "only the card the user sent ran")


class CarriesOnOverTheWire(fixtures.PluginChat):
    def setUp(self):
        super().setUp()
        from dgc.chatdgc.service import ChatService
        # No follow-ups: their model call, after a reply carries on, would take the next scripted step.
        self.config.get = lambda key, default=None: False if key == "chatdgc_followups" else default
        self.frames, self.lock = [], threading.Lock()

        def emit(type, **fields):
            frame = {"type": type, **fields}
            problem = event_error({**frame, "seq": 0})
            if problem:
                raise AssertionError(f"invalid event: {problem}")
            with self.lock:
                self.frames.append(frame)
        self.service = ChatService(emit, self.config, engine=self.engine)
        self.addCleanup(self.service.close, 2.0)

    def wait_for(self, test, what):
        for _ in range(600):
            with self.lock:
                found = [f for f in self.frames if test(f)]
            if found:
                return found[-1]
            time.sleep(0.01)
        raise AssertionError(f"no {what}: {[f['type'] for f in self.frames[-8:]]}")

    def test_send_it_now_then_the_same_reply_streams_on_and_dont_is_quiet(self):
        chat, reply = self.say("Lunch Friday.", {"calls": [("call_plugin", {"plugin": "gcal", "tool": "create_event",
                                                                            "arguments": {"title": "Lunch"}})]},
                               {"parts": ["Send it and I'll confirm."]})
        card = reply["actions"][0]
        self.world["script"].append({"parts": ["Added: lunch on Friday."]})
        self.service.dispatch({"type": "chatdgc_action", "request_id": "a1", "conversation_id": chat["id"],
                               "message_id": reply["id"], "action_id": card["id"], "op": "run"})
        self.wait_for(lambda f: f["type"] == "chatdgc_action" and f.get("request_id") == "a1", "the card's outcome")
        self.wait_for(lambda f: f["type"] == "chatdgc_turn" and f.get("state") == "started" and f.get("reply_id") == reply["id"],
                      "the reply carrying on")
        final = self.wait_for(lambda f: f["type"] == "chatdgc_message" and f["message"].get("id") == reply["id"]
                              and "Added" in f["message"].get("text", ""), "the reply as it ended")
        self.assertEqual(final["message"]["text"], "Send it and I'll confirm.\n\nAdded: lunch on Friday.")
        time.sleep(0.5)
        with self.lock:
            started = [f for f in self.frames if f["type"] == "chatdgc_turn" and f.get("state") == "started"]
        self.assertEqual(len(started), 1, "the reply carries on once, never twice")
        self.wait_for(lambda f: f["type"] == "chatdgc_turn" and f.get("state") == "ended", "the turn's end")
        order = [f["type"] for f in self.frames]
        self.assertLess(order.index("chatdgc_action"), order.index("chatdgc_turn"), "the card's outcome first")

        chat, reply = self.say("Dinner.", {"calls": [("call_plugin", {"plugin": "gcal", "tool": "create_event",
                                                                      "arguments": {"title": "Dinner"}})]}, {"parts": ["Card."]})
        with self.lock:
            self.frames.clear()
        self.service.dispatch({"type": "chatdgc_action", "request_id": "a2", "conversation_id": chat["id"],
                               "message_id": reply["id"], "action_id": reply["actions"][0]["id"], "op": "dismiss"})
        self.wait_for(lambda f: f["type"] == "chatdgc_action" and f.get("request_id") == "a2", "Don't")
        time.sleep(0.3)
        self.assertNotIn("chatdgc_turn", [f["type"] for f in self.frames], "Don't doesn't carry on")
