"""What a Pip sends in its chat: a picture, a video or any file from its computer (Pips API 101; his ask, 15 Nov: "Pip
should have capability to show images, or videos or such files in the chat itself, like it happens in regular chat
between 2 people").

The Pip names a file in its computer's Files (its computer's `send_to_chat`). The HOST, in the controller, reads it
there (pip_computer_files: inside Files, no links), keeps it once by its digest in the chat's own stores (the ones a
user's photos and files use: pip_chat.image_directory and file_directory) and records it in the run's folder. When the
reply is written, its record becomes the reply's pictures (pip_chat_images) and files (pip_chat_files), so the chat
shows them as a person's message would. The worker's word is never taken for any of it: it names a path, nothing more.

A picture is a picture by its bytes, never its name (PNG, JPEG, GIF, WebP or BMP up to pip_chat.MAX_CHAT_IMAGE_BYTES);
anything else, a video too, is a file the user opens or saves, up to MAX_FILE_BYTES.
"""
from __future__ import annotations

import hashlib
import json
import mimetypes
import os
from pathlib import Path

from .workspace_registry import RegistryError

RECORD = "sent-to-chat.json"
MAX_PER_REPLY = 16
MAX_FILE_BYTES = 100 * 1024 * 1024          # = pip_chat.MAX_CHAT_DOCUMENT_BYTES, the bound pip_chat_files keeps
_PICTURES = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp")
_KINDS = ("image", "file")


def picture_type(raw: bytes) -> str:
    """The picture type its bytes say, or "" for anything that isn't one."""
    from .attachments import _image_matches
    return next((mime for mime in _PICTURES if _image_matches(raw, mime)), "")


def _write_once(folder: Path, name: str, raw: bytes) -> None:
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = folder / name
    if path.exists():
        return
    staging = folder / f".{name}.{os.getpid()}.{os.urandom(4).hex()}"
    fd = os.open(staging, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "wb") as handle:
        handle.write(raw)
    os.replace(staging, path)


def keep(directory, pip_id: str, name: str, raw: bytes, mime: str | None = None) -> dict:
    """Keep one file in the chat's own store, once, by its digest; return what the reply records for it."""
    from . import pip_chat
    name = pip_chat.file_name(name)
    if not raw:
        raise RegistryError("invalid_files", f"{name} is empty.")
    if len(raw) > MAX_FILE_BYTES:
        raise RegistryError("invalid_files", f"{name} is over {MAX_FILE_BYTES // 1048576} MB. Tell the user where it is "
                                             "in your Files instead; they can open it there.")
    digest = hashlib.sha256(raw).hexdigest()
    picture = picture_type(raw)
    if picture and len(raw) <= pip_chat.MAX_CHAT_IMAGE_BYTES:
        _write_once(pip_chat.image_directory(directory, pip_id), f"{digest}.{pip_chat._IMAGE_EXT[picture]}", raw)
        return {"kind": "image", "name": name, "mime": picture, "sha256": digest, "bytes": len(raw)}
    _write_once(pip_chat.file_directory(directory, pip_id), digest, raw)
    return {"kind": "file", "name": name, "mime": file_type(name), "sha256": digest, "bytes": len(raw)}


def file_type(name: str) -> str:
    return mimetypes.guess_type(name)[0] or "application/octet-stream"


