"""Images the model viewed: what they are, where they are kept, and how they come back.

A tool result is text, so an image a step produced (a browser screenshot, an image file read with
``view_image``, an image an MCP tool returned) travels on its own. This module is the pure part of
that path: format sniffing and header dimensions, the record the session index keeps for each image,
and the private per-session store the bytes live in.

The store is a session sidecar, ``~/.dgc/sessions/<slug>/<session>.images/`` (mode 0700), like the
``.plan.md``, ``.metrics``, ``.workspace`` and ``.recall`` files beside a transcript: it is deleted
with the session and copied on a fork. Files are content addressed (``<sha256[:32]>.<ext>``), so a
record's ``ref`` names exactly the bytes the model saw, and a changed file is detectable.
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import stat
import tempfile
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .attachments import MAX_IMAGE_FILE_BYTES, _IMAGE_TYPES, _image_matches

IMAGE_MIMES = frozenset(_IMAGE_TYPES.values())
MIME_EXTENSIONS = {"image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
                   "image/webp": "webp", "image/bmp": "bmp"}
MAX_VIEW_BYTES = MAX_IMAGE_FILE_BYTES        # 8 MB: view_image and the store's per-file ceiling
MAX_IMAGES_PER_CALL = 8                      # images kept per step; the rest count as omitted
MAX_INDEX = 512                              # records a session index keeps, oldest dropped
STORE_BUDGET_BYTES = 256 * 1024 * 1024       # per-session sidecar; oldest files pruned on save
MAX_NAME_CHARS = 128
MAX_DIMENSION = 1_000_000
SOURCES = ("browser", "view_image", "mcp")
SOURCE_LABELS = {"browser": "Browser screenshot", "view_image": "Workspace image", "mcp": "MCP image"}
REF_RE = re.compile(r"img_[0-9a-f]{32}\Z")
_STORE_FILE_RE = re.compile(r"([0-9a-f]{32})\.(png|jpg|gif|webp|bmp)\Z")
_CONTROL_RE = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")
_HOST_RE = re.compile(
    r"(?=.{1,253}\Z)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\Z")
_SNIFF_ORDER = ("image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp")


def sniff(data: bytes) -> str | None:
    """The image MIME type these bytes really are, or None (SVG and anything else is not an image
    DGC shows: SVG is a document that can carry script)."""
    if not isinstance(data, (bytes, bytearray)):
        return None
    head = bytes(data[:32])
    for mime in _SNIFF_ORDER:
        if _image_matches(head, mime):
            # "BM" alone is two letters of text; a bitmap also names a known DIB header size.
            if mime == "image/bmp" and (len(head) < 18 or int.from_bytes(head[14:18], "little")
                                        not in (12, 16, 40, 52, 56, 64, 108, 124)):
                return None
            return mime
    return None


def parse_dimensions(data: bytes) -> tuple[int, int] | None:
    """Width and height from an image header (PNG, GIF, BMP, WebP VP8/VP8L/VP8X, JPEG SOF), or None."""
    width = height = 0
    if len(data) >= 24 and data.startswith(b"\x89PNG\r\n\x1a\n"):
        width, height = int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")
    elif len(data) >= 10 and data.startswith((b"GIF87a", b"GIF89a")):
        width, height = int.from_bytes(data[6:8], "little"), int.from_bytes(data[8:10], "little")
    elif len(data) >= 26 and data.startswith(b"BM"):
        width = abs(int.from_bytes(data[18:22], "little", signed=True))
        height = abs(int.from_bytes(data[22:26], "little", signed=True))
    elif len(data) >= 30 and data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        if data[12:16] == b"VP8X" and len(data) >= 30:
            width = 1 + int.from_bytes(data[24:27], "little")
            height = 1 + int.from_bytes(data[27:30], "little")
        elif data[12:16] == b"VP8L" and len(data) >= 25 and data[20] == 0x2F:
            bits = int.from_bytes(data[21:25], "little")
            width, height = 1 + (bits & 0x3FFF), 1 + ((bits >> 14) & 0x3FFF)
        elif data[12:16] == b"VP8 " and len(data) >= 30 and data[23:26] == b"\x9d\x01\x2a":
            width = int.from_bytes(data[26:28], "little") & 0x3FFF
            height = int.from_bytes(data[28:30], "little") & 0x3FFF
    elif len(data) >= 12 and data.startswith(b"\xff\xd8\xff"):
        offset = 2
        sof = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB,
               0xCD, 0xCE, 0xCF}
        while offset + 9 <= len(data):
            if data[offset] != 0xFF:
                offset += 1
                continue
            while offset < len(data) and data[offset] == 0xFF:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
                continue
            if offset + 2 > len(data):
                break
            length = int.from_bytes(data[offset:offset + 2], "big")
            if length < 2 or offset + length > len(data):
                break
            if marker in sof and length >= 7:
                height = int.from_bytes(data[offset + 3:offset + 5], "big")
                width = int.from_bytes(data[offset + 5:offset + 7], "big")
                break
            offset += length
    if 0 < width <= MAX_DIMENSION and 0 < height <= MAX_DIMENSION:
        return width, height
    return None


def dimensions(data: bytes) -> tuple[int, int]:
    """Width and height, or (0, 0) when the header does not say (0 means unknown on the wire)."""
    return parse_dimensions(bytes(data or b"")) or (0, 0)


def human_size(size: int) -> str:
    """'310 KB' under a megabyte, otherwise '2.4 MB' (the panel and the terminal say the same)."""
    size = max(0, int(size or 0))
    if size < 1024 * 1024:
        return f"{max(1, round(size / 1024)) if size else 0} KB"
    return f"{size / (1024 * 1024):.1f} MB"


def safe_name(name: object, mime: str = "") -> str:
    """A display name: a basename, no control characters, never a URL, 1-128 characters."""
    text = _CONTROL_RE.sub("", str(name or ""))
    if "://" in text:
        text = ""
    text = text.replace("\\", "/").rsplit("/", 1)[-1].strip()
    if not text:
        text = f"image.{MIME_EXTENSIONS.get(mime, 'png')}"
    return text[:MAX_NAME_CHARS]


def safe_host(value: object) -> str:
    """The bare hostname of a URL (or a hostname), lower-cased; never userinfo, a port, a path or a
    query. Anything that is not a plain hostname becomes ""."""
    text = str(value or "").strip()
    if not text:
        return ""
    try:
        host = urlsplit(text if "://" in text else f"http://{text}").hostname or ""
    except ValueError:
        return ""
    host = host.lower().rstrip(".")
    return host if _HOST_RE.match(host) else ""


def _bounded_int(value, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        return 0
    return value if 0 <= value <= maximum else 0


@dataclass
class ImageRecord:
    """One image a step produced, as the session index keeps it (metadata only, never pixels)."""
    ref: str
    name: str
    mime: str
    width: int = 0
    height: int = 0
    bytes: int = 0
    source: str = "browser"
    host: str = ""
    call_id: str | None = None          # the top-level visible call (a sub-agent's `task` call)
    live_call_id: str | None = None     # the id the live UI saw (prefixed inside a sub-agent)
    tool: str = ""
    anchor: int = 0                     # the root transcript's message count when it was recorded
    created: float = 0.0

    def to_item(self) -> dict:
        """The v14 ``tool_images.items[i]`` shape."""
        return {"ref": self.ref, "name": self.name, "mime": self.mime, "width": self.width,
                "height": self.height, "bytes": self.bytes, "source": self.source,
                "host": self.host if self.source == "browser" else ""}

    def to_record(self) -> dict:
        return asdict(self)

    @classmethod
    def from_record(cls, raw) -> "ImageRecord | None":
        """A validated record from a session file, or None for anything malformed."""
        if not isinstance(raw, dict):
            return None
        ref, mime, source = raw.get("ref"), raw.get("mime"), raw.get("source")
        if not isinstance(ref, str) or not REF_RE.match(ref) or mime not in IMAGE_MIMES:
            return None
        if source not in SOURCES:
            return None
        call_id = raw.get("call_id")
        live = raw.get("live_call_id")
        if call_id is not None and (not isinstance(call_id, str) or len(call_id) > 256):
            return None
        if live is not None and (not isinstance(live, str) or len(live) > 512):
            live = None
        created = raw.get("created")
        try:
            created = float(created) if not isinstance(created, bool) else 0.0
        except (TypeError, ValueError):
            created = 0.0
        return cls(ref=ref, name=safe_name(raw.get("name"), mime), mime=mime,
                   width=_bounded_int(raw.get("width"), MAX_DIMENSION),
                   height=_bounded_int(raw.get("height"), MAX_DIMENSION),
                   bytes=_bounded_int(raw.get("bytes"), MAX_VIEW_BYTES),
                   source=source, host=safe_host(raw.get("host")) if source == "browser" else "",
                   call_id=call_id, live_call_id=live, tool=str(raw.get("tool") or "")[:128],
                   anchor=_bounded_int(raw.get("anchor"), 1 << 40),
                   created=created if created == created and created >= 0 else 0.0)


def load_index(raw) -> list[ImageRecord]:
    """The newest ``MAX_INDEX`` valid records of a saved index, in their saved order."""
    if not isinstance(raw, list):
        return []
    records = [record for record in (ImageRecord.from_record(item) for item in raw[-MAX_INDEX:])
               if record is not None]
    return records[-MAX_INDEX:]


# ---- the private store ---------------------------------------------------------------------------
def store_dir(session_file) -> Path:
    """``<session>.images/`` beside the transcript (not created)."""
    return Path(session_file).with_suffix(".images")


def _ensure_store_dir(session_file) -> Path:
    directory = store_dir(session_file)
    if directory.is_symlink():
        raise OSError("the image store is a symlink")
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        directory.chmod(0o700)
    except OSError:
        pass
    return directory


def _store_path(session_file, ref: str, mime: str) -> Path:
    return store_dir(session_file) / f"{ref[4:]}.{MIME_EXTENSIONS[mime]}"


def store(session_file, data: bytes, *, name: object = "", source: str = "browser",
          host: object = "", tool: str = "", call_id: str | None = None,
          live_call_id: str | None = None, anchor: int = 0) -> ImageRecord:
    """Keep ``data`` in the session's store and return its record. Idempotent: identical bytes are
    one file. Raises ValueError for bytes that are not a supported image or exceed 8 MB."""
    data = bytes(data or b"")
    mime = sniff(data)
    if mime is None:
        raise ValueError("not a PNG, JPEG, GIF, WebP or BMP image")
    if len(data) > MAX_VIEW_BYTES:
        raise ValueError(f"image is {len(data)} bytes; the store keeps images up to {MAX_VIEW_BYTES}")
    if source not in SOURCES:
        raise ValueError(f"unknown image source {source!r}")
    digest = hashlib.sha256(data).hexdigest()
    ref = "img_" + digest[:32]
    directory = _ensure_store_dir(session_file)
    target = _store_path(session_file, ref, mime)
    try:
        info = os.lstat(target)
        present = stat.S_ISREG(info.st_mode) and info.st_size == len(data)
    except FileNotFoundError:
        present = False
    if not present:
        fd, temporary = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".part")
        try:
            with os.fdopen(fd, "wb") as handle:
                handle.write(data)
            os.chmod(temporary, 0o600)
            os.replace(temporary, target)
        except BaseException:
            try:
                os.unlink(temporary)
            except OSError:
                pass
            raise
    else:
        try:
            os.utime(target)                  # recently viewed again: the last thing prune removes
        except OSError:
            pass
    width, height = dimensions(data)
    return ImageRecord(ref=ref, name=safe_name(name, mime), mime=mime, width=width, height=height,
                       bytes=len(data), source=source,
                       host=safe_host(host) if source == "browser" else "", call_id=call_id,
                       live_call_id=live_call_id, tool=str(tool or "")[:128], anchor=max(0, int(anchor)),
                       created=time.time())


def resolve(session_file, record: ImageRecord) -> tuple[bytes | None, str, str]:
    """``(data, reason, path)`` for a record: the stored bytes with reason "" when they are intact,
    or None with one of not_found | changed | too_large | unreadable. ``path`` is the stored file's
    absolute path whenever the file resolved to a regular file inside this session's store."""
    try:
        if not REF_RE.match(str(record.ref)) or record.mime not in IMAGE_MIMES:
            return None, "unreadable", ""
        directory = store_dir(session_file)
        target = _store_path(session_file, record.ref, record.mime)
        try:
            if stat.S_ISLNK(os.lstat(directory).st_mode):
                return None, "unreadable", ""
            info = os.lstat(target)
        except FileNotFoundError:
            return None, "not_found", ""
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            return None, "unreadable", ""
        real_dir = os.path.realpath(directory)
        real = os.path.realpath(target)
        if os.path.dirname(real) != real_dir:
            return None, "unreadable", ""
        if info.st_size > MAX_VIEW_BYTES:
            return None, "too_large", real
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_BINARY", 0)
        fd = os.open(real, flags)
        try:
            opened = os.fstat(fd)
            if not stat.S_ISREG(opened.st_mode) or opened.st_size > MAX_VIEW_BYTES:
                return None, "too_large" if stat.S_ISREG(opened.st_mode) else "unreadable", real
            chunks, total = [], 0
            while total <= MAX_VIEW_BYTES:
                chunk = os.read(fd, 65_536)
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
        finally:
            os.close(fd)
        if total > MAX_VIEW_BYTES:
            return None, "too_large", real
        data = b"".join(chunks)
        if hashlib.sha256(data).hexdigest()[:32] != record.ref[4:]:
            return None, "changed", real
        return data, "", real
    except FileNotFoundError:
        return None, "not_found", ""
    except OSError:
        return None, "unreadable", ""


