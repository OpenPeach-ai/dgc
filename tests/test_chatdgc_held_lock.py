"""One holder per ChatDGC chat, for real: a window's DGC holds a chat only while it holds that chat's lock.

A process's note says which chats it holds, but notes are files written now and then, so two windows that opened (or
took with Open here) one chat in the same instant both read "nobody holds it" and both held it. Now each held chat has
an exclusive flock (dgc/chatdgc/held.py): of two at once exactly one gets it, the other shows the chat read-only with
Open here; the kernel frees it when its process dies; and where no lock can be made the notes decide as before.

Real `dgc serve` homes on one HOME, as VS Code windows are; a model that counts slowly.
"""
from __future__ import annotations

import errno
import fcntl
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

from test_chatdgc_open_here import HELD, held  # noqa: E402
from test_session_detach import POSIX_SOCKETS, ChatModel, Serve, World, wait_until  # noqa: E402

from dgc import editor_protocol as ep  # noqa: E402
from dgc.chatdgc.held import HeldLocks  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
A_CHAT = "chat_" + "a" * 32
B_CHAT = "chat_" + "b" * 32
NO_LOCK = "no chat lock can be made"


def try_lock(path: Path):
    """The test's own try at a chat's lock: True (free; let go again at once), False (a process holds it), None (no
    such lock file)."""
    try:
        fd = os.open(str(path), os.O_RDWR | os.O_NOFOLLOW)
    except FileNotFoundError:
        return None
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except BlockingIOError:
        return False
    finally:
        os.close(fd)


class HeldLocksTests(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix="dgc-held-"))
        self.addCleanup(shutil.rmtree, self.base, True)
        self.folder = self.base / "chat" / "held"
        self.lines: list[str] = []

    def locks(self):
        found = HeldLocks(self.folder, log=self.lines.append)
        self.addCleanup(found.close)
        return found

    def test_one_holder_per_chat_and_its_file_stays(self):
        mine, theirs = self.locks(), self.locks()       # two descriptions of one file: as two processes are
        self.assertIs(mine.take(A_CHAT), True)
        self.assertIs(mine.take(A_CHAT), True, "taken again: still this one's")
        self.assertIs(theirs.take(A_CHAT), False, "held elsewhere")
        self.assertIs(theirs.take(B_CHAT), True, "another chat is another lock")
        self.assertEqual(oct(self.folder.stat().st_mode & 0o777), "0o700")
        lock = self.folder / f"{A_CHAT}.lock"
        self.assertEqual(oct(lock.stat().st_mode & 0o777), "0o600")
        mine.release(A_CHAT)
        self.assertTrue(lock.exists(), "never removed: someone may hold it")
        self.assertIs(theirs.take(A_CHAT), True)
        self.assertEqual(theirs.held(), {A_CHAT, B_CHAT})
        theirs.keep_only({B_CHAT})
        self.assertEqual(theirs.held(), {B_CHAT})
        self.assertIs(mine.take(A_CHAT), True)
        self.assertIsNone(mine.take("../../etc/passwd"), "only a chat's own id names a lock")
        self.assertEqual(self.lines, [])

    def test_a_taker_waits_a_moment_for_the_holder_to_drop_it(self):
        mine, theirs = self.locks(), self.locks()
        mine.take(A_CHAT)
        threading.Timer(0.3, mine.release, args=(A_CHAT,)).start()
        started = time.monotonic()
        self.assertIs(theirs.take_within(A_CHAT, 2.0), True)
        self.assertLess(time.monotonic() - started, 1.5)
        started = time.monotonic()
        self.assertIs(mine.take_within(A_CHAT, 0.3), False, "nobody drops it: refused once the moment is over")
        self.assertGreaterEqual(time.monotonic() - started, 0.3)

    def test_a_killed_holder_frees_it_at_once(self):
        child = subprocess.Popen(
            [sys.executable, "-c", "import sys, time; from dgc.chatdgc.held import HeldLocks; "
             f"print(HeldLocks(sys.argv[1]).take({A_CHAT!r}), flush=True); time.sleep(60)", str(self.folder)],
            cwd=str(ROOT), env=dict(os.environ, PYTHONPATH=str(ROOT)), stdout=subprocess.PIPE, text=True)
        self.addCleanup(lambda: child.poll() is None and (child.kill(), child.wait()))
        self.assertEqual(child.stdout.readline().strip(), "True")
        mine = self.locks()
        self.assertIs(mine.take(A_CHAT), False)
        os.kill(child.pid, signal.SIGKILL)               # the child this test started, by its pid
        child.wait(10)
        child.stdout.close()
        self.assertIs(mine.take(A_CHAT), True, "nothing stale: the kernel let go of it with the process")

    def test_where_no_lock_can_be_made_it_says_so_once_and_never_blocks(self):
        self.folder.parent.mkdir(parents=True)
        self.folder.write_text("")                      # not a folder
        locks = self.locks()
        self.assertIsNone(locks.take(A_CHAT))
        self.assertFalse(locks.usable)
        self.assertIsNone(locks.take(B_CHAT))
        self.assertIsNone(locks.take_within(A_CHAT, 1.0), "no waiting where nothing can be locked")
        self.assertEqual(len(self.lines), 1, self.lines)
        self.assertIn(NO_LOCK, self.lines[0])

    def test_a_link_in_place_of_a_lock_file_is_refused(self):
        self.folder.mkdir(parents=True, mode=0o700)
        (self.base / "elsewhere").write_text("")
        (self.folder / f"{A_CHAT}.lock").symlink_to(self.base / "elsewhere")
        locks = self.locks()
        self.assertIsNone(locks.take(A_CHAT))
        self.assertEqual(len(self.lines), 1)

    def test_a_filesystem_without_flock_falls_back(self):
        locks = self.locks()
        with mock.patch("fcntl.flock", side_effect=OSError(errno.ENOLCK, "No locks available")):
            self.assertIsNone(locks.take(A_CHAT))
        self.assertIsNone(locks.take(A_CHAT), "the notes alone from then on")
        self.assertEqual(len(self.lines), 1)
        self.assertIn("No locks available", self.lines[0])


