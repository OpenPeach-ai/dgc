"""Canvas (ChatGPT's), as a real file beside the chat: ChatDGC and the user work on one document or piece of code.

A canvas is a file VS Code opens in an editor beside the chat, named for its title, under
``<chat root>/canvas/<chat>/<id>/``; the user edits it there like any file. The model changes it with exact
find-and-replace edits (as ChatGPT's canvas does) or a rewrite, and reads it fresh from disk every turn, so what the
user typed is what it works from. Every change is a version (``.versions/v<n>.<ext>``, with who made it), to compare
and restore; an edit of the user's that the model hasn't seen yet becomes a version of theirs first.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import shutil
import tempfile
from datetime import datetime, timezone
from pathlib import Path

CANVAS_ID = re.compile(r"cv_[a-f0-9]{16}\Z")
CHAT_ID = re.compile(r"chat_[a-f0-9]{32}\Z")
KINDS = ("document", "code")
MAX_CHARS = 200_000
MAX_VERSIONS = 60
MAX_TITLE = 80
LANGUAGES = {
    "python": "py", "py": "py", "javascript": "js", "js": "js", "typescript": "ts", "ts": "ts", "tsx": "tsx",
    "jsx": "jsx", "java": "java", "go": "go", "rust": "rs", "c": "c", "cpp": "cpp", "c++": "cpp", "csharp": "cs",
    "c#": "cs", "ruby": "rb", "php": "php", "swift": "swift", "kotlin": "kt", "sql": "sql", "bash": "sh", "shell": "sh",
    "sh": "sh", "zsh": "sh", "html": "html", "css": "css", "json": "json", "yaml": "yml", "yml": "yml", "toml": "toml",
    "markdown": "md", "md": "md", "r": "r", "lua": "lua", "dart": "dart", "scala": "scala", "text": "txt",
}


class CanvasError(Exception):
    """A canvas change that can't be made as asked; the text says what to change, for the model or the user."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _title(value) -> str:
    text = " ".join(re.sub(r"[\x00-\x1f\x7f/\\:*?\"<>|]", " ", str(value or "")).split()).strip(" .")
    return text[:MAX_TITLE].rstrip(" .") or "Canvas"


def apply_edits(text: str, edits) -> str:
    """Each edit's ``find`` must be in the canvas exactly once (or ``all``), so an edit never lands somewhere else."""
    if not isinstance(edits, list) or not edits:
        raise CanvasError("Give edits: [{find, replace}], or the whole new text as content.")
    for i, edit in enumerate(edits, 1):
        if not isinstance(edit, dict) or not isinstance(edit.get("find"), str) or not edit["find"]:
            raise CanvasError(f"Edit {i} needs find: the exact text in the canvas to change.")
        find, replace = edit["find"], str(edit.get("replace") if edit.get("replace") is not None else "")
        count = text.count(find)
        if not count:
            raise CanvasError(f"Edit {i}: “{find[:80]}” isn't in the canvas now (the user may have changed it). "
                              "Copy the text exactly as it is in the canvas below, or rewrite it with content.")
        if count > 1 and not edit.get("all"):
            raise CanvasError(f"Edit {i}: “{find[:80]}” is in the canvas {count} times. Include more of the "
                              "text around it, so it's found once (or set all to change every one).")
        text = text.replace(find, replace) if edit.get("all") else text.replace(find, replace, 1)
    return text


