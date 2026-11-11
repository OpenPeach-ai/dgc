"""ChatDGC's wake-ups (0.52, finishing work-wake-later): a ChatDGC chat sets "come back in 30 minutes" with the same
wake_later / wake_cancel tools as Work, kept in a journal beside the chat, so a reload or a restart keeps them.

The backend never runs a wake-up's turn by itself here: a chat on a saved provider sends its key from the editor with
every message, so when one falls due the service says so (`chatdgc_wakeup_due`) and the editor sends `chatdgc_wake`,
with the chat's route like any turn. The turn's user message carries `wakeup` (what it was for) so the screen shows it
as a note, and its text says what the chat said it would do. `chatdgc_wakeups` is the chat's row for the pill;
`chatdgc_cancel_wakeup` takes one back.
"""
import threading
import time
from pathlib import Path
from unittest.mock import patch

from dgc import wakeups
from dgc.editor_protocol import command_error, event_error
from tests import test_chatdgc_plugins as fixtures

WAKE = ("wake_later", {"minutes": 30, "why": "Check the build", "prompt": "Look at the build and say if it passed."})


class FileJournal(fixtures.PluginChat):
    def test_a_chat_book_lives_beside_the_chat_and_a_new_process_takes_it_back(self):
        chat = self.store.create()
        path = self.store._path(chat["id"])
        book = wakeups.Book(lambda: path, journal=wakeups.FILE_JOURNAL)
        item = book.add(30, "Check the build", "Look at the build.")
        journal = path.with_suffix(".wakeups")
        self.assertTrue(journal.is_file(), "written beside the chat")
        again = wakeups.Book(lambda: path, journal=wakeups.FILE_JOURNAL)
        with patch.object(wakeups, "owner_alive", lambda who: False):
            again.adopt()
        self.assertEqual([i["id"] for i in again.items()], [item["id"]], "the old process gone: this one has it")
        self.assertTrue(again.cancel(item["id"]))
        third = wakeups.Book(lambda: path, journal=wakeups.FILE_JOURNAL)
        with patch.object(wakeups, "owner_alive", lambda who: False):
            third.adopt()
        self.assertEqual(third.items(), [], "a cancelled one is gone from the journal too")


class Tools(fixtures.PluginChat):
    def setUp(self):
        super().setUp()
        self.books = {}

        def book_for(chat_id):
            return self.books.setdefault(chat_id, wakeups.Book(lambda: self.store._path(chat_id), journal=wakeups.FILE_JOURNAL))
        self.book_for = book_for

    def test_offered_only_where_wake_ups_are_delivered(self):
        self.say("Hi", {"parts": ["Hello."]})
        self.assertNotIn("wake_later", self.world["read"][-1]["tools"], "no editor that starts them: not offered")
        self.engine.wake_book = self.book_for
        self.say("Hi", {"parts": ["Hello."]})
        self.assertIn("wake_later", self.world["read"][-1]["tools"])
        self.assertIn("wake_cancel", self.world["read"][-1]["tools"])
        # A chat on Claude Code or Codex: their CLI runs its own loop, as Work's subscription does: not offered.
        chat = self.store.create(model="subscription:claude")
        self.say("Hi", {"parts": ["Hello."]}, chat=chat)
        self.assertNotIn("wake_later", self.world["read"][-1]["tools"])

    def test_wake_later_adds_to_the_chats_book_and_cancel_takes_it_back(self):
        self.engine.wake_book = self.book_for
        chat, reply = self.say("Check the build in half an hour.", {"calls": [WAKE]}, {"parts": ["I'll look at 14:30."]})
        book = self.books[chat["id"]]
        self.assertEqual([(i["why"], i["prompt"]) for i in book.items()],
                         [("Check the build", "Look at the build and say if it passed.")])
        told = self.told(-1)[0]
        self.assertTrue(told.startswith(f"Set {book.items()[0]['id']}: I wake at"), told)
        wid = book.items()[0]["id"]
        self.say("Never mind.", {"calls": [("wake_cancel", {"id": wid})]}, {"parts": ["Cancelled."]}, chat=chat)
        self.assertEqual(book.items(), [])
        self.assertEqual(self.told(-1)[0], f"Cancelled {wid}.")

    def test_a_fifth_is_refused_in_the_models_words(self):
        self.engine.wake_book = self.book_for
        chat, _ = self.say("Four.", {"calls": [WAKE, WAKE, WAKE, WAKE]}, {"parts": ["Set."]})
        self.say("One more.", {"calls": [WAKE]}, {"parts": ["Can't."]}, chat=chat)
        self.assertTrue(self.told(-1)[0].startswith("error: A chat can wait on at most 4 wake-ups"), self.told(-1)[0])


