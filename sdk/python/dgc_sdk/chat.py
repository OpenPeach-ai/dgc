"""ChatDGC from your program: ``DGC.chat()``.

ChatDGC is DGC's chat app, for everything that isn't code: your model answers, with web search and cited
sources, deep research, and files. The same chats the editor shows (with ``inherit_user_state=True``) or a
private store of your own (the client's isolated state). Everything goes through ``dgc serve``'s ChatDGC
commands (``chatdgc_*``), on a backend of its own that never opens your workspace.

    with DGC(inherit_user_state=True) as dgc:
        chats = dgc.chat()
        reply = chats.ask("How does compound interest work?")
        print(reply.text)
        for source in reply.sources:
            print(source.n, source.title, source.url)

A :class:`Chat` holds one conversation: :meth:`Chat.send` waits for the whole reply, :meth:`Chat.stream`
yields it as it's written, :meth:`Chat.research` runs deep research. One reply at a time per chat; any
number of chats at once.
"""

from __future__ import annotations

import asyncio
import queue
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, AsyncIterator, Callable, Iterator, Mapping, Sequence

from .errors import DGCConfigError, DGCRuntimeError, DGCTimeoutError, DGCUnsupportedError
from .wire.client import DGCClientError, DGCEventTimeout

if TYPE_CHECKING:
    from .session import Session

THINKING = ("off", "low", "medium", "high", "xhigh")
SEARCH = ("off", "auto", "on")
EXPORT_FORMATS = ("markdown", "json")
MAX_FILES = 10
_DONE = object()


@dataclass(frozen=True)
class ChatSource:
    """A page a reply cites: ``[n]`` in its text."""

    n: int
    title: str
    url: str
    snippet: str = ""


@dataclass(frozen=True)
class ChatReply:
    """A finished reply. ``text`` is Markdown with ``[n]`` citations; ``sources`` are what they point to."""

    chat_id: str
    message_id: str
    text: str
    sources: tuple[ChatSource, ...] = ()
    searches: tuple[str, ...] = ()
    files: tuple[Mapping[str, Any], ...] = ()
    model: str = ""
    finish: str = ""
    usage: Mapping[str, Any] = field(default_factory=dict)
    research: Mapping[str, Any] | None = None
    raw: Mapping[str, Any] = field(default_factory=dict, repr=False)


@dataclass(frozen=True)
class ChatSummary:
    """A chat in the list, newest first."""

    id: str
    title: str
    created_at: str
    updated_at: str
    preview: str = ""
    messages: int = 0
    pinned: bool = False
    archived: bool = False
    project: str = ""


@dataclass(frozen=True)
class ChatEvent:
    """One moment of a reply, from :meth:`Chat.stream`.

    ``kind``: ``"text"`` (``text`` is the next piece of the reply), ``"thinking"`` (the model's thinking, when
    it shows it), ``"activity"`` (``data`` = {kind, text}: searching, looking, compacting, ...), ``"question"``
    (``data`` is a question the reply put to you), ``"research"`` (``data`` is deep research's progress) or
    ``"reply"`` (the last one: ``reply`` is the finished :class:`ChatReply`).
    """

    kind: str
    text: str = ""
    data: Mapping[str, Any] = field(default_factory=dict)
    reply: ChatReply | None = None


def _reply(chat_id: str, message: Mapping[str, Any]) -> ChatReply:
    sources = tuple(
        ChatSource(n=int(s.get("n") or 0), title=str(s.get("title") or ""), url=str(s.get("url") or ""),
                   snippet=str(s.get("snippet") or ""))
        for s in message.get("sources") or [] if isinstance(s, Mapping))
    research = message.get("research")
    return ChatReply(
        chat_id=chat_id, message_id=str(message.get("id") or ""), text=str(message.get("text") or ""),
        sources=sources, searches=tuple(str(q) for q in message.get("searches") or []),
        files=tuple(dict(f) for f in message.get("files") or [] if isinstance(f, Mapping)),
        model=str(message.get("model") or ""), finish=str(message.get("finish") or ""),
        usage=dict(message.get("usage") or {}), research=dict(research) if isinstance(research, Mapping) else None,
        raw=dict(message))


def _summary(row: Mapping[str, Any]) -> ChatSummary:
    return ChatSummary(id=str(row.get("id") or ""), title=str(row.get("title") or ""),
                       created_at=str(row.get("created_at") or ""), updated_at=str(row.get("updated_at") or ""),
                       preview=str(row.get("preview") or ""), messages=int(row.get("messages") or 0),
                       pinned=bool(row.get("pinned")), archived=bool(row.get("archived")),
                       project=str(row.get("project") or ""))


