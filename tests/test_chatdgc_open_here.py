"""Open here for a ChatDGC chat: one window writes to a chat at a time, and Open here moves one chat, never a process.

A chat rides on its window's Sessions home backend, which also carries that window's Pips, Sessions and Settings, so
moving the process (as Work's Open here does) would take all of that with it. Here the process that holds a chat lets
that one chat go: idle, the other window opens it from disk; mid-reply, the reply goes on where it was and its events
come through the other window's own backend (each part once), and when it ends the chat is that backend's for good.

Two real `dgc serve` homes on one HOME, as two VS Code windows are; a model that counts slowly.
"""
from __future__ import annotations

import json
import os
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_session_detach import (POSIX_SOCKETS, ChatModel, Serve, World, alive, chat_lines,  # noqa: E402
                                 wait_until)

from dgc import editor_protocol as ep  # noqa: E402

HELD = "open in another window"


def held(event, state, conversation_id):
    return (event.get("type") == "chatdgc_held" and event.get("state") == state
            and event.get("conversation_id") == conversation_id)


class ProtocolTests(unittest.TestCase):
    def test_the_commands_and_the_event_are_declared(self):
        self.assertEqual(set(ep.COMMAND_FIELDS["chatdgc_shown"]), {"conversation_ids"})
        self.assertEqual(set(ep.COMMAND_FIELDS["chatdgc_open_here"]), {"request_id", "conversation_id"})
        chat = "chat_" + "a" * 32
        self.assertIsNone(ep.event_error({"type": "chatdgc_held", "seq": 1, "conversation_id": chat, "state": "elsewhere",
                                          "pid": 42}))
        self.assertIsNone(ep.event_error({"type": "chatdgc_held", "seq": 2, "conversation_id": chat, "state": "here",
                                          "request_id": "cd-open-3"}))
        self.assertIsNotNone(ep.event_error({"type": "chatdgc_held", "seq": 3, "conversation_id": chat, "state": "gone"}))
        self.assertIsNone(ep.command_error({"type": "chatdgc_shown", "conversation_ids": [chat]}))
        self.assertIsNone(ep.command_error({"type": "chatdgc_open_here", "request_id": "r", "conversation_id": chat}))


