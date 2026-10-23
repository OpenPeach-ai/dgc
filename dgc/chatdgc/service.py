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

from ..editor_protocol import command_error
from .engine import ChatEngine, ChatEngineError
from .store import ChatStoreError

WIDGET_REPORT_SECONDS = 6.0        # how long a reply waits to hear what its widget shows
WIDGET_REPORT_CHARS = 4_000

PAGE_BYTES = 3 * 1024 * 1024          # one frame's messages, encoded
OUTLINE_PROMPTS = 4000                # the latest prompts an outline lists: well inside one frame
OUTLINE_CHARS = 160                   # of each prompt's words
PREVIEW_BYTES = 2_500_000             # an image shown in the chat: its data: URI must fit one frame
FLUSH_S = 0.05
FLUSH_CHARS = 16_000
CLOSE_GRACE_S = 5.0


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
        self.emit = emit
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

    # -- the router's door

    def dispatch(self, cmd: dict) -> None:
        kind = cmd.get("type")
        request_id = cmd.get("request_id") if isinstance(cmd.get("request_id"), str) else None
        problem = command_error(cmd)
        if problem:
            return self._error(f"invalid command: {problem}", request_id, None)
        conversation_id = cmd.get("conversation_id")
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
             "memory_list": self._memory, "memory_add": self._memory, "memory_edit": self._memory,
             "memory_forget": self._memory, "memory_clear": self._memory, "memory_project": self._memory,
             "memory_history": self._memory_history, "memory_undo": self._memory_undo,
             "memory_watch": self._memory_watch}[kind](cmd)
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
        self._opened(chat, cmd["request_id"])
        self._context_later(chat["id"])

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
        self.engine.open(conversation_id)
        cancel = threading.Event()
        with self._lock:
            if self._closing:
                raise ChatEngineError("DGC is shutting down.")
            if conversation_id in self._turns:
                raise ChatEngineError("This chat is still answering. Stop it or wait for it to finish.")
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
        self.engine.open(conversation_id)
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
            if turn.get("look_back"):
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
        thread = threading.Thread(target=name, daemon=True, name=f"dgc-chatdgc-name-{conversation_id[5:13]}")
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
        thread = threading.Thread(target=suggest, daemon=True, name=f"dgc-chatdgc-next-{conversation_id[5:13]}")
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
