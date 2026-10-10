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

PAGE_BYTES = 3 * 1024 * 1024          # one frame's messages, encoded
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
                                                                      "project": chat.get("project")}


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


class ChatService:
    def __init__(self, emit, config, engine: ChatEngine | None = None):
        self.emit = emit
        self.engine = engine or ChatEngine(config)
        self._turns: dict[str, dict] = {}
        self._naming: set[threading.Thread] = set()     # chats being named after their first reply
        self._lock = threading.Lock()
        self._closing = False

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
             "chatdgc_send": self._send, "chatdgc_continue": self._continue, "chatdgc_cancel": self._cancel,
             "chatdgc_update": self._update, "chatdgc_file": self._file, "chatdgc_edit": self._edit,
             "chatdgc_regenerate": self._regenerate, "chatdgc_version": self._version, "chatdgc_answer": self._answer,
             "chatdgc_export": self._export, "chatdgc_compact": self._compact_now, "chatdgc_summary": self._summary,
             "chatdgc_carry": self._carry, "chatdgc_branch": self._branch, "chatdgc_research": self._research,
             "chatdgc_projects": self._projects, "chatdgc_project": self._project, "chatdgc_move": self._move,
             "chatdgc_library": self._library, "chatdgc_library_file": self._library_file,
             "chatdgc_action": self._action, "chatdgc_pips": self._pips,
             "chatdgc_research_start": self._research_start, "chatdgc_research_steer": self._research_steer,
             "memory_list": self._memory, "memory_add": self._memory, "memory_edit": self._memory,
             "memory_forget": self._memory, "memory_clear": self._memory, "memory_project": self._memory}[kind](cmd)
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
        messages, earlier = page(chat["messages"])
        with self._lock:
            turn = self._turns.get(chat["id"])
        fields = {"reply_id": turn["reply_id"]} if turn and turn.get("reply_id") else {}
        project = self.engine._project_of(chat)
        if project:
            fields["project"] = project            # its page, and the chat's header, show it
        self.emit("chatdgc_opened", request_id=request_id, conversation=summary(chat),
                  messages=self._marked(chat, messages), earlier=earlier, busy=turn is not None, **fields)

    def _open(self, cmd: dict) -> None:
        chat = self.engine.open(cmd.get("conversation_id") or None, temporary=bool(cmd.get("temporary")),
                                project=cmd.get("project") or None)
        self._opened(chat, cmd["request_id"])
        self._context_later(chat["id"])

    def _context(self, conversation_id: str) -> None:
        """What the chat takes of its window, said on the wire (the model's limit may be asked of the provider)."""
        try:
            fields = self.engine.context(conversation_id)
        except Exception:                             # noqa: BLE001 -- a meter is a nicety
            return
        self.emit("chatdgc_context", conversation_id=conversation_id, **fields)

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
        of its own, so nothing else runs in that chat meanwhile and Stop ends it."""
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
            try:
                self.emit("chatdgc_activity", conversation_id=conversation_id, message_id=request_id[:64],
                          kind="compacting", text="")
                work(cancel)
            except (ChatEngineError, ChatStoreError) as exc:
                self._error(str(exc), request_id, conversation_id)
            except Exception as exc:                  # noqa: BLE001
                self._error(f"ChatDGC hit an error: {' '.join(str(exc).split())[:300] or type(exc).__name__}",
                            request_id, conversation_id)
            finally:
                with self._lock:
                    if self._turns.get(conversation_id) is slot:
                        del self._turns[conversation_id]
        slot["thread"] = threading.Thread(target=run, daemon=True, name=f"dgc-chatdgc-work-{conversation_id[5:13]}")
        slot["thread"].start()

    def _compact_now(self, cmd: dict) -> None:
        def work(cancel):
            summary = self.engine.compact(cmd["conversation_id"], cancel=cancel)
            self._compacted(cmd["conversation_id"], summary, cmd["request_id"])
            self._context(cmd["conversation_id"])
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
                                          limit=cmd.get("limit", 60), offset=cmd.get("offset", 0))
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
        thread = threading.Thread(target=run, daemon=True, name="chatdgc-action")
        slot["thread"] = thread
        thread.start()

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
                                    attachments=cmd.get("attachments"),
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
                                      model=cmd.get("model"), thinking=cmd.get("thinking"),
                                      search=cmd.get("search", "auto"), on_start=on_start, on_activity=activity,
                                      cancel=cancel, **stream_for())
        self._start(cmd, run)

    # Deep research: the plan is one turn, the research another (on the same reply); progress is chatdgc_research.

    def _researched(self, conversation_id: str):
        def said(message_id, state):
            self.emit("chatdgc_research", conversation_id=conversation_id, message_id=message_id, research=state)
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

    def _memory_state(self, request_id: str | None = None, error: str | None = None) -> None:
        from ..shared_memory import NotRemembered, work_projects
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
                         | {"source": {k: (f.get("source") or {}).get(k, "") for k in ("surface", "where")}}
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
        self.engine.open(conversation_id)            # an unknown chat is refused here, not on the thread
        cancel = threading.Event()
        with self._lock:
            if self._closing:
                raise ChatEngineError("DGC is shutting down.")
            if conversation_id in self._turns:
                raise ChatEngineError("This chat is still answering. Stop it or wait for it to finish.")
            turn = self._turns[conversation_id] = {"cancel": cancel, "reply_id": None, "thread": None}
        turn["refresh"] = refresh
        thread = threading.Thread(target=self._turn, args=(conversation_id, request_id, cancel, run, turn),
                                  daemon=True, name=f"dgc-chatdgc-{conversation_id[5:13]}")
        turn["thread"] = thread
        thread.start()

    def _turn(self, conversation_id: str, request_id: str, cancel, run, turn: dict) -> None:
        stream = {"value": None}

        def on_start(mine, reply_id):
            turn["reply_id"] = reply_id
            stream["value"] = _Stream(self.emit, conversation_id, reply_id)
            self.emit("chatdgc_turn", conversation_id=conversation_id, state="started", reply_id=reply_id,
                      request_id=request_id)
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
            self.emit("chatdgc_activity", conversation_id=conversation_id, message_id=turn["reply_id"], kind=kind,
                      text=str(text)[:400])

        def stream_for():
            # The stream exists once on_start ran; the engine calls on_text only after that.
            return {"on_text": lambda part: stream["value"].text(part),
                    "on_thinking": lambda part: stream["value"].thinking(part),
                    "on_compacted": lambda summary: self._compacted(conversation_id, summary),
                    "on_question": question, "on_images": pictures, "on_action": card}

        def card(action):
            # A plugin's card, as the reply puts it there (the reply goes on): the screen shows it at once.
            stream["value"].flush()
            self.emit("chatdgc_action", conversation_id=conversation_id, message_id=turn["reply_id"], action=action)

        def pictures(shown):
            # From the pictures' own thread, while the answer streams: they show above it as soon as they're kept.
            self.emit("chatdgc_images", conversation_id=conversation_id, message_id=turn["reply_id"], images=shown)

        def question(asked):
            stream["value"].flush()                   # what it wrote before asking reaches the screen first
            self.emit("chatdgc_question", conversation_id=conversation_id, message_id=turn["reply_id"],
                      question=asked)

        try:
            reply = run(cancel, on_start, stream_for, activity)
            if stream["value"] is not None:
                stream["value"].flush()
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
            if reply.get("finish") == "stop":
                self._name_later(conversation_id)
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
            with self._lock:
                if self._turns.get(conversation_id) is turn:
                    del self._turns[conversation_id]
            if turn.get("reply_id"):
                self.emit("chatdgc_turn", conversation_id=conversation_id, state="ended",
                          reply_id=turn["reply_id"], request_id=request_id)

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

    def close(self, grace_s: float = CLOSE_GRACE_S) -> None:
        """Stop every reply and wait (briefly) for each to save what it wrote."""
        with self._lock:
            self._closing = True
            turns = list(self._turns.values())
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