def _choice(value: str | None, allowed: Sequence[str], name: str) -> str | None:
    if value is None:
        return None
    if value not in allowed:
        raise DGCConfigError(f"{name} must be one of {', '.join(allowed)}")
    return value


def _answer_text(text: str) -> str:
    """An answer as it's sent: without the spaces (or a byte-order mark) around it, as the TypeScript SDK trims it."""
    return text.strip().strip("\ufeff").strip()


class Chats:
    """ChatDGC on its own backend: list, open and start chats. Made by :meth:`DGC.chat`; close it (or the
    client) when done."""

    def __init__(self, session: "Session", *, model: str | None = None, thinking: str | None = None,
                 reply_timeout: float | None = None, owns_session: bool = True):
        chatdgc = session.capabilities.get("chatdgc")
        if not isinstance(chatdgc, Mapping) or int(chatdgc.get("version") or 0) < 1:
            raise DGCUnsupportedError("This DGC CLI has no ChatDGC; update it (dgc update).")
        self._session = session
        self._raw = session.raw
        self._owns_session = owns_session
        self._model = model
        self._thinking = _choice(thinking, THINKING, "thinking")
        if reply_timeout is not None and (isinstance(reply_timeout, bool) or not isinstance(reply_timeout, (int, float))
                                          or not reply_timeout > 0 or reply_timeout != reply_timeout):
            raise DGCConfigError("reply_timeout must be a positive number of seconds, or None for no limit")
        self._reply_timeout = None if reply_timeout is None else float(reply_timeout)
        self._lock = threading.Lock()
        self._outstanding: set[str] = set()
        self._listeners: dict[str, queue.Queue] = {}
        self._titles: dict[str, str] = {}
        self._failure: BaseException | None = None
        self._closed = False
        self._reader = threading.Thread(target=self._read, name="dgc-sdk-chat", daemon=True)
        self._reader.start()

    # -- the one reader: every ChatDGC event goes to its conversation; a reply to a request is left for it

    def _takeable(self, event: Mapping[str, Any]) -> bool:
        rid = event.get("request_id")
        with self._lock:
            return not (isinstance(rid, str) and rid in self._outstanding)

    def _read(self) -> None:
        while not self._closed:
            try:
                event = self._raw.wait_for(predicate=self._takeable, timeout=0.5)
            except DGCEventTimeout:
                continue
            except DGCClientError as exc:                 # the backend went away
                self._fail(exc)
                return
            except Exception as exc:                      # noqa: BLE001 -- a reader that dies must say so
                self._fail(exc)
                return
            kind = str(event.get("type") or "")
            conversation = event.get("conversation_id")
            if kind == "chatdgc_changed" and isinstance(event.get("summary"), Mapping):
                summary = event["summary"]
                if isinstance(conversation, str) and summary.get("title"):
                    with self._lock:
                        self._titles[conversation] = str(summary["title"])
            if not kind.startswith("chatdgc_") or not isinstance(conversation, str):
                continue
            with self._lock:
                listener = self._listeners.get(conversation)
            if listener is not None:
                listener.put(event)

    def _fail(self, exc: BaseException) -> None:
        with self._lock:
            self._failure = exc
            listeners = list(self._listeners.values())
        for listener in listeners:
            listener.put(_DONE)

    def _request(self, command: dict[str, Any], response: str, timeout: float | None = None) -> dict[str, Any]:
        if self._closed:
            raise DGCRuntimeError("these chats are closed")
        rid = f"chat-{time.monotonic_ns():x}"
        command = {**command, "request_id": rid}
        with self._lock:
            self._outstanding.add(rid)
        try:
            return self._session._request(command, response, timeout, request_id=rid)
        finally:
            with self._lock:
                self._outstanding.discard(rid)

    # -- the list

    def list(self, query: str | None = None, *, limit: int = 50, offset: int = 0,
             archived: bool = False) -> list[ChatSummary]:
        """Chats, newest first; ``query`` finds a chat by its title or anything said in it."""
        command: dict[str, Any] = {"type": "chatdgc_list", "limit": max(1, min(int(limit), 200)),
                                   "offset": max(0, int(offset)), "archived": bool(archived)}
        if query:
            command["query"] = str(query)[:500]
        answer = self._request(command, "chatdgc_chats")
        return [_summary(row) for row in answer.get("chats") or [] if isinstance(row, Mapping)]

    def new(self, *, temporary: bool = False) -> "Chat":
        """A new chat. It's saved (and listed) from its first message; a temporary one never is."""
        answer = self._request({"type": "chatdgc_open", **({"temporary": True} if temporary else {})}, "chatdgc_opened")
        return Chat(self, answer)

    def open(self, chat_id: str) -> "Chat":
        """An existing chat, with its latest messages."""
        if not isinstance(chat_id, str) or not chat_id:
            raise DGCConfigError("chat_id must be a chat's id")
        return Chat(self, self._request({"type": "chatdgc_open", "conversation_id": chat_id}, "chatdgc_opened"))

    def ask(self, text: str, **options: Any) -> ChatReply:
        """One question in a new chat: its reply. Options as :meth:`Chat.send`, plus ``temporary``."""
        temporary = bool(options.pop("temporary", False))
        return self.new(temporary=temporary).send(text, **options)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._fail(DGCRuntimeError("these chats are closed"))
        if self._owns_session:
            self._session.close()

    def __enter__(self) -> "Chats":
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.close()


