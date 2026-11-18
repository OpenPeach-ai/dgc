"""Keep an image in the Library on purpose (0.52; his call 15 Nov: "images model thinks needs to go in library").

ONE module every surface reaches ("one capability, one module"): Work's keep_image (a picture in the project, or an
https image), ChatDGC's and a Pip's (an https image; a Pip's is read by the controller under careful mode, and, 18 Nov,
a picture in its own Files or one it sent in its chat). A kept image sits beside the generated ones
(images.directory()/kept/) with a sidecar, and in the same images index, marked ``kept`` with its title and why, so the
Library's Images tab lists it with who kept it. Only images are kept; an address carrying a secret DGC knows is never
fetched. Nothing here sends anything anywhere else.

Save to Library (18 Nov, his ask: "on the card we give an option for 'Save', and that saves the image in library"): a
person keeps a picture of a chat from its row or its pop-up, through ``keep`` with ``by="you"``. A picture already in the
Library, made or kept, is found by its bytes (``held``) and is never kept twice: the chat says "In Library" instead.
Nothing is kept on its own beyond what already is (a generated picture is in the Library from the start).
"""
from __future__ import annotations

import copy
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

NAME = "keep_image"
MAX_BYTES = 15_000_000
TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}
# How many of the newest Library rows `held` looks through (the index is trimmed to images.LIBRARY_MAX anyway).
HELD_ROWS = 5000
# A picture a Pip sent in its chat, found again by its name: how many of the newest runs' records are read.
SENT_RUNS = 400

SCHEMA = {"type": "function", "function": {
    "name": NAME,
    "description": ("Keep an image in the user's Library (its Images tab), with a title and why, when it is worth keeping "
                    "for them: a chart or diagram you made, a picture you found that they will want again. Images you "
                    "generate are kept already; never keep one just to show it, and never a screenshot of your own "
                    "screen unless asked. `source`: an https address of an image, or (in a Work session) a picture "
                    "file in the project."),
    "parameters": {"type": "object", "properties": {
        "source": {"type": "string", "description": "An https image address, or a project picture's path (Work only)."},
        "title": {"type": "string", "description": "A short title the user will recognise."},
        "why": {"type": "string", "description": "One line on why it is worth keeping."}},
        "required": ["source", "title"]}}}

# A Pip's own keep_image (18 Nov): the same tool, its source also a picture in its computer's Files or one it sent in
# its chat, so "save this image in the Library" in its chat works.
PIP_SCHEMA = copy.deepcopy(SCHEMA)
PIP_SCHEMA["function"]["description"] = (
    "Keep an image in the user's Library (its Images tab), with a title and why, when it is worth keeping for them or "
    "when they ask you to save one there: a chart or diagram you made, a picture you found, one you sent in this chat. "
    "Images you generate are kept already; never keep one just to show it, and never a screenshot of your own screen "
    "unless asked. A picture already in the Library is never kept twice. `source`: an https address of an image, a "
    "picture's path in your computer's Files (\"Pictures/cafe.png\"), or the name of a picture you sent in this chat "
    "with send_to_chat.")
PIP_SCHEMA["function"]["parameters"]["properties"]["source"]["description"] = (
    "An https image address, a picture's path in your Files, or the name of a picture you sent in this chat.")


class KeepError(Exception):
    """Not kept; the text says why, for the model and the user."""


def _mime(data: bytes) -> str:
    from .image_providers import sniff
    found = sniff(data or b"")
    if found not in TYPES:
        raise KeepError("that isn't an image (PNG, JPEG, WebP or GIF).")
    return found


def digest(data: bytes) -> str:
    return hashlib.sha256(data or b"").hexdigest()


def from_url(url: str, config) -> tuple[bytes, str]:
    """An https (or http) image's bytes and final address: DGC's public fetch, images only, the leak guard first."""
    url = str(url or "").strip()
    if not url.lower().startswith(("https://", "http://")) or len(url) > 2048:
        raise KeepError("give the image's http or https address.")
    from . import leak_guard
    if leak_guard.carries_secret(url, config):
        raise KeepError("not fetched: the address carries a saved secret.")
    from . import tools
    final, ctype, data, _ = tools._fetch_public(url, max_bytes=MAX_BYTES, binary_types=TYPES)
    if str(ctype or "").split(";")[0].strip().lower() not in TYPES and _mime(data) not in TYPES:
        raise KeepError("that address isn't an image.")
    _mime(data)
    return data, str(final or url)


def from_path(path: Path) -> bytes:
    try:
        size = path.stat().st_size
    except OSError as exc:
        raise KeepError(f"can't read {path.name}.") from exc
    if size > MAX_BYTES:
        raise KeepError("that image is larger than 15 MB.")
    data = path.read_bytes()
    _mime(data)
    return data


