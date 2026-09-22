"""A queued follow-up must carry the paste, not the chip that stands in for it.

A long paste collapses to `[Pasted text #1 +40 lines]` in the composer. Enter expanded that back
to the pasted body before sending. Tab — which queues the message behind the running turn — did
not: `_route_followup` stores the string verbatim and the next turn submits it unchanged, so the
model received the placeholder and the pasted text was silently dropped.

The chips also belong to one chat. They used to live on the fleet, so sending in one chat cleared
the store that another chat's stashed draft still referred to.
"""
from __future__ import annotations

import os
import sys
import tempfile
import unittest

import os as _os, sys as _sys                             # noqa: E402
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))

if "dgc.config" not in sys.modules and "dgc-tests-home-" not in os.environ.get("HOME", ""):
    _HOME = tempfile.mkdtemp(prefix="dgc-tests-home-")
    os.environ["HOME"] = os.environ["USERPROFILE"] = os.path.realpath(_HOME)

from prompt_toolkit.buffer import Buffer                  # noqa: E402

from dgc.tui import TUI                                   # noqa: E402

PASTE = "def broken():\n" + "\n".join(f"    step_{n}()" for n in range(40))
CHIP = "[Pasted text #1 +40 lines]"


class _Session:
    """Only what the paste store needs of a session: its own draft and its own chips."""

    def __init__(self, draft=""):
        self.draft = draft
        self.pastes: dict[int, str] = {}


class PasteCase(unittest.TestCase):
    def tui(self, *, sessions=0):
        t = object.__new__(TUI)
        t.input_buf = Buffer(multiline=True)
        t._input = None
        t._naming = False
        t.sent = []
        t.queued = []
        if sessions:
            t._sessions = [_Session() for _ in range(sessions)]
            t._active_idx = 0
        t._pastes = {1: PASTE}
        return t

    @staticmethod
    def wire(t, *, send="sent", queue="queued"):
        t._dispatch_composer_text = lambda text: (t.sent.append(text), send)[1]
        t._route_followup = lambda text, queue_only=False: (t.queued.append(text), queue)[1]


class TabQueuePasteTests(PasteCase):
    def test_the_chip_expands_to_the_pasted_text(self):
        t = self.tui()
        out = t._expand_pastes(f"{CHIP} please fix this")
        self.assertIn("def broken():", out)
        self.assertNotIn("[Pasted text #1", out)

    def test_the_tab_handler_expands_before_queueing(self):
        t = self.tui()
        self.wire(t)
        t.input_buf.insert_text(f"{CHIP} please fix this")
        t._queue_composer_text(t.input_buf.text.strip())
        self.assertEqual(len(t.queued), 1)
        self.assertIn("def broken():", t.queued[0],
                      "Tab queues the composer text; without expanding, the model gets the chip")
        self.assertNotIn("[Pasted text #1", t.queued[0])
        self.assertEqual(t.input_buf.text, "", "the queued message leaves the composer")
        self.assertEqual(t._pastes, {}, "its chips go with it")

    def test_enter_still_expands(self):
        t = self.tui()
        self.wire(t)
        t._send_composer_text(f"{CHIP} please fix this")
        self.assertEqual(len(t.sent), 1)
        self.assertIn("def broken():", t.sent[0])
        self.assertNotIn("[Pasted text #1", t.sent[0])

    def test_a_refused_send_keeps_the_chip_collapsed_for_the_retry(self):
        t = self.tui()
        self.wire(t, send="full")
        t._send_composer_text(f"{CHIP} please fix this")
        self.assertIn("def broken():", t.sent[0], "the model still saw the real text")
        self.assertEqual(t.input_buf.text, f"{CHIP} please fix this",
                         "the composer stays a few rows high, not 41")
        self.assertEqual(t._pastes, {1: PASTE}, "and the chip must still resolve on the retry")

    def test_a_full_queue_keeps_the_composer_as_typed(self):
        t = self.tui()
        self.wire(t, queue="full")
        t.input_buf.insert_text(f"{CHIP} please fix this")
        t._queue_composer_text(t.input_buf.text.strip())
        self.assertEqual(t.input_buf.text, f"{CHIP} please fix this")
        self.assertEqual(t._pastes, {1: PASTE})

    def test_text_without_a_chip_is_untouched(self):
        t = self.tui()
        self.assertEqual(t._expand_pastes("just a normal follow-up"), "just a normal follow-up")


class PastesBelongToOneChatTests(PasteCase):
    """Drafts are stashed per chat; the chips in them have to be too."""

    def test_the_store_follows_the_active_chat(self):
        t = self.tui(sessions=2)
        self.assertEqual(t._pastes, {1: PASTE})
        t._active_idx = 1
        self.assertEqual(t._pastes, {}, "a second chat starts with no chips of its own")
        t._pastes[1] = "other paste"
        t._active_idx = 0
        self.assertEqual(t._pastes, {1: PASTE}, "and does not overwrite the first chat's")

    def test_sending_in_one_chat_does_not_strip_another_chats_draft(self):
        t = self.tui(sessions=2)
        self.wire(t)
        # Chat 1 holds an unsent draft with a chip in it.
        t._sessions[0].draft = f"{CHIP} please fix this"
        # Switch to chat 2, paste there, and send.
        t._active_idx = 1
        t._pastes[1] = "a different paste"
        t._send_composer_text(f"{CHIP} ship it")
        self.assertEqual(t._pastes, {}, "chat 2's own chips are cleared by its send")
        # Back in chat 1: its stashed draft must still resolve.
        t._active_idx = 0
        self.assertEqual(t._pastes, {1: PASTE})
        t._send_composer_text(t._sessions[0].draft)
        self.assertIn("def broken():", t.sent[-1],
                      "the other chat's send must not have dropped this paste")
        self.assertNotIn("[Pasted text #1", t.sent[-1])

    def test_queueing_in_one_chat_does_not_strip_another_chats_draft(self):
        t = self.tui(sessions=2)
        self.wire(t)
        t._active_idx = 1
        t._pastes[1] = "a different paste"
        t.input_buf.insert_text(f"{CHIP} ship it")
        t._queue_composer_text(t.input_buf.text.strip())
        t._active_idx = 0
        self.assertEqual(t._pastes, {1: PASTE})

    def test_with_no_session_yet_the_store_still_works(self):
        t = self.tui()                       # startup: the fleet has no sessions
        self.assertEqual(t._pastes, {1: PASTE})
        t._pastes.clear()
        self.assertEqual(t._pastes, {})