class Chat:
    """One conversation. ``id``, ``title`` and ``messages`` (as the chat was opened, then each turn's)."""

    def __init__(self, chats: Chats, opened: Mapping[str, Any]):
        self._chats = chats
        conversation = opened.get("conversation") if isinstance(opened.get("conversation"), Mapping) else {}
        self.id: str = str(conversation.get("id") or "")
        self._title = str(conversation.get("title") or "New chat")
        self.temporary: bool = bool(conversation.get("temporary"))
        self.messages: list[dict[str, Any]] = [dict(m) for m in opened.get("messages") or [] if isinstance(m, Mapping)]
        if not self.id:
            raise DGCRuntimeError("ChatDGC opened a chat without an id")

    @property
    def title(self) -> str:
        with self._chats._lock:
            return self._chats._titles.get(self.id, self._title)

    # -- a reply

    def _turn(self, command: dict[str, Any], timeout: float | None) -> Iterator[ChatEvent]:
        chats = self._chats
        if chats._closed:
            raise DGCRuntimeError("these chats are closed")
        listener: queue.Queue = queue.Queue()
        rid = f"chat-{time.monotonic_ns():x}"
        with chats._lock:
            if self.id in chats._listeners:
                raise DGCRuntimeError("this chat is already answering; wait for its reply")
            chats._listeners[self.id] = listener
        limit = chats._reply_timeout if timeout is None else float(timeout)
        deadline = None if limit is None else time.monotonic() + limit
        try:
            try:
                chats._raw.send({**command, "conversation_id": self.id, "request_id": rid})
            except DGCClientError as exc:
                raise DGCRuntimeError(str(exc)) from exc
            started = False
            final: ChatReply | None = None
            while True:
                left = 1.0 if deadline is None else deadline - time.monotonic()
                if left <= 0:
                    self.cancel()
                    raise DGCTimeoutError("ChatDGC didn't finish the reply in time; it was stopped")
                try:
                    event = listener.get(timeout=min(left, 1.0))
                except queue.Empty:
                    continue
                if event is _DONE:
                    raise DGCRuntimeError(str(chats._failure or "the ChatDGC backend went away"))
                kind = event["type"]
                if kind == "chatdgc_error":
                    if event.get("request_id") == rid or started:
                        raise DGCRuntimeError(str(event.get("message") or "ChatDGC couldn't answer"))
                    continue
                if kind == "chatdgc_turn":
                    if event.get("state") == "started":
                        started = True
                    elif event.get("state") == "ended" and started:
                        if final is None:
                            raise DGCRuntimeError("ChatDGC ended the reply without one")
                        yield ChatEvent("reply", reply=final)
                        return
                elif kind == "chatdgc_delta" and started:
                    if event.get("text"):
                        yield ChatEvent("text", text=str(event["text"]))
                    if event.get("thinking"):
                        yield ChatEvent("thinking", text=str(event["thinking"]))
                elif kind == "chatdgc_activity" and started:
                    yield ChatEvent("activity", text=str(event.get("text") or ""),
                                    data={"kind": event.get("kind"), "text": event.get("text")})
                elif kind == "chatdgc_question" and started:
                    yield ChatEvent("question", data=dict(event.get("question") or {}))
                elif kind == "chatdgc_research":
                    yield ChatEvent("research", data=dict(event.get("research") or {}))
                elif kind == "chatdgc_message" and isinstance(event.get("message"), Mapping):
                    message = dict(event["message"])
                    self._remember(message)
                    if message.get("role") == "assistant" and started:
                        final = _reply(self.id, message)
        finally:
            with chats._lock:
                if chats._listeners.get(self.id) is listener:
                    del chats._listeners[self.id]

    def _card(self, message_id: str, question: int) -> dict[str, Any] | None:
        """The question card ``question`` of reply ``message_id``, as this chat last saw it (None when unknown)."""
        for message in self.messages:
            if message.get("id") == message_id and message.get("role") == "assistant":
                asked = message.get("questions") if isinstance(message.get("questions"), list) else []
                return asked[question] if 0 <= question < len(asked) and isinstance(asked[question], Mapping) else None
        return None

    def _remember(self, message: dict[str, Any]) -> None:
        for index, known in enumerate(self.messages):
            if known.get("id") == message.get("id"):
                self.messages[index] = message
                return
        self.messages.append(message)

    def _send_command(self, text: str, model: str | None, thinking: str | None, search: str | None,
                      files: Sequence[str | Path], study: bool | None = None) -> dict[str, Any]:
        if not isinstance(text, str) or not text.strip():
            raise DGCConfigError("text must be a non-empty message")
        if len(files) > MAX_FILES:
            raise DGCConfigError(f"a message takes at most {MAX_FILES} files")
        command: dict[str, Any] = {"type": "chatdgc_send", "text": text}
        model = model or self._chats._model
        thinking = _choice(thinking, THINKING, "thinking") or self._chats._thinking
        if model:
            command["model"] = str(model)
        if thinking:
            command["thinking"] = thinking
        if search is not None:
            command["search"] = _choice(search, SEARCH, "search")
        if study is not None:
            if not isinstance(study, bool):
                raise DGCConfigError("study must be True or False")
            command["study"] = study
        if files:
            attachments = []
            for item in files:
                path = Path(item).expanduser().resolve()
                if not path.is_file():
                    raise DGCConfigError(f"not a file: {path}")
                attachments.append({"kind": "file", "path": str(path)})
            command["attachments"] = attachments
        return command

    def stream(self, text: str, *, model: str | None = None, thinking: str | None = None,
               search: str | None = None, files: Sequence[str | Path] = (), study: bool | None = None,
               timeout: float | None = None) -> Iterator[ChatEvent]:
        """Send a message and yield the reply as it's written; the last event is ``"reply"``.

        ``search``: ``"auto"`` (the default: it searches when an answer depends on facts), ``"on"`` (search first)
        or ``"off"``. ``files``: up to ten local files the backend reads. ``study``: True turns Study mode on for the
        chat from this message (it teaches instead of answering), False turns it off; left out, the chat stays as it
        is. ``timeout``: seconds for the whole reply (default: the client's ``reply_timeout``, which is no limit unless it
        was given one); past it the reply is stopped."""
        return self._turn(self._send_command(text, model, thinking, search, files, study), timeout)

    def send(self, text: str, **options: Any) -> ChatReply:
        """Send a message and wait for the whole reply. Options as :meth:`stream`."""
        reply = None
        for event in self.stream(text, **options):
            if event.kind == "reply":
                reply = event.reply
        assert reply is not None
        return reply

    def research(self, question: str, *, edit_plan: Callable[[dict[str, Any]], Mapping[str, Any] | None] | None = None,
                 model: str | None = None, thinking: str | None = None, timeout: float | None = None,
                 on_event: Callable[[ChatEvent], None] | None = None) -> ChatReply:
        """Deep research: a plan ({title, steps, sites}), then the research, then a report whose citations are
        checked. ``edit_plan`` gets the plan and may return a changed one (or None to keep it), as you'd edit it
        in the editor. ``on_event`` sees the progress. ``timeout``: seconds for each of its two turns (default: the
        client's ``reply_timeout``, which is no limit unless it was given one). Returns the report."""
        if not isinstance(question, str) or not question.strip():
            raise DGCConfigError("question must be non-empty")
        command: dict[str, Any] = {"type": "chatdgc_research", "text": question}
        if model or self._chats._model:
            command["model"] = str(model or self._chats._model)
        if thinking or self._chats._thinking:
            command["thinking"] = _choice(thinking, THINKING, "thinking") or self._chats._thinking
        planned = None
        for event in self._turn(command, timeout):
            if on_event is not None:
                on_event(event)
            if event.kind == "reply":
                planned = event.reply
        assert planned is not None
        plan = dict((planned.research or {}).get("plan") or {})
        if not plan:
            return planned                            # it answered without researching (a quick question)
        if edit_plan is not None:
            changed = edit_plan(dict(plan))
            if changed is not None:
                plan = dict(changed)
        report = None
        for event in self._turn({"type": "chatdgc_research_start", "message_id": planned.message_id, "plan": plan},
                                timeout):
            if on_event is not None:
                on_event(event)
            if event.kind == "reply":
                report = event.reply
        assert report is not None
        return report

    def answer(self, message_id: str, choice: str | None = None, *, question: int = 0,
               choices: Sequence[str] | None = None, model: str | None = None, thinking: str | None = None,
               search: str | None = None, timeout: float | None = None) -> ChatReply:
        """Answer the question card a reply asked (a ``"question"`` event), as a click on it does: the message the
        model wrote for it is sent with your answer in, and its reply comes back. ``choice`` answers a one-question
        card (one of its options, or your own words); ``choices`` answers a card of several questions, one each, in
        order. Only while that reply is the last thing said."""
        if not isinstance(message_id, str) or not message_id:
            raise DGCConfigError("message_id must be the id of the reply that asked")
        if isinstance(question, bool) or not isinstance(question, int) or question < 0:
            raise DGCConfigError("question must be the card's index (0 for the first)")
        command: dict[str, Any] = {"type": "chatdgc_answer", "message_id": message_id, "question": question}
        card = self._card(message_id, question)
        form = card.get("questions") if card and isinstance(card.get("questions"), list) and len(card["questions"]) > 1 else None
        if choices is not None:
            if isinstance(choices, (str, bytes)) or not all(isinstance(c, str) for c in choices):
                raise DGCConfigError("choices must be a list of answers, each one text")
            picked = [_answer_text(c) for c in choices]
            if not 2 <= len(picked) <= 4 or not all(1 <= len(c) <= 500 for c in picked):
                raise DGCConfigError("choices must be 2 to 4 answers of 1 to 500 characters, one for each question on the card")
            if card is not None and form is None:
                raise DGCConfigError("that card asks one question: answer it with choice")
            if form is not None and len(form) != len(picked):
                raise DGCConfigError(f"that card asks {len(form)} questions: give one answer each")
            forms = (self._chats._session.capabilities.get("chatdgc") or {}).get("question_forms")
            if not isinstance(forms, int) or forms < 1:
                raise DGCUnsupportedError("This DGC CLI can't take a card of several questions; update it (dgc update).")
            command["choice"], command["choices"] = picked[0], picked
        else:
            if not isinstance(choice, str) or not 1 <= len(_answer_text(choice)) <= 500:
                raise DGCConfigError("choice must be the answer, 1 to 500 characters")
            if form is not None:
                raise DGCConfigError(f"that card asks {len(form)} questions: answer them with choices=[...], one each")
            command["choice"] = _answer_text(choice)
        model = model or self._chats._model
        thinking = _choice(thinking, THINKING, "thinking") or self._chats._thinking
        if model:
            command["model"] = str(model)
        if thinking:
            command["thinking"] = thinking
        if search is not None:
            command["search"] = _choice(search, SEARCH, "search")
        reply = None
        for event in self._turn(command, timeout):
            if event.kind == "reply":
                reply = event.reply
        assert reply is not None
        return reply

    def cancel(self) -> None:
        """Stop the reply being written; what it wrote so far is kept."""
        try:
            self._chats._raw.send({"type": "chatdgc_cancel", "conversation_id": self.id})
        except DGCClientError:
            pass

    # -- the chat itself

    def _update(self, **fields: Any) -> None:
        self._chats._request({"type": "chatdgc_update", "conversation_id": self.id, **fields}, "chatdgc_changed")

    def rename(self, title: str) -> None:
        if not isinstance(title, str) or not title.strip():
            raise DGCConfigError("title must be non-empty")
        self._update(title=title.strip()[:200])
        with self._chats._lock:
            self._chats._titles[self.id] = title.strip()[:200]

    def pin(self, pinned: bool = True) -> None:
        self._update(pinned=bool(pinned))

    def archive(self, archived: bool = True) -> None:
        self._update(archived=bool(archived))

    def delete(self) -> None:
        """Delete the chat (its canvases and files too). It can't be undone."""
        self._update(delete=True)

    def export(self, path: str | Path, *, format: str = "markdown") -> Path:
        """Save the chat as Markdown (what you see, with its sources) or JSON (everything)."""
        if format not in EXPORT_FORMATS:
            raise DGCConfigError("format must be markdown or json")
        target = Path(path).expanduser().resolve()
        answer = self._chats._request({"type": "chatdgc_export", "conversation_id": self.id, "path": str(target),
                                       "format": format}, "chatdgc_exported", timeout=120.0)
        return Path(str(answer.get("path") or target))

    def refresh(self) -> None:
        """Read the chat again (another client may have added to it)."""
        opened = self._chats._request({"type": "chatdgc_open", "conversation_id": self.id}, "chatdgc_opened")
        self.messages = [dict(m) for m in opened.get("messages") or [] if isinstance(m, Mapping)]
        conversation = opened.get("conversation") if isinstance(opened.get("conversation"), Mapping) else {}
        if conversation.get("title"):
            self._title = str(conversation["title"])


