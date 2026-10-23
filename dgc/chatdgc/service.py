"""ChatDGC on the wire: the ``chatdgc_*`` commands of one ``dgc serve`` process, and their events.

The process owns this, not a session: chats are the same whatever folder the editor has open, so the
router hands every ``chatdgc_*`` command here and no event carries the envelope's ``chat_id``. Each
turn runs on its own thread (a reply can take minutes, and the stdin thread is where Stop arrives),
one turn per conversation; turns in different conversations run side by side.

Streamed parts are batched a little (every ~50 ms) so a fast model doesn't send one frame per token.
Every frame stays well under the wire's 4 MiB ceiling: a long conversation opens on its latest
messages and pages back with ``chatdgc_earlier``, and a message too large for one frame is cut for
showing (``partial: true``); the file keeps all of it.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from ..editor_protocol import command_error
from .engine import ChatEngine, ChatEngineError
from .held import HeldLocks
from .store import ChatStoreError, default_root

WIDGET_REPORT_SECONDS = 6.0        # how long a reply waits to hear what its widget shows
WIDGET_REPORT_CHARS = 4_000

PAGE_BYTES = 3 * 1024 * 1024          # one frame's messages, encoded
OUTLINE_PROMPTS = 4000                # the latest prompts an outline lists: well inside one frame
OUTLINE_CHARS = 160                   # of each prompt's words
PREVIEW_BYTES = 2_500_000             # an image shown in the chat: its data: URI must fit one frame
FLUSH_S = 0.05
FLUSH_CHARS = 16_000
CLOSE_GRACE_S = 5.0

# Open here for a chat (one window writes to a chat at a time; the founder, 23 Oct 2026). A window's process holds the
# chats its tabs show and the ones it is writing, and says so in its note (dgc/peers.py, "chatdgc_held"); another
# window's process finds it there and asks it over its socket (dgc/serve_detach.py) to let one chat go. Holding a chat
# means holding its lock (dgc/chatdgc/held.py; the founder, 24 Oct 2026): notes are written now and then, and two windows
# opening one chat in that gap both read "nobody holds it". The kernel's lock lets exactly one of them have it.
TAKE_ANSWER_S = 40.0          # how long a take waits for the holder's answer (its chat's name and follow-ups land first)
SETTLE_S = 30.0               # how long a holder waits for what follows a reply (name, follow-ups, a look back)
AWAY_CHECK_S = 3.0            # how often a chat another window holds is looked at again, to be this one's once it's free
GIVEN_GRACE_S = 15.0          # a chat just let go stays read-only here this long while its new holder's note is written
LINK_LINE_BYTES = 12 * 1024 * 1024    # one event on a link: a frame is at most 4 MiB on the wire, escaped here
TAKE_LOCK_S = 2.0             # how long a window taking a chat tries for its lock while the holder drops it
HELD_ELSEWHERE = "This chat is open in another window. Use Open here to carry on with it in this window."
BEATEN = "Another window took this chat at the same moment. Use Open here again to carry on with it in this window."
MAX_HELD_COMMANDS = 32
CHAT_ID_CHARS = 37
# What changes a chat: while another window holds it, refused here; while this window takes it mid-reply, held until
# the reply ends and the chat is this window's (a message typed meanwhile goes then, as ChatDGC's queue sends it).
WRITES = frozenset({"chatdgc_send", "chatdgc_continue", "chatdgc_edit", "chatdgc_regenerate", "chatdgc_version",
                    "chatdgc_answer", "chatdgc_research", "chatdgc_research_start", "chatdgc_compact", "chatdgc_summary",
                    "chatdgc_carry", "chatdgc_branch", "chatdgc_draft", "chatdgc_action"})
# What a window that took a chat mid-reply asks of the process writing the reply: what it has now (open), Stop, a
# steer for research, what a widget shows. Anything else it reads from disk itself.
THROUGH = frozenset({"chatdgc_open", "chatdgc_cancel", "chatdgc_research_steer", "chatdgc_widget_report"})


class _HeldElsewhere(ChatEngineError):
    """A change to a chat whose lock another window's DGC holds: refused, and the chat is read-only here from now on."""


def _writes(cmd: dict) -> bool:
    kind = cmd.get("type")
    return (kind in WRITES or (kind == "chatdgc_canvas" and cmd.get("op") == "restore")
            or (kind == "chatdgc_widgets" and cmd.get("op") == "remove"))


def _chat_id(value) -> bool:
    return (isinstance(value, str) and len(value) == CHAT_ID_CHARS and value.startswith("chat_")
            and all(c in "0123456789abcdef" for c in value[5:]))