def from_pip(directory, pip_id: str, source: str) -> bytes:
    """A picture of a Pip's own (its keep_image): a path in its computer's Files, read by DGC inside Files without
    following a link, or else a picture it sent in its chat by that name (send_to_chat), kept in this Pip's own chat
    store. An image by its bytes, at most MAX_BYTES; nothing of another Pip's and nothing outside its Files."""
    from .pip_computer import computer_root
    from . import pip_computer_files as desk
    from .workspace_registry import RegistryError
    source = str(source or "").strip()
    for lead in ("/Files/", "Files/"):
        if source.startswith(lead):
            source = source[len(lead):]
            break
    files = desk.files_root(computer_root(directory, pip_id))
    try:
        data, size = desk._read_bytes(files, source, MAX_BYTES + 1)
    except (RegistryError, OSError):
        data, size = None, 0
    if data is not None:
        if size > MAX_BYTES:
            raise KeepError("that image is larger than 15 MB.")
        _mime(data)
        return data
    if "/" in source.strip("/") or "\\" in source or ".." in source:
        raise KeepError("that picture isn't in your Files.")
    sent = _sent_picture(directory, pip_id, source.strip("/"))
    if sent is None:
        raise KeepError("that picture isn't in your Files, and you didn't send one by that name in this chat.")
    return sent


def _sent_picture(directory, pip_id: str, name: str) -> bytes | None:
    """The newest picture this Pip sent in its chat under ``name``: from the runs' records, read from this Pip's own
    chat store and checked against its digest (another Pip's store never has it)."""
    from . import pip_chat, pip_chat_sends
    if not name:
        return None
    runs = Path(directory) / "runs"
    try:
        records = sorted(runs.glob(f"run_*/{pip_chat_sends.RECORD}"), key=lambda p: p.stat().st_mtime, reverse=True)
    except OSError:
        return None
    store = pip_chat.image_directory(directory, pip_id)
    for record in records[:SENT_RUNS]:
        for item in reversed(pip_chat_sends.recorded(record.parent)):
            if item["kind"] != "image" or item["name"] != name or item["bytes"] > MAX_BYTES:
                continue
            ext = pip_chat._IMAGE_EXT.get(item["mime"])
            try:
                data = (store / f"{item['sha256']}.{ext}").read_bytes()
            except OSError:
                continue
            if digest(data) == item["sha256"]:
                _mime(data)
                return data
    return None


def held(data: bytes) -> dict | None:
    """The Library's row already holding exactly these bytes (a picture DGC made, or one kept before), or None. A row
    says its digest (newer rows) or its size; a row of the same size is read to be sure. A row whose file is gone holds
    nothing."""
    from . import images
    want, size = digest(data), len(data or b"")
    try:
        lines = (images.directory() / "library.jsonl").read_text(encoding="utf-8").splitlines()[-HELD_ROWS:]
    except OSError:
        return None
    for line in reversed(lines):
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if not isinstance(row, dict) or not row.get("path"):
            continue
        said = row.get("sha256")
        if said is not None and said != want:
            continue
        if said is None and row.get("bytes") not in (size, None):
            continue
        path = Path(str(row["path"]))
        try:
            if not path.is_file() or path.stat().st_size != size:
                continue
            if said == want or digest(path.read_bytes()) == want:
                return row
        except OSError:
            continue
    return None


def keep(data: bytes, *, title: str, why: str, source: str, surface: str, where: dict, by: str = "model") -> dict:
    """Keep ``data`` (an image) in the Library: the file beside the generated images, its sidecar and an index row. A
    picture already there is not kept again: the answer names the one there, with ``already``. ``by`` "you" is a person
    keeping it (Save to Library), said in its row as ``kept_by``."""
    from . import images
    mime = _mime(data)
    there = held(data)
    if there is not None:
        name = str(there.get("title") or there.get("prompt") or Path(str(there["path"])).stem)[:200]
        return {"path": str(there["path"]), "title": name, "already": True}
    title = " ".join(str(title or "").split())[:200] or "Kept image"
    why = " ".join(str(why or "").split())[:500]
    folder = images.directory() / "kept"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = f"{images._slug(title)}-{stamp}"
    path, serial = folder / f"{base}.{EXT[mime]}", 2
    while path.exists() or path.with_suffix(".json").exists():
        path, serial = folder / f"{base}-{serial}.{EXT[mime]}", serial + 1
    path.write_bytes(data)
    width, height = images._dimensions(data)
    created = datetime.now(timezone.utc).isoformat(timespec="seconds")
    mine = {"kept_by": "you"} if by == "you" else {}
    record = {"kept": True, "title": title, "why": why, "source": str(source or "")[:2048], "file": path.name,
              "bytes": len(data), "mime": mime, "width": width, "height": height, "created_at": created,
              "surface": surface, "made_by": "DGC", "sha256": digest(data), **mine}
    path.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    images._index({"path": str(path), "rel": "", "surface": surface, "kept": True, "title": title, "why": why,
                   "prompt": title, "width": width, "height": height, "bytes": len(data), "created_at": created,
                   "source": str(source or "")[:2048], "sha256": digest(data), **mine,
                   **{k: v for k, v in (where or {}).items() if isinstance(v, str)}})
    return {"path": str(path), "title": title, "already": False}


def said(kept: dict) -> str:
    if kept.get("already"):
        return f"Already in the user's Library (Images) as “{kept['title']}”: nothing kept twice."
    return f"Kept “{kept['title']}” in the user's Library (Images)."