class AsyncChats:
    """:class:`Chats`, awaitable (from :meth:`AsyncDGC.chat`)."""

    def __init__(self, chats: Chats):
        self._sync = chats

    @property
    def sync(self) -> Chats:
        return self._sync

    async def list(self, query: str | None = None, **options: Any) -> list[ChatSummary]:
        return await asyncio.to_thread(self._sync.list, query, **options)

    async def new(self, *, temporary: bool = False) -> "AsyncChat":
        return AsyncChat(await asyncio.to_thread(self._sync.new, temporary=temporary))

    async def open(self, chat_id: str) -> "AsyncChat":
        return AsyncChat(await asyncio.to_thread(self._sync.open, chat_id))

    async def ask(self, text: str, **options: Any) -> ChatReply:
        return await asyncio.to_thread(self._sync.ask, text, **options)

    async def close(self) -> None:
        await asyncio.to_thread(self._sync.close)

    async def __aenter__(self) -> "AsyncChats":
        return self

    async def __aexit__(self, *_exc: Any) -> None:
        await self.close()


class AsyncChat:
    """:class:`Chat`, awaitable; :meth:`stream` is an async iterator."""

    def __init__(self, chat: Chat):
        self._sync = chat

    @property
    def sync(self) -> Chat:
        return self._sync

    @property
    def id(self) -> str:
        return self._sync.id

    @property
    def title(self) -> str:
        return self._sync.title

    @property
    def messages(self) -> list[dict[str, Any]]:
        return self._sync.messages

    async def send(self, text: str, **options: Any) -> ChatReply:
        return await asyncio.to_thread(self._sync.send, text, **options)

    async def answer(self, message_id: str, choice: str | None = None, **options: Any) -> ChatReply:
        """:meth:`Chat.answer`, awaitable."""
        return await asyncio.to_thread(self._sync.answer, message_id, choice, **options)

    async def stream(self, text: str, **options: Any) -> AsyncIterator[ChatEvent]:
        """Yield :class:`ChatEvent` as the reply is written; the last one is ``"reply"``."""
        loop = asyncio.get_running_loop()
        events: asyncio.Queue = asyncio.Queue()

        def pump() -> None:
            try:
                for event in self._sync.stream(text, **options):
                    loop.call_soon_threadsafe(events.put_nowait, event)
            except BaseException as exc:              # noqa: BLE001 -- handed to the awaiting side
                loop.call_soon_threadsafe(events.put_nowait, exc)
            finally:
                loop.call_soon_threadsafe(events.put_nowait, _DONE)

        worker = threading.Thread(target=pump, name="dgc-sdk-chat-stream", daemon=True)
        worker.start()
        while True:
            item = await events.get()
            if item is _DONE:
                return
            if isinstance(item, BaseException):
                raise item
            yield item

    async def research(self, question: str, **options: Any) -> ChatReply:
        return await asyncio.to_thread(self._sync.research, question, **options)

    async def cancel(self) -> None:
        await asyncio.to_thread(self._sync.cancel)

    async def rename(self, title: str) -> None:
        await asyncio.to_thread(self._sync.rename, title)

    async def pin(self, pinned: bool = True) -> None:
        await asyncio.to_thread(self._sync.pin, pinned)

    async def archive(self, archived: bool = True) -> None:
        await asyncio.to_thread(self._sync.archive, archived)

    async def delete(self) -> None:
        await asyncio.to_thread(self._sync.delete)

    async def export(self, path: str | Path, *, format: str = "markdown") -> Path:
        return await asyncio.to_thread(self._sync.export, path, format=format)

    async def refresh(self) -> None:
        await asyncio.to_thread(self._sync.refresh)