@unittest.skipUnless(POSIX_SOCKETS, "a backend lets a chat go over its socket on Linux and macOS")
class ChatDGCOpenHereIntegrationTests(unittest.TestCase):
    maxDiff = None

    def home(self, world, name, *, shows=True):
        """A window's Sessions home backend. `shows`: its editor says which chats its tabs show (an older one never
        does, and holds nothing)."""
        serve = Serve(world, name=name)
        ready = serve.wait(lambda e: e.get("type") == "ready", 90)
        serve.send({"type": "set_detach_chatdgc", "keep_running": True})
        if shows:
            serve.send({"type": "chatdgc_shown", "conversation_ids": []})
        return serve, ready

    def open_chat(self, serve, request_id, conversation_id=None):
        serve.send({"type": "chatdgc_open", "request_id": request_id,
                    **({"conversation_id": conversation_id} if conversation_id else {})})
        return serve.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == request_id, 60)

    def send(self, serve, request_id, chat, text):
        serve.send({"type": "chatdgc_send", "request_id": request_id, "conversation_id": chat, "text": text})

    def ended(self, serve, request_id, timeout=90):
        return serve.wait(lambda e: e.get("type") == "chatdgc_turn" and e.get("state") == "ended"
                          and e.get("request_id") == request_id, timeout)

    def refused(self, serve, request_id):
        error = serve.wait(lambda e: e.get("type") == "chatdgc_error" and e.get("request_id") == request_id, 30)
        self.assertIn(HELD, error["message"])

    def holds(self, world, pid, chat):
        return chat in ((world.note(pid) or {}).get("chatdgc_held") or [])

    def answering(self, world, pid, chat):
        return chat in [c.get("conversation_id") for c in (world.note(pid) or {}).get("chatdgc") or []]

    def saved(self, world, chat):
        return json.loads(next((world.home / ".dgc" / "chat").rglob(f"{chat}.json")).read_text())

    def assert_valid(self, *serves):
        for serve in serves:
            for event in serve.events:
                self.assertIsNone(ep.event_error(event), event)

    def test_it_is_offered(self):
        world = World(self, scale=1.0, handler=ChatModel)
        _a, ready = self.home(world, "home-a")
        self.assertEqual(ready["capabilities"]["detach"]["chatdgc_open_here"], 1)

    def test_one_window_writes_and_open_here_moves_an_idle_chat_and_back(self):
        world = World(self, scale=0.05, handler=ChatModel)
        a, _ = self.home(world, "home-a")
        b, _ = self.home(world, "home-b")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        self.send(a, "s1", chat, "CHAT_COUNT 3")
        self.ended(a, "s1")
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        wait_until(lambda: self.holds(world, a.proc.pid, chat), timeout=20, what="A's note to name the chat it shows")

        # B opens it: as last saved, read-only, and told who has it.
        opened = self.open_chat(b, "o2", chat)
        self.assertFalse(opened["busy"])
        self.assertEqual(chat_lines(opened["messages"][-1]["text"]), ["1", "2", "3"])
        elsewhere = b.wait(lambda e: held(e, "elsewhere", chat), 30)
        self.assertEqual(elsewhere["pid"], a.proc.pid)
        self.assertGreater(elsewhere["seq"], opened["seq"], "the chat first, then what holds it")
        self.assertFalse(self.holds(world, b.proc.pid, chat), "B holds nothing it only shows")
        self.send(b, "s2", chat, "CHAT_COUNT 2")
        self.refused(b, "s2")

        # Open here in B: A lets it go and goes read-only; B opens it from disk and writes to it.
        b.send({"type": "chatdgc_open_here", "request_id": "h1", "conversation_id": chat})
        here = b.wait(lambda e: held(e, "here", chat) and e.get("request_id") == "h1", 40)
        taken = b.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "h1", 30)
        self.assertGreater(taken["seq"], here["seq"])
        self.assertFalse(taken["busy"])
        self.assertEqual(chat_lines(taken["messages"][-1]["text"]), ["1", "2", "3"])
        a.wait(lambda e: held(e, "moved", chat), 30)
        wait_until(lambda: self.holds(world, b.proc.pid, chat) and not self.holds(world, a.proc.pid, chat),
                   timeout=20, what="the notes to say B holds it now")
        self.send(a, "s3", chat, "CHAT_COUNT 2")
        self.refused(a, "s3")
        self.send(b, "s4", chat, "CHAT_COUNT 5")
        wait_until(lambda: self.answering(world, b.proc.pid, chat), timeout=30, what="B's own backend to answer")
        self.assertFalse(self.answering(world, a.proc.pid, chat))
        self.ended(b, "s4")
        self.assertEqual(chat_lines(self.saved(world, chat)["messages"][-1]["text"]), ["1", "2", "3", "4", "5"])

        # Open here back in A, idle: the same way.
        a.send({"type": "chatdgc_open_here", "request_id": "h2", "conversation_id": chat})
        back = a.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "h2", 40)
        self.assertEqual(chat_lines(back["messages"][-1]["text"]), ["1", "2", "3", "4", "5"], "B's reply, from disk")
        b.wait(lambda e: held(e, "moved", chat), 30)
        self.send(a, "s5", chat, "CHAT_COUNT 1")
        self.ended(a, "s5")
        self.send(b, "s6", chat, "CHAT_COUNT 1")
        self.refused(b, "s6")
        self.assertEqual(len(self.saved(world, chat)["messages"]), 6, "no message lost, none written twice")
        self.assert_valid(a, b)

    def test_open_here_mid_reply_streams_on_here_each_line_once_then_the_chat_is_this_windows(self):
        world = World(self, scale=0.05, handler=ChatModel)
        a, _ = self.home(world, "home-a")
        b, _ = self.home(world, "home-b")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        self.send(a, "s1", chat, "CHAT_COUNT 300")
        a.wait(lambda e: e.get("type") == "chatdgc_delta" and "12\n" in e.get("text", ""), 60)
        wait_until(lambda: self.holds(world, a.proc.pid, chat), timeout=20, what="A's note")

        self.open_chat(b, "o2", chat)
        b.wait(lambda e: held(e, "elsewhere", chat), 30)
        b.send({"type": "chatdgc_open_here", "request_id": "h1", "conversation_id": chat})
        opened = b.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "h1", 40)
        self.assertTrue(opened["busy"], "the reply is still being written")
        reply_id = opened["reply_id"]
        shown = opened["messages"][-1]
        self.assertEqual((shown["id"], shown["role"]), (reply_id, "assistant"), "the reply so far is in it")
        self.assertGreaterEqual(len(chat_lines(shown["text"])), 12)
        moved = a.wait(lambda e: held(e, "moved", chat), 30)
        # A message typed here while it answers waits, and goes once the chat is this window's.
        self.send(b, "s2", chat, "CHAT_COUNT 4")

        b.wait(lambda e: e.get("type") == "chatdgc_turn" and e.get("state") == "ended" and e.get("reply_id") == reply_id, 120)
        after = "".join(e.get("text", "") for e in b.events if e.get("type") == "chatdgc_delta"
                        and e.get("message_id") == reply_id and e["seq"] > opened["seq"])
        lines = chat_lines(shown["text"] + after)
        self.assertEqual(lines, [str(n) for n in range(1, 301)], "every line once: what it opened with, then the rest")
        self.assertFalse([e for e in a.events if e.get("type") == "chatdgc_delta" and e["seq"] > moved["seq"]],
                         "A shows it as it was: nothing more of it streams there")
        final = [e["message"] for e in b.events if e.get("type") == "chatdgc_message" and e["message"]["id"] == reply_id][-1]
        self.assertEqual(chat_lines(final["text"]), lines)

        # The move: the chat is B's own now, and what waited goes, on B's backend.
        moved_here = b.wait(lambda e: held(e, "here", chat) and "request_id" not in e, 60)
        started = b.wait(lambda e: e.get("type") == "chatdgc_turn" and e.get("state") == "started"
                         and e.get("request_id") == "s2", 60)
        self.assertGreater(started["seq"], moved_here["seq"], "it waited for the move")
        wait_until(lambda: self.answering(world, b.proc.pid, chat), timeout=30, what="B's own backend to answer it")
        self.assertFalse(self.answering(world, a.proc.pid, chat), "A's backend has let it go")
        self.ended(b, "s2")
        messages = self.saved(world, chat)["messages"]
        self.assertEqual([m["role"] for m in messages], ["user", "assistant", "user", "assistant"])
        self.assertEqual(chat_lines(messages[1]["text"]), lines)
        self.assertEqual(chat_lines(messages[3]["text"]), ["1", "2", "3", "4"])
        self.send(a, "s3", chat, "CHAT_COUNT 1")
        self.refused(a, "s3")

        # Open here back in A, idle.
        a.send({"type": "chatdgc_open_here", "request_id": "h2", "conversation_id": chat})
        back = a.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "h2", 40)
        self.assertEqual(len(back["messages"]), 4)
        b.wait(lambda e: held(e, "moved", chat) and e["seq"] > moved_here["seq"], 30)
        self.assert_valid(a, b)

    def test_open_here_back_mid_reply_takes_the_live_reply_back(self):
        world = World(self, scale=0.05, handler=ChatModel)
        a, _ = self.home(world, "home-a")
        b, _ = self.home(world, "home-b")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        self.send(a, "s1", chat, "CHAT_COUNT 400")
        a.wait(lambda e: e.get("type") == "chatdgc_delta" and "10\n" in e.get("text", ""), 60)
        wait_until(lambda: self.holds(world, a.proc.pid, chat), timeout=20, what="A's note")
        b.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        b.send({"type": "chatdgc_open_here", "request_id": "h1", "conversation_id": chat})
        taken = b.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "h1", 40)
        self.assertTrue(taken["busy"])
        b.wait(lambda e: e.get("type") == "chatdgc_delta" and e["seq"] > taken["seq"], 30)

        # A takes it back while A's own backend is still writing it: live again in A, read-only in B.
        a.send({"type": "chatdgc_open_here", "request_id": "h2", "conversation_id": chat})
        back = a.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "h2", 40)
        self.assertTrue(back["busy"], "still being written")
        reply_id = back["reply_id"]
        moved = b.wait(lambda e: held(e, "moved", chat) and e["seq"] > taken["seq"], 30)
        a.wait(lambda e: e.get("type") == "chatdgc_turn" and e.get("state") == "ended" and e.get("reply_id") == reply_id, 120)
        after = "".join(e.get("text", "") for e in a.events if e.get("type") == "chatdgc_delta"
                        and e.get("message_id") == reply_id and e["seq"] > back["seq"])
        self.assertEqual(chat_lines(back["messages"][-1]["text"] + after), [str(n) for n in range(1, 401)])
        self.assertFalse([e for e in b.events if e.get("type") == "chatdgc_delta" and e["seq"] > moved["seq"]],
                         "B shows it as it was once A took it back")
        self.send(a, "s2", chat, "CHAT_COUNT 1")
        self.ended(a, "s2")
        self.send(b, "s3", chat, "CHAT_COUNT 1")
        self.refused(b, "s3")
        self.assert_valid(a, b)

    def test_a_reply_left_running_with_no_window_opens_live_in_another_window(self):
        world = World(self, scale=0.05, handler=ChatModel)               # 2 minutes with no work are 6s
        a, _ = self.home(world, "home-a")
        b, _ = self.home(world, "home-b")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        self.send(a, "s1", chat, "CHAT_COUNT 200")
        a.wait(lambda e: e.get("type") == "chatdgc_delta" and "5\n" in e.get("text", ""), 60)
        writer = a.proc.pid
        a.send({"type": "detach"})
        a.close_stdin()
        wait_until(lambda: (world.note(writer) or {}).get("attached") is False, timeout=20, what="A's window to go")
        self.assertTrue(self.holds(world, writer, chat), "still writing it, with no window")

        b.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        b.send({"type": "chatdgc_open_here", "request_id": "h1", "conversation_id": chat})
        opened = b.wait(lambda e: e.get("type") == "chatdgc_opened" and e.get("request_id") == "h1", 40)
        self.assertTrue(opened["busy"])
        reply_id = opened["reply_id"]
        b.wait(lambda e: e.get("type") == "chatdgc_turn" and e.get("state") == "ended" and e.get("reply_id") == reply_id, 120)
        after = "".join(e.get("text", "") for e in b.events if e.get("type") == "chatdgc_delta"
                        and e.get("message_id") == reply_id and e["seq"] > opened["seq"])
        self.assertEqual(chat_lines(opened["messages"][-1]["text"] + after), [str(n) for n in range(1, 201)])
        b.wait(lambda e: held(e, "here", chat) and "request_id" not in e, 60)
        self.send(b, "s2", chat, "CHAT_COUNT 2")
        self.ended(b, "s2")
        # Its link gone and its reply done, the windowless writer follows the usual rules: it saves and exits.
        wait_until(lambda: not alive(writer), timeout=60, what="the windowless writer's idle exit")
        self.assertEqual(chat_lines(self.saved(world, chat)["messages"][-1]["text"]), ["1", "2"])
        self.assert_valid(b)

    def test_a_chat_its_holder_closes_is_this_windows_by_itself(self):
        world = World(self, scale=0.05, handler=ChatModel)
        a, _ = self.home(world, "home-a")
        b, _ = self.home(world, "home-b")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        self.send(a, "s1", chat, "CHAT_COUNT 2")
        self.ended(a, "s1")
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        wait_until(lambda: self.holds(world, a.proc.pid, chat), timeout=20, what="A's note")
        b.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        self.open_chat(b, "o2", chat)
        elsewhere = b.wait(lambda e: held(e, "elsewhere", chat), 30)
        a.send({"type": "chatdgc_shown", "conversation_ids": []})            # A closes its tab
        here = b.wait(lambda e: held(e, "here", chat) and e["seq"] > elsewhere["seq"], 30)
        self.assertNotIn("request_id", here, "nobody asked: the screen opens it again, here")
        self.send(b, "s2", chat, "CHAT_COUNT 1")
        self.ended(b, "s2")
        self.assert_valid(a, b)

    def test_an_editor_that_never_says_what_it_shows_holds_nothing_as_before(self):
        world = World(self, scale=1.0, handler=ChatModel)
        a, _ = self.home(world, "home-old-editor", shows=False)
        b, _ = self.home(world, "home-b")
        chat = self.open_chat(a, "o1")["conversation"]["id"]
        self.send(a, "s1", chat, "CHAT_COUNT 2")
        self.ended(a, "s1")
        a.send({"type": "chatdgc_list", "request_id": "l1"})
        a.wait(lambda e: e.get("type") == "chatdgc_chats", 30)
        self.assertNotIn("chatdgc_held", world.note(a.proc.pid) or {})
        opened = self.open_chat(b, "o2", chat)
        self.send(b, "s2", chat, "CHAT_COUNT 1")
        self.ended(b, "s2")
        self.assertFalse([e for e in b.events if e.get("type") == "chatdgc_held"], "today's behaviour: no bar")
        self.assertGreater(len(self.saved(world, chat)["messages"]), len(opened["messages"]))


if __name__ == "__main__":
    unittest.main()