class _Link:
    """The writer's end of a chat another window took mid-reply: every event of the chat goes down this socket, and what
    that window asks of the reply as it is now (THROUGH) comes up it. Once the reply and what follows it are done, the
    writer says "end" and the chat is the other window's for good. A send that fails ends the link (never the reply)."""

    def __init__(self, sock, conversation_id: str, sanitize=None):
        self.sock, self.conversation_id, self._sanitize = sock, conversation_id, sanitize
        self._lock = threading.Lock()
        self.dead = False

    def send(self, value: dict) -> bool:
        line = (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with self._lock:
            if self.dead:
                return False
            try:
                self.sock.sendall(line)
                return True
            except OSError:
                self.dead = True
        self.close()
        return False

    def event(self, event: str, fields: dict) -> bool:
        frame = {"type": event, **fields}
        if callable(self._sanitize):
            try:
                frame = self._sanitize(frame)          # redacted as this process's own wire is
            except Exception:                          # noqa: BLE001 -- never unredacted: dropped
                return False
        return self.send({"k": "event", "event": frame})

    def close(self) -> None:
        self.dead = True
        import socket as _socket
        try:
            self.sock.shutdown(_socket.SHUT_RDWR)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


class _Remote:
    """This window's end of a chat it took mid-reply: the reply goes on in the process that was writing it, its events come
    down the socket and go out on this wire as this process's own, and what this window does in the chat goes up it
    (THROUGH) or, if it would change the chat, waits here for the move (``held``)."""

    def __init__(self, sock, conversation_id: str, pid=None):
        self.sock, self.conversation_id, self.pid = sock, conversation_id, pid
        self.lock = threading.RLock()                  # taken after the wire's dispatch lock, never before it
        self.held: list[dict] = []
        self.ended = False
        self.closed_here = False
        self._send_lock = threading.Lock()

    def forward(self, cmd: dict) -> bool:
        line = (json.dumps({"k": "command", "command": cmd}, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
        with self._send_lock:
            try:
                self.sock.sendall(line)
                return True
            except OSError:
                return False

    def close(self) -> None:
        import socket as _socket
        try:
            self.sock.shutdown(_socket.SHUT_RDWR)
        except OSError:
            pass


def summary(chat: dict) -> dict:
    """A conversation without its messages: what the list and an opened chat's header show."""
    return {key: chat.get(key) for key in ("id", "title", "created_at", "updated_at", "model", "thinking",
                                            "pinned", "archived")} | {"temporary": bool(chat.get("temporary")),
                                                                      "summary": chat.get("summary"),
                                                                      "carried": chat.get("carried"),
                                                                      "branched": chat.get("branched"),
                                                                      "project": chat.get("project"),
                                                                      "study": bool(chat.get("study"))}


def _size(value) -> int:
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))


def fit(message: dict, budget: int = PAGE_BYTES) -> dict:
    """The message, or (too large for one frame) a copy cut to fit, marked partial."""
    if _size(message) <= budget:
        return message
    cut = dict(message)
    cut["thinking"] = ""
    for key in ("text",):
        text = str(cut.get(key) or "")
        while text and _size({**cut, key: text}) > budget:
            text = text[: len(text) * 3 // 4]
        cut[key] = text
    cut["partial"] = True
    return cut


def page(messages: list[dict], before: str | None = None) -> tuple[list[dict], int]:
    """The latest messages (before ``before``, if named) that fit one frame, and how many came earlier."""
    end = len(messages)
    if before is not None:
        end = next((i for i, m in enumerate(messages) if m.get("id") == before), None)
        if end is None:
            raise ChatEngineError("That message isn't in this chat.")
    out, used, start = [], 0, end
    while start > 0:
        message = fit(messages[start - 1])
        size = _size(message) + 1
        if out and used + size > PAGE_BYTES:
            break
        out.insert(0, message)
        used += size
        start -= 1
    return out, start


def outline(messages: list[dict]) -> list[dict]:
    """Every prompt of the conversation as shown, oldest first: its first words (or what it attached), when it was
    sent, and the widgets the replies to it made. What the prompt rail and a chat's Widgets list show, whichever of
    its pages the screen holds."""
    prompts: list[dict] = []
    for m in messages:
        if not isinstance(m, dict) or not m.get("id"):
            continue
        if m.get("role") == "user":
            words = " ".join(str(m.get("text") or "").split())
            if not words:
                words = ", ".join(str(a.get("name") or "attachment") for a in m.get("attachments") or [] if isinstance(a, dict))
            prompts.append({"id": m["id"], "text": words[:OUTLINE_CHARS], "created_at": str(m.get("created_at") or "")})
        elif prompts:
            made = [{"id": str(w["id"]), "message_id": m["id"], "title": str(w.get("title") or "Interactive")[:80],
                     "created_at": str(w.get("created_at") or m.get("created_at") or ""), **({"removed": True} if w.get("removed") else {})}
                    for w in m.get("widgets") or [] if isinstance(w, dict) and w.get("id")]
            if made:
                prompts[-1].setdefault("widgets", []).extend(made)
    return prompts[-OUTLINE_PROMPTS:]


class _Stream:
    """Parts of one reply, sent in small batches."""

    def __init__(self, emit, conversation_id: str, message_id: str):
        self.emit, self.conversation_id, self.message_id = emit, conversation_id, message_id
        self._text, self._thinking, self._lock = [], [], threading.Lock()
        self._last, self._timer = 0.0, None

    def text(self, part: str) -> None:
        self._add(self._text, part)

    def thinking(self, part: str) -> None:
        self._add(self._thinking, part)

    def _add(self, into: list, part) -> None:
        if not part:
            return
        with self._lock:
            into.append(str(part))
            due = (time.monotonic() - self._last >= FLUSH_S
                   or sum(map(len, self._text)) + sum(map(len, self._thinking)) >= FLUSH_CHARS)
            if not due and self._timer is None:
                self._timer = threading.Timer(FLUSH_S, self.flush)
                self._timer.daemon = True
                self._timer.start()
        if due:
            self.flush()

    def flush(self) -> None:
        with self._lock:
            if self._timer is not None:
                self._timer.cancel()
                self._timer = None
            text, thinking = "".join(self._text), "".join(self._thinking)
            self._text, self._thinking = [], []
            self._last = time.monotonic()
            if not text and not thinking:
                return
            fields = {"conversation_id": self.conversation_id, "message_id": self.message_id}
            for key, value in (("text", text), ("thinking", thinking)):
                if value:
                    fields[key] = value
            # Under the lock: two flushes (the timer's and a part's) must reach the wire in order.
            self.emit("chatdgc_delta", **fields)


class _Live:
    """The reply being written, as a screen that saw each of its events so far holds it.

    What ``chatdgc_open`` sends of a chat mid-reply: a window that reloaded while the reply went on with no window
    (dgc/serve_detach.py), or a tab opened on it again. Every event of the reply is sent through ``said``, which
    folds it in here first, under the lock ``_opened`` takes to read it and send the chat: each part of the reply
    reaches a screen exactly once, in what it opened with or in an event after. The folding is the screen's own
    (media/chatdgc.js). Once the reply is saved (``finish``), the chat on disk is the truth again."""

    def __init__(self, emit):
        self._emit = emit
        self.lock = threading.RLock()
        self.message: dict | None = None
        self.activity: tuple[str, str] | None = None     # what it is doing that shows only as "Searching…"
        self.done = False

    def start(self, reply_id: str, existing: dict | None) -> None:
        with self.lock:
            base = json.loads(json.dumps(existing)) if isinstance(existing, dict) else None
            self.message = base or {"id": reply_id, "role": "assistant", "text": "", "thinking": ""}

    def finish(self) -> None:
        with self.lock:
            self.done = True

    def snapshot(self) -> dict | None:
        """The reply so far, or None when there is none to show (nothing yet, or saved now)."""
        with self.lock:
            message = self.message
            if self.done or message is None:
                return None
            kept = any(message.get(key) for key in ("text", "thinking", "questions", "images", "actions", "files",
                                                     "canvases", "widgets", "research"))
            return json.loads(json.dumps(message)) if kept else None

    def said(self, event: str, /, **fields) -> None:
        with self.lock:
            if not self.done and self.message is not None and fields.get("message_id") == self.message["id"]:
                try:
                    self._fold(event, fields)
                except Exception:                    # noqa: BLE001 -- what reaches the screen never depends on it
                    pass
            self._emit(event, **fields)

    def _upsert(self, key: str, item) -> None:
        if not isinstance(item, dict):
            return
        items = [x for x in self.message.get(key) or [] if isinstance(x, dict)]
        at = next((i for i, x in enumerate(items) if x.get("id") == item.get("id")), None)
        if at is None:
            items.append(dict(item))
        elif key == "canvases":
            items[at] = {**item, "op": "created" if items[at].get("op") == "created" else item.get("op")}
        else:
            items[at] = dict(item)
        self.message[key] = items

    def _fold(self, event: str, fields: dict) -> None:
        message = self.message
        if event == "chatdgc_delta":
            if message.get("finish") and message.get("finish") != "stop":
                message.pop("finish", None)          # a stopped reply, continued
            if fields.get("text"):
                self.activity = None
            message["text"] = str(message.get("text") or "") + str(fields.get("text") or "")
            message["thinking"] = str(message.get("thinking") or "") + str(fields.get("thinking") or "")
        elif event == "chatdgc_question":
            message["questions"] = [*(message.get("questions") or []), fields.get("question")]
        elif event == "chatdgc_images":
            message["images"] = fields.get("images")
        elif event == "chatdgc_action":
            self._upsert("actions", fields.get("action"))
        elif event == "chatdgc_made":
            self._upsert("files", fields.get("file"))
            if self.activity and self.activity[0] == "making":
                self.activity = None
        elif event == "chatdgc_canvas":
            view = fields.get("canvas") or {}
            self._upsert("canvases", {key: view.get(key) for key in ("id", "title", "kind", "language", "version", "op")})
            if self.activity and self.activity[0] == "canvas":
                self.activity = None
        elif event == "chatdgc_widget":
            shown = fields.get("widget")
            if isinstance(shown, dict):
                message["widgets"] = [*(w for w in message.get("widgets") or [] if w.get("id") != shown.get("id")),
                                      dict(shown)]
        elif event == "chatdgc_research":
            state = fields.get("research") if isinstance(fields.get("research"), dict) else {}
            before = (message.get("research") or {}).get("status")
            if state.get("status") == "running" and before not in ("running", "writing", "checking"):
                message["text"] = ""
                for key in ("sources", "error", "finish"):
                    message.pop(key, None)
            message["research"] = {**(message.get("research") or {}), **state}
        elif event == "chatdgc_activity":
            if fields.get("kind") in ("searching", "looking", "compacting", "plugin", "making", "canvas", "analyzing"):
                self.activity = (str(fields.get("kind")), str(fields.get("text") or ""))


class ChatService:
    def __init__(self, emit, config, engine: ChatEngine | None = None):
        # Every event goes through _out: a chat another window took mid-reply has its events sent down that window's
        # link instead of this wire (Open here).
        self._wire = emit
        self.emit = self._out
        self.engine = engine or ChatEngine(config)
        self._turns: dict[str, dict] = {}
        self._naming: set[threading.Thread] = set()     # chats being named after their first reply
        self._lock = threading.Lock()
        self._widget_screen = False                      # a screen that tells what a widget shows is here
        self._widget_reports: dict[str, dict] = {}       # widget id -> {event, report}, while a reply waits
        self._closing = False
        # Memory that learns (dgc/memory_review.py): a chat is looked back over once it's quiet, or as a turn ends
        # after enough new words. memory_history is sent unasked only to a screen that asked for it once.
        from .. import memory_review
        self._review_cancel = threading.Event()
        self._reviews = memory_review.Reviews(self.engine.unreviewed_chars, self._review_now,
                                              idle=memory_review.idle_seconds(config))
        self._history_wanted = False
        self.watching = False                            # a screen that shows a Work session's "Remembered" line
        self.on_turns_changed = None                     # the Host's: the process's note follows the replies
        # Open here (one window writes to a chat at a time). Until the window says which chats it shows
        # (chatdgc_shown), nothing is held: an older editor's chats behave exactly as before.
        self.sanitize = None                             # the Host's: what goes down a link is redacted as the wire is
        self.dispatch_lock = None                        # the wire's (dgc/serve_detach.py): commands run one at a time
        self._hold_lock = threading.RLock()
        self._holding = False
        self._shown: set[str] = set()                    # the chats this window's tabs show
        self._away: dict[str, dict] = {}                 # of those, the ones another window holds: {state, pid}
        self._links: dict[str, _Link] = {}               # chats this process writes for another window that took them
        self._remote: dict[str, _Remote] = {}            # chats this window took mid-reply from another process
        self._via = threading.local()                    # a link's command being run: its answers go back down it
        self._given: dict[str, float] = {}               # chats just let go: read-only here until (monotonic)
        self._watching_away = False
        self._held_order = threading.Lock()              # chatdgc_held is said one at a time, as it is true then
        # A held chat's lock: the shown ones held here, the ones being written (and finished) here, the ones another
        # window took mid-reply until their reply ends. Taken where this window decides it holds a chat, let go as soon
        # as it doesn't (_release_unwanted).
        self.log = None                                  # the Host's: serve.log
        store_root = getattr(getattr(self.engine, "store", None), "root", None)
        self._locks = HeldLocks((Path(store_root) if store_root else default_root()) / "held", log=self._log_line)

    # -- the router's door

    def dispatch(self, cmd: dict) -> None:
        kind = cmd.get("type")
        request_id = cmd.get("request_id") if isinstance(cmd.get("request_id"), str) else None
        problem = command_error(cmd)
        if problem:
            return self._error(f"invalid command: {problem}", request_id, None)
        conversation_id = cmd.get("conversation_id")
        if _chat_id(conversation_id) and kind not in ("chatdgc_open_here", "chatdgc_shown"):
            if self._through(conversation_id, cmd):
                return                                   # the process writing its reply answers it, or it waits
            if self._refused_here(conversation_id, cmd):
                return self._error(HELD_ELSEWHERE, request_id, conversation_id)
        try:
            {"chatdgc_list": self._list, "chatdgc_open": self._open, "chatdgc_earlier": self._earlier,
             "chatdgc_outline": self._outline, "chatdgc_send": self._send, "chatdgc_continue": self._continue, "chatdgc_cancel": self._cancel,
             "chatdgc_update": self._update, "chatdgc_file": self._file, "chatdgc_edit": self._edit,
             "chatdgc_regenerate": self._regenerate, "chatdgc_version": self._version, "chatdgc_answer": self._answer,
             "chatdgc_export": self._export, "chatdgc_compact": self._compact_now, "chatdgc_summary": self._summary,
             "chatdgc_carry": self._carry, "chatdgc_branch": self._branch, "chatdgc_research": self._research,
             "chatdgc_projects": self._projects, "chatdgc_project": self._project, "chatdgc_move": self._move,
             "chatdgc_library": self._library, "chatdgc_library_file": self._library_file,
             "chatdgc_action": self._action, "chatdgc_pips": self._pips, "chatdgc_draft": self._draft,
             "chatdgc_canvas": self._canvas, "chatdgc_widget_report": self._widget_report, "chatdgc_widgets": self._widgets,
             "chatdgc_context": lambda cmd: self._context_later(cmd["conversation_id"]),
             "chatdgc_context_breakdown": self._breakdown,
             "chatdgc_research_start": self._research_start, "chatdgc_research_steer": self._research_steer,
             "chatdgc_shown": self._shown_now, "chatdgc_open_here": self._open_here,
             "memory_list": self._memory, "memory_add": self._memory, "memory_edit": self._memory,
             "memory_forget": self._memory, "memory_clear": self._memory, "memory_project": self._memory,
             "memory_history": self._memory_history, "memory_undo": self._memory_undo,
             "memory_watch": self._memory_watch}[kind](cmd)
        except _HeldElsewhere as exc:
            self._error(str(exc), request_id, conversation_id)
            self._lost_hold(conversation_id)
        except (ChatEngineError, ChatStoreError) as exc:
            self._error(str(exc), request_id, conversation_id)

    def _error(self, message: str, request_id, conversation_id) -> None:
        fields = {"message": str(message)[:1000]}
        if request_id:
            fields["request_id"] = request_id
        if isinstance(conversation_id, str) and conversation_id:
            fields["conversation_id"] = conversation_id[:64]
        self.emit("chatdgc_error", **fields)

    # -- reading

    def _list(self, cmd: dict) -> None:
        found = self.engine.store.listing(query=cmd.get("query", ""), archived=cmd.get("archived", False),
                                          limit=cmd.get("limit", 50), offset=cmd.get("offset", 0),
                                          project=cmd.get("project", ""))
        self.emit("chatdgc_chats", request_id=cmd["request_id"], chats=found["chats"], total=found["total"],
                  next_offset=found["next_offset"])

    def _marked(self, chat: dict, messages: list[dict]) -> list[dict]:
        """Messages as the screen shows them: each with other versions says which it is, of how many."""
        versions = self.engine.versions(chat)
        return [{**m, "versions": versions[m["id"]]} if m.get("id") in versions else m for m in messages]

    def _opened(self, chat: dict, request_id: str) -> None:
        """The chat as a screen opens it. Mid-reply, with the reply so far in it (_Live): a window that reloaded
        while the reply went on, or a tab opened on it again, shows every part of it once."""
        for _ in range(3):
            with self._lock:
                turn = self._turns.get(chat["id"])
            live = (turn or {}).get("live")
            if live is None:
                return self._send_opened(chat, request_id, turn, None)
            with live.lock:
                with self._lock:
                    if self._turns.get(chat["id"]) is not turn:
                        continue                   # it ended (or another began) meanwhile: look again
                try:
                    chat = self.engine.open(chat["id"])     # as it is now: a reply saved meanwhile is in it
                except (ChatEngineError, ChatStoreError):
                    pass
                reply = live.snapshot()
                self._send_opened(chat, request_id, turn, reply)
                if reply is not None and live.activity is not None:
                    kind, text = live.activity     # "Searching…" again: no part of the reply says it
                    self.emit("chatdgc_activity", conversation_id=chat["id"], message_id=reply["id"], kind=kind,
                              text=text[:400])
                return None
        with self._lock:
            turn = self._turns.get(chat["id"])
        return self._send_opened(chat, request_id, turn, None)

    def _send_opened(self, chat: dict, request_id: str, turn: dict | None, reply: dict | None) -> None:
        messages = list(chat["messages"])
        if reply is not None:
            at = next((i for i, m in enumerate(messages) if m.get("id") == reply["id"]), None)
            if at is None:
                messages.append(reply)
            else:
                messages[at] = reply               # a reply continued: what it had, and what it wrote since
        messages, earlier = page(messages)
        fields = {"reply_id": turn["reply_id"]} if turn and turn.get("reply_id") else {}
        project = self.engine._project_of(chat)
        if project:
            fields["project"] = project            # its page, and the chat's header, show it
        self.emit("chatdgc_opened", request_id=request_id, conversation=summary(chat),
                  messages=self._marked(chat, messages), earlier=earlier, busy=turn is not None, **fields)

    def _open(self, cmd: dict) -> None:
        chat = self.engine.open(cmd.get("conversation_id") or None, temporary=bool(cmd.get("temporary")),
                                project=cmd.get("project") or None)
        if cmd.get("widget_reports"):
            # Said by the screen as it opens a chat; it answers for every chat (shown: false where none shows it).
            self._widget_screen = True
        state = None
        if self._via_link() is None and not chat.get("temporary"):
            with self._hold_lock:
                was = chat["id"] in self._away
                newly = chat["id"] not in self._shown
                self._shown.add(chat["id"])              # this window shows it now (chatdgc_shown says so again)
            state = self._holder_state(chat["id"]) if cmd.get("conversation_id") else None
            if state is None and was:
                self._held(chat["id"], {"state": "here"}, cmd["request_id"])     # free again: this window's
            if self._holding and (newly or was):
                self._turns_changed()                    # the note names what this window holds now
        if state is not None:
            # Another window's DGC writes to it: as last saved, read-only here until Open here.
            self._send_opened(chat, cmd["request_id"], None, None)
            self._held(chat["id"], state)
        else:
            self._opened(chat, cmd["request_id"])
        self._context_later(chat["id"])

    # -- Open here: one window writes to a chat at a time

    def _via_link(self):
        """The link whose command this thread is running (its answers go back down it), or None."""
        return getattr(self._via, "link", None)

    def _out(self, event: str, /, **fields) -> None:
        """Every event of this service: down the link of the window that took its chat mid-reply, else on this wire."""
        via = self._via_link()
        if via is not None:
            via.event(event, fields)                     # an answer to that window's own command, never this one's
            return
        conversation_id = fields.get("conversation_id")
        link = self._links.get(conversation_id) if self._links and isinstance(conversation_id, str) else None
        if link is not None:
            if link.event(event, fields):
                if event == "chatdgc_changed":
                    self._wire(event, **fields)          # its name and preview in this window's list too
                return
            self._link_lost(conversation_id, link)
        self._wire(event, **fields)

    def _held(self, conversation_id: str, state: dict, request_id: str | None = None) -> None:
        """Tell this window who writes to the chat now (chatdgc_held): never down a link, it is this window's news.
        "here" is said only if it is still true as it is said: another window's Open here may have taken the chat a
        moment after this window had it, and its "moved" must be the last word this window hears, never a stale here."""
        with self._held_order:
            if (state.get("state") or "here") == "here":
                with self._hold_lock:
                    now = self._away.get(conversation_id)
                if now is not None:
                    state = dict(now)
            fields = {"conversation_id": conversation_id, "state": state.get("state") or "here"}
            pid = state.get("pid")
            if isinstance(pid, int) and not isinstance(pid, bool) and pid > 0:
                fields["pid"] = pid
            if request_id:
                fields["request_id"] = request_id
            self._wire("chatdgc_held", **fields)

    def held_here(self) -> list[str] | None:
        """The chats this process holds: the ones its window shows that no other window holds, the ones it is writing
        (and finishing: a name, follow-ups), and the ones its window took mid-reply. What its note says (chatdgc_held)
        for another window's DGC to find. None until its window says what it shows: an older editor holds nothing."""
        if not self._holding:
            return None
        with self._lock:
            found = list(self._turns) + [getattr(t, "dgc_chat", "") for t in self._naming if t.is_alive()]
        with self._hold_lock:
            locking = self._locks.usable                 # a chat it shows is held once its lock is
            found += [c for c in sorted(self._shown) if c not in self._away and c not in self._links
                      and (not locking or self._locks.holds(c))] + list(self._remote)
        out: list[str] = []
        for conversation_id in found:
            if _chat_id(conversation_id) and conversation_id not in out:
                out.append(conversation_id)
        return out[:64]

    def locking(self) -> bool:
        """Whether this process holds its chats by their locks (its note says so, chatdgc_locks), not by its note alone."""
        return self._locks.usable

    def _log_line(self, line: str) -> None:
        hook = self.log
        if callable(hook):
            hook(line)

    def _holders(self, conversation_id: str) -> list[dict]:
        """The other DGC processes holding this chat, by their notes; the one writing it first."""
        from .. import peers
        try:
            records = peers.others(here=False)
        except Exception:                                # noqa: BLE001 -- no notes: nobody else holds it
            return []
        found = []
        for record in records:
            if record.get("kind") != "serve" or record.get("chatdgc_take") != 1:
                continue
            if not record.get("socket") or not record.get("instance") or record.get("liveness") == "gone":
                continue
            held = record.get("chatdgc_held")
            if isinstance(held, list) and conversation_id in held:
                found.append(record)

        def writing(record) -> bool:
            listed = record.get("chatdgc") if isinstance(record.get("chatdgc"), list) else []
            return any(isinstance(c, dict) and c.get("conversation_id") == conversation_id for c in listed)
        found.sort(key=lambda record: 0 if writing(record) else 1)
        return found

    def _holder_state(self, conversation_id: str) -> dict | None:
        """Who writes to this chat, as this window sees it: None when this window does (or may), else {state, pid}
        ("elsewhere", or "moved" when another window took it from here), kept until it is this window's again."""
        if not self._holding:
            return None
        with self._lock:
            writing = conversation_id in self._turns
        with self._hold_lock:
            link = self._links.get(conversation_id)
            if link is not None:                         # another window took it mid-reply: it shows it now
                state = self._away.get(conversation_id) or {"state": "moved", "pid": getattr(link, "pid", None)}
                if conversation_id in self._shown:
                    self._away[conversation_id] = state
                return dict(state)
            if writing or conversation_id in self._remote:
                self._away.pop(conversation_id, None)
                if writing:
                    self._locks.take(conversation_id)    # a reply begun before its window said what it shows
                return None
            was = self._away.get(conversation_id)
        holders = self._holders(conversation_id)
        if holders and self._locks.holds(conversation_id):
            # This window has its lock: a note naming another holder is one about to be written again (a window that
            # just let it go). Only a DGC that holds chats by its note alone, locking none, still counts.
            holders = [h for h in holders if h.get("chatdgc_locks") != 1]
        with self._hold_lock:
            if not holders:
                if time.monotonic() < self._given.get(conversation_id, 0.0):
                    state = was or {"state": "moved", "pid": None}      # just let go: its new holder's note is on its way
                    if conversation_id in self._shown:
                        self._away[conversation_id] = state
                    return dict(state)
                if self._locks.take(conversation_id) is not False:
                    self._given.pop(conversation_id, None)
                    self._away.pop(conversation_id, None)
                    return None                          # this window's: its lock is held (or none can be made here)
                # Another window has its lock and its note doesn't say so yet: read-only, its holder named once it does.
                state = {"state": (was or {}).get("state") or "elsewhere", "pid": (was or {}).get("pid")}
            else:
                state = {"state": (was or {}).get("state") or "elsewhere", "pid": holders[0].get("pid")}
                self._locks.release(conversation_id)     # another holds it by its note: not this window's to keep
            if conversation_id in self._shown:
                self._away[conversation_id] = state
        self._watch_away()
        return dict(state)

    def _lost_hold(self, conversation_id) -> None:
        """A change refused because another window's DGC has the chat's lock: read-only here, as such a chat is."""
        if not _chat_id(conversation_id):
            return
        state = self._holder_state(conversation_id)
        if state is not None:
            self._turns_changed()
            self._held(conversation_id, state)

    def _hold_to_write(self, conversation_id: str, chat: dict) -> None:
        """A reply, a summary or a card being sent writes the chat: this process holds its lock while it does, and it is
        refused when another window's DGC holds it (its lock says so before its note can). Called with self._lock held."""
        if not self._holding or chat.get("temporary") or self._via_link() is not None:
            return
        if self._locks.take(conversation_id) is False:
            raise _HeldElsewhere(HELD_ELSEWHERE)

    def _release_unwanted(self) -> None:
        """Let go of the lock of every chat this process no longer holds: one its window stopped showing, or another
        window took, or whose reply (and what follows it) is done here."""
        if not self._locks.held():
            return
        with self._hold_lock:
            with self._lock:                             # held to the end: a reply taking its lock waits for this
                wanted = set(self._turns) | {getattr(t, "dgc_chat", "") for t in self._naming}
                wanted |= set(self._links) | {c for c in self._shown if c not in self._away and c not in self._remote}
                self._locks.keep_only(wanted)

    def _refused_here(self, conversation_id: str, cmd: dict) -> bool:
        """A change to a chat another window writes to, from this window: refused (its screen is read-only)."""
        if self._via_link() is not None:
            return False
        if not (_writes(cmd) or cmd.get("type") in ("chatdgc_cancel", "chatdgc_research_steer")):
            return False
        with self._hold_lock:
            return conversation_id in self._away or conversation_id in self._links

    def _through(self, conversation_id: str, cmd: dict) -> bool:
        """A command for a chat this window took mid-reply: to the process writing the reply (THROUGH), or held for the
        move (a change); False when it is answered here, from disk, as any other chat's is."""
        if self._via_link() is not None:
            return False
        with self._hold_lock:
            remote = self._remote.get(conversation_id)
        if remote is None:
            return False
        with remote.lock:
            if remote.ended:
                return False
            if cmd.get("type") in THROUGH:
                if remote.forward(cmd):
                    return True
            elif not _writes(cmd):
                return False
            if len(remote.held) >= MAX_HELD_COMMANDS:
                self._error("Too much is waiting for this chat to move here. Wait for its reply to finish.",
                            cmd.get("request_id") if isinstance(cmd.get("request_id"), str) else None, conversation_id)
                return True
            remote.held.append(dict(cmd))
            return True

    def _shown_now(self, cmd: dict) -> None:
        """chatdgc_shown: the chats this window's tabs show, all of them. A chat no longer shown is let go (a link taken
        for it closes; its writer goes on); one newly shown is held here unless another window holds it."""
        ids = {c for c in (cmd.get("conversation_ids") or [])[:256] if _chat_id(c)}
        with self._hold_lock:
            first = not self._holding                    # chats it opened before it said: held (or not) now
            self._holding = True
            before = set() if first else set(self._shown)
            self._shown = ids
            for conversation_id in before - ids:
                self._away.pop(conversation_id, None)
            closing = [remote for conversation_id, remote in self._remote.items() if conversation_id not in ids]
        for remote in closing:
            remote.closed_here = True
            remote.close()
        for conversation_id in sorted(ids - before):
            state = self._holder_state(conversation_id)
            if state is not None:
                self._held(conversation_id, state)
        self._turns_changed()

    def window_gone(self) -> None:
        """The window went (dgc/serve_detach.py): it shows nothing now. What this process writes it still holds, and a
        chat its window took mid-reply goes on moving here (a reloaded window gets it back)."""
        with self._hold_lock:
            self._shown.clear()
            self._away.clear()
        self._release_unwanted()

    def _open_here(self, cmd: dict) -> None:
        """Open here: take a chat from the window (or the windowless DGC) holding it. Answered by chatdgc_held "here"
        and chatdgc_opened: from disk if it was idle there, or with its reply so far if not, the rest of it streaming
        here and the chat this process's once it ends."""
        conversation_id, request_id = cmd["conversation_id"], cmd["request_id"]
        self.engine.open(conversation_id)                # an unknown chat is refused here, not on the thread
        with self._hold_lock:
            self._holding = True
            self._shown.add(conversation_id)
        if self._through(conversation_id, {"type": "chatdgc_open", "request_id": request_id,
                                           "conversation_id": conversation_id}):
            return                                       # this window has it already, through its writer
        threading.Thread(target=self._take, args=(conversation_id, request_id), daemon=True,
                         name=f"dgc-chatdgc-take-{conversation_id[5:13]}").start()

    def _take(self, conversation_id: str, request_id: str) -> None:
        try:
            self._take_now(conversation_id, request_id)
        except (ChatEngineError, ChatStoreError) as exc:
            self._error(str(exc), request_id, conversation_id)
        except Exception as exc:                         # noqa: BLE001 -- said, never lost
            self._error(f"This chat couldn't be opened here: {' '.join(str(exc).split())[:300] or type(exc).__name__}",
                        request_id, conversation_id)

    def _take_now(self, conversation_id: str, request_id: str) -> None:
        with self._lock:
            mine = conversation_id in self._turns
        with self._hold_lock:
            link = self._links.get(conversation_id)
        if link is not None:
            # Another window took this chat from here mid-reply, and this window takes it back (its reply may still be
            # being written here): that window's link ends ("taken"), and it shows the chat read-only again.
            mine = True
            link.send({"k": "end", "reason": "taken"})
            self._link_lost(conversation_id, link)
        refused = ""
        if not mine:
            for holder in self._holders(conversation_id):
                outcome, sock, answer = self._ask(holder, conversation_id, request_id)
                if outcome == "linked":
                    return self._follow_from(sock, conversation_id, holder.get("pid"), request_id)
                if outcome == "released":
                    break
                if outcome == "refused" and answer.get("reason") not in ("through", "instance", "exiting", "not_here"):
                    refused = str(answer.get("reason") or "no")
                    break
                # unreachable, or not the one to ask: the next holder, if any
        if refused:
            return self._error({
                "version": "Another window's DGC, a different version, is writing this chat's reply. It opens here once "
                           "that reply finishes.",
                "busy": "This chat is busy in another window (a summary, or a card being sent). Try again in a moment.",
            }.get(refused, "The other window didn't let this chat go. Try again in a moment."), request_id, conversation_id)
        if not mine and self._locks.take_within(conversation_id, TAKE_LOCK_S) is False:
            return self._beaten(conversation_id, request_id)
        with self._hold_lock:
            self._away.pop(conversation_id, None)
            self._given.pop(conversation_id, None)
            self._shown.add(conversation_id)
        # This window hears it is its own before its note says so: another window learns it from the note, and its
        # Open here (this window then hears "moved") must never arrive here first.
        self._held(conversation_id, {"state": "here"}, request_id)
        self._turns_changed()
        self._opened(self.engine.open(conversation_id), request_id)
        self._context_later(conversation_id)
        if not mine:
            # What the other window would have looked back over, once quiet, is looked back over here now.
            threading.Thread(target=self._review_after, args=(conversation_id,), daemon=True,
                             name=f"dgc-chatdgc-review-{conversation_id[5:13]}").start()

    def _beaten(self, conversation_id: str, request_id: str) -> None:
        """Open here didn't get the chat's lock: another window took it at the same moment (or holds it, its note not yet
        written). Read-only here, with Open here, and its holder named as soon as its note says."""
        holders = self._holders(conversation_id)
        pid = holders[0].get("pid") if holders else None
        state = {"state": "elsewhere", "pid": pid if isinstance(pid, int) else None}
        with self._hold_lock:
            if conversation_id in self._shown:
                self._away[conversation_id] = dict(state)
        self._turns_changed()
        self._held(conversation_id, state)               # the bar again, its Open here back
        self._error(BEATEN, request_id, conversation_id)
        self._watch_away()

    def _ask(self, holder: dict, conversation_id: str, request_id: str):
        """Ask one holder for the chat over its socket: ("released" | "linked" | "refused" | "unreachable", the
        socket when linked, its answer)."""
        import os
        from .. import __version__, session_socket
        from ..editor_protocol import PROTOCOL_VERSION
        try:
            sock = session_socket.connect(str(holder.get("socket") or ""), expect_pid=holder.get("pid"), timeout=10.0)
        except (OSError, ValueError, TypeError):
            return "unreachable", None, {}
        try:
            session_socket.send_line(sock, {"type": "chatdgc_take", "instance": holder.get("instance"),
                                            "conversation_id": conversation_id, "request_id": request_id,
                                            "pid": os.getpid(), "version": __version__,
                                            "protocol_version": PROTOCOL_VERSION})
            sock.settimeout(TAKE_ANSWER_S)
            answer = session_socket.read_line(sock) or {}
        except OSError:
            sock.close()
            return "unreachable", None, {}
        kind = answer.get("type")
        if kind == "linked":
            sock.settimeout(None)
            session_socket.set_send_timeout(sock, 30.0)
            return "linked", sock, answer
        sock.close()
        return ("released" if kind == "released" else "refused" if kind == "refused" else "unreachable"), None, answer

    def _follow_from(self, sock, conversation_id: str, pid, request_id: str) -> None:
        """This window took the chat mid-reply: it is this window's from now on (its note says so), and the reply's
        events come down the link until it ends."""
        remote = _Remote(sock, conversation_id, pid if isinstance(pid, int) else None)
        with self._hold_lock:
            self._remote[conversation_id] = remote
            self._away.pop(conversation_id, None)
            self._given.pop(conversation_id, None)
            self._shown.add(conversation_id)
        self._held(conversation_id, {"state": "here"}, request_id)      # before the chat itself, and before the note
        self._turns_changed()
        self._follow(remote)

    def _follow(self, remote: _Remote) -> None:
        reason = "lost"
        reader = None
        try:
            reader = remote.sock.makefile("rb")
            while True:
                line = reader.readline(LINK_LINE_BYTES + 1)
                if not line or len(line) > LINK_LINE_BYTES:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if not isinstance(message, dict):
                    continue
                if message.get("k") == "end":
                    reason = str(message.get("reason") or "done")[:32]
                    break
                frame = message.get("event") if message.get("k") == "event" else None
                if not isinstance(frame, dict):
                    continue
                kind = frame.pop("type", None)
                for key in ("seq", "chat_id"):
                    frame.pop(key, None)
                if not isinstance(kind, str) or not (kind.startswith("chatdgc_") or kind == "context_breakdown"):
                    continue
                if frame.get("conversation_id", remote.conversation_id) != remote.conversation_id:
                    continue
                try:
                    self._wire(kind, **frame)            # this process's own event now: its seq, its checks
                except Exception:                        # noqa: BLE001 -- one this wire refuses is dropped, not the link
                    pass
        except (OSError, ValueError):
            pass
        finally:
            for closing in (reader, remote.sock):
                try:
                    if closing is not None:
                        closing.close()
                except OSError:
                    pass
            self._moved_here(remote, "closed" if remote.closed_here else reason)

    def _moved_here(self, remote: _Remote, reason: str) -> None:
        """The link ended. "done": the reply and what follows it are saved, and the chat is this window's for good: the
        screen opens it again from here, and what waited for the move goes now. "taken": a third window took it.
        Anything else: the writer went, or goes on without this window, and the chat is whoever's holds it now."""
        import contextlib
        conversation_id = remote.conversation_id
        if reason == "done" and not remote.closed_here:
            # The writer let go of the chat's lock as it said "done": this window's, once it has it (before the wire's
            # lock is taken, so nothing waits on the moment it takes).
            self._locks.take_within(conversation_id, TAKE_LOCK_S)
        with (self.dispatch_lock if self.dispatch_lock is not None else contextlib.nullcontext()):
            with remote.lock:
                remote.ended = True
                held, remote.held = remote.held, []
                with self._hold_lock:
                    if self._remote.get(conversation_id) is remote:
                        del self._remote[conversation_id]
                if reason == "closed":
                    self._turns_changed()                # this window let it go: its tab closed
                    return
                if reason == "taken":
                    state = {"state": "moved", "pid": None}
                    with self._hold_lock:
                        if conversation_id in self._shown:
                            self._away[conversation_id] = state
                else:
                    state = self._holder_state(conversation_id)
                if state is None:
                    self._held(conversation_id, {"state": "here"})      # before the note says so
                self._turns_changed()
                if state is not None:
                    self._held(conversation_id, state)
                    for cmd in held:
                        self._error("This chat is open in another window now. Use Open here to carry on with it in "
                                    "this window.", cmd.get("request_id") if isinstance(cmd.get("request_id"), str)
                                    else None, conversation_id)
                    self._watch_away()
                    return
                for cmd in held:
                    try:
                        self.dispatch(cmd)
                    except Exception:                    # noqa: BLE001 -- the next one still goes
                        pass
        if reason == "done":
            self._review_after(conversation_id)

    # The holder's side: another window's DGC asks for a chat this process holds.

    def take(self, sock, hello: dict) -> bool:
        """chatdgc_take over this process's socket (dgc/serve_detach.py), from another window's Open here. Idle, the chat
        is let go once what follows its last reply has landed: "released". Mid-reply, the socket becomes that chat's
        link: "linked", its reply so far as a chatdgc_opened, then every event of it, until the reply ends and the chat
        is that window's for good. Either way this window's screen hears chatdgc_held "moved". True when it linked."""
        import os
        from .. import __version__, session_socket
        from ..editor_protocol import PROTOCOL_VERSION

        def answer(**fields) -> bool:
            try:
                session_socket.send_line(sock, fields)
                return True
            except OSError:
                return False

        conversation_id = hello.get("conversation_id")
        request_id = str(hello.get("request_id") or "")[:128]
        taker = hello.get("pid") if isinstance(hello.get("pid"), int) and not isinstance(hello.get("pid"), bool) else None
        if not _chat_id(conversation_id) or not request_id or self._closing:
            answer(type="refused", reason="invalid" if not self._closing else "exiting")
            return False
        with self._hold_lock:
            through = self._remote.get(conversation_id)
        if through is not None:                          # this window watches it through its writer: ask that one
            answer(type="refused", reason="through", pid=through.pid or 0)
            return False
        moved = {"state": "moved", "pid": taker}
        for _ in range(3):
            with self._lock:
                turn = self._turns.get(conversation_id)
            if turn is None:
                with self._hold_lock:
                    with self._lock:
                        if conversation_id in self._turns:
                            continue                     # a reply started meanwhile: take it mid-reply instead
                        shown = conversation_id in self._shown
                        if shown:
                            self._away[conversation_id] = dict(moved)     # nothing starts here from now on
                        self._given[conversation_id] = time.monotonic() + GIVEN_GRACE_S + SETTLE_S
                self._settle(conversation_id)
                with self._hold_lock:
                    self._given[conversation_id] = time.monotonic() + GIVEN_GRACE_S
                    with self._lock:
                        writing = conversation_id in self._turns
                    if not writing:
                        self._locks.release(conversation_id)     # before the answer: the taker takes it next
                answer(type="released", pid=os.getpid())
                if shown:
                    self._held(conversation_id, moved)
                    self._watch_away()
                self._turns_changed()
                return False
            live = turn.get("live")
            if live is None:
                answer(type="refused", reason="busy")     # a summary, or a card being sent: no reply to show as it goes
                return False
            if hello.get("version") != __version__ or hello.get("protocol_version") != PROTOCOL_VERSION:
                answer(type="refused", reason="version", version=__version__)
                return False
            link = _Link(sock, conversation_id, self.sanitize)
            link.pid = taker
            with live.lock:                              # no part of the reply between the snapshot and the link
                with self._lock:
                    if self._turns.get(conversation_id) is not turn:
                        continue
                if not answer(type="linked", pid=os.getpid()):
                    return False
                with self._hold_lock:
                    old = self._links.get(conversation_id)
                    self._links[conversation_id] = link
                    shown = conversation_id in self._shown
                    if shown:
                        self._away[conversation_id] = dict(moved)
                self._via.link = link
                try:
                    self._opened(self.engine.open(conversation_id), request_id)
                except (ChatEngineError, ChatStoreError) as exc:
                    self._error(str(exc), request_id, conversation_id)
                finally:
                    self._via.link = None
            if old is not None:
                old.send({"k": "end", "reason": "taken"})
                old.close()
            if shown:
                self._held(conversation_id, moved)
            self._turns_changed()
            self._serve(link)
            return True
        answer(type="refused", reason="busy")
        return False

    def _serve(self, link: _Link) -> None:
        """A link's commands (THROUGH), each run as this window's own would be, its answers going back down the link."""
        import contextlib
        reader = None
        try:
            reader = link.sock.makefile("rb")
            while True:
                line = reader.readline(LINK_LINE_BYTES + 1)
                if not line or len(line) > LINK_LINE_BYTES:
                    break
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                cmd = message.get("command") if isinstance(message, dict) and message.get("k") == "command" else None
                if (not isinstance(cmd, dict) or cmd.get("type") not in THROUGH
                        or cmd.get("conversation_id") != link.conversation_id):
                    continue
                self._via.link = link
                try:
                    with (self.dispatch_lock if self.dispatch_lock is not None else contextlib.nullcontext()):
                        self.dispatch(cmd)
                except Exception:                        # noqa: BLE001 -- one command never ends the link
                    pass
                finally:
                    self._via.link = None
        except (OSError, ValueError):
            pass
        finally:
            try:
                if reader is not None:
                    reader.close()
            except OSError:
                pass
            self._link_lost(link.conversation_id, link)

    def _link_lost(self, conversation_id: str, link: _Link) -> None:
        with self._hold_lock:
            gone = self._links.get(conversation_id) is link
            if gone:
                del self._links[conversation_id]
        link.close()
        if gone:
            self._turns_changed()

    def _end_link(self, conversation_id: str, link: _Link) -> None:
        """The reply the other window took is saved: once what follows it has landed, the chat is that window's."""
        self._settle(conversation_id)
        with self._hold_lock:
            gone = self._links.get(conversation_id) is link
            if gone:
                del self._links[conversation_id]
                with self._lock:
                    writing = conversation_id in self._turns
                if not writing:
                    self._locks.release(conversation_id)     # before "done": the other window takes it next
        link.send({"k": "end", "reason": "done"})
        link.close()
        if gone:
            self._turns_changed()

    def _settle(self, conversation_id: str) -> None:
        """What follows a reply here (its chat's name, follow-ups, a look back: each writes the chat) lands before the
        chat goes to another window, and no look back is left waiting to write it later."""
        deadline = time.monotonic() + SETTLE_S
        with self._lock:
            after = [t for t in self._naming if getattr(t, "dgc_chat", "") == conversation_id]
        for thread in after:
            if thread is not threading.current_thread():
                thread.join(max(0.0, deadline - time.monotonic()))
        self._reviews.settle(conversation_id, max(0.0, deadline - time.monotonic()))

    def _watch_away(self) -> None:
        """While a chat this window shows is held elsewhere, look again now and then: once nobody else holds it (no note
        names it, and its lock is free), it is this window's, as a chat nobody else has open always is. One whose
        holder had its lock before its note named it gets its holder named."""
        with self._hold_lock:
            if self._watching_away or not self._away or self._closing:
                return
            self._watching_away = True
        threading.Thread(target=self._away_loop, daemon=True, name="dgc-chatdgc-away").start()

    def _away_loop(self) -> None:
        import contextlib
        from ..serve_detach import time_scale
        every = max(0.2, AWAY_CHECK_S * time_scale())
        try:
            while not self._closing:
                time.sleep(every)
                with self._hold_lock:
                    if not self._away:
                        return
                    waiting = [c for c in self._away if c not in self._links]
                for conversation_id in waiting:
                    if time.monotonic() < self._given.get(conversation_id, 0.0):
                        continue
                    holders = self._holders(conversation_id)
                    if holders:
                        self._name_holder(conversation_id, holders[0].get("pid"))
                        continue
                    with (self.dispatch_lock if self.dispatch_lock is not None else contextlib.nullcontext()):
                        with self._hold_lock:
                            if conversation_id not in self._away or conversation_id in self._links:
                                continue
                            if self._locks.take(conversation_id) is False:
                                continue                 # another window has it, its note still to come
                            del self._away[conversation_id]
                        self._held(conversation_id, {"state": "here"})    # the screen opens it again, here
                        self._turns_changed()                             # then the note says so
        finally:
            with self._hold_lock:
                self._watching_away = False
                again = bool(self._away) and not self._closing
            if again:
                self._watch_away()

    def _name_holder(self, conversation_id: str, pid) -> None:
        """A chat read-only here whose holder wasn't named (its lock said so before its note did): named now."""
        import contextlib
        if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
            return
        with self._hold_lock:
            state = self._away.get(conversation_id)
            if state is None or state.get("pid"):
                return
        with (self.dispatch_lock if self.dispatch_lock is not None else contextlib.nullcontext()):
            with self._hold_lock:
                state = self._away.get(conversation_id)
                if state is None or state.get("pid") or conversation_id in self._links:
                    return
                state["pid"] = pid
                named = dict(state)
            self._held(conversation_id, named)

    def _widget_report(self, cmd: dict) -> None:
        """What a widget shows, from the screen: to the reply waiting for it (if it still is)."""
        with self._lock:
            waiting = self._widget_reports.get(str(cmd.get("widget_id") or ""))
        if waiting is None:
            return
        errors = [e[:300] for e in (cmd.get("errors") or []) if isinstance(e, str)][:3]
        waiting["report"] = {"shown": bool(cmd.get("shown")), "text": str(cmd.get("text") or "")[:WIDGET_REPORT_CHARS],
                             "errors": errors}
        waiting["event"].set()

    def _widgets(self, cmd: dict) -> None:
        """Widgets in the Library: listed, one with its page (to open it again), or one deleted."""
        op, request_id = cmd["op"], cmd["request_id"]
        if op == "list":
            found = self.engine.store.widgets(query=cmd.get("query", ""), limit=cmd.get("limit", 60),
                                              offset=cmd.get("offset", 0))
            self.emit("chatdgc_widgets", request_id=request_id, op=op, **found)
            return
        conversation_id, widget_id = str(cmd.get("conversation_id") or ""), str(cmd.get("widget_id") or "")
        if not conversation_id or not widget_id:
            raise ChatEngineError("Say which chat and which widget.")
        if op == "get":
            self.emit("chatdgc_widgets", request_id=request_id, op=op, conversation_id=conversation_id,
                      widget_id=widget_id, widget=self.engine.store.widget(conversation_id, widget_id))
            return
        with self._lock:                              # remove: a reply's save would put it back
            if conversation_id in self._turns:
                raise ChatEngineError("Let the reply finish first.")
        message = self.engine.store.remove_widget(conversation_id, widget_id)
        self.emit("chatdgc_widgets", request_id=request_id, op=op, conversation_id=conversation_id, widget_id=widget_id)
        chat = self.engine.open(conversation_id)
        if any(m.get("id") == message.get("id") for m in chat.get("messages") or []):
            self.emit("chatdgc_message", conversation_id=conversation_id, message=fit(self._marked(chat, [message])[0]))
        self._changed(conversation_id, None)

    def _context(self, conversation_id: str) -> None:
        """What the chat takes of its window, said on the wire (the model's limit may be asked of the provider)."""
        try:
            fields = self.engine.context(conversation_id)
        except Exception:                             # noqa: BLE001 -- a meter is a nicety
            return
        self.emit("chatdgc_context", conversation_id=conversation_id, **fields)

    def _breakdown(self, cmd: dict) -> None:
        """What fills a chat's window, part by part: on a thread of its own, as the meter is (asking the provider for
        the model's limit can take a moment)."""
        conversation_id, request_id = cmd["conversation_id"], cmd["request_id"]

        def answer():
            try:
                parts = self.engine.context_breakdown(conversation_id)
            except (ChatEngineError, ChatStoreError) as exc:
                self._error(str(exc), request_id, conversation_id)
                return
            except Exception:                     # noqa: BLE001 -- a breakdown is a nicety
                self._error("What fills the window couldn't be counted just now.", request_id, conversation_id)
                return
            self.emit("context_breakdown", request_id=request_id, conversation_id=conversation_id, **parts)
        threading.Thread(target=answer, daemon=True, name=f"dgc-chatdgc-breakdown-{conversation_id[5:13]}").start()

    def _context_later(self, conversation_id: str) -> None:
        threading.Thread(target=self._context, args=(conversation_id,), daemon=True,
                         name=f"dgc-chatdgc-context-{conversation_id[5:13]}").start()

    def _compacted(self, conversation_id: str, summary, request_id: str | None = None) -> None:
        fields = {"request_id": request_id} if request_id else {}
        self.emit("chatdgc_compacted", conversation_id=conversation_id, summary=summary, **fields)

    def _summary(self, cmd: dict) -> None:
        with self._lock:
            if cmd["conversation_id"] in self._turns:
                raise ChatEngineError("This chat is still answering. Stop it or wait for it to finish.")
        summary = self.engine.set_summary(cmd["conversation_id"], cmd["text"])
        self._compacted(cmd["conversation_id"], summary, cmd["request_id"])
        self._context_later(cmd["conversation_id"])

    def _occupied(self, cmd: dict, work) -> None:
        """Work on a chat that takes a while (a summary is a model request): in the chat's turn slot, on a thread
        of its own, so nothing else runs in that chat meanwhile and Stop ends it. What ``work`` returns, if it's
        callable, runs once the chat is free again: a screen that acts on the news at once (Edit the summary just
        made) is never told the chat is still answering."""
        conversation_id, request_id = cmd["conversation_id"], cmd["request_id"]
        chat = self.engine.open(conversation_id)
        cancel = threading.Event()
        with self._lock:
            if self._closing:
                raise ChatEngineError("DGC is shutting down.")
            if conversation_id in self._turns:
                raise ChatEngineError("This chat is still answering. Stop it or wait for it to finish.")
            self._hold_to_write(conversation_id, chat)
            slot = self._turns[conversation_id] = {"cancel": cancel, "reply_id": None, "thread": None}

        def run():
            after = None
            try:
                self.emit("chatdgc_activity", conversation_id=conversation_id, message_id=request_id[:64],
                          kind="compacting", text="")
                after = work(cancel)
            except (ChatEngineError, ChatStoreError) as exc:
                self._error(str(exc), request_id, conversation_id)
            except Exception as exc:                  # noqa: BLE001
                self._error(f"ChatDGC hit an error: {' '.join(str(exc).split())[:300] or type(exc).__name__}",
                            request_id, conversation_id)
            finally:
                with self._lock:
                    if self._turns.get(conversation_id) is slot:
                        del self._turns[conversation_id]
                self._turns_changed()
            if callable(after):
                try:
                    after()
                except Exception as exc:              # noqa: BLE001
                    self._error(f"ChatDGC hit an error: {' '.join(str(exc).split())[:300] or type(exc).__name__}",
                                request_id, conversation_id)
        slot["thread"] = threading.Thread(target=run, daemon=True, name=f"dgc-chatdgc-work-{conversation_id[5:13]}")
        slot["thread"].start()
        self._turns_changed()

    def _compact_now(self, cmd: dict) -> None:
        def work(cancel):
            summary = self.engine.compact(cmd["conversation_id"], cancel=cancel)

            def said():                             # once the chat is free: its summary can be edited at once
                self._compacted(cmd["conversation_id"], summary, cmd["request_id"])
                self._context(cmd["conversation_id"])
            return said
        self._occupied(cmd, work)

    def _carry(self, cmd: dict) -> None:
        def work(cancel):
            fresh = self.engine.carry(cmd["conversation_id"], cancel=cancel)
            self._opened(fresh, cmd["request_id"])
            self._changed(fresh["id"], None)
            self._context(fresh["id"])
        self._occupied(cmd, work)

    def _branch(self, cmd: dict) -> None:
        conversation_id = cmd["conversation_id"]
        with self._lock:
            if conversation_id in self._turns:
                raise ChatEngineError("This chat is still answering. Stop it or wait for it to finish.")
        fresh = self.engine.branch(conversation_id, cmd["message_id"])
        self._opened(fresh, cmd["request_id"])
        self._changed(fresh["id"], None)

    # -- projects (ChatGPT's): chats, files and instructions together

    def _projects(self, cmd: dict) -> None:
        self.emit("chatdgc_projects", request_id=cmd["request_id"], projects=self.engine.store.projects())

    def _projects_changed(self) -> None:
        """Every screen showing projects (the home's list, a project's page, a chat's header) sees the change."""
        self.emit("chatdgc_projects", projects=self.engine.store.projects())

    def _project(self, cmd: dict) -> None:
        op, store, ident = cmd["op"], self.engine.store, cmd.get("project_id") or ""
        deleted = []
        if op == "create":
            project = store.create_project(cmd.get("name", ""), color=cmd.get("color"),
                                           memory=cmd.get("memory") or "shared", instructions=cmd.get("instructions", ""))
        elif op == "update":
            project = store.update_project(ident, name=cmd.get("name"), color=cmd.get("color"),
                                           instructions=cmd.get("instructions"), memory=cmd.get("memory"))
        elif op == "add_files":
            project = self.engine.add_project_files(ident, cmd.get("attachments"))
        elif op == "remove_file":
            project = store.remove_project_file(ident, cmd.get("file_id", ""))
        else:                                         # delete: its chats too, unless they're kept
            with self._lock:
                busy = [c for c in self._turns if (self.engine._chat_or_none(c) or {}).get("project") == ident]
            if busy:
                raise ChatEngineError("A chat in this project is still answering. Stop it or wait, then delete.")
            deleted = store.delete_project(ident, keep_chats=bool(cmd.get("keep_chats")))
            project = None
        self.emit("chatdgc_project", request_id=cmd["request_id"], project=project,
                  **({"deleted": deleted} if op == "delete" else {}))
        for chat_id in deleted:
            self.emit("chatdgc_changed", conversation_id=chat_id, summary=None)
        self._projects_changed()

    # -- the Library (ChatGPT's): every file you attached

    def _library(self, cmd: dict) -> None:
        found = self.engine.store.library(query=cmd.get("query", ""), kind=cmd.get("kind", ""),
                                          origin=cmd.get("origin", ""), limit=cmd.get("limit", 60),
                                          offset=cmd.get("offset", 0))
        self.emit("chatdgc_library", request_id=cmd["request_id"], **found)

    def _library_file(self, cmd: dict) -> None:
        ref = {key: cmd[key] for key in ("conversation_id", "project_id", "attachment_id") if cmd.get(key)}
        op, fields = cmd["op"], {}
        if op == "save":
            import os
            from pathlib import Path
            target = Path(cmd.get("path") or "")
            if not target.is_absolute() or target.is_dir() or not target.parent.is_dir():
                raise ChatEngineError("Choose where to save the file.")
            _meta, raw, _text = self.engine.library_file(ref)
            temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            try:
                temp.write_bytes(raw)
                os.replace(temp, target)
            except OSError as exc:
                temp.unlink(missing_ok=True)
                raise ChatEngineError(f"The file couldn't be saved: {exc.strerror or exc}.") from exc
            fields = {"path": str(target), "bytes": len(raw)}
        elif op == "to_project":
            self.engine.library_to_project(ref, cmd.get("target_project") or "")
        else:                                         # remove
            self.engine.remove_library_file(ref)
        self.emit("chatdgc_library_file", request_id=cmd["request_id"], op=op, **fields)
        if op != "save":
            self._projects_changed()

    # -- plugins: the user's choice on a card under a reply

    def _canvas(self, cmd: dict) -> None:
        """A canvas, for the editor: its file and versions (get, with its text), a version restored, or a copy saved
        where the user chose (export: Word, PDF or Markdown for a document; the code file for code)."""
        conversation_id, canvas_id, op = cmd["conversation_id"], cmd["canvas_id"], cmd["op"]
        if op == "export":
            import os
            from pathlib import Path
            from . import made
            target = Path(cmd.get("path") or "")
            if not target.is_absolute() or target.is_dir() or not target.parent.is_dir():
                raise ChatEngineError("Choose where to save it.")
            view = self.engine.canvas(conversation_id, canvas_id, text=True)
            fmt = str(cmd.get("format") or "file")
            if fmt == "file" or (view["kind"] == "code" and fmt != "md"):
                data = view["text"].encode("utf-8")
            else:
                try:
                    data = made.make({"name": view["title"], "format": fmt, "content": view["text"]}, self.engine.config).raw
                except made.MadeError as exc:
                    raise ChatEngineError(str(exc)) from None
            temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
            try:
                temp.write_bytes(data)
                os.replace(temp, target)
            except OSError as exc:
                temp.unlink(missing_ok=True)
                raise ChatEngineError(f"It couldn't be saved: {exc.strerror or exc}.") from exc
            self.emit("chatdgc_exported", request_id=cmd["request_id"], conversation_id=conversation_id,
                      path=str(target), bytes=len(data))
            return
        if op == "restore":
            with self._lock:
                if conversation_id in self._turns:
                    raise ChatEngineError("Let the reply finish first.")
            view = self.engine.canvas_restore(conversation_id, canvas_id, cmd.get("version"))
        else:
            view = self.engine.canvas(conversation_id, canvas_id, text=True)
        self.emit("chatdgc_canvas", conversation_id=conversation_id, canvas=view, request_id=cmd["request_id"])

    def _draft(self, cmd: dict) -> None:
        """A draft edited in place (ChatGPT's writing blocks): the reply as it is now, on every screen. Not while a
        reply is being written in the chat: its save would put the old words back."""
        conversation_id = cmd["conversation_id"]
        with self._lock:
            if conversation_id in self._turns:
                raise ChatEngineError("Let the reply finish first.")
        message = self.engine.edit_draft(conversation_id, cmd["message_id"], cmd["original"], cmd["text"])
        marked = self._marked(self.engine.open(conversation_id), [message])[0]
        self.emit("chatdgc_message", conversation_id=conversation_id, message=fit(marked), request_id=cmd["request_id"])
        self._changed(conversation_id, None)

    def _action(self, cmd: dict) -> None:
        """Send it now (as edited), don't, or hand it to a Pip. Sending holds the chat's turn slot, so no reply starts
        meanwhile (its save would overwrite the card's outcome) and Stop has nothing to cut short."""
        conversation_id, request_id, op = cmd["conversation_id"], cmd["request_id"], cmd["op"]
        message_id, action_id = cmd["message_id"], cmd["action_id"]
        chat = self.engine.open(conversation_id)
        if op == "dismiss":
            with self._lock:
                if conversation_id in self._turns:
                    raise ChatEngineError("Let the reply finish first.")
            done = self.engine.act(conversation_id, message_id, action_id, "dismiss")
            self.emit("chatdgc_action", conversation_id=conversation_id, message_id=message_id, action=done,
                      request_id=request_id)
            return
        arguments = cmd.get("arguments") if op == "run" else None
        pip_id = str(cmd.get("pip_id") or "")
        if op == "hand" and not pip_id:
            raise ChatEngineError("Choose a Pip to hand it to.")
        with self._lock:
            if self._closing:
                raise ChatEngineError("DGC is shutting down.")
            if conversation_id in self._turns:
                raise ChatEngineError("Let the reply finish first.")
            self._hold_to_write(conversation_id, chat)
            slot = self._turns[conversation_id] = {"cancel": threading.Event(), "reply_id": None, "thread": None}

        def run():
            try:
                if op == "run":
                    done = self.engine.act(conversation_id, message_id, action_id, "run", arguments=arguments)
                else:
                    done = self._hand(conversation_id, message_id, action_id, pip_id)
                self.emit("chatdgc_action", conversation_id=conversation_id, message_id=message_id, action=done,
                          request_id=request_id)
                self._changed(conversation_id, None)
            except (ChatEngineError, ChatStoreError) as exc:
                self._error(str(exc), request_id, conversation_id)
            except Exception as exc:                  # noqa: BLE001 -- said, never lost
                self._error(f"ChatDGC hit an error: {' '.join(str(exc).split())[:300] or type(exc).__name__}",
                            request_id, conversation_id)
            finally:
                with self._lock:
                    if self._turns.get(conversation_id) is slot:
                        del self._turns[conversation_id]
                self._turns_changed()
        thread = threading.Thread(target=run, daemon=True, name="chatdgc-action")
        slot["thread"] = thread
        thread.start()
        self._turns_changed()

    def _pips_call(self, request: dict) -> dict:
        """One Pips control, as the side bar runs it (the user's own, from this machine)."""
        from ..pips import handle_control
        if request.get("type") == "send_pip_message":
            from ..pip_runtime import require_supervisor
            require_supervisor(self.engine.config)
        response = handle_control(self.engine.config, {**request, "request_id": "chatdgc"}, "editor-user", start_worker=False)
        if not response.get("ok"):
            raise ChatEngineError(str((response.get("error") or {}).get("message") or "Pips didn't answer.")[:300])
        return response.get("result") or {}

    def _personal_pips(self) -> list[dict]:
        found = self._pips_call({"type": "list_workspaces"})
        personal = next((w for w in found.get("workspaces") or [] if w.get("kind") == "personal"), None)
        if personal is None:
            return []
        rows = self._pips_call({"type": "list_pips", "workspace_id": personal["id"], "order": "recent", "limit": 50})
        return [{"id": p["id"], "name": p.get("name") or "Pip", "goal": str(p.get("goal") or "")[:200]}
                for p in rows.get("pips") or [] if p.get("status") != "archived"]

    def _pips(self, cmd: dict) -> None:
        """Your Personal Pips, for "Hand it to a Pip"."""
        try:
            pips = self._personal_pips()
        except Exception as exc:                      # noqa: BLE001 -- Pips off, or the runner can't start: said
            self.emit("chatdgc_pips", request_id=cmd["request_id"], pips=[], error=" ".join(str(exc).split())[:300])
            return
        self.emit("chatdgc_pips", request_id=cmd["request_id"], pips=pips)

    def _hand(self, conversation_id, message_id, action_id, pip_id) -> dict:
        pip = next((p for p in self._personal_pips() if p["id"] == pip_id), None)
        if pip is None:
            raise ChatEngineError("That Pip isn't one of yours now.")
        text = self.engine.pip_message(conversation_id, message_id, action_id)
        self._pips_call({"type": "send_pip_message", "pip_id": pip_id, "text": text,
                         "idempotency_key": f"chatdgc-{action_id}"})
        return self.engine.act(conversation_id, message_id, action_id, "handed", pip=pip)

    def _move(self, cmd: dict) -> None:
        conversation_id = cmd["conversation_id"]
        moved = self.engine.move(conversation_id, cmd.get("project_id") or "")
        if not moved.get("draft"):
            self._changed(conversation_id, cmd["request_id"])
        else:
            self.emit("chatdgc_changed", conversation_id=conversation_id, summary=summary(moved),
                      request_id=cmd["request_id"])
        self._projects_changed()

    def _version(self, cmd: dict) -> None:
        conversation_id = cmd["conversation_id"]
        with self._lock:
            if conversation_id in self._turns:
                raise ChatEngineError("This chat is still answering. Stop it or wait for it to finish.")
        chat = self.engine.version(conversation_id, cmd["parent_id"], cmd["index"])
        self._opened(chat, cmd["request_id"])
        self._changed(conversation_id, None)

    def _earlier(self, cmd: dict) -> None:
        chat = self.engine.open(cmd["conversation_id"])
        messages, earlier = page(chat["messages"], cmd["before"])
        messages = self._marked(chat, messages)
        self.emit("chatdgc_earlier", request_id=cmd["request_id"], conversation_id=chat["id"], messages=messages,
                  earlier=earlier)

    def _outline(self, cmd: dict) -> None:
        chat = self.engine.open(cmd["conversation_id"])
        self.emit("chatdgc_outline", request_id=cmd["request_id"], conversation_id=chat["id"], prompts=outline(chat["messages"]))

    def _file(self, cmd: dict) -> None:
        fields = {"request_id": cmd["request_id"], "conversation_id": cmd["conversation_id"],
                  "attachment_id": cmd["attachment_id"]}
        try:
            self.emit("chatdgc_file", data=self.engine.image(cmd["conversation_id"], cmd["attachment_id"],
                                                              limit=PREVIEW_BYTES), **fields)
        except (ChatEngineError, ChatStoreError) as exc:
            self.emit("chatdgc_file", error=str(exc)[:300], **fields)

    def _export(self, cmd: dict) -> None:
        import os
        from pathlib import Path
        target = Path(cmd["path"])
        if not target.is_absolute() or target.is_dir() or not target.parent.is_dir():
            raise ChatEngineError("Choose where to save the export.")
        data = self.engine.export(cmd["conversation_id"], cmd["format"], cmd.get("message_id")).encode("utf-8")
        temp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        try:
            temp.write_bytes(data)
            os.replace(temp, target)
        except OSError as exc:
            temp.unlink(missing_ok=True)
            raise ChatEngineError(f"The export couldn't be saved: {exc.strerror or exc}.") from exc
        self.emit("chatdgc_exported", request_id=cmd["request_id"], conversation_id=cmd["conversation_id"],
                  path=str(target), bytes=len(data))

    # -- turns

    def _send(self, cmd: dict) -> None:
        def run(cancel, on_start, stream_for, activity):
            return self.engine.send(cmd["conversation_id"], cmd["text"], model=cmd.get("model"),
                                    thinking=cmd.get("thinking"), search=cmd.get("search", "auto"),
                                    attachments=cmd.get("attachments"), study=cmd.get("study"), voice=cmd.get("voice") is True,
                                    canvas_selection=cmd.get("canvas_selection"),
                                    on_start=on_start, on_activity=activity, cancel=cancel, **stream_for())
        self._start(cmd, run)

    def _edit(self, cmd: dict) -> None:
        def run(cancel, on_start, stream_for, activity):
            return self.engine.edit(cmd["conversation_id"], cmd["message_id"], cmd["text"], model=cmd.get("model"),
                                    thinking=cmd.get("thinking"), search=cmd.get("search", "auto"),
                                    on_start=on_start, on_activity=activity, cancel=cancel, **stream_for())
        self._start(cmd, run, refresh=True)

    def _regenerate(self, cmd: dict) -> None:
        def run(cancel, on_start, stream_for, activity):
            return self.engine.regenerate(cmd["conversation_id"], cmd["message_id"], model=cmd.get("model"),
                                          thinking=cmd.get("thinking"), search=cmd.get("search", "auto"),
                                          on_start=on_start, on_activity=activity, cancel=cancel, **stream_for())
        self._start(cmd, run, refresh=True)

    def _answer(self, cmd: dict) -> None:
        def run(cancel, on_start, stream_for, activity):
            return self.engine.answer(cmd["conversation_id"], cmd["message_id"], cmd["question"], cmd["choice"],
                                      choices=cmd.get("choices"), model=cmd.get("model"), thinking=cmd.get("thinking"),
                                      search=cmd.get("search", "auto"), on_start=on_start, on_activity=activity,
                                      cancel=cancel, **stream_for())
        self._start(cmd, run)

    # Deep research: the plan is one turn, the research another (on the same reply); progress is chatdgc_research.

    def _researched(self, conversation_id: str):
        def said(message_id, state):
            with self._lock:
                turn = self._turns.get(conversation_id)
            live = (turn or {}).get("live")
            (live.said if live is not None else self.emit)("chatdgc_research", conversation_id=conversation_id,
                                                           message_id=message_id, research=state)
        return said

    def _research(self, cmd: dict) -> None:
        def run(cancel, on_start, stream_for, activity):
            return self.engine.research_plan(cmd["conversation_id"], cmd["text"], model=cmd.get("model"),
                                             thinking=cmd.get("thinking"), on_start=on_start,
                                             on_research=self._researched(cmd["conversation_id"]), cancel=cancel)
        self._start(cmd, run)

    def _research_start(self, cmd: dict) -> None:
        def run(cancel, on_start, stream_for, activity):
            return self.engine.research_run(cmd["conversation_id"], cmd["message_id"], cmd.get("plan"),
                                            write=bool(cmd.get("write")), on_start=on_start,
                                            on_text=stream_for()["on_text"],
                                            on_research=self._researched(cmd["conversation_id"]), cancel=cancel)
        self._start(cmd, run)

    def _research_steer(self, cmd: dict) -> None:
        self.engine.research_steer(cmd["conversation_id"], cmd["message_id"], cmd["text"])

    # One memory about the user (dgc/shared_memory.py): Settings -> Memory, and Forget under a reply.

    def _memory(self, cmd: dict) -> None:
        from ..shared_memory import NotRemembered
        memory, kind, error = self.engine.memory, cmd["type"], None
        try:
            if kind == "memory_add":
                memory.add(cmd["text"])
            elif kind == "memory_edit":
                memory.edit(cmd["id"], cmd["text"])
            elif kind == "memory_forget":
                memory.forget(cmd["id"])
            elif kind == "memory_clear":
                memory.clear()
            elif kind == "memory_project":
                memory.hide_project(cmd["folder"], not cmd["remember"])
                self.engine._projects_cache = (0.0, [])      # the next reply sees the change
        except NotRemembered as exc:
            error = str(exc)
        self._memory_state(cmd["request_id"], error)
        if kind != "memory_list":
            self._history_changed()

    def _memory_history(self, cmd: dict) -> None:
        """Settings -> Memory's history: every change, who made it and when, with Undo where it still can."""
        self._history_wanted = True
        self._send_history(cmd["request_id"], limit=cmd.get("limit"))

    def _send_history(self, request_id: str | None = None, error: str | None = None, *, limit=None) -> None:
        from ..shared_memory import NotRemembered
        try:
            entries = self.engine.memory.history(int(limit) if isinstance(limit, int) and limit > 0 else 50)
        except NotRemembered as exc:
            entries, error = [], error or str(exc)
        fields = {"request_id": request_id} if request_id else {}
        if error:
            fields["error"] = error[:1000]
        self.emit("memory_history", entries=entries, **fields)

    def _history_changed(self) -> None:
        if self._history_wanted:
            self._send_history()

    def _memory_undo(self, cmd: dict) -> None:
        from ..shared_memory import NotRemembered
        error = None
        try:
            self.engine.memory.undo(cmd["id"], by="you")
            self.engine._projects_cache = (0.0, [])
        except NotRemembered as exc:
            error = str(exc)
        self._memory_state()                       # the facts as they are now, for the page and every Forget
        self._send_history(cmd["request_id"], error)

    def _memory_watch(self, cmd: dict) -> None:
        """This screen shows the "Remembered" line a Work session's look back adds: send it memory_learned."""
        self.watching = True
        self._memory_state(cmd["request_id"])

    def learned(self) -> None:
        """Something outside a ChatDGC reply (a Work session's look back) changed memory: refresh what's open."""
        self._memory_state()
        self._history_changed()

    # -- memory that learns: a quiet chat is looked back over (memory_review.Reviews decides when)

    def _review_now(self, conversation_id: str) -> None:
        if self._closing:
            return
        with self._lock:
            if conversation_id in self._turns:
                return                                # it's answering: looked back over when this turn ends
        found = self.engine.review_memory(conversation_id, self._review_cancel,
                                          busy=lambda: conversation_id in self._turns)
        if not found:
            return
        message = found.get("message")
        if message is not None and message.get("id"):
            try:
                marked = self._marked(self.engine.open(conversation_id), [message])[0]
                self.emit("chatdgc_message", conversation_id=conversation_id, message=fit(marked))
            except (ChatEngineError, ChatStoreError):
                pass
        self._memory_state()
        self._history_changed()

    def _review_after(self, conversation_id: str) -> None:
        """A turn ended: look back now if the user said enough since the last time, else once the chat is quiet.
        With memory off for this chat, what was said meanwhile is never looked back over."""
        try:
            chat = self.engine.open(conversation_id)
        except (ChatEngineError, ChatStoreError):
            return
        if not self.engine._memory_on(chat):
            self.engine.skip_review(conversation_id)
            return
        self._reviews.ended(conversation_id)

    def _memory_state(self, request_id: str | None = None, error: str | None = None) -> None:
        from ..shared_memory import NotRemembered, expired, work_projects
        memory = self.engine.memory
        try:
            facts, hidden = memory.facts(), memory.hidden_projects()
        except NotRemembered as exc:
            facts, hidden, error = [], set(), error or str(exc)
        try:
            projects = work_projects()
        except Exception:                         # noqa: BLE001 -- the facts still show
            projects = []
        fields = {"request_id": request_id} if request_id else {}
        if error:
            fields["error"] = error
        self.emit("memory_state", enabled=self.engine.config.get("memory", True) is not False, **fields,
                  facts=[{key: f.get(key) for key in ("id", "text", "created_at", "updated_at")}
                         | ({"edited": True} if f.get("edited") else {})
                         | ({"kind": f["kind"]} if f.get("kind") else {})
                         | ({"until": f["until"], "expired": expired(f)} if f.get("until") else {})
                         | {"source": {k: (f.get("source") or {}).get(k, "") for k in ("surface", "where", "by")}}
                         for f in facts],
                  projects=[{"folder": p["folder"], "name": p["name"], "when": p["when"], "recent": p["recent"],
                             "remember": p["folder"] not in hidden} for p in projects])

    def _continue(self, cmd: dict) -> None:
        def run(cancel, on_start, stream_for, activity):
            return self.engine.continue_reply(cmd["conversation_id"], cmd["message_id"], on_start=on_start,
                                              on_activity=activity, cancel=cancel, **stream_for())
        self._start(cmd, run)

    def _start(self, cmd: dict, run, *, refresh: bool = False) -> None:
        conversation_id, request_id = cmd["conversation_id"], cmd["request_id"]
        chat = self.engine.open(conversation_id)     # an unknown chat is refused here, not on the thread
        cancel = threading.Event()
        with self._lock:
            if self._closing:
                raise ChatEngineError("DGC is shutting down.")
            if conversation_id in self._turns:
                raise ChatEngineError("This chat is still answering. Stop it or wait for it to finish.")
            self._hold_to_write(conversation_id, chat)
            turn = self._turns[conversation_id] = {"cancel": cancel, "reply_id": None, "thread": None,
                                                   "live": _Live(self.emit), "title": chat.get("title")}
        self._reviews.started(conversation_id)       # it isn't quiet any more
        turn["refresh"] = refresh
        thread = threading.Thread(target=self._turn, args=(conversation_id, request_id, cancel, run, turn),
                                  daemon=True, name=f"dgc-chatdgc-{conversation_id[5:13]}")
        turn["thread"] = thread
        thread.start()
        self._turns_changed()

    def _turn(self, conversation_id: str, request_id: str, cancel, run, turn: dict) -> None:
        stream = {"value": None}
        live = turn.get("live") or _Live(self.emit)
        say = live.said                               # every event of the reply: folded into what an open shows

        def on_start(mine, reply_id):
            with live.lock:
                turn["reply_id"] = reply_id
                try:                                  # a reply continued, or research's plan: what it has so far
                    now_chat = self.engine.open(conversation_id)
                    turn["title"] = now_chat.get("title")  # named by its first message by now (the note shows it)
                    existing = next((m for m in now_chat["messages"] if m.get("id") == reply_id), None)
                except (ChatEngineError, ChatStoreError):
                    existing = None
                live.start(reply_id, existing)
                stream["value"] = _Stream(say, conversation_id, reply_id)
                self.emit("chatdgc_turn", conversation_id=conversation_id, state="started", reply_id=reply_id,
                          request_id=request_id)
            self._turns_changed()                     # the note names the chat as its first message did
            if turn.get("refresh"):
                # A new version: the conversation from the fork point on is what it is now, on every screen.
                self._opened(self.engine.open(conversation_id), request_id)
            if mine is not None:
                # Marked as the screen shows it: an edited message carries its ‹ n / m ›. (Sent bare, this echo
                # replaced the marked one the refreshed view had just drawn.)
                marked = self._marked(self.engine.open(conversation_id), [mine])[0]
                self.emit("chatdgc_message", conversation_id=conversation_id, message=fit(marked),
                          request_id=request_id)

        def activity(kind, text):
            if stream["value"] is not None:
                stream["value"].flush()               # what it wrote so far reaches the screen first
            say("chatdgc_activity", conversation_id=conversation_id, message_id=turn["reply_id"], kind=kind,
                text=str(text)[:400])

        def stream_for():
            # The stream exists once on_start ran; the engine calls on_text only after that.
            return {"on_text": lambda part: stream["value"].text(part),
                    "on_thinking": lambda part: stream["value"].thinking(part),
                    "on_compacted": lambda summary: self._compacted(conversation_id, summary),
                    "on_question": question, "on_images": pictures, "on_action": card, "on_file": made,
                    "on_canvas": canvas, "on_widget": widget}

        def widget(shown):
            # An interactive answer: its card shows at once, under the reply, and its tab opens. A screen that tells
            # what it shows gets a moment to (the model checks the widget with it); the reply goes on either way.
            stream["value"].flush()
            with self._lock:
                waiting = {"event": threading.Event(), "report": None} if self._widget_screen else None
                if waiting is not None:
                    self._widget_reports[shown["id"]] = waiting
            say("chatdgc_widget", conversation_id=conversation_id, message_id=turn["reply_id"], widget=shown)
            if waiting is None:
                return None
            try:
                waiting["event"].wait(WIDGET_REPORT_SECONDS)
                return waiting["report"]
            finally:
                with self._lock:
                    if self._widget_reports.get(shown["id"]) is waiting:
                        del self._widget_reports[shown["id"]]

        def canvas(view):
            # A canvas made or changed: the editor beside the chat shows it at once (the reply goes on).
            stream["value"].flush()
            say("chatdgc_canvas", conversation_id=conversation_id, message_id=turn["reply_id"], canvas=view)

        def made(file):
            # A file the reply made: its card shows at once, where the reply is (the reply goes on).
            stream["value"].flush()
            say("chatdgc_made", conversation_id=conversation_id, message_id=turn["reply_id"], file=file)

        def card(action):
            # A plugin's card, as the reply puts it there (the reply goes on): the screen shows it at once.
            stream["value"].flush()
            say("chatdgc_action", conversation_id=conversation_id, message_id=turn["reply_id"], action=action)

        def pictures(shown):
            # From the pictures' own thread, while the answer streams: they show above it as soon as they're kept.
            say("chatdgc_images", conversation_id=conversation_id, message_id=turn["reply_id"], images=shown)

        def question(asked):
            stream["value"].flush()                   # what it wrote before asking reaches the screen first
            say("chatdgc_question", conversation_id=conversation_id, message_id=turn["reply_id"], question=asked)

        try:
            try:
                reply = run(cancel, on_start, stream_for, activity)
            finally:
                if stream["value"] is not None:
                    stream["value"].flush()
                live.finish()                         # saved (or failed): the chat on disk is the truth again
            now_ = self.engine.open(conversation_id)
            # The message the reply answers, as it ended up: a vision model may have added what it saw after the
            # first echo went out.
            at = next((i for i, m in enumerate(now_["messages"]) if m.get("id") == reply.get("id")), None)
            if at and now_["messages"][at - 1].get("role") == "user":
                asked = self._marked(now_, [now_["messages"][at - 1]])[0]
                self.emit("chatdgc_message", conversation_id=conversation_id, message=fit(asked), request_id=request_id)
            marked = self._marked(now_, [reply])[0]
            self.emit("chatdgc_message", conversation_id=conversation_id, message=fit(marked), request_id=request_id)
            self._changed(conversation_id, request_id)
            self._context(conversation_id)
            if reply.get("memory"):
                self._memory_state()                  # Settings -> Memory, if it's open, shows what changed
                self._history_changed()
            if reply.get("finish") == "stop":
                self._name_later(conversation_id)
                self._followups_later(conversation_id, reply["id"])
            turn["look_back"] = True
        except (ChatEngineError, ChatStoreError) as exc:
            if stream["value"] is not None:
                stream["value"].flush()
            if not (cancel.is_set() and isinstance(exc, ChatStoreError)):    # deleted mid-reply: as asked
                self._error(str(exc), request_id, conversation_id)
                self._changed(conversation_id, request_id)
        except Exception as exc:                    # noqa: BLE001 -- a turn must always end on the wire
            self._error(f"ChatDGC hit an error: {' '.join(str(exc).split())[:300] or type(exc).__name__}",
                        request_id, conversation_id)
        finally:
            with live.lock:                           # an open sees it running, or ended: never in between
                with self._lock:
                    if self._turns.get(conversation_id) is turn:
                        del self._turns[conversation_id]
                if turn.get("reply_id"):
                    self.emit("chatdgc_turn", conversation_id=conversation_id, state="ended",
                              reply_id=turn["reply_id"], request_id=request_id)
            self._turns_changed()
            with self._hold_lock:
                link = self._links.get(conversation_id)
            if link is not None:
                # Another window took this chat mid-reply: once what follows the reply has landed, it is that
                # window's for good, and it looks back over it there.
                threading.Thread(target=self._end_link, args=(conversation_id, link), daemon=True,
                                 name=f"dgc-chatdgc-moved-{conversation_id[5:13]}").start()
            elif turn.get("look_back"):
                # After the turn has ended on the wire: what decides when to look back never holds a reply up.
                self._review_after(conversation_id)

    def _name_later(self, conversation_id: str) -> None:
        """A chat's name from its first exchange, off the turn's thread: the reply has already ended. close()
        waits for it, so a name is never written after the process has let go of its chats."""
        def name():
            try:
                if not self._closing and self.engine.name(conversation_id) is not None:
                    self._changed(conversation_id, None)
            except Exception:                         # noqa: BLE001 -- a name is a nicety; its first line stays
                pass
            finally:
                with self._lock:
                    self._naming.discard(threading.current_thread())
                self._turns_changed()                     # the note stops naming the chat as being finished here
        thread = threading.Thread(target=name, daemon=True, name=f"dgc-chatdgc-name-{conversation_id[5:13]}")
        thread.dgc_chat = conversation_id                 # what Open here waits for before it lets the chat go
        with self._lock:
            if self._closing:
                return
            self._naming.add(thread)
        thread.start()

    def _followups_later(self, conversation_id: str, message_id: str) -> None:
        """Suggested next messages for a reply that just ended, off its turn's thread (the reply is already on screen).
        close() waits for it, as for a name."""
        def suggest():
            try:
                found = None if self._closing else self.engine.followups(conversation_id, message_id)
                if found:
                    self.emit("chatdgc_followups", conversation_id=conversation_id, message_id=message_id, followups=found)
            except Exception:                         # noqa: BLE001 -- suggestions are a nicety: none, then
                pass
            finally:
                with self._lock:
                    self._naming.discard(threading.current_thread())
                self._turns_changed()
        thread = threading.Thread(target=suggest, daemon=True, name=f"dgc-chatdgc-next-{conversation_id[5:13]}")
        thread.dgc_chat = conversation_id
        with self._lock:
            if self._closing:
                return
            self._naming.add(thread)
        thread.start()

    def _cancel(self, cmd: dict) -> None:
        with self._lock:
            turn = self._turns.get(cmd["conversation_id"])
        if turn is not None:
            turn["cancel"].set()

    # -- the list's own changes

    def _update(self, cmd: dict) -> None:
        conversation_id, request_id = cmd["conversation_id"], cmd["request_id"]
        chat = self.engine.open(conversation_id)
        if chat.get("temporary") or chat.get("draft"):
            if not cmd.get("delete"):
                raise ChatEngineError("A temporary chat isn't saved, so it can't be renamed, pinned or archived."
                                      if chat.get("temporary") else "Send a message first.")
        if cmd.get("delete"):
            with self._lock:
                turn = self._turns.get(conversation_id)
            if turn is not None:
                turn["cancel"].set()
            self.engine.delete(conversation_id)
            self.emit("chatdgc_changed", conversation_id=conversation_id, summary=None, request_id=request_id)
            return
        changed = self.engine.store.update(conversation_id, title=cmd.get("title"), pinned=cmd.get("pinned"),
                                           archived=cmd.get("archived"))
        self.emit("chatdgc_changed", conversation_id=conversation_id, summary=self._entry(changed),
                  request_id=request_id)

    def _changed(self, conversation_id: str, request_id: str | None) -> None:
        try:
            chat = self.engine.open(conversation_id)
        except (ChatEngineError, ChatStoreError):
            return
        if chat.get("temporary"):
            return
        fields = {"request_id": request_id} if request_id else {}
        self.emit("chatdgc_changed", conversation_id=conversation_id, summary=self._entry(chat), **fields)

    def _entry(self, chat: dict) -> dict:
        """The chat as the list shows it (the index's row)."""
        last = next((m for m in reversed(chat["messages"]) if m.get("text")), None)
        preview = " ".join(str(last.get("text", "")).split())[:200] if last else ""
        return {key: chat.get(key) for key in ("id", "title", "created_at", "updated_at")} | {
            "pinned": bool(chat.get("pinned")), "archived": bool(chat.get("archived")), "preview": preview,
            "messages": len(chat["messages"]),
            # Its project, or null: an open tab shows it in the header, and a move (in or out) reaches it here.
            "project": chat.get("project") or None}

    # -- the process going down

    def busy(self) -> bool:
        with self._lock:
            return bool(self._turns)

    def answering(self) -> list[dict]:
        """The chats with a reply (or a summary, or a card being sent) under way, by id and name: what the process's
        note says of them (dgc ps, Settings -> Running sessions). Each name is read once a turn, not at every note."""
        with self._lock:
            turns = list(self._turns.items())[:16]
        found = []
        for conversation_id, turn in turns:
            title = turn.get("title")
            if not isinstance(title, str):
                try:
                    title = turn["title"] = str(self.engine.open(conversation_id).get("title") or "New chat")
                except Exception:                     # noqa: BLE001 -- deleted meanwhile: still named
                    title = "Chat"
            found.append({"conversation_id": conversation_id, "title": (title or "New chat")[:200]})
        return found

    def _turns_changed(self) -> None:
        """A reply started or ended: the process's note says so (on_turns_changed is the Host's announce_peers)."""
        try:
            self._release_unwanted()                  # before the note: never named while its lock is let go
        except Exception:                             # noqa: BLE001 -- the kernel lets go of it at exit anyway
            pass
        hook = self.on_turns_changed
        if callable(hook):
            try:
                hook()
            except Exception:                         # noqa: BLE001 -- a note is a courtesy
                pass

    def close(self, grace_s: float = CLOSE_GRACE_S) -> None:
        """Stop every reply and wait (briefly) for each to save what it wrote."""
        with self._lock:
            self._closing = True
            turns = list(self._turns.values())
        self._review_cancel.set()
        self._reviews.close(min(grace_s, 2.0))
        for turn in turns:
            turn["cancel"].set()
        deadline = time.monotonic() + grace_s
        for turn in turns:
            thread = turn.get("thread")
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=max(0.0, deadline - time.monotonic()))
        with self._lock:
            naming = list(self._naming)              # a reply that just ended may have started one
        for thread in naming:
            if thread is not threading.current_thread():
                thread.join(timeout=max(0.0, deadline - time.monotonic()))
        self._locks.close()                          # the process's exit would; a service closed in-process too