class OverTheWire(fixtures.PluginChat):
    def setUp(self):
        super().setUp()
        from dgc.chatdgc.service import ChatService
        self.config.get = lambda key, default=None: False if key == "chatdgc_followups" else default
        self.frames, self.lock = [], threading.Lock()

        def emit(type, **fields):
            frame = {"type": type, **fields}
            problem = event_error({**frame, "seq": 0})
            if problem:
                raise AssertionError(f"invalid event: {problem}")
            with self.lock:
                self.frames.append(frame)
        self.service = ChatService(emit, self.config, engine=self.engine, wakeups=True)
        self.addCleanup(self.service.close, 2.0)

    def wait_for(self, test, what, timeout=6.0):
        end = time.time() + timeout
        while time.time() < end:
            with self.lock:
                found = [f for f in self.frames if test(f)]
            if found:
                return found[-1]
            time.sleep(0.01)
        raise AssertionError(f"no {what}: {[f['type'] for f in self.frames[-10:]]}")

    def dispatch(self, cmd):
        self.assertIsNone(command_error(cmd), cmd)
        self.service.dispatch(cmd)

    def set_one(self):
        chat, _ = self.say("Check the build in half an hour.", {"calls": [WAKE]}, {"parts": ["I'll look then."]})
        row = self.wait_for(lambda f: f["type"] == "chatdgc_wakeups" and f["conversation_id"] == chat["id"] and f["items"],
                            "the chat's wake-up row")
        self.assertEqual([i["why"] for i in row["items"]], ["Check the build"])
        return chat, row["items"][0]["id"]

    def due(self):
        """Half an hour on: the service's clock moves and it looks again (its timer would, at that time)."""
        self.service._wake_clock = lambda: time.time() + 31 * 60
        self.service._wake_check()

    def test_a_due_wake_up_is_said_and_the_editors_wake_runs_its_turn_once(self):
        chat, wid = self.set_one()
        self.service._wake_check()
        with self.lock:
            self.assertFalse([f for f in self.frames if f["type"] == "chatdgc_wakeup_due"], "not due yet: nothing said")
        self.due()
        due = self.wait_for(lambda f: f["type"] == "chatdgc_wakeup_due", "the wake-up's word to the editor")
        self.assertEqual((due["conversation_id"], due["id"], due["model"]), (chat["id"], wid, "chat-model"))
        self.world["script"].append({"parts": ["The build passed."]})
        self.dispatch({"type": "chatdgc_wake", "request_id": "w1", "conversation_id": chat["id"], "id": wid})
        self.wait_for(lambda f: f["type"] == "chatdgc_turn" and f.get("state") == "ended", "the wake-up's turn")
        kept = self.store.get(chat["id"])["messages"]
        mine = [m for m in kept if m["role"] == "user"][-1]
        self.assertEqual(mine.get("wakeup", {}).get("why"), "Check the build", "the screen shows it as a note")
        self.assertIn("This is the wake-up you set", mine["text"])
        self.assertIn("Look at the build and say if it passed.", mine["text"])
        self.assertEqual(kept[-1]["text"], "The build passed.")
        self.wait_for(lambda f: f["type"] == "chatdgc_wakeups" and f["conversation_id"] == chat["id"] and f["items"] == [],
                      "the row emptied")
        before = len([f for f in self.frames if f["type"] == "chatdgc_turn"])
        self.dispatch({"type": "chatdgc_wake", "request_id": "w2", "conversation_id": chat["id"], "id": wid})
        self.wait_for(lambda f: f["type"] == "chatdgc_error" and f.get("request_id") == "w2", "a second wake refused")
        self.assertEqual(len([f for f in self.frames if f["type"] == "chatdgc_turn"]), before, "it runs once")

    def test_one_not_due_yet_or_unknown_is_refused_and_kept(self):
        chat, wid = self.set_one()
        self.dispatch({"type": "chatdgc_wake", "request_id": "w3", "conversation_id": chat["id"], "id": wid})
        self.wait_for(lambda f: f["type"] == "chatdgc_error" and f.get("request_id") == "w3", "not due: refused")
        self.dispatch({"type": "chatdgc_wake", "request_id": "w4", "conversation_id": chat["id"], "id": "wake999999"})
        self.wait_for(lambda f: f["type"] == "chatdgc_error" and f.get("request_id") == "w4", "unknown: refused")
        self.assertEqual([i["id"] for i in self.service._wake_book(chat["id"]).items()], [wid], "still waiting")

    def test_cancel_takes_it_back_and_says_so(self):
        chat, wid = self.set_one()
        self.dispatch({"type": "chatdgc_cancel_wakeup", "conversation_id": chat["id"], "id": wid})
        self.wait_for(lambda f: f["type"] == "chatdgc_wakeups" and f["conversation_id"] == chat["id"] and f["items"] == [],
                      "the row emptied")
        self.due()
        time.sleep(0.2)
        with self.lock:
            self.assertFalse([f for f in self.frames if f["type"] == "chatdgc_wakeup_due"])

    def test_due_while_the_chat_answers_waits_for_its_turn_to_end(self):
        chat, wid = self.set_one()
        with self.service._lock:
            self.service._turns[chat["id"]] = {"cancel": threading.Event(), "reply_id": None, "thread": None}
        self.due()
        time.sleep(0.2)
        with self.lock:
            self.assertFalse([f for f in self.frames if f["type"] == "chatdgc_wakeup_due"], "busy: not yet")
        with self.service._lock:
            del self.service._turns[chat["id"]]
        self.service._turns_changed()
        self.wait_for(lambda f: f["type"] == "chatdgc_wakeup_due" and f["id"] == wid, "said once the chat is free")

    def test_ready_says_chatdgc_takes_wake_ups(self):
        from dgc import headless
        from types import SimpleNamespace
        self.assertEqual(headless.Backend._chatdgc_capability(SimpleNamespace(_host=object()))["chatdgc"].get("wakeups"), 1)