class SaidInOrderTests(unittest.TestCase):
    def test_here_is_never_said_after_another_window_took_the_chat(self):
        """A window that just had a chat can lose it to another's Open here before it says "here": what it says
        then is what is true, so the "moved" it hears is never followed by a stale "here"."""
        from types import SimpleNamespace
        from dgc.chatdgc.service import ChatService
        base = Path(tempfile.mkdtemp(prefix="dgc-held-said-"))
        self.addCleanup(shutil.rmtree, base, True)
        said = []
        engine = SimpleNamespace(store=SimpleNamespace(root=base / "chat"), unreviewed_chars=lambda *a, **k: 0)
        service = ChatService(lambda kind, **fields: said.append({"type": kind, **fields}),
                              SimpleNamespace(get=lambda key, default=None: default), engine=engine)
        service._shown.add(A_CHAT)
        service._held(A_CHAT, {"state": "here"}, "h1")
        service._away[A_CHAT] = {"state": "moved", "pid": 4242}         # taken a moment later
        service._held(A_CHAT, {"state": "here"}, "h2")
        self.assertEqual([(e["state"], e.get("pid"), e.get("request_id")) for e in said],
                         [("here", None, "h1"), ("moved", 4242, "h2")])


@unittest.skipUnless(POSIX_SOCKETS, "a backend holds chats for its window on Linux and macOS")
class ChatDGCLockIntegrationTests(unittest.TestCase):
    maxDiff = None

    def home(self, world, name):
        serve = Serve(world, name=name)
        serve.wait(lambda e: e.get("type") == "ready", 90)
        serve.send({"type": "set_detach_chatdgc", "keep_running": True})
        serve.send({"type": "chatdgc_shown", "conversation_ids": []})
        return serve

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

    def barrier(self, serve, request_id):
        """Every command sent before this one has been dispatched (they run one at a time) and said what it says."""
        serve.send({"type": "chatdgc_list", "request_id": request_id})
        serve.wait(lambda e: e.get("type") == "chatdgc_chats" and e.get("request_id") == request_id, 30)

    def holds(self, world, serve, chat):
        return chat in ((world.note(serve.proc.pid) or {}).get("chatdgc_held") or [])

    def holders(self, world, chat, serves):
        return [serve for serve in serves if self.holds(world, serve, chat)]

    def last_seq(self, serve):
        return max((e.get("seq", 0) for e in serve.events), default=0)

    def a_saved_chat(self, world, serve):
        chat = self.open_chat(serve, "o0")["conversation"]["id"]
        self.send(serve, "s0", chat, "CHAT_COUNT 2")
        self.ended(serve, "s0")
        return chat

    def assert_valid(self, *serves):
        for serve in serves:
            for event in serve.events:
                self.assertIsNone(ep.event_error(event), event)

    def test_two_windows_opening_one_chat_in_the_same_instant_one_holds_it(self):
        world = World(self, scale=0.05, handler=ChatModel)
        a, b = self.home(world, "home-a"), self.home(world, "home-b")
        chat = self.a_saved_chat(world, a)
        a.send({"type": "chatdgc_shown", "conversation_ids": []})        # its tab closed: nobody holds it
        wait_until(lambda: self.holders(world, chat, (a, b)) == [], timeout=30,
                   what="A to let it go once its name and follow-ups are written")
        for round_ in range(20):
            marks = {serve: len(serve.events) for serve in (a, b)}
            for serve in (a, b):                     # both windows open it at once, each tab saying so
                serve.send({"type": "chatdgc_open", "request_id": f"r{round_}", "conversation_id": chat})
            for serve in (a, b):
                serve.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
            for serve in (a, b):
                self.barrier(serve, f"b{round_}")
            holding = self.holders(world, chat, (a, b))
            told = [serve for serve in (a, b) if any(held(e, "elsewhere", chat) for e in serve.events[marks[serve]:])]
            self.assertEqual(len(holding), 1, f"round {round_}: one window holds it, not {len(holding)}")
            self.assertEqual(told, [serve for serve in (a, b) if serve is not holding[0]],
                             f"round {round_}: the other shows it read-only")
            self.assertEqual((world.note(holding[0].proc.pid) or {}).get("chatdgc_locks"), 1)
            for serve in (a, b):                     # both tabs close: the next round starts with nobody holding it
                serve.send({"type": "chatdgc_shown", "conversation_ids": []})
            for serve in (a, b):
                self.barrier(serve, f"c{round_}")
            self.assertEqual(self.holders(world, chat, (a, b)), [], f"round {round_}: let go")

        # Once more, and only the one that holds it writes.
        for serve in (a, b):
            serve.send({"type": "chatdgc_open", "request_id": "r-last", "conversation_id": chat})
        for serve in (a, b):
            serve.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
            self.barrier(serve, "b-last")
        winner, = self.holders(world, chat, (a, b))
        other = b if winner is a else a
        self.send(other, "w1", chat, "CHAT_COUNT 1")
        self.refused(other, "w1")
        self.send(winner, "w2", chat, "CHAT_COUNT 1")
        self.ended(winner, "w2")
        self.assert_valid(a, b)

    def test_two_open_heres_at_once_one_wins_and_the_other_stays_read_only(self):
        world = World(self, scale=0.05, handler=ChatModel)
        a, b, c = self.home(world, "home-a"), self.home(world, "home-b"), self.home(world, "home-c")
        chat = self.a_saved_chat(world, a)
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        wait_until(lambda: self.holds(world, a, chat), timeout=20, what="A's note")
        for serve, request_id in ((b, "o1"), (c, "o2")):
            self.open_chat(serve, request_id, chat)
            serve.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
            serve.wait(lambda e: held(e, "elsewhere", chat), 30)
        holder, racers = a, (b, c)
        for round_ in range(3):
            mark = {serve: self.last_seq(serve) for serve in (a, b, c)}
            request_id = f"h{round_}"
            for serve in racers:                     # Open here pressed in two windows at the same moment
                serve.send({"type": "chatdgc_open_here", "request_id": request_id, "conversation_id": chat})
            outcome = {}
            for serve in racers:
                answer = serve.wait(lambda e: e.get("request_id") == request_id and e.get("type") in (
                    "chatdgc_held", "chatdgc_error"), 40)
                outcome[serve] = answer["state"] if answer["type"] == "chatdgc_held" else answer["message"]

            def last_said(serve):
                said = [e["state"] for e in serve.events if e.get("type") == "chatdgc_held"
                        and e.get("conversation_id") == chat and e["seq"] > mark[serve]]
                return said[-1] if said else None

            def settled():
                # One window has it, by its note, and what every window heard last is what is true: here there,
                # read-only in the other two. Both pressed at once: one won and the other is told it lost. Or one
                # pressed a moment later, once the first one's note named it: it took it from that one ("moved").
                holding = self.holders(world, chat, (a, b, c))
                if len(holding) != 1 or holding[0] not in racers:
                    return None
                won, = holding
                lost, = [serve for serve in racers if serve is not won]
                said = (last_said(won), last_said(lost), last_said(holder))
                return (won, lost) if said in (("here", "elsewhere", "moved"), ("here", "moved", "moved")) else None
            winner, loser = wait_until(settled, timeout=20, what=f"round {round_}: one holder, every window told so")
            self.assertEqual(outcome[winner], "here")
            if outcome[loser] not in ("here", "moved"):
                self.assertIn("at the same moment", outcome[loser])
            self.assertIs(try_lock(world.home / ".dgc" / "chat" / "held" / f"{chat}.lock"), False)
            self.send(loser, f"x{round_}", chat, "CHAT_COUNT 1")
            self.refused(loser, f"x{round_}")
            self.send(holder, f"y{round_}", chat, "CHAT_COUNT 1")
            self.refused(holder, f"y{round_}")
            self.send(winner, f"w{round_}", chat, "CHAT_COUNT 1")
            self.ended(winner, f"w{round_}")
            holder, racers = winner, tuple(serve for serve in (a, b, c) if serve is not winner)
        self.assert_valid(a, b, c)

    def test_a_holder_killed_frees_the_chat_at_once(self):
        world = World(self, scale=0.05, handler=ChatModel)
        a, b = self.home(world, "home-a"), self.home(world, "home-b")
        chat = self.a_saved_chat(world, a)
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        wait_until(lambda: self.holds(world, a, chat), timeout=20, what="A's note")
        lock = world.home / ".dgc" / "chat" / "held" / f"{chat}.lock"
        self.assertIs(try_lock(lock), False, "A's DGC holds the chat's lock")
        self.open_chat(b, "o1", chat)
        b.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        b.wait(lambda e: held(e, "elsewhere", chat), 30)

        os.kill(a.proc.pid, signal.SIGKILL)          # the backend this test started, by its pid
        a.proc.wait(10)
        killed = time.monotonic()
        self.assertIs(try_lock(lock), True, "nothing stale: the kernel let go of it with the process")
        b.send({"type": "chatdgc_open_here", "request_id": "h1", "conversation_id": chat})
        b.wait(lambda e: held(e, "here", chat) and e.get("request_id") == "h1", 20)
        self.assertLess(time.monotonic() - killed, 5.0, "at once")
        wait_until(lambda: self.holds(world, b, chat), timeout=10, what="B's note")
        self.assertIs(try_lock(lock), False, "B's DGC holds it now")
        self.send(b, "s1", chat, "CHAT_COUNT 1")
        self.ended(b, "s1")
        self.assert_valid(b)

    def test_held_before_any_note_says_so_read_only_and_its_holder_named_once_one_does(self):
        world = World(self, scale=0.05, handler=ChatModel)
        b = self.home(world, "home-b")
        chat = self.a_saved_chat(world, b)
        b.send({"type": "chatdgc_shown", "conversation_ids": []})
        wait_until(lambda: not self.holds(world, b, chat), timeout=30, what="B to let it go")

        # Another holder has the chat's lock and no note names it yet (this test process, standing in for a window).
        locks = HeldLocks(world.home / ".dgc" / "chat" / "held")
        self.addCleanup(locks.close)
        self.assertIs(locks.take(chat), True)
        mark = self.last_seq(b)
        self.open_chat(b, "o1", chat)
        b.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        gap = b.wait(lambda e: held(e, "elsewhere", chat) and e["seq"] > mark, 30)
        self.assertNotIn("pid", gap, "nobody named yet: just 'open in another window'")
        self.send(b, "s1", chat, "CHAT_COUNT 1")
        self.refused(b, "s1")
        self.assertFalse(self.holds(world, b, chat))

        # Its note comes: B asks again shortly and names it.
        from dgc import peers
        note = world.home / ".dgc" / "peers" / f"{os.getpid()}.json"
        self.addCleanup(lambda: note.unlink(missing_ok=True))
        note.write_text(json.dumps({
            "pid": os.getpid(), "proc_start": peers._proc_start(os.getpid()), "kind": "serve", "heartbeat": time.time(),
            "socket": str(world.base / "nobody.sock"), "instance": "test", "chatdgc_take": 1, "chatdgc_locks": 1,
            "chatdgc_held": [chat]}))
        named = b.wait(lambda e: held(e, "elsewhere", chat) and e.get("pid") == os.getpid(), 30)
        self.assertGreater(named["seq"], gap["seq"])

        # It lets go: B's by itself, as a chat nobody else has open always is.
        note.unlink()
        locks.release(chat)
        here = b.wait(lambda e: held(e, "here", chat) and e["seq"] > named["seq"], 30)
        self.assertNotIn("request_id", here)
        wait_until(lambda: self.holds(world, b, chat), timeout=20, what="B's note")
        self.assertIs(locks.take(chat), False, "B's lock now")
        self.send(b, "s2", chat, "CHAT_COUNT 1")
        self.ended(b, "s2")
        self.assert_valid(b)

    def test_where_no_lock_can_be_made_the_notes_decide_as_before(self):
        world = World(self, scale=0.05, handler=ChatModel)
        (world.home / ".dgc" / "chat").mkdir(mode=0o700)
        (world.home / ".dgc" / "chat" / "held").write_text("")      # where the locks go isn't a folder
        a, b = self.home(world, "home-a"), self.home(world, "home-b")
        chat = self.a_saved_chat(world, a)
        a.send({"type": "chatdgc_shown", "conversation_ids": [chat]})
        wait_until(lambda: self.holds(world, a, chat), timeout=20, what="A's note")
        self.assertNotIn("chatdgc_locks", world.note(a.proc.pid), "its note alone says what it holds")

        # Today's behaviour: B is told by A's note, and Open here moves it.
        self.open_chat(b, "o1", chat)
        elsewhere = b.wait(lambda e: held(e, "elsewhere", chat), 30)
        self.assertEqual(elsewhere["pid"], a.proc.pid)
        self.send(b, "s1", chat, "CHAT_COUNT 1")
        self.refused(b, "s1")
        b.send({"type": "chatdgc_open_here", "request_id": "h1", "conversation_id": chat})
        b.wait(lambda e: held(e, "here", chat) and e.get("request_id") == "h1", 40)
        a.wait(lambda e: held(e, "moved", chat), 30)
        wait_until(lambda: self.holders(world, chat, (a, b)) == [b], timeout=20, what="the notes to name B")
        self.send(b, "s2", chat, "CHAT_COUNT 1")
        self.ended(b, "s2")
        self.send(a, "s3", chat, "CHAT_COUNT 1")
        self.refused(a, "s3")
        for serve in (a, b):
            self.assertEqual(serve.stderr().count(NO_LOCK), 1, "said once, in serve.log")
        self.assert_valid(a, b)


if __name__ == "__main__":
    unittest.main()