if __name__ == "__main__":
    unittest.main()


class ClosingAChatHandsTheComposerOverTests(PasteCase):
    """Closing the chat you are looking at must not leave its draft in the composer.

    `_close_session` popped the session and clamped `_active_idx` without touching the composer,
    so the closed chat's sentence stayed on screen while `_pastes` now resolved against the
    SURVIVING chat. Enter then sent that chat's pasted text under the closed chat's words -- or,
    if it had no chip of that number, the literal placeholder with the 40 lines dropped.
    """

    def tui_with_close(self, sessions=2):
        t = self.tui(sessions=sessions)
        self.wire(t)
        t._overlay = None
        t._flash = lambda *a, **k: None
        t._invalidate = lambda *a, **k: None
        t._finalize_session_workspace = lambda *a, **k: None
        for s in t._sessions:
            s._closing = False
            s._queue_lock = __import__("threading").Lock()
            s._queue = []
            s._aux_cancel = __import__("threading").Event()
            s._req_answer = None
            s._req_event = __import__("threading").Event()
            s._worker_thread = None
            s.workspace = None
            s.agent = type("A", (), {
                "cancelled": __import__("threading").Event(),
                "monitors": type("M", (), {"new_epoch": lambda self, r: None})(),
                "mcp": type("C", (), {"stop_all": lambda self: None})(),
            })()
        return t

    def test_the_surviving_chats_draft_replaces_the_closed_ones(self):
        t = self.tui_with_close()
        t._sessions[1].draft = "the other chat was writing this"
        t.input_buf.insert_text(f"{CHIP} please fix this")   # chat 0's draft, on screen
        t._close_session(0)
        self.assertEqual(t.input_buf.text, "the other chat was writing this")
        self.assertEqual(t._pastes, {}, "and the chips resolve against the surviving chat")

    def test_the_closed_chats_sentence_cannot_borrow_another_chats_paste(self):
        t = self.tui_with_close()
        t._sessions[1].pastes[1] = "A COMPLETELY DIFFERENT PASTE"
        t.input_buf.insert_text(f"{CHIP} please fix this")
        t._close_session(0)
        t._send_composer_text(t.input_buf.text)
        self.assertNotIn("A COMPLETELY DIFFERENT PASTE", "".join(t.sent),
                         "the surviving chat's paste must not be sent under the closed chat's words")

    def test_closing_a_background_chat_leaves_the_composer_alone(self):
        t = self.tui_with_close(sessions=3)
        t.input_buf.insert_text(f"{CHIP} please fix this")
        t._close_session(2)                                   # not the one on screen
        self.assertEqual(t.input_buf.text, f"{CHIP} please fix this")
        self.assertEqual(t._pastes, {1: PASTE})


class TheRealKeysReachTheseHandlersTests(PasteCase):
    """Pin the WIRING, not just the handlers.

    Testing `_queue_composer_text` directly proves the expansion works; it says nothing about Tab
    still calling it. The original bug was at the call site -- the handler sent `input_buf.text`
    straight to `_route_followup` -- so it could be restored verbatim with every other test in this
    file still green. These drive the real KeyBindings the TUI builds.
    """

    def keyed(self, *, mid_turn):
        import threading
        t = self.tui(sessions=1)
        self.wire(t)
        t._overlay = t._pane = t._req = None
        t._turn = threading.Event()
        if mid_turn:
            t._turn.set()
        t._flash = lambda *a, **k: None
        t._invalidate = lambda *a, **k: None
        return t

    @staticmethod
    def binding(t, name):
        from dgc.tui import TUI
        kb = TUI._keys(t)
        live = [b for b in kb.bindings
                if tuple(getattr(k, "name", str(k)) for k in b.keys) == (name,) and b.filter()]
        assert len(live) == 1, f"{name}: {len(live)} live bindings"
        return live[0]

    def test_tab_mid_turn_queues_the_pasted_text_not_the_chip(self):
        t = self.keyed(mid_turn=True)                # Tab queues only while a turn is running
        t.input_buf.insert_text(f"{CHIP} please fix this")
        self.binding(t, "ControlI").handler(None)    # Tab is ControlI on a terminal
        self.assertEqual(len(t.queued), 1, "Tab must reach the queue path")
        self.assertIn("def broken():", t.queued[0],
                      "the call site must expand; this is where the bug lived")
        self.assertNotIn("[Pasted text #1", t.queued[0])

    def test_enter_sends_the_pasted_text_not_the_chip(self):
        t = self.keyed(mid_turn=False)
        t._picker = None
        t._prompt_history = []
        t.input_buf.insert_text(f"{CHIP} please fix this")
        self.binding(t, "ControlM").handler(None)    # Enter is ControlM on a terminal
        self.assertEqual(len(t.sent), 1, "Enter must reach the dispatch path")
        self.assertIn("def broken():", t.sent[0])
        self.assertNotIn("[Pasted text #1", t.sent[0])
