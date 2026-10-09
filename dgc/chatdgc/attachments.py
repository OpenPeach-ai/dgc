"""What a ChatDGC message carries besides its words: files you picked, images you pasted, long text you pasted.

Each one is checked and read here, once, when the message is sent: an image must be one (its bytes say so, not
its name); a document (PDF, Word, PowerPoint, Excel, OpenDocument, RTF, CSV) is read with DGC's document reader;
anything else must be UTF-8 text. The chat keeps its own copy (``ChatStore.put_file``), so a file moved or
deleted afterwards is still what the conversation was about.

What the model reads: the message's words, then each text attachment inside DGC's attachment frame (the same
one Work uses, so a file can never close the frame and speak as DGC), and each image as an image part. A model
that can't see images is told so before anything is sent.
"""
from __future__ import annotations

import base64
import binascii
import re
import uuid
from pathlib import Path

MAX_ATTACHMENTS = 10
MAX_FILE_BYTES = 25 * 1024 * 1024
MAX_IMAGE_BYTES = 8 * 1024 * 1024
MAX_PASTE_CHARS = 1_000_000
MAX_MODEL_CHARS = 200_000          # of one attachment's text, for the model
ATTACHMENT_ID = re.compile(r"att_[a-f0-9]{32}\Z")
IMAGE_TYPES = {"image/png": b"\x89PNG\r\n\x1a\n", "image/jpeg": b"\xff\xd8\xff", "image/gif": b"GIF8",
               "image/webp": b"RIFF"}
_DATA_URI = re.compile(r"data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=\s]+)\Z")


class AttachmentError(Exception):
    """An attachment that can't go with the message; the text says which and why, for the user."""


def new_attachment_id() -> str:
    return "att_" + uuid.uuid4().hex


def _image_type(raw: bytes) -> str | None:
    for mime, magic in IMAGE_TYPES.items():
        if raw.startswith(magic) and (mime != "image/webp" or raw[8:12] == b"WEBP"):
            return mime
    return None


def _name(value, fallback: str) -> str:
    text = " ".join(str(value or "").split())
    text = re.sub(r"[\x00-\x1f\x7f/\\]", "", text)[:120]
    return text or fallback


def _text_of(raw: bytes, name: str) -> tuple[str, bool, dict]:
    """A file's text for the model: a document through DGC's reader, else UTF-8 text, else refused."""
    from .. import documents
    try:
        fmt = documents.sniff(name, raw)
    except documents.DocumentError as exc:
        raise AttachmentError(f"{name} can't be read: {_problem(exc)}") from exc
    if fmt is not None:
        try:
            found = documents.extract_text(raw, name, max_chars=MAX_MODEL_CHARS)
        except (documents.DocumentError, documents.UnsupportedDocument) as exc:
            raise AttachmentError(f"{name} can't be read: {_problem(exc)}") from exc
        return found.text, bool(found.truncated), dict(found.summary or {})
    if b"\x00" in raw[:8192]:
        raise AttachmentError(f"{name} isn't text, an image or a document ChatDGC can read.")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise AttachmentError(f"{name} isn't UTF-8 text, an image or a document ChatDGC can read.") from exc
    return text[:MAX_MODEL_CHARS], len(text) > MAX_MODEL_CHARS, {}


def _problem(exc) -> str:
    message = str(exc).strip() or "it could not be read"
    return message[7:].lstrip() if message.startswith("error: ") else message


def prepare(items) -> list[dict]:
    """Check and read what came with a message. Each result: ``meta`` (what the message keeps and the screen
    shows), ``raw`` (the bytes the chat keeps), and ``text`` (what the model reads, for a non-image)."""
    if items is None:
        return []
    if not isinstance(items, list):
        raise AttachmentError("Attachments must be a list.")
    if len(items) > MAX_ATTACHMENTS:
        raise AttachmentError(f"Attach up to {MAX_ATTACHMENTS} things to one message.")
    out = []
    for item in items:
        if not isinstance(item, dict):
            raise AttachmentError("An attachment is a file, an image or pasted text.")
        kind = item.get("kind")
        if kind == "file":
            out.append(_file(item))
        elif kind == "image":
            out.append(_pasted_image(item))
        elif kind == "text":
            out.append(_pasted_text(item))
        else:
            raise AttachmentError("An attachment is a file, an image or pasted text.")
    return out


