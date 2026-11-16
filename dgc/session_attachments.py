"""What you attached in Work sessions, for the Library (his call, 16 Nov: "Work attachments in the Library" into 0.52).

A Work session keeps a picture you attached in its transcript (the user message's image part, a data URI) and a file you
named with @ where it is, in its project (the message's `_dgc_display_mentions`, kind "file"). The Library listed
ChatDGC's files only. Here: `listing()` lists them from every project's sessions, newest first (the newest
MAX_SESSIONS session files, at most MAX_PER_SESSION each), and `get()` gives one back: a picture's data URI, or a file's
place on this computer. Only DGC's own session store is read, a file is given only inside its own project, and nothing is
copied anywhere.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

MAX_SESSIONS = 200
MAX_PER_SESSION = 200
MAX_SESSION_BYTES = 64 * 1024 * 1024
_PICTURE_ENDING = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp"}


class AttachmentError(Exception):
    pass


def _store() -> Path:
    from . import sessions
    return Path(sessions.SESSIONS_DIR)


def _own_session(path) -> Path:
    """A session file in DGC's own store (no link, no other folder), or AttachmentError."""
    try:
        base = _store().resolve(strict=True)
        real = Path(path).resolve(strict=True)
        real.relative_to(base)
    except (OSError, ValueError, TypeError) as exc:
        raise AttachmentError("That isn't one of DGC's sessions.") from exc
    if real.suffix != ".json" or real.parent.parent != base:
        raise AttachmentError("That isn't one of DGC's sessions.")
    return real


def _read(path: Path) -> dict | None:
    try:
        if path.stat().st_size > MAX_SESSION_BYTES:
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) and isinstance(data.get("messages"), list) else None


def _inside(project: Path, identity) -> Path | None:
    """A file a mark names, resolved inside its project; None when it leaves it."""
    if not isinstance(identity, str) or not identity or len(identity) > 4096:
        return None
    target = (project / identity).resolve(strict=False) if not os.path.isabs(identity) else Path(identity).resolve(strict=False)
    try:
        target.relative_to(project)
    except ValueError:
        return None
    return target


def _attachments(data: dict) -> list[tuple[str, dict, dict]]:
    """(id, item, source) for each attachment in a session, in order: per message, its named files, then its pictures."""
    project = Path(str(data.get("project") or "")).expanduser().resolve(strict=False)
    out = []
    for index, message in enumerate(data["messages"]):
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        n = 0
        at = message.get("_dgc_at") if isinstance(message.get("_dgc_at"), (int, float)) else None
        for mark in message.get("_dgc_display_mentions") or []:
            if not isinstance(mark, dict) or mark.get("kind") != "file":
                continue
            target = _inside(project, mark.get("identity"))
            if target is None:
                continue
            out.append((f"{index}:{n}", {"kind": "file", "name": target.name, "file": str(target), "at": at}, mark))
            n += 1
        content = message.get("content")
        pictures = 0
        for part in content if isinstance(content, list) else []:
            if not isinstance(part, dict) or part.get("type") != "image_url":
                continue
            url = (part.get("image_url") or {}).get("url") if isinstance(part.get("image_url"), dict) else None
            if not isinstance(url, str) or not url.startswith("data:") or ";base64," not in url[:80]:
                continue
            mime = url[5:url.index(";base64,")]
            if mime not in _PICTURE_ENDING:
                continue
            pictures += 1
            size = (len(url) - url.index(",") - 1) * 3 // 4
            out.append((f"{index}:{n}", {"kind": "image", "name": f"Picture {pictures}.{_PICTURE_ENDING[mime]}",
                                         "mime": mime, "bytes": size, "at": at}, {"url": url}))
            n += 1
        if len(out) >= MAX_PER_SESSION:
            break
    return out[:MAX_PER_SESSION]


def listing(*, query: str = "", limit: int = 60, offset: int = 0) -> dict:
    """Every attachment in the newest sessions of every project, newest first; ``query`` part of its name."""
    from . import sessions
    from .config import dgc_home
    if type(limit) is not int or not 1 <= limit <= 500 or type(offset) is not int or offset < 0:
        raise AttachmentError("Ask for 1–500 attachments at a time.")
    words = " ".join(str(query or "").split())[:200].casefold()
    own = str(dgc_home().expanduser().resolve(strict=False))
    store = _store()
    try:
        files = sorted(store.glob("*/*.json"), key=lambda p: p.stat().st_mtime, reverse=True)[:MAX_SESSIONS]
    except OSError:
        files = []
    items = []
    for candidate in files:
        try:
            path = _own_session(candidate)
        except AttachmentError:
            continue
        data = _read(path)
        if data is None or not data.get("project"):
            continue
        place = str(Path(str(data["project"])).expanduser().resolve(strict=False))
        if place == own or place.startswith(own + os.sep) or sessions.not_a_project(place):
            continue
        name = str(data.get("name") or "").strip()[:120]
        updated = data.get("updated") if isinstance(data.get("updated"), (int, float)) else path.stat().st_mtime
        for ident, item, _source in _attachments(data):
            if words and words not in item["name"].casefold():
                continue
            items.append({"path": str(path), "id": ident, **{k: v for k, v in item.items() if k != "file"},
                          "at": item["at"] or updated, "session_name": name, "project": place,
                          "project_name": Path(place).name or place})
    items.sort(key=lambda i: i["at"] or 0, reverse=True)
    page = items[offset:offset + limit]
    return {"items": page, "total": len(items),
            "next_offset": offset + len(page) if offset + len(page) < len(items) else None}


def get(path, attachment_id: str) -> dict:
    """One attachment: a picture's data URI (checked as a picture), or a file's place in its own project."""
    real = _own_session(path)
    data = _read(real)
    if data is None:
        raise AttachmentError("That session can't be read.")
    for ident, item, source in _attachments(data):
        if ident != attachment_id:
            continue
        if item["kind"] == "image":
            from .attachments import validate_image_data_uris
            (uri,) = validate_image_data_uris([source["url"]])
            return {"id": ident, "kind": "image", "name": item["name"], "mime": item["mime"], "data": uri}
        if not Path(item["file"]).is_file():
            raise AttachmentError(f"{item['name']} is no longer in its project.")
        return {"id": ident, "kind": "file", "name": item["name"], "file_path": item["file"]}
    raise AttachmentError("That attachment isn't in this session any more.")
