"""`dgc chat`: ChatDGC in the terminal.

ChatDGC is DGC's chat app, for everything that isn't code: your model answers, searching the web when an answer
depends on it, with its sources. These are the same chats as the editor's Chat tab (~/.dgc/chat). The service runs
in this process (dgc/chatdgc/service.py), driven by the same `chatdgc_*` commands the editor sends.

    dgc chat                          a chat you type into (/help inside for its commands)
    dgc chat "How does compound interest work?"     one question, its answer, then exit
    echo "Summarise this" | dgc chat --file notes.pdf
    dgc chat --list [QUERY]           your chats, newest first
    dgc chat --resume ID ["question"] continue a chat
    dgc chat --export ID [-o FILE]    save a chat as Markdown (JSON with --json)
"""

from __future__ import annotations

import argparse
import json
import queue
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, TextIO

THINKING = ("off", "low", "medium", "high", "xhigh")
SEARCH = ("off", "auto", "on")
MAX_FILES = 10
REPLY_TIMEOUT_S = 1800.0
USAGE = ("dgc chat [QUESTION] [--resume ID] [--list [QUERY]] [--export ID [-o FILE]] [--model M] "
         "[--think LEVEL] [--search off|auto|on] [--temporary] [--file PATH]... [--json]")
HELP = """Commands, inside a chat:
  /new              a new chat
  /list [QUERY]     your chats, newest first
  /open ID          continue another chat
  /title TEXT       rename this chat
  /export [FILE]    save this chat as Markdown
  /help             this list
  /quit             leave (Ctrl-D does too); Ctrl-C stops a reply"""


class ChatCliError(Exception):
    """Something ChatDGC refused or couldn't do; its message is the user's to read."""


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dgc chat", allow_abbrev=False,
        description="ChatDGC in the terminal: DGC's chat app, for everything that isn't code. Your model answers, "
                    "searching the web when an answer depends on it, with its sources. The same chats as the "
                    "editor's Chat tab.")
    p.add_argument("question", nargs="*", help="ask this and exit (none: a chat you type into; piped text is a question)")
    p.add_argument("--resume", metavar="ID", help="continue the chat with this id")
    p.add_argument("--list", nargs="?", const="", metavar="QUERY",
                   help="your chats, newest first; QUERY finds one by its title or anything said in it")
    p.add_argument("--export", metavar="ID", help="save a chat as Markdown (JSON with --json), to --output or ~/.dgc/exports")
    p.add_argument("-o", "--output", metavar="FILE", help="where --export saves the chat")
    p.add_argument("--model", help="the model for this chat's messages (your default otherwise)")
    p.add_argument("--think", choices=THINKING, help="how much the model thinks first")
    p.add_argument("--search", choices=SEARCH,
                   help="auto (default): it searches when an answer depends on facts; on: search first; off: never")
    p.add_argument("--temporary", action="store_true", help="a chat that's never saved or listed")
    p.add_argument("--file", action="append", default=[], metavar="PATH", help="attach a file (up to 10)")
    p.add_argument("--json", action="store_true", help="print the reply, list or export as JSON")
    return p


class ChatClient:
    """The ChatDGC service in this process, spoken to as the editor speaks to it."""

    def __init__(self, config, service=None):
        self.events: queue.Queue = queue.Queue()
        if service is None:
            from .chatdgc.service import ChatService
            service = ChatService(self._emit, config)
        self.service = service
        self._n = 0
        self.titles: dict[str, str] = {}

    def _emit(self, event_type: str, /, **fields: Any) -> None:
        # Positional-only: ChatDGC's events carry fields of every name (an activity has a `kind`).
        self.events.put({"type": event_type, **fields})

    def _rid(self) -> str:
        self._n += 1
        return f"cli-{self._n}"

    def _next(self, deadline: float) -> dict:
        left = deadline - time.monotonic()
        if left <= 0:
            raise ChatCliError("ChatDGC didn't answer in time")
        event = self.events.get(timeout=min(left, 0.5))
        if event.get("type") == "chatdgc_changed" and isinstance(event.get("summary"), dict):
            title = event["summary"].get("title")
            if title and isinstance(event.get("conversation_id"), str):
                self.titles[event["conversation_id"]] = str(title)
        return event

    def request(self, command: dict, answer: str, timeout: float = 60.0) -> dict:
        rid = self._rid()
        self.service.dispatch({**command, "request_id": rid})
        deadline = time.monotonic() + timeout
        while True:
            try:
                event = self._next(deadline)
            except queue.Empty:
                continue
            if event.get("request_id") != rid:
                continue
            if event["type"] == answer:
                return event
            if event["type"] in ("chatdgc_error", "command_rejected", "error"):
                raise ChatCliError(str(event.get("message") or "ChatDGC refused that"))

    def turn(self, conversation_id: str, command: dict, on_event: Callable[[dict], None],
             timeout: float = REPLY_TIMEOUT_S) -> dict:
        """One reply: send `command`, hand each of its events to `on_event`, return the finished message.
        Ctrl-C stops the reply (what it wrote is kept); a second Ctrl-C leaves."""
        rid = self._rid()
        self.service.dispatch({**command, "conversation_id": conversation_id, "request_id": rid})
        deadline = time.monotonic() + timeout
        started, final, stopping = False, None, False
        while True:
            try:
                event = self._next(deadline)
            except queue.Empty:
                continue
            except KeyboardInterrupt:
                if stopping:
                    raise
                stopping = True
                self.service.dispatch({"type": "chatdgc_cancel", "conversation_id": conversation_id})
                continue
            if event.get("conversation_id") != conversation_id:
                continue
            kind = event["type"]
            if kind == "chatdgc_error":
                if event.get("request_id") == rid or started:
                    raise ChatCliError(str(event.get("message") or "ChatDGC couldn't answer"))
                continue
            if kind == "chatdgc_turn":
                if event.get("state") == "started":
                    started = True
                elif event.get("state") == "ended" and started:
                    if final is None:
                        raise ChatCliError("ChatDGC ended the reply without one")
                    return final
                continue
            if kind == "chatdgc_message" and isinstance(event.get("message"), dict):
                message = event["message"]
                if message.get("role") == "assistant" and started:
                    final = message
                continue
            if started or kind == "chatdgc_research":
                on_event(event)

    def close(self) -> None:
        self.service.close()