def _file(item: dict) -> dict:
    path = Path(str(item.get("path") or ""))
    name = _name(item.get("name") or path.name, "file")
    if not path.is_absolute():
        raise AttachmentError(f"{name}: choose the file again.")
    try:
        size = path.stat().st_size
        if not path.is_file():
            raise AttachmentError(f"{name} isn't a file.")
        if size > MAX_FILE_BYTES:
            raise AttachmentError(f"{name} is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
        raw = path.read_bytes()
    except FileNotFoundError:
        raise AttachmentError(f"{name} is no longer there.") from None
    except OSError as exc:
        raise AttachmentError(f"{name} couldn't be opened: {exc.strerror or exc}.") from exc
    if len(raw) > MAX_FILE_BYTES:
        raise AttachmentError(f"{name} is larger than {MAX_FILE_BYTES // (1024 * 1024)} MB.")
    mime = _image_type(raw)
    if mime is not None:
        if len(raw) > MAX_IMAGE_BYTES:
            raise AttachmentError(f"{name} is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB.")
        return _attached("image", name, raw, mime)
    text, truncated, summary = _text_of(raw, name)
    return _attached("document", name, raw, "", text=text, truncated=truncated, summary=summary)


def _pasted_image(item: dict) -> dict:
    match = _DATA_URI.match(str(item.get("data") or ""))
    if match is None:
        raise AttachmentError("That pasted image isn't a PNG, JPEG, GIF or WebP.")
    try:
        raw = base64.b64decode(re.sub(r"\s+", "", match.group(2)), validate=True)
    except (binascii.Error, ValueError) as exc:
        raise AttachmentError("That pasted image couldn't be read.") from exc
    if len(raw) > MAX_IMAGE_BYTES:
        raise AttachmentError(f"That pasted image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)} MB.")
    mime = _image_type(raw)
    if mime is None or mime != match.group(1):
        raise AttachmentError("That pasted image isn't what it says it is.")
    return _attached("image", _name(item.get("name"), "Pasted image"), raw, mime)


def _pasted_text(item: dict) -> dict:
    text = item.get("text")
    if not isinstance(text, str) or not text.strip():
        raise AttachmentError("That pasted text is empty.")
    if len(text) > MAX_PASTE_CHARS:
        raise AttachmentError("That pasted text is too long to send.")
    raw = text.encode("utf-8")
    return _attached("text", _name(item.get("name"), "Pasted text"), raw, "text/plain",
                     text=text[:MAX_MODEL_CHARS], truncated=len(text) > MAX_MODEL_CHARS)


def _attached(kind: str, name: str, raw: bytes, mime: str, *, text: str | None = None, truncated: bool = False,
              summary: dict | None = None) -> dict:
    meta = {"id": new_attachment_id(), "kind": kind, "name": name, "size": len(raw)}
    if mime:
        meta["mime"] = mime
    if text is not None:
        meta["chars"] = len(text)
        if truncated:
            meta["truncated"] = True
    return {"meta": meta, "raw": raw, "text": text, "summary": summary or {}}


def frame(meta: dict, raw: bytes, text: str, summary: dict | None = None) -> str:
    """A text attachment as the model reads it: DGC's attachment frame, which no file can close."""
    from ..attachments import _text_block
    return _text_block(meta.get("name", "attachment"), raw, text, bool(meta.get("truncated")), summary or None)


def image_part(meta: dict, raw: bytes) -> dict:
    return {"type": "image_url",
            "image_url": {"url": f"data:{meta.get('mime', 'image/png')};base64,{base64.b64encode(raw).decode('ascii')}"}}

