"""ChatDGC's chats: a store of their own under ``~/.dgc/chat/``, never mixed with Work sessions.

Each chat is one JSON file (``chats/<id>.json``): its title, times, model and thinking level, whether it is
pinned or archived, the ChatDGC project it's in (if any), and its messages. A small SQLite index
(``index.sqlite3``) keeps the list, search and the Library fast without opening every file. A chat is the same
whatever folder DGC runs in: nothing here knows a Work folder.

Projects, as ChatGPT has them (chats, files and instructions together), are ``projects.json``; a project's own
files are under ``project-files/<project>/``.

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
MAX_BODY = 1_000_000                 # characters of a chat kept for search
INDEX_VERSION = 4                    # 2: what was said is searched too (body, body_fts); 3: the Library (files);
                                     # 4: files ChatDGC made (files.made)
PROJECT_ID = re.compile(r"proj_[a-f0-9]{32}\Z")
MAX_PROJECTS = 200
MAX_PROJECT_NAME = 80
MAX_INSTRUCTIONS = 8_000             # characters of a project's instructions
MAX_PROJECT_FILES = 40               # ChatGPT's own most, per project
PROJECT_COLORS = ("purple", "blue", "teal", "green", "yellow", "orange", "red", "pink", "gray")
PROJECT_MEMORY = ("shared", "project")     # the memory you share with every chat, or this project's alone
# The Library's kinds, as ChatGPT filters it: what an attachment is, by its kind and its name.
LIBRARY_TYPES = ("image", "pdf", "document", "spreadsheet", "presentation", "code", "text")
_SHEETS = {"xlsx", "xls", "xlsm", "csv", "tsv", "ods", "numbers"}
_SLIDES = {"pptx", "ppt", "odp", "key"}
_CODE = {"py", "js", "ts", "tsx", "jsx", "mjs", "cjs", "json", "html", "htm", "css", "scss", "java", "c", "h", "cpp", "hpp",
         "cc", "cs", "go", "rs", "rb", "php", "sh", "bash", "zsh", "ps1", "sql", "yaml", "yml", "toml", "ini", "xml", "swift",
         "kt", "kts", "scala", "r", "lua", "pl", "dart", "vue", "svelte", "ipynb", "m", "mm", "gradle"}


def library_type(kind: str, name: str) -> str:
    if kind == "image":
        return "image"
    if kind == "text":
        return "text"
    ext = name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return ("pdf" if ext == "pdf" else "spreadsheet" if ext in _SHEETS else "presentation" if ext in _SLIDES
            else "code" if ext in _CODE else "document")
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


def new_project_id() -> str:
    return "proj_" + uuid.uuid4().hex


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
        if "project" not in {row[1] for row in db.execute("PRAGMA table_info(chats)")}:
            try:
                db.execute("ALTER TABLE chats ADD COLUMN project TEXT NOT NULL DEFAULT ''")
            except sqlite3.OperationalError as exc:      # another process added it between the look and the add
                if "duplicate column" not in str(exc):
                    raise
        db.execute("CREATE INDEX IF NOT EXISTS chats_project ON chats(project, archived, pinned, updated_at)")
        db.execute("""CREATE TABLE IF NOT EXISTS files (
            chat_id TEXT NOT NULL, id TEXT NOT NULL, message_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
            mime TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, chars INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL, PRIMARY KEY(chat_id, id))""")
        db.execute("CREATE INDEX IF NOT EXISTS files_order ON files(created_at)")
        if "made" not in {row[1] for row in db.execute("PRAGMA table_info(files)")}:
            try:
                db.execute("ALTER TABLE files ADD COLUMN made INTEGER NOT NULL DEFAULT 0")
            except sqlite3.OperationalError as exc:      # another process added it between the look and the add
                if "duplicate column" not in str(exc):
                    raise
        db.execute("CREATE TABLE IF NOT EXISTS body (id TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '')")
        try:
            db.execute("CREATE VIRTUAL TABLE IF NOT EXISTS body_fts USING fts5(id UNINDEXED, text, "
                       "tokenize='unicode61 remove_diacritics 2')")
            self._fts = True
        except sqlite3.Error:
            self._fts = False                  # a SQLite without FTS5: search matches with LIKE
        try:
            os.chmod(self.root / "index.sqlite3", 0o600)
        except OSError:
            pass
        return db

    @staticmethod
    def _body(chat: dict) -> str:
        """What a chat is searched by: its name and everything said in the conversation you see, questions asked
        in a reply included."""
        parts = [chat.get("title", "")]
        for m in chat.get("messages", []):
            parts.append(m.get("text", ""))
            parts += [" ".join([q.get("question", ""), *q.get("options", [])]) for q in m.get("questions") or []
                      if isinstance(q, dict)]
        return "\n".join(p for p in parts if p)[:MAX_BODY]

    def _put_body(self, db, chat: dict) -> None:
        body = self._body(chat)
        db.execute("INSERT OR REPLACE INTO body(id, text) VALUES(?,?)", (chat["id"], body))
        if self._fts:
            db.execute("DELETE FROM body_fts WHERE id=?", (chat["id"],))
            db.execute("INSERT INTO body_fts(id, text) VALUES(?,?)", (chat["id"], body))

    @staticmethod
    def _files_of(chat: dict) -> list[tuple]:
        """The files a chat keeps that you attached or it made (in every version of it), for the Library: rows of the
        files table. Pictures from the web aren't yours, so they aren't here."""
        tails = [t for fork in (chat.get("forks") or {}).values() for t in fork.get("tails") or [] if t]
        rows, seen = [], set()
        for m in [*chat.get("messages", []), *(m for tail in tails for m in tail)]:
            for meta in [*(m.get("attachments") or []), *(m.get("files") or [])] if isinstance(m, dict) else []:
                ident = str(meta.get("id") or "")
                if not ident or ident in seen or meta.get("removed"):
                    continue
                seen.add(ident)
                rows.append((chat["id"], ident, str(m.get("id") or ""), str(meta.get("name") or "attachment")[:255],
                             str(meta.get("kind") or "file")[:32], str(meta.get("mime") or "")[:100],
                             int(meta.get("size") or 0), int(meta.get("chars") or 0),
                             str(m.get("created_at") or chat.get("created_at") or ""), 1 if meta.get("made") else 0))
        return rows

    def _put_files(self, db, chat: dict) -> None:
        db.execute("DELETE FROM files WHERE chat_id=?", (chat["id"],))
        db.executemany("INSERT OR REPLACE INTO files(chat_id,id,message_id,name,kind,mime,size,chars,created_at,made) "
                       "VALUES(?,?,?,?,?,?,?,?,?,?)", self._files_of(chat))

    def _catch_up(self, db) -> None:
        """An index from before what was said was searched (2), or before the Library (3): read each chat once and
        fill it in."""
        if db.execute("PRAGMA user_version").fetchone()[0] >= INDEX_VERSION:
            return
        for path in self.chats_dir.glob("chat_*.json"):
            try:
                chat = self.get(path.stem)
            except ChatStoreError:
                continue
            self._put_body(db, chat)
            self._put_files(db, chat)
            db.execute("UPDATE chats SET project=? WHERE id=?", (str(chat.get("project") or ""), chat["id"]))
        db.execute(f"PRAGMA user_version = {INDEX_VERSION}")

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

    def listing(self, *, query: str = "", archived: bool = False, limit: int = 50, offset: int = 0,
                project: str = "") -> dict:
        """The Chat list: pinned first, then the newest; ``query`` matches titles and what was said. ``project``:
        that project's chats; without one, the chats in no project, as ChatGPT lists them apart (a search
        looks through every chat, and each says its project)."""
        if project and not PROJECT_ID.fullmatch(str(project)):
            raise ChatStoreError("That project doesn't exist.")
        if type(limit) is not int or not 1 <= limit <= MAX_LIST or type(offset) is not int or offset < 0:
            raise ChatStoreError(f"Ask for 1–{MAX_LIST} chats at a time.")
        self._ensure()
        from ..session_index import snippet
        text = " ".join(str(query or "").split())[:200]
        with self._index() as db:
            if text:
                self._catch_up(db)
            for fts in ((True, False) if self._fts else (False,)):
                where, args = ["archived=?"], [1 if archived else 0]
                if project or not text:
                    where.append("project=?")
                    args.append(project)
                if text:
                    like = "%" + text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                    inner = ("SELECT id FROM body_fts WHERE body_fts MATCH ?" if fts
                             else "SELECT id FROM body WHERE text LIKE ? ESCAPE '\\'")
                    where.append("(title LIKE ? ESCAPE '\\' OR preview LIKE ? ESCAPE '\\' OR id IN (" + inner + "))")
                    args += [like, like, ('"' + text.replace('"', '""') + '"*') if fts else like]
                try:
                    total = db.execute("SELECT count(*) FROM chats WHERE " + " AND ".join(where), args).fetchone()[0]
                    rows = db.execute("SELECT * FROM chats WHERE " + " AND ".join(where)
                                      + " ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?",
                                      (*args, limit, offset)).fetchall()
                    break
                except sqlite3.Error:
                    if not fts:
                        raise
            chats = []
            for row in rows:
                entry = self._row(row)
                if text and text.casefold() not in (row["title"] + " " + row["preview"]).casefold():
                    said = db.execute("SELECT text FROM body WHERE id=?", (row["id"],)).fetchone()
                    if said:
                        entry["match"] = snippet(said[0], text)
                chats.append(entry)
        return {"chats": chats, "total": total,
                "next_offset": offset + len(rows) if offset + len(rows) < total else None}

    @staticmethod
    def _row(row) -> dict:
        return {"id": row["id"], "title": row["title"], "created_at": row["created_at"], "updated_at": row["updated_at"],
                "pinned": bool(row["pinned"]), "archived": bool(row["archived"]), "preview": row["preview"],
                "messages": row["messages"], **({"project": row["project"]} if row["project"] else {})}

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
            db.execute("INSERT OR REPLACE INTO chats(id,title,created_at,updated_at,pinned,archived,preview,messages,project) "
                       "VALUES(?,?,?,?,?,?,?,?,?)",
                       (chat["id"], chat["title"], chat["created_at"], chat["updated_at"], int(chat.get("pinned", False)),
                        int(chat.get("archived", False)), preview, len(chat["messages"]), str(chat.get("project") or "")))
            self._put_body(db, chat)
            self._put_files(db, chat)

    def create(self, *, model: str | None = None, thinking: str | None = None, title: str = "New chat",
               chat_id: str | None = None, project: str | None = None) -> dict:
        stamp = now()
        chat_id = chat_id or new_chat_id()
        self._path(chat_id)
        chat = {"id": chat_id, "title": _title(title), "created_at": stamp, "updated_at": stamp,
                "model": model, "thinking": thinking, "pinned": False, "archived": False, "messages": []}
        with self._locked():
            if project:
                self._project(self._read_projects(), project)
                chat["project"] = project
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
            # Which project it's in is the list's to change, as its name is (a move mid-reply stays moved).
            chat.pop("project", None)
            if current.get("project"):
                chat["project"] = current["project"]
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
                db.execute("DELETE FROM files WHERE chat_id=?", (chat_id,))
                db.execute("DELETE FROM body WHERE id=?", (chat_id,))
                if self._fts:
                    db.execute("DELETE FROM body_fts WHERE id=?", (chat_id,))


    # -- the Library (ChatGPT's): every file you attached, in one place

    def library(self, *, query: str = "", kind: str = "", origin: str = "", limit: int = 60, offset: int = 0) -> dict:
        """Every file you attached, in every chat (archived ones too) and every project, the newest first: ``kind``
        one of LIBRARY_TYPES, ``query`` part of a name, ``origin`` "made" (by ChatDGC) or "uploaded" (by you), as
        ChatGPT filters it. ``counts`` says how many of each kind the query finds, ``origins`` how many of each origin."""
        if type(limit) is not int or not 1 <= limit <= MAX_LIST or type(offset) is not int or offset < 0:
            raise ChatStoreError(f"Ask for 1–{MAX_LIST} files at a time.")
        if kind and kind not in LIBRARY_TYPES:
            raise ChatStoreError("Choose images, PDFs, documents, spreadsheets, presentations, code or text.")
        if origin not in ("", "made", "uploaded"):
            raise ChatStoreError("Choose files ChatDGC made, or files you uploaded.")
        text = " ".join(str(query or "").split())[:200].casefold()
        self._ensure()
        with self._index() as db:
            self._catch_up(db)
            rows = db.execute("SELECT f.chat_id, f.id, f.message_id, f.name, f.kind, f.mime, f.size, f.chars, f.created_at, "
                              "c.title, c.project, f.made FROM files f JOIN chats c ON c.id = f.chat_id").fetchall()
        projects = self._read_projects()
        names = {p["id"]: p.get("name", "") for p in projects}
        items = [{"source": "chat", "chat_id": r[0], "id": r[1], "message_id": r[2], "name": r[3], "kind": r[4], "mime": r[5],
                  "size": r[6], "chars": r[7], "created_at": r[8], "chat_title": r[9], "type": library_type(r[4], r[3]),
                  "made": bool(r[11]),
                  **({"project_id": r[10], "project_name": names.get(r[10], "")} if r[10] in names else {})} for r in rows]
        for project in projects:
            for f in project.get("files") or []:
                name = str(f.get("name") or "file")
                items.append({"source": "project", "project_id": project["id"], "project_name": project.get("name", ""),
                              "id": f.get("id"), "name": name, "kind": f.get("kind", "document"), "mime": f.get("mime", ""),
                              "size": int(f.get("size") or 0), "chars": int(f.get("chars") or 0),
                              "created_at": f.get("added_at") or project.get("created_at") or "",
                              "type": library_type(str(f.get("kind") or ""), name)})
        if text:
            items = [i for i in items if text in i["name"].casefold()]
        origins = {"made": sum(1 for i in items if i.get("made")), "uploaded": sum(1 for i in items if not i.get("made"))}
        if origin:
            items = [i for i in items if bool(i.get("made")) == (origin == "made")]
        counts = {t: sum(1 for i in items if i["type"] == t) for t in LIBRARY_TYPES}
        if kind:
            items = [i for i in items if i["type"] == kind]
        items.sort(key=lambda i: (i["name"].casefold(), i["id"] or ""))       # files sent together: by name
        items.sort(key=lambda i: i["created_at"] or "", reverse=True)
        page = items[offset:offset + limit]
        return {"files": page, "total": len(items), "counts": counts, "origins": origins,
                "next_offset": offset + len(page) if offset + len(page) < len(items) else None}

    def remove_file(self, chat_id: str, attachment_id: str) -> dict:
        """Delete a file you attached, from the Library: its bytes go; the chat keeps its name, marked removed,
        and says it's no longer there."""
        with self._locked():
            chat = self.get(chat_id)
            tails = [t for fork in (chat.get("forks") or {}).values() for t in fork.get("tails") or [] if t]
            found = False
            for m in [*chat["messages"], *(m for tail in tails for m in tail)]:
                for meta in [*(m.get("attachments") or []), *(m.get("files") or [])]:
                    if meta.get("id") == attachment_id:
                        meta["removed"] = True
                        found = True
            if not found:
                raise ChatStoreError("That file isn't in this chat.")
            folder = self.files_dir(chat_id)
            for name in (attachment_id, f"{attachment_id}.txt"):
                try:
                    (folder / name).unlink()
                except OSError:
                    pass
            self._write(chat)
        return chat

    # -- projects (ChatGPT's): chats, files and instructions together

    @property
    def projects_path(self) -> Path:
        return self.root / "projects.json"

    def project_files_dir(self, project_id: str) -> Path:
        if not isinstance(project_id, str) or not PROJECT_ID.fullmatch(project_id):
            raise ChatStoreError("That project doesn't exist.")
        return self.root / "project-files" / project_id

    def _read_projects(self) -> list[dict]:
        try:
            raw = json.loads(self.projects_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return []
        except (OSError, ValueError) as exc:
            raise ChatStoreError("Your projects couldn't be read.") from exc
        return [p for p in raw if isinstance(p, dict) and PROJECT_ID.fullmatch(str(p.get("id", "")))] \
            if isinstance(raw, list) else []

    def _write_projects(self, projects: list[dict]) -> None:
        self._ensure()
        temp = self.projects_path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
        fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            stream.write(json.dumps(projects, ensure_ascii=False, separators=(",", ":")))
        os.replace(temp, self.projects_path)

    @staticmethod
    def _project(projects: list[dict], project_id) -> dict:
        found = next((p for p in projects if p.get("id") == project_id), None)
        if found is None:
            raise ChatStoreError("That project doesn't exist.")
        return found

    def projects(self) -> list[dict]:
        """Every project, the most recently changed first, each with how many chats it holds (not archived)."""
        self._ensure()
        projects = self._read_projects()
        with self._index() as db:
            counts = dict(db.execute("SELECT project, count(*) FROM chats WHERE archived=0 AND project!='' "
                                     "GROUP BY project").fetchall())
        return sorted(({**p, "chats": int(counts.get(p["id"], 0))} for p in projects),
                      key=lambda p: (p.get("updated_at") or "", p["id"]), reverse=True)

    def project(self, project_id: str) -> dict:
        found = self._project(self._read_projects(), project_id)
        return {**found, "chats": next((p["chats"] for p in self.projects() if p["id"] == project_id), 0)}

    def create_project(self, name, *, color: str | None = None, memory: str = "shared", instructions: str = "") -> dict:
        stamp = now()
        project = {"id": new_project_id(), "name": _project_name(name), "color": _color(color or "purple"),
                   "instructions": _instructions(instructions), "memory": _memory(memory), "files": [],
                   "created_at": stamp, "updated_at": stamp}
        with self._locked():
            projects = self._read_projects()
            if len(projects) >= MAX_PROJECTS:
                raise ChatStoreError(f"That's the most projects ({MAX_PROJECTS}). Delete one you're done with.")
            projects.append(project)
            self._write_projects(projects)
        return {**project, "chats": 0}

    def update_project(self, project_id: str, *, name=None, color=None, instructions=None, memory=None) -> dict:
        with self._locked():
            projects = self._read_projects()
            project = self._project(projects, project_id)
            if name is not None:
                project["name"] = _project_name(name)
            if color is not None:
                project["color"] = _color(color)
            if instructions is not None:
                project["instructions"] = _instructions(instructions)
            if memory is not None:
                project["memory"] = _memory(memory)
            project["updated_at"] = now()
            self._write_projects(projects)
        return self.project(project_id)

    def delete_project(self, project_id: str, *, keep_chats: bool) -> list[str]:
        """Delete a project and its files. Its chats go too, as ChatGPT deletes them, unless ``keep_chats``: then
        they move back to your chats. Returns the chats deleted."""
        deleted = []
        with self._locked():
            projects = self._read_projects()
            self._project(projects, project_id)
            with self._index() as db:
                ids = [r[0] for r in db.execute("SELECT id FROM chats WHERE project=?", (project_id,)).fetchall()]
        for chat_id in ids:
            if keep_chats:
                try:
                    self.move(chat_id, "")
                except ChatStoreError:
                    pass
            else:
                self.delete(chat_id)
                deleted.append(chat_id)
        with self._locked():
            projects = [p for p in self._read_projects() if p.get("id") != project_id]
            self._write_projects(projects)
            shutil.rmtree(self.project_files_dir(project_id), ignore_errors=True)
        return deleted

    def move(self, chat_id: str, project_id: str) -> dict:
        """Put a chat in a project ("" takes it out). Like a rename, it doesn't change when the chat was last used."""
        with self._locked():
            chat = self.get(chat_id)
            if project_id:
                self._project(self._read_projects(), project_id)
                chat["project"] = project_id
            else:
                chat.pop("project", None)
            self._write(chat)
        return chat

    def put_project_file(self, project_id: str, meta: dict, raw: bytes, text: str | None = None) -> dict:
        """Keep a file in a project, for every chat in it: its bytes (and what the model reads of a document)."""
        from .attachments import ATTACHMENT_ID
        if not ATTACHMENT_ID.fullmatch(str(meta.get("id") or "")):
            raise ChatStoreError("That file doesn't exist.")
        with self._locked():
            projects = self._read_projects()
            project = self._project(projects, project_id)
            files = project.setdefault("files", [])
            if len(files) >= MAX_PROJECT_FILES:
                raise ChatStoreError(f"A project holds up to {MAX_PROJECT_FILES} files. Remove one first.")
            folder = self.project_files_dir(project_id)
            folder.mkdir(parents=True, exist_ok=True, mode=0o700)
            for path in (folder.parent, folder):
                try:
                    os.chmod(path, 0o700)
                except OSError:
                    pass
            for target, data in ((folder / meta["id"], raw),
                                 *(((folder / f"{meta['id']}.txt", text.encode("utf-8")),) if text is not None else ())):
                temp = target.with_name(f".{target.name}.{os.getpid()}.{threading.get_ident()}.tmp")
                fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                os.replace(temp, target)
            kept = {**meta, "added_at": now()}
            files.append(kept)
            project["updated_at"] = now()
            self._write_projects(projects)
        return kept

    def get_project_file(self, project_id: str, file_id: str) -> tuple[bytes, str | None]:
        from .attachments import ATTACHMENT_ID
        if not isinstance(file_id, str) or not ATTACHMENT_ID.fullmatch(file_id):
            raise ChatStoreError("That file doesn't exist.")
        folder = self.project_files_dir(project_id)
        try:
            raw = (folder / file_id).read_bytes()
        except OSError:
            raise ChatStoreError("That file is no longer there.") from None
        try:
            text = (folder / f"{file_id}.txt").read_text(encoding="utf-8")
        except OSError:
            text = None
        return raw, text

    def remove_project_file(self, project_id: str, file_id: str) -> dict:
        with self._locked():
            projects = self._read_projects()
            project = self._project(projects, project_id)
            before = len(project.get("files") or [])
            project["files"] = [f for f in project.get("files") or [] if f.get("id") != file_id]
            if len(project["files"]) == before:
                raise ChatStoreError("That file isn't in this project.")
            project["updated_at"] = now()
            self._write_projects(projects)
            folder = self.project_files_dir(project_id)
            for name in (file_id, f"{file_id}.txt"):
                try:
                    (folder / name).unlink()
                except OSError:
                    pass
        return self.project(project_id)


def _project_name(value) -> str:
    text = " ".join(str(value or "").split())
    if not text:
        raise ChatStoreError("Give the project a name.")
    return text[:MAX_PROJECT_NAME]


def _color(value) -> str:
    if value not in PROJECT_COLORS:
        raise ChatStoreError("Choose one of the project colours.")
    return value


def _instructions(value) -> str:
    text = str(value or "").strip()
    if len(text) > MAX_INSTRUCTIONS:
        raise ChatStoreError(f"Project instructions are up to {MAX_INSTRUCTIONS:,} characters.")
    return text


def _memory(value) -> str:
    if value not in PROJECT_MEMORY:
        raise ChatStoreError("Memory is shared or this project's only.")
    return value

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
    _check_messages(chat["messages"])
    forks = chat.get("forks", {})
    if not isinstance(forks, dict):
        raise ChatStoreError("This chat couldn't be saved.")
    for key, fork in forks.items():
        tails = fork.get("tails") if isinstance(fork, dict) else None
        if (not isinstance(key, str) or not isinstance(tails, list) or type(fork.get("active")) is not int
                or not 0 <= fork["active"] < len(tails) or tails[fork["active"]] is not None):
            raise ChatStoreError("This chat couldn't be saved.")
        for tail in tails:
            if tail is not None:
                if not isinstance(tail, list):
                    raise ChatStoreError("This chat couldn't be saved.")
                _check_messages(tail)


def _check_messages(messages: list) -> None:
    for message in messages:
        if not isinstance(message, dict) or not isinstance(message.get("attachments", []), list):
            raise ChatStoreError("This chat couldn't be saved.")
        if (not isinstance(message, dict) or message.get("role") not in ROLES
                or not MESSAGE_ID.fullmatch(str(message.get("id", ""))) or not isinstance(message.get("text"), str)
                or len(message["text"]) > MAX_TEXT):
            raise ChatStoreError("This chat couldn't be saved.")