def _send_command(text: str, args) -> dict:
    command: dict[str, Any] = {"type": "chatdgc_send", "text": text}
    if args.model:
        command["model"] = args.model
    if args.think:
        command["thinking"] = args.think
    if args.search:
        command["search"] = args.search
    if args.file:
        command["attachments"] = [{"kind": "file", "path": str(Path(f).expanduser().resolve())} for f in args.file]
    return command


class Printer:
    """A reply as it's written: its words as they come, a quiet line for each search, then its sources."""

    def __init__(self, out: TextIO, styled: bool):
        self.out = out
        self.styled = styled
        self._thinking = False
        self._wrote = False

    def _dim(self, text: str) -> str:
        return f"\x1b[2m{text}\x1b[0m" if self.styled else text

    def event(self, event: dict) -> None:
        kind = event["type"]
        if kind == "chatdgc_delta":
            if event.get("thinking") and not self._thinking and not self._wrote:
                self._thinking = True
                self.out.write(self._dim("· thinking") + "\n")
            if event.get("text"):
                self._wrote = True
                self.out.write(str(event["text"]))
            self.out.flush()
        elif kind == "chatdgc_activity" and event.get("text") and not self._wrote:
            self.out.write(self._dim(f"· {event['text']}") + "\n")
            self.out.flush()
        elif kind == "chatdgc_question" and isinstance(event.get("question"), dict):
            question = event["question"]
            self.out.write("\n" + str(question.get("question") or question.get("text") or "") + "\n")

    def finish(self, message: dict) -> None:
        if not self._wrote and message.get("text"):
            self.out.write(str(message["text"]))
        self.out.write("\n")
        sources = [s for s in message.get("sources") or [] if isinstance(s, dict)]
        if sources:
            self.out.write("\n" + self._dim("Sources") + "\n")
            for s in sources:
                self.out.write(f"  [{s.get('n')}] {s.get('title') or s.get('url')}  {self._dim(str(s.get('url') or ''))}\n")
        if message.get("finish") == "cancelled":
            self.out.write(self._dim("Stopped.") + "\n")
        elif message.get("finish") == "length":
            self.out.write(self._dim("The model reached its length limit here.") + "\n")
        self.out.flush()


def _reply_json(chat_id: str, message: dict) -> str:
    return json.dumps({"chat_id": chat_id, "message_id": message.get("id"), "text": message.get("text", ""),
                       "sources": message.get("sources") or [], "searches": message.get("searches") or [],
                       "model": message.get("model"), "finish": message.get("finish"),
                       "usage": message.get("usage") or {}}, ensure_ascii=False)


def _list(client: ChatClient, query: str, out: TextIO, as_json: bool) -> int:
    answer = client.request({"type": "chatdgc_list", "limit": 50, **({"query": query} if query else {})}, "chatdgc_chats")
    chats = [c for c in answer.get("chats") or [] if isinstance(c, dict)]
    if as_json:
        out.write(json.dumps(chats, ensure_ascii=False) + "\n")
        return 0
    if not chats:
        out.write(f"No chat mentions “{query}”.\n" if query else "No chats yet. Start one: dgc chat\n")
        return 0
    for chat in chats:
        when = str(chat.get("updated_at") or "")[:16].replace("T", " ")
        pin = " · pinned" if chat.get("pinned") else ""
        out.write(f"{chat.get('id')}  {when}  {chat.get('title') or 'New chat'}{pin}\n")
    return 0