def recorded(run_dir) -> list:
    """What this run sent, checked: a record that doesn't read as one is none."""
    try:
        items = json.loads((Path(run_dir) / RECORD).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    if not isinstance(items, list) or len(items) > MAX_PER_REPLY:
        return []
    out = []
    for item in items:
        if (isinstance(item, dict) and set(item) == {"kind", "name", "mime", "sha256", "bytes"} and item["kind"] in _KINDS
                and isinstance(item["name"], str) and isinstance(item["mime"], str) and len(item["mime"]) <= 128
                and isinstance(item["sha256"], str) and len(item["sha256"]) == 64 and type(item["bytes"]) is int
                and 0 < item["bytes"] <= MAX_FILE_BYTES and (item["kind"] == "file" or item["mime"] in _PICTURES)):
            out.append(item)
    return out


def record(run_dir, item: dict) -> int:
    """Add one sent file to this run's record; how many it has now. More than MAX_PER_REPLY is refused."""
    items = recorded(run_dir)
    if len(items) >= MAX_PER_REPLY:
        raise RegistryError("too_many", f"A reply can carry {MAX_PER_REPLY} files at most. Send the rest in your next "
                                        "reply, or tell the user where they are in your Files.")
    items.append(item)
    path = Path(run_dir) / RECORD
    staging = path.with_name(f".{RECORD}.{os.getpid()}.{os.urandom(4).hex()}")
    staging.write_text(json.dumps(items), encoding="utf-8")
    os.replace(staging, path)
    return len(items)


def send(directory, pip_id: str, run_dir, name: str, raw: bytes) -> str:
    """The host's side of send_to_chat: keep it, record it for this reply, and say so to the Pip."""
    item = keep(directory, pip_id, name, raw)
    count = record(run_dir, item)
    what = "picture" if item["kind"] == "image" else "video" if item["mime"].startswith("video/") else "file"
    return (f"Sent {item['name']} ({what}, {item['bytes']:,} bytes) to the chat: it shows with your reply"
            f"{f' ({count} so far)' if count > 1 else ''}. Say in a line what it is; don't paste its contents.")


def attach(store, run, reply_id: str) -> int:
    """The files this run sent, on its reply (pip_chat.insert_reply), after any pictures it generated. How many."""
    run_dir = Path(store.registry.directory) / "runs" / run["id"]
    items = recorded(run_dir)
    if not items:
        return 0
    from . import pip_chat
    pip_chat.widen_tables(store.db)
    pictures = store.db.execute("SELECT COUNT(*) FROM pip_chat_images WHERE message_id=?", (reply_id,)).fetchone()[0]
    files = store.db.execute("SELECT COUNT(*) FROM pip_chat_files WHERE message_id=?", (reply_id,)).fetchone()[0]
    added = 0
    for item in items:
        try:
            if item["kind"] == "image":
                if pictures >= pip_chat.MAX_CHAT_IMAGES:
                    continue
                pip_chat.image_paths(store.registry.directory, run["pip_id"],
                                     [{k: item[k] for k in ("sha256", "mime", "bytes")}])
                store.db.execute("INSERT INTO pip_chat_images VALUES(?,?,?,?,?)",
                                 (reply_id, pictures, item["sha256"], item["mime"], item["bytes"]))
                pictures += 1
            else:
                if files >= pip_chat.MAX_CHAT_FILES:
                    continue
                kept = pip_chat.file_directory(store.registry.directory, run["pip_id"]) / item["sha256"]
                if kept.stat().st_size != item["bytes"]:
                    continue
                store.db.execute("INSERT INTO pip_chat_files VALUES(?,?,?,?,?)",
                                 (reply_id, files, pip_chat.file_name(item["name"]), item["sha256"], item["bytes"]))
                files += 1
            added += 1
        except (RegistryError, OSError):
            continue                                    # a file gone from the store is left off, never the reply
    return added


def get_file(store, pip_id: str, message_id, index, actor: str) -> dict:
    """One file of a message in a Pip's chat, for the editor on this computer: where it is kept, checked against its
    digest (a kept file that changed is never handed out). A Pip's reply's files and the user's own alike."""
    from .pip_chat import file_directory, file_name
    if actor not in ("editor-user", "local-console"):
        raise RegistryError("local_only", "A message's file opens only on the computer DGC runs on.")
    if not isinstance(message_id, str) or type(index) is not int:
        raise RegistryError("invalid_request", "Choose one file of the message.")
    row = store.db.execute("SELECT f.name,f.sha256,f.bytes FROM pip_chat_files f JOIN pip_chat_messages m ON "
                           "m.id=f.message_id WHERE m.pip_id=? AND m.id=? AND f.idx=?",
                           (pip_id, message_id, index)).fetchone()
    if row is None:
        raise RegistryError("not_found", "That file is not in this Pip's chat.")
    path = file_directory(store.registry.directory, pip_id) / row[1]
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
    except OSError as exc:
        raise RegistryError("not_found", "That file is no longer kept.") from exc
    if digest.hexdigest() != row[1]:
        raise RegistryError("invalid_files", "That kept file changed on disk, so it isn't opened.")
    return {"pip_id": pip_id, "message_id": message_id, "index": index, "name": file_name(row[0]),
            "mime": file_type(row[0]), "bytes": row[2], "path": str(path)}