def _store_files(directory: Path) -> list[tuple[str, Path, os.stat_result]]:
    rows = []
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return rows
    for entry in entries:
        match = _STORE_FILE_RE.match(entry.name)
        if not match:
            continue
        try:
            info = entry.stat(follow_symlinks=False)
        except OSError:
            continue
        if stat.S_ISREG(info.st_mode):
            rows.append(("img_" + match.group(1), Path(entry.path), info))
    return rows


def prune(session_file, keep_refs, budget: int = STORE_BUDGET_BYTES) -> set[str]:
    """Bring the store under ``budget`` bytes: the oldest files no index record names go first, then
    (only if that is not enough) the oldest indexed ones. Returns the refs whose files are gone."""
    directory = store_dir(session_file)
    if directory.is_symlink() or not directory.is_dir():
        return set()
    keep = {str(ref) for ref in keep_refs or ()}
    files = sorted(_store_files(directory), key=lambda row: row[2].st_mtime)
    total = sum(row[2].st_size for row in files)
    removed: set[str] = set()
    for indexed_pass in (False, True):
        for ref, path, info in files:
            if total <= budget:
                return removed
            if (ref in keep) != indexed_pass or ref in removed:
                continue
            try:
                path.unlink()
            except OSError:
                continue
            total -= info.st_size
            removed.add(ref)
    return removed


def copy_store(src_session, dst_session) -> int:
    """A fork keeps the images its conversation viewed: hard links, falling back to copies."""
    source = store_dir(src_session)
    if source.is_symlink() or not source.is_dir():
        return 0
    copied = 0
    target_dir = None
    for _ref, path, _info in _store_files(source):
        if target_dir is None:
            target_dir = _ensure_store_dir(dst_session)
        target = target_dir / path.name
        if target.exists():
            copied += 1
            continue
        try:
            os.link(path, target)
        except OSError:
            try:
                shutil.copyfile(path, target)
                os.chmod(target, 0o600)
            except OSError:
                continue
        copied += 1
    return copied


def remove_store(session_file) -> None:
    """Delete a session's image store (a symlink in its place is unlinked, never followed)."""
    directory = store_dir(session_file)
    try:
        if directory.is_symlink():
            directory.unlink()
        elif directory.is_dir():
            shutil.rmtree(directory, ignore_errors=True)
    except OSError:
        pass
