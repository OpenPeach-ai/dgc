"""Keep an image in the Library on purpose (0.52; his call 15 Nov: "images model thinks needs to go in library").

ONE module every surface reaches ("one capability, one module"): Work's keep_image (a picture in the project, or an
https image), ChatDGC's and a Pip's (an https image; a Pip's is read by the controller under careful mode). A kept image
sits beside the generated ones (images.directory()/kept/) with a sidecar, and in the same images index, marked
``kept`` with its title and why, so the Library's Images tab lists it with who kept it. Only images are kept; an
address carrying a secret DGC knows is never fetched. Nothing here sends anything anywhere else.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

NAME = "keep_image"
MAX_BYTES = 15_000_000
TYPES = frozenset({"image/png", "image/jpeg", "image/webp", "image/gif"})
EXT = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}

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


class KeepError(Exception):
    """Not kept; the text says why, for the model and the user."""


def _mime(data: bytes) -> str:
    from .image_providers import sniff
    found = sniff(data or b"")
    if found not in TYPES:
        raise KeepError("that isn't an image (PNG, JPEG, WebP or GIF).")
    return found


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


def keep(data: bytes, *, title: str, why: str, source: str, surface: str, where: dict) -> dict:
    """Keep ``data`` (an image) in the Library: the file beside the generated images, its sidecar and an index row."""
    from . import images
    mime = _mime(data)
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
    record = {"kept": True, "title": title, "why": why, "source": str(source or "")[:2048], "file": path.name,
              "bytes": len(data), "mime": mime, "width": width, "height": height, "created_at": created,
              "surface": surface, "made_by": "DGC"}
    path.with_suffix(".json").write_text(json.dumps(record, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    images._index({"path": str(path), "rel": "", "surface": surface, "kept": True, "title": title, "why": why,
                   "prompt": title, "width": width, "height": height, "bytes": len(data), "created_at": created,
                   "source": str(source or "")[:2048], **{k: v for k, v in (where or {}).items() if isinstance(v, str)}})
    return {"path": str(path), "title": title}


def said(kept: dict) -> str:
    return f"Kept “{kept['title']}” in the user's Library (Images)."
