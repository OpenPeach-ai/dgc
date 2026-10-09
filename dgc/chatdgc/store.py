"""ChatDGC's chats: a store of their own under ``~/.dgc/chat/``, never mixed with Work sessions.

Each chat is one JSON file (``chats/<id>.json``): its title, times, model and thinking level, whether it is
pinned or archived, and its messages. A small SQLite index (``index.sqlite3``) keeps the list and search fast
without opening every file. A chat is the same whatever folder DGC runs in: nothing here knows a project.

Writes are atomic (a temporary file, then a rename) and owner-only; a lock file serialises writers across
processes (two editor tabs, the CLI). A temporary chat is never written: it lives in the engine's memory only.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import re
import shutil
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

CHAT_ID = re.compile(r"chat_[a-f0-9]{32}\Z")
MESSAGE_ID = re.compile(r"msg_[a-f0-9]{32}\Z")
MAX_TITLE = 120
MAX_TEXT = 1_000_000                 # one message, in characters: a reply can be very long
MAX_CHAT_BYTES = 32 * 1024 * 1024    # one chat file
MAX_LIST = 200
ROLES = ("user", "assistant")
FINISHES = ("stop", "length", "cancelled", "error")

_LOCK = threading.Lock()


class ChatStoreError(Exception):
    """Something about a chat or a message is wrong; the text says what, for the user."""


def default_root() -> Path:
    from ..config import USER_HOME
    return USER_HOME / "chat"


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_chat_id() -> str:
    return "chat_" + uuid.uuid4().hex


def new_message_id() -> str:
    return "msg_" + uuid.uuid4().hex


def title_from(text: str) -> str:
    """A first title, from the first line of the first message (a model can rename it later)."""
    line = next((part.strip() for part in str(text or "").splitlines() if part.strip()), "")
    line = re.sub(r"\s+", " ", line)
    if not line:
        return "New chat"
    return line if len(line) <= 60 else line[:59].rstrip() + "…"


class ChatStore:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root is not None else default_root()

    # -- files and the lock

    @property
    def chats_dir(self) -> Path:
        return self.root / "chats"

    def files_dir(self, chat_id: str) -> Path:
        """A chat's attachments: ``files/<chat>/<attachment>`` (its bytes) and ``<attachment>.txt`` (what the
        model reads of a document or pasted text)."""
        self._path(chat_id)
        return self.root / "files" / chat_id

    def _ensure(self) -> None:
        self.chats_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path in (self.root, self.chats_dir):
            try:
                os.chmod(path, 0o700)
            except OSError:
                pass

    @contextlib.contextmanager
    def _locked(self):
        self._ensure()
        with _LOCK:
            fd = os.open(self.root / ".lock", os.O_RDWR | os.O_CREAT, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX)
                yield
            finally:
                fcntl.flock(fd, fcntl.LOCK_UN)
                os.close(fd)

    def _path(self, chat_id: str) -> Path:
        if not isinstance(chat_id, str) or not CHAT_ID.fullmatch(chat_id):
            raise ChatStoreError("That chat doesn't exist.")
        return self.chats_dir / f"{chat_id}.json"

    def _index(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.root / "index.sqlite3", timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("""CREATE TABLE IF NOT EXISTS chats (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
            preview TEXT NOT NULL DEFAULT '', messages INTEGER NOT NULL DEFAULT 0)""")
        db.execute("CREATE INDEX IF NOT EXISTS chats_order ON chats(archived, pinned, updated_at)")
        try:
            os.chmod(self.root / "index.sqlite3", 0o600)
        except OSError:
            pass
        return db

    # -- reading

    def get(self, chat_id: str) -> dict:
        path = self._path(chat_id)
        try:
            if path.stat().st_size > MAX_CHAT_BYTES:
                raise ChatStoreError("This chat is too large to open.")
            chat = json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            raise ChatStoreError("That chat doesn't exist.") from None
        except (OSError, ValueError) as exc:
            raise ChatStoreError("This chat couldn't be read.") from exc
        if not isinstance(chat, dict) or chat.get("id") != chat_id or not isinstance(chat.get("messages"), list):
            raise ChatStoreError("This chat couldn't be read.")
        return chat

    def listing(self, *, query: str = "", archived: bool = False, limit: int = 50, offset: int = 0) -> dict:
        """The Chat list: pinned first, then the newest; ``query`` matches titles and the latest message."""
        if type(limit) is not int or not 1 <= limit <= MAX_LIST or type(offset) is not int or offset < 0:
            raise ChatStoreError(f"Ask for 1–{MAX_LIST} chats at a time.")
        self._ensure()
        where, args = ["archived=?"], [1 if archived else 0]
        text = " ".join(str(query or "").split())[:200]
        if text:
            where.append("(title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\')")
            like = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
            args += [like, like]
        with self._index() as db:
            total = db.execute("SELECT count(*) FROM chats WHERE " + " AND ".join(where), args).fetchone()[0]
            rows = db.execute("SELECT * FROM chats WHERE " + " AND ".join(where)
                              + " ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?",
                              (*args, limit, offset)).fetchall()
        return {"chats": [self._row(r) for r in rows], "total": total,
                "next_offset": offset + len(rows) if offset + len(rows) < total else None}

    @staticmethod
    def _row(row) -> dict:
        return {"id": row["id"], "title": row["title"], "created_at": row["created_at"], "updated_at": row["updated_at"],
                "pinned": bool(row["pinned"]), "archived": bool(row["archived"]), "preview": row["preview"],
                "messages": row["messages"]}

    # -- writing

    def _write(self, chat: dict) -> None:
        data = json.dumps(chat, ensure_ascii=False, separators=(",", ":"))
        if len(data.encode("utf-8")) > MAX_CHAT_BYTES:
            raise ChatStoreError("This chat is full. Start a new chat to carry on.")
        path = self._path(chat["id"])
        temp = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(data)
        os.replace(temp, path)
        last = next((m for m in reversed(chat["messages"]) if m.get("text")), None)
        preview = re.sub(r"\s+", " ", str(last.get("text", "")) if last else "")[:200]
        with self._index() as db:
            db.execute("INSERT OR REPLACE INTO chats(id,title,created_at,updated_at,pinned,archived,preview,messages) "
                       "VALUES(?,?,?,?,?,?,?,?)",
                       (chat["id"], chat["title"], chat["created_at"], chat["updated_at"], int(chat.get("pinned", False)),
                        int(chat.get("archived", False)), preview, len(chat["messages"])))

    def create(self, *, model: str | None = None, thinking: str | None = None, title: str = "New chat",
               chat_id: str | None = None) -> dict:
        stamp = now()
        chat_id = chat_id or new_chat_id()
        self._path(chat_id)
        chat = {"id": chat_id, "title": _title(title), "created_at": stamp, "updated_at": stamp,
                "model": model, "thinking": thinking, "pinned": False, "archived": False, "messages": []}
        with self._locked():
            self._write(chat)
        return chat

    def save(self, chat: dict) -> dict:
        """Write a chat the engine changed (its messages, model, thinking), stamping it now.

        A reply can take minutes, and the list's own changes land meanwhile: what the file says now
        about its name, pin and archive wins over the copy the turn started with (the engine names a
        chat only while it is still "New chat"). A chat deleted mid-reply stays deleted."""
        _check_chat(chat)
        with self._locked():
            if not self._path(chat["id"]).exists():
                raise ChatStoreError("This chat was deleted.")
            current = self.get(chat["id"])
            chat = {**chat, "updated_at": now(), "pinned": current.get("pinned", False),
                    "archived": current.get("archived", False),
                    "title": chat["title"] if current.get("title") == "New chat" else current["title"]}
            self._write(chat)
        return chat

    def update(self, chat_id: str, *, title=None, pinned=None, archived=None, expect_title=None) -> dict | None:
        """Rename, pin or archive a chat: the list's own changes, never its messages. With ``expect_title``,
        only if the chat still has that title (None if it doesn't)."""
        with self._locked():
            chat = self.get(chat_id)
            if expect_title is not None and chat.get("title") != expect_title:
                return None
            if title is not None:
                chat["title"] = _title(title)
            if pinned is not None:
                if type(pinned) is not bool:
                    raise ChatStoreError("Pinned is true or false.")
                chat["pinned"] = pinned
            if archived is not None:
                if type(archived) is not bool:
                    raise ChatStoreError("Archived is true or false.")
                chat["archived"] = archived
            chat["updated_at"] = now() if title is not None else chat["updated_at"]
            self._write(chat)
        return chat

    # -- attachments

    def put_file(self, chat_id: str, attachment_id: str, raw: bytes, text: str | None = None) -> None:
        from .attachments import ATTACHMENT_ID
        if not isinstance(attachment_id, str) or not ATTACHMENT_ID.fullmatch(attachment_id):
            raise ChatStoreError("That attachment doesn't exist.")
        folder = self.files_dir(chat_id)
        self._ensure()
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        for path in (folder.parent, folder):
            try:
                os.chmod(path, 0o700)
            except OSError:
                pass
        for target, data in ((folder / attachment_id, raw),
                             *(((folder / f"{attachment_id}.txt", text.encode("utf-8")),) if text is not None else ())):
            temp = target.with_name(f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
            os.replace(temp, target)

    def get_file(self, chat_id: str, attachment_id: str) -> tuple[bytes, str | None]:
        """An attachment's bytes and, for a document or pasted text, what the model reads of it."""
        from .attachments import ATTACHMENT_ID
        if not isinstance(attachment_id, str) or not ATTACHMENT_ID.fullmatch(attachment_id):
            raise ChatStoreError("That attachment doesn't exist.")
        folder = self.files_dir(chat_id)
        try:
            raw = (folder / attachment_id).read_bytes()
        except OSError:
            raise ChatStoreError("That attachment is no longer there.") from None
        try:
            text = (folder / f"{attachment_id}.txt").read_text(encoding="utf-8")
        except OSError:
            text = None
        return raw, text

    def delete(self, chat_id: str) -> None:
        path = self._path(chat_id)
        with self._locked():
            shutil.rmtree(self.files_dir(chat_id), ignore_errors=True)
            try:
                path.unlink()
            except FileNotFoundError:
                pass
            with self._index() as db:
                db.execute("DELETE FROM chats WHERE id=?", (chat_id,))


def _title(value) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        raise ChatStoreError("Give the chat a name.")
    return text[:MAX_TITLE]


def _check_chat(chat) -> None:
    if not isinstance(chat, dict) or not CHAT_ID.fullmatch(str(chat.get("id", ""))):
        raise ChatStoreError("That chat doesn't exist.")
    if not isinstance(chat.get("messages"), list):
        raise ChatStoreError("This chat couldn't be saved.")
    for message in chat["messages"]:
        if not isinstance(message, dict) or not isinstance(message.get("attachments", []), list):
            raise ChatStoreError("This chat couldn't be saved.")
        if (not isinstance(message, dict) or message.get("role") not in ROLES
                or not MESSAGE_ID.fullmatch(str(message.get("id", ""))) or not isinstance(message.get("text"), str)
                or len(message["text"]) > MAX_TEXT):
            raise ChatStoreError("This chat couldn't be saved.")