class Canvases:
    """One chat store's canvases: ``root`` is ``<chat root>/canvas``."""

    def __init__(self, root: Path):
        self.root = Path(root)

    @staticmethod
    def temporary() -> "Canvases":
        """A temporary chat's: the system's temp folder, gone with it."""
        uid = getattr(os, "getuid", lambda: 0)()
        return Canvases(Path(tempfile.gettempdir()) / f"dgc-chat-canvas-{uid}")

    def _dir(self, chat_id: str, canvas_id: str) -> Path:
        if not CHAT_ID.fullmatch(str(chat_id)) or not CANVAS_ID.fullmatch(str(canvas_id)):
            raise CanvasError("That canvas doesn't exist.")
        return self.root / chat_id / canvas_id

    def _meta(self, chat_id: str, canvas_id: str) -> dict:
        try:
            return json.loads((self._dir(chat_id, canvas_id) / "meta.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise CanvasError("That canvas doesn't exist.") from None

    def _write(self, path: Path, text: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        temp.write_text(text, encoding="utf-8")
        os.replace(temp, path)

    def _put_meta(self, chat_id: str, meta: dict) -> None:
        self._write(self._dir(chat_id, meta["id"]) / "meta.json", json.dumps(meta, ensure_ascii=False, indent=1))

    def path(self, chat_id: str, canvas_id: str, meta: dict | None = None) -> Path:
        """The file the user edits."""
        meta = meta or self._meta(chat_id, canvas_id)
        return self._dir(chat_id, canvas_id) / meta["file"]

    def _version_path(self, chat_id: str, meta: dict, n: int) -> Path:
        return self._dir(chat_id, meta["id"]) / ".versions" / f"v{n}.{meta['ext']}"

    def read(self, chat_id: str, canvas_id: str) -> tuple[dict, str]:
        meta = self._meta(chat_id, canvas_id)
        try:
            text = self.path(chat_id, canvas_id, meta).read_text(encoding="utf-8", errors="replace")
        except OSError:
            text = self._last(chat_id, meta)          # the user deleted the file: it's what it was
        return meta, text

    def _last(self, chat_id: str, meta: dict) -> str:
        try:
            return self._version_path(chat_id, meta, meta["versions"][-1]["n"]).read_text(encoding="utf-8")
        except (OSError, IndexError, KeyError):
            return ""

    def _add_version(self, chat_id: str, meta: dict, text: str, by: str, note: str) -> None:
        n = (meta["versions"][-1]["n"] if meta["versions"] else 0) + 1
        self._write(self._version_path(chat_id, meta, n), text)
        meta["versions"].append({"n": n, "at": _now(), "by": by, "note": str(note or "")[:200], "chars": len(text)})
        for old in meta["versions"][:-MAX_VERSIONS]:
            try:
                self._version_path(chat_id, meta, old["n"]).unlink()
            except OSError:
                pass
        meta["versions"] = meta["versions"][-MAX_VERSIONS:]

    def _theirs_first(self, chat_id: str, meta: dict) -> str:
        """The canvas as it is now; if the user changed it since the last version, that's a version of theirs."""
        text = self.read(chat_id, meta["id"])[1]
        if text != self._last(chat_id, meta):
            self._add_version(chat_id, meta, text, "user", "Your edits")
        return text

    def create(self, chat_id: str, *, title, kind, language, content) -> dict:
        kind = str(kind or "document").lower()
        if kind not in KINDS:
            raise CanvasError("A canvas is a document or code.")
        if not isinstance(content, str) or not content.strip():
            raise CanvasError("Give the canvas's text as content.")
        if len(content) > MAX_CHARS:
            raise CanvasError(f"A canvas holds at most {MAX_CHARS:,} characters.")
        lang = str(language or "").strip().lower()
        ext = "md" if kind == "document" else LANGUAGES.get(lang, "txt")
        name = _title(title)
        if name.lower().endswith("." + ext):
            name = name[: -len(ext) - 1] or "Canvas"
        meta = {"id": "cv_" + secrets.token_hex(8), "title": name, "kind": kind,
                "language": "markdown" if kind == "document" else (lang or "text"), "ext": ext, "file": f"{name}.{ext}",
                "created_at": _now(), "versions": []}
        self._write(self.path(chat_id, meta["id"], meta), content)
        self._add_version(chat_id, meta, content, "model", "Created")
        self._put_meta(chat_id, meta)
        return self.view(chat_id, meta, content)

    def edit(self, chat_id: str, canvas_id: str, *, edits=None, content=None, note="") -> dict:
        meta = self._meta(chat_id, canvas_id)
        text = self._theirs_first(chat_id, meta)
        if content is not None:
            if not isinstance(content, str) or not content.strip():
                raise CanvasError("content is the canvas's whole new text; it can't be empty.")
            changed = content
        else:
            changed = apply_edits(text, edits)
        if len(changed) > MAX_CHARS:
            raise CanvasError(f"A canvas holds at most {MAX_CHARS:,} characters.")
        if changed == text:
            raise CanvasError("Those edits change nothing.")
        self._write(self.path(chat_id, canvas_id, meta), changed)
        self._add_version(chat_id, meta, changed, "model", note or "Edited")
        self._put_meta(chat_id, meta)
        return self.view(chat_id, meta, changed)

    def restore(self, chat_id: str, canvas_id: str, n: int) -> dict:
        meta = self._meta(chat_id, canvas_id)
        if not any(v["n"] == n for v in meta["versions"]):
            raise CanvasError("That version isn't kept any more.")
        self._theirs_first(chat_id, meta)
        text = self._version_path(chat_id, meta, n).read_text(encoding="utf-8")
        self._write(self.path(chat_id, canvas_id, meta), text)
        self._add_version(chat_id, meta, text, "user", f"Restored version {n}")
        self._put_meta(chat_id, meta)
        return self.view(chat_id, meta, text)

    def view(self, chat_id: str, meta: dict, text: str | None = None) -> dict:
        """A canvas as the screen and the editor need it: where it is, its versions' files, and (when given) its text."""
        out = {key: meta[key] for key in ("id", "title", "kind", "language", "created_at")}
        out["path"] = str(self.path(chat_id, meta["id"], meta))
        out["version"] = meta["versions"][-1]["n"] if meta["versions"] else 0
        out["versions"] = [{**v, "path": str(self._version_path(chat_id, meta, v["n"]))} for v in meta["versions"]]
        if text is not None:
            out["text"] = text
        return out

    def get(self, chat_id: str, canvas_id: str, *, text: bool = False) -> dict:
        meta, body = self.read(chat_id, canvas_id)
        return self.view(chat_id, meta, body if text else None)

    def all(self, chat_id: str) -> list[dict]:
        """A chat's canvases, the newest change first, each with its text now."""
        if not CHAT_ID.fullmatch(str(chat_id)):
            return []
        out = []
        try:
            entries = list((self.root / chat_id).iterdir())
        except OSError:
            return []
        for entry in entries:
            if CANVAS_ID.fullmatch(entry.name):
                try:
                    meta, text = self.read(chat_id, entry.name)
                    changed = (entry / "meta.json").stat().st_mtime_ns      # finer than a version's time
                except (CanvasError, OSError):
                    continue
                out.append((changed, meta, text))
        out.sort(key=lambda row: row[0], reverse=True)
        return [{**self.view(chat_id, meta), "text": text} for _, meta, text in out]

    def copy_chat(self, source: str, target: str, into: "Canvases | None" = None) -> None:
        """A branch's canvases: its own copies, from here on."""
        into = into or self
        try:
            shutil.copytree(self.root / source, into.root / target, dirs_exist_ok=True)
        except OSError:
            pass

    def remove_chat(self, chat_id: str) -> None:
        if CHAT_ID.fullmatch(str(chat_id)):
            shutil.rmtree(self.root / chat_id, ignore_errors=True)