def _slug(title: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", title).strip("-").lower()[:60] or "chat"


def _export(client: ChatClient, chat_id: str, file: str | None, as_json: bool, out: TextIO) -> int:
    opened = client.request({"type": "chatdgc_open", "conversation_id": chat_id}, "chatdgc_opened")
    title = str((opened.get("conversation") or {}).get("title") or "chat")
    suffix = ".json" if as_json else ".md"
    target = Path(file).expanduser() if file else Path.home() / ".dgc" / "exports" / f"{_slug(title)}{suffix}"
    target = target.resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    answer = client.request({"type": "chatdgc_export", "conversation_id": chat_id, "path": str(target),
                             "format": "json" if as_json else "markdown"}, "chatdgc_exported", timeout=120.0)
    out.write(f"{answer.get('path') or target}\n")
    return 0


def _open(client: ChatClient, chat_id: str | None, temporary: bool = False) -> dict:
    if chat_id:
        return client.request({"type": "chatdgc_open", "conversation_id": chat_id}, "chatdgc_opened")
    return client.request({"type": "chatdgc_open", **({"temporary": True} if temporary else {})}, "chatdgc_opened")


def _ask(client: ChatClient, chat_id: str, text: str, args, out: TextIO, styled: bool) -> int:
    printer = Printer(out, styled)
    message = client.turn(chat_id, _send_command(text, args), (lambda e: None) if args.json else printer.event)
    if args.json:
        out.write(_reply_json(chat_id, message) + "\n")
    else:
        printer.finish(message)
    return 1 if message.get("finish") == "error" else 0


def _repl(client: ChatClient, opened: dict, args, out: TextIO, styled: bool,
          read: Callable[[str], str] = input) -> int:
    chat_id = str(opened["conversation"]["id"])
    model = args.model or ""
    out.write(f"ChatDGC{(' · ' + model) if model else ''}. Ask anything; /help for commands, Ctrl-D to leave.\n")
    title = (opened.get("conversation") or {}).get("title")
    if args.resume and title:
        out.write(f"Continuing “{title}”.\n")
    while True:
        try:
            line = read("\n› ").strip()
        except EOFError:
            out.write("\n")
            return 0
        except KeyboardInterrupt:
            out.write("\n")
            continue
        if not line:
            continue
        if line.startswith("/"):
            word, _, rest = line.partition(" ")
            rest = rest.strip()
            try:
                if word in ("/quit", "/exit"):
                    return 0
                if word == "/help":
                    out.write(HELP + "\n")
                elif word == "/new":
                    chat_id = str(_open(client, None, args.temporary)["conversation"]["id"])
                    out.write("A new chat.\n")
                elif word == "/list":
                    _list(client, rest, out, False)
                elif word == "/open" and rest:
                    opened = _open(client, rest)
                    chat_id = str(opened["conversation"]["id"])
                    out.write(f"Continuing “{opened['conversation'].get('title') or 'New chat'}”.\n")
                elif word == "/title" and rest:
                    client.request({"type": "chatdgc_update", "conversation_id": chat_id, "title": rest[:200]}, "chatdgc_changed")
                    out.write("Renamed.\n")
                elif word == "/export":
                    _export(client, chat_id, rest or None, False, out)
                else:
                    out.write("Unknown command; /help lists them.\n")
            except ChatCliError as exc:
                out.write(f"{exc}\n")
            continue
        try:
            _ask(client, chat_id, line, args, out, styled)
        except ChatCliError as exc:
            out.write(f"\n{exc}\n")
        except KeyboardInterrupt:
            out.write("\n")
            return 130


def main(config, argv: list[str], *, stdin: TextIO | None = None, out: TextIO | None = None, client: ChatClient | None = None) -> int:
    stdin = stdin or sys.stdin
    out = out or sys.stdout
    try:
        args = parser().parse_args(argv)
    except SystemExit as exc:
        return int(exc.code or 0)
    if len(args.file) > MAX_FILES:
        print(f"dgc chat: at most {MAX_FILES} files", file=sys.stderr)
        return 2
    for f in args.file:
        if not Path(f).expanduser().is_file():
            print(f"dgc chat: not a file: {f}", file=sys.stderr)
            return 2
    question = " ".join(args.question).strip()
    if not question and args.list is None and not args.export and not stdin.isatty():
        question = stdin.read().strip()               # piped text is the question
    styled = out.isatty() and not args.json
    client = client or ChatClient(config)
    try:
        if args.list is not None:
            return _list(client, args.list, out, args.json)
        if args.export:
            return _export(client, args.export, args.output, args.json, out)
        opened = _open(client, args.resume, args.temporary)
        chat_id = str(opened["conversation"]["id"])
        if question:
            return _ask(client, chat_id, question, args, out, styled)
        if not stdin.isatty():
            print("dgc chat: nothing to ask (give a question, or pipe one in)", file=sys.stderr)
            return 2
        return _repl(client, opened, args, out, styled)
    except ChatCliError as exc:
        print(f"dgc chat: {exc}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130
    finally:
        client.close()
